"""Symmetric opportunity-scoring engine.

Mirror of risk_scoring_engine.py: same architecture, same severity-points
math, opposite polarity. Outputs PublicCompanyOpportunityScore where higher
= stronger tailwind.

Per brief §11. Opportunity inputs:
  · Sector opportunities (e.g. AI capex beneficiary, GLP-1 ramp)
  · Theme opportunities (e.g. defense spending, AI datacenter buildout)
  · Financial-quality flags (low leverage, strong FCF, healthy margin)
  · Valuation flags (undervaluation vs peers — Phase A absolute; Phase B peer-median)
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from .models import (
    CompanyExposureProfile,
    IntelligenceSignal,
    OpportunityItem,
    PublicCompanyOpportunityScore,
    Severity,
)
from .risk_scoring_engine import SEVERITY_POINTS  # reuse the same scale


OPPORTUNITY_CATEGORY_WEIGHTS: dict[str, float] = {
    "sector_tailwind": 0.45,
    "financial_quality": 0.30,
    "valuation_discount": 0.15,
    "market_position": 0.10,
}
assert abs(sum(OPPORTUNITY_CATEGORY_WEIGHTS.values()) - 1.0) < 1e-9

STRENGTH_LEVEL_CUTOFFS: list[tuple[int, Severity]] = [
    (75, "critical"),  # "exceptional opportunity"
    (50, "high"),
    (25, "medium"),
    (0,  "low"),
]


def _score_sector_tailwind(exposure: CompanyExposureProfile) -> int:
    if not exposure.main_opportunities:
        return 0
    top = exposure.main_opportunities[:3]
    return int(round(sum(SEVERITY_POINTS[o.severity] for o in top) / max(len(top), 1)))


def _score_financial_quality(financials: dict[str, Any]) -> int:
    """Strong FCF, low leverage, healthy margin → high quality score."""
    score = 0

    fcf_yield = financials.get("fcf_yield")
    if fcf_yield is not None:
        if fcf_yield >= 0.08:    score += 30
        elif fcf_yield >= 0.05:  score += 22
        elif fcf_yield >= 0.03:  score += 14
        elif fcf_yield >= 0.00:  score += 6

    nde = financials.get("net_debt_to_ebitda")
    if nde is not None:
        if nde <= 0:        score += 30
        elif nde <= 1.0:    score += 22
        elif nde <= 2.0:    score += 14
        elif nde <= 3.0:    score += 6

    ebitda_margin = financials.get("ebitda_margin")
    if ebitda_margin is not None:
        if ebitda_margin >= 0.30:    score += 25
        elif ebitda_margin >= 0.20:  score += 18
        elif ebitda_margin >= 0.10:  score += 10
        elif ebitda_margin >= 0.05:  score += 4

    roe = financials.get("roe")
    if roe is not None and roe >= 0.20:
        score += 15
    elif roe is not None and roe >= 0.12:
        score += 8

    return min(100, score)


def _score_valuation_discount(financials: dict[str, Any]) -> int:
    """Cheap on absolute valuation = opportunity score lift.

    Phase A uses absolute thresholds. Phase B will use peer-median.
    """
    ev_ebitda = financials.get("ev_to_ebitda")
    pe = financials.get("pe_ratio")

    ev_score = 0
    if ev_ebitda is not None:
        if ev_ebitda <= 6:    ev_score = 80
        elif ev_ebitda <= 8:  ev_score = 65
        elif ev_ebitda <= 10: ev_score = 45
        elif ev_ebitda <= 12: ev_score = 25
        else:                 ev_score = 10

    pe_score = 0
    if pe is not None:
        if pe <= 10:    pe_score = 80
        elif pe <= 13:  pe_score = 65
        elif pe <= 18:  pe_score = 45
        elif pe <= 22:  pe_score = 25
        else:           pe_score = 10

    return int(round(0.5 * ev_score + 0.5 * pe_score))


def _score_market_position(financials: dict[str, Any]) -> int:
    """Market-cap proxy for 'too-big-to-ignore' positioning.

    Crude: large market cap → bias toward incumbency advantage. The
    accurate version uses market share + brand strength, which we don't
    have at MVP. Phase B can refine.
    """
    market_cap = financials.get("market_cap")
    if market_cap is None:
        return 30
    if market_cap >= 500_000_000_000:    return 75  # ≥ $500B
    if market_cap >= 100_000_000_000:    return 60
    if market_cap >= 50_000_000_000:     return 45
    if market_cap >= 10_000_000_000:     return 30
    return 15


def compute_opportunity_score(
    exposure: CompanyExposureProfile,
    financials: dict[str, Any],
    matched_signals: Optional[list[IntelligenceSignal]] = None,
) -> PublicCompanyOpportunityScore:
    """Deterministic opportunity score, 0–100. Higher = stronger tailwind."""
    sector_tail = _score_sector_tailwind(exposure)
    fin_qual = _score_financial_quality(financials)
    val_disc = _score_valuation_discount(financials)
    mkt_pos = _score_market_position(financials)

    overall = int(round(
        OPPORTUNITY_CATEGORY_WEIGHTS["sector_tailwind"]    * sector_tail +
        OPPORTUNITY_CATEGORY_WEIGHTS["financial_quality"]  * fin_qual +
        OPPORTUNITY_CATEGORY_WEIGHTS["valuation_discount"] * val_disc +
        OPPORTUNITY_CATEGORY_WEIGHTS["market_position"]    * mkt_pos
    ))
    overall = max(0, min(100, overall))

    strength_level: Severity = "low"
    for cutoff, label in STRENGTH_LEVEL_CUTOFFS:
        if overall >= cutoff:
            strength_level = label
            break

    top_opportunities = _top_opps(exposure, fin_qual, val_disc, n=3)

    explanation = _build_explanation(
        ticker=exposure.ticker,
        overall=overall,
        strength_level=strength_level,
        top_opportunities=top_opportunities,
    )

    return PublicCompanyOpportunityScore(
        ticker=exposure.ticker,
        overall_opportunity_score=overall,
        strength_level=strength_level,
        top_opportunities=top_opportunities,
        explanation=explanation,
        confidence=exposure.confidence,
        computed_at=datetime.now(timezone.utc),
    )


def _top_opps(
    exposure: CompanyExposureProfile,
    fin_qual_score: int,
    val_disc_score: int,
    n: int = 3,
) -> list[OpportunityItem]:
    items: list[OpportunityItem] = []

    # Sector / theme opportunities.
    for opp in exposure.main_opportunities:
        items.append(OpportunityItem(
            key=opp.key,
            label=opp.label,
            strength=opp.severity,
            score_contribution=SEVERITY_POINTS[opp.severity],
            channels=list(opp.channels),
            source_signal_ids=[],
        ))

    # Synthetic financial-quality opportunity if score is strong.
    if fin_qual_score >= 60:
        items.append(OpportunityItem(
            key="financial_quality",
            label="Strong financial quality (margin + FCF + low leverage)",
            strength="high" if fin_qual_score >= 75 else "medium",
            score_contribution=fin_qual_score,
            channels=["ebitda_margin", "debt_cost"],
            source_signal_ids=[],
        ))

    if val_disc_score >= 60:
        items.append(OpportunityItem(
            key="valuation_discount",
            label="Trading at attractive valuation",
            strength="high" if val_disc_score >= 75 else "medium",
            score_contribution=val_disc_score,
            channels=["valuation_multiple"],
            source_signal_ids=[],
        ))

    items.sort(key=lambda i: i.score_contribution, reverse=True)
    return items[:n]


def _build_explanation(
    ticker: str,
    overall: int,
    strength_level: Severity,
    top_opportunities: list[OpportunityItem],
) -> str:
    parts = [f"{ticker} opportunity score {overall}/100 ({strength_level})."]
    if top_opportunities:
        parts.append(f"Top driver: {top_opportunities[0].label}.")
    return " ".join(parts)
