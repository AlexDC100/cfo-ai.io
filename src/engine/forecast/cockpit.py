"""The Forecast COCKPIT: four numbers, one chart, sliders — computed by the
ONE forecast engine (forecast-scenarios-live, owner-approved spec).

WHAT THIS MODULE IS
===================
A compiler and a reader, nothing else:

  * it reads the lever set a reader chose (a built-in case, a saved case, or
    sliders moved on top of either) and COMPILES it onto the engine's own
    drivers — the overrides and shocks of ``packs/forecast/levers.yaml
    #registry`` — then runs :func:`engine.forecast.levers.project_levers`,
    the one entry point the Forecast GET, the lever recompute and the
    Scenarios page also run through;
  * it READS the projection that comes back: the four numbers a bank asks
    for, the chart series, the plain-language sentence, the bridge from base,
    the full annual statements and every lever's basis.

It does no projection arithmetic of its own. Every amount it serves is a sum
of the engine's served period amounts (a plan-year total is the sum of its
periods, exactly as ``packs/forecast/levers.yaml#aggregates`` states), and
the only ratios it forms — the EBITDA margin and the DSCR — use the ratio
table's own formulas on those sums. A lever at its default compiles to
NOTHING, so the base case is the forecast byte for byte (gate F4).

Everything a reader sees in words — the lever labels, the bases, the case
definitions, the sentence — is pack data (``packs/forecast/cockpit.yaml``,
TC-10) rendered from the numbers the engine computed; no sentence carries a
numeral of its own and no AI touches a number or a word here.

Pure: no I/O beyond reading the two packs. Python 3.9 — no ``match``, no
``X | Y``.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from fractions import Fraction
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import yaml

from .errors import ForecastError, PlanRequestError
from .levers import PlanRequest, Shock, project_levers
from .levers_pack import PackError, macro_pack
from .money import MICRO, MICRO_DAY, cents_from
from .opening import (ASSET_LINES, CURRENT_ASSET_LINES, CURRENT_LIABILITY_LINES,
                      EL_LINES, EQUITY_LINES)
from .pools import COGS_BUCKET, LEVEL_PREFIX

__all__ = ["COCKPIT_FILE", "BridgeError", "CockpitError", "CockpitPack", "build_cockpit",
           "cockpit_pack", "compile_levers", "bridge", "export_document",
           "saved_case_levers"]

COCKPIT_FILE = "packs/forecast/cockpit.yaml"
SCHEMA_VERSION = "forecast_cockpit/1"

_COMPILE_KINDS = ("override", "input_price_share", "pool_growth_over_inflation",
                  "pool_level", "fx_on_imported", "parameter_of")
_UNITS = ("pct", "days")
_SHAPES = ("per_year", "scalar")
_CASE_RULES = ("best_growth_reading", "anchor_band_low", "dated_path", "dated_last")
_DECIMAL = re.compile(r"^-?[0-9]+(\.[0-9]+)?$")
_LANGS = ("ro", "en")


class CockpitError(ForecastError):
    """A cockpit request the engine refuses: ``code`` and ``text`` go to the
    reader verbatim (422), ``field`` names the lever or case."""

    def __init__(self, code: str, text: str, field: Optional[str] = None,
                 status: int = 422) -> None:
        ForecastError.__init__(self, text)
        self.code = code
        self.text = text
        self.field = field
        self.key = field
        self.status = status


class BridgeError(RuntimeError):
    """The bridge did not sum to the difference in closing cash: a producer
    defect, never served."""


# ── the pack ──────────────────────────────────────────────────────────────

def _two(raw: Any, where: str) -> Dict[str, str]:
    if not isinstance(raw, dict) or any(not isinstance(raw.get(l), str) or not raw.get(l)
                                        for l in _LANGS):
        raise PackError("%s#%s: needs a ro and an en string" % (COCKPIT_FILE, where))
    return {"ro": " ".join(raw["ro"].split()), "en": " ".join(raw["en"].split())}


def _frac(raw: Any, where: str) -> Fraction:
    if not isinstance(raw, str) or not _DECIMAL.match(raw):
        raise PackError("%s#%s: a decimal string" % (COCKPIT_FILE, where))
    return Fraction(raw)


class LeverSpec(object):
    __slots__ = ("id", "group", "unit", "shape", "low", "high", "step", "decimals", "kind",
                 "drivers", "compile", "label")

    def __init__(self, raw: Dict[str, Any], where: str) -> None:
        self.id = str(raw.get("id") or "")
        if not self.id:
            raise PackError("%s#%s.id: missing" % (COCKPIT_FILE, where))
        self.group = raw.get("group")
        if self.group not in ("primary", "more"):
            raise PackError("%s#%s.group: primary or more" % (COCKPIT_FILE, where))
        self.unit = raw.get("unit")
        if self.unit not in _UNITS:
            raise PackError("%s#%s.unit: one of %s" % (COCKPIT_FILE, where, _UNITS))
        self.shape = raw.get("shape")
        if self.shape not in _SHAPES:
            raise PackError("%s#%s.shape: one of %s" % (COCKPIT_FILE, where, _SHAPES))
        rng = raw.get("range") or {}
        self.low = _frac(rng.get("min"), where + ".range.min")
        self.high = _frac(rng.get("max"), where + ".range.max")
        self.step = _frac(rng.get("step"), where + ".range.step")
        if not self.low < self.high or self.step <= 0:
            raise PackError("%s#%s.range: min < max and a positive step" % (COCKPIT_FILE, where))
        # THE LEVER'S FIXED SLIDER SCALE (range.decimals): the page holds a
        # position as an exact decimal at 10^decimals ticks per unit and
        # never derives the scale from an answer. The pack's own bounds and
        # step must be exact at it, or a tick could be a value the engine
        # refuses (F10).
        decimals = rng.get("decimals")
        if isinstance(decimals, bool) or not isinstance(decimals, int) or not 0 <= decimals <= 12:
            raise PackError("%s#%s.range.decimals: an integer 0..12, the lever's fixed slider scale"
                            % (COCKPIT_FILE, where))
        self.decimals = decimals
        unit = Fraction(1, 10 ** decimals)
        for key, value in (("min", self.low), ("max", self.high), ("step", self.step)):
            if (value / unit).denominator != 1:
                raise PackError("%s#%s.range.%s: %s is not exact at %d decimals"
                                % (COCKPIT_FILE, where, key, rng.get(key), decimals))
        if self.step < unit:
            raise PackError("%s#%s.range.step: below one tick at %d decimals"
                            % (COCKPIT_FILE, where, decimals))
        comp = dict(raw.get("compiles_to") or {})
        self.kind = comp.get("kind")
        if self.kind not in _COMPILE_KINDS:
            raise PackError("%s#%s.compiles_to.kind: one of %s"
                            % (COCKPIT_FILE, where, _COMPILE_KINDS))
        drivers = comp.get("drivers")
        if not isinstance(drivers, list) or not drivers:
            raise PackError("%s#%s.compiles_to.drivers: a non-empty list" % (COCKPIT_FILE, where))
        self.drivers = tuple(str(d) for d in drivers)
        self.compile = comp
        self.label = _two(raw.get("label"), where + ".label")


class CaseSpec(object):
    __slots__ = ("id", "label", "in_sentence", "levers", "basis")

    def __init__(self, raw: Dict[str, Any], where: str, lever_ids: Sequence[str]) -> None:
        self.id = str(raw.get("id") or "")
        self.label = _two(raw.get("label"), where + ".label")
        self.in_sentence = _two(raw.get("in_sentence"), where + ".in_sentence")
        self.basis = _two(raw.get("basis"), where + ".basis")
        levers = raw.get("levers") or {}
        if not isinstance(levers, dict):
            raise PackError("%s#%s.levers: a mapping" % (COCKPIT_FILE, where))
        for key, rule in levers.items():
            if key not in lever_ids:
                raise PackError("%s#%s.levers.%s: no such lever" % (COCKPIT_FILE, where, key))
            if not isinstance(rule, dict) or rule.get("rule") not in _CASE_RULES:
                raise PackError("%s#%s.levers.%s.rule: one of %s"
                                % (COCKPIT_FILE, where, key, _CASE_RULES))
        self.levers = dict(levers)


class CockpitPack(object):
    """``packs/forecast/cockpit.yaml``, read once and checked whole."""

    def __init__(self, path: str, raw: Any) -> None:
        if not isinstance(raw, dict) or raw.get("schema_version") != SCHEMA_VERSION:
            raise PackError("%s: schema_version must be %s" % (COCKPIT_FILE, SCHEMA_VERSION))
        self.path = path
        self.pack_id = str(raw.get("pack_id") or "")
        horizon = raw.get("horizon") or {}
        self.total_years = int(horizon.get("total_years") or 0)
        self.monthly_months = int(horizon.get("monthly_months") or 0)
        if self.total_years < 1 or self.monthly_months not in (12, 24):
            raise PackError("%s#horizon: total_years >= 1, monthly_months 12 or 24" % COCKPIT_FILE)
        self.levers = []  # type: List[LeverSpec]
        for i, item in enumerate(raw.get("levers") or []):
            self.levers.append(LeverSpec(item, "levers[%d]" % i))
        ids = [l.id for l in self.levers]
        if len(set(ids)) != len(ids):
            raise PackError("%s#levers: two levers share an id" % COCKPIT_FILE)
        self.by_id = dict((l.id, l) for l in self.levers)
        for lever in self.levers:
            if lever.kind == "fx_on_imported" and lever.compile.get("share_lever") not in self.by_id:
                raise PackError("%s#levers.%s: share_lever names no lever" % (COCKPIT_FILE, lever.id))
            if lever.kind == "parameter_of" and lever.compile.get("lever") not in self.by_id:
                raise PackError("%s#levers.%s: lever names no lever" % (COCKPIT_FILE, lever.id))
        self.measures = dict(raw.get("measures") or {})
        self.funding_reference = dict(raw.get("funding_line_reference") or {})
        not_split = raw.get("year0_not_split") or {}
        self.year0_not_split = {"code": str(not_split.get("code") or ""),
                                "text": _two(not_split, "year0_not_split")}
        self.dscr = dict(raw.get("dscr") or {})
        self.dscr_formula = _two(self.dscr.get("formula"), "dscr.formula")
        self.cases = [CaseSpec(c, "cases[%d]" % i, ids) for i, c in enumerate(raw.get("cases") or [])]
        self.case_by_id = dict((c.id, c) for c in self.cases)
        if "base" not in self.case_by_id or self.case_by_id["base"].levers:
            raise PackError("%s#cases: a base case with no lever is required" % COCKPIT_FILE)
        self.saved = dict(raw.get("saved_cases") or {})
        self.basis = dict(raw.get("basis") or {})
        self.sentence = dict((k, _two(v, "sentence." + k))
                             for k, v in (raw.get("sentence") or {}).items())
        self.refusals = dict(raw.get("refusals") or {})
        self.lines = dict((k, _two(v, "lines." + k)) for k, v in (raw.get("lines") or {}).items())
        steps = (raw.get("bridge") or {}).get("steps") or []
        self.bridge_steps = [(str(s["id"]), bool(s.get("subtotal")), bool(s.get("total")),
                              _two(s.get("label"), "bridge." + str(s.get("id"))))
                             for s in steps]
        months = raw.get("months") or {}
        if any(len(months.get(l) or []) != 12 for l in _LANGS):
            raise PackError("%s#months: twelve names per language" % COCKPIT_FILE)
        self.months = dict((l, list(months[l])) for l in _LANGS)
        self.money_display = dict((k, _two(v, "money_display." + k))
                                  for k, v in (raw.get("money_display") or {}).items())
        export = raw.get("export") or {}
        self.export = {
            "title": _two(export.get("title"), "export.title"),
            "assumptions_title": _two(export.get("assumptions_title"), "export.assumptions_title"),
            "sections": dict((k, _two(v, "export.sections." + k))
                             for k, v in (export.get("sections") or {}).items()),
            "projected_note": _two(export.get("projected_note"), "export.projected_note"),
            "origin": dict((k, _two(v, "export.origin." + k))
                           for k, v in (export.get("origin") or {}).items()),
            "pools": dict((k, _two(v, "export.pools." + k))
                          for k, v in (export.get("pools") or {}).items()),
        }
        with open(path, "rb") as fh:
            self.digest = "sha256:" + hashlib.sha256(fh.read()).hexdigest()

    def text(self, section: str, key: str, lang: str, **facts: Any) -> str:
        node = self.basis.get(section) or {}
        for part in key.split("."):
            node = node.get(part) if isinstance(node, dict) else None
        if not isinstance(node, dict) or lang not in node:
            raise PackError("%s#basis.%s.%s: no %s sentence" % (COCKPIT_FILE, section, key, lang))
        return " ".join(str(node[lang]).split()).format(**facts)

    def refusal(self, code: str, field: Optional[str] = None, **facts: Any) -> CockpitError:
        entry = self.refusals.get(code) or (self.saved.get("refusals") or {}).get(code)
        if not isinstance(entry, dict):
            raise PackError("%s: no refusal sentence for %r" % (COCKPIT_FILE, code))
        return CockpitError(str(entry["code"]), " ".join(str(entry["text"]).split()).format(**facts),
                            field)


_PACK_CACHE = {}  # type: Dict[str, CockpitPack]


def _pack_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "..", COCKPIT_FILE))


def cockpit_pack(path: Optional[str] = None) -> CockpitPack:
    target = path or _pack_path()
    cached = _PACK_CACHE.get(target)
    if cached is not None:
        return cached
    if not os.path.isfile(target):
        raise PackError("forecast cockpit pack not found: %s" % target)
    with open(target, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    pack = CockpitPack(target, raw)
    _PACK_CACHE[target] = pack
    return pack


# ── formatting (integer arithmetic, half-up, per language) ────────────────

_MINUS = "−"


def _half_up(value: Fraction) -> int:
    value = Fraction(value)
    if value >= 0:
        return int(value + Fraction(1, 2))
    return -int(-value + Fraction(1, 2))


def _grouped(digits: str, sep: str) -> str:
    out = []
    while len(digits) > 3:
        out.insert(0, digits[-3:])
        digits = digits[:-3]
    out.insert(0, digits)
    return sep.join(out)


def _decimal(value: Fraction, places: int, lang: str, group: bool = True) -> str:
    scaled = _half_up(Fraction(value) * 10 ** places)
    sign = _MINUS if scaled < 0 else ""
    digits = "%d" % abs(scaled)
    if places:
        digits = digits.rjust(places + 1, "0")
        whole, frac = digits[:-places], digits[-places:]
    else:
        whole, frac = digits, ""
    dec, thou = ("," , ".") if lang == "ro" else (".", ",")
    whole = _grouped(whole, thou) if group else whole
    return sign + whole + (dec + frac if frac else "")


def fmt_pct(value: Fraction, lang: str, places: int = 1) -> str:
    return _decimal(Fraction(value) * 100, places, lang) + "%"


def fmt_ratio(value: Fraction, lang: str) -> str:
    return _decimal(value, 2, lang) + "×"


def fmt_days(value: Fraction, lang: str) -> str:
    return _decimal(value, 1, lang)


def fmt_money(cents: int, lang: str, pack: Optional[CockpitPack] = None) -> str:
    """Millions with one decimal at or above a million, thousands below."""
    pack = pack or cockpit_pack()
    units = Fraction(cents, 100)
    if abs(units) >= 1000000:
        return pack.money_display["million"][lang].format(
            value=_decimal(units / 1000000, 1, lang))
    return pack.money_display["thousand"][lang].format(value=_decimal(units / 1000, 1, lang))


def fmt_whole(amount: Fraction, lang: str) -> str:
    return _decimal(amount, 0, lang)


def month_label(label: str, lang: str, pack: Optional[CockpitPack] = None) -> str:
    """"2026-03" -> "martie 2026" / "March 2026"; "FY2028" -> "2028"."""
    pack = pack or cockpit_pack()
    if label.startswith("FY"):
        return label[2:]
    year, month = label.split("-")[0], int(label.split("-")[1])
    return "%s %s" % (pack.months[lang][month - 1], year)


def _year_of(label: str) -> str:
    return label[2:] if label.startswith("FY") else label[:4]


# ── the book's readings: each lever's default and basis ──────────────────

class LeverDefault(object):
    __slots__ = ("id", "values", "basis", "source", "measured", "inert", "locked",
                 "facts", "follows")

    def __init__(self, lever_id: str, values: Optional[Tuple[Fraction, ...]],
                 basis: Dict[str, str], source: Dict[str, Any], measured: bool,
                 inert: Optional[Dict[str, str]] = None, facts: Optional[Dict[str, Any]] = None,
                 follows: Optional[str] = None) -> None:
        self.id = lever_id
        #: one value per plan year (per_year) or a 1-tuple (scalar); None when
        #: the book cannot measure it and no rung supplies it.
        self.values = values
        self.basis = basis
        self.source = source
        self.measured = measured
        self.inert = inert
        self.locked = None  # type: Optional[Dict[str, str]]
        self.facts = dict(facts or {})
        #: another lever this default follows (wage_growth follows inflation)
        self.follows = follows


def _join(parts: Sequence[Dict[str, str]], pack: CockpitPack) -> Dict[str, str]:
    sep = pack.basis.get("sep") or " · "
    return dict((l, sep.join(p[l] for p in parts if p.get(l))) for l in _LANGS)


def _both(pack: CockpitPack, section: str, key: str, **facts_by_lang: Any) -> Dict[str, str]:
    """Render one basis sentence in both languages. A fact that is a
    {ro, en} mapping is taken per language."""
    out = {}
    for lang in _LANGS:
        facts = dict((k, (v[lang] if isinstance(v, dict) and lang in v else v))
                     for k, v in facts_by_lang.items())
        out[lang] = pack.text(section, key, lang, **facts)
    return out


def _leaf(pack: CockpitPack, section: str, **facts: Any) -> Dict[str, str]:
    """A basis section that is itself one {ro, en} sentence."""
    node = pack.basis.get(section)
    if not isinstance(node, dict) or any(l not in node for l in _LANGS):
        raise PackError("%s#basis.%s: no ro/en sentence" % (COCKPIT_FILE, section))
    return dict((l, " ".join(str(node[l]).split()).format(**facts)) for l in _LANGS)


def _per_lang(fn, *args) -> Dict[str, str]:
    return dict((l, fn(*(args + (l,)))) for l in _LANGS)


def _series_path(series: Any, pack: CockpitPack) -> Dict[str, str]:
    out = {}
    for lang in _LANGS:
        parts = []
        for at, value in series.points:
            parts.append("%s %s" % (fmt_pct(value, lang), month_label(at, lang, pack)))
        out[lang] = ", ".join(parts)
    return out


def _raw_material_share(payload: Mapping[str, Any], pools: Any,
                        prefixes: Sequence[str]) -> Tuple[int, int]:
    """(raw-material cents inside cost of sales, cost-of-sales pool base).
    Read from the SAME rows the pool split reads (bucket ``cogs``)."""
    base = int(getattr(pools.cost_of_sales, "base_cents", 0) or 0)
    total = 0
    for row in payload.get("line_items") or ():
        if str(row.get("bucket") or "") != COGS_BUCKET:
            continue
        code = str(row.get("ro_account_code") or "")
        if any(code.startswith(p) for p in prefixes):
            total += cents_from(row.get("amount") or 0)
    return total, base


def _pool_or_none(pools: Any, name: str) -> Any:
    for pool in pools.opex:
        if pool.name == name:
            return pool
    return None


def _defaults(plan: Any, payload: Mapping[str, Any], pack: CockpitPack) -> Dict[str, LeverDefault]:
    """Every lever's default on THIS book, with the basis the reader sees."""
    a = plan.base.assumptions
    history = plan.inputs["history"]
    opening = plan.inputs["opening"]
    pools = plan.inputs["pools"]
    book = plan.inputs["book"]
    years = plan.request.total_years
    year0 = str(opening.period_end)[:4]
    macro = macro_pack()
    out = {}  # type: Dict[str, LeverDefault]

    def ratio(key: str) -> Optional[Fraction]:
        item = a.get(key)
        return None if item.exact is None else Fraction(item.exact, MICRO)

    def per_year(value: Optional[Fraction]) -> Optional[Tuple[Fraction, ...]]:
        return None if value is None else tuple([value] * years)

    def src(item: Any, **extra: Any) -> Dict[str, Any]:
        base = {"tier": item.tier, "rule_id": item.rule_id, "engine_basis": item.basis}
        base.update(extra)
        return base

    # revenue growth: the engine's ladder, and the sector offered beside it
    growth = a.get("revenue_growth")
    g = ratio("revenue_growth")
    reading = getattr(book, "sector_growth", None)
    parts = []  # type: List[Dict[str, str]]
    facts = {}  # type: Dict[str, Any]
    if growth.tier == "book":
        ev = growth.evidence or {}
        used = list(ev.get("periods_used") or [])
        parts.append(_both(pack, "revenue_growth", "book",
                           growth=_per_lang(fmt_pct, g), prior_year=used[0][:4] if used else "",
                           year=used[-1][:4] if used else year0))
        facts["history"] = str(g)
    elif growth.tier == "sector" and reading is not None and reading.present:
        ev = reading.evidence
        parts.append(_both(pack, "revenue_growth", "sector",
                           growth=_per_lang(fmt_pct, Fraction(reading.value, MICRO)),
                           caen=ev.get("sector_caen"), n=ev.get("n"),
                           prior_year=ev.get("prior_year"), year=ev.get("period_year")))
    elif growth.tier == "macro":
        parts.append(_both(pack, "revenue_growth", "macro", growth=_per_lang(fmt_pct, g)))
    else:
        parts.append(_both(pack, "revenue_growth", "convention", year0=year0))
    if reading is not None and reading.present and growth.tier != "sector":
        ev = reading.evidence
        parts.append(_both(pack, "revenue_growth", "sector_offer",
                           growth=_per_lang(fmt_pct, Fraction(reading.value, MICRO)),
                           caen=ev.get("sector_caen"), n=ev.get("n"),
                           prior_year=ev.get("prior_year"), year=ev.get("period_year")))
        facts["sector_median"] = str(Fraction(reading.value, MICRO))
    elif growth.tier != "sector":
        code = getattr(reading, "reason_code", None) or "not_consulted"
        reasons = (pack.basis.get("revenue_growth") or {}).get("sector_reasons") or {}
        reason = reasons.get(code) or reasons.get("not_consulted")
        parts.append(_both(pack, "revenue_growth", "sector_absent", reason=reason))
    out["revenue_growth"] = LeverDefault(
        "revenue_growth", per_year(g), _join(parts, pack),
        src(growth, sector=(dict(reading.evidence) if reading is not None and reading.present
                            else None)),
        measured=growth.tier in ("book", "sector"), facts=facts)

    # inflation: the anchor the forecast uses, the BNR projection, the INS print
    infl = a.get("inflation")
    i = ratio("inflation")
    parts = []
    anchor = macro.anchors.get("inflation")
    if infl.tier == "macro" and anchor is not None:
        parts.append(_both(pack, "inflation", "macro", anchor=_per_lang(fmt_pct, anchor.value),
                           band=_per_lang(lambda v, l: _decimal(v * 100, 1, l) + " pp",
                                          anchor.band_half_width or Fraction(0)),
                           anchor_as_of=anchor.stated_as_of))
    else:
        parts.append(_both(pack, "inflation", "convention", year0=year0))
    projection = macro.series.get("bnr_inflation_projection")
    if projection is not None:
        parts.append(_both(pack, "inflation", "projection", path=_series_path(projection, pack),
                           source=projection.source, published=projection.published))
    cpi = macro.series.get("ins_cpi_annual")
    if cpi is not None:
        at, value = cpi.points[-1]
        parts.append(_both(pack, "inflation", "print", rate=_per_lang(lambda v, l: fmt_pct(v, l, 2), value),
                           month=_per_lang(lambda lab, l: month_label(lab, l, pack), at), published=cpi.published))
    out["inflation"] = LeverDefault(
        "inflation", per_year(i), _join(parts, pack),
        src(infl, series=[s.evidence() for s in (projection, cpi) if s is not None]),
        measured=False)

    # raw materials: their share of cost of sales, measured from the rows
    prefixes = list(pack.by_id["raw_material_price"].compile.get("cost_prefixes") or [])
    raw_cents, cogs_cents = _raw_material_share(payload, pools, prefixes)
    ippi = macro.series.get("ins_ippi_manufacturing")
    parts = []
    share = Fraction(raw_cents, cogs_cents) if cogs_cents > 0 and raw_cents > 0 else Fraction(0)
    if share > 0:
        parts.append(_both(pack, "raw_material_price", "measured",
                           prefixes=", ".join(prefixes),
                           amount=_per_lang(fmt_money, raw_cents), share=_per_lang(fmt_pct, share),
                           cogs=_per_lang(fmt_money, cogs_cents), year0=year0))
        inert = None
    else:
        parts.append(_both(pack, "raw_material_price", "absent",
                           prefixes=", ".join(prefixes), year0=year0))
        inert = parts[-1]
    if ippi is not None:
        at, value = ippi.points[-1]
        parts.append(_both(pack, "raw_material_price", "reference",
                           rate=_per_lang(lambda v, l: ("+" if v > 0 else "") + fmt_pct(v, l, 2), value),
                           month=_per_lang(lambda lab, l: month_label(lab, l, pack), at)))
    out["raw_material_price"] = LeverDefault(
        "raw_material_price", (Fraction(0),), _join(parts, pack),
        {"tier": "book", "facts": {"raw_material_minor": raw_cents,
                                   "cost_of_sales_minor": cogs_cents,
                                   "account_prefixes": prefixes},
         "series": [ippi.evidence()] if ippi is not None else []},
        measured=share > 0, inert=inert, facts={"share": share})

    # wages: the personnel pool, following inflation unless set
    wage_pool_name = pack.by_id["wage_growth"].compile.get("pool")
    personnel = _pool_or_none(pools, wage_pool_name)
    pprefixes = list(pack.measures.get("personnel_prefixes") or [])
    parts = []
    inert = None
    if personnel is not None and personnel.base_cents > 0:
        parts.append(_both(pack, "wage_growth", "measured", prefixes=", ".join(pprefixes),
                           amount=_per_lang(fmt_money, personnel.base_cents), year0=year0))
    else:
        parts.append(_both(pack, "wage_growth", "absent", prefixes=", ".join(pprefixes),
                           year0=year0))
        inert = parts[-1]
    wage = macro.series.get("minimum_wage_gross")
    if wage is not None and len(wage.points) >= 2:
        (a0, v0), (a1, v1) = wage.points[-2], wage.points[-1]
        parts.append(_both(pack, "wage_growth", "minimum_wage",
                           from_amount=_per_lang(fmt_whole, v0), to_amount=_per_lang(fmt_whole, v1),
                           to_month=_per_lang(lambda lab, l: month_label(lab, l, pack), a1),
                           change=_per_lang(lambda v, l: "+" + fmt_pct(v, l), v1 / v0 - 1),
                           source="HG", published=wage.published))
    out["wage_growth"] = LeverDefault(
        "wage_growth", per_year(i), _join(parts, pack),
        {"tier": "follows", "follows": "inflation",
         "facts": {"personnel_minor": personnel.base_cents if personnel is not None else None},
         "series": [wage.evidence()] if wage is not None else []},
        measured=False, inert=inert, follows="inflation")

    # energy: the energy pool against revenue
    energy = _pool_or_none(pools, pack.by_id["energy_price"].compile.get("pool"))
    eprefixes = list(pack.measures.get("energy_prefixes") or [])
    revenue = history.revenue or 0
    if energy is not None and energy.base_cents > 0 and revenue > 0:
        basis = _both(pack, "energy_price", "measured", prefixes=", ".join(eprefixes),
                      amount=_per_lang(fmt_money, energy.base_cents),
                      share=_per_lang(fmt_pct, Fraction(energy.base_cents, revenue)), year0=year0)
        inert = None
    else:
        basis = _both(pack, "energy_price", "absent", prefixes=", ".join(eprefixes), year0=year0)
        inert = basis
    out["energy_price"] = LeverDefault(
        "energy_price", (Fraction(0),), basis,
        {"tier": "book", "facts": {"energy_minor": energy.base_cents if energy is not None else None,
                                   "account_prefixes": eprefixes}},
        measured=inert is None, inert=inert)

    # EUR/RON and the imported share: never measurable from a trial balance
    out["imported_share"] = LeverDefault(
        "imported_share", (Fraction(0),), _both(pack, "imported_share", "default"),
        {"tier": "not_measurable"}, measured=False)
    out["eur_ron"] = LeverDefault(
        "eur_ron", (Fraction(0),), _both(pack, "eur_ron", "inert"),
        {"tier": "not_measurable"}, measured=False, inert=_both(pack, "eur_ron", "inert"))

    # working-capital days
    for lever_id, key, balance, flow in (("dso_days", "dso_days", opening.cents("ar"), history.revenue),
                                         ("dio_days", "dio_cogs_days", opening.cents("inventory"), history.cogs),
                                         ("dpo_days", "dpo_cogs_days", opening.cents("ap"), history.cogs)):
        item = a.get(key)
        if item.exact is None:
            out[lever_id] = LeverDefault(lever_id, None, _leaf(pack, "days_absent", year0=year0),
                                         src(item), measured=False)
            continue
        days = Fraction(item.exact, MICRO_DAY)
        if item.tier == "book" and flow:
            basis = _both(pack, lever_id, "book", days=_per_lang(fmt_days, days),
                          balance=_per_lang(fmt_money, balance), flow=_per_lang(fmt_money, flow),
                          year0=year0)
        else:
            basis = _leaf(pack, "untranslated", sentence=item.basis)
        out[lever_id] = LeverDefault(lever_id, per_year(days), basis, src(item),
                                     measured=item.tier == "book")

    # capital expenditure
    capex = a.get("capex_pct_of_revenue")
    c = ratio("capex_pct_of_revenue")
    if c is not None and c > 0 and history.depreciation:
        basis = _both(pack, "capex", "maintenance",
                      amount=_per_lang(fmt_money, abs(history.depreciation)),
                      share=_per_lang(fmt_pct, c))
    else:
        basis = _both(pack, "capex", "none", year0=year0)
    out["capex"] = LeverDefault("capex", per_year(c), basis, src(capex), measured=False)

    # the interest rate (debt and the credit line)
    rate_item = a.get("interest_rate_debt")
    r = ratio("interest_rate_debt")
    debt = opening.cents("st_debt") + opening.cents("lt_debt")
    if r is not None and rate_item.tier == "book":
        basis = _both(pack, "interest_rate", "book", rate=_per_lang(lambda v, l: fmt_pct(v, l, 2), r),
                      interest=_per_lang(fmt_money, abs(history.interest_expense or 0)),
                      debt=_per_lang(fmt_money, debt), year0=year0)
    elif r is None:
        parts = [_both(pack, "interest_rate", "absent", year0=year0)]
        reference = _reference_rate(pack)
        if reference is not None:
            rate, series = reference
            parts.append(_both(pack, "interest_rate", "reference",
                               rate=_per_lang(lambda v, l: fmt_pct(v, l, 2), rate),
                               published=series.published))
        basis = _join(parts, pack)
    else:
        basis = _leaf(pack, "untranslated", sentence=rate_item.basis)
    out["interest_rate"] = LeverDefault("interest_rate", per_year(r), basis, src(rate_item),
                                        measured=rate_item.tier == "book")

    # dividends
    div = a.get("dividend_payout_pct")
    out["dividend_payout"] = LeverDefault("dividend_payout", per_year(ratio("dividend_payout_pct")),
                                          _both(pack, "dividend_payout", "none"), src(div),
                                          measured=False)

    # a refused cost split locks the levers whose effect IS the split
    if getattr(pools, "refused", False):
        from .levers_pack import plan_pack
        text = plan_pack().refusals.get("cost_split_refused", "").format(
            reason=getattr(pools, "refusal_rule_id", None) or "the split was refused")
        locked = {"code": "cost_split_refused", "text": " ".join(text.split())}
        for lever_id in ("revenue_growth", "inflation", "raw_material_price", "eur_ron",
                         "imported_share"):
            out[lever_id].locked = locked
    for lever_id in ("wage_growth", "energy_price"):
        pool = pack.by_id[lever_id].compile.get("pool")
        if LEVEL_PREFIX + str(pool) not in set(pools.level_keys()):
            if out[lever_id].inert is None:
                out[lever_id].inert = out[lever_id].basis
    for spec in pack.levers:
        if spec.id not in out:
            raise PackError("%s#levers.%s: the engine reads no default for it" % (COCKPIT_FILE, spec.id))
    return out


