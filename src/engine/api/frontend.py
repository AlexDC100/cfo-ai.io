"""Frontend-facing endpoints — what the React app calls.

Distinct from the n8n `run-daily` flow because:
  - n8n reads from PG; the React app posts SKU rows in the request body
  - n8n auth is mandatory in prod; the frontend uses a session-token model
  - the React `DailyRun` shape is flatter than the engine's classification output
    (4 buckets: anchors / eliminate / review / scale, vs. 6 internal flags),
    so we adapt at the API boundary

The canonical category metrics (DIO/CCC/etc.) are loaded ONCE at startup from
the shipped Excel and held in memory. Uploads that lack DIO inherit from this
canonical lookup keyed on category name.
"""

from __future__ import annotations

from datetime import date as Date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from ..alerts import alert_summary, detect_alerts
from ..config import Config
from ..loader import load_categories_from_excel, load_skus_from_excel
from ..models import CategoryRow, SkuRow
from ..pipeline import run_pipeline
from ..sku_pipeline import drill_category


# ─────────── Request / response models ───────────


class SkuRowIn(BaseModel):
    """One uploaded SKU row from the React Upload page.

    `dio_days` is optional — the backend fills it from canonical category data
    when the upload is SKU-profitability-only (no inventory column).
    """
    category: str
    sku: Optional[str] = None
    volume_tons: float = Field(ge=0)
    revenue_kron: float = Field(ge=0)  # NIV in kRON
    gross_margin_pct: float
    dio_days: Optional[int] = None
    strategic_flag: bool = False


# Per-request threshold overrides — Settings drawer sliders. Each subsection
# is optional; only the fields the user changed need to be sent.
class AnchorOverrides(BaseModel):
    top_pct_by_absolute_profit: Optional[float] = None
    min_revenue_share_pct: Optional[float] = None
    volume_threshold_tons_default: Optional[float] = None
    floor_real_margin_pct: Optional[float] = None
    high_volume_anchor_floor_pct: Optional[float] = None


class EliminateOverrides(BaseModel):
    micro_volume_tons: Optional[float] = None
    micro_profit_kron: Optional[float] = None
    dio_capital_trap: Optional[int] = None
    capital_trap_real_margin: Optional[float] = None
    zero_sales_window_days: Optional[int] = None
    ccc_category_red_days: Optional[int] = None


class WarningOverrides(BaseModel):
    thin_real_margin_max_pct: Optional[float] = None
    long_dio_days: Optional[int] = None
    trend_lookback_months: Optional[int] = None
    min_volume_tons: Optional[float] = None
    max_volume_tons: Optional[float] = None
    min_profit_kron: Optional[float] = None


class ScaleOverrides(BaseModel):
    high_margin_min_pct: Optional[float] = None
    high_margin_min_volume: Optional[float] = None
    volume_play_min_pct: Optional[float] = None
    volume_play_min_volume: Optional[float] = None
    gmroii_min_pct: Optional[float] = None
    high_volume_dio_max: Optional[int] = None


class EngineOverrides(BaseModel):
    cost_of_capital_pct: Optional[float] = None
    fx_eur_ron: Optional[float] = None
    anchor: Optional[AnchorOverrides] = None
    eliminate: Optional[EliminateOverrides] = None
    warning: Optional[WarningOverrides] = None
    scale: Optional[ScaleOverrides] = None


def _merge_config(base: Config, ov: Optional[EngineOverrides]) -> Config:
    """Produce a per-request Config with the user's threshold overrides applied.

    Only fields the caller explicitly set are patched; unset fields keep the
    calibrated baseline. Returning a copy keeps the startup Config immutable.
    """
    if ov is None:
        return base
    patch: Dict[str, Any] = {}
    if ov.cost_of_capital_pct is not None:
        patch["cost_of_capital_pct"] = ov.cost_of_capital_pct
    if ov.fx_eur_ron is not None:
        patch["fx_eur_ron"] = ov.fx_eur_ron
    for sub in ("anchor", "eliminate", "warning", "scale"):
        sub_ov = getattr(ov, sub)
        if sub_ov is None:
            continue
        delta = {k: v for k, v in sub_ov.model_dump().items() if v is not None}
        if not delta:
            continue
        patch[sub] = getattr(base, sub).model_copy(update=delta)
    return base.model_copy(update=patch) if patch else base


class ClassifyRowsRequest(BaseModel):
    rows: List[SkuRowIn]
    period_months: int = Field(10, gt=0)
    data_period: str = "YTD October 2025"
    run_date: Optional[Date] = None
    overrides: Optional[EngineOverrides] = None


class DrillRequest(BaseModel):
    category: str
    rows: List[SkuRowIn]
    period_months: int = Field(10, gt=0)
    overrides: Optional[EngineOverrides] = None


class SkusRequest(BaseModel):
    """Run the engine across all uploaded rows and return one record per SKU.

    Unlike `classify-rows` which buckets by category, this returns a flat list
    of every individual SKU with its decision — what the SKU-first dashboard
    renders.
    """
    rows: List[SkuRowIn]
    period_months: int = Field(10, gt=0)
    min_volume_tons: float = 0.0
    min_revenue_kron: float = 0.0
    overrides: Optional[EngineOverrides] = None


class AnalyzeRequest(BaseModel):
    """Run the AI briefing over an existing classification result.

    The frontend posts the DailyRun back to us; we don't recompute.
    Optionally include the SKU rows so the AI can name SPECIFIC products to cut.
    """
    run: Dict[str, Any]
    file_name: Optional[str] = None
    row_count: Optional[int] = None
    language: str = "en"  # English only — kept as a field for back-compat.
    rows: Optional[List[SkuRowIn]] = None  # When present, picks specific SKUs
    period_months: int = 10
    overrides: Optional[EngineOverrides] = None


# ─────────── Adapter: engine flags → React 4-bucket shape ───────────


# Engine flag → React bucket. ANCHOR_REVIEW falls into anchors with status=alert too.
_BUCKET_MAP = {
    "ANCHOR": "anchors",
    "ANCHOR_ALERT": "anchors",      # surfaces in anchors with status="alert"
    "ANCHOR_REVIEW": "anchors",     # status="alert"
    "ELIMINATE": "eliminate",
    "WARNING": "review",            # React calls them "review"
    "KEEP": "review",               # park healthy non-anchors here too
    "SCALE": "scale",
}


