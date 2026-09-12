"""THE COMPARATIVE LINE REGISTRY — what a column may be struck on.

Each entry names one statement line: where it is read from inside an
assembled envelope, which classification buckets feed it, what unit it
carries, and the detail level a period must reach before the line means
anything.

TWO DIFFERENT MECHANISMS, and conflating them is the defect this file
exists to prevent.

  COVERAGE answers "did this period's book contain any row that feeds
  this line?" It is DATA, read off the envelope's own `lineItems`, and it
  is what makes ABSENT != ZERO real. The measured case: of 35 buckets in
  the two real Scandia books, exactly one — `ar_doubtful` — is present in
  the analytic year and absent in the condensed year. The condensed book
  has no doubtful-receivable row at all, so `ar_doubtful_gross` assembles
  to 0.0 in an envelope whose every field is dense. Read that 0.0 as a
  balance and the product reports that doubtful receivables were
  eliminated in full. Coverage is how that reads as absent instead.

  REQUIRES answers "could a book at this detail level carry this line at
  all?" It is a DECLARATION, and it belongs to the small family of
  figures that are not a sum over synthetic accounts but a subdivision of
  one — exposure by counterparty, an ageing schedule. A synthetic book
  does not disclose those at any value, so they never move against it.

A line handled by the wrong mechanism fails in a specific way. Declare a
merely-absent line as analytic-only and the product withholds a
comparison it could have made. Leave a genuinely analytic-only line to
coverage and, the day the breakdown is assembled for one period, it moves
against a period that never disclosed it.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, FrozenSet, Mapping, Optional, Sequence, Tuple

from .levels import ANALYTIC, SYNTHETIC

__all__ = [
    "UNITS",
    "UNIT_MONEY",
    "ZERO_FLOOR",
    "LineSpec",
    "LINE_SPECS",
    "spec_for",
    "unwrap_envelope",
    "coverage_from_envelope",
    "read_value",
]

#: Every figure in this registry is a money amount in the envelope's own
#: reporting currency. Declared rather than assumed: an undeclared money
#: fact is one a downstream ranker cannot order, and one a renderer will
#: eventually format as a percentage.
UNIT_MONEY = "money"
UNITS: Tuple[str, ...] = (UNIT_MONEY,)

#: Half a cent. Below it a money value is a zero: the same floor the
#: column model uses for a percentage base (`columns.PCT_BASE_FLOOR`
#: reads this name), so "zero" means one thing across the package. It
#: absorbs float representation and never admits a real balance.
ZERO_FLOOR = 0.005


@dataclass(frozen=True)
class LineSpec:
    """One comparable statement line."""

    key: str
    statement: str  # "PL" | "BS"
    label: str
    #: Path inside `envelope["statements"]`.
    path: Tuple[str, ...]
    unit: str
    #: Classification buckets that feed this line. EMPTY means the line is
    #: derived from other lines (a subtotal, a margin base) and carries no
    #: bucket of its own — coverage cannot speak to it, so presence is
    #: decided by whether the envelope holds a number.
    source_buckets: Tuple[str, ...]
    #: The detail level a period must reach for this line to mean
    #: anything. SYNTHETIC for everything a rolled-up chart can express.
    requires: str = SYNTHETIC


def _pl(key, label, field, buckets, requires=SYNTHETIC):
    return LineSpec(key="pl." + key, statement="PL", label=label,
                    path=("assembled_pl", field), unit=UNIT_MONEY,
                    source_buckets=tuple(buckets), requires=requires)


def _bs(key, label, field, buckets, requires=SYNTHETIC):
    return LineSpec(key="bs." + key, statement="BS", label=label,
                    path=("assembled_bs", field), unit=UNIT_MONEY,
                    source_buckets=tuple(buckets), requires=requires)


def _analytic(key, label, field):
    """A figure that only exists BELOW the synthetic boundary.

    It reads from `statements.supplementary`, which is where an analytic
    assembly puts a breakdown. Today the engine assembles none of these,
    so both periods read absent — which is the correct answer and not the
    interesting one. The interesting one is the day one period carries it:
    against a synthetic comparison period the answer must still be that
    the period did not disclose it, never a movement.
    """
    return LineSpec(key="analytic." + key, statement="BS", label=label,
                    path=("supplementary", field), unit=UNIT_MONEY,
                    source_buckets=(), requires=ANALYTIC)


#: The registry. Order is the render order and is deliberate: P&L top to
#: bottom, then the balance sheet, then the sub-aggregates a book may or
#: may not carry, then the analytic-only family.
LINE_SPECS: Tuple[LineSpec, ...] = (
    # ── P&L, the statement spine ─────────────────────────────────────
    _pl("revenue", "Net turnover", "revenue", ("revenue",)),
    _pl("cogs", "Cost of goods sold", "cogs", ("cogs",)),
    _pl("gross_profit", "Gross profit", "gross_profit", ()),
    _pl("opex_total", "Operating expenses", "opex_total",
        ("operatingExpenses", "opex_third_party")),
    _pl("other_operating_income", "Other operating income",
        "other_income_758", ("otherIncome",)),
    _pl("depreciation", "Depreciation & amortisation", "depreciation",
        ("depreciation",)),
    _pl("ebitda", "EBITDA", "ebitda", ()),
    _pl("ebit", "EBIT", "ebit", ()),
    _pl("interest_expense", "Interest expense", "interest_expense",
        ("interest_expense", "interestExpense")),
    _pl("interest_income", "Interest income", "interest_income",
        ("interest_income",)),
    _pl("financial_income", "Financial income", "financial_income",
        ("financial_income", "financialIncome", "fx_gain",
         "interest_income")),
    _pl("financial_expense", "Financial expense", "financial_expense_total",
        ("financialExpense", "fx_loss", "interest_expense")),
    _pl("pretax", "Profit before tax", "pretax", ()),
    _pl("tax", "Income tax", "tax", ("taxExpense",)),
    _pl("net_income", "Net income", "net_income_statutory", ()),
    # ── Balance sheet, the statement spine ───────────────────────────
    _bs("cash", "Cash & equivalents", "cash", ("cash", "cash_fx")),
    _bs("trade_receivables_net", "Trade receivables, net", "ar_net",
        ("ar", "ar_doubtful", "ar_provisions")),
    _bs("inventory", "Inventory", "inventory", ("inventory",)),
    _bs("other_current_assets", "Other current assets",
        "other_current_assets", ("otherCurrentAssets", "ar_intercompany")),
    _bs("total_current_assets", "Total current assets",
        "total_current_assets", ()),
    _bs("ppe_net", "Property, plant & equipment, net", "ppe_net",
        ("ppe", "ppe_investment", "ppe_under_construction", "ppe_advances")),
    _bs("intangibles_net", "Intangibles, net", "intangibles_net",
        ("intangibles",)),
    _bs("other_non_current_assets", "Other non-current assets",
        "other_non_current_assets", ("otherNonCurrentAssets",)),
    _bs("total_non_current_assets", "Total non-current assets",
        "total_non_current_assets", ()),
    _bs("total_assets", "Total assets", "total_assets", ()),
    _bs("trade_payables", "Trade payables", "ap", ("ap",)),
    _bs("short_term_debt", "Short-term debt", "st_debt", ("stDebt",)),
    _bs("other_current_liabilities", "Other current liabilities",
        "other_current_liabilities", ("otherCurrentLiab", "ap_dividends")),
    _bs("long_term_debt", "Long-term debt", "lt_debt", ("ltDebt",)),
    _bs("other_non_current_liabilities", "Other non-current liabilities",
        "other_non_current_liabilities", ("otherNonCurrentLiab",)),
    _bs("total_debt", "Total debt", "total_debt", ()),
    _bs("total_liabilities", "Total liabilities", "total_liabilities", ()),
    _bs("share_capital", "Share capital", "share_capital", ("shareCapital",)),
    _bs("retained_earnings", "Retained earnings", "retained_earnings",
        ("retained_earnings", "retainedEarnings")),
    _bs("other_equity", "Other equity", "other_equity",
        ("otherEquity", "equity_revaluation")),
    _bs("total_equity", "Total equity", "total_equity", ()),
    # ── Sub-aggregates a book MAY carry. Bucket-backed, so coverage —
    #    not a declaration — decides whether a period disclosed them.
    #    `ar_doubtful_gross` is the measured case: present in the real
    #    analytic year, absent from the real condensed one.
    _bs("ar_doubtful_gross", "Receivables flagged doubtful, gross",
        "ar_doubtful_gross", ("ar_doubtful",)),
    _bs("ar_provisions", "Receivable provisions", "ar_provisions",
        ("ar_provisions",)),
    _bs("ar_intercompany", "Related-party receivables", "ar_intercompany",
        ("ar_intercompany",)),
    _bs("cash_fx_component", "Cash held in foreign currency",
        "cash_fx_component", ("cash_fx",)),
    _bs("ppe_under_construction", "Assets under construction",
        "ppe_under_construction", ("ppe_under_construction",)),
    _bs("ppe_advances", "Advances on fixed assets", "ppe_advances",
        ("ppe_advances",)),
    _bs("ap_dividends", "Dividends payable", "ap_dividends",
        ("ap_dividends",)),
    _pl("opex_third_party", "Third-party services (628)",
        "opex_third_party", ("opex_third_party",)),
    # ── ANALYTIC-ONLY. A subdivision of a synthetic account, not a sum
    #    over synthetic accounts. A condensed book does not disclose
    #    these at any value, so nothing here ever moves against one.
    _analytic("related_party_exposure", "Related-party exposure, by party",
              "related_party_exposure"),
    _analytic("receivables_by_counterparty",
              "Receivable concentration, by counterparty",
              "receivables_by_counterparty"),
    _analytic("payables_by_counterparty",
              "Payable concentration, by counterparty",
              "payables_by_counterparty"),
    _analytic("receivable_ageing", "Receivable ageing schedule",
              "receivable_ageing"),
    _analytic("non_trade_receivable_split",
              "Non-trade receivables, by debtor class",
              "non_trade_receivable_split"),
)

_BY_KEY: Dict[str, LineSpec] = dict((s.key, s) for s in LINE_SPECS)


def spec_for(key: str) -> Optional[LineSpec]:
    return _BY_KEY.get(key)


def unwrap_envelope(envelope: Mapping[str, Any]) -> Mapping[str, Any]:
    """Accept either an assembled envelope (`{"statements": …}`) or a
    captured baseline (`{"assembled": {"statements": …}}`) and return the
    envelope. Raises on anything else rather than guessing — a shape this
    does not recognise is a caller bug, and defaulting to an empty dict
    would make every line read absent, which is the most dangerous
    possible failure mode for this module.
    """
    if not isinstance(envelope, Mapping):
        raise TypeError("assembled envelope must be a mapping, got %s"
                        % type(envelope).__name__)
    if "statements" in envelope:
        return envelope
    inner = envelope.get("assembled")
    if isinstance(inner, Mapping) and "statements" in inner:
        return inner
    raise ValueError(
        "not an assembled envelope: expected a 'statements' key, or an "
        "'assembled' block holding one; got keys %s"
        % sorted(str(k) for k in envelope.keys())[:12])


def coverage_from_envelope(
    envelope: Mapping[str, Any],
) -> Optional[FrozenSet[str]]:
    """The set of classification buckets this period's book actually fed.

    Returns None — not an empty set — when the envelope carries no
    `lineItems`. None means COVERAGE IS UNKNOWN and the caller must fall
    back to "a number is present"; an empty set would mean the book fed
    nothing, and reading one as the other would mark every line absent.
    """
    env = unwrap_envelope(envelope)
    items = env.get("lineItems")
    if not isinstance(items, Sequence) or isinstance(items, (str, bytes)):
        return None
    buckets = set()
    for item in items:
        if not isinstance(item, Mapping):
            continue
        bucket = item.get("canonical_bucket") or item.get("bucket")
        if bucket:
            buckets.add(str(bucket))
    return frozenset(buckets)


def read_value(
    envelope: Mapping[str, Any],
    spec: LineSpec,
    coverage: Optional[FrozenSet[str]] = None,
) -> Optional[float]:
    """This period's value for one line, or None for ABSENT.

    None — never 0.0 — when the period's book fed none of the line's
    buckets, when the path is not in the envelope, when the value is
    None, or when it is not a finite real number. A line that IS in the
    book and IS zero returns 0.0, and the two are different answers.

    COVERAGE UNKNOWN (no `lineItems` on the envelope) is not coverage
    assumed. A dense envelope holds 0.0 for every bucket-backed line the
    book never fed, and without coverage a 0.0 that was disclosed cannot
    be told from a 0.0 that stands for nothing — so, for a bucket-backed
    line, a zero under unknown coverage reads ABSENT. This is the only
    reading that never fabricates a balance: the cost is that a genuinely
    disclosed zero on an envelope with no line items is withheld, and the
    caller can see why in `ComparativeTable.*_coverage_source`. The first
    version of this function returned 0.0 here, "falling back to a number
    is present" — which is the absent-read-as-zero defect this module
    exists to refuse, wearing a label.
    """
    if spec.source_buckets and coverage is not None:
        if not any(b in coverage for b in spec.source_buckets):
            return None

    node: Any = unwrap_envelope(envelope).get("statements")
    for part in spec.path:
        if not isinstance(node, Mapping) or part not in node:
            return None
        node = node[part]

    if isinstance(node, bool) or not isinstance(node, (int, float)):
        return None
    value = float(node)
    if value != value or value in (float("inf"), float("-inf")):
        return None
    if spec.source_buckets and coverage is None and abs(value) < ZERO_FLOOR:
        return None
    return value
