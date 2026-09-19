"""The SERVED public risk / opportunity scores refuse on absent inputs.

Drives the real route handlers (``routes.build_router``) — not the engine —
for the three surfaces the neutral-50 composites reached: the per-ticker
risk score, the universe batch, and the AI market read. The universe is a
fixed in-test payload shaped exactly like the live producers (percentage
points, no interestExpense, revenueGrowth None, mode "live") and the signal
feed is pre-warmed empty, so nothing leaves the process.

R-PUBLIC-ABSENT (2026-09-19) restated the refusal these tests pin: the
inputs no live producer carries (interest expense, revenue growth) DROP
their categories with the weights redistributed and the coverage stated
(test_risk_producer_coverage.py pins that path), so a full live row now
scores. The per-company refusal is pinned here on a live row lacking P/E —
a field the producer carries — which refuses valuation, and with it the
composite, the batch row and the AI-read headline.

TC-11, what this reds on after the repair: a numeric composite or level on
any of the three surfaces for a snapshot missing a carried input; a
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
# revenueGrowth None ("requires prior period — v2"), no interestExpense key,
# mode "live" (the producer marker the risk engine reads).
LIVE_US_AAPL = {
    "ticker": "AAPL", "companyName": "Apple Inc.", "sector": "Technology",
    "mode": "live",
    "marketCap": 3.4e12, "enterpriseValue": 3.45e12, "revenue": 391e9,
    "revenueGrowth": None, "ebitda": 134.7e9, "ebitdaMargin": 34.45,
    "netIncome": 93.7e9, "netMargin": 23.97, "netDebt": 50e9,
    "capex": 9.4e9, "freeCashFlow": 108.8e9, "peRatio": 36.3, "evToEbitda": 25.6,
    "fcfYield": 3.2, "roe": 164.6, "netDebtToEbitda": 0.37, "debtToEquity": 1.9,
}

# The same live shape lacking P/E — a field the live producer carries, so
# its absence is this company's, not the producer's: valuation refuses.
LIVE_US_MSFT_NO_PE = dict(LIVE_US_AAPL, ticker="MSFT", companyName="Microsoft Corp.",
                          peRatio=None)


@pytest.fixture
def client(monkeypatch):
    for var in ("SEC_EDGAR_ENABLED", "ANTHROPIC_API_KEY", "FILINGS_EXTRACTION_ENABLED"):
        monkeypatch.delenv(var, raising=False)
    reset_intelligence_cache()
    monkeypatch.setattr(routes, "_fetch_universe_snapshots",
                        lambda: {"AAPL": dict(LIVE_US_AAPL), "MSFT": dict(LIVE_US_MSFT_NO_PE)})
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


def test_per_ticker_risk_score_refuses_for_a_live_row_lacking_a_carried_input(client):
    r = client.get("/api/public/intelligence/companies/MSFT/risk-score")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["overall_risk_score"] is None
    assert body["risk_level"] is None
    assert body["categories"]["valuation"] is None     # no P/E: this company's gap
    assert body["categories"]["financial"] is None     # dropped: no producer carries interest expense
    assert body["categories"]["operational"] is None   # dropped: live carries no revenue growth
    assert isinstance(body["categories"]["macro"], int)
    by = {x["component"]: x for x in body["refusals"]}
    assert by["valuation"]["code"] == "risk_category_unavailable"
    assert by["valuation"]["inputs"] == ["pe_ratio"]
    assert by["financial"]["code"] == "risk_category_dropped"
    assert by["operational"]["code"] == "risk_category_dropped"
    # The composite refuses on the refused category only — a dropped
    # category is stated in `coverage`, never redistributed away silently.
    assert by["overall"]["inputs"] == ["valuation"]
    assert by["overall"]["text"] == (
        "Composite risk unavailable: valuation inputs not reported for MSFT."
    )
    assert [d["category"] for d in body["coverage"]["dropped"]] == ["financial", "operational"]


def test_universe_batch_serves_null_scores_with_reasons(client, monkeypatch):
    # One-ticker universe so the batch builds exactly the row under test.
    from engine.public import universe as universe_module
    monkeypatch.setattr(universe_module, "DEFAULT_UNIVERSE",
                        [t for t in universe_module.DEFAULT_UNIVERSE if t[0] == "MSFT"])
    r = client.get("/api/public/intelligence/risk-scores")
    assert r.status_code == 200, r.text
    row = r.json()["scores"]["MSFT"]
    assert row["risk_score"] is None and row["risk_level"] is None
    assert row["risk_refusal"] == (
        "Composite risk unavailable: valuation inputs not reported for MSFT."
    )
    # P/E is an opportunity input too: that score refuses, with its reason.
    assert row["opportunity_score"] is None
    assert row["opportunity_refusal"].startswith("Opportunity score unavailable:")


def test_ai_market_read_headline_states_the_refusal(client):
    r = client.get("/api/public/intelligence/companies/MSFT/ai-market-read")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["headline"].startswith("MSFT composite risk unavailable,"), body["headline"]
    assert "composite risk unavailable" in body["summary"].lower()
