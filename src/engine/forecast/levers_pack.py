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
    "Rung",
    "TaxConvention",
    "capex_rules",
    "dividend_book_rung_absent",
    "load_levers",
    "macro_pack",
    "min_cash_default",
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
