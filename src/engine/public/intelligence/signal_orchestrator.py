"""Ties IntelligenceSignals → CompanyExposureProfiles → universe-wide risk view.

Phase A workflow (no live feed):

  1. Build CompanyExposureProfile for every ticker in the universe
     (sector_model source) — done by company_exposure_service.
  2. Synthesize one IntelligenceSignal per sector × top-3-risks from the
     sector library, with affected_tickers populated from the universe.
     These "sector-model signals" populate the Macro Signals tab with
     real content even when no live feed is connected.
  3. Pass the universe-wide profile + signals to the radar aggregator
     to produce sector-level risk-radar cards.

When live adapters come online in Phase B, the synthesized sector-model
signals coexist with live signals — sources are clearly labeled so the
FE can filter / hide one or the other.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Optional
from uuid import uuid5, NAMESPACE_URL

from .models import (
    CompanyExposureProfile,
    FinancialImpactChannel,
    IntelligenceSignal,
    RiskCategory,
    Severity,
    SignalType,
    TimeHorizon,
)
from .sector_risk_library import SECTOR_RISK_LIBRARY, THEME_RISK_LIBRARY


# Mapping from sector-library channels → RiskCategory for radar grouping.
_CHANNEL_TO_CATEGORY: dict[str, RiskCategory] = {
    "supply_availability": "supply_chain",
    "inventory":           "supply_chain",
    "valuation_multiple":  "rates_credit",
    "debt_cost":           "rates_credit",
    "fx":                  "fx",
    "revenue":             "consumer_demand",
    "gross_margin":        "supply_chain",
    "ebitda_margin":       "consumer_demand",
    "capex":               "technology",
    "working_capital":     "supply_chain",
}


def synthesize_sector_signals(
    sector_filter: Optional[Iterable[str]] = None,
) -> list[IntelligenceSignal]:
    """Build IntelligenceSignals from the static sector_risk_library.

    Each sector contributes its top-3-severity risks. The synthesized signal
    has source=`sector_model` and source_label=`sector_model:<sector>` so the
    FE can clearly distinguish library-derived signals from live news.

    IDs are deterministic via uuid5 — same input produces the same UUID, so
    the cache key for "current sector-model signals" is stable across calls
    until the library itself is edited.
    """
    sectors = list(sector_filter) if sector_filter else list(SECTOR_RISK_LIBRARY.keys())

    signals: list[IntelligenceSignal] = []
    severity_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}

    for sector in sectors:
        profile = SECTOR_RISK_LIBRARY.get(sector)
        if profile is None:
            continue

        # Top 3 risks by severity for this sector.
        top_risks = sorted(profile.risks, key=lambda r: severity_rank.get(r.severity, 99))[:3]

        for risk in top_risks:
            sig_id = str(uuid5(NAMESPACE_URL, f"sector_model:{sector}:{risk.key}"))
            categories = _derive_categories(risk.channels)
            signals.append(IntelligenceSignal(
                id=sig_id,
                signal_type="supply_chain" if "supply_availability" in risk.channels
                            else "company_news",  # neutral default
                title=f"{sector}: {risk.label}",
                summary=(
                    f"Sector exposure model identifies {risk.label.lower()} "
                    f"as a {risk.severity}-severity risk for {sector}. "
                    f"This is a sector-default characterization, not a "
                    f"live event."
                ),
                source=f"sector_model:{sector}",
                severity=risk.severity,
                time_horizon="12m",
                confidence=0.55,
                published_at=datetime.now(timezone.utc),
                affected_sectors=[sector],
                affected_industries=list(risk.applies_to_industries),
                financial_impact_channels=list(risk.channels),
                risk_categories=categories,
            ))

    # Theme overlays — each theme becomes a signal too.
    for theme in THEME_RISK_LIBRARY.values():
        if sector_filter and not any(s in theme.affected_sectors for s in sectors):
            continue
        sig_id = str(uuid5(NAMESPACE_URL, f"theme:{theme.key}"))
        categories = _derive_categories(theme.channels)
        signals.append(IntelligenceSignal(
            id=sig_id,
            signal_type=("supply_chain" if "supply_availability" in theme.channels
                         else "geopolitical" if "fx" in theme.channels or "supply_availability" in theme.channels
                         else "company_news"),
            title=theme.label,
            summary=(
                f"Cross-sector theme ({theme.polarity}). Affected sectors: "
                f"{', '.join(theme.affected_sectors)}. "
                f"Strength/severity: {theme.severity_or_strength}."
            ),
            source=f"theme:{theme.key}",
            severity=theme.severity_or_strength,
            time_horizon="12m",
            confidence=0.60,
            published_at=datetime.now(timezone.utc),
            affected_sectors=list(theme.affected_sectors),
            affected_industries=list(theme.affected_industries_or_all),
            affected_tickers=list(theme.explicit_tickers),
            financial_impact_channels=list(theme.channels),
            risk_categories=categories,
        ))

    return signals


def _derive_categories(channels: list[FinancialImpactChannel]) -> list[RiskCategory]:
    """Map a risk's channels → RiskCategory(s) for radar grouping."""
    result: set[RiskCategory] = set()
    for ch in channels:
        if ch in _CHANNEL_TO_CATEGORY:
            result.add(_CHANNEL_TO_CATEGORY[ch])
    if not result:
        result.add("consumer_demand")
    return sorted(result)


def link_signal_to_universe(
    signal: IntelligenceSignal,
    profiles_by_ticker: dict[str, CompanyExposureProfile],
) -> list[str]:
    """Derive `affected_tickers` for a signal that only lists affected sectors.

    Used when ingesting a live news signal that tags sectors/themes but not
    specific tickers — we hydrate the ticker list from the universe profiles
    so the FE can show "this signal affects NVDA, AMD, TSM" without the
    operator having to type them.
    """
    if signal.affected_tickers:
        # Operator/adapter already provided explicit tickers.
        return list(signal.affected_tickers)

    tickers: list[str] = []
    for ticker, prof in profiles_by_ticker.items():
        if signal.affected_sectors and prof.sector in signal.affected_sectors:
            if signal.affected_industries and prof.industry not in signal.affected_industries:
                continue
            tickers.append(ticker)
    return tickers
