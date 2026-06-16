"""F3.2 — Universal canonical financial model.

This module formalises the dict shape every country pack's
`assemble_statements()` method must return. The Romanian pack already
conforms by definition (it produced the shape originally); the type
declarations below DOCUMENT the contract that any future pack must
also satisfy.

# Why TypedDict, not dataclasses

The existing engine output is a nested dict of plain Python primitives
(int, float, str, list, dict). TypedDicts let us add type information
WITHOUT changing the runtime shape — no migration, no risk of breaking
F-A3.1 / F3.1-PARITY. A future refactor can swap TypedDicts for
Pydantic models or dataclasses; that's a separate workstream.

# Validation

`validate_canonical_envelope(envelope)` checks structural conformance:
required keys present, types correct, nested shapes conform. Returns
a `ValidationReport` listing any violations. It does NOT check
numerical correctness (that's F-A3.1's job) — only that the shape is
right so downstream consumers (FE, briefing layer, ratio calculator)
can rely on a contract.

# Field naming convention

All canonical fields use `snake_case`. The two "legacy view"
sub-objects (`balanceSheet` and `incomeStatement`) preserve camelCase
because the TypeScript Statements interface on the FE consumes them
directly (matching that interface byte-for-byte avoids an FE-side
remap layer).

# F3.2 scope

This file lands the contract + validator. Pipeline integration (asserts
at write time, exposing the validation result in the API response) is
out of scope for F3.2 — those land if/when the validator catches
something in a real pipeline run.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, TypedDict


# ─────────────────────────────────────────────────────────────────────
# 1. Legacy "view" sub-objects (camelCase, FE Statements interface)
# ─────────────────────────────────────────────────────────────────────

class BalanceSheetLegacyView(TypedDict, total=True):
    """The FE's TS `BalanceSheet` interface. Camel-cased keys; every
    field is a float in the source currency. Values are signed:
    asset/equity/liability buckets all carry positive values (the
    sign-flip happens upstream during account mapping).
    """
    cash: float
    accountsReceivable: float
    inventory: float
    otherCurrentAssets: float
    propertyPlantEquipment: float
    intangibles: float
    otherNonCurrentAssets: float
    accountsPayable: float
    shortTermDebt: float
    otherCurrentLiabilities: float
    longTermDebt: float
    otherNonCurrentLiabilities: float
    shareCapital: float
    retainedEarnings: float
    otherEquity: float


class IncomeStatementLegacyView(TypedDict, total=True):
    """The FE's TS `IncomeStatement` interface. `capitalizedOwnWork`
    and `inventoryVariationMemo` are memo fields — surfaced for
    transparency but excluded from headline revenue / EBITDA.
    """
    revenue: float
    costOfGoodsSold: float
    operatingExpenses: float
    depreciationAmortization: float
    interestExpense: float
    otherIncome: float
    financialIncome: float
    financialExpense: float
    taxExpense: float
    capitalizedOwnWork: float
    inventoryVariationMemo: float


class SupplementaryFields(TypedDict, total=True):
    """Period-level helpers the FE's `computeRatios()` reads."""
    periodDays: int   # 365 for FY, 90 for Q, etc.


# ─────────────────────────────────────────────────────────────────────
# 2. Sub-aggregates (memo carve-outs)
# ─────────────────────────────────────────────────────────────────────

class SubAggregates(TypedDict, total=False):
    """Sub-aggregate carve-outs the BS legacy view sums into a single
    bucket. The FE renders these as "of which" disclosure rows. All
    fields optional — country packs only populate what their chart of
    accounts can distinguish.
    """
    ap_dividends: float
    ppe_investment: float
    interest_expense: float
    opex_third_party: float
    fx_gain: float
    retained_earnings: float
    ar_provisions: float
    ar_intercompany: float
    ppe_advances: float
    ar_doubtful: float
    ppe_under_construction: float
    interest_income: float
    financial_income: float
    fx_loss: float
    equity_revaluation: float
    cash_fx: float
    current_year_pnl: float


# ─────────────────────────────────────────────────────────────────────
# 3. Canonical balance sheet (assembled_bs)
# ─────────────────────────────────────────────────────────────────────

