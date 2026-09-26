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
  * `reserved_at` (+ `reservation_id`, `was_extra`, `month`, `owner`,
    `heartbeat_at`, and `nonro_*` for the non-RO meter) — an OUTSTANDING
    reservation of this document's slot. It used to live only in the
    engine's memory (`pipeline._QUOTA_RUNS`, the grants in `_usage_gate`):
    a deploy restart mid-run lost it and the slot stayed in
    `user_usage.uploads_reserved`, counted against the cap, for the rest of
    the month (lens S, S8). Now:
      - the document's next run ADOPTS its own outstanding reservation
        instead of reserving again (`adopt`);
      - the process that holds a reservation touches `heartbeat_at` every
        HEARTBEAT_S (`heartbeat`); a reservation whose heartbeat is older
        than STALE_AFTER_S and that is not live in the sweeping process is
        RELEASED (`sweep_stale`) — compare-and-set on `reservation_id`, so
        two sweepers (the old and the new container during a deploy)
        release it once. A deploy's boot-probe container sees the running
        container's reservations heartbeating and leaves them alone;
      - an orphan whose analysis FINISHED (only its settlement was lost)
        is settled by the engine as the success it was
        (`pipeline._settle_orphaned_reservation`); the rest are released;
      - scripts/recompute_document_quota.py releases the orphans whose
        analysis never finished (it never charges: a finished one is left
        to the engine) and resets the current month's `uploads_reserved`
        to the reservations still live or awaiting that settlement.

FAILURE POLICY. Every read returns None when the table cannot be read (a
database without the migration, a transient 5xx): the caller then decides
by the status rule it used before and logs it. Every write is best-effort
and logged at ERROR — a settlement is never undone because its record could
not be written.

THE TABLE IS ABSENT (P2-A NO-TABLE AMPLIFICATION, 2026-09-26)
=============================================================
Production runs with USAGE_LIMITS_ENABLED=true and WITHOUT this table until
the owner applies the migration: PostgREST answers 404 PGRST205 to every
call. Before: every settlement parked its failed record in `_PENDING`
forever and every 60 s maintenance tick re-issued one failing call per
settled document (plus the heartbeat and the sweep), a traceback each; the
tick's cost grew with every analysis. Now a PGRST205 / 404 opens an ABSENT
WINDOW (`absent()`, ABSENT_REPROBE_S): one INFO line per window, every read
answers None and every write is skipped without a call, the maintenance
tick does nothing, and the next call after the window re-probes once. A
parked write whose failure is a 404 is dropped — there is nowhere to write
it; the migration's backfill records every analysed document. `_PENDING`
itself is bounded (PENDING_MAX), retried with backoff (PENDING_BACKOFF_S)
and dropped after PENDING_MAX_AGE_S — each drop one ERROR line, for
scripts/recompute_document_quota.py.

SETTLING (P1 RESTART, second shape, 2026-09-26)
===============================================
A settlement is TWO writes: the meter RPC (`commit_user_upload` /
`release_user_upload`) and this row's record (`committed_at` /
`released_at`). When the record failed and the process restarted before the
in-process retry (`_PENDING`) landed, the row still read "reserved", its
heartbeat stopped, and the sweep settled the finished analysis AS A COMMIT
again: uploads + 2, and a confirmed extra billed twice through
`record_metered_extra_doc`. The property "never settled a second time by
the sweep" held only in-process.

Now every settlement stamps `settling_at` on the row (`mark_settling`,
compare-and-set on `reservation_id`) BEFORE the meter moves. A row that
reads reserved + settling + no `committed_at` (`is_settling`) means "the
meter MAY already have moved": nothing automated moves it again — the
sweep neither releases nor commits it, adoption refuses it, and a run of
its book is never metered again (`counted_ids`). It is logged at ERROR
once per process, for scripts/recompute_document_quota.py, which lists it
for a human to rule on. The sweep itself CLAIMS an orphan with the same
mark (it used to pre-clear the row as *released* — wrong on its face for
one it was about to COMMIT, and it defeated the mark) and lets its
callback record the terminal state. The one-transaction fix —
`commit_user_upload(p_document_id)` writing this row in the same
statement — is the RPC change that retires the mark.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple, Union

from . import _supabase

logger = logging.getLogger(__name__)

