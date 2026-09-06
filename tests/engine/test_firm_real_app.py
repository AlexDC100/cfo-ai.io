"""THE REAL APP survives a dead model registry (critic D6) — measured on
``engine.api.create_app()``, the object ``python -m engine serve`` runs
(``engine/__main__.py`` ``_cmd_serve``: ``from .api import create_app``).

The route gate (tests/engine/test_firm_route.py) builds a bare
``FastAPI()`` + one router, so it could never see what the critics saw:
``create_app`` -> server.py -> ``engine.api.pipeline`` read the model
registry AT MODULE LEVEL (``_EXTRACT_MODEL`` / ``_NARRATIVE_MODEL``), and
so did ``engine.ai_lane.config``. A missing role, an unreadable file, or
a role with no breaker caps was a ``RegistryError`` at IMPORT: no app, no
process, the §14 restart-loop shape — the deterministic firm board
included. GATES.md R1 said "DEGRADES". It died.

Every case here is a FRESH subprocess (the registry is read once per
process and cached), with the production URL and keys stripped, sockets
blocked, and ``ENGINE_AI_MODELS_PATH`` pointed at the dead registry. It
builds the real app, hits ``GET /health``, then opens the firm board over
the double's TWO REAL clients (the fixtures C9 measures) and compares it
with the same board under the real registry: the SAME rows, the SAME
gaps, and exactly ONE notice more — the registry's own error, naming the
file and (when a role is the problem) the role. It also asserts the
deployed entry (``engine.__main__._cmd_serve``) resolves the very same
``create_app`` — the claim is about the process the container runs.

TC-11 — after D6 this gate reds on: a registry read that returns to the
import closure of create_app (any module — the plant is one eager
``_model_registry.model_for(...)`` at pipeline.py's module level); a
board whose items or gaps CHANGE under a dead registry (the notice is the
only difference allowed); a dead registry that goes unstated (zero
notices) or is stated twice; a route table that differs between the two
apps; the anthropic SDK loaded on the request.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Optional

import pytest

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests" / "engine" / "fixtures" / "firm"
MODELS_YAML = REPO / "src" / "engine" / "ai" / "models.yaml"

#: The production configuration must never reach a subprocess of this
#: gate: stripped, then replaced by a name that resolves nowhere (and
#: sockets are blocked in the child besides).
STRIPPED_ENV = ("ANTHROPIC_API_KEY", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY",
                "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ENGINE_AI_MODELS_PATH")
FAKE_ENV = {"VITE_SUPABASE_URL": "https://netblock.invalid",
            "VITE_SUPABASE_ANON_KEY": "netblock-anon",
            "SUPABASE_SERVICE_ROLE_KEY": "netblock-service",
            "CFO_AI_SKIP_BOOT_VERIFY": "1",
            # The Cockpit mounts only behind this flag (server.py
            # `_firm_cockpit_enabled`), and it is UNSET in production —
            # the launch posture is that /api/firm does not exist there.
            # This gate is about the board the flag serves, so it builds
            # the app WITH the surface on; that the surface is absent
            # without the flag is the subject of
            # `test_the_cockpit_is_not_mounted_without_its_flag` below.
            "FIRM_COCKPIT_ENABLED": "1"}

REAL_APP_CODE = r"""
import json, os, socket, sys, traceback
def _blocked(self, addr): raise RuntimeError("NETBLOCK: outbound connect to %r" % (addr,))
socket.socket.connect = _blocked
socket.socket.connect_ex = lambda self, addr: (_ for _ in ()).throw(RuntimeError("NETBLOCK %r" % (addr,)))
def ai(): return sorted(m for m in sys.modules if m == 'anthropic' or m.startswith('anthropic.') or m.startswith('engine.ai'))
out = {"ai_before": ai()}
try:
    from engine.api import create_app
    app = create_app(config_path=__CONFIG__)
    out["create_app"] = "OK"
    out["routes"] = len(app.routes)
    out["firm_routes"] = sorted(set(
        getattr(r, "path", "") for r in app.routes
        if str(getattr(r, "path", "")).startswith("/api/firm")))
    import engine.__main__ as entry
    import engine.api as api_pkg
    out["entry_resolves_same_create_app"] = (callable(getattr(entry, "_cmd_serve", None))
                                             and api_pkg.create_app is create_app)
