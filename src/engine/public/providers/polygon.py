"""Polygon provider — SCAFFOLD ONLY.

No HTTP calls implemented. Methods raise NotImplementedError until
POLYGON_API_KEY is present in env. When the day comes that a paying
customer needs sub-30-min latency on US equities:

  1. Subscribe to Polygon ($30-$200/mo depending on plan)
  2. `POLYGON_API_KEY=pk_xxx` in /opt/cfo-ai/.env
  3. `MARKETS_INTRADAY_ENABLED=true`
  4. Implement get_quote / get_history / get_intraday below using the
     Polygon HTTP client (httpx). The shapes are documented at
     https://polygon.io/docs/stocks. Mind rate limits — the free tier
     is 5 req/min, paid tiers are 100+ req/sec.
  5. Add usage tracking (admin/market-data-costs would land at this
     point) so the bill doesn't surprise anyone.

Keep this file minimal until then. CLAUDE.md is explicit about not
designing for hypothetical future requirements; the scaffold exists so
the router can dispatch correctly on flip, nothing more.
"""
from __future__ import annotations

import os
from datetime import date
from typing import List, Literal

from .base import Candle, PriceQuote


class PolygonProvider:
    name: str = "polygon"
    granularity: Literal["intraday"] = "intraday"
    latency_minutes: int = 1  # rough — actual depends on Polygon plan tier

    def _require_key(self) -> str:
        key = os.environ.get("POLYGON_API_KEY")
        if not key:
            raise NotImplementedError(
                "POLYGON_API_KEY not configured. Either set the env var to "
                "activate the Polygon provider, or leave MARKETS_INTRADAY_ENABLED "
                "unset so the router stays on Sharadar (EOD)."
            )
        return key

    def get_quote(self, ticker: str) -> PriceQuote:  # pragma: no cover
        self._require_key()
        raise NotImplementedError("PolygonProvider.get_quote not yet implemented")

    def get_history(self, ticker: str, from_date: date, to_date: date) -> List[Candle]:  # pragma: no cover
        self._require_key()
        raise NotImplementedError("PolygonProvider.get_history not yet implemented")

    def get_intraday(self, ticker: str, interval: str = "1min") -> List[Candle]:  # pragma: no cover
        self._require_key()
        raise NotImplementedError("PolygonProvider.get_intraday not yet implemented")
