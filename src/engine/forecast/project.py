"""THE ROLL-FORWARD. P&L -> balance sheet -> cash flow, linked, closing.

WHAT MAKES THIS DIFFERENT FROM A GROWTH SPREADSHEET
===================================================
Anyone can grow revenue 15%. Almost nobody produces a projected balance
sheet that balances. This one does, and the guarantee is structural
rather than tolerated:

  1. Every amount is an integer number of cents (see ``money.py``), so
     there is no floating-point residual to absorb.
  2. Cash is the BALANCING ITEM, computed as the articulation of the
     cash-flow statement, which is itself the exact articulation of the
     balance-sheet movements:

         Δcash = CFO + CFI + CFF
         CFO   = net income + depreciation + amortisation
                 − Δreceivables − Δinventory + Δpayables
         CFI   = − capital expenditure − intangible additions
         CFF   = net debt movement + funding-line movement − dividends

     Substituting the roll-forwards (PP&E closes at opening + capex −
     depreciation; equity at opening + net income − dividends) reduces
     Δassets − Δ(equity + liabilities) to zero identically. Every term
     cancels a term. Nothing is plugged.
  3. The result is CHECKED anyway, every period, and a non-zero
     difference raises :class:`~engine.forecast.errors.BalanceViolation`
     — the projection is refused, naming the period and the amount.
     A year that does not balance is a hard error, not a rounding note.

THE FUNDING LINE (F8)
=====================
Cash never silently goes negative. When the period's articulated cash
falls below the stated floor, a named ``revolver`` liability draws
exactly the shortfall, appears on the projected balance sheet, and is
priced at ``revolver_rate``. Interest is charged on the balance at the
START of the period, which is what breaks the circularity between "how
much do we need to draw" and "how much does the draw cost" without an
iterative solve — and therefore without a solver whose convergence
tolerance would put a residual back into the statement.

DETERMINISM (F3)
================
No clock is read (the calendar is anchored to the book's own period
end). No ``hash()``, no ``set`` iteration reaches output; every mapping
rendered out is ordered by an explicit, declared sequence. The same
book and the same assumptions therefore produce byte-identical output
across processes.

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

from datetime import date
from fractions import Fraction
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .assumptions import (AssumptionSet, BookContext, NoStatutoryTaxRate,
                          derive_assumptions)
from .pools import (FIXED_SHARE_PREFIX, LEVEL_PREFIX, TEMPLATE_FIXED_SHARE,
                    TEMPLATE_LEVEL, split_pools)
from .errors import AssumptionError, BalanceViolation
from .history import PlHistory, pl_history_from_payload
from .levers_pack import tax_conventions
from .money import MICRO, MICRO_DAY, apply_rate, fmt, mul_div, to_float
from .opening import (ASSET_LINES, CURRENT_ASSET_LINES,
                      CURRENT_LIABILITY_LINES, EL_LINES, EQUITY_LINES, LINES,
                      OpeningPosition)
from .timeline import Period, build_timeline

__all__ = ["CompiledPlan", "ProjectedPeriod", "Projection", "ShortfallRefusal",
           "WC_BALANCES", "assumptions_for_payload", "context_for_payload",
           "project", "project_payload"]

#: P&L line order — declared once, so every render and every serialization
#: emits the same sequence (F3: no dict-ordering accident reaches output).
PL_LINES = (
    "revenue",
    "cost_of_sales",
    "operating_costs",
    "other_operating_income",
    "ebitda",
    "depreciation",
    "amortisation",
    "ebit",
    "interest_expense_debt",
    "interest_expense_funding_line",
    "interest_income",
    "other_financial_income",
    "other_financial_expense",
    "pretax_result",
    "income_tax",
    "net_income",
)

#: Cash-flow line order.
CF_LINES = (
    "net_income",
    "depreciation",
    "amortisation",
    "change_in_receivables",
    "change_in_inventory",
    "change_in_payables",
    "cash_from_operating",
    "capital_expenditure",
    "intangible_additions",
    "cash_from_investing",
    "debt_drawdowns",
    "debt_repayments",
    "dividends_paid",
    "funding_line_movement",
    "cash_from_financing",
    "net_change_in_cash",
    "opening_cash",
    "closing_cash",
)


#: The two tax conventions (plan_contract_v2 6.3), read from
#: packs/forecast/levers.yaml#tax — pack data, never prose typed here
#: (TC-10). One authority serves both the notes below and the fp1
#: conventions, so the sentence on the face of the plan and the sentence
#: beside a tax figure cannot disagree.
_TAX_CONVENTIONS = tax_conventions()

#: What the model itself does that a reader would otherwise have to
#: reverse-engineer from the arithmetic. These are the model's
#: conventions, not the book's facts, so they are rendered on the face of
#: every projection alongside the drivers that could not be measured.
MODEL_CONVENTIONS = tuple(c.sentence for c in _TAX_CONVENTIONS) + (
    "interest is charged and paid in the period it accrues, on the "
    "balance at the START of that period. Charging on the opening "
    "balance is what lets the funding line be sized in one pass instead "
    "of by an iterative solve, whose convergence tolerance would put a "
    "residual back into a balance sheet that is required to close "
    "exactly.",
    "balance-sheet lines with no driver (other receivables and payables, "
    "prepayments, deferred income, provisions, contributed capital and "
    "reserves) are HELD at their opening balance. They neither grow with "
    "the business nor decay.",
    "depreciation is capped at the net book value actually available, and "
    "the capped figure is the one that reaches the profit and loss "
    "account, the cash-flow add-back and the roll-forward alike.",
    "other operating income is HELD at the source period's own annual "
    "amount, spread across each plan year by days: it scales with "
    "neither volume, growth nor inflation, and is treated as CASH in the "
    "period it arises. Where the source figure contains provision "
    "reversals, this model turns a non-cash credit into projected cash; "
    "the amount at stake is stated beside this note when the book "
    "discloses it.",
    "cost of sales and operating costs are POOLS split from the anchor's "
    "line items: cost of sales follows volume in full; each operating "
    "cost pool splits into a fixed part that follows inflation and a "
    "variable part that follows revenue growth, so at neutral growth and "
    "inflation the pools reproduce the anchor's own costs to the cent.",
    "financial income and expense other than interest are HELD at the "
    "source period's own annual amounts and repeated every year. Nothing "
    "in a trial balance says foreign-exchange movement or income from "
    "holdings scales with trading, so none of it is grown with revenue — "
    "and none of it is dropped either.",
)


#: THE MODEL CONVENTIONS THAT PRODUCE A FIGURE, declared as assumptions.
#:
#: fp1 requires every projected figure to name the assumption that made
#: it. Most name a numeric driver. A HELD line names none of them — and
#: "held at the opening balance" is not an absence of an assumption, it
#: is a strong, falsifiable claim ("other receivables at 2028-12-31 will
#: be exactly what they were at 2025-12-31") produced by a decision this
#: model made. It gets an id, a basis and a place in the served driver
#: list like every other reason a number has.
#:
#: They carry the fp1 unit ``convention``: a stated rule with no
#: quantity. That unit exists precisely so a word is never dressed as a
#: number — the alternative considered was a `held_line_growth` ratio
#: pinned at 0%, and it was rejected because a non-zero value would grow
#: the two sides of the balance sheet by different amounts and break the
#: close. A knob that must never be turned is not a driver.
FP1_CONVENTIONS = (
    ("held_at_opening_balance",
     "balance-sheet lines this model does not drive are HELD at their "
     "opening balance: they neither grow with the business nor decay. "
     "Nothing in a single trial balance implies a rate at which they "
     "move, and inventing one would move a total no assumption stated."),
    ("interest_charged_on_opening_balance",
     "interest is charged and paid in the period it accrues, on the "
     "balance at the START of that period — which is what lets the "
     "funding line be sized in one pass instead of by an iterative "
     "solve whose convergence tolerance would leave a residual in a "
     "balance sheet required to close exactly."),
) + tuple((c.convention_id, c.sentence) for c in _TAX_CONVENTIONS)

#: line id -> the drivers and conventions that produced it.
#:
#: Composed rather than transcribed. An aggregate's attribution is the
#: UNION of its inputs', computed here from the same decomposition the
#: arithmetic below uses, so the two cannot drift: change what feeds
#: EBITDA and this map changes with it. A hand-written list would have
#: been correct on the day it was written and wrong on the next one.
#: plan/2 B5 (28.3 B5): the three index drivers join the attribution that
#: project_plan reads for driver_ids and consumed_by. The fp1 VIEW drops
#: them (FP1_DROPPED_IDS), so GET serves the B4 ids until B6 deletes fp1.
INDEX_KEYS = ("volume_index", "price_index", "input_price_index")
FP1_DROPPED_IDS = INDEX_KEYS
_REVENUE = ("revenue_growth", "volume_index", "price_index")
#: plan/2 B4b (contract 5, 3a.2): cost of sales is the cost_of_sales POOL
#: (its fixed share, nil by convention unless overridden, and revenue
#: growth); operating costs are the opex pools — each pool's fixed share
#: and level, revenue growth on the variable parts, inflation on the fixed
#: parts. The two template ids expand per book, over the SERVED opex
#: pools, in Projection.line_assumptions(); other operating income is
#: HELD at the anchor's own amount (5.5) and names only that driver.
_COGS = _REVENUE + (FIXED_SHARE_PREFIX + "cost_of_sales", "input_price_index")
_OPEX = _REVENUE + ("inflation", TEMPLATE_FIXED_SHARE, TEMPLATE_LEVEL)
_OOI = ("other_operating_income_annual",)
_EBITDA = _REVENUE + _COGS + _OPEX + _OOI
_CAPEX = _REVENUE + ("capex_pct_of_revenue",)
_INTANGIBLE_ADD = _REVENUE + ("intangible_additions_pct_of_revenue",)
_DEPRECIATION = _CAPEX + ("depreciation_rate", "days_basis")
_AMORTISATION = _INTANGIBLE_ADD + ("depreciation_rate", "days_basis")
_EBIT = _EBITDA + _DEPRECIATION + _AMORTISATION
_INT_DEBT = ("interest_rate_debt", "days_basis",
             "interest_charged_on_opening_balance")
_INT_FUNDING = ("revolver_rate", "days_basis", "min_cash",
                "interest_charged_on_opening_balance")
_INT_INCOME = ("interest_income_rate", "interest_income_annual",
               "days_basis", "interest_charged_on_opening_balance")
_OTHER_FIN_INC = ("other_financial_income_annual",)
_OTHER_FIN_EXP = ("other_financial_expense_annual",)
_PRETAX = (_EBIT + _INT_DEBT + _INT_FUNDING + _INT_INCOME
           + _OTHER_FIN_INC + _OTHER_FIN_EXP)
_TAX = _PRETAX + ("tax_rate", "tax_accrued_year_to_date",
                  "tax_no_loss_carry_forward")
_NET_INCOME = _PRETAX + _TAX
_AR = _REVENUE + ("dso_days", "days_basis")
_INVENTORY = _COGS + ("dio_cogs_days", "days_basis")
_AP = _COGS + ("dpo_cogs_days", "days_basis")
_DIVIDENDS = _NET_INCOME + ("dividend_payout_pct",)
_FUNDING = ("min_cash", "revolver_rate")
_HELD = ("held_at_opening_balance",)
#: Everything that can move cash. The closing cash balance is the result
#: of the whole model, and saying so is more honest than naming the three
#: drivers nearest to it.
_CASH = (_NET_INCOME + _DEPRECIATION + _AMORTISATION + _AR + _INVENTORY
         + _AP + _CAPEX + _INTANGIBLE_ADD + _DIVIDENDS + _FUNDING)


def _u(*groups):
    """The union, in first-seen order — deterministic without a sort, and
    reading in the order the arithmetic reaches them."""
    out = []
    for group in groups:
        for key in group:
            if key not in out:
                out.append(key)
    return tuple(out)


LINE_ASSUMPTIONS = {
    "pl.revenue": _u(_REVENUE),
    "pl.cost_of_sales": _u(_COGS),
    "pl.operating_costs": _u(_OPEX),
    "pl.other_operating_income": _u(_OOI),
    "pl.ebitda": _u(_EBITDA),
    "pl.depreciation": _u(_DEPRECIATION),
    "pl.amortisation": _u(_AMORTISATION),
    "pl.ebit": _u(_EBIT),
    "pl.interest_expense_debt": _u(_INT_DEBT),
    # The funding-line charge is priced on the OPENING revolver balance,
    # and that balance is the running shortfall of everything that moves
    # cash — so it is attributed like bs.revolver itself. Attributed to its
    # rate alone until plan/2 B3, where the base parity gate measured it
    # moving with revenue growth outside its own static closure.
    "pl.interest_expense_funding_line": _u(_INT_FUNDING, _CASH),
    "pl.interest_income": _u(_INT_INCOME),
    "pl.other_financial_income": _u(_OTHER_FIN_INC),
    "pl.other_financial_expense": _u(_OTHER_FIN_EXP),
    "pl.pretax_result": _u(_PRETAX),
    "pl.income_tax": _u(_TAX),
    "pl.net_income": _u(_NET_INCOME),

    "bs.cash": _u(_CASH),
    "bs.ar": _u(_AR),
    "bs.inventory": _u(_INVENTORY),
    "bs.other_current_assets": _u(_HELD),
    "bs.ppe_net": _u(_CAPEX, _DEPRECIATION),
    "bs.intangibles_net": _u(_INTANGIBLE_ADD, _AMORTISATION),
    "bs.investment_property": _u(_HELD),
    "bs.other_non_current_assets": _u(_HELD),
    "bs.ap": _u(_AP),
    "bs.other_current_liabilities": _u(_HELD),
    # The debt schedule is a PLAN the caller supplies, not a rate; it is
    # named through the rate that prices it and the convention that says
    # when the charge lands.
    "bs.st_debt": _u(_INT_DEBT),
    "bs.lt_debt": _u(_INT_DEBT),
    "bs.revolver": _u(_FUNDING, _CASH),
    "bs.other_non_current_liabilities": _u(_HELD),
    "bs.equity_contributed": _u(_HELD),
    "bs.equity_reserves": _u(_HELD),
    "bs.equity_retained": _u(_NET_INCOME, _DIVIDENDS),
    "bs.equity_other": _u(_HELD),

    "cf.net_income": _u(_NET_INCOME),
    "cf.depreciation": _u(_DEPRECIATION),
    "cf.amortisation": _u(_AMORTISATION),
    "cf.change_in_receivables": _u(_AR),
    "cf.change_in_inventory": _u(_INVENTORY),
    "cf.change_in_payables": _u(_AP),
    "cf.cash_from_operating": _u(_NET_INCOME, _DEPRECIATION, _AMORTISATION,
                                 _AR, _INVENTORY, _AP),
    "cf.capital_expenditure": _u(_CAPEX),
    "cf.intangible_additions": _u(_INTANGIBLE_ADD),
    "cf.cash_from_investing": _u(_CAPEX, _INTANGIBLE_ADD),
    "cf.debt_drawdowns": _u(_INT_DEBT),
    "cf.debt_repayments": _u(_INT_DEBT),
    "cf.dividends_paid": _u(_DIVIDENDS),
    "cf.funding_line_movement": _u(_FUNDING, _CASH),
    "cf.cash_from_financing": _u(_INT_DEBT, _DIVIDENDS, _FUNDING, _CASH),
    "cf.net_change_in_cash": _u(_CASH),
    "cf.opening_cash": _u(_CASH),
    "cf.closing_cash": _u(_CASH),

    "bs_totals.assets": _u(_CASH, _AR, _INVENTORY, _CAPEX, _DEPRECIATION,
                           _INTANGIBLE_ADD, _AMORTISATION, _HELD),
    "bs_totals.current_assets": _u(_CASH, _AR, _INVENTORY, _HELD),
    "bs_totals.current_liabilities": _u(_AP, _INT_DEBT, _FUNDING, _HELD),
    "bs_totals.equity": _u(_NET_INCOME, _DIVIDENDS, _HELD),
    "bs_totals.equity_plus_liabilities": _u(_AP, _INT_DEBT, _FUNDING,
                                            _NET_INCOME, _DIVIDENDS, _HELD),
}


def is_pool_id(assumption_id: str) -> bool:
    """A pool template id or one of its per-book expansions (3a.2)."""
    return (assumption_id in (TEMPLATE_FIXED_SHARE, TEMPLATE_LEVEL)
            or assumption_id.startswith(FIXED_SHARE_PREFIX)
            or assumption_id.startswith(LEVEL_PREFIX))


def expand_line_assumptions(assumptions: "AssumptionSet",
                            fp1_view: bool = True) -> Dict[str, List[str]]:
    """``fp1_view`` (the default, what ``as_dict`` serves) drops
    FP1_DROPPED_IDS; ``project_plan`` reads the full attribution with
    ``fp1_view=False``.

    LINE_ASSUMPTIONS with the two pool templates expanded over the
    book's SERVED opex pools (pool_fixed_share.* -> the opex pools' fixed
    shares; pool_level.* -> their levels), in served order. The
    cost_of_sales pool is named literally where it applies."""
    pools = assumptions.pools
    if pools is None:
        fixed = tuple(k for k in assumptions.pool_keys()
                      if k.startswith(FIXED_SHARE_PREFIX) and k != FIXED_SHARE_PREFIX + "cost_of_sales")
        level = tuple(k for k in assumptions.pool_keys() if k.startswith(LEVEL_PREFIX))
    else:
        fixed = tuple(FIXED_SHARE_PREFIX + p.name for p in pools.opex)
        level = pools.level_keys()
    out = {}  # type: Dict[str, List[str]]
    for line, ids in LINE_ASSUMPTIONS.items():
        expanded = []  # type: List[str]
        for aid in ids:
            if aid == TEMPLATE_FIXED_SHARE:
                expanded.extend(fixed)
            elif aid == TEMPLATE_LEVEL:
                expanded.extend(level)
            elif fp1_view and aid in FP1_DROPPED_IDS:
                continue
            else:
                expanded.append(aid)
        seen = set()  # type: set
        out[line] = [i for i in expanded if not (i in seen or seen.add(i))]
    return out


def _round(value: Fraction) -> int:
    """An exact rational rounded ONCE to the minor unit, half away from
    zero (contract 5.3)."""
    return mul_div(value.numerator, 1, value.denominator)


def _assert_attribution_covers_every_line():
    """Every emitted line names at least one reason, and every reason is
    a driver or a convention that actually exists.

    At IMPORT, not in a test: a line added to `PL_LINES` without an entry
    here would otherwise reach `fp1_from_forecast_v1`, arrive at the
    serving contract with no attribution, and take the WHOLE projection
    down with it — which is exactly how this map came to be written.
    """
    from .assumptions import KEYS
    known = (set(KEYS) | set(cid for cid, _basis in FP1_CONVENTIONS)
             | set(INDEX_KEYS))
    expected = set()
    for line in PL_LINES:
        expected.add("pl." + line)
    for line in LINES:
        expected.add("bs." + line)
    for line in CF_LINES:
        expected.add("cf." + line)
    for line in ("assets", "current_assets", "current_liabilities",
                 "equity", "equity_plus_liabilities"):
        expected.add("bs_totals." + line)
    missing = sorted(expected - set(LINE_ASSUMPTIONS))
    if missing:
        raise AssertionError(
            "these projected lines name no assumption and would refuse the "
            "whole projection at the fp1 contract: %s" % ", ".join(missing))
    extra = sorted(set(LINE_ASSUMPTIONS) - expected)
    if extra:
        raise AssertionError(
            "LINE_ASSUMPTIONS attributes lines this model does not "
            "project: %s" % ", ".join(extra))
    for line in sorted(LINE_ASSUMPTIONS):
        unknown = sorted(i for i in set(LINE_ASSUMPTIONS[line]) - known
                         if not is_pool_id(i))
        if unknown:
            raise AssertionError(
                "%s names %s, which is neither a driver nor a declared "
                "convention" % (line, ", ".join(unknown)))


_assert_attribution_covers_every_line()


def _period_charge(base_cents: int, annual_rate_micros: int, days: int,
                   days_basis: int) -> int:
    """An annual rate applied to a base for part of a year, rounded once."""
    if base_cents == 0 or annual_rate_micros == 0:
        return 0
    return mul_div(apply_rate(base_cents, annual_rate_micros), days, days_basis)


def _pct(rate_micros: int) -> str:
    """A rate rendered from the integer the model actually holds, for a
    refusal message. TC-10: the cutoff a message names is the cutoff the
    check used, never a number retyped into prose."""
    return "%.4f%%" % (int(rate_micros) / float(MICRO) * 100.0)


def _slice_by_days(total_cents: int, periods: Sequence[Period]) -> List[int]:
    """Split an annual amount across a year's periods by day count so the
    slices sum EXACTLY to the total. Cumulative rounding, not per-period
    rounding: the k-th slice is round(total * days<=k / days) minus the
    same for k-1, so the rounding errors telescope away."""
    total_days = sum(p.days for p in periods)
    if total_days <= 0:
        return [0 for _ in periods]
    out = []  # type: List[int]
    cumulative_days = 0
    previous = 0
    for period in periods:
        cumulative_days += period.days
        allocated = mul_div(total_cents, cumulative_days, total_days)
        out.append(allocated - previous)
        previous = allocated
    return out


#: Check keys, in render order. A ``_cents`` suffix means the in-memory
#: value is an integer number of cents.
CHECK_KEYS = (
    "balance_delta_cents",
    "cash_before_funding_line_cents",
    "funding_line_draw_cents",
    "funding_line_repay_cents",
    "funding_line_balance_cents",
    "cash_went_negative",
)


class ProjectedPeriod(object):
    """One projected period: the three statements and the checks."""

    __slots__ = ("period", "pl", "bs", "cf", "checks")

    def __init__(self, period: Period, pl: Dict[str, int], bs: Dict[str, int],
                 cf: Dict[str, int], checks: Dict[str, Any]) -> None:
        self.period = period
        self.pl = pl
        self.bs = bs
        self.cf = cf
        self.checks = checks

    @property
    def label(self) -> str:
        return self.period.label

    def total_assets_cents(self) -> int:
        return sum(self.bs[line] for line in ASSET_LINES)

    def total_el_cents(self) -> int:
        return sum(self.bs[line] for line in EL_LINES)

    def checks_as_units(self) -> Dict[str, Any]:
        """The checks with every ``*_cents`` key converted to currency
        units and renamed without the suffix — the serialization
        boundary, and the only place the two vocabularies meet."""
        out = {}  # type: Dict[str, Any]
        for key in CHECK_KEYS:
            value = self.checks[key]
            if key.endswith("_cents"):
                out[key[:-len("_cents")]] = to_float(value)
            else:
                out[key] = value
        return out

    def as_dict(self) -> Dict[str, Any]:
        return {
            "period": self.period.as_dict(),
            "pl": dict((k, to_float(self.pl[k])) for k in PL_LINES),
            "bs": dict((k, to_float(self.bs[k])) for k in LINES),
            "bs_totals": {
                "assets": to_float(self.total_assets_cents()),
                "equity_plus_liabilities": to_float(self.total_el_cents()),
                "current_assets": to_float(
                    sum(self.bs[l] for l in CURRENT_ASSET_LINES)),
                "current_liabilities": to_float(
                    sum(self.bs[l] for l in CURRENT_LIABILITY_LINES)),
                "equity": to_float(sum(self.bs[l] for l in EQUITY_LINES)),
            },
            "cf": dict((k, to_float(self.cf[k])) for k in CF_LINES),
            "checks": self.checks_as_units(),
        }


class Projection(object):
    """A finished, balanced, traceable projection."""

    __slots__ = ("opening", "assumptions", "periods", "history", "notes",
                 "timeline", "shortfall", "wc_targets", "work")

    def __init__(self, opening: OpeningPosition, assumptions: AssumptionSet,
                 periods: Tuple[ProjectedPeriod, ...], history: PlHistory,
                 notes: Tuple[str, ...],
                 timeline: Tuple[Period, ...] = (),
                 shortfall: "Optional[ShortfallRefusal]" = None,
                 wc_targets: Optional[Dict[Tuple[str, int], int]] = None,
                 work: Optional[Dict[str, int]] = None) -> None:
        self.opening = opening
        self.assumptions = assumptions
        self.periods = periods
        self.history = history
        self.notes = notes
        #: plan/2 B5. None of the four is serialised by :meth:`as_dict`, so
        #: the fp1 bytes are the B4 bytes (forecast-get-b4-parity).
        #: ``timeline`` is the full requested horizon (``periods`` stops
        #: short of it on a partial refusal, 6.5); ``shortfall`` is that
        #: refusal; ``wc_targets`` are the run's own working-capital targets
        #: T_bp by (balance, period index), which a plan run reads off its
        #: base run (6.2); ``work`` counts the rounding operations the run
        #: performed on year-one revenue, which is the F6 band (26.2).
        self.timeline = tuple(timeline) or tuple(p.period for p in periods)
        self.shortfall = shortfall
        self.wc_targets = dict(wc_targets or {})
        self.work = dict(work or {})

    def funding_periods(self) -> Tuple[ProjectedPeriod, ...]:
        """Every period in which the funding line was drawn (F8)."""
        return tuple(p for p in self.periods
                     if p.checks["funding_line_draw_cents"] > 0)

    def peak_funding_cents(self) -> int:
        return max([0] + [p.bs["revolver"] for p in self.periods])

    def fp1_assumptions(self) -> List[Dict[str, Any]]:
        """Every quantitative driver in the shape the fp1 serving
        contract (``engine.forecast_serving``) reads, so wave 2 attaches
        without re-describing a driver a second time and drifting."""
        labels = [p.label for p in self.periods]
        out = []  # type: List[Dict[str, Any]]
        for item in self.assumptions.items():
            shaped = item.as_fp1(labels)
            if shaped is not None:
                out.append(shaped)
        # The conventions, after the drivers. They are NOT in
        # `_DEFAULTS` — `derive_assumptions` measures quantities from a
        # book, and none of these is a quantity to measure. They belong
        # to the fp1 VIEW: a reader being handed a held balance-sheet
        # line needs to be told it is held, and the numeric engine does
        # not. Emitted here so the two never have to agree about a driver
        # that exists on only one side.
        for cid, basis in FP1_CONVENTIONS:
            out.append({
                "id": cid,
                "label": cid.replace("_", " "),
                "unit": "convention",
                "values": dict((label, None) for label in labels),
                "basis": "%s [engine_default]" % basis,
                "derived_from": [],
            })
        return out

    def series(self) -> Dict[str, Tuple[float, ...]]:
        """Line -> the projected values, in period order. The shape the
        wave-2 insight detectors read."""
        out = {}  # type: Dict[str, Tuple[float, ...]]
        for line in PL_LINES:
            out["pl." + line] = tuple(to_float(p.pl[line]) for p in self.periods)
        for line in LINES:
            out["bs." + line] = tuple(to_float(p.bs[line]) for p in self.periods)
        for line in CF_LINES:
            out["cf." + line] = tuple(to_float(p.cf[line]) for p in self.periods)
        return out

    def as_dict(self) -> Dict[str, Any]:
        return {
            "schema": "forecast_v1",
            "opening": self.opening.as_dict(),
            "history": self.history.as_dict(),
            "assumptions": self.assumptions.as_list(),
            "fp1_assumptions": self.fp1_assumptions(),
            # The fp1 attribution map: line -> the reasons behind it.
            # `engine.forecast_serving.adapter` reads this key and REFUSES
            # every figure that is not in it, so an unattributed line
            # cannot reach a reader as a number with no reason.
            "line_assumptions": expand_line_assumptions(self.assumptions),
            # The cost pools this projection ran on (plan/2 B4b, section
            # 5): bases, fixed shares, tiers and rules. B6 serves them.
            "pools": (self.assumptions.pools.as_dict()
                      if self.assumptions.pools is not None else None),
            "debt_schedule": self.assumptions.debt_schedule.as_list(),
            "notes": list(self.notes),
            "periods": [p.as_dict() for p in self.periods],
            "summary": {
                "period_count": len(self.periods),
                "labels": [p.label for p in self.periods],
                "balances_every_period": all(
                    p.checks["balance_delta_cents"] == 0 for p in self.periods),
                "funding_line_periods": [p.label for p in self.funding_periods()],
                "peak_funding_line": to_float(self.peak_funding_cents()),
            },
        }


def _trailing_deviation(history, window_micro_days):
    # type: (List[Tuple[int, int, int]], int) -> int
    """The deviation a balance carries at the end of the LAST period of
    ``history``: every period's deviation weighted by the micro-days of it
    that fall inside the trailing window, over the window, one rounding.
    Days before the plan starts carry no deviation (the run is the base
    there). ``history`` rows are (start ordinal - 1, end ordinal, deviation
    in minor units)."""
    window_end = history[-1][1] * MICRO_DAY
    window_start = window_end - window_micro_days
    weighted = 0
    for opened, closed, deviation in reversed(history):
        upper = closed * MICRO_DAY
        if upper <= window_start:
            break
        lower = max(opened * MICRO_DAY, window_start)
        weighted += deviation * (upper - lower)
    return mul_div(weighted, 1, window_micro_days)


#: The three balances the working-capital unwind of contract 6.2 governs:
#: (balance line, days driver, the flow its target is priced on).
WC_BALANCES = (("ar", "dso_days", "revenue"),
               ("inventory", "dio_cogs_days", "cost_of_sales"),
               ("ap", "dpo_cogs_days", "cost_of_sales"))


class ShortfallRefusal(object):
    """The partial refusal of contract 6.5: the plan first draws a funding
    line this book cannot price in ``period``. The first shortfall accrues
    no funding interest (the line opens at zero), so its amount and the
    cash before funding are computable without the rate."""

    __slots__ = ("period", "amount_minor", "cash_before_funding_minor", "sentence")

    def __init__(self, period: Period, amount_minor: int,
                 cash_before_funding_minor: int, sentence: Dict[str, str]) -> None:
        self.period = period
        self.amount_minor = int(amount_minor)
        self.cash_before_funding_minor = int(cash_before_funding_minor)
        self.sentence = dict(sentence)

    def as_dict(self) -> Dict[str, Any]:
        return {"driver_key": "revolver_rate", "from_period": self.period.label,
                "shortfall_minor": self.amount_minor,
                "cash_before_funding_minor": self.cash_before_funding_minor,
                "sentence": dict(self.sentence)}


class CompiledPlan(object):
    """A lever set compiled onto one timeline (plan/2 B5, contract 2.5-2.6).

    Built only by :mod:`engine.forecast.levers`; :func:`project` reads it and
    does no composition of its own. Every value is already rounded once to
    its model unit. A key that is absent from a mapping means "no lever
    moved this driver": the resolved default of the AssumptionSet applies,
    which is why a run with ``plan=None`` and a run with an empty plan are
    the same arithmetic.

    - ``years``: annual-granularity rate drivers, micros per plan year
      (index n-1), None where the book cannot price the rate.
    - ``periods``: monthly-granularity drivers per period index: the index
      drivers and pool levels in micros, the days drivers in micro-days.
    - ``money``: the held money lines, (annual amount in force, level in
      micros) per period index.
    - ``scalars``: min_cash, depreciation_rate, pool_fixed_share.<pool>.
    - ``elasticity``: volume_elasticity per pool (0 or 1).
    - ``debt_schedule``: the request's debt rows placed per 6.7.
    - ``wc_base_targets`` and ``wc_unwind_micro_days``: the base run's
      targets and the pack's unwind window (6.2); None on a base run.
    """

    __slots__ = ("years", "periods", "money", "scalars", "elasticity",
                 "debt_schedule", "wc_base_targets", "wc_unwind_micro_days")

    def __init__(self, years=None, periods=None, money=None, scalars=None,
                 elasticity=None, debt_schedule=None, wc_base_targets=None,
                 wc_unwind_micro_days=None) -> None:
        self.years = dict(years or {})
        self.periods = dict(periods or {})
        self.money = dict(money or {})
        self.scalars = dict(scalars or {})
        self.elasticity = dict(elasticity or {})
        self.debt_schedule = debt_schedule
        self.wc_base_targets = wc_base_targets
        self.wc_unwind_micro_days = wc_unwind_micro_days


def project(opening: OpeningPosition, history: PlHistory,
            assumptions: Optional[AssumptionSet] = None, *,
            total_years: int, monthly_months: int,
            context: Optional[BookContext] = None,
            plan: Optional[CompiledPlan] = None,
            stop_at_unpriced_draw: bool = False,
            **overrides: Any) -> Projection:
    """Roll the opening position forward. Refuses rather than approximates.

    ``assumptions`` defaults to :func:`derive_assumptions` over this
    book; ``overrides`` are applied on top and stamped ``source='caller'``.
    ``total_years`` and ``monthly_months`` are the horizon (plan_contract_v2
    2.2, 6.1): request fields, never drivers, so they are arguments and no
    override can name them. ``context`` is the book's
    :class:`~engine.forecast.assumptions.BookContext` (its jurisdiction and
    ratio table, contract 0.3); without it the jurisdiction is not
    recorded, so a tax rate the book cannot measure refuses the plan.
    """
    if assumptions is None:
        assumptions = derive_assumptions(opening, history, context=context,
                                         **overrides)
    elif overrides:
        assumptions = assumptions.with_overrides(**overrides)

    if plan is None:
        plan = CompiledPlan()

    def _year_rate(key, scalar, year_offset):
        values = plan.years.get(key)
        return scalar if values is None else values[year_offset - 1]

    def _index(key, period):
        values = plan.periods.get(key)
        return MICRO if values is None else values[period.index]

    days_basis = assumptions.count("days_basis")
    if days_basis <= 0:
        raise AssumptionError("days_basis", "must be positive")
    min_cash = plan.scalars.get("min_cash", None)
    if min_cash is None:
        min_cash = assumptions.cents("min_cash")
    if min_cash < 0:
        raise AssumptionError(
            "min_cash",
            "must not be negative: the funding line exists so cash never "
            "goes below the floor, and a negative floor would licence "
            "exactly the silent overdraft it prevents")

    anchor = _parse_date(opening.period_end)
    timeline = build_timeline(anchor, total_years, monthly_months)

    # ``micros`` REFUSES an unavailable rate rather than handing back 0.
    # Each of these governs a P&L flow or a programme the model creates
    # itself, so there is no balance to hold and a 0 would be an invented
    # rate — the same argument the funding line makes for itself below,
    # applied to every rate that carries it. A book that cannot measure
    # one of them says so in the driver's own basis, and that sentence is
    # what the AssumptionError carries to the caller.
    growth = assumptions.micros("revenue_growth")
    inflation = assumptions.micros("inflation")
    capex_pct = assumptions.micros("capex_pct_of_revenue")
    intangible_pct = assumptions.micros("intangible_additions_pct_of_revenue")
    ooi_annual = assumptions.cents("other_operating_income_annual")
    # The cost pools (contract 5): the set carries the split it was derived
    # with; a set built without a book refuses the split by name (one pool
    # that follows volume in full — never a guessed split).
    pools = assumptions.pools
    if pools is None:
        pools = split_pools(None, opex_total_cents=history.opex,
                            cogs_total_cents=history.cogs,
                            revenue_cents=history.revenue or 0)

    def _pool_share(pool):
        key = FIXED_SHARE_PREFIX + pool.name
        if pool.absent_reason is not None:
            # ABSENT != ZERO: the assembled statement carries no total for
            # this pool's line, so there is no base to project. Refused by
            # the pool's own driver name; a share a caller supplies cannot
            # stand in for an amount that is not there.
            raise AssumptionError(key, "is unavailable, so there is no cost "
                                  "base to project: %s" % pool.absent_reason)
        if key in plan.scalars:
            return plan.scalars[key]
        try:
            assumptions[key]
        except AssumptionError:
            # a set built without this book's pool keys: the pool's own share
            return pool.fixed_share_micros
        return assumptions.micros(key)

    def _pool_level(pool):
        key = LEVEL_PREFIX + pool.name
        if key in plan.periods:
            return None  # per period, read through _index below
        try:
            return assumptions.micros(key)
        except AssumptionError:
            return MICRO

    fixed_share_of = dict((p.name, _pool_share(p)) for p in pools.pools())
    level_of = dict((p.name, _pool_level(p)) for p in pools.opex)
    for name, share in fixed_share_of.items():
        if share < 0 or share > MICRO:
            raise AssumptionError(FIXED_SHARE_PREFIX + name,
                                  "a fixed share is a decimal in [0, 1], got %s"
                                  % _pct(share))
    tax_driver = assumptions["tax_rate"]
    if tax_driver.exact is None and tax_driver.tier == "absent":
        # R16: the book's effective rate is not measured and no statutory
        # rate is packed for this period's jurisdiction (or the
        # jurisdiction is not recorded). Refused by name, with the code the
        # route serves — never taxed at a rate nobody stated.
        raise NoStatutoryTaxRate(tax_driver.basis,
                                 getattr(context, "jurisdiction", None))
    tax_rate = assumptions.micros("tax_rate")
    # The FOUR rates that price a BALANCE, which may be nil at the
    # opening date and NOT nil once the plan moves — the capital
    # programme buys fixed assets, a DebtSchedule draws debt, and this
    # model creates the funding line itself. An unmeasurable rate on a
    # balance that is never carried costs nothing, and refusing that plan
    # would refuse a well-defined one; so each is read as an explicit
    # refusal — never as a spendable 0 — and checked INSIDE the loop, at
    # the period where the balance actually appears. The question each
    # asks is the VALUE ("is there a rate to spend?"), never the source
    # word: a driver that pairs a comfortable word with a missing number,
    # or a refusal that still carries one, would otherwise slip between
    # the guard and the charge.
    dep_rate = plan.scalars.get("depreciation_rate")
    if dep_rate is None:
        dep_rate = assumptions.micros_or_none("depreciation_rate")
    debt_rate = assumptions.micros_or_none("interest_rate_debt")
    revolver_rate = assumptions.micros_or_none("revolver_rate")
    cash_rate = assumptions.micros_or_none("interest_income_rate")
    book_rates = {"interest_rate_debt": debt_rate, "revolver_rate": revolver_rate,
                  "interest_income_rate": cash_rate}
    interest_income_held = assumptions.cents("interest_income_annual")
    other_fin_income_annual = assumptions.cents("other_financial_income_annual")
    other_fin_expense_annual = assumptions.cents(
        "other_financial_expense_annual")
    payout = assumptions.micros("dividend_payout_pct")
    dso = assumptions.micro_days_or_none("dso_days")
    dio = assumptions.micro_days_or_none("dio_cogs_days")
    dpo = assumptions.micro_days_or_none("dpo_cogs_days")
    schedule = (plan.debt_schedule if plan.debt_schedule is not None
                else assumptions.debt_schedule)

    year_count = timeline[-1].year_offset
    growth_of_year = dict((n, _year_rate("revenue_growth", growth, n))
                          for n in range(1, year_count + 1))
    worst_growth = min(growth_of_year.values())
    if worst_growth < -MICRO:
        growth = worst_growth
    if growth < -MICRO:
        # Below −100% revenue turns NEGATIVE, and every line driven off it
        # follows: cost of sales, receivables, inventory, payables. The
        # balance check cannot see it — a mirror-image balance sheet still
        # closes to zero — so nothing downstream would ever object. −100%
        # (the business stops selling) is the floor a projection can mean.
        raise AssumptionError(
            "revenue_growth",
            "is %s, below -100%%. Revenue would be projected NEGATIVE, and "
            "every line driven off it — cost of sales, receivables, "
            "inventory, payables — with it, while the balance check stays "
            "satisfied because a mirror-image balance sheet still closes "
            "to zero. -100%% (revenue stops) is the floor."
            % _pct(growth))

    # ── revenue and the annual programmes, sliced onto the timeline ────
    by_year = []  # type: List[Tuple[int, List[Period]]]
    for period in timeline:
        if not by_year or by_year[-1][0] != period.year_offset:
            by_year.append((period.year_offset, []))
        by_year[-1][1].append(period)

    revenue_of = {}  # type: Dict[int, int]
    capex_of = {}  # type: Dict[int, int]
    intangible_of = {}  # type: Dict[int, int]
    #: The pool parts per period (5.3): fixed_p and variable_p of each
    #: pool, sliced by days from the plan year's F_jn and V_jn.
    pool_fixed_of = {}  # type: Dict[Tuple[str, int], int]
    pool_variable_of = {}  # type: Dict[Tuple[str, int], int]
    ooi_of = {}  # type: Dict[int, int]
    #: The three P&L lines the model HOLDS rather than drives. Each is the
    #: source period's own annual amount, spread across the year's periods
    #: by day count and repeated unchanged every year — held, not grown.
    interest_income_of = {}  # type: Dict[int, int]
    other_fin_income_of = {}  # type: Dict[int, int]
    other_fin_expense_of = {}  # type: Dict[int, int]
    if history.revenue is None:
        # ABSENT != ZERO (plan/2 B5, B4RV-2): an assembled P&L with no
        # revenue line projected revenue 0.00 and an EBITDA of minus the
        # whole cost base. wave/plan-b3 refused this payload; so does this.
        from .levers_pack import plan_pack
        raise AssumptionError("revenue", plan_pack().refusals["revenue_absent"])
    anchor_revenue = history.revenue
    #: G(n) and C(n) of contract 5.3: the cumulative growth and inflation
    #: factors, exact rationals; every annual amount is one product rounded
    #: once, so at neutral growth and inflation each pool reproduces its
    #: anchor base to the cent.
    growth_factor = Fraction(1)
    inflation_factor = Fraction(1)
    money_lines = {
        "other_operating_income_annual": ooi_annual,
        "interest_income_annual": interest_income_held,
        "other_financial_income_annual": other_fin_income_annual,
        "other_financial_expense_annual": other_fin_expense_annual,
    }

    def _held(key, periods):
        """A held money line sliced by days (5.5). With no lever it is the
        one annual amount sliced cumulatively, exactly as before B5. A set
        or level_pct from month m (2.6) gives each period the day slice of
        the annual amount in force in that period, times its level."""
        compiled = plan.money.get(key)
        if compiled is None:
            return _slice_by_days(money_lines[key], periods)
        out = []
        for position, period in enumerate(periods):
            amount, level = compiled[period.index]
            out.append(mul_div(_slice_by_days(amount, periods)[position],
                               level, MICRO))
        return out

    #: F6 (26.2): the rounding operations this run performed on year-one
    #: revenue. The magnitude gate renders its band from this count.
    revenue_roundings_year_one = 0
    for _year, periods in by_year:
        growth_factor *= Fraction(MICRO + growth_of_year[_year], MICRO)
        inflation_factor *= Fraction(
            MICRO + _year_rate("inflation", inflation, _year), MICRO)
        running_revenue = _round(anchor_revenue * growth_factor)
        if _year == 1:
            revenue_roundings_year_one += 1
        for pool in pools.pools():
            share = Fraction(fixed_share_of[pool.name], MICRO)
            fixed_total = _round(pool.base_cents * share * inflation_factor)
            variable_total = (_round(pool.base_cents * growth_factor)
                              - _round(pool.base_cents * share * growth_factor))
            elastic = plan.elasticity.get(pool.name, 1) == 1
            price_linked = pool.name == pools.cost_of_sales.name
            for period, fixed_slice, variable_slice in zip(
                    periods, _slice_by_days(fixed_total, periods),
                    _slice_by_days(variable_total, periods)):
                # 5.3, in the declared order: volume, then input price.
                if elastic:
                    variable_slice = mul_div(variable_slice,
                                             _index("volume_index", period), MICRO)
                if price_linked:
                    variable_slice = mul_div(
                        variable_slice, _index("input_price_index", period), MICRO)
                pool_fixed_of[(pool.name, period.index)] = fixed_slice
                pool_variable_of[(pool.name, period.index)] = variable_slice
        for period, ooi_slice in zip(
                periods, _held("other_operating_income_annual", periods)):
            ooi_of[period.index] = ooi_slice
        annual_capex = apply_rate(
            running_revenue, _year_rate("capex_pct_of_revenue", capex_pct, _year))
        annual_intangible = apply_rate(
            running_revenue, _year_rate("intangible_additions_pct_of_revenue",
                                        intangible_pct, _year))
        for (period, slice_revenue, slice_capex, slice_intangible,
             slice_interest_income, slice_fin_income, slice_fin_expense) in zip(
                periods,
                _slice_by_days(running_revenue, periods),
                _slice_by_days(annual_capex, periods),
                _slice_by_days(annual_intangible, periods),
                _held("interest_income_annual", periods),
                _held("other_financial_income_annual", periods),
                _held("other_financial_expense_annual", periods)):
            # 5.3: revenue_p = apply(apply(slice(R_n)_p, volume_p), price_p).
            if _year == 1:
                revenue_roundings_year_one += 1
            for index_key in ("volume_index", "price_index"):
                level = _index(index_key, period)
                if level != MICRO:
                    slice_revenue = mul_div(slice_revenue, level, MICRO)
                    if _year == 1:
                        revenue_roundings_year_one += 1
            revenue_of[period.index] = slice_revenue
            capex_of[period.index] = slice_capex
            intangible_of[period.index] = slice_intangible
            interest_income_of[period.index] = slice_interest_income
            other_fin_income_of[period.index] = slice_fin_income
            other_fin_expense_of[period.index] = slice_fin_expense

    last_index_of_year = dict(
        (year, periods[-1].index) for year, periods in by_year)

    balances = opening.balances()
    projected = []  # type: List[ProjectedPeriod]
    year_net_income = 0
    #: Year-to-date pre-tax result and the tax already charged in the
    #: current plan year (levers.yaml#tax.accrued_year_to_date). Both reset
    #: at each plan-year start, which is the no-loss-carry-forward
    #: convention (levers.yaml#tax.no_loss_carry_forward): nothing about a
    #: loss year reaches the next one.
    year_pretax = 0
    year_tax_charged = 0
    current_year = None  # type: Optional[int]
    shortfall = None  # type: Optional[ShortfallRefusal]
    wc_targets = {}  # type: Dict[Tuple[str, int], int]
    #: 6.2 as repaired (as-built B5R-1): per balance, every monthly period's
    #: deviation of its own target from the base run's target, with the
    #: period's span in ordinal days. The closing balance carries the
    #: TRAILING WINDOW of those deviations over its days in force, so a
    #: lever that lands after an earlier one still unwinds (the first
    #: reading, "the first divergence ever, never reset", booked every later
    #: lever in full in its landing month).
    wc_deviations = {}  # type: Dict[str, List[Tuple[int, int, int]]]
    days_scalar = {"dso_days": dso, "dio_cogs_days": dio, "dpo_cogs_days": dpo}

    for period in timeline:
        # The per-year rates a lever may have moved (2.6). The three that
        # price a BALANCE keep the names their guards ask by value.
        tax_rate_now = _year_rate("tax_rate", tax_rate, period.year_offset)
        debt_rate = _year_rate("interest_rate_debt",
                               book_rates["interest_rate_debt"], period.year_offset)
        revolver_rate = _year_rate("revolver_rate", book_rates["revolver_rate"],
                                   period.year_offset)
        cash_rate = _year_rate("interest_income_rate",
                               book_rates["interest_income_rate"],
                               period.year_offset)
        payout_now = _year_rate("dividend_payout_pct", payout, period.year_offset)
        if current_year != period.year_offset:
            current_year = period.year_offset
            year_net_income = 0
            year_pretax = 0
            year_tax_charged = 0

        opening_cash = balances["cash"]
        opening_ppe = balances["ppe_net"]
        opening_intangibles = balances["intangibles_net"]
        opening_st = balances["st_debt"]
        opening_lt = balances["lt_debt"]
        opening_revolver = balances["revolver"]

        # ── P&L ────────────────────────────────────────────────────────
        revenue = revenue_of[period.index]
        # The pools (5.3): cost of sales has no level index; each opex
        # pool is (fixed_p + variable_p) x its level, levels neutral until
        # a shock moves them (B5).
        cost_of_sales = (pool_fixed_of[(pools.cost_of_sales.name, period.index)]
                         + pool_variable_of[(pools.cost_of_sales.name, period.index)])
        operating_costs = 0
        for pool in pools.opex:
            parts = (pool_fixed_of[(pool.name, period.index)]
                     + pool_variable_of[(pool.name, period.index)])
            level = level_of[pool.name]
            if level is None:
                level = _index(LEVEL_PREFIX + pool.name, period)
            operating_costs += mul_div(parts, level, MICRO)
        # An operating INCOME the source statement names, HELD at its own
        # annual amount and sliced by days (5.5). Without it the model's
        # EBITDA is the book's EBITDA less exactly this line, on every
        # book that has one, with nothing on the projection saying so.
        other_operating_income = ooi_of[period.index]
        ebitda = (revenue - cost_of_sales - operating_costs
                  + other_operating_income)

        capex = capex_of[period.index]
        intangible_additions = intangible_of[period.index]
        # The same argument the funding line makes below, on the
        # depreciable base: a rate this book could not measure is not 0%,
        # and 0% carries every asset the plan owns through the rest of
        # the horizon undepreciated — raising operating profit in every
        # period and growing a net book value that never wears out. The
        # check is HERE and not at the top because a plan that owns no
        # fixed assets and buys none is well defined and must still
        # project: nothing is charged on a nil base, so nothing is
        # invented by charging it.
        #
        # It asks about the base this period PUBLISHES, not only the one
        # it opens with. An asset bought in the last period accrues no
        # charge under this model's opening-balance convention, so a
        # guard on the opening balance alone would let the projection
        # print a balance sheet carrying assets beside a note saying the
        # base is nil and nothing is charged — the same sentence
        # contradicted by the same statement, one convention deeper. The
        # funding line has always guarded on the DRAW for this reason.
        base_this_period = (opening_ppe + opening_intangibles
                            + capex + intangible_additions)
        if base_this_period > 0 and dep_rate is None:
            raise AssumptionError(
                "depreciation_rate",
                "the plan carries %s of property, plant, equipment and "
                "intangibles in %s and this book cannot price their "
                "depreciation: %s. Charging 0%% would be an invented "
                "rate, and the most favourable one. Supply "
                "depreciation_rate."
                % (fmt(base_this_period), period.label,
                   assumptions["depreciation_rate"].basis),
                period_label=period.label)
        # The charge is capped at the book value actually available. An
        # uncapped charge would drive net book value negative, and a
        # clamp applied only to the balance sheet would break the
        # articulation — so the CAPPED figure is the one that reaches the
        # P&L, the cash-flow add-back and the roll-forward alike.
        #
        # A missing rate charges nothing ONLY because the guard above has
        # already proved both opening balances are nil, so the charge
        # would be zero at any rate whatsoever. It is not a 0% rate
        # standing in for one nobody measured.
        depreciation = 0
        amortisation = 0
        if dep_rate is not None:
            depreciation = min(
                _period_charge(opening_ppe, dep_rate, period.days, days_basis),
                max(0, opening_ppe + capex))
            amortisation = min(
                _period_charge(opening_intangibles, dep_rate, period.days,
                               days_basis),
                max(0, opening_intangibles + intangible_additions))
        ebit = ebitda - depreciation - amortisation

        # The funding line's argument, on the debt the book already
        # carries: a rate that could not be measured is not 0%, and 0% on
        # real debt is the cheapest money there is. As above, the
        # question is the debt this period PUBLISHES — a draw scheduled
        # in the final period would otherwise reach the balance sheet
        # with no rate behind it and no charge against it.
        debt_this_period = (opening_st + opening_lt
                            + schedule.at(period.index).st_draw
                            + schedule.at(period.index).lt_draw)
        if debt_this_period > 0 and debt_rate is None:
            raise AssumptionError(
                "interest_rate_debt",
                "the plan carries %s of interest-bearing debt in %s and "
                "this book cannot price it: %s. Charging 0%% would be an "
                "invented rate, and the cheapest one. Supply "
                "interest_rate_debt."
                % (fmt(debt_this_period), period.label,
                   assumptions["interest_rate_debt"].basis),
                period_label=period.label)
        # As above: a missing rate charges nothing only where the guards
        # have already proved the balance is nil. ``rate or 0`` would say
        # the same thing in a way that reads as a default, and that is
        # the idiom this whole repair exists to remove.
        interest_debt = (
            _period_charge(opening_st + opening_lt, debt_rate,
                           period.days, days_basis)
            if debt_rate is not None else 0)
        interest_funding = (
            _period_charge(opening_revolver, revolver_rate,
                           period.days, days_basis)
            if revolver_rate is not None else 0)
        # ONE interest-income line, from ONE of two stated rules: priced on
        # the cash this model projects when a rate is available, and
        # otherwise carried at the source period's own amount. Never both,
        # and never neither — dropping it would zero an income the book
        # names, and charging both would count it twice.
        interest_income = (
            _period_charge(opening_cash, cash_rate, period.days,
                           days_basis)
            # priced in a plan year whose rate has a VALUE (the book's own,
            # or a lever's for that year, 2.6); otherwise carried. Never both.
            if cash_rate is not None
            else interest_income_of[period.index])
        other_financial_income = other_fin_income_of[period.index]
        other_financial_expense = other_fin_expense_of[period.index]
        pretax = (ebit - interest_debt - interest_funding + interest_income
                  + other_financial_income - other_financial_expense)
        # Year-to-date accrual (contract 6.3): the tax on the result so far
        # this plan year, never below zero, less what earlier periods of
        # the same year were already charged. A loss period after profit
        # periods reverses tax (a negative charge); the year's total is
        # exactly max(0, tax on the year's own result), one rounding. An
        # annual period is its own year to date, so it is charged
        # max(0, pre-tax x rate).
        year_pretax += pretax
        year_tax_due = max(0, apply_rate(year_pretax, tax_rate_now))
        income_tax = year_tax_due - year_tax_charged
        year_tax_charged = year_tax_due
        net_income = pretax - income_tax
        year_net_income += net_income

        # ── working capital ────────────────────────────────────────────
        # Day counts are MICRO-days, so the denominator carries the same
        # scale. A whole-day driver would move these balances by up to
        # half a day of the flow that drives them and post the difference
        # as operating cash no assumption ever stated.
        period_micro_days = period.days * MICRO_DAY
        flows = {"revenue": revenue, "cost_of_sales": cost_of_sales}
        closing_wc = {}  # type: Dict[str, int]
        for balance, days_key, flow_key in WC_BALANCES:
            compiled_days = plan.periods.get(days_key)
            days_now = (days_scalar[days_key] if compiled_days is None
                        else compiled_days[period.index])
            if days_now is None:
                closing_wc[balance] = balances[balance]
                continue
            target = mul_div(flows[flow_key], days_now, period_micro_days)
            wc_targets[(balance, period.index)] = target
            closing = target
            base_target = (None if plan.wc_base_targets is None
                           else plan.wc_base_targets.get((balance, period.index)))
            # 6.2 (convention wc_unwind_ramp): a balance leaves its base
            # target one day of flow per elapsed day. The deviation of the
            # target from the base target is carried as a trailing window
            # over the balance's own days in force (or the pack's unwind
            # window): each monthly period inside the window contributes
            # its deviation for the days it overlaps, one rounding. For a
            # single step this is the contract's min(E, D) / D; a second
            # lever, a ramp or a shock that ends unwinds the same way.
            # Annual periods land on the target; the base run has no base
            # target and is unchanged.
            if base_target is not None and period.granularity == "monthly":
                deviations = wc_deviations.setdefault(balance, [])
                deviations.append((period.start.toordinal() - 1,
                                period.end.toordinal(), target - base_target))
                window = (plan.wc_unwind_micro_days
                          if plan.wc_unwind_micro_days is not None else days_now)
                if window > 0 and any(item[2] for item in deviations):
                    closing = base_target + _trailing_deviation(deviations, window)
            closing_wc[balance] = closing
        receivables = closing_wc["ar"]
        inventory = closing_wc["inventory"]
        payables = closing_wc["ap"]

        # ── fixed assets ───────────────────────────────────────────────
        closing_ppe = opening_ppe + capex - depreciation
        closing_intangibles = (opening_intangibles + intangible_additions
                               - amortisation)

        # ── debt ───────────────────────────────────────────────────────
        move = schedule.at(period.index)
        st_repaid = min(move.st_repay, max(0, opening_st + move.st_draw))
        lt_repaid = min(move.lt_repay, max(0, opening_lt + move.lt_draw))
        closing_st = opening_st + move.st_draw - st_repaid
        closing_lt = opening_lt + move.lt_draw - lt_repaid

        # ── distributions ──────────────────────────────────────────────
        dividends = 0
        if period.index == last_index_of_year[period.year_offset] \
                and year_net_income > 0 and payout_now > 0:
            dividends = apply_rate(year_net_income, payout_now)
            # A distribution cannot exceed what the reserve can carry.
            dividends = min(dividends,
                            max(0, balances["equity_retained"] + net_income))
        closing_retained = balances["equity_retained"] + net_income - dividends

        # ── cash flow ──────────────────────────────────────────────────
        change_receivables = receivables - balances["ar"]
        change_inventory = inventory - balances["inventory"]
        change_payables = payables - balances["ap"]
        cfo = (net_income + depreciation + amortisation
               - change_receivables - change_inventory + change_payables)
        cfi = -capex - intangible_additions
        drawdowns = move.st_draw + move.lt_draw
        repayments = st_repaid + lt_repaid
        cff_before_funding = drawdowns - repayments - dividends
        cash_before_funding = opening_cash + cfo + cfi + cff_before_funding

        if cash_before_funding < min_cash:
            funding_draw = min_cash - cash_before_funding
            funding_repay = 0
        else:
            funding_draw = 0
            funding_repay = min(opening_revolver,
                                cash_before_funding - min_cash)
        if (funding_draw > 0 or opening_revolver > 0) \
                and revolver_rate is None:
            if stop_at_unpriced_draw and opening_revolver == 0:
                # 6.5: serve the periods before the first unpriceable draw
                # and say where, and by how much, the plan falls short.
                shortfall = ShortfallRefusal(
                    period, funding_draw, cash_before_funding,
                    {"code": "funding_line_unpriceable",
                     "text": "the plan draws %s on the funding line in %s and "
                             "this book cannot price it: %s"
                             % (fmt(funding_draw), period.label,
                                assumptions["revolver_rate"].basis)})
                break
            # An `unavailable` rate means the line is HELD, not that it
            # resolves to zero on the numeric path. There is no balance to
            # hold here — the model creates this one itself — so a rate it
            # cannot measure cannot be silently replaced by 0%, which is
            # an invented rate AND the most favourable one available.
            raise AssumptionError(
                "revolver_rate",
                "the plan draws %s on the funding line in %s and this book "
                "cannot price it: %s. Charging 0%% would be an invented "
                "rate, and the cheapest one. Supply revolver_rate, or "
                "change the plan so the line is not drawn."
                % (fmt(funding_draw or opening_revolver), period.label,
                   assumptions["revolver_rate"].basis),
                period_label=period.label)
        funding_movement = funding_draw - funding_repay
        closing_revolver = opening_revolver + funding_movement
        closing_cash = cash_before_funding + funding_movement
        cff = cff_before_funding + funding_movement

        if closing_cash < 0:  # pragma: no cover - unreachable while min_cash>=0
            raise BalanceViolation(period.label, closing_cash, closing_cash, 0)

        # ── the projected balance sheet ────────────────────────────────
        balances = {
            "cash": closing_cash,
            "ar": receivables,
            "inventory": inventory,
            "other_current_assets": balances["other_current_assets"],
            "ppe_net": closing_ppe,
            "intangibles_net": closing_intangibles,
            "investment_property": balances["investment_property"],
            "other_non_current_assets": balances["other_non_current_assets"],
            "ap": payables,
            "other_current_liabilities": balances["other_current_liabilities"],
            "st_debt": closing_st,
            "revolver": closing_revolver,
            "lt_debt": closing_lt,
            "other_non_current_liabilities":
                balances["other_non_current_liabilities"],
            "equity_contributed": balances["equity_contributed"],
            "equity_reserves": balances["equity_reserves"],
            "equity_retained": closing_retained,
            "equity_other": balances["equity_other"],
        }

        assets = sum(balances[line] for line in ASSET_LINES)
        equity_plus_liabilities = sum(balances[line] for line in EL_LINES)
        delta = assets - equity_plus_liabilities
        if delta != 0:
            raise BalanceViolation(period.label, delta, assets,
                                   equity_plus_liabilities)

        projected.append(ProjectedPeriod(
            period=period,
            pl={
                "revenue": revenue,
                "cost_of_sales": -cost_of_sales,
                "operating_costs": -operating_costs,
                "other_operating_income": other_operating_income,
                "ebitda": ebitda,
                "depreciation": -depreciation,
                "amortisation": -amortisation,
                "ebit": ebit,
                "interest_expense_debt": -interest_debt,
                "interest_expense_funding_line": -interest_funding,
                "interest_income": interest_income,
                "other_financial_income": other_financial_income,
                "other_financial_expense": -other_financial_expense,
                "pretax_result": pretax,
                "income_tax": -income_tax,
                "net_income": net_income,
            },
            bs=dict(balances),
            cf={
                "net_income": net_income,
                "depreciation": depreciation,
                "amortisation": amortisation,
                "change_in_receivables": -change_receivables,
                "change_in_inventory": -change_inventory,
                "change_in_payables": change_payables,
                "cash_from_operating": cfo,
                "capital_expenditure": -capex,
                "intangible_additions": -intangible_additions,
                "cash_from_investing": cfi,
                "debt_drawdowns": drawdowns,
                "debt_repayments": -repayments,
                "dividends_paid": -dividends,
                "funding_line_movement": funding_movement,
                "cash_from_financing": cff,
                "net_change_in_cash": cfo + cfi + cff,
                "opening_cash": opening_cash,
                "closing_cash": closing_cash,
            },
            # Every money key here carries `_cents` in its NAME, because
            # the in-memory object is integer cents and `as_dict()` emits
            # units. A key that is cents in one place and units in the
            # other, under one name, is the exact shape of defect this
            # repo has shipped before.
            checks={
                "balance_delta_cents": delta,
                "cash_before_funding_line_cents": cash_before_funding,
                "funding_line_draw_cents": funding_draw,
                "funding_line_repay_cents": funding_repay,
                "funding_line_balance_cents": closing_revolver,
                "cash_went_negative": closing_cash < 0,
            },
        ))

    return Projection(opening=opening, assumptions=assumptions,
                      periods=tuple(projected), history=history,
                      notes=_notes(assumptions, history),
                      timeline=timeline, shortfall=shortfall,
                      wc_targets=wc_targets,
                      work={"revenue_roundings_year_one":
                            revenue_roundings_year_one})


def _notes(assumptions: AssumptionSet, history: PlHistory) -> Tuple[str, ...]:
    """The plain-language record of what this projection could NOT measure
    — rendered from the assumption pedigrees, never written as prose."""
    out = []  # type: List[str]
    for item in assumptions.items():
        if item.source in ("unavailable", "engine_default"):
            out.append("%s: %s (%s)" % (item.key, item.basis, item.source))
    for convention in MODEL_CONVENTIONS:
        out.append("model convention: %s" % convention)
    # The one figure the conventions above point at, taken from the book
    # rather than described. A convention that names an exposure without
    # sizing it leaves the reader to guess whether it matters.
    # EVERY driver measured off the assembled P&L rests on a build-up
    # that this same payload says does not reach the profit the company
    # filed in account 121. The tax rate is DEMOTED for it (an effective
    # rate is a claim the filed figure can contradict — see
    # assumptions.py); the cost ratios are not, because a share of
    # revenue is a statement about the build-up rather than about a
    # figure filed beside it. Either way the reader is told, once, with
    # the gap sized from the book's own integers rather than described:
    # a `derived` driver is the one case that otherwise says nothing on
    # the face of the projection.
    unexplained = history.unexplained_vs_filed()
    if unexplained:
        out.append(
            "measured against account 121: %s of this book's profit and "
            "loss account is not attributable to any line on it — the "
            "reconstruction reaches %s where the company filed %s. EVERY "
            "driver measured from this statement, the cost pools and "
            "working-capital ratios included, is measured from that "
            "build-up; only the tax rate is displaced by it, because only "
            "the tax rate claims to reproduce a figure filed beside it."
            % (fmt(unexplained),
               fmt((history.pretax or 0) - (history.income_tax or 0)),
               fmt(history.net_income or 0)))
    reversals = history.provision_reversals
    if reversals:
        out.append(
            "measured exposure to the convention above: of the %s of other "
            "operating income this book reports, %s is provision reversals "
            "(assembled_pl.other_income_781_reversals) — a non-cash credit "
            "this model projects forward as cash."
            % (fmt(history.other_operating_income or 0), fmt(reversals)))
    return tuple(out)


def _parse_date(text: str) -> date:
    parts = str(text)[:10].split("-")
    if len(parts) != 3:
        raise AssumptionError("period_end",
                              "expected an ISO date, got %r" % (text,))
    return date(int(parts[0]), int(parts[1]), int(parts[2]))


def context_for_payload(payload: Dict[str, Any]) -> BookContext:
    """The book context a payload carries: its jurisdiction, read from the
    anchor envelope (contract 0.3), and its ratio table."""
    return BookContext.from_payload(payload)


def _opening_and_history(payload: Dict[str, Any]
                         ) -> Tuple[OpeningPosition, PlHistory]:
    from engine.serving.facts import FactsGateway

    envelope = payload.get("envelope")
    gateway = FactsGateway.from_envelope(
        envelope if isinstance(envelope, dict) else payload,
        currency=str(payload.get("currency") or "RON"))
    if gateway is None:
        from .errors import OpeningPositionError
        raise OpeningPositionError(
            "this period carries no served balance sheet, so there is "
            "nothing to open the projection on")
    period_end = str(payload.get("period_end") or "")
    opening = OpeningPosition.from_gateway(gateway, period_end)
    return opening, pl_history_from_payload(payload)


def assumptions_for_payload(payload: Dict[str, Any],
                            **overrides: Any) -> AssumptionSet:
    """The resolved driver set of one payload, with no projection run.

    The ONE derivation (contract 4): ``engine.forecast_drivers`` reads the
    concepts it shares with this model from here rather than measuring
    them a second time."""
    opening, history = _opening_and_history(payload)
    return derive_assumptions(opening, history,
                              context=context_for_payload(payload),
                              **overrides)


def project_payload(payload: Dict[str, Any], horizon_years: int = 5,
                    **overrides: Any) -> Projection:
    """Project one captured/served period payload end to end.

    The opening position is taken from the CANONICAL balance sheet
    through the facts gateway; the P&L history from the assembled P&L;
    the jurisdiction from the anchor envelope (contract 0.3).

    ``horizon_years`` is kept only as ``total_years`` with a monthly window
    of twelve months (plan_contract_v2 2.2) — the one shape the route
    serves today — and is never an assumption override.

    Since plan/2 B5 (contract 1.1) this is a thin wrapper: nothing projects
    except ``engine.forecast.levers.project_plan``, called here with a base
    request. ``overrides`` stay what they always were on this API,
    caller-stamped assumptions, and an unpriceable funding line still
    refuses the whole plan (the partial serve of 6.5 reaches readers with
    fp1.2 in B6).
    """
    from .levers import PlanRequest, project_plan  # levers imports this module
    plan = project_plan(payload, (), PlanRequest(total_years=horizon_years,
                                                 monthly_months=12),
                        None, stop_at_unpriced_draw=False,
                        assumption_overrides=overrides)
    return plan.projection
