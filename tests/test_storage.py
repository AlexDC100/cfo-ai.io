"""Tests for the Postgres adapter — exercised against sqlite in-memory."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from engine.config import load_config
from engine.actions import build_output
from engine.loader import load_categories_from_csv
from engine.models import CategoryRow, MasterOverride
from engine.pipeline import run_pipeline
from engine.storage import (
    PostgresAdapter,
    SchemaMasterOverride,
    create_engine_from_url,
)


REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def adapter() -> PostgresAdapter:
    eng = create_engine_from_url("sqlite:///:memory:")
    a = PostgresAdapter(eng)
    a.create_all()
    return a


@pytest.fixture
def fixture_rows() -> list:
    return load_categories_from_csv(REPO_ROOT / "data" / "validation_fixture_categories.csv")


def test_round_trip_categories(adapter: PostgresAdapter, fixture_rows: list) -> None:
    snap = date(2025, 10, 31)
    adapter.insert_categories(snap, fixture_rows)
    loaded = adapter.load_categories(snap)
    assert len(loaded) == len(fixture_rows)
    by_name = {r.category: r for r in loaded}
    assert by_name["Macrou"].volume_tons == pytest.approx(352.8)
    assert by_name["LEGUME CONSERVATE"].dio_days == 60


def test_insert_categories_idempotent(adapter: PostgresAdapter, fixture_rows: list) -> None:
    """Re-inserting the same date wipes prior rows — no duplicates accumulate."""
    snap = date(2025, 10, 31)
    adapter.insert_categories(snap, fixture_rows)
    adapter.insert_categories(snap, fixture_rows)  # Second insert
    assert len(adapter.load_categories(snap)) == len(fixture_rows)


def test_overrides_round_trip(adapter: PostgresAdapter) -> None:
    with adapter._session() as s:
        s.add(SchemaMasterOverride(
            sku_id="MURATURI",
            strategic_flag=False,
            override_reason="Alex: warning until renegotiation, NOT auto-strategic",
        ))
        s.add(SchemaMasterOverride(
            sku_id="Macrou",
            strategic_flag=True,
            override_reason="High-volume anchor, do not auto-eliminate",
        ))
        s.commit()
    overrides = adapter.load_overrides()
    assert overrides["MURATURI"].strategic_flag is False
    assert overrides["Macrou"].strategic_flag is True


def test_write_and_fetch_decisions(adapter: PostgresAdapter, fixture_rows: list) -> None:
    """Run the engine, persist its JSON output, fetch it back."""
    cfg = load_config(REPO_ROOT / "config.yaml")
    metrics, decisions = run_pipeline(fixture_rows, cfg, period_months=10)
    payload = build_output(decisions, metrics, cfg, run_date=date(2026, 5, 4),
                           data_period="YTD October 2025")
    n = adapter.write_decisions(payload)
    assert n == 23

    fetched = adapter.fetch_decisions(date(2026, 5, 4))
    assert len(fetched) == 23
    by_cat = {f["category"]: f for f in fetched}
    assert by_cat["Macrou"]["flag"] == "ANCHOR_ALERT"
    assert by_cat["Macrou"]["do_not_eliminate"] is True
    assert by_cat["Calamar"]["flag"] == "ELIMINATE"
    assert by_cat["MURATURI"]["flag"] == "WARNING"


def test_write_decisions_idempotent(adapter: PostgresAdapter, fixture_rows: list) -> None:
    cfg = load_config(REPO_ROOT / "config.yaml")
    metrics, decisions = run_pipeline(fixture_rows, cfg, period_months=10)
    payload = build_output(decisions, metrics, cfg, run_date=date(2026, 5, 4),
                           data_period="YTD October 2025")
    adapter.write_decisions(payload)
    adapter.write_decisions(payload)  # Second run for same date
    assert len(adapter.fetch_decisions(date(2026, 5, 4))) == 23


def test_engine_runs_against_postgres_data(adapter: PostgresAdapter, fixture_rows: list) -> None:
    """End-to-end: stash data in PG, read it back, run pipeline, verify Macrou alert."""
    cfg = load_config(REPO_ROOT / "config.yaml")
    snap = date(2025, 10, 31)
    adapter.insert_categories(snap, fixture_rows)

    rows_from_pg = adapter.load_categories(snap)
    overrides = adapter.load_overrides()
    metrics, decisions = run_pipeline(rows_from_pg, cfg, period_months=10, overrides=overrides)

    by_cat = {d.id: d for d in decisions}
    assert by_cat["Macrou"].flag == "ANCHOR_ALERT"
    assert by_cat["SUC"].flag == "SCALE"
    assert by_cat["Calamar"].flag == "ELIMINATE"
