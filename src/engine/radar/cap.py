"""THE SURFACED CAP — a ceiling on attention, declared as data, and one
rule it can never break.

Seven findings is a queue; sixty is a wall. The ranker already caps
(``_finding_rank.rank_findings``), but it caps by POSITION, so a Critical
that ranks eighth on a bad month is held back like anything else. Radar
cannot ship that: a Critical is the one row a reader must never discover
under "All checks". So this module owns the cap on the served surface,
with three properties the ranker's cap does not have:

  DATA-DECLARED   the ceiling is read from the country pack
                  (``profiles.yaml`` ``radar.surfaced_cap``) and the
                  policy SAYS where it came from; when the pack is silent
                  the ranker's own default applies and the policy says
                  that instead. No profile or company name is consulted
                  (N7) — one number for the jurisdiction.
  CRITICAL-PROOF  the cap applies BELOW Critical, and Critical is a
                  property of the GROUP, not of the primary row. The
                  ranker merges findings that share a root cause and
                  picks the primary by score, so a Critical with the
                  smaller share becomes a ``merged_from`` contributor of
                  a non-Critical primary; reading only the primary's
                  severity buried that Critical under the cap
                  (SERVE_GATES.md, A3). A group containing a Critical —
                  primary or contributor — is never held. If such groups
                  alone exceed the cap, all of them surface and the
                  decision says so. What the cap does NOT promise: a
                  Critical BELOW the materiality floor is an info row or
                  a check row by the ranker's own rule; the statement
                  counts those rather than claiming "every Critical
                  surfaces, always".
  DEMOTION, NOT DELETION  a finding held below the cap is demoted with
                  its reason recorded as a check row, so "we found 23 and
                  are showing you 7" is a claim the reader can open.

No clock, no model, no I/O beyond the one YAML read in
:meth:`CapPolicy.from_pack`. Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, replace
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import yaml

from engine.api import _company_profile as CP
from engine.api import _finding_rank as R

#: Where the pack declares the ceiling: ``radar: {surfaced_cap: N}`` at
#: the top level of ``profiles.yaml``. The same file carries the optional
#: ``materiality:`` block the ranker reads, so the two policies that
#: allocate attention live side by side.
PACK_BLOCK = "radar"
PACK_KEY = "surfaced_cap"

CAP_SOURCE_DEFAULT = "engine.api._finding_rank#DEFAULT_CAP"

#: The reason stamped on a finding held below the ceiling. One string,
#: so a gate can look for it and a reader can recognise it.
HELD_BELOW_CAP = "held below the Radar cap of %d surfaced finding(s)"

SEVERITY_CRITICAL = "critical"


#: (path, mtime_ns) -> CapPolicy. Invalidated by the file changing.
_POLICY_CACHE = {}  # type: Dict[Tuple[str, int], "CapPolicy"]


class CapPolicyError(ValueError):
    """The pack declares a cap that is not a positive integer. Raised at
    load rather than clamped: a cap of zero or a negative one is not a
    smaller cap, it is a misconfiguration."""


@dataclass(frozen=True)
class CapPolicy:
    """The ceiling, and where it came from."""

    cap: int
    source: str

    @classmethod
    def default(cls) -> "CapPolicy":
        return cls(cap=int(R.DEFAULT_CAP), source=CAP_SOURCE_DEFAULT)

    @classmethod
    def from_pack(cls, path: Optional[str] = None) -> "CapPolicy":
        """Read ``radar.surfaced_cap`` from the country pack's profiles
        file. Absent block or key -> the ranker's default, and the policy
        says so. A present-but-invalid value REFUSES. Memoised by
        (path, mtime) the way the profile catalogue is: the file is data
        and it is read on every open, so a re-parse per open is the cost
        of the warm path."""
        target = path or str(CP.DEFAULT_PROFILES_PATH)
        try:
            stamp = os.stat(target).st_mtime_ns
        except OSError:
            return cls.default()
        cached = _POLICY_CACHE.get((target, stamp))
        if cached is not None:
            return cached
        policy = cls._read(target)
        _POLICY_CACHE[(target, stamp)] = policy
        return policy

    @classmethod
    def _read(cls, target: str) -> "CapPolicy":
        try:
            with open(target, "r", encoding="utf-8") as fh:
                raw = yaml.safe_load(fh)
        except (OSError, yaml.YAMLError):
            return cls.default()
        block = (raw or {}).get(PACK_BLOCK) if isinstance(raw, dict) else None
        if not isinstance(block, dict) or PACK_KEY not in block:
            return cls.default()
        value = block.get(PACK_KEY)
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise CapPolicyError(
                "%s: %s.%s must be a positive integer, got %r"
                % (target, PACK_BLOCK, PACK_KEY, value))
        return cls(cap=int(value), source="%s#%s.%s" % (target, PACK_BLOCK, PACK_KEY))

    def to_payload(self) -> Dict[str, Any]:
        return {"cap": int(self.cap), "source": self.source}


@dataclass(frozen=True)
class CapDecision:
    """What the cap did. Every count here is reproducible from the two
    tuples; they are carried so the payload can state them without
    recounting. ``critical_below_floor`` is the ranker's, not the cap's
    — it is carried so the statement can say what is TRUE about
    Criticals rather than what the cap alone can promise."""

    surfaced: Tuple[R.RankedFinding, ...]
    held: Tuple[R.RankedFinding, ...]
    checks: Tuple[Dict[str, Any], ...]
    cap: int
    source: str
    critical_count: int
    exceeded_by_critical: bool
    critical_below_floor: int = 0

    @property
    def held_back(self) -> int:
        return len(self.held)

    def statement(self) -> str:
        bits = ["%d finding(s) surfaced under a cap of %d"
                % (len(self.surfaced), self.cap)]
        if self.exceeded_by_critical:
            bits.append("%d group(s) graded Critical at or above the "
                        "materiality floor exceed the cap on their own, so "
                        "every one of them is shown and nothing below "
                        "Critical is" % self.critical_count)
        elif self.critical_count:
            bits.append("every finding graded Critical at or above the "
                        "materiality floor surfaces (%d), exempt from the cap"
                        % self.critical_count)
        if self.critical_below_floor:
            bits.append("%d Critical(s) below the materiality floor are "
                        "listed under info or All checks with the reason, "
                        "not surfaced" % self.critical_below_floor)
        if self.held:
            bits.append("%d held below the cap and listed under All checks "
                        "with the reason" % len(self.held))
        return "; ".join(bits) + "."

    def to_payload(self) -> Dict[str, Any]:
        return {
            "cap": int(self.cap),
            "source": self.source,
            "surfaced": len(self.surfaced),
            "held_back": len(self.held),
            "critical_count": int(self.critical_count),
            "critical_below_floor": int(self.critical_below_floor),
            "exceeded_by_critical": bool(self.exceeded_by_critical),
            "statement": self.statement(),
        }


def group_severity(ranked: R.RankedFinding,
                   severity_by_rule: Optional[Mapping[str, str]] = None) -> str:
    """The most severe DETECTOR severity in the ranked row's group: the
    primary's own, and every ``merged_from`` contributor's as the caller
    looked it up. A contributor the caller cannot resolve counts as the
    primary's severity — never as Critical by default, never as info."""
    best = ranked.finding.severity
    rank = R.SEVERITY_RANK.get(best, 9)
    for rule_id in ranked.merged_from:
        member = (severity_by_rule or {}).get(rule_id)
        if member is None:
            continue
        member_rank = R.SEVERITY_RANK.get(member, 9)
        if member_rank < rank:
            best, rank = member, member_rank
    return best


