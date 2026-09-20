"""DRIVER (plan_contract_v2 3.2), BASIS (3.3) and the client block (3.1).

Every driver is served ONCE per response, with its tier and exactly the
evidence that tier requires. The tier is the pedigree the engine stamped at
``put()`` (3.4); nothing here infers one from a sentence. A user layer
(override, behaviour override) keeps the resolved default as ``original``.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from fractions import Fraction
from typing import Any, Dict, List, Optional, Sequence, Tuple

from engine.forecast.errors import AssumptionError
from engine.forecast.levers_pack import plan_pack, serving_pack, index_neutral
from engine.forecast.money import MICRO, MICRO_DAY
from engine.forecast.pools import FIXED_SHARE_PREFIX

from . import BLOCK_FIELD_CONSUMERS

__all__ = ["UNIT_WIRE", "build_client", "build_drivers", "scale_of"]

UNIT_WIRE = {"ratio": "ratio_micros", "days": "micro_days",
             "money": "money_minor", "index": "index_micros"}
EVIDENCE_OF_TIER = {"book": "book", "sector": "sector", "macro": "macro",
                    "convention": "convention"}


def scale_of(unit: str) -> int:
    return {"ratio": MICRO, "index": MICRO, "days": MICRO_DAY, "money": 100}[unit]


def _round(value: Fraction) -> int:
    from engine.forecast.money import mul_div
    value = Fraction(value)
    return mul_div(value.numerator, 1, value.denominator)


def _sentence(code: str, text: str) -> Dict[str, str]:
    return {"code": code, "text": text}


def _steps(assumption: Any) -> List[Dict[str, Any]]:
    return [{"tier": s["tier"], "outcome": s["outcome"],
             "reason": _sentence("%s_%s" % (s["tier"], s["outcome"]), s["reason"])}
            for s in assumption.fallback_steps]


def _basis(assumption: Any, tier: str, source: Optional[str],
           original: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = {"tier": tier,
           "sentence": _sentence(assumption.rule_id or assumption.key, assumption.basis),
           "book": None, "sector": None, "macro": None, "convention": None,
           "fallback_steps": _steps(assumption), "original": original,
           "accepted_from_proposal": None, "source": source}  # type: Dict[str, Any]
    slot = EVIDENCE_OF_TIER.get(tier)
    if slot is not None:
        out[slot] = assumption.evidence
    return out


def _neutral_index(key: str) -> Any:
    """volume_index, price_index and input_price_index are not book drivers:
    their default is the pack's neutral rung (3.4)."""
    from engine.forecast.assumptions import Assumption
    rung = index_neutral()
    return Assumption(key, "ratio", MICRO, "engine_default", rung.sentence,
                      tier="convention", rule_id=rung.rule_id,
                      evidence={"rule_id": rung.rule_id, "pack_address": rung.rule_id,
                                "evidence": []})


def build_drivers(plan: Any, registry: Sequence[Tuple[str, Any]],
                  line_assumptions: Dict[str, Sequence[str]],
                  inert: Dict[str, bool]) -> Dict[str, Dict[str, Any]]:
    request = plan.request
    assumptions = plan.projection.assumptions
    overrides = dict(request.overrides)
    behaviour = dict((FIXED_SHARE_PREFIX + b.pool, b) for b in request.behaviour_overrides)
    serving = serving_pack()
    consumed = {}  # type: Dict[str, List[str]]
    for line, ids in line_assumptions.items():
        for i in ids:
            consumed.setdefault(i, []).append(line)
    out = {}  # type: Dict[str, Dict[str, Any]]
    for key, entry in registry:
        try:
            assumption = assumptions.get(key)
        except AssumptionError:
            assumption = _neutral_index(key)
        length = request.total_years if entry.shape == "per_year" else 1
        default = assumption.exact
        values = [default] * length  # type: List[Optional[int]]
        tier, source, original = assumption.tier, None, None
        scale = scale_of(entry.unit)
        if key in overrides and any(v is not None for v in overrides[key]):
            original = {"values": list(values),
                        "basis": _basis(assumption, assumption.tier, None, None)}
            for i, v in enumerate(overrides[key][:length]):
                if v is not None:
                    values[i] = _round(Fraction(v) * scale)
            tier, source = "user", "override"
        elif key in behaviour and behaviour[key].fixed_share is not None:
            original = {"values": list(values),
                        "basis": _basis(assumption, assumption.tier, None, None)}
            values = [_round(Fraction(behaviour[key].fixed_share) * scale)]
            tier, source = "user", "behaviour"
        label = key.replace("_", " ")
        sentence = None  # type: Optional[Dict[str, str]]
        if inert.get(key):
            text = serving.inert.get(key)
            if text is None:
                text = serving.inert["default"].format(label=label)
            sentence = _sentence("inert_in_this_plan", text)
        out[key] = {
            "key": key, "model_key": entry.model_key, "pack_key": entry.pack_key,
            "label": _sentence(key, label),
            "panel": entry.panel, "rail_group": entry.rail_group,
            "unit": UNIT_WIRE[entry.unit], "shape": entry.shape,
            "granularity": entry.granularity, "values": values,
            "set_via": entry.set_via, "allowed_ops": list(entry.allowed_ops),
            "rail_op": entry.rail_op,
            "bounds": {"min": _text(entry.bounds[0]), "max": _text(entry.bounds[1])},
            "reach_step": _text(entry.reach_step), "solve_step": _text(Fraction(1, scale)),
            "favourable_direction": entry.favourable_direction,
            "consumed_by": consumed.get(key, []) + list(BLOCK_FIELD_CONSUMERS.get(key, ())),
            "inert_in_this_plan": sentence,
            "formula_id": (assumption.rule_id if (assumption.rule_id or "").startswith("forecast.")
                           else None),
            "basis": _basis(assumption, tier, source, original),
            "alternatives": {
                "book": ({"values": [default] * length,
                          "basis": _basis(assumption, "book", None, None)}
                         if assumption.tier == "book" else None),
                "sector": None,
                "macro": ({"values": [default] * length,
                           "basis": _basis(assumption, "macro", None, None)}
                          if assumption.tier == "macro" else None)},
            "breakeven": (None if entry.breakeven is None else
                          {"ops": list(entry.breakeven["ops"]),
                           "metrics": list(entry.breakeven["metrics"])}),
        }
    return out


def _text(value: Optional[Fraction]) -> Optional[str]:
    """An exact rational as its shortest exact decimal string (3.12: no
    float anywhere in the body)."""
    if value is None:
        return None
    value = Fraction(value)
    sign = "-" if value < 0 else ""
    value = abs(value)
    digits = 0
    while (value * 10 ** digits).denominator != 1:
        digits += 1
        if digits > 18:
            return "%s%d/%d" % (sign, value.numerator, value.denominator)
    whole = value * 10 ** digits
    text = str(whole.numerator).rjust(digits + 1, "0")
    return sign + (text if digits == 0 else "%s.%s" % (text[:-digits], text[-digits:]))


def build_client() -> Dict[str, Any]:
    serving = serving_pack()
    return {"debounce_ms": serving.latency["debounce_ms"],
            "analysis_debounce_ms": serving.latency["analysis_debounce_ms"],
            "unserved": [{"key": key, "panel": None, "rail_group": None,
                          "sentence": _sentence(key, sentence)}
                         for key, sentence in plan_pack().unserved]}
