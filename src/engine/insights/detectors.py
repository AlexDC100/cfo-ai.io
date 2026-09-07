"""The eight detectors — what a sharp CFO notices in a finished book.

EVERY DETECTOR OBEYS THE SAME CONTRACT
=====================================
It is handed a :class:`~engine.insights.book.Book` and its pack spec, and
it returns either a :class:`Detection` (measures, accounts, facts,
magnitude) or a :class:`NotFired` carrying the STATED GAP. There is no
third answer: a detector never returns nothing, because "the report did
not mention it" is precisely the defect this package exists to end.

WHAT A DETECTOR MAY NOT DO
==========================
  · it may not reach past `Book` into the payload;
  · it may not write its own severity (that is `severity.grade`, off the
    pack's ladder);
  · it may not write prose containing a figure (the claim is a TEMPLATE;
    the figures come from its own measures);
  · it may not turn an absent input into 0.

MEASURED ON THE FOUR COMMITTED BOOKS
====================================
See `tests/engine/test_insights_detectors.py`, which pins every value
below against the fixtures rather than describing it here in prose that
can rot.

Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .book import AccountRef, Book
from .measures import Measure
from .packdata import DetectorSpec

__all__ = ["Detection", "NotFired", "DETECTORS", "run_detector"]


class Fact(object):
    """One gateway read the detection consumed, named by its address in
    the served payload so a reader can go and check it."""

    __slots__ = ("name", "label", "value", "unit")

    def __init__(self, name: str, label: str, value: Optional[float],
                 unit: str) -> None:
        self.name = name
        self.label = label
        self.value = None if value is None else float(value)
        self.unit = unit

    def as_dict(self) -> Dict[str, Any]:
        value = self.value
        if value is not None:
            value = round(value, 2 if self.unit in ("money", "count") else 6)
        return {"name": self.name, "label": self.label, "value": value,
                "unit": self.unit}


class Detection(object):
    """`variant` selects one of the pack's `claim_variants` when the same
    detector has two genuinely different things to say — "this book earns
    more on financial assets than it pays on debt" is not a sign flip of
    "it pays more than it earns", it is a different sentence. Writing one
    sentence that covers both would mean prose that reads around its own
    finding. `""` uses the detector's single `claim`."""

    __slots__ = ("magnitude", "measures", "accounts", "facts", "variant")

    def __init__(self, magnitude: Optional[float], measures: Sequence[Measure],
                 accounts: Sequence[AccountRef], facts: Sequence[Fact],
                 variant: str = "") -> None:
        self.magnitude = magnitude
        self.measures = list(measures)
        self.accounts = list(accounts)
        self.facts = list(facts)
        self.variant = variant


class NotFired(object):
    """The stated gap. `reason` is a sentence a reader can act on."""

    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason


def _fact_pl(book: Book, key: str, label: str, unit: str = "money") -> Fact:
    return Fact("assembled_pl.%s" % key, label, book.pl(key), unit)


def _fact_bs(book: Book, key: str, label: str, unit: str = "money") -> Fact:
    return Fact("assembled_bs.%s" % key, label, book.bs(key), unit)


def _fact_row(book: Book, row_ids: Sequence[str], name: str, label: str) -> Fact:
    return Fact("canonical_bs.rows[%s]" % "+".join(row_ids), label,
                book.row_sum(row_ids), "money")


def _div(numerator: Optional[float], denominator: Optional[float]
         ) -> Optional[float]:
    """ABSENT != ZERO, and a zero denominator is ABSENT, not infinity."""
    if numerator is None or denominator is None:
        return None
    if abs(denominator) < 1e-9:
        return None
    return numerator / denominator


# ══ 1. ASSET AGE ══════════════════════════════════════════════════════


