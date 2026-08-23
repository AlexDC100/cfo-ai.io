"""The run journal — append-only, hash-chained, event-sourced spine
around the existing pipeline (the DB envelope write in ``stage_persist``
REMAINS the serving source of truth; the journal records what happened
and retains content-addressed copies, so serving behavior is unchanged).

Filesystem layout under the journal root (``ENGINE_JOURNAL_DIR``;
locally ``<repo>/data/journal`` — gitignored; in-container
``/app/data/journal`` on the mounted volume):

    objects/<sha[:2]>/<sha>     content-addressed snapshot store
    runs/<run_id>.jsonl         one hash-chained event stream per run
    index/<file_hash>.jsonl     per-document chain index: one line per
                                registered run (append-only) + one line
                                per persisted period (asof lookup aid)
    dlq/<run_id>.json           dead-lettered runs (typed reason)
    dlq/resolved/<run_id>.json  dead letters cleared by a later success
                                (moved, never deleted — audit trail)

PERSIST ORDERING RULE (crash safety — encoded as tests in
tests/engine/test_crash_safety.py, not just prose):
  1. snapshot content is written CONTENT-ADDRESSED FIRST,
  2. then SNAPSHOT_PERSISTED commits to the journal,
  3. then serving flips (the caller's DB write).
A snapshot object without its journal event is invisible garbage
(collectable — ``gc_orphans``, list-only by default); a journal event
without its object is impossible by ordering. ``record_snapshot`` takes
an injectable ``crash_after`` test hook to simulate crashes between the
steps.

DUPLICATE SHORT-CIRCUIT: a run whose document chain already carries a
completed snapshot begins PROVISIONAL — its events buffer in memory and
are flushed to disk only when its own snapshot proves NEW (normalized
content or snapshot key differs from the chain head). Re-delivery of
the same upload under the same engine (same file_hash + parser_version
+ mapping_version + pack_hash → byte-identical analysis modulo volatile
write stamps) therefore leaves exactly one chain and one snapshot on
disk. A crash mid-provisional-run loses only the buffer — the chain
already describes the served state, and the serve-seam observation
self-heals any divergence at the next read.

RETENTION: the journal is append-only forever by default; snapshots are
deduplicated by content hash. COMPACTION STRATEGY (documented, NOT
implemented — no destructive compaction exists in this module): when a
deployment ever needs to bound disk, the sanctioned approach is
(a) archive whole per-document chains (index file + run files + their
referenced objects) into cold storage as a unit, verifying the hash
chain before AND after the move, then (b) leave a single tombstone index
line naming the archive location — never rewrite, truncate, or
selectively delete committed events or referenced objects in place.
Orphan objects (crash debris no event references) are the only
collectable artifacts (``gc_orphans``).

CONCURRENCY: appends take a process-wide lock plus a best-effort
``fcntl.flock`` on the target file (the production pipeline is a
thread-per-upload single-server design — see ``pipeline._enqueue``).
Cross-process writers on the SAME document chain are not arbitrated
beyond the file lock; the verify CLI detects any interleaving damage.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

from .events import (
    canonical_bytes,
    hash_bytes,
    make_event,
    normalized_hash,
    strip_volatile,
    verify_event,
)
from .store import SnapshotStore

logger = logging.getLogger("engine.journal")

try:  # POSIX file locking — best-effort (darwin/linux both fine)
    import fcntl as _fcntl
except ImportError:  # pragma: no cover — non-POSIX fallback
    _fcntl = None  # type: ignore[assignment]


class SimulatedCrash(RuntimeError):
    """Raised by the injectable ``crash_after`` test seam."""


#: crash_after seam positions accepted by record_snapshot.
CRASH_AFTER_OBJECT_WRITE = "object_write"
CRASH_AFTER_EVENT_APPEND = "event_append"

_SAFE_COMPONENT = re.compile(r"[^A-Za-z0-9._-]")


def sanitize_key(key: str) -> str:
    """Filesystem-safe form of a chain key (doc content hashes are
    ``sha256-<hex>`` strings already, but never trust input shape)."""
    return _SAFE_COMPONENT.sub("_", str(key))[:200] or "_"


def extract_snapshot_key(envelope: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """The duplicate-delivery identity halves carried BY the envelope:
    parser_version + mapping_version + pack_hash (file_hash is implicit
    in the chain the snapshot lands on). Missing halves stay None —
    absent provenance simply never matches, which disables dedup rather
    than guessing."""
    cbs = envelope.get("canonical_bs") if isinstance(envelope, dict) else None
    cbs = cbs if isinstance(cbs, dict) else {}
    extraction = cbs.get("extraction")
    extraction = extraction if isinstance(extraction, dict) else {}
    pack_prov = envelope.get("pack_provenance") if isinstance(envelope, dict) else None
    pack_prov = pack_prov if isinstance(pack_prov, dict) else {}
    return {
        "parser_version": extraction.get("parser_version"),
        "mapping_version": cbs.get("mapping_version"),
        "pack_hash": pack_prov.get("pack_hash"),
    }


class RunHandle:
    """One run's append cursor: sequence counter + rolling prev-hash.

    ``provisional`` handles buffer events in memory until their snapshot
    proves new (see module docstring); ``short_circuited`` handles have
    proven duplicate and drop every further emission."""

    def __init__(
        self,
        journal: "Journal",
        *,
        run_id: str,
        file_hash: str,
        document_id: Optional[str],
        run_kind: str,
        provisional: bool,
        prev_event_hash: Optional[str],
        prev_run_id: Optional[str],
        engine_version: str,
    ) -> None:
        self.journal = journal
        self.run_id = run_id
        self.file_hash = file_hash
        self.document_id = document_id
        self.run_kind = run_kind
        self.provisional = provisional
        self.short_circuited = False
        self.duplicate_of: Optional[str] = None
        self.engine_version = engine_version
        self.last_event_type: Optional[str] = None
        self._prev_event_hash = prev_event_hash
        self._prev_run_id = prev_run_id
        self._seq = 0
        self._buffer: List[Dict[str, Any]] = []
        self._registered = False

    # ── event emission ─────────────────────────────────────────────

    def emit(self, event_type: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if self.short_circuited:
            return None
        with self.journal._lock:
            event = make_event(
                run_id=self.run_id,
                seq=self._seq,
                ts=self.journal._now_iso(),
                event_type=event_type,
                payload=payload,
                prev_event_hash=self._prev_event_hash,
            )
            self._seq += 1
            self._prev_event_hash = event["event_hash"]
            self.last_event_type = event_type
            if self.provisional:
                self._buffer.append(event)
            else:
                self._ensure_registered()
                self.journal._append_event(self.run_id, event)
        return event

    def flush(self) -> None:
        """Promote a provisional run to durable: register it in the
        document index and append every buffered event, in order."""
        if self.short_circuited or not self.provisional:
            return
        with self.journal._lock:
            self.provisional = False
            self._ensure_registered()
            for event in self._buffer:
                self.journal._append_event(self.run_id, event)
            self._buffer = []

    def _ensure_registered(self) -> None:
        if self._registered:
            return
        self.journal._append_index(
            self.file_hash,
            {
                "v": 1,
                "kind": "run",
                "run_id": self.run_id,
                "file_hash": self.file_hash,
                "document_id": self.document_id,
                "run_kind": self.run_kind,
                "engine_version": self.engine_version,
                "prev_run_id": self._prev_run_id,
                "started_at": self.journal._now_iso(),
            },
        )
        self._registered = True

    # ── the snapshot commit point (ordering rule lives HERE) ───────

    def record_snapshot(
        self,
        envelope: Dict[str, Any],
        *,
        period_id: Optional[str] = None,
        origin: str = "pipeline",
        crash_after: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Persist ``envelope`` content-addressed, then commit
        SNAPSHOT_PERSISTED to the chain. The CALLER flips serving (its
        DB write) only after this returns — that ordering is the crash
        contract. Returns ``{"duplicate": bool, "snapshot_id",
        "content_hash", "normalized_hash", "run_id"}``."""
        if self.short_circuited:
            prior = self.journal.last_snapshot_event(self.file_hash)
            prior_payload = (prior or {}).get("payload") or {}
            return {
                "duplicate": True,
                "snapshot_id": prior_payload.get("snapshot_id"),
                "content_hash": prior_payload.get("content_hash"),
                "normalized_hash": prior_payload.get("normalized_hash"),
                "run_id": (prior or {}).get("run_id"),
            }
        data, lossy = canonical_bytes(envelope)
        exact_hash = hash_bytes(data)
        norm_hash = normalized_hash(envelope)
        key = extract_snapshot_key(envelope)

        if self.provisional:
            prior = self.journal.last_snapshot_event(self.file_hash)
            prior_payload = (prior or {}).get("payload") or {}
            if (
                prior is not None
                and prior_payload.get("normalized_hash") == norm_hash
                and (prior_payload.get("key") or {}) == key
            ):
                # DUPLICATE DELIVERY — same upload, same engine, same
                # analysis: short-circuit to the existing chain. Exactly
                # one snapshot, one chain (K3).
                self.short_circuited = True
                self.duplicate_of = prior.get("run_id")
                self._buffer = []
                logger.info(
                    "[journal] duplicate delivery short-circuited to run %s "
                    "(file %s)",
                    self.duplicate_of,
                    self.file_hash,
                )
                return {
                    "duplicate": True,
                    "snapshot_id": prior_payload.get("snapshot_id"),
                    "content_hash": prior_payload.get("content_hash"),
                    "normalized_hash": norm_hash,
                    "run_id": prior.get("run_id"),
                }
            self.flush()

        # 1. Object FIRST (content-addressed, atomic, idempotent).
        self.journal.store.write_object(data)
        if crash_after == CRASH_AFTER_OBJECT_WRITE:
            raise SimulatedCrash(
                "crash injected after object write (before journal event)"
            )

        # 2. THEN the journal event commits the snapshot.
        snapshot_id = "snap_%s" % uuid.uuid4().hex[:16]
        event = self.emit(
            "SNAPSHOT_PERSISTED",
            {
                "snapshot_id": snapshot_id,
                "content_hash": exact_hash,
                "normalized_hash": norm_hash,
                "period_id": period_id,
                "origin": origin,
                "key": key,
                "lossy": lossy,
            },
        )
        if crash_after == CRASH_AFTER_EVENT_APPEND:
            raise SimulatedCrash(
                "crash injected after journal event (before serving flip)"
            )

        # 3. Best-effort lookup aids + DLQ resolution (both derivable
        #    from the committed event, so a crash here loses nothing).
        if period_id:
            try:
                self.journal._append_index(
                    self.file_hash,
                    {
                        "v": 1,
                        "kind": "period",
                        "period_id": str(period_id),
                        "run_id": self.run_id,
                    },
                )
            except Exception:  # noqa: BLE001
                logger.exception("[journal] period index line failed (non-fatal)")
        try:
            self.journal.resolve_dlq_for(
                document_id=self.document_id, file_hash=self.file_hash
            )
        except Exception:  # noqa: BLE001
            logger.exception("[journal] dlq resolution failed (non-fatal)")

        return {
            "duplicate": False,
            "snapshot_id": snapshot_id,
            "content_hash": exact_hash,
            "normalized_hash": norm_hash,
            "run_id": self.run_id,
            "event": event,
        }


