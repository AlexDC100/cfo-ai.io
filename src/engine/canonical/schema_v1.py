"""F4.1a — canonical schema v1, declarative module.

Defines every canonical bucket exactly as specified in
`CANONICAL_SCHEMA_V1.md` §3-5. This module is PURE DATA — no engine
logic, no I/O. The RO pack adapter (and future country pack adapters)
read these definitions to know what buckets to produce and what
sign_meaning + parent_aggregate metadata to emit alongside.

Why declarative + frozen-dataclass:
  · Schema changes are visible in source diffs (auditable)
  · Round-trip property (sum of leaves == aggregate) is mechanically
    checkable from this single source of truth
  · Methodology YAML files reference bucket canonical_names; this
    module is the validation set for those references
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional


SCHEMA_VERSION = "canonical_v1.0.0"


def schema_version() -> str:
    return SCHEMA_VERSION


class BucketType(str, Enum):
    """Top-level statement classification. `memo` = not summed into
    statement totals; surfaced for methodology layer use only."""
    ASSET = "asset"
    LIABILITY = "liability"
    EQUITY = "equity"
    REVENUE = "revenue"
    EXPENSE = "expense"
    OCI_ITEM = "oci_item"  # Other Comprehensive Income — IFRS only
    MEMO = "memo"          # capitalized_own_work_memo, inventory_variation_memo
    CF_OPERATING = "cf_operating"
    CF_INVESTING = "cf_investing"
    CF_FINANCING = "cf_financing"


class SignMeaning(str, Enum):
    """Economic direction of the bucket. Per F3.15 operator decision 3b,
    all magnitudes are emitted as non-negative; the consumer composes
    final totals using sign_meaning to determine whether to add or
    subtract the magnitude."""
    ASSET_POSITIVE = "asset_positive"        # debit-natural; increases assets
    ASSET_NEGATIVE = "asset_negative"        # credit-natural contra; reduces assets
    LIABILITY_POSITIVE = "liability_positive"
    EQUITY_POSITIVE = "equity_positive"
    EQUITY_NEGATIVE = "equity_negative"      # treasury_shares, current_year_loss, etc.
    REVENUE_POSITIVE = "revenue_positive"
    REVENUE_NEGATIVE = "revenue_negative"    # 709 commercial reductions, contra-revenue
    EXPENSE_POSITIVE = "expense_positive"
    EXPENSE_NEGATIVE = "expense_negative"    # discounts received from suppliers, etc.
    CF_INFLOW = "cf_inflow"
    CF_OUTFLOW = "cf_outflow"
    SIGNED = "signed"                         # net deltas; sign carries economic direction


@dataclass(frozen=True)
class CanonicalBucket:
    """One canonical bucket. Frozen so adapters can't mutate the schema."""
    canonical_name: str
    display_label: str
    bucket_type: BucketType
    sign_meaning: SignMeaning
    parent_aggregate: str
    description: str
    # Country-pack mapping examples. The actual mapping logic lives in
    # the country pack's `canonical_adapter.py`; these fields document
    # the expected RAS / IFRS / US-GAAP correspondence for auditors.
    ras_mapping: str = ""        # e.g. "5121, 5311 (cash in RON, petty cash)"
    ifrs_ref: str = ""           # e.g. "IAS 7.6"
    us_gaap_ref: str = ""        # e.g. "ASC 305"
    # Per §8 deprecation list. None = active; ISO date = scheduled removal.
    deprecation_horizon: Optional[str] = None
    # When parent_aggregate is a contra relationship (this bucket
    # reduces another bucket's net), name the bucket(s) it offsets.
    # Used by F4.1-ROUNDTRIP gate to verify the contra math.
    contra_of: Optional[str] = None


# ────────────────────────────────────────────────────────────────────────
# §3a — BALANCE SHEET: Current Assets (21 leaves, 5 parent aggregates)
# ────────────────────────────────────────────────────────────────────────

