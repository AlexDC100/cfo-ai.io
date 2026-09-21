"""scenario-page-templates (plan/2 B13, minimal cut): the Scenarios page's
templates, run through the ONE engine.

The page declares its templates as DATA in frontend/lib/scenarioTemplates.json
(driver_key, op, value in the vocabulary of packs/forecast/levers.yaml) and
POSTs each set to /api/forecast/{period_id}/recompute. The vitest suite pins
what the page SENDS. This pins what the ENGINE DOES with the same file: every
template is compiled here exactly as the page compiles it (a ``<prefix>.*``
key expanded over the served driver keys of the book, ids
``template:<id>:<n>``, source ``template:<id>``, first month, no ramp, no end),
put through the route's own wire path (PlanRequestBody -> _wire ->
plan_request_from_body) and projected by project_plan on the four corpus
books at the Scenarios horizon (monthly_months 12, total_years omitted and
filled from the pack, contract 2.2).

RED ON, AFTER THE REPAIR (TC-11):
- a template the engine cannot run for a reason other than a named book
  refusal (days_not_measured, rate_not_measured, cost_split_refused), whose
  sentence the page renders;
- a projected period whose cash is below the floor, or whose balance sheet
  does not close (S3, F1);
- Recession leaving year-one cost of sales where the base plan has it on a book
  that carries one, or moving other operating income (R2, R3, defect 0.1);
- Price pressure moving cost of sales (R2: it never follows the selling price);
- Input cost inflation leaving cost of sales flat on a book that carries one,
  or moving revenue;
- Working-capital squeeze moving revenue or EBITDA (the page says days move
  balances, not EBITDA);
- a pool pattern that expands over nothing on a book (the page refuses that
  template by name; here it would be a template with nothing to test);
- zero projected templates across the books (TC-3).

CANNOT SEE: what the page paints (the vitest suite); books other than the four
corpus fixtures (the Scandia acceptance is run locally, never committed).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine.api._forecast_routes import PlanRequestBody, _wire
from engine.forecast import PlanRequestError, project_plan
from engine.forecast.levers import plan_request_from_body

REPO = Path(__file__).resolve().parents[2]
BOOKS = ("agras", "carniprod", "realestate", "retail")
TEMPLATE_FILE = REPO / "frontend" / "lib" / "scenarioTemplates.json"
#: Book refusals the page renders as the engine's own sentence.
NAMED_REFUSALS = ("days_not_measured", "rate_not_measured", "cost_split_refused")
WORK = {"units": 0, "projected": [], "refused": []}


def _templates():
    data = json.loads(TEMPLATE_FILE.read_text(encoding="utf-8"))
    return data["templates"]


def _book(name):
    return json.loads((REPO / "tests" / "engine" / "fixtures" / "firm"
                       / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


def _plan(book, body):
    request = plan_request_from_body(_wire(PlanRequestBody.model_validate(body)))
    return project_plan(book, (), request, None, client_sent=True)


def _compile(template, served_keys):
    """frontend/lib/scenarioTemplates.ts compileTemplate, restated."""
    shocks = []
    n = 0
    for spec in template["shocks"]:
        key = spec["driver_key"]
        if key.endswith(".*"):
            prefix = key[:-1]
            keys = [k for k in served_keys if k.startswith(prefix)]
            assert keys, ("%s: %s expands over no served key" % (template["id"], key))
            group = "template:%s:%s" % (template["id"], prefix.rstrip("."))
        else:
            keys, group = [key], None
        for k in keys:
            n += 1
            shocks.append({"id": "template:%s:%d" % (template["id"], n),
                           "driver_key": k, "op": spec["op"], "value": spec["value"],
                           "start_month": 1, "ramp_months": 0, "end_month": None,
                           "source": "template:%s" % template["id"], "group_id": group})
    return shocks


def _year_one(plan, line, runs="projection"):
    proj = getattr(plan, runs)
    return sum(p.pl[line] for p in proj.periods if p.period.year_offset == 1)


BASE_BODY = {"horizon": {"monthly_months": 12}, "overrides": {}, "shocks": []}


@pytest.mark.parametrize("name", BOOKS)
def test_every_page_template_runs_on_the_engine(name):
    book = _book(name)
    base = _plan(book, BASE_BODY)
    served = list(base.driver_order)
    for template in _templates():
        label = "%s/%s" % (name, template["id"])
        body = {"horizon": {"monthly_months": 12}, "overrides": {},
                "shocks": _compile(template, served)}
        try:
            plan = _plan(book, body)
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
        elif tid == "recession":
            if base_cogs:
                assert abs(cogs) < abs(base_cogs), (
                    "%s: year-one cost of sales %d against base %d — a volume "
                    "fall must reach cost of sales (defect 0.1)" % (label, cogs, base_cogs))
            assert ooi == base_ooi, (
                "%s: other operating income %d against base %d — it is held (R3)"
                % (label, ooi, base_ooi))
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


def test_the_page_file_declares_the_named_templates():
    ids = [t["id"] for t in _templates()]
    assert ids[0] == "base" and not _templates()[0]["shocks"], ids
    assert len(ids) == len(set(ids)), ids
    for template in _templates():
        for spec in template["shocks"]:
            assert set(spec) == {"driver_key", "op", "value"}, spec
    WORK["units"] += 1


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE scenario-page-templates (plan/2 B13, minimal cut): books %s; "
              "anchor: each book's own; monthly_months 12, total_years from the pack; "
              "templates: %s; reach: PlanRequestBody -> _wire -> "
              "plan_request_from_body -> project_plan (the route's wire path)"
              % (", ".join(BOOKS), ", ".join(t["id"] for t in _templates())))
        print("projected: %d; refused by name: %s"
              % (len(WORK["projected"]), "; ".join(WORK["refused"]) or "none"))
        print("GATE-WORK scenario-page-templates units=%d" % WORK["units"])
    assert WORK["projected"], "TC-3: no page template projected on any book"