def detect_asset_age(book: Book, spec: DetectorSpec):
    gross_rows = spec.rows.get("gross_ppe", ())
    dep_rows = spec.rows.get("accumulated_depreciation", ())
    int_rows = spec.rows.get("gross_intangibles", ())
    amort_rows = spec.rows.get("accumulated_amortization", ())

    gross = book.row_sum(gross_rows)
    accumulated = book.row_sum(dep_rows)
    if gross is None or gross <= 0.0:
        return NotFired(
            "The book carries no gross PP&E rows, so there is no asset base "
            "to age."
        )
    if accumulated is None:
        return NotFired(
            "Gross PP&E of %s is reported but no accumulated-depreciation row "
            "is, so the depreciated share cannot be stated." % _plain(gross)
        )

    accumulated_abs = abs(accumulated)
    depreciated_share = accumulated_abs / gross
    net_book_value = gross - accumulated_abs

    gross_int = book.row_sum(int_rows)
    amort_int = book.row_sum(amort_rows)
    amort_share = None
    if gross_int is not None and gross_int > 0.0 and amort_int is not None:
        amort_share = abs(amort_int) / gross_int

    annual_da = book.pl("depreciation")
    intangible_nbv = None
    if gross_int is not None and amort_int is not None:
        intangible_nbv = gross_int - abs(amort_int)
    total_nbv = net_book_value + (intangible_nbv or 0.0)
    remaining_life = _div(total_nbv, annual_da)
    if remaining_life is not None and remaining_life < 0.0:
        remaining_life = None

    measures = [
        Measure("depreciated_share", "Depreciated share of gross PP&E",
                depreciated_share, "ratio"),
        Measure("gross_ppe", "Gross PP&E", gross, "money"),
        Measure("accumulated_depreciation", "Accumulated depreciation",
                accumulated_abs, "money"),
        Measure("net_book_value", "Net book value (PP&E and intangibles)",
                total_nbv, "money"),
        Measure("intangible_amortised_share",
                "Amortised share of gross intangibles", amort_share, "ratio"),
        Measure("annual_da", "Annual depreciation and amortisation charge",
                annual_da, "money"),
        Measure("remaining_book_life", "Remaining book life at current charge",
                remaining_life, "years"),
    ]
    accounts = (
        book.accounts_for(gross_rows, "gross_ppe")
        + book.accounts_for(dep_rows, "accumulated_depreciation")
        + book.accounts_for(int_rows, "gross_intangibles")
        + book.accounts_for(amort_rows, "accumulated_amortization")
    )
    facts = [
        _fact_row(book, gross_rows, "gross_ppe", "Gross PP&E"),
        _fact_row(book, dep_rows, "accumulated_depreciation",
                  "Accumulated depreciation"),
        _fact_row(book, int_rows, "gross_intangibles", "Gross intangibles"),
        _fact_row(book, amort_rows, "accumulated_amortization",
                  "Accumulated amortisation"),
        _fact_pl(book, "depreciation", "D&A charge for the period"),
    ]
    return Detection(accumulated_abs, measures, accounts, facts)


# ══ 2. QUALITY OF LIQUIDITY ═══════════════════════════════════════════


