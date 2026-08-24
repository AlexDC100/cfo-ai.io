"""DST fault registry — one typed scenario per fault class, each
asserting its K-invariants against the fault-free baseline.

Every scenario drives the REAL composition through ``harness`` (the same
code objects scripts/corpus_replay.py replays) and injects its fault
ONLY through seams that already exist:

    kill_between_stages        SimulatedKill at a stage boundary +
                               engine.journal.resume (K1)
    kill_inside_snapshot_commit RunHandle.record_snapshot's crash_after
                               DI seam, exercised THROUGH stage_persist
    disk_full_snapshot_write   journal.store.write_object → ENOSPC
                               (temp debris left, never a half-object)
    torn_write                 post-hoc truncation of a committed
                               object AT REST (see GAPS: a torn write
                               in flight is structurally impossible —
                               tempfile + os.replace)
    journal_append_failure     Journal._append_line → OSError
    duplicate_delivery         the same content bytes + document row
                               delivered twice (K3)
    clock_skew                 Journal(clock=...) — frozen and
                               backward-jumping journal clocks
    ai_timeout / ai_malformed_json / ai_malformed_recovers /
    ai_slow_response           the HU lane's injectable client_factory
    db_error_mid_persist       FaultableAdmin raising on a targeted
                               write inside the REAL stage_persist
    crash_during_undo          the undo envelope write raising
                               mid-flight (perform_undo is pure; the
                               single DB write is the commit point)
    suppression_survives_kill  kill + resume of the persist that
                               carries an undo suppression forward

K-invariants (task contract):
    K1  kill-and-resume == uninterrupted: byte-identical envelope under
        the volatile-key normalization; no duplicate reconciliation
        adjustments; suppression entries intact.
    K2  no partial snapshot is ever servable: a torn / missing object
        is refused by every journal read path, and the chain shows the
        incomplete state honestly; the DB envelope (serving truth) is
        never a partial write.
    K3  duplicate delivery → exactly one snapshot + one chain + one
        period row; what cannot complete lands in the DLQ with a typed
        reason and is resolved by the first later success.

Faults that CANNOT be injected through an existing seam are DOCUMENTED
GAPS (``GAPS`` below) — surfaced by scripts/dst_explore.py on every
run, never a silent skip.
"""
from __future__ import annotations

import errno
import os
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from engine.api import _reconcile
from engine.journal import Journal, ResumeRefused, replay_dlq, resume_run
from engine.journal.events import content_hash, normalized_hash
from engine.journal.journal import (
    CRASH_AFTER_EVENT_APPEND,
    CRASH_AFTER_OBJECT_WRITE,
    RunHandle,
)

from .harness import (
    BOUNDARIES,
    FIXTURES,
    FaultableAdmin,
    FaultyLaneClient,
    InvariantViolation,
    Patcher,
    SimulatedKill,
    admin_seam,
    baseline_for,
    check,
    envelope_write_predicate,
    every_snapshot_object_present,
    hu_mock_responses,
    journal_env,
    norm_bytes,
    norm_without_audit,
    resume_latest,
    run_fixture,
    run_hu_lane,
)

#: Kill points for the process-kill fault: the three between-stage
#: boundaries plus the post-persist point (kill after the envelope
#: landed — resume must short-circuit as a duplicate, K3).
KILL_POINTS: Tuple[str, ...] = BOUNDARIES + ("persist_done",)

#: Store-fault arm points: run_start breaks the very first object write
#: (the doc object inside on_run_started); frontend_done breaks the
#: assembled-checkpoint write; pass_done breaks the snapshot write
#: inside stage_persist.
STORE_ARM_POINTS: Tuple[str, ...] = ("run_start", "frontend_done", "pass_done")

#: db_error_mid_persist targets — self-describing write predicates
#: instead of brittle Nth-write counting.
DB_WRITE_TARGETS: Tuple[str, ...] = (
    "period_insert",
    "documents_update",
    "line_items_wipe",
    "line_items_insert",
    "envelope_write",
)

#: The db-error targets whose failure is FATAL to the run (unguarded
#: writes inside stage_persist). ``envelope_write`` is deliberately
#: non-fatal in production (best-effort JSONB persist) and has its own
#: assertions.
DB_FATAL_TARGETS = (
    "period_insert",
    "documents_update",
    "line_items_wipe",
    "line_items_insert",
)

AI_STAGES: Tuple[str, ...] = FaultyLaneClient.STAGES  # format_detect/extract/classify

_UTC = timezone.utc


class _Enospc(OSError):
    def __init__(self, message: str) -> None:
        super().__init__(errno.ENOSPC, message)


def _kill_at(boundary: str) -> Callable[[str], None]:
    def _cb(name: str) -> None:
        if name == boundary:
            raise SimulatedKill("process killed at boundary %r" % boundary)

    return _cb


