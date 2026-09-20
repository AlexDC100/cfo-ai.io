"""The working-capital unwind (plan/2 B5, plan_contract_v2 6.2; part of the
forecast-model battery command).

A lever that changes a flow or its days does not re-price the whole balance
in the month it lands: the balance leaves the base plan's level one day of
flow per elapsed day, over its own days in force (convention
wc_unwind_ramp, packs/forecast/levers.yaml#wc_unwind).

- agras, volume_index level_pct -0.20 from month 1: change_in_receivables
  equals the 6.2 formula, evaluated by this test from the two runs' own
  revenue, to the cent in every month.
- retail, volume -0.30: month-one operating cash differs from base by no
  more than 31 days of the daily flow change, the bound rendered from the
  two runs (TC-10).
- the base run is unchanged to the cent by the rule (a request with no lever
  returns the base run itself), and annual periods land on the target.

RED ON, AFTER THE REPAIR (TC-11): a balance re-priced in full in the period a
lever lands (a one-month cash windfall in a downturn); a balance that never
reaches its target; the rule moving the base run.
"""

from __future__ import annotations

import json
from fractions import Fraction as F
from pathlib import Path

from engine.forecast import PlanRequest, Shock, project_plan
from engine.forecast.money import MICRO_DAY, fmt, mul_div

REPO = Path(__file__).resolve().parents[2]
WORK = {"units": 0}


def _book(name):
    return json.loads((REPO / "tests" / "engine" / "fixtures" / "firm"
                       / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


def _volume(name, value, total_years=3, monthly_months=12):
    return project_plan(_book(name), (), PlanRequest(
        total_years=total_years, monthly_months=monthly_months,
        overrides=(("revolver_rate", tuple(F("0.09") for _ in range(total_years))),),
        shocks=(Shock("rail:volume_index", "volume_index", "level_pct", F(value)),)), None)


def test_agras_receivables_follow_the_unwind_formula_every_month():
    """Receivables, as 6.2 names them, and inventory and payables by the same
    formula. On agras the receivable days (28.05, printed) are shorter than
    the first month, so receivables land on their target within it and ONLY
    inventory (46.21 days) and payables (37.18 days) can show a full
    re-price; the test asserts at least one balance is still mid-unwind at
    the end of month one, so it cannot pass vacuously."""
    from engine.forecast.project import WC_BALANCES
    plan = _volume("agras", "-0.20")
    assumptions = plan.projection.assumptions
    cf_line = {"ar": ("change_in_receivables", -1), "inventory": ("change_in_inventory", -1),
               "ap": ("change_in_payables", 1)}
    mid_unwind = []
    for balance, days_key, flow in WC_BALANCES:
        days = assumptions.micro_days_or_none(days_key)
        assert days, "TC-3: agras measures no %s" % days_key
        previous = plan.projection.opening.balances()[balance]
        elapsed = 0
        months = 0
        for base, item in zip(plan.base.periods, plan.projection.periods):
            if item.period.granularity != "monthly":
                continue
            span = item.period.days * MICRO_DAY
            target = mul_div(abs(item.pl[flow]), days, span)
            base_target = mul_div(abs(base.pl[flow]), days, span)
            elapsed += item.period.days
            expected = base_target + mul_div(target - base_target,
                                             min(elapsed * MICRO_DAY, days), days)
            assert item.bs[balance] == expected, (
                "agras %s %s %s, the 6.2 formula gives %s (target %s, base target %s)"
                % (item.label, balance, fmt(item.bs[balance]), fmt(expected),
                   fmt(target), fmt(base_target)))
            line, sign = cf_line[balance]
            assert item.cf[line] == sign * (expected - previous), (item.label, line)
            if months == 0 and expected != target:
                mid_unwind.append(balance)
            previous = expected
            months += 1
        assert months == 12
        WORK["units"] += months
    WORK["mid_unwind"] = mid_unwind
    assert mid_unwind, "vacuous: every agras balance landed on its target in month one"


def test_retail_month_one_cash_moves_by_at_most_a_month_of_the_flow_change():
    plan = _volume("retail", "-0.30")
    base, item = plan.base.periods[0], plan.projection.periods[0]
    days = item.period.days
    # one day of each flow's change, for each balance or charge it drives:
    # revenue (the result and receivables), cost of sales (the result,
    # inventory and payables), operating costs and tax (the result)
    per_day = (2 * abs(item.pl["revenue"] - base.pl["revenue"])
               + 3 * abs(item.pl["cost_of_sales"] - base.pl["cost_of_sales"])
               + abs(item.pl["operating_costs"] - base.pl["operating_costs"])
               + abs(item.pl["income_tax"] - base.pl["income_tax"]))
    bound = mul_div(per_day, 31, days)
    moved = abs(item.cf["cash_from_operating"] - base.cf["cash_from_operating"])
    assert moved <= bound, (
        "retail %s operating cash moved %s against base, above 31 days of the flow "
        "change %s" % (item.label, fmt(moved), fmt(bound)))
    # and the balances themselves: no balance moved by more than a month of its flow
    for line, flow in (("ar", "revenue"), ("inventory", "cost_of_sales"),
                       ("ap", "cost_of_sales")):
        step = abs(item.bs[line] - base.bs[line])
        month = mul_div(abs(item.pl[flow] - base.pl[flow]), 31, days) + 1
        assert step <= month, (
            "retail %s %s moved %s in the month the lever landed; a month of its "
            "flow change is %s" % (item.label, line, fmt(step), fmt(month)))
        WORK["units"] += 1
    WORK["units"] += 1


def test_the_base_run_is_untouched_and_annual_periods_land_on_the_target():
    plan = _volume("agras", "-0.20", total_years=3, monthly_months=12)
    bare = project_plan(_book("agras"), (), PlanRequest(total_years=3), None)
    assert bare.projection is bare.base, "a request with no lever ran a second projection"
    assert bare.base.periods, "TC-3"
    assert [p.as_dict() for p in bare.base.periods] == [p.as_dict() for p in plan.base.periods]
    dso = plan.projection.assumptions.micro_days_or_none("dso_days")
    annual = [p for p in plan.projection.periods if p.period.granularity == "annual"]
    assert annual, "TC-3: no annual period"
    for item in annual:
        assert item.bs["ar"] == mul_div(item.pl["revenue"], dso,
                                        item.period.days * MICRO_DAY), item.label
        WORK["units"] += 1


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE forecast-wc-unwind (plan/2 B5, contract 6.2): agras volume -20%, "
              "retail volume -30%, from month 1; total_years 3, monthly_months 12; "
              "a caller revolver_rate so the whole horizon is served; reach: "
              "engine.forecast.levers.project_plan")
        print("agras balances still mid-unwind at the end of month one: %s"
              % ", ".join(WORK.get("mid_unwind", [])))
        print("GATE-WORK forecast-wc-unwind units=%d" % WORK["units"])
    assert WORK["units"] >= 12
