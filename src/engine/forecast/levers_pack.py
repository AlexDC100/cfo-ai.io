"""Loads ``packs/forecast/levers.yaml`` — the lever registry's pack data.

Pure data in, frozen objects out (plan_contract_v2 3a, 0.6). Every rule
id, sentence, cutoff, step and budget the one forecast engine reads is an
address in that file, never a literal in code (TC-10), and each section is
read here through an accessor named after it, so pack-key liveness (S8)
can tell a read key from a dead one.

A malformed pack RAISES at first use rather than degrading: a projection
that silently fell back to a built-in sentence would state a convention
nobody can audit.

Sections read so far, by the batch that added them (contract 3a.4):

- B2: ``tax`` — the two tax conventions of 6.3 (rule ids and sentences).
- B3: the terminal rungs and default rules of 3.4 (``revenue_growth``,
  ``dividend_payout_pct``, ``intangible_additions_pct_of_revenue``,
  ``capex_pct_of_revenue``, ``capex_maintenance_replaces_depreciation``,
  the four held money drivers, ``min_cash``), and — outside levers.yaml —
  ``packs/forecast/ro_macro.yaml`` through :func:`macro_pack`, the ONE
  loader both ``engine.forecast`` and ``engine.forecast_drivers`` read the
  macro anchor and the statutory rates from (contract 4).

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

import os
from fractions import Fraction
from typing import Any, Dict, Optional, Tuple

import yaml

__all__ = [
    "MACRO_FILE",
    "MacroPack",
    "MacroSeries",
    "PACK_FILE",
    "PackError",
    "PlanPack",
    "RegistryEntry",
    "Rung",
    "TaxConvention",
    "capex_rules",
    "dividend_book_rung_absent",
    "load_levers",
    "macro_pack",
    "min_cash_default",
    "plan_pack",
    "tax_conventions",
    "terminal_rung",
]

#: The pack's address prefix, as a rule id writes it.
PACK_FILE = "packs/forecast/levers.yaml"

#: The macro pack's address prefix (contract 3.3 macro evidence).
MACRO_FILE = "packs/forecast/ro_macro.yaml"

SCHEMA_VERSION = "forecast_levers/1"


class PackError(RuntimeError):
    """The lever pack is unusable. Never swallowed."""


def _clean(text):
    # type: (str) -> str
    """Folded scalars arrive with soft wraps; one space between words."""
    return " ".join(str(text).split())


def _mapping(raw, where):
    # type: (Any, str) -> Dict[str, Any]
    if not isinstance(raw, dict):
        raise PackError("%s: must be a mapping" % where)
    return raw


def _text(raw, key, where):
    # type: (Dict[str, Any], str, str) -> str
    if key not in raw:
        raise PackError("%s: missing required key %r" % (where, key))
    value = raw[key]
    if not isinstance(value, str) or not value.strip():
        raise PackError("%s: %r must be a non-empty string" % (where, key))
    return _clean(value)


class TaxConvention(object):
    """One tax convention: its served id, its rule address, its sentence."""

    __slots__ = ("key", "convention_id", "rule_id", "sentence")

    def __init__(self, key, raw):
        # type: (str, Any) -> None
        where = "%s#tax.%s" % (PACK_FILE, key)
        body = _mapping(raw, where)
        self.key = key
        self.convention_id = _text(body, "convention_id", where)
        self.rule_id = where
        self.sentence = _text(body, "sentence", where)
        if any(ch.isdigit() for ch in self.sentence):
            # A numeral in a convention sentence is a cutoff written as
            # prose; TC-10 wants it rendered from the data that used it.
            raise PackError("%s: the sentence carries a numeral" % where)


def _sentence(raw, key, where, placeholder=False):
    # type: (Dict[str, Any], str, str, bool) -> str
    """A served sentence: no numeral (TC-10), and ``{amount}`` only where
    the rung renders a book amount into it."""
    text = _text(raw, key, where)
    if any(ch.isdigit() for ch in text):
        raise PackError("%s.%s: the sentence carries a numeral" % (where, key))
    has = "{amount}" in text
    if has and not placeholder:
        raise PackError("%s.%s: {amount} is not rendered for this sentence"
                        % (where, key))
    if placeholder and not has:
        raise PackError("%s.%s: the sentence must render {amount}"
                        % (where, key))
    stripped = text.replace("{amount}", "")
    if "{" in stripped or "}" in stripped:
        raise PackError("%s.%s: unknown placeholder" % (where, key))
    return text


def _exact_value(raw, where):
    # type: (Dict[str, Any], str) -> Fraction
    """A rung value: a decimal STRING, parsed exactly. A YAML float would
    arrive through binary floating point before any code saw it."""
    value = raw.get("value")
    if not isinstance(value, str) or not value.strip():
        raise PackError("%s.value: must be a decimal string" % (where,))
    try:
        return Fraction(value.strip())
    except (ValueError, ZeroDivisionError):
        raise PackError("%s.value: %r is not a decimal" % (where, value))


class Rung(object):
    """One convention rung of a default ladder (contract 3.4).

    ``rule_id`` is its pack address, ``value`` the exact rational it
    resolves to, ``sentence`` the basis the driver serves (placeholders
    left for the engine to render from its own integers)."""

    __slots__ = ("rule_id", "value", "sentence")

    def __init__(self, rule_id, value, sentence):
        # type: (str, Fraction, str) -> None
        self.rule_id = rule_id
        self.value = value
        self.sentence = sentence


class LeversPack(object):
    """The parsed pack. Sections are validated at load, all at once."""

    __slots__ = ("path", "tax", "rungs", "dividend_book_absent",
                 "capex_no_charge", "capex_nil_revenue", "capex_maintenance",
                 "index_neutral", "pool_templates",
                 "min_cash")

    #: The keys whose ``terminal_rung`` B3 reads (contract 3a.4). Each is
    #: {value, sentence}; capex_pct_of_revenue carries two sentences.
    TERMINAL_RUNG_KEYS = (
        "revenue_growth", "dividend_payout_pct",
        "intangible_additions_pct_of_revenue", "interest_income_annual",
        "other_financial_income_annual", "other_financial_expense_annual",
        "other_operating_income_annual",
        # plan/2 B4b (3.4): the rung below the macro anchor
        "inflation",
    )

    #: The tax conventions of contract 6.3, in the order they are served.
    TAX_KEYS = ("accrued_year_to_date", "no_loss_carry_forward")

    def __init__(self, path, raw):
        # type: (str, Any) -> None
        self.path = path
        body = _mapping(raw, PACK_FILE)
        version = body.get("schema_version")
        if version != SCHEMA_VERSION:
            raise PackError("%s: schema_version must be %r, got %r"
                            % (PACK_FILE, SCHEMA_VERSION, version))
        tax = _mapping(body.get("tax"), "%s#tax" % PACK_FILE)
        unknown = sorted(set(tax) - set(self.TAX_KEYS))
        missing = [k for k in self.TAX_KEYS if k not in tax]
        if unknown or missing:
            raise PackError("%s#tax: expected exactly %s; missing %s, unknown %s"
                            % (PACK_FILE, ", ".join(self.TAX_KEYS),
                               missing or "none", unknown or "none"))
        self.tax = tuple(TaxConvention(k, tax[k]) for k in self.TAX_KEYS)
        ids = [c.convention_id for c in self.tax]
        if len(set(ids)) != len(ids):
            raise PackError("%s#tax: two conventions share an id: %s"
                            % (PACK_FILE, ids))

        # ── plan/2 B3: terminal rungs and default rules ──────────────────
        rungs = {}  # type: Dict[str, Rung]
        for key in self.TERMINAL_RUNG_KEYS:
            where = "%s#%s.terminal_rung" % (PACK_FILE, key)
            section = _mapping(body.get(key), "%s#%s" % (PACK_FILE, key))
            rung = _mapping(section.get("terminal_rung"), where)
            rungs[key] = Rung(where, _exact_value(rung, where),
                              _sentence(rung, "sentence", where))
        self.rungs = rungs
        where = "%s#dividend_payout_pct" % PACK_FILE
        self.dividend_book_absent = _sentence(
            _mapping(body.get("dividend_payout_pct"), where),
            "book_rung_absent", where)
        where = "%s#capex_pct_of_revenue.terminal_rung" % PACK_FILE
        capex = _mapping(_mapping(body.get("capex_pct_of_revenue"),
                                  "%s#capex_pct_of_revenue" % PACK_FILE)
                         .get("terminal_rung"), where)
        value = _exact_value(capex, where)
        self.capex_no_charge = Rung(where, value, _sentence(
            capex, "sentence_no_charge", where))
        self.capex_nil_revenue = Rung(where, value, _sentence(
            capex, "sentence_nil_revenue", where, placeholder=True))
        where = "%s#capex_maintenance_replaces_depreciation" % PACK_FILE
        self.capex_maintenance = Rung(where, Fraction(0), _sentence(
            _mapping(body.get("capex_maintenance_replaces_depreciation"),
                     where), "sentence", where, placeholder=True))
        where = "%s#min_cash.default_rule" % PACK_FILE
        rule = _mapping(_mapping(body.get("min_cash"),
                                 "%s#min_cash" % PACK_FILE)
                        .get("default_rule"), where)
        self.min_cash = Rung(where, _exact_value(rule, where),
                             _sentence(rule, "sentence", where))
        # ── end plan/2 B3 ────────────────────────────────────────────────

        # ── plan/2 B4b: the neutral index rung and the pool templates ────
        where = "%s#index_neutral" % PACK_FILE
        rule = _mapping(body.get("index_neutral"), where)
        self.index_neutral = Rung(where, _exact_value(rule, where),
                                  _sentence(rule, "sentence", where))
        where = "%s#pools.templates" % PACK_FILE
        templates = _mapping(_mapping(body.get("pools"), "%s#pools" % PACK_FILE)
                             .get("templates"), where)
        expected = ("pool_fixed_share", "pool_level")
        if tuple(templates) != expected:
            raise PackError("%s: exactly %s, in that order; got %s"
                            % (where, ", ".join(expected), ", ".join(templates)))
        pool_templates = {}  # type: Dict[str, Dict[str, str]]
        for name in expected:
            entry = _mapping(templates.get(name), "%s.%s" % (where, name))
            unit = entry.get("unit")
            if unit not in ("ratio", "index"):
                raise PackError("%s.%s: unit must be ratio or index" % (where, name))
            pool_templates[name] = {
                "id": name + ".*", "unit": str(unit),
                "expands_over": _sentence(entry, "expands_over",
                                          "%s.%s" % (where, name))}
        self.pool_templates = pool_templates
        # ── end plan/2 B4b ───────────────────────────────────────────────


def _pack_path():
    # type: () -> str
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    return os.path.join(root, PACK_FILE)


_CACHE = {}  # type: Dict[str, LeversPack]


def load_levers(path=None):
    # type: (Optional[str]) -> LeversPack
    """Read once per path, cache, hand back the frozen pack."""
    target = path or _pack_path()
    cached = _CACHE.get(target)
    if cached is not None:
        return cached
    if not os.path.isfile(target):
        raise PackError("forecast lever pack not found: %s" % target)
    with open(target, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    pack = LeversPack(target, raw)
    _CACHE[target] = pack
    return pack


def tax_conventions(path=None):
    # type: (Optional[str]) -> Tuple[TaxConvention, ...]
    """``levers.yaml#tax``: the year-to-date accrual and the no-carry-forward
    conventions, in served order."""
    return load_levers(path).tax


# ── plan/2 B5: the driver registry, wc_unwind, debt_timing, unserved and
# the request refusals (contract 3a.1-3a.3, 6.2, 6.7, 2.3-2.6) ───────────
# Parsed on first use and cached beside the pack. The checks that need the
# engine's own attribution (model_key against KEYS, consumers against
# LINE_ASSUMPTIONS) run in engine.forecast.levers, which may import
# project.py; this module may not (project.py imports it).

REGISTRY_UNITS = ("ratio", "index", "days", "money")
REGISTRY_SHAPES = ("per_year", "scalar")
REGISTRY_GRANULARITIES = ("annual", "monthly")
REGISTRY_OPS = ("set", "level_pct", "growth_pp", "add_days", "add_pp")
REGISTRY_SET_VIA = ("overrides", "shocks_only", "behaviour_overrides",
                    "not_settable")
REGISTRY_DIRECTIONS = ("up", "down", "neutral")
REGISTRY_FIELDS = (
    "model_key", "pack_key", "panel", "rail_group", "unit", "shape",
    "granularity", "bounds", "reach_step", "probe_value", "tornado",
    "breakeven", "allowed_ops", "rail_op", "set_via", "favourable_direction",
    "case_rule", "label_key", "consumers")


def _decimal_or_none(raw, where):
    # type: (Any, str) -> Optional[Fraction]
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip():
        raise PackError("%s: must be a decimal string or null" % (where,))
    try:
        return Fraction(raw.strip())
    except (ValueError, ZeroDivisionError):
        raise PackError("%s: %r is not a decimal" % (where, raw))


class RegistryEntry(object):
    """One driver's registry entry (contract 3a.1). Values are exact
    rationals in the driver's own unit; ``solve_step`` is one model unit by
    definition and therefore not pack data."""

    __slots__ = REGISTRY_FIELDS + ("key", "rule_id")

    def __init__(self, key, raw, where):
        # type: (str, Dict[str, Any], str) -> None
        body = _mapping(raw, where)
        unknown = sorted(set(body) - set(REGISTRY_FIELDS))
        missing = [f for f in REGISTRY_FIELDS if f not in body]
        if unknown or missing:
            raise PackError("%s: missing %s, unknown %s"
                            % (where, missing or "none", unknown or "none"))
        self.key = key
        self.rule_id = where
        self.model_key = _text(body, "model_key", where)
        self.pack_key = body.get("pack_key")
        self.panel = _text(body, "panel", where)
        self.rail_group = _text(body, "rail_group", where)
        self.label_key = _text(body, "label_key", where)
        self.case_rule = _text(body, "case_rule", where)
        for field, allowed in (("unit", REGISTRY_UNITS), ("shape", REGISTRY_SHAPES),
                               ("granularity", REGISTRY_GRANULARITIES),
                               ("set_via", REGISTRY_SET_VIA),
                               ("favourable_direction", REGISTRY_DIRECTIONS)):
            value = body.get(field)
            if value not in allowed:
                raise PackError("%s.%s: %r is not one of %s"
                                % (where, field, value, ", ".join(allowed)))
            setattr(self, field, value)
        bounds = _mapping(body.get("bounds"), where + ".bounds")
        self.bounds = (_decimal_or_none(bounds.get("min"), where + ".bounds.min"),
                       _decimal_or_none(bounds.get("max"), where + ".bounds.max"))
        if None not in self.bounds and self.bounds[0] > self.bounds[1]:
            raise PackError("%s.bounds: min is above max" % (where,))
        self.reach_step = _decimal_or_none(body.get("reach_step"), where + ".reach_step")
        self.probe_value = _decimal_or_none(body.get("probe_value"), where + ".probe_value")
        if self.reach_step is None or self.probe_value is None:
            raise PackError("%s: reach_step and probe_value are required" % (where,))
        tornado = _mapping(body.get("tornado"), where + ".tornado")
        self.tornado = (_decimal_or_none(tornado.get("low"), where + ".tornado.low"),
                        _decimal_or_none(tornado.get("high"), where + ".tornado.high"))
        if None in self.tornado or self.tornado[0] > self.tornado[1]:
            raise PackError("%s.tornado: low and high are required, low <= high"
                            % (where,))
        ops = body.get("allowed_ops")
        if not isinstance(ops, list) or any(op not in REGISTRY_OPS for op in ops):
            raise PackError("%s.allowed_ops: a list drawn from %s"
                            % (where, ", ".join(REGISTRY_OPS)))
        self.allowed_ops = tuple(ops)
        self.rail_op = body.get("rail_op")
        if self.rail_op is not None and self.rail_op not in self.allowed_ops:
            raise PackError("%s.rail_op: %r is outside allowed_ops %s"
                            % (where, self.rail_op, list(self.allowed_ops)))
        if self.set_via == "shocks_only" and not self.allowed_ops:
            raise PackError("%s: a shocks_only key needs an allowed op" % (where,))
        breakeven = body.get("breakeven")
        if breakeven is not None:
            breakeven = _mapping(breakeven, where + ".breakeven")
            be_ops = breakeven.get("ops")
            metrics = breakeven.get("metrics")
            if (not isinstance(be_ops, list) or not be_ops
                    or any(op not in self.allowed_ops for op in be_ops)):
                raise PackError("%s.breakeven.ops: a non-empty subset of allowed_ops"
                                % (where,))
            if not isinstance(metrics, list) or not metrics:
                raise PackError("%s.breakeven.metrics: a non-empty list" % (where,))
            breakeven = {"ops": tuple(be_ops), "metrics": tuple(str(m) for m in metrics)}
        self.breakeven = breakeven
        consumers = body.get("consumers")
        if not isinstance(consumers, list) or not consumers:
            raise PackError("%s.consumers: a non-empty list of line ids" % (where,))
        self.consumers = tuple(str(c) for c in consumers)

    @property
    def is_template(self):
        return self.key.endswith(".*")


class PlanPack(object):
    """The B5 sections of levers.yaml."""

    __slots__ = ("registry", "wc_unwind_id", "wc_unwind_days", "wc_unwind_sentence",
                 "debt_timing_id", "debt_draws", "debt_repayments",
                 "debt_timing_sentence", "unserved", "refusals", "runway")

    PLACEMENTS = ("first_period", "last_period")

    def __init__(self, raw):
        body = _mapping(raw, PACK_FILE)
        where = "%s#registry" % PACK_FILE
        registry = _mapping(body.get("registry"), where)
        entries = []
        for key in registry:
            entries.append(RegistryEntry(str(key), registry[key],
                                         "%s.%s" % (where, key)))
        if not entries:
            raise PackError("%s: no entries" % (where,))
        self.registry = tuple(entries)

        where = "%s#wc_unwind" % PACK_FILE
        unwind = _mapping(body.get("wc_unwind"), where)
        self.wc_unwind_id = _text(unwind, "convention_id", where)
        self.wc_unwind_days = _decimal_or_none(unwind.get("unwind_days"),
                                               where + ".unwind_days")
        if self.wc_unwind_days is not None and self.wc_unwind_days < 0:
            raise PackError("%s.unwind_days: must not be negative" % (where,))
        self.wc_unwind_sentence = _sentence(unwind, "sentence", where)

        where = "%s#debt_timing" % PACK_FILE
        timing = _mapping(body.get("debt_timing"), where)
        self.debt_timing_id = _text(timing, "convention_id", where)
        for field in ("draws", "repayments"):
            if timing.get(field) not in self.PLACEMENTS:
                raise PackError("%s.%s: one of %s" % (where, field,
                                                      ", ".join(self.PLACEMENTS)))
        self.debt_draws = timing["draws"]
        self.debt_repayments = timing["repayments"]
        self.debt_timing_sentence = _sentence(timing, "sentence", where)

        where = "%s#unserved" % PACK_FILE
        unserved = _mapping(body.get("unserved"), where)
        self.unserved = tuple(
            (str(k), _sentence(_mapping(unserved[k], "%s.%s" % (where, k)),
                               "sentence", "%s.%s" % (where, k)))
            for k in unserved)

        where = "%s#request_refusals" % PACK_FILE
        refusals = _mapping(body.get("request_refusals"), where)
        self.refusals = dict((str(k), _clean(_text(refusals, k, where)))
                             for k in refusals)

        where = "%s#runway" % PACK_FILE
        runway = _mapping(body.get("runway"), where)
        limit = _mapping(runway.get("facility_limit"), where + ".facility_limit")
        self.runway = {
            "exact": _clean(_text(runway, "exact", where)),
            "annual_tail": _clean(_text(runway, "annual_tail", where)),
            "none": _clean(_text(runway, "none", where)),
            "facility_limit": {
                "code": _text(limit, "code", where + ".facility_limit"),
                "text": _clean(_text(limit, "text", where + ".facility_limit"))},
        }

    def entry(self, key):
        # type: (str) -> Optional[RegistryEntry]
        for item in self.registry:
            if item.key == key:
                return item
        return None


_PLAN_CACHE = {}  # type: Dict[str, PlanPack]


def plan_pack(path=None):
    # type: (Optional[str]) -> PlanPack
    target = path or _pack_path()
    cached = _PLAN_CACHE.get(target)
    if cached is not None:
        return cached
    if not os.path.isfile(target):
        raise PackError("forecast lever pack not found: %s" % target)
    with open(target, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    pack = PlanPack(raw)
    _PLAN_CACHE[target] = pack
    return pack


# ── end plan/2 B5 ───────────────────────────────────────────────────────


# ── plan/2 B3: accessors ────────────────────────────────────────────────

def terminal_rung(key, path=None):
    # type: (str, Optional[str]) -> Rung
    """``levers.yaml#<key>.terminal_rung`` (contract 3.4)."""
    rungs = load_levers(path).rungs
    if key not in rungs:
        raise PackError("%s: no terminal_rung is read for %r" % (PACK_FILE, key))
    return rungs[key]


