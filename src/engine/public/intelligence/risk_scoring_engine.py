"""Deterministic public-company risk-scoring engine.

Per brief §10: "Do not let AI produce the numeric score alone. AI can
interpret and explain." This module is the ONLY place numeric risk scores
are produced. It takes inputs and returns a deterministic int. Same inputs
always produce the same output (proved by tests/intelligence/test_risk_scoring_engine.py).

Score architecture — composite 0–100, weighted across 7 categories:

  category               weight   inputs
  ─────────────────────────────────────────────────────────────────────
  macro          (sector signals + theme overlays + macro feed)   0.18
  supply_chain   (supply_chain_exposure × outstanding signals)    0.17
  geopolitical   (geographic_exposure × geopolitical signals)     0.13
  financial      (leverage + interest coverage + margin)          0.22
  valuation      (EV/EBITDA + P/E vs peer median)                 0.10
  operational    (capex maturity + inventory turns)               0.10
  regulatory     (regulation signals tied to sector + geography)  0.10
  ─────────────────────────────────────────────────────────────────────
                                                          sum =  1.00

Each category is itself a 0–100 number. The overall_risk_score is the
weighted sum, rounded. Category weights are NOT operator-tunable to keep
the score comparable across companies and stable across time.

Tunable parameters live at the top of this file as named constants. To
calibrate, change a constant + re-run the wrong-on-purpose test fixtures.

Inputs are READ-ONLY references to existing types — we don't mutate the
canonical envelope, the exposure profile, or the signal list.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from .models import (
    CompanyExposureProfile,
    IntelligenceSignal,
    OpportunityItem,
    PublicCompanyRiskScore,
    RiskCategoryScores,
    RiskItem,
    Severity,
)
from .sector_risk_library import (
    SECTOR_RISK_LIBRARY,
)


# ─────────────────────────────────────────────────────────────────────────
# Tunable constants — change these to calibrate, not the per-call code.
# ─────────────────────────────────────────────────────────────────────────

CATEGORY_WEIGHTS: dict[str, float] = {
    "macro": 0.18,
    "supply_chain": 0.17,
    "geopolitical": 0.13,
    "financial": 0.22,
    "valuation": 0.10,
    "operational": 0.10,
    "regulatory": 0.10,
}
assert abs(sum(CATEGORY_WEIGHTS.values()) - 1.0) < 1e-9, "weights must sum to 1.0"

# Severity → 0–100 contribution. Used everywhere a sector risk or signal
# converts into a numeric add to a category score. Symmetric for opportunity.
SEVERITY_POINTS: dict[Severity, int] = {
    "low": 15,
    "medium": 35,
    "high": 60,
    "critical": 85,
}

# Risk-level cutoffs (overall_risk_score → category label).
RISK_LEVEL_CUTOFFS: list[tuple[int, Severity]] = [
    (75, "critical"),
    (50, "high"),
    (25, "medium"),
    (0,  "low"),
]

# Financial-sub-score thresholds (per category 0–100).
# Net Debt / EBITDA tiers.
NDE_TIERS: list[tuple[float, int]] = [
    (1.0, 10),   # NDE ≤ 1×    → 10 risk points (very low)
    (2.0, 25),
    (3.0, 45),
    (4.0, 65),
    (5.0, 80),
    (float("inf"), 95),
]

# Interest coverage (EBITDA / interest) tiers — inverted: lower = riskier.
ICR_TIERS_INVERSE: list[tuple[float, int]] = [
    (10.0, 5),   # ICR ≥ 10×    → 5 risk points (very safe)
    (5.0, 20),
    (3.0, 40),
    (2.0, 60),
    (1.0, 80),
    (0.0, 95),
]

# EBITDA margin tiers — inverted (lower margin = higher operating risk).
EBITDA_MARGIN_TIERS_INVERSE: list[tuple[float, int]] = [
    (0.25, 10),  # ≥25%        → 10 risk points
    (0.15, 25),
    (0.08, 45),
    (0.03, 65),
    (0.00, 80),
    (-1.00, 95), # negative    → 95
]


def _tier_score(value: Optional[float], tiers: list[tuple[float, int]]) -> int:
    """Score `value` against (threshold, points) tiers. Picks first matching tier."""
    if value is None:
        return 50  # neutral when unknown
    for threshold, points in tiers:
        if value <= threshold:
            return points
    return tiers[-1][1]


def _tier_score_inverse(value: Optional[float], tiers: list[tuple[float, int]]) -> int:
    """Score for inversely-ordered tiers (e.g. coverage where HIGHER is better)."""
    if value is None:
        return 50
    for threshold, points in tiers:
        if value >= threshold:
            return points
    return tiers[-1][1]


def _safe_div(a: Optional[float], b: Optional[float]) -> Optional[float]:
    if a is None or b is None or b == 0:
        return None
    return a / b


# ─────────────────────────────────────────────────────────────────────────
# Category sub-scorers
# ─────────────────────────────────────────────────────────────────────────

def _score_financial(financials: dict[str, Any]) -> int:
    """Financial-health risk score from canonical financial snapshot.

    Inputs (all optional — score degrades gracefully when missing):
      · net_debt_to_ebitda
      · ebitda_margin (0–1, not %)
      · interest_coverage = ebitda / interest_expense (computed if absent)
      · debt_to_equity (informational tilt only)
    """
    nde = financials.get("net_debt_to_ebitda")
    ebitda_margin = financials.get("ebitda_margin")
    icr = financials.get("interest_coverage")

    # If ICR not provided but ebitda + interest_expense are, compute it.
    if icr is None:
        icr = _safe_div(financials.get("ebitda"), financials.get("interest_expense"))

    nde_score = _tier_score(nde, NDE_TIERS)
    icr_score = _tier_score_inverse(icr, ICR_TIERS_INVERSE)
    margin_score = _tier_score_inverse(ebitda_margin, EBITDA_MARGIN_TIERS_INVERSE)

    # Weighted average of three components.
    return int(round(0.40 * nde_score + 0.30 * icr_score + 0.30 * margin_score))


def _score_valuation(financials: dict[str, Any], sector: str) -> int:
    """Valuation-rich risk score. High multiples → high risk.

    Sector-relative would be ideal but Phase A uses absolute thresholds.
    Phase B can wire in peer-median comparison once we wire benchmark data.
    """
    ev_ebitda = financials.get("ev_to_ebitda")
    pe = financials.get("pe_ratio")

    ev_score = 50
    if ev_ebitda is not None:
        if ev_ebitda <= 6:    ev_score = 10
        elif ev_ebitda <= 10: ev_score = 25
        elif ev_ebitda <= 15: ev_score = 45
        elif ev_ebitda <= 20: ev_score = 65
        elif ev_ebitda <= 30: ev_score = 80
        else:                 ev_score = 92

    pe_score = 50
    if pe is not None:
        if pe <= 10:     pe_score = 10
        elif pe <= 18:   pe_score = 25
        elif pe <= 25:   pe_score = 45
        elif pe <= 35:   pe_score = 65
        elif pe <= 50:   pe_score = 80
        else:            pe_score = 92

    return int(round(0.5 * ev_score + 0.5 * pe_score))


def _score_macro(
    exposure: CompanyExposureProfile,
    matched_signals: list[IntelligenceSignal],
) -> int:
    """Macro risk: severity-weighted sector risks + macro-typed signals."""
    base = 0
    sector_risks = exposure.main_risks
    if sector_risks:
        # Average severity points across the top 5 sector risks.
        top = sector_risks[:5]
        base = sum(SEVERITY_POINTS[r.severity] for r in top) / len(top)

    signal_bump = 0
    for sig in matched_signals:
        if sig.signal_type in {"interest_rates", "fx", "energy", "commodity", "consumer_demand"}:
            signal_bump += SEVERITY_POINTS[sig.severity] / 6  # diluted contribution

    return int(min(100, round(base + signal_bump)))


def _score_supply_chain(
    exposure: CompanyExposureProfile,
    matched_signals: list[IntelligenceSignal],
) -> int:
    """Supply-chain risk: exposure intensity × outstanding supply-chain signals."""
    intensity = max(exposure.supply_chain_exposure.values(), default=0.0)

    signal_bump = 0
    for sig in matched_signals:
        if sig.signal_type in {"supply_chain", "commodity"}:
            signal_bump += SEVERITY_POINTS[sig.severity] / 4

    base = intensity * 70
    return int(min(100, round(base + signal_bump)))


def _score_geopolitical(
    exposure: CompanyExposureProfile,
    matched_signals: list[IntelligenceSignal],
) -> int:
    """Geopolitical risk: exposure to risky geographies × signal presence."""
    risky_geos = {"china", "taiwan", "middle_east", "russia_ukraine", "russia"}
    risky_exposure = sum(
        v for k, v in exposure.geographic_exposure.items() if k in risky_geos
    )

    signal_bump = 0
    for sig in matched_signals:
        if sig.signal_type == "geopolitical":
            signal_bump += SEVERITY_POINTS[sig.severity] / 3

    base = risky_exposure * 80
    return int(min(100, round(base + signal_bump)))


def _score_operational(financials: dict[str, Any], sector: str) -> int:
    """Operational risk: revenue growth direction + capex intensity."""
    rev_growth = financials.get("revenue_growth")
    capex_intensity = _safe_div(financials.get("capex"), financials.get("revenue"))

    growth_score = 50
    if rev_growth is not None:
        if rev_growth >= 0.20:     growth_score = 10
        elif rev_growth >= 0.10:   growth_score = 20
        elif rev_growth >= 0.05:   growth_score = 35
        elif rev_growth >= 0.00:   growth_score = 50
        elif rev_growth >= -0.05:  growth_score = 70
        else:                      growth_score = 88

    capex_score = 50
    if capex_intensity is not None:
        # Capex intensity isn't strictly risk-positive — high capex in growth
        # sectors is a feature, not a bug. Use it as a milder signal.
        ci = abs(capex_intensity)
        if ci <= 0.05:    capex_score = 30
        elif ci <= 0.10:  capex_score = 40
        elif ci <= 0.20:  capex_score = 55
        elif ci <= 0.30:  capex_score = 70
        else:             capex_score = 80

    return int(round(0.6 * growth_score + 0.4 * capex_score))


def _score_regulatory(
    exposure: CompanyExposureProfile,
    matched_signals: list[IntelligenceSignal],
) -> int:
    """Regulatory risk: regulation-intensive supply-chain dimension + signals."""
    reg_intensity = exposure.supply_chain_exposure.get("regulation", 0.0)

    signal_bump = 0
    for sig in matched_signals:
        if sig.signal_type == "regulation":
            signal_bump += SEVERITY_POINTS[sig.severity] / 3

    return int(min(100, round(reg_intensity * 75 + signal_bump)))


# ─────────────────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────────────────

def compute_risk_score(
    exposure: CompanyExposureProfile,
    financials: dict[str, Any],
    matched_signals: Optional[list[IntelligenceSignal]] = None,
) -> PublicCompanyRiskScore:
    """Compute the deterministic 0–100 risk score for a single ticker.

    `financials` is a flat dict pulled from PublicCompanyFinancialSnapshot.
    Required keys are documented per-sub-scorer above; missing keys degrade
    that category to a neutral 50, never to 100.

    `matched_signals` is the subset of IntelligenceSignals where this
    ticker appears in `affected_tickers`. The signal_orchestrator owns
    the match logic; this engine just consumes the result.

    The function is pure — same inputs always return the same output.
    Test enforced via tests/intelligence/test_risk_scoring_engine.py.
    """
    signals = matched_signals or []

    cat_macro = _score_macro(exposure, signals)
    cat_supply = _score_supply_chain(exposure, signals)
    cat_geo = _score_geopolitical(exposure, signals)
    cat_fin = _score_financial(financials)
    cat_val = _score_valuation(financials, exposure.sector)
    cat_op = _score_operational(financials, exposure.sector)
    cat_reg = _score_regulatory(exposure, signals)

    categories = RiskCategoryScores(
        macro=cat_macro,
        supply_chain=cat_supply,
        geopolitical=cat_geo,
        financial=cat_fin,
        valuation=cat_val,
        operational=cat_op,
        regulatory=cat_reg,
    )

    overall = int(round(
        CATEGORY_WEIGHTS["macro"]        * cat_macro +
        CATEGORY_WEIGHTS["supply_chain"] * cat_supply +
        CATEGORY_WEIGHTS["geopolitical"] * cat_geo +
        CATEGORY_WEIGHTS["financial"]    * cat_fin +
        CATEGORY_WEIGHTS["valuation"]    * cat_val +
        CATEGORY_WEIGHTS["operational"]  * cat_op +
        CATEGORY_WEIGHTS["regulatory"]   * cat_reg
    ))
    overall = max(0, min(100, overall))

    # Risk-level label from cutoffs.
    risk_level: Severity = "low"
    for cutoff, label in RISK_LEVEL_CUTOFFS:
        if overall >= cutoff:
            risk_level = label
            break

    # Top 3 risks for surface (each weighted by score_contribution).
    top_risks = _top_risks(exposure, categories, signals, n=3)
    top_opps = _top_opportunities(exposure, categories, n=3)

    explanation = _build_explanation(
        ticker=exposure.ticker,
        overall=overall,
        risk_level=risk_level,
        categories=categories,
        top_risks=top_risks,
    )

    return PublicCompanyRiskScore(
        ticker=exposure.ticker,
        overall_risk_score=overall,
        risk_level=risk_level,
        categories=categories,
        top_risks=top_risks,
        top_opportunities=top_opps,
        explanation=explanation,
        confidence=exposure.confidence,
        computed_at=datetime.now(timezone.utc),
    )


def _top_risks(
    exposure: CompanyExposureProfile,
    categories: RiskCategoryScores,
    signals: list[IntelligenceSignal],
    n: int = 3,
) -> list[RiskItem]:
    """Select top-N risks by score_contribution.

    score_contribution is the company-specific magnitude — not the sector
    default. We compute it as `severity_points × category_weight × 100`
    so a critical-severity supply_chain risk in a high-supply-chain-score
    company contributes more than the same risk in a low-exposure company.
    """
    if not exposure.main_risks:
        return []

    items: list[RiskItem] = []
    for risk in exposure.main_risks:
        sev_pts = SEVERITY_POINTS[risk.severity]
        # Heuristic: map a risk to its most-relevant category by inspecting
        # the channels. supply_availability → supply_chain, valuation_multiple
        # → valuation, etc. Defaults to macro.
        cat_weight = _risk_to_category_weight(risk.channels, categories)
        score_contrib = int(round(sev_pts * cat_weight))
        related_signal_ids = [
            s.id for s in signals
            if any(c in s.financial_impact_channels for c in risk.channels)
        ][:3]
        items.append(RiskItem(
            key=risk.key,
            label=risk.label,
            severity=risk.severity,
            score_contribution=score_contrib,
            channels=list(risk.channels),
            source_signal_ids=related_signal_ids,
        ))

    items.sort(key=lambda i: i.score_contribution, reverse=True)
    return items[:n]


def _top_opportunities(
    exposure: CompanyExposureProfile,
    categories: RiskCategoryScores,
    n: int = 3,
) -> list[OpportunityItem]:
    if not exposure.main_opportunities:
        return []

    items: list[OpportunityItem] = []
    for opp in exposure.main_opportunities:
        sev_pts = SEVERITY_POINTS[opp.severity]
        items.append(OpportunityItem(
            key=opp.key,
            label=opp.label,
            strength=opp.severity,
            score_contribution=sev_pts,
            channels=list(opp.channels),
            source_signal_ids=[],
        ))

    items.sort(key=lambda i: i.score_contribution, reverse=True)
    return items[:n]


def _risk_to_category_weight(
    channels: list[str],
    categories: RiskCategoryScores,
) -> float:
    """Map a risk's financial-impact channels → the most-relevant category score.

    Returns a 0–1 weight in the spirit of "how relevant is this risk to the
    overall picture?" A risk in a high-scoring category gets a higher weight
    so the top-N selection emphasizes the company's actual pain points.
    """
    channel_to_cat = {
        "supply_availability": ("supply_chain", categories.supply_chain),
        "inventory":            ("supply_chain", categories.supply_chain),
        "valuation_multiple":   ("valuation",    categories.valuation),
        "debt_cost":            ("financial",    categories.financial),
        "capex":                ("operational",  categories.operational),
        "fx":                   ("macro",        categories.macro),
        "working_capital":      ("operational",  categories.operational),
        "revenue":              ("macro",        categories.macro),
        "gross_margin":         ("operational",  categories.operational),
        "ebitda_margin":        ("financial",    categories.financial),
    }
    # Pick the maximum category score across the risk's channels — that's
    # the "loudest" alignment between the risk and the company's pressure.
    best = 0.0
    for ch in channels:
        if ch in channel_to_cat:
            _, score = channel_to_cat[ch]
            best = max(best, score / 100.0)
    return max(0.3, best)  # never less than 0.3 so a risk always shows up


def _build_explanation(
    ticker: str,
    overall: int,
    risk_level: Severity,
    categories: RiskCategoryScores,
    top_risks: list[RiskItem],
) -> str:
    """Deterministic short sentence. NO LLM.

    LLM-driven narrative lives in ai_market_read.py.
    """
    parts = [f"{ticker} composite risk {overall}/100 ({risk_level})."]
    # Identify the loudest category.
    cat_dict = {
        "financial":     categories.financial,
        "supply_chain":  categories.supply_chain,
        "geopolitical":  categories.geopolitical,
        "macro":         categories.macro,
        "valuation":     categories.valuation,
        "operational":   categories.operational,
        "regulatory":    categories.regulatory,
    }
    loudest_cat, loudest_score = max(cat_dict.items(), key=lambda kv: kv[1])
    parts.append(f"Highest pressure: {loudest_cat.replace('_',' ')} ({loudest_score}/100).")
    if top_risks:
        parts.append(f"Top risk: {top_risks[0].label}.")
    return " ".join(parts)
