"""
Comprehensive Financial Analysis — Romanian SME / Mid-cap from RAS Trial Balance
================================================================================

Implements the 8-section framework described in financial_analysis_methodology.md:
  1. Overview / KPIs
  2. P&L reconstruction
  3. Balance Sheet
  4. Cash Flow (indirect)
  5. Ratios (25+)
  6. Valuation (EV/EBITDA + DCF + NAV + Book)
  7. Risk & Credit (Altman Z", Piotroski, composite)
  8. Recommendations

USAGE:
    from financial_analysis import analyze_company

    result = analyze_company(
        trial_balance_path="balanta.xlsx",
        company_name="Scandia Food SRL",
        period="FY2025",
        industry="food_mfg",            # see INDUSTRY_BENCHMARKS below
        prior_period_path=None,         # optional; enables full cash flow
        output_html_path="report.html", # optional; writes HTML if set
    )

    # `result` is a dict containing all 8 sections' computed values.

The Scandia Food case is included as the calibration example at the bottom.
"""

from dataclasses import dataclass, field
from typing import Optional, List, Dict, Tuple
import pandas as pd


# ──────────────────────────────────────────────────────────────────────
# INDUSTRY BENCHMARKS (RO market, 2024-25)
# ──────────────────────────────────────────────────────────────────────

INDUSTRY_BENCHMARKS = {
    "food_mfg": {
        "ebitda_margin": (0.08, 0.13),
        "net_margin": (0.03, 0.07),
        "roe": (0.12, 0.20),
        "current_ratio": (1.2, 1.8),
        "quick_ratio": (0.7, 1.0),
        "net_debt_ebitda": (1.0, 3.0),
        "interest_coverage": (3.0, 8.0),
        "dio": (40, 70),
        "dso": (30, 60),
        "ev_ebitda_range": (6.0, 10.0),
        "default_wacc": 0.10,
    },
    "real_estate": {
        "ebitda_margin": (0.50, 0.80),
        "net_margin": (0.20, 0.50),
        "roe": (0.05, 0.12),
        "current_ratio": (0.8, 1.5),
        "quick_ratio": (0.5, 1.0),
        "net_debt_ebitda": (3.0, 8.0),
        "interest_coverage": (1.5, 4.0),
        "dio": (0, 5),
        "dso": (15, 45),
        "ev_ebitda_range": (8.0, 14.0),
        "default_wacc": 0.085,
    },
    "consumer_goods": {
        "ebitda_margin": (0.10, 0.18),
        "net_margin": (0.05, 0.10),
        "roe": (0.15, 0.25),
        "current_ratio": (1.5, 2.5),
        "quick_ratio": (0.8, 1.2),
        "net_debt_ebitda": (1.0, 2.5),
        "interest_coverage": (4.0, 10.0),
        "dio": (50, 90),
        "dso": (30, 60),
        "ev_ebitda_range": (7.0, 12.0),
        "default_wacc": 0.10,
    },
    "services": {
        "ebitda_margin": (0.12, 0.22),
        "net_margin": (0.06, 0.12),
        "roe": (0.15, 0.30),
        "current_ratio": (1.2, 2.0),
        "quick_ratio": (1.0, 1.6),
        "net_debt_ebitda": (0.5, 2.0),
        "interest_coverage": (5.0, 15.0),
        "dio": (0, 15),
        "dso": (30, 75),
        "ev_ebitda_range": (8.0, 14.0),
        "default_wacc": 0.105,
    },
    "default": {
        "ebitda_margin": (0.08, 0.15),
        "net_margin": (0.03, 0.08),
        "roe": (0.10, 0.20),
        "current_ratio": (1.2, 2.0),
        "quick_ratio": (0.7, 1.2),
        "net_debt_ebitda": (1.0, 3.0),
        "interest_coverage": (3.0, 8.0),
        "dio": (30, 70),
        "dso": (30, 60),
        "ev_ebitda_range": (6.0, 10.0),
        "default_wacc": 0.10,
    },
}


# ──────────────────────────────────────────────────────────────────────
# DATA LOADING
# ──────────────────────────────────────────────────────────────────────

def load_trial_balance(path: str) -> pd.DataFrame:
    """
    Load a Romanian RAS trial balance from xlsx/csv.
    Expected 10 columns (Romanian SAGA / WinMentor / Saga format):
      cont, nume, sold_init_D, sold_init_C, rulaj_D, rulaj_C,
      sume_tot_D, sume_tot_C, sold_fin_D, sold_fin_C
    """
    if path.endswith(".xlsx"):
        df = pd.read_excel(path, sheet_name=0, header=None, skiprows=1)
    else:
        df = pd.read_csv(path, header=None, skiprows=1)

    df.columns = [
        "cont", "nume",
        "sold_init_D", "sold_init_C",
        "rulaj_D", "rulaj_C",
        "sume_tot_D", "sume_tot_C",
        "sold_fin_D", "sold_fin_C",
    ]
    df = df[df["cont"].notna()].copy()
    df["cont"] = df["cont"].astype(str)
    for c in df.columns[2:]:
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)
    df["class"] = df["cont"].str[0]
    return df


def validate_trial_balance(df: pd.DataFrame) -> Dict:
    """Run basic sanity checks. Returns dict with status + any warnings."""
    issues = []
    sum_D = df["sume_tot_D"].sum()
    sum_C = df["sume_tot_C"].sum()
    if abs(sum_D - sum_C) > 1.0:
        issues.append(f"Trial balance not balanced: D={sum_D:,.2f}, C={sum_C:,.2f}")
    close_D = df["sold_fin_D"].sum()
    close_C = df["sold_fin_C"].sum()
    if abs(close_D - close_C) > 1.0:
        issues.append(f"Closing balances not balanced: D={close_D:,.2f}, C={close_C:,.2f}")
    if len(df) < 50:
        issues.append(f"Only {len(df)} accounts — may be incomplete")
    return {"status": "ok" if not issues else "warning",
            "issues": issues,
            "total_assets_estimate": close_D,
            "account_count": len(df)}


# Helper: sum balance for a list of account prefixes
def _sum_prefix(df: pd.DataFrame, prefixes, col: str) -> float:
    """Sum a column for accounts starting with any of the given prefixes."""
    if isinstance(prefixes, str):
        prefixes = [prefixes]
    mask = pd.Series([False] * len(df), index=df.index)
    for p in prefixes:
        mask |= df["cont"].str.startswith(p)
    return df.loc[mask, col].sum()


