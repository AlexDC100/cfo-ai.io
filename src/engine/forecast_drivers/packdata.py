"""Loads `packs/forecast/drivers.yaml` and `packs/forecast/ro_macro.yaml`.

Pure data in, frozen objects out. Deliberately does NOT go through
`engine.packs` — that loader validates a five-file jurisdiction pack, and
a driver pack is neither jurisdictional nor five-file. It follows
`engine.insights.packdata` instead, which solved the same problem.

A malformed pack RAISES at first use rather than degrading. A driver pack
that silently fell back to built-in defaults would be exactly the failure
this whole lane exists to prevent: a number on a bank's desk with no
stated basis and no way to audit the rule behind it.

Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Sequence, Tuple

import yaml

__all__ = [
    "DriverSpec", "MacroAnchor", "ForecastPack", "load_pack", "PackError",
]


class PackError(RuntimeError):
    """The pack is unusable. Never swallowed."""


def _req(raw, key, where):
    # type: (Dict[str, Any], str, str) -> Any
    if key not in raw:
        raise PackError("%s: missing required key %r" % (where, key))
    return raw[key]


def _req_str(raw, key, where):
    # type: (Dict[str, Any], str, str) -> str
    value = _req(raw, key, where)
    if not isinstance(value, str) or not value.strip():
        raise PackError("%s: %r must be a non-empty string" % (where, key))
    return value.strip()


def _clean(text):
    # type: (str) -> str
    """YAML folded scalars arrive with a trailing newline and soft wraps."""
    return " ".join(text.split())


#: Every unit the pack may declare. A unit outside this set has no
#: rounding rule, and an unrounded value breaks determinism.
UNITS = ("rate", "days", "currency", "count", "years")

#: Every case rule the pack may declare, resolved in `cases.py`.
CASE_RULES = ("band_traverse", "macro_band", "hold")

KINDS = ("level", "rate")
DIRECTIONS = ("up", "down", "neutral")


class DriverSpec(object):
    __slots__ = ("key", "label", "unit", "kind", "favourable_direction",
                 "authority", "case_rule", "band_key", "macro_anchor",
                 "forced_status", "fallback_value", "why")

    def __init__(self, raw):
        # type: (Dict[str, Any]) -> None
        where = "driver %r" % (raw.get("key"),)
        self.key = _req_str(raw, "key", where)
        self.label = _req_str(raw, "label", where)
        self.unit = _req_str(raw, "unit", where)
        if self.unit not in UNITS:
            raise PackError("%s: unknown unit %r" % (where, self.unit))
        self.kind = _req_str(raw, "kind", where)
        if self.kind not in KINDS:
            raise PackError("%s: unknown kind %r" % (where, self.kind))
        self.favourable_direction = _req_str(raw, "favourable_direction", where)
        if self.favourable_direction not in DIRECTIONS:
            raise PackError("%s: unknown favourable_direction %r"
                            % (where, self.favourable_direction))
        self.authority = _req_str(raw, "authority", where)
        self.case_rule = _req_str(raw, "case_rule", where)
        if self.case_rule not in CASE_RULES:
            raise PackError("%s: unknown case_rule %r" % (where, self.case_rule))
        self.band_key = raw.get("band_key")
        self.macro_anchor = raw.get("macro_anchor")
        self.forced_status = raw.get("forced_status")
        if self.forced_status not in (None, "fallback"):
            raise PackError("%s: forced_status may only be 'fallback'" % where)
        fv = raw.get("fallback_value")
        self.fallback_value = None if fv is None else float(fv)
        self.why = _clean(_req_str(raw, "why", where))

        if self.case_rule == "band_traverse" and not self.band_key:
            raise PackError(
                "%s: case_rule band_traverse needs a band_key — the rule is "
                "'walk to the rung the report's own verdict uses', and "
                "without a band there is no rung" % where)
        if self.case_rule == "macro_band" and not self.macro_anchor:
            raise PackError("%s: case_rule macro_band needs a macro_anchor"
                            % where)

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "key": self.key, "label": self.label, "unit": self.unit,
            "kind": self.kind,
            "favourable_direction": self.favourable_direction,
            "authority": self.authority, "case_rule": self.case_rule,
            "band_key": self.band_key, "macro_anchor": self.macro_anchor,
            "why": self.why,
        }


class MacroAnchor(object):
    __slots__ = ("key", "label", "value", "band_half_width", "source",
                 "source_kind", "stated_as_of", "unit", "why")

    def __init__(self, key, raw):
        # type: (str, Dict[str, Any]) -> None
        where = "macro anchor %r" % (key,)
        self.key = key
        self.label = _req_str(raw, "label", where)
        self.value = float(_req(raw, "value", where))
        self.band_half_width = float(_req(raw, "band_half_width", where))
        if self.band_half_width < 0:
            raise PackError("%s: band_half_width must not be negative" % where)
        self.source = _req_str(raw, "source", where)
        self.source_kind = _req_str(raw, "source_kind", where)
        self.stated_as_of = _req_str(raw, "stated_as_of", where)
        self.unit = _req_str(raw, "unit", where)
        self.why = _clean(_req_str(raw, "why", where))


class ForecastPack(object):
    __slots__ = ("schema_version", "pack_id", "pack_version", "round_dp",
                 "opex_fixed", "opex_variable", "depreciable_rows",
                 "debt_rows", "fx_materiality_of_revenue", "_drivers",
                 "_by_key", "macro_pack_id", "macro_pack_version",
                 "_anchors")

    def __init__(self, drivers_raw, macro_raw):
        # type: (Dict[str, Any], Dict[str, Any]) -> None
        where = "packs/forecast/drivers.yaml"
        self.schema_version = _req_str(drivers_raw, "schema_version", where)
        self.pack_id = _req_str(drivers_raw, "pack_id", where)
        self.pack_version = str(_req(drivers_raw, "pack_version", where))

        round_dp = _req(drivers_raw, "round_dp", where)
        if not isinstance(round_dp, dict):
            raise PackError("%s: round_dp must be a mapping" % where)
        missing = [u for u in UNITS if u not in round_dp]
        if missing:
            raise PackError(
                "%s: round_dp is missing %s — an unrounded value breaks "
                "determinism" % (where, ", ".join(missing)))
        self.round_dp = dict((str(k), int(v)) for k, v in round_dp.items())

        split = _req(drivers_raw, "opex_nature_split", where)
        self.opex_fixed = tuple(str(x) for x in (split.get("fixed") or []))
        self.opex_variable = tuple(str(x) for x in (split.get("variable") or []))
        overlap = sorted(set(self.opex_fixed) & set(self.opex_variable))
        if overlap:
            raise PackError(
                "%s: opex leaf in BOTH fixed and variable: %s"
                % (where, ", ".join(overlap)))
        if not self.opex_fixed or not self.opex_variable:
            raise PackError("%s: opex_nature_split needs both sides" % where)

        self.depreciable_rows = tuple(
            str(x) for x in _req(drivers_raw, "depreciable_rows", where))
        self.debt_rows = tuple(
            str(x) for x in _req(drivers_raw, "debt_rows", where))
        self.fx_materiality_of_revenue = float(
            _req(drivers_raw, "fx_materiality_of_revenue", where))

        raw_drivers = _req(drivers_raw, "drivers", where)
        if not isinstance(raw_drivers, list) or not raw_drivers:
            raise PackError("%s: drivers must be a non-empty list" % where)
        specs = []  # type: List[DriverSpec]
        seen = {}  # type: Dict[str, bool]
        for raw in raw_drivers:
            spec = DriverSpec(raw)
            if spec.key in seen:
                raise PackError("%s: duplicate driver key %r" % (where, spec.key))
            seen[spec.key] = True
            specs.append(spec)
        self._drivers = tuple(specs)
        self._by_key = dict((s.key, s) for s in specs)

        mwhere = "packs/forecast/ro_macro.yaml"
        self.macro_pack_id = _req_str(macro_raw, "pack_id", mwhere)
        self.macro_pack_version = str(_req(macro_raw, "pack_version", mwhere))
        anchors_raw = _req(macro_raw, "anchors", mwhere)
        if not isinstance(anchors_raw, dict) or not anchors_raw:
            raise PackError("%s: anchors must be a non-empty mapping" % mwhere)
        anchors = {}  # type: Dict[str, MacroAnchor]
        for key in sorted(anchors_raw):
            anchors[key] = MacroAnchor(key, anchors_raw[key])
        self._anchors = anchors

        for spec in specs:
            if spec.macro_anchor and spec.macro_anchor not in anchors:
                raise PackError(
                    "driver %r names macro anchor %r, which %s does not "
                    "carry" % (spec.key, spec.macro_anchor, mwhere))

    @property
    def drivers(self):
        # type: () -> Tuple[DriverSpec, ...]
        """Declaration order. This IS the render order."""
        return self._drivers

    @property
    def driver_keys(self):
        # type: () -> Tuple[str, ...]
        return tuple(s.key for s in self._drivers)

    def driver(self, key):
        # type: (str) -> Optional[DriverSpec]
        return self._by_key.get(key)

    def anchor(self, key):
        # type: (str) -> MacroAnchor
        a = self._anchors.get(key)
        if a is None:
            raise PackError("no macro anchor %r" % (key,))
        return a

    def round_for(self, unit):
        # type: (str) -> int
        if unit not in self.round_dp:
            raise PackError("no rounding rule for unit %r" % (unit,))
        return self.round_dp[unit]


def _pack_dir():
    # type: () -> str
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    return os.path.join(root, "packs", "forecast")


_CACHE = {}  # type: Dict[str, ForecastPack]


def load_pack(pack_dir=None):
    # type: (Optional[str]) -> ForecastPack
    """Read once, cache, hand back frozen objects."""
    directory = pack_dir or _pack_dir()
    cached = _CACHE.get(directory)
    if cached is not None:
        return cached
    drivers_path = os.path.join(directory, "drivers.yaml")
    macro_path = os.path.join(directory, "ro_macro.yaml")
    for path in (drivers_path, macro_path):
        if not os.path.isfile(path):
            raise PackError("forecast pack file not found: %s" % path)
    with open(drivers_path, "r", encoding="utf-8") as fh:
        drivers_raw = yaml.safe_load(fh)
    with open(macro_path, "r", encoding="utf-8") as fh:
        macro_raw = yaml.safe_load(fh)
    if not isinstance(drivers_raw, dict) or not isinstance(macro_raw, dict):
        raise PackError("forecast pack files must each be a mapping")
    pack = ForecastPack(drivers_raw, macro_raw)
    _CACHE[directory] = pack
    return pack
