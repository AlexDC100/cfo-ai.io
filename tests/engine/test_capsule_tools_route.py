"""The Capsule tools route ACCEPTS a JSON body.

Regression gate for a live-path defect: ``ToolCall`` was a closure-local
Pydantic model inside ``build_router`` while the module runs under
``from __future__ import annotations``, so FastAPI saw the annotation as
an unresolvable string and demanded ``body`` as a QUERY parameter — every
real request from ``capsuleToolsApi.ts`` was answered 422 with
``loc == ["query", "body"]``. The e2e specs intercept the route, which is
how it stayed green.

PLANT (TC-2): move ``ToolCall`` back inside ``build_router``. RED: the
first test fails with the exact 422 shape below. REVERT: green.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.api import _capsule_tools as CT


def _client():
    application = FastAPI()
    application.include_router(CT.build_router())
    return TestClient(application)


def test_tools_route_reads_the_body_and_reaches_auth_not_422():
    # The claim is "the body is parsed and the handler RUNS". Authentication
    # is the first thing the handler does and a MISSING bearer is refused
    # before any Supabase call — so a 401/403 on a valid body with no
    # Authorization header is the proof, and needs no environment.
    r = _client().post(
        "/api/capsule/tools/get_facts",
        headers={"X-Org-Id": "00000000-0000-0000-0000-000000000001"},
        json={"args": {"metric": "total_assets"}},
    )
    assert r.status_code != 422, (
        "CAPSULE TOOLS ROUTE REJECTS EVERY BODY — 422 %s. ToolCall must be a "
        "MODULE-scope model (forward-ref under `from __future__ import "
        "annotations`)." % r.text[:200]
    )
    # Body was parsed; the request got as far as authentication.
    assert r.status_code in (401, 403), r.text[:200]


def test_tool_call_model_is_module_scope():
    assert hasattr(CT, "ToolCall"), "ToolCall is not at module scope"
    assert CT.ToolCall.__module__ == CT.__name__


def test_a_malformed_body_is_still_a_422_on_the_body_not_the_query():
    r = _client().post(
        "/api/capsule/tools/get_facts",
        headers={"Authorization": "Bearer x"},
        json={"args": "not-a-dict"},
    )
    assert r.status_code == 422, r.text[:200]
    locs = [tuple(d.get("loc", ())) for d in r.json()["detail"]]
    assert all(loc and loc[0] == "body" for loc in locs), locs
