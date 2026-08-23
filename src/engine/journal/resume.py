"""Idempotent resume + DLQ replay — re-invoke the RECORDED stage entry
points from the last completed checkpoint.

Every stage-boundary event references a content-addressed copy of its
payload (RUN_STARTED → the ``doc`` row, FRONTEND_DONE → ``parsed``,
PASS_DONE → ``assembled``), so a crashed run resumes by loading the last
checkpoint from the object store and re-running the REAL remaining
stages (``pipeline.stage_map`` / ``pipeline.stage_persist`` — the same
code objects production composes, never a mirror):

    last checkpoint          resume path
    PASS_DONE                stage_persist(doc, parsed, assembled)
    FRONTEND_DONE            stage_map(...) then stage_persist(...)
    RUN_STARTED only         cannot_resume — re-extraction needs the
                             original uploaded bytes (and possibly a
                             model call); report honestly, never fake
    SNAPSHOT_PERSISTED       stage_persist re-runs anyway (idempotent:
                             the DB write may have been the crashed
                             step; the journal-side snapshot
                             short-circuits as a duplicate)

The resume executes under a ``resume`` run on the SAME document chain
(the hooks inside ``stage_persist`` attach to it via the thread-local
context), so a resume that reproduces the already-committed state
leaves the chain untouched (duplicate short-circuit) and a resume that
produces a NEW state appends it — byte-identical envelopes to an
uninterrupted run either way (tests/engine/test_crash_safety.py, K2).

Honesty rules (DLQ replay): a missing run file, a missing checkpoint
object, a lossy (non-round-trippable) checkpoint, or an unavailable
persistence seam is reported as a typed refusal — the replay NEVER
fabricates inputs or claims success it can't prove.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Callable, Dict, List, Optional

from .journal import Journal

logger = logging.getLogger("engine.journal")


class ResumeRefused(RuntimeError):
    """Typed, honest refusal — carries a machine-readable reason."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__("%s: %s" % (reason, detail))
        self.reason = reason
        self.detail = detail


def _load_object(journal: Journal, digest: Optional[str], what: str) -> Dict[str, Any]:
    if not digest:
        raise ResumeRefused("missing_checkpoint", "%s has no object reference" % what)
    try:
        data = journal.store.read_object(str(digest))
    except (KeyError, ValueError) as exc:
        raise ResumeRefused(
            "object_unavailable", "%s object %s: %s" % (what, digest, exc)
        )
    try:
        loaded = json.loads(data.decode("utf-8"))
    except ValueError as exc:
        raise ResumeRefused(
            "object_corrupt", "%s object %s failed to parse: %s" % (what, digest, exc)
        )
    if not isinstance(loaded, dict):
        raise ResumeRefused(
            "object_corrupt", "%s object %s is not a mapping" % (what, digest)
        )
    return loaded


def find_checkpoints(events: List[Dict[str, Any]]) -> Dict[str, Optional[Dict[str, Any]]]:
    """The last event of each checkpoint type in a run's event list."""
    out: Dict[str, Optional[Dict[str, Any]]] = {
        "RUN_STARTED": None,
        "FRONTEND_DONE": None,
        "PASS_DONE": None,
        "SNAPSHOT_PERSISTED": None,
    }
    for event in events:
        etype = event.get("type")
        if etype in out:
            out[etype] = event
    return out


