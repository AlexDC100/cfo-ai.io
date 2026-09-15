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
    DIO_SHEET_PLAUSIBLE_DAYS,
    SkuRowIn,
    _aggregate_to_categories,
    _load_dio_from_workbook,
)
from engine.config import load_config
from engine.metrics import (
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


@pytest.fixture
def client():
    os.environ.pop("ENGINE_API_TOKEN", None)
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
    r = client.post("/run-daily", json={"run_date": "2026-05-04",
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
