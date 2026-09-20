"""The request refusals of project_plan (plan/2 B5, plan_contract_v2 2.3-2.6,
2.9, 5.4). Runs with the forecast-balance battery command.

Every refusal is a PlanRequestError whose code is stable and whose text is
rendered from packs/forecast/levers.yaml#request_refusals (TC-10). The route
answers them 422 {code, text} from B6.

RED ON, AFTER THE REPAIR (TC-11): a malformed lever that projects instead of
refusing; a refusal whose code changed; a wire body and the equivalent
in-process PlanRequest giving different plans; a request value rounded
instead of refused.
"""

from __future__ import annotations

import json
from fractions import Fraction as F
from pathlib import Path

import pytest

from engine.forecast import (BehaviourOverride, DebtRow, PlanRequest,
                             PlanRequestError, Shock, plan_request_from_body,
                             project_plan)

REPO = Path(__file__).resolve().parents[2]
BOOK = json.loads((REPO / "tests" / "engine" / "fixtures" / "firm"
                   / "saga_10_col_agras.json").read_text(encoding="utf-8"))
T = "template:t"


def _refused(code, client_sent=False, **levers):
    with pytest.raises(PlanRequestError) as caught:
        project_plan(BOOK, (), PlanRequest(total_years=3, **levers), None,
                     client_sent=client_sent)
    assert caught.value.code == code, (code, caught.value)
    assert caught.value.text and "{" not in caught.value.text, caught.value.text
    return caught.value


CASES = (
    ("unknown_driver", dict(shocks=(Shock("a", "fx_rate_move", "set", F(1)),))),
    ("unknown_driver", dict(overrides=(("opex_pct_of_revenue", (F(0),) * 3),))),
    ("op_not_allowed", dict(shocks=(Shock("a", "volume_index", "add_days", F(1)),))),
    ("op_not_allowed", dict(shocks=(Shock("a", "pool_fixed_share.personnel", "set", F(1)),))),
    ("shock_window", dict(shocks=(Shock("a", "volume_index", "set", F(1), start_month=0),))),
    ("shock_window", dict(shocks=(Shock("a", "volume_index", "set", F(1), start_month=37),))),
    ("shock_window", dict(shocks=(Shock("a", "volume_index", "set", F(1), start_month=5,
                                        end_month=4),))),
    ("annual_alignment", dict(shocks=(Shock("a", "inflation", "add_pp", F("0.01"),
                                            start_month=2),))),
    ("annual_alignment", dict(shocks=(Shock("a", "inflation", "add_pp", F("0.01"),
                                            ramp_months=3),))),
    ("scalar_window", dict(shocks=(Shock("a", "min_cash", "set", F(100), start_month=2),))),
    ("growth_change_is_an_override", dict(shocks=(Shock("a", "revenue_growth", "add_pp",
                                                        F("0.01")),))),
    ("growth_pp_source", dict(shocks=(Shock("a", "volume_index", "growth_pp", F("0.01")),))),
    ("overlapping_sets", dict(shocks=(Shock("a", "dso_days", "set", F(40)),
                                      Shock("b", "dso_days", "set", F(50), start_month=6)))),
    ("duplicate_shock_id", dict(shocks=(Shock("a", "dso_days", "set", F(40)),
                                        Shock("a", "dio_cogs_days", "set", F(50))))),
    ("override_not_settable", dict(overrides=(("volume_index", (F(1),)),))),
    ("override_length", dict(overrides=(("revenue_growth", (F(0),)),))),
    ("not_exact", dict(overrides=(("revenue_growth", (F(1, 3),) * 3),))),
    ("not_exact", dict(shocks=(Shock("a", "dso_days", "set", F("40.0000001")),))),
    ("out_of_bounds", dict(shocks=(Shock("a", "volume_index", "level_pct", F("-1.5")),))),
    ("out_of_bounds", dict(overrides=(("tax_rate", (F("1.2"),) * 3),))),
    ("unknown_pool", dict(behaviour_overrides=(BehaviourOverride("no_such_pool", F("0.5")),))),
    ("fixed_share_range", dict(behaviour_overrides=(BehaviourOverride("personnel", F("1.5")),))),
    ("elasticity_value", dict(behaviour_overrides=(BehaviourOverride("personnel", None, 2),))),
    ("debt_year", dict(debt_schedule=(DebtRow(4, lt_draw=F(1)),))),
    ("debt_duplicate_year", dict(debt_schedule=(DebtRow(1, lt_draw=F(1)), DebtRow(1)))),
    ("debt_negative", dict(debt_schedule=(DebtRow(1, lt_draw=F(-1)),))),
    ("not_served_in_this_build", dict(case="downside")),
    ("not_served_in_this_build", dict(accept_proposals=("p-1",))),
    ("not_served_in_this_build", dict(spread={"rate_pp": "0.02"})),
    ("not_served_in_this_build", dict(breakeven_from="active")),
)


