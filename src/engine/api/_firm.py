"""THE FIRM MODEL — accounting firms over client workspaces (Firm Cockpit, Part A).

An accounting firm brings 30-80 client companies. A client IS a workspace
(workspace == organization, CLAUDE.md §16) — nothing about a workspace
changes when a firm is attached to it, and a workspace with no firm is
the current product, untouched. This module is the layer above:

    firm ──< firm_memberships (owner | partner | accountant | assistant | viewer)
      └──< organizations.firm_id (nullable) ── client_assignments

WHAT THIS MODULE GUARANTEES

THE ROLE MATRIX IS DATA. :data:`ROLE_MATRIX` is a frozen table — one
    row per role, one cell per action — and :func:`can` is the ONLY way
    code asks "may this role do that". Nothing here branches on a role
    NAME to grant an action; tests/engine/test_firm_tenancy.py scans this
    module for such a branch (the profile-name guard of
    test_company_profile.py, applied to roles) and
    compares every cell against the SQL seed in
    supabase/schema_phase_firm.sql, so the database and the backend can
    never disagree about a permission.

TWO WALLS, NEVER ONE. Every route resolves the caller's firm membership
    through :func:`resolve_firm` (403 on a non-member — the same shape
    as `_org.resolve_org`) and checks the client belongs to THAT firm
    through :func:`require_client` (403, with a message that is
    identical whether the workspace exists or not, so a probe learns
    nothing). Underneath, every read of firm or client rows goes through
    the caller's OWN Supabase client (`_supabase.per_user`), so Postgres
    RLS — `is_firm_member_of`, `firm_can`, `can_read_client_org` — is the
    second wall. A backend bug that skips the Python guard still reads
    nothing; a policy bug still meets the Python guard.

READ-ONLY TOWARD CLIENT BOOKS. A firm reads its clients' served facts; it
    does not edit them. The only writes here are firm-model writes, and
    each — attach, detach, assign, roles, invitations, AND the CSV
    importer's client creation (`import_firm_client`) — goes through a
    SECURITY DEFINER RPC, called AS THE USER, that asks `firm_can()`
    first and writes an audit row last. No firm-model write goes through
    the service role: a Python guard removed by hand still writes nothing.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import logging
import re
import uuid
from types import MappingProxyType
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from . import _org, _supabase

logger = logging.getLogger(__name__)

#: Contract version for the /api/firm surface. Bump on a shape change.
FIRM_API_VERSION = "firm-a1"

# ──────────────────────────────────────────────────────────────────────
# THE ROLE MATRIX — data, mirrored cell for cell by
# supabase/schema_phase_firm.sql §5 (firm_role_permissions).
# ──────────────────────────────────────────────────────────────────────

#: The five firm roles, most privileged first. Display order only — no
#: code here ranks roles to decide anything; the matrix decides.
ROLES = ("owner", "partner", "accountant", "assistant", "viewer")  # type: Tuple[str, ...]

#: The seven actions a role may or may not hold.
#:   read          see the firm's clients and their served data
#:   assign        set the responsible accountant / collaborators
#:   invite        invite people into the firm (an OWNER invite needs manage too)
#:   import        attach workspaces / bulk-create clients from CSV
#:   request_file  ask a client for a document (Part B wires the request)
#:   suppress      dismiss an attention item WITH a reason
#:   manage        rename/archive the firm, change roles, remove members
ACTIONS = ("read", "assign", "invite", "import", "request_file", "suppress",
           "manage")  # type: Tuple[str, ...]

_MATRIX_ROWS = (
    # role          read   assign invite import request_file suppress manage
    ("owner",       True,  True,  True,  True,  True,        True,    True),
    ("partner",     True,  True,  True,  True,  True,        True,    False),
    ("accountant",  True,  False, False, False, True,        True,    False),
    ("assistant",   True,  False, False, False, True,        False,   False),
    ("viewer",      True,  False, False, False, False,       False,   False),
)


def _freeze_matrix(rows):  # type: (Sequence[Tuple[Any, ...]]) -> Mapping[str, Mapping[str, bool]]
    out = {}  # type: Dict[str, Mapping[str, bool]]
    for row in rows:
        role = row[0]
        cells = row[1:]
        if len(cells) != len(ACTIONS):
            raise ValueError("matrix row for %r has %d cells, expected %d"
                             % (role, len(cells), len(ACTIONS)))
        out[role] = MappingProxyType(dict(zip(ACTIONS, (bool(c) for c in cells))))
    if tuple(out.keys()) != ROLES:
        raise ValueError("matrix rows %r do not match ROLES %r"
                         % (tuple(out.keys()), ROLES))
    return MappingProxyType(out)


#: role -> action -> allowed. Immutable; assigning into it raises.
ROLE_MATRIX = _freeze_matrix(_MATRIX_ROWS)


class FirmActionError(ValueError):
    """An action name this module does not know. A typo in a permission
    check must fail loudly, never quietly deny (or quietly allow)."""


def can(role, action):  # type: (Optional[str], str) -> bool
    """The ONE permission question. Unknown role → False (no grant for a
    name the table does not carry); unknown action → :class:`FirmActionError`.
    """
    if action not in ACTIONS:
        raise FirmActionError("unknown firm action %r (known: %s)"
                              % (action, ", ".join(ACTIONS)))
    row = ROLE_MATRIX.get(role or "")
    if row is None:
        return False
    return bool(row[action])


def permissions_for(role):  # type: (Optional[str]) -> Dict[str, bool]
    """The caller's row of the matrix, action → allowed (all False for an
    unknown role)."""
    return dict((action, can(role, action)) for action in ACTIONS)


# ──────────────────────────────────────────────────────────────────────
# Context resolution — the first wall
# ──────────────────────────────────────────────────────────────────────

class FirmContext(object):
    """Who is asking, which firm, and the role the firm gives them."""

    __slots__ = ("user_id", "firm_id", "role")

    def __init__(self, user_id, firm_id, role):  # type: (str, str, str) -> None
        self.user_id = user_id
        self.firm_id = firm_id
        self.role = role

    def __repr__(self):  # pragma: no cover — debugging aid
        return "FirmContext(user=%s, firm=%s, role=%s)" % (
            self.user_id, self.firm_id, self.role)


def _require_jwt(authorization):  # type: (Optional[str]) -> str
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token.")
    return authorization.split(" ", 1)[1].strip()


def firm_role_for_user(user_id, firm_id):  # type: (str, str) -> Optional[str]
    """The role `user_id` holds in `firm_id`, or None when not a member."""
    with _supabase.admin() as ac:
        rows = ac.select(
            "firm_memberships",
            filters={"firm_id": "eq.%s" % firm_id, "user_id": "eq.%s" % user_id},
            columns="firm_id,user_id,role",
            limit=1,
        )
    if not rows:
        return None
    return str(rows[0].get("role") or "") or None


def resolve_firm(jwt, firm_id):  # type: (str, Optional[str]) -> FirmContext
    """Resolve the caller's :class:`FirmContext` for `firm_id`, or refuse.

    403 on a non-member — never a fallback to another firm the caller
    does belong to, which would answer one firm's question with another
    firm's clients.
    """
    user_id = _org.resolve_user_id(jwt)
    requested = str(firm_id or "").strip()
    if not requested:
        raise HTTPException(400, "A firm id is required.")
    role = firm_role_for_user(user_id, requested)
    if role is None:
        raise HTTPException(403, "Not a member of the requested firm.")
    return FirmContext(user_id=user_id, firm_id=requested, role=role)


def require(ctx, action):  # type: (FirmContext, str) -> None
    """403 unless the caller's role holds `action` in the matrix."""
    if not can(ctx.role, action):
        raise HTTPException(
            403, "Your firm role does not permit '%s'." % action)


