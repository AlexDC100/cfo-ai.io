"""EDGAR-driven cache freshness loop — Phase D.2.

Polls SEC EDGAR's `getcurrent` Atom feed every 15 minutes (operator-
driven cron, see routes.py), finds 10-K filings posted since the last
poll, and invalidates the cached filings profile for any affected
ticker we have in cache.

Why not in-process scheduler:
  Multi-container deploys would multiply EDGAR load by N pods. Exposing
  the refresh as a POST endpoint lets the operator orchestrate a single
  call from their existing cron/k8s CronJob layer. One source of truth
  for the schedule.

Cadence (operator-controlled, recommendation):
  · 15 min — sweet spot. EDGAR's recent-filings feed updates ~10 min
    cycle during business hours. 15 min cron gives us "always latest"
    without saturating.
  · Don't poll faster than 10 min (waste; same payload).
  · Don't poll slower than 30 min (defeats the purpose of freshness).

What we DON'T do:
  · Subscribe to filings for tickers OUTSIDE our 200-universe — those
    cache lookups would always miss anyway. Filter against
    DEFAULT_UNIVERSE before invalidating.
  · Pre-warm the cache by extracting the new 10-K immediately on
    invalidation. The next user request triggers extraction lazily.
    Pre-warming would multiply EDGAR + Claude load every time SEC
    publishes a batch of filings (after-hours dumps can be 50+ at
    once); lazy extraction smooths the load.
"""

from __future__ import annotations

import logging
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional

from ..universe import DEFAULT_UNIVERSE
from . import filings_cache

logger = logging.getLogger(__name__)


# Per SEC fair-access policy — must identify the requester. Mirrors
# the User-Agent in filings_extractor.py so EDGAR sees one consistent
# identity across our two callsites.
_EDGAR_USER_AGENT = (
    "CFO-AI-Intelligence research@cfo-ai.io "
    "(https://cfo-ai.io)"
)

# `getcurrent` returns the 40 most recent filings by default. Set
# `count=100` so a 15-min cadence with many concurrent 10-K filings
# (typical at close-of-quarter) doesn't miss entries between polls.
_EDGAR_FEED_URL = (
    "https://www.sec.gov/cgi-bin/browse-edgar"
    "?action=getcurrent&type=10-K&company=&dateb=&owner=include"
    "&count=100&output=atom"
)

_HTTP_TIMEOUT_SEC = 15


@dataclass
class RefreshResult:
    """Outcome of one refresh-loop tick. Surfaced via the API response."""
    fetched_filing_count: int
    universe_matches: int
    invalidated: list[str]
    skipped_not_in_universe: int
    last_polled_at: datetime
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "fetched_filing_count": self.fetched_filing_count,
            "universe_matches": self.universe_matches,
            "invalidated": list(self.invalidated),
            "invalidated_count": len(self.invalidated),
            "skipped_not_in_universe": self.skipped_not_in_universe,
            "last_polled_at": self.last_polled_at.isoformat(),
            "error": self.error,
        }


def run_refresh() -> RefreshResult:
    """One refresh tick. Fetches the feed, invalidates matched tickers.

    Idempotent and side-effect-bounded — only writes to the cache
    (invalidations). Safe to call from cron, manual probes, or tests.
    """
    universe_tickers = {t.upper() for t, _, _ in DEFAULT_UNIVERSE}
    polled_at = datetime.now(timezone.utc)

    try:
        entries = _fetch_recent_10k_filings()
    except Exception as e:
        logger.warning("filings_refresh: feed fetch failed: %s", e)
        return RefreshResult(
            fetched_filing_count=0,
            universe_matches=0,
            invalidated=[],
            skipped_not_in_universe=0,
            last_polled_at=polled_at,
            error=f"feed fetch failed: {e.__class__.__name__}",
        )

    matched: list[str] = []
    skipped = 0
    invalidated: list[str] = []
    for entry in entries:
        ticker = entry.get("ticker", "").upper()
        if not ticker:
            continue
        if ticker not in universe_tickers:
            skipped += 1
            continue
        matched.append(ticker)
        # Only invalidate if we actually had something cached. invalidate()
        # returns False when both layers are empty for the ticker.
        if filings_cache.invalidate(ticker):
            invalidated.append(ticker)

    return RefreshResult(
        fetched_filing_count=len(entries),
        universe_matches=len(matched),
        invalidated=invalidated,
        skipped_not_in_universe=skipped,
        last_polled_at=polled_at,
        error=None,
    )


# ─────────────────────────────────────────────────────────────────────────
# EDGAR Atom feed parsing
# ─────────────────────────────────────────────────────────────────────────

