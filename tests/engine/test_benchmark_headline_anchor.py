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


# ── the two surfaces BELOW the headline, on the same page ───────────────────
#
# The 2026-09-20 repair above moved the headline tile onto the account-121
# anchor and stopped there. Two other figures on the SAME benchmark page kept
# reading `net_income`, the class-6/7 reconstruction:
#
#   · the "Compania ta" row of the named-peer table (`net_profit_mlei`) —
#     printed in a column whose other rows are peers' FILED net profits from
#     Ministry of Finance accounts, so the company's own row was the only
#     one in the table on a different basis;
#   · `net_margin`, which is then graded against the sector percentile bands
#     and repeated in the gap-vs-leader table.
#
# Measured on the four committed firm books (tests/engine/fixtures/firm/
# served_metrics.json, real `calculated_metrics` as the route reads them):
#
#   book         headline tile     "Compania ta"   net margin   was graded as
#   agras         7,533,676.02          14.1 M        6.35 %        11.90 %
#   carniprod     1,435,533.59           5.8 M        1.44 %         5.88 %
#   realestate     -801,604.14         -30.4 M     -493.70 %    -18,717.91 %
#   retail        3,205,212.62           1.2 M        4.03 %         1.46 %
#
# CLAUDE.md §21: when a hardening fix lands in one place, grep for every
# sibling that reads the same thing.
#
# Fails on: either surface dropping back to the reconstruction when the period
# carries the anchor; the two disagreeing with the headline tile; the
# legacy (no-anchor) fallback losing the operating view; and the denominator
# or the 722 operating-view adjustment being changed, which are deliberate and
# are NOT what this gate is about.

FIRM_BOOKS = ("agras", "carniprod", "realestate", "retail")


def _firm_metrics(book):
    import json, pathlib
    root = pathlib.Path(__file__).resolve().parents[1] / "engine" / "fixtures" / "firm"
    served = json.loads((root / "served_metrics.json").read_text(encoding="utf-8"))[book]
    fx = json.loads((root / f"saga_10_col_{book}.json").read_text(encoding="utf-8"))
    rows = [{"name": k, "value": v, "unit": None} for k, v in served.items() if v is not None]
    return rows, fx["line_items"], served


@pytest.mark.parametrize("book", FIRM_BOOKS)
def test_the_company_row_prints_the_profit_the_headline_prints(book):
    rows, line_items, _ = _firm_metrics(book)
    cm = be.compute_company_metrics(rows, line_items)
    head = cm[be.headline_metrics(cm)[-1]]
    r = be.build_benchmark_report(
        period_id="p1", caen_code="1013", caen_label="Meat",
        industry_category="manufacturing_consumer", calculated_metrics=rows,
        line_items=line_items, benchmarks={}, company_name="Compania",
        peers=[{"company_name": "Peer", "tier": "leader", "net_profit_mlei": 1.0,
                "display_order": 1}],
    )
    deep = r.get("sections", {}).get("deep") or r.get("deep") or {}
    me = next(p for p in deep["peers"] if p.get("tier") == "self")
    assert me["net_profit_mlei"] == pytest.approx(round(head / 1_000_000, 1)), (
        "the peer table's own row prints a different profit from the headline tile "
        "on the same page"
    )


@pytest.mark.parametrize("book", FIRM_BOOKS)
def test_the_graded_net_margin_is_built_on_that_same_profit(book):
    rows, line_items, served = _firm_metrics(book)
    cm = be.compute_company_metrics(rows, line_items)
    head = cm[be.headline_metrics(cm)[-1]]
    rev_denom = cm.get("total_operating_revenue") or cm.get("revenue")
    assert cm["net_margin"] == pytest.approx(head / rev_denom * 100.0, rel=1e-9), (
        "the margin the percentile bands grade is not the profit the page prints"
    )


@pytest.mark.parametrize("book", FIRM_BOOKS)
def test_that_margin_is_the_one_every_other_surface_shows(book):
    """The engine already serves `net_margin` as a ratio for the dashboard and
    the report. The benchmark's own recompute differs only by its operating
    denominator, so on a book where the two denominators agree the two figures
    must agree too — otherwise one screen grades a margin the next screen does
    not print."""
    rows, line_items, served = _firm_metrics(book)
    cm = be.compute_company_metrics(rows, line_items)
    if cm.get("total_operating_revenue") != cm.get("revenue"):
        pytest.skip("operating revenue differs from turnover on this book")
    # The served row is a ROUNDED ratio; compare at the precision it was
    # stored with, read off the row itself rather than asserted as a cutoff.
    decimals = len(repr(served["net_margin"]).partition(".")[2])
    assert round(cm["net_margin"] / 100.0, decimals) == pytest.approx(served["net_margin"])


