"""GOLDEN CORPUS replay — pytest wrapper (one test per case).

Runs scripts/corpus_replay.py's `run_case` for every case under
corpus/, so the corpus joins the standard battery: any diff between the
freshly-replayed pipeline artifacts and the frozen expected/ goldens
fails with the runner's per-field report (JSON path, expected, actual).

NO LIVE API CALLS: the runner nulls `sys.modules["anthropic"]` and
replaces `_reconcile._ai_propose` with a recording raiser for every
case (restored afterwards — later tests in the same session see the
real seams); mocked lanes get scripted clients through the engine's own
injectable seams. The Anthropic credit state can never affect this gate.

Also locked here:
  · the CLI contract — exit 0 on green, exit 1 + a readable per-field
    report when a golden diverges (exercised on a tampered tmp copy);
  · the anonymizer's numeric-invariance property on a corpus input
    (the same `--verify` the runner applies to anonymized cases).
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

CORPUS = REPO / "corpus"
REPLAY_SCRIPT = REPO / "scripts" / "corpus_replay.py"


def load_module_from_path(name: str, path: Path):
    """Same loader contract as conftest.load_module_from_path (inlined
    so this file stays importable outside a pytest session)."""
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


corpus_replay = load_module_from_path("corpus_replay", REPLAY_SCRIPT)

CASE_DIRS = corpus_replay.discover_cases(CORPUS) if CORPUS.is_dir() else []


def test_corpus_present_and_complete():
    """The corpus exists and every case carries all five goldens."""
    assert CASE_DIRS, "corpus/ has no cases — run corpus/_tools/make_corpus_inputs.py"
    missing = []
    for case_dir in CASE_DIRS:
        for name in corpus_replay.EXPECTED_ARTIFACTS:
            if not (case_dir / "expected" / name).is_file():
                missing.append("%s/expected/%s" % (case_dir.name, name))
    assert not missing, "unfrozen goldens (UPDATE_GOLDEN=1): %s" % missing


@pytest.mark.parametrize(
    "case_dir", CASE_DIRS, ids=[c.name for c in CASE_DIRS]
)
def test_corpus_case_replays_byte_identical(case_dir):
    failures = corpus_replay.run_case(case_dir, update=False)
    assert not failures, "\n".join(failures)


def test_replay_seams_restored_after_run():
    """run_case's guard patches (anthropic module null, _ai_propose
    recorder, the fake persist admin) must not leak into the rest of
    the battery."""
    from engine.api import _reconcile
    from engine.api import pipeline

    assert not isinstance(
        _reconcile._ai_propose, corpus_replay.AiProposeRecorder
    ), "_ai_propose left patched"
    assert sys.modules.get("anthropic", "absent") is not None, (
        "sys.modules['anthropic'] left nulled"
    )
    assert pipeline._supabase.admin.__name__ != "_fake_admin", (
        "pipeline._supabase.admin left patched"
    )


def _run_cli(*args: str, cwd: Path = REPO) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(
        [sys.executable, str(REPLAY_SCRIPT), *args],
        cwd=str(cwd), capture_output=True, text=True, timeout=600,
    )


def test_cli_green_case_exits_zero():
    result = _run_cli("--case", "exact_zero")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS   exact_zero" in result.stdout


def test_cli_tampered_golden_exits_nonzero_with_field_report(tmp_path):
    """The divergence contract: non-zero exit + a readable per-field
    report naming the JSON path with expected and actual values."""
    tampered_root = tmp_path / "corpus"
    case_src = CORPUS / "exact_zero"
    case_dst = tampered_root / "exact_zero"
    shutil.copytree(case_src, case_dst)
    statuses_path = case_dst / "expected" / "statuses.json"
    statuses = json.loads(statuses_path.read_text(encoding="utf-8"))
    statuses["served_status"] = "TAMPERED"
    statuses_path.write_text(
        json.dumps(statuses, sort_keys=True, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    result = _run_cli("--corpus-root", str(tampered_root))
    assert result.returncode == 1, result.stdout + result.stderr
    assert "statuses.json DIFFERS" in result.stdout
    assert "$.served_status" in result.stdout
    assert "'TAMPERED'" in result.stdout and "'BALANCED'" in result.stdout


def test_anonymizer_verify_holds_on_anonymized_corpus_input():
    """The scrambler's numeric-invariance property (--verify) on a real
    anonymized corpus input: codes, per-row numerics, column-pair sums
    and the totals-row anchor all survive a re-scramble."""
    anonymize_tb = load_module_from_path(
        "anonymize_tb", REPO / "scripts" / "anonymize_tb.py"
    )
    case = CORPUS / "saga_10_col_realestate" / "input.xlsx"
    if not case.is_file():
        pytest.skip("anonymized corpus input not present")
    assert anonymize_tb.verify_bytes(case.read_bytes()) == []
