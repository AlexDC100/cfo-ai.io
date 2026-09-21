"""scenario-page-templates (forecast-scenarios-live; was plan/2 B13 minimal
cut): the Scenarios templates, compiled and run by the ONE engine.

The templates are PACK DATA, packs/scenarios/templates.yaml (FMCG Romania),
in the vocabulary of packs/forecast/levers.yaml. The Scenarios page sends a
template id to POST /api/forecast/{period_id}/scenario and the ENGINE
compiles it over the book's served driver keys
(engine.forecast.scenario_templates.compile_template: a ``<prefix>.*`` key
expanded over the served keys, ids ``template:<id>:<n>``, source
``template:<id>``, first month, no ramp, no end) and projects it through
engine.forecast.levers.project_levers — the same function the forecast GET
runs. This pins what the engine DOES with every template on the four corpus
books at the Scenarios horizon (monthly_months 12, total_years from the pack,
contract 2.2), through the route's own wire path (PlanRequestBody -> _wire ->
plan_request_from_body).

RED ON, AFTER THE REPAIR (TC-11):
- a template the engine cannot run for a reason other than a named book
  refusal (days_not_measured, rate_not_measured, cost_split_refused,
  template_key_not_served), whose sentence the page renders;
- a projected period whose cash is below the floor, or whose balance sheet
  does not close (S3, F1);
- Recession leaving year-one cost of sales where the base plan has it on a book
  that carries one, or moving other operating income (R2, R3, defect 0.1);
- Revenue -10% moving other operating income or the debt interest (it moves
  revenue and the lines volume drives, nothing else);
- Price pressure moving cost of sales (R2: it never follows the selling price);
- Input cost inflation leaving cost of sales flat on a book that carries one,
  or moving revenue;
- Energy shock moving revenue or cost of sales;
- Working-capital squeeze moving revenue or EBITDA (days move balances, not
  EBITDA);
- the base template differing from the plan with no template at all;
- zero projected templates across the books (TC-3).

CANNOT SEE: what the page paints (the vitest suite); books other than the four
corpus fixtures (the Scandia acceptance is run locally, never committed).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine.api._forecast_routes import PlanRequestBody, _wire
from engine.forecast import PlanRequestError
from engine.forecast.levers import plan_request_from_body, project_levers
from engine.forecast.scenario_templates import load_templates

REPO = Path(__file__).resolve().parents[2]
BOOKS = ("agras", "carniprod", "realestate", "retail")
#: Book refusals the page renders as the engine's own sentence.
NAMED_REFUSALS = ("days_not_measured", "rate_not_measured", "cost_split_refused",
                  "template_key_not_served")
WORK = {"units": 0, "projected": [], "refused": []}


def _templates():
    return [{"id": t.id,
             "shocks": [{"driver_key": s.driver_key, "op": s.op, "value": s.text}
                        for s in t.shocks]}
            for t in load_templates().templates]


def _book(name):
    return json.loads((REPO / "tests" / "engine" / "fixtures" / "firm"
                       / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


def _plan(book, body, template_id=None):
    request = plan_request_from_body(_wire(PlanRequestBody.model_validate(body)))
    plan, _scenario = project_levers(book, (), request, None,
                                     template_id=template_id, client_sent=True)
    return plan


def _year_one(plan, line, runs="projection"):
    proj = getattr(plan, runs)
    return sum(p.pl[line] for p in proj.periods if p.period.year_offset == 1)


BASE_BODY = {"horizon": {"monthly_months": 12}, "overrides": {}, "shocks": []}


@pytest.mark.parametrize("name", BOOKS)
def test_every_page_template_runs_on_the_engine(name):
    book = _book(name)
    base = _plan(book, BASE_BODY)
    for template in _templates():
        label = "%s/%s" % (name, template["id"])
        try:
            plan = _plan(book, BASE_BODY, template["id"])
        except PlanRequestError as refused:
            assert refused.code in NAMED_REFUSALS, (
                "%s: refused as %s (%s) — not a book refusal the page renders"
                % (label, refused.code, refused.text))
            assert refused.text, label
            WORK["refused"].append("%s (%s)" % (label, refused.code))
            WORK["units"] += 1
            continue
        # No template moves min_cash, so the floor is the book default of
        # nil (packs/forecast/levers.yaml#min_cash.default_rule).
        for period in plan.projection.periods:
            assert period.bs["cash"] >= 0, (
                "%s: cash %d in %s — the engine floors cash and draws the funding "
                "line; a negative cash is never served" % (
                    label, period.bs["cash"], period.label))
            assert period.checks["balance_delta_cents"] == 0, (label, period.label)
            WORK["units"] += 2
        base_cogs = _year_one(base, "cost_of_sales", "projection")
        cogs = _year_one(plan, "cost_of_sales")
        base_ooi = _year_one(base, "other_operating_income", "projection")
        ooi = _year_one(plan, "other_operating_income")
        tid = template["id"]
        if tid == "base":
            assert cogs == base_cogs and ooi == base_ooi, label
            assert [p.pl for p in plan.projection.periods] == [
                p.pl for p in base.projection.periods], (
                "%s: the base template is not the plan with no template" % label)
        elif tid == "recession":
            if base_cogs:
                assert abs(cogs) < abs(base_cogs), (
                    "%s: year-one cost of sales %d against base %d — a volume "
                    "fall must reach cost of sales (defect 0.1)" % (label, cogs, base_cogs))
            assert ooi == base_ooi, (
                "%s: other operating income %d against base %d — it is held (R3)"
                % (label, ooi, base_ooi))
        elif tid == "revenue_down_10":
            assert abs(_year_one(plan, "revenue")) < abs(_year_one(base, "revenue")), label
            assert ooi == base_ooi, (
                "%s: revenue -10%% moved other operating income, which it does "
                "not drive (R3)" % label)
            assert _year_one(plan, "interest_expense_debt") == _year_one(
                base, "interest_expense_debt"), (
                "%s: revenue -10%% moved the interest on the book's debt" % label)
        elif tid == "energy_shock":
            assert _year_one(plan, "revenue") == _year_one(base, "revenue"), label
            assert cogs == base_cogs, (
                "%s: an energy-pool shock moved cost of sales" % label)
        elif tid == "price_pressure":
            assert cogs == base_cogs, (
                "%s: cost of sales moved with the SELLING price (R2)" % label)
        elif tid == "input_cost_inflation":
            if base_cogs:
                assert abs(cogs) > abs(base_cogs), (
                    "%s: purchase prices up, cost of sales flat" % label)
            assert _year_one(plan, "revenue") == _year_one(base, "revenue"), label
        elif tid == "working_capital_squeeze":
            assert _year_one(plan, "revenue") == _year_one(base, "revenue"), label
            assert _year_one(plan, "ebitda") == _year_one(base, "ebitda"), (
                "%s: days moved EBITDA; the page says they move balances" % label)
        WORK["projected"].append(label)
        WORK["units"] += 1


def test_the_pack_declares_the_named_templates():
    ids = [t["id"] for t in _templates()]
    assert ids[0] == "base" and not _templates()[0]["shocks"], ids
    assert len(ids) == len(set(ids)), ids
    for template in _templates():
        for spec in template["shocks"]:
            assert set(spec) == {"driver_key", "op", "value"}, spec
    WORK["units"] += 1


def test_the_committed_catalogue_is_what_the_engine_serves():
    """RED ON: tests/engine/fixtures/forecast/scenario_catalogue.json (what the
    frontend gates read) drifting from GET /api/forecast/templates/scenarios's
    own builder. Regenerate with scripts/gen_fp1_2_fixtures.py."""
    from engine.forecast.scenario_templates import catalogue
    on_disk = json.loads((REPO / "tests" / "engine" / "fixtures" / "forecast"
                          / "scenario_catalogue.json").read_text(encoding="utf-8"))
    assert on_disk == catalogue(), "scenario_catalogue.json is stale"
    WORK["units"] += 1


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE scenario-page-templates (packs/scenarios/templates.yaml, "
              "FMCG Romania): books %s; anchor: each book's own; monthly_months 12, "
              "total_years from the pack; templates: %s; reach: PlanRequestBody -> "
              "_wire -> plan_request_from_body -> project_levers (the route's wire "
              "path; the engine compiles every template)"
              % (", ".join(BOOKS), ", ".join(t["id"] for t in _templates())))
        print("projected: %d; refused by name: %s"
              % (len(WORK["projected"]), "; ".join(WORK["refused"]) or "none"))
        print("GATE-WORK scenario-page-templates units=%d" % WORK["units"])
    assert WORK["projected"], "TC-3: no page template projected on any book"
