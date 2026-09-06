"""FastAPI router for the AI Intelligence layer.

Mounted at /api/public/intelligence/* in src/engine/api/server.py — sibling
of the existing /api/public/* router. Routes are deliberately namespaced
under `intelligence/` so existing FE polling of /api/public/universe etc.
is unaffected.

Endpoints (matches design plan §25.7):
  GET  /api/public/intelligence/health
  GET  /api/public/intelligence/risk-radar
  GET  /api/public/intelligence/macro-signals
  GET  /api/public/intelligence/supply-chain          ?sector=...|?ticker=...
  GET  /api/public/intelligence/companies/{ticker}/risk-score
  GET  /api/public/intelligence/companies/{ticker}/exposure
  GET  /api/public/intelligence/companies/{ticker}/signals
  GET  /api/public/intelligence/companies/{ticker}/ai-market-read
  POST /api/public/intelligence/signals/manual        — operator signal upload
                                                        WALLED (fail closed)
  POST /api/public/intelligence/refresh-filings-cache  — poll EDGAR, invalidate
                                                        WALLED (fail closed)
  POST /api/public/intelligence/refresh-signals       — bust radar + signal cache
                                                        SHIELDED (rate limit)

The two WALLED routes require the ENGINE_API_TOKEN bearer and refuse with
503 when it is unset; the SHIELDED one stays anonymously reachable behind a
per-client budget. That split is deliberate and is pinned by
tests/engine/test_public_post_surface.py — see refresh_shield's module
docstring for the reasoning.
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .. import universe as universe_module
# Cache-bust shield (rate limit + operator bearer). MODULE scope on purpose:
# this file uses `from __future__ import annotations`, so anything FastAPI has
# to resolve from an endpoint signature must be visible in module globals.
from ..refresh_shield import guard as _refresh_guard
from ..refresh_shield import require_operator as _require_operator
from ..universe_service import get_universe
from ..bvb_seed import bvb_universe as _bvb_universe
from .category_scoring import CATEGORIES as RADAR_CATEGORIES
from .company_exposure_service import (
    SECTOR_MODEL_CONFIDENCE,
    build_company_exposure_profile,
    build_universe_exposure_profiles,
    score_categories_for_ticker,
)
from .intelligence_cache import (
    EXPOSURE_TTL_SEC,
    RADAR_TTL_SEC,
    SCORE_TTL_SEC,
    SIGNALS_TTL_SEC,
    get_intelligence_cache,
)
from .macro_signal_service import get_macro_signal_service
from .models import (
    FinancialImpactChannel,
    IntelligenceSignal,
    PublicCompanyRiskScore,
    RiskCategory,
    Severity,
    SignalType,
    TimeHorizon,
)
from .ai_market_read import compose_ai_market_read
# Phase D — filings cache observability + refresh hook
from . import filings_cache
from .filings_refresh import run_refresh
from .opportunity_scoring_engine import compute_opportunity_score
from .risk_scoring_engine import compute_risk_score
from .sector_risk_library import SECTOR_RISK_LIBRARY, all_sectors
from .signal_orchestrator import synthesize_sector_signals

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────
# Helpers — universe + financials hydration
# ─────────────────────────────────────────────────────────────────────────

def _industry_lookup() -> dict[str, str]:
    """Mirror of universe_module.INDUSTRY but typed as a dict."""
    return dict(universe_module.INDUSTRY)


def _serialize(obj: Any) -> Any:
    """Recursive dataclasses.asdict-equivalent that also coerces datetimes to
    ISO strings, so FastAPI's JSON serializer never trips on a tz-aware dt.
    """
    if obj is None:
        return None
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, list):
        return [_serialize(o) for o in obj]
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    if hasattr(obj, "__dataclass_fields__"):
        return _serialize(asdict(obj))
    return obj


def _fetch_universe_snapshots() -> dict[str, dict[str, Any]]:
    """Pull the live universe payload + index by uppercase ticker.

    Falls back to demo universe if no Nasdaq key is configured.
    Cached by build_universe_payload itself (TTL inside universe_service.py).
    """
    payload = get_universe()
    # universe_service returns either {"companies":[...]} or a list directly.
    rows = payload.get("companies", []) if isinstance(payload, dict) else payload
    out: dict[str, dict[str, Any]] = {}
    for snap in rows:
        if not isinstance(snap, dict):
            continue
        ticker = (snap.get("ticker") or "").upper()
        if ticker:
            out[ticker] = snap
    return out


def _financials_from_snapshot(snap: dict[str, Any]) -> dict[str, Any]:
    """Pull the canonical financial subset the scoring engines expect."""
    return {
        "revenue":              snap.get("revenue"),
        "revenue_growth":       snap.get("revenue_growth") or snap.get("revenueGrowth"),
        "ebitda":               snap.get("ebitda"),
        "ebitda_margin":        snap.get("ebitda_margin") or snap.get("ebitdaMargin"),
        "net_income":           snap.get("net_income") or snap.get("netIncome"),
        "net_margin":           snap.get("net_margin") or snap.get("netMargin"),
        "capex":                snap.get("capex"),
        "operating_cash_flow":  snap.get("operating_cash_flow") or snap.get("operatingCashFlow"),
        "free_cash_flow":       snap.get("free_cash_flow") or snap.get("freeCashFlow"),
        "fcf_yield":            snap.get("fcf_yield") or snap.get("fcfYield"),
        "market_cap":           snap.get("market_cap") or snap.get("marketCap"),
        "ev":                   snap.get("enterprise_value") or snap.get("enterpriseValue"),
        "ev_to_ebitda":         snap.get("ev_to_ebitda") or snap.get("evToEbitda"),
        "pe_ratio":             snap.get("pe_ratio") or snap.get("peRatio"),
        "net_debt":             snap.get("net_debt") or snap.get("netDebt"),
        "net_debt_to_ebitda":   snap.get("net_debt_to_ebitda") or snap.get("netDebtToEbitda"),
        "debt_to_equity":       snap.get("debt_to_equity") or snap.get("debtToEquity"),
        "roe":                  snap.get("roe"),
        "interest_expense":     snap.get("interest_expense") or snap.get("interestExpense"),
    }


# ─────────────────────────────────────────────────────────────────────────
# Pydantic request models
# ─────────────────────────────────────────────────────────────────────────

class ManualSignalIn(BaseModel):
    signal_type: SignalType
    title: str = Field(..., min_length=4, max_length=200)
    summary: str = Field(..., min_length=8, max_length=2000)
    severity: Severity
    time_horizon: TimeHorizon = "12m"
    affected_sectors: list[str] = Field(default_factory=list)
    affected_industries: Optional[list[str]] = None
    affected_companies: Optional[list[str]] = None
    affected_tickers: Optional[list[str]] = None
    geography: Optional[list[str]] = None
    financial_impact_channels: Optional[list[FinancialImpactChannel]] = None
    risk_categories: Optional[list[RiskCategory]] = None
    confidence: float = Field(0.7, ge=0.0, le=1.0)
    source_label: str = "manual:operator"
    source_url: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────
# Router
# ─────────────────────────────────────────────────────────────────────────

def build_router() -> APIRouter:
    router = APIRouter(prefix="/api/public/intelligence", tags=["public-companies-intelligence"])

    # ─── Health ─────────────────────────────────────────────────────────
    @router.get("/health")
    def health() -> dict[str, Any]:
        """Per-adapter health + feed status.

        Used by the FE Macro Signals tab to decide whether to show the
        "Live signal feed not connected" empty-state vs a live feed.
        """
        svc = get_macro_signal_service()
        # Phase D — surface filings cache observability so operators can
        # see hit rate, eviction frequency, and total entries WITHOUT
        # SSHing into the DB. Counters are container-local per the
        # `metrics_scope` field in the payload.
        cache_metrics = filings_cache.get_metrics_snapshot()
        cache_oldest = filings_cache.oldest_entry_age_seconds()
        return {
            "feed_status": svc.feed_status(),
            "adapters": {
                name: _serialize(asdict(h)) for name, h in svc.health().items()
            },
            "sector_library_version": "v1",
            "universe_sector_count": len(all_sectors()),
            "filings_cache": {
                **cache_metrics,
                "total_entries": filings_cache.total_cached_entries(),
                "oldest_entry_age_seconds": cache_oldest,
                "ttl_days": filings_cache.CACHE_TTL_DAYS,
            },
        }

    # ─── Risk Radar ─────────────────────────────────────────────────────

    # Per-sector diversity cap on radar top-12 affected_tickers rankings.
    # Honest scoring produces sector-uniform top-12 within categories where
    # one sector dominates (e.g. Utilities top all 12 rates_credit slots
    # because they share the same default financial_sensitivity.interest_rates
    # value; Semis top supply_chain because they share semiconductors=0.95).
    # A CFO scanning the radar needs cross-sector situational awareness —
    # "which OTHER industries are exposed?" — not 12 names from one sector.
    # This cap forces the top-12 to draw from at least 3 sectors by limiting
    # any single sector to MAX_TICKERS_PER_SECTOR_PER_CATEGORY.
    #
    # Set to 4 (empirically chosen — Gate A v2/v3 comparison, 2026-06-01).
    # At 12 slots / 4 per sector = minimum 3 sectors represented per
    # category. The radar's affected_tickers ranking draws from at least
    # 3 distinct sectors so a CFO scanning the card sees cross-sector
    # situational awareness, not 12 names from one industry.
    #
    # COUNTERINTUITIVE EMPIRICAL FINDING — do not "tighten" this to 3
    # thinking it improves diversity. We tried cap=3 and it made overlap
    # WORSE:
    #   cap=4 — 5/28 category pairs over 40% overlap, max 83%
    #   cap=3 — 8/28 category pairs over 40% overlap, max 75%
    # Mechanism: tighter cap forces MORE sectors into each top-12 list.
    # When two categories LEGITIMATELY share their top sectors (Semis
    # is in both supply_chain and geopolitical top sectors; Consumer
    # Defensive is in both fx and supply_chain top sectors), each shared
    # sector contributes the cap value to the overlap. Three shared
    # sectors at cap=3 = 9/12 overlap (75%); three shared sectors at
    # cap=4 = also 9/12 (75%) — but cap=4 fits MORE total per-sector
    # signal so fewer sectors are shared overall.
    #
    # Going below 3 (e.g. cap=2) would mutilate the data: forcing 6+
    # sectors into every top-12 means the radar shows 1 NVDA + 11
    # tickers from sectors that aren't actually supply-chain dominant.
    # The cap mechanism is at its empirical ceiling.
    #
    # The remaining structural overlaps (energy×fx, geopolitical×
    # supply_chain, etc.) reflect REAL CFO-level correlations — Semis
    # are both Taiwan-exposed AND semi-supply-fragile; Consumer Defensive
    # is both energy-sensitive AND FX-sensitive. These overlaps are
    # surfaced honestly, not hidden, via the `diversity_status` field
    # the response includes per category (see _diversity_status_for_cat
    # below).
    #
    # The deeper fix — per-ticker financial variation that breaks
    # within-sector score ties — lands when SEC filings extraction is
    # wired (Phase D-something). At that point the 40% gate becomes
    # achievable and this constant can re-tighten. Until then 50% is
    # the honest floor and the cap stays at 4.
    #
    # CRITICAL — applied AFTER score-rank sorting, NOT before scoring.
    # Scoring stays honest (score_categories_for_ticker is exchange-
    # agnostic, ticker-agnostic to sector caps); presentation layer
    # enforces diversity. Keep these layers separate — applying the cap
    # before scoring would bias the input data and break Lock #11.
    #
    # Gate A overlap matrix validates this: before-cap had geopolitical×
    # supply_chain=10/12 and rates_credit×regulation=12/12 shared
    # (Utilities flooding both, Semis flooding both). After-cap target:
    # max overlap ≤4/12. Re-run Gate A after any change to this constant.
    _MAX_TICKERS_PER_SECTOR_PER_CATEGORY = 4

    # Per-category structural-correlation labels surfaced in the response
    # payload. These flag the pairs where the radar's top-12 lists
    # overlap >50% because of HONEST CFO-level correlations in the
    # underlying data, not because of a bug. The FE can use these to
    # render a "Shares N of 12 with {related} — both driven by {sectors}"
    # footnote inside the affected_tickers list (not as a card-level
    # badge) so the user understands the correlation when they're deep
    # in the data, not as a top-level label that makes every card feel
    # weakly differentiated.
    #
    # Empirical history (Lock #8 working correctly):
    # I predicted 2 correlated pairs ahead of Gate A. Gate A FINAL
    # revealed 4. The 2 surprises matched the same pattern — dominant-
    # sector convergence on real CFO-level correlations, not wiring
    # bugs. Treating the surprises as bugs because they weren't
    # predicted would have been Lock #8 in reverse: letting prediction
    # define reality. The pattern (ALL 4 over-threshold pairs are
    # structurally explainable, ZERO are random) is the discriminator.
    # A future failing pair like `technology × consumer_demand` WOULD
    # be a wiring bug — the data shouldn't produce uncorrelated overlaps
    # at this magnitude.
    #
    # Each entry: category → (related_category, shared_sectors_label).
    # Label is the operator-readable explanation of WHY they overlap,
    # rendered inline in the FE footnote.
    _KNOWN_STRUCTURAL_CORRELATIONS: dict[str, list[dict[str, str]]] = {
        "supply_chain": [
            {"related": "geopolitical",
             "drivers": "Semiconductors (Taiwan concentration + semi-supply fragility)"},
            {"related": "energy",
             "drivers": "Materials (China-exposed metals + energy-intensive production); "
                        "Consumer Defensive (food commodities + energy input cost)"},
        ],
        "geopolitical": [
            {"related": "supply_chain",
             "drivers": "Semiconductors (Taiwan concentration + semi-supply fragility)"},
        ],
        "energy": [
            {"related": "fx",
             "drivers": "Consumer Defensive + Energy (globally exposed input costs "
                        "AND multi-currency revenue)"},
            {"related": "supply_chain",
             "drivers": "Materials + Consumer Defensive (energy-intensive + commodity-supply)"},
        ],
        "fx": [
            {"related": "energy",
             "drivers": "Consumer Defensive + Energy (globally exposed input costs "
                        "AND multi-currency revenue)"},
        ],
        "rates_credit": [
            {"related": "regulation",
             "drivers": "Utilities + Financials (heavily regulated AND long-duration "
                        "debt / tariff-structured revenue)"},
        ],
        "regulation": [
            {"related": "rates_credit",
             "drivers": "Utilities + Financials (heavily regulated AND long-duration "
                        "debt / tariff-structured revenue)"},
        ],
    }

    @router.get("/risk-radar")
    def risk_radar() -> dict[str, Any]:
        """8 risk-radar category cards (per brief §14).

        Aggregates exposure profiles + sector-model signals across the
        full 200-ticker universe to produce one card per RiskCategory.
        Cached for RADAR_TTL_SEC (5 min) to keep FE polling cheap.
        """
        cache = get_intelligence_cache()

        def _compute():
            industry = _industry_lookup()

            # ── Merge universe: NASDAQ + BVB ──────────────────────────
            # BVB Phase 2 (2026-06-01) — radar iteration spans both
            # universes. NASDAQ rows from DEFAULT_UNIVERSE always pass
            # the sparse-row filter (every NASDAQ ticker has demo +
            # potentially live financials). BVB rows pass only when
            # the seed entry carries a non-null revenue (Option B —
            # see intelligence/README.md "Sparse-row handling").
            #
            # Tuples shape: (ticker, name, sector, country, has_financials).
            merged_universe: list[tuple[str, str, str, str, bool]] = [
                (t, n, s, "US", True)
                for t, n, s in universe_module.DEFAULT_UNIVERSE
            ]
            bvb_rows = _bvb_universe()
            for bvb_ticker, bvb_row in bvb_rows.items():
                has_fin = bvb_row.get("revenue") is not None
                merged_universe.append((
                    bvb_ticker,
                    bvb_row["companyName"],
                    bvb_row.get("sector") or "",
                    "RO",
                    has_fin,
                ))

            # Build profiles ONCE for the merged universe — both for
            # the legacy `affected_sectors` aggregation AND for the
            # per-category scoring loop below. score_categories_for_
            # ticker handles BVB overrides internally (Lock #11 — the
            # exchange knowledge stays in the service).
            profiles = build_universe_exposure_profiles(
                [(t, n, s) for t, n, s, _country, _has_fin in merged_universe],
                industry_lookup=industry,
            )
            signals = synthesize_sector_signals()

            # Per-ticker country + has-financials lookup, indexed for
            # the per-card affected_ticker scoring loop.
            ticker_meta: dict[str, dict[str, Any]] = {
                t: {"country": c, "has_financials": h, "sector": s}
                for t, _n, s, c, h in merged_universe
            }

            # Pre-compute the full (ticker → 8-category-scores) table
            # ONCE. For 200 NASDAQ + 20 BVB tickers this is ~220
            # `score_categories_for_ticker` calls, each cheap. Done
            # outside the per-category loop so we don't recompute per
            # category — and so the BVB override INFO log fires at
            # most once per ticker per radar refresh, not 8 times.
            ticker_category_scores: dict[str, dict[str, float]] = {}
            for ticker, meta in ticker_meta.items():
                profile = profiles.get(ticker)
                if profile is None:
                    continue
                ticker_category_scores[ticker] = score_categories_for_ticker(
                    ticker=ticker,
                    sector=meta["sector"],
                    industry=industry.get(ticker),
                    geographic_exposure=profile.geographic_exposure,
                )

            # Bucket signals + companies into 8 Risk Radar cards.
            categories: dict[str, dict[str, Any]] = {}
            for cat in RADAR_CATEGORIES:
                cat_signals = [s for s in signals if cat in s.risk_categories]
                affected_sectors = sorted({
                    sec
                    for sig in cat_signals
                    for sec in sig.affected_sectors
                })

                # ── Score-ranked affected_tickers (the bug fix) ──
                # Replaces the prior alphabetical-sort logic. For each
                # ticker, look up its per-category score from the
                # pre-computed table; rank descending; cap to top-12.
                # Option B sparse filter: skip tickers with
                # has_financials=False BEFORE ranking so they don't
                # displace real signal (intelligence/README.md
                # "Sparse-row handling").
                scored: list[tuple[str, float]] = []
                for ticker, scores in ticker_category_scores.items():
                    if not ticker_meta[ticker]["has_financials"]:
                        continue
                    s = scores.get(cat, 0.0)
                    if s > 0.0:
                        scored.append((ticker, s))
                scored.sort(key=lambda x: x[1], reverse=True)

                # ── Per-sector diversity cap (see constant comment above) ──
                # Walk the score-sorted list. Count per-sector
                # occurrences as we go; skip any ticker that would push
                # its sector past the cap. Continue until 12 slots fill
                # OR list is exhausted. Exhausted-early case is OK —
                # better to ship 9 honest names than 3 honest + 9
                # sector-uniform filler.
                sector_count: dict[str, int] = {}
                top_tickers: list[tuple[str, float]] = []
                for ticker, score in scored:
                    sec = ticker_meta[ticker]["sector"]
                    if sector_count.get(sec, 0) >= _MAX_TICKERS_PER_SECTOR_PER_CATEGORY:
                        continue
                    top_tickers.append((ticker, score))
                    sector_count[sec] = sector_count.get(sec, 0) + 1
                    if len(top_tickers) >= 12:
                        break

                affected_tickers_rich = [
                    {
                        "ticker": t,
                        "category_score": round(score, 3),
                        "country": ticker_meta[t]["country"],
                        "sector": ticker_meta[t]["sector"],
                        "source": (profiles[t].source if profiles.get(t) else "sector_model"),
                        "confidence": (
                            profiles[t].confidence
                            if profiles.get(t)
                            else SECTOR_MODEL_CONFIDENCE
                        ),
                    }
                    for t, score in top_tickers
                ]
                # Legacy `affected_tickers` field — bare list of
                # tickers in score order. Kept for back-compat with
                # any FE consumer still on the old shape. The new
                # `affected_tickers_rich` is the canonical field the
                # updated radar UI reads (exposure bars + country flag).
                affected_tickers = [t for t, _ in top_tickers]

                # Aggregate severity → 0-100 card score (unchanged)
                if cat_signals:
                    sev_avg = sum({"critical":85,"high":60,"medium":35,"low":15}[s.severity]
                                  for s in cat_signals) / len(cat_signals)
                else:
                    sev_avg = 0

                # Compute the sector diversity of this card's top-12 for
                # the FE's "Closely related to {X}" badge. When the top-12
                # is drawn from <4 sectors, the radar is structurally
                # constrained — flag it so the FE can show a hint.
                sectors_represented = len({
                    ticker_meta[t]["sector"] for t, _ in top_tickers
                })
                if cat in _KNOWN_STRUCTURAL_CORRELATIONS:
                    diversity_status = "structural_correlation"
                elif sectors_represented < 3:
                    diversity_status = "sector_constrained"
                else:
                    diversity_status = "diverse"

                categories[cat] = {
                    "category": cat,
                    "score": int(round(sev_avg)),
                    "level": (
                        "critical" if sev_avg >= 75 else
                        "high"     if sev_avg >= 50 else
                        "medium"   if sev_avg >= 25 else
                        "low"
                    ),
                    "affected_sectors": affected_sectors,
                    "affected_tickers": affected_tickers,
                    "affected_tickers_rich": affected_tickers_rich,
                    # FE-rendered honesty signal — see
                    # _KNOWN_STRUCTURAL_CORRELATIONS above for the
                    # documented overlapping pairs (energy×fx,
                    # geopolitical×supply_chain). When this is
                    # "structural_correlation", the FE renders a "Closely
                    # related to {related}" badge so the user understands
                    # why two cards look similar instead of assuming the
                    # radar is broken. "sector_constrained" fires when
                    # top-12 draws from <3 sectors (real concentration
                    # outweighs diversity cap). "diverse" is the healthy
                    # default. Per the README ladder doc — honest about
                    # the underlying data shape.
                    "diversity_status": diversity_status,
                    "structural_correlations": _KNOWN_STRUCTURAL_CORRELATIONS.get(cat, []),
                    "sectors_represented": sectors_represented,
                    "signal_count": len(cat_signals),
                    "top_signals": _serialize([s for s in cat_signals[:3]]),
                }

            return {
                "categories": categories,
                "feed_status": get_macro_signal_service().feed_status(),
                "computed_at": datetime.now(timezone.utc).isoformat(),
            }

        return cache.get_or_compute("risk-radar:v1", RADAR_TTL_SEC, _compute)

    # ─── Macro Signals feed ─────────────────────────────────────────────
    @router.get("/macro-signals")
    def macro_signals(
        sector: Optional[str] = Query(None),
        ticker: Optional[str] = Query(None),
        limit: int = Query(50, ge=1, le=200),
    ) -> dict[str, Any]:
        cache = get_intelligence_cache()
        key = f"macro-signals:s={sector or ''}:t={ticker or ''}:l={limit}"

        def _compute():
            svc = get_macro_signal_service()
            live_signals = svc.fetch_all()
            sector_signals = synthesize_sector_signals(
                sector_filter=[sector] if sector else None,
            )
            all_signals = live_signals + sector_signals

            if ticker:
                tu = ticker.upper()
                all_signals = [s for s in all_signals if tu in s.affected_tickers]
            elif sector:
                all_signals = [s for s in all_signals if sector in s.affected_sectors]

            all_signals.sort(
                key=lambda s: ({"critical":0,"high":1,"medium":2,"low":3}[s.severity],
                               s.published_at or datetime.min),
            )

            return {
                "signals": _serialize(all_signals[:limit]),
                "feed_status": svc.feed_status(),
                "total": len(all_signals),
            }

        return cache.get_or_compute(key, SIGNALS_TTL_SEC, _compute)

    # ─── Supply Chain ───────────────────────────────────────────────────
    @router.get("/supply-chain")
    def supply_chain(
        ticker: Optional[str] = Query(None),
        sector: Optional[str] = Query(None),
    ) -> dict[str, Any]:
        """Supply-chain exposure for a ticker or sector.

        ticker → single-company exposure bars + source label
        sector → sector default exposure + affected tickers
        """
        if ticker:
            tu = ticker.upper()
            snaps = _fetch_universe_snapshots()
            snap = snaps.get(tu)
            if snap is None:
                raise HTTPException(404, f"Ticker {tu} not in universe")
            profile = build_company_exposure_profile(
                ticker=tu,
                company_name=snap.get("company_name") or snap.get("companyName") or tu,
                sector=snap.get("sector") or "Unknown",
                industry=_industry_lookup().get(tu),
            )
            return {"ticker": tu, "exposure": _serialize(profile)}

        if sector:
            profile = SECTOR_RISK_LIBRARY.get(sector)
            if profile is None:
                raise HTTPException(404, f"Sector {sector} not in library")
            tickers = [t for t, _, s in universe_module.DEFAULT_UNIVERSE if s == sector]
            return {
                "sector": sector,
                "default_geographic_exposure": profile.default_geographic_exposure,
                "default_supply_chain_exposure": profile.default_supply_chain_exposure,
                "default_financial_sensitivity": profile.default_financial_sensitivity,
                "affected_tickers": tickers,
                "source": "sector_model",
            }

        raise HTTPException(400, "Provide ?ticker= or ?sector=")

    # ─── Per-ticker risk score ──────────────────────────────────────────
    @router.get("/companies/{ticker}/risk-score")
    def ticker_risk_score(ticker: str) -> dict[str, Any]:
        tu = ticker.upper()
        cache = get_intelligence_cache()

        def _compute():
            snaps = _fetch_universe_snapshots()
            snap = snaps.get(tu)
            if snap is None:
                raise HTTPException(404, f"Ticker {tu} not in universe")
            profile = build_company_exposure_profile(
                ticker=tu,
                company_name=snap.get("company_name") or snap.get("companyName") or tu,
                sector=snap.get("sector") or "Unknown",
                industry=_industry_lookup().get(tu),
            )
            financials = _financials_from_snapshot(snap)
            signals = get_macro_signal_service().fetch_for_ticker(tu)
            score = compute_risk_score(profile, financials, signals)
            return _serialize(score)

        return cache.get_or_compute(f"risk-score:{tu}", SCORE_TTL_SEC, _compute)

    # ─── Per-ticker exposure ────────────────────────────────────────────
    @router.get("/companies/{ticker}/exposure")
    def ticker_exposure(ticker: str) -> dict[str, Any]:
        tu = ticker.upper()
        cache = get_intelligence_cache()

        def _compute():
            snaps = _fetch_universe_snapshots()
            snap = snaps.get(tu)
            if snap is None:
                raise HTTPException(404, f"Ticker {tu} not in universe")
            profile = build_company_exposure_profile(
                ticker=tu,
                company_name=snap.get("company_name") or snap.get("companyName") or tu,
                sector=snap.get("sector") or "Unknown",
                industry=_industry_lookup().get(tu),
            )
            return _serialize(profile)

        return cache.get_or_compute(f"exposure:{tu}", EXPOSURE_TTL_SEC, _compute)

    # ─── Per-ticker signals ─────────────────────────────────────────────
    @router.get("/companies/{ticker}/signals")
    def ticker_signals(ticker: str) -> dict[str, Any]:
        tu = ticker.upper()
        svc = get_macro_signal_service()
        live = svc.fetch_for_ticker(tu)
        sector_for_ticker = next(
            (s for t, _, s in universe_module.DEFAULT_UNIVERSE if t == tu), None,
        )
        sector_signals = synthesize_sector_signals(
            sector_filter=[sector_for_ticker] if sector_for_ticker else None,
        ) if sector_for_ticker else []
        return {
            "ticker": tu,
            "signals": _serialize(live + sector_signals),
            "feed_status": svc.feed_status(),
        }

    # ─── Per-ticker AI Market Read (Phase B — real Claude Opus) ─────────
    @router.get("/companies/{ticker}/ai-market-read")
    def ai_market_read(ticker: str) -> dict[str, Any]:
        """Per-ticker AI Market Read narrative.

        Phase B: calls Claude Opus via `compose_ai_market_read()` when
        ANTHROPIC_API_KEY is set. Falls back to the deterministic template
        on any LLM failure (missing key, network, malformed JSON). The
        response shape is identical in both cases — only model_id differs.
        """
        tu = ticker.upper()
        snaps = _fetch_universe_snapshots()
        snap = snaps.get(tu)
        if snap is None:
            raise HTTPException(404, f"Ticker {tu} not in universe")
        profile = build_company_exposure_profile(
            ticker=tu,
            company_name=snap.get("company_name") or snap.get("companyName") or tu,
            sector=snap.get("sector") or "Unknown",
            industry=_industry_lookup().get(tu),
        )
        financials = _financials_from_snapshot(snap)
        signals = get_macro_signal_service().fetch_for_ticker(tu)
        risk = compute_risk_score(profile, financials, signals)
        opportunity = compute_opportunity_score(profile, financials, signals)
        feed_status = get_macro_signal_service().feed_status()

        read = compose_ai_market_read(
            ticker=tu,
            company_name=profile.company_name,
            sector=profile.sector,
            industry=profile.industry,
            risk=risk,
            opportunity=opportunity,
            exposure=profile,
            signals=signals,
            feed_status=feed_status,
        )
        return _serialize(read)

    # ─── Manual signal upload ───────────────────────────────────────────
    @router.post("/signals/manual")
    def post_manual_signal(payload: ManualSignalIn, request: Request) -> dict[str, Any]:
        """Create a macro signal by hand. OPERATOR ONLY — WALLED, fail closed.

        This route WRITES content the product then shows to users: the new
        signal feeds risk-radar, macro-signals and every per-ticker risk
        score (this handler busts those three caches itself, below). Until
        2026-09-04 it had no authentication of any kind — an anonymous POST
        with a valid payload answered 200 and the signal was live. That is
        content injection, not a cache bust.

        A rate limit would be the wrong control: it still admits one
        injected signal per window, and one is enough. So this follows
        tests/engine/test_cron_auth.py's fail-closed contract (503 with the
        token unset, 401 on a missing/wrong bearer) rather than the
        refresh_shield contract used by the cache-bust routes next door.
        See refresh_shield.require_operator for the full justification.
        """
        _require_operator(request, route="/api/public/intelligence/signals/manual")
        svc = get_macro_signal_service()
        signal = svc.manual.create_signal(
            signal_type=payload.signal_type,
            title=payload.title,
            summary=payload.summary,
            severity=payload.severity,
            time_horizon=payload.time_horizon,
            affected_sectors=payload.affected_sectors,
            affected_industries=payload.affected_industries,
            affected_companies=payload.affected_companies,
            affected_tickers=payload.affected_tickers,
            geography=payload.geography,
            financial_impact_channels=payload.financial_impact_channels,
            risk_categories=payload.risk_categories,
            confidence=payload.confidence,
            source_label=payload.source_label,
            source_url=payload.source_url,
        )
        # Bust caches that depend on signal state.
        cache = get_intelligence_cache()
        cache.invalidate("risk-radar:")
        cache.invalidate("macro-signals:")
        cache.invalidate("risk-score:")
        return {"signal": _serialize(signal), "ok": True}

    # ─── Universe-wide risk-score batch ─────────────────────────────────
    @router.get("/risk-scores")
    def risk_scores_batch() -> dict[str, Any]:
        """One call → risk-score summary for every ticker in the universe.

        The universe-wide table needs an AI Risk column per row. Calling
        /companies/{ticker}/risk-score 200 times is wasteful — this endpoint
        builds + scores every profile in one pass and returns a compact
        summary keyed by ticker.

        Cached for SCORE_TTL_SEC (3 min) so frequent FE re-renders during
        sort/filter operations don't re-compute every time.
        """
        cache = get_intelligence_cache()

        def _compute():
            industry = _industry_lookup()
            profiles = build_universe_exposure_profiles(
                universe_module.DEFAULT_UNIVERSE,
                industry_lookup=industry,
            )
            snaps = _fetch_universe_snapshots()

            out: dict[str, dict[str, Any]] = {}
            for ticker, profile in profiles.items():
                snap = snaps.get(ticker, {})
                financials = _financials_from_snapshot(snap) if snap else {}
                # Signals matched per-ticker — at Phase A these come from
                # synthesized sector signals via the orchestrator.
                # Skipping per-ticker signal fetch here since the universe
                # batch is hot path; categories already reflect sector model.
                risk = compute_risk_score(profile, financials, [])
                opp = compute_opportunity_score(profile, financials, [])
                out[ticker] = {
                    "ticker": ticker,
                    "risk_score": risk.overall_risk_score,
                    "risk_level": risk.risk_level,
                    "main_risk": (
                        risk.top_risks[0].label if risk.top_risks else None
                    ),
                    "main_risk_severity": (
                        risk.top_risks[0].severity if risk.top_risks else None
                    ),
                    "opportunity_score": opp.overall_opportunity_score,
                    "opportunity_level": opp.strength_level,
                    "exposure_source": profile.source,
                    "confidence": profile.confidence,
                }
            return {
                "scores": out,
                "total": len(out),
                "feed_status": get_macro_signal_service().feed_status(),
                "computed_at": datetime.now(timezone.utc).isoformat(),
            }

        return cache.get_or_compute("risk-scores:universe:v1", SCORE_TTL_SEC, _compute)

    # ─── Filings cache freshness (Phase D.2) ────────────────────────────
    @router.post("/refresh-filings-cache")
    def refresh_filings_cache(request: Request) -> dict[str, Any]:
        """Poll EDGAR's recent-10-K Atom feed → invalidate stale cache.

        Operator wires this to a 15-minute cron / k8s CronJob. EDGAR's
        `getcurrent` feed updates ~10 min cycle, so 15-min cadence catches
        new filings without saturating. Single-source orchestration —
        external cron prevents N-pod multiplication of EDGAR load.

        OPERATOR ONLY — WALLED, fail closed. Unlike the cache-bust routes
        next door, this one does not merely make the NEXT read cold: it
        performs the EDGAR request itself, synchronously, inside the
        handler (run_refresh → _fetch_recent_10k_filings → urlopen). Until
        2026-09-04 it answered 200 unauthenticated, so an anonymous loop
        here was a direct outbound amplifier against a host-wide published
        ceiling of 10 req/s — and a block there takes the whole US market
        down. Its own docstring already said the only intended caller is a
        cron, and it has no caller in frontend/, e2e/, scripts/ or deploy/,
        so the fail-closed contract of tests/engine/test_cron_auth.py is
        the right one: running it unauthenticated is worse than not
        running it. See refresh_shield.require_operator.

        OPERATOR FOLLOW-UP: the cron line in
        docs/public-intelligence-activation-runbook.md curls this route
        with no Authorization header and will now 401. It must send
        `-H "Authorization: Bearer $ENGINE_API_TOKEN"`.
        """
        _require_operator(request, route="/api/public/intelligence/refresh-filings-cache")
        result = run_refresh()
        return result.to_dict()

    # ─── Cache refresh ──────────────────────────────────────────────────
    @router.post("/refresh-signals")
    def refresh_signals(request: Request) -> dict[str, Any]:
        """Bust the radar / macro / risk-score / exposure caches.

        SHIELDED (engine.public.refresh_shield): a valid ENGINE_API_TOKEN
        bearer is never limited; anonymous callers spend one token from a
        per-client bucket and get 429 + Retry-After over the budget. The
        guard runs BEFORE any cache is invalidated, so a 429 mutates
        nothing. With the token unset the bearer path is simply unavailable
        and the anonymous path still serves — deliberately NOT the
        fail-closed contract of tests/engine/test_cron_auth.py; see the
        shield's module docstring for why the asymmetry is intended.
        """
        limited = _refresh_guard(request, route="/api/public/intelligence/refresh-signals")
        if limited is not None:
            return limited  # type: ignore[return-value]
        cache = get_intelligence_cache()
        dropped = (
            cache.invalidate("risk-radar:")
            + cache.invalidate("macro-signals:")
            + cache.invalidate("risk-score:")
            + cache.invalidate("exposure:")
        )
        return {"cache_keys_invalidated": dropped, "ok": True}

    return router


def _derive_categories_for_profile(profile) -> list[str]:
    """Best-effort mapping of an exposure profile's risks → RiskCategory list."""
    cats = set()
    channel_to_cat = {
        "supply_availability": "supply_chain",
        "inventory": "supply_chain",
        "valuation_multiple": "rates_credit",
        "debt_cost": "rates_credit",
        "fx": "fx",
        "revenue": "consumer_demand",
        "capex": "technology",
    }
    for risk in profile.main_risks[:8]:
        for ch in risk.channels:
            if ch in channel_to_cat:
                cats.add(channel_to_cat[ch])
    return sorted(cats)


def _build_watchlist(profile, risk: PublicCompanyRiskScore) -> list[str]:
    """Produce a deterministic 'what to watch' list from the score breakdown.

    No LLM — just a template tied to top risks + category scores. The
    eventual Claude call will replace this with a richer per-ticker
    narrative.
    """
    items: list[str] = []
    if risk.top_risks:
        items.append(f"Watch {risk.top_risks[0].label} — {risk.top_risks[0].severity} severity.")
    if risk.categories.financial >= 60:
        items.append("Watch upcoming refinancings + interest coverage trend.")
    if risk.categories.supply_chain >= 60:
        items.append("Watch shipping cost + supplier concentration disclosures.")
    if risk.categories.geopolitical >= 60:
        items.append("Watch regional revenue exposure breakdown in next 10-K.")
    if risk.categories.valuation >= 60:
        items.append("Watch peer-relative valuation — multiple compression risk.")
    if not items:
        items.append("No specific watch flags — score is composite-low.")
    return items
