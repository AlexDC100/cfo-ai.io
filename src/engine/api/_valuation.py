"""EBITDA-multiple valuation engine.

This is the deterministic-math companion to stage_narrate. Opus 4.7 writes
rationale text but never the numbers (same architectural rule as Phase I:
ratios are math, narrative is LLM).

PRIMARY METHOD — EV/EBITDA:
    EV       = EBITDA × multiple
    Equity   = EV − total_debt + cash

We materialize three scenarios per industry: P25 / P50 / P75 of the peer
multiple distribution (Damodaran 2026, EU). P50 is the headline.

CROSS-CHECKS:
    EV/Revenue × revenue   → equity (for revenue-led businesses)
    DCF (FCF + WACC + Gordon terminal) → equity (intrinsic)

CONFIDENCE:
    low      — EBITDA ≤ 0, or ebitda_margin < 5%, or generic industry fallback
    medium   — EBITDA positive but margin 5–10%, OR using an aliased industry
               key (e.g. 'fmcg_distribution' falling back to 'fmcg')
    high     — EBITDA positive, margin ≥ 10%, exact industry_key match

The football_field block lists each method with its low/mid/high equity
value so the dashboard can render a horizontal-bar chart.

THE ONE EBITDA (owner ruling 2026-09-26). EBITDA is the assembled P&L's one
definition (`credit_model.operating_figures`: net 711 "Variația stocurilor
de produse" and net 72x inside, 767 financial), read — never recomputed here
when the served figure is 0.0 or absent (the legacy fallback that rebuilt a
"statutory" EBITDA from the incomeStatement mirror is gone). A refused
EBITDA refuses EV/EBITDA with the reason. ROUTING is by the company, not by
the sign of its EBITDA: commercial real estate (the sector) and a book
whose turnover is negligible against its operating activity (the ONE
margin rule, engine.ratios.margin_meaning — the developer) are valued on
their assets; the developer's EBITDA turned from -29.0M to +0.55M by
ruling, and its valuation must not move because of it. On an operating
company a non-positive EBITDA still leaves EV/EBITDA undefined (a method
domain, stated). The NAV cap-rate NOI proxy is served as EBITDA − net 711
(the stock variation is not rental income), labelled "NOI (aproximare)".
User-saved overrides are stamped with the EBITDA definition; one saved
under an earlier definition is flagged.
"""

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, Tuple

from engine.country_packs.ro_romania import parameters as _ro_params
from engine.country_packs.ro_romania.chart_of_accounts import EBITDA_DEFINITION_REVISION

from . import _supabase


logger = logging.getLogger(__name__)


# ─── Benchmark loader ───────────────────────────────────────────────────────


# Some industry keys are coarser than the benchmark seed; fall back through a
# short chain before landing on 'generic'. Keeps low-cardinality industry keys
# from accidentally hitting the wide 'generic' band.
_INDUSTRY_FALLBACK = {
    "real_estate_office": "real_estate_commercial",
    "real_estate_retail": "real_estate_commercial",
    "real_estate_industrial": "real_estate_commercial",
    "real_estate_logistics": "real_estate_commercial",
    "real_estate_mixed": "real_estate",
    "fmcg_food": "fmcg",
    "fmcg_beverage": "fmcg",
    "saas_b2b": "b2b_saas",
    "saas_b2c": "saas",
    "ecom": "e_commerce",
    "logistics_trucking": "transport_logistics",
    "construction_residential": "construction",
    "construction_commercial": "construction",
    "energy": "energy_utilities",
    "utilities": "energy_utilities",
}


def _candidate_keys(industry_key: Optional[str]) -> List[str]:
    """Resolution chain for one industry_key → list of keys to try in order."""
    key = (industry_key or "generic").lower().strip()
    chain: List[str] = [key]
    aliased = _INDUSTRY_FALLBACK.get(key)
    if aliased and aliased not in chain:
        chain.append(aliased)
    if "generic" not in chain:
        chain.append("generic")
    return chain


def load_valuation_benchmarks(industry_key: Optional[str]) -> Dict[str, Any]:
    """Return both EV/EBITDA and EV/Revenue benchmarks for the resolved
    industry, plus which key actually matched.

    Output shape:
      {
        "industry_key_used": "fmcg",
        "industry_key_requested": "fmcg_distribution",
        "ev_ebitda":  {"p25": 6.0, "p50": 8.5, "p75": 11.0, "source": "...", "as_of_date": "..."},
        "ev_revenue": {"p25": 0.3, "p50": 0.5, "p75": 0.8,  "source": "...", "as_of_date": "..."},
      }
    """
    requested = (industry_key or "generic").lower().strip()
    chain = _candidate_keys(industry_key)

    with _supabase.admin() as client:
        rows = client.select(
            "industry_benchmarks",
            filters={
                "metric_name": "in.(ev_ebitda_multiple,ev_revenue_multiple)",
                "industry_key": f"in.({','.join(chain)})",
            },
        )

    by_key: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for r in rows:
        by_key.setdefault(r["industry_key"], {})[r["metric_name"]] = r

    industry_key_used: Optional[str] = None
    for candidate in chain:
        if candidate in by_key and "ev_ebitda_multiple" in by_key[candidate]:
            industry_key_used = candidate
            break
    if industry_key_used is None:
        # Defensive — schema seed guarantees 'generic' exists, but if a fresh
        # install ever drops it we return all-None and the caller emits a
        # low-confidence valuation.
        return {
            "industry_key_used": None,
            "industry_key_requested": requested,
            "ev_ebitda": None,
            "ev_revenue": None,
        }

    def pack(metric: Dict[str, Any] | None) -> Optional[Dict[str, Any]]:
        if metric is None:
            return None
        return {
            "p25": float(metric["p25"]) if metric.get("p25") is not None else None,
            "p50": float(metric["p50"]) if metric.get("p50") is not None else None,
            "p75": float(metric["p75"]) if metric.get("p75") is not None else None,
            "source": metric.get("source"),
            "as_of_date": str(metric.get("as_of_date")) if metric.get("as_of_date") else None,
        }

    return {
        "industry_key_used": industry_key_used,
        "industry_key_requested": requested,
        "ev_ebitda": pack(by_key[industry_key_used].get("ev_ebitda_multiple")),
        "ev_revenue": pack(by_key[industry_key_used].get("ev_revenue_multiple")),
    }


# ─── DCF cross-check ─────────────────────────────────────────────────────────
#
# ABSENT IS NEVER ZERO AND NEVER A FLOOR (owner rulings R-D5, R-D6, R-OTHER,
# 2026-09-15). This section used to keep every division defined by
# substituting a figure the book did not yield: book equity floored at 1 RON
# (so an insolvent book was discounted at the cost of debt and valued ~2.5x
# higher than the same book at +5M equity), a 5% pre-tax cost of debt that
# overrode a measured 2% rate and stood in for absent interest, an effective
# tax rate clamped into [0, 25%], a negative free cash flow floored to 0 (an
# EV of exactly 0 and a zero-width band served as a valuation), and a WACC at
# or below terminal growth nudged to g + 0.5%. Each is now either a stated
# refusal (`refusals`, every applicable one, each with a code, the inputs it
# read and the sentence the page shows) or a DECLARED assumption served with
# its source (`kd_source`, `tax_source`) — never a silent substitute.


#: Romania-corrected WACC and growth inputs. Each is overridable through
#: POST /api/period/{id}/valuation/recompute (F1.j); the override keys are
#: the keys of this table.
DCF_DEFAULTS: Dict[str, float] = {
    "rf": 0.0675,                   # Romanian 10Y sovereign, RON
    "equity_risk_premium": 0.075,   # Romania mature-EM premium (Damodaran)
    "beta": 1.0,
    "forecast_growth": 0.035,       # years 1-N (CPI + small lease-up)
    "terminal_growth": 0.030,       # mature CRE indexation
    "forecast_years": 5,
}

#: WACC shift of each sensitivity scenario around the central rate.
DCF_SCENARIO_SHIFTS: Tuple[Tuple[str, float], ...] = (
    ("Optimistic", -0.010),
    ("Central", 0.0),
    ("Conservative", 0.015),
)

#: The mathematical domain of each recompute override. A value outside it
#: makes the DCF formula itself undefined, so the endpoint answers 400 with
#: the sentence rendered from this row — it never computes at a substitute.
#: `gt` / `ge` are exclusive / inclusive lower bounds; every value must be a
#: finite number.
DCF_OVERRIDE_DOMAINS: Dict[str, Dict[str, Any]] = {
    "forecast_years": {"ge": 1, "integer": True,
                       "why": "the explicit forecast needs at least one whole year"},
    "forecast_growth": {"gt": -1.0,
                        "why": "a growth rate at or below -100% has no compounding meaning"},
    "terminal_growth": {"gt": -1.0,
                        "why": "a growth rate at or below -100% has no compounding meaning"},
    "rf": {"why": "the risk-free rate must be a finite number"},
    "equity_risk_premium": {"why": "the equity risk premium must be a finite number"},
    "beta": {"why": "beta must be a finite number"},
}


