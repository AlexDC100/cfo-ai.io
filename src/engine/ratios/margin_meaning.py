"""WHEN A MARGIN IS NOT MEANINGFUL — one rule, asked by every surface that
prints a margin over turnover.

THE DEFECT THIS EXISTS FOR
==========================
A margin divides a result by turnover. On a property developer in a
building year (the corpus book ``saga_10_col_realestate``) turnover is a
little rent while the construction cost runs through class 6 and is
capitalised into stock through account 711. The served ratio table printed
an EBITDA margin of -17,884.9%, the forecast cockpit printed -17,886.1% for
the final plan year beside -17,884.9% "today", and its sentence repeated
both. Nothing was wrong with the arithmetic; the percent described an
incidental line, not the company's sales, and printed on a page it reads as
a verdict.

THE RULE (``packs/ratios/margin_meaning.yaml``)
===============================================
A margin over turnover is NOT MEANINGFUL when turnover is non-zero and

    |turnover| < max(floor, share_below x activity)

with activity = total operating expense (cost of sales + operating expenses
+ depreciation). ONE rule, decided here and nowhere else:

  * ``engine.ratios.table`` refuses every margin row the pack lists
    (``margin_not_meaningful``), with the share and the threshold beside
    the code — never a percent;
  * ``GET /api/period`` serves the verdict as ``statements.margin_meaning``
    (``period_block``) wherever it refuses — every other book's body is
    unchanged, and a statements block with no verdict refuses nothing — and
    every dashboard surface reads it before it prints any margin;
  * ``engine.forecast.cockpit`` asks ``judge`` for the actual year and for
    the final plan year, prints the refusal in the four numbers, drops the
    margin clause from its sentence, and the bank export carries both.

A turnover of exactly zero (or absent) is outside the rule: the margins are
already undefined there and keep the refusal they had. An absent activity
means the rule cannot judge, and nothing changes either.

THE ONE NOTE
============
Where the rule refuses a property developer's margins, the reader still needs
to know what the headline EBITDA is made of: since the owner's ruling of
2026-09-26 EBITDA INCLUDES the stock variation (account 711, "Variația
stocurilor de produse") — for a developer, the construction cost capitalised
into stock. The pack's ``note`` names the case (margin refused, account mix
read as real estate by ``engine.industry``, a positive net 711) and the served
figure it quotes (``assembled_pl.inventory_variation.value``, the MEASURED net
711 — never the gross credit turnover). The note carries no arithmetic of its
own: the figure is read, never computed. (Before the ruling the note said the
opposite — that EBITDA left 711 out — and quoted
``ebitda_statutory_with_711``, a figure built on the gross turnover.)

Pure: no I/O beyond the one pack read, no clock. Exact arithmetic
(``fractions.Fraction``) on every comparison; a float is read bit for bit.
Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

import functools
import os
from decimal import Decimal
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

import yaml

__all__ = [
    "MARGIN_NOT_MEANINGFUL",
    "MEANINGFUL",
    "NOT_APPLICABLE",
    "NOT_MEANINGFUL",
    "PACK_FILE",
    "REASON_FLOOR",
    "REASON_SHARE",
    "MarginMeaningPackError",
    "Verdict",
    "fmt_money",
    "judge",
    "money_unit",
    "margin_keys",
    "margin_meaning_pack",
    "note_block",
    "period_block",
    "period_operands",
    "reason_block",
    "refusal_display",
    "served_block",
]

#: The pack, resolved from this file so a source checkout and the backend
#: image (/app/packs — the Dockerfile COPYs packs/) agree.
#: ``MARGIN_MEANING_PACKS_DIR`` overrides it for a test that plants a value.
DEFAULT_PACKS_DIR = Path(__file__).resolve().parents[3] / "packs" / "ratios"
PACK_NAME = "margin_meaning.yaml"
PACK_FILE = "packs/ratios/%s" % PACK_NAME
SCHEMA_VERSION = "margin_meaning/1"

#: The reason code every refused margin carries (the ratio table's
#: ``reason.code``, the period block's ``code``).
MARGIN_NOT_MEANINGFUL = "margin_not_meaningful"

#: Why: turnover under share_below of activity, or under the floor.
REASON_SHARE = "turnover_share_below_threshold"
REASON_FLOOR = "turnover_below_floor"

#: The three states a period (or a plan year) is in.
MEANINGFUL = "meaningful"
NOT_MEANINGFUL = "not_meaningful"
NOT_APPLICABLE = "not_applicable"

#: The only activity basis this revision reads.
ACTIVITY_BASES = ("total_operating_expense",)

#: The one figure the note quotes: the MEASURED net 711 the one EBITDA
#: includes (never the gross 711 credit turnover).
NOTE_FIGURE = "assembled_pl.inventory_variation.value"

_LANGS = ("ro", "en")
_MINUS = "−"


class MarginMeaningPackError(RuntimeError):
    """packs/ratios/margin_meaning.yaml is unusable. Raised, never defaulted:
    a threshold with no stated source is what the pack exists to prevent."""


def pack_path() -> Path:
    override = os.environ.get("MARGIN_MEANING_PACKS_DIR")
    return (Path(override) if override else DEFAULT_PACKS_DIR) / PACK_NAME


def _two(raw: Any, where: str) -> Dict[str, str]:
    if not isinstance(raw, dict) or any(not isinstance(raw.get(l), str) or not raw.get(l).strip()
                                        for l in _LANGS):
        raise MarginMeaningPackError("%s#%s: a ro and an en string are required" % (PACK_FILE, where))
    return {"ro": " ".join(raw["ro"].split()), "en": " ".join(raw["en"].split())}


def _two_raw(raw: Any, where: str) -> Dict[str, str]:
    """A ro/en pair kept verbatim (a leading space is part of the text)."""
    if not isinstance(raw, dict) or any(not isinstance(raw.get(l), str) or not raw.get(l)
                                        for l in _LANGS):
        raise MarginMeaningPackError("%s#%s: a ro and an en string are required" % (PACK_FILE, where))
    return {"ro": raw["ro"], "en": raw["en"]}


def _decimal_text(raw: Any, where: str) -> Fraction:
    if not isinstance(raw, str):
        raise MarginMeaningPackError("%s#%s: a decimal string is required, got %r"
                                     % (PACK_FILE, where, raw))
    try:
        value = Decimal(raw)
    except Exception:
        raise MarginMeaningPackError("%s#%s: %r is not a decimal" % (PACK_FILE, where, raw))
    if not value.is_finite():
        raise MarginMeaningPackError("%s#%s: %r is not finite" % (PACK_FILE, where, raw))
    return Fraction(value)


class MarginMeaningPack(object):
    __slots__ = ("share_below", "share_below_text", "floor", "floor_text", "activity",
                 "applies_to", "display", "note", "money_display")

    def __init__(self, raw: Any) -> None:
        if not isinstance(raw, dict):
            raise MarginMeaningPackError("%s: not a mapping" % PACK_FILE)
        if raw.get("schema_version") != SCHEMA_VERSION:
            raise MarginMeaningPackError("%s: schema_version is %r, expected %r"
                                         % (PACK_FILE, raw.get("schema_version"), SCHEMA_VERSION))
        rule = raw.get("rule")
        if not isinstance(rule, dict):
            raise MarginMeaningPackError("%s#rule: a mapping is required" % PACK_FILE)
        self.activity = rule.get("activity")
        if self.activity not in ACTIVITY_BASES:
            raise MarginMeaningPackError("%s#rule.activity: one of %s, got %r"
                                         % (PACK_FILE, ACTIVITY_BASES, self.activity))
        self.share_below = _decimal_text(rule.get("share_below"), "rule.share_below")
        if not Fraction(0) < self.share_below < Fraction(1):
            raise MarginMeaningPackError("%s#rule.share_below: must lie in (0, 1)" % PACK_FILE)
        self.share_below_text = str(rule["share_below"])
        self.floor = _decimal_text(rule.get("floor"), "rule.floor")
        if self.floor < 0:
            raise MarginMeaningPackError("%s#rule.floor: must not be negative" % PACK_FILE)
        self.floor_text = str(rule["floor"])
        applies = rule.get("applies_to")
        if (not isinstance(applies, list) or not applies
                or any(not isinstance(k, str) or not k for k in applies)
                or len(set(applies)) != len(applies)):
            raise MarginMeaningPackError("%s#rule.applies_to: a list of distinct ratio keys" % PACK_FILE)
        self.applies_to = tuple(applies)
        display = raw.get("display")
        if not isinstance(display, dict):
            raise MarginMeaningPackError("%s#display: a mapping is required" % PACK_FILE)
        self.display = dict((k, _two(display.get(k), "display." + k))
                            for k in ("share", "floor", "basis"))
        for lang in _LANGS:
            if "{share}" not in self.display["share"][lang]:
                raise MarginMeaningPackError("%s#display.share.%s: must place {share}" % (PACK_FILE, lang))
            if "{floor}" not in self.display["floor"][lang]:
                raise MarginMeaningPackError("%s#display.floor.%s: must place {floor}" % (PACK_FILE, lang))
            if "{threshold}" not in self.display["basis"][lang]:
                raise MarginMeaningPackError("%s#display.basis.%s: must place {threshold}"
                                             % (PACK_FILE, lang))
        note = raw.get("note")
        if not isinstance(note, dict):
            raise MarginMeaningPackError("%s#note: a mapping is required" % PACK_FILE)
        requires = note.get("requires")
        if requires != {"margin": NOT_MEANINGFUL, "industry_family": "real_estate",
                        "inventory_variation": "positive"}:
            # The requirements are read as data by `note_block`; a pack that
            # states others would be a rule this revision does not evaluate.
            raise MarginMeaningPackError(
                "%s#note.requires: this revision evaluates exactly margin: not_meaningful, "
                "industry_family: real_estate, inventory_variation: positive; got %r"
                % (PACK_FILE, requires))
        if note.get("figure") != NOTE_FIGURE:
            raise MarginMeaningPackError("%s#note.figure: %s is the one figure this revision reads"
                                         % (PACK_FILE, NOTE_FIGURE))
        text = _two(note, "note")
        for lang in _LANGS:
            if "{amount}" not in text[lang]:
                raise MarginMeaningPackError("%s#note.%s: must place {amount}" % (PACK_FILE, lang))
        # The sentence under a PLAN year's EBITDA, which projects net 711 at
        # 0: it names the actual year the figure belongs to and must not
        # say the EBITDA above includes it.
        plan_year = _two(note.get("plan_year"), "note.plan_year")
        for lang in _LANGS:
            if "{amount}" not in plan_year[lang] or "{year}" not in plan_year[lang]:
                raise MarginMeaningPackError("%s#note.plan_year.%s: must place {amount} and {year}"
                                             % (PACK_FILE, lang))
        self.note = {"id": str(note.get("id") or ""), "requires": dict(requires),
                     "figure": note["figure"], "text": text, "plan_year": plan_year}
        if not self.note["id"]:
            raise MarginMeaningPackError("%s#note.id: missing" % PACK_FILE)
        money = raw.get("money_display")
        if not isinstance(money, dict):
            raise MarginMeaningPackError("%s#money_display: a mapping is required" % PACK_FILE)
        self.money_display = dict((k, _two(money.get(k), "money_display." + k))
                                  for k in ("million", "thousand"))
        for size in ("million", "thousand"):
            for lang in _LANGS:
                if "{value}" not in self.money_display[size][lang]:
                    raise MarginMeaningPackError("%s#money_display.%s.%s: must place {value}"
                                                 % (PACK_FILE, size, lang))


@functools.lru_cache(maxsize=4)
def _load(path: str) -> MarginMeaningPack:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh)
    except OSError as exc:
        raise MarginMeaningPackError("%s cannot be read: %s" % (path, exc))
    return MarginMeaningPack(raw)


def margin_meaning_pack() -> MarginMeaningPack:
    return _load(str(pack_path()))


def margin_keys() -> Tuple[str, ...]:
    """The ratio-table keys the rule refuses together."""
    return margin_meaning_pack().applies_to


# ── exact numbers ───────────────────────────────────────────────────────────


def _exact(value: Any) -> Optional[Fraction]:
    """A number's exact value, or None when it is absent or not a finite
    number (absent is never zero)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Fraction):
        return value
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return Fraction(value)
    if isinstance(value, Decimal):
        return Fraction(value) if value.is_finite() else None
    return None


