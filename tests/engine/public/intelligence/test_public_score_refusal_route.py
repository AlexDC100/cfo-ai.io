"""The SERVED public risk / opportunity scores refuse on absent inputs.

Drives the real route handlers (``routes.build_router``) — not the engine —
for the three surfaces the neutral-50 composites reached: the per-ticker
risk score, the universe batch, and the AI market read. The universe is a
fixed in-test payload shaped exactly like the live producers (percentage
points, no interestExpense, revenueGrowth None) and the signal feed is
pre-warmed empty, so nothing leaves the process.

TC-11, what this reds on after the repair: a numeric composite or level on
any of the three surfaces for a snapshot missing a weighted input; a
"NN/100" headline for a refused score; a percentage-point margin read as a
fraction at the snapshot boundary.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.public.intelligence import routes
from engine.public.intelligence.intelligence_cache import (
    get_intelligence_cache,
    reset_intelligence_cache,
)

# universe_service.py shape for a live US row: ratios in percentage points,
# revenueGrowth None ("requires prior period — v2"), no interestExpense key.
LIVE_US_AAPL = {
    "ticker": "AAPL", "companyName": "Apple Inc.", "sector": "Technology",
    "marketCap": 3.4e12, "enterpriseValue": 3.45e12, "revenue": 391e9,
    "revenueGrowth": None, "ebitda": 134.7e9, "ebitdaMargin": 34.45,
    "netIncome": 93.7e9, "netMargin": 23.97, "netDebt": 50e9,
    "capex": 9.4e9, "freeCashFlow": 108.8e9, "peRatio": 36.3, "evToEbitda": 25.6,
    "fcfYield": 3.2, "roe": 164.6, "netDebtToEbitda": 0.37, "debtToEquity": 1.9,
}


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


def test_snapshot_boundary_converts_points_and_keeps_a_measured_zero():
    fin = routes._financials_from_snapshot(dict(LIVE_US_AAPL, revenueGrowth=0.0))
    assert fin["ebitda_margin"] == pytest.approx(0.3445)
    assert fin["fcf_yield"] == pytest.approx(0.032)
    assert fin["roe"] == pytest.approx(1.646)
    # `snap.get(a) or snap.get(b)` used to turn a measured 0 into None.
    assert fin["revenue_growth"] == 0.0
    assert fin["interest_expense"] is None


def test_per_ticker_risk_score_refuses_for_a_live_shaped_snapshot(client):
    r = client.get("/api/public/intelligence/companies/AAPL/risk-score")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["overall_risk_score"] is None
    assert body["risk_level"] is None
    assert body["categories"]["financial"] is None     # no interest expense
    assert body["categories"]["operational"] is None   # no revenue growth
    assert isinstance(body["categories"]["valuation"], int)
    by = {x["component"]: x for x in body["refusals"]}
    assert by["financial"]["inputs"] == ["interest_coverage"]
    assert by["operational"]["inputs"] == ["revenue_growth"]
    assert by["overall"]["text"] == (
        "Composite risk unavailable: financial and operational inputs not "
        "reported for AAPL."
    )


def test_universe_batch_serves_null_scores_with_reasons(client, monkeypatch):
    # One-ticker universe so the batch builds exactly the row under test.
    from engine.public import universe as universe_module
    monkeypatch.setattr(universe_module, "DEFAULT_UNIVERSE",
                        [t for t in universe_module.DEFAULT_UNIVERSE if t[0] == "AAPL"])
    r = client.get("/api/public/intelligence/risk-scores")
    assert r.status_code == 200, r.text
    row = r.json()["scores"]["AAPL"]
    assert row["risk_score"] is None and row["risk_level"] is None
    assert row["risk_refusal"].startswith("Composite risk unavailable:")
    # Every opportunity input IS in this snapshot: that score is measured.
    assert isinstance(row["opportunity_score"], int) and row["opportunity_refusal"] is None


def test_ai_market_read_headline_states_the_refusal(client):
    r = client.get("/api/public/intelligence/companies/AAPL/ai-market-read")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["headline"].startswith("AAPL composite risk unavailable,"), body["headline"]
    assert "composite risk unavailable" in body["summary"].lower()
