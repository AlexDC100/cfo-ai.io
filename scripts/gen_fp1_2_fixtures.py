"""Regenerates tests/engine/fixtures/forecast/fp1_2_agras*.json from the REAL
route (create_app, the loader, the engine, the fp1.2 builder). recompute_ms is
removed: it is a clock reading and sits outside body_hash."""
import json, sys
sys.path.insert(0, "tests/engine")
from test_forecast_route import _call
status, body = _call("agras", "GET", 3)
assert status == 200
body.pop("recompute_ms")
base = "tests/engine/fixtures/forecast/"
json.dump(body, open(base + "fp1_2_agras_served.json", "w"), indent=1, sort_keys=True, ensure_ascii=False)
one = dict(body)
# the first month (painted by the page) and the served FY aggregate of plan
# year one (the magnitude band reads it; the browser never sums months)
keep = (body["horizon"]["labels"][0], body["horizon"]["labels_annual"][0])
one["figures"] = [f for f in body["figures"] if f["period"] in keep]
one["series"] = dict((k, [p for p in v if p["period"] in keep]) for k, v in body["series"].items())
json.dump(one, open(base + "fp1_2_agras_engine_one_period.json", "w"), indent=1, sort_keys=True, ensure_ascii=False)
print(len(body["figures"]), len(one["figures"]))
# forecast-scenarios-live: the scenario template catalogue the engine serves
# (GET /api/forecast/templates/scenarios), for the frontend gates to read the
# ENGINE's catalogue rather than a hand-typed copy. Pinned by
# tests/engine/test_scenario_page_templates.py.
from engine.forecast.scenario_templates import catalogue
json.dump(catalogue(), open(base + "scenario_catalogue.json", "w"), indent=1, sort_keys=True, ensure_ascii=False)
