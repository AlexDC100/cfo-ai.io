"""Public-company pipeline orchestrator.

NASDAQ-5: ties NasdaqAdapter + normalizer together so the API routes have
one entry point per concept (search / get-company / sync-period). Persistence
to Supabase is deferred to NASDAQ-5b — for the MVP, the routes call back
into this module on every request and rely on the adapter's daily-budget
guard + the Nasdaq response cache (NASDAQ-2 nasdaq_responses table, wired
in NASDAQ-5b) to keep API spend bounded.

Public surface:
  search_companies(query)           → List[TickerHit]
  get_company_envelope(ticker, dim) → assembled_canonical_v1 envelope OR
                                       a "subscription_required" stub when
                                       Sharadar SF1 returns empty data for
                                       this ticker
  sync_company(ticker)              → triggers a fundamentals + daily fetch
                                       so the next get_company_envelope is
                                       warm-cached
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .adapter import Dimension, NasdaqAdapter
from .errors import NasdaqEntitlementError, NasdaqError, NasdaqKeyMissing, NasdaqNotFound
from .normalizer import normalize

logger = logging.getLogger(__name__)


# Module-level singleton so the daily-budget counter persists across requests
# within a single backend process. Multi-replica setups would need a shared
# counter (Redis) — deferred until we actually run more than one replica.
_ADAPTER: Optional[NasdaqAdapter] = None


def get_adapter() -> NasdaqAdapter:
    """Lazy adapter singleton; tests can monkeypatch this."""
    global _ADAPTER
    if _ADAPTER is None:
        _ADAPTER = NasdaqAdapter()
    return _ADAPTER


# ── Search ───────────────────────────────────────────────────────────────


def search_companies(query: str, *, limit: int = 20) -> List[Dict[str, Any]]:
    """Search public companies by ticker or name.

    Returns a list of plain dicts (FE-ready JSON) rather than dataclasses
    so the FastAPI layer can hand the result straight to the client.

    Available on the free Nasdaq Data Link tier — does NOT require Sharadar
    SF1 entitlement. The TICKERS reference table is included even with the
    free key.
    """
    adapter = get_adapter()
    hits = adapter.search(query, limit=limit)
    return [
        {
            "ticker": h.ticker,
            "name": h.name,
            "sector": h.sector,
            "industry": h.industry,
            "exchange": h.exchange,
            "country": h.country,
            "currency": h.currency,
            "is_active": h.is_active,
        }
        for h in hits
    ]


# ── Company envelope ────────────────────────────────────────────────────


def get_company_envelope(
    ticker: str,
    *,
    dimension: Dimension = "ARY",
    limit: int = 20,
) -> Dict[str, Any]:
    """Build the full company envelope: search hit + N periods of fundamentals
    + latest daily metrics, all wrapped per `assembled_canonical_v1`.

    When the operator's Nasdaq key DOES NOT have SF1 entitlement, this
    returns a "subscription_required" envelope with the ticker reference
    info populated (from TICKERS — works on free tier) and an empty periods
    array. The FE renders the dashboard shell with a "Subscribe to Sharadar
    SF1 to load fundamentals" empty state.

    Shape::

        {
          "ticker": "AAPL",
          "ticker_info": {                      # from /api/v3/datatables/SHARADAR/TICKERS
            "name": "Apple Inc",
            "sector": "Technology",
            "industry": "Consumer Electronics",
            "exchange": "NASDAQ",
            "country": "United States",
            "currency": "USD",
          },
          "dimension": "ARY",
          "periods": [                          # one envelope per fiscal period
            {
              "schema_version": "canonical_v1.0.0",
              "ticker": "AAPL",
              "dimension": "ARY",
              "fiscal_period_end": "2024-09-30",
              "headline": { … },
              "leaves": { … },
              "aggregates": { … },
              "market_metrics": { … },          # only on most-recent period
              ...
            },
            …
          ],
          "subscription_required": false,       # true if SF1 returned empty
          "synced_at": "2026-05-24T13:55:00Z",
        }
    """
    adapter = get_adapter()
    ticker = ticker.strip().upper()

    # 1. Ticker reference info (free tier, must work)
    hits = adapter.search(ticker, limit=1)
    if not hits:
        raise NasdaqNotFound(f"No public-company record for ticker {ticker!r}")
    info = hits[0]
    ticker_info = {
        "name": info.name,
        "sector": info.sector,
        "industry": info.industry,
        "exchange": info.exchange,
        "country": info.country,
        "currency": info.currency,
    }

    # 2. Fundamentals (Sharadar SF1 — paid tier)
    rows = adapter.get_fundamentals(ticker, dimension=dimension, limit=limit)
    subscription_required = len(rows) == 0

    # 3. Daily market metrics — also paid (DAILY dataset). Best-effort: don't
    #    fail the whole call if it returns empty.
    daily = None
    if not subscription_required:
        try:
            daily = adapter.get_daily_metrics(ticker)
        except NasdaqError as e:
            logger.warning(f"[public_pipeline] get_daily_metrics({ticker}) skipped: {e.code}")

    # 4. Normalize each fundamentals row to canonical envelope. Attach
    #    market_metrics only to the most-recent period.
    periods = []
    for i, fundamentals_row in enumerate(rows):
        env = normalize(fundamentals_row, daily if i == 0 else None)
        periods.append(env)

    from datetime import datetime, timezone

    return {
        "ticker": ticker,
        "ticker_info": ticker_info,
        "dimension": dimension,
        "periods": periods,
        "subscription_required": subscription_required,
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }


# ── Sync (warm cache + persist) ─────────────────────────────────────────


def sync_company(ticker: str, *, dimensions: Optional[List[Dimension]] = None) -> Dict[str, Any]:
    """Force a refresh across one or more dimensions.

    Returns a summary the FE can show on the "Syncing Nasdaq data…" overlay:
      {
        "ticker": "AAPL",
        "dimensions_synced": ["ARY", "ARQ"],
        "periods_total": 35,
        "subscription_required": false,
        "elapsed_ms": 480,
      }

    Persistence to public_companies / public_company_periods / etc. is wired
    in NASDAQ-5b. For now, sync just returns the freshly-fetched envelope
    counts so the route can echo progress to the FE.
    """
    from datetime import datetime, timezone

    started = datetime.now(timezone.utc)
    dims = dimensions or ["ARY", "ARQ"]
    counts: Dict[str, int] = {}
    subscription_required_any = False
    for d in dims:
        env = get_company_envelope(ticker, dimension=d, limit=20)
        counts[d] = len(env["periods"])
        subscription_required_any = subscription_required_any or env["subscription_required"]
    elapsed_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    return {
        "ticker": ticker.upper(),
        "dimensions_synced": list(counts.keys()),
        "periods_per_dimension": counts,
        "periods_total": sum(counts.values()),
        "subscription_required": subscription_required_any,
        "elapsed_ms": elapsed_ms,
    }


__all__ = ["get_adapter", "search_companies", "get_company_envelope", "sync_company"]
