"""forecast-magnitude (plan/2 B5, plan_contract_v2 gate row F6, engine half).

Year-one projected revenue equals source revenue x (1 + the effective
year-one growth), with the effective volume and price indices applied per
period, within the number of rounding operations the run itself performed on
year-one revenue (Projection.work, half a minor unit each: the band is
rendered from the run, never typed). At zero growth and neutral indices
year one equals source exactly.

RED ON, AFTER THE REPAIR (TC-11): year-one revenue outside that band on any
book (a x100 scale error, a stamped growth that was never applied, a lever
that did not reach revenue); a missing source revenue projected as nil
(B4RV-2: absent is refused, never read as zero); a band the run did not
render (zero counted rounding operations reds as vacuous).
"""

from __future__ import annotations

import json
from fractions import Fraction as F
from pathlib import Path

import pytest

from engine.forecast import AssumptionError, PlanRequest, Shock, project_plan
from engine.forecast.money import MICRO, fmt

REPO = Path(__file__).resolve().parents[2]
BOOKS = ("agras", "carniprod", "realestate", "retail")
YEARS = 3
WORK = {"units": 0, "bands": []}


def _book(name):
    return json.loads((REPO / "tests" / "engine" / "fixtures" / "firm"
                       / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


CASES = (
    ("default", dict()),
    ("growth override 0.08", dict(overrides=(("revenue_growth", (F("0.08"),) * YEARS),))),
    ("volume -20% ramped over 6 months, price +3% from month 7", dict(shocks=(
        Shock("rail:volume_index", "volume_index", "level_pct", F("-0.20"), ramp_months=6),
        Shock("rail:price_index", "price_index", "level_pct", F("0.03"), start_month=7)))),
    ("template growth_pp -0.20", dict(shocks=(
        Shock("template:r:1", "revenue_growth", "growth_pp", F("-0.20"),
              source="template:r"),))),
)


@pytest.mark.parametrize("label,levers", CASES, ids=[c[0] for c in CASES])
@pytest.mark.parametrize("name", BOOKS)
def test_year_one_revenue_is_source_times_effective_growth(name, label, levers):
    plan = project_plan(_book(name), (), PlanRequest(total_years=YEARS, **levers), None)
    projection = plan.projection
    source = projection.history.revenue
    assert source is not None, "%s: no source revenue" % name
    year_one = [p for p in projection.timeline if p.year_offset == 1]
    served = [p for p in projection.periods if p.period.year_offset == 1]
    if len(served) < len(year_one):
        pytest.skip("year one is served partially (6.5); the aggregate is refused")
    growth = (plan.compiled.years["revenue_growth"][0]
              if "revenue_growth" in plan.compiled.years
              else projection.assumptions.micros("revenue_growth"))
    annual = F(source) * F(MICRO + growth, MICRO)
    days = sum(p.days for p in year_one)
    exact = F(0)
    for period in year_one:
        share = annual * F(period.days, days)
        for key in ("volume_index", "price_index"):
            if key in plan.compiled.periods:
                share *= F(plan.compiled.periods[key][period.index], MICRO)
        exact += share
    got = sum(p.pl["revenue"] for p in served)
    roundings = projection.work["revenue_roundings_year_one"]
    assert roundings > 0, "vacuous: the run counted no rounding on year-one revenue"
    band = F(roundings, 2)
    assert abs(got - exact) <= band, (
        "%s [%s]: year-one revenue %s, source %s x (1 + %s) with the indices applied is "
        "%s; difference %s minor units, band %s (%d rounding operations)"
        % (name, label, fmt(got), fmt(source), F(growth, MICRO), fmt(int(exact)),
           got - exact, band, roundings))
    WORK["bands"].append("%s [%s] roundings %d" % (name, label, roundings))
    WORK["units"] += 1


@pytest.mark.parametrize("name", BOOKS)
def test_zero_growth_and_neutral_indices_reproduce_source_exactly(name):
    plan = project_plan(_book(name), (), PlanRequest(
        total_years=YEARS, overrides=(("revenue_growth", (F(0),) * YEARS),)), None)
    served = [p for p in plan.projection.periods if p.period.year_offset == 1]
    if len(served) < 12:
        pytest.skip("year one is served partially (6.5)")
    assert sum(p.pl["revenue"] for p in served) == plan.projection.history.revenue, name
    WORK["units"] += 1


def test_an_absent_source_revenue_refuses_and_is_never_read_as_nil():
    """B4RV-2: measured at B4, agras with no revenue line projected year-one
    EBITDA -102,532,231.44. SYNTHETIC: agras with assembled_pl.revenue removed."""
    book = _book("agras")
    book["statements"]["assembled_pl"].pop("revenue")
    with pytest.raises(AssumptionError) as caught:
        project_plan(book, (), PlanRequest(total_years=YEARS), None)
    assert caught.value.key == "revenue", caught.value
    WORK["units"] += 1


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE forecast-magnitude (plan/2 B5, gate row F6 engine half): books %s; "
              "total_years %d, monthly_months 12; cases %s; SYNTHETIC: agras without a "
              "revenue line; the frontend band and the export formatter land with their "
              "batches (B9, B20)" % (", ".join(BOOKS), YEARS,
                                     "; ".join(c[0] for c in CASES)))
        print("bands rendered from the run: %d; rounding operations min %s"
              % (len(WORK["bands"]), min([b.split()[-1] for b in WORK["bands"]] or ["-"])))
        print("GATE-WORK forecast-magnitude units=%d" % WORK["units"])
    assert WORK["units"] >= len(BOOKS)
