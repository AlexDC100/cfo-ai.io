"""Phase-5 item 5 — synthetic file-level fixtures through the full
deterministic path (real XLSX/CSV bytes, not pre-built row dicts).

Covers: per-document number-locale detection (RO vs anglo renderings of
the SAME logical TB, including THE ambiguous one-separator cell), the
generic 4-column closing-only path, the CSV path (cp1250 + semicolon +
labelled TOTAL row), a source-imbalanced file (D1), and a mis-signed
account (MATERIAL_IMBALANCE + D2 sign-flip fingerprint).

The committed fixture files and the generator module
(fixtures/synthetic/make_synthetic_fixtures.py) are asserted against the
SAME expectation constants — regenerating the files with a drifted
generator fails here first.
"""

from __future__ import annotations

import pytest

from engine.country_packs.ro_romania import number_locale as nl

_NUMERIC_FIELDS = ("si_d", "si_c", "r_d", "r_c", "st_d", "st_c", "sf_d", "sf_c")


@pytest.fixture(scope="module")
def parse_synth(run_tb, synthetic_dir):
    def _parse(name):
        return run_tb(synthetic_dir / name)
    return _parse


def _rows_by_code(tb_rows):
    out = {}
    for r in tb_rows:
        assert r["cont"] not in out, f"duplicate code {r['cont']} in fixture"
        out[r["cont"]] = r
    return out


# ── RO vs anglo: same logical numbers, two textual renderings ──────────

def test_locale_detected_per_document(parse_synth):
    ro_tb, _s, _a = parse_synth("synthetic_tb_ro_locale.xlsx")
    an_tb, _s, _a = parse_synth("synthetic_tb_anglo_locale.xlsx")
    assert ro_tb.extraction["number_locale"] == "ro"
    assert an_tb.extraction["number_locale"] == "anglo"
    assert ro_tb.extraction["source_format"] == "saga_10_col"
    assert an_tb.extraction["source_format"] == "saga_10_col"


def test_ro_and_anglo_parse_to_identical_values(parse_synth, synth):
    ro_tb, _s, _a = parse_synth("synthetic_tb_ro_locale.xlsx")
    an_tb, _s, _a = parse_synth("synthetic_tb_anglo_locale.xlsx")
    ro_rows, an_rows = _rows_by_code(ro_tb), _rows_by_code(an_tb)
    assert set(ro_rows) == set(an_rows) == set(synth.EXPECTED_ROWS)
    for code, expected in synth.EXPECTED_ROWS.items():
        for field in _NUMERIC_FIELDS:
            assert ro_rows[code][field] == pytest.approx(expected[field], abs=0.005), (
                f"RO {code}.{field}"
            )
            assert an_rows[code][field] == pytest.approx(expected[field], abs=0.005), (
                f"anglo {code}.{field}"
            )


def test_ambiguous_cell_resolved_by_document_locale(parse_synth):
    """'4.568' (RO file) and '4,568' (anglo file) are the SAME number —
    only the per-document vote can parse both correctly; a per-cell
    heuristic misreads one of them 1000× (audit Ingestion §3)."""
    ro_tb, _s, _a = parse_synth("synthetic_tb_ro_locale.xlsx")
    an_tb, _s, _a = parse_synth("synthetic_tb_anglo_locale.xlsx")
    assert _rows_by_code(ro_tb)["5121"]["sf_d"] == 4568.0
    assert _rows_by_code(an_tb)["5121"]["sf_d"] == 4568.0


def test_locale_pair_anchor_and_assembly(parse_synth, synth):
    for name in ("synthetic_tb_ro_locale.xlsx", "synthetic_tb_anglo_locale.xlsx"):
        tb, _shaped, assembled = parse_synth(name)
        anchor = tb.source_anchor
        assert anchor["anchor_status"] == "MATCHED", name
        assert anchor["source_balanced"] is True, name
        for pair_key, total in synth.EXPECTED_TOTALS.items():
            pair = anchor["pairs"][pair_key]
            assert pair["extracted_debit"] == pytest.approx(total, abs=0.005)
            assert pair["extracted_credit"] == pytest.approx(total, abs=0.005)
            assert pair["file_debit"] == pytest.approx(total, abs=0.005)
        cbs = assembled["assembled_canonical_v1"]["canonical_bs"]
        assert cbs["status"] == "BALANCED", name
        assert cbs["totals"]["assets"] == pytest.approx(synth.EXPECTED_ASSETS)
        assert cbs["totals"]["equity"] == pytest.approx(synth.EXPECTED_EQUITY)
        assert cbs["totals"]["liabilities"] == pytest.approx(synth.EXPECTED_LIABILITIES)


