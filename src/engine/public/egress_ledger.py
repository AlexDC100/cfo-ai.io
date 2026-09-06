"""Per-process DAILY ceilings on what the public surface may spend upstream.

The token buckets in ``refresh_shield`` bound a RATE per client. Two costs
on this surface are not rates and are not per client:

  · a provider's DAILY quota — newsapi.org's free tier is 100 requests a
    day, quoted in ``docs/public-intelligence-activation-runbook.md``.
    The signal feed is cached for 60 s, so a caller who keeps the feed
    cold spends one newsapi request per minute: 100 in 100 minutes, and
    the product has no news for the rest of the day. That is the whole
    quota, exhausted by ONE client inside the per-client rate budget.
  · a PAID completion — every Claude call behind ``ai-market-read`` and
    the filings extractor is money, not a rate, and the per-client
    budget of 120 cold reads a minute multiplies into 120 completions a
    minute per client if nothing below it says no.

So this module holds two ledgers, both keyed by UTC day and both
process-wide (one container = one ledger; the horizontal-scale caveat of
``public_ro.ratelimit`` applies identically — N replicas spend N ceilings):

``provider_hosts()``  one counter PER HOST of outbound HTTP calls, with a
    default below the tier wherever a tier is published. The binding one
    is newsapi.org. The others are generous and exist so the mechanism
    is uniform: every provider the feed reaches has a stated daily worst
    case rather than an unbounded one.

``completions()``     one counter for paid model calls, across BOTH paid
    paths (market read + filings), because the wallet does not care which
    route spent it.

WHAT HAPPENS AT THE CEILING is decided by the caller, not here — this
module only answers "may one more unit be spent". The adapters serve
their LAST-KNOWN signals and say so in ``/health``; the market read falls
back to the deterministic narrative with the reason in ``model_id``; the
filings extractor returns None and the sector model answers. Nothing
refuses a user; the product degrades to what it already has.

Env, read once at first use (``reset_ledgers`` re-reads, for tests):

    PUBLIC_LLM_COMPLETIONS_PER_DAY        default 300
    PUBLIC_PROVIDER_DAILY_CEILINGS        "host=n,host=n" overrides
    PUBLIC_PROVIDER_DAILY_CEILING_DEFAULT default for an unlisted host

The 300 is derived, not guessed: the served universe is 291 tickers
(203 NASDAQ + 88 BVB), the filings layer needs at most one completion
per ticker per annual 10-K, and one market read per ticker per day is
the FE's realistic maximum (its TTL is 600 s but the drawer is opened
by a person). 300 covers a full cold fill of either path once a day and
stops a loop from buying the same narrative 144 times.
"""

from __future__ import annotations

import logging
import os
import threading
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_ENV_COMPLETIONS = "PUBLIC_LLM_COMPLETIONS_PER_DAY"
_ENV_HOSTS = "PUBLIC_PROVIDER_DAILY_CEILINGS"
_ENV_HOST_DEFAULT = "PUBLIC_PROVIDER_DAILY_CEILING_DEFAULT"

DEFAULT_COMPLETIONS_PER_DAY = 300

# Per-host daily ceilings. newsapi.org is the only provider on this
# surface with a published DAILY tier (100/day, free); 80 leaves an
# operator 20 for their own diagnostics. The rest publish RATE limits
# (FRED 120/min, EIA 5000/h, GDELT 1 per 5 s, SEC EDGAR 10/s) and the
# numbers below sit far under what those allow per day while still being
# a ceiling a loop cannot push through: the feed is cached 60 s, so the
# worst case per day without a ceiling is 1440 fan-outs = 7200 FRED calls.
PROVIDER_HOST_CEILINGS: Dict[str, int] = {
    "newsapi.org": 80,
    "api.stlouisfed.org": 2000,     # FRED — 5 series per fan-out
    "api.eia.gov": 2000,            # EIA — 5 series per fan-out
    "api.gdeltproject.org": 500,    # GDELT — its own 15-min cache caps it at 96
    "www.sec.gov": 2000,            # EDGAR archive + tickers map
    "data.sec.gov": 2000,           # EDGAR submissions
}
DEFAULT_HOST_CEILING = 2000         # any host not listed (an RSS feed URL)


class DailyCeilingReached(Exception):
    """One more unit would exceed the day's ceiling. Nothing was spent."""

    def __init__(self, ledger: str, key: str, limit: int) -> None:
        super().__init__(
            "%s daily ceiling reached for %r (%d/day); nothing was sent"
            % (ledger, key, limit))
        self.ledger = ledger
        self.key = key
        self.limit = limit


