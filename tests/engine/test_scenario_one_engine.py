"""scenario-one-engine (S4; plan/2 B6, extended by forecast-scenarios-live
R6): ONE handler and ONE engine entry point make every served projection.

R6 (scenarios_rulings): ``GET /api/forecast/{id}`` is ``project_levers(base,
no levers)``, the lever recompute is ``project_levers(no template, levers)``
and ``POST /api/forecast/{id}/scenario`` is ``project_levers(template,
levers)``. So the base scenario IS the forecast (gate F4, half one).

REDS ON (TC-11): GET ?horizon=h and POST recompute {"horizon": {"total_years":
h, "monthly_months": 12}} differing in body_hash on any corpus book at 3 or 5;
POST /scenario {"template": "base"} at the same horizon differing from the GET
in ANY block but its own ``scenario`` block and the hash; the mounted
/api/forecast routes being anything but GET /{period_id}, POST
/{period_id}/recompute, POST /{period_id}/scenario and GET
/templates/scenarios; a projecting endpoint not going through the one
handler; the handler not calling project_levers, or calling anything else
that projects (project_payload, project, the fp1 adapter or gateway);
project_levers not calling project_plan.
CANNOT SEE: the Scenarios page (its import closure is held by
scenarios-closure, not here); forecast_drivers cases, which still compute on
their own.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import ast
import inspect

import pytest

from forecast_recompute_harness import BOOKS, _call

FORBIDDEN = ("project_payload", "fp1_from_forecast_v1", "ProjectionGateway")
_WORK = []


@pytest.mark.parametrize("horizon", (3, 5))
@pytest.mark.parametrize("name", BOOKS)
def test_get_is_the_default_post(name, horizon):
    _s, got = _call(name, "GET", horizon)
    status, posted = _call(name, "POST", body={
        "horizon": {"total_years": horizon, "monthly_months": 12}})
    assert status == 200
    assert got["body_hash"] == posted["body_hash"], (name, horizon)
    _WORK.append((name, horizon))


@pytest.mark.parametrize("horizon", (3, 5))
@pytest.mark.parametrize("name", BOOKS)
def test_the_base_scenario_is_the_forecast(name, horizon):
    """F4, half one: POST /scenario with the base template IS the GET, block
    by block (only its own ``scenario`` block, and so the hash, differ)."""
    _s, got = _call(name, "GET", horizon)
    status, scenario = _call(name, "POST", route="scenario", body={
        "template": "base",
        "horizon": {"total_years": horizon, "monthly_months": 12}})
    assert status == 200, (name, horizon, str(scenario)[:300])
    assert scenario["scenario"]["template"] == "base"
    assert scenario["scenario"]["shocks"] == []
    strip = ("scenario", "body_hash", "recompute_ms")
    a = dict((k, v) for k, v in got.items() if k not in strip)
    b = dict((k, v) for k, v in scenario.items() if k not in strip)
    differing = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
    assert not differing, (name, horizon, differing)
    _WORK.append((name, horizon, "base-scenario"))


def _calls(func):
    tree = ast.parse(inspect.getsource(inspect.getmodule(func)))
    names = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            names[node.name] = set(
                (c.func.id if isinstance(c.func, ast.Name) else getattr(c.func, "attr", None))
                for c in ast.walk(node) if isinstance(c, ast.Call))
    return names


def test_both_verbs_reach_project_plan_through_one_handler_and_nothing_else_projects():
    import sys
    from pathlib import Path
    scripts = str(Path(__file__).resolve().parents[2] / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import measure_plan_blast_radius as M
    app = M._app()
    mounted = dict(((r.path, tuple(sorted(r.methods or ()))), r.endpoint)
                   for r in app.routes if getattr(r, "path", "").startswith("/api/forecast"))
    assert set(mounted) == {("/api/forecast/{period_id}", ("GET",)),
                            ("/api/forecast/{period_id}/recompute", ("POST",)),
                            ("/api/forecast/{period_id}/scenario", ("POST",)),
                            ("/api/forecast/templates/scenarios", ("GET",))}, sorted(mounted)
    calls = _calls(mounted[("/api/forecast/{period_id}/recompute", ("POST",))])
    projecting = [e for (path, _m), e in mounted.items()
                  if path != "/api/forecast/templates/scenarios"]
    for endpoint in projecting:
        assert "recompute" in calls[endpoint.__name__], (
            "%s does not go through the one handler" % endpoint.__name__)
        assert not calls[endpoint.__name__] & set(FORBIDDEN), endpoint.__name__
    templates = mounted[("/api/forecast/templates/scenarios", ("GET",))]
    assert not calls[templates.__name__] & (set(FORBIDDEN) | {"recompute", "project_levers",
                                                              "project_plan", "project"}), (
        "the template catalogue projects something")
    assert "project_levers" in calls["recompute"], sorted(calls["recompute"])
    assert "project_plan" not in calls["recompute"], (
        "the handler projects around project_levers")
    assert not calls["recompute"] & set(FORBIDDEN), sorted(calls["recompute"] & set(FORBIDDEN))
    assert "project" not in calls["recompute"]
    from engine.forecast import levers
    lever_calls = _calls(levers.project_levers)
    assert "project_plan" in lever_calls["project_levers"], sorted(lever_calls["project_levers"])
    assert not lever_calls["project_levers"] & set(FORBIDDEN)


def test_zz_scope_and_work(capsys):
    assert len(_WORK) == len(BOOKS) * 2 * 2
    with capsys.disabled():
        print("\nSCOPE scenario-one-engine (plan/2 B6 + R6, gate row S4): books %s x "
              "horizons 3, 5; GET == recompute (body_hash) and GET == scenario(base) "
              "(every block); mounted /api/forecast routes; the Scenarios page POSTs "
              "/scenario (its closure is held by scenarios-closure, not here); "
              "forecast_drivers cases are NOT on this engine" % ", ".join(BOOKS))
        print("GATE-WORK scenario-one-engine units=%d" % (len(_WORK) + 2))
