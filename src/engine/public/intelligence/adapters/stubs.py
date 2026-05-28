"""Stub adapters for Phase B providers (news / RSS / commodity / rates / geopolitical).

Each returns `configured = False` unless its env var is set. When unconfigured,
`fetch_recent_signals` returns []. The route layer surfaces the `configured`
state explicitly so the FE shows "Live signal feed not connected" instead of
rendering a silent empty feed.

When operators wire up a provider in Phase B, replace the stub body with a
real implementation. The Protocol contract is satisfied by the stubs even
in their inert state.
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Optional

from ..models import IntelligenceSignal
from .base import AdapterHealth, SignalAdapter


class _BaseStubAdapter:
    """Common Phase-B-stub plumbing. Subclasses define name + env_var."""

    name: str = ""
    env_var: str = ""
    description: str = ""

    def __init__(self):
        self._configured = bool(os.getenv(self.env_var))
        self._last_fetch_at: Optional[datetime] = None
        self._last_error: Optional[str] = None

    @property
    def configured(self) -> bool:
        return self._configured

    def fetch_recent_signals(self, since: datetime) -> list[IntelligenceSignal]:
        if not self._configured:
            return []
        # TODO(Phase B): real provider call goes here.
        return []

    def health(self) -> AdapterHealth:
        if not self._configured:
            return AdapterHealth(
                name=self.name,
                configured=False,
                reason=f"{self.env_var} not set — {self.description}",
            )
        return AdapterHealth(
            name=self.name,
            configured=True,
            reason="Configured (Phase B implementation pending).",
            last_fetch_at=self._last_fetch_at,
            last_fetch_count=0,
            last_error=self._last_error,
        )


class NewsSignalAdapter(_BaseStubAdapter):
    name = "news"
    env_var = "NEWS_API_KEY"
    description = (
        "Connect a news provider (NewsAPI / Bloomberg RSS / Reuters) "
        "to surface company-level news signals."
    )


class RssSignalAdapter(_BaseStubAdapter):
    name = "rss"
    env_var = "RSS_FEED_URLS"
    description = (
        "Set RSS_FEED_URLS (comma-separated) to an aggregator endpoint "
        "to surface RSS-based news signals."
    )


class CommoditySignalAdapter(_BaseStubAdapter):
    name = "commodity"
    env_var = "EIA_API_KEY"
    description = (
        "Connect EIA (energy) or FRED (general commodities) to surface "
        "commodity-price signals."
    )


class RatesSignalAdapter(_BaseStubAdapter):
    name = "rates"
    env_var = "FRED_API_KEY"
    description = (
        "Connect FRED (US rates + macro) to surface interest-rate + FX "
        "shift signals."
    )


class GeopoliticalSignalAdapter(_BaseStubAdapter):
    name = "geopolitical"
    env_var = "GDELT_ENABLED"
    description = (
        "Enable GDELT (Global Database of Events, Language, Tone) to "
        "surface geopolitical-event signals."
    )
