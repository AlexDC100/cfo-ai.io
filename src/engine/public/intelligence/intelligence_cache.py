"""Short-TTL in-memory cache for hot intelligence queries.

Risk Radar + Macro Signals are read-heavy + slow-to-compute (radar needs
exposure profiles for all 200 tickers + signal aggregation). The cache
holds rendered results for `RADAR_TTL_SEC` so repeated FE polls don't
recompute every time.

This is process-local — when the backend has multiple workers, each
warms its own cache on first hit. That's fine: cache misses just trigger
a recompute, and the computations are deterministic so workers don't
diverge.

TTL is intentionally short (5 min for radar, 1 min for signal feed) so
operator-uploaded manual signals appear quickly.
"""

from __future__ import annotations

import time
from threading import Lock
from typing import Any, Callable, Optional


RADAR_TTL_SEC = 300         # 5 min — radar is expensive (universe-wide aggregation)
SIGNALS_TTL_SEC = 60        # 1 min — signal feed needs near-real-time refresh
EXPOSURE_TTL_SEC = 600      # 10 min — exposure profiles change slowly (library edits)
SCORE_TTL_SEC = 180         # 3 min — per-ticker risk score


class IntelligenceCache:
    """Simple TTL cache — get_or_compute(key, ttl, fn). Thread-safe."""

    def __init__(self):
        self._store: dict[str, tuple[float, Any]] = {}  # key → (expires_at_epoch, value)
        self._lock = Lock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if time.time() >= expires_at:
                self._store.pop(key, None)
                return None
            return value

    def put(self, key: str, value: Any, ttl_sec: int) -> None:
        with self._lock:
            self._store[key] = (time.time() + ttl_sec, value)

    def get_or_compute(self, key: str, ttl_sec: int, fn: Callable[[], Any]) -> Any:
        cached = self.get(key)
        if cached is not None:
            return cached
        value = fn()
        self.put(key, value, ttl_sec)
        return value

    def invalidate(self, key_prefix: str = "") -> int:
        """Drop every key starting with the prefix. Returns # of keys dropped."""
        with self._lock:
            doomed = [k for k in self._store if k.startswith(key_prefix)]
            for k in doomed:
                self._store.pop(k, None)
            return len(doomed)


# Process-wide cache instance.
_cache: Optional[IntelligenceCache] = None


def get_intelligence_cache() -> IntelligenceCache:
    global _cache
    if _cache is None:
        _cache = IntelligenceCache()
    return _cache


def reset_intelligence_cache() -> None:
    """Test helper — drop the cache singleton."""
    global _cache
    _cache = None
