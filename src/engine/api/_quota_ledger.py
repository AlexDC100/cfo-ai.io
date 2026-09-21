"""The per-document quota ledger — what the plan has COUNTED, where the
browser cannot write it (engine.api._quota_ledger).

WHY (verifier lens S, 2026-09-21)
=================================
Whether a run is metered was read from `documents.status`: a re-run of a
document that is not `analyzed` "holds no analysis", so it was taken for
the book's FIRST analysis and reserved, committed and — at the plan cap —
billed as a paid extra. But a COUNTED book goes back to `failed` whenever a
free correction re-run of it fails (a PDF on an empty Anthropic balance,
CLAUDE.md §24): the re-run has already deleted its period. The next /retry,
the failed banner's /run or a re-upload of the same bytes then counted the
book a second time. And every column of `documents` is browser-writable, so
nothing on that row could have carried the fact anyway.

THE RECORD
==========
`document_quota_ledger` (supabase/schema_phase_document_quota_ledger.sql):
one row per document the meter touched, service role only — RLS on with no
policy, every privilege revoked from anon / authenticated.

  * `committed_at` — written by the settlement
    (`pipeline._commit_pipeline_quota`) when THIS document was counted
    (`commit_user_upload`). A book any live copy of which carries it
    (`pipeline._book_already_counted`) is never metered, committed or
    billed again, whatever its status says.

FAILURE POLICY. Every read returns None when the table cannot be read (a
database without the migration, a transient 5xx): the caller then decides
by the status rule it used before and logs it. Every write is best-effort
and logged at ERROR — a settlement is never undone because its record could
not be written.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set

from . import _supabase

logger = logging.getLogger(__name__)

#: The table (supabase/schema_phase_document_quota_ledger.sql).
TABLE = "document_quota_ledger"

#: Ids per `in.(…)` filter — keeps every PostgREST URL well under its limit.
_CHUNK = 100


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _chunks(ids: List[str]) -> Iterable[List[str]]:
    for i in range(0, len(ids), _CHUNK):
        yield ids[i:i + _CHUNK]


def rows_for(document_ids: Iterable[Any]) -> Optional[Dict[str, Dict[str, Any]]]:
    """document id → its ledger row, for the ids that have one. None when
    the ledger cannot be read."""
    ids = sorted({str(i) for i in document_ids if i})
    if not ids:
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    try:
        with _supabase.admin() as ac:
            for chunk in _chunks(ids):
                for r in ac.select(TABLE, filters={"document_id": "in.(%s)" % ",".join(chunk)}) or []:
                    if r.get("document_id"):
                        out[str(r["document_id"])] = dict(r)
    except Exception:  # noqa: BLE001 — unknown proves nothing; the caller decides
        logger.exception("[quota-ledger] could not read the ledger rows of %d document(s)", len(ids))
        return None
    return out


def committed_ids(document_ids: Iterable[Any]) -> Optional[Set[str]]:
    """The ids among `document_ids` that were COUNTED. None = unreadable."""
    rows = rows_for(document_ids)
    if rows is None:
        return None
    return {d for d, r in rows.items() if r.get("committed_at")}


def committed_document_ids_for_user(user_id: str) -> Optional[Set[str]]:
    """Every document counted to `user_id`. None = unreadable."""
    try:
        with _supabase.admin() as ac:
            rows = ac.select(TABLE, filters={"user_id": f"eq.{user_id}", "committed_at": "not.is.null"},
                             columns="document_id") or []
    except Exception:  # noqa: BLE001
        logger.exception("[quota-ledger] could not read the counted documents of user %s", user_id)
        return None
    return {str(r["document_id"]) for r in rows if r.get("document_id")}


def all_committed_ids() -> Optional[Set[str]]:
    """Every counted document (the restore script). None = unreadable."""
    out: Set[str] = set()
    try:
        with _supabase.admin() as ac:
            offset = 0
            while True:
                page = ac.select(TABLE, filters={"committed_at": "not.is.null", "offset": str(offset)},
                                 columns="document_id", order="document_id.asc", limit=1000) or []
                out.update(str(r["document_id"]) for r in page if r.get("document_id"))
                if len(page) < 1000:
                    return out
                offset += 1000
    except Exception:  # noqa: BLE001
        logger.exception("[quota-ledger] could not read the counted documents")
        return None


def record_commit(document_id: str, *, user_id: str, was_extra: bool, month: str) -> None:
    """THIS document was counted (the settlement's `commit_user_upload`)."""
    now = _now_iso()
    try:
        with _supabase.admin() as ac:
            ac.upsert(TABLE, {
                "document_id": str(document_id), "user_id": str(user_id), "month": str(month),
                "was_extra": bool(was_extra), "committed_at": now, "updated_at": now,
            }, on_conflict="document_id")
    except Exception:  # noqa: BLE001 — the count stands; only its record is missing
        logger.exception(
            "[quota-ledger][billing] could not record the COMMIT of document %s (user=%s) — a "
            "later re-run of it may be metered again until the record exists", document_id, user_id)
