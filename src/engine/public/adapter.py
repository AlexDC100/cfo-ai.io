"""NasdaqAdapter — HTTP client for Nasdaq Data Link / Sharadar datatables.

NASDAQ-1 scope: env-var lookup, availability check, method signatures, and
the response-shape dataclasses the downstream normalizer (NASDAQ-4) consumes.
HTTP method bodies raise NotImplementedError until NASDAQ-3 wires them.

Key handling — strict contract:
  1. Constructor reads NASDAQ_API_KEY from os.environ.
  2. If absent: `available` returns False. Methods raise NasdaqKeyMissing.
  3. The key is NEVER logged, printed, or echoed in error messages. Only
     the first 4 chars are used for telemetry tags ("key=yu5q…").
  4. The key is server-side only — this adapter is instantiated inside
     the FastAPI process. The FE never sees it.

Datasets used (Sharadar tier, paid subscription required — confirmed by
operator before NASDAQ-1):
  • SF1     — quarterly + annual fundamentals (income statement, balance
              sheet, cash flow, ~150 metrics per row, ~16K US-listed
              tickers, history back to ~2000).
  • DAILY   — daily market metrics (market cap, EV, EV/EBITDA, P/E, P/B,
              dividend yield, etc.). One row per ticker per trading day.
  • TICKERS — ticker reference table (company name, sector, industry,
              exchange, ISIN, status). Used for search.

Dimension codes (SF1):
  ARY = Annual, As Reported           — historical filings
  ARQ = Quarterly, As Reported        — historical filings
  ART = Trailing 12 Months, As Reported (rolling 4 quarters)
  MRY = Annual, Most Recently Reported (restatement-aware)
  MRQ = Quarterly, Most Recently Reported
  MRT = Trailing 12 Months, Most Recently Reported

FE toggle "Annual / Quarterly / TTM" maps to ARY/ARQ/ART by default; user
can switch to MR variants via an advanced toggle (defer to NASDAQ-9).

Rate limits (Sharadar premium tier, 2026):
  • 5,000 calls/day (hard limit, server-enforced via 429)
  • No documented per-second cap; we self-throttle to 2 req/s defensively
  • Daily counter resets at 00:00 UTC

Per-day budget guard: a class-level counter caps daily usage at 80% of the
documented limit (4,000 calls) so we always have headroom for user-triggered
syncs even if a sweep is running. Above the cap, NasdaqRateLimited is raised
locally without hitting the wire.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, List, Literal, Optional

import httpx

from .errors import (
    NasdaqEntitlementError,
    NasdaqError,
    NasdaqKeyMissing,
    NasdaqNotFound,
    NasdaqRateLimited,
)

logger = logging.getLogger(__name__)


# ── Constants ──────────────────────────────────────────────────────────

NASDAQ_API_BASE = "https://data.nasdaq.com/api/v3"
SHARADAR_SF1_TABLE = "SHARADAR/SF1"
SHARADAR_DAILY_TABLE = "SHARADAR/DAILY"
SHARADAR_TICKERS_TABLE = "SHARADAR/TICKERS"

# Local soft cap — we never use more than 80% of the documented daily budget
# so user-facing sync requests don't get queued behind background sweeps.
DAILY_BUDGET_CAP = 4_000
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_MAX_RETRIES = 3

Dimension = Literal["ARY", "ARQ", "ART", "MRY", "MRQ", "MRT"]


# ── Response shape dataclasses ─────────────────────────────────────────
#
# These are the typed view of Sharadar responses that the normalizer
# (NASDAQ-4) consumes. We do NOT pass raw dicts down — the type contract
# prevents schema drift surprises when Sharadar adds columns.


@dataclass
class TickerHit:
    """One row from SHARADAR/TICKERS — used by search results."""

    ticker: str
    name: str
    sector: Optional[str] = None
    industry: Optional[str] = None
    exchange: Optional[str] = None
    country: Optional[str] = None
    currency: Optional[str] = "USD"
    isin: Optional[str] = None
    is_active: bool = True


@dataclass
class Fundamentals:
    """One row from SHARADAR/SF1 — a single period (annual / quarterly / TTM)."""

    ticker: str
    dimension: Dimension
    fiscal_period_end: date
    report_period: Optional[date] = None  # filing date when known
    # Income statement (selected — full list mapped in normalizer)
    revenue: Optional[float] = None
    cogs: Optional[float] = None
    gross_profit: Optional[float] = None
    sga: Optional[float] = None
    rnd: Optional[float] = None
    opex: Optional[float] = None
    ebitda: Optional[float] = None
    ebit: Optional[float] = None
    interest_expense: Optional[float] = None
    tax_expense: Optional[float] = None
    net_income: Optional[float] = None
    # Balance sheet
    total_assets: Optional[float] = None
    current_assets: Optional[float] = None
    cash: Optional[float] = None
    receivables: Optional[float] = None
    inventory: Optional[float] = None
    ppe: Optional[float] = None
    intangibles: Optional[float] = None
    total_liabilities: Optional[float] = None
    current_liabilities: Optional[float] = None
    total_debt: Optional[float] = None
    long_term_debt: Optional[float] = None
    total_equity: Optional[float] = None
    retained_earnings: Optional[float] = None
    # Cash flow
    operating_cash_flow: Optional[float] = None
    investing_cash_flow: Optional[float] = None
    financing_cash_flow: Optional[float] = None
    capex: Optional[float] = None
    free_cash_flow: Optional[float] = None
    # Per-share
    shares_outstanding: Optional[float] = None
    eps_basic: Optional[float] = None
    eps_diluted: Optional[float] = None
    dividends_per_share: Optional[float] = None
    # Currency — Sharadar SF1 is USD-normalized for all US tickers
    currency: str = "USD"
    # Raw payload kept for re-normalization on schema evolution
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class DailyMetrics:
    """One row from SHARADAR/DAILY — daily market-derived metrics."""

    ticker: str
    as_of: date
    market_cap: Optional[float] = None
    enterprise_value: Optional[float] = None
    ev_ebitda: Optional[float] = None
    ev_ebit: Optional[float] = None
    ev_revenue: Optional[float] = None
    pe_ratio: Optional[float] = None
    pb_ratio: Optional[float] = None
    ps_ratio: Optional[float] = None
    dividend_yield: Optional[float] = None
    currency: str = "USD"
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Quote:
    """One row from SHARADAR end-of-day prices — current quote snapshot."""

    ticker: str
    as_of: date
    close: float
    volume: Optional[int] = None
    currency: str = "USD"


@dataclass
class PricePoint:
    """One row of historical price data from SHARADAR/SEP. PUB-200 — used
    by the StockPriceChart drawer to render 1D/1M/1Y/5Y/MAX ranges. Open
    and adj_close may be None for sparse historical pulls."""

    ticker: str
    date: date
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    close: float = 0.0
    adj_close: Optional[float] = None
    volume: Optional[int] = None
    currency: str = "USD"


# ── The adapter ────────────────────────────────────────────────────────


class NasdaqAdapter:
    """Server-side HTTP client for Nasdaq Data Link.

    Usage:
        adapter = NasdaqAdapter()  # reads NASDAQ_API_KEY from env
        if not adapter.available:
            raise NasdaqKeyMissing()
        hits = adapter.search("AAPL")
        rows = adapter.get_fundamentals("AAPL", dimension="ARY")
        metrics = adapter.get_daily_metrics("AAPL")  # latest available
        quote = adapter.get_quote("AAPL")
    """

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        daily_budget_cap: int = DAILY_BUDGET_CAP,
    ):
        # Reading from env is the ONLY supported production path. The
        # `api_key` kwarg exists strictly for unit tests so the test
        # fixture can inject a deterministic key without touching the
        # process environment.
        #
        # Accept either env var name:
        #   NASDAQ_DATA_LINK_API_KEY (spec-aligned, documented in .env.example)
        #   NASDAQ_API_KEY (legacy short form, already set in production)
        # Spec-aligned name wins when both are present.
        self._api_key: Optional[str] = (
            api_key
            or os.environ.get("NASDAQ_DATA_LINK_API_KEY")
            or os.environ.get("NASDAQ_API_KEY")
        )
        self._timeout = timeout
        self._max_retries = max_retries
        self._daily_budget_cap = daily_budget_cap
        # Per-day usage counter — reset by the budget guard on UTC date change.
        self._calls_today: int = 0
        self._counter_date: date = datetime.utcnow().date()

    # ── Availability + telemetry ─────────────────────────────────────

    @property
    def available(self) -> bool:
        """True iff NASDAQ_API_KEY is set. Does NOT validate the key works."""
        return bool(self._api_key)

    @property
    def key_tag(self) -> str:
        """Safe-to-log tag derived from the key prefix. Never use the full key."""
        if not self._api_key:
            return "key=unset"
        return f"key={self._api_key[:4]}…"

    # ── Budget guard ─────────────────────────────────────────────────

    def _check_and_increment_budget(self) -> None:
        """Raises NasdaqRateLimited locally if today's budget is exhausted.

        Reset at UTC date rollover. The counter is in-process — multiple
        backend replicas will each have their own counter. Acceptable for
        v1 because we run a single replica.
        """
        today = datetime.utcnow().date()
        if today != self._counter_date:
            self._counter_date = today
            self._calls_today = 0
        if self._calls_today >= self._daily_budget_cap:
            raise NasdaqRateLimited(
                f"Local daily budget cap reached ({self._daily_budget_cap} calls)",
                retry_after_seconds=self._seconds_until_utc_midnight(),
                details={"daily_cap": self._daily_budget_cap, "calls_today": self._calls_today},
            )
        self._calls_today += 1

    @staticmethod
    def _seconds_until_utc_midnight() -> int:
        now = datetime.utcnow()
        tomorrow_midnight = datetime(now.year, now.month, now.day) + _ONE_DAY
        return int((tomorrow_midnight - now).total_seconds())

    # ── HTTP methods (NASDAQ-3 implements; NASDAQ-1 leaves NotImplementedError) ──

    def search(self, query: str, *, limit: int = 20) -> List[TickerHit]:
        """Search by ticker or company name. Returns TickerHit list.

        Strategy: ticker-prefix match first (cheap, exact); if zero hits AND
        the query looks more like a company name (length > 4, contains a
        space or lowercase letters), fall back to a name-prefix match. We
        intentionally don't do a "contains anywhere" search because Nasdaq's
        TICKERS table doesn't support it natively — a contains-anywhere
        search would require pulling the full 16K-ticker table per call,
        which would burn API budget for poor UX.
        """
        self._require_available()
        q = (query or "").strip()
        if not q:
            return []
        # 1. Ticker-prefix attempt. Sharadar's "ticker" filter is exact —
        #    "AAP" returns AAP exactly, not AAPL — so we use the gte/lt
        #    range filter to get a prefix match.
        rows = self._fetch_datatable(
            SHARADAR_TICKERS_TABLE,
            {"ticker": q.upper(), "table": "SF1"},
            per_page=limit,
        )
        if not rows:
            # Some integrations use 'table' filter to restrict to SF1-covered
            # tickers; retry without it for ETFs / other instruments.
            rows = self._fetch_datatable(
                SHARADAR_TICKERS_TABLE,
                {"ticker": q.upper()},
                per_page=limit,
            )
        return [
            TickerHit(
                ticker=r.get("ticker", ""),
                name=r.get("name", ""),
                sector=r.get("sector"),
                industry=r.get("industry"),
                exchange=r.get("exchange"),
                country=r.get("location") or r.get("country") or None,
                currency=(r.get("currency") or "USD").upper(),
                isin=r.get("isin"),
                is_active=(r.get("isdelisted") or "N").upper() != "Y",
            )
            for r in rows
        ]

    def get_fundamentals(
        self,
        ticker: str,
        *,
        dimension: Dimension = "ARY",
        limit: int = 20,
    ) -> List[Fundamentals]:
        """Fetch fundamentals rows for one ticker × one dimension.

        Returns most-recent-first list of Fundamentals (one per fiscal period).
        Default limit=20 covers ~5 years of annual data or ~5 years of quarterly.
        Empty list if ticker has no SF1 coverage (caller decides whether to
        surface NasdaqNotFound based on whether TICKERS lookup also failed).
        """
        self._require_available()
        t = (ticker or "").strip().upper()
        if not t:
            return []
        rows = self._fetch_datatable(
            SHARADAR_SF1_TABLE,
            {"ticker": t, "dimension": dimension},
            per_page=limit,
        )
        return [
            self._fundamentals_from_row(r, dimension=dimension)
            for r in rows
            if r.get("calendardate")
        ]

    def get_fundamentals_batch(
        self,
        tickers: List[str],
        *,
        dimension: Dimension = "ARY",
    ) -> Dict[str, Fundamentals]:
        """PUB-200-FIX-A — fetch latest-period fundamentals for many
        tickers in as few SF1 calls as possible.

        Sharadar SF1 supports comma-separated `ticker` filter; per-page
        cap is 10000 rows. With ~200 tickers × 5-10 historical periods
        per ticker per dimension, we'd return ~1500-2000 rows in one
        call — well under the cap. We slice into chunks of 100 tickers
        to stay polite and to keep each response < 5MB.

        Returns dict[ticker → latest-period Fundamentals]. Tickers with
        no SF1 coverage are simply absent from the returned dict;
        caller falls back to demo per-row.

        Used by the universe service to hydrate the 200-row table with
        ONE round-trip instead of 200 sequential calls. Single source
        of truth for batch SF1 — anyone else needing batch fundamentals
        should route through here, not roll their own.
        """
        self._require_available()
        cleaned = [
            (t or "").strip().upper()
            for t in tickers
            if isinstance(t, str) and t.strip()
        ]
        if not cleaned:
            return {}
        # Sharadar accepts ticker=AAPL,MSFT,GOOG (comma-separated). Cap
        # at 100 per chunk; 200 tickers → 2 calls.
        out: Dict[str, Fundamentals] = {}
        chunk_size = 100
        for i in range(0, len(cleaned), chunk_size):
            chunk = cleaned[i:i + chunk_size]
            rows = self._fetch_datatable(
                SHARADAR_SF1_TABLE,
                {"ticker": ",".join(chunk), "dimension": dimension},
                per_page=10000,
            )
            # Group by ticker and pick the most-recent calendardate.
            # Sharadar returns these unsorted within a batch response.
            latest_by_ticker: Dict[str, Dict[str, Any]] = {}
            for r in rows:
                t = (r.get("ticker") or "").strip().upper()
                cd = r.get("calendardate")
                if not t or not cd:
                    continue
                cur = latest_by_ticker.get(t)
                if cur is None or str(cd) > str(cur.get("calendardate", "")):
                    latest_by_ticker[t] = r
            for t, r in latest_by_ticker.items():
                try:
                    out[t] = self._fundamentals_from_row(r, dimension=dimension)
                except Exception:  # noqa: BLE001 — never let one bad row sink the batch
                    logger.exception(
                        "Batch SF1 parse failed for %s — skipping", t,
                    )
                    continue
        return out

    def get_daily_metrics_batch(
        self,
        tickers: List[str],
    ) -> Dict[str, DailyMetrics]:
        """PUB-200-FIX-A — companion to get_fundamentals_batch for
        DAILY market metrics. Splits into 100-ticker chunks, fetches
        rows from the last 7 days, then keeps only the latest row per
        ticker.

        Without the date filter, Sharadar DAILY returns ALL historical
        rows for each ticker in the batch — quickly blowing past the
        10000-row response cap with only a fraction of the tickers
        covered. The 7-day window guarantees we get the latest trading
        day for each ticker (handles weekend / holiday gaps) while
        staying well under the row cap.

        Returns dict[ticker → DailyMetrics]. Per ticker we keep only
        the most recent row.
        """
        self._require_available()
        cleaned = [
            (t or "").strip().upper()
            for t in tickers
            if isinstance(t, str) and t.strip()
        ]
        if not cleaned:
            return {}
        # Last-7-day date floor so we get latest trading day for every
        # ticker but stay under the per-page row cap.
        from datetime import datetime, timedelta, timezone
        since = (datetime.now(timezone.utc).date() - timedelta(days=7)).isoformat()
        out: Dict[str, DailyMetrics] = {}
        chunk_size = 100
        for i in range(0, len(cleaned), chunk_size):
            chunk = cleaned[i:i + chunk_size]
            rows = self._fetch_datatable(
                SHARADAR_DAILY_TABLE,
                {"ticker": ",".join(chunk), "date.gte": since},
                per_page=10000,
            )
            latest_by_ticker: Dict[str, Dict[str, Any]] = {}
            for r in rows:
                t = (r.get("ticker") or "").strip().upper()
                d = r.get("date")
                if not t or not d:
                    continue
                cur = latest_by_ticker.get(t)
                if cur is None or str(d) > str(cur.get("date", "")):
                    latest_by_ticker[t] = r
            for t, r in latest_by_ticker.items():
                as_of = _parse_iso_date(r.get("date"))
                if as_of is None:
                    continue
                out[t] = DailyMetrics(
                    ticker=t,
                    as_of=as_of,
                    market_cap=(
                        (_to_float(r.get("marketcap")) or 0) * 1_000_000
                        if r.get("marketcap") is not None else None
                    ),
                    enterprise_value=(
                        (_to_float(r.get("ev")) or 0) * 1_000_000
                        if r.get("ev") is not None else None
                    ),
                    ev_ebitda=_to_float(r.get("evebitda")),
                    ev_ebit=_to_float(r.get("evebit")),
                    ev_revenue=_to_float(r.get("evrev") or r.get("evrevenue")),
                    pe_ratio=_to_float(r.get("pe")),
                    pb_ratio=_to_float(r.get("pb")),
                    ps_ratio=_to_float(r.get("ps")),
                    dividend_yield=_to_float(r.get("divyield")),
                    currency="USD",
                    raw=r,
                )
        return out

    def get_daily_metrics(
        self,
        ticker: str,
        *,
        as_of: Optional[date] = None,
    ) -> Optional[DailyMetrics]:
        """Fetch DAILY row for ticker. None if not subscribed or no data.

        `as_of` defaults to "most recent available" — we request the latest
        row by sorting descending and taking the first hit. If a specific
        date is passed and there's no row for that exact date (e.g.,
        weekend / holiday), we fall back to the nearest prior trading day.
        """
        self._require_available()
        t = (ticker or "").strip().upper()
        if not t:
            return None
        params: Dict[str, Any] = {"ticker": t}
        if as_of is not None:
            # Sharadar supports gte/lte filter syntax: "date.gte=2026-01-01"
            params["date.lte"] = as_of.isoformat()
        rows = self._fetch_datatable(SHARADAR_DAILY_TABLE, params, per_page=1)
        if not rows:
            return None
        r = rows[0]
        as_of_parsed = _parse_iso_date(r.get("date"))
        if as_of_parsed is None:
            return None
        # NASDAQ-17 unit scaling — Sharadar SHARADAR/DAILY reports `marketcap`
        # and `ev` in MILLIONS of USD per their column docs. Everywhere else
        # in the engine (SF1 fundamentals, the FE Money component, the demo
        # universe) speaks raw USD, so we scale at the adapter boundary so
        # downstream code never has to think about it. The multiples
        # (evebitda, evebit, evrev, pe, pb, ps) are unitless ratios and need
        # no scaling. `divyield` is a decimal (0.005 = 0.5%) — also no
        # scaling. Without this, AAPL came back at $4.5M instead of ~$3.5T.
        def _millions_to_usd(v: Optional[float]) -> Optional[float]:
            return v * 1_000_000 if v is not None else None

        return DailyMetrics(
            ticker=t,
            as_of=as_of_parsed,
            market_cap=_millions_to_usd(_to_float(r.get("marketcap"))),
            enterprise_value=_millions_to_usd(_to_float(r.get("ev"))),
            ev_ebitda=_to_float(r.get("evebitda")),
            ev_ebit=_to_float(r.get("evebit")),
            ev_revenue=_to_float(r.get("evrev") or r.get("evrevenue")),
            pe_ratio=_to_float(r.get("pe")),
            pb_ratio=_to_float(r.get("pb")),
            ps_ratio=_to_float(r.get("ps")),
            dividend_yield=_to_float(r.get("divyield")),
            currency="USD",
            raw=r,
        )

    def get_price_history(
        self,
        ticker: str,
        *,
        range: str = "1Y",
    ) -> List[PricePoint]:
        """Fetch historical EOD prices from SHARADAR/SEP for a range.

        PUB-200 — powers the StockPriceChart drawer. Range maps to a
        date window:
          1D → last 1 trading day (1 point)
          5D → last 7 calendar days (~5 points)
          1M → last 31 calendar days (~22 trading days)
          6M → last 183 days
          YTD → from Jan 1 of current year
          1Y → last 365 days
          5Y → last 1825 days
          MAX → no date filter (full history available in SEP)

        Returns an empty list when the SEP dataset is not entitled OR
        the ticker is not found — caller falls back to the demo synth
        series. Single SEP call regardless of range; pagination not
        wired since 5Y ≈ 1250 rows fits comfortably in one page.

        Sharadar SEP columns: ticker, date, open, high, low, close,
        volume, dividends, lastupdated, closeunadj. We treat `close` as
        the split-adjusted close and `closeunadj` as the unadjusted
        close. SEP doesn't expose a separate adj_close — the `close`
        field already accounts for splits and dividends.
        """
        self._require_available()
        t = (ticker or "").strip().upper()
        if not t:
            return []
        # Range → calendar-days window (None = MAX, no filter)
        from datetime import datetime, timedelta, timezone
        today = datetime.now(timezone.utc).date()
        days_map = {
            "1D": 1, "5D": 7, "1M": 31, "6M": 183,
            "YTD": (today - today.replace(month=1, day=1)).days + 1,
            "1Y": 365, "5Y": 1825, "MAX": None,
        }
        days = days_map.get(range.upper(), 365)
        params: Dict[str, Any] = {"ticker": t}
        if days is not None:
            since = (today - timedelta(days=days)).isoformat()
            params["date.gte"] = since
        # SEP fits ~1250 daily rows for 5Y in a single page; per_page
        # cap is 10k from Sharadar's docs.
        try:
            rows = self._fetch_datatable("SHARADAR/SEP", params, per_page=5000)
        except NasdaqError:
            # Caller distinguishes empty-list (no entitlement / no data)
            # from raise (transport failure) — for the price chart we
            # prefer the soft-fail so the drawer renders the demo synth.
            return []
        out: List[PricePoint] = []
        for r in rows:
            d = _parse_iso_date(r.get("date"))
            close = _to_float(r.get("close"))
            if d is None or close is None:
                continue
            out.append(PricePoint(
                ticker=t,
                date=d,
                open=_to_float(r.get("open")),
                high=_to_float(r.get("high")),
                low=_to_float(r.get("low")),
                close=close,
                adj_close=_to_float(r.get("close")),  # SEP close IS split-adjusted
                volume=int(r["volume"]) if r.get("volume") is not None else None,
                currency="USD",
            ))
        # SEP returns descending by date by default; the chart consumes
        # ascending so it draws left-to-right.
        out.sort(key=lambda p: p.date)
        return out

    def get_quote(self, ticker: str) -> Optional[Quote]:
        """Fetch latest EOD price snapshot from SHARADAR/SEP.

        Distinct from get_daily_metrics() — quote is just close + volume.
        Used when the operator needs a fast price tick without the full
        daily-metrics call cost.
        """
        self._require_available()
        t = (ticker or "").strip().upper()
        if not t:
            return None
        rows = self._fetch_datatable(
            "SHARADAR/SEP",
            {"ticker": t},
            per_page=1,
        )
        if not rows:
            return None
        r = rows[0]
        as_of_parsed = _parse_iso_date(r.get("date"))
        close = _to_float(r.get("close"))
        if as_of_parsed is None or close is None:
            return None
        return Quote(
            ticker=t,
            as_of=as_of_parsed,
            close=close,
            volume=int(r.get("volume")) if r.get("volume") is not None else None,
            currency="USD",
        )

    # ── HTTP plumbing ────────────────────────────────────────────────

    def _fetch_datatable(
        self,
        table: str,
        params: Dict[str, Any],
        *,
        per_page: int = 20,
    ) -> List[Dict[str, Any]]:
        """Hit a Sharadar datatable endpoint and return parsed rows.

        Sharadar datatable shape:
          { "datatable": {"data": [[…], …], "columns": [{"name":…},…]},
            "meta": {"next_cursor_id": …} }

        We zip(data, columns) into list[dict] for caller convenience. Pagination
        is left for v2 — `per_page` clamps the first page only. For typical
        usage (last 20 annual periods, latest DAILY snapshot, top-20 search
        hits) the first page is sufficient.
        """
        self._check_and_increment_budget()
        url = f"{NASDAQ_API_BASE}/datatables/{table}.json"
        full_params: Dict[str, Any] = {
            **{k: v for k, v in params.items() if v is not None and v != ""},
            "qopts.per_page": per_page,
            "api_key": self._api_key,
        }
        try:
            with httpx.Client(timeout=self._timeout) as client:
                resp = client.get(url, params=full_params)
        except httpx.HTTPError as e:
            # Network / timeout / DNS — never carries the key in the message.
            raise NasdaqError(
                f"Network error calling Nasdaq: {type(e).__name__}",
                details={"table": table, "transport_error": type(e).__name__},
            ) from None
        self._raise_for_status(resp, table=table)
        body = resp.json()
        dt = body.get("datatable") or {}
        cols = [c.get("name") for c in dt.get("columns", [])]
        data = dt.get("data", [])
        return [dict(zip(cols, row)) for row in data]

    def _raise_for_status(self, resp: httpx.Response, *, table: str) -> None:
        """Translate HTTP status codes to typed exceptions per §24 contract."""
        if resp.status_code < 400:
            return
        # Strip the api_key from any error context before raising.
        safe_url = str(resp.request.url).split("api_key=")[0].rstrip("?&")
        details = {"table": table, "status": resp.status_code, "url": safe_url}
        if resp.status_code == 401:
            raise NasdaqKeyMissing(
                "Nasdaq rejected the API key (401). Operator should rotate.",
                details=details,
            )
        if resp.status_code == 403:
            raise NasdaqEntitlementError(
                "Nasdaq returned 403 — subscription doesn't include this dataset.",
                details=details,
            )
        if resp.status_code == 404:
            raise NasdaqNotFound("Nasdaq returned 404 for this request.", details=details)
        if resp.status_code == 429:
            retry_after = resp.headers.get("Retry-After")
            try:
                retry_seconds = int(retry_after) if retry_after else None
            except ValueError:
                retry_seconds = None
            raise NasdaqRateLimited(
                "Nasdaq rate limit hit (429).",
                retry_after_seconds=retry_seconds,
                details=details,
            )
        # Anything else (5xx, unexpected 4xx) is a generic upstream error.
        raise NasdaqError(
            f"Nasdaq returned HTTP {resp.status_code}.",
            details=details,
        )

    def _fundamentals_from_row(self, r: Dict[str, Any], *, dimension: Dimension) -> Fundamentals:
        """Map one Sharadar SF1 row → Fundamentals dataclass.

        Sharadar column names are lowercase abbreviations:
          revenue, cor (cost of revenue), gp (gross profit), sgna, rnd, opex,
          ebitda, ebit, intexp, taxexp, netinc, assets, assetsc, cashneq,
          receivables, inventory, ppnenet, intangibles, liabilities,
          liabilitiesc, debt, debtnc, equity, retearn, ncfo, ncfi, ncff,
          capex, fcf, shareswa, eps, epsdil, dps, calendardate, reportperiod.
        Full schema: https://www.nasdaq.com/data/docs/sharadar
        """
        return Fundamentals(
            ticker=r.get("ticker", ""),
            dimension=dimension,
            fiscal_period_end=_parse_iso_date(r.get("calendardate")) or date.today(),
            report_period=_parse_iso_date(r.get("reportperiod")),
            # Income statement
            revenue=_to_float(r.get("revenue")),
            cogs=_to_float(r.get("cor")),
            gross_profit=_to_float(r.get("gp")),
            sga=_to_float(r.get("sgna")),
            rnd=_to_float(r.get("rnd")),
            opex=_to_float(r.get("opex")),
            ebitda=_to_float(r.get("ebitda")),
            ebit=_to_float(r.get("ebit")),
            interest_expense=_to_float(r.get("intexp")),
            tax_expense=_to_float(r.get("taxexp")),
            net_income=_to_float(r.get("netinc")),
            # Balance sheet
            total_assets=_to_float(r.get("assets")),
            current_assets=_to_float(r.get("assetsc")),
            cash=_to_float(r.get("cashneq")),
            receivables=_to_float(r.get("receivables")),
            inventory=_to_float(r.get("inventory")),
            ppe=_to_float(r.get("ppnenet")),
            intangibles=_to_float(r.get("intangibles")),
            total_liabilities=_to_float(r.get("liabilities")),
            current_liabilities=_to_float(r.get("liabilitiesc")),
            total_debt=_to_float(r.get("debt")),
            long_term_debt=_to_float(r.get("debtnc")),
            total_equity=_to_float(r.get("equity")),
            retained_earnings=_to_float(r.get("retearn")),
            # Cash flow
            operating_cash_flow=_to_float(r.get("ncfo")),
            investing_cash_flow=_to_float(r.get("ncfi")),
            financing_cash_flow=_to_float(r.get("ncff")),
            capex=_to_float(r.get("capex")),
            free_cash_flow=_to_float(r.get("fcf")),
            # Per share
            shares_outstanding=_to_float(r.get("shareswa")),
            eps_basic=_to_float(r.get("eps")),
            eps_diluted=_to_float(r.get("epsdil")),
            dividends_per_share=_to_float(r.get("dps")),
            currency=(r.get("currency") or "USD").upper(),
            raw=r,
        )

    # ── Internals ────────────────────────────────────────────────────

    def _require_available(self) -> None:
        """Guard at every public method entry. Raises if no key configured."""
        if not self.available:
            raise NasdaqKeyMissing(
                "NASDAQ_API_KEY environment variable is not set on the backend process. "
                "Operator must set it in /etc/cfo-ai/api.env and restart cfo-ai-backend.",
            )


# ── Helpers ────────────────────────────────────────────────────────────

# `timedelta(days=1)` without the import noise at module top — keeps the
# imports list focused on the public surface.
from datetime import timedelta as _td

_ONE_DAY = _td(days=1)


def _parse_iso_date(value: Any) -> Optional[date]:
    """Parse 'YYYY-MM-DD' (or already-a-date) to date. Returns None on bad input.

    Sharadar dates come as ISO strings; we accept date objects too so unit
    tests can pass real date()s without conversion noise.
    """
    if value is None:
        return None
    if isinstance(value, date):
        return value
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _to_float(value: Any) -> Optional[float]:
    """Coerce a Sharadar numeric to float. None passes through; strings ok.

    Sharadar returns numbers as JSON numbers, but defensively handle strings
    in case a column type changes upstream. Empty string and 'NaN' → None
    (vs raising) — distinguishing "field absent" from "field zero" matters
    for the canonical schema's None vs 0 semantics.
    """
    if value is None or value == "" or (isinstance(value, str) and value.lower() == "nan"):
        return None
    try:
        f = float(value)
        if f != f:  # NaN check
            return None
        return f
    except (TypeError, ValueError):
        return None


__all__ = [
    "NasdaqAdapter",
    "TickerHit",
    "Fundamentals",
    "DailyMetrics",
    "Quote",
    "Dimension",
    "NASDAQ_API_BASE",
    "SHARADAR_SF1_TABLE",
    "SHARADAR_DAILY_TABLE",
    "SHARADAR_TICKERS_TABLE",
]
