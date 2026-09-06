"""FastAPI router for the AI Intelligence layer.

Mounted at /api/public/intelligence/* in src/engine/api/server.py — sibling
of the existing /api/public/* router. Routes are deliberately namespaced
under `intelligence/` so existing FE polling of /api/public/universe etc.
is unaffected.

Endpoints (matches design plan §25.7):
  GET  /api/public/intelligence/health
  GET  /api/public/intelligence/risk-radar
  GET  /api/public/intelligence/macro-signals
  GET  /api/public/intelligence/supply-chain          ?sector=...|?ticker=...
  GET  /api/public/intelligence/companies/{ticker}/risk-score
  GET  /api/public/intelligence/companies/{ticker}/exposure
  GET  /api/public/intelligence/companies/{ticker}/signals
  GET  /api/public/intelligence/companies/{ticker}/ai-market-read
  POST /api/public/intelligence/signals/manual        — operator signal upload
                                                        WALLED (fail closed)
  POST /api/public/intelligence/refresh-filings-cache  — poll EDGAR, invalidate
                                                        WALLED (fail closed)
  POST /api/public/intelligence/refresh-signals       — bust radar + signal cache
                                                        SHIELDED (rate limit)

The two WALLED routes require the ENGINE_API_TOKEN bearer and refuse with
503 when it is unset; the SHIELDED one stays anonymously reachable behind a
per-client budget. That split is deliberate and is pinned by
tests/engine/test_public_post_surface.py — see refresh_shield's module
docstring for the reasoning.

EGRESS (2026-09-04) — the GETs here reach upstream too
-------------------------------------------------------
That POST classification covered no GET, and five of the reads above are
upstream amplifiers. MEASURED in-process against the real ``create_app()``
with every outbound socket blocked and recorded:

  · risk-score / exposure / risk-scores / supply-chain?ticker= /
    ai-market-read all hydrate through ``_fetch_universe_snapshots`` ->
    ``universe_service.get_universe``: 7 outbound on a cold universe
    (2 data.nasdaq.com + 5 query1.finance.yahoo.com), 0 warm. Each now
    passes ``refresh_shield.egress_guard`` with the universe's own warmth,
    so a warm read still costs nothing and a cold one is bounded.

  · ai-market-read had NO CACHE AT ALL and called the LLM on EVERY
    request. MEASURED with a spy client: four identical anonymous GETs
    produced four completions. With ANTHROPIC_API_KEY set on the backend
    that is one paid Claude request per anonymous call, unbounded — a
    strictly worse amplifier than the cache-busts that were shielded
    first, because the spend is money rather than a rate. It is now
    cached for AI_READ_TTL_SEC through the same IntelligenceCache its
    siblings use, and ``refresh-signals`` busts it with them.

THE GUARD IS KEYED ON WHAT THE ROUTE SPENDS (2026-09-05)
---------------------------------------------------------
The guards above were written against the universe's warmth, and a
critic instrumenting the TRANSPORT with successful canned responses
showed the flag was reading a neighbour's cache: with the universe warm,
150 distinct tickers on ``/risk-score`` from one client cost 1,950
outbound and zero tokens, and with ``SEC_EDGAR_ENABLED`` +
``ANTHROPIC_API_KEY`` set, 9 distinct tickers on ``/supply-chain`` cost
9 paid completions against a budget of 3 a minute — because
``build_company_exposure_profile(try_filings=True)`` reaches SEC EDGAR and
Claude, and no flag on this router knew it.

Three rules now hold, each pinned by tests/engine/test_public_egress.py:

  1. ``warm`` is true ONLY when THIS route's own compute would make zero
     outbound calls and zero paid completions. ``_profile_warm`` /
     ``_filings_warm`` / ``_feed_warm`` / ``_universe_warm`` are the
     resources, and each route's flag is the conjunction of the ones its
     compute touches — or its own rendered cache.
  2. The ticker is VALIDATED against the served registry (203 NASDAQ +
     88 BVB, the same set ``_fetch_universe_snapshots`` can answer for)
     before the guard runs. A nonsense ticker is a 404 that cost nothing
     upstream and spent no token; it used to cost the full fan-out.
  3. The filings-derived profile is computed ONCE per ticker and shared by
     exposure / supply-chain / risk-score / ai-market-read through the
     ``exposure:`` cache, and both paid paths sit behind the per-process
     daily completion ceiling in ``engine.public.egress_ledger``.
"""

from __future__ import annotations

import logging
import os
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .. import egress_ledger as _ledger
from .. import universe as universe_module
# Cache-bust shield (rate limit + operator bearer). MODULE scope on purpose:
# this file uses `from __future__ import annotations`, so anything FastAPI has
# to resolve from an endpoint signature must be visible in module globals.
from ..refresh_shield import egress_guard as _egress_guard
from ..refresh_shield import guard as _refresh_guard
from ..refresh_shield import require_operator as _require_operator
from ..universe_service import get_universe
from ..universe_service import is_warm as _universe_warm
from ..bvb_seed import bvb_universe as _bvb_universe
from .category_scoring import CATEGORIES as RADAR_CATEGORIES
from .company_exposure_service import (
    SECTOR_MODEL_CONFIDENCE,
    build_company_exposure_profile,
    build_universe_exposure_profiles,
    score_categories_for_ticker,
)
from .intelligence_cache import (
    EXPOSURE_TTL_SEC,
    RADAR_TTL_SEC,
    SCORE_TTL_SEC,
    SIGNALS_TTL_SEC,
    get_intelligence_cache,
)
from .macro_signal_service import get_macro_signal_service
from .models import (
    FinancialImpactChannel,
    IntelligenceSignal,
    PublicCompanyRiskScore,
    RiskCategory,
    Severity,
    SignalType,
    TimeHorizon,
    as_utc,
)
from .ai_market_read import compose_ai_market_read
# Phase D — filings cache observability + refresh hook
from . import filings_cache
from .filings_extractor import is_enabled as _filings_enabled
from .filings_refresh import run_refresh
from .opportunity_scoring_engine import compute_opportunity_score
from .risk_scoring_engine import compute_risk_score
from .sector_risk_library import SECTOR_RISK_LIBRARY, all_sectors
from .signal_orchestrator import synthesize_sector_signals

logger = logging.getLogger(__name__)

# ── AI Market Read cache TTL ─────────────────────────────────────────────
#
# 600 s, matching EXPOSURE_TTL_SEC — the read is a narrative ABOUT the
# exposure profile and the risk/opportunity scores, so it cannot say
# anything new until one of those changes, and exposure is the slowest of
# them. Held here rather than in intelligence_cache.py so this wave adds
# no constant to a module it does not own; `refresh-signals` invalidates
# the "ai-market-read:" prefix alongside the four it already busts.
AI_READ_TTL_SEC = 600


# ─────────────────────────────────────────────────────────────────────────
# Ordering the merged feed — TOTAL, and with no naive sentinel
# ─────────────────────────────────────────────────────────────────────────
#
# ``macro_signals`` is the only place in this package that ORDERS
# datetimes, and it orders the one list six adapters are merged into. The
# key it used could not order that list:
#
#     key=lambda s: (RANK[s.severity], s.published_at or datetime.min)
#
# ``datetime.min`` is NAIVE. Against the aware stamps every other producer
# on this feed emits, the first undated signal raised ``TypeError: can't
# compare offset-naive and offset-aware datetimes`` and the route answered
# 500 — for the whole feed TTL, because the list it chokes on is the
# CACHED one. MEASURED anonymous against the real ``create_app()`` with
# canned SUCCESSFUL provider bodies: 500 with ``NEWS_API_KEY`` set alone
# and one article whose ``publishedAt`` was malformed, 500 with
# ``RSS_FEED_URLS`` set alone and a bare-ISO ``pubDate``.
#
# ``models.as_utc`` in ``IntelligenceSignal.__post_init__`` closes the
# second of those at the boundary — a signal now carries an aware stamp or
# carries none. The FIRST is this key's own doing and is fixed here, by
# not needing a sentinel at all: presence is its own component of the
# tuple, so an undated signal is never compared against a dated one.
#
# ORDER IS UNCHANGED from the sentinel version, deliberately — this lane
# owns the crash, not the feed's editorial order. ``datetime.min`` sorted
# undated FIRST within a severity band; ``False < True`` keeps it there,
# and the dated ones stay ascending behind it. ``_UNDATED`` is only ever
# compared against itself (both sides reach it only when both flags are
# False) and is aware regardless, so no naive value exists on this path
# even as filler.
_SEVERITY_RANK: dict[str, int] = {"critical": 0, "high": 1, "medium": 2, "low": 3}
_UNDATED = datetime.min.replace(tzinfo=timezone.utc)


