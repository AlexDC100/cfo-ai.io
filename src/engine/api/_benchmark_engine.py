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
    "revenue":                 {"ro": "Cifra de afaceri netă",       "en": "Net turnover",           "fmt": "currency"},
    # THE ONE EBITDA (owner ruling 2026-09-26): net 711 and net 72x inside.
    "ebitda":                  {"ro": "EBITDA",                       "en": "EBITDA",                 "fmt": "currency"},
    "net_income":              {"ro": "Profit / pierdere netă (cash)", "en": "Net income / loss (cash)", "fmt": "currency"},
    "net_income_operating":    {"ro": "Profit / pierdere netă (operațional)", "en": "Net income / loss (operating view)", "fmt": "currency"},
    # The STATUTORY figure — account 121's closing balance, the number on the
    # filed accounts and the one the dashboard's NET PROFIT card shows. The
    # headline reads this when the period carries it (2026-09-20: the benchmark
    # page showed the reconstruction, 36.3M, beside a dashboard showing the
    # anchor, 36.8M, both labelled "Net income / loss" — one company, one
    # screen apart, two different profits).
    "net_income_statutory":    {"ro": "Profit / pierdere netă (statutar)", "en": "Net income / loss (statutory)", "fmt": "currency"},
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

#: The first credit-model revision whose stored EBITDA-family rows carry the
#: ONE EBITDA (owner ruling 2026-09-26: net 711 and net 72x inside, 767
#: financial) — `engine.ratios.credit_model.ONE_EBITDA_REVISION`, spelled
#: here so this module reads rows only. A period whose rows are stamped
#: below it (or not at all) stored the EBITDA WITHOUT 711 / 72x under the
#: same names: its EBITDA figures and its margins are REFUSED here until the
#: period is reprocessed, never graded against the sector. 4 since the
#: 2026-09-28 rulings (R2 provisions outside EBITDA, R3 7411 in turnover):
#: rows stamped 3 carry the previous EBITDA and turnover.
ONE_EBITDA_REVISION = 4

#: Stored rows that carry EBITDA or a figure built on it. On a stale period
#: they are dropped from the company metrics (a pre-ruling figure is never
#: printed as the one EBITDA).
_EBITDA_FAMILY_ROWS = (
    "ebitda", "ebitda_cash", "ebitda_statutory", "operating_profit", "gross_profit",
    "ebitda_margin", "gross_margin", "operating_margin", "debt_to_ebitda", "net_debt_to_ebitda",
    "ebitda_to_interest", "dscr", "dscr_with_lt_principal", "interest_coverage", "roic",
    "core_ebitda", "core_ebitda_margin", "adjusted_ebitda", "total_operating_revenue",
    "ebitda_statutory_with_711", "inventory_variation_memo", "total_operating_revenue_statutory",
)

#: Why a company figure is not graded — the served refusal vocabulary of
#: this report (each with its RO / EN sentence, never typed by the FE).
REFUSAL_STALE = "period_predates_ebitda_definition"
REFUSAL_EBITDA = "ebitda_refused"
REFUSAL_MARGIN = "margin_not_meaningful"
#: The NET RESULT is refused with 711: no account 121 in the trial balance,
#: so the class-6/7 build-up — short by the unmeasured stock variation — is
#: all there would be (`assembled_pl.net_income_refusal`). Stored as a
#: `net_income_statutory` row whose value is None.
REFUSAL_NET_INCOME = "net_income_refused"
_REFUSAL_TEXT = {
    # Generic: the definition stamp has moved more than once, so the words
    # name no content an earlier definition lacked (deploy-readiness review,
    # 2026-09-29).
    REFUSAL_STALE: {
        "ro": "Perioada a fost analizată sub o definiție anterioară a EBITDA; cifra se "
              "recalculează la reprocesarea perioadei.",
        "en": "The period was analysed under an earlier EBITDA definition; the figure is "
              "recomputed when the period is reprocessed.",
    },
    REFUSAL_EBITDA: {
        "ro": "EBITDA este refuzat pentru această perioadă: variația stocurilor de produse nu a "
              "putut fi măsurată din balanță.",
        "en": "EBITDA is refused for this period: the stock variation (Variația stocurilor de "
              "produse) could not be measured from the trial balance.",
    },
    REFUSAL_NET_INCOME: {
        "ro": "Rezultatul net este refuzat pentru această perioadă: variația stocurilor de produse nu "
              "a putut fi măsurată, iar balanța nu conține contul 121.",
        "en": "The net result is refused for this period: the stock variation (Variația stocurilor "
              "de produse) could not be measured and the trial balance carries no account 121.",
    },
}

