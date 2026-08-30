# -*- coding: utf-8 -*-
"""THE aggregate public_market router — ``/api/public/markets/*``.

Mounts, on one APIRouter:
  - ``GET /api/public/markets``            the registry, with per-market
                                           status and what we actually hold
  - ``GET /api/public/markets/company/{market}/{ticker}``
                                           one company's pm1 document, or
                                           a typed refusal
  - sibling lanes' sub-routers, assembled via try/except ImportError so a
    partial lane state stays importable and mountable (the public_ro
    precedent — a half-landed wave must never take the API down).

WHAT THIS SURFACE PROMISES, AND WHAT IT REFUSES
-----------------------------------------------
Every number that leaves here came from a deterministic feed and carries
its own provenance. Nothing here calls a model, and there is no code path
where an absent figure becomes a rendered one.

The company route therefore has FOUR honest outcomes, and the status of
the market decides which:

  * ``live``               — resolve the ticker and serve the document.
  * ``fundamentals_only``  — 501 with ``code: MARKET_NOT_ADDRESSABLE``:
                             the feed has figures, but no ticker→filing
                             resolution exists for this market yet. The
                             body says exactly that, and names the feed,
                             so the gap reads as a roadmap item rather
                             than a broken page.
  * ``awaiting_provider``  — 501 with ``code: MARKET_AWAITING_PROVIDER``:
                             there is no feed. Saying "no data for AAPL"
                             here would imply we looked.
  * unknown market         — 404. Never coerced to a default market: a
                             default would attach the wrong currency and
                             the wrong licence to a real number.

A miss inside a live market is a plain 404 with ``code: NOT_CACHED`` —
this route READS the spine store; it never fetches from an external feed
on a web request (that is the ingest lane's job, rate-limited and
journaled). A serving surface that can trigger an outbound SEC call per
page view is a fair-access violation waiting for traffic.

PM7: nothing here touches ``public_ro`` / BVB. The ``ro`` registry row is
served in the market LIST (Romania leads the ordering) but its company
route deliberately refuses — the home market has its own storefront and
must never be answered twice, by two document classes, with two numbers.

Python 3.9: no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from engine.public_market import registry as _registry

logger = logging.getLogger("engine.public_market.router")

#: Route prefix. Sits beside /api/public/ro/* (the RO storefront) and
#: /api/public/companies/* (the NASDAQ-6 surface); no path collides.
PREFIX = "/api/public/markets"

#: Registry responses are safe to cache hard — the file changes on
#: deploy, not on traffic.
REGISTRY_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400"
#: Company documents change when a filing lands; an hour is the fair-access
#: friendly floor, and the served document carries its own as_of anyway.
COMPANY_CACHE_CONTROL = "public, max-age=900, stale-while-revalidate=86400"
ERROR_CACHE_CONTROL = "public, max-age=300"

#: Sibling lanes of this wave. Each entry is (module, factory) and each
#: is imported defensively: a lane that has not landed, or one that fails
#: to import in a partially-provisioned deployment, must not prevent the
#: spine's own routes from mounting.
#:
#: CONTRACT FOR SIBLING LANES: export a zero-argument factory returning a
#: FastAPI ``APIRouter`` whose paths are FULLY QUALIFIED (start with
#: ``/api/public/markets/…``). This aggregate router carries NO prefix of
#: its own — the public_ro precedent — precisely so an included lane owns
#: its complete URL space and one grep for a path finds the code that
#: serves it. A router that carried a prefix here would silently double
#: it onto every sub-router that also declared one.
_SUB_ROUTERS: Tuple[Tuple[str, str], ...] = (
    # Prices / quote surface (keyless today; self-activates with a key).
    ("engine.public_market.prices", "build_prices_router"),
    # AI freshness layer — narrative + freshness only, never digits.
    ("engine.public_market.freshness", "build_freshness_router"),
    # Entity resolution review queue (PM6 human-in-the-loop).
    ("engine.public_market.entity", "build_entity_review_router"),
    # Cross-market universe search (/search, /universe).
    ("engine.public_market.search", "build_search_router"),
    # Cross-market screener / comparison surface.
    ("engine.public_market.screener", "build_screener_router"),
    # Server-rendered market pages, if that lane lands.
    ("engine.public_market.pages.router", "build_router"),
)


# ── store resolution (lazy: mounting must not touch the DB) ─────────

_default_store: Any = None
_store_probe_done = False


def _resolve_store() -> Optional[Any]:
    """Process-cached default store. Lazy so the router mounts (and
    tests import) without creating ``data/public_market.db``."""
    global _default_store, _store_probe_done
    if _default_store is not None:
        return _default_store
    if _store_probe_done:
        return None
    _store_probe_done = True
    try:
        from engine.public_market.store import get_store

        _default_store = get_store()
        return _default_store
    except Exception:  # pragma: no cover — depends on runtime fs state
        logger.warning("public_market store unavailable; company routes will "
                       "refuse honestly", exc_info=True)
        return None


def reset_default_store() -> None:
    """Test hook: drop the cached store handle (env re-read)."""
    global _default_store, _store_probe_done
    _default_store = None
    _store_probe_done = False


# ── response helpers ────────────────────────────────────────────────


def _refusal(status_code: int, code: str, detail: str,
             extra: Optional[Dict[str, Any]] = None) -> JSONResponse:
    """One shape for every refusal this surface emits.

    ``code`` is the stable machine string a client branches on; ``detail``
    is the sentence a human reads. A refusal that only carried an HTTP
    status would make "this market has no feed" and "we have not cached
    this company yet" indistinguishable — they are completely different
    answers and the UI must be able to say which one it got.
    """
    body: Dict[str, Any] = {"status": "refused", "code": code, "detail": detail}
    if extra:
        body.update(extra)
    return JSONResponse(body, status_code=status_code,
                        headers={"Cache-Control": ERROR_CACHE_CONTROL})


def _market_refusal_for(market: "_registry.Market") -> Optional[JSONResponse]:
    """The refusal a non-live market owes the caller, or None when the
    market is live. Reads the registry STATUS — there is no market-id
    branch here, which is the whole point of the registry."""
    if market.is_home:
        # PM7. The home market has its own storefront and its own
        # document class. Answering it here too would give one company
        # two sources of truth and two numbers — the exact failure this
        # wave exists to avoid. Structural (``is_home``), never a
        # market-id comparison.
        return _refusal(
            404, "HOME_MARKET_SERVED_ELSEWHERE",
            "%s is served by the existing %s pipeline, not by public_market — "
            "one company, one source of truth"
            % (market.display_name, market.fundamentals_source),
            {"market": market.to_dict()},
        )
    if market.is_live:
        return None
    if market.is_fundamentals_only:
        return _refusal(
            501, "MARKET_NOT_ADDRESSABLE",
            "%s figures come from %s, but no ticker to filing resolution "
            "exists for this market yet — the feed is real, the lookup is "
            "not built" % (market.display_name, market.fundamentals_source),
            {"market": market.to_dict()},
        )
    return _refusal(
        501, "MARKET_AWAITING_PROVIDER",
        "%s has no deterministic feed wired today. Reporting 'no results' "
        "would imply a search happened." % market.display_name,
        {"market": market.to_dict()},
    )


# ── the router ──────────────────────────────────────────────────────


def build_router(store: Any = None) -> APIRouter:
    """Build the aggregate public_market router.

    ``store`` is injectable so tests drive a temp-file store without
    touching the process default."""
    # NO prefix on the aggregate router: sub-routers declare fully
    # qualified paths, so a prefix here would be concatenated onto theirs.
    router = APIRouter(tags=["public-market"])

    def _store() -> Optional[Any]:
        return store if store is not None else _resolve_store()

    # ── GET /api/public/markets — the registry, with status ─────────

    def _registry_body() -> Dict[str, Any]:
        payload = _registry.registry_payload()
        holdings: Dict[str, int] = {}
        current = _store()
        if current is not None:
            try:
                holdings = current.market_counts()
            except Exception:  # noqa: BLE001 — a count is never worth a 500
                logger.warning("market_counts failed", exc_info=True)
                holdings = {}
        # `entities_held` is what we ACTUALLY have, next to what the
        # market's status CLAIMS. A registry that only published its own
        # ambitions would be a brochure.
        for entry in payload["markets"]:
            entry["entities_held"] = int(holdings.get(entry["market_id"], 0))
        return payload

    @router.get(PREFIX)
    def list_markets() -> JSONResponse:  # noqa: D401 - route
        """The market registry with per-market status and holdings."""
        return JSONResponse(_registry_body(),
                            headers={"Cache-Control": REGISTRY_CACHE_CONTROL})

    # Trailing-slash twin: /api/public/markets/ must not 307 into a
    # redirect that clients (and the sitemap gates) then have to follow.
    @router.get(PREFIX + "/")
    def list_markets_slash() -> JSONResponse:  # noqa: D401 - route
        """Trailing-slash alias of :func:`list_markets`."""
        return JSONResponse(_registry_body(),
                            headers={"Cache-Control": REGISTRY_CACHE_CONTROL})

    # ── GET /api/public/markets/company/{market}/{ticker} ───────────

    @router.get(PREFIX + "/company/{market}/{ticker}")
    def get_company(market: str, ticker: str) -> JSONResponse:  # noqa: D401
        """One company's pm1 document, or a typed refusal naming the gap."""
        entry = _registry.find_market(market)
        if entry is None:
            return _refusal(
                404, "UNKNOWN_MARKET",
                "unknown market %r — no default is substituted, because a "
                "default market would attach the wrong currency and the wrong "
                "licence to a real number" % market,
                {"known_markets": list(_registry.market_ids())},
            )
        refusal = _market_refusal_for(entry)
        if refusal is not None:
            return refusal

        current = _store()
        if current is None:
            return _refusal(
                503, "STORE_UNAVAILABLE",
                "the public_market store is not reachable on this node",
                {"market": entry.to_dict()},
            )
        symbol = (ticker or "").strip().upper()
        if not symbol:
            return _refusal(400, "EMPTY_TICKER", "no ticker supplied",
                            {"market": entry.to_dict()})
        try:
            envelope = current.get_by_ticker(entry.market_id, symbol)
        except Exception:  # noqa: BLE001 — a store fault is not a 500 page
            logger.warning("public_market store read failed for %s/%s",
                           entry.market_id, symbol, exc_info=True)
            return _refusal(
                503, "STORE_READ_FAILED",
                "the public_market store could not be read",
                {"market": entry.to_dict()},
            )
        if envelope is None:
            # READ-ONLY by design: this route never triggers an outbound
            # fetch. A serving surface that hits SEC once per page view
            # is a fair-access violation waiting for traffic.
            return _refusal(
                404, "NOT_CACHED",
                "%s is not in the public_market store for %s yet — this route "
                "reads the store and never fetches from the feed on a web "
                "request" % (symbol, entry.display_name),
                {"market": entry.to_dict(), "ticker": symbol},
            )

        body: Dict[str, Any] = {
            "status": envelope.get("status"),
            "market": entry.to_dict(),
            "envelope": envelope,
        }
        presentation = _presentation_for(envelope)
        if presentation is not None:
            body["presentation"] = presentation
        return JSONResponse(body,
                            headers={"Cache-Control": COMPANY_CACHE_CONTROL})

    _attach_sub_routers(router)
    return router


