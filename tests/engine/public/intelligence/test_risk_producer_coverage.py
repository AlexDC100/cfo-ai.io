"""R-PUBLIC-ABSENT (floor_rulings.md, 2026-09-19): in the PUBLIC risk score a
category whose input NO producer carries is DROPPED — its weight is
redistributed over the categories that computed and the served block says
which categories were dropped, why, and which weights were applied. A
category whose input the producer carries but THIS company lacks still
REFUSES, and the composite refuses with it. The private credit composite
never redistributes (R-COMPOSITE); this rule is the public score's only.

Measured 2026-09-19 over the 291 offline rows (88 BVB seed + 203 NASDAQ
demo, scratchpad/c6_measure_coverage.py): ``interestExpense`` is a key on
0 / 291 rows — no producer has the field. ``revenueGrowth`` IS a field of
the seed and demo producers (203 / 203 demo rows carry a value, 7 / 88 seed
rows do) and is written as a literal ``None`` by both LIVE producers
(universe_service._live_row, normalizer.build_universe_snapshot_row:
"requires prior period — v2"). So the drop is declared PER PRODUCER, keyed
by the row's ``mode``: every producer drops financial (interest expense);
only the live producers drop operational (revenue growth). The ruling's
"291/291 for revenueGrowth" was the live shape, not the offline rows.

TC-11, what this reds on after the repair: a composite refused on a
structurally absent input; a composite served while a per-company refused
category is redistributed away; applied weights that do not sum to 1 or
that are not the declared weights rescaled; a dropped category with no
stated reason; a declared "not carried" input that a producer does carry
(the declaration drifting from the producers, e.g. once PT-PUBLIC-1 lands);
the per-ticker route or the batch row serving the composite without the
coverage block.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.public import bvb_seed, universe
from engine.public.demo_universe import demo_snapshot_for
from engine.public.intelligence import routes
from engine.public.intelligence.company_exposure_service import (
    build_company_exposure_profile,
)
from engine.public.intelligence.intelligence_cache import (
    get_intelligence_cache,
    reset_intelligence_cache,
)
from engine.public.intelligence.risk_scoring_engine import (
    CATEGORY_INPUTS,
    CATEGORY_WEIGHTS,
    NOT_CARRIED_REASON,
    PRODUCER_COVERAGE,
    RISK_CATEGORY_DROPPED,
    RISK_CATEGORY_UNAVAILABLE,
    RISK_COMPOSITE_UNAVAILABLE,
    applied_weights,
    compute_risk_score,
    dropped_categories,
)
from engine.public.normalizer import build_universe_snapshot_row
from engine.public.universe_service import _live_row

# universe_service.py shape for a live US row: percentage points,
# revenueGrowth None, no interestExpense key, mode "live".
LIVE_US_AAPL = {
    "ticker": "AAPL", "companyName": "Apple Inc.", "sector": "Technology",
    "mode": "live",
    "marketCap": 3.4e12, "enterpriseValue": 3.45e12, "revenue": 391e9,
    "revenueGrowth": None, "ebitda": 134.7e9, "ebitdaMargin": 34.45,
    "netIncome": 93.7e9, "netMargin": 23.97, "netDebt": 50e9,
    "capex": 9.4e9, "freeCashFlow": 108.8e9, "peRatio": 36.3, "evToEbitda": 25.6,
    "fcfYield": 3.2, "roe": 164.6, "netDebtToEbitda": 0.37, "debtToEquity": 1.9,
}

# The financials dict the route builds from that row (fractions, producer).
LIVE_FIN = {
    "producer": "live",
    "net_debt_to_ebitda": 0.37, "ebitda": 134.7e9, "ebitda_margin": 0.3445,
    "interest_expense": None, "ev_to_ebitda": 25.6, "pe_ratio": 36.3,
    "revenue_growth": None, "capex": 9.4e9, "revenue": 391e9,
}


def _profile(ticker="AAPL", sector="Technology"):
    return build_company_exposure_profile(ticker, ticker, sector, None, try_filings=False)


def _by_component(score):
    return {r.component: r for r in score.refusals}


# ─── The declaration ─────────────────────────────────────────────────────


def test_declared_weights_are_the_ones_redistributed_and_they_sum_to_one():
    kept = ["macro", "supply_chain", "geopolitical", "valuation", "regulatory"]
    w = applied_weights(kept)
    assert set(w) == set(kept)
    assert abs(sum(w.values()) - 1.0) < 1e-9
    total = sum(CATEGORY_WEIGHTS[k] for k in kept)
    for k in kept:
        assert w[k] == pytest.approx(CATEGORY_WEIGHTS[k] / total)
    # Nothing kept → nothing to apply; never a division by zero.
    assert applied_weights([]) == {}


def test_every_producer_drops_financial_and_only_live_drops_operational():
    assert set(PRODUCER_COVERAGE) == {"live", "demo", "seed"}
    for producer in PRODUCER_COVERAGE:
        dropped = {d.category: d for d in dropped_categories(producer)}
        assert "financial" in dropped, producer
        assert dropped["financial"].inputs == ["interest_expense"]
        assert dropped["financial"].reason == NOT_CARRIED_REASON
        assert ("operational" in dropped) == (producer == "live"), producer
    assert dropped_categories(None) == []
    assert dropped_categories("a-producer-nobody-declared") == []


def test_the_declaration_is_measured_against_the_offline_producers():
    """Over every seed and demo row: a declared-not-carried input has no key
    on any row, and every OTHER category input IS a key of every row (the
    producer carries the field, whether or not this company filled it)."""
    rows = {
        "seed": list(bvb_seed.bvb_universe().values()),
        "demo": [demo_snapshot_for(t, n, s) for t, n, s in universe.DEFAULT_UNIVERSE],
    }
    snapshot_keys = {
        "interest_expense": ("interest_expense", "interestExpense"),
        "revenue_growth": ("revenue_growth", "revenueGrowth"),
        "net_debt_to_ebitda": ("net_debt_to_ebitda", "netDebtToEbitda"),
        "ebitda": ("ebitda",), "ebitda_margin": ("ebitda_margin", "ebitdaMargin"),
        "ev_to_ebitda": ("ev_to_ebitda", "evToEbitda"), "pe_ratio": ("pe_ratio", "peRatio"),
        "capex": ("capex",), "revenue": ("revenue",),
    }
    all_inputs = {i for inputs in CATEGORY_INPUTS.values() for i in inputs}
    for producer, snaps in rows.items():
        assert len(snaps) >= 88, producer
        assert {s["mode"] for s in snaps} == {producer}
        not_carried = set(PRODUCER_COVERAGE[producer])
        for snap in snaps:
            for inp in not_carried:
                assert not any(k in snap for k in snapshot_keys[inp]), (producer, snap["ticker"], inp)
            for inp in all_inputs - not_carried:
                assert any(k in snap for k in snapshot_keys[inp]), (producer, snap["ticker"], inp)


def test_the_declaration_is_measured_against_the_live_producers():
    """Both live builders are driven with inputs that DO carry an interest
    expense and a prior revenue: the row still has no interestExpense key and
    revenueGrowth None, while every other category input is a key."""
    fundamentals = SimpleNamespace(
        revenue=391e9, ebitda=134.7e9, net_income=93.7e9, total_debt=100e9,
        cash=50e9, total_equity=57e9, operating_cash_flow=118e9,
        free_cash_flow=108e9, ebit=123e9, shares_outstanding=15.3e9,
        interest_expense=3.9e9, revenue_prior=383e9, capex=9.4e9,
    )
    daily = SimpleNamespace(market_cap=3.4e12, enterprise_value=3.45e12,
                            pe_ratio=36.3, ev_ebitda=25.6, ev_revenue=8.8,
                            dividend_yield=0.005)
    row = _live_row(ticker="AAPL", fallback_name="Apple", fallback_sector="Technology",
                    fundamentals=fundamentals, daily=daily)
    envelope = {
        "ticker": "AAPL", "ticker_info": {"name": "Apple"},
        "periods": [{
            "headline": {"revenue": 391e9, "ebitda": 134.7e9, "net_income": 93.7e9,
                         "cash": 50e9, "total_debt": 100e9, "total_equity": 57e9,
                         "operating_cash_flow": 118e9, "free_cash_flow": 108e9,
                         "interest_expense": 3.9e9},
            "market_metrics": {"market_cap": 3.4e12, "pe_ratio": 36.3, "ev_ebitda": 25.6},
        }],
    }
    row2 = build_universe_snapshot_row(envelope, fallback_name="Apple", fallback_sector="Technology")
    for built in (row, row2):
        assert built is not None
        assert built["mode"] == "live"
        assert "interestExpense" not in built and "interest_expense" not in built
        assert "revenueGrowth" in built and built["revenueGrowth"] is None
        for key in ("netDebtToEbitda", "ebitda", "ebitdaMargin", "evToEbitda",
                    "peRatio", "capex", "revenue"):
            assert key in built, key
    assert routes._financials_from_snapshot(row)["producer"] == "live"
    assert routes._financials_from_snapshot(LIVE_US_AAPL)["producer"] == "live"


# ─── The engine ──────────────────────────────────────────────────────────


def test_a_live_row_drops_financial_and_operational_and_scores_the_rest():
    score = compute_risk_score(_profile(), LIVE_FIN, [])
    assert score.categories.financial is None
    assert score.categories.operational is None
    assert isinstance(score.categories.valuation, int)
    by = _by_component(score)
    assert by["financial"].code == RISK_CATEGORY_DROPPED
    assert by["financial"].inputs == ["interest_expense"]
    assert by["financial"].text == (
        "Financial risk not scored: interest coverage is not carried by the data "
        "producer; its 22% weight is redistributed over the scored categories."
    )
    assert by["operational"].code == RISK_CATEGORY_DROPPED
    assert by["operational"].inputs == ["revenue_growth"]
    assert "overall" not in by
    kept = ["macro", "supply_chain", "geopolitical", "valuation", "regulatory"]
    w = applied_weights(kept)
    expected = int(round(sum(w[k] * getattr(score.categories, k) for k in kept)))
    assert score.overall_risk_score == expected
    assert score.risk_level is not None
    cov = score.coverage
    assert cov.producer == "live"
    assert cov.scored == kept
    assert [d.category for d in cov.dropped] == ["financial", "operational"]
    assert all(d.reason == NOT_CARRIED_REASON for d in cov.dropped)
    assert cov.declared_weights == CATEGORY_WEIGHTS
    assert cov.applied_weights == w
    assert abs(sum(cov.applied_weights.values()) - 1.0) < 1e-9
    assert (
        "over 5 of 7 categories: financial and operational not scored "
        "(input not carried by the data producer)"
    ) in score.explanation
    assert "Highest pressure" in score.explanation
    assert "financial" not in score.explanation.split("Highest pressure")[1]


def test_a_per_company_absence_still_refuses_the_category_and_the_composite():
    """A demo row without P/E: valuation refuses (the producer carries the
    field), financial is dropped, and the composite refuses — a refused
    category is never redistributed away."""
    fin = {"producer": "demo", "net_debt_to_ebitda": 1.2, "ebitda": 10e9,
           "ebitda_margin": 0.2, "ev_to_ebitda": 9.0, "pe_ratio": None,
           "revenue_growth": 0.05, "capex": 1e9, "revenue": 50e9}
    score = compute_risk_score(_profile("MSFT"), fin, [])
    by = _by_component(score)
    assert by["financial"].code == RISK_CATEGORY_DROPPED
    assert score.categories.valuation is None
    assert by["valuation"].code == RISK_CATEGORY_UNAVAILABLE
    assert isinstance(score.categories.operational, int)   # demo carries growth
    assert score.overall_risk_score is None and score.risk_level is None
    assert by["overall"].code == RISK_COMPOSITE_UNAVAILABLE
    assert by["overall"].inputs == ["valuation"]
    assert score.coverage.scored == ["macro", "supply_chain", "geopolitical",
                                     "valuation", "operational", "regulatory"]
    assert [d.category for d in score.coverage.dropped] == ["financial"]
    assert "Highest pressure" not in score.explanation


def test_a_row_with_no_producer_marker_drops_nothing():
    """Test fixtures and the batch's ``{}`` for a ticker without a snapshot
    carry no producer: nothing is structurally absent, so an absent input is
    a per-company refusal, as before."""
    fin = {k: v for k, v in LIVE_FIN.items() if k != "producer"}
    score = compute_risk_score(_profile(), fin, [])
    by = _by_component(score)
    assert by["financial"].code == RISK_CATEGORY_UNAVAILABLE
    assert by["operational"].code == RISK_CATEGORY_UNAVAILABLE
    assert score.overall_risk_score is None
    assert score.coverage.dropped == []
    assert score.coverage.producer is None
    assert score.coverage.applied_weights == CATEGORY_WEIGHTS


def test_a_dropped_category_is_never_scored_even_when_the_row_carries_the_input():
    """The drop is the producer's declaration, not this row's content:
    weights stay comparable across every row of one producer."""
    fin = dict(LIVE_FIN, interest_expense=3.9e9, revenue_growth=0.02)
    score = compute_risk_score(_profile(), fin, [])
    assert score.categories.financial is None
    assert score.categories.operational is None
    assert _by_component(score)["financial"].code == RISK_CATEGORY_DROPPED


# ─── The served surfaces ─────────────────────────────────────────────────


@pytest.fixture
def client(monkeypatch):
    for var in ("SEC_EDGAR_ENABLED", "ANTHROPIC_API_KEY", "FILINGS_EXTRACTION_ENABLED"):
        monkeypatch.delenv(var, raising=False)
    reset_intelligence_cache()
    monkeypatch.setattr(routes, "_fetch_universe_snapshots", lambda: {"AAPL": dict(LIVE_US_AAPL)})
    monkeypatch.setattr(routes, "_egress_guard", lambda *a, **k: None)
    get_intelligence_cache().put("macro-signals:__feed__", [], 600)
    app = FastAPI()
    app.include_router(routes.build_router())
    yield TestClient(app)
    reset_intelligence_cache()


def test_per_ticker_route_serves_the_composite_with_its_coverage_block(client):
    r = client.get("/api/public/intelligence/companies/AAPL/risk-score")
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body["overall_risk_score"], int)
    assert body["risk_level"] in ("low", "medium", "high", "critical")
    assert body["categories"]["financial"] is None
    assert body["categories"]["operational"] is None
    by = {x["component"]: x for x in body["refusals"]}
    assert by["financial"]["code"] == RISK_CATEGORY_DROPPED
    assert by["operational"]["code"] == RISK_CATEGORY_DROPPED
    assert "overall" not in by
    cov = body["coverage"]
    assert cov["producer"] == "live"
    assert [d["category"] for d in cov["dropped"]] == ["financial", "operational"]
    assert all(d["reason"] == NOT_CARRIED_REASON for d in cov["dropped"])
    assert set(cov["applied_weights"]) == set(cov["scored"])
    assert abs(sum(cov["applied_weights"].values()) - 1.0) < 1e-9
    assert cov["declared_weights"] == CATEGORY_WEIGHTS


def test_universe_batch_row_carries_the_score_and_its_coverage(client, monkeypatch):
    from engine.public import universe as universe_module
    monkeypatch.setattr(universe_module, "DEFAULT_UNIVERSE",
                        [t for t in universe_module.DEFAULT_UNIVERSE if t[0] == "AAPL"])
    r = client.get("/api/public/intelligence/risk-scores")
    assert r.status_code == 200, r.text
    row = r.json()["scores"]["AAPL"]
    assert isinstance(row["risk_score"], int) and row["risk_level"] is not None
    assert row["risk_refusal"] is None
    assert [d["category"] for d in row["risk_coverage"]["dropped"]] == ["financial", "operational"]
    assert row["risk_coverage"]["scored"] == ["macro", "supply_chain", "geopolitical",
                                              "valuation", "regulatory"]
