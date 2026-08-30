"""Benchmark comparison engine — pipeline-agnostic.

Reads the period's `calculated_metrics` rows (summary headline values
written by `stage_compute`) PLUS `statement_line_items` (per-account
amounts the mapper persisted). Derives ratio metrics that aren't
already stored, then compares against `industry_benchmarks` for the
company's CAEN code.

Output is a structured payload ready for the FE to render and
optionally cache in `benchmark_reports.report_data`.

Works for ANY upload type (trial balance, statutory F30+F10, or
future channels) because every source writes the same canonical
metric names into `calculated_metrics` and assembled-PL buckets.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple


logger = logging.getLogger(__name__)


# ─── Display metadata (rendered on the FE + PDF) ────────────────────────────


METRIC_DISPLAY: Dict[str, Dict[str, Any]] = {
    # Headline (currency values shown in the summary tiles)
    "revenue":                 {"ro": "Cifra de afaceri",            "en": "Revenue",                "fmt": "currency"},
    "total_operating_revenue": {"ro": "Venituri operaționale totale", "en": "Total operating revenue", "fmt": "currency"},
    "ebitda_cash":             {"ro": "EBITDA (cash)",                "en": "EBITDA (cash)",          "fmt": "currency"},
    "ebitda":                  {"ro": "EBITDA",                       "en": "EBITDA",                 "fmt": "currency"},
    "ebitda_operating":        {"ro": "EBITDA",                       "en": "EBITDA",                 "fmt": "currency"},
    "net_income":              {"ro": "Profit / pierdere netă (cash)", "en": "Net income / loss (cash)", "fmt": "currency"},
    "net_income_operating":    {"ro": "Profit / pierdere netă",       "en": "Net income / loss",      "fmt": "currency"},
    # Profitability ratios (compared against industry)
    "ebitda_margin":           {"ro": "Marja EBITDA",                 "en": "EBITDA margin",          "fmt": "pct"},
    "net_margin":              {"ro": "Marja netă",                   "en": "Net margin",             "fmt": "pct"},
    # Cost structure (derived from statement_line_items)
    "cogs_pct_revenue":              {"ro": "Materii prime % CA",        "en": "COGS / Revenue",          "fmt": "pct"},
    "opex_energy_pct_revenue":       {"ro": "Energie % CA",              "en": "Energy / Revenue",        "fmt": "pct"},
    "opex_personnel_pct_revenue":    {"ro": "Personal % CA",             "en": "Personnel / Revenue",     "fmt": "pct"},
    "opex_external_services_pct_revenue": {"ro": "Servicii externe % CA", "en": "External services / Revenue", "fmt": "pct"},
    "opex_rent_pct_revenue":         {"ro": "Chirii % CA",               "en": "Rent / Revenue",          "fmt": "pct"},
    "depreciation_pct_revenue":      {"ro": "Amortizare % CA",           "en": "D&A / Revenue",           "fmt": "pct"},
    # Capital structure
    "debt_to_ebitda":          {"ro": "Datorie / EBITDA",            "en": "Debt / EBITDA",          "fmt": "ratio"},
    "equity_ratio":            {"ro": "Capitaluri / Active",         "en": "Equity ratio",           "fmt": "pct"},
}


# For each metric: does lower-is-better? Drives the verdict colouring.
LOWER_IS_BETTER: Dict[str, bool] = {
    "cogs_pct_revenue": True,
    "opex_energy_pct_revenue": True,
    "opex_personnel_pct_revenue": True,
    "opex_external_services_pct_revenue": True,
    "opex_rent_pct_revenue": True,
    "depreciation_pct_revenue": True,
    "debt_to_ebitda": True,
    # Higher is better
    "ebitda_margin": False,
    "net_margin": False,
    "equity_ratio": False,
}


# RO Chart-of-Accounts code prefixes used to roll up `statement_line_items`
# into the breakdown buckets benchmarks compare against. Same conventions
# `_ro_coa.py` already uses.
OPEX_PERSONNEL_PREFIXES = ("641", "642", "643", "644", "645", "646", "647", "648")
OPEX_ENERGY_PREFIXES = ("605",)
OPEX_RENT_PREFIXES = ("612",)
OPEX_EXTERNAL_SERVICES_PREFIXES = ("611", "613", "614", "615", "616", "617", "618",
                                   "621", "622", "623", "624", "625", "626", "627", "628")
DEPRECIATION_PREFIXES = ("6811", "6813", "6817", "6814")


# ─── Helpers ────────────────────────────────────────────────────────────────


def _sum_line_items_by_prefix(line_items: List[Dict[str, Any]], prefixes: Tuple[str, ...]) -> float:
    """Sum `amount` over all PL line items whose ro_account_code starts
    with any of the given prefixes. Used for the opex-breakdown ratios
    that aren't stored as standalone calculated_metrics rows."""
    total = 0.0
    for li in line_items:
        if li.get("statement") != "PL":
            continue
        code = (li.get("ro_account_code") or "").strip()
        if not code:
            continue
        for p in prefixes:
            if code.startswith(p):
                try:
                    total += float(li.get("amount") or 0)
                except (TypeError, ValueError):
                    pass
                break
    return total


