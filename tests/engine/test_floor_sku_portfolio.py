"""SKU / portfolio engine — floor substitutes refuse (owner ruling 2026-09-15).

Absent is never zero and never a floor. Each test drives a SERVED surface
(the real FastAPI app over in-memory sqlite, or the function that writes
the served payload) with the measured input from the floor sweep, and
asserts the served figure is null with its reason — plus a control that the
measured figure is still the arithmetic it claims to be (TC-11).

Sites (floor_sweep.json fix_list C7):
  C7.1  api/frontend.py share_of_category_profit_pct  `or 1.0`
  C7.2  actions.py / api/cfo_ai.py / api/frontend.py portfolio real margin
        and ROIC (`or 1.0`, `if d > 0 else 0.0`), anchor profit share
  C7.3  api/frontend.py volume-weighted category DIO `or 1.0`
  C7.4  api/frontend.py DIO-sheet clamp to [7, 365] and assumed 90-day period
  C7.5  metrics.composite_score `max(DIO, 1)`
  census siblings: api/frontend.py revenue-weighted GM% `if niv > 0 else 0.0`

TC-11, what this reds on after the repair: a numeric portfolio margin /
ROIC / share served where its denominator is not positive; a category or
SKU classified on a GM% it has no revenue to weight; a DIO of 0 served for
rows that state positive DIO; a DIO-sheet value clamped into its plausible
band, or computed over an unconfirmed period.
"""

from __future__ import annotations

import datetime as _dt
import os
from datetime import date
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from engine.actions import build_output
from engine.api import create_app
from engine.api.frontend import (
    DIO_SHEET_PERIOD_DAYS_RANGE,
    DIO_SHEET_PLAUSIBLE_DAYS,
    SkuRowIn,
    _aggregate_to_categories,
    _load_dio_from_workbook,
)
from engine.config import load_config
from engine.metrics import (
    ANCHOR_PROFIT_SHARE_UNDEFINED,
    PORTFOLIO_REAL_MARGIN_UNDEFINED,
    PORTFOLIO_ROIC_UNDEFINED,
    composite_score,
    niv_weighted_margin,
    portfolio_roic,
)
from engine.models import CategoryRow
from engine.pipeline import run_pipeline

REPO_ROOT = Path(__file__).resolve().parents[2]
CFG = load_config(REPO_ROOT / "config.yaml")


#: /run-daily is the engine bearer's (it fails closed without a configured
#: token); every other route this file drives is public and ignores it.
ENGINE_TOKEN = "floor-sku-engine-token"
ENGINE_AUTH = {"Authorization": "Bearer %s" % ENGINE_TOKEN}


@pytest.fixture
def client(monkeypatch):
    # HERMETIC (2026-10-02): `create_app()` verifies the Supabase variables at
    # boot; without the switch these tests errored at setup on any host with
    # no .env (green only where the variables, or a leaked switch, happened
    # to be set). Nothing they assert reads Supabase.
    monkeypatch.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")
    monkeypatch.setenv("ENGINE_API_TOKEN", ENGINE_TOKEN)
    return TestClient(create_app(config_path=REPO_ROOT / "config.yaml"))


def _cat(name, niv, gm, dio, vol=10.0):
    return CategoryRow(category=name, volume_tons=vol, niv_kron=niv, gm_pct=gm, dio_days=dio)


def _summary(rows):
    metrics, decisions = run_pipeline(rows, CFG, period_months=12)
    return build_output(decisions, metrics, CFG, run_date=date(2026, 1, 1), data_period="x")


# ─── metrics.py helpers ─────────────────────────────────────────────────


def test_niv_weighted_margin_refuses_zero_and_negative_weights():
    value, refusal = niv_weighted_margin([(29.3, 0.0)])
    assert value is None and refusal["code"] == PORTFOLIO_REAL_MARGIN_UNDEFINED
    assert refusal["text"] == (
        "Portfolio real margin unavailable: total NIV is zero, so there is nothing "
        "to weight the category margins by."
    )
    value, refusal = niv_weighted_margin([(29.3, 1000.0), (9.3, -1000.0)])
    assert value is None and "negative NIV" in refusal["text"]
    value, refusal = niv_weighted_margin([(29.3, 1000.0), (9.3, 3000.0)])
    assert refusal is None and value == pytest.approx((29.3 * 1000 + 9.3 * 3000) / 4000)