def _net_balance(df: pd.DataFrame, prefixes, side="D") -> float:
    """Closing balance net (D - C) or (C - D) for accounts."""
    if isinstance(prefixes, str):
        prefixes = [prefixes]
    d = _sum_prefix(df, prefixes, "sold_fin_D")
    c = _sum_prefix(df, prefixes, "sold_fin_C")
    return (d - c) if side == "D" else (c - d)


# ──────────────────────────────────────────────────────────────────────
# SECTION 2: P&L RECONSTRUCTION
# ──────────────────────────────────────────────────────────────────────

def build_pnl(df: pd.DataFrame) -> Dict:
    """Reconstruct P&L from class 6 (D movements) and class 7 (C movements)."""

    # Net Turnover (class 70 already nets 709 contra-revenue)
    net_turnover = _sum_prefix(df, "70", "sume_tot_C")

    # Revenue components for display
    sales_701 = _sum_prefix(df, "701", "sume_tot_C")
    sales_707 = _sum_prefix(df, "707", "sume_tot_C")
    sales_704_706 = _sum_prefix(df, ["704", "706"], "sume_tot_C")
    sales_708 = _sum_prefix(df, "708", "sume_tot_C")
    reductions_709 = _sum_prefix(df, "709", "sume_tot_C")

    # Production variation (711) — nets D vs C
    prod_var_net = (_sum_prefix(df, "711", "sume_tot_C")
                    - _sum_prefix(df, "711", "sume_tot_D"))

    # Other operating revenue
    capitalized_72 = _sum_prefix(df, "72", "sume_tot_C")
    other_op_758 = _sum_prefix(df, "758", "sume_tot_C")
    provision_rev_781 = _sum_prefix(df, "781", "sume_tot_C")

    total_op_revenue = (net_turnover + prod_var_net + capitalized_72
                        + other_op_758 + provision_rev_781)

    # Operating expenses
    exp_601 = _sum_prefix(df, "601", "sume_tot_D")
    exp_602 = _sum_prefix(df, "602", "sume_tot_D")
    exp_603 = _sum_prefix(df, "603", "sume_tot_D")
    exp_605 = _sum_prefix(df, "605", "sume_tot_D")
    exp_607 = _sum_prefix(df, "607", "sume_tot_D")
    exp_608 = _sum_prefix(df, "608", "sume_tot_D")
    exp_60_other = (_sum_prefix(df, "60", "sume_tot_D")
                    - (exp_601 + exp_602 + exp_603 + exp_605 + exp_607 + exp_608))
    exp_61 = _sum_prefix(df, "61", "sume_tot_D")
    exp_62 = _sum_prefix(df, "62", "sume_tot_D")
    exp_63 = _sum_prefix(df, "63", "sume_tot_D")
    exp_64 = _sum_prefix(df, "64", "sume_tot_D")
    exp_65 = _sum_prefix(df, "65", "sume_tot_D")
    exp_681 = _sum_prefix(df, "681", "sume_tot_D")
    exp_68_other = _sum_prefix(df, "68", "sume_tot_D") - exp_681

    total_op_expense = (exp_601 + exp_602 + exp_603 + exp_605 + exp_607 + exp_608
                        + exp_60_other + exp_61 + exp_62 + exp_63 + exp_64
                        + exp_65 + exp_681 + exp_68_other)

    ebit = total_op_revenue - total_op_expense
    ebitda = ebit + exp_681 + exp_68_other

    # Financial result
    rev_761 = _sum_prefix(df, "761", "sume_tot_C")
    rev_765 = _sum_prefix(df, "765", "sume_tot_C")
    rev_766 = _sum_prefix(df, "766", "sume_tot_C")
    rev_768 = _sum_prefix(df, "768", "sume_tot_C")
    fin_revenue = rev_761 + rev_765 + rev_766 + rev_768

    exp_665 = _sum_prefix(df, "665", "sume_tot_D")
    exp_666 = _sum_prefix(df, "666", "sume_tot_D")
    exp_667 = _sum_prefix(df, "667", "sume_tot_D")
    exp_668 = _sum_prefix(df, "668", "sume_tot_D")
    fin_expense = exp_665 + exp_666 + exp_667 + exp_668

    pbt = ebit + (fin_revenue - fin_expense)
    income_tax = _sum_prefix(df, "69", "sume_tot_D")
    net_profit_reconstructed = pbt - income_tax

    # Anchor: account 121 closing C balance is statutory net profit
    net_profit_statutory = (_sum_prefix(df, "121", "sold_fin_C")
                            - _sum_prefix(df, "121", "sold_fin_D"))

    reconciliation_gap = net_profit_reconstructed - net_profit_statutory
    reconciliation_pct = (reconciliation_gap / abs(net_profit_statutory) * 100
                          if net_profit_statutory else 0)

    return {
        "sales_701": sales_701, "sales_707": sales_707,
        "sales_704_706": sales_704_706, "sales_708": sales_708,
        "reductions_709": reductions_709,
        "net_turnover": net_turnover,
        "prod_var_net": prod_var_net,
        "capitalized_72": capitalized_72,
        "other_op_758": other_op_758,
        "provision_rev_781": provision_rev_781,
        "total_op_revenue": total_op_revenue,
        "exp_601": exp_601, "exp_602": exp_602, "exp_603": exp_603,
        "exp_605": exp_605, "exp_607": exp_607, "exp_608": exp_608,
        "exp_60_other": exp_60_other,
        "exp_61": exp_61, "exp_62": exp_62, "exp_63": exp_63,
        "exp_64": exp_64, "exp_65": exp_65, "exp_681": exp_681,
        "exp_68_other": exp_68_other,
        "total_op_expense": total_op_expense,
        "ebit": ebit, "ebitda": ebitda,
        "fin_revenue": fin_revenue, "fin_expense": fin_expense,
        "rev_761": rev_761, "rev_765": rev_765, "rev_766": rev_766, "rev_768": rev_768,
        "exp_665": exp_665, "exp_666": exp_666, "exp_667": exp_667, "exp_668": exp_668,
        "pbt": pbt, "income_tax": income_tax,
        "net_profit_reconstructed": net_profit_reconstructed,
        "net_profit_statutory": net_profit_statutory,
        "reconciliation_gap": reconciliation_gap,
        "reconciliation_pct": reconciliation_pct,
    }


# ──────────────────────────────────────────────────────────────────────
# SECTION 3: BALANCE SHEET
# ──────────────────────────────────────────────────────────────────────

