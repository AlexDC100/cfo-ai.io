"""Crash-safety suite (Part A) — the persist ORDERING RULE encoded as
tests, idempotent resume (K2), and the DLQ lifecycle.

The ordering rule under test (engine/journal/journal.py):
    1. snapshot content is written CONTENT-ADDRESSED FIRST,
    2. then SNAPSHOT_PERSISTED commits to the journal,
    3. then serving flips (the caller's DB write).
Crashes are injected through the journal writer's ``crash_after``
dependency-injection seam — both directions are proven:
  * a snapshot OBJECT without its journal event is invisible garbage
    (collectable, list-only by default), and the interrupted write is
    idempotently completable;
  * a journal EVENT without its object is impossible by ordering — an
    object-write failure leaves no event behind.

K2 (idempotent resume): a run interrupted at ANY stage boundary resumes
from its last completed checkpoint via the RECORDED stage entry points
(the real ``pipeline.stage_map`` / ``stage_persist`` against the
fake-admin harness) and produces a BYTE-IDENTICAL envelope to an
uninterrupted run — compared under the corpus volatile-key
normalization discipline (write stamps stripped, everything else
byte-exact).
"""
from __future__ import annotations

import contextlib
import copy
import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from engine.core.country_pack_registry import get_pack
from engine.api import pipeline as _pipeline
from engine.journal import (
    CRASH_AFTER_EVENT_APPEND,
    CRASH_AFTER_OBJECT_WRITE,
    Journal,
    ResumeRefused,
    SimulatedCrash,
    canonical_bytes,
    normalized_envelope,
    replay_dlq,
    resume_run,
)
from engine.journal import hooks as _hooks

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"


# ── harness (mirrors test_journal.py) ──────────────────────────────────


class FakeAdminClient:
    def __init__(self) -> None:
        self.period_rows: List[Dict[str, Any]] = []
        self.updates: List[Any] = []

    def select(self, table, *, filters=None, columns="*", limit=None,
               order=None, single=False):
        if table != "financial_periods":
            return []

        def _matches(row):
            for key, value in (filters or {}).items():
                if not str(value).startswith("eq."):
                    return False
                if str(row.get(key)) != str(value)[3:]:
                    return False
            return True

        return [r for r in self.period_rows if _matches(r)]

    def insert(self, table, rows, returning=True):
        rows_list = rows if isinstance(rows, list) else [rows]
        if table == "financial_periods":
            new = dict(rows_list[0])
            new["id"] = "period-1"
            self.period_rows.append(new)
            return [new]
        return rows_list if returning else []

    def update(self, table, patch, *, filters=None):
        self.updates.append((table, copy.deepcopy(patch), dict(filters or {})))
        if table == "financial_periods":
            for row in self.period_rows:
                if (filters or {}).get("id") == "eq.%s" % row.get("id"):
                    row.update(copy.deepcopy(patch))

    def delete(self, table, *, filters=None):
        return None

    def envelope(self) -> Dict[str, Any]:
        return self.period_rows[0]["assembled_canonical_v1"]


@contextlib.contextmanager
def fake_persist_seam():
    fake = FakeAdminClient()

    @contextlib.contextmanager
    def _fake_admin():
        yield fake

    prior = _pipeline._supabase.admin
    _pipeline._supabase.admin = _fake_admin
    try:
        yield fake
    finally:
        _pipeline._supabase.admin = prior


@pytest.fixture()
def journal_dir(monkeypatch, tmp_path):
    root = tmp_path / "journal"
    monkeypatch.setenv(_hooks.ENV_VAR, str(root))
    _hooks.reset_cache()
    yield root
    _hooks.reset_cache()


def load_case(case_id: str):
    pack = get_pack("RO")
    case_dir = CORPUS / case_id
    input_path = sorted(case_dir.glob("input.*"))[0]
    content = input_path.read_bytes()
    if input_path.suffix == ".csv":
        tb_rows = pack.parse_trial_balance_csv(content, input_path.name)
    else:
        tb_rows = pack.parse_trial_balance(content, input_path.name)
    shaped = pack.accounts_to_assemble_shape(tb_rows)
    doc = {
        "id": "doc-%s" % case_id,
        "org_id": "org-crash",
        "original_filename": input_path.name,
        "content_hash": "sha256-%s" % hashlib.sha256(content).hexdigest(),
        "period_end_hint": "2025-12-31",
    }
    parsed = _pipeline._deterministic_tb_parsed(
        doc, tb_rows, shaped,
        pack.compute_statutory_net_profit_anchor(tb_rows),
        pack.compute_source_imbalance(tb_rows),
    )
    return doc, parsed