class AssembledBalanceSheet(TypedDict, total=True):
    """Canonical balance sheet — the source of truth for the FE BS
    tab + KPI tiles + valuation envelope. Keys are snake_case.

    Required fields are the universals (total_assets, total_equity,
    total_liabilities, total_debt, lt_debt, st_debt, cash, ar_net,
    ppe_net, intangibles_net, bs_balance_delta). Country packs may
    add country-specific sub-aggregates (e.g. RO `ar_intercompany`)
    — those go in an optional schema below.
    """
    # Universals
    cash: float
    ar_net: float
    inventory: float
    ppe_net: float
    intangibles_net: float
    total_assets: float
    ap: float
    st_debt: float
    lt_debt: float
    total_debt: float
    total_liabilities: float
    total_equity: float
    share_capital: float
    retained_earnings: float
    bs_balance_delta: float


class AssembledBalanceSheetOptional(TypedDict, total=False):
    """Optional balance-sheet fields. Country packs populate as
    available. The validator does NOT require these — but documents
    them so the FE can render them when present."""
    cash_fx_component: float
    ar_doubtful_gross: float
    ar_provisions: float
    ar_intercompany: float
    ar_other: float
    ppe_investment_net: float
    ppe_under_construction: float
    ppe_advances: float
    investments: float
    ap_dividends: float
    ap_other: float
    revaluation_reserves: float
    other_equity_non_revaluation: float
    current_year_pnl: float
    accounts_receivable: float
    other_current_assets: float
    property_plant_equipment: float
    intangibles: float
    other_non_current_assets: float
    accounts_payable: float
    short_term_debt: float
    other_current_liabilities: float
    long_term_debt: float
    other_non_current_liabilities: float
    other_equity: float
    total_current_assets: float
    total_non_current_assets: float
    total_current_liabilities: float
    total_non_current_liabilities: float


# ─────────────────────────────────────────────────────────────────────
# 4. Canonical P&L (assembled_pl)
# ─────────────────────────────────────────────────────────────────────

class AssembledIncomeStatement(TypedDict, total=True):
    """Canonical P&L. The `*_operational` / `*_statutory` /
    `*_operating_view` triple captures the three EBITDA bases the
    F1.e/F1.m/F1.n series locked in; every pack must produce all three
    even if they're identical for the country's GAAP (then they're
    just the same number)."""
    revenue: float
    gross_profit: float
    operating_ebitda: float          # operating-view (with 722 / capitalised own work)
    operating_ebit: float
    ebitda: float                    # cash-view (excludes non-cash 711/722)
    ebit: float
    ebitda_operational: float        # operational view (excludes 711, 722)
    ebitda_statutory: float          # matches statutory net-income anchor
    ebitda_operating_view: float
    depreciation: float
    interest_expense: float
    interest_income: float
    financial_income: float
    financial_expense: float
    tax: float
    pretax: float
    net_income_operational: float
    net_income_statutory: float
    total_operating_revenue: float
    total_operating_expense: float
    capitalized_own_work_memo: float
    inventory_variation_memo: float


class AssembledIncomeStatementOptional(TypedDict, total=False):
    cogs: float
    cost_of_goods_sold: float
    opex_total: float
    opex_excluding_cogs_and_da: float
    opex_third_party: float
    income_tax: float
    discounts_received: float
    ebitda_cash: float
    ebitda_statutory_with_711: float
    ebitda_adjusted: float
    fx_gain: float
    fx_loss: float
    financial_income_other: float
    other_income_758: float
    other_income_781_reversals: float
    core_ebitda: float
    net_financial_result: float
    financial_expense_total: float
    free_cash_flow_proxy: float
    total_operating_revenue_statutory: float


# ─────────────────────────────────────────────────────────────────────
# 5. Canonical cash flow (assembled_cf)
# ─────────────────────────────────────────────────────────────────────

class AssembledCashFlow(TypedDict, total=True):
    """Canonical cash flow — indirect method. `is_approximated` is
    REQUIRED so the briefing layer can disclose when working-capital
    movements were estimated (no prior-period BS available)."""
    net_profit: float
    depreciation: float
    cash_from_operating: float
    cash_used_in_investing: float
    cash_used_in_financing: float
    net_change_in_cash: float
    is_approximated: bool


class AssembledCashFlowOptional(TypedDict, total=False):
    provision_movement: float
    cf_before_wc: float
    delta_receivables: float
    delta_inventory: float
    delta_trade_pay: float
    delta_tax_pay: float
    net_wc_change: float
    capex_real: float
    capex_other_approx: float
    cip_change: float
    affiliate_change: float
    dividends_received: float
    interest_received: float
    capitalized_construction: float
    delta_lt_debt: float
    delta_st_bank: float
    bank_loan_drawdowns: float
    bank_loan_repayments: float
    interest_paid: float
    dividends_paid: float
    closing_cash_actual: float
    free_cash_flow: float
    approximation_notes: List[str]
    dividends_declared_but_unpaid: bool
    cash_from_investing: float
    cash_from_financing: float
    capex_total: float
    working_capital_change: float


