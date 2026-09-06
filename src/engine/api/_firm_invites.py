"""FIRM INVITATIONS — e-mail-scoped, role-scoped, expiring, audit-logged.

An invitation names an e-mail address and a role. Redeeming it requires
a signed-in account whose JWT e-mail matches — it is not a bearer link
any account can spend. It expires (1 h .. 30 d, default 7 d), can be
revoked by anyone holding `invite`, and every step writes a
`firm_audit_log` row (create / accept / revoke), all inside the
SECURITY DEFINER RPCs in supabase/schema_phase_firm.sql.

SENDING IS A STUB. :func:`enqueue_invitation_email` drops a structured
row into `firm_invite_email_queue` — the same columns as
`renewal_email_queue` (schema_phase_newsletter.sql), so the existing
drain shape applies once a drain is pointed at this table. Until then
the inviter receives the token in the create response and can hand the
accept link over by any channel; nothing is silently "sent".

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from . import _firm, _org, _supabase

logger = logging.getLogger(__name__)

#: The queue this wave writes to. Mirrors renewal_email_queue's columns.
INVITE_QUEUE_TABLE = "firm_invite_email_queue"
INVITE_TEMPLATE = "firm_invitation"

#: The frontend route the accept link points at (the /firm screen is a
#: later wave; this is the contract it will honour).
ACCEPT_PATH = "/firm/invitations/accept"

DEFAULT_TTL_HOURS = 168
MIN_TTL_HOURS = 1
MAX_TTL_HOURS = 720


def _now():  # type: () -> datetime
    return datetime.now(timezone.utc)


def _parse_ts(value):  # type: (Any) -> Optional[datetime]
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def invitation_status(row, now=None):  # type: (Dict[str, Any], Optional[datetime]) -> str
    """revoked | accepted | expired | pending — decided from the row and an
    explicit clock, so the answer is reproducible."""
    if row.get("revoked_at"):
        return "revoked"
    if row.get("accepted_at"):
        return "accepted"
    expires = _parse_ts(row.get("expires_at"))
    moment = now or _now()
    if expires is not None and expires < moment:
        return "expired"
    return "pending"


def accept_url(token):  # type: (str) -> str
    base = (os.environ.get("APP_URL") or "").rstrip("/")
    return "%s%s?token=%s" % (base, ACCEPT_PATH, token)


def build_invitation_payload(invitation, firm_name):  # type: (Dict[str, Any], str) -> Dict[str, Any]
    """The structured e-mail the queue carries — same shape as the renewal
    reminder payload (`to`, `template`, `subject`, `vars`)."""
    return {
        "to": invitation.get("email"),
        "template": INVITE_TEMPLATE,
        "subject": "You have been invited to join %s on CFO AI" % (firm_name or "a firm"),
        "vars": {
            "firm_name": firm_name,
            "role": invitation.get("role"),
            "accept_url": accept_url(str(invitation.get("token") or "")),
            "expires_at": invitation.get("expires_at"),
        },
    }


def enqueue_invitation_email(invitation, firm_name):  # type: (Dict[str, Any], str) -> Dict[str, Any]
    """Drop the invitation e-mail into the queue (service role — the
    queue has no client policy). Never raises: a missing queue table is
    logged and reported as `queued: False`, exactly like the billing
    renewal reminders, so the invitation itself is not lost."""
    payload = build_invitation_payload(invitation, firm_name)
    row = {
        "invitation_id": invitation.get("id"),
        "send_at": _now().isoformat(),
        "template": INVITE_TEMPLATE,
        "payload": payload,
        "sent_at": None,
    }
    try:
        with _supabase.admin() as client:
            client.insert(INVITE_QUEUE_TABLE, row, returning=False)
        return {"queued": True, "template": INVITE_TEMPLATE}
    except Exception:  # noqa: BLE001 — queue missing / unreachable
        logger.info("[firm] invitation e-mail pending (queue unavailable): %s",
                    payload)
        return {"queued": False, "template": INVITE_TEMPLATE,
                "note": "e-mail queue unavailable; the accept link is in this response"}


# ──────────────────────────────────────────────────────────────────────
# Request shapes
# ──────────────────────────────────────────────────────────────────────

class CreateInvitationRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)
    role: str = Field(..., min_length=1)
    ttl_hours: int = Field(DEFAULT_TTL_HOURS, ge=MIN_TTL_HOURS, le=MAX_TTL_HOURS)


class AcceptInvitationRequest(BaseModel):
    token: str = Field(..., min_length=1)


def _public_invitation(row, now=None):  # type: (Dict[str, Any], Optional[datetime]) -> Dict[str, Any]
    return {
        "id": str(row.get("id") or ""),
        "firm_id": str(row.get("firm_id") or ""),
        "email": row.get("email"),
        "role": row.get("role"),
        "status": invitation_status(row, now),
        "expires_at": row.get("expires_at"),
        "accepted_at": row.get("accepted_at"),
        "revoked_at": row.get("revoked_at"),
        "created_at": row.get("created_at"),
        "invited_by": row.get("invited_by"),
    }


def build_router():  # type: () -> APIRouter
    """Included into the firm router (prefix /api/firm) by
    `_firm.build_router`. Paths are relative to that prefix."""
    router = APIRouter(tags=["firm-invitations"])

    @router.post("/{firm_id:uuid}/invitations")
    def create_invitation(firm_id: uuid.UUID, body: CreateInvitationRequest,
                          authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _firm._require_jwt(authorization)
        ctx = _firm.resolve_firm(jwt, firm_id)
        _firm.require(ctx, "invite")
        if body.role not in _firm.ROLES:
            raise HTTPException(400, "Unknown firm role %r." % body.role)
        with _supabase.per_user(jwt) as client:
            invitation_id = _firm.rpc_or_http(client, "create_firm_invitation", {
                "p_firm_id": ctx.firm_id,
                "p_email": body.email,
                "p_role": body.role,
                "p_ttl_hours": int(body.ttl_hours),
            })
            rows = client.select("firm_invitations",
                                 filters={"id": "eq.%s" % invitation_id},
                                 limit=1) or []
            firm_rows = client.select("firms",
                                      filters={"id": "eq.%s" % ctx.firm_id},
                                      columns="id,name", limit=1) or []
        if not rows:
            raise HTTPException(500, "Invitation was created but cannot be read back.")
        invitation = rows[0]
        firm_name = str((firm_rows[0].get("name") if firm_rows else "") or "")
        email = enqueue_invitation_email(invitation, firm_name)
        out = _public_invitation(invitation)
        # The inviter is the one party who may hold the token: sending is
        # a stub, so the accept link must be retrievable from here.
        out["token"] = str(invitation.get("token") or "")
        out["accept_url"] = accept_url(out["token"])
        return {"invitation": out, "email": email}

    @router.get("/{firm_id:uuid}/invitations")
    def list_invitations(firm_id: uuid.UUID,
                         authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _firm._require_jwt(authorization)
        ctx = _firm.resolve_firm(jwt, firm_id)
        _firm.require(ctx, "invite")
        with _supabase.per_user(jwt) as client:
            rows = client.select("firm_invitations",
                                 filters={"firm_id": "eq.%s" % ctx.firm_id},
                                 order="created_at.desc", limit=500) or []
        now = _now()
        return {"firm_id": ctx.firm_id,
                "invitations": [_public_invitation(r, now) for r in rows],
                "count": len(rows)}

    @router.post("/{firm_id:uuid}/invitations/{invitation_id:uuid}/revoke")
    def revoke_invitation(firm_id: uuid.UUID, invitation_id: uuid.UUID,
                          authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _firm._require_jwt(authorization)
        ctx = _firm.resolve_firm(jwt, firm_id)
        _firm.require(ctx, "invite")
        wanted = str(invitation_id)
        with _supabase.per_user(jwt) as client:
            # The invitation must be THIS firm's: the inviter policy scopes
            # the read, and the RPC re-checks `invite` on the row's firm.
            rows = client.select("firm_invitations",
                                 filters={"id": "eq.%s" % wanted,
                                          "firm_id": "eq.%s" % ctx.firm_id},
                                 limit=1) or []
            if not rows:
                raise HTTPException(404, "Invitation not found.")
            _firm.rpc_or_http(client, "revoke_firm_invitation",
                              {"p_invitation_id": wanted})
        return {"firm_id": ctx.firm_id, "invitation_id": wanted,
                "revoked": True}

    @router.post("/invitations/accept")
    def accept_invitation(body: AcceptInvitationRequest,
                          authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _firm._require_jwt(authorization)
        user_id = _org.resolve_user_id(jwt)
        with _supabase.per_user(jwt) as client:
            firm_id = _firm.rpc_or_http(client, "accept_firm_invitation",
                                        {"p_token": body.token})
        role = _firm.firm_role_for_user(user_id, str(firm_id))
        return {"firm_id": str(firm_id), "user_id": user_id, "role": role,
                "permissions": _firm.permissions_for(role)}

    @router.get("/invitations/mine")
    def my_invitations(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Pending invitations addressed to the caller's e-mail (the
        invitee select policy scopes the read to their own address)."""
        jwt = _firm._require_jwt(authorization)
        _org.resolve_user_id(jwt)
        with _supabase.per_user(jwt) as client:
            rows = client.select("firm_invitations",
                                 order="created_at.desc", limit=100) or []
        now = _now()
        pending = [r for r in rows if invitation_status(r, now) == "pending"]
        firm_names = {}  # type: Dict[str, str]
        if pending:
            # The invitee is not a member yet, so the firms policy hides
            # the name; read just the names of the firms that invited them.
            with _supabase.admin() as ac:
                for firm_id in sorted(set(str(r.get("firm_id")) for r in pending)):
                    firm_rows = ac.select("firms", filters={"id": "eq.%s" % firm_id},
                                          columns="id,name", limit=1) or []
                    if firm_rows:
                        firm_names[firm_id] = str(firm_rows[0].get("name") or "")
        out = []  # type: List[Dict[str, Any]]
        for r in pending:
            item = _public_invitation(r, now)
            item["firm_name"] = firm_names.get(item["firm_id"])
            item["token"] = str(r.get("token") or "")
            out.append(item)
        return {"invitations": out, "count": len(out)}

    return router


__all__ = [
    "INVITE_QUEUE_TABLE", "INVITE_TEMPLATE", "ACCEPT_PATH",
    "DEFAULT_TTL_HOURS", "MIN_TTL_HOURS", "MAX_TTL_HOURS",
    "invitation_status", "accept_url", "build_invitation_payload",
    "enqueue_invitation_email", "build_router",
]
