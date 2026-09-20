"""scenario-cost-behaviour (plan/2 B5, plan_contract_v2 5.6, gate row S1).

The SHOCK half of S1 (forecast-pools holds the no-shock half since B4). On
the four corpus books, through ``engine.forecast.levers.project_plan`` with
revenue_growth and inflation overridden to 0:

- a template-sourced growth_pp of -0.20 on revenue_growth moves plan-year-one
  cost of sales to mul_div(base, 800000, MICRO) to the cent;
- volume_index level_pct -0.20 moves EVERY monthly cost of sales to
  mul_div(base monthly, 800000, MICRO);
- price_index level_pct -0.10 leaves cost of sales byte-identical to base;
- the law: where the opex variable bases plus the cost-of-sales base fit
  inside anchor revenue, year-one EBITDA at volume -0.20 is not above base;
- B4R-8a: a volume move over a REFUSED cost split refuses by name.

RED ON, AFTER THE REPAIR (TC-11): cost of sales flat against a volume or
growth move (the page cascade, defect 0.1); cost of sales following the
selling price; a variable part that ignores growth; a downturn that raises
EBITDA on a book whose costs fit inside revenue; a volume shock served over
a refused split; zero books meeting the law's precondition (TC-3).
"""

from __future__ import annotations

import json
from fractions import Fraction as F
from pathlib import Path

import pytest

from engine.forecast import (PlanRequest, PlanRequestError, Shock, project_plan)
from engine.forecast.money import MICRO, fmt, mul_div

REPO = Path(__file__).resolve().parents[2]
BOOKS = ("agras", "carniprod", "realestate", "retail")
YEARS = 3
WORK = {"units": 0, "law_books": [], "law_excluded": []}


