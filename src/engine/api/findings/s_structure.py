"""S-STRUCTURE — is the composition of this company's cost base, asset
base and equity what its profile band expects?

Three detectors, all of them about SHAPE rather than level:

  input_cost_exposure                    how much of every unit of
                                         turnover leaves again as input
                                         cost
  asset_maturity                         how much of the productive
                                         asset base has already been
                                         written off
  equity_quality_revaluation_reserves    how much of book equity was
                                         created by writing assets up
                                         rather than by earning

ONE OF THE THREE REFUSES, ON PURPOSE
``asset_maturity`` is registered with the parameter "accumulated-
depreciation share of gross PP&E", and this engine's canonical views
carry NEITHER gross PP&E nor accumulated depreciation — only ``ppe_net``
and the period's depreciation CHARGE. The rule therefore cannot form the
quantity its threshold judges, and it says so: a check record naming the
two missing fields, and no finding.

That is not a gap being papered over, it is the gap being stated. The
rule this replaces computed ``sub_agg["ppe_amort"] / bs["propertyPlant
Equipment"]``, where ``ppe_amort`` does not exist in any assembled
period — so the numerator was silently 0.0, the share was silently 0.0,
and the rule silently never fired on any company. Same outcome; the
difference is that the reader is now told.

A proxy WAS available (``ppe_net / depreciation`` gives an implied
remaining life in years) and was deliberately not used: it answers a
different question from the one the registered threshold asks, and
printing it under that threshold's label would be a mislabelled number
rather than a missing one.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from .. import _finding as F
from . import _base


# ── input_cost_exposure ──────────────────────────────────────────────────

_INPUT_COST_SUBJECT = (
    F.Account("601", "Cheltuieli cu materiile prime", "PL"),
    F.Account("602", "Cheltuieli cu materialele consumabile", "PL"),
    F.Account("607", "Cheltuieli privind mărfurile", "PL"),
)


def detect_input_cost_exposure(ctx: _base.Ctx) -> _base.Outcome:
    """Input cost as a share of turnover, against the profile's ceiling.

    NOTE ON WHAT IS CITED. The input-cost AMOUNT is not printed. Money
    figures may only be printed under a fact name ``_ratio_units``
    declares as money, and there is no declared name for cost of goods
    sold; an undeclared money figure would print as digits beside a raw
    currency word and never convert for display. So the amount travels
    as the observed SHARE (dimensionless, and therefore identical in
    every display currency) with turnover and EBITDA as the money
    anchors — and the recomputed impact restates the whole thing as a
    margin, which is what the reader acts on anyway.
    """
    did = "input_cost_exposure"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    cogs = r.view("pl", "cogs")
    revenue = r.view("pl", "revenue")
    ebitda = r.view("pl", "ebitda_statutory")
    spec = ctx.threshold_spec(did, "share_of_revenue_high")
    if cogs is None or revenue is None:
        return _base.quiet(ctx.skipped(
            did, "the period carries no cost-of-goods line or no turnover line"))
    observed = _base.share(r, cogs, revenue, "cogs", "revenue")
    if observed is None:
        return _base.quiet(ctx.skipped(
            did, "turnover is nil, so an input-cost share has no denominator"))
    if observed <= spec.value:
        return _base.quiet(ctx.not_fired(
            did, spec, ">", observed, F.UNIT_PERCENT,
            note="input cost sits inside the ceiling this profile is graded on"))
    if ebitda is None:
        return _base.quiet(ctx.skipped(
            did, "statutory EBITDA is absent, so the margin consequence of the "
                 "input-cost share cannot be recomputed"))

    bag = (_base.Bag()
           .money("revenue", revenue, "turnover")
           .money("ebitda_statutory", ebitda, "statutory EBITDA")
           .percent("input_cost_share", observed,
                    "input cost as a share of turnover")
           .fact_only("input_cost_ceiling_share", float(spec.value)))

    # The counterfactual uses the TABLE's own ceiling and nothing else —
    # no invented price shock. "What this margin would be if input cost
    # sat where this profile is graded" is a number the table already
    # decided; a 10% shock would be a number this module invented.
    ebitda_at_ceiling = ebitda + (cogs - revenue * float(spec.value))
    impact = _base.ratio_impact_or_none(
        "ebitda_margin_at_input_cost_ceiling",
        "EBITDA margin, as reported versus with input cost at the ceiling this "
        "profile is graded on",
        numerator=r.q(ebitda, "ebitda_statutory"),
        denominator=r.q(revenue, "revenue"),
        adjusted_numerator=r.q(ebitda_at_ceiling, "ebitda_at_input_cost_ceiling"),
        unit=F.UNIT_PERCENT)

    return _base.found(_base.build_finding(
        ctx, did, "medium", _INPUT_COST_SUBJECT,
        scope="Input cost on 601 / 602 / 607 against turnover",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="profile_threshold",
            description="input cost is measured against the company's own "
                        "turnover for the same period, and the ceiling is the "
                        "one this structural profile is graded on",
            basis_value=float(spec.value), basis_unit=F.UNIT_PERCENT),
        threshold_element=_base.threshold(spec, ">", observed, F.UNIT_PERCENT),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Negotiate index-linked price-review clauses into the "
                           "largest supplier contracts",
                artefact="price-review clause covering the input lines behind "
                         "601 and 602",
                provider="the procurement lead",
                horizon="before the next annual price round"),
            F.ActionStep(
                imperative="Hedge the next two quarters of input volume",
                artefact="forward purchase cover schedule, by input line and "
                         "delivery month",
                provider="the treasury team"),
        ),
        extra_caveats=applicability.caveats))


# ── asset_maturity — the stated refusal ──────────────────────────────────

#: The canonical names this rule WOULD read. Named in the check record so
#: the refusal is actionable rather than a shrug, and so the rule starts
#: answering the day either field lands, with no code change.
_ASSET_MATURITY_INPUTS = ("assembled_bs.ppe_gross",
                          "assembled_bs.ppe_accumulated_depreciation")


def detect_asset_maturity(ctx: _base.Ctx) -> _base.Outcome:
    did = "asset_maturity"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    gross = r.value("ppe_gross", "property_plant_equipment_gross")
    accumulated = r.value("ppe_accumulated_depreciation", "ppe_amort")
    if gross is None or accumulated is None:
        missing = [name for name, value in
                   zip(_ASSET_MATURITY_INPUTS, (gross, accumulated))
                   if value is None]
        return _base.quiet(ctx.skipped(
            did,
            "not run: the accumulated-depreciation share of GROSS PP&E cannot "
            "be formed because %s is not carried by this engine's canonical "
            "views. The net book value and the period charge are present, but "
            "they answer a different question from the one this threshold asks, "
            "so no proxy was substituted." % " and ".join(missing)))

    observed = _base.share(r, accumulated, gross, "ppe_amort", "ppe_gross")
    spec = ctx.threshold_spec(did, "accumulated_depreciation_share_high")
    if observed is None:
        return _base.quiet(ctx.skipped(
            did, "gross PP&E is nil, so the depreciation share has no "
                 "denominator"))
    if observed <= spec.value:
        return _base.quiet(ctx.not_fired(
            did, spec, ">", observed, F.UNIT_PERCENT,
            note="the productive asset base is younger than this profile's "
                 "replacement-cycle ceiling"))

    # Reached only once the canonical fields exist. Kept complete rather
    # than raising, so the rule ships whole and starts speaking on the
    # first period that carries the pair.
    # Both cited figures are dimensionless. Gross PP&E and accumulated
    # depreciation have no declared money name in `_ratio_units`, so
    # printing either as currency would leave an unbindable figure — the
    # same constraint `input_cost_exposure` documents. They travel as
    # facts on the payload instead.
    net_book_value = gross - accumulated
    remaining_share = _base.share(r, net_book_value, gross, "ppe_net", "ppe_gross")
    if remaining_share is None:
        return _base.quiet(ctx.skipped(
            did, "the remaining book-value share is undefined for this period"))
    bag = (_base.Bag()
           .percent("asset_maturity", observed,
                    "accumulated depreciation as a share of gross PP&E")
           .percent("remaining_book_value_share", remaining_share,
                    "share of the gross asset base still carried at book value")
           .fact_only("ppe_gross", gross)
           .fact_only("ppe_accumulated_depreciation", accumulated))
    impact = _base.ratio_impact_or_none(
        "remaining_book_value_share",
        "Share of the gross asset base still carried at book value",
        numerator=r.q(net_book_value, "ppe_net"),
        denominator=r.q(gross, "ppe_gross"),
        adjusted_numerator=r.q(gross * (1.0 - float(spec.value)),
                               "ppe_net_at_ceiling"),
        unit=F.UNIT_PERCENT)
    return _base.found(_base.build_finding(
        ctx, did, "medium",
        (F.Account("212", "Construcții", "BS"),
         F.Account("213", "Instalații tehnice și mijloace de transport", "BS"),
         F.Account("281", "Amortizări privind imobilizările corporale", "BS")),
        scope="Accumulated depreciation on 281 against gross PP&E",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="profile_threshold",
            description="accumulated depreciation is measured against the "
                        "company's own gross PP&E for the same period",
            basis_value=gross, basis_unit=F.UNIT_MONEY),
        threshold_element=_base.threshold(spec, ">", observed, F.UNIT_PERCENT),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Obtain the fixed-asset register with the remaining "
                           "useful life of each major line",
                artefact="fixed-asset register extract sorted by remaining life",
                provider="the accounting team"),
            F.ActionStep(
                imperative="Schedule the replacement capex against the maturity "
                           "of the committed facilities",
                artefact="capex plan mapped onto the facility maturity ladder",
                provider="the treasury team"),
        ),
        extra_caveats=applicability.caveats))


# ── equity_quality_revaluation_reserves ──────────────────────────────────

_REVALUATION_SUBJECT = (
    F.Account("105", "Rezerve din reevaluare", "BS"),
)


def detect_revaluation_reserves(ctx: _base.Ctx) -> _base.Outcome:
    """How much of book equity has never been cash.

    The impact strips the reserve from BOTH sides — equity and assets —
    because that is what a lender does: the reserve and the write-up it
    came from are the same money counted once on each side, and removing
    it from equity alone would overstate the damage.
    """
    did = "equity_quality_revaluation_reserves"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    reserves = r.view("bs", "revaluation_reserves")
    total_equity = r.view("bs", "total_equity")
    total_assets = r.view("bs", "total_assets")
    spec = ctx.threshold_spec(did, "share_of_equity_high")
    if reserves is None or total_equity is None:
        return _base.quiet(ctx.skipped(
            did, "the period carries no revaluation reserve line or no equity "
                 "total"))
    if total_equity <= 0:
        return _base.quiet(ctx.skipped(
            did, "book equity is not positive, so a share of equity is not a "
                 "meaningful measure here — the equity position itself is the "
                 "finding, and art. 153^24 covers it"))
    # The SHARE is taken on the magnitude (a reserve booked negative is a
    # write-DOWN, and it dilutes equity quality just as a write-up does),
    # while the cited FIGURE keeps the signed balance — a fact on the
    # payload must be the value the books carry, not its magnitude.
    observed = _base.share(r, abs(reserves), total_equity,
                           "revaluation_reserves", "total_equity")
    if observed is None:
        return _base.quiet(ctx.skipped(did, "the reserve share is undefined"))
    if observed <= spec.value:
        return _base.quiet(ctx.not_fired(
            did, spec, ">", observed, F.UNIT_PERCENT,
            note="the revaluation reserve is a minority of book equity"))
    if total_assets is None or total_assets <= abs(reserves):
        return _base.quiet(ctx.skipped(
            did, "total assets are absent or smaller than the reserve, so the "
                 "haircut cannot be recomputed on both sides"))

    bag = (_base.Bag()
           .money("revaluation_reserves", reserves,
                  "revaluation reserve on account 105")
           .money("total_equity", total_equity, "book equity")
           .money("total_assets", total_assets, "total assets")
           .percent("pct_of_equity", observed,
                    "revaluation reserve as a share of book equity"))

    impact = _base.ratio_impact_or_none(
        "equity_ratio_ex_revaluation",
        "Equity ratio once the revaluation reserve is removed from both sides",
        numerator=r.q(total_equity, "total_equity"),
        denominator=r.q(total_assets, "total_assets"),
        adjusted_numerator=r.q(total_equity - abs(reserves),
                               "equity_ex_revaluation"),
        adjusted_denominator=r.q(total_assets - abs(reserves),
                                 "assets_ex_revaluation"),
        unit=F.UNIT_PERCENT)

    return _base.found(_base.build_finding(
        ctx, did, "medium", _REVALUATION_SUBJECT,
        scope="Revaluation reserve on 105 inside book equity",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="self_total",
            description="the reserve is measured against the company's own book "
                        "equity for the same period",
            basis_value=total_equity, basis_unit=F.UNIT_MONEY),
        threshold_element=_base.threshold(spec, ">", observed, F.UNIT_PERCENT),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Obtain the valuation report that supports the 105 "
                           "balance, with its effective date",
                artefact="independent valuation report and the valuer's "
                         "engagement terms",
                provider="the valuer engaged by the company",
                horizon="before the next covenant certificate"),
            F.ActionStep(
                imperative="Recompute the gearing covenant on equity excluding "
                           "account 105",
                artefact="restated gearing calculation on both definitions",
                provider="the treasury team"),
        ),
        extra_caveats=applicability.caveats))


DETECTORS = {
    "input_cost_exposure": detect_input_cost_exposure,
    "asset_maturity": detect_asset_maturity,
    "equity_quality_revaluation_reserves": detect_revaluation_reserves,
}