def _utc_day() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class DailyCeiling:
    """A UTC-day-keyed counter table. ``allow`` reserves one unit or refuses.

    Reservation happens BEFORE the spend, and a failed spend is still
    counted — that is the conservative reading for a quota provider, which
    bills the request whether or not it succeeded.
    """

    def __init__(self, name: str, limit_for: Any) -> None:
        self.name = name
        # ``limit_for`` is either an int (one limit for every key) or a
        # callable key -> int, so one class serves both ledgers.
        self._limit_for = limit_for
        self._lock = threading.Lock()
        self._day = _utc_day()
        self._used: Dict[str, int] = {}

    def limit(self, key: str) -> int:
        if callable(self._limit_for):
            return int(self._limit_for(key))
        return int(self._limit_for)

    def _roll(self) -> None:
        day = _utc_day()
        if day != self._day:
            self._day = day
            self._used = {}

    def used(self, key: str) -> int:
        with self._lock:
            self._roll()
            return self._used.get(key, 0)

    def remaining(self, key: str) -> int:
        return max(0, self.limit(key) - self.used(key))

    def allow(self, key: str) -> bool:
        """Reserve one unit for ``key``. False (and nothing reserved) at the ceiling."""
        with self._lock:
            self._roll()
            used = self._used.get(key, 0)
            if used >= self.limit(key):
                return False
            self._used[key] = used + 1
            return True

    def reserve(self, key: str) -> None:
        """``allow`` that raises ``DailyCeilingReached`` instead of returning False."""
        if not self.allow(key):
            raise DailyCeilingReached(self.name, key, self.limit(key))

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            self._roll()
            return {
                "day_utc": self._day,
                "used": dict(sorted(self._used.items())),
                "limits": {k: self.limit(k) for k in sorted(self._used)},
            }


# ── the two process-wide ledgers ─────────────────────────────────────────

_hosts: Optional[DailyCeiling] = None
_completions: Optional[DailyCeiling] = None
_lock = threading.Lock()


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        logger.warning("[egress-ledger] %s=%r is not a number; using %d", name, raw, default)
        return default
    if value < 0:
        logger.warning("[egress-ledger] %s=%r is negative; using %d", name, raw, default)
        return default
    return value


def _host_table() -> Dict[str, int]:
    table = dict(PROVIDER_HOST_CEILINGS)
    raw = os.environ.get(_ENV_HOSTS, "")
    for item in raw.split(","):
        item = item.strip()
        if not item or "=" not in item:
            continue
        host, _, num = item.partition("=")
        try:
            table[host.strip().lower()] = max(0, int(float(num)))
        except (TypeError, ValueError):
            logger.warning("[egress-ledger] ignoring malformed ceiling %r", item)
    return table


def provider_hosts() -> DailyCeiling:
    """The per-host ledger. Keys are lowercase hostnames."""
    global _hosts
    with _lock:
        if _hosts is None:
            table = _host_table()
            default = _int_env(_ENV_HOST_DEFAULT, DEFAULT_HOST_CEILING)
            _hosts = DailyCeiling("provider-host", lambda h: table.get(h, default))
        return _hosts


def completions() -> DailyCeiling:
    """The paid-completion ledger. One key, ``"llm"``, shared by both paid paths."""
    global _completions
    with _lock:
        if _completions is None:
            _completions = DailyCeiling(
                "llm-completions", _int_env(_ENV_COMPLETIONS, DEFAULT_COMPLETIONS_PER_DAY))
        return _completions


COMPLETIONS_KEY = "llm"


def reserve_completion(kind: str) -> None:
    """Spend one paid completion or raise. ``kind`` is for the log only."""
    ledger = completions()
    if not ledger.allow(COMPLETIONS_KEY):
        logger.warning("[egress-ledger] completion REFUSED for %s: ceiling %d/day reached",
                       kind, ledger.limit(COMPLETIONS_KEY))
        raise DailyCeilingReached(ledger.name, kind, ledger.limit(COMPLETIONS_KEY))


def completions_remaining() -> int:
    return completions().remaining(COMPLETIONS_KEY)


def reset_ledgers() -> None:
    """Drop both ledgers so the next use re-reads env (tests)."""
    global _hosts, _completions
    with _lock:
        _hosts = None
        _completions = None


def snapshot() -> Dict[str, Any]:
    """Operator view for ``/api/public/intelligence/health``. In-process only."""
    c = completions()
    return {
        "scope": "container-local",
        "completions": {
            "used_today": c.used(COMPLETIONS_KEY),
            "limit_per_day": c.limit(COMPLETIONS_KEY),
        },
        "provider_hosts": provider_hosts().snapshot(),
    }


# ── the one transport wrapper every ceiling-bound urllib call goes through ─

def _host_of(req: Any) -> str:
    url = getattr(req, "full_url", None) or str(req)
    return url.split("//", 1)[-1].split("/", 1)[0].split("?", 1)[0].split("@")[-1].lower()


def open_with_ceiling(req: Any, *, timeout: Optional[float] = None) -> Any:
    """``urllib.request.urlopen`` behind the per-host daily ledger.

    Reserves one unit for the request's host FIRST, then opens. Raises
    ``DailyCeilingReached`` — and sends nothing — at the ceiling. Looks
    ``urlopen`` up on the module at call time on purpose, so a test that
    patches ``urllib.request.urlopen`` by name still intercepts it.
    """
    provider_hosts().reserve(_host_of(req))
    return urllib.request.urlopen(req, timeout=timeout)


__all__ = [
    "COMPLETIONS_KEY",
    "DEFAULT_COMPLETIONS_PER_DAY",
    "DEFAULT_HOST_CEILING",
    "DailyCeiling",
    "DailyCeilingReached",
    "PROVIDER_HOST_CEILINGS",
    "completions",
    "completions_remaining",
    "open_with_ceiling",
    "provider_hosts",
    "reserve_completion",
    "reset_ledgers",
    "snapshot",
]
