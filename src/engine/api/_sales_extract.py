"""Sales-dataset extraction — XLSX → sku_lines → sku_aggregates.

The earlier path for sku-scope uploads asked Opus to summarize the workbook
into a briefing + a handful of synthetic category roll-up rows. That's the
wrong abstraction for trading-analysis files which already have one row per
(sku × channel × client) at native granularity. This module reads the
spreadsheet rows directly via openpyxl, maps columns to a normalized schema,
streams them into sku_lines, then rolls up to sku_aggregates.

Pipeline branch: when a document's scope is 'sku' AND the workbook has
a recognizable sales shape (column synonyms match), `extract_sales_dataset`
takes over from the generic LLM-briefing path.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Tuple

from openpyxl import load_workbook  # type: ignore


# ─── Column synonyms ────────────────────────────────────────────────────────
# Each canonical field has a list of regexes; first match wins. Headers are
# normalized (lowercased + stripped) before matching. Order in the list
# expresses preference when multiple variants might match.

COLUMN_SYNONYMS: Dict[str, List[str]] = {
    "channel": [r"^canal$", r"^channel$"],
    "client_type": [r"^tip[\s_]client$", r"^client[\s_]type$"],
    "client_parent": [r"^client[_\s]?parinte$", r"^client[\s_]parent$", r"^cliente?$", r"^customer$"],
    "business_unit": [r"^bu$", r"^business[_\s]unit$", r"^div(?:erse)?$"],
    "category": [r"^categ[_\s]?pr$", r"^categori[ea]?$", r"^categ$", r"^category$", r"^specie$"],
    "brand": [r"^brand$", r"^marca$", r"^marque$"],
    "product_name": [r"^denumire[_\s]?produs$", r"^denumire$", r"^product[\s_]name$", r"^sku$", r"^article$", r"^product$"],
    "pack_size": [r"^pack[\s_]?size$", r"^pack$", r"^cantitate$"],
    "volume_kg": [r"^volume[\s_]?kg$", r"^volum[\s_]?kg$", r"^sold[\s_]?in[\s_]?kg$"],
    "volume_tons": [r"^volume\s*\(to\)$", r"^volume[\s_]?to$", r"^volum[\s_]?to$", r"^volume$"],
    "gross_revenue": [r"^gross[\s_]revenue$", r"^vanzari[\s_]brute$"],
    "niv_turnover": [
        r"^niv[\s_]turnover.*",
        r"^niv[\s_]\(?\s*krn?\s*\)?$",
        r"^niv$",
        r"^net[\s_]invoiced.*",
    ],
    "nip_revenue": [r"^nip$", r"^nip[\s_]revenue$", r"^net[\s_]in[\s_]pocket$"],
    "raw_materials": [r"^raw[\s_]materials?$", r"^materii[\s_]prime$"],
    "pack_materials": [r"^pack[\s_]materials?$", r"^ambalaje$"],
    "secondary_pack_materials": [r"^secondary[\s_]pack.*", r"^ambalaje[\s_]secundare$"],
    "direct_material_cost": [r"^direct[\s_]material[\s_]cost$", r"^cost[\s_]material[\s_]direct$"],
    "transportation_cost": [r"^transport.*$", r"^transportation[\s_]cost$"],
    "conversion_cost": [r"^conversion[\s_]cost$", r"^cost[\s_]conversie$"],
    "warehousing_cost": [r"^warehousing.*$", r"^depozitare$"],
    "environment_tax": [r"^environment[\s_]tax$", r"^env[\s_]tax$", r"^taxa[\s_]de[\s_]mediu$"],
    "depreciation": [r"^depreciation$", r"^amortizare$"],
    "direct_margin": [r"^direct[\s_]margin$", r"^marja[\s_]directa$"],
    "gm_krn": [
        r"^gm\s*\(?\s*krn?\s*\)?$",
        r"^gm2[\s_]?with[\s_]?dep$",
        r"^gross[\s_]margin$",
        r"^gm$",
        r"^profit$",
    ],
    "gm_pct": [r"^gm2[\s_]?pct$", r"^gm[\s_]?pct$", r"^gm[\s_]?%$", r"^%\s*gm$"],
}


def _normalize_header(h: Any) -> str:
    if h is None:
        return ""
    return re.sub(r"\s+", " ", str(h).strip().lower())


def _match_synonym(header: str, patterns: List[str]) -> bool:
    for p in patterns:
        if re.search(p, header):
            return True
    return False


def _build_column_map(headers: List[Any]) -> Dict[str, int]:
    """Map canonical field name → column index. Required: product_name +
    niv_turnover. Others optional (file may omit cost breakdown columns).
    """
    normalized = [_normalize_header(h) for h in headers]
    col_map: Dict[str, int] = {}
    for canonical, patterns in COLUMN_SYNONYMS.items():
        for idx, h in enumerate(normalized):
            if not h:
                continue
            if _match_synonym(h, patterns):
                col_map[canonical] = idx
                break
    return col_map


# ─── Sheet selection ────────────────────────────────────────────────────────

YTD_PATTERN = re.compile(r"\b(ytd|q[1-4]|h[12]|fy)\b", re.IGNORECASE)


def _pick_data_sheet(sheet_names: List[str]) -> str:
    """Prefer YTD/Q* sheets; fall back to the first non-summary sheet, then
    the first sheet."""
    for name in sheet_names:
        if YTD_PATTERN.search(name):
            return name
    for name in sheet_names:
        if not re.search(r"^(summary|index|toc|notes?)$", name, re.IGNORECASE):
            return name
    return sheet_names[0]


def _find_header_row(rows: List[List[Any]]) -> Tuple[int, Dict[str, int]]:
    """Some XLSX files have title rows above the actual headers. Scan the
    first 12 rows; return the index of the row that yields the richest
    column map (i.e. matches the most canonical fields)."""
    best_idx = 0
    best_map: Dict[str, int] = {}
    for i in range(min(12, len(rows))):
        candidate = _build_column_map(rows[i])
        if len(candidate) > len(best_map):
            best_idx = i
            best_map = candidate
    return best_idx, best_map


# ─── Detection ──────────────────────────────────────────────────────────────


def is_sales_dataset(xlsx_bytes: bytes) -> Tuple[bool, Optional[Dict[str, Any]]]:
    """Returns (is_sales, info). Info includes sheet name + column map +
    inferred period label when sales-shaped. The pipeline calls this before
    deciding which branch to take; a False here keeps the existing generic
    LLM-summary path."""
    try:
        wb = load_workbook(io.BytesIO(xlsx_bytes), data_only=True, read_only=True)
    except Exception:
        return False, None
    if not wb.sheetnames:
        return False, None
    sheet_name = _pick_data_sheet(wb.sheetnames)
    ws = wb[sheet_name]
    # Read up to first 14 rows to find headers.
    sniff: List[List[Any]] = []
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        sniff.append(list(row))
        if i >= 13:
            break
    if not sniff:
        return False, None
    header_idx, col_map = _find_header_row(sniff)
    required = {"product_name", "niv_turnover"}
    if not required.issubset(col_map.keys()):
        return False, None
    return True, {
        "sheet_name": sheet_name,
        "header_row_index": header_idx,
        "column_map": col_map,
        "period_label": _infer_period_label(sheet_name),
    }


def _infer_period_label(sheet_name: str) -> str:
    # "YTD October '25" / "YTD Oct '25" / "Q4 2025" — normalize.
    m = re.search(r"(YTD|Q[1-4]|H[12]|FY)[^\d\w]*([A-Za-z]{3,9})?[^\d]*'?(\d{2,4})?", sheet_name, re.IGNORECASE)
    if m:
        return " ".join(part for part in [m.group(1).upper(), m.group(2), m.group(3) and f"'{m.group(3)[-2:]}"] if part)
    return sheet_name


# ─── Row streaming ──────────────────────────────────────────────────────────


def _num(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        # Romanian decimal: "1.234,56" → 1234.56
        s = str(v).strip().replace("\xa0", "")
        if "," in s and s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
        return float(s)
    except (TypeError, ValueError):
        return None


def stream_sales_rows(xlsx_bytes: bytes, info: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    """Yield one dict per data row from the sheet identified by `info`.
    Skips rows where product_name is empty. Coerces numbers, handles
    Romanian decimal separators."""
    wb = load_workbook(io.BytesIO(xlsx_bytes), data_only=True, read_only=True)
    ws = wb[info["sheet_name"]]
    col_map: Dict[str, int] = info["column_map"]
    header_idx: int = info["header_row_index"]

    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i <= header_idx:
            continue
        row_list = list(row)
        prod_idx = col_map.get("product_name")
        if prod_idx is None or prod_idx >= len(row_list):
            continue
        product = row_list[prod_idx]
        if not product or not str(product).strip():
            continue
        rec: Dict[str, Any] = {}
        for field, idx in col_map.items():
            if idx >= len(row_list):
                continue
            val = row_list[idx]
            if field in ("product_name", "brand", "category", "channel", "client_type",
                          "client_parent", "business_unit", "pack_size"):
                rec[field] = str(val).strip() if val is not None else None
            else:
                rec[field] = _num(val)
        # Derived: volume_tons + niv_krn + gm_krn. Files vary in which
        # version they provide; we normalize so downstream code has a
        # single source of truth.
        if rec.get("volume_tons") is None and rec.get("volume_kg") is not None:
            rec["volume_tons"] = (rec["volume_kg"] or 0) / 1000.0
        if rec.get("niv_krn") is None and rec.get("niv_turnover") is not None:
            rec["niv_krn"] = rec["niv_turnover"]
        if rec.get("gm_krn") is None and rec.get("direct_margin") is not None:
            rec["gm_krn"] = rec["direct_margin"]
        # gm_pct fallback: gm_krn / niv_krn
        if rec.get("gm_pct") is None and rec.get("gm_krn") and rec.get("niv_krn"):
            try:
                rec["gm_pct"] = float(rec["gm_krn"]) / float(rec["niv_krn"])
            except (TypeError, ValueError, ZeroDivisionError):
                pass
        yield rec


# ─── Roll-up: lines → aggregates ────────────────────────────────────────────


@dataclass
class _Agg:
    product_name: str
    brand: Optional[str] = None
    category: Optional[str] = None
    volume_tons: float = 0.0
    niv_krn: float = 0.0
    gm_krn: float = 0.0
    line_row_count: int = 0
    channels: set = None  # type: ignore[assignment]
    clients: set = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.channels is None:
            self.channels = set()
        if self.clients is None:
            self.clients = set()


def aggregate_sku_lines(lines: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Roll lines up to one row per product_name. Returns list of dicts
    ready for insertion into sku_aggregates (without dataset_id / org_id —
    the caller stamps those)."""
    bucket: Dict[str, _Agg] = {}
    for line in lines:
        name = (line.get("product_name") or "").strip()
        if not name:
            continue
        agg = bucket.get(name)
        if agg is None:
            agg = _Agg(product_name=name, brand=line.get("brand"), category=line.get("category"))
            bucket[name] = agg
        agg.volume_tons += line.get("volume_tons") or 0.0
        agg.niv_krn += line.get("niv_krn") or 0.0
        agg.gm_krn += line.get("gm_krn") or 0.0
        agg.line_row_count += 1
        ch = line.get("channel")
        if ch:
            agg.channels.add(ch)
        cl = line.get("client_parent")
        if cl:
            agg.clients.add(cl)
        if not agg.brand and line.get("brand"):
            agg.brand = line.get("brand")
        if not agg.category and line.get("category"):
            agg.category = line.get("category")

    rows: List[Dict[str, Any]] = []
    for a in bucket.values():
        gm_pct = (a.gm_krn / a.niv_krn) if a.niv_krn else 0.0
        rows.append({
            "product_name": a.product_name,
            "brand": a.brand,
            "category": a.category,
            "volume_tons": round(a.volume_tons, 4),
            "niv_krn": round(a.niv_krn, 2),
            "gm_krn": round(a.gm_krn, 2),
            "gm_pct": round(gm_pct, 6),
            "line_row_count": a.line_row_count,
            "channels_present": sorted(a.channels),
            "clients_present": sorted(a.clients),
        })
    return rows
