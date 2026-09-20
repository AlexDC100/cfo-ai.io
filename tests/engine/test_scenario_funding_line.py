"""scenario-funding-line (plan/2 B5, plan_contract_v2 6.4-6.6, gate row S3,
engine half: on the Plan returned by project_plan, no route).

The engine grid: the four corpus books x template-like shock sets x
volume_index level_pct {0, -0.2, -0.4, -0.6, -0.8, -1.0} at monthly_months 24
(a caller revolver_rate only where the book cannot price one):

- closing cash is never below min_cash in any period;
- every draw equals the shortfall (min_cash less cash before funding);
- the revolver equals cumulative draws less repayments;
- next-period funding interest equals the _period_charge identity at
  revolver_rate, recomputed by the test;
- summary and runway per 6.6; at least one cell draws (TC-3);
- a book that cannot price the line returns the ShortfallRefusal of 6.5
  (the periods before the first draw, the period, the amount);
- the runway annual-tail case of 6.6, found by integer bisection.

RED ON, AFTER THE REPAIR (TC-11): cash below the floor; a draw that is not the
shortfall; funding interest not at revolver_rate; an unpriceable line served
at a zero rate, or refused as a bare error that names no period; a runway
that counts an annual period as months.

AS-BUILT B0-8: the contract names carniprod as the book that returns the
refusal on its base plan; measured, carniprod's base plan never draws. The
refusal is asserted on every (book, cell) that draws an unpriceable line,
the books are printed, and zero such cells reds.
"""

from __future__ import annotations

import json
from fractions import Fraction as F
from pathlib import Path

import pytest

from engine.forecast import (AssumptionError, PlanRequest, Shock, project_plan)
from engine.forecast.levers_pack import plan_pack
from engine.forecast.money import MICRO, fmt
from engine.forecast.project import _period_charge

REPO = Path(__file__).resolve().parents[2]
BOOKS = ("agras", "carniprod", "realestate", "retail")
VOLUMES = ("0", "-0.2", "-0.4", "-0.6", "-0.8", "-1.0")
YEARS = 3
CALLER_RATE = F("0.09")
WORK = {"units": 0, "draw_cells": 0, "refusals": [], "caller_rate_books": set()}