def _verdict(value: float, p25: Optional[float], p50: Optional[float], p75: Optional[float], lower_is_better: bool) -> str:
    """Map a value to one of: top_quartile / above_median / below_median / bottom_quartile.
    Falls through to 'not_available' if the benchmark percentiles are missing."""
    if p25 is None or p50 is None or p75 is None:
        return "not_available"
    if lower_is_better:
        if value <= p25: return "top_quartile"
        if value <= p50: return "above_median"
        if value <= p75: return "below_median"
        return "bottom_quartile"
    if value >= p75: return "top_quartile"
    if value >= p50: return "above_median"
    if value >= p25: return "below_median"
    return "bottom_quartile"


# ─── Customer-metric computation ────────────────────────────────────────────


def compute_company_metrics(
    calculated_metrics: List[Dict[str, Any]],
    line_items: List[Dict[str, Any]],
) -> Dict[str, float]:
    """Roll the raw `calculated_metrics` rows + `statement_line_items`
    into a flat dict of metric_name → value the comparison engine can
    look up. Normalizes percentage representation: the DB stores
    `ebitda_margin` as a 0-to-1 ratio; benchmarks store it as a 0-to-100
    percentage. We multiply by 100 here so comparison math is apples
    to apples."""
    out: Dict[str, float] = {}

    # 1. Headline values straight from calculated_metrics.
    for row in calculated_metrics or []:
        name = row.get("name")
        value = row.get("value")
        if name is None or value is None:
            continue
        try:
            v = float(value)
        except (TypeError, ValueError):
            continue
        # Convert ratio-stored values to display percentages — driven by
        # the ROW'S OWN unit, not a name list. The name-trio fallback
        # survives for legacy rows fetched without a unit column. This
        # closed a real production display bug (2026-08-30): a period
        # whose operating recompute below could not run kept the
        # x100-by-name value, and the FE's own x100 doubled it —
        # "EBITDA margin 1553.0%". One unit convention per name, decided
        # HERE, and the FE renders pct values verbatim.
        unit = row.get("unit")
        display_fmt = (METRIC_DISPLAY.get(name) or {}).get("fmt")
        if unit == "ratio" and display_fmt == "pct":
            v = v * 100.0
        elif unit is None and name in ("ebitda_margin", "net_margin", "gross_margin"):
            v = v * 100.0
        out[name] = v

    # 2. Currency basics — revenue + COGS bucket totals from line items
    # (used for the cost-breakdown ratios below). Bucket totals are
    # already aggregated by statement+bucket in the persisted line items.
    revenue_bucket = 0.0
    cogs_bucket = 0.0
    opex_bucket = 0.0
    depreciation_bucket = 0.0
    cap_own_bucket = 0.0
    other_income_bucket = 0.0
    for li in line_items or []:
        if li.get("statement") != "PL":
            continue
        bucket = (li.get("bucket") or "").strip()
        try:
            amt = float(li.get("amount") or 0)
        except (TypeError, ValueError):
            continue
        if bucket == "revenue":
            revenue_bucket += amt
        elif bucket == "cogs":
            cogs_bucket += amt
        elif bucket in ("operatingExpenses",):
            opex_bucket += amt
        elif bucket in ("depreciation", "depreciationAmortization"):
            depreciation_bucket += amt
        elif bucket == "capitalizedOwnWork":
            cap_own_bucket += amt
        elif bucket == "otherIncome":
            other_income_bucket += amt

    # 3. Derive total_operating_revenue if it isn't already in
    # calculated_metrics. The TB-pipeline stage_compute writes
    # `revenue` (= cifra de afaceri only) — but the assembled-PL
    # canonical view computes total_operating_revenue including
    # 722 + 711 + other income. Use the bucket sums as a best-effort
    # fallback so benchmark ratios don't divide by an under-stated
    # denominator.
    if "total_operating_revenue" not in out:
        if revenue_bucket > 0:
            out["total_operating_revenue"] = revenue_bucket + cap_own_bucket + other_income_bucket
        elif "revenue" in out:
            out["total_operating_revenue"] = out["revenue"]

    # Denominator for the ratio breakdown — prefer total_operating_revenue,
    # fall back to plain revenue if it's still missing.
    rev_denom = out.get("total_operating_revenue") or out.get("revenue") or revenue_bucket or 0
    if rev_denom <= 0:
        # No revenue → none of the % ratios are meaningful.
        return out

    # ── RECOMPUTE ebitda_margin / net_margin against OPERATING revenue ──
    # stage_compute persists `ebitda_margin` as ebitda / revenue, where
    # `revenue` is the narrow Cifra-de-afaceri figure and `ebitda` is the
    # cash view (excludes 722 capitalized own-work + 711 inventory
    # variation memo). That's the right number for a manufacturer but
    # wrong for real-estate / asset-intensive companies that book a
    # large 722 (investment-property uplift) and small cifra — there,
    # the "cash" EBITDA looks ~0 against narrow revenue, while the real
    # OMFP F30 row-43 EBITDA against operating revenue is healthy.
    #
    # Industry benchmark percentiles and named-peer data are both
    # expressed against OPERATING revenue (Transavia 24.9% margin,
    # NEPI 40%, etc. — all use the OMFP row-1 + 9 + 13 + 16 total).
    # To make the comparison apples-to-apples, we override the two
    # margins here using the operating view: EBITDA includes 722 + 711
    # net + other_income, denominator is total_operating_revenue.
    #
    # For Scandia the override changes nothing (722 ≈ 0).
    # For EEI (722 = 2.16M on 2.73M revenue) it flips the sign of the
    # EBITDA margin from −1.3% (nonsense vs CRE peers) to +43% (which
    # actually places EEI within the CRE percentile band).
    ebitda_cash = None
    for row in calculated_metrics or []:
        if row.get("name") == "ebitda_cash":
            try:
                ebitda_cash = float(row.get("value") or 0)
            except (TypeError, ValueError):
                ebitda_cash = None
            break
    if ebitda_cash is None:
        # Fallback to bucket math when the cached metric isn't there.
        ebitda_cash = revenue_bucket - cogs_bucket - opex_bucket + other_income_bucket
    # 711 inventory-variation memo — already routed to inv_var_memo in
    # the API layer; for older payloads it's inside otherIncome.
    ebitda_operating = ebitda_cash + cap_own_bucket
    net_income = out.get("net_income") or 0
    net_income_operating = net_income + cap_own_bucket

    out["ebitda_margin"] = (ebitda_operating / rev_denom) * 100.0
    out["net_margin"] = (net_income_operating / rev_denom) * 100.0
    # Surface both views explicitly so the FE / future surfaces can show
    # cash-vs-operating side by side without re-deriving.
    out["ebitda_margin_cash"] = (ebitda_cash / rev_denom) * 100.0
    out["ebitda_operating"] = ebitda_operating
    out["net_income_operating"] = net_income_operating

    # 4. Derived ratio metrics (the comparison engine's bread and butter).
    if cogs_bucket > 0:
        out["cogs_pct_revenue"] = (cogs_bucket / rev_denom) * 100.0

    personnel = _sum_line_items_by_prefix(line_items, OPEX_PERSONNEL_PREFIXES)
    energy = _sum_line_items_by_prefix(line_items, OPEX_ENERGY_PREFIXES)
    rent = _sum_line_items_by_prefix(line_items, OPEX_RENT_PREFIXES)
    services = _sum_line_items_by_prefix(line_items, OPEX_EXTERNAL_SERVICES_PREFIXES)
    if personnel > 0:
        out["opex_personnel_pct_revenue"] = (personnel / rev_denom) * 100.0
    if energy > 0:
        out["opex_energy_pct_revenue"] = (energy / rev_denom) * 100.0
    if rent > 0:
        out["opex_rent_pct_revenue"] = (rent / rev_denom) * 100.0
    if services > 0:
        # Exclude rent (612) which is also in 61x range — we already
        # accounted for it under opex_rent_pct_revenue.
        services_minus_rent = services - rent
        if services_minus_rent > 0:
            out["opex_external_services_pct_revenue"] = (services_minus_rent / rev_denom) * 100.0
    if depreciation_bucket > 0:
        out["depreciation_pct_revenue"] = (depreciation_bucket / rev_denom) * 100.0

    # 5. equity_ratio = total_equity / total_assets — neither parser
    # writes this directly, but both write the two components.
    eq = out.get("total_equity")
    ta = out.get("total_assets")
    if eq is not None and ta is not None and ta > 0:
        out["equity_ratio"] = (eq / ta) * 100.0

    return out