def _half_up(value: Fraction) -> int:
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


def _number(value: Fraction, places: int, lang: str) -> str:
    """``value`` at ``places`` decimals, half away from zero, in the
    language's separators (ro: 1.234,5; en: 1,234.5)."""
    scaled = _half_up(Fraction(value) * 10 ** places)
    sign = _MINUS if scaled < 0 else ""
    digits = "%d" % abs(scaled)
    if places:
        digits = digits.rjust(places + 1, "0")
        whole, frac = digits[:-places], digits[-places:]
    else:
        whole, frac = digits, ""
    dec, thou = (",", ".") if lang == "ro" else (".", ",")
    return sign + _grouped(whole, thou) + (dec + frac if frac else "")


def _pct_text(share: Fraction, lang: str) -> str:
    """A share as a percent at one decimal — or, when that rounds to zero,
    at the first decimal (up to six) where it does not: a share is never
    printed as 0,0%."""
    for places in range(1, 7):
        if _half_up(share * 100 * 10 ** places) != 0:
            return _number(share * 100, places, lang) + "%"
    return _number(share * 100, 6, lang) + "%"


def _threshold_text(text: str, lang: str) -> str:
    """The pack's share_below as a percent, exactly as written (0.10 ->
    10%, 0.075 -> 7,5% in ro)."""
    pct = format((Decimal(text) * 100).normalize(), "f")
    return (pct.replace(".", ",") if lang == "ro" else pct) + "%"


