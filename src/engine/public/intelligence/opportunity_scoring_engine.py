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
    ScoreRefusal,
    Severity,
)
from .risk_scoring_engine import (  # reuse the same scale and refusal vocabulary
    INPUT_LABELS as _RISK_INPUT_LABELS,
    SCORE_RANGE,
    SEVERITY_POINTS,
    InputGaps,
    exposure_is_modelled,
    join_names,
    read_net_debt_to_ebitda,
    read_positive_multiple,
)


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

# Refusal codes. Every sub-score below used to score an absent input as
# its worst reading (0 points) — or, for market cap, as a fixed 30 — so a
# ticker with no financial data at all served 26/100 "medium", within two
# points of a fully-measured worst case (measured 2026-09-15).
OPPORTUNITY_CATEGORY_UNAVAILABLE = "opportunity_category_unavailable"
OPPORTUNITY_COMPOSITE_UNAVAILABLE = "opportunity_composite_unavailable"
OPPORTUNITY_SCORE_OUT_OF_RANGE = "opportunity_score_out_of_range"

CATEGORY_LABELS: dict[str, str] = {
    "sector_tailwind": "Sector tailwind",
    "financial_quality": "Financial quality",
    "valuation_discount": "Valuation discount",
    "market_position": "Market position",
}

INPUT_LABELS: dict[str, str] = {
    **_RISK_INPUT_LABELS,
    "fcf_yield": "FCF yield",
    "roe": "ROE",
    "market_cap": "market cap",
}

Scored = tuple[Optional[int], Optional[ScoreRefusal]]


def _refusal(gaps: InputGaps, category: str) -> ScoreRefusal:
    return gaps.refusal(
        code=OPPORTUNITY_CATEGORY_UNAVAILABLE,
        component=category,
        subject=f"{CATEGORY_LABELS[category]} opportunity",
        labels=INPUT_LABELS,
    )


def _score_sector_tailwind(exposure: CompanyExposureProfile) -> Scored:
    if not exposure_is_modelled(exposure):
        return None, ScoreRefusal(
            code=OPPORTUNITY_CATEGORY_UNAVAILABLE,
            component="sector_tailwind",
            inputs=["sector_exposure_model"],
            text=(
                "Sector tailwind opportunity unavailable: sector "
                f"'{exposure.sector}' has no exposure model."
            ),
        )
    if not exposure.main_opportunities:
        # A modelled sector that lists no opportunities declares no tailwind.
        return 0, None
    top = exposure.main_opportunities[:3]
    return int(round(sum(SEVERITY_POINTS[o.severity] for o in top) / len(top))), None


def _score_financial_quality(financials: dict[str, Any]) -> Scored:
    """Strong FCF, low leverage, healthy margin → high quality score.

    All four inputs required. A MEASURED value below every threshold adds
    0 points — that is its reading; an absent one refuses the category.
    """
    gaps = InputGaps()
    fcf_yield = gaps.read(financials, "fcf_yield")
    nde = read_net_debt_to_ebitda(financials, gaps)
    ebitda_margin = gaps.read(financials, "ebitda_margin")
    roe = gaps.read(financials, "roe")
    if gaps:
        return None, _refusal(gaps, "financial_quality")

    score = 0
    if fcf_yield >= 0.08:    score += 30
    elif fcf_yield >= 0.05:  score += 22
    elif fcf_yield >= 0.03:  score += 14
    elif fcf_yield >= 0.00:  score += 6

    # EBITDA > 0 is guaranteed by read_net_debt_to_ebitda, so nde <= 0 is
    # net cash.
    if nde <= 0:        score += 30
    elif nde <= 1.0:    score += 22
    elif nde <= 2.0:    score += 14
    elif nde <= 3.0:    score += 6

    if ebitda_margin >= 0.30:    score += 25
    elif ebitda_margin >= 0.20:  score += 18
    elif ebitda_margin >= 0.10:  score += 10
    elif ebitda_margin >= 0.05:  score += 4

    if roe >= 0.20:
        score += 15
    elif roe >= 0.12:
        score += 8

    # The point ladders top out at 30 + 30 + 25 + 15 = 100.
    return score, None


def _score_valuation_discount(financials: dict[str, Any]) -> Scored:
    """Cheap on absolute valuation = opportunity score lift.

    Phase A uses absolute thresholds. Phase B will use peer-median. Both
    multiples required and positive.
    """
    gaps = InputGaps()
    ev_ebitda = read_positive_multiple(
        financials, "ev_to_ebitda", "EBITDA or enterprise value is not positive", gaps)
    pe = read_positive_multiple(financials, "pe_ratio", "earnings are not positive", gaps)
    if gaps:
        return None, _refusal(gaps, "valuation_discount")

    if ev_ebitda <= 6:    ev_score = 80
    elif ev_ebitda <= 8:  ev_score = 65
    elif ev_ebitda <= 10: ev_score = 45
    elif ev_ebitda <= 12: ev_score = 25
    else:                 ev_score = 10

    if pe <= 10:    pe_score = 80
    elif pe <= 13:  pe_score = 65
    elif pe <= 18:  pe_score = 45
    elif pe <= 22:  pe_score = 25
    else:           pe_score = 10

    return int(round(0.5 * ev_score + 0.5 * pe_score)), None


