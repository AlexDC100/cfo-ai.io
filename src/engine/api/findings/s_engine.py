"""SINGLE-PERIOD FINDINGS — the runner. Where most users start.

One period, one profile, seventeen registered detectors, and a result
that is either a finding carrying all seven contract elements or an
explicit statement of what was checked and why it stayed quiet.

    from engine.api.findings import s_engine

    result = s_engine.run_single_period(
        statements, period_id="…", caen=None, snapshot_id="…")

    result.payloads()           # alert rows, each stamped surfaced/demoted
    result.all_checks()         # every rule that ran, with its numbers
    result.silence_statement()  # None, or the exact claim + the checks

(``engine.api.findings.run_single_period`` re-exports it; the package
``__init__`` is kept to a thin re-export so the multi-period modules that
share this package can extend it without either side rewriting the
other's entry point.)

WHAT THIS LANE IS REPLACING
Fifty-nine rule-authored findings, of which 47 contained no imperative
verb and 34 carried fewer than two figures; eleven rules firing, five of
them through banned boilerplate. The worked example — the 461 note —
scored 1.5 of the seven elements. The rules themselves were mostly
sound; what was missing was the contract around them, and these
modules are those same detections rebuilt to carry it.

THE ARRANGEMENT

    s_coherence     does the arithmetic hold together at all
    s_structure     is the composition what this profile band expects
    s_concentration one source carrying a class, and the class without it
    s_interco       money lent inside the group, and the lender's haircut
    s_liquidity     cash against what is owed and what is being burnt
    s_solvency      debt against earnings; equity against the statute
    s_aging         what the company has already stopped believing in
    s_compliance    the statutory checks, and the article they cite

SCOPE. This registry is the SINGLE-PERIOD one: the ``s_*`` modules, and
the seventeen detectors ``profiles.yaml`` registers. The ``m_*`` modules
in this package are the multi-period lane's; they carry their own policy
table and their own entry point, and are neither imported nor registered
here.

Every registered detector is claimed by exactly one ``s_*`` module, and
:func:`run_single_period` walks the CATALOGUE's list rather than the
package's — so a detector added to ``profiles.yaml`` with no
implementation here is a loud failure at the coverage gate, not a rule
that quietly never runs. That is the failure mode the baseline had:
``asset_maturity`` and ``input_cost_exposure`` both read canonical
fields that do not exist, computed 0.0, and never fired on any company
for months without anybody noticing.

THREE RULES THESE DETECTORS HOLD THEMSELVES TO

  DETERMINISTIC END TO END. Detection AND quantification are computed
  here. Nothing in these modules constructs an AI client, and the only
  seam an advisory model may use is
  ``_finding.apply_advisory_narrative``, which re-words a rationale and
  an action step and refuses if a single number moves.

  ABSENT != ZERO. Every read returns ``None`` when a field is not
  present, every rule that cannot form its quantity records a check
  naming the missing field, and no rule substitutes a proxy for the
  quantity its threshold judges.

  SILENCE IS VALID. A period with nothing material returns a silence
  statement listing what was examined, with each check's parameter,
  limit and observed value. Never filler.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from .. import _company_profile as CP
from .. import _finding as F
from . import _base
from . import (s_aging, s_coherence, s_compliance, s_concentration,
               s_interco, s_liquidity, s_solvency, s_structure)

logger = logging.getLogger(__name__)

#: Modules in the order a reader should meet them: can the numbers be
#: believed, then what shape is the company, then what is concentrated,
#: then can it pay, then does it comply. `run_single_period` iterates the
#: CATALOGUE for coverage, so this order is documentation, not dispatch.
MODULES = (s_coherence, s_structure, s_concentration, s_interco,
           s_liquidity, s_solvency, s_aging, s_compliance)

#: detector id -> the function that runs it. Built once, at import.
DETECTORS = _base.build_registry(MODULES)


class DetectorCoverageError(RuntimeError):
    """The catalogue and this package disagree about which detectors
    exist.

    Deliberately fatal rather than a warning. A registered detector with
    no implementation is a rule the operator believes is running and is
    not; an implemented detector with no catalogue entry has no
    thresholds, no applicability and no why-here copy, and would raise
    ``UnknownDetectorError`` the first time it asked for any of them.
    """


@dataclass(frozen=True)
class SinglePeriodResult:
    """What one period produced. Carries the PROFILE too, because a
    reader who disagrees with a finding's why-here needs to see the
    classification it came from."""

    profile: "CP.CompanyProfile"
    finding_set: F.FindingSet
    checks: Tuple[F.CheckRecord, ...]

    def payloads(self) -> List[Dict[str, Any]]:
        """Alert rows, most severe first. Every row is stamped
        ``surfaced`` / ``demoted`` by the contract's own validator — this
        method cannot promote anything."""
        rows = self.finding_set.payloads()
        rows.sort(key=lambda row: (_SEVERITY_ORDER.get(row.get("severity"), 99),
                                   row.get("rule_key") or ""))
        return rows

    def surfaced(self) -> List[Dict[str, Any]]:
        return [row for row in self.payloads() if row.get("surfaced")]

    def demoted(self) -> List[Dict[str, Any]]:
        return [row for row in self.payloads() if not row.get("surfaced")]

    def all_checks(self) -> List[Dict[str, Any]]:
        """Every check that ran — the ones a detector recorded, plus the
        row every finding degrades to. This is what makes silence a
        claim."""
        return [check.to_payload() for check in self.checks] \
            + self.finding_set.all_checks()

    def silence_statement(self) -> Optional[Dict[str, Any]]:
        statement = self.finding_set.silence_statement()
        if statement is None:
            return None
        # The set only knows about the checks its own findings produced;
        # the detectors that stayed quiet recorded theirs here.
        checks = self.all_checks()
        statement["checks"] = checks
        statement["checks_performed"] = len(checks)
        statement["statement"] = (
            "No finding met the seven-element contract for this period. "
            "%d check(s) ran; each is listed with its parameter, its limit "
            "and the observed value." % len(checks))
        return statement


_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}


def assert_full_coverage(catalog: Optional["CP.ProfileCatalog"] = None) -> None:
    """Every catalogued detector is implemented, and nothing extra is.

    Called on every run, not only from a test: a coverage hole is a rule
    the operator thinks is running.
    """
    cat = catalog or CP.load_catalog()
    catalogued = set(cat.detectors)
    implemented = set(DETECTORS)
    missing = sorted(catalogued - implemented)
    extra = sorted(implemented - catalogued)
    if missing or extra:
        raise DetectorCoverageError(
            "detector coverage mismatch against %s — registered but not "
            "implemented: %r; implemented but not registered: %r"
            % (cat.origin, missing, extra))


def run_single_period(statements: Optional[Dict[str, Any]],
                      period_id: str,
                      caen: Optional[str] = None,
                      snapshot_id: Optional[str] = None,
                      catalog: Optional["CP.ProfileCatalog"] = None,
                      extra_facts: Optional[Dict[str, Any]] = None
                      ) -> SinglePeriodResult:
    """Run every applicable detector over ONE period's assembled
    statements.

    Nothing else is consulted — no prior period, no clock, no registry
    lookup beyond the CAEN the caller passes — so the same statements
    always produce the same findings, the same prose and the same
    templates. That is what lets the corpus replay stay byte-identical.
    """
    cat = catalog or CP.load_catalog()
    assert_full_coverage(cat)
    profile = CP.build_company_profile(
        statements or {}, period_id=period_id, caen=caen, catalog=cat,
        extra_facts=extra_facts, snapshot_id=snapshot_id)
    ctx = _base.Ctx(profile=profile, reader=_base.Reader(statements),
                    period_id=period_id, snapshot_id=snapshot_id)

    finding_set = F.FindingSet(profile.profile_id, profile.fingerprint())
    checks = []  # type: List[F.CheckRecord]
    # The CATALOGUE's order, not the package's — stable, and it cannot
    # silently skip a detector nobody remembered to list.
    for detector_id in profile.detector_ids():
        try:
            outcome = DETECTORS[detector_id](ctx)
        except Exception as exc:  # noqa: BLE001 — see below
            # One detector must not take the other sixteen down with it.
            # But it must not vanish either: swallowing the failure is how
            # a whole subsystem stays green while producing nothing (the
            # FakeStore outages). So the failure becomes a CHECK ROW,
            # which is rendered on the "All checks" list beside every
            # other rule, AND is logged at exception level.
            logger.exception("[findings] detector %s raised on period %s",
                             detector_id, period_id)
            checks.append(F.CheckRecord(
                rule_id=detector_id, profile_id=profile.profile_id,
                note="the detector raised and produced nothing: %s: %s"
                     % (type(exc).__name__, exc)))
            continue
        checks.extend(outcome.checks)
        if outcome.finding is not None:
            finding_set.add(outcome.finding)
    return SinglePeriodResult(profile=profile, finding_set=finding_set,
                              checks=tuple(checks))


__all__ = [
    "DETECTORS", "MODULES", "DetectorCoverageError", "SinglePeriodResult",
    "assert_full_coverage", "run_single_period",
]
