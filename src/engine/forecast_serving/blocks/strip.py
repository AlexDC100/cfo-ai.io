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
    periods = plan.projection.periods
    labels = [p.label for p in periods]
    last = periods[-1]
    fcf = sum(p.cf["cash_from_operating"] + p.cf["cash_from_investing"] for p in periods)
    cumulative = fig(fcf, "cf.cash_from_operating", labels, attribution,
                     cumulative_formula)
    for i in attribution.driver_ids("cf.cash_from_investing"):
        if i not in cumulative["driver_ids"]:
            cumulative["driver_ids"].append(i)
    gap = summary["peak_funding_gap"]
    return {
        "peak_funding_gap": (gap if "refused" in gap else
                             {"amount": gap, "period": summary["peak_funding_period"]}),
        "first_breach_period": {"refused": dict(not_served)},
        "cumulative_fcf": cumulative,
        "closing_cash": fig(last.bs["cash"], "bs.cash", [last.label], attribution,
                            formulas["bs.cash"]),
        "dcf_ev": {"refused": dict(not_served)},
    }