def is_critical(ranked: R.RankedFinding,
                severity_by_rule: Optional[Mapping[str, str]] = None) -> bool:
    """Critical is a property of the GROUP. The detector's OWN severity
    of the primary or of any merged contributor — not the effective one:
    a Critical the ranker demoted to an info row is not on the surfaced
    list at all, and a surfaced Critical keeps its label."""
    return group_severity(ranked, severity_by_rule) == SEVERITY_CRITICAL


def order_key(ranked: R.RankedFinding) -> Tuple[float, int, str, str]:
    """The ranker's total order, restated over ranked rows so two lanes'
    surfaced lists merge the way one lane would have ranked them: score
    descending, severity, rule id, root cause. No dictionary order, no
    tie left to chance."""
    return (-float(ranked.score.total),
            R.SEVERITY_RANK.get(ranked.finding.severity, 9),
            ranked.finding.rule_id,
            ranked.root_cause)


def apply_cap(surfaced: Sequence[R.RankedFinding],
              policy: CapPolicy,
              severity_by_rule: Optional[Mapping[str, str]] = None,
              critical_below_floor: int = 0) -> CapDecision:
    """Apply the ceiling to the rows the ranker surfaced.

    Input: rows already judged material, merged, dismissed-or-retained
    and ranked (from one lane or several), plus the detector severity of
    every rule id a ``merged_from`` may name. Output: the rows that stay
    surfaced, renumbered 1..N in the merged order, and the rows held
    below the cap — each demoted with the reason on it and a check row
    that carries the same reason.

    The cap is applied BELOW Critical, where Critical is a property of
    the group. Critical groups fill their slots first and are never held;
    the remaining slots (if any) go to the highest-ranked non-Critical
    groups; the rest are held.
    """
    cap = max(1, int(policy.cap))
    ordered = sorted(surfaced, key=order_key)
    criticals = [r for r in ordered if is_critical(r, severity_by_rule)]
    others = [r for r in ordered if not is_critical(r, severity_by_rule)]
    slots = max(0, cap - len(criticals))
    keep_others = others[:slots]
    hold_others = others[slots:]

    kept = sorted(criticals + keep_others, key=order_key)
    renumbered = []  # type: List[R.RankedFinding]
    for position, row in enumerate(kept, start=1):
        renumbered.append(replace(row, rank=position))

    reason = HELD_BELOW_CAP % cap
    held = []  # type: List[R.RankedFinding]
    checks = []  # type: List[Dict[str, Any]]
    for row in hold_others:
        demoted = replace(
            row, rank=0, disposition=R.DISPOSITION_CHECKS,
            recommendation=False, demotion_reason=reason)
        held.append(demoted)
        checks.append(R._check_from(demoted))

    return CapDecision(
        surfaced=tuple(renumbered), held=tuple(held), checks=tuple(checks),
        cap=cap, source=policy.source, critical_count=len(criticals),
        exceeded_by_critical=(len(criticals) > cap),
        critical_below_floor=int(critical_below_floor))


__all__ = [
    "CAP_SOURCE_DEFAULT", "CapDecision", "CapPolicy", "CapPolicyError",
    "HELD_BELOW_CAP", "PACK_BLOCK", "PACK_KEY", "SEVERITY_CRITICAL",
    "apply_cap", "group_severity", "is_critical", "order_key",
]