def detect_liquidity_quality(book: Book, spec: DetectorSpec):
    non_trade_rows = spec.rows.get("non_trade", ())
    current_assets = book.bs("total_current_assets")
    current_liabilities = book.bs("total_current_liabilities")
    cash = book.bs("cash")
    non_trade = book.row_sum(non_trade_rows)

    if current_assets is None or current_liabilities is None:
        return NotFired(
            "Total current assets or total current liabilities are not "
            "reported, so no liquidity ratio can be recomputed."
        )
    if current_liabilities <= 0.0:
        return NotFired(
            "Current liabilities are not positive on this book, so a current "
            "ratio has no denominator to be graded against."
        )
    if non_trade is None:
        return NotFired(
            "The book carries no intercompany, other-debtor, supplier-advance "
            "or tax-recoverable rows, so headline liquidity is already "
            "trade-only and there is nothing to restate."
        )

    current_ratio = current_assets / current_liabilities
    trade_only = (current_assets - non_trade) / current_liabilities
    cash_ratio = cash / current_liabilities if cash is not None else None
    quick = None
    inventory = book.bs("inventory")
    if inventory is not None:
        quick = (current_assets - inventory) / current_liabilities

    measures = [
        Measure("current_ratio", "Current ratio as reported", current_ratio,
                "multiple"),
        Measure("current_ratio_trade_only",
                "Current ratio, non-trade receivables removed", trade_only,
                "multiple"),
        Measure("ratio_delta", "Movement in the current ratio",
                current_ratio - trade_only, "multiple"),
        Measure("non_trade", "Non-trade receivables removed", non_trade,
                "money"),
        Measure("quick_ratio", "Quick ratio as reported", quick, "multiple"),
        Measure("cash_ratio", "Cash ratio as reported", cash_ratio, "multiple"),
    ]
    facts = [
        _fact_bs(book, "total_current_assets", "Total current assets"),
        _fact_bs(book, "total_current_liabilities", "Total current liabilities"),
        _fact_bs(book, "cash", "Cash and equivalents"),
        _fact_bs(book, "inventory", "Inventory"),
        _fact_row(book, non_trade_rows, "non_trade",
                  "Non-trade receivables inside current assets"),
    ]
    return Detection(non_trade, measures,
                     book.accounts_for(non_trade_rows, "non_trade_receivable"),
                     facts)


# ══ 3. RELATED-PARTY EXPOSURE ═════════════════════════════════════════


def detect_related_party_exposure(book: Book, spec: DetectorSpec):
    rows = spec.rows.get("related_party", ())
    exposure = book.row_sum(rows)
    total_assets = book.bs("total_assets")
    equity = book.bs("total_equity")

    if exposure is None:
        return NotFired(
            "No intercompany or related-party receivable row is present in "
            "the classified balance sheet."
        )
    if abs(exposure) < 0.005:
        return NotFired(
            "The intercompany row is present and nets to nil, so there is no "
            "related-party exposure to haircut."
        )

    share_assets = _div(exposure, total_assets)
    share_equity = _div(exposure, equity)
    equity_ratio = _div(equity, total_assets)
    equity_ratio_haircut = None
    if equity is not None and total_assets is not None:
        haircut_assets = total_assets - exposure
        if abs(haircut_assets) > 1e-9:
            equity_ratio_haircut = (equity - exposure) / haircut_assets

    current_assets = book.bs("total_current_assets")
    current_liabilities = book.bs("total_current_liabilities")
    current_ratio = _div(current_assets, current_liabilities)
    current_ratio_haircut = None
    if current_assets is not None and current_liabilities is not None \
            and current_liabilities > 0.0:
        current_ratio_haircut = (current_assets - exposure) / current_liabilities

    net_debt = None
    total_debt = book.bs("total_debt")
    cash = book.bs("cash")
    if total_debt is not None and cash is not None:
        net_debt = total_debt - cash
    ebitda = book.pl("ebitda")
    leverage = _div(net_debt, ebitda) if (ebitda is not None and ebitda > 0.0) \
        else None

    measures = [
        Measure("related_party", "Related-party and other-debtor receivables",
                exposure, "money"),
        Measure("share_of_assets", "Share of total assets", share_assets,
                "ratio"),
        Measure("share_of_equity", "Share of total equity", share_equity,
                "ratio"),
        Measure("equity_ratio", "Equity ratio as reported", equity_ratio,
                "ratio"),
        Measure("equity_ratio_haircut", "Equity ratio at a 100% haircut",
                equity_ratio_haircut, "ratio"),
        Measure("current_ratio", "Current ratio as reported", current_ratio,
                "multiple"),
        Measure("current_ratio_haircut", "Current ratio at a 100% haircut",
                current_ratio_haircut, "multiple"),
        Measure("net_debt_ebitda", "Net debt ÷ EBITDA as reported", leverage,
                "multiple"),
    ]
    facts = [
        _fact_row(book, rows, "related_party", "Related-party receivables"),
        _fact_bs(book, "total_assets", "Total assets"),
        _fact_bs(book, "total_equity", "Total equity"),
        _fact_bs(book, "total_current_assets", "Total current assets"),
        _fact_bs(book, "total_current_liabilities", "Total current liabilities"),
    ]
    return Detection(abs(exposure), measures,
                     book.accounts_for(rows, "related_party"), facts)