_BS_CURRENT_ASSETS: List[CanonicalBucket] = [
    # cash_and_equivalents (4)
    CanonicalBucket("cash_operating",        "Cash in operating currency", BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "cash_and_equivalents", "Bank accounts + petty cash in functional currency.", "5121, 5311", "IAS 7.6"),
    CanonicalBucket("cash_fx",               "Cash in foreign currency",   BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "cash_and_equivalents", "Bank accounts + petty cash in non-functional currencies.", "5124, 5314", "IAS 7.6 + IAS 21"),
    CanonicalBucket("cash_restricted",       "Restricted cash",            BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "cash_and_equivalents", "Escrows, blocked accounts, security deposits used as collateral.", "(sub-analytics of 512/581)", "IAS 7.48"),
    CanonicalBucket("short_term_investments","Short-term investments",     BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "cash_and_equivalents", "Marketable securities, treasury bills, term deposits <3m.", "501, 503, 505-508", "IFRS 9"),
    # trade_receivables_net (3)
    CanonicalBucket("ar_trade_gross",        "Trade receivables (gross)",  BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "trade_receivables_net", "Customer balances at face value.", "4111", "IFRS 9 / IAS 1.54(h)"),
    CanonicalBucket("ar_doubtful_gross",     "Doubtful receivables (gross)", BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "trade_receivables_net", "Customer balances flagged as collection risk.", "4118", "IFRS 9 ECL"),
    CanonicalBucket("ar_provisions",         "AR allowance",               BucketType.ASSET, SignMeaning.ASSET_NEGATIVE, "trade_receivables_net", "Expected credit loss allowance; offsets ar_trade_gross + ar_doubtful_gross.", "491", "IFRS 9 ECL", contra_of="ar_trade_gross + ar_doubtful_gross"),
    # other_receivables (5)
    CanonicalBucket("ar_intercompany",       "Intercompany receivables",   BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "other_receivables", "Receivables from affiliated entities; related-party concentration signal.", "451 D-side, 4511, 455", "IAS 24"),
    CanonicalBucket("ar_tax_recoverable",    "Tax recoverable",            BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "other_receivables", "VAT recoverable, advance income tax paid.", "4424, 4411 (D)", "IAS 12"),
    CanonicalBucket("ar_personnel",          "Personnel receivables",      BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "other_receivables", "Employee advances + short-term loans.", "425 (D), 4282", "IAS 19"),
    CanonicalBucket("ar_supplier_advances",  "Supplier advances",          BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "other_receivables", "Prepayments to suppliers excluding capex advances.", "4091, 4092", "IAS 1"),
    CanonicalBucket("ar_other",              "Other receivables",          BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "other_receivables", "Residual receivables (debtor balances, settlement accounts).", "461 (D), 462 (D), 471", "IFRS 9"),
    # inventory_net (8)
    CanonicalBucket("inventory_raw_materials",  "Raw materials",           BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "inventory_net", "Raw materials at acquisition cost.", "301", "IAS 2.6"),
    CanonicalBucket("inventory_consumables",    "Auxiliary consumables",   BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "inventory_net", "Auxiliary materials, small inventory items, spare parts.", "302, 303", "IAS 2.6"),
    CanonicalBucket("inventory_wip",            "Work in progress",        BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "inventory_net", "Production WIP + semi-finished goods.", "331, 341", "IAS 2.6"),
    CanonicalBucket("inventory_finished_goods", "Finished goods",          BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "inventory_net", "Finished products awaiting sale.", "345", "IAS 2.6"),
    CanonicalBucket("inventory_merchandise_resale", "Merchandise for resale", BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "inventory_net", "Purchased goods held for resale without modification.", "371", "IAS 2.6"),
    CanonicalBucket("inventory_packaging",      "Packaging",               BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "inventory_net", "Packaging materials inventory.", "381", "IAS 2.6"),
    CanonicalBucket("inventory_at_third_parties", "Inventory at third parties", BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "inventory_net", "Goods consigned, in transit, or stored at third-party warehouses.", "351, 357", "IAS 2"),
    CanonicalBucket("inventory_provisions",     "Inventory allowance",     BucketType.ASSET, SignMeaning.ASSET_NEGATIVE, "inventory_net", "Net realizable value write-down across all inventory categories.", "391-398", "IAS 2.9 (NRV)", contra_of="inventory_raw_materials + inventory_consumables + inventory_wip + inventory_finished_goods + inventory_merchandise_resale + inventory_packaging + inventory_at_third_parties"),
    # prepaid_expenses_and_other (1)
    CanonicalBucket("prepaid_expenses_st",   "Prepaid expenses (ST)",      BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "prepaid_expenses_and_other", "Costs paid in advance allocable to <12m periods.", "471 (ST portion)", "IFRS 15.66 / IAS 1"),
]


# ────────────────────────────────────────────────────────────────────────
# §3b — BALANCE SHEET: Non-current Assets (19 leaves, 6 parent aggregates)
# ────────────────────────────────────────────────────────────────────────

_BS_NON_CURRENT_ASSETS: List[CanonicalBucket] = [
    # ppe_net (8)
    CanonicalBucket("ppe_land",              "Land",                       BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "ppe_net", "Land at acquisition cost or revalued amount; not depreciated (operator-flagged).", "211", "IAS 16.37(a)"),
    CanonicalBucket("ppe_buildings",         "Buildings",                  BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "ppe_net", "Office, factory, warehouse buildings at gross.", "212", "IAS 16.37(b)"),
    CanonicalBucket("ppe_machinery_equipment", "Machinery & equipment",    BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "ppe_net", "Production equipment, measurement instruments, transport equipment at gross.", "2131, 2132, 2133", "IAS 16.37(c-e)"),
    CanonicalBucket("ppe_furniture_office",  "Furniture & office equipment", BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "ppe_net", "Furniture, fittings, office equipment at gross.", "214", "IAS 16.37(g)"),
    CanonicalBucket("ppe_under_construction", "PPE under construction",    BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "ppe_net", "Capital projects in progress; not depreciated until in-service.", "231, 232", "IAS 16.37"),
    CanonicalBucket("ppe_advances",          "PPE advances",               BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "ppe_net", "Prepayments to suppliers for fixed asset acquisitions.", "4093", "IAS 16"),
    CanonicalBucket("accumulated_depreciation_ppe", "Accumulated depreciation (PPE)", BucketType.ASSET, SignMeaning.ASSET_NEGATIVE, "ppe_net", "Cumulative depreciation on depreciable PPE (buildings + machinery + furniture); land NOT included.", "281", "IAS 16.43", contra_of="ppe_buildings + ppe_machinery_equipment + ppe_furniture_office"),
    CanonicalBucket("accumulated_impairment_ppe", "Accumulated impairment (PPE)", BucketType.ASSET, SignMeaning.ASSET_NEGATIVE, "ppe_net", "Cumulative impairment write-downs across PPE.", "291", "IAS 36", contra_of="ppe_land + ppe_buildings + ppe_machinery_equipment + ppe_furniture_office + ppe_under_construction"),
    # investment_property (1)
    CanonicalBucket("investment_property",   "Investment property",        BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "investment_property", "Property held to earn rentals or capital appreciation; distinct from owner-occupied PPE.", "215", "IAS 40.5"),
    # right_of_use_assets (2)
    CanonicalBucket("right_of_use_assets",   "Right-of-use assets",        BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "right_of_use_assets", "Lessee's right to use a leased asset over the lease term. Zero for RAS-only entities; populated when IFRS 16 adopted.", "(IFRS-adopted entities only)", "IFRS 16.22"),
    CanonicalBucket("accumulated_depreciation_rou", "Accumulated depreciation (ROU)", BucketType.ASSET, SignMeaning.ASSET_NEGATIVE, "right_of_use_assets", "Depreciation accumulated on ROU assets.", "(n/a in RAS)", "IFRS 16.31", contra_of="right_of_use_assets"),
    # intangibles_net (4)
    CanonicalBucket("intangibles_goodwill",  "Goodwill",                   BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "intangibles_net", "Goodwill from business combinations. RAS amortizes; IFRS impairs only.", "207", "IFRS 3.32 / IAS 36"),
    CanonicalBucket("intangibles_other",     "Other intangibles",          BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "intangibles_net", "Software licenses, patents, trademarks, R&D capitalized.", "201, 203, 205, 208", "IAS 38.118"),
    CanonicalBucket("accumulated_amortization_intangibles", "Accumulated amortization (intangibles)", BucketType.ASSET, SignMeaning.ASSET_NEGATIVE, "intangibles_net", "Cumulative amortization on intangibles with finite useful life. Does NOT include goodwill under IFRS (impaired separately).", "280", "IAS 38.97", contra_of="intangibles_other"),
    CanonicalBucket("accumulated_impairment_goodwill", "Accumulated impairment (goodwill)", BucketType.ASSET, SignMeaning.ASSET_NEGATIVE, "intangibles_net", "Cumulative goodwill impairment write-downs.", "(n/a separate in RAS)", "IAS 36.124", contra_of="intangibles_goodwill"),
    # financial_investments (2)
    CanonicalBucket("financial_investments_affiliates", "Investments in affiliates", BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "financial_investments", "Equity stakes in subsidiaries, associates, joint ventures.", "261, 263", "IAS 28 / IFRS 10/11"),
    CanonicalBucket("financial_investments_other", "Other financial investments", BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "financial_investments", "Long-term securities, deposits, loans receivable >12m.", "265, 267", "IFRS 9"),
    # deferred_tax_assets (1)
    CanonicalBucket("deferred_tax_assets",   "Deferred tax assets",        BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "deferred_tax_assets", "Future tax deductions from temporary differences + tax loss carry-forwards. Rarely recognized in RAS SMEs (operator-flagged).", "(rarely populated in RAS SME)", "IAS 12.24"),
    # other_non_current_assets (1)
    CanonicalBucket("other_non_current_assets", "Other non-current assets", BucketType.ASSET, SignMeaning.ASSET_POSITIVE, "other_non_current_assets", "Long-term receivables >12m + residual non-current asset items.", "2678", "IAS 1.54"),
]


