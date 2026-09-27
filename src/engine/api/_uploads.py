"""ONE COMPANY PER WORKSPACE — the upload flow's backend (2026-09-21).

A workspace IS an organization, and under the redesign an organization IS
one company, keyed by its CUI. The CUI lives in ``org_prefs.prefs.cui``
(beside ``company_name`` and ``identity_sources``): production has no
``organizations.cui`` column and this change ships no DDL, so nothing here
reads or writes one.

THREE ROUTES
  POST /api/uploads/identify        what is this file? Stores nothing,
                                    reserves nothing.
  POST /api/uploads/commit          store it in the company the user
                                    confirmed, and analyse it.
  GET  /api/companies/{org_id}/years  one tile per year, from the served
                                    figures.

THE RULES THIS MODULE HOLDS
  G1  A file whose document CUI belongs to another of the caller's
      companies is routed to THAT company, whichever company is on screen.
      A CUI none of them holds is a new company. No readable CUI → the
      company on screen, stated on the card so the user can change it.
  G2  The period is read off the DOCUMENT's own period line — the header
      detector's, else (a PDF) the one the verified balanta reader reads off
      the title block (`printed_period_of_pdf`). A period the identifier
      could only have taken from the file NAME is dropped (ABSENT, the card
      asks), never offered; commit refuses a missing or implausible period
      instead of inventing one, and files the document with that confirmed
      period as its `period_end_hint`.
  G4  Nothing here creates a `financial_periods` row. The only writer is
      the pipeline's `stage_persist`, after extraction, and a run that then
      fails removes the row it inserted (pipeline
      `_rollback_period_of_failed_run`). The years route lists only periods
      whose source document is live and analysed.
  DUP The same bytes (content hash) uploaded by the same account into the
      same company for the same period are not stored, not analysed and not
      counted — ONE definition, `_doc_dedupe` (the one /api/pipeline/run and
      /api/documents/duplicate-check use): identify reports the existing
      document, commit answers `status: "duplicate"` before the meter is
      touched, and a twin that races past that check is archived at the
      same analysis entry the run takes (`_doc_dedupe.enter_analysis`).

WALLS
  Every route verifies the bearer (`_org.verified_user_id`). identify
  validates `X-Org-Id` membership (`_org.resolve_org`: 403 on a company the
  caller is not a member of). commit takes its target through
  `_org.require_org_member` (403 otherwise) — never firm visibility, never a
  fallback to another company. years is membership-checked the same way.
  Reads go through the CALLER's own client (`_supabase.per_user`), so RLS is
  the second wall; the one service-role call is the storage write, whose
  path `upload_object` refuses unless its first segment is the target org.

THE METER is `pipeline.reserve_upload_or_refuse` — the function
  `/api/pipeline/run` calls — so a commit is metered, confirmed (402) and
  refused (429) exactly like every other upload, and an `allowed`
  reservation goes into the same run ledger the terminal settles.

AN EMPTY WORKSPACE BECOMES THE COMPANY. A new trial account has exactly one
  auto-created workspace, with no CUI and no data, and a plan that allows one
  company — so its first balance, which prints a CUI, used to route to "new
  company", meet the cap and be refused. When a file's company would be NEW
  and the caller owns a live workspace that is EMPTY (no `financial_periods`
  row, no live document) and has NO CUI, the commit ADOPTS it instead of
  creating one: renamed to the company, `org_prefs {cui, company_name,
  identity_sources}` stamped, CAEN and industry set (`adoptable_workspace`,
  `_adopt_workspace`); identify reports `target.reason
  "adopt_empty_workspace"`. Never a workspace with any data, with a CUI, or
  one the caller does not own; the one on screen first, else the oldest.

THE PLAN'S WORKSPACE CAP (the `create_workspace` SQL floor) is an answer,
  never a 500: 402 `{code: "workspace_cap_reached", plan, cap, message}`,
  nothing stored, the meter's reservation handed back
  (`workspace_cap_refusal`). No plan or cap is decided here.

Module-scope Pydantic models only (tests/engine/test_route_bindings.py).
Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import unicodedata
import uuid
from datetime import date
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile

from . import _org, _supabase

logger = logging.getLogger(__name__)

#: The storage bucket every document lives in, under `{org_id}/uploads/`.
DOC_BUCKET = "documents"

#: The same ceiling the browser path and the firm request link hold: a
#: 25 MB document. `server.BodyLimitMiddleware` gives these two routes the
#: document-sized body cap so the multipart framing fits around it.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

REASON_CUI_MATCH = "cui_match"
REASON_ON_SCREEN = "on_screen_company"
REASON_NEW_CUI = "new_cui"
REASON_ADOPT_EMPTY = "adopt_empty_workspace"

#: The identity fields the card shows, each with the evidence it was read
#: from.
IDENTITY_FIELDS = ("cui", "company_name", "period_end", "caen_code", "industry_key")

#: Signals that mean "read off the file NAME". G2: a period from one of
#: these is not a period the document states, so it is dropped.
FILENAME_SIGNALS = frozenset({"filename", "file_name", "filename_date"})

# ── Small, pure helpers ─────────────────────────────────────────────────


def normalize_cui(raw: Any) -> Optional[str]:
    """Digits only — the RO prefix, spaces and punctuation are not identity.
    Two to ten digits (a Romanian CUI), else ABSENT."""
    if raw is None:
        return None
    digits = re.sub(r"\D", "", str(raw))
    return digits if 2 <= len(digits) <= 10 else None


_LEGAL_FORMS = re.compile(
    r"\b(s\.?\s*r\.?\s*l\.?|s\.?\s*a\.?|s\.?\s*c\.?\s*s\.?|s\.?\s*n\.?\s*c\.?|"
    r"p\.?\s*f\.?\s*a\.?|i\.?\s*i\.?|i\.?\s*f\.?|ltd|llc|gmbh|inc)\b",
    re.IGNORECASE,
)


def normalize_name(raw: Any) -> str:
    """Lower-case ASCII words with the legal form and punctuation removed:
    "SCANDIA FOOD S.R.L." and "Scandia Food SRL" are one name."""
    if not raw:
        return ""
    text = unicodedata.normalize("NFKD", str(raw))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = _LEGAL_FORMS.sub(" ", text)
    text = re.sub(r"[^A-Za-z0-9]+", " ", text).lower()
    return " ".join(text.split())


def _iso_date(value: Any) -> Optional[str]:
    """An ISO `YYYY-MM-DD` from a date or a string, else None."""
    if value is None:
        return None
    if isinstance(value, date):
        return value.isoformat()
    raw = str(value).strip()[:10]
    try:
        return date.fromisoformat(raw).isoformat()
    except ValueError:
        return None


def _source(value: Any) -> Dict[str, Any]:
    """One field's provenance as `{signal, evidence}`."""
    if isinstance(value, dict):
        return {"signal": value.get("signal"), "evidence": value.get("evidence")}
    signal = getattr(value, "signal", None)
    if signal is not None:
        return {"signal": signal, "evidence": getattr(value, "evidence", None)}
    if value is None:
        return {"signal": None, "evidence": None}
    return {"signal": str(value), "evidence": None}


def _field(identity: Any, name: str) -> Any:
    if isinstance(identity, dict):
        return identity.get(name)
    return getattr(identity, name, None)


