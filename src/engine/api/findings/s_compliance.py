"""S-TAX / COMPLI — the statutory checks, and the article they cite.

Two things live here.

1. :data:`RO_STATUTES` — the pack's statutory citation table. A
   compliance finding that does not name the article it rests on is an
   opinion; naming it is what lets an administrator hand the page to
   counsel. ``s_solvency`` imports the art. 153^24 entry for the
   equity-floor finding, so the citation exists once and is quoted from
   one place.

2. ``cash_dividends_declared_unpaid`` — a declared dividend is a
   CREDITOR of the company under art. 67 alin. (2) of Legea 31/1990,
   ranking ahead of the shareholder who voted it, and it carries a
   statutory payment deadline with penalty interest behind it. The rule
   the baseline shipped said the company "could service this if
   distribution is planned"; this one prices the settlement.

WHY THE THRESHOLD PRINTS AS A MULTIPLE
The table's parameter is an absolute money floor. A money limit cannot
be rendered: it is nobody's cited fact, so ``templatize`` cannot bind
it, and the finding would demote for a rendering reason rather than a
substantive one (see ``_base.normalised_threshold``). The floor is
therefore printed as a multiple of itself — the identical decision — and
its exact currency amount travels on the payload in
``ComparisonBasis.basis_value``.

WHAT IS NOT HERE
No VAT, payroll-tax or corporate-tax reconciliation. The pack declares
no such detector and the assembled views carry no tax base to run one
against; ``s_coherence`` records the same absence for the coherence
checks that depend on it. An empty statutory section is the honest
answer to "we cannot see the tax ledger", and it is a different answer
from a green tick.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from .. import _finding as F
from . import _base


@dataclass(frozen=True)
class Statute:
    """One citable provision. `duty` is written to be readable inside an
    action step — it names what the company must DO, not what the law
    says in the abstract."""

    citation: str
    subject: str
    duty: str
    deadline: str


#: RO statutory provisions this package cites. Pack data held as a
#: module constant rather than in `profiles.yaml`, which is owned by the
#: contract lane; the natural home is the country pack, and a test in
#: `tests/engine/test_findings_single_period.py` asserts every citation
#: reaches the prose of the finding that claims it.
RO_STATUTES = {
    "equity_floor": Statute(
        citation="art. 153^24 of Legea 31/1990",
        subject="net assets fallen below half of the registered share capital",
        duty="convene the general meeting to decide on recapitalisation, "
             "reduction of the registered capital, or dissolution",
        deadline="at the latest when these annual accounts are approved",
    ),
    "dividend_payment": Statute(
        citation="art. 67 alin. (2) of Legea 31/1990",
        subject="a dividend declared by the general meeting but not yet paid",
        duty="pay the declared dividend within the term the general meeting "
             "set, and carry statutory penalty interest on any delay beyond it",
        deadline="no later than six months from the approval of the annual "
                 "financial statements",
    ),
}  # type: Dict[str, Statute]


# ── cash_dividends_declared_unpaid ───────────────────────────────────────

_DIVIDEND_SUBJECT = (
    F.Account("457", "Dividende de plată", "BS"),
    F.Account("117", "Rezultatul reportat", "BS"),
)


def detect_dividends_declared_unpaid(ctx: _base.Ctx) -> _base.Outcome:
    did = "cash_dividends_declared_unpaid"
    applicability = ctx.applies(did)
    if not applicability.applies:
        return _base.quiet(ctx.skipped(did, applicability.reason))

    statute = RO_STATUTES["dividend_payment"]
    r = ctx.reader
    declared = r.value("ap_dividends")
    cash = r.view("bs", "cash")
    current_liabilities = r.view("bs", "total_current_liabilities")
    operating = r.view("cf", "cash_from_operating")
    spec = ctx.threshold_spec(did, "min_amount")
    if declared is None:
        return _base.quiet(ctx.skipped(
            did, "the period carries no account 457 dividend-payable line"))

    element = _base.normalised_threshold(spec, ">", declared)
    if element is None:
        return _base.quiet(ctx.skipped(
            did, "the pack's dividend materiality floor is zero, so the "
                 "declared balance cannot be expressed as a multiple of it"))
    if not element.holds():
        return _base.quiet(ctx.not_fired(
            did, spec, ">", declared, F.UNIT_MONEY,
            note="no material dividend is declared and unpaid at the "
                 "balance-sheet date"))
    if cash is None or current_liabilities is None or operating is None:
        return _base.quiet(ctx.skipped(
            did, "cash, current liabilities or operating cash flow is absent, "
                 "so the liquidity cost of settling the dividend cannot be "
                 "recomputed"))

    bag = (_base.Bag()
           .money("dividends_payable", declared,
                  "dividend declared and unpaid on account 457")
           .money("cash", cash, "cash and bank balances")
           .money("cash_from_operating", operating,
                  "cash generated by operations")
           .money("cur_liab", current_liabilities, "current liabilities")
           .ratio("dividend_floor_multiple_x", element.observed,
                  "declared dividend as a multiple of the materiality floor"))

    impact = _base.ratio_impact_or_none(
        "cash_ratio_after_settling_the_dividend",
        "Cash cover of current liabilities, before and after the declared "
        "dividend is paid",
        numerator=r.q(cash, "cash"),
        denominator=r.q(current_liabilities, "cur_liab"),
        adjusted_numerator=r.q(cash - declared, "cash_after_dividend"),
        adjusted_denominator=r.q(current_liabilities - declared,
                                 "cur_liab_after_dividend"),
        unit=F.UNIT_RATIO)

    # Deterministic severity: the dividend is either fundable from the
    # cash on hand or it is not. Nothing is inferred about intent.
    severity = "high" if cash < declared else "medium"

    return _base.found(_base.build_finding(
        ctx, did, severity, _DIVIDEND_SUBJECT,
        scope="Dividend declared and unpaid on 457",
        bag=bag,
        comparison=F.ComparisonBasis(
            kind="regulatory",
            description="the balance is measured against the pack's "
                        "declared-dividend materiality floor, expressed as a "
                        "multiple of that floor so both sides print in the same "
                        "units; the payment duty itself comes from "
                        + statute.citation,
            basis_value=float(spec.value), basis_unit=F.UNIT_MONEY),
        threshold_element=element,
        impact=impact,
        steps=(
            F.ActionStep(
                imperative="Diarise the payment deadline under "
                           + statute.citation
                           + " against the date these accounts are approved",
                artefact="dividend payment schedule keyed to the approval date, "
                         "with the statutory penalty interest rate stated",
                provider="the company secretary",
                horizon=statute.deadline),
            F.ActionStep(
                imperative="Confirm the cash forecast funds the 457 balance "
                           "before that date",
                artefact="13-week cash forecast covering the dividend "
                         "settlement in full",
                provider="the treasury team"),
        ),
        extra_caveats=applicability.caveats))


DETECTORS = {
    "cash_dividends_declared_unpaid": detect_dividends_declared_unpaid,
}