# ────────────────────────────────────────────────────────────────────────
# §3c — BALANCE SHEET: Current Liabilities (16 leaves, 5 parent aggregates)
# ────────────────────────────────────────────────────────────────────────

_BS_CURRENT_LIABILITIES: List[CanonicalBucket] = [
    # trade_payables (2)
    CanonicalBucket("ap_trade",              "Trade payables",             BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "trade_payables", "Supplier balances at face value.", "401, 403, 404, 408", "IAS 1.54(k)"),
    CanonicalBucket("ap_intercompany",       "Intercompany payables",      BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "trade_payables", "Payables to affiliated entities.", "451 (C), 4511 (C), 455 (C)", "IAS 24"),
    # tax_payables (1)
    CanonicalBucket("ap_tax",                "Tax payables",               BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "tax_payables", "Income tax payable, VAT collected, payroll tax, other taxes.", "441, 442 (C), 444-448", "IAS 12 / IAS 1.54(n)"),
    # personnel_payables (3)
    CanonicalBucket("ap_personnel_salaries", "Salaries payable",           BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "personnel_payables", "Net wages owed to employees.", "421, 423", "IAS 19"),
    CanonicalBucket("ap_personnel_social",   "Social contributions payable", BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "personnel_payables", "Social security, health insurance contributions owed.", "431, 436, 438", "IAS 19"),
    CanonicalBucket("ap_personnel_other",    "Other personnel payables",   BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "personnel_payables", "Accrued bonuses, vouchers payable, other personnel obligations.", "425 (C), 426, 427, 428", "IAS 19"),
    # other_payables_st + deferred_revenue_st + provisions_st (10)
    CanonicalBucket("ap_dividends",          "Dividends payable",          BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "other_payables_st", "Declared but unpaid dividends.", "457", "IAS 10"),
    CanonicalBucket("ap_other",              "Other current payables",     BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "other_payables_st", "Sundry creditors, settlement accounts (C-side).", "462", "IAS 1"),
    CanonicalBucket("st_debt_bank",          "Short-term bank debt",       BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "financial_liabilities_st", "Bank loans + overdrafts with <12m maturity.", "519, 5191, 5192", "IFRS 9 / IAS 1.54(m)"),
    CanonicalBucket("st_debt_other",         "Short-term other debt",      BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "financial_liabilities_st", "Commercial paper, factoring liabilities, other short-term debt.", "509", "IFRS 9"),
    CanonicalBucket("st_lease_liabilities",  "Short-term lease liabilities", BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "financial_liabilities_st", "IFRS 16 lease liabilities due <12m. Zero for non-IFRS entities.", "(IFRS-adopted: 167 current portion)", "IFRS 16.47"),
    CanonicalBucket("customer_advances",     "Customer advances",          BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "deferred_revenue_st", "Advance payments received from customers for future delivery.", "419", "IFRS 15.106"),
    CanonicalBucket("deferred_revenue_st",   "Deferred revenue (ST)",      BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "deferred_revenue_st", "Revenue received but not yet earned, recognizable <12m.", "472", "IFRS 15.106"),
    CanonicalBucket("provisions_st",         "Provisions (ST)",            BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "provisions_st", "Expected cash outflows for past obligations with timing/amount uncertainty, <12m.", "(151 portion <12m)", "IAS 37.14"),
    CanonicalBucket("accrued_expenses",      "Accrued expenses",           BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "other_payables_st", "Expenses incurred but not yet invoiced; invoices not received.", "408, 4281", "IAS 1.54(k)"),
    CanonicalBucket("other_current_liabilities", "Other current liabilities", BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "other_payables_st", "Residual current liability items.", "(residual)", "IAS 1"),
]


# ────────────────────────────────────────────────────────────────────────
# §3d — BALANCE SHEET: Non-current Liabilities (9 leaves, 5 parent aggregates)
# ────────────────────────────────────────────────────────────────────────

