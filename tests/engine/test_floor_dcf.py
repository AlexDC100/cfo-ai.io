"""Floor-substitute fixes, batch C3 — the valuation DCF (owner rulings
R-D5, R-D6, R-OTHER, 2026-09-15) and POST /api/period/{id}/valuation/recompute.

THE RULE UNDER TEST: absent is never zero and never a floor. Each test
asserts the CLAIM a surface makes (is this figure a measurement? is the
refusal the sentence the page shows?), never a shape property of the
figure (TC-11).

What this file reds on AFTER the repair (TC-11), beside the plant that
proved it (TC-2 — plant log in docs/engine_book/gates.md, `floor-valuation`):

* DCF — reds if a non-positive / absent equity, a negative FCF, a WACC at
  or below g, or a negative debt ever yields an enterprise value again; if
  a measured implied cost of debt stops being the one used; if the tax
  label stops rendering its bound from pack data.
* recompute — reds if an out-of-domain override is computed instead of
  answered 400, or if an in-domain request stops answering 200.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

import pytest

from engine.api import _valuation as V
from engine.country_packs.ro_romania import parameters as PARAMS

import test_rebuild_net_income_anchor as ANCHOR

REPO = Path(__file__).resolve().parents[2]

def _stub_benchmarks(key):  # noqa: ARG001
    return {"industry_key_used": "generic", "industry_key_requested": key or "generic",
            "ev_ebitda": {"p25": 6.0, "p50": 8.0, "p75": 10.0, "source": "stub", "as_of_date": None},
            "ev_revenue": {"p25": 0.5, "p50": 0.8, "p75": 1.2, "source": "stub", "as_of_date": None}}


def _dcf(**over: Any) -> Dict[str, Any]:
    """`_dcf_cross_check` on a solvent, profitable, levered book; `over`
    replaces any input. The skeptic's measured book (floor_sweep.json)."""
    kw: Dict[str, Any] = dict(
        net_income=2_000_000.0, depreciation=500_000.0, total_debt=10_000_000.0,
        cash=0.0, interest_expense=800_000.0, tax_expense=400_000.0,
        pretax=2_400_000.0, total_equity=15_000_000.0, real_capex=None,
        net_wc_change=0.0,
    )
    kw.update(over)
    return V._dcf_cross_check(**kw)


def _codes(d: Dict[str, Any]):
    return [r["code"] for r in d["refusals"]]


def _assert_no_dcf_value(d: Dict[str, Any]) -> None:
    for k in ("enterprise_value", "equity_value", "sensitivity_low", "sensitivity_high", "scenarios"):
        assert d[k] is None, "%s served %r beside a refusal %s" % (k, d[k], _codes(d))


# ── DCF: capital structure ──────────────────────────────────────────────


@pytest.mark.parametrize("equity", [-5_000_000.0, 0.0])
def test_dcf_refuses_when_book_equity_is_not_positive(equity):
    """Measured before the fix: equity -5,000,000 (and 0, and 1) served
    WACC 5.0%, weight_debt 1.0, total_equity_used 1.0, EV 26,357,383.94 —
    2.5x the same book at +5,000,000 equity."""
    d = _dcf(total_equity=equity, net_income=500_000.0, pretax=500_000.0, tax_expense=0.0,
             interest_expense=0.0)
    assert _codes(d) == ["dcf_equity_not_positive"]
    _assert_no_dcf_value(d)
    assert d["wacc"] is None
    assert d["wacc_components"]["total_equity_used"] == equity  # the book's figure, unfloored
    assert d["wacc_components"]["weight_debt"] is None
    assert "book equity is not positive" in d["refusals"][0]["text"]


def test_dcf_refuses_when_book_equity_is_absent():
    d = _dcf(total_equity=None)
    assert _codes(d) == ["dcf_equity_absent"]
    _assert_no_dcf_value(d)


def test_dcf_refuses_a_negative_debt_figure():
    d = _dcf(total_debt=-1.0)
    assert "dcf_debt_negative" in _codes(d)
    _assert_no_dcf_value(d)