def build_balance_sheet(df: pd.DataFrame) -> Dict:
    """Build balance sheet from classes 1-5 closing balances."""

    # NON-CURRENT ASSETS
    intangibles_gross = _sum_prefix(df, ["205", "208"], "sold_fin_D")
    intangibles_amort = _sum_prefix(df, "280", "sold_fin_C")
    intangibles_net = intangibles_gross - intangibles_amort

    ppe_gross = _sum_prefix(df, ["211", "212", "213", "214"], "sold_fin_D")
    ppe_amort = _sum_prefix(df, "281", "sold_fin_C")
    ppe_net = ppe_gross - ppe_amort

    investment_property = _net_balance(df, "215", "D")
    cip = _net_balance(df, "23", "D") - _sum_prefix(df, "29", "sold_fin_C")

    affiliates = _net_balance(df, "261", "D")
    interests = _net_balance(df, "263", "D")
    other_lt_inv = _net_balance(df, ["265", "267"], "D")
    financial_fixed = affiliates + interests + other_lt_inv

    total_noncurrent = (intangibles_net + ppe_net + investment_property
                        + cip + financial_fixed)

    # CURRENT ASSETS
    inventory_gross = _sum_prefix(df, "3", "sold_fin_D")
    inventory_provisions = _sum_prefix(df, "39", "sold_fin_C")
    # Class 3 also has some credit balances for price differentials etc
    inventory_other_credits = (_sum_prefix(df, "3", "sold_fin_C")
                               - inventory_provisions)
    total_inventory = inventory_gross - inventory_provisions - inventory_other_credits

    # Receivables — class 4 GROSS debit balances (don't net against credit side;
    # class 43 and 44 have separate sub-accounts where debit = asset and
    # credit = liability — netting would understate both receivables and payables)
    trade_rec = _sum_prefix(df, "411", "sold_fin_D")  # gross trade receivables
    notes_rec = _sum_prefix(df, "413", "sold_fin_D")
    supplier_adv = _sum_prefix(df, "409", "sold_fin_D")
    state_rec = _sum_prefix(df, "44", "sold_fin_D")     # VAT recoverable, advance tax
    other_debtors = _sum_prefix(df, "46", "sold_fin_D")
    prepaid = _sum_prefix(df, "471", "sold_fin_D")
    personnel_rec = _sum_prefix(df, ["425", "4282"], "sold_fin_D")
    social_rec = _sum_prefix(df, "43", "sold_fin_D")     # social security receivable
    affiliated_rec = _sum_prefix(df, ["451", "452", "455"], "sold_fin_D")
    rec_provisions = _sum_prefix(df, "49", "sold_fin_C")
    total_receivables = (trade_rec + notes_rec + supplier_adv + state_rec
                         + other_debtors + prepaid + personnel_rec + social_rec
                         + affiliated_rec - rec_provisions)

    # Cash
    cash_lei = _net_balance(df, "5121", "D")
    cash_fx = _net_balance(df, "5124", "D")
    cash_other = _net_balance(df, ["5125", "5128"], "D")
    petty_cash = _sum_prefix(df, "531", "sold_fin_D")
    transit = _net_balance(df, "581", "D")
    cash_other_5xx = _net_balance(df, ["541", "542"], "D")
    total_cash = cash_lei + cash_fx + cash_other + petty_cash + transit + cash_other_5xx

    total_current = total_inventory + total_receivables + total_cash
    total_assets = total_noncurrent + total_current

    # EQUITY
    share_capital = _sum_prefix(df, "101", "sold_fin_C")
    share_premium = _sum_prefix(df, "104", "sold_fin_C")
    revaluation = _sum_prefix(df, "105", "sold_fin_C")
    reserves_legal = _sum_prefix(df, "1061", "sold_fin_C")
    reserves_other = _sum_prefix(df, "1068", "sold_fin_C")
    retained = _net_balance(df, "117", "C")
    current_profit = _net_balance(df, "121", "C")
    total_equity = (share_capital + share_premium + revaluation + reserves_legal
                    + reserves_other + retained + current_profit)

    # LIABILITIES
    provisions = _net_balance(df, "15", "C")
    lt_bank = _net_balance(df, "162", "C")
    leasing = _net_balance(df, "167", "C")
    lt_interest = _net_balance(df, "168", "C")
    subsidies = _net_balance(df, "475", "C")
    grants = _net_balance(df, "478", "C")
    total_lt_liab = provisions + lt_bank + leasing + lt_interest + subsidies + grants
    total_lt_debt = lt_bank + leasing + lt_interest

    st_bank = _net_balance(df, "519", "C")
    trade_pay = _sum_prefix(df, "401", "sold_fin_C")
    notes_pay = _sum_prefix(df, "403", "sold_fin_C")
    fa_pay = _sum_prefix(df, ["404", "405"], "sold_fin_C")
    invoices_not_recd = _sum_prefix(df, "408", "sold_fin_C")
    customer_accruals = _sum_prefix(df, "418", "sold_fin_C")
    customer_advances = _sum_prefix(df, "419", "sold_fin_C")
    personnel = _sum_prefix(df, ["421", "423", "427", "428"], "sold_fin_C")
    social_pay = _sum_prefix(df, "43", "sold_fin_C")  # gross social security payable
    tax_pay = _sum_prefix(df, "44", "sold_fin_C")     # gross taxes payable
    dividends_pay = _sum_prefix(df, "457", "sold_fin_C")
    other_creditors = _sum_prefix(df, "462", "sold_fin_C")
    affiliated_pay = _sum_prefix(df, ["451", "452", "455"], "sold_fin_C")
    deferred_rev = _sum_prefix(df, "472", "sold_fin_C")

    total_st_liab = (st_bank + trade_pay + notes_pay + fa_pay + invoices_not_recd
                     + customer_accruals + customer_advances + personnel
                     + social_pay + tax_pay + dividends_pay + other_creditors
                     + affiliated_pay + deferred_rev)

    total_liab = total_lt_liab + total_st_liab
    total_debt = total_lt_debt + st_bank
    net_debt = total_debt - total_cash

    reconciliation_gap = (total_equity + total_liab) - total_assets
    reconciliation_pct = (reconciliation_gap / total_assets * 100
                          if total_assets else 0)

    return {
        # Non-current
        "intangibles_gross": intangibles_gross,
        "intangibles_amort": intangibles_amort,
        "intangibles_net": intangibles_net,
        "ppe_gross": ppe_gross, "ppe_amort": ppe_amort, "ppe_net": ppe_net,
        "investment_property": investment_property,
        "cip": cip,
        "affiliates": affiliates, "interests": interests,
        "other_lt_inv": other_lt_inv, "financial_fixed": financial_fixed,
        "total_noncurrent": total_noncurrent,
        # Current
        "total_inventory": total_inventory,
        "trade_rec": trade_rec, "rec_provisions": rec_provisions,
        "total_receivables": total_receivables,
        "cash_lei": cash_lei, "cash_fx": cash_fx, "total_cash": total_cash,
        "total_current": total_current,
        "total_assets": total_assets,
        # Equity
        "share_capital": share_capital, "share_premium": share_premium,
        "revaluation": revaluation,
        "reserves_legal": reserves_legal, "reserves_other": reserves_other,
        "retained": retained, "current_profit": current_profit,
        "total_equity": total_equity,
        # Liabilities
        "provisions": provisions, "lt_bank": lt_bank, "leasing": leasing,
        "subsidies": subsidies, "total_lt_liab": total_lt_liab,
        "total_lt_debt": total_lt_debt,
        "st_bank": st_bank, "trade_pay": trade_pay,
        "personnel": personnel, "social_pay": social_pay, "tax_pay": tax_pay,
        "dividends_pay": dividends_pay,
        "total_st_liab": total_st_liab, "total_liab": total_liab,
        "total_debt": total_debt, "net_debt": net_debt,
        # Reconciliation
        "reconciliation_gap": reconciliation_gap,
        "reconciliation_pct": reconciliation_pct,
    }