def norm_dump(envelope: Dict[str, Any]) -> bytes:
    data, _lossy = canonical_bytes(normalized_envelope(envelope))
    return data


def _synthetic_envelope(tag: str = "a") -> Dict[str, Any]:
    return {
        "canonical_bs": {
            "schema": "bs_v2",
            "mapping_version": "ro_omfp1802_v2",
            "extraction": {"method": "deterministic", "parser_version": "tb_parser_v5"},
            "status": "BALANCED",
        },
        "pack_provenance": {"pack_hash": "packhash-%s" % tag},
        "provenance": {
            "source_document_id": "doc-syn",
            "content_hash": "sha256-synthetic-%s" % tag,
            "written_at": "2026-08-23T00:00:00+00:00",
        },
        "marker": tag,
    }


# ── ORDERING RULE, direction 1: object first, event second ─────────────


def test_crash_between_object_write_and_event_leaves_collectable_orphan(journal_dir):
    journal = Journal(journal_dir)
    envelope = _synthetic_envelope()
    fh = envelope["provenance"]["content_hash"]
    handle = journal.begin_run(
        file_hash=fh, document_id="doc-syn", engine_version="test", run_kind="pipeline"
    )

    with pytest.raises(SimulatedCrash):
        handle.record_snapshot(
            envelope, period_id="period-1", crash_after=CRASH_AFTER_OBJECT_WRITE
        )

    # The object landed; NO snapshot event committed.
    data, _lossy = canonical_bytes(envelope)
    digest = hashlib.sha256(data).hexdigest()
    assert journal.store.has(digest)
    assert journal.snapshots(fh) == []
    # The chain (RUN_STARTED only) still verifies — nothing dangling
    # INSIDE the committed chain.
    assert journal.verify_chain(fh) == []

    # The orphan is visible to the collector — list-only by default.
    report = journal.gc_orphans()
    assert digest in report["orphans"]
    assert journal.store.has(digest), "list-only gc must not delete"

    # Idempotent completion: re-running the interrupted write finishes
    # cleanly (the object write is a content-addressed no-op).
    result = handle.record_snapshot(envelope, period_id="period-1")
    assert result["duplicate"] is False
    assert len(journal.snapshots(fh)) == 1
    assert journal.verify_chain(fh) == []
    assert journal.gc_orphans()["orphans"] == []

    # Explicit delete collects nothing now that the object is referenced.
    assert journal.gc_orphans(delete=True)["deleted"] == []
    assert journal.store.has(digest)


def test_event_without_object_is_impossible_by_ordering(journal_dir, monkeypatch):
    journal = Journal(journal_dir)
    envelope = _synthetic_envelope("b")
    fh = envelope["provenance"]["content_hash"]
    handle = journal.begin_run(
        file_hash=fh, document_id="doc-syn", engine_version="test", run_kind="pipeline"
    )

    def _failing_write(data):
        raise IOError("disk full")

    monkeypatch.setattr(journal.store, "write_object", _failing_write)
    with pytest.raises(IOError):
        handle.record_snapshot(envelope, period_id="period-1")

    # No event was appended — an event referencing a missing object
    # cannot exist.
    assert journal.snapshots(fh) == []
    assert journal.verify_chain(fh) == []
    for event in journal.chain_events(fh):
        assert event["type"] != "SNAPSHOT_PERSISTED"


def test_crash_after_event_before_serving_flip_is_resumable(journal_dir):
    """Direction 2 of the ordering rule: the journal may run AHEAD of
    serving (event committed, DB write crashed) — the safe direction.
    The chain honestly shows the snapshot; re-running the persist is a
    duplicate short-circuit, never a second snapshot."""
    journal = Journal(journal_dir)
    envelope = _synthetic_envelope("c")
    fh = envelope["provenance"]["content_hash"]
    handle = journal.begin_run(
        file_hash=fh, document_id="doc-syn", engine_version="test", run_kind="pipeline"
    )
    with pytest.raises(SimulatedCrash):
        handle.record_snapshot(
            envelope, period_id="period-1", crash_after=CRASH_AFTER_EVENT_APPEND
        )
    assert len(journal.snapshots(fh)) == 1
    assert journal.verify_chain(fh) == []

    # "Re-delivery" after the crash (same content, same key) — e.g. the
    # user retries the scan: exactly one snapshot remains.
    retry = journal.begin_run(
        file_hash=fh, document_id="doc-syn", engine_version="test", run_kind="pipeline"
    )
    result = retry.record_snapshot(envelope, period_id="period-1")
    assert result["duplicate"] is True
    assert retry.short_circuited
    assert len(journal.snapshots(fh)) == 1
    assert len(journal.registered_runs(fh)) == 1
    assert journal.verify_chain(fh) == []


