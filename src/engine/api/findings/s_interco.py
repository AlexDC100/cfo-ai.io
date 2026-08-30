"""S-INTERCO — money lent inside the group, and what a lender does to it.

One detector, and it is the worked case the whole contract was designed
around: the Critical-461 note. The live version of that note scored 1.5
of the seven contract elements — it named a balance and a percentage,
told the reader that recoverability "should be confirmed", and stopped.
This one carries all seven, and the arithmetic that made the note
famous (19.6% of total assets, native over native) is untouched.

THE HAIRCUT IS RECOMPUTED, NOT DESCRIBED
The old note said lenders "typically haircut related-party receivables
during covenant measurement". This one performs the haircut: the
current ratio is recomputed with the related-party balance removed from
current assets, and both numbers are printed. That is the difference
between a sentence a reader has to act on and a sentence a reader can
act with.

The current ratio is the right recomputation for this family because
``ar_intercompany`` sits INSIDE current assets — the pack routes 451,
452, 455 and 461 into the ``otherCurrentAssets`` bucket — so removing it
moves exactly one side of the ratio, which is what a credit committee
does to it.

THE ACCOUNT FAMILY IS THE PACK'S, NOT THIS MODULE'S
``country_packs/ro_romania/canonical_adapter.py`` maps 451 / 452 / 455 /
461 into ``ar_intercompany``. The family is restated here so the subject
can name real ledger codes, and a guard test in
``tests/engine/test_findings_single_period.py`` re-reads the adapter and
fails if the two ever disagree — the family is data, and a copy of data
needs a leash.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from .. import _finding as F
from . import _base

#: The RO account family the pack routes into ``ar_intercompany``.
#: Restated from canonical_adapter._RAS_TO_CANONICAL; kept honest by a
#: guard test rather than by memory.
RELATED_PARTY_ACCOUNTS = (
    F.Account("461", "Debitori diverși", "BS", "ar_intercompany"),
    F.Account("451", "Decontări între entitățile afiliate", "BS", "ar_intercompany"),
    F.Account("452", "Decontări privind interesele de participare", "BS",
              "ar_intercompany"),
    F.Account("455", "Sume datorate acționarilor / asociaților", "BS",
              "ar_intercompany"),
)

_BANDS = (
    _base.Band("share_of_assets_high", "high"),
    _base.Band("share_of_assets_medium", "medium"),
)


def detect_related_party_concentration(ctx: _base.Ctx) -> _base.Outcome:
    did = "concentration_related_party"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    related_party = r.value("ar_intercompany", "intercompany_loans")
    total_assets = r.view("bs", "total_assets")
    if related_party is None or total_assets is None:
        return _base.quiet(ctx.skipped(
            did, "the period carries no related-party receivable line or no "
                 "asset total"))
    observed = _base.share(r, related_party, total_assets,
                           "intercompany_loans", "total_assets")
    if observed is None:
        return _base.quiet(ctx.skipped(
            did, "total assets are nil, so a share of assets has no denominator"))

    # Pick the band that ACTUALLY fired. A finding that cites the "high"
    # parameter while the observation only clears "elevated" is demoted by
    # the contract with "the rule did not actually fire", and rightly so.
    hit = _base.fired_band(ctx.profile, did, _BANDS, observed, ">")
    if hit is None:
        spec = ctx.threshold_spec(did, "share_of_assets_medium")
        return _base.quiet(ctx.not_fired(
            did, spec, ">", observed, F.UNIT_PERCENT,
            note="related-party balances sit inside the share this profile "
                 "tolerates"))
    band, spec = hit

    current_assets = r.view("bs", "total_current_assets")
    current_liabilities = r.view("bs", "total_current_liabilities")
    if current_liabilities is None:
        return _base.quiet(ctx.skipped(
            did, "current liabilities are absent, so the lender's haircut "
                 "cannot be recomputed on the current ratio"))

    bag = (_base.Bag()
           .money("intercompany_loans", related_party,
                  "related-party balance on 461")
           .money("total_assets", total_assets, "total assets")
           .money("cur_liab", current_liabilities, "current liabilities")
           .percent("pct_of_assets", observed, "share of total assets"))

    impact = _base.ratio_impact_or_none(
        "current_ratio_ex_related_party",
        "Current ratio after a full related-party haircut",
        numerator=(None if current_assets is None
                   else r.q(current_assets, "total_current_assets")),
        denominator=r.q(current_liabilities, "total_current_liabilities"),
        adjusted_numerator=(None if current_assets is None
                            else r.q(current_assets - related_party,
                                     "current_assets_ex_related_party")),
        unit=F.UNIT_RATIO)

    return _base.found(_base.build_finding(
        ctx, did, band.severity, RELATED_PARTY_ACCOUNTS,
        scope="Related-party receivable on 461",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="self_total",
            description="measured against the company's own total assets for "
                        "the same period",
            basis_value=total_assets, basis_unit=F.UNIT_MONEY),
        threshold_element=_base.threshold(spec, ">", observed, F.UNIT_PERCENT),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Pull the 461 sub-ledger by counterparty with "
                           "settlement dates",
                artefact="461 aging schedule per related entity",
                provider="the group financial controller",
                horizon="before the next covenant certificate"),
            F.ActionStep(
                imperative="Recompute the gearing covenant with the 461 balance "
                           "excluded",
                artefact="restated covenant calculation",
                provider="the treasury team"),
        ),
        extra_caveats=applicability.caveats))


DETECTORS = {
    "concentration_related_party": detect_related_party_concentration,
}
