"""Provider router — picks active provider based on env flags.

Default: SharadarProvider (EOD).
Switch criteria for PolygonProvider:
  · MARKETS_INTRADAY_ENABLED=true  AND
  · POLYGON_API_KEY=pk_xxx

Both must be set. The dual-flag pattern lets the operator stage the
switch: add the API key first, smoke-test it on staging, then flip
ENABLED on prod when ready.

Lazy singletons — instantiate on first call, reuse thereafter. Tests
clear `_INSTANCES` to force re-selection.
"""
from __future__ import annotations

import logging
import os
from typing import Dict

from .base import MarketDataProvider
from .polygon import PolygonProvider
from .sharadar import SharadarProvider

logger = logging.getLogger(__name__)

_INSTANCES: Dict[str, MarketDataProvider] = {}


def _truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def get_price_provider() -> MarketDataProvider:
    """Return the active provider for this request. Cheap to call —
    safe to invoke per-request rather than caching at the call site."""
    if _truthy("MARKETS_INTRADAY_ENABLED") and os.environ.get("POLYGON_API_KEY"):
        if "polygon" not in _INSTANCES:
            _INSTANCES["polygon"] = PolygonProvider()
            logger.warning("[markets] active provider: polygon (intraday, ~1min latency)")
        return _INSTANCES["polygon"]
    if "sharadar" not in _INSTANCES:
        _INSTANCES["sharadar"] = SharadarProvider()
        logger.warning("[markets] active provider: sharadar (EOD, ~30min latency)")
    return _INSTANCES["sharadar"]


def reset_provider_cache() -> None:
    """Test hook — drop the cached singleton so a subsequent
    `get_price_provider()` call re-evaluates env flags."""
    _INSTANCES.clear()