#: The table (supabase/schema_phase_document_quota_ledger.sql).
TABLE = "document_quota_ledger"

#: This engine process — the `owner` of the reservations it makes.
PROCESS_ID = "%s:%d:%s" % (socket.gethostname(), os.getpid(), uuid.uuid4().hex[:8])

#: How often a process touches the heartbeat of the reservations it holds.
HEARTBEAT_S = 60
#: A reservation whose heartbeat is older than this belongs to a process
#: that died (ten missed heartbeats).
STALE_AFTER_S = 600

#: Ids per `in.(…)` filter — keeps every PostgREST URL well under its limit.
_CHUNK = 100

#: How long the ledger is taken as ABSENT after a PGRST205 / 404 before the
#: next call re-probes it (one call, one INFO line per window).
ABSENT_REPROBE_S = 600
_ABSENT: Dict[str, Any] = {"until": 0.0, "windows": 0}
_ABSENT_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_mono() -> float:
    return time.monotonic()


def absent() -> bool:
    """Is the ledger table known to be absent right now (inside the window a
    PGRST205 / 404 opened)? Every read answers None and every write is
    skipped — without a call — while it is."""
    with _ABSENT_LOCK:
        return _now_mono() < float(_ABSENT.get("until") or 0.0)


def _absent_error(exc: BaseException) -> bool:
    """A PostgREST "no such table": 404 (`raise_for_status` on a select /
    update / upsert / delete carries the response), PGRST205 ("could not
    find the table in the schema cache"), 42P01 (undefined_table), or the
    `(HTTP 404)` an insert wraps into its RuntimeError."""
    resp = getattr(exc, "response", None)
    if getattr(resp, "status_code", None) == 404:
        return True
    text = ""
    if resp is not None:
        try:
            text = str(getattr(resp, "text", "") or "")
        except Exception:  # noqa: BLE001
            text = ""
    s = "%s %s" % (exc, text)
    return "PGRST205" in s or "42P01" in s or "(HTTP 404)" in s


def _note_absent(op: str, exc: BaseException) -> None:
    """Open (or extend) the absent window. ONE INFO line per window — the
    thread that opens it says so; every other caller inside it is silent."""
    with _ABSENT_LOCK:
        opened = _now_mono() >= float(_ABSENT.get("until") or 0.0)
        _ABSENT["until"] = _now_mono() + ABSENT_REPROBE_S
        if opened:
            _ABSENT["windows"] = int(_ABSENT.get("windows") or 0) + 1
    if opened:
        resp = getattr(exc, "response", None)
        code = getattr(resp, "status_code", None)
        logger.info(
            "[quota-ledger] %s cannot be reached (%s on %s): supabase/schema_phase_document_quota_ledger.sql "
            "is not applied, or the PostgREST schema cache was not reloaded. Ledger reads, writes and the "
            "maintenance tick are skipped for the next %d s; entries meter by status meanwhile and the "
            "migration's backfill records what was analysed.",
            TABLE, ("HTTP %s" % code) if code else type(exc).__name__, op, ABSENT_REPROBE_S)


def _failed(op: str, exc: BaseException, msg: str, *args: Any) -> None:
    """Inside an except block: an absent table opens the window (one INFO
    line per window, no traceback); anything else is logged with its
    traceback at ERROR."""
    if _absent_error(exc):
        _note_absent(op, exc)
        return
    logger.exception(msg, *args)


def _chunks(ids: List[str]) -> Iterable[List[str]]:
    for i in range(0, len(ids), _CHUNK):
        yield ids[i:i + _CHUNK]


def rows_for(document_ids: Iterable[Any]) -> Optional[Dict[str, Dict[str, Any]]]:
    """document id → its ledger row, for the ids that have one. None when
    the ledger cannot be read."""
    ids = sorted({str(i) for i in document_ids if i})
    if not ids:
        return {}
    if absent():
        return None
    out: Dict[str, Dict[str, Any]] = {}
    try:
        with _supabase.admin() as ac:
            for chunk in _chunks(ids):
                for r in ac.select(TABLE, filters={"document_id": "in.(%s)" % ",".join(chunk)}) or []:
                    if r.get("document_id"):
                        out[str(r["document_id"])] = dict(r)
    except Exception as e:  # noqa: BLE001 — unknown proves nothing; the caller decides
        _failed("select", e, "[quota-ledger] could not read the ledger rows of %d document(s)", len(ids))
        return None
    return out


