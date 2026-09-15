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

def _opex_fixed_share(spec, pack, period):
    # type: (DriverSpec, ForecastPack, ActualsPeriod) -> Driver
    fixed, fixed_found = period.leaves_sum(pack.opex_fixed)
    variable, variable_found = period.leaves_sum(pack.opex_variable)
    if fixed is None and variable is None:
        return _absent(
            spec, "This book carries none of the operating-cost leaves the "
                  "nature split is defined over.", period.period_end)
    fixed_value = 0.0 if fixed is None else fixed
    variable_value = 0.0 if variable is None else variable
    base = fixed_value + variable_value
    if base <= 0.0:
        return _absent(
            spec, "The classified operating-cost base is not positive.",
            period.period_end)
    inputs = [
        DerivationInput("fixed_by_nature", period.period_end, fixed_value,
                        "envelope.leaves (%s)" % ", ".join(fixed_found)),
        DerivationInput("variable_by_nature", period.period_end,
                        variable_value,
                        "envelope.leaves (%s)" % ", ".join(variable_found)),
    ]
    note = (
        "Split by expense NATURE from this book's own leaves, not by "
        "regression: a regression split needs three or more periods. The "
        "classification is data in packs/forecast/drivers.yaml, so it can "
        "be argued with."
    )
    return _make(spec, pack, fixed_value / base, "nature_split",
                 "expense-nature split of this book's operating costs",
                 (period.period_end,), inputs, note=note)


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


#: The Romanian chart of accounts carries the profit-tax charge in class
#: 69 (691 impozit pe profit, 698 impozitul pe venit). `assembled_pl`
#: reports `income_tax` as the SUM of those accounts, so a book that
#: carries none of them reports 0.00 — the sum of an empty set, written
#: as a number. Measured on the four committed books:
#:
#:     agras       691 = 1,471,550.00  -> income_tax 1,471,550.00
#:     carniprod   691 =   287,686.00  -> income_tax   287,686.00
#:     realestate  no class-69 account -> income_tax         0.00
#:     retail      no class-69 account -> income_tax         0.00
#:
#: The zero on the last two is the absence of a charge account, not the
#: presence of a nil charge.
_INCOME_TAX_PREFIXES = ("69",)


