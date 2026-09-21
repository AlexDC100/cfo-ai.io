"""forecast-balance (plan/2 B5, plan_contract_v2 gate row F1).

Every projected period of every run ``project_plan`` makes closes assets to
equity plus liabilities to the minor unit. Matrix: the four corpus books x
monthly_months {12, 24} x total_years {3, 5} x one lever set per shock op
(set, level_pct, growth_pp, add_days, add_pp) plus a behaviour override and
a debt schedule, x the run kinds this batch has: base and plan. The test
re-adds the balance sheet itself from the served lines; it does not read the
engine's own balance_delta.

RED ON, AFTER THE REPAIR (TC-11): any period of any run kind whose assets
differ from equity plus liabilities; a run that catches BalanceViolation and
continues (the violation must reach the caller); a run kind of this batch
missing from the scope line; a matrix cell that projected nothing (TC-3).
A lever a book cannot take (a days change where the days are not measured)
is a named refusal, counted and printed, never a skipped cell.
"""

from __future__ import annotations

import json
from fractions import Fraction as F
from pathlib import Path

import pytest

from engine.forecast import (ASSET_LINES, EL_LINES, BehaviourOverride, DebtRow,
                             PlanRequest, PlanRequestError, Shock, project_plan)
from engine.forecast.money import fmt

REPO = Path(__file__).resolve().parents[2]
BOOKS = ("agras", "carniprod", "realestate", "retail")
RUN_KINDS = ("base", "plan")
WORK = {"periods": 0, "cells": 0, "refused": [], "partial": 0}


def _book(name):
    return json.loads((REPO / "tests" / "engine" / "fixtures" / "firm"
                       / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


def lever_sets(total_years):
    return (
        ("set", dict(shocks=(Shock("rail:dso_days", "dso_days", "set", F("60")),))),
        ("level_pct", dict(shocks=(Shock("rail:volume_index", "volume_index",
                                         "level_pct", F("-0.30"), ramp_months=6),))),
        ("growth_pp", dict(shocks=(Shock("template:t:1", "input_price_index", "growth_pp",
                                         F("0.05"), start_month=4, source="template:t"),))),
        ("add_days", dict(shocks=(Shock("rail:dpo_cogs_days", "dpo_cogs_days",
                                        "add_days", F("-10"), start_month=3,
                                        ramp_months=3),))),
        ("add_pp", dict(shocks=(Shock("rail:inflation", "inflation", "add_pp",
                                      F("0.03"), start_month=13),))),
        ("behaviour+debt", dict(
            behaviour_overrides=(BehaviourOverride("cost_of_sales", F("0.25"), 1),),
            debt_schedule=(DebtRow(1, lt_draw=F("1000000")),
                           DebtRow(total_years, lt_repay=F("400000"))))),
    )


def _assert_closes(name, label, projection):
    assert projection.periods, "TC-3: %s %s projected no period" % (name, label)
    for item in projection.periods:
        assets = sum(item.bs[line] for line in ASSET_LINES)
        funding = sum(item.bs[line] for line in EL_LINES)
        assert assets == funding, (
            "%s %s %s: assets %s, equity plus liabilities %s, difference %s"
            % (name, label, item.label, fmt(assets), fmt(funding), fmt(assets - funding)))
        WORK["periods"] += 1


@pytest.mark.parametrize("total_years", (3, 5))
@pytest.mark.parametrize("monthly_months", (12, 24))
@pytest.mark.parametrize("name", BOOKS)
def test_every_period_of_every_run_closes(name, monthly_months, total_years):
    book = _book(name)
    for op, levers in lever_sets(total_years):
        # with the book's own funding rate (partial where it has none), and
        # with a caller rate so the whole horizon is walked on every book
        for rate in (None, F("0.09")):
            overrides = () if rate is None else (
                ("revolver_rate", tuple(rate for _ in range(total_years))),)
            if "debt_schedule" in levers:
                # a book with no opening debt cannot price a draw (the engine
                # refuses it by name); the schedule cell supplies the rate
                overrides += (("interest_rate_debt",
                               tuple(F("0.08") for _ in range(total_years))),)
            request = PlanRequest(total_years=total_years, monthly_months=monthly_months,
                                  overrides=overrides, **levers)
            label = "%s mm%d y%d rate=%s" % (op, monthly_months, total_years, rate)
            try:
                plan = project_plan(book, (), request, None)
            except PlanRequestError as refused:
                assert refused.code == "days_not_measured", (name, label, refused)
                WORK["refused"].append("%s %s: %s" % (name, label, refused.code))
                continue
            _assert_closes(name, label + " base", plan.base)
            _assert_closes(name, label + " plan", plan.projection)
            if plan.refusal is not None:
                WORK["partial"] += 1
            else:
                assert len(plan.projection.periods) == len(plan.projection.timeline)
            WORK["cells"] += 1


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE forecast-balance (plan/2 B5, gate row F1): books %s; "
              "monthly_months 12, 24; total_years 3, 5; ops set, level_pct, growth_pp, "
              "add_days, add_pp, plus a behaviour override with a debt schedule; "
              "run kinds covered: %s (FY aggregate, spread, case, compare, tornado, "
              "break-even, reach, removal, contribution and plan-finding runs land "
              "with their batches); reach: engine.forecast.levers.project_plan"
              % (", ".join(BOOKS), ", ".join(RUN_KINDS)))
        print("cells projected %d, of which served partially (6.5) %d; named refusals %d"
              % (WORK["cells"], WORK["partial"], len(WORK["refused"])))
        for line in sorted(set(WORK["refused"]))[:12]:
            print("  refused " + line)
        print("GATE-WORK forecast-balance units=%d" % WORK["periods"])
    assert WORK["cells"] > 0 and WORK["periods"] > 0
