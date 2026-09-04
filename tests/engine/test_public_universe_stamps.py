# -*- coding: utf-8 -*-
"""UNIVERSE TIMESTAMPS ARE DATA TIMESTAMPS, NEVER THE PROCESS CLOCK.

The defect this file pins (critic finding #3, commit ea6df1f):
``bvb_seed._row``, ``demo_universe._row`` and ``universe_service`` each
stamped ``lastUpdated`` with ``datetime.now()`` at universe build. The FE
renders that field as "computed <ts>" on every company card, so 72
cards read "computed <engine boot>" for figures that were months old —
and the stamp moved on every container restart.

What is true, and what is asserted:

  · a BET-20 SEED row is as of the day the seed was taken (a constant the
    module declares), a LISTING row as of the day the listing was taken,
    and building one now yields the same stamp as building one tomorrow;
  · a DEMO row is as of the date the demo table declares for itself;
  · a BVB row that received a live quote dates its PRICE by the sweep
    that produced it (``quoteAsOf``) and its seeded figures by the seed —
    a quote does not make a seeded market cap fresher;
  · a failed sweep stamps nothing, and last-known quotes kept through a
    failure stay dated by the sweep that produced them;
  · a LIVE row is as of the DAILY trading day, and carries no stamp at
    all when DAILY is absent (the adapter keeps no fetch stamp for SF1);
  · the payload-level stamp is the newest ROW stamp, not a build time.

No network: the Yahoo sweep is replaced at the provider seam, and
``time.time`` is pinned where a sweep time is asserted.
"""

from __future__ import annotations

import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[2] / "src"
if (_SRC / "engine").exists() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from engine.public import bvb_seed, demo_universe, universe_service  # noqa: E402
from engine.public.providers import yahoo_bvb  # noqa: E402

DATE_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
#: A clock reading carries a time-of-day. A data date does not.
CLOCK_SHAPE = re.compile(r"T\d{2}:\d{2}")


@pytest.fixture(autouse=True)
def _fresh_quote_cache():
    saved = dict(universe_service._bvb_quotes_cache)
    universe_service._bvb_quotes_cache.update({"at": 0.0, "quoted_at": None, "quotes": {}})
    yield
    universe_service._bvb_quotes_cache.clear()
    universe_service._bvb_quotes_cache.update(saved)


def _no_quotes(monkeypatch):
    monkeypatch.setattr(yahoo_bvb, "fetch_bvb_spark_quotes", lambda tickers, timeout=12.0: {})


# ── seed ────────────────────────────────────────────────────────────


def test_every_seed_row_is_stamped_with_its_table_date_not_the_clock():
    seed = bvb_seed._BVB_TABLE
    listing = bvb_seed._BVB_REGS_TABLE
    checked = 0
    for ticker, r in seed.items():
        assert r["lastUpdated"] == bvb_seed._SEED_RETRIEVED_AT, ticker
        assert not CLOCK_SHAPE.search(r["lastUpdated"]), ticker
        checked += 1
    for ticker, r in listing.items():
        assert r["lastUpdated"] == bvb_seed._LISTING_RETRIEVED_AT, ticker
        assert not CLOCK_SHAPE.search(r["lastUpdated"]), ticker
        checked += 1
    # Floor AFTER the loop (TC-3): an empty universe is not a clean one.
    assert checked >= 80
    for stamp in (bvb_seed._SEED_RETRIEVED_AT, bvb_seed._LISTING_RETRIEVED_AT):
        assert DATE_ONLY.match(stamp)
        assert date.fromisoformat(stamp) < date.today()


def test_a_seed_row_built_now_carries_the_seed_date():
    a = bvb_seed._row(ticker="ZZZ", name="Test S.A.", sector="Industrials")
    b = bvb_seed._row(ticker="ZZZ", name="Test S.A.", sector="Industrials")
    assert a["lastUpdated"] == b["lastUpdated"] == bvb_seed._SEED_RETRIEVED_AT
    assert not hasattr(bvb_seed, "datetime"), "the seed module consults no clock"


# ── demo ────────────────────────────────────────────────────────────


def test_demo_rows_are_stamped_with_the_declared_as_of():
    r = demo_universe.demo_snapshot_for("AAPL", "Apple Inc.", "Technology")
    assert r["lastUpdated"] == demo_universe._LAST_UPDATED
    assert DATE_ONLY.match(r["lastUpdated"])
    assert not hasattr(demo_universe, "datetime"), "the demo module consults no clock"


