"""canonical_bs v2 invariant suite over every parseable fixture in files/.

Phase-5 item 1 (docs/CANONICAL_BS_V2_CONTRACT.md): for each fixture the
FULL offline production path runs (`RomaniaPack.run_deterministic_tb` —
the same code object stage_extract + stage_map compose) and the emitted
canonical_bs is checked against the contract's structural invariants:

  · totals.assets == Σ asset-section rows == Σ asset-section subtotals
  · totals.equity_plus_liabilities likewise on the E+L side
  · difference == assets − (equity + liabilities)
  · source conservation — classified + unmapped + excluded covers the
    source account census (builder flag asserted TRUE, plus the edge
    checks the flag alone can't localize)
  · no reconciliation value without a source value — every cited account
    code exists in the source file; every nonzero row is leaf-backed
    except the derived current-year-result closure
  · 121 cross-check — p121 mirrors the statutory anchor and `ok` follows
    the comparison formula exactly (see the note on the honest-mismatch
    fixtures below)
  · status matches the contract tolerance ladder

Fixture enumeration is dynamic (files/*.xlsx|*.xls|*.csv|*.pdf) so a new
TB fixture dropped into files/ is covered automatically; known fixtures
MUST parse (a ParseError there is a regression, not a skip).
"""

from __future__ import annotations

from pathlib import Path
from typing import List

import pytest

from engine.country_packs.ro_romania import trial_balance_parser as tbp
from engine.country_packs.ro_romania.chart_of_accounts import MAPPING_VERSION

REPO = Path(__file__).resolve().parents[2]
FILES_DIR = REPO / "files"

# Not trial balances — never expected to parse. Attempting them anyway
# costs ~7s each (multi-sheet scan of a 12MB SKU workbook) for a known
# ParseError, so they are excluded by name with the reason on record.
_NOT_TRIAL_BALANCES = {
    "Trading_analysis_YTDOct'25_LV.xlsx": "SKU trading workbook, not a TB",
}

# Fixtures that MUST parse — a ParseError on any of these is a parser
# regression and fails the test instead of skipping.
_MUST_PARSE = {
    "agras_tb_2025.xlsx",
    "carniprod_tb_2025.xlsx",
    "prod_scandia_frozen_31.12.2025.xlsx",
    "scandia_frozen_tb_2025.xlsx",
    "scandia_realestate_tb_2025.xlsx",
    "scandia_retail_tb_2025.xlsx",
    "scandia_sibiu_tb_2019.pdf",
    "scandia_trial_balance_2025_downloaded.xlsx",
}

_ASSET_SECTIONS = {"non_current_assets", "current_assets", "prepaid_expenses"}
_EQUITY_SECTIONS = {"equity"}
_SECTION_ORDER = [
    "non_current_assets", "current_assets", "prepaid_expenses",
    "equity", "provisions", "non_current_liabilities",
    "current_liabilities", "deferred_income",
]
# Rows synthesized from the 121 result closure — the only rows allowed
# to carry value without account-level leaf backing.
_DERIVED_ROW_IDS = {"current_year_profit", "current_year_loss"}

_SOURCE_FORMATS = {
    "saga_10_col", "saga_compact_6_col", "generic_4_col", "pdf_positional",
}


def _fixture_paths() -> List[Path]:
    out = [
        p for p in sorted(FILES_DIR.iterdir())
        if p.suffix.lower() in (".xlsx", ".xls", ".csv", ".pdf")
        and p.name not in _NOT_TRIAL_BALANCES
    ]
    assert out, f"no fixture files found under {FILES_DIR}"
    return out


_PATHS = _fixture_paths()


@pytest.fixture(scope="module", params=_PATHS, ids=[p.name for p in _PATHS])
def parsed(request, run_tb):
    """(tb_rows, shaped, assembled, canonical_bs) for one fixture, parsed
    once per session via the shared memoized runner."""
    path = request.param
    try:
        tb_rows, shaped, assembled = run_tb(path)
    except tbp.ParseError as e:
        if path.name in _MUST_PARSE:
            pytest.fail(f"{path.name} MUST parse but raised ParseError: {e.user_message}")
        pytest.skip(f"{path.name}: not deterministically parseable ({e.user_message[:80]})")
    env = assembled.get("assembled_canonical_v1")
    assert isinstance(env, dict), f"{path.name}: no assembled_canonical_v1 emitted"
    cbs = env.get("canonical_bs")
    assert isinstance(cbs, dict), f"{path.name}: envelope has no canonical_bs"
    return tb_rows, shaped, assembled, cbs


