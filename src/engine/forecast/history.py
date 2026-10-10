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
                 "capitalized_own_work", "filed_net_income_121",
                 "pretax_before_stock_variation",
                 "ebitda_before_stock_variation", "inventory_variation",
                 "inventory_variation_provenance", "ebitda_refusal",
                 "inventory_flow", "inventory_days_refusal", "net_provisions")

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
                 filed_net_income_121: Optional[int] = None,
                 pretax_before_stock_variation: Optional[int] = None,
                 ebitda_before_stock_variation: Optional[int] = None,
                 inventory_variation: Optional[int] = None,
                 inventory_variation_provenance: Optional[str] = None,
                 ebitda_refusal: Optional[Dict[str, Any]] = None,
                 inventory_flow: Optional[int] = None,
                 inventory_days_refusal: Optional[Dict[str, Any]] = None,
                 net_provisions: Optional[int] = None) -> None:
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
        # THE RULING (2026-09-26): `ebitda` and `pretax` above are the ONE
        # definition — net 711 ("Variația stocurilor de produse") and net
        # 72x inside — and None when net 711 is refused (`ebitda_refusal`
        # says why). The build-up BEFORE both is the recurring basis the
        # plan years project (they carry net 711 = 0 and 72x = 0) and the
        # basis the tax-rate rule is keyed to.
        self.pretax_before_stock_variation = pretax_before_stock_variation
        self.ebitda_before_stock_variation = ebitda_before_stock_variation
        self.inventory_variation = inventory_variation
        self.inventory_variation_provenance = inventory_variation_provenance
        self.ebitda_refusal = ebitda_refusal
        # INVENTORY DAYS (owner spec 2026-09-26 P1, engine.ratios.
        # inventory_days): the ONE block's total flow — cost of production
        # sold + 607 — in cents, the flow the served split total divides;
        # or the block's refusal. The DIO driver is days of THIS flow.
        self.inventory_flow = inventory_flow
        self.inventory_days_refusal = inventory_days_refusal
        # NET PROVISIONS (owner ruling R2, 2026-09-28): the 6812 / 6814
        # charges less the 7812 / 7814 reversals, OUTSIDE EBITDA, between it
        # and the operating result (signed as a charge). The actual year's
        # operating result carries it; no plan year projects it (it is
        # neither a recurring cost nor a cash flow) — stated on the face of
        # the projection. None on a statement assembled before the ruling,
        # whose D&A still held the charges and whose other operating income
        # the reversals.
        self.net_provisions = net_provisions

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
        # KEYED TO THE BUILD-UP BEFORE THE STOCK VARIATION (ruling
        # 2026-09-26, design A6). Since the ruling `pretax` includes net
        # 711, and on a CLOSED book net 711 is DERIVED from account 121
        # (the bridge: 121 less every other line), so `pretax − tax`
        # reproduces 121 by construction on every such book. Measuring the
        # distance on it would report "nothing unexplained" exactly where
        # the 121 bridge filled the gap, and flip every closed manufacturer
        # onto a measured tax rate read off a figure derived from the one
        # it is checked against. So the distance is taken on the build-up
        # BEFORE net 711 — today's rule, unchanged in value — and on a
        # bridge book its whole amount IS the stock variation (named by
        # `stock_variation_in_distance`).
        pretax = self.pretax_before_stock_variation
        if pretax is None:
            pretax = self.pretax
        if pretax is None or self.income_tax is None:
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
        reconstructed = pretax - self.income_tax
        return (self.filed_net_income_121 - reconstructed
                - (self.capitalized_own_work or 0))

    def stock_variation_in_distance(self) -> Optional[int]:
        """The part of :meth:`unexplained_vs_filed` the statement NAMES
        since the ruling: net 711 when it was derived from account 121
        (provenance ``account_121_bridge``) — 0 otherwise. What remains
        after it is what no line explains."""
        if (self.inventory_variation_provenance == "account_121_bridge"
                and self.inventory_variation is not None):
            return self.inventory_variation
        return 0

    def stock_variation_step(self) -> Optional[int]:
        """Net 711 + net 72x of the actual year: the step from the book's
        EBITDA to the recurring basis the plan years project (both are
        projected at 0). None when EBITDA is refused."""
        if self.ebitda is None or self.ebitda_before_stock_variation is None:
            return None
        return self.ebitda - self.ebitda_before_stock_variation

    def as_dict(self) -> Dict[str, Any]:
        from .money import to_float
        out = {}
        for name in self.__slots__:
            value = getattr(self, name)
            if name in ("inventory_variation_provenance", "ebitda_refusal",
                        "inventory_days_refusal"):
                out[name] = value
                continue
            out[name] = None if value is None else to_float(value)
        for name in ("other_financial_income", "other_financial_expense",
                     "unexplained_vs_filed", "stock_variation_in_distance",
                     "stock_variation_step"):
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
    inventory_variation = pl.get("inventory_variation")
    if not isinstance(inventory_variation, dict):
        inventory_variation = {}
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
        pretax_before_stock_variation=_cents_or_none(
            pl.get("pretax_before_stock_variation")),
        ebitda_before_stock_variation=_cents_or_none(
            pl.get("ebitda_before_stock_variation")),
        inventory_variation=_cents_or_none(inventory_variation.get("value")),
        inventory_variation_provenance=(
            str(inventory_variation.get("provenance"))
            if inventory_variation.get("provenance") else None),
        ebitda_refusal=(dict(pl["ebitda_refusal"])
                        if isinstance(pl.get("ebitda_refusal"), dict) else None),
        inventory_flow=_inventory_flow(statements),
        inventory_days_refusal=_inventory_days_refusal(statements),
        net_provisions=_cents_or_none(
            (pl.get("net_provisions") or {}).get("value")
            if isinstance(pl.get("net_provisions"), dict) else None),
    )


def _inventory_block(statements: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    from engine.ratios.inventory_days import served_block

    return served_block(statements)


def _inventory_flow(statements: Dict[str, Any]) -> Optional[int]:
    """The served inventory-days block's total flow (cost of production sold
    + 607), in cents — None when the block is absent or refuses its total."""
    block = _inventory_block(statements)
    total = (block or {}).get("total") if isinstance(block, dict) else None
    if not isinstance(total, dict) or total.get("reason") is not None:
        return None
    flow = total.get("flow")
    return _cents_or_none(flow.get("value")) if isinstance(flow, dict) else None


def _inventory_days_refusal(statements: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The block's refusal of its total — or, when no block is served, the
    absence itself (never a fallback flow)."""
    block = _inventory_block(statements)
    if block is None:
        # Worded by the pack (refusals.inventory_days_absent), never here.
        from engine.ratios.inventory_days import pack_refusal

        return pack_refusal("inventory_days_absent")
    reason = (block.get("total") or {}).get("reason")
    return dict(reason) if isinstance(reason, dict) else None


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