except BaseException as exc:
    out["create_app"] = "DEAD"
    out["error"] = "%s: %s" % (type(exc).__name__, exc)
    out["traceback_tail"] = traceback.format_exc().splitlines()[-4:]
    print(json.dumps(out)); raise SystemExit(0)
from fastapi.testclient import TestClient
import firm_postgrest_double as D
from engine.api import _org
class _MP(object):
    def setattr(self, obj, name, value): setattr(obj, name, value)
double = D.PostgrestDouble()
for org_id, name, fx in (("org-agras", "Agras SA", "saga_10_col_agras"),
                         ("org-carni", "Carniprod SRL", "saga_10_col_carniprod")):
    with open(__FIXTURES__ + "/" + fx + ".json", encoding="utf-8") as fh:
        D.seed_client(double, org_id, name, json.load(fh), ["2025-12-31"])
D.install(_MP(), double)
_org.resolve_user_id = lambda jwt: "user-double"
tc = TestClient(app, raise_server_exceptions=False)
h = tc.get("/health")
out["health"] = {"status": h.status_code, "body": h.text[:200]}
r = tc.get("/api/firm/attention?as_of=2026-01-10", headers={"Authorization": "Bearer t"})
out["board"] = {"status": r.status_code}
if r.status_code == 200:
    body = r.json()
    out["board"]["rows"] = dict((row["client_id"], sorted(i["kind"] for i in row["items"])) for row in body["clients"])
    out["board"]["gaps"] = dict((row["client_id"], sorted(g["reason"] for g in row["gaps"])) for row in body["clients"])
    out["board"]["notices"] = body["notices"]
    out["board"]["items"] = body["counts"]["items"]
else:
    out["board"]["text"] = r.text[:400]
out["ai_after"] = ai()
print(json.dumps(out))
"""


def _registry(tmp_path: Path, shape: str) -> Optional[Path]:
    """A models.yaml in one of the dead shapes (or None: the packaged one).
    The three the coordinator named — a missing role, an unreadable file,
    a role with no breaker caps — plus a corrupt YAML, the fourth shape
    the critics' harness (scratchpad/adv_board/dead_registry.py) drove."""
    import yaml
    if shape == "healthy":
        return None
    if shape == "unreadable_file":
        path = tmp_path / "models_that_does_not_exist.yaml"
        assert not path.exists()
        return path
    if shape == "corrupt_yaml":
        path = tmp_path / "models_corrupt.yaml"
        path.write_text("roles: [unclosed\n  : :\n", encoding="utf-8")
        return path
    raw = yaml.safe_load(MODELS_YAML.read_text(encoding="utf-8"))
    if shape == "missing_role":
        del raw["roles"]["reconcile_proposal"]
    elif shape == "no_breaker_caps":
        raw.get("defaults", {}).pop("breaker", None)
        raw["roles"]["reconcile_proposal"].pop("breaker", None)
    else:
        raise AssertionError(shape)
    path = tmp_path / ("models_%s.yaml" % shape)
    path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    return path


def real_app_under(registry_path: Optional[Path],
                   extra_env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    env = dict((k, v) for k, v in os.environ.items() if k not in STRIPPED_ENV)
    env.update(FAKE_ENV)
    if extra_env:
        env.update(extra_env)
    env["PYTHONPATH"] = os.pathsep.join([str(REPO / "src"), str(REPO / "tests" / "engine")])
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if registry_path is not None:
        env["ENGINE_AI_MODELS_PATH"] = str(registry_path)
    code = (REAL_APP_CODE.replace("__CONFIG__", repr(str(REPO / "config.yaml")))
            .replace("__FIXTURES__", repr(str(FIXTURES))))
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                          env=env, timeout=300, cwd=str(REPO))
    assert proc.returncode == 0, proc.stderr[-3000:]
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.startswith("{")]
    assert lines, proc.stdout[-1500:] + proc.stderr[-1500:]
    return json.loads(lines[-1])