def test_demo_payload_stamp_is_the_newest_row_stamp_and_does_not_move(monkeypatch):
    _no_quotes(monkeypatch)
    a = universe_service._build_demo_payload(reason="no_key")
    b = universe_service._build_demo_payload(reason="no_key")
    assert a["lastUpdated"] == b["lastUpdated"]
    assert a["lastUpdated"] == max(r["lastUpdated"] for r in a["companies"])
    assert DATE_ONLY.match(a["lastUpdated"])
    assert len(a["companies"]) >= 100


# ── BVB quotes ──────────────────────────────────────────────────────


def test_a_quoted_bvb_row_dates_its_price_by_the_sweep_and_its_seed_by_the_seed(monkeypatch):
    fixed = 1_800_000_000.0
    monkeypatch.setattr(universe_service.time, "time", lambda: fixed)
    monkeypatch.setattr(
        yahoo_bvb, "fetch_bvb_spark_quotes",
        lambda tickers, timeout=12.0: {"TLV": {"price": 30.5, "priceChangePct": 1.2}},
    )
    rows = {r["ticker"]: r for r in universe_service._bvb_seed_rows()}
    tlv = rows["TLV"]
    assert tlv["price"] == 30.5
    assert tlv["quoteAsOf"] == datetime.fromtimestamp(fixed, tz=timezone.utc).isoformat(timespec="seconds")
    # The quote did NOT make the seeded market cap fresher.
    assert tlv["lastUpdated"] == bvb_seed._SEED_RETRIEVED_AT
    unquoted = rows["BRD"]
    assert unquoted["price"] is None
    assert unquoted.get("quoteAsOf") is None


def test_a_failed_sweep_stamps_nothing(monkeypatch):
    def boom(tickers, timeout=12.0):
        raise RuntimeError("yahoo down")

    monkeypatch.setattr(yahoo_bvb, "fetch_bvb_spark_quotes", boom)
    rows = universe_service._bvb_seed_rows()
    assert rows
    assert all(r.get("quoteAsOf") is None for r in rows)
    assert universe_service._bvb_quotes_cache["quoted_at"] is None
    # The TTL clock still moved — an outage is not retried on every request.
    assert universe_service._bvb_quotes_cache["at"] > 0


def test_last_known_quotes_stay_dated_by_the_sweep_that_produced_them(monkeypatch):
    clock = {"now": 1_800_000_000.0}
    monkeypatch.setattr(universe_service.time, "time", lambda: clock["now"])
    monkeypatch.setattr(
        yahoo_bvb, "fetch_bvb_spark_quotes",
        lambda tickers, timeout=12.0: {"TLV": {"price": 30.5}},
    )
    first = {r["ticker"]: r for r in universe_service._bvb_seed_rows()}["TLV"]["quoteAsOf"]
    assert first is not None

    clock["now"] += universe_service._BVB_QUOTES_TTL_S + 1

    def boom(tickers, timeout=12.0):
        raise RuntimeError("yahoo down")

    monkeypatch.setattr(yahoo_bvb, "fetch_bvb_spark_quotes", boom)
    again = {r["ticker"]: r for r in universe_service._bvb_seed_rows()}["TLV"]
    assert again["price"] == 30.5  # last-known kept …
    assert again["quoteAsOf"] == first  # … and NOT re-dated by the failed attempt


# ── live (Sharadar) ─────────────────────────────────────────────────


class _Daily:
    as_of = date(2026, 9, 2)
    market_cap = 1.0e9
    enterprise_value = None
    pe_ratio = None
    ev_ebitda = None
    ev_revenue = None
    dividend_yield = None


class _Fund:
    revenue = 1.0e8
    ebitda = None
    net_income = None
    total_debt = None
    cash = None
    total_equity = None
    operating_cash_flow = None
    free_cash_flow = None
    ebit = None
    shares_outstanding = 1.0e6
    fiscal_period_end = date(2025, 12, 31)


def test_live_row_is_dated_by_the_daily_trading_day():
    row = universe_service._live_row(
        ticker="AAPL", fallback_name="Apple", fallback_sector="Technology",
        fundamentals=_Fund(), daily=_Daily(),
    )
    assert row["price"] == 1000.0
    assert row["lastUpdated"] == "2026-09-02"
    assert row["quoteAsOf"] == "2026-09-02"
    assert row["latestPeriodEnd"] == "2025-12-31"


def test_live_row_without_daily_claims_no_timestamp_at_all():
    row = universe_service._live_row(
        ticker="AAPL", fallback_name="Apple", fallback_sector="Technology",
        fundamentals=_Fund(), daily=None,
    )
    assert row["price"] is None
    assert row["lastUpdated"] is None
    assert row["quoteAsOf"] is None