def test_schema_and_provenance(parsed):
    tb_rows, _shaped, _assembled, cbs = parsed
    assert cbs["schema"] == "bs_v2"
    assert cbs["mapping_version"] == MAPPING_VERSION
    ex = cbs["extraction"]
    assert ex["method"] == "deterministic"
    assert ex["parser_version"] == tbp.PARSER_VERSION
    assert ex["source_format"] in _SOURCE_FORMATS
    assert ex["number_locale"] in ("ro", "anglo")
    # The parse result's own metadata is what the envelope must carry.
    assert ex["source_format"] == tb_rows.extraction["source_format"]
    assert ex["number_locale"] == tb_rows.extraction["number_locale"]


def test_sections_fixed_order(parsed):
    _tb, _shaped, _assembled, cbs = parsed
    assert [s["id"] for s in cbs["sections"]] == _SECTION_ORDER


def test_assets_equal_row_and_subtotal_sums(parsed):
    _tb, _shaped, _assembled, cbs = parsed
    totals = cbs["totals"]
    row_sum = round(sum(
        r["amount"] for r in cbs["rows"] if r["section"] in _ASSET_SECTIONS
    ), 2)
    subtotal_sum = round(sum(
        s["subtotal"] for s in cbs["sections"] if s["id"] in _ASSET_SECTIONS
    ), 2)
    assert abs(totals["assets"] - row_sum) < 0.01
    assert abs(totals["assets"] - subtotal_sum) < 0.01
    assert cbs["invariants"]["assets_eq_row_sum"] is True


def test_equity_plus_liabilities_equal_row_and_subtotal_sums(parsed):
    _tb, _shaped, _assembled, cbs = parsed
    totals = cbs["totals"]
    el_row_sum = round(sum(
        r["amount"] for r in cbs["rows"] if r["section"] not in _ASSET_SECTIONS
    ), 2)
    equity_sum = round(sum(
        s["subtotal"] for s in cbs["sections"] if s["id"] in _EQUITY_SECTIONS
    ), 2)
    liab_sum = round(sum(
        s["subtotal"] for s in cbs["sections"]
        if s["id"] not in _ASSET_SECTIONS and s["id"] not in _EQUITY_SECTIONS
    ), 2)
    assert abs(totals["equity"] - equity_sum) < 0.01
    assert abs(totals["liabilities"] - liab_sum) < 0.01
    assert abs(totals["equity_plus_liabilities"]
               - round(totals["equity"] + totals["liabilities"], 2)) < 0.01
    assert abs(totals["equity_plus_liabilities"] - el_row_sum) < 0.01
    assert cbs["invariants"]["el_eq_row_sum"] is True


def test_difference_is_assets_minus_el(parsed):
    _tb, _shaped, _assembled, cbs = parsed
    totals = cbs["totals"]
    expected = round(totals["assets"] - totals["equity_plus_liabilities"], 2)
    assert cbs["difference"] == expected


def test_status_matches_tolerance_ladder(parsed):
    _tb, _shaped, _assembled, cbs = parsed
    assets = cbs["totals"]["assets"]
    diff = abs(cbs["difference"])
    anchor_status = (cbs.get("source_anchor") or {}).get("anchor_status")
    method = (cbs.get("extraction") or {}).get("method")
    # Contract ladder: BALANCED ≤ max(1 RON, 0.001% of assets);
    # MINOR_DRIFT ≤ 0.5%; MATERIAL otherwise; DIVERGED anchor forces
    # MATERIAL; llm extraction can never claim BALANCED.
    if anchor_status == "DIVERGED":
        expected = "MATERIAL_IMBALANCE"
    elif diff <= max(1.0, abs(assets) * 0.00001):
        expected = "BALANCED"
    elif diff <= abs(assets) * 0.005:
        expected = "MINOR_DRIFT"
    else:
        expected = "MATERIAL_IMBALANCE"
    if expected == "BALANCED" and method == "llm":
        expected = "MINOR_DRIFT"
    assert cbs["status"] == expected


