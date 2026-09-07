"""Measures — the ONLY place an insight's digits come from.

Every number a reader sees inside an insight is a `Measure` in that
insight's own list. The claim sentence is a TEMPLATE carrying
`{measure:key}` / `{money:key}` placeholders; rendering substitutes from
this list and from nowhere else. A template naming a key the detector did
not emit raises rather than printing a blank, because a claim with a hole
in it is worse than no claim.

That is the same discipline `engine.ai.numerals` imposes on model text,
applied to the deterministic text as well: the sentence and the figure
table cannot disagree, because the sentence is built out of the table.

ABSENT != ZERO: a Measure whose `value` is None renders as
"not reported". It never renders as 0 and it is never dropped.

Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Sequence

__all__ = ["Measure", "render_claim", "format_measure", "UNITS"]

UNITS = ("money", "ratio", "pct", "multiple", "days", "years", "count")


class Measure(object):
    __slots__ = ("key", "label", "value", "unit", "noun")

    def __init__(self, key: str, label: str, value: Optional[float],
                 unit: str, noun: str = "") -> None:
        if unit not in UNITS:
            raise ValueError("unknown measure unit %r (legal: %s)"
                             % (unit, ", ".join(UNITS)))
        self.key = key
        self.label = label
        self.value = None if value is None else float(value)
        self.unit = unit
        #: What a `count` counts. "3" is not a fact a reader can use;
        #: "3 accounts" is. Only `count` may carry one — every other unit
        #: already renders its own dimension.
        if noun and unit != "count":
            raise ValueError(
                "measure %r is a %s and may not carry a noun; only counts do"
                % (key, unit))
        self.noun = noun

    #: Serialisation precision, per unit.
    #:
    #: This is not cosmetic. `as_dict` is what reaches the frontend, and
    #: the frontend re-renders it with the same rules `format_measure`
    #: uses — so if serialisation rounds harder than rendering resolves,
    #: the two surfaces print DIFFERENT strings for one measure. Measured
    #: while building this: the realestate unclassified share is 6e-10,
    #: the engine's own claim printed "<0.0001%", and the serialized
    #: measure rounded to 0.0 and would have rendered "0.0%" on screen.
    #: Twelve decimals sits below the smallest share `_percent` can
    #: resolve (1e-6 as a ratio), so a round trip cannot change a render.
    _PRECISION = {"money": 2, "count": 2}
    _DEFAULT_PRECISION = 12

    def as_dict(self) -> Dict[str, Any]:
        value = self.value
        if value is not None:
            value = round(value, self._PRECISION.get(self.unit,
                                                     self._DEFAULT_PRECISION))
        out = {"key": self.key, "label": self.label, "value": value,
               "unit": self.unit}
        if self.noun:
            out["noun"] = self.noun
        return out


def _group(value: float, decimals: int) -> str:
    text = "{:,.{d}f}".format(value, d=decimals)
    return text


def _percent(pct: float) -> str:
    """SMALL IS NOT ZERO — the sibling of ABSENT IS NOT ZERO.

    Measured on the carniprod book, an unclassified balance of 15,750.23
    against 125.9M of assets is 0.0125% and printed as "0.0%", which a
    reader reads as "nothing". A share that is genuinely non-zero keeps
    widening its precision (to at most four decimals) until a significant
    digit survives; only a share that really is zero prints "0.0%"."""
    if pct == 0.0:
        return "0.0%"
    for decimals in (1, 2, 3, 4):
        text = _group(pct, decimals)
        if float(text.replace(",", "")) != 0.0:
            return "%s%%" % text
    return "%s0.0001%%" % ("<" if pct > 0 else ">-")


def format_measure(measure: Measure, currency: str) -> str:
    """The engine's own rendering of one measure. The frontend reader
    mirrors this byte-for-byte (`frontend/lib/insights.ts::formatMeasure`)
    so the screen and the printed export cannot render the same measure
    two different ways."""
    if measure.value is None:
        return "not reported"
    value = measure.value
    if measure.unit == "money":
        return "%s %s" % (str(currency).upper(), _group(value, 2))
    if measure.unit == "ratio":
        return _percent(value * 100.0)
    if measure.unit == "pct":
        return _percent(value)
    if measure.unit == "multiple":
        return "%s×" % _group(value, 2)
    if measure.unit == "days":
        return "%s days" % _group(value, 1)
    if measure.unit == "years":
        return "%s years" % _group(value, 1)
    text = _group(value, 0)
    if measure.noun:
        # "1 account" / "2 accounts" — the plural is the reader's word,
        # not a grammar engine's guess at every noun in the pack.
        noun = measure.noun
        if abs(value) != 1.0 and not noun.endswith("s"):
            noun = noun + "s"
        return "%s %s" % (text, noun)
    return text


_PLACEHOLDER = re.compile(r"\{(measure|money):([A-Za-z_][A-Za-z0-9_]*)\}")


def render_claim(template: str, measures: Sequence[Measure], currency: str,
                 detector_id: str = "") -> str:
    """Substitute `{measure:key}` / `{money:key}` from `measures`.

    `{money:key}` additionally asserts the measure is a money measure —
    so a template cannot silently print a ratio where a reader expects an
    amount and a currency."""
    index = {}  # type: Dict[str, Measure]
    for m in measures:
        index[m.key] = m

    def _sub(match):  # type: (Any) -> str
        kind, key = match.group(1), match.group(2)
        measure = index.get(key)
        if measure is None:
            raise KeyError(
                "detector %r claim names measure %r, which it does not emit; "
                "it emits: %s"
                % (detector_id or "?", key, ", ".join(sorted(index)) or "(none)")
            )
        if kind == "money" and measure.unit != "money":
            raise ValueError(
                "detector %r claim asks for {money:%s} but that measure is a "
                "%s" % (detector_id or "?", key, measure.unit)
            )
        return format_measure(measure, currency)

    return _PLACEHOLDER.sub(_sub, template)


def measures_as_dicts(measures: Iterable[Measure]) -> List[Dict[str, Any]]:
    return [m.as_dict() for m in measures]
