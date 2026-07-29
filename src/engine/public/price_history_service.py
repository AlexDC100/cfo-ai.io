"""Historical price-series service for the StockPriceChart drawer.

PUB-200 — wraps the adapter's `get_price_history` with:
  · Live SEP fetch when the adapter is available (NASDAQ_API_KEY set)
  · Deterministic geometric Brownian motion synth when not
  · In-process per-(ticker, range) cache with a tight TTL

Returns a plain dict ready for `_envelope_for_frontend()`. Demo mode is
always labelled clearly so the FE can render the Demo watermark.

Range semantics — calendar days from "today" (UTC), inclusive:
  1D=1, 5D=7, 1M=31, 6M=183, YTD=Jan 1 → today, 1Y=365, 5Y=1825,
  MAX=full SEP history (we cap synth at 5Y for the demo path so the
  series stays drawable).
"""

from __future__ import annotations

import hashlib
import logging
import math
import random
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from .adapter import NasdaqAdapter, PricePoint
from .demo_universe import demo_snapshot_for
from .errors import NasdaqError, NasdaqKeyMissing

logger = logging.getLogger(__name__)

# Cache TTLs — keep last-trading-day data fresh, accept stale on longer
# ranges where the trailing point matters less.
_CACHE_TTL_SECONDS: Dict[str, int] = {
    "1D": 300,         # 5 minutes — intraday-ish
    "5D": 900,         # 15 minutes
    "1M": 60 * 60,     # 1 hour
    "6M": 6 * 60 * 60,  # 6 hours
    "YTD": 6 * 60 * 60,
    "1Y": 24 * 60 * 60,
    "5Y": 7 * 24 * 60 * 60,
    "MAX": 7 * 24 * 60 * 60,
}

_DEFAULT_TTL = 24 * 60 * 60

_warm_cache: Dict[str, Dict[str, Any]] = {}


VALID_RANGES = {"1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"}


def _ttl_for(range_: str) -> int:
    return _CACHE_TTL_SECONDS.get(range_.upper(), _DEFAULT_TTL)


def _range_days(range_: str) -> Optional[int]:
    """Calendar-days window for a range. None = MAX (no cap)."""
    today = datetime.now(timezone.utc).date()
    if range_.upper() == "YTD":
        return (today - today.replace(month=1, day=1)).days + 1
    return {
        "1D": 1, "5D": 7, "1M": 31, "6M": 183,
        "1Y": 365, "5Y": 1825, "MAX": None,
    }.get(range_.upper(), 365)


# ── Public API ──────────────────────────────────────────────────────────

def get_price_history(
    ticker: str,
    *,
    range: str = "1Y",
    force_refresh: bool = False,
    adapter: Optional[NasdaqAdapter] = None,
) -> Dict[str, Any]:
    """Return a chart-ready price-history payload.

    Shape:
        {
            "ticker": "AAPL",
            "range": "1Y",
            "currency": "USD",
            "source": "nasdaq" | "demo" | "unavailable",
            "mode": "live" | "demo",
            "message": str | None,
            "points": [
                {"date": "YYYY-MM-DD", "open": …, "high": …, "low": …,
                 "close": …, "volume": …},
                …
            ],
            "fetched_at": "<ISO timestamp>",
        }

    Never raises. Falls back to demo synth on any live failure, never
    fabricates a "live" label.
    """
    t = (ticker or "").strip().upper()
    if not t:
        return _empty_payload(t, range, reason="empty_ticker")

    r = range.upper()
    if r not in VALID_RANGES:
        r = "1Y"

    cache_key = f"price-history::{t}::{r}"
    now = time.time()

    if not force_refresh:
        cached = _warm_cache.get(cache_key)
        if cached and now - cached["_cached_at"] < _ttl_for(r):
            return cached["payload"]

    # ── BVB branch (2026-07-23) — Romanian tickers never existed in
    #    Sharadar, so they used to fall straight to the demo synth. Yahoo
    #    Finance carries the whole BVB market under ".RO"; real RON series,
    #    labelled source="bvb_yahoo". Any fetch failure falls through to
    #    the demo synth exactly like the Nasdaq path.
    from .bvb_seed import get_bvb_snapshot
    if get_bvb_snapshot(t) is not None:
        from .providers.yahoo_bvb import fetch_bvb_price_history
        bvb_points = fetch_bvb_price_history(t, r)
        if bvb_points:
            payload = _envelope(
                t, r, bvb_points,
                mode="live", source="bvb_yahoo", message=None,
            )
            payload["currency"] = "RON"
        else:
            payload = _envelope(
                t, r, _synth_series(t, r),
                mode="demo", source="demo",
                message="Live BVB price feed unavailable — showing an illustrative series.",
            )
            payload["currency"] = "RON"
        _warm_cache[cache_key] = {"_cached_at": now, "payload": payload}
        return payload

    nasdaq = adapter or NasdaqAdapter()
    payload: Dict[str, Any]

    if nasdaq.available:
        try:
            points = nasdaq.get_price_history(t, range=r)
        except (NasdaqKeyMissing, NasdaqError) as exc:
            logger.warning("Price history live fetch failed for %s: %s", t, exc)
            points = []
        except Exception as exc:  # noqa: BLE001
            logger.exception("Price history unexpected error for %s: %s", t, exc)
            points = []

        if points:
            payload = _envelope(
                t, r, points,
                mode="live", source="nasdaq", message=None,
            )
        else:
            # Adapter available but no data (SEP not entitled OR ticker
            # not covered) → demo synth so the chart still renders.
            synth = _synth_series(t, r)
            payload = _envelope(
                t, r, synth,
                mode="demo", source="demo",
                message=(
                    "Live SEP price data unavailable for this ticker. "
                    "Showing indicative synthesized series for illustration."
                ),
            )
    else:
        synth = _synth_series(t, r)
        payload = _envelope(
            t, r, synth,
            mode="demo", source="demo",
            message=(
                "Demo price chart shown — connect NASDAQ_DATA_LINK_API_KEY "
                "for live SEP data."
            ),
        )

    _warm_cache[cache_key] = {"_cached_at": now, "payload": payload}
    return payload


