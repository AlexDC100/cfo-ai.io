"""FC1-import — every firm module imports FIRST, in a FRESH process, and
the deterministic attention path loads no AI subsystem and no server.

Run as its own named battery gate:

    python -m pytest tests/engine/test_firm_imports.py -q
    python scripts/run_battery.py            # gate name: firm-imports

THE DEFECT THIS GATE EXISTS FOR (critic finding C5, 2026-09-04): in a
fresh process `import engine.firm.facts` (or pack / severity / suppress /
calendar) as the first engine import raised

    ImportError: cannot import name 'AttentionCache' from partially
    initialized module 'engine.firm.facts' (most likely due to a circular
    import)

because `engine/api/__init__.py` eagerly imported `.server`, so the leaf
helper `engine.api._company_profile` dragged in every router, and
`_firm_attention` re-entered the half-built `engine.firm.facts`. The
whole suite passed only because `test_firm_attention.py` happened to
import `engine.api._company_profile` before any firm module — an import
ORDER the gate's own process cannot reproduce, which is why every
subject here runs in a subprocess of its own.

Two properties, both measured (`sys.modules` after the import), never
inferred from a line scan:

  1. every `src/engine/firm/*.py` and `src/engine/api/_firm*.py` module
     imports first, alone, with exit 0;
  2. after importing any `engine.firm.*` module NEITHER `engine.ai` NOR
     `engine.api.server` is loaded — the deterministic attention path
     carries no model subsystem, not even by presence (critic C9); and
     no `_firm*.py` router loads `engine.api.server` (the app is never
     on a firm module's import path). `engine.api._firm_brief` — the ONE
     model role in the cockpit — is the declared exception for
     `engine.ai`, and only for `engine.ai`.

The subjects are DISCOVERED from the tree (glob), so a new firm module
is on the roster the moment it exists; the roster is pinned against a
recorded floor so a glob that finds nothing cannot pass vacuously.

Every subprocess runs with the production Supabase / model environment
stripped (`.env` carries the prod URL); importing a module must not need
either, and must never reach either.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Tuple

import pytest

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
FIRM_PKG = SRC / "engine" / "firm"
API_PKG = SRC / "engine" / "api"

#: Environment the child must NOT see: the prod project URL/keys the
#: checkout's .env carries, a model key, and the test-mode bypass.
STRIPPED_ENV = ("VITE_SUPABASE_URL", "SUPABASE_URL", "SUPABASE_ANON_KEY",
                "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY",
                "PUBLIC_TEST_MODE", "ENGINE_TEST_MODE")

#: The one firm module allowed to load `engine.ai`: the advisory brief.
AI_ALLOWED = ("engine.api._firm_brief",)

#: Recorded roster size (10 package modules + 6 routers) — a floor, so a
#: glob that stops finding modules reds instead of passing on nothing.
ROSTER_FLOOR = 16

_PROBE = r"""
import importlib, json, sys
name = sys.argv[1]
try:
    importlib.import_module(name)
except BaseException as exc:  # noqa: BLE001 — report, the parent asserts
    print(json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}))
    raise SystemExit(0)
