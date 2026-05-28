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
  POST /api/public/intelligence/refresh-signals       — bust radar + signal cache
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel, Field

from .. import universe as universe_module
from ..universe_service import get_universe
from .company_exposure_service import (
    SECTOR_MODEL_CONFIDENCE,
    build_company_exposure_profile,
    build_universe_exposure_profiles,
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
            profiles = build_universe_exposure_profiles(
                universe_module.DEFAULT_UNIVERSE,
                industry_lookup=industry,
            )
            signals = synthesize_sector_signals()

            # Bucket signals + companies into 8 RiskCategory cards.
            categories: dict[str, dict[str, Any]] = {}
            for cat in (
                "geopolitical", "supply_chain", "energy", "rates_credit",
                "fx", "regulation", "technology", "consumer_demand",
            ):
                cat_signals = [s for s in signals if cat in s.risk_categories]
                affected_sectors = sorted({s for sig in cat_signals for s in sig.affected_sectors})
                affected_tickers = sorted({
                    t for ticker, prof in profiles.items()
                    if any(cat in _derive_categories_for_profile(prof) for _ in [None])
                    for t in [ticker]
                    if prof.sector in affected_sectors
                })[:12]  # cap to top-12 per card for FE rendering

                # Aggregate severity → 0-100 card score
                if cat_signals:
                    sev_avg = sum({"critical":85,"high":60,"medium":35,"low":15}[s.severity]
                                  for s in cat_signals) / len(cat_signals)
                else:
                    sev_avg = 0

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
    def post_manual_signal(payload: ManualSignalIn) -> dict[str, Any]:
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
    def refresh_filings_cache() -> dict[str, Any]:
        """Poll EDGAR's recent-10-K Atom feed → invalidate stale cache.

        Operator wires this to a 15-minute cron / k8s CronJob. EDGAR's
        `getcurrent` feed updates ~10 min cycle, so 15-min cadence catches
        new filings without saturating. Single-source orchestration —
        external cron prevents N-pod multiplication of EDGAR load.
        """
        result = run_refresh()
        return result.to_dict()

    # ─── Cache refresh ──────────────────────────────────────────────────
    @router.post("/refresh-signals")
    def refresh_signals() -> dict[str, Any]:
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
