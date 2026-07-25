"""FastAPI service — n8n triggers /run-daily at 06:00 RO time.

Endpoints:
    GET  /health            — liveness probe
    POST /run-daily         — runs the engine, returns JSON contract, writes to PG
    GET  /decisions/{date}  — fetch a previously-stored day's decisions

The service is intentionally small: it wraps the existing pipeline + adapter,
adds an auth header check, and exposes both as HTTP. No new business logic.

Auth: a single shared bearer token from `ENGINE_API_TOKEN` env var. n8n stores
it as a credential and sends `Authorization: Bearer <token>`.
"""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy.engine import Engine

from ..actions import build_output
from ..config import Config, load_config
from ..models import CategoryRow
from ..pipeline import run_pipeline
from ..storage import PostgresAdapter, create_engine_from_url
from ._benchmarks import build_router as create_benchmarks_router
from ._billing import build_router as create_billing_router
from ._features import build_router as create_features_router
from ._health import build_router as create_health_router
from ._industry_intelligence import build_router as create_industry_router
from ._newsletter import build_router as create_newsletter_router
from ._pricing_routes import build_router as create_pricing_router
from ._test_mode import build_router as create_test_mode_router
from ._org import create_workspaces_router
from .cfo_ai import create_cfo_router
from .financial_statements import build_router as create_financial_statements_router
from .frontend import create_frontend_router
from .pipeline import build_router as create_pipeline_router
# NASDAQ-6 — public-company surface (/api/public/*). Wraps Sharadar SF1
# + DAILY + TICKERS via engine.public.NasdaqAdapter. Independent of the
# RO trial-balance pipeline; shares only the assembled_canonical_v1
# output shape so FE renderers consume both source types unchanged.
from ..public.routes import build_router as create_public_company_router
# AI Intelligence layer (Phase A). Mounted alongside the public-company
# router. Provides /api/public/intelligence/* endpoints — risk-radar,
# macro-signals, supply-chain, per-ticker risk-score/exposure/signals/ai-market-read,
# manual-signal upload, cache refresh. Decoupled from the Sharadar SF1
# pipeline and from the trial-balance engine. See
# docs/PUBLIC-COMPANY-AI-INTELLIGENCE-PLAN.md.
from ..public.intelligence.routes import build_router as create_intelligence_router


# ─────────── Request / response shapes ───────────


class RunRequest(BaseModel):
    """Payload posted by n8n (or any caller) to trigger a run."""

    run_date: date = Field(..., description="The date to stamp on the decisions output")
    snapshot_date: Optional[date] = Field(
        None,
        description="Date of the category snapshot in PG. Defaults to run_date.",
    )
    period_months: int = Field(10, gt=0, le=60,
                               description="Months of data in the snapshot (10 for YTD Oct dataset)")
    data_period: str = Field("YTD October 2025", description="Human-readable period label")
    dry_run: bool = Field(False, description="Skip PG write-back if true")


class HealthResponse(BaseModel):
    status: str
    version: str


class SessionTrackRequest(BaseModel):
    """Body posted by the frontend on identity-set + heartbeat."""
    name: str = Field(..., min_length=1, max_length=64)


# ─────────── Factory: build app with injected dependencies ───────────


