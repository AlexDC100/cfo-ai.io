"""Run-journal event model — typed, hash-chained, canonically serialized.

Every journal event is one JSONL line:

    {
      "v": 1,
      "run_id": "<uuid hex>",
      "seq": <int, contiguous within a run, starting at 0>,
      "ts": "<UTC ISO-8601>",
      "type": "<one of EVENT_TYPES>",
      "payload": {...},                # type-specific fields
      "prev_event_hash": "<sha256 hex>" | null,
      "event_hash": "<sha256 hex>"     # over the event WITHOUT this key
    }

Hash chain: ``event_hash = sha256(canonical_json(event - event_hash))``.
The first event of a run carries ``prev_event_hash`` equal to the tail
hash of the PREVIOUS run in the same document chain (``None`` for the
very first run of a document), so the per-document chain is one
continuous cryptographic sequence across runs. ``verify_event`` /
``Journal.verify_chain`` recompute every link; any byte flipped in any
committed line breaks the chain loudly.

Canonical serialization (``canonical_bytes``) is the ONE byte form used
for event hashing, snapshot object content, and content addressing:
``json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":"))``
encoded UTF-8. Objects that are not strictly JSON-serializable fall back
to ``default=str`` and are flagged ``lossy`` — the resume machinery
refuses lossy checkpoints instead of faking fidelity.

Volatile-key normalization (``normalized_hash``) mirrors the corpus
replay's documented whitelist (scripts/corpus_replay.py VOLATILE_KEYS):
run-time timestamps stamped inside envelopes (``written_at`` etc.) are
replaced with a fixed placeholder before hashing, so two byte-identical
analyses that differ ONLY by write stamps share one identity. The
journal stores EXACT bytes but deduplicates (duplicate-delivery
short-circuit, serve-observation dedupe) on the normalized identity.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Optional, Tuple

#: Schema version stamped on every event line.
EVENT_SCHEMA_VERSION = 1

#: The typed event vocabulary. AI_REVIEW_DONE / AI_REVIEW_DEGRADED are
#: accepted now (emit-ready) even though the advisory AI-review hook
#: lands in a later wave — the chain format must not need a migration
#: when it does.
EVENT_TYPES = frozenset(
    {
        "RUN_STARTED",
        "FRONTEND_DONE",
        "PASS_DONE",
        "RECONCILE_APPLIED",
        "RECONCILE_SKIPPED",
        "AI_REVIEW_DONE",
        "AI_REVIEW_DEGRADED",
        "SNAPSHOT_PERSISTED",
        "SERVED",
        "RUN_FAILED",
    }
)

#: Mirrors scripts/corpus_replay.py VOLATILE_KEYS — the documented
#: whitelist of run-time timestamp keys stamped inside envelopes.
VOLATILE_KEYS = frozenset(
    {
        "written_at",
        "applied_at",
        "attempted_at",
        "archived_at",
        "undone_at",
        "suppressed_at",
        "at",
        "updated_at",
    }
)

VOLATILE_PLACEHOLDER = "<volatile:stripped>"


class JournalIntegrityError(RuntimeError):
    """A hash-chain link failed re-verification (tamper / corruption)."""


def canonical_bytes(obj: Any) -> Tuple[bytes, bool]:
    """Canonical JSON bytes of ``obj`` → ``(data, lossy)``.

    ``lossy`` is True when strict JSON serialization failed and the
    ``default=str`` fallback was used — consumers that need round-trip
    fidelity (resume) must refuse lossy payloads.
    """
    try:
        return (
            json.dumps(
                obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8"),
            False,
        )
    except (TypeError, ValueError):
        return (
            json.dumps(
                obj,
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
                default=str,
            ).encode("utf-8"),
            True,
        )


def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def content_hash(obj: Any) -> Tuple[str, bool]:
    """``(sha256 hex of canonical bytes, lossy)`` for any JSON-ish object."""
    data, lossy = canonical_bytes(obj)
    return hash_bytes(data), lossy


def strip_volatile(obj: Any) -> Any:
    """Deep copy with every VOLATILE_KEYS value replaced by the fixed
    placeholder (same normalization discipline as the corpus replay)."""
    if isinstance(obj, dict):
        return {
            k: (VOLATILE_PLACEHOLDER if k in VOLATILE_KEYS else strip_volatile(v))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [strip_volatile(v) for v in obj]
    return obj


def normalized_hash(obj: Any) -> str:
    """Content hash of the volatile-normalized form — the DEDUP identity
    (exact bytes remain the STORAGE identity)."""
    h, _lossy = content_hash(strip_volatile(obj))
    return h


def _hash_basis(event: Dict[str, Any]) -> bytes:
    basis = {k: v for k, v in event.items() if k != "event_hash"}
    data, _lossy = canonical_bytes(basis)
    return data


def make_event(
    *,
    run_id: str,
    seq: int,
    ts: str,
    event_type: str,
    payload: Dict[str, Any],
    prev_event_hash: Optional[str],
) -> Dict[str, Any]:
    """Build a fully-hashed event dict. Unknown types are rejected loudly
    — the vocabulary is the contract."""
    if event_type not in EVENT_TYPES:
        raise ValueError(
            "unknown journal event type %r (known: %s)"
            % (event_type, ", ".join(sorted(EVENT_TYPES)))
        )
    event: Dict[str, Any] = {
        "v": EVENT_SCHEMA_VERSION,
        "run_id": run_id,
        "seq": seq,
        "ts": ts,
        "type": event_type,
        "payload": payload,
        "prev_event_hash": prev_event_hash,
    }
    event["event_hash"] = hash_bytes(_hash_basis(event))
    return event


def verify_event(event: Dict[str, Any]) -> Optional[str]:
    """Re-hash one event. Returns an error string or None when intact."""
    try:
        expected = hash_bytes(_hash_basis(event))
    except Exception as exc:  # noqa: BLE001 — corrupt line shapes count as tamper
        return "event unreadable: %s" % (exc,)
    if event.get("event_hash") != expected:
        return "event_hash mismatch (run %s seq %s): stored %s != recomputed %s" % (
            event.get("run_id"),
            event.get("seq"),
            event.get("event_hash"),
            expected,
        )
    if event.get("type") not in EVENT_TYPES:
        return "unknown event type %r (run %s seq %s)" % (
            event.get("type"),
            event.get("run_id"),
            event.get("seq"),
        )
    return None
