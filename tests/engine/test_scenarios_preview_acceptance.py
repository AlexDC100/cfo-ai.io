"""GATE — Forecast and Scenarios ship as `preview`, and the flag carries its
acceptance (forecast-scenarios-live).

REPLACES tests/engine/test_scenarios_off_path.py, whose own docstring asked to
be deleted "in the same commit that flips the flag back, by whoever can point
at the acceptance run". The acceptance it named — year-one EBITDA from the
book's MEASURED fixed/variable split, cash never negative, no property copy,
FMCG templates — is now held by gates that run on every battery:
scenario-page-templates (cost of sales follows volume, other operating income
held, cash never below the floor, every period balances, on the four corpus
books), scenario-one-engine (one handler, one engine entry point, the base
scenario IS the forecast), forecast-f1..f6, and scenarios-closure (the page
computes nothing). The Scandia measurement is recorded in the owner's
specs-durable/forecast_scandia_table.md, never committed.

WHAT IS HELD HERE:
  · both rows read `preview` in the SOURCE registry. `active` for everyone is
    the owner's switch, CFO_FEATURES_ACTIVE, not an edit to this file;
  · the served registry promotes exactly the keys CFO_FEATURES_ACTIVE names,
    per request, through the REAL app, and demotes them again when the
    variable is unset (the module registry is never mutated);
  · the reason travels with the flag (the production figures that took it
    off the demo path, and the names of the gates that now hold it);
  · the three-state nav law is still stated (the ROUTE consults the flag).

RED ON: either row moved to `active`, `coming_soon` or `hidden` in the source;
CFO_FEATURES_ACTIVE not promoting a listed key, promoting an unlisted one, or
sticking after the variable is unset; the evidence or a named gate file
vanishing.
"""
from __future__ import annotations

import inspect
from pathlib import Path

from fastapi.testclient import TestClient

from engine.api import _features

REPO = Path(__file__).resolve().parents[2]


def test_forecast_and_scenarios_are_preview_in_the_source():
    for key in ("forecast", "scenarios"):
        assert _features.FEATURES[key]["status"] == "preview", (
            "%s is %r in the source registry. Everyone-on is the owner's switch "
            "(CFO_FEATURES_ACTIVE), never an edit here." % (key, _features.FEATURES[key]["status"]))


def test_the_active_env_promotes_exactly_the_listed_keys_per_request(monkeypatch):
    from engine.api.server import create_app
    monkeypatch.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")
    client = TestClient(create_app(config_path=REPO / "config.yaml"))

    monkeypatch.delenv(_features.ACTIVE_ENV, raising=False)
    off = client.get("/api/features/status").json()["features"]
    assert off["forecast"]["status"] == "preview", off["forecast"]
    assert off["scenarios"]["status"] == "preview", off["scenarios"]

    monkeypatch.setenv(_features.ACTIVE_ENV, " forecast , not_a_feature,scenarios")
    on = client.get("/api/features/status").json()["features"]
    assert on["forecast"]["status"] == "active", on["forecast"]
    assert on["scenarios"]["status"] == "active", on["scenarios"]
    assert "not_a_feature" not in on
    moved = sorted(k for k in on if on[k]["status"] != off[k]["status"])
    assert moved == ["forecast", "scenarios"], moved

    monkeypatch.delenv(_features.ACTIVE_ENV)
    again = client.get("/api/features/status").json()["features"]
    assert again["forecast"]["status"] == "preview", "the promotion stuck"
    assert _features.FEATURES["forecast"]["status"] == "preview", "the registry was mutated"


def test_the_reason_travels_with_the_flag():
    src = inspect.getsource(_features)
    for evidence in ("−20.3", "−107.6", "measured", "acceptance", "project_levers",
                     "scenario-page-templates", "scenario-one-engine"):
        assert evidence in src, "the source no longer records %r" % evidence
    for gate in ("tests/engine/test_scenario_page_templates.py",
                 "tests/engine/test_scenario_one_engine.py",
                 "tests/engine/test_forecast_f_gates.py"):
        assert (REPO / gate).is_file(), "%s is named as holding the acceptance and is gone" % gate


def test_a_gated_feature_is_off_the_route_not_just_the_nav():
    """The three-state nav law: the ROUTE consults the flag, so a deep link
    renders PendingState rather than a half-verified screen."""
    src = inspect.getsource(_features)
    assert "route" in src.lower(), "the law that the route consults this registry is no longer stated here"
