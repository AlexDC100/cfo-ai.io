"""Phase D — cache + freshness + observability tests.

Three concerns:

  · Cache semantics — in-memory ↔ DB layering, TTL, source-filter
  · Freshness loop — EDGAR Atom parsing, universe-filter discipline
  · Observability — metric counters, hit rate, eviction tracking

No live HTTP, no Supabase. The DB layer is patched via the
`_get_admin_client` indirection; the EDGAR Atom feed is mocked at
urlopen.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from engine.public.intelligence import filings_cache
from engine.public.intelligence.filings_cache import (
    CACHE_TTL_SEC,
    get_cached,
    get_metrics_snapshot,
    invalidate,
    record_hit,
    record_invalidation,
    record_miss,
    reset_in_memory,
    reset_metrics,
    set_cached,
)
from engine.public.intelligence.filings_refresh import (
    RefreshResult,
    _extract_accession_from_link,
    _extract_ticker,
    _normalize_company_name,
    _parse_atom,
    run_refresh,
)
from engine.public.intelligence.models import (
    CompanyExposureProfile,
    OpportunityRef,
    RiskRef,
)


# ─────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────

def _build_profile(ticker: str = "AAPL", source: str = "filings",
                   last_updated: datetime = None) -> CompanyExposureProfile:
    return CompanyExposureProfile(
        ticker=ticker,
        company_name=f"{ticker} Test Co",
        sector="Technology",
        industry=None,
        geographic_exposure={"us": 0.5, "china": 0.5},
        supply_chain_exposure={"semiconductors": 0.7},
        financial_sensitivity={"interest_rates": 0.3},
        main_risks=[
            RiskRef(key="test_risk", label="Test risk",
                    severity="high", channels=["revenue"], explanation="x"),
        ],
        main_opportunities=[],
        confidence=0.85,
        source=source,
        last_updated=last_updated or datetime.now(timezone.utc),
    )


@pytest.fixture(autouse=True)
def reset_all():
    """Clean state between each test — in-memory cache + metrics."""
    reset_in_memory()
    reset_metrics()
    yield
    reset_in_memory()
    reset_metrics()


# ─────────────────────────────────────────────────────────────────────────
# Cache semantics
# ─────────────────────────────────────────────────────────────────────────

def test_in_memory_hit_skips_db():
    """In-memory cache hit returns immediately, no DB call needed."""
    profile = _build_profile("AAPL")
    # Use the test helper to seed in-memory directly via set_cached(),
    # but mock the DB layer so we can verify it was/wasn't called.
    with patch.object(filings_cache, "_get_admin_client") as mock_client:
        mock_client.return_value = None    # DB unavailable — proves we don't need it
        filings_cache._memory_put("AAPL", profile)

        result = get_cached("AAPL")
    assert result is not None
    assert result.ticker == "AAPL"

    # Hit was recorded
    metrics = get_metrics_snapshot()
    assert metrics["hits"] == 1
    assert metrics["misses"] == 0


def test_db_hit_promotes_to_in_memory():
    """DB row exists → fetch + populate in-memory + return."""
    profile = _build_profile("MSFT", last_updated=datetime.now(timezone.utc))

    db_row = {
        "ticker": "MSFT",
        "company_name": "MSFT Test Co",
        "sector": "Technology",
        "industry": None,
        "geographic_exposure": {"us": 0.5, "china": 0.5},
        "supply_chain_exposure": {"semiconductors": 0.7},
        "financial_sensitivity": {"interest_rates": 0.3},
        "main_risks": [{"key": "x", "label": "X", "severity": "high",
                        "channels": ["revenue"], "explanation": ""}],
        "main_opportunities": [],
        "confidence": 0.85,
        "source": "filings",
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }

    fake_client = MagicMock()
    fake_client.select.return_value = [db_row]

    with patch.object(filings_cache, "_get_admin_client", return_value=fake_client):
        # First call → miss in-memory, hit DB
        result = get_cached("MSFT")
        assert result is not None
        assert result.ticker == "MSFT"

        # Second call → in-memory hit (DB not queried again)
        fake_client.select.reset_mock()
        result2 = get_cached("MSFT")
        assert result2 is not None
        fake_client.select.assert_not_called()

    metrics = get_metrics_snapshot()
    assert metrics["hits"] == 2     # 1 promoted from DB, 1 in-memory


def test_stale_db_row_is_miss():
    """A row older than CACHE_TTL_DAYS treats as a cache miss."""
    too_old = datetime.now(timezone.utc) - timedelta(seconds=CACHE_TTL_SEC + 60)
    db_row = {
        "ticker": "NVDA",
        "company_name": "NVDA Test",
        "sector": "Semiconductors",
        "industry": None,
        "geographic_exposure": {},
        "supply_chain_exposure": {},
        "financial_sensitivity": {},
        "main_risks": [],
        "main_opportunities": [],
        "confidence": 0.85,
        "source": "filings",
        "last_updated": too_old.isoformat(),
    }
    fake_client = MagicMock()
    fake_client.select.return_value = [db_row]
    with patch.object(filings_cache, "_get_admin_client", return_value=fake_client):
        result = get_cached("NVDA")
    assert result is None
    metrics = get_metrics_snapshot()
    assert metrics["misses"] == 1


def test_set_cached_refuses_non_filings_source():
    """The cache writer ONLY accepts source=filings."""
    profile = _build_profile("X", source="manual")
    fake_client = MagicMock()
    with patch.object(filings_cache, "_get_admin_client", return_value=fake_client):
        ok = set_cached(profile)
    assert ok is False
    fake_client.upsert.assert_not_called()


def test_set_cached_writes_through_to_db_and_memory():
    """Successful DB write → in-memory cache populated."""
    profile = _build_profile("TSLA")
    fake_client = MagicMock()
    fake_client.upsert.return_value = None
    with patch.object(filings_cache, "_get_admin_client", return_value=fake_client):
        ok = set_cached(profile)
    assert ok is True
    fake_client.upsert.assert_called_once()
    # In-memory now has it — get_cached short-circuits before hitting DB
    fake_client.upsert.reset_mock()
    fake_client.select.reset_mock()
    with patch.object(filings_cache, "_get_admin_client", return_value=fake_client):
        result = get_cached("TSLA")
    assert result is not None
    fake_client.select.assert_not_called()


def test_set_cached_fails_silently_when_db_unavailable():
    """No DB client → set_cached returns False, in-memory NOT populated."""
    profile = _build_profile("X")
    with patch.object(filings_cache, "_get_admin_client", return_value=None):
        ok = set_cached(profile)
    assert ok is False
    # In-memory MUST stay empty — never serve a hit for an entry we
    # didn't persist (split-brain protection).
    assert get_cached("X") is None


def test_invalidate_clears_both_layers_and_records_metric():
    """Invalidation hits in-memory + DB + bumps the eviction counter.

    We mock `_db_invalidate` directly rather than the entire
    `load_config` → httpx.delete chain — the DB-side delete is tested
    by Supabase itself, what we care about HERE is that invalidate()
    drops both layers and bumps the metric counter."""
    profile = _build_profile("AAPL")
    # Seed in-memory only (avoid the set_cached() write path's DB call)
    filings_cache._memory_put("AAPL", profile)

    with patch.object(filings_cache, "_db_invalidate", return_value=True):
        removed = invalidate("AAPL")
    assert removed is True
    metrics = get_metrics_snapshot()
    assert metrics["invalidations"] == 1
    assert metrics["last_invalidation_at"] is not None
    # In-memory is gone too
    assert filings_cache._memory_get("AAPL") is None


# ─────────────────────────────────────────────────────────────────────────
# Observability metrics
# ─────────────────────────────────────────────────────────────────────────

def test_metrics_hit_rate_arithmetic():
    """cache_hit_rate = hits / (hits + misses); None when total is 0."""
    snap = get_metrics_snapshot()
    assert snap["cache_hit_rate"] is None

    record_hit()
    record_hit()
    record_hit()
    record_miss()
    snap = get_metrics_snapshot()
    assert snap["hits"] == 3
    assert snap["misses"] == 1
    assert snap["cache_hit_rate"] == 0.75


def test_metrics_evictions_24h_window():
    """Only invalidations within the last 24h count toward evictions_24h."""
    # Manually inject an old timestamp + a recent one
    import time
    filings_cache._METRICS.eviction_timestamps.append(time.time() - 48 * 60 * 60)  # 48h ago
    filings_cache._METRICS.eviction_timestamps.append(time.time() - 60)             # 1 min ago
    snap = get_metrics_snapshot()
    assert snap["evictions_last_24h"] == 1


def test_metrics_labeled_container_local():
    """Operators reading /health must see this is per-container, not cluster-wide."""
    snap = get_metrics_snapshot()
    assert snap["metrics_scope"] == "container-local"


# ─────────────────────────────────────────────────────────────────────────
# EDGAR refresh loop
# ─────────────────────────────────────────────────────────────────────────

def test_normalize_company_name_strips_suffixes():
    """Different corporate suffixes converge to the same key."""
    assert _normalize_company_name("Apple Inc.") == "apple"
    assert _normalize_company_name("Apple, Inc.") == "apple"
    assert _normalize_company_name("APPLE CORPORATION") == "apple"
    assert _normalize_company_name("NVIDIA Corp") == "nvidia"
    assert _normalize_company_name("JPMorgan Chase & Co.") == "jpmorgan chase &"  # tolerable


def test_extract_ticker_from_explicit_parens():
    """Title with (TICKER) (Filer) format."""
    title = "10-K - Some Random Company (NVDA) (Filer)"
    assert _extract_ticker(title, {}) == "NVDA"


def test_extract_ticker_from_name_lookup():
    """Title without explicit ticker → name fuzzy match."""
    title = "10-K - Apple Inc. (0000320193) (Filer)"
    # Ticker isn't in the title (only CIK), so we fall back to name lookup
    # The name "Apple" normalizes; the lookup map must have "apple" → "AAPL"
    name_map = {"apple": "AAPL"}
    assert _extract_ticker(title, name_map) == "AAPL"


def test_extract_accession_from_link():
    """Pull the 18-digit accession out of an EDGAR URL."""
    url = (
        "https://www.sec.gov/cgi-bin/browse-edgar?"
        "action=getcompany&CIK=0000320193&type=10-K"
    )
    # No accession in this URL → None
    assert _extract_accession_from_link(url) is None

    url2 = (
        "https://www.sec.gov/Archives/edgar/data/320193/"
        "000032019323000106/0000320193-23-000106-index.htm"
    )
    assert _extract_accession_from_link(url2) == "0000320193-23-000106"


def test_parse_atom_extracts_entries():
    """Real-ish Atom feed → list of filing dicts."""
    atom = b"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>EDGAR recent 10-K filings</title>
  <entry>
    <title>10-K - Apple Inc. (AAPL) (Filer)</title>
    <link href="https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/0000320193-23-000106-index.htm" />
    <updated>2026-05-27T10:00:00Z</updated>
  </entry>
  <entry>
    <title>10-K - Nvidia Corporation (NVDA) (Filer)</title>
    <link href="https://www.sec.gov/Archives/edgar/data/1045810/000104581023000123/0001045810-23-000123-index.htm" />
    <updated>2026-05-27T11:00:00Z</updated>
  </entry>
</feed>"""
    entries = _parse_atom(atom)
    assert len(entries) == 2
    tickers = [e["ticker"] for e in entries]
    assert "AAPL" in tickers
    assert "NVDA" in tickers
    # Accession + updated_at populated
    assert entries[0]["accession"] is not None
    assert entries[0]["updated_at"] is not None


