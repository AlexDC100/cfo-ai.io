"""Power BI export tests — flatten correctness and round-trip via parquet."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from engine.actions import build_output
from engine.config import load_config
from engine.loader import load_categories_from_csv
from engine.pipeline import run_pipeline
from engine.storage.powerbi import export_csv, export_parquet, flatten

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def payload() -> dict:
    cfg = load_config(REPO_ROOT / "config.yaml")
    rows = load_categories_from_csv(REPO_ROOT / "data" / "validation_fixture_categories.csv")
    metrics, decisions = run_pipeline(rows, cfg, period_months=10)
    return build_output(decisions, metrics, cfg, run_date=date(2026, 5, 4),
                        data_period="YTD October 2025")


def test_flatten_one_row_per_category(payload: dict) -> None:
    df = flatten(payload)
    assert len(df) == 23


def test_flatten_columns_pinned(payload: dict) -> None:
    """Power BI dashboard depends on column order — verify it's stable."""
    df = flatten(payload)
    assert list(df.columns) == [
        "run_date", "data_period", "category", "level", "flag", "reason",
        "recommendation", "real_margin_pct", "volume_tons", "abs_profit_kron",
        "dio_days", "do_not_eliminate", "capital_freed_kron", "alert_reason",
        "context", "cost_of_capital_pct",
    ]


def test_flatten_macrou_alert_flag_preserved(payload: dict) -> None:
    df = flatten(payload)
    macrou = df[df["category"] == "Macrou"].iloc[0]
    assert macrou["flag"] == "ANCHOR_ALERT"
    assert macrou["alert_reason"] == "high_volume_anchor_below_floor"
    assert bool(macrou["do_not_eliminate"]) is True


def test_flatten_eliminate_carries_capital_freed(payload: dict) -> None:
    df = flatten(payload)
    elim = df[df["flag"] == "ELIMINATE"]
    # Pastrav and Plachie are KEEP after the niche-margin protection rule;
    # Calamar (real margin -92.7%) remains the only ELIMINATE category.
    assert len(elim) == 1
    assert elim["capital_freed_kron"].notna().all()


def test_export_parquet_round_trip(payload: dict, tmp_path: Path) -> None:
    out = export_parquet(payload, tmp_path)
    assert out.exists()
    df = pd.read_parquet(out)
    assert len(df) == 23
    assert "Macrou" in df["category"].tolist()


def test_export_csv_round_trip(payload: dict, tmp_path: Path) -> None:
    out = export_csv(payload, tmp_path)
    df = pd.read_csv(out)
    assert len(df) == 23
    flag_counts = df["flag"].value_counts().to_dict()
    # Counts updated by the niche-margin-protection fix (rules.py).
    assert flag_counts["KEEP"] == 12
    assert flag_counts["WARNING"] == 4
    assert flag_counts["ELIMINATE"] == 1
