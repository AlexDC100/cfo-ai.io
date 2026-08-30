"""THE COMPANY PROFILE — who this period belongs to, derived from its own data.

A finding's WHY-HERE element is only honest if something upstream actually
knows what kind of company this is. That is this module. It reads the
period's own canonical views and answers, deterministically:

    size band        revenue AND assets, higher band wins
    structure        CAEN when known, otherwise inferred from the ACCOUNT
                     MIX — inventory-heavy, receivables-heavy,
                     fixed-asset-heavy, service, property-rental, holding
    signals          related-party balances, bank debt, leases, FX
                     exposure, payroll scale — each PRESENT / ABSENT /
                     UNKNOWN, never a fabricated zero
    financing        who actually reads a leverage finding here

WHERE THE KNOWLEDGE LIVES
Not here. `country_packs/ro_romania/profiles.yaml` holds every profile
definition, every detection rule, every detector's applicability and every
threshold. This module is the READER. It contains no profile name, no
threshold number, and no `if profile == ...` — and neither may any
detector: `tests/engine/test_company_profile.py` token-scans the detector
modules for a quoted profile id or a comparison against one, in the N7
style, and fails the build on either.

ABSENT != ZERO
Every derived share is `None` when its inputs are missing, and a
detection rule that reads `None` simply does not match. A profile that
matches nothing resolves to the catalogue's declared FALLBACK, which is a
stated refusal ("structure not inferable") carrying a confidence caveat —
not a silent default that would let a tuned threshold be applied to a
company nobody classified.

BOUNDARY NOTE
The canonical sub-views are bound to short locals (`bs`, `pl`, `cf`)
before any `total_*` key is read. `scripts/check_import_boundary.py`
flags `<assembled-like>["total_*"]`, and it is right to: reading a total
off an expression that still spells "assembled" is the pattern the
serving gateway exists to replace. This module reads shares of totals for
CLASSIFICATION only and never serves a total to a user.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from . import _finding, _ratio_units

#: Where the DATA lives. Resolved from this file so an editable install
#: (what the container runs) and a source checkout agree.
DEFAULT_PROFILES_PATH = (
    Path(__file__).resolve().parents[1]
    / "country_packs" / "ro_romania" / "profiles.yaml"
)

STATE_PRESENT = "present"
STATE_ABSENT = "absent"
STATE_UNKNOWN = "unknown"

_UNIT_BY_NAME = {
    "money": _ratio_units.UNIT_MONEY,
    "ratio": _ratio_units.UNIT_RATIO,
    "percent": _ratio_units.UNIT_PERCENT,
    "days": _ratio_units.UNIT_DAYS,
    "count": _ratio_units.UNIT_COUNT,
    "score": _ratio_units.UNIT_SCORE,
}

#: The `requires:` vocabulary a structural profile / financing context may
#: use. A key outside this set is a catalogue error, raised at load time
#: rather than silently ignored — a mis-typed rule that never matches is
#: the worst possible failure mode for a classifier.
METRIC_KEYS = (
    "ppe_share_of_assets",
    "inventory_share_of_assets",
    "receivables_share_of_assets",
    "investments_share_of_assets",
    "debt_share_of_assets",
    "related_party_share_of_assets",
    "cash_share_of_assets",
    "asset_turnover",
)

CAVEAT_UNCLASSIFIED = "unclassified_profile"
CAVEAT_CAEN_DISAGREEMENT = "caen_structure_disagreement"
CAVEAT_SIGNAL_UNKNOWN = "signal_unknown"
CAVEAT_BS_DRIFT = "balance_sheet_drift"
CAVEAT_APPROX_CF = "approximated_cash_flow"


# ── Refusals ─────────────────────────────────────────────────────────────


class CatalogError(ValueError):
    """profiles.yaml is malformed. Raised at LOAD time so a bad table
    cannot classify a single company."""


class UnknownDetectorError(KeyError):
    """A detector asked for thresholds it has no entry for. The catalogue
    is the registry: an unregistered detector has no thresholds, and
    inventing one in code is the branch this design removes."""


class UnknownThresholdError(KeyError):
    """A detector asked for a parameter its entry does not declare."""


# ── Catalogue types ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class SizeBand:
    id: str
    adjective: str
    label: str
    rank: int
    revenue_max: Optional[float]
    assets_max: Optional[float]


@dataclass(frozen=True)
class StructuralProfile:
    id: str
    label: str
    describes: str
    priority: int
    requires: Dict[str, float]
    fallback: bool = False


@dataclass(frozen=True)
class SignalSpec:
    id: str
    label: str
    source_facts: Tuple[str, ...]
    present_when_abs_above: float


@dataclass(frozen=True)
class FinancingSpec:
    id: str
    label: str
    audience: str
    requires_signals: Tuple[str, ...]
    requires: Dict[str, float]


@dataclass(frozen=True)
class DetectorSpec:
    id: str
    category: str
    profiles: Tuple[str, ...]        # ("all",) or explicit ids
    requires_signals: Tuple[str, ...]
    units: Dict[str, str]
    labels: Dict[str, str]
    default: Dict[str, float]
    by_profile: Dict[str, Dict[str, float]]
    why_here_default: str
    why_here_by_profile: Dict[str, str]

    def applies_to_all(self) -> bool:
        return "all" in self.profiles


@dataclass(frozen=True)
class Signal:
    id: str
    label: str
    state: str
    value: Optional[float]
    basis: str

    def is_present(self) -> bool:
        return self.state == STATE_PRESENT

    def is_unknown(self) -> bool:
        return self.state == STATE_UNKNOWN


@dataclass(frozen=True)
class ThresholdSpec:
    """A threshold WITH ITS ADDRESS. `source` is the path inside
    profiles.yaml that produced the number, which is what a Finding
    records so a reader can always find the rule that judged them."""

    detector_id: str
    parameter: str
    parameter_label: str
    value: float
    unit: str
    source: str
    profile_id: str
    tuned: bool                       # True == a by_profile override


@dataclass(frozen=True)
class Applicability:
    applies: bool
    reason: str
    caveats: Tuple[str, ...] = ()


class ProfileCatalog(object):
    """Parsed, validated profiles.yaml. Immutable after construction."""

    def __init__(self, raw: Dict[str, Any], origin: str) -> None:
        self.origin = origin
        self.version = str(raw.get("version") or "")
        self.currency = str(raw.get("currency") or "RON").upper()
        if not self.version:
            raise CatalogError("%s: no version" % origin)

        self.size_bands = tuple(sorted(
            (SizeBand(
                id=str(b["id"]), adjective=str(b["adjective_en"]),
                label=str(b["label_en"]), rank=int(b["rank"]),
                revenue_max=_opt_float(b.get("revenue_max")),
                assets_max=_opt_float(b.get("assets_max")),
            ) for b in raw.get("size_bands") or ()),
            key=lambda b: b.rank,
        ))
        if not self.size_bands:
            raise CatalogError("%s: no size bands" % origin)

        profiles = []  # type: List[StructuralProfile]
        for p in raw.get("structural_profiles") or ():
            requires = dict(p.get("requires") or {})
            for key in requires:
                metric, _cmp = _split_requirement(key)
                if metric not in METRIC_KEYS:
                    raise CatalogError(
                        "%s: structural profile %r requires unknown metric %r"
                        % (origin, p.get("id"), key))
            profiles.append(StructuralProfile(
                id=str(p["id"]), label=str(p["label_en"]),
                describes=str(p.get("describes") or "").strip(),
                priority=int(p.get("priority") or 0),
                requires=requires, fallback=bool(p.get("fallback")),
            ))
        self.structural_profiles = tuple(
            sorted(profiles, key=lambda p: (-p.priority, p.id)))
        fallbacks = [p for p in self.structural_profiles if p.fallback]
        if len(fallbacks) != 1:
            raise CatalogError(
                "%s: exactly one structural profile must be marked "
                "`fallback: true` (found %d)" % (origin, len(fallbacks)))
        self.fallback_profile = fallbacks[0]
        self._profiles_by_id = dict((p.id, p) for p in self.structural_profiles)

        self.caen_division_profiles = {}  # type: Dict[str, str]
        for division, pid in (raw.get("caen_division_profiles") or {}).items():
            if pid not in self._profiles_by_id:
                raise CatalogError(
                    "%s: CAEN %s maps to unknown profile %r" % (origin, division, pid))
            self.caen_division_profiles[str(division)] = str(pid)

        self.signals = tuple(SignalSpec(
            id=str(s["id"]), label=str(s["label_en"]),
            source_facts=tuple(str(f) for f in s.get("source_facts") or ()),
            present_when_abs_above=float(s.get("present_when_abs_above") or 0.0),
        ) for s in raw.get("signals") or ())
        self._signals_by_id = dict((s.id, s) for s in self.signals)

        financings = []  # type: List[FinancingSpec]
        for f in raw.get("financing_contexts") or ():
            requires = dict(f.get("requires") or {})
            for key in requires:
                metric, _cmp = _split_requirement(key)
                if metric not in METRIC_KEYS:
                    raise CatalogError(
                        "%s: financing context %r requires unknown metric %r"
                        % (origin, f.get("id"), key))
            for sid in f.get("requires_signals") or ():
                if sid not in self._signals_by_id:
                    raise CatalogError(
                        "%s: financing context %r requires unknown signal %r"
                        % (origin, f.get("id"), sid))
            financings.append(FinancingSpec(
                id=str(f["id"]), label=str(f["label_en"]),
                audience=str(f.get("audience") or ""),
                requires_signals=tuple(str(s) for s in f.get("requires_signals") or ()),
                requires=requires,
            ))
        self.financing_contexts = tuple(financings)
        if not self.financing_contexts:
            raise CatalogError("%s: no financing contexts" % origin)

        detectors = {}  # type: Dict[str, DetectorSpec]
        for d in raw.get("detectors") or ():
            did = str(d["detector"])
            applies = d.get("applies_to") or {}
            thresholds = d.get("thresholds") or {}
            units = dict(thresholds.get("units") or {})
            labels = dict(thresholds.get("labels") or {})
            default = dict(thresholds.get("default") or {})
            by_profile = dict(
                (str(k), dict(v)) for k, v in (thresholds.get("by_profile") or {}).items())
            if set(units) != set(default) or set(labels) != set(default):
                raise CatalogError(
                    "%s: detector %r must declare a unit AND a label for every "
                    "default threshold (units=%r labels=%r default=%r)"
                    % (origin, did, sorted(units), sorted(labels), sorted(default)))
            for key, unit_name in units.items():
                if unit_name not in _UNIT_BY_NAME:
                    raise CatalogError(
                        "%s: detector %r declares unknown unit %r for %r"
                        % (origin, did, unit_name, key))
            for pid, overrides in by_profile.items():
                if pid not in self._profiles_by_id:
                    raise CatalogError(
                        "%s: detector %r overrides unknown profile %r"
                        % (origin, did, pid))
                extra = set(overrides) - set(default)
                if extra:
                    raise CatalogError(
                        "%s: detector %r override for %r adds undeclared "
                        "parameters %r" % (origin, did, pid, sorted(extra)))
            for pid in applies.get("profiles") or ():
                if pid != "all" and pid not in self._profiles_by_id:
                    raise CatalogError(
                        "%s: detector %r applies to unknown profile %r"
                        % (origin, did, pid))
            for sid in applies.get("requires_signals") or ():
                if sid not in self._signals_by_id:
                    raise CatalogError(
                        "%s: detector %r requires unknown signal %r"
                        % (origin, did, sid))
            why = d.get("why_here") or {}
            why_default = str(why.get("default") or "").strip()
            if not why_default:
                raise CatalogError(
                    "%s: detector %r has no default why-here copy" % (origin, did))
            why_by_profile = dict(
                (str(k), str(v).strip()) for k, v in (why.get("by_profile") or {}).items())
            for pid in why_by_profile:
                if pid not in self._profiles_by_id:
                    raise CatalogError(
                        "%s: detector %r has why-here copy for unknown profile %r"
                        % (origin, did, pid))
            detectors[did] = DetectorSpec(
                id=did, category=str(d.get("category") or ""),
                profiles=tuple(str(p) for p in (applies.get("profiles") or ("all",))),
                requires_signals=tuple(
                    str(s) for s in applies.get("requires_signals") or ()),
                units=units, labels=labels, default=default, by_profile=by_profile,
                why_here_default=why_default, why_here_by_profile=why_by_profile,
            )
        self.detectors = detectors
        if not self.detectors:
            raise CatalogError("%s: no detectors" % origin)

        self.confidence_caveats = dict(
            (str(k), str(v).strip())
            for k, v in (raw.get("confidence_caveats") or {}).items())

    # -- lookups ---------------------------------------------------------

    def profile(self, profile_id: str) -> StructuralProfile:
        return self._profiles_by_id[profile_id]

    def signal_spec(self, signal_id: str) -> SignalSpec:
        return self._signals_by_id[signal_id]

    def detector(self, detector_id: str) -> DetectorSpec:
        if detector_id not in self.detectors:
            raise UnknownDetectorError(
                "detector %r is not registered in %s — register it there, do "
                "not hard-code its thresholds" % (detector_id, self.origin))
        return self.detectors[detector_id]

    def caveat_text(self, caveat_id: str) -> str:
        return self.confidence_caveats.get(caveat_id, "")

    def fingerprint(self) -> str:
        return _sha(self.version + "|" + "|".join(sorted(self.detectors)))


_CACHE = {}  # type: Dict[Tuple[str, float], ProfileCatalog]


def load_catalog(path: Optional[str] = None) -> ProfileCatalog:
    """Parse + validate profiles.yaml. Cached by (path, mtime) so a
    long-lived process picks up an edited table without a restart while
    never re-parsing per finding."""
    target = Path(path) if path else DEFAULT_PROFILES_PATH
    try:
        mtime = os.path.getmtime(str(target))
    except OSError as exc:
        raise CatalogError("cannot read %s: %s" % (target, exc))
    key = (str(target), mtime)
    if key not in _CACHE:
        with open(str(target), "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh)
        if not isinstance(raw, dict):
            raise CatalogError("%s: top level must be a mapping" % target)
        _CACHE[key] = ProfileCatalog(raw, origin=str(target))
    return _CACHE[key]


# ── The profile ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CompanyProfile:
    """What a detector is allowed to know about the company. Read-only,
    deterministic, and derived entirely from the period's own data."""

    catalog: ProfileCatalog
    period_id: str
    currency: str
    size_band: SizeBand
    structure: StructuralProfile
    sector_source: str                 # "caen+structure" | "structure_over_caen" | "structure"
    sector_label: str
    caen: Optional[str]
    financing: FinancingSpec
    signals: Dict[str, Signal]
    metrics: Dict[str, Optional[float]]
    figures: Dict[str, Optional[float]]
    caveat_ids: Tuple[str, ...]
    provenance: _finding.Provenance

    # -- identity --------------------------------------------------------

    @property
    def profile_id(self) -> str:
        """The id a Finding records as the profile that QUALIFIED it."""
        return self.structure.id

    @property
    def profile_label(self) -> str:
        return "%s %s" % (self.size_band.adjective, self.structure.label)

    @property
    def composite_id(self) -> str:
        return "%s/%s/%s" % (self.structure.id, self.size_band.id, self.financing.id)

    def fingerprint(self) -> str:
        return _sha(json.dumps(self.to_payload(), sort_keys=True, ensure_ascii=False))

    def anchors(self) -> Tuple[str, ...]:
        """Tokens that make a sentence about THIS company. The Finding's
        why-here validator requires the rationale to contain one; the
        profile supplies them so a detector cannot forget to."""
        out = [self.profile_label, self.structure.label, self.size_band.label,
               self.sector_label, self.financing.label]
        for sig in self.present_signals():
            out.append(sig.label)
        if self.caen:
            out.append("CAEN %s" % self.caen)
        return tuple(a for a in out if (a or "").strip())

    def provenance_for(self, line_refs: Tuple[str, ...] = ()) -> _finding.Provenance:
        """The period-level provenance with a detector's own line
        references attached. The bare `provenance` field carries only what
        the PROFILE knows (period + snapshot); a finding's evidence must
        name the lines it actually read, and the contract's evidence check
        demotes it if it does not."""
        return _finding.Provenance(
            period_id=self.provenance.period_id,
            snapshot_id=self.provenance.snapshot_id,
            line_refs=tuple(line_refs),
            source=self.provenance.source,
        )

    # -- signals ---------------------------------------------------------

    def signal(self, signal_id: str) -> Signal:
        return self.signals[signal_id]

    def has_signal(self, signal_id: str) -> bool:
        sig = self.signals.get(signal_id)
        return bool(sig is not None and sig.is_present())

    def present_signals(self) -> List[Signal]:
        return [self.signals[k] for k in sorted(self.signals)
                if self.signals[k].is_present()]

    # -- detector wiring -------------------------------------------------

    def applies(self, detector_id: str) -> Applicability:
        """Does this detector run for this company? Profile membership
        and signal preconditions, both read from the catalogue.

        A required signal that is UNKNOWN does not block the detector —
        it runs and carries a caveat. Blocking on unknown would silently
        drop findings for periods whose books simply do not carry the
        field yet; asserting absence would be worse."""
        spec = self.catalog.detector(detector_id)
        if not spec.applies_to_all() and self.structure.id not in spec.profiles:
            return Applicability(
                False,
                "detector %s is scoped to %s; this period is %s"
                % (detector_id, ", ".join(spec.profiles), self.structure.id))
        caveats = []  # type: List[str]
        for sid in spec.requires_signals:
            sig = self.signals.get(sid)
            if sig is None or sig.state == STATE_ABSENT:
                return Applicability(
                    False,
                    "detector %s needs the %s signal, which is absent for this period"
                    % (detector_id, sid))
            if sig.is_unknown():
                caveats.append(CAVEAT_SIGNAL_UNKNOWN)
        return Applicability(True, "detector %s applies to %s"
                             % (detector_id, self.structure.id), tuple(caveats))

    def threshold(self, detector_id: str, parameter: str) -> ThresholdSpec:
        """The parameter value that judges THIS company, with the
        profiles.yaml address that produced it."""
        spec = self.catalog.detector(detector_id)
        if parameter not in spec.default:
            raise UnknownThresholdError(
                "detector %r declares no parameter %r (has %r) in %s"
                % (detector_id, parameter, sorted(spec.default), self.catalog.origin))
        overrides = spec.by_profile.get(self.structure.id) or {}
        tuned = parameter in overrides
        value = float(overrides[parameter] if tuned else spec.default[parameter])
        source = "profiles.yaml#detectors.%s.thresholds.%s.%s" % (
            detector_id,
            ("by_profile.%s" % self.structure.id) if tuned else "default",
            parameter,
        )
        return ThresholdSpec(
            detector_id=detector_id, parameter=parameter,
            parameter_label=str(spec.labels[parameter]),
            value=value, unit=_UNIT_BY_NAME[spec.units[parameter]],
            source=source, profile_id=self.structure.id, tuned=tuned,
        )

    def thresholds(self, detector_id: str) -> Dict[str, ThresholdSpec]:
        spec = self.catalog.detector(detector_id)
        return dict((p, self.threshold(detector_id, p)) for p in sorted(spec.default))

    def category_for(self, detector_id: str) -> str:
        """The alert CATEGORY, from the table. It is persisted against a
        DB CHECK constraint, so it is data like everything else — a
        detector inventing one in code would fail at insert."""
        return self.catalog.detector(detector_id).category

    def detector_ids(self) -> Tuple[str, ...]:
        """Every registered detector, in a stable order. A lane iterating
        this cannot silently skip a detector by forgetting to list it."""
        return tuple(sorted(self.catalog.detectors))

    def applicable_detector_ids(self) -> Tuple[str, ...]:
        """The subset that runs for THIS company. The complement is not a
        silence — each one has an `applies()` reason, which belongs on the
        raw "All checks" list."""
        return tuple(d for d in self.detector_ids() if self.applies(d).applies)

    def why_here(self, detector_id: str, scope: str = "") -> _finding.WhyHere:
        """The WHY-HERE element, rendered from catalogue copy against this
        company's own profile tokens. Returns the Finding type directly so
        a detector cannot assemble a company-agnostic one by hand."""
        spec = self.catalog.detector(detector_id)
        template = spec.why_here_by_profile.get(
            self.structure.id, spec.why_here_default)
        rationale = _render_tokens(template, {
            "profile_label": self.profile_label,
            "size_label": self.size_band.label,
            "sector_label": self.sector_label,
            "financing_label": self.financing.label,
            "financing_audience": self.financing.audience,
            "signal_labels": ", ".join(s.label for s in self.present_signals())
                             or "no structural signals",
            "scope": scope or self.structure.label,
        })
        signals = tuple(s.id for s in self.present_signals()) or (
            self.financing.id,)
        return _finding.WhyHere(
            profile_id=self.structure.id,
            profile_label=self.profile_label,
            rationale=rationale,
            signals=signals,
            anchors=self.anchors(),
        )

    def confidence(self, detector_id: Optional[str] = None,
                   extra_caveats: Tuple[str, ...] = ()) -> _finding.Confidence:
        """The CONFIDENCE element. A finding with nothing to caveat still
        gets an explicit position — "we looked, and the inputs are clean"
        is a claim, and it is not the same claim as silence."""
        ids = list(self.caveat_ids)
        if detector_id:
            ids.extend(self.applies(detector_id).caveats)
        ids.extend(extra_caveats)
        seen = []  # type: List[str]
        for cid in ids:
            if cid and cid not in seen:
                seen.append(cid)
        basis = "profile %s resolved from %s" % (self.composite_id, self.sector_source)
        if not seen:
            return _finding.Confidence(level="high", basis=basis, caveat=None)
        texts = [self.catalog.caveat_text(cid) or cid for cid in seen]
        level = "low" if (CAVEAT_BS_DRIFT in seen or len(seen) >= 3) else "medium"
        return _finding.Confidence(
            level=level, basis=basis,
            caveat=" ".join(t.rstrip(".") + "." for t in texts),
        )

    # -- serialization ---------------------------------------------------

    def to_payload(self) -> Dict[str, Any]:
        return {
            "catalog_version": self.catalog.version,
            "period_id": self.period_id,
            "currency": self.currency,
            "profile_id": self.profile_id,
            "profile_label": self.profile_label,
            "composite_id": self.composite_id,
            "size_band": self.size_band.id,
            "structure": self.structure.id,
            "sector_source": self.sector_source,
            "sector_label": self.sector_label,
            "caen": self.caen,
            "financing": self.financing.id,
            "signals": dict(
                (k, {"state": v.state, "value": v.value, "basis": v.basis})
                for k, v in sorted(self.signals.items())),
            "metrics": dict(sorted(self.metrics.items())),
            "caveats": list(self.caveat_ids),
        }


