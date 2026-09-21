"""Regenerates tests/engine/fixtures/forecast/cockpit_agras_*.json from the
REAL route (create_app over the tenancy double, the cached loader, the
engine, engine.forecast.cockpit) on the committed agras corpus book — the
bytes the frontend's cockpit gates read instead of a hand-typed copy.
recompute_ms is removed: it is a clock reading and sits outside
pins.body_hash. Pinned by tests/engine/test_forecast_cockpit.py
(test_c_the_committed_cockpit_fixtures_are_what_the_route_serves).

Run from the repository root:
    PYTHONPATH=src CFO_AI_SKIP_BOOT_VERIFY=1 python scripts/gen_cockpit_fixtures.py
"""
import json
import sys

sys.path.insert(0, "tests/engine")
import test_forecast_cockpit as C  # noqa: E402

BASE = "tests/engine/fixtures/forecast/"
with C._World("agras") as world:
    for name, route, body in C.FIXTURE_REQUESTS:
        served = world.ok(body, route=route)
        served.pop("recompute_ms", None)
        if "cockpit" in served:
            served["cockpit"].pop("recompute_ms", None)
        with open(BASE + "cockpit_agras_%s.json" % name, "w", encoding="utf-8") as fh:
            json.dump(served, fh, indent=1, sort_keys=True, ensure_ascii=False)
            fh.write("\n")
        print(name, len(json.dumps(served)))