def clear_warm_cache() -> None:
    """Test hook + admin endpoint hook — drops the in-process cache."""
    _warm_cache.clear()


# ── Helpers ─────────────────────────────────────────────────────────────


def _empty_payload(ticker: str, range_: str, *, reason: str) -> Dict[str, Any]:
    return {
        "ticker": ticker,
        "range": range_,
        "currency": "USD",
        "source": "unavailable",
        "mode": "demo",
        "message": f"No price history available ({reason}).",
        "points": [],
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def _envelope(
    ticker: str,
    range_: str,
    points: List[Any],
    *,
    mode: str,
    source: str,
    message: Optional[str],
) -> Dict[str, Any]:
    """Wrap a list of PricePoints (or dicts from the synth) into the
    response envelope expected by the FE."""
    serialized: List[Dict[str, Any]] = []
    for p in points:
        if isinstance(p, PricePoint):
            serialized.append({
                "date": p.date.isoformat(),
                "open": p.open,
                "high": p.high,
                "low": p.low,
                "close": p.close,
                "volume": p.volume,
            })
        else:
            serialized.append(p)
    return {
        "ticker": ticker,
        "range": range_,
        "currency": "USD",
        "source": source,
        "mode": mode,
        "message": message,
        "points": serialized,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def _synth_series(ticker: str, range_: str) -> List[Dict[str, Any]]:
    """Deterministic geometric Brownian motion price series seeded by
    the ticker hash. Used when SEP data isn't available so the chart
    has SOMETHING plausible to draw. Labelled `source="demo"` upstream
    so the FE renders the Demo watermark.

    Anchor price: derived from the demo snapshot's market cap when
    available (with a notional shares-outstanding heuristic), otherwise
    a sector-typical default. Drift: 6% annual. Vol: 22% annual.
    Bounds: never below 1.0 USD so the chart can use a log-ish view if
    needed. Cap at 5Y of history for the synth path (MAX falls back to
    5Y synth — live MAX still works for entitled tickers).
    """
    seed_bytes = hashlib.md5(ticker.encode("utf-8")).digest()
    seed = int.from_bytes(seed_bytes[:8], "big")
    rng = random.Random(seed)

    # Anchor price: use demo snapshot to derive a plausible starting
    # price. Real ticker prices vary widely; this synth doesn't need to
    # match reality, just be plausible-looking for the chart.
    snap = demo_snapshot_for(ticker, ticker, "Technology")
    mc = snap.get("marketCap")
    # Notional shares: 1B for $1T+ caps, 100M for $50B+, 10M default.
    if mc and mc > 1e12:
        anchor = mc / 1e10  # $100/share at $1T cap
    elif mc and mc > 1e11:
        anchor = mc / 1e9   # $100/share at $100B cap
    elif mc and mc > 1e10:
        anchor = mc / 5e8   # $20/share at $10B cap
    elif mc and mc > 0:
        anchor = max(10.0, mc / 1e8)
    else:
        anchor = 50.0
    # Inject a small per-ticker offset so two close-priced tickers
    # don't look identical.
    anchor *= 1.0 + (rng.random() - 0.5) * 0.10

    days = _range_days(range_) or 1825  # MAX → 5Y synth
    # Sample one point per "trading day" — approximate 252 / 365.
    n_points = max(2, int(days * 252 / 365))
    # 1D special-case: 1 trading day → 1 point would draw nothing.
    # Render 24 hourly-ish points instead so the chart shows a line.
    if range_.upper() == "1D":
        n_points = 24
        days = 1
    dt = days / n_points / 365.0  # year-fraction step
    drift = 0.06
    vol = 0.22

    today = datetime.now(timezone.utc).date()
    points: List[Dict[str, Any]] = []
    price = anchor
    for i in range(n_points):
        # Geometric Brownian motion increment
        z = rng.gauss(0.0, 1.0)
        log_return = (drift - 0.5 * vol * vol) * dt + vol * math.sqrt(dt) * z
        price = max(1.0, price * math.exp(log_return))
        d = today - timedelta(days=int((n_points - 1 - i) * (days / n_points)))
        high = price * (1.0 + abs(rng.gauss(0.0, 0.008)))
        low = price * (1.0 - abs(rng.gauss(0.0, 0.008)))
        open_ = price * (1.0 + rng.gauss(0.0, 0.005))
        volume = int(rng.uniform(1e6, 5e7))
        points.append({
            "date": d.isoformat(),
            "open": round(open_, 2),
            "high": round(high, 2),
            "low": round(low, 2),
            "close": round(price, 2),
            "volume": volume,
        })
    # Sort ascending in case the loop produced a slight permutation
    points.sort(key=lambda p: p["date"])
    return points


__all__ = [
    "VALID_RANGES",
    "get_price_history",
    "clear_warm_cache",
]