def test_portfolio_roic_refuses_zero_capital():
    value, refusal = portfolio_roic(300.0, 0.0)
    assert value is None and refusal["code"] == PORTFOLIO_ROIC_UNDEFINED
    value, refusal = portfolio_roic(300.0, 150.0)
    assert refusal is None and value == pytest.approx(200.0)


def test_composite_score_refuses_non_positive_dio():
    assert composite_score(real_margin_pct=10.0, sales=1000.0, dio_days=0) is None
    assert composite_score(real_margin_pct=10.0, sales=1000.0, dio_days=100) == pytest.approx(100.0)


# ─── actions.py: POST /run-daily + CLI payload ──────────────────────────


def test_run_daily_summary_refuses_zero_niv():
    """Measured: one category NIV 0 served real_margin_pct 0.0 while the
    category itself said 29.3."""
    out = _summary([_cat("Lactate", 0.0, 30, 40)])
    es = out["executive_summary"]
    assert es["real_margin_pct"] is None and es["roic_pct"] is None
    codes = {r["component"]: r["code"] for r in es["refusals"]}
    assert codes == {"real_margin_pct": PORTFOLIO_REAL_MARGIN_UNDEFINED,
                     "roic_pct": PORTFOLIO_ROIC_UNDEFINED}
    assert out["summary"]["total_roic_pct"] is None
    assert out["summary"]["total_roic_refusal"]["code"] == PORTFOLIO_ROIC_UNDEFINED


def test_run_daily_summary_refuses_netting_niv_instead_of_20000_pct():
    out = _summary([_cat("Lactate", 1000.0, 30, 40), _cat("Carne", -1000.0, 10, 40)])
    assert out["executive_summary"]["real_margin_pct"] is None


def test_run_daily_summary_refuses_roic_on_zero_trapped_capital():
    """Measured: NIV 1000, DIO 0 → 300 kRON profit on 0 capital served 0.0."""
    out = _summary([_cat("Lactate", 1000.0, 30, 0)])
    es = out["executive_summary"]
    assert es["roic_pct"] is None
    assert es["real_margin_pct"] == pytest.approx(30.0)


def test_run_daily_summary_control_is_the_arithmetic():
    rows = [_cat("Lactate", 1000.0, 30, 40)]
    metrics, _ = run_pipeline(rows, CFG, period_months=12)
    m = metrics[0]
    es = _summary(rows)["executive_summary"]
    assert es["refusals"] == []
    assert es["real_margin_pct"] == pytest.approx(round(m.real_margin_pct, 2))
    assert es["roic_pct"] == pytest.approx(
        round(m.abs_profit_kron / m.capital_trapped_kron * 100.0, 2))


def test_run_daily_route_serves_the_refusal(client):
    """The served route, end to end over the sqlite adapter."""
    app = client.app
    app.state.adapter.insert_categories(date(2025, 10, 31), [_cat("Lactate", 0.0, 30, 40)])
    r = client.post("/run-daily", headers=ENGINE_AUTH,
                    json={"run_date": "2026-05-04",
                          "snapshot_date": "2025-10-31",
                          "period_months": 10})
    assert r.status_code == 200, r.text
    es = r.json()["executive_summary"]
    assert es["real_margin_pct"] is None and es["roic_pct"] is None
    assert len(es["refusals"]) == 2


# ─── api/cfo_ai.py ──────────────────────────────────────────────────────


def _cats_json(*rows):
    return [dict(category=n, volume_tons=10, niv_kron=niv, gm_pct=gm, dio_days=dio)
            for n, niv, gm, dio in rows]


def test_cfo_today_refuses_and_the_briefing_states_why(client):
    r = client.post("/api/cfo/today", json=dict(categories=_cats_json(("A", 0.0, 30, 40)),
                                                persist_recommendations=False))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["executive_summary"]["real_margin_pct"] is None
    assert body["executive_summary"]["roic_pct"] is None
    assert "Portfolio real margin unavailable" in body["briefing"]["body"]
    assert "0.0%" not in body["briefing"]["body"]