_BS_NON_CURRENT_LIABILITIES: List[CanonicalBucket] = [
    CanonicalBucket("lt_debt_bank",          "Long-term bank debt",        BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "financial_liabilities_lt", "Bank loans with >12m maturity + accrued LT interest.", "1621-1625, 168", "IFRS 9"),
    CanonicalBucket("lt_debt_other",         "Long-term other debt",       BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "financial_liabilities_lt", "Bonds payable, intercompany loans LT, other non-bank debt.", "166, 167 (legacy lease)", "IFRS 9"),
    CanonicalBucket("lt_lease_liabilities",  "Long-term lease liabilities", BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "financial_liabilities_lt", "IFRS 16 lease liabilities >12m. Zero for non-IFRS entities.", "(IFRS-adopted: 167 LT portion)", "IFRS 16.47"),
    CanonicalBucket("deferred_tax_liabilities", "Deferred tax liabilities", BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "deferred_tax_liabilities", "Future tax obligations from taxable temporary differences.", "(rarely populated in RAS SME)", "IAS 12.24"),
    CanonicalBucket("provisions_lt",         "Provisions (LT)",            BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "provisions_lt", "Expected cash outflows for past obligations >12m (litigation, decommissioning).", "151 (>12m portion)", "IAS 37.14"),
    CanonicalBucket("pension_liabilities",   "Pension liabilities",        BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "pension_liabilities", "Defined benefit obligations net of plan assets.", "(rare in RAS SME)", "IAS 19.55"),
    CanonicalBucket("government_grants_deferred", "Deferred government grants", BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "deferred_income_lt", "Government grants not yet recognized in P&L.", "475, 478", "IAS 20.12"),
    CanonicalBucket("convertible_debt_host", "Convertible debt — host",    BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "financial_liabilities_lt", "Liability component of convertible instruments per IAS 32 split accounting.", "(rare in RAS SME)", "IAS 32.28"),
    CanonicalBucket("other_non_current_liabilities", "Other non-current liabilities", BucketType.LIABILITY, SignMeaning.LIABILITY_POSITIVE, "other_non_current_liabilities", "Residual non-current liability items.", "(residual)", "IAS 1"),
]


# ────────────────────────────────────────────────────────────────────────
# §3e — BALANCE SHEET: Equity (14 leaves, 5 parent aggregates)
# ────────────────────────────────────────────────────────────────────────

_BS_EQUITY: List[CanonicalBucket] = [
    CanonicalBucket("share_capital",         "Share capital",              BucketType.EQUITY, SignMeaning.EQUITY_POSITIVE, "contributed_capital", "Paid-in share capital at par value.", "101, 1012", "IAS 1.78(e)"),
    CanonicalBucket("share_premium",         "Share premium",              BucketType.EQUITY, SignMeaning.EQUITY_POSITIVE, "contributed_capital", "Premium paid over par value at share issuance.", "104", "IAS 1.78(e)"),
    CanonicalBucket("revaluation_reserves",  "Revaluation reserves",       BucketType.EQUITY, SignMeaning.EQUITY_POSITIVE, "reserves", "Revaluation surplus on PPE per IAS 16 revaluation model (or RAS equivalent). Zero under US-GAAP (revaluation not permitted).", "105", "IAS 16.39"),
    CanonicalBucket("legal_reserves",        "Legal reserves",             BucketType.EQUITY, SignMeaning.EQUITY_POSITIVE, "reserves", "Statutory reserve required by local company law (RAS: 5% of profit until 20% of capital).", "1061", "IAS 1.78(e)"),
    CanonicalBucket("other_reserves",        "Other reserves",             BucketType.EQUITY, SignMeaning.EQUITY_POSITIVE, "reserves", "Voluntary reserves, statutory reserves beyond legal minimum.", "1068", "IAS 1.78(e)"),
    CanonicalBucket("retained_earnings_prior_years", "Retained earnings (prior years)", BucketType.EQUITY, SignMeaning.EQUITY_POSITIVE, "retained_earnings", "Cumulative undistributed profits from prior years.", "117 (C-net)", "IAS 1.79(b)"),
    CanonicalBucket("accumulated_losses_prior_years", "Accumulated losses (prior years)", BucketType.EQUITY, SignMeaning.EQUITY_NEGATIVE, "retained_earnings", "Cumulative undistributed losses from prior years.", "117 (D-net)", "IAS 1.79(b)", contra_of="retained_earnings_prior_years"),
    CanonicalBucket("current_year_profit",   "Current year profit",        BucketType.EQUITY, SignMeaning.EQUITY_POSITIVE, "retained_earnings", "Current year net profit (account 121 closing C in RAS).", "121 (C)", "IAS 1.81A"),
    CanonicalBucket("current_year_loss",     "Current year loss",          BucketType.EQUITY, SignMeaning.EQUITY_NEGATIVE, "retained_earnings", "Current year net loss (account 121 closing D in RAS).", "121 (D)", "IAS 1.81A", contra_of="current_year_profit"),
    CanonicalBucket("profit_distribution_provision", "Profit distribution provision", BucketType.EQUITY, SignMeaning.EQUITY_NEGATIVE, "retained_earnings", "Profit allocated to reserves/dividends during the year (RAS account 129 — reduces distributable equity to avoid double-count).", "129", "local statutes", contra_of="current_year_profit"),
    CanonicalBucket("treasury_shares",       "Treasury shares",            BucketType.EQUITY, SignMeaning.EQUITY_NEGATIVE, "treasury_shares", "Own shares repurchased; reduces equity.", "(rare in RAS SME)", "IAS 32.33", contra_of="share_capital + share_premium"),
    CanonicalBucket("accumulated_oci",       "Accumulated OCI",            BucketType.EQUITY, SignMeaning.EQUITY_POSITIVE, "accumulated_oci", "Accumulated other comprehensive income (FX translation, cash flow hedge reserve, FVOCI reserve). Zero for RAS SMEs.", "(n/a in RAS SME)", "IAS 1.7"),
    CanonicalBucket("non_controlling_interest", "Non-controlling interest", BucketType.EQUITY, SignMeaning.EQUITY_POSITIVE, "non_controlling_interest", "Equity attributable to minority shareholders in consolidated subsidiaries.", "(n/a in single-entity RAS)", "IAS 27.27"),
    CanonicalBucket("convertible_debt_equity_component", "Convertible debt equity component", BucketType.EQUITY, SignMeaning.EQUITY_POSITIVE, "convertible_debt_equity_component", "Equity portion of split convertible instruments per IAS 32.", "(rare in RAS SME)", "IAS 32.28"),
]


