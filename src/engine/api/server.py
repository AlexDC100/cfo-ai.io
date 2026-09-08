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

import logging
import os
import uuid
from datetime import date
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.engine import Engine

# MODULE SCOPE, and load-bearing. Two mounts below are wrapped in
# ``except Exception: logger.exception(...)`` and documented as "never
# fatal" — a partially-provisioned deployment (no public_ro.db yet) must
# lose the storefront, not the API. Until 2026-09-05 there was no
# module-level ``logger`` here: the only logging name bound anywhere in
# this file was a LOCAL ``_logging`` inside create_app(). So on the one
# day the guard mattered, the handler raised ``NameError: name 'logger'
# is not defined`` out of itself and create_app() died — the whole API,
# for the surface the comment promised was optional. Gate:
# tests/engine/test_launch_survival.py::
# test_a_failing_storefront_mount_does_not_take_the_whole_api_down.
logger = logging.getLogger(__name__)

from ..actions import build_output
from ..config import Config, load_config
from ..models import CategoryRow
from ..pipeline import run_pipeline
from ..storage import PostgresAdapter, create_engine_from_url
from ._benchmarks import build_router as create_benchmarks_router
from ._billing import build_router as create_billing_router
from ._capsule_tools import build_router as create_capsule_router
from ._dashboard import build_router as create_dashboard_router
from ._features import build_router as create_features_router
from ._forecast_routes import build_router as create_forecast_router
from ._health import build_router as create_health_router
from ._industry_intelligence import build_router as create_industry_router
from ._newsletter import build_router as create_newsletter_router
from ._pricing_routes import build_router as create_pricing_router
from ._report_pdf import build_router as create_report_pdf_router
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


# ─────────── Security headers ───────────
#
# MEASURED on https://cfo-ai.io on 2026-09-05: no strict-transport-security,
# no content-security-policy, no x-frame-options, no x-content-type-options.
# The SPA half is nginx's (see nginx.conf); this is the API half.
SECURITY_HEADERS = {
    # One year, subdomains included. No `preload` — that is a submission
    # to a browser-vendor list and an irreversible decision the owner
    # makes, not a deploy.
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": (
        "accelerometer=(), autoplay=(), camera=(), display-capture=(), "
        "encrypted-media=(), fullscreen=(self), geolocation=(), "
        "gyroscope=(), magnetometer=(), microphone=(), midi=(), "
        "payment=(), usb=(), xr-spatial-tracking=()"
    ),
    # REPORT-ONLY. The API answers JSON and the RO storefront's own HTML;
    # neither should ever be framed or load a plugin. Enforcement across
    # the whole origin is a separate, tested change.
    "content-security-policy-report-only": (
        "default-src 'self'; frame-ancestors 'none'; object-src 'none'; "
        "base-uri 'self'"
    ),
}


class SecurityHeadersMiddleware:
    """Pure-ASGI, so it cannot inherit BaseHTTPMiddleware's buffering.

    ``setdefault`` on purpose: a route that deliberately sets its own
    value (the RO storefront's per-page ``x-robots-tag``, a future
    per-response CSP) keeps it.
    """

    def __init__(self, app):  # type: (Any) -> None
        self.app = app

    async def __call__(self, scope, receive, send):  # type: (Any, Any, Any) -> None
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        async def _send(message):  # type: (Any) -> None
            if message.get("type") == "http.response.start":
                from starlette.datastructures import MutableHeaders

                headers = MutableHeaders(scope=message)
                for key, value in SECURITY_HEADERS.items():
                    if key not in headers:
                        headers[key] = value
            await send(message)

        await self.app(scope, receive, _send)