# ── DCF: cost of debt (R-D5) ────────────────────────────────────────────


def test_a_measured_implied_cost_of_debt_is_used_even_below_the_old_floor():
    """Measured before the fix: interest 0 and a real 2.0% rate served an
    IDENTICAL Kd 5.00% and EV 29,158,422.27 — the floor overrode the book."""
    measured = _dcf(interest_expense=200_000.0)
    comp = measured["wacc_components"]
    assert comp["kd_source"] == "implied"
    assert comp["cost_of_debt_pre_tax"] == 0.02
    assert measured["enterprise_value"] != 29_158_422.27
    absent = _dcf(interest_expense=None)
    assert absent["enterprise_value"] != measured["enterprise_value"]


@pytest.mark.parametrize("interest,phrase", [
    (None, "is not reported"), (0.0, "no interest expense"), (-10.0, "is negative"),
])
def test_unmeasurable_cost_of_debt_is_the_declared_methodology_assumption(interest, phrase):
    d = _dcf(interest_expense=interest)
    comp = d["wacc_components"]
    lo, hi = PARAMS.METHODOLOGY_KD_AFTER_TAX_RANGE
    assert comp["kd_source"] == "methodology_assumption"
    assert comp["cost_of_debt_pre_tax"] is None
    assert comp["cost_of_debt_after_tax_range"] == [lo, hi]
    assert comp["cost_of_debt_after_tax"] == round((lo + hi) / 2, 4)
    # TC-10: the range is rendered from the pack data, not written as prose.
    assert "%.1f%%-%.1f%%" % (lo * 100, hi * 100) in comp["kd_note"]
    assert phrase in comp["kd_note"]
    assert d["refusals"] == []


def test_no_debt_makes_cost_of_debt_not_applicable_not_five_percent():
    """Corpus carniprod served cost_of_debt_pre_tax 0.05 on zero debt."""
    d = _dcf(total_debt=0.0, interest_expense=0.0)
    comp = d["wacc_components"]
    assert comp["kd_source"] == "not_applicable_no_debt"
    assert comp["cost_of_debt_pre_tax"] is None and comp["cost_of_debt_after_tax"] is None
    assert d["wacc"] == round(comp["cost_of_equity"], 4)


# ── DCF: tax (R-D6) ─────────────────────────────────────────────────────


def test_an_effective_rate_inside_the_statutory_bound_is_used():
    d = _dcf(tax_expense=300_000.0, pretax=2_400_000.0)
    assert d["wacc_components"]["tax_source"] == "effective"
    assert d["wacc_components"]["tax_rate"] == 0.125


@pytest.mark.parametrize("tax,pretax,why", [
    (1_320_000.0, 2_400_000.0, "outside"),       # 55% — the old clamp served 25%
    (-100_000.0, 2_400_000.0, "outside"),        # negative — the old clamp served 0%
    (0.0, -500_000.0, "not positive"),           # loss — the old code served 0%
    (None, 2_400_000.0, "not reported"),
])
def test_an_unusable_effective_rate_takes_the_labelled_statutory_rate(tax, pretax, why):
    d = _dcf(tax_expense=tax, pretax=pretax)
    comp = d["wacc_components"]
    statutory = PARAMS.STATUTORY_PROFIT_TAX_RATE
    assert comp["tax_source"] == "statutory"
    assert comp["tax_rate"] == statutory
    assert why in comp["tax_label"]
    if why == "outside":
        assert "[0, %.1f%%]" % (statutory * 100) in comp["tax_label"]


# ── DCF: free cash flow and the Gordon domain ───────────────────────────


def test_dcf_refuses_a_non_positive_base_fcf_and_serves_it_signed():
    """Measured before the fix: NI -2,000,000 served base_fcf 0.0, EV 0.0,
    equity value -10,000,000 (= -net debt), low = high."""
    d = _dcf(net_income=-2_000_000.0, pretax=-2_000_000.0, tax_expense=0.0,
             total_debt=12_000_000.0, cash=2_000_000.0, total_equity=5_000_000.0)
    assert _codes(d) == ["dcf_base_fcf_not_positive"]
    assert d["base_fcf"] == -2_000_000.0
    _assert_no_dcf_value(d)


