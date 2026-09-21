"""strip (plan_contract_v2 3.9). first_breach_period (B8) and dcf_ev (B12)
are served as the pack's not-served refusal until their batches land.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from typing import Any, Dict

from .figures import Attribution
from .summary import fig

__all__ = ["build_strip"]


def build_strip(plan: Any, summary: Dict[str, Any], attribution: Attribution,
                formulas: Dict[str, str], not_served: Dict[str, str],
                cumulative_formula: str) -> Dict[str, Any]:
    projection = plan.projection
    periods = projection.periods
    gap = summary["peak_funding_gap"]
    out = {
        "peak_funding_gap": (gap if "refused" in gap else
                             {"amount": gap, "period": summary["peak_funding_period"]}),
        "first_breach_period": {"refused": dict(not_served)},
        "dcf_ev": {"refused": dict(not_served)},
    }  # type: Dict[str, Any]
    if projection.shortfall is not None or not periods:
        # 3.9 / 6.5: both headlines read the LAST horizon period. A partial
        # serve stops before it (possibly before the first period, so
        # ``periods`` may be empty): the cash of the last served month and
        # the fcf of the served months are truncated totals, never served.
        sentence = (projection.shortfall.sentence if projection.shortfall is not None
                    else not_served)
        out["cumulative_fcf"] = {"refused": dict(sentence)}
        out["closing_cash"] = {"refused": dict(sentence)}
        return out
    labels = [p.label for p in periods]
    last = periods[-1]
    fcf = sum(p.cf["cash_from_operating"] + p.cf["cash_from_investing"] for p in periods)
    cumulative = fig(fcf, "cf.cash_from_operating", labels, attribution,
                     cumulative_formula)
    for i in attribution.driver_ids("cf.cash_from_investing"):
        if i not in cumulative["driver_ids"]:
            cumulative["driver_ids"].append(i)
    out["cumulative_fcf"] = cumulative
    out["closing_cash"] = fig(last.bs["cash"], "bs.cash", [last.label], attribution,
                              formulas["bs.cash"])
    return out
