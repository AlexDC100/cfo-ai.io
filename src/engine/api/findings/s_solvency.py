"""S-SOLVENCY — can this company carry what it owes, and is its equity
still legal?

  leverage_debt_to_ebitda      gross debt against the earnings that
                               refinance it
  leverage_net_debt_ebitda     the same test with the cash applied, and
                               with one year of free cash flow applied
                               on top
  equity_below_half_capital    net assets against the statutory floor in
                               art. 153^24 of Legea 31/1990

WHY THE LEVERAGE IMPACTS ARE HEADROOMS AND NOT RECOMPUTATIONS
A leverage multiple is already the recomputation — restating it against
the cash balance IS the net-debt detector, and printing that as the
gross detector's "impact" would make the two findings say the same
thing twice. So the gross-debt finding states its distance from the
OTHER band: a finding that fired on the covenant alarm shows how far
past the comfort ceiling it sits, and a finding that fired on the
comfort ceiling shows how much room is left before the alarm. Every
number in that sentence comes from the table.

The net-debt finding does recompute, because there is a genuine second
state to compute: leverage after a year of the company's own free cash
flow is applied to the debt. No assumed growth, no assumed refinancing —
one period's actual cash, applied once.

THE STATUTORY FLOOR
``equity_below_half_capital`` is a compliance rule with a deadline
attached, so its citation comes from ``s_compliance.RO_STATUTES``
rather than being retyped here. Its impact is the REMEDY priced: the
equity ratio the company would report once net assets are restored to
the floor the article names.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from .. import _finding as F
from . import _base
from .s_compliance import RO_STATUTES

_DEBT_SUBJECT = (
    F.Account("162", "Credite bancare pe termen lung", "BS"),
    F.Account("167", "Alte împrumuturi și datorii asimilate", "BS"),
    F.Account("519", "Credite bancare pe termen scurt", "BS"),
)

_NET_DEBT_SUBJECT = _DEBT_SUBJECT + (
    F.Account("5121", "Conturi la bănci în lei", "BS"),
)

_EQUITY_SUBJECT = (
    F.Account("101", "Capital social", "BS"),
    F.Account("117", "Rezultatul reportat", "BS"),
    F.Account("121", "Profit sau pierdere", "BS"),
)

_LEVERAGE_BANDS = (
    _base.Band("critical", "critical"),
    _base.Band("high", "high"),
)


def _counterpart(band_parameter: str) -> str:
    """The band a leverage finding measures its headroom against — the
    one it did NOT cite as its threshold, so the impact adds a number
    instead of repeating one."""
    return "high" if band_parameter == "critical" else "critical"


# ── leverage_debt_to_ebitda ──────────────────────────────────────────────


def detect_debt_to_ebitda(ctx: _base.Ctx) -> _base.Outcome:
    did = "leverage_debt_to_ebitda"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    debt = r.view("bs", "total_debt")
    ebitda = r.view("pl", "ebitda_statutory")
    if debt is None or ebitda is None:
        return _base.quiet(ctx.skipped(
            did, "the period carries no debt total or no statutory EBITDA line"))
    if ebitda <= 0:
        return _base.quiet(ctx.skipped(
            did, "statutory EBITDA is not positive, so an earnings multiple has "
                 "no denominator — the EBITDA finding carries this period "
                 "instead"))
    if debt <= 0:
        return _base.quiet(ctx.skipped(
            did, "no drawn bank debt is recorded at the balance-sheet date"))

    observed = _base.share(r, debt, ebitda, "bank_debt_total", "ebitda_statutory")
    if observed is None:
        return _base.quiet(ctx.skipped(did, "the leverage multiple is undefined"))
    hit = _base.fired_band(ctx.profile, did, _LEVERAGE_BANDS, observed, ">")
    if hit is None:
        spec = ctx.threshold_spec(did, "high")
        return _base.quiet(ctx.not_fired(
            did, spec, ">", observed, F.UNIT_RATIO,
            note="gross leverage sits inside the comfort ceiling this profile "
                 "is graded on"))
    band, spec = hit
    cash = r.view("bs", "cash")

    bag = (_base.Bag()
           .money("bank_debt_total", debt, "drawn bank debt")
           .money("ebitda_statutory", ebitda, "statutory EBITDA")
           .ratio("debt_to_ebitda", observed, "gross leverage multiple"))

    # The recomputation a reader actually wants next: what the cash on
    # the balance sheet does to the multiple. It is the first step a
    # credit committee takes, and it chains into the net-debt finding
    # (which then applies a period of free cash flow on top) rather than
    # repeating it.
    impact = None
    if cash is not None and cash != 0:
        impact = _base.ratio_impact_or_none(
            "debt_to_ebitda_after_applying_cash",
            "Gross leverage, as drawn versus after the cash balance is applied",
            numerator=r.q(debt, "bank_debt_total"),
            denominator=r.q(ebitda, "ebitda_statutory"),
            adjusted_numerator=r.q(debt - cash, "net_debt"),
            unit=F.UNIT_RATIO)
    if impact is None:
        # No cash to apply. Fall back to the distance from the band this
        # finding did NOT cite, so the impact still adds a number from
        # the table rather than repeating the threshold.
        counterpart = ctx.threshold_spec(did, _counterpart(band.parameter))
        label = ("Gross leverage measured against the comfort ceiling"
                 if counterpart.parameter == "high"
                 else "Gross leverage measured against the covenant alarm")
        impact = _base.headroom_impact_or_none(
            "debt_to_ebitda_vs_" + counterpart.parameter, label,
            observed=observed, limit=float(counterpart.value))

    return _base.found(_base.build_finding(
        ctx, did, band.severity, _DEBT_SUBJECT,
        scope="Drawn bank debt on 162 / 167 / 519 against statutory EBITDA",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="profile_threshold",
            description="the multiple is the company's own drawn debt over its "
                        "own statutory EBITDA, judged against the ceiling this "
                        "structural profile is graded on",
            basis_value=float(spec.value), basis_unit=F.UNIT_RATIO),
        threshold_element=_base.threshold(spec, ">", observed, F.UNIT_RATIO),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Draft the covenant certificate on this period's "
                           "figures before the testing date",
                artefact="covenant compliance certificate with the leverage "
                         "calculation shown",
                provider="the treasury team",
                horizon="before the next testing date"),
            F.ActionStep(
                imperative="Refinance the facilities maturing inside twelve "
                           "months",
                artefact="refinancing term sheet or a written extension of the "
                         "existing facility",
                provider="the relationship bank"),
        ),
        extra_caveats=applicability.caveats))


# ── leverage_net_debt_ebitda ─────────────────────────────────────────────


def detect_net_debt_to_ebitda(ctx: _base.Ctx) -> _base.Outcome:
    did = "leverage_net_debt_ebitda"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    r = ctx.reader
    debt = r.view("bs", "total_debt")
    cash = r.view("bs", "cash")
    ebitda = r.view("pl", "ebitda_statutory")
    free_cash_flow = r.view("cf", "free_cash_flow")
    if debt is None or cash is None or ebitda is None:
        return _base.quiet(ctx.skipped(
            did, "the period carries no debt total, no cash line or no "
                 "statutory EBITDA line"))
    if ebitda <= 0:
        return _base.quiet(ctx.skipped(
            did, "statutory EBITDA is not positive, so a net leverage multiple "
                 "has no denominator"))

    net_debt = debt - cash
    observed = _base.share(r, net_debt, ebitda, "net_debt", "ebitda_statutory")
    if observed is None:
        return _base.quiet(ctx.skipped(did, "the net leverage multiple is "
                                            "undefined"))
    hit = _base.fired_band(ctx.profile, did, _LEVERAGE_BANDS, observed, ">")
    if hit is None:
        spec = ctx.threshold_spec(did, "high")
        return _base.quiet(ctx.not_fired(
            did, spec, ">", observed, F.UNIT_RATIO,
            note="net leverage sits inside the comfort ceiling this profile is "
                 "graded on"))
    band, spec = hit
    if free_cash_flow is None:
        return _base.quiet(ctx.skipped(
            did, "the cash-flow view carries no free-cash-flow line, so the "
                 "deleveraging one period of cash would buy cannot be "
                 "recomputed"))

    bag = (_base.Bag()
           .money("net_debt", net_debt, "net debt after applying cash")
           .money("cash", cash, "cash applied against the debt")
           .money("ebitda_statutory", ebitda, "statutory EBITDA")
           .ratio("net_debt_ebitda", observed, "net leverage multiple"))

    impact = _base.ratio_impact_or_none(
        "net_debt_ebitda_after_one_period_of_free_cash_flow",
        "Net leverage, today versus after one period of free cash flow is "
        "applied to the debt",
        numerator=r.q(net_debt, "net_debt"),
        denominator=r.q(ebitda, "ebitda_statutory"),
        adjusted_numerator=r.q(net_debt - free_cash_flow,
                               "net_debt_after_free_cash_flow"),
        unit=F.UNIT_RATIO)

    return _base.found(_base.build_finding(
        ctx, did, band.severity, _NET_DEBT_SUBJECT,
        scope="Net debt on 162 / 167 / 519 after cash, against statutory EBITDA",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="profile_threshold",
            description="net debt is the company's own drawn debt less its own "
                        "cash, judged against the net-leverage ceiling this "
                        "structural profile is graded on",
            basis_value=float(spec.value), basis_unit=F.UNIT_RATIO),
        threshold_element=_base.threshold(spec, ">", observed, F.UNIT_RATIO),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Repay the revolver down to the comfort ceiling with "
                           "the free cash flow this period produced",
                artefact="debt amortisation plan tied to the rolling cash "
                         "forecast",
                provider="the treasury team"),
            F.ActionStep(
                imperative="Agree a covenant reset with the lender before the "
                           "next test",
                artefact="amendment letter or waiver covering the testing dates "
                         "in the next twelve months",
                provider="the relationship bank"),
        ),
        extra_caveats=applicability.caveats))


# ── equity_below_half_capital ────────────────────────────────────────────


def detect_equity_below_half_capital(ctx: _base.Ctx) -> _base.Outcome:
    did = "equity_below_half_capital"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    statute = RO_STATUTES["equity_floor"]
    r = ctx.reader
    total_equity = r.view("bs", "total_equity")
    share_capital = r.view("bs", "share_capital")
    total_assets = r.view("bs", "total_assets")
    spec = ctx.threshold_spec(did, "equity_to_capital_max")
    if total_equity is None or share_capital is None:
        return _base.quiet(ctx.skipped(
            did, "the period carries no equity total or no registered share "
                 "capital line"))
    if share_capital <= 0:
        return _base.quiet(ctx.skipped(
            did, "no registered share capital is recorded, so the statutory "
                 "floor has no base"))

    observed = _base.share(r, total_equity, share_capital,
                           "total_equity", "share_capital")
    if observed is None:
        return _base.quiet(ctx.skipped(
            did, "the equity-to-capital cover is undefined"))
    if observed >= spec.value:
        return _base.quiet(ctx.not_fired(
            did, spec, "<", observed, F.UNIT_RATIO,
            note="net assets are above the statutory floor in "
                 + statute.citation))
    if total_assets is None or total_assets <= 0:
        return _base.quiet(ctx.skipped(
            did, "total assets are absent or not positive, so the equity ratio "
                 "after the statutory restoration cannot be recomputed"))

    bag = (_base.Bag()
           .money("total_equity", total_equity, "net assets")
           .money("share_capital", share_capital, "registered share capital")
           .money("total_assets", total_assets, "total assets")
           .ratio("equity_to_capital_ratio", observed,
                  "net assets as a cover of registered capital"))

    # The impact prices the REMEDY the article names: what the equity
    # ratio becomes once net assets are restored to the statutory floor.
    impact = _base.ratio_impact_or_none(
        "equity_ratio_after_statutory_restoration",
        "Equity ratio, as reported versus with net assets restored to the "
        "statutory floor",
        numerator=r.q(total_equity, "total_equity"),
        denominator=r.q(total_assets, "total_assets"),
        adjusted_numerator=r.q(share_capital * float(spec.value),
                               "equity_at_statutory_floor"),
        unit=F.UNIT_PERCENT)

    # Deterministic severity: negative net assets is a different statement
    # from thin net assets, and the article treats it as one.
    severity = "critical" if total_equity < 0 else "high"

    return _base.found(_base.build_finding(
        ctx, did, severity, _EQUITY_SUBJECT,
        scope="Net assets on 101 / 117 / 121 against registered capital",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="regulatory",
            description="net assets are measured against the company's own "
                        "registered share capital, against the floor in "
                        + statute.citation,
            basis_value=share_capital, basis_unit=F.UNIT_MONEY),
        threshold_element=_base.threshold(spec, "<", observed, F.UNIT_RATIO),
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Convene the general meeting to " + statute.duty,
                artefact="convening notice and the administrator's report under "
                         + statute.citation,
                provider="the administrator",
                horizon=statute.deadline),
            F.ActionStep(
                imperative="File the resulting resolution with the trade "
                           "registry",
                artefact="ONRC filing of the general-meeting resolution",
                provider="the company's legal counsel"),
        ),
        extra_caveats=applicability.caveats))


DETECTORS = {
    "leverage_debt_to_ebitda": detect_debt_to_ebitda,
    "leverage_net_debt_ebitda": detect_net_debt_to_ebitda,
    "equity_below_half_capital": detect_equity_below_half_capital,
}