def _decimal6(value: Fraction) -> str:
    """An exact decimal string at six places, half away from zero."""
    scaled = _half_up(value * 10 ** 6)
    sign = "-" if scaled < 0 else ""
    digits = ("%d" % abs(scaled)).rjust(7, "0")
    return "%s%s.%s" % (sign, digits[:-6], digits[-6:])


def money_unit(amount: Any) -> str:
    """"million" from a million up (in magnitude), "thousand" below."""
    value = _exact(amount)
    return "million" if value is not None and abs(value) >= 1000000 else "thousand"


def fmt_money(amount: Any, lang: str, unit: Optional[str] = None) -> Optional[str]:
    """The pack's money display for an amount in currency units, at one
    decimal: in millions from a million up and in thousands below, unless
    ``unit`` fixes the unit (the note prints in the unit of the EBITDA it
    stands under, so the two read side by side)."""
    value = _exact(amount)
    if value is None:
        return None
    unit = unit or money_unit(value)
    if unit not in ("million", "thousand"):
        raise ValueError("unit must be million or thousand, got %r" % (unit,))
    money = margin_meaning_pack().money_display
    scale = 1000000 if unit == "million" else 1000
    return money[unit][lang].format(value=_number(value / scale, 1, lang))


# ── the verdict ─────────────────────────────────────────────────────────────