# ── K2: interrupted-and-resumed == uninterrupted (byte-identical) ──────


def _uninterrupted_envelope(case_id: str, tmp_path, monkeypatch) -> bytes:
    """Baseline: a full run in its own journal + fake DB."""
    root = tmp_path / "journal-baseline"
    monkeypatch.setenv(_hooks.ENV_VAR, str(root))
    _hooks.reset_cache()
    doc, parsed = load_case(case_id)
    with fake_persist_seam() as fake:
        _hooks.on_run_started(doc, industry=None)
        _hooks.on_frontend_done(doc, parsed)
        assembled = _pipeline.stage_map(doc, copy.deepcopy(parsed), None)
        _hooks.on_pass_done(doc, assembled)
        _pipeline.stage_persist(doc, copy.deepcopy(parsed), assembled)
        baseline = norm_dump(fake.envelope())
    _hooks.set_active_run(None)
    return baseline


def test_k2_crash_after_pass_done_resumes_byte_identical(tmp_path, monkeypatch):
    baseline = _uninterrupted_envelope("csv", tmp_path, monkeypatch)

    # Interrupted run: crash right after the assemble boundary — the
    # process dies before stage_persist.
    root = tmp_path / "journal-interrupted"
    monkeypatch.setenv(_hooks.ENV_VAR, str(root))
    _hooks.reset_cache()
    doc, parsed = load_case("csv")
    _hooks.on_run_started(doc, industry=None)
    _hooks.on_frontend_done(doc, parsed)
    assembled = _pipeline.stage_map(doc, copy.deepcopy(parsed), None)
    _hooks.on_pass_done(doc, assembled)
    _hooks.set_active_run(None)  # process death
    _hooks.reset_cache()

    journal = Journal(root)
    fh = doc["content_hash"]
    runs = journal.registered_runs(fh)
    assert len(runs) == 1
    crashed_run_id = str(runs[0]["run_id"])
    assert journal.snapshots(fh) == []  # crashed before the snapshot

    with fake_persist_seam() as fake:
        result = resume_run(journal, crashed_run_id)
        resumed = norm_dump(fake.envelope())

    assert result["status"] == "resumed"
    assert result["period_id"] == "period-1"
    assert resumed == baseline  # BYTE-identical (volatile-normalized)
    assert len(journal.snapshots(fh)) == 1
    assert journal.verify_chain(fh) == []
    kinds = [e["run_kind"] for e in journal.registered_runs(fh)]
    assert kinds == ["pipeline", "resume"]


def test_k2_crash_after_frontend_done_resumes_byte_identical(tmp_path, monkeypatch):
    baseline = _uninterrupted_envelope("csv", tmp_path, monkeypatch)

    root = tmp_path / "journal-interrupted-fe"
    monkeypatch.setenv(_hooks.ENV_VAR, str(root))
    _hooks.reset_cache()
    doc, parsed = load_case("csv")
    _hooks.on_run_started(doc, industry=None)
    _hooks.on_frontend_done(doc, parsed)
    _hooks.set_active_run(None)  # process death before stage_map
    _hooks.reset_cache()

    journal = Journal(root)
    fh = doc["content_hash"]
    crashed_run_id = str(journal.registered_runs(fh)[0]["run_id"])

    with fake_persist_seam() as fake:
        result = resume_run(journal, crashed_run_id)
        resumed = norm_dump(fake.envelope())

    assert result["status"] == "resumed"
    assert resumed == baseline
    # The resume run re-ran the assemble stage and recorded PASS_DONE +
    # the snapshot on its own chain segment.
    resume_events = journal.read_run(str(result["resume_run_id"]))
    types = [e["type"] for e in resume_events]
    assert "PASS_DONE" in types and "SNAPSHOT_PERSISTED" in types
    assert journal.verify_chain(fh) == []


def test_resume_refuses_before_frontend_checkpoint(journal_dir):
    journal = Journal(journal_dir)
    doc, _parsed = load_case("csv")
    _hooks.on_run_started(doc, industry=None)
    run_id = _hooks.active_run().run_id
    _hooks.set_active_run(None)
    with pytest.raises(ResumeRefused) as exc_info:
        resume_run(journal, run_id)
    assert exc_info.value.reason == "cannot_resume"