# ─── Comparison builder ─────────────────────────────────────────────────────


def build_comparison_row(metric_name: str, company_value: Optional[float], bench: Dict[str, Any]) -> Dict[str, Any]:
    """Build a single comparison row for the report."""
    lower_better = LOWER_IS_BETTER.get(metric_name, False)
    display = METRIC_DISPLAY.get(metric_name, {"ro": metric_name, "en": metric_name, "fmt": "ratio"})
    if company_value is None:
        verdict = "not_available"
        gap = None
    else:
        verdict = _verdict(company_value, bench.get("p25"), bench.get("p50"), bench.get("p75"), lower_better)
        p50 = bench.get("p50")
        gap = (company_value - p50) if p50 is not None else None
    return {
        "metric_name": metric_name,
        "display": display,
        "company_value": company_value,
        "benchmark": bench,
        "verdict": verdict,
        "gap_pp": gap,
        "lower_is_better": lower_better,
    }


SECTIONS: Dict[str, Tuple[List[str], str, str]] = {
    # section_key: (metric_names_in_order, title_ro, title_en)
    "profitability": (
        ["ebitda_margin", "net_margin"],
        "Profitabilitate vs industrie",
        "Profitability vs industry",
    ),
    "cost_structure": (
        ["cogs_pct_revenue", "opex_personnel_pct_revenue", "opex_energy_pct_revenue",
         "opex_external_services_pct_revenue", "opex_rent_pct_revenue", "depreciation_pct_revenue"],
        "Structură costuri vs industrie",
        "Cost structure vs industry",
    ),
    "capital_structure": (
        ["debt_to_ebitda", "equity_ratio"],
        "Structură de capital vs industrie",
        "Capital structure vs industry",
    ),
}