def test_ro_and_anglo_canonical_bs_identical_except_locale(parse_synth):
    import json
    _t, _s, ro_asm = parse_synth("synthetic_tb_ro_locale.xlsx")
    _t, _s, an_asm = parse_synth("synthetic_tb_anglo_locale.xlsx")
    ro_cbs = json.loads(json.dumps(ro_asm["assembled_canonical_v1"]["canonical_bs"]))
    an_cbs = json.loads(json.dumps(an_asm["assembled_canonical_v1"]["canonical_bs"]))
    assert ro_cbs["extraction"].pop("number_locale") == "ro"
    assert an_cbs["extraction"].pop("number_locale") == "anglo"
    # Sheet names differ by design (TB_ro / TB_anglo); everything numeric
    # and structural must be identical.
    ro_cbs["extraction"].pop("sheet")
    an_cbs["extraction"].pop("sheet")
    assert json.dumps(ro_cbs, sort_keys=True) == json.dumps(an_cbs, sort_keys=True)


# ── CSV path (cp1250, semicolon, TOTAL-labelled totals row) ────────────

def test_csv_parses_like_the_xlsx(parse_synth, synth):
    csv_tb, _shaped, assembled = parse_synth("synthetic_tb_ro_locale.csv")
    assert csv_tb.extraction["method"] == "deterministic"
    assert csv_tb.extraction["number_locale"] == "ro"
    assert csv_tb.extraction["source_format"] == "saga_10_col"
    rows = _rows_by_code(csv_tb)
    assert set(rows) == set(synth.EXPECTED_ROWS)
    for code, expected in synth.EXPECTED_ROWS.items():
        for field in _NUMERIC_FIELDS:
            assert rows[code][field] == pytest.approx(expected[field], abs=0.005)
    # cp1250 fallback preserved the diacritic name (utf-8 decode fails
    # on 0xE3-followed-by-ASCII, so surviving 'ă' proves the fallback).
    assert rows["371"]["nume_cont"] == "Mărfuri"
    # The bottom TOTAL-labelled row anchors the extraction.
    anchor = csv_tb.source_anchor
    assert anchor["anchor_status"] == "MATCHED"
    assert anchor["source_balanced"] is True
    cbs = assembled["assembled_canonical_v1"]["canonical_bs"]
    assert cbs["status"] == "BALANCED"
    assert cbs["totals"]["assets"] == pytest.approx(synth.EXPECTED_ASSETS)


# ── Generic 4-column closing-only export ───────────────────────────────

def test_generic_4col_path(parse_synth):
    tb, _shaped, assembled = parse_synth("synthetic_tb_generic_4col.xlsx")
    assert tb.extraction["source_format"] == "generic_4_col"
    anchor = tb.source_anchor
    # The lone unlabelled pair is the closing balances; the other blocks
    # do not exist in this format → null pairs per the contract.
    assert anchor["pairs"]["si"] is None
    assert anchor["pairs"]["rl"] is None
    assert anchor["pairs"]["rc"] is None
    assert anchor["pairs"]["sf"] is not None
    assert anchor["anchor_status"] == "MATCHED"
    assert anchor["source_balanced"] is True
    cbs = assembled["assembled_canonical_v1"]["canonical_bs"]
    assert cbs["status"] == "BALANCED"
    assert cbs["totals"]["assets"] == 1000.0
    assert cbs["totals"]["equity"] == 1000.0


# ── Deliberately imbalanced source → D1 ────────────────────────────────

def test_imbalanced_source_fires_d1(parse_synth, synth):
    tb, _shaped, assembled = parse_synth("synthetic_tb_imbalanced_source.xlsx")
    anchor = tb.source_anchor
    # Extraction is FAITHFUL to a broken source: anchor MATCHED, yet the
    # file's own sf pair disagrees with itself.
    assert anchor["anchor_status"] == "MATCHED"
    assert anchor["source_balanced"] is False
    assert anchor["imbalanced_pairs"] == ["sf"]
    cbs = assembled["assembled_canonical_v1"]["canonical_bs"]
    assert cbs["status"] == "MATERIAL_IMBALANCE"
    assert cbs["difference"] == -synth.IMBALANCED_GAP_RON
    d1 = [d for d in cbs["diagnosis"] if d["code"] == "D1_SOURCE_IMBALANCED"]
    assert d1, f"D1 missing; diagnosis: {cbs['diagnosis']}"
    assert "pereche sf" in d1[0]["detail"]
    assert "300.00" in d1[0]["detail"]


