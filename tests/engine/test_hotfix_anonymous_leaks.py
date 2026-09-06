"""STREAM 1 — two anonymous leaks measured live on 2026-09-05, closed here.

Both were found on ``https://cfo-ai.io`` with a bare ``curl``, no bearer:

  GET /api/sessions      -> 200 {"count":1,"sessions":[{"name":"alex 3",
                            "ip":"82.76.35.223","user_agent":"Mozilla/5.0 …",
                            "first_seen":…,"visit_count":33}]}
  GET /api/public/health -> 200 {"key_tag":"key=ttAK…",
                            "daily_budget_remaining":3997, …}

The first published a real person's name, IP address, device fingerprint and
visit history to anyone who asked — personal data under GDPR Art. 4(1), and
an IP address explicitly so (Breyer, C-582/14). The second published a live
credential prefix and a quota counter.

WHAT EACH TEST FAILS ON AFTER THE REPAIR (TC-11)
  · ``test_listing_sessions_without_the_operator_bearer_is_refused`` reds if
    the route is ever made anonymous again, or if a *user* bearer is enough
    (it must not be: session_log has no user column, so "only mine" cannot
    be told truthfully — see the docstring on the route).
  · ``test_the_operator_can_still_read_the_session_log`` is the non-vacuity
    half: it reds if the route is walled so hard that the operator
    diagnostic dies too, which would make the first test pass for the wrong
    reason.
  · ``test_the_public_health_payload_carries_no_credential_or_quota`` reds if
    any key material or budget counter returns to the anonymous body, under
    whatever name — it asserts over the VALUES, not a field allowlist, so
    renaming ``key_tag`` does not evade it.
  · ``test_the_session_ip_is_the_rightmost_forwarded_hop`` reds if the
    recorded address goes back to ``hops[0]``, which the caller writes.

The hop test is the same defect CLAUDE.md §21 repaired in ``ratelimit``,
``funnel`` and ``refresh_shield`` on 2026-09-04. This module was never
swept, so the address it published could also be forged — a poisoned value
served as fact.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
os.environ["CFO_AI_SKIP_BOOT_VERIFY"] = "1"
assert "test." in os.environ["VITE_SUPABASE_URL"], "refusing a non-manifest Supabase URL"

OPERATOR_TOKEN = "stream1-operator-token-0123456789"

#: The row the live site was handing out, shape-for-shape.
LEAKED_ROW = {
    "id": 1,
    "name": "alex 3",
    "ip": "82.76.35.223",
    "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "first_seen": "2026-05-18T19:14:46.764000",
    "last_seen": "2026-05-19T11:26:29.059333",
    "visit_count": 33,
}


class _StubAdapter(object):
    """Records what the route asked for; returns the leaked row verbatim."""

    def __init__(self) -> None:
        self.upserts: List[Dict[str, Any]] = []

    def list_sessions(self, limit: int = 50) -> List[Dict[str, Any]]:
        return [dict(LEAKED_ROW)]

    def upsert_session(self, name: str, ip: Optional[str],
                       user_agent: str) -> Dict[str, Any]:
        self.upserts.append({"name": name, "ip": ip, "user_agent": user_agent})
        return dict(LEAKED_ROW, name=name, ip=ip)


@pytest.fixture(scope="module")
def client_and_adapter():
    os.environ["ENGINE_API_TOKEN"] = OPERATOR_TOKEN
    from engine.api.server import create_app

    app = create_app()
    adapter = _StubAdapter()
    app.state.adapter = adapter
    # The routes close over the adapter built in create_app(); re-point the
    # closure's cell so the stub is what answers.
    for route in app.routes:
        fn = getattr(route, "endpoint", None)
        closure = getattr(fn, "__closure__", None) or ()
        for cell in closure:
            try:
                current = cell.cell_contents
            except ValueError:
                continue
            if current.__class__.__name__ == "PostgresAdapter":
                cell.cell_contents = adapter  # type: ignore[misc]
    return TestClient(app, raise_server_exceptions=False), adapter


# ── GET /api/sessions ────────────────────────────────────────────────────

@pytest.mark.parametrize("headers", [
    pytest.param({}, id="no-bearer"),
    pytest.param({"Authorization": "Bearer not-the-operator-token"}, id="wrong-bearer"),
    pytest.param({"Authorization": "Bearer "}, id="empty-bearer"),
    pytest.param({"Authorization": OPERATOR_TOKEN}, id="token-without-scheme"),
])
def test_listing_sessions_without_the_operator_bearer_is_refused(
        client_and_adapter, headers):
    client, _ = client_and_adapter
    r = client.get("/api/sessions", headers=headers)
    assert r.status_code in (401, 403), (
        "GET /api/sessions answered %d to %r — this route published a real "
        "visitor's name, IP address, user agent and visit history to anyone "
        "who asked. Body: %s" % (r.status_code, headers, r.text[:400]))
    body = r.text
    for leaked in (LEAKED_ROW["ip"], LEAKED_ROW["name"], LEAKED_ROW["user_agent"][:20]):
        assert leaked not in body, (
            "the refusal body still carries %r" % (leaked,))


def test_the_operator_can_still_read_the_session_log(client_and_adapter):
    """Non-vacuity: the wall must not have killed the diagnostic itself."""
    client, _ = client_and_adapter
    r = client.get("/api/sessions",
                   headers={"Authorization": "Bearer " + OPERATOR_TOKEN})
    assert r.status_code == 200, r.text[:400]
    assert r.json()["sessions"][0]["ip"] == LEAKED_ROW["ip"]


# ── the forwarded hop ────────────────────────────────────────────────────

def test_the_session_ip_is_the_rightmost_forwarded_hop(client_and_adapter):
    """§21: Caddy APPENDS, so index 0 is attacker-written.

    One trusted hop runs today (`via: 1.1 Caddy`, DNS straight at the VPS),
    so the rightmost entry is the address Caddy itself observed.
    """
    client, adapter = client_and_adapter
    before = len(adapter.upserts)
    r = client.post(
        "/api/sessions/track",
        json={"name": "hop probe"},
        headers={"X-Forwarded-For": "1.1.1.1, 2.2.2.2, 9.9.9.9"},
    )
    assert r.status_code == 200, r.text[:300]
    assert len(adapter.upserts) == before + 1
    recorded = adapter.upserts[-1]["ip"]
    assert recorded == "9.9.9.9", (
        "recorded %r — a caller who writes their own X-Forwarded-For chooses "
        "the address this endpoint stores, and it used to be served publicly"
        % (recorded,))


# ── GET /api/public/health ───────────────────────────────────────────────

def _forbidden_values(payload: Dict[str, Any]) -> List[str]:
    """Every credential-ish or quota-ish VALUE in the body, by value.

    Deliberately not a field allowlist: renaming `key_tag` must not evade
    this gate.
    """
    found = []
    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
        elif isinstance(node, str):
            if node.startswith("key=") and node != "key=unset":
                found.append(node)
        elif isinstance(node, int) and not isinstance(node, bool):
            # a raw remaining-budget counter (the live value was 3997)
            if node > 100:
                found.append(str(node))
    walk(payload)
    return found


@pytest.mark.parametrize("path", ["/api/public/health", "/api/public/status"])
def test_the_public_health_payload_carries_no_credential_or_quota(
        client_and_adapter, path):
    client, _ = client_and_adapter
    r = client.get(path)
    if r.status_code == 404:
        pytest.skip("public surface unmounted here; the anonymous body is the subject")
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    leaked = _forbidden_values(body)
    assert not leaked, (
        "%s answers anonymously with credential/quota material %r — live on "
        "2026-09-05 this was {\"key_tag\":\"key=ttAK…\","
        "\"daily_budget_remaining\":3997}. Body: %s" % (path, leaked, body))
    assert "key_configured" in body, (
        "the frontend needs the boolean; only the tag and the counter go")


@pytest.mark.parametrize("path", ["/api/public/health", "/api/public/status"])
def test_the_operator_still_sees_the_key_tag_and_the_budget(
        client_and_adapter, path):
    """Non-vacuity: the detail moves behind the bearer, it does not vanish."""
    client, _ = client_and_adapter
    r = client.get(path, headers={"Authorization": "Bearer " + OPERATOR_TOKEN})
    if r.status_code == 404:
        pytest.skip("public surface unmounted here")
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert "key_tag" in body and "daily_budget_remaining" in body, body