#: The company figures the margin rule covers on this page.
_MARGIN_METRICS = ("ebitda_margin", "net_margin")
#: The company figures built on EBITDA on this page.
_EBITDA_METRICS = ("ebitda", "ebitda_margin", "debt_to_ebitda")


def _refusal(code: str, display: Optional[Dict[str, str]] = None,
             **extra: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {"code": code, "display": dict(display or _REFUSAL_TEXT[code])}
    out.update(extra)
    return out


def compute_company_metrics(
    calculated_metrics: List[Dict[str, Any]],
    line_items: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Roll the raw `calculated_metrics` rows + `statement_line_items`
    into a flat dict of metric_name → value the comparison engine can
    look up, plus `refusals` — `{metric: {code, display{ro,en}, ...}}` for
    every company figure the page must NOT grade. Normalizes percentage
    representation: the DB stores `ebitda_margin` as a 0-to-1 ratio;
    benchmarks store it as a 0-to-100 percentage.

    THE ONE DEFINITION (owner ruling 2026-09-26):
      · every margin and every cost-structure share divides TURNOVER — the
        `revenue` row, cifra de afaceri netă (class 70 − 709) — never total
        operating revenue (the filed percentile bands and the named peers
        are on filed net turnover too, I13);
      · EBITDA is the stored `ebitda` row — the one EBITDA (net 711 and
        net 72x inside) — read, never rebuilt from buckets; refused when the
        row is refused, and refused as stale on a period whose rows predate
        the definition (`ONE_EBITDA_REVISION`);
      · the ONE margin rule (engine.ratios.margin_meaning, over the stored
        `revenue` and `total_operating_expense` rows) refuses both margins
        on a book whose turnover is negligible against its operating
        activity — the developer — exactly where the ratio table refuses
        them.
    """
    from engine.ratios import margin_meaning as _mm

    out: Dict[str, Any] = {}
    refused_rows = set()
    refusals: Dict[str, Dict[str, Any]] = {}

    # 1. Headline values straight from calculated_metrics.
    for row in calculated_metrics or []:
        name = row.get("name")
        value = row.get("value")
        if name is None:
            continue
        if value is None:
            # A row the model REFUSED (the one EBITDA and the rows on it)
            # — absent here, and remembered so its refusal is stated.
            refused_rows.add(name)
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

    # 2. Currency basics — bucket totals from line items (the cost-structure
    # numerators below).
    revenue_bucket = 0.0
    cogs_bucket = 0.0
    depreciation_bucket = 0.0
    cap_own_bucket = 0.0
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
        elif bucket in ("depreciation", "depreciationAmortization"):
            depreciation_bucket += amt
        elif bucket == "capitalizedOwnWork":
            cap_own_bucket += amt

    # 3. THE DENOMINATOR: turnover. The stored `revenue` row (class 70 −
    # 709), else the revenue bucket sum — never total operating revenue.
    turnover = out.get("revenue")
    if turnover is None and revenue_bucket > 0:
        turnover = revenue_bucket
    out["turnover"] = turnover

    # 4. Which EBITDA this period's rows carry.
    revision = out.get("credit_model_revision")
    stale = revision is None or revision < ONE_EBITDA_REVISION
    if stale:
        for name in _EBITDA_FAMILY_ROWS:
            out.pop(name, None)
        for name in _EBITDA_METRICS + _MARGIN_METRICS:
            refusals[name] = _refusal(REFUSAL_STALE, revision=revision)
    elif "ebitda" in refused_rows or out.get("ebitda") is None:
        for name in _EBITDA_METRICS:
            refusals[name] = _refusal(REFUSAL_EBITDA)
        for name in _EBITDA_FAMILY_ROWS:
            out.pop(name, None)

    # The NET RESULT refused with 711 (no account 121): the stored
    # `net_income_statutory` row is PRESENT with no value — refused, not
    # absent (a legacy period with no statutory row keeps the operating
    # view below). The headline, the "Compania ta" row and the graded net
    # margin refuse together; the operating view (the build-up, short by
    # the unmeasured variation) must not stand in for it.
    net_income_refused = "net_income_statutory" in refused_rows
    if net_income_refused:
        for name in ("net_income_statutory", "net_income_operating"):
            refusals[name] = _refusal(REFUSAL_NET_INCOME)
        refusals.setdefault("net_margin", _refusal(REFUSAL_NET_INCOME))

    if turnover is None or turnover <= 0:
        # No turnover → none of the % ratios are meaningful; a stored margin
        # the page must not grade is not carried either.
        for name in refusals:
            out.pop(name, None)
        out["refusals"] = refusals
        return out

    # 5. THE ONE MARGIN RULE, on the stored operands (a stale period has no
    # activity row, and its margins are refused as stale above).
    if not stale:
        verdict = _mm.judge(turnover, out.get("total_operating_expense"))
        if verdict.refused:
            display = _mm.refusal_display(verdict, None) or {}
            for name in _MARGIN_METRICS:
                refusals[name] = _refusal(REFUSAL_MARGIN, display,
                                          margin_meaning=_mm.served_block(
                                              verdict, ("metrics.revenue", "metrics.total_operating_expense")))

    # `or 0` IS A FLOOR, and this one reached the screen (2026-09-21). A period
    # whose calculated_metrics carry no `net_income` row got a profit of
    # cap_own_bucket — commonly 0.00 — printed as a figure rather than refused,
    # and every margin graded against the sector bands was built on it. Absent
    # is not zero: with no reported profit this view has no value, and
    # `headline_net_income_key` then has nothing to choose, so the headline,
    # the peer row and the margin all refuse together instead of grading a
    # company against its peers on a profit nobody filed.
    net_income_reported = out.get("net_income")
    if net_income_reported is not None and not net_income_refused:
        # The legacy operating view (no account-121 row): the build-up plus
        # own work capitalised — the stored net 72x row, else the 72x
        # bucket sum of a period stored before that row — labelled as such
        # on the page.
        cap = out.get("capitalized_own_work_memo")
        out["net_income_operating"] = net_income_reported + (cap_own_bucket if cap is None else cap)

    # ── ONE PROFIT PER PAGE ─────────────────────────────────────────────
    # The headline prints the account-121 anchor when the period carries it
    # (`headline_net_income_key`); the graded net margin divides THAT profit
    # by turnover, and so does the "Compania ta" row.
    headline_net_income = headline_net_income_of(out)

    if "ebitda_margin" not in refusals:
        out["ebitda_margin"] = (out["ebitda"] / turnover) * 100.0
    else:
        out.pop("ebitda_margin", None)
    if "net_margin" not in refusals and headline_net_income is not None:
        out["net_margin"] = (headline_net_income / turnover) * 100.0
    else:
        out.pop("net_margin", None)

    # 6. Cost structure, every share over turnover.
    if cogs_bucket > 0:
        out["cogs_pct_revenue"] = (cogs_bucket / turnover) * 100.0

    personnel = _sum_line_items_by_prefix(line_items, OPEX_PERSONNEL_PREFIXES)
    energy = _sum_line_items_by_prefix(line_items, OPEX_ENERGY_PREFIXES)
    rent = _sum_line_items_by_prefix(line_items, OPEX_RENT_PREFIXES)
    services = _sum_line_items_by_prefix(line_items, OPEX_EXTERNAL_SERVICES_PREFIXES)
    if personnel > 0:
        out["opex_personnel_pct_revenue"] = (personnel / turnover) * 100.0
    if energy > 0:
        out["opex_energy_pct_revenue"] = (energy / turnover) * 100.0
    if rent > 0:
        out["opex_rent_pct_revenue"] = (rent / turnover) * 100.0
    if services > 0:
        # Exclude rent (612) which is also in 61x range — we already
        # accounted for it under opex_rent_pct_revenue.
        services_minus_rent = services - rent
        if services_minus_rent > 0:
            out["opex_external_services_pct_revenue"] = (services_minus_rent / turnover) * 100.0
    if depreciation_bucket > 0:
        out["depreciation_pct_revenue"] = (depreciation_bucket / turnover) * 100.0

    # 7. equity_ratio = total_equity / total_assets — neither parser
    # writes this directly, but both write the two components.
    eq = out.get("total_equity")
    ta = out.get("total_assets")
    if eq is not None and ta is not None and ta > 0:
        out["equity_ratio"] = (eq / ta) * 100.0

    out["refusals"] = refusals
    return out


# ─── Comparison builder ─────────────────────────────────────────────────────


def build_comparison_row(metric_name: str, company_value: Optional[float], bench: Dict[str, Any],
                         refusal: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Build a single comparison row for the report. A company figure the
    page must not grade (`refusal`: stale definition, a refused EBITDA, a
    margin the one rule refuses) carries no value, no verdict and no gap —
    and says why."""
    lower_better = LOWER_IS_BETTER.get(metric_name, False)
    display = METRIC_DISPLAY.get(metric_name, {"ro": metric_name, "en": metric_name, "fmt": "ratio"})
    if refusal is not None:
        company_value = None
    if company_value is None:
        verdict = "refused" if refusal is not None else "not_available"
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
        "refusal": refusal,
        # Every margin and cost share on this page divides net turnover.
        "denominator": ("net_turnover" if metric_name in _TURNOVER_DENOMINATED else None),
    }


#: The company figures on this page that divide net turnover (cifra de
#: afaceri netă, class 70 − 709) — served beside each row so no surface
#: guesses the basis.
_TURNOVER_DENOMINATED = frozenset({
    "ebitda_margin", "net_margin", "cogs_pct_revenue", "opex_personnel_pct_revenue",
    "opex_energy_pct_revenue", "opex_external_services_pct_revenue", "opex_rent_pct_revenue",
    "depreciation_pct_revenue",
})

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


# Headline tiles — THE ONE DEFINITION (owner ruling 2026-09-26): net
# turnover, the one EBITDA (net 711 and net 72x inside — EEI's 722 is in it,
# the developer's stock variation too) and the account-121 profit. Before the
# ruling this page kept an "operating view" of its own (EBITDA = cash EBITDA
# + 722 over total operating revenue) so EEI's margin read sensibly; the one
# EBITDA carries 722 on every surface, and total operating revenue is no
# longer a denominator anywhere, so neither tile is needed.
#: The figures at the top of the benchmark report. The net-income slot is
#: resolved per period by `headline_metrics()` — statutory when the period
#: carries the account-121 anchor, the operating view only when it does not.
HEADLINE_METRICS = ["revenue", "ebitda", "net_income_operating"]
NET_INCOME_SLOT = ("net_income_statutory", "net_income_operating")

#: The report's own revision. `_benchmarks.py` stamps it into the cached
#: `report_data` and REFUSES a cached row whose revision differs, so a change
#: to this module actually reaches the screen.
#:
#: Before this existed the cache was keyed on `period_id` alone, on the
#: assumption (stated in that file, and already recorded as stale in
#: CLAUDE.md §16) that "re-analysis produces a NEW period_id". An engine
#: change therefore never invalidated anything: the headline net-income fix
#: shipped on 2026-09-20 was still serving the old 36.3 M figure from a report
#: generated on 9 September.
#:
#: BUMP THIS whenever a change alters what this module puts on screen.
#: 4 (2026-09-26): the ONE EBITDA, margins over turnover, the margin rule's
#: refusal on the company side and the "Compania ta" row, peer basis served.
#: 5 (2026-09-27): a net result refused with 711 (no account 121) refuses the
#: headline profit, the peer row and the net margin — never the build-up.
#: 6 (2026-09-28, owner rulings R2 / R3): EBITDA without the 6812 / 6814
#: charges and the 7812 / 7814 reversals, margins over a turnover that
#: holds 7411 — a report cached under 5 graded the previous EBITDA.
REPORT_REVISION = 6


def headline_net_income_key(company_metrics: Dict[str, Any]) -> str:
    """WHICH net-income view this period is shown in — the one decision.

    Statutory (account 121's closing balance, the filed result) when the
    period carries it; the operating view only when it does not. A statutory
    ZERO is a figure, not an absence, so the test is `is not None`.

    Every surface on the benchmark page resolves through this function, not
    through its own copy of the rule: the headline tile (`headline_metrics`),
    the graded `net_margin` (`compute_company_metrics`) and the "Compania ta"
    row of the named-peer table (`_build_deep_section`). Three copies is how
    the 2026-09-20 headline repair left two of them behind.
    """
    preferred, fallback = NET_INCOME_SLOT
    return preferred if company_metrics.get(preferred) is not None else fallback


def headline_net_income_of(company_metrics: Dict[str, Any]) -> Optional[float]:
    """The VALUE in that slot, or None when the period carries neither view.

    None, not 0.0: a period that reported no profit of either kind has an
    ABSENT bottom line, and a zero printed in its place is a figure the
    filing does not contain.
    """
    v = company_metrics.get(headline_net_income_key(company_metrics))
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _self_net_profit_mlei(company_metrics: Dict[str, Any]) -> Optional[float]:
    """The "Compania ta" row's net profit, in millions — the SAME figure the
    headline tile prints, or None.

    PRESENCE is tested on a REPORTED figure, never on the derived
    `net_income_operating` (which is `net_income or 0` plus 722 and is
    therefore always there): testing that one would print a
    capitalized-own-work total as the bottom line of a period that reported
    no profit at all.
    """
    if (company_metrics.get("net_income_statutory") is None
            and company_metrics.get("net_income") is None):
        return None
    v = headline_net_income_of(company_metrics)
    return None if v is None else round(v / 1_000_000, 1)


def headline_metrics(company_metrics: Dict[str, Any]) -> List[str]:
    """HEADLINE_METRICS with the net-income slot resolved for THIS period.

    ONE anchor, every surface: the benchmark headline must not print a
    different profit from the dashboard for the same company. Falls back to the
    operating view for legacy periods with no statutory row — never to zero,
    and never silently: the label says which view is on screen.
    """
    _, fallback = NET_INCOME_SLOT
    chosen = headline_net_income_key(company_metrics)
    return [chosen if m == fallback else m for m in HEADLINE_METRICS]


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
    refusals: Dict[str, Dict[str, Any]] = company_metrics.get("refusals") or {}
    _headline = headline_metrics(company_metrics)

    sections_out: Dict[str, Any] = {
        "headline": {
            "title_ro": "Sumar headline",
            "title_en": "Headline summary",
            "metrics": _headline,
            "company_values": {m: (None if m in refusals else company_metrics.get(m)) for m in _headline},
            "display": {m: METRIC_DISPLAY.get(m, {"ro": m, "en": m}) for m in _headline},
            # Why a headline figure is not printed (the one EBITDA refused,
            # or the period predates its definition) — never a blank.
            "refusals": {m: refusals[m] for m in _headline if m in refusals},
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
            comparisons.append(build_comparison_row(mname, company_metrics.get(mname), bench,
                                                    refusals.get(mname)))
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
        "report_revision": REPORT_REVISION,
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


#: The basis of a named peer's revenue and margins, by its declared source —
#: recorded on every seed row (benchmarks_deep_seed.json `revenue_basis`) and
#: served beside every peer, so the company's own row (trial-balance net
#: turnover) is never read as sitting on a basis it does not. The filed
#: Romanian accounts (Ministerul Finanțelor, and Termene.ro / Risco.ro which
#: republish them) state cifra de afaceri netă (I13); a group's consolidated
#: figures, an IFRS annual report and a segment estimate are other bases.
PEER_BASIS_FILED = "filed_net_turnover"
PEER_BASIS_CONSOLIDATED = "consolidated_turnover"
PEER_BASIS_ANNUAL_REPORT = "annual_report_revenue"
PEER_BASIS_ESTIMATE = "segment_estimate"
SELF_BASIS = "trial_balance_net_turnover"
PEER_BASIS_DISPLAY: Dict[str, Dict[str, str]] = {
    PEER_BASIS_FILED: {"ro": "cifra de afaceri netă din situațiile financiare depuse",
                       "en": "net turnover from the filed financial statements"},
    PEER_BASIS_CONSOLIDATED: {"ro": "cifra de afaceri consolidată a grupului",
                              "en": "the group's consolidated turnover"},
    PEER_BASIS_ANNUAL_REPORT: {"ro": "veniturile din raportul anual al grupului",
                               "en": "revenue from the group's annual report"},
    PEER_BASIS_ESTIMATE: {"ro": "estimare pe segment", "en": "segment estimate"},
    SELF_BASIS: {"ro": "cifra de afaceri netă din balanța de verificare (70x − 709)",
                 "en": "net turnover from the trial balance (70x − 709)"},
}


def peer_revenue_basis(peer: Dict[str, Any]) -> str:
    """The basis of one seeded peer's figures, from its declared source and
    name — the ONE classifier, used to record the seed and to serve it."""
    source = str(peer.get("source") or "").lower()
    name = str(peer.get("company_name") or "").lower()
    if "estimate" in source:
        return PEER_BASIS_ESTIMATE
    if "consolidat" in source or "consolidat" in name:
        return PEER_BASIS_CONSOLIDATED
    if "ministerul" in source or "termene" in source or "risco" in source:
        return PEER_BASIS_FILED
    return PEER_BASIS_ANNUAL_REPORT


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

    refusals: Dict[str, Dict[str, Any]] = company_metrics.get("refusals") or {}
    # Inject the "this is you" row.
    cur_year_revenue_lei = company_metrics.get("revenue") or 0.0
    cur_year_revenue_mlei = cur_year_revenue_lei / 1_000_000 if cur_year_revenue_lei else None
    self_row = {
        "company_name": company_name,
        "fiscal_year": company_metrics.get("__fiscal_year__"),
        "revenue_mlei": round(cur_year_revenue_mlei, 1) if cur_year_revenue_mlei else None,
        # The other rows in this column are peers' FILED net profits from
        # Ministry of Finance accounts. The company's own row read
        # `net_income` — the class-6/7 reconstruction — so it was the only
        # row in the table on a different basis, and it disagreed with the
        # headline tile one scroll above it (agras: 14.1 M vs 7.5 M).
        # PRESENCE is tested on a REPORTED figure, not on the derived
        # `net_income_operating` — that one is always present (it is
        # `net_income or 0` plus 722), so testing it would print a
        # capitalized-own-work total as the bottom line of a period that
        # reported no profit at all. Absent stays blank.
        "net_profit_mlei": _self_net_profit_mlei(company_metrics),
        # A margin the one rule refuses (the developer) or an EBITDA margin
        # refused with the EBITDA is not printed in the peer table either —
        # the same refusal as the graded rows above, never a percent beside
        # the peers' filed ones.
        "net_margin_pct": None if "net_margin" in refusals else company_metrics.get("net_margin"),
        "ebitda_margin_pct": None if "ebitda_margin" in refusals else company_metrics.get("ebitda_margin"),
        "equity_ratio_pct": company_metrics.get("equity_ratio"),
        "debt_to_equity": None,
        "specialization": "Compania ta",
        "tier": "self",
        "source": "Trial balance — current period",
        "revenue_basis": SELF_BASIS,
        "revenue_basis_display": dict(PEER_BASIS_DISPLAY[SELF_BASIS]),
        "refusals": {k: refusals[k] for k in ("net_margin", "ebitda_margin") if k in refusals},
        "display_order": 99,  # sort to the end by default; FE may reorder
    }
    peers_basis = []
    for peer in peers:
        row = dict(peer)
        basis = row.get("revenue_basis") or peer_revenue_basis(row)
        row["revenue_basis"] = basis
        row["revenue_basis_display"] = dict(PEER_BASIS_DISPLAY[basis])
        peers_basis.append(row)
    peers_full = peers_basis + [self_row]
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