def _book(name):
    return json.loads((REPO / "tests" / "engine" / "fixtures" / "firm"
                       / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


def _flat(*shocks, **kw):
    zero = tuple(F(0) for _ in range(YEARS))
    return PlanRequest(total_years=YEARS, monthly_months=kw.get("monthly_months", 12),
                       overrides=(("inflation", zero), ("revenue_growth", zero)),
                       shocks=tuple(shocks))


def _plan(name, *shocks, **kw):
    return project_plan(_book(name), (), _flat(*shocks, **kw), None,
                        stop_at_unpriced_draw=True)


def _year_one(plan, line):
    return sum(p.pl[line] for p in plan.projection.periods if p.period.year_offset == 1)


@pytest.mark.parametrize("name", BOOKS)
def test_growth_pp_moves_year_one_cost_of_sales_in_full(name):
    base = _plan(name)
    shocked = _plan(name, Shock("template:recession:1", "revenue_growth", "growth_pp",
                                F("-0.20"), source="template:recession"))
    expected = mul_div(_year_one(base, "cost_of_sales"), 800000, MICRO)
    got = _year_one(shocked, "cost_of_sales")
    assert got == expected, (
        "%s: year-one cost of sales %s under growth -20%%, expected %s (base %s)"
        % (name, fmt(got), fmt(expected), fmt(_year_one(base, "cost_of_sales"))))
    WORK["units"] += 1


@pytest.mark.parametrize("name", BOOKS)
def test_volume_index_moves_every_monthly_cost_of_sales(name):
    base = _plan(name)
    shocked = _plan(name, Shock("rail:volume_index", "volume_index", "level_pct", F("-0.20")))
    months = 0
    for b, s in zip(base.projection.periods, shocked.projection.periods):
        if b.period.granularity != "monthly":
            continue
        expected = mul_div(b.pl["cost_of_sales"], 800000, MICRO)
        assert s.pl["cost_of_sales"] == expected, (
            "%s %s: cost of sales %s, expected %s"
            % (name, b.label, fmt(s.pl["cost_of_sales"]), fmt(expected)))
        months += 1
    assert months == 12, "TC-3: %s compared %d months" % (name, months)
    WORK["units"] += months


@pytest.mark.parametrize("name", BOOKS)
def test_the_selling_price_never_moves_cost_of_sales(name):
    base = _plan(name)
    shocked = _plan(name, Shock("rail:price_index", "price_index", "level_pct", F("-0.10")))
    # a price cut may draw a funding line the book cannot price (carniprod):
    # the plan is then served up to that period (6.5), and those are compared
    served = len(shocked.projection.periods)
    assert served >= 1, "TC-3: %s served no period" % name
    assert ([p.pl["cost_of_sales"] for p in shocked.projection.periods]
            == [p.pl["cost_of_sales"] for p in base.projection.periods[:served]]), name
    first = shocked.projection.periods[0]
    assert first.pl["revenue"] == mul_div(base.projection.periods[0].pl["revenue"],
                                          900000, MICRO), (
        "%s: the price shock did not reach revenue" % name)
    WORK["units"] += 1


@pytest.mark.parametrize("name", BOOKS)
def test_law_a_downturn_never_raises_ebitda_where_costs_fit_inside_revenue(name):
    base = _plan(name)
    pools = base.projection.assumptions.pools
    variable = sum(p.base_cents - mul_div(p.base_cents, p.fixed_share_micros, MICRO)
                   for p in pools.opex) + pools.cost_of_sales.base_cents
    revenue = pools.revenue_cents
    if variable > revenue:
        WORK["law_excluded"].append("%s (variable bases %s > revenue %s)"
                                    % (name, fmt(variable), fmt(revenue)))
        return
    shocked = _plan(name, Shock("rail:volume_index", "volume_index", "level_pct", F("-0.20")))
    assert _year_one(shocked, "ebitda") <= _year_one(base, "ebitda"), (
        "%s: EBITDA %s at volume -20%% is above base %s"
        % (name, fmt(_year_one(shocked, "ebitda")), fmt(_year_one(base, "ebitda"))))
    WORK["law_books"].append(name)
    WORK["units"] += 1


@pytest.mark.parametrize("name", BOOKS)
def test_a_pool_level_moves_the_whole_pool_and_nothing_else(name):
    """5.4 / B4R-8b (pool_level was held by no gate): every opex pool's level
    at -5% moves each monthly operating cost to 95% of base, within one
    minor unit per pool (each pool is rounded once), and leaves revenue and
    cost of sales byte-identical."""
    base = _plan(name)
    keys = base.projection.assumptions.pools.level_keys()
    assert keys, "TC-3: %s serves no opex pool" % name
    shocked = _plan(name, *[Shock("rail:%s" % k, k, "level_pct", F("-0.05")) for k in keys])
    served = len(shocked.projection.periods)
    assert served >= 1
    for b, s in zip(base.projection.periods[:served], shocked.projection.periods):
        expected = mul_div(b.pl["operating_costs"], 950000, MICRO)
        assert abs(s.pl["operating_costs"] - expected) <= len(keys), (
            "%s %s: operating costs %s, 95%% of base is %s (band %d minor units, one "
            "per pool)" % (name, b.label, fmt(s.pl["operating_costs"]), fmt(expected),
                           len(keys)))
        assert s.pl["revenue"] == b.pl["revenue"]
        assert s.pl["cost_of_sales"] == b.pl["cost_of_sales"]
        WORK["units"] += 1
    if any(b.pl["operating_costs"] for b in base.projection.periods):
        assert any(s.pl["operating_costs"] != b.pl["operating_costs"] for b, s in
                   zip(base.projection.periods, shocked.projection.periods)), (
            "%s: the pool levels reached nothing" % name)


def test_a_volume_move_over_a_refused_split_refuses_by_name():
    """B4R-8a / B4RV-4 (measured at B4: retail served +1,956,107.72 EBITDA
    where the measured split gives -805,701.65). SYNTHETIC: agras and retail
    with their statement rows removed, which refuses the split."""
    for name in ("agras", "retail"):
        book = _book(name)
        book["line_items"] = []
        with pytest.raises(PlanRequestError) as caught:
            project_plan(book, (), _flat(Shock("rail:volume_index", "volume_index",
                                               "level_pct", F("-0.20"))), None)
        assert caught.value.code == "cost_split_refused", caught.value
        # a selling-price move needs no split and still projects
        project_plan(book, (), PlanRequest(total_years=YEARS, shocks=(
            Shock("rail:price_index", "price_index", "level_pct", F("-0.10")),)), None)
        WORK["units"] += 2


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE scenario-cost-behaviour (plan/2 B5, contract 5.6): books %s; "
              "anchor: each book's own; total_years %d, monthly_months 12; "
              "revenue_growth and inflation overridden to 0; reach: "
              "engine.forecast.levers.project_plan (no route until B6); SYNTHETIC: "
              "agras and retail with no statement rows (the refused split)"
              % (", ".join(BOOKS), YEARS))
        print("law precondition met on %d book(s): %s; excluded: %s"
              % (len(WORK["law_books"]), ", ".join(WORK["law_books"]) or "none",
                 "; ".join(WORK["law_excluded"]) or "none"))
        print("GATE-WORK scenario-cost-behaviour units=%d" % WORK["units"])
    assert WORK["law_books"], "TC-3: no book met the law's precondition"