def _signal_sort_key(s: IntelligenceSignal) -> tuple:
    """Total order over a merged signal list. Cannot raise on a mixture.

    ``as_utc`` runs HERE TOO, not only at
    ``IntelligenceSignal.__post_init__``. Dropping it because the model
    already coerces was measured to be wrong: with the model boundary
    planted out, two dated signals at the SAME severity — one aware, one
    naive — reach this tuple's third component and are compared raw, and
    the route answers 500 again. Presence-as-a-component alone is not
    totality; it only separates dated from undated. This is the same
    belt-and-braces the package already applies at ``base.is_before``, and
    for the same reason: the model defends the value, this defends the
    ordering, and they fail independently.

    ``[s.severity]`` is indexed, not ``.get``-ed with a fallback: every
    producer in this package emits one of the four ``models.Severity``
    literals (the manual route validates the field through Pydantic, the
    adapters emit constants), so a miss is a broken contract that should
    be loud rather than silently sorted last. The gate asserts this dict
    covers ``Severity`` exactly, so ADDING a fifth severity reds a test
    instead of 500ing a route.
    """
    at = as_utc(s.published_at)
    return (_SEVERITY_RANK[s.severity], at is not None, at or _UNDATED)


# ─────────────────────────────────────────────────────────────────────────
# Helpers — universe + financials hydration
# ─────────────────────────────────────────────────────────────────────────

def _industry_lookup() -> dict[str, str]:
    """Mirror of universe_module.INDUSTRY but typed as a dict."""
    return dict(universe_module.INDUSTRY)


def _serialize(obj: Any) -> Any:
    """Recursive dataclasses.asdict-equivalent that also coerces datetimes to
    ISO strings, so FastAPI's JSON serializer never trips on a tz-aware dt.
    """
    if obj is None:
        return None
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, list):
        return [_serialize(o) for o in obj]
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    if hasattr(obj, "__dataclass_fields__"):
        return _serialize(asdict(obj))
    return obj


# ─────────────────────────────────────────────────────────────────────────
# The ticker registry — what the SERVER knows, checked before any spend
# ─────────────────────────────────────────────────────────────────────────
#
# Every per-ticker route on this router answers 404 for a ticker that is
# not in the universe payload. That payload is built from exactly two
# static tables — ``universe.DEFAULT_UNIVERSE`` (203 NASDAQ) and
# ``bvb_seed.bvb_universe()`` (88 BVB) — so membership is decidable
# without hydrating anything. It used to be decided AFTER the hydration
# and the signal fan-out: MEASURED, ``ZZZZNOTAREALTICKER`` cost the same
# 13 outbound as ``AAPL`` on ``/signals`` and the same 11 on ``/exposure``.
# Now the 404 is the first thing the handler does, before the guard, so a
# nonsense identifier spends neither an outbound call nor a token — and
# never becomes a cache key, because it never reaches a cache write.
_KNOWN_TICKERS: Optional[frozenset] = None


def _known_tickers() -> frozenset:
    global _KNOWN_TICKERS
    if _KNOWN_TICKERS is None:
        _KNOWN_TICKERS = frozenset(
            [t.upper() for t in universe_module.universe_tickers()]
            + [t.upper() for t in _bvb_universe().keys()]
        )
    return _KNOWN_TICKERS


def _validated_ticker(raw: str) -> str:
    """Uppercase registry member, or 404. Runs BEFORE the egress guard."""
    tu = (raw or "").strip().upper()
    if len(tu) > 16 or tu not in _known_tickers():
        raise HTTPException(
            404,
            "Ticker %r not in universe. Nothing was requested from any "
            "provider." % (raw or "")[:40],
        )
    return tu


# ─────────────────────────────────────────────────────────────────────────
# Warmth, per RESOURCE — a guard is only as true as the warmth it reads
# ─────────────────────────────────────────────────────────────────────────

def _llm_configured() -> bool:
    """Would ``compose_ai_market_read`` build a real client?"""
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _filings_warm(tu: str) -> bool:
    """Would ``build_company_exposure_profile(try_filings=True)`` reach nothing?

    True when the filings layer is switched off (either variable unset —
    the extractor returns before the wire) or when the in-memory filings
    cache holds this ticker. A DB hit is one request to our own Supabase
    and a miss is EDGAR + a paid completion, so neither is warm.
    """
    if not _filings_enabled():
        return True
    return filings_cache.has_in_memory(tu)


def _exposure_key(tu: str) -> str:
    return "exposure:%s" % tu


def _profile_warm(tu: str) -> bool:
    """Would ``_exposure_profile(tu)`` reach nothing?"""
    if get_intelligence_cache().get(_exposure_key(tu)) is not None:
        return True
    return _universe_warm() and _filings_warm(tu)


def _fetch_universe_snapshots() -> dict[str, dict[str, Any]]:
    """Pull the live universe payload + index by uppercase ticker.

    Falls back to demo universe if no Nasdaq key is configured.
    Cached by build_universe_payload itself (TTL inside universe_service.py).
    """
    payload = get_universe()
    # universe_service returns either {"companies":[...]} or a list directly.
    rows = payload.get("companies", []) if isinstance(payload, dict) else payload
    out: dict[str, dict[str, Any]] = {}
    for snap in rows:
        if not isinstance(snap, dict):
            continue
        ticker = (snap.get("ticker") or "").upper()
        if ticker:
            out[ticker] = snap
    return out


def _exposure_profile(tu: str):
    """ONE per-ticker profile, cached under ``exposure:{ticker}``, shared.

    exposure / supply-chain / risk-score / ai-market-read all need the
    same ``CompanyExposureProfile``, and each used to build its own —
    which, with the filings layer on, was the EDGAR + Claude chain per
    route per ticker (MEASURED: 4 outbound + 1 completion, on a route
    that carried a guard reading the universe's warmth). Building it here
    once means the paid work happens at most once per ticker per
    EXPOSURE_TTL_SEC across the four, and ``_profile_warm`` can answer for
    all of them. The DATACLASS is cached, not its serialisation, because
    the scoring engines take the object; every route serialises on the
    way out and the bytes are the same as before.

    ``tu`` must already be validated — the 404 below is the defensive
    path for a registry/payload disagreement, not the caller's.
    """
    def _build():
        snaps = _fetch_universe_snapshots()
        snap = snaps.get(tu)
        if snap is None:
            raise HTTPException(404, f"Ticker {tu} not in universe")
        return build_company_exposure_profile(
            ticker=tu,
            company_name=snap.get("company_name") or snap.get("companyName") or tu,
            sector=snap.get("sector") or "Unknown",
            industry=_industry_lookup().get(tu),
        )

    return get_intelligence_cache().get_or_compute(
        _exposure_key(tu), EXPOSURE_TTL_SEC, _build)


