"""Materiality-scaled severity (R4).

THE RULE
========
A severity is never a verdict on an absolute figure. It is a verdict on a
SHARE: the magnitude the detector measured, divided by a basis taken from
the SAME company. 46,613.06 RON of unclassified balance is `high` on a
39.3M book and `medium` on a 125.9M one, and that difference is the whole
point — `tests/engine/test_insights_materiality.py` plants exactly that
delta on both books and reds if the two grade the same.

WHAT COMES BACK
===============
Never a bare level. `Verdict` carries the level, the basis it used, the
basis' VALUE, the materiality, and the LADDER it was read against — so the
renderer prints the cutoffs from the same table the verdict read (TC-10)
instead of restating them as prose that can drift.

WHEN THE BASIS IS ABSENT
========================
`info`, with `materiality: None` and a `why` that says the scale was
unavailable. Not `low`, which would be a claim that the magnitude is
small; not zero, which would be a claim it does not exist. A detector may
declare a `basis_fallback`, and when the fallback is what got used the
`why` sentence says so in the same breath as the verdict.

Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .book import Book
from .packdata import DetectorSpec

__all__ = ["Verdict", "grade"]


class Verdict(object):
    __slots__ = ("level", "basis", "basis_label", "basis_value", "magnitude",
                 "materiality", "bands", "why")

    def __init__(self, level: str, basis: str, basis_label: str,
                 basis_value: Optional[float], magnitude: Optional[float],
                 materiality: Optional[float], bands: List[Dict[str, Any]],
                 why: str) -> None:
        self.level = level
        self.basis = basis
        self.basis_label = basis_label
        self.basis_value = basis_value
        self.magnitude = magnitude
        self.materiality = materiality
        self.bands = bands
        self.why = why

    def as_dict(self) -> Dict[str, Any]:
        return {
            "level": self.level,
            "basis": self.basis,
            "basis_label": self.basis_label,
            "basis_value": _round(self.basis_value),
            "magnitude": _round(self.magnitude),
            "materiality": None if self.materiality is None
            else round(self.materiality, 6),
            "bands": self.bands,
            "why": self.why,
        }


def _round(value: Optional[float]) -> Optional[float]:
    return None if value is None else round(float(value), 2)


def grade(spec: DetectorSpec, book: Book, magnitude: Optional[float]) -> Verdict:
    """Grade `magnitude` on `spec`'s ladder, scaled to this book."""
    bands = spec.bands_as_dicts()

    if magnitude is None:
        return Verdict(
            "info", spec.basis, spec.basis_label, book.basis(spec.basis), None,
            None, bands,
            "%s could not be measured on this book, so no share of %s can be "
            "stated." % (spec.magnitude_label, spec.basis_label.lower()),
        )

    basis_name = spec.basis
    basis_label = spec.basis_label
    basis_value = book.basis(basis_name)
    fell_back = False
    if basis_value is None and spec.basis_fallback:
        fallback_value = book.basis(str(spec.basis_fallback))
        if fallback_value is not None:
            basis_name = str(spec.basis_fallback)
            basis_label = _FALLBACK_LABELS.get(basis_name, basis_name)
            basis_value = fallback_value
            fell_back = True

    if basis_value is None:
        return Verdict(
            "info", basis_name, basis_label, None, magnitude, None, bands,
            "%s is %s, but %s is not available on this book as a scale, so "
            "the finding is reported without a graded severity."
            % (spec.magnitude_label, "unavailable" if magnitude is None else
               "measured", spec.basis_label.lower()),
        )

    materiality = abs(magnitude) / basis_value
    level = "info"
    for band in spec.bands:
        if band.at_least is None or materiality >= band.at_least:
            level = band.level
            break

    why = spec.basis_why
    if fell_back:
        why = (
            "%s is not a usable scale on this book, so the finding is graded "
            "against %s instead. %s"
            % (spec.basis_label.lower(), basis_label.lower(), why)
        )
    return Verdict(level, basis_name, basis_label, basis_value, magnitude,
                   materiality, bands, why)


#: Labels for the fallback bases, so a fallback verdict never prints the
#: raw key at a reader.
_FALLBACK_LABELS = {
    "revenue": "Revenue",
    "total_assets": "Total assets",
    "total_equity": "Total equity",
    "ebitda": "EBITDA (absolute)",
    "ebitda_positive": "EBITDA",
    "gross_ppe": "Gross PP&E",
    "total_current_liabilities": "Total current liabilities",
    "reconstructed_net_income": "Reconstructed net income",
}
