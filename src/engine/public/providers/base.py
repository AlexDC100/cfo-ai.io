"""Market-data provider Protocol.

Any provider implementation must expose:
  · `name`              — short identifier ('sharadar', 'polygon', ...)
  · `granularity`       — 'eod' or 'intraday'; drives UI freshness label
  · `latency_minutes`   — typical delay from market event to availability
  · `get_quote(ticker)`             — latest snapshot
  · `get_history(ticker, from, to)` — daily OHLC range
  · `get_intraday(ticker, interval)` — sub-day bars; EOD providers may raise

Concrete shapes are deliberately thin — most callers just want price +
timestamp. Add fields only when a real call-site needs them.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import List, Literal, Optional, Protocol, runtime_checkable


@dataclass
class PriceQuote:
    ticker: str
    price: Optional[float]
    currency: str
    timestamp: datetime
    source: str  # provider name for the badge/audit trail


@dataclass
class Candle:
    ticker: str
    timestamp: datetime
    open: Optional[float]
    high: Optional[float]
    low: Optional[float]
    close: Optional[float]
    volume: Optional[int] = None


@runtime_checkable
class MarketDataProvider(Protocol):
    name: str
    granularity: Literal["intraday", "eod"]
    latency_minutes: int

    def get_quote(self, ticker: str) -> PriceQuote: ...

    def get_history(
        self, ticker: str, from_date: date, to_date: date,
    ) -> List[Candle]: ...

    def get_intraday(
        self, ticker: str, interval: str = "1min",
    ) -> List[Candle]: ...
