"""THE ATTENTION PACK — packs/firm/attention.yaml, parsed and validated.

The pack is the ONLY place an attention kind, its base severity, its
thresholds or its escalation ladder is written down. This module is the
reader. It contains no kind branch and no profile id; a detector asks
``pack.kind("CASH_RUNWAY")`` for its entry and
``pack.threshold(kind, parameter, profile_id)`` for the number that
judges THIS client, and receives the yaml address of that number so the
item can record where its grade came from.

Validation happens at LOAD time and refuses a malformed table outright:
a kind without a base severity, a disabled kind without an absence
reason, a `by_profile` override for a profile the country pack does not
declare, a materiality basis the ranker's policy does not know. A table
that fails cannot grade a single client — which is the right failure
mode for the thing that decides what an accountant looks at first.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from ._deps import company_profile as CP
from ._deps import finding_rank as R
from .model import SEVERITIES

#: packs/firm — resolved from this file so a source checkout and an
#: editable install agree. ``FIRM_PACKS_DIR`` overrides for containers
#: that mount the packs elsewhere.
DEFAULT_PACKS_DIR = Path(__file__).resolve().parents[3] / "packs" / "firm"
ATTENTION_PACK_NAME = "attention.yaml"

_UNIT_NAMES = ("money", "ratio", "percent", "days", "count", "score")
_ESCALATIONS = (None, "deadline", "age")
_COMPARATORS = (">=", ">", "<=", "<")


class AttentionPackError(ValueError):
    """attention.yaml is malformed. Raised at load, never at grade time."""


def packs_dir() -> Path:
    override = os.environ.get("FIRM_PACKS_DIR")
    return Path(override) if override else DEFAULT_PACKS_DIR


# ── Types ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DeadlineBand:
    max_days: Optional[int]
    step: int
    label: str


@dataclass(frozen=True)
class SeverityPolicy:
    ladder: Tuple[str, ...]
    materiality_steps: Dict[str, int]       # tier -> step
    saturation_multiple: float
    refused_cap: str
    deadline_bands: Tuple[DeadlineBand, ...]
    age_bands: Tuple[DeadlineBand, ...]
    persistence_min: int
    persistence_step: int

    def index(self, severity: str) -> int:
        return self.ladder.index(severity)

    def clamp(self, index: int) -> str:
        return self.ladder[max(0, min(len(self.ladder) - 1, index))]


@dataclass(frozen=True)
class ThresholdValue:
    """A threshold WITH ITS ADDRESS — the same discipline as
    ``_company_profile.ThresholdSpec``."""

    kind: str
    parameter: str
    label: str
    value: float
    unit: str
    source: str
    tuned: bool


@dataclass(frozen=True)
class KindSpec:
    kind: str
    order: int
    base_severity: str
    materiality_basis: Optional[str]
    escalates_on: Optional[str]
    enabled: bool
    absent_reason: str
    reason_template: str
    action_template: str
    deadline_rule: Optional[str]
    thresholds_units: Dict[str, str]
    thresholds_labels: Dict[str, str]
    thresholds_default: Dict[str, float]
    thresholds_by_profile: Dict[str, Dict[str, float]]
    extra: Dict[str, Any]                  # statute / covenant blocks, verbatim

    @property
    def source(self) -> str:
        return "attention.yaml#kinds.%s" % self.kind


class AttentionPack(object):
    """Parsed, validated attention.yaml. Immutable after construction."""

    def __init__(self, raw: Dict[str, Any], origin: str,
                 catalog: Optional["CP.ProfileCatalog"] = None,
                 policy: Optional["R.MaterialityPolicy"] = None) -> None:
        self.origin = origin
        self.version = str(raw.get("version") or "")
        if not self.version:
            raise AttentionPackError("%s: no version" % origin)
        self._raw = raw
        known_profiles = set(p.id for p in catalog.structural_profiles) if catalog else None
        known_bases = set((policy or R.MaterialityPolicy.default()).floors)

        sev = raw.get("severity") or {}
        ladder = tuple(str(s) for s in (sev.get("ladder") or ()))
        if not ladder or any(s not in SEVERITIES for s in ladder):
            raise AttentionPackError(
                "%s: severity.ladder must list rungs from %r" % (origin, SEVERITIES))
        mat = sev.get("materiality") or {}
        steps = {}  # type: Dict[str, int]
        for tier in (R.TIER_IMMATERIAL, R.TIER_INFO, R.TIER_MATERIAL, "saturated"):
            if tier not in mat:
                raise AttentionPackError(
                    "%s: severity.materiality lacks a step for %r" % (origin, tier))
            steps[tier] = int(mat[tier])
        refused_cap = str(mat.get("refused_cap") or "")
        if refused_cap not in ladder:
            raise AttentionPackError(
                "%s: severity.materiality.refused_cap %r is not on the ladder"
                % (origin, refused_cap))
        self.severity = SeverityPolicy(
            ladder=ladder, materiality_steps=steps,
            saturation_multiple=float(mat.get("saturation_multiple") or 10.0),
            refused_cap=refused_cap,
            deadline_bands=self._bands(sev.get("deadline_bands"), origin, "deadline_bands"),
            age_bands=self._bands(sev.get("age_bands"), origin, "age_bands"),
            persistence_min=int((sev.get("persistence") or {}).get("min_consecutive") or 3),
            persistence_step=int((sev.get("persistence") or {}).get("step") or 1),
        )

        # Cadence is NOT here: expected period ends, deadlines and the
        # stale verdict are packs/firm/cadence.yaml's (engine.firm.cadence).
        if "cadence" in raw:
            raise AttentionPackError(
                "%s: a `cadence:` block belongs in packs/firm/cadence.yaml, "
                "not here — two sources of truth for one deadline" % origin)

        self.closed_statuses = tuple(str(s) for s in (raw.get("closed_statuses") or ()))
        if not self.closed_statuses:
            raise AttentionPackError("%s: closed_statuses is empty" % origin)
        self.auto_reconcile_gate_share = float(raw.get("auto_reconcile_gate_share") or 0.0)
        self.deadline_window_days = int(raw.get("deadline_window_days") or 0)
        self.cash_row_ids = tuple(str(r) for r in (raw.get("cash_row_ids") or ()))
        if not self.cash_row_ids:
            raise AttentionPackError("%s: cash_row_ids is empty" % origin)

        kinds = {}  # type: Dict[str, KindSpec]
        for entry in raw.get("kinds") or ():
            kid = str(entry.get("kind") or "")
            if not kid:
                raise AttentionPackError("%s: a kind entry has no `kind`" % origin)
            if kid in kinds:
                raise AttentionPackError("%s: kind %r declared twice" % (origin, kid))
            base = str(entry.get("base_severity") or "")
            if base not in ladder:
                raise AttentionPackError(
                    "%s: kind %r base_severity %r is not on the ladder"
                    % (origin, kid, base))
            basis = entry.get("materiality")
            if basis is not None and str(basis) not in known_bases:
                raise AttentionPackError(
                    "%s: kind %r names materiality basis %r, which the ranker's "
                    "policy does not declare (%r)"
                    % (origin, kid, basis, sorted(known_bases)))
            esc = entry.get("escalates_on")
            if esc not in _ESCALATIONS:
                raise AttentionPackError(
                    "%s: kind %r escalates_on %r is not one of %r"
                    % (origin, kid, esc, _ESCALATIONS))
            enabled = entry.get("enabled")
            if not isinstance(enabled, bool):
                raise AttentionPackError(
                    "%s: kind %r must declare enabled: true|false" % (origin, kid))
            absent = str(entry.get("absent_reason") or "").strip()
            if not enabled and not absent:
                raise AttentionPackError(
                    "%s: kind %r is disabled without an absent_reason — a kind "
                    "that emits nothing must say why" % (origin, kid))
            thresholds = entry.get("thresholds") or {}
            units = dict(thresholds.get("units") or {})
            labels = dict(thresholds.get("labels") or {})
            default = dict(thresholds.get("default") or {})
            by_profile = dict((str(k), dict(v))
                              for k, v in (thresholds.get("by_profile") or {}).items())
            if set(units) != set(default) or set(labels) != set(default):
                raise AttentionPackError(
                    "%s: kind %r must declare a unit AND a label for every "
                    "default threshold" % (origin, kid))
            for pname, uname in units.items():
                if uname not in _UNIT_NAMES:
                    raise AttentionPackError(
                        "%s: kind %r declares unknown unit %r for %r"
                        % (origin, kid, uname, pname))
            for pid, overrides in by_profile.items():
                if known_profiles is not None and pid not in known_profiles:
                    raise AttentionPackError(
                        "%s: kind %r overrides unknown profile %r (profiles.yaml "
                        "declares %r)" % (origin, kid, pid, sorted(known_profiles)))
                extra_keys = set(overrides) - set(default)
                if extra_keys:
                    raise AttentionPackError(
                        "%s: kind %r override for %r adds undeclared parameters %r"
                        % (origin, kid, pid, sorted(extra_keys)))
            reason = str(entry.get("reason_en") or "").strip()
            action = str(entry.get("action_en") or "").strip()
            if not reason or not action:
                raise AttentionPackError(
                    "%s: kind %r needs reason_en and action_en" % (origin, kid))
            extra = {}  # type: Dict[str, Any]
            for key in ("statute", "covenant_schema", "covenant_metrics"):
                if key in entry:
                    extra[key] = entry[key]
            if "covenant_metrics" in extra:
                for mid, mspec in extra["covenant_metrics"].items():
                    if not isinstance(mspec, dict) or not mspec.get("accessor"):
                        raise AttentionPackError(
                            "%s: kind %r covenant metric %r names no accessor"
                            % (origin, kid, mid))
            kinds[kid] = KindSpec(
                kind=kid, order=int(entry.get("order") or 0), base_severity=base,
                materiality_basis=(None if basis is None else str(basis)),
                escalates_on=(None if esc is None else str(esc)),
                enabled=enabled, absent_reason=absent,
                reason_template=reason, action_template=action,
                deadline_rule=(str(entry["deadline_rule"])
                               if entry.get("deadline_rule") else None),
                thresholds_units=units, thresholds_labels=labels,
                thresholds_default=dict((k, float(v)) for k, v in default.items()),
                thresholds_by_profile=by_profile, extra=extra)
        if not kinds:
            raise AttentionPackError("%s: no kinds" % origin)
        self.kinds = kinds

    @staticmethod
    def _bands(raw: Any, origin: str, name: str) -> Tuple[DeadlineBand, ...]:
        bands = []  # type: List[DeadlineBand]
        for b in raw or ():
            max_days = b.get("max_days")
            bands.append(DeadlineBand(
                max_days=(None if max_days is None else int(max_days)),
                step=int(b.get("step") or 0), label=str(b.get("label") or "")))
        if not bands or bands[-1].max_days is not None:
            raise AttentionPackError(
                "%s: severity.%s must end with an open-ended band (max_days: null)"
                % (origin, name))
        return tuple(bands)

    # -- lookups ---------------------------------------------------------

    def kind(self, kind_id: str) -> KindSpec:
        if kind_id not in self.kinds:
            raise AttentionPackError(
                "kind %r is not declared in %s — declare it there, do not "
                "hard-code it" % (kind_id, self.origin))
        return self.kinds[kind_id]

    def kind_ids(self) -> Tuple[str, ...]:
        return tuple(k for k, _ in sorted(self.kinds.items(),
                                          key=lambda kv: (kv[1].order, kv[0])))

    def enabled_kind_ids(self) -> Tuple[str, ...]:
        return tuple(k for k in self.kind_ids() if self.kinds[k].enabled)

    def absent_kinds(self) -> List[Dict[str, str]]:
        """Every declared kind that emits nothing, with its reason —
        surfaced on the payload so an absent kind is a stated absence."""
        return [{"kind": k, "reason": self.kinds[k].absent_reason}
                for k in self.kind_ids() if not self.kinds[k].enabled]

    def threshold(self, kind_id: str, parameter: str,
                  profile_id: Optional[str]) -> ThresholdValue:
        """The parameter value that judges THIS client, with the yaml
        address that produced it. ``profile_id`` is an OPAQUE key into
        the table — it is never compared to anything in code."""
        spec = self.kind(kind_id)
        if parameter not in spec.thresholds_default:
            raise AttentionPackError(
                "kind %r declares no parameter %r (has %r)"
                % (kind_id, parameter, sorted(spec.thresholds_default)))
        overrides = spec.thresholds_by_profile.get(profile_id or "") or {}
        tuned = parameter in overrides
        value = float(overrides[parameter] if tuned else spec.thresholds_default[parameter])
        source = "attention.yaml#kinds.%s.thresholds.%s.%s" % (
            kind_id, ("by_profile.%s" % profile_id) if tuned else "default", parameter)
        return ThresholdValue(
            kind=kind_id, parameter=parameter,
            label=str(spec.thresholds_labels[parameter]), value=value,
            unit=str(spec.thresholds_units[parameter]), source=source, tuned=tuned)

    def fingerprint(self) -> str:
        blob = json.dumps(self._raw, sort_keys=True, ensure_ascii=False, default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]

    def to_payload(self) -> Dict[str, Any]:
        return {
            "version": self.version, "origin": self.origin,
            "fingerprint": self.fingerprint(),
            "kinds": list(self.kind_ids()),
            "enabled_kinds": list(self.enabled_kind_ids()),
            "absent_kinds": self.absent_kinds(),
            "ladder": list(self.severity.ladder),
        }


_CACHE = {}  # type: Dict[Tuple[str, float, str], AttentionPack]


def load_attention_pack(path: Optional[str] = None,
                        catalog: Optional["CP.ProfileCatalog"] = None,
                        policy: Optional["R.MaterialityPolicy"] = None) -> AttentionPack:
    """Parse + validate attention.yaml. Cached by (path, mtime, catalog
    fingerprint) so a long-lived process picks up an edited table
    without a restart and never re-parses per client."""
    target = Path(path) if path else packs_dir() / ATTENTION_PACK_NAME
    try:
        mtime = os.path.getmtime(str(target))
    except OSError as exc:
        raise AttentionPackError("cannot read %s: %s" % (target, exc))
    cat = catalog or CP.load_catalog()
    key = (str(target), mtime, cat.fingerprint())
    if key not in _CACHE:
        with open(str(target), "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh)
        if not isinstance(raw, dict):
            raise AttentionPackError("%s: top level must be a mapping" % target)
        _CACHE[key] = AttentionPack(raw, origin=str(target), catalog=cat, policy=policy)
    return _CACHE[key]


__all__ = [
    "ATTENTION_PACK_NAME", "AttentionPack", "AttentionPackError",
    "DEFAULT_PACKS_DIR", "DeadlineBand", "KindSpec", "SeverityPolicy",
    "ThresholdValue", "load_attention_pack", "packs_dir",
]
