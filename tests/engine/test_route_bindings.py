"""ROUTE-BINDING GATE — every mutating route in the REAL app parses its body.

The defect class (hit twice in production, 2026-09-04): a Pydantic request
model defined INSIDE a router factory in a module that runs under
``from __future__ import annotations``. The handler's annotation is then a
string FastAPI cannot resolve from module globals, so the body parameter is
treated as a required QUERY param: every real request is answered 422 with
``loc == ["query", <param>]`` — and the Playwright specs, which intercept
those routes, never notice. Instances: ``ToolCall`` (Capsule tools, every
grounded tool call), ``ContactSalesRequest`` (every contact-sales form).

Two checks, both over the real ``create_app()``:
  1. dynamic — send a JSON body to every POST/PUT/PATCH route; no 422 may
     locate a ``missing`` field under ``query`` (the shape above);
  2. static — no ``class X(BaseModel)`` nested inside a function in any
     ``src/engine/api/*.py`` module that uses ``from __future__``.

PLANT (TC-2): nest ``ContactSalesRequest`` back inside ``build_router`` in
``_billing.py``. RED: both tests fail, the first naming the route. REVERT.

Hermetic: no network (the app is created with the test-manifest Supabase
URL and boot verification skipped); nothing is written.
"""
from __future__ import annotations

import ast
import os
import re
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]
API_DIR = REPO / "src" / "engine" / "api"
UUID = "00000000-0000-0000-0000-000000000001"


@pytest.fixture(scope="module")
def app(monkeypatch_module=None):
    os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    os.environ["CFO_AI_SKIP_BOOT_VERIFY"] = "1"
    assert "supabase.co" in os.environ["VITE_SUPABASE_URL"] and "test." in os.environ["VITE_SUPABASE_URL"], (
        "refusing to build the app against a non-manifest Supabase URL")
    from engine.api.server import create_app
    return create_app()


def _mutating_routes(app):
    out = []
    for r in app.routes:
        if isinstance(r, APIRoute):
            for m in sorted(r.methods or []):
                if m in ("POST", "PUT", "PATCH"):
                    out.append((m, r.path))
    return out


def test_no_mutating_route_demands_its_body_as_a_query_param(app):
    client = TestClient(app)
    routes = _mutating_routes(app)
    assert len(routes) >= 40, "ROUTE-BINDING VACUOUS — only %d mutating routes discovered" % len(routes)
    offenders = []
    for m, path in routes:
        url = re.sub(r"\{[^}]+\}", UUID, path)
        try:
            resp = client.request(m, url, json={"args": {}}, headers={"X-Org-Id": UUID})
        except Exception:
            continue  # a handler that raises on a dummy body is a different failure, not a binding one
        if resp.status_code != 422:
            continue
        try:
            detail = resp.json().get("detail") or []
        except Exception:
            continue
        for d in detail:
            loc = list(d.get("loc") or [])
            if loc[:1] == ["query"] and d.get("type") == "missing":
                offenders.append("%s %s  loc=%s" % (m, path, loc))
    assert not offenders, (
        "ROUTE-BINDING VIOLATED — %d route(s) demand their BODY as a QUERY param "
        "(closure-local Pydantic model under `from __future__ import annotations`):\n  %s"
        % (len(offenders), "\n  ".join(offenders)))
    print("[route-binding] %d mutating routes probed, 0 body-as-query" % len(routes))


def test_no_request_model_is_nested_inside_a_function_under_future_annotations():
    offenders = []
    scanned = 0
    for path in sorted(API_DIR.glob("*.py")):
        src = path.read_text(encoding="utf-8")
        if "from __future__ import annotations" not in src:
            continue
        scanned += 1
        tree = ast.parse(src)
        for fn in [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
            for node in ast.walk(fn):
                if isinstance(node, ast.ClassDef) and any(
                    (isinstance(b, ast.Name) and b.id == "BaseModel")
                    or (isinstance(b, ast.Attribute) and b.attr == "BaseModel") for b in node.bases
                ):
                    offenders.append("%s:%d %s (inside %s)" % (path.name, node.lineno, node.name, fn.name))
    assert scanned >= 5, "ROUTE-BINDING VACUOUS — scanned only %d future-annotations modules" % scanned
    assert not offenders, (
        "ROUTE-BINDING VIOLATED — Pydantic model(s) nested inside a function under "
        "`from __future__ import annotations` (unresolvable forward ref):\n  %s" % "\n  ".join(offenders))


def test_the_full_openapi_schema_generates(app):
    """Every forward ref in every route — request models AND return
    annotations — resolves. ``/openapi.json`` (and therefore ``/docs``) had
    500'd since the contact-sales model was nested (CLAUDE.md §16) and, after
    that was fixed, on a ``-> JSONResponse`` whose import was closure-local
    (public_market/search.py)."""
    schema = app.openapi()
    n = len(schema.get("paths") or {})
    assert n >= 100, "ROUTE-BINDING VACUOUS — openapi listed only %d paths" % n
    print("[route-binding] openapi paths: %d" % n)
