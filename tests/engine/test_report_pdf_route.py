"""G-P4 — the engine's door to the PDF renderer.

``src/engine/api/_report_pdf.py`` stands between a signed-in browser and
``cfo-ai-pdf``, the Node sidecar that runs headless Chromium.  The
sidecar sits on the internal compose network only, so this module is the
ONLY authenticated way to reach it, and everything it gets wrong is a
production defect of a familiar kind:

  · a Pydantic model that binds as a QUERY parameter instead of a body —
    the exact shape that shipped twice (Capsule tools, contact-sales) and
    answered 422 ``loc: [query, body]`` to every real request
    (CLAUDE.md §22);
  · a route that renders for anyone when its shared secret is unset —
    the shape the renewal-reminder cron had;
  · a job one user can collect from another user's session.

WHAT THIS FILE REDS ON, once the module is correct (TC-11):
  · the body binding moving off ``[body, html]``;
  · the 503 becoming a 200 when ``PDF_SERVICE_TOKEN`` is unset;
  · a poll or a download succeeding without a bearer;
  · a poll or a download succeeding for a job the caller does not own;
  · the sidecar's own error text reaching the caller (it names internal
    hosts), or a sidecar outage being reported as a 500 rather than a
    502.

WHAT IT CANNOT SEE: the sidecar.  ``httpx`` is stubbed here, so this
proves the door, not the renderer.  The renderer is
``scripts/check_report_pdf.mjs``, which renders the real Agras book and
reads the produced PDF back.

Nothing here reaches a network.  Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

import ast
import json
import pathlib
from typing import Any, Dict, Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


USER_A = "11111111-1111-1111-1111-111111111111"
USER_B = "22222222-2222-2222-2222-222222222222"
JOB = "0f2f1a1e-0000-4000-8000-000000000001"


class _FakeResponse:
    def __init__(self, status_code: int, payload: Any, headers: Optional[Dict[str, str]] = None):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}
        self.text = str(payload)
        # JSON, not `str(dict)` — a double that answers a Python repr
        # would make the module's own `json.loads` the thing under test.
        self.content = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")

    def json(self) -> Any:
        return self._payload


class _FakeClient:
    """Stands in for ``httpx.Client``. Records what the module asked the
    sidecar for, so a test can assert the request as well as the answer."""

    calls: list = []

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def post(self, url, headers=None, json=None):  # noqa: A002
        _FakeClient.calls.append(("POST", url, headers, json))
        return _FakeResponse(200, {"jobId": JOB, "state": "queued", "progress": "Starting the renderer"})

    def get(self, url, headers=None):
        _FakeClient.calls.append(("GET", url, headers, None))
        if url.endswith("/pdf"):
            return _FakeResponse(
                200,
                b"%PDF-1.4 fake",
                {"content-disposition": 'attachment; filename="A_B_CFO_Report.pdf"'},
            )
        return _FakeResponse(
            200,
            {"state": "done", "progress": "Ready — 31 pages", "pages": 31,
             "bytes": 1276183, "filename": "A_B_CFO_Report.pdf", "error": None},
        )


def _app(monkeypatch, user_by_token: Dict[str, str]):
    from engine.api import _report_pdf

    _FakeClient.calls = []
    monkeypatch.setenv("PDF_SERVICE_TOKEN", "shared-secret")
    monkeypatch.setenv("PDF_SERVICE_URL", "http://cfo-ai-pdf:8081")
    monkeypatch.setattr(_report_pdf.httpx, "Client", _FakeClient)
    monkeypatch.setattr(
        _report_pdf, "_user_id", lambda authorization: _resolve(authorization, user_by_token)
    )
    _report_pdf._JOB_OWNER.clear()
    app = FastAPI()
    app.include_router(_report_pdf.build_router())
    return app


def _resolve(authorization, table):
    from fastapi import HTTPException

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    token = authorization.split(" ", 1)[1].strip()
    if token not in table:
        raise HTTPException(401, "Could not resolve user from JWT.")
    return table[token]


# ── §1 the binding ─────────────────────────────────────────────────────


def test_the_body_binds_as_a_body_and_not_as_a_query_parameter(monkeypatch):
    """The defect that shipped twice: a `BaseModel` under postponed
    annotations that FastAPI could not resolve, so it bound the argument
    as a query parameter and every real POST answered 422."""
    app = _app(monkeypatch, {"a": USER_A})
    spec = app.openapi()
    op = spec["paths"]["/api/report/pdf"]["post"]
    assert "requestBody" in op, "the route declares no request body"
    assert [p["in"] for p in op.get("parameters", [])] == ["header"], op.get("parameters")

    client = TestClient(app)
    res = client.post("/api/report/pdf", json={}, headers={"Authorization": "Bearer a"})
    assert res.status_code == 422
    assert [tuple(e["loc"]) for e in res.json()["detail"]] == [("body", "html")]


def test_the_request_model_is_declared_at_module_scope(monkeypatch):
    """A `BaseModel` nested inside `build_router()` in a module carrying
    `from __future__ import annotations` cannot have its forward
    reference resolved — that is the mechanism behind the binding defect
    above, and it is invisible until a real request arrives."""
    src = pathlib.Path("src/engine/api/_report_pdf.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    nested = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for inner in ast.walk(node):
            if isinstance(inner, ast.ClassDef) and any(
                isinstance(b, ast.Name) and b.id == "BaseModel" for b in inner.bases
            ):
                nested.append(f"{node.name}.{inner.name}")
    assert nested == [], f"BaseModel declared inside a function: {nested}"


# ── §2 fail closed ─────────────────────────────────────────────────────


def test_every_route_refuses_when_the_shared_secret_is_unset(monkeypatch):
    """An unauthenticated PDF renderer is a free CPU and memory
    amplifier for anything that can reach its network."""
    app = _app(monkeypatch, {"a": USER_A})
    monkeypatch.delenv("PDF_SERVICE_TOKEN", raising=False)
    client = TestClient(app)
    for method, url in [
        ("post", "/api/report/pdf"),
        ("get", f"/api/report/pdf/{JOB}"),
        ("get", f"/api/report/pdf/{JOB}/file"),
    ]:
        call = getattr(client, method)
        res = call(url, headers={"Authorization": "Bearer a"}, **({"json": {"html": "<p/>"}} if method == "post" else {}))
        assert res.status_code == 503, (url, res.status_code)
        assert "not configured" in res.json()["detail"]


def test_no_bearer_is_401_on_every_route(monkeypatch):
    app = _app(monkeypatch, {"a": USER_A})
    client = TestClient(app)
    assert client.post("/api/report/pdf", json={"html": "<p/>"}).status_code == 401
    assert client.get(f"/api/report/pdf/{JOB}").status_code == 401
    assert client.get(f"/api/report/pdf/{JOB}/file").status_code == 401


# ── §3 one user's render is not another's ──────────────────────────────


def test_a_second_user_cannot_poll_or_collect_the_first_users_render(monkeypatch):
    """The sidecar has no idea who anyone is — it answers any caller
    holding the shared secret. This module is the only thing that knows,
    and it answers 404 rather than 403 so a stranger does not even learn
    the job exists."""
    app = _app(monkeypatch, {"a": USER_A, "b": USER_B})
    client = TestClient(app)
    start = client.post(
        "/api/report/pdf",
        json={"html": "<p>x</p>", "company": "A", "period": "B"},
        headers={"Authorization": "Bearer a"},
    )
    assert start.status_code == 202, start.text
    job_id = start.json()["job_id"]

    assert client.get(f"/api/report/pdf/{job_id}", headers={"Authorization": "Bearer a"}).status_code == 200
    assert client.get(f"/api/report/pdf/{job_id}/file", headers={"Authorization": "Bearer a"}).status_code == 200

    for url in (f"/api/report/pdf/{job_id}", f"/api/report/pdf/{job_id}/file"):
        res = client.get(url, headers={"Authorization": "Bearer b"})
        assert res.status_code == 404, (url, res.status_code)
        assert "No such render job" in res.json()["detail"]


def test_the_owner_check_runs_before_the_sidecar_is_called(monkeypatch):
    """Otherwise a stranger polling a guessed job id still costs a
    round trip to the renderer for every guess."""
    app = _app(monkeypatch, {"b": USER_B})
    client = TestClient(app)
    _FakeClient.calls = []
    client.get(f"/api/report/pdf/{JOB}", headers={"Authorization": "Bearer b"})
    assert _FakeClient.calls == [], _FakeClient.calls


# ── §4 what the caller is told ─────────────────────────────────────────


def test_the_start_call_forwards_the_document_and_the_shared_secret(monkeypatch):
    app = _app(monkeypatch, {"a": USER_A})
    client = TestClient(app)
    client.post(
        "/api/report/pdf",
        json={"html": "<p>doc</p>", "company": "Agras", "period": "FY2025"},
        headers={"Authorization": "Bearer a"},
    )
    method, url, headers, body = _FakeClient.calls[0]
    assert (method, url) == ("POST", "http://cfo-ai-pdf:8081/render")
    assert headers["authorization"] == "Bearer shared-secret"
    assert body == {"html": "<p>doc</p>", "company": "Agras", "period": "FY2025"}


def test_the_filename_the_sidecar_chose_is_passed_through_untouched(monkeypatch):
    """Two derivations of one filename is how the header and the saved
    file come to disagree about the same download."""
    app = _app(monkeypatch, {"a": USER_A})
    client = TestClient(app)
    start = client.post(
        "/api/report/pdf", json={"html": "<p/>"}, headers={"Authorization": "Bearer a"}
    )
    res = client.get(
        f"/api/report/pdf/{start.json()['job_id']}/file",
        headers={"Authorization": "Bearer a"},
    )
    assert res.headers["content-disposition"] == 'attachment; filename="A_B_CFO_Report.pdf"'
    assert res.headers["content-type"] == "application/pdf"


def test_a_sidecar_outage_is_a_502_and_leaks_no_internal_detail(monkeypatch):
    """502, not 500: the engine is fine and its dependency is not, and an
    operator reading the status code should be sent to the right
    container. The upstream message is logged, never returned — it names
    internal hosts."""
    from engine.api import _report_pdf

    app = _app(monkeypatch, {"a": USER_A})

    class _Dead(_FakeClient):
        def post(self, url, headers=None, json=None):  # noqa: A002
            raise OSError("[Errno -2] Name or service not known: cfo-ai-pdf")

    monkeypatch.setattr(_report_pdf.httpx, "Client", _Dead)
    res = TestClient(app).post(
        "/api/report/pdf", json={"html": "<p/>"}, headers={"Authorization": "Bearer a"}
    )
    assert res.status_code == 502
    assert res.json()["detail"] == "The PDF renderer is not reachable."
    assert "cfo-ai-pdf" not in res.text


@pytest.mark.parametrize("upstream,expected", [(404, 404), (409, 409), (500, 502)])
def test_the_sidecars_status_is_mapped_not_forwarded(monkeypatch, upstream, expected):
    from engine.api import _report_pdf

    app = _app(monkeypatch, {"a": USER_A})
    client = TestClient(app)
    start = client.post(
        "/api/report/pdf", json={"html": "<p/>"}, headers={"Authorization": "Bearer a"}
    )
    job_id = start.json()["job_id"]

    class _Refusing(_FakeClient):
        def get(self, url, headers=None):
            return _FakeResponse(upstream, {"error": "internal host cfo-ai-pdf said no"})

    monkeypatch.setattr(_report_pdf.httpx, "Client", _Refusing)
    res = client.get(f"/api/report/pdf/{job_id}/file", headers={"Authorization": "Bearer a"})
    assert res.status_code == expected
    assert "cfo-ai-pdf" not in res.text