def test_a_legacy_period_without_the_anchor_keeps_the_operating_view():
    """No `net_income_statutory` row: both surfaces fall back to
    `net_income + 722`, the documented EEI operating view — never to zero and
    never to the bare cash figure."""
    rows = [{"name": "revenue", "value": 1_000.0, "unit": None},
            {"name": "net_income", "value": 100.0, "unit": None}]
    line_items = [{"statement": "PL", "bucket": "capitalizedOwnWork", "amount": 40.0},
                  {"statement": "PL", "bucket": "revenue", "amount": 1_000.0}]
    cm = be.compute_company_metrics(rows, line_items)
    assert cm["net_income_operating"] == pytest.approx(140.0)
    assert be.headline_metrics(cm)[-1] == "net_income_operating"
    # The denominator stays the operating one (1,000 turnover + 40 of 722) —
    # this gate is about the NUMERATOR, and changing that denominator is a
    # deliberate decision recorded in `compute_company_metrics`.
    assert cm["total_operating_revenue"] == pytest.approx(1_040.0)
    assert cm["net_margin"] == pytest.approx(140.0 / 1_040.0 * 100.0)


def test_a_period_with_no_profit_at_all_prints_no_row_rather_than_722():
    """A period that reported no profit of either kind must show no bottom
    line — absent is not zero, and it is certainly not 722.

    RESTATED 2026-09-21. This test used to open by ASSERTING the defect it was
    written to guard against: `assert cm["net_income_operating"] == 40.0`,
    i.e. the capitalized-own-work figure standing in for a profit nobody
    filed, with a docstring saying in the same breath that 722 is not a
    profit. The `or 0` floor behind it has since been removed, so the metric
    is now ABSENT — and the row stays blank for the honest reason rather than
    by a second guard downstream. (See "gates that encode the defect": the
    red on a repair is sometimes the gate.)"""
    rows = [{"name": "revenue", "value": 1_000.0, "unit": None}]
    line_items = [{"statement": "PL", "bucket": "capitalizedOwnWork", "amount": 40.0},
                  {"statement": "PL", "bucket": "revenue", "amount": 1_000.0}]
    cm = be.compute_company_metrics(rows, line_items)
    assert "net_income_operating" not in cm or cm["net_income_operating"] is None, \
        "722 stood in for a profit that was never reported"
    r = be.build_benchmark_report(
        period_id="p1", caen_code="1013", caen_label="Meat",
        industry_category="manufacturing_consumer", calculated_metrics=rows,
        line_items=line_items, benchmarks={}, company_name="Compania",
        peers=[{"company_name": "Peer", "tier": "leader", "net_profit_mlei": 1.0,
                "display_order": 1}],
    )
    deep = r.get("sections", {}).get("deep") or r.get("deep") or {}
    me = next(p for p in deep["peers"] if p.get("tier") == "self")
    assert me["net_profit_mlei"] is None


# ── `or 0` is a floor, and this one reached the screen ──────────────────────

def test_a_period_with_no_reported_profit_refuses_instead_of_printing_zero():
    """`net_income_operating = (out.get("net_income") or 0) + cap_own` gave a
    period with no reported profit a net income of cap_own — commonly 0.00 —
    printed as a figure, and every sector margin was graded against it. Absent
    is not zero: with nothing filed, the headline, the peer row and the margin
    refuse together."""
    metrics = be.compute_company_metrics(
        [{"name": "revenue", "value": 84_000_000.0, "unit": None}], [])
    assert metrics.get("net_income_operating") is None
    assert metrics.get("net_margin") is None
    assert be.headline_net_income_of(metrics) is None

    r = be.build_benchmark_report(
        period_id="p1", caen_code="1013", caen_label="Meat",
        industry_category="manufacturing_consumer",
        calculated_metrics=[{"name": "revenue", "value": 84_000_000.0, "unit": None}],
        line_items=[], benchmarks={}, company_name="No-profit SRL",
    )
    head = r["sections"]["headline"] if "headline" in r.get("sections", {}) else r["headline"]
    slot = head["metrics"][-1]
    assert head["company_values"].get(slot) is None, \
        "the headline printed a profit for a period that reported none"


def test_a_reported_zero_profit_is_still_a_figure():
    """A company that filed exactly zero filed a number. Only ABSENCE refuses."""
    metrics = be.compute_company_metrics([
        {"name": "revenue", "value": 84_000_000.0, "unit": None},
        {"name": "net_income", "value": 0.0, "unit": None},
    ], [])
    assert metrics.get("net_income_operating") == 0.0
    assert metrics.get("net_margin") == 0.0
    assert be.headline_net_income_of(metrics) == 0.0
