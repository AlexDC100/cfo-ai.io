"""MATERIALITY FIRST, THEN RANK, THEN CAP.

Sixty findings is the same as none. The baseline
(`design_review/findings/BASELINE.md`) shipped 59 rule-authored rows with
no ordering beyond a severity bucket, so the reader's attention was
allocated by whichever rule happened to fire — not by what the numbers
were worth. This module fixes the allocation, in four steps, in this
order:

1.  MATERIALITY (F4). Every finding is measured against a basis the
    DETECTOR declares — a share of total assets, of revenue, or of equity
    — and the floor is per company and pack-configurable. Below the
    floor a finding is at most an INFO row and is never a
    recommendation. This runs FIRST because a correctly-detected,
    perfectly-worded finding about 0.02% of the balance sheet is still
    noise, and no amount of ranking makes it not noise.

2.  MERGE. One root cause is one finding. A receivable that stopped
    moving will trip the direction analysis, the velocity analysis and
    the trend analysis; three rows about one balance is the generic-
    findings failure wearing three hats. Correlated findings are grouped
    by root cause, the strongest becomes the primary, and the rest are
    attached to it as CONTRIBUTORS — listed, not deleted.

3.  RANK. Quantified impact x confidence x persistence x actionability.
    Every factor is a number this module can show, and the score is
    reproducible from the payload — there is no model in the loop and no
    tie broken by dictionary order.

4.  CAP. Seven surfaced, by default. The rest are not thrown away: they
    go to the raw "All checks" list with a count, so "we found 23 things
    and are showing you 7" is a statement the reader can see and open.

DISMISSAL IS NOT DELETION
A dismissal carries a REASON, is scoped to a rule and a subject, and is
persisted by the caller. It moves a finding off the surfaced list and
onto the checks list WITH the reason attached. It cannot silently remove
a CRITICAL finding: a dismissed critical is still surfaced, flagged as
dismissed, with the reason shown next to it. Suppressing a critical
finding is a decision, and a decision has to be visible to be a decision.

NO CLOCK, NO MODEL
Nothing here reads the time or calls a model. `Dismissal.dismissed_at` is
an opaque caller-supplied string, ordering is total and deterministic,
and the same inputs always produce the same report.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import yaml

from . import _company_profile as CP
from . import _finding as F
from . import _ratio_units


# ── Materiality ──────────────────────────────────────────────────────────

TIER_MATERIAL = "material"
TIER_INFO = "info"
TIER_IMMATERIAL = "immaterial"

#: Cross-company defaults, as a share of the declared basis. They are
#: floors, not targets: the point is to keep a rounding difference off a
#: CFO's desk, not to decide what is interesting.
DEFAULT_FLOORS = {
    "total_assets": 0.005,     # 0.5% of the balance sheet
    "revenue": 0.010,          # 1.0% of turnover
    "total_equity": 0.010,     # 1.0% of book equity
}

#: A finding below `floor` is an info row; a finding below
#: `floor * INFO_FRACTION` is not even that — it goes straight to the
#: checks list. Two tiers rather than one, because "small" and
#: "arithmetically invisible" are different verdicts.
DEFAULT_INFO_FRACTION = 0.25

POLICY_SOURCE_DEFAULT = "engine.api._finding_rank#DEFAULT_FLOORS"


class MaterialityBasisMissing(ValueError):
    """No basis value was available, so the share could not be computed.
    Raised rather than defaulted: a materiality decision taken against an
    unknown denominator is not a materiality decision."""


@dataclass(frozen=True)
class MaterialityPolicy:
    """The floors, and where they came from."""

    floors: Dict[str, float]
    info_fraction: float
    source: str

    @classmethod
    def default(cls) -> "MaterialityPolicy":
        return cls(floors=dict(DEFAULT_FLOORS),
                   info_fraction=DEFAULT_INFO_FRACTION,
                   source=POLICY_SOURCE_DEFAULT)

    @classmethod
    def from_pack(cls, path: Optional[str] = None) -> "MaterialityPolicy":
        """Read the optional `materiality:` block from the country pack.

        The pack is the right home for these numbers — a jurisdiction with
        a statutory materiality convention should not need a code change
        to apply it. When the block is absent (which it is today) the
        cross-company defaults are used and the policy SAYS so, so a
        reader can always tell which floor judged them.
        """
        target = path or str(CP.DEFAULT_PROFILES_PATH)
        try:
            with open(target, "r", encoding="utf-8") as fh:
                raw = yaml.safe_load(fh)
        except (OSError, yaml.YAMLError):
            return cls.default()
        block = (raw or {}).get("materiality") if isinstance(raw, dict) else None
        if not isinstance(block, dict):
            return cls.default()
        floors = dict(DEFAULT_FLOORS)
        for key, value in (block.get("floors") or {}).items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                floors[str(key)] = float(value)
        fraction = block.get("info_fraction")
        if not isinstance(fraction, (int, float)) or isinstance(fraction, bool):
            fraction = DEFAULT_INFO_FRACTION
        return cls(floors=floors, info_fraction=float(fraction),
                   source="%s#materiality" % target)

    def floor(self, basis_id: str) -> float:
        if basis_id in self.floors:
            return float(self.floors[basis_id])
        # An unknown basis takes the STRICTEST declared floor rather than
        # a permissive default: an undeclared basis is a gap in the
        # policy, and a gap must not make things EASIER to surface.
        declared = list(self.floors.values()) or list(DEFAULT_FLOORS.values())
        return float(max(declared))


@dataclass(frozen=True)
class MaterialityVerdict:
    """What the amount at stake is worth, against what, and therefore
    what the finding is allowed to be."""

    basis_id: str
    basis_label: str
    basis_value: float
    amount: float
    share: float
    floor: float
    tier: str
    source: str

    def is_material(self) -> bool:
        return self.tier == TIER_MATERIAL

    def statement(self) -> str:
        return ("%s of %s (floor %s, %s)"
                % (_pct(self.share), self.basis_label, _pct(self.floor),
                   self.tier))

    def to_payload(self) -> Dict[str, Any]:
        return {
            "basis_id": self.basis_id, "basis_label": self.basis_label,
            "basis_value": self.basis_value, "amount": self.amount,
            "share": self.share, "floor": self.floor, "tier": self.tier,
            "source": self.source, "statement": self.statement(),
        }


def assess_materiality(policy: MaterialityPolicy, basis_id: str,
                       basis_label: str, basis_value: Optional[float],
                       amount: float, currency: str) -> MaterialityVerdict:
    """The amount at stake as a share of the declared basis.

    Both operands are money in the SAME currency, so the quotient goes
    through the ratio law and is dimensionless — a materiality verdict
    cannot change because the reader switched the display currency.
    """
    if basis_value is None or basis_value == 0:
        raise MaterialityBasisMissing(
            "the %s basis is absent or zero for this period, so the share of "
            "it cannot be computed; materiality is undefined, not passed"
            % (basis_id or "declared"))
    share = _ratio_units.ratio(
        _ratio_units.money(abs(float(amount)), currency, name="amount"),
        _ratio_units.money(abs(float(basis_value)), currency, name=basis_id),
    )
    floor = policy.floor(basis_id)
    if share >= floor:
        tier = TIER_MATERIAL
    elif share >= floor * policy.info_fraction:
        tier = TIER_INFO
    else:
        tier = TIER_IMMATERIAL
    return MaterialityVerdict(
        basis_id=basis_id, basis_label=basis_label,
        basis_value=float(basis_value), amount=float(amount), share=share,
        floor=floor, tier=tier, source=policy.source)


# ── Dismissals ───────────────────────────────────────────────────────────

SCOPE_ANY = "*"


@dataclass(frozen=True)
class Dismissal:
    """A reader's decision to stop seeing a finding, WITH the reason.

    Scoped on purpose. A dismissal keyed only by rule id would silence the
    same rule on a different account in a different company; keyed by rule
    AND subject scope, it silences the thing that was actually judged.
    `periods` limits how long it holds — an open-ended dismissal is how a
    real problem disappears for two years.
    """

    rule_id: str
    scope_key: str = SCOPE_ANY
    reason: str = ""
    dismissed_by: str = ""
    dismissed_at: str = ""
    from_period_ordinal: Optional[int] = None
    periods: Optional[int] = None

    def covers(self, rule_id: str, scope_key: str,
               period_ordinal: Optional[int] = None) -> bool:
        if self.rule_id != rule_id:
            return False
        if self.scope_key != SCOPE_ANY and self.scope_key != scope_key:
            return False
        if (self.periods is not None and self.from_period_ordinal is not None
                and period_ordinal is not None):
            span = period_ordinal - int(self.from_period_ordinal)
            if span < 0 or span >= int(self.periods):
                return False
        return True

    def to_payload(self) -> Dict[str, Any]:
        return {
            "rule_id": self.rule_id, "scope_key": self.scope_key,
            "reason": self.reason, "dismissed_by": self.dismissed_by,
            "dismissed_at": self.dismissed_at,
            "from_period_ordinal": self.from_period_ordinal,
            "periods": self.periods,
        }

    @classmethod
    def from_payload(cls, payload: Dict[str, Any]) -> "Dismissal":
        return cls(
            rule_id=str(payload.get("rule_id") or ""),
            scope_key=str(payload.get("scope_key") or SCOPE_ANY),
            reason=str(payload.get("reason") or ""),
            dismissed_by=str(payload.get("dismissed_by") or ""),
            dismissed_at=str(payload.get("dismissed_at") or ""),
            from_period_ordinal=_opt_int(payload.get("from_period_ordinal")),
            periods=_opt_int(payload.get("periods")),
        )


class DismissalIndex(object):
    """The dismissals in force, and the one rule they cannot break."""

    def __init__(self, dismissals: Sequence[Dismissal] = ()) -> None:
        self._items = tuple(dismissals)

    def __len__(self) -> int:
        return len(self._items)

    def match(self, rule_id: str, scope_key: str,
              period_ordinal: Optional[int] = None) -> Optional[Dismissal]:
        for d in self._items:
            if d.covers(rule_id, scope_key, period_ordinal):
                return d
        return None

    def payloads(self) -> List[Dict[str, Any]]:
        return [d.to_payload() for d in self._items]


# ── Ranking ──────────────────────────────────────────────────────────────

DISPOSITION_SURFACED = "surfaced"
DISPOSITION_INFO = "info"
DISPOSITION_CHECKS = "all_checks"

SEVERITY_WEIGHT = {
    "critical": 1.00, "high": 0.75, "medium": 0.50, "low": 0.30, "info": 0.15,
}
SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}

CONFIDENCE_WEIGHT = {"high": 1.00, "medium": 0.80, "low": 0.55}

#: A finding at ten times its own materiality floor scores full marks on
#: the impact component. Chosen rather than unbounded so that one enormous
#: item cannot compress every other score to nothing.
IMPACT_SATURATION = 10.0

#: Persistence uplift per repeat, and its ceiling. A recurring finding
#: outranks a fresh one of the same size — it has survived a period of
#: everyone knowing about it.
PERSISTENCE_STEP = 0.15
PERSISTENCE_CAP = 1.60

DEFAULT_CAP = 7


@dataclass(frozen=True)
class RankInput:
    """One candidate, with the three things ranking needs that the
    Finding itself does not carry: what it is worth, how long it has been
    true, and which root cause it belongs to."""

    finding: F.Finding
    materiality: MaterialityVerdict
    root_cause: str
    persistence: int = 1
    contributors: Tuple[str, ...] = ()
    scope_key: str = ""
    period_ordinal: Optional[int] = None

    def key(self) -> str:
        return "%s|%s" % (self.finding.rule_id, self.scope_key or self.root_cause)


@dataclass(frozen=True)
class ScoreBreakdown:
    """Every multiplicand, kept. A rank a reader cannot reconstruct is a
    rank they have to take on faith."""

    impact: float
    confidence: float
    persistence: float
    actionability: float
    total: float

    def to_payload(self) -> Dict[str, Any]:
        return {"impact": self.impact, "confidence": self.confidence,
                "persistence": self.persistence,
                "actionability": self.actionability, "total": self.total}


@dataclass(frozen=True)
class RankedFinding:
    finding: F.Finding
    rank: int
    score: ScoreBreakdown
    disposition: str
    effective_severity: str
    materiality: MaterialityVerdict
    persistence: int
    persistence_label: str
    root_cause: str
    recommendation: bool
    merged_from: Tuple[str, ...] = ()
    contributor_rules: Tuple[str, ...] = ()
    dismissal: Optional[Dismissal] = None
    dismissed_but_retained: bool = False
    demotion_reason: str = ""

    def contributor_summary(self) -> str:
        if not self.merged_from:
            return ""
        return ("Also detected by %d correlated check(s) on the same balance: "
                "%s." % (len(self.merged_from), ", ".join(self.merged_from)))

    def to_payload(self) -> Dict[str, Any]:
        payload = self.finding.to_payload()
        payload.update({
            "rank": self.rank,
            "score": self.score.to_payload(),
            "disposition": self.disposition,
            "effective_severity": self.effective_severity,
            "materiality": self.materiality.to_payload(),
            "persistence": self.persistence,
            "persistence_label": self.persistence_label,
            "root_cause": self.root_cause,
            "recommendation": self.recommendation,
            "merged_from": list(self.merged_from),
            "contributor_rules": list(self.contributor_rules),
            "contributor_summary": self.contributor_summary(),
            "dismissed": self.dismissal is not None,
            "dismissal": (self.dismissal.to_payload() if self.dismissal else None),
            "dismissed_but_retained": self.dismissed_but_retained,
            "demotion_reason": self.demotion_reason,
        })
        return payload


@dataclass(frozen=True)
class RankedReport:
    surfaced: Tuple[RankedFinding, ...]
    info: Tuple[RankedFinding, ...]
    demoted: Tuple[RankedFinding, ...]
    checks: Tuple[Dict[str, Any], ...]
    cap: int
    counts: Dict[str, int]
    policy_source: str

    def statement(self) -> str:
        """What the reader is being shown, and what they are not."""
        held = self.counts.get("held_back", 0)
        bits = ["%d finding(s) surfaced" % len(self.surfaced)]
        if held:
            bits.append("%d ranked below the cap of %d and listed under All "
                        "checks" % (held, self.cap))
        if self.counts.get("immaterial", 0):
            bits.append("%d below the materiality floor"
                        % self.counts["immaterial"])
        if self.counts.get("dismissed", 0):
            bits.append("%d dismissed with a recorded reason"
                        % self.counts["dismissed"])
        if self.counts.get("incomplete", 0):
            bits.append("%d demoted for missing a contract element"
                        % self.counts["incomplete"])
        return "; ".join(bits) + "."

    def to_payload(self) -> Dict[str, Any]:
        return {
            "surfaced": [r.to_payload() for r in self.surfaced],
            "info": [r.to_payload() for r in self.info],
            "demoted": [r.to_payload() for r in self.demoted],
            "checks": list(self.checks),
            "cap": self.cap,
            "counts": dict(self.counts),
            "materiality_policy": self.policy_source,
            "statement": self.statement(),
        }


def impact_component(materiality: MaterialityVerdict, severity: str) -> float:
    """How much this is worth, on 0..1.

    The quantified share against the floor that judged it, saturated, then
    weighted by severity. Severity alone was the baseline's whole ordering
    and it is why a `medium` note about 19.6% of the balance sheet sorted
    below a `high` note about a rounding difference.
    """
    floor = max(float(materiality.floor), 1e-9)
    reach = materiality.share / (floor * IMPACT_SATURATION)
    return SEVERITY_WEIGHT.get(severity, 0.15) * min(1.0, max(0.0, reach))


def confidence_component(finding: F.Finding) -> float:
    level = finding.confidence.level if finding.confidence else "low"
    return CONFIDENCE_WEIGHT.get(level, 0.55)


def persistence_component(consecutive: int) -> float:
    repeats = max(0, int(consecutive) - 1)
    return min(PERSISTENCE_CAP, 1.0 + PERSISTENCE_STEP * repeats)


def actionability_component(finding: F.Finding) -> float:
    """How close the action is to being executable.

    A step naming a horizon is a step someone can be held to; two steps
    that name an artefact and a provider is a plan. This is a property of
    the finding's own action element, so it is auditable — not a guess
    about how "useful" the text feels.
    """
    action = finding.action
    if action is None or not action.steps:
        return 0.5
    score = 0.7
    if len(action.steps) >= 2:
        score += 0.1
    dated = len([s for s in action.steps if (s.horizon or "").strip()])
    score += 0.1 * min(2, dated)
    return min(1.0, score)


def score_of(item: RankInput) -> ScoreBreakdown:
    impact = impact_component(item.materiality, item.finding.severity)
    conf = confidence_component(item.finding)
    pers = persistence_component(item.persistence)
    act = actionability_component(item.finding)
    return ScoreBreakdown(impact=impact, confidence=conf, persistence=pers,
                          actionability=act,
                          total=impact * conf * pers * act)


def persistence_label(consecutive: int) -> str:
    n = max(1, int(consecutive))
    if n == 1:
        return "first period this has fired"
    return "%s consecutive period" % _ordinal(n)


def rank_findings(items: Sequence[RankInput],
                  checks: Sequence[Dict[str, Any]] = (),
                  cap: int = DEFAULT_CAP,
                  dismissals: Optional[DismissalIndex] = None,
                  policy_source: str = POLICY_SOURCE_DEFAULT) -> RankedReport:
    """Materiality, then merge, then rank, then cap. In that order.

    Nothing is deleted at any step: a finding that does not surface ends
    up on the checks list with the reason it did not, which is what makes
    the surfaced seven a claim about the other sixteen rather than a claim
    about nothing.
    """
    index = dismissals or DismissalIndex(())
    counts = {"candidates": len(items), "immaterial": 0, "info": 0,
              "dismissed": 0, "incomplete": 0, "merged": 0, "held_back": 0}
    extra_checks = []  # type: List[Dict[str, Any]]

    # ── 1. contract completeness and materiality ────────────────────
    eligible = []  # type: List[RankInput]
    demoted = []  # type: List[RankedFinding]
    info_rows = []  # type: List[RankInput]
    for item in items:
        verdict = item.finding.verdict()
        if not verdict.surfaced:
            counts["incomplete"] += 1
            demoted.append(_ranked(item, 0, DISPOSITION_CHECKS,
                                   recommendation=False,
                                   demotion_reason="; ".join(verdict.reasons())))
            continue
        tier = item.materiality.tier
        if tier == TIER_IMMATERIAL:
            counts["immaterial"] += 1
            demoted.append(_ranked(
                item, 0, DISPOSITION_CHECKS, recommendation=False,
                effective_severity="info",
                demotion_reason="below the materiality floor: %s"
                                % item.materiality.statement()))
            continue
        if tier == TIER_INFO:
            counts["info"] += 1
            info_rows.append(item)
            continue
        eligible.append(item)

    # ── 2. one root cause is one finding ────────────────────────────
    groups = {}  # type: Dict[str, List[RankInput]]
    for item in eligible:
        groups.setdefault(item.root_cause or item.key(), []).append(item)

    primaries = []  # type: List[Tuple[RankInput, Tuple[str, ...], Tuple[str, ...]]]
    for root in sorted(groups):
        members = sorted(groups[root], key=lambda i: _order_key(i))
        primary = members[0]
        others = members[1:]
        counts["merged"] += len(others)
        merged_from = tuple(m.finding.rule_id for m in others)
        contributor_rules = tuple(sorted(set(
            list(primary.contributors)
            + [c for m in others for c in m.contributors])))
        for m in others:
            extra_checks.append({
                "rule_id": m.finding.rule_id,
                "parameter": (m.finding.threshold.parameter
                              if m.finding.threshold else ""),
                "comparator": (m.finding.threshold.comparator
                               if m.finding.threshold else ""),
                "limit": (m.finding.threshold.limit if m.finding.threshold else None),
                "observed": (m.finding.threshold.observed
                             if m.finding.threshold else None),
                "unit": (m.finding.threshold.unit if m.finding.threshold
                         else F.UNIT_UNKNOWN),
                "fired": True,
                "profile_id": m.finding.profile_id,
                "note": ("merged into %s — same root cause (%s)"
                         % (primary.finding.rule_id, root)),
            })
        primaries.append((primary, merged_from, contributor_rules))

    # ── 3. rank ─────────────────────────────────────────────────────
    ordered = sorted(primaries, key=lambda t: _order_key(t[0]))

    # ── 4. dismissals, then the cap ─────────────────────────────────
    surfaced = []  # type: List[RankedFinding]
    held = []  # type: List[RankedFinding]
    position = 0
    for primary, merged_from, contributor_rules in ordered:
        dismissal = index.match(primary.finding.rule_id,
                                primary.scope_key or primary.root_cause,
                                primary.period_ordinal)
        is_critical = primary.finding.severity == "critical"
        if dismissal is not None and not is_critical:
            counts["dismissed"] += 1
            held.append(_ranked(
                primary, 0, DISPOSITION_CHECKS, recommendation=False,
                merged_from=merged_from, contributor_rules=contributor_rules,
                dismissal=dismissal,
                demotion_reason="dismissed: %s" % (dismissal.reason
                                                   or "no reason recorded")))
            continue
        if len(surfaced) >= max(0, int(cap)):
            counts["held_back"] += 1
            held.append(_ranked(
                primary, 0, DISPOSITION_CHECKS, recommendation=False,
                merged_from=merged_from, contributor_rules=contributor_rules,
                demotion_reason="ranked below the cap of %d surfaced findings"
                                % cap))
            continue
        position += 1
        surfaced.append(_ranked(
            primary, position, DISPOSITION_SURFACED, recommendation=True,
            merged_from=merged_from, contributor_rules=contributor_rules,
            dismissal=dismissal,
            dismissed_but_retained=(dismissal is not None and is_critical)))
        if dismissal is not None and is_critical:
            counts["dismissed"] += 1

    # Info rows obey the same one-root-cause rule. Three sub-floor views
    # of one balance is the generic-findings failure at a smaller size,
    # and it would push the genuinely separate small items off the page.
    info_ranked = []  # type: List[RankedFinding]
    info_groups = {}  # type: Dict[str, List[RankInput]]
    for item in info_rows:
        info_groups.setdefault(item.root_cause or item.key(), []).append(item)
    info_primaries = []  # type: List[Tuple[RankInput, Tuple[str, ...]]]
    for root in sorted(info_groups):
        members = sorted(info_groups[root], key=lambda i: _order_key(i))
        info_primaries.append(
            (members[0], tuple(m.finding.rule_id for m in members[1:])))
        counts["merged"] += len(members) - 1
        for m in members[1:]:
            extra_checks.append({
                "rule_id": m.finding.rule_id, "parameter": "", "comparator": "",
                "limit": None, "observed": None, "unit": F.UNIT_UNKNOWN,
                "fired": True, "profile_id": m.finding.profile_id,
                "note": ("merged into %s — same root cause (%s), below the "
                         "materiality floor" % (members[0].finding.rule_id, root)),
            })
    for item, merged in sorted(info_primaries, key=lambda t: _order_key(t[0])):
        info_ranked.append(_ranked(item, 0, DISPOSITION_INFO,
                                   recommendation=False,
                                   effective_severity="info",
                                   merged_from=merged))

    all_checks = list(checks) + extra_checks + [
        _check_from(r) for r in (held + demoted)]
    return RankedReport(
        surfaced=tuple(surfaced), info=tuple(info_ranked),
        demoted=tuple(held + demoted), checks=tuple(all_checks),
        cap=int(cap), counts=counts, policy_source=policy_source)


# ── internals ────────────────────────────────────────────────────────────


def _ranked(item: RankInput, position: int, disposition: str,
            recommendation: bool,
            effective_severity: Optional[str] = None,
            merged_from: Tuple[str, ...] = (),
            contributor_rules: Tuple[str, ...] = (),
            dismissal: Optional[Dismissal] = None,
            dismissed_but_retained: bool = False,
            demotion_reason: str = "") -> RankedFinding:
    return RankedFinding(
        finding=item.finding, rank=position, score=score_of(item),
        disposition=disposition,
        effective_severity=(effective_severity or item.finding.severity),
        materiality=item.materiality, persistence=item.persistence,
        persistence_label=persistence_label(item.persistence),
        root_cause=item.root_cause, recommendation=recommendation,
        merged_from=merged_from, contributor_rules=contributor_rules,
        dismissal=dismissal, dismissed_but_retained=dismissed_but_retained,
        demotion_reason=demotion_reason)


def _order_key(item: RankInput) -> Tuple[float, int, str, str]:
    """Total order. Score descending, then severity, then rule id, then
    scope — so two findings that score identically still sort the same way
    on every run and on every machine."""
    return (-score_of(item).total,
            SEVERITY_RANK.get(item.finding.severity, 9),
            item.finding.rule_id,
            item.scope_key or item.root_cause)


def _check_from(ranked: RankedFinding) -> Dict[str, Any]:
    record = ranked.finding.check_record().to_payload()
    note = record.get("note") or ""
    reason = ranked.demotion_reason
    record["note"] = "; ".join([bit for bit in (note, reason) if bit])
    record["disposition"] = ranked.disposition
    record["materiality"] = ranked.materiality.to_payload()
    if ranked.dismissal is not None:
        record["dismissal"] = ranked.dismissal.to_payload()
    return record


def _pct(value: float) -> str:
    return "%.2f%%" % (float(value) * 100.0)


def _ordinal(n: int) -> str:
    if 10 <= (n % 100) <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return "%d%s" % (n, suffix)


def _opt_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


__all__ = [
    "DEFAULT_CAP", "DEFAULT_FLOORS", "DEFAULT_INFO_FRACTION",
    "DISPOSITION_CHECKS", "DISPOSITION_INFO", "DISPOSITION_SURFACED",
    "Dismissal", "DismissalIndex", "MaterialityBasisMissing",
    "MaterialityPolicy", "MaterialityVerdict", "RankInput", "RankedFinding",
    "RankedReport", "ScoreBreakdown", "SCOPE_ANY",
    "TIER_IMMATERIAL", "TIER_INFO", "TIER_MATERIAL",
    "actionability_component", "assess_materiality", "confidence_component",
    "impact_component", "persistence_component", "persistence_label",
    "rank_findings", "score_of",
]