def resume_run(
    journal: Journal,
    run_id: str,
    *,
    stage_map: Optional[Callable[..., Dict[str, Any]]] = None,
    stage_persist: Optional[Callable[..., str]] = None,
) -> Dict[str, Any]:
    """Resume the run from its last completed stage checkpoint. The
    stage callables default to the REAL ``engine.api.pipeline`` entry
    points (imported lazily so the journal package itself never drags
    FastAPI in); tests may inject them.

    Raises ResumeRefused with a typed reason when the recorded state
    cannot honestly be re-executed."""
    events = journal.read_run(run_id)
    if not events:
        raise ResumeRefused("run_not_found", "no event file for run %s" % run_id)
    checkpoints = find_checkpoints(events)
    started = checkpoints["RUN_STARTED"]
    if started is None:
        raise ResumeRefused("chain_incomplete", "run %s has no RUN_STARTED" % run_id)
    started_payload = started.get("payload") or {}
    file_hash = str(started_payload.get("file_hash") or "")
    if not file_hash:
        raise ResumeRefused("chain_incomplete", "RUN_STARTED carries no file_hash")

    frontend = checkpoints["FRONTEND_DONE"]
    passed = checkpoints["PASS_DONE"]
    if frontend is None:
        raise ResumeRefused(
            "cannot_resume",
            "run %s crashed before FRONTEND_DONE — re-extraction needs the "
            "original uploaded bytes; re-run the pipeline for the document "
            "instead" % run_id,
        )
    for name, event in (("FRONTEND_DONE", frontend), ("PASS_DONE", passed)):
        if event is not None and (event.get("payload") or {}).get("lossy"):
            raise ResumeRefused(
                "lossy_checkpoint",
                "%s payload was not strictly JSON-serializable when recorded; "
                "resuming from it would not be byte-faithful" % name,
            )
    if started_payload.get("doc_lossy"):
        raise ResumeRefused(
            "lossy_checkpoint", "recorded doc payload was lossy at capture time"
        )

    doc = _load_object(journal, started_payload.get("doc_object"), "doc")
    parsed = _load_object(
        journal, (frontend.get("payload") or {}).get("ir_hash"), "parsed"
    )
    assembled: Optional[Dict[str, Any]] = None
    if passed is not None:
        assembled = _load_object(
            journal, (passed.get("payload") or {}).get("layer_hash"), "assembled"
        )

    if stage_map is None or stage_persist is None:
        try:
            from engine.api import pipeline as _pipeline
        except Exception as exc:  # noqa: BLE001
            raise ResumeRefused(
                "environment_unavailable",
                "engine.api.pipeline not importable here: %s" % exc,
            )
        stage_map = stage_map or _pipeline.stage_map
        stage_persist = stage_persist or _pipeline.stage_persist

    from . import hooks  # late import — avoid a cycle at package import

    handle = journal.begin_run(
        file_hash=file_hash,
        document_id=started_payload.get("document_id"),
        engine_version=str(started_payload.get("engine_version") or "unknown"),
        run_kind="resume",
        extra_payload={"resumed_run_id": run_id},
    )
    previous = hooks.active_run()
    hooks.set_active_run(handle)
    try:
        if assembled is None:
            assembled = stage_map(doc, parsed, started_payload.get("industry"))
            hooks.on_pass_done(doc, assembled)
        period_id = stage_persist(doc, parsed, assembled)
    except ResumeRefused:
        raise
    except Exception as exc:  # noqa: BLE001 — the stage itself failed; honest report
        raise ResumeRefused(
            "stage_failed", "%s: %s" % (type(exc).__name__, exc)
        )
    finally:
        hooks.set_active_run(previous)

    resolved = journal.resolve_dlq_for(run_id=run_id)
    return {
        "status": "resumed",
        "run_id": run_id,
        "resume_run_id": handle.run_id,
        "short_circuited": handle.short_circuited,
        "period_id": period_id,
        "dlq_resolved": resolved,
    }


def replay_dlq(journal: Journal, run_id: str) -> Dict[str, Any]:
    """``journal_cli dlq replay <run_id>`` — re-execute a dead-lettered
    run from its recorded checkpoints (see resume_run's honesty rules)."""
    entries = [e for e in journal.dlq_entries() if e.get("run_id") == run_id]
    if not entries:
        raise ResumeRefused(
            "not_in_dlq", "run %s has no dead-letter entry (dlq list)" % run_id
        )
    result = resume_run(journal, run_id)
    result["dlq_resolved"] = sorted(
        set(list(result.get("dlq_resolved") or []) + journal.resolve_dlq_for(run_id=run_id))
    )
    return result