def _financials_from_snapshot(snap: dict[str, Any]) -> dict[str, Any]:
    """Pull the canonical financial subset the scoring engines expect."""
    return {
        "revenue":              snap.get("revenue"),
        "revenue_growth":       snap.get("revenue_growth") or snap.get("revenueGrowth"),
        "ebitda":               snap.get("ebitda"),
        "ebitda_margin":        snap.get("ebitda_margin") or snap.get("ebitdaMargin"),
        "net_income":           snap.get("net_income") or snap.get("netIncome"),
        "net_margin":           snap.get("net_margin") or snap.get("netMargin"),
        "capex":                snap.get("capex"),
        "operating_cash_flow":  snap.get("operating_cash_flow") or snap.get("operatingCashFlow"),
        "free_cash_flow":       snap.get("free_cash_flow") or snap.get("freeCashFlow"),
        "fcf_yield":            snap.get("fcf_yield") or snap.get("fcfYield"),
        "market_cap":           snap.get("market_cap") or snap.get("marketCap"),
        "ev":                   snap.get("enterprise_value") or snap.get("enterpriseValue"),
        "ev_to_ebitda":         snap.get("ev_to_ebitda") or snap.get("evToEbitda"),
        "pe_ratio":             snap.get("pe_ratio") or snap.get("peRatio"),
        "net_debt":             snap.get("net_debt") or snap.get("netDebt"),
        "net_debt_to_ebitda":   snap.get("net_debt_to_ebitda") or snap.get("netDebtToEbitda"),
        "debt_to_equity":       snap.get("debt_to_equity") or snap.get("debtToEquity"),
        "roe":                  snap.get("roe"),
        "interest_expense":     snap.get("interest_expense") or snap.get("interestExpense"),
    }


# ─────────────────────────────────────────────────────────────────────────
# Pydantic request models
# ─────────────────────────────────────────────────────────────────────────

class ManualSignalIn(BaseModel):
    signal_type: SignalType
    title: str = Field(..., min_length=4, max_length=200)
    summary: str = Field(..., min_length=8, max_length=2000)
    severity: Severity
    time_horizon: TimeHorizon = "12m"
    affected_sectors: list[str] = Field(default_factory=list)
    affected_industries: Optional[list[str]] = None
    affected_companies: Optional[list[str]] = None
    affected_tickers: Optional[list[str]] = None
    geography: Optional[list[str]] = None
    financial_impact_channels: Optional[list[FinancialImpactChannel]] = None
    risk_categories: Optional[list[RiskCategory]] = None
    confidence: float = Field(0.7, ge=0.0, le=1.0)
    source_label: str = "manual:operator"
    source_url: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────
# Router
# ─────────────────────────────────────────────────────────────────────────

