"""S-LIQUIDITY — cash against what is already owed, and against what the
period is burning.

  liquidity_cash_tight   cash cover of current liabilities, and the
                         DAYS OF OPERATING COST that cover buys
  fcf_negative           free cash flow below zero, split by whether the
                         capex went into a development asset or into
                         keeping the lights on
  fx_exposure            how much of the cash balance is denominated in
                         a currency the books do not report in

DAYS, NOT A GUESSED YEAR
Every day-count here divides by ``supplementary.periodDays``. When the
period does not declare its length the day-based impact is not computed
— a quarter narrated as a year would treble the answer, and a day count
built on an assumed denominator is a fabricated number wearing a unit.

WHY THE BURN BRANCH AND THE DEVELOPMENT BRANCH GET DIFFERENT IMPACTS
They are different claims. "Free cash flow is negative because a
building is being paid for" is answered by showing the same margin with
the construction spend removed. "Free cash flow is negative because the
business does not fund itself" is answered by showing what the cash
ratio looks like after one more period of the same. Using one impact for
both would make the finding read the same either way, which is the
generic sentence this package exists to eliminate.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from .. import _finding as F
from . import _base


# ── liquidity_cash_tight ─────────────────────────────────────────────────

_CASH_SUBJECT = (
    F.Account("5121", "Conturi la bănci în lei", "BS"),
    F.Account("5124", "Conturi la bănci în valută", "BS"),
    F.Account("531", "Casa", "BS"),
)


def detect_cash_tight(ctx: _base.Ctx) -> _base.Outcome:
    did = "liquidity_cash_tight"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    cash = r.view("bs", "cash")
    current_liabilities = r.view("bs", "total_current_liabilities")
    spec = ctx.threshold_spec(did, "cash_ratio_low")
    if cash is None or current_liabilities is None:
        return _base.quiet(ctx.skipped(
            did, "the period carries no cash line or no current-liability "
                 "total"))
    observed = _base.share(r, cash, current_liabilities, "cash", "cur_liab")
    if observed is None:
        return _base.quiet(ctx.skipped(
            did, "current liabilities are nil, so a cash ratio has no "
                 "denominator"))
    if observed >= spec.value:
        return _base.quiet(ctx.not_fired(
            did, spec, "<", observed, F.UNIT_RATIO,
            note="cash cover sits at or above the floor this profile is graded "
                 "on"))

    # The consequence is stated in DAYS, because that is the unit a
    # treasurer acts in. The cash operating cost excludes depreciation —
    # a non-cash charge does not consume a day of runway.
    #
    # Two things can take the day count away: a period that does not
    # declare its length, and a gap smaller than one whole day. Neither
    # is a reason to drop the finding, so both fall back to the same
    # consequence expressed as a SHARE of the period's cash cost, which
    # needs no day count and prints to a decimal place.
    days = r.period_days()
    operating_expense = r.view("pl", "total_operating_expense")
    depreciation = r.view("pl", "depreciation")
    cash_at_floor = current_liabilities * float(spec.value)
    impact = None
    period_cash_cost = None
    if operating_expense is not None and depreciation is not None:
        period_cash_cost = operating_expense - depreciation
    if period_cash_cost:
        daily_cash_cost = _base.per_day(period_cash_cost, days)
        if daily_cash_cost:
            impact = _base.whole_days_impact(
                "days_of_operating_cost_covered_by_cash",
                "Days of operating cost the cash balance covers, as held versus "
                "at the floor this profile is graded on",
                r,
                held_days=_base.quotient(r.q(cash, "cash"),
                                         r.q(daily_cash_cost, "daily_cash_cost")),
                target_days=_base.quotient(r.q(cash_at_floor, "cash_at_floor"),
                                           r.q(daily_cash_cost,
                                               "daily_cash_cost")),
                unit_cost=daily_cash_cost,
                unit_cost_name="daily_cash_operating_cost")
        if impact is None:
            impact = _base.ratio_impact_or_none(
                "cash_share_of_period_operating_cost",
                "Share of the period's cash operating cost the cash balance "
                "covers, as held versus at the floor this profile is graded on",
                numerator=r.q(cash, "cash"),
                denominator=r.q(period_cash_cost,
                                "period_cash_operating_cost"),
                adjusted_numerator=r.q(cash_at_floor, "cash_at_profile_floor"),
                unit=F.UNIT_PERCENT)

    bag = (_base.Bag()
           .money("cash", cash, "cash and bank balances")
           .money("cur_liab", current_liabilities, "current liabilities")
           .ratio("cash_ratio", observed, "cash cover of current liabilities"))

    return _base.found(_base.build_finding(
        ctx, did, "high", _CASH_SUBJECT,
        scope="Cash cover on 5121 / 5124 / 531 against current liabilities",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="profile_threshold",
            description="cash is measured against the company's own current "
                        "liabilities for the same period, against the cash "
                        "floor this structural profile is graded on",
            basis_value=current_liabilities, basis_unit=F.UNIT_MONEY),
        threshold_element=_base.threshold(spec, "<", observed, F.UNIT_RATIO),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Obtain a committed overdraft sized to one month of "
                           "operating cost",
                artefact="signed committed facility term sheet, with the "
                         "drawdown conditions",
                provider="the relationship bank",
                horizon="within this quarter"),
            F.ActionStep(
                imperative="Negotiate longer settlement terms on the largest "
                           "401 supplier balances",
                artefact="revised payment calendar for the ten largest supplier "
                         "accounts",
                provider="the procurement lead"),
        ),
        extra_caveats=applicability.caveats))


# ── fcf_negative ─────────────────────────────────────────────────────────

_DEVELOPMENT_SUBJECT = (
    F.Account("231", "Imobilizări corporale în curs de execuție", "BS"),
    F.Account("5121", "Conturi la bănci în lei", "BS"),
)
_BURN_SUBJECT = (
    F.Account("5121", "Conturi la bănci în lei", "BS"),
    F.Account("5124", "Conturi la bănci în valută", "BS"),
)


def detect_fcf_negative(ctx: _base.Ctx) -> _base.Outcome:
    did = "fcf_negative"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    free_cash_flow = r.view("cf", "free_cash_flow")
    operating = r.view("cf", "cash_from_operating")
    capex = r.view("cf", "capex_real")
    construction = r.view("cf", "capitalized_construction")
    spec = ctx.threshold_spec(did, "development_capex_share")
    if free_cash_flow is None or capex is None:
        return _base.quiet(ctx.skipped(
            did, "the cash-flow view carries no free-cash-flow or no capex "
                 "line"))
    if free_cash_flow >= 0:
        return _base.quiet(ctx.not_fired(
            did, spec, ">", None, F.UNIT_PERCENT,
            note="free cash flow is not negative for this period, so the "
                 "development-versus-burn split was never formed"))
    if capex >= 0:
        return _base.quiet(ctx.skipped(
            did, "free cash flow is negative but no capex outflow is recorded, "
                 "so the development-versus-burn split this rule turns on "
                 "cannot be computed"))
    if construction is None or operating is None:
        return _base.quiet(ctx.skipped(
            did, "the construction-in-progress or operating cash-flow line is "
                 "absent, so the split cannot be computed"))

    observed = _base.share(r, abs(construction), abs(capex),
                           "capitalized_construction", "capex_real")
    if observed is None:
        return _base.quiet(ctx.skipped(
            did, "capex is nil, so the development share has no denominator"))

    revenue = r.view("pl", "revenue")
    cash = r.view("bs", "cash")
    current_liabilities = r.view("bs", "total_current_liabilities")
    development = observed > float(spec.value)

    if development:
        comparator, severity, subject = ">", "medium", _DEVELOPMENT_SUBJECT
        scope = "Free cash flow against development capex on 231"
        impact = _base.ratio_impact_or_none(
            "fcf_share_of_revenue_ex_development",
            "Free cash flow as a share of turnover, as reported versus with the "
            "231 development spend excluded",
            numerator=r.q(free_cash_flow, "free_cash_flow"),
            denominator=(None if revenue is None else r.q(revenue, "revenue")),
            adjusted_numerator=r.q(free_cash_flow + abs(construction),
                                   "free_cash_flow_ex_development"),
            unit=F.UNIT_PERCENT)
        steps = (
            F.ActionStep(
                imperative="Model the stabilised free cash flow for the first "
                           "full period after account 231 delivers into service",
                artefact="commissioning schedule with the first full-year rent "
                         "or output it carries",
                provider="the project manager",
                horizon="before the next facility review"),
            F.ActionStep(
                imperative="Confirm the facility tenor outlasts the construction "
                           "period",
                artefact="facility maturity schedule set against the "
                         "commissioning date",
                provider="the treasury team"),
        )
    else:
        comparator, severity, subject = "<=", "high", _BURN_SUBJECT
        scope = "Free cash flow against the cash balance"
        impact = _base.ratio_impact_or_none(
            "cash_ratio_after_one_more_period",
            "Cash cover of current liabilities, today versus after one more "
            "period at this burn",
            numerator=(None if cash is None else r.q(cash, "cash")),
            denominator=(None if current_liabilities is None
                         else r.q(current_liabilities, "cur_liab")),
            adjusted_numerator=(None if cash is None
                                else r.q(cash + free_cash_flow,
                                         "cash_after_one_more_period")),
            unit=F.UNIT_RATIO)
        steps = (
            F.ActionStep(
                imperative="Quantify the monthly cash burn and the date the cash "
                           "balance reaches zero",
                artefact="13-week rolling cash forecast with a stated zero date",
                provider="the treasury team",
                horizon="this week"),
            F.ActionStep(
                imperative="Cap discretionary capex until operating cash flow "
                           "covers it",
                artefact="capex approval gate with a named approver and a "
                         "monetary limit",
                provider="the board"),
        )

    bag = (_base.Bag()
           .money("free_cash_flow", free_cash_flow, "free cash flow")
           .money("cash_from_operating", operating, "cash from operations")
           .money("capex_real", capex, "capex outflow")
           .money("capitalized_construction", construction,
                  "of which into construction in progress on 231")
           .percent("development_capex_share", observed,
                    "development share of the capex outflow"))

    return _base.found(_base.build_finding(
        ctx, did, severity, subject, scope=scope, bag=bag,
        comparison=F.ComparisonBasis(
            kind="self_total",
            description="the development share is the company's own account 231 "
                        "spend measured against its own total capex outflow for "
                        "the same period",
            basis_value=abs(capex), basis_unit=F.UNIT_MONEY),
        threshold_element=_base.threshold(spec, comparator, observed,
                                          F.UNIT_PERCENT),
        impact=impact,
        steps=steps,
        extra_caveats=applicability.caveats))


# ── fx_exposure ──────────────────────────────────────────────────────────

_FX_SUBJECT = (
    F.Account("5124", "Conturi la bănci în valută", "BS"),
    F.Account("765", "Venituri din diferențe de curs valutar", "PL"),
    F.Account("665", "Cheltuieli din diferențe de curs valutar", "PL"),
)


def detect_fx_exposure(ctx: _base.Ctx) -> _base.Outcome:
    """Foreign-currency cash, sized by the currency result it already
    produced.

    The impact deliberately uses THIS period's own realised FX result
    rather than an invented rate move: a hypothetical shock would be a
    parameter this module made up, while the recorded 765/665 pair is
    the company's own evidence of what a year of currency movement does
    to its result.
    """
    did = "fx_exposure"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    fx_cash = r.value("cash_fx_component", "cash_fx")
    cash = r.view("bs", "cash")
    spec = ctx.threshold_spec(did, "fx_cash_share_high")
    if fx_cash is None or cash is None:
        return _base.quiet(ctx.skipped(
            did, "the period carries no foreign-currency cash component or no "
                 "cash total"))
    observed = _base.share(r, abs(fx_cash), cash, "fx_cash", "total_cash")
    if observed is None:
        return _base.quiet(ctx.skipped(
            did, "the cash balance is nil, so an FX share has no denominator"))
    if observed <= spec.value:
        return _base.quiet(ctx.not_fired(
            did, spec, ">", observed, F.UNIT_PERCENT,
            note="the foreign-currency cash position is a minority of the cash "
                 "balance"))

    fx_gain = r.view("pl", "fx_gain")
    fx_loss = r.view("pl", "fx_loss")
    net_income = r.view("pl", "net_income_statutory")
    revenue = r.view("pl", "revenue")
    impact = None
    if None not in (fx_gain, fx_loss, net_income, revenue):
        net_fx = fx_gain - fx_loss
        impact = _base.ratio_impact_or_none(
            "net_margin_ex_currency_result",
            "Net margin, as reported versus excluding the recorded currency "
            "result",
            numerator=r.q(net_income, "net_income"),
            denominator=r.q(revenue, "revenue"),
            adjusted_numerator=r.q(net_income - net_fx,
                                   "net_income_ex_currency_result"),
            unit=F.UNIT_PERCENT)

    bag = (_base.Bag()
           .money("fx_cash", fx_cash, "cash held in foreign currency on 5124")
           .money("total_cash", cash, "total cash and bank balances")
           .percent("fx_cash_pct", observed,
                    "foreign-currency share of the cash balance"))

    return _base.found(_base.build_finding(
        ctx, did, "medium", _FX_SUBJECT,
        scope="Foreign-currency cash on 5124 inside the cash balance",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="self_total",
            description="the foreign-currency component is measured against the "
                        "company's own total cash for the same period",
            basis_value=cash, basis_unit=F.UNIT_MONEY),
        threshold_element=_base.threshold(spec, ">", observed, F.UNIT_PERCENT),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Match the foreign-currency cash against "
                           "foreign-currency payables, currency by currency",
                artefact="net exposure schedule per currency at the "
                         "balance-sheet date",
                provider="the treasury team"),
            F.ActionStep(
                imperative="Lock a forward contract over the uncovered net "
                           "position",
                artefact="forward contract confirmation, with its maturity set "
                         "against the settlement dates",
                provider="the relationship bank"),
        ),
        extra_caveats=applicability.caveats))


DETECTORS = {
    "liquidity_cash_tight": detect_cash_tight,
    "fcf_negative": detect_fcf_negative,
    "fx_exposure": detect_fx_exposure,
}
