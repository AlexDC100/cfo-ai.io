"""Ops surface — GET /api/ops (engine health, read-only).

Mounted by ``pipeline.build_router`` exactly like the reconcile/journal
routes (``register_routes(router, require_jwt=...)`` — ``require_jwt``
is injected so this module never imports back into pipeline.py).

The payload is ``engine.obs.status.ops_snapshot()``: last battery
result per gate, deploy versions (engine + packs + model registry),
AI spend vs caps, journal verification + DLQ depth, drift-sentinel
notices, and the collector's rate/mix summary. Aggregate operational
metadata only — no statement amounts, no line items, no tenant
financial data — and strictly read-only (the sentinel baseline is NOT
updated by this route; the nightly ``scripts/engine_ops.py sentinels``
run owns that).

AUTH: same bar as the reconcile routes — a Bearer token is required
(PUBLIC_TEST_MODE bypass included via the injected ``require_jwt``),
then validated best-effort against Supabase with the caller's own
per-user client: a definitive 401/403 from PostgREST rejects the call,
while infra trouble (no Supabase configured, network down) degrades
OPEN with a log line — an ops surface must keep answering while the
rest of the stack is on fire.

REGISTERING also installs the tracing seams (``engine.obs.tracing
.install``) — decorated journal hooks that stay pure pass-throughs
until ``ENGINE_OBS_TRACE`` is set, so mounting this router changes
nothing about pipeline behavior or bytes.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import Header, HTTPException

from engine.obs import status as _obs_status
from engine.obs import tracing as _obs_tracing

from . import _supabase

logger = logging.getLogger("engine.api.ops_routes")


def _validate_jwt_best_effort(jwt: str) -> None:
    """Reject definitively-bad tokens; degrade open on infra trouble."""
    try:
        with _supabase.per_user(jwt) as client:
            client.select("financial_periods", columns="id", limit=1)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — classify, never crash
        status_code = None
        response = getattr(exc, "response", None)
        if response is not None:
            status_code = getattr(response, "status_code", None)
        if status_code in (401, 403):
            raise HTTPException(401, "Invalid or expired token.")
        logger.info(
            "[ops] auth probe degraded open (infra: %s) — serving ops snapshot",
            type(exc).__name__,
        )


def register_routes(router: Any, *, require_jwt: Any) -> None:
    # Tracing seams: decorate the journal hooks once at router build.
    # Inert (pure pass-through) until ENGINE_OBS_TRACE is set.
    _obs_tracing.install()

    @router.get("/api/ops")
    def get_ops(
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        jwt = require_jwt(authorization)
        _validate_jwt_best_effort(jwt)
        return _obs_status.ops_snapshot()
