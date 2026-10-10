"""GATE forecast-scenarios-active — Forecast and Scenarios ship for EVERYONE
(registry status `active`, no Beta label), each advertising the engine route
behind it, and the reason they moved travels with the flag
(forecast-scenarios-live, the owner's rollout: "Forecast and Scenarios ship
for EVERYONE once F1 and F2 pass").

WHAT MOVED, AND ON WHAT EVIDENCE. Both rows were `coming_soon` for the
product as sold, open per account as Beta through the deployed per-account
preview (the frontend's `applyPreview` over `user_prefs.prefs.
preview_features`). They moved to `active` in the source registry on
2026-09-26 after the cockpit's gates F1 (year 0 of the cockpit IS the served
actuals of the company, to the cent) and F2 (every plan year of every case and
of every slider extreme balances, and its balance-sheet cash is its cash-flow
closing cash) were measured green through the real `create_app()` on the
owner's two books — the Scandia FY2025 + FY2024 pair (FORECAST_LOCAL_SCANDIA)
and agras — tests/engine/test_forecast_cockpit.py, 41 passed. The per-company,
per-case, per-year figures sit in the owner's specs-durable/
forecast_cockpit_acceptance.md, never committed (client data).

REPLACES tests/engine/test_scenarios_preview_acceptance.py (which held both
rows `coming_soon` and replaced, in its turn, tests/engine/
test_scenarios_off_path.py — the off-path tripwire whose own docstring asked
to be deleted "in the same commit that flips the flag back, by whoever can
point at the acceptance run"; it is gone, and this file asserts it stays
gone). The acceptance it named — year-one EBITDA from the book's MEASURED
fixed/variable split, cash never negative, no property copy, FMCG templates —
is held on every battery by scenario-page-templates, scenario-one-engine,
forecast-f1..f6, scenarios-closure and forecast-cockpit (F1-F9 and the
slider latency).

ONE MECHANISM STAYS: per-account early access is still `applyPreview`, for
the keys that are still `coming_soon`; there is no `preview` status in the
registry, and CFO_FEATURES_ACTIVE still promotes exactly the keys it names,
per request, without touching the module registry.

WHAT IS HELD HERE:
  · both rows read `active` in the SOURCE registry and are served `active`
    by the real app with no `beta` mark (Beta is the preview's, for
    `coming_soon` rows only);
  · each advertises its endpoint, and that endpoint is a route the real app
    mounts (the Forecast page's POST /api/forecast/{period_id}/cockpit, the
    Scenarios page's POST /api/forecast/{period_id}/scenario);
  · the registry offers no fourth status;
  · CFO_FEATURES_ACTIVE promotes exactly the keys it names (a still-
    `coming_soon` key), per request, and demotes them when unset;
  · the reason travels with the flag (the production figures that took the
    old Scenarios off the demo path, the names of the gates that hold the
    acceptance, the acceptance run's books);
  · the three-state nav law is still stated (the ROUTE consults the flag);
  · the off-path tripwire stays deleted.

RED ON: either row leaving `active` in the source, served with a `beta`
mark, or advertising no endpoint / an endpoint the app does not mount; a
`preview` status reappearing in FeatureStatus; CFO_FEATURES_ACTIVE not
promoting a listed key, promoting an unlisted one, or sticking after the
variable is unset; the evidence, a named gate file or the acceptance's book
names vanishing from the source; test_scenarios_off_path.py reappearing.
"""
from __future__ import annotations

import inspect
from pathlib import Path

from fastapi.testclient import TestClient

from engine.api import _features

REPO = Path(__file__).resolve().parents[2]

LIVE = {
    "forecast": "/api/forecast/{period_id}/cockpit",
    "scenarios": "/api/forecast/{period_id}/scenario",
}

#: A key the product still sells as coming soon: the everyone-on switch is
#: exercised on it, so the mechanism is proven on a row it still governs.
STILL_COMING_SOON = "erp_connector"


def _app():
    from engine.api.server import create_app
    return create_app(config_path=REPO / "config.yaml")


def test_forecast_and_scenarios_are_active_in_the_source_with_their_endpoints():
    for key, endpoint in LIVE.items():
        row = _features.FEATURES[key]
        assert row["status"] == "active", (
            "%s is %r in the source registry; it ships for everyone since the "
            "cockpit's F1 and F2 passed on the Scandia pair and agras (2026-09-26)"
            % (key, row["status"]))
        assert row.get("endpoint") == endpoint, (
            "%s advertises %r, not the route the page reads (%s)"
            % (key, row.get("endpoint"), endpoint))
        assert "beta" not in row, "%s carries a beta mark in the source" % key
    import typing
    statuses = set(typing.get_args(_features.FeatureStatus))
    # `preview` (the workspace redesign's status, 2026-09-21) is NOT a second
    # early-access mechanism: it is a status the ONE mechanism resolves —
    # frontend/lib/features.ts applyPreview promotes `coming_soon` OR
    # `preview` rows named in the user's own preview_features, and nothing
    # else in the browser reads that list (asserted below).
    assert statuses == {"active", "coming_soon", "hidden", "preview"}, (
        "FeatureStatus is %r: a status beyond active/coming_soon/hidden/preview "
        "is a second early-access mechanism competing with applyPreview"
        % sorted(statuses))
    frontend = REPO / "frontend"
    readers = sorted(
        str(p.relative_to(REPO)) for p in frontend.rglob("*.ts*")
        if "__tests__" not in p.parts and "node_modules" not in p.parts
        and ("preview_features" in p.read_text(encoding="utf-8", errors="ignore")
             or "PREVIEW_PREF_KEY" in p.read_text(encoding="utf-8", errors="ignore")))
    assert readers == ["frontend/lib/features.ts", "frontend/lib/previewFeatures.ts"], (
        "the per-account preview list is read outside the one mechanism: %r" % readers)
    pf = (frontend / "lib" / "previewFeatures.ts").read_text(encoding="utf-8")
    assert "applyPreview(" in pf, "previewFeatures.ts decides a preview without applyPreview"
    assert _features.FEATURES[STILL_COMING_SOON]["status"] == "coming_soon", (
        "%s is no longer coming_soon; pick another key for the switch test"
        % STILL_COMING_SOON)