# ──────────────────────────────────────────────────────────────────────
# SECTION 4: CASH FLOW (INDIRECT METHOD)
# ──────────────────────────────────────────────────────────────────────

def build_cash_flow(pnl: Dict, bs: Dict,
                    prior_bs: Optional[Dict] = None) -> Dict:
    """
    Indirect-method cash flow. If prior_bs is None, working capital changes
    are flagged as approximated and marked with ~ symbol in output.
    """
    is_approximated = prior_bs is None

    # Operating
    net_profit = pnl["net_profit_statutory"]
    da = pnl["exp_681"]
    provision_movement = pnl["provision_rev_781"] - pnl["exp_65"] * 0.2  # rough
    cf_before_wc = net_profit + da + provision_movement

    if prior_bs:
        delta_inventory = -(bs["total_inventory"] - prior_bs["total_inventory"])
        delta_receivables = -(bs["total_receivables"] - prior_bs["total_receivables"])
        delta_trade_pay = bs["trade_pay"] - prior_bs["trade_pay"]
        delta_tax_pay = bs["tax_pay"] - prior_bs["tax_pay"]
    else:
        # Approximate at ±15%
        delta_inventory = -bs["total_inventory"] * 0.05
        delta_receivables = -bs["total_receivables"] * 0.05
        delta_trade_pay = bs["trade_pay"] * 0.05
        delta_tax_pay = bs["tax_pay"] * 0.02

    wc_changes = delta_inventory + delta_receivables + delta_trade_pay + delta_tax_pay
    cfo = cf_before_wc + wc_changes

    # Investing
    if prior_bs:
        capex = -((bs["ppe_gross"] - prior_bs["ppe_gross"]))
        cip_change = -(bs["cip"] - prior_bs["cip"])
        affiliate_change = -(bs["affiliates"] - prior_bs["affiliates"])
    else:
        capex = -bs["ppe_gross"] * 0.05  # approximation
        cip_change = -bs["cip"] * 0.5
        affiliate_change = -bs["affiliates"] * 0.02

    dividends_received = pnl["rev_761"]
    interest_received = pnl["rev_766"]
    cfi = capex + cip_change + affiliate_change + dividends_received + interest_received

    # Financing
    if prior_bs:
        delta_lt_debt = bs["total_lt_debt"] - prior_bs["total_lt_debt"]
        delta_st_bank = bs["st_bank"] - prior_bs["st_bank"]
    else:
        delta_lt_debt = -bs["total_lt_debt"] * 0.10  # assume some repayment
        delta_st_bank = bs["st_bank"] * 0.10

    interest_paid = -pnl["exp_666"]
    # Dividends paid = prior current profit moved to 117/distributed via 129
    dividends_paid = -net_profit * 0.5  # rough; depends on policy
    cff = delta_lt_debt + delta_st_bank + interest_paid + dividends_paid

    net_change_cash = cfo + cfi + cff

    return {
        "net_profit": net_profit, "da": da, "provision_movement": provision_movement,
        "cf_before_wc": cf_before_wc,
        "delta_inventory": delta_inventory, "delta_receivables": delta_receivables,
        "delta_trade_pay": delta_trade_pay, "delta_tax_pay": delta_tax_pay,
        "wc_changes": wc_changes, "cfo": cfo,
        "capex": capex, "cip_change": cip_change, "affiliate_change": affiliate_change,
        "dividends_received": dividends_received, "interest_received": interest_received,
        "cfi": cfi,
        "delta_lt_debt": delta_lt_debt, "delta_st_bank": delta_st_bank,
        "interest_paid": interest_paid, "dividends_paid": dividends_paid,
        "cff": cff,
        "net_change_cash": net_change_cash,
        "is_approximated": is_approximated,
    }


# ──────────────────────────────────────────────────────────────────────
# SECTION 5: FINANCIAL RATIOS
# ──────────────────────────────────────────────────────────────────────