@pytest.fixture(scope="module")
def healthy() -> Dict[str, Any]:
    measured = real_app_under(None)
    assert measured["create_app"] == "OK", measured
    assert measured["entry_resolves_same_create_app"] is True, measured
    assert measured["health"]["status"] == 200, measured["health"]
    assert measured["board"]["status"] == 200, measured["board"]
    # Not vacuous: two real clients, items on both, no registry notice.
    assert set(measured["board"]["rows"]) == {"org-agras", "org-carni"}, measured["board"]
    assert "CASH_RUNWAY" in measured["board"]["rows"]["org-agras"], measured["board"]["rows"]
    assert measured["board"]["items"] >= 4, measured["board"]
    assert not [n for n in measured["board"]["notices"] if "model registry" in n], (
        "the healthy registry is reported unavailable: %s" % measured["board"]["notices"])
    return measured


DEAD_SHAPES = ("missing_role", "unreadable_file", "no_breaker_caps", "corrupt_yaml")
#: The role the registry's own error names, per shape ("" when the failure
#: is the file itself, and no role can be named).
NAMED_ROLE = {"missing_role": "reconcile_proposal", "no_breaker_caps": "reconcile_proposal",
              "unreadable_file": "", "corrupt_yaml": ""}


def test_the_healthy_real_app_builds_and_serves_the_board(healthy, capsys):
    """The baseline the dead shapes are compared against, asserted on its
    own so a collapse of the healthy run is a named failure."""
    with capsys.disabled():
        print("\n[D6/real-app] healthy registry: create_app OK, %d routes; /health %s; board %s "
              "rows=%s items=%d notices=%d"
              % (healthy["routes"], healthy["health"]["status"], healthy["board"]["status"],
                 healthy["board"]["rows"], healthy["board"]["items"],
                 len(healthy["board"]["notices"])))
    assert healthy["routes"] >= 150, healthy["routes"]


@pytest.mark.parametrize("shape", DEAD_SHAPES)
def test_the_real_app_builds_serves_health_and_the_same_board_under_a_dead_registry(
        tmp_path, capsys, healthy, shape):
    measured = real_app_under(_registry(tmp_path, shape))
    with capsys.disabled():
        print("\n[D6/real-app] registry %s: create_app %s%s; /health %s; board %s rows=%s "
              "notices=%d; AI modules before/after = %d/%d"
              % (shape, measured["create_app"],
                 (" (%s)" % measured.get("error", "")[:160]) if measured["create_app"] != "OK" else "",
                 measured.get("health", {}).get("status"),
                 measured["board"].get("status") if "board" in measured else "-",
                 measured.get("board", {}).get("rows"),
                 len(measured.get("board", {}).get("notices") or []),
                 len(measured["ai_before"]), len(measured.get("ai_after", []))))
    assert measured["create_app"] == "OK", (
        "D6 — the real app died at import under a %s registry: %s\n%s"
        % (shape, measured.get("error"), "\n".join(measured.get("traceback_tail", []))))
    assert measured["routes"] == healthy["routes"], (
        "D6 — a dead registry changed the app's route table: %d vs %d"
        % (measured["routes"], healthy["routes"]))
    assert measured["health"]["status"] == 200, measured["health"]
    assert measured["board"]["status"] == 200, (
        "D6 BOARD DEAD (real app) — HTTP %s under a %s registry: %s"
        % (measured["board"]["status"], shape, measured["board"].get("text")))
    assert measured["board"]["rows"] == healthy["board"]["rows"], (
        "D6 — the dead registry changed the board's deterministic items: healthy %s, dead %s"
        % (healthy["board"]["rows"], measured["board"]["rows"]))
    assert measured["board"]["gaps"] == healthy["board"]["gaps"], (
        "D6 — the dead registry changed the board's gaps: healthy %s, dead %s"
        % (healthy["board"]["gaps"], measured["board"]["gaps"]))
    extra = [n for n in measured["board"]["notices"] if n not in healthy["board"]["notices"]]
    assert len(extra) == 1 and len(measured["board"]["notices"]) == len(healthy["board"]["notices"]) + 1, (
        "D6 — expected exactly ONE notice more than the healthy board (the registry), got: %s"
        % measured["board"]["notices"])
    notice = extra[0]
    assert "model registry" in notice and "RegistryError" in notice, notice
    role = NAMED_ROLE[shape]
    if role:
        assert role in notice, "D6 — the notice does not name the role: %s" % notice
    assert not [m for m in measured["ai_after"] if m == "anthropic" or m.startswith("anthropic.")], (
        measured["ai_after"])


