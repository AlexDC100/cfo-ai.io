"""The shapes a forecast assumption is allowed to have.

THE ONE RULE THIS FILE EXISTS TO ENFORCE
========================================
Every number in this engine so far has been a FACT anchored to a source
cell. A driver is an ASSUMPTION. A :class:`Driver` therefore CANNOT BE
CONSTRUCTED WITHOUT ITS DERIVATION — there is no default, no `basis=""`
escape, and `Driver.basis` is generated from the derivation rather than
passed in. A reader who sees `8.2%` can always see `3-year CAGR of
revenue, FY2023-FY2025` next to it, because the type made it impossible
to emit one without the other.

STATUS IS A FIRST-CLASS FACT, NOT A FLAG
========================================
  ``derived``   measured from this company's own actuals.
  ``fallback``  a number is available, but it came from outside this
                company's history (a pack anchor) or from a source that
                declares itself an approximation. Usable, must be shown
                as what it is.
  ``absent``    ``value is None``. The served payload carries NO source.
                ABSENT != ZERO: a company with no debt has no interest
                rate, and 0% is a different claim.

Consumers must branch on all three. A consumer that reads ``.value`` and
treats ``None`` as ``0.0`` has reintroduced the exact defect this
codebase has already shipped twice.

No I/O. No network. No clocks. Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

__all__ = [
    "DerivationInput",
    "Derivation",
    "Driver",
    "AssumptionSet",
    "CaseSet",
    "STATUSES",
    "CASE_KINDS",
    "DriverError",
]


class DriverError(RuntimeError):
    """A driver could not be constructed honestly. Never swallowed."""


#: Ordered worst-to-best so a surface can sort by confidence.
STATUSES = ("absent", "fallback", "derived")

#: The render order of the three cases. Fixed, so two runs agree.
CASE_KINDS = ("base", "upside", "downside")


class DerivationInput(object):
    """One fact that went into a default, and WHERE it was read from.

    `authority` is the served-payload location, not a vague label. It is
    what makes a default auditable: a reader can open the same envelope
    and find the same cell.
    """

    __slots__ = ("name", "period", "value", "authority")

    def __init__(self, name, period, value, authority):
        # type: (str, str, Optional[float], str) -> None
        self.name = str(name)
        self.period = str(period)
        self.value = None if value is None else float(value)
        self.authority = str(authority)

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "name": self.name,
            "period": self.period,
            "value": None if self.value is None else round(self.value, 6),
            "authority": self.authority,
        }


class Derivation(object):
    """How a default was arrived at. Required on every driver."""

    __slots__ = ("method", "method_label", "periods_used", "inputs",
                 "source", "note")

    def __init__(self, method, method_label, periods_used, inputs,
                 source, note=""):
        # type: (str, str, Sequence[str], Sequence[DerivationInput], str, str) -> None
        if not method or not method_label:
            raise DriverError("a derivation needs a method and a label")
        if not source:
            raise DriverError("a derivation needs a source")
        self.method = str(method)
        self.method_label = str(method_label)
        #: Chronological. Never a set — set order is not deterministic and
        #: this tuple reaches the served output.
        self.periods_used = tuple(str(p) for p in periods_used)
        self.inputs = tuple(inputs)
        self.source = str(source)
        self.note = str(note or "")

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "method": self.method,
            "method_label": self.method_label,
            "periods_used": list(self.periods_used),
            "inputs": [i.as_dict() for i in self.inputs],
            "source": self.source,
            "note": self.note,
        }


class Driver(object):
    """One editable assumption, inseparable from the reason it holds that
    value."""

    __slots__ = ("key", "label", "unit", "kind", "favourable_direction",
                 "value", "status", "derivation", "case_rule", "why")

    def __init__(self, key, label, unit, kind, favourable_direction,
                 value, status, derivation, case_rule="hold", why=""):
        # type: (str, str, str, str, str, Optional[float], str, Derivation, str, str) -> None
        if status not in STATUSES:
            raise DriverError("unknown driver status: %r" % (status,))
        if not isinstance(derivation, Derivation):
            raise DriverError(
                "driver %r has no derivation; a default with no stated "
                "basis is a number someone will mistake for a fact" % (key,)
            )
        if status == "absent" and value is not None:
            raise DriverError(
                "driver %r is absent but carries a value" % (key,))
        if status != "absent" and value is None:
            raise DriverError(
                "driver %r has status %s but no value; ABSENT != ZERO, so "
                "say absent" % (key, status))
        self.key = str(key)
        self.label = str(label)
        self.unit = str(unit)
        self.kind = str(kind)
        self.favourable_direction = str(favourable_direction)
        self.value = None if value is None else float(value)
        self.status = str(status)
        self.derivation = derivation
        self.case_rule = str(case_rule)
        self.why = str(why or "")

    # ── the sentence the surface prints beside the number ──────────────

    @property
    def basis(self):
        # type: () -> str
        """THE RENDERED BASIS. Generated, never passed in — so it cannot
        drift from the derivation it describes.

        The owner's example reads `default 8.2% = 3-year CAGR`; this
        produces the right-hand side of it, with the periods named.
        """
        d = self.derivation
        parts = [d.method_label]
        # The period clause is rendered only when the derivation actually
        # CONSUMED values. An absent driver examined a period and read
        # nothing from it; "not derivable from this book, from 2025-12-31"
        # reads as though the date were the reason.
        if d.periods_used and d.inputs:
            if len(d.periods_used) == 1:
                parts.append("from %s" % d.periods_used[0])
            else:
                parts.append("over %s-%s" % (d.periods_used[0],
                                             d.periods_used[-1]))
        text = ", ".join(parts)
        if d.note:
            text = "%s. %s" % (text, d.note)
        return text

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "key": self.key,
            "label": self.label,
            "unit": self.unit,
            "kind": self.kind,
            "favourable_direction": self.favourable_direction,
            "value": self.value,
            "status": self.status,
            "basis": self.basis,
            "case_rule": self.case_rule,
            "why": self.why,
            "derivation": self.derivation.as_dict(),
        }


class AssumptionSet(object):
    """One full, self-contained set of assumptions: a case."""

    __slots__ = ("case_kind", "case_label", "case_basis", "_drivers", "_by_key")

    def __init__(self, case_kind, case_label, case_basis, drivers):
        # type: (str, str, str, Sequence[Driver]) -> None
        if case_kind not in CASE_KINDS:
            raise DriverError("unknown case kind: %r" % (case_kind,))
        self.case_kind = str(case_kind)
        self.case_label = str(case_label)
        #: One sentence saying how THIS case's numbers were arrived at.
        #: Empty is not allowed: a case with no stated construction is the
        #: "fixed +/-20% on every driver" gesture wearing a name.
        if not case_basis:
            raise DriverError("case %r has no stated basis" % (case_kind,))
        self.case_basis = str(case_basis)
        self._drivers = tuple(drivers)
        self._by_key = {}  # type: Dict[str, Driver]
        for d in self._drivers:
            self._by_key[d.key] = d

    @property
    def drivers(self):
        # type: () -> Tuple[Driver, ...]
        return self._drivers

    def driver(self, key):
        # type: (str) -> Optional[Driver]
        return self._by_key.get(key)

    def value(self, key):
        # type: (str) -> Optional[float]
        d = self._by_key.get(key)
        return None if d is None else d.value

    def requires_review(self):
        # type: () -> Tuple[str, ...]
        """Keys a surface must flag. Declaration order, not sorted — the
        render order is the pack's order and this follows it."""
        return tuple(d.key for d in self._drivers if d.status != "derived")

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "case_kind": self.case_kind,
            "case_label": self.case_label,
            "case_basis": self.case_basis,
            "requires_review": list(self.requires_review()),
            "drivers": [d.as_dict() for d in self._drivers],
        }


