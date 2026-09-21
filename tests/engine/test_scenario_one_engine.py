"""scenario-one-engine (S4, the B6 subset of 26.2; plan/2 B6): the recompute
handler is the one way a served projection is made.

REDS ON (TC-11): GET ?horizon=h and POST {"horizon": {"total_years": h,
"monthly_months": 12}} differing in body_hash on any corpus book at 3 or 5; an
import-and-call walk from the mounted recompute handler not reaching
engine.forecast.levers.project_plan; either mounted forecast handler calling
anything else that projects (project_payload, project, the fp1 adapter or
gateway); a mounted path ending in /scenario; the GET and the POST not being
handled by one function.
CANNOT SEE (lands with B13, 26.2): the Scenarios page (it POSTs recompute
since the B13 minimal cut; its import closure is held by scenarios-closure,
not here), the Capsule run_scenario_preview tool and forecast_drivers cases,
which still compute on their own until the cut-over.

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
                            ("/api/forecast/{period_id}/recompute", ("POST",))}, sorted(mounted)
    assert not any(getattr(r, "path", "").endswith("/scenario") for r in app.routes)
    calls = _calls(mounted[("/api/forecast/{period_id}/recompute", ("POST",))])
    for endpoint in mounted.values():
        assert "recompute" in calls[endpoint.__name__], (
            "%s does not go through the one handler" % endpoint.__name__)
        assert not calls[endpoint.__name__] & set(FORBIDDEN), endpoint.__name__
    assert "project_plan" in calls["recompute"], sorted(calls["recompute"])
    assert not calls["recompute"] & set(FORBIDDEN), sorted(calls["recompute"] & set(FORBIDDEN))
    assert "project" not in calls["recompute"]


def test_zz_scope_and_work(capsys):
    assert len(_WORK) == len(BOOKS) * 2
    with capsys.disabled():
        print("\nSCOPE scenario-one-engine (plan/2 B6, gate row S4, recompute-handler "
              "subset 26.2): books %s x horizons 3, 5; mounted /api/forecast routes; the "
              "Scenarios page POSTs recompute since the B13 minimal cut (its closure is "
              "held by scenarios-closure, not here); the Capsule preview and "
              "forecast_drivers cases are NOT yet on this engine (B13)" % ", ".join(BOOKS))
        print("GATE-WORK scenario-one-engine units=%d" % (len(_WORK) + 2))
