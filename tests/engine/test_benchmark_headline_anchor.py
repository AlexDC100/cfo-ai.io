"""GATE — the benchmark headline prints the SAME profit the dashboard prints.

Measured on production 2026-09-20: the Benchmark page's headline read
"NET INCOME / LOSS 36.3 M RON" for Scandia Dec 2025 while the dashboard's NET
PROFIT card read 36.8 M — one company, one click apart, two different profits.
The dashboard shows `net_income_statutory` (account 121's closing balance, the
number on the filed accounts, which the pipeline explicitly anchors); the
benchmark headline showed `net_income_operating`, the reconstruction.

Same family as "two assembly paths, one anchor": a second surface deriving its
own view of a figure the engine already has an authority for.

Fails on: the headline dropping back to the operating view when the period
carries the anchor; a statutory zero being treated as absent; either view
losing the label that says which one it is; the headline slot being read from
the module constant instead of the per-period resolution.
"""
from __future__ import annotations

import pytest

from engine.api import _benchmark_engine as be

ANCHOR = 36_787_352.75      # account 121 closing — what the dashboard shows
RECONSTRUCTION = 36_267_964.0  # the operating view


def test_the_headline_prefers_the_statutory_anchor():
    chosen = be.headline_metrics({"net_income_statutory": ANCHOR,
                                  "net_income_operating": RECONSTRUCTION})
    assert chosen[-1] == "net_income_statutory"
    assert "net_income_operating" not in chosen


def test_a_statutory_zero_is_a_figure_not_an_absence():
    """A company that made exactly zero profit still filed zero."""
    assert be.headline_metrics({"net_income_statutory": 0.0,
                                "net_income_operating": 12.0})[-1] == "net_income_statutory"


def test_a_legacy_period_without_the_anchor_falls_back_and_says_so():
    chosen = be.headline_metrics({"net_income_operating": RECONSTRUCTION})
    assert chosen[-1] == "net_income_operating"
    assert "operating" in be.METRIC_DISPLAY["net_income_operating"]["en"].lower()


def test_both_views_are_labelled_distinctly_in_both_languages():
    stat, oper = be.METRIC_DISPLAY["net_income_statutory"], be.METRIC_DISPLAY["net_income_operating"]
    for lang in ("en", "ro"):
        assert stat[lang] != oper[lang], f"{lang}: the two views share a label"
    assert "statutory" in stat["en"].lower() and "statutar" in stat["ro"].lower()


def _report(metrics):
    rows = [{"name": k, "value": v, "unit": None} for k, v in metrics.items()]
    return be.build_benchmark_report(
        period_id="p1", caen_code="1013", caen_label="Meat", industry_category="manufacturing_consumer",
        calculated_metrics=rows, line_items=[], benchmarks={}, company_name="Scandia",
    )


def test_the_served_report_carries_the_anchor_and_its_label():
    r = _report({"revenue": 413_727_560.16, "net_income_statutory": ANCHOR,
                 "net_income_operating": RECONSTRUCTION, "ebitda_cash": 54_443_833.33})
    head = r["sections"]["headline"] if "headline" in r.get("sections", {}) else r["headline"]
    assert head["metrics"][-1] == "net_income_statutory"
    assert head["company_values"]["net_income_statutory"] == pytest.approx(ANCHOR)
    assert "statutory" in head["display"]["net_income_statutory"]["en"].lower()
    assert "net_income_operating" not in head["company_values"], \
        "the reconstruction must not sit in the headline beside the anchor"


def test_the_report_is_driven_by_the_resolution_not_the_constant(monkeypatch):
    """Plant: pin headline_metrics back to the module constant. The served
    report must then carry the reconstruction — which is the defect, so this
    test states exactly what a regression would look like."""
    monkeypatch.setattr(be, "headline_metrics", lambda m: list(be.HEADLINE_METRICS))
    r = _report({"revenue": 1.0, "net_income_statutory": ANCHOR, "net_income_operating": RECONSTRUCTION})
    head = r["sections"]["headline"] if "headline" in r.get("sections", {}) else r["headline"]
    assert head["metrics"][-1] == "net_income_operating", \
        "the plant did not take — build_benchmark_report is not calling headline_metrics"