def _reference_rate(pack: CockpitPack) -> Optional[Tuple[Fraction, Any]]:
    """(rate, series) a credit line is priced at when the book measures no
    borrowing rate (packs/forecast/cockpit.yaml#funding_line_reference)."""
    key = pack.funding_reference.get("series")
    series = macro_pack().series.get(key) if key else None
    if series is None:
        return None
    return series.points[-1][1], series


def _with_reference(request: PlanRequest, rate: Fraction, pack: CockpitPack) -> PlanRequest:
    from dataclasses import replace
    overrides = dict(request.overrides)
    for driver in pack.funding_reference.get("drivers") or ("revolver_rate",):
        overrides[driver] = tuple([rate] * request.total_years)
    return replace(request, overrides=tuple(sorted(overrides.items())))


# ── the lever set in force ────────────────────────────────────────────────

def effective_range(spec: Any, default: Optional[Tuple[Fraction, ...]]) -> Tuple[Fraction, Fraction]:
    """The pack's range for a lever, widened to hold this book's own default:
    a measured value outside the pack's range (a book that grew 41% in a
    year) is still what the slider shows and what the reader can send back.
    A widened bound is rounded OUTWARD to the lever's fixed decimals, so the
    served range is exact at the slider's scale — every tick the slider can
    stand on is accepted — and the default stays inside it; the pack's own
    bounds are exact already and are never moved (F10)."""
    low, high = spec.low, spec.high
    for value in default or ():
        low, high = min(low, value), max(high, value)
    unit = Fraction(1, 10 ** spec.decimals)
    if low < spec.low:
        low = math.floor(low / unit) * unit
    if high > spec.high:
        high = math.ceil(high / unit) * unit
    return low, high


