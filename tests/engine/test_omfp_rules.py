"""OMFP 1802 rule unit tests on SYNTHETIC minimal account lists (Phase-5
item 4).

Each test builds a tiny 10-column trial balance in memory and runs the
REAL production path — `accounts_to_assemble_shape` (parser signing +
side flips) followed by `RomaniaPack.assemble_statements` (rules table +
canonical_bs builder) — so every assertion pins the composed behavior of
both layers, per OMFP_GAP_MATRIX.md rows. Assertions read the emitted
canonical_bs (the single authority) rather than intermediate buckets
wherever possible.
"""

from __future__ import annotations

from typing import Dict, List

import pytest

from engine.country_packs.ro_romania import trial_balance_parser as tbp
from engine.country_packs.ro_romania.chart_of_accounts import wrong_side_flip_bucket

ASSET_SECTIONS = {"non_current_assets", "current_assets", "prepaid_expenses"}


def rows10(*specs) -> List[Dict]:
    """Build 10-column parser-shape rows from (cont, name, {field: value})
    specs; unspecified columns are 0.0."""
    out: List[Dict] = []
    for cont, name, fields in specs:
        row = {"cont": cont, "nume_cont": name,
               "si_d": 0.0, "si_c": 0.0, "r_d": 0.0, "r_c": 0.0,
               "st_d": 0.0, "st_c": 0.0, "sf_d": 0.0, "sf_c": 0.0}
        row.update(fields)
        out.append(row)
    return out


@pytest.fixture(scope="module")
def assemble(pack):
    """Run the composed parser-shape + assemble + exclusion-merge path on
    raw 10-col rows — the same calls run_deterministic_tb makes after
    parsing, minus the file layer. Uses `pack.assemble_parsed_tb` (the
    extracted production composition) on a TrialBalanceParseResult with
    a real computed anchor + `closing_result`, so these pins exercise
    the closing-identity path exactly as stage_extract produces it."""

    def _assemble(rows):
        tb = tbp.TrialBalanceParseResult(
            rows,
            extraction={"method": "deterministic"},
            source_anchor=tbp.compute_source_anchor(rows),
        )
        pack.attach_closing_result(tb)
        _tb, shaped, assembled = pack.assemble_parsed_tb(
            tb, company_name="Synthetic", period_label="TEST",
        )
        cbs = assembled["assembled_canonical_v1"]["canonical_bs"]
        return shaped, assembled, cbs

    return _assemble


def _row_by_id(cbs: dict, row_id: str) -> dict:
    matches = [r for r in cbs["rows"] if r["id"] == row_id]
    assert matches, f"canonical row {row_id!r} not emitted; have " \
                    f"{[r['id'] for r in cbs['rows']]}"
    return matches[0]


def _diag_codes(cbs: dict) -> List[str]:
    return [d["code"] for d in cbs.get("diagnosis") or []]


# ── (a) Contra families reduce assets ──────────────────────────────────

def test_contra_28x_29x_39x_49x_reduce_assets(assemble):
    _shaped, _asm, cbs = assemble(rows10(
        ("212", "Constructii", {"sf_d": 1000.0}),
        ("2813", "Amortizarea constructiilor", {"sf_c": 300.0}),
        ("291", "Deprecieri imobilizari", {"sf_c": 100.0}),
        ("371", "Marfuri", {"sf_d": 400.0}),
        ("391", "Ajustari marfuri", {"sf_c": 50.0}),
        ("4111", "Clienti", {"sf_d": 200.0}),
        ("491", "Ajustari clienti", {"sf_c": 20.0}),
        ("1012", "Capital", {"sf_c": 1130.0}),
    ))
    # Every contra lands as a NEGATIVE row inside an ASSET section.
    for row_id, amount in (
        ("accumulated_depreciation_ppe", -300.0),
        ("accumulated_impairment_ppe", -100.0),
        ("inventory_provisions", -50.0),
        ("ar_provisions", -20.0),
    ):
        row = _row_by_id(cbs, row_id)
        assert row["section"] in ASSET_SECTIONS
        assert row["amount"] == amount
    # Net effect: assets 1000−300−100+400−50+200−20 = 1130 == equity.
    assert cbs["totals"]["assets"] == 1130.0
    assert cbs["status"] == "BALANCED"
    assert cbs["difference"] == 0.0


# ── (b) 129 contra-equity ──────────────────────────────────────────────

