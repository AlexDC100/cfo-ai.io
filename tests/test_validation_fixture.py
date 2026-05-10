"""End-to-end test: every category in the fixture must get its expected flag.

Runs against both the fixture CSV (always present) and the real Excel
workbook (skipped if not shipped). Either path is the Phase 1 contract.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from engine.config import load_config
from engine.loader import load_categories_from_csv, load_categories_from_excel
from engine.pipeline import run_pipeline
from engine.validate import EXPECTED_COUNTS, EXPECTED_FLAGS

REPO_ROOT = Path(__file__).resolve().parent.parent
EXCEL_PATH = REPO_ROOT / "files" / "Trading_analysis_YTDOct'25_LV.xlsx"
FIXTURE_CSV = REPO_ROOT / "data" / "validation_fixture_categories.csv"
CONFIG = REPO_ROOT / "config.yaml"


def _run(rows):
    cfg = load_config(CONFIG)
    _metrics, decisions = run_pipeline(rows, cfg, period_months=10)
    return {d.id: d.flag for d in decisions}


def test_fixture_csv_matches_expected_flags() -> None:
    rows = load_categories_from_csv(FIXTURE_CSV)
    got = _run(rows)
    for cat, expected in EXPECTED_FLAGS.items():
        assert got.get(cat) == expected, f"{cat}: expected {expected}, got {got.get(cat)}"


def test_fixture_csv_matches_expected_counts() -> None:
    rows = load_categories_from_csv(FIXTURE_CSV)
    got = _run(rows)
    counts: dict[str, int] = {}
    for f in got.values():
        counts[f] = counts.get(f, 0) + 1
    for flag, expected in EXPECTED_COUNTS.items():
        assert counts.get(flag, 0) == expected, f"{flag}: expected {expected}, got {counts.get(flag, 0)}"


@pytest.mark.skipif(not EXCEL_PATH.exists(), reason="Excel workbook not shipped")
def test_real_excel_matches_expected_flags() -> None:
    """Same contract as the CSV path — proves the Excel loader extracts the same data."""
    rows = load_categories_from_excel(EXCEL_PATH)
    got = _run(rows)
    for cat, expected in EXPECTED_FLAGS.items():
        assert got.get(cat) == expected, f"{cat}: expected {expected}, got {got.get(cat)}"