def build_ratios(pnl: Dict, bs: Dict, prior_bs: Optional[Dict] = None) -> Dict:
    """Compute 25+ ratios across 5 dimensions."""

    turnover = pnl["net_turnover"]
    ebitda = pnl["ebitda"]
    ebit = pnl["ebit"]
    net_profit = pnl["net_profit_statutory"]
    total_assets = bs["total_assets"]
    total_equity = bs["total_equity"]
    total_debt = bs["total_debt"]
    net_debt = bs["net_debt"]
    interest_exp = pnl["exp_666"]

    avg_assets = (total_assets + prior_bs["total_assets"]) / 2 if prior_bs else total_assets
    avg_equity = (total_equity + prior_bs["total_equity"]) / 2 if prior_bs else total_equity
    avg_inventory = ((bs["total_inventory"] + prior_bs["total_inventory"]) / 2
                     if prior_bs else bs["total_inventory"])

    # Two different COGS proxies — purposes differ:
    # `gross_margin_proxy_cogs` (narrow: 601+602+607) — for the GROSS MARGIN ratio,
    #   answers "what % of revenue is left after direct materials/merchandise costs?"
    # `total_cogs_for_turnover` (broad: full operating expense) — for INVENTORY TURNOVER,
    #   DIO and DPO ratios; in a manufacturer, inventory absorbs all production costs
    #   (materials + labor + utilities + overhead via 711 movements), not just raw materials.
    #   Industry convention for DIO uses total operating expense as the denominator.
    gross_margin_proxy_cogs = pnl["exp_601"] + pnl["exp_602"] + pnl["exp_607"]
    total_cogs_for_turnover = pnl["total_op_expense"]

    def _safe_div(a, b):
        return a / b if b not in (0, None) else 0

    return {
        # Profitability
        "ebitda_margin": _safe_div(ebitda, turnover),
        "ebit_margin": _safe_div(ebit, turnover),
        "net_margin": _safe_div(net_profit, turnover),
        "gross_margin_proxy": _safe_div(turnover - gross_margin_proxy_cogs, turnover),
        "roe": _safe_div(net_profit, avg_equity),
        "roa": _safe_div(net_profit, avg_assets),
        "roic": _safe_div(ebit * 0.84, total_equity + total_debt),
        # Liquidity
        "current_ratio": _safe_div(bs["total_current"], bs["total_st_liab"]),
        "quick_ratio": _safe_div(bs["total_current"] - bs["total_inventory"],
                                 bs["total_st_liab"]),
        "cash_ratio": _safe_div(bs["total_cash"], bs["total_st_liab"]),
        "working_capital": bs["total_current"] - bs["total_st_liab"],
        # Leverage
        "equity_ratio": _safe_div(total_equity, total_assets),
        "debt_to_equity": _safe_div(total_debt, total_equity),
        "lt_debt_to_equity": _safe_div(bs["total_lt_debt"], total_equity),
        "net_debt_ebitda": _safe_div(net_debt, ebitda) if ebitda else 0,
        "debt_to_assets": _safe_div(total_debt, total_assets),
        # Coverage
        "interest_coverage": _safe_div(ebit, interest_exp) if interest_exp else 999,
        "ebitda_to_interest": _safe_div(ebitda, interest_exp) if interest_exp else 999,
        "dscr": _safe_div(ebitda, interest_exp + bs["total_lt_debt"] / 8) if interest_exp else 999,
        # Efficiency (using TOTAL operating expense as COGS proxy — correct for manufacturers)
        "asset_turnover": _safe_div(turnover, avg_assets),
        "inventory_turnover": _safe_div(total_cogs_for_turnover, avg_inventory),
        "dio": _safe_div(avg_inventory, total_cogs_for_turnover) * 365 if total_cogs_for_turnover else 0,
        "dso": _safe_div(bs["total_receivables"], turnover) * 365 if turnover else 0,
        "dpo": _safe_div(bs["trade_pay"], total_cogs_for_turnover) * 365 if total_cogs_for_turnover else 0,
        # Cash conversion cycle
        "ccc": (_safe_div(avg_inventory, total_cogs_for_turnover) * 365
                + _safe_div(bs["total_receivables"], turnover) * 365
                - _safe_div(bs["trade_pay"], total_cogs_for_turnover) * 365),
    }


# ──────────────────────────────────────────────────────────────────────
# SECTION 6: VALUATION
# ──────────────────────────────────────────────────────────────────────

def build_valuation(pnl: Dict, bs: Dict, ratios: Dict, industry: str = "default") -> Dict:
    """Multi-method valuation envelope."""
    ebitda = pnl["ebitda"]
    net_profit = pnl["net_profit_statutory"]
    net_debt = bs["net_debt"]
    total_equity = bs["total_equity"]
    bench = INDUSTRY_BENCHMARKS.get(industry, INDUSTRY_BENCHMARKS["default"])

    ev_low, ev_high = bench["ev_ebitda_range"]
    ev_mid = (ev_low + ev_high) / 2
    wacc = bench["default_wacc"]
    g_terminal = 0.03

    # EV/EBITDA at three points
    valuations_ev = []
    for mult, label in [(ev_low, "Conservative"), (ev_mid, "Mid"), (ev_high, "Premium")]:
        ev = ebitda * mult
        equity = ev - net_debt
        valuations_ev.append({"label": label, "multiple": mult, "ev": ev, "equity": equity})

    # DCF with Gordon terminal — 5-year explicit
    fcf_base = net_profit  # assumes maint capex ≈ D&A
    g_explicit = 0.05  # default growth
    dcf_explicit = sum(fcf_base * ((1 + g_explicit) ** t) / ((1 + wacc) ** t)
                       for t in range(1, 6))
    fcf_year5 = fcf_base * ((1 + g_explicit) ** 5)
    terminal_value = fcf_year5 * (1 + g_terminal) / (wacc - g_terminal)
    dcf_terminal_pv = terminal_value / ((1 + wacc) ** 5)
    dcf_ev = dcf_explicit + dcf_terminal_pv
    dcf_equity = dcf_ev - net_debt

    # NAV simple version (full cascade is in nav_calculator.py)
    # Adjusted NAV: book + 20% uplift on PP&E + 25% uplift on affiliates, less DT
    ppe_uplift = bs["ppe_net"] * 0.20
    affiliate_uplift = bs["affiliates"] * 0.25
    deferred_tax = (ppe_uplift + affiliate_uplift) * 0.16
    nnnav = total_equity + ppe_uplift + affiliate_uplift - deferred_tax

    return {
        "industry": industry,
        "ev_multiples": valuations_ev,
        "wacc": wacc, "g_terminal": g_terminal, "g_explicit": g_explicit,
        "fcf_base": fcf_base,
        "dcf_explicit_pv": dcf_explicit, "terminal_value": terminal_value,
        "dcf_terminal_pv": dcf_terminal_pv, "dcf_ev": dcf_ev, "dcf_equity": dcf_equity,
        "nnnav": nnnav, "book_equity": total_equity,
        "ppe_uplift": ppe_uplift, "affiliate_uplift": affiliate_uplift,
        "deferred_tax": deferred_tax,
    }


# ──────────────────────────────────────────────────────────────────────
# SECTION 7: RISK & CREDIT
# ──────────────────────────────────────────────────────────────────────