def _to_daily_run(
    metrics: list,
    decisions: list,
    cfg: Config,
    run_date: Date,
    data_period: str,
) -> Dict[str, Any]:
    """Convert engine output into the DailyRun shape the React app reads."""
    by_bucket: Dict[str, List[Dict[str, Any]]] = {
        "anchors": [], "eliminate": [], "review": [], "scale": []
    }
    metrics_by_id = {m.category: m for m in metrics}

    coc_pct = cfg.cost_of_capital_pct
    for d in decisions:
        bucket = _BUCKET_MAP.get(d.flag, "review")
        m = metrics_by_id.get(d.id)
        # Extras present on EVERY bucket so the briefing can render a
        # capital-lockup table without per-bucket special cases.
        ccc = m.ccc_days if (m and m.ccc_days is not None) else None
        woca_pp_period = (
            (ccc / 365.0) * coc_pct if ccc is not None
            else (d.dio_days / 365.0) * coc_pct
        )
        common_extras = {
            "volumeT": d.volume_tons,
            "nivKron": round(m.niv_kron, 1) if m else None,
            "grossMargin": round(m.gm_pct, 1) if m else None,
            "dioDays": d.dio_days,
            "cccDays": ccc,
            "wocaCostPct": round(woca_pp_period, 2),  # percentage points subtracted
            "capitalMRon": round(((m.niv_kron if m else 0) * d.dio_days / 365.0) / 1000.0, 2),
        }
        if bucket == "anchors":
            by_bucket["anchors"].append({
                "name": d.id,
                "realMargin": d.real_margin_pct,
                "absoluteProfit": d.abs_profit_kron,
                "status": "alert" if d.flag in ("ANCHOR_ALERT", "ANCHOR_REVIEW") else "healthy",
                "alertReason": d.context if d.flag == "ANCHOR_ALERT" else None,
                **common_extras,
            })
        else:
            by_bucket[bucket].append({
                "name": d.id,
                "flag": "eliminate" if bucket == "eliminate" else (
                    "scale" if bucket == "scale" else "review"
                ),
                "realMargin": d.real_margin_pct,
                "absoluteProfit": d.abs_profit_kron,
                "reason": d.reason,
                **common_extras,
            })

    # Aggregates
    total_woca = sum((m.niv_kron * m.dio_days / 365.0) for m in metrics)  # in kRON
    total_abs_profit = sum(m.abs_profit_kron for m in metrics)
    anchor_profit = sum(a["absoluteProfit"] for a in by_bucket["anchors"])
    anchor_share = (anchor_profit / total_abs_profit) if total_abs_profit > 0 else 0.0
    roic = (total_abs_profit / total_woca * 100.0) if total_woca > 0 else 0.0
    now = datetime.now()
    return {
        "date": run_date.isoformat(),
        "period": data_period,
        "workingCapitalMRon": round(total_woca / 1000.0, 2),  # kRON → MRON
        "roicPct": round(roic, 1),
        "costOfCapitalPct": cfg.cost_of_capital_pct,
        "runCompletedAt": now.strftime("%H:%M"),
        "nextRunAt": "06:00",
        "confidence": "high" if len(decisions) >= 20 else ("medium" if len(decisions) >= 10 else "low"),
        "anchorProfitShare": round(anchor_share, 3),
        "anchors": sorted(by_bucket["anchors"], key=lambda x: x["absoluteProfit"], reverse=True),
        "eliminate": sorted(by_bucket["eliminate"], key=lambda x: x["realMargin"]),
        "review": sorted(by_bucket["review"], key=lambda x: x["absoluteProfit"], reverse=True),
        "scale": sorted(by_bucket["scale"], key=lambda x: x["absoluteProfit"], reverse=True),
    }


# ─────────── DIO ingestion from upload's own DIO sheet ───────────


def _load_dio_from_workbook(
    xlsx_path: Path,
    sales_volume_tons_by_cat: Dict[str, float],
) -> Dict[str, int]:
    """Compute fresh DIO per category from the upload's DIO sheet.

    legacy workbooks ship a `DIO` sheet with stock snapshots at the start
    and end of the reporting period, in two side-by-side blocks:

        | Grupa_Pr | ... | Stoc KG (end)   | <gap> | Grupa_Pr | ... | Stoc KG (start) |
        |  cat A   |     | end_kg_A        |       |  cat A   |     | start_kg_A      |

    Implied DIO = avg_stock_kg × period_days / sales_kg_during_period.

    period_days defaults to 90 (a quarter). When the sheet header row carries
    two date strings (e.g. 31.03.2026 and 01.01.2026) we use their difference.

    Returns a {UPPERCASE_CATEGORY: int(dio_days)} map. Categories without an
    entry fall through to canonical inheritance.
    """
    import pandas as pd
    try:
        raw = pd.read_excel(xlsx_path, sheet_name="DIO", header=None)
    except Exception:
        return {}

    if raw.shape[0] < 3 or raw.shape[1] < 17:
        return {}

    # Period detection: row 0 typically has two date stamps. Find them.
    period_days = 90
    dates = []
    for v in raw.iloc[0].tolist():
        if hasattr(v, "year") and hasattr(v, "month"):
            dates.append(v)
        elif isinstance(v, str):
            # Try to parse "31.03.2026" or "2026-03-31" forms
            try:
                from datetime import datetime
                for fmt in ("%d.%m.%Y", "%Y-%m-%d", "%d/%m/%Y"):
                    try:
                        dates.append(datetime.strptime(v.strip(), fmt))
                        break
                    except ValueError:
                        continue
            except Exception:
                pass
    if len(dates) >= 2:
        d_max, d_min = max(dates), min(dates)
        diff = (d_max - d_min).days
        if 30 <= diff <= 366:
            period_days = diff

    # Data rows start at index 2 (row 0 = period banner, row 1 = column labels).
    end_stock_kg: Dict[str, float] = {}
    start_stock_kg: Dict[str, float] = {}
    for _, row in raw.iloc[2:].iterrows():
        # End-of-period block (cols 0-7)
        try:
            cat_e = str(row.iloc[0]).strip().upper()
            kg_e = float(row.iloc[7])
            if cat_e and cat_e != "NAN" and kg_e > 0:
                end_stock_kg[cat_e] = kg_e
        except (ValueError, TypeError):
            pass
        # Start-of-period block (cols 9-16)
        try:
            cat_s = str(row.iloc[9]).strip().upper()
            kg_s = float(row.iloc[16])
            if cat_s and cat_s != "NAN" and kg_s > 0:
                start_stock_kg[cat_s] = kg_s
        except (ValueError, TypeError):
            pass

    out: Dict[str, int] = {}
    for cat in set(list(end_stock_kg.keys()) + list(start_stock_kg.keys())):
        e = end_stock_kg.get(cat)
        s = start_stock_kg.get(cat)
        avg = (e + s) / 2 if (e and s) else (e or s)
        sold_kg = sales_volume_tons_by_cat.get(cat, 0) * 1000.0
        if avg and sold_kg > 0:
            dio = avg * period_days / sold_kg
            # Clamp to a sane range — outliers like HERING at 1488d are real but
            # cap so they don't poison the engine. 365 days = 1 year of stock.
            out[cat] = int(round(min(max(dio, 7), 365)))
    return out


# ─────────── SKU rows → CategoryRow aggregation ───────────


