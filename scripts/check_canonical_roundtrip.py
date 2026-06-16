"""F4.1-ROUNDTRIP gate — verifies that canonical aggregate totals
reconcile to legacy `assembled_bs.total_assets / total_equity /
total_liabilities` within tolerance.

Per F4.1b-cont calibration: all 6 RO fixtures hit 0.00% exact match
across all 3 metrics post-fix. This gate locks that in — any future
adapter change or schema change that breaks the canonical-vs-legacy
round-trip will trip the gate before deploy.

Tolerance: 0.5% per metric per fixture (matches the operator's <0.5%
target for production BS reconciliation). Independent of source-data
quality — canonical-vs-legacy is an INTERNAL consistency check.

Exit 0 if all pass, 1 if any fail.

Run from container:
    docker exec cfo-ai-backend python3 /app/scripts/check_canonical_roundtrip.py
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Dict, List


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for c in [here, *here.parents][:6]:
        if (c / "pyproject.toml").is_file():
            return c
    return here.parent


REPO = _find_repo_root()
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "scripts"))


TOLERANCE_PCT = 0.5


# Aggregates that compose each side. Wide-grained per CANONICAL_SCHEMA_V1
# §3a; new aggregates added in future schema versions go here.
BS_ASSET_AGGREGATES: List[str] = [
    "cash_and_equivalents", "trade_receivables_net", "other_receivables",
    "inventory_net", "prepaid_expenses_and_other",
    "ppe_net", "investment_property", "right_of_use_assets",
    "intangibles_net", "financial_investments",
    "deferred_tax_assets", "other_non_current_assets",
]
BS_EQUITY_AGGREGATES: List[str] = [
    "contributed_capital", "reserves", "retained_earnings",
    "treasury_shares", "accumulated_oci", "non_controlling_interest",
    "convertible_debt_equity_component",
]
BS_LIABILITY_AGGREGATES: List[str] = [
    "trade_payables", "tax_payables", "personnel_payables", "other_payables_st",
    "financial_liabilities_st", "deferred_revenue_st", "provisions_st",
    "financial_liabilities_lt", "deferred_tax_liabilities",
    "provisions_lt", "pension_liabilities", "deferred_income_lt",
    "other_non_current_liabilities",
]


def _sum_aggregates(canonical: dict, agg_names: List[str]) -> float:
    return sum(
        canonical.get("aggregates", {}).get(name, {}).get("net", 0.0) or 0.0
        for name in agg_names
    )


def _pct_diff(legacy: float, canonical: float) -> float:
    if abs(legacy) < 1.0:
        return 0.0 if abs(canonical) < 1.0 else float("inf")
    return abs(legacy - canonical) / abs(legacy) * 100


def _check_fixture(name: str, assembled: dict) -> Dict[str, object]:
    statements = assembled.get("statements") or {}
    legacy_bs = statements.get("assembled_bs") or {}
    canonical = assembled.get("assembled_canonical_v1")
    if not isinstance(canonical, dict):
        return {"ok": False, "reason": "MISSING assembled_canonical_v1"}

    legacy_assets = float(legacy_bs.get("total_assets", 0) or 0)
    legacy_equity = float(legacy_bs.get("total_equity", 0) or 0)
    legacy_liab   = float(legacy_bs.get("total_liabilities", 0) or 0)

    canon_assets = _sum_aggregates(canonical, BS_ASSET_AGGREGATES)
    canon_equity = _sum_aggregates(canonical, BS_EQUITY_AGGREGATES)
    canon_liab   = _sum_aggregates(canonical, BS_LIABILITY_AGGREGATES)

    da = _pct_diff(legacy_assets, canon_assets)
    de = _pct_diff(legacy_equity, canon_equity)
    dl = _pct_diff(legacy_liab,   canon_liab)

    worst = max(da, de, dl)
    return {
        "ok": worst <= TOLERANCE_PCT,
        "Δassets_pct": da, "Δequity_pct": de, "Δliab_pct": dl,
        "legacy_assets": legacy_assets, "canon_assets": canon_assets,
        "legacy_equity": legacy_equity, "canon_equity": canon_equity,
        "legacy_liab":   legacy_liab,   "canon_liab":   canon_liab,
        "worst_pct": worst,
    }


def main() -> int:
    from measure_bs_drift import (
        _load_ro_coa, _normalize_for_assembler,
        load_eei, load_scandia, load_sibiu,
        load_frozen, load_realestate,
        load_agras, load_carniprod, load_retail,
    )
    ro_coa = _load_ro_coa()
    fn = ro_coa.assemble_statements

    fixtures: list = []
    try:
        accts, name, _ = load_eei()
        normalized = _normalize_for_assembler(accts, ro_coa)
        fixtures.append(("EEI", normalized, name))
    except Exception as e:
        print(f"FAIL EEI load: {e}")
        return 1
    for short, loader in [
        ("Scandia", load_scandia), ("Sibiu", load_sibiu),
        ("Frozen", load_frozen), ("RealEstate", load_realestate),
        ("Agras", load_agras), ("Carniprod", load_carniprod),
        ("Retail", load_retail),
    ]:
        try:
            accts, name, _ = loader()
            fixtures.append((short, accts, name))
        except Exception as e:
            print(f"FAIL {short} load: {e}")
            return 1

    all_pass = True
    print("F4.1-ROUNDTRIP — canonical aggregates vs legacy assembled_bs (tolerance <= %.2f%%)" % TOLERANCE_PCT)
    print("=" * 100)
    print(f"  {'fixture':<11s} {'Δassets':>8s} {'Δequity':>8s} {'Δliab':>8s}  worst    verdict")
    print("-" * 100)
    for short, accts, name in fixtures:
        try:
            result = fn(accts, company_name=name, currency="RON", period_label="FY2025")
            r = _check_fixture(short, result)
            if "reason" in r:
                print(f"  {short:<11s}  RED — {r['reason']}")
                all_pass = False
                continue
            verdict = "GREEN" if r["ok"] else "RED"
            if not r["ok"]:
                all_pass = False
            print(f"  {short:<11s} {r['Δassets_pct']:>7.3f}% {r['Δequity_pct']:>7.3f}% {r['Δliab_pct']:>7.3f}% {r['worst_pct']:>7.3f}%  {verdict}")
        except Exception as e:
            print(f"  {short:<11s}  RED — exception {type(e).__name__}: {e}")
            all_pass = False
    print()
    print("Overall: " + ("GREEN — F4.1-ROUNDTRIP passes on all RO fixtures."
                          if all_pass else
                          "RED — F4.1-ROUNDTRIP fails. Do not deploy."))
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
