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
