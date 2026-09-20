"""FORECAST v1.5 — the gates the demo surface stands on.

WHY THIS FILE EXISTS
====================
Three of the four executive-strip figures and all fourteen chart series
were ALREADY served by fp1.2 before this wave; what had no gate was
whether the strip still equals the statements it summarises, whether the
trough marked on the cash chart is the minimum of the curve drawn beside
it, and — once B7 made the growth default readable from the book — whether
that default can quietly become the macro anchor (or a zero) while the
page prints a [book] chip beside it.

A page reads these four numbers as headlines. A headline that drifts from
the table under it is worse than one that refuses.

WHAT THIS REDS ON (TC-11), after the repairs of this wave:
  · a strip figure computed from anything other than the served figures
    (closing cash off the last served period, cumulative FCF off the two
    served cash-flow lines, peak funding off the served revolver balance);
  · a cash trough that is not the minimum of the served closing-cash
    series, or that names a period other than the first one holding it;
  · a revenue_growth default that carries tier "book" without its two
    turnovers, or that falls to the macro anchor while a comparable prior
    period IS held;
  · a growth value that disagrees with the two turnovers its OWN basis
    names — the same drift class as the strip one, one level down;
  · a prior period in ANOTHER workspace being read, named, or reaching
    the growth;
  · an interim or two-years-back period being spent as a prior year;
  · any projected period of any corpus book failing to balance.

WHAT IT CANNOT SEE
  · what the page paints (frontend has its own gate);
  · whether a growth is a GOOD forecast — it is the book's own arithmetic,
    and the basis says so;
  · a covenant breach. The engine holds no covenant input at all and
    serves strip.first_breach_period as a standing refusal; a test that
    asserted a breach year here would be asserting a fabrication.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]
BOOKS = ("agras", "carniprod", "retail", "realestate")
#: packs/forecast/ro_macro.yaml's inflation anchor, in ratio micros. The
#: value the ladder falls to when no book history is held — named here so a
#: "book" rung that is really the anchor cannot pass unnoticed.
MACRO_ANCHOR_MICROS = 25000


def _measure():
    import sys
    scripts = str(REPO / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import measure_plan_blast_radius as M
    return M


# ── a row server that holds MORE THAN ONE period ─────────────────────────


class _Rows(object):
    """``measure_plan_blast_radius._RowServer`` holds exactly one period and
    ignores any filter that is not ``eq.``. The prior-period select is
    ``org_id=eq. AND period_end=lt. AND id=neq.`` with an ``order`` and a
    ``limit``, so a double that drops those three would answer the anchor as
    its own prior and prove nothing. This one honours them."""

    def __init__(self, periods, org_rows=None):
        #: periods: [(period_id, org_id, period_end, book)]
        self._periods = list(periods)
        self._orgs = list(org_rows or [])

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def close(self):
        return None

    def _financial_periods(self):
        return [{"id": pid, "org_id": oid, "period_end": end,
                 "period_start": book.get("period_start"),
                 "period_label": end,
                 "currency": book.get("currency") or "RON",
                 "updated_at": "1970-01-01T00:00:00+00:00",
                 "assembled_canonical_v1": book["envelope"]}
                for pid, oid, end, book in self._periods]

    def _line_items(self):
        out = []
        for pid, _oid, _end, book in self._periods:
            out.extend(dict(row, period_id=pid) for row in book["line_items"])
        return out

    def select(self, table, filters=None, columns=None, limit=None,
               order=None, single=False, **_kw):
        if table == "financial_periods":
            rows = self._financial_periods()
        elif table == "statement_line_items":
            rows = self._line_items()
        elif table == "organizations":
            rows = list(self._orgs) or [
                {"id": oid, "name": None, "industry_key": None,
                 "industry_display_name": None, "firm_id": None}
                for _p, oid, _e, _b in self._periods]
        else:
            rows = []
        for key, cond in (filters or {}).items():
            if not isinstance(cond, str):
                continue
            op, _sep, value = cond.partition(".")
            if op == "eq":
                rows = [r for r in rows if str(r.get(key)) == value]
            elif op == "neq":
                rows = [r for r in rows if str(r.get(key)) != value]
            elif op == "lt":
                rows = [r for r in rows if str(r.get(key) or "") < value]
            elif op == "gt":
                rows = [r for r in rows if str(r.get(key) or "") > value]
            else:  # an operator this double does not model is never ignored
                raise AssertionError("unmodelled filter %s=%s" % (key, cond))
        if order:
            for clause in reversed(order.split(",")):
                name, _s, direction = clause.strip().partition(".")
                rows = sorted(rows, key=lambda r: str(r.get(name) or ""),
                              reverse=direction == "desc")
        if columns and columns != "*":
            wanted = [c.strip() for c in columns.split(",") if c.strip()]
            rows = [dict((c, r.get(c)) for c in wanted if c in r) for r in rows]
        if limit is not None:
            rows = rows[:limit]
        return rows


def _book(name):
    return json.loads(
        (REPO / "tests" / "engine" / "fixtures" / "firm"
         / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


def _scaled(book, factor):
    """The same book with every line item scaled. A linear scaling keeps the
    trial balance balanced, so the prior period rebuilds through the real
    assembly exactly as the anchor does — no hand-built statements."""
    out = copy.deepcopy(book)
    for row in out["line_items"]:
        row["amount"] = round(float(row["amount"]) * factor, 2)
    out["envelope"] = book["envelope"]
    return out


def _get(periods, period_id, org_id, horizon=3):
    from engine.api import _forecast_history, _org, _supabase
    M = _measure()
    saved = (_org.resolve_org, _supabase.per_user)
    _org.resolve_org = lambda jwt, requested: ("v15-user", org_id)
    _supabase.per_user = lambda jwt: _Rows(periods)
    _forecast_history.clear_cache()
    try:
        client = TestClient(M._app(), raise_server_exceptions=False)
        res = client.get("/api/forecast/%s?horizon=%d" % (period_id, horizon),
                         headers={"Authorization": "Bearer v15",
                                  "X-Org-Id": org_id},
                         follow_redirects=False)
    finally:
        _org.resolve_org, _supabase.per_user = saved
        _forecast_history.clear_cache()
    return res.status_code, res.json()


def _one(name, horizon=3):
    book = _book(name)
    pid, oid = "v15-%s" % name, "v15-org-%s" % name
    return _get([(pid, oid, book["period_end"], book)], pid, oid, horizon)


def _figure(body, line, period):
    for f in body["figures"]:
        if f["line"] == line and f["period"] == period:
            return f
    raise AssertionError("no figure %s at %s" % (line, period))


# ── G1: the strip equals the statements it summarises ────────────────────


@pytest.mark.parametrize("name", BOOKS)
def test_every_strip_figure_equals_the_served_figures_it_summarises(name):
    """3.9. The strip is the page's headline row; the figures block is the
    table under it. They are two readings of ONE projection and must agree
    to the cent.

    RED ON: closing cash read off any period but the last served one;
    cumulative FCF that is not the two served cash-flow lines summed over
    exactly the served periods; peak funding that is not the largest served
    revolver balance, or a peak period that does not hold it."""
    status, body = _one(name)
    assert status == 200, (status, str(body)[:300])
    served = [p for p in body["horizon"]["labels"]
              if any(f["period"] == p and "amount_minor" in f
                     for f in body["figures"])]
    assert served, "no period served"
    last = body["horizon"]["served_through"]
    assert last == served[-1], (last, served[-1])

    assert body["strip"]["closing_cash"]["amount_minor"] == \
        _figure(body, "bs.cash", last)["amount_minor"]

    expected_fcf = sum(_figure(body, line, p)["amount_minor"]
                       for p in served
                       for line in ("cf.cash_from_operating",
                                    "cf.cash_from_investing"))
    assert body["strip"]["cumulative_fcf"]["amount_minor"] == expected_fcf

    revolvers = [(p, _figure(body, "bs.revolver", p)["amount_minor"])
                 for p in served]
    peak = max([0] + [v for _p, v in revolvers])
    gap = body["strip"]["peak_funding_gap"]
    assert gap["amount"]["amount_minor"] == peak, (gap, peak)
    if peak > 0:
        first_at_peak = [p for p, v in revolvers if v == peak][0]
        assert gap["period"] == first_at_peak, (gap["period"], first_at_peak)
    else:
        assert gap["period"] is None, gap


def test_a_strip_figure_that_drifts_from_the_statements_is_caught(monkeypatch):
    """TC-2 PLANT. One cent added to every strip amount — the smallest
    drift a hand-composed strip can acquire, and the shape the B6RV2-5
    defect had one block over (a strip re-derived beside the statements
    instead of from them). The gate above must red on it.

    AFTER THE REPAIR this plant is the gate's own proof: if it ever passes,
    the gate has stopped reading the figures block."""
    from engine.forecast_serving.blocks import strip as strip_block

    real = strip_block.fig

    def drifted(amount, line, labels, attribution, formula):
        return real(amount + 1, line, labels, attribution, formula)

    monkeypatch.setattr(strip_block, "fig", drifted)
    with pytest.raises(AssertionError):
        test_every_strip_figure_equals_the_served_figures_it_summarises("agras")


# ── G2: the trough is the minimum of the curve ───────────────────────────


@pytest.mark.parametrize("name", BOOKS)
def test_the_cash_trough_is_the_minimum_of_the_served_cash_series(name):
    """3.8. The chart draws series.closing_cash and marks summary.cash_trough
    on it. A mark that is not on the curve is a lie the reader cannot check.

    RED ON: a trough amount that is not the minimum of the served points; a
    trough period that is not the FIRST period holding that minimum (the
    engine breaks ties on period index, and a chart marking a later one
    would move under a lever that changes nothing)."""
    status, body = _one(name)
    assert status == 200, (status, str(body)[:300])
    points = [p for p in body["series"]["closing_cash"] if "amount_minor" in p]
    assert points, "no served cash point"
    trough = body["summary"]["cash_trough"]
    assert trough is not None
    lowest = min(p["amount_minor"] for p in points)
    assert trough["amount"]["amount_minor"] == lowest, (trough, lowest)
    assert trough["period"] == [p["period"] for p in points
                                if p["amount_minor"] == lowest][0]
    # ...and the mark sits on the curve the chart actually draws
    on_curve = [p for p in points if p["period"] == trough["period"]][0]
    assert on_curve["amount_minor"] == trough["amount"]["amount_minor"]


# ── G3: the growth default, and what it may never silently be ────────────


def _growth(body):
    return body["drivers"]["revenue_growth"]


def test_with_no_prior_period_the_growth_is_the_macro_anchor_and_says_so():
    """The pre-B7 behaviour, pinned so the new rung cannot silently become
    the only one. RED ON: a book rung claimed with no prior period; a zero
    growth served with no sentence; the anchor losing its tier."""
    status, body = _one("agras")
    assert status == 200
    growth = _growth(body)
    basis = growth["basis"]
    assert basis["tier"] == "macro", basis["tier"]
    assert basis["book"] is None and basis["macro"] is not None
    assert [s for s in basis["fallback_steps"]
            if s["tier"] == "book" and s["outcome"] == "absent"], basis
    assert body["history"]["held"] == []
    assert all(v == MACRO_ANCHOR_MICROS for v in growth["values"]), growth["values"]


@pytest.mark.parametrize("factor,label", [(0.8, "a fifth smaller"),
                                          (1.25, "a quarter larger")])
def test_a_comparable_prior_year_makes_the_growth_the_books_own(factor, label):
    """B7. The prior period is the SAME book scaled linearly, rebuilt through
    the real assembly, so the two turnovers are real readings of two real
    trial balances.

    RED ON: the ladder still falling to the macro anchor while a comparable
    prior is held; a book tier served without its two turnovers; the value
    disagreeing with the two turnovers its own basis names."""
    from engine.forecast.money import MICRO, mul_div

    book = _book("agras")
    prior = _scaled(book, factor)
    oid = "v15-org-history"
    periods = [("v15-anchor", oid, "2025-12-31", book),
               ("v15-prior", oid, "2024-12-31", prior)]
    status, body = _get(periods, "v15-anchor", oid)
    assert status == 200, (status, str(body)[:300])

    held = body["history"]["held"]
    assert [h["period_id"] for h in held] == ["v15-prior"], body["history"]
    basis = _growth(body)["basis"]
    assert basis["tier"] == "book", basis
    assert basis["macro"] is None and basis["sector"] is None
    evidence = basis["book"]
    assert evidence["method"] == "growth"
    assert evidence["periods_used"] == ["2024-12-31", "2025-12-31"]
    inputs = evidence["inputs"]
    assert [i["period_end"] for i in inputs] == ["2024-12-31", "2025-12-31"]
    assert all(i["fact"] == "assembled_pl.revenue" for i in inputs), inputs

    prior_rev, current_rev = inputs[0]["value_minor"], inputs[1]["value_minor"]
    assert prior_rev > 0 and current_rev > 0
    implied = mul_div(current_rev - prior_rev, MICRO, prior_rev)
    values = _growth(body)["values"]
    assert all(v == implied for v in values), (values, implied)
    # the whole point: it is the BOOK's number, not the pack's
    assert implied != MACRO_ANCHOR_MICROS
    assert (implied > 0) == (factor < 1.0)
    # and the sentence names both turnovers, so the page renders neither
    assert "2024-12-31" in _growth(body)["basis"]["sentence"]["text"]


def test_a_prior_year_with_the_same_turnover_is_a_MEASURED_zero_not_a_silent_one():
    """The one case the page may legitimately open on a flat plan. It must
    still arrive as a book measurement with both turnovers on it, never as
    the bare 0 that a missing default used to produce.

    RED ON: a zero growth carrying no evidence; the ladder skipping the book
    rung because the measurement happened to be zero."""
    book = _book("agras")
    oid = "v15-org-flat"
    periods = [("v15-anchor", oid, "2025-12-31", book),
               ("v15-prior", oid, "2024-12-31", _scaled(book, 1.0))]
    status, body = _get(periods, "v15-anchor", oid)
    assert status == 200, (status, str(body)[:300])
    basis = _growth(body)["basis"]
    assert basis["tier"] == "book", basis
    assert all(v == 0 for v in _growth(body)["values"])
    assert basis["book"]["inputs"][0]["value_minor"] == \
        basis["book"]["inputs"][1]["value_minor"]


@pytest.mark.parametrize("prior_end,code", [
    ("2025-06-30", "different_year_end"),
    ("2023-12-31", "not_the_prior_year"),
])
def test_a_period_that_is_not_the_prior_YEAR_is_excluded_by_name(prior_end, code):
    """An interim period would grow a twelve-month turnover against a
    six-month one; a period two years back would spend a two-year growth as
    a one-year rate. Both are excluded, both say which.

    RED ON: either being held; either being dropped silently (no row in
    history.excluded); the growth leaving the macro rung."""
    book = _book("agras")
    oid = "v15-org-span"
    periods = [("v15-anchor", oid, "2025-12-31", book),
               ("v15-other", oid, prior_end, _scaled(book, 0.5))]
    status, body = _get(periods, "v15-anchor", oid)
    assert status == 200, (status, str(body)[:300])
    assert body["history"]["held"] == []
    excluded = body["history"]["excluded"]
    assert [e["period_id"] for e in excluded] == ["v15-other"], excluded
    assert excluded[0]["reason"]["code"] == code, excluded
    assert excluded[0]["reason"]["text"].strip()
    assert _growth(body)["basis"]["tier"] == "macro"


def test_a_comparable_prior_in_ANOTHER_workspace_is_never_read():
    """Tenancy of the history lookup. The candidate select carries the org
    filter itself, so a period that would otherwise be a perfect prior year
    is not a candidate at all — not held, not excluded, not named.

    RED ON: the org filter leaving the candidate select; the other org's
    period appearing anywhere in history; the growth moving off the macro
    anchor (which would mean its turnover was read)."""
    book = _book("agras")
    mine, theirs = "v15-org-mine", "v15-org-theirs"
    periods = [("v15-anchor", mine, "2025-12-31", book),
               ("v15-foreign", theirs, "2024-12-31", _scaled(book, 0.5))]
    status, body = _get(periods, "v15-anchor", mine)
    assert status == 200, (status, str(body)[:300])
    history = body["history"]
    assert history["held"] == [] and history["eligible"] == []
    named = json.dumps(history)
    assert "v15-foreign" not in named and theirs not in named, named
    assert _growth(body)["basis"]["tier"] == "macro"
    assert all(v == MACRO_ANCHOR_MICROS for v in _growth(body)["values"])
    # ...and the same prior IS read once it is in the anchor's own workspace
    same_org = [("v15-anchor", mine, "2025-12-31", book),
                ("v15-foreign", mine, "2024-12-31", _scaled(book, 0.5))]
    status, moved = _get(same_org, "v15-anchor", mine)
    assert status == 200
    assert _growth(moved)["basis"]["tier"] == "book", moved["history"]


# ── G4: every projected period balances, on every corpus book ────────────


@pytest.mark.parametrize("name", BOOKS)
@pytest.mark.parametrize("horizon", (3, 5))
def test_every_projected_period_balances_to_the_cent(name, horizon):
    """The acceptance criterion, read off the served payload rather than off
    the engine's own objects. RED ON: any non-zero balance_check row; an
    EMPTY balance_check (a vacuous pass); unbalanced_periods disagreeing
    with the rows it is derived from."""
    status, body = _one(name, horizon)
    assert status == 200, (status, str(body)[:300])
    rows = body["balance_check"]
    assert rows, "no balance rows: a vacuous pass"
    off = [r for r in rows if r["difference_minor"] != 0]
    assert off == [], off
    assert body["unbalanced_periods"] == [r["period"] for r in off]
