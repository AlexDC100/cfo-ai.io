"""The ACTUAL figures a projection is built from, read once, in one place.

Balance-sheet history comes from the canonical statement through the
facts gateway (see ``opening.py``). This module carries the other half:
the P&L of the source period, whose authority is
``statements.assembled_pl`` — the same authority the insight engine's
``Book.pl()`` reads, so a driver derived here and a finding printed
there cannot disagree about what the company earned.

Everything is optional. A figure the payload does not carry is None, not
zero: a book with no interest expense and a book whose interest expense
the payload failed to carry are different facts, and the assumption
derived from each must differ too (one is a rate, the other is a
refusal).

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .money import cents_from

__all__ = ["PlHistory", "pl_history_from_payload"]


def _cents_or_none(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        return None
    try:
        as_float = float(value)
    except (TypeError, ValueError):
        return None
    if as_float != as_float:  # NaN
        return None
    return cents_from(as_float)


class PlHistory(object):
    """The source period's P&L, in cents, ABSENT-safe."""

    __slots__ = ("revenue", "cogs", "opex", "depreciation", "interest_expense",
                 "interest_income", "pretax", "income_tax", "net_income",
                 "ebitda", "other_operating_income", "financial_income",
                 "financial_expense_total", "provision_reversals",
                 "capitalized_own_work", "filed_net_income_121")

    def __init__(self, revenue: Optional[int] = None, cogs: Optional[int] = None,
                 opex: Optional[int] = None, depreciation: Optional[int] = None,
                 interest_expense: Optional[int] = None,
                 interest_income: Optional[int] = None,
                 pretax: Optional[int] = None,
                 income_tax: Optional[int] = None,
                 net_income: Optional[int] = None,
                 ebitda: Optional[int] = None,
                 other_operating_income: Optional[int] = None,
                 financial_income: Optional[int] = None,
                 financial_expense_total: Optional[int] = None,
                 provision_reversals: Optional[int] = None,
                 capitalized_own_work: Optional[int] = None,
                 filed_net_income_121: Optional[int] = None) -> None:
        self.revenue = revenue
        self.cogs = cogs
        self.opex = opex
        self.depreciation = depreciation
        self.interest_expense = interest_expense
        self.interest_income = interest_income
        self.pretax = pretax
        self.income_tax = income_tax
        self.net_income = net_income
        self.filed_net_income_121 = filed_net_income_121
        self.ebitda = ebitda
        self.other_operating_income = other_operating_income
        self.financial_income = financial_income
        self.financial_expense_total = financial_expense_total
        self.provision_reversals = provision_reversals
        self.capitalized_own_work = capitalized_own_work

    # ── the two NET figures the model has a line for but the book does
    # not name directly. Both are differences, so both are ABSENT when
    # the total they are taken from is absent — never "the total minus
    # nothing".
    def other_financial_income(self) -> Optional[int]:
        """Financial income that is NOT interest on cash.

        The model prices interest on the cash IT projects, so the interest
        component of the book's financial income would be charged twice if
        it were carried here as well. When the book names a financial
        income total but no interest component, the whole total is
        non-interest as far as this book can tell — and the model then
        prices no interest income either, so nothing is double counted.
        """
        if self.financial_income is None:
            return None
        return self.financial_income - (self.interest_income or 0)

    def other_financial_expense(self) -> Optional[int]:
        """Financial expense that is NOT interest on debt — the same
        argument as :meth:`other_financial_income`, on the other side."""
        if self.financial_expense_total is None:
            return None
        return self.financial_expense_total - (self.interest_expense or 0)

    def unexplained_vs_filed(self) -> Optional[int]:
        """How far the reconstructed result falls short of the FILED one.

        The book states its profit twice: once as the build-up this model
        reads (``pretax`` less ``income_tax``) and once as the legal
        figure closed into account 121 (``net_income_statutory``). The
        bridge between them has exactly one nameable component —
        capitalised own work — and whatever is left over is the part the
        source data cannot attribute to anything.

        Recomputed here from the four figures this model already spends,
        rather than read from the payload's own ``net_income_-
        unexplained_vs_121`` field, so the model carries ONE authority for
        it and cannot drift from a second reader. The two are asserted
        equal on every committed book by
        ``tests/engine/test_forecast_model.py``.

        ABSENT != ZERO: None when the book does not carry enough to
        compute it, which is not the same fact as a reconstruction that
        ties.
        """
        if self.pretax is None or self.income_tax is None:
            return None
        # ⚠ MEASURED AGAINST THE FILED BALANCE, NOT `net_income_statutory`.
        #
        # This read `self.net_income`, which is `assembled_pl.
        # net_income_statutory` — and that is only the FILED figure when
        # the Romanian assembly's anchor override fired.
        # `chart_of_accounts.py:1108-1113` overrides it only when the miss
        # exceeds `max(|account 121|, 100_000) * 0.05`. Below that band,
        # AND when there is no account-121 row at all, it stays the
        # RECONSTRUCTION — so this computed `reconstruction - reconstruction
        # = 0` and reported "nothing unexplained" on a book that misses its
        # filed profit.
        #
        # Measured through the real `assemble_statements` on a micro-SRL
        # (build-up 19,000.00): a book filing 15,000.00 — a 26.7% miss —
        # and a book with NO 121 row both reported 0 and both took a
        # `derived 5.0000%` tax rate into a five-year plan, charging
        # 5,527.84 where the statutory rate charges 17,689.11. The
        # 100,000 RON floor makes the tolerated miss unbounded as a
        # percentage, and this platform explicitly serves small books.
        #
        # The filed balance is published whether or not the override fired,
        # at `envelope.canonical_bs.invariants.p121_cross_check.p121`, so
        # nothing upstream had to change.
        if self.filed_net_income_121 is None:
            # ABSENT != ZERO. No account-121 balance survived, so the
            # build-up was never checked against anything — which is not
            # the same fact as a build-up that ties.
            return None
        reconstructed = self.pretax - self.income_tax
        return (self.filed_net_income_121 - reconstructed
                - (self.capitalized_own_work or 0))

    def as_dict(self) -> Dict[str, Any]:
        from .money import to_float
        out = {}
        for name in self.__slots__:
            value = getattr(self, name)
            out[name] = None if value is None else to_float(value)
        for name in ("other_financial_income", "other_financial_expense",
                     "unexplained_vs_filed"):
            value = getattr(self, name)()
            out[name] = None if value is None else to_float(value)
        return out


