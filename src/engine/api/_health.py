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
import threading
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


# ── The probe is memoised. It is ANONYMOUS. ─────────────────────────────
#
# Every hit ran a Supabase round-trip AND a Stripe Balance.retrieve AND
# (through _check_fx_rates) a possible BNR fetch. MEASURED live on
# https://cfo-ai.io 2026-09-05: 3.9 s per call. Anonymous, unlimited, and
# amplifying — one curl loop was three upstreams' worth of load and, on
# Stripe, requests against a rate limit that real checkouts share.
#
# 60 s is chosen against the consumer, not invented: the uptime monitor
# this endpoint exists for polls at 60 s or slower, so a memo of one
# window never hides a failure from it for longer than one missed poll,
# while any burst above that rate costs nothing extra. A cached answer
# says so (`"cached": true`) so an operator reading it by hand is never
# misled about how fresh it is.
_HEALTH_TTL_SECONDS = 60.0
_HEALTH_CACHE: Dict[str, Any] = {"body": None, "status": 200, "at": 0.0}
_HEALTH_LOCK = threading.Lock()


def reset_health_cache() -> None:
    """Drop the memo. Tests only; there is no route that calls this."""
    with _HEALTH_LOCK:
        _HEALTH_CACHE["body"] = None
        _HEALTH_CACHE["status"] = 200
        _HEALTH_CACHE["at"] = 0.0


def _observability_state() -> Dict[str, Any]:
    try:
        from ._observability import state
        return state()
    except Exception as exc:  # noqa: BLE001
        return {"configured": False, "active": False,
                "reason": "unavailable: %s" % type(exc).__name__}


def _country_packs() -> Dict[str, Any]:
    """The startup gate's registry, surfaced. A container that came up
    with no accounting pack registered cannot process a trial balance."""
    try:
        from engine.core.country_pack_registry import registered_country_codes
        codes = sorted(registered_country_codes())
        return {"ok": bool(codes), "codes": codes}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": type(exc).__name__}


def _egress_ledgers() -> Dict[str, Any]:
    """Per-provider outbound counters, when the public surface is mounted.
    Absent (not zero) when it is walled — ABSENT ≠ ZERO."""
    if not _public_markets_enabled():
        return {"available": False, "reason": "public markets surface walled"}
    try:
        from engine.public import egress_ledger
        snap = egress_ledger.snapshot()  # type: ignore[attr-defined]
        return {"available": True, "ledgers": snap}
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "reason": type(exc).__name__}


def _public_markets_enabled() -> bool:
    return os.environ.get("PUBLIC_MARKETS_ENABLED", "").strip().lower() in (
        "1", "true", "yes", "on")


def _build_body() -> Dict[str, Any]:
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
    critical_ok = checks["db"]["ok"]
    return {
        "ok": critical_ok,
        "mode": _detect_mode(),
        "version": os.environ.get("GIT_SHA", "unknown"),
        "checks": checks,
        "country_packs": _country_packs(),
        "public_markets": {
            "enabled": _public_markets_enabled(),
            "flag": "PUBLIC_MARKETS_ENABLED",
        },
        "egress": _egress_ledgers(),
        "sentry": _observability_state(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def build_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/health")
    def api_health() -> JSONResponse:
        import time as _time

        now = _time.time()
        with _HEALTH_LOCK:
            cached = _HEALTH_CACHE.get("body")
            at = _HEALTH_CACHE.get("at") or 0.0
            if cached is not None and (now - at) < _HEALTH_TTL_SECONDS:
                body = dict(cached)
                body["cached"] = True
                body["cache_age_s"] = round(now - at, 1)
                return JSONResponse(body, status_code=_HEALTH_CACHE["status"])

        body = _build_body()
        # `degraded` makes the rollup `ok=false` so monitoring can alert
        # without taking the container out of rotation.
        status_code = 200 if body["ok"] else 503
        with _HEALTH_LOCK:
            _HEALTH_CACHE["body"] = body
            _HEALTH_CACHE["status"] = status_code
            _HEALTH_CACHE["at"] = now
        fresh = dict(body)
        fresh["cached"] = False
        fresh["cache_age_s"] = 0.0
        return JSONResponse(fresh, status_code=status_code)

    return router