def client_org_ids(firm_id):  # type: (str) -> List[str]
    """Every workspace attached to `firm_id` (archived ones included — an
    archived client is still the firm's, and still not anyone else's).
    EVERY page (critic D11): one bare select answered 1,000 of a
    1,200-client firm, and this list is the basis of `require_client`
    (client #1,001 was "not a client of this firm"), of the digest cron
    and of the brief. A failed page raises (PageWalkError) — a wall must
    not answer from a partial list."""
    from ._paging import select_all
    with _supabase.admin() as ac:
        rows = select_all(
            ac, "organizations", order="id.asc",
            filters={"firm_id": "eq.%s" % firm_id},
            columns="id,firm_id",
        )
    return [str(r.get("id")) for r in rows or [] if r.get("id")]


#: One message for "not yours" and "does not exist": a cross-firm probe
#: must not be able to tell the two apart.
NOT_A_CLIENT = "Not a client of this firm."


def require_client(ctx, org_id):  # type: (FirmContext, str) -> str
    """403 unless `org_id` is attached to the caller's firm. Returns the
    normalised org id."""
    wanted = str(org_id or "").strip()
    if not wanted or wanted not in set(client_org_ids(ctx.firm_id)):
        raise HTTPException(403, NOT_A_CLIENT)
    return wanted


