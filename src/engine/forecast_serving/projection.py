"""THE TYPES A PROJECTED FIGURE IS SERVED AS — and the ones it is NOT.

THE ONE RULE THIS FILE EXISTS TO ENFORCE
========================================
    No projected figure may be served through an accessor a consumer
    could mistake for an actual.

``engine.serving.facts.Fact`` is what an ACTUAL figure is served as. It
carries ``amount_minor``, ``currency`` and ``provenance`` — and its
provenance is ``{snapshot_id, line_id}``: the cell in the uploaded book
that the number came out of. Every consumer in this repo knows that
shape; several read ``.to_float()`` without looking at anything else.

:class:`ProjectedFigure` is deliberately NOT that shape, and deliberately
not duck-compatible with it:

  ``Fact``                       ``ProjectedFigure``
  ────────────────────────────   ─────────────────────────────────────
  ``.amount_minor``   (int)      ``.projected_minor``   (int)
  ``.to_float()``     (float)    ``.to_display()``      (float)
  ``.provenance``     (cell)     ``.basis``             (assumptions)
  no ``kind``                    ``.kind == "projection"``

The overlapping NAMES are the trap, so the overlapping names raise. Ask a
projection for ``.amount_minor``, ``.to_float()`` or ``.provenance`` and
you get :class:`ProjectedFigureMisuse` with a message that says which
accessor you wanted and why this object refuses it. An ``AttributeError``
would have done the structural job; a legible refusal also teaches, and
the reader of a stack trace at 2am is the person this rule protects.

WHY NOT JUST NAME THEM DIFFERENTLY AND TRUST THE AUTHOR
-------------------------------------------------------
Because that has already failed twice in this repo, in writing. The
``periodFacts.ts:278`` note and the D1 note in
``frontend/lib/__tests__/envelopeKeySpace.test.ts`` are both the same
defect: a lookup that "compiles clean and then MISSES on every lookup",
silently, for the life of the product. A distinction that only exists in
a name is a distinction that only exists until somebody is in a hurry.

ABSENT != ZERO
==============
A figure the projection does not carry is :class:`ProjectionRefusal`,
returned and never raised, carrying WHY and never carrying a number. A
refusal with a number in it is a partial answer, and a partial projected
figure is indistinguishable from a wrong one — the same reasoning as
:class:`engine.serving.facts.MarketRefusal`, which this mirrors on
purpose so the two read alike on a surface.

Python 3.9. No I/O, no network, no model, no clock.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

from .contract import ACTUAL_PROVENANCE_FIELDS

__all__ = [
    "AssumptionRef",
    "ProjectedFigure",
    "ProjectionRefusal",
    "ProjectedFigureMisuse",
    "PROJECTED_MARKER",
]

#: The data-level carrier of the distinction (F2/B3). Every serialized
#: projected figure carries it, every renderer must consume it, and the
#: serializer refuses to emit a figure without it. A CSS class is not a
#: distinction: the export renderer is different code, and four of five
#: known defects in this product lived in exactly that gap.
PROJECTED_MARKER = "projected"


class ProjectedFigureMisuse(TypeError):
    """A consumer reached for an ACTUAL-figure accessor on a projection.

    A ``TypeError`` and not a ``ValueError``: the object is the wrong
    KIND for what the caller is doing, which is a type error even in a
    language that will not check it for you.
    """


class AssumptionRef(object):
    """One driver, as the projection declares it — and the whole of what
    a projected figure resolves to.

    ``value`` is the driver's value FOR THE PERIOD of the figure that
    cites it, not the whole schedule: a reader looking at FY2026 revenue
    is owed the FY2026 growth rate, and handing them a dict of three
    years is handing them the work.

    ``basis`` is the stated reason the driver holds that value, in
    prose the projection's author wrote. It is mandatory
    (``contract.CLAUSE_ASSUMPTION_BASIS``) because a driver a reader
    cannot interrogate is a number with an opinion attached.

    ``derived_from`` names the ACTUAL facts the driver was fitted on.
    That is the only place in this namespace where a source reference is
    legitimate, and note what it references: the DRIVER's derivation, not
    the projected figure's value. The figure came from the driver; the
    driver came from history. Two hops, stated as two hops.
    """

    __slots__ = ("id", "label", "unit", "value", "basis", "derived_from")

    def __init__(self, id: str, label: str, unit: str,
                 value: Optional[float], basis: str,
                 derived_from: Sequence[str] = ()) -> None:
        self.id = str(id)
        self.label = str(label)
        self.unit = str(unit)
        self.value = value
        self.basis = str(basis)
        self.derived_from = tuple(str(x) for x in derived_from)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "unit": self.unit,
            "value": self.value,
            "basis": self.basis,
            "derived_from": list(self.derived_from),
        }

    def __repr__(self) -> str:  # pragma: no cover — debugging aid
        return "AssumptionRef(%s=%r %s)" % (self.id, self.value, self.unit)


class ProjectionRefusal(object):
    """The projection does not carry that figure, and says why.

    Returned, never raised. NEVER carries a number.
    """

    __slots__ = ("line", "period", "code", "detail")

    #: Stable codes. Surfaces group on them.
    NOT_PROJECTED = "not_projected"
    NO_ASSUMPTIONS = "no_assumptions_behind_it"
    OUTSIDE_HORIZON = "outside_horizon"

    def __init__(self, line: str, period: str, code: str,
                 detail: str = "") -> None:
        self.line = str(line)
        self.period = str(period)
        self.code = str(code)
        self.detail = str(detail)

    @property
    def refused(self) -> bool:
        return True

    def as_dict(self) -> Dict[str, Any]:
        return {
            PROJECTED_MARKER: True,
            "refused": True,
            "line": self.line,
            "period": self.period,
            "code": self.code,
            "detail": self.detail,
        }

    def __repr__(self) -> str:  # pragma: no cover — debugging aid
        return "ProjectionRefusal(%s/%s, %s)" % (self.line, self.period,
                                                 self.code)


class ProjectedFigure(object):
    """ONE projected number, and every assumption standing behind it.

    Constructed only by :class:`~engine.forecast_serving.gateway
    .ProjectionGateway`. Constructing one with an empty ``basis`` raises:
    F4 says a projected figure resolves to the assumptions that produced
    it, so a figure that resolves to nothing is not a figure this type
    will represent.
    """

    __slots__ = ("line", "period", "_projected_minor", "currency",
                 "_basis", "formula")

    #: The discriminant, on the object as well as on the wire, so a
    #: consumer holding an unknown object can ask rather than guess.
    kind = "projection"

    def __init__(self, line: str, period: str, projected_minor: int,
                 currency: str, basis: Sequence[AssumptionRef],
                 formula: str = "") -> None:
        basis = tuple(basis)
        if not basis:
            raise ProjectedFigureMisuse(
                "ProjectedFigure(%r/%r) was constructed with no assumptions "
                "behind it. A projected figure resolves to the assumptions "
                "that produced it (F4); one that resolves to nothing is a "
                "ProjectionRefusal, not a figure." % (line, period)
            )
        self.line = str(line)
        self.period = str(period)
        self._projected_minor = int(projected_minor)
        self.currency = str(currency)
        self._basis = basis
        self.formula = str(formula)

    # ── the projection's own accessors ───────────────────────────────

    @property
    def projected_minor(self) -> int:
        """Integer minor units. Named apart from ``Fact.amount_minor`` on
        purpose: a caller who wrote ``amount_minor`` was writing for an
        actual, and this object is not one."""
        return self._projected_minor

    @property
    def basis(self) -> Tuple[AssumptionRef, ...]:
        """Every assumption behind this figure. Never empty."""
        return self._basis

    def to_display(self) -> float:
        """Serialization boundary — the 2-decimal float a surface paints.
        The division happens HERE, once, on the way out."""
        return self._projected_minor / 100.0

    def as_dict(self) -> Dict[str, Any]:
        """The wire form. ``projected: True`` is the data-level carrier
        of the distinction (B3): it is not optional, it is not derived at
        render time, and every renderer — screen, PDF, XLSX, chat — has
        to consume the same field, because they all read this one dict.

        WHY THE AMOUNT AND THE ATTRIBUTION ARE EACH EMITTED TWICE
        --------------------------------------------------------
        Because the wire form has two jobs and they pull opposite ways.

        It has to be UNMISTAKABLE — ``amount_minor_projected`` is a name
        no actuals consumer has ever typed, and that is the whole reason
        it exists. And it has to be READABLE BY ITS OWN READERS, which
        speak the contract's input vocabulary: ``contract.py`` requires
        ``amount_minor`` and ``assumption_ids``, and
        ``frontend/lib/forecastFacts.ts`` resolves a basis from
        ``assumption_ids`` and nothing else.

        Wave 1 emitted only the first half, and it was measured:
        ``ProjectionGateway.from_payload(gateway.as_dict())`` RAISED
        ``ProjectionContractError`` on 30 clauses, and the real shipped
        ``readProjection`` turned all 15 served figures into
        ``{"projected":true,"refused":true,"code":
        "no_assumptions_behind_it"}`` — which ``ProjectedAmount``
        paints as an em-dash. Every projected figure on every surface
        would have rendered as "—" while the engine held the number and
        considered it served.

        So the dict is a SUPERSET, and every pair carries the identical
        value: ``amount_minor == amount_minor_projected``, and
        ``assumption_ids`` is exactly ``[a.id for a in basis]``, in the
        same order. One concept, one value — two names for it, both
        emitted from the one source, so they cannot disagree. The
        round-trip is gated on both sides
        (``test_the_wire_form_reads_back_through_its_own_gateway``,
        ``forecastFactsBoundary.test.ts``), because a shape nobody feeds
        back is a shape nobody has read.
        """
        return {
            PROJECTED_MARKER: True,
            "kind": self.kind,
            "line": self.line,
            "period": self.period,
            # The contract's name, so the payload reads back.
            "amount_minor": self._projected_minor,
            # The unmistakable name, so no actuals consumer reaches it by
            # habit. Same integer, from the same attribute.
            "amount_minor_projected": self._projected_minor,
            "currency": self.currency,
            "formula": self.formula,
            # The contract's name for the attribution: ids, in basis
            # order, derived from the basis rather than carried beside it.
            "assumption_ids": [a.id for a in self._basis],
            # The richer form the surfaces actually need: each driver
            # valued FOR THIS FIGURE'S PERIOD, with its stated basis. A
            # reader cannot get that by joining against the top-level
            # assumption list, which is period-less.
            "basis": [a.as_dict() for a in self._basis],
        }

    # ── the ACTUAL accessors, refused ────────────────────────────────
    #
    # Each of these is a real accessor on `engine.serving.facts.Fact`.
    # Leaving them undefined would raise AttributeError, which is already
    # structurally correct. Defining them to raise makes the refusal say
    # what happened, which is what a person reading the traceback needs.

    def _refuse(self, wanted: str, instead: str) -> "ProjectedFigureMisuse":
        return ProjectedFigureMisuse(
            "%s.%s is an ACTUAL-figure accessor and this is a projection "
            "(%s for %s). A projection has no source cell and no actual "
            "amount; use .%s. If you meant to read an actual, you are "
            "holding the wrong object — actuals come from "
            "engine.serving.facts.FactsGateway."
            % (type(self).__name__, wanted, self.line, self.period, instead)
        )

    @property
    def amount_minor(self) -> int:
        raise self._refuse("amount_minor", "projected_minor")

    @property
    def provenance(self) -> Dict[str, Any]:
        raise self._refuse("provenance", "basis")

    def to_float(self) -> float:
        raise self._refuse("to_float()", "to_display()")

    def __repr__(self) -> str:  # pragma: no cover — debugging aid
        return "ProjectedFigure(%s/%s, %d minor, %d assumption(s))" % (
            self.line, self.period, self._projected_minor, len(self._basis),
        )


def assumption_from_raw(raw: Dict[str, Any], period: str) -> AssumptionRef:
    """Build one :class:`AssumptionRef` for ``period`` from its fp1 form.

    A driver whose schedule does not name this period yields ``value=None``
    — ABSENT, not zero. The reader is shown that the driver exists and
    that its value for this year is not stated, which is a different fact
    from "the driver is 0%".
    """
    values = raw.get("values")
    value = None  # type: Optional[float]
    if isinstance(values, dict) and period in values:
        candidate = values.get(period)
        if isinstance(candidate, bool):
            value = None
        elif isinstance(candidate, (int, float)):
            as_float = float(candidate)
            value = as_float if as_float == as_float else None
    derived = raw.get("derived_from")
    return AssumptionRef(
        id=str(raw.get("id") or ""),
        label=str(raw.get("label") or raw.get("id") or ""),
        unit=str(raw.get("unit") or ""),
        value=value,
        basis=str(raw.get("basis") or ""),
        derived_from=[str(x) for x in derived] if isinstance(derived, (list, tuple)) else (),
    )


def actual_provenance_fields_in(obj: Any) -> List[str]:
    """Every ACTUAL-provenance field name found anywhere inside ``obj``.

    Used by the boundary guard, exported here so the list of what counts
    as "a source-cell affordance" is defined once
    (:data:`contract.ACTUAL_PROVENANCE_FIELDS`) and read by both.
    """
    found = []  # type: List[str]

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if str(key) in ACTUAL_PROVENANCE_FIELDS:
                    found.append(str(key))
                _walk(value)
        elif isinstance(node, (list, tuple)):
            for item in node:
                _walk(item)

    _walk(obj)
    return found
