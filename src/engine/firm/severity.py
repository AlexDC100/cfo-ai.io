"""SEVERITY = f(kind weight, materiality for THAT client, days to deadline,
persistence) — every factor a number the payload shows.

The ladder and every step live in packs/firm/attention.yaml
(``severity:``). This module walks the ladder; it never decides how
far a step is. Materiality is the ranker's own verdict
(:func:`engine.api._finding_rank.assess_materiality`) taken against the
client's OWN basis; when the basis is absent the policy REFUSES and the
grade is capped and marked, never defaulted.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

from ._deps import finding_rank as R
from .pack import DeadlineBand, KindSpec, SeverityPolicy


@dataclass(frozen=True)
class Graded:
    severity: str
    breakdown: Dict[str, Any]


def band_for(bands: Tuple[DeadlineBand, ...], days: int) -> DeadlineBand:
    """First band whose ``max_days`` covers ``days``; the last band is
    open-ended by construction (the pack loader refuses otherwise)."""
    for band in bands:
        if band.max_days is None or days <= band.max_days:
            return band
    return bands[-1]


def materiality_step(policy: SeverityPolicy,
                     verdict: Optional["R.MaterialityVerdict"]) -> Tuple[int, str]:
    if verdict is None:
        return 0, "not graded"
    if verdict.tier == R.TIER_MATERIAL:
        floor = max(float(verdict.floor), 1e-12)
        if float(verdict.share) >= floor * float(policy.saturation_multiple):
            return int(policy.materiality_steps["saturated"]), "saturated"
        return int(policy.materiality_steps[R.TIER_MATERIAL]), R.TIER_MATERIAL
    return int(policy.materiality_steps.get(verdict.tier, 0)), verdict.tier


def grade(spec: KindSpec, policy: SeverityPolicy,
          materiality: Optional["R.MaterialityVerdict"] = None,
          materiality_refusal: Optional[str] = None,
          days_to_due: Optional[int] = None,
          days_over_budget: Optional[int] = None,
          persistence: int = 1,
          extra_steps: Optional[Dict[str, int]] = None) -> Graded:
    """Walk the ladder from the kind's base rung.

    ``days_to_due`` applies when the kind escalates on a deadline;
    ``days_over_budget`` when it escalates on age. ``extra_steps`` are
    detector-declared, labelled moves (a breach, a positive-but-thin
    net-asset position) so the breakdown names every move.

    The index is clamped to the ladder AFTER EVERY move, not once at the
    end: a move above the top rung is spent, not banked. Otherwise a
    saturated critical (+1, off the ladder) followed by a detector's
    -1 would net to critical — and a thin-but-positive net-asset
    position would grade the same as a negative one.
    """
    top = len(policy.ladder) - 1

    def _clamped(i: int) -> int:
        return max(0, min(top, i))

    index = policy.index(spec.base_severity)
    breakdown = {"base": spec.base_severity}  # type: Dict[str, Any]

    step, tier = materiality_step(policy, materiality)
    if materiality is not None:
        breakdown["materiality"] = {"tier": tier, "step": step,
                                    "share": float(materiality.share),
                                    "floor": float(materiality.floor)}
        index = _clamped(index + step)
    elif materiality_refusal:
        cap = policy.index(policy.refused_cap)
        breakdown["materiality"] = {"tier": "refused", "step": 0,
                                    "cap": policy.refused_cap,
                                    "reason": materiality_refusal}
        index = min(index, cap)

    if spec.escalates_on == "deadline" and days_to_due is not None:
        band = band_for(policy.deadline_bands, int(days_to_due))
        breakdown["deadline"] = {"days_to_due": int(days_to_due),
                                 "band": band.label, "step": band.step}
        index = _clamped(index + band.step)
    if spec.escalates_on == "age" and days_over_budget is not None:
        band = band_for(policy.age_bands, int(days_over_budget))
        breakdown["age"] = {"days_over_budget": int(days_over_budget),
                            "band": band.label, "step": band.step}
        index = _clamped(index + band.step)

    if int(persistence) >= int(policy.persistence_min):
        breakdown["persistence"] = {"consecutive": int(persistence),
                                    "step": int(policy.persistence_step)}
        index = _clamped(index + int(policy.persistence_step))
    else:
        breakdown["persistence"] = {"consecutive": int(persistence), "step": 0}

    for label, move in sorted((extra_steps or {}).items()):
        breakdown[label] = {"step": int(move)}
        index = _clamped(index + int(move))

    severity = policy.clamp(index)
    breakdown["result"] = severity
    return Graded(severity=severity, breakdown=breakdown)


def assess(policy: "R.MaterialityPolicy", basis_id: str, basis_label: str,
           basis_value: Optional[float], amount: float, currency: str
           ) -> Tuple[Optional["R.MaterialityVerdict"], Optional[str]]:
    """The ranker's materiality verdict, or the refusal it raised. A
    refusal is returned as TEXT so the item can carry it; it is never
    turned into a default tier."""
    try:
        return R.assess_materiality(policy, basis_id, basis_label, basis_value,
                                    amount, currency), None
    except R.MaterialityBasisMissing as exc:
        return None, str(exc)


__all__ = ["Graded", "assess", "band_for", "grade", "materiality_step"]