def test_129_reduces_equity(assemble):
    _shaped, _asm, cbs = assemble(rows10(
        ("1012", "Capital", {"sf_c": 100.0}),
        ("117.5", "Rezultat reportat", {"sf_c": 500.0}),
        ("1171", "Pierdere reportata", {"sf_d": 300.0}),
        ("129", "Repartizarea profitului", {"sf_d": 40.0}),
        ("475", "Subventii pentru investitii", {"sf_c": 240.0}),
        ("5121", "Banca", {"sf_d": 500.0}),
    ))
    assert _row_by_id(cbs, "profit_distribution_provision")["amount"] == -40.0
    assert _row_by_id(cbs, "profit_distribution_provision")["section"] == "equity"
    assert cbs["totals"]["equity"] == 260.0  # 100 + 500 − 300 − 40
    assert cbs["status"] == "BALANCED"


# ── (d) 5121 credit balance → ST bank debt, never negative cash ────────

def test_5121_credit_is_st_debt_not_negative_cash(assemble):
    _shaped, asm, cbs = assemble(rows10(
        ("1012", "Capital", {"sf_c": 300.0}),
        ("5121.1", "Banca RON", {"sf_d": 500.0}),
        ("5121.2", "Banca RON overdraft", {"sf_c": 200.0}),
    ))
    cash = _row_by_id(cbs, "cash_operating")
    assert cash["amount"] == 500.0 and cash["section"] == "current_assets"
    debt = _row_by_id(cbs, "st_debt_bank")
    assert debt["amount"] == 200.0 and debt["section"] == "current_liabilities"
    # No asset row may carry the overdraft as a negative — the flip must
    # move value across sides, not net it away.
    assert all(r["amount"] > 0 for r in cbs["rows"] if r["section"] in ASSET_SECTIONS)
    bs = asm["statements"]["balanceSheet"]
    assert bs["cash"] == 500.0
    assert bs["shortTermDebt"] == 200.0
    assert cbs["status"] == "BALANCED"


def test_wrong_side_flip_table_longest_prefix(pack):
    # 4428 must win over the 442 family; 512x routes to stDebt; 117/121
    # are deliberately absent (debit side = legitimate negative equity).
    assert wrong_side_flip_bucket("4428") == "otherCurrentAssets"
    assert wrong_side_flip_bucket("4424") == "otherCurrentLiab"
    assert wrong_side_flip_bucket("5124.01") == "stDebt"
    assert wrong_side_flip_bucket("117") is None
    assert wrong_side_flip_bucket("121") is None


# ── (d) Bifunctional 455/461/462 — both sides are real positions ───────

def test_bifunctional_455_461_462_both_sides(assemble):
    _shaped, _asm, cbs = assemble(rows10(
        ("1012", "Capital", {"sf_c": 380.0}),
        ("455", "Asociati - creditor", {"sf_c": 100.0}),
        ("455.1", "Asociati - debitor", {"sf_d": 80.0}),
        ("461", "Debitori diversi", {"sf_d": 120.0}),
        ("461.2", "Debitori diversi - creditor", {"sf_c": 60.0}),
        ("462", "Creditori diversi", {"sf_c": 90.0}),
        ("462.1", "Creditori diversi - debitor", {"sf_d": 70.0}),
        ("5121", "Banca", {"sf_d": 360.0}),
    ))
    # Debit balances land on the ASSET side…
    ar_ic = _row_by_id(cbs, "ar_intercompany")
    assert ar_ic["section"] == "current_assets"
    assert ar_ic["amount"] == 200.0            # 455.1 (80) + 461 (120)
    assert set(ar_ic["leaf_ids"]) == {"455.1", "461"}
    ar_other = _row_by_id(cbs, "ar_other")
    assert ar_other["amount"] == 70.0          # 462 debit → receivable
    # …credit balances land on the LIABILITY side, positive.
    ap_ic = _row_by_id(cbs, "ap_intercompany")
    assert ap_ic["section"] == "current_liabilities"
    assert ap_ic["amount"] == 160.0            # 455 (100) + 461.2 (60)
    assert _row_by_id(cbs, "ap_other")["amount"] == 90.0  # 462 credit
    # Nothing netted away: both sides carry the full gross positions.
    assert cbs["totals"]["assets"] == 630.0
    assert cbs["totals"]["equity_plus_liabilities"] == 630.0
    assert cbs["status"] == "BALANCED"


# ── (g) TVA 4423/4424/4426/4427 + 4428 by side ─────────────────────────