class Journal:
    def __init__(
        self,
        root: Union[str, Path],
        *,
        clock: Optional[Callable[[], datetime]] = None,
    ) -> None:
        self.root = Path(root)
        self.store = SnapshotStore(self.root)
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._lock = threading.RLock()
        for sub in ("runs", "index", "dlq", "objects"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)

    # ── time ───────────────────────────────────────────────────────

    def _now_iso(self) -> str:
        return self._clock().isoformat()

    # ── paths ──────────────────────────────────────────────────────

    def _run_path(self, run_id: str) -> Path:
        return self.root / "runs" / ("%s.jsonl" % sanitize_key(run_id))

    def _index_path(self, file_hash: str) -> Path:
        return self.root / "index" / ("%s.jsonl" % sanitize_key(file_hash))

    def _dlq_path(self, run_id: str) -> Path:
        return self.root / "dlq" / ("%s.json" % sanitize_key(run_id))

    # ── low-level append (locked, fsynced) ─────────────────────────

    def _append_line(self, path: Path, obj: Dict[str, Any]) -> None:
        data, _lossy = canonical_bytes(obj)
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            with open(str(path), "ab") as fh:
                if _fcntl is not None:
                    try:
                        _fcntl.flock(fh.fileno(), _fcntl.LOCK_EX)
                    except OSError:  # pragma: no cover
                        pass
                try:
                    fh.write(data + b"\n")
                    fh.flush()
                    os.fsync(fh.fileno())
                finally:
                    if _fcntl is not None:
                        try:
                            _fcntl.flock(fh.fileno(), _fcntl.LOCK_UN)
                        except OSError:  # pragma: no cover
                            pass

    def _append_event(self, run_id: str, event: Dict[str, Any]) -> None:
        self._append_line(self._run_path(run_id), event)

    def _append_index(self, file_hash: str, entry: Dict[str, Any]) -> None:
        self._append_line(self._index_path(file_hash), entry)

    # ── reads ──────────────────────────────────────────────────────

    @staticmethod
    def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
        if not path.is_file():
            return []
        out: List[Dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                out.append({"__corrupt_line__": line})
        return out

    def read_run(self, run_id: str) -> List[Dict[str, Any]]:
        return self._read_jsonl(self._run_path(run_id))

    def read_index(self, file_hash: str) -> List[Dict[str, Any]]:
        return self._read_jsonl(self._index_path(file_hash))

    def registered_runs(self, file_hash: str) -> List[Dict[str, Any]]:
        return [e for e in self.read_index(file_hash) if e.get("kind") == "run"]

    def list_chains(self) -> List[str]:
        index_dir = self.root / "index"
        if not index_dir.is_dir():
            return []
        return sorted(p.stem for p in index_dir.glob("*.jsonl"))

    def chain_events(self, file_hash: str) -> List[Dict[str, Any]]:
        """Every committed event of the document chain, in structural
        order (index registration order, then per-run seq)."""
        events: List[Dict[str, Any]] = []
        for entry in self.registered_runs(file_hash):
            events.extend(self.read_run(str(entry.get("run_id"))))
        return events

    def chain_tail(self, file_hash: str) -> Optional[Dict[str, Any]]:
        events = self.chain_events(file_hash)
        return events[-1] if events else None

    def last_snapshot_event(self, file_hash: str) -> Optional[Dict[str, Any]]:
        for event in reversed(self.chain_events(file_hash)):
            if event.get("type") == "SNAPSHOT_PERSISTED":
                return event
        return None

    def last_served_normalized_hash(self, file_hash: str) -> Optional[str]:
        for event in reversed(self.chain_events(file_hash)):
            if event.get("type") == "SERVED":
                return (event.get("payload") or {}).get("normalized_hash")
        return None

    # ── run lifecycle ──────────────────────────────────────────────

    def begin_run(
        self,
        *,
        file_hash: str,
        document_id: Optional[str],
        engine_version: str,
        run_kind: str = "pipeline",
        extra_payload: Optional[Dict[str, Any]] = None,
    ) -> RunHandle:
        """Open a run on the document chain and emit RUN_STARTED.
        ``pipeline``/``resume`` runs on a chain that already holds a
        completed snapshot begin PROVISIONAL (duplicate short-circuit,
        module docstring); ``serve``/``adhoc`` runs are always durable."""
        with self._lock:
            registered = self.registered_runs(file_hash)
            prev_run_id = str(registered[-1]["run_id"]) if registered else None
            tail = self.chain_tail(file_hash)
            prev_hash = tail.get("event_hash") if tail else None
            provisional = (
                run_kind in ("pipeline", "resume")
                and self.last_snapshot_event(file_hash) is not None
            )
            run_id = uuid.uuid4().hex
            handle = RunHandle(
                self,
                run_id=run_id,
                file_hash=file_hash,
                document_id=document_id,
                run_kind=run_kind,
                provisional=provisional,
                prev_event_hash=prev_hash,
                prev_run_id=prev_run_id,
                engine_version=engine_version,
            )
            payload = {
                "run_id": run_id,
                "file_hash": file_hash,
                "engine_version": engine_version,
                "document_id": document_id,
                "run_kind": run_kind,
            }
            if extra_payload:
                payload.update(extra_payload)
            handle.emit("RUN_STARTED", payload)
            return handle

    # ── serve-seam observation ─────────────────────────────────────

    def observe_serving(
        self,
        envelope: Dict[str, Any],
        *,
        envelope_version: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """The serve seam (``_apply_envelope_truth_to_statements``):
        record SERVED once per distinct served state, and SELF-HEAL the
        chain when the persisted envelope changed out-of-band (e.g. the
        reconcile undo route mutates ``assembled_canonical_v1`` without
        passing through ``stage_persist``) by capturing a
        ``serve_observed`` snapshot of the new era. Reads that serve the
        same state as last recorded are complete no-ops — the journal
        never grows per page view."""
        if not isinstance(envelope, dict) or not envelope:
            return None
        provenance = envelope.get("provenance")
        provenance = provenance if isinstance(provenance, dict) else {}
        file_hash = provenance.get("content_hash")
        if not file_hash:
            return None
        norm_hash = normalized_hash(envelope)
        with self._lock:
            if self.last_served_normalized_hash(file_hash) == norm_hash:
                return None
            last_snapshot = self.last_snapshot_event(file_hash)
            last_snapshot_norm = (
                ((last_snapshot or {}).get("payload") or {}).get("normalized_hash")
            )
            handle = self.begin_run(
                file_hash=str(file_hash),
                document_id=provenance.get("source_document_id"),
                engine_version="serve-observation",
                run_kind="serve",
            )
            snapshot_info: Optional[Dict[str, Any]] = None
            if last_snapshot_norm != norm_hash:
                snapshot_info = handle.record_snapshot(
                    envelope, period_id=None, origin="serve_observed"
                )
            data, _lossy = canonical_bytes(envelope)
            served_event = handle.emit(
                "SERVED",
                {
                    "envelope_version": envelope_version,
                    "content_hash": hash_bytes(data),
                    "normalized_hash": norm_hash,
                },
            )
            return {
                "run_id": handle.run_id,
                "snapshot": snapshot_info,
                "served_event": served_event,
            }

    # ── failure / DLQ ──────────────────────────────────────────────

    def record_failure(
        self,
        handle: RunHandle,
        *,
        stage: str,
        error_type: str,
        message: str,
    ) -> Optional[Dict[str, Any]]:
        """Append RUN_FAILED and dead-letter the run. The pipeline has no
        internal retry loop (retries are user-triggered re-runs), so
        every failed run dead-letters immediately; a later successful
        snapshot for the same document resolves its entries (moved to
        dlq/resolved/, never deleted)."""
        if handle.short_circuited:
            return None
        handle.flush()
        event = handle.emit(
            "RUN_FAILED",
            {"stage": stage, "error_type": error_type, "message": message},
        )
        entry = {
            "v": 1,
            "run_id": handle.run_id,
            "file_hash": handle.file_hash,
            "document_id": handle.document_id,
            "run_kind": handle.run_kind,
            "stage": stage,
            "reason_type": error_type,
            "message": message,
            "failed_at": self._now_iso(),
            "failing_event": event,
        }
        path = self._dlq_path(handle.run_id)
        data, _lossy = canonical_bytes(entry)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data + b"\n")
        return entry

    def dlq_entries(self) -> List[Dict[str, Any]]:
        dlq_dir = self.root / "dlq"
        out: List[Dict[str, Any]] = []
        if not dlq_dir.is_dir():
            return out
        for path in sorted(dlq_dir.glob("*.json")):
            try:
                out.append(json.loads(path.read_text(encoding="utf-8")))
            except ValueError:
                out.append({"run_id": path.stem, "__corrupt__": True})
        return out

    def dlq_depth(self) -> int:
        dlq_dir = self.root / "dlq"
        if not dlq_dir.is_dir():
            return 0
        return len(list(dlq_dir.glob("*.json")))

    def resolve_dlq_for(
        self,
        *,
        document_id: Optional[str] = None,
        file_hash: Optional[str] = None,
        run_id: Optional[str] = None,
    ) -> List[str]:
        """Move matching dead letters to dlq/resolved/ (audit-preserving
        — nothing is deleted). Returns the resolved run ids."""
        dlq_dir = self.root / "dlq"
        resolved_dir = dlq_dir / "resolved"
        moved: List[str] = []
        if not dlq_dir.is_dir():
            return moved
        for path in sorted(dlq_dir.glob("*.json")):
            try:
                entry = json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                continue
            match = (
                (run_id is not None and entry.get("run_id") == run_id)
                or (
                    document_id is not None
                    and entry.get("document_id") == document_id
                )
                or (file_hash is not None and entry.get("file_hash") == file_hash)
            )
            if not match:
                continue
            resolved_dir.mkdir(parents=True, exist_ok=True)
            os.replace(str(path), str(resolved_dir / path.name))
            moved.append(str(entry.get("run_id")))
        return moved

    # ── verification ───────────────────────────────────────────────

    def verify_chain(self, file_hash: str) -> List[str]:
        """Re-hash every committed event of the document chain and check
        every link (intra-run contiguity + cross-run linkage + snapshot
        object presence/content). Returns error strings; [] == intact."""
        errors: List[str] = []
        prev_hash: Optional[str] = None
        registered = self.registered_runs(file_hash)
        if not registered:
            return ["no runs registered for chain %s" % file_hash]
        for entry in registered:
            run_id = str(entry.get("run_id"))
            events = self.read_run(run_id)
            if not events:
                errors.append("run %s registered but has no event file" % run_id)
                continue
            expected_seq = 0
            for event in events:
                if "__corrupt_line__" in event:
                    errors.append("run %s: unparseable line" % run_id)
                    prev_hash = None
                    continue
                err = verify_event(event)
                if err:
                    errors.append(err)
                if event.get("seq") != expected_seq:
                    errors.append(
                        "run %s: seq gap (expected %d, found %r)"
                        % (run_id, expected_seq, event.get("seq"))
                    )
                expected_seq = (event.get("seq") or expected_seq) + 1
                if event.get("prev_event_hash") != prev_hash:
                    errors.append(
                        "run %s seq %s: prev_event_hash broken link "
                        "(stored %r != expected %r)"
                        % (
                            run_id,
                            event.get("seq"),
                            event.get("prev_event_hash"),
                            prev_hash,
                        )
                    )
                prev_hash = event.get("event_hash")
                if event.get("type") == "SNAPSHOT_PERSISTED":
                    digest = (event.get("payload") or {}).get("content_hash")
                    if not digest or not self.store.has(str(digest)):
                        errors.append(
                            "run %s seq %s: snapshot object %s missing from store"
                            % (run_id, event.get("seq"), digest)
                        )
                    else:
                        try:
                            self.store.read_object(str(digest))
                        except Exception as exc:  # noqa: BLE001
                            errors.append(
                                "run %s seq %s: snapshot object %s corrupt: %s"
                                % (run_id, event.get("seq"), digest, exc)
                            )
        return errors

    # ── as-of reconstruction ───────────────────────────────────────

    def resolve_chain(self, ref: str) -> Optional[str]:
        """Map a reference (file_hash | document_id | period_id) to the
        chain's file_hash. Index lines first; falls back to scanning run
        events for period ids (the period index line is a best-effort
        lookup aid, not the source of truth)."""
        ref = str(ref)
        if self._index_path(ref).is_file():
            return ref
        for chain_key in self.list_chains():
            for entry in self.read_index(chain_key):
                if entry.get("kind") == "run" and entry.get("document_id") == ref:
                    return str(entry.get("file_hash") or chain_key)
                if entry.get("kind") == "period" and entry.get("period_id") == ref:
                    file_hashes = [
                        e.get("file_hash")
                        for e in self.read_index(chain_key)
                        if e.get("kind") == "run"
                    ]
                    return str(file_hashes[0]) if file_hashes else chain_key
        for chain_key in self.list_chains():
            for event in self.chain_events(chain_key):
                if (
                    event.get("type") == "SNAPSHOT_PERSISTED"
                    and (event.get("payload") or {}).get("period_id") == ref
                ):
                    return str((event.get("payload") or {}).get("file_hash") or chain_key)
        return None

    def _chain_file_hash_of(self, chain_key: str) -> str:
        for entry in self.read_index(chain_key):
            if entry.get("kind") == "run" and entry.get("file_hash"):
                return str(entry["file_hash"])
        return chain_key

    def snapshots(self, file_hash: str) -> List[Dict[str, Any]]:
        return [
            e
            for e in self.chain_events(file_hash)
            if e.get("type") == "SNAPSHOT_PERSISTED"
        ]

    @staticmethod
    def _parse_ts(value: str) -> datetime:
        ts = str(value)
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        parsed = datetime.fromisoformat(ts)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed

    def asof(self, ref: str, t_iso: str) -> Optional[Dict[str, Any]]:
        """The envelope that was live at ``t``: the LAST
        SNAPSHOT_PERSISTED whose ``ts`` <= t (structural chain order
        breaks exact-timestamp ties), loaded from the content-addressed
        store. None == no journal coverage at that moment (pre-journal
        history is honestly absent, never reconstructed)."""
        chain_key = self.resolve_chain(ref)
        if chain_key is None:
            return None
        # ``resolve_chain`` returns the raw file_hash when the ref WAS
        # the file hash; sanitize-keyed chains resolve through the index.
        file_hash = chain_key
        target = self._parse_ts(t_iso)
        live: Optional[Dict[str, Any]] = None
        for event in self.snapshots(file_hash):
            try:
                event_ts = self._parse_ts(str(event.get("ts")))
            except ValueError:
                continue
            if event_ts <= target:
                live = event
        if live is None:
            return None
        payload = live.get("payload") or {}
        digest = str(payload.get("content_hash"))
        try:
            data = self.store.read_object(digest)
        except (KeyError, ValueError) as exc:
            return {
                "error": "snapshot object unavailable: %s" % exc,
                "snapshot": payload,
                "recorded_at": live.get("ts"),
                "run_id": live.get("run_id"),
            }
        return {
            "file_hash": file_hash,
            "as_of": t_iso,
            "snapshot": {
                "snapshot_id": payload.get("snapshot_id"),
                "content_hash": digest,
                "normalized_hash": payload.get("normalized_hash"),
                "origin": payload.get("origin"),
                "period_id": payload.get("period_id"),
                "recorded_at": live.get("ts"),
                "run_id": live.get("run_id"),
            },
            "assembled_canonical_v1": json.loads(data.decode("utf-8")),
        }

    # ── orphan collection (list-only by default) ───────────────────

    def referenced_digests(self) -> set:
        referenced = set()
        runs_dir = self.root / "runs"
        if runs_dir.is_dir():
            for path in sorted(runs_dir.glob("*.jsonl")):
                for event in self._read_jsonl(path):
                    if event.get("type") == "SNAPSHOT_PERSISTED":
                        digest = (event.get("payload") or {}).get("content_hash")
                        if digest:
                            referenced.add(str(digest))
        return referenced

    def gc_orphans(self, *, delete: bool = False) -> Dict[str, Any]:
        """Objects (and atomic-write temp debris) no journal event
        references — the ONLY collectable artifacts. List-only unless
        ``delete=True`` (the CLI mirrors this default)."""
        referenced = self.referenced_digests()
        orphans = [d for d in self.store.iter_digests() if d not in referenced]
        temp_files = [str(p) for p in self.store.iter_temp_files()]
        deleted: List[str] = []
        if delete:
            for digest in orphans:
                if self.store.delete_object(digest):
                    deleted.append(digest)
            for tmp in temp_files:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        return {
            "orphans": orphans,
            "temp_files": temp_files,
            "deleted": deleted,
            "referenced_count": len(referenced),
        }


# ── normalized-comparison helper (exported for tests / tooling) ────────


def normalized_envelope(envelope: Dict[str, Any]) -> Dict[str, Any]:
    """Volatile-normalized deep copy (the corpus-replay discipline) —
    what byte-identity means for envelopes across re-runs."""
    return strip_volatile(envelope)
