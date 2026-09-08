"""THE PROJECTION GATEWAY - the only way to read a projected figure.

Mirrors :class:`engine.serving.facts.FactsGateway` in shape so the two
read alike, and is separate from it in every way that matters so a
consumer cannot hold one thinking it holds the other:

  * a different class, in a different package, built from a different
    payload, returning a different type (:class:`ProjectedFigure`, never
    :class:`engine.serving.facts.Fact`);
  * :meth:`from_payload` returns ``None`` for anything that is not a
    projection, and RAISES for a payload that claims to be one and is
    malformed. Silence for "not mine", noise for "mine and broken";
  * it will not construct from an object that also carries actual-figure
    containers (``contract.ACTUAL_FIGURE_CONTAINERS``). One object that
    both gateways accept is precisely the confusion this lane exists to
    prevent.

WHAT IT REFUSES TO SERVE
------------------------
A figure whose assumptions do not resolve. F4: an actual resolves to a
source cell, a projection resolves to the assumptions that produced it.
Where the assumptions do not resolve, the gateway returns
:class:`ProjectionRefusal` - WITHOUT a number. Serving the number and
omitting the basis would be the LACKS_SHOWS bucket of
``design_review/PROVENANCE_CENSUS.json``: "an affordance over a payload
with nothing behind it", which that gate already declares is never a
state to sit in.

DETERMINISM
-----------
Every ordering here is the payload's own declared order, or a sort on a
declared key. No ``set`` iteration reaches an output, no clock is read,
no ``hash()`` is called. Same payload, same bytes.

Python 3.9. No I/O, no network, no model.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple, Union

from . import contract
from .projection import (
    AssumptionRef,
    ProjectedFigure,
    ProjectionRefusal,
    assumption_from_raw,
)

__all__ = ["ProjectionGateway"]


class ProjectionGateway(object):
    """Typed accessors over ONE fp1 projection payload."""

    def __init__(self, payload: Dict[str, Any]) -> None:
        violations = contract.clause_violations(payload)
        if violations:
            raise contract.ProjectionContractError(violations)
        self._payload = payload
        self.currency = str(payload.get("currency"))
        self.contract_version = contract.CONTRACT_VERSION
        base = payload.get("base_period") or {}
        self.base_period_label = str(base.get("label") or "")
        #: The snapshot the projection stands on. A POINTER to an actual
        #: book, kept here at the projection level and deliberately NOT
        #: on any figure: the projection as a whole stands on a book; no
        #: single projected number came out of a cell in it.
        self.base_snapshot_id = (
            str(base.get("snapshot_id")) if base.get("snapshot_id") else None
        )
        self.horizon = tuple(str(h) for h in (payload.get("horizon") or ()))

        self._assumptions_raw = {}  # type: Dict[str, Dict[str, Any]]
        self._assumption_order = []  # type: List[str]
        for raw in (payload.get("assumptions") or []):
            aid = str(raw.get("id") or "")
            self._assumptions_raw[aid] = raw
            self._assumption_order.append(aid)

        self._figures_raw = {}  # type: Dict[Tuple[str, str], Dict[str, Any]]
        self._figure_order = []  # type: List[Tuple[str, str]]
        for raw in (payload.get("figures") or []):
            key = (str(raw.get("line") or ""), str(raw.get("period") or ""))
            self._figures_raw[key] = raw
            self._figure_order.append(key)

    # -- construction --------------------------------------------------

    @classmethod
    def from_payload(cls, payload: Any) -> "Optional[ProjectionGateway]":
        """A gateway, or ``None`` when ``payload`` is not a projection.

        ``None`` - not an exception - for a payload that never claimed to
        be one: a caller sweeping mixed objects should not have to catch
        anything. A payload that DOES claim ``kind == "projection"`` and
        breaks the contract raises, because that is a producer defect and
        swallowing it would serve half a projection.
        """
        if not isinstance(payload, dict) or payload.get("kind") != contract.KIND:
            return None
        return cls(payload)

    # -- the projected figures -----------------------------------------

    def figure(self, line: str, period: str
               ) -> Union[ProjectedFigure, ProjectionRefusal]:
        """One projected figure, or a refusal that carries no number."""
        line = str(line)
        period = str(period)
        if self.horizon and period not in self.horizon:
            return ProjectionRefusal(
                line, period, ProjectionRefusal.OUTSIDE_HORIZON,
                "the projection runs %s" % ", ".join(self.horizon),
            )
        raw = self._figures_raw.get((line, period))
        if raw is None:
            return ProjectionRefusal(
                line, period, ProjectionRefusal.NOT_PROJECTED,
                "this projection does not carry %r for %r" % (line, period),
            )
        basis = self._basis_for(raw, period)
        if not basis:
            return ProjectionRefusal(
                line, period, ProjectionRefusal.NO_ASSUMPTIONS,
                "the assumptions this figure names do not resolve, so the "
                "figure is not served",
            )
        return ProjectedFigure(
            line=line,
            period=period,
            projected_minor=int(raw.get("amount_minor")),
            currency=self.currency,
            basis=basis,
            formula=str(raw.get("formula") or ""),
        )

    def figures(self) -> List[Union[ProjectedFigure, ProjectionRefusal]]:
        """Every declared figure, in the payload's own declared order."""
        return [self.figure(line, period)
                for line, period in self._figure_order]

    def lines(self) -> Tuple[str, ...]:
        """Every projected line id, sorted - a stable, declared order that
        does not depend on dict or set iteration."""
        return tuple(sorted(set(line for line, _ in self._figure_order)))

    # -- the assumptions -----------------------------------------------

    def assumptions(self, period: Optional[str] = None) -> List[AssumptionRef]:
        """Every driver, in declared order, valued for ``period``.

        With no period the values are ``None`` - the drivers exist, their
        per-year values do not apply to "no year", and ABSENT != ZERO.
        """
        target = str(period) if period is not None else " "
        return [assumption_from_raw(self._assumptions_raw[aid], target)
                for aid in self._assumption_order]

    def declared_assumptions(self) -> List[Dict[str, Any]]:
        """Every driver as the payload DECLARES it — schedule included.

        :meth:`assumptions` answers "what is this driver worth in year
        X"; this answers "what did the payload say this driver is", which
        is the only form that survives serialization. The difference is
        the ``values`` map, and dropping it was measured: the wire form
        emitted ``AssumptionRef.as_dict()`` (one period-less ``value``),
        so a re-read of the served bytes gave ``value=None`` for every
        driver in every year while the payload it came from stated 0.08.
        ABSENT != ZERO cuts both ways — a schedule serialized away reads
        as ABSENT and is not.

        Normalized to the six fp1 keys rather than passed through, so a
        producer's private extras cannot ride out onto the wire and be
        mistaken for part of the contract.
        """
        out = []  # type: List[Dict[str, Any]]
        for aid in self._assumption_order:
            raw = self._assumptions_raw[aid]
            values = raw.get("values")
            derived = raw.get("derived_from")
            out.append({
                "id": aid,
                "label": str(raw.get("label") or aid),
                "unit": str(raw.get("unit") or ""),
                # The schedule, in the payload's own declared order.
                "values": (dict(values) if isinstance(values, dict) else {}),
                "basis": str(raw.get("basis") or ""),
                "derived_from": ([str(x) for x in derived]
                                 if isinstance(derived, (list, tuple)) else []),
            })
        return out

    def _basis_for(self, raw: Dict[str, Any], period: str) -> List[AssumptionRef]:
        out = []  # type: List[AssumptionRef]
        for aid in (raw.get("assumption_ids") or []):
            declared = self._assumptions_raw.get(str(aid))
            if declared is None:
                continue
            out.append(assumption_from_raw(declared, period))
        return out

    # -- the balance check, which is the whole product -----------------

    def balance_check(self) -> List[Dict[str, Any]]:
        """Per projected year: does the balance sheet close?

        A year that does not balance is a HARD ERROR, not a rounding
        note, so this reports the difference in integer minor units and
        the caller decides. ``balances`` is stated here rather than left
        to each caller's own comparison, because a threshold every caller
        re-invents is a threshold that disagrees with itself (TC-10).
        """
        out = []  # type: List[Dict[str, Any]]
        for raw in (self._payload.get("balance_check") or []):
            if not isinstance(raw, dict):
                continue
            diff = raw.get("difference_minor")
            diff_int = (int(diff) if isinstance(diff, int)
                        and not isinstance(diff, bool) else None)
            out.append({
                "period": str(raw.get("period") or ""),
                "difference_minor": diff_int,
                # Zero to the cent, or it does not balance. There is no
                # tolerance band: the projection is built in integer
                # minor units precisely so that this comparison is exact.
                "balances": diff_int == 0,
            })
        return out

    def unbalanced_periods(self) -> Tuple[str, ...]:
        """Every projected year whose balance sheet does not close, in
        horizon order. Empty is the only shippable state.

        Ordered by the declared horizon, never by set iteration - the
        same input has to produce the same bytes.
        """
        failing = set(row["period"] for row in self.balance_check()
                      if not row["balances"])
        return tuple(p for p in self.horizon if p in failing)

    # -- the wire form -------------------------------------------------

    def as_dict(self) -> Dict[str, Any]:
        """The serialized projection every renderer consumes.

        Every entry under ``figures`` carries ``projected: True`` - the
        data-level carrier of the distinction (B3). Renderers do not
        derive it, do not infer it from a route, and cannot forget it,
        because it is in the payload they are handed.

        IT READS BACK. This dict satisfies :func:`contract
        .clause_violations` and reconstructs through
        :meth:`from_payload`, and both halves of the gate feed it back
        rather than only inspecting it. Wave 1 did not: the Python suite
        called ``as_dict()`` seven times and never once fed it in, the
        TypeScript suite only ever handed ``readProjection`` a
        hand-written INPUT-shaped payload, and between the two of them
        the served shape was the one thing nobody read. It did not
        parse - measured, 30 broken clauses and 15 em-dashes.
        """
        return {
            "kind": contract.KIND,
            "contract": contract.CONTRACT_VERSION,
            "currency": self.currency,
            "base_period": {
                "label": self.base_period_label,
                "snapshot_id": self.base_snapshot_id,
            },
            "horizon": list(self.horizon),
            # The DECLARED drivers, schedules and all - not the
            # period-less refs. See `declared_assumptions`.
            "assumptions": self.declared_assumptions(),
            "figures": [f.as_dict() for f in self.figures()],
            "balance_check": self.balance_check(),
            "unbalanced_periods": list(self.unbalanced_periods()),
        }
