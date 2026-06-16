"""Macro signal store + query.

Aggregates signals across every configured adapter. The orchestrator
walks the active adapters, asks each for recent signals, and merges
them into a unified IntelligenceSignal list — deduped by (source, title).

At Phase A only the manual adapter is configured. The other 5 adapter
stubs return empty lists until their env vars are set in Phase B.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from .adapters import ManualSignalAdapter, SignalAdapter
# Phase B + Phase C — real adapters for all 5 providers.
from .adapters.news_signal_adapter import NewsSignalAdapter        # Phase B
from .adapters.rss_signal_adapter import RssSignalAdapter           # Phase B (now w/ Romanian NFKD)
from .adapters.rates_signal_adapter import RatesSignalAdapter       # Phase B
from .adapters.commodity_signal_adapter import CommoditySignalAdapter  # Phase C
from .adapters.gdelt_adapter import GdeltSignalAdapter               # Phase C (replaces the stub)
from .adapters.base import AdapterHealth
from .models import IntelligenceSignal


# Module-level singleton — same instance used by the route layer + tests.
# The manual adapter is the only one that holds state in Phase A (the
# in-memory signal store). Stubs are stateless beyond their env-driven
# `configured` flag.
class MacroSignalService:
    """Aggregates signals from every adapter."""

    def __init__(
        self,
        manual_adapter: Optional[ManualSignalAdapter] = None,
        news_adapter: Optional[SignalAdapter] = None,
        rss_adapter: Optional[SignalAdapter] = None,
        commodity_adapter: Optional[SignalAdapter] = None,
        rates_adapter: Optional[SignalAdapter] = None,
        geopolitical_adapter: Optional[SignalAdapter] = None,
    ):
        self.manual = manual_adapter or ManualSignalAdapter()
        self.news = news_adapter or NewsSignalAdapter()
        self.rss = rss_adapter or RssSignalAdapter()
        self.commodity = commodity_adapter or CommoditySignalAdapter()
        self.rates = rates_adapter or RatesSignalAdapter()
        # `name = "geopolitical"` claims the same slot the stub used to fill,
        # so the route-level health endpoint shape is unchanged. Default off
        # (GDELT_ENABLED unset → configured=False, same as the prior stub).
        self.geopolitical = geopolitical_adapter or GdeltSignalAdapter()

    @property
    def adapters(self) -> list[SignalAdapter]:
        return [self.manual, self.news, self.rss, self.commodity,
                self.rates, self.geopolitical]

    def fetch_all(self, since: Optional[datetime] = None) -> list[IntelligenceSignal]:
        """Pull signals from every adapter since the cutoff.

        Default `since` = 90 days ago — enough to catch all material macro
        events for radar aggregation without paging through years of news.
        """
        if since is None:
            since = datetime.utcnow() - timedelta(days=90)

        collected: list[IntelligenceSignal] = []
        seen: set[tuple[str, str]] = set()  # (source, title) dedup key
        for adapter in self.adapters:
            for signal in adapter.fetch_recent_signals(since):
                key = (signal.source, signal.title)
                if key in seen:
                    continue
                seen.add(key)
                collected.append(signal)
        return collected

    def fetch_for_ticker(
        self,
        ticker: str,
        since: Optional[datetime] = None,
    ) -> list[IntelligenceSignal]:
        ticker_u = ticker.upper()
        return [s for s in self.fetch_all(since) if ticker_u in s.affected_tickers]

    def fetch_for_sector(
        self,
        sector: str,
        since: Optional[datetime] = None,
    ) -> list[IntelligenceSignal]:
        return [s for s in self.fetch_all(since) if sector in s.affected_sectors]

    def health(self) -> dict[str, AdapterHealth]:
        """Per-adapter health snapshot — surfaced by /api/public/intelligence/health."""
        return {a.name: a.health() for a in self.adapters}

    def feed_status(self) -> str:
        """Single-string status used by the FE to render the Macro Signals tab.

        Reflects whether ANY live adapter is configured. Manual is always
        configured but doesn't count as a "live feed" — it's an operator
        artifact. When only manual is configured, the FE shows
        "sector_model_only" and the AI Market Read knows to disclose that.
        """
        live_adapters = [a for a in [self.news, self.rss, self.commodity,
                                      self.rates, self.geopolitical]
                         if a.configured]
        if live_adapters:
            return "live_feed_active"
        return "sector_model_only"


# Singleton — initialized lazily so import doesn't touch the env.
_singleton: Optional[MacroSignalService] = None


def get_macro_signal_service() -> MacroSignalService:
    """Process-wide singleton. Routes import this and call methods on it."""
    global _singleton
    if _singleton is None:
        _singleton = MacroSignalService()
    return _singleton


def reset_macro_signal_service() -> None:
    """Test helper — drop the singleton so the next get_* call re-creates it."""
    global _singleton
    _singleton = None