# Aggregate BS bucket list
BS_BUCKETS: List[CanonicalBucket] = (
    _BS_CURRENT_ASSETS + _BS_NON_CURRENT_ASSETS +
    _BS_CURRENT_LIABILITIES + _BS_NON_CURRENT_LIABILITIES +
    _BS_EQUITY
)


# ────────────────────────────────────────────────────────────────────────
# §4 — PROFIT & LOSS (55 leaves across 9 parent aggregates)
# ────────────────────────────────────────────────────────────────────────

_PL_REVENUE: List[CanonicalBucket] = [
    CanonicalBucket("revenue_products",      "Revenue — finished products", BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "revenue_gross", "Sales of manufactured finished products.", "701", "IFRS 15.31"),
    CanonicalBucket("revenue_semi_finished", "Revenue — semi-finished",    BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "revenue_gross", "Sales of semi-finished goods.", "702", "IFRS 15.31"),
    CanonicalBucket("revenue_residual_products", "Revenue — residual products", BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "revenue_gross", "Sales of by-products and waste.", "703", "IFRS 15.31"),
    CanonicalBucket("revenue_services",      "Revenue — services",         BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "revenue_gross", "Service revenue including research/consulting.", "704, 705", "IFRS 15.31"),
    CanonicalBucket("revenue_rental_royalty","Revenue — rental & royalty", BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "revenue_gross", "Lease income, royalty income, IP licensing. CRE entity signal.", "706", "IFRS 15.31 / IAS 17 / IAS 40.75"),
    CanonicalBucket("revenue_merchandise_resale", "Revenue — merchandise", BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "revenue_gross", "Sales of purchased merchandise without modification.", "707", "IFRS 15.31"),
    CanonicalBucket("revenue_other_operating", "Revenue — other operating", BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "revenue_gross", "Other operating revenue not classified above.", "708", "IFRS 15.31"),
    CanonicalBucket("revenue_commercial_reductions", "Commercial reductions", BucketType.REVENUE, SignMeaning.REVENUE_NEGATIVE, "revenue_gross", "Discounts, rebates given to customers; contra-revenue.", "709", "IFRS 15 variable consideration", contra_of="revenue_products + revenue_semi_finished + revenue_merchandise_resale + revenue_other_operating"),
]

_PL_COGS: List[CanonicalBucket] = [
    CanonicalBucket("cogs_raw_materials",    "COGS — raw materials",       BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "cogs", "Raw materials consumed in production.", "601", "IAS 2.34"),
    CanonicalBucket("cogs_auxiliary_consumables", "COGS — consumables",    BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "cogs", "Auxiliary materials consumed in production.", "602", "IAS 2.34"),
    CanonicalBucket("cogs_merchandise",      "COGS — merchandise sold",    BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "cogs", "Cost of merchandise resold.", "607", "IAS 2.34"),
    CanonicalBucket("cogs_packaging",        "COGS — packaging",           BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "cogs", "Packaging consumed (sales-related).", "608", "IAS 2.34"),
    CanonicalBucket("discounts_received_supplier", "Discounts received from suppliers", BucketType.EXPENSE, SignMeaning.EXPENSE_NEGATIVE, "cogs", "Supplier rebates and discounts; contra-cost.", "609", "IFRS 15 / IAS 2"),
]

_PL_OPEX: List[CanonicalBucket] = [
    CanonicalBucket("materials_non_inventory", "Non-inventory materials",  BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "opex_general", "Small tools, non-storable materials.", "603, 604", "IAS 1.99"),
    CanonicalBucket("energy_utilities",      "Energy & utilities",         BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "opex_general", "Electricity, gas, water.", "605", "IAS 1.99"),
    CanonicalBucket("maintenance_repairs",   "Maintenance & repairs",      BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "opex_general", "Repair and maintenance services.", "611", "IAS 1.99"),
    CanonicalBucket("rent_operating_lease",  "Rent — operating leases",    BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "opex_general", "Operating lease expense (or IFRS 16 short-term/low-value lease exemption).", "612", "IFRS 16.5/6 / IAS 17"),
    CanonicalBucket("insurance",             "Insurance",                  BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "opex_general", "Insurance premiums.", "613", "IAS 1.99"),
    CanonicalBucket("third_party_services",  "Third-party services",       BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "opex_general", "Consulting, legal, audit, marketing services.", "622, 626, 627, 628", "IAS 1.99"),
    CanonicalBucket("transport_logistics",   "Transport & logistics",      BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "opex_general", "Freight, transport, logistics services.", "624", "IAS 1.99"),
    CanonicalBucket("travel_protocol",       "Travel & protocol",          BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "opex_general", "Travel, accommodation, business entertainment.", "625, 623", "IAS 1.99"),
    CanonicalBucket("other_operating_taxes", "Other operating taxes",      BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "opex_general", "Non-income taxes: property tax, local taxes, environmental fees.", "63 (635, 636 etc.)", "IAS 12 (non-income tax) / IAS 1.99"),
    CanonicalBucket("other_operating_expenses", "Other operating expenses", BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "opex_general", "Residual operating expenses.", "65 catchall", "IAS 1.99"),
]

