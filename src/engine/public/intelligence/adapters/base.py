"""SignalAdapter Protocol — the contract every signal source implements.

Each adapter answers:
  · `configured` — does this provider have what it needs (env vars, etc.)?
  · `fetch_recent_signals(since)` — produce zero+ IntelligenceSignals
  · `health()` — diagnostic info for the /api/public/intelligence/health route

When `configured == False`, the adapter MUST return an empty list from
`fetch_recent_signals`. The routes surface the configured=False state
explicitly so the FE shows "Live signal feed not connected" instead of
silently rendering an empty feed.

THE `since` BOUNDARY IS TIMEZONE-AWARE UTC — and the adapters do not
trust that
=======================================================================
``MacroSignalService.fetch_all`` built its default cutoff with
``datetime.utcnow()``, which is NAIVE, and handed it to five adapters
that every one of them parse provider timestamps into tz-AWARE UTC.
Python refuses to order a naive against an aware datetime, so the very
first item any live provider returned raised

    TypeError: can't compare offset-naive and offset-aware datetimes

out of an unguarded comparison, and the four signal routes answered 500.
MEASURED at the transport layer with successful canned provider bodies,
anonymous, against the real ``create_app()``: with ANY ONE of
``RSS_FEED_URLS`` / ``NEWS_API_KEY`` / ``EIA_API_KEY`` / ``FRED_API_KEY``
/ ``GDELT_ENABLED`` set alone, all four of

    GET /api/public/intelligence/macro-signals
    GET /api/public/intelligence/companies/{ticker}/signals
    GET /api/public/intelligence/companies/{ticker}/risk-score
    GET /api/public/intelligence/companies/{ticker}/ai-market-read

returned 500, forever, at a repeat cost of one outbound call each.

An earlier map reported NEWS_API_KEY and GDELT_ENABLED as 200. They are
not: those two adapters skip the comparison when an article carries no
usable timestamp, so a generic canned body exercised the parse and never
the compare. With a body that DOES carry ``publishedAt`` / ``seendate``
they raise identically — proven at unit level, independently of any
harness.

The rule, so this cannot come back:

  · ``since`` is ALWAYS timezone-aware UTC. ``MacroSignalService`` is the
    one clock and coerces anything a caller hands it.
  · Adapters STILL do not compare raw. Providers are not trustworthy
    about ``tzinfo``, so every ordering goes through ``is_before`` below,
    which coerces both sides and therefore cannot raise. Until
    2026-09-04 this package's OWN RSS parser was the standing proof:
    ``_parse_date_safe`` stamped UTC on an RFC-2822 ``pubDate`` and
    returned a bare naive ``fromisoformat`` for an ISO one, so a single
    feed handed one loop both kinds. That producer now stamps UTC on
    every branch — but the coercion here stays, because it defends the
    NEXT provider rather than that one.

AND THE STAMP ITSELF IS NORMALISED WHERE IT ENTERS THE MODEL
=============================================================
Coercing at the comparisons was necessary and not sufficient. It kept
each adapter's own ``since`` filter from raising, and left the naive
value free to travel into the merged, CACHED feed — where
``routes.macro_signals`` orders all six adapters' signals in one list and
raised the identical ``TypeError`` at ``all_signals.sort``, 500 for the
whole feed TTL. ``IntelligenceSignal.__post_init__`` now coerces
``published_at`` through ``as_utc`` at construction, so the invariant is
"a signal carrying a timestamp carries an aware one" rather than "every
reader remembers to coerce". ``as_utc`` moved to ``..models`` for that
reason and is re-exported below.

``is_before`` is a TOTAL comparison, not a swallowed one. There is no
``except`` anywhere on this path: a broad try would have hidden the
original defect just as well as it would hide the next one, and it would
have dropped real signals to do it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Protocol, runtime_checkable

from ..models import IntelligenceSignal, as_utc

# ``as_utc`` MOVED to ``..models`` and is re-exported here unchanged.
#
# It was defined in this module while the invariant it protects belongs to
# the MODEL: ``IntelligenceSignal.published_at`` is aware-or-None, enforced
# in ``__post_init__``, and a model cannot import its own readers without a
# cycle. Every ``from .base import as_utc`` and ``from ..base import
# as_utc`` in this package keeps working, and there is still exactly ONE
# implementation — see ``models.as_utc`` for the UTC-reading rationale and
# the ABSENT != ZERO rule for the undated case.
#
# Re-exported explicitly rather than by accident: this name is part of the
# adapter-facing surface and a bare re-import reads like a leftover.
__all__ = ["as_utc", "is_before", "AdapterHealth", "SignalAdapter"]


def is_before(dt: datetime, since: datetime) -> bool:
    """True iff ``dt`` is strictly older than ``since``. Never raises.

    Both sides are coerced through ``as_utc`` first, so a naive/aware mix
    — in EITHER direction — orders correctly instead of raising. That
    matters in both directions and not just the one that broke: a
    provider may hand back naive (bare-ISO RSS ``pubDate``) while the
    cutoff is aware, and a direct caller of an adapter may still hand a
    naive cutoff to an aware provider stamp.

    ``dt`` is required to be non-None. The undated case is NOT decided
    here — see ``as_utc``.
    """
    return as_utc(dt) < as_utc(since)  # type: ignore[operator]


@dataclass(frozen=True)
class AdapterHealth:
    """Diagnostic record per adapter — surfaced by the health endpoint."""
    name: str
    configured: bool
    reason: str = ""                  # human-readable why-not when configured=False
    last_fetch_at: datetime | None = None
    last_fetch_count: int = 0
    last_error: str | None = None
    extras: dict[str, str] = field(default_factory=dict)


@runtime_checkable
class SignalAdapter(Protocol):
    """The Protocol every adapter implements. Duck-typed; no inheritance
    required. Use `isinstance(obj, SignalAdapter)` to check conformance at
    runtime (works because @runtime_checkable)."""

    name: str
    configured: bool

    def fetch_recent_signals(self, since: datetime) -> list[IntelligenceSignal]:
        """Return signals published since `since`. Empty list when no signals
        available — including the not-configured case."""
        ...

    def health(self) -> AdapterHealth:
        """Return a snapshot of adapter state."""
        ...