class Verdict(object):
    """One period's (or one plan year's) answer. ``status`` is MEANINGFUL,
    NOT_MEANINGFUL or NOT_APPLICABLE; ``reason`` names why a margin is not
    meaningful (REASON_SHARE / REASON_FLOOR) or why the rule does not apply
    (``turnover_absent``, ``turnover_zero``, ``activity_absent``)."""

    __slots__ = ("status", "reason", "turnover", "activity", "share")

    def __init__(self, status: str, reason: Optional[str], turnover: Optional[Fraction],
                 activity: Optional[Fraction], share: Optional[Fraction]) -> None:
        self.status = status
        self.reason = reason
        self.turnover = turnover
        self.activity = activity
        self.share = share

    @property
    def refused(self) -> bool:
        return self.status == NOT_MEANINGFUL


def judge(turnover: Any, activity: Any) -> Verdict:
    """THE rule. ``turnover`` and ``activity`` in the book's currency units
    (any exact or float number; a float is read bit for bit)."""
    pack = margin_meaning_pack()
    t = _exact(turnover)
    a = _exact(activity)
    if t is None:
        return Verdict(NOT_APPLICABLE, "turnover_absent", None, a, None)
    if t == 0:
        return Verdict(NOT_APPLICABLE, "turnover_zero", t, a, None)
    if a is None:
        return Verdict(NOT_APPLICABLE, "activity_absent", t, None, None)
    share = (abs(t) / a) if a > 0 else None
    if abs(t) < pack.floor:
        return Verdict(NOT_MEANINGFUL, REASON_FLOOR, t, a, share)
    if a > 0 and abs(t) < pack.share_below * a:
        return Verdict(NOT_MEANINGFUL, REASON_SHARE, t, a, share)
    return Verdict(MEANINGFUL, None, t, a, share)