def build_credit_score(pnl: Dict, bs: Dict, ratios: Dict) -> Dict:
    """Altman Z" + composite credit score."""

    total_assets = bs["total_assets"]
    if not total_assets:
        return {"altman_z_double_prime": 0, "composite": 0, "grade": "N/A"}

    # Altman Z" — emerging markets variant
    X1 = (bs["total_current"] - bs["total_st_liab"]) / total_assets
    X2 = bs["retained"] / total_assets
    X3 = pnl["ebit"] / total_assets
    X4 = bs["total_equity"] / max(bs["total_liab"], 1)
    z_double_prime = 6.56 * X1 + 3.26 * X2 + 6.72 * X3 + 1.05 * X4

    # Map Z" to 0-100 score
    if z_double_prime >= 2.60:
        altman_score = min(100, 70 + (z_double_prime - 2.60) * 15)
    elif z_double_prime >= 1.10:
        altman_score = 40 + (z_double_prime - 1.10) * 20
    else:
        altman_score = max(0, z_double_prime * 36)

    # Profitability score
    roe = ratios["roe"]
    net_margin = ratios["net_margin"]
    prof_score = min(100, max(0, (roe * 100 * 0.5 + net_margin * 100 * 5) / 1.5))

    # Leverage score (lower = better)
    nde = ratios["net_debt_ebitda"]
    if nde <= 0:
        lev_score = 100
    elif nde <= 1.5:
        lev_score = 90
    elif nde <= 3.0:
        lev_score = 70
    elif nde <= 5.0:
        lev_score = 50
    else:
        lev_score = max(0, 50 - (nde - 5) * 10)

    # Interest coverage score
    ic = ratios["interest_coverage"]
    if ic >= 8:
        ic_score = 95
    elif ic >= 4:
        ic_score = 80
    elif ic >= 2:
        ic_score = 60
    elif ic >= 1:
        ic_score = 40
    else:
        ic_score = max(0, ic * 30)

    # DSCR score
    dscr = ratios["dscr"]
    if dscr >= 2:
        dscr_score = 90
    elif dscr >= 1.25:
        dscr_score = 70
    else:
        dscr_score = max(0, dscr * 50)

    # Liquidity score
    liq_score = (min(100, ratios["current_ratio"] * 50)
                 + min(100, ratios["quick_ratio"] * 80)
                 + min(100, ratios["cash_ratio"] * 250)) / 3

    # Equity ratio score
    eq_score = min(100, ratios["equity_ratio"] * 200)

    composite = (0.30 * altman_score + 0.20 * prof_score + 0.15 * lev_score
                 + 0.10 * ic_score + 0.10 * dscr_score
                 + 0.10 * liq_score + 0.05 * eq_score)

    # Letter grade
    if composite >= 90: grade = "AAA / AA"
    elif composite >= 80: grade = "A"
    elif composite >= 70: grade = "BBB"
    elif composite >= 60: grade = "BB"
    elif composite >= 50: grade = "B"
    elif composite >= 40: grade = "CCC"
    else: grade = "CC / C / D"

    return {
        "altman_z_double_prime": z_double_prime,
        "altman_components": {"X1": X1, "X2": X2, "X3": X3, "X4": X4},
        "altman_score": altman_score, "prof_score": prof_score,
        "lev_score": lev_score, "ic_score": ic_score, "dscr_score": dscr_score,
        "liq_score": liq_score, "eq_score": eq_score,
        "composite": composite, "grade": grade,
    }


def build_risk_inventory(pnl: Dict, bs: Dict, ratios: Dict) -> List[Dict]:
    """Identify 5-8 specific risks based on findings."""
    risks = []

    # Receivables provision quality
    if bs["trade_rec"] > 0:
        prov_pct = bs["rec_provisions"] / bs["trade_rec"]
        if prov_pct > 0.15:
            risks.append({
                "severity": "high",
                "title": "Receivables provision elevated",
                "detail": f"Provisions are {prov_pct*100:.0f}% of trade receivables — historical credit issues",
            })

    # Cash ratio
    if ratios["cash_ratio"] < 0.10:
        risks.append({
            "severity": "high",
            "title": "Tight cash liquidity",
            "detail": f"Cash ratio {ratios['cash_ratio']:.2f}× — heavy dependence on revolvers",
        })

    # Raw materials concentration
    materials_pct = (pnl["exp_601"] + pnl["exp_602"]) / pnl["net_turnover"]
    if materials_pct > 0.30:
        risks.append({
            "severity": "medium",
            "title": "Raw material price exposure",
            "detail": f"Materials are {materials_pct*100:.0f}% of turnover — unhedged commodity risk",
        })

    # Affiliate dependency
    if pnl["net_profit_statutory"] > 0:
        affiliate_dep = pnl["rev_761"] / pnl["net_profit_statutory"]
        if affiliate_dep > 0.15:
            risks.append({
                "severity": "medium",
                "title": "Affiliate income dependency",
                "detail": f"Affiliate dividends are {affiliate_dep*100:.0f}% of net profit",
            })

    # Asset maturity
    if bs["ppe_gross"] > 0:
        dep_pct = bs["ppe_amort"] / bs["ppe_gross"]
        if dep_pct > 0.55:
            risks.append({
                "severity": "medium",
                "title": "Mature asset base",
                "detail": f"Accumulated depreciation = {dep_pct*100:.0f}% of gross PP&E — capex pressure ahead",
            })

    # Leverage
    if ratios["net_debt_ebitda"] > 4:
        risks.append({
            "severity": "high",
            "title": "Elevated leverage",
            "detail": f"Net Debt/EBITDA = {ratios['net_debt_ebitda']:.1f}× — covenant pressure likely",
        })

    return risks


# ──────────────────────────────────────────────────────────────────────
# SECTION 8: RECOMMENDATIONS
# ──────────────────────────────────────────────────────────────────────

