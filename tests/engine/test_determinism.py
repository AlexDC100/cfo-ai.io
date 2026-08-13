"""Determinism gate as pytest (Phase-5 item 2, contract requirement 1).

Same file parsed + assembled 5× must yield BYTE-IDENTICAL canonical JSON
(`json.dumps(..., sort_keys=True)` over `assembled_canonical_v1`,
canonical_bs included). Reuses scripts/verify_determinism.py's own
fixture registry and structural differ — one source of truth, so the CI
script and this suite can never audit different fixture sets by drift.

The synthetic Phase-5 fixtures run through the same 5× check: they are
tiny, and the RO-locale + CSV variants specifically pin the per-document
locale vote (a nondeterministic vote would break byte-identity here
first).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SYNTHETIC_DIR = (
    REPO / "src" / "engine" / "country_packs" / "ro_romania" / "fixtures" / "synthetic"
)


def _load_verify_determinism():
    """Import scripts/verify_determinism.py by path (it is a script, not
    a package member). Idempotent via sys.modules so repeated collection
    never re-executes it."""
    name = "verify_determinism"
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(
        name, str(REPO / "scripts" / "verify_determinism.py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# The determinism script IS the registry — import it, don't mirror it.
_vd = _load_verify_determinism()

RUNS = _vd.RUNS  # 5 — the contract's number, not a local choice

_GOLDEN = [(path, label) for path, label, _expected in _vd.FIXTURES]
_SYNTHETIC = [
    (SYNTHETIC_DIR / "synthetic_tb_ro_locale.xlsx", "synthetic_ro_locale"),
    (SYNTHETIC_DIR / "synthetic_tb_anglo_locale.xlsx", "synthetic_anglo_locale"),
    (SYNTHETIC_DIR / "synthetic_tb_ro_locale.csv", "synthetic_ro_csv"),
    (SYNTHETIC_DIR / "synthetic_tb_generic_4col.xlsx", "synthetic_generic_4col"),
]
_ALL = _GOLDEN + _SYNTHETIC


@pytest.mark.parametrize(
    "fixture_path,label", _ALL, ids=[label for _p, label in _ALL]
)
def test_five_runs_byte_identical(pack, fixture_path, label):
    assert fixture_path.is_file(), f"fixture missing: {fixture_path}"
    content = fixture_path.read_bytes()

    dumps = []
    envelopes = []
    for _ in range(RUNS):
        _tb_rows, _shaped, assembled = pack.run_deterministic_tb(
            content, fixture_path.name
        )
        env = assembled.get("assembled_canonical_v1")
        assert isinstance(env, dict), f"[{label}] no assembled_canonical_v1 emitted"
        assert "canonical_bs" in env, f"[{label}] envelope has no canonical_bs"
        envelopes.append(env)
        dumps.append(json.dumps(env, sort_keys=True, ensure_ascii=False))

    for i, dump in enumerate(dumps[1:], start=2):
        if dump != dumps[0]:
            diff = _vd._json_paths_diff(envelopes[0], envelopes[i - 1])
            pytest.fail(
                f"[{label}] run 1 vs run {i} NOT byte-identical; first "
                f"differing paths:\n  " + "\n  ".join(diff)
            )
