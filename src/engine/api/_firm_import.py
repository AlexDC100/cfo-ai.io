"""FIRM CSV IMPORT — (name, CUI, industry, responsible accountant) → clients.

A firm's client book usually already exists as a spreadsheet. This
module turns one into workspaces, honestly:

  · The CUI is normalised (RO prefix, spaces, dots stripped; digits kept)
    and resolved against the EXISTING public-data spine —
    `engine.public_ro.store.PublicRoStore` (data.gov.ro identification +
    bilanț join, CLAUDE.md §21). Where the spine knows the company and
    the row is publishable (PS7: a natural person's data never leaves
    the store), its registered name and CAEN are used and credited.
  · Industry is resolved in this order, and STOPS at the first honest
    answer:
      1. an `industry` column naming an ACTIVE `industry_profiles.key`
         → resolved, source `user_provided`;
      2. the public CAEN through `caen_industry_mappings` with an
         `exact` or `close` match → resolved, source `auto_caen`;
      3. anything else → UNRESOLVED. `sector_fallback` is a guess by the
         mapping table's own definition, so it is recorded as a HINT in
         the resolution and the workspace's industry_key stays NULL.
    A client is never created with a guessed industry.
  · The responsible accountant is matched by e-mail or user id against
    the firm's members; anyone else is an honest UNRESOLVED marker, and
    the client is created unassigned.
  · A CUI the firm already holds (or that repeats inside the file) is
    SKIPPED as a duplicate, never a second workspace.

Every created workspace gets: the importer as its org owner (so the
existing per-workspace routes work for them), the responsible accountant
as an org admin when resolved, a `client_assignments` row carrying the
full `import_resolution`, and an audit row. `dry_run` runs the whole
resolution and writes nothing.

TWO WALLS ON THE WRITE (W1). Every created client goes through the
SECURITY DEFINER RPC `import_firm_client` (schema_phase_firm.sql) AS THE
USER: the RPC asks `firm_can(firm_id, 'import')` itself, refuses a
duplicate CUI and a responsible accountant outside the firm, and writes
the organization, the memberships, the assignment and the audit row in
one transaction. Nothing here writes a client through the service role,
so a Python guard removed by hand still creates nothing.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import csv
import io
import logging
import uuid
from types import MappingProxyType
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from . import _firm, _supabase

logger = logging.getLogger(__name__)

#: Column aliases (lower-cased, spaces → underscores) — DATA. The first
#: alias in each tuple is the canonical header the docs advertise.
COLUMN_ALIASES = MappingProxyType({
    "name": ("name", "denumire", "company", "company_name", "client", "client_name"),
    "cui": ("cui", "cif", "cod_fiscal", "fiscal_code", "vat", "vat_number"),
    "industry": ("industry", "industry_key", "industrie"),
    "responsible": ("responsible", "responsible_accountant", "accountant",
                    "responsabil", "contabil"),
})

#: The one column a row cannot be imported without. A name can come from
#: the public spine; a CUI cannot come from anywhere else.
REQUIRED_COLUMNS = ("cui",)

#: Hard cap on rows per import call — a firm has 30-80 clients; a file
#: past this is almost certainly the wrong file.
MAX_ROWS = 500

#: Org-membership roles (the workspace model's vocabulary — owner/admin/
#: member, schema_phase3.sql), NOT firm roles. Named once, as data; the
#: RPC below writes exactly these (asserted against its SQL body by
#: tests/engine/test_firm_tenancy.py).
ORG_ROLE_FOR_IMPORTER = "owner"
ORG_ROLE_FOR_RESPONSIBLE = "admin"

#: The SECURITY DEFINER RPC every created client goes through, as the
#: user — the SQL wall on the import (schema_phase_firm.sql).
IMPORT_RPC = "import_firm_client"

#: caen_industry_mappings.match_quality values that count as an answer.
#: `sector_fallback` is excluded on purpose: the table itself calls it a
#: guess ("surface as SOURCE_FALLBACK so the UI knows we're guessing").
RESOLVING_MATCH_QUALITIES = ("exact", "close")

STATUS_RESOLVED = "resolved"
STATUS_UNRESOLVED = "unresolved"
STATUS_UNASSIGNED = "unassigned"


class CsvFormatError(ValueError):
    """The file has no usable header — nothing can be imported from it."""


# ──────────────────────────────────────────────────────────────────────
# Parsing
# ──────────────────────────────────────────────────────────────────────

class ClientRow(object):
    __slots__ = ("line", "name", "cui_raw", "industry", "responsible")

    def __init__(self, line, name, cui_raw, industry, responsible):
        # type: (int, str, str, str, str) -> None
        self.line = line
        self.name = name
        self.cui_raw = cui_raw
        self.industry = industry
        self.responsible = responsible


def normalize_cui(raw):  # type: (Any) -> Optional[str]
    """'RO 12.345.678' → '12345678'. None when no 2-10 digit code remains.
    Romanian CUIs are 2-10 digits; the optional 'RO' prefix is the VAT
    registration marker, not part of the code."""
    text = str(raw or "").strip().upper()
    if not text:
        return None
    for ch in (" ", ".", "-", " "):
        text = text.replace(ch, "")
    if text.startswith("RO"):
        text = text[2:]
    if not text.isdigit():
        return None
    text = text.lstrip("0") or "0"
    if not (2 <= len(text) <= 10):
        return None
    return text


def _sniff_delimiter(header_line):  # type: (str) -> str
    counts = dict((d, header_line.count(d)) for d in (",", ";", "\t"))
    best = max(counts.items(), key=lambda kv: (kv[1], kv[0] == ","))
    return best[0] if best[1] > 0 else ","


def _canon_header(cell):  # type: (str) -> str
    return str(cell or "").strip().lstrip("﻿").lower().replace(" ", "_")


def map_header(cells):  # type: (List[str]) -> Dict[str, int]
    """Canonical field → column index, by alias. Unknown columns are
    ignored (a firm's sheet carries many); a canonical field present twice
    keeps its first column."""
    out = {}  # type: Dict[str, int]
    for idx, cell in enumerate(cells):
        key = _canon_header(cell)
        if not key:
            continue
        for field, aliases in COLUMN_ALIASES.items():
            if key in aliases and field not in out:
                out[field] = idx
                break
    return out


def parse_clients_csv(text):  # type: (str) -> Tuple[List[ClientRow], List[Dict[str, Any]], Dict[str, int]]
    """(rows, issues, header_map). `issues` are per-line, never fatal;
    :class:`CsvFormatError` is raised only when the header carries no
    CUI column at all."""
    body = str(text or "").lstrip("﻿")
    lines = body.splitlines()
    first = next((ln for ln in lines if ln.strip()), "")
    if not first:
        raise CsvFormatError("The file is empty.")
    delimiter = _sniff_delimiter(first)
    reader = csv.reader(io.StringIO(body), delimiter=delimiter)
    header = None  # type: Optional[Dict[str, int]]
    rows = []  # type: List[ClientRow]
    issues = []  # type: List[Dict[str, Any]]
    line_no = 0
    for cells in reader:
        line_no += 1
        if header is None:
            if not any(str(c).strip() for c in cells):
                continue
            header = map_header([str(c) for c in cells])
            missing = [c for c in REQUIRED_COLUMNS if c not in header]
            if missing:
                raise CsvFormatError(
                    "No %s column found. Header seen: %s. Accepted names: %s."
                    % (", ".join(missing),
                       ", ".join(_canon_header(c) for c in cells) or "(none)",
                       "; ".join("%s = %s" % (f, "/".join(COLUMN_ALIASES[f]))
                                 for f in COLUMN_ALIASES)))
            continue
        if not any(str(c).strip() for c in cells):
            continue
        if len(rows) >= MAX_ROWS:
            issues.append({"line": line_no, "code": "too_many_rows",
                           "detail": "Import is capped at %d rows per file." % MAX_ROWS})
            break

        def _cell(field):  # type: (str) -> str
            idx = header.get(field)
            if idx is None or idx >= len(cells):
                return ""
            return str(cells[idx] or "").strip()

        rows.append(ClientRow(line=line_no, name=_cell("name"), cui_raw=_cell("cui"),
                              industry=_cell("industry"), responsible=_cell("responsible")))
    if header is None:
        raise CsvFormatError("The file is empty.")
    return rows, issues, header


# ──────────────────────────────────────────────────────────────────────
# Resolution — public data, industry, responsible
# ──────────────────────────────────────────────────────────────────────

def resolve_public(cui, store):  # type: (str, Any) -> Dict[str, Any]
    """What the public spine knows about `cui`. Four honest states:
    found / absent / withheld (known, but not publishable — PS7) /
    unavailable (no store, or it failed)."""
    if store is None:
        return {"status": "unavailable", "reason": "public_store_unavailable"}
    try:
        row = store.get_company(int(cui))
    except Exception:  # noqa: BLE001
        logger.exception("[firm-import] public store lookup failed for %s", cui)
        return {"status": "unavailable", "reason": "public_store_error"}
    if not row:
        return {"status": "absent"}
    if not row.get("publishable"):
        # A natural-person form (PFA/II/IF) or an unknown register series:
        # the store's verdict is "not publishable"; nothing of it is used.
        return {"status": "withheld", "reason": "not_publishable"}
    return {
        "status": "found",
        "name": row.get("name"),
        "caen": row.get("caen"),
        "county": row.get("county"),
        "source": "data.gov.ro",
        "provenance": row.get("provenance"),
    }


def resolve_industry(csv_industry, caen, client):  # type: (str, Optional[str], Any) -> Dict[str, Any]
    """See the module docstring for the order. Never returns a guess."""
    key = (csv_industry or "").strip()
    if key:
        rows = client.select(
            "industry_profiles",
            filters={"key": "eq.%s" % key, "is_active": "eq.true"},
            columns="key,display_name",
            limit=1,
        ) or []
        if rows:
            return {"status": STATUS_RESOLVED, "source": "user_provided",
                    "industry_key": rows[0].get("key"),
                    "display_name": rows[0].get("display_name")}
        return {"status": STATUS_UNRESOLVED, "reason": "unknown_industry_key",
                "value": key}

    if caen:
        from ._industry_detection import (_industry_display_name,
                                          _normalize_caen, _resolve_caen)
        norm = _normalize_caen(caen)
        row = _resolve_caen(client, norm) if norm else None
        if row and (row.get("match_quality") or "exact") in RESOLVING_MATCH_QUALITIES:
            industry_key = str(row.get("industry_key") or "")
            return {"status": STATUS_RESOLVED, "source": "auto_caen",
                    "caen": norm, "match_quality": row.get("match_quality"),
                    "industry_key": industry_key,
                    "display_name": _industry_display_name(client, industry_key)}
        if row:
            return {"status": STATUS_UNRESOLVED, "reason": "sector_fallback_only",
                    "caen": norm, "hint_industry_key": row.get("industry_key")}
        return {"status": STATUS_UNRESOLVED, "reason": "caen_unmapped",
                "caen": norm or caen}

    return {"status": STATUS_UNRESOLVED, "reason": "no_industry_signal"}


def resolve_responsible(value, members):  # type: (str, List[Dict[str, Any]]) -> Dict[str, Any]
    """Match by user id or e-mail (case-insensitive) among the firm's
    members. Blank → unassigned; unknown → unresolved."""
    wanted = (value or "").strip()
    if not wanted:
        return {"status": STATUS_UNASSIGNED}
    lowered = wanted.lower()
    for m in members or []:
        uid = str(m.get("user_id") or "")
        email = str(m.get("email") or "").strip().lower()
        if lowered == uid.lower() or (email and lowered == email):
            return {"status": STATUS_RESOLVED, "user_id": uid, "email": email or None}
    return {"status": STATUS_UNRESOLVED, "reason": "not_a_firm_member",
            "value": wanted}


# ──────────────────────────────────────────────────────────────────────
# The import
# ──────────────────────────────────────────────────────────────────────

_public_store_cache = {"store": None, "tried": False}  # type: Dict[str, Any]


def default_public_store():  # type: () -> Any
    """Process-cached PublicRoStore, or None when the spine is not
    provisioned here (no data/public_ro.db). Lazy so the router mounts
    and tests import without touching the file."""
    if _public_store_cache["tried"]:
        return _public_store_cache["store"]
    _public_store_cache["tried"] = True
    try:
        from engine.public_ro.store import PublicRoStore, default_db_path
        if default_db_path().exists():
            _public_store_cache["store"] = PublicRoStore()
    except Exception:  # noqa: BLE001 — the importer degrades to "unavailable"
        logger.warning("[firm-import] public_ro store unavailable", exc_info=True)
    return _public_store_cache["store"]


def reset_default_public_store():  # type: () -> None
    _public_store_cache["store"] = None
    _public_store_cache["tried"] = False


def import_clients(ctx, jwt, csv_text, store=None, dry_run=False):
    # type: (_firm.FirmContext, str, str, Any, bool) -> Dict[str, Any]
    """Run the import for `ctx.firm_id`. Returns the report; writes only
    when `dry_run` is False. Deterministic for a given file and state."""
    try:
        rows, issues, header = parse_clients_csv(csv_text)
    except CsvFormatError as exc:
        raise HTTPException(400, str(exc))

    # Both reads as the CALLER: the member list (RPC, `is_firm_member_of`)
    # and the firm's existing clients (`organizations firm read`, RLS).
    with _supabase.per_user(jwt) as client:
        members = _firm.rpc_or_http(client, "list_firm_members",
                                    {"p_firm_id": ctx.firm_id}) or []
        # Every page (critic D11): a bare select answered 1,000 of a
        # 1,200-client firm, so client #1,001's CUI read as "new" and was
        # imported twice. The walk stops on an EMPTY page (engine.api._paging).
        from ._paging import select_all
        existing = select_all(client, "organizations", order="id.asc",
                              filters={"firm_id": "eq.%s" % ctx.firm_id},
                              columns="id,cui,name") or []
    known_cuis = {}  # type: Dict[str, str]
    for org in existing:
        norm = normalize_cui(org.get("cui"))
        if norm:
            known_cuis[norm] = str(org.get("id"))

    created = []  # type: List[Dict[str, Any]]
    skipped = []  # type: List[Dict[str, Any]]
    seen = set()  # type: set

    for row in rows:
        cui = normalize_cui(row.cui_raw)
        if cui is None:
            issues.append({"line": row.line, "code": "invalid_cui",
                           "detail": "CUI %r is not a 2-10 digit fiscal code." % row.cui_raw})
            continue
        if cui in known_cuis:
            skipped.append({"line": row.line, "cui": cui, "code": "duplicate",
                            "detail": "Already a client of this firm.",
                            "org_id": known_cuis[cui]})
            continue
        if cui in seen:
            skipped.append({"line": row.line, "cui": cui, "code": "duplicate",
                            "detail": "Repeated inside this file."})
            continue
        seen.add(cui)

        public = resolve_public(cui, store)
        public_name = public.get("name") if public.get("status") == "found" else None
        name = row.name or (public_name or "")
        if not name:
            issues.append({"line": row.line, "cui": cui, "code": "name_required",
                           "detail": "No name in the file and none in public data."})
            continue
        name_source = "csv" if row.name else "public_registry"
        caen = public.get("caen") if public.get("status") == "found" else None

        with _supabase.admin() as ac:
            industry = resolve_industry(row.industry, caen, ac)
        responsible = resolve_responsible(row.responsible, members)

        resolution = {
            "name": {"value": name, "source": name_source,
                     "public_name": public_name},
            "public_data": public,
            "industry": industry,
            "responsible": responsible,
        }
        record = {
            "line": row.line,
            "cui": cui,
            "name": name,
            "industry_key": industry.get("industry_key") if industry.get("status") == STATUS_RESOLVED else None,
            "industry_status": industry.get("status"),
            "responsible_user_id": responsible.get("user_id") if responsible.get("status") == STATUS_RESOLVED else None,
            "responsible_status": responsible.get("status"),
            "resolution": resolution,
        }

        if not dry_run:
            # ONE guarded RPC per client, AS THE USER (W1): `firm_can(...,
            # 'import')` is asked inside it, the organization / memberships
            # (importer = org owner, responsible = org admin) / assignment /
            # audit rows are written by it, in one transaction.
            with _supabase.per_user(jwt) as client:
                org_id = str(_firm.rpc_or_http(client, IMPORT_RPC, {
                    "p_firm_id": ctx.firm_id,
                    "p_name": name,
                    "p_cui": cui,
                    "p_industry_key": record["industry_key"],
                    "p_industry_display_name": (industry.get("display_name")
                                                if industry.get("status") == STATUS_RESOLVED
                                                else None),
                    "p_caen_code": caen,
                    "p_responsible": record["responsible_user_id"],
                    "p_resolution": resolution,
                }) or "")
            if not org_id:
                raise HTTPException(500, "Workspace insert returned no id.")
            record["org_id"] = org_id
            known_cuis[cui] = org_id
        created.append(record)

    counts = {
        "rows": len(rows),
        "created": len(created),
        "skipped": len(skipped),
        "issues": len(issues),
        "industry_unresolved": sum(1 for c in created
                                   if c["industry_status"] != STATUS_RESOLVED),
        "responsible_unresolved": sum(1 for c in created
                                      if c["responsible_status"] == STATUS_UNRESOLVED),
    }
    return {
        "version": _firm.FIRM_API_VERSION,
        "firm_id": ctx.firm_id,
        "dry_run": bool(dry_run),
        "columns": sorted(header.keys()),
        "created": created,
        "skipped": skipped,
        "issues": issues,
        "counts": counts,
    }


# ──────────────────────────────────────────────────────────────────────
# Route
# ──────────────────────────────────────────────────────────────────────

class ImportRequest(BaseModel):
    csv: str = Field(..., min_length=1, max_length=2_000_000)
    dry_run: bool = False


def build_router():  # type: () -> APIRouter
    """Included into the firm router (prefix /api/firm)."""
    router = APIRouter(tags=["firm-import"])

    @router.post("/{firm_id:uuid}/import")
    def import_csv(firm_id: uuid.UUID, body: ImportRequest,
                   authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _firm._require_jwt(authorization)
        ctx = _firm.resolve_firm(jwt, firm_id)
        _firm.require(ctx, "import")
        return import_clients(ctx, jwt, body.csv, store=default_public_store(),
                              dry_run=body.dry_run)

    @router.get("/import/columns")
    def import_columns(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """The header contract, so the FE can render a template."""
        _firm._require_jwt(authorization)
        return {
            "required": list(REQUIRED_COLUMNS),
            "columns": dict((f, list(a)) for f, a in COLUMN_ALIASES.items()),
            "max_rows": MAX_ROWS,
        }

    return router


__all__ = [
    "COLUMN_ALIASES", "REQUIRED_COLUMNS", "MAX_ROWS", "IMPORT_RPC",
    "ORG_ROLE_FOR_IMPORTER", "ORG_ROLE_FOR_RESPONSIBLE",
    "RESOLVING_MATCH_QUALITIES", "STATUS_RESOLVED", "STATUS_UNRESOLVED",
    "STATUS_UNASSIGNED", "CsvFormatError", "ClientRow",
    "normalize_cui", "map_header", "parse_clients_csv",
    "resolve_public", "resolve_industry", "resolve_responsible",
    "default_public_store", "reset_default_public_store", "import_clients",
    "build_router",
]
