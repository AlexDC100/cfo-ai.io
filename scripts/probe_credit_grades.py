"""
F1.h probe — capture composite credit score + letter grade for EEI + Scandia.

Replicates the credit-score logic in pipeline.py:stage_compute against the
output of _ro_coa.assemble_statements(). Reports both OLD-band and NEW-band
letter grades so the F1.h re-banding deploy can be verified before/after.

Run inside the cfo-ai-backend container:
    docker exec cfo-ai-backend python3 /app/scripts/probe_credit_grades.py

Re-uses the loaders from measure_bs_drift.py so we hit the EXACT same code
path the F-A3.1 acceptance gate runs.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Use the same path/loader setup as measure_bs_drift.py.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import measure_bs_drift as mbd  # noqa: E402

ro_coa = mbd._load_ro_coa()


def grade_old(composite: float) -> str:
    if composite >= 90: return "AAA"
    if composite >= 80: return "A"
    if composite >= 70: return "BBB"
    if composite >= 60: return "BB"
    if composite >= 50: return "B"
    if composite >= 40: return "CCC"
    return "CC"


def grade_new(composite: float) -> str:
    # Spec §10 — locked re-banding with AA notch.
    if composite >= 90: return "AAA"
    if composite >= 80: return "AA"
    if composite >= 70: return "A"
    if composite >= 60: return "BBB"
    if composite >= 50: return "BB"
    if composite >= 40: return "B"
    if composite >= 25: return "CCC"
    return "CC"


def compute_credit(statements):
    bs = statements["balanceSheet"]
    pl = statements["incomeStatement"]

    revenue = pl["revenue"]
    cogs = pl["costOfGoodsSold"]
    opex = pl["operatingExpenses"]
    depreciation = pl["depreciationAmortization"]
    interest = pl["interestExpense"]
    other_inc = pl["otherIncome"]
    fin_inc = pl["financialIncome"]
    fin_exp = pl["financialExpense"]
    tax = pl["taxExpense"]

    gross_profit = revenue - cogs
    operating_profit = gross_profit - opex - depreciation + other_inc
    ebitda = operating_profit + depreciation
    pretax = operating_profit + fin_inc - fin_exp - interest
    net_income = pretax - tax

    current_assets = bs["cash"] + bs["accountsReceivable"] + bs["inventory"] + bs["otherCurrentAssets"]
    non_current_assets = bs["propertyPlantEquipment"] + bs["intangibles"] + bs["otherNonCurrentAssets"]
    total_assets = current_assets + non_current_assets
    current_liab = bs["accountsPayable"] + bs["shortTermDebt"] + bs["otherCurrentLiabilities"]
    non_current_liab = bs["longTermDebt"] + bs["otherNonCurrentLiabilities"]
    total_debt = bs["shortTermDebt"] + bs["longTermDebt"]
    total_equity = bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]

    if total_assets <= 0:
        return None

    x1 = (current_assets - current_liab) / total_assets
    x2 = bs["retainedEarnings"] / total_assets
    x3 = operating_profit / total_assets
    total_liab_safe = max(current_liab + non_current_liab, 1)
    x4 = total_equity / total_liab_safe
    altman_z = 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4

    if altman_z >= 2.60:
        altman_sub = min(100, 70 + (altman_z - 2.60) * 15)
    elif altman_z >= 1.10:
        altman_sub = 40 + (altman_z - 1.10) * 20
    else:
        altman_sub = max(0, altman_z * 36)

    roe_val = net_income / total_equity if total_equity > 0 else 0
    nm = net_income / revenue if revenue > 0 else 0
    prof_sub = min(100, max(0, (roe_val * 100 * 0.5 + nm * 100 * 5) / 1.5))

    net_debt = total_debt - bs["cash"]
    nde = net_debt / ebitda if ebitda > 0 else 999
    if nde <= 0:
        lev_sub = 100
    elif nde <= 1.5:
        lev_sub = 90
    elif nde <= 3.0:
        lev_sub = 70
    elif nde <= 5.0:
        lev_sub = 50
    else:
        lev_sub = max(0, 50 - (nde - 5) * 10)

    ic = (operating_profit / interest) if interest > 0 else 999
    if ic >= 8:
        ic_sub = 95
    elif ic >= 4:
        ic_sub = 80
    elif ic >= 2:
        ic_sub = 60
    elif ic >= 1:
        ic_sub = 40
    else:
        ic_sub = max(0, ic * 30)

    dscr = (ebitda / (interest + bs["longTermDebt"] / 8)) if interest > 0 else 999
    if dscr >= 2:
        dscr_sub = 90
    elif dscr >= 1.25:
        dscr_sub = 70
    else:
        dscr_sub = max(0, dscr * 50)

    cur_ratio = current_assets / current_liab if current_liab > 0 else 0
    quick_ratio = (current_assets - bs["inventory"]) / current_liab if current_liab > 0 else 0
    cash_ratio = bs["cash"] / current_liab if current_liab > 0 else 0
    liq_sub = (min(100, cur_ratio * 50) + min(100, quick_ratio * 80) + min(100, cash_ratio * 250)) / 3

    eq_sub = min(100, (total_equity / total_assets) * 200) if total_assets > 0 else 0

    composite = (
        0.30 * altman_sub
        + 0.20 * prof_sub
        + 0.15 * lev_sub
        + 0.10 * ic_sub
        + 0.10 * dscr_sub
        + 0.10 * liq_sub
        + 0.05 * eq_sub
    )

    return {
        "altman_z": altman_z,
        "composite": composite,
        "altman_sub": altman_sub,
        "prof_sub": prof_sub,
        "lev_sub": lev_sub,
        "ic_sub": ic_sub,
        "dscr_sub": dscr_sub,
        "liq_sub": liq_sub,
        "eq_sub": eq_sub,
        "total_assets": total_assets,
        "ebitda": ebitda,
        "net_income": net_income,
        "grade_old": grade_old(composite),
        "grade_new": grade_new(composite),
    }


def report(label, accounts):
    if not accounts:
        print(f"=== {label} === NO ACCOUNTS")
        return
    result = ro_coa.assemble_statements(accounts)
    creds = compute_credit(result["statements"])
    if creds is None:
        print(f"=== {label} === total_assets <= 0; skipping")
        return
    print(f"=== {label} ===")
    print(f"  total_assets     {creds['total_assets']:>16,.2f}")
    print(f"  EBITDA           {creds['ebitda']:>16,.2f}")
    print(f"  net_income       {creds['net_income']:>16,.2f}")
    print(f"  Altman Z\"        {creds['altman_z']:>16.2f}")
    print(f"  composite        {creds['composite']:>16.1f}  / 100")
    print(f"    altman          {creds['altman_sub']:>15.1f}")
    print(f"    profitability   {creds['prof_sub']:>15.1f}")
    print(f"    leverage        {creds['lev_sub']:>15.1f}")
    print(f"    int. coverage   {creds['ic_sub']:>15.1f}")
    print(f"    DSCR            {creds['dscr_sub']:>15.1f}")
    print(f"    liquidity       {creds['liq_sub']:>15.1f}")
    print(f"    equity ratio    {creds['eq_sub']:>15.1f}")
    print(f"  OLD-band grade   {creds['grade_old']:>16}")
    print(f"  NEW-band grade   {creds['grade_new']:>16}")
    print()


if __name__ == "__main__":
    print("Loading EEI fixture...")
    eei_accts, eei_name = mbd.load_eei()
    eei_normalized = mbd._normalize_for_assembler(eei_accts, ro_coa)
    report(eei_name, eei_normalized)

    print("Loading Scandia fixture...")
    scandia_accts, scandia_name = mbd.load_scandia()
    report(scandia_name, scandia_accts)