def _fetch_recent_10k_filings() -> list[dict]:
    """Return [{ticker, accession, title, updated_at}, ...] from the feed."""
    req = urllib.request.Request(
        _EDGAR_FEED_URL,
        headers={
            "User-Agent": _EDGAR_USER_AGENT,
            "Accept": "application/atom+xml, application/xml",
        },
    )
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
        raw = resp.read()
    return _parse_atom(raw)


def _parse_atom(raw: bytes) -> list[dict]:
    """Parse the getcurrent Atom feed into a list of filing dicts.

    The feed has entries like:
      <entry>
        <title>10-K - Apple Inc. (0000320193) (Filer)</title>
        <link href="https://www.sec.gov/Archives/edgar/data/320193/..." />
        <updated>2026-05-27T10:00:00-04:00</updated>
      </entry>

    We extract the ticker (or fall back to CIK→ticker name match), the
    accession number from the link, and the updated_at timestamp.
    """
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        logger.warning("filings_refresh: Atom parse error: %s", e)
        return []

    # Build a quick name → ticker lookup for fallback when the entry
    # title doesn't carry a ticker directly. Trade-off: O(N) lookup per
    # entry, but N=200 so it's fine.
    name_to_ticker = {
        _normalize_company_name(name): ticker
        for ticker, name, _ in DEFAULT_UNIVERSE
    }

    out: list[dict] = []
    for entry in _find_all_local(root, "entry"):
        title = (_local_text(entry, "title") or "").strip()
        link_href = ""
        for link_el in _find_all_local(entry, "link"):
            href = link_el.get("href")
            if href:
                link_href = href
                break
        updated_raw = _local_text(entry, "updated") or _local_text(entry, "published")

        # Try ticker extraction from title — EDGAR sometimes formats
        # entries as "10-K - Apple Inc. (AAPL) (Filer)" with ticker in
        # parens; sometimes as "(0000320193)" (CIK). Cover both.
        ticker = _extract_ticker(title, name_to_ticker)
        if not ticker:
            continue

        accession = _extract_accession_from_link(link_href)
        out.append({
            "ticker": ticker,
            "accession": accession,
            "title": title,
            "updated_at": _parse_date(updated_raw),
        })
    return out


def _extract_ticker(title: str, name_to_ticker: dict[str, str]) -> Optional[str]:
    """Pull a ticker out of an EDGAR entry title.

    Strategy:
      1. If title has an explicit (TICKER) in parens (3-5 caps), take it.
      2. Otherwise normalize the company name in title and look up.
    """
    # 1. Explicit ticker in parens
    ticker_match = re.search(r"\(([A-Z]{1,5})\)\s*\(?(Filer|Reporting)?", title)
    if ticker_match:
        return ticker_match.group(1)

    # 2. Name lookup — extract the company name from "10-K - {name} (...)"
    name_match = re.match(r"\s*10-K\s*-\s*([^(]+)", title)
    if name_match:
        normalized = _normalize_company_name(name_match.group(1).strip())
        if normalized in name_to_ticker:
            return name_to_ticker[normalized]
    return None


def _normalize_company_name(name: str) -> str:
    """Lowercase + strip common corporate suffixes for fuzzy name match.

    Matches the suffix-stripping the RSS adapter uses so EDGAR's
    "Apple Inc." aligns with universe.py's "Apple Inc." regardless of
    which side has the suffix.
    """
    n = name.lower().strip()
    n = re.sub(
        r"\s*(,?\s*)?(inc\.?|incorporated|corp\.?|corporation|company|co\.?|"
        r"ltd\.?|limited|plc|llc|holdings|group|n\.?v\.?)\s*$",
        "",
        n,
    )
    return n.strip()


def _extract_accession_from_link(link: str) -> Optional[str]:
    """Pull the 18-digit accession from an EDGAR filing URL.

    URL shape: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany
    &CIK=0000320193&type=10-K&dateb=&owner=include&count=40&action=getcompany
    OR the per-filing index URL:
    https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/0000320193-23-000106-index.htm
    """
    m = re.search(r"(\d{10}-\d{2}-\d{6})", link)
    return m.group(1) if m else None


# ─────────────────────────────────────────────────────────────────────────
# XML helpers (namespace-tolerant)
# ─────────────────────────────────────────────────────────────────────────

def _strip_ns(tag: str) -> str:
    return tag.split("}", 1)[1] if tag.startswith("{") else tag


def _find_all_local(el, local_name: str) -> list:
    return [c for c in el.iter() if _strip_ns(c.tag) == local_name]


def _local_text(el, local_name: str) -> Optional[str]:
    for c in el.iter():
        if _strip_ns(c.tag) == local_name and c.text:
            return c.text
    return None


def _parse_date(raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw)
        if dt is None:
            return None
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError, IndexError):
        pass
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        return datetime.fromisoformat(raw)
    except ValueError:
        return None
