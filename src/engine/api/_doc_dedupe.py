"""Duplicate uploads — ONE definition, used before storage and at every
analysis entry (engine.api._doc_dedupe).

WHY THIS EXISTS (measured in production, 2026-09-21)
====================================================
The owner's account showed 51 documents used in September for a handful of
unique books. The EEI PDF had been uploaded 13 times into one company and
Scandia FY2025 three or four times; 31 rows carried `metered_extra=true`,
18 of them re-uploads of a file the company already held and 12 of them
failures. The browser's only guard was a `window.confirm` whose OK button
uploaded the copy anyway, and nothing on the server looked at all.

THE DEFINITION (owner spec)
===========================
A document DUPLICATES a live one when all four agree:

  * CONTENT  — the same SHA-256 of the file bytes, 64 lowercase hex. The
               browser (`lib/supabase.ts::uploadDocument`) and the firm
               landing (`_firm_requests.land_file`) compute it exactly as
               `sha256_hex` below; at an analysis entry, a row stored
               without one — the new upload or an older copy of the same
               account and company (`_unhashed_candidates`, same size,
               bounded) — is hashed from its storage object before it is
               compared, and the hash is written back.
  * ACCOUNT  — `documents.uploaded_by`: the new upload's own uploader,
               and only when that is the verified caller (`dedupe_account`).
               The quota and the bill are per user; a colleague's copy is
               theirs, and a colleague's entry never archives an upload.
  * COMPANY  — `documents.org_id` is the same workspace. The same file in
               a DIFFERENT company is not a duplicate.
  * PERIOD   — when the new upload carries a user-confirmed closing date
               (`period_end_hint`), the original matches only if its own
               date — its hint, else the period it was analysed into — is
               unknown or equal. Without a hint the same bytes are the same
               period.

A duplicate is NOT stored, NOT analysed and NOT counted. The browser asks
`POST /api/documents/duplicate-check` before it writes a byte to storage;
`POST /api/pipeline/run` (and retry, recover-stuck, the stuck-SKU watchdog
and the firm landing) repeat the check so a stale tab, a second tab or a
racing double-drop cannot slip past it.

WHAT COUNTS AS THE LIVE ORIGINAL
================================
Not deleted, not failed, and either

  * analysed — when the document being checked is itself analysed (a
    re-run of an old copy), only an EARLIER analysed copy (created_at, id)
    counts, so the first copy is always the one kept; or
  * running with `pipeline_started_at` set AND its run in flight in this
    process — it holds the reservation. A run a restart killed is not.

A queued row that never started is NOT an original: that is an upload whose
run was refused (a 402 the user dismissed) or has not been asked for yet.

TWO IDENTICAL UPLOADS AT ONCE. Both rows exist and both /run calls race.
`enter_analysis` makes "look for an original, else stamp my own
`pipeline_started_at`" ONE step under a lock keyed by (company, account,
content): whichever run enters first claims, the second finds the first
running and is archived, so at most one of them is ever analysed and only
one reservation is ever made. EVERY analysis entry takes that step — /run,
retry, recover-stuck and the stuck-SKU watchdog — so a recovery and a twin
/run cannot both claim either. A run that is then refused by the meter puts
its `pipeline_started_at` back (`release_claim`), so a dismissed 402 never
turns into an original.

ONE RUN PER DOCUMENT. The same step claims the document ITSELF in the
in-flight registry (a test-and-set): a second entry for a document whose
run is in flight, or a first analysis of a document already analysed,
reserves nothing and enqueues nothing. The lock is in-process: the engine serves from ONE
uvicorn process (Dockerfile CMD). A second process would reopen a window of
a few milliseconds between two runs' reads and writes — the price of having
no unique index to lean on (the table already holds duplicates in
production, so one cannot be added without archiving them first).

HOW A SERVER-SIDE DUPLICATE IS REPRESENTED
==========================================
The new row is ARCHIVED, never hard-deleted and its storage object never
touched: `deleted_at` is set and `error` carries `duplicate_of:<original
id>` — the typed marker every counter and billing seam reads
(`is_archived_duplicate`). Its status is set to `analyzed` so a tab still
watching the row (one loaded before this code shipped) sees a terminal
state and not an endless spinner; it is excluded from the Recently-deleted
shelf and from "clear recently deleted", and it is never committed, counted
or billed (`pipeline._commit_pipeline_quota` refuses it — by this process's
own record, `archived_here`, never by the browser-writable marker).
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from . import _supabase

logger = logging.getLogger(__name__)

#: Prefix of the `documents.error` marker on an archived duplicate.
DUPLICATE_MARKER_PREFIX = "duplicate_of:"

#: The pipeline's in-flight statuses (schema_phase3.sql documents_status_check).
RUNNING_STATUSES = frozenset({"queued", "extracting", "mapping", "computing", "narrating"})

_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_IDISH = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


# ──────────────────────────────────────────────────────────────────────
# Pure helpers
# ──────────────────────────────────────────────────────────────────────

def sha256_hex(data: bytes) -> str:
    """The content hash, exactly as the browser computes it
    (`crypto.subtle.digest('SHA-256')` → lowercase hex)."""
    return hashlib.sha256(data).hexdigest()


def normalize_hash(value: Any) -> Optional[str]:
    """A stored or submitted hash, lower-cased; None unless it is 64 hex."""
    s = str(value or "").strip().lower()
    return s if _HEX64.match(s) else None


def duplicate_marker(original_id: str) -> str:
    return f"{DUPLICATE_MARKER_PREFIX}{original_id}"


def duplicate_of(error: Any) -> Optional[str]:
    """The original's id named by an archived duplicate's marker, else None."""
    s = str(error or "")
    if not s.startswith(DUPLICATE_MARKER_PREFIX):
        return None
    rest = s[len(DUPLICATE_MARKER_PREFIX):].strip()
    ident = rest.split()[0] if rest else ""
    return ident if _IDISH.match(ident) else None


def is_archived_duplicate(row: Optional[Dict[str, Any]]) -> bool:
    """True for a row carrying the archived-duplicate marker. `deleted_at`
    alone is a user's delete and proves nothing.

    DISPLAY AND AUDIT ONLY. Every column of `documents` is browser-writable
    (RLS is `is_member_of(org_id)` with no column restriction), so a marker
    on a row proves nothing to a BILLING seam: the settlement asks
    `archived_here`, which only this process can answer."""
    return bool(row) and duplicate_of((row or {}).get("error")) is not None


# Documents THIS process archived as duplicates — the one signal the
# settlement (`pipeline._commit_pipeline_quota`) trusts. A browser that
# writes the marker onto its own row to have a successful analysis released
# instead of committed finds nothing here.
_ARCHIVED_HERE: "set[str]" = set()
_ARCHIVED_HERE_LOCK = threading.Lock()


def archived_here(document_id: str) -> bool:
    with _ARCHIVED_HERE_LOCK:
        return str(document_id) in _ARCHIVED_HERE


def _date10(value: Any) -> Optional[str]:
    s = str(value or "").strip()[:10]
    return s if re.match(r"^\d{4}-\d{2}-\d{2}$", s) else None


def same_period(new_hint: Any, orig_hint: Any, orig_period_end: Any) -> bool:
    """The PERIOD clause. No hint on the new upload → the same bytes are the
    same period. A hint → the original's own date (its hint, else its
    analysed period's end) must be unknown or equal."""
    new = _date10(new_hint)
    if new is None:
        return True
    orig = _date10(orig_hint) or _date10(orig_period_end)
    return orig is None or orig == new