def committed_ids(document_ids: Iterable[Any]) -> Optional[Set[str]]:
    """The ids among `document_ids` that were COUNTED. None = unreadable."""
    rows = rows_for(document_ids)
    if rows is None:
        return None
    return {d for d, r in rows.items() if r.get("committed_at")}


def counted_ids(document_ids: Iterable[Any], *,
                except_reservation: Optional[str] = None) -> Optional[Set[str]]:
    """The ids among `document_ids` the plan COUNTED — or whose settlement
    is undetermined (`is_settling`: the meter may have counted it). Neither
    is ever metered again. `except_reservation`: the caller's OWN
    reservation, which it is settling right now — its settling mark is the
    caller's, not evidence of another settlement. None = unreadable."""
    rows = rows_for(document_ids)
    if rows is None:
        return None
    return {d for d, r in rows.items()
            if r.get("committed_at")
            or (is_settling(r) and not (except_reservation
                                        and str(r.get("reservation_id")) == str(except_reservation)))}


def committed_document_ids_for_user(user_id: str) -> Optional[Set[str]]:
    """Every document counted to `user_id`. None = unreadable."""
    if absent():
        return None
    try:
        with _supabase.admin() as ac:
            rows = ac.select(TABLE, filters={"user_id": f"eq.{user_id}", "committed_at": "not.is.null"},
                             columns="document_id") or []
    except Exception as e:  # noqa: BLE001
        _failed("select", e, "[quota-ledger] could not read the counted documents of user %s", user_id)
        return None
    return {str(r["document_id"]) for r in rows if r.get("document_id")}


def all_committed_ids() -> Optional[Set[str]]:
    """Every counted document (the restore script). None = unreadable."""
    if absent():
        return None
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
    except Exception as e:  # noqa: BLE001
        _failed("select", e, "[quota-ledger] could not read the counted documents")
        return None


#: What a settled reservation leaves behind (committed or released): no
#: outstanding reservation, no owner, no settling mark.
_CLEARED = {"reserved_at": None, "nonro_reserved_at": None, "owner": None, "settling_at": None}

# SETTLEMENT WRITES THAT FAILED. The meter already moved (committed or
# released); only the ledger row still reads "reserved". Left alone, its
# heartbeat would stop and the sweep would settle it a SECOND time — a
# finished analysis as another commit. So the process that settled keeps
# the write, heartbeats the row (`pending_ids`, part of the live set) and
# retries it every maintenance tick (`retry_pending`) until it lands.
#
# BOUNDED (P2-A). A write whose failure is a 404 (the table is absent) is
# never parked — nowhere to write it. A transient failure is parked with
# `parked_at`, `attempts` and `next_at`: the first retry is due at the next
# tick, each failed retry backs off (PENDING_BACKOFF_S), and a record older
# than PENDING_MAX_AGE_S — or the oldest, once PENDING_MAX are waiting — is
# DROPPED with one ERROR line for scripts/recompute_document_quota.py.
_PENDING: Dict[str, Dict[str, Any]] = {}
_PENDING_LOCK = threading.Lock()
PENDING_MAX = 500
PENDING_MAX_AGE_S = 24 * 3600
PENDING_BACKOFF_S = (0, 60, 120, 240, 480, 900)


def pending_ids() -> List[str]:
    with _PENDING_LOCK:
        return list(_PENDING.keys())


def is_pending(document_id: str) -> bool:
    with _PENDING_LOCK:
        return str(document_id) in _PENDING


def _write_settlement(document_id: str, write: Dict[str, Any]) -> Optional[bool]:
    """True: landed (and left the parking lot). False: failed transiently —
    park it. None: the table is absent (a 404, or inside the window) — drop
    it, there is nowhere to write it."""
    if absent():
        return None
    try:
        with _supabase.admin() as ac:
            if write["op"] == "commit":
                ac.upsert(TABLE, write["row"], on_conflict="document_id")
            else:
                ac.update(TABLE, write["patch"], filters={"document_id": f"eq.{document_id}"})
    except Exception as e:  # noqa: BLE001
        if _absent_error(e):
            _note_absent(write["op"], e)
            return None
        return False
    with _PENDING_LOCK:
        _PENDING.pop(str(document_id), None)
    return True