def _find_canonical_sibling(
    cat_name: str,
    canonical: Dict[str, CategoryRow],
) -> Optional[CategoryRow]:
    """Look up DIO/CCC for a category that isn't directly in the canonical lookup.

    Match ladder (most specific → most lenient):
      1. Exact case-insensitive match — "SARDINE" → "Sardina" (different spelling
         catches 1-letter drift via the fuzzy step below; same-spelling-different-case
         is caught here).
      2. Word-boundary prefix — "SUC DE ROSII" → "SUC".
      3. Fuzzy match (≥ 0.85 similarity) — "SARDINE" ↔ "Sardina" (1 char diff in 7
         = 0.86), "MACROU" ↔ "Macrou" (1.0 case-insensitive). Catches Romanian
         singular/plural drift between workbook periods.

    Returns the best-fitting canonical row, or None if nothing matches at all.
    """
    if not canonical:
        return None
    import difflib

    target = cat_name.strip().lower()

    # 1. Case-insensitive exact match — handles SARDINA vs SARDINA, OTET vs OTET, etc.
    for canon_name, canon_row in canonical.items():
        if canon_name.strip().lower() == target:
            return canon_row

    # 2. Prefix match (longest wins) — handles "SUC DE ROSII" → "SUC"
    best: Optional[CategoryRow] = None
    best_len = 0
    for canon_name, canon_row in canonical.items():
        prefix = canon_name.strip().lower()
        if target.startswith(prefix + " "):
            if len(prefix) > best_len:
                best = canon_row
                best_len = len(prefix)
    if best is not None:
        return best

    # 3. Fuzzy match — last resort for spelling drift like SARDINE ↔ Sardina.
    candidates = [(n, n.strip().lower()) for n in canonical.keys()]
    scored = [
        (difflib.SequenceMatcher(None, target, normalised).ratio(), name)
        for name, normalised in candidates
    ]
    scored.sort(reverse=True)
    if scored and scored[0][0] >= 0.85:
        return canonical[scored[0][1]]

    return None


def _aggregate_to_categories(
    rows: List[SkuRowIn],
    canonical: Dict[str, CategoryRow],
    dio_overrides: Optional[Dict[str, int]] = None,
) -> Tuple[List[CategoryRow], List[SkuRow]]:
    """Group uploaded SKU rows by category and build CategoryRows.

    DIO/CCC inheritance ladder:
      1. fresh DIO from this upload's own DIO sheet (most accurate)
      2. explicit per-row dio in the upload (volume-weighted average)
      3. exact canonical match by category name (case-insensitive)
      4. canonical sibling — longest prefix match (e.g. SUC DE ROSII → SUC)
      5. fuzzy match (≥0.85 similarity) against canonical
      6. arbitrary 90-day fallback (logged so the operator can fix calibration)

    `real_margin_pct_stored` is intentionally NOT inherited — we always
    recompute via the CCC formula so margins reflect the upload's GM%.
    """
    dio_overrides = dio_overrides or {}
    by_cat: Dict[str, List[SkuRowIn]] = {}
    for r in rows:
        by_cat.setdefault(r.category.strip(), []).append(r)

    cats: List[CategoryRow] = []
    skus: List[SkuRow] = []
    for cat_name, items in by_cat.items():
        total_vol = sum(i.volume_tons for i in items)
        total_niv = sum(i.revenue_kron for i in items)
        # GM% as revenue-weighted average
        gm_pct = (
            sum(i.gross_margin_pct * i.revenue_kron for i in items) / total_niv
            if total_niv > 0 else 0.0
        )

        # Inheritance ladder: exact match → sibling prefix match → 90-day default.
        canon = canonical.get(cat_name) or _find_canonical_sibling(cat_name, canonical)

        # Fresh DIO from the upload's own DIO sheet (highest priority — it's
        # actual physical inventory data for THIS period, not stale calibration)
        upload_dio = dio_overrides.get(cat_name.strip().upper())

        # Per-row DIO: prefer explicit, else upload DIO, else canonical, else default
        explicit_dios = [i.dio_days for i in items if i.dio_days is not None]
        if explicit_dios:
            # Volume-weighted average DIO
            denom = sum(i.volume_tons for i in items if i.dio_days is not None) or 1.0
            dio = int(round(sum(
                (i.dio_days or 0) * i.volume_tons for i in items if i.dio_days is not None
            ) / denom))
        elif upload_dio is not None:
            dio = upload_dio
        elif canon is not None:
            dio = canon.dio_days
        else:
            # Last resort: 90 days. Logged so the operator knows calibration is missing.
            dio = 90
            print(
                f"[engine] WARNING: category {cat_name!r} not found in canonical "
                f"and no sibling prefix match — falling back to DIO=90, CCC=None. "
                f"Add a calibration row to fix."
            )

        cats.append(CategoryRow(
            category=cat_name,
            business_unit=canon.business_unit if canon else None,
            volume_tons=total_vol,
            niv_kron=total_niv,
            gm_pct=gm_pct,
            dio_days=dio,
            dso_days=canon.dso_days if canon else None,
            dpo_days=canon.dpo_days if canon else None,
            ccc_days=canon.ccc_days if canon else None,
            woca_kron=None,
            abs_profit_kron=None,
            # Do NOT inherit canonical's real_margin_pct_stored. That value was
            # calibrated against the canonical workbook's GM% — which is stale
            # by the time the user uploads fresh data. Setting it to None forces
            # pipeline.compute_category_metrics to recompute via the CCC formula
            # using THIS upload's GM% and the canonical's CCC days.
            real_margin_pct_stored=None,
        ))

        # Aggregate transaction rows up to one SkuRow per unique (sku) within
        # this category. Without this, the same product sold to 5 clients
        # surfaces as 5 separate "SKUs" in the dashboard.
        sku_groups: Dict[str, List[SkuRowIn]] = {}
        for i in items:
            sid = (i.sku or i.category).strip()
            sku_groups.setdefault(sid, []).append(i)
        for sid, rows_for_sku in sku_groups.items():
            agg_vol = sum(r.volume_tons for r in rows_for_sku)
            agg_niv = sum(r.revenue_kron for r in rows_for_sku)
            # GM% as revenue-weighted average so GM_kron is consistent.
            gm_pct = (
                sum(r.gross_margin_pct * r.revenue_kron for r in rows_for_sku) / agg_niv
                if agg_niv > 0 else 0.0
            )
            brand = sid.split("|", 1)[0] if "|" in sid else None
            sku_name = sid.split("|", 1)[1] if "|" in sid else sid
            skus.append(SkuRow(
                sku_id=sid,
                sku_name=sku_name,
                brand=brand,
                category=cat_name,
                volume_tons=agg_vol,
                niv_kron=agg_niv,
                gm_pct=gm_pct,
                gm_kron=agg_niv * gm_pct / 100.0,
            ))
    return cats, skus