def test_dcf_refuses_absent_fcf_inputs_instead_of_reading_them_as_zero():
    d = _dcf(net_wc_change=None)
    assert _codes(d) == ["dcf_fcf_input_absent"]
    assert d["refusals"][0]["inputs"] == ["cashFlow.net_wc_change"]
    _assert_no_dcf_value(d)


def test_dcf_refuses_when_wacc_does_not_exceed_terminal_growth():
    """Measured before the fix: terminal_growth 0.2 served dcf_wacc 11.74%
    beside scenario WACCs of 20.5% and EV 692,629,098.21."""
    d = _dcf(terminal_growth_override=0.2)
    assert _codes(d) == ["dcf_wacc_not_above_growth"]
    _assert_no_dcf_value(d)
    assert "g 20.0%" in d["refusals"][0]["text"]


def test_only_the_scenario_that_crosses_g_refuses():
    # Ke = 3.5%, no debt -> central WACC 3.5% > g 3.0%; Optimistic 2.5% <= g.
    d = _dcf(total_debt=0.0, interest_expense=0.0, rf_override=0.035, beta_override=0.0)
    assert d["refusals"] == []
    by = {s["label"]: s for s in d["scenarios"]}
    assert by["Optimistic"]["enterprise_value"] is None
    assert by["Optimistic"]["refusal"]["code"] == "dcf_wacc_not_above_growth"
    assert by["Central"]["enterprise_value"] is not None
    assert d["sensitivity_high"] is None and d["sensitivity_low"] is not None


@pytest.mark.parametrize("over,needle", [
    ({"forecast_years": 0}, "'forecast_years' must be at least 1"),
    ({"forecast_years": 2.5}, "'forecast_years' must be a whole number"),
    ({"terminal_growth": -1.0}, "'terminal_growth' must be greater than -1.0"),
    ({"beta": float("nan")}, "'beta' must be a finite number"),
])
def test_override_domain_errors_render_from_the_domain_table(over, needle):
    errors = V.dcf_override_domain_errors(over)
    assert len(errors) == 1 and needle in errors[0]
    assert V.dcf_override_domain_errors({"forecast_years": 5, "terminal_growth": 0.02}) == []


def test_compute_valuation_serves_signed_stabilized_fcf_and_states_the_refusal(monkeypatch):
    """Measured before the fix (CRE, NI -3,000,000, ΔWC -500,000): served
    stabilized_fcf 0.0 beside free_cash_flow -17,500,000, dcf_equity_value
    -19,000,000 — a banner reading "net income + ΔWC ≈ RON 0.00"."""
    monkeypatch.setattr(V, "load_valuation_benchmarks", _stub_benchmarks)
    statements = {
        "balanceSheet": {}, "incomeStatement": {},
        "assembled_pl": {"net_income_statutory": -3_000_000.0, "depreciation": 500_000.0,
                         "interest_expense": 1_000_000.0, "tax": 0.0, "pretax": -3_000_000.0,
                         "ebitda_statutory": 2_000_000.0},
        "assembled_bs": {"cash": 1_000_000.0, "total_debt": 20_000_000.0,
                         "total_equity": 30_000_000.0, "total_assets": 55_000_000.0},
        "assembled_cf": {"capex_real": -15_000_000.0, "net_wc_change": -500_000.0},
    }
    out = V.compute_valuation(industry_key="real_estate_commercial", statements=statements)
    assert out["fcf_breakdown"]["stabilized_fcf"] == -3_500_000.0
    assert out["dcf_enterprise_value"] is None and out["dcf_equity_value"] is None
    assert [r["code"] for r in out["dcf_refusals"]] == ["dcf_base_fcf_not_positive"]
    assert out["dcf_refusals"][0]["text"] in out["method_warnings"]