def refusal_display(verdict: Verdict, currency: Optional[str] = None) -> Optional[Dict[str, str]]:
    """What a refused margin prints in place of a percent (ro and en), or
    None when the margin is not refused. ``currency`` names the unit of the
    floor (the book's own currency) on the floor branch."""
    if not verdict.refused:
        return None
    pack = margin_meaning_pack()
    out = {}
    for lang in _LANGS:
        if verdict.reason == REASON_SHARE:
            out[lang] = pack.display["share"][lang].format(share=_pct_text(verdict.share, lang))
        else:
            floor = pack.floor_text.replace(".", ",") if lang == "ro" else pack.floor_text
            out[lang] = pack.display["floor"][lang].format(
                floor=("%s %s" % (floor, currency)) if currency else floor)
    return out


def basis_display() -> Dict[str, str]:
    """What "activity" means and the threshold, rendered from the pack."""
    pack = margin_meaning_pack()
    return dict((l, pack.display["basis"][l].format(threshold=_threshold_text(pack.share_below_text, l)))
                for l in _LANGS)


def served_block(verdict: Verdict, inputs: Sequence[str], currency: Optional[str] = None) -> Dict[str, Any]:
    """The verdict as served: the state, the reason, the operands as exact
    six-place decimal strings, the pack's threshold and floor as written,
    the margin keys it covers, the refusal text (ro/en) when refused, and
    where the rule lives."""
    pack = margin_meaning_pack()
    return {
        "version": SCHEMA_VERSION,
        "status": verdict.status,
        "code": MARGIN_NOT_MEANINGFUL if verdict.refused else None,
        "reason": verdict.reason,
        "turnover": None if verdict.turnover is None else _decimal6(verdict.turnover),
        "activity": None if verdict.activity is None else _decimal6(verdict.activity),
        "share": None if verdict.share is None else _decimal6(verdict.share),
        "threshold": pack.share_below_text,
        "floor": pack.floor_text,
        "activity_basis": pack.activity,
        "inputs": list(inputs),
        "margins": list(pack.applies_to),
        "display": refusal_display(verdict, currency),
        "basis": basis_display(),
        "source": PACK_FILE,
    }


def reason_block(verdict: Verdict, inputs: Sequence[str], currency: Optional[str] = None) -> Dict[str, Any]:
    """The ratio table's ``reason`` for a refused margin row: the closed
    code, the operands it read, the share and the threshold as decimal
    strings, and the refusal text — every figure from the verdict, the
    threshold from the pack (TC-10)."""
    pack = margin_meaning_pack()
    return {
        "code": MARGIN_NOT_MEANINGFUL,
        "inputs": list(inputs),
        "cause": verdict.reason,
        "share": None if verdict.share is None else _decimal6(verdict.share),
        "threshold": pack.share_below_text,
        "floor": pack.floor_text,
        "activity_basis": pack.activity,
        "display": refusal_display(verdict, currency),
        "source": PACK_FILE,
    }


# ── the served period ───────────────────────────────────────────────────────

#: Where the rule reads a served period's two operands.
PERIOD_INPUTS = ("assembled_pl.revenue", "assembled_pl.total_operating_expense")
#: The legacy fallback, for a statements block that carries no assembled P&L.
LEGACY_INPUTS = ("incomeStatement.revenue",
                 "incomeStatement.costOfGoodsSold+incomeStatement.operatingExpenses"
                 "+incomeStatement.depreciationAmortization")


