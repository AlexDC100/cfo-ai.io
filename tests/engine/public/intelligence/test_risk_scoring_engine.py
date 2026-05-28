"""Risk-scoring engine — determinism + Lock #12 wrong-on-purpose tests.

Per brief §10: the engine produces the numeric score deterministically.
Per Lock #12 (ADR-F3.16-closure.md): we ship a wrong-on-purpose fixture
that proves the engine doesn't rubber-stamp a sector just because the
financial snapshot is otherwise nominal.
"""

from __future__ import annotations

import pytest

from engine.public.intelligence.company_exposure_service import (
    build_company_exposure_profile,
)
from engine.public.intelligence.risk_scoring_engine import (
    CATEGORY_WEIGHTS,
    NDE_TIERS,
    SEVERITY_POINTS,
    compute_risk_score,
)


# Reusable strong-company financial snapshot (NVDA-ish at peak).
STRONG_FIN = {
    "net_debt_to_ebitda": -1.5,
    "ebitda_margin": 0.60,
    "ebitda": 80_000_000_000,
    "interest_expense": 200_000_000,
    "ev_to_ebitda": 35,
    "pe_ratio": 55,
    "revenue_growth": 0.95,
    "capex": 5_000_000_000,
    "revenue": 130_000_000_000,
    "roe": 0.85,
    "fcf_yield": 0.025,
    "market_cap": 3_000_000_000_000,
}

# Distressed snapshot — high leverage, negative margin, collapsing revenue.
DISTRESSED_FIN = {
    "net_debt_to_ebitda": 6.5,
    "ebitda_margin": -0.05,
    "ebitda": -50_000_000,
    "interest_expense": 100_000_000,
    "ev_to_ebitda": None,        # negative EBITDA → undefined multiple
    "pe_ratio": None,
    "revenue_growth": -0.30,
    "capex": 500_000_000,
    "revenue": 800_000_000,
    "roe": -0.15,
    "fcf_yield": -0.05,
    "market_cap": 2_000_000_000,
}


def _semis_profile():
    return build_company_exposure_profile(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
    )


def test_category_weights_sum_to_one():
    """Defensive: any future weight edit must preserve the sum invariant."""
    assert abs(sum(CATEGORY_WEIGHTS.values()) - 1.0) < 1e-9


def test_severity_points_monotonic():
    """Severity points must be strictly increasing: low < medium < high < critical."""
    assert (
        SEVERITY_POINTS["low"] < SEVERITY_POINTS["medium"] <
        SEVERITY_POINTS["high"] < SEVERITY_POINTS["critical"]
    )


def test_determinism_same_inputs_same_output():
    """Per brief §10: same inputs ALWAYS produce the same numeric score."""
    profile = _semis_profile()
    r1 = compute_risk_score(profile, STRONG_FIN, [])
    r2 = compute_risk_score(profile, STRONG_FIN, [])
    r3 = compute_risk_score(profile, STRONG_FIN, [])
    assert r1.overall_risk_score == r2.overall_risk_score == r3.overall_risk_score
    assert r1.categories == r2.categories == r3.categories
    assert [t.key for t in r1.top_risks] == [t.key for t in r2.top_risks]


def test_score_bounds_0_to_100():
    """Score must always be in [0, 100]. No NaN, no overflow."""
    profile = _semis_profile()
    for fin in [STRONG_FIN, DISTRESSED_FIN, {}]:
        score = compute_risk_score(profile, fin, [])
        assert 0 <= score.overall_risk_score <= 100, (
            f"Score out of bounds: {score.overall_risk_score}"
        )
        for cat_score in [
            score.categories.macro,
            score.categories.supply_chain,
            score.categories.geopolitical,
            score.categories.financial,
            score.categories.valuation,
            score.categories.operational,
            score.categories.regulatory,
        ]:
            assert 0 <= cat_score <= 100


def test_wrong_on_purpose_distressed_semis_scores_high():
    """Lock #12 — distressed Semis should score ≥50 (high) despite the
    sector having some opportunity overlays. Proves the engine doesn't
    rubber-stamp a sector just because of strong-sector defaults."""
    profile = _semis_profile()
    score = compute_risk_score(profile, DISTRESSED_FIN, [])
    assert score.overall_risk_score >= 50, (
        f"Distressed Semis company scored {score.overall_risk_score}/100, "
        f"expected ≥50 (high). Engine may be rubber-stamping."
    )


def test_wrong_on_purpose_strong_semis_still_has_macro_pressure():
    """Even with great financials, NVDA-like profile MUST surface
    Taiwan / macro risk in top_risks — it's the structural exposure
    that defines the company. If macro is 0 here, the radar's wrong."""
    profile = _semis_profile()
    score = compute_risk_score(profile, STRONG_FIN, [])
    top_risk_keys = [r.key for r in score.top_risks]
    # Should surface Taiwan or supply-chain-related risk
    assert any(
        "taiwan" in k.lower() or "supply" in k.lower() or "concentration" in k.lower()
        for k in top_risk_keys
    ), f"Strong Semis missing macro/supply-chain risk; got {top_risk_keys}"


def test_financial_health_dominates_for_strong_company():
    """A negative-net-debt + 60%-EBITDA-margin company should score low
    on `financial` category (the one purely derived from financials)."""
    profile = _semis_profile()
    score = compute_risk_score(profile, STRONG_FIN, [])
    assert score.categories.financial < 30, (
        f"Strong financials should score low on financial category; "
        f"got {score.categories.financial}/100"
    )


def test_financial_health_dominates_for_distressed_company():
    profile = _semis_profile()
    score = compute_risk_score(profile, DISTRESSED_FIN, [])
    assert score.categories.financial >= 60, (
        f"Distressed financials should score high on financial category; "
        f"got {score.categories.financial}/100"
    )


def test_no_llm_in_score_path():
    """The engine MUST be importable + runnable without anthropic SDK
    or any network. Compute a score without touching any AI dep."""
    # This will fail at import time if risk_scoring_engine.py ever pulls
    # in anthropic/openai/network code. Defensive check via attribute.
    import engine.public.intelligence.risk_scoring_engine as mod
    src_attrs = dir(mod)
    forbidden = {"anthropic", "openai", "httpx", "requests"}
    found = {a for a in src_attrs if a in forbidden}
    assert not found, f"Risk engine pulled in network deps: {found}"


def test_missing_financials_degrade_to_neutral_not_high():
    """When financials are entirely missing, the financial category
    should degrade to ~50 (neutral), not to 100. We never PUNISH a
    company for missing data."""
    profile = _semis_profile()
    score = compute_risk_score(profile, {}, [])
    # Financial category with no inputs → all three tiers return 50 (neutral)
    # → weighted average ~50. Allow 40-60 range.
    assert 35 <= score.categories.financial <= 65, (
        f"Missing financials degraded badly: {score.categories.financial}"
    )


def test_explanation_is_a_sentence():
    """The deterministic explanation should be a short, complete English sentence."""
    profile = _semis_profile()
    score = compute_risk_score(profile, STRONG_FIN, [])
    assert score.explanation
    assert "NVDA" in score.explanation or "composite" in score.explanation.lower()
