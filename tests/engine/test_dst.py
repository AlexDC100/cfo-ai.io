"""DST suite (Part B) — K-invariants under injected faults, on the REAL
pipeline composition (src/engine/dst/).

What is locked here:
  * NO SIMULATION FORK — the harness's fault-free baseline reproduces
    the golden-corpus serve artifacts byte-for-byte (same code objects
    scripts/corpus_replay.py drives).
  * K1 — kill-and-resume == uninterrupted: byte-identical envelope
    under the volatile-key normalization, no duplicated reconciliation
    adjustments, suppression entries intact. Includes the AI-lane
    resume defect found by this harness (resume of a lane run killed
    between FRONTEND_DONE and PASS_DONE must use the RECORDED lane
    assembled, never the RO stage_map): the direct tests below were the
    RED tests for the engine/journal/resume.py fix.
  * K2 — no partial snapshot is ever servable: torn objects are refused
    by every read path, ENOSPC/append faults leave an honestly
    incomplete chain and never touch the pipeline result, the DB
    envelope write is atomic-or-absent.
  * K3 — duplicate delivery → one chain + one snapshot + one period
    row; what cannot complete dead-letters with a typed reason and is
    resolved by the first later success.
  * The explorer: bounded per-PR matrix (1 fixture × every fault
    class) green; DST_PROFILE=deep expands to 3 fixtures × every fault
    × every boundary; failures minimize and archive to
    corpus/quarantine/dst/<sha16>/ (property-suite discipline).

ENGINE_JOURNAL_DIR is only ever set inside ``harness.journal_env``
scopes (tmp dirs) and restored on exit — the corpus and determinism
gates keep running journal-OFF (locked by the hygiene test).
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

from engine.api import _reconcile
from engine.api import pipeline as _pipeline
from engine.journal import Journal, ResumeRefused, resume_run
from engine.journal import hooks as _hooks

import engine.dst as dst
from engine.dst import explorer as dst_explorer
from engine.dst import faults as dst_faults
from engine.dst import harness as dst_harness

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"


def load_module_from_path(name, path):
    """Script-module loader (conftest.py pattern — tests/engine is not a
    package, so the helper is inlined)."""
    import importlib.util
    import sys

    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

BASELINE_FIXTURES = (
    "csv",
    "rounding_004pct",
    "unmapped_equals_delta",
    "imbalance_03pct",
    "hu_ai_lane",
)


@pytest.fixture(scope="module")
def corpus_replay():
    return load_module_from_path(
        "corpus_replay_for_dst", REPO / "scripts" / "corpus_replay.py"
    )


@pytest.fixture(autouse=True)
def _journal_env_restored():
    """Hygiene lock: no DST test may leak ENGINE_JOURNAL_DIR (the corpus
    and determinism gates run journal-OFF)."""
    prior = os.environ.get(_hooks.ENV_VAR)
    yield
    assert os.environ.get(_hooks.ENV_VAR) == prior, (
        "a DST test leaked ENGINE_JOURNAL_DIR"
    )
    _hooks.reset_cache()


def _run_fault(fault: str, fixture: str, boundary: str, tmp_path: Path) -> dict:
    """Run one registry scenario; K-invariant violations raise."""
    return dst.FAULTS[fault].runner(fixture, boundary, tmp_path)


# ── No simulation fork: baseline == golden corpus ──────────────────────


@pytest.mark.parametrize("fixture_name", BASELINE_FIXTURES)
def test_baseline_reproduces_corpus_golden(fixture_name, corpus_replay):
    """The harness's fault-free run reproduces the corpus goldens
    byte-for-byte (served envelope + gateway facts) — the composition
    is the REAL one, never a mirror."""
    baseline = dst.baseline_for(fixture_name)
    served = _reconcile.served_canonical_bs(baseline.envelope)
    golden = json.loads(
        (CORPUS / fixture_name / "expected" / "served_envelope.json").read_text(
            encoding="utf-8"
        )
    )
    assert corpus_replay.normalize(served) == golden
    facts_golden = json.loads(
        (CORPUS / fixture_name / "expected" / "gateway_facts.json").read_text(
            encoding="utf-8"
        )
    )
    assert baseline.facts == facts_golden


def test_baseline_is_deterministic(tmp_path):
    """Two independent fault-free runs are byte-identical (the seeded
    scheduler can only permute run order, never results)."""
    fixture = dst.FIXTURES["csv"]
    first = dst.FaultableAdmin()
    second = dst.FaultableAdmin()
    with dst.journal_env(None):
        r1 = dst_harness.run_fixture(fixture, admin=first)
        r2 = dst_harness.run_fixture(fixture, admin=second)
    assert r1.outcome == r2.outcome == "completed"
    assert dst.norm_bytes(first.envelope()) == dst.norm_bytes(second.envelope())


# ── K1: kill between stages → resume (every boundary, every lane) ──────


@pytest.mark.parametrize("boundary", dst_faults.KILL_POINTS)
@pytest.mark.parametrize(
    "fixture_name", ("csv", "rounding_004pct", "hu_ai_lane")
)
def test_k1_kill_and_resume_byte_identical(fixture_name, boundary, tmp_path):
    """K1 across every kill point × a BALANCED close, an auto-reconciled
    receipt, and the AI lane. The (hu_ai_lane, frontend_done) cell was
    RED before the resume.py fix: resume fed the lane payload into the
    RO stage_map and silently produced an empty BALANCED envelope."""
    summary = _run_fault("kill_between_stages", fixture_name, boundary, tmp_path)
    assert summary["boundary"] == boundary


def test_k1_lane_resume_uses_recorded_assembled(tmp_path):
    """THE red test for the resume fix, mechanism-level: an AI-lane run
    killed between FRONTEND_DONE and PASS_DONE resumes from the
    RECORDED ``parsed.ai_lane.assembled`` (production's own ai-lane
    branch semantics) — never through the RO ``stage_map``, which would
    fabricate an empty BALANCED statement from the lane's deliberately
    empty ``accounts``."""
    baseline = dst.baseline_for("hu_ai_lane")
    fixture = dst.FIXTURES["hu_ai_lane"]
    admin = dst.FaultableAdmin()
    root = tmp_path / "lane-resume"

    def _kill(name: str) -> None:
        if name == "frontend_done":
            raise dst.SimulatedKill(name)

    with dst.journal_env(root) as journal:
        killed = dst_harness.run_fixture(fixture, admin=admin, at_boundary=_kill)
        assert killed.outcome == "killed"
        assert journal is not None
        result = dst_harness.resume_latest(journal, killed.file_hash, admin)
        assert result["status"] == "resumed"

        envelope = admin.envelope()
        assert dst.norm_bytes(envelope) == baseline.norm, (
            "resumed AI-lane envelope must be byte-identical to the "
            "uninterrupted baseline"
        )
        # The mechanism, pinned: the served rows/status come from the
        # lane's recorded envelope, not an empty RO assembly.
        served = _reconcile.served_canonical_bs(envelope)
        baseline_served = _reconcile.served_canonical_bs(baseline.envelope)
        assert served["status"] == baseline_served["status"]
        assert len(served.get("rows") or []) == len(baseline_served.get("rows") or [])
        assert len(served.get("rows") or []) > 0
        # The resume run recorded PASS_DONE for the lane assembled.
        resume_events = journal.read_run(str(result["resume_run_id"]))
        assert "PASS_DONE" in [e.get("type") for e in resume_events]
        assert journal.verify_chain(killed.file_hash) == []


def test_k1_resume_refuses_zero_account_payload(tmp_path):
    """RED test #2 for the resume fix: a recorded parsed payload with
    ZERO accounts and no lane assembled must REFUSE to resume (typed),
    mirroring production's own loud zero-accounts failure — never mint
    an empty-but-analyzed period."""
    root = tmp_path / "zero-accounts"
    content = b"dst-zero-accounts-probe"
    doc = {
        "id": "doc-dst-zero",
        "org_id": "org-dst",
        "original_filename": "empty.pdf",
        "content_hash": "sha256-%s" % hashlib.sha256(content).hexdigest(),
        "period_end_hint": "2025-12-31",
    }
    parsed = {
        "company_name": "Empty",
        "period_label": "Imported period",
        "period_end": None,
        "currency": "RON",
        "confidence": 0.2,
        "detected_type": "public_records",
        "accounts": [],
        "warnings": [],
    }
    admin = dst.FaultableAdmin()
    with dst.journal_env(root) as journal:
        _hooks.on_run_started(doc, industry=None)
        _hooks.on_frontend_done(doc, parsed)
        _hooks.set_active_run(None)  # process death after the checkpoint
        _hooks.reset_cache()
        assert journal is not None
        run_id = str(journal.registered_runs(doc["content_hash"])[0]["run_id"])
        with dst.admin_seam(admin):
            with pytest.raises(ResumeRefused) as excinfo:
                resume_run(journal, run_id)
        assert excinfo.value.reason == "cannot_resume"
        assert admin.envelope() is None, "no period may be minted for the refusal"


def test_k1_suppression_survives_kill(tmp_path):
    """K1's suppression half: kill + resume of the persist that carries
    an undo suppression forward — suppression intact, the undone fix is
    NOT re-applied, byte-identical to the uninterrupted control."""
    for boundary in dst_harness.BOUNDARIES:
        summary = _run_fault(
            "suppression_survives_kill",
            "rounding_004pct",
            boundary,
            tmp_path / boundary,
        )
        assert summary["suppressed"] == 1


# ── K2: no partial snapshot is ever servable ───────────────────────────


@pytest.mark.parametrize("arm_point", dst_faults.STORE_ARM_POINTS)
def test_k2_disk_full_on_snapshot_write(arm_point, tmp_path):
    _run_fault("disk_full_snapshot_write", "csv", arm_point, tmp_path)


def test_k2_torn_object_never_served(tmp_path):
    summary = _run_fault("torn_write", "csv", "object_at_rest", tmp_path)
    assert summary["verify_errors"] >= 1


@pytest.mark.parametrize("arm_point", ("run_start", "pass_done"))
def test_k2_journal_append_failure(arm_point, tmp_path):
    _run_fault("journal_append_failure", "csv", arm_point, tmp_path)


@pytest.mark.parametrize(
    "position", dst.FAULTS["kill_inside_snapshot_commit"].boundaries
)
def test_k2_crash_inside_snapshot_commit(position, tmp_path):
    """The persist ordering rule exercised THROUGH stage_persist: object
    first, event second, serving last — each sub-step crash leaves a
    collectable or complete state, never a servable partial."""
    _run_fault("kill_inside_snapshot_commit", "csv", position, tmp_path)


def test_k2_serving_flip_db_failure_journal_runs_ahead(tmp_path):
    """The envelope DB write dying is the SAFE direction: journal ahead
    of serving; re-delivery heals serving while the journal
    short-circuits the duplicate."""
    summary = _run_fault("db_error_mid_persist", "csv", "envelope_write", tmp_path)
    assert summary["dlq"] == "not_needed"


# ── K3: duplicates + DLQ ───────────────────────────────────────────────


@pytest.mark.parametrize("fixture_name", ("csv", "rounding_004pct", "hu_ai_lane"))
def test_k3_duplicate_delivery_one_chain_one_snapshot(fixture_name, tmp_path):
    summary = _run_fault(
        "duplicate_delivery", fixture_name, "same_document", tmp_path
    )
    assert summary["period_rows"] == 1


@pytest.mark.parametrize("target", dst_faults.DB_FATAL_TARGETS)
def test_k3_db_error_mid_persist_dead_letters_and_replays(target, tmp_path):
    """A DB write dying mid-persist fails the run with the typed reason,
    dead-letters, and the DLQ REPLAY (fault cleared) lands the
    byte-identical envelope — the K1 loop through the operator path."""
    summary = _run_fault("db_error_mid_persist", "csv", target, tmp_path)
    assert summary["dlq"] == "replayed"


@pytest.mark.parametrize("stage", dst_faults.AI_STAGES)
def test_k3_ai_timeout_dead_letters_typed(stage, tmp_path):
    summary = _run_fault("ai_timeout", "hu_ai_lane", stage, tmp_path)
    assert summary["dlq_reason"] == "AiLaneError"


@pytest.mark.parametrize("stage", dst_faults.AI_STAGES)
def test_k3_ai_malformed_json_exhausts_single_retry(stage, tmp_path):
    summary = _run_fault("ai_malformed_json", "hu_ai_lane", stage, tmp_path)
    assert summary["dlq_reason"] == "AiLaneError"


def test_ai_malformed_once_recovers_with_honest_audit(tmp_path):
    summary = _run_fault("ai_malformed_recovers", "hu_ai_lane", "extract", tmp_path)
    baseline = dst.baseline_for("hu_ai_lane")
    assert summary["audit_attempts"] == baseline.audit_attempts + 1


def test_ai_slow_response_changes_nothing(tmp_path):
    summary = _run_fault("ai_slow_response", "hu_ai_lane", "classify", tmp_path)
    assert summary["elapsed_s"] >= 0.25


# ── Clock skew (the journal's injectable clock) ────────────────────────


def test_clock_skew_frozen_structural_order_decides(tmp_path):
    summary = _run_fault("clock_skew", "csv", "frozen", tmp_path)
    assert summary["stamps"] == 1


def test_clock_skew_backward_asof_still_structural(tmp_path):
    summary = _run_fault("clock_skew", "csv", "backward", tmp_path)
    assert summary["snapshots"] == 2


# ── Crash during undo ──────────────────────────────────────────────────


def test_crash_during_undo_leaves_receipt_untouched(tmp_path):
    summary = _run_fault(
        "crash_during_undo", "rounding_004pct", "undo_envelope_write", tmp_path
    )
    assert summary == {"history": 1, "suppressed": 1}


# ── The explorer ───────────────────────────────────────────────────────


def test_per_pr_matrix_covers_every_fault_class():
    matrix = dst.build_matrix("per-pr")
    assert len(matrix) == len(dst.FAULTS)
    assert {c.fault for c in matrix} == set(dst.FAULTS)
    for config in matrix:
        spec = dst.FAULTS[config.fault]
        assert config.boundary == spec.per_pr_boundary
        assert config.fixture in spec.fixtures_for("per-pr")


def test_deep_matrix_expands_every_boundary(monkeypatch):
    monkeypatch.setenv("DST_PROFILE", "deep")
    assert dst_explorer.profile_from_env() == "deep"
    matrix = dst.build_matrix("deep")
    assert len(matrix) > len(dst.build_matrix("per-pr"))
    kills = [c for c in matrix if c.fault == "kill_between_stages"]
    # 3 deterministic deep fixtures + the AI lane, × every kill point.
    assert {c.fixture for c in kills} == set(
        dst_harness.DEEP_DETERMINISTIC + ("hu_ai_lane",)
    )
    assert {c.boundary for c in kills} == set(dst_faults.KILL_POINTS)
    # AI-client faults structurally need the AI-lane fixture.
    for config in matrix:
        if config.fault.startswith("ai_"):
            assert config.fixture == "hu_ai_lane"


def test_explorer_schedule_is_seeded_and_deterministic(tmp_path):
    kwargs = dict(
        profile="per-pr",
        faults=["duplicate_delivery"],
        out_root=tmp_path / "q",
        minimize=False,
    )
    first = dst.explore(seed=5, **kwargs)
    second = dst.explore(seed=5, **kwargs)
    assert first["schedule"] == second["schedule"]
    assert first["failed"] == second["failed"] == []


def test_explorer_per_pr_profile_green(tmp_path):
    """The bounded per-PR gate: every fault class injected once, all
    K-invariants hold, nothing quarantined."""
    report = dst.explore(seed=3, profile="per-pr", out_root=tmp_path / "q")
    assert report["total"] == len(dst.FAULTS)
    assert report["failed"] == [], "per-PR DST matrix must be green: %r" % [
        f["config"] for f in report["failed"]
    ]
    assert report["quarantined"] == []
    assert not (tmp_path / "q").exists() or not any((tmp_path / "q").iterdir())


def test_explorer_quarantines_and_minimizes_failures(tmp_path, monkeypatch):
    """A failing config archives {seed, fixture, fault, boundary,
    traceback} to <out_root>/<sha16>/ and MINIMIZES to the smallest
    lane-compatible fixture (property-suite discipline)."""

    def _always_fails(fixture_name, boundary, scratch):
        raise dst_harness.InvariantViolation(
            "synthetic DST failure on %s@%s" % (fixture_name, boundary)
        )

    spec = dst_faults.FaultSpec(
        name="synthetic_always_fails",
        runner=_always_fails,
        lane="deterministic",
        boundaries=("only",),
        per_pr_boundary="only",
        per_pr_fixture="unmapped_equals_delta",  # NOT the smallest
        description="synthetic failure for the quarantine test",
    )
    monkeypatch.setitem(dst.FAULTS, spec.name, spec)
    out_root = tmp_path / "quarantine"
    report = dst.explore(
        seed=11, profile="per-pr", faults=[spec.name], out_root=out_root
    )
    assert report["total"] == 1
    assert len(report["failed"]) == 1
    failure = report["failed"][0]
    # Minimized: the smallest deterministic fixture, not the one that ran.
    smallest = dst_harness.minimize_order()[0]
    assert failure["config"]["fixture"] == smallest
    assert failure["minimized_from"]["fixture"] == "unmapped_equals_delta"

    target = Path(failure["quarantine"])
    assert target.parent == out_root
    assert len(target.name) == 16
    config = json.loads((target / "config.json").read_text(encoding="utf-8"))
    assert config["fault"] == spec.name
    assert config["fixture"] == smallest
    assert config["boundary"] == "only"
    assert config["seed"] == 11
    assert config["minimized_from"]["fixture"] == "unmapped_equals_delta"
    assert (target / "fault").read_text(encoding="utf-8").strip() == spec.name
    seed_doc = json.loads((target / "seed").read_text(encoding="utf-8"))
    assert seed_doc["seed"] == 11
    assert "synthetic DST failure" in (target / "traceback").read_text(
        encoding="utf-8"
    )


def test_gaps_are_documented_not_silent():
    """A fault the harness cannot inject is a documented gap. The list
    must name the known seams-that-do-not-exist and each entry must
    explain itself."""
    names = {g["name"] for g in dst.GAPS}
    assert {
        "pipeline_wall_clock_skew",
        "torn_write_in_flight",
        "ai_slow_drip_streaming",
        "os_level_sigkill",
        "kill_between_journal_commit_and_serving_flip",
    } <= names
    for gap in dst.GAPS:
        assert gap["name"] and len(gap["detail"]) > 80


# ── Journal-env hygiene (the corpus gates stay journal-OFF) ────────────


def test_journal_env_scopes_and_restores(tmp_path):
    prior = os.environ.get(_hooks.ENV_VAR)
    with dst.journal_env(tmp_path / "j") as journal:
        assert os.environ[_hooks.ENV_VAR] == str(tmp_path / "j")
        assert isinstance(journal, Journal)
    assert os.environ.get(_hooks.ENV_VAR) == prior
    with dst.journal_env(None) as nothing:
        assert nothing is None
        assert _hooks.ENV_VAR not in os.environ
    assert os.environ.get(_hooks.ENV_VAR) == prior


def test_journal_off_run_writes_nothing(tmp_path):
    """The corpus discipline: with the journal OFF the composition runs
    to the same bytes and no journal artifacts exist anywhere."""
    admin = dst.FaultableAdmin()
    with dst.journal_env(None):
        result = dst_harness.run_fixture(dst.FIXTURES["csv"], admin=admin)
    assert result.outcome == "completed"
    assert dst.norm_bytes(admin.envelope()) == dst.baseline_for("csv").norm
    assert not (tmp_path / "j").exists()


# ── The composition really is the production one (spot lock) ───────────


def test_harness_composes_production_stage_objects():
    """The harness calls the SAME callables production wires: guard the
    identity of the stage entry points it composes so a refactor that
    forks them fails loudly here."""
    import engine.dst.harness as h

    assert h._pipeline.stage_map is _pipeline.stage_map
    assert h._pipeline.stage_persist is _pipeline.stage_persist
    assert h._reconcile.served_canonical_bs is _reconcile.served_canonical_bs


def test_lane_marker_literal_locked():
    """resume.py keeps the lane marker literal (no lane import at
    journal import time — the facts.py precedent); this locks it to the
    lane's own constant so the literal cannot drift."""
    from engine.ai_lane import AI_LANE_DETECTED_TYPE
    from engine.journal import resume as journal_resume

    assert journal_resume._AI_LANE_DETECTED_TYPE == AI_LANE_DETECTED_TYPE


def test_kill_points_cover_every_stage_gap():
    """Every between-stage gap of the composed financial branch has a
    kill point: after RUN_STARTED, after FRONTEND_DONE (extract), after
    PASS_DONE (assemble), after persist."""
    assert dst_faults.KILL_POINTS == (
        "run_started",
        "frontend_done",
        "pass_done",
        "persist_done",
    )
    assert set(dst_faults.KILL_POINTS) <= set(dst_harness.ARM_POINTS)
