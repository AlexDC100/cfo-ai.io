"""Unit tests for engine.public.adapter — fully mocked, no live API.

Run with: pytest tests/engine/public/test_adapter.py -v

Coverage:
  · Constructor env-var lookup (with + without NASDAQ_API_KEY)
  · key_tag never leaks the full key
  · Daily budget guard raises NasdaqRateLimited locally
  · search() parses SHARADAR/TICKERS payload → TickerHit list
  · get_fundamentals() parses SHARADAR/SF1 payload → Fundamentals list
  · get_daily_metrics() parses SHARADAR/DAILY → DailyMetrics
  · HTTP status codes map to typed exceptions per §24
  · API key is stripped from error context
"""

from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from engine.public.adapter import (
    NASDAQ_API_BASE,
    DailyMetrics,
    Fundamentals,
    NasdaqAdapter,
    TickerHit,
)
from engine.public.errors import (
    NasdaqEntitlementError,
    NasdaqError,
    NasdaqKeyMissing,
    NasdaqNotFound,
    NasdaqRateLimited,
)


FIXTURES = Path(__file__).parent / "fixtures"


def _load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def _make_response(status: int, body: dict | None = None, *, retry_after: str | None = None) -> MagicMock:
    """Mock httpx.Response."""
    r = MagicMock()
    r.status_code = status
    r.json.return_value = body or {}
    r.headers = {"Retry-After": retry_after} if retry_after else {}
    r.request.url = f"{NASDAQ_API_BASE}/datatables/SHARADAR/SF1.json?ticker=AAPL&api_key=FAKE_KEY_DO_NOT_USE"
    return r


def _patch_http_client(response: MagicMock):
    """Returns a context manager that patches httpx.Client to return `response`."""
    mock_client = MagicMock()
    mock_client.__enter__ = MagicMock(return_value=mock_client)
    mock_client.__exit__ = MagicMock(return_value=False)
    mock_client.get.return_value = response
    return patch("engine.public.adapter.httpx.Client", return_value=mock_client)


# ── Constructor / availability ──────────────────────────────────────────


def test_constructor_reads_env_var(monkeypatch):
    monkeypatch.setenv("NASDAQ_API_KEY", "test_key_from_env_yu5q")
    a = NasdaqAdapter()
    assert a.available is True
    assert a.key_tag == "key=test…"


def test_constructor_no_env_var(monkeypatch):
    monkeypatch.delenv("NASDAQ_API_KEY", raising=False)
    a = NasdaqAdapter()
    assert a.available is False
    assert a.key_tag == "key=unset"


def test_constructor_explicit_key_overrides_env(monkeypatch):
    monkeypatch.setenv("NASDAQ_API_KEY", "from_env")
    a = NasdaqAdapter(api_key="explicit_test_key")
    assert a.available is True
    assert a.key_tag == "key=expl…"


# ── Key safety ───────────────────────────────────────────────────────────


def test_key_tag_only_shows_first_four_chars():
    a = NasdaqAdapter(api_key="abcdefghijklmnop_super_secret")
    assert a.key_tag == "key=abcd…"
    assert "efghijkl" not in a.key_tag
    assert "super_secret" not in a.key_tag


def test_no_key_raises_on_search():
    a = NasdaqAdapter(api_key=None)
    with pytest.raises(NasdaqKeyMissing) as exc:
        a.search("AAPL")
    assert exc.value.code == "nasdaq_key_missing"
    assert exc.value.http_status == 503


def test_no_key_raises_on_fundamentals():
    a = NasdaqAdapter(api_key=None)
    with pytest.raises(NasdaqKeyMissing):
        a.get_fundamentals("AAPL")


def test_no_key_raises_on_daily():
    a = NasdaqAdapter(api_key=None)
    with pytest.raises(NasdaqKeyMissing):
        a.get_daily_metrics("AAPL")


# ── Daily budget guard ──────────────────────────────────────────────────