# ══ 4. RECONSTRUCTION GAP MATERIALITY ═════════════════════════════════


def detect_reconstruction_gap(book: Book, spec: DetectorSpec):
    step = book.pl("net_income_reconciliation_to_121")
    if step is None:
        step = book.pl("net_income_unexplained_vs_121")
    reconstructed = book.pl("net_income_operational")
    statutory = book.pl("net_income_statutory")

    if step is None:
        return NotFired(
            "The payload carries no reconciliation step to account 121, so "
            "the reconstruction cannot be compared with statutory profit."
        )
    if abs(step) < 0.005:
        return NotFired(
            "The reconstructed P&L reaches statutory profit exactly; there is "
            "no bridging step to report."
        )

    # ONE CONCEPT, ONE VALUE. The share printed in the claim must be the
    # share the severity was graded on, or the card states two different
    # percentages for the same idea. `_graded_share` picks the same base
    # `severity.grade` will pick — primary if usable, else the declared
    # fallback — and returns the share and the base together.
    share, base_value, base_label = _graded_share(book, spec, abs(step))

    measures = [
        Measure("step", "Reconciliation to account 121", step, "money"),
        Measure("reconstructed", "Net income rebuilt from the movements",
                reconstructed, "money"),
        Measure("statutory", "Net income in account 121", statutory, "money"),
        Measure("graded_share", "Step as a share of %s" % base_label.lower(),
                share, "ratio"),
        Measure("graded_base", base_label, base_value, "money"),
    ]
    facts = [
        _fact_pl(book, "net_income_reconciliation_to_121",
                 "Reconciliation to account 121"),
        _fact_pl(book, "net_income_operational",
                 "Net income rebuilt from the movements"),
        _fact_pl(book, "net_income_statutory", "Net income in account 121"),
        _fact_pl(book, "revenue", "Revenue"),
    ]
    accounts = book.accounts_for(("current_year_profit", "current_year_loss"),
                                "account_121")
    return Detection(abs(step), measures, accounts, facts)


# ══ 5. TRADE FLOAT ════════════════════════════════════════════════════


def detect_trade_float(book: Book, spec: DetectorSpec):
    ar_rows = spec.rows.get("trade_receivables", ())
    ap_rows = spec.rows.get("trade_payables", ())
    receivables = book.row_sum(ar_rows)
    payables = book.row_sum(ap_rows)
    revenue = book.pl("revenue")
    cogs = book.pl("cogs")
    if cogs is None:
        cogs = book.pl("cost_of_goods_sold")

    if receivables is None and payables is None:
        return NotFired(
            "Neither a trade-receivable nor a trade-payable row is present, "
            "so there is no trade cycle to measure."
        )
    if revenue is None or revenue <= 0.0:
        return NotFired(
            "Revenue is not positive on this book, so days-sales-outstanding "
            "has no annualisation base and the float cannot be dated."
        )

    dso = None
    if receivables is not None:
        dso = receivables / revenue * 365.0
    dpo = None
    if payables is not None and cogs is not None and cogs > 0.0:
        dpo = payables / cogs * 365.0
    float_days = None
    if dso is not None and dpo is not None:
        float_days = dso - dpo
    float_money = None
    if receivables is not None and payables is not None:
        float_money = receivables - payables

    measures = [
        Measure("dso", "Days sales outstanding", dso, "days"),
        Measure("dpo", "Days payables outstanding", dpo, "days"),
        Measure("float_days", "Collection gap (DSO − DPO)", float_days, "days"),
        Measure("float", "Net trade float (receivables − payables)",
                float_money, "money"),
        Measure("trade_receivables", "Trade receivables net of provisions",
                receivables, "money"),
        Measure("trade_payables", "Trade payables", payables, "money"),
        Measure("cogs", "Cost of goods sold", cogs, "money"),
    ]
    facts = [
        _fact_row(book, ar_rows, "trade_receivables",
                  "Trade receivables net of provisions"),
        _fact_row(book, ap_rows, "trade_payables", "Trade payables"),
        _fact_pl(book, "revenue", "Revenue"),
        _fact_pl(book, "cogs", "Cost of goods sold"),
    ]
    accounts = (book.accounts_for(ar_rows, "trade_receivable")
                + book.accounts_for(ap_rows, "trade_payable"))
    magnitude = None if float_money is None else abs(float_money)
    return Detection(magnitude, measures, accounts, facts)


