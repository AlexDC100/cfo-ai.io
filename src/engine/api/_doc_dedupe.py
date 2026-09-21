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
               `sha256_hex` below; a row stored without one is hashed from
               its storage object before it is compared.
  * ACCOUNT  — `documents.uploaded_by` is the verified caller. The quota
               and the bill are per user; a colleague's copy is theirs.
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
  * running with `pipeline_started_at` set — it holds the reservation.

A queued row that never started is NOT an original: that is an upload whose
run was refused (a 402 the user dismissed) or has not been asked for yet.

TWO IDENTICAL UPLOADS AT ONCE. Both rows exist and both /run calls race.
`claim_or_duplicate` makes "look for an original, else stamp my own
`pipeline_started_at`" ONE step under a lock keyed by (company, account,
content): whichever run enters first claims, the second finds the first
running and is archived, so at most one of them is ever analysed and only
one reservation is ever made. A run that is then refused by the meter puts
its `pipeline_started_at` back (`release_claim`), so a dismissed 402 never
turns into an original. The lock is in-process: the engine serves from ONE
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


def pick_original(
    candidates: Iterable[Dict[str, Any]],
    *,
    hint: Any = None,
    self_row: Optional[Dict[str, Any]] = None,
    period_end_of: Optional[Dict[str, str]] = None,
) -> Optional[Dict[str, Any]]:
    """The live original among `candidates` (rows already narrowed to the
    same org + uploaded_by + content hash), or None.

    `self_row` is the document being checked when it already exists (the
    analysis entries); None for the pre-storage check. An analysed row wins
    over a running one; the earliest (created_at, id) within a class.
    """
    period_end_of = period_end_of or {}
    self_id = str((self_row or {}).get("id") or "")
    self_analyzed = str((self_row or {}).get("status") or "").lower() == "analyzed"
    self_key = (_ts((self_row or {}).get("created_at")), self_id)
    ranked: List[Tuple[int, str, str, Dict[str, Any]]] = []
    for row in candidates:
        rid = str(row.get("id") or "")
        if not rid or rid == self_id:
            continue
        if row.get("deleted_at"):
            continue
        status = str(row.get("status") or "").lower()
        if status == "failed":
            continue
        pid = row.get("period_id")
        if not same_period(hint, row.get("period_end_hint"), period_end_of.get(str(pid)) if pid else None):
            continue
        created = _ts(row.get("created_at"))
        if status == "analyzed":
            if self_analyzed and self_key[0] is not None and created is not None \
                    and (created, rid) > self_key:
                continue  # a LATER analysed copy never displaces the first one
            rank = 0
        elif status in RUNNING_STATUSES and row.get("pipeline_started_at"):
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


def _period_ends(org_id: str, period_ids: Sequence[str]) -> Dict[str, str]:
    ids = sorted({str(p) for p in period_ids if p})
    if not ids:
        return {}
    with _supabase.admin() as ac:
        rows = ac.select(
            "financial_periods",
            filters={"id": "in.(" + ",".join(ids) + ")", "org_id": f"eq.{org_id}"},
            columns="id,period_end",
        ) or []
    return {str(r["id"]): str(r.get("period_end") or "") for r in rows if r.get("id")}


def find_live_original(
    *,
    org_id: str,
    user_id: str,
    content_hash: str,
    hint: Any = None,
    self_row: Optional[Dict[str, Any]] = None,
) -> Optional[DuplicateHit]:
    """The live original of (company, account, content, period), or None."""
    h = normalize_hash(content_hash)
    if not (h and org_id and user_id):
        return None
    rows = _candidates(str(org_id), str(user_id), h)
    if not rows:
        return None
    period_end_of = _period_ends(str(org_id), [r.get("period_id") for r in rows]) if _date10(hint) else {}
    row = pick_original(rows, hint=hint, self_row=self_row, period_end_of=period_end_of)
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
                        hasher: Callable[[Dict[str, Any]], Optional[str]] = hash_stored_object) -> Optional[str]:
    """The document's content hash; computed from its stored bytes and
    written back when the row has none (rows landed by an older bundle or a
    path that never hashed). None when neither is available."""
    existing = normalize_hash(doc.get("content_hash"))
    if existing:
        return existing
    computed = normalize_hash(hasher(doc))
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


def claim_or_duplicate(doc: Dict[str, Any], user_id: str, *, now_iso: str, claim: bool,
                       hasher: Callable[[Dict[str, Any]], Optional[str]] = hash_stored_object,
                       ) -> Optional[DuplicateHit]:
    """THE analysis-entry check. Under the (company, account, content) lock:
    if `doc` duplicates a live original, archive it and return the hit;
    otherwise, when `claim` is set, stamp `doc`'s own `pipeline_started_at`
    (the claim a racing twin will find) and return None.

    A document whose hash cannot be established is let through unclaimed:
    the check can only refuse what it can prove."""
    if not doc or doc.get("deleted_at"):
        return None
    h = ensure_content_hash(doc, hasher)
    if not h:
        return None
    org_id = str(doc.get("org_id") or "")
    uid = str(user_id or "")
    with _lock_for(org_id, uid, h):
        hit = find_live_original(org_id=org_id, user_id=uid, content_hash=h,
                                 hint=doc.get("period_end_hint"), self_row=doc)
        if hit is not None:
            archive_as_duplicate(doc, hit, now_iso=now_iso)
            return hit
        if claim:
            with _supabase.admin() as ac:
                ac.update("documents", {"pipeline_started_at": now_iso},
                          filters={"id": f"eq.{doc.get('id')}", "org_id": f"eq.{org_id}"})
    return None


def release_claim(doc: Dict[str, Any]) -> None:
    """Undo `claim_or_duplicate`'s stamp after the meter refused the run
    (402 / 429 / an error): the row goes back to exactly what it was, so a
    dismissed extra-document dialog never leaves a phantom original and the
    stuck-upload watchdog still recognises the refused row."""
    try:
        with _supabase.admin() as ac:
            ac.update("documents", {"pipeline_started_at": doc.get("pipeline_started_at")},
                      filters={"id": f"eq.{doc.get('id')}", "org_id": f"eq.{doc.get('org_id')}"})
    except Exception:  # noqa: BLE001
        logger.exception("[dedupe] could not release the run claim on %s", doc.get("id"))


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