def _parse_value(spec: Any, raw: Any, years: int, pack: CockpitPack,
                 default: Optional[Tuple[Fraction, ...]] = None) -> Tuple[Fraction, ...]:
    low, high = effective_range(spec, default)

    def one(item: Any) -> Fraction:
        if not isinstance(item, str) or not _DECIMAL.match(item.strip()):
            raise pack.refusal("not_decimal", spec.id, lever=spec.id, value=repr(item))
        value = Fraction(item.strip())
        if value < low or value > high:
            raise pack.refusal("out_of_range", spec.id, lever=spec.id, value=item.strip(),
                               low=_exact_decimal(low), high=_exact_decimal(high))
        return value
    if isinstance(raw, list):
        if spec.shape == "scalar":
            raise pack.refusal("scalar_only", spec.id, lever=spec.id)
        if len(raw) != years:
            raise pack.refusal("per_year_length", spec.id, lever=spec.id, years=years, got=len(raw))
        return tuple(one(v) for v in raw)
    value = one(raw)
    return tuple([value] * (years if spec.shape == "per_year" else 1))


def _case_values(case: Any, defaults: Mapping[str, LeverDefault], years: int, anchor_year: int,
                 pack: CockpitPack) -> Tuple[Dict[str, Tuple[Fraction, ...]], Dict[str, Any]]:
    """A built-in case's lever values, from the readings it names, and the
    facts its basis sentence renders."""
    macro = macro_pack()
    values = {}  # type: Dict[str, Tuple[Fraction, ...]]
    facts = {}  # type: Dict[str, Any]
    for lever_id, rule in case.levers.items():
        kind = rule["rule"]
        if kind == "best_growth_reading":
            candidates = []  # (value, source {ro, en})
            base = defaults["revenue_growth"]
            if base.values is not None:
                candidates.append((base.values[0], {"ro": "prognoza de bază", "en": "the base forecast"}))
            src = base.source or {}
            sector = src.get("sector")
            if sector and sector.get("p50") is not None:
                candidates.append((Fraction(sector["p50"], MICRO),
                                   {"ro": "mediana sectorului CAEN %s" % sector.get("sector_caen"),
                                    "en": "the CAEN %s sector median" % sector.get("sector_caen")}))
            anchor = macro.anchors.get("inflation")
            if anchor is not None:
                candidates.append((anchor.value, {"ro": "ancora BNR", "en": "the BNR anchor"}))
            best = max(candidates, key=lambda c: c[0])
            values[lever_id] = tuple([best[0]] * years)
            facts["growth"] = _per_lang(fmt_pct, best[0])
            facts["growth_source"] = best[1]
        elif kind == "anchor_band_low":
            anchor = macro.anchors.get(rule.get("anchor"))
            low = anchor.value - (anchor.band_half_width or 0)
            values[lever_id] = tuple([low] * years)
            facts["inflation"] = _per_lang(fmt_pct, low)
            facts["inflation_source"] = {"ro": "BNR, confirmat %s" % anchor.stated_as_of,
                                         "en": "BNR, confirmed %s" % anchor.stated_as_of}
        elif kind == "dated_path":
            series = macro.series[rule["series"]]
            path = []
            for n in range(1, years + 1):
                year = anchor_year + n
                chosen = None
                for at, value in series.points:
                    if int(at[:4]) <= year:
                        chosen = value
                if chosen is None:
                    chosen = series.points[0][1]
                path.append(chosen)
            values[lever_id] = tuple(path)
            facts["path"] = dict((l, ", ".join("%s %d" % (fmt_pct(v, l), anchor_year + n + 1)
                                               for n, v in enumerate(path))) for l in _LANGS)
            facts["inflation_source"] = {"ro": "BNR, Raport asupra inflației, %s" % series.published,
                                         "en": "BNR Inflation Report, %s" % series.published}
        elif kind == "dated_last":
            series = macro.series[rule["series"]]
            at, value = series.points[-1]
            spec = pack.by_id[lever_id]
            values[lever_id] = tuple([value] * (years if spec.shape == "per_year" else 1))
            facts["raw"] = _per_lang(lambda v, l: fmt_pct(v, l, 2), value)
            facts["raw_source"] = dict((l, "INS, %s" % month_label(at, l, pack)) for l in _LANGS)
    return values, facts