def _book(name):
    return json.loads((REPO / "tests" / "engine" / "fixtures" / "firm"
                       / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


def shock_sets(volume):
    vol = () if F(volume) == 0 else (
        Shock("rail:volume_index", "volume_index", "level_pct", F(volume)),)
    return (
        ("volume only", vol),
        ("recession-like", vol + (
            Shock("template:r:1", "price_index", "level_pct", F("-0.05"),
                  source="template:r"),
            Shock("template:r:2", "dso_days", "add_days", F("15"), ramp_months=3,
                  source="template:r"))),
        ("cost-spike-like", vol + (
            Shock("template:c:1", "input_price_index", "level_pct", F("0.10"),
                  start_month=4, source="template:c"),)),
    )


def _request(shocks, rate=None, monthly_months=24):
    overrides = () if rate is None else (("revolver_rate", (rate,) * YEARS),)
    return PlanRequest(total_years=YEARS, monthly_months=monthly_months,
                       overrides=overrides, shocks=tuple(shocks))


def _priced(name):
    base = project_plan(_book(name), (), PlanRequest(total_years=YEARS), None)
    return base.projection.assumptions.micros_or_none("revolver_rate") is not None


@pytest.mark.parametrize("name", BOOKS)
def test_the_funding_line_identities_hold_over_the_grid(name):
    book = _book(name)
    priced = _priced(name)
    for volume in VOLUMES:
        for label, shocks in shock_sets(volume):
            where = "%s vol %s %s" % (name, volume, label)
            try:
                plain = project_plan(book, (), _request(shocks), None)
            except Exception as refused:  # a days lever on unmeasured days
                assert getattr(refused, "code", None) == "days_not_measured", (where, refused)
                continue
            if plain.refusal is not None:
                # 6.5: the book cannot price the line it draws
                assert not priced, where
                refusal = plain.refusal
                assert refusal.amount_minor > 0, where
                assert [p.label for p in plain.projection.periods] == [
                    p.label for p in plain.projection.timeline[:refusal.period.index]], where
                assert refusal.amount_minor == (
                    plain.projection.assumptions.cents("min_cash")
                    - refusal.cash_before_funding_minor), where
                assert plain.summary["first_shortfall_period"] == refusal.period.label
                assert "refused" in plain.summary["peak_funding_gap_minor"]
                assert "refused" in plain.summary["funding_interest_total_minor"]
                assert plain.runway["first_shortfall_period"] == refusal.period.label
                # and with stop_at_unpriced_draw false the refusal names its period
                with pytest.raises(AssumptionError) as bare:
                    project_plan(book, (), _request(shocks), None,
                                 stop_at_unpriced_draw=False)
                assert bare.value.key == "revolver_rate"
                assert bare.value.period_label == refusal.period.label, where
                WORK["refusals"].append("%s -> %s %s" % (where, refusal.period.label,
                                                         fmt(refusal.amount_minor)))
                WORK["caller_rate_books"].add(name)
                plan = project_plan(book, (), _request(shocks, CALLER_RATE), None)
            else:
                plan = plain
            assert plan.refusal is None, where
            projection = plan.projection
            min_cash = projection.assumptions.cents("min_cash")
            days_basis = projection.assumptions.count("days_basis")
            revolver = projection.opening.balances()["revolver"]
            drew = False
            previous = None
            for item in projection.periods:
                rate = (plan.compiled.years["revolver_rate"][item.period.year_offset - 1]
                        if "revolver_rate" in plan.compiled.years
                        else projection.assumptions.micros_or_none("revolver_rate"))
                assert item.bs["cash"] >= min_cash, "%s %s cash %s" % (
                    where, item.label, fmt(item.bs["cash"]))
                before = item.checks["cash_before_funding_line_cents"]
                draw = item.checks["funding_line_draw_cents"]
                assert draw == max(0, min_cash - before), (where, item.label)
                revolver += draw - item.checks["funding_line_repay_cents"]
                assert item.bs["revolver"] == revolver, (where, item.label)
                if previous is not None and previous > 0:
                    assert rate is not None, (where, item.label)
                    assert -item.pl["interest_expense_funding_line"] == _period_charge(
                        previous, rate, item.period.days, days_basis), (where, item.label)
                    assert item.pl["interest_expense_funding_line"] < 0 or rate == 0
                previous = item.bs["revolver"]
                drew = drew or draw > 0
                WORK["units"] += 1
            if drew:
                WORK["draw_cells"] += 1
                first = next(p for p in projection.periods
                             if p.checks["funding_line_draw_cents"] > 0)
                assert plan.summary["first_shortfall_period"] == first.label, where
                assert plan.runway["first_shortfall_period"] == first.label, where
                assert plan.summary["peak_funding_gap_minor"] == max(
                    p.bs["revolver"] for p in projection.periods), where
                if first.period.granularity == "monthly":
                    assert plan.runway["bound"] == "exact"
                    assert plan.runway["months"] == first.period.index, where
            else:
                assert plan.runway == dict(plan.runway, bound="at_least", months=24,
                                           first_shortfall_period=None), where


def _first_shortfall(name, value_micros, monthly_months):
    plan = project_plan(_book(name), (), _request(
        (Shock("rail:input_price_index", "input_price_index", "level_pct",
               F(value_micros, MICRO)),), CALLER_RATE, monthly_months), None)
    for item in plan.projection.periods:
        if item.checks["funding_line_draw_cents"] > 0:
            return plan, item.period
    return plan, None


def test_runway_annual_tail_found_by_bisection_on_retail():
    """6.6: the smallest input-price rise whose first shortfall falls at or
    before the end of the first annual period, at monthly_months 12."""
    entry = plan_pack().entry("input_price_index")
    high = int((entry.bounds[1] - 1) * MICRO)  # level_pct values up to bounds.max
    low = 0

    def breaches(value):
        _plan, period = _first_shortfall("retail", value, 12)
        return period is not None and period.year_offset <= 2

    assert not breaches(low) and breaches(high), (
        "TC-3: no bracket on retail over [0, %s]" % (entry.bounds[1] - 1))
    while high - low > 1:  # solve_step: one micro
        mid = (low + high) // 2
        if breaches(mid):
            high = mid
        else:
            low = mid
    plan, period = _first_shortfall("retail", high, 12)
    assert period.granularity == "annual", (
        "TC-3: the value found (%d micros) first falls short in a monthly period %s"
        % (high, period.label))
    assert plan.runway["bound"] == "at_least" and plan.runway["months"] == 12, plan.runway
    assert plan.runway["first_shortfall_period"] == period.label
    assert period.label in plan.runway["sentence"]["text"]
    plan24, period24 = _first_shortfall("retail", high, 24)
    assert period24 is not None and period24.granularity == "monthly"
    assert plan24.runway["bound"] == "exact"
    assert plan24.runway["months"] == period24.index
    WORK["bisection"] = ("bracket (%d, %d] micros of input_price_index level_pct; found "
                         "%d -> first shortfall %s at monthly_months 12 (at_least 12), "
                         "%s at 24 (exact %d)" % (low, high, high, period.label,
                                                  period24.label, period24.index))
    WORK["units"] += 2


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE scenario-funding-line (plan/2 B5, contract 6.4-6.6, S3 engine "
              "half): books %s; volume_index %s x 3 template-like shock sets; "
              "total_years %d, monthly_months 24; reach: project_plan (the route "
              "half lands in B6, the page half in B13)" % (", ".join(BOOKS),
                                                           ", ".join(VOLUMES), YEARS))
        print("cells that draw the line: %d; books given a caller revolver_rate "
              "because they cannot price one: %s"
              % (WORK["draw_cells"], ", ".join(sorted(WORK["caller_rate_books"])) or "none"))
        print("ShortfallRefusal cells (6.5): %d" % len(WORK["refusals"]))
        for line in WORK["refusals"][:6]:
            print("  " + line)
        print("runway annual tail: %s" % WORK.get("bisection", "not run"))
        print("GATE-WORK scenario-funding-line units=%d" % WORK["units"])
    assert WORK["draw_cells"] > 0, "TC-3: no cell of the grid drew the funding line"
    assert WORK["refusals"], "TC-3: no cell returned the ShortfallRefusal of 6.5"