# ─────────────────────────────────────────────────────────────────────
# 6. Ratio bands (assembled_bands) and Piotroski (assembled_piotroski)
# ─────────────────────────────────────────────────────────────────────

class BandSpec(TypedDict, total=True):
    """One ratio's traffic-light bands. `direction='higher'` = strong is
    high; `direction='lower'` = strong is low (e.g. leverage)."""
    strong: float
    healthy: float
    watch: float
    direction: Literal["higher", "lower"]


class AssembledBands(TypedDict, total=True):
    """Wrapper for the per-ratio band dictionary. `bands` is a dict
    keyed by ratio name (e.g. 'current_ratio') → `BandSpec`."""
    bands: Dict[str, BandSpec]


class PiotroskiCheck(TypedDict, total=True):
    """One of the 9 Piotroski signals — pass/fail + reason."""
    name: str
    pass_: bool       # PEP-8 doesn't allow `pass`; alias for the JSON key 'pass'
    reason: str


class AssembledPiotroski(TypedDict, total=True):
    score: int                  # 0-9
    score_max: int              # always 9
    has_prior_period: bool      # False → some checks skipped
    checks: List[Dict[str, Any]]
    disclosure: str             # human-readable methodology note


# ─────────────────────────────────────────────────────────────────────
# 7. Statements wrapper
# ─────────────────────────────────────────────────────────────────────

class CanonicalStatements(TypedDict, total=True):
    """The top-level `statements` dict every pack must return inside
    its `assemble_statements()` result."""
    companyName: str
    currency: str
    periodLabel: str
    balanceSheet: BalanceSheetLegacyView
    incomeStatement: IncomeStatementLegacyView
    subAggregates: Dict[str, float]            # see SubAggregates schema
    assembled_bs: Dict[str, float]             # see AssembledBalanceSheet + Optional
    assembled_pl: Dict[str, float]             # see AssembledIncomeStatement + Optional
    assembled_cf: Dict[str, Any]               # see AssembledCashFlow + Optional
    assembled_bands: AssembledBands
    assembled_piotroski: AssembledPiotroski
    supplementary: SupplementaryFields


class CanonicalStatementsOptional(TypedDict, total=False):
    industry: Optional[str]


# ─────────────────────────────────────────────────────────────────────
# 8. Full envelope
# ─────────────────────────────────────────────────────────────────────

class LineItem(TypedDict, total=True):
    """One line-item row written to the `statement_line_items` DB
    table. `bucket` is the legacy DB-schema bucket name (CHECK-
    constrained); `canonical_bucket` is the pack's full-fidelity bucket
    name. They may differ for memo/sub-aggregate buckets."""
    statement: Literal["BS", "PL", "CF"]
    bucket: str
    canonical_bucket: str
    ro_account_code: str         # F3.7+: pack-local "code" field; staged-rename
    ro_account_name: str
    amount: float
    is_derived: bool


class CanonicalFinancialModel(TypedDict, total=True):
    """The full dict every country pack's `assemble_statements()`
    returns. `lineItems` is the per-account audit trail; `unmapped`
    surfaces accounts the chart of accounts didn't recognise (Review
    Mode in F3.4 consumes this); `ignored` carries explicitly-discarded
    rows with reasons.
    """
    statements: CanonicalStatements
    lineItems: List[LineItem]
    unmapped: List[Dict[str, Any]]
    ignored: List[Dict[str, Any]]


# ─────────────────────────────────────────────────────────────────────
# 9. Runtime validator
# ─────────────────────────────────────────────────────────────────────

# Required keys for the four canonical sub-objects, derived from the
# `total=True` TypedDicts above. The validator checks these.
_REQUIRED_BS_LEGACY = list(BalanceSheetLegacyView.__annotations__.keys())
_REQUIRED_PL_LEGACY = list(IncomeStatementLegacyView.__annotations__.keys())
_REQUIRED_BS_CANON = list(AssembledBalanceSheet.__annotations__.keys())
_REQUIRED_PL_CANON = list(AssembledIncomeStatement.__annotations__.keys())
_REQUIRED_CF_CANON = list(AssembledCashFlow.__annotations__.keys())
_REQUIRED_STMT = [
    "companyName", "currency", "periodLabel",
    "balanceSheet", "incomeStatement",
    "assembled_bs", "assembled_pl", "assembled_cf",
    "assembled_bands", "assembled_piotroski",
    "supplementary",
]
_REQUIRED_PIOTROSKI = ["score", "score_max", "has_prior_period", "checks"]


