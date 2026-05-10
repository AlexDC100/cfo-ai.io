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
from .cfo_ai import create_cfo_router
from .financial_statements import build_router as create_financial_statements_router
from .frontend import create_frontend_router
from .pipeline import build_router as create_pipeline_router


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
    cfg = load_config(config_path)
    engine: Engine = create_engine_from_url(db_url or "sqlite:///:memory:")
    adapter = PostgresAdapter(engine)
    adapter.create_all()

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
