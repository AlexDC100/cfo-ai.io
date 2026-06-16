"""F3.13 — line-by-line comparison of engine vs toolkit oracle for all 6 RO fixtures.

For each fixture, prints:
  - Engine fresh totals (assets / equity / liab / drift / cash / ppe)
  - Oracle target totals (from toolkit HTML reports — hardcoded below)
  - Per-bucket variance, identifying which lines diverge
  - Account-level inventory of high-value codes ROUTING to the divergent
    bucket vs. expected oracle bucket

Pure read-only diagnostic — no data modified. Read by Claude to identify
specific MappingRule additions needed before any engine source edit.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "scripts"))

from engine.country_packs.ro_romania import trial_balance_parser as tbp
from engine.country_packs.ro_romania import chart_of_accounts as coa


# Oracle numbers from toolkit HTML reports (operator-attached, F3.12 archive)
ORACLE = {
    "agras_tb_2025.xlsx": {
        "name": "Agras Food Factory FY2025",
        "net_turnover": 118_576_820,
        "ebitda": 18_420_491,
        "net_profit": 7_533_676,
        "total_assets": 38_301_692,
        "total_equity": 23_924_084,
        "total_debt": 3_640_203,    # 552K + 887K LT + 2.2M ST bank
        "cash": 1_168_047,
        "ppe_net": 11_005_677,
        "inventory": 8_933_332,
        "ar_net": 8_513_385,        # 8.57M - 60K provisions
        "ap_trade": 6_684_077,      # 401+403+404+405+408
        "bs_gap_pct": 2.12,
    },
    "carniprod_tb_2025.xlsx": {
        "name": "Carniprod FY2025",
        "net_turnover": 99_424_740,
        "ebitda": 9_588_745,
        "net_profit": 1_435_534,
        "total_assets": 125_851_944,
        "total_equity": 106_895_968,
        "total_debt": 0,
        "cash": 10_124_869,
        "ppe_net": 90_687_779,
        "inventory": 9_796_027,
        "ar_net": 10_829_721,       # 12.18M gross - 1.35M provisions
        "ap_trade": 13_002_678,
        "bs_gap_pct": 0.14,
    },
    "scandia_frozen_tb_2025.xlsx": {
        "name": "Scandia Frozen FY2025",
        "net_turnover": 48_349_082,
        "ebitda": 5_256_298,
        "net_profit": 402_869,
        "total_assets": 52_732_279,
        "total_equity": 8_005_866,
        "total_debt": 33_193_874,   # 15.8M LT + 207K leasing + 17.0M ST
        "cash": 1_255_039,
        "ppe_net": 25_369_030,
        "inventory": 12_315_519,
        "ar_net": 11_853_561,       # 12.66M - 810K provisions
        "ap_trade": 8_572_339,
        "bs_gap_pct": 0.53,
    },
    "scandia_realestate_tb_2025.xlsx": {
        "name": "Scandia RealEstate FY2025",
        "net_turnover": 162_366,    # rental only (706001 + 704002)
        "ebitda": -2_221_779,       # economic (excl. capitalized)
        "net_profit": -801_604,     # loss; account 121 D-balance
        "total_assets": 83_422_423,
        "total_equity": 40_285_270,
        "total_debt": 14_754_212,   # bank LT + leasing
        "cash": 1_184_400,
        "ppe_net": 1_452_000,
        "inventory": 67_821_214,    # 331 CIP + 371901 — toolkit calls these inventory
        "ar_net": 150_000,
        "ap_trade": 2_658_327,      # 401 + 404
        "bs_gap_pct": 4.5,          # toolkit shows D=C=90.55M balanced; FE shows ~4% on subtotals
    },
    "scandia_retail_tb_2025.xlsx": {
        "name": "Scandia Retail FY2025",
        "net_turnover": 79_510_265,
        "ebitda": -182_858,
        "net_profit": 3_205_213,
        "total_assets": 68_766_045,
        "total_equity": 25_224_177,
        "total_debt": 27_859_010,
        "cash": 1_138_012,
        "ppe_net": 2_446_375,
        "inventory": 6_795_206,
        "ar_net": 203_159,          # 1.43M - 1.22M provisions
        "ap_trade": 6_456_780,
        "bs_gap_pct": 1.92,
    },
    "scandia_sibiu_tb_2019.pdf": {
        "name": "Scandia Sibiu FY2019",
        "net_turnover": 8_121_590,
        "ebitda": 729_677,
        "net_profit": 650_887,
        "total_assets": 1_203_418,
        "total_equity": 110_532,
        "total_debt": 0,
        "cash": 324_423,
        "ppe_net": 148_074,
        "inventory": 32_053,
        "ar_net": 185_273,
        "ap_trade": 793_921,
        "bs_gap_pct": 2.62,
    },
}


def _pct(a, b):
    if b == 0:
        return float("inf")
    return abs(a - b) / abs(b) * 100


def _verdict(engine, oracle, tol_pct=0.5):
    if oracle == 0:
        if abs(engine) < 1000:
            return "OK"
        return "DIFF"
    pct = _pct(engine, oracle)
    if pct < tol_pct:
        return "OK"
    if pct < 5:
        return "MINOR %.2f%%" % pct
    return "BIG %.1f%%" % pct


def diagnose(filename):
    path = REPO / "files" / filename
    if not path.is_file():
        print("MISSING: %s" % filename)
        return
    oracle = ORACLE.get(filename, {})
    name = oracle.get("name", filename)
    print("=" * 90)
    print("=== %s ===" % name)
    print("=" * 90)

    # Parse + assemble
    file_bytes = path.read_bytes()
    if filename.lower().endswith(".pdf"):
        from engine.country_packs.ro_romania import pdf_ingester
        rows = pdf_ingester.parse_pdf_trial_balance(file_bytes, filename=filename)
    else:
        rows = tbp.parse_trial_balance_file(file_bytes, filename)
    sq = tbp.compute_source_imbalance(rows)
    shaped = tbp.accounts_to_assemble_shape(rows)
    result = coa.assemble_statements(shaped, company_name=name, currency="RON", period_label="FY",
                                     source_data_quality=sq)
    bs = result["statements"].get("assembled_bs") or {}
    pl = result["statements"].get("assembled_pl") or {}

    eng_assets = bs.get("total_assets", 0)
    eng_equity = bs.get("total_equity", 0)
    eng_liab = bs.get("total_liabilities", 0)
    eng_debt = bs.get("total_debt", 0)
    eng_cash = bs.get("cash", 0)
    eng_ppe = bs.get("ppe_net", 0)
    eng_inv = bs.get("inventory", 0)
    eng_ar = bs.get("ar_net", 0)
    eng_ap = bs.get("ap_trade", 0)
    eng_drift_pct = abs(bs.get("bs_balance_delta", 0)) / max(eng_assets, 1) * 100
    eng_turnover = pl.get("net_turnover", 0) or pl.get("total_operating_revenue", 0)
    eng_ebitda = pl.get("operating_ebitda", 0)
    eng_netprofit = pl.get("net_income_statutory", 0)

    print("source imbalance:   pct=%.4f%% abs=%.0f warn=%s" % (
        sq.get("raw_imbalance_pct", 0), sq.get("raw_imbalance_abs", 0), sq.get("warn")))
    print("rows parsed:        %d  shaped accounts: %d  unmapped: %d  semantic: %d" % (
        len(rows), len(shaped), len(result.get("unmapped") or []), result.get("semantic_fallbacks_used", 0)))
    print()
    print("%-20s | %16s | %16s | %s" % ("Field", "Engine", "Oracle", "Verdict"))
    print("-" * 80)
    for label, eng, orc in [
        ("net_turnover", eng_turnover, oracle.get("net_turnover", 0)),
        ("ebitda", eng_ebitda, oracle.get("ebitda", 0)),
        ("net_profit", eng_netprofit, oracle.get("net_profit", 0)),
        ("total_assets", eng_assets, oracle.get("total_assets", 0)),
        ("total_equity", eng_equity, oracle.get("total_equity", 0)),
        ("total_liabilities", eng_liab, 0),
        ("total_debt", eng_debt, oracle.get("total_debt", 0)),
        ("cash", eng_cash, oracle.get("cash", 0)),
        ("ppe_net", eng_ppe, oracle.get("ppe_net", 0)),
        ("inventory", eng_inv, oracle.get("inventory", 0)),
        ("ar_net", eng_ar, oracle.get("ar_net", 0)),
        ("ap_trade", eng_ap, oracle.get("ap_trade", 0)),
    ]:
        print("%-20s | %16.2f | %16.2f | %s" % (label, eng, orc, _verdict(eng, orc)))
    print()
    print("engine drift %%: %.4f%% (oracle reports its own BS gap %.2f%%)" % (eng_drift_pct, oracle.get("bs_gap_pct", 0)))
    print()


if __name__ == "__main__":
    for fn in ORACLE:
        diagnose(fn)