def dividend_book_rung_absent(path=None):
    # type: (Optional[str]) -> str
    """``levers.yaml#dividend_payout_pct.book_rung_absent``."""
    return load_levers(path).dividend_book_absent


def capex_rules(path=None):
    # type: (Optional[str]) -> Tuple[Rung, Rung, Rung]
    """(maintenance rule, no-charge terminal rung, nil-revenue terminal
    rung): ``levers.yaml#capex_maintenance_replaces_depreciation`` and
    ``#capex_pct_of_revenue.terminal_rung``."""
    pack = load_levers(path)
    return pack.capex_maintenance, pack.capex_no_charge, pack.capex_nil_revenue


def min_cash_default(path=None):
    # type: (Optional[str]) -> Rung
    """``levers.yaml#min_cash.default_rule``."""
    return load_levers(path).min_cash


def index_neutral(path=None):
    # type: (Optional[str]) -> Rung
    """``levers.yaml#index_neutral`` (plan/2 B4b, 3.4): the convention rung
    of every index driver — the anchor level holds."""
    return load_levers(path).index_neutral


def pool_templates(path=None):
    # type: (Optional[str]) -> Dict[str, Dict[str, str]]
    """``levers.yaml#pools.templates`` (plan/2 B4b, 3a.2): the two template
    entries the engine expands per book: {name: {id, unit, expands_over}}."""
    return dict(load_levers(path).pool_templates)


