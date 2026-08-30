"""S-CONCENTRA — one source carrying a disproportionate share of a class,
and what the number looks like once that source is taken out.

The class this detector concentrates on is EARNINGS. A receivable
concentration is a balance the company can chase; an earnings
concentration is a result the company does not control — it is decided
in another entity's general meeting — and it is the one a lender
discounts first.

THE DERIVATION, STATED
There is no canonical "income from participations" field. What the
assembled P&L carries is ``financial_income`` (the whole class 76),
``interest_income`` (766) and ``fx_gain`` (765). Participation income is
therefore taken as::

    financial_income - interest_income - fx_gain

which leaves 761 / 762 / 763 and the residue of 768. The derivation is
printed in the comparison basis, not hidden in a helper, because a
reader who disagrees with it has to be able to see it. Where the
subtraction lands at or below zero the rule does NOT fire: a
non-positive residue means the period recorded no participation income,
and asserting a concentration from a rounding artefact would be exactly
the fabrication this package refuses. (Two of the regression fixtures
land at -2.9e-11 and -1.8e-12 — floating residue, not income.)

THE IMPACT IS THE EXCLUSION
The law asks a concentration finding for "the impact of EXCLUDING it".
So the impact is the net margin recomputed without the participation
income: the margin the company earned from what it actually does.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from .. import _finding as F
from . import _base

_AFFILIATE_SUBJECT = (
    F.Account("761", "Venituri din imobilizări financiare", "PL"),
    F.Account("762", "Venituri din investiții financiare pe termen scurt", "PL"),
    F.Account("763", "Venituri din creanțe imobilizate", "PL"),
)


def detect_affiliate_income_dependency(ctx: _base.Ctx) -> _base.Outcome:
    did = "affiliate_income_dependency"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    financial_income = r.view("pl", "financial_income")
    interest_income = r.view("pl", "interest_income")
    fx_gain = r.view("pl", "fx_gain")
    net_income = r.view("pl", "net_income_statutory")
    revenue = r.view("pl", "revenue")
    spec = ctx.threshold_spec(did, "share_of_net_income_high")

    if financial_income is None or interest_income is None or fx_gain is None:
        return _base.quiet(ctx.skipped(
            did, "the financial-income, interest-income and FX-gain lines are "
                 "not all present, so participation income cannot be isolated "
                 "from the rest of class 76"))
    participation = financial_income - interest_income - fx_gain
    if participation <= 0:
        return _base.quiet(ctx.skipped(
            did, "class 76 carries no positive residue once interest and FX are "
                 "removed, so this period recorded no participation income"))
    if net_income is None or net_income <= 0:
        return _base.quiet(ctx.skipped(
            did, "the statutory result is absent or not positive, so a share of "
                 "net income is not a meaningful denominator"))

    observed = _base.share(r, participation, net_income,
                           "affiliate_income", "net_income")
    if observed is None:
        return _base.quiet(ctx.skipped(did, "the dependency share is undefined"))
    if observed <= spec.value:
        return _base.quiet(ctx.not_fired(
            did, spec, ">", observed, F.UNIT_PERCENT,
            note="participation income is a minority of the statutory result"))
    if revenue is None or revenue == 0:
        return _base.quiet(ctx.skipped(
            did, "turnover is absent or nil, so the margin consequence of "
                 "excluding participation income cannot be recomputed"))

    bag = (_base.Bag()
           .money("affiliate_income", participation,
                  "participation income, class 76 net of interest and FX")
           .money("net_income", net_income, "statutory result for the period")
           .money("revenue", revenue, "turnover")
           .percent("affiliate_dep", observed,
                    "participation income as a share of the statutory result"))

    impact = _base.ratio_impact_or_none(
        "net_margin_ex_participation_income",
        "Net margin, as reported versus excluding participation income",
        numerator=r.q(net_income, "net_income"),
        denominator=r.q(revenue, "revenue"),
        adjusted_numerator=r.q(net_income - participation,
                               "net_income_ex_participation"),
        unit=F.UNIT_PERCENT)

    return _base.found(_base.build_finding(
        ctx, did, "medium", _AFFILIATE_SUBJECT,
        scope="Participation income on 761 / 762 / 763 inside the result",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="self_total",
            description="participation income is taken as class 76 financial "
                        "income less interest income on 766 and FX gains on "
                        "765, and measured against the company's own statutory "
                        "result for the same period",
            basis_value=net_income, basis_unit=F.UNIT_MONEY),
        threshold_element=_base.threshold(spec, ">", observed, F.UNIT_PERCENT),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Obtain the distribution resolution of each "
                           "participation for this period",
                artefact="general-meeting dividend resolutions, one per "
                         "participation, with the declared amount",
                provider="the group corporate secretary"),
            F.ActionStep(
                imperative="Rank the participations by distribution yield on "
                           "their carrying value",
                artefact="per-entity yield schedule against the 261 / 263 "
                         "carrying amounts",
                provider="the group controller",
                horizon="before the next budget round"),
        ),
        extra_caveats=applicability.caveats))


DETECTORS = {
    "affiliate_income_dependency": detect_affiliate_income_dependency,
}