def _dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def period_operands(statements: Mapping[str, Any]) -> Tuple[Any, Any, Tuple[str, ...]]:
    """(turnover, activity, inputs) of a served statements block: the
    assembled P&L's revenue and total operating expense — the same two
    figures every served margin and DIO/DPO divide — else the legacy
    incomeStatement's revenue and cost of sales + operating expenses +
    depreciation. An operand the block does not carry is None."""
    statements = _dict(statements)
    apl = _dict(statements.get("assembled_pl"))
    if "revenue" in apl or "total_operating_expense" in apl:
        return apl.get("revenue"), apl.get("total_operating_expense"), PERIOD_INPUTS
    inc = _dict(statements.get("incomeStatement"))
    parts = [_exact(inc.get(k)) for k in ("costOfGoodsSold", "operatingExpenses",
                                          "depreciationAmortization")]
    activity = None if any(p is None for p in parts) else sum(parts, Fraction(0))
    return inc.get("revenue"), activity, LEGACY_INPUTS


def period_verdict(statements: Mapping[str, Any]) -> Tuple[Verdict, Tuple[str, ...]]:
    turnover, activity, inputs = period_operands(statements)
    return judge(turnover, activity), inputs


def note_block(verdict: Verdict, *, industry_family: Optional[str], inventory_variation: Any,
               unit_of: Any = None, year: Optional[str] = None,
               money: Optional[Callable[[Any, str, Optional[str]], Optional[str]]] = None
               ) -> Optional[Dict[str, Any]]:
    """The one note, when every requirement of ``note.requires`` holds;
    None otherwise. ``inventory_variation`` is READ from the served
    ``assembled_pl.inventory_variation.value`` — the measured net 711 the one
    EBITDA includes (in currency units; None when it was refused, and then
    there is no note); the note computes nothing. ``unit_of`` is the EBITDA
    printed above the note: the amount prints in its unit (millions when it
    is a million or more), so the two read side by side. ``year`` is given
    where the page shows a PLAN year's EBITDA above the note (the cockpit's
    final plan year, the bank export): plan years project net 711 at 0, so
    the note is the pack's ``plan_year`` sentence — the figure belongs to
    ``year`` (the actual year) and the EBITDA above does NOT include it.
    Without ``year`` the EBITDA above is the actual year's and includes it."""
    pack = margin_meaning_pack()
    figure = _exact(inventory_variation)
    if not (verdict.refused and industry_family == "real_estate"
            and figure is not None and figure > 0):
        return None
    render = money or fmt_money
    unit = money_unit(unit_of) if _exact(unit_of) is not None else None
    display = {}
    for lang in _LANGS:
        amount = render(inventory_variation, lang, unit)
        if year:
            display[lang] = pack.note["plan_year"][lang].format(amount=amount, year=year)
        else:
            display[lang] = pack.note["text"][lang].format(amount=amount)
    return {
        "id": pack.note["id"],
        # The served figure, verbatim: the note reads it and computes nothing.
        "figure": {"source": pack.note["figure"], "value": inventory_variation, "year": year},
        "requires": dict(pack.note["requires"]),
        "display": display,
        "source": PACK_FILE,
    }


def period_block(statements: Mapping[str, Any], industry_signal: Any = None) -> Dict[str, Any]:
    """``statements.margin_meaning`` for one served period: the
    verdict over its statements and, for the one case the pack names, the
    note. What the dashboard reads before it prints a margin."""
    verdict, inputs = period_verdict(statements)
    currency = _dict(statements).get("currency")
    block = served_block(verdict, inputs, currency if isinstance(currency, str) and currency else None)
    apl = _dict(_dict(statements).get("assembled_pl"))
    signal = _dict(industry_signal)
    family = signal.get("family") if signal.get("verdict") == "decided" else None
    # The EBITDA the dashboard prints above the note is the ONE served
    # EBITDA (`assembled_pl.ebitda`, the headline tile); the note quotes the
    # net 711 inside it.
    block["note"] = note_block(verdict, industry_family=family,
                               inventory_variation=_dict(apl.get("inventory_variation")).get("value"),
                               unit_of=apl.get("ebitda"))
    return block