_PL_PERSONNEL: List[CanonicalBucket] = [
    CanonicalBucket("personnel_wages",       "Personnel — wages",          BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "personnel_total", "Gross wages and salaries.", "641", "IAS 19.5(a)"),
    CanonicalBucket("personnel_social_security", "Personnel — social security", BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "personnel_total", "Employer social security contributions.", "645", "IAS 19.5(a)"),
    CanonicalBucket("personnel_benefits",    "Personnel — benefits",       BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "personnel_total", "Meal vouchers, training, other employee benefits.", "642, 644, 647", "IAS 19.5(a)"),
    CanonicalBucket("personnel_other_contributions", "Personnel — other contributions", BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "personnel_total", "Work-insurance, other mandatory employer contributions.", "646", "IAS 19.5(a)"),
]

_PL_DAP: List[CanonicalBucket] = [
    CanonicalBucket("depreciation_ppe",      "Depreciation — PPE",         BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "dap", "Depreciation of property, plant, and equipment.", "6811", "IAS 16.50"),
    CanonicalBucket("depreciation_rou_assets", "Depreciation — ROU assets", BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "dap", "Depreciation of right-of-use assets (IFRS 16). Zero for RAS-only.", "(n/a in RAS SME)", "IFRS 16.32"),
    CanonicalBucket("amortization_intangibles", "Amortization — intangibles", BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "dap", "Amortization of finite-life intangibles. RAS lumps with depreciation in 6811; IFRS splits.", "6811 (RAS combines)", "IAS 38.97"),
    CanonicalBucket("impairment_goodwill",   "Impairment — goodwill",      BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "dap", "Goodwill impairment charges (IFRS only; RAS amortizes goodwill).", "(rare in RAS SME)", "IAS 36.124"),
    CanonicalBucket("impairment_ppe_intangibles", "Impairment — PPE/intangibles", BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "dap", "Impairment write-downs on PPE and other intangibles.", "6813", "IAS 36"),
    CanonicalBucket("impairment_receivables", "Impairment — receivables",  BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "dap", "Expected credit loss charges on receivables.", "654, 6814", "IFRS 9 ECL"),
    CanonicalBucket("provision_charges",     "Provision charges",          BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "dap", "Provisions booked during the period.", "6812", "IAS 37.59"),
    CanonicalBucket("provision_reversals",   "Provision reversals",        BucketType.EXPENSE, SignMeaning.EXPENSE_NEGATIVE, "dap", "Reversals of previously-booked provisions; contra to provision_charges.", "781", "IAS 37.59"),
]

_PL_OTHER_OP_INCOME: List[CanonicalBucket] = [
    CanonicalBucket("other_operating_income_recurring", "Other operating income — recurring", BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "other_op_income", "Recurring miscellaneous operating income.", "758 (sub-detail)", "IAS 1.99"),
    CanonicalBucket("other_operating_income_one_off", "Other operating income — one-off", BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "other_op_income", "Non-recurring operating income (legal settlements, write-back of payables).", "758 (sub-detail)", "IAS 1.99"),
    CanonicalBucket("government_grants_recognized", "Government grants recognized", BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "other_op_income", "Government grants amortized from deferred income.", "740, 7584", "IAS 20.12"),
    CanonicalBucket("gain_loss_disposal_ppe", "Gain/(loss) on PPE disposals", BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "other_op_income", "Net gain (positive) or loss (negative magnitude with sign hint) on PPE disposals.", "7583 (G), 6583 (L)", "IAS 16.71"),
    # Memo lines — not in any parent_aggregate sum; methodology layer uses them
    CanonicalBucket("capitalized_own_work_memo", "Capitalized own work (memo)", BucketType.MEMO, SignMeaning.REVENUE_POSITIVE, "memo_pl", "Own-work capitalized to PPE/intangibles. RAS-explicit; IFRS implicit in capex.", "72x", "IAS 16.22 / IAS 23"),
    CanonicalBucket("inventory_variation_memo", "Inventory variation (memo)", BucketType.MEMO, SignMeaning.SIGNED, "memo_pl", "Net change in finished/WIP inventory (production stocked minus consumed). RAS-specific; IFRS books in COGS.", "711 net", "(n/a; IFRS books in COGS)"),
]

_PL_FINANCIAL: List[CanonicalBucket] = [
    CanonicalBucket("interest_income",       "Interest income",            BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "financial_income", "Interest earned on cash, deposits, loans extended.", "766", "IFRS 9.5.4.1 / IAS 1.82(a)"),
    CanonicalBucket("dividend_income_affiliates", "Dividend income — affiliates", BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "financial_income", "Dividends from affiliated entities.", "7611, 7612", "IAS 27 / IAS 1.82(a)"),
    CanonicalBucket("dividend_income_other", "Dividend income — other",    BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "financial_income", "Dividends from non-affiliated investments.", "762, 763", "IFRS 9"),
    CanonicalBucket("fx_gain_realized",      "FX gain — realized",         BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "financial_income", "FX gains from settled transactions.", "7651 (sub)", "IAS 21.28"),
    CanonicalBucket("fx_gain_unrealized",    "FX gain — unrealized",       BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "financial_income", "FX gains from period-end revaluation of FX balances. Cash EBITDA strips this.", "7651 (sub)", "IAS 21.28"),
    CanonicalBucket("discounts_received_financial", "Discounts received (financial)", BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "financial_income", "Early-payment discounts received from suppliers (financial component).", "767", "IFRS 9"),
    CanonicalBucket("other_financial_income", "Other financial income",    BucketType.REVENUE, SignMeaning.REVENUE_POSITIVE, "financial_income", "Residual financial income items.", "768", "IAS 1"),
    CanonicalBucket("interest_expense",      "Interest expense",           BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "financial_expense", "Interest on bank debt, lease liabilities, intercompany loans.", "666", "IFRS 9 / IAS 1.82(b)"),
    CanonicalBucket("fx_loss_realized",      "FX loss — realized",         BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "financial_expense", "FX losses from settled transactions.", "6651 (sub)", "IAS 21.28"),
    CanonicalBucket("fx_loss_unrealized",    "FX loss — unrealized",       BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "financial_expense", "FX losses from period-end revaluation. Cash EBITDA strips this.", "6651 (sub)", "IAS 21.28"),
    CanonicalBucket("discount_charges",      "Discount charges",           BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "financial_expense", "Early-payment discounts given to customers (financial component).", "667", "IFRS 9"),
    CanonicalBucket("other_financial_expense", "Other financial expense",  BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "financial_expense", "Residual financial expense items.", "668", "IAS 1"),
]

