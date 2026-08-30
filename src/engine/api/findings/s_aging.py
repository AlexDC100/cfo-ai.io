"""S-AGING — how old is the money the company is owed, and how much of it
has it already stopped believing in?

THE METHOD, STATED UP FRONT — because the brief requires the method to
be stated wherever aging is inferred rather than measured.

There is no aging in this engine's canonical views. No bucket, no
invoice date, no settlement date reaches ``assembled_bs``; what reaches
it is three balances:

    ar_net             receivables carried net of allowance
    ar_provisions      the 49x allowance against them
    ar_doubtful_gross  balances already reclassified to 4118

So this module measures the ONE aging question those three can answer
honestly: what share of gross receivables the company has already
provided against. A high share is not a collection problem in the
future — it is a collection problem the company has already conceded,
still sitting inside the current-asset total a lender reads.

Three things this module deliberately does NOT do:

  · It does not infer buckets from the balances. A single net figure
    cannot be split into 30/60/90 without inventing the split.
  · It does not use the cash-flow view's ``delta_receivables`` as a
    movement proxy. On every period where ``is_approximated`` is set —
    which is every period with no prior trial balance — that delta is a
    5%-of-balance ESTIMATE, not a movement. Aging built on it would be
    aging built on an assumption.
  · It does not read a doubtful balance as an allowance. A balance
    reclassified to 4118 with no 49x allowance behind it is a real
    signal, and it is recorded as a CHECK with the numbers attached —
    but it is not the quantity the registered threshold judges, and
    printing it under that threshold's label would be a mislabelled
    number.

The proxy is declared in the comparison basis and costs the finding its
"high" confidence position, which is what a proxy should cost.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from .. import _finding as F
from . import _base

_RECEIVABLES_SUBJECT = (
    F.Account("411", "Clienți", "BS"),
    F.Account("4118", "Clienți incerți sau în litigiu", "BS"),
    F.Account("491", "Ajustări pentru deprecierea creanțelor – clienți", "BS"),
)

_METHOD = ("The allowance share of gross receivables is the aging read this "
           "engine can support: the canonical views carry no invoice or "
           "settlement dates, so no aging bucket is asserted.")


def detect_receivables_allowance_quality(ctx: _base.Ctx) -> _base.Outcome:
    did = "receivables_allowance_quality"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    net_receivables = r.view("bs", "ar_net")
    allowance = r.view("bs", "ar_provisions")
    doubtful = r.view("bs", "ar_doubtful_gross")
    revenue = r.view("pl", "revenue")
    days = r.period_days()
    spec = ctx.threshold_spec(did, "allowance_share_high")

    if net_receivables is None or allowance is None:
        return _base.quiet(ctx.skipped(
            did, "the period carries no net receivable balance or no 49x "
                 "allowance line, so the allowance share cannot be formed"))

    gross = net_receivables + allowance
    observed = _base.share(r, allowance, gross, "rec_provisions", "trade_rec")
    if observed is None:
        return _base.quiet(ctx.skipped(
            did, "gross receivables are nil, so the allowance share has no "
                 "denominator"))

    if observed <= spec.value:
        # Not a finding — but not nothing either. A balance the company
        # has moved to 4118 without an allowance behind it is stated with
        # its numbers, on the row where a reader looks for what was
        # checked.
        note = "the 49x allowance is a minority of gross receivables"
        if doubtful is not None and doubtful > 0 and allowance < doubtful:
            coverage = _base.share(r, allowance, doubtful,
                                   "rec_provisions", "ar_doubtful_gross")
            # Stated as a dimensionless COVERAGE, never as a money
            # magnitude: a check note is not templatized, so a currency
            # amount written here would stay native beside converted
            # figures elsewhere on the page.
            note += ("; separately, the 4118 doubtful balances are only %.2f "
                     "covered by the 49x allowance. Recorded here rather than "
                     "surfaced: the registered threshold judges the allowance "
                     "share of gross receivables, not the coverage of doubtful "
                     "balances, and printing one under the other's label would "
                     "be a mislabelled number." % (coverage or 0.0))
        return _base.quiet(ctx.not_fired(
            did, spec, ">", observed, F.UNIT_PERCENT, note=note))

    bag = (_base.Bag()
           .money("rec_provisions", allowance, "49x allowance against receivables")
           .money("trade_rec", gross, "gross trade receivables before allowance")
           .percent("prov_pct", observed,
                    "allowance as a share of gross receivables"))

    # Days sales outstanding, gross and net of the allowance: the size of
    # the collection the balance sheet is still carrying as an asset.
    impact = None
    if revenue is not None and days is not None and revenue != 0:
        daily_revenue = _base.per_day(revenue, days)
        impact = _base.whole_days_impact(
            "days_sales_outstanding_net_of_allowance",
            "Days sales outstanding, gross versus net of the allowance already "
            "booked",
            r,
            held_days=_base.quotient(r.q(gross, "trade_rec"),
                                     r.q(daily_revenue, "daily_revenue")),
            target_days=_base.quotient(r.q(gross - allowance, "trade_rec_net"),
                                       r.q(daily_revenue, "daily_revenue")),
            unit_cost=daily_revenue,
            unit_cost_name="daily_revenue")

    return _base.found(_base.build_finding(
        ctx, did, "high", _RECEIVABLES_SUBJECT,
        scope="Allowance on 491 against gross receivables on 411",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="self_total",
            description="the allowance is measured against the company's own "
                        "gross receivables for the same period. " + _METHOD,
            basis_value=gross, basis_unit=F.UNIT_MONEY),
        threshold_element=_base.threshold(spec, ">", observed, F.UNIT_PERCENT),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Extract the 411 aging by counterparty and settlement "
                           "date",
                artefact="411 aging report at the balance-sheet date, with 4118 "
                         "shown separately",
                provider="the credit control team",
                horizon="before the next receivables review with the bank"),
            F.ActionStep(
                imperative="Write off the balances the 491 allowance already "
                           "covers",
                artefact="write-off schedule with the approval that supports it",
                provider="the financial controller"),
        ),
        extra_caveats=applicability.caveats,
        method_caveat=_METHOD))


DETECTORS = {
    "receivables_allowance_quality": detect_receivables_allowance_quality,
}