def build_router() -> APIRouter:
    router = APIRouter(prefix="/api/public/intelligence", tags=["public-companies-intelligence"])

    # ─── THE SIGNAL FEED: one fan-out, one server-derived key ───────────
    #
    # ``MacroSignalService.fetch_all()`` walks all six adapters and is the
    # ONLY outbound path on this router that is not the universe or the
    # LLM. MEASURED 2026-09-04 in-process against the real ``create_app()``
    # with every socket blocked and every ``urlopen`` recorded, with the
    # five signal activation vars set (the production shape whenever an
    # operator has configured any feed):
    #
    #     1x newsapi.org/v2/top-headlines          (NEWS_API_KEY)
    #     1x the configured RSS feed               (RSS_FEED_URLS)
    #     5x api.stlouisfed.org/fred/...           (FRED_API_KEY, 5 series)
    #     5x api.eia.gov/v2/seriesid/...           (EIA_API_KEY, 5 series)
    #     1x api.gdeltproject.org/api/v2/doc/doc   (GDELT_ENABLED)
    #     ── 13 outbound calls, per fan-out.
    #
    # Three routes reached that fan-out with no cache between them and the
    # wire, and the egress map called all of them NO_EGRESS because the map
    # enumerates with all five vars ABSENT — and with them absent every
    # adapter refuses at ``health()`` before the wire, so the map measured
    # a keyless deployment and generalised it to a configured one. The
    # lane's own earlier insight ("a keyless run hides an amplifier"),
    # under-applied: it was carried to NASDAQ_API_KEY and ANTHROPIC_API_KEY
    # and not to these five.
    #
    #   · GET /companies/{ticker}/signals   13 per call, EVERY call, no
    #     cache. 3 identical calls = 39. A nonsense ticker costs the same
    #     13 (the ticker is filtered AFTER the fan-out, so it cannot
    #     shorten it).
    #   · GET /macro-signals                cached, but on a key built from
    #     caller-supplied sector/ticker/limit — 5 calls differing only in
    #     ``?limit=`` cost 65.
    #   · GET /companies/{ticker}/risk-score  classified GUARDED and
    #     carrying egress_guard, but the guard reads the UNIVERSE's warmth
    #     while ``_compute`` calls ``fetch_for_ticker`` — so on a WARM
    #     universe with a cold score cache the route took NO token and
    #     still fanned out 13. MEASURED at 13. Not named by any critic;
    #     found by driving the siblings.
    #
    # Caching the FAN-OUT rather than each route's rendered view fixes all
    # three at one place: every view above becomes a filter over one cached
    # list, so a caller's parameters select from server-held data instead
    # of steering a fetch. That is the difference between a cache key and
    # a cache-miss lever.
    #
    # THE KEY IS SERVER-DERIVED AND CARRIES NO CALLER TEXT. It is a
    # constant. A caller cannot vary it, cannot grow the cache dict with
    # it, and cannot miss on it. It sits under the ``macro-signals:``
    # prefix that POST /refresh-signals already invalidates, so an operator
    # bust still drops it and no new invalidate line changes that route's
    # reported count.
    _FEED_KEY = "macro-signals:__feed__"

    def _signal_feed() -> list:
        """The full adapter fan-out, cached for SIGNALS_TTL_SEC.

        Returns the raw ``IntelligenceSignal`` list, not a serialised
        view: the callers filter on ``.affected_tickers`` /
        ``.affected_sectors`` / ``.severity``, and re-serialising per view
        keeps one authority for the fetch and none for the shape.
        """
        return get_intelligence_cache().get_or_compute(
            _FEED_KEY, SIGNALS_TTL_SEC,
            lambda: get_macro_signal_service().fetch_all(),
        )

    def _feed_warm() -> bool:
        """Would ``_signal_feed()`` answer WITHOUT touching a provider?

        This is the warmth the signal routes must guard on — NOT
        ``_universe_warm()``. Guarding a signal fan-out on the universe's
        warmth is exactly the risk-score defect above: the flag says warm,
        the guard takes no token, and 13 calls go out anyway. An empty
        feed is a legitimate cached value (every adapter can return no
        signals), so warmth is `is not None`, never truthiness — an
        ABSENT feed and an EMPTY one are different facts.
        """
        return get_intelligence_cache().get(_FEED_KEY) is not None

    # ─── Health ─────────────────────────────────────────────────────────
    #
    # Server-derived, constant. Carries NO caller text, exactly like
    # ``_FEED_KEY`` — a caller cannot vary it, cannot grow the cache dict
    # with it, and cannot miss on it. Its own prefix, because the block it
    # holds describes the FILINGS cache and is therefore invalidated by
    # ``refresh-filings-cache`` (the operator route that changes it), not
    # by ``refresh-signals``.
    _FILINGS_OBS_KEY = "filings-observability:__db__"

    # The two DB reads below describe a cache whose entries live
    # ``filings_cache.CACHE_TTL_DAYS`` (7 days). Reusing SIGNALS_TTL_SEC —
    # the SHORTEST TTL in the module that owns them — rather than deriving
    # a sixth constant: on a 7-day-scale counter, 60 s of staleness changes
    # no operator decision, and picking the shortest existing number means
    # this block can never be staler than the feed rendered beside it.
    def _filings_observability() -> dict[str, Any]:
        """The DB-backed half of /health, cached. Two full-table selects.

        MEASURED 2026-09-04 at the transport layer, anonymous, against the
        real ``create_app()``: ``GET /api/public/intelligence/health`` cost
        2 outbound Supabase reads on EVERY call — cold and warm alike, no
        cache, no guard — and 200 sequential anonymous calls answered 200
        each, for 400 reads. Both are unbounded selects over
        ``company_exposure_profiles`` (``total_cached_entries`` and
        ``oldest_entry_age_seconds`` each pull every filings row), so the
        cost grows with the table.

        This was the last route on /api/public with NO control of any
        kind. The earlier maps could not see it: their spy RAISED on the
        first provider call, and this route's siblings reach a provider
        long before it does.

        ``get_metrics_snapshot()`` is deliberately NOT cached — it is a
        lock-guarded read of in-process counters, reaches nothing, and its
        own docstring says it is computed lazily "so /health stays cheap".
        Caching it would freeze live counters to buy nothing.
        """
        return get_intelligence_cache().get_or_compute(
            _FILINGS_OBS_KEY, SIGNALS_TTL_SEC,
            lambda: {
                "total_entries": filings_cache.total_cached_entries(),
                "oldest_entry_age_seconds": filings_cache.oldest_entry_age_seconds(),
            },
        )

    def _filings_observability_warm() -> bool:
        """Would /health answer WITHOUT touching the database?

        ``is not None``, never truthiness: an empty filings table is a
        legitimate cached answer (``total_entries: 0``), and an ABSENT
        cache entry is a different fact from an EMPTY result. Reading it
        as falsy would take a token on every warm poll and re-run both
        selects — the exact defect this closes.
        """
        return get_intelligence_cache().get(_FILINGS_OBS_KEY) is not None

    @router.get("/health")
    def health(request: Request) -> dict[str, Any]:
        """Per-adapter health + feed status.

        Used by the FE Macro Signals tab to decide whether to show the
        "Live signal feed not connected" empty-state vs a live feed.

        EGRESS-GUARDED on the DB block's warmth — see
        ``_filings_observability``. A SHIELD and not a WALL, because this
        is a live public surface the FE polls: walling it would blank the
        Macro Signals tab to protect a database. With the cache in front,
        an FE poll inside the window is warm, so it costs zero outbound
        AND zero budget; only the once-per-TTL cold miss spends a token.

        The guard runs BEFORE the read, so a 429 costs the database
        nothing.
        """
        limited = _egress_guard(
            request,
            route="/api/public/intelligence/health",
            warm=_filings_observability_warm(),
        )
        if limited is not None:
            return limited  # type: ignore[return-value]

        svc = get_macro_signal_service()
        # Phase D — surface filings cache observability so operators can
        # see hit rate, eviction frequency, and total entries WITHOUT
        # SSHing into the DB. Counters are container-local per the
        # `metrics_scope` field in the payload.
        cache_metrics = filings_cache.get_metrics_snapshot()
        return {
            "feed_status": svc.feed_status(),
            "adapters": {
                name: _serialize(asdict(h)) for name, h in svc.health().items()
            },
            "sector_library_version": "v1",
            "universe_sector_count": len(all_sectors()),
            "filings_cache": {
                **cache_metrics,
                **_filings_observability(),
                "ttl_days": filings_cache.CACHE_TTL_DAYS,
            },
            # The daily ceilings (engine.public.egress_ledger): paid
            # completions used today against the limit, and per provider
            # host the calls used against its ceiling. In-process counters,
            # labelled as such — reaches nothing.
            "egress_ledgers": _ledger.snapshot(),
        }

    # ─── Risk Radar ─────────────────────────────────────────────────────

    # Per-sector diversity cap on radar top-12 affected_tickers rankings.
    # Honest scoring produces sector-uniform top-12 within categories where
    # one sector dominates (e.g. Utilities top all 12 rates_credit slots
    # because they share the same default financial_sensitivity.interest_rates
    # value; Semis top supply_chain because they share semiconductors=0.95).
    # A CFO scanning the radar needs cross-sector situational awareness —
    # "which OTHER industries are exposed?" — not 12 names from one sector.
    # This cap forces the top-12 to draw from at least 3 sectors by limiting
    # any single sector to MAX_TICKERS_PER_SECTOR_PER_CATEGORY.
    #
    # Set to 4 (empirically chosen — Gate A v2/v3 comparison, 2026-06-01).
    # At 12 slots / 4 per sector = minimum 3 sectors represented per
    # category. The radar's affected_tickers ranking draws from at least
    # 3 distinct sectors so a CFO scanning the card sees cross-sector
    # situational awareness, not 12 names from one industry.
    #
    # COUNTERINTUITIVE EMPIRICAL FINDING — do not "tighten" this to 3
    # thinking it improves diversity. We tried cap=3 and it made overlap
    # WORSE:
    #   cap=4 — 5/28 category pairs over 40% overlap, max 83%
    #   cap=3 — 8/28 category pairs over 40% overlap, max 75%
    # Mechanism: tighter cap forces MORE sectors into each top-12 list.
    # When two categories LEGITIMATELY share their top sectors (Semis
    # is in both supply_chain and geopolitical top sectors; Consumer
    # Defensive is in both fx and supply_chain top sectors), each shared
    # sector contributes the cap value to the overlap. Three shared
    # sectors at cap=3 = 9/12 overlap (75%); three shared sectors at
    # cap=4 = also 9/12 (75%) — but cap=4 fits MORE total per-sector
    # signal so fewer sectors are shared overall.
    #
    # Going below 3 (e.g. cap=2) would mutilate the data: forcing 6+
    # sectors into every top-12 means the radar shows 1 NVDA + 11
    # tickers from sectors that aren't actually supply-chain dominant.
    # The cap mechanism is at its empirical ceiling.
    #
    # The remaining structural overlaps (energy×fx, geopolitical×
    # supply_chain, etc.) reflect REAL CFO-level correlations — Semis
    # are both Taiwan-exposed AND semi-supply-fragile; Consumer Defensive
    # is both energy-sensitive AND FX-sensitive. These overlaps are
    # surfaced honestly, not hidden, via the `diversity_status` field
    # the response includes per category (see _diversity_status_for_cat
    # below).
    #
    # The deeper fix — per-ticker financial variation that breaks
    # within-sector score ties — lands when SEC filings extraction is
    # wired (Phase D-something). At that point the 40% gate becomes
    # achievable and this constant can re-tighten. Until then 50% is
    # the honest floor and the cap stays at 4.
    #
    # CRITICAL — applied AFTER score-rank sorting, NOT before scoring.
    # Scoring stays honest (score_categories_for_ticker is exchange-
    # agnostic, ticker-agnostic to sector caps); presentation layer
    # enforces diversity. Keep these layers separate — applying the cap
    # before scoring would bias the input data and break Lock #11.
    #
    # Gate A overlap matrix validates this: before-cap had geopolitical×
    # supply_chain=10/12 and rates_credit×regulation=12/12 shared
    # (Utilities flooding both, Semis flooding both). After-cap target:
    # max overlap ≤4/12. Re-run Gate A after any change to this constant.
    _MAX_TICKERS_PER_SECTOR_PER_CATEGORY = 4

    # Per-category structural-correlation labels surfaced in the response
    # payload. These flag the pairs where the radar's top-12 lists
    # overlap >50% because of HONEST CFO-level correlations in the
    # underlying data, not because of a bug. The FE can use these to
    # render a "Shares N of 12 with {related} — both driven by {sectors}"
    # footnote inside the affected_tickers list (not as a card-level
    # badge) so the user understands the correlation when they're deep
    # in the data, not as a top-level label that makes every card feel
    # weakly differentiated.
    #
    # Empirical history (Lock #8 working correctly):
    # I predicted 2 correlated pairs ahead of Gate A. Gate A FINAL
    # revealed 4. The 2 surprises matched the same pattern — dominant-
    # sector convergence on real CFO-level correlations, not wiring
    # bugs. Treating the surprises as bugs because they weren't
    # predicted would have been Lock #8 in reverse: letting prediction
    # define reality. The pattern (ALL 4 over-threshold pairs are
    # structurally explainable, ZERO are random) is the discriminator.
    # A future failing pair like `technology × consumer_demand` WOULD
    # be a wiring bug — the data shouldn't produce uncorrelated overlaps
    # at this magnitude.
    #
    # Each entry: category → (related_category, shared_sectors_label).
    # Label is the operator-readable explanation of WHY they overlap,
    # rendered inline in the FE footnote.
    _KNOWN_STRUCTURAL_CORRELATIONS: dict[str, list[dict[str, str]]] = {
        "supply_chain": [
            {"related": "geopolitical",
             "drivers": "Semiconductors (Taiwan concentration + semi-supply fragility)"},
            {"related": "energy",
             "drivers": "Materials (China-exposed metals + energy-intensive production); "
                        "Consumer Defensive (food commodities + energy input cost)"},
        ],
        "geopolitical": [
            {"related": "supply_chain",
             "drivers": "Semiconductors (Taiwan concentration + semi-supply fragility)"},
        ],
        "energy": [
            {"related": "fx",
             "drivers": "Consumer Defensive + Energy (globally exposed input costs "
                        "AND multi-currency revenue)"},
            {"related": "supply_chain",
             "drivers": "Materials + Consumer Defensive (energy-intensive + commodity-supply)"},
        ],
        "fx": [
            {"related": "energy",
             "drivers": "Consumer Defensive + Energy (globally exposed input costs "
                        "AND multi-currency revenue)"},
        ],
        "rates_credit": [
            {"related": "regulation",
             "drivers": "Utilities + Financials (heavily regulated AND long-duration "
                        "debt / tariff-structured revenue)"},
        ],
        "regulation": [
            {"related": "rates_credit",
             "drivers": "Utilities + Financials (heavily regulated AND long-duration "
                        "debt / tariff-structured revenue)"},
        ],
    }

    @router.get("/risk-radar")
    def risk_radar() -> dict[str, Any]:
        """8 risk-radar category cards (per brief §14).

        Aggregates exposure profiles + sector-model signals across the
        full 200-ticker universe to produce one card per RiskCategory.
        Cached for RADAR_TTL_SEC (5 min) to keep FE polling cheap.
        """
        cache = get_intelligence_cache()

        def _compute():
            industry = _industry_lookup()

            # ── Merge universe: NASDAQ + BVB ──────────────────────────
            # BVB Phase 2 (2026-06-01) — radar iteration spans both
            # universes. NASDAQ rows from DEFAULT_UNIVERSE always pass
            # the sparse-row filter (every NASDAQ ticker has demo +
            # potentially live financials). BVB rows pass only when
            # the seed entry carries a non-null revenue (Option B —
            # see intelligence/README.md "Sparse-row handling").
            #
            # Tuples shape: (ticker, name, sector, country, has_financials).
            merged_universe: list[tuple[str, str, str, str, bool]] = [
                (t, n, s, "US", True)
                for t, n, s in universe_module.DEFAULT_UNIVERSE
            ]
            bvb_rows = _bvb_universe()
            for bvb_ticker, bvb_row in bvb_rows.items():
                has_fin = bvb_row.get("revenue") is not None
                merged_universe.append((
                    bvb_ticker,
                    bvb_row["companyName"],
                    bvb_row.get("sector") or "",
                    "RO",
                    has_fin,
                ))

            # Build profiles ONCE for the merged universe — both for
            # the legacy `affected_sectors` aggregation AND for the
            # per-category scoring loop below. score_categories_for_
            # ticker handles BVB overrides internally (Lock #11 — the
            # exchange knowledge stays in the service).
            profiles = build_universe_exposure_profiles(
                [(t, n, s) for t, n, s, _country, _has_fin in merged_universe],
                industry_lookup=industry,
            )
            signals = synthesize_sector_signals()

            # Per-ticker country + has-financials lookup, indexed for
            # the per-card affected_ticker scoring loop.
            ticker_meta: dict[str, dict[str, Any]] = {
                t: {"country": c, "has_financials": h, "sector": s}
                for t, _n, s, c, h in merged_universe
            }

            # Pre-compute the full (ticker → 8-category-scores) table
            # ONCE. For 200 NASDAQ + 20 BVB tickers this is ~220
            # `score_categories_for_ticker` calls, each cheap. Done
            # outside the per-category loop so we don't recompute per
            # category — and so the BVB override INFO log fires at
            # most once per ticker per radar refresh, not 8 times.
            ticker_category_scores: dict[str, dict[str, float]] = {}
            for ticker, meta in ticker_meta.items():
                profile = profiles.get(ticker)
                if profile is None:
                    continue
                ticker_category_scores[ticker] = score_categories_for_ticker(
                    ticker=ticker,
                    sector=meta["sector"],
                    industry=industry.get(ticker),
                    geographic_exposure=profile.geographic_exposure,
                )

            # Bucket signals + companies into 8 Risk Radar cards.
            categories: dict[str, dict[str, Any]] = {}
            for cat in RADAR_CATEGORIES:
                cat_signals = [s for s in signals if cat in s.risk_categories]
                affected_sectors = sorted({
                    sec
                    for sig in cat_signals
                    for sec in sig.affected_sectors
                })

                # ── Score-ranked affected_tickers (the bug fix) ──
                # Replaces the prior alphabetical-sort logic. For each
                # ticker, look up its per-category score from the
                # pre-computed table; rank descending; cap to top-12.
                # Option B sparse filter: skip tickers with
                # has_financials=False BEFORE ranking so they don't
                # displace real signal (intelligence/README.md
                # "Sparse-row handling").
                scored: list[tuple[str, float]] = []
                for ticker, scores in ticker_category_scores.items():
                    if not ticker_meta[ticker]["has_financials"]:
                        continue
                    s = scores.get(cat, 0.0)
                    if s > 0.0:
                        scored.append((ticker, s))
                scored.sort(key=lambda x: x[1], reverse=True)

                # ── Per-sector diversity cap (see constant comment above) ──
                # Walk the score-sorted list. Count per-sector
                # occurrences as we go; skip any ticker that would push
                # its sector past the cap. Continue until 12 slots fill
                # OR list is exhausted. Exhausted-early case is OK —
                # better to ship 9 honest names than 3 honest + 9
                # sector-uniform filler.
                sector_count: dict[str, int] = {}
                top_tickers: list[tuple[str, float]] = []
                for ticker, score in scored:
                    sec = ticker_meta[ticker]["sector"]
                    if sector_count.get(sec, 0) >= _MAX_TICKERS_PER_SECTOR_PER_CATEGORY:
                        continue
                    top_tickers.append((ticker, score))
                    sector_count[sec] = sector_count.get(sec, 0) + 1
                    if len(top_tickers) >= 12:
                        break

                affected_tickers_rich = [
                    {
                        "ticker": t,
                        "category_score": round(score, 3),
                        "country": ticker_meta[t]["country"],
                        "sector": ticker_meta[t]["sector"],
                        "source": (profiles[t].source if profiles.get(t) else "sector_model"),
                        "confidence": (
                            profiles[t].confidence
                            if profiles.get(t)
                            else SECTOR_MODEL_CONFIDENCE
                        ),
                    }
                    for t, score in top_tickers
                ]
                # Legacy `affected_tickers` field — bare list of
                # tickers in score order. Kept for back-compat with
                # any FE consumer still on the old shape. The new
                # `affected_tickers_rich` is the canonical field the
                # updated radar UI reads (exposure bars + country flag).
                affected_tickers = [t for t, _ in top_tickers]

                # Aggregate severity → 0-100 card score (unchanged)
                if cat_signals:
                    sev_avg = sum({"critical":85,"high":60,"medium":35,"low":15}[s.severity]
                                  for s in cat_signals) / len(cat_signals)
                else:
                    sev_avg = 0

                # Compute the sector diversity of this card's top-12 for
                # the FE's "Closely related to {X}" badge. When the top-12
                # is drawn from <4 sectors, the radar is structurally
                # constrained — flag it so the FE can show a hint.
                sectors_represented = len({
                    ticker_meta[t]["sector"] for t, _ in top_tickers
                })
                if cat in _KNOWN_STRUCTURAL_CORRELATIONS:
                    diversity_status = "structural_correlation"
                elif sectors_represented < 3:
                    diversity_status = "sector_constrained"
                else:
                    diversity_status = "diverse"

                categories[cat] = {
                    "category": cat,
                    "score": int(round(sev_avg)),
                    "level": (
                        "critical" if sev_avg >= 75 else
                        "high"     if sev_avg >= 50 else
                        "medium"   if sev_avg >= 25 else
                        "low"
                    ),
                    "affected_sectors": affected_sectors,
                    "affected_tickers": affected_tickers,
                    "affected_tickers_rich": affected_tickers_rich,
                    # FE-rendered honesty signal — see
                    # _KNOWN_STRUCTURAL_CORRELATIONS above for the
                    # documented overlapping pairs (energy×fx,
                    # geopolitical×supply_chain). When this is
                    # "structural_correlation", the FE renders a "Closely
                    # related to {related}" badge so the user understands
                    # why two cards look similar instead of assuming the
                    # radar is broken. "sector_constrained" fires when
                    # top-12 draws from <3 sectors (real concentration
                    # outweighs diversity cap). "diverse" is the healthy
                    # default. Per the README ladder doc — honest about
                    # the underlying data shape.
                    "diversity_status": diversity_status,
                    "structural_correlations": _KNOWN_STRUCTURAL_CORRELATIONS.get(cat, []),
                    "sectors_represented": sectors_represented,
                    "signal_count": len(cat_signals),
                    "top_signals": _serialize([s for s in cat_signals[:3]]),
                }

            return {
                "categories": categories,
                "feed_status": get_macro_signal_service().feed_status(),
                "computed_at": datetime.now(timezone.utc).isoformat(),
            }

        return cache.get_or_compute("risk-radar:v1", RADAR_TTL_SEC, _compute)

    # ─── Macro Signals feed ─────────────────────────────────────────────
    @router.get("/macro-signals")
    def macro_signals(
        request: Request,
        sector: Optional[str] = Query(None),
        ticker: Optional[str] = Query(None),
        limit: int = Query(50, ge=1, le=200),
    ) -> dict[str, Any]:
        """EGRESS-GUARDED on the SIGNAL FEED's warmth.

        This route used to cache on a key built from the caller's own
        ``sector`` / ``ticker`` / ``limit`` — so the cache was real but the
        caller held the miss lever. MEASURED before the fix: 3 identical
        calls cost 13 outbound, and 5 calls differing only in ``?limit=``
        cost 65. The filters are now applied to the shared server-keyed
        feed, so they select from cached data and cost nothing; only the
        feed's own TTL decides when a provider is touched again.
        """
        limited = _egress_guard(
            request,
            route="/api/public/intelligence/macro-signals",
            warm=_feed_warm(),
        )
        if limited is not None:
            return limited  # type: ignore[return-value]

        svc = get_macro_signal_service()
        live_signals = _signal_feed()
        sector_signals = synthesize_sector_signals(
            sector_filter=[sector] if sector else None,
        )
        all_signals = list(live_signals) + sector_signals

        if ticker:
            tu = ticker.upper()
            all_signals = [s for s in all_signals if tu in s.affected_tickers]
        elif sector:
            all_signals = [s for s in all_signals if sector in s.affected_sectors]

        # TOTAL over a naive/aware mixture and over undated items — see
        # ``_signal_sort_key``. This line is where the merged feed's
        # ordering used to raise ``TypeError`` and answer 500.
        all_signals.sort(key=_signal_sort_key)

        return {
            "signals": _serialize(all_signals[:limit]),
            "feed_status": svc.feed_status(),
            "total": len(all_signals),
        }

    # ─── Supply Chain ───────────────────────────────────────────────────
    @router.get("/supply-chain")
    def supply_chain(
        request: Request,
        ticker: Optional[str] = Query(None),
        sector: Optional[str] = Query(None),
    ) -> dict[str, Any]:
        """Supply-chain exposure for a ticker or sector.

        ticker → single-company exposure bars + source label
        sector → sector default exposure + affected tickers

        Only the TICKER branch can reach a provider, so only that branch
        is egress-guarded. The sector branch is a library lookup and reaches
        nothing (MEASURED: 0 outbound over four calls) — guarding it would
        charge a token for a request that cannot fetch anything.

        The ticker branch guarded on the UNIVERSE's warmth while its
        compute built the profile with ``try_filings=True`` — SEC EDGAR
        plus a paid completion per ticker, uncached on this route. MEASURED
        2026-09-04 with ``SEC_EDGAR_ENABLED`` + ``ANTHROPIC_API_KEY`` set and
        the universe warm: 9 distinct tickers, 9 completions, 0 x 429 on a
        budget of 3/min. It now validates the ticker first, reads the
        shared ``exposure:`` cache, and is warm only when that profile is.
        """
        if ticker:
            tu = _validated_ticker(ticker)
            limited = _egress_guard(
                request,
                route="/api/public/intelligence/supply-chain",
                warm=_profile_warm(tu),
            )
            if limited is not None:
                return limited  # type: ignore[return-value]
            return {"ticker": tu, "exposure": _serialize(_exposure_profile(tu))}

        if sector:
            profile = SECTOR_RISK_LIBRARY.get(sector)
            if profile is None:
                raise HTTPException(404, f"Sector {sector} not in library")
            tickers = [t for t, _, s in universe_module.DEFAULT_UNIVERSE if s == sector]
            return {
                "sector": sector,
                "default_geographic_exposure": profile.default_geographic_exposure,
                "default_supply_chain_exposure": profile.default_supply_chain_exposure,
                "default_financial_sensitivity": profile.default_financial_sensitivity,
                "affected_tickers": tickers,
                "source": "sector_model",
            }

        raise HTTPException(400, "Provide ?ticker= or ?sector=")

    # ─── Per-ticker risk score ──────────────────────────────────────────
    @router.get("/companies/{ticker}/risk-score")
    def ticker_risk_score(ticker: str, request: Request) -> dict[str, Any]:
        """EGRESS-GUARDED on EVERYTHING its compute touches.

        Three resources: the universe (11 outbound cold, 0 warm), the
        signal feed (13 cold, 0 warm) and the per-ticker exposure profile
        (SEC EDGAR + a paid completion cold when the filings layer is on,
        0 warm). The guard used to read the universe's warmth alone —
        MEASURED 2026-09-04: warm universe + cold score cache = 13 outbound
        with NO token — then the universe's and the feed's, which still
        left the filings chain unread. Warm is now the score cache itself,
        or the conjunction of all three.
        """
        tu = _validated_ticker(ticker)
        cache = get_intelligence_cache()
        score_key = f"risk-score:{tu}"
        limited = _egress_guard(
            request,
            route="/api/public/intelligence/companies/{ticker}/risk-score",
            warm=(cache.get(score_key) is not None
                  or (_universe_warm() and _feed_warm() and _profile_warm(tu))),
        )
        if limited is not None:
            return limited  # type: ignore[return-value]

        def _compute():
            snaps = _fetch_universe_snapshots()
            snap = snaps.get(tu)
            if snap is None:
                raise HTTPException(404, f"Ticker {tu} not in universe")
            profile = _exposure_profile(tu)
            financials = _financials_from_snapshot(snap)
            # Shared feed, not fetch_for_ticker: the latter calls
            # fetch_all() and would fan out 13 per ticker per score-cache
            # miss. Filtering the cached feed is the same answer for zero
            # outbound.
            signals = [s for s in _signal_feed() if tu in s.affected_tickers]
            score = compute_risk_score(profile, financials, signals)
            return _serialize(score)

        return cache.get_or_compute(score_key, SCORE_TTL_SEC, _compute)

    # ─── Per-ticker exposure ────────────────────────────────────────────
    @router.get("/companies/{ticker}/exposure")
    def ticker_exposure(ticker: str, request: Request) -> dict[str, Any]:
        """EGRESS-GUARDED on the PROFILE's warmth — see ``_profile_warm``.

        This route is the drill-down the activation runbook's cold-fill
        smoke test drives, and the one the critic measured at 30 distinct
        tickers = unmetered EDGAR + Claude on a warm universe. Warm is the
        cached profile, or a warm universe AND a warm filings layer.
        """
        tu = _validated_ticker(ticker)
        limited = _egress_guard(
            request,
            route="/api/public/intelligence/companies/{ticker}/exposure",
            warm=_profile_warm(tu),
        )
        if limited is not None:
            return limited  # type: ignore[return-value]
        return _serialize(_exposure_profile(tu))

    # ─── Per-ticker signals ─────────────────────────────────────────────
    @router.get("/companies/{ticker}/signals")
    def ticker_signals(ticker: str, request: Request) -> dict[str, Any]:
        """EGRESS-GUARDED on the SIGNAL FEED's warmth.

        This route had NO cache and NO guard while every sibling in this
        router had both, and the egress map classified it NO_EGRESS.
        MEASURED with the five signal vars set: 13 outbound on EVERY call
        (3 identical calls = 39), and a nonsense ticker cost the same 13
        because ``fetch_for_ticker`` filters AFTER the fan-out rather than
        narrowing it. It now reads the shared feed, so a repeat inside the
        window costs zero outbound and zero budget.
        """
        tu = _validated_ticker(ticker)
        limited = _egress_guard(
            request,
            route="/api/public/intelligence/companies/{ticker}/signals",
            warm=_feed_warm(),
        )
        if limited is not None:
            return limited  # type: ignore[return-value]
        svc = get_macro_signal_service()
        live = [s for s in _signal_feed() if tu in s.affected_tickers]
        sector_for_ticker = next(
            (s for t, _, s in universe_module.DEFAULT_UNIVERSE if t == tu), None,
        )
        sector_signals = synthesize_sector_signals(
            sector_filter=[sector_for_ticker] if sector_for_ticker else None,
        ) if sector_for_ticker else []
        return {
            "ticker": tu,
            "signals": _serialize(live + sector_signals),
            "feed_status": svc.feed_status(),
        }

    # ─── Per-ticker AI Market Read (Phase B — real Claude Opus) ─────────
    @router.get("/companies/{ticker}/ai-market-read")
    def ai_market_read(ticker: str, request: Request) -> dict[str, Any]:
        """Per-ticker AI Market Read narrative.

        Phase B: calls Claude Opus via `compose_ai_market_read()` when
        ANTHROPIC_API_KEY is set. Falls back to the deterministic template
        on any LLM failure (missing key, network, malformed JSON). The
        response shape is identical in both cases — only model_id differs.

        CACHED + EGRESS-GUARDED (2026-09-04). This route had NO cache while
        every sibling in this router had one, and MEASURED with a spy
        client four identical anonymous GETs produced four completions. On
        a deployment with ANTHROPIC_API_KEY set that is one paid Claude
        request per anonymous call, with no ceiling — the only amplifier on
        this surface whose cost is money rather than a rate, which is why
        it gets a cache rather than only a budget.

        ``warm`` is the cached read itself — a hit returns before any
        compute — or, on a miss, the conjunction of every resource the
        compute touches: the universe, the signal feed, the per-ticker
        profile (EDGAR + Claude when the filings layer is on) AND no LLM
        key, because with a key set a miss is a paid completion every
        time. It used to be ``cached and _universe_warm()``, which charged
        a token for a cached read whenever the universe had lapsed, and
        knew nothing of the filings chain the compute reaches.
        """
        tu = _validated_ticker(ticker)
        cache = get_intelligence_cache()
        cache_key = "ai-market-read:%s" % tu
        cached = cache.get(cache_key)
        limited = _egress_guard(
            request,
            route="/api/public/intelligence/companies/{ticker}/ai-market-read",
            warm=(cached is not None
                  or (_universe_warm() and _feed_warm() and _profile_warm(tu)
                      and not _llm_configured())),
        )
        if limited is not None:
            return limited  # type: ignore[return-value]
        if cached is not None:
            return cached
        snaps = _fetch_universe_snapshots()
        snap = snaps.get(tu)
        if snap is None:
            raise HTTPException(404, f"Ticker {tu} not in universe")
        profile = _exposure_profile(tu)
        financials = _financials_from_snapshot(snap)
        signals = [s for s in _signal_feed() if tu in s.affected_tickers]
        risk = compute_risk_score(profile, financials, signals)
        opportunity = compute_opportunity_score(profile, financials, signals)
        feed_status = get_macro_signal_service().feed_status()

        read = compose_ai_market_read(
            ticker=tu,
            company_name=profile.company_name,
            sector=profile.sector,
            industry=profile.industry,
            risk=risk,
            opportunity=opportunity,
            exposure=profile,
            signals=signals,
            feed_status=feed_status,
        )
        payload = _serialize(read)
        cache.put(cache_key, payload, AI_READ_TTL_SEC)
        return payload

    # ─── Manual signal upload ───────────────────────────────────────────
    @router.post("/signals/manual")
    def post_manual_signal(payload: ManualSignalIn, request: Request) -> dict[str, Any]:
        """Create a macro signal by hand. OPERATOR ONLY — WALLED, fail closed.

        This route WRITES content the product then shows to users: the new
        signal feeds risk-radar, macro-signals and every per-ticker risk
        score (this handler busts those three caches itself, below). Until
        2026-09-04 it had no authentication of any kind — an anonymous POST
        with a valid payload answered 200 and the signal was live. That is
        content injection, not a cache bust.

        A rate limit would be the wrong control: it still admits one
        injected signal per window, and one is enough. So this follows
        tests/engine/test_cron_auth.py's fail-closed contract (503 with the
        token unset, 401 on a missing/wrong bearer) rather than the
        refresh_shield contract used by the cache-bust routes next door.
        See refresh_shield.require_operator for the full justification.
        """
        _require_operator(request, route="/api/public/intelligence/signals/manual")
        svc = get_macro_signal_service()
        signal = svc.manual.create_signal(
            signal_type=payload.signal_type,
            title=payload.title,
            summary=payload.summary,
            severity=payload.severity,
            time_horizon=payload.time_horizon,
            affected_sectors=payload.affected_sectors,
            affected_industries=payload.affected_industries,
            affected_companies=payload.affected_companies,
            affected_tickers=payload.affected_tickers,
            geography=payload.geography,
            financial_impact_channels=payload.financial_impact_channels,
            risk_categories=payload.risk_categories,
            confidence=payload.confidence,
            source_label=payload.source_label,
            source_url=payload.source_url,
        )
        # Bust caches that depend on signal state.
        cache = get_intelligence_cache()
        cache.invalidate("risk-radar:")
        cache.invalidate("macro-signals:")
        cache.invalidate("risk-score:")
        # 2026-09-04 — same reason as in refresh-signals: the AI Market
        # Read narrates these signals, so a new one makes it stale too.
        cache.invalidate("ai-market-read:")
        return {"signal": _serialize(signal), "ok": True}

    # ─── Universe-wide risk-score batch ─────────────────────────────────
    @router.get("/risk-scores")
    def risk_scores_batch(request: Request) -> dict[str, Any]:
        """One call → risk-score summary for every ticker in the universe.

        The universe-wide table needs an AI Risk column per row. Calling
        /companies/{ticker}/risk-score 200 times is wasteful — this endpoint
        builds + scores every profile in one pass and returns a compact
        summary keyed by ticker.

        Cached for SCORE_TTL_SEC (3 min) so frequent FE re-renders during
        sort/filter operations don't re-compute every time.

        EGRESS-GUARDED on the universe's warmth — the compute hydrates it
        (7 outbound cold, 0 warm).
        """
        limited = _egress_guard(
            request,
            route="/api/public/intelligence/risk-scores",
            warm=_universe_warm(),
        )
        if limited is not None:
            return limited  # type: ignore[return-value]
        cache = get_intelligence_cache()

        def _compute():
            industry = _industry_lookup()
            profiles = build_universe_exposure_profiles(
                universe_module.DEFAULT_UNIVERSE,
                industry_lookup=industry,
            )
            snaps = _fetch_universe_snapshots()

            out: dict[str, dict[str, Any]] = {}
            for ticker, profile in profiles.items():
                snap = snaps.get(ticker, {})
                financials = _financials_from_snapshot(snap) if snap else {}
                # Signals matched per-ticker — at Phase A these come from
                # synthesized sector signals via the orchestrator.
                # Skipping per-ticker signal fetch here since the universe
                # batch is hot path; categories already reflect sector model.
                risk = compute_risk_score(profile, financials, [])
                opp = compute_opportunity_score(profile, financials, [])
                out[ticker] = {
                    "ticker": ticker,
                    "risk_score": risk.overall_risk_score,
                    "risk_level": risk.risk_level,
                    "main_risk": (
                        risk.top_risks[0].label if risk.top_risks else None
                    ),
                    "main_risk_severity": (
                        risk.top_risks[0].severity if risk.top_risks else None
                    ),
                    "opportunity_score": opp.overall_opportunity_score,
                    "opportunity_level": opp.strength_level,
                    "exposure_source": profile.source,
                    "confidence": profile.confidence,
                }
            return {
                "scores": out,
                "total": len(out),
                "feed_status": get_macro_signal_service().feed_status(),
                "computed_at": datetime.now(timezone.utc).isoformat(),
            }

        return cache.get_or_compute("risk-scores:universe:v1", SCORE_TTL_SEC, _compute)

    # ─── Filings cache freshness (Phase D.2) ────────────────────────────
    @router.post("/refresh-filings-cache")
    def refresh_filings_cache(request: Request) -> dict[str, Any]:
        """Poll EDGAR's recent-10-K Atom feed → invalidate stale cache.

        Operator wires this to a 15-minute cron / k8s CronJob. EDGAR's
        `getcurrent` feed updates ~10 min cycle, so 15-min cadence catches
        new filings without saturating. Single-source orchestration —
        external cron prevents N-pod multiplication of EDGAR load.

        OPERATOR ONLY — WALLED, fail closed. Unlike the cache-bust routes
        next door, this one does not merely make the NEXT read cold: it
        performs the EDGAR request itself, synchronously, inside the
        handler (run_refresh → _fetch_recent_10k_filings → urlopen). Until
        2026-09-04 it answered 200 unauthenticated, so an anonymous loop
        here was a direct outbound amplifier against a host-wide published
        ceiling of 10 req/s — and a block there takes the whole US market
        down. Its own docstring already said the only intended caller is a
        cron, and it has no caller in frontend/, e2e/, scripts/ or deploy/,
        so the fail-closed contract of tests/engine/test_cron_auth.py is
        the right one: running it unauthenticated is worse than not
        running it. See refresh_shield.require_operator.

        OPERATOR FOLLOW-UP: the cron line in
        docs/public-intelligence-activation-runbook.md curls this route
        with no Authorization header and will now 401. It must send
        `-H "Authorization: Bearer $ENGINE_API_TOKEN"`.
        """
        _require_operator(request, route="/api/public/intelligence/refresh-filings-cache")
        result = run_refresh()
        # This route is what CHANGES the filings rows /health reports on, so
        # it is the route that must drop the cached observability block —
        # not refresh-signals, which busts the signal-derived views. Without
        # this an operator would refresh the cache and read a stale count
        # back from /health for up to SIGNALS_TTL_SEC and conclude the
        # refresh did nothing.
        get_intelligence_cache().invalidate(_FILINGS_OBS_KEY)
        return result.to_dict()

    # ─── Cache refresh ──────────────────────────────────────────────────
    @router.post("/refresh-signals")
    def refresh_signals(request: Request) -> dict[str, Any]:
        """Bust the radar / macro / risk-score / exposure caches.

        SHIELDED (engine.public.refresh_shield): a valid ENGINE_API_TOKEN
        bearer is never limited; anonymous callers spend one token from a
        per-client bucket and get 429 + Retry-After over the budget. The
        guard runs BEFORE any cache is invalidated, so a 429 mutates
        nothing. With the token unset the bearer path is simply unavailable
        and the anonymous path still serves — deliberately NOT the
        fail-closed contract of tests/engine/test_cron_auth.py; see the
        shield's module docstring for why the asymmetry is intended.
        """
        limited = _refresh_guard(request, route="/api/public/intelligence/refresh-signals")
        if limited is not None:
            return limited  # type: ignore[return-value]
        cache = get_intelligence_cache()
        dropped = (
            cache.invalidate("risk-radar:")
            + cache.invalidate("macro-signals:")
            + cache.invalidate("risk-score:")
            + cache.invalidate("exposure:")
            # 2026-09-04 — the AI Market Read is a narrative ABOUT the
            # signals and the risk score, so a signal change makes it stale
            # exactly like the four above. Listed last so the count grows
            # rather than any existing key changing meaning.
            + cache.invalidate("ai-market-read:")
        )
        return {"cache_keys_invalidated": dropped, "ok": True}

    return router


