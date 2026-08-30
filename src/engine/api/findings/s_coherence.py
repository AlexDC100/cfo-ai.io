"""S-COHERENCE — does this period's arithmetic hold together?

Four checks that ask whether the statements can be believed BEFORE any
ratio drawn from them is quoted:

  data_quality_bs_imbalance             the two sides of the balance
                                        sheet disagree
  data_quality_pnl_zero                 a material asset base reporting
                                        no turnover at all
  earnings_quality_capitalized_own_work statutory EBITDA lifted by
                                        account 722 with no cash behind
                                        it
  valuation_ebitda_non_positive         earnings multiples have no
                                        denominator

WHAT THE BRIEF ASKED FOR THAT IS NOT HERE, AND WHY
The single-period coherence set was specified as "stock vs COGS
plausibility, VAT vs revenue, payroll vs employee scale, depreciation vs
fixed assets, provisions adequacy". Three of those five have no
canonical input in this engine today:

  · VAT — no ``ar_tax_recoverable`` / ``ap_tax`` split by VAT rate
    reaches the assembled views, so a VAT-to-revenue plausibility test
    would have to guess the rate. Guessing it is worse than not running.
  · payroll vs employee scale — the ``employee_scale`` signal resolves
    to UNKNOWN on every current period (no canonical payroll field), and
    headcount is not carried at all.
  · depreciation vs fixed assets — the charge is available
    (``assembled_pl.depreciation``) but GROSS PP&E and accumulated
    depreciation are not, so the ratio that would test it cannot be
    formed. The same gap is what makes ``asset_maturity`` refuse in
    ``s_structure``.

Stock-vs-COGS plausibility IS available and is covered from the cost
side by ``input_cost_exposure`` in ``s_structure``; provisions adequacy
is covered by ``receivables_allowance_quality`` in ``s_aging``. The
three above are recorded as checks that did not run, with the missing
field named, rather than being approximated into a number. ABSENT !=
ZERO applies to a whole rule exactly as it applies to a figure.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from typing import Optional

from .. import _finding as F
from . import _base


# ── data_quality_bs_imbalance ────────────────────────────────────────────

_BS_BANDS = (
    _base.Band("critical_share", "critical"),
    _base.Band("warn_share", "high"),
)

#: The balance-sheet control total spans the whole trial balance, so its
#: SUBJECT is the class range rather than one account. Naming a single
#: account would be a fabrication: the drift is a residual, and nothing
#: in the assembled views says which ledger line carries it.
_BS_SUBJECT = (
    F.Account("1-5", "conturi de bilanț, clasele 1–5", "BS"),
    F.Account("4", "conturi de terți (clasa 4, cea cu solduri mixte)", "BS"),
)


def detect_bs_imbalance(ctx: _base.Ctx) -> _base.Outcome:
    did = "data_quality_bs_imbalance"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    total_assets = r.view("bs", "total_assets")
    total_liabilities = r.view("bs", "total_liabilities")
    total_equity = r.view("bs", "total_equity")
    if total_assets is None or total_liabilities is None or total_equity is None:
        return _base.quiet(ctx.skipped(
            did, "the assembled balance sheet carries no total_assets / "
                 "total_liabilities / total_equity triple for this period"))
    if total_assets <= 0:
        return _base.quiet(ctx.skipped(
            did, "total assets are not positive, so a drift share has no "
                 "denominator"))

    stated_delta = r.view("bs", "bs_balance_delta")
    drift = (abs(stated_delta) if stated_delta is not None
             else abs(total_assets - total_liabilities - total_equity))
    drift_share = _base.share(r, drift, total_assets, "drift", "total_assets")
    if drift_share is None:
        return _base.quiet(ctx.skipped(did, "the drift share is undefined"))

    hit = _base.fired_band(ctx.profile, did, _BS_BANDS, drift_share, ">")
    if hit is None:
        spec = ctx.threshold_spec(did, "warn_share")
        return _base.quiet(ctx.not_fired(
            did, spec, ">", drift_share, F.UNIT_PERCENT,
            note="the two sides of the balance sheet agree within tolerance"))
    band, spec = hit

    bag = (_base.Bag()
           .money("drift", drift, "unexplained difference between the two sides")
           .money("total_assets", total_assets, "total assets")
           .money("total_liabilities", total_liabilities, "total liabilities")
           .money("total_equity", total_equity, "total equity")
           .percent("drift_share", drift_share, "drift as a share of total assets"))

    impact = _base.ratio_impact_or_none(
        "equity_ratio_by_side",
        "Equity ratio, measured on the asset side versus on the funding side",
        numerator=r.q(total_equity, "total_equity"),
        denominator=r.q(total_assets, "total_assets"),
        adjusted_denominator=r.q(total_liabilities + total_equity,
                                 "equity_plus_liabilities"),
        unit=F.UNIT_PERCENT)

    return _base.found(_base.build_finding(
        ctx, did, band.severity, _BS_SUBJECT,
        scope="Balance-sheet control total across classes 1-5",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="self_total",
            description="the drift is measured against the company's own total "
                        "assets for the same period",
            basis_value=total_assets, basis_unit=F.UNIT_MONEY),
        threshold_element=_base.threshold(spec, ">", drift_share, F.UNIT_PERCENT),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Trace the difference to the class control totals of "
                           "the balanță de verificare",
                artefact="class-by-class debit and credit control totals for "
                         "classes 1-5",
                provider="the accounting team",
                horizon="before this period is used for a covenant or valuation "
                        "figure"),
            F.ActionStep(
                imperative="Split the class 4 accounts that carry a debit and a "
                           "credit sub-balance at the same time",
                artefact="sub-account level debit/credit split for 44x, 451 and 455",
                provider="the financial controller"),
        ),
        extra_caveats=applicability.caveats))


# ── data_quality_pnl_zero ────────────────────────────────────────────────

_PNL_ZERO_SUBJECT = (
    F.Account("701", "Venituri din vânzarea produselor finite", "PL"),
    F.Account("704", "Venituri din servicii prestate", "PL"),
    F.Account("707", "Venituri din vânzarea mărfurilor", "PL"),
)


def detect_pnl_zero(ctx: _base.Ctx) -> _base.Outcome:
    did = "data_quality_pnl_zero"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    revenue = r.view("pl", "revenue")
    total_assets = r.view("bs", "total_assets")
    capitalised = r.view("pl", "capitalized_own_work_memo")
    spec = ctx.threshold_spec(did, "min_assets")
    if revenue is None or total_assets is None:
        return _base.quiet(ctx.skipped(
            did, "the period carries no revenue line or no total assets, so "
                 "the pair this rule compares does not exist"))
    if revenue != 0:
        return _base.quiet(ctx.not_fired(
            did, spec, ">", total_assets, F.UNIT_MONEY,
            note="revenue is recorded for this period, so the extraction gap "
                 "this rule looks for is not present"))
    if capitalised is not None and capitalised != 0:
        return _base.quiet(ctx.not_fired(
            did, spec, ">", total_assets, F.UNIT_MONEY,
            note="turnover is nil but account 722 carries capitalised own work, "
                 "so the period is producing for itself rather than mis-extracted"))

    element = _base.normalised_threshold(spec, ">", total_assets)
    if element is None or element.observed <= element.limit:
        return _base.quiet(ctx.not_fired(
            did, spec, ">", total_assets, F.UNIT_MONEY,
            note="turnover is nil but the asset base is below the pack's "
                 "materiality floor"))

    bag = (_base.Bag()
           .money("total_assets", total_assets, "total assets carried")
           .money("revenue", revenue, "turnover recorded for the period")
           .ratio("asset_floor_multiple_x", element.observed,
                  "asset base as a multiple of the materiality floor"))

    total_operating_revenue = r.view("pl", "total_operating_revenue")
    impact = _base.ratio_impact_or_none(
        "asset_turnover_by_revenue_view",
        "Asset turnover, read off the turnover line versus off total operating "
        "revenue",
        numerator=r.q(revenue, "revenue"),
        denominator=r.q(total_assets, "total_assets"),
        adjusted_numerator=(None if total_operating_revenue is None
                            else r.q(total_operating_revenue,
                                     "total_operating_revenue")),
        unit=F.UNIT_RATIO)

    return _base.found(_base.build_finding(
        ctx, did, "critical", _PNL_ZERO_SUBJECT,
        scope="Turnover on 701 / 704 / 707 against the asset base",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="profile_threshold",
            description="the asset base is expressed as a multiple of the "
                        "pack's material asset-base floor, so the comparison "
                        "prints in the same units on both sides",
            basis_value=float(spec.value), basis_unit=F.UNIT_MONEY),
        threshold_element=element,
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Extract the class 7 accounts as year-to-date "
                           "movements rather than closing balances",
                artefact="rulaj cumulat columns for accounts 701 to 708",
                provider="the accounting team",
                horizon="before any earnings figure is quoted"),
            F.ActionStep(
                imperative="Tie the reconstructed turnover to the closing "
                           "balance of account 121",
                artefact="121 closing-balance reconciliation against the "
                         "reconstructed profit and loss",
                provider="the financial controller"),
        ),
        extra_caveats=applicability.caveats))


# ── earnings_quality_capitalized_own_work ────────────────────────────────

_COW_SUBJECT = (
    F.Account("722", "Venituri din producția de imobilizări corporale", "PL"),
    F.Account("628", "Alte cheltuieli cu serviciile executate de terți", "PL"),
)


def detect_capitalized_own_work(ctx: _base.Ctx) -> _base.Outcome:
    did = "earnings_quality_capitalized_own_work"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    capitalised = r.view("pl", "capitalized_own_work_memo")
    revenue = r.view("pl", "revenue")
    statutory = r.view("pl", "ebitda_statutory")
    operational = r.view("pl", "ebitda_operational")
    spec = ctx.threshold_spec(did, "share_of_revenue_high")
    if capitalised is None or revenue is None:
        return _base.quiet(ctx.skipped(
            did, "account 722 or the turnover line is absent from this period's "
                 "profit and loss"))
    observed = _base.share(r, capitalised, revenue,
                           "capitalized_own_work_memo", "revenue")
    if observed is None:
        return _base.quiet(ctx.skipped(
            did, "turnover is nil, so the capitalised share has no denominator"))
    if observed <= spec.value:
        return _base.quiet(ctx.not_fired(
            did, spec, ">", observed, F.UNIT_PERCENT,
            note="capitalised own work is a minority of turnover"))
    if statutory is None or operational is None:
        return _base.quiet(ctx.skipped(
            did, "the statutory and operational EBITDA views are not both "
                 "present, so the gap this rule exists to size cannot be "
                 "computed"))

    bag = (_base.Bag()
           .money("capitalized_own_work_memo", capitalised,
                  "capitalised own work on account 722")
           .money("revenue", revenue, "turnover")
           .money("ebitda_statutory", statutory, "EBITDA, statutory view")
           .money("ebitda_operational", operational, "EBITDA, operational view")
           .percent("capitalised_share", observed,
                    "capitalised own work as a share of turnover"))

    impact = _base.ratio_impact_or_none(
        "ebitda_margin_by_view",
        "EBITDA margin, statutory view versus operational view",
        numerator=r.q(statutory, "ebitda_statutory"),
        denominator=r.q(revenue, "revenue"),
        adjusted_numerator=r.q(operational, "ebitda_operational"),
        unit=F.UNIT_PERCENT)

    # Deterministic severity: when the operational view is non-positive the
    # whole of the reported EBITDA is the 722/628 wash, which is a different
    # statement from "a slice of it is".
    severity = "high" if operational <= 0 else "info"

    return _base.found(_base.build_finding(
        ctx, did, severity, _COW_SUBJECT,
        scope="Capitalised own work on 722 against turnover",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="self_total",
            description="capitalised own work is measured against the company's "
                        "own turnover for the same period, and the two EBITDA "
                        "views are the engine's statutory and operational "
                        "assemblies of the same accounts",
            basis_value=revenue, basis_unit=F.UNIT_MONEY),
        threshold_element=_base.threshold(spec, ">", observed, F.UNIT_PERCENT),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Recompute the covenant EBITDA on the definition "
                           "written into the facility agreement",
                artefact="EBITDA bridge from the statutory view to the "
                         "operational view, line by line",
                provider="the treasury team",
                horizon="before the next compliance certificate"),
            F.ActionStep(
                imperative="Disclose the 722 treatment in the next compliance "
                           "certificate",
                artefact="certificate note stating which EBITDA view was used "
                         "and why",
                provider="the financial controller"),
        ),
        extra_caveats=applicability.caveats))


# ── valuation_ebitda_non_positive ────────────────────────────────────────

_EBITDA_SUBJECT = (
    F.Account("121", "Profit sau pierdere", "PL"),
    F.Account("681", "Cheltuieli de exploatare privind amortizarea", "PL"),
)


def detect_ebitda_non_positive(ctx: _base.Ctx) -> _base.Outcome:
    did = "valuation_ebitda_non_positive"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    statutory = r.view("pl", "ebitda_statutory")
    revenue = r.view("pl", "revenue")
    total_assets = r.view("bs", "total_assets")
    spec = ctx.threshold_spec(did, "ebitda_max")
    if statutory is None:
        return _base.quiet(ctx.skipped(
            did, "the period carries no statutory EBITDA line"))
    if statutory > spec.value:
        return _base.quiet(ctx.not_fired(
            did, spec, "<=", statutory, F.UNIT_MONEY,
            note="statutory EBITDA is positive, so an earnings multiple has a "
                 "denominator"))

    # The floor is ZERO, and zero is scale-free: comparing an EBITDA
    # SHARE against the same 0.0 is the identical decision and prints
    # without a currency label the templatizer could not bind.
    #
    # The share is taken on the ASSET BASE rather than on turnover, for
    # a reason the finding itself gives: when the earnings multiple has
    # no denominator, the valuation moves to the assets, so EBITDA per
    # unit of asset is the comparison the reader is being sent to. It is
    # also the stable one — a property vehicle with a nominal rent line
    # produces a margin of -17,885%, which is arithmetically true and
    # tells nobody anything.
    if total_assets is not None and total_assets != 0:
        base_value, base_name, base_label = (total_assets, "total_assets",
                                             "total assets")
        basis = ("statutory EBITDA is expressed as a share of the company's own "
                 "asset base — the base an asset method would value it on — so "
                 "the zero floor prints in the same units on both sides")
    elif revenue is not None and revenue != 0:
        base_value, base_name, base_label = revenue, "revenue", "turnover"
        basis = ("no asset base is available, so statutory EBITDA is expressed "
                 "as a share of the company's own turnover against the same "
                 "zero floor")
    else:
        return _base.quiet(ctx.skipped(
            did, "neither an asset base nor turnover is available to express "
                 "the zero EBITDA floor without a currency label"))

    observed = _base.share(r, statutory, base_value, "ebitda_statutory", base_name)
    if observed is None:
        return _base.quiet(ctx.skipped(
            did, "the EBITDA share is undefined for this period"))

    bag = (_base.Bag()
           .money("ebitda_statutory", statutory, "statutory EBITDA")
           .money(base_name, base_value, base_label)
           .percent("ebitda_return_share", observed,
                    "statutory EBITDA as a share of " + base_label))

    impact = _base.ratio_impact_or_none(
        "ebitda_share_to_breakeven",
        "Statutory EBITDA against " + base_label + ", as reported versus at "
        "break-even",
        numerator=r.q(statutory, "ebitda_statutory"),
        denominator=r.q(base_value, base_name),
        adjusted_numerator=r.q(0.0, "breakeven_ebitda"),
        unit=F.UNIT_PERCENT)

    return _base.found(_base.build_finding(
        ctx, did, "high", _EBITDA_SUBJECT,
        scope="Statutory EBITDA behind account 121",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="profile_threshold", description=basis,
            basis_value=float(spec.value), basis_unit=F.UNIT_PERCENT),
        threshold_element=_base.threshold(spec, "<=", observed, F.UNIT_PERCENT),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Compute the valuation on the asset and revenue "
                           "methods instead of an earnings multiple",
                artefact="asset-based and revenue-multiple valuation run for "
                         "this period",
                provider="the valuation tab of this platform"),
            F.ActionStep(
                imperative="Split the operating result between recurring "
                           "trading and one-off items",
                artefact="normalised EBITDA bridge listing every one-off "
                         "adjustment and its account",
                provider="the financial controller",
                horizon="before the next investor or lender pack"),
        ),
        extra_caveats=applicability.caveats))


DETECTORS = {
    "data_quality_bs_imbalance": detect_bs_imbalance,
    "data_quality_pnl_zero": detect_pnl_zero,
    "earnings_quality_capitalized_own_work": detect_capitalized_own_work,
    "valuation_ebitda_non_positive": detect_ebitda_non_positive,
}