# ── The builder ──────────────────────────────────────────────────────────


def build_company_profile(statements: Dict[str, Any],
                          period_id: str,
                          caen: Optional[str] = None,
                          catalog: Optional[ProfileCatalog] = None,
                          extra_facts: Optional[Dict[str, Any]] = None,
                          snapshot_id: Optional[str] = None) -> CompanyProfile:
    """Derive the profile from ONE period's assembled statements.

    `statements` is `assembled["statements"]`. Nothing else is consulted —
    no prior period, no registry lookup, no clock — so the same period
    always produces the same profile and the same fingerprint.
    """
    cat = catalog or load_catalog()
    stmts = statements or {}
    # Bound to short locals BEFORE any total_* read — see BOUNDARY NOTE.
    bs = dict(stmts.get("assembled_bs") or {})
    pl = dict(stmts.get("assembled_pl") or {})
    cf = dict(stmts.get("assembled_cf") or {})
    sub = dict(stmts.get("subAggregates") or {})
    legacy_bs = dict(stmts.get("balanceSheet") or {})
    legacy_pl = dict(stmts.get("incomeStatement") or {})
    currency = str(stmts.get("currency") or cat.currency or "RON").upper()

    facts = {}  # type: Dict[str, Any]
    for source in (legacy_bs, legacy_pl, sub, cf, pl, bs, dict(extra_facts or {})):
        for key, value in source.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            facts[key] = float(value)

    total_assets = _pick(bs, ("total_assets",))
    if total_assets is None:
        total_assets = _sum_present(legacy_bs, (
            "cash", "accountsReceivable", "inventory", "otherCurrentAssets",
            "propertyPlantEquipment", "intangibles", "otherNonCurrentAssets"))
    revenue = _pick(pl, ("revenue",), legacy_pl, ("revenue",))
    inventory = _pick(bs, ("inventory",), legacy_bs, ("inventory",))
    receivables = _pick(bs, ("ar_net", "accounts_receivable"),
                        legacy_bs, ("accountsReceivable",))
    # `ppe_net` is already the tangible-asset TOTAL; `ppe_investment_net`
    # and `ppe_under_construction` are memo components inside it (EEI:
    # ppe_net 15.13M with investment 14.46M and CIP 2.16M sitting inside
    # a 15.66M non-current total). Summing them triple-counted the same
    # building and pushed the PP&E share above 1.0 of total assets.
    ppe = _pick(bs, ("ppe_net", "property_plant_equipment"),
                legacy_bs, ("propertyPlantEquipment",))
    investments = _pick(bs, ("investments",))
    total_debt = _pick(bs, ("total_debt",))
    cash = _pick(bs, ("cash",), legacy_bs, ("cash",))
    related_party = _pick(bs, ("ar_intercompany",), sub, ("ar_intercompany",))

    figures = {
        "total_assets": total_assets, "revenue": revenue, "inventory": inventory,
        "receivables": receivables, "ppe": ppe, "investments": investments,
        "total_debt": total_debt, "cash": cash, "related_party": related_party,
    }
    metrics = {
        "ppe_share_of_assets": _share(ppe, total_assets, currency),
        "inventory_share_of_assets": _share(inventory, total_assets, currency),
        "receivables_share_of_assets": _share(receivables, total_assets, currency),
        "investments_share_of_assets": _share(investments, total_assets, currency),
        "debt_share_of_assets": _share(total_debt, total_assets, currency),
        "related_party_share_of_assets": _share(related_party, total_assets, currency),
        "cash_share_of_assets": _share(cash, total_assets, currency),
        "asset_turnover": _share(revenue, total_assets, currency),
    }

    signals = _build_signals(cat, facts)
    size_band = _resolve_size_band(cat, revenue, total_assets)
    structure, sector_source, caveats = _resolve_structure(cat, metrics, caen)
    financing = _resolve_financing(cat, metrics, signals)

    caveat_ids = list(caveats)
    drift = _pick(bs, ("bs_balance_delta",))
    if drift is not None and total_assets:
        drift_share = _share(abs(drift), total_assets, currency)
        if drift_share is not None and drift_share > 0.005:
            caveat_ids.append(CAVEAT_BS_DRIFT)
    if bool(cf.get("is_approximated")) or bool(stmts.get("cash_flow_approximated")):
        caveat_ids.append(CAVEAT_APPROX_CF)

    sector_label = ("CAEN %s" % caen) if caen else structure.label
    provenance = _finding.Provenance(
        period_id=period_id, snapshot_id=snapshot_id,
        line_refs=(), source="assembled_canonical_v1",
    )
    return CompanyProfile(
        catalog=cat, period_id=period_id, currency=currency,
        size_band=size_band, structure=structure, sector_source=sector_source,
        sector_label=sector_label, caen=(str(caen) if caen else None),
        financing=financing, signals=signals, metrics=metrics, figures=figures,
        caveat_ids=tuple(_dedupe(caveat_ids)), provenance=provenance,
    )


