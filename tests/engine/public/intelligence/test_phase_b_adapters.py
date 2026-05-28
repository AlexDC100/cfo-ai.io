"""Phase B live-adapter unit tests — RSS, NewsAPI, FRED.

No network. Each test injects a known XML/JSON payload via a mocked
urllib.request.urlopen, then asserts the adapter parses + tags +
classifies correctly. The configured/unconfigured paths are verified
independently.
"""

from __future__ import annotations

import io
import json
import os
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock

import pytest

from engine.public.intelligence.adapters.rss_signal_adapter import (
    RssSignalAdapter,
    _classify_keyword,
    _parse_date_safe,
)
from engine.public.intelligence.adapters.news_signal_adapter import (
    NewsSignalAdapter,
)
from engine.public.intelligence.adapters.rates_signal_adapter import (
    RatesSignalAdapter,
    SERIES_CONFIG,
    _severity_from_delta,
)


# ─────────────────────────────────────────────────────────────────────────
# RSS adapter
# ─────────────────────────────────────────────────────────────────────────

def test_rss_unconfigured_without_env_var():
    saved = os.environ.pop("RSS_FEED_URLS", None)
    try:
        a = RssSignalAdapter()
        assert a.configured is False
        h = a.health()
        assert h.configured is False
        assert "RSS_FEED_URLS" in h.reason
        # Fetch must return empty list, never raise.
        assert a.fetch_recent_signals(datetime.utcnow()) == []
    finally:
        if saved is not None:
            os.environ["RSS_FEED_URLS"] = saved


def test_rss_configured_with_url_list():
    a = RssSignalAdapter(feed_urls=["https://example.com/feed.xml"])
    assert a.configured is True
    assert a.health().configured is True


def test_rss_filters_invalid_urls():
    """Schemes other than http(s) or empty netloc get dropped silently."""
    a = RssSignalAdapter(feed_urls=[
        "https://valid.com/feed.xml",
        "javascript:alert(1)",   # rejected
        "not a url at all",       # rejected
        "ftp://old.com/feed",     # rejected (not http/https)
    ])
    assert a.configured is True   # at least one valid URL