# ─────────── Router factory ───────────


def create_frontend_router(
    cfg: Config,
    canonical_excel: Optional[Path] = None,
) -> APIRouter:
    """Build the /api/* router. Loads canonical Analysis data at startup.

    `canonical_excel` is the path to `Trading_analysis_YTDOct'25_LV.xlsx`
    or equivalent — its `Analysis` sheet feeds DIO/CCC inheritance.
    """
    router = APIRouter(prefix="/api", tags=["frontend"])

    canonical: Dict[str, CategoryRow] = {}
    canonical_skus: List[SkuRow] = []
    if canonical_excel is not None and canonical_excel.exists():
        try:
            for c in load_categories_from_excel(canonical_excel):
                canonical[c.category] = c
            try:
                canonical_skus = load_skus_from_excel(canonical_excel)
            except Exception:
                canonical_skus = []
        except Exception:
            # If the canonical workbook can't be read, the API still works —
            # just without inherited DIO. Uploads with explicit DIO are unaffected.
            canonical = {}

    @router.post("/upload-excel")
    async def upload_excel(
        file: UploadFile = File(...),
        period_months: int = 10,
        overrides_json: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Server-side upload + full pipeline in one round-trip.

        Accepts an .xlsx, parses it (pandas does Romanian-locale-y characters
        better than the browser), aggregates SKU transactions to one row per
        unique product, runs classification, builds the SKU list, generates
        the AI analysis. Returns everything the dashboard needs.
        """
        if not file.filename or not file.filename.lower().endswith((".xlsx", ".xlsm")):
            raise HTTPException(400, "File must be .xlsx or .xlsm")

        # Save to a tmp path because pandas read_excel works best with paths
        import tempfile
        import shutil
        from datetime import date as _Date

        try:
            with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
                shutil.copyfileobj(file.file, tmp)
                tmp_path = Path(tmp.name)

            # Pick the most-recent transaction sheet automatically. Legacy
            # workbooks accumulate historical periods (the Mar'26 file ships
            # with the Oct'25 + Sep'25 sheets too) so we can't just match by
            # name — we need to score each sheet on:
            #   (a) does it have the required transaction columns?
            #   (b) which period does the sheet name encode?  newer wins.
            # Tie-break: prefer "Trading" suffix (Mar'26 convention).
            import pandas as pd
            import re

            xls = pd.ExcelFile(tmp_path)
            month_idx = {
                "ian": 1, "feb": 2, "mar": 3, "apr": 4, "mai": 5, "may": 5,
                "iun": 6, "jun": 6, "iul": 7, "jul": 7, "aug": 8, "sep": 9,
                "oct": 10, "nov": 11, "dec": 12,
            }
            REQUIRED_HINTS = ("categ_pr", "volume(to)", "niv (kron)")

            def score_sheet(name: str) -> tuple:
                # Match patterns like "YTD Mar'26_Trading", "YTD Oct'25", etc.
                m = re.search(r"ytd\s*([a-z]{3,})'?(\d{2})", name.lower())
                year = month = 0
                if m:
                    month = month_idx.get(m.group(1)[:3], 0)
                    year = int(m.group(2))
                # Anything ending in _Trading (or containing it) ranks higher.
                trading_bonus = 1 if "trading" in name.lower() else 0
                return (year, month, trading_bonus)

            best = None
            for sn in xls.sheet_names:
                try:
                    head = pd.read_excel(tmp_path, sheet_name=sn, nrows=2)
                except Exception:
                    continue
                cols_lower = [str(c).lower() for c in head.columns]
                if not all(any(h in c for c in cols_lower) for h in REQUIRED_HINTS):
                    continue
                s = score_sheet(sn)
                if best is None or s > best[1]:
                    best = (sn, s)

            if best is None:
                raise HTTPException(400, "Could not find a usable transaction sheet (missing Categ_Pr / Volume(to) / NIV (kRon)).")
            df = pd.read_excel(tmp_path, sheet_name=best[0])
            print(f"[upload-excel] selected sheet {best[0]!r} (score={best[1]}) from {len(xls.sheet_names)} sheets")

            df.columns = [str(c).strip() for c in df.columns]

            # Required columns. `gm_kron` is optional — it lets us derive GM%
            # exactly without unit-detection guesswork.
            col_map = _resolve_columns(list(df.columns))
            required = ["category", "product", "volume", "niv", "gm_pct"]
            missing = [k for k in required if col_map.get(k) is None]
            if missing:
                raise HTTPException(
                    400,
                    f"Workbook missing required columns: {missing}. "
                    f"Found: {list(df.columns)}"
                )

            # ── GM% scale detection (workbook-level, ONCE) ──
            # Some workbooks store GM% as decimals (0.142 = 14.2%), others as
            # percentages (14.2 = 14.2%). Decide by the median magnitude of the
            # column, not row-by-row — a per-row heuristic flips on outliers
            # (e.g. a -1.03 decimal getting kept as -1.03% instead of -103%).
            gm_pct_col = df[col_map["gm_pct"]].apply(_safe_float)
            gm_kron_col = df[col_map["gm_kron"]].apply(_safe_float) if col_map.get("gm_kron") else None
            nonzero = gm_pct_col[gm_pct_col != 0].abs()
            gm_is_decimal = bool(nonzero.median() < 1.0) if len(nonzero) > 0 else True
            gm_scale = 100.0 if gm_is_decimal else 1.0

            # Build SkuRowIn list, dropping zero-revenue noise
            rows: List[SkuRowIn] = []
            for idx, r in df.iterrows():
                niv = _safe_float(r[col_map["niv"]])
                if niv <= 0:
                    continue
                cat = str(r[col_map["category"]]).strip()
                if not cat or cat.lower() == "nan":
                    continue
                vol = _safe_float(r[col_map["volume"]])

                # Prefer kRON-on-kRON math when GM (kRon) is available — it's
                # unit-stable and avoids decimal/percent ambiguity entirely.
                # `idx` is the DataFrame's label-based row index, so `.loc[idx]`
                # picks the matching value in the parallel Series.
                if gm_kron_col is not None and niv > 0:
                    gm_pct = float(gm_kron_col.loc[idx]) / niv * 100.0
                else:
                    gm_pct = _safe_float(r[col_map["gm_pct"]]) * gm_scale

                brand = str(r[col_map["brand"]]).strip() if col_map["brand"] else ""
                product = str(r[col_map["product"]]).strip() if col_map["product"] else cat
                sku_id = f"{brand}|{product}".strip("|") if brand else product

                rows.append(SkuRowIn(
                    category=cat,
                    sku=sku_id,
                    volume_tons=vol,
                    revenue_kron=niv,
                    gross_margin_pct=gm_pct,
                ))

            if not rows:
                raise HTTPException(400, "No usable rows in workbook (all had zero revenue)")

            # Per-request config: merge user threshold overrides over baseline.
            ov: Optional[EngineOverrides] = None
            if overrides_json:
                try:
                    import json as _json
                    ov = EngineOverrides.model_validate(_json.loads(overrides_json))
                except Exception:
                    ov = None
            req_cfg = _merge_config(cfg, ov)

            # Read the upload's own DIO sheet if present — gives us fresh
            # inventory days per category for THIS period, way better than
            # the stale Oct'25 canonical calibration.
            sales_by_cat: Dict[str, float] = {}
            for r in rows:
                k = r.category.strip().upper()
                sales_by_cat[k] = sales_by_cat.get(k, 0.0) + r.volume_tons
            dio_overrides = _load_dio_from_workbook(tmp_path, sales_by_cat)
            if dio_overrides:
                print(f"[upload-excel] DIO sheet found — overriding canonical for {len(dio_overrides)} categories")

            # Run full pipeline
            cats, sku_records = _aggregate_to_categories(rows, canonical, dio_overrides)
            metrics, decisions = run_pipeline(cats, req_cfg, period_months=period_months)
            run = _to_daily_run(metrics, decisions, req_cfg, _Date.today(), "Uploaded YTD")
            alerts = detect_alerts(metrics, decisions, sku_records, req_cfg)

            # Build SKU list (same logic as /api/skus)
            cat_flag_by_name = {d.id: d.flag for d in decisions}
            cat_real_margin_by_name = {m.category: m.real_margin_pct for m in metrics}
            from .frontend_helpers import classify_skus_within_category
            _, sku_records = _aggregate_to_categories(rows, canonical, dio_overrides)
            all_sku_decisions: List[Dict[str, Any]] = []
            for cat in cats:
                cat_skus = [s for s in sku_records if s.category == cat.category]
                if not cat_skus:
                    continue
                sku_dec_rows = classify_skus_within_category(
                    cat, cat_skus, req_cfg, period_months
                )
                cat_total_profit = sum(s["abs_profit_kron"] for s in sku_dec_rows) or 1.0
                for s in sku_dec_rows:
                    s["category_flag"] = cat_flag_by_name.get(cat.category, "KEEP")
                    s["category_real_margin_pct"] = round(
                        cat_real_margin_by_name.get(cat.category, 0.0), 1
                    )
                    s["share_of_category_profit_pct"] = round(
                        s["abs_profit_kron"] / cat_total_profit * 100.0, 1
                    )
                    all_sku_decisions.append(s)
            all_sku_decisions.sort(key=lambda d: d["abs_profit_kron"], reverse=True)

            flag_counts: Dict[str, int] = {}
            for s in all_sku_decisions:
                flag_counts[s["flag"]] = flag_counts.get(s["flag"], 0) + 1
            total_revenue = sum(s["revenue_kron"] for s in all_sku_decisions)
            total_volume = sum(s["volume_tons"] for s in all_sku_decisions)
            total_abs_profit = sum(s["abs_profit_kron"] for s in all_sku_decisions)
            loss_makers_kron = sum(
                -s["abs_profit_kron"] for s in all_sku_decisions if s["abs_profit_kron"] < 0
            )

            # Compact raw_rows for the SKU dashboard's drill (one entry per
            # unique SKU within category — already what the engine works with).
            raw_rows_out = [
                {
                    "category": s["category"],
                    "sku": s["id"],
                    "volume_tons": s["volume_tons"],
                    "revenue_kron": s["revenue_kron"],
                    "gross_margin_pct": s["gross_margin_pct"],
                }
                for s in all_sku_decisions
            ]

            # AI analysis (with SKU recs)
            sku_recs: List[Dict[str, Any]] = []
            for cat_decision in decisions:
                if cat_decision.flag not in ("ELIMINATE", "WARNING", "ANCHOR_ALERT"):
                    continue
                for s in all_sku_decisions:
                    if s["category"] != cat_decision.id or s["is_anchor"]:
                        continue
                    if s["flag"] not in ("ELIMINATE", "WARNING"):
                        continue
                    # ── Healthy gross margin shield ──
                    # Don't list 10%+ gross GM SKUs as removal candidates,
                    # even when their parent category is WARNING. They land
                    # in the WARNING bucket because of long DIO or thin band,
                    # not because per-unit economics are broken. Listing
                    # them next to genuine cuts gives operators the wrong
                    # signal. Negative-margin SKUs (real loss-makers) still
                    # appear regardless — the shield is "high GM AND not
                    # bleeding".
                    if s["gross_margin_pct"] >= 10.0 and s["real_margin_pct"] >= 0:
                        continue
                    sku_recs.append({
                        "sku": s["id"],
                        "category": s["category"],
                        "brand": s.get("brand"),
                        "volume_t": s["volume_tons"],
                        "real_margin_pct": s["real_margin_pct"],
                        "gross_margin_pct": s["gross_margin_pct"],
                        "absolute_profit_kron": s["abs_profit_kron"],
                        "dio_days": s["category_dio_days"],
                        "verdict": _verdict_for(s),
                        "reason": _human_reason(s),
                        "category_flag": cat_decision.flag,
                    })
            sku_recs.sort(key=lambda r: (
                0 if r["absolute_profit_kron"] < 0 else 1,
                r["absolute_profit_kron"] if r["absolute_profit_kron"] < 0 else -r["absolute_profit_kron"],
            ))

            analysis = _build_analysis(run, "en", canonical_skus, sku_recs)

            return {
                "file_name": file.filename,
                "transaction_rows": len(rows),
                "run": run,
                "skus": {
                    "sku_count": len(all_sku_decisions),
                    "category_count": len({s["category"] for s in all_sku_decisions}),
                    "totals": {
                        "volume_tons": round(total_volume, 1),
                        "revenue_kron": round(total_revenue, 0),
                        "abs_profit_kron": round(total_abs_profit, 1),
                        "loss_makers_kron": round(loss_makers_kron, 1),
                    },
                    "flag_counts": flag_counts,
                    "skus": all_sku_decisions,
                },
                "raw_rows": raw_rows_out,
                "analysis": analysis,
                "alerts": [a.model_dump() for a in alerts],
                "alert_summary": alert_summary(alerts),
            }
        finally:
            try:
                tmp_path.unlink()
            except Exception:
                pass

    @router.get("/config")
    def get_config() -> Dict[str, Any]:
        """Return the live engine config so the Settings drawer can show the
        calibrated baseline. Mutation comes later — for now, the frontend
        persists overrides locally and the server uses calibrated values.
        """
        return {
            "cost_of_capital_pct": cfg.cost_of_capital_pct,
            "fx_eur_ron": cfg.fx_eur_ron,
            "anchor": cfg.anchor.model_dump(),
            "eliminate": cfg.eliminate.model_dump(),
            "warning": cfg.warning.model_dump(),
            "scale": cfg.scale.model_dump(),
            "windows": cfg.windows.model_dump(),
        }

    @router.get("/canonical-categories")
    def get_canonical_categories() -> Dict[str, Any]:
        """Return DIO/CCC for known categories (frontend uses for DIO inheritance)."""
        return {
            "count": len(canonical),
            "categories": [
                {
                    "name": c.category,
                    "dio_days": c.dio_days,
                    "ccc_days": c.ccc_days,
                    "dso_days": c.dso_days,
                    "dpo_days": c.dpo_days,
                    "real_margin_pct_stored": c.real_margin_pct_stored,
                }
                for c in canonical.values()
            ],
        }

    @router.post("/classify-rows")
    def classify_rows(req: ClassifyRowsRequest) -> Dict[str, Any]:
        """Run the engine over uploaded SKU rows and return the DailyRun shape."""
        if not req.rows:
            raise HTTPException(400, "rows is empty")

        req_cfg = _merge_config(cfg, req.overrides)
        cats, _ = _aggregate_to_categories(req.rows, canonical)
        metrics, decisions = run_pipeline(cats, req_cfg, period_months=req.period_months)
        run_date = req.run_date or Date.today()
        return _to_daily_run(metrics, decisions, req_cfg, run_date, req.data_period)

    @router.post("/skus")
    def skus_flat(req: SkusRequest) -> Dict[str, Any]:
        """Flat list: every SKU with its classification + parent-category context.

        This is the heart of the SKU-first dashboard. We classify at the
        category level (so anchor protection works correctly), then break out
        the SKU-level facts and decisions inside each category.
        """
        if not req.rows:
            raise HTTPException(400, "rows is empty")

        req_cfg = _merge_config(cfg, req.overrides)
        cats, sku_records = _aggregate_to_categories(req.rows, canonical)

        # Run the category-level pipeline so we know each category's flag
        cat_metrics, cat_decisions = run_pipeline(cats, req_cfg, period_months=req.period_months)
        cat_flag_by_name = {d.id: d.flag for d in cat_decisions}
        cat_real_margin_by_name = {m.category: m.real_margin_pct for m in cat_metrics}

        # SKU-level drill within each category
        all_sku_decisions: List[Dict[str, Any]] = []
        from .frontend_helpers import classify_skus_within_category
        for cat in cats:
            cat_skus = [s for s in sku_records if s.category == cat.category]
            if not cat_skus:
                continue
            sku_dec_rows = classify_skus_within_category(
                cat, cat_skus, req_cfg, req.period_months,
            )
            cat_total_profit = sum(s["abs_profit_kron"] for s in sku_dec_rows) or 1.0
            for s in sku_dec_rows:
                if s["volume_tons"] < req.min_volume_tons:
                    continue
                if s["revenue_kron"] < req.min_revenue_kron:
                    continue
                s["category_flag"] = cat_flag_by_name.get(cat.category, "KEEP")
                s["category_real_margin_pct"] = round(
                    cat_real_margin_by_name.get(cat.category, 0.0), 1
                )
                s["share_of_category_profit_pct"] = round(
                    s["abs_profit_kron"] / cat_total_profit * 100.0, 1
                )
                all_sku_decisions.append(s)

        # Sort by absolute profit descending — top contributors at the top
        all_sku_decisions.sort(key=lambda d: d["abs_profit_kron"], reverse=True)

        # Aggregate counts by flag for the dashboard hero
        flag_counts: Dict[str, int] = {}
        for s in all_sku_decisions:
            flag_counts[s["flag"]] = flag_counts.get(s["flag"], 0) + 1

        total_revenue = sum(s["revenue_kron"] for s in all_sku_decisions)
        total_volume = sum(s["volume_tons"] for s in all_sku_decisions)
        total_abs_profit = sum(s["abs_profit_kron"] for s in all_sku_decisions)
        loss_makers_kron = sum(
            -s["abs_profit_kron"] for s in all_sku_decisions if s["abs_profit_kron"] < 0
        )

        return {
            "sku_count": len(all_sku_decisions),
            "category_count": len({s["category"] for s in all_sku_decisions}),
            "totals": {
                "volume_tons": round(total_volume, 1),
                "revenue_kron": round(total_revenue, 0),
                "abs_profit_kron": round(total_abs_profit, 1),
                "loss_makers_kron": round(loss_makers_kron, 1),
            },
            "flag_counts": flag_counts,
            "skus": all_sku_decisions,
        }

    @router.post("/drill")
    def drill(req: DrillRequest) -> Dict[str, Any]:
        """Per-SKU classification inside one category."""
        if not req.rows:
            raise HTTPException(400, "rows is empty")

        req_cfg = _merge_config(cfg, req.overrides)
        cats, skus = _aggregate_to_categories(req.rows, canonical)
        metrics, decisions = drill_category(req.category, skus, cats, req_cfg, req.period_months)
        if not decisions:
            raise HTTPException(404, f"No SKUs found for category '{req.category}'")
        return {
            "category": req.category,
            "sku_count": len(decisions),
            "decisions": [
                {
                    "id": d.id,
                    "flag": d.flag,
                    "reason": d.reason,
                    "recommendation": d.recommendation,
                    "real_margin_pct": d.real_margin_pct,
                    "volume_tons": d.volume_tons,
                    "abs_profit_kron": d.abs_profit_kron,
                    "dio_days": d.dio_days,
                    "do_not_eliminate": d.do_not_eliminate,
                    "alert_reason": d.alert_reason,
                    "gross_margin_pct": next(
                        (round(m.gm_pct, 1) for m in metrics if m.category == d.id),
                        None,
                    ),
                }
                for d in decisions
            ],
        }

    @router.post("/analyze")
    def analyze(req: AnalyzeRequest) -> Dict[str, Any]:
        """AI analysis with SPECIFIC SKU-level removal recommendations.

        When `rows` are posted, the engine drills into each ELIMINATE and
        WARNING category and picks the worst SKUs by composite score
        (negative real margin × volume). Those become the AI's hit list —
        not generic category advice, but "remove SKU X, expect Y kRON saved".
        """
        req_cfg = _merge_config(cfg, req.overrides)
        # Build SKU-level rec list
        sku_recs: List[Dict[str, Any]] = []
        if req.rows:
            cats, _ = _aggregate_to_categories(req.rows, canonical)
            cat_metrics, cat_decisions = run_pipeline(cats, req_cfg, period_months=req.period_months)
            cat_flag_by_name = {d.id: d.flag for d in cat_decisions}
            cats_by_name = {c.category: c for c in cats}
            from .frontend_helpers import classify_skus_within_category

            for cat_decision in cat_decisions:
                # Drill into eliminate + warning + scale categories — those are
                # the actionable ones. Anchors are protected by definition.
                if cat_decision.flag not in ("ELIMINATE", "WARNING", "ANCHOR_ALERT"):
                    continue
                cat_row = cats_by_name.get(cat_decision.id)
                if cat_row is None:
                    continue
                from ..models import SkuRow as _SkuRow
                in_cat = [
                    _SkuRow(
                        sku_id=(r.sku or r.category).strip(),
                        sku_name=(r.sku or r.category).strip(),
                        category=r.category,
                        volume_tons=r.volume_tons,
                        niv_kron=r.revenue_kron,
                        gm_pct=r.gross_margin_pct,
                        gm_kron=r.revenue_kron * r.gross_margin_pct / 100.0,
                    )
                    for r in req.rows if r.category == cat_decision.id
                ]
                sku_decisions = classify_skus_within_category(
                    cat_row, in_cat, req_cfg, req.period_months,
                )
                for s in sku_decisions:
                    if s["is_anchor"] or s["flag"] not in ("ELIMINATE", "WARNING"):
                        continue
                    # Healthy gross margin shield (mirrors upload-excel handler):
                    # 10%+ gross GM with non-negative real margin = niche premium,
                    # not a removal candidate.
                    if s["gross_margin_pct"] >= 10.0 and s["real_margin_pct"] >= 0:
                        continue
                    sku_recs.append({
                            "sku": s["id"],
                            "category": s["category"],
                            "brand": s.get("brand"),
                            "volume_t": s["volume_tons"],
                            "real_margin_pct": s["real_margin_pct"],
                            "absolute_profit_kron": s["abs_profit_kron"],
                            "dio_days": s["category_dio_days"],
                            "verdict": _verdict_for(s),
                            "reason": _human_reason(s),
                            "category_flag": cat_decision.flag,
                        })

            # Rank by impact: most-negative profit first, then biggest absolute profit
            # for thin-margin warnings (more volume = more recovery potential).
            sku_recs.sort(key=lambda r: (
                0 if r["absolute_profit_kron"] < 0 else 1,
                r["absolute_profit_kron"] if r["absolute_profit_kron"] < 0 else -r["absolute_profit_kron"],
            ))

        return _build_analysis(req.run, req.language, canonical_skus, sku_recs)

    @router.post("/alerts")
    def alerts_endpoint(req: SkusRequest) -> Dict[str, Any]:
        """Run the alert detector across the uploaded rows.

        Same input shape as /api/skus — the engine classifies, then derives
        the full set of CFO alerts from the resulting metrics + SKU records.
        """
        if not req.rows:
            raise HTTPException(400, "rows is empty")

        req_cfg = _merge_config(cfg, req.overrides)
        cats, sku_records = _aggregate_to_categories(req.rows, canonical)
        metrics, decisions = run_pipeline(cats, req_cfg, period_months=req.period_months)
        alerts = detect_alerts(metrics, decisions, sku_records, req_cfg)

        return {
            "alerts": [a.model_dump() for a in alerts],
            "summary": alert_summary(alerts),
        }

    return router


def _resolve_columns(headers: List[str]) -> Dict[str, Optional[str]]:
    """Match Excel headers to logical fields. Tolerant to variants used in the
    legacy workbooks we've seen.

    Patterns are tried in order — the first pattern that matches ANY header
    wins. This means more specific patterns (e.g. `NIV (kRon)`) take priority
    over generic ones (`NIV anywhere in the name`), which matters when an
    Excel has multiple "NIV*" columns at different units.
    """
    import re
    def find(patterns: List[str]) -> Optional[str]:
        for p in patterns:
            for h in headers:
                if re.search(p, str(h).lower()):
                    return h
        return None

    return {
        # Most-specific patterns first.
        "category": find([r"^categ", r"\bcategor"]),
        "product":  find([r"^denumire", r"product[_ ]?name", r"^sku\b", r"\bnume\b"]),
        "brand":    find([r"^brand"]),
        # Volume: "Volume(to)" first, fall back to other variants.
        "volume":   find([r"^volume\(to\)", r"^volume_t\b", r"^volume\(", r"^volum"]),
        # NIV: prefer the kRON column explicitly (it has parens around the unit).
        # The "NIV TURNOVER - Net Invoiced" column in the legacy workbook is in
        # full RON, not kRON — picking it would multiply totals by 1000.
        "niv":      find([r"^niv\s*\(\s*kron\b", r"niv.*kron", r"^niv\s*\(", r"^niv\s*$"]),
        "gm_pct":   find([r"gm 2 wo dep %", r"gm.*%", r"gross[_ ]margin.*%", r"^gm\s*$"]),
        # GM in kRON — when present we derive GM% as gm_kron / niv_kron, which
        # is unit-stable (no decimal/percent guesswork). The legacy workbook
        # exposes this as "GM (kRon)".
        "gm_kron":  find([r"^gm\s*\(\s*kron\b", r"gm\s*\(kron"]),
    }


def _safe_float(v: Any) -> float:
    try:
        f = float(v)
        if f != f:  # NaN
            return 0.0
        return f
    except (ValueError, TypeError):
        return 0.0


def _verdict_for(sku: Dict[str, Any]) -> str:
    """Map a SKU decision row to a human verdict."""
    if sku["flag"] == "ELIMINATE":
        if sku["real_margin_pct"] < -5:
            return "remove now"
        return "wind down"
    if sku["flag"] == "WARNING":
        if sku["volume_tons"] > 50:
            return "renegotiate or exit"
        return "wind down"
    return "review"


def _human_reason(sku: Dict[str, Any]) -> str:
    """Human-readable one-liner explaining why this SKU is on the list."""
    rm = sku["real_margin_pct"]
    vol = sku["volume_tons"]
    profit = sku["abs_profit_kron"]
    if rm < 0:
        return f"Bleeds {abs(profit):.1f} kRON at {rm:.1f}% real margin — every unit sold loses money."
    if vol < 1 and profit < 5:
        return f"Sub-tonne volume ({vol:.2f}t) and tiny profit ({profit:.2f} kRON) — costs more to administer than it earns."
    if rm < 3:
        return f"{vol:.0f}t volume but only {rm:.1f}% real margin — capital better deployed elsewhere."
    return f"DIO too long for the margin earned ({rm:.1f}%)."


def _build_analysis(
    run: Dict[str, Any],
    language: str,
    canonical_skus: List[SkuRow],
    sku_recs: Optional[List[Dict[str, Any]]] = None,
    use_claude: bool = True,
) -> Dict[str, Any]:
    """Build the AI analysis payload.

    `sku_recs` (when provided) carries SPECIFIC per-SKU removal candidates
    derived from drilling into ELIMINATE/WARNING categories — these are what
    the AI panel surfaces as "remove SKU X, expect Y kRON saved" cards.
    """
    eliminate = run.get("eliminate", [])
    review = run.get("review", [])
    scale = run.get("scale", [])
    anchors = run.get("anchors", [])
    alerts = [a for a in anchors if a.get("status") == "alert"]

    eliminations = [
        {
            "name": c["name"],
            "real_margin_pct": c.get("realMargin", 0.0),
            "absolute_profit_kron": c.get("absoluteProfit", 0.0),
            "verdict": "remove now" if c.get("realMargin", 0.0) < -5 else "wind down",
            "reason": c.get("reason", "Below cost of capital"),
            "capital_freed_note": (
                f"Frees inventory tied up in {c['name']} — see SKU drill for specific cuts."
            ),
        }
        for c in eliminate[:5]
    ]

    # SKU-level removals: prefer the SPECIFIC list from /api/analyze; fall back
    # to category-mapped canonical SKUs when no rows were posted.
    sku_removals: List[Dict[str, Any]] = []
    if sku_recs:
        sku_removals = sku_recs[:30]
    else:
        elim_cats = {c["name"] for c in eliminate}
        for s in canonical_skus[:50]:
            if s.category in elim_cats:
                sku_removals.append({
                    "sku": s.sku_name,
                    "category": s.category,
                    "volume_t": round(s.volume_tons, 3),
                    "real_margin_pct": 0.0,
                    "absolute_profit_kron": round(s.gm_kron, 2),
                    "dio_days": 0,
                    "verdict": "remove now",
                    "reason": f"Parent category {s.category} flagged for elimination.",
                })

    proposition = []
    for c in eliminate[:3]:
        proposition.append({
            "title": f"Discontinue {c['name']}",
            "detail": c.get("reason", "Real margin below cost of capital."),
            "impact": f"~{abs(c.get('absoluteProfit', 0)):.1f} kRON loss removed",
            "priority": "high",
        })
    for a in alerts[:2]:
        proposition.append({
            "title": f"Renegotiate {a['name']}",
            "detail": a.get("alertReason") or "Anchor below margin floor.",
            "impact": f"{a.get('absoluteProfit', 0):.0f} kRON anchor profit at risk",
            "priority": "high",
        })
    for c in review[:2]:
        proposition.append({
            "title": f"Review pricing for {c['name']}",
            "detail": c.get("reason", "Margin compressed by working capital cost."),
            "impact": "Recover working capital velocity",
            "priority": "medium",
        })
    for c in scale[:1]:
        proposition.append({
            "title": f"Scale {c['name']}",
            "detail": "Real margin clears the cost of capital with headroom.",
            "impact": f"{c.get('absoluteProfit', 0):.0f} kRON profit, room to grow",
            "priority": "medium",
        })

    headline_en = (
        f"{len(eliminate)} eliminations, {len(alerts)} anchor alerts, {len(scale)} scale opportunities. "
        f"Working capital {run.get('workingCapitalMRon', 0):.1f}M RON at "
        f"{run.get('roicPct', 0):.1f}% ROIC."
    )
    headline_ro = (
        f"{len(eliminate)} eliminări, {len(alerts)} alerte ancoră, "
        f"{len(scale)} oportunități de scalare. Capital de lucru "
        f"{run.get('workingCapitalMRon', 0):.1f}M RON la "
        f"{run.get('roicPct', 0):.1f}% ROIC."
    )

    summary_en, summary_ro = _build_summaries(run, eliminate, alerts, scale)
    powered_by = "deterministic"

    # If Claude is configured, replace deterministic prose + SKU reasons with model output.
    if use_claude and (sku_recs or eliminate):
        from .ai_analyzer import claude_analysis
        claude = claude_analysis(run, sku_recs or [])
        if claude and "_error" not in claude:
            powered_by = "claude-sonnet-4-7"
            headline_en = claude.get("headline", headline_en)
            headline_ro = claude.get("headline", headline_ro)  # Claude returns one headline
            summary_en = claude.get("summary_en", summary_en)
            summary_ro = claude.get("summary_ro", summary_ro)

            # Merge per-SKU reasons into sku_removals
            ai_reasons = {r["sku"]: r["reason"] for r in claude.get("sku_reasons", [])
                          if isinstance(r, dict) and "sku" in r and "reason" in r}
            for s in sku_removals:
                if s.get("sku") in ai_reasons:
                    s["reason"] = ai_reasons[s["sku"]]
                    s["reason_source"] = "ai"
                else:
                    s["reason_source"] = "engine"

            # Use Claude's propositions if returned and well-formed
            ai_props = claude.get("propositions")
            if isinstance(ai_props, list) and ai_props:
                proposition = [
                    {
                        "title": p.get("title", "Action"),
                        "detail": p.get("detail", ""),
                        "impact": p.get("impact", ""),
                        "priority": p.get("priority", "medium"),
                    }
                    for p in ai_props if isinstance(p, dict)
                ]

    return {
        "headline": headline_en if language == "en" else headline_ro,
        "summary_en": summary_en,
        "summary_ro": summary_ro,
        "eliminations": eliminations,
        "sku_removals": sku_removals,
        "proposition": proposition,
        "confidence": run.get("confidence", "medium"),
        "powered_by": powered_by,
    }


def _build_summaries(
    run: Dict[str, Any],
    eliminate: List[Dict[str, Any]],
    alerts: List[Dict[str, Any]],
    scale: List[Dict[str, Any]],
) -> Tuple[str, str]:
    """Two-paragraph narrative — deterministic so UI works without an API key.

    If ANTHROPIC_API_KEY is set, swap in the real briefing module here.
    """
    elim_names = ", ".join(c["name"] for c in eliminate[:3]) or "none"
    alert_names = ", ".join(a["name"] for a in alerts) or "none"
    scale_names = ", ".join(c["name"] for c in scale) or "none"

    en = (
        f"Working capital deployed: {run.get('workingCapitalMRon', 0):.2f}M RON, "
        f"earning {run.get('roicPct', 0):.1f}% ROIC against a "
        f"{run.get('costOfCapitalPct', 6.5):.1f}% cost of capital. "
        f"Engine flagged {len(eliminate)} categories for elimination ({elim_names}) and "
        f"{len(alerts)} anchor alerts ({alert_names}).\n\n"
        f"Scale opportunities: {scale_names}. Anchors generate "
        f"{run.get('anchorProfitShare', 0) * 100:.1f}% of real profit — protect them; "
        f"every other line either earns its capital or it doesn't."
    )
    ro = (
        f"Capital de lucru desfășurat: {run.get('workingCapitalMRon', 0):.2f}M RON, "
        f"generând {run.get('roicPct', 0):.1f}% ROIC față de un cost de capital de "
        f"{run.get('costOfCapitalPct', 6.5):.1f}%. "
        f"Motorul a marcat {len(eliminate)} categorii pentru eliminare ({elim_names}) și "
        f"{len(alerts)} alerte de ancoră ({alert_names}).\n\n"
        f"Oportunități de scalare: {scale_names}. Ancorele generează "
        f"{run.get('anchorProfitShare', 0) * 100:.1f}% din profitul real — protejați-le."
    )
    return en, ro