def test_source_conservation(parsed):
    tb_rows, shaped, _assembled, cbs = parsed
    # The builder's falsifiable flag (census plumbed by run_deterministic_tb).
    assert cbs["invariants"]["source_conservation"] is True
    # Edge coverage the count-equality flag can't localize:
    unmapped_codes = {u["code"] for u in cbs.get("unmapped") or []}
    excluded_codes = {e["code"] for e in cbs.get("excluded") or []}
    for u in getattr(shaped, "unmapped", []):
        assert u["code"] in unmapped_codes, (
            f"parser-unmapped {u['code']} missing from canonical_bs.unmapped"
        )
    for e in getattr(shaped, "excluded", []):
        assert e["code"] in excluded_codes, (
            f"parser-excluded {e['code']} missing from canonical_bs.excluded"
        )


def test_no_reconciliation_value_without_source_value(parsed):
    tb_rows, _shaped, _assembled, cbs = parsed
    source_codes = {(r.get("cont") or "").strip() for r in tb_rows}
    cited = set()
    for row in cbs["rows"]:
        cited.update(row.get("leaf_ids") or [])
        if row["amount"] != 0 and not row.get("leaf_ids"):
            # Only the derived 121 result closure may carry value with no
            # account backing — anything else is a fabricated figure.
            assert row["id"] in _DERIVED_ROW_IDS, (
                f"row {row['id']} carries {row['amount']} with no source accounts"
            )
    cited |= {u["code"] for u in cbs.get("unmapped") or []}
    cited |= {e["code"] for e in cbs.get("excluded") or []}
    alien = sorted(c for c in cited if c and c not in source_codes)
    assert not alien, f"canonical_bs cites accounts absent from the source: {alien}"


def test_p121_cross_check(parsed):
    tb_rows, shaped, _assembled, cbs = parsed
    block = cbs["invariants"]["p121_cross_check"]
    assert set(block) == {"ok", "p121", "cls7_minus_cls6"}
    p121 = block["p121"]
    cls = block["cls7_minus_cls6"]
    if p121 is None or cls is None:
        # Not falsifiable — emitted ok:true by contract.
        assert block["ok"] is True
        return
    # p121 must be the statutory anchor read from the SOURCE rows.
    anchor = round(tbp.compute_statutory_net_profit_anchor(tb_rows), 2)
    assert p121 == anchor
    # `ok` follows the emission formula exactly. NOTE: several Crystal-
    # layout fixtures honestly report ok:false (sume-totale 711 semantics,
    # audit item i) — the invariant here is that the emission is HONEST
    # and never auto-corrected, not that every source reconciles.
    expected_ok = abs(p121 - cls) <= max(1.0, abs(p121) * 0.005)
    assert block["ok"] is expected_ok
    # When classes 6/7 carry movements, the reconstruction side must be
    # present (non-null) — the comparison may not silently degrade.
    has_pl_activity = any(
        (r.get("cont") or "").strip()[:1] in ("6", "7")
        and (float(r.get("st_d") or 0) != 0 or float(r.get("st_c") or 0) != 0
             or float(r.get("sf_d") or 0) != 0 or float(r.get("sf_c") or 0) != 0)
        for r in tb_rows
    )
    if has_pl_activity:
        assert cls is not None


def test_anchor_pairs_match_when_anchored(parsed):
    _tb, _shaped, _assembled, cbs = parsed
    anchor = cbs["source_anchor"]
    assert anchor["anchor_status"] in ("MATCHED", "DIVERGED", "NO_ANCHOR")
    pairs = anchor.get("pairs") or {}
    assert set(pairs) <= {"si", "rl", "rc", "sf"}
    if anchor["anchor_status"] != "MATCHED":
        return
    # MATCHED means every file-provided side agrees with the extracted
    # sum within the parser's 1-cent tolerance (or via the documented
    # off-balance-inclusive fallback, which the flag records).
    for name, pair in pairs.items():
        if not pair:
            continue
        for side in ("debit", "credit"):
            file_v = pair.get(f"file_{side}")
            delta = pair.get(f"delta_{side}")
            if file_v is None:
                assert delta is None
            elif not anchor.get("file_totals_include_off_balance"):
                assert delta is not None and abs(delta) <= 0.01, (
                    f"pair {name} {side}: delta {delta} on a MATCHED anchor"
                )