def _park(document_id: str, write: Dict[str, Any]) -> None:
    """Keep a transiently failed settlement write for retry — bounded."""
    now = _now_mono()
    dropped: List[str] = []
    with _PENDING_LOCK:
        _PENDING[str(document_id)] = {**write, "parked_at": now, "attempts": 1,
                                      "next_at": now + PENDING_BACKOFF_S[0]}
        while len(_PENDING) > PENDING_MAX:
            oldest = min(_PENDING, key=lambda d: float(_PENDING[d].get("parked_at") or 0.0))
            _PENDING.pop(oldest, None)
            dropped.append(oldest)
    for doc in dropped:
        logger.error(
            "[quota-ledger][billing] the parked settlement record of %s was DROPPED — %d records "
            "are waiting to be written; scripts/recompute_document_quota.py reconciles it", doc, PENDING_MAX)


def retry_pending() -> None:
    """Retry every settlement write that failed (a maintenance tick): the
    ones whose backoff elapsed; drop the ones past their max age (one ERROR
    line each) and — the table absent — every one of them."""
    if absent():
        return
    now = _now_mono()
    with _PENDING_LOCK:
        items = [(d, dict(w)) for d, w in _PENDING.items()]
    for doc, write in items:
        if now - float(write.get("parked_at") or now) > PENDING_MAX_AGE_S:
            with _PENDING_LOCK:
                _PENDING.pop(doc, None)
            logger.error(
                "[quota-ledger][billing] the settlement record of %s (%s) was DROPPED after %d attempt(s) "
                "over %d h — never written; scripts/recompute_document_quota.py reconciles it",
                doc, write.get("op"), int(write.get("attempts") or 0), PENDING_MAX_AGE_S // 3600)
            continue
        if float(write.get("next_at") or 0.0) > now:
            continue
        outcome = _write_settlement(doc, write)
        if outcome is True:
            continue
        if outcome is None:
            # The table is absent: nowhere to write it (the window's one INFO
            # line said so). Dropped, never retried.
            with _PENDING_LOCK:
                _PENDING.pop(doc, None)
            logger.debug("[quota-ledger] the parked %s record of %s was dropped: the ledger is absent",
                         write.get("op"), doc)
            continue
        with _PENDING_LOCK:
            cur = _PENDING.get(doc)
            if cur is not None:
                cur["attempts"] = int(cur.get("attempts") or 0) + 1
                wait = PENDING_BACKOFF_S[min(int(cur["attempts"]) - 1, len(PENDING_BACKOFF_S) - 1)]
                cur["next_at"] = now + wait
        logger.error("[quota-ledger] the settlement record of %s still cannot be written (attempt %d; "
                     "next in %d s)", doc, int((cur or {}).get("attempts") or 0), int(wait) if cur else 0)


def record_commit(document_id: str, *, user_id: str, was_extra: bool, month: str) -> None:
    """THIS document was counted (the settlement's `commit_user_upload`);
    its reservation is settled."""
    now = _now_iso()
    write = {"op": "commit", "row": {
        "document_id": str(document_id), "user_id": str(user_id), "month": str(month),
        "was_extra": bool(was_extra), "committed_at": now, "updated_at": now, **_CLEARED,
    }}
    outcome = _write_settlement(document_id, write)
    if outcome is True:
        return
    if outcome is None:
        logger.debug("[quota-ledger] the COMMIT record of %s was not written: the ledger is absent "
                     "(the migration's backfill records it)", document_id)
        return
    _park(document_id, write)
    logger.error(
        "[quota-ledger][billing] could not record the COMMIT of document %s (user=%s) — parked, "
        "heartbeated and retried with backoff for up to %d h", document_id, user_id,
        PENDING_MAX_AGE_S // 3600)


@dataclass(frozen=True)
class Outstanding:
    """`record_reservation` found the document's row already carrying an
    OUTSTANDING reservation — another run's, or another member's — and left
    it untouched. The caller gives back the slot it just reserved."""
    row: Dict[str, Any]

    @property
    def user_id(self) -> str:
        return str(self.row.get("user_id") or "")


def record_reservation(document_id: str, *, user_id: str, was_extra: bool,
                       month: str) -> Union[str, Outstanding, None]:
    """THIS process holds a reservation of `document_id`'s slot (a run's,
    or a confirmed extra granted to it). Returns the `reservation_id`
    written — the settlement's compare-and-set key (`mark_settling`) — an
    `Outstanding` when the row already holds a reservation, or None when
    the write failed (or the ledger is absent).

    NEVER OVERWRITES AN OUTSTANDING RESERVATION (P2-B, 2026-09-26). This was
    an upsert on `document_id`: a confirm re-posted after a restart, or a
    run of a document whose colleague's run a restart orphaned, wrote a new
    `reservation_id` over the outstanding one — the earlier slot stayed in
    the meter with no record left to be adopted or swept. Now the row is
    PATCHed only while `reserved_at` is null (a settled row) and read back;
    a document without a row gets one; a row that holds a reservation is
    answered as `Outstanding` for the caller to release its own slot."""
    now = _now_iso()
    rid = uuid.uuid4().hex
    doc = str(document_id)
    if absent():
        return None
    fields = {
        "user_id": str(user_id), "month": str(month), "was_extra": bool(was_extra),
        "reservation_id": rid, "reserved_at": now, "owner": PROCESS_ID, "heartbeat_at": now,
        "release_token": None, "settling_at": None, "updated_at": now,
    }
    try:
        with _supabase.admin() as ac:
            for _attempt in (1, 2):
                ac.update(TABLE, fields, filters={"document_id": f"eq.{doc}", "reserved_at": "is.null"})
                back = (rows_for([doc]) or {}).get(doc)
                if back is None:
                    # No row yet — insert one. A conflict (a row that appeared
                    # meanwhile) is read back below.
                    try:
                        ac.insert(TABLE, {"document_id": doc, **fields}, returning=False)
                        return rid
                    except Exception as e:  # noqa: BLE001
                        if _absent_error(e):
                            raise
                        back = (rows_for([doc]) or {}).get(doc)
                        if back is None:
                            raise
                if str(back.get("reservation_id") or "") == rid:
                    return rid
                if back.get("reserved_at"):
                    return Outstanding(dict(back))
                # settled between the PATCH and the read-back: once more
            return None
    except Exception as e:  # noqa: BLE001 — the in-process ledger still settles it
        _failed("update", e,
                "[quota-ledger] could not record the reservation of document %s (user=%s) — a "
                "restart before it settles would leave it outstanding", document_id, user_id)
        return None


def record_nonro_reservation(document_id: str, *, user_id: str, was_extra: bool, month: str) -> None:
    """The non-RO meter's reservation, alongside the document's slot."""
    now = _now_iso()
    if absent():
        return
    try:
        with _supabase.admin() as ac:
            ac.update(TABLE, {"nonro_user_id": str(user_id), "nonro_was_extra": bool(was_extra),
                              "nonro_month": str(month), "nonro_reserved_at": now,
                              "heartbeat_at": now, "updated_at": now},
                      filters={"document_id": f"eq.{document_id}"})
    except Exception as e:  # noqa: BLE001
        _failed("update", e, "[quota-ledger] could not record the non-RO reservation of %s", document_id)


def record_release(document_id: str) -> None:
    """`document_id`'s reservation was released (a failure, a refusal, an
    expired or cancelled grant)."""
    now = _now_iso()
    write = {"op": "release", "patch": {**_CLEARED, "released_at": now, "updated_at": now}}
    outcome = _write_settlement(document_id, write)
    if outcome is True:
        return
    if outcome is None:
        logger.debug("[quota-ledger] the release record of %s was not written: the ledger is absent",
                     document_id)
        return
    _park(document_id, write)
    logger.error("[quota-ledger] could not record the release of %s — parked, heartbeated and "
                 "retried with backoff for up to %d h", document_id, PENDING_MAX_AGE_S // 3600)


def is_settling(row: Optional[Dict[str, Any]]) -> bool:
    """Reserved, stamped `settling_at`, not committed: the process holding
    it began moving the meter and the record never landed. The meter MAY
    already have moved — nothing automated moves it again."""
    return bool(row and row.get("reserved_at") and row.get("settling_at")
                and not row.get("committed_at"))


def mark_settling(document_id: str, *, reservation_id: Optional[str]) -> bool:
    """Stamp `document_id`'s outstanding reservation SETTLING — the meter is
    about to move for it. Compare-and-set on `reservation_id` when the
    caller holds it (a run's own reservation), else on the row still being
    reserved (a grant). Best-effort: False, logged at ERROR, when the write
    failed — the settlement proceeds as it always did; only the restart
    protection is missing for this one."""
    now = _now_iso()
    filters = {"document_id": f"eq.{document_id}", "reserved_at": "not.is.null"}
    if reservation_id:
        filters["reservation_id"] = f"eq.{reservation_id}"
    if absent():
        return False
    try:
        with _supabase.admin() as ac:
            ac.update(TABLE, {"settling_at": now, "updated_at": now}, filters=filters)
    except Exception as e:  # noqa: BLE001
        _failed("update", e,
                "[quota-ledger][billing] could not mark document %s's reservation as settling — the "
                "meter moves without it; a restart before its record lands could settle it twice",
                document_id)
        return False
    return True


#: The settling rows THIS process has reported (once each, at ERROR).
_SETTLING_REPORTED: Set[Tuple[str, str]] = set()
_SETTLING_LOCK = threading.Lock()


def _report_settling(row: Dict[str, Any]) -> None:
    """A stale reservation the sweep must leave alone — for the operator."""
    key = (str(row.get("document_id") or ""), str(row.get("reservation_id") or ""))
    with _SETTLING_LOCK:
        if key in _SETTLING_REPORTED:
            return
        _SETTLING_REPORTED.add(key)
    logger.error(
        "[quota-ledger][billing] document %s: reservation %s (user=%s month=%s extra=%s, owner %s) "
        "was SETTLING when its owner stopped heartbeating (last %s) — the meter may already have "
        "moved (commit or release) and the record never landed. Neither released nor committed "
        "here; scripts/recompute_document_quota.py lists it for a human to rule on.",
        key[0], key[1], row.get("user_id"), row.get("month"), bool(row.get("was_extra")),
        row.get("owner"), row.get("heartbeat_at"))


def outstanding(document_id: str) -> Optional[Dict[str, Any]]:
    """`document_id`'s outstanding reservation row, or None (none, or
    unreadable)."""
    rows = rows_for([document_id])
    row = (rows or {}).get(str(document_id))
    return row if row and row.get("reserved_at") else None


def adopt(document_id: str, *, user_id: str, take_extra: bool) -> Optional[Dict[str, Any]]:
    """Take over `document_id`'s OUTSTANDING reservation — one a restart
    orphaned — for the run the caller has just claimed (the caller holds the
    document's in-process claim and has no in-memory reservation for it).

    Only a reservation made for the same verified `user_id`; a confirmed
    extra (`was_extra`) only when `take_extra` (the document's own run).
    Compare-and-set against the sweep: the row is taken by swapping its
    `reservation_id` while it still carries the one read, and the swap is
    read back — a sweeper that read the row before the adoption then
    matches nothing and releases nothing. Returns the row AS ADOPTED — its
    new `reservation_id`, which the caller's run now holds and which its
    settlement compares-and-sets against — else None (the caller reserves
    as usual)."""
    row = outstanding(document_id)
    if row is None or str(row.get("user_id") or "") != str(user_id):
        return None
    if is_settling(row):
        # The meter may already have moved for it: adopting it would let
        # this run's terminal move it a second time. The caller's
        # `_needs_metering` reads the same row as counted (`counted_ids`).
        logger.error("[quota-ledger][billing] document %s: refused to adopt a SETTLING reservation "
                     "(%s) — its settlement is undetermined", document_id, row.get("reservation_id"))
        return None
    if row.get("was_extra") and not take_extra:
        return None
    old_rid = row.get("reservation_id")
    if not old_rid:
        return None
    new_rid = uuid.uuid4().hex
    try:
        with _supabase.admin() as ac:
            ac.update(TABLE, {"reservation_id": new_rid, "owner": PROCESS_ID,
                              "heartbeat_at": _now_iso(), "updated_at": _now_iso()},
                      filters={"document_id": f"eq.{document_id}", "reservation_id": f"eq.{old_rid}",
                               "reserved_at": "not.is.null", "settling_at": "is.null"})
        back = (rows_for([document_id]) or {}).get(str(document_id)) or {}
    except Exception as e:  # noqa: BLE001 — not adopted; the caller reserves, the sweep frees the orphan
        _failed("update", e, "[quota-ledger] could not take over %s's reservation", document_id)
        return None
    if back.get("reservation_id") != new_rid:
        return None  # a sweeper released it first
    logger.warning("[quota-ledger] document %s: adopted the reservation a restart orphaned "
                   "(user=%s month=%s extra=%s)", document_id, user_id, row.get("month"),
                   bool(row.get("was_extra")))
    return dict(back)


def heartbeat(document_ids: Iterable[Any]) -> None:
    """Touch the heartbeat of the reservations this process holds."""
    ids = sorted({str(i) for i in document_ids if i})
    if not ids or absent():
        return
    now = _now_iso()
    try:
        with _supabase.admin() as ac:
            for chunk in _chunks(ids):
                ac.update(TABLE, {"heartbeat_at": now, "owner": PROCESS_ID},
                          filters={"document_id": "in.(%s)" % ",".join(chunk),
                                   "reserved_at": "not.is.null"})
    except Exception as e:  # noqa: BLE001 — the next beat retries
        _failed("update", e, "[quota-ledger] heartbeat failed for %d reservation(s)", len(ids))


def release_rpcs(row: Dict[str, Any]) -> None:
    """Give an orphaned reservation back to the meter, in the month it was
    made in (the slot, and the non-RO slot when it holds one), and record
    the release (`record_release`: a failed record is kept and retried like
    every settlement write). The caller (`sweep_stale`) has already claimed
    the row SETTLING."""
    from . import _usage_gate as _ug
    _ug.release_document(str(row.get("user_id")), was_extra=bool(row.get("was_extra")),
                         month=row.get("month") or None)
    if row.get("nonro_reserved_at") and row.get("nonro_user_id"):
        _ug.release_nonro_document(str(row.get("nonro_user_id")),
                                   was_extra=bool(row.get("nonro_was_extra")),
                                   month=row.get("nonro_month") or None)
    record_release(str(row.get("document_id") or ""))


def stale_outstanding(*, now: Optional[datetime] = None,
                      stale_after_s: int = STALE_AFTER_S) -> Optional[List[Dict[str, Any]]]:
    """Outstanding reservations whose owner stopped heartbeating — the
    SETTLING ones included (the restore script reports them). None =
    unreadable."""
    cutoff = ((now or datetime.now(timezone.utc)) - timedelta(seconds=stale_after_s)).isoformat()
    if absent():
        return None
    try:
        with _supabase.admin() as ac:
            return list(ac.select(TABLE, filters={"reserved_at": "not.is.null",
                                                  "heartbeat_at": f"lt.{cutoff}"},
                                  order="heartbeat_at.asc", limit=500) or [])
    except Exception as e:  # noqa: BLE001
        _failed("select", e, "[quota-ledger] could not list stale reservations")
        return None


def live_outstanding(*, now: Optional[datetime] = None,
                     stale_after_s: int = STALE_AFTER_S) -> Optional[List[Dict[str, Any]]]:
    """Outstanding reservations still heartbeating (a run or a grant some
    engine process holds). None = unreadable."""
    cutoff = ((now or datetime.now(timezone.utc)) - timedelta(seconds=stale_after_s)).isoformat()
    if absent():
        return None
    try:
        with _supabase.admin() as ac:
            return list(ac.select(TABLE, filters={"reserved_at": "not.is.null",
                                                  "heartbeat_at": f"gte.{cutoff}"}) or [])
    except Exception as e:  # noqa: BLE001
        _failed("select", e, "[quota-ledger] could not list live reservations")
        return None


def sweep_stale(*, is_live: Callable[[str], bool],
                release: Callable[[Dict[str, Any]], None] = release_rpcs,
                now: Optional[datetime] = None,
                stale_after_s: int = STALE_AFTER_S) -> List[Dict[str, Any]]:
    """Settle every reservation whose owner stopped heartbeating and that
    is not live here (`is_live(document_id)`: in flight, in the in-process
    ledger, or a grant this process holds) through `release` — the meter
    release, or the engine's orphan settlement (a commit when the analysis
    finished). Returns the rows settled.

    Compare-and-set: the row is CLAIMED — stamped `settling_at` and a fresh
    `release_token` — only while it still carries the reservation read
    (`reservation_id`) and is not settling, and `release` runs only in the
    sweeper whose token is read back: two sweepers settle one reservation
    once, and a run that adopted it first is never touched. `release`
    records the terminal state (`released_at` / `committed_at`); a row
    whose settlement began and never recorded stays SETTLING (`is_settling`)
    and is skipped — reported at ERROR once — for the restore script: the
    meter may already have moved for it."""
    settled: List[Dict[str, Any]] = []
    for row in stale_outstanding(now=now, stale_after_s=stale_after_s) or []:
        doc = str(row.get("document_id") or "")
        rid = row.get("reservation_id")
        if not doc or not rid or is_live(doc):
            continue
        if is_settling(row):
            _report_settling(row)
            continue
        token = uuid.uuid4().hex
        try:
            with _supabase.admin() as ac:
                ac.update(TABLE, {"settling_at": _now_iso(), "release_token": token,
                                  "owner": PROCESS_ID, "updated_at": _now_iso()},
                          filters={"document_id": f"eq.{doc}", "reservation_id": f"eq.{rid}",
                                   "reserved_at": "not.is.null", "settling_at": "is.null"})
            back = (rows_for([doc]) or {}).get(doc) or {}
        except Exception as e:  # noqa: BLE001 — the next sweep retries
            _failed("update", e, "[quota-ledger] could not claim the stale reservation of %s", doc)
            continue
        if back.get("release_token") != token:
            continue  # another sweeper claimed it (or the run adopted it)
        try:
            release(row)
        except Exception:  # noqa: BLE001
            logger.exception("[quota-ledger][billing] settling %s's stale reservation failed — the "
                             "row stays SETTLING (the meter may have moved) for the restore script", doc)
            continue
        logger.warning("[quota-ledger] settled the reservation of document %s (user=%s month=%s "
                       "extra=%s): its owner %s stopped heartbeating", doc, row.get("user_id"),
                       row.get("month"), bool(row.get("was_extra")), row.get("owner"))
        settled.append(row)
    return settled


_MAINTENANCE: Dict[str, Any] = {"thread": None}
_MAINTENANCE_LOCK = threading.Lock()


def maintenance_tick(*, live_ids: Callable[[], Iterable[str]],
                     is_live: Callable[[str], bool],
                     settle: Callable[[Dict[str, Any]], None] = release_rpcs) -> bool:
    """One tick of the maintenance daemon: retry the parked settlement
    writes, heartbeat this process's reservations, sweep the orphaned ones.
    False — nothing done, no call made — while the ledger is absent; the
    first tick after the window re-probes once."""
    if absent():
        return False
    retry_pending()
    heartbeat(list(live_ids()) + pending_ids())
    sweep_stale(is_live=lambda d: is_pending(d) or is_live(d), release=settle)
    return True


def start_maintenance(*, live_ids: Callable[[], Iterable[str]],
                      is_live: Callable[[str], bool],
                      settle: Callable[[Dict[str, Any]], None] = release_rpcs) -> bool:
    """Start (once per process) the daemon that heartbeats this process's
    reservations and sweeps the orphaned ones (`settle`: the engine commits
    one whose analysis finished, releases the rest). Off when the database
    is not configured or ENGINE_QUOTA_LEDGER_MAINTENANCE=0. True when
    running."""
    if os.environ.get("ENGINE_QUOTA_LEDGER_MAINTENANCE", "1") == "0":
        return False
    if not (os.environ.get("VITE_SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY")):
        return False
    with _MAINTENANCE_LOCK:
        if _MAINTENANCE["thread"] is not None:
            return True
        stop = threading.Event()

        def loop() -> None:
            while not stop.wait(HEARTBEAT_S):
                try:
                    maintenance_tick(live_ids=live_ids, is_live=is_live, settle=settle)
                except Exception:  # noqa: BLE001 — never kill the daemon
                    logger.exception("[quota-ledger] maintenance tick failed")

        t = threading.Thread(target=loop, name="quota-ledger-maintenance", daemon=True)
        _MAINTENANCE.update(thread=t, stop=stop)
        t.start()
    logger.info("[quota-ledger] maintenance started (owner=%s, heartbeat %ss, stale after %ss)",
                PROCESS_ID, HEARTBEAT_S, STALE_AFTER_S)
    return True
