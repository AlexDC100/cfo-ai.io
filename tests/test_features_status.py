"""Phase 9 backend test — feature registry endpoint.

Guards the contract the frontend depends on:
  · GET /api/features/status returns 200
  · Response shape: { "features": { <key>: { status, label, description } } }
  · Calibration keys land in the statuses the cleanup brief specifies
    (active for the upload trio + ask_cfo_ai + change_password;
     coming_soon for ERP / 2FA / simulate-*;
     hidden for decisions / alerts / public_records).
  · Active features advertise an `endpoint` field (no active row in the
    UI without a real route behind it).
"""

from __future__ import annotations

import os
import sys


def _ensure_env_stubs() -> None:
    """Supabase config is read at import time on some paths — stub the
    env so importing server.py doesn't blow up in tests that don't
    touch the DB."""
    os.environ.setdefault("VITE_SUPABASE_URL", "http://stub")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "stub")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


def _client():
    _ensure_env_stubs()
    from fastapi.testclient import TestClient  # noqa: WPS433
    from engine.api import server  # noqa: WPS433
    return TestClient(server.create_app())


def test_features_status_returns_200_with_features_dict():
    resp = _client().get("/api/features/status")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, dict)
    assert "features" in body
    assert isinstance(body["features"], dict)
    # Cleanup brief expects 25+ feature entries. 30 is the headroom we
    # have today; if the count drops below 25, something was deleted
    # that shouldn't have been.
    assert len(body["features"]) >= 25


def test_active_features_present():
    body = _client().get("/api/features/status").json()
    feats = body["features"]
    for k in (
        "upload_trial_balance",
        "upload_financial_statement",
        "ask_cfo_ai",
        "change_password",
        "manage_billing",
        "industry_classification",
        "benchmarks",
        "dashboard",
        "generate_action_list",
        "generate_board_summary",
    ):
        assert feats.get(k, {}).get("status") == "active", (
            f"expected '{k}' to be active, got {feats.get(k, {}).get('status')!r}"
        )


def test_coming_soon_features_present():
    body = _client().get("/api/features/status").json()
    feats = body["features"]
    for k in (
        "erp_connector",
        "accounting_connector",
        "two_factor_auth",
        "simulate_cost_of_capital",
        "simulate_debt_reduction",
        "inventory",
        "invoices",
        "import_history",
    ):
        assert feats.get(k, {}).get("status") == "coming_soon", (
            f"expected '{k}' to be coming_soon, got {feats.get(k, {}).get('status')!r}"
        )


def test_hidden_features_present():
    """Hidden features stay in the registry (so backend introspection
    works) but the frontend filters them out."""
    body = _client().get("/api/features/status").json()
    feats = body["features"]
    for k in ("decisions", "alerts", "public_records"):
        assert feats.get(k, {}).get("status") == "hidden", (
            f"expected '{k}' to be hidden, got {feats.get(k, {}).get('status')!r}"
        )


def test_every_active_feature_advertises_endpoint_or_is_meta():
    """Every `active` feature should either expose an `endpoint`, OR be
    one of the "this is itself a UI surface" keys (dashboard, reports,
    industry_classification — those are container surfaces, not single
    endpoints). The whitelist below is intentionally tight so a future
    PR that promotes a feature to active without wiring a real route
    fails this test.
    """
    body = _client().get("/api/features/status").json()
    feats = body["features"]
    NO_ENDPOINT_REQUIRED = {
        "ask_about_current_company",
        "change_password",
        "manage_profile",
        "reports",
        # products_legacy has a backend endpoint via /api/cfo/products,
        # so it should advertise one. (Verified by the loop, not exempt.)
    }
    for key, defn in feats.items():
        if defn.get("status") != "active":
            continue
        if key in NO_ENDPOINT_REQUIRED:
            continue
        assert defn.get("endpoint"), (
            f"active feature '{key}' must advertise an endpoint or be in "
            f"NO_ENDPOINT_REQUIRED; got: {defn!r}"
        )