@pytest.mark.parametrize("code,levers", CASES, ids=["%02d-%s" % (i, c[0])
                                                    for i, c in enumerate(CASES)])
def test_a_malformed_request_refuses_by_code(code, levers):
    _refused(code, **levers)


def test_reserved_ids_are_refused_only_when_the_client_sent_them():
    shock = Shock("capsule:revenue", "volume_index", "level_pct", F("-0.1"))
    _refused("reserved_shock_id", client_sent=True, shocks=(shock,))
    _refused("reserved_shock_id", client_sent=True,
             shocks=(Shock("spread", "volume_index", "level_pct", F("-0.1")),))
    # minted in process (the Capsule tool, 1.7): accepted
    project_plan(BOOK, (), PlanRequest(total_years=3, shocks=(shock,)), None)
    # legacy: is reserved for the migrated v1 shocks and IS accepted from a client
    project_plan(BOOK, (), PlanRequest(total_years=3, shocks=(
        Shock("legacy:revenue", "volume_index", "level_pct", F("-0.1")),)), None,
        client_sent=True)


def test_shocks_of_one_rank_commute_so_ids_never_decide_the_result():
    a = Shock("a", "volume_index", "level_pct", F("-0.10"))
    b = Shock("b", "volume_index", "level_pct", F("0.05"), start_month=4, ramp_months=3)
    first = project_plan(BOOK, (), PlanRequest(total_years=3, shocks=(a, b)), None)
    renamed = project_plan(BOOK, (), PlanRequest(total_years=3, shocks=(
        Shock("z", "volume_index", "level_pct", F("-0.10")),
        Shock("c", "volume_index", "level_pct", F("0.05"), start_month=4, ramp_months=3))),
        None)
    assert ([p.as_dict() for p in first.projection.periods]
            == [p.as_dict() for p in renamed.projection.periods])
    assert first.compiled.periods["volume_index"][0] == 900000
    assert first.compiled.periods["volume_index"][3] == 915000   # 0.9 x (1 + 0.05 / 3)
    assert first.compiled.periods["volume_index"][5] == 945000   # 0.9 x 1.05


def test_the_wire_body_and_the_dataclass_give_the_same_plan():
    body = {"horizon": {"total_years": 3, "monthly_months": 24},
            "overrides": {"revenue_growth": {"values": ["0.08", None, "0.05"]}},
            "shocks": [{"id": "rail:volume_index", "driver_key": "volume_index",
                        "op": "level_pct", "value": "-0.20", "start_month": 3,
                        "ramp_months": 6, "end_month": None, "source": "user",
                        "group_id": None}],
            "behaviour_overrides": [{"pool": "personnel", "fixed_share": "0.90",
                                     "volume_elasticity": "1"}],
            "debt_schedule": [{"year": 2, "st_draw": "0.00", "st_repay": "0.00",
                               "lt_draw": "0.00", "lt_repay": "100000.00"}]}
    wire = project_plan(BOOK, (), plan_request_from_body(body), None, client_sent=True)
    direct = project_plan(BOOK, (), PlanRequest(
        total_years=3, monthly_months=24,
        overrides=(("revenue_growth", (F("0.08"), None, F("0.05"))),),
        shocks=(Shock("rail:volume_index", "volume_index", "level_pct", F("-0.20"),
                      start_month=3, ramp_months=6),),
        behaviour_overrides=(BehaviourOverride("personnel", F("0.90"), 1),),
        debt_schedule=(DebtRow(2, lt_repay=F("100000")),)), None)
    assert ([p.as_dict() for p in wire.projection.periods]
            == [p.as_dict() for p in direct.projection.periods])
    # a null override year keeps the resolved default of that year
    default = direct.base.assumptions.micros("revenue_growth")
    assert direct.compiled.years["revenue_growth"] == (80000, default, 50000)
    with pytest.raises(PlanRequestError):
        plan_request_from_body(dict(body, shocks=[dict(body["shocks"][0], value=-0.2)]))


