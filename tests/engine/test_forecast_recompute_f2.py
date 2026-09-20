"""forecast-server-side (F2, plan/2 B6): every number a surface could be
tempted to compute is SERVED, and equals the integer walk over the served
figures of the same run. The browser paints; it never sums, accumulates,
finds a trough, totals a year or differences two values.

Through the real route, four corpus books, base and levered requests.

REDS ON (TC-11): a series point differing from the figure(s) it is read off;
fcf_cumulative differing from the running sum of served fcf; an FY aggregate
differing from the sum of its months (flows), its closing month (balances) or
its opening month (cf.opening_cash); a balance-sheet total differing from the
sum of its served lines; summary.cash_trough, peak_funding_gap,
funding_interest_total or strip.cumulative_fcf / closing_cash differing from
the walk; on a partial refusal, a strip headline served as a number (the
truncated total of the served months) instead of the refusal sentence; a float anywhere in the body; zero checks (TC-3).
CANNOT SEE: what the page does with the values (forecast-boundary, vitest).

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import pytest

from forecast_recompute_harness import BASE3, BOOKS, levered_for, post

_WORK = []
TOTALS = {
    "bs_totals.current_assets": ("bs.cash", "bs.ar", "bs.inventory", "bs.other_current_assets"),
    "bs_totals.equity": ("bs.equity_contributed", "bs.equity_reserves",
                         "bs.equity_retained", "bs.equity_other"),
    "bs_totals.current_liabilities": ("bs.ap", "bs.other_current_liabilities",
                                      "bs.st_debt", "bs.revolver"),
}


def _floats(node, path="$"):
    if isinstance(node, float):
        return [path]
    if isinstance(node, dict):
        return [h for k, v in node.items() for h in _floats(v, "%s.%s" % (path, k))]
    if isinstance(node, list):
        return [h for i, v in enumerate(node) for h in _floats(v, "%s[%d]" % (path, i))]
    return []


def _walk(name, body):
    checks = 0
    fig = dict(((f["line"], f["period"]), f["amount_minor"]) for f in body["figures"]
               if "amount_minor" in f)
    labels = [l for l in body["horizon"]["labels"] if ("pl.revenue", l) in fig]
    assert labels, "TC-3: no served period on %s" % name
    assert _floats(dict((k, v) for k, v in body.items() if k != "recompute_ms")) == []
    series = body["series"]
    reads = {"revenue": "pl.revenue", "ebitda": "pl.ebitda", "net_income": "pl.net_income",
             "closing_cash": "bs.cash", "revolver": "bs.revolver", "st_debt": "bs.st_debt",
             "lt_debt": "bs.lt_debt", "capex": "cf.capital_expenditure",
             "depreciation": "pl.depreciation"}
    running = 0
    for i, label in enumerate(labels):
        for key, line in reads.items():
            assert series[key][i]["amount_minor"] == fig[(line, label)], (name, key, label)
            checks += 1
        fcf = fig[("cf.cash_from_operating", label)] + fig[("cf.cash_from_investing", label)]
        running += fcf
        assert series["fcf"][i]["amount_minor"] == fcf, (name, label)
        assert series["fcf_cumulative"][i]["amount_minor"] == running, (name, label)
        assert series["cash_before_funding"][i]["amount_minor"] == (
            fig[("bs.cash", label)] - fig[("bs.revolver", label)]), (name, label)
        for total, parts in TOTALS.items():
            assert fig[(total, label)] == sum(fig[(p, label)] for p in parts), (name, total, label)
        assert fig[("bs_totals.assets", label)] == fig[("bs_totals.equity_plus_liabilities", label)]
        checks += 7
    year_of = body["horizon"]["year_of"]
    for fy in body["horizon"]["labels_annual"]:
        months = [l for l in labels if year_of[l] == year_of[fy] and not l.startswith("FY")]
        if len(months) != 12:
            continue
        for f in body["figures"]:
            if f["period"] != fy:
                continue
            line = f["line"]
            if line == "cf.opening_cash":
                want = fig[(line, months[0])]
            elif line.split(".")[0] in ("pl", "cf") and line != "cf.closing_cash":
                want = sum(fig[(line, m)] for m in months)
            else:
                want = fig[(line, months[-1])]
            assert f["amount_minor"] == want, (name, line, fy)
            checks += 1
    summary, strip = body["summary"], body["strip"]
    cash = [(fig[("bs.cash", l)], i, l) for i, l in enumerate(labels)]
    low = min(cash)
    assert summary["cash_trough"] == dict(summary["cash_trough"], period=low[2]) \
        and summary["cash_trough"]["amount"]["amount_minor"] == low[0], name
    if body["refusal"] is None:
        peak = max([0] + [fig[("bs.revolver", l)] for l in labels])
        assert summary["peak_funding_gap"]["amount_minor"] == peak, name
        assert summary["funding_interest_total"]["amount_minor"] == -sum(
            fig[("pl.interest_expense_funding_line", l)] for l in labels), name
    if body["refusal"] is None:
        assert labels == body["horizon"]["labels"], name
        assert strip["cumulative_fcf"]["amount_minor"] == running, name
        assert strip["closing_cash"]["amount_minor"] == fig[("bs.cash", labels[-1])], name
    else:
        # 3.9 / 6.5: a headline over the horizon is not the total of the
        # months that happened to be served (B6V-2b)
        assert labels != body["horizon"]["labels"], name
        sentence = body["refusal"]["sentence"]
        for field in ("peak_funding_gap", "cumulative_fcf", "closing_cash"):
            assert strip[field] == {"refused": sentence}, (name, field, strip[field])
    return checks + 5


@pytest.mark.parametrize("name", BOOKS)
def test_every_served_number_equals_the_walk_over_the_served_figures(name):
    levered, _ids = levered_for(name)
    total = 0
    for body in (BASE3, {"horizon": {"total_years": 2, "monthly_months": 24}}, levered):
        total += _walk(name, post(name, body))
    _WORK.append((name, total))


def test_a_partial_refusal_refuses_the_strip_headlines_it_cannot_reach():
    """carniprod, volume_index level_pct -0.6: the plan draws an unpriceable
    line part-way through year one. RED ON: strip.closing_cash served as the
    cash of the last SERVED month, strip.cumulative_fcf as the sum of the
    served months (plant: gates.md). TC-3: the request stops refusing."""
    body = post("carniprod", dict(BASE3, shocks=[
        {"id": "rail:volume_index", "driver_key": "volume_index",
         "op": "level_pct", "value": "-0.6"}]))
    assert body["refusal"] is not None, "TC-3: carniprod -60% volume no longer refuses"
    assert body["horizon"]["served_through"] is not None, "TC-3: nothing served"
    _WORK.append(("carniprod-partial", _walk("carniprod-partial", body)))


def test_zz_scope_and_work(capsys):
    assert len(_WORK) == len(BOOKS) + 1
    with capsys.disabled():
        print("\nSCOPE forecast-server-side (plan/2 B6, gate row F2): books %s; requests "
              "base 3y/12m, base 2y/24m, levered 3y/12m (every lever kind B6 accepts); "
              "series, FY aggregates, balance-sheet totals, summary and strip re-walked "
              "from the served figures" % ", ".join(BOOKS))
        print("GATE-WORK forecast-server-side units=%d" % sum(w[1] for w in _WORK))
