"""THE MULTI-PERIOD ENTRY POINT.

One function, :func:`analyse_multi_period`, and one hard gate in front of
it: with fewer than two comparable periods NOTHING runs. Not a reduced
analysis, not a single-period fallback, not a slope through one point —
the result is a typed :class:`~engine.api.findings.m_series.NeedsHistory`
naming every analysis that is waiting and what it is waiting for. That is
F6, and it is enforced by shape rather than by discipline: the analyses
take windows, the windows refuse to be built short, and the cold-start
branch returns before any of them is called.

WHAT THIS MODULE ACTUALLY DOES

    measure     ask each analysis for its observable (`m_detect`)
    judge       resolve the threshold — pack first, table second
                (`m_policy`) — and pick the band that ACTUALLY fired
    dress       assemble the seven contract elements from the company
                profile (`_company_profile`) and the analysis copy, and
                let `_finding.Finding` decide whether it may be surfaced
    remember    count how many consecutive periods the same check has
                fired on the same balance, and say so in the finding
    weigh       hand the candidates to `_finding_rank` for materiality,
                merge, rank and cap

WHAT IT NEVER DOES
Invent a number, decide materiality by feel, rank by severity alone,
suppress a critical finding, or read a clock. Every check that RAN is
recorded — fired or not, applicable or not — so a quiet period answers
with the list of what was examined instead of with silence.

THE ADVISORY SEAM
An advisory model may re-word `why_here.rationale` and the action steps
through `_finding.apply_advisory_narrative`, which re-validates and
refuses on any numeric drift. It is not called from here: this module is
the deterministic half, and it is complete on its own.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .. import _company_profile as CP
from .. import _finding as F
from .. import _finding_rank as R
from . import m_detect as D
from . import m_policy as P
from . import m_series as S


# ── Persistence input ────────────────────────────────────────────────────


@dataclass(frozen=True)
class PriorFinding:
    """One finding that fired in an earlier period. Supplied by the
    caller from storage — this module reads history, it does not keep it.

    `scope_key` is the finding's ROOT CAUSE (the ledger accounts it is
    about), which is what `RankedFinding.root_cause` publishes and what a
    dismissal is scoped by. One key, learned once: "the same finding on
    the same balance" has to mean the same thing to persistence, to
    dismissal and to merge, or an operator dismissing a row silences a
    different one.
    """

    period_ordinal: int
    rule_id: str
    scope_key: str = ""


# ── The result ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class MultiPeriodResult:
    period_id: str
    currency: str
    profile_id: str
    profile_composite: str
    needs_history: Optional["S.NeedsHistory"]
    requirements: Tuple["S.AnalysisRequirement", ...]
    finding_set: "F.FindingSet"
    report: Optional["R.RankedReport"]

    def cold_start(self) -> bool:
        return self.needs_history is not None

    def silence(self) -> Optional[Dict[str, Any]]:
        return self.finding_set.silence_statement()

    def to_payload(self) -> Dict[str, Any]:
        payload = {
            "period_id": self.period_id,
            "currency": self.currency,
            "profile_id": self.profile_id,
            "profile_composite": self.profile_composite,
            "cold_start": self.cold_start(),
            "needs_history": (self.needs_history.to_payload()
                              if self.needs_history else None),
            "requirements": [r.to_payload() for r in self.requirements],
            "all_checks": self.finding_set.all_checks(),
            "silence": self.silence(),
            "report": (self.report.to_payload() if self.report else None),
        }
        return payload


# ── The analysis roster ──────────────────────────────────────────────────
#
# (analysis id, how to enumerate its targets). Declared here rather than
# discovered, so a target list is reviewable and an analysis cannot start
# running on a line nobody chose for it.


def _direction_targets(series_set: "S.SeriesSet") -> Tuple[Any, ...]:
    return tuple(k for k in series_set.subject_keys()
                 if series_set.require(k).spec.adverse_direction
                 != S.DIRECTION_NONE)


def _all_subject_targets(series_set: "S.SeriesSet") -> Tuple[Any, ...]:
    return series_set.subject_keys()


def _asset_targets(series_set: "S.SeriesSet") -> Tuple[Any, ...]:
    return tuple(k for k in series_set.subject_keys()
                 if series_set.require(k).spec.side == S.SIDE_ASSET)


def _decouple_targets(series_set: "S.SeriesSet") -> Tuple[Any, ...]:
    return tuple(pair for pair in D.DECOUPLE_PAIRS
                 if series_set.get(pair[0]) is not None
                 and series_set.get(pair[1]) is not None)


def _cycle_targets(series_set: "S.SeriesSet") -> Tuple[Any, ...]:
    return tuple(cycle for cycle in D.CYCLES
                 if series_set.get(cycle[2]) is not None
                 and series_set.get(cycle[3]) is not None)


ROSTER = (
    (P.M_DIRECTION.id, D.direction, _direction_targets),
    (P.M_MAGNITUDE.id, D.magnitude, _all_subject_targets),
    (P.M_DECOUPLE.id, D.decouple, _decouple_targets),
    (P.M_VELOCITY.id, D.velocity, _cycle_targets),
    (P.M_REVERSAL.id, D.reversal, _all_subject_targets),
    (P.M_DORMANT.id, D.dormant, _asset_targets),
    (P.M_TREND.id, D.trend, _direction_targets),
    (P.M_SEASONAL.id, D.seasonal, _direction_targets),
)


# ── The entry point ──────────────────────────────────────────────────────


def analyse_multi_period(series_set: "S.SeriesSet",
                         profile: "CP.CompanyProfile",
                         prior_findings: Sequence[PriorFinding] = (),
                         dismissals: Sequence["R.Dismissal"] = (),
                         policy: Optional["R.MaterialityPolicy"] = None,
                         cap: int = R.DEFAULT_CAP,
                         ) -> MultiPeriodResult:
    """Run every multi-period analysis over one company's spine.

    COLD START IS THE FIRST BRANCH, deliberately. A single-period spine
    returns before a single analysis function is reached, so there is no
    code path in which a trend, a median or a year-over-year move is
    computed from one point. The caller gets the requirement list instead,
    which is the honest answer and a more useful one than an empty list.
    """
    latest = series_set.latest_period()
    period_id = latest.period_id if latest else ""
    fs = F.FindingSet(profile.profile_id, profile.fingerprint())
    mpolicy = policy or R.MaterialityPolicy.from_pack()

    if series_set.period_count() < 2:
        requirements = _cold_requirements(series_set)
        needs = S.NeedsHistory(
            period_count=series_set.period_count(),
            year_count=series_set.years_covered(),
            period_labels=tuple(p.label for p in series_set.periods),
            requirements=requirements)
        for req in requirements:
            fs.record_check(F.CheckRecord(
                rule_id=req.analysis_id, parameter="periods_available",
                comparator=">=", limit=float(req.needs_periods),
                observed=float(req.have_periods), unit=F.UNIT_COUNT,
                fired=False, profile_id=profile.profile_id,
                note="not run: %s" % req.reason))
        return MultiPeriodResult(
            period_id=period_id, currency=series_set.currency,
            profile_id=profile.profile_id,
            profile_composite=profile.composite_id,
            needs_history=needs, requirements=requirements,
            finding_set=fs, report=None)

    requirements = []  # type: List[S.AnalysisRequirement]
    candidates = []  # type: List[R.RankInput]
    persistence = _PersistenceIndex(series_set, prior_findings)

    for analysis_id, runner, targets in ROSTER:
        spec = P.ANALYSES[analysis_id]
        params = _resolved_params(profile, analysis_id)
        blocked_reason = ""
        measured = 0
        for target in targets(series_set):
            try:
                outcome = runner(series_set, target, params)
            except S.NeedsHistoryError as exc:
                blocked_reason = blocked_reason or str(exc)
                fs.record_check(F.CheckRecord(
                    rule_id=_rule_id(analysis_id, _target_key(target)),
                    parameter="periods_available", comparator=">=",
                    limit=float(exc.needed), observed=float(exc.have),
                    unit=F.UNIT_COUNT, fired=False,
                    profile_id=profile.profile_id,
                    note="not run: %s" % exc))
                continue
            if not outcome.measured():
                fs.record_check(F.CheckRecord(
                    rule_id=_rule_id(analysis_id, outcome.series_key),
                    parameter="", comparator="", limit=None, observed=None,
                    unit=F.UNIT_UNKNOWN, fired=False,
                    profile_id=profile.profile_id,
                    note="not measured: %s" % outcome.reason))
                blocked_reason = blocked_reason or ("could not be measured: %s"
                                                    % outcome.reason)
                continue
            measured += 1
            _consider(fs, candidates, profile, series_set, spec,
                      outcome.measurement, mpolicy, persistence)

        requirements.append(S.AnalysisRequirement(
            analysis_id=analysis_id, label=spec.label,
            needs_periods=spec.min_periods, needs_years=spec.min_years,
            have_periods=series_set.period_count(),
            have_years=series_set.years_covered(),
            satisfied=bool(measured),
            reason=("" if measured else
                    (blocked_reason or "no line on this spine is in scope for "
                                       "this analysis"))))

    report = R.rank_findings(
        candidates, checks=tuple(fs.all_checks()), cap=cap,
        dismissals=R.DismissalIndex(tuple(dismissals)),
        policy_source=mpolicy.source)
    return MultiPeriodResult(
        period_id=period_id, currency=series_set.currency,
        profile_id=profile.profile_id, profile_composite=profile.composite_id,
        needs_history=None, requirements=tuple(requirements),
        finding_set=fs, report=report)


# ── Measurement -> Finding ───────────────────────────────────────────────


def _consider(fs: "F.FindingSet", candidates: List["R.RankInput"],
              profile: "CP.CompanyProfile", series_set: "S.SeriesSet",
              spec: "P.AnalysisSpec", m: "D.Measurement",
              mpolicy: "R.MaterialityPolicy",
              persistence: "_PersistenceIndex") -> None:
    """Judge one measurement, and record it either way."""
    rule_id = _rule_id(spec.id, m.series_key)

    gate_failed = ""
    for gate in spec.gates:
        limit = P.resolve_threshold(profile, spec.id, gate)
        observed = m.observed.get(gate)
        if observed is None:
            continue
        if not _holds(limit.comparator, observed, limit.value, limit.unit):
            gate_failed = ("%s %s %s not met (observed %s)"
                           % (limit.label, limit.comparator, limit.value,
                              observed))
            break

    band = None  # type: Optional[P.ResolvedThreshold]
    observed_value = None  # type: Optional[float]
    if not gate_failed:
        for name in spec.bands:
            limit = P.resolve_threshold(profile, spec.id, name)
            observed = m.observed.get(name)
            if observed is None:
                continue
            if _holds(limit.comparator, observed, limit.value, limit.unit):
                band, observed_value = limit, observed
                break

    if band is None or observed_value is None:
        # Record against the ORDINARY band, not the severe one: the check
        # a reader wants to see is the limit the line came closest to,
        # and `bands` is ordered most-severe-first.
        primary = spec.bands[-1]
        limit = P.resolve_threshold(profile, spec.id, primary)
        fs.record_check(F.CheckRecord(
            rule_id=rule_id, parameter=limit.parameter,
            comparator=limit.comparator, limit=limit.value,
            observed=m.observed.get(primary), unit=limit.unit, fired=False,
            profile_id=profile.profile_id,
            note=(gate_failed or "ran and did not fire")))
        return

    consecutive = persistence.consecutive(rule_id, m.root_cause)
    finding = _build_finding(profile, series_set, spec, m, band,
                             observed_value, consecutive)
    verdict = fs.add(finding)

    try:
        materiality = R.assess_materiality(
            mpolicy, m.materiality_basis_id or spec.materiality_basis,
            _basis_label(series_set, m.materiality_basis_id),
            m.materiality_basis_value, m.materiality_amount,
            series_set.currency)
    except R.MaterialityBasisMissing as exc:
        fs.record_check(F.CheckRecord(
            rule_id=rule_id, parameter=band.parameter,
            comparator=band.comparator, limit=band.value,
            observed=observed_value, unit=band.unit, fired=True,
            profile_id=profile.profile_id,
            note="fired but not ranked: %s" % exc))
        return

    # An incomplete finding is NOT dropped here. It goes to the ranker
    # like every other candidate and is routed to the checks list with
    # its missing elements — demotion belongs in exactly one place, and
    # that place is the contract, not this function.
    del verdict
    candidates.append(R.RankInput(
        finding=finding, materiality=materiality, root_cause=m.root_cause,
        persistence=consecutive, contributors=m.contributors,
        scope_key=m.root_cause,
        period_ordinal=_latest_ordinal(series_set)))


def _build_finding(profile: "CP.CompanyProfile", series_set: "S.SeriesSet",
                   spec: "P.AnalysisSpec", m: "D.Measurement",
                   band: "P.ResolvedThreshold", observed: float,
                   consecutive: int) -> "F.Finding":
    """The seven elements, assembled. Every one of them comes from a
    typed source — the measurement, the profile or the analysis table —
    so there is no place for a hand-written sentence to enter."""
    rule_id = _rule_id(spec.id, m.series_key)
    latest = series_set.latest_period()

    figures = tuple(F.Figure(fact=f.fact, value=f.value, unit=f.unit,
                             label=f.label) for f in m.figures)
    provenance = series_set.provenance_for(m.line_refs)
    evidence = F.Evidence(
        figures=figures, provenance=provenance,
        comparison_basis=F.ComparisonBasis(
            kind=spec.basis_kind, description=m.basis_description,
            basis_value=m.basis_value, basis_unit=m.basis_unit))

    threshold = F.Threshold(
        rule_id=rule_id, parameter=band.parameter,
        parameter_label=band.label, comparator=band.comparator,
        limit=band.value, observed=observed, unit=band.unit,
        source=band.source)

    tokens = dict(m.tokens)
    tokens.update({
        "profile_label": profile.profile_label,
        "size_label": profile.size_band.label,
        "sector_label": profile.sector_label,
        "financing_label": profile.financing.label,
        "financing_audience": profile.financing.audience,
        "signal_labels": (", ".join(s.label for s in profile.present_signals())
                          or "no structural signals"),
        "scope": m.scope,
    })

    why_here = _why_here(profile, spec, tokens, m, consecutive)
    action = F.Action(steps=tuple(
        F.ActionStep(
            imperative=P.render_tokens(step.imperative, tokens),
            artefact=P.render_tokens(step.artefact, tokens),
            provider=step.provider,
            horizon=(P.render_tokens(step.horizon, tokens)
                     if step.horizon else None))
        for step in spec.actions))
    confidence = profile.confidence(None, extra_caveats=m.caveats)

    return F.Finding(
        rule_id=rule_id, severity=band.severity,
        category=P.resolve_category(profile, spec.id),
        currency=series_set.currency,
        subject=F.Subject(accounts=m.accounts, scope=m.scope),
        evidence=evidence, threshold=threshold, impact=m.impact,
        why_here=why_here, action=action, confidence=confidence,
        profile_id=profile.profile_id,
        profile_fingerprint=profile.fingerprint(),
        facts_cited=dict(m.facts))


def _why_here(profile: "CP.CompanyProfile", spec: "P.AnalysisSpec",
              tokens: Dict[str, str], m: "D.Measurement",
              consecutive: int) -> "F.WhyHere":
    """Profile-derived, pack-first.

    When the country pack registers this analysis as a detector, its copy
    wins — tuned per structural profile and validated by the catalogue
    loader. Otherwise the analysis table's cross-profile copy is rendered
    against this company's own tokens. Either way the rationale carries a
    profile anchor, which is what stops the sentence being reusable for a
    different company.

    PERSISTENCE IS SIGNAL: a check that has fired for several consecutive
    periods says so, here, in the finding itself, with the count.
    """
    try:
        base = profile.why_here(spec.id, scope=m.scope)
        rationale = base.rationale
    except CP.UnknownDetectorError:
        rationale = P.render_tokens(spec.why_here, tokens)
    if consecutive >= 2:
        rationale = (rationale.rstrip(". ")
                     + ". This is the %s the same check has fired on %s."
                     % (R.persistence_label(consecutive),
                        tokens.get("codes") or m.series_key))
    return F.WhyHere(
        profile_id=profile.profile_id, profile_label=profile.profile_label,
        rationale=rationale,
        signals=(tuple(s.id for s in profile.present_signals())
                 or (profile.financing.id,)),
        anchors=profile.anchors())


# ── Persistence ──────────────────────────────────────────────────────────


class _PersistenceIndex(object):
    """How many CONSECUTIVE periods a rule has fired on the same balance,
    counting this one.

    Consecutive on the SPINE, not on the calendar: a period the company
    did not upload cannot be counted as a period in which the finding was
    absent, so the walk steps backwards through the spine's own ordinals.
    """

    def __init__(self, series_set: "S.SeriesSet",
                 prior: Sequence[PriorFinding]) -> None:
        self._ordinals = [p.ordinal for p in series_set.periods]
        self._seen = set()  # type: set
        for item in prior:
            self._seen.add((int(item.period_ordinal), item.rule_id,
                            item.scope_key))

    def consecutive(self, rule_id: str, scope_key: str) -> int:
        count = 1
        for ordinal in reversed(self._ordinals[:-1]):
            if (int(ordinal), rule_id, scope_key) in self._seen:
                count += 1
            else:
                break
        return count


# ── helpers ──────────────────────────────────────────────────────────────


def _rule_id(analysis_id: str, target_key: str) -> str:
    return "%s.%s" % (analysis_id, target_key)


def _target_key(target: Any) -> str:
    if isinstance(target, tuple):
        return target[0] if len(target) == 1 else "%s~%s" % (target[0], target[1])
    return str(target)


def _holds(comparator: str, observed: float, limit: float,
           unit: str = F.UNIT_COUNT) -> bool:
    """The comparison, taken from the contract's own implementation.

    Deliberately not re-implemented: the finding will later assert that
    its threshold `holds()`, and a second copy of the comparison here is
    exactly how a rule ships citing a limit it never crossed.
    """
    return F.Threshold(
        rule_id="probe", parameter="probe", parameter_label="probe",
        comparator=comparator, limit=float(limit), observed=float(observed),
        unit=unit, source="probe").holds()


def _resolved_params(profile: "CP.CompanyProfile",
                     analysis_id: str) -> Dict[str, float]:
    spec = P.ANALYSES[analysis_id]
    return dict((name, P.resolve_threshold(profile, analysis_id, name).value)
                for name in sorted(spec.parameters))


def _basis_label(series_set: "S.SeriesSet", basis_id: str) -> str:
    series = series_set.get(basis_id)
    return series.label.lower() if series is not None else (basis_id or "basis")


def _latest_ordinal(series_set: "S.SeriesSet") -> Optional[int]:
    latest = series_set.latest_period()
    return latest.ordinal if latest else None


def _cold_requirements(series_set: "S.SeriesSet"
                       ) -> Tuple["S.AnalysisRequirement", ...]:
    have_periods = series_set.period_count()
    have_years = series_set.years_covered()
    out = []  # type: List[S.AnalysisRequirement]
    for analysis_id in P.ANALYSIS_IDS:
        spec = P.ANALYSES[analysis_id]
        reason = ("needs %d comparable periods and this spine carries %d"
                  % (spec.min_periods, have_periods))
        if spec.min_years and have_years < spec.min_years:
            reason += ("; it also needs %d calendar years and this spine "
                       "carries %d" % (spec.min_years, have_years))
        out.append(S.AnalysisRequirement(
            analysis_id=analysis_id, label=spec.label,
            needs_periods=spec.min_periods, needs_years=spec.min_years,
            have_periods=have_periods, have_years=have_years,
            satisfied=False, reason=reason))
    return tuple(out)


__all__ = [
    "MultiPeriodResult", "PriorFinding", "ROSTER", "analyse_multi_period",
]