def _presentation_for(envelope: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The serving layer's wording object for this document, when the
    serving package is importable. Guarded: the presenter is a nicety,
    the document is the payload — a presenter import failure must not
    withhold real, provenance-carrying figures from the caller."""
    try:
        from engine.serving import present_public_market

        return present_public_market(envelope)
    except Exception:  # noqa: BLE001
        logger.warning("public_market presenter unavailable", exc_info=True)
        return None


def _attach_sub_routers(router: APIRouter) -> List[str]:
    """Include every sibling lane's router that is importable. Returns
    the list of mounted "module:factory" names (tests assert on it)."""
    mounted: List[str] = []
    for module_name, factory_name in _SUB_ROUTERS:
        try:
            module = __import__(module_name, fromlist=[factory_name])
        except ImportError:
            continue  # lane not landed — expected, not an error
        except Exception:  # noqa: BLE001 — a broken lane is not fatal
            logger.warning("[public_market] sub-router module %s failed to "
                           "import", module_name, exc_info=True)
            continue
        factory = getattr(module, factory_name, None)
        if factory is None:
            continue
        try:
            router.include_router(factory())
            mounted.append("%s:%s" % (module_name, factory_name))
        except Exception:  # noqa: BLE001
            logger.warning("[public_market] sub-router %s:%s failed to mount",
                           module_name, factory_name, exc_info=True)
    return mounted