# ─────────── A STATED WORST CASE FOR AN ANONYMOUS REQUEST ───────────
#
# MEASURED 2026-09-06, locally, against the real create_app(), anonymous,
# no bearer, no rate limit anywhere in front of it:
#
#   POST /api/skus    18.5 MB of INVALID rows -> 422, 42,009,599 bytes out
#                     (2.13x) in 3.46 s
#   POST /api/skus    18.5 MB of VALID   rows -> 200, 56,989,094 bytes out
#                     (2.82x) in 3.45 s
#   POST /api/drill   18.5 MB of INVALID rows -> 422, 42,009,599 bytes out
#   POST /api/cfo/today 18.5 MB invalid       -> 422, 39,984,904 bytes out
#
# Two separate defects, and both are closed here:
#
#   * NO SIZE LIMIT ANYWHERE. There is no `client_max_body_size` in
#     nginx.conf (which serves the SPA only) and none in the app, so the
#     ceiling was whatever the front proxy happened to allow. A caller
#     chose how much work the box did.
#   * THE VALIDATOR ECHOES THE ATTACK BACK. FastAPI's default
#     RequestValidationError handler returns `exc.errors()` verbatim,
#     and every entry carries the offending `input`. One invalid row
#     produced three echoed values; 75,481 rows produced 42 MB of them.
#     No schema knowledge required — the failure path was the amplifier.
#
# HOW THE NUMBERS BELOW WERE CHOSEN. The largest legitimate body the
# product can produce was measured, not guessed:
#
#   * the largest real SKU dataset in this repo
#     (files/Trading_analysis_YTDOct'25_LV.xlsx, 9,604 rows) serialized in
#     the exact shape `frontend/lib/api.ts::rawRowsToBackend` posts is
#     1,925,012 bytes — 1.84 MB, at 200.4 bytes per row. GENERAL_BODY_
#     LIMIT_BYTES is 8 MiB: 4.4x that, i.e. room for a portfolio four
#     times larger than anything the owner has ever analyzed.
#   * the financial pipeline does NOT post documents here at all — the
#     browser uploads straight to Supabase Storage and the engine
#     downloads by signed URL (engine/api/pipeline.py:1219). The only
#     paths that legitimately carry a whole document in the request are
#     `POST /api/financial-statements/parse` (`pdf_b64`, whose own
#     ceiling is a 25 MB decoded PDF -> 33.4 MB of base64) and the firm
#     cockpit's `POST /api/firm/requests/{token}/upload` (a 25 MB
#     multipart file). DOCUMENT_BODY_LIMIT_BYTES is 36 MiB, which clears
#     33.4 MB of base64 plus its JSON envelope and 25 MB plus multipart
#     framing, and nothing more.
#
# WHY TWO ENFORCEMENT POINTS. `nginx.conf` gets a `client_max_body_size`
# for the hop it actually owns, and this middleware holds the same line
# inside the app so the limit survives a direct hit on :8000, a different
# front, or a future ingress. The VPS's Caddy needs its own line; it is
# not in this repo (see the operator delta in the Stream 3 report).
GENERAL_BODY_LIMIT_BYTES = 8 * 1024 * 1024          # 8 MiB
DOCUMENT_BODY_LIMIT_BYTES = 36 * 1024 * 1024        # 36 MiB


def _is_document_body_path(path):  # type: (str) -> bool
    """The two paths that legitimately carry a whole document in the body."""
    if path == "/api/financial-statements/parse":
        return True
    return path.startswith("/api/firm/requests/") and path.endswith("/upload")


def body_limit_for(path):  # type: (str) -> int
    """The stated ceiling, in bytes, for a request to `path`."""
    return (DOCUMENT_BODY_LIMIT_BYTES if _is_document_body_path(path)
            else GENERAL_BODY_LIMIT_BYTES)