def test_cfo_profit_portfolio_and_rankings_refuse(client):
    r = client.post("/api/cfo/profit", json=dict(categories=_cats_json(("A", 0.0, 30, 40),
                                                                        ("B", 0.0, 12, 60))))
    assert r.status_code == 200, r.text
    body = r.json()
    p = body["portfolio"]
    assert p["weighted_gross_margin_pct"] is None
    assert p["weighted_real_margin_pct"] is None
    assert p["margin_leak_pp"] is None
    assert all(row["roic_pct"] is None for row in body["roic_ranking"])
    assert all(row["gmroii_pct"] is None for row in body["gmroii_ranking"])


def test_cfo_board_summary_states_refused_roic(client):
    r = client.post("/api/cfo/exports/board-summary",
                    json=dict(categories=_cats_json(("A", 1000.0, 30, 0))))
    assert r.status_code == 200, r.text
    md = r.json()["markdown"]
    assert "Portfolio ROIC unavailable" in md
    assert "ROIC: **0.0%**" not in md


# ─── api/frontend.py ────────────────────────────────────────────────────


def _row(cat, sku, vol, rev, gm, dio=None):
    return dict(category=cat, sku=sku, volume_tons=vol, revenue_kron=rev,
                gross_margin_pct=gm, dio_days=dio)


def test_skus_share_of_category_profit_refuses_net_zero(client):
    """Measured: profits +500 / -500 served shares 50,000.0 / -50,000.0."""
    r = client.post("/api/skus", json={"rows": [
        _row("ZZTEST", "A", 10, 5000, 11.6), _row("ZZTEST", "B", 10, 5000, -8.4)]})
    assert r.status_code == 200, r.text
    skus = r.json()["skus"]
    assert sum(s["abs_profit_kron"] for s in skus) == pytest.approx(0.0)
    for s in skus:
        assert s["share_of_category_profit_pct"] is None
        assert s["share_of_category_profit_refusal"]["text"].startswith(
            "Share of category profit unavailable: SKU profits in this category net to zero")


def test_skus_share_of_category_profit_refuses_negative_total(client):
    """Measured: total -100 flipped the sign — a +100 kRON SKU served -100.0."""
    r = client.post("/api/skus", json={"rows": [
        _row("ZZTEST", "A", 10, 1000, 11.6), _row("ZZTEST", "B", 10, 1000, -18.4)]})
    skus = r.json()["skus"]
    assert sum(s["abs_profit_kron"] for s in skus) < 0
    assert all(s["share_of_category_profit_pct"] is None for s in skus)
    assert "net to a loss" in skus[0]["share_of_category_profit_refusal"]["text"]


def test_skus_share_control_is_profit_over_positive_total(client):
    r = client.post("/api/skus", json={"rows": [
        _row("ZZTEST", "A", 10, 5000, 11.6), _row("ZZTEST", "B", 10, 1000, -8.4)]})
    skus = r.json()["skus"]
    total = sum(s["abs_profit_kron"] for s in skus)
    assert total > 0
    for s in skus:
        assert s["share_of_category_profit_pct"] == pytest.approx(
            round(s["abs_profit_kron"] / total * 100.0, 1))


def test_zero_revenue_category_is_refused_not_eliminated(client):
    """Measured: revenue 0, stated GM 25% → GM 0.0 → ELIMINATE / LIQUIDATE on
    real margin -1.6. It is now refused, with the reason on the payload."""
    r = client.post("/api/classify-rows", json={"rows": [
        _row("ZZZERO", "s1", 5, 0.0, 25.0), _row("ZZLIVE", "s2", 5, 1000.0, 20.0)]})
    assert r.status_code == 200, r.text
    run = r.json()
    names = [x["name"] for b in ("anchors", "eliminate", "review", "scale") for x in run[b]]
    assert "ZZZERO" not in names and "ZZLIVE" in names
    refused = [x for x in run["refusals"] if x["code"] == "category_gross_margin_undefined"]
    assert [x["component"] for x in refused] == ["category:ZZZERO"]


