"""NewsAPI adapter — Phase B.

Uses https://newsapi.org/ (Top Headlines + Everything endpoints) when
NEWS_API_KEY is set. Same tagging strategy as the RSS adapter: ticker +
sector keyword matching, severity/channel classification via keyword
heuristic.

Free tier is 100 requests/day. The adapter is poll-on-demand and the
intelligence_cache + macro_signal_service throttle calls — radar
recompute (5-min TTL) typically issues 1 call per ticker drill-down.

Config:
  NEWS_API_KEY       — required
  NEWS_API_SOURCES   — optional, comma-separated source IDs (e.g.
                       "bloomberg,reuters,financial-times"). When unset
                       the adapter queries Top Headlines (business
                       category, English).
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid5, NAMESPACE_URL

from ...universe import DEFAULT_UNIVERSE
from ..models import IntelligenceSignal
from .base import AdapterHealth, SignalAdapter
from .rss_signal_adapter import _classify_keyword

logger = logging.getLogger(__name__)

_BASE = "https://newsapi.org/v2"
_HTTP_TIMEOUT_SEC = 8
_MAX_ARTICLES = 60


class NewsSignalAdapter:
    """Live NewsAPI client. Honors NEWS_API_KEY + NEWS_API_SOURCES env."""

    name = "news"

    def __init__(
        self,
        api_key: Optional[str] = None,
        sources: Optional[list[str]] = None,
    ):
        self._api_key = api_key or os.environ.get("NEWS_API_KEY")
        sources_env = os.environ.get("NEWS_API_SOURCES", "")
        self._sources = sources or [s.strip() for s in sources_env.split(",") if s.strip()]
        self._configured = bool(self._api_key)
        self._last_fetch_at: Optional[datetime] = None
        self._last_fetch_count = 0
        self._last_error: Optional[str] = None
        # Ticker tagging — same dictionaries as RSS adapter; reused here so
        # FE renders a uniform tag set regardless of provider.
        self._ticker_to_sector: dict[str, str] = {t: s for t, _, s in DEFAULT_UNIVERSE}
        self._name_lower_to_ticker: dict[str, str] = {
            n.lower().strip(): t for t, n, _ in DEFAULT_UNIVERSE
        }

    @property
    def configured(self) -> bool:
        return self._configured

    def fetch_recent_signals(self, since: datetime) -> list[IntelligenceSignal]:
        if not self._configured:
            return []
        try:
            articles = self._fetch_articles(since)
        except Exception as e:
            self._last_error = f"{e.__class__.__name__}: {e}"
            logger.warning("news_adapter: fetch failed: %s", self._last_error)
            return []

        signals: list[IntelligenceSignal] = []
        for article in articles:
            sig = self._article_to_signal(article)
            if sig and (sig.published_at is None or sig.published_at >= since):
                signals.append(sig)

        self._last_fetch_at = datetime.utcnow()
        self._last_fetch_count = len(signals)
        self._last_error = None
        return signals

    def health(self) -> AdapterHealth:
        if not self._configured:
            return AdapterHealth(
                name=self.name,
                configured=False,
                reason="NEWS_API_KEY not set — sign up at newsapi.org and set the env var.",
            )
        return AdapterHealth(
            name=self.name,
            configured=True,
            reason="",
            last_fetch_at=self._last_fetch_at,
            last_fetch_count=self._last_fetch_count,
            last_error=self._last_error,
            extras={"sources_count": str(len(self._sources))},
        )

    # ─── Internals ──────────────────────────────────────────────────────

    def _fetch_articles(self, since: datetime) -> list[dict]:
        """One NewsAPI call. Routes between Everything (with sources filter)
        and Top Headlines (business category) depending on config."""
        if self._sources:
            params = {
                "apiKey": self._api_key,
                "sources": ",".join(self._sources),
                "pageSize": str(_MAX_ARTICLES),
                "language": "en",
                "sortBy": "publishedAt",
                "from": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            url = f"{_BASE}/everything?{urllib.parse.urlencode(params)}"
        else:
            params = {
                "apiKey": self._api_key,
                "category": "business",
                "pageSize": str(_MAX_ARTICLES),
                "language": "en",
            }
            url = f"{_BASE}/top-headlines?{urllib.parse.urlencode(params)}"

        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "CFO-AI-Intelligence/1.0 (+https://cfo-ai.io)",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read())
        if payload.get("status") != "ok":
            raise RuntimeError(f"NewsAPI returned {payload.get('status')}: {payload.get('message')}")
        return payload.get("articles", [])

    def _article_to_signal(self, article: dict) -> Optional[IntelligenceSignal]:
        title = (article.get("title") or "").strip()
        if not title or title == "[Removed]":
            return None
        description = (article.get("description") or "").strip()
        content = (article.get("content") or "").strip()
        url = (article.get("url") or "").strip()
        source = (article.get("source", {}) or {}).get("name") or "newsapi"
        published_at = _parse_iso8601(article.get("publishedAt"))

        # Tag tickers + sectors
        text_upper = (title + " " + description + " " + content).upper()
        text_lower = (title + " " + description + " " + content).lower()
        affected_tickers: list[str] = []
        for ticker in self._ticker_to_sector.keys():
            if re.search(rf"\b{re.escape(ticker)}\b", text_upper):
                affected_tickers.append(ticker)
        for name_lower, ticker in self._name_lower_to_ticker.items():
            if ticker in affected_tickers:
                continue
            if len(name_lower) >= 5 and name_lower in text_lower:
                affected_tickers.append(ticker)

        affected_sectors = sorted({
            self._ticker_to_sector[t]
            for t in affected_tickers
            if t in self._ticker_to_sector
        })

        # Reuse RSS adapter's keyword classifier — same input shape, same
        # output. Single source of truth for keyword → (type, severity).
        signal_type, severity, channels = _classify_keyword(text_lower)

        sig_id = str(uuid5(NAMESPACE_URL, f"newsapi:{source}:{title}"))
        return IntelligenceSignal(
            id=sig_id,
            signal_type=signal_type,
            title=title[:200],
            summary=(description or title)[:1500],
            source=f"newsapi:{source}",
            source_url=url or None,
            severity=severity,
            time_horizon="3m",
            confidence=0.65,             # Slightly higher than RSS — curated source
            published_at=published_at,
            affected_sectors=affected_sectors,
            affected_tickers=affected_tickers,
            financial_impact_channels=channels,
            risk_categories=[],
        )


def _parse_iso8601(raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None