def test_resume_refuses_when_checkpoint_object_gone(journal_dir):
    journal = Journal(journal_dir)
    doc, parsed = load_case("csv")
    _hooks.on_run_started(doc, industry=None)
    _hooks.on_frontend_done(doc, parsed)
    handle = _hooks.active_run()
    run_id = handle.run_id
    _hooks.set_active_run(None)

    events = journal.read_run(run_id)
    ir_hash = [e for e in events if e["type"] == "FRONTEND_DONE"][0]["payload"]["ir_hash"]
    # Storage fault: the checkpoint object vanishes.
    (journal.store._path_for(ir_hash)).unlink()

    with pytest.raises(ResumeRefused) as exc_info:
        resume_run(journal, run_id)
    assert exc_info.value.reason == "object_unavailable"


def test_resume_missing_run_refused(journal_dir):
    journal = Journal(journal_dir)
    with pytest.raises(ResumeRefused) as exc_info:
        resume_run(journal, "no-such-run")
    assert exc_info.value.reason == "run_not_found"


# ── DLQ lifecycle: fail → list (NOTICE) → replay after fix → resolved ──


def test_dlq_fail_list_replay_resolve(journal_dir, capsys):
    journal = Journal(journal_dir)
    doc, parsed = load_case("csv")

    # A run that dies after extraction (e.g. the mapper raised).
    _hooks.on_run_started(doc, industry=None)
    _hooks.on_frontend_done(doc, parsed)
    _hooks.on_run_failed(doc["id"], RuntimeError("mapper exploded"))

    fh = doc["content_hash"]
    events = journal.chain_events(fh)
    assert events[-1]["type"] == "RUN_FAILED"
    assert events[-1]["payload"]["error_type"] == "RuntimeError"
    assert events[-1]["payload"]["stage"] == "map"
    assert _hooks.active_run() is None  # context cleared on failure

    entries = journal.dlq_entries()
    assert len(entries) == 1
    entry = entries[0]
    assert entry["reason_type"] == "RuntimeError"
    assert entry["document_id"] == doc["id"]
    assert entry["failing_event"]["type"] == "RUN_FAILED"
    assert journal.dlq_depth() == 1

    # The battery NOTICE reflects the depth (non-blocking, exit 0).
    import sys as _sys

    scripts = REPO / "scripts"
    if str(scripts) not in _sys.path:
        _sys.path.insert(0, str(scripts))
    import journal_cli as cli

    assert cli.main(["--journal-root", str(journal_dir), "dlq", "list"]) == 0
    out = capsys.readouterr().out
    assert "NOTICE  journal: DLQ depth 1" in out

    # Replay after the fix: re-invokes the recorded stage entry points.
    run_id = str(entry["run_id"])
    with fake_persist_seam() as fake:
        result = replay_dlq(journal, run_id)
        assert result["status"] == "resumed"
        assert fake.envelope()

    # The dead letter is resolved — moved, never deleted.
    assert journal.dlq_depth() == 0
    assert (journal_dir / "dlq" / "resolved" / ("%s.json" % run_id)).is_file()
    assert journal.verify_chain(fh) == []

    # Replaying a run that is not in the DLQ is refused honestly.
    with pytest.raises(ResumeRefused) as exc_info:
        replay_dlq(journal, run_id)
    assert exc_info.value.reason == "not_in_dlq"


def test_dlq_resolved_by_later_successful_run(journal_dir):
    journal = Journal(journal_dir)
    doc, parsed = load_case("csv")
    _hooks.on_run_started(doc, industry=None)
    _hooks.on_frontend_done(doc, parsed)
    _hooks.on_run_failed(doc["id"], RuntimeError("transient"))
    assert journal.dlq_depth() == 1

    # The user retries the scan; the successful snapshot resolves the
    # document's dead letters.
    with fake_persist_seam():
        _hooks.on_run_started(doc, industry=None)
        _hooks.on_frontend_done(doc, parsed)
        assembled = _pipeline.stage_map(doc, copy.deepcopy(parsed), None)
        _hooks.on_pass_done(doc, assembled)
        _pipeline.stage_persist(doc, copy.deepcopy(parsed), assembled)
    _hooks.set_active_run(None)

    assert journal.dlq_depth() == 0
    resolved = list((journal_dir / "dlq" / "resolved").glob("*.json"))
    assert len(resolved) == 1


# ── events module edge: unknown types rejected loudly ──────────────────


def test_unknown_event_type_rejected(journal_dir):
    journal = Journal(journal_dir)
    handle = journal.begin_run(
        file_hash="sha256-x", document_id=None, engine_version="test",
        run_kind="adhoc",
    )
    with pytest.raises(ValueError):
        handle.emit("TOTALLY_NEW_EVENT", {})
