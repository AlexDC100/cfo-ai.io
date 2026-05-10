"""FastAPI service tests via TestClient.

Each test builds a fresh app with an in-memory sqlite, seeds the adapter
directly, then hits the HTTP surface.
"""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from engine.api import create_app
from engine.loader import load_categories_from_csv

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def app_no_auth():
    """App with auth disabled (no ENGINE_API_TOKEN env var)."""
    os.environ.pop("ENGINE_API_TOKEN", None)
    return create_app(config_path=REPO_ROOT / "config.yaml")


@pytest.fixture
def seeded_app(app_no_auth):
    """App with the fixture rows seeded at snapshot date 2025-10-31."""
    rows = load_categories_from_csv(REPO_ROOT / "data" / "validation_fixture_categories.csv")
    app_no_auth.state.adapter.insert_categories(date(2025, 10, 31), rows)
    return app_no_auth


def test_health_endpoint(app_no_auth) -> None:
    client = TestClient(app_no_auth)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "version" in body


def test_run_daily_returns_decisions(seeded_app) -> None:
    client = TestClient(seeded_app)
    r = client.post("/run-daily", json={
        "run_date": "2026-05-04",
        "snapshot_date": "2025-10-31",
        "period_months": 10,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["total_categories_analyzed"] == 23
    assert body["summary"]["anchors_with_alerts"] == 1
    assert len(body["anchor_alerts"]) == 1
    assert body["anchor_alerts"][0]["id"] == "Macrou"
    # Niche-margin protection (rules.py) reclassified Pastrav and Plachie
    # from ELIMINATE to KEEP. Calamar remains the only elimination.
    assert len(body["eliminate"]) == 1
    assert len(body["warning"]) == 4


def test_run_daily_404_when_no_snapshot(app_no_auth) -> None:
    """Empty PG → 404 with a useful message."""
    client = TestClient(app_no_auth)
    r = client.post("/run-daily", json={"run_date": "2026-05-04"})
    assert r.status_code == 404
    assert "No category snapshot" in r.json()["detail"]


def test_run_daily_writes_to_storage(seeded_app) -> None:
    """After /run-daily, /decisions/{date} returns the same set."""
    client = TestClient(seeded_app)
    client.post("/run-daily", json={
        "run_date": "2026-05-04",
        "snapshot_date": "2025-10-31",
        "period_months": 10,
    })
    r = client.get("/decisions/2026-05-04")
    assert r.status_code == 200
    decisions = r.json()
    assert len(decisions) == 23
    macrou = next(d for d in decisions if d["category"] == "Macrou")
    assert macrou["flag"] == "ANCHOR_ALERT"


def test_run_daily_dry_run_skips_write(seeded_app) -> None:
    client = TestClient(seeded_app)
    client.post("/run-daily", json={
        "run_date": "2026-05-04",
        "snapshot_date": "2025-10-31",
        "period_months": 10,
        "dry_run": True,
    })
    r = client.get("/decisions/2026-05-04")
    assert r.status_code == 404  # nothing was written


def test_get_decisions_404_when_missing(app_no_auth) -> None:
    client = TestClient(app_no_auth)
    r = client.get("/decisions/2026-01-01")
    assert r.status_code == 404


def test_auth_required_when_token_set(monkeypatch) -> None:
    monkeypatch.setenv("ENGINE_API_TOKEN", "shh-secret")
    app = create_app(config_path=REPO_ROOT / "config.yaml")
    rows = load_categories_from_csv(REPO_ROOT / "data" / "validation_fixture_categories.csv")
    app.state.adapter.insert_categories(date(2025, 10, 31), rows)

    client = TestClient(app)
    # No auth header → 401
    r = client.post("/run-daily", json={"run_date": "2026-05-04",
                                         "snapshot_date": "2025-10-31"})
    assert r.status_code == 401
    # Wrong token → 401
    r = client.post("/run-daily", json={"run_date": "2026-05-04",
                                         "snapshot_date": "2025-10-31"},
                    headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401
    # Right token → 200
    r = client.post("/run-daily", json={"run_date": "2026-05-04",
                                         "snapshot_date": "2025-10-31"},
                    headers={"Authorization": "Bearer shh-secret"})
    assert r.status_code == 200
