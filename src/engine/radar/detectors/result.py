"""WHAT A DETECTOR HANDS BACK.

A family measures; it does not decide whether it fired, and it never
writes a sentence. It returns a :class:`DetectorResult` carrying the
observable, the parameter it was compared against, the QUANTIFIED
consequence, the atoms it read and a deterministic one-line reason. The
builder turns that into a ``_finding.Finding``; the runner records it on
the checks list whether it fired or not, so a quiet book answers with the
list of what was examined rather than with silence.

A RESULT WITHOUT A QUANTIFIED IMPACT IS NOT A FINDING. ``fired=True`` with
``impact=None`` is refused by :meth:`DetectorResult.__post_init__` — the
whole point of Radar is that "something looks odd" never reaches a reader.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from engine.api import _finding as F


class UnquantifiedFindingError(ValueError):
    """A family said a rule fired and could not say what it costs."""


@dataclass(frozen=True)
class MeasuredFigure:
    """A number destined for the finding's evidence. ``fact`` is the key
    it also appears under in ``facts``, which is what lets the renderer
    bind the printed token to a typed placeholder instead of leaving raw
    digits in the prose."""

    fact: str
    value: float
    unit: str
    label: str


@dataclass(frozen=True)
class DetectorResult:
    """One detector's reading of one book (or one series)."""

    detector_id: str
    family: str
    #: Did the rule fire? A result that ran and did not fire still carries
    #: its observed value — that is what makes "All checks" complete.
    fired: bool
    #: Could it run at all? False means an input was ABSENT, and
    #: ``na_reason`` says which.
    applicable: bool = True
    na_reason: str = ""

    observed: float = 0.0
    observed_unit: str = F.UNIT_RATIO
    parameter: str = ""
    parameter_label: str = ""
    parameter_source: str = ""
    comparator: str = ">="
    limit: float = 0.0

    accounts: Tuple[Tuple[str, str], ...] = ()
    periods: Tuple[str, ...] = ()
    atom_ids: Tuple[str, ...] = ()
    figures: Tuple[MeasuredFigure, ...] = ()
    facts: Dict[str, float] = field(default_factory=dict)
    impact: Optional["F.Impact"] = None

    basis_kind: str = "profile_threshold"
    basis_description: str = ""
    basis_value: Optional[float] = None
    basis_unit: Optional[str] = None

    #: The deterministic one-line reason. No adjectives, no model, no
    #: clock — the same inputs always produce the same string.
    reason: str = ""
    tokens: Dict[str, str] = field(default_factory=dict)
    caveats: Tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.fired and self.impact is None:
            raise UnquantifiedFindingError(
                "%s fired with no impact. A detector that cannot say what the "
                "finding costs — a recomputed ratio or an amount — is not "
                "finished; 'something looks odd' is the noise Radar exists to "
                "remove." % self.detector_id)
        if self.fired and not self.reason.strip():
            raise UnquantifiedFindingError(
                "%s fired with no reason line" % self.detector_id)
        if self.fired and self.impact is not None:
            self._refuse_tautological_impact()

    def _refuse_tautological_impact(self) -> None:
        """An impact whose two endpoints PRINT THE SAME is not a
        consequence, it is a sentence that says nothing twice.

        The check is against the renderer rather than against a tolerance,
        because the reader's question is "what changed?" and the reader
        only ever sees `Impact.render`'s output. A verifier caught a HIGH
        finding surfacing as "moves from 0.0% to 0.0% (-0.0%)" — the
        endpoints were not bit-identical, so an `==` guard would have
        passed it straight through, and the reader would still have been
        handed a cost of nothing beside a severity that demands action.
        Whatever the unit rounds away is, by construction, exactly what
        the reader cannot see."""
        impact = self.impact
        assert impact is not None  # narrowed by the caller
        currency = impact.currency or ""
        before = F._format_value(impact.baseline, impact.unit, currency)
        after = F._format_value(impact.adjusted, impact.unit, currency)
        if before == after:
            raise UnquantifiedFindingError(
                "%s fired with an impact that prints as %r on both sides "
                "(%s: baseline=%r adjusted=%r delta=%r). A finding whose "
                "quantified consequence renders 'moves from X to X' costs the "
                "reader attention and returns nothing — it is the shape of "
                "noise Radar exists to remove. Either the detector fired on a "
                "movement too small for its own unit to show, or the impact "
                "measures the wrong pair of endpoints."
                % (self.detector_id, before, impact.metric,
                   impact.baseline, impact.adjusted, impact.delta))

    def scope_codes(self) -> Tuple[str, ...]:
        return tuple(code for code, _name in self.accounts)


def na(detector_id: str, family: str, reason: str,
       accounts: Tuple[Tuple[str, str], ...] = (),
       periods: Tuple[str, ...] = ()) -> DetectorResult:
    """NOT APPLICABLE, with the reason spelled out. 'We could not measure
    this' and 'we measured this and it was fine' are different claims and
    only one of them may look like silence."""
    return DetectorResult(detector_id=detector_id, family=family, fired=False,
                          applicable=False, na_reason=reason,
                          accounts=accounts, periods=periods,
                          reason=reason)


__all__ = ["DetectorResult", "MeasuredFigure", "UnquantifiedFindingError", "na"]
