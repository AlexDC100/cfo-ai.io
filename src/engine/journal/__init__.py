"""Run journal — the event-sourced spine around the pipeline (Part A).

An append-only, hash-chained JSONL journal + content-addressed snapshot
store on the EXISTING storage conventions (the gitignored ``data/`` tree
locally; the mounted ``/app/data`` volume in-container — no new
datastore). The DB envelope write in ``pipeline.stage_persist`` REMAINS
the serving source of truth; the journal records what happened around
it and retains content-addressed copies, so serving behavior is
unchanged and the golden corpus stays byte-identical.

Activation: hooks are COMPLETE NO-OPS unless ``ENGINE_JOURNAL_DIR`` is
set (default OFF — corpus replay and the determinism gate run without
it; production points it at ``/app/data/journal``).

Public surface:
    Journal / RunHandle / SimulatedCrash      journal.py
    SnapshotStore                             store.py
    hooks.*                                   the pipeline seams
    resume_run / replay_dlq / ResumeRefused   resume.py
    EVENT_TYPES / canonical_bytes / ...       events.py

AS-OF RESPONSE SHAPE — the contract the CLI (``journal_cli.py asof``)
and GET /api/period/{id}/asof both return, and the FE "View as of…"
entry point (a LATER wave — not built here) will consume:

    {
      "period_id": "<requested period, route only>",
      "as_of": "<the requested ISO timestamp>",
      "snapshot": {
        "snapshot_id":     "snap_<hex>",
        "content_hash":    "<sha256 of the exact envelope bytes>",
        "normalized_hash": "<sha256 of the volatile-normalized form>",
        "origin":          "pipeline" | "serve_observed",
        "period_id":       "<period at record time, may be null>",
        "recorded_at":     "<event UTC ISO timestamp>",
        "run_id":          "<owning run>"
      },
      "assembled_canonical_v1": { ...the exact persisted envelope of
                                  that era, verbatim... }
    }

Consumers rebuild any serve-time presentation (sv1 stamps, presenter
copy) from the envelope with the same pure serve functions used today —
the journal returns persisted truth, not a re-derived view. A 404 (CLI:
non-zero exit) means NO journal coverage at that moment — pre-journal
periods have none, and that absence is honest, never reconstructed.

RETENTION — append-only forever by default; snapshots deduplicate by
content hash. The compaction strategy is DOCUMENTED (journal.py module
docstring), not implemented: archival moves whole verified chains as a
unit; nothing ever rewrites, truncates, or selectively deletes
committed events or referenced objects. The only collectable artifacts
are orphan objects no event references (``gc_orphans`` — list-only by
default).
"""
from .events import (  # noqa: F401
    EVENT_TYPES,
    VOLATILE_KEYS,
    JournalIntegrityError,
    canonical_bytes,
    content_hash,
    normalized_hash,
    strip_volatile,
)
from .journal import (  # noqa: F401
    CRASH_AFTER_EVENT_APPEND,
    CRASH_AFTER_OBJECT_WRITE,
    Journal,
    RunHandle,
    SimulatedCrash,
    extract_snapshot_key,
    normalized_envelope,
    sanitize_key,
)
from .resume import ResumeRefused, replay_dlq, resume_run  # noqa: F401
from .store import SnapshotStore  # noqa: F401

__all__ = [
    "EVENT_TYPES",
    "VOLATILE_KEYS",
    "JournalIntegrityError",
    "canonical_bytes",
    "content_hash",
    "normalized_hash",
    "strip_volatile",
    "CRASH_AFTER_EVENT_APPEND",
    "CRASH_AFTER_OBJECT_WRITE",
    "Journal",
    "RunHandle",
    "SimulatedCrash",
    "extract_snapshot_key",
    "normalized_envelope",
    "sanitize_key",
    "ResumeRefused",
    "replay_dlq",
    "resume_run",
    "SnapshotStore",
]