def identity_payload(identity: Any) -> Dict[str, Any]:
    """The `identity` block of the identify response, from whatever the
    identifier returned (a `CompanyIdentity` or a dict of the same fields).

    G2 is enforced HERE, on the way out: a period whose recorded signal is
    the file NAME is dropped — ABSENT, so the card asks — and its source
    records why."""
    raw_sources = _field(identity, "sources") or {}
    if not isinstance(raw_sources, dict):
        raw_sources = {}
    sources = dict((k, _source(v)) for k, v in raw_sources.items())
    period_end = _iso_date(_field(identity, "period_end"))
    period_signal = str((sources.get("period_end") or {}).get("signal") or "").lower()
    if period_end and period_signal in FILENAME_SIGNALS:
        sources["period_end"] = {
            "signal": "none",
            "evidence": "the only date found was in the file name, which is not "
                        "read as the period (it must come from the document itself)",
        }
        period_end = None
    caen = _field(identity, "caen_code")
    return {
        "cui": normalize_cui(_field(identity, "cui")),
        "company_name": (str(_field(identity, "company_name")).strip() or None)
        if _field(identity, "company_name") else None,
        "period_end": period_end,
        "caen_code": (str(caen).strip() or None) if caen else None,
        "industry_key": _field(identity, "industry_key") or None,
        "industry_label": _field(identity, "industry_label") or None,
        "document_kind": _field(identity, "document_kind") or None,
        "sources": sources,
    }


def resolve_target(identity: Dict[str, Any], companies: Sequence[Dict[str, Any]],
                   on_screen_org_id: Optional[str]) -> Dict[str, Any]:
    """Which company a file lands in (G1). Pure: the caller's live companies
    in, one `target` out.

      1. The document's CUI is held by one of the caller's companies →
         that company (`cui_match`), whichever company is on screen.
      2. The document's CUI is held by none of them →
           · the company on screen when it has no CUI recorded yet and its
             name is the document's company name (a workspace created
             before companies were keyed by CUI — `on_screen_company`);
           · otherwise a NEW company named from the document (`new_cui`).
      3. No readable CUI → the company on screen (`on_screen_company`), or
         a new company when nothing is on screen.
    """
    by_id = dict((c["org_id"], c) for c in companies)
    on_screen = by_id.get(on_screen_org_id or "")
    cui = identity.get("cui")
    doc_name = identity.get("company_name") or ""
    # A name read only off the file NAME is shown, never used as a key.
    name_signal = str(((identity.get("sources") or {}).get("company_name") or {}).get("signal") or "")
    name_key = normalize_name(doc_name) if name_signal.lower() not in FILENAME_SIGNALS else ""
    if cui:
        for company in companies:
            if company.get("cui") == cui:
                return {"org_id": company["org_id"], "name": company["name"],
                        "is_new": False, "reason": REASON_CUI_MATCH}
        if (on_screen is not None and not on_screen.get("cui")
                and name_key and name_key == normalize_name(on_screen["name"])):
            return {"org_id": on_screen["org_id"], "name": on_screen["name"],
                    "is_new": False, "reason": REASON_ON_SCREEN}
        return {"org_id": None, "name": doc_name, "is_new": True, "reason": REASON_NEW_CUI}
    if on_screen is not None:
        return {"org_id": on_screen["org_id"], "name": on_screen["name"],
                "is_new": False, "reason": REASON_ON_SCREEN}
    return {"org_id": None, "name": doc_name, "is_new": True, "reason": REASON_NEW_CUI}


# ── Identification (the company_identity module) ──────────────────────


def _open_registry() -> Any:
    """The ONRC/MF registry (`engine.public_ro.store.PublicRoStore`) at its
    default path, or None. Tolerates its absence: the store's constructor
    would CREATE an empty database, so it is only opened when the file is
    already there."""
    try:
        from engine.public_ro.store import PublicRoStore, default_db_path
        path = default_db_path()
        if not path.is_file():
            return None
        return PublicRoStore(path)
    except Exception:  # noqa: BLE001 — a missing registry is not a failed upload
        logger.exception("[uploads] the company registry could not be opened")
        return None


def start_name_index_warmup() -> Optional[threading.Thread]:
    """Make the registry's persisted name index current in a background
    thread (the server's start), so the first upload after a deploy never
    builds it in its own request (`engine.workspaces.registry_names`). None
    when there is no registry file — which is never created here."""
    try:
        from engine.public_ro.store import default_db_path
        if not default_db_path().is_file():
            return None
    except Exception:  # noqa: BLE001
        return None

    def _warm() -> None:
        registry = _open_registry()
        if registry is None:
            return
        try:
            from engine.workspaces.company_identity import warm_name_index
            logger.info("[uploads] %s", warm_name_index(registry))
        except Exception:  # noqa: BLE001 — a warm-up is never worth a crash
            logger.exception("[uploads] name index warm-up failed")
        finally:
            registry.close()

    thread = threading.Thread(target=_warm, name="registry-name-index-warmup", daemon=True)
    thread.start()
    return thread


def _identify_document(content: bytes, filename: str, registry: Any) -> Any:
    """The seam to `engine.workspaces.company_identity.identify_document`."""
    from engine.workspaces.company_identity import identify_document
    return identify_document(content, filename, registry=registry)


#: The period signals that mean "the header detector found none in the
#: document": nothing at all, or only the file NAME (G2 drops that one).
_NO_DOCUMENT_PERIOD = frozenset({"", "none"}) | FILENAME_SIGNALS


def printed_period_of_pdf(content: bytes) -> Optional[Tuple[str, str]]:
    """(period_end, the literal the document prints) — the period the
    verified text-line balanta reader reads off a PDF's title block
    (`pdf_balanta_text.read_balanta_text_verdict`: a Romanian month name and
    a year closing a title line, "Decembrie 2025", exactly one of them,
    never after a day number), checked by the engine's own period reader
    (`_period_detect`: sanity bounds, today is never evidence). None for
    anything else: not a PDF, a layout the reader does not verify, no
    printed period. Document text only — never the file name."""
    if not content or content[:4] != b"%PDF":
        return None
    try:
        from engine.country_packs.ro_romania.pdf_balanta_text import printed_period, read_balanta_text_verdict
        from engine.workspaces.company_identity import extract_document_text
        from ._period_detect import detect_period
    except ImportError:
        return None
    # The reader's own rule over the document's title lines first — one text
    # pass over two pages. The full verified read (every page, word
    # positions: 1-3 s) runs only for a document that prints a period there.
    head = extract_document_text(content, "document.pdf")
    if printed_period(list(head.header_lines)) is None:
        return None
    meta = read_balanta_text_verdict(content).meta or {}   # never raises
    end, text = meta.get("period_end"), meta.get("period_text")
    if not end or not text:
        return None
    checked = detect_period(extracted={"period_end": str(end)}, filename=None)
    iso = checked.get("proposed_period_end")
    return (str(iso), str(text).strip()[:160]) if iso else None