def _receipt(envelope: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    value = envelope.get("reconciliation") if isinstance(envelope, dict) else None
    return value if isinstance(value, dict) else None


def _history(envelope: Dict[str, Any]) -> List[Any]:
    return list(envelope.get("reconciliation_history") or [])


def _suppressed(envelope: Dict[str, Any]) -> List[Any]:
    return list(envelope.get("reconciliation_suppressed") or [])


def _expect_no_ai(result: Any, fixture_name: str) -> None:
    """Deterministic corpus fixtures pin expect_ai_never_consulted."""
    if FIXTURES[fixture_name].lane == "deterministic":
        check(
            result.ai_propose_calls == 0,
            "AI proposal path consulted %d time(s) on deterministic fixture %s"
            % (result.ai_propose_calls, fixture_name),
        )


# ── F1: process kill between stages → journal resume (K1) ──────────────


def scenario_kill_between_stages(
    fixture_name: str, boundary: str, scratch: Path
) -> Dict[str, Any]:
    """Kill the run at ``boundary``; recover through the REAL resume
    machinery (or, where recovery is honestly impossible, through a
    typed refusal + fresh delivery). K1: the recovered envelope is
    byte-identical to the uninterrupted baseline, reconciliation
    adjustments are not duplicated, exactly one snapshot exists and the
    chain verifies."""
    baseline = baseline_for(fixture_name)
    fixture = FIXTURES[fixture_name]
    admin = FaultableAdmin()
    root = scratch / "kill-journal"
    summary: Dict[str, Any] = {"boundary": boundary}

    with journal_env(root) as journal:
        result = run_fixture(fixture, admin=admin, at_boundary=_kill_at(boundary))
        check(result.outcome == "killed", "kill did not take at %s" % boundary)
        _expect_no_ai(result, fixture_name)
        file_hash = result.file_hash
        assert journal is not None

        if boundary != "persist_done":
            check(
                admin.envelope() is None,
                "K2: a run killed before persist_done must not have "
                "flipped serving",
            )

        if boundary == "run_started":
            # Crash before extraction was checkpointed: resume must
            # REFUSE with the typed reason — re-extraction needs the
            # original bytes; faking it would violate the honesty rule.
            try:
                resume_latest(journal, file_hash, admin)
            except ResumeRefused as refused:
                check(
                    refused.reason == "cannot_resume",
                    "expected cannot_resume, got %r" % refused.reason,
                )
                summary["resume"] = "refused:%s" % refused.reason
            else:
                raise InvariantViolation(
                    "resume before FRONTEND_DONE must refuse, not fabricate"
                )
            # Recovery for this boundary is a fresh delivery.
            second = run_fixture(fixture, admin=admin)
            check(second.outcome == "completed", "fresh delivery failed")
        else:
            resumed = resume_latest(journal, file_hash, admin)
            check(resumed["status"] == "resumed", "resume did not complete")
            summary["resume"] = (
                "short_circuited" if resumed["short_circuited"] else "resumed"
            )

        envelope = admin.envelope()
        check(isinstance(envelope, dict), "no envelope after recovery")
        check(
            norm_bytes(envelope) == baseline.norm,
            "K1: recovered envelope differs from the uninterrupted baseline",
        )
        check(
            len(_history(envelope)) == baseline.history_len,
            "K1: reconciliation history grew across kill+resume "
            "(duplicate adjustments)",
        )
        check(
            (_receipt(envelope) is not None) == baseline.has_receipt,
            "K1: reconciliation receipt presence changed across kill+resume",
        )
        check(
            len(journal.snapshots(file_hash)) == 1,
            "K1/K3: expected exactly one snapshot after recovery",
        )
        check(journal.verify_chain(file_hash) == [], "chain verification failed")
        check(
            every_snapshot_object_present(journal, file_hash),
            "K2: snapshot event without a verifiable object",
        )
    return summary


# ── F2: crash INSIDE the snapshot commit (ordering rule, composed) ─────


def scenario_kill_inside_snapshot_commit(
    fixture_name: str, position: str, scratch: Path
) -> Dict[str, Any]:
    """Exercise the journal writer's ``crash_after`` DI seam THROUGH the
    real ``stage_persist`` (the hook swallows the crash — hooks never
    raise — so the pipeline completes and the journal is left in the
    mid-commit state a process death would leave):

      object_write  → object present, NO event: invisible garbage,
                      listed by the collector, chain still verifies.
      event_append  → object + event both present: the chain is already
                      complete (the best-effort index/DLQ step after the
                      crash point is derivable, not load-bearing).

    Both directions heal: a re-delivery leaves exactly one snapshot.
    """
    check(
        position in (CRASH_AFTER_OBJECT_WRITE, CRASH_AFTER_EVENT_APPEND),
        "unknown crash position %r" % position,
    )
    baseline = baseline_for(fixture_name)
    fixture = FIXTURES[fixture_name]
    admin = FaultableAdmin()
    root = scratch / "commit-crash"
    original = RunHandle.record_snapshot
    summary: Dict[str, Any] = {"position": position}

    with journal_env(root) as journal:
        assert journal is not None

        def _crashing(self, envelope, **kwargs):  # type: ignore[no-untyped-def]
            if kwargs.get("origin", "pipeline") == "pipeline":
                kwargs = dict(kwargs)
                kwargs["crash_after"] = position
            return original(self, envelope, **kwargs)

        with Patcher() as patcher:
            patcher.setattr(RunHandle, "record_snapshot", _crashing)
            result = run_fixture(fixture, admin=admin)
        check(
            result.outcome == "completed",
            "hooks must swallow a journal crash (pipeline unaffected)",
        )
        _expect_no_ai(result, fixture_name)
        file_hash = result.file_hash
        envelope = admin.envelope()
        check(
            norm_bytes(envelope) == baseline.norm,
            "journal mid-commit crash leaked into the pipeline result",
        )
        # The snapshot object's content address (the persisted envelope's
        # canonical bytes). NOTE: gc_orphans lists CHECKPOINT objects
        # (doc/parsed/assembled — referenced by non-snapshot events) as
        # collectable too, so orphan assertions are digest-specific.
        envelope_digest, _lossy = content_hash(envelope)

        snaps = journal.snapshots(file_hash)
        report = journal.gc_orphans()
        if position == CRASH_AFTER_OBJECT_WRITE:
            check(len(snaps) == 0, "event committed despite object-write crash")
            check(journal.store.has(envelope_digest), "crashed object must exist")
            check(
                envelope_digest in report["orphans"],
                "the crashed snapshot object must be listed as collectable",
            )
        else:
            check(len(snaps) == 1, "event lost despite event-append crash")
            check(
                envelope_digest not in report["orphans"],
                "a committed snapshot's object must never be collectable",
            )
            check(
                every_snapshot_object_present(journal, file_hash),
                "K2: committed event must reference a verifiable object",
            )
        check(journal.verify_chain(file_hash) == [], "chain verification failed")

        # Heal: re-delivery (crash seam removed) → exactly one snapshot
        # whose OWN object is referenced (the crashed run's object may
        # remain as honest, collectable debris — exact bytes differ by
        # volatile write stamps, so the heal content-addresses anew).
        second = run_fixture(fixture, admin=admin)
        check(second.outcome == "completed", "healing re-delivery failed")
        check(
            len(journal.snapshots(file_hash)) == 1,
            "K3: heal must leave exactly one snapshot",
        )
        healed_digest, _lossy = content_hash(admin.envelope())
        check(
            healed_digest not in journal.gc_orphans()["orphans"],
            "the healed snapshot's object must not be collectable",
        )
        check(
            every_snapshot_object_present(journal, file_hash),
            "K2: healed chain must reference a verifiable object",
        )
        check(journal.verify_chain(file_hash) == [], "chain broken after heal")
        check(norm_bytes(admin.envelope()) == baseline.norm, "healed envelope differs")
    return summary


# ── F3: disk full on the object store (K2's journal half) ──────────────


def scenario_disk_full_snapshot_write(
    fixture_name: str, arm_point: str, scratch: Path
) -> Dict[str, Any]:
    """From ``arm_point`` on, every object-store write raises ENOSPC
    after leaving a temp file behind (the fs filling up mid-write). The
    pipeline result must be untouched (hooks swallow); the chain shows
    the incomplete state honestly; no half-written object ever exists
    at a valid address — only collectable ``.tmp-*`` debris."""
    baseline = baseline_for(fixture_name)
    fixture = FIXTURES[fixture_name]
    admin = FaultableAdmin()
    root = scratch / "enospc-journal"
    patcher = Patcher()
    summary: Dict[str, Any] = {"arm_point": arm_point}

    with journal_env(root) as journal:
        assert journal is not None
        store = journal.store

        def _enospc_write(data: bytes) -> str:
            # Simulate the fs dying mid-write: temp file lands, final
            # object never does.
            shard = store.objects_dir / "00"
            shard.mkdir(parents=True, exist_ok=True)
            fd, _tmp = tempfile.mkstemp(prefix=".tmp-dst-", dir=str(shard))
            os.close(fd)
            raise _Enospc("simulated ENOSPC on snapshot write")

        def _arm(name: str) -> None:
            if name == arm_point:
                patcher.setattr(store, "write_object", _enospc_write)

        try:
            if arm_point == "run_start":
                patcher.setattr(store, "write_object", _enospc_write)
                result = run_fixture(fixture, admin=admin)
            else:
                result = run_fixture(fixture, admin=admin, at_boundary=_arm)
        finally:
            patcher.undo()

        check(result.outcome == "completed", "ENOSPC must never fail the pipeline")
        _expect_no_ai(result, fixture_name)
        envelope = admin.envelope()
        check(
            norm_bytes(envelope) == baseline.norm,
            "journal ENOSPC leaked into the pipeline result",
        )
        file_hash = result.file_hash
        check(
            journal.snapshots(file_hash) == [],
            "K2: no snapshot event may commit when its object cannot land",
        )
        check(journal.verify_chain(file_hash) in ([], [
            "no runs registered for chain %s" % file_hash
        ]), "chain must be honestly empty or verifiably incomplete")
        # No object at a valid address; only temp debris is collectable.
        check(
            list(journal.store.iter_digests()) == []
            or arm_point != "run_start",
            "run_start arm must leave zero committed objects",
        )
        report = journal.gc_orphans()
        check(len(report["temp_files"]) >= 1, "expected ENOSPC temp debris")
        for tmp in report["temp_files"]:
            check(".tmp-" in Path(tmp).name, "unexpected debris name %r" % tmp)
        summary["temp_debris"] = len(report["temp_files"])
    return summary


# ── F4: torn write (object corrupted AT REST) ──────────────────────────


def scenario_torn_write(
    fixture_name: str, _boundary: str, scratch: Path
) -> Dict[str, Any]:
    """Truncate the committed snapshot object mid-content. K2: every
    journal read path refuses the partial object (content
    re-verification), the chain reports the corruption honestly, and
    serving — whose truth is the DB envelope — still serves the intact
    baseline."""
    baseline = baseline_for(fixture_name)
    fixture = FIXTURES[fixture_name]
    admin = FaultableAdmin()
    root = scratch / "torn-journal"

    with journal_env(root) as journal:
        assert journal is not None
        result = run_fixture(fixture, admin=admin)
        check(result.outcome == "completed", "setup run failed")
        file_hash = result.file_hash
        snaps = journal.snapshots(file_hash)
        check(len(snaps) == 1, "setup expected one snapshot")
        digest = str((snaps[0].get("payload") or {}).get("content_hash"))
        path = journal.store._path_for(digest)
        data = path.read_bytes()
        check(len(data) > 2, "object too small to tear")
        path.write_bytes(data[: len(data) // 2])  # the torn write, at rest

        # Read path refuses the partial object.
        try:
            journal.store.read_object(digest)
        except ValueError:
            pass
        else:
            raise InvariantViolation(
                "K2: store.read_object served a torn object"
            )
        check(
            not every_snapshot_object_present(journal, file_hash),
            "K2: torn object counted as present",
        )
        errors = journal.verify_chain(file_hash)
        check(
            any("corrupt" in e for e in errors),
            "verify_chain did not report the torn object: %r" % errors,
        )
        # As-of refuses to serve it and says so, in-band.
        asof = journal.asof(file_hash, datetime.now(_UTC).isoformat())
        check(isinstance(asof, dict), "asof returned nothing")
        check(
            "error" in asof and "assembled_canonical_v1" not in asof,
            "K2: asof served a torn snapshot",
        )
        # Serving truth (the DB envelope) is unaffected.
        check(
            norm_bytes(admin.envelope()) == baseline.norm,
            "serving envelope affected by journal-side corruption",
        )
    return {"digest": digest, "verify_errors": len(errors)}


# ── F5: journal append failure ─────────────────────────────────────────


def scenario_journal_append_failure(
    fixture_name: str, arm_point: str, scratch: Path
) -> Dict[str, Any]:
    """From ``arm_point`` on, every journal line append raises. The
    pipeline result must be identical (hooks swallow); the chain is
    honestly shorter; an object written before its event append failed
    is collectable garbage; a later healthy delivery heals to exactly
    one committed snapshot."""
    baseline = baseline_for(fixture_name)
    fixture = FIXTURES[fixture_name]
    admin = FaultableAdmin()
    root = scratch / "append-journal"
    patcher = Patcher()
    summary: Dict[str, Any] = {"arm_point": arm_point}

    with journal_env(root) as journal:
        assert journal is not None

        def _failing_append(path: Path, obj: Dict[str, Any]) -> None:
            raise OSError("simulated journal append failure")

        def _arm(name: str) -> None:
            if name == arm_point:
                patcher.setattr(journal, "_append_line", _failing_append)

        try:
            if arm_point == "run_start":
                patcher.setattr(journal, "_append_line", _failing_append)
                result = run_fixture(fixture, admin=admin)
            else:
                result = run_fixture(fixture, admin=admin, at_boundary=_arm)
        finally:
            patcher.undo()

        check(result.outcome == "completed", "append failure must not fail the run")
        _expect_no_ai(result, fixture_name)
        check(
            norm_bytes(admin.envelope()) == baseline.norm,
            "append failure leaked into the pipeline result",
        )
        file_hash = result.file_hash
        envelope_digest, _lossy = content_hash(admin.envelope())
        if arm_point == "run_start":
            check(
                journal.registered_runs(file_hash) == [],
                "nothing may register when the very first append fails",
            )
        else:
            # Chain committed up to the arm point; the snapshot event's
            # append failed AFTER its object landed → the object is
            # collectable garbage until a later event references it.
            check(
                journal.snapshots(file_hash) == [],
                "snapshot event committed despite append failure",
            )
            check(journal.verify_chain(file_hash) == [], "partial chain must verify")
            check(
                envelope_digest in journal.gc_orphans()["orphans"],
                "expected the snapshot object as a collectable orphan",
            )

        # Heal: healthy delivery commits the missing pieces. The crashed
        # run's object may remain as collectable debris (exact bytes
        # differ by volatile write stamps); the healed snapshot's own
        # object must be referenced.
        second = run_fixture(fixture, admin=admin)
        check(second.outcome == "completed", "healing delivery failed")
        check(
            len(journal.snapshots(file_hash)) == 1,
            "heal must leave exactly one committed snapshot",
        )
        check(journal.verify_chain(file_hash) == [], "chain broken after heal")
        healed_digest, _lossy = content_hash(admin.envelope())
        check(
            healed_digest not in journal.gc_orphans()["orphans"],
            "the healed snapshot's object must not be collectable",
        )
        check(norm_bytes(admin.envelope()) == baseline.norm, "healed envelope differs")
    return summary


# ── F6: duplicate delivery (K3) ────────────────────────────────────────


def scenario_duplicate_delivery(
    fixture_name: str, _boundary: str, scratch: Path
) -> Dict[str, Any]:
    """The same content bytes + document row delivered twice. K3:
    exactly one chain, one snapshot, one period row; the envelope is
    byte-identical to the single-delivery baseline; nothing
    dead-letters. (Same bytes under a DIFFERENT document row is a NEW
    provenance era by design — see GAPS notes.)"""
    baseline = baseline_for(fixture_name)
    fixture = FIXTURES[fixture_name]
    admin = FaultableAdmin()
    root = scratch / "dup-journal"

    with journal_env(root) as journal:
        assert journal is not None
        first = run_fixture(fixture, admin=admin)
        check(first.outcome == "completed", "first delivery failed")
        second = run_fixture(fixture, admin=admin)
        check(second.outcome == "completed", "second delivery failed")
        _expect_no_ai(first, fixture_name)
        _expect_no_ai(second, fixture_name)
        file_hash = first.file_hash
        check(second.file_hash == file_hash, "content hash must be identical")

        check(
            len(journal.registered_runs(file_hash)) == 1,
            "K3: duplicate delivery registered a second run",
        )
        check(
            len(journal.snapshots(file_hash)) == 1,
            "K3: duplicate delivery committed a second snapshot",
        )
        check(journal.verify_chain(file_hash) == [], "chain verification failed")
        check(
            len(admin.period_rows) == 1,
            "K3: duplicate delivery minted a second period row",
        )
        check(
            norm_bytes(admin.envelope()) == baseline.norm,
            "duplicate delivery changed the served envelope",
        )
        check(journal.dlq_depth() == 0, "duplicate delivery dead-lettered")
        check(
            len(_history(admin.envelope())) == baseline.history_len,
            "K1/K3: duplicate delivery duplicated reconciliation history",
        )
    return {"period_rows": len(admin.period_rows)}


# ── F7: clock skew (the journal's injectable clock) ────────────────────


def scenario_clock_skew(
    fixture_name: str, mode: str, scratch: Path
) -> Dict[str, Any]:
    """``frozen``: every journal event carries the same timestamp — the
    chain and as-of must rely on structural order, never on time
    monotonicity. ``backward``: the clock jumps an hour BACK between two
    deliveries of the same bytes under different document rows (a new
    provenance era by design) — the structurally-last snapshot must
    still win an as-of at a later instant, and the chain must verify
    despite genuinely non-monotonic stamps."""
    baseline = baseline_for(fixture_name)
    fixture = FIXTURES[fixture_name]
    admin = FaultableAdmin()
    root = scratch / ("clock-%s" % mode)
    t0 = datetime(2026, 1, 15, 12, 0, 0, tzinfo=_UTC)
    now_holder = [t0]

    with journal_env(root, clock=lambda: now_holder[0]) as journal:
        assert journal is not None
        result = run_fixture(fixture, admin=admin)
        check(result.outcome == "completed", "setup run failed")
        file_hash = result.file_hash
        check(
            norm_bytes(admin.envelope()) == baseline.norm,
            "journal clock leaked into the pipeline result",
        )

        if mode == "frozen":
            stamps = {e.get("ts") for e in journal.chain_events(file_hash)}
            check(
                stamps == {t0.isoformat()},
                "frozen clock produced mixed stamps: %r" % stamps,
            )
            check(journal.verify_chain(file_hash) == [], "chain broke under frozen clock")
            asof = journal.asof(file_hash, t0.isoformat())
            check(
                isinstance(asof, dict) and "assembled_canonical_v1" in asof,
                "asof at the frozen instant must serve the snapshot "
                "(structural order breaks the tie)",
            )
            return {"stamps": len(stamps)}

        check(mode == "backward", "unknown clock mode %r" % mode)
        # The clock jumps BACK an hour, then the same bytes arrive under
        # a different document row — a new provenance era whose events
        # are stamped EARLIER than the era they succeed.
        now_holder[0] = t0 - timedelta(hours=1)
        second = run_fixture(
            fixture, admin=admin, doc_id="doc-dst-%s-redelivered" % fixture_name
        )
        check(second.outcome == "completed", "second-era run failed")
        check(second.file_hash == file_hash, "content hash must be identical")
        check(journal.verify_chain(file_hash) == [], "chain broke under backward clock")
        snaps = journal.snapshots(file_hash)
        check(len(snaps) == 2, "expected two provenance eras on the chain")
        check(
            str(snaps[0].get("ts")) > str(snaps[1].get("ts")),
            "scenario must actually produce non-monotonic stamps",
        )
        # As-of at a later instant returns the STRUCTURALLY last state,
        # not the latest wall-clock stamp.
        asof = journal.asof(file_hash, (t0 + timedelta(hours=2)).isoformat())
        check(isinstance(asof, dict) and "assembled_canonical_v1" in asof, "asof failed")
        check(
            asof["snapshot"]["normalized_hash"] == normalized_hash(admin.envelope()),
            "as-of under backward skew served a stale era",
        )
        check(
            asof["snapshot"]["snapshot_id"]
            == (snaps[-1].get("payload") or {}).get("snapshot_id"),
            "as-of must pick the structurally-last snapshot",
        )
    return {"snapshots": 2}


# ── F8: AI client faults (the lane's injectable client_factory) ────────


def _hu_fault_run(
    scratch: Path,
    modes: Dict[int, str],
    delay_s: float = 0.0,
) -> Tuple[Any, FaultableAdmin, Optional[Journal], Path]:
    fixture = FIXTURES["hu_ai_lane"]
    client = FaultyLaneClient(hu_mock_responses(fixture), modes=modes, delay_s=delay_s)
    admin = FaultableAdmin()
    root = scratch / "hu-journal"
    with journal_env(root) as journal:
        result = run_hu_lane(fixture, admin=admin, client=client)
    return result, admin, Journal(root), root


def _assert_dead_letter_and_heal(
    scratch: Path, result: Any, admin: FaultableAdmin, journal: Journal, root: Path
) -> Dict[str, Any]:
    """Shared tail for the fatal AI faults: typed DLQ entry, honest
    resume refusal, and a healthy re-delivery that heals + resolves."""
    baseline = baseline_for("hu_ai_lane")
    fixture = FIXTURES["hu_ai_lane"]
    check(result.outcome == "failed", "fault did not fail the run")
    check(result.error_type == "AiLaneError", "expected AiLaneError, got %r" % result.error_type)
    check(admin.envelope() is None, "failed lane run must persist nothing")
    file_hash = result.file_hash

    entries = journal.dlq_entries()
    check(len(entries) == 1, "expected exactly one dead letter")
    entry = entries[0]
    check(
        entry["reason_type"] == "AiLaneError",
        "DLQ reason_type %r is not the typed lane error" % entry.get("reason_type"),
    )
    check(entry["stage"] == "extract", "lane failure must dead-letter at extract")

    # The dead letter honestly cannot be replayed — extraction was never
    # checkpointed and the model call is not re-runnable from disk.
    with journal_env(root):
        with admin_seam(admin):
            try:
                replay_dlq(journal, str(entry["run_id"]))
            except ResumeRefused as refused:
                check(
                    refused.reason == "cannot_resume",
                    "expected cannot_resume, got %r" % refused.reason,
                )
            else:
                raise InvariantViolation("DLQ replay fabricated an AI extraction")

    # Heal: a healthy delivery completes byte-identical and RESOLVES the
    # dead letter (moved to dlq/resolved/, never deleted).
    with journal_env(root):
        healthy = run_fixture(fixture, admin=admin)
    check(healthy.outcome == "completed", "healthy re-delivery failed")
    check(
        norm_bytes(admin.envelope()) == baseline.norm,
        "healed envelope differs from baseline",
    )
    check(journal.dlq_depth() == 0, "dead letter not resolved by the success")
    resolved = list((root / "dlq" / "resolved").glob("*.json"))
    check(len(resolved) == 1, "resolved dead letter must be archived, not deleted")
    check(journal.verify_chain(file_hash) == [], "chain verification failed")
    check(len(journal.snapshots(file_hash)) == 1, "expected exactly one snapshot")
    return {"dlq_reason": entry["reason_type"], "resolved": len(resolved)}


def scenario_ai_timeout(_fixture: str, stage: str, scratch: Path) -> Dict[str, Any]:
    """Model transport timeout at ``stage`` → immediate typed AiLaneError
    (the lane never retries transport faults), nothing persisted, a
    typed dead letter, honest replay refusal, heal on re-delivery."""
    idx = AI_STAGES.index(stage)
    result, admin, journal, root = _hu_fault_run(scratch, {idx: "timeout"})
    check(
        "timeout" in (result.error_message or "").lower(),
        "error message must carry the transport cause",
    )
    summary = _assert_dead_letter_and_heal(scratch, result, admin, journal, root)
    summary["stage"] = stage
    return summary


def scenario_ai_malformed_json(_fixture: str, stage: str, scratch: Path) -> Dict[str, Any]:
    """Malformed JSON on BOTH attempts at ``stage`` → the lane's single
    retry is exhausted → typed AiLaneError + dead letter; the audit
    contract (one entry per attempt) is proven by the recovering
    variant below."""
    idx = AI_STAGES.index(stage)
    fixture = FIXTURES["hu_ai_lane"]
    client = FaultyLaneClient(hu_mock_responses(fixture), modes={idx: "malformed"})
    admin = FaultableAdmin()
    root = scratch / "hu-journal"
    with journal_env(root) as journal:
        result = run_hu_lane(fixture, admin=admin, client=client)
        assert journal is not None
    check(
        client.total_calls == idx + 2,
        "the lane must retry malformed JSON exactly once (saw %d calls)"
        % client.total_calls,
    )
    check(
        "malformed" in (result.error_message or "").lower(),
        "error message must name the malformed-JSON cause",
    )
    summary = _assert_dead_letter_and_heal(scratch, result, admin, Journal(root), root)
    summary["stage"] = stage
    return summary


def scenario_ai_malformed_recovers(
    _fixture: str, stage: str, scratch: Path
) -> Dict[str, Any]:
    """Malformed JSON on the FIRST attempt only: the retry succeeds, the
    run completes, and the envelope is byte-identical to baseline
    everywhere EXCEPT the audit trail, which HONESTLY records the extra
    attempt."""
    baseline = baseline_for("hu_ai_lane")
    idx = AI_STAGES.index(stage)
    fixture = FIXTURES["hu_ai_lane"]
    client = FaultyLaneClient(hu_mock_responses(fixture), modes={idx: "malformed_once"})
    admin = FaultableAdmin()
    root = scratch / "hu-journal"
    with journal_env(root) as journal:
        result = run_hu_lane(fixture, admin=admin, client=client)
        assert journal is not None
        check(result.outcome == "completed", "recovering retry did not complete")
        envelope = admin.envelope()
        check(
            norm_without_audit(envelope) == norm_without_audit(baseline.envelope),
            "recovered run differs from baseline outside the audit trail",
        )
        audit = envelope.get("ai_audit") or {}
        attempts = len(audit.get("stages") or [])
        check(
            attempts == baseline.audit_attempts + 1,
            "audit must record the extra attempt (%d vs baseline %d)"
            % (attempts, baseline.audit_attempts),
        )
        facts = result.facts or {}
        check(facts == baseline.facts, "gateway facts drifted on the recovered run")
        check(journal.dlq_depth() == 0, "recovered run must not dead-letter")
        check(
            len(journal.snapshots(result.file_hash)) == 1,
            "expected exactly one snapshot",
        )
    return {"stage": stage, "audit_attempts": attempts}


def scenario_ai_slow_response(
    _fixture: str, stage: str, scratch: Path
) -> Dict[str, Any]:
    """A slow (single-response) model at ``stage``: the run completes
    byte-identical — latency alone changes nothing. (Token-level
    slow-DRIP has no seam in the non-streaming lane client — GAPS.)"""
    baseline = baseline_for("hu_ai_lane")
    idx = AI_STAGES.index(stage)
    delay = 0.25
    started = time.monotonic()
    result, admin, journal, _root = _hu_fault_run(scratch, {idx: "slow"}, delay_s=delay)
    elapsed = time.monotonic() - started
    check(result.outcome == "completed", "slow response failed the run")
    check(elapsed >= delay, "delay did not take (%.3fs)" % elapsed)
    check(
        norm_bytes(admin.envelope()) == baseline.norm,
        "a slow model changed the envelope",
    )
    check(journal.dlq_depth() == 0, "slow run must not dead-letter")
    return {"stage": stage, "elapsed_s": round(elapsed, 3)}


# ── F9: DB error mid-persist ───────────────────────────────────────────


def _db_predicate(target: str) -> Callable[[str, str, Any], bool]:
    if target == "period_insert":
        return lambda op, table, _p: op == "insert" and table == "financial_periods"
    if target == "documents_update":
        return lambda op, table, _p: op == "update" and table == "documents"
    if target == "line_items_wipe":
        return lambda op, table, _p: op == "delete" and table == "statement_line_items"
    if target == "line_items_insert":
        return lambda op, table, _p: op == "insert" and table == "statement_line_items"
    if target == "envelope_write":
        return envelope_write_predicate
    raise ValueError("unknown db write target %r" % target)


def scenario_db_error_mid_persist(
    fixture_name: str, target: str, scratch: Path
) -> Dict[str, Any]:
    """``FaultableAdmin`` raises on the targeted write inside the REAL
    ``stage_persist``. Fatal targets: the run fails, dead-letters with
    the typed reason, and the DLQ REPLAY (disarmed) completes
    byte-identical — the K1 loop through the operator path.
    ``envelope_write``: production treats the serving-flip JSONB write
    as best-effort — the run completes, the journal runs AHEAD of
    serving (the safe direction), and a re-delivery heals serving while
    the journal short-circuits the duplicate (K3)."""
    baseline = baseline_for(fixture_name)
    fixture = FIXTURES[fixture_name]
    admin = FaultableAdmin()
    admin.fail_predicate = _db_predicate(target)
    root = scratch / "db-journal"
    summary: Dict[str, Any] = {"target": target}

    with journal_env(root) as journal:
        assert journal is not None
        result = run_fixture(fixture, admin=admin)
        file_hash = result.file_hash
        check(admin.faults_raised >= 1, "the DB fault never fired")

        if target in DB_FATAL_TARGETS:
            check(result.outcome == "failed", "unguarded DB write fault must fail the run")
            check(
                result.error_type == "SimulatedDbError",
                "expected SimulatedDbError, got %r" % result.error_type,
            )
            check(admin.envelope() is None, "failed persist must not flip serving")
            entries = journal.dlq_entries()
            check(len(entries) == 1, "expected exactly one dead letter")
            check(
                entries[0]["reason_type"] == "SimulatedDbError",
                "DLQ reason_type must be the typed DB error",
            )
            check(entries[0]["stage"] == "persist", "DB fault must dead-letter at persist")
            check(
                journal.snapshots(file_hash) == [],
                "no snapshot may commit for the failed persist",
            )
            # Operator path: DLQ replay with the fault cleared.
            admin.armed = False
            with admin_seam(admin):
                replayed = replay_dlq(journal, str(entries[0]["run_id"]))
            check(replayed["status"] == "resumed", "DLQ replay did not resume")
            check(
                norm_bytes(admin.envelope()) == baseline.norm,
                "K1: replayed envelope differs from baseline",
            )
            check(journal.dlq_depth() == 0, "dead letter not resolved by the replay")
            check(len(journal.snapshots(file_hash)) == 1, "expected one snapshot")
            check(journal.verify_chain(file_hash) == [], "chain verification failed")
            summary["dlq"] = "replayed"
        else:
            check(
                result.outcome == "completed",
                "the serving-flip write is best-effort — the run must complete",
            )
            check(
                admin.envelope() is None,
                "the failed serving flip must leave no envelope",
            )
            check(
                len(journal.snapshots(file_hash)) == 1,
                "the journal must run AHEAD of serving (ordering rule)",
            )
            check(journal.verify_chain(file_hash) == [], "chain verification failed")
            # Heal: re-delivery with the fault cleared → serving catches
            # up; the journal short-circuits the duplicate.
            admin.armed = False
            second = run_fixture(fixture, admin=admin)
            check(second.outcome == "completed", "healing re-delivery failed")
            check(
                norm_bytes(admin.envelope()) == baseline.norm,
                "healed envelope differs from baseline",
            )
            check(
                len(journal.snapshots(file_hash)) == 1,
                "K3: heal must not add a second snapshot",
            )
            check(
                len(journal.registered_runs(file_hash)) == 1,
                "K3: the duplicate heal run must short-circuit, not register",
            )
            summary["dlq"] = "not_needed"
        _expect_no_ai(result, fixture_name)
    return summary


# ── F10: crash during undo ─────────────────────────────────────────────


def scenario_crash_during_undo(
    fixture_name: str, _boundary: str, scratch: Path
) -> Dict[str, Any]:
    """The undo route's composition (select → perform_undo → single
    envelope write) with the write raising mid-flight. ``perform_undo``
    is pure, the DB write is the one commit point — so a crashed undo
    leaves the receipt EXACTLY as it was (no partial suppression, no
    half-archived history), and the retry lands exactly-once."""
    baseline = baseline_for(fixture_name)
    check(
        baseline.has_receipt,
        "crash_during_undo needs a fixture with an applied receipt",
    )
    fixture = FIXTURES[fixture_name]
    admin = FaultableAdmin()
    root = scratch / "undo-journal"

    with journal_env(root) as journal:
        assert journal is not None
        result = run_fixture(fixture, admin=admin)
        check(result.outcome == "completed", "setup run failed")
        file_hash = result.file_hash
        norm_before = norm_bytes(admin.envelope())

        # The undo attempt whose envelope write dies mid-flight.
        envelope = admin.envelope()
        updated, _served = _reconcile.perform_undo(envelope, "user-dst")
        admin.fail_predicate = envelope_write_predicate
        try:
            admin.update(
                "financial_periods",
                {"assembled_canonical_v1": updated},
                filters={"id": "eq.%s" % result.period_id},
            )
        except Exception as exc:  # noqa: BLE001 — the injected write fault
            check(
                type(exc).__name__ == "SimulatedDbError",
                "unexpected fault type %r" % type(exc).__name__,
            )
        else:
            raise InvariantViolation("the undo write fault never fired")

        current = admin.envelope()
        check(
            norm_bytes(current) == norm_before,
            "K2: a crashed undo mutated the served envelope",
        )
        check(_receipt(current) is not None, "receipt lost by the crashed undo")
        check(_suppressed(current) == [], "partial suppression from a crashed undo")
        check(_history(current) == [], "partial history from a crashed undo")
        check(
            len(journal.snapshots(file_hash)) == 1,
            "a crashed undo must not touch the chain",
        )

        # Retry (fault cleared) — exactly-once semantics.
        admin.armed = False
        retried, _served2 = _reconcile.perform_undo(admin.envelope(), "user-dst")
        admin.update(
            "financial_periods",
            {"assembled_canonical_v1": retried},
            filters={"id": "eq.%s" % result.period_id},
        )
        final = admin.envelope()
        check(_receipt(final) is None, "receipt survived the undo")
        check(len(_history(final)) == 1, "undo must archive exactly one entry")
        check(len(_suppressed(final)) == 1, "undo must write exactly one suppression")
        # A second undo on the undone envelope must reject, not double-book.
        try:
            _reconcile.perform_undo(final, "user-dst")
        except _reconcile.ReconcileRejected:
            pass
        else:
            raise InvariantViolation("double undo was not rejected")
        # The serve seam self-heals the chain with the new era.
        observed = journal.observe_serving(final)
        check(
            isinstance(observed, dict) and observed.get("snapshot") is not None,
            "serve seam did not capture the undone era",
        )
        check(journal.verify_chain(file_hash) == [], "chain verification failed")
        check(len(journal.snapshots(file_hash)) == 2, "expected two eras on the chain")
    return {"history": 1, "suppressed": 1}


# ── F11: suppression survives a killed persist (K1's suppression half) ─


def scenario_suppression_survives_kill(
    fixture_name: str, boundary: str, scratch: Path
) -> Dict[str, Any]:
    """After an undo wrote a suppression entry, a re-scan of the same
    file carries it forward (and the auto stage respects it). Kill that
    re-scan at ``boundary``; resume. K1: suppression entries intact, the
    receipt is NOT re-applied, and the final envelope is byte-identical
    to an UNINTERRUPTED undo + re-scan control leg."""
    baseline = baseline_for(fixture_name)
    check(
        baseline.has_receipt,
        "suppression scenario needs a fixture with an applied receipt",
    )
    fixture = FIXTURES[fixture_name]

    def _undo_in_place(admin: FaultableAdmin, period_id: str) -> None:
        updated, _served = _reconcile.perform_undo(admin.envelope(), "user-dst")
        admin.update(
            "financial_periods",
            {"assembled_canonical_v1": updated},
            filters={"id": "eq.%s" % period_id},
        )

    # Control leg: run → undo → uninterrupted re-scan (journal OFF — the
    # hook contract makes on/off equivalent, proven elsewhere).
    control_admin = FaultableAdmin()
    with journal_env(None):
        first = run_fixture(fixture, admin=control_admin)
        check(first.outcome == "completed", "control run failed")
        _undo_in_place(control_admin, str(first.period_id))
        rescan = run_fixture(fixture, admin=control_admin)
        check(rescan.outcome == "completed", "control re-scan failed")
    control_norm = norm_bytes(control_admin.envelope())
    control_env = control_admin.envelope()
    check(_receipt(control_env) is None, "control: auto re-applied a suppressed fix")
    check(len(_suppressed(control_env)) == 1, "control: suppression lost")

    # Fault leg: the same story with the re-scan KILLED, then resumed.
    admin = FaultableAdmin()
    root = scratch / "suppress-journal"
    with journal_env(root) as journal:
        assert journal is not None
        first = run_fixture(fixture, admin=admin)
        check(first.outcome == "completed", "fault-leg run failed")
        file_hash = first.file_hash
        run1_id = str(journal.registered_runs(file_hash)[0]["run_id"])
        _undo_in_place(admin, str(first.period_id))
        # The serve seam observes the undone era (production reads the
        # period after an undo), keeping the chain honest pre-kill.
        journal.observe_serving(admin.envelope())

        killed = run_fixture(fixture, admin=admin, at_boundary=_kill_at(boundary))
        check(killed.outcome == "killed", "kill did not take")

        # Recovery: resume the run that HAS checkpoints (the killed
        # re-scan was provisional — its buffer died with the process; the
        # chain still honestly describes the served state). Re-persisting
        # run 1's recorded checkpoints must carry the CURRENT undo state
        # forward, not resurrect the receipt era.
        with admin_seam(admin):
            resumed = resume_run(journal, run1_id)
        check(
            resumed["status"] == "resumed",
            "resume after the killed suppression persist failed",
        )
        final = admin.envelope()
        check(
            norm_bytes(final) == control_norm,
            "K1: kill+resume diverged from the uninterrupted control",
        )
        check(_receipt(final) is None, "K1: the suppressed fix was re-applied")
        check(len(_suppressed(final)) == 1, "K1: suppression entries not intact")
        check(len(_history(final)) == 1, "K1: history not intact")
        check(journal.verify_chain(file_hash) == [], "chain verification failed")
        # The chain's last era agrees with serving.
        snaps = journal.snapshots(file_hash)
        check(len(snaps) >= 2, "expected the undone era on the chain")
        check(
            (snaps[-1].get("payload") or {}).get("normalized_hash")
            == normalized_hash(final),
            "chain tail disagrees with the served envelope",
        )
    return {"boundary": boundary, "suppressed": 1}


# ── The registry ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class FaultSpec:
    """One injectable fault class.

    ``boundaries`` is the enumeration axis the explorer walks (stage
    boundaries, arm points, write targets, client stages — whatever the
    fault parameterizes over); ``per_pr_boundary`` is the single
    representative the bounded profile runs. ``lane`` restricts the
    fixture set ("deterministic" | "hu_ai_lane" | "any"); AI-client
    faults structurally need the AI-lane fixture. ``receipt_only``
    fixtures must carry an applied reconciliation receipt."""

    name: str
    runner: Callable[[str, str, Path], Dict[str, Any]]
    lane: str
    boundaries: Tuple[str, ...]
    per_pr_boundary: str
    per_pr_fixture: str
    description: str
    receipt_only: bool = False

    def fixtures_for(self, profile: str) -> Tuple[str, ...]:
        from .harness import DEEP_DETERMINISTIC  # local: avoid cycle at import

        if self.lane == "hu_ai_lane":
            return ("hu_ai_lane",)
        if self.receipt_only:
            return ("rounding_004pct",)
        if profile == "deep":
            if self.lane == "any":
                return DEEP_DETERMINISTIC + ("hu_ai_lane",)
            return DEEP_DETERMINISTIC
        return (self.per_pr_fixture,)


FAULTS: Dict[str, FaultSpec] = {
    spec.name: spec
    for spec in (
        FaultSpec(
            name="kill_between_stages",
            runner=scenario_kill_between_stages,
            lane="any",
            boundaries=KILL_POINTS,
            per_pr_boundary="pass_done",
            per_pr_fixture="csv",
            description="process death at a stage boundary; recovery via "
            "the journal's resume machinery (K1)",
        ),
        FaultSpec(
            name="kill_inside_snapshot_commit",
            runner=scenario_kill_inside_snapshot_commit,
            lane="deterministic",
            boundaries=(CRASH_AFTER_OBJECT_WRITE, CRASH_AFTER_EVENT_APPEND),
            per_pr_boundary=CRASH_AFTER_OBJECT_WRITE,
            per_pr_fixture="csv",
            description="crash between the snapshot object write and the "
            "journal event (the ordering rule, exercised through "
            "stage_persist)",
        ),
        FaultSpec(
            name="disk_full_snapshot_write",
            runner=scenario_disk_full_snapshot_write,
            lane="deterministic",
            boundaries=STORE_ARM_POINTS,
            per_pr_boundary="pass_done",
            per_pr_fixture="csv",
            description="ENOSPC on the content-addressed store: pipeline "
            "unaffected, chain honestly incomplete, only temp debris (K2)",
        ),
        FaultSpec(
            name="torn_write",
            runner=scenario_torn_write,
            lane="deterministic",
            boundaries=("object_at_rest",),
            per_pr_boundary="object_at_rest",
            per_pr_fixture="csv",
            description="committed snapshot object truncated mid-content: "
            "every read path refuses it; serving unaffected (K2)",
        ),
        FaultSpec(
            name="journal_append_failure",
            runner=scenario_journal_append_failure,
            lane="deterministic",
            boundaries=("run_start", "pass_done"),
            per_pr_boundary="pass_done",
            per_pr_fixture="csv",
            description="journal line appends raise: pipeline identical, "
            "chain honestly shorter, orphan collectable, heals on "
            "re-delivery",
        ),
        FaultSpec(
            name="duplicate_delivery",
            runner=scenario_duplicate_delivery,
            lane="any",
            boundaries=("same_document",),
            per_pr_boundary="same_document",
            per_pr_fixture="csv",
            description="same content bytes delivered twice: one chain, one "
            "snapshot, one period row (K3)",
        ),
        FaultSpec(
            name="clock_skew",
            runner=scenario_clock_skew,
            lane="deterministic",
            boundaries=("frozen", "backward"),
            per_pr_boundary="frozen",
            per_pr_fixture="csv",
            description="frozen / backward journal clock via the injectable "
            "Journal(clock=...) seam: structural order, not wall time, "
            "decides",
            receipt_only=False,
        ),
        FaultSpec(
            name="ai_timeout",
            runner=scenario_ai_timeout,
            lane="hu_ai_lane",
            boundaries=AI_STAGES,
            per_pr_boundary="extract",
            per_pr_fixture="hu_ai_lane",
            description="model transport timeout: typed AiLaneError, typed "
            "dead letter, honest replay refusal, heal on re-delivery",
        ),
        FaultSpec(
            name="ai_malformed_json",
            runner=scenario_ai_malformed_json,
            lane="hu_ai_lane",
            boundaries=AI_STAGES,
            per_pr_boundary="extract",
            per_pr_fixture="hu_ai_lane",
            description="malformed JSON on both attempts: single retry "
            "exhausted → typed dead letter (K3)",
        ),
        FaultSpec(
            name="ai_malformed_recovers",
            runner=scenario_ai_malformed_recovers,
            lane="hu_ai_lane",
            boundaries=AI_STAGES,
            per_pr_boundary="extract",
            per_pr_fixture="hu_ai_lane",
            description="malformed JSON once, retry succeeds: byte-identical "
            "outside the audit trail, which records the extra attempt",
        ),
        FaultSpec(
            name="ai_slow_response",
            runner=scenario_ai_slow_response,
            lane="hu_ai_lane",
            boundaries=AI_STAGES,
            per_pr_boundary="classify",
            per_pr_fixture="hu_ai_lane",
            description="slow single-response model: latency changes nothing",
        ),
        FaultSpec(
            name="db_error_mid_persist",
            runner=scenario_db_error_mid_persist,
            lane="any",
            boundaries=DB_WRITE_TARGETS,
            per_pr_boundary="documents_update",
            per_pr_fixture="csv",
            description="fake-admin raises on a targeted write inside "
            "stage_persist: typed dead letter + byte-identical DLQ replay; "
            "the best-effort serving flip heals by re-delivery",
        ),
        FaultSpec(
            name="crash_during_undo",
            runner=scenario_crash_during_undo,
            lane="deterministic",
            boundaries=("undo_envelope_write",),
            per_pr_boundary="undo_envelope_write",
            per_pr_fixture="rounding_004pct",
            description="the undo's single envelope write dies: receipt "
            "untouched, no partial suppression/history, retry exactly-once",
            receipt_only=True,
        ),
        FaultSpec(
            name="suppression_survives_kill",
            runner=scenario_suppression_survives_kill,
            lane="deterministic",
            boundaries=BOUNDARIES,
            per_pr_boundary="pass_done",
            per_pr_fixture="rounding_004pct",
            description="kill + resume of the persist carrying an undo "
            "suppression forward: suppression intact, fix not re-applied "
            "(K1)",
            receipt_only=True,
        ),
    )
}


#: Faults the harness cannot inject through an existing seam — surfaced
#: by scripts/dst_explore.py on every run, never silently skipped.
GAPS: Tuple[Dict[str, str], ...] = (
    {
        "name": "pipeline_wall_clock_skew",
        "detail": "The pipeline's own datetime.now() stamps (e.g. "
        "provenance.written_at) have no injection seam — by contract they "
        "are VOLATILE keys, normalized out of every byte-identity "
        "comparison, so skewing them cannot change any invariant this "
        "harness checks. The injectable clock is the journal's "
        "(Journal(clock=...)), exercised by the clock_skew fault. Adding a "
        "pipeline clock seam would be a logic edit outside this wave.",
    },
    {
        "name": "torn_write_in_flight",
        "detail": "A half-written object under a VALID address is "
        "structurally impossible: SnapshotStore writes via same-dir "
        "tempfile + fsync + os.replace. The injectable approximations are "
        "(a) post-hoc truncation of the object AT REST (torn_write) and "
        "(b) ENOSPC mid-write leaving only .tmp-* debris "
        "(disk_full_snapshot_write). Nothing can make read_object return "
        "partial content silently — content re-verification hashes every "
        "read.",
    },
    {
        "name": "ai_slow_drip_streaming",
        "detail": "The lane client is a single blocking messages.create() "
        "call — there is no token-streaming seam to drip through. "
        "ai_slow_response injects the observable equivalent (a delayed "
        "single response). A real drip seam arrives only if the lane ever "
        "adopts streaming.",
    },
    {
        "name": "os_level_sigkill",
        "detail": "Kills are simulated in-process: the thread-local run "
        "context and the journal cache are dropped (what a dead process "
        "loses); the fsynced journal/store files and the DB rows are the "
        "crash survivors resume works from. A subprocess-based SIGKILL "
        "harness would add no new observable state on this composition.",
    },
    {
        "name": "kill_between_journal_commit_and_serving_flip",
        "detail": "Hooks never raise, so a crash injected INSIDE "
        "on_snapshot_persisted cannot stop the pipeline before the DB "
        "write. The observable end state (journal ahead of serving) is "
        "exercised exactly by db_error_mid_persist @ envelope_write; the "
        "sub-step crash states are exercised by "
        "kill_inside_snapshot_commit.",
    },
    {
        "name": "duplicate_bytes_different_document",
        "detail": "Semantics note, not an injection gap: the same bytes "
        "re-uploaded as a DIFFERENT document row is a NEW provenance era "
        "by design (provenance.source_document_id differs, so the "
        "normalized identity differs) — the journal records a second "
        "snapshot instead of short-circuiting. K3's dedup contract is "
        "about re-delivery of the SAME upload.",
    },
)