def pl_history_from_payload(payload: Dict[str, Any]) -> PlHistory:
    """Read the source P&L off a captured/served period payload.

    ``opex`` is ``opex_excluding_cogs_and_da`` deliberately: the forecast
    charges depreciation on its own roll-forward schedule, so an opex
    driver that already contained D&A would charge it twice.

    EVERY named income the payload carries is read here, including the
    ones no driver used to consume. A figure this reader declines to
    look at is a figure the projection silently drops, and the reader of
    the projection then sees the book's own pre-tax result and the
    model's beside each other in one object with nothing saying why they
    differ. Reading it is what makes the difference either modelled or
    stated.
    """
    statements = payload.get("statements")
    if not isinstance(statements, dict):
        statements = payload
    pl = statements.get("assembled_pl")
    if not isinstance(pl, dict):
        pl = {}
    return PlHistory(
        revenue=_cents_or_none(pl.get("revenue")),
        cogs=_cents_or_none(pl.get("cogs")),
        opex=_cents_or_none(pl.get("opex_excluding_cogs_and_da")),
        depreciation=_cents_or_none(pl.get("depreciation")),
        interest_expense=_cents_or_none(pl.get("interest_expense")),
        interest_income=_cents_or_none(pl.get("interest_income")),
        pretax=_cents_or_none(pl.get("pretax")),
        income_tax=_cents_or_none(pl.get("income_tax")),
        net_income=_cents_or_none(pl.get("net_income_statutory")),
        ebitda=_cents_or_none(pl.get("ebitda")),
        other_operating_income=_cents_or_none(pl.get("other_operating_income")),
        financial_income=_cents_or_none(pl.get("financial_income")),
        financial_expense_total=_cents_or_none(
            pl.get("financial_expense_total")),
        provision_reversals=_cents_or_none(
            pl.get("other_income_781_reversals")),
        capitalized_own_work=_cents_or_none(
            pl.get("capitalized_own_work_memo")),
        # Published before the threshold test, and None when no account-121
        # row survived — see `unexplained_vs_filed` for why this and not
        # `assembled_pl.net_income_statutory`.
        filed_net_income_121=_cents_or_none(_p121_cross_check(payload)),
    )


def _p121_cross_check(payload: Dict[str, Any]) -> Any:
    """The account-121 closing balance as the canonical BS publishes it."""
    envelope = payload.get("envelope")
    envelope = envelope if isinstance(envelope, dict) else {}
    canonical = envelope.get("canonical_bs")
    canonical = canonical if isinstance(canonical, dict) else {}
    invariants = canonical.get("invariants")
    invariants = invariants if isinstance(invariants, dict) else {}
    block = invariants.get("p121_cross_check")
    block = block if isinstance(block, dict) else {}
    return block.get("p121")
