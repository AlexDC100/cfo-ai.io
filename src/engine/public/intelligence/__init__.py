"""Public Company AI Intelligence — macro-to-micro risk reasoning layer.

Sits ALONGSIDE the public-company Sharadar adapter (src/engine/public/) and
the trial-balance engine (src/engine/api/, src/engine/country_packs/). Reads
the existing `assembled_canonical_v1` envelopes from `public_company_periods`
+ the in-repo sector risk library + the in-DB intelligence_signals store, and
produces:

  · per-company risk + opportunity scores (deterministic, 0–100)
  · per-company exposure profiles (geographic / supply-chain / sensitivity)
  · macro signal feed (manual at Phase A; live providers at Phase B+)
  · risk-radar aggregation (sector × risk-dimension)
  · AI Market Read (Claude Opus interpretation of the above)

Architecture invariants (locked from the design plan, 2026-05-27):

  · ZERO imports from src/engine/api/ pipeline or src/engine/country_packs/.
    The trial-balance engine cannot be perturbed.
  · The numeric risk score is ALWAYS computed by risk_scoring_engine.py —
    the LLM only INTERPRETS the score. Per brief §10.
  · Every CompanyExposureProfile carries a `source` label
    (sector_model / filings / ai_inferred / manual) so the FE never
    presents inferred exposure as verified fact. Per brief §8.
  · Adapter pattern via SignalAdapter Protocol — provider-agnostic. When
    a provider env var is missing, the adapter returns configured=False
    and the route exposes feature-status, NOT fake data. Per brief §6+§21.
  · The /api/public/intelligence/* router is mounted alongside the existing
    /api/public/* router in server.py. No path conflicts.

Module layout (Phase A):
  models.py                      — IntelligenceSignal, CompanyExposureProfile,
                                   RiskScore, OpportunityScore dataclasses
  sector_risk_library.py         — static 12-sector library (the data)
  company_exposure_service.py    — ticker → CompanyExposureProfile resolution
  risk_scoring_engine.py         — deterministic 0–100 risk score
  opportunity_scoring_engine.py  — symmetric opportunity score
  macro_signal_service.py        — IntelligenceSignal CRUD + query
  signal_orchestrator.py         — signal → affected-tickers via sector exposure
  intelligence_cache.py          — short-TTL in-memory cache (radar/signals hot)
  ai_market_read.py              — Claude Opus interpretation orchestrator
  adapters/
    base.py                      — SignalAdapter Protocol + AdapterHealth
    manual_signal_adapter.py     — operator-uploaded signals (always configured)
    {news,rss,commodity,rates,geopolitical}_signal_adapter.py — stubs (Phase B)
  routes.py                      — 9 FastAPI endpoints under /api/public/intelligence/*
"""

from .models import (
    IntelligenceSignal,
    CompanyExposureProfile,
    PublicCompanyRiskScore,
    PublicCompanyOpportunityScore,
    RiskItem,
    OpportunityItem,
    RiskCategory,
    SignalType,
    Severity,
    TimeHorizon,
    FinancialImpactChannel,
    ExposureSource,
)
from .sector_risk_library import (
    SECTOR_RISK_LIBRARY,
    SectorRiskProfile,
    RiskDimension,
    OpportunityDimension,
)

__all__ = [
    "IntelligenceSignal",
    "CompanyExposureProfile",
    "PublicCompanyRiskScore",
    "PublicCompanyOpportunityScore",
    "RiskItem",
    "OpportunityItem",
    "RiskCategory",
    "SignalType",
    "Severity",
    "TimeHorizon",
    "FinancialImpactChannel",
    "ExposureSource",
    "SECTOR_RISK_LIBRARY",
    "SectorRiskProfile",
    "RiskDimension",
    "OpportunityDimension",
]
