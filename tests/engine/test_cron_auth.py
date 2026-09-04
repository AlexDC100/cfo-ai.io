"""Scheduler-only routes FAIL CLOSED without ENGINE_API_TOKEN.

Found 2026-09-04 by sweeping every mutating route of the real app for an
unauthenticated 2xx: POST /api/billing/cron/renewal-reminders ran OPEN when
ENGINE_API_TOKEN was unset (its own docstring said so), and the token is
unset in production — an anonymous POST could mass-send renewal e-mails.
/api/workspaces/cron/purge-expired already failed closed; now both do, and
so do the firm crons.

PLANT (TC-2): restore `if token:` around the check in _billing.py. RED: the
first test fails naming the route. REVERT.
"""
from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

CRONS = [
    ("POST", "/api/billing/cron/renewal-reminders"),
    ("POST", "/api/workspaces/cron/purge-expired"),
    ("POST", "/api/firm/requests/cron/nudge"),
    ("POST", "/api/firm/digest/cron/run"),
]


@pytest.fixture(scope="module")
def client():
    os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    os.environ["CFO_AI_SKIP_BOOT_VERIFY"] = "1"
    assert "test." in os.environ["VITE_SUPABASE_URL"], "refusing a non-manifest Supabase URL"
    from engine.api.server import create_app
    return TestClient(create_app())


@pytest.mark.parametrize("method,path", CRONS)
def test_cron_without_a_configured_token_is_503_never_run(client, monkeypatch, method, path):
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    # A cron that runs open reaches for the database before answering; in
    # this hermetic process that surfaces as an exception, not a status.
    # Either way the claim is the same: the handler DID WORK without a token.
    try:
        r = client.request(method, path)
        outcome = "answered %s: %s" % (r.status_code, r.text[:160])
        ok = r.status_code == 503
    except Exception as exc:  # noqa: BLE001 — the point is that it ran
        outcome = "ran and raised %s (it reached for the database)" % type(exc).__name__
        ok = False
    assert ok, (
        "CRON RUNS OPEN — %s %s %s with ENGINE_API_TOKEN unset "
        "(an anonymous caller can trigger it)" % (method, path, outcome))


@pytest.mark.parametrize("method,path", CRONS)
def test_cron_with_a_wrong_bearer_is_refused(client, monkeypatch, method, path):
    monkeypatch.setenv("ENGINE_API_TOKEN", "the-real-scheduler-token")
    r = client.request(method, path, headers={"Authorization": "Bearer not-it"})
    assert r.status_code in (401, 403), (method, path, r.status_code, r.text[:160])
    r = client.request(method, path)
    assert r.status_code in (401, 403), ("no bearer", method, path, r.status_code)
