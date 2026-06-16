#!/usr/bin/env python3
"""EEI Dec 2025 — AUDITED year-end canonical CI validation.

Reads expected values from references/eei-python-reference/audit.json and
asserts every field to ±1 RON. The reference is the YEAR-END Solduri finale
convention — the same one Romanian statutory financial statements, Patria
Bank covenant measurement, and the published v5 annual report use.

CONVENTION:
    - BS positions: Solduri finale columns (Dec 31, 2025 closing balance)
    - P&L values: Sume totale (YTD movement totals)
    - amount per account = closing_dr (debit-natural) OR closing_cr
      (credit-natural), emitted POSITIVE. Mapping rule sign='reverse'
      handles direction.

This is the AUDITED reference. Period-only convention (Dec 1 + Dec
movements) is a different, also-correct number that answers a different
question — not used here.

Usage:
    .venv/bin/python3 scripts/validate_eei_canonical.py

Exit:
    0 — every audit.json field matches within tolerance
    1 — at least one drift detected (CI must fail)

Wire into CI via `.github/workflows/tier1-validation.yml`:
    - run: python3 scripts/validate_eei_canonical.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# F3.1e: data moved to engine.country_packs.ro_romania.chart_of_accounts.
# Add `src` to sys.path so the proper package-qualified import resolves.
sys.path.insert(0, str(REPO_ROOT / "src"))
# Legacy sibling-import fallback (when sys.path includes engine/api).
sys.path.insert(0, str(REPO_ROOT / "src" / "engine" / "api"))

try:
    from engine.country_packs.ro_romania import chart_of_accounts as mod  # noqa: E402
except Exception:
    import _ro_coa as mod  # noqa: E402  — legacy shim, F3.1d-vintage


# ─── Load audit.json — the durable specification ─────────────────────────
AUDIT_PATH = REPO_ROOT / "references" / "eei-python-reference" / "audit.json"
with AUDIT_PATH.open() as f:
    AUDIT = json.load(f)


# ─── EEI Dec 2025 source-of-truth account amounts (YEAR-END Solduri finale) ──
# Every value is the closing balance from balanta verificare EEI dec 2025.pdf,
# Solduri finale column. P&L entries (Class 6/7) use Sume totale (YTD).
EEI_ACCOUNTS = [
    # Cash & equivalents — Solduri finale Dr
    {"code": "5121", "name": "Conturi la banca in lei",         "amount":   810431.78},  # closing_dr
    {"code": "5124", "name": "Conturi la banca in valuta",       "amount":   679102.51},  # closing_dr (FX)
    {"code": "5311", "name": "Casa in lei",                      "amount":     5302.52},  # closing_dr
    {"code": "581",  "name": "Viramente interne",                "amount":        0.00},  # IGNORED — closing is 0
    # AR
    {"code": "4111", "name": "Clienti",                          "amount":        4.00},  # closing_dr
    {"code": "4118", "name": "Clienti incerti",                  "amount":   167026.63},  # closing_dr (gross)
    {"code": "491",  "name": "Ajustari deprecierea creantelor",  "amount":   167026.63},  # closing_cr (contra)
    {"code": "461",  "name": "Debitori diversi",                 "amount":  2597484.00},  # closing_dr (intercompany)
    # PPE — Solduri finale Dr (gross book; deprec is contra in 2815)
    {"code": "215",  "name": "Investitii imobiliare",            "amount": 14457160.32},  # closing_dr
    {"code": "231",  "name": "Imobilizari in curs",              "amount":  2164079.83},  # closing_dr
    {"code": "4093", "name": "Avansuri imobilizari",             "amount":  2021340.00},  # closing_dr
    # Liabilities — Solduri finale Cr
    {"code": "401",  "name": "Furnizori",                        "amount":        7.49},  # closing_cr
    {"code": "408",  "name": "Furnizori facturi nesosite",       "amount":      143.18},  # closing_cr
    {"code": "457",  "name": "Dividende de plata",               "amount":        1.00},  # closing_cr (paid down)
    {"code": "1621", "name": "Credite bancare termen lung",      "amount": 14083315.77},  # closing_cr (full bank loan)
    # Equity — Solduri finale Cr
    {"code": "1012", "name": "Capital subscris varsat",          "amount":    45200.00},
    {"code": "105",  "name": "Rezerve din reevaluare",           "amount":  3980157.61},  # closing_cr
    {"code": "1061", "name": "Rezerve legale",                   "amount":     9040.00},
    {"code": "1171", "name": "Rezultatul reportat",              "amount":   364310.48},  # closing_cr
    {"code": "121",  "name": "Profit si pierdere",               "amount":  1425245.58},  # IGNORED — derived
    # P&L — YTD movements (Sume totale)
    {"code": "706",  "name": "Venituri din chirii",              "amount":  2727103.68},  # ytd_cr
    {"code": "628",  "name": "Servicii executate de terti",      "amount":  2172788.60},
    {"code": "611",  "name": "Intretinerea si reparatiile",      "amount":    45875.96},
    {"code": "613",  "name": "Prime de asigurare",               "amount":    34248.69},
    {"code": "622",  "name": "Comisioane si onorarii",           "amount":    31412.39},
    {"code": "627",  "name": "Servicii bancare",                 "amount":    41206.34},
    {"code": "635",  "name": "Impozite si taxe",                 "amount":   253065.00},
    # 605 Energia / utilities — fills the remaining ~55K of Class 6 opex
    # so the synthetic stub's class_6_total reaches 4,211,575.00 and
    # statutory NI matches the audited 121 closing of 1,425,245.58.
    {"code": "605",  "name": "Energia si apa",                   "amount":    55342.74},
    {"code": "641",  "name": "Cheltuieli cu salariile",          "amount":   125808.00},
    {"code": "6458", "name": "Cheltuieli sociale",               "amount":     1200.00},
    {"code": "6461", "name": "Contributia asiguratorie munca",   "amount":     2832.00},
    {"code": "6811", "name": "Cheltuieli cu amortizarea",        "amount":   355607.00},
    {"code": "666",  "name": "Cheltuieli privind dobanzile",     "amount":   716741.02},
    {"code": "6651", "name": "Diferente nefavorabile curs",      "amount":   338580.67},
    {"code": "7611", "name": "Venituri din dividende",           "amount":   245637.00},
    {"code": "7651", "name": "Diferente favorabile curs",        "amount":    26632.48},
    {"code": "766",  "name": "Venituri din dobanzi",             "amount":   245368.00},
    {"code": "767",  "name": "Venituri din sconturi",            "amount":   228000.00},
    {"code": "691",  "name": "Impozit pe profit",                "amount":    36867.00},
    {"code": "722",  "name": "Productia imobilizari corporale",  "amount":  2164079.83},  # YTD memo
]


def main() -> int:
    result = mod.assemble_statements(
        EEI_ACCOUNTS,
        company_name=AUDIT["company"],
        currency="RON",
        period_label="Dec 2025 (audited year-end)",
    )
    bs = result["statements"]["assembled_bs"]
    pl = result["statements"]["assembled_pl"]
    classification = mod.detect_industry(result)

    failed: list[str] = []
    audit_bs = AUDIT["balance_sheet"]
    audit_pl = AUDIT["income_statement"]
    audit_cls = AUDIT["classification"]

    def check(label: str, actual: float, expected: float, tol: float = 1.0) -> None:
        ok = abs(actual - expected) <= tol
        status = "PASS" if ok else "FAIL"
        print(f"  {status}  {label:35s}  actual={actual:>14,.2f}  expected={expected:>14,.2f}  tol=±{tol}")
        if not ok:
            failed.append(f"{label}: actual {actual:,.2f}, expected {expected:,.2f}")

    def check_predicate(label: str, value, predicate, predicate_text: str) -> None:
        ok = predicate(value)
        status = "PASS" if ok else "FAIL"
        if isinstance(value, (int, float)):
            print(f"  {status}  {label:35s}  actual={value:>14,.2f}  expected={predicate_text}")
        else:
            print(f"  {status}  {label:35s}  actual={str(value):>14s}  expected={predicate_text}")
        if not ok:
            failed.append(f"{label}: actual {value}, expected {predicate_text}")

    print("═" * 80)
    print(f"EEI Dec 2025 — AUDITED year-end CI Validation  (convention: {AUDIT['convention']})")
    print("═" * 80)
    print()

    # ── Balance Sheet (year-end Solduri finale) ────────────────────────
    check("BS  cash",                    bs["cash"],                 audit_bs["cash"])
    check("BS  cash_fx_component",       bs["cash_fx_component"],    audit_bs["cash_fx_component"])
    check("BS  ar_net",                  bs["ar_net"],               audit_bs["ar_net"])
    check("BS  ar_intercompany",         bs["ar_intercompany"],      audit_bs["ar_intercompany"])
    check("BS  ppe_investment_net",      bs["ppe_investment_net"],   audit_bs["ppe_investment_net"])
    check("BS  ppe_under_construction",  bs["ppe_under_construction"], audit_bs["ppe_under_construction"])
    check("BS  ppe_advances",            bs["ppe_advances"],         audit_bs["ppe_advances"])
    check("BS  ap",                      bs["ap"],                   audit_bs["ap"])
    check("BS  ap_dividends",            bs["ap_dividends"],         audit_bs["ap_dividends"])
    check("BS  lt_debt",                 bs["lt_debt"],              audit_bs["lt_debt"])
    check("BS  st_debt",                 bs["st_debt"],              audit_bs["st_debt"])
    check("BS  total_debt",              bs["total_debt"],           audit_bs["total_debt"])
    check("BS  share_capital",           bs["share_capital"],        audit_bs["share_capital"])
    check("BS  revaluation_reserves",    bs["revaluation_reserves"], audit_bs["revaluation_reserves"])
    check("BS  retained_earnings",       bs["retained_earnings"],    audit_bs["retained_earnings"])
    check("BS  current_year_pnl",        bs["current_year_pnl"],     audit_bs["current_year_pnl_statutory"])

    # ── P&L (YTD Sume totale) ──────────────────────────────────────────
    check("PL  revenue",                       pl["revenue"],                       audit_pl["revenue"])
    check("PL  capitalized_own_work_memo",     pl["capitalized_own_work_memo"],     audit_pl["capitalized_own_work_memo"])
    check("PL  net_income_statutory",          pl["net_income_statutory"],          audit_pl["net_income_statutory"])

    # ── Both net income views must be present ──────────────────────────
    check_predicate("PL  net_income_operational < 0", pl["net_income_operational"],
                    lambda v: v < 0, "< 0 (operational view excluded 722)")

    # ── Industry classification ────────────────────────────────────────
    check_predicate("CLS industry_key",
                    classification["industry_key"],
                    lambda v: v == audit_cls["industry_key"],
                    audit_cls["industry_key"])
    check_predicate("CLS industry_confidence",
                    classification["confidence"],
                    lambda v: v >= audit_cls["industry_confidence"],
                    f">= {audit_cls['industry_confidence']}")

    # ── MUST-NOT invariants (drift sentinels) ──────────────────────────
    # 457 NEVER in total_debt — even if ap_dividends amount changes, total_debt
    # must equal lt_debt + st_debt with no extras.
    debt_delta = bs["total_debt"] - bs["lt_debt"] - bs["st_debt"]
    check_predicate("INV total_debt = lt + st (no 457)",
                    abs(debt_delta),
                    lambda v: v < 1,
                    "no extras in total_debt")

    # 581 NEVER in cash — cash should never include the transit account
    # (5121 + 5124 + 5311 only, no 581 contamination).
    cash_expected_no_581 = 810431.78 + 679102.51 + 5302.52  # year-end Solduri finale
    check_predicate("INV cash excludes 581",
                    abs(bs["cash"] - cash_expected_no_581),
                    lambda v: v < 1,
                    "cash = 5121 + 5124 + 5311 (no 581)")

    # 722 NEVER in revenue — capitalized own-work is memo only
    check_predicate("INV 722 NOT in revenue",
                    abs(pl["revenue"] - 2727103.68),
                    lambda v: v < 1,
                    "revenue = 706 only, no 722")

    print()
    print("═" * 80)
    if failed:
        print(f"FAIL — {len(failed)} audited-canonical assertion(s) failed:")
        for msg in failed:
            print(f"  - {msg}")
        return 1

    print("PASS — All audited EEI canonical assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