def _too_large_body(limit, observed):  # type: (int, Optional[int]) -> Dict[str, Any]
    """The designed 413 payload. Under 400 bytes, in the same
    ``{"error": {...}}`` envelope the surface walls answer in, so a caller
    that switches on ``.error.code`` needs no new branch."""
    details = {"limit_bytes": limit, "limit_mib": limit // (1024 * 1024)}
    if observed is not None:
        details["observed_bytes"] = observed
    return {
        "error": {
            "code": "request_too_large",
            "message": ("Request body is larger than this endpoint accepts. "
                        "Send fewer rows, or upload the file to storage first."),
            "details": details,
        }
    }


class BodyLimitMiddleware:
    """Reject an over-size body with 413 BEFORE the route or the validator.

    Pure ASGI on purpose: BaseHTTPMiddleware would buffer the very body
    this exists to refuse.

    TWO CASES, because HTTP frames a body in two ways:

      * ``content-length`` declared — the ordinary case; every JSON client
        sends it. Over the cap answers 413 and THE BODY IS NEVER READ, so
        the amplifier costs one header parse. A *lying* content-length
        cannot smuggle more past this: with length framing, h11/uvicorn
        deliver exactly the declared number of bytes and no more, so the
        declaration is the ceiling the transport itself enforces.
      * no ``content-length`` (chunked transfer) — the body is drained
        here, bounded at ``limit + 1`` bytes, before the app is called.
        Over the cap answers 413; under it, the buffered bytes are
        replayed to the app through a substitute ``receive``, so the route
        sees exactly the request it would have seen.

    The 413 carries SECURITY_HEADERS itself for the same reason the
    surface wall does — it must not depend on which middleware happens to
    wrap it today.
    """

    def __init__(self, app, general=None, document=None):
        # type: (Any, Optional[int], Optional[int]) -> None
        self.app = app
        self.general = GENERAL_BODY_LIMIT_BYTES if general is None else general
        self.document = DOCUMENT_BODY_LIMIT_BYTES if document is None else document

    def _limit_for(self, path):  # type: (str) -> int
        return self.document if _is_document_body_path(path) else self.general

    async def _refuse(self, scope, receive, send, limit, observed):
        # type: (Any, Any, Any, int, Optional[int]) -> None
        response = JSONResponse(_too_large_body(limit, observed),
                                status_code=413,
                                headers=dict(SECURITY_HEADERS))
        await response(scope, receive, send)

    async def __call__(self, scope, receive, send):  # type: (Any, Any, Any) -> None
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        limit = self._limit_for(scope.get("path") or "")

        declared = None  # type: Optional[int]
        for raw_key, raw_value in scope.get("headers") or ():
            if raw_key == b"content-length":
                try:
                    declared = int(raw_value)
                except (TypeError, ValueError):
                    declared = None
                break

        if declared is not None:
            if declared > limit:
                await self._refuse(scope, receive, send, limit, declared)
                return
            await self.app(scope, receive, send)
            return

        # Chunked (or no body at all): drain, bounded, before the app runs.
        # Never more than `limit + 1` bytes are held here — that bound is
        # per request, so N concurrent chunked requests still cost N times
        # it (a limiter's problem, not a cap's; backlog LB-RL-1).
        chunks = []  # type: List[bytes]
        total = 0
        disconnected = None  # type: Optional[Dict[str, Any]]
        while True:
            message = await receive()
            if message.get("type") != "http.request":
                # A disconnect mid-body. Replay it AS A DISCONNECT rather
                # than as an empty body, so the app sees the request that
                # actually happened.
                disconnected = message
                break
            body = message.get("body") or b""
            total += len(body)
            if total > limit:
                await self._refuse(scope, receive, send, limit, None)
                return
            chunks.append(body)
            if not message.get("more_body"):
                break

        pending = []  # type: List[Dict[str, Any]]
        if chunks:
            pending.append({"type": "http.request",
                            "body": b"".join(chunks),
                            "more_body": False})
        if disconnected is not None:
            pending.append(disconnected)

        async def _replay():  # type: () -> Dict[str, Any]
            if pending:
                return pending.pop(0)
            return await receive()

        await self.app(scope, _replay, send)


# ─────────── The bounded 422 ───────────
#
# The ceiling this handler guarantees, and the gate asserts as a NUMBER:
# a validation failure answers in under VALIDATION_RESPONSE_CEILING_BYTES,
# no matter how many rows failed. 20 errors x (loc <=550 + msg <=200 +
# input <=120 + type <=40 + JSON framing) + envelope < 20 KiB.
MAX_VALIDATION_ERRORS = 20
MAX_VALIDATION_INPUT_CHARS = 120
MAX_VALIDATION_MSG_CHARS = 200
MAX_VALIDATION_LOC_ELEMENTS = 8
MAX_VALIDATION_LOC_CHARS = 64
VALIDATION_RESPONSE_CEILING_BYTES = 20 * 1024        # 20 KiB


def _clip(text, cap):  # type: (str, int) -> str
    return text if len(text) <= cap else (text[:cap] + "…")


def bounded_validation_detail(errors):  # type: (Any) -> Dict[str, Any]
    """FastAPI's 422 body, with the echo bounded and still USEFUL.

    What survives, per error: ``loc`` (which field of which row), ``msg``
    (why), ``type``, and a TRUNCATED ``input`` so the developer can see
    what they actually sent. What does not: the unbounded verbatim
    ``input`` for every failing row — the amplifier — and pydantic's
    ``ctx``/``url``, which repeat the value and the docs link.

    ``detail`` stays a list under the same key, because
    ``frontend/lib/api.ts::call`` and ``tests/engine/test_route_bindings``
    both read ``detail[].loc`` / ``detail[].type``.
    """
    errors = list(errors or [])
    shown = []
    for err in errors[:MAX_VALIDATION_ERRORS]:
        loc = list(err.get("loc") or [])[:MAX_VALIDATION_LOC_ELEMENTS]
        loc = [_clip(item, MAX_VALIDATION_LOC_CHARS) if isinstance(item, str)
               else item for item in loc]
        entry = {
            "type": _clip(str(err.get("type") or "invalid"), 40),
            "loc": loc,
            "msg": _clip(str(err.get("msg") or ""), MAX_VALIDATION_MSG_CHARS),
        }
        if "input" in err:
            entry["input"] = _clip(repr(err.get("input")),
                                   MAX_VALIDATION_INPUT_CHARS)
        shown.append(entry)
    body = {"detail": shown, "error_count": len(errors)}
    if len(errors) > len(shown):
        body["truncated"] = True
        body["message"] = (
            "%d validation errors; the first %d are shown. Every failing row "
            "has the same shape — fix these and re-send."
            % (len(errors), len(shown))
        )
    return body


def _flag_on(name):  # type: (str) -> bool
    """True only for an explicit truthy string. Read at create_app() time,
    never cached at import, so one process can build both postures."""
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _public_markets_enabled():  # type: () -> bool
    """THE PUBLIC-MARKETS WALL — default OFF.

    Public Companies (Nasdaq/EDGAR envelopes, the AI intelligence layer,
    the global market registry) ships HIDDEN at launch. Hidden in the
    navigation is not hidden on the wire: every one of those routes is an
    anonymous GET or POST that reaches a paid provider or a model, so with
    the surface unreachable in the product they are pure cost per
    anonymous hit and nothing else. One flag decides whether the surface
    exists at all — absent the flag there is no route to wall, which is
    the only wall that cannot be got past.

    What this flag does NOT cover: the RO storefront (``/api/public/ro/*``
    and its clean paths ``/companii`` … ``/sitemap.xml``). That surface is
    deterministic, reads only its own store, reaches no provider on any
    serve path, and carries its own rate limiter — it keeps serving, and
    600k indexed URLs stay live.
    """
    return _flag_on("PUBLIC_MARKETS_ENABLED")


# ─────────── Surfaces that ship hidden, walled at the wire ───────────
#
# "Hidden in the navigation" is not hidden. A route that no screen calls
# is still an anonymous HTTP endpoint, and two of the hidden surfaces
# reach something that costs money on every hit. Each entry below is one
# surface: the paths it owns, the single environment flag that brings it
# back, and the reason it is off. A walled path answers a stable JSON 404
# in the §24 envelope shape the public routers already use, so a caller
# that switches on ``.error.code`` needs no new branch.


def _is_public_markets(path):  # type: (str) -> bool
    # The RO storefront is EXEMPT: it is deterministic, reads only its own
    # SQLite store, reaches no provider on any serve path, and carries its
    # own rate limiter — it keeps serving, and 600k indexed URLs stay live.
    # `/api/public-records/` does not match this prefix; the trailing slash
    # is load-bearing.
    return (path.startswith("/api/public/")
            and not path.startswith("/api/public/ro/"))


def _is_legacy_sku_ai(path):  # type: (str) -> bool
    return path in ("/api/analyze", "/api/upload-excel")


WALLED_SURFACES = (
    {
        "name": "public_markets",
        "flag": "PUBLIC_MARKETS_ENABLED",
        "match": _is_public_markets,
        "message": "The public markets surface is not enabled on this deployment.",
    },
    {
        "name": "legacy_sku_ai",
        "flag": "LEGACY_SKU_AI_ENABLED",
        "match": _is_legacy_sku_ai,
        # MEASURED 2026-09-05 against the real app with every transport
        # spied: an anonymous POST /api/analyze with a ~200-byte body
        # answered 200 in 0.01 s having spent ONE api.anthropic.com
        # completion. No bearer, no rate limit, no usage gate — and in
        # production ANTHROPIC_API_KEY is set while USAGE_LIMITS_ENABLED
        # is false. A loop was a bill. /api/upload-excel reaches the same
        # `_build_analysis` and the same model. Both belong to the legacy
        # SKU / Products surface, which ships hidden: the live upload path
        # is the dashboard dropzone into the financial pipeline, and
        # UploadDialog (the only caller of /api/upload-excel) is mounted
        # nowhere. The four SIBLING routes — /api/classify-rows, /api/skus,
        # /api/alerts, /api/drill — are deliberately NOT walled: they
        # compute deterministically from the body and reach no model
        # (measured 0.17-0.58 s on a 2.2 MB body). Their body-size cap and
        # rate limit is a backlog ticket, not a launch change.
        "message": "The legacy SKU analysis surface is not enabled on this deployment.",
    },
)


def _wall_body(surface):  # type: (Dict[str, Any]) -> Dict[str, Any]
    return {
        "error": {
            "code": "surface_not_enabled",
            "message": surface["message"],
            "details": {"surface": surface["name"], "flag": surface["flag"]},
        }
    }


# Kept as a module-level name because tests and callers read it.
PUBLIC_MARKETS_WALL_BODY = _wall_body(WALLED_SURFACES[0])


class SurfaceWallMiddleware:
    """A stable JSON 404 for every path a hidden surface owns.

    A MIDDLEWARE, not a catch-all route, for three reasons:

      * it adds no row to the app's route table, so the route censuses
        (test_identity_wall's write-wall classification,
        test_route_bindings) keep enumerating exactly the surface the
        product has, and a ``{walled_path:path}`` placeholder never has to
        be classified as a mutating route it is not;
      * it runs BEFORE routing, so it is not sensitive to which router was
        included first — an exemption is a prefix test here, not an
        ordering accident that a later edit could quietly reverse;
      * it walls any route a surface grows LATER without that route having
        to remember the flag.

    The flags are read ONCE, at create_app() time, and the resulting rule
    list is captured — the same contract as the mounts, so one process can
    build both postures and no test can flip a wall out from under a
    request mid-run.
    """

    def __init__(self, app, surfaces=()):  # type: (Any, Any) -> None
        self.app = app
        self.surfaces = tuple(surfaces)

    def _match(self, path):  # type: (str) -> Optional[Dict[str, Any]]
        for surface in self.surfaces:
            if surface["match"](path):
                return surface
        return None

    async def __call__(self, scope, receive, send):  # type: (Any, Any, Any) -> None
        surface = (self._match(scope.get("path") or "")
                   if scope.get("type") == "http" else None)
        if surface is None:
            await self.app(scope, receive, send)
            return
        response = JSONResponse(_wall_body(surface), status_code=404,
                                headers=dict(SECURITY_HEADERS))
        await response(scope, receive, send)


def _active_walls():  # type: () -> List[Dict[str, Any]]
    """The surfaces that are OFF right now — i.e. the ones to wall."""
    return [s for s in WALLED_SURFACES if not _flag_on(s["flag"])]


def _anomaly_radar_enabled():  # type: () -> bool
    """True only when ANOMALY_RADAR_ENABLED is an explicit truthy string.

    `/api/radar/*` is a fully built surface with no frontend caller and no
    menu row — the same "complete and unreachable" shape the forecast was
    in until today. Mounting it behind an explicit flag makes the state
    honest: unset, every radar path is a 404 by construction, exactly the
    way `/api/firm` is without FIRM_COCKPIT_ENABLED.

    Read at create_app() time, never cached at import, so a test can build
    one app with the surface and one without in the same process.
    """
    return os.environ.get("ANOMALY_RADAR_ENABLED", "").strip().lower() in (
        "1", "true", "yes", "on",
    )


def _firm_cockpit_enabled():  # type: () -> bool
    """True only when FIRM_COCKPIT_ENABLED is an explicit truthy string.

    Read at create_app() time, never cached at import, so a test can build
    one app with the Cockpit and one without in the same process.
    """
    return os.environ.get("FIRM_COCKPIT_ENABLED", "").strip().lower() in (
        "1", "true", "yes", "on",
    )


def _rightmost_forwarded_hop(request):  # type: (Any) -> Optional[str]
    """The address our own proxy observed, never the one the caller wrote.

    Delegates to `engine.public_ro.ratelimit._client_ip` — the same helper
    the rate limiter, the funnel and the refresh shield read, so the four
    cannot drift apart on what "the client" means (CLAUDE.md §21).
    """
    from engine.public_ro.ratelimit import _client_ip as _canonical_hop
    return _canonical_hop(request) or None


def _require_operator(request, *, route):  # type: (Any, str) -> None
    """Fail-closed operator gate: 503 unconfigured, 401 missing/wrong."""
    from engine.public.refresh_shield import require_operator
    require_operator(request, route=route)


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

    # Gzip large JSON responses (period reports run to hundreds of KB). In
    # prod Caddy compresses at the edge and will pass an already-encoded body
    # through untouched; this covers dev and any direct :8000 access. Added
    # BEFORE CORSMiddleware so CORS stays the outermost middleware (Starlette
    # runs later-added middleware first) and preflights never hit the gzipper.
    # No engine endpoint streams (SSE moved to the chat-llm Edge Function), so
    # response buffering here is safe.
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    # THE BODY CAP. Added here — after GZip, BEFORE CORS — deliberately:
    # Starlette runs later-added middleware first, so this ends up INSIDE
    # CORSMiddleware and its 413 therefore carries the CORS headers a
    # browser needs to read the refusal, while still running before
    # routing and before the validator. Measured before this line existed:
    # an anonymous 18.5 MB POST /api/skus answered 200 with 56,989,094
    # bytes (2.82x) in 3.45 s, and the same body of INVALID rows answered
    # 422 with 42,009,599 bytes (2.13x). See the module-level note above
    # for the two limits and how each number was chosen.
    # Gate: tests/engine/test_request_limits.py.
    app.add_middleware(BodyLimitMiddleware)

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

    # SECURITY HEADERS — added LAST so it is the outermost user middleware
    # and every API response carries them, including the ones CORS and
    # GZip produce. Measured on https://cfo-ai.io 2026-09-05: not one of
    # these was present. The CSP is REPORT-ONLY on purpose — a hard CSP
    # shipped onto a Vite SPA without being tested against it is a P0
    # waiting to happen; enforcing it is a backlog ticket, not a launch
    # change. The 500 handler below sets the same headers itself, because
    # Starlette's ServerErrorMiddleware sits OUTSIDE every user middleware
    # and its response never passes back through this one.
    app.add_middleware(SecurityHeadersMiddleware)

    # THE HIDDEN-SURFACE WALLS. Added after the header middleware so it is
    # OUTSIDE it — the wall sets the same headers on its own 404 — and
    # before routing, so a walled path never reaches a router at all.
    walls = _active_walls()
    app.add_middleware(SurfaceWallMiddleware, surfaces=walls)
    if walls:
        logger.info("[server] walled surfaces: %s",
                    ", ".join("%s (set %s to enable)" % (s["name"], s["flag"])
                              for s in walls))

    # ERROR TRACKING — inert unless SENTRY_DSN is set. Never raises, never
    # adds a hard dependency (see _observability.py).
    from ._observability import init_error_tracking
    init_error_tracking()

    # THE BOUNDED 422. FastAPI's default RequestValidationError handler
    # returns `exc.errors()` verbatim, and every entry carries the
    # offending `input` — so the FAILURE path was the amplifier, and it
    # needed no schema knowledge to drive: 18.5 MB of invalid rows came
    # back as 42,009,599 bytes. This replaces the default with the same
    # contract (status 422, `detail` a list of {type, loc, msg, input}),
    # bounded to MAX_VALIDATION_ERRORS entries with `input` clipped, and
    # `error_count` added so a developer still learns how many rows
    # failed. Gate: tests/engine/test_request_limits.py.
    from fastapi.exceptions import RequestValidationError

    @app.exception_handler(RequestValidationError)
    async def _validation_failed(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(bounded_validation_detail(exc.errors()),
                            status_code=422)

    # NO RAW ERRORS — one handler for everything that escapes a route.
    # FastAPI's own HTTPException handler is untouched, so those 4xx
    # contracts are unchanged.
    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        error_id = uuid.uuid4().hex[:12]
        logger.exception(
            "[server] unhandled error %s on %s %s",
            error_id, request.method, request.url.path,
        )
        return JSONResponse(
            {
                "error": {
                    "code": "internal_error",
                    "id": error_id,
                    "message": (
                        "Something went wrong on our side. Quote this "
                        "reference if you contact support."
                    ),
                }
            },
            status_code=500,
            headers=dict(SECURITY_HEADERS),
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
    # FORECAST — the driver-based linked three-statement projection
    # over ONE persisted period. Every figure it returns is
    # PROJECTED and says so in the payload; the frontend reads it
    # through `lib/forecastFacts.ts`, whose opaque `ProjectedMinor`
    # type makes mixing a projection into an actual a compile
    # error. See `_forecast_routes.py` for why refusals are the
    # product here and not an error path.
    app.include_router(create_forecast_router())
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
    # ─── PUBLIC MARKETS — MOUNTED ONLY WHEN EXPLICITLY ENABLED ───
    #
    # NASDAQ-6 — public-company routes (/api/public/search,
    # /api/public/companies/:ticker, /api/public/companies/:ticker/sync,
    # /api/public/health) and the AI Intelligence layer (risk radar,
    # exposure, scoring, signals, market-read narrative,
    # /api/public/intelligence/*). Both reach paid providers and, on the
    # market-read path, a model. Public Companies is hidden at launch, so
    # the surface is not mounted at all; `_build_public_markets_wall_router`
    # below answers every one of those paths with a stable JSON 404.
    if _public_markets_enabled():
        app.include_router(create_public_company_router())
        app.include_router(create_intelligence_router())
    # PUBLIC RO STOREFRONT — server-rendered company pages built from the
    # Ministry of Finance open datasets (public_summary class: summary
    # level, never a trial-balance analysis, no AI on the default path).
    # Serves BOTH the clean paths (/companii/…, /sitemap.xml, /og/…) and
    # the /api/public/ro/* twins, so every route works through the
    # EXISTING Caddy /api/* matcher before the operator adds a clean-path
    # matcher. Import is guarded: a partially-provisioned deployment
    # (no public_ro.db yet) must never take the whole API down.
    try:
        from engine.public_ro.pages.router import build_router as _public_ro_router
        app.include_router(_public_ro_router())
    except Exception:  # noqa: BLE001 — storefront is additive, never fatal
        logger.exception("[server] public RO storefront not mounted")
    # GLOBAL PUBLIC MARKETS — /api/public/markets/* (the market registry
    # with per-market status, and one company's pm1 document per market).
    # A SIBLING document class of public_summary: status PUBLIC_MARKET,
    # never entering packs / reconcile / consensus, every figure carrying
    # its own provenance from a deterministic feed. Import is guarded for
    # the same reason as the RO storefront above: a partially-provisioned
    # deployment (no public_market.db yet, a half-landed sibling lane)
    # must never take the whole API down.
    #
    # Behind the SAME flag as the rest of the markets surface: it is the
    # other half of the hidden Public Companies product.
    if _public_markets_enabled():
        try:
            from engine.public_market.router import build_router as _public_market_router
            app.include_router(_public_market_router())
        except Exception:  # noqa: BLE001 — additive surface, never fatal
            logger.exception("[server] public market surface not mounted")
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
    # F6.0.4 — per-user dashboard card layout (GET/PUT /api/dashboard/config).
    # Mounted 2026-07-26 per _dashboard.py's own deploy checklist: the FE
    # (frontend/lib/dashboard/configApi.ts) has been calling it on every
    # dashboard mount and taking a 404 each time, which is harmless (it falls
    # back to localStorage) but printed a console error per load.
    # Safe without schema_phase_dashboard_config.sql applied: GET degrades to
    # {"cards": []} when the table is missing and PUT returns 503, so the FE
    # simply stays device-local — the same outcome as the 404, minus the noise.
    app.include_router(create_dashboard_router())
    # THE CAPSULE — read-only tool layer for the inline AI surface
    # (GET /api/capsule/tools, POST /api/capsule/tools/{name}). The
    # registry is a frozen allowlist of eight READS; there is no route
    # here that mutates anything (see _capsule_tools.py's C2 contract).
    app.include_router(create_capsule_router())
    # ─── THE PDF RENDERER'S DOOR ───────────────────────────────────
    #
    # POST /api/report/pdf + its two polls. Mounted UNCONDITIONALLY, and
    # deliberately so: every route inside checks `PDF_SERVICE_TOKEN` and
    # answers 503 "PDF rendering is not configured on this deployment"
    # when it is unset. That is a better answer than a 404 — a 404 tells
    # an operator the build is old, a 503 with that sentence tells them
    # exactly which environment variable to set. Mounting behind a flag
    # would trade that sentence for the ambiguity.
    #
    # The renderer itself is `cfo-ai-pdf`, on the compose `default`
    # network only, so THIS is the only path from a browser to it and the
    # JWT check inside is the whole access-control story. See
    # `docker-compose.yml`'s header for the three walls.
    app.include_router(create_report_pdf_router())
    # ─── THE FIRM COCKPIT — MOUNTED ONLY WHEN EXPLICITLY ENABLED ───
    #
    # The Cockpit backend ships COMPLETE and OFF. `FIRM_COCKPIT_ENABLED`
    # is unset in production, so `create_app()` mounts no /api/firm route
    # and every one of them is a 404 — the launch posture (the Cockpit is
    # hidden until its post-launch pass lands). The code is committed, its
    # gates run against a create_app() built with the flag set, and
    # enabling the surface is one environment variable, not a deploy of
    # new code. Absent the flag there is no surface to wall, which is the
    # only wall no critic can get past.
    # ANOMALY RADAR — /api/radar/{period_id} and its dismissal routes.
    # Behind its own flag; unset, the whole surface is absent rather than
    # half-present. The DETECTOR families inside it carry a SECOND flag
    # (RADAR_DETECTORS_ENABLED, read in `_radar.py`), so the surface can
    # be turned on without them and turned on with them separately.
    if _anomaly_radar_enabled():
        # Imported here, not at module scope: the radar package pulls the
        # explanation lane and the detector pack loader, and a
        # partially-provisioned deployment must not fail to boot over a
        # surface it does not serve.
        from ._radar import build_router as create_radar_router
        app.include_router(create_radar_router())

    if _firm_cockpit_enabled():
        # IMPORTED HERE, NOT AT MODULE SCOPE — this took the site down.
        # These four imports used to sit beside the others at the top of
        # the file, so `import engine.api.server` REQUIRED the whole firm
        # package on disk even with the Cockpit off. On 2026-09-05 a
        # deploy shipped this file without those modules and every worker
        # died at import with `ModuleNotFoundError: No module named
        # 'engine.api._firm'` — 45 s of 502 on every route, the §14
        # restart-loop shape, from a change that touched neither the firm
        # code nor the mount. A surface that is off must cost nothing to
        # deploy: with the flag unset, nothing under `engine.api._firm*`
        # is read, so this module deploys on its own.
        # Gated by test_firm_real_app.py::
        # test_the_server_module_imports_no_firm_module_when_the_cockpit_is_off.
        from ._firm import build_router as create_firm_router
        from ._firm_brief import build_router as create_firm_brief_router
        from ._firm_attention import build_router as create_firm_attention_router
        from ._firm_requests import build_router as create_firm_requests_router

        # THE FIRM MODEL — /api/firm/* (firms, roles-as-data, client
        # assignments, invitations, CSV import). Every route: JWT → firm
        # membership (403) → role-matrix cell (403) → client-of-this-firm
        # (403) → the caller's own RLS-scoped read. See _firm.py (FC1 gate:
        # tests/engine/test_firm_tenancy.py). Requires schema_phase_firm.sql.
        app.include_router(create_firm_router())
        # FIRM COCKPIT (backend) — the file-request flow (signed single-use
        # upload links that land through the NORMAL pipeline), per-client
        # cadence + stale verdicts, digest preferences + cron, and the
        # firm email queue drain. Deterministic; no model anywhere in it.
        # See _firm_requests.py (FC7 gate: tests/engine/test_firm_gates.py).
        # Requires schema_phase_firm_requests.sql.
        app.include_router(create_firm_requests_router())
        # FIRM COCKPIT — "Brief me": the ONE AI role in the cockpit. Advisory
        # only: the deterministic order is computed first and the model's
        # prose is numeral-guarded; a dead model yields the deterministic
        # brief with a notice (FC8 gate). Mount asserts structurally that no
        # model is reachable from the ranking path (engine.firm.digest).
        app.include_router(create_firm_brief_router())
        # FIRM ATTENTION — /api/firm/attention* (deterministic attention items,
        # suppression with reason). See _firm_attention.py (FC2/FC4/FC5/FC9
        # gates: tests/engine/test_firm_attention.py). Requires
        # schema_phase_firm_attention.sql.
        app.include_router(create_firm_attention_router())

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

    # ─── Session log ────────────────────────────────────────────────────
    #
    # The comment that used to sit here read: "No auth (the frontend calls
    # these on every page load) — the data is intentionally low-sensitivity
    # (name + IP last octet + last-seen timestamp)." Two of those three
    # claims were false. Measured on the live site 2026-09-05 with a bare
    # curl and no bearer:
    #
    #   GET /api/sessions -> 200 {"count":1,"sessions":[{"name":"alex 3",
    #     "ip":"82.76.35.223","user_agent":"Mozilla/5.0 (Macintosh; …)",
    #     "first_seen":"2026-05-18T…","visit_count":33}]}
    #
    # The whole address, not an octet; the device string too. A name beside
    # an IP address is personal data under GDPR Art. 4(1) (an IP address is
    # so on its own — Breyer, C-582/14), published to anyone who asked.
    #
    # WHY THE OPERATOR BEARER AND NOT "the caller's own sessions".
    # `session_log` is keyed by (name, ip) and carries NO user column, so
    # "mine" cannot be told from "someone who typed the same name" — and a
    # scoping rule that cannot be told truthfully is not a wall, it is a
    # guess. The honest options were an operator wall today or a migration
    # to add the linkage; the leak is live, so this takes the wall. The
    # reader has no caller either way: `fetchSessions` in
    # frontend/lib/identity.ts is dead code (zero call sites), so nothing
    # regresses. If cross-user awareness is ever wanted back, it needs the
    # user column first.
    #
    # /track stays anonymous on purpose — the frontend posts it on every
    # page load, before any session exists — but it no longer trusts the
    # caller for the address (see below).

    @app.post("/api/sessions/track")
    def track_session(payload: SessionTrackRequest, request: Request) -> Dict[str, Any]:
        # The RIGHTMOST forwarded hop. Caddy fronts this backend with a bare
        # `reverse_proxy` and therefore APPENDS the real peer to whatever the
        # caller already put in the header, so index 0 is attacker-written.
        # Reading it meant a caller chose the address we stored — and, until
        # the wall above, the address we then served to the public. This is
        # the defect CLAUDE.md §21 repaired in `public_ro.ratelimit`,
        # `public_ro.funnel` and `public.refresh_shield` on 2026-09-04; this
        # module was not swept then. One helper, no fourth copy.
        ip = _rightmost_forwarded_hop(request)
        ua = (request.headers.get("user-agent") or "")[:256]
        return adapter.upsert_session(name=payload.name, ip=ip, user_agent=ua)

    @app.get("/api/sessions")
    def list_sessions(request: Request, limit: int = 50) -> Dict[str, Any]:
        _require_operator(request, route="GET /api/sessions")
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