# ──────────────────────────────────────────────────────────────────────
# RPC error translation — PostgREST codes → HTTP, with the message kept
# ──────────────────────────────────────────────────────────────────────

_PG_CODE_RX = re.compile(r"""['"]code['"]\s*:\s*['"]([0-9A-Z]{5})['"]""")
# The client formats PostgREST's JSON error with %s, i.e. Python repr: a
# message holding an apostrophe is double-quoted, the rest single-quoted.
_PG_MESSAGE_RX = re.compile(r"""['"]message['"]\s*:\s*(?:"([^"]*)"|'([^']*)')""")

#: SQLSTATE → HTTP status. The RPCs in schema_phase_firm.sql raise with
#: exactly these codes; anything else is a 400 with the message.
PG_CODE_TO_HTTP = MappingProxyType({
    "42501": 403,   # insufficient_privilege — a firm_can() refusal
    "P0002": 404,   # no_data_found
    "P0001": 409,   # raise_exception — a state conflict (already attached…)
    "23505": 409,   # unique_violation
    "22023": 400,   # invalid_parameter_value
    "28000": 401,   # invalid_authorization_specification
})


def rpc_or_http(client, fn, params=None):  # type: (Any, str, Optional[Dict[str, Any]]) -> Any
    """Call an RPC through `client`; a Postgres refusal becomes the HTTP
    status its SQLSTATE means, message preserved."""
    try:
        return client.rpc(fn, params or {})
    except RuntimeError as exc:
        text = str(exc)
        code_m = _PG_CODE_RX.search(text)
        code = code_m.group(1) if code_m else ""
        msg_m = _PG_MESSAGE_RX.search(text)
        message = (msg_m.group(1) or msg_m.group(2) or "") if msg_m else text
        status = PG_CODE_TO_HTTP.get(code, 400)
        raise HTTPException(status, message)


# ──────────────────────────────────────────────────────────────────────
# Request shapes
# ──────────────────────────────────────────────────────────────────────

class CreateFirmRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)


class AttachRequest(BaseModel):
    org_id: str = Field(..., min_length=1)


class AssignmentRequest(BaseModel):
    responsible_user_id: Optional[str] = None
    collaborator_user_ids: List[str] = Field(default_factory=list)


class MemberRoleRequest(BaseModel):
    role: str = Field(..., min_length=1)


# ──────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────

def _period_row(row):  # type: (Dict[str, Any]) -> Dict[str, Any]
    """The period summary a firm sees: identity, status, and WHETHER a
    served envelope exists — never the envelope itself (that is the
    cockpit's read, Part B, through the FactsGateway)."""
    envelope = row.get("assembled_canonical_v1")
    return {
        "period_id": str(row.get("id") or ""),
        "period_label": row.get("period_label"),
        "period_start": row.get("period_start"),
        "period_end": row.get("period_end"),
        "currency": row.get("currency"),
        "status": row.get("status"),
        "has_envelope": isinstance(envelope, dict) and bool(envelope),
        "source_document_id": row.get("source_document_id"),
    }