_ISO_PARTS = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?(.*)$")


def _ts(value: Any) -> Optional[datetime]:
    """A PostgREST timestamp → aware datetime. Tolerates `Z`, a space
    separator and any number of fractional digits (PostgREST trims trailing
    zeros — `.00934` — which `fromisoformat` rejects before Python 3.11)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    s = str(value).strip()
    m = _ISO_PARTS.match(s)
    if m:
        frac = (m.group(3) or "")[:6]
        tz = (m.group(4) or "").strip().replace("Z", "+00:00")
        s = "%sT%s%s%s" % (m.group(1), m.group(2), ("." + frac.ljust(6, "0")) if frac else "", tz)
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


#: What an analysed copy holds (`_analysis_state`).
_HOLDS, _ORPHAN, _SUPERSEDED = "holds", "orphan", "superseded"


def _analysis_state(row: Dict[str, Any], period_source_of: Optional[Dict[str, Optional[str]]]) -> str:
    """Does this analysed copy still HOLD its analysis?

      * holds      — a financial copy whose period exists in this company and
                     names it as its source (or names none); any SKU copy
                     (SKU analyses carry no period);
      * orphan     — a financial copy with no period (a /retry of a twin
                     deleted the shared period: `documents.period_id` is
                     ON DELETE SET NULL), or whose period is gone;
      * superseded — its period now shows ANOTHER document (the pipeline's
                     duplicate-month REPLACE re-pointed the month).
    `period_source_of` None = the periods could not be read: every copy is
    taken to hold (the check can only refuse what it can prove)."""
    if str(row.get("scope") or "financial").lower() != "financial":
        return _HOLDS
    pid = row.get("period_id")
    if not pid:
        return _ORPHAN
    if period_source_of is None:
        return _HOLDS
    if str(pid) not in period_source_of:
        return _ORPHAN
    src = period_source_of.get(str(pid))
    return _HOLDS if (not src or str(src) == str(row.get("id"))) else _SUPERSEDED


def pick_original(
    candidates: Iterable[Dict[str, Any]],
    *,
    hint: Any = None,
    self_row: Optional[Dict[str, Any]] = None,
    period_end_of: Optional[Dict[str, str]] = None,
    run_is_live: Optional[Callable[[str], bool]] = None,
    period_source_of: Optional[Dict[str, Optional[str]]] = None,
) -> Optional[Dict[str, Any]]:
    """The live original among `candidates` (rows already narrowed to the
    same org + uploaded_by + content hash), or None.

    `self_row` is the document being checked when it already exists (the
    analysis entries); None for the pre-storage check. An analysed row wins
    over a running one; the earliest (created_at, id) within a class.

    A RUNNING row is an original only while its run is alive —
    `run_is_live(id)`, by default: in flight in THIS process (the engine is
    one process). A run a restart killed leaves its row 'extracting' with
    `pipeline_started_at` set and nothing ever marks it failed; it used to
    block every re-upload of that file for good ("Already uploaded — open
    it", pointing at a run that will never finish).

    An ANALYSED row is an original only while it holds its analysis
    (`_analysis_state`, over `period_source_of` = period id → its
    source_document_id). A SUPERSEDED copy — its month now shows another
    document — never is: re-uploading the file to put the month back was
    refused, and "open it" opened someone else's analysis. An ORPHAN copy
    (no period) is one only when no copy — the one being checked included —
    holds an analysis: "open it" must lead to the copy that has one, and
    re-running the copy that owns the live period must not archive it
    against an orphan. The first-copy-wins rule (a LATER analysed copy never
    displaces the one being checked) applies when the one being checked
    holds its analysis.
    """
    period_end_of = period_end_of or {}
    if run_is_live is None:
        run_is_live = lambda rid: in_flight(rid) is not None  # noqa: E731
    rows = list(candidates)
    self_id = str((self_row or {}).get("id") or "")
    self_analyzed = str((self_row or {}).get("status") or "").lower() == "analyzed"
    self_state = _analysis_state(self_row, period_source_of) if (self_row and self_analyzed) else None
    self_key = (_ts((self_row or {}).get("created_at")), self_id)

    def eligible(row: Dict[str, Any]) -> bool:
        rid = str(row.get("id") or "")
        if not rid or rid == self_id or row.get("deleted_at"):
            return False
        if str(row.get("status") or "").lower() == "failed":
            return False
        pid = row.get("period_id")
        return same_period(hint, row.get("period_end_hint"),
                           period_end_of.get(str(pid)) if pid else None)

    pool = [r for r in rows if eligible(r)]
    someone_holds = self_state == _HOLDS or any(
        str(r.get("status") or "").lower() == "analyzed"
        and _analysis_state(r, period_source_of) == _HOLDS for r in pool)
    first_copy_wins = self_analyzed and (
        self_state == _HOLDS or (self_state == _ORPHAN and not someone_holds))

    ranked: List[Tuple[int, str, str, Dict[str, Any]]] = []
    for row in pool:
        rid = str(row.get("id") or "")
        status = str(row.get("status") or "").lower()
        created = _ts(row.get("created_at"))
        if status == "analyzed":
            state = _analysis_state(row, period_source_of)
            if state == _SUPERSEDED or (state == _ORPHAN and someone_holds):
                continue
            if first_copy_wins and self_key[0] is not None and created is not None \
                    and (created, rid) > self_key:
                continue  # a LATER analysed copy never displaces the first one
            rank = 0
        elif status in RUNNING_STATUSES and row.get("pipeline_started_at") and run_is_live(rid):
            rank = 1
        else:
            continue
        ranked.append((rank, created.isoformat() if created else "", rid, row))
    if not ranked:
        return None
    ranked.sort(key=lambda t: (t[0], t[1], t[2]))
    return ranked[0][3]


# ──────────────────────────────────────────────────────────────────────
# The per-(company, account, content) lock
# ──────────────────────────────────────────────────────────────────────

_LOCK_STRIPES = [threading.Lock() for _ in range(64)]


def _lock_for(org_id: str, user_id: str, content_hash: str) -> "threading.Lock":
    key = hashlib.sha256(f"{org_id}|{user_id}|{content_hash}".encode("utf-8")).digest()
    return _LOCK_STRIPES[key[0] % len(_LOCK_STRIPES)]


def _doc_lock(document_id: str) -> "threading.Lock":
    """The lock of a document whose content hash is not known: its entries
    still serialise against each other (the per-document claim below), they
    just cannot be compared with a twin."""
    key = hashlib.sha256(f"doc|{document_id}".encode("utf-8")).digest()
    return _LOCK_STRIPES[key[0] % len(_LOCK_STRIPES)]


def analysis_lock(org_id: str, user_id: str, content_hash: str) -> "threading.Lock":
    """The (company, account, content) lock, for an entry that creates its
    row inside it (the firm landing): look for an original, reserve and
    insert as one step, exactly as `enter_analysis` does for a row that
    already exists."""
    return _lock_for(str(org_id or ""), str(user_id or ""), str(content_hash or ""))


# ──────────────────────────────────────────────────────────────────────
# One run per document — the in-flight registry
# ──────────────────────────────────────────────────────────────────────
#
# MEASURED (verifier, 2026-09-21): `/api/pipeline/run` never asked whether
# THIS document already had its run. The failed-upload banner's Retry posts
# /run on the SAME id — and a `failed` banner can be a transport failure for
# a run the server did start (CLAUDE.md §24) — so one book was reserved and
# committed twice, or two reservations shared one ledger entry and one of
# them stayed in `uploads_reserved` for good. The same held for
# recover-stuck and the SKU watchdog racing each other on one page mount.
#
# The registry below is the per-document claim: a document id is in it from
# the moment an entry claims it until its daemon thread's terminal
# (`pipeline._run_pipeline_sync`) or the entry giving the claim back
# (`release_claim`). `try_mark_in_flight` is a test-and-set, so of two
# entries for one document exactly one claims. In-process on purpose, like
# the lock stripes above and the reservation ledger in pipeline.py: the
# engine is ONE uvicorn process, and a run that a restart killed is, after
# the restart, correctly NOT in flight.

#: "claiming" — an entry holds the claim and is still asking the meter;
#: "running"  — the run was handed to its daemon thread.
CLAIMING = "claiming"
RUNNING = "running"

_IN_FLIGHT: Dict[str, str] = {}
_IN_FLIGHT_LOCK = threading.Lock()


def try_mark_in_flight(document_id: str) -> bool:
    """Claim `document_id` for one run. False when another entry holds it."""
    key = str(document_id or "")
    if not key:
        return False
    with _IN_FLIGHT_LOCK:
        if key in _IN_FLIGHT:
            return False
        _IN_FLIGHT[key] = CLAIMING
        return True


def mark_running(document_id: str) -> None:
    """The claimed run was handed to its daemon thread."""
    with _IN_FLIGHT_LOCK:
        if str(document_id) in _IN_FLIGHT:
            _IN_FLIGHT[str(document_id)] = RUNNING


def in_flight(document_id: str) -> Optional[str]:
    """The phase of `document_id`'s run in this process, or None."""
    with _IN_FLIGHT_LOCK:
        return _IN_FLIGHT.get(str(document_id or ""))


def clear_in_flight(document_id: str) -> None:
    with _IN_FLIGHT_LOCK:
        _IN_FLIGHT.pop(str(document_id or ""), None)


def await_decision(document_id: str, *, timeout_s: float = 3.0, poll_s: float = 0.05) -> Optional[str]:
    """Wait (bounded) while another entry holds `document_id` in the
    CLAIMING phase — it is asking the meter and will either start the run
    or give the claim back. Returns the phase it settled in (None = the
    claim was given back)."""
    import time
    deadline = time.monotonic() + max(0.0, timeout_s)
    phase = in_flight(document_id)
    while phase == CLAIMING and time.monotonic() < deadline:
        time.sleep(poll_s)
        phase = in_flight(document_id)
    return phase


# ──────────────────────────────────────────────────────────────────────
# Database seams (service role; every caller has already verified the
# identity and the membership of the org it passes in)
# ──────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class DuplicateHit:
    """The live original a new upload duplicates."""
    existing_document_id: str
    period_id: Optional[str]
    original_filename: Optional[str]
    status: str

    def to_payload(self) -> Dict[str, Any]:
        return {
            "duplicate": True,
            "existing_document_id": self.existing_document_id,
            "period_id": self.period_id,
            "original_filename": self.original_filename,
            "status": self.status,
        }


def _hit(row: Dict[str, Any]) -> DuplicateHit:
    return DuplicateHit(
        existing_document_id=str(row.get("id")),
        period_id=(str(row["period_id"]) if row.get("period_id") else None),
        original_filename=row.get("original_filename"),
        status=str(row.get("status") or ""),
    )


def _candidates(org_id: str, user_id: str, content_hash: str) -> List[Dict[str, Any]]:
    # columns="*": `period_end_hint` is an optional migration; naming it
    # would 400 on a database that lacks it.
    with _supabase.admin() as ac:
        return list(ac.select(
            "documents",
            filters={
                "org_id": f"eq.{org_id}",
                "uploaded_by": f"eq.{user_id}",
                "content_hash": f"eq.{content_hash}",
                "deleted_at": "is.null",
            },
            order="created_at.asc",
        ) or [])


def _period_info(org_id: str, period_ids: Sequence[Any]) -> Optional[Dict[str, Dict[str, Any]]]:
    """period id → {period_end, source_document_id} for the periods of THIS
    company among `period_ids`. None when they cannot be read."""
    ids = sorted({str(p) for p in period_ids if p})
    if not ids:
        return {}
    try:
        with _supabase.admin() as ac:
            rows = ac.select(
                "financial_periods",
                filters={"id": "in.(" + ",".join(ids) + ")", "org_id": f"eq.{org_id}"},
                columns="id,period_end,source_document_id",
            ) or []
    except Exception:  # noqa: BLE001 — unknown periods prove nothing
        logger.exception("[dedupe] could not read the periods of org %s", org_id)
        return None
    return {str(r["id"]): {"period_end": str(r.get("period_end") or ""),
                           "source_document_id": r.get("source_document_id")}
            for r in rows if r.get("id")}


#: At most this many hash-less copies are hashed from storage per entry.
LEGACY_HASH_LIMIT = 5


def _unhashed_candidates(org_id: str, user_id: str, self_row: Dict[str, Any],
                         hasher: Callable[[Dict[str, Any]], Optional[str]],
                         content_hash: str) -> List[Dict[str, Any]]:
    """Copies of the same account and company stored WITHOUT a content hash
    (an older bundle, a path that never hashed) that turn out to hold the
    same bytes. Hashed from their storage objects — only analysed or
    running ones, only of the same size when both sizes are known, at most
    LEGACY_HASH_LIMIT per entry — and the hash is written back, so each is
    hashed once, ever."""
    filters = {
        "org_id": f"eq.{org_id}",
        "uploaded_by": f"eq.{user_id}",
        "content_hash": "is.null",
        "deleted_at": "is.null",
        "status": "in.(" + ",".join(["analyzed"] + sorted(RUNNING_STATUSES)) + ")",
    }
    size = self_row.get("size_bytes")
    if isinstance(size, int) and size > 0:
        filters["size_bytes"] = f"eq.{size}"
    try:
        with _supabase.admin() as ac:
            rows = list(ac.select("documents", filters=filters, order="created_at.asc",
                                  limit=LEGACY_HASH_LIMIT) or [])
    except Exception:  # noqa: BLE001 — legacy copies we cannot read prove nothing
        logger.exception("[dedupe] could not list hash-less copies in org %s", org_id)
        return []
    same = []
    for row in rows:
        if str(row.get("id")) == str(self_row.get("id")):
            continue
        if ensure_content_hash(row, hasher) == content_hash:
            same.append(row)
    return same


def find_live_original(
    *,
    org_id: str,
    user_id: str,
    content_hash: str,
    hint: Any = None,
    self_row: Optional[Dict[str, Any]] = None,
    hasher: Optional[Callable[[Dict[str, Any]], Optional[str]]] = None,
) -> Optional[DuplicateHit]:
    """The live original of (company, account, content, period), or None.

    For an analysis entry (`self_row` given) copies stored without a hash
    are hashed from storage and compared too (`_unhashed_candidates`); the
    pre-storage check, which runs while the browser waits, compares hashed
    copies only — /run repeats the check before anything is reserved."""
    h = normalize_hash(content_hash)
    if not (h and org_id and user_id):
        return None
    rows = _candidates(str(org_id), str(user_id), h)
    if self_row is not None:
        rows = rows + _unhashed_candidates(str(org_id), str(user_id), self_row,
                                           hasher or hash_stored_object, h)
    if not rows:
        return None
    info = _period_info(str(org_id), [r.get("period_id") for r in rows]
                        + [(self_row or {}).get("period_id")])
    period_end_of = {pid: v["period_end"] for pid, v in (info or {}).items()}
    period_source_of = ({pid: v.get("source_document_id") for pid, v in info.items()}
                        if info is not None else None)
    row = pick_original(rows, hint=hint, self_row=self_row, period_end_of=period_end_of,
                        period_source_of=period_source_of)
    return _hit(row) if row else None


def hash_stored_object(doc: Dict[str, Any]) -> Optional[str]:
    """SHA-256 of a document's stored bytes, or None when they cannot be
    read. Tenant-checked by `signed_url` (the path must sit under the row's
    own org)."""
    path = doc.get("storage_path")
    if not path:
        return None
    try:
        import httpx
        with _supabase.admin() as ac:
            signed = ac.signed_url("documents", path, org_id=doc.get("org_id"), expires_in=120)
        with httpx.Client(timeout=60.0) as http:
            r = http.get(signed)
            r.raise_for_status()
            return sha256_hex(r.content)
    except Exception as exc:  # noqa: BLE001 — a hash we cannot compute proves no duplicate
        logger.warning("[dedupe] cannot hash stored bytes of document %s (%s: %s)",
                       doc.get("id"), type(exc).__name__, str(exc)[:160])
        return None


def ensure_content_hash(doc: Dict[str, Any],
                        hasher: Optional[Callable[[Dict[str, Any]], Optional[str]]] = None) -> Optional[str]:
    """The document's content hash; computed from its stored bytes and
    written back when the row has none (rows landed by an older bundle or a
    path that never hashed). None when neither is available."""
    existing = normalize_hash(doc.get("content_hash"))
    if existing:
        return existing
    computed = normalize_hash((hasher or hash_stored_object)(doc))
    if not computed:
        return None
    try:
        with _supabase.admin() as ac:
            ac.update("documents", {"content_hash": computed},
                      filters={"id": f"eq.{doc.get('id')}", "org_id": f"eq.{doc.get('org_id')}"})
    except Exception:  # noqa: BLE001 — the comparison below still uses it
        logger.exception("[dedupe] could not persist content_hash for %s", doc.get("id"))
    doc["content_hash"] = computed
    return computed


def archive_as_duplicate(doc: Dict[str, Any], hit: DuplicateHit, *, now_iso: str) -> None:
    """Archive the NEW row: soft-delete + the typed marker naming the
    original. Never a hard delete; the storage object is left untouched."""
    patch: Dict[str, Any] = {
        "deleted_at": now_iso,
        "status": "analyzed",
        "error": duplicate_marker(hit.existing_document_id),
    }
    with _ARCHIVED_HERE_LOCK:
        _ARCHIVED_HERE.add(str(doc.get("id")))
    with _supabase.admin() as ac:
        ac.update("documents", patch, filters={
            "id": f"eq.{doc.get('id')}",
            "org_id": f"eq.{doc.get('org_id')}",
        })
    logger.info("[dedupe] document %s archived as a duplicate of %s (org=%s)",
                doc.get("id"), hit.existing_document_id, doc.get("org_id"))


def release_claim(doc: Dict[str, Any]) -> None:
    """Undo a claim after the meter refused the run (402 / 429 / an error):
    the row goes back to exactly what it was (`doc` carries the prior
    `pipeline_started_at`), so a dismissed extra-document dialog never
    leaves a phantom original and the stuck-upload watchdog still
    recognises the refused row — and the document leaves the in-flight
    registry, so the next entry may claim it."""
    try:
        with _supabase.admin() as ac:
            ac.update("documents", {"pipeline_started_at": doc.get("pipeline_started_at")},
                      filters={"id": f"eq.{doc.get('id')}", "org_id": f"eq.{doc.get('org_id')}"})
    except Exception:  # noqa: BLE001
        logger.exception("[dedupe] could not release the run claim on %s", doc.get("id"))
    finally:
        clear_in_flight(str(doc.get("id") or ""))


# ──────────────────────────────────────────────────────────────────────
# THE analysis entry — one step for /run, retry, recover-stuck, the watchdog
# ──────────────────────────────────────────────────────────────────────

#: POST /api/pipeline/run — the metered FIRST analysis of an upload.
FIRST = "first"
#: POST /api/pipeline/retry — an unmetered re-run of the stored bytes.
RERUN = "rerun"
#: recover-stuck and the SKU watchdog — a /run that was refused or lost.
RECOVER = "recover"

#: The entry claimed the document: the caller reserves (or not) and either
#: hands the run to its thread or gives the claim back (`release_claim`).
CLAIMED = "claimed"
#: The document duplicates a live original (now archived), or already is
#: an archived duplicate. Nothing is reserved, analysed or counted.
DUPLICATE = "duplicate"
#: Another entry holds this document's run (in flight in this process), or
#: — for a recovery — it is no longer a stuck, never-started upload.
BUSY = "busy"
#: A first analysis asked for a document that is already analysed.
DONE = "done"
#: The document is deleted (a user's soft delete): no entry analyses it.
DELETED = "deleted"
#: A recovery of an upload that is not the caller's own: a colleague's
#: upload is theirs to recover (and to be charged for), never the caller's.
NOT_MINE = "not_mine"


def dedupe_account(row: Dict[str, Any], caller_id: str) -> Optional[str]:
    """The ACCOUNT an analysis entry checks for duplicates under: the
    document's OWN uploader — and only when that uploader is the verified
    caller making this entry and a member of the document's company.

    It used to be whoever called the route (verifier, 2026-09-21): OWNER's
    dashboard mount (FinancialStatements calls recover-stuck on every
    mount) archived a colleague's upload as a duplicate of OWNER's own copy
    — breaking the ACCOUNT clause ("another account in the same company:
    not a duplicate") — and dropped it from the Recently-deleted shelf where
    the colleague could have restored it. Companies with several members
    exist today (the firm client import makes the importer and the
    responsible accountant both members). None → the entry never archives."""
    uploader = str(row.get("uploaded_by") or "").strip()
    caller = str(caller_id or "").strip()
    org = str(row.get("org_id") or "").strip()
    if not uploader or uploader != caller or not org:
        return None
    try:
        from . import _org
        if not _org.user_is_member(uploader, org):
            return None
    except Exception:  # noqa: BLE001 — an unverifiable account proves no duplicate
        logger.exception("[dedupe] membership of %s in %s could not be read", uploader, org)
        return None
    return uploader


@dataclass(frozen=True)
class Entry:
    """What `enter_analysis` decided for one document."""
    kind: str
    row: Dict[str, Any]
    hit: Optional[DuplicateHit] = None
    #: `pipeline_started_at` before the claim — what `release_claim` restores.
    prior_claim: Any = None

    @property
    def status(self) -> str:
        return str(self.row.get("status") or "")

    @property
    def period_id(self) -> Optional[str]:
        pid = self.row.get("period_id")
        return str(pid) if pid else None

    def released_row(self) -> Dict[str, Any]:
        """The row to hand `release_claim`: its prior claim restored."""
        return {**self.row, "pipeline_started_at": self.prior_claim}


def _fresh_row(document_id: str, org_id: str) -> Optional[Dict[str, Any]]:
    """The document as it is NOW (the route's copy was read before the
    lock). None when it cannot be read."""
    try:
        with _supabase.admin() as ac:
            rows = ac.select("documents", filters={
                "id": f"eq.{document_id}", "org_id": f"eq.{org_id}",
            }, single=True) or []
    except Exception:  # noqa: BLE001 — the caller's copy stands in
        logger.exception("[dedupe] could not re-read document %s", document_id)
        return None
    return dict(rows[0]) if rows else None


def _hit_for_marker(original_id: str, org_id: str) -> DuplicateHit:
    """The hit an archived duplicate's own marker names — read back so the
    answer links to where the original's analysis lives."""
    try:
        with _supabase.admin() as ac:
            rows = ac.select("documents", filters={
                "id": f"eq.{original_id}", "org_id": f"eq.{org_id}",
            }, single=True) or []
    except Exception:  # noqa: BLE001 — the marker alone still refuses
        rows = []
    if rows:
        return _hit(rows[0])
    return DuplicateHit(existing_document_id=str(original_id), period_id=None,
                        original_filename=None, status="")


def enter_analysis(doc: Dict[str, Any], caller_id: str, *, now_iso: str, mode: str,
                   hasher: Optional[Callable[[Dict[str, Any]], Optional[str]]] = None,
                   ) -> Entry:
    """THE analysis-entry decision, one step under the (company, account,
    content) lock — the document-id lock when its content hash is unknown:

      * the document already has its run in this process   → BUSY
      * a FIRST analysis of a document already analysed     → DONE
      * a RECOVERY of a row that is no longer queued-and-
        never-started (a /run claimed it meanwhile)          → BUSY
      * a RECOVERY of an upload that is not the caller's own  → NOT_MINE
      * it duplicates a live original of the same account
        (`dedupe_account`: the document's own uploader, when
        that is the caller), company and period              → archived, DUPLICATE
      * otherwise the document is CLAIMED: in the in-flight
        registry (test-and-set) and `pipeline_started_at`
        stamped — the claim a racing twin finds              → CLAIMED

    Only a CLAIMED entry may reserve and enqueue. Every other outcome
    reserves nothing — which is what makes /run on the same id twice (the
    failed-banner Retry of a run the server did start) count once.

    A DELETED row is refused FIRST, before any reservation and before any
    write (verifier P-F): an archived duplicate answers DUPLICATE with the
    original its marker names — its marker is never erased and it is never
    re-run, whatever this process remembers (`_ARCHIVED_HERE` is emptied by
    every restart) — and a user's soft delete answers DELETED."""
    doc_id = str(doc.get("id") or "")
    org_id = str(doc.get("org_id") or "")
    account = dedupe_account(doc, caller_id)
    if mode == RECOVER and account is None:
        return Entry(NOT_MINE, dict(doc))
    h = ensure_content_hash(doc, hasher) if account else None
    lock = _lock_for(org_id, account, h) if h else _doc_lock(doc_id)
    with lock:
        row = _fresh_row(doc_id, org_id) or dict(doc)
        if h and not row.get("content_hash"):
            row["content_hash"] = h
        if row.get("deleted_at"):
            original = duplicate_of(row.get("error"))
            if original:
                return Entry(DUPLICATE, row, hit=_hit_for_marker(original, org_id))
            return Entry(DELETED, row)
        if in_flight(doc_id):
            return Entry(BUSY, row)
        status = str(row.get("status") or "").lower()
        if mode == FIRST and status == "analyzed":
            return Entry(DONE, row)
        if mode == RECOVER and (status != "queued" or row.get("pipeline_started_at")):
            return Entry(BUSY, row)
        if h:
            hit = find_live_original(org_id=org_id, user_id=account, content_hash=h,
                                     hint=row.get("period_end_hint"), self_row=row,
                                     hasher=hasher)
            if hit is not None:
                archive_as_duplicate(row, hit, now_iso=now_iso)
                return Entry(DUPLICATE, row, hit=hit)
        if not try_mark_in_flight(doc_id):
            return Entry(BUSY, row)
        prior = row.get("pipeline_started_at")
        try:
            with _supabase.admin() as ac:
                ac.update("documents", {"pipeline_started_at": now_iso},
                          filters={"id": f"eq.{doc_id}", "org_id": f"eq.{org_id}"})
        except Exception:
            clear_in_flight(doc_id)
            raise
        return Entry(CLAIMED, row, prior_claim=prior)


# ──────────────────────────────────────────────────────────────────────
# Unique successful documents — what the quota banner shows
# ──────────────────────────────────────────────────────────────────────

def month_of(ts: Any) -> Optional[str]:
    dt = _ts(ts)
    return dt.astimezone(timezone.utc).strftime("%Y-%m") if dt else None


def unique_successful(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The documents that count: analysed, not an archived duplicate, one per
    (org, content, period). Rows without a hash are unique by id — nothing
    proves them equal. A later copy with a DIFFERENT confirmed date is a
    different period; one without a date collapses into the first copy.
    Returned in created order (the first of each group represents it)."""
    kept: List[Dict[str, Any]] = []
    groups: Dict[Tuple[str, str], List[Optional[str]]] = {}
    for row in sorted(rows, key=lambda r: (str(r.get("created_at") or ""), str(r.get("id") or ""))):
        if str(row.get("status") or "").lower() != "analyzed" or is_archived_duplicate(row):
            continue
        h = normalize_hash(row.get("content_hash"))
        if not h:
            kept.append(row)
            continue
        key = (str(row.get("org_id") or ""), h)
        date = _date10(row.get("period_end_hint"))
        seen = groups.setdefault(key, [])
        if any(date is None or s is None or s == date for s in seen):
            continue
        seen.append(date)
        kept.append(row)
    return kept


def unique_successful_docs_in_month(user_id: str, month: str) -> Optional[int]:
    """Unique successful documents `user_id` uploaded in `month` (YYYY-MM,
    UTC). None when the documents cannot be read — the caller falls back to
    the counter rather than showing a made-up zero."""
    try:
        start = datetime.strptime(month + "-01", "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    nxt = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    try:
        # Only the companies the user is a MEMBER of: `uploaded_by` is
        # browser-written, so a row filed in someone else's workspace naming
        # this user must not move this user's count.
        from . import _org
        orgs = sorted(set(_org.member_org_ids(str(user_id))))
        if not orgs:
            return 0
        with _supabase.admin() as ac:
            rows = ac.select(
                "documents",
                filters={
                    "org_id": "in.(" + ",".join(orgs) + ")",
                    "uploaded_by": f"eq.{user_id}",
                    "status": "eq.analyzed",
                    "and": "(created_at.gte.%s,created_at.lt.%s)" % (
                        start.strftime("%Y-%m-%dT%H:%M:%SZ"), nxt.strftime("%Y-%m-%dT%H:%M:%SZ")),
                },
                order="created_at.asc",
            ) or []
    except Exception:  # noqa: BLE001
        logger.exception("[dedupe] unique-document count failed for user=%s", user_id)
        return None
    return len(unique_successful(rows))