@dataclass
class ValidationReport:
    """Result of running `validate_canonical_envelope(envelope)`.

    `ok` is True only when `errors` is empty. `warnings` flags fields
    that are merely missing (no values), not type-incorrect — the
    validator distinguishes "wrong shape" from "missing data" so a
    pack can be partially-calibrated without failing every period.
    """
    ok: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    def summary(self) -> str:
        if self.ok and not self.warnings:
            return "GREEN — canonical envelope conforms to CanonicalFinancialModel."
        lines: List[str] = []
        if self.errors:
            lines.append(f"RED — {len(self.errors)} structural violation(s):")
            for e in self.errors[:10]:
                lines.append(f"  - {e}")
            if len(self.errors) > 10:
                lines.append(f"  - (+ {len(self.errors) - 10} more)")
        if self.warnings:
            lines.append(f"AMBER — {len(self.warnings)} missing optional field(s):")
            for w in self.warnings[:10]:
                lines.append(f"  - {w}")
            if len(self.warnings) > 10:
                lines.append(f"  - (+ {len(self.warnings) - 10} more)")
        return "\n".join(lines) if lines else "GREEN"


def _expect_keys(
    obj: Any, required: List[str], path: str, errors: List[str]
) -> bool:
    """Append errors for any missing key. Returns True if all present."""
    if not isinstance(obj, dict):
        errors.append(f"{path}: expected dict, got {type(obj).__name__}")
        return False
    missing = [k for k in required if k not in obj]
    if missing:
        errors.append(f"{path}: missing required keys: {missing}")
        return False
    return True


def _expect_numeric(obj: Any, key: str, path: str, errors: List[str]) -> None:
    """Append error if obj[key] is not a number (int/float/bool)."""
    if key not in obj:
        return  # _expect_keys handles missing
    v = obj[key]
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        errors.append(f"{path}.{key}: expected numeric, got {type(v).__name__}")


