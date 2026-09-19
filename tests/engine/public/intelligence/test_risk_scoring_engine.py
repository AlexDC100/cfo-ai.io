"""Risk-scoring engine — determinism, refusal on absent inputs, and
Lock #12 wrong-on-purpose tests.

Per brief §10: the engine produces the numeric score deterministically.
Per Lock #12 (ADR-F3.16-closure.md): we ship a wrong-on-purpose fixture
that proves the engine doesn't rubber-stamp a sector just because the
financial snapshot is otherwise nominal.

Owner ruling 2026-09-15 (floor substitutes): absent is never zero and never
a floor. A category whose input is absent is None with a stated reason, and
the composite refuses unless every weighted category is measured. The test
that used to live here — "missing financials degrade to neutral 50" —
asserted the defect as law (TC-11) and is replaced by the refusal tests.

TC-11, what these red on after the repair: a composite served while any
weighted category is unmeasured; a category served over an absent,
non-finite or out-of-domain input; a measured composite that differs from
the weighted sum of its declared tiers.
"""

from __future__ import annotations

import math

import pytest

from engine.public.intelligence.company_exposure_service import (
    build_company_exposure_profile,
)
from engine.public.intelligence.risk_scoring_engine import (
    CATEGORY_WEIGHTS,
    EBITDA_MARGIN_TIERS_INVERSE,
    ICR_TIERS_INVERSE,
    NDE_TIERS,
    RISK_CATEGORY_UNAVAILABLE,
    RISK_COMPOSITE_UNAVAILABLE,
    RISK_LEVEL_CUTOFFS,
    SEVERITY_POINTS,
    compute_risk_score,
)

FINANCIAL_CATEGORIES = ("financial", "valuation", "operational")
EXPOSURE_CATEGORIES = ("macro", "supply_chain", "geopolitical", "regulatory")


# Reusable strong-company financial snapshot (NVDA-ish at peak). Every
# field a category reads is measured.
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

# Distressed but fully MEASURED snapshot — thin positive EBITDA, high
# leverage, coverage below 1x, rich multiples, collapsing revenue.
DISTRESSED_FIN = {
    "net_debt_to_ebitda": 6.5,
    "ebitda_margin": 0.02,
    "ebitda": 50_000_000,
    "interest_expense": 100_000_000,
    "ev_to_ebitda": 40,
    "pe_ratio": 80,
    "revenue_growth": -0.30,
    "capex": 500_000_000,
    "revenue": 2_500_000_000,
    "roe": 0.01,
    "fcf_yield": -0.05,
    "market_cap": 2_000_000_000,
}


def _semis_profile():
    return build_company_exposure_profile(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
        try_filings=False,
    )


def _refusal(score, component):
    hits = [r for r in score.refusals if r.component == component]
    assert len(hits) == 1, (component, score.refusals)
    return hits[0]


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


def test_measured_composite_is_the_weighted_sum_of_its_categories():
    """A fully-measured score is served, in range, and IS the declared
    weighted sum — not merely a finite number (TC-11)."""
    profile = _semis_profile()
    for fin in (STRONG_FIN, DISTRESSED_FIN):
        score = compute_risk_score(profile, fin, [])
        assert score.refusals == []
        cats = {k: getattr(score.categories, k) for k in CATEGORY_WEIGHTS}
        assert all(isinstance(v, int) and 0 <= v <= 100 for v in cats.values()), cats
        expected = int(round(sum(CATEGORY_WEIGHTS[k] * cats[k] for k in CATEGORY_WEIGHTS)))
        assert score.overall_risk_score == expected
        level = next(label for cutoff, label in RISK_LEVEL_CUTOFFS if expected >= cutoff)
        assert score.risk_level == level


def test_financial_category_reads_the_declared_tiers():
    """Distressed: NDE 6.5 → last NDE tier; ICR 0.5 → bottom ICR tier;
    margin 2% → the 0.00 tier. The category is 0.4/0.3/0.3 of those."""
    score = compute_risk_score(_semis_profile(), DISTRESSED_FIN, [])
    nde_pts = NDE_TIERS[-1][1]
    icr_pts = ICR_TIERS_INVERSE[-1][1]
    margin_pts = next(p for t, p in EBITDA_MARGIN_TIERS_INVERSE if 0.02 >= t)
    assert score.categories.financial == int(round(0.4 * nde_pts + 0.3 * icr_pts + 0.3 * margin_pts))