# ── Builder internals ────────────────────────────────────────────────────


def _build_signals(cat: ProfileCatalog, facts: Dict[str, Any]) -> Dict[str, Signal]:
    out = {}  # type: Dict[str, Signal]
    for spec in cat.signals:
        found = None  # type: Optional[Tuple[str, float]]
        for name in spec.source_facts:
            if name in facts:
                found = (name, float(facts[name]))
                break
        if found is None:
            out[spec.id] = Signal(
                spec.id, spec.label, STATE_UNKNOWN, None,
                "none of %s present in this period's views"
                % ", ".join(spec.source_facts))
            continue
        name, value = found
        state = (STATE_PRESENT if abs(value) > spec.present_when_abs_above
                 else STATE_ABSENT)
        out[spec.id] = Signal(spec.id, spec.label, state, value,
                              "read from %s" % name)
    return out


def _resolve_size_band(cat: ProfileCatalog, revenue: Optional[float],
                       assets: Optional[float]) -> SizeBand:
    """Higher of the revenue band and the asset band. A company with no
    revenue AND no assets lands in the lowest band — that is the honest
    read of an empty period, not a refusal."""
    def band_for(value: Optional[float], attr: str) -> SizeBand:
        if value is None:
            return cat.size_bands[0]
        for band in cat.size_bands:
            cap = getattr(band, attr)
            if cap is None or abs(float(value)) <= float(cap):
                return band
        return cat.size_bands[-1]

    by_revenue = band_for(revenue, "revenue_max")
    by_assets = band_for(assets, "assets_max")
    return by_revenue if by_revenue.rank >= by_assets.rank else by_assets