def _pct(x: float, places: int = 1) -> str:
    return f"{x * 100:.{places}f}%"


def _refusal(code: str, inputs: List[str], text: str) -> Dict[str, Any]:
    return {"code": code, "inputs": list(inputs), "text": text}


def dcf_override_domain_errors(overrides: Dict[str, Any]) -> List[str]:
    """Every override outside `DCF_OVERRIDE_DOMAINS`, as the sentence the
    recompute endpoint returns with its 400. Empty list = all in domain."""
    errors: List[str] = []
    for key, value in (overrides or {}).items():
        dom = DCF_OVERRIDE_DOMAINS.get(key)
        if dom is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            errors.append(f"'{key}' must be a finite number (got {value!r}); {dom['why']}.")
            continue
        if dom.get("integer") and float(value) != int(value):
            errors.append(f"'{key}' must be a whole number (got {value!r}); {dom['why']}.")
            continue
        if "ge" in dom and value < dom["ge"]:
            errors.append(f"'{key}' must be at least {dom['ge']} (got {value!r}); {dom['why']}.")
        if "gt" in dom and value <= dom["gt"]:
            errors.append(f"'{key}' must be greater than {dom['gt']} (got {value!r}); {dom['why']}.")
    return errors


def _tax_rate_for_dcf(tax_expense: Optional[float], pretax: Optional[float]) -> Dict[str, Any]:
    """R-D6. The book's effective rate when it is measurable and inside
    [0, statutory]; otherwise the statutory rate from pack data, labelled
    with why the effective rate was not used. Never clamped."""
    statutory = _ro_params.STATUTORY_PROFIT_TAX_RATE
    bound = f"[0, {_pct(statutory)}]"
    if tax_expense is None:
        why = "effective rate not measurable: tax expense not reported"
        effective = None
    elif pretax is None or pretax <= 0:
        why = ("effective rate not measurable: pre-tax profit not reported" if pretax is None
               else f"effective rate not measurable: pre-tax profit {_fmt_ron(pretax)} is not positive")
        effective = None
    else:
        effective = tax_expense / pretax
        if 0.0 <= effective <= statutory:
            return {"tax_rate": effective, "tax_source": "effective",
                    "tax_label": f"effective ({_fmt_ron(tax_expense)} tax / {_fmt_ron(pretax)} pre-tax)",
                    "effective_tax_rate": effective}
        why = f"effective rate {_pct(effective)} outside {bound}"
    return {"tax_rate": statutory, "tax_source": "statutory",
            "tax_label": f"statutory {_pct(statutory)} ({why}; {_ro_params.STATUTORY_PROFIT_TAX_SOURCE})",
            "effective_tax_rate": effective}


def _cost_of_debt_for_dcf(interest_expense: Optional[float], debt: float,
                          tax_rate: float) -> Dict[str, Any]:
    """R-D5. The book's implied rate (interest / debt) when it is
    measurable; the methodology's Romanian SME assumption, served with its
    range and source, when it is not. No floor."""
    if debt == 0:
        return {"kd_source": "not_applicable_no_debt", "cost_of_debt_pre_tax": None,
                "cost_of_debt_after_tax": None, "cost_of_debt_after_tax_range": None,
                "kd_note": "No interest-bearing debt on the balance sheet: the debt weight is 0."}
    if interest_expense is not None and interest_expense > 0:
        implied = interest_expense / debt
        return {"kd_source": "implied", "cost_of_debt_pre_tax": implied,
                "cost_of_debt_after_tax": implied * (1 - tax_rate),
                "cost_of_debt_after_tax_range": None,
                "kd_note": (f"Implied from interest expense {_fmt_ron(interest_expense)} "
                            f"on debt {_fmt_ron(debt)}.")}
    lo, hi = _ro_params.METHODOLOGY_KD_AFTER_TAX_RANGE
    central = (lo + hi) / 2
    if interest_expense is None:
        missing = "interest expense (class 666) is not reported"
    elif interest_expense == 0:
        # A measured 0 on positive debt is NOT served as a 0% Kd — the
        # ruling in parameters.py says why, and the note states it.
        missing = ("no interest expense (class 666) is booked; "
                   + _ro_params.METHODOLOGY_KD_ZERO_INTEREST_RULING)
    else:
        missing = f"interest expense is negative ({_fmt_ron(interest_expense)})"
    return {"kd_source": "methodology_assumption", "cost_of_debt_pre_tax": None,
            "cost_of_debt_after_tax": central,
            "cost_of_debt_after_tax_range": [lo, hi],
            "kd_note": (f"The book carries {_fmt_ron(debt)} of debt but {missing}, so its cost of "
                        f"debt cannot be measured. The DCF uses the methodology assumption "
                        f"{_pct(lo)}-{_pct(hi)} after tax, central {_pct(central, 2)} "
                        f"({_ro_params.METHODOLOGY_KD_SOURCE}).")}


