"""Resolve a ticker → CompanyExposureProfile.

Resolution order (cheapest first, per design plan §25.5):
  1. Manual override   — operator-uploaded row in company_exposure_profiles.source = "manual"
  2. Filings-derived   — Phase C; not active yet
  3. Sector model      — Phase A default; built from sector_risk_library
  4. AI-inferred       — Phase C; not active yet

Phase A always returns source = "sector_model" (unless a manual override
exists). The FE shows a "Sector-derived exposure" badge so users never
mistake inferred exposure for verified company-specific data.

This module is pure-Python — no FastAPI, no DB session passed in. The DB
lookup for manual overrides is delegated to macro_signal_service (which
owns Supabase access). At Phase A we don't actually hit the DB here
because manual overrides aren't a Phase-A feature; we accept the
optional `manual_overrides` argument so the route layer can pass any
pre-fetched overrides without this module needing a DB handle.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from .models import (
    CompanyExposureProfile,
    ExposureSource,
    OpportunityRef,
    RiskRef,
)
from .sector_risk_library import (
    THEME_RISK_LIBRARY,
    opportunities_for_company,
    risks_for_company,
    themes_for_ticker,
    SECTOR_RISK_LIBRARY,
)


# Confidence band for sector_model: 0.55 default. We're not pretending to
# know company-specific risk; we're saying "this is the sector default."
# When filings/manual sources take over, this lifts to 0.85+.
SECTOR_MODEL_CONFIDENCE = 0.55


def build_company_exposure_profile(
    ticker: str,
    company_name: str,
    sector: str,
    industry: Optional[str],
    manual_overrides: Optional[CompanyExposureProfile] = None,
    try_filings: bool = True,
) -> CompanyExposureProfile:
    """Build a CompanyExposureProfile for one ticker.

    Resolution order (per design plan §25.5):
      1. Manual override (operator-provided) — wins absolutely
      2. Filings-derived (Phase C — SEC EDGAR 10-K via Claude) when
         SEC_EDGAR_ENABLED + ANTHROPIC_API_KEY are set + a 10-K exists
      3. Sector model (Phase A default — from sector_risk_library)
      4. Unknown sector → empty profile at confidence 0.0

    `try_filings=False` skips the Phase C path — used by the universe
    batch builder where we don't want 200 EDGAR fetches per refresh.
    The per-ticker exposure endpoint keeps try_filings=True so individual
    drill-downs get the higher-confidence filings data.
    """

    # 1. Manual override path — operator knows better than the model.
    if manual_overrides is not None:
        return manual_overrides

    # 2. Filings-derived path — lazy import so we don't pay the
    #    filings_extractor + urllib + anthropic-SDK startup cost on
    #    every cold start, only when actually trying filings.
    if try_filings:
        try:
            from .filings_extractor import try_filings_derived_profile
            filings_profile = try_filings_derived_profile(
                ticker=ticker,
                company_name=company_name,
                sector=sector,
                industry=industry,
            )
            if filings_profile is not None:
                return filings_profile
        except Exception:
            # Filings extractor is best-effort. Any error → fall through
            # to sector model so the request never 500s.
            pass

    profile = SECTOR_RISK_LIBRARY.get(sector)
    if profile is None:
        # Unknown sector — return an empty shell so the engine never crashes,
        # but signal to the UI that we have nothing real to say (confidence 0).
        return CompanyExposureProfile(
            ticker=ticker,
            company_name=company_name,
            sector=sector,
            industry=industry,
            geographic_exposure={},
            supply_chain_exposure={},
            financial_sensitivity={},
            main_risks=[],
            main_opportunities=[],
            confidence=0.0,
            source="sector_model",
            last_updated=datetime.now(timezone.utc),
        )

    # Sector-derived geographic + supply-chain + sensitivity maps.
    # These are dict copies — frozen dataclasses share the underlying dict
    # if we don't copy, and callers must be able to mutate per-ticker.
    geo = dict(profile.default_geographic_exposure)
    supply = dict(profile.default_supply_chain_exposure)
    sens = dict(profile.default_financial_sensitivity)

    # Filter sector risks to the ones that apply to this industry +
    # geographic exposure. Then turn each RiskDimension into a RiskRef
    # (the surface-level record with company-specific explanation).
    applicable_risks = risks_for_company(sector, industry, geo)
    risk_refs: list[RiskRef] = [
        RiskRef(
            key=r.key,
            label=r.label,
            severity=r.severity,
            channels=list(r.channels),
            explanation=f"Sector-default exposure for {sector}.",
        )
        for r in applicable_risks
    ]

    applicable_opps = opportunities_for_company(sector, industry)
    opp_refs: list[OpportunityRef] = [
        OpportunityRef(
            key=o.key,
            label=o.label,
            severity=o.strength,
            channels=list(o.channels),
            explanation=f"Sector-default tailwind for {sector}.",
        )
        for o in applicable_opps
    ]

    # Theme overlay — cross-sector themes (AI datacenter, Taiwan, Red Sea)
    # that affect this specific ticker. Themes are appended after sector
    # risks/opportunities so the main list stays ordered by source-of-truth
    # (sector profile first, then themes).
    for theme in themes_for_ticker(ticker, sector, industry):
        if theme.polarity == "risk":
            risk_refs.append(RiskRef(
                key=theme.key,
                label=theme.label,
                severity=theme.severity_or_strength,
                channels=list(theme.channels),
                explanation=f"Theme overlay — affects {sector} via cross-sector linkage.",
            ))
        else:
            opp_refs.append(OpportunityRef(
                key=theme.key,
                label=theme.label,
                severity=theme.severity_or_strength,
                channels=list(theme.channels),
                explanation=f"Theme tailwind for {sector}.",
            ))

    # Order risks + opportunities by severity (critical > high > medium > low)
    # so the FE renders the most impactful first without sorting again.
    severity_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    risk_refs.sort(key=lambda r: severity_rank.get(r.severity, 99))
    opp_refs.sort(key=lambda o: severity_rank.get(o.severity, 99))

    return CompanyExposureProfile(
        ticker=ticker,
        company_name=company_name,
        sector=sector,
        industry=industry,
        geographic_exposure=geo,
        supply_chain_exposure=supply,
        financial_sensitivity=sens,
        main_risks=risk_refs,
        main_opportunities=opp_refs,
        confidence=SECTOR_MODEL_CONFIDENCE,
        source="sector_model",
        last_updated=datetime.now(timezone.utc),
    )


def build_universe_exposure_profiles(
    universe: list[tuple[str, str, str]],
    industry_lookup: Optional[dict[str, str]] = None,
) -> dict[str, CompanyExposureProfile]:
    """Bulk-build profiles for every ticker in the universe.

    `universe` is the DEFAULT_UNIVERSE list of (ticker, name, sector) tuples
    from src/engine/public/universe.py. `industry_lookup` maps ticker →
    industry sub-tag (Software / Pharma / Aerospace / etc.).

    Used by the risk-radar endpoint to aggregate sector-level risk across
    the whole universe in one pass instead of per-request.
    """
    industry_lookup = industry_lookup or {}
    profiles: dict[str, CompanyExposureProfile] = {}
    for ticker, name, sector in universe:
        # NOTE: try_filings=False on the bulk path — fetching 10-Ks for
        # 200 tickers via SEC EDGAR + Claude is too expensive for the
        # 3-minute radar cache TTL. Per-ticker drill-downs (the exposure
        # endpoint) use try_filings=True so individual companies get the
        # filings-derived profile when configured.
        profiles[ticker] = build_company_exposure_profile(
            ticker=ticker,
            company_name=name,
            sector=sector,
            industry=industry_lookup.get(ticker),
            try_filings=False,
        )
    return profiles
