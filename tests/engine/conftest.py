"""Shared fixtures for the canonical_bs v2 engine test suite (Phase-5).

Import contract: CI installs the package (`pip install -e .`) so
`engine` resolves normally; local runs work without an install because
this conftest puts `<repo>/src` on sys.path first. Both paths load the
SAME source tree.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any, Dict, Tuple

import pytest

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