def test_tva_routing_by_side(assemble):
    _shaped, _asm, cbs = assemble(rows10(
        ("1012", "Capital", {"sf_c": 130.0}),
        ("4423", "TVA de plata", {"sf_c": 50.0}),
        ("4424", "TVA de recuperat", {"sf_d": 40.0}),
        ("4426", "TVA deductibila", {"sf_d": 30.0}),
        ("4427", "TVA colectata", {"sf_c": 60.0}),
        ("4428", "TVA neexigibila (debit)", {"sf_d": 20.0}),
        ("4428.1", "TVA neexigibila (credit)", {"sf_c": 25.0}),
        ("5121", "Banca", {"sf_d": 175.0}),
    ))
    asset_vat = _row_by_id(cbs, "ar_tax_recoverable")
    assert asset_vat["section"] == "current_assets"
    assert asset_vat["amount"] == 90.0                 # 4424 + 4426 + 4428-D
    assert set(asset_vat["leaf_ids"]) == {"4424", "4426", "4428"}
    liab_vat = _row_by_id(cbs, "ap_tax")
    assert liab_vat["section"] == "current_liabilities"
    assert liab_vat["amount"] == 135.0                 # 4423 + 4427 + 4428-C
    assert set(liab_vat["leaf_ids"]) == {"4423", "4427", "4428.1"}
    assert cbs["status"] == "BALANCED"


# ── (h) 475 → deferred income (liability side), never equity ───────────

def test_475_is_deferred_income_never_equity(assemble):
    _shaped, _asm, cbs = assemble(rows10(
        ("1012", "Capital", {"sf_c": 260.0}),
        ("475", "Subventii pentru investitii", {"sf_c": 240.0}),
        ("5121", "Banca", {"sf_d": 500.0}),
    ))
    grants = _row_by_id(cbs, "government_grants_deferred")
    assert grants["section"] == "deferred_income"
    assert grants["amount"] == 240.0
    # 475 must contribute to liabilities, and never appear in equity.
    assert cbs["totals"]["equity"] == 260.0
    assert cbs["totals"]["liabilities"] == 240.0
    for row in cbs["rows"]:
        if row["section"] == "equity":
            assert "475" not in (row.get("leaf_ids") or [])
    assert cbs["status"] == "BALANCED"


# ── (j) Class 8 + 891/892 excluded, with contract reasons ──────────────

def test_class8_and_891_892_excluded(assemble):
    shaped, _asm, cbs = assemble(rows10(
        ("1012", "Capital", {"sf_c": 500.0}),
        ("5121", "Banca", {"sf_d": 500.0}),
        ("8038", "Alte valori in afara bilantului", {"sf_d": 999.0}),
        ("891", "Bilant de deschidere", {"sf_d": 123.0}),
        ("892", "Bilant de inchidere", {"sf_c": 123.0}),
        # Zero NET closing — the normal 581 state, still excluded. A
        # NONZERO 581 closing now routes to unmapped and INTO the totals
        # (closing-identity fix 2026-08-15) — covered by
        # test_identity_property.py::test_transit_581_nonzero_closing_keeps_identity.
        ("581", "Viramente interne", {"sf_d": 10.0, "sf_c": 10.0}),
    ))
    # Parser layer: explicit exclusion with specific reasons — never
    # exclusion-by-fallthrough (audit gap 14).
    parser_reasons = {e["code"]: e["reason"] for e in shaped.excluded}
    assert parser_reasons["8038"] == "off_balance_class_8"
    assert parser_reasons["891"] == "opening_balance_sheet_account"
    assert parser_reasons["892"] == "closing_balance_sheet_account"
    assert parser_reasons["581"] == "ignore_transit"
    # canonical_bs.excluded carries the contract reason vocabulary.
    cbs_reasons = {e["code"]: e["reason"] for e in cbs["excluded"]}
    assert cbs_reasons["8038"] == "off_balance_memo_account"
    assert cbs_reasons["891"] == "opening_balance_sheet_account"
    assert cbs_reasons["892"] == "closing_balance_sheet_account"
    assert cbs_reasons["581"] == "transit_account_581"
    # No memo amount leaks into the statement.
    cited = set()
    for row in cbs["rows"]:
        cited.update(row.get("leaf_ids") or [])
    assert not cited & {"8038", "891", "892", "581"}
    assert cbs["totals"]["assets"] == 500.0
    assert cbs["totals"]["equity_plus_liabilities"] == 500.0
    assert cbs["status"] == "BALANCED"


# ── Unmapped accounts are surfaced, never silently dropped ─────────────