def _score_market_position(financials: dict[str, Any]) -> Scored:
    """Market-cap proxy for 'too-big-to-ignore' positioning.

    Crude: large market cap → bias toward incumbency advantage. The
    accurate version uses market share + brand strength, which we don't
    have at MVP. Phase B can refine. Market cap is required: it used to
    default to 30, the same score as a measured $10-50B cap.
    """
    gaps = InputGaps()
    market_cap = gaps.read(financials, "market_cap")
    if market_cap is not None and market_cap <= 0:
        gaps.reject("market_cap", "is not positive")
    if gaps:
        return None, _refusal(gaps, "market_position")
    if market_cap >= 500_000_000_000:    return 75, None  # ≥ $500B
    if market_cap >= 100_000_000_000:    return 60, None
    if market_cap >= 50_000_000_000:     return 45, None
    if market_cap >= 10_000_000_000:     return 30, None
    return 15, None


def compute_opportunity_score(
    exposure: CompanyExposureProfile,
    financials: dict[str, Any],
    matched_signals: Optional[list[IntelligenceSignal]] = None,
) -> PublicCompanyOpportunityScore:
    """Deterministic opportunity score, 0–100. Higher = stronger tailwind.

    None — with ``refusals`` — unless every weighted category is measured.
    """
    scored: dict[str, Scored] = {
        "sector_tailwind": _score_sector_tailwind(exposure),
        "financial_quality": _score_financial_quality(financials),
        "valuation_discount": _score_valuation_discount(financials),
        "market_position": _score_market_position(financials),
    }
    refusals: list[ScoreRefusal] = [v[1] for v in scored.values() if v[1] is not None]

    overall: Optional[int] = None
    strength_level: Optional[Severity] = None
    refused = [k for k in OPPORTUNITY_CATEGORY_WEIGHTS if scored[k][0] is None]
    if refused:
        refusals.append(ScoreRefusal(
            code=OPPORTUNITY_COMPOSITE_UNAVAILABLE,
            component="overall",
            inputs=refused,
            text=(
                "Opportunity score unavailable: "
                f"{join_names([CATEGORY_LABELS[k].lower() for k in refused])} "
                f"inputs not reported for {exposure.ticker}."
            ),
        ))
    else:
        overall = int(round(sum(
            OPPORTUNITY_CATEGORY_WEIGHTS[k] * scored[k][0]
            for k in OPPORTUNITY_CATEGORY_WEIGHTS
        )))
        lo, hi = SCORE_RANGE
        if not (lo <= overall <= hi):
            # Unreachable with the ladders above; out of range refuses.
            refusals.append(ScoreRefusal(
                code=OPPORTUNITY_SCORE_OUT_OF_RANGE,
                component="overall",
                inputs=list(OPPORTUNITY_CATEGORY_WEIGHTS),
                text=f"Opportunity score unavailable: computed {overall} is outside {lo}-{hi}.",
            ))
            overall = None
        else:
            strength_level = "low"
            for cutoff, label in STRENGTH_LEVEL_CUTOFFS:
                if overall >= cutoff:
                    strength_level = label
                    break

    fin_qual = scored["financial_quality"][0]
    val_disc = scored["valuation_discount"][0]
    top_opportunities = _top_opps(exposure, fin_qual, val_disc, n=3)

    explanation = _build_explanation(
        ticker=exposure.ticker,
        overall=overall,
        strength_level=strength_level,
        top_opportunities=top_opportunities,
        composite_refusal=next(
            (r for r in reversed(refusals) if r.component == "overall"), None
        ),
    )

    return PublicCompanyOpportunityScore(
        ticker=exposure.ticker,
        overall_opportunity_score=overall,
        strength_level=strength_level,
        top_opportunities=top_opportunities,
        explanation=explanation,
        confidence=exposure.confidence,
        computed_at=datetime.now(timezone.utc),
        refusals=refusals,
    )


def _top_opps(
    exposure: CompanyExposureProfile,
    fin_qual_score: Optional[int],
    val_disc_score: Optional[int],
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
    if fin_qual_score is not None and fin_qual_score >= 60:
        items.append(OpportunityItem(
            key="financial_quality",
            label="Strong financial quality (margin + FCF + low leverage)",
            strength="high" if fin_qual_score >= 75 else "medium",
            score_contribution=fin_qual_score,
            channels=["ebitda_margin", "debt_cost"],
            source_signal_ids=[],
        ))

    if val_disc_score is not None and val_disc_score >= 60:
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
    overall: Optional[int],
    strength_level: Optional[Severity],
    top_opportunities: list[OpportunityItem],
    composite_refusal: Optional[ScoreRefusal] = None,
) -> str:
    if overall is None:
        parts = [composite_refusal.text if composite_refusal is not None
                 else f"{ticker} opportunity score unavailable."]
    else:
        parts = [f"{ticker} opportunity score {overall}/100 ({strength_level})."]
    if top_opportunities:
        parts.append(f"Top driver: {top_opportunities[0].label}.")
    return " ".join(parts)