def test_daily_budget_guard_raises_locally():
    # cap=4 because search() with empty response retries once (primary + retry-on-empty),
    # so each empty-result search burns 2 budget slots. Two such searches = 4 calls.
    a = NasdaqAdapter(api_key="test_key", daily_budget_cap=4)
    response = _make_response(200, {"datatable": {"columns": [], "data": []}})
    with _patch_http_client(response):
        a.search("AAPL")   # 2 calls
        a.search("MSFT")   # 2 calls → at cap
    # Third search should raise before hitting the wire
    with pytest.raises(NasdaqRateLimited) as exc:
        with _patch_http_client(response):
            a.search("GOOG")
    assert exc.value.code == "nasdaq_rate_limited"
    assert exc.value.details["daily_cap"] == 4


# ── Empty input handling ─────────────────────────────────────────────────


def test_search_empty_string_returns_empty_list():
    a = NasdaqAdapter(api_key="test_key")
    assert a.search("") == []
    assert a.search("   ") == []


def test_get_fundamentals_empty_ticker_returns_empty_list():
    a = NasdaqAdapter(api_key="test_key")
    assert a.get_fundamentals("") == []


# ── HTTP status code → typed exception mapping ──────────────────────────


def test_401_raises_nasdaq_key_missing():
    a = NasdaqAdapter(api_key="invalid_key")
    response = _make_response(401)
    with _patch_http_client(response):
        with pytest.raises(NasdaqKeyMissing) as exc:
            a.search("AAPL")
    assert exc.value.code == "nasdaq_key_missing"
    # API key must NOT appear in error details URL
    assert "FAKE_KEY_DO_NOT_USE" not in exc.value.details.get("url", "")
    assert "api_key" not in exc.value.details.get("url", "")


def test_403_raises_entitlement_error():
    a = NasdaqAdapter(api_key="test_key")
    response = _make_response(403)
    with _patch_http_client(response):
        with pytest.raises(NasdaqEntitlementError) as exc:
            a.get_fundamentals("AAPL")
    assert exc.value.code == "nasdaq_entitlement_missing"
    assert exc.value.http_status == 402


def test_404_raises_not_found():
    a = NasdaqAdapter(api_key="test_key")
    response = _make_response(404)
    with _patch_http_client(response):
        with pytest.raises(NasdaqNotFound) as exc:
            a.get_fundamentals("FAKETICKER")
    assert exc.value.code == "nasdaq_not_found"


def test_429_raises_rate_limited_with_retry_after():
    a = NasdaqAdapter(api_key="test_key")
    response = _make_response(429, retry_after="120")
    with _patch_http_client(response):
        with pytest.raises(NasdaqRateLimited) as exc:
            a.get_fundamentals("AAPL")
    assert exc.value.code == "nasdaq_rate_limited"
    assert exc.value.retry_after_seconds == 120


def test_5xx_raises_generic_error():
    a = NasdaqAdapter(api_key="test_key")
    response = _make_response(502)
    with _patch_http_client(response):
        with pytest.raises(NasdaqError) as exc:
            a.get_fundamentals("AAPL")
    assert exc.value.code == "nasdaq_error"


# ── Response parsing ────────────────────────────────────────────────────


def test_get_fundamentals_parses_aapl_fy2024():
    a = NasdaqAdapter(api_key="test_key")
    response = _make_response(200, _load_fixture("aapl_fy2024_sf1.json"))
    with _patch_http_client(response):
        rows = a.get_fundamentals("AAPL", dimension="ARY")
    assert len(rows) == 1
    f = rows[0]
    assert isinstance(f, Fundamentals)
    assert f.ticker == "AAPL"
    assert f.dimension == "ARY"
    assert f.fiscal_period_end == date(2024, 9, 30)
    # Spot-check the key headline numbers parsed correctly
    assert f.revenue == 391_035_000_000
    assert f.cogs == 210_352_000_000
    assert f.ebitda == 134_661_000_000
    assert f.ebit == 123_216_000_000
    assert f.net_income == 93_736_000_000
    assert f.total_assets == 364_980_000_000
    assert f.total_equity == 56_950_000_000
    assert f.total_debt == 106_629_000_000
    assert f.cash == 65_171_000_000
    assert f.operating_cash_flow == 118_254_000_000
    assert f.currency == "USD"