# ══ 6. FINANCIAL POSITION ═════════════════════════════════════════════


def detect_financial_position(book: Book, spec: DetectorSpec):
    income = book.pl("financial_income")
    expense = book.pl("financial_expense_total")
    if expense is None:
        expense = book.pl("financial_expense")
    net = book.pl("net_financial_result")
    if net is None and income is not None and expense is not None:
        net = income - expense

    if net is None:
        return NotFired(
            "Neither a financial income nor a financial expense figure is "
            "reported, so there is no financial result to weigh against "
            "operating earnings."
        )
    if abs(net) < 0.005 and (income is None or abs(income) < 0.005):
        return NotFired(
            "The financial result nets to nil and no financial income or "
            "expense is reported."
        )

    ebitda = book.pl("ebitda")
    share, base_value, base_label = _graded_share(book, spec, abs(net))

    interest_expense = book.pl("interest_expense")
    interest_income = book.pl("interest_income")

    measures = [
        Measure("financial_income", "Financial income", income, "money"),
        Measure("financial_expense", "Financial expense", expense, "money"),
        Measure("net_financial", "Net financial result", net, "money"),
        Measure("graded_share",
                "Net financial result as a share of %s" % base_label.lower(),
                share, "ratio"),
        Measure("graded_base", base_label, base_value, "money"),
        Measure("interest_expense", "Interest expense", interest_expense,
                "money"),
        Measure("interest_income", "Interest income", interest_income, "money"),
        Measure("ebitda", "EBITDA", ebitda, "money"),
    ]
    facts = [
        _fact_pl(book, "financial_income", "Financial income"),
        _fact_pl(book, "financial_expense_total", "Financial expense"),
        _fact_pl(book, "net_financial_result", "Net financial result"),
        _fact_pl(book, "interest_expense", "Interest expense"),
        _fact_pl(book, "interest_income", "Interest income"),
        _fact_pl(book, "ebitda", "EBITDA"),
    ]
    accounts = _pl_accounts(book, ("financialIncome", "financialExpense",
                                  "interestExpense", "interestIncome"))
    variant = "earns" if net > 0.0 else "pays"
    return Detection(abs(net), measures, accounts, facts, variant)


# ══ 7. EARNINGS QUALITY ═══════════════════════════════════════════════