def test_run_refresh_only_invalidates_universe_tickers():
    """Filings for tickers OUTSIDE the 200-universe don't trigger invalidation
    (because they wouldn't be in cache anyway)."""
    # Feed mentions AAPL (in universe) + ABCDE (not in universe)
    atom = b"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>10-K - Apple Inc. (AAPL) (Filer)</title>
    <link href="https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/0000320193-23-000106-index.htm" />
    <updated>2026-05-27T10:00:00Z</updated>
  </entry>
  <entry>
    <title>10-K - Some Obscure Co (ABCDE) (Filer)</title>
    <link href="https://www.sec.gov/Archives/edgar/data/9999/000000999923000001/0000009999-23-000001-index.htm" />
    <updated>2026-05-27T11:00:00Z</updated>
  </entry>
</feed>"""
    # Seed AAPL in cache so invalidate() returns True
    profile = _build_profile("AAPL")
    filings_cache._memory_put("AAPL", profile)

    with patch("urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = atom
        # Mock the DB invalidate path too — we don't need it to succeed here
        with patch.object(filings_cache, "_db_invalidate", return_value=False):
            result = run_refresh()

    assert result.fetched_filing_count == 2
    assert result.universe_matches == 1    # AAPL only
    assert result.skipped_not_in_universe == 1
    assert "AAPL" in result.invalidated
    assert "ABCDE" not in result.invalidated


def test_run_refresh_no_cache_hit_no_invalidation():
    """Filing for a universe ticker that ISN'T cached → universe_matches=1
    but invalidated=[] because there was nothing to evict."""
    atom = b"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>10-K - Apple Inc. (AAPL) (Filer)</title>
    <link href="https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/0000320193-23-000106-index.htm" />
    <updated>2026-05-27T10:00:00Z</updated>
  </entry>
</feed>"""
    # No seed — cache is empty
    with patch("urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = atom
        with patch.object(filings_cache, "_db_invalidate", return_value=False):
            result = run_refresh()
    assert result.universe_matches == 1
    assert result.invalidated == []      # nothing to evict


def test_run_refresh_handles_feed_fetch_failure():
    """Network failure → returns RefreshResult with error set, never raises."""
    with patch("urllib.request.urlopen", side_effect=OSError("network down")):
        result = run_refresh()
    assert result.error is not None
    assert "network down" in result.error or "OSError" in result.error
    assert result.fetched_filing_count == 0
    assert result.invalidated == []


# ─────────────────────────────────────────────────────────────────────────
# Pre-activation synthetic harness — Lock #12 (wrong-on-purpose)
# ─────────────────────────────────────────────────────────────────────────
#
# These 5 cases together exercise the LAYERED-READ SEMANTICS of the cache:
# that in-memory is read first within its TTL, that DB is consulted on
# in-memory miss, that invalidate() drops both layers, and that
# empty-result handling matches the architectural promise.
#
# Wrong-on-purpose principle: use a ticker that doesn't exist in the
# universe ("__FAKE__"). The test can't accidentally pass via real-data
# side channels (CIK map lookup, sector library default), so a failure
# here is unambiguously a layering bug, not an environment artifact.


def test_synthetic_in_memory_serves_within_ttl_even_if_db_changes():
    """Step 1-3 of the pre-activation harness.

    set_cached(v1) populates BOTH layers. Then we simulate an external
    DB mutation (someone else writes v2 — multi-process or a manual
    SQL edit) by changing what the mocked select() returns. Within the
    in-memory TTL window, get_cached() MUST return v1, not v2. If it
    returns v2, the in-memory layer is being bypassed — which would
    mean hitting the DB on every read, defeating the cache.
    """
    profile_v1 = _build_profile("__FAKE__", last_updated=datetime.now(timezone.utc))
    profile_v1_marker = profile_v1.geographic_exposure   # capture v1 fingerprint

    # Mutate the v1 fingerprint so we can tell v1 and v2 apart later
    profile_v1 = CompanyExposureProfile(
        ticker=profile_v1.ticker, company_name=profile_v1.company_name,
        sector=profile_v1.sector, industry=profile_v1.industry,
        geographic_exposure={"v1_marker": 1.0},
        supply_chain_exposure=profile_v1.supply_chain_exposure,
        financial_sensitivity=profile_v1.financial_sensitivity,
        main_risks=profile_v1.main_risks,
        main_opportunities=profile_v1.main_opportunities,
        confidence=profile_v1.confidence,
        source=profile_v1.source,
        last_updated=profile_v1.last_updated,
    )

    db_state = {"value": profile_v1}    # mutable container the mock reads from

    def fake_select(table, filters=None, columns="*"):
        p = db_state["value"]
        return [{
            "ticker": p.ticker, "company_name": p.company_name,
            "sector": p.sector, "industry": p.industry,
            "geographic_exposure": p.geographic_exposure,
            "supply_chain_exposure": p.supply_chain_exposure,
            "financial_sensitivity": p.financial_sensitivity,
            "main_risks": [], "main_opportunities": [],
            "confidence": p.confidence, "source": "filings",
            "last_updated": p.last_updated.isoformat(),
        }]

    fake_client = MagicMock()
    fake_client.select.side_effect = fake_select
    fake_client.upsert.return_value = None

    with patch.object(filings_cache, "_get_admin_client", return_value=fake_client):
        # 1. Seed both layers
        assert set_cached(profile_v1) is True

        # 2. Simulate external DB mutation — someone writes v2 directly
        profile_v2 = CompanyExposureProfile(
            ticker=profile_v1.ticker, company_name=profile_v1.company_name,
            sector=profile_v1.sector, industry=profile_v1.industry,
            geographic_exposure={"v2_marker": 1.0},     # ← changed
            supply_chain_exposure={}, financial_sensitivity={},
            main_risks=[], main_opportunities=[],
            confidence=0.85, source="filings",
            last_updated=datetime.now(timezone.utc),
        )
        db_state["value"] = profile_v2

        # 3. get_cached within in-memory TTL — MUST return v1, not v2
        result = get_cached("__FAKE__")
    assert result is not None
    assert "v1_marker" in result.geographic_exposure, (
        "In-memory layer was bypassed — got v2 from DB despite recent "
        "set_cached(v1). Cache layering is broken."
    )


def test_synthetic_invalidate_then_get_pulls_fresh_from_db():
    """Step 4 of the pre-activation harness.

    After invalidate(), the next get_cached MUST hit the DB (because
    in-memory was wiped) and return whatever's currently there. This
    proves the freshness loop's invalidation actually surfaces newer DB
    state — which is the entire point of the EDGAR RSS refresh path.
    """
    profile_v1 = CompanyExposureProfile(
        ticker="__FAKE__", company_name="Fake Co", sector="Technology",
        industry=None,
        geographic_exposure={"v1_marker": 1.0},
        supply_chain_exposure={}, financial_sensitivity={},
        main_risks=[], main_opportunities=[],
        confidence=0.85, source="filings",
        last_updated=datetime.now(timezone.utc),
    )
    profile_v2 = CompanyExposureProfile(
        ticker="__FAKE__", company_name="Fake Co", sector="Technology",
        industry=None,
        geographic_exposure={"v2_marker": 1.0},
        supply_chain_exposure={}, financial_sensitivity={},
        main_risks=[], main_opportunities=[],
        confidence=0.85, source="filings",
        last_updated=datetime.now(timezone.utc),
    )

    db_state = {"value": profile_v1}

    def fake_select(table, filters=None, columns="*"):
        p = db_state["value"]
        return [{
            "ticker": p.ticker, "company_name": p.company_name,
            "sector": p.sector, "industry": p.industry,
            "geographic_exposure": p.geographic_exposure,
            "supply_chain_exposure": p.supply_chain_exposure,
            "financial_sensitivity": p.financial_sensitivity,
            "main_risks": [], "main_opportunities": [],
            "confidence": p.confidence, "source": "filings",
            "last_updated": p.last_updated.isoformat(),
        }]

    fake_client = MagicMock()
    fake_client.select.side_effect = fake_select
    fake_client.upsert.return_value = None

    with patch.object(filings_cache, "_get_admin_client", return_value=fake_client), \
         patch.object(filings_cache, "_db_invalidate", return_value=True):
        # Seed v1 in both layers
        set_cached(profile_v1)
        # External mutation to v2 (the "new 10-K was filed" scenario)
        db_state["value"] = profile_v2
        # Invalidate (what filings_refresh.run_refresh() would do)
        invalidate("__FAKE__")
        # Next get_cached should return v2 from DB
        result = get_cached("__FAKE__")

    assert result is not None
    assert "v2_marker" in result.geographic_exposure, (
        "Post-invalidation read returned stale data. Either invalidate() "
        "didn't actually drop the in-memory layer, or get_cached fell "
        "back to a different stale source."
    )


def test_synthetic_empty_result_caching_gap_documented():
    """Step 5 of the pre-activation harness — exposes a real gap.

    When `filings_extractor.try_filings_derived_profile()` returns None
    (no 10-K found, EDGAR failure, malformed Claude output, etc.), we
    DO NOT cache that fact. Every subsequent request re-attempts the
    full EDGAR + Claude chain.

    For tickers in the universe that genuinely have no extractable
    10-K (foreign ADRs filing 20-F, recently-IPO'd companies, etc.),
    this means we hit EDGAR every time the user opens the drawer.

    This test ASSERTS the gap exists today — when Phase D.5 adds
    negative-result caching, this test should be inverted to assert
    the gap is closed. Leave the test in place either way as a
    regression sentinel.
    """
    # Reset everything so the test is hermetic
    reset_in_memory()
    reset_metrics()

    fake_client = MagicMock()
    fake_client.select.return_value = []      # no DB row for __FAKE__

    with patch.object(filings_cache, "_get_admin_client", return_value=fake_client):
        # First lookup — miss
        assert get_cached("__FAKE__") is None
        # Second lookup — also miss (negative result not cached)
        assert get_cached("__FAKE__") is None

    metrics = get_metrics_snapshot()
    # The gap: BOTH lookups hit the DB. If we had negative-result caching,
    # the second would be served from in-memory and miss count would be 1.
    assert metrics["misses"] == 2, (
        "If misses != 2 here, negative-result caching has been "
        "implemented — invert this assertion (expect misses == 1) and "
        "move this test to a 'phase D.5 shipped' suite."
    )
    # Document the cost amplifier honestly
    # In production: each miss triggers EDGAR + Claude call chain from
    # the filings_extractor. For tickers with no extractable 10-K, that's
    # one full LLM round-trip per drawer-open. See Phase D.5 in
    # docs/ADR-public-intelligence-locks.md (not yet authored — this is
    # the deferred work).


def test_refresh_result_serialization():
    """to_dict() produces a JSON-friendly payload for the API response."""
    result = RefreshResult(
        fetched_filing_count=10,
        universe_matches=3,
        invalidated=["AAPL", "MSFT", "NVDA"],
        skipped_not_in_universe=7,
        last_polled_at=datetime(2026, 5, 27, 10, 0, tzinfo=timezone.utc),
    )
    d = result.to_dict()
    assert d["fetched_filing_count"] == 10
    assert d["invalidated_count"] == 3
    assert d["last_polled_at"] == "2026-05-27T10:00:00+00:00"
    # JSON-serializable
    json.dumps(d)