def test_unmapped_account_surfaced(assemble):
    shaped, _asm, cbs = assemble(rows10(
        ("1012", "Capital", {"sf_c": 500.0}),
        ("5121", "Banca", {"sf_d": 500.0}),
        # Bare 413 has no rule (the table carries 4130) — the exact code
        # behind the agras −46,613.06 leak. Class 9 codes are no longer a
        # valid "unmapped" example: they exclude as off-balance now.
        ("413", "Efecte de primit", {"sf_d": 77.0}),
    ))
    assert [u["code"] for u in shaped.unmapped] == ["413"]
    entry = [u for u in cbs["unmapped"] if u["code"] == "413"]
    assert entry and entry[0]["reason"] == "no_rule"
    assert entry[0]["sf_d"] == 77.0
    # Closing-identity: the unmapped balance is IN the totals (as an
    # Unclassified row) — never dropped.
    assert cbs["totals"]["assets"] == 577.0


# ── Negative equity renders with its sign ──────────────────────────────

def test_negative_equity_renders_with_sign(assemble):
    _shaped, _asm, cbs = assemble(rows10(
        ("1012", "Capital", {"sf_c": 100.0}),
        ("1171", "Pierdere reportata", {"sf_d": 400.0}),
        ("5121", "Banca", {"sf_d": 50.0}),
        ("401", "Furnizori", {"sf_c": 350.0}),
    ))
    losses = _row_by_id(cbs, "accumulated_losses_prior_years")
    assert losses["section"] == "equity"
    assert losses["amount"] == -400.0          # sign preserved, no abs() flip
    assert cbs["totals"]["equity"] == -300.0
    assert cbs["totals"]["equity_plus_liabilities"] == 50.0
    assert cbs["status"] == "BALANCED"
    assert cbs["difference"] == 0.0


# ── Duplicate rows detected (D5) ───────────────────────────────────────

def test_duplicate_rows_detected_d5(assemble):
    _shaped, _asm, cbs = assemble(rows10(
        ("371", "Marfuri", {"sf_d": 500.0}),
        ("371", "Marfuri", {"sf_d": 500.0}),   # exact duplicate row
        ("1012", "Capital", {"sf_c": 500.0}),
    ))
    # The doubled asset unbalances the statement…
    assert cbs["status"] == "MATERIAL_IMBALANCE"
    # …and the deterministic diagnosis names the duplicate.
    assert "D5_DUPLICATE_ROWS" in _diag_codes(cbs)
    d5 = [d for d in cbs["diagnosis"] if d["code"] == "D5_DUPLICATE_ROWS"]
    assert d5[0]["leaf_ids"] == ["371"]
    assert "2×" in d5[0]["detail"]


# ── (i) Pre-closing TB: 6xx/7xx close to equity, never assets ──────────

def test_preclosing_pl_balances_close_to_equity(assemble):
    _shaped, _asm, cbs = assemble(rows10(
        ("1012", "Capital", {"sf_c": 400.0}),
        ("5121", "Banca", {"sf_d": 1000.0}),
        # Pre-closing: class 6/7 still carry balances AND movements.
        ("707", "Venituri din vanzarea marfurilor", {"st_c": 700.0, "sf_c": 700.0}),
        ("607", "Cheltuieli privind marfurile", {"st_d": 100.0, "sf_d": 100.0}),
    ))
    # The result lands in equity as the derived current-year row, sourced
    # from the SAME closing column as everything else (closing identity)…
    profit = _row_by_id(cbs, "current_year_profit")
    assert profit["section"] == "equity"
    assert profit["amount"] == 600.0
    assert cbs["invariants"]["result_basis"] == "sf_closing_column"
    # …which DOCUMENTS the absorbed 6/7 balances via its leaf_ids
    # (contract 1b: excluded from asset/liability placement, absorbed
    # into the result line, traceable on the row).
    assert set(profit["leaf_ids"]) == {"607", "707"}
    # NO class 6/7 account appears on any OTHER balance-sheet row, asset
    # side or otherwise (a 6xx-as-asset would also unbalance the
    # statement) — only the derived result row may absorb them.
    for row in cbs["rows"]:
        if row["id"] in ("current_year_profit", "current_year_loss"):
            continue
        for code in row.get("leaf_ids") or []:
            assert not code.startswith(("6", "7")), (
                f"P&L account {code} leaked into BS row {row['id']}"
            )
    assert cbs["totals"]["assets"] == 1000.0
    assert cbs["totals"]["equity"] == 1000.0   # 400 capital + 600 result
    assert cbs["status"] == "BALANCED"
    assert cbs["difference"] == 0.0
    assert cbs["invariants"]["identity_holds"] is True