# Headline tiles — kept in the OPERATING view so they match the frame of
# reference the comparison sections + named-peer tables use right below.
# For a manufacturer (Scandia) where 722 ≈ 0, ebitda_operating == ebitda_cash
# and net_income_operating == net_income — same numbers, just consistent
# labeling. For a real-estate company (EEI) where 722 dominates revenue,
# the cash-view tiles previously read -37K / -739K right next to a +43%
# EBITDA margin in the comparison table — obviously wrong. Operating-view
# tiles fix that: EEI reads +2.1M EBITDA / +1.4M net income, internally
# consistent with the rest of the page.
HEADLINE_METRICS = ["revenue", "total_operating_revenue", "ebitda_operating", "net_income_operating"]


DISCLOSURE = (
    "Benchmarks are estimates derived from public Romanian SME filings "
    "(Ministerul Finanțelor, Termene.ro samples), Eurostat Structural Business "
    "Statistics, and sector-specific public reports — typical mid-size "
    "Romanian companies in each CAEN code, FY2023-2024. Individual companies "
    "vary materially. Use as directional context, not as absolute targets. "
    "For audit-grade benchmarks, consider licensed providers (Bisnode, KeysFin)."
)


def build_benchmark_report(
    *,
    period_id: str,
    caen_code: str,
    caen_label: str,
    industry_category: str,
    calculated_metrics: List[Dict[str, Any]],
    line_items: List[Dict[str, Any]],
    benchmarks: Dict[str, Dict[str, Any]],
    # Deep-analysis payload (Phase 7b) — optional; when None the report
    # falls back to just the percentile-bar sections. When present, the
    # FE renders the full Transavia-style peer comparison + leader-why +
    # gap analysis + margin tiers + industry dynamics.
    peers: Optional[List[Dict[str, Any]]] = None,
    leader_reasons: Optional[List[Dict[str, Any]]] = None,
    qualitative: Optional[Dict[str, Any]] = None,
    company_name: str = "Your company",
) -> Dict[str, Any]:
    """Compose the final report payload. Pure function — no DB calls.
    Caller is responsible for fetching the inputs and caching the
    result in `benchmark_reports.report_data`."""
    company_metrics = compute_company_metrics(calculated_metrics, line_items)

    sections_out: Dict[str, Any] = {
        "headline": {
            "title_ro": "Sumar headline",
            "title_en": "Headline summary",
            "metrics": HEADLINE_METRICS,
            "company_values": {m: company_metrics.get(m) for m in HEADLINE_METRICS},
            "display": {m: METRIC_DISPLAY.get(m, {"ro": m, "en": m}) for m in HEADLINE_METRICS},
        },
    }
    for section_key, (metric_names, title_ro, title_en) in SECTIONS.items():
        comparisons = []
        for mname in metric_names:
            bench = benchmarks.get(mname)
            if not bench:
                # Industry has no value for this metric — skip rather
                # than render an empty row.
                continue
            comparisons.append(build_comparison_row(mname, company_metrics.get(mname), bench))
        sections_out[section_key] = {
            "title_ro": title_ro,
            "title_en": title_en,
            "comparisons": comparisons,
        }

    # Build the deep-analysis section when peer/leader data is available.
    deep: Optional[Dict[str, Any]] = None
    if peers or leader_reasons or qualitative:
        deep = _build_deep_section(
            peers=peers or [],
            leader_reasons=leader_reasons or [],
            qualitative=qualitative or {},
            company_metrics=company_metrics,
            company_name=company_name,
        )

    return {
        "period_id": period_id,
        "caen_code": caen_code,
        "caen_label": caen_label,
        "industry_category": industry_category,
        "disclosure": DISCLOSURE,
        "sections": sections_out,
        "deep": deep,                         # None when no deep data seeded
        "company_metrics_raw": company_metrics,
    }