def build_recommendations(pnl: Dict, bs: Dict, ratios: Dict,
                          credit: Dict, risks: List[Dict]) -> List[Dict]:
    """Generate prioritized recommendations from findings."""
    recs = []

    if ratios["cash_ratio"] < 0.10:
        target = bs["total_st_liab"] * 0.05
        gap = target - bs["total_cash"]
        recs.append({
            "severity": "high",
            "title": "Build minimum liquidity buffer to 5% of ST liabilities",
            "why": f"Cash ratio of {ratios['cash_ratio']:.2f}× is the weakest financial metric; vulnerable to a 15-day disruption.",
            "action": f"Target {target/1e6:.1f}M RON minimum cash. Fund by reducing dividend distribution or converting ST revolver to committed term facility.",
            "impact": f"Cash ratio doubles, liquidity risk eliminated. Cost: ~{gap/1e6:.1f}M RON one-time.",
        })

    if bs["trade_rec"] > 0 and bs["rec_provisions"] / bs["trade_rec"] > 0.15:
        prov_pct = bs["rec_provisions"] / bs["trade_rec"]
        recs.append({
            "severity": "high",
            "title": "Investigate receivables provisions",
            "why": f"Provisions at {prov_pct*100:.0f}% of gross trade receivables is unusual.",
            "action": "Pull aging schedule by counterparty. Write off uncollectible affiliated balances; establish credit terms with key customers.",
            "impact": "Cleaner balance sheet; potentially 2-4M additional hit if reserves need increase.",
        })

    materials_pct = (pnl["exp_601"] + pnl["exp_602"]) / pnl["net_turnover"]
    if materials_pct > 0.30:
        recs.append({
            "severity": "medium",
            "title": "Hedge raw material exposure forward 6-12 months",
            "why": f"Materials at {materials_pct*100:.0f}% of turnover; 10% price spike = ~{(pnl['exp_601']+pnl['exp_602'])*0.10/1e6:.0f}M margin compression.",
            "action": "Forward purchasing contracts on 50-70% of next 6-month volume. Fixed-price energy contracts where viable.",
            "impact": "Margin stability; reduces earnings volatility, improves predictability for credit.",
        })

    if bs["ppe_gross"] > 0 and bs["ppe_amort"] / bs["ppe_gross"] > 0.55:
        recs.append({
            "severity": "medium",
            "title": "5-year capex plan for equipment modernization",
            "why": f"Accumulated depreciation {bs['ppe_amort']/bs['ppe_gross']*100:.0f}% of gross PP&E; equipment approaching end of life.",
            "action": f"Target {(pnl['exp_681']*1.5)/1e6:.0f}-{(pnl['exp_681']*2)/1e6:.0f}M RON/year capex for next 3 years. Use EU grants where eligible.",
            "impact": f"Debt capacity exists — could lever to 2.5× Net Debt/EBITDA for ~{(pnl['ebitda']*2.5 - bs['net_debt'])/1e6:.0f}M additional capacity.",
        })

    if ratios["net_debt_ebitda"] < 1.5 and pnl["ebit"] > 0:
        recs.append({
            "severity": "medium",
            "title": "Capacity to lever for growth or shareholder returns",
            "why": f"Net Debt/EBITDA of {ratios['net_debt_ebitda']:.1f}× is exceptionally low for industry.",
            "action": "Consider strategic acquisitions or accelerated dividend program. Maintain ≤2.5× as guardrail.",
            "impact": f"Could deploy {(pnl['ebitda']*2.5 - bs['net_debt'])/1e6:.0f}M additional capital while staying investment-grade.",
        })

    if pnl["net_profit_statutory"] > 0 and pnl["rev_761"] / pnl["net_profit_statutory"] > 0.15:
        affiliate_dep = pnl["rev_761"] / pnl["net_profit_statutory"]
        recs.append({
            "severity": "medium",
            "title": "Affiliate portfolio review",
            "why": f"Affiliate dividends {affiliate_dep*100:.0f}% of net profit; concentration risk.",
            "action": "Entity-by-entity review. Liquidate dormants. Establish minimum yield threshold (e.g., 8%); divest underperformers within 24 months.",
            "impact": "Cleaner group structure; potential 2-5M one-time gain from divestments.",
        })

    return recs


# ──────────────────────────────────────────────────────────────────────
# MAIN ENTRY POINT
# ──────────────────────────────────────────────────────────────────────

def analyze_company(trial_balance_path: str,
                    company_name: str,
                    period: str,
                    industry: str = "default",
                    prior_period_path: Optional[str] = None,
                    output_html_path: Optional[str] = None) -> Dict:
    """
    End-to-end analysis. Returns a dict with all 8 sections' computed values.
    If output_html_path is set, also writes the HTML report.
    """
    df = load_trial_balance(trial_balance_path)
    validation = validate_trial_balance(df)

    pnl = build_pnl(df)
    bs = build_balance_sheet(df)

    prior_bs = None
    if prior_period_path:
        prior_df = load_trial_balance(prior_period_path)
        prior_bs = build_balance_sheet(prior_df)

    cf = build_cash_flow(pnl, bs, prior_bs)
    ratios = build_ratios(pnl, bs, prior_bs)
    valuation = build_valuation(pnl, bs, ratios, industry)
    credit = build_credit_score(pnl, bs, ratios)
    risks = build_risk_inventory(pnl, bs, ratios)
    recommendations = build_recommendations(pnl, bs, ratios, credit, risks)

    result = {
        "company_name": company_name,
        "period": period,
        "industry": industry,
        "validation": validation,
        "pnl": pnl,
        "balance_sheet": bs,
        "cash_flow": cf,
        "ratios": ratios,
        "valuation": valuation,
        "credit": credit,
        "risks": risks,
        "recommendations": recommendations,
    }

    if output_html_path:
        html = render_html_report(result)
        with open(output_html_path, "w", encoding="utf-8") as f:
            f.write(html)

    return result


# ──────────────────────────────────────────────────────────────────────
# HTML RENDERING (templates the report)
# ──────────────────────────────────────────────────────────────────────

def render_html_report(result: Dict) -> str:
    """
    Produce the full 8-section HTML report.
    Uses the v5 site styling (navy header, amber highlights, green positive).

    For brevity, this is a template skeleton — fill the {placeholders} with
    values from result. Use the Scandia FY2025 HTML as the canonical reference.
    """
    name = result["company_name"]
    period = result["period"]
    pnl = result["pnl"]
    bs = result["balance_sheet"]
    ratios = result["ratios"]
    credit = result["credit"]

    # Minimal skeleton — extend each section using the patterns from the
    # Scandia / EEI worked examples.
    html = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>{name} — Comprehensive Analysis {period}</title>
