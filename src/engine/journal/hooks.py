"""Pipeline-facing journal hooks — the ONLY surface pipeline.py calls.

Contract with the pipeline (and with the golden corpus):
  * Every hook is a COMPLETE NO-OP unless ``ENGINE_JOURNAL_DIR`` is set
    (default OFF — scripts/corpus_replay.py and verify_determinism.py
    run without it, so goldens cannot move; production enables it via
    env, pointing at the mounted ``/app/data/journal``).
  * Hooks NEVER raise and NEVER mutate their arguments — a journal
    failure is logged and swallowed; the pipeline result is identical
    with the journal on, off, or broken.
  * The run context is thread-local (the pipeline runs one document per
    daemon thread — ``pipeline._enqueue``); ``on_run_started`` resets
    any stale context so a reused thread can never misattribute events.

Emission map (each is one call-line at a stage boundary in pipeline.py):
    on_run_started        _run_pipeline_sync, after the doc/org load
    on_frontend_done      after ``stage_extract`` returns (all lanes:
                          deterministic parse / ai-lane / llm fallback)
    on_pass_done          after ``stage_map`` (financial branch) and on
                          the ai-lane assembled payload
    on_reconcile_outcome  inside ``stage_persist``, right after
                          ``_reconcile.auto_reconcile_envelope``
    on_snapshot_persisted inside ``stage_persist``, BEFORE the envelope
                          DB write (object → event → THEN serving flips;
                          the crash-ordering rule lives in
                          Journal.record_snapshot)
    on_served             at the serve seam in
                          ``_apply_envelope_truth_to_statements``
    on_run_failed         the orchestrator's blanket except handler

``on_snapshot_persisted`` without an active run context (e.g. the
reanalyze-with-overrides path calling ``stage_persist`` directly) opens
an implicit ``adhoc`` run so out-of-band persists are still captured.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Any, Dict, Optional

from .events import canonical_bytes, content_hash
from .journal import Journal

logger = logging.getLogger("engine.journal")

ENV_VAR = "ENGINE_JOURNAL_DIR"

_TLS = threading.local()
_JOURNAL_CACHE: Dict[str, Journal] = {}
_JOURNAL_CACHE_LOCK = threading.Lock()


def journal_from_env() -> Optional[Journal]:
    """The Journal for ``ENGINE_JOURNAL_DIR``, or None when the journal
    is disabled. Cached per root path."""
    root = os.environ.get(ENV_VAR)
    if not root:
        return None
    with _JOURNAL_CACHE_LOCK:
        cached = _JOURNAL_CACHE.get(root)
        if cached is None:
            cached = Journal(root)
            _JOURNAL_CACHE[root] = cached
        return cached


def reset_cache() -> None:
    """Test seam: drop cached Journal instances + the active context."""
    with _JOURNAL_CACHE_LOCK:
        _JOURNAL_CACHE.clear()
    _TLS.run = None


def _engine_version() -> str:
    try:
        from importlib.metadata import version

        return "scandia-engine@%s" % version("scandia-engine")
    except Exception:  # noqa: BLE001 — not installed as a dist locally
        return "scandia-engine@dev"


def active_run() -> Optional[Any]:
    return getattr(_TLS, "run", None)


def set_active_run(handle: Optional[Any]) -> None:
    """Bind a run handle to this thread (used by on_run_started and by
    the resume machinery so ``stage_persist``'s internal hooks attach to
    the resume run)."""
    _TLS.run = handle


def _file_hash_of(doc: Dict[str, Any]) -> Optional[str]:
    value = (doc or {}).get("content_hash")
    return str(value) if value else None


# ── hook functions (one per pipeline seam) ─────────────────────────────


def on_run_started(doc: Dict[str, Any], industry: Optional[str] = None) -> None:
    try:
        set_active_run(None)  # a reused thread must never misattribute
        journal = journal_from_env()
        if journal is None:
            return
        file_hash = _file_hash_of(doc)
        if not file_hash:
            return
        # Object BEFORE the event that references it (same ordering
        # discipline as snapshots). The store is content-addressed and
        # idempotent; a later-discarded duplicate run's doc object is
        # collectable garbage at worst.
        data, doc_lossy = canonical_bytes(doc)
        doc_hash = journal.store.write_object(data)
        handle = journal.begin_run(
            file_hash=file_hash,
            document_id=str((doc or {}).get("id") or "") or None,
            engine_version=_engine_version(),
            run_kind="pipeline",
            extra_payload={
                "doc_object": doc_hash,
                "doc_lossy": doc_lossy,
                "industry": industry,
                "original_filename": (doc or {}).get("original_filename"),
            },
        )
        set_active_run(handle)
    except Exception:  # noqa: BLE001 — hooks never break the pipeline
        logger.exception("[journal] on_run_started failed (non-fatal)")
        set_active_run(None)


def on_frontend_done(doc: Dict[str, Any], parsed: Dict[str, Any]) -> None:
    try:
        journal = journal_from_env()
        handle = active_run()
        if journal is None or handle is None:
            return
        data, lossy = canonical_bytes(parsed)
        ir_hash = journal.store.write_object(data)
        extraction = (parsed or {}).get("extraction")
        extraction = extraction if isinstance(extraction, dict) else {}
        front_end_id = (
            extraction.get("source_format")
            or (parsed or {}).get("detected_type")
            or "unknown"
        )
        handle.emit(
            "FRONTEND_DONE",
            {"front_end_id": front_end_id, "ir_hash": ir_hash, "lossy": lossy},
        )
    except Exception:  # noqa: BLE001
        logger.exception("[journal] on_frontend_done failed (non-fatal)")


def on_pass_done(doc: Dict[str, Any], assembled: Dict[str, Any]) -> None:
    try:
        journal = journal_from_env()
        handle = active_run()
        if journal is None or handle is None:
            return
        data, lossy = canonical_bytes(assembled)
        layer_hash = journal.store.write_object(data)
        canonical = (assembled or {}).get("assembled_canonical_v1")
        canonical = canonical if isinstance(canonical, dict) else {}
        pack_prov = canonical.get("pack_provenance")
        pack_prov = pack_prov if isinstance(pack_prov, dict) else {}
        handle.emit(
            "PASS_DONE",
            {
                "pass": "assemble",
                "layer_hash": layer_hash,
                "pack_hash": pack_prov.get("pack_hash"),
                "lossy": lossy,
            },
        )
    except Exception:  # noqa: BLE001
        logger.exception("[journal] on_pass_done failed (non-fatal)")


def on_reconcile_outcome(
    doc: Dict[str, Any],
    period_id: str,
    canonical: Dict[str, Any],
    auto_result: Dict[str, Any],
) -> None:
    try:
        journal = journal_from_env()
        handle = active_run()
        if journal is None or handle is None:
            return
        outcome = str((auto_result or {}).get("outcome") or "unknown")
        if outcome == "accepted":
            receipt = (canonical or {}).get("reconciliation")
            receipt_hash, _lossy = content_hash(receipt or {})
            handle.emit(
                "RECONCILE_APPLIED",
                {
                    "receipt_hash": receipt_hash,
                    "diagnosis_code": (auto_result or {}).get("diagnosis_code"),
                    "origin": (auto_result or {}).get("origin"),
                    "period_id": str(period_id),
                },
            )
        else:
            handle.emit(
                "RECONCILE_SKIPPED",
                {"reason": outcome, "period_id": str(period_id)},
            )
    except Exception:  # noqa: BLE001
        logger.exception("[journal] on_reconcile_outcome failed (non-fatal)")


def on_snapshot_persisted(
    doc: Dict[str, Any], period_id: str, canonical: Dict[str, Any]
) -> None:
    """Object first, SNAPSHOT_PERSISTED second — the caller's DB write
    (serving flip) runs strictly after this returns."""
    try:
        journal = journal_from_env()
        if journal is None:
            return
        handle = active_run()
        if handle is None:
            file_hash = _file_hash_of(doc) or (
                ((canonical or {}).get("provenance") or {}).get("content_hash")
            )
            if not file_hash:
                return
            handle = journal.begin_run(
                file_hash=str(file_hash),
                document_id=str((doc or {}).get("id") or "") or None,
                engine_version=_engine_version(),
                run_kind="adhoc",
            )
        handle.record_snapshot(
            canonical, period_id=str(period_id), origin="pipeline"
        )
    except Exception:  # noqa: BLE001
        logger.exception("[journal] on_snapshot_persisted failed (non-fatal)")


def on_period_moved(doc: Dict[str, Any], record: Dict[str, Any]) -> None:
    """PERIOD_MOVED — an operator re-filed this document under a
    different period (``engine.api._period_move``).

    Always opens its OWN ``adhoc`` run rather than joining ``active_run``:
    a move happens on an HTTP request thread, outside any pipeline run,
    and an ``adhoc`` run is durable (never provisional), so the event
    lands on the chain immediately instead of buffering behind a snapshot
    that this path never writes.

    The payload is the before/after of the period IDENTITY — that is the
    fact a later reader needs to explain why a month's numbers changed.
    """
    try:
        journal = journal_from_env()
        if journal is None:
            return
        file_hash = _file_hash_of(doc)
        if not file_hash:
            return
        source = (record or {}).get("from") or {}
        destination = (record or {}).get("to") or {}
        handle = journal.begin_run(
            file_hash=str(file_hash),
            document_id=str((doc or {}).get("id") or "") or None,
            engine_version=_engine_version(),
            run_kind="adhoc",
        )
        handle.emit(
            "PERIOD_MOVED",
            {
                "document_id": str((doc or {}).get("id") or "") or None,
                "original_filename": (record or {}).get("original_filename"),
                "before": {
                    "period_id": source.get("period_id"),
                    "period_end": source.get("period_end"),
                },
                "after": {
                    "period_id": destination.get("period_id"),
                    "period_end": destination.get("period_end"),
                },
                "source_action": source.get("action"),
                "rebuild_document_id": (record or {}).get("rebuild_document_id"),
                # W4's own verdict on the move, stored with it: a
                # non-empty list here is the record of a real defect.
                "orphaned_after": (record or {}).get("orphaned_after") or [],
            },
        )
    except Exception:  # noqa: BLE001
        logger.exception("[journal] on_period_moved failed (non-fatal)")


def on_served(
    envelope: Optional[Dict[str, Any]],
    served_cbs: Optional[Dict[str, Any]] = None,
) -> None:
    try:
        journal = journal_from_env()
        if journal is None or not isinstance(envelope, dict) or not envelope:
            return
        envelope_version = None
        if isinstance(served_cbs, dict):
            envelope_version = served_cbs.get("envelope_version")
        journal.observe_serving(envelope, envelope_version=envelope_version)
    except Exception:  # noqa: BLE001
        logger.exception("[journal] on_served failed (non-fatal)")


def on_run_failed(document_id: str, exc: BaseException) -> None:
    try:
        journal = journal_from_env()
        handle = active_run()
        set_active_run(None)
        if journal is None or handle is None:
            return
        stage_by_last_event = {
            None: "start",
            "RUN_STARTED": "extract",
            "FRONTEND_DONE": "map",
            "PASS_DONE": "persist",
            "RECONCILE_APPLIED": "persist",
            "RECONCILE_SKIPPED": "persist",
            "SNAPSHOT_PERSISTED": "finalize",
            "SERVED": "finalize",
        }
        stage = stage_by_last_event.get(handle.last_event_type, "unknown")
        journal.record_failure(
            handle,
            stage=stage,
            error_type=type(exc).__name__,
            message=str(exc)[:2000],
        )
    except Exception:  # noqa: BLE001
        logger.exception("[journal] on_run_failed failed (non-fatal)")