def test_the_advertised_endpoints_are_routes_the_real_app_mounts(monkeypatch):
    # HERMETIC (2026-10-02): `create_app()` verifies the Supabase variables at
    # boot. This test read whatever the host's environment held — green in
    # the container and inside the full suite (where another test leaks the
    # switch), RED alone on any host without a .env, and so red as its own
    # battery gate on a clean worktree. The routes the app mounts do not
    # depend on those variables.
    monkeypatch.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")
    app = _app()
    mounted = set()
    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None) or set()
        if path:
            mounted.add((path, frozenset(m for m in methods if m != "HEAD")))
    for key, endpoint in LIVE.items():
        hits = [m for p, m in mounted if p == endpoint]
        assert hits, "%s advertises %s, which the real app does not mount" % (key, endpoint)
        assert any("POST" in m for m in hits), (
            "%s: %s is mounted without POST (%s)" % (key, endpoint, hits))


def test_served_active_for_everyone_and_the_env_promotes_only_what_it_names(monkeypatch):
    monkeypatch.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")
    client = TestClient(_app())

    monkeypatch.delenv(_features.ACTIVE_ENV, raising=False)
    off = client.get("/api/features/status").json()["features"]
    for key, endpoint in LIVE.items():
        assert off[key]["status"] == "active", off[key]
        assert off[key].get("endpoint") == endpoint, off[key]
        assert "beta" not in off[key], "%s served with a beta mark" % key
    assert off[STILL_COMING_SOON]["status"] == "coming_soon", off[STILL_COMING_SOON]

    monkeypatch.setenv(_features.ACTIVE_ENV, " %s , not_a_feature,forecast" % STILL_COMING_SOON)
    on = client.get("/api/features/status").json()["features"]
    assert on[STILL_COMING_SOON]["status"] == "active", on[STILL_COMING_SOON]
    assert on["forecast"]["status"] == "active", on["forecast"]
    assert "not_a_feature" not in on
    moved = sorted(k for k in on if on[k]["status"] != off[k]["status"])
    assert moved == [STILL_COMING_SOON], moved

    monkeypatch.delenv(_features.ACTIVE_ENV)
    again = client.get("/api/features/status").json()["features"]
    assert again[STILL_COMING_SOON]["status"] == "coming_soon", "the promotion stuck"
    assert _features.FEATURES[STILL_COMING_SOON]["status"] == "coming_soon", "the registry was mutated"
    for key in LIVE:
        assert again[key]["status"] == "active", again[key]


def test_the_reason_travels_with_the_flag():
    src = inspect.getsource(_features)
    for evidence in ("−20.3", "−107.6", "measured", "acceptance", "project_levers",
                     "scenario-page-templates", "scenario-one-engine", "forecast-cockpit",
                     "F1", "F2", "Scandia FY2025 + FY2024", "agras",
                     "forecast_cockpit_acceptance.md"):
        assert evidence in src, "the source no longer records %r" % evidence
    for gate in ("tests/engine/test_scenario_page_templates.py",
                 "tests/engine/test_scenario_one_engine.py",
                 "tests/engine/test_forecast_f_gates.py",
                 "tests/engine/test_forecast_cockpit.py"):
        assert (REPO / gate).is_file(), "%s is named as holding the acceptance and is gone" % gate


def test_the_off_path_tripwire_stays_deleted():
    """The tripwire asked to be deleted by whoever could point at the
    acceptance run; the flag flip did (the run is named in this file's
    docstring and in the flipping commit). It must not come back."""
    gone = REPO / "tests" / "engine" / "test_scenarios_off_path.py"
    assert not gone.exists(), "%s is back: it pins the pre-acceptance state" % gone
    assert not (REPO / "tests" / "engine" / "test_scenarios_preview_acceptance.py").exists(), (
        "the coming_soon gate is back beside this one; two gates would disagree")


def test_a_gated_feature_is_off_the_route_not_just_the_nav():
    """The three-state nav law: the ROUTE consults the flag, so a deep link
    to a `coming_soon` or `hidden` surface renders PendingState rather than
    a half-verified screen."""
    src = inspect.getsource(_features)
    assert "route" in src.lower(), "the law that the route consults this registry is no longer stated here"