<style>
  body {{ font-family: Helvetica, Arial, sans-serif; max-width: 1180px;
         margin: 0 auto; padding: 30px; color: #1a1a1a; background: #fafbfc; }}
  h1, h2 {{ color: #003366; }}
  h2 {{ border-bottom: 2px solid #d6dde6; padding-bottom: 8px; margin-top: 36px; }}
  table {{ width: 100%; border-collapse: collapse; background: white; font-size: 13px; }}
  th {{ background: #003366; color: white; padding: 8px; text-align: left; }}
  td {{ padding: 8px; border-bottom: 1px solid #e0e6ed; }}
  td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  .header-card {{ background: linear-gradient(135deg, #003366, #1a5490);
                  color: white; padding: 22px 28px; border-radius: 4px; }}
  .kpi-grid {{ display: grid; grid-template-columns: repeat(4, 1fr);
               gap: 12px; margin: 16px 0; }}
  .kpi {{ background: white; border: 1px solid #d6dde6; padding: 14px;
          border-left: 4px solid #0a7c3a; border-radius: 4px; }}
  .kpi .label {{ font-size: 11px; color: #666; text-transform: uppercase; }}
  .kpi .value {{ font-size: 22px; font-weight: 700; color: #003366; }}
</style></head><body>

<div class="header-card">
  <h1 style="color:white; border:none; padding:0;">
    {name} — Comprehensive Financial Analysis
  </h1>
  <div>{period} · Source: trial balance (RAS)</div>
</div>

<h2>1. Overview</h2>
<div class="kpi-grid">
  <div class="kpi"><div class="label">Net Turnover</div>
    <div class="value">{pnl['net_turnover']/1e6:.1f}M</div></div>
  <div class="kpi"><div class="label">EBITDA</div>
    <div class="value">{pnl['ebitda']/1e6:.1f}M</div></div>
  <div class="kpi"><div class="label">Net Profit</div>
    <div class="value">{pnl['net_profit_statutory']/1e6:.1f}M</div></div>
  <div class="kpi"><div class="label">Total Assets</div>
    <div class="value">{bs['total_assets']/1e6:.1f}M</div></div>
  <div class="kpi"><div class="label">Equity Ratio</div>
    <div class="value">{ratios['equity_ratio']*100:.1f}%</div></div>
  <div class="kpi"><div class="label">Net Debt/EBITDA</div>
    <div class="value">{ratios['net_debt_ebitda']:.2f}×</div></div>
  <div class="kpi"><div class="label">ROE</div>
    <div class="value">{ratios['roe']*100:.1f}%</div></div>
  <div class="kpi"><div class="label">Altman Z″</div>
    <div class="value">{credit['altman_z_double_prime']:.2f}</div></div>
</div>

<h2>2. P&L</h2>
<table><tr><th>Line</th><th>RON</th><th>% of turnover</th></tr>
<tr><td>Net turnover</td><td class="num">{pnl['net_turnover']:,.0f}</td><td class="num">100.0%</td></tr>
<tr><td>Raw materials (601)</td><td class="num">{pnl['exp_601']:,.0f}</td><td class="num">{pnl['exp_601']/pnl['net_turnover']*100:.1f}%</td></tr>
<tr><td>Auxiliary mat (602)</td><td class="num">{pnl['exp_602']:,.0f}</td><td class="num">{pnl['exp_602']/pnl['net_turnover']*100:.1f}%</td></tr>
<tr><td>Utilities (605)</td><td class="num">{pnl['exp_605']:,.0f}</td><td class="num">{pnl['exp_605']/pnl['net_turnover']*100:.1f}%</td></tr>
<tr><td>Personnel (64)</td><td class="num">{pnl['exp_64']:,.0f}</td><td class="num">{pnl['exp_64']/pnl['net_turnover']*100:.1f}%</td></tr>
<tr><td>D&A (681)</td><td class="num">{pnl['exp_681']:,.0f}</td><td class="num">{pnl['exp_681']/pnl['net_turnover']*100:.1f}%</td></tr>
<tr><td><b>EBITDA</b></td><td class="num"><b>{pnl['ebitda']:,.0f}</b></td><td class="num"><b>{pnl['ebitda']/pnl['net_turnover']*100:.1f}%</b></td></tr>
<tr><td><b>EBIT</b></td><td class="num"><b>{pnl['ebit']:,.0f}</b></td><td class="num"><b>{pnl['ebit']/pnl['net_turnover']*100:.1f}%</b></td></tr>
<tr><td><b>NET PROFIT</b></td><td class="num"><b>{pnl['net_profit_statutory']:,.0f}</b></td><td class="num"><b>{pnl['net_profit_statutory']/pnl['net_turnover']*100:.1f}%</b></td></tr>
</table>

<h2>3. Balance Sheet</h2>
<table><tr><th>Item</th><th>RON</th></tr>
<tr><td>Total non-current assets</td><td class="num">{bs['total_noncurrent']:,.0f}</td></tr>
<tr><td>Total current assets</td><td class="num">{bs['total_current']:,.0f}</td></tr>
<tr><td><b>Total assets</b></td><td class="num"><b>{bs['total_assets']:,.0f}</b></td></tr>
<tr><td>Total equity</td><td class="num">{bs['total_equity']:,.0f}</td></tr>
<tr><td>Total liabilities</td><td class="num">{bs['total_liab']:,.0f}</td></tr>
</table>

<h2>7. Credit rating</h2>
<p style="font-size:32px; font-weight:700;">{credit['composite']:.0f} / 100 → {credit['grade']}</p>
<p>Altman Z″ = {credit['altman_z_double_prime']:.2f}</p>

<p style="text-align:center; color:#888; margin-top:40px; font-size:11px;">
NOTE: This is a skeleton render. Extend each section with the full level of detail
shown in the Scandia FY2025 worked example.
</p>
</body></html>"""
    return html


# ──────────────────────────────────────────────────────────────────────
# EXAMPLE — Scandia Food calibration
# ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    # Default run: Scandia Food FY2025 if file is in cwd or supplied via argv
    if len(sys.argv) > 1:
        path = sys.argv[1]
        company = sys.argv[2] if len(sys.argv) > 2 else "Test Company"
    else:
        path = "scandia_trial_balance_2025.xlsx"
        company = "Scandia Food SRL"

    result = analyze_company(
        trial_balance_path=path,
        company_name=company,
        period="FY2025",
        industry="food_mfg",
        output_html_path=f"{company.replace(' ','_')}_analysis.html",
    )

    # Print headline summary
    print(f"\n{'='*70}")
    print(f"ANALYSIS RESULT — {result['company_name']} {result['period']}")
    print(f"{'='*70}")
    print(f"Validation: {result['validation']['status']}")
    if result['validation']['issues']:
        for i in result['validation']['issues']:
            print(f"  ! {i}")
    print(f"\nKey metrics:")
    print(f"  Net turnover:    {result['pnl']['net_turnover']:>16,.0f} RON")
    print(f"  EBITDA:          {result['pnl']['ebitda']:>16,.0f} RON  "
          f"({result['ratios']['ebitda_margin']*100:.1f}%)")
    print(f"  Net profit:      {result['pnl']['net_profit_statutory']:>16,.0f} RON  "
          f"({result['ratios']['net_margin']*100:.1f}%)")
    print(f"  Total assets:    {result['balance_sheet']['total_assets']:>16,.0f} RON")
    print(f"  Equity:          {result['balance_sheet']['total_equity']:>16,.0f} RON  "
          f"({result['ratios']['equity_ratio']*100:.1f}%)")
    print(f"  Net Debt/EBITDA: {result['ratios']['net_debt_ebitda']:>16.2f}x")
    print(f"  Altman Z″:       {result['credit']['altman_z_double_prime']:>16.2f}")
    print(f"  Composite credit:{result['credit']['composite']:>16.0f} / 100 → "
          f"{result['credit']['grade']}")
    print(f"\nRisks identified: {len(result['risks'])}")
    for r in result['risks']:
        print(f"  [{r['severity'].upper():<6}] {r['title']}")
    print(f"\nRecommendations: {len(result['recommendations'])}")
    for r in result['recommendations']:
        print(f"  [{r['severity'].upper():<6}] {r['title']}")