def saved_case_levers(bag: Any, case_id: str, org_id: str, pack: Optional[CockpitPack] = None
                      ) -> Tuple[str, Dict[str, Any]]:
    """(name, levers) of the saved case ``case_id`` in ONE company's prefs
    bag. An entry that names another company is refused, never computed."""
    pack = pack or cockpit_pack()
    prefix = str(pack.saved.get("id_prefix") or "saved:")
    key = case_id[len(prefix):] if case_id.startswith(prefix) else case_id
    items = (bag or {}).get(pack.saved.get("prefs_key")) if isinstance(bag, dict) else None
    for entry in items if isinstance(items, list) else ():
        if not isinstance(entry, dict) or entry.get("id") != key:
            continue
        if entry.get("orgId") != org_id:
            raise pack.refusal("other_company", "case_id", case_id=case_id)
        levers = entry.get("levers")
        name = entry.get("name")
        if not isinstance(levers, dict) or not isinstance(name, str):
            raise pack.refusal("malformed", "case_id", case_id=case_id)
        return name, dict(levers)
    err = pack.refusal("not_found", "case_id", case_id=case_id)
    err.status = 404
    raise err


def resolve_levers(defaults: Mapping[str, LeverDefault], case_id: str,
                   case_levers: Mapping[str, Any], request_levers: Mapping[str, Any],
                   years: int, anchor_year: int, pack: CockpitPack
                   ) -> Tuple[Dict[str, Tuple[Fraction, ...]], Dict[str, Any], Dict[str, str]]:
    """(values in force per lever, case facts, where each value came from:
    default | case | user)."""
    in_force = {}  # type: Dict[str, Tuple[Fraction, ...]]
    origin = {}  # type: Dict[str, str]
    for spec in pack.levers:
        d = defaults[spec.id]
        if d.values is not None:
            in_force[spec.id] = d.values
            origin[spec.id] = "default"
    facts = {}  # type: Dict[str, Any]
    case = pack.case_by_id.get(case_id)
    if case is not None:
        values, facts = _case_values(case, defaults, years, anchor_year, pack)
        for key, value in values.items():
            in_force[key] = value
            origin[key] = "case"
    for key, raw in (case_levers or {}).items():
        spec = pack.by_id.get(key)
        if spec is None:
            raise pack.refusal("unknown_lever", key, lever=key,
                               levers=", ".join(s.id for s in pack.levers))
        in_force[key] = _parse_value(spec, raw, years, pack, defaults[key].values)
        origin[key] = "case"
    for key, raw in (request_levers or {}).items():
        spec = pack.by_id.get(key)
        if spec is None:
            raise pack.refusal("unknown_lever", key, lever=key,
                               levers=", ".join(s.id for s in pack.levers))
        if raw is None:
            continue
        in_force[key] = _parse_value(spec, raw, years, pack, defaults[key].values)
        origin[key] = "user"
    # wages follow inflation until set
    if origin.get("wage_growth") == "default" and "inflation" in in_force:
        in_force["wage_growth"] = in_force["inflation"]
    for key, value in list(in_force.items()):
        if defaults[key].locked is not None and origin.get(key) != "default" \
                and value != defaults[key].values:
            locked = defaults[key].locked
            raise CockpitError(locked["code"], locked["text"], key)
    return in_force, facts, origin