# ─── Deep-analysis assembler ───────────────────────────────────────────────


def _build_deep_section(
    *,
    peers: List[Dict[str, Any]],
    leader_reasons: List[Dict[str, Any]],
    qualitative: Dict[str, Any],
    company_metrics: Dict[str, float],
    company_name: str,
) -> Dict[str, Any]:
    """Assemble the deep-analysis payload that powers the Transavia-style
    peer comparison + structural-reasons + gap + margin-tiers blocks.

    Adds a synthetic 'self' row to the peer list using the company's
    own metrics so the FE table puts the user's numbers in context next
    to the named competitors. The synthetic row carries tier='self' so
    the FE can highlight it differently.
    """
    leader: Optional[Dict[str, Any]] = next(
        (p for p in peers if p.get("tier") == "leader"), None
    )

    # Inject the "this is you" row.
    cur_year_revenue_lei = company_metrics.get("revenue") or 0.0
    cur_year_revenue_mlei = cur_year_revenue_lei / 1_000_000 if cur_year_revenue_lei else None
    self_row = {
        "company_name": company_name,
        "fiscal_year": company_metrics.get("__fiscal_year__"),
        "revenue_mlei": round(cur_year_revenue_mlei, 1) if cur_year_revenue_mlei else None,
        "net_profit_mlei": (
            round(company_metrics.get("net_income", 0) / 1_000_000, 1)
            if company_metrics.get("net_income") is not None else None
        ),
        "net_margin_pct": company_metrics.get("net_margin"),
        "ebitda_margin_pct": company_metrics.get("ebitda_margin"),
        "equity_ratio_pct": company_metrics.get("equity_ratio"),
        "debt_to_equity": None,
        "specialization": "Compania ta",
        "tier": "self",
        "source": "Trial balance — current period",
        "display_order": 99,  # sort to the end by default; FE may reorder
    }
    peers_full = list(peers) + [self_row]
    peers_full.sort(key=lambda p: (p.get("display_order") or 99))

    # Gap-vs-leader table — only meaningful when we have a leader row.
    gap_rows: List[Dict[str, Any]] = []
    if leader is not None:
        gap_metrics = [
            ("net_margin", "Net Margin", "pct"),
            ("ebitda_margin", "EBITDA Margin", "pct"),
            ("equity_ratio", "Equity Ratio", "pct"),
            ("debt_to_equity", "Debt / Equity", "ratio"),
        ]
        # Map leader peer-row keys → our company_metrics keys.
        leader_map = {
            "net_margin": leader.get("net_margin_pct"),
            "ebitda_margin": leader.get("ebitda_margin_pct"),
            "equity_ratio": leader.get("equity_ratio_pct"),
            "debt_to_equity": leader.get("debt_to_equity"),
        }
        for key, label, unit in gap_metrics:
            company_val = company_metrics.get(key)
            leader_val = leader_map.get(key)
            if company_val is None or leader_val is None:
                continue
            gap = company_val - leader_val
            # For "lower is better" metrics (debt_to_equity) flip the
            # sentiment of the sign so the UI colors gap correctly.
            lower_is_better = LOWER_IS_BETTER.get(key, False)
            favorable = (gap <= 0) if lower_is_better else (gap >= 0)
            gap_rows.append({
                "key": key,
                "label": label,
                "unit": unit,
                "company_value": company_val,
                "leader_value": leader_val,
                "gap": gap,
                "favorable": favorable,
            })

    # Cumulative leader-reason margin impact, used in the section intro
    # ("the sum of these 5 reasons is +18pp over industry median").
    total_leader_impact_pp = sum(
        float(r.get("margin_impact_pp") or 0) for r in leader_reasons
    )

    return {
        "leader_company": leader.get("company_name") if leader else None,
        "leader_year": leader.get("fiscal_year") if leader else None,
        "leader_revenue_mlei": leader.get("revenue_mlei") if leader else None,
        "leader_net_margin_pct": leader.get("net_margin_pct") if leader else None,
        "leader_specialization": leader.get("specialization") if leader else None,
        "peers": peers_full,
        "leader_reasons": sorted(leader_reasons, key=lambda r: r.get("rank") or 99),
        "leader_total_impact_pp": round(total_leader_impact_pp, 1),
        "gap_vs_leader": gap_rows,
        "target_tiers": qualitative.get("target_tiers"),
        "dynamics": qualitative.get("dynamics"),
        "success_patterns": qualitative.get("success_patterns") or [],
        "failure_modes": qualitative.get("failure_modes") or [],
        "market_context": qualitative.get("market_context"),
    }
