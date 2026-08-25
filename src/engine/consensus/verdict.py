"""THE THREE-LEG E9 PREDICATE — the single eligibility rule for a
``mechanical_mapped`` extraction to keep a BALANCED status.

    dual_map_full_consensus  AND  totals_row_exact  AND  movement_checks_pass

Every leg fails CLOSED: an unknown / absent / None leg is a failed leg.
The movement input arrives as a bool-or-None parameter — ``None`` means
"the movement checks could not be run", which is NOT a pass.

Pure and dependency-free by design: the pack-hosted status ladder
(``canonical_adapter``) and the serving presenter (``serving.status``)
both consult this module, so the predicate exists exactly once.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

#: Leg names — the wire vocabulary of ``consensus["legs"]``.
LEG_DUAL = "dual_map_full_consensus"
LEG_TOTALS = "totals_row_exact"
LEG_MOVEMENTS = "movement_checks_pass"
LEG_ORDER = (LEG_DUAL, LEG_TOTALS, LEG_MOVEMENTS)


def three_leg_verdict(
    *,
    dual_map_full_consensus: Any,
    totals_row_exact: Any,
    movement_checks_pass: Optional[bool],
) -> Dict[str, Any]:
    """Evaluate the E9 predicate.

    Returns ``{"legs": [{"leg", "pass"}...], "eligible_balanced": bool}``.
    ``movement_checks_pass`` is bool-or-None; None is recorded honestly
    on the leg (``"pass": None``) and FAILS the verdict (fail closed).
    """
    legs: List[Dict[str, Any]] = [
        {"leg": LEG_DUAL, "pass": bool(dual_map_full_consensus)},
        {"leg": LEG_TOTALS, "pass": bool(totals_row_exact)},
        {
            "leg": LEG_MOVEMENTS,
            "pass": (None if movement_checks_pass is None else bool(movement_checks_pass)),
        },
    ]
    eligible = all(leg["pass"] is True for leg in legs)
    return {"legs": legs, "eligible_balanced": eligible}


def eligible_from_block(consensus: Any) -> bool:
    """Fail-closed reader of a persisted consensus block.

    True ONLY when the block carries all three named legs and every one
    is exactly ``True``. Any malformed / partial / absent shape → False.
    Never raises.
    """
    try:
        if not isinstance(consensus, dict):
            return False
        legs = consensus.get("legs")
        if not isinstance(legs, list):
            return False
        seen: Dict[str, Any] = {}
        for leg in legs:
            if isinstance(leg, dict) and isinstance(leg.get("leg"), str):
                seen[leg["leg"]] = leg.get("pass")
        return all(seen.get(name) is True for name in LEG_ORDER)
    except Exception:  # noqa: BLE001 — fail closed, never raise
        return False