class MacroSeries(object):
    """One sourced external series: an anchor or a statutory rate.

    ``kind`` is ``pack_anchor`` or ``statutory`` (contract 3.3 macro
    evidence); ``value`` is exact, read through the YAML scalar's own
    decimal text rather than its float."""

    __slots__ = ("key", "kind", "series_id", "label", "value", "source",
                 "source_url", "stated_as_of", "pack_address",
                 "band_half_width", "raw")

    def __init__(self, key, kind, raw, where):
        # type: (str, str, Any, str) -> None
        body = _mapping(raw, where)
        #: The parsed mapping, for a consumer that needs a field this class
        #: does not model (engine.forecast_drivers' label, why, source_kind).
        #: The file is still read once, here.
        self.raw = dict(body)
        self.key = key
        self.kind = kind
        self.pack_address = where
        self.series_id = _text(body, "series_id", where)
        self.label = _text(body, "label", where)
        value = body.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            raise PackError("%s.value: must be a number" % where)
        self.value = Fraction(str(value))
        self.source = _text(body, "source", where)
        url = body.get("source_url")
        if url is not None and (not isinstance(url, str) or not url.strip()):
            raise PackError("%s.source_url: a URL or null" % where)
        self.source_url = url
        self.stated_as_of = _text(body, "stated_as_of", where)
        half = body.get("band_half_width")
        self.band_half_width = None if half is None else Fraction(str(half))

    def evidence(self):
        # type: () -> Dict[str, Any]
        """The BASIS macro evidence object (contract 3.3)."""
        return {
            "series_id": self.series_id,
            "kind": self.kind,
            "source": self.source,
            "source_url": self.source_url,
            "stated_as_of": self.stated_as_of,
            "fetched_at": None,
            "series_content_digest": None,
        }


