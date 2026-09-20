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


# ── the cache that outlived the engine ──────────────────────────────────────

def test_the_report_stamps_its_own_revision():
    r = _report({"revenue": 1.0, "net_income_statutory": ANCHOR})
    assert r["report_revision"] == be.REPORT_REVISION
    assert isinstance(be.REPORT_REVISION, int) and be.REPORT_REVISION >= 2


def test_a_cached_report_from_an_older_engine_is_refused(monkeypatch):
    """BEHAVIOURAL, not a source scan (the first version of this test passed
    against a planted `if False and stale_revision:` — it read the shape, not
    the conduct).

    The headline fix shipped on 2026-09-20 was still serving a report generated
    on 9 September: the cache is keyed on period_id alone, and an ENGINE change
    mints no new period_id. A cached row from an older revision must be dropped
    and recomputed.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from engine.api import _benchmarks, _supabase

    ORG, PERIOD, CAEN = "org-1", "p-1", "1013"
    stale = {"report_revision": 1, "period_id": PERIOD, "caen_code": CAEN,
             "sections": {"headline": {"metrics": ["net_income_operating"],
                                       "company_values": {"net_income_operating": RECONSTRUCTION},
                                       "display": {}, "title_en": "H", "title_ro": "H"}}}
    built = {"n": 0}

    class Client:
        def __enter__(self): return self
        def __exit__(self, *e): return None
        def select(self, table, **kw):
            if table == "financial_periods":
                return [{"id": PERIOD, "org_id": ORG, "currency": "RON"}]
            if table == "organizations":
                return [{"id": ORG, "name": "Scandia"}]
            if table == "benchmark_reports":
                return [{"report_data": dict(stale), "generated_at": "2026-09-09T08:25:00Z",
                         "caen_code": CAEN}]
            if table == "industry_benchmarks":
                return [{"caen_code": CAEN, "metric_name": "net_margin", "p50": 5.0,
                         "p25": 2.0, "p75": 9.0, "unit": "pct"}]
            if table == "calculated_metrics":
                return [{"name": "net_income_statutory", "value": ANCHOR, "unit": None},
                        {"name": "revenue", "value": 413_727_560.16, "unit": None}]
            return []
        def upsert(self, *a, **k): return []
        def insert(self, *a, **k): return []

    def counting_build(**kw):
        built["n"] += 1
        return be.build_benchmark_report(**kw)

    monkeypatch.setattr(_benchmarks, "_require_jwt", lambda a=None: "jwt")
    monkeypatch.setattr(_benchmarks, "_resolve_user_org", lambda jwt, org=None: (jwt, ORG))
    monkeypatch.setattr(_benchmarks, "_resolve_effective_caen",
                        lambda **kw: (CAEN, "assignment", None))
    monkeypatch.setattr(_benchmarks, "build_benchmark_report", counting_build)
    monkeypatch.setattr(_supabase, "admin", lambda: Client())
    monkeypatch.setattr(_supabase, "per_user", lambda jwt: Client())

    app = FastAPI(); app.include_router(_benchmarks.build_router())
    body = TestClient(app).get(f"/api/benchmarks/report/{PERIOD}",
                               headers={"Authorization": "Bearer x"}).json()

    assert built["n"] == 1, "the stale-revision row was served instead of recomputed"
    assert body.get("report_revision") == be.REPORT_REVISION
    assert body.get("cached") is False
    head = body["sections"]["headline"]
    assert head["metrics"][-1] == "net_income_statutory"
    assert head["company_values"]["net_income_statutory"] == pytest.approx(ANCHOR)


def test_a_cached_report_at_the_CURRENT_revision_is_still_served(monkeypatch):
    """The revision check must not turn the cache off altogether."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from engine.api import _benchmarks, _supabase

    ORG, PERIOD, CAEN = "org-1", "p-1", "1013"
    fresh = {"report_revision": be.REPORT_REVISION, "period_id": PERIOD, "caen_code": CAEN,
             "sections": {"headline": {"metrics": [], "company_values": {}, "display": {},
                                       "title_en": "H", "title_ro": "H"}}}

    class Client:
        def __enter__(self): return self
        def __exit__(self, *e): return None
        def select(self, table, **kw):
            if table == "financial_periods":
                return [{"id": PERIOD, "org_id": ORG, "currency": "RON"}]
            if table == "organizations":
                return [{"id": ORG, "name": "Scandia"}]
            if table == "benchmark_reports":
                return [{"report_data": dict(fresh), "generated_at": "now", "caen_code": CAEN}]
            return []
        def upsert(self, *a, **k): return []

    monkeypatch.setattr(_benchmarks, "_require_jwt", lambda a=None: "jwt")
    monkeypatch.setattr(_benchmarks, "_resolve_user_org", lambda jwt, org=None: (jwt, ORG))
    monkeypatch.setattr(_benchmarks, "_resolve_effective_caen", lambda **kw: (CAEN, "assignment", None))
    monkeypatch.setattr(_benchmarks, "build_benchmark_report",
                        lambda **kw: pytest.fail("a current-revision cache hit was recomputed"))
    monkeypatch.setattr(_supabase, "admin", lambda: Client())
    monkeypatch.setattr(_supabase, "per_user", lambda jwt: Client())

    app = FastAPI(); app.include_router(_benchmarks.build_router())
    body = TestClient(app).get(f"/api/benchmarks/report/{PERIOD}",
                               headers={"Authorization": "Bearer x"}).json()
    assert body.get("cached") is True