# ── B5V-3: what a well-formed lever DOES, asserted as values ───────────────
# B6's lever-reach gate reds on a lever that reaches nothing. These red on a
# lever that reaches the WRONG value, which reach cannot see.

def test_a_set_and_a_level_on_one_driver_compose_set_then_level():
    """2.5 step 7: set, then level_pct, whatever the ids sort to. An index set
    to 0.5 and then raised 10% is 0.55; level-then-set would leave 0.5."""
    for set_id, level_id in (("a", "b"), ("z", "b")):
        plan = project_plan(BOOK, (), PlanRequest(total_years=3, shocks=(
            Shock(level_id, "volume_index", "level_pct", F("0.10")),
            Shock(set_id, "volume_index", "set", F("0.5")))), None)
        assert plan.compiled.periods["volume_index"][0] == 550000, (
            set_id, plan.compiled.periods["volume_index"][0])


def test_a_windowed_shock_ends_with_its_window():
    """2.4: end_month is the last month the shock applies to; the month after
    it carries the default again, and revenue returns to the base plan's."""
    plan = project_plan(BOOK, (), PlanRequest(total_years=3, shocks=(
        Shock("a", "volume_index", "level_pct", F("-0.20"), start_month=2,
              end_month=4),)), None)
    index = plan.compiled.periods["volume_index"]
    assert [index[m] for m in (0, 1, 3, 4, 11)] == [1000000, 800000, 800000,
                                                    1000000, 1000000]
    for m in (0, 4, 11):
        assert plan.projection.periods[m].pl["revenue"] == plan.base.periods[m].pl["revenue"]
    assert plan.projection.periods[3].pl["revenue"] < plan.base.periods[3].pl["revenue"]


def test_an_annual_period_carries_the_day_weighted_mean_of_its_months():
    """2.6: a ramp that starts in month 11 and runs six months crosses into
    plan year two, which is ONE annual period at monthly_months 12. Its index
    is the mean of the twelve monthly values weighted by each month's days,
    written here from the calendar, not the last month's value."""
    plan = project_plan(BOOK, (), PlanRequest(total_years=3, monthly_months=12, shocks=(
        Shock("a", "volume_index", "level_pct", F("-0.30"), start_month=11,
              ramp_months=6),)), None)
    annual = [p for p in plan.projection.periods if p.period.granularity == "annual"]
    assert annual and annual[0].period.year_offset == 2, "TC-3: no annual second year"
    import calendar
    from datetime import date
    start = annual[0].period.start
    weighted, days = F(0), 0
    for k in range(12):
        year, month = start.year + (start.month - 1 + k) // 12, (start.month - 1 + k) % 12 + 1
        length = calendar.monthrange(year, month)[1]
        ramp = min(F(1), F(13 + k - 11 + 1, 6))
        weighted += (1 - F("0.30") * ramp) * length
        days += length
    assert days == annual[0].period.days, (days, annual[0].period.days)
    expected = weighted / days
    got = plan.compiled.periods["volume_index"][annual[0].period.index]
    assert abs(F(got, 1000000) - expected) <= F(1, 1000000), (got, float(expected))
    assert got != 700000, "the annual period took its last month's value"
    assert plan.compiled.periods["volume_index"][annual[1].period.index] == 700000


