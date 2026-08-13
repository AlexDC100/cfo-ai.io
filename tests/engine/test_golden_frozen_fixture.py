"""Golden test for the frozen production fixture (Phase-5 item 3).

files/prod_scandia_frozen_31.12.2025.xlsx is THE document behind the
BS_ENGINE_ROOT_CAUSE incident (two engine runs of the byte-identical
file produced different books). Its expected.json pins the external
conservation anchor read from the FILE ITSELF — extraction must match
the file's own totals row to the cent, on every column pair, every run.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from engine.country_packs.ro_romania import trial_balance_parser as tbp

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "files" / "prod_scandia_frozen_31.12.2025.xlsx"
EXPECTED = REPO / "files" / "prod_scandia_frozen_31.12.2025.expected.json"

# expected.json's source_totals_row keys → contract anchor pair names.
_PAIR_KEYS = {
    "si": ("si_debit", "si_credit"),
    "rl": ("rl_debit", "rl_credit"),
    "rc": ("rc_debit", "rc_credit"),
    "sf": ("sf_debit", "sf_credit"),
}

# "to the cent" — beyond float-rounding slack on a 60M sum is a failure.
_CENT = 0.005


@pytest.fixture(scope="module")
def expected():
    return json.loads(EXPECTED.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def golden(run_tb):
    tb_rows, shaped, assembled = run_tb(FIXTURE)
    cbs = assembled["assembled_canonical_v1"]["canonical_bs"]
    return tb_rows, shaped, assembled, cbs


def test_fixture_bytes_unchanged(expected):
    """Guard against fixture rot: the golden file must still be the
    byte-exact document the incident was diagnosed on."""
    md5 = hashlib.md5(FIXTURE.read_bytes()).hexdigest()
    assert md5 == expected["md5"]


def test_account_row_count(golden, expected):
    tb_rows, _shaped, _assembled, _cbs = golden
    assert len(tb_rows) == int(expected["account_rows"])  # 382


def test_all_four_pairs_match_file_totals_to_the_cent(golden, expected):
    _tb, _shaped, _assembled, cbs = golden
    src = expected["source_totals_row"]
    pairs = cbs["source_anchor"]["pairs"]
    for pair_name, (dk, ck) in sorted(_PAIR_KEYS.items()):
        pair = pairs[pair_name]
        assert pair is not None, f"pair {pair_name} missing from anchor"
        exp_d, exp_c = float(src[dk]), float(src[ck])
        assert abs(pair["extracted_debit"] - exp_d) <= _CENT, (
            f"{pair_name} debit: extracted {pair['extracted_debit']:,.2f} "
            f"!= file {exp_d:,.2f}"
        )
        assert abs(pair["extracted_credit"] - exp_c) <= _CENT, (
            f"{pair_name} credit: extracted {pair['extracted_credit']:,.2f} "
            f"!= file {exp_c:,.2f}"
        )
        assert abs(pair["file_debit"] - exp_d) <= _CENT
        assert abs(pair["file_credit"] - exp_c) <= _CENT


def test_sf_sums_exact(golden, expected):
    """The headline anchor: extracted SF column sums == 60,205,165.12
    both sides (the prod incident claimed 70.2M against this file)."""
    tb_rows, _shaped, _assembled, _cbs = golden
    exp = expected["source_totals_row"]
    sf_d = sum(float(r["sf_d"]) for r in tb_rows if not r["cont"].startswith("8"))
    sf_c = sum(float(r["sf_c"]) for r in tb_rows if not r["cont"].startswith("8"))
    assert abs(sf_d - float(exp["sf_debit"])) <= _CENT
    assert abs(sf_c - float(exp["sf_credit"])) <= _CENT


def test_anchor_matched_and_source_balanced(golden):
    _tb, _shaped, _assembled, cbs = golden
    anchor = cbs["source_anchor"]
    assert anchor["anchor_status"] == "MATCHED"
    assert anchor["totals_row_found"] is True
    assert anchor["source_balanced"] is True


def test_extraction_provenance(golden, expected):
    _tb, _shaped, _assembled, cbs = golden
    ex = cbs["extraction"]
    assert ex["method"] == "deterministic"
    assert ex["parser_version"] == tbp.PARSER_VERSION
    assert ex["source_format"] == "saga_10_col"
    assert ex["sheet"] == expected["sheet"]  # Document_CH14
    assert ex["header_row_index"] == 0
    # The file's numeric cells are true-numeric (pandas dot-decimal repr)
    # → the per-document vote lands on the anglo default.
    assert ex["number_locale"] == "anglo"


def test_status_balanced_per_tolerance(golden):
    _tb, _shaped, _assembled, cbs = golden
    assets = cbs["totals"]["assets"]
    assert abs(cbs["difference"]) <= max(1.0, abs(assets) * 0.00001), (
        f"difference {cbs['difference']} exceeds the BALANCED tolerance"
    )
    assert cbs["status"] == "BALANCED"


def test_frozen_twin_fixture_is_byte_identical(expected):
    """files/scandia_frozen_tb_2025.xlsx (the F-A3.1 canary's 'Frozen'
    fixture) must stay the same document — the canary and this golden
    test cover one file, not two silently diverging copies."""
    twin = REPO / "files" / "scandia_frozen_tb_2025.xlsx"
    assert hashlib.md5(twin.read_bytes()).hexdigest() == expected["md5"]