def test_zero_revenue_sku_inside_a_live_category_is_refused():
    refusals = []
    cats, skus = _aggregate_to_categories(
        [SkuRowIn(**_row("X", "live", 5, 1000.0, 20.0)),
         SkuRowIn(**_row("X", "dead", 5, 0.0, 30.0))], {}, refusals=refusals)
    assert [s.sku_id for s in skus] == ["live"]
    assert cats[0].gm_pct == pytest.approx(20.0)
    assert [r["component"] for r in refusals] == ["sku:dead"]


def test_zero_volume_dio_rows_fall_through_to_the_upload_sheet():
    """Measured: DIO 180 / 120 on zero volume with a sheet at 150 served DIO 0,
    real margin 20.0 and 0 trapped; expected DIO 150, 15.1%, 3,287.7 kRON."""
    rows = [SkuRowIn(**_row("X", "a", 0, 5000, 20, dio=180)),
            SkuRowIn(**_row("X", "b", 0, 3000, 20, dio=120))]
    refusals = []
    cats, _ = _aggregate_to_categories(rows, {}, {"X": 150}, refusals=refusals)
    assert cats[0].dio_days == 150
    metrics, _ = run_pipeline(cats, CFG.model_copy(update={"cost_of_capital_pct": 12.0}), 12)
    assert metrics[0].real_margin_pct == pytest.approx(15.1)
    assert metrics[0].capital_trapped_kron == pytest.approx(3287.7, abs=0.1)
    assert [r["code"] for r in refusals] == ["category_weighted_dio_undefined"]


def test_weighted_dio_control_with_volume():
    rows = [SkuRowIn(**_row("X", "a", 3, 5000, 20, dio=180)),
            SkuRowIn(**_row("X", "b", 1, 3000, 20, dio=120))]
    cats, _ = _aggregate_to_categories(rows, {}, {"X": 150}, refusals=[])
    assert cats[0].dio_days == round((180 * 3 + 120 * 1) / 4)


def _dio_workbook(tmp_path, banner, rows):
    """A DIO sheet in the legacy two-block layout the loader reads."""
    grid = [[None] * 17 for _ in range(2 + len(rows))]
    for i, v in enumerate(banner):
        grid[0][i] = v
    for r, (cat, end_kg, start_kg) in enumerate(rows, start=2):
        grid[r][0], grid[r][7] = cat, end_kg
        grid[r][9], grid[r][16] = cat, start_kg
    path = tmp_path / "dio.xlsx"
    with pd.ExcelWriter(path) as xw:
        pd.DataFrame(grid).to_excel(xw, sheet_name="DIO", header=False, index=False)
    return path


def test_dio_sheet_serves_measured_outlier_and_flags_it(tmp_path):
    """HERING-like stock: 1,000 kg on hand, 60 kg sold over 89 days is ~1,483
    days. It used to be clamped to 365."""
    path = _dio_workbook(tmp_path, ["01.01.2026", "31.03.2026"],
                         [("HERING", 1000.0, 1000.0), ("SUC", 500.0, 500.0)])
    notes = []
    out = _load_dio_from_workbook(path, {"HERING": 0.06, "SUC": 1.0}, notes)
    assert out["HERING"] == round(1000.0 * 89 / 60.0)
    assert out["HERING"] > DIO_SHEET_PLAUSIBLE_DAYS[1]
    assert out["SUC"] == round(500.0 * 89 / 1000.0)
    assert [n["component"] for n in notes] == ["dio_days:HERING"]
    lo, hi = DIO_SHEET_PLAUSIBLE_DAYS
    assert f"outside the {lo}-{hi} day band" in notes[0]["text"]


def test_dio_sheet_without_a_confirmed_period_is_not_used(tmp_path):
    """No banner dates: the sheet used to assume a 90-day quarter."""
    path = _dio_workbook(tmp_path, [None, None], [("SUC", 500.0, 500.0)])
    notes = []
    assert _load_dio_from_workbook(path, {"SUC": 1.0}, notes) == {}
    assert [n["code"] for n in notes] == ["dio_sheet_period_unconfirmed"]
    assert "does not carry two dates" in notes[0]["text"]


# ─── api/frontend.py narrative: a refused figure is stated, never 0.0 or a 500 ──