def create_app(
    config_path: Path = Path("config.yaml"),
    db_url: Optional[str] = None,
    auth_token_env: str = "ENGINE_API_TOKEN",
    canonical_excel: Optional[Path] = None,
    cors_origins: Optional[List[str]] = None,
) -> FastAPI:
    """Wire the FastAPI app. Caller supplies config + DB URL.

    Defaults to sqlite in-memory if db_url is omitted — useful for smoke tests
    but useless for production (data is lost on restart).

    `canonical_excel` (optional) seeds the frontend `/api/canonical-categories`
    DIO/CCC lookup. Without it, uploads must carry their own DIO data.
    """
    # WS4 — fail-fast on missing Supabase trio + log Stripe mode banner.
    # Optional gaps are warned, not raised. Tests / dev set
    # CFO_AI_SKIP_BOOT_VERIFY=1 to bypass.
    from ..boot_verify import verify_config_safe
    verify_config_safe()

    cfg = load_config(config_path)
    engine: Engine = create_engine_from_url(db_url or "sqlite:///:memory:")
    adapter = PostgresAdapter(engine)
    adapter.create_all()

    # F3.1e startup gate: refuse to come up if no country accounting
    # pack registered. The `engine.country_packs.ro_romania` import at
    # module top of `engine.api.pipeline` already triggers the pack's
    # self-registration; here we just sanity-check the registry.
    from engine.core.country_pack_registry import (  # local import to avoid shadowing local var `engine`
        assert_at_least_one_registered,
        registered_country_codes,
    )
    assert_at_least_one_registered()
    import logging as _logging
    _logging.getLogger(__name__).info(
        "F3.1 country packs registered: %s", registered_country_codes()
    )

    app = FastAPI(
        title="SKU Decision Engine",
        version="0.1.0",
        description="Daily decision engine for SKU rationalization.",
    )

    # CORS — the React dev server runs on a different port. Tighten in prod.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins or [
            "http://localhost:5173", "http://127.0.0.1:5173",
            "http://localhost:8080", "http://127.0.0.1:8080",
            "http://localhost:4173", "http://127.0.0.1:4173",
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Frontend-facing endpoints (no auth in dev; add it before exposing publicly)
    app.include_router(create_frontend_router(cfg, canonical_excel))
    # CFO AI endpoints (Today / Cash / Profit / Decisions / Products)
    app.include_router(create_cfo_router(cfg, adapter))
    # Financial Statement Intelligence pipeline (Phase 2)
    app.include_router(create_financial_statements_router())
    # Phase 3 — async pipeline orchestrator + period read endpoint
    app.include_router(create_pipeline_router())
    # Ask CFO AI — streaming SSE endpoint backed by Opus 4.7 (Phase III) —
    # removed 2026-07-24 (ask.py deleted). It had tool-use + live pipeline
    # re-grounding the Edge Function doesn't replicate, but nothing in the
    # frontend ever called `/api/ask` — confirmed dead, not a duplicate.
    # Stripe-backed billing (checkout, portal, webhook, renewal cron)
    app.include_router(create_billing_router())
    # Phase 7 — industry-benchmark comparison (suggest / set-caen / report).
    app.include_router(create_benchmarks_router())
    # Phase Industry Intelligence B — read-only routes over the new
    # industry_profiles / caen_industry_mappings / peer_candidates /
    # benchmark_sets catalog + per-period detect endpoint. Writes land in Phase C.
    app.include_router(create_industry_router())
    # App-shell cleanup Phase 1 — feature registry. Single source of
    # truth for "is this product capability active, coming_soon, or
    # hidden". Read by Command Center + Sidebar + Settings on first
    # paint to gate UI rendering. No auth.
    app.include_router(create_features_router())
    # Pricing V2 — new tier model (trial/intro/starter/pro) with
    # config-driven prices, daily+monthly chat caps, extra-doc
    # metering, and an internal below-COGS warning. Public
    # `GET /api/pricing/config` is read by Landing + Pricing pages;
    # `GET /api/plan/state` drives the Settings usage card; admin
    # endpoint surfaces the below-COGS warnings.
    app.include_router(create_pricing_router())
    # Email — newsletter (double opt-in subscribe / confirm / unsubscribe),
    # admin broadcast to confirmed subscribers, and the renewal-email queue
    # drain. All app-originated mail goes through Resend (see _email.py).
    # Auth emails (reset/confirm) are delivered by Supabase via Resend SMTP.
    app.include_router(create_newsletter_router())
    # NASDAQ-6 — public-company routes (/api/public/search,
    # /api/public/companies/:ticker, /api/public/companies/:ticker/sync,
    # /api/public/health). Requires NASDAQ_API_KEY in env for full
    # functionality; the /health route stays callable without the key.
    app.include_router(create_public_company_router())
    # AI Intelligence layer — risk radar, exposure, scoring, signals,
    # market-read narrative. /api/public/intelligence/*.
    app.include_router(create_intelligence_router())
    # WS4 — deep diagnostic endpoint. /health stays as the simple
    # liveness probe (Caddy / docker healthcheck); /api/health pings DB
    # + Stripe + FX, returns 503 if DB is down so deploy.sh fails the
    # smoke test instead of marking a broken deploy green.
    app.include_router(create_health_router())
    # PUBLIC_TEST_MODE — exposes /api/test-mode/session. Endpoint
    # returns 404 when the env flag is off so production posture
    # surfaces no test-mode endpoint.
    app.include_router(create_test_mode_router())
    # Workspace lifecycle — POST /api/workspaces/cron/purge-expired.
    # Scheduler-only (ENGINE_API_TOKEN); permanently deletes workspaces
    # whose 30-day recovery window has closed.
    app.include_router(create_workspaces_router())

    # ─── Auth dependency ───
    auth_dep = _make_auth_dependency(auth_token_env)

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok", version=app.version)

    @app.post("/run-daily")
    def run_daily(req: RunRequest, _: None = Depends(auth_dep)) -> Dict[str, Any]:
        snapshot = req.snapshot_date or req.run_date
        rows: List[CategoryRow] = adapter.load_categories(snapshot)
        if not rows:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No category snapshot found for {snapshot.isoformat()}",
            )
        overrides = adapter.load_overrides()

        metrics, decisions = run_pipeline(
            rows, cfg, period_months=req.period_months, overrides=overrides
        )
        payload = build_output(
            decisions, metrics, cfg,
            run_date=req.run_date,
            data_period=req.data_period,
        )
        if not req.dry_run:
            adapter.write_decisions(payload)
        return payload

    @app.get("/decisions/{run_date}")
    def get_decisions(run_date: date, _: None = Depends(auth_dep)) -> List[Dict[str, Any]]:
        decisions = adapter.fetch_decisions(run_date)
        if not decisions:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No decisions for {run_date.isoformat()}",
            )
        return decisions

    # ─── Session log (cross-user awareness) ─────────────────────────────
    # Anyone using the platform appears in this list. Lets the team see who
    # has logged in, from where, and when. No auth (the frontend calls these
    # on every page load) — the data is intentionally low-sensitivity (name +
    # IP last octet + last-seen timestamp).

    @app.post("/api/sessions/track")
    def track_session(payload: SessionTrackRequest, request: Request) -> Dict[str, Any]:
        # Caddy forwards the original client IP via X-Forwarded-For.
        # Fall back to the direct peer address otherwise.
        xff = request.headers.get("x-forwarded-for", "")
        ip = (xff.split(",")[0].strip() if xff else None) or (
            request.client.host if request.client else None
        )
        ua = (request.headers.get("user-agent") or "")[:256]
        return adapter.upsert_session(name=payload.name, ip=ip, user_agent=ua)

    @app.get("/api/sessions")
    def list_sessions(limit: int = 50) -> Dict[str, Any]:
        rows = adapter.list_sessions(limit=max(1, min(limit, 200)))
        return {"count": len(rows), "sessions": rows}

    # Stash the adapter on app state so tests can seed data.
    app.state.adapter = adapter
    app.state.cfg = cfg
    return app


def _make_auth_dependency(env_var: str) -> Callable[[Optional[str]], None]:
    """Build a Depends() that checks a Bearer token.

    If the env var is unset, auth is DISABLED — useful for local dev and tests
    but a deployment-time misconfiguration in prod. The README warns about this.
    """
    expected = os.environ.get(env_var)

    def check(authorization: Optional[str] = Header(None)) -> None:
        if expected is None:
            return  # auth disabled
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing bearer token")
        token = authorization.removeprefix("Bearer ").strip()
        if token != expected:
            raise HTTPException(status_code=401, detail="Invalid bearer token")

    return check
