"""Loads `packs/insights/detectors.yaml` — the detector pack.

Pure data in, frozen objects out. This deliberately does NOT go through
`engine.packs`: that loader validates a five-file jurisdiction pack with
its own schema, and an insight pack is neither jurisdictional nor
five-file. Borrowing it would have meant either weakening its schema or
lying about what this directory is.

The pack is read ONCE and cached. A malformed pack raises at import of
the first caller rather than degrading — a severity ladder that silently
falls back to defaults is a threshold nobody can audit, which is the
exact failure TC-10 exists to prevent.

Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Sequence, Tuple

import yaml

__all__ = ["DetectorSpec", "Band", "load_pack", "InsightPack", "PackError"]


class PackError(RuntimeError):
    """The pack is unusable. Never swallowed."""


class Band(object):
    __slots__ = ("level", "at_least")

    def __init__(self, level: str, at_least: Optional[float]) -> None:
        self.level = level
        self.at_least = at_least

    def as_dict(self) -> Dict[str, Any]:
        return {"level": self.level, "at_least": self.at_least}


LEVELS = ("critical", "high", "medium", "low", "info")
#: critical sorts first. Quoted by the ranker and by the frontend reader.
LEVEL_ORDER = {name: index for index, name in enumerate(LEVELS)}


class DetectorSpec(object):
    __slots__ = ("id", "title", "formula", "basis", "basis_label", "basis_why",
                 "basis_fallback", "magnitude", "magnitude_label", "bands",
                 "claim", "claim_variants", "rows")

    def __init__(self, raw: Dict[str, Any]) -> None:
        self.id = _req_str(raw, "id")
        self.title = _req_str(raw, "title")
        self.formula = _clean(_req_str(raw, "formula"))
        self.basis = _req_str(raw, "basis")
        self.basis_label = _req_str(raw, "basis_label")
        self.basis_why = _clean(_req_str(raw, "basis_why"))
        self.basis_fallback = raw.get("basis_fallback")
        self.magnitude = _req_str(raw, "magnitude")
        self.magnitude_label = _req_str(raw, "magnitude_label")
        self.claim = _clean(_req_str(raw, "claim"))
        #: Optional alternative sentences, selected by the detector's
        #: `Detection.variant`. A detector naming a variant the pack does
        #: not carry raises rather than silently printing the default —
        #: a claim that reads around its own finding is the defect.
        self.claim_variants = {}  # type: Dict[str, str]
        for key, value in (raw.get("claim_variants") or {}).items():
            self.claim_variants[str(key)] = _clean(str(value))
        self.rows = {}  # type: Dict[str, Tuple[str, ...]]
        for key, value in (raw.get("rows") or {}).items():
            self.rows[str(key)] = tuple(str(v) for v in (value or ()))

        bands = []  # type: List[Band]
        for entry in (raw.get("bands") or ()):
            level = str(entry.get("level"))
            if level not in LEVELS:
                raise PackError(
                    "detector %r declares band level %r; legal levels are %s"
                    % (self.id, level, ", ".join(LEVELS))
                )
            at_least = entry.get("at_least")
            bands.append(Band(level, None if at_least is None else float(at_least)))
        if not bands:
            raise PackError("detector %r declares no severity bands" % self.id)
        if bands[-1].at_least is not None:
            raise PackError(
                "detector %r has no floor band: the last band must carry "
                "`at_least: null`, or a materiality below every cutoff would "
                "have no verdict at all" % self.id
            )
        previous = None  # type: Optional[float]
        for band in bands[:-1]:
            if band.at_least is None:
                raise PackError(
                    "detector %r has a null cutoff above the floor band" % self.id
                )
            if previous is not None and band.at_least >= previous:
                raise PackError(
                    "detector %r lists bands out of descending order (%s after %s); "
                    "they are read top-down and the first match wins, so an "
                    "ascending list would make the strictest band unreachable"
                    % (self.id, band.at_least, previous)
                )
            previous = band.at_least
        self.bands = tuple(bands)

    def bands_as_dicts(self) -> List[Dict[str, Any]]:
        return [b.as_dict() for b in self.bands]

    def claim_for(self, variant: str) -> str:
        if not variant:
            return self.claim
        text = self.claim_variants.get(variant)
        if text is None:
            raise PackError(
                "detector %r asked for claim variant %r; the pack declares: %s"
                % (self.id, variant,
                   ", ".join(sorted(self.claim_variants)) or "(none)")
            )
        return text


class InsightPack(object):
    __slots__ = ("schema_version", "pack_id", "pack_version", "detectors",
                 "ranking_statement", "ranking_order", "summary_limit")

    def __init__(self, raw: Dict[str, Any]) -> None:
        self.schema_version = str(raw.get("schema_version") or "")
        self.pack_id = str(raw.get("pack_id") or "")
        self.pack_version = str(raw.get("pack_version") or "")
        specs = [DetectorSpec(d) for d in (raw.get("detectors") or ())]
        seen = set()
        for spec in specs:
            if spec.id in seen:
                raise PackError("detector id %r declared twice" % spec.id)
            seen.add(spec.id)
        self.detectors = tuple(specs)
        ranking = raw.get("ranking") or {}
        self.ranking_statement = _clean(str(ranking.get("statement") or ""))
        self.ranking_order = tuple(str(x) for x in (ranking.get("order") or ()))
        self.summary_limit = int(ranking.get("summary_limit") or 5)

    def spec(self, detector_id: str) -> DetectorSpec:
        for spec in self.detectors:
            if spec.id == detector_id:
                return spec
        raise PackError(
            "no detector %r in pack %r; it declares: %s"
            % (detector_id, self.pack_id, ", ".join(d.id for d in self.detectors))
        )


def _req_str(raw: Dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise PackError("pack entry is missing required string %r: %r" % (key, raw))
    return value.strip()


def _clean(text: str) -> str:
    return " ".join(text.split())


def _default_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", "..", ".."))
    return os.path.join(repo, "packs", "insights", "detectors.yaml")


_CACHE = {}  # type: Dict[str, InsightPack]


def load_pack(path: Optional[str] = None) -> InsightPack:
    resolved = path or os.environ.get("INSIGHTS_PACK_PATH") or _default_path()
    cached = _CACHE.get(resolved)
    if cached is not None:
        return cached
    if not os.path.exists(resolved):
        raise PackError("insight pack not found at %s" % resolved)
    with open(resolved, "r") as handle:
        raw = yaml.safe_load(handle)
    if not isinstance(raw, dict):
        raise PackError("insight pack at %s is not a mapping" % resolved)
    pack = InsightPack(raw)
    _CACHE[resolved] = pack
    return pack
