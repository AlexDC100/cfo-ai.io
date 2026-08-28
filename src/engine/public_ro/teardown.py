"""Teardown generator — deterministic, operator-only blog drafts from
public-summary data (Lane 5, public-data acquisition engine).

POST /api/public/ro/companies/{cui}/teardown renders a blog-ready
markdown draft (headline, KPI summary table, trend description, health
flags, source attribution + the honest "public summary data" note) plus
inline-SVG sparkline files into ``data/public_teardowns/<cui>-<year>/``
and returns ``{"markdown": ..., "files": [...]}``. It NEVER
auto-publishes anything — the draft sits on disk until a human moves it.
A GET lists the drafts on disk (same gate).

Gate: the ENGINE_API_TOKEN FAIL-CLOSED pattern (verbatim from
src/engine/api/_org.py:130 — 503 when the token is unset, 401 on a
missing/invalid Bearer). Never the _billing.py degrade-open variant:
an unconfigured deployment must not let anonymous callers write files.

Determinism: same company rows in → byte-identical markdown and SVG out.
No timestamps, no randomness, no AI (wave rule: zero anthropic imports;
the PUBLIC_AI_NARRATIVE seam is checked but this wave always takes the
deterministic branch).

Data contract (lane 1, concurrent): ``engine.public_ro.store.
fetch_company(cui) -> Optional[dict]`` shaped
``{"cui", "name"?, "tip_contrib"?, "years": [{"year": int,
"indicators": {"I1"..."I20": int|None}, "derived": {...}?,
"provenance": {"dataset_version"?, "source"?, ...}?}]}``.
Indicator i-codes follow the VERIFIED stable FY2019-FY2025 layout
(data.gov.ro mfp bilant mass files): I13=Cifra de afaceri neta,
I18=Profit net, I19=Pierdere neta (both non-negative; net = I18-I19),
I7=Datorii, I10=Capitaluri total, I20=Numar mediu de salariati,
Active totale = I1+I2+I6 (computed). i-codes are positional per
(year, family) and are resolved from the companion spec .csv at ingest
time by lane 1 — by the time rows reach this renderer they are already
normalized to the stable layout.

PS7 belt-and-braces: bilant mass files are companies-only by
construction, but if the row carries an identification join we refuse
any ``tip_contrib`` that is not PJ before rendering.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

logger = logging.getLogger("engine.public_ro.teardown")

_ENV_TEARDOWNS_DIR = "PUBLIC_TEARDOWNS_DIR"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def teardowns_dir() -> Path:
    env = os.environ.get(_ENV_TEARDOWNS_DIR)
    if env:
        return Path(env)
    return _repo_root() / "data" / "public_teardowns"


# ──────────────────────────────────────────────────────────────────────
# Operator gate — fail-closed (copied from _org.py:130, the ONLY
# acceptable variant for a write endpoint)
# ──────────────────────────────────────────────────────────────────────

def _require_operator(authorization: Optional[str]) -> None:
    from fastapi import HTTPException

    token = os.environ.get("ENGINE_API_TOKEN")
    if not token:
        raise HTTPException(
            503,
            "ENGINE_API_TOKEN is not configured; refusing to run the "
            "operator-only teardown generator.",
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    if authorization.split(" ", 1)[1].strip() != token:
        raise HTTPException(401, "Invalid operator token.")


# ──────────────────────────────────────────────────────────────────────
# Deterministic rendering helpers
# ──────────────────────────────────────────────────────────────────────

def _ind(year_row: Mapping[str, Any], code: str) -> Optional[int]:
    value = (year_row.get("indicators") or {}).get(code)
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _net_result(year_row: Mapping[str, Any]) -> Optional[int]:
    derived = year_row.get("derived") or {}
    if isinstance(derived.get("net_result"), int):
        return int(derived["net_result"])
    profit, loss = _ind(year_row, "I18"), _ind(year_row, "I19")
    if profit is None and loss is None:
        return None
    return (profit or 0) - (loss or 0)


def _active_totale(year_row: Mapping[str, Any]) -> Optional[int]:
    derived = year_row.get("derived") or {}
    if isinstance(derived.get("active_totale"), int):
        return int(derived["active_totale"])
    parts = [_ind(year_row, c) for c in ("I1", "I2", "I6")]
    if all(p is None for p in parts):
        return None
    return sum(p or 0 for p in parts)


def _fmt_ron(value: Optional[int]) -> str:
    if value is None:
        return "n/a"
    return f"{value:,}".replace(",", ".")  # 1.234.567 — RO thousands style


def _pct_change(old: Optional[int], new: Optional[int]) -> Optional[float]:
    if old is None or new is None or old == 0:
        return None
    return (new - old) / abs(old) * 100.0


def _sparkline_svg(values: Sequence[Optional[int]], *, width: int = 240,
                   height: int = 48, stroke: str = "#1a5490") -> str:
    """Server-rendered inline SVG sparkline (wave rule: zero JS beyond
    the beacon). Deterministic: pure function of the values."""
    points = [(i, v) for i, v in enumerate(values) if v is not None]
    if len(points) < 2:
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" '
            f'height="{height}" viewBox="0 0 {width} {height}"></svg>'
        )
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    x_span = (x_max - x_min) or 1
    y_span = (y_max - y_min) or 1
    pad = 4
    coords = []
    for x, y in points:
        px = pad + (x - x_min) / x_span * (width - 2 * pad)
        py = height - pad - (y - y_min) / y_span * (height - 2 * pad)
        coords.append(f"{px:.1f},{py:.1f}")
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" '
        f'height="{height}" viewBox="0 0 {width} {height}">'
        f'<polyline fill="none" stroke="{stroke}" stroke-width="2" '
        f'points="{" ".join(coords)}"/></svg>'
    )


def _health_flags(years: Sequence[Mapping[str, Any]]) -> List[str]:
    """Deterministic rule-based flags — no editorializing beyond the
    data (project non-goal: recommendations come from rules)."""
    flags: List[str] = []
    if not years:
        return flags
    last = years[-1]
    capitaluri = _ind(last, "I10")
    if capitaluri is not None and capitaluri < 0:
        flags.append(
            "Capitaluri totale negative în ultimul an raportat — semnal "
            "de fragilitate a bilanțului (vezi Legea 31/1990 privind "
            "reconstituirea capitalului)."
        )
    net = _net_result(last)
    if net is not None and net < 0:
        flags.append("Pierdere netă în ultimul an raportat.")
    datorii, active = _ind(last, "I7"), _active_totale(last)
    if datorii is not None and active is not None and active > 0 and datorii > active:
        flags.append("Datoriile depășesc activele totale în ultimul an raportat.")
    if len(years) >= 2:
        emp_prev, emp_last = _ind(years[-2], "I20"), _ind(last, "I20")
        if (
            emp_prev is not None and emp_last is not None and emp_prev > 0
            and (emp_prev - emp_last) / emp_prev > 0.2
        ):
            flags.append(
                "Numărul mediu de salariați a scăzut cu peste 20% față de "
                "anul precedent."
            )
        loss_years = sum(1 for y in years[-3:] if (_net_result(y) or 0) < 0)
        if loss_years >= 2:
            flags.append("Pierderi în cel puțin doi din ultimii trei ani raportați.")
    return flags


def _trend_sentence(label: str, series: Sequence[Tuple[int, Optional[int]]]) -> Optional[str]:
    known = [(y, v) for y, v in series if v is not None]
    if len(known) < 2:
        return None
    (y0, v0), (y1, v1) = known[0], known[-1]
    change = _pct_change(v0, v1)
    if change is None:
        return None
    direction = "a crescut" if change > 0 else ("a scăzut" if change < 0 else "a rămas constantă")
    if change == 0:
        return f"{label} a rămas constantă între {y0} și {y1}."
    return (
        f"{label} {direction} cu {abs(change):.1f}% între {y0} "
        f"({_fmt_ron(v0)} RON) și {y1} ({_fmt_ron(v1)} RON)."
    )


def render_teardown(company: Mapping[str, Any]) -> Dict[str, Any]:
    """Pure renderer: company dict in → ``{"markdown", "svg_files":
    {filename: svg_text}, "year": int}``. Deterministic — no clock, no
    randomness, no network, no AI."""
    cui = str(company.get("cui"))
    name = company.get("name") or f"CUI {cui}"
    years = sorted(
        (y for y in (company.get("years") or []) if y.get("year") is not None),
        key=lambda y: int(y["year"]),
    )
    if not years:
        raise ValueError("no reported years for this company")
    last = years[-1]
    last_year = int(last["year"])

    # PUBLIC_AI_NARRATIVE seam — flag checked, but this wave ALWAYS
    # renders the deterministic template (credits absent; the AI branch
    # is future work behind this flag).
    _ai_flag = os.environ.get("PUBLIC_AI_NARRATIVE", "")
    del _ai_flag  # deliberate: seam kept, branch not implemented

    turnover_series = [(int(y["year"]), _ind(y, "I13")) for y in years]
    net_series = [(int(y["year"]), _net_result(y)) for y in years]

    svg_files = {
        "cifra_afaceri_sparkline.svg": _sparkline_svg([v for _, v in turnover_series]),
        "rezultat_net_sparkline.svg": _sparkline_svg(
            [v for _, v in net_series], stroke="#0a7c3a"
        ),
    }

    provenance = last.get("provenance") or {}
    dataset_version = provenance.get("dataset_version")

    lines: List[str] = []
    lines.append(f"# {name} — analiză pe scurt din datele publice (FY{last_year})")
    lines.append("")
    lines.append(
        f"CUI {cui} · ultimul an raportat: {last_year} · "
        f"{len(years)} ani de raportări publice analizați."
    )
    lines.append("")
    lines.append("## Indicatori-cheie")
    lines.append("")
    lines.append(
        "| An | Cifra de afaceri netă (RON) | Rezultat net (RON) | "
        "Datorii (RON) | Capitaluri totale (RON) | Active totale (RON) | "
        "Salariați |"
    )
    lines.append("|---|---:|---:|---:|---:|---:|---:|")
    for y in years:
        lines.append(
            "| {year} | {cifra} | {net} | {datorii} | {capitaluri} | "
            "{active} | {salariati} |".format(
                year=int(y["year"]),
                cifra=_fmt_ron(_ind(y, "I13")),
                net=_fmt_ron(_net_result(y)),
                datorii=_fmt_ron(_ind(y, "I7")),
                capitaluri=_fmt_ron(_ind(y, "I10")),
                active=_fmt_ron(_active_totale(y)),
                salariati=_fmt_ron(_ind(y, "I20")),
            )
        )
    lines.append("")
    lines.append("![Cifra de afaceri](./cifra_afaceri_sparkline.svg)")
    lines.append("![Rezultat net](./rezultat_net_sparkline.svg)")
    lines.append("")
    lines.append("## Tendințe")
    lines.append("")
    trend_lines = [
        _trend_sentence("Cifra de afaceri netă", turnover_series),
        _trend_sentence("Rezultatul net", net_series),
        _trend_sentence(
            "Numărul mediu de salariați",
            [(int(y["year"]), _ind(y, "I20")) for y in years],
        ),
    ]
    trends = [t for t in trend_lines if t]
    if trends:
        lines.extend(f"- {t}" for t in trends)
    else:
        lines.append(
            "- Serie insuficientă pentru o tendință (un singur an raportat "
            "sau valori lipsă)."
        )
    lines.append("")
    lines.append("## Semnale de atenție")
    lines.append("")
    flags = _health_flags(years)
    if flags:
        lines.extend(f"- {f}" for f in flags)
    else:
        lines.append("- Niciun semnal de atenție declanșat de regulile standard.")
    lines.append("")
    lines.append("## Sursa datelor")
    lines.append("")
    lines.append(
        "Date: Ministerul Finanțelor, seturile publice de situații "
        "financiare anuale republicate pe data.gov.ro"
        + (f" (versiunea setului: {dataset_version})" if dataset_version else "")
        + ", licență CC-BY-4.0 pentru anii FY2019–FY2023."
    )
    lines.append("")
    lines.append(
        "**Notă de onestitate:** această analiză folosește exclusiv "
        "indicatorii agregați din datele publice (public summary data) — "
        "nu balanța de verificare completă a companiei. Nivelul de "
        "detaliu este limitat la ce publică statul; nu este o analiză "
        "contabilă completă și nu constituie consultanță."
    )
    lines.append("")

    return {
        "markdown": "\n".join(lines),
        "svg_files": svg_files,
        "year": last_year,
    }


def generate_teardown(
    company: Mapping[str, Any], *, out_root: Optional[Any] = None
) -> Dict[str, Any]:
    """Render + write the draft under
    ``<teardowns dir>/<cui>-<last year>/``. Writes NOTHING anywhere
    else — no publishing, no page-cache touch, no DB write."""
    rendered = render_teardown(company)
    cui = str(company.get("cui"))
    root = Path(out_root) if out_root is not None else teardowns_dir()
    target = root / f"{cui}-{rendered['year']}"
    target.mkdir(parents=True, exist_ok=True)
    files: List[str] = []
    md_path = target / "teardown.md"
    md_path.write_text(rendered["markdown"], encoding="utf-8")
    files.append(str(md_path))
    for filename, svg in rendered["svg_files"].items():
        svg_path = target / filename
        svg_path.write_text(svg, encoding="utf-8")
        files.append(str(svg_path))
    return {"markdown": rendered["markdown"], "files": files}


def list_drafts(out_root: Optional[Any] = None) -> List[Dict[str, Any]]:
    root = Path(out_root) if out_root is not None else teardowns_dir()
    drafts: List[Dict[str, Any]] = []
    if not root.is_dir():
        return drafts
    for entry in sorted(root.iterdir()):
        if entry.is_dir() and (entry / "teardown.md").is_file():
            drafts.append(
                {
                    "draft": entry.name,
                    "files": sorted(p.name for p in entry.iterdir() if p.is_file()),
                }
            )
    return drafts


# ──────────────────────────────────────────────────────────────────────
# Store access (lane 1 contract, concurrent)
# ──────────────────────────────────────────────────────────────────────

def _load_company(cui: str) -> Tuple[str, Optional[Dict[str, Any]]]:
    """Returns ("ok", company) / ("missing", None) / ("unavailable",
    None). Primary contract: ``engine.public_ro.store.fetch_company``;
    a couple of alternate names tolerated while the concurrent lane
    lands."""
    try:
        from engine.public_ro import store as _store  # type: ignore
    except Exception:  # noqa: BLE001 — lane 1 not landed / import error
        return "unavailable", None
    for name in ("fetch_company", "company_summary", "load_company"):
        fn = getattr(_store, name, None)
        if callable(fn):
            try:
                company = fn(cui)
            except Exception:  # noqa: BLE001
                logger.warning("[public_ro.teardown] store read failed", exc_info=True)
                return "unavailable", None
            return ("ok", company) if company else ("missing", None)
    return "unavailable", None


# ──────────────────────────────────────────────────────────────────────
# Router
# ──────────────────────────────────────────────────────────────────────

def build_teardown_router() -> Any:
    from fastapi import APIRouter, Header, HTTPException

    router = APIRouter()

    @router.post("/api/public/ro/companies/{cui}/teardown")
    def create_teardown(
        cui: str, authorization: Optional[str] = Header(None)
    ) -> Dict[str, Any]:
        _require_operator(authorization)
        if not cui.isdigit() or not (2 <= len(cui) <= 10):
            raise HTTPException(422, "CUI must be 2-10 digits.")
        status, company = _load_company(cui)
        if status == "unavailable":
            raise HTTPException(
                503, "Public store is not available on this deploy yet."
            )
        if status == "missing" or not company:
            raise HTTPException(404, "No public summary for this CUI.")
        # PS7 belt-and-braces: never render a PF/PFA record.
        tip = str(company.get("tip_contrib") or "PJ").upper()
        if tip != "PJ":
            raise HTTPException(404, "No public summary for this CUI.")
        try:
            return generate_teardown(company)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc

    @router.get("/api/public/ro/teardowns")
    def get_drafts(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        _require_operator(authorization)
        drafts = list_drafts()
        return {"count": len(drafts), "drafts": drafts}

    return router
