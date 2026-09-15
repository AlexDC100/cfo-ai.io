"""The export gates' served two-period ratio block is today's composer output.

``tests/engine/fixtures/firm/served_ratio_pair.json`` is what the frontend
export gates (``frontend/lib/__tests__/reportPriorCredit.test.ts``,
``reportComparativesNoSecondRatio.test.ts``, ``exportFormatParity.test.ts``
G-C3b) render the report and the workbook over. A reader gate over a stale
capture proves the reader against a block the engine no longer serves, so
this recomputes the block through the real router and composer and compares
it byte for byte with the committed file.

WHAT IT REDS ON (TC-11): any change to the served ``ratios`` block of
``compare_payloads`` for the agras / carniprod pair — a value, a quantized
string, a band, a delta, a movement, a ranking, a finding row, a stamp — or
to the current period's served credit / Piotroski envelopes, without the
fixture being recaptured (``capture_served_ratio_pair.py``).

WHAT IT CANNOT SEE: whether the recaptured block is right; the ratio gates
(``test_ratio_compare.py``, ``test_comparatives_bands.py``) own that.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
CAPTURE = HERE / "fixtures" / "firm" / "capture_served_ratio_pair.py"


def _capture_module():
    spec = importlib.util.spec_from_file_location("capture_served_ratio_pair", CAPTURE)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_the_committed_pair_is_todays_composer_output():
    cap = _capture_module()
    if not cap.OUT.is_file():
        pytest.fail("served_ratio_pair.json is not committed; run capture_served_ratio_pair.py")
    fresh = cap.serialise(cap.build())
    committed = cap.OUT.read_text(encoding="utf-8")
    assert committed == fresh, (
        "served_ratio_pair.json is stale against the composer: re-run "
        "tests/engine/fixtures/firm/capture_served_ratio_pair.py and review the diff"
    )


def test_the_committed_corpus_pairs_are_todays_composer_output():
    """The twelve ordered corpus pairs the book-agnostic export gates render
    over (``reportPriorCredit.test.ts`` §4). Reds on any served change to any
    pair's ``ratios`` block, or to a book's credit / Piotroski envelope, not
    recaptured."""
    cap = _capture_module()
    if not cap.OUT_ALL.is_file():
        pytest.fail("served_ratio_pairs.json is not committed; run capture_served_ratio_pair.py")
    fresh = cap.serialise_compact(cap.build_all())
    committed = cap.OUT_ALL.read_text(encoding="utf-8")
    assert committed == fresh, (
        "served_ratio_pairs.json is stale against the composer: re-run "
        "tests/engine/fixtures/firm/capture_served_ratio_pair.py and review the diff"
    )
    doc = cap.build_all()
    assert len(doc["pairs"]) == 12, sorted(doc["pairs"])
    # Non-vacuity for the ladder-divergence gate: at least one pair where a
    # declared divergent key is graded on the served ladder.
    graded = [k for k, r in doc["pairs"].items()
              for row in r["rows"]
              if row["key"] in ("debt_to_assets", "dpo", "ccc", "asset_turnover")
              and row["current"]["band_status"] == "graded"]
    assert graded, "no pair grades a declared divergent key"


def test_the_pair_is_not_vacuous():
    doc = _capture_module().build()
    bm = doc["ratios"]["band_movements"]
    assert bm["improved"] and bm["deteriorated"], bm
    assert any(f.get("demoted") for f in bm["findings"]), "no demoted crossing to list"
    assert all(c["prior"]["value_q"] is not None for c in doc["ratios"]["composites"])
    assert doc["current_label"] != doc["prior_label"]
    assert doc["current_credit_envelope"]["letter_grade"] is not None