def compile_levers(in_force: Mapping[str, Tuple[Fraction, ...]],
                   defaults: Mapping[str, LeverDefault], total_years: int,
                   monthly_months: int, pack: CockpitPack) -> PlanRequest:
    """The lever set as a PlanRequest of the engine's own overrides and
    shocks. A lever at its default adds NOTHING (gate F4)."""
    overrides = {}  # type: Dict[str, Tuple[Optional[Fraction], ...]]
    shocks = []  # type: List[Shock]
    inflation = in_force.get("inflation")
    input_levels = []  # type: List[Tuple[str, Fraction]]
    for spec in pack.levers:
        value = in_force.get(spec.id)
        default = defaults[spec.id].values
        if value is None:
            continue
        if spec.kind == "override":
            if value == default:
                continue
            for driver in spec.drivers:
                overrides[driver] = tuple(value)
        elif spec.kind == "input_price_share":
            share = defaults[spec.id].facts.get("share") or Fraction(0)
            move = value[0] * share
            if move != 0:
                input_levels.append((spec.id, move))
        elif spec.kind == "fx_on_imported":
            share = (in_force.get(spec.compile["share_lever"]) or (Fraction(0),))[0]
            move = value[0] * share
            if move != 0:
                input_levels.append((spec.id, move))
        elif spec.kind == "pool_level":
            if value[0] != 0:
                shocks.append(Shock(id="cockpit.%s" % spec.id, driver_key=spec.drivers[0],
                                    op="level_pct", value=value[0], start_month=1,
                                    source="preset:cockpit", group_id="cockpit.%s" % spec.id))
        elif spec.kind == "pool_growth_over_inflation":
            if inflation is None or value == inflation:
                continue
            for n in range(1, total_years + 1):
                step = (1 + value[n - 1]) / (1 + inflation[n - 1]) - 1
                if step == 0:
                    continue
                shocks.append(Shock(id="cockpit.%s.y%d" % (spec.id, n), driver_key=spec.drivers[0],
                                    op="level_pct", value=step, start_month=12 * (n - 1) + 1,
                                    source="preset:cockpit", group_id="cockpit.%s" % spec.id))
        # parameter_of: read by the lever it parameterises
    for lever_id, move in input_levels:
        shocks.append(Shock(id="cockpit.%s" % lever_id, driver_key="input_price_index",
                            op="level_pct", value=move, start_month=1,
                            source="preset:cockpit", group_id="cockpit.%s" % lever_id))
    return PlanRequest(total_years=total_years, monthly_months=monthly_months,
                       overrides=tuple(sorted(overrides.items())), shocks=tuple(shocks))


# ── reading the projection ───────────────────────────────────────────────

def _years(projection: Any) -> List[Tuple[int, str, List[Any]]]:
    """(plan year, FY label, its periods) in order."""
    groups = {}  # type: Dict[int, List[Any]]
    for item in projection.periods:
        groups.setdefault(item.period.year_offset, []).append(item)
    return [(n, "FY%d" % max(p.period.end for p in groups[n]).year, groups[n])
            for n in sorted(groups)]


_FLOW_CF = ("net_income", "depreciation", "amortisation", "change_in_receivables",
            "change_in_inventory", "change_in_payables", "cash_from_operating",
            "capital_expenditure", "intangible_additions", "cash_from_investing",
            "debt_drawdowns", "debt_repayments", "dividends_paid", "funding_line_movement",
            "cash_from_financing", "net_change_in_cash")


def _aggregate(periods: Sequence[Any]) -> Dict[str, int]:
    """One plan year: flows summed over its periods, balances at its close
    (packs/forecast/levers.yaml#aggregates)."""
    out = {}  # type: Dict[str, int]
    for key in periods[0].pl:
        out["pl." + key] = sum(p.pl[key] for p in periods)
    for key in periods[-1].bs:
        out["bs." + key] = periods[-1].bs[key]
    for key in _FLOW_CF:
        out["cf." + key] = sum(p.cf[key] for p in periods)
    out["cf.opening_cash"] = periods[0].cf["opening_cash"]
    out["cf.closing_cash"] = periods[-1].cf["closing_cash"]
    bs = periods[-1].bs
    out["bs_totals.assets"] = sum(bs[l] for l in ASSET_LINES)
    out["bs_totals.equity"] = sum(bs[l] for l in EQUITY_LINES)
    out["bs_totals.equity_plus_liabilities"] = sum(bs[l] for l in EL_LINES)
    out["bs_totals.current_assets"] = sum(bs[l] for l in CURRENT_ASSET_LINES)
    out["bs_totals.current_liabilities"] = sum(bs[l] for l in CURRENT_LIABILITY_LINES)
    return out


def _dscr(year: Mapping[str, int]) -> Tuple[Optional[Fraction], int, int]:
    """The ratio table's dscr on a projected plan year: EBITDA / (interest +
    short-term debt), interest = debt + funding-line interest, short-term
    debt = short-term debt + the funding-line balance at the close."""
    numerator = year["pl.ebitda"]
    interest = -(year["pl.interest_expense_debt"] + year["pl.interest_expense_funding_line"])
    st = year["bs.st_debt"] + year["bs.revolver"]
    denominator = interest + st
    if denominator <= 0:
        return None, numerator, denominator
    return Fraction(numerator, denominator), numerator, denominator


