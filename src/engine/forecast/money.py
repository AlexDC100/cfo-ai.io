"""Integer-cent arithmetic for the forecast. NO FLOAT EVER REACHES A TOTAL.

WHY INTEGERS, AND WHY THE DECISION MATTERS
==========================================
The projected balance sheet must close to ZERO for every period — not
"within tolerance and annotated". A float model cannot promise that:
each rate application (growth, margin, DSO, tax, interest) lands on a
value with no exact binary representation, and a 5-year plan with a
monthly year one applies a few hundred of them. The residuals do not
cancel; they accumulate, and the honest engineering answer is either
(a) carry a residual line and admit the statement does not balance, or
(b) never create a residual in the first place.

This module is (b). Every amount is an ``int`` number of cents. Every
rate is an ``int`` number of MICRO-UNITS (1_000_000 == 100.0000%), so a
rate application is integer multiply + integer divide with an explicit
rounding rule, and the rounded integer IS the fact — the same integer
flows into the cash-flow statement and into the balance sheet, so the
articulation between them is exact by construction rather than by luck.

There is no IEEE-754 arithmetic anywhere in the projection path, so the
result cannot vary with platform, libm version, or evaluation order.
Floats appear at exactly two boundaries, both one-way:
  · IN  — a caller may hand a rate as a float; ``micros_from`` converts
          it ONCE, deterministically, through ``str()`` (shortest
          round-trip repr) into an exact ``Fraction``.
  · OUT — ``to_float`` divides by 100 on the way to a renderer.

ROUNDING RULE: half away from zero, applied to the exact rational.
Chosen over banker's rounding because a projection is read beside a
statutory statement, where half-up is the convention a Romanian reader
and a bank credit officer expect; and over truncation because
truncation is biased and the bias compounds over sixteen periods.

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

from fractions import Fraction
from typing import Union

__all__ = [
    "MICRO",
    "MICRO_DAY",
    "Cents",
    "MicroDays",
    "Micros",
    "micro_days_from",
    "micros_from",
    "days_fmt",
    "days_to_float",
    "rate_to_float",
    "apply_rate",
    "mul_div",
    "to_float",
    "cents_from",
    "fmt",
]

#: One whole unit of a rate. 1_000_000 micro-units == 100%.
MICRO = 1000000

#: One whole DAY, in the same micro-unit resolution rates use. A working-
#: capital day count is stored as an int of these, never as a whole day:
#: rounding a day count to the nearest integer moves a balance-sheet line
#: by up to half a day of the flow that drives it, and TRUNCATING one
#: (which is what ``int(value)`` does to a caller's 0.5) can drive it to
#: zero — which liquidates the whole balance into cash and prints the
#: result as a plan. ``None`` is the model's refusal for "not measurable";
#: 0 must never be reachable by rounding, or the refusal and the
#: liquidation become the same value.
MICRO_DAY = 1000000

Cents = int
Micros = int
MicroDays = int


def mul_div(value: int, numerator: int, denominator: int) -> int:
    """``value * numerator / denominator``, rounded HALF AWAY FROM ZERO,
    in exact integer arithmetic. ``denominator`` must be positive."""
    if denominator <= 0:
        raise ValueError("denominator must be positive, got %r" % (denominator,))
    num = value * numerator
    if num >= 0:
        return (2 * num + denominator) // (2 * denominator)
    return -((-2 * num + denominator) // (2 * denominator))


def apply_rate(amount_cents: int, rate_micros: int) -> int:
    """A rate applied to a money amount, in cents, rounded once."""
    return mul_div(int(amount_cents), int(rate_micros), MICRO)


def _exact_fraction(value: Union[int, float, str, Fraction], noun: str,
                    allow_percent: bool) -> Fraction:
    """The ONE place a human-written quantity becomes an exact rational.

    Rates, money amounts and day counts all enter the model this way, so
    a caller's ``0.085`` cannot mean one thing on one line and another on
    the next. Floats go through ``str()`` — the shortest repr that
    round-trips — so 0.085 becomes exactly 85/1000 rather than the
    85.000000000000004 a binary multiply would produce.
    """
    if isinstance(value, bool):
        raise TypeError("%s is not a boolean" % (noun,))
    if isinstance(value, Fraction):
        return value
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError("%s is not a finite number: %r" % (noun, value))
        return Fraction(str(value))
    if isinstance(value, str):
        text = value.strip()
        if allow_percent and text.endswith("%"):
            return Fraction(text[:-1].strip()) / 100
        return Fraction(text)
    raise TypeError("cannot read %s from %r" % (noun, type(value).__name__))


def _scaled(frac: Fraction, scale: int) -> int:
    scaled = frac * scale
    return mul_div(scaled.numerator, 1, scaled.denominator)


def micros_from(value: Union[int, float, str, Fraction]) -> int:
    """A human-written rate (0.085, "8.5%", Fraction(17, 200)) as exact
    micro-units."""
    return _scaled(_exact_fraction(value, "a rate", True), MICRO)


def micro_days_from(value: Union[int, float, str, Fraction]) -> int:
    """A human-written day count (26, 1.1704, "26.5") as exact micro-days.

    Deliberately NOT ``int(value)``: truncation is a second, different
    rounding rule from the one the derivation uses, so an override and a
    derivation of the same quantity would disagree — and truncation is
    the rule that turns a sub-day driver into 0.
    """
    return _scaled(_exact_fraction(value, "a day count", False), MICRO_DAY)


def cents_from(value: Union[int, float, str, Fraction]) -> int:
    """A money amount (in whole currency units) as exact cents."""
    if isinstance(value, int) and not isinstance(value, bool):
        return value * 100
    return _scaled(_exact_fraction(value, "an amount", False), 100)


def days_to_float(micro_days: int) -> float:
    """Serialization boundary for a day count. Never fed back in."""
    return int(micro_days) / float(MICRO_DAY)


def days_fmt(micro_days: int) -> str:
    """Deterministic rendering of a day count, at the model's own
    resolution. Printed in the driver's own basis sentence so the stated
    derivation and the value the model used cannot disagree."""
    sign = "-" if micro_days < 0 else ""
    whole, frac = divmod(abs(int(micro_days)), MICRO_DAY)
    text = "%s%d.%06d" % (sign, whole, frac)
    text = text.rstrip("0")
    if text.endswith("."):
        text += "0"
    return text


def rate_to_float(rate_micros: int) -> float:
    """Serialization boundary for a rate. Never fed back into arithmetic."""
    return int(rate_micros) / float(MICRO)


def to_float(amount_cents: int) -> float:
    """Serialization boundary for money. Never fed back into arithmetic."""
    return int(amount_cents) / 100.0


def fmt(amount_cents: int) -> str:
    """Deterministic thousands-separated rendering of a cent amount."""
    sign = "-" if amount_cents < 0 else ""
    whole, frac = divmod(abs(int(amount_cents)), 100)
    return "%s%s.%02d" % (sign, format(whole, ","), frac)
