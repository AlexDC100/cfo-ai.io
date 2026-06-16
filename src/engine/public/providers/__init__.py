"""WS3 — pluggable market-data provider layer.

The active provider is selected at request time by `router.get_price_provider()`
based on env (MARKETS_INTRADAY_ENABLED + POLYGON_API_KEY). Defaults to
Sharadar EOD. Polygon is scaffolded but disabled — flip env to switch
without code edits when intraday demand justifies the subscription cost.

Caller pattern:
    from engine.public.providers import get_price_provider
    provider = get_price_provider()
    quote = provider.get_quote(ticker)
"""
from .router import get_price_provider
from .base import MarketDataProvider, PriceQuote, Candle

__all__ = ["get_price_provider", "MarketDataProvider", "PriceQuote", "Candle"]
