"""plan-meter-routes — a user cannot move their own document meter.

INCIDENT (measured 2026-10-03 by an adversarial review, on the real router and
the real meter RPCs of a local stack): ``POST /api/plan/release-document-reservation``
took the CALLER's own bearer and released the caller's own reservation. A
signed-in account on a one-document plan reserved, released with its own
token, reserved again: four documents in flight, four counted, cap 1.
``POST /api/plan/commit-document-usage`` moved the same meter the other way.
No screen calls either route.

LAW. Both routes are the operator's: the engine bearer (``ENGINE_API_TOKEN``),
failing closed (503) where it is not configured, and the account NAMED in the
request — never taken from a token. Without the operator bearer the meter
functions are not called at all (a recorder stands where the RPC would be, so
"refused" means "nothing moved", not "the answer said no").

What it cannot see: a new route that moves a meter with a user's token
(the route census in test_identity_wall.py classifies every mutating route;
this file holds these two).
Plant log: docs/engine_book/gates.md, "plan-meter-routes".
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.api import _pricing_routes, _usage_gate

OPERATOR_TOKEN = "plan-meter-operator-0123456789"
ACCOUNT = "0b6f1c1e-0000-4000-8000-00000000a001"
ROUTES = ("/api/plan/release-document-reservation", "/api/plan/commit-document-usage")

#: A token shaped like a signed-in user's (three base64url parts). It is not
#: the operator's bearer, and that is all the routes look at now.
USER_SHAPED = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIwYjZmMWMxZSJ9.c2lnbmF0dXJl"


@pytest.fixture()
def world(monkeypatch):
    moved = []
    monkeypatch.setattr(_usage_gate, "release_document",
                        lambda uid, *, was_extra, month=None: moved.append(("release", uid, was_extra)))
    monkeypatch.setattr(_usage_gate, "commit_document",
                        lambda uid, *, was_extra, month=None: moved.append(("commit", uid, was_extra)))
    monkeypatch.setenv("ENGINE_API_TOKEN", OPERATOR_TOKEN)
    app = FastAPI()
    app.include_router(_pricing_routes.build_router())
    return TestClient(app, raise_server_exceptions=False), moved


NOT_THE_OPERATOR = [
    pytest.param({}, id="no bearer"),
    pytest.param({"Authorization": "Bearer " + USER_SHAPED}, id="a user's token"),
    pytest.param({"Authorization": "Bearer " + OPERATOR_TOKEN[:-1]}, id="a prefix of the operator token"),
    pytest.param({"Authorization": "Bearer " + OPERATOR_TOKEN + "x"}, id="the operator token plus a byte"),
    pytest.param({"Authorization": "Basic " + OPERATOR_TOKEN}, id="the token under another scheme"),
    pytest.param({"X-Engine-Token": OPERATOR_TOKEN}, id="the token in another header"),
]


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("headers", NOT_THE_OPERATOR)
def test_without_the_operator_bearer_the_meter_does_not_move(world, route, headers):
    client, moved = world
    r = client.post(route, params={"user_id": ACCOUNT}, headers=headers)
    assert r.status_code == 401, (route, r.status_code, r.text[:200])
    assert moved == [], "refused, and yet the meter function was called: %s" % moved


@pytest.mark.parametrize("route", ROUTES)
def test_the_token_in_the_query_string_is_not_the_bearer(world, route):
    client, moved = world
    r = client.post(route, params={"user_id": ACCOUNT, "token": OPERATOR_TOKEN,
                                   "authorization": "Bearer " + OPERATOR_TOKEN})
    assert r.status_code == 401 and moved == []


@pytest.mark.parametrize("route", ROUTES)
def test_the_wall_answers_before_any_validation(world, route):
    """No account named, no bearer: the answer is the wall's 401, not a 422
    that would tell an anonymous caller what the route expects."""
    client, moved = world
    assert client.post(route).status_code == 401
    assert client.post(route, params={"user_id": "not-a-uuid"},
                       headers={"Authorization": "Bearer " + USER_SHAPED}).status_code == 401
    assert moved == []


def test_the_incident_a_user_cannot_release_their_own_reservation(world):
    """The loop that gave four documents on a one-document plan: the release
    step, with the user's own token and the user's own id, is refused."""
    client, moved = world
    for _ in range(4):
        r = client.post("/api/plan/release-document-reservation",
                        params={"user_id": ACCOUNT},
                        headers={"Authorization": "Bearer " + USER_SHAPED})
        assert r.status_code == 401
    assert moved == []


def test_the_operator_releases_and_commits_for_the_account_it_names(world):
    client, moved = world
    op = {"Authorization": "Bearer " + OPERATOR_TOKEN}
    r = client.post("/api/plan/release-document-reservation", params={"user_id": ACCOUNT}, headers=op)
    assert r.status_code == 200 and r.json() == {"ok": True, "scope": "operator", "user_id": ACCOUNT}
    r = client.post("/api/plan/commit-document-usage",
                    params={"user_id": ACCOUNT, "was_extra": "true"}, headers=op)
    assert r.status_code == 200
    assert moved == [("release", ACCOUNT, False), ("commit", ACCOUNT, True)]


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("params", [{}, {"user_id": ""}, {"user_id": "me"}, {"user_id": "1 or 1=1"}],
                         ids=["no account", "empty", "not a uuid", "not a uuid either"])
def test_the_operator_must_name_an_account(world, route, params):
    client, moved = world
    r = client.post(route, params=params, headers={"Authorization": "Bearer " + OPERATOR_TOKEN})
    assert r.status_code == 422, (params, r.status_code)
    assert moved == []


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("unset", ["absent", "empty", "blank"])
def test_where_no_operator_token_is_configured_the_routes_refuse(monkeypatch, world, route, unset):
    client, moved = world
    if unset == "absent":
        monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    else:
        monkeypatch.setenv("ENGINE_API_TOKEN", "" if unset == "empty" else "   ")
    for headers in ({}, {"Authorization": "Bearer "}, {"Authorization": "Bearer " + OPERATOR_TOKEN},
                    {"Authorization": "Bearer " + USER_SHAPED}):
        r = client.post(route, params={"user_id": ACCOUNT}, headers=headers)
        assert r.status_code in (401, 503), (unset, headers, r.status_code)
        assert r.status_code != 200
    assert moved == []


def test_neither_route_reads_a_user_token_any_more():
    """The source says so: no `_require_jwt` / `_user_id_from_jwt` inside the
    two handlers — the account comes from the operator's request."""
    import inspect
    src = inspect.getsource(_pricing_routes.build_router)
    start = src.index('@router.post("/api/plan/commit-document-usage")')
    tail = src[start:]
    assert tail.count("require_operator(request") == 2
    assert "_require_jwt" not in tail and "_user_id_from_jwt" not in tail