def _resolve_structure(cat: ProfileCatalog, metrics: Dict[str, Optional[float]],
                       caen: Optional[str]
                       ) -> Tuple[StructuralProfile, str, List[str]]:
    matched = None  # type: Optional[StructuralProfile]
    for spec in cat.structural_profiles:
        if spec.fallback or not spec.requires:
            continue
        if _requirements_met(spec.requires, metrics):
            matched = spec
            break

    caen_expected = None
    if caen:
        caen_expected = cat.caen_division_profiles.get(str(caen)[:2])

    caveats = []  # type: List[str]
    if matched is None and caen_expected is not None:
        # The books said nothing; the registry did. Take the registry
        # rather than refuse — and say where it came from.
        return cat.profile(caen_expected), "caen", caveats
    if matched is None:
        caveats.append(CAVEAT_UNCLASSIFIED)
        return cat.fallback_profile, "structure", caveats
    if caen_expected is None:
        return matched, "structure", caveats
    if caen_expected == matched.id:
        return matched, "caen+structure", caveats
    caveats.append(CAVEAT_CAEN_DISAGREEMENT)
    return matched, "structure_over_caen", caveats


def _resolve_financing(cat: ProfileCatalog, metrics: Dict[str, Optional[float]],
                       signals: Dict[str, Signal]) -> FinancingSpec:
    for spec in cat.financing_contexts:
        ok = True
        for sid in spec.requires_signals:
            sig = signals.get(sid)
            if sig is None or not sig.is_present():
                ok = False
                break
        if ok and _requirements_met(spec.requires, metrics):
            return spec
    return cat.financing_contexts[-1]