def test_wrong_on_purpose_distressed_semis_scores_high():
    """Lock #12 — distressed Semis should score ≥50 (high) despite the
    sector having some opportunity overlays. Proves the engine doesn't
    rubber-stamp a sector just because of strong-sector defaults."""
    profile = _semis_profile()
    score = compute_risk_score(profile, DISTRESSED_FIN, [])
    assert score.overall_risk_score is not None
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
    assert any(
        "taiwan" in k.lower() or "supply" in k.lower() or "concentration" in k.lower()
        for k in top_risk_keys
    ), f"Strong Semis missing macro/supply-chain risk; got {top_risk_keys}"


def test_financial_health_dominates_for_strong_company():
    profile = _semis_profile()
    score = compute_risk_score(profile, STRONG_FIN, [])
    assert score.categories.financial < 30, score.categories.financial


def test_financial_health_dominates_for_distressed_company():
    profile = _semis_profile()
    score = compute_risk_score(profile, DISTRESSED_FIN, [])
    assert score.categories.financial >= 60, score.categories.financial


def test_no_llm_in_score_path():
    """The engine MUST be importable + runnable without anthropic SDK
    or any network."""
    import engine.public.intelligence.risk_scoring_engine as mod
    forbidden = {"anthropic", "openai", "httpx", "requests"}
    assert not {a for a in dir(mod) if a in forbidden}


# ─── Refusal on absent inputs (owner ruling 2026-09-15) ──────────────────


def test_no_financials_refuses_every_financial_category_and_the_composite():
    """The batch route passes {} for a ticker with no snapshot. That used
    to serve 47 "medium" with financial/valuation/operational at 50."""
    profile = _semis_profile()
    score = compute_risk_score(profile, {}, [])
    for cat in FINANCIAL_CATEGORIES:
        assert getattr(score.categories, cat) is None, cat
        assert _refusal(score, cat).code == RISK_CATEGORY_UNAVAILABLE
    # Exposure categories come from the sector model, which IS modelled.
    for cat in EXPOSURE_CATEGORIES:
        assert isinstance(getattr(score.categories, cat), int), cat
    assert score.overall_risk_score is None
    assert score.risk_level is None
    overall = _refusal(score, "overall")
    assert overall.code == RISK_COMPOSITE_UNAVAILABLE
    assert overall.inputs == list(FINANCIAL_CATEGORIES)
    assert overall.text == (
        "Composite risk unavailable: financial, valuation and operational "
        "inputs not reported for NVDA."
    )
    assert _refusal(score, "financial").text == (
        "Financial risk unavailable: net debt/EBITDA, EBITDA margin and interest "
        "coverage not reported in this snapshot."
    )
    assert _refusal(score, "valuation").text == (
        "Valuation risk unavailable: EV/EBITDA and P/E not reported in this snapshot."
    )
    # The explanation must not name a "highest pressure" over a partial set.
    assert "Highest pressure" not in score.explanation
    assert "unavailable" in score.explanation


def test_unknown_sector_refuses_exposure_categories():
    """An unknown sector gets an empty shell profile. Its empty maps used to
    score macro/supply/geo/regulatory as 0 — "no exposure" from "no model"."""
    shell = build_company_exposure_profile("ZZZ", "Zeta", "Unknown Sector", None,
                                           try_filings=False)
    score = compute_risk_score(shell, STRONG_FIN, [])
    for cat in EXPOSURE_CATEGORIES:
        assert getattr(score.categories, cat) is None, cat
        r = _refusal(score, cat)
        assert r.inputs == ["sector_exposure_model"]
        assert "has no exposure model" in r.text
    assert score.overall_risk_score is None


@pytest.mark.parametrize("missing, label", [
    ("net_debt_to_ebitda", "net debt/EBITDA"),
    ("ebitda_margin", "EBITDA margin"),
    ("interest_expense", "interest coverage"),
])
def test_one_absent_financial_input_refuses_the_category(missing, label):
    """Every live US snapshot lacks interest expense; 30% of the financial
    category used to be a fixed 50 for all of them."""
    fin = {k: v for k, v in STRONG_FIN.items() if k != missing}
    score = compute_risk_score(_semis_profile(), fin, [])
    assert score.categories.financial is None
    assert label in _refusal(score, "financial").text
    assert score.overall_risk_score is None