def _refused_run():
    """A DailyRun as `_to_daily_run` serves it when both headline figures refuse."""
    return {
        "date": "2026-01-01", "period": "x", "workingCapitalMRon": 0.0,
        "roicPct": None, "costOfCapitalPct": 6.5, "confidence": "low",
        "anchorProfitShare": None,
        "refusals": [
            {"code": PORTFOLIO_ROIC_UNDEFINED, "component": "roicPct", "inputs": {},
             "text": "Portfolio ROIC unavailable: capital trapped is zero."},
            {"code": ANCHOR_PROFIT_SHARE_UNDEFINED, "component": "anchorProfitShare",
             "inputs": {}, "text": "Anchor profit share unavailable: the portfolio's "
             "absolute profit nets to a loss (-3.0 kRON), so there is no profit to "
             "take a share of."},
        ],
        "anchors": [], "eliminate": [], "scale": [],
        "review": [{"name": "A", "realMargin": -1.0, "absoluteProfit": -3.0, "reason": "x"}],
    }


def _legacy_client(monkeypatch):
    """/api/analyze sits behind the LEGACY_SKU_AI_ENABLED wall; no model key, so
    the narrative is the deterministic one."""
    monkeypatch.setenv("LEGACY_SKU_AI_ENABLED", "1")
    monkeypatch.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")  # hermetic: see `client`
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    os.environ.pop("ENGINE_API_TOKEN", None)
    return TestClient(create_app(config_path=REPO_ROOT / "config.yaml"))


