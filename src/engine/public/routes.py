"""FastAPI router for the public-company surface (/api/public/*).

Wired into src/engine/api/server.py via `app.include_router(build_router())`.
Same shape as the other router modules in engine/api/.

Routes:
  GET  /api/public/health                  → key configured? subscription tier?
  GET  /api/public/search?q=AAPL           → search results (free tier endpoint)
  GET  /api/public/companies/{ticker}      → full envelope (needs SF1 for periods)
  POST /api/public/companies/{ticker}/sync → force refresh

§24 contract: every error path returns a stable JSON envelope:
  {"error": {"code": "nasdaq_xxx", "message": "<user-facing>", "details": {…}}}
so the FE can switch on `.error.code` to pick the right empty-state component.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from . import pipeline
from .adapter import Dimension
from .errors import (
    NasdaqEntitlementError,
    NasdaqError,
    NasdaqKeyMissing,
    NasdaqNotFound,
    NasdaqRateLimited,
)

logger = logging.getLogger(__name__)

VALID_DIMENSIONS = {"ARY", "ARQ", "ART", "MRY", "MRQ", "MRT"}


def _error_response(err: NasdaqError) -> JSONResponse:
    """Translate a typed Nasdaq exception → §24-compliant JSON envelope."""
    return JSONResponse(
        status_code=err.http_status,
        content={"error": err.to_dict()},
    )


def build_router() -> APIRouter:
    router = APIRouter(prefix="/api/public", tags=["public-companies"])

    # ── /api/public/health ─────────────────────────────────────────────
    #
    # Cheap probe the FE can hit on PublicCompanySearchPage mount to
    # decide whether to render the search form (key configured) or the
    # "Nasdaq API key is not configured" state. Doesn't burn API budget
    # — just checks the env var.

    @router.get("/health")
    def health() -> Dict[str, Any]:
        adapter = pipeline.get_adapter()
        return {
            "service": "public-company-pipeline",
            "key_configured": adapter.available,
            "key_tag": adapter.key_tag,
            "daily_budget_remaining": max(0, adapter._daily_budget_cap - adapter._calls_today),
        }

    # ── /api/public/search?q= ──────────────────────────────────────────
    #
    # Reference search over the Sharadar TICKERS table. Works on the free
    # Nasdaq Data Link tier — does NOT require SF1 subscription.

    @router.get("/search")
    def search(
        q: str = Query("", description="Ticker or company-name fragment"),
        limit: int = Query(20, ge=1, le=100),
    ) -> Dict[str, Any]:
        try:
            hits = pipeline.search_companies(q, limit=limit)
            return {"query": q, "count": len(hits), "results": hits}
        except NasdaqKeyMissing as e:
            return _error_response(e)  # type: ignore[return-value]
        except NasdaqRateLimited as e:
            return _error_response(e)  # type: ignore[return-value]
        except NasdaqError as e:
            return _error_response(e)  # type: ignore[return-value]

    # ── /api/public/companies/{ticker} ─────────────────────────────────
    #
    # Full company envelope: TICKERS reference info + N periods of SF1
    # fundamentals + latest DAILY metrics, all wrapped per
    # assembled_canonical_v1. When SF1 isn't subscribed, returns the
    # envelope with periods=[] and subscription_required=true so the FE
    # can render the dashboard shell with the "Subscribe to Sharadar SF1"
    # empty state on financials tabs.

    @router.get("/companies/{ticker}")
    def get_company(
        ticker: str,
        dimension: str = Query("ARY", description="ARY/ARQ/ART/MRY/MRQ/MRT"),
        limit: int = Query(20, ge=1, le=100),
    ) -> Dict[str, Any]:
        if dimension not in VALID_DIMENSIONS:
            raise HTTPException(400, f"Invalid dimension {dimension!r}; must be one of {sorted(VALID_DIMENSIONS)}")
        try:
            envelope = pipeline.get_company_envelope(
                ticker,
                dimension=dimension,  # type: ignore[arg-type]
                limit=limit,
            )
            return envelope
        except NasdaqNotFound as e:
            return _error_response(e)  # type: ignore[return-value]
        except NasdaqKeyMissing as e:
            return _error_response(e)  # type: ignore[return-value]
        except NasdaqEntitlementError as e:
            return _error_response(e)  # type: ignore[return-value]
        except NasdaqRateLimited as e:
            return _error_response(e)  # type: ignore[return-value]
        except NasdaqError as e:
            return _error_response(e)  # type: ignore[return-value]

    # ── /api/public/companies/{ticker}/sync ────────────────────────────
    #
    # Force a refresh — useful when the FE wants to re-pull after a known
    # filing date. Returns sync stats for the "Syncing Nasdaq data…"
    # overlay. Body is unused (POST chosen because it's an action with
    # side effects: API-budget consumption + future DB writes).

    @router.post("/companies/{ticker}/sync")
    def sync_company(
        ticker: str,
        dimensions: Optional[str] = Query(
            None,
            description="Comma-separated dimensions (default: ARY,ARQ)",
        ),
    ) -> Dict[str, Any]:
        dims_list = None
        if dimensions:
            requested = [d.strip().upper() for d in dimensions.split(",") if d.strip()]
            invalid = [d for d in requested if d not in VALID_DIMENSIONS]
            if invalid:
                raise HTTPException(400, f"Invalid dimensions {invalid}; must be subset of {sorted(VALID_DIMENSIONS)}")
            dims_list = requested  # type: ignore[assignment]
        try:
            return pipeline.sync_company(ticker, dimensions=dims_list)
        except NasdaqNotFound as e:
            return _error_response(e)  # type: ignore[return-value]
        except NasdaqKeyMissing as e:
            return _error_response(e)  # type: ignore[return-value]
        except NasdaqError as e:
            return _error_response(e)  # type: ignore[return-value]

    # ── PUB-UPG (Public Companies massive upgrade) ─────────────────────
    #
    # Universe + sectors endpoints. Power the new 54-row table on
    # /public-companies. Both routes are open (no JWT) so anonymous
    # landing-page visitors who clicked a Quick try ticker chip can
    # see the table without signing up. The universe service handles
    # live-vs-demo fallback per-ticker.

    @router.get("/universe")
    def get_universe(
        dimension: str = Query("ARY", description="ARY/ARQ/ART/MRY/MRQ/MRT"),
        refresh: bool = Query(False, description="Bust the 1h warm cache"),
    ) -> Dict[str, Any]:
        if dimension not in VALID_DIMENSIONS:
            raise HTTPException(
                400,
                f"Invalid dimension {dimension!r}; must be one of {sorted(VALID_DIMENSIONS)}",
            )
        from .universe_service import get_universe as _get_universe
        return _get_universe(dimension=dimension, force_refresh=refresh)

    @router.get("/sectors")
    def get_sectors() -> Dict[str, Any]:
        from .universe import sectors as _sectors
        return {"sectors": _sectors()}

    @router.get("/universe/search")
    def universe_search(
        q: str = Query("", description="Ticker or name fragment"),
        limit: int = Query(20, ge=1, le=100),
    ) -> Dict[str, Any]:
        from .universe_service import search_universe
        return {"query": q, "results": search_universe(q, limit=limit)}

    # ── PUB-200 endpoints ─────────────────────────────────────────────
    #
    # Backwards-compatible additions. `/status` is an alias for `/health`
    # (the spec's preferred name). `/price-history` powers the
    # StockPriceChart drawer. `/refresh` busts both the universe warm
    # cache and the price-history cache for a single ticker. `/compare`
    # bundles N tickers' snapshots into one payload for the side-by-side
    # peer view.

    @router.get("/status")
    def status() -> Dict[str, Any]:
        """Alias for /health using the spec-aligned name."""
        adapter = pipeline.get_adapter()
        return {
            "service": "public-company-pipeline",
            "key_configured": adapter.available,
            "key_tag": adapter.key_tag,
            "daily_budget_remaining": max(
                0, adapter._daily_budget_cap - adapter._calls_today
            ),
        }

    @router.get("/companies/{ticker}/price-history")
    def price_history(
        ticker: str,
        range: str = Query(
            "1Y",
            description="1D | 5D | 1M | 6M | YTD | 1Y | 5Y | MAX",
        ),
        refresh: bool = Query(False, description="Bust the per-range cache"),
    ) -> Dict[str, Any]:
        """Return a chart-ready price-history payload for `ticker` at
        the requested range. Never raises — falls back to demo synth
        when SEP isn't entitled or the ticker has no live data."""
        from .price_history_service import VALID_RANGES, get_price_history
        r = (range or "1Y").upper()
        if r not in VALID_RANGES:
            raise HTTPException(
                400,
                f"Invalid range {range!r}; must be one of {sorted(VALID_RANGES)}",
            )
        return get_price_history(ticker, range=r, force_refresh=refresh)

    @router.post("/companies/{ticker}/refresh")
    def refresh_company(ticker: str) -> Dict[str, Any]:
        """Force-bust caches for one ticker — universe warm cache (so
        the table re-pulls live SF1 next render) + price-history cache
        for every range. Doesn't trigger a fetch itself; the next read
        will hit the live providers."""
        from .price_history_service import clear_warm_cache as _clear_ph
        from .universe_service import clear_warm_cache as _clear_uni
        # The universe cache is universe-wide (not per-ticker); the
        # spec accepts that side-effect because forcing a single
        # ticker refresh always implies "the operator wants fresh
        # data right now".
        _clear_uni()
        _clear_ph()
        return {
            "ticker": (ticker or "").strip().upper(),
            "refreshed": ["universe_warm_cache", "price_history_cache"],
            "message": (
                "Caches cleared. The next read for this ticker will "
                "hit the configured providers (live SF1/SEP when "
                "entitled, demo fallback otherwise)."
            ),
        }

    @router.post("/companies/compare")
    def compare_companies(
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Multi-ticker side-by-side comparison. Bundles each ticker's
        latest snapshot (demo or live) into a single payload the FE
        can render in a comparison grid.

        Body shape:
            {"tickers": ["AAPL", "MSFT", "NVDA"]}

        Returns:
            {"tickers": [...], "rows": [snapshot, ...], "missing": [...]}
        """
        tickers = payload.get("tickers") or []
        if not isinstance(tickers, list):
            raise HTTPException(400, "Body must include `tickers: string[]`")
        if not tickers:
            raise HTTPException(400, "At least one ticker required")
        if len(tickers) > 20:
            raise HTTPException(400, "Up to 20 tickers per compare call")
        from .demo_universe import demo_snapshot_for
        from .universe import universe_meta
        meta = universe_meta()
        rows = []
        missing = []
        for raw in tickers:
            t = (str(raw) or "").strip().upper()
            if not t:
                continue
            m = meta.get(t)
            if not m:
                missing.append(t)
                continue
            rows.append(demo_snapshot_for(
                t,
                m.get("name") or t,
                m.get("sector") or "Unknown",
            ))
        return {
            "tickers": [str(t).upper() for t in tickers],
            "count": len(rows),
            "rows": rows,
            "missing": missing,
        }

    return router


__all__ = ["build_router"]