def _dscr_threshold() -> Tuple[Fraction, str]:
    from engine.country_packs.ro_romania.chart_of_accounts import _GENERAL_SME_BAND_DEFINITIONS
    band = cockpit_pack().dscr.get("threshold_band") or "healthy"
    row = _GENERAL_SME_BAND_DEFINITIONS[cockpit_pack().dscr.get("metric") or "dscr"]
    return Fraction(str(row[band])), band


def _ppm(value: Fraction) -> int:
    return _half_up(Fraction(value) * MICRO)


def _fig(amount: int) -> Dict[str, Any]:
    return {"kind": "projected", "amount_minor": int(amount)}


def _actual(amount: Optional[int], pack: Optional[CockpitPack] = None) -> Dict[str, Any]:
    if amount is None:
        refusal = (pack or cockpit_pack()).year0_not_split
        return {"kind": "actual", "refused": {"code": refusal["code"],
                                              "text": dict(refusal["text"])}}
    return {"kind": "actual", "amount_minor": int(amount)}


def bridge(base: Any, case: Any, window: str, pack: Optional[CockpitPack] = None) -> Dict[str, Any]:
    """The bridge from ``base`` to ``case`` (two Projections) over ``window``
    ("year_one" or "horizon"): revenue -> EBITDA -> working capital -> capex
    -> interest and tax -> dividends -> debt -> closing cash. Each step is the
    difference of the cumulative served flows; they sum EXACTLY to the
    difference in closing cash (gate F9), or the bridge is not served."""
    pack = pack or cockpit_pack()

    def periods(projection: Any) -> List[Any]:
        items = list(projection.periods)
        if window == "year_one":
            return [p for p in items if p.period.year_offset == 1]
        return items

    b, c = periods(base), periods(case)
    if not b or not c or len(b) != len(c):
        raise BridgeError("the base and the case do not serve the same periods")

    def total(items: Sequence[Any], fn) -> int:
        return sum(fn(p) for p in items)

    def delta(fn) -> int:
        return total(c, fn) - total(b, fn)

    revenue = delta(lambda p: p.pl["revenue"])
    costs = delta(lambda p: p.pl["cost_of_sales"] + p.pl["operating_costs"]
                  + p.pl["other_operating_income"])
    ebitda = delta(lambda p: p.pl["ebitda"])
    wc = delta(lambda p: p.cf["change_in_receivables"] + p.cf["change_in_inventory"]
               + p.cf["change_in_payables"])
    capex = delta(lambda p: p.cf["cash_from_investing"])
    interest_tax = delta(lambda p: p.pl["interest_expense_debt"]
                         + p.pl["interest_expense_funding_line"] + p.pl["interest_income"]
                         + p.pl["other_financial_income"] + p.pl["other_financial_expense"]
                         + p.pl["income_tax"])
    dividends = delta(lambda p: p.cf["dividends_paid"])
    debt = delta(lambda p: p.cf["debt_drawdowns"] + p.cf["debt_repayments"]
                 + p.cf["funding_line_movement"])
    cash = c[-1].bs["cash"] - b[-1].bs["cash"]
    if c[0].cf["opening_cash"] != b[0].cf["opening_cash"]:
        raise BridgeError("the base and the case open on different cash")
    if revenue + costs != ebitda:
        raise BridgeError("revenue + costs %d != EBITDA %d" % (revenue + costs, ebitda))
    cfo_identity = delta(lambda p: p.cf["cash_from_operating"])
    if ebitda + wc + interest_tax != cfo_identity:
        raise BridgeError("EBITDA + working capital + interest and tax %d != operating cash %d"
                          % (ebitda + wc + interest_tax, cfo_identity))
    parts = {"revenue": revenue, "costs": costs, "ebitda": ebitda, "working_capital": wc,
             "capex": capex, "interest_tax": interest_tax, "dividends": dividends,
             "debt": debt, "cash": cash}
    summed = revenue + costs + wc + capex + interest_tax + dividends + debt
    if summed != cash:
        raise BridgeError("the bridge sums to %d, closing cash moved by %d" % (summed, cash))
    steps = []
    for step_id, subtotal, is_total, label in pack.bridge_steps:
        steps.append({"id": step_id, "label": dict(label), "subtotal": subtotal, "total": is_total,
                      "figure": _fig(parts[step_id])})
    return {"window": window, "period": c[-1].period.label if window == "horizon"
            else c[-1].period.label, "steps": steps, "sums_exactly": True,
            "closing_cash_base": _fig(b[-1].bs["cash"]), "closing_cash_case": _fig(c[-1].bs["cash"])}


# ── the cockpit ──────────────────────────────────────────────────────────

def _lever_payload(spec: Any, d: LeverDefault, value: Optional[Tuple[Fraction, ...]],
                   origin: str, year0: str, pack: CockpitPack,
                   in_force: Mapping[str, Tuple[Fraction, ...]]) -> Dict[str, Any]:
    def text(v: Fraction) -> str:
        return _exact_decimal(v)

    def shaped(values: Optional[Tuple[Fraction, ...]]) -> Any:
        if values is None:
            return None
        if spec.shape == "scalar" or len(set(values)) == 1:
            return text(values[0])
        return [text(v) for v in values]

    basis = dict(d.basis)
    inert = d.inert
    if spec.id == "eur_ron":
        share = (in_force.get("imported_share") or (Fraction(0),))[0]
        if share > 0:
            basis = _both(pack, "eur_ron", "stated", share=_per_lang(fmt_pct, share))
            inert = None
    if spec.id == "imported_share" and value is not None and value[0] > 0:
        basis = _both(pack, "imported_share", "stated", share=_per_lang(fmt_pct, value[0]))
    unit_display = (lambda v, l: fmt_pct(v, l)) if spec.unit == "pct" else fmt_days
    return {
        "id": spec.id, "group": spec.group, "unit": spec.unit, "shape": spec.shape,
        "label": dict((l, spec.label[l].format(year0=year0)) for l in _LANGS),
        "value": shaped(value), "default": shaped(d.values),
        "is_default": origin == "default" or value == d.values, "origin": origin,
        "display": (None if value is None else
                    dict((l, unit_display(value[0], l)) for l in _LANGS)),
        "range": dict(zip(("min", "max"), (text(v) for v in effective_range(spec, d.values))),
                      step=text(spec.step)),
        # the slider's FIXED scale (packs/forecast/cockpit.yaml#levers[].range
        # .decimals): the page reads it, never the decimals of `value`
        "decimals": spec.decimals,
        "basis": basis, "source": d.source, "measured": d.measured,
        "follows": d.follows if origin == "default" else None,
        "inert": inert, "locked": d.locked,
        "engine_drivers": list(spec.drivers),
    }


def _exact_decimal(value: Fraction) -> str:
    value = Fraction(value)
    scaled = value * 10 ** 12
    if scaled.denominator != 1:
        scaled = Fraction(_half_up(scaled))
    digits = ("%d" % abs(int(scaled))).rjust(13, "0")
    whole, frac = digits[:-12], digits[-12:].rstrip("0")
    return ("-" if value < 0 else "") + whole + ("." + frac if frac else "")