def test_the_cockpit_is_not_mounted_without_its_flag():
    """FIRM_COCKPIT_ENABLED unset → create_app() serves no /api/firm route.

    The launch posture: the Cockpit backend is committed, complete and
    OFF. Reds if a future edit mounts a firm router unconditionally (the
    surface would then exist in production, where nothing has walled it
    at the edge), or if the flag starts defaulting to on. It does NOT
    red on a Cockpit that is broken behind the flag — that is what the
    rest of this file measures.
    """
    off = real_app_under(None, extra_env={"FIRM_COCKPIT_ENABLED": ""})
    assert off["create_app"] == "OK", off
    assert off["firm_routes"] == [], (
        "FIRM_COCKPIT_ENABLED is unset and create_app() still serves %d "
        "/api/firm route(s): %s"
        % (len(off["firm_routes"]), off["firm_routes"][:5]))
    assert off["board"]["status"] == 404, off["board"]
    # Non-vacuity: the same app WITH the flag serves the board, so this
    # test cannot pass by the board being broken for another reason.
    on = real_app_under(None)
    assert on["firm_routes"], on
    assert on["board"]["status"] == 200, on["board"]


def test_the_server_module_imports_no_firm_module_when_the_cockpit_is_off():
    """With FIRM_COCKPIT_ENABLED unset, nothing under engine.api._firm* loads.

    THE INCIDENT THIS EXISTS FOR (2026-09-05, 45 s of total outage).
    `server.py` imported the four firm routers at MODULE scope, so
    `import engine.api.server` required the whole firm package on disk even
    with the Cockpit off. A deploy of an unrelated security fix shipped
    server.py without those modules; every worker died at import with
    `ModuleNotFoundError: No module named 'engine.api._firm'` and the site
    answered 502 on every route until the file was rolled back. Neither the
    firm code nor the mount had changed — the dependency was invisible
    because nothing measured it.

    A surface that is OFF must cost nothing to deploy. This reds if any
    firm module returns to module scope, i.e. if `engine.api.server`
    becomes undeployable without the Cockpit's files again. It does NOT red
    on a Cockpit that is broken behind its flag — the rest of this file
    measures that.
    """
    code = (
        "import json, sys\n"
        "import engine.api.server as srv\n"
        "app = srv.create_app(config_path=%r)\n"
        "firm = sorted(m for m in sys.modules\n"
        "              if m.startswith('engine.api._firm') or m == 'engine.firm'\n"
        "              or m.startswith('engine.firm.'))\n"
        "paths = sorted(set(getattr(r, 'path', '') for r in app.routes\n"
        "                   if str(getattr(r, 'path', '')).startswith('/api/firm')))\n"
        "print(json.dumps({'firm_modules': firm, 'firm_routes': paths}))\n"
        % str(REPO / "config.yaml")
    )
    env = dict((k, v) for k, v in os.environ.items() if k not in STRIPPED_ENV)
    env.update(FAKE_ENV)
    env["FIRM_COCKPIT_ENABLED"] = ""          # the production posture
    env["PYTHONPATH"] = os.pathsep.join([str(REPO / "src"), str(REPO / "tests" / "engine")])
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True,
                          text=True, env=env, timeout=300, cwd=str(REPO))
    assert proc.returncode == 0, proc.stderr[-3000:]
    measured = json.loads(proc.stdout.strip().splitlines()[-1])
    assert measured["firm_modules"] == [], (
        "FIRM_COCKPIT_ENABLED is unset and importing engine.api.server still "
        "loaded %d firm module(s): %s — server.py cannot be deployed without "
        "the Cockpit's files, which is the 2026-09-05 outage."
        % (len(measured["firm_modules"]), measured["firm_modules"]))
    assert measured["firm_routes"] == [], measured["firm_routes"]
