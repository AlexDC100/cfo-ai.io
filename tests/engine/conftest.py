"""Shared fixtures for the canonical_bs v2 engine test suite (Phase-5).

Import contract: CI installs the package (`pip install -e .`) so
`engine` resolves normally; local runs work without an install because
this conftest puts `<repo>/src` on sys.path first. Both paths load the
SAME source tree.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Any, Dict, Tuple

import pytest

# HERMETIC — NO PROCESS-WIDE DAEMON OUTLIVES THE TEST THAT BUILT THE APP.
# `server.create_app()` starts the quota ledger's maintenance daemon once
# per process whenever the Supabase variables are set (many tests set
# placeholders). It then ticks every 60 s for the rest of the pytest
# process, issuing `document_quota_ledger` requests through whatever HTTP
# double the test running AT THAT MOMENT has installed: a later test that
# counts requests or hosts goes red for a request it never made. Measured in
# the full battery of 2026-10-02 — `test_check_served_periods` ("asked
# ['document_quota_ledger']") and `test_launch_anonymous_egress` (a
# `test.supabase.co` call charged to GET /api/features/status), both green
# alone; the 2026-10-01 run recorded the same leak in `test_public_egress`.
# Which test is hit depends on timing, so the full gate was red at random.
# The engine's own switch turns the daemon off for the suite (and for the
# subprocesses a test spawns); the daemon's logic is tested through
# `_quota_ledger.maintenance_tick`, called directly. Law:
# test_suite_hermetic_daemons.py.
os.environ.setdefault("ENGINE_QUOTA_LEDGER_MAINTENANCE", "0")

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.core.country_pack_registry import get_pack  # noqa: E402

SYNTHETIC_DIR = (
    SRC / "engine" / "country_packs" / "ro_romania" / "fixtures" / "synthetic"
)


def load_module_from_path(name: str, path: Path):
    """Load a non-package module (script / fixture generator) by path.
    Registered in sys.modules before exec so dataclass forward refs and
    repeated loads behave; idempotent per name."""
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def _bearers_verify_against_the_test_jwks(monkeypatch):
    """IDENTITY (FC1x, critic D5). The backend verifies every bearer's ES256
    signature against Supabase's JWKS (engine.api._jwt). In this suite the
    verifier is pointed at the per-process TEST key from firm_postgrest_double
    — so a token minted by ``mint_jwt`` verifies, a forged one does not, and
    no test ever fetches a JWKS (with ``-p netblock`` a fetch would raise;
    without it, it would be a network call from a test). The key cache is
    emptied before every test so one test's keys never leak into the next."""
    import firm_postgrest_double as _double

    _double.install_test_jwks(monkeypatch)
    yield
    from engine.api import _jwt

    _jwt.reset_cache()


@pytest.fixture(autouse=True)
def _one_run_per_document_registries_are_per_test(monkeypatch):
    """The in-flight registry (`_doc_dedupe._IN_FLIGHT`) and the confirmed
    extra-document grants (`_usage_gate._EXTRA_GRANTS`) — and the quota
    ledger's retried settlement writes (`_quota_ledger._PENDING`) — are
    process-wide by design — the engine is one process. A test whose `_enqueue` is a
    recorder never runs the daemon thread that clears its claim, so each
    test starts with both empty and leaves nothing behind for the next."""
    from engine.api import _doc_dedupe, _quota_ledger, _usage_gate

    monkeypatch.setattr(_doc_dedupe, "_IN_FLIGHT", {})
    for name, empty in (("_EXTRA_GRANTS", dict), ("_LAST_EXTRA_REQUIRED", dict)):
        if hasattr(_usage_gate, name):
            monkeypatch.setattr(_usage_gate, name, empty())
    # The quota ledger's failed settlement writes, kept for retry — and the
    # settling rows it has already reported (once per process, at ERROR).
    monkeypatch.setattr(_quota_ledger, "_PENDING", {})
    monkeypatch.setattr(_quota_ledger, "_SETTLING_REPORTED", set())
    # The ABSENT window a PGRST205 opens (P2-A): a test that models the
    # table missing must not silence the ledger for the tests after it.
    if hasattr(_quota_ledger, "_ABSENT"):
        monkeypatch.setattr(_quota_ledger, "_ABSENT", {"until": 0.0, "windows": 0})
    # Which claimed Docs-panel re-runs were handed off as STAGED
    # (`pipeline._STAGED_RERUNS`): set by POST /api/pipeline/retry, popped by
    # the run. A test whose `_enqueue` is a recorder may never run it. Only
    # when the module is already loaded — this fixture rides on every test
    # of the suite and must not import the pipeline for those that do not.
    _pipeline = sys.modules.get("engine.api.pipeline")
    if _pipeline is not None and hasattr(_pipeline, "_STAGED_RERUNS"):
        monkeypatch.setattr(_pipeline, "_STAGED_RERUNS", {})
    yield


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO


@pytest.fixture(scope="session")
def pack():
    return get_pack("RO")


@pytest.fixture(scope="session")
def synthetic_dir() -> Path:
    return SYNTHETIC_DIR


@pytest.fixture(scope="session")
def synth():
    """The synthetic-fixture generator module — single source of truth
    for the expected values the committed fixture files encode."""
    return load_module_from_path(
        "ro_synthetic_fixtures", SYNTHETIC_DIR / "make_synthetic_fixtures.py"
    )


@pytest.fixture(scope="session")
def run_tb(pack):
    """Memoized offline parse+assemble on a fixture path. One parse per
    file per session, shared by every test — the cache key is the
    resolved path string, so iteration order never reaches any output."""
    cache: Dict[str, Tuple[Any, Any, dict]] = {}

    def _run(path: Path) -> Tuple[Any, Any, dict]:
        key = str(path.resolve())
        if key not in cache:
            cache[key] = pack.run_deterministic_tb(path.read_bytes(), path.name)
        return cache[key]

    return _run