class MacroPack(object):
    """``packs/forecast/ro_macro.yaml``: its jurisdiction, its anchors and
    its statutory rates."""

    __slots__ = ("path", "jurisdiction", "pack_id", "pack_version",
                 "anchors", "statutory")

    def __init__(self, path, raw):
        # type: (str, Any) -> None
        body = _mapping(raw, MACRO_FILE)
        self.path = path
        self.jurisdiction = _text(body, "jurisdiction", MACRO_FILE)
        self.pack_id = _text(body, "pack_id", MACRO_FILE)
        self.pack_version = str(body.get("pack_version") or "")
        anchors = _mapping(body.get("anchors"), "%s#anchors" % MACRO_FILE)
        self.anchors = dict(
            (key, MacroSeries(key, "pack_anchor", anchors[key],
                              "%s#anchors.%s" % (MACRO_FILE, key)))
            for key in sorted(anchors))
        statutory = _mapping(body.get("statutory"),
                             "%s#statutory" % MACRO_FILE)
        self.statutory = dict(
            (key, MacroSeries(key, "statutory", statutory[key],
                              "%s#statutory.%s" % (MACRO_FILE, key)))
            for key in sorted(statutory))
        ids = [s.series_id for s in list(self.anchors.values())
               + list(self.statutory.values())]
        if len(set(ids)) != len(ids):
            raise PackError("%s: two series share an id: %s"
                            % (MACRO_FILE, ids))

    def anchor(self, key, jurisdiction):
        # type: (str, Optional[str]) -> Optional[MacroSeries]
        """The anchor for a period in ``jurisdiction``, or None when the
        period's jurisdiction is not this pack's (or is not recorded)."""
        if jurisdiction != self.jurisdiction:
            return None
        return self.anchors.get(key)

    def statutory_rate(self, key, jurisdiction):
        # type: (str, Optional[str]) -> Optional[MacroSeries]
        if jurisdiction != self.jurisdiction:
            return None
        return self.statutory.get(key)


_MACRO_CACHE = {}  # type: Dict[str, MacroPack]


def _macro_path():
    # type: () -> str
    return os.path.join(os.path.dirname(_pack_path()), "ro_macro.yaml")


def macro_pack(path=None):
    # type: (Optional[str]) -> MacroPack
    """``packs/forecast/ro_macro.yaml``, read once per path. The ONE reader
    of the file: ``engine.forecast_drivers.packdata`` builds its anchors
    from this object, so both packages cite the same series_id and the
    same exact value (contract 4)."""
    target = path or _macro_path()
    cached = _MACRO_CACHE.get(target)
    if cached is not None:
        return cached
    if not os.path.isfile(target):
        raise PackError("forecast macro pack not found: %s" % target)
    with open(target, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    pack = MacroPack(target, raw)
    _MACRO_CACHE[target] = pack
    return pack
# ── end plan/2 B3 ───────────────────────────────────────────────────────