def _dcf_cross_check(
    *,
    net_income: Optional[float],
    depreciation: Optional[float],
    total_debt: Optional[float],
    cash: Optional[float],
    interest_expense: Optional[float],
    tax_expense: Optional[float],
    pretax: Optional[float],
    total_equity: Optional[float],
    real_capex: Optional[float] = None,
    net_wc_change: Optional[float] = None,
    use_stabilized_fcf: bool = False,
    wc_change_approximated: bool = False,
    # ── F1.j — interactive recompute overrides (None = DCF_DEFAULTS) ────
    rf_override: Optional[float] = None,
    erp_override: Optional[float] = None,
    beta_override: Optional[float] = None,
    forecast_growth_override: Optional[float] = None,
    terminal_growth_override: Optional[float] = None,
    forecast_years_override: Optional[int] = None,
) -> Dict[str, Any]:
    """5-year FCF growth + Gordon terminal, ROMANIA-CORRECTED inputs.

    WACC = E/(D+E) x Ke + D/(D+E) x Kd_after, book-value weights from the
    canonical balance sheet. Ke = Rf + beta x ERP (`DCF_DEFAULTS`). Kd is
    the book's implied rate or the declared methodology assumption
    (`_cost_of_debt_for_dcf`); the tax rate is the book's effective rate
    or the declared statutory rate (`_tax_rate_for_dcf`).

    `use_stabilized_fcf=True` (or no real capex figure) values the business
    on NI + ΔWC — maintenance capex taken as D&A — instead of CFO + capex.

    Refuses, with every applicable reason in `refusals`, when: debt is
    negative; book equity is not positive or not reported (the weights are
    undefined); a base-FCF input is not reported; base FCF is not positive
    (a perpetuity DCF is undefined); WACC does not exceed terminal growth
    (the Gordon terminal is undefined — per scenario, so an Optimistic shift
    that crosses g refuses that scenario alone). A refused DCF serves null
    values, never 0 and never -net debt.
    """
    refusals: List[Dict[str, Any]] = []

    given = {k: v for k, v in (
        ("rf", rf_override), ("equity_risk_premium", erp_override), ("beta", beta_override),
        ("forecast_years", forecast_years_override),
        ("forecast_growth", forecast_growth_override),
        ("terminal_growth", terminal_growth_override)) if v is not None}
    domain = dcf_override_domain_errors(given)
    if domain:
        # The formula is undefined at these inputs: refuse the whole DCF and
        # compute nothing at them (the recompute endpoint answers 400 first).
        refusals.append(_refusal("dcf_override_out_of_domain", sorted(given),
                                 "DCF unavailable: " + " ".join(domain)))
        given = {}
    inputs = {**DCF_DEFAULTS, **{k: float(v) for k, v in given.items()}}
    rf = inputs["rf"]
    erp = inputs["equity_risk_premium"]
    beta = inputs["beta"]
    horizon = int(inputs["forecast_years"])
    g_forecast = inputs["forecast_growth"]
    g_terminal = inputs["terminal_growth"]
    cost_of_equity = rf + beta * erp

    tax = _tax_rate_for_dcf(tax_expense, pretax)
    tax_rate = tax["tax_rate"]

    # ── Capital structure ────────────────────────────────────────────────
    we: Optional[float] = None
    wd: Optional[float] = None
    kd: Dict[str, Any] = {"kd_source": None, "cost_of_debt_pre_tax": None,
                          "cost_of_debt_after_tax": None, "cost_of_debt_after_tax_range": None,
                          "kd_note": None}
    if total_debt is None:
        refusals.append(_refusal(
            "dcf_debt_absent", ["balanceSheet.total_debt"],
            "DCF cross-check unavailable: total debt is not reported, so the "
            "capital-structure weights for WACC are undefined."))
    elif total_debt < 0:
        refusals.append(_refusal(
            "dcf_debt_negative", ["balanceSheet.total_debt"],
            f"DCF cross-check unavailable: total debt is negative ({_fmt_ron(total_debt)}), "
            f"so the capital-structure weights for WACC are undefined; debt classification "
            f"needs review."))
    else:
        kd = _cost_of_debt_for_dcf(interest_expense, total_debt, tax_rate)
    if total_equity is None:
        refusals.append(_refusal(
            "dcf_equity_absent", ["balanceSheet.total_equity"],
            "DCF cross-check unavailable: book equity is not reported, so the "
            "capital-structure weights for WACC are undefined; use asset-based / NAV."))
    elif total_equity <= 0:
        refusals.append(_refusal(
            "dcf_equity_not_positive", ["balanceSheet.total_equity"],
            f"DCF cross-check unavailable: book equity is not positive "
            f"({_fmt_ron(total_equity)}), so the capital-structure weights for WACC are "
            f"undefined; use asset-based / NAV."))
    wacc_central: Optional[float] = None
    if total_debt is not None and total_debt >= 0 and total_equity is not None and total_equity > 0:
        wd = total_debt / (total_debt + total_equity)
        we = 1.0 - wd
        kd_after = kd["cost_of_debt_after_tax"] if wd > 0 else 0.0
        wacc_central = we * cost_of_equity + wd * kd_after

    # ── Base free cash flow ──────────────────────────────────────────────
    # The working-capital change a single-period book yields is the RO
    # pack's approximation (assembled_cf.is_approximated — ±5% of the
    # closing balances, no prior-period balance sheet). It is labelled at
    # its source; the label travels with it here (sweep C5.2), so a base
    # FCF built on it is never stated as a measurement.
    wc_label = ("working-capital change" if not wc_change_approximated
                else "working-capital change [approximated: no prior-period balance sheet]")
    base_fcf: Optional[float] = None
    stabilized = use_stabilized_fcf or real_capex is None or real_capex == 0.0
    if stabilized:
        missing = [n for n, v in (("incomeStatement.net_income", net_income),
                                  ("cashFlow.net_wc_change", net_wc_change)) if v is None]
        formula = "net income + " + wc_label
        if not missing:
            base_fcf = net_income + net_wc_change
    else:
        missing = [n for n, v in (("incomeStatement.net_income", net_income),
                                  ("incomeStatement.depreciation", depreciation),
                                  ("cashFlow.net_wc_change", net_wc_change)) if v is None]
        formula = "net income + D&A + " + wc_label + " + capex"
        if not missing:
            base_fcf = net_income + depreciation + net_wc_change + real_capex
    if cash is None:
        refusals.append(_refusal(
            "dcf_cash_absent", ["balanceSheet.cash"],
            "DCF not computed: cash is not reported, so net debt (and the equity "
            "value it bridges to) is undefined."))
    if missing:
        refusals.append(_refusal(
            "dcf_fcf_input_absent", missing,
            "DCF not computed: %s not available for this period." % ", ".join(missing)))
    elif base_fcf <= 0:
        refusals.append(_refusal(
            "dcf_base_fcf_not_positive", ["dcf.base_fcf"],
            f"DCF not computed: base free cash flow is non-positive ({formula} = "
            f"{_fmt_ron(base_fcf)}); a perpetuity DCF is undefined for this period."))

    def _wacc_refusal(label: str, wacc: float) -> Dict[str, Any]:
        return _refusal(
            "dcf_wacc_not_above_growth", ["dcf.wacc", "dcf.terminal_growth"],
            f"DCF unavailable{'' if label == 'Central' else ' (' + label + ' scenario)'}: "
            f"discount rate (WACC {_pct(wacc)}) must exceed terminal growth "
            f"(g {_pct(g_terminal)}); the Gordon terminal value is undefined.")

    if wacc_central is not None and wacc_central <= g_terminal:
        refusals.append(_wacc_refusal("Central", wacc_central))

    def _dcf_at(wacc: float) -> Dict[str, float]:
        """One DCF at `wacc` (> g_terminal, checked by the caller)."""
        total_pv = 0.0
        last = base_fcf
        for y in range(1, horizon + 1):
            fcf = base_fcf * ((1 + g_forecast) ** y)
            total_pv += fcf / ((1 + wacc) ** y)
            last = fcf
        tv_pv = ((last * (1 + g_terminal)) / (wacc - g_terminal)) / ((1 + wacc) ** horizon)
        ev = total_pv + tv_pv
        net_debt = total_debt - cash
        return {"enterprise_value": ev, "net_debt": net_debt, "equity_value": ev - net_debt}

    scenarios: Optional[List[Dict[str, Any]]] = None
    central: Optional[Dict[str, float]] = None
    by_label: Dict[str, Optional[Dict[str, float]]] = {}
    if not refusals:
        scenarios = []
        for label, shift in DCF_SCENARIO_SHIFTS:
            w = wacc_central + shift
            if w <= g_terminal:
                by_label[label] = None
                scenarios.append({"label": label, "wacc": round(w, 4), "enterprise_value": None,
                                  "net_debt": round(total_debt - cash, 2), "equity_value": None,
                                  "refusal": _wacc_refusal(label, w)})
                continue
            r = _dcf_at(w)
            by_label[label] = r
            scenarios.append({"label": label, "wacc": round(w, 4),
                              "enterprise_value": round(r["enterprise_value"], 2),
                              "net_debt": round(r["net_debt"], 2),
                              "equity_value": round(r["equity_value"], 2),
                              "refusal": None})
        central = by_label.get("Central")

    def _eq(label: str) -> Optional[float]:
        r = by_label.get(label)
        return None if r is None else round(r["equity_value"], 2)

    return {
        "refusals": refusals,
        "wacc": None if wacc_central is None else round(wacc_central, 4),
        "wacc_components": {
            "rf": rf,
            "erp": erp,
            "beta": beta,
            "cost_of_equity": round(cost_of_equity, 4),
            "cost_of_debt_pre_tax": (None if kd["cost_of_debt_pre_tax"] is None
                                     else round(kd["cost_of_debt_pre_tax"], 4)),
            "cost_of_debt_after_tax": (None if kd["cost_of_debt_after_tax"] is None
                                       else round(kd["cost_of_debt_after_tax"], 4)),
            "cost_of_debt_after_tax_range": kd["cost_of_debt_after_tax_range"],
            "kd_source": kd["kd_source"],
            "kd_note": kd["kd_note"],
            "tax_rate": round(tax_rate, 4),
            "tax_source": tax["tax_source"],
            "tax_label": tax["tax_label"],
            "weight_equity": None if we is None else round(we, 4),
            "weight_debt": None if wd is None else round(wd, 4),
            "total_equity_used": None if total_equity is None else round(total_equity, 2),
            "total_debt_used": None if total_debt is None else round(total_debt, 2),
        },
        "forecast_growth": g_forecast,
        "terminal_growth": g_terminal,
        "base_fcf": None if base_fcf is None else round(base_fcf, 2),
        # How the base FCF was formed, with the approximation label when the
        # working-capital change is the pack's single-period estimate.
        "base_fcf_formula": formula,
        "wc_change_source": "approximated" if wc_change_approximated else "measured",
        "enterprise_value": None if central is None else round(central["enterprise_value"], 2),
        "equity_value": None if central is None else round(central["equity_value"], 2),
        # The optimistic / conservative bookends become the FE
        # sensitivity_low / sensitivity_high band.
        "sensitivity_low": _eq("Conservative"),
        "sensitivity_high": _eq("Optimistic"),
        "scenarios": scenarios,
    }

# ─── Compute (the actual valuation) ──────────────────────────────────────────


def _safe(n: Optional[float], default: float = 0.0) -> float:
    return default if n is None else float(n)


def _first(*values: Any) -> Optional[float]:
    """The first reported number among `values`, or None. Unlike `_safe`,
    an absent figure stays absent — the DCF inputs must be able to tell a
    measured 0 from a figure the statements never carried."""
    for v in values:
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            continue
        if math.isfinite(float(v)):
            return float(v)
    return None