# ── The production wiring: absent inputs reach the DCF as absent ────────
#
# `_dcf_cross_check` refuses an absent input; `compute_valuation` is the
# layer every served / recompute path calls, and it is where a re-floor
# would hide (`_first(..., 0.0)`, a legacy `else 1.0`). These tests pass
# statements with the key REMOVED — not set to 0 — and assert the refusal
# code and a null EV at the served envelope.


def _wired(**drop_or_set: Any) -> Dict[str, Any]:
    """A solvent, profitable canonical envelope; `drop_or_set` maps
    `"assembled_bs.total_equity"` to `None` (delete the key) or a value."""
    statements: Dict[str, Any] = {
        "balanceSheet": {}, "incomeStatement": {},
        "assembled_pl": {"net_income_statutory": 1_400_000.0, "depreciation": 300_000.0,
                         "interest_expense": 200_000.0, "tax": 300_000.0, "pretax": 1_700_000.0,
                         "ebitda_statutory": 2_200_000.0},
        "assembled_bs": {"cash": 500_000.0, "total_debt": 3_000_000.0,
                         "total_equity": 12_000_000.0, "total_assets": 20_000_000.0},
        "assembled_cf": {"capex_real": 0.0, "net_wc_change": 300_000.0, "is_approximated": False},
    }
    for dotted, value in drop_or_set.items():
        view, key = dotted.split(".")
        if value is None:
            statements[view].pop(key, None)
        else:
            statements[view][key] = value
    return statements


@pytest.mark.parametrize("dropped,code", [
    ("assembled_bs.total_equity", "dcf_equity_absent"),
    ("assembled_bs.total_debt", "dcf_debt_absent"),
    ("assembled_bs.cash", "dcf_cash_absent"),
    ("assembled_cf.net_wc_change", "dcf_fcf_input_absent"),
])
def test_compute_valuation_refuses_an_absent_balance_or_wc_input(monkeypatch, dropped, code):
    """Plant P5b (`dcf_cash = _first(..., 0.0)`, legacy debt `else 0.0`,
    legacy equity `else 1.0`) and P5c (`net_wc_change` `_first(..., 0.0)`)
    left every `_dcf_cross_check` test green: the re-floor sat one layer up."""
    monkeypatch.setattr(V, "load_valuation_benchmarks", _stub_benchmarks)
    control = V.compute_valuation(industry_key=None, statements=_wired())
    assert control["dcf_refusals"] == [] and control["dcf_enterprise_value"] > 0
    out = V.compute_valuation(industry_key=None, statements=_wired(**{dropped: None}))
    assert [r["code"] for r in out["dcf_refusals"]] == [code], out["dcf_refusals"]
    assert out["dcf_enterprise_value"] is None and out["dcf_equity_value"] is None
    assert out["dcf_sensitivity_low"] is None and out["dcf_sensitivity_high"] is None
    assert out["dcf_refusals"][0]["text"] in out["method_warnings"]


