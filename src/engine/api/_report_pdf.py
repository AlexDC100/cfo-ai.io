"""Server-side PDF of the standalone report.

  POST /api/report/pdf              {html, company, period} → 202 {job_id, …}
  GET  /api/report/pdf/{job_id}     poll: queued → rendering → done | failed
  GET  /api/report/pdf/{job_id}/file  the bytes, named by the renderer

WHY THE ENGINE IS IN THE PATH AT ALL
    The renderer is `cfo-ai-pdf`, a Node sidecar that runs headless
    Chromium (see services/pdf/server.mjs for why it is not in this
    image).  That container sits on the compose `default` network only —
    `scandia-caddy`, the public ingress, cannot reach it.  So the browser
    cannot call it directly, and this module is the authenticated door:
    it checks the caller's JWT, forwards to the sidecar over the
    internal network, and remembers WHICH USER owns each job so one
    firm's report cannot be collected by another.

WHY THE BROWSER SENDS THE HTML RATHER THAN THE ENGINE BUILDING IT
    The report document is built by `frontend/lib/financialReport.ts` —
    TypeScript, ~4,600 lines, with the ratio ladders, the insight
    detectors' prose and the ten SVG chart builders inside it.  The
    engine cannot produce that HTML, and a second Python implementation
    of it would be a second answer to every figure.  The export laws for
    this product say a figure that differs between formats IS the
    defect, so the PDF is deliberately the SAME BYTES the HTML export
    writes, paginated.  That is why a 190 KB body travels: format parity
    by construction rather than by assertion.

    The consequence is that this route accepts caller-supplied HTML and
    hands it to a browser.  The sidecar is what makes that safe — it
    renders with JavaScript OFF and aborts every network request the
    page attempts, so there is no SSRF and no local file read.  This
    module adds the half the sidecar cannot: knowing who is asking.

FAIL CLOSED
    `PDF_SERVICE_TOKEN` unset ⇒ 503 on every route here, matching the
    rule §22 of CLAUDE.md locked for the cron endpoints.  A PDF renderer
    reachable without a shared secret is an unmetered CPU and memory
    amplifier for anything on that network.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional, Tuple

import httpx
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from . import _supabase


logger = logging.getLogger(__name__)


def _service_url() -> str:
    return os.getenv("PDF_SERVICE_URL", "http://cfo-ai-pdf:8081").rstrip("/")


def _service_token() -> str:
    return os.getenv("PDF_SERVICE_TOKEN", "").strip()


# ── THE JOB → OWNER MAP ────────────────────────────────────────────────
#
# In process, deliberately.  A rendered report is derived data with a ten
# minute life on the sidecar; persisting the ownership row would outlive
# the thing it protects.
#
# THE LIMIT, STATED: this is correct for exactly one backend replica,
# which is what `docker-compose.yml` runs today (`container_name:
# cfo-ai-backend`, no `deploy.replicas`).  If the engine is ever scaled
# horizontally, a poll load-balanced to the other replica finds no owner
# row and answers 404 — a broken download, not a leak, because the
# fallback is refusal.  Moving this to Postgres is the fix at that point.
_JOB_OWNER: Dict[str, str] = {}
# Bounded, oldest-first, so a client that never polls cannot grow it.
_JOB_OWNER_MAX = 512


def _remember(job_id: str, user_id: str) -> None:
    if len(_JOB_OWNER) >= _JOB_OWNER_MAX:
        for stale in list(_JOB_OWNER.keys())[: len(_JOB_OWNER) - _JOB_OWNER_MAX + 1]:
            _JOB_OWNER.pop(stale, None)
    _JOB_OWNER[job_id] = user_id


def _owned_by(job_id: str, user_id: str) -> bool:
    return _JOB_OWNER.get(job_id) == user_id


# ── Auth (same local-copy pattern as _newsletter.py / _pricing_routes.py)


def _require_jwt(authorization: Optional[str]) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    return authorization.split(" ", 1)[1].strip()


def _user_id(authorization: Optional[str]) -> str:
    jwt = _require_jwt(authorization)
    with _supabase.per_user(jwt) as client:
        user = client.get_user(jwt)
    if not user or not user.get("id"):
        raise HTTPException(401, "Could not resolve user from JWT.")
    return str(user["id"])


# ── Request model ──────────────────────────────────────────────────────
#
# MODULE SCOPE, not inside `build_router`.  This module carries
# `from __future__ import annotations`, and a Pydantic model defined
# inside a router factory under postponed annotations cannot have its
# forward reference resolved — FastAPI then binds the body as a QUERY
# parameter and the route answers 422 `loc: [query, body]` to every
# request.  That is not hypothetical: it shipped to production twice
# (Capsule tools, contact-sales) and `tests/engine/test_route_bindings.py`
# exists because of it.  See CLAUDE.md §22.


class RenderPdfRequest(BaseModel):
    html: str
    company: str = ""
    period: str = ""


def _sidecar_headers() -> Dict[str, str]:
    return {"authorization": "Bearer " + _service_token(), "content-type": "application/json"}


def _guard_configured() -> None:
    if _service_token() == "":
        raise HTTPException(
            503,
            "PDF rendering is not configured on this deployment "
            "(PDF_SERVICE_TOKEN unset).",
        )


def _sidecar_error(exc: Exception) -> HTTPException:
    # 502, not 500: the engine is fine, its dependency is not, and an
    # operator reading the status code should be sent to the right
    # container.  The upstream message is logged, never returned — it can
    # name internal hosts.
    logger.warning("pdf sidecar unreachable: %s", exc)
    return HTTPException(502, "The PDF renderer is not reachable.")


def build_router() -> APIRouter:
    router = APIRouter(tags=["report-pdf"])

    @router.post("/api/report/pdf", status_code=202)
    def start_render(
        req: RenderPdfRequest,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        _guard_configured()
        user_id = _user_id(authorization)
        if not req.html.strip():
            raise HTTPException(422, "html is required.")
        try:
            with httpx.Client(timeout=20.0) as client:
                resp = client.post(
                    _service_url() + "/render",
                    headers=_sidecar_headers(),
                    json={"html": req.html, "company": req.company, "period": req.period},
                )
        except Exception as exc:  # noqa: BLE001 — mapped to 502 below
            raise _sidecar_error(exc)
        if resp.status_code >= 400:
            logger.warning("pdf sidecar refused a render: %s %s", resp.status_code, resp.text[:200])
            raise HTTPException(502, "The PDF renderer refused the document.")
        body = resp.json()
        job_id = str(body.get("jobId", ""))
        if not job_id:
            raise HTTPException(502, "The PDF renderer returned no job id.")
        _remember(job_id, user_id)
        return {
            "job_id": job_id,
            "state": body.get("state"),
            "progress": body.get("progress"),
        }

    def _fetch(job_id: str, user_id: str, suffix: str) -> Tuple[int, bytes, Dict[str, str]]:
        # ONE ownership check, in the one place both GETs go through.  A
        # second copy of this test is a second chance to omit it.
        if not _owned_by(job_id, user_id):
            # 404 rather than 403: a caller who does not own the job
            # should not learn whether it exists.
            raise HTTPException(404, "No such render job.")
        try:
            with httpx.Client(timeout=30.0) as client:
                resp = client.get(
                    _service_url() + "/jobs/" + job_id + suffix,
                    headers={"authorization": "Bearer " + _service_token()},
                )
        except Exception as exc:  # noqa: BLE001
            raise _sidecar_error(exc)
        return resp.status_code, resp.content, dict(resp.headers)

    @router.get("/api/report/pdf/{job_id}")
    def poll(job_id: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        _guard_configured()
        status, content, _ = _fetch(job_id, _user_id(authorization), "")
        if status == 404:
            raise HTTPException(404, "No such render job — it may have expired.")
        if status >= 400:
            raise HTTPException(502, "The PDF renderer returned an error.")
        try:
            body = json.loads(content.decode("utf-8"))
        except ValueError:
            # The sidecar answered 200 with something that is not JSON.
            # 502 for the same reason an outage is: the engine is fine,
            # its dependency is not.
            raise HTTPException(502, "The PDF renderer returned an unreadable status.")
        return {
            "job_id": job_id,
            "state": body.get("state"),
            "progress": body.get("progress"),
            "pages": body.get("pages"),
            "bytes": body.get("bytes"),
            "filename": body.get("filename"),
            "error": body.get("error"),
        }

    @router.get("/api/report/pdf/{job_id}/file")
    def download(job_id: str, authorization: Optional[str] = Header(None)) -> Response:
        _guard_configured()
        status, content, headers = _fetch(job_id, _user_id(authorization), "/pdf")
        if status == 404:
            raise HTTPException(404, "No such render job — it may have expired.")
        if status == 409:
            raise HTTPException(409, "The PDF is not finished yet.")
        if status >= 400:
            raise HTTPException(502, "The PDF renderer returned an error.")
        # The sidecar computed the name and asserted it matches
        # `^[A-Za-z0-9_]+\\.pdf$` before sending it.  It is passed through
        # rather than recomputed here: two derivations of one filename is
        # how the header and the saved file come to disagree.
        disposition = headers.get("content-disposition", 'attachment; filename="report.pdf"')
        return Response(
            content=content,
            media_type="application/pdf",
            headers={"content-disposition": disposition, "cache-control": "no-store"},
        )

    return router
