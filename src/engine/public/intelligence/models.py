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
from datetime import datetime, timezone
from typing import Literal, Optional


# ─────────────────────────────────────────────────────────────────────────
# THE TIMEZONE BOUNDARY — it lives here, on the model, not on the readers
# ─────────────────────────────────────────────────────────────────────────
#
# ``IntelligenceSignal.published_at`` is merged into ONE list from six
# adapters and then ordered. That ordering is total only if every stamp in
# the list is comparable to every other, and Python refuses to order a
# naive datetime against an aware one. So the invariant is asserted where
# the value ENTERS the domain — the dataclass every producer must build —
# and not at each place it is later read:
#
#     A SIGNAL CARRYING A TIMESTAMP CARRIES AN AWARE ONE, OR CARRIES NONE.
#
# Two producers were still handing naive stamps into that list after the
# cutoff itself was made aware, and each was invisible from the other's
# side of the code:
#
#   · ``rss_signal_adapter._parse_date_safe`` returns a bare
#     ``datetime.fromisoformat`` for an ISO ``pubDate`` with no offset
#     ("2026-09-01T10:00:00", "2026-09-01"), while stamping UTC on the
#     RFC-2822 branch — so ONE feed hands the same list both kinds.
#   · anything reading a stamp the provider omitted or wrote badly, where
#     the read then substituted a naive sentinel.
#
# MEASURED against the real ``create_app()`` with canned SUCCESSFUL
# provider bodies, anonymous, one activation variable at a time:
# ``GET /api/public/intelligence/macro-signals`` answered 500
# (``TypeError: can't compare offset-naive and offset-aware datetimes``,
# routes.py ``all_signals.sort``) with RSS_FEED_URLS set alone and a
# bare-ISO ``pubDate``, and again with NEWS_API_KEY set alone and an
# article whose ``publishedAt`` was malformed. The prior gate's canned RSS
# body used an RFC-2822 date and its NewsAPI body always carried a valid
# ``publishedAt``, so neither shape was ever generated and the gate was
# green over a live 500.
#
# The failure is STICKY beyond the request that causes it: the poisoned
# list is the CACHED feed (``routes._FEED_KEY``), so one naive stamp keeps
# answering 500 for the whole feed TTL, and every other route that reads
# the feed serves that stamp on to the FE as an offset-less ISO string.
#
# ABSENT != ZERO, and this helper does not decide the undated case. It
# returns ``None`` unchanged; what an undated signal MEANS is the reader's
# business and the readers deliberately disagree (the news adapter
# includes one, the manual adapter excludes one). What the readers may no
# longer do is invent a naive stand-in for it.


def as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Coerce a datetime to timezone-aware UTC. ``None`` passes through.

    A NAIVE input is READ AS UTC rather than as local time. That is the
    correct reading for every producer on this path and is not a guess:
    FRED and EIA publish observation dates in UTC, NewsAPI's
    ``publishedAt`` and GDELT's ``seendate`` are both documented UTC, and
    the RSS/news parsers already stamp ``timezone.utc`` on their other
    branches. Interpreting a naive stamp as machine-local instead would
    shift every cutoff by the deployment's offset — a silent correctness
    bug that no test in a UTC container would ever show.

    Defined HERE rather than in ``adapters/base.py`` so the model can hold
    the invariant without importing its own readers. ``adapters.base``
    re-exports it, so every existing ``from .base import as_utc`` is
    unchanged and there is still exactly ONE implementation.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

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

    def __post_init__(self) -> None:
        """Enforce the timezone boundary at the ONE place every signal is born.

        Six adapters build this class and their number grows; a naive stamp
        from any one of them poisons the single list they are merged into
        for the whole feed TTL. Coercing at each producer would be six
        edits that the seventh adapter is free to forget — this is the
        boundary that a new producer cannot route around, because there is
        no way to become an ``IntelligenceSignal`` without passing it.

        ``object.__setattr__`` because the dataclass is frozen; the value
        is normalised at construction and immutable thereafter.

        This does NOT invent a timestamp. ``published_at=None`` stays
        ``None`` — see ``as_utc`` above on why the undated case is the
        reader's decision and not this class's.
        """
        object.__setattr__(self, "published_at", as_utc(self.published_at))


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
