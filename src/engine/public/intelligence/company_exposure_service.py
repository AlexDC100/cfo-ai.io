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

import logging
from datetime import datetime, timezone
from typing import Optional

from .bvb_overrides import get_bvb_overrides
from .category_scoring import (
    CATEGORIES,
    derive_category_scores,
)
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

logger = logging.getLogger(__name__)


# Confidence band for sector_model: 0.55 default. We're not pretending to
# know company-specific risk; we're saying "this is the sector default."
# When filings/manual sources take over, this lifts to 0.85+.
SECTOR_MODEL_CONFIDENCE = 0.55


# ─────────────────────────────────────────────────────────────────────────
# BVB override observability
# ─────────────────────────────────────────────────────────────────────────
# Per-override-fire INFO logging is deduplicated via this process-local
# set so we don't spam logs once per request. Each (ticker, field) pair
# logs exactly once per process lifetime — the radar refreshes every 5
# min, so without dedup we'd emit ~144 lines per ticker per 12-hour day.
# Module-level startup log (bvb_overrides.py) gives the operator the
# "which overrides are loaded" view; this gives the "which overrides
# fired in practice" view, complementary not redundant.

_override_logged: set[tuple[str, str]] = set()


def _log_override_once(ticker: str, field: str, detail: str) -> None:
    key = (ticker, field)
    if key in _override_logged:
        return
    _override_logged.add(key)
    logger.info("[bvb_override_fired] %s.%s — %s", ticker, field, detail)


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

    # BVB Phase 2 — apply ticker-level overrides on top of sector default.
    # The geographic_exposure overlay is the most important field: H2O's
    # romania=0.95 replaces the Utilities sector default of us=0.85, which
    # then flows into category_scoring's geopolitical computation. Per Lock
    # #11, the override knowledge stays at the service layer; the scoring
    # function is exchange-agnostic. Per Lock #8, the override fire is
    # logged once per (ticker, field) so we can confirm in production logs
    # that the overrides we expected to fire actually fired.
    bvb_override = get_bvb_overrides(ticker)
    if bvb_override is not None:
        geo_override = bvb_override.get("geographic_exposure")
        if geo_override:
            # Replace the geo dict entirely — the override is intentional and
            # caller-curated (Hidroelectrica is 100% RO, not 5% RO + 85% US).
            # Partial-merge would silently mix sector defaults with curated
            # data which is exactly the kind of source-of-truth ambiguity
            # the README ladder doc warns against.
            geo = dict(geo_override)
            _log_override_once(
                ticker, "geographic_exposure",
                f"replaced sector default with {sorted(geo_override.items())}",
            )

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


def score_categories_for_ticker(
    *,
    ticker: str,
    sector: str,
    industry: Optional[str],
    geographic_exposure: dict[str, float],
) -> dict[str, float]:
    """Compute the 8 Risk Radar category exposures for a ticker.

    This is the service-layer entry point for the radar's per-(ticker,
    category) ranking. routes.py calls this once per ticker; the
    function itself is the ONE place that knows where category-level
    overrides come from (currently bvb_overrides; future
    wse_overrides / ase_overrides for Warsaw / Athens drop in next to
    it without `category_scoring.py` ever changing — Lock #11).

    Args:
      ticker: ticker symbol (e.g. "NVDA", "TLV", "EL.BVB"). Used to
        look up explicit_tickers theme matches AND to look up per-
        ticker override entries.
      sector: sector name as it appears in SECTOR_RISK_LIBRARY.
      industry: optional industry sub-tag for finer-grained theme
        matches (e.g. "Pharma" for healthcare GLP-1 theme).
      geographic_exposure: the resolved geo dict for the ticker. Caller
        passes the post-override geo (BVB override applied in
        build_company_exposure_profile already), so this function
        doesn't re-apply the geo overlay.

    Returns:
      Dict keyed by category (`CATEGORIES`), values in [0.0, 1.0].
      Sector-unknown tickers return zeros (`category_scoring`'s
      contract for None profile).
    """
    profile = SECTOR_RISK_LIBRARY.get(sector)
    if profile is None:
        return {cat: 0.0 for cat in CATEGORIES}

    # Resolve themes via the same path the existing main_risks/main_opps
    # uses. themes_for_ticker handles both sector matches and the
    # explicit_tickers shortcut.
    themes_applied = themes_for_ticker(ticker, sector, industry)

    # Pull category-level overrides from the relevant exchange's module.
    # Today only BVB is wired; tomorrow Warsaw/Athens slot into the same
    # if/elif structure. The DERIVATION function knows nothing about any
    # of this — it just receives a dict[str, float] | None.
    category_overrides: Optional[dict[str, float]] = None
    bvb_override = get_bvb_overrides(ticker)
    if bvb_override is not None:
        category_overrides = bvb_override.get("category_exposures") or None
        if category_overrides:
            # Per-fire dedup log so we can confirm in prod which override
            # categories are actually being applied. Logs once per
            # (ticker, "category_exposures") combo per process — the
            # detail string lists which categories were overridden.
            _log_override_once(
                ticker, "category_exposures",
                "overrode " + ", ".join(
                    f"{k}={v}" for k, v in sorted(category_overrides.items())
                ),
            )

    return derive_category_scores(
        profile=profile,
        themes_applied=themes_applied,
        geographic_exposure=geographic_exposure,
        category_overrides=category_overrides,
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
