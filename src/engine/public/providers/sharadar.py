"""Sharadar provider — wraps the existing NasdaqAdapter so callers can
go through `get_price_provider()` without knowing which backend serves
the data.

This is a thin adapter; the heavy lifting (caching, batching, normalizer)
stays in `engine.public.adapter` and `price_history_service`. We just
expose the Protocol shape and translate the existing call signatures.

`get_intraday` raises NotImplementedError — Sharadar is end-of-day only.
Callers that genuinely need intraday should switch the active provider
via env (`MARKETS_INTRADAY_ENABLED=true`) once a Polygon (or equivalent)
key is configured.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import List, Literal

from .base import Candle, PriceQuote


class SharadarProvider:
    name: str = "sharadar"
    granularity: Literal["eod"] = "eod"
    latency_minutes: int = 30  # SF1+DAILY publish ~30min after market close

    def get_quote(self, ticker: str) -> PriceQuote:
        # Lazy import avoids circular dep between providers/ and the
        # adapter module that already imports cache + normalizer.
        from ..pipeline import get_adapter
        adapter = get_adapter()
        # Existing adapter exposes a single-ticker quote getter.
        q = adapter.get_quote(ticker)
        if not q:
            return PriceQuote(ticker=ticker, price=None, currency="USD",
                              timestamp=datetime.now(timezone.utc), source=self.name)
        return PriceQuote(
            ticker=ticker,
            price=float(q.get("price")) if q.get("price") is not None else None,
            currency=q.get("currency") or "USD",
            timestamp=q.get("date") or datetime.now(timezone.utc),
            source=self.name,
        )

    def get_history(self, ticker: str, from_date: date, to_date: date) -> List[Candle]:
        # Sharadar SEP daily candles via price_history_service. Range is
        # bounded to the requested window; the service handles caching.
        from ..price_history_service import get_price_history
        # The service uses a `range` shorthand; for explicit date windows
        # the adapter is the right entry point.
        from ..pipeline import get_adapter
        adapter = get_adapter()
        rows = adapter.get_price_history_window(ticker, from_date, to_date) or []
        return [
            Candle(
                ticker=ticker,
                timestamp=r.get("date"),
                open=r.get("open"),
                high=r.get("high"),
                low=r.get("low"),
                close=r.get("close"),
                volume=r.get("volume"),
            )
            for r in rows
        ]

    def get_intraday(self, ticker: str, interval: str = "1min") -> List[Candle]:
        raise NotImplementedError(
            f"sharadar provider is end-of-day only; intraday requested "
            f"(ticker={ticker}, interval={interval}). Set "
            f"MARKETS_INTRADAY_ENABLED=true and POLYGON_API_KEY to switch."
        )
