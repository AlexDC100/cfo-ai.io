"""FastAPI router for the public-company surface (/api/public/*).

Wired into src/engine/api/server.py via `app.include_router(build_router())`.
Same shape as the other router modules in engine/api/.

Routes:
  GET  /api/public/health                  → key configured? subscription tier?
  GET  /api/public/search?q=AAPL           → search results (CACHED + EGRESS-GUARDED)
  GET  /api/public/companies/{ticker}      → full envelope (CACHED + EGRESS-GUARDED)
  GET  /api/public/universe                → universe table (EGRESS-GUARDED)
  GET  /api/public/companies/{t}/price-history → chart series (EGRESS-GUARDED)
  POST /api/public/companies/{ticker}/sync → force refresh (SHIELDED)
  POST /api/public/companies/{ticker}/refresh → bust caches (SHIELDED)
  POST /api/public/companies/compare       → local-only peer bundle (public)

§24 contract: every error path returns a stable JSON envelope:
  {"error": {"code": "nasdaq_xxx", "message": "<user-facing>", "details": {…}}}
so the FE can switch on `.error.code` to pick the right empty-state component.

EGRESS (2026-09-04). The 2026-09-04 POST-surface wave classified only
mutating methods, and that filter was itself the blind spot: the two
routes it shielded reach upstream ZERO times per call, while four
anonymous GETs here reached it on EVERY call. MEASURED in-process against
the real ``create_app()`` with every outbound socket blocked and recorded,
Nasdaq key configured (the production shape):

    GET /companies/{ticker}      1 data.nasdaq.com per call, NO CACHE AT ALL
    GET /search?q=               1 data.nasdaq.com per call, NO CACHE AT ALL
    GET /universe (cold)         2 data.nasdaq.com + 5 query1.finance.yahoo.com
    GET /universe?refresh=true   the same, on EVERY call — the cache cannot
                                 absorb a repeat once the caller opts out of it
    GET .../price-history        1 cold, then 0 — the cache worked already
    GET .../price-history?refresh=true     1 on EVERY call

Both missing caches are added below and both ``?refresh=true`` paths now
go through ``refresh_shield.allow_forced_refresh``. See that module's
docstring for the budgets and the measurements they come from.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from . import pipeline
# Cache-bust shield (rate limit + operator bearer). MODULE scope on purpose:
# this file uses `from __future__ import annotations`, so anything FastAPI has
# to resolve from an endpoint signature must be visible in module globals.
from .refresh_shield import allow_forced_refresh as _allow_forced_refresh
from .refresh_shield import egress_guard as _egress_guard
from .refresh_shield import guard as _refresh_guard
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

# The SHAPE of a ticker, checked before any provider is asked about one.
# This surface serves Sharadar's whole TICKERS table, so membership cannot
# be decided locally — the provider is the authority on whether a
# well-formed symbol exists (that lookup is ONE call, cached below, and
# its negative answer is cached too). What CAN be refused for free is
# everything that is not shaped like a symbol at all: MEASURED, a 200-char
# string and a path-traversal string each reached data.nasdaq.com as a
# TICKERS query. Every ticker in the served universe (203 NASDAQ + 88 BVB,
# longest 8 chars, e.g. BRK.B / EL.BVB) matches this.
_TICKER_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,15}$")


def _well_formed_ticker(raw: str) -> str:
    """Uppercase, or 400. Costs nothing; runs before every guard."""
    t = (raw or "").strip().upper()
    if not _TICKER_RE.match(t):
        raise HTTPException(
            400,
            "Not a ticker symbol: %r (letters, digits, '.' or '-', at most "
            "16 characters). Nothing was requested from any provider." % (raw or "")[:40],
        )
    return t


def _error_response(err: NasdaqError) -> JSONResponse:
    """Translate a typed Nasdaq exception → §24-compliant JSON envelope."""
    return JSONResponse(
        status_code=err.http_status,
        content={"error": err.to_dict()},
    )


# ── The two caches that did not exist ────────────────────────────────────
#
# ``/companies/{ticker}`` and ``/search`` were the only two public reads
# with NO cache of any kind: one anonymous GET was one provider call,
# forever, and a repeat cost exactly as much as the first (MEASURED: 4/4
# calls reached data.nasdaq.com). Their siblings (`universe_service`,
# `price_history_service`) have had an in-process warm cache since
# PUB-200; these two simply never got one.
#
# TTL — 300 s, the SAME number as ``universe_service.LIVE_TTL_SECONDS``,
# for the same reason it was chosen there: the envelope's market half
# comes from Sharadar DAILY, an end-of-day dataset that rolls over once a
# trading day, and its fundamentals half from SF1, which moves quarterly.
# A read fresher than 5 minutes cannot show anything the provider has not
# published. The TICKERS reference behind /search moves less often still,
# so it inherits the same figure rather than a looser one — one number is
# easier to keep honest than two.
#
# BOUNDED, because the key is caller-supplied: both routes accept an
# arbitrary ticker / query string, so an unbounded dict is a memory leak a
# loop can drive. Stalest-half eviction, the same shape as
# ``ratelimit.TokenBucketLimiter._maybe_evict``.
_READ_TTL_SECONDS: int = 5 * 60
_MAX_CACHE_KEYS = 20_000

_company_cache: Dict[str, Dict[str, Any]] = {}
_search_cache: Dict[str, Dict[str, Any]] = {}


def _cache_get(store: Dict[str, Dict[str, Any]], key: str) -> Optional[Any]:
    entry = store.get(key)
    if not entry:
        return None
    if (time.time() - entry["_cached_at"]) >= _READ_TTL_SECONDS:
        return None
    return entry["payload"]


def _cache_put(store: Dict[str, Dict[str, Any]], key: str, payload: Any) -> None:
    store[key] = {"_cached_at": time.time(), "payload": payload}


# A provider's "no such ticker" is cached exactly like a hit, under the same
# TTL. Without this a well-formed unknown symbol cost one TICKERS lookup on
# EVERY call — the one shape of caller text this route cannot validate
# locally was the one shape the cache did not hold. The marker is a dict
# with this single key so a cached miss can never be mistaken for an
# envelope; ``get_company`` turns it back into the same 404 the provider
# gave. ``clear_read_caches`` drops it with everything else.
_NOT_FOUND = "__nasdaq_not_found__"


def _is_not_found(payload: Any) -> bool:
    return isinstance(payload, dict) and _NOT_FOUND in payload
    if len(store) > _MAX_CACHE_KEYS:
        by_age = sorted(store.items(), key=lambda kv: kv[1]["_cached_at"])
        for k, _ in by_age[: len(by_age) // 2]:
            store.pop(k, None)


def _company_key(ticker: str, dimension: str, limit: int) -> str:
    return "%s::%s::%d" % ((ticker or "").strip().upper(), dimension, limit)


def _search_key(q: str, limit: int) -> str:
    return "%s::%d" % ((q or "").strip().upper(), limit)


def clear_read_caches(*, ticker: Optional[str] = None) -> None:
    """Drop the company-envelope + search caches.

    ``ticker`` narrows the company half to one symbol — used by
    ``POST /companies/{ticker}/sync``, which is what the FE's refresh
    button actually calls: without this a sync would pull fresh data
    upstream and the reload right behind it would still be served the
    pre-sync envelope, so the button would look broken.
    """
    if ticker:
        t = ticker.strip().upper()
        for key in [k for k in _company_cache if k.startswith("%s::" % t)]:
            _company_cache.pop(key, None)
        return
    _company_cache.clear()
    _search_cache.clear()


def _pipeline_health_payload(adapter, request):  # type: (Any, Any) -> Dict[str, Any]
    """The health body. Credential and quota detail ONLY for an operator.

    Measured on the live site 2026-09-05, anonymous, no bearer:

        GET /api/public/health -> {"service":"public-company-pipeline",
          "key_configured":true,"key_tag":"key=ttAK…",
          "daily_budget_remaining":3997}

    A credential prefix narrows a brute force and confirms which provider
    account is in use; a remaining-budget counter tells an attacker exactly
    how much of our paid quota is left to burn and when it resets. Neither
    is needed by the only consumer: the frontend renders the search form on
    `key_configured` alone (PublicCompanySearchPage). So the boolean stays
    anonymous and the detail moves behind the operator bearer, which is a
    narrowing of the payload, not of the route — the probe still answers 200
    to anyone, because the frontend calls it on mount with no bearer.

    A WRONG bearer is treated as anonymous here rather than refused: there
    is no credential to leak by guessing and answering 401 would make this
    an oracle for token probing (the same reasoning `refresh_shield.guard`
    applies to its shielded routes).
    """
    body = {
        "service": "public-company-pipeline",
        "key_configured": adapter.available,
    }
    try:
        from engine.public.refresh_shield import has_operator_bearer
        privileged = bool(has_operator_bearer(request))
    except Exception:
        privileged = False
    if privileged:
        body["key_tag"] = adapter.key_tag
        body["daily_budget_remaining"] = max(
            0, adapter._daily_budget_cap - adapter._calls_today
        )
    return body


def build_router() -> APIRouter:
    router = APIRouter(prefix="/api/public", tags=["public-companies"])

    # ── /api/public/health ─────────────────────────────────────────────
    #
    # Cheap probe the FE can hit on PublicCompanySearchPage mount to
    # decide whether to render the search form (key configured) or the
    # "Nasdaq API key is not configured" state. Doesn't burn API budget
    # — just checks the env var.

    @router.get("/health")
    def health(request: Request) -> Dict[str, Any]:
        return _pipeline_health_payload(pipeline.get_adapter(), request)

    # ── /api/public/search?q= ──────────────────────────────────────────
    #
    # Reference search over the Sharadar TICKERS table. Works on the free
    # Nasdaq Data Link tier — does NOT require SF1 subscription.

    @router.get("/search")
    def search(
        request: Request,
        q: str = Query("", description="Ticker or company-name fragment"),
        limit: int = Query(20, ge=1, le=100),
    ) -> Dict[str, Any]:
        """CACHED + EGRESS-GUARDED (2026-09-04).

        This route had no cache: MEASURED, four identical anonymous GETs
        made four calls to data.nasdaq.com. It is reached from
        PublicCompanySearchPage's 300 ms-debounced box, so a single user
        refining a query fires several distinct prefixes — each one a
        distinct cache key and therefore a real cold read. That is why the
        cold-read budget is 120/min and not the bust budget's 5: a typing
        session must not 429. Repeats are now free, which is what makes the
        common case (many visitors searching the same names) cost nothing.
        """
        key = _search_key(q, limit)
        cached = _cache_get(_search_cache, key)
        limited = _egress_guard(
            request, route="/api/public/search", warm=cached is not None)
        if limited is not None:
            return limited  # type: ignore[return-value]
        if cached is not None:
            return cached
        try:
            hits = pipeline.search_companies(q, limit=limit)
            payload = {"query": q, "count": len(hits), "results": hits}
            _cache_put(_search_cache, key, payload)
            return payload
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
        request: Request,
        dimension: str = Query("ARY", description="ARY/ARQ/ART/MRY/MRQ/MRT"),
        limit: int = Query(20, ge=1, le=100),
    ) -> Dict[str, Any]:
        """CACHED + EGRESS-GUARDED (2026-09-04).

        This route HAD NO CACHE AT ALL. One anonymous GET was one provider
        call, forever — MEASURED, four identical calls made four requests
        to data.nasdaq.com — and it is the single request the company
        dashboard page fires (PublicCompanyDashboard.tsx -> getPublicCompany),
        so it is also the most-loaded read on the surface. Each call can
        spend up to three provider requests inside ``get_company_envelope``
        (TICKERS search + SF1 fundamentals + DAILY metrics), which is why
        it is cached rather than merely limited.

        ``synced_at`` inside the envelope is the ORIGINAL fetch time, not
        the time of this response — a cached read must not claim to have
        synced now. That falls out of caching the whole payload, and the
        gate pins it.
        """
        if dimension not in VALID_DIMENSIONS:
            raise HTTPException(400, f"Invalid dimension {dimension!r}; must be one of {sorted(VALID_DIMENSIONS)}")
        ticker = _well_formed_ticker(ticker)
        key = _company_key(ticker, dimension, limit)
        cached = _cache_get(_company_cache, key)
        limited = _egress_guard(
            request, route="/api/public/companies/{ticker}",
            warm=cached is not None)
        if limited is not None:
            return limited  # type: ignore[return-value]
        if cached is not None:
            if _is_not_found(cached):
                return JSONResponse(status_code=404, content=cached[_NOT_FOUND])  # type: ignore[return-value]
            return cached
        try:
            envelope = pipeline.get_company_envelope(
                ticker,
                dimension=dimension,  # type: ignore[arg-type]
                limit=limit,
            )
            _cache_put(_company_cache, key, envelope)
            return envelope
        except NasdaqNotFound as e:
            _cache_put(_company_cache, key, {_NOT_FOUND: {"error": e.to_dict()}})
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
        request: Request,
        dimensions: Optional[str] = Query(
            None,
            description="Comma-separated dimensions (default: ARY,ARQ)",
        ),
    ) -> Dict[str, Any]:
        """SHIELDED (engine.public.refresh_shield) — the strongest upstream
        amplifier on the public surface.

        Unlike /refresh next door, this route does not merely make the next
        read cold: `pipeline.sync_company` calls `get_company_envelope` once
        per requested dimension, and each of those pulls TICKERS + SF1 +
        DAILY from the provider inside this handler, spending the adapter's
        metered daily budget. Anonymous and unbounded until 2026-09-04.

        It is SHIELDED rather than WALLED because it is a live user surface:
        `PublicCompanyDashboard.tsx`'s refresh button calls it via
        `syncPublicCompany`. Failing closed on an unset token would break
        that button for every visitor to protect a provider quota, which is
        the wrong trade — the opposite of the two WALLED operator routes in
        the intelligence router. The guard runs BEFORE any provider call, so
        a 429 spends nothing upstream, and it shares ONE bucket with the
        other shielded routes so a loop cannot alternate between them.
        """
        ticker = _well_formed_ticker(ticker)
        limited = _refresh_guard(request, route="/api/public/companies/{ticker}/sync")
        if limited is not None:
            return limited  # type: ignore[return-value]
        dims_list = None
        if dimensions:
            requested = [d.strip().upper() for d in dimensions.split(",") if d.strip()]
            invalid = [d for d in requested if d not in VALID_DIMENSIONS]
            if invalid:
                raise HTTPException(400, f"Invalid dimensions {invalid}; must be subset of {sorted(VALID_DIMENSIONS)}")
            dims_list = requested  # type: ignore[assignment]
        try:
            result = pipeline.sync_company(ticker, dimensions=dims_list)
        except NasdaqNotFound as e:
            return _error_response(e)  # type: ignore[return-value]
        except NasdaqKeyMissing as e:
            return _error_response(e)  # type: ignore[return-value]
        except NasdaqError as e:
            return _error_response(e)  # type: ignore[return-value]
        # The envelope cache added on 2026-09-04 has to be dropped HERE, and
        # only on the success path. The FE's refresh button is
        # `syncPublicCompany(ticker)` immediately followed by
        # `getPublicCompany(ticker)`; without this the sync would pull fresh
        # data and the reload right behind it would still be served the
        # pre-sync envelope for up to 5 minutes, so the button would look
        # broken. Dropped only for THIS ticker — a sync says nothing about
        # anyone else's data.
        clear_read_caches(ticker=ticker)
        return result

    # ── PUB-UPG (Public Companies massive upgrade) ─────────────────────
    #
    # Universe + sectors endpoints. Power the new 54-row table on
    # /public-companies. Both routes are open (no JWT) so anonymous
    # landing-page visitors who clicked a Quick try ticker chip can
    # see the table without signing up. The universe service handles
    # live-vs-demo fallback per-ticker.

    @router.get("/universe")
    def get_universe(
        request: Request,
        dimension: str = Query("ARY", description="ARY/ARQ/ART/MRY/MRQ/MRT"),
        refresh: bool = Query(False, description="Bust the warm cache (bounded)"),
    ) -> Dict[str, Any]:
        """EGRESS-GUARDED (2026-09-04), and ``refresh`` is now bounded.

        MEASURED: a cold read costs 7 outbound (2 data.nasdaq.com batch
        calls over 203 tickers + 5 query1.finance.yahoo.com spark calls
        over 88 BVB tickers); a repeat inside LIVE_TTL_SECONDS costs 0.
        ``?refresh=true`` opted out of that cache, so it cost 7 then 2 on
        EVERY call — a cache a caller can switch off with a query
        parameter is not a control.

        ``refresh`` is the same act as ``POST /companies/{t}/refresh``, so
        it spends the same bust token. Refused, the parameter is IGNORED
        and the warm payload is served with ``refresh_honored: false``
        rather than a 429: the caller asked for the universe and the cache
        can answer that honestly. No frontend call site passes ``refresh``
        (``fetchUniverse``'s ``opts.refresh`` is never set), so nothing a
        real visitor does is affected either way.
        """
        if dimension not in VALID_DIMENSIONS:
            raise HTTPException(
                400,
                f"Invalid dimension {dimension!r}; must be one of {sorted(VALID_DIMENSIONS)}",
            )
        from .universe_service import get_universe as _get_universe
        from .universe_service import is_warm as _universe_warm
        forced = bool(refresh) and _allow_forced_refresh(
            request, route="/api/public/universe")
        warm = _universe_warm(dimension=dimension) and not forced
        limited = _egress_guard(
            request, route="/api/public/universe", warm=warm)
        if limited is not None:
            return limited  # type: ignore[return-value]
        payload = _get_universe(dimension=dimension, force_refresh=forced)
        if refresh:
            payload = dict(payload)
            payload["refresh_honored"] = forced
            if not forced:
                payload["refresh_message"] = (
                    "refresh=true was NOT honored — this client is over the "
                    "cache-refresh budget. Nothing was fetched from any "
                    "provider; the cached universe is returned unchanged."
                )
        return payload

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
    def status(request: Request) -> Dict[str, Any]:
        """Alias for /health using the spec-aligned name."""
        return _pipeline_health_payload(pipeline.get_adapter(), request)

    @router.get("/companies/{ticker}/price-history")
    def price_history(
        ticker: str,
        request: Request,
        range: str = Query(
            "1Y",
            description="1D | 5D | 1M | 6M | YTD | 1Y | 5Y | MAX",
        ),
        refresh: bool = Query(False, description="Bust the per-range cache (bounded)"),
    ) -> Dict[str, Any]:
        """Return a chart-ready price-history payload for `ticker` at
        the requested range. Never raises — falls back to demo synth
        when SEP isn't entitled or the ticker has no live data.

        EGRESS-GUARDED (2026-09-04). This is the most-repeated read on the
        surface: MEASURED, the markets overview renders 24 grid tiles and
        each one fetches ``range=1M`` for its own ticker, so ONE page load
        is 24 calls here — 24 outbound cold, 0 warm. That measurement is
        where the 120/min cold-read budget comes from; the bust budget of
        5 would have 429'd the page at tile 6. ``?refresh=true`` bypassed
        the cache on every call and is now bounded exactly like
        ``/universe``'s, with the same honest downgrade instead of a 429.
        """
        from .price_history_service import VALID_RANGES, get_price_history
        from .price_history_service import is_warm as _price_warm
        r = (range or "1Y").upper()
        if r not in VALID_RANGES:
            raise HTTPException(
                400,
                f"Invalid range {range!r}; must be one of {sorted(VALID_RANGES)}",
            )
        ticker = _well_formed_ticker(ticker)
        forced = bool(refresh) and _allow_forced_refresh(
            request, route="/api/public/companies/{ticker}/price-history")
        warm = _price_warm(ticker, range=r) and not forced
        limited = _egress_guard(
            request,
            route="/api/public/companies/{ticker}/price-history",
            warm=warm,
        )
        if limited is not None:
            return limited  # type: ignore[return-value]
        payload = get_price_history(ticker, range=r, force_refresh=forced)
        if refresh:
            payload = dict(payload)
            payload["refresh_honored"] = forced
            if not forced:
                payload["refresh_message"] = (
                    "refresh=true was NOT honored — this client is over the "
                    "cache-refresh budget. Nothing was fetched from any "
                    "provider; the cached series is returned unchanged."
                )
        return payload

    @router.post("/companies/{ticker}/refresh")
    def refresh_company(ticker: str, request: Request) -> Dict[str, Any]:
        """Force-bust caches for one ticker — universe warm cache (so
        the table re-pulls live SF1 next render) + price-history cache
        for every range. Doesn't trigger a fetch itself; the next read
        will hit the live providers.

        SHIELDED (engine.public.refresh_shield): a valid ENGINE_API_TOKEN
        bearer is never limited; anonymous callers spend one token from a
        per-client bucket and get 429 + Retry-After over the budget. The
        guard runs BEFORE any cache is touched, so a 429 mutates nothing.
        With the token unset the bearer path is simply unavailable and the
        anonymous path still serves — deliberately NOT the fail-closed
        contract of tests/engine/test_cron_auth.py; see the shield's
        module docstring for why the asymmetry is intended.

        SCOPE, stated because it is narrower than it reads: this clears the
        two caches it NAMES and no others. The company-envelope and search
        caches added on 2026-09-04 are deliberately left alone here — this
        response body is pinned byte-for-byte by
        tests/engine/test_public_refresh_shield.py::
        test_under_the_budget_the_payloads_are_byte_for_byte_unchanged, and
        a route that clears a cache it does not list would make
        ``refreshed`` a false claim. Those two are bounded by their own
        300 s TTL and are dropped per-ticker by ``POST /sync``, which is
        the route the FE's refresh button actually calls. Widening
        ``refreshed`` and that pinned assertion together is an owner
        decision, not a silent one.
        """
        ticker = _well_formed_ticker(ticker)
        limited = _refresh_guard(request, route="/api/public/companies/{ticker}/refresh")
        if limited is not None:
            return limited  # type: ignore[return-value]
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

        PUBLIC BY DESIGN — deliberately neither walled nor shielded, and
        that is a measured decision rather than an oversight. It writes
        nothing, and it reaches no upstream: `universe.universe_meta()` is a
        comprehension over the in-module DEFAULT_UNIVERSE tuple and
        `demo_universe.demo_snapshot_for` is a dict lookup in a static
        table. Work per call is bounded by the 20-ticker cap enforced above,
        so the worst an anonymous loop achieves is ordinary CPU on a route
        that is cheaper than the GET pages beside it. Adding a limiter here
        would spend the shared cache-bust budget on calls that cost no
        provider quota. Pinned by tests/engine/test_public_post_surface.py.
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


__all__ = ["build_router", "clear_read_caches"]