def compute_valuation(
    *,
    industry_key: Optional[str],
    statements: Dict[str, Any],
    user_assumptions: Optional[Dict[str, Any]] = None,
    # F1.j — stateless interactive recompute overrides. Pass-through dict
    # forwarded to `_dcf_cross_check`. None means "engine defaults".
    # Accepted keys (all optional): forecast_years, forecast_growth,
    # terminal_growth, beta, equity_risk_premium, rf, property_market_value,
    # annual_lease_expense, shares_outstanding. The last three are accepted
    # for schema-completeness per SPEC §11 and stored back on the result
    # for the FE to surface even if the engine doesn't yet wire them into
    # the calculation (real-estate-specific extensions).
    dcf_overrides: Optional[Dict[str, Any]] = None,
    # The peer multiples to use instead of reading the benchmark table —
    # `row_benchmarks(stored_row)` when the table is unreachable, so a
    # served valuation is RECOMPUTED on the served EBITDA over the
    # multiples persisted beside the stored row (benchmark data, not an
    # EBITDA) rather than served as stored.
    benchmarks: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build the valuation payload.

    `statements` is the assembled blob (same shape stage_compute consumes):
      { balanceSheet: {...}, incomeStatement: {...} }
    `user_assumptions` is an optional row from user_valuation_assumptions —
    overrides ebitda / multiple / debt / cash if present.
    """
    bs = statements.get("balanceSheet", {})
    pl = statements.get("incomeStatement", {})
    # ── CANONICAL VIEWS — single source of truth ─────────────────────────
    # The Valuation engine MUST read from `assembled_pl` / `assembled_bs` /
    # `assembled_cf`, never derive EBITDA from `revenue − operatingExpenses`
    # (that path produces the operational view, which is negative for EEI
    # and gives the −12.92M nonsense valuation). Statutory EBITDA is the
    # primary; real CapEx (CIP additions) replaces the D&A fallback.
    pl_canonical = statements.get("assembled_pl", {}) or {}
    bs_canonical = statements.get("assembled_bs", {}) or {}
    cf_canonical = statements.get("assembled_cf", {}) or {}

    # Net turnover (cifra de afaceri netă, 70x − 709) — the assembler's
    # `turnover`, the one denominator of every margin and revenue multiple.
    revenue = _safe(_first(pl_canonical.get("turnover"), pl.get("revenue")))
    depreciation = _safe(pl_canonical.get("depreciation", pl.get("depreciationAmortization")))

    # THE ONE EBITDA (owner ruling 2026-09-26), read from the assembled P&L
    # — net 711 and net 72x inside. The revision-2 code read
    # `ebitda_statutory` and, when it was 0.0, RECOMPUTED a second EBITDA
    # from the incomeStatement mirror (without 711): a refused EBITDA (None)
    # or a real zero fell through to another definition. There is no
    # fallback: a refused EBITDA is None, with its reason.
    from engine.ratios.credit_model import operating_figures

    try:
        figures = operating_figures(statements)
    except (KeyError, TypeError):
        figures = {"ebitda": None, "ebit": None, "inventory_variation": None,
                   "capitalized_own_work": None,
                   "refusal": {"code": "ebitda_refused", "cause": "operand_absent",
                               "text_ro": "contul de profit și pierdere nu este asamblat",
                               "text_en": "the profit and loss account is not assembled"}}
    ebitda_computed = figures["ebitda"]
    ebitda_refusal = figures["refusal"]

    cash = _safe(bs_canonical.get("cash", bs.get("cash")))
    total_debt = _safe(bs_canonical.get("total_debt",
                                        _safe(bs.get("shortTermDebt")) + _safe(bs.get("longTermDebt"))))
    # Total equity from the BS — needed for the asset-based fallback when
    # EV/EBITDA is methodologically inappropriate (CRE, negative EBITDA).
    total_equity = _safe(bs_canonical.get("total_equity",
        _safe(bs.get("shareCapital"))
        + _safe(bs.get("retainedEarnings"))
        + _safe(bs.get("otherEquity"))
    ))
    total_assets = _safe(bs_canonical.get("total_assets",
        cash
        + _safe(bs.get("accountsReceivable"))
        + _safe(bs.get("inventory"))
        + _safe(bs.get("otherCurrentAssets"))
        + _safe(bs.get("propertyPlantEquipment"))
        + _safe(bs.get("intangibles"))
        + _safe(bs.get("otherNonCurrentAssets"))
    ))
    # Investment property book value — for the CRE markup range on
    # asset-based valuation. Canonical view exposes it; legacy BS doesn't.
    investment_property_book = _safe(bs_canonical.get("ppe_net",
                                                       bs.get("propertyPlantEquipment", 0)))

    # ── DCF inputs, absence preserved ────────────────────────────────────
    # `_safe` above turns an absent figure into 0.0, which the asset-based /
    # multiple methods have always read. The DCF may not: an absent interest
    # expense is not a measured 0, absent equity is not 1 RON, an absent
    # working-capital change is not "no change".
    dcf_interest = _first(pl_canonical.get("interest_expense"), pl.get("interestExpense"))
    dcf_tax = _first(pl_canonical.get("tax"), pl.get("taxExpense"))
    dcf_depreciation = _first(pl_canonical.get("depreciation"), pl.get("depreciationAmortization"))
    # The pre-tax figure the DCF reads is the reported one, never the
    # `_safe`-built reconstruction above: `pretax - tax` stood in for an
    # absent statutory net income with `tax` read as 0 when it was not
    # reported, so the same envelope declared "tax expense not reported"
    # in `tax_label` and served a net income that assumed it was nil.
    dcf_pretax = _first(pl_canonical.get("pretax"))
    dcf_net_income = _first(
        pl_canonical.get("net_income_statutory"),
        None if dcf_pretax is None or dcf_tax is None else dcf_pretax - dcf_tax)
    dcf_cash = _first(bs_canonical.get("cash"), bs.get("cash"))
    _legacy_debt = [v for v in (_first(bs.get("shortTermDebt")), _first(bs.get("longTermDebt")))
                    if v is not None]
    dcf_total_debt = _first(bs_canonical.get("total_debt"),
                            sum(_legacy_debt) if _legacy_debt else None)
    _legacy_equity = [v for v in (_first(bs.get("shareCapital")), _first(bs.get("retainedEarnings")),
                                  _first(bs.get("otherEquity"))) if v is not None]
    dcf_total_equity = _first(bs_canonical.get("total_equity"),
                              sum(_legacy_equity) if _legacy_equity else None)

    # User overrides (Step 4). An override is a figure the user typed: it
    # stands (its stamp says which definition it was typed under); without
    # one, the one EBITDA or its refusal.
    ua = user_assumptions or {}
    ebitda_used = _first(ua.get("ebitda_used"), ebitda_computed)
    total_debt_used = _safe(ua.get("debt_used"), total_debt)
    cash_used = _safe(ua.get("cash_used"), cash)

    if benchmarks is None:
        benchmarks = load_valuation_benchmarks(industry_key)
    ebitda_bm = benchmarks["ev_ebitda"]
    revenue_bm = benchmarks["ev_revenue"]
    industry_used = benchmarks["industry_key_used"]
    industry_requested = benchmarks["industry_key_requested"]

    # ── Methodology guard ────────────────────────────────────────────────
    # EV/EBITDA is mathematically defined for any EBITDA but produces
    # nonsense when EBITDA is negative (a positive multiple × negative
    # EBITDA = negative EV = "company worth less than its debt by definition",
    # which is a fact about the formula not about the company). It's also
    # the wrong method for commercial real estate, where value derives from
    # the property asset and NOI / cap rate, not from operating earnings.
    #
    # Rule:
    #   - EBITDA ≤ 0  → demote EV/EBITDA, switch primary to asset_based
    #   - industry is CRE → demote EV/EBITDA, switch primary to asset_based
    # In both cases EV/EBITDA stays in the response (auditable) but is NOT
    # the primary method and is NOT shown on the football field.
    cre_industries = {"real_estate_commercial", "real_estate", "real_estate_office",
                      "real_estate_retail", "real_estate_industrial",
                      "real_estate_logistics", "real_estate_mixed"}
    is_cre = (industry_used in cre_industries) or (industry_requested in cre_industries)
    # The ONE margin rule: turnover negligible against operating activity
    # (a property developer in a building year) — the company is valued on
    # its assets whatever the sign of its EBITDA.
    from engine.ratios import margin_meaning as _mm

    try:
        margin_verdict, _margin_inputs = _mm.period_verdict(statements)
    except Exception:  # noqa: BLE001 — a pack the rule cannot read routes nothing
        margin_verdict = None
    margin_refused = bool(margin_verdict is not None and margin_verdict.refused)
    ebitda_refused = ebitda_used is None
    # EV/EBITDA has no useful value on a refused or non-positive EBITDA — a
    # METHOD domain, stated; it is not what routes a developer.
    ebitda_unusable = ebitda_refused or ebitda_used <= 0

    # ── ROUTING: by the company (sector, margin rule), then the method ────
    if is_cre:
        routing_basis = "sector_real_estate"
    elif margin_refused:
        routing_basis = "margin_not_meaningful"
    elif ebitda_refused:
        routing_basis = "ebitda_refused"
    elif ebitda_unusable:
        routing_basis = "ebitda_not_positive"
    else:
        routing_basis = "ev_ebitda"
    primary_method = "ev_ebitda" if routing_basis == "ev_ebitda" else "asset_based"
    if ebitda_used is None:
        ebitda_used_value = 0.0  # never served: every figure on it is refused below
    else:
        ebitda_used_value = ebitda_used
    multiple_p25 = (ebitda_bm or {}).get("p25") if ebitda_bm else None
    multiple_p50 = (ebitda_bm or {}).get("p50") if ebitda_bm else None
    multiple_p75 = (ebitda_bm or {}).get("p75") if ebitda_bm else None

    # User-supplied multiple overrides P50 only (the slider position).
    multiple_override = ua.get("multiple_used")
    if multiple_override is not None:
        multiple_p50 = float(multiple_override)

    def equity_from_multiple(m: Optional[float]) -> Optional[float]:
        if m is None or ebitda_refused:
            return None
        ev = ebitda_used_value * m
        return round(ev - total_debt_used + cash_used, 2)

    def ev_from_multiple(m: Optional[float]) -> Optional[float]:
        if m is None or ebitda_refused:
            return None
        return round(ebitda_used_value * m, 2)

    equity_ebitda_p25 = equity_from_multiple(multiple_p25)
    equity_ebitda_p50 = equity_from_multiple(multiple_p50)
    equity_ebitda_p75 = equity_from_multiple(multiple_p75)
    ev_ebitda_p25 = ev_from_multiple(multiple_p25)
    ev_ebitda_p50 = ev_from_multiple(multiple_p50)
    ev_ebitda_p75 = ev_from_multiple(multiple_p75)

    # ── CROSS-CHECK 1: EV/Revenue ─────────────────────────────────────────
    rev_p25 = (revenue_bm or {}).get("p25") if revenue_bm else None
    rev_p50 = (revenue_bm or {}).get("p50") if revenue_bm else None
    rev_p75 = (revenue_bm or {}).get("p75") if revenue_bm else None

    def equity_from_rev_multiple(m: Optional[float]) -> Optional[float]:
        if m is None or revenue <= 0:
            return None
        ev = revenue * m
        return round(ev - total_debt_used + cash_used, 2)

    ev_rev_equity_p25 = equity_from_rev_multiple(rev_p25)
    ev_rev_equity_p50 = equity_from_rev_multiple(rev_p50)
    ev_rev_equity_p75 = equity_from_rev_multiple(rev_p75)

    # ── CROSS-CHECK 2: DCF ───────────────────────────────────────────────
    # CRE companies in development phase have real one-time CIP capex that
    # would crush the DCF if treated as recurring. Use stabilized FCF for
    # the perpetuity (maintenance capex ≈ D&A).
    dcf_real_capex = _first(cf_canonical.get("capex_real"))
    dcf_net_wc_change = _first(cf_canonical.get("net_wc_change"))
    real_capex = _safe(dcf_real_capex)
    net_wc_change = _safe(dcf_net_wc_change)
    use_stabilized = is_cre and abs(real_capex) > depreciation * 2
    # F1.j — DCF overrides (rf / erp / beta / forecast_growth /
    # terminal_growth / forecast_years) thread through to _dcf_cross_check.
    # When absent, _dcf_cross_check applies its engine defaults.
    overrides = dcf_overrides or {}
    dcf = _dcf_cross_check(
        depreciation=dcf_depreciation,
        net_income=dcf_net_income,
        total_debt=_first(ua.get("debt_used"), dcf_total_debt),
        cash=_first(ua.get("cash_used"), dcf_cash),
        interest_expense=dcf_interest,
        tax_expense=dcf_tax,
        pretax=dcf_pretax,
        # The REAL book equity from the canonical BS view, signed and
        # unfloored: a non-positive or absent equity refuses the DCF.
        total_equity=dcf_total_equity,
        real_capex=dcf_real_capex,
        net_wc_change=dcf_net_wc_change,
        use_stabilized_fcf=use_stabilized,
        wc_change_approximated=bool(cf_canonical.get("is_approximated")),
        rf_override=overrides.get("rf"),
        erp_override=overrides.get("equity_risk_premium"),
        beta_override=overrides.get("beta"),
        forecast_growth_override=overrides.get("forecast_growth"),
        terminal_growth_override=overrides.get("terminal_growth"),
        forecast_years_override=overrides.get("forecast_years"),
    )

    # ── FCF BREAKDOWN for the Valuation tab tiles ────────────────────────
    # Mirrors the visible "Free cash flow" row on the Valuation tab. The
    # FE reads these verbatim — no client-side capex inference.
    # A tile whose inputs are absent is None, never a 0.00 built from
    # zeroed operands; `stabilized_fcf` is SIGNED — it used to be floored at
    # 0, so a development-phase banner read "net income + ΔWC ≈ RON 0.00"
    # on a book whose NI + ΔWC was -3.5M.
    cfo_value = (None if None in (dcf_net_income, dcf_depreciation, dcf_net_wc_change)
                 else round(dcf_net_income + dcf_depreciation + dcf_net_wc_change, 2))
    fcf_value = (None if cfo_value is None or dcf_real_capex is None
                 else round(cfo_value + dcf_real_capex, 2))
    fcf_breakdown = {
        "net_income": None if dcf_net_income is None else round(dcf_net_income, 2),
        "depreciation": None if dcf_depreciation is None else round(dcf_depreciation, 2),
        "net_wc_change": None if dcf_net_wc_change is None else round(dcf_net_wc_change, 2),
        "cash_from_operating": cfo_value,
        "capex_real": None if dcf_real_capex is None else round(dcf_real_capex, 2),
        "free_cash_flow": fcf_value,
        "is_development_phase": bool(use_stabilized),
        "stabilized_fcf": (None if dcf_net_income is None or dcf_net_wc_change is None
                           else round(dcf_net_income + dcf_net_wc_change, 2)),
        # The working-capital change (and so CFO, FCF and the stabilized
        # tile) is the pack's single-period approximation when
        # assembled_cf says so — stated here, beside the figures built on it.
        "net_wc_change_source": ("approximated (assembled_cf.is_approximated: ±5% of closing "
                                 "balances, no prior-period balance sheet)"
                                 if cf_canonical.get("is_approximated") else "measured"),
    }

    # ── Confidence ───────────────────────────────────────────────────────
    # The margin is undefined without revenue; such a book is low confidence
    # for that reason, not because its margin "is 0%".
    ebitda_margin = (ebitda_used_value / revenue) if revenue > 0 and not ebitda_refused else None
    if ebitda_unusable or margin_refused or industry_used in (None, "generic", "other", "unknown"):
        confidence = "low"
    elif ebitda_margin is None or ebitda_margin < 0.05:
        confidence = "low"
    elif ebitda_margin < 0.10 or industry_used != industry_requested:
        confidence = "medium"
    else:
        confidence = "high"

    # ── Asset-based valuation (primary for CRE / negative-EBITDA) ────────
    # Book equity is the conservative anchor: total assets at cost less
    # accumulated depreciation minus total liabilities. For CRE this is
    # typically conservative relative to fair value; the briefing should
    # frame the gap (Step 7 — "Book LTV is X based on depreciated cost;
    # market LTV is likely lower").
    # BOOK EQUITY THAT EXCLUDES A REFUSED YEAR'S RESULT (no account 121,
    # net 711 refused, the sheet short by the missing result — the
    # assembler's `total_equity_refusal`) is not the company's book equity:
    # the asset-based value REFUSES with the net result's typed reason,
    # never the rows' sum standing in (the constructed book with its 121
    # row dropped was valued at 200,000.00 where its equity with the
    # year's result is 370,000.00).
    from engine.ratios.credit_model import equity_completeness_refusal

    _equity_incomplete = equity_completeness_refusal(statements)
    asset_based_refusal: Optional[Dict[str, Any]] = None
    if _equity_incomplete is not None:
        asset_based_refusal = {
            "code": "total_equity_incomplete",
            "cause": _equity_incomplete.get("code"),
            "text_ro": _equity_incomplete.get("text_ro"),
            "text_en": _equity_incomplete.get("text_en"),
            "inputs": ["assembled_bs.total_equity", "assembled_bs.total_equity_refusal"],
        }
    asset_based_equity: Optional[float] = (None if asset_based_refusal is not None
                                           else round(total_equity, 2))
    asset_based_label = {
        "sector_real_estate": ("Asset-based — investment property + other assets − debt − other liab. "
                               "(book value; market value typically higher for stabilized CRE)"),
        "margin_not_meaningful": ("Asset-based — book equity (turnover is negligible against operating "
                                  "activity: valued on assets, not on an earnings multiple)"),
        "ebitda_refused": "Asset-based — book equity (EV/EBITDA refused: EBITDA is refused for this period)",
        "ebitda_not_positive": "Asset-based — book equity (EV/EBITDA disabled because EBITDA ≤ 0)",
    }.get(routing_basis, "Asset-based — book equity (a downside floor beside the multiple)")

    # ── Football field ──────────────────────────────────────────────────
    football_field: List[Dict[str, Any]] = []

    # If asset_based is primary, lead with it. For CRE, expose the IP
    # markup range explicitly (1.2× to 1.5× book) — Bucharest commercial
    # market typically trades stabilized assets above depreciated book.
    # NAV bands are computed for EVERY industry — even manufacturers benefit
    # from seeing book equity as a downside floor. The variant logic only
    # differs in how the upper bound is set:
    #   · CRE w/ investment property: book + 20-50% IP markup (Bucharest mkt)
    #   · other asset-based primary:  ±15% sensitivity around book equity
    #   · non-asset-based primary:    ±15% sensitivity around book equity
    asset_based_low: Optional[float]
    asset_based_high: Optional[float]
    if asset_based_equity is None:
        asset_based_low = asset_based_high = None
        asset_based_subtitle = "Book equity refused: %s" % (
            (asset_based_refusal or {}).get("text_en") or "total equity is incomplete")
    elif is_cre and investment_property_book > 0:
        ip_adj_low = investment_property_book * 0.2   # +20% over book
        ip_adj_high = investment_property_book * 0.5  # +50% over book
        asset_based_low = round(asset_based_equity + ip_adj_low, 2)
        asset_based_high = round(asset_based_equity + ip_adj_high, 2)
        asset_based_subtitle = (
            f"Book equity {_fmt_ron(asset_based_equity)}; investment property "
            f"({_fmt_ron(investment_property_book)}) marked up to 1.2-1.5× book "
            f"= +{_fmt_ron(ip_adj_low)} to +{_fmt_ron(ip_adj_high)} adjustment."
        )
    else:
        asset_based_subtitle = (
            f"Book equity {_fmt_ron(asset_based_equity)} = total assets {_fmt_ron(total_assets)} "
            f"− total liabilities {_fmt_ron(total_assets - asset_based_equity)}. ±15% sensitivity."
        )
        asset_based_low = round(asset_based_equity * 0.85, 2)
        asset_based_high = round(asset_based_equity * 1.15, 2)

    # Always include NAV on the football field. It's primary for asset-heavy
    # industries (CRE, holdings) and a cross-check / downside floor for
    # operating businesses. Showing it for every customer prevents the
    # "where's NAV?" question that surfaced from a holding-company user.
    # A REFUSED book equity draws no bar (a bar at 0 is a value).
    if asset_based_low is not None and asset_based_high is not None:
        football_field.append({
            "method": "Asset-based — net asset value",
            "primary": primary_method == "asset_based",
            "low": asset_based_low,
            "mid": round((asset_based_low + asset_based_high) / 2, 2),
            "high": asset_based_high,
            "subtitle": asset_based_subtitle,
        })

    # Only include EV/EBITDA on the football field if it's the primary
    # method (not demoted). It still appears in the response payload so
    # the dashboard can show it as auditable detail under "All methods
    # considered", but it doesn't headline.
    if equity_ebitda_p25 is not None and primary_method == "ev_ebitda":
        football_field.append({
            "method": "EV / EBITDA (peers)",
            "primary": True,
            "low": equity_ebitda_p25,
            "mid": equity_ebitda_p50,
            "high": equity_ebitda_p75,
            "subtitle": f"{multiple_p25}× — {multiple_p50}× — {multiple_p75}×" if multiple_p25 else None,
        })
    # EV/Revenue is a useful cross-check for revenue-led businesses
    # (manufacturers, wholesale, services). It's NOT meaningful when the
    # primary method is asset-based (CRE) — the cash flows that justify a
    # revenue multiple aren't structurally present in a holding/property
    # company. Industry routing: include only when primary is EV/EBITDA or
    # EV/Revenue itself.
    if ev_rev_equity_p25 is not None and primary_method != "asset_based":
        football_field.append({
            "method": "EV / Revenue (peers)",
            "primary": False,
            "low": ev_rev_equity_p25,
            "mid": ev_rev_equity_p50,
            "high": ev_rev_equity_p75,
            "subtitle": f"{rev_p25}× — {rev_p50}× — {rev_p75}×" if rev_p25 else None,
        })
    # DCF is intentionally NOT appended to football_field for public display.
    # Romanian SMEs with 5-year noisy historicals produce WACC estimates that
    # vary widely and aren't defensible to a CFO. We still compute + persist
    # `dcf` on the response payload so future industries (e.g. growth-stage
    # SaaS) can opt back in without recomputing. The frontend's render layer
    # also filters DCF by method-name as defense in depth.

    if primary_method == "asset_based" and asset_based_equity is None:
        formula_text = asset_based_subtitle
    elif primary_method == "asset_based":
        formula_text = (
            f"Equity = Total assets ({_fmt_ron(total_assets)}) "
            f"− Debt ({_fmt_ron(total_debt_used)}) − Other liabilities "
            f"= Book equity ({_fmt_ron(asset_based_equity)})"
        )
    else:
        formula_text = (
            f"Equity = EBITDA ({_fmt_ron(ebitda_used_value)}) × Multiple ({multiple_p50}×) "
            f"− Debt ({_fmt_ron(total_debt_used)}) + Cash ({_fmt_ron(cash_used)})"
            if multiple_p50 is not None
            else "Insufficient benchmark data — manual multiple required."
        )

    # Methodology warnings — surfaced on the Valuation tab + briefing.
    method_warnings: List[str] = []
    if ebitda_refused:
        method_warnings.append(
            "EV/EBITDA is refused: EBITDA is refused for this period (%s). Primary method: "
            "asset-based (book equity)." % ((ebitda_refusal or {}).get("text_en") or "the stock "
                                              "variation could not be measured"))
    elif ebitda_unusable and routing_basis == "ebitda_not_positive":
        method_warnings.append(
            f"EV/EBITDA is mathematically undefined for a useful valuation when EBITDA "
            f"is negative or zero (EBITDA = {_fmt_ron(ebitda_used_value)}). "
            f"Primary method switched to asset-based (book equity)."
        )
    if margin_refused and not is_cre:
        refusal_text = (_mm.refusal_display(margin_verdict) or {}).get("en") or "margin not meaningful"
        method_warnings.append(
            "Valued on its assets, not on an earnings multiple (%s): the company's turnover is not "
            "what it does this period, so a multiple of its EBITDA would not value it." % refusal_text)
    if is_cre:
        method_warnings.append(
            "For commercial real estate, value derives from the property asset and "
            "NOI / cap rate, not from operating earnings. EV/EBITDA is not an appropriate "
            "primary method for this industry — using asset-based equity instead."
        )
    # Every DCF refusal is stated where the page lists method warnings, and
    # a declared cost-of-debt assumption is stated beside it.
    if asset_based_refusal is not None:
        method_warnings.append(
            "Asset-based value refused: %s." % (asset_based_refusal.get("text_en") or "total equity is incomplete"))
    for refusal in dcf["refusals"]:
        method_warnings.append(refusal["text"])
    wacc_components = dcf.get("wacc_components") or {}
    if wacc_components.get("kd_source") == "methodology_assumption" and not dcf["refusals"]:
        method_warnings.append(wacc_components["kd_note"])

    # ── Primary equity value + range — sourced from the right method ─────
    if primary_method == "asset_based" and asset_based_low is None:
        # The primary method's own figure is refused: no primary value.
        primary_equity_value = primary_equity_low = primary_equity_high = None
        primary_label = "Net asset value (book equity) — refused"
    elif primary_method == "asset_based":
        primary_equity_value = round((asset_based_low + asset_based_high) / 2, 2)
        primary_equity_low = asset_based_low
        primary_equity_high = asset_based_high
        primary_label = (
            "Net asset value (book equity + RE markup)" if is_cre
            else "Net asset value (book equity)"
        )
    else:
        primary_equity_value = equity_ebitda_p50
        primary_equity_low = equity_ebitda_p25
        primary_equity_high = equity_ebitda_p75
        primary_label = "EV / EBITDA (peer multiple)"

    return {
        "primary_method": primary_method,
        "primary_label": primary_label,
        "primary_equity_value": primary_equity_value,
        "primary_equity_low": primary_equity_low,
        "primary_equity_high": primary_equity_high,
        "method_warnings": method_warnings,
        # Asset-based payload (always computed; shown when primary)
        "asset_based_equity": asset_based_equity,
        "asset_based_label": asset_based_label,
        # Why the asset-based figure is absent (None beside a figure).
        "asset_based_refusal": asset_based_refusal,
        "total_assets_used": round(total_assets, 2),
        "total_equity_used": None if asset_based_refusal is not None else round(total_equity, 2),
        "is_cre_industry": is_cre,
        "ebitda_unusable": ebitda_unusable,
        # WHY the primary method is what it is — the company (sector, the
        # margin rule), never the sign of the EBITDA alone.
        "routing": {"basis": routing_basis, "margin_not_meaningful": margin_refused,
                    "is_cre_industry": is_cre},
        # Inputs (auditable). None when the one EBITDA is refused (never 0).
        "ebitda_used": None if ebitda_used is None else round(ebitda_used, 2),
        "revenue_used": round(revenue, 2),
        "total_debt_used": round(total_debt_used, 2),
        "cash_used": round(cash_used, 2),
        # EBITDA multiple primary
        "multiple_ebitda_p25": multiple_p25,
        "multiple_ebitda_p50": multiple_p50,
        "multiple_ebitda_p75": multiple_p75,
        "ev_ebitda_p25": ev_ebitda_p25,
        "ev_ebitda_p50": ev_ebitda_p50,
        "ev_ebitda_p75": ev_ebitda_p75,
        "equity_ebitda_p25": equity_ebitda_p25,
        "equity_ebitda_p50": equity_ebitda_p50,
        "equity_ebitda_p75": equity_ebitda_p75,
        # EV/Revenue cross-check
        "multiple_revenue_p25": rev_p25,
        "multiple_revenue_p50": rev_p50,
        "multiple_revenue_p75": rev_p75,
        "ev_revenue_equity_p25": ev_rev_equity_p25,
        "ev_revenue_equity_p50": ev_rev_equity_p50,
        "ev_revenue_equity_p75": ev_rev_equity_p75,
        # DCF cross-check
        "dcf_wacc": dcf["wacc"],
        "dcf_forecast_growth": dcf.get("forecast_growth"),
        "dcf_terminal_growth": dcf["terminal_growth"],
        "dcf_base_fcf": dcf.get("base_fcf"),
        "dcf_enterprise_value": dcf["enterprise_value"],
        "dcf_equity_value": dcf["equity_value"],
        "dcf_sensitivity_low": dcf["sensitivity_low"],
        "dcf_sensitivity_high": dcf["sensitivity_high"],
        # New: Romania-corrected WACC components + 3-scenario table for
        # the FE to render the methodology breakdown and the sensitivity
        # band (optimistic / central / conservative).
        "dcf_wacc_components": dcf.get("wacc_components"),
        "dcf_scenarios": dcf.get("scenarios"),
        # Every reason the DCF refused ([] when it computed): {code, inputs, text}.
        "dcf_refusals": dcf["refusals"],
        # FCF breakdown — the Valuation tab renders these tiles verbatim.
        # Real CapEx (CIP additions), NOT D&A. Statutory net income
        # (positive), NOT operational (negative). See spec rule 2.
        "fcf_breakdown": fcf_breakdown,
        # THE ONE EBITDA (the three legacy views are aliases of it, served
        # for readers that still name them), its definition and its refusal.
        "ebitda": None if ebitda_computed is None else round(ebitda_computed, 2),
        "ebitda_statutory": None if ebitda_computed is None else round(ebitda_computed, 2),
        "ebitda_operational": None if ebitda_computed is None else round(ebitda_computed, 2),
        "ebitda_operating_view": None if ebitda_computed is None else round(ebitda_computed, 2),
        "ebitda_definition": EBITDA_DEFINITION_REVISION,
        "ebitda_refusal": ebitda_refusal,
        # NAV cap-rate NOI proxy: EBITDA less the stock variation (net 711 is
        # capitalised production, not rental income); own work capitalised
        # (72x) stays as the NAV cascade has always read it.
        "noi_approximation": _noi_approximation(figures),
        # The user's saved override (when there is one): which EBITDA
        # definition it was typed under, flagged when not today's.
        "user_override_definition": override_definition_status(user_assumptions),
        # Quality + provenance
        "confidence": confidence,
        "multiples_source": (ebitda_bm or {}).get("source") if ebitda_bm else None,
        "multiples_as_of_date": (ebitda_bm or {}).get("as_of_date") if ebitda_bm else None,
        "industry_key_used": industry_used,
        "industry_key_requested": industry_requested,
        # Presentation
        "formula_text": formula_text,
        "football_field": football_field,
        # F1.j — echo back what overrides were applied (or NULL = engine
        # defaults). Lets the FE render "you used these inputs" alongside
        # the recomputed numbers, and lets the SPEC §11 schema fields
        # `property_market_value`, `annual_lease_expense`, `shares_outstanding`
        # round-trip even though the engine does not yet consume them.
        "overrides_applied": {
            "rf":                    overrides.get("rf"),
            "equity_risk_premium":   overrides.get("equity_risk_premium"),
            "beta":                  overrides.get("beta"),
            "forecast_years":        overrides.get("forecast_years"),
            "forecast_growth":       overrides.get("forecast_growth"),
            "terminal_growth":       overrides.get("terminal_growth"),
            "property_market_value": overrides.get("property_market_value"),
            "annual_lease_expense":  overrides.get("annual_lease_expense"),
            "shares_outstanding":    overrides.get("shares_outstanding"),
        },
    }


#: The NOI proxy's labels — served, never typed by a renderer.
NOI_LABEL = {"ro": "NOI (aproximare)", "en": "NOI (approximation)"}
NOI_NOTE = {
    "ro": "EBITDA minus variația stocurilor de produse (contul 711): producția stocată nu este venit din "
          "chirii; producția imobilizată (72x) rămâne inclusă.",
    "en": "EBITDA less the stock variation (Variația stocurilor de produse): production stocked is not "
          "rental income; own work capitalised (72x) stays in.",
}


def _noi_approximation(figures: Dict[str, Any]) -> Dict[str, Any]:
    """`{value, label, note, components}` — EBITDA − net 711, or a refusal
    (value None) when the one EBITDA is refused."""
    ebitda, net_711 = figures.get("ebitda"), figures.get("inventory_variation")
    value = None if ebitda is None or net_711 is None else round(ebitda - net_711, 2)
    return {
        "value": value,
        "label": dict(NOI_LABEL),
        "note": dict(NOI_NOTE),
        "components": {"ebitda": None if ebitda is None else round(ebitda, 2),
                       "inventory_variation": None if net_711 is None else round(net_711, 2),
                       "capitalized_own_work": figures.get("capitalized_own_work")},
        "refusal": figures.get("refusal") if value is None else None,
    }


# ── User-saved overrides and the EBITDA definition they were typed under ────

#: The flag served beside an override saved under an earlier definition.
PREVIOUS_DEFINITION_FLAG = {
    "ro": "salvat sub definiția anterioară a EBITDA",
    "en": "saved under the previous EBITDA definition",
}


#: The override fields a user types on the Valuation tab.
OVERRIDE_FIELDS: Tuple[str, ...] = ("ebitda_used", "multiple_used", "debt_used", "cash_used")


def override_definition_status(user_assumptions: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """For a saved override row: which EBITDA definition it was saved under
    and, when that is not today's (or unknown — every row saved before the
    stamp existed), the flag. None when there is no saved row or the row
    overrides nothing (a notes-only row). The override itself still
    applies: it is the user's figure; the flag says what it was typed
    against."""
    if not user_assumptions or all(user_assumptions.get(k) is None for k in OVERRIDE_FIELDS):
        return None
    stamped = user_assumptions.get("ebitda_definition")
    current = stamped == EBITDA_DEFINITION_REVISION
    return {
        "saved_under": stamped,
        "current_definition": EBITDA_DEFINITION_REVISION,
        "saved_under_previous_definition": not current,
        "flag": None if current else dict(PREVIOUS_DEFINITION_FLAG),
    }


# ─── A STORED valuations ROW is never the valuation's EBITDA ───────────────
#
# (critic, fixer round 1, 2026-09-27.) Production's `valuations` table holds
# rows the engine wrote under the PREVIOUS EBITDA definition (711 / 72x
# outside): 9507d2ee 54,534,488.97, ce72e080 54,443,833.33, the developer
# 06ffa6e8 -29,038,838.12 asset-based, … GET /api/period serves a FRESH
# recompute on the served statements; when that recompute failed (the
# benchmark table unreachable, any exception) `_serialize_valuation`
# served the stored row as it was — its old `ebitda_used`, its EV/EBITDA
# equity and `primary_method: ev_ebitda` — beside a P&L that served the
# one EBITDA, or even a REFUSED one; and the briefing regenerate route
# handed the same row to the narrator. The law: a stored row whose
# `ebitda_used` is not the served EBITDA (or the user's own typed
# override), or any stored row when the served EBITDA is refused, is never
# used as EBITDA and never makes EV/EBITDA primary.

#: Why a stored row cannot stand in (the served EBITDA is not refused).
STORED_ROW_OTHER_EBITDA = "valuation_row_other_ebitda"

_STORED_ROW_TEXT = {
    "ro": ("evaluarea salvată a fost calculată pe un alt EBITDA (%s) decât cel servit (%s) — "
           "definiția anterioară a EBITDA — și nu a putut fi recalculată acum"),
    "en": ("the stored valuation was computed on another EBITDA (%s) than the one served (%s) — "
           "the previous EBITDA definition — and could not be recomputed now"),
}

#: Every stored-row field computed ON the row's EBITDA.
_ROW_EBITDA_FIELDS = ("ebitda_used", "ev_ebitda_p25", "ev_ebitda_p50", "ev_ebitda_p75",
                      "equity_ebitda_p25", "equity_ebitda_p50", "equity_ebitda_p75",
                      "primary_equity_value", "primary_equity_low", "primary_equity_high",
                      "ebitda", "ebitda_statutory", "ebitda_operational", "ebitda_operating_view")


def row_benchmarks(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The peer multiples persisted beside a stored valuations row, in the
    shape `load_valuation_benchmarks` returns — benchmark data (a table
    read at the row's write time), never an EBITDA. None when the row
    carries no EV/EBITDA multiple."""
    if not row or _first(row.get("multiple_ebitda_p50")) is None:
        return None

    def band(prefix: str) -> Optional[Dict[str, Any]]:
        vals = [_first(row.get("%s_p%d" % (prefix, q))) for q in (25, 50, 75)]
        if vals[1] is None:
            return None
        return {"p25": vals[0], "p50": vals[1], "p75": vals[2],
                "source": row.get("multiples_source"), "as_of_date": row.get("multiples_as_of_date")}

    return {"industry_key_used": row.get("industry_key_used"),
            "industry_key_requested": row.get("industry_key_requested") or row.get("industry_key_used"),
            "ev_ebitda": band("multiple_ebitda"), "ev_revenue": band("multiple_revenue")}


