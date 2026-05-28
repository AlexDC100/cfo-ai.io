"""Dataclasses for the Public Company AI Intelligence layer.

Single source of truth for shapes that flow across the orchestrator, the
scoring engine, the routes, and the DB persistence (intelligence_signals,
company_exposure_profiles, public_company_risk_scores tables).

Frozen dataclasses + Literal types keep the FE/BE contract honest: any field
the engine produces is on this page, and any field the route surface accepts
maps to one of these classes. The JSON shapes the FastAPI routes emit match
these dataclasses 1:1 via dataclasses.asdict().
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Optional

# ─────────────────────────────────────────────────────────────────────────
# Type aliases — kept on one page so a casual reader can see the full
# vocabulary in 30 seconds.
# ─────────────────────────────────────────────────────────────────────────

SignalType = Literal[
    "geopolitical",
    "supply_chain",
    "energy",
    "commodity",
    "interest_rates",
    "fx",
    "regulation",
    "technology",
    "consumer_demand",
    "climate",
    "company_news",
    "earnings",
    "filing",
    "credit",
]

# 8 risk-radar categories per brief §14. Distinct from SignalType because a
# signal can map to multiple categories (e.g. a Red-Sea event is both
# geopolitical AND supply_chain) — we surface signals under their primary
# type but tag affected categories separately for radar aggregation.
RiskCategory = Literal[
    "geopolitical",
    "supply_chain",
    "energy",
    "rates_credit",
    "fx",
    "regulation",
    "technology",
    "consumer_demand",
]

Severity = Literal["low", "medium", "high", "critical"]

TimeHorizon = Literal["immediate", "3m", "12m", "long_term"]

# Financial-impact channels — these are the levers a risk pulls on the P&L /
# BS / CF. Used by the LLM prompt to force the model to identify a specific
# metric the risk could move, not just say "this is bad."
FinancialImpactChannel = Literal[
    "revenue",
    "gross_margin",
    "ebitda_margin",
    "capex",
    "working_capital",
    "inventory",
    "debt_cost",
    "fx",
    "valuation_multiple",
    "supply_availability",
]

# Provenance label — always present on every CompanyExposureProfile so the FE
# can show "Sector-derived exposure" badges and the LLM prompt can refuse to
# present inferred numbers as verified facts.
ExposureSource = Literal[
    "filings",       # Phase C — extracted from 10-K/10-Q risk factors
    "sector_model",  # Phase A default — derived from sector_risk_library
    "ai_inferred",   # Phase C — Claude proposed, operator approved
    "manual",        # operator-uploaded override (always wins)
]

Polarity = Literal["risk", "opportunity"]


# ─────────────────────────────────────────────────────────────────────────
# Intelligence signals — the macro-and-news-and-filing-and-commodity feed
# ─────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class IntelligenceSignal:
    """A single discrete signal in the macro / supply-chain / company feed.

    Phase A: created by `manual_signal_adapter` (operator paste) or by
    `signal_orchestrator` synthesizing sector-derived signals at radar query
    time. Phase B: created by news/RSS/commodity/rates adapters.

    `affected_tickers` is computed at insert/synth time — we don't recompute
    it on every read because the universe is stable and ticker affiliation
    rarely changes between syncs. If the universe changes, the signal
    orchestrator re-derives links nightly.
    """

    id: str
    signal_type: SignalType
    title: str
    summary: str
    source: str           # "sector_model", "manual:alex", "rss:bloomberg", etc.
    severity: Severity
    time_horizon: TimeHorizon
    confidence: float     # 0.0–1.0
    published_at: Optional[datetime] = None
    source_url: Optional[str] = None

    affected_sectors: list[str] = field(default_factory=list)
    affected_industries: list[str] = field(default_factory=list)
    affected_companies: list[str] = field(default_factory=list)   # display names
    affected_tickers: list[str] = field(default_factory=list)     # uppercase

    geography: list[str] = field(default_factory=list)            # e.g. ["taiwan","china"]
    financial_impact_channels: list[FinancialImpactChannel] = field(default_factory=list)
    risk_categories: list[RiskCategory] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────
# Per-company exposure profile
# ─────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class RiskRef:
    """A pointer to a risk dimension as it applies to a specific company."""
    key: str                     # matches sector_risk_library.RiskDimension.key
    label: str                   # human-readable, e.g. "Taiwan concentration"
    severity: Severity
    channels: list[FinancialImpactChannel]
    explanation: str             # 1-sentence why this applies to THIS company


@dataclass(frozen=True)
class OpportunityRef:
    key: str
    label: str
    severity: Severity           # reused enum — "high" opportunity = strong tailwind
    channels: list[FinancialImpactChannel]
    explanation: str


@dataclass(frozen=True)
class CompanyExposureProfile:
    """A company's exposure across geography / supply chain / financial sensitivity.

    Sums in geographic_exposure ≈ 1.0 (it's a partition). Values in
    supply_chain_exposure and financial_sensitivity are independent 0–1
    intensities (a company can be highly exposed to multiple supply chains).

    `source` is the provenance label — sector_model means "this came from
    the sector default, not company-specific data." The FE renders a
    "Sector-derived exposure" badge when source == "sector_model".
    """

    ticker: str
    company_name: str
    sector: str
    industry: Optional[str]

    geographic_exposure: dict[str, float]    # {"us":0.4,"china":0.2,...}
    supply_chain_exposure: dict[str, float]  # {"semiconductors":0.8,...}
    financial_sensitivity: dict[str, float]  # {"interest_rates":0.6,"fx":0.4,...}

    main_risks: list[RiskRef]                # ordered by impact, top first
    main_opportunities: list[OpportunityRef]

    confidence: float                        # 0.0–1.0
    source: ExposureSource
    last_updated: datetime


# ─────────────────────────────────────────────────────────────────────────
# Risk + opportunity scores
# ─────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class RiskCategoryScores:
    """0–100 per risk category. None where the engine has no signal.

    Each category aggregates a subset of inputs:
      · macro:        sector library + macro signals tied to this ticker
      · supply_chain: supply_chain_exposure × outstanding signals
      · geopolitical: geographic_exposure × geopolitical signals
      · financial:    leverage + margin volatility + interest coverage
      · valuation:    EV/EBITDA + P/E vs peers (peer median)
      · operational:  capex maturity + inventory turnover quality
      · regulatory:   regulation signals tied to sector + geography
    """
    macro: int
    supply_chain: int
    geopolitical: int
    financial: int
    valuation: int
    operational: int
    regulatory: int


@dataclass(frozen=True)
class RiskItem:
    """Surfaced top risk for a company — what the radar / drawer / chat show."""
    key: str
    label: str
    severity: Severity
    score_contribution: int      # 0–100 — how much this risk lifts the overall score
    channels: list[FinancialImpactChannel]
    source_signal_ids: list[str] = field(default_factory=list)  # IntelligenceSignal.id refs


@dataclass(frozen=True)
class OpportunityItem:
    key: str
    label: str
    strength: Severity           # "high" opportunity = strong tailwind
    score_contribution: int
    channels: list[FinancialImpactChannel]
    source_signal_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class PublicCompanyRiskScore:
    """The deterministic risk score for a single ticker.

    Computed by risk_scoring_engine.py from inputs:
      · CompanyExposureProfile (sector + geographic + financial sensitivity)
      · canonical financial envelope (leverage, margins, coverage)
      · outstanding IntelligenceSignals tied to this ticker
    NO LLM in the critical path. The LLM lives in ai_market_read.py and
    INTERPRETS this score — it doesn't compute it.

    The `risk_level` mapping is fixed (NOT operator-tunable to avoid drift):
      0–24  : "low"
      25–49 : "medium"
      50–74 : "high"
      75–100: "critical"
    """
    ticker: str
    overall_risk_score: int             # 0–100
    risk_level: Severity
    categories: RiskCategoryScores
    top_risks: list[RiskItem]
    top_opportunities: list[OpportunityItem]
    explanation: str                    # short deterministic sentence (no LLM)
    confidence: float                   # 0.0–1.0, propagates from exposure profile
    computed_at: datetime


@dataclass(frozen=True)
class PublicCompanyOpportunityScore:
    """Symmetric to PublicCompanyRiskScore — 0–100 opportunity rating."""
    ticker: str
    overall_opportunity_score: int      # 0–100, higher = stronger tailwind
    strength_level: Severity
    top_opportunities: list[OpportunityItem]
    explanation: str
    confidence: float
    computed_at: datetime


# ─────────────────────────────────────────────────────────────────────────
# AI Market Read — LLM-produced narrative, not a number
# ─────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AIMarketRead:
    """The Claude Opus interpretation of a company / sector / universe slice.

    Cites IntelligenceSignal IDs (per `source_signal_ids`) so a reader can
    drill from the narrative back to the underlying signal. If the
    macro-signal feed is unconfigured, the prompt is informed and the
    narrative says so explicitly — never invents news.
    """
    subject: str                          # ticker, sector name, or "universe"
    subject_kind: Literal["ticker", "sector", "universe"]
    headline: str                         # 1 sentence
    summary: str                          # 2–4 sentences
    top_risks: list[RiskItem]
    top_opportunities: list[OpportunityItem]
    what_to_watch: list[str]              # next-quarter watchlist
    confidence: float
    model_id: str                         # e.g. "claude-opus-4-7"
    source_signal_ids: list[str]
    feed_status: Literal[
        "live_feed_active",
        "sector_model_only",
        "no_provider_configured",
    ]
    computed_at: datetime