def test_get_daily_metrics_parses_aapl():
    a = NasdaqAdapter(api_key="test_key")
    response = _make_response(200, _load_fixture("aapl_daily.json"))
    with _patch_http_client(response):
        d = a.get_daily_metrics("AAPL")
    assert isinstance(d, DailyMetrics)
    assert d.ticker == "AAPL"
    assert d.as_of == date(2024, 12, 31)
    assert d.market_cap == 3_780_000_000_000
    assert d.enterprise_value == 3_820_000_000_000
    assert d.ev_ebitda == 28.4
    assert d.pe_ratio == 40.5


def test_search_parses_ticker_hit():
    a = NasdaqAdapter(api_key="test_key")
    body = {
        "datatable": {
            "columns": [
                {"name": "ticker"}, {"name": "name"}, {"name": "exchange"},
                {"name": "sector"}, {"name": "industry"}, {"name": "currency"},
                {"name": "isdelisted"}, {"name": "location"},
            ],
            "data": [["AAPL", "Apple Inc", "NASDAQ", "Technology",
                      "Consumer Electronics", "USD", "N", "United States"]],
        },
    }
    response = _make_response(200, body)
    with _patch_http_client(response):
        hits = a.search("AAPL")
    assert len(hits) == 1
    h = hits[0]
    assert isinstance(h, TickerHit)
    assert h.ticker == "AAPL"
    assert h.name == "Apple Inc"
    assert h.exchange == "NASDAQ"
    assert h.sector == "Technology"
    assert h.currency == "USD"
    assert h.is_active is True
    assert h.country == "United States"


def test_get_fundamentals_empty_response_returns_empty_list():
    a = NasdaqAdapter(api_key="test_key")
    response = _make_response(200, {"datatable": {"columns": [], "data": []}})
    with _patch_http_client(response):
        rows = a.get_fundamentals("UNKNOWNTICKER")
    assert rows == []


# ── Adapter normalizer round-trip ────────────────────────────────────────


def test_normalizer_emits_envelope_shape_from_aapl_fixture():
    """The full pipeline: SF1 payload → Fundamentals → assembled_canonical_v1."""
    from engine.public.normalizer import normalize

    a = NasdaqAdapter(api_key="test_key")
    response = _make_response(200, _load_fixture("aapl_fy2024_sf1.json"))
    with _patch_http_client(response):
        rows = a.get_fundamentals("AAPL", dimension="ARY")
    daily_response = _make_response(200, _load_fixture("aapl_daily.json"))
    with _patch_http_client(daily_response):
        daily = a.get_daily_metrics("AAPL")

    env = normalize(rows[0], daily)
    # Envelope contract
    assert env["schema_version"].startswith("canonical_v1")
    assert env["source"] == "nasdaq_sharadar_sf1"
    assert env["ticker"] == "AAPL"
    assert env["dimension"] == "ARY"
    assert env["fiscal_period_end"] == "2024-09-30"
    assert env["currency"] == "USD"
    # Headline is always populated even when leaves are sparse
    assert env["headline"]["revenue"] == 391_035_000_000
    assert env["headline"]["ebitda"] == 134_661_000_000
    assert env["headline"]["net_income"] == 93_736_000_000
    # Market metrics included since DailyMetrics was passed
    assert env["market_metrics"] is not None
    assert env["market_metrics"]["market_cap"] == 3_780_000_000_000
    # Round-trip check passes — AAPL BS balances within tolerance
    rt = env["round_trip_check"]
    assert rt["passed"] is True
    assert rt["max_deviation_pct"] < 0.5
