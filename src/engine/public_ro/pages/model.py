"""Page model for the public company page — pure computation, no I/O.

Turns (company row, filings rows, percentile rows) from
``engine.public_ro.store.PublicRoStore`` into a plain dict the templates
render. Everything here is deterministic: no clocks, no randomness, no
network, ZERO anthropic imports (PUBLIC_AI_NARRATIVE is checked but only
the deterministic branch exists this wave — the flag is a seam).

Canonical indicator slots (stable FY2019-FY2025 layout, resolved per
(year, family) from the companion spec .csv upstream — see specs.py;
verified live 2026-08):
  i1  Active imobilizate total     i11 Capital subscris varsat
  i2  Active circulante total      i13 Cifra de afaceri neta
  i3  Stocuri                      i14 Venituri totale
  i4  Creante                      i15 Cheltuieli totale
  i5  Casa si conturi la banci     i16 Profit brut
  i6  Cheltuieli in avans          i17 Pierdere bruta
  i7  DATORII (total, no ST/LT)    i18 Profit net
  i8  Venituri in avans            i19 Pierdere neta
  i9  Provizioane                  i20 Numar mediu de salariati
  i10 CAPITALURI TOTAL (there is NO separate "capitaluri proprii"
      column in the summary file — label honestly, PS rule)
Derived (persisted by lane 1): total_assets = i1+i2+i6,
net_result = i18 - i19.

Health flags are FACTUAL statements of what was reported — wording lives
in templates/i18n; this module only emits typed flag records.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Sequence

from .slug import canonical_slug

AI_NARRATIVE_FLAG = "PUBLIC_AI_NARRATIVE"

# Deterministic health-flag thresholds (mission-fixed).
DEBT_SPIKE_PCT = 50.0      # i7 YoY increase > 50%
REVENUE_DROP_PCT = 30.0    # i13 YoY drop > 30%
EMPLOYEE_DROP_PCT = 30.0   # i20 YoY drop > 30%
LOSS_YEARS_MIN = 2         # >= 2 consecutive net-loss years

# The conversion-signature locked cards (PS5): ratios the summary file
# structurally cannot support. Keys resolve labels via i18n
# ("locked_<key>"); labels must never contain digits (render test).
LOCKED_RATIO_KEYS = (
    "ebitda",
    "current_ratio",
    "dso",
    "dio",
    "interest_cover",
    "ocf",
)

TREND_METRICS = (
    # (model key, indicator slot, baseline_zero)
    ("revenue", "i13", False),
    ("net_result", "net_result", True),
    ("equity_total", "i10", True),
    ("liabilities", "i7", False),
    ("employees", "i20", False),
)

TREND_YEARS = 5  # five-year trend blocks per the mission layout

POSITION_METRICS = ("revenue", "net_result", "employees")
_POSITION_SLOT = {"revenue": "i13", "net_result": "net_result",
                  "employees": "i20"}


# ── formatting (shared by templates + OG) ──────────────────────────────

def fmt_int(n: Optional[int], lang: str = "ro") -> str:
    """Whole-RON int with thousands separators: RO 1.234.567 / EN 1,234,567."""
    if n is None:
        return "—"
    s = "{:,}".format(int(n))
    if lang == "ro":
        s = s.replace(",", ".")
    return s


def fmt_pct(x: Optional[float], lang: str = "ro") -> str:
    """One decimal place; RO uses the decimal comma."""
    if x is None:
        return "—"
    s = "%.1f%%" % x
    if lang == "ro":
        s = s.replace(".", ",")
    return s


def fmt_signed_pct(x: Optional[float], lang: str = "ro") -> str:
    if x is None:
        return "—"
    sign = "+" if x > 0 else ""
    return sign + fmt_pct(x, lang)


def fmt_compact_ron(n: Optional[int], lang: str = "ro") -> str:
    """Compact money for KPI cards / OG image: 41,3 mil. RON etc."""
    if n is None:
        return "—"
    v = float(n)
    a = abs(v)
    if a >= 1e9:
        num, unit = v / 1e9, ("mld." if lang == "ro" else "B")
    elif a >= 1e6:
        num, unit = v / 1e6, ("mil." if lang == "ro" else "M")
    elif a >= 1e3:
        num, unit = v / 1e3, ("mii" if lang == "ro" else "K")
    else:
        return "%s RON" % fmt_int(int(v), lang)
    s = "%.1f" % num
    if lang == "ro":
        s = s.replace(".", ",")
    return "%s %s RON" % (s, unit)


# ── small numeric helpers ──────────────────────────────────────────────

def _pct_change(prev: Optional[int], cur: Optional[int]) -> Optional[float]:
    if prev is None or cur is None or prev == 0:
        return None
    return (cur - prev) / abs(prev) * 100.0


def _slot(filing: Dict[str, Any], slot: str) -> Optional[int]:
    v = filing.get(slot)
    if v is None:
        return None
    return int(v)


def net_result_of(filing: Dict[str, Any]) -> Optional[int]:
    """Prefer the persisted derived column; else i18 - i19 (both columns
    are non-negative in the source files)."""
    v = filing.get("net_result")
    if v is not None:
        return int(v)
    p, l = filing.get("i18"), filing.get("i19")
    if p is None and l is None:
        return None
    return int(p or 0) - int(l or 0)


def total_assets_of(filing: Dict[str, Any]) -> Optional[int]:
    v = filing.get("total_assets")
    if v is not None:
        return int(v)
    parts = [filing.get("i1"), filing.get("i2"), filing.get("i6")]
    if all(p is None for p in parts):
        return None
    return sum(int(p or 0) for p in parts)


# ── licence evidence (the footer's input) ──────────────────────────────

def dataset_slug_of(provenance: Optional[Dict[str, Any]]) -> Optional[str]:
    """CKAN dataset slug behind a filing, from the joined provenance.

    ``provenance["dataset_id"]`` is the INGEST id ("2015_UU_<sha12>",
    ingest.py) and NOT a portal slug, so the slug can only be recovered
    from source_url. Returns None when there is nothing to read — a
    guessed slug would resolve to a guessed licence.
    """
    if not provenance:
        return None
    url = provenance.get("source_url")
    if not url:
        return None
    text = str(url).split("#", 1)[0].split("?", 1)[0].rstrip("/")
    if not text:
        return None
    return text.rsplit("/", 1)[-1] or None


def license_evidence(
    filings: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Per-filing licence evidence, ascending by year.

    A data.gov.ro bilanț licence varies BY YEAR under ONE registered
    source (FY2008-2018 = uk-ogl, FY2019-2023 = CC-BY-4.0), so the
    source-level licence is not the licence of any particular page. This
    only extracts what the store recorded; resolving an id and wording
    the sentence belong to compliance + the renderer.
    """
    out: List[Dict[str, Any]] = []
    for f in filings:
        prov = f.get("provenance") or {}
        out.append({
            "year": int(f["year"]),
            "license_id": prov.get("license_id"),
            "dataset_slug": dataset_slug_of(prov),
        })
    return out


