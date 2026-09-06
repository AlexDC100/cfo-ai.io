"""Universe service — flattens the 200+ ticker universe into the row
shape the FE table consumes.

PUB-200-FIX-A — live-by-default when NASDAQ_DATA_LINK_API_KEY is set.
We use batch SF1 + batch DAILY (one call each for 100 tickers,
two calls each for 200) instead of fanning out 200 sequential
single-ticker fetches. Cold-load latency is ~2-4 seconds, warm cache
is instant. Per-ticker live failures fall back to the demo row so a
single dead ticker doesn't blank the table.

Mode selection per request:

  · LIVE — `NasdaqAdapter.available` is True and the batch SF1 call
    returned ≥1 ticker. Per-ticker fallback: any ticker missing from
    the batch response renders demo, but the row still ships.
  · DEMO — adapter unavailable OR batch call returned zero tickers.
    Returns the static demo snapshots tagged ``source="demo"``.

The top-level `mode` is "live" when ANY ticker resolved live, "demo"
when ALL fell back. The per-row `source` is always authoritative —
the FE renders the badge from that.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from .adapter import NasdaqAdapter
from .bvb_seed import bvb_universe as _bvb_universe
from .demo_universe import demo_snapshot_for
from .errors import NasdaqError, NasdaqKeyMissing
from .normalizer import build_universe_snapshot_row
from .universe import DEFAULT_UNIVERSE, universe_meta, universe_tickers


# ── BVB Phase 1 (2026-05-31) ────────────────────────────────────────────
# BVB seed rows are pre-shaped (they already carry the full snapshot
# fields with exchange="BVB", currency="RON", source="seed_bvb"). Both
# the demo and live universe paths append these via _bvb_seed_rows()
# so the FE's RomanianListedCard finds them whether or not the Nasdaq
# adapter is wired. The seed is the data source for Phase 1 — no live
# BVB feed yet.

def _bvb_seed_rows() -> List[Dict[str, Any]]:
    """Return the BVB seed rows in display order, enriched with live
    quotes. Each row is the canonical PublicCompanyFinancialSnapshot
    shape — shallow-copied so the caller can mutate freely without
    aliasing the in-memory seed table.

    Timestamps are DATA timestamps, never the process clock:

      · ``lastUpdated`` stays the seed's own retrieval date — the seeded
        market cap and fundamentals are as of that day, and a quote sweep
        does not make them fresher.
      · ``quoteAsOf`` is set ONLY on a row that received a live quote,
        to the moment the Yahoo sweep that produced it succeeded. That is
        what the price and the day change are as of.
    """
    rows = [dict(row) for row in _bvb_universe().values()]
    quotes = _bvb_live_quotes()
    quoted_at = _bvb_quotes_as_of()
    for row in rows:
        q = quotes.get(row["ticker"]) or {}
        # KEY ON THE PRICE, NOT ON TRUTHINESS. This used to be `if q:` and
        # then stamp ``quoteAsOf`` unconditionally inside the branch. A
        # provider entry that carries no ``price`` key — or carries
        # ``price: None`` — is truthy as soon as it holds any other field,
        # so the row kept the seed's price of None and gained a
        # ``quoteAsOf`` saying when that absent price was observed. A
        # timestamp on a figure that does not exist is a provenance claim
        # with nothing behind it; the FE reads ``quoteAsOf`` as "this
        # price is as of". Latent on today's provider, one field away from
        # live.
        price = q.get("price")
        if price is not None:
            row["price"] = price
            row["quoteAsOf"] = quoted_at
        if q.get("priceChangePct") is not None:
            # A day change is its own observation; it rides the same sweep
            # timestamp only when there is also a price it is a change in.
            row["priceChangePct"] = q["priceChangePct"]
    return rows


# BVB quote cache (2026-07-23) — one batched Yahoo spark sweep per TTL
# window covers all 88 tickers in ~5 HTTP calls. Failure degrades to the
# seed's price=None (never a fake number).
#
# ``at`` is the TTL clock — bumped on every attempt, success or failure,
# so an outage is not retried on every request. ``quoted_at`` is the
# DATA clock — set only when a sweep actually returned — because
# last-known quotes kept through a failed sweep are still as of the sweep
# that produced them, and stamping them with the failed attempt's time
# would fabricate freshness.
_BVB_QUOTES_TTL_S = 5 * 60
_bvb_quotes_cache: Dict[str, Any] = {"at": 0.0, "quoted_at": None, "quotes": {}}


def _bvb_live_quotes() -> Dict[str, Dict[str, float]]:
    now = time.time()
    if now - _bvb_quotes_cache["at"] < _BVB_QUOTES_TTL_S:
        return _bvb_quotes_cache["quotes"]
    try:
        from .providers.yahoo_bvb import fetch_bvb_spark_quotes
        quotes = fetch_bvb_spark_quotes(list(_bvb_universe().keys()))
        _bvb_quotes_cache["quoted_at"] = now
    except Exception:  # noqa: BLE001 — quotes are strictly best-effort
        logger.exception("[universe] BVB quote sweep failed")
        quotes = _bvb_quotes_cache["quotes"]  # keep last-known on failure
    _bvb_quotes_cache["at"] = now
    _bvb_quotes_cache["quotes"] = quotes
    return quotes


def _bvb_quotes_as_of() -> Optional[str]:
    """ISO-8601 UTC time of the last SUCCESSFUL quote sweep, or None when
    no sweep has ever returned. This is the only timestamp a BVB price
    may carry."""
    from datetime import datetime, timezone

    at = _bvb_quotes_cache.get("quoted_at")
    if not at:
        return None
    return datetime.fromtimestamp(float(at), tz=timezone.utc).isoformat(timespec="seconds")


def _newest_row_stamp(rows: List[Dict[str, Any]]) -> Optional[str]:
    """The payload-level ``lastUpdated``: the newest DATA timestamp any
    row carries (seed date, demo as-of, DAILY trading day), or None. Never
    the time this function ran — a build time says nothing about the
    data, and it was what every payload carried until 2026-09-04."""
    stamps = [r.get("lastUpdated") for r in rows]
    stamps = [x for x in stamps if isinstance(x, str) and x]
    return max(stamps) if stamps else None

logger = logging.getLogger(__name__)

# In-process cache. Keyed by ("universe", dimension). Survives within a
# uvicorn worker but not across worker restarts — fine for our scale.
#
# PUB-200-FIX-F — was 1h; now 5min. Sharadar DAILY rolls over each
# afternoon (US market close + ~30min), so a fresh read every 5min
# lines up with how often the upstream actually changes during a
# trading day. SF1 fundamentals only change quarterly so the bulk of
# the response is stable; we're really just keeping market_cap, P/E,
# EV multiples on the latest trading day's close.
#
# True intraday tick-by-tick is NOT available from Sharadar
# (SEP/DAILY are end-of-day datasets). Wiring Polygon or IEX would be
# a separate paid integration.
LIVE_TTL_SECONDS: int = 5 * 60  # 5 minutes
_warm_cache: Dict[str, Dict[str, Any]] = {}


def get_universe(
    *,
    dimension: str = "ARY",
    force_refresh: bool = False,
    live: Optional[bool] = None,
    adapter: Optional[NasdaqAdapter] = None,
) -> Dict[str, Any]:
    """Hydrate the full default universe into the FE table shape.

    PUB-200-FIX-A — `live` parameter semantics:

      · None (default): auto-detect. Live if adapter.available, demo
        otherwise. This is the right default for production: when the
        API key is set, the user expects live data.
      · True: force live attempt. Per-ticker fallback to demo if a
        ticker isn't in the batch response.
      · False: force demo. Used when an operator wants to skip the
        live call entirely (e.g., for offline preview).

    Returns:
        {
            "mode": "live" | "demo",
            "source": "nasdaq" | "demo",
            "count": int,
            "lastUpdated": iso-8601 str,
            "message": str | None,
            "companies": [PublicCompanyFinancialSnapshot, ...],
        }
    """
    nasdaq = adapter or NasdaqAdapter()

    # Auto-detect when the caller didn't specify a mode.
    if live is None:
        live = nasdaq.available

    if not live:
        # Hot path — pre-computed demo table, no HTTP, no allocations
        # beyond the dict copy. ~0.5 ms on the VPS.
        reason = "no_key" if not nasdaq.available else "forced_demo"
        return _build_demo_payload(reason=reason)

    key = f"universe::{dimension}::live"
    now = time.time()

    if not force_refresh:
        cached = _warm_cache.get(key)
        if cached and now - cached["_cached_at"] < LIVE_TTL_SECONDS:
            return cached["payload"]

    payload = _hydrate_universe_batch(dimension=dimension, adapter=nasdaq)
    _warm_cache[key] = {"_cached_at": now, "payload": payload}
    return payload


def _build_demo_payload(*, reason: str) -> Dict[str, Any]:
    """All-demo universe payload — used as the default response when
    the API key isn't configured and as the safety net when the live
    batch call returned zero usable rows."""
    rows = [
        demo_snapshot_for(ticker, name, sector)
        for ticker, name, sector in DEFAULT_UNIVERSE
    ]
    # BVB Phase 1 — append seed rows so the Markets-page Romanian card
    # is populated even when NASDAQ_DATA_LINK_API_KEY isn't configured.
    rows.extend(_bvb_seed_rows())
    if reason == "no_key":
        message = (
            "Demo data shown. Configure NASDAQ_DATA_LINK_API_KEY on the "
            "backend to hydrate the full universe with live SF1/DAILY data."
        )
    elif reason == "live_empty":
        message = (
            "Live SF1 batch returned no rows for the configured tickers. "
            "Falling back to demo snapshots. Check Nasdaq subscription tier."
        )
    else:
        message = (
            "Showing indicative FY2024 values. Use the snapshot drawer "
            "(click a row) for live SF1 data per ticker."
        )
    return {
        "mode": "demo",
        "source": "demo",
        "count": len(rows),
        "lastUpdated": _newest_row_stamp(rows),
        "message": message,
        "companies": rows,
    }


def _hydrate_universe_batch(
    *,
    dimension: str,
    adapter: NasdaqAdapter,
) -> Dict[str, Any]:
    """PUB-200-FIX-A — single-batch hydration path. Two HTTP calls
    (SF1 fundamentals + DAILY market metrics) cover all 200 tickers.

    Strategy:
      1. Batch SF1 for fundamentals (revenue, EBITDA, margins, debt)
      2. Batch DAILY for market metrics (price, market cap, EV, P/E,
         multiples, dividend yield)
      3. Merge per-ticker into the universe row shape
      4. Per-ticker demo fallback when both batches return nothing

    Never raises — a transport failure on either batch logs and falls
    back to all-demo (so the page never blanks).
    """
    tickers = universe_tickers()
    meta = universe_meta()

    # ── Live fetch (both batches) ──
    fundamentals_by_ticker: Dict[str, Any] = {}
    daily_by_ticker: Dict[str, Any] = {}

    try:
        fundamentals_by_ticker = adapter.get_fundamentals_batch(
            tickers, dimension=dimension,  # type: ignore[arg-type]
        )
    except (NasdaqKeyMissing, NasdaqError) as exc:
        logger.warning("Batch SF1 fetch failed: %s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Batch SF1 unexpected error: %s", exc)

    try:
        daily_by_ticker = adapter.get_daily_metrics_batch(tickers)
    except (NasdaqKeyMissing, NasdaqError) as exc:
        logger.warning("Batch DAILY fetch failed: %s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Batch DAILY unexpected error: %s", exc)

    # If BOTH batches returned nothing, fall back to all-demo so the
    # page renders something useful. The message tells the operator
    # what went wrong.
    if not fundamentals_by_ticker and not daily_by_ticker:
        logger.warning(
            "Live hydration returned 0 fundamentals + 0 daily metrics; "
            "falling back to demo. Check Sharadar SF1/DAILY entitlement.",
        )
        return _build_demo_payload(reason="live_empty")

    # ── Merge per-ticker ──
    rows: List[Dict[str, Any]] = []
    any_live = False
    any_demo = False

    for ticker, name, sector in DEFAULT_UNIVERSE:
        f = fundamentals_by_ticker.get(ticker)
        d = daily_by_ticker.get(ticker)

        if f is None and d is None:
            # No live data for this ticker — render demo row.
            rows.append(demo_snapshot_for(ticker, name, sector))
            any_demo = True
            continue

        # Build a live snapshot row from the fundamentals + DAILY blob.
        live_row = _live_row(
            ticker=ticker,
            fallback_name=meta.get(ticker, {}).get("name") or name,
            fallback_sector=sector,
            fundamentals=f,
            daily=d,
        )
        if live_row is None:
            rows.append(demo_snapshot_for(ticker, name, sector))
            any_demo = True
        else:
            rows.append(live_row)
            any_live = True

    # BVB Phase 1 — append seed rows in the live path too. NASDAQ
    # universe and BVB seed coexist as parallel sources; the FE filters
    # by exchange to route them to different surfaces. Computed against
    # NASDAQ-only count for the live/demo ratio messaging.
    nasdaq_live_count = sum(1 for r in rows if r.get("source") == "nasdaq")
    nasdaq_total = len(rows)
    rows.extend(_bvb_seed_rows())

    overall_mode = "live" if any_live else "demo"
    source = "nasdaq" if any_live else "demo"
    message: Optional[str] = None
    if overall_mode == "demo":
        message = (
            "Live hydration returned no usable rows; showing demo snapshots."
        )
    elif any_demo:
        # Some rows live, some demo — mention it so the user knows why
        # some Source pills say Demo. Excludes BVB rows from the ratio
        # since they're seed (not subject to Sharadar coverage).
        message = (
            f"Live data for {nasdaq_live_count} of {nasdaq_total} NASDAQ "
            "tickers; the rest fell back to demo (likely Sharadar coverage gap)."
        )

    return {
        "mode": overall_mode,
        "source": source,
        "count": len(rows),
        "lastUpdated": _newest_row_stamp(rows),
        "message": message,
        "companies": rows,
    }


def _live_row(
    *,
    ticker: str,
    fallback_name: str,
    fallback_sector: str,
    fundamentals: Optional[Any],
    daily: Optional[Any],
) -> Optional[Dict[str, Any]]:
    """Flatten one ticker's fundamentals + DAILY metrics into the FE row.

    Returns None when there's not enough data to render a meaningful
    row (caller falls back to demo).
    """
    if fundamentals is None and daily is None:
        return None

    def _g(obj: Any, attr: str) -> Optional[float]:
        if obj is None:
            return None
        v = getattr(obj, attr, None)
        return float(v) if isinstance(v, (int, float)) else None

    revenue = _g(fundamentals, "revenue")
    ebitda = _g(fundamentals, "ebitda")
    net_income = _g(fundamentals, "net_income")
    total_debt = _g(fundamentals, "total_debt")
    cash = _g(fundamentals, "cash")
    equity = _g(fundamentals, "total_equity")
    ocf = _g(fundamentals, "operating_cash_flow")
    fcf = _g(fundamentals, "free_cash_flow")
    ebit = _g(fundamentals, "ebit")
    shares_outstanding = _g(fundamentals, "shares_outstanding")

    market_cap = _g(daily, "market_cap")
    enterprise_value = _g(daily, "enterprise_value")
    pe = _g(daily, "pe_ratio")
    ev_ebitda = _g(daily, "ev_ebitda")
    ev_revenue = _g(daily, "ev_revenue")
    div_yield_raw = _g(daily, "dividend_yield")

    # PUB-200-FIX-D — derive per-share price from market_cap /
    # shares_outstanding so the Price column renders without an
    # additional SEP batch call. This is the same number a SEP close
    # quote would give, modulo rounding. None when either input is
    # missing — the table renders "—" via the formatter.
    price = (
        market_cap / shares_outstanding
        if market_cap is not None
        and shares_outstanding is not None
        and shares_outstanding > 0
        else None
    )
    # Sharadar emits dividend_yield as a decimal (0.005 = 0.5%) for
    # most equities; we convert to percentage points so the FE
    # formatter shows it as "0.5%" not "0.005%".
    div_yield = (
        div_yield_raw * 100 if div_yield_raw is not None and div_yield_raw < 1
        else div_yield_raw
    )

    ebitda_margin = (ebitda / revenue * 100) if revenue and ebitda else None
    net_margin = (net_income / revenue * 100) if revenue and net_income else None
    net_debt = (
        (total_debt - cash) if total_debt is not None and cash is not None else None
    )
    nd_to_ebitda = (net_debt / ebitda) if net_debt is not None and ebitda not in (None, 0) else None
    fcf_yield = (fcf / market_cap * 100) if fcf and market_cap else None
    roe = (net_income / equity * 100) if net_income and equity not in (None, 0) else None
    debt_to_equity = (total_debt / equity) if total_debt is not None and equity not in (None, 0) else None

    # Data timestamps, never the process clock. DAILY carries the trading
    # day its market figures are as of — that is when the market cap, the
    # multiples and the price derived from them were observed, so it is
    # both the row's ``lastUpdated`` and, when a price exists, its
    # ``quoteAsOf``. SF1 fundamentals carry a fiscal period (below) but
    # the adapter keeps no fetch stamp for them, so no fiscal timestamp
    # is claimed. Until 2026-09-04 this was ``datetime.now()``.
    market_as_of: Optional[str] = None
    if daily is not None:
        _as_of = getattr(daily, "as_of", None)
        if _as_of is not None:
            market_as_of = (
                _as_of.isoformat() if hasattr(_as_of, "isoformat") else str(_as_of)
            )

    # Period info — from fundamentals when present, daily when not.
    period_end = None
    period_label = None
    if fundamentals is not None:
        fpe = getattr(fundamentals, "fiscal_period_end", None)
        if fpe is not None:
            period_end = fpe.isoformat() if hasattr(fpe, "isoformat") else str(fpe)
            # Format as "FY2024" when annual
            year = period_end[:4] if isinstance(period_end, str) and len(period_end) >= 4 else None
            if year:
                period_label = f"FY{year}"

    return {
        "ticker": ticker,
        "companyName": fallback_name,
        "exchange": "NASDAQ" if ticker in {
            "AAPL", "MSFT", "NVDA", "GOOGL", "META", "AVGO", "ORCL", "CRM",
            "ADBE", "CSCO", "INTC", "AMD", "QCOM", "TXN", "MU", "ASML",
            "AMZN", "TSLA", "NFLX", "CMCSA", "TMUS", "PEP", "COST", "MDLZ",
            "ISRG", "BKNG", "SBUX", "PANW", "FTNT", "WDAY", "TEAM", "DDOG",
            "SNOW", "NOW", "INTU", "REGN", "VRTX", "GILD", "MRVL", "MCHP",
            "ADI", "NXPI", "AMAT", "LRCX", "ON", "SWKS", "MAR", "ABNB",
            "EA", "ROST", "LULU", "ORLY", "FAST", "FI",
        } else "NYSE",
        "sector": fallback_sector,
        "industry": None,
        "country": "USA",
        "currency": "USD",
        "mode": "live",
        # PUB-200-FIX-D — `price` is derived from market_cap / shares
        # (exact = SEP last close ÷ rounding). Today % left null in v1
        # since it'd need a second SEP batch for yesterday's close.
        "price": price,
        "priceChangePct": None,  # populated when DAILY exposes daily delta
        "marketCap": market_cap,
        "enterpriseValue": enterprise_value,
        "revenue": revenue,
        "revenueGrowth": None,  # requires prior period — v2
        "grossProfit": None,
        "grossMargin": None,
        "ebitda": ebitda,
        "ebitdaMargin": ebitda_margin,
        "operatingIncome": ebit,
        "netIncome": net_income,
        "netMargin": net_margin,
        "cash": cash,
        "grossDebt": total_debt,
        "netDebt": net_debt,
        "equity": equity,
        "operatingCashFlow": ocf,
        "capex": _g(fundamentals, "capex"),
        "freeCashFlow": fcf,
        "peRatio": pe,
        "evToEbitda": ev_ebitda,
        "evToSales": ev_revenue,
        "fcfYield": fcf_yield,
        "dividendYield": div_yield,
        "roe": roe,
        "roa": None,
        "roic": None,
        "netDebtToEbitda": nd_to_ebitda,
        "debtToEquity": debt_to_equity,
        "currentRatio": None,
        "latestPeriod": period_label,
        "latestPeriodEnd": period_end,
        "lastUpdated": market_as_of,
        "quoteAsOf": market_as_of if price is not None else None,
        "source": "nasdaq",
        "confidence": 0.95,
        "missingFields": [],
    }


def is_warm(*, dimension: str = "ARY", adapter: Optional[NasdaqAdapter] = None) -> bool:
    """True when the next ``get_universe`` would reach NO provider.

    Read by ``engine.public.refresh_shield.egress_guard`` so a warm read
    spends neither an outbound call nor a token. Two ways to be warm:

      · the live warm cache is inside ``LIVE_TTL_SECONDS``; or
      · the adapter has no key, so ``get_universe`` takes the pre-computed
        demo path — no HTTP at all. Charging a token there would throttle
        a route that costs a provider nothing.

    The DEMO path is not unconditionally free, and saying so would be the
    easy lie here: ``_build_demo_payload`` still calls ``_bvb_seed_rows``,
    which sweeps Yahoo for 88 BVB quotes (MEASURED: 5 outbound) whenever
    ``_BVB_QUOTES_TTL_S`` has lapsed. So the demo path counts as warm only
    while that quote cache is fresh. The live path needs no separate check
    — the sweep happens INSIDE hydration, so a fresh live payload already
    contains the quotes it was built from.
    """
    now = time.time()
    nasdaq = adapter or NasdaqAdapter()
    if not nasdaq.available:
        return (now - float(_bvb_quotes_cache["at"])) < _BVB_QUOTES_TTL_S
    cached = _warm_cache.get("universe::%s::live" % dimension)
    return bool(cached) and (now - cached["_cached_at"]) < LIVE_TTL_SECONDS


def clear_warm_cache() -> None:
    """Test hook + admin endpoint hook — drops the in-process cache so
    the next ``get_universe`` call goes back to the source."""
    _warm_cache.clear()


def _fold_diacritics(s: str) -> str:
    """BVB Phase 2 (2026-06-01) — Unicode-fold + uppercase for search.

    Romanian company names carry diacritics (ă/â/î/ș/ț, and variants
    with cedilla vs comma). A user typing 'transilvania' or 'romgaz'
    in ASCII should match 'Banca Transilvania' or 'Romgaz' (no
    diacritics in those particular names) AND 'Societatea Națională'
    should match queries 'nationala' / 'naţională' / 'natională'.

    Strategy: NFKD-normalize so each accented letter splits into
    base-letter + combining mark, then drop the combining marks
    (Unicode category Mn). Finally uppercase for case-insensitive
    membership tests downstream. Pure standard library — no dep.
    """
    import unicodedata
    if not s:
        return ""
    nfkd = unicodedata.normalize("NFKD", s)
    folded = "".join(c for c in nfkd if not unicodedata.combining(c))
    return folded.upper()


def search_universe(query: str, *, limit: int = 20) -> List[Dict[str, str]]:
    """Lightweight prefix search over the default universe + BVB seed.

    BVB Phase 2 (2026-06-01):
      · Folds diacritics on both query and corpus so ASCII queries match
        Romanian names ('Romgaz' query → matches 'Romgaz S.A.';
        'nationala' query → matches 'Națională').
      · Searches the BVB seed table alongside DEFAULT_UNIVERSE. Result
        rows tag exchange='BVB' so the FE can show the exchange chip.

    Used for the universe-only quick-pick — full Nasdaq search remains
    on the adapter's `search_companies` endpoint.
    """
    q = _fold_diacritics(query.strip() if query else "")
    if not q:
        return []
    hits: List[Dict[str, str]] = []

    # NASDAQ default universe — back-compat shape (no exchange field on
    # the hit; the FE treats the absence as US-listed).
    for ticker, name, sector in DEFAULT_UNIVERSE:
        if q in _fold_diacritics(ticker) or q in _fold_diacritics(name):
            hits.append({"ticker": ticker, "name": name, "sector": sector})
            if len(hits) >= limit:
                return hits

    # BVB seed table — include in the same response so a search hits
    # both universes in one round-trip. Tag exchange so the FE can
    # render the BVB chip (the NASDAQ path leaves exchange undefined).
    for ticker, row in _bvb_universe().items():
        name = row["companyName"]
        if q in _fold_diacritics(ticker) or q in _fold_diacritics(name):
            hits.append({
                "ticker": ticker,
                "name": name,
                "sector": row.get("sector") or "",
                "exchange": "BVB",
            })
            if len(hits) >= limit:
                return hits

    return hits


__all__ = [
    "LIVE_TTL_SECONDS",
    "clear_warm_cache",
    "get_universe",
    "is_warm",
    "search_universe",
]