def build_router():  # type: () -> APIRouter
    """``/api/firm/*`` — the firm model. Every route: JWT → firm
    membership (403) → matrix cell (403) → client-of-this-firm (403) →
    the caller's own RLS-scoped client."""
    router = APIRouter(prefix="/api/firm", tags=["firm"])

    # Path ids carry Starlette's `:uuid` convertor, so a sibling router's
    # literal path (`/api/firm/attention`, `/api/firm/requests/…`) is never
    # captured by `/{firm_id}` — a non-UUID segment simply does not match
    # here. Static paths still come FIRST so `/roles` reads as itself.
    @router.get("/roles")
    def get_roles(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        _require_jwt(authorization)
        return {
            "version": FIRM_API_VERSION,
            "roles": list(ROLES),
            "actions": list(ACTIONS),
            "matrix": dict((role, dict(ROLE_MATRIX[role])) for role in ROLES),
        }

    @router.get("")
    def list_my_firms(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        _org.resolve_user_id(jwt)
        with _supabase.per_user(jwt) as client:
            rows = rpc_or_http(client, "list_firms") or []
        return {"version": FIRM_API_VERSION, "firms": rows}

    @router.post("")
    def create_firm(body: CreateFirmRequest,
                    authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        _org.resolve_user_id(jwt)
        with _supabase.per_user(jwt) as client:
            firm_id = rpc_or_http(client, "create_firm", {"p_name": body.name})
        return {"firm_id": str(firm_id)}

    @router.get("/{firm_id:uuid}")
    def get_firm(firm_id: uuid.UUID,
                 authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        ctx = resolve_firm(jwt, firm_id)
        with _supabase.per_user(jwt) as client:
            rows = client.select("firms", filters={"id": "eq.%s" % ctx.firm_id},
                                 limit=1) or []
        if not rows:
            # Member of a firm RLS will not show: only possible if the
            # policy and the membership disagree — refuse, never invent.
            raise HTTPException(403, "Not a member of the requested firm.")
        firm = rows[0]
        return {
            "version": FIRM_API_VERSION,
            "firm": {"id": str(firm.get("id")), "name": firm.get("name"),
                     "archived_at": firm.get("archived_at"),
                     "created_at": firm.get("created_at")},
            "role": ctx.role,
            "permissions": permissions_for(ctx.role),
        }

    @router.get("/{firm_id:uuid}/members")
    def list_members(firm_id: uuid.UUID,
                     authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        ctx = resolve_firm(jwt, firm_id)
        with _supabase.per_user(jwt) as client:
            rows = rpc_or_http(client, "list_firm_members",
                               {"p_firm_id": ctx.firm_id}) or []
        return {"firm_id": ctx.firm_id, "members": rows}

    @router.put("/{firm_id:uuid}/members/{user_id:uuid}/role")
    def set_member_role(firm_id: uuid.UUID, user_id: uuid.UUID, body: MemberRoleRequest,
                        authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        ctx = resolve_firm(jwt, firm_id)
        require(ctx, "manage")
        if body.role not in ROLES:
            raise HTTPException(400, "Unknown firm role %r." % body.role)
        target = str(user_id)
        with _supabase.per_user(jwt) as client:
            rpc_or_http(client, "set_firm_member_role", {
                "p_firm_id": ctx.firm_id, "p_user_id": target, "p_role": body.role})
        return {"firm_id": ctx.firm_id, "user_id": target, "role": body.role}

    @router.delete("/{firm_id:uuid}/members/{user_id:uuid}")
    def remove_member(firm_id: uuid.UUID, user_id: uuid.UUID,
                      authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        ctx = resolve_firm(jwt, firm_id)
        # Leaving is always the member's own right; removing someone else
        # needs `manage`. The RPC enforces the same rule a second time.
        target = str(user_id)
        if target != ctx.user_id:
            require(ctx, "manage")
        with _supabase.per_user(jwt) as client:
            rpc_or_http(client, "remove_firm_member",
                        {"p_firm_id": ctx.firm_id, "p_user_id": target})
        return {"firm_id": ctx.firm_id, "user_id": target, "removed": True}

    @router.get("/{firm_id:uuid}/clients")
    def list_clients(firm_id: uuid.UUID,
                     authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        ctx = resolve_firm(jwt, firm_id)
        require(ctx, "read")
        with _supabase.per_user(jwt) as client:
            rows = rpc_or_http(client, "list_firm_clients",
                               {"p_firm_id": ctx.firm_id}) or []
        return {"version": FIRM_API_VERSION, "firm_id": ctx.firm_id,
                "clients": rows, "count": len(rows)}

    @router.post("/{firm_id:uuid}/clients/attach")
    def attach_client(firm_id: uuid.UUID, body: AttachRequest,
                      authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        ctx = resolve_firm(jwt, firm_id)
        require(ctx, "import")
        with _supabase.per_user(jwt) as client:
            rpc_or_http(client, "attach_workspace_to_firm",
                        {"p_org_id": body.org_id, "p_firm_id": ctx.firm_id})
        return {"firm_id": ctx.firm_id, "org_id": body.org_id, "attached": True}

    @router.post("/{firm_id:uuid}/clients/{org_id:uuid}/detach")
    def detach_client(firm_id: uuid.UUID, org_id: uuid.UUID,
                      authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        ctx = resolve_firm(jwt, firm_id)
        wanted = require_client(ctx, org_id)
        # Owner-or-manage is decided by the RPC (it can see the workspace's
        # memberships); the Python side only pins the client to THIS firm.
        with _supabase.per_user(jwt) as client:
            rpc_or_http(client, "detach_workspace_from_firm", {"p_org_id": wanted})
        return {"firm_id": ctx.firm_id, "org_id": wanted, "detached": True}

    @router.put("/{firm_id:uuid}/clients/{org_id:uuid}/assignment")
    def assign_client(firm_id: uuid.UUID, org_id: uuid.UUID, body: AssignmentRequest,
                      authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        ctx = resolve_firm(jwt, firm_id)
        require(ctx, "assign")
        wanted = require_client(ctx, org_id)
        with _supabase.per_user(jwt) as client:
            rpc_or_http(client, "assign_client", {
                "p_org_id": wanted,
                "p_responsible": body.responsible_user_id,
                "p_collaborators": list(body.collaborator_user_ids or []),
            })
        return {"firm_id": ctx.firm_id, "org_id": wanted,
                "responsible_user_id": body.responsible_user_id,
                "collaborator_user_ids": list(body.collaborator_user_ids or [])}

    @router.get("/{firm_id:uuid}/clients/{org_id:uuid}/periods")
    def client_periods(firm_id: uuid.UUID, org_id: uuid.UUID,
                       authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """The client's periods as the FIRM sees them — read through the
        caller's own client, so `financial_periods firm read` (RLS) is
        the wall even if the Python guard above it were removed."""
        jwt = _require_jwt(authorization)
        ctx = resolve_firm(jwt, firm_id)
        require(ctx, "read")
        wanted = require_client(ctx, org_id)
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "financial_periods",
                filters={"org_id": "eq.%s" % wanted},
                order="period_end.desc",
                limit=60,
            ) or []
        return {"version": FIRM_API_VERSION, "firm_id": ctx.firm_id,
                "org_id": wanted,
                "periods": [_period_row(r) for r in rows],
                "count": len(rows)}

    @router.get("/{firm_id:uuid}/audit")
    def audit(firm_id: uuid.UUID, limit: int = 100,
              authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        ctx = resolve_firm(jwt, firm_id)
        require(ctx, "manage")
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "firm_audit_log",
                filters={"firm_id": "eq.%s" % ctx.firm_id},
                order="created_at.desc",
                limit=max(1, min(int(limit), 500)),
            ) or []
        return {"firm_id": ctx.firm_id, "entries": rows, "count": len(rows)}

    # Sibling surfaces share the /api/firm prefix and this router's
    # ordering guarantees (static paths before `/{firm_id}`), so server.py
    # mounts the firm model with ONE include. Local imports: both modules
    # import this one for resolve_firm/require, a top-level import would
    # be a cycle.
    from . import _firm_import, _firm_invites
    router.include_router(_firm_invites.build_router())
    router.include_router(_firm_import.build_router())

    return router


__all__ = [
    "FIRM_API_VERSION", "ROLES", "ACTIONS", "ROLE_MATRIX",
    "FirmActionError", "FirmContext", "NOT_A_CLIENT", "PG_CODE_TO_HTTP",
    "can", "permissions_for", "resolve_firm", "firm_role_for_user",
    "require", "require_client", "client_org_ids", "rpc_or_http",
    "build_router",
]