def _requirements_met(requires: Dict[str, float],
                      metrics: Dict[str, Optional[float]]) -> bool:
    """ABSENT != ZERO: an unknown metric fails the requirement rather than
    comparing as 0.0, so a profile is never inferred from a hole."""
    for key, limit in requires.items():
        metric, comparator = _split_requirement(key)
        value = metrics.get(metric)
        if value is None:
            return False
        if comparator == "min" and not value >= float(limit):
            return False
        if comparator == "max" and not value <= float(limit):
            return False
    return True


def _split_requirement(key: str) -> Tuple[str, str]:
    if key.endswith("_min"):
        return key[:-4], "min"
    if key.endswith("_max"):
        return key[:-4], "max"
    return key, ""


def _share(part: Optional[float], whole: Optional[float],
           currency: str) -> Optional[float]:
    """Every classification share goes through the ratio law: same unit,
    same currency, same scale, or nothing. `None` in, `None` out."""
    if part is None or whole is None:
        return None
    return _ratio_units.safe_ratio(
        _ratio_units.money(float(part), currency, name="part"),
        _ratio_units.money(float(whole), currency, name="whole"),
    )


def _pick(primary: Dict[str, Any], names: Tuple[str, ...],
          secondary: Optional[Dict[str, Any]] = None,
          secondary_names: Tuple[str, ...] = ()) -> Optional[float]:
    for name in names:
        if name in primary and _is_number(primary[name]):
            return float(primary[name])
    if secondary is not None:
        for name in secondary_names:
            if name in secondary and _is_number(secondary[name]):
                return float(secondary[name])
    return None