def detect_earnings_quality(book: Book, spec: DetectorSpec):
    ebitda = book.pl("ebitda")
    other_income = book.pl("other_operating_income")
    if other_income is None:
        parts = [book.pl("other_income_758"), book.pl("other_income_781_reversals")]
        present = [p for p in parts if p is not None]
        other_income = sum(present) if present else None
    reversals = book.pl("other_income_781_reversals")
    capitalised = book.pl("capitalized_own_work_memo")
    cash_proxy = book.pl("free_cash_flow_proxy")

    if ebitda is None:
        return NotFired(
            "EBITDA is not reported, so the non-trading share of it cannot be "
            "stated."
        )
    if other_income is None and capitalised is None:
        return NotFired(
            "No other-operating-income, provision-reversal or capitalised-own-"
            "work figure is reported, so every currency unit of EBITDA is "
            "already trading margin."
        )

    non_trading = (other_income or 0.0) + (capitalised or 0.0)
    share, base_value, base_label = _graded_share(book, spec, abs(non_trading))
    conversion = None
    if cash_proxy is not None and ebitda is not None and abs(ebitda) > 0.005:
        conversion = cash_proxy / ebitda

    measures = [
        Measure("non_trading", "Other operating income and provision reversals",
                non_trading, "money"),
        Measure("ebitda", "EBITDA", ebitda, "money"),
        Measure("graded_share",
                "Non-trading income as a share of %s" % base_label.lower(),
                share, "ratio"),
        Measure("graded_base", base_label, base_value, "money"),
        Measure("provision_reversals", "Provision reversals (781)", reversals,
                "money"),
        Measure("capitalised_own_work", "Capitalised own work", capitalised,
                "money"),
        Measure("cash_proxy", "Operating cash proxy", cash_proxy, "money"),
        Measure("cash_conversion", "Operating cash proxy ÷ EBITDA", conversion,
                "ratio"),
    ]
    facts = [
        _fact_pl(book, "ebitda", "EBITDA"),
        _fact_pl(book, "other_operating_income", "Other operating income"),
        _fact_pl(book, "other_income_781_reversals", "Provision reversals"),
        _fact_pl(book, "capitalized_own_work_memo", "Capitalised own work"),
        _fact_pl(book, "free_cash_flow_proxy", "Operating cash proxy"),
    ]
    accounts = _pl_accounts(book, ("otherIncome",), exclude_prefixes=("711",))
    return Detection(abs(non_trading), measures, accounts, facts)


# ══ 8. UNCLASSIFIED / DORMANT BALANCES ════════════════════════════════


def detect_unclassified_balances(book: Book, spec: DetectorSpec):
    rows = spec.rows.get("unclassified", ())
    row_total = book.row_sum(rows)
    unmapped = book.unmapped()

    codes = []  # type: List[str]
    accounts = []  # type: List[AccountRef]
    for entry in unmapped:
        code = str(entry.get("code") or "")
        if not code:
            continue
        debit = _as_float(entry.get("sf_d"))
        credit = _as_float(entry.get("sf_c"))
        amount = (debit or 0.0) - (credit or 0.0)
        codes.append(code)
        accounts.append(AccountRef(code, str(entry.get("name") or ""), amount,
                                   "unclassified"))
    if not accounts and rows:
        accounts = book.accounts_for(rows, "unclassified")
        codes = [a.code for a in accounts]

    magnitude = None
    if accounts:
        magnitude = sum(abs(a.amount) for a in accounts)
    elif row_total is not None:
        magnitude = abs(row_total)

    if magnitude is None or magnitude < 0.005:
        return NotFired(
            "Every account in the book matched a classification rule; no "
            "balance is carried under an Unclassified row."
        )

    diagnosis_codes = tuple(str(d.get("code") or "") for d in book.diagnoses())
    total_assets = book.bs("total_assets")

    measures = [
        Measure("unclassified", "Unclassified balances", magnitude, "money"),
        Measure("account_count", "Accounts affected", float(len(accounts)),
                "count", noun="account"),
        Measure("share_of_assets", "Share of total assets",
                _div(magnitude, total_assets), "ratio"),
        Measure("balance_sheet_delta",
                "Balance-sheet delta the payload reports",
                book.bs("bs_balance_delta"), "money"),
    ]
    facts = [
        Fact("canonical_bs.unmapped", "Accounts the pack matched no rule for",
             float(len(accounts)), "count"),
        Fact("canonical_bs.diagnosis",
             "Diagnosis codes raised: %s" % (", ".join(diagnosis_codes) or "none"),
             float(len(diagnosis_codes)), "count"),
        _fact_bs(book, "bs_balance_delta", "Balance-sheet delta"),
        _fact_bs(book, "total_assets", "Total assets"),
    ]
    return Detection(magnitude, measures, accounts, facts)