def test_absent_revenue_growth_refuses_operational():
    fin = dict(STRONG_FIN, revenue_growth=None)
    score = compute_risk_score(_semis_profile(), fin, [])
    assert score.categories.operational is None
    assert "revenue growth" in _refusal(score, "operational").text


def test_nan_input_refuses_rather_than_taking_the_last_tier():
    """NaN fails every comparison and used to fall to tiers[-1] (95)."""
    fin = dict(STRONG_FIN, ebitda_margin=math.nan)
    score = compute_risk_score(_semis_profile(), fin, [])
    assert score.categories.financial is None
    assert "EBITDA margin is not a finite number" in _refusal(score, "financial").text


def test_net_debt_over_negative_ebitda_is_not_scored_as_net_cash():
    """Net debt 100 over EBITDA -50 gives NDE -2.0, which the ≤1× tier used
    to score as the lowest leverage risk (10)."""
    fin = dict(STRONG_FIN, ebitda=-50_000_000, net_debt_to_ebitda=-2.0)
    score = compute_risk_score(_semis_profile(), fin, [])
    assert score.categories.financial is None
    assert "EBITDA is not positive" in _refusal(score, "financial").text


@pytest.mark.parametrize("key, value, why", [
    ("pe_ratio", -12.0, "earnings are not positive"),
    ("ev_to_ebitda", -3.0, "EBITDA or enterprise value is not positive"),
])
def test_non_positive_multiple_is_not_scored_cheap(key, value, why):
    """A negative P/E used to take the ≤10 tier: the lowest valuation risk."""
    score = compute_risk_score(_semis_profile(), dict(STRONG_FIN, **{key: value}), [])
    assert score.categories.valuation is None
    assert why in _refusal(score, "valuation").text


def test_zero_interest_expense_refuses_coverage():
    fin = dict(STRONG_FIN, interest_expense=0)
    score = compute_risk_score(_semis_profile(), fin, [])
    assert score.categories.financial is None
    assert "interest expense is zero" in _refusal(score, "financial").text


# ─── top_risks[].score_contribution over refused categories ─────────────────


def _mapped_categories(item, categories):
    """The category scores a risk's channels map to, as _risk_to_category_weight reads them."""
    channel_to_cat = {
        "supply_availability": "supply_chain", "inventory": "supply_chain",
        "valuation_multiple": "valuation", "debt_cost": "financial",
        "capex": "operational", "fx": "macro", "working_capital": "operational",
        "revenue": "macro", "gross_margin": "operational", "ebitda_margin": "financial",
    }
    return [getattr(categories, channel_to_cat[c]) for c in item.channels if c in channel_to_cat]


def test_top_risk_contribution_is_null_when_every_mapped_category_is_refused():
    """Measured 2026-09-19 on f68d45a: AAPL with an empty snapshot served
    top_risks contributions 48/39/34 (severity x the 0.3 relevance floor)
    beside overall None, while the field is documented as how much the risk
    lifts the overall score."""
    from engine.public.intelligence.risk_scoring_engine import _risk_to_category_weight
    score = compute_risk_score(_semis_profile(), {}, [])
    assert score.overall_risk_score is None
    assert _risk_to_category_weight(["capex"], score.categories) is None
    assert _risk_to_category_weight(["ebitda_margin", "valuation_multiple"], score.categories) is None
    assert score.top_risks, "the sector model always carries risks"
    for item in score.top_risks:
        mapped = _mapped_categories(item, score.categories)
        if mapped and all(c is None for c in mapped):
            assert item.score_contribution is None, item
        else:
            assert isinstance(item.score_contribution, int), item


def test_top_risk_contribution_control_is_severity_times_relevance():
    from engine.public.intelligence.risk_scoring_engine import _risk_to_category_weight
    score = compute_risk_score(_semis_profile(), STRONG_FIN, [])
    assert score.overall_risk_score is not None
    for item in score.top_risks:
        w = _risk_to_category_weight(item.channels, score.categories)
        assert w is not None
        assert item.score_contribution == int(round(SEVERITY_POINTS[item.severity] * w))
    # The relevance floor still applies among MEASURED categories.
    assert _risk_to_category_weight(["fx"], score.categories) >= 0.3