def test_compute_valuation_never_builds_net_income_from_an_absent_tax(monkeypatch):
    """Measured before the fix: `assembled_pl` with only ebitda_statutory /
    depreciation / interest_expense served `dcf_refusals []`, base FCF
    1,700,000, EV 18,665,048.19 and `fcf_breakdown.net_income 1,400,000`
    beside `tax_label: 'statutory 16.0% (effective rate not measurable: tax
    expense not reported ...)'` — the same envelope declared the tax
    unreported and served an NI that read it as 0."""
    monkeypatch.setattr(V, "load_valuation_benchmarks", _stub_benchmarks)
    out = V.compute_valuation(industry_key=None, statements=_wired(**{
        "assembled_pl.net_income_statutory": None, "assembled_pl.tax": None,
        "assembled_pl.pretax": None}))
    assert [r["code"] for r in out["dcf_refusals"]] == ["dcf_fcf_input_absent"]
    assert out["dcf_refusals"][0]["inputs"] == ["incomeStatement.net_income"]
    assert out["dcf_enterprise_value"] is None
    assert out["fcf_breakdown"]["net_income"] is None
    assert out["fcf_breakdown"]["stabilized_fcf"] is None
    assert "tax expense not reported" in out["dcf_wacc_components"]["tax_label"]
    # Both reported and no statutory line: the legacy difference is used.
    legacy = V.compute_valuation(industry_key=None, statements=_wired(**{
        "assembled_pl.net_income_statutory": None}))
    assert legacy["dcf_refusals"] == []
    assert legacy["fcf_breakdown"]["net_income"] == 1_400_000.0
    # Tax reported, pre-tax not: still no invented net income.
    half = V.compute_valuation(industry_key=None, statements=_wired(**{
        "assembled_pl.net_income_statutory": None, "assembled_pl.pretax": None}))
    assert [r["code"] for r in half["dcf_refusals"]] == ["dcf_fcf_input_absent"]
    assert "pre-tax profit not reported" in half["dcf_wacc_components"]["tax_label"]


# ── POST /api/period/{id}/valuation/recompute ───────────────────────────


def _corpus_book(name: str):
    return ANCHOR._book("saga_10_col_%s" % name, REPO / "corpus" / ("saga_10_col_%s" % name))


def _recompute(monkeypatch, body: Dict[str, Any]):
    monkeypatch.setattr(V, "load_valuation_benchmarks", _stub_benchmarks)
    bk = _corpus_book("agras")
    with ANCHOR._routed(bk, monkeypatch) as (client, _db):
        # The route reads the CALLER'S saved overrides (tenancy hotfix
        # 2026-10-02), so this world must say who is calling.
        _db.get_user = lambda _jwt: {"id": ANCHOR.REANALYZE_USER}
        return client.post("/api/period/%s/valuation/recompute" % bk.period_id,
                           json=body, headers={"Authorization": "Bearer test"})


def test_recompute_answers_200_with_a_computed_dcf_at_in_domain_overrides(monkeypatch):
    resp = _recompute(monkeypatch, {"terminal_growth": 0.02, "forecast_years": 5})
    assert resp.status_code == 200, resp.text[:400]
    val = resp.json()["valuation"]
    assert val["dcf_refusals"] == []
    assert val["dcf_enterprise_value"] is not None and val["dcf_enterprise_value"] > 0


@pytest.mark.parametrize("body,needle", [
    ({"terminal_growth": 0.2}, "must exceed terminal growth"),
    ({"forecast_years": 0}, "'forecast_years' must be at least 1"),
    ({"forecast_years": 2.5}, "whole number"),
    ({"rf": "nan"}, "'rf' must be a finite number"),
])
def test_recompute_answers_400_on_an_out_of_domain_override(monkeypatch, body, needle):
    resp = _recompute(monkeypatch, body)
    assert resp.status_code == 400, resp.text[:400]
    assert needle in resp.json()["detail"]




# ── The approximated working-capital change is stated, not silently used ─