# ── health flags (deterministic, factual) ──────────────────────────────

def build_health_flags(years: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """``years`` is the filings list ascending by year. Returns typed flag
    records; templates own the (factual) wording."""
    flags: List[Dict[str, Any]] = []
    by_year = list(years)

    # negative CAPITALURI TOTAL, most recent occurrence
    for f in reversed(by_year):
        cap = _slot(f, "i10")
        if cap is not None and cap < 0:
            flags.append({"kind": "negative_equity", "year": int(f["year"]),
                          "value": cap})
            break

    # >= 2 consecutive loss years (latest run)
    #
    # A run only continues across ADJACENT reported years. Without this
    # guard a company that reported a loss in 2019 and again in 2024 (no
    # filings in between) was flagged as "loss in 2 consecutive years
    # (2019–2024)" — a false factual claim, and the exact wording the
    # i18n strings commit to. The adjacent-delta rules below already
    # apply the same year-gap guard; this one was missing it.
    run: List[int] = []
    best: List[int] = []
    prev_year: Optional[int] = None
    for f in by_year:
        y = int(f["year"])
        nr = net_result_of(f)
        if nr is not None and nr < 0:
            if prev_year is not None and y - prev_year != 1:
                run = []
            run.append(y)
            if len(run) >= len(best):
                best = list(run)
        else:
            run = []
        prev_year = y
    if len(best) >= LOSS_YEARS_MIN:
        flags.append({"kind": "loss_years", "year_from": best[0],
                      "year_to": best[-1], "count": len(best)})

    # adjacent-year deltas (only for truly adjacent reported years)
    for prev, cur in zip(by_year, by_year[1:]):
        if int(cur["year"]) - int(prev["year"]) != 1:
            continue
        y = int(cur["year"])
        d = _pct_change(_slot(prev, "i7"), _slot(cur, "i7"))
        if d is not None and d > DEBT_SPIKE_PCT:
            flags.append({"kind": "debt_spike", "year": y, "pct": round(d, 1)})
        r = _pct_change(_slot(prev, "i13"), _slot(cur, "i13"))
        if r is not None and r < -REVENUE_DROP_PCT:
            flags.append({"kind": "revenue_drop", "year": y,
                          "pct": round(-r, 1)})
        e = _pct_change(_slot(prev, "i20"), _slot(cur, "i20"))
        if e is not None and e < -EMPLOYEE_DROP_PCT:
            flags.append({"kind": "employee_drop", "year": y,
                          "pct": round(-e, 1)})
    return flags


# ── percentile estimate ────────────────────────────────────────────────

def estimate_percentile(value: float, dist: Dict[str, Any]) -> Optional[int]:
    """Piecewise-linear percentile estimate of ``value`` against a stored
    distribution row (p10/p25/p50/p75/p90). Clamped to [3, 97] and
    explicitly labeled an ESTIMATE on the page. Returns None when the
    distribution is unusable."""
    anchors = []
    for pct, key in ((10, "p10"), (25, "p25"), (50, "p50"),
                     (75, "p75"), (90, "p90")):
        v = dist.get(key)
        if v is not None:
            anchors.append((float(v), pct))
    if len(anchors) < 2:
        return None
    # A distribution of one member places nobody: every anchor is that
    # member's own value, so the bottom-of-range branch below would have
    # published the SOLE filer in a CAEN division as "p10" — a sector
    # position the data cannot support. Refuse instead (no bar renders).
    n = dist.get("n")
    if n is not None and int(n) < 2:
        return None
    anchors.sort(key=lambda t: (t[0], t[1]))
    if value == anchors[0][0] == anchors[-1][0]:
        # Ties EVERY anchor — the distribution has no spread here, so it
        # cannot order this company against it. A tie with only the
        # lowest anchor (p10 < p90) is still a real p10 and is kept.
        return None
    if value <= anchors[0][0]:
        return 3 if value < anchors[0][0] else anchors[0][1]
    if value >= anchors[-1][0]:
        return 97 if value > anchors[-1][0] else anchors[-1][1]
    for (v0, p0), (v1, p1) in zip(anchors, anchors[1:]):
        if v0 <= value <= v1:
            if v1 == v0:
                return p0
            frac = (value - v0) / (v1 - v0)
            return int(round(p0 + frac * (p1 - p0)))
    return None  # pragma: no cover — anchors cover the range above


# ── model assembly ─────────────────────────────────────────────────────

def build_page_model(
    company: Dict[str, Any],
    filings: Sequence[Dict[str, Any]],
    *,
    percentiles: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Assemble the render model. ``filings`` must be ascending by year
    (store.get_filings guarantees ORDER BY year). ``percentiles`` maps
    metric name -> stored distribution row for (latest year, caen2)."""
    filings = sorted(filings, key=lambda f: int(f["year"]))
    if not filings:
        raise ValueError("build_page_model requires at least one filing")
    latest = filings[-1]
    prior = None
    for f in filings[:-1]:
        if int(f["year"]) == int(latest["year"]) - 1:
            prior = f
    year = int(latest["year"])

    cui = int(company["cui"])
    name = company.get("name") or ("CUI %d" % cui)
    slug = canonical_slug(company.get("name"))
    caen = latest.get("caen") or company.get("caen")

    def _kpi(slot: str) -> Dict[str, Any]:
        cur = (net_result_of(latest) if slot == "net_result"
               else _slot(latest, slot))
        prev = (net_result_of(prior) if slot == "net_result"
                else _slot(prior, slot)) if prior else None
        return {"value": cur, "yoy_pct": _pct_change(prev, cur),
                "prior_year": int(prior["year"]) if prior else None}

    revenue = _kpi("i13")
    net_result = _kpi("net_result")
    equity_total = _kpi("i10")
    liabilities = _kpi("i7")
    employees = _kpi("i20")

    net_margin = None
    if revenue["value"] not in (None, 0) and net_result["value"] is not None:
        net_margin = net_result["value"] / revenue["value"] * 100.0

    # computable ratio grid
    ratios: List[Dict[str, Any]] = []
    if net_margin is not None:
        ratios.append({"key": "net_margin", "pct": round(net_margin, 1)})
    cap = equity_total["value"]
    dat = liabilities["value"]
    if cap not in (None, 0) and dat is not None and cap > 0:
        ratios.append({"key": "debt_to_capital",
                       "ratio": round(dat / cap, 2)})
    emp = employees["value"]
    if emp not in (None, 0) and revenue["value"] is not None and emp > 0:
        ratios.append({"key": "revenue_per_employee",
                       "value": int(revenue["value"] / emp)})

    # trends — last TREND_YEARS reported filings
    window = filings[-TREND_YEARS:]
    trends: List[Dict[str, Any]] = []
    for key, slot, baseline_zero in TREND_METRICS:
        series = [
            (net_result_of(f) if slot == "net_result" else _slot(f, slot))
            for f in window
        ]
        if all(v is None for v in series):
            continue
        # The endpoints ship as (year, value) PAIRS, not as two indexes
        # into two parallel lists: the renderer used to take the first /
        # last reported VALUE but label it with years[0] / years[-1], so
        # a filing that reported nothing for this slot was published
        # carrying its neighbour's number (PS1 — a false claim about a
        # named company, contradicting the "—" on its own KPI card).
        reported = [
            (int(f["year"]), v) for f, v in zip(window, series) if v is not None
        ]
        trends.append({
            "key": key,
            "years": [int(f["year"]) for f in window],
            "values": series,
            "baseline_zero": baseline_zero,
            "first_reported": {"year": reported[0][0], "value": reported[0][1]},
            "last_reported": {"year": reported[-1][0], "value": reported[-1][1]},
        })

    # sector position (estimated percentile per metric)
    position: List[Dict[str, Any]] = []
    for metric in POSITION_METRICS:
        dist = (percentiles or {}).get(metric)
        if not dist:
            continue
        slot = _POSITION_SLOT[metric]
        val = (net_result_of(latest) if slot == "net_result"
               else _slot(latest, slot))
        if val is None:
            continue
        pct = estimate_percentile(float(val), dist)
        if pct is None:
            continue
        position.append({"metric": metric, "percentile": pct,
                         "n": dist.get("n")})

    prov = latest.get("provenance") or {}
    dataset_version = str(prov.get("dataset_id") or "0")

    return {
        "cui": cui,
        "name": name,
        "slug": slug,
        "county": company.get("county"),
        "locality": company.get("locality"),
        "caen": caen,
        "sector_label": company.get("sector_label"),
        "name_source": company.get("name_source"),
        "year": year,
        "years": [int(f["year"]) for f in filings],
        "dataset_version": dataset_version,
        "provenance": prov,
        "license_evidence": license_evidence(filings),
        "kpis": {
            "revenue": revenue,
            "net_result": net_result,
            "net_margin": (round(net_margin, 1)
                           if net_margin is not None else None),
            "equity_total": equity_total,
            "liabilities": liabilities,
            "employees": employees,
        },
        "ratios": ratios,
        "locked_ratio_keys": list(LOCKED_RATIO_KEYS),
        "trends": trends,
        "health_flags": build_health_flags(filings),
        "position": position,
    }


def narrative_text(model: Dict[str, Any], lang: str, strings: Dict[str, str]) -> str:
    """Deterministic 2-3 sentence template narrative.

    PUBLIC_AI_NARRATIVE seam: the flag is honored but this wave ships ONLY
    the deterministic branch (no AI credits; zero anthropic imports in
    this package by mission rule). When the flag is set the SAME
    deterministic text is returned — the seam exists so a future wave can
    branch here without touching callers.
    """
    _ai_requested = os.environ.get(AI_NARRATIVE_FLAG) == "1"  # noqa: F841 — seam only
    k = model["kpis"]
    bits: List[str] = []
    head = "%s (%s %d)" % (model["name"], strings["cui_label"], model["cui"])
    sentence = "%s %s %d" % (head, strings["narr_reported"], model["year"])
    if k["revenue"]["value"] is not None:
        sentence += " %s %s RON" % (
            strings["narr_revenue_of"], fmt_int(k["revenue"]["value"], lang))
    if k["net_result"]["value"] is not None:
        sentence += " %s %s RON" % (
            strings["narr_net_result_of"],
            fmt_int(k["net_result"]["value"], lang))
    if k["employees"]["value"] is not None:
        sentence += ", %s %s %s" % (
            strings["narr_employees_with"],
            fmt_int(k["employees"]["value"], lang),
            strings["narr_employees_word"])
    sentence += "."
    bits.append(sentence)
    bits.append(strings["narr_source"])
    return " ".join(bits)
