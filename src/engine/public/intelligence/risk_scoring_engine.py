"""Deterministic public-company risk-scoring engine.

Per brief §10: "Do not let AI produce the numeric score alone. AI can
interpret and explain." This module is the ONLY place numeric risk scores
are produced. It takes inputs and returns a deterministic int. Same inputs
always produce the same output (proved by tests/intelligence/test_risk_scoring_engine.py).

Score architecture — composite 0–100, weighted across 7 categories
(the weights are ``CATEGORY_WEIGHTS`` below — the one copy):

  category       inputs
  ─────────────────────────────────────────────────────────────────────
  macro          sector signals + theme overlays + macro feed
  supply_chain   supply_chain_exposure × outstanding signals
  geopolitical   geographic_exposure × geopolitical signals
  financial      leverage + interest coverage + margin
  valuation      EV/EBITDA + P/E
  operational    revenue growth + capex intensity
  regulatory     regulation signals tied to sector + geography
  ─────────────────────────────────────────────────────────────────────

Each category is itself a 0–100 number — or None, with a ``ScoreRefusal``,
when an input it reads is absent, non-finite or outside the domain its
tiers are defined on. The overall_risk_score is the weighted sum, rounded,
and it is served only when EVERY weighted category is measured. Category
weights are NOT operator-tunable to keep the score comparable across
companies and stable across time, and they are never renormalised over
the measured subset (a renormalised composite is its own fabrication).

Tunable parameters live at the top of this file as named constants. To
calibrate, change a constant + re-run the wrong-on-purpose test fixtures.

Inputs are READ-ONLY references to existing types — we don't mutate the
canonical envelope, the exposure profile, or the signal list.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Optional

from .models import (
    CompanyExposureProfile,
    IntelligenceSignal,
    OpportunityItem,
    PublicCompanyRiskScore,
    RiskCategoryScores,
    RiskItem,
    ScoreRefusal,
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
# Net Debt / EBITDA tiers — defined over EBITDA > 0 only.
NDE_TIERS: list[tuple[float, int]] = [
    (1.0, 10),   # NDE ≤ 1× (net cash included) → 10 risk points
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

# Top-risk ordering: a sector risk whose channels map to no scored category
# still ranks at this relevance, so the sector library's risks always show.
# It orders the list; it is not an input to any score.
TOP_RISK_MIN_RELEVANCE = 0.3


# ─────────────────────────────────────────────────────────────────────────
# Refusal vocabulary. A category with an input that is absent, non-finite
# or outside the domain its tiers are defined on is NOT scored. It used to
# take a "neutral 50", and the composite was a weighted sum over those
# stand-ins (measured 2026-09-15: an unknown-sector ticker with no snapshot
# served 21/100 "low" — every point of it from the constants — with
# "Highest pressure: financial (50/100)" for a category with no data).
# ─────────────────────────────────────────────────────────────────────────

RISK_CATEGORY_UNAVAILABLE = "risk_category_unavailable"
RISK_COMPOSITE_UNAVAILABLE = "risk_composite_unavailable"
RISK_SCORE_OUT_OF_RANGE = "risk_score_out_of_range"

# Declared range of every category and of the composite.
SCORE_RANGE: tuple[int, int] = (0, 100)

# Reader-facing names of the fields the scorers read.
INPUT_LABELS: dict[str, str] = {
    "net_debt_to_ebitda": "net debt/EBITDA",
    "ebitda": "EBITDA",
    "ebitda_margin": "EBITDA margin",
    "interest_coverage": "interest coverage",
    "ev_to_ebitda": "EV/EBITDA",
    "pe_ratio": "P/E",
    "revenue_growth": "revenue growth",
    "capex": "capex",
    "revenue": "revenue",
    "sector_exposure_model": "a sector exposure model",
}

CATEGORY_LABELS: dict[str, str] = {
    "macro": "Macro",
    "supply_chain": "Supply-chain",
    "geopolitical": "Geopolitical",
    "financial": "Financial",
    "valuation": "Valuation",
    "operational": "Operational",
    "regulatory": "Regulatory",
}


def join_names(names: list[str]) -> str:
    """'a', 'a and b', 'a, b and c'."""
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def measured_number(value: Any) -> Optional[float]:
    """``value`` as a float when it is a finite real number, else None."""
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value):
        return None
    return float(value)


class InputGaps:
    """Collects why a category's inputs cannot be scored.

    Shared with opportunity_scoring_engine so both engines refuse in one
    vocabulary.
    """

    def __init__(self) -> None:
        self.absent: list[str] = []
        self.not_meaningful: list[tuple[str, str]] = []  # (field, why)

    def read(self, financials: dict[str, Any], key: str) -> Optional[float]:
        """The measured value of ``key``, or None with the gap recorded."""
        v = financials.get(key)
        if v is None or isinstance(v, bool) or not isinstance(v, (int, float)):
            self.absent.append(key)
            return None
        if not math.isfinite(v):
            self.not_meaningful.append((key, "is not a finite number"))
            return None
        return float(v)

    def reject(self, key: str, why: str) -> None:
        self.not_meaningful.append((key, why))

    def __bool__(self) -> bool:
        return bool(self.absent or self.not_meaningful)

    def refusal(
        self,
        *,
        code: str,
        component: str,
        subject: str,
        labels: dict[str, str],
    ) -> ScoreRefusal:
        parts: list[str] = []
        if self.absent:
            parts.append(
                f"{join_names([labels.get(k, k) for k in self.absent])} not reported "
                "in this snapshot"
            )
        for key, why in self.not_meaningful:
            parts.append(f"{labels.get(key, key)} {why}")
        return ScoreRefusal(
            code=code,
            component=component,
            inputs=list(self.absent) + [k for k, _ in self.not_meaningful],
            text=f"{subject} unavailable: " + "; ".join(parts) + ".",
        )


def _category_refusal(gaps: InputGaps, category: str) -> ScoreRefusal:
    return gaps.refusal(
        code=RISK_CATEGORY_UNAVAILABLE,
        component=category,
        subject=f"{CATEGORY_LABELS[category]} risk",
        labels=INPUT_LABELS,
    )


def _tier_score(value: float, tiers: list[tuple[float, int]]) -> int:
    """Score a MEASURED `value` against (threshold, points) tiers.

    Picks the first matching tier. Every ladder here ends at +inf, so a
    finite value always matches and the trailing return is unreachable.
    """
    for threshold, points in tiers:
        if value <= threshold:
            return points
    return tiers[-1][1]


def _tier_score_inverse(value: float, tiers: list[tuple[float, int]]) -> int:
    """Score for inversely-ordered tiers (e.g. coverage where HIGHER is better).

    A measured value below the last threshold takes the last (riskiest)
    tier: that is the defined bottom of the ladder, not a stand-in.
    """
    for threshold, points in tiers:
        if value >= threshold:
            return points
    return tiers[-1][1]


def read_net_debt_to_ebitda(financials: dict[str, Any], gaps: InputGaps) -> Optional[float]:
    """Net debt/EBITDA, read only where its tiers are defined: EBITDA > 0.

    Over a non-positive EBITDA the ratio's sign inverts — net debt over a
    loss reads as net cash — and the ≤1× tier would score an indebted
    loss-maker as the lowest leverage risk. EBITDA fixes the sign, so a
    ratio without it cannot be read either.
    """
    nde = gaps.read(financials, "net_debt_to_ebitda")
    if nde is None:
        return None
    ebitda = measured_number(financials.get("ebitda"))
    if ebitda is None:
        gaps.reject("net_debt_to_ebitda",
                    "cannot be read: EBITDA, which fixes its sign, is not reported")
        return None
    if ebitda <= 0:
        gaps.reject("net_debt_to_ebitda", "is not meaningful: EBITDA is not positive")
        return None
    return nde


def read_positive_multiple(
    financials: dict[str, Any], key: str, why: str, gaps: InputGaps
) -> Optional[float]:
    """A valuation multiple, read only when positive — a multiple over a
    non-positive denominator is not "cheap", it is undefined."""
    v = gaps.read(financials, key)
    if v is None:
        return None
    if v <= 0:
        gaps.reject(key, f"is not meaningful: {why}")
        return None
    return v


def exposure_is_modelled(exposure: CompanyExposureProfile) -> bool:
    """False for the empty shell built for a sector with no library entry.

    That shell carries empty exposure maps and confidence 0.0; the
    exposure-driven categories read those empty maps as 0 exposure, which
    is "no model", not "no exposure".
    """
    return not (
        exposure.source == "sector_model"
        and exposure.sector not in SECTOR_RISK_LIBRARY
    )


def _exposure_refusal(exposure: CompanyExposureProfile, category: str) -> ScoreRefusal:
    return ScoreRefusal(
        code=RISK_CATEGORY_UNAVAILABLE,
        component=category,
        inputs=["sector_exposure_model"],
        text=(
            f"{CATEGORY_LABELS[category]} risk unavailable: sector "
            f"'{exposure.sector}' has no exposure model."
        ),
    )


# ─────────────────────────────────────────────────────────────────────────
# Category sub-scorers — each returns (score, refusal); exactly one is None
# ─────────────────────────────────────────────────────────────────────────

Scored = tuple[Optional[int], Optional[ScoreRefusal]]


def _score_financial(financials: dict[str, Any]) -> Scored:
    """Financial-health risk score from canonical financial snapshot.

    Inputs — ALL required; the category refuses when any is unmeasured:
      · net_debt_to_ebitda (EBITDA > 0)
      · ebitda_margin (0–1, not %)
      · interest_coverage = ebitda / interest_expense (computed if absent)
    """
    gaps = InputGaps()
    nde = read_net_debt_to_ebitda(financials, gaps)
    ebitda_margin = gaps.read(financials, "ebitda_margin")

    if financials.get("interest_coverage") is not None:
        icr = gaps.read(financials, "interest_coverage")
    else:
        # Not provided: compute it when EBITDA and interest expense are both
        # measured and interest expense is non-zero.
        ebitda = measured_number(financials.get("ebitda"))
        interest = measured_number(financials.get("interest_expense"))
        icr = None
        if ebitda is None or interest is None:
            gaps.absent.append("interest_coverage")
        elif interest == 0:
            gaps.reject("interest_coverage", "is not defined: interest expense is zero")
        else:
            icr = ebitda / interest

    if gaps:
        return None, _category_refusal(gaps, "financial")

    nde_score = _tier_score(nde, NDE_TIERS)
    icr_score = _tier_score_inverse(icr, ICR_TIERS_INVERSE)
    margin_score = _tier_score_inverse(ebitda_margin, EBITDA_MARGIN_TIERS_INVERSE)

    # Weighted average of three components.
    return int(round(0.40 * nde_score + 0.30 * icr_score + 0.30 * margin_score)), None


def _score_valuation(financials: dict[str, Any], sector: str) -> Scored:
    """Valuation-rich risk score. High multiples → high risk.

    Sector-relative would be ideal but Phase A uses absolute thresholds.
    Both multiples are required and must be positive.
    """
    gaps = InputGaps()
    ev_ebitda = read_positive_multiple(
        financials, "ev_to_ebitda", "EBITDA or enterprise value is not positive", gaps)
    pe = read_positive_multiple(financials, "pe_ratio", "earnings are not positive", gaps)
    if gaps:
        return None, _category_refusal(gaps, "valuation")

    if ev_ebitda <= 6:    ev_score = 10
    elif ev_ebitda <= 10: ev_score = 25
    elif ev_ebitda <= 15: ev_score = 45
    elif ev_ebitda <= 20: ev_score = 65
    elif ev_ebitda <= 30: ev_score = 80
    else:                 ev_score = 92

    if pe <= 10:     pe_score = 10
    elif pe <= 18:   pe_score = 25
    elif pe <= 25:   pe_score = 45
    elif pe <= 35:   pe_score = 65
    elif pe <= 50:   pe_score = 80
    else:            pe_score = 92

    return int(round(0.5 * ev_score + 0.5 * pe_score)), None


def _score_macro(
    exposure: CompanyExposureProfile,
    matched_signals: list[IntelligenceSignal],
) -> Scored:
    """Macro risk: severity-weighted sector risks + macro-typed signals."""
    if not exposure_is_modelled(exposure):
        return None, _exposure_refusal(exposure, "macro")
    # A modelled sector that lists no risks is a declared zero base.
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

    # Cap at the top of the 0–100 scale (signals stack additively).
    return int(min(100, round(base + signal_bump))), None


def _score_supply_chain(
    exposure: CompanyExposureProfile,
    matched_signals: list[IntelligenceSignal],
) -> Scored:
    """Supply-chain risk: exposure intensity × outstanding supply-chain signals."""
    if not exposure_is_modelled(exposure):
        return None, _exposure_refusal(exposure, "supply_chain")
    # A modelled sector with no supply-chain dimensions declares zero
    # intensity; the default only applies to that declared-empty map.
    intensity = max(exposure.supply_chain_exposure.values(), default=0.0)

    signal_bump = 0
    for sig in matched_signals:
        if sig.signal_type in {"supply_chain", "commodity"}:
            signal_bump += SEVERITY_POINTS[sig.severity] / 4

    base = intensity * 70
    # Saturates at the top of the scale: signals stack additively.
    return int(min(100, round(base + signal_bump))), None


def _score_geopolitical(
    exposure: CompanyExposureProfile,
    matched_signals: list[IntelligenceSignal],
) -> Scored:
    """Geopolitical risk: exposure to risky geographies × signal presence."""
    if not exposure_is_modelled(exposure):
        return None, _exposure_refusal(exposure, "geopolitical")
    risky_geos = {"china", "taiwan", "middle_east", "russia_ukraine", "russia"}
    risky_exposure = sum(
        v for k, v in exposure.geographic_exposure.items() if k in risky_geos
    )

    signal_bump = 0
    for sig in matched_signals:
        if sig.signal_type == "geopolitical":
            signal_bump += SEVERITY_POINTS[sig.severity] / 3

    base = risky_exposure * 80
    # Saturates at the top of the scale: signals stack additively.
    return int(min(100, round(base + signal_bump))), None


def _score_operational(financials: dict[str, Any], sector: str) -> Scored:
    """Operational risk: revenue growth direction + capex intensity.

    Both inputs required: revenue growth, and capex over a positive revenue.
    """
    gaps = InputGaps()
    rev_growth = gaps.read(financials, "revenue_growth")
    capex = gaps.read(financials, "capex")
    revenue = gaps.read(financials, "revenue")
    capex_intensity: Optional[float] = None
    if capex is not None and revenue is not None:
        if revenue <= 0:
            gaps.reject("revenue", "is not positive, so capex intensity is undefined")
        else:
            capex_intensity = capex / revenue
    if gaps:
        return None, _category_refusal(gaps, "operational")

    if rev_growth >= 0.20:     growth_score = 10
    elif rev_growth >= 0.10:   growth_score = 20
    elif rev_growth >= 0.05:   growth_score = 35
    elif rev_growth >= 0.00:   growth_score = 50
    elif rev_growth >= -0.05:  growth_score = 70
    else:                      growth_score = 88

    # Capex intensity isn't strictly risk-positive — high capex in growth
    # sectors is a feature, not a bug. Use it as a milder signal.
    ci = abs(capex_intensity)
    if ci <= 0.05:    capex_score = 30
    elif ci <= 0.10:  capex_score = 40
    elif ci <= 0.20:  capex_score = 55
    elif ci <= 0.30:  capex_score = 70
    else:             capex_score = 80

    return int(round(0.6 * growth_score + 0.4 * capex_score)), None


def _score_regulatory(
    exposure: CompanyExposureProfile,
    matched_signals: list[IntelligenceSignal],
) -> Scored:
    """Regulatory risk: regulation-intensive supply-chain dimension + signals."""
    if not exposure_is_modelled(exposure):
        return None, _exposure_refusal(exposure, "regulatory")
    # A modelled sector without a "regulation" dimension declares none.
    reg_intensity = exposure.supply_chain_exposure.get("regulation", 0.0)

    signal_bump = 0
    for sig in matched_signals:
        if sig.signal_type == "regulation":
            signal_bump += SEVERITY_POINTS[sig.severity] / 3

    # Saturates at the top of the scale: signals stack additively.
    return int(min(100, round(reg_intensity * 75 + signal_bump))), None


# ─────────────────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────────────────

def compute_risk_score(
    exposure: CompanyExposureProfile,
    financials: dict[str, Any],
    matched_signals: Optional[list[IntelligenceSignal]] = None,
) -> PublicCompanyRiskScore:
    """Compute the deterministic 0–100 risk score for a single ticker.

    `financials` is a flat dict pulled from PublicCompanyFinancialSnapshot
    (ratios as 0–1 fractions). A category whose inputs are not all measured
    is None with a ``ScoreRefusal``; the overall score and risk level are
    None unless every weighted category is measured.

    `matched_signals` is the subset of IntelligenceSignals where this
    ticker appears in `affected_tickers`. The signal_orchestrator owns
    the match logic; this engine just consumes the result.

    The function is pure — same inputs always return the same output.
    Test enforced via tests/intelligence/test_risk_scoring_engine.py.
    """
    signals = matched_signals or []

    scored: dict[str, Scored] = {
        "macro": _score_macro(exposure, signals),
        "supply_chain": _score_supply_chain(exposure, signals),
        "geopolitical": _score_geopolitical(exposure, signals),
        "financial": _score_financial(financials),
        "valuation": _score_valuation(financials, exposure.sector),
        "operational": _score_operational(financials, exposure.sector),
        "regulatory": _score_regulatory(exposure, signals),
    }
    categories = RiskCategoryScores(**{k: v[0] for k, v in scored.items()})
    refusals: list[ScoreRefusal] = [v[1] for v in scored.values() if v[1] is not None]

    overall: Optional[int]
    risk_level: Optional[Severity]
    refused = [k for k in CATEGORY_WEIGHTS if scored[k][0] is None]
    if refused:
        overall = None
        risk_level = None
        refusals.append(ScoreRefusal(
            code=RISK_COMPOSITE_UNAVAILABLE,
            component="overall",
            inputs=refused,
            text=(
                f"Composite risk unavailable: "
                f"{join_names([CATEGORY_LABELS[k].lower() for k in refused])} "
                f"inputs not reported for {exposure.ticker}."
            ),
        ))
    else:
        overall = int(round(sum(
            CATEGORY_WEIGHTS[k] * scored[k][0] for k in CATEGORY_WEIGHTS
        )))
        lo, hi = SCORE_RANGE
        if not (lo <= overall <= hi):
            # Unreachable while every category is capped at the top of the
            # scale and the weights sum to 1.0 — but a score outside its
            # declared range refuses; it is never clamped into it.
            refusals.append(ScoreRefusal(
                code=RISK_SCORE_OUT_OF_RANGE,
                component="overall",
                inputs=list(CATEGORY_WEIGHTS),
                text=f"Composite risk unavailable: computed {overall} is outside {lo}-{hi}.",
            ))
            overall = None
            risk_level = None
        else:
            risk_level = "low"
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
        composite_refusal=(
            next(r for r in reversed(refusals) if r.component == "overall")
            if overall is None else None
        ),
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
        refusals=refusals,
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
    so the top-N selection emphasizes the company's actual pain points. A
    refused (None) category contributes nothing to the relevance.
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
            if score is not None:
                best = max(best, score / 100.0)
    return max(TOP_RISK_MIN_RELEVANCE, best)


def _build_explanation(
    ticker: str,
    overall: Optional[int],
    risk_level: Optional[Severity],
    categories: RiskCategoryScores,
    top_risks: list[RiskItem],
    composite_refusal: Optional[ScoreRefusal] = None,
) -> str:
    """Deterministic short sentence. NO LLM.

    LLM-driven narrative lives in ai_market_read.py. A refused composite
    states its refusal and names no "highest pressure": the loudest of a
    partial set of categories is not the company's loudest.
    """
    if overall is None:
        parts = [composite_refusal.text if composite_refusal is not None
                 else f"{ticker} composite risk unavailable."]
    else:
        parts = [f"{ticker} composite risk {overall}/100 ({risk_level})."]
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
