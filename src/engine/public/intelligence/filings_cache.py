"""DB-primary cache for filings-derived CompanyExposureProfiles.

Architecture decision (locked Phase D, 2026-05-27):

  · DB (Supabase `company_exposure_profiles`) is the SOURCE OF TRUTH.
  · In-memory layer is a read-through cache for hot tickers.
  · The reverse (in-memory primary, DB as backup) would create
    split-brain on multi-container deploys — if we ever horizontally
    scale, in-memory-primary fails immediately. DB-primary survives.

The Phase A schema (`schema_phase_intelligence_engine.sql`) already
created `company_exposure_profiles` with the right shape — ticker PK,
JSONB exposure maps, source TEXT, last_updated TIMESTAMPTZ. Phase D
is when we actually start writing to it.

Resolution order on get():
  1. In-memory TTL hit → return (fast path)
  2. DB row hit + fresh (last_updated > NOW() - 7 days) → load + cache in-memory + return
  3. Miss → caller does the EDGAR + Claude work + calls set_cached() to populate

TTL: 7 days. Most 10-Ks update annually; quarterly 10-Q updates aren't
extracted yet (Phase D scope is locked to 10-K). The EDGAR RSS refresh
loop (filings_refresh.py) invalidates entries when SEC publishes a new
10-K for a cached ticker, so the 7-day TTL is a safety net rather than
the primary freshness signal.

Counters: cache_hit_rate, evictions_last_24h, last_invalidation_at are
process-local (not aggregated across containers). The /health endpoint
labels them `container-local` so operators don't trust them as
cluster-wide.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from .models import (
    CompanyExposureProfile,
    OpportunityRef,
    RiskRef,
)

logger = logging.getLogger(__name__)


# 7 days. Locked here so tests can monkeypatch a smaller value.
CACHE_TTL_DAYS = 7
CACHE_TTL_SEC = CACHE_TTL_DAYS * 24 * 60 * 60

# In-memory TTL on the read-through layer. Shorter than DB TTL so a
# multi-container scale-up sees fresh DB writes within a few minutes
# rather than holding stale data for the full week.
IN_MEMORY_TTL_SEC = 5 * 60   # 5 min


# ─────────────────────────────────────────────────────────────────────────
# Metrics — process-local counters surfaced via /health
# ─────────────────────────────────────────────────────────────────────────

@dataclass
class _Metrics:
    """Process-local cache metrics.

    NOT aggregated across containers. The /health endpoint exposes the
    fields with `container-local` label so the operator can't mistake them
    for cluster-wide values. If multi-deploy ever happens, we either:
      a. push these to a counter table (overkill for now), OR
      b. trust the operator to query each container's /health and sum.
    """
    hits: int = 0
    misses: int = 0
    writes: int = 0
    invalidations: int = 0
    last_invalidation_at: Optional[datetime] = None
    # Eviction timestamps — used to compute "evictions in the last 24h"
    # without retaining a full history. deque caps at 1000 entries; if we
    # ever exceed that in a 24h window we're already in trouble.
    eviction_timestamps: deque = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.eviction_timestamps is None:
            self.eviction_timestamps = deque(maxlen=1000)


_METRICS = _Metrics()
_METRICS_LOCK = threading.Lock()


def record_hit() -> None:
    with _METRICS_LOCK:
        _METRICS.hits += 1


def record_miss() -> None:
    with _METRICS_LOCK:
        _METRICS.misses += 1


def record_write() -> None:
    with _METRICS_LOCK:
        _METRICS.writes += 1


def record_invalidation() -> None:
    with _METRICS_LOCK:
        _METRICS.invalidations += 1
        _METRICS.last_invalidation_at = datetime.now(timezone.utc)
        _METRICS.eviction_timestamps.append(time.time())


def reset_metrics() -> None:
    """Test helper — clear all counters."""
    global _METRICS
    with _METRICS_LOCK:
        _METRICS = _Metrics()


def get_metrics_snapshot() -> dict:
    """Read-only metrics view. Computed lazily so /health stays cheap.

    Returns container-local counters. cache_hit_rate is rolling since
    process start (resets on container restart — acceptable for our
    deployment cadence).
    """
    with _METRICS_LOCK:
        total = _METRICS.hits + _METRICS.misses
        hit_rate = _METRICS.hits / total if total > 0 else None
        # Count evictions newer than 24h
        cutoff = time.time() - 24 * 60 * 60
        evictions_24h = sum(1 for t in _METRICS.eviction_timestamps if t >= cutoff)
        return {
            "hits": _METRICS.hits,
            "misses": _METRICS.misses,
            "writes": _METRICS.writes,
            "invalidations": _METRICS.invalidations,
            "cache_hit_rate": hit_rate,
            "evictions_last_24h": evictions_24h,
            "last_invalidation_at": (
                _METRICS.last_invalidation_at.isoformat()
                if _METRICS.last_invalidation_at else None
            ),
            "metrics_scope": "container-local",
        }


# ─────────────────────────────────────────────────────────────────────────
# In-memory layer — thin TTL wrapper, NOT the source of truth
# ─────────────────────────────────────────────────────────────────────────

# (ticker_upper) → (expires_at_epoch, profile)
_in_memory_cache: dict[str, tuple[float, CompanyExposureProfile]] = {}
_in_memory_lock = threading.Lock()


def _memory_get(ticker: str) -> Optional[CompanyExposureProfile]:
    with _in_memory_lock:
        entry = _in_memory_cache.get(ticker)
        if entry is None:
            return None
        expires_at, profile = entry
        if time.time() >= expires_at:
            # Cooperative eviction during get — keeps the dict from
            # growing unbounded between explicit reset_in_memory() calls.
            _in_memory_cache.pop(ticker, None)
            return None
        return profile


def _memory_put(ticker: str, profile: CompanyExposureProfile) -> None:
    with _in_memory_lock:
        _in_memory_cache[ticker] = (
            time.time() + IN_MEMORY_TTL_SEC,
            profile,
        )


def _memory_invalidate(ticker: str) -> bool:
    with _in_memory_lock:
        return _in_memory_cache.pop(ticker, None) is not None


def reset_in_memory() -> None:
    """Test helper — drop the in-memory cache without touching DB."""
    with _in_memory_lock:
        _in_memory_cache.clear()


# ─────────────────────────────────────────────────────────────────────────
# DB layer — the source of truth
# ─────────────────────────────────────────────────────────────────────────

def _get_admin_client():
    """Lazy Supabase admin client. Returns None if env not configured
    (e.g. local dev without Supabase). Lets cache calls no-op silently
    so the rest of the engine still works."""
    try:
        from ...api._supabase import admin
        return admin()
    except Exception as e:
        logger.debug("filings_cache: Supabase admin client unavailable: %s", e)
        return None


def _db_get(ticker: str) -> Optional[CompanyExposureProfile]:
    """Read a single filings-source row for `ticker` from
    `company_exposure_profiles`. Returns None on:
      · Supabase unavailable
      · No row for this ticker
      · Row exists but is stale (> CACHE_TTL_DAYS old)
      · Row exists but source != "filings" (manual / ai_inferred etc.
        don't go through this cache path)
    """
    client = _get_admin_client()
    if client is None:
        return None
    try:
        rows = client.select(
            "company_exposure_profiles",
            filters={
                "ticker": f"eq.{ticker.upper()}",
                "source": "eq.filings",
            },
        )
    except Exception as e:
        logger.warning("filings_cache._db_get failed for %s: %s", ticker, e)
        return None
    if not rows:
        return None

    row = rows[0]
    last_updated = _parse_db_datetime(row.get("last_updated"))
    if last_updated is None:
        return None
    age = datetime.now(timezone.utc) - last_updated
    if age > timedelta(seconds=CACHE_TTL_SEC):
        # DB entry exists but is past TTL — treat as miss + evict.
        # The refresh-filings-cache endpoint will eventually overwrite
        # this row with fresh data; doing nothing here is fine.
        return None

    return _row_to_profile(row)


def _db_put(profile: CompanyExposureProfile) -> bool:
    """Upsert the profile to `company_exposure_profiles`.

    Source must be "filings" — manual + ai_inferred go through other
    paths. Returns True on success, False otherwise (and logs).
    """
    if profile.source != "filings":
        logger.warning("filings_cache._db_put refused non-filings source: %s",
                       profile.source)
        return False
    client = _get_admin_client()
    if client is None:
        return False
    try:
        client.upsert(
            "company_exposure_profiles",
            {
                "ticker": profile.ticker.upper(),
                "company_name": profile.company_name,
                "sector": profile.sector,
                "industry": profile.industry,
                "geographic_exposure": profile.geographic_exposure,
                "supply_chain_exposure": profile.supply_chain_exposure,
                "financial_sensitivity": profile.financial_sensitivity,
                "main_risks": [_riskref_to_dict(r) for r in profile.main_risks],
                "main_opportunities": [
                    _oppref_to_dict(o) for o in profile.main_opportunities
                ],
                "confidence": profile.confidence,
                "source": profile.source,
                "last_updated": profile.last_updated.isoformat(),
            },
            on_conflict="ticker",
        )
        return True
    except Exception as e:
        logger.warning("filings_cache._db_put failed for %s: %s",
                       profile.ticker, e)
        return False


def _db_invalidate(ticker: str) -> bool:
    """Delete the filings-source row for `ticker` from
    `company_exposure_profiles`. Returns True if a row was removed.

    Only deletes when source == "filings" so we never nuke a
    manually-curated override accidentally.
    """
    client = _get_admin_client()
    if client is None:
        return False
    try:
        # Use a raw delete-with-filter; SupabaseClient exposes select +
        # insert + upsert but we need delete. Falls through to HTTP.
        import httpx  # type: ignore
        from ...api._supabase import load_config
        cfg = load_config()
        resp = httpx.delete(
            f"{cfg.url}/rest/v1/company_exposure_profiles",
            params={"ticker": f"eq.{ticker.upper()}", "source": "eq.filings"},
            headers={
                "apikey": cfg.service_key,
                "Authorization": f"Bearer {cfg.service_key}",
                "Prefer": "return=representation",
            },
            timeout=8.0,
        )
        if resp.status_code in (200, 204):
            body = resp.json() if resp.text else []
            return len(body) > 0 if isinstance(body, list) else False
        logger.warning("filings_cache._db_invalidate returned %d: %s",
                       resp.status_code, resp.text[:200])
        return False
    except Exception as e:
        logger.warning("filings_cache._db_invalidate failed for %s: %s", ticker, e)
        return False


# ─────────────────────────────────────────────────────────────────────────
# Public API — what filings_extractor.py calls
# ─────────────────────────────────────────────────────────────────────────

def get_cached(ticker: str) -> Optional[CompanyExposureProfile]:
    """Get a cached filings-derived profile.

    Resolution: in-memory → DB → None. Records hit/miss metric.
    """
    ticker_u = ticker.upper()

    # 1. In-memory fast path
    profile = _memory_get(ticker_u)
    if profile is not None:
        record_hit()
        return profile

    # 2. DB read-through. Promotes into in-memory on success.
    profile = _db_get(ticker_u)
    if profile is not None:
        _memory_put(ticker_u, profile)
        record_hit()
        return profile

    record_miss()
    return None


def set_cached(profile: CompanyExposureProfile) -> bool:
    """Write a filings-derived profile to the cache (DB + in-memory).

    Always writes through to DB first; only populates in-memory if the
    DB write succeeded. Prevents in-memory hits for entries that aren't
    actually persisted.
    """
    if profile.source != "filings":
        # Cache only handles filings. Manual + ai_inferred have their own
        # paths. Catch this contract violation early.
        logger.warning("set_cached refused non-filings source: %s", profile.source)
        return False
    ok = _db_put(profile)
    if ok:
        _memory_put(profile.ticker.upper(), profile)
        record_write()
    return ok


def invalidate(ticker: str) -> bool:
    """Remove a ticker's cached filings profile from BOTH layers.

    Used by filings_refresh.py when EDGAR signals a new 10-K. Returns
    True if at least one of the two layers had an entry to remove. Always
    safe to call — invalidating a non-existent entry is a silent no-op.
    """
    ticker_u = ticker.upper()
    mem_evicted = _memory_invalidate(ticker_u)
    db_evicted = _db_invalidate(ticker_u)
    if mem_evicted or db_evicted:
        record_invalidation()
        return True
    return False


def total_cached_entries() -> int:
    """Best-effort count of DB-backed cached entries. Used by /health.

    Returns -1 when Supabase is unavailable so the FE can render
    "unknown" rather than 0 (which would be a lie if DB is just down).
    """
    client = _get_admin_client()
    if client is None:
        return -1
    try:
        rows = client.select(
            "company_exposure_profiles",
            filters={"source": "eq.filings"},
            columns="ticker",
        )
        return len(rows) if rows else 0
    except Exception:
        return -1


def oldest_entry_age_seconds() -> Optional[int]:
    """Age (seconds) of the oldest cached filings profile.

    Useful for /health: if this approaches CACHE_TTL_SEC, the refresh
    loop isn't running often enough OR there's a stuck ticker.
    """
    client = _get_admin_client()
    if client is None:
        return None
    try:
        rows = client.select(
            "company_exposure_profiles",
            filters={"source": "eq.filings"},
            columns="last_updated",
        )
    except Exception:
        return None
    if not rows:
        return None
    oldest: Optional[datetime] = None
    for row in rows:
        ts = _parse_db_datetime(row.get("last_updated"))
        if ts is None:
            continue
        if oldest is None or ts < oldest:
            oldest = ts
    if oldest is None:
        return None
    return int((datetime.now(timezone.utc) - oldest).total_seconds())


# ─────────────────────────────────────────────────────────────────────────
# Row ↔ dataclass conversion helpers
# ─────────────────────────────────────────────────────────────────────────

def _row_to_profile(row: dict) -> CompanyExposureProfile:
    """Build a CompanyExposureProfile from a DB row.

    Defensive against partial rows — missing fields default to {} / []
    rather than raising. A row written by a future schema version
    shouldn't crash today's code.
    """
    return CompanyExposureProfile(
        ticker=str(row["ticker"]).upper(),
        company_name=str(row.get("company_name") or row["ticker"]),
        sector=str(row.get("sector") or "Unknown"),
        industry=row.get("industry"),
        geographic_exposure=_safe_dict(row.get("geographic_exposure")),
        supply_chain_exposure=_safe_dict(row.get("supply_chain_exposure")),
        financial_sensitivity=_safe_dict(row.get("financial_sensitivity")),
        main_risks=[
            _dict_to_riskref(r) for r in (row.get("main_risks") or [])
            if isinstance(r, dict)
        ],
        main_opportunities=[
            _dict_to_oppref(o) for o in (row.get("main_opportunities") or [])
            if isinstance(o, dict)
        ],
        confidence=float(row.get("confidence") or 0.0),
        source=row.get("source") or "filings",
        last_updated=_parse_db_datetime(row.get("last_updated")) or datetime.now(timezone.utc),
    )


def _riskref_to_dict(r: RiskRef) -> dict:
    return {
        "key": r.key,
        "label": r.label,
        "severity": r.severity,
        "channels": list(r.channels),
        "explanation": r.explanation,
    }


def _oppref_to_dict(o: OpportunityRef) -> dict:
    return {
        "key": o.key,
        "label": o.label,
        "severity": o.severity,
        "channels": list(o.channels),
        "explanation": o.explanation,
    }


def _dict_to_riskref(d: dict) -> RiskRef:
    return RiskRef(
        key=str(d.get("key", "")),
        label=str(d.get("label", "")),
        severity=str(d.get("severity", "medium")),       # type: ignore[arg-type]
        channels=list(d.get("channels") or []),
        explanation=str(d.get("explanation", "")),
    )


def _dict_to_oppref(d: dict) -> OpportunityRef:
    return OpportunityRef(
        key=str(d.get("key", "")),
        label=str(d.get("label", "")),
        severity=str(d.get("severity", "medium")),       # type: ignore[arg-type]
        channels=list(d.get("channels") or []),
        explanation=str(d.get("explanation", "")),
    )


def _safe_dict(value) -> dict:
    if isinstance(value, dict):
        return {k: v for k, v in value.items() if isinstance(k, str)}
    return {}


def _parse_db_datetime(value) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            if value.endswith("Z"):
                value = value[:-1] + "+00:00"
            dt = datetime.fromisoformat(value)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None
