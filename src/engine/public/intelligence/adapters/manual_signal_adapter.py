"""Operator-uploaded signals. The one adapter that's always configured.

When an analyst wants to track a specific event (e.g. "Red Sea container
hijacking — December"), they POST to /api/public/intelligence/signals/manual.
The route hands the payload to this adapter, which validates + persists
into intelligence_signals (Supabase).

This is the Phase A feed source for the Macro Signals tab. Phase B adds
news + RSS + commodity adapters; until those land, manual is the only
live source.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from ..models import (
    FinancialImpactChannel,
    IntelligenceSignal,
    RiskCategory,
    Severity,
    SignalType,
    TimeHorizon,
)
from .base import AdapterHealth, SignalAdapter, as_utc, is_before


class ManualSignalAdapter:
    """Adapter for operator-curated signals stored in Supabase.

    `db` is a callable returning a Supabase admin client (matches the
    pattern used elsewhere in the codebase — see scripts/_pgrst_visibility.py
    and src/engine/public/cache.py). At Phase A we don't pass a real DB
    handle from routes yet because we use in-memory storage for the first
    cut; the route layer overrides this with a Supabase-backed implementation
    once schema_phase_intelligence_engine.sql is applied.
    """

    name = "manual"
    configured = True  # Always — the operator can always paste signals.

    def __init__(self, db: Optional[Any] = None):
        self._db = db
        self._memory: list[IntelligenceSignal] = []
        self._last_fetch_at: Optional[datetime] = None
        self._last_fetch_count = 0
        self._last_error: Optional[str] = None

    # ─── Reads ──────────────────────────────────────────────────────────

    def fetch_recent_signals(self, since: datetime) -> list[IntelligenceSignal]:
        """Return signals with published_at >= since.

        THIS ADAPTER IS WHY THE CLOCK FIX IS NOT A ONE-LINER. Making
        ``MacroSignalService``'s cutoff tz-aware without touching here
        would have made every comparison below raise — and the broad
        ``except`` on this method would have turned that into an EMPTY
        LIST rather than a 500. MEASURED before the fix: one operator
        signal, an aware cutoff, result ``[]`` and
        ``_last_error='can't compare offset-naive and offset-aware
        datetimes'``. Every operator-uploaded signal would have silently
        vanished from the radar, from macro-signals and from every
        per-ticker score, and the 500 that used to advertise the bug
        would have stopped advertising it. Trading a loud failure for a
        silent wrong answer is strictly worse.

        The ``datetime.min`` sentinel is aware for the same reason: it is
        one side of this comparison. An UNDATED manual signal is still
        EXCLUDED, exactly as before — the news adapter deliberately
        includes its undated items and this one deliberately does not.
        """
        try:
            if self._db is None:
                # In-memory fallback used by tests + when DB isn't wired.
                _UNDATED = datetime.min.replace(tzinfo=timezone.utc)
                result = [
                    s for s in self._memory
                    if not is_before(s.published_at or _UNDATED, since)
                ]
            else:
                result = self._fetch_from_db(since)
            self._last_fetch_at = datetime.now(timezone.utc)
            self._last_fetch_count = len(result)
            self._last_error = None
            return result
        except Exception as e:
            self._last_error = str(e)
            return []

    def _fetch_from_db(self, since: datetime) -> list[IntelligenceSignal]:
        """Fetch from Supabase intelligence_signals table.

        Phase A leaves the DB wiring as a TODO so the route layer can ship
        without a Supabase migration on the critical path. Tests + Phase-A
        usage rely on the in-memory store.
        """
        # TODO(Phase A.5): wire real Supabase read once schema migration ships.
        return []

    # ─── Writes ─────────────────────────────────────────────────────────

    def create_signal(
        self,
        *,
        signal_type: SignalType,
        title: str,
        summary: str,
        severity: Severity,
        time_horizon: TimeHorizon,
        affected_sectors: list[str],
        affected_industries: Optional[list[str]] = None,
        affected_companies: Optional[list[str]] = None,
        affected_tickers: Optional[list[str]] = None,
        geography: Optional[list[str]] = None,
        financial_impact_channels: Optional[list[FinancialImpactChannel]] = None,
        risk_categories: Optional[list[RiskCategory]] = None,
        confidence: float = 0.7,
        source_label: str = "manual:operator",
        source_url: Optional[str] = None,
        published_at: Optional[datetime] = None,
    ) -> IntelligenceSignal:
        signal = IntelligenceSignal(
            id=str(uuid4()),
            signal_type=signal_type,
            title=title,
            summary=summary,
            source=source_label,
            source_url=source_url,
            severity=severity,
            time_horizon=time_horizon,
            confidence=max(0.0, min(1.0, confidence)),
            # tz-AWARE, and a caller-supplied naive stamp is coerced. Every
            # other adapter on this feed already emits aware timestamps;
            # this one emitted naive, so an operator signal was the odd
            # value out in the one list they are all merged into.
            published_at=as_utc(published_at) or datetime.now(timezone.utc),
            affected_sectors=list(affected_sectors),
            affected_industries=list(affected_industries or []),
            affected_companies=list(affected_companies or []),
            affected_tickers=[t.upper() for t in (affected_tickers or [])],
            geography=list(geography or []),
            financial_impact_channels=list(financial_impact_channels or []),
            risk_categories=list(risk_categories or []),
        )
        self._memory.append(signal)
        # TODO(Phase A.5): persist to Supabase when DB is wired.
        return signal

    # ─── Health ─────────────────────────────────────────────────────────

    def health(self) -> AdapterHealth:
        return AdapterHealth(
            name=self.name,
            configured=True,
            reason="",
            last_fetch_at=self._last_fetch_at,
            last_fetch_count=self._last_fetch_count,
            last_error=self._last_error,
            extras={"in_memory_count": str(len(self._memory))},
        )