def _sum_present(source: Dict[str, Any], names: Tuple[str, ...]) -> Optional[float]:
    total = None  # type: Optional[float]
    for name in names:
        if name in source and _is_number(source[name]):
            total = float(source[name]) if total is None else total + float(source[name])
    return total


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _opt_float(value: Any) -> Optional[float]:
    return None if value is None else float(value)


def _dedupe(values: List[str]) -> List[str]:
    out = []  # type: List[str]
    for v in values:
        if v and v not in out:
            out.append(v)
    return out


def _render_tokens(template: str, tokens: Dict[str, str]) -> str:
    """Deliberately not `str.format`: catalogue copy contains prose that
    may hold a stray brace, and a KeyError there would take down an
    analysis for a typo. Unknown tokens are left visible instead."""
    text = " ".join((template or "").split())
    for key in sorted(tokens):
        text = text.replace("{%s}" % key, tokens[key])
    return text


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


__all__ = [
    "CompanyProfile", "ProfileCatalog", "Applicability", "Signal",
    "SignalSpec", "SizeBand", "StructuralProfile", "FinancingSpec",
    "DetectorSpec", "ThresholdSpec",
    "build_company_profile", "load_catalog",
    "CatalogError", "UnknownDetectorError", "UnknownThresholdError",
    "DEFAULT_PROFILES_PATH", "METRIC_KEYS",
    "STATE_PRESENT", "STATE_ABSENT", "STATE_UNKNOWN",
    "CAVEAT_UNCLASSIFIED", "CAVEAT_CAEN_DISAGREEMENT", "CAVEAT_SIGNAL_UNKNOWN",
    "CAVEAT_BS_DRIFT", "CAVEAT_APPROX_CF",
]
