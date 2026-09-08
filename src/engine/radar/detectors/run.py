"""THE RUNNER — pack rows in, findings and checks out.

It does four things and refuses to do a fifth:

  GATE      cold start is enforced HERE and declared in the pack. Under
            :data:`~engine.radar.detectors.pack.COLD_START_MIN_PERIODS`
            periods only ``single_period_valid`` detectors run, every
            other one is recorded as WAITING with the history it needs,
            and nothing in the output claims a trend. The rule cannot be
            forgotten by a new detector because the loader refuses a row
            that does not answer the question.
  RUN       each declared detector through the family its row names, in
            PACK ORDER. A family this build does not carry is a refusal,
            not a skip.
  DRESS     a fired result becomes a ``_finding.Finding``; the Finding
            decides for itself whether it may be surfaced. One that
            cannot is DEMOTED with the missing elements named — never
            dropped, never patched up.
  RECORD    every detector that ran lands on the checks list, fired or
            not, applicable or not. "We looked at this and it was fine"
            and "we could not look at this" are different sentences and
            both of them are printable.

It never reads a clock, never calls a model, never writes anything.
The same books and the same pack always produce the same findings, in the
same order, with the same ids.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from engine.api import _finding as F

from . import book as B
from . import fam_series  # noqa: F401  (registers seven families)
from . import fam_static  # noqa: F401  (registers five families)
from . import registry
from . import support as SUP
from .pack import COLD_START_MIN_PERIODS, DetectorPack, DetectorSpec
from .result import DetectorResult

STATUS_FIRED = "fired"
STATUS_CLEAR = "clear"
STATUS_NOT_APPLICABLE = "not_applicable"
STATUS_WAITING = "waiting_on_history"
STATUS_DEMOTED = "demoted"


@dataclass(frozen=True)
class DetectorCheck:
    """One row of the "All checks" list."""

    detector_id: str
    family: str
    label: str
    status: str
    reason: str
    accounts: Tuple[str, ...] = ()
    periods: Tuple[str, ...] = ()
    missing_elements: Tuple[str, ...] = ()

    def to_payload(self) -> Dict[str, Any]:
        return {
            "detector_id": self.detector_id, "family": self.family,
            "label": self.label, "status": self.status, "reason": self.reason,
            "accounts": list(self.accounts), "periods": list(self.periods),
            "missing_elements": list(self.missing_elements),
        }


@dataclass(frozen=True)
class DetectorRun:
    findings: Tuple["F.Finding", ...]
    results: Tuple[DetectorResult, ...]
    checks: Tuple[DetectorCheck, ...]
    cold_start: bool
    period_count: int
    waiting: Tuple[str, ...] = ()
    ran: Tuple[str, ...] = ()

    def statement(self) -> str:
        """What ran, what did not, and why — in one sentence a reader can
        act on. A cold-start run says which detectors are waiting and on
        what, rather than presenting a short history as a full one."""
        head = ("%d detector(s) ran across %d period(s)"
                % (len(self.ran), self.period_count))
        if not self.cold_start:
            return ("%s; %d finding(s) surfaced from the detector lane."
                    % (head, len(self.findings)))
        return ("%s. This book carries fewer than %d comparable periods, so "
                "only the %d detector(s) that are valid on a single period "
                "ran; %d cross-period detector(s) are waiting on history "
                "(%s). No trend is claimed from this history."
                % (head, COLD_START_MIN_PERIODS, len(self.ran),
                   len(self.waiting), ", ".join(self.waiting) or "none"))


def _check(spec: "DetectorSpec", status: str, reason: str,
           result: Optional[DetectorResult] = None,
           missing: Sequence[str] = ()) -> DetectorCheck:
    return DetectorCheck(
        detector_id=spec.id, family=spec.family, label=spec.label,
        status=status, reason=reason,
        accounts=(result.scope_codes() if result is not None else ()),
        periods=(result.periods if result is not None else ()),
        missing_elements=tuple(missing))


def _history_gate(spec: "DetectorSpec", series: "B.BookSeries"
                  ) -> Optional[str]:
    """The pack's own history bill for this detector, checked before the
    family is called. Returns the unmet bill, or None."""
    periods = series.period_count()
    if periods < COLD_START_MIN_PERIODS and not spec.single_period_valid:
        return ("needs %d comparable periods before any cross-period claim is "
                "made and this book carries %d" % (COLD_START_MIN_PERIODS, periods))
    if periods < spec.min_periods:
        return ("needs %d comparable period(s) and this book carries %d"
                % (spec.min_periods, periods))
    if spec.min_years and series.years_covered() < spec.min_years:
        return ("needs %d calendar year(s) and this spine covers %d"
                % (spec.min_years, series.years_covered()))
    return None


def run_detectors(pack: "DetectorPack", series: "B.BookSeries",
                  profile: Any, snapshot_id: Optional[str] = None,
                  only: Optional[Sequence[str]] = None) -> DetectorRun:
    """Run every detector the pack declares that this history supports."""
    latest = series.latest()
    if latest is None:
        raise ValueError("run_detectors needs at least one period book")
    period_id = latest.period_id
    currency = series.currency or latest.currency
    cold = series.period_count() < COLD_START_MIN_PERIODS

    findings = []  # type: List[F.Finding]
    results = []  # type: List[DetectorResult]
    checks = []  # type: List[DetectorCheck]
    waiting = []  # type: List[str]
    ran = []  # type: List[str]

    wanted = set(only) if only is not None else None
    for spec in pack.detectors:
        if wanted is not None and spec.id not in wanted:
            continue
        bill = _history_gate(spec, series)
        if bill is not None:
            waiting.append(spec.id)
            checks.append(_check(spec, STATUS_WAITING,
                                 "%s %s" % (spec.label, bill)))
            continue
        family = registry.family(spec.family)
        ran.append(spec.id)
        for result in family(spec, series, profile):
            results.append(result)
            if not result.applicable:
                checks.append(_check(spec, STATUS_NOT_APPLICABLE,
                                     result.na_reason, result))
                continue
            if not result.fired:
                checks.append(_check(spec, STATUS_CLEAR, result.reason, result))
                continue
            finding = SUP.build_finding(
                spec, result, profile, currency, period_id, snapshot_id)
            verdict = finding.verdict()
            if verdict.surfaced:
                findings.append(finding)
                checks.append(_check(spec, STATUS_FIRED, result.reason, result))
            else:
                # The Finding demoted itself. Recorded with the missing
                # elements so the gap is fixable, and kept OUT of the
                # findings list — an incomplete finding belongs on the
                # checks list, which is exactly where it lands.
                findings.append(finding)
                checks.append(_check(
                    spec, STATUS_DEMOTED,
                    "%s — incomplete against the seven-element contract: %s"
                    % (result.reason, "; ".join(m.render() for m in verdict.missing)),
                    result, missing=verdict.missing_elements()))

    return DetectorRun(
        findings=tuple(findings), results=tuple(results), checks=tuple(checks),
        cold_start=cold, period_count=series.period_count(),
        waiting=tuple(waiting), ran=tuple(ran))


def surfaced(run: DetectorRun) -> Tuple["F.Finding", ...]:
    """The findings that pass the contract, in a deterministic order:
    severity, then rule id, then the accounts they are about. Ranking,
    materiality and the cap are the serving lane's job — this is only a
    stable order for a caller that wants one."""
    from engine.api import _finding_rank as R
    return tuple(sorted(
        (f for f in run.findings if f.verdict().surfaced),
        key=lambda f: (R.SEVERITY_RANK.get(f.severity, 9), f.rule_id,
                       "+".join(a.code for a in (f.subject.accounts if f.subject else ())))))


__all__ = [
    "DetectorCheck", "DetectorRun", "STATUS_CLEAR", "STATUS_DEMOTED",
    "STATUS_FIRED", "STATUS_NOT_APPLICABLE", "STATUS_WAITING",
    "run_detectors", "surfaced",
]