def validate_canonical_envelope(envelope: Any) -> ValidationReport:
    """Validate that `envelope` conforms to `CanonicalFinancialModel`.

    Checks:
      - Top-level keys present: statements, lineItems, unmapped, ignored
      - statements keys present (F3.2 required list)
      - balanceSheet / incomeStatement / assembled_bs / assembled_pl /
        assembled_cf required keys present
      - assembled_piotroski has score (int 0-9), score_max (int=9),
        has_prior_period (bool), checks (list)
      - assembled_bands.bands is a dict
      - lineItems is a list of dicts with required fields
      - unmapped, ignored are lists

    Returns a `ValidationReport`. Validation does NOT throw.
    """
    errors: List[str] = []
    warnings: List[str] = []

    if not isinstance(envelope, dict):
        return ValidationReport(
            ok=False,
            errors=[f"<root>: expected dict, got {type(envelope).__name__}"],
        )

    # ── Top level ──────────────────────────────────────────
    top_required = ["statements", "lineItems", "unmapped", "ignored"]
    if not _expect_keys(envelope, top_required, "envelope", errors):
        return ValidationReport(ok=False, errors=errors)

    stmts = envelope["statements"]
    line_items = envelope["lineItems"]
    unmapped = envelope["unmapped"]
    ignored = envelope["ignored"]

    if not isinstance(line_items, list):
        errors.append(f"envelope.lineItems: expected list, got {type(line_items).__name__}")
    if not isinstance(unmapped, list):
        errors.append(f"envelope.unmapped: expected list, got {type(unmapped).__name__}")
    if not isinstance(ignored, list):
        errors.append(f"envelope.ignored: expected list, got {type(ignored).__name__}")

    # ── statements ────────────────────────────────────────
    if not _expect_keys(stmts, _REQUIRED_STMT, "envelope.statements", errors):
        return ValidationReport(ok=False, errors=errors)

    for str_key in ("companyName", "currency", "periodLabel"):
        v = stmts.get(str_key)
        if not isinstance(v, str):
            errors.append(f"envelope.statements.{str_key}: expected str, got {type(v).__name__}")

    # ── balanceSheet (legacy view) ─────────────────────────
    bs_legacy = stmts["balanceSheet"]
    if _expect_keys(bs_legacy, _REQUIRED_BS_LEGACY, "envelope.statements.balanceSheet", errors):
        for k in _REQUIRED_BS_LEGACY:
            _expect_numeric(bs_legacy, k, "envelope.statements.balanceSheet", errors)

    # ── incomeStatement (legacy view) ──────────────────────
    pl_legacy = stmts["incomeStatement"]
    if _expect_keys(pl_legacy, _REQUIRED_PL_LEGACY, "envelope.statements.incomeStatement", errors):
        for k in _REQUIRED_PL_LEGACY:
            _expect_numeric(pl_legacy, k, "envelope.statements.incomeStatement", errors)

    # ── assembled_bs ───────────────────────────────────────
    a_bs = stmts["assembled_bs"]
    if _expect_keys(a_bs, _REQUIRED_BS_CANON, "envelope.statements.assembled_bs", errors):
        for k in _REQUIRED_BS_CANON:
            _expect_numeric(a_bs, k, "envelope.statements.assembled_bs", errors)

    # ── assembled_pl ───────────────────────────────────────
    a_pl = stmts["assembled_pl"]
    if _expect_keys(a_pl, _REQUIRED_PL_CANON, "envelope.statements.assembled_pl", errors):
        for k in _REQUIRED_PL_CANON:
            _expect_numeric(a_pl, k, "envelope.statements.assembled_pl", errors)

    # ── assembled_cf ───────────────────────────────────────
    a_cf = stmts["assembled_cf"]
    if _expect_keys(a_cf, _REQUIRED_CF_CANON, "envelope.statements.assembled_cf", errors):
        for k in _REQUIRED_CF_CANON:
            if k == "is_approximated":
                v = a_cf.get(k)
                if not isinstance(v, bool):
                    errors.append(
                        f"envelope.statements.assembled_cf.is_approximated: "
                        f"expected bool, got {type(v).__name__}"
                    )
            else:
                _expect_numeric(a_cf, k, "envelope.statements.assembled_cf", errors)

    # ── assembled_bands ────────────────────────────────────
    a_bands = stmts["assembled_bands"]
    if not isinstance(a_bands, dict):
        errors.append(
            f"envelope.statements.assembled_bands: expected dict, got {type(a_bands).__name__}"
        )
    elif "bands" not in a_bands or not isinstance(a_bands["bands"], dict):
        errors.append("envelope.statements.assembled_bands.bands: expected dict")

    # ── assembled_piotroski ────────────────────────────────
    p = stmts["assembled_piotroski"]
    if _expect_keys(p, _REQUIRED_PIOTROSKI, "envelope.statements.assembled_piotroski", errors):
        score = p.get("score")
        if not isinstance(score, int) or score < 0 or score > 9:
            errors.append(
                f"envelope.statements.assembled_piotroski.score: "
                f"expected int 0-9, got {score!r}"
            )
        if p.get("score_max") != 9:
            errors.append(
                f"envelope.statements.assembled_piotroski.score_max: "
                f"expected 9, got {p.get('score_max')!r}"
            )
        if not isinstance(p.get("has_prior_period"), bool):
            errors.append(
                "envelope.statements.assembled_piotroski.has_prior_period: expected bool"
            )
        if not isinstance(p.get("checks"), list):
            errors.append(
                "envelope.statements.assembled_piotroski.checks: expected list"
            )

    # ── supplementary ──────────────────────────────────────
    supp = stmts["supplementary"]
    if not isinstance(supp, dict) or "periodDays" not in supp:
        errors.append(
            "envelope.statements.supplementary: expected dict with 'periodDays' key"
        )
    elif not isinstance(supp["periodDays"], int):
        errors.append(
            f"envelope.statements.supplementary.periodDays: "
            f"expected int, got {type(supp['periodDays']).__name__}"
        )

    # ── lineItems shape ────────────────────────────────────
    if isinstance(line_items, list):
        required_li = ["statement", "bucket", "canonical_bucket", "ro_account_code",
                       "ro_account_name", "amount", "is_derived"]
        for i, li in enumerate(line_items[:5]):  # sample first 5 to keep cost bounded
            for k in required_li:
                if k not in li:
                    errors.append(f"envelope.lineItems[{i}]: missing key '{k}'")

    return ValidationReport(ok=not errors, errors=errors, warnings=warnings)