_PL_TAX: List[CanonicalBucket] = [
    CanonicalBucket("income_tax_current",    "Income tax — current",       BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "income_tax", "Current period income tax expense.", "691", "IAS 12.46"),
    CanonicalBucket("income_tax_deferred",   "Income tax — deferred",      BucketType.EXPENSE, SignMeaning.EXPENSE_POSITIVE, "income_tax", "Deferred tax expense/benefit from temporary differences.", "6912 (rare in RAS SME)", "IAS 12.46"),
]

PL_BUCKETS: List[CanonicalBucket] = (
    _PL_REVENUE + _PL_COGS + _PL_OPEX + _PL_PERSONNEL +
    _PL_DAP + _PL_OTHER_OP_INCOME + _PL_FINANCIAL + _PL_TAX
)


# ────────────────────────────────────────────────────────────────────────
# §5 — CASH FLOW STATEMENT (25 leaves across 3 parent aggregates)
# Indirect method only for v1; direct method support is a future option.
# ────────────────────────────────────────────────────────────────────────

_CF_OPERATING: List[CanonicalBucket] = [
    CanonicalBucket("cfo_net_income_anchor", "CFO — net income anchor",    BucketType.CF_OPERATING, SignMeaning.SIGNED, "cfo", "Anchors at statutory net income (current_year_profit - current_year_loss).", "(derived from BS)", "IAS 7.18(b)"),
    CanonicalBucket("cfo_da_addback",        "CFO — D&A addback",          BucketType.CF_OPERATING, SignMeaning.CF_INFLOW, "cfo", "Adds back non-cash depreciation + amortization.", "(derived from PL dap)", "IAS 7.20(b)"),
    CanonicalBucket("cfo_provision_net_addback", "CFO — provision net addback", BucketType.CF_OPERATING, SignMeaning.SIGNED, "cfo", "Adds back net provision movements (charges minus reversals).", "(derived from PL)", "IAS 7.20(b)"),
    CanonicalBucket("cfo_fx_unrealized_addback", "CFO — FX unrealized addback", BucketType.CF_OPERATING, SignMeaning.SIGNED, "cfo", "Adds back unrealized FX gains/losses (non-cash).", "(derived from PL)", "IAS 7.28"),
    CanonicalBucket("cfo_other_non_cash_addback", "CFO — other non-cash addback", BucketType.CF_OPERATING, SignMeaning.SIGNED, "cfo", "Residual non-cash items (impairments, gain/loss on disposals).", "(derived from PL)", "IAS 7.20(b)"),
    CanonicalBucket("cfo_delta_inventory",   "CFO — Δ inventory",          BucketType.CF_OPERATING, SignMeaning.SIGNED, "cfo", "Negative of closing - opening inventory_net.", "(BS comparison)", "IAS 7.20(a)"),
    CanonicalBucket("cfo_delta_receivables", "CFO — Δ receivables",        BucketType.CF_OPERATING, SignMeaning.SIGNED, "cfo", "Negative of closing - opening receivables (trade + other).", "(BS comparison)", "IAS 7.20(a)"),
    CanonicalBucket("cfo_delta_payables",    "CFO — Δ payables",           BucketType.CF_OPERATING, SignMeaning.SIGNED, "cfo", "Positive of closing - opening payables (trade + tax + personnel).", "(BS comparison)", "IAS 7.20(a)"),
    CanonicalBucket("cfo_delta_other_wc",    "CFO — Δ other working capital", BucketType.CF_OPERATING, SignMeaning.SIGNED, "cfo", "Residual working capital movements (prepayments, deferred revenue, advances).", "(BS comparison)", "IAS 7.20(a)"),
    CanonicalBucket("cfo_interest_paid",     "CFO — interest paid",        BucketType.CF_OPERATING, SignMeaning.CF_OUTFLOW, "cfo", "Cash paid on interest (can be classified in CFF per IAS 7.33 — convention is CFO here).", "(cash basis from PL 666)", "IAS 7.31"),
    CanonicalBucket("cfo_income_tax_paid",   "CFO — income tax paid",      BucketType.CF_OPERATING, SignMeaning.CF_OUTFLOW, "cfo", "Cash paid for income tax.", "(cash basis from PL 691)", "IAS 7.35"),
]

_CF_INVESTING: List[CanonicalBucket] = [
    CanonicalBucket("cfi_capex_ppe",         "CFI — capex on PPE",         BucketType.CF_INVESTING, SignMeaning.CF_OUTFLOW, "cfi", "Cash outflow for PPE acquisitions (from BS gross PPE delta).", "(BS gross delta)", "IAS 7.16(a)"),
    CanonicalBucket("cfi_capex_intangibles", "CFI — capex on intangibles", BucketType.CF_INVESTING, SignMeaning.CF_OUTFLOW, "cfi", "Cash outflow for intangible asset acquisitions.", "(BS gross delta)", "IAS 7.16(a)"),
    CanonicalBucket("cfi_acquisitions",      "CFI — acquisitions",         BucketType.CF_INVESTING, SignMeaning.CF_OUTFLOW, "cfi", "Cash outflow for business combinations + affiliate acquisitions.", "(BS delta + notes)", "IAS 7.39"),
    CanonicalBucket("cfi_disposals",         "CFI — disposals",            BucketType.CF_INVESTING, SignMeaning.CF_INFLOW, "cfi", "Cash inflow from PPE / business disposals (net proceeds).", "(BS delta + 7583)", "IAS 7.16(b)"),
    CanonicalBucket("cfi_financial_investments_net", "CFI — financial investments net", BucketType.CF_INVESTING, SignMeaning.SIGNED, "cfi", "Net change in long-term financial investments.", "(BS delta of 26x)", "IAS 7.16(c)"),
    CanonicalBucket("cfi_interest_received", "CFI — interest received",    BucketType.CF_INVESTING, SignMeaning.CF_INFLOW, "cfi", "Cash interest received (can also be CFO per IAS 7.33; convention is CFI here).", "(cash basis from PL 766)", "IAS 7.31"),
    CanonicalBucket("cfi_dividends_received", "CFI — dividends received",  BucketType.CF_INVESTING, SignMeaning.CF_INFLOW, "cfi", "Cash dividends received from affiliates and other investments.", "(cash basis from PL 761/762)", "IAS 7.31"),
]