class CaseSet(object):
    """Base, upside and downside — comparable in one view because every
    case carries the full driver list, not a delta against base."""

    __slots__ = ("_cases", "provenance", "dispersion_method",
                 "dispersion_label", "dispersion_note")

    def __init__(self, cases, provenance, dispersion_method,
                 dispersion_label, dispersion_note=""):
        # type: (Sequence[AssumptionSet], Dict[str, Any], str, str, str) -> None
        self._cases = tuple(cases)
        got = tuple(c.case_kind for c in self._cases)
        if got != CASE_KINDS:
            raise DriverError(
                "a case set is exactly %r in that order, got %r"
                % (CASE_KINDS, got))
        self.provenance = provenance
        self.dispersion_method = str(dispersion_method)
        self.dispersion_label = str(dispersion_label)
        self.dispersion_note = str(dispersion_note or "")

    @property
    def cases(self):
        # type: () -> Tuple[AssumptionSet, ...]
        return self._cases

    def case(self, kind):
        # type: (str) -> Optional[AssumptionSet]
        for c in self._cases:
            if c.case_kind == kind:
                return c
        return None

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "schema_version": "forecast_drivers/1",
            "dispersion_method": self.dispersion_method,
            "dispersion_label": self.dispersion_label,
            "dispersion_note": self.dispersion_note,
            "provenance": self.provenance,
            "cases": [c.as_dict() for c in self._cases],
        }
