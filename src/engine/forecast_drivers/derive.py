"""Builds the BASE assumption set from a company's own actuals.

THE HARD PART IS THE DEFAULTS, NOT THE SCHEMA
=============================================
Every default below is derived from the book's own numbers and carries
its derivation: the method, the periods it consumed, and the input
values with the payload location each was read from. `default 8.2% =
3-year CAGR` is the shape; this module produces both halves and the type
system refuses to emit one without the other.

THE LEVEL / RATE DISTINCTION IS THE WHOLE DESIGN
================================================
A LEVEL is a state — a margin, a days-ratio, an effective tax rate. One
period measures it exactly, so a one-period book defaults every level
driver at full confidence.

A RATE is a change per year. One period cannot measure a change AT ALL.
This is where the pressure to lie is: the tempting default is 0% growth,
which reads as modest and is in fact a claim — that this company's
nominal revenue falls in real terms every year of the forecast. Rate
drivers on a one-period book fall to the macro anchor in
`packs/forecast/ro_macro.yaml`, are stamped `fallback`, and say so.

WHAT IS REFUSED
===============
`headcount` — no trial balance carries an employee count, so it is
absent, and `avg_personnel_cost` with it. Dividing personnel cost by a
guessed average wage would manufacture both.
`new_debt` — a financing plan, not a measurement.
`capex_rate` and `debt_repayment_years` — a number exists, but from an
assumption the engine already declares as one. Emitted `fallback` with
that declaration carried through verbatim.
`dividend_payout` — absent on every book: distributions are not
measurable from closing balances (plan/2 contract 3.4), and the cash-flow
statement's `dividends_paid` is a market-average inference.

ONE DERIVATION, SHARED WITH THE MODEL (plan/2 B3, contract 4)
=============================================================
Every concept this package shares with `engine.forecast` — the cost-of-
sales share (read back as a gross margin), the operating-cost share, the
three working-capital day counts, the maintenance-capital rate, the
closing-NBV depreciation rate, the borrowing rate, the dividend payout and
the one-period revenue growth — is READ from the model's own resolution of
the same payload (`engine.forecast.project.assumptions_for_payload`), with
its exact integer and its tier. It is never measured a second time here,
so the two packages cannot hold two values for one concept; the
`forecast-authority` gate compares the integers on every committed book.
Multi-period revenue CAGR stays this package's derivation (the authority
over the eligible history).

Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

import datetime
import re
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .packdata import DriverSpec, ForecastPack
from .reader import ActualsPeriod
from .types import (AssumptionSet, Derivation, DerivationInput, Driver,
                    DriverError)

__all__ = ["build_base_set", "BASE_CASE_BASIS"]

BASE_CASE_BASIS = (
    "Every driver defaulted from this company's own actuals; each carries "
    "the method, the periods it used and the values it read."
)

#: A CAGR needs a real elapsed span, not an assumed one. Two period ends
#: 18 months apart are not a year of growth, and calling them one would
#: overstate the rate by half.
_DAYS_PER_YEAR = 365.25

#: Below this many years between the first and last period, a compound
#: rate is not annualisable without amplifying noise into a headline
#: growth number.
_MIN_SPAN_YEARS = 0.5


def _parse_date(text):
    # type: (str) -> Optional[datetime.date]
    """Parse a stored ISO date. Reading a persisted date is not reading a
    clock — nothing here consults `today`, so output stays deterministic."""
    if not text:
        return None
    try:
        return datetime.date(int(text[0:4]), int(text[5:7]), int(text[8:10]))
    except (ValueError, IndexError):
        return None


def _span_years(older, newer):
    # type: (str, str) -> Optional[float]
    a = _parse_date(older)
    b = _parse_date(newer)
    if a is None or b is None:
        return None
    days = (b - a).days
    if days <= 0:
        return None
    return days / _DAYS_PER_YEAR


def _round(pack, unit, value):
    # type: (ForecastPack, str, Optional[float]) -> Optional[float]
    if value is None:
        return None
    return round(float(value), pack.round_for(unit))


# ──────────────────────────────────────────────────────────────────────
# driver constructors
# ──────────────────────────────────────────────────────────────────────

def _absent(spec, note, period_end):
    # type: (DriverSpec, str, str) -> Driver
    """A driver with no source. value is None — NEVER 0."""
    return Driver(
        key=spec.key, label=spec.label, unit=spec.unit, kind=spec.kind,
        favourable_direction=spec.favourable_direction,
        value=None, status="absent",
        derivation=Derivation(
            method="no_source",
            method_label="not derivable from this book",
            periods_used=(period_end,) if period_end else (),
            inputs=(), source="book", note=note),
        case_rule=spec.case_rule, why=spec.why)


def _absent_with_inputs(spec, method, method_label, note, period_end, inputs):
    # type: (DriverSpec, str, str, str, str, Sequence[DerivationInput]) -> Driver
    """An ABSENT driver whose refusal was itself measured.

    `_absent` carries no inputs, which is right when the book simply has
    no source. It is wrong when the refusal was a comparison — a share
    against a declared gate — because then the note quotes numbers and a
    reader has nothing to check them against. TC-10: the numbers in that
    sentence must be the driver's own inputs, not prose.
    """
    return Driver(
        key=spec.key, label=spec.label, unit=spec.unit, kind=spec.kind,
        favourable_direction=spec.favourable_direction,
        value=None, status="absent",
        derivation=Derivation(
            method=method, method_label=method_label,
            periods_used=(period_end,) if period_end else (),
            inputs=inputs, source="book", note=note),
        case_rule=spec.case_rule, why=spec.why)


def _make(spec, pack, value, method, method_label, periods, inputs,
          source="book", note="", status="derived", exact=None, tier=None,
          rule_id=None, evidence=None, fallback_steps=()):
    # type: (DriverSpec, ForecastPack, Optional[float], str, str, Sequence[str], Sequence[DerivationInput], str, str, str, Optional[int], Optional[str], Optional[str], Any, Sequence[Dict[str, str]]) -> Driver
    if value is None:
        return _absent(spec, note or "No value could be computed.",
                       periods[-1] if periods else "")
    if spec.forced_status == "fallback":
        status = "fallback"
    return Driver(
        key=spec.key, label=spec.label, unit=spec.unit, kind=spec.kind,
        favourable_direction=spec.favourable_direction,
        value=_round(pack, spec.unit, value), status=status,
        derivation=Derivation(method=method, method_label=method_label,
                              periods_used=periods, inputs=inputs,
                              source=source, note=note),
        case_rule=spec.case_rule, why=spec.why, exact=exact, tier=tier,
        rule_id=rule_id, evidence=evidence, fallback_steps=fallback_steps)


# ──────────────────────────────────────────────────────────────────────
# the SHARED concepts — read from engine.forecast (contract 4)
# ──────────────────────────────────────────────────────────────────────

#: Divisor from an exact integer to the display value, by driver unit.
_EXACT_SCALE = {"rate": 1000000, "days": 1000000}


class EngineResolution(object):
    """engine.forecast's resolved drivers for ONE period, or its refusal.

    Built once per period by :func:`build_base_set`. A payload the engine
    cannot open (an opening partition that does not reproduce the served
    balance sheet, no served balance sheet at all) yields no assumption
    set and the engine's own sentence: every shared concept is then ABSENT
    for that stated reason, never re-measured here."""

    __slots__ = ("assumptions", "refusal")

    def __init__(self, period):
        # type: (ActualsPeriod) -> None
        from engine.forecast.errors import ForecastError
        from engine.forecast.project import assumptions_for_payload

        self.assumptions = None
        self.refusal = ""
        try:
            self.assumptions = assumptions_for_payload(period._payload)
        except ForecastError as exc:
            self.refusal = str(exc)

    def get(self, model_key):
        # type: (str) -> Any
        if self.assumptions is None:
            return None
        return self.assumptions[model_key]


def _from_engine(spec, pack, period, engine, model_key, method_label,
                 complement=False):
    # type: (DriverSpec, ForecastPack, ActualsPeriod, EngineResolution, str, str, bool) -> Driver
    """One shared concept, read from the engine's resolution of this book.

    ``complement`` publishes one minus the engine's share (the gross margin
    over the engine's cost-of-sales share). The exact integer and the tier
    travel with the value; the display value is its round_dp rounding."""
    item = engine.get(model_key)
    if item is None:
        return _absent(
            spec, "engine.forecast could not open this book, so %s has no "
                  "value: %s" % (model_key, engine.refusal),
            period.period_end)
    if item.exact is None:
        return _absent(spec, item.basis, period.period_end)
    exact = int(item.exact)
    if complement:
        exact = _EXACT_SCALE[spec.unit] - exact
    value = float(exact) / _EXACT_SCALE[spec.unit]
    first = DerivationInput(
        "engine.forecast.%s" % model_key, period.period_end, value,
        "%s (engine.forecast %s)" % (
            spec.authority.split(" (")[0],
            item.rule_id or model_key))
    return _make(spec, pack, value, "engine_forecast", method_label,
                 (period.period_end,), (first,),
                 note=item.basis, exact=exact, tier=item.tier,
                 rule_id=item.rule_id, evidence=item.evidence,
                 fallback_steps=item.fallback_steps,
                 status=("derived" if item.tier == "book" else "fallback"))


# ──────────────────────────────────────────────────────────────────────
# RATE drivers — a change per year
# ──────────────────────────────────────────────────────────────────────

def _growth_from_engine(spec, pack, history, newest, engine):
    # type: (DriverSpec, ForecastPack, Sequence[ActualsPeriod], ActualsPeriod, EngineResolution) -> Driver
    """One-period revenue growth: the engine's ladder (contract 3.4) — the
    macro anchor for a book whose jurisdiction the anchor serves, else the
    convention terminal rung — with its exact integer, tier and steps."""
    item = engine.get("revenue_growth")
    if item is None or item.exact is None:
        return _absent(spec, "engine.forecast could not resolve revenue "
                             "growth for this book: %s" % (engine.refusal,),
                       newest.period_end)
    exact = int(item.exact)
    value = float(exact) / _EXACT_SCALE[spec.unit]
    common = dict(exact=exact, tier=item.tier, rule_id=item.rule_id,
                  evidence=item.evidence, fallback_steps=item.fallback_steps)
    if item.tier == "macro":
        anchor = pack.anchor(spec.macro_anchor)
        note = (
            "This workspace holds %d actuals period%s, so %s's own rate of "
            "change cannot be measured. Held at the %s (%s), a nominal "
            "continuation at constant real volume. Replace this the moment a "
            "second period is loaded."
            % (len(history), "" if len(history) == 1 else "s",
               "the company", anchor.label.lower(), anchor.source))
        return _make(
            spec, pack, value, "pack_macro",
            "no company history — %s" % (anchor.label.lower(),),
            (newest.period_end,),
            (DerivationInput(anchor.key, anchor.stated_as_of, value, "pack"),),
            source="pack:%s@%s" % (pack.macro_pack_id, pack.macro_pack_version),
            note=note, status="fallback", **common)
    return _make(
        spec, pack, value, "pack_convention",
        "no company history and no macro anchor — the convention rung",
        (newest.period_end,),
        (DerivationInput(str(item.rule_id), newest.period_end, value, "pack"),),
        source="pack:%s" % (item.rule_id,), note=item.basis,
        status="fallback", **common)


def _rate_driver(spec, pack, history, series, series_name, authority,
                 engine=None):
    # type: (DriverSpec, ForecastPack, Sequence[ActualsPeriod], Callable[[ActualsPeriod], Optional[float]], str, str, Optional[EngineResolution]) -> Driver
    """Compound growth from the company's own history, or the macro
    anchor when there is no history to measure."""
    observed = []  # type: List[Tuple[str, float]]
    for period in history:
        value = series(period)
        # A compound rate needs a positive base at both ends. A zero or
        # negative starting value has no growth rate — it has a sign
        # change, and calling that a percentage is meaningless.
        if value is not None and value > 0.0:
            observed.append((period.period_end, value))

    if len(observed) >= 2:
        first_end, first_value = observed[0]
        last_end, last_value = observed[-1]
        years = _span_years(first_end, last_end)
        if years is not None and years >= _MIN_SPAN_YEARS:
            growth = (last_value / first_value) ** (1.0 / years) - 1.0
            intervals = len(observed) - 1
            if intervals >= 2:
                method = "cagr"
                label = "%s-year CAGR of %s" % (
                    _fmt_years(years), series_name)
            else:
                method = "yoy"
                label = "year-on-year change in %s" % (series_name,)
            note = ""
            if intervals == 1:
                note = ("One year-on-year change is the whole history this "
                        "book carries; a third period would make it a "
                        "trend rather than a single observation.")
            inputs = [
                DerivationInput(series_name, pe, value, authority)
                for pe, value in observed
            ]
            return _make(spec, pack, growth, method, label,
                         [pe for pe, _ in observed], inputs, note=note)

    # No measurable history. NOT zero.
    newest = history[-1]
    if engine is not None:
        return _growth_from_engine(spec, pack, history, newest, engine)
    anchor = pack.anchor(spec.macro_anchor)
    note = (
        "This workspace holds %d actuals period%s, so %s's own rate of "
        "change cannot be measured. Held at the %s (%s), a nominal "
        "continuation at constant real volume. Replace this the moment a "
        "second period is loaded."
        % (len(history), "" if len(history) == 1 else "s",
           "the company", anchor.label.lower(), anchor.source)
    )
    return _make(
        spec, pack, anchor.value, "pack_macro",
        "no company history — %s" % (anchor.label.lower(),),
        (newest.period_end,),
        (DerivationInput(anchor.key, anchor.stated_as_of, anchor.value,
                         "pack"),),
        source="pack:%s@%s" % (pack.macro_pack_id, pack.macro_pack_version),
        note=note, status="fallback")


def _fmt_years(years):
    # type: (float) -> str
    rounded = round(years, 1)
    if abs(rounded - round(rounded)) < 0.05:
        return "%d" % int(round(rounded))
    return ("%.1f" % rounded)


# ──────────────────────────────────────────────────────────────────────
# LEVEL drivers — a state, measurable from one period
# ──────────────────────────────────────────────────────────────────────

def _ratio_of(spec, pack, period, num_value, num_name, num_authority,
              den_value, den_name, den_authority, method_label,
              den_must_be_positive=True, note="",
              zero_numerator_refusal=None,
              zero_numerator_method="unattributed_numerator"):
    # type: (DriverSpec, ForecastPack, ActualsPeriod, Optional[float], str, str, Optional[float], str, str, str, bool, str, Optional[str], str) -> Driver
    """One level driver as a quotient of two facts this book carries.

    ``zero_numerator_refusal`` is for the one case the closed vocabulary
    cannot express with a number: a numerator of exactly zero that no
    account in the book stands behind. The caller decides that — it needs
    the chart of accounts, which this helper does not read — and passes
    the sentence saying so. The base checks run FIRST, so a book that has
    no usable denominator keeps the refusal it already had.
    """
    if num_value is None or den_value is None:
        missing = num_name if num_value is None else den_name
        return _absent(
            spec, "%s is not carried by this book, so the ratio cannot be "
                  "formed." % (missing,), period.period_end)
    if den_must_be_positive and den_value <= 0.0:
        # TC-10: this refusal QUOTES the denominator, so the denominator
        # is carried as an input rather than printed as prose. It read
        # `_absent` — which carries none — until the tax-rate work needed
        # a reader to be able to check the sentence.
        return _absent_with_inputs(
            spec, "unusable_denominator",
            "refused: the base is not a usable denominator",
            "%s is %s, which is not a usable base. A zero or negative "
            "denominator does not make the driver small — it makes it "
            "unmeasurable." % (den_name, _plain(den_value)),
            period.period_end,
            (DerivationInput(num_name, period.period_end, num_value,
                             num_authority),
             DerivationInput(den_name, period.period_end, den_value,
                             den_authority)))
    # UNATTRIBUTED != MEASURED. A zero the caller has established no
    # account stands behind is an absence that the assembly wrote as a
    # number; dividing it produces a rate that reads as a measurement of
    # the company and is a measurement of the mapping.
    if zero_numerator_refusal is not None and abs(num_value) < 1e-9:
        return _absent_with_inputs(
            spec, zero_numerator_method,
            "refused: the numerator is an unattributed zero",
            zero_numerator_refusal, period.period_end,
            (DerivationInput(num_name, period.period_end, num_value,
                             num_authority),
             DerivationInput(den_name, period.period_end, den_value,
                             den_authority)))
    value = num_value / den_value
    # A MEASURED ZERO IS NOT THE SAME AS AN ABSENT ONE, and it is also not
    # a safe thing to project silently for five years. Measured on the
    # committed retail book: income tax 0.00 on pretax profit of
    # 1,161,957.98 gives a genuine 0% effective rate — a loss carry-forward
    # or a micro-enterprise regime, either of which expires. The value
    # stays `derived`, because it IS what this book says; the note makes
    # sure nobody carries it forward without deciding to.
    if spec.unit == "rate" and abs(value) < 1e-12:
        zero_note = (
            "This book's %s is exactly zero against a usable base, so the "
            "rate is a measured 0%%, not an absent one. Projecting it "
            "unchanged assumes whatever produced it — a carried-forward "
            "loss, a special regime, a one-off — persists for every "
            "forecast year." % (num_name,)
        )
        note = ("%s %s" % (note, zero_note)).strip()
    return _make(
        spec, pack, value, "period_ratio", method_label,
        (period.period_end,),
        (DerivationInput(num_name, period.period_end, num_value,
                         num_authority),
         DerivationInput(den_name, period.period_end, den_value,
                         den_authority)),
        note=note)


def _plain(value):
    # type: (float) -> str
    return ("%.2f" % value).rstrip("0").rstrip(".")


# ──────────────────────────────────────────────────────────────────────
# the per-driver rules
# ──────────────────────────────────────────────────────────────────────

# plan/2 B4b: the leaf-based `_opex_fixed_share` (packs/forecast/drivers.yaml
# opex_nature_split over envelope.leaves) is retired — the engine's pool
# split (packs/forecast/cost_behaviour.yaml#nature over the anchor's line
# items) is the one authority (contract 4), read above through
# `pools.opex_fixed_share`.


def _depreciation_rate(spec, pack, period):
    # type: (DriverSpec, ForecastPack, ActualsPeriod) -> Driver
    charge = period.pl("depreciation")
    base = period.rows_sum(pack.depreciable_rows)
    return _ratio_of(
        spec, pack, period,
        charge, "depreciation_and_amortisation", "assembled_pl.depreciation",
        base, "gross_depreciable_assets",
        "canonical_bs.rows (%s)" % ", ".join(pack.depreciable_rows),
        "this book's own charge over its own gross depreciable base",
        note=("Land and assets under construction are excluded from the "
              "base: land is not depreciated and construction in progress "
              "is not yet in service."))


def _dividend_payout(spec, pack, period, engine):
    # type: (DriverSpec, ForecastPack, ActualsPeriod, EngineResolution) -> Driver
    """plan/2 B3 (contract 3.4, 4): the book rung is ABSENT on every book,
    with engine.forecast's own sentence — distributions are not measurable
    from closing balances. A 457 dividends-payable or 129 balance is what
    was not yet paid, or was allocated, at the close; it is not the year's
    payout, and the cash-flow statement's `dividends_paid` is an inference
    from typical Romanian payout ratios."""
    item = engine.get("dividend_payout_pct")
    reason = None
    if item is not None:
        for step in item.fallback_steps:
            if step["tier"] == "book":
                reason = step["reason"]
    if reason is None:
        from engine.forecast.levers_pack import dividend_book_rung_absent
        reason = dividend_book_rung_absent()
    return _absent(spec, reason[:1].upper() + reason[1:] + ".",
                   period.period_end)


def _fx_rate_move(spec, pack, period, history):
    # type: (DriverSpec, ForecastPack, ActualsPeriod, Sequence[ActualsPeriod]) -> Driver
    revenue = period.pl("revenue")
    cash_fx = period.row("cash_fx")
    gain = period.pl("fx_gain")
    loss = period.pl("fx_loss")
    exposure = 0.0
    for value in (cash_fx, gain, loss):
        if value is not None:
            exposure += abs(value)
    if revenue is None or revenue <= 0.0:
        return _absent(
            spec, "No revenue base against which to test FX materiality.",
            period.period_end)
    share = exposure / revenue
    #: Both numbers this refusal quotes are carried as inputs, so the
    #: sentence can be checked rather than believed: the measured share,
    #: and the gate it was compared against, which is pack data.
    gate_inputs = (
        DerivationInput("fx_exposure_share", period.period_end, share,
                        "canonical_bs.rows + assembled_pl"),
        DerivationInput("fx_materiality_gate", period.period_end,
                        pack.fx_materiality_of_revenue, "pack"),
    )
    if share < pack.fx_materiality_of_revenue:
        return _absent_with_inputs(
            spec, "below_materiality",
            "not modelled — FX exposure is below the pack's declared gate",
            "FX exposure is %.2f%% of revenue, below the %.2f%% at which "
            "this driver is modelled. Emitting it would invite a reader to "
            "weight a line that does not move this company's result."
            % (share * 100.0, pack.fx_materiality_of_revenue * 100.0),
            period.period_end, gate_inputs)
    # Material, but the MOVE itself is a market rate, not a company fact.
    anchor = pack.anchor(spec.macro_anchor) if spec.macro_anchor else None
    if anchor is None:
        return _absent_with_inputs(
            spec, "no_rate_history",
            "material, but this book carries no rate history to measure a "
            "move from",
            "FX exposure is material (%.2f%% of revenue) but this book "
            "carries no rate history to measure a move from; a person must "
            "supply the assumption." % (share * 100.0),
            period.period_end, gate_inputs)
    return _make(
        spec, pack, anchor.value, "pack_macro",
        "no rate history — %s" % (anchor.label.lower(),),
        (period.period_end,),
        (DerivationInput("fx_exposure_share", period.period_end, share,
                         "canonical_bs.rows + assembled_pl"),),
        source="pack:%s@%s" % (pack.macro_pack_id, pack.macro_pack_version),
        note="FX exposure is %.2f%% of revenue, above the modelling "
             "threshold." % (share * 100.0),
        status="fallback")


#: The engine states the tenor its own DSCR amortises debt over inside the
#: served note on that ratio ("LT debt amortized over 8y assumption"). It
#: is the ONLY place the number is published, so this driver reads it from
#: there rather than keeping a second copy: a pack constant that merely
#: agreed with it today would go on claiming to be the engine's tenor
#: after the engine changed its own.
_TENOR_IN_NOTE = re.compile(r"(\d+(?:\.\d+)?)\s*y(?:ears?|r)?\b",
                            re.IGNORECASE)


def _engine_dscr_tenor(period):
    # type: (ActualsPeriod) -> Optional[float]
    """The tenor the served DSCR note declares, or None if it declares
    none. Never a guess — an unreadable note yields None."""
    match = _TENOR_IN_NOTE.search(period.ratio_note("dscr_approx") or "")
    if match is None:
        return None
    try:
        return float(match.group(1))
    except ValueError:  # pragma: no cover - the regex cannot produce this
        return None


def _debt_repayment_years(spec, pack, period):
    # type: (DriverSpec, ForecastPack, ActualsPeriod) -> Driver
    engine_tenor = _engine_dscr_tenor(period)
    if engine_tenor is not None:
        return _make(
            spec, pack, engine_tenor, "engine_assumption",
            "the tenor the engine's own DSCR already amortises debt over",
            (period.period_end,),
            (DerivationInput("dscr_tenor_years", period.period_end,
                             engine_tenor,
                             "methodology.ratios.dscr_approx.note"),),
            source="envelope:methodology.ratios.dscr_approx",
            note=("A trial balance carries the debt balance but never its "
                  "maturity schedule. The tenor is READ from the engine's "
                  "own DSCR note rather than restated here, so two "
                  "surfaces of one report cannot disagree about it; it is "
                  "an assumption in both places, and a real amortisation "
                  "schedule should replace it."),
            status="fallback")
    if spec.fallback_value is None:
        return _absent(spec, "No tenor declared in the pack.",
                       period.period_end)
    return _make(
        spec, pack, spec.fallback_value, "pack_default",
        "the pack's declared tenor, because this book's DSCR note states "
        "none",
        (period.period_end,),
        (DerivationInput("assumed_tenor_years", period.period_end,
                         spec.fallback_value, "pack"),),
        source="pack:%s@%s" % (pack.pack_id, pack.pack_version),
        note=("A trial balance carries the debt balance but never its "
              "maturity schedule, and this book's served DSCR note does "
              "not state the tenor the engine used, so the pack's own "
              "declared tenor is used and labelled as the pack's rather "
              "than as the engine's."),
        status="fallback")


# ──────────────────────────────────────────────────────────────────────
# assembly
# ──────────────────────────────────────────────────────────────────────

def build_base_set(history, pack):
    # type: (Sequence[ActualsPeriod], ForecastPack) -> AssumptionSet
    """The BASE case: every driver defaulted from this company's actuals.

    `history` is oldest-first. Level drivers read the NEWEST period; rate
    drivers consume the whole run.
    """
    if not history:
        raise DriverError("a forecast needs at least one actuals period")
    newest = history[-1]
    engine = EngineResolution(newest)

    drivers = []  # type: List[Driver]
    for spec in pack.drivers:
        drivers.append(_build_one(spec, pack, history, newest, engine))
    return AssumptionSet("base", "Base", BASE_CASE_BASIS, drivers)


def _build_one(spec, pack, history, newest, engine):
    # type: (DriverSpec, ForecastPack, Sequence[ActualsPeriod], ActualsPeriod, EngineResolution) -> Driver
    key = spec.key

    if key == "revenue_growth":
        return _rate_driver(spec, pack, history,
                            lambda p: p.pl("revenue"), "revenue",
                            "assembled_pl.revenue", engine=engine)
    if key == "opex_growth":
        return _rate_driver(
            spec, pack, history,
            lambda p: p.pl("opex_excluding_cogs_and_da"),
            "operating cost excluding COGS and D&A",
            "assembled_pl.opex_excluding_cogs_and_da")
    if key == "opex_rate":
        return _from_engine(
            spec, pack, newest, engine, "pools.operating_cost_share",
            "the engine's own operating-cost pools, summed, over revenue")
    if key == "gross_margin":
        return _from_engine(
            spec, pack, newest, engine, "pools.cost_of_sales_share",
            "one minus the engine's own cost_of_sales pool base over revenue",
            complement=True)
    if key == "dso":
        return _from_engine(spec, pack, newest, engine, "dso_days",
                            "the engine's own days sales outstanding")
    if key == "dio":
        return _from_engine(spec, pack, newest, engine, "dio_cogs_days",
                            "the engine's own inventory days, split by stock "
                            "type on the period-end balance")
    if key == "dpo":
        return _from_engine(spec, pack, newest, engine, "dpo_cogs_days",
                            "the engine's own trade payables in days of "
                            "cost of sales (not the ratio table's DPO)")
    if key == "capex_rate":
        return _from_engine(spec, pack, newest, engine,
                            "capex_pct_of_revenue",
                            "the engine's own maintenance-capital rate")
    if key == "opex_fixed_share":
        return _from_engine(
            spec, pack, newest, engine, "pools.opex_fixed_share",
            "the engine's own amount-weighted fixed share of its "
            "operating-cost pools")
    if key == "personnel_rate":
        return _ratio_of(
            spec, pack, newest,
            newest.aggregate("personnel_total"), "personnel_total",
            "envelope.aggregates.personnel_total",
            newest.pl("revenue"), "revenue", "assembled_pl.revenue",
            "this book's own personnel cost over its own revenue")
    if key == "headcount":
        return _absent(
            spec,
            "A trial balance carries the personnel COST but never an "
            "employee count. Supply it and the average cost per employee "
            "becomes computable; it is not inferred by dividing by a "
            "guessed wage.", newest.period_end)
    if key == "avg_personnel_cost":
        return _absent(
            spec,
            "Headcount is absent, so this cannot be formed. It is one "
            "division away the moment a person supplies the count.",
            newest.period_end)
    if key == "depreciation_share_of_gross_depreciable_base":
        return _depreciation_rate(spec, pack, newest)
    if key == "depreciation_rate":
        return _from_engine(spec, pack, newest, engine, "depreciation_rate",
                            "the engine's own depreciation rate on closing "
                            "net book value")
    if key == "new_debt":
        return _absent(
            spec,
            "Nothing in a closing trial balance says what the company "
            "intends to draw next year. Defaulting it from last year's "
            "drawdowns would present a financing plan as a measurement.",
            newest.period_end)
    if key == "debt_repayment_years":
        return _debt_repayment_years(spec, pack, newest)
    if key == "interest_rate":
        return _from_engine(spec, pack, newest, engine, "interest_rate_debt",
                            "the engine's own borrowing rate")
    if key == "tax_rate":
        # plan/2 contract 4, 3.4, R16: ONE derivation. The book rung is the
        # engine's existing effective-rate rule (positive pre-tax result and
        # a reconstruction that reaches account 121 with nothing
        # unexplained), else the jurisdiction's packed statutory rate, else
        # absent; this package reads that resolution rather than holding a
        # second rule of its own.
        return _from_engine(spec, pack, newest, engine, "tax_rate",
                            "the engine's own effective-rate rule, else the "
                            "jurisdiction's statutory rate")
    if key == "dividend_payout":
        return _dividend_payout(spec, pack, newest, engine)
    if key == "fx_rate_move":
        return _fx_rate_move(spec, pack, newest, history)

    raise DriverError(
        "pack declares driver %r but no rule builds it. A driver with no "
        "rule would ship as a silent absence." % (key,))