# ── shared helpers ────────────────────────────────────────────────────


def _graded_share(book: Book, spec: DetectorSpec, magnitude: Optional[float]):
    """The share the SEVERITY will be graded on, and the base it used.

    `severity.grade` picks the primary basis, or the declared fallback
    when the primary is unusable. A detector that computes its claim's
    percentage against a base of its own choosing will print a different
    number from the severity chip for the same idea — measured on the
    realestate book, the earnings-quality claim said 0.1% while its own
    severity said 10.2%. One concept, one value: both come from here."""
    basis_name = spec.basis
    basis_label = spec.basis_label
    value = book.basis(basis_name)
    if value is None and spec.basis_fallback:
        fallback = book.basis(str(spec.basis_fallback))
        if fallback is not None:
            basis_name = str(spec.basis_fallback)
            basis_label = _BASIS_LABELS.get(basis_name, basis_name)
            value = fallback
    share = _div(magnitude, value)
    return share, value, basis_label


#: Labels for a fallback base, mirrored from `severity._FALLBACK_LABELS`
#: so a claim and a severity chip name the same base the same way.
_BASIS_LABELS = {
    "revenue": "Revenue",
    "total_assets": "Total assets",
    "total_equity": "Total equity",
    "ebitda": "EBITDA",
    "ebitda_positive": "EBITDA",
    "gross_ppe": "Gross PP&E",
    "total_current_liabilities": "Total current liabilities",
    "reconstructed_net_income": "Reconstructed net income",
}


def _as_float(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _pl_accounts(book: Book, buckets: Sequence[str],
                 exclude_prefixes: Sequence[str] = ()) -> List[AccountRef]:
    """P&L accounts by the engine's OWN bucket assignment.

    The balance sheet has canonical rows carrying their account codes; the
    P&L does not, so the bucket the assembler already wrote on each line
    item is the authority here. `exclude_prefixes` drops the 711
    production-variation memo from the other-income listing — it is a
    stock movement, not income, and the assembled P&L keeps it out of
    `other_operating_income` too."""
    out = []  # type: List[AccountRef]
    wanted = set(buckets)
    for li in book._line_items:  # noqa: SLF001 — Book is this package's own
        if li.get("statement") != "PL":
            continue
        bucket = str(li.get("bucket") or "")
        if bucket not in wanted:
            continue
        code = str(li.get("ro_account_code") or "")
        if any(code.startswith(p) for p in exclude_prefixes):
            continue
        amount = _as_float(li.get("amount"))
        if amount is None:
            continue
        out.append(AccountRef(code, str(li.get("ro_account_name") or ""),
                              amount, bucket))
    return out


def _plain(value: float) -> str:
    return "{:,.2f}".format(value)


#: id -> implementation. The pack declares the metadata; this maps it to
#: the arithmetic. A pack entry with no implementation here, or an
#: implementation with no pack entry, is a wiring error and
#: `build_insights` raises on it rather than skipping quietly.
DETECTORS = {
    "asset_age": detect_asset_age,
    "liquidity_quality": detect_liquidity_quality,
    "related_party_exposure": detect_related_party_exposure,
    "reconstruction_gap": detect_reconstruction_gap,
    "trade_float": detect_trade_float,
    "financial_position": detect_financial_position,
    "earnings_quality": detect_earnings_quality,
    "unclassified_balances": detect_unclassified_balances,
}  # type: Dict[str, Callable[[Book, DetectorSpec], Any]]


def run_detector(detector_id: str, book: Book, spec: DetectorSpec):
    impl = DETECTORS.get(detector_id)
    if impl is None:
        raise KeyError(
            "pack declares detector %r but engine.insights.detectors has no "
            "implementation for it; implemented: %s"
            % (detector_id, ", ".join(sorted(DETECTORS)))
        )
    return impl(book, spec)