def _derive_categories_for_profile(profile) -> list[str]:
    """Best-effort mapping of an exposure profile's risks → RiskCategory list."""
    cats = set()
    channel_to_cat = {
        "supply_availability": "supply_chain",
        "inventory": "supply_chain",
        "valuation_multiple": "rates_credit",
        "debt_cost": "rates_credit",
        "fx": "fx",
        "revenue": "consumer_demand",
        "capex": "technology",
    }
    for risk in profile.main_risks[:8]:
        for ch in risk.channels:
            if ch in channel_to_cat:
                cats.add(channel_to_cat[ch])
    return sorted(cats)


def _build_watchlist(profile, risk: PublicCompanyRiskScore) -> list[str]:
    """Produce a deterministic 'what to watch' list from the score breakdown.

    No LLM — just a template tied to top risks + category scores. The
    eventual Claude call will replace this with a richer per-ticker
    narrative.
    """
    items: list[str] = []
    if risk.top_risks:
        items.append(f"Watch {risk.top_risks[0].label} — {risk.top_risks[0].severity} severity.")
    if risk.categories.financial >= 60:
        items.append("Watch upcoming refinancings + interest coverage trend.")
    if risk.categories.supply_chain >= 60:
        items.append("Watch shipping cost + supplier concentration disclosures.")
    if risk.categories.geopolitical >= 60:
        items.append("Watch regional revenue exposure breakdown in next 10-K.")
    if risk.categories.valuation >= 60:
        items.append("Watch peer-relative valuation — multiple compression risk.")
    if not items:
        items.append("No specific watch flags — score is composite-low.")
    return items