# ── Mis-signed account → MATERIAL_IMBALANCE + D2 fingerprint ───────────

def test_missigned_account_fires_d2_signflip(parse_synth, synth):
    tb, _shaped, assembled = parse_synth("synthetic_tb_missigned_account.xlsx")
    assert tb.source_anchor["anchor_status"] == "NO_ANCHOR"
    cbs = assembled["assembled_canonical_v1"]["canonical_bs"]
    assert cbs["status"] == "MATERIAL_IMBALANCE"
    # A sign flip moves the gap by 2× the amount.
    assert cbs["difference"] == -2 * synth.MISSIGNED_AMOUNT_RON
    d2 = [d for d in cbs["diagnosis"] if d["code"] == "D2_FINGERPRINT"]
    assert d2, f"D2 missing; diagnosis: {cbs['diagnosis']}"
    assert d2[0]["leaf_ids"] == ["371"]
    assert "sign-flip" in d2[0]["detail"]


# ── number_locale unit coverage (the shared cell grammar) ──────────────

class TestNumberLocale:
    def test_unambiguous_shapes_parse_identically_in_both_locales(self):
        for cell, expected in (
            ("1.234.567,89", 1234567.89),   # both separators, RO order
            ("1,234,567.89", 1234567.89),   # both separators, anglo order
            ("1234,56", 1234.56),           # decimal comma by grammar
            ("1234.56", 1234.56),           # decimal dot by grammar
            ("3 980 157,61", 3980157.61),   # space thousands
            ("(1.234,56)", -1234.56),       # parenthesized negative
            ("-500", -500.0),
        ):
            assert nl.parse_number(cell, nl.RO) == pytest.approx(expected), cell
            assert nl.parse_number(cell, nl.ANGLO) == pytest.approx(expected), cell

    def test_ambiguous_shape_decided_by_document_locale(self):
        assert nl.parse_number("4.568", nl.RO) == 4568.0      # ro thousands
        assert nl.parse_number("4.568", nl.ANGLO) == 4.568    # anglo decimal
        assert nl.parse_number("4,568", nl.ANGLO) == 4568.0   # anglo thousands
        assert nl.parse_number("4,568", nl.RO) == 4.568       # ro decimal

    def test_garbage_and_blanks_degrade_to_zero(self):
        for cell in ("", "nan", "-", None, "abc", "—"):
            assert nl.parse_number(cell, nl.RO) == 0.0
            assert nl.parse_number(cell, nl.ANGLO) == 0.0

    def test_unknown_locale_raises(self):
        with pytest.raises(ValueError):
            nl.parse_number("1", "de")

    def test_majority_vote_and_default(self):
        assert nl.detect_number_locale(["1.234,56", "789,00", "1,234.56"]) == nl.RO
        assert nl.detect_number_locale(["1,234.56", "789.00", "1.234,56"]) == nl.ANGLO
        # No signal → the caller's default decides (XLSX passes anglo).
        assert nl.detect_number_locale(["123", "456"], default=nl.ANGLO) == nl.ANGLO
        assert nl.detect_number_locale(["123", "456"], default=nl.RO) == nl.RO


# ── Committed fixture files ↔ generator drift guard ────────────────────

def test_committed_fixtures_match_generator(synth, synthetic_dir, pack):
    """Every committed synthetic fixture must PARSE identically to
    freshly generated bytes (XLSX containers are not byte-stable across
    openpyxl versions, so equality is asserted on parsed rows, not on
    the container)."""
    for name in sorted(synth.FIXTURE_BUILDERS):
        committed = (synthetic_dir / name).read_bytes()
        fresh = synth.FIXTURE_BUILDERS[name]()
        kind = "csv" if name.endswith(".csv") else "auto"
        tb_committed = (
            pack.parse_trial_balance_csv(committed, name) if kind == "csv"
            else pack.parse_trial_balance(committed, name)
        )
        tb_fresh = (
            pack.parse_trial_balance_csv(fresh, name) if kind == "csv"
            else pack.parse_trial_balance(fresh, name)
        )
        assert list(tb_committed) == list(tb_fresh), f"{name} drifted from generator"
        assert tb_committed.source_anchor == tb_fresh.source_anchor, name