def test_a_tax_rate_lever_reaches_the_tax_charge():
    rate = F("0.30")
    plan = project_plan(BOOK, (), PlanRequest(
        total_years=3, overrides=(("tax_rate", (rate, rate, rate)),)), None)
    year_one = [p for p in plan.projection.periods if p.period.year_offset == 1]
    pretax = sum(p.pl["pretax_result"] for p in year_one)
    assert pretax > 0, "TC-3: agras year one is not profitable"
    from engine.forecast.money import apply_rate
    # the statement carries the charge as a negative amount
    assert sum(p.pl["income_tax"] for p in year_one) == -apply_rate(pretax, 300000)
    base_tax = sum(p.pl["income_tax"] for p in plan.base.periods
                   if p.period.year_offset == 1)
    assert base_tax != -apply_rate(pretax, 300000), "TC-3: the book's own rate is 30%"


def test_a_min_cash_lever_sizes_the_draw():
    """The S3 floor: a floor above the cash the plan holds is met by a draw of
    exactly the shortfall, in the month it opens."""
    base = project_plan(BOOK, (), PlanRequest(total_years=3), None).base
    assert not base.funding_periods(), "TC-3: the base plan already draws"
    floor_minor = base.periods[0].bs["cash"] + 100000000
    plan = project_plan(BOOK, (), PlanRequest(total_years=3, overrides=(
        ("min_cash", (F(floor_minor, 100),)),
        ("revolver_rate", (F("0.09"),) * 3))), None)
    first = plan.projection.periods[0]
    assert first.checks["funding_line_draw_cents"] == (
        floor_minor - first.checks["cash_before_funding_line_cents"])
    assert first.checks["funding_line_draw_cents"] > 0
    assert first.bs["cash"] == floor_minor


def test_a_fractional_elasticity_on_the_wire_refuses_it_is_never_truncated():
    """B5V-7a (5.2, 2.3): 0.5 became 0, 1.9 became 1, -0.4 became 0."""
    for raw in ("0.5", "1.9", "-0.4", "2"):
        with pytest.raises(PlanRequestError) as caught:
            plan_request_from_body({
                "horizon": {"total_years": 3},
                "behaviour_overrides": [{"pool": "personnel", "fixed_share": None,
                                         "volume_elasticity": raw}]})
        assert caught.value.code == "elasticity_value", (raw, caught.value)
    for raw, want in (("0", 0), ("1", 1), ("1.0", 1)):
        request = plan_request_from_body({
            "horizon": {"total_years": 3},
            "behaviour_overrides": [{"pool": "personnel", "fixed_share": None,
                                     "volume_elasticity": raw}]})
        assert request.behaviour_overrides[0].volume_elasticity == want


def test_a_rate_the_book_does_not_price_refuses_in_a_rate_s_words():
    """B5V-7b: add_pp on carniprod's unpriced revolver_rate refused under
    days_not_measured, with a sentence about days."""
    book = json.loads((REPO / "tests" / "engine" / "fixtures" / "firm"
                       / "saga_10_col_carniprod.json").read_text(encoding="utf-8"))
    with pytest.raises(PlanRequestError) as caught:
        project_plan(book, (), PlanRequest(total_years=3, shocks=(
            Shock("a", "revolver_rate", "add_pp", F("0.02")),)), None)
    assert caught.value.code == "rate_not_measured", caught.value
    assert "days" not in caught.value.text, caught.value.text
    with pytest.raises(PlanRequestError) as caught:
        realestate = json.loads((REPO / "tests" / "engine" / "fixtures" / "firm"
                                 / "saga_10_col_realestate.json").read_text(encoding="utf-8"))
        project_plan(realestate, (), PlanRequest(total_years=3, shocks=(
            Shock("a", "dio_cogs_days", "add_days", F(2)),)), None)
    assert caught.value.code == "days_not_measured", caught.value
