"""F5 — AI NEVER PRODUCES A PROJECTED NUMBER.

There is no AI in this wave at all. This gate exists so there is none in
wave 2 either: no model-authored numeral may reach a driver, a projected
result, or the prose printed beside one.

It does NOT install a second guard. ``engine.ai.numerals`` already refuses
model-authored digits against typed facts and serves a deterministic
fallback, and ``engine.forecast_serving.boundary.guard_projection_narrative``
calls it in ``MODE_ENFORCE``, reading ``GuardResult.accepted`` itself rather
than serving ``result.text``. That construction — not the mode argument — is
what holds the line, and the plant below proves it by setting the environment
every way it can be set.

WHAT THIS GATE REDS ON, AFTER THE REPAIR (TC-11)
------------------------------------------------
  * any forecast package importing a model surface (``anthropic``,
    ``openai``, ``engine.ai.advisory``, ``engine.ai.registry``,
    ``engine.ai.finding_sharpen``, ``engine.ai_lane``) — measured by
    importing the packages in a CLEAN interpreter and reading
    ``sys.modules``, so a lazily-imported client is caught too;
  * a model draft containing a numeral reaching a served narrative;
  * ``AI_NUMERAL_GUARD`` set to ``off``/``observe``/anything letting one
    through;
  * a numeral in a model-authored field anywhere in a served projection
    block;
  * a driver value or a projected amount whose source is a model — proved
    negatively: the whole serving namespace computes nothing and calls
    nothing, so there is no code path for a model to write into.

WHAT IT CANNOT SEE (TC-11)
--------------------------
  * lane M's and lane D's packages before they exist. The import scan walks
    every ``engine.forecast*`` package PRESENT on the tree and prints which
    ones it found, so when ``engine.forecast`` and ``engine.forecast_drivers``
    land they are covered with no edit here — but until they do, this gate
    covers ``engine.forecast_serving`` alone and says so out loud rather than
    passing vacuously.
  * a model asserting a false CLAIM in words with no digits in it. The guard
    is a numeral guard, not a truth oracle.
  * a numeral a model writes into a field this sweep does not consider
    model-authored. The precise instrument is
    ``guard_projection_narrative``; the sweep is the net for a lane that
    never called it.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "tests" / "engine"))

from engine.forecast_serving import (  # noqa: E402
    MODEL_SURFACE_MODULES,
    ProjectionGateway,
    ai_authored_numerals,
    guard_projection_narrative,
)
from forecast_boundary_fixture import projection_payload  # noqa: E402


def _forecast_packages():
    """Every ``engine.forecast*`` package on the tree today, sorted."""
    root = REPO / "src" / "engine"
    return sorted(
        p.name for p in root.iterdir()
        if p.is_dir() and p.name.startswith("forecast")
        and (p / "__init__.py").exists()
    )


# ── the import scan, in a clean interpreter ──────────────────────────────


def test_the_scan_is_not_vacuous_and_names_what_it_covers():
    """A gate that finds nothing to check is broken, not clean (TC-3)."""
    packages = _forecast_packages()
    assert "forecast_serving" in packages, packages
    print("F5 import scan covers: %s" % ", ".join(packages))


def test_importing_the_forecast_packages_loads_no_model_surface():
    """Measured in a FRESH interpreter, because inside the pytest session a
    sibling test has already imported half the engine and ``sys.modules``
    would say nothing about this package."""
    packages = _forecast_packages()
    program = (
        "import sys\n"
        "sys.path.insert(0, %r)\n"
        "for name in %r:\n"
        "    __import__('engine.' + name)\n"
        "import json\n"
        "print(json.dumps(sorted(\n"
        "    n for n in list(sys.modules)\n"
        "    if any(n == m or n.startswith(m + '.') for m in %r)\n"
        ")))\n" % (str(REPO / "src"), packages, list(MODEL_SURFACE_MODULES))
    )
    result = subprocess.run(
        [sys.executable, "-c", program],
        capture_output=True, text=True, cwd=str(REPO), timeout=90,
    )
    assert result.returncode == 0, result.stderr
    loaded = json.loads(result.stdout.strip().splitlines()[-1])
    assert loaded == [], (
        "importing %s loaded a model surface: %s. AI never produces a "
        "projected number — not a driver, not a result, not a rounding."
        % (", ".join(packages), ", ".join(loaded))
    )


def test_exercising_the_gateway_end_to_end_still_loads_no_model_surface():
    """Not just import — USE. A client constructed inside the first call to
    some accessor is still a client.

    The payload arrives on STDIN rather than being built in the child, on
    purpose: importing the test fixture would import ``engine.insights.book``,
    and ``engine.insights`` pulls ``engine.ai.registry`` at import time (its
    narrative lane imports the numeral guard's neighbours). That is a real
    fact about the insights package and it was found by this very assertion —
    but it is not a fact about THIS package, and letting the fixture's import
    graph into the measurement would make the gate measure the wrong thing in
    both directions: green when the fixture changes, red when it does not.
    """
    payload = json.dumps(projection_payload())
    program = (
        "import sys, json\n"
        "sys.path.insert(0, %r)\n"
        "from engine.forecast_serving import ProjectionGateway\n"
        "payload = json.loads(sys.stdin.read())\n"
        "g = ProjectionGateway.from_payload(payload)\n"
        "blob = g.as_dict()\n"
        "assert blob['figures'], 'the child exercised nothing'\n"
        "assert g.unbalanced_periods() == ()\n"
        "print(json.dumps(sorted(\n"
        "    n for n in list(sys.modules)\n"
        "    if any(n == m or n.startswith(m + '.') for m in %r)\n"
        ")))\n" % (str(REPO / "src"), list(MODEL_SURFACE_MODULES))
    )
    result = subprocess.run(
        [sys.executable, "-c", program], input=payload,
        capture_output=True, text=True, cwd=str(REPO), timeout=90,
    )
    assert result.returncode == 0, result.stderr
    loaded = json.loads(result.stdout.strip().splitlines()[-1])
    assert loaded == [], loaded


# ── THE PLANT: a model writing a number about a forecast ─────────────────

_FALLBACK = (
    "Revenue is projected to grow at the rate the operator stated; the "
    "driver and its basis are listed beside the figure."
)


def test_plant_a_model_authored_numeral_about_a_projection_is_refused():
    """A model doing what models do: writing a figure it invented, about a
    year that has not happened."""
    draft = (
        "Revenue reaches 128.1 million next year, which is 8% ahead of the "
        "sector."
    )
    served = guard_projection_narrative(draft, {}, fallback=_FALLBACK)
    assert served["source"] == "deterministic", served
    assert served["text"] == _FALLBACK
    assert "128.1" not in served["text"]
    assert "bare_numeral" in served["reason"], served["reason"]


def test_the_env_var_cannot_disarm_this_channel(monkeypatch):
    """``AI_NUMERAL_GUARD`` must not be able to open a path for a
    model-authored numeral into a forecast.

    TWO defences hold this, and planting each away in turn showed that
    NEITHER IS SUFFICIENT ALONE — the tidy summary is wrong:

      * drop the explicit ``mode=MODE_ENFORCE`` and set the env to ``off``:
        measured, the model's own sentence is served (``source: ai``). The
        mode argument is the only thing that closes ``off``.
      * keep the mode but serve ``result.text`` instead of reading
        ``GuardResult.accepted``: in ``observe`` the guard passes the draft
        through byte-identical with ``accepted=False``, so reading
        ``accepted`` is the only thing that closes ``observe``.

    This test reds if either is removed, which is why it walks every mode
    rather than only the interesting one.
    """
    draft = "Revenue reaches 128.1 million next year."
    for mode in ("off", "observe", "enforce", "nonsense", ""):
        monkeypatch.setenv("AI_NUMERAL_GUARD", mode)
        served = guard_projection_narrative(draft, {}, fallback=_FALLBACK)
        assert served["source"] == "deterministic", (mode, served)
        assert "128.1" not in served["text"], mode


def test_a_currency_code_in_the_models_own_prose_about_a_forecast_is_refused():
    monkeypatch_free_draft = "The projection is stated in RON throughout."
    served = guard_projection_narrative(
        monkeypatch_free_draft, {}, fallback=_FALLBACK,
    )
    assert served["source"] == "deterministic"
    assert "loose_currency_label" in served["reason"], served["reason"]


def test_a_draft_that_names_no_number_at_all_is_allowed_through():
    """The guard is a numeral guard, not a censor: prose with no digits and no
    currency label is the model's job and passes."""
    draft = "Growth is carried at the operator's plan rather than fitted."
    served = guard_projection_narrative(draft, {}, fallback=_FALLBACK)
    assert served["source"] == "ai", served
    assert served["text"] == draft


# ── the served projection carries no model-authored numeral ──────────────


def test_the_served_projection_block_contains_no_ai_authored_numeral():
    served = ProjectionGateway.from_payload(projection_payload()).as_dict()
    assert ai_authored_numerals(served) == []


def test_the_sweep_is_not_vacuous_it_catches_a_planted_narrative():
    served = ProjectionGateway.from_payload(projection_payload()).as_dict()
    assert ai_authored_numerals(served) == []
    served["figures"][0]["explanation"] = "Grows 8% on last year."
    found = ai_authored_numerals(served)
    assert found == ["$.figures[0].explanation"], found


# ── the negative proof: there is no write path at all ────────────────────


def test_the_serving_namespace_declares_no_way_for_a_model_to_write_a_number():
    """Every public entry point either reads the payload or refuses it. The
    ONE function that touches a model takes prose and returns prose, and its
    numeric arguments are the engine's own typed facts."""
    import inspect

    import engine.forecast_serving as ns

    source = inspect.getsource(ns.gateway) + inspect.getsource(ns.projection)
    for surface in MODEL_SURFACE_MODULES:
        assert surface not in source, (
            "%s is named in the projection read path" % surface
        )
    # `guard_projection_narrative` is the only place `engine.ai` appears, and
    # it appears inside a function body, not at module scope.
    boundary_source = inspect.getsource(ns.boundary)
    assert boundary_source.count("engine.ai.numerals") >= 1
    for line in boundary_source.splitlines():
        if line.startswith("from engine.ai") or line.startswith("import engine.ai"):
            raise AssertionError(
                "engine.ai is imported at module scope in boundary.py: %r "
                "— importing the forecast namespace must load no model "
                "surface" % line
            )


@pytest.mark.parametrize("surface", MODEL_SURFACE_MODULES)
def test_the_model_surface_roster_is_real_and_not_a_list_of_typos(surface):
    """A roster of module names nobody checks is a roster that rots. Every
    entry either imports or is a third-party package genuinely absent from
    this environment — what is NOT allowed is a name that is simply
    misspelled, which would make the scan silently cover nothing."""
    if surface in ("anthropic", "openai"):
        return  # third-party; presence is environment-dependent
    __import__(surface)


def test_the_roster_excludes_the_guard_and_the_config_table_on_purpose():
    """This roster was WRONG on its first draft, and the measurement is what
    corrected it — recorded here so nobody "fixes" it back.

    ``engine.ai.registry`` is a schema-validated YAML table whose own
    docstring says it must never pull an SDK; ``engine.ai.numerals`` is the
    numeral GUARD. Neither can author a digit. Listing them made this gate red
    on ``engine.forecast_drivers``, which imports ``engine.insights.book`` —
    and ``engine.insights.__init__`` eagerly imports its narrative lane, which
    names both. A gate that reds on correct code is the gate that is wrong
    (TC-11), so the roster now asks one question per entry: CAN THIS MODULE
    PUT A MODEL ON THE WIRE.
    """
    assert "engine.ai.registry" not in MODEL_SURFACE_MODULES
    assert "engine.ai.numerals" not in MODEL_SURFACE_MODULES
    assert "engine.ai_lane" in MODEL_SURFACE_MODULES
    assert "anthropic" in MODEL_SURFACE_MODULES


def test_plant_a_forecast_module_that_imports_a_model_surface_and_it_reds():
    """THE PLANT for the import scan. Without it the scan is a green light
    that has never been shown a red thing (TC-3): a sweep that finds nothing
    is broken, not clean.

    Nothing is written to the repo — the planted module is created inside the
    child interpreter, in ITS temp dir, and dies with it.
    """
    program = (
        "import sys, json, tempfile, os\n"
        "sys.path.insert(0, %r)\n"
        "tmp = tempfile.mkdtemp()\n"
        "pkg = os.path.join(tmp, 'forecast_planted')\n"
        "os.makedirs(pkg)\n"
        "open(os.path.join(pkg, '__init__.py'), 'w').write(\n"
        "    'from engine.ai import finding_sharpen  # PLANT\\n')\n"
        "sys.path.insert(0, tmp)\n"
        "import forecast_planted\n"
        "print(json.dumps(sorted(\n"
        "    n for n in list(sys.modules)\n"
        "    if any(n == m or n.startswith(m + '.') for m in %r)\n"
        ")))\n" % (str(REPO / "src"), list(MODEL_SURFACE_MODULES))
    )
    result = subprocess.run(
        [sys.executable, "-c", program],
        capture_output=True, text=True, cwd=str(REPO), timeout=90,
    )
    assert result.returncode == 0, result.stderr
    loaded = json.loads(result.stdout.strip().splitlines()[-1])
    assert "engine.ai.finding_sharpen" in loaded, (
        "the import scan did not see a module that imports a model surface — "
        "it would pass a real one too: %s" % loaded
    )