def _tax_rate(spec, pack, period):
    # type: (DriverSpec, ForecastPack, ActualsPeriod) -> Driver
    """The effective rate, measured only when BOTH conditions hold.

    TWO independent things have to be true before `income_tax / pretax`
    is a statement about the company, and each was found by a different
    lane looking at the same books:

    1. **The charge is attributed.** A class-69 account has to stand
       behind it. Otherwise `assembled_pl.income_tax` is 0.00 because
       nothing was mapped, and the rate describes the mapping.
    2. **The build-up it sits in reproduces the profit the company
       FILED.** The book states its profit twice — as this build-up
       (`pretax` less `income_tax`) and as the closing balance of account
       121 — and the rate is a claim about the second. `pretax − tax`
       has to BE the filed figure, to the cent.

    Condition 2 is `engine.forecast.assumptions`' ruling, arrived at
    independently in the same session, and it is the stronger of the two;
    condition 1 is what stops a nil charge NOTHING stands behind from
    reading as "a company charged no profit tax" on a book that happens
    to tie. Both live here because this package OWNS the concept (see
    `authority.CONCEPTS`), and the model states the statutory rate under
    its own name whenever this refuses.

    WHY THE FILED FIGURE IS READ FROM THE 121 CROSS-CHECK AND NOT FROM
    `net_income_unexplained_vs_121`
    -----------------------------------------------------------------
    That field looks like the measurement this condition wants and is
    not one. The Romanian assembly
    (`country_packs/ro_romania/chart_of_accounts.py`) replaces the
    reconstruction with the filed figure only when the two differ by more
    than `max(|account 121|, 100_000) * 0.05`, and sets the
    "unexplained" field to a literal `0.0` in every other case —
    including the case where nothing was compared at all. Measured
    through the real assembly:

        filed 121   reconstruction   miss                 field says
        20,000.00       24,500.00     4,500.00  (22.5%)   0.00
        (no 121 row)    24,500.00     not measurable      0.00

    Both of those read as "the build-up ties" and both took a `derived
    18.3333%` rate into a five-year plan. The floor is what makes it
    unbounded as a share of the profit: it tolerates 5,000.00 RON of
    unattributed result on ANY book smaller than 100,000.00, and this
    platform serves small books.

    `canonical_bs.invariants.p121_cross_check.p121` is the account's own
    closing balance, captured before that comparison and published
    whether or not it fired — and `None`, not zero, when no account-121
    row survived extraction.

    WHAT IS ALLOWED TO BRIDGE, AND WHY THE CUTOFF IS ZERO
    -----------------------------------------------------
    Exactly what the assembly's OWN bridge allows, so that this and
    `engine.forecast.history.unexplained_vs_filed` stay one concept
    rather than two conditions with one name. That bridge is
    `net_income_statutory = (pretax − tax) + capitalized_own_work`, so
    capitalised own work (722) closes the distance and nothing else does.
    The remainder is what neither statement can attribute, and it is the
    quantity `net_income_unexplained_vs_121` reports — when it reports
    anything at all.

    The inventory variation (711) is NOT allowed to bridge, and the
    committed realestate book is why: the whole 29,589,814.24 of its
    distance is inventory variation, and admitting it would tie the
    build-up while leaving this rate divided by −30,391,418.38 when the
    charge was assessed on −801,604.14. It is named in the refusal where
    it is present, because a reader is owed the size of the thing that is
    NOT closing the gap, but it does not close it.

    The cutoff is zero, and that is an identity rather than a materiality
    judgement: both sides are the engine's own cent-rounded figures for
    the same legal quantity, so a residue is a real unattributed
    difference and not measurement noise.

    Measured on the four committed books, all four refuse:

        agras       filed 7,533,676.02 vs build-up 14,106,102.03
        carniprod   filed 1,435,533.59 vs build-up  5,843,449.04
        retail      filed 3,205,212.62 vs build-up  1,161,957.98
        realestate  pre-tax result < 0 + no class-69 (the deeper refusal)
    """
    tax = period.pl("income_tax")
    pretax = period.pl("pretax")
    filed = period.filed_net_income_121()
    capitalized = period.pl("capitalized_own_work_memo")
    inventory_variation = period.pl("inventory_variation_memo")

    def _inputs():
        rows = [DerivationInput("income_tax", period.period_end, tax,
                                "assembled_pl.income_tax"),
                DerivationInput("pretax_profit", period.period_end, pretax,
                                "assembled_pl.pretax")]
        if filed is not None:
            rows.append(DerivationInput(
                "account_121_closing", period.period_end, filed,
                "canonical_bs.invariants.p121_cross_check.p121"))
        # The two components the assembly NAMES between its own
        # reconstruction and account 121. Carried only when they are
        # actually there, so the refusal can say how much of the distance
        # has a name — and, because each is a credit the denominator does
        # not carry, why naming it does not rescue the rate.
        if capitalized:
            rows.append(DerivationInput(
                "capitalized_own_work", period.period_end, capitalized,
                "assembled_pl.capitalized_own_work_memo"))
        if inventory_variation:
            rows.append(DerivationInput(
                "inventory_variation", period.period_end, inventory_variation,
                "assembled_pl.inventory_variation_memo"))
        return tuple(rows)

    # The base check runs FIRST and unchanged: a book with no usable
    # pre-tax result cannot form the ratio at all, which is a deeper
    # refusal than either condition below and keeps its own sentence.
    if tax is None or pretax is None:
        return _ratio_of(
            spec, pack, period,
            tax, "income_tax", "assembled_pl.income_tax",
            pretax, "pretax_profit", "assembled_pl.pretax",
            "the EFFECTIVE rate this book paid")
    if pretax <= 0.0:
        return _ratio_of(
            spec, pack, period,
            tax, "income_tax", "assembled_pl.income_tax",
            pretax, "pretax_profit", "assembled_pl.pretax",
            "the EFFECTIVE rate this book paid")

    reasons = []
    #: EXISTENCE only, never the amount. `accounts_with_prefix` warns in
    #: its own docstring that a prefix-derived FIGURE disagrees with the
    #: canonical rows (7,536,754.90 against 7,692,202.74 on its worked
    #: example); the charge itself keeps coming from
    #: `assembled_pl.income_tax`. All this asks is whether an account
    #: that could hold one is in the book at all.
    if abs(tax) < 1e-9 and not period.accounts_with_prefix(
            _INCOME_TAX_PREFIXES):
        reasons.append(
            "This book carries no class-69 account (691 impozit pe profit "
            "/ 698), so the %s income_tax its assembled P&L reports is the "
            "sum of an empty set, not a charge measured at nil."
            % (_plain(tax),))
    if filed is None:
        reasons.append(
            "No account-121 closing balance survived extraction of this "
            "book, so the reconstructed result (pre-tax %s less tax %s) "
            "cannot be checked against the profit the company filed. An "
            "unchecked build-up is not a build-up that ties."
            % (_plain(pretax), _plain(tax)))
    else:
        # The assembly's own bridge, in its own terms: statutory net
        # income is the build-up plus capitalised own work, and what is
        # left over is what nothing on the statement accounts for.
        reconstructed = round(pretax - tax + (capitalized or 0.0), 2)
        distance = round(filed - reconstructed, 2)
        if distance != 0.0:
            reasons.append(
                "This book's reconstructed result of %s (pre-tax %s less "
                "tax %s%s) is %s short of the %s it filed in account 121, "
                "and nothing on the statement accounts for the difference, "
                "so a rate divided out of two figures inside that build-up "
                "would be measured across the distance rather than from "
                "the company."
                % (_plain(reconstructed), _plain(pretax), _plain(tax),
                   ("" if not capitalized
                    else ", plus capitalised own work of %s"
                    % (_plain(capitalized),)),
                   _plain(distance), _plain(filed)))
            if inventory_variation:
                # NAMED, and deliberately NOT admitted as a bridge: it is
                # outside the assembly's own reconciliation to statutory
                # net income, and admitting it would tie the build-up
                # while leaving the denominator the wrong base — measured
                # on the realestate book, −30,391,418.38 against a charge
                # assessed on −801,604.14.
                reasons.append(
                    "The statement separately records an inventory "
                    "variation of %s, which is not part of its "
                    "reconciliation to the filed figure and is not in the "
                    "%s this rate would divide by, so it does not close "
                    "the distance."
                    % (_plain(inventory_variation), _plain(pretax)))
    if reasons:
        reasons.append(
            "A consumer that must hold a rate states the statutory one "
            "under its own name; this package does not restate it as a "
            "measurement.")
        return _absent_with_inputs(
            spec, "unattributed_or_unreconciled_charge",
            "refused: the charge is not attributable, or the build-up it "
            "sits in does not reproduce the profit filed in account 121",
            " ".join(reasons), period.period_end, _inputs())

    return _ratio_of(
        spec, pack, period,
        tax, "income_tax", "assembled_pl.income_tax",
        pretax, "pretax_profit", "assembled_pl.pretax",
        "the EFFECTIVE rate this book paid",
        note=("The effective rate, not the statutory headline. The two "
              "differ for any company with non-deductibles, a sponsorship "
              "credit or a micro-enterprise history, and the effective rate "
              "is the one that projects. Measured here because a class-69 "
              "account stands behind the charge AND this book's pre-tax "
              "result less that charge IS the profit it filed in account "
              "121, to the cent."))




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
            spec, pack, newest, engine, "opex_pct_of_revenue",
            "the engine's own operating cost excluding cost of sales and "
            "depreciation, over revenue")
    if key == "gross_margin":
        return _from_engine(
            spec, pack, newest, engine, "cogs_pct_of_revenue",
            "one minus the engine's own cost-of-sales share of revenue",
            complement=True)
    if key == "dso":
        return _from_engine(spec, pack, newest, engine, "dso_days",
                            "the engine's own days sales outstanding")
    if key == "dio":
        return _from_engine(spec, pack, newest, engine, "dio_cogs_days",
                            "the engine's own days inventory outstanding, "
                            "in days of cost of sales")
    if key == "dpo":
        return _from_engine(spec, pack, newest, engine, "dpo_cogs_days",
                            "the engine's own days payables outstanding, "
                            "in days of cost of sales")
    if key == "capex_rate":
        return _from_engine(spec, pack, newest, engine,
                            "capex_pct_of_revenue",
                            "the engine's own maintenance-capital rate")
    if key == "opex_fixed_share":
        return _opex_fixed_share(spec, pack, newest)
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
        return _tax_rate(spec, pack, newest)
    if key == "dividend_payout":
        return _dividend_payout(spec, pack, newest, engine)
    if key == "fx_rate_move":
        return _fx_rate_move(spec, pack, newest, history)

    raise DriverError(
        "pack declares driver %r but no rule builds it. A driver with no "
        "rule would ship as a silent absence." % (key,))