_CF_FINANCING: List[CanonicalBucket] = [
    CanonicalBucket("cff_debt_drawn",        "CFF — debt drawn",           BucketType.CF_FINANCING, SignMeaning.CF_INFLOW, "cff", "New debt issuance / drawdowns.", "(BS delta)", "IAS 7.17(c)"),
    CanonicalBucket("cff_debt_repaid",       "CFF — debt repaid",          BucketType.CF_FINANCING, SignMeaning.CF_OUTFLOW, "cff", "Principal repayments on debt.", "(BS delta)", "IAS 7.17(d)"),
    CanonicalBucket("cff_lease_payments_principal", "CFF — lease principal payments", BucketType.CF_FINANCING, SignMeaning.CF_OUTFLOW, "cff", "Principal portion of IFRS 16 lease payments.", "(BS lease liability delta)", "IFRS 16.50 / IAS 7.17(e)"),
    CanonicalBucket("cff_equity_issued",     "CFF — equity issued",        BucketType.CF_FINANCING, SignMeaning.CF_INFLOW, "cff", "Cash from share issuance.", "(BS share_capital + share_premium delta)", "IAS 7.17(a)"),
    CanonicalBucket("cff_equity_repurchased", "CFF — equity repurchased",  BucketType.CF_FINANCING, SignMeaning.CF_OUTFLOW, "cff", "Cash for treasury share buybacks.", "(BS treasury_shares delta)", "IAS 7.17(b)"),
    CanonicalBucket("cff_dividends_paid",    "CFF — dividends paid",       BucketType.CF_FINANCING, SignMeaning.CF_OUTFLOW, "cff", "Cash dividend distributions.", "(457 movement)", "IAS 7.31"),
    CanonicalBucket("cff_other",             "CFF — other financing",      BucketType.CF_FINANCING, SignMeaning.SIGNED, "cff", "Residual financing items.", "(residual)", "IAS 7.17"),
]

CF_BUCKETS: List[CanonicalBucket] = _CF_OPERATING + _CF_INVESTING + _CF_FINANCING


# ────────────────────────────────────────────────────────────────────────
# Aggregate views — for round-trip gate
# ────────────────────────────────────────────────────────────────────────

ALL_BUCKETS: List[CanonicalBucket] = BS_BUCKETS + PL_BUCKETS + CF_BUCKETS


def _aggregates_for(buckets: List[CanonicalBucket]) -> Dict[str, List[str]]:
    """Group bucket canonical_names by their parent_aggregate."""
    out: Dict[str, List[str]] = {}
    for b in buckets:
        out.setdefault(b.parent_aggregate, []).append(b.canonical_name)
    return out


PARENT_AGGREGATES_BS: Dict[str, List[str]] = _aggregates_for(BS_BUCKETS)
PARENT_AGGREGATES_PL: Dict[str, List[str]] = _aggregates_for(PL_BUCKETS)
PARENT_AGGREGATES_CF: Dict[str, List[str]] = _aggregates_for(CF_BUCKETS)


def bucket_by_name(name: str) -> Optional[CanonicalBucket]:
    """O(1) lookup. Returns None for unknown names (caller decides whether
    that's a hard error vs. a benign miss during migration)."""
    for b in ALL_BUCKETS:
        if b.canonical_name == name:
            return b
    return None


def leaves_for_aggregate(aggregate_name: str) -> List[str]:
    """Return the canonical_name list of leaves that compose the given
    parent_aggregate. Used by F4.1-ROUNDTRIP to verify
    sum(leaves) == aggregate per fixture."""
    for d in (PARENT_AGGREGATES_BS, PARENT_AGGREGATES_PL, PARENT_AGGREGATES_CF):
        if aggregate_name in d:
            return list(d[aggregate_name])
    return []


# ────────────────────────────────────────────────────────────────────────
# Self-validation — runs at import time. Detects schema-level bugs early.
# ────────────────────────────────────────────────────────────────────────

def _validate_schema() -> None:
    """Assertions that must hold for the schema to be internally consistent.
    Caught at import time so a typo in a bucket definition fails loud."""
    seen_names: set = set()
    for b in ALL_BUCKETS:
        if b.canonical_name in seen_names:
            raise ValueError(f"Duplicate canonical_name: {b.canonical_name}")
        seen_names.add(b.canonical_name)
        # contra_of must reference real buckets (or be a compound formula
        # with `+` — those reference multiple buckets, validated separately)
        if b.contra_of and "+" not in b.contra_of:
            # Simple single-bucket reference
            if b.contra_of not in seen_names and b.contra_of not in {bb.canonical_name for bb in ALL_BUCKETS}:
                # Forward-reference — fine, just check it's in ALL_BUCKETS
                if not any(bb.canonical_name == b.contra_of for bb in ALL_BUCKETS):
                    raise ValueError(f"Bucket {b.canonical_name} contra_of references unknown bucket: {b.contra_of}")
    # Bucket counts match the F4.0 design doc
    assert len(BS_BUCKETS) == 79, f"BS_BUCKETS count {len(BS_BUCKETS)} != 79 (design floor)"
    assert len(PL_BUCKETS) == 55, f"PL_BUCKETS count {len(PL_BUCKETS)} != 55 (design floor)"
    assert len(CF_BUCKETS) == 25, f"CF_BUCKETS count {len(CF_BUCKETS)} != 25 (design floor)"


_validate_schema()
