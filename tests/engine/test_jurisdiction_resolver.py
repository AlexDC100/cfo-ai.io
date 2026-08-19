"""Jurisdiction resolver suite (AI extraction lane, deterministic).

Locked properties:
  · EVERY RO fixture — production golden files AND the synthetic
    locale/format variants — resolves RO, so the RO deterministic lane
    can never be hijacked by the resolver.
  · The synthetic HU fixture resolves HU (language signals).
  · Explicit user choice outranks every content signal.
  · Ambiguous / empty / binary content falls back to the RO default.
  · The resolver never raises (crash → RO default).

No network, no LLM — the resolver is deterministic by contract.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from engine.ai_lane import jurisdiction_resolver as jr
from engine.ai_lane import resolve_jurisdiction

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"

HU_FIXTURE = (
    SRC / "engine" / "country_packs" / "hu_hungary" / "fixtures"
    / "hu_szamlatukor_tb_2025.csv"
)
RO_SYNTHETIC_DIR = (
    SRC / "engine" / "country_packs" / "ro_romania" / "fixtures" / "synthetic"
)

# Same golden set the determinism gate runs (scripts/verify_determinism.py).
RO_GOLDEN = [
    REPO / "files" / "prod_scandia_frozen_31.12.2025.xlsx",
    REPO / "files" / "agras_tb_2025.xlsx",
    REPO / "files" / "scandia_realestate_tb_2025.xlsx",
    REPO / "files" / "carniprod_tb_2025.xlsx",
]

RO_SYNTHETIC = sorted(
    p for p in RO_SYNTHETIC_DIR.glob("synthetic_tb_*")
    if p.suffix in (".xlsx", ".csv")
)


def _resolve_path(path: Path):
    return jr.resolve(
        {"original_filename": path.name}, path.read_bytes(), None,
    )


# ── 1. RO fixtures must ALL resolve RO ─────────────────────────────────

@pytest.mark.parametrize(
    "path", RO_GOLDEN, ids=[p.name for p in RO_GOLDEN],
)
def test_ro_golden_fixtures_resolve_ro(path: Path):
    if not path.is_file():
        pytest.skip("golden fixture not present in this checkout: %s" % path.name)
    res = _resolve_path(path)
    assert res["jurisdiction"] == "RO", res
    assert res["source"] in ("language", "account_pattern"), res
    assert res["confidence"] > 0.2


@pytest.mark.parametrize(
    "path", RO_SYNTHETIC, ids=[p.name for p in RO_SYNTHETIC],
)
def test_ro_synthetic_fixtures_resolve_ro(path: Path):
    res = _resolve_path(path)
    assert res["jurisdiction"] == "RO", (path.name, res)


def test_ro_synthetic_fixtures_exist():
    # The parametrized RO-synthetic guard must never silently run empty.
    assert len(RO_SYNTHETIC) >= 4, RO_SYNTHETIC


# ── 2. HU fixture ──────────────────────────────────────────────────────

def test_hu_fixture_resolves_hu_via_language():
    res = _resolve_path(HU_FIXTURE)
    assert res["jurisdiction"] == "HU", res
    assert res["source"] == "language"
    assert res["confidence"] >= 0.5


# ── 3. Explicit user choice wins over everything ───────────────────────

def test_user_choice_outranks_content():
    ro_bytes = HU_FIXTURE.read_bytes()  # HU content...
    res = jr.resolve({}, ro_bytes, "RO")  # ...explicit RO choice
    assert res == {"jurisdiction": "RO", "source": "user", "confidence": 1.0}


def test_user_choice_from_doc_hint_key():
    # CONTRACT: documents.jurisdiction_hint (or the same key injected in
    # the doc dict) is the explicit user choice when no argument is given.
    res = resolve_jurisdiction({"jurisdiction_hint": "hu"}, b"irrelevant")
    assert res["jurisdiction"] == "HU"
    assert res["source"] == "user"


def test_user_choice_unknown_value_is_other():
    res = jr.resolve({}, b"", "DE")
    assert res["jurisdiction"] == "OTHER"
    assert res["source"] == "user"


def test_user_choice_argument_overrides_doc_hint():
    res = jr.resolve({"jurisdiction_hint": "HU"}, b"", "RO")
    assert res["jurisdiction"] == "RO"
    assert res["source"] == "user"


# ── 4. Account-pattern fallback (no language signal) ───────────────────

def test_ro_codes_with_english_names_resolve_ro_by_pattern():
    text = (
        "1012;Share capital;;1000000\n"
        "5121;Bank current account;500000;\n"
        "4111;Customers;250000;\n"
        "371;Goods;100000;\n"
    ).encode("utf-8")
    res = jr.resolve({}, text, None)
    assert res["jurisdiction"] == "RO", res
    assert res["source"] == "account_pattern"


def test_hu_marker_codes_with_english_names_resolve_hu_by_pattern():
    text = (
        "384;Bank current account;6400000;\n"
        "466;Input tax receivable;400000;\n"
        "411;Registered capital;;10000000\n"
        "911;Domestic sales;;17400000\n"
    ).encode("utf-8")
    res = jr.resolve({}, text, None)
    assert res["jurisdiction"] == "HU", res
    assert res["source"] == "account_pattern"


# ── 5. Ambiguous / degenerate inputs default to RO ─────────────────────

def test_empty_bytes_default_ro():
    assert jr.resolve({}, b"", None) == {
        "jurisdiction": "RO", "source": "default", "confidence": 0.2,
    }


def test_generic_english_text_defaults_ro():
    res = jr.resolve({}, b"hello world, quarterly report, nothing here", None)
    assert res["jurisdiction"] == "RO"
    assert res["source"] == "default"


def test_binary_garbage_never_raises():
    res = jr.resolve({}, b"\x00\xff\xfe\x01" * 100, None)
    assert res["jurisdiction"] == "RO"


def test_corrupt_zip_never_raises():
    res = jr.resolve({"original_filename": "x.xlsx"}, b"PK\x03\x04garbage", None)
    assert res["jurisdiction"] == "RO"