def test_an_approximated_wc_change_is_labelled_on_the_dcf_and_the_tiles(monkeypatch):
    """Every single-period RO book yields `assembled_cf.is_approximated`
    (±5% of closing balances); the DCF read it as a measurement and its
    refusal sentence stated "net income + working-capital change = -302K"
    on Scandia as if the -302K had been read off the books."""
    monkeypatch.setattr(V, "load_valuation_benchmarks", _stub_benchmarks)
    base = {
        "balanceSheet": {}, "incomeStatement": {},
        "assembled_pl": {"net_income_statutory": 1_000_000.0, "depreciation": 500_000.0,
                         "interest_expense": 100_000.0, "tax": 160_000.0, "pretax": 1_000_000.0,
                         "ebitda_statutory": 2_000_000.0},
        "assembled_bs": {"cash": 1_000_000.0, "total_debt": 2_000_000.0,
                         "total_equity": 10_000_000.0, "total_assets": 20_000_000.0},
    }
    approx = dict(base, assembled_cf={"capex_real": 0.0, "net_wc_change": -1_500_000.0,
                                      "is_approximated": True})
    out = V.compute_valuation(industry_key=None, statements=approx)
    assert out["fcf_breakdown"]["net_wc_change_source"].startswith("approximated")
    assert out["dcf_refusals"][0]["code"] == "dcf_base_fcf_not_positive"
    assert "[approximated: no prior-period balance sheet]" in out["dcf_refusals"][0]["text"]
    measured = dict(base, assembled_cf={"capex_real": 0.0, "net_wc_change": -1_500_000.0,
                                        "is_approximated": False})
    out2 = V.compute_valuation(industry_key=None, statements=measured)
    assert out2["fcf_breakdown"]["net_wc_change_source"] == "measured"
    assert "approximated" not in out2["dcf_refusals"][0]["text"]
    # The label never moves a number.
    assert out["fcf_breakdown"]["stabilized_fcf"] == out2["fcf_breakdown"]["stabilized_fcf"] == -500_000.0


# ── A nil interest charge on positive debt is a ruling, not a measured 0% ─


def test_a_nil_interest_charge_on_positive_debt_is_the_declared_range_not_a_measured_zero():
    """The book yielded a figure (0), so this is a substitute — an explicit
    one: the ruling in parameters.py is rendered on the served kd_note."""
    d = _dcf(interest_expense=0.0)
    wc = d["wacc_components"]
    assert wc["kd_source"] == "methodology_assumption"
    lo, hi = PARAMS.METHODOLOGY_KD_AFTER_TAX_RANGE
    assert wc["cost_of_debt_after_tax"] == (lo + hi) / 2
    assert "no interest expense (class 666) is booked" in wc["kd_note"]
    assert PARAMS.METHODOLOGY_KD_ZERO_INTEREST_RULING in wc["kd_note"]
    assert "not as a measured 0%" in wc["kd_note"]
# ── PUT / DELETE /api/period/{id}/valuation-assumptions ─────────────────
#
# The two sibling routes of the recompute seam (§21: grep every sibling).
# Both persist a valuations row for the period; both rebuilt the statements
# through the bucket-only `_rebuild_assembled` (no assembled_pl / _bs /
# _cf), so every save / reset persisted `dcf_fcf_input_absent` — a DCF
# refusal on a period whose GET computes a DCF.


def _valuation_assumptions(monkeypatch, method: str):
    monkeypatch.setattr(V, "load_valuation_benchmarks", _stub_benchmarks)
    bk = _corpus_book("agras")
    with ANCHOR._routed(bk, monkeypatch) as (client, db):
        # The double carries no `get_user` / `upsert`; the routes need both.
        db.tables.setdefault("user_valuation_assumptions", [])
        db.get_user = lambda _jwt: {"id": ANCHOR.REANALYZE_USER}
        db.upsert = lambda table, row, on_conflict=None: db.insert(table, row)
        url = "/api/period/%s/valuation-assumptions" % bk.period_id
        headers = ANCHOR._member_bearer()
        if method == "put":
            resp = client.put(url, json={"notes": "saved by the test"}, headers=headers)
        else:
            resp = client.delete(url, headers=headers)
        rows = list(db.tables.get("valuations", []))
    return resp, rows


@pytest.mark.parametrize("method", ["put", "delete"])
def test_saving_or_resetting_assumptions_persists_the_dcf_the_get_path_serves(monkeypatch, method):
    """Measured before the fix (corpus agras, whose GET and recompute both
    compute a DCF): the persisted valuations row carried
    `dcf_enterprise_value None` after every save / reset, because the
    bucket-only rebuild handed the DCF no working-capital change."""
    resp, rows = _valuation_assumptions(monkeypatch, method)
    assert resp.status_code == 200 and resp.json() == {"ok": True}, resp.text[:400]
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["dcf_enterprise_value"] is not None and row["dcf_enterprise_value"] > 0, row
    assert row["dcf_equity_value"] is not None


