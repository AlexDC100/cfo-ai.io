"""summary (3.8) and strip (3.9 lives in strip.py): the funding-line facts of
the served run, figure-shaped. Every amount is read off the projected
periods the figures block serves.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .figures import Attribution

__all__ = ["build_summary", "fig"]


def fig(amount: int, line: str, labels: List[str], attribution: Attribution,
        formula: str) -> Dict[str, Any]:
    # The levers that reach any period the amount is read over. A summary
    # amount is a selection or a sum over those periods, so this is the
    # union; B8's verdict slots re-test it by removal.
    lever_ids = []  # type: List[str]
    joint = False
    for label in labels:
        ids, j = attribution.lever_ids(line, label)
        joint = joint or j
        for i in ids:
            if i not in lever_ids:
                lever_ids.append(i)
    return {"amount_minor": amount, "driver_ids": attribution.driver_ids(line),
            "lever_ids": lever_ids, "joint": joint, "formula": formula}


def build_summary(plan: Any, attribution: Attribution, formulas: Dict[str, str],
                  rate_sentence: Dict[str, str]) -> Dict[str, Any]:
    projection = plan.projection
    periods = projection.periods
    labels = [p.label for p in periods]
    refusal = projection.shortfall
    first = plan.summary["first_shortfall_period"]
    first_amount = plan.summary["first_shortfall_amount_minor"]
    out = {
        "first_shortfall_period": first,
        "first_shortfall_amount": (
            None if first is None else
            fig(first_amount, "cf.funding_line_movement",
                [first] if first in labels else [], attribution,
                formulas["cf.funding_line_movement"])),
        "funding_rate_basis": {"driver_key": "revolver_rate",
                               "sentence": dict(rate_sentence)},
        "funding_gap_periods": [p.label for p in periods if p.bs["revolver"] > 0],
        "runway": plan.runway,
    }  # type: Dict[str, Any]
    if refusal is not None:
        sentence = dict(refusal.sentence)
        out["peak_funding_gap"] = {"refused": sentence}
        out["peak_funding_period"] = None
        out["funding_interest_total"] = {"refused": dict(sentence)}
    else:
        peak = max([0] + [p.bs["revolver"] for p in periods])
        peak_period = None  # type: Optional[str]
        for p in periods:
            if peak > 0 and p.bs["revolver"] == peak:
                peak_period = p.label
                break
        out["peak_funding_gap"] = fig(
            peak, "bs.revolver", [peak_period] if peak_period else labels,
            attribution, formulas["bs.revolver"])
        out["peak_funding_period"] = peak_period
        out["funding_interest_total"] = fig(
            sum(-p.pl["interest_expense_funding_line"] for p in periods),
            "pl.interest_expense_funding_line", labels, attribution,
            formulas["pl.interest_expense_funding_line"])
    trough = min(periods, key=lambda p: (p.bs["cash"], p.period.index)) if periods else None
    out["cash_trough"] = (None if trough is None else {
        "period": trough.label,
        "amount": fig(trough.bs["cash"], "bs.cash", [trough.label], attribution,
                      formulas["bs.cash"])})
    return out
