"""EIA (Energy Information Administration) commodity adapter — Phase C.

Tracks 5 standard energy + commodity series via EIA's v2 API. Same
move-vs-prior-reading + threshold approach as the FRED rates adapter,
but for the commodities the rates adapter doesn't cover (natural gas,
gasoline, heating oil, diesel) + a richer crude series.

The FRED adapter already tracks WTI for the rates surface. Here we
overlap deliberately on WTI but tag it as `commodity` (FRED tags it
`commodity` too — both fire the same risk_category at the radar
layer). Operators can disable one or the other by toggling the env.

Config:
  EIA_API_KEY — required (free at https://www.eia.gov/opendata/)

Series tracked (EIA series IDs):
  · PET.RWTC.D — WTI Crude Oil spot price ($/bbl, daily)
  · PET.RBRTE.D — Brent Crude Oil spot price ($/bbl, daily)
  · NG.RNGWHHD.D — Henry Hub Natural Gas spot price ($/MMBtu, daily)
  · PET.EMM_EPMR_PTE_NUS_DPG.W — Regular Gasoline retail price ($/gal, weekly)
  · PET.EMD_EPD2D_PTE_NUS_DPG.W — Diesel retail price ($/gal, weekly)
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

_BASE = "https://api.eia.gov/v2/seriesid"
_HTTP_TIMEOUT_SEC = 8


# (series_id, label, signal_type, threshold $-or-pct move, affected_sectors, channels)
SERIES_CONFIG: list[tuple[str, str, str, float, list[str], list[str]]] = [
    (
        "PET.RWTC.D",
        "WTI Crude Oil price",
        "commodity",
        7.50,                      # $7.50 / bbl move
        ["Energy", "Consumer Discretionary", "Industrials", "Materials"],
        ["gross_margin", "ebitda_margin"],
    ),
    (
        "PET.RBRTE.D",
        "Brent Crude Oil price",
        "commodity",
        7.50,
        ["Energy", "Consumer Discretionary", "Industrials", "Materials"],
        ["gross_margin", "ebitda_margin"],
    ),
    (
        "NG.RNGWHHD.D",
        "Henry Hub Natural Gas price",
        "commodity",
        0.50,                       # $0.50/MMBtu move
        ["Energy", "Utilities", "Materials"],
        ["gross_margin", "ebitda_margin"],
    ),
    (
        "PET.EMM_EPMR_PTE_NUS_DPG.W",
        "US Regular Gasoline retail price",
        "commodity",
        0.20,                       # $0.20/gallon move
        ["Consumer Discretionary", "Industrials"],
        ["gross_margin"],
    ),
    (
        "PET.EMD_EPD2D_PTE_NUS_DPG.W",
        "US Diesel retail price",
        "commodity",
        0.25,                       # $0.25/gallon move
        ["Industrials", "Consumer Defensive", "Materials"],
        ["gross_margin"],
    ),
]


class CommoditySignalAdapter:
    """EIA commodity series → IntelligenceSignals on material moves."""

    name = "commodity"

    def __init__(self, api_key: Optional[str] = None):
        self._api_key = api_key or os.environ.get("EIA_API_KEY")
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
                latest, prior = self._fetch_latest_two(series_id)
            except Exception as e:
                errors.append(f"{series_id}: {e.__class__.__name__}")
                continue
            if latest is None or prior is None:
                continue
            delta = latest["value"] - prior["value"]
            if abs(delta) < threshold:
                continue
            if latest["date"] < since:
                continue

            severity = _severity_from_delta(abs(delta), threshold)
            direction = "↑" if delta > 0 else "↓"
            title = (
                f"{label} {direction}{abs(delta):.2f} "
                f"(now {latest['value']:.2f}, was {prior['value']:.2f})"
            )
            summary = (
                f"EIA series {series_id} moved {delta:+.2f} between "
                f"{prior['date'].date().isoformat()} and "
                f"{latest['date'].date().isoformat()}. "
                f"Threshold for signaling: {threshold:.2f}."
            )
            sig_id = str(uuid5(
                NAMESPACE_URL,
                f"eia:{series_id}:{latest['date'].isoformat()}"
            ))
            signals.append(IntelligenceSignal(
                id=sig_id,
                signal_type=sig_type,  # type: ignore[arg-type]
                title=title,
                summary=summary,
                source=f"eia:{series_id}",
                source_url=f"https://www.eia.gov/opendata/v1/qb.php?sdid={series_id}",
                severity=severity,
                time_horizon="3m",
                confidence=0.85,
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
                reason="EIA_API_KEY not set — sign up at eia.gov/opendata and set the env var.",
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

    def _fetch_latest_two(
        self,
        series_id: str,
    ) -> tuple[Optional[dict], Optional[dict]]:
        """EIA v2 API returns observations sorted desc by `period`. Pull a
        few extra in case any are missing.

        Returns (latest, prior) where each is {date: datetime, value: float}.
        """
        params = {
            "api_key": self._api_key,
            "sort[0][column]": "period",
            "sort[0][direction]": "desc",
            "length": "10",
        }
        url = f"{_BASE}/{series_id}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "CFO-AI-Intelligence/1.0 (+https://cfo-ai.io)"},
        )
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read())

        # EIA v2 envelope: {"response": {"data": [{"period": "2026-05-27", "value": 4.50}, ...]}}
        response = payload.get("response") or {}
        rows = response.get("data") or []
        clean: list[dict] = []
        for row in rows:
            period = row.get("period")
            raw_value = row.get("value")
            if raw_value is None or period is None:
                continue
            try:
                value = float(raw_value)
            except (TypeError, ValueError):
                continue
            try:
                # EIA returns "YYYY-MM-DD" for daily/weekly series
                dt = datetime.fromisoformat(period)
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
    """Threshold-relative severity, shared shape with FRED adapter."""
    ratio = abs_delta / threshold if threshold > 0 else 0
    if ratio >= 3.5:
        return "critical"
    if ratio >= 2.0:
        return "high"
    return "medium"
