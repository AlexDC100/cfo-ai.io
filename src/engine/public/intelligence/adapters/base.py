"""SignalAdapter Protocol — the contract every signal source implements.

Each adapter answers:
  · `configured` — does this provider have what it needs (env vars, etc.)?
  · `fetch_recent_signals(since)` — produce zero+ IntelligenceSignals
  · `health()` — diagnostic info for the /api/public/intelligence/health route

When `configured == False`, the adapter MUST return an empty list from
`fetch_recent_signals`. The routes surface the configured=False state
explicitly so the FE shows "Live signal feed not connected" instead of
silently rendering an empty feed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol, runtime_checkable

from ..models import IntelligenceSignal


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
