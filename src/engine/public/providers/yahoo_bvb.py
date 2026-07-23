"""Yahoo Finance chart provider for BVB (Bucharest Stock Exchange) tickers.

Sharadar/Nasdaq Data Link covers US listings only, so the price-history
service had NO real data source for the Romanian universe — BVB tickers
fell through to the synthetic demo series. Yahoo Finance carries the whole
BVB regulated market under the ``.RO`` suffix (verified live 2026-07-23:
``TLV.RO`` → currency RON, exchangeName BVB, real OHLC history back to
2007), which makes it the pragmatic free source for charts.

Symbol rule: our namespaced tickers drop the ``.BVB`` suffix first —
``EL.BVB`` → ``EL.RO``, ``STZ.BVB`` → ``STZ.RO``; everything else is
``{ticker}.RO``.

Caveats, stated plainly:
  * This is Yahoo's UNOFFICIAL chart endpoint (no key, no SLA). We send a
    browser UA, time out fast, and return [] on any failure — the caller
    falls back to the labelled demo synth, never a fake "live" label.
  * Intraday granularity is not requested; all ranges use daily bars
    (weekly for MAX) to match the SEP-shaped envelope the FE expects
    (one point per "YYYY-MM-DD").

stdlib-only (urllib), mirroring providers/anaf_bilant.py, so this also
works in operator scripts without third-party deps.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

_CHART_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/"
    "{symbol}?range={yrange}&interval={interval}"
)
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

# Our range → (yahoo range, yahoo interval). Daily bars throughout so the
# envelope's one-point-per-date contract holds; MAX uses weekly to keep
# multi-decade series drawable.
_RANGE_MAP: Dict[str, tuple[str, str]] = {
    "1D": ("5d", "1d"),    # last close + previous — enough to draw a delta
    "5D": ("5d", "1d"),
    "1M": ("1mo", "1d"),
    "6M": ("6mo", "1d"),
    "YTD": ("ytd", "1d"),
    "1Y": ("1y", "1d"),
    "5Y": ("5y", "1d"),
    "MAX": ("max", "1wk"),
}


def yahoo_symbol_for_bvb(ticker: str) -> str:
    """Map a universe ticker to Yahoo's BVB symbol."""
    t = (ticker or "").strip().upper()
    if t.endswith(".BVB"):
        t = t[: -len(".BVB")]
    return f"{t}.RO"


def fetch_bvb_price_history(ticker: str, range_: str, timeout: float = 12.0) -> List[Dict[str, Any]]:
    """Daily OHLCV points for a BVB ticker, oldest-first, in the same dict
    shape `_envelope()` serializes. Returns [] on any failure."""
    yrange, interval = _RANGE_MAP.get(range_.upper(), _RANGE_MAP["1Y"])
    url = _CHART_URL.format(symbol=yahoo_symbol_for_bvb(ticker), yrange=yrange, interval=interval)
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — fixed https host
            payload = json.loads(resp.read().decode("utf-8", errors="replace"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        logger.warning("[yahoo_bvb] fetch failed for %s: %s", ticker, exc)
        return []

    try:
        result = payload["chart"]["result"][0]
        stamps: List[int] = result.get("timestamp") or []
        quote = result["indicators"]["quote"][0]
    except (KeyError, IndexError, TypeError):
        return []

    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []

    points: List[Dict[str, Any]] = []
    for i, ts in enumerate(stamps):
        close = closes[i] if i < len(closes) else None
        if close is None:
            continue  # untraded day — Yahoo pads with nulls
        day = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
        points.append({
            "date": day,
            "open": opens[i] if i < len(opens) else None,
            "high": highs[i] if i < len(highs) else None,
            "low": lows[i] if i < len(lows) else None,
            "close": round(float(close), 4),
            "volume": volumes[i] if i < len(volumes) else None,
        })

    # 1D keeps just the trailing two bars (delta vs. previous close).
    if range_.upper() == "1D" and len(points) > 2:
        points = points[-2:]
    return points


# ── Batch quotes (spark endpoint) ────────────────────────────────────────

_SPARK_URL = (
    "https://query1.finance.yahoo.com/v8/finance/spark"
    "?symbols={symbols}&range=5d&interval=1d"
)
_SPARK_BATCH = 20  # symbols per call — well under any URL/step limits


def fetch_bvb_spark_quotes(tickers: List[str], timeout: float = 12.0) -> Dict[str, Dict[str, float]]:
    """Latest close + day-over-day change for a set of BVB tickers, in a
    handful of batched spark calls. Returns {ticker: {"price": …,
    "priceChangePct": …}} — tickers Yahoo doesn't know are simply absent.
    Best-effort: a failed batch is skipped, never raised."""
    out: Dict[str, Dict[str, float]] = {}
    for i in range(0, len(tickers), _SPARK_BATCH):
        batch = tickers[i : i + _SPARK_BATCH]
        sym_to_ticker = {yahoo_symbol_for_bvb(t): t for t in batch}
        url = _SPARK_URL.format(symbols=",".join(sym_to_ticker))
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
                payload = json.loads(resp.read().decode("utf-8", errors="replace"))
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            logger.warning("[yahoo_bvb] spark batch failed (%d syms): %s", len(batch), exc)
            continue
        if not isinstance(payload, dict):
            continue
        for sym, ticker in sym_to_ticker.items():
            series = payload.get(sym)
            closes = [c for c in (series or {}).get("close") or [] if c is not None]
            if not closes:
                continue
            price = float(closes[-1])
            entry: Dict[str, float] = {"price": round(price, 4)}
            if len(closes) >= 2 and closes[-2]:
                entry["priceChangePct"] = round((price / float(closes[-2]) - 1) * 100, 2)
            out[ticker] = entry
    return out