def build_cockpit(anchor_payload: Dict[str, Any], prior_periods: Sequence[Dict[str, Any]],
                  context: Any = None, *, case_id: str = "base",
                  levers: Optional[Mapping[str, Any]] = None,
                  saved: Optional[Tuple[str, Mapping[str, Any]]] = None,
                  pack: Optional[CockpitPack] = None) -> Dict[str, Any]:
    """The cockpit of one book under one lever set. ``case_id`` is a built-in
    case or a saved one (``saved`` then carries (name, levers) read from the
    company's prefs); ``levers`` are the sliders moved on top of it."""
    pack = pack or cockpit_pack()
    years, months = pack.total_years, pack.monthly_months
    if saved is None and case_id not in pack.case_by_id:
        raise pack.refusal("unknown_case", "case_id", case=case_id,
                           cases=", ".join(c.id for c in pack.cases))
    base_request = PlanRequest(total_years=years, monthly_months=months)
    base_plan, _ = project_levers(anchor_payload, prior_periods, base_request, context)
    reference = _reference_rate(pack)
    priced_at = "book"
    if base_plan.projection.shortfall is not None and reference is not None:
        # the base plan itself draws a credit line this book cannot price:
        # the base case is priced at the reference rate, and says so
        base_plan, _ = project_levers(anchor_payload, prior_periods,
                                      _with_reference(base_request, reference[0], pack), context)
        priced_at = "reference"
    base_projection = base_plan.projection
    defaults = _defaults(base_plan, anchor_payload, pack)
    opening = base_plan.inputs["opening"]
    history = base_plan.inputs["history"]
    anchor_year = int(str(opening.period_end)[:4])
    year0 = str(anchor_year)
    in_force, case_facts, origin = resolve_levers(
        defaults, case_id if saved is None else "__saved__",
        saved[1] if saved is not None else {}, levers or {}, years, anchor_year, pack)
    request = compile_levers(in_force, defaults, years, months, pack)
    rate_set = origin.get("interest_rate") in ("user", "case")
    if rate_set:
        priced_at = "user"
    elif priced_at == "reference":
        request = _with_reference(request, reference[0], pack)
    if request.has_levers():
        plan, _ = project_levers(anchor_payload, prior_periods, request, context)
        if (plan.projection.shortfall is not None and not rate_set and reference is not None
                and priced_at != "reference"):
            request = _with_reference(request, reference[0], pack)
            plan, _ = project_levers(anchor_payload, prior_periods, request, context)
            priced_at = "reference"
    else:
        plan = base_plan
    projection = plan.projection
    if projection.shortfall is not None or base_projection.shortfall is not None:
        refusal = (projection.shortfall or base_projection.shortfall)
        raise CockpitError(refusal.sentence.get("code") or "funding_line_unpriceable",
                           refusal.sentence.get("text") or "", "interest_rate")

    plan_years = _years(projection)
    base_years = _years(base_projection)
    agg = [(n, label, _aggregate(items)) for n, label, items in plan_years]
    base_agg = [(n, label, _aggregate(items)) for n, label, items in base_years]
    final_n, final_label, final = agg[-1]

    # 1. EBITDA in the final year, and its margin against today
    revenue0 = history.revenue
    margin0 = (Fraction(history.ebitda, revenue0) if revenue0 and history.ebitda is not None
               else None)
    margin = Fraction(final["pl.ebitda"], final["pl.revenue"]) if final["pl.revenue"] else None
    ebitda_block = {
        "period": final_label, "figure": _fig(final["pl.ebitda"]),
        "margin_ppm": None if margin is None else _ppm(margin),
        "margin_year0_ppm": None if margin0 is None else _ppm(margin0),
        "margin_change_ppm": (None if margin is None or margin0 is None
                              else _ppm(margin) - _ppm(margin0)),
        "display": dict((l, {"amount": fmt_money(final["pl.ebitda"], l, pack),
                             "margin": None if margin is None else fmt_pct(margin, l),
                             "margin_year0": None if margin0 is None else fmt_pct(margin0, l)})
                        for l in _LANGS),
    }

    # 2. cumulative free cash flow: operating + investing cash, every period
    fcf = sum(p.cf["cash_from_operating"] + p.cf["cash_from_investing"] for p in projection.periods)
    fcf_block = {"from": agg[0][1], "to": final_label, "figure": _fig(fcf),
                 "formula": {"ro": "numerar din exploatare + numerar din investiții, cumulat",
                             "en": "operating cash + investing cash, cumulative"},
                 "display": dict((l, fmt_money(fcf, l, pack)) for l in _LANGS)}

    # 3. minimum cash, or the funding need and its month
    periods = list(projection.periods)
    peak = max(p.bs["revolver"] for p in periods)
    funding_interest = -sum(p.pl["interest_expense_funding_line"] for p in periods)
    if peak > 0:
        first = next(p for p in periods if p.checks["funding_line_draw_cents"] > 0)
        peak_at = next(p for p in periods if p.bs["revolver"] == peak)
        cash_block = {
            "kind": "funding_need", "figure": _fig(peak),
            "first_period": first.period.label, "first_granularity": first.period.granularity,
            "peak_period": peak_at.period.label,
            "funding_interest": _fig(funding_interest),
            "display": dict((l, {"amount": fmt_money(peak, l, pack),
                                 "when": month_label(first.period.label, l, pack),
                                 "interest": fmt_money(funding_interest, l, pack)})
                            for l in _LANGS)}
    else:
        low = min(periods, key=lambda p: (p.bs["cash"], p.period.index))
        cash_block = {
            "kind": "min_cash", "figure": _fig(low.bs["cash"]), "period": low.period.label,
            "granularity_note": {"ro": "la închiderile de perioadă: lunar în primul an, anual după",
                                 "en": "at period closes: monthly in year one, annual after"},
            "display": dict((l, {"amount": fmt_money(low.bs["cash"], l, pack),
                                 "when": month_label(low.period.label, l, pack)})
                            for l in _LANGS)}

    # 4. DSCR in plan year one against the ratio table's threshold
    threshold, band = _dscr_threshold()
    y1_label, y1 = agg[0][1], agg[0][2]
    value, num, den = _dscr(y1)
    if value is None:
        dscr_block = {"period": y1_label, "status": "not_applicable",
                      "numerator": _fig(num), "denominator": _fig(den),
                      "threshold": _exact_decimal(threshold), "threshold_band": band,
                      "formula": pack.dscr_formula}
    else:
        dscr_block = {"period": y1_label, "kind": "projected", "value_micros": _ppm(value),
                      "numerator": _fig(num), "denominator": _fig(den),
                      "threshold": _exact_decimal(threshold), "threshold_band": band,
                      "status": "above" if value >= threshold else "below",
                      "colour": "green" if value >= threshold else "red",
                      "formula": pack.dscr_formula,
                      "display": dict((l, {"value": fmt_ratio(value, l),
                                           "threshold": fmt_ratio(threshold, l)}) for l in _LANGS)}

    # the chart: EBITDA bars and the cash line, the gap before the funding line
    chart_ebitda = [{"period": "FY%s" % year0, "kind": "actual",
                     "amount_minor": history.ebitda}] + [
        {"period": label, "kind": "projected", "amount_minor": a["pl.ebitda"]}
        for _n, label, a in agg]
    chart_cash = [{"period": "FY%s" % year0, "kind": "actual", "granularity": "annual",
                   "cash_minor": opening.cents("cash"), "funding_line_minor": 0,
                   "cash_before_funding_minor": opening.cents("cash"), "gap": False}]
    for p in periods:
        before = p.bs["cash"] - p.bs["revolver"]
        chart_cash.append({"period": p.period.label, "kind": "projected",
                           "granularity": p.period.granularity, "cash_minor": p.bs["cash"],
                           "funding_line_minor": p.bs["revolver"],
                           "cash_before_funding_minor": before, "gap": before < 0})

    # the sentence
    sentence = _sentence(pack, case_id, saved, cash_block, dscr_block, ebitda_block,
                         final_label, margin is not None and margin0 is not None)

    # the statements, per plan year, with year 0 where the book carries it
    statements = _statements(pack, agg, opening, history, year0)
    dscr_by_year = []
    for _n, label, a in agg:
        v, nn, dd = _dscr(a)
        dscr_by_year.append({"period": label, "kind": "projected",
                             "value_micros": None if v is None else _ppm(v),
                             "numerator": _fig(nn), "denominator": _fig(dd),
                             "status": ("not_applicable" if v is None else
                                        ("above" if v >= threshold else "below"))})

    lever_rows = [_lever_payload(spec, defaults[spec.id], in_force.get(spec.id),
                                 origin.get(spec.id, "default"), year0, pack, in_force)
                  for spec in pack.levers]
    cases = []
    for case in pack.cases:
        values, facts = _case_values(case, defaults, years, anchor_year, pack)
        basis = case.basis
        rendered = {}
        for l in _LANGS:
            per = dict((k, (v[l] if isinstance(v, dict) else v)) for k, v in facts.items())
            try:
                rendered[l] = basis[l].format(**per)
            except KeyError:
                rendered[l] = basis[l]
        cases.append({"id": case.id, "label": case.label, "basis": rendered,
                      "levers": dict((k, [_exact_decimal(x) for x in v]) for k, v in values.items())})

    bridges = {"year_one": bridge(base_projection, projection, "year_one", pack),
               "horizon": bridge(base_projection, projection, "horizon", pack)}

    body = {
        "kind": "projection",
        "cockpit_version": SCHEMA_VERSION,
        "currency": anchor_payload.get("currency") or "RON",
        "company_name": anchor_payload.get("company_name"),
        "base_period": {
            "period_end": str(opening.period_end), "label": "FY%s" % year0,
            "figures": {"revenue": _actual(history.revenue), "ebitda": _actual(history.ebitda),
                        "net_income": _actual(history.net_income),
                        "cash": _actual(opening.cents("cash")),
                        "total_assets": _actual(opening.total_assets_cents()),
                        "equity": _actual(sum(opening.cents(l) for l in EQUITY_LINES)),
                        "ebitda_margin_ppm": None if margin0 is None else _ppm(margin0)}},
        "horizon": {"total_years": years, "monthly_months": months,
                    "years": [label for _n, label, _a in agg]},
        "case": {"id": case_id, "name": saved[0] if saved is not None else None,
                 "label": (pack.case_by_id[case_id].label if saved is None
                           else {"ro": saved[0], "en": saved[0]}),
                 "modified": any(o == "user" for o in origin.values())},
        "numbers": {"ebitda_final_year": ebitda_block, "cumulative_fcf": fcf_block,
                    "cash": cash_block, "dscr_year_one": dscr_block},
        "sentence": sentence,
        "chart": {"ebitda": chart_ebitda, "cash": chart_cash,
                  "funding_gap": any(pt["gap"] for pt in chart_cash)},
        "levers": lever_rows,
        "cases": cases,
        "bridge": bridges,
        "statements": statements,
        "dscr_by_year": dscr_by_year,
        "engine_request": {
            "overrides": dict((k, [_exact_decimal(x) if x is not None else None for x in v])
                              for k, v in request.overrides),
            "shocks": [{"id": s.id, "driver_key": s.driver_key, "op": s.op,
                        "value": _exact_decimal(s.value), "start_month": s.start_month}
                       for s in request.shocks]},
        "conventions": [{"id": c["id"], "sentence": c["sentence"]} for c in plan.conventions],
        "funding_line": {"rate_basis": plan.base.assumptions.get("revolver_rate").basis,
                         "floor_minor": plan.base.assumptions.cents("min_cash"),
                         "priced_at": priced_at,
                         "reference": (None if priced_at != "reference" else
                                       {"rate": _exact_decimal(reference[0]),
                                        "series": reference[1].evidence(),
                                        "basis": _both(pack, "interest_rate", "reference",
                                                       rate=_per_lang(lambda v, l: fmt_pct(v, l, 2),
                                                                      reference[0]),
                                                       published=reference[1].published)})},
        "cost_behaviour": [
            {"pool": p.name, "label": pack.export["pools"].get(p.name, {"ro": p.name, "en": p.name}),
             "base_minor": p.base_cents, "fixed_share_ppm": p.fixed_share_micros,
             "tier": p.tier, "rule_id": p.rule_id, "sentence": p.sentence}
            for p in base_plan.inputs["pools"].pools()],
        "not_modelled": [{"id": key, "sentence": text} for key, text in _unserved()],
        # what the page debounces a slider by, and the budget the answer is
        # held to (packs/forecast/levers.yaml#latency): read, never typed twice
        "client": _client_block(),
        "pins": {"pack_id": pack.pack_id, "cockpit_pack": pack.digest,
                 "macro_pack": _file_digest(macro_pack().path),
                 "engine_version": _engine_version()},
    }
    body["pins"]["body_hash"] = "sha256:" + hashlib.sha256(json.dumps(
        body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    return body


def _client_block() -> Dict[str, int]:
    from .levers_pack import serving_pack
    latency = serving_pack().latency
    return {"debounce_ms": int(latency["debounce_ms"]),
            "budget_ms": int(latency["chart_inprocess_p50_ms"])}


_DIGESTS = {}  # type: Dict[str, str]


def _file_digest(path: str) -> str:
    if path not in _DIGESTS:
        with open(path, "rb") as fh:
            _DIGESTS[path] = "sha256:" + hashlib.sha256(fh.read()).hexdigest()
    return _DIGESTS[path]


def _engine_version() -> str:
    import engine
    return str(engine.__version__)


def _unserved() -> List[Tuple[str, str]]:
    from .levers_pack import plan_pack
    return [(str(key), str(text)) for key, text in plan_pack().unserved]


def export_document(payload: Dict[str, Any], pack: Optional[CockpitPack] = None) -> Dict[str, Any]:
    """The bank export's data (POST .../cockpit/export): the cockpit payload
    as served, and an assumptions page built FROM it — every lever with its
    value, where the value came from and its basis, the DSCR formula and
    threshold, the funding line, the measured fixed/variable split, the
    engine's conventions, what the model does not cover and every external
    source cited. Nothing is recomputed here."""
    pack = pack or cockpit_pack()
    sources = {}  # type: Dict[str, Any]
    for lever in payload["levers"]:
        for item in (lever.get("source") or {}).get("series") or []:
            sources[item["series_id"]] = item
        sector = (lever.get("source") or {}).get("sector")
        if sector:
            sources[sector.get("source_id")] = {"series_id": sector.get("source_id"),
                                                "source": sector.get("source"),
                                                "source_url": sector.get("source_url"),
                                                "kind": "sector dataset"}
    levers = []
    for lever in payload["levers"]:
        levers.append({"id": lever["id"], "label": lever["label"], "value": lever["value"],
                       "display": lever["display"], "origin": lever["origin"],
                       "origin_label": pack.export["origin"].get(lever["origin"]),
                       "basis": lever["basis"], "measured": lever["measured"],
                       "inert": lever["inert"], "locked": lever["locked"]})
    case = payload["case"]
    case_basis = None
    for item in payload["cases"]:
        if item["id"] == case["id"]:
            case_basis = item["basis"]
    numbers = payload["numbers"]
    return {
        "document": {
            "kind": "bank_forecast", "title": pack.export["title"],
            "company_name": payload.get("company_name"), "currency": payload.get("currency"),
            "period_id": payload.get("period_id"), "base_period": payload["base_period"],
            "horizon": payload["horizon"], "case": case, "sentence": payload["sentence"],
            "projected_note": pack.export["projected_note"],
            "sections": pack.export["sections"],
            "pins": dict(payload["pins"]),
        },
        "cockpit": payload,
        "assumptions_page": {
            "title": pack.export["assumptions_title"],
            "case": {"id": case["id"], "label": case["label"], "basis": case_basis},
            "levers": levers,
            "dscr": {"formula": pack.dscr_formula,
                     "threshold": numbers["dscr_year_one"]["threshold"],
                     "threshold_band": numbers["dscr_year_one"]["threshold_band"]},
            "funding_line": payload["funding_line"],
            "cost_behaviour": payload["cost_behaviour"],
            "conventions": payload["conventions"],
            "not_modelled": payload["not_modelled"],
            "sources": [sources[k] for k in sorted(sources)],
        },
    }


def _sentence(pack: CockpitPack, case_id: str, saved: Optional[Tuple[str, Any]],
              cash: Mapping[str, Any], dscr: Mapping[str, Any], ebitda: Mapping[str, Any],
              final_label: str, with_margin: bool) -> Dict[str, Any]:
    out = {"template": [], "facts": {}}  # type: Dict[str, Any]
    for lang in _LANGS:
        if saved is not None:
            case = pack.sentence["saved_case"][lang].format(name=saved[0])
        else:
            case = pack.case_by_id[case_id].in_sentence[lang]
        if cash["kind"] == "funding_need":
            # a first draw the plan knows only to the year (after the monthly
            # months) is said as the year, never as if it were a month
            funding_key = ("funding_annual" if cash.get("first_granularity") == "annual"
                           else "funding")
            cash_text = pack.sentence[funding_key][lang].format(
                amount=cash["display"][lang]["amount"], when=cash["display"][lang]["when"])
        else:
            cash_text = pack.sentence["no_funding"][lang].format(
                amount=cash["display"][lang]["amount"], when=cash["display"][lang]["when"])
        year = _year_of(dscr["period"])
        if dscr["status"] == "not_applicable":
            dscr_text = pack.sentence["dscr_none"][lang].format(year=year)
        else:
            key = "dscr_above" if dscr["status"] == "above" else "dscr_below"
            dscr_text = pack.sentence[key][lang].format(
                dscr=dscr["display"][lang]["value"], year=year,
                threshold=dscr["display"][lang]["threshold"])
        if with_margin:
            ebitda_text = pack.sentence["ebitda"][lang].format(
                amount=ebitda["display"][lang]["amount"], year=_year_of(final_label),
                margin=ebitda["display"][lang]["margin"],
                margin0=ebitda["display"][lang]["margin_year0"])
        else:
            ebitda_text = pack.sentence["ebitda_no_revenue"][lang].format(
                amount=ebitda["display"][lang]["amount"], year=_year_of(final_label))
        out[lang] = pack.sentence["frame"][lang].format(case=case, cash=cash_text,
                                                        dscr=dscr_text, ebitda=ebitda_text)
    out["template"] = ["frame",
                       ("funding_annual" if cash.get("first_granularity") == "annual" else "funding")
                       if cash["kind"] == "funding_need" else "no_funding",
                       {"above": "dscr_above", "below": "dscr_below"}.get(dscr["status"], "dscr_none"),
                       "ebitda" if with_margin else "ebitda_no_revenue"]
    out["facts"] = {"cash": cash["figure"], "dscr": dscr.get("value_micros"),
                    "ebitda": ebitda["figure"]}
    return out


_YEAR0_PL = {
    "pl.revenue": lambda h: h.revenue,
    "pl.cost_of_sales": lambda h: None if h.cogs is None else -h.cogs,
    "pl.operating_costs": lambda h: None if h.opex is None else -h.opex,
    "pl.other_operating_income": lambda h: h.other_operating_income,
    "pl.ebitda": lambda h: h.ebitda,
    "pl.interest_income": lambda h: h.interest_income,
    "pl.pretax_result": lambda h: h.pretax,
    "pl.income_tax": lambda h: None if h.income_tax is None else -h.income_tax,
    "pl.net_income": lambda h: h.net_income,
}


def _statements(pack: CockpitPack, agg: Sequence[Tuple[int, str, Dict[str, int]]],
                opening: Any, history: Any, year0: str) -> Dict[str, Any]:
    """The annual statements: every served line, one projected figure per
    plan year, and year 0 where the actual book carries the line."""
    balances = opening.balances()
    year0_bs = dict(("bs." + k, v) for k, v in balances.items())
    year0_bs["bs_totals.assets"] = sum(balances[l] for l in ASSET_LINES)
    year0_bs["bs_totals.equity"] = sum(balances[l] for l in EQUITY_LINES)
    year0_bs["bs_totals.equity_plus_liabilities"] = sum(balances[l] for l in EL_LINES)
    out = {"years": ["FY%s" % year0] + [label for _n, label, _a in agg]}
    for section in ("pl", "bs", "cf"):
        rows = []
        for line, label in pack.lines.items():
            if not (line.startswith(section + ".") or (section == "bs" and line.startswith("bs_totals."))):
                continue
            if line not in agg[0][2]:
                continue
            if section == "pl":
                y0 = _YEAR0_PL.get(line)
                zero = _actual(y0(history) if y0 is not None else None)
            elif section == "bs":
                zero = _actual(year0_bs.get(line))
            else:
                zero = None
            values = [{"period": label_, "kind": "projected", "amount_minor": a[line]}
                      for _n, label_, a in agg]
            row = {"line": line, "label": dict(label), "values": values}
            if zero is not None:
                row["year0"] = dict(zero, period="FY%s" % year0)
            rows.append(row)
        out[section] = rows
    return out
