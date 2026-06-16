"""DB-backed cache for Nasdaq raw payloads.

NASDAQ-1 scope: API contract + signature. NASDAQ-5 wires the actual SQL
against the nasdaq_responses table created by NASDAQ-2.

Cache strategy:
  • Fundamentals (SF1): TTL 24h. Sharadar releases fundamentals on
    quarterly/annual filing cadence; a 24h cache catches multiple user
    requests for the same ticker without re-hitting the wire.
  • Daily metrics (DAILY): TTL 15min during US market hours
    (13:30–20:00 UTC weekdays), 6h otherwise. Market cap moves intraday.
  • Quotes (SEP): TTL 15min during market hours, 6h otherwise.
  • Tickers reference (TICKERS): TTL 7 days. Names + exchanges don't
    move often; a stale row is acceptable for search UX.

Cache key: tuple(table, ticker, dimension_or_date, query_hash). The
query_hash captures any filter params so two different filters on the
same ticker don't collide.

Why DB-backed (not in-memory): backend can restart between user requests.
A 30-second uvicorn reload after a code push would otherwise nuke a hot
cache and trigger a stampede of Sharadar calls. The cache survives.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


# TTL constants (seconds) — module-level so tests can monkeypatch.
TTL_FUNDAMENTALS = 24 * 60 * 60  # 24h
TTL_DAILY_MARKET_HOURS = 15 * 60  # 15min
TTL_DAILY_OFF_HOURS = 6 * 60 * 60  # 6h
TTL_TICKERS = 7 * 24 * 60 * 60  # 7d


@dataclass
class CacheEntry:
    """One row from nasdaq_responses."""

    table_name: str
    ticker: str
    dimension_or_date: str  # "ARY" / "2026-05-24" / "" depending on dataset
    query_hash: str
    payload: Dict[str, Any]
    fetched_at: datetime
    expires_at: datetime

    @property
    def is_fresh(self) -> bool:
        return datetime.now(timezone.utc) < self.expires_at


def make_query_hash(params: Dict[str, Any]) -> str:
    """Deterministic short hash of arbitrary query params.

    Used as part of the cache key so two requests with different filters on
    the same (table, ticker) don't conflict. JSON-encoding with sort_keys is
    stable across Python versions.
    """
    canonical = json.dumps(params, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


def is_us_market_hours(now: Optional[datetime] = None) -> bool:
    """Best-effort check for US equity market hours (NYSE/NASDAQ).

    Doesn't account for half-days or holidays — those just mean we get a
    slightly fresher cache than strictly necessary. Acceptable error mode.
    """
    now = now or datetime.now(timezone.utc)
    if now.weekday() >= 5:  # Sat/Sun
        return False
    # 13:30–20:00 UTC = 09:30–16:00 ET (standard, ignoring DST nuance)
    return (now.hour, now.minute) >= (13, 30) and now.hour < 20


def daily_ttl_now() -> int:
    """Return TTL seconds for daily-metrics endpoints, market-hours aware."""
    return TTL_DAILY_MARKET_HOURS if is_us_market_hours() else TTL_DAILY_OFF_HOURS


class NasdaqCache:
    """SQLite/Postgres-backed cache. NASDAQ-5 implements get/put against
    the nasdaq_responses table; NASDAQ-1 ships the signature only."""

    def __init__(self, db_url: Optional[str] = None):
        self._db_url = db_url

    def get(self, table_name: str, ticker: str, dimension_or_date: str, query_hash: str) -> Optional[CacheEntry]:
        # NASDAQ-5 will query: SELECT * FROM nasdaq_responses WHERE
        # table_name=? AND ticker=? AND dimension_or_date=? AND query_hash=?
        # AND expires_at > now()
        raise NotImplementedError("NASDAQ-5 — wire to Supabase/SQLite session")

    def put(self, entry: CacheEntry) -> None:
        # NASDAQ-5 will INSERT … ON CONFLICT UPDATE the entry.
        raise NotImplementedError("NASDAQ-5 — wire to Supabase/SQLite session")


__all__ = [
    "CacheEntry",
    "NasdaqCache",
    "make_query_hash",
    "is_us_market_hours",
    "daily_ttl_now",
    "TTL_FUNDAMENTALS",
    "TTL_DAILY_MARKET_HOURS",
    "TTL_DAILY_OFF_HOURS",
    "TTL_TICKERS",
]
