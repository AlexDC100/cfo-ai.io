"""DETECTORS AS PACK DATA.

A Radar detector is a ROW IN A YAML FILE, not a function someone
remembered to call. ``packs/<jurisdiction>/detectors.yaml`` declares the
whole of it — id, family, the accounts it is about, its parameters, the
severity a crossing earns, the citation that justifies the rule, the
copy a reader sees and whether it may run on a single period. The engine
supplies FAMILIES (the arithmetic); the pack supplies DETECTORS
(instances of that arithmetic, aimed at named accounts with named
numbers). Adding a detector is therefore an act of authoring data, and
``tests/engine/test_radar_detector_pack.py`` proves it by admitting a
fictional one through YAML alone and watching it surface.

WHY THE PARAMETERS CANNOT LIVE IN THE MODULE
TC-10: no cutoff is ever written as prose, and no cutoff is written in
code either. A finding renders its threshold FROM the row that produced
it — ``Threshold.source`` is the pack path plus the parameter's address,
so a reader who disagrees with a severity can open the exact line.

JURISDICTION IS AN OPAQUE STRING HERE
This module never names one. It takes whatever the caller resolved,
lower-cases it for the directory lookup and reads the file it finds. No
module in this package compares a jurisdiction value against anything,
and ``tests/engine/test_e8_jurisdiction_blindness.py`` scans the package
for that shape as it does for the AI-first-reader modules.

COLD START IS DECLARED, NOT REMEMBERED
``single_period_valid`` is a REQUIRED key. A new detector cannot forget
the rule that under three periods only single-period-valid detectors run,
because the loader refuses a row that does not answer the question.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import yaml

#: The file a jurisdiction's detectors live in, under its own directory.
PACK_FILENAME = "detectors.yaml"

#: Schema this loader understands. A pack declaring anything else is
#: refused rather than read optimistically.
SCHEMA_VERSION = "radar-detectors/1"

#: Periods below which only single-period-valid detectors may run. The
#: number is the product rule ("under 3 periods runs single-period-valid
#: detectors ONLY"), so it lives beside the flag that enforces it.
COLD_START_MIN_PERIODS = 3

SEVERITIES = ("critical", "high", "medium", "low", "info")


class DetectorPackError(ValueError):
    """The pack is malformed. Raised at load, never clamped — a detector
    with a missing severity is not a detector with a default severity."""


@dataclass(frozen=True)
class ActionSpec:
    imperative: str
    artefact: str
    provider: str
    horizon: Optional[str] = None


@dataclass(frozen=True)
class DetectorSpec:
    """One declared detector. Everything a family needs, and everything a
    finding must say about where its rule came from."""

    id: str
    family: str
    label: str
    scope: str
    category: str
    severity: str
    citation: str
    single_period_valid: bool
    accounts: Dict[str, Tuple[str, ...]]
    params: Dict[str, Any]
    why: str
    actions: Tuple[ActionSpec, ...]
    source: str
    min_periods: int = 2
    min_years: int = 0
    basis: Optional[str] = None
    #: A family whose output is a STATISTICAL SIGNAL rather than a
    #: verdict about conduct. The renderer is required to say so; see
    #: ``families.SIGNAL_SENTENCE``.
    signal_only: bool = False
    confidence_level: str = "high"
    confidence_basis: str = ""
    confidence_caveat: Optional[str] = None

    def prefixes(self, role: str) -> Tuple[str, ...]:
        return tuple(self.accounts.get(role, ()))

    def param(self, name: str) -> Any:
        if name not in self.params:
            raise DetectorPackError(
                "%s: detector %r declares no parameter %r; add it to %s"
                % (self.source, self.id, name, self.source))
        return self.params[name]

    def number(self, name: str) -> float:
        value = self.param(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise DetectorPackError(
                "%s: detector %r parameter %r must be a number, got %r"
                % (self.source, self.id, name, value))
        return float(value)

    def address(self, name: str) -> str:
        """The exact place a reader opens to see this number."""
        return "%s#detectors.%s.params.%s" % (self.source, self.id, name)


@dataclass(frozen=True)
class DetectorPack:
    jurisdiction: str
    pack_id: str
    path: str
    detectors: Tuple[DetectorSpec, ...] = ()

    def ids(self) -> Tuple[str, ...]:
        return tuple(d.id for d in self.detectors)

    def get(self, detector_id: str) -> DetectorSpec:
        for spec in self.detectors:
            if spec.id == detector_id:
                return spec
        raise DetectorPackError(
            "%s declares no detector %r (declared: %s)"
            % (self.path, detector_id, ", ".join(self.ids()) or "none"))


def pack_path(jurisdiction: str, root: str) -> str:
    """``<root>/<jurisdiction>/detectors.yaml``. The jurisdiction is used
    as a directory name and nothing else — it is never compared."""
    token = str(jurisdiction or "").strip().lower()
    if not token:
        raise DetectorPackError("no jurisdiction supplied to resolve a "
                                "detector pack against")
    return os.path.join(root, token, PACK_FILENAME)


def _require(raw: Dict[str, Any], key: str, where: str) -> Any:
    if key not in raw:
        raise DetectorPackError("%s: missing required key %r" % (where, key))
    return raw[key]


def _prefix_map(raw: Any, where: str) -> Dict[str, Tuple[str, ...]]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise DetectorPackError("%s: accounts must be a mapping, got %r" % (where, raw))
    out = {}  # type: Dict[str, Tuple[str, ...]]
    for role, prefixes in raw.items():
        if isinstance(prefixes, str):
            prefixes = [prefixes]
        if not isinstance(prefixes, (list, tuple)) or not prefixes:
            raise DetectorPackError(
                "%s: accounts.%s must be a non-empty list of code prefixes"
                % (where, role))
        out[str(role)] = tuple(str(p) for p in prefixes)
    return out


def _actions(raw: Any, where: str) -> Tuple[ActionSpec, ...]:
    if not isinstance(raw, list) or not raw:
        raise DetectorPackError(
            "%s: actions must be a non-empty list — a finding with no step is "
            "an observation, and the contract refuses one" % where)
    out = []  # type: List[ActionSpec]
    for i, step in enumerate(raw):
        if not isinstance(step, dict):
            raise DetectorPackError("%s: actions[%d] must be a mapping" % (where, i))
        out.append(ActionSpec(
            imperative=str(_require(step, "imperative", where)),
            artefact=str(_require(step, "artefact", where)),
            provider=str(_require(step, "provider", where)),
            horizon=(str(step["horizon"]) if step.get("horizon") else None)))
    return tuple(out)


def parse_pack(raw: Any, path: str, jurisdiction: str) -> DetectorPack:
    """Parse an already-read mapping. Separated from the file read so a
    caller can validate a pack it holds in memory."""
    if not isinstance(raw, dict):
        raise DetectorPackError("%s: the pack must be a mapping" % path)
    version = raw.get("schema_version")
    if version != SCHEMA_VERSION:
        raise DetectorPackError(
            "%s: schema_version is %r, this loader reads %r"
            % (path, version, SCHEMA_VERSION))
    rows = raw.get("detectors")
    if not isinstance(rows, list) or not rows:
        raise DetectorPackError("%s: detectors must be a non-empty list" % path)
    specs = []  # type: List[DetectorSpec]
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise DetectorPackError("%s: every detector must be a mapping" % path)
        detector_id = str(_require(row, "id", path))
        where = "%s#detectors.%s" % (path, detector_id)
        if detector_id in seen:
            raise DetectorPackError("%s: duplicate detector id %r" % (path, detector_id))
        seen.add(detector_id)
        severity = str(_require(row, "severity", where))
        if severity not in SEVERITIES:
            raise DetectorPackError(
                "%s: severity %r is not one of %r" % (where, severity, SEVERITIES))
        single = _require(row, "single_period_valid", where)
        if not isinstance(single, bool):
            raise DetectorPackError(
                "%s: single_period_valid must be true or false — a detector "
                "that does not answer it cannot be cold-start gated" % where)
        params = row.get("params") or {}
        if not isinstance(params, dict):
            raise DetectorPackError("%s: params must be a mapping" % where)
        specs.append(DetectorSpec(
            id=detector_id,
            family=str(_require(row, "family", where)),
            label=str(_require(row, "label", where)),
            scope=str(_require(row, "scope", where)),
            category=str(_require(row, "category", where)),
            severity=severity,
            citation=str(_require(row, "citation", where)),
            single_period_valid=bool(single),
            accounts=_prefix_map(row.get("accounts"), where),
            params=dict(params),
            why=str(_require(row, "why", where)),
            actions=_actions(row.get("actions"), where),
            source=path,
            min_periods=int(row.get("min_periods", 2)),
            min_years=int(row.get("min_years", 0)),
            basis=(str(row["basis"]) if row.get("basis") else None),
            signal_only=bool(row.get("signal_only", False)),
            confidence_level=str(row.get("confidence_level", "high")),
            confidence_basis=str(row.get("confidence_basis", "")),
            confidence_caveat=(str(row["confidence_caveat"])
                               if row.get("confidence_caveat") else None)))
    return DetectorPack(jurisdiction=str(jurisdiction), path=path,
                        pack_id=str(raw.get("pack_id") or ""),
                        detectors=tuple(specs))


#: (path, mtime_ns) -> DetectorPack. The pack is data read on every open;
#: memoised the way the cap policy and the profile catalogue are.
_PACK_CACHE = {}  # type: Dict[Tuple[str, int], DetectorPack]


def load_pack(jurisdiction: str, root: str) -> DetectorPack:
    """Read ``<root>/<jurisdiction>/detectors.yaml``. A missing file is a
    REFUSAL, not an empty pack: "this jurisdiction ships no detectors" and
    "somebody deleted the file" must not look the same."""
    path = pack_path(jurisdiction, root)
    try:
        stamp = os.stat(path).st_mtime_ns
    except OSError as exc:
        raise DetectorPackError(
            "no detector pack at %s (%s). Radar detectors are pack data; a "
            "jurisdiction without the file has no detectors declared, which "
            "is a different claim from having none that fired."
            % (path, exc.__class__.__name__))
    cached = _PACK_CACHE.get((path, stamp))
    if cached is not None:
        return cached
    with open(path, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    pack = parse_pack(raw, path, jurisdiction)
    _PACK_CACHE[(path, stamp)] = pack
    return pack


def invalidate_cache() -> None:
    _PACK_CACHE.clear()


__all__ = [
    "ActionSpec", "COLD_START_MIN_PERIODS", "DetectorPack",
    "DetectorPackError", "DetectorSpec", "PACK_FILENAME", "SCHEMA_VERSION",
    "SEVERITIES", "invalidate_cache", "load_pack", "pack_path", "parse_pack",
]