def _with_printed_period(raw: Any, content: bytes) -> Any:
    """`raw` (the identifier's answer), its period taken from the balanta
    reader when the header detector found none in the document — the
    WinMentor five-pair print closes its title block with "Decembrie 2025"
    on the address line, where no closing-balance vocabulary sits, so the
    card read "Not in the document" for a period the document prints (live
    walkthrough, 2026-09-26). A period the header detector read stays."""
    sources = _field(raw, "sources") or {}
    signal = str(((sources.get("period_end") if isinstance(sources, dict) else None) or {}).get("signal") or "")
    if signal.lower() not in _NO_DOCUMENT_PERIOD:
        return raw
    printed = printed_period_of_pdf(content)
    if printed is None:
        return raw
    shaped = dict((name, _field(raw, name)) for name in (
        "cui", "company_name", "caen_code", "industry_key", "industry_label", "document_kind"))
    shaped["sources"] = dict(sources if isinstance(sources, dict) else {},
                             period_end={"signal": "in_document", "evidence": printed[1]})
    shaped["period_end"] = printed[0]
    return shaped


def identify(content: bytes, filename: str, *, printed_period: bool = True) -> Dict[str, Any]:
    """Run the identifier over the file with the registry open, and shape
    its answer. Raises 503 when the identifier itself is not installed.
    `printed_period`: read the balanta reader's printed period when the
    header detector found none (the commit, which takes its period from
    the card, skips it)."""
    registry = _open_registry()
    try:
        try:
            raw = _identify_document(content, filename, registry)
        except ImportError:
            logger.exception("[uploads] company identification is not installed")
            raise HTTPException(503, {"code": "identification_unavailable",
                                      "message": "Company identification is not available right now."})
    finally:
        close = getattr(registry, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001
                pass
    if printed_period:
        raw = _with_printed_period(raw, content)
    return identity_payload(raw)


def _industry_label(client: Any, industry_key: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """(display_name, display_name_ro) for an industry key, read from the
    same `industry_profiles` catalog the industry picker lists. Fails open:
    a label is not worth an upload."""
    if not industry_key:
        return None, None
    try:
        rows = client.select("industry_profiles", filters={"key": "eq.%s" % industry_key},
                             columns="key,display_name,display_name_ro", limit=1) or []
    except Exception:  # noqa: BLE001
        logger.exception("[uploads] industry label lookup failed for %s", industry_key)
        return None, None
    if not rows:
        return None, None
    return rows[0].get("display_name"), rows[0].get("display_name_ro")


# ── The caller's companies ─────────────────────────────────────────────


def my_companies(client: Any, user_id: str) -> List[Dict[str, Any]]:
    """The caller's LIVE companies, oldest first: `{org_id, name, cui}`.

    Read through the caller's own client: `memberships self select` returns
    only their rows, and the organizations / org_prefs reads are then
    narrowed to exactly those ids — a firm read grant on another company
    never adds one. Archived companies (the recently-deleted shelf) are not
    places a file can land."""
    mems = client.select("memberships", filters={"user_id": "eq.%s" % user_id},
                         columns="org_id,created_at", order="created_at.asc") or []
    ids = []  # type: List[str]
    for m in mems:
        oid = str(m.get("org_id") or "")
        if oid and oid not in ids:
            ids.append(oid)
    if not ids:
        return []
    in_ids = "in.(%s)" % ",".join(ids)
    orgs = client.select("organizations", filters={"id": in_ids},
                         columns="id,name,archived_at") or []
    try:
        prefs_rows = client.select("org_prefs", filters={"org_id": in_ids},
                                   columns="org_id,prefs") or []
    except Exception:  # noqa: BLE001 — a company without prefs has no CUI yet
        logger.exception("[uploads] org_prefs read failed")
        prefs_rows = []
    prefs = dict((str(r.get("org_id")), r.get("prefs") or {}) for r in prefs_rows)
    by_id = dict((str(o.get("id")), o) for o in orgs)
    out = []  # type: List[Dict[str, Any]]
    for oid in ids:
        org = by_id.get(oid)
        if not org or org.get("archived_at"):
            continue
        bag = prefs.get(oid) or {}
        out.append({"org_id": oid, "name": org.get("name") or "",
                    "cui": normalize_cui(bag.get("cui") if isinstance(bag, dict) else None)})
    return out


# ── Duplicates ─────────────────────────────────────────────────────────


def find_duplicate(*, content_hash: str, user_id: str, org_id: str,
                   period_end: Optional[str]) -> Optional[Dict[str, Any]]:
    """The live document this upload would duplicate, as the contract's
    `{document_id, period_id, org_id}`, or None.

    ONE definition: `_doc_dedupe.find_live_original` — the same check
    `/api/documents/duplicate-check` and `/api/pipeline/run` make (same bytes,
    same account, same company, same period; a failed, deleted or
    never-started copy is not an original). With the period still unknown
    (identify, before the card asks) the same bytes are the same period."""
    from . import _doc_dedupe
    hit = _doc_dedupe.find_live_original(org_id=org_id, user_id=user_id,
                                         content_hash=content_hash, hint=period_end)
    if hit is None:
        return None
    return {"document_id": hit.existing_document_id, "period_id": hit.period_id, "org_id": org_id}


# ── An empty workspace becomes the company ─────────────────────────────

#: One adoption at a time in this process (the engine runs one): the check
#: that a workspace is still empty and CUI-less and the stamp that makes it
#: the company happen together. `_ADOPTING` holds a workspace from its
#: adoption until the commit that adopted it has filed its document (or
#: failed), so a second new company's commit racing that insert never takes
#: the same workspace; after the insert the workspace is simply not empty.
_ADOPT_LOCK = threading.Lock()
_ADOPTING = set()  # type: set


def _release_adoption(org_id: Optional[str]) -> None:
    with _ADOPT_LOCK:
        _ADOPTING.discard(org_id)


def _owned_org_ids(client: Any, user_id: str) -> List[str]:
    """The companies the caller OWNS, read through their own client."""
    rows = client.select("memberships", filters={"user_id": "eq.%s" % user_id, "role": "eq.owner"},
                         columns="org_id") or []
    return [str(r.get("org_id")) for r in rows if r.get("org_id")]


def workspace_is_empty(org_id: str) -> bool:
    """No `financial_periods` row and no live document. Read with the
    service role, filtered by the workspace, so no row can be hidden from
    the check; a read that fails is NOT empty — a workspace is never taken
    on a guess."""
    try:
        with _supabase.admin() as ac:
            if ac.select("financial_periods", filters={"org_id": "eq.%s" % org_id},
                         columns="id", limit=1):
                return False
            if ac.select("documents", filters={"org_id": "eq.%s" % org_id, "deleted_at": "is.null"},
                         columns="id", limit=1):
                return False
    except Exception:  # noqa: BLE001
        logger.exception("[uploads] could not tell whether workspace %s is empty", org_id)
        return False
    return True


def adoptable_workspace(client: Any, user_id: str, companies: Sequence[Dict[str, Any]],
                        on_screen_org_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """The caller's workspace a NEW company's file adopts instead of a new
    one, or None: a live company of theirs (`companies`, from `my_companies`)
    with NO CUI, that they OWN, that is EMPTY. The one on screen first, then
    the oldest."""
    blank = [c for c in companies if not c.get("cui") and c["org_id"] not in _ADOPTING]
    if not blank:
        return None
    try:
        owned = set(_owned_org_ids(client, user_id))
    except Exception:  # noqa: BLE001 — unknown ownership adopts nothing
        logger.exception("[uploads] membership read failed")
        return None
    ordered = sorted((c for c in blank if c["org_id"] in owned),
                     key=lambda c: c["org_id"] != on_screen_org_id)   # stable: oldest first after
    for company in ordered:
        if workspace_is_empty(company["org_id"]):
            return company
    return None


def _adopt_workspace(jwt: str, user_id: str, company: Dict[str, Any], spec: Dict[str, Any],
                     identity_sources: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Make the empty workspace `company` the new company `spec`: renamed,
    its industry and CAEN set, `org_prefs {cui, company_name,
    identity_sources}` stamped — every write as the caller. Re-checked under
    the lock first (still the caller's, still owned, still CUI-less, still
    empty); None when it no longer qualifies, and the caller creates a
    company instead. Idempotent: a workspace this adopted carries the CUI,
    and the next commit for it finds it by that CUI. The caller releases the
    hold (`_release_adoption`) once its document is filed or it failed."""
    org_id = company["org_id"]
    name = spec["name"]
    industry_key = spec.get("industry_key") or None
    with _ADOPT_LOCK:
        with _supabase.per_user(jwt) as client:
            fresh = next((c for c in my_companies(client, user_id) if c["org_id"] == org_id), None)
            if (fresh is None or fresh.get("cui") or org_id in _ADOPTING
                    or org_id not in set(_owned_org_ids(client, user_id))
                    or not workspace_is_empty(org_id)):
                return None
            patch = {"name": name}  # type: Dict[str, Any]
            if industry_key:
                label, _label_ro = _industry_label(client, industry_key)
                patch.update({"industry_key": industry_key, "industry_display_name": label})
            client.update("organizations", patch, filters={"id": "eq.%s" % org_id})
            if spec.get("caen_code"):
                try:
                    client.update("organizations", {"caen_code": spec["caen_code"]},
                                  filters={"id": "eq.%s" % org_id})
                except Exception:  # noqa: BLE001 — a CAEN is not worth the upload
                    logger.exception("[uploads] caen_code not written for adopted workspace %s", org_id)
            _ADOPTING.add(org_id)
            _set_identity_prefs(client, org_id, cui=spec.get("cui"), company_name=name,
                                identity_sources=identity_sources)
    logger.info("[uploads] user %s adopted empty workspace %s as company %r (cui=%s)",
                user_id, org_id, name, spec.get("cui"))
    return {"org_id": org_id, "name": name}


# ── Company creation ───────────────────────────────────────────────────

#: The plan's workspace cap, as `create_workspace` raises it — the SQL hard
#: floor in supabase/schema_phase_plan_caps.sql:
#:   'workspace_cap_reached: your % plan allows % workspace(s). Upgrade to add more.'
#: PostgREST answers 400 with that message and `SupabaseClient.rpc` raises it
#: inside its RuntimeError text. Read here, never changed here: the plans and
#: their caps belong to the pricing lane.
WORKSPACE_CAP_CODE = "workspace_cap_reached"
_WORKSPACE_CAP_RE = re.compile(
    r"workspace_cap_reached:\s*your\s+(?P<plan>[A-Za-z0-9_\-]+)\s+plan\s+allows\s+(?P<cap>\d+)\s+workspace",
    re.IGNORECASE,
)


def workspace_cap_refusal(exc: BaseException) -> Optional[HTTPException]:
    """The plan's workspace cap as the route's answer — 402
    `{code: "workspace_cap_reached", plan, cap, message}` — when `exc` is
    the `create_workspace` RPC refusing at the cap; None for anything else.

    It used to escape the commit as a 500, and the card read "We couldn't
    save the file" (live walkthrough, 2026-09-26). The card now says, in the
    reader's language, how many companies the plan allows, with the upgrade
    path and the choice of one of the caller's companies."""
    m = _WORKSPACE_CAP_RE.search(str(exc))
    if not m:
        return None
    plan, cap = m.group("plan").lower(), int(m.group("cap"))
    return HTTPException(402, {
        "code": WORKSPACE_CAP_CODE,
        "plan": plan,
        "cap": cap,
        "message": ("Your plan allows %d %s. Upgrade to add another, or choose one of your "
                    "companies for this file." % (cap, "company" if cap == 1 else "companies")),
    })


def _create_company(jwt: str, user_id: str, spec: Dict[str, Any],
                    identity_sources: Dict[str, Any]) -> Dict[str, Any]:
    """A new company: the organization and its OWNER membership through the
    `create_workspace` RPC (the same function the workspace UI calls —
    there is deliberately no client INSERT policy on either table), its CAEN
    on the organization, and `org_prefs {cui, company_name,
    identity_sources}` through `set_org_pref` (the server-side `||` merge).
    Every write runs as the caller."""
    name = spec["name"]
    industry_key = spec.get("industry_key") or None
    with _supabase.per_user(jwt) as client:
        label, _label_ro = _industry_label(client, industry_key)
        try:
            org_id = client.rpc("create_workspace", {
                "p_name": name, "p_industry_key": industry_key, "p_industry_display": label})
        except Exception as exc:  # noqa: BLE001 — the cap is an answer; anything else stays an error
            refusal = workspace_cap_refusal(exc)
            if refusal is None:
                raise
            logger.info("[uploads] user %s is at the plan's workspace cap (%s)", user_id,
                        refusal.detail.get("cap"))
            raise refusal
        org_id = str(org_id or "").strip().strip('"')
        if not org_id:
            raise HTTPException(502, {"code": "company_not_created",
                                      "message": "The company could not be created."})
        if spec.get("caen_code"):
            try:
                client.update("organizations", {"caen_code": spec["caen_code"]},
                              filters={"id": "eq.%s" % org_id})
            except Exception:  # noqa: BLE001 — a CAEN is not worth the upload
                logger.exception("[uploads] caen_code not written for new company %s", org_id)
        _set_identity_prefs(client, org_id, cui=spec.get("cui"), company_name=name,
                            identity_sources=identity_sources)
    logger.info("[uploads] user %s created company %s (cui=%s)", user_id, org_id, spec.get("cui"))
    return {"org_id": org_id, "name": name}


def _set_identity_prefs(client: Any, org_id: str, *, cui: Optional[str],
                        company_name: Optional[str], identity_sources: Dict[str, Any]) -> None:
    """Record the company's identity in `org_prefs` — one `set_org_pref`
    per key, so no other preference in the bag is touched."""
    for key, value in (("cui", cui), ("company_name", company_name),
                       ("identity_sources", identity_sources or {})):
        if value is None:
            continue
        client.rpc("set_org_pref", {"p_org_id": org_id, "p_key": key, "p_value": value})


def _parse_create_company(raw: Optional[str]) -> Optional[Dict[str, Any]]:
    if raw is None or not str(raw).strip():
        return None
    try:
        spec = json.loads(raw)
    except ValueError:
        raise HTTPException(422, {"code": "invalid_create_company",
                                  "message": "create_company must be a JSON object."})
    if not isinstance(spec, dict):
        raise HTTPException(422, {"code": "invalid_create_company",
                                  "message": "create_company must be a JSON object."})
    name = str(spec.get("name") or "").strip()
    if not name:
        raise HTTPException(422, {"code": "company_name_required",
                                  "message": "A new company needs a name."})
    return {"name": name[:200], "cui": normalize_cui(spec.get("cui")),
            "caen_code": (str(spec.get("caen_code")).strip() or None) if spec.get("caen_code") else None,
            "industry_key": (str(spec.get("industry_key")).strip() or None) if spec.get("industry_key") else None}


def _confirmed_period_end(value: Optional[str]) -> str:
    """The period the user confirmed on the card — the engine's own
    normalizer (`_period_move.normalize_target_period_end`: `YYYY-MM-DD` or
    `YYYY-MM`, inside the plausible reporting window). No period, no
    commit: there is no fallback date."""
    from ._period_move import MoveRefused, normalize_target_period_end
    try:
        return normalize_target_period_end(value)
    except MoveRefused as exc:
        raise HTTPException(422, {"code": getattr(exc, "code", "invalid_period_end"),
                                  "message": str(exc)})


# ── The request body ───────────────────────────────────────────────────


def _read_upload(file: UploadFile) -> Tuple[bytes, str, str]:
    content = file.file.read(MAX_UPLOAD_BYTES + 1)
    if not content:
        raise HTTPException(400, {"code": "empty_file", "message": "The file is empty."})
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, {"code": "file_too_large",
                                  "message": "The file is larger than 25 MB."})
    filename = (file.filename or "").rsplit("/", 1)[-1].rsplit("\\", 1)[-1] or "upload"
    return content, filename, (file.content_type or "application/octet-stream")


# ── The real file type, from the bytes ─────────────────────────────────
#
# A Word document renamed .pdf — a PK (zip) container holding
# word/document.xml — used to reach the PDF path: the identifier's PDF
# reader failed, the card read "not in the document" everywhere, and
# Analyse handed the file to Claude. The name says what the user believes;
# the magic bytes say what the file IS. A provable mismatch is refused with
# a plain sentence before the identifier, the meter or storage; bytes that
# prove nothing (a CSV, an unknown header, a PK container that names no
# Office part) are never refused.

#: What the extension declares.
_DECLARED_BY_EXT = {
    "pdf": "pdf", "xlsx": "xlsx", "xlsm": "xlsx", "xls": "xls", "csv": "csv",
    "jpg": "image", "jpeg": "image", "png": "image", "heic": "image", "heif": "image",
    "pptx": "pptx", "ppt": "ppt",
}

#: The words for a kind the bytes prove, in the sentence "This is X, not Y."
_KIND_WORDS = {
    "pdf": "a PDF", "docx": "a Word document", "xlsx": "an Excel workbook",
    "pptx": "a PowerPoint presentation", "zip": "a ZIP archive",
    "ole": "an older Office document", "image": "an image",
}

#: What each declared kind is called in "…, not Y."
_DECLARED_WORDS = {
    "pdf": "a PDF", "xlsx": "an Excel workbook", "xls": "an Excel workbook",
    "csv": "a CSV file", "image": "an image", "pptx": "a PowerPoint presentation",
    "ppt": "a PowerPoint presentation",
}

#: The kinds each declared kind may actually be (everything else the bytes
#: PROVE is a mismatch; "unknown" and "text" never refuse).
_COMPATIBLE = {
    "pdf": {"pdf"},
    "xlsx": {"xlsx", "zip"},
    "xls": {"ole", "xlsx", "zip"},      # .xls exports are often xlsx or HTML inside
    "csv": {"text"},
    "image": {"image"},
    "pptx": {"pptx", "zip"},
    "ppt": {"ole", "pptx", "zip"},
}


def declared_file_kind(filename: str) -> Optional[str]:
    return _DECLARED_BY_EXT.get(_ext_of(filename or ""))


def actual_file_kind(content: bytes) -> str:
    """The kind the magic bytes prove: pdf / docx / xlsx / pptx / zip / ole /
    image / text / unknown. Never raises."""
    head = bytes(content[:16] or b"")
    if head.startswith(b"%PDF"):
        return "pdf"
    if head.startswith(b"PK"):
        names = []  # type: List[str]
        try:
            import io
            import zipfile
            with zipfile.ZipFile(io.BytesIO(content)) as z:
                names = z.namelist()
        except Exception:  # noqa: BLE001 — a truncated container: read the names off the bytes
            for marker in (b"word/", b"xl/", b"ppt/"):
                if marker in content[:262144] or marker in content[-262144:]:
                    names.append(marker.decode("ascii"))
        if any(n.startswith("word/") for n in names):
            return "docx"
        if any(n.startswith("xl/") for n in names):
            return "xlsx"
        if any(n.startswith("ppt/") for n in names):
            return "pptx"
        return "zip"
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return "ole"
    if head.startswith(b"\x89PNG\r\n\x1a\n") or head.startswith(b"\xff\xd8\xff") or head.startswith(b"GIF8"):
        return "image"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "image"  # HEIC / HEIF (and any ISO media file a phone exports)
    try:
        content[:4096].decode("utf-8")
        return "text"
    except Exception:  # noqa: BLE001
        return "unknown"


def format_mismatch(filename: str, content: bytes) -> Optional[Tuple[str, str]]:
    """(code, plain sentence) when the bytes PROVE the file is not what its
    name says — "This is a Word document, not a PDF." — else None."""
    declared = declared_file_kind(filename)
    if not declared:
        return None
    actual = actual_file_kind(content)
    if actual in ("unknown", "text") or actual in _COMPATIBLE.get(declared, set()):
        return None
    if actual not in _KIND_WORDS:
        return None
    code = "%s_not_%s" % (actual, declared)
    return code, "This is %s, not %s." % (_KIND_WORDS[actual], _DECLARED_WORDS[declared])


def _refuse_format_mismatch(filename: str, content: bytes) -> None:
    hit = format_mismatch(filename, content)
    if hit is not None:
        code, message = hit
        raise HTTPException(422, {"code": "format_mismatch", "kind": code, "message": message})


def _ext_of(filename: str) -> str:
    if "." in filename:
        ext = filename.rsplit(".", 1)[1].lower()
        if 1 <= len(ext) <= 8 and ext.isalnum():
            return ext
    return "bin"


def _detected_type(filename: str, mime: str) -> str:
    """The upload-time type tag — `lib/supabase.ts detectFromName`, rule for
    rule, so both paths write only values the `documents.detected_type`
    CHECK constraint (supabase/schema.sql) admits. A tag only: the pipeline
    overwrites it once it has read the content."""
    n = (filename or "").lower()
    mime = (mime or "").lower()
    if re.search(r"balanta\s*verificare|trial[\s_-]?balance|^tb_", n):
        return "trial_balance"
    if re.search(r"bilan[tț]|balance[\s_-]?sheet|^bs_", n):
        return "bilant"
    if re.search(r"factur|invoice|saft|d406|smartbill", n):
        return "invoice"
    if re.search(r"p[\s_-]?l|profit[\s_-]?loss|cont[\s_-]?profit|^pl_", n):
        return "pl"
    if re.search(r"anual|annual[\s_-]?report", n):
        return "annual_report"
    if "spreadsheet" in mime or re.search(r"\.xlsx?$", n):
        return "xlsx_workbook"
    if mime == "text/csv" or n.endswith(".csv"):
        return "csv"
    if mime.startswith("image/"):
        return "image"
    return "unknown"


def _release(user_id: str, was_extra: bool) -> None:
    """Hand back a reservation no run will settle. Never raises."""
    try:
        from . import _usage_gate as _ug
        _ug.release_document(user_id, was_extra=was_extra)
    except Exception:  # noqa: BLE001
        logger.exception("[uploads] reservation release failed")


def _row_exists(org_id: str, doc_id: str) -> bool:
    """Whether the documents row made it in (an object with a row is the
    row's, never an orphan to delete). Unknown counts as existing: a
    storage object is never removed on a guess."""
    try:
        with _supabase.admin() as ac:
            return bool(ac.select("documents", filters={"id": "eq.%s" % doc_id, "org_id": "eq.%s" % org_id},
                                  columns="id", limit=1))
    except Exception:  # noqa: BLE001
        logger.exception("[uploads] could not tell whether document %s exists", doc_id)
        return True


def _require_jwt(authorization: Optional[str]) -> str:
    from .pipeline import _require_jwt as _pipeline_require_jwt
    return _pipeline_require_jwt(authorization)


# ── Years (the company page) ───────────────────────────────────────────


def _served_revenue(envelope: Any, currency: str) -> Optional[float]:
    """The period's NET TURNOVER as the engine serves it:
    `FactsGateway.revenue` — cifra de afaceri netă, 70x − 709, and nothing
    else (owner ruling 2026-09-26: growth divides turnover by turnover; the
    gateway no longer adds a P&L-placed reconciliation delta to it). The
    value the Capsule and the report read. ABSENT (None) when the envelope
    carries none, never a zero."""
    if not isinstance(envelope, dict) or not envelope:
        return None
    from engine.serving.facts import FactsGateway, MissingFactError
    try:
        gateway = FactsGateway.from_envelope(envelope, currency=currency or "RON")
        if gateway is None:
            return None
        return gateway.revenue().to_float()
    except MissingFactError:
        return None
    except Exception:  # noqa: BLE001 — one unreadable period is a gap, not a 500
        logger.exception("[uploads] served revenue unreadable")
        return None


def _change_pct(current: Optional[float], prior: Optional[float]) -> Optional[float]:
    """Turnover growth. ABSENT when either year is absent, when the prior is
    nil, and across a sign change (a percent across zero means nothing)."""
    if current is None or prior is None or prior == 0:
        return None
    if (current < 0) != (prior < 0):
        return None
    return round((current - prior) / abs(prior) * 100.0, 1)


#: What the tile's figure is — served, never typed in the page.
TURNOVER_BASIS = {"ro": "cifra de afaceri netă (70x − 709)",
                  "en": "net turnover (70x − 709)"}


def company_years(client: Any, org_id: str) -> List[Dict[str, Any]]:
    """One row per year the company has an ANALYSED period for, oldest
    first: `{period_id, year, period_end, turnover, turnover_change_pct,
    revenue, revenue_change_pct (the same two, the page's names), basis,
    currency}`.

    A year is represented by its latest analysed period (a Romanian trial
    balance is cumulative, so that is the year so far). The change is
    against the prior year's analysed period at the SAME month end —
    December against December, a year-to-date August against August —
    and ABSENT when there is none: a part year against a full one is not a
    change. Periods with no live, analysed source document are not years
    (G4)."""
    # Light columns first: an envelope is large, and only the periods that
    # become a tile (and their same-month comparators) need one.
    periods = client.select(
        "financial_periods",
        filters={"org_id": "eq.%s" % org_id},
        columns="id,period_end,currency,source_document_id,updated_at",
        order="period_end.asc",
    ) or []
    doc_ids = sorted(set(str(p["source_document_id"]) for p in periods if p.get("source_document_id")))
    analysed = set()  # type: set
    if doc_ids:
        docs = client.select(
            "documents",
            filters={"org_id": "eq.%s" % org_id, "id": "in.(%s)" % ",".join(doc_ids),
                     "deleted_at": "is.null", "status": "eq.analyzed"},
            columns="id",
        ) or []
        analysed = set(str(d["id"]) for d in docs)
    backed = []  # type: List[Dict[str, Any]]
    for p in periods:
        end = _iso_date(p.get("period_end"))
        if not end or str(p.get("source_document_id") or "") not in analysed:
            continue
        backed.append(dict(p, period_end=end))

    def _latest(rows: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        ordered = sorted(rows, key=lambda r: (r["period_end"], str(r.get("updated_at") or "")))
        return ordered[-1] if ordered else None

    by_year = {}  # type: Dict[int, List[Dict[str, Any]]]
    for p in backed:
        by_year.setdefault(int(p["period_end"][:4]), []).append(p)

    tiles = []  # type: List[Tuple[int, Dict[str, Any], Optional[Dict[str, Any]]]]
    for year in sorted(by_year):
        latest = _latest(by_year[year])
        prior = _latest([r for r in by_year.get(year - 1, [])
                         if r["period_end"][5:7] == latest["period_end"][5:7]])
        tiles.append((year, latest, prior))

    needed = sorted(set(str(r["id"]) for _y, a, b in tiles for r in (a, b) if r is not None))
    envelopes = {}  # type: Dict[str, Any]
    if needed:
        rows = client.select(
            "financial_periods",
            filters={"org_id": "eq.%s" % org_id, "id": "in.(%s)" % ",".join(needed)},
            columns="id,assembled_canonical_v1",
        ) or []
        envelopes = dict((str(r["id"]), r.get("assembled_canonical_v1")) for r in rows)

    revenue_cache = {}  # type: Dict[str, Optional[float]]

    def revenue_of(p: Optional[Dict[str, Any]]) -> Optional[float]:
        if p is None:
            return None
        pid = str(p["id"])
        if pid not in revenue_cache:
            revenue_cache[pid] = _served_revenue(envelopes.get(pid), p.get("currency") or "RON")
        return revenue_cache[pid]

    out = []  # type: List[Dict[str, Any]]
    for year, latest, prior in tiles:
        turnover = revenue_of(latest)
        change = _change_pct(turnover, revenue_of(prior))
        out.append({
            "period_id": latest["id"],
            "year": year,
            "period_end": latest["period_end"],
            # Turnover and its growth ONLY (design A6: workspace home
            # company cards). `revenue` / `revenue_change_pct` are the names
            # the page reads today; they ARE the turnover and its growth.
            "turnover": turnover,
            "turnover_change_pct": change,
            "revenue": turnover,
            "revenue_change_pct": change,
            "basis": dict(TURNOVER_BASIS),
            "currency": latest.get("currency") or "RON",
        })
    return out


# ── The router ─────────────────────────────────────────────────────────


def build_router() -> APIRouter:
    router = APIRouter(tags=["uploads"])

    @router.post("/api/uploads/identify")
    def identify_upload(
        file: UploadFile = File(...),
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """Who is this file? Company, CUI, period and industry — each with
        the evidence it was read from — the company it would land in, and
        whether it is already here. Stores nothing, reserves nothing."""
        jwt = _require_jwt(authorization)
        user_id = _org.verified_user_id(jwt)
        on_screen = None  # type: Optional[str]
        try:
            _uid, on_screen = _org.resolve_org(jwt, x_org_id)
        except HTTPException as exc:
            if exc.status_code != 404:  # 403: X-Org-Id names a company not theirs
                raise
        content, filename, _mime = _read_upload(file)
        # The bytes, before anything reads them as what the name claims.
        _refuse_format_mismatch(filename, content)
        content_hash = hashlib.sha256(content).hexdigest()
        identity = identify(content, filename)
        with _supabase.per_user(jwt) as client:
            if identity.get("industry_key") and not identity.get("industry_label"):
                identity["industry_label"], _ro = _industry_label(client, identity["industry_key"])
            companies = my_companies(client, user_id)
            target = resolve_target(identity, companies, on_screen)
            if target.get("is_new"):
                # A new company lands in the caller's empty, CUI-less
                # workspace when they have one — the commit adopts it.
                adopt = adoptable_workspace(client, user_id, companies, on_screen)
                if adopt is not None:
                    target = {"org_id": adopt["org_id"], "name": target.get("name") or adopt["name"],
                              "is_new": True, "reason": REASON_ADOPT_EMPTY}
            duplicate = None
            if target.get("org_id"):
                duplicate = find_duplicate(content_hash=content_hash, user_id=user_id,
                                           org_id=target["org_id"], period_end=identity.get("period_end"))
        return {"content_hash": content_hash, "identity": identity, "target": target,
                "duplicate": duplicate, "companies": companies}

    @router.post("/api/uploads/commit")
    def commit_upload(
        file: UploadFile = File(...),
        period_end: Optional[str] = Form(None),
        target_org_id: Optional[str] = Form(None),
        create_company: Optional[str] = Form(None),
        industry_key: Optional[str] = Form(None),
        output_language: Optional[str] = Form(None),
        confirm_extra: Optional[str] = Form(None),
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """Store the file in the company the user confirmed and analyse it.

        `confirm_extra` ("1"): the user answered the plan's extra-document
        question (the 402 this route gave a moment ago) with Confirm. The
        extra is then reserved as a GRANT for the document this commit is
        about to store and taken by it — one confirmation pays for one
        document (verifier P-B) — so there is no separate confirm call for a
        document that does not exist yet.

        `target_org_id` (a company the caller is a member of — 403
        otherwise) or `create_company` (JSON `{name, cui, caen_code,
        industry_key}`; an existing company of theirs with that CUI is used
        instead of a second one, and an empty CUI-less workspace of theirs
        becomes the company instead of a new one). `period_end` is the period
        the user confirmed — required, never inferred here. `X-Org-Id` (the
        company on screen) only orders the caller's OWN empty workspaces when
        one is adopted; it grants nothing."""
        jwt = _require_jwt(authorization)
        spec = _parse_create_company(create_company)
        target = str(target_org_id or "").strip()
        if target:
            user_id = _org.require_org_member(jwt, target)
        elif spec is not None:
            user_id = _org.verified_user_id(jwt)
        else:
            raise HTTPException(422, {"code": "target_required",
                                      "message": "Choose a company, or create a new one."})
        confirmed_end = _confirmed_period_end(period_end)
        content, filename, mime = _read_upload(file)
        # Belt and braces with identify: a mismatch never reaches storage,
        # the meter or the pipeline (and so never Claude).
        _refuse_format_mismatch(filename, content)
        content_hash = hashlib.sha256(content).hexdigest()
        chosen_industry = (str(industry_key).strip() or None) if industry_key else None

        # The identity again, best-effort: the new company's evidence, and
        # the CUI a pre-CUI workspace can adopt. Never a reason to refuse.
        # The period is the card's (`period_end`), so the reader is not asked.
        try:
            identity = identify(content, filename, printed_period=False)
        except Exception:  # noqa: BLE001
            logger.exception("[uploads] identification during commit failed (non-fatal)")
            identity = {"cui": None, "company_name": None, "sources": {}}

        with _supabase.per_user(jwt) as client:
            companies = my_companies(client, user_id)
            by_id = dict((c["org_id"], c) for c in companies)
            if target:
                company = by_id.get(target)
                if company is None:
                    raise HTTPException(409, {"code": "company_archived",
                                              "message": "That company was deleted. Restore it first."})
            elif spec is not None and spec.get("cui"):
                company = next((c for c in companies if c.get("cui") == spec["cui"]), None)
            else:
                company = None

            if company is not None:
                dup = find_duplicate(content_hash=content_hash, user_id=user_id,
                                     org_id=company["org_id"], period_end=confirmed_end)
                if dup is not None:
                    return dict(dup, status="duplicate", company_name=company["name"])

        # THE METER — the same reservation /api/pipeline/run takes (429 /
        # 402 unchanged). Nothing has been written yet. The document's id is
        # chosen now: a confirmed extra is granted to exactly this document.
        from . import pipeline as _pipeline
        from . import _usage_gate as _ug
        doc_id = str(uuid.uuid4())  # type: Optional[str]
        # A BOOK THE PLAN ALREADY COUNTED is never metered again — /run's
        # rule (`_needs_metering`, fix/dedupe-quota a8c1c8cf, lens S), read
        # from the same quota ledger. A counted book whose later correction
        # failed is no live original (the duplicate check above misses it),
        # so its re-upload through the card is stored and analysed — the
        # user gets the book back — but never reserved, counted, or at the
        # cap put to the €-dialog a second time. The ledger unreadable
        # (None): a new document holds no analysis, so it is metered — the
        # status rule /run falls back to.
        already_counted = company is not None and bool(_pipeline._book_already_counted({
            "org_id": company["org_id"], "uploaded_by": user_id, "content_hash": content_hash,
            "scope": "financial", "period_end_hint": confirmed_end}))
        if already_counted:
            logger.info("[uploads] %s: the book was already counted — analysed unmetered", doc_id)
            decision = None  # type: Any
        elif str(confirm_extra or "").strip().lower() in ("1", "true", "yes"):
            granted = _ug.confirm_extra_document(user_id, doc_id)
            if granted.kind == "blocked":
                raise HTTPException(409, {"code": "extra_doc_not_confirmed",
                                          "message": granted.message or
                                          "The extra document could not be confirmed. Nothing was charged."})
            decision = _pipeline.reserve_upload_or_refuse(user_id, doc_id)
        else:
            decision = _pipeline.reserve_upload_or_refuse(user_id)
        was_extra = bool(getattr(decision, "was_extra", False))
        reserved = getattr(decision, "kind", "disabled") == "allowed"
        created = False
        adopted = False
        stored = None  # type: Optional[Tuple[str, str]]
        claimed = None  # type: Optional[Dict[str, Any]]
        queued = False
        try:
            if company is None:
                spec = dict(spec or {})
                if chosen_industry:  # the industry the user chose on the card wins
                    spec["industry_key"] = chosen_industry
                with _supabase.per_user(jwt) as client:
                    blank = adoptable_workspace(client, user_id, companies, (x_org_id or "").strip() or None)
                if blank is not None:
                    company = _adopt_workspace(jwt, user_id, blank, spec, identity.get("sources") or {})
                    adopted = company is not None
                if company is None:
                    company = _create_company(jwt, user_id, spec, identity.get("sources") or {})
                    created = True
                company["cui"] = spec.get("cui")
            org_id = company["org_id"]
            storage_path = "%s/uploads/%s.%s" % (org_id, doc_id, _ext_of(filename))
            with _supabase.admin() as admin_client:
                admin_client.upload_object(DOC_BUCKET, storage_path, content, org_id=org_id,
                                           content_type=mime)
            stored = (storage_path, org_id)
            row = {
                "id": doc_id,
                "org_id": org_id,
                "uploaded_by": user_id,
                "storage_path": storage_path,
                "original_filename": filename,
                "mime_type": mime,
                "size_bytes": len(content),
                "detected_type": _detected_type(filename, mime),
                "status": "queued",
                "scope": "financial",
                "content_hash": content_hash,
                # The CONFIRMATION channel: the period the user confirmed on
                # the card, read off the document (G2). stage_persist files
                # the analysis under it and records any disagreement.
                "period_end_hint": confirmed_end,
            }
            if was_extra:
                row["metered_extra"] = True
            if output_language:
                row["detected_language"] = str(output_language)[:8]
            with _supabase.per_user(jwt) as client:
                client.insert("documents", row, returning=False)
                if not created and not adopted:
                    _after_commit_to_existing(client, company, identity, companies, chosen_industry)

            # THE ENTRY — the one analysis-entry step /api/pipeline/run takes
            # (`_doc_dedupe.enter_analysis`, FIRST), under the (company,
            # account, content) lock: a racing twin committed a moment
            # earlier is found RUNNING and this row is archived as its
            # duplicate (never analysed, never counted); otherwise this row
            # is CLAIMED — in the in-flight registry, pipeline_started_at
            # stamped — and only a claimed row runs.
            from . import _doc_dedupe
            entry = _doc_dedupe.enter_analysis(dict(row, deleted_at=None, pipeline_started_at=None),
                                               user_id, now_iso=_pipeline._now_iso(),
                                               mode=_doc_dedupe.FIRST)
            if entry.kind == _doc_dedupe.DUPLICATE and entry.hit is not None:
                # archived as the duplicate: no claim to give back
                if reserved:
                    _release(user_id, was_extra)
                return {"status": "duplicate", "document_id": entry.hit.existing_document_id,
                        "period_id": entry.hit.period_id, "org_id": org_id,
                        "company_name": company["name"]}
            if entry.kind != _doc_dedupe.CLAIMED:
                # A row this request inserted a moment ago cannot already be
                # running, analysed or deleted; if it reads so, nothing runs.
                raise RuntimeError("upload %s could not be claimed for analysis (%s)" % (doc_id, entry.kind))
            claimed = entry.released_row()

            # The run ledger: the terminal settles exactly this reservation
            # (committed on `analyzed`, released on failure). A confirmed
            # extra's grant already holds its ledger reservation — it is
            # registered as the run's own, never recorded a second time
            # (fix/dedupe-quota P2-B: the ledger refuses a second record).
            if reserved and not _pipeline._register_quota_run(
                    doc_id, user_id=user_id, was_extra=was_extra,
                    month=getattr(decision, "month", "") or None,
                    reservation_id=getattr(decision, "reservation_id", "") or None):
                # The document's ledger row holds another reservation: the
                # slot just reserved was given back inside — never twice.
                reserved = False
                raise HTTPException(409, {
                    "code": "reservation_outstanding",
                    "message": ("This document's analysis is still reserved. "
                                "Try again in a few minutes."),
                })
            _pipeline._admin_set_status(doc_id, "queued", pipeline_started_at=_pipeline._now_iso())
            _doc_dedupe.mark_running(doc_id)
            _pipeline._enqueue(doc_id)
            queued = True
        except Exception:
            if not queued:
                # Nothing is analysed. An object no document row points at
                # (the row insert failed) is removed; a claimed row gives its
                # claim back, so it never passes for a running original; and
                # a reservation no run will settle is handed back.
                if stored is not None and doc_id and not _row_exists(stored[1], doc_id):
                    try:
                        with _supabase.admin() as admin_client:
                            admin_client.delete_object(DOC_BUCKET, stored[0], org_id=stored[1])
                    except Exception:  # noqa: BLE001
                        logger.exception("[uploads] orphaned object %s not removed", stored[0])
                if claimed is not None:
                    from . import _doc_dedupe
                    _doc_dedupe.release_claim(claimed)  # also leaves the in-flight registry
                if reserved:
                    run = _pipeline._take_quota_run(doc_id) if doc_id else None
                    if run is not None:
                        # Registered: released through the run's own record —
                        # the meter in the month it was reserved in AND the
                        # quota ledger row, so the orphan sweep never gives
                        # the same slot back a second time.
                        _pipeline._release_run_reservation(doc_id, run)
                    else:
                        _release(user_id, was_extra)
                if doc_id:
                    _ug.cancel_extra_grant(doc_id)  # an unclaimed grant goes back unbilled
            raise
        finally:
            if adopted:
                # Filed (or failed): the adopted workspace needs no hold now.
                _release_adoption(company["org_id"])
        # No `_usage_limits.record_usage` here: the legacy enqueue-time bump
        # double-counted every upload (the owner's "51 documents used"); the
        # V3 commit at the run's end is the one counter.
        return {"status": "queued", "document_id": doc_id, "org_id": org_id,
                "company_name": company["name"], "period_end": confirmed_end,
                "created_company": created, "adopted_company": adopted}

    @router.get("/api/companies/{org_id}/years")
    def get_company_years(
        org_id: str,
        authorization: Optional[str] = Header(None),
    ) -> List[Dict[str, Any]]:
        """The company page's year tiles, from the served figures.
        Membership-checked: 403 on a company the caller does not belong to."""
        jwt = _require_jwt(authorization)
        _org.require_org_member(jwt, org_id)
        with _supabase.per_user(jwt) as client:
            return company_years(client, org_id)

    return router


def _after_commit_to_existing(client: Any, company: Dict[str, Any], identity: Dict[str, Any],
                              companies: Sequence[Dict[str, Any]],
                              chosen_industry: Optional[str]) -> None:
    """Two small company updates a commit into an EXISTING company may
    carry, both best-effort (the document is already filed):

      · the industry the user chose on the card, when it differs;
      · a workspace created before companies were keyed by CUI adopts the
        document's CUI — only when it has none, no other company of the
        caller holds it, and its name IS the document's company name."""
    org_id = company["org_id"]
    if chosen_industry:
        try:
            rows = client.select("organizations", filters={"id": "eq.%s" % org_id},
                                 columns="id,industry_key", limit=1) or []
            if rows and rows[0].get("industry_key") != chosen_industry:
                label, _ro = _industry_label(client, chosen_industry)
                client.update("organizations",
                              {"industry_key": chosen_industry, "industry_display_name": label},
                              filters={"id": "eq.%s" % org_id})
        except Exception:  # noqa: BLE001
            logger.exception("[uploads] industry update failed for %s", org_id)
    cui = identity.get("cui")
    name_signal = str(((identity.get("sources") or {}).get("company_name") or {}).get("signal") or "")
    if (cui and not company.get("cui")
            and not any(c.get("cui") == cui for c in companies)
            and identity.get("company_name") and name_signal.lower() not in FILENAME_SIGNALS
            and normalize_name(identity["company_name"]) == normalize_name(company["name"])):
        try:
            _set_identity_prefs(client, org_id, cui=cui, company_name=company["name"],
                                identity_sources=identity.get("sources") or {})
        except Exception:  # noqa: BLE001
            logger.exception("[uploads] CUI adoption failed for %s", org_id)
