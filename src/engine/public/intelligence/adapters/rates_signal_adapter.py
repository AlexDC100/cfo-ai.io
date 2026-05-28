"""FRED (Federal Reserve Economic Data) rates + macro adapter — Phase B.

Pulls 5 standard macro series, detects material moves vs prior reading,
and emits IntelligenceSignals when a move crosses a threshold. The
adapter is poll-on-demand; FRED publishes most series daily/weekly so
the intelligence_cache's 5-min radar TTL gives plenty of margin.

Config:
  FRED_API_KEY — required (free at https://fred.stlouisfed.org/)

Series tracked (FRED IDs):
  · DGS10  — 10-Year Treasury yield
  · DGS2   — 2-Year Treasury yield
  · DFF    — Federal Funds Effective Rate
  · DEXUSEU — USD/EUR FX rate
  · DCOILWTICO — WTI crude oil spot price

Each series → optional signal. We emit only when |Δ| since prior reading
crosses the per-series threshold so the radar doesn't fill with noise.

Affected-ticker tagging strategy:
  · DGS10 / DGS2 / DFF: rates moves affect Real Estate + Utilities +
    high-multiple Technology. Sector mapping handled in the signal_type
    → risk_category aggregation downstream.
  · DEXUSEU: affects FX-heavy sectors (Consumer Defensive + Healthcare).
  · DCOILWTICO: hits Energy producers + raw-material consumers
    (Consumer Discretionary, Industrials, Consumer Defensive).
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid5, NAMESPACE_URL

from ..models import IntelligenceSignal
from .base import AdapterHealth, SignalAdapter

logger = logging.getLogger(__name__)

_BASE = "https://api.stlouisfed.org/fred"
_HTTP_TIMEOUT_SEC = 8


# (FRED series ID, label, signal_type, threshold for material move,
#  affected_sectors when moving, financial_impact_channels)
SERIES_CONFIG: list[tuple[str, str, str, float, list[str], list[str]]] = [
    (
        "DGS10",
        "10-Year Treasury yield",
        "interest_rates",
        0.25,                       # 25bp move triggers signal
        ["Real Estate", "Utilities", "Technology", "Financials"],
        ["debt_cost", "valuation_multiple"],
    ),
    (
        "DGS2",
        "2-Year Treasury yield",
        "interest_rates",
        0.30,
        ["Financials", "Real Estate"],
        ["debt_cost"],
    ),
    (
        "DFF",
        "Fed Funds Rate",
        "interest_rates",
        0.20,
        ["Financials", "Real Estate", "Consumer Discretionary"],
        ["debt_cost", "valuation_multiple"],
    ),
    (
        "DEXUSEU",
        "USD/EUR FX rate",
        "fx",
        0.03,                       # 3% move triggers signal
        ["Consumer Defensive", "Healthcare", "Industrials"],
        ["fx", "revenue"],
    ),
    (
        "DCOILWTICO",
        "WTI Crude Oil price",
        "commodity",
        7.50,                       # $7.50 / bbl
        ["Energy", "Consumer Discretionary", "Industrials", "Materials"],
        ["gross_margin", "ebitda_margin"],
    ),
]


class RatesSignalAdapter:
    """FRED rates + macro signal source."""

    name = "rates"

    def __init__(self, api_key: Optional[str] = None):
        self._api_key = api_key or os.environ.get("FRED_API_KEY")
        self._configured = bool(self._api_key)
        self._last_fetch_at: Optional[datetime] = None
        self._last_fetch_count = 0
        self._last_error: Optional[str] = None

    @property
    def configured(self) -> bool:
        return self._configured

    def fetch_recent_signals(self, since: datetime) -> list[IntelligenceSignal]:
        if not self._configured:
            return []
        signals: list[IntelligenceSignal] = []
        errors: list[str] = []
        for series_id, label, sig_type, threshold, sectors, channels in SERIES_CONFIG:
            try:
                latest, prior = self._fetch_latest_two_observations(series_id)
            except Exception as e:
                errors.append(f"{series_id}: {e.__class__.__name__}")
                continue
            if latest is None or prior is None:
                continue
            delta = latest["value"] - prior["value"]
            if abs(delta) < threshold:
                continue
            # Skip if the latest observation is older than `since`.
            if latest["date"] < since:
                continue
            severity = _severity_from_delta(abs(delta), threshold)
            direction = "↑" if delta > 0 else "↓"
            title = (
                f"{label} {direction}{abs(delta):.2f} "
                f"(now {latest['value']:.2f}, was {prior['value']:.2f})"
            )
            summary = (
                f"FRED series {series_id} moved {delta:+.2f} between "
                f"{prior['date'].date().isoformat()} and "
                f"{latest['date'].date().isoformat()}. "
                f"Threshold for signaling: {threshold:.2f}."
            )
            sig_id = str(uuid5(NAMESPACE_URL, f"fred:{series_id}:{latest['date'].isoformat()}"))
            signals.append(IntelligenceSignal(
                id=sig_id,
                signal_type=sig_type,  # type: ignore[arg-type]
                title=title,
                summary=summary,
                source=f"fred:{series_id}",
                source_url=f"https://fred.stlouisfed.org/series/{series_id}",
                severity=severity,
                time_horizon="3m",
                confidence=0.85,        # FRED is canonical macro data
                published_at=latest["date"],
                affected_sectors=list(sectors),
                financial_impact_channels=list(channels),  # type: ignore[arg-type]
                risk_categories=[],
            ))

        self._last_fetch_at = datetime.utcnow()
        self._last_fetch_count = len(signals)
        self._last_error = "; ".join(errors) if errors else None
        return signals

    def health(self) -> AdapterHealth:
        if not self._configured:
            return AdapterHealth(
                name=self.name,
                configured=False,
                reason="FRED_API_KEY not set — sign up at fred.stlouisfed.org and set the env var.",
            )
        return AdapterHealth(
            name=self.name,
            configured=True,
            reason="",
            last_fetch_at=self._last_fetch_at,
            last_fetch_count=self._last_fetch_count,
            last_error=self._last_error,
            extras={"series_tracked": str(len(SERIES_CONFIG))},
        )

    # ─── Internals ──────────────────────────────────────────────────────

    def _fetch_latest_two_observations(
        self,
        series_id: str,
    ) -> tuple[Optional[dict], Optional[dict]]:
        """Pull the two most recent NON-MISSING observations for series_id.

        Returns (latest, prior) where each is {date: datetime, value: float},
        or (None, None) on failure.
        """
        params = {
            "series_id": series_id,
            "api_key": self._api_key,
            "file_type": "json",
            "sort_order": "desc",
            "limit": 20,        # Some series have "." (missing) — pull a few extra
        }
        url = f"{_BASE}/series/observations?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "CFO-AI-Intelligence/1.0 (+https://cfo-ai.io)"},
        )
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read())
        observations = payload.get("observations", [])
        # Filter out missing values (FRED uses "." for unavailable)
        clean: list[dict] = []
        for obs in observations:
            raw_value = obs.get("value")
            if raw_value is None or raw_value == "." or raw_value == "":
                continue
            try:
                value = float(raw_value)
            except ValueError:
                continue
            date_str = obs.get("date")
            if not date_str:
                continue
            try:
                dt = datetime.fromisoformat(date_str)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            clean.append({"date": dt, "value": value})
            if len(clean) >= 2:
                break
        if len(clean) < 2:
            return (None, None)
        return (clean[0], clean[1])


def _severity_from_delta(abs_delta: float, threshold: float) -> str:
    """Map move magnitude → severity.

    < 1.0x threshold → no signal (filtered above)
    1.0x–2.0x       → medium
    2.0x–3.5x       → high
    > 3.5x          → critical
    """
    ratio = abs_delta / threshold if threshold > 0 else 0
    if ratio >= 3.5:
        return "critical"
    if ratio >= 2.0:
        return "high"
    return "medium"
