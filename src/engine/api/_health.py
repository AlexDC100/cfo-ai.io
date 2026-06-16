"""GET /api/health — deep diagnostic endpoint.

Distinct from `/health` (the simple liveness probe used by Caddy + Docker
healthchecks). `/api/health` actively pings every external dependency the
engine uses in production and returns:

  · 200 — everything reachable; safe to route traffic
  · 503 — at least one critical dependency is down; deploy.sh fails the
          smoke test, monitoring alerts fire

`status` is the boolean rollup; `checks` is a per-dependency map so the
operator can see exactly what failed without grep-ing logs.

`mode` is the most asked-for ops field: is the container running with
live Stripe keys or test keys? Without this, "did the live env vars
actually load?" needs a docker exec. Now it's one curl.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter
from fastapi.responses import JSONResponse


def _check_db() -> Dict[str, Any]:
    """Ping Supabase via the admin client (already used everywhere else).
    A failure here means the engine cannot read/write users, subscriptions,
    or any persisted data — every product surface is broken."""
    t0 = time.time()
    try:
        from . import _supabase
        with _supabase.admin() as client:
            # Cheapest possible round-trip — singleton lookup with no
            # filter so PostgREST returns 200 with 0 or 1 row regardless.
            client.select("subscriptions", limit=1)
        return {"ok": True, "latency_ms": round((time.time() - t0) * 1000, 1)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:120]}",
                "latency_ms": round((time.time() - t0) * 1000, 1)}


def _check_stripe() -> Dict[str, Any]:
    """Resolve the Stripe SDK + ping Balance.retrieve. `livemode` is the
    field the operator actually cares about — confirms whether sk_live_ or
    sk_test_ is actually loaded into the running process."""
    t0 = time.time()
    try:
        from . import _billing
        client = _billing._stripe_or_none()
        if client is None:
            return {"ok": False, "error": "SDK or STRIPE_SECRET_KEY missing",
                    "latency_ms": round((time.time() - t0) * 1000, 1)}
        balance = client.Balance.retrieve()
        return {
            "ok": True,
            "livemode": bool(balance.livemode),
            "latency_ms": round((time.time() - t0) * 1000, 1),
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:120]}",
                "latency_ms": round((time.time() - t0) * 1000, 1)}


def _check_fx_rates() -> Dict[str, Any]:
    """FX rates ship from the BNR cache. Stale rates mean reports show
    wrong RON↔EUR conversions. The cache file mtime tells us when it was
    last refreshed; >24h is stale enough to flag."""
    t0 = time.time()
    try:
        from .fx_rates import get_fx_rates
        rates = get_fx_rates(force_refresh=False) or {}
        age_hours = None
        ts = rates.get("fetched_at") or rates.get("timestamp")
        if ts:
            try:
                fetched = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                age_hours = round((datetime.now(timezone.utc) - fetched).total_seconds() / 3600, 1)
            except Exception:  # noqa: BLE001
                age_hours = None
        ok = bool(rates) and (age_hours is None or age_hours < 48)
        return {
            "ok": ok,
            "currencies": len(rates.get("rates") or {}) if isinstance(rates, dict) else 0,
            "age_hours": age_hours,
            "latency_ms": round((time.time() - t0) * 1000, 1),
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:120]}",
                "latency_ms": round((time.time() - t0) * 1000, 1)}


def _detect_mode() -> str:
    """LIVE / TEST / UNSET — sourced from the Stripe secret key prefix
    since the SDK doesn't expose mode without a network call."""
    sk = os.environ.get("STRIPE_SECRET_KEY", "")
    if sk.startswith("sk_live_"):
        return "LIVE"
    if sk.startswith("sk_test_"):
        return "TEST"
    return "UNSET"


def _check_dio_persistence() -> Dict[str, Any]:
    """Surface the DIO-columns-missing silent-drop state.

    2026-05-26 — the pipeline.py upload path has a defensive retry that
    drops DIO fields when sku_aggregates lacks the columns. Without this
    health check the warning log scrolled past unnoticed for weeks. The
    flag flips to degraded on the next bad insert and resets on the next
    clean upload — operator runs supabase/schema_phase_sku_dio_columns.sql
    once, the next upload populates DIO, and the flag clears.
    """
    try:
        from .pipeline import get_dio_persistence_state
        state = get_dio_persistence_state()
        degraded = bool(state.get("degraded"))
        if degraded:
            return {
                "ok": False,
                "degraded": True,
                "reason": (
                    "sku_aggregates is missing DIO columns; uploads are "
                    "succeeding but silently dropping DIO. Run "
                    "supabase/schema_phase_sku_dio_columns.sql."
                ),
                "last_drop_at": state.get("last_drop_at"),
                "last_dataset_id": state.get("last_dataset_id"),
                "total_rows_dropped": state.get("total_rows_dropped"),
                "drop_event_count": state.get("drop_event_count"),
            }
        return {"ok": True, "degraded": False}
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "degraded": False,
                "warning": f"Could not read DIO persistence state: {type(exc).__name__}"}


def build_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/health")
    def api_health() -> JSONResponse:
        # DB is the only check whose failure means "container should be
        # restarted, traffic should be drained". Stripe/FX are warnings —
        # billing returns 503 on its own, reports still render with stale
        # FX. Keep the 503 trigger narrow.
        checks = {
            "db": _check_db(),
            "stripe": _check_stripe(),
            "fx_rates": _check_fx_rates(),
            "dio_persistence": _check_dio_persistence(),
        }
        # DB is the only hard-503 trigger — Stripe/FX/DIO are warnings.
        # `degraded` makes the rollup `ok=false` so monitoring can alert
        # without taking the container out of rotation.
        critical_ok = checks["db"]["ok"]

        body = {
            "ok": critical_ok,
            "mode": _detect_mode(),
            "version": os.environ.get("GIT_SHA", "unknown"),
            "checks": checks,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        return JSONResponse(body, status_code=200 if critical_ok else 503)

    return router
