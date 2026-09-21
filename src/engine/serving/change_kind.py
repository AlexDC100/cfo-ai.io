"""THE ONE SIGN-FLIP CLASSIFIER (plan_contract_v2 section 7, R21; B1).

A change from a base value to a plan value is one of seven kinds:

  absent_base       the base is null (nothing to move from)
  absent_plan       the plan is null (nothing to move to)
  compared          both within the zero floor (delta 0, no percentage), or
                    both non-zero with the same sign (a percentage)
  from_zero         the base is within the floor, the plan is not
  to_zero           the plan is within the floor, the base is not
  flip_to_negative  base > 0 and plan < 0
  flip_to_positive  base < 0 and plan > 0

Only ``compared`` with a non-zero base carries ``delta_pct``: every other
kind renders in words beside the absolute change, never as a percent or a
multiplier. A profit of 6.1M becoming a loss of 107.6M is "turned
negative", not "-1,863%" and not "-19x" (defect 0.4).

ONE CLASSIFIER PER RUNTIME. frontend/lib/changeKind.ts is the TypeScript
twin; both are tested against tests/fixtures/contracts/change_kind_truth_table.json.
The two runtimes agree to the byte because both compute on the EXACT value
of their inputs (a binary64 is a dyadic rational; Fraction reads it
exactly, the TS twin decomposes it into BigInts), round once, half away
from zero, to packs/serving/change_kind.yaml#delta_pct_places.

This is orthogonal to the comparatives disclosure statuses: a column that
both periods reported is ``compared`` there and carries a change kind here.

Pure: no clock, no I/O except the one pack read, no global state beyond
that cached read.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
from functools import lru_cache
from numbers import Rational
from typing import Any, Optional, Tuple

import yaml

__all__ = [
    "COMPARED",
    "FLIP_TO_NEGATIVE",
    "FLIP_TO_POSITIVE",
    "FROM_ZERO",
    "TO_ZERO",
    "ABSENT_BASE",
    "ABSENT_PLAN",
    "KINDS",
    "WORD_KINDS",
    "ChangeKind",
    "ChangeKindPack",
    "ChangeKindPackError",
    "classify",
    "load_pack",
]

COMPARED = "compared"
FLIP_TO_NEGATIVE = "flip_to_negative"
FLIP_TO_POSITIVE = "flip_to_positive"
FROM_ZERO = "from_zero"
TO_ZERO = "to_zero"
ABSENT_BASE = "absent_base"
ABSENT_PLAN = "absent_plan"

#: The seven kinds of R21, in the order the contract lists them.
KINDS: Tuple[str, ...] = (COMPARED, FLIP_TO_NEGATIVE, FLIP_TO_POSITIVE,
                          FROM_ZERO, TO_ZERO, ABSENT_BASE, ABSENT_PLAN)
#: Every kind that renders as words and never as a percent or multiplier.
WORD_KINDS: Tuple[str, ...] = tuple(k for k in KINDS if k != COMPARED)

PACK_SCHEMA = "change_kind/1"


class ChangeKindPackError(RuntimeError):
    """packs/serving/change_kind.yaml is unusable. Never swallowed."""


@dataclass(frozen=True)
class ChangeKindPack:
    delta_pct_places: int
    #: Decimal string; the zero floor for rounded major-unit money.
    rounded_money_zero_floor: str


@dataclass(frozen=True)
class ChangeKind:
    kind: str
    #: Decimal string with ``delta_pct_places`` places, or None.
    delta_pct: Optional[str]


def _default_pack_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    return os.path.join(root, "packs", "serving", "change_kind.yaml")


def _parse_pack(raw: Any, where: str) -> ChangeKindPack:
    if not isinstance(raw, dict):
        raise ChangeKindPackError("%s: the pack must be a mapping" % where)
    if raw.get("schema") != PACK_SCHEMA:
        raise ChangeKindPackError("%s: schema is %r, expected %r"
                                  % (where, raw.get("schema"), PACK_SCHEMA))
    places = raw.get("delta_pct_places")
    if isinstance(places, bool) or not isinstance(places, int) or places < 0:
        raise ChangeKindPackError("%s: delta_pct_places must be a non-negative "
                                  "integer, got %r" % (where, places))
    floor = raw.get("rounded_money_zero_floor")
    if not isinstance(floor, str):
        raise ChangeKindPackError("%s: rounded_money_zero_floor must be a decimal "
                                  "string, got %r" % (where, floor))
    try:
        floor_value = Decimal(floor)
    except Exception:
        raise ChangeKindPackError("%s: rounded_money_zero_floor %r is not a decimal"
                                  % (where, floor))
    if not floor_value.is_finite() or floor_value < 0:
        raise ChangeKindPackError("%s: rounded_money_zero_floor %r must be finite "
                                  "and non-negative" % (where, floor))
    return ChangeKindPack(delta_pct_places=places, rounded_money_zero_floor=floor)


@lru_cache(maxsize=4)
def _load(path: str) -> ChangeKindPack:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh)
    except OSError as exc:
        raise ChangeKindPackError("cannot read %s: %s" % (path, exc))
    return _parse_pack(raw, path)


def load_pack(path: Optional[str] = None) -> ChangeKindPack:
    return _load(path or _default_pack_path())


def _exact(value: Any, name: str) -> Fraction:
    """The exact rational value of a number. A float is read bit for bit,
    so 0.1 is 3602879701896397/36028797018963968 — the same value the TS
    twin reconstructs from the same double."""
    if isinstance(value, bool):
        raise TypeError("%s must be a number, not a bool" % name)
    if isinstance(value, (int, Rational)):
        return Fraction(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError("%s must be finite, got %r" % (name, value))
        return Fraction(value)
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("%s must be finite, got %r" % (name, value))
        return Fraction(value)
    raise TypeError("%s must be a number, got %s" % (name, type(value).__name__))


def _render(ratio: Fraction, places: int) -> str:
    """Round once, half away from zero, to ``places`` places."""
    scaled = abs(ratio) * (10 ** places)
    whole, rem = divmod(scaled.numerator, scaled.denominator)
    if 2 * rem >= scaled.denominator:
        whole += 1
    digits = str(whole)
    if places:
        digits = digits.rjust(places + 1, "0")
        text = "%s.%s" % (digits[:-places], digits[-places:])
    else:
        text = digits
    if ratio < 0 and whole != 0:
        text = "-" + text
    return text


def classify(base: Any, plan: Any, zero_floor: Any,
             places: Optional[int] = None) -> ChangeKind:
    """Classify the change from ``base`` to ``plan``.

    ``zero_floor`` is 0 for integer minor units and comparatives'
    PCT_BASE_FLOOR for its rounded values. A value is within the floor when
    it is exactly zero or its magnitude is strictly below the floor (the
    comparatives rule, which a floor of 0 reduces to "is zero").
    ``places`` defaults to the pack's delta_pct_places.
    """
    floor = _exact(zero_floor, "zero_floor")
    if floor < 0:
        raise ValueError("zero_floor must be non-negative, got %r" % (zero_floor,))
    if base is None:
        return ChangeKind(ABSENT_BASE, None)
    if plan is None:
        return ChangeKind(ABSENT_PLAN, None)
    b = _exact(base, "base")
    p = _exact(plan, "plan")

    def within(x: Fraction) -> bool:
        return x == 0 or abs(x) < floor

    b_zero, p_zero = within(b), within(p)
    if b_zero and p_zero:
        return ChangeKind(COMPARED, None)
    if b_zero:
        return ChangeKind(FROM_ZERO, None)
    if p_zero:
        return ChangeKind(TO_ZERO, None)
    if b > 0 and p < 0:
        return ChangeKind(FLIP_TO_NEGATIVE, None)
    if b < 0 and p > 0:
        return ChangeKind(FLIP_TO_POSITIVE, None)
    if places is None:
        places = load_pack().delta_pct_places
    return ChangeKind(COMPARED, _render((p - b) / abs(b), places))