def test_analyze_route_states_refused_roic_and_share_instead_of_500(monkeypatch):
    """The narrative formatted `run.get("roicPct", 0)` — a PRESENT None is not
    defaulted, so `f"{None:.1f}"` raised and the route 500'd for exactly the
    portfolios whose figures refused. `eliminate` is empty so no model call
    is attempted; the summary is deterministic."""
    client = _legacy_client(monkeypatch)
    r = client.post("/api/analyze", json={"run": _refused_run(), "language": "en"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "ROIC unavailable (Portfolio ROIC unavailable: capital trapped is zero.)" in body["headline"]
    assert "an unavailable share of real profit (Anchor profit share unavailable" in body["summary_en"]
    assert "o cotă indisponibilă din profitul real" in body["summary_ro"]
    for text in (body["headline"], body["summary_en"], body["summary_ro"]):
        assert "0.0% ROIC" not in text and "0.0% of real profit" not in text


def test_analyze_route_control_formats_a_measured_roic(monkeypatch):
    client = _legacy_client(monkeypatch)
    run = dict(_refused_run(), roicPct=38.8, anchorProfitShare=0.833, refusals=[])
    body = client.post("/api/analyze", json={"run": run}).json()
    assert "38.8% ROIC" in body["headline"]
    assert "83.3% of real profit" in body["summary_en"]


# ─── sku_pipeline.py (CLI loader path): share of category NIV ───────────────


def test_sku_share_of_category_niv_is_undefined_over_a_zero_total():
    """Measured before: `total or 1.0` gave a 1,000 kRON SKU in a category whose
    SKU NIV nets to zero a share of 1,000x — 500 kRON of parent WOCA allocated
    as 500,000 kRON, and -500,000 to its mirror. With the share undefined the
    parent's WOCA and inventory are not allocated; the SKU keeps only what it
    supplied itself."""
    from engine.models import SkuRow
    from engine.sku_pipeline import compute_sku_metrics
    parent = CategoryRow(category="X", volume_tons=10, niv_kron=2000.0, gm_pct=20,
                         dio_days=40, woca_kron=500.0)
    skus = [SkuRow(sku_id="a", sku_name="a", category="X", volume_tons=5,
                   niv_kron=1000.0, gm_pct=20),
            SkuRow(sku_id="b", sku_name="b", category="X", volume_tons=5,
                   niv_kron=-1000.0, gm_pct=20)]
    out = {m.category: m for m in compute_sku_metrics(skus, [parent], 6.5)}
    assert out["a"].woca_kron is None and out["b"].woca_kron is None
    assert out["a"].avg_inventory_kron is None and out["a"].capital_trapped_kron is None
    assert out["a"].roic_pct is None and out["a"].gmroii_pct is None


def test_sku_share_of_category_niv_control_allocates_pro_rata():
    from engine.models import SkuRow
    from engine.sku_pipeline import compute_sku_metrics
    parent = CategoryRow(category="X", volume_tons=10, niv_kron=4000.0, gm_pct=20,
                         dio_days=40, woca_kron=500.0)
    skus = [SkuRow(sku_id="a", sku_name="a", category="X", volume_tons=5,
                   niv_kron=1000.0, gm_pct=20),
            SkuRow(sku_id="b", sku_name="b", category="X", volume_tons=5,
                   niv_kron=3000.0, gm_pct=20)]
    out = {m.category: m for m in compute_sku_metrics(skus, [parent], 6.5)}
    assert out["a"].woca_kron == pytest.approx(125.0)
    assert out["b"].woca_kron == pytest.approx(375.0)
    assert out["a"].avg_inventory_kron == pytest.approx(4000.0 * 40 / 365.0 * 0.25)


# ─── api/frontend.py _to_daily_run: anchorProfitShare over a non-positive total ─


def test_classify_rows_refuses_anchor_profit_share_when_profit_nets_to_a_loss(client):
    """Verifier plant V3 (2026-09-19) left the gates GREEN with `anchor_share =
    0.0` served on a zero/loss total — the figure is a headline on
    /run-daily, /classify-rows and the upload payload, and no test read it."""
    r = client.post("/api/classify-rows", json={"rows": [
        _row("ZZLOSS", "s1", 5, 1000.0, -30.0), _row("ZZTHIN", "s2", 5, 100.0, 2.0)]})
    assert r.status_code == 200, r.text
    run = r.json()
    total = sum(x["absoluteProfit"] for b in ("anchors", "eliminate", "review", "scale")
                for x in run[b])
    assert total < 0
    assert run["anchorProfitShare"] is None
    refusal = next(x for x in run["refusals"] if x["component"] == "anchorProfitShare")
    assert refusal["code"] == ANCHOR_PROFIT_SHARE_UNDEFINED
    assert refusal["text"].startswith(
        "Anchor profit share unavailable: the portfolio's absolute profit nets to a loss")
    assert refusal["inputs"]["total_abs_profit_kron"] == pytest.approx(round(total, 2))


def test_classify_rows_anchor_profit_share_control_is_anchor_over_total(client):
    r = client.post("/api/classify-rows", json={"rows": [
        _row("ZZBIG", "s1", 50, 50000.0, 30.0, dio=20),
        _row("ZZSMALL", "s2", 5, 1000.0, 20.0, dio=20)]})
    run = r.json()
    total = sum(x["absoluteProfit"] for b in ("anchors", "eliminate", "review", "scale")
                for x in run[b])
    anchor = sum(x["absoluteProfit"] for x in run["anchors"])
    assert total > 0 and run["anchors"], run
    assert run["anchorProfitShare"] == pytest.approx(round(anchor / total, 3))
    assert not [x for x in run["refusals"] if x["component"] == "anchorProfitShare"]


# ─── api/frontend.py DIO sheet: an out-of-range banner span refuses, never clamps ─


@pytest.mark.parametrize("banner, span", [
    (["01.01.2026", "11.01.2026"], 10),
    (["01.01.2025", "05.02.2026"], 400),
])
def test_dio_sheet_out_of_range_banner_span_is_not_used(tmp_path, banner, span):
    """Verifier plant V4 (2026-09-19): `min(max(diff, 30), 366)` in place of the
    range check left the gates GREEN — a 10- or 400-day banner was served as a
    confirmed 30- or 366-day period and every category DIO computed over it."""
    path = _dio_workbook(tmp_path, banner, [("SUC", 500.0, 500.0)])
    notes = []
    assert _load_dio_from_workbook(path, {"SUC": 1.0}, notes) == {}
    assert [n["code"] for n in notes] == ["dio_sheet_period_unconfirmed"]
    lo, hi = DIO_SHEET_PERIOD_DAYS_RANGE
    assert f"spans {span} days, outside the {lo}-{hi} day range" in notes[0]["text"]
    assert notes[0]["inputs"] == {"banner_dates_found": 2, "banner_span_days": span}