print(json.dumps({
    "ok": True,
    "engine_ai": "engine.ai" in sys.modules,
    "server": "engine.api.server" in sys.modules,
    "loaded_firm": sorted(m for m in sys.modules if m.startswith("engine.firm")),
}))
"""


def firm_modules() -> List[str]:
    """Every module under src/engine/firm/ plus every engine.api._firm*.py,
    dotted — discovered, not listed."""
    out = []  # type: List[str]
    for path in sorted(FIRM_PKG.glob("*.py")):
        if path.name == "__init__.py":
            continue
        out.append("engine.firm." + path.stem)
    for path in sorted(API_PKG.glob("_firm*.py")):
        out.append("engine.api." + path.stem)
    return out


def import_first(module: str) -> Dict[str, object]:
    """Import `module` as the FIRST engine import of a brand-new
    interpreter and report what ended up in sys.modules."""
    env = dict(os.environ)
    for key in STRIPPED_ENV:
        env.pop(key, None)
    env["PYTHONPATH"] = str(SRC)
    proc = subprocess.run(
        [sys.executable, "-c", _PROBE, module],
        cwd=str(REPO), env=env, capture_output=True, text=True, timeout=120)
    tail = (proc.stdout.strip().splitlines() or [""])[-1]
    try:
        report = json.loads(tail)
    except ValueError:
        raise AssertionError(
            "FC1-IMPORT VIOLATED — importing %s first in a fresh process did not report "
            "(exit %d)\nstdout: %s\nstderr: %s" % (module, proc.returncode,
                                                     proc.stdout[-800:], proc.stderr[-1200:]))
    return report


MODULES = firm_modules()


def test_the_roster_is_discovered_from_the_tree_and_not_empty():
    assert len(MODULES) >= ROSTER_FLOOR, (
        "roster collapsed: %d module(s) found, recorded floor %d — %s"
        % (len(MODULES), ROSTER_FLOOR, MODULES))
    assert "engine.firm.facts" in MODULES and "engine.api._firm_attention" in MODULES
    assert all(m.startswith("engine.firm.") or m.startswith("engine.api._firm") for m in MODULES)


@pytest.mark.parametrize("module", MODULES)
def test_firm_module_imports_first_in_a_fresh_process(module):
    """THE GATE. Each subject is the first engine import of its own
    interpreter — the only way an import cycle shows itself."""
    report = import_first(module)
    assert report.get("ok"), (
        "FC1-IMPORT VIOLATED — `import %s` FIRST in a fresh process failed: %s"
        % (module, report.get("error")))


@pytest.mark.parametrize("module", [m for m in MODULES if m.startswith("engine.firm.")])
def test_the_attention_path_loads_no_ai_subsystem_and_no_server(module):
    """Critic C9 answered by measurement: after importing an
    engine.firm module, `engine.ai` is NOT in sys.modules — not used,
    not present — and neither is the server."""
    report = import_first(module)
    assert report.get("ok"), report
    assert report["engine_ai"] is False, (
        "FC1-IMPORT VIOLATED — importing %s loaded engine.ai transitively; the "
        "deterministic attention path must not carry a model subsystem" % module)
    assert report["server"] is False, (
        "FC1-IMPORT VIOLATED — importing %s loaded engine.api.server; the app must "
        "never be on a firm module's import path" % module)


@pytest.mark.parametrize("module", [m for m in MODULES if m.startswith("engine.api._firm")])
def test_no_firm_router_loads_the_server_and_only_the_brief_loads_ai(module):
    report = import_first(module)
    assert report.get("ok"), report
    assert report["server"] is False, (
        "FC1-IMPORT VIOLATED — importing %s loaded engine.api.server" % module)
    if module in AI_ALLOWED:
        assert report["engine_ai"] is True, (
            "%s is the declared model role and no longer imports engine.ai — "
            "update AI_ALLOWED if that is intended" % module)
    else:
        assert report["engine_ai"] is False, (
            "FC1-IMPORT VIOLATED — %s loaded engine.ai; the brief is the ONE model "
            "role (AI_ALLOWED)" % module)


def test_engine_api_package_init_is_lazy_about_the_server():
    """The root cause, pinned: `import engine.api` alone must not import
    the server, and `create_app` must still resolve on demand."""
    report = import_first("engine.api")
    assert report.get("ok") and report["server"] is False, (
        "engine/api/__init__.py imports the server eagerly again — every leaf helper "
        "import would drag the whole app (and the firm cycle) back in: %s" % report)
    env = dict(os.environ)
    for key in STRIPPED_ENV:
        env.pop(key, None)
    env["PYTHONPATH"] = str(SRC)
    probe = ("from engine.api import create_app; import engine.api, sys; "
             "print(callable(create_app), engine.api.create_app is create_app, "
             "'engine.api.server' in sys.modules)")
    proc = subprocess.run([sys.executable, "-c", probe], cwd=str(REPO), env=env,
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr[-1200:]
    assert proc.stdout.strip() == "True True True", proc.stdout


def test_the_gate_is_not_vacuous():
    """A module that cannot be imported first is REPORTED as a failure by
    the probe — the mechanism the parametrized test asserts on."""
    report = import_first("engine.firm.does_not_exist")
    assert report.get("ok") is False and "ModuleNotFoundError" in str(report.get("error"))
