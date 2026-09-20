"""forecast-debt-timing (plan/2 B5, plan_contract_v2 6.7).

packs/forecast/levers.yaml#debt_timing: a debt_schedule row's draws land in
the FIRST period of its plan year and its repayments in the LAST. On
project_plan with a debt schedule on the four books:

- per-plan-year sums of debt drawdowns and of repayments are identical at
  monthly_months 12 and 24;
- at both, each draw lands in the first period and each repayment in the
  last period of its plan year, and nowhere else;
- a row for a year beyond total_years is refused naming it.

RED ON, AFTER THE REPAIR (TC-11): a draw or repayment in any other period of
its year; per-year sums that depend on the monthly window; a year beyond the
horizon accepted; a schedule that moved nothing (TC-3).
"""

from __future__ import annotations

import json
from fractions import Fraction as F
from pathlib import Path

import pytest

from engine.forecast import DebtRow, PlanRequest, PlanRequestError, project_plan
from engine.forecast.levers_pack import plan_pack

REPO = Path(__file__).resolve().parents[2]
BOOKS = ("agras", "carniprod", "realestate", "retail")
YEARS = 3
ROWS = (DebtRow(1, lt_draw=F("2000000")),
        DebtRow(2, st_draw=F("500000.50"), lt_repay=F("750000")),
        DebtRow(3, st_repay=F("250000"), lt_repay=F("100000.25")))
WORK = {"units": 0}


def _book(name):
    return json.loads((REPO / "tests" / "engine" / "fixtures" / "firm"
                       / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


def _plan(name, monthly_months):
    rates = (F("0.08"),) * YEARS
    return project_plan(_book(name), (), PlanRequest(
        total_years=YEARS, monthly_months=monthly_months, debt_schedule=ROWS,
        overrides=(("interest_rate_debt", rates), ("revolver_rate", rates))), None)


def _by_year(projection, line):
    out = {}
    for item in projection.periods:
        out[item.period.year_offset] = out.get(item.period.year_offset, 0) + item.cf[line]
    return out


@pytest.mark.parametrize("name", BOOKS)
def test_draws_land_first_and_repayments_last_at_both_windows(name):
    pack = plan_pack()
    assert (pack.debt_draws, pack.debt_repayments) == ("first_period", "last_period")
    sums = {}
    for monthly_months in (12, 24):
        projection = _plan(name, monthly_months).projection
        assert len(projection.periods) == len(projection.timeline), name
        first, last = {}, {}
        for item in projection.periods:
            first.setdefault(item.period.year_offset, item.label)
            last[item.period.year_offset] = item.label
        moved = 0
        for item in projection.periods:
            year = item.period.year_offset
            if item.cf["debt_drawdowns"]:
                assert item.label == first[year], (
                    "%s mm%d: a draw of %d landed in %s, the first period of plan year "
                    "%d is %s" % (name, monthly_months, item.cf["debt_drawdowns"],
                                  item.label, year, first[year]))
                moved += 1
            if item.cf["debt_repayments"]:
                assert item.label == last[year], (
                    "%s mm%d: a repayment landed in %s, the last period of plan year "
                    "%d is %s" % (name, monthly_months, item.label, year, last[year]))
                moved += 1
        assert moved >= 4, "TC-3: %s mm%d moved %d debt lines" % (name, monthly_months, moved)
        sums[monthly_months] = (_by_year(projection, "debt_drawdowns"),
                                _by_year(projection, "debt_repayments"))
        WORK["units"] += moved
    assert sums[12] == sums[24], "%s: per-year debt sums differ by window: %s" % (name, sums)
    assert sums[12][0] == {1: 200000000, 2: 50000050, 3: 0}, sums[12][0]


def test_a_year_beyond_the_horizon_is_refused_by_name():
    with pytest.raises(PlanRequestError) as caught:
        project_plan(_book("agras"), (), PlanRequest(
            total_years=YEARS, debt_schedule=(DebtRow(YEARS + 1, lt_draw=F("1")),)), None)
    assert caught.value.code == "debt_year" and str(YEARS + 1) in caught.value.text
    WORK["units"] += 1


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE forecast-debt-timing (plan/2 B5, contract 6.7): books %s; "
              "total_years %d; monthly_months 12 and 24; caller debt and revolver rates "
              "so every book prices the schedule; reach: project_plan"
              % (", ".join(BOOKS), YEARS))
        print("GATE-WORK forecast-debt-timing units=%d" % WORK["units"])
    assert WORK["units"] > 0