def stored_row_refusal(row: Optional[Dict[str, Any]], statements: Optional[Dict[str, Any]],
                       user_assumptions: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Why a stored valuations row may NOT stand in for the valuation of
    these served statements, or None when it may.

    The served EBITDA REFUSED -> that refusal (`ebitda_refused` with the
    stock-variation cause): no stored figure stands in for it. Otherwise
    the row's `ebitda_used` must be the served EBITDA (half a cent), or the
    EBITDA the user typed (`user_assumptions.ebitda_used` — the user's
    figure, flagged by `override_definition_status` when typed under an
    earlier definition); anything else is `valuation_row_other_ebitda`.
    Statements with no assembled P&L carry no served EBITDA to compare:
    the row is refused there too (nothing says which definition it is)."""
    if not row:
        return None
    from engine.ratios.credit_model import operating_figures

    try:
        figures = operating_figures(statements or {})
    except (KeyError, TypeError, ValueError):
        figures = {"ebitda": None, "refusal": None}
    served = figures.get("ebitda")
    refusal = figures.get("refusal")
    row_ebitda = _first(row.get("ebitda_used"))
    typed = _first((user_assumptions or {}).get("ebitda_used"))
    # The user's typed EBITDA stands over a refusal, as it does in
    # `compute_valuation`: a row persisted on it is the user's figure.
    if row_ebitda is not None and typed is not None and abs(row_ebitda - typed) < 0.005:
        return None
    if refusal is not None:
        return dict(refusal)
    if row_ebitda is not None and served is not None and abs(row_ebitda - served) < 0.005:
        return None
    shown_row = _fmt_ron(row_ebitda) if row_ebitda is not None else "—"
    shown_served = _fmt_ron(served) if served is not None else "—"
    return {"code": "ebitda_refused", "cause": STORED_ROW_OTHER_EBITDA,
            "text_ro": _STORED_ROW_TEXT["ro"] % (shown_row, shown_served),
            "text_en": _STORED_ROW_TEXT["en"] % (shown_row, shown_served),
            "inputs": ["valuations.ebitda_used", "assembled_pl.ebitda"],
            "stored_ebitda_used": row_ebitda, "served_ebitda": served}


def lawful_stored_row(row: Optional[Dict[str, Any]], statements: Optional[Dict[str, Any]],
                      user_assumptions: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """The stored row as it may be SERVED when no recompute ran: unchanged
    when `stored_row_refusal` allows it; otherwise every figure computed on
    its EBITDA withheld (None), EV/EBITDA NOT primary, `ebitda_refusal`
    stating why, and every other method's figure withheld as well (they
    were written beside the same stale EBITDA, under the same earlier
    definition; nothing on the row says which inputs still hold). The
    peer multiples stay: benchmark data, not an EBITDA."""
    if not row:
        return row
    refusal = stored_row_refusal(row, statements, user_assumptions)
    if refusal is None:
        return row
    out = dict(row)
    for key in _ROW_EBITDA_FIELDS + ("ev_revenue_equity_p25", "ev_revenue_equity_p50",
                                     "ev_revenue_equity_p75", "dcf_enterprise_value",
                                     "dcf_equity_value", "dcf_sensitivity_low",
                                     "dcf_sensitivity_high"):
        if key in out or key in _ROW_EBITDA_FIELDS:
            out[key] = None
    out["primary_method"] = "refused"
    out["primary_label"] = "Valuation refused"
    out["ebitda_refusal"] = refusal
    out["stored_row_refusal"] = refusal
    out["method_warnings"] = ["Valuation refused: %s." % (refusal.get("text_en") or refusal.get("cause"))]
    out["formula_text"] = "Valuation refused: %s." % (refusal.get("text_en") or refusal.get("cause"))
    return out


def _fmt_ron(n: float) -> str:
    sign = "-" if n < 0 else ""
    a = abs(n)
    if a >= 1_000_000:
        return f"{sign}{a/1_000_000:.2f}M RON"
    if a >= 1_000:
        return f"{sign}{a/1_000:.0f}K RON"
    return f"{sign}{a:.0f} RON"


# ─── Persistence ────────────────────────────────────────────────────────────


def persist_valuation(period_id: str, org_id: str, result: Dict[str, Any]) -> None:
    """Upsert one valuations row per period. Idempotent — re-running the
    pipeline overwrites prior values."""
    row = {
        "period_id": period_id,
        "org_id": org_id,
        "primary_method": result["primary_method"],
        "ebitda_used": result["ebitda_used"],
        "revenue_used": result["revenue_used"],
        "total_debt_used": result["total_debt_used"],
        "cash_used": result["cash_used"],
        "multiple_ebitda_p25": result["multiple_ebitda_p25"],
        "multiple_ebitda_p50": result["multiple_ebitda_p50"],
        "multiple_ebitda_p75": result["multiple_ebitda_p75"],
        "ev_ebitda_p25": result["ev_ebitda_p25"],
        "ev_ebitda_p50": result["ev_ebitda_p50"],
        "ev_ebitda_p75": result["ev_ebitda_p75"],
        "equity_ebitda_p25": result["equity_ebitda_p25"],
        "equity_ebitda_p50": result["equity_ebitda_p50"],
        "equity_ebitda_p75": result["equity_ebitda_p75"],
        "multiple_revenue_p25": result["multiple_revenue_p25"],
        "multiple_revenue_p50": result["multiple_revenue_p50"],
        "multiple_revenue_p75": result["multiple_revenue_p75"],
        "ev_revenue_equity_p25": result["ev_revenue_equity_p25"],
        "ev_revenue_equity_p50": result["ev_revenue_equity_p50"],
        "ev_revenue_equity_p75": result["ev_revenue_equity_p75"],
        "dcf_wacc": result["dcf_wacc"],
        "dcf_terminal_growth": result["dcf_terminal_growth"],
        "dcf_enterprise_value": result["dcf_enterprise_value"],
        "dcf_equity_value": result["dcf_equity_value"],
        "dcf_sensitivity_low": result["dcf_sensitivity_low"],
        "dcf_sensitivity_high": result["dcf_sensitivity_high"],
        "confidence": result["confidence"],
        "multiples_source": result["multiples_source"],
        "multiples_as_of_date": result["multiples_as_of_date"],
    }
    with _supabase.admin() as client:
        client.upsert("valuations", row, on_conflict="period_id")
