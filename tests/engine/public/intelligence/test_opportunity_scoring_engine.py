"""Opportunity-scoring engine — refusal on absent inputs.

Owner ruling 2026-09-15: absent is never zero and never a floor. Every
sub-score here used to score an absent input as its worst reading (0
points) or, for market cap, as a fixed 30 — so a ticker with no financial
data served 26/100 "medium", two points from a fully measured worst case,
and an unknown-sector ticker with nothing at all served "3/100 (low)".

TC-11, what these red on after the repair: an overall score served while a
weighted category is unmeasured; a measured overall that is not the
weighted sum of its declared ladders.
"""

from __future__ import annotations

import pytest

from engine.public.intelligence.company_exposure_service import (
    build_company_exposure_profile,
)
from engine.public.intelligence.opportunity_scoring_engine import (
    OPPORTUNITY_CATEGORY_UNAVAILABLE,
    OPPORTUNITY_CATEGORY_WEIGHTS,
    OPPORTUNITY_COMPOSITE_UNAVAILABLE,
    STRENGTH_LEVEL_CUTOFFS,
    compute_opportunity_score,
)
from engine.public.intelligence.risk_scoring_engine import SEVERITY_POINTS

FULL_FIN = {
    "fcf_yield": 0.09,           # +30
    "net_debt_to_ebitda": 0.5,   # +22
    "ebitda": 1_000_000_000,
    "ebitda_margin": 0.22,       # +18
    "roe": 0.13,                 # +8   → financial_quality 78
    "ev_to_ebitda": 7.0,         # 65
    "pe_ratio": 12.0,            # 65   → valuation_discount 65
    "market_cap": 60_000_000_000,  # 45
}


def _tech():
    return build_company_exposure_profile("TST", "Test Co", "Technology", None,
                                          try_filings=False)


def _refusal(score, component):
    hits = [r for r in score.refusals if r.component == component]
    assert len(hits) == 1, (component, score.refusals)
    return hits[0]


def test_measured_overall_is_the_weighted_sum_of_declared_ladders():
    profile = _tech()
    score = compute_opportunity_score(profile, FULL_FIN, [])
    assert score.refusals == []
    top = profile.main_opportunities[:3]
    tail = int(round(sum(SEVERITY_POINTS[o.severity] for o in top) / len(top)))
    parts = {"sector_tailwind": tail, "financial_quality": 78,
             "valuation_discount": 65, "market_position": 45}
    expected = int(round(sum(OPPORTUNITY_CATEGORY_WEIGHTS[k] * v for k, v in parts.items())))
    assert score.overall_opportunity_score == expected
    assert score.strength_level == next(
        label for cutoff, label in STRENGTH_LEVEL_CUTOFFS if expected >= cutoff)


def test_no_financials_refuses_instead_of_scoring_medium():
    score = compute_opportunity_score(_tech(), {}, [])
    assert score.overall_opportunity_score is None
    assert score.strength_level is None
    for cat in ("financial_quality", "valuation_discount", "market_position"):
        assert _refusal(score, cat).code == OPPORTUNITY_CATEGORY_UNAVAILABLE
    overall = _refusal(score, "overall")
    assert overall.code == OPPORTUNITY_COMPOSITE_UNAVAILABLE
    assert overall.text == (
        "Opportunity score unavailable: financial quality, valuation discount and "
        "market position inputs not reported for TST."
    )
    assert _refusal(score, "market_position").text == (
        "Market position opportunity unavailable: market cap not reported in this snapshot."
    )
    assert "/100" not in score.explanation


def test_unknown_sector_with_nothing_refuses_rather_than_three_out_of_a_hundred():
    shell = build_company_exposure_profile("ZZZ", "Zeta", "Unknown Sector", None,
                                           try_filings=False)
    score = compute_opportunity_score(shell, {}, [])
    assert score.overall_opportunity_score is None
    assert "has no exposure model" in _refusal(score, "sector_tailwind").text


@pytest.mark.parametrize("missing", ["fcf_yield", "net_debt_to_ebitda", "ebitda_margin", "roe"])
def test_one_absent_quality_input_refuses_financial_quality(missing):
    fin = {k: v for k, v in FULL_FIN.items() if k != missing}
    score = compute_opportunity_score(_tech(), fin, [])
    assert _refusal(score, "financial_quality").inputs == [missing]
    assert score.overall_opportunity_score is None


def test_negative_pe_is_not_an_attractive_valuation():
    """A loss-maker's negative P/E used to take the ≤10 "cheapest" rung (80)."""
    score = compute_opportunity_score(_tech(), dict(FULL_FIN, pe_ratio=-8.0), [])
    assert "earnings are not positive" in _refusal(score, "valuation_discount").text
    assert not any(o.key == "valuation_discount" for o in score.top_opportunities)
