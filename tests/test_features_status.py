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
    # LAUNCH CUT (2026-09-05). This list previously named only the three
    # build-flag mirrors. It now also names every row the launch cut
    # switched off — `benchmarks`, `products_legacy`, `reports`,
    # `inventory`, `invoices` were `active`/`coming_soon` before the cut,
    # and the two lists above were updated in the same pass so this file
    # states the posture AFTER the cut rather than pinning the one before
    # it. What this test reds on: a row silently promoted back to
    # `active`/`coming_soon` without its screen being walked end-to-end.
    for k in (
        "decisions",
        "alerts",
        "public_records",
        "benchmarks",
        "products_legacy",
        "reports",
        "inventory",
        "invoices",
        "scenarios",
        "variance",
        "public_companies",
        "comprehensive_report",
        "peer_report",
        "chat_page",
        "roadmap",
        "firm_cockpit",
        "anomaly_radar",
    ):
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


# ──────────────────────────────────────────────────────────────────────
# LR4 — the registry mirror gate (2026-09-05)
# ──────────────────────────────────────────────────────────────────────

def test_registry_keys_mirror_the_frontend_union():
    """`_features.py`'s FEATURES dict and `frontend/lib/features.ts`'s
    `FeatureKey` union are two hand-maintained halves of ONE contract.

    Before this gate the only symptom of a drifted half was silent: an
    unknown key reads `undefined` in `useFeatures()`, and every consumer
    treats `undefined` exactly like `hidden` — so a key added backend-only
    renders nothing, and a key added frontend-only gates a route shut
    forever. Neither throws, neither logs.

    What this test reds on: a key present in one half and absent in the
    other, naming the side that is missing it.
    """
    import os
    import re

    root = os.path.join(os.path.dirname(__file__), "..")
    ts_path = os.path.join(root, "frontend", "lib", "features.ts")
    with open(ts_path, encoding="utf-8") as fh:
        ts = fh.read()

    # Strip `//` line comments FIRST. The union carries explanatory
    # comments between its members, and a comment is free to contain a
    # semicolon — which silently truncated an earlier version of this
    # scan mid-union, so the gate compared half a list and passed.
    uncommented = re.sub(r"//[^\n]*", "", ts)
    # The union runs from `export type FeatureKey =` to the terminating `;`.
    m = re.search(r"export type FeatureKey\s*=(.*?);", uncommented, re.S)
    assert m, "FeatureKey union not found in frontend/lib/features.ts"
    ts_keys = set(re.findall(r'"([a-z0-9_]+)"', m.group(1)))
    assert len(ts_keys) >= 25, (
        "the FeatureKey union scan found only "
        f"{len(ts_keys)} keys — the scan itself is broken, not the mirror"
    )

    _ensure_env_stubs()
    from engine.api._features import FEATURES  # noqa: WPS433

    py_keys = set(FEATURES)

    missing_in_ts = sorted(py_keys - ts_keys)
    missing_in_py = sorted(ts_keys - py_keys)
    assert not missing_in_ts, (
        "keys in _features.py but NOT in the frontend FeatureKey union "
        f"(the frontend can never read them): {missing_in_ts}"
    )
    assert not missing_in_py, (
        "keys in the frontend FeatureKey union but NOT in _features.py "
        f"(they resolve to undefined, i.e. permanently hidden): {missing_in_py}"
    )
