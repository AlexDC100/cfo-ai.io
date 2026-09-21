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

from . import BLOCK_FIELD_CONSUMERS

__all__ = ["UNIT_WIRE", "build_client", "build_drivers"]

UNIT_WIRE = {"ratio": "ratio_micros", "days": "micro_days",
             "money": "money_minor", "index": "index_micros"}
EVIDENCE_OF_TIER = {"book": "book", "sector": "sector", "macro": "macro",
                    "convention": "convention"}


def _round(value: Fraction) -> int:
    """Half away from zero, in exact integer arithmetic (3.12)."""
    value = Fraction(value)
    n, d = value.numerator, value.denominator
    q, r = divmod(abs(n), d)
    if 2 * r >= d:
        q += 1
    return q if n >= 0 else -q


def _sentence(code: str, text: str) -> Dict[str, str]:
    return {"code": code, "text": text}


def _steps(assumption: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [{"tier": s["tier"], "outcome": s["outcome"],
             "reason": _sentence("%s_%s" % (s["tier"], s["outcome"]), s["reason"])}
            for s in assumption["fallback_steps"]]


def _basis(assumption: Dict[str, Any], tier: str, source: Optional[str],
           original: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """``assumption`` is the producer's pedigree record {key, exact, tier,
    rule_id, basis, evidence, fallback_steps}."""
    out = {"tier": tier,
           "sentence": _sentence(assumption["rule_id"] or assumption["key"],
                                 assumption["basis"]),
           "book": None, "sector": None, "macro": None, "convention": None,
           "fallback_steps": _steps(assumption), "original": original,
           "accepted_from_proposal": None, "source": source}  # type: Dict[str, Any]
    slot = EVIDENCE_OF_TIER.get(tier)
    if slot is not None:
        out[slot] = assumption["evidence"]
    return out


def build_drivers(request: Any, inputs: Dict[str, Any],
                  line_assumptions: Dict[str, Sequence[str]]) -> Dict[str, Dict[str, Any]]:
    """``inputs`` is ``engine.forecast.levers.serving_inputs(plan)``."""
    inert = inputs["inert"]
    prefix = inputs["fixed_share_prefix"]
    overrides = dict(request.overrides)
    behaviour = dict((prefix + b.pool, b) for b in request.behaviour_overrides)
    inert_text = inputs["pack"]["inert"]
    consumed = {}  # type: Dict[str, List[str]]
    for line, ids in line_assumptions.items():
        for i in ids:
            consumed.setdefault(i, []).append(line)
    out = {}  # type: Dict[str, Dict[str, Any]]
    for entry in inputs["registry"]:
        key = entry["key"]
        assumption = dict(inputs["pedigree"][key], key=key)
        length = request.total_years if entry["shape"] == "per_year" else 1
        default = assumption["exact"]
        values = [default] * length  # type: List[Optional[int]]
        tier, source, original = assumption["tier"], None, None
        scale = entry["scale"]
        if key in overrides and any(v is not None for v in overrides[key]):
            original = {"values": list(values),
                        "basis": _basis(assumption, assumption["tier"], None, None)}
            for i, v in enumerate(overrides[key][:length]):
                if v is not None:
                    values[i] = _round(Fraction(v) * scale)
            tier, source = "user", "override"
        elif key in behaviour and behaviour[key].fixed_share is not None:
            original = {"values": list(values),
                        "basis": _basis(assumption, assumption["tier"], None, None)}
            values = [_round(Fraction(behaviour[key].fixed_share) * scale)]
            tier, source = "user", "behaviour"
        label = key.replace("_", " ")
        sentence = None  # type: Optional[Dict[str, str]]
        if inert.get(key):
            text = inert_text.get(key)
            if text is None:
                text = inert_text["default"].format(label=label)
            sentence = _sentence("inert_in_this_plan", text)
        out[key] = {
            "key": key, "model_key": entry["model_key"], "pack_key": entry["pack_key"],
            "label": _sentence(key, label),
            "panel": entry["panel"], "rail_group": entry["rail_group"],
            "unit": UNIT_WIRE[entry["unit"]], "shape": entry["shape"],
            "granularity": entry["granularity"], "values": values,
            "set_via": entry["set_via"], "allowed_ops": list(entry["allowed_ops"]),
            "rail_op": entry["rail_op"],
            "bounds": {"min": _text(entry["bounds"][0]), "max": _text(entry["bounds"][1])},
            "reach_step": _text(entry["reach_step"]), "solve_step": _text(Fraction(1, scale)),
            "favourable_direction": entry["favourable_direction"],
            "consumed_by": consumed.get(key, []) + list(BLOCK_FIELD_CONSUMERS.get(key, ())),
            "inert_in_this_plan": sentence,
            "formula_id": (assumption["rule_id"]
                           if (assumption["rule_id"] or "").startswith("forecast.")
                           else None),
            "basis": _basis(assumption, tier, source, original),
            "alternatives": {
                "book": ({"values": [default] * length,
                          "basis": _basis(assumption, "book", None, None)}
                         if assumption["tier"] == "book" else None),
                "sector": None,
                "macro": ({"values": [default] * length,
                           "basis": _basis(assumption, "macro", None, None)}
                          if assumption["tier"] == "macro" else None)},
            "breakeven": entry["breakeven"],
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


def build_client(inputs: Dict[str, Any]) -> Dict[str, Any]:
    pack = inputs["pack"]
    return {"debounce_ms": pack["latency"]["debounce_ms"],
            "analysis_debounce_ms": pack["latency"]["analysis_debounce_ms"],
            "unserved": [{"key": key, "panel": None, "rail_group": None,
                          "sentence": _sentence(key, sentence)}
                         for key, sentence in pack["unserved"]]}