def test_rss_parses_rss20_format():
    """Standard RSS 2.0 payload → 2 signals with ticker tagging."""
    rss = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>NVDA earnings beat expectations</title>
      <description>Nvidia reports record revenue.</description>
      <link>https://example.com/article1</link>
      <pubDate>Wed, 27 May 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Red Sea shipping disruption widens</title>
      <description>Container traffic rerouting via Cape of Good Hope.</description>
      <link>https://example.com/article2</link>
      <pubDate>Wed, 27 May 2026 13:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>"""

    a = RssSignalAdapter(feed_urls=["https://example.com/feed.xml"])
    with patch("urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = rss
        signals = a.fetch_recent_signals(datetime(2026, 5, 1, tzinfo=timezone.utc))

    assert len(signals) == 2
    # Signal 1: NVDA tagged + classified as earnings
    s1 = signals[0]
    assert s1.title == "NVDA earnings beat expectations"
    assert "NVDA" in s1.affected_tickers
    assert s1.signal_type == "earnings"
    # Signal 2: shipping = supply_chain
    s2 = signals[1]
    assert s2.signal_type == "supply_chain"
    assert s2.severity == "high"


def test_rss_parses_atom_format():
    """Atom 1.0 payload → signals via the same path."""
    atom = b"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Test</title>
  <entry>
    <title>Apple antitrust investigation expands</title>
    <summary>Regulatory probe deepens.</summary>
    <link href="https://example.com/a1" rel="alternate"/>
    <published>2026-05-27T10:00:00Z</published>
  </entry>
</feed>"""
    a = RssSignalAdapter(feed_urls=["https://example.com/atom.xml"])
    with patch("urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = atom
        signals = a.fetch_recent_signals(datetime(2026, 5, 1, tzinfo=timezone.utc))
    assert len(signals) == 1
    s = signals[0]
    assert "AAPL" in s.affected_tickers   # "Apple" fuzzy → AAPL
    assert s.signal_type == "regulation"
    assert s.source_url == "https://example.com/a1"


def test_rss_drops_entries_older_than_since():
    """Items published before `since` cutoff are filtered out."""
    rss = b"""<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Old story</title>
    <description>Stuff that happened</description>
    <pubDate>Wed, 01 Jan 2020 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Recent story</title>
    <description>Newer stuff</description>
    <pubDate>Wed, 27 May 2026 12:00:00 GMT</pubDate>
  </item>
</channel></rss>"""
    a = RssSignalAdapter(feed_urls=["https://example.com/feed.xml"])
    with patch("urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = rss
        # since = 2026 → only "Recent story" should pass through
        signals = a.fetch_recent_signals(datetime(2026, 5, 1, tzinfo=timezone.utc))
    titles = [s.title for s in signals]
    assert "Recent story" in titles
    assert "Old story" not in titles


def test_rss_classifier_keyword_routing():
    """The keyword classifier maps known phrases → signal type + severity."""
    cases = [
        ("tariff on Chinese imports", "geopolitical", "high"),
        ("oil price spikes on OPEC cut", "energy", "high"),
        ("red sea shipping disruption", "supply_chain", "high"),
        ("rate hike from the Fed", "interest_rates", "medium"),
        ("antitrust investigation against Google", "regulation", "medium"),
        ("downgrade to BB by S&P", "credit", "high"),
        ("layoffs announced at FAANG", "company_news", "high"),
        ("random unrelated story", "company_news", "medium"),   # default
    ]
    for text, expected_type, expected_severity in cases:
        sig_type, severity, _ = _classify_keyword(text)
        assert sig_type == expected_type, f"For {text!r}: type expected {expected_type}, got {sig_type}"
        assert severity == expected_severity, f"For {text!r}: severity expected {expected_severity}, got {severity}"


def test_parse_date_safe_handles_rfc2822_and_iso():
    assert _parse_date_safe("Wed, 27 May 2026 12:00:00 GMT") is not None
    assert _parse_date_safe("2026-05-27T12:00:00Z") is not None
    assert _parse_date_safe("2026-05-27T12:00:00+00:00") is not None
    assert _parse_date_safe(None) is None
    assert _parse_date_safe("nonsense") is None


# ─────────────────────────────────────────────────────────────────────────
# NewsAPI adapter
# ─────────────────────────────────────────────────────────────────────────

def test_news_unconfigured_without_env_var():
    saved = os.environ.pop("NEWS_API_KEY", None)
    try:
        a = NewsSignalAdapter()
        assert a.configured is False
        assert "NEWS_API_KEY" in a.health().reason
        assert a.fetch_recent_signals(datetime.utcnow()) == []
    finally:
        if saved is not None:
            os.environ["NEWS_API_KEY"] = saved


def test_news_parses_api_payload():
    """NewsAPI articles → IntelligenceSignals with tag + classification."""
    fake_payload = {
        "status": "ok",
        "articles": [
            {
                "source": {"name": "Reuters"},
                "title": "AMD layoffs hit AI chip division",
                "description": "Restructuring after slow datacenter ramp.",
                "content": "Sources say...",
                "url": "https://reuters.com/a1",
                "publishedAt": "2026-05-27T08:00:00Z",
            },
        ],
    }
    a = NewsSignalAdapter(api_key="test_key", sources=["reuters"])
    assert a.configured is True
    with patch("urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = json.dumps(fake_payload).encode()
        signals = a.fetch_recent_signals(datetime(2026, 5, 1, tzinfo=timezone.utc))
    assert len(signals) == 1
    s = signals[0]
    assert "AMD" in s.affected_tickers
    assert s.source == "newsapi:Reuters"
    assert s.source_url == "https://reuters.com/a1"
    assert s.signal_type == "company_news"
    # 'layoff' keyword should classify as high severity
    assert s.severity == "high"


def test_news_skips_removed_articles():
    """NewsAPI marks deleted articles with title=='[Removed]'. Skip them."""
    fake_payload = {
        "status": "ok",
        "articles": [
            {"source": {"name": "X"}, "title": "[Removed]", "url": "https://x.com/1",
             "publishedAt": "2026-05-27T08:00:00Z"},
            {"source": {"name": "Y"}, "title": "Real story",
             "description": "Real content", "url": "https://y.com/1",
             "publishedAt": "2026-05-27T09:00:00Z"},
        ],
    }
    a = NewsSignalAdapter(api_key="k", sources=["x"])
    with patch("urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = json.dumps(fake_payload).encode()
        signals = a.fetch_recent_signals(datetime(2026, 5, 1, tzinfo=timezone.utc))
    titles = [s.title for s in signals]
    assert "Real story" in titles
    assert "[Removed]" not in titles


# ─────────────────────────────────────────────────────────────────────────
# FRED rates adapter
# ─────────────────────────────────────────────────────────────────────────

def test_rates_unconfigured_without_env_var():
    saved = os.environ.pop("FRED_API_KEY", None)
    try:
        a = RatesSignalAdapter()
        assert a.configured is False
        assert "FRED_API_KEY" in a.health().reason
        assert a.fetch_recent_signals(datetime.utcnow()) == []
    finally:
        if saved is not None:
            os.environ["FRED_API_KEY"] = saved


def test_rates_emits_signal_on_material_move():
    """A 50bp move on 10Y > 25bp threshold → emits a signal."""
    fake_payload = {
        "observations": [
            {"date": "2026-05-27", "value": "4.50"},
            {"date": "2026-05-26", "value": "4.00"},   # +50bp move
        ],
    }
    a = RatesSignalAdapter(api_key="test_key")
    # Patch all 5 series calls — return same payload for all (deterministic test)
    with patch("urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = json.dumps(fake_payload).encode()
        signals = a.fetch_recent_signals(datetime(2026, 5, 1, tzinfo=timezone.utc))
    # 4 of 5 series cross their material-move threshold with a +0.50 delta:
    # DGS10 (>0.25), DGS2 (>0.30), DFF (>0.20), DEXUSEU (>0.03 → critical).
    # DCOILWTICO does NOT trigger because its threshold is 7.50 ($/bbl).
    assert len(signals) == 4
    # Each signal carries proper metadata
    s = signals[0]
    assert s.source.startswith("fred:")
    assert s.confidence == 0.85
    # Sectors populated from the SERIES_CONFIG list
    assert len(s.affected_sectors) > 0


def test_rates_filters_subthreshold_moves():
    """A 5bp move on 10Y (< 25bp threshold) → no signal for that series.

    Use values that don't cross threshold for ANY series — picking a 1bp
    move which is below every series's threshold."""
    fake_payload = {
        "observations": [
            {"date": "2026-05-27", "value": "4.50"},
            {"date": "2026-05-26", "value": "4.51"},   # 1bp move
        ],
    }
    a = RatesSignalAdapter(api_key="test_key")
    with patch("urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = json.dumps(fake_payload).encode()
        signals = a.fetch_recent_signals(datetime(2026, 5, 1, tzinfo=timezone.utc))
    # 0.01 < every threshold → no signals
    assert signals == []


def test_rates_filters_missing_observations():
    """FRED uses '.' for missing values — adapter should skip those silently."""
    fake_payload = {
        "observations": [
            {"date": "2026-05-27", "value": "."},        # missing
            {"date": "2026-05-26", "value": "4.50"},
            {"date": "2026-05-25", "value": "4.00"},     # +50bp vs that
        ],
    }
    a = RatesSignalAdapter(api_key="test_key")
    with patch("urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = json.dumps(fake_payload).encode()
        signals = a.fetch_recent_signals(datetime(2026, 5, 1, tzinfo=timezone.utc))
    # Latest is 4.50, prior is 4.00 → 50bp move > 25bp threshold for DGS10
    assert len(signals) > 0


def test_severity_from_delta_scales_with_ratio():
    # 1.0× threshold → medium
    assert _severity_from_delta(0.30, 0.30) == "medium"
    # 2.0× threshold → high
    assert _severity_from_delta(0.60, 0.30) == "high"
    # 3.5× threshold → critical
    assert _severity_from_delta(1.10, 0.30) == "critical"
    # Below ratio bands → medium (the threshold-crossing case)
    assert _severity_from_delta(0.31, 0.30) == "medium"
