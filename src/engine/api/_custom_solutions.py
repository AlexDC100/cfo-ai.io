"""Custom solutions — the admin side of per-account access.

A custom solution is a bespoke workspace built on top of CFO AI for one
client (the first: AutoMasters, the CFO side of the AutoMasters dealership
app). Access is per ACCOUNT: the operator links an account to a solution
here, and the frontend shows the solution to that account only. Storage is
``custom_solutions`` / ``custom_solution_grants`` (see
``supabase/schema_phase_custom_solutions.sql``); grants are written ONLY by
this module, through the service role — the tables carry no client write
policy.

ROUTES
======
  GET    /api/admin/me                                   → {"is_admin": bool}
  GET    /api/admin/custom-solutions                     → catalogue + linked accounts
  POST   /api/admin/custom-solutions/{key}/grants        → link an account by e-mail
  DELETE /api/admin/custom-solutions/{key}/grants/{uid}  → unlink an account

AUTH
====
Every route needs a VERIFIED bearer (``_supabase.SupabaseClient.get_user``
checks the signature). ``/api/admin/me`` answers for any signed-in user — it
only says whether that user is an operator, so the frontend can show the
Admin page. The other three are operator-only: the verified user id must be
in ``PLATFORM_ADMIN_USER_IDS`` or ``PRICING_ADMIN_USER_IDS`` (comma-separated
env allowlists, the same model as the pricing / newsletter admin routes).
An empty allowlist means nobody is an operator — the routes fail closed.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from . import _supabase

logger = logging.getLogger(__name__)

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,39}$")
_UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")


# ── Auth ────────────────────────────────────────────────────────────────────

def _require_jwt(authorization: Optional[str]) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    return authorization.split(" ", 1)[1].strip()


def _user_id_from_jwt(jwt: str) -> str:
    with _supabase.per_user(jwt) as client:
        user = client.get_user(jwt)
    uid = user.get("id") if user else None
    if not uid:
        raise HTTPException(401, "Could not resolve user from JWT.")
    return uid


def admin_user_ids() -> set:
    """The operator allowlist. Read per call (never cached), so a changed
    env takes effect on the next request and a test can set it freely."""
    out = set()
    for name in ("PLATFORM_ADMIN_USER_IDS", "PRICING_ADMIN_USER_IDS"):
        out.update(u.strip() for u in os.environ.get(name, "").split(",") if u.strip())
    return out


def is_admin(user_id: str) -> bool:
    return bool(user_id) and user_id in admin_user_ids()


def _require_admin(authorization: Optional[str]) -> str:
    uid = _user_id_from_jwt(_require_jwt(authorization))
    if not is_admin(uid):
        raise HTTPException(
            403,
            "Admin-only endpoint. Add the user_id to PLATFORM_ADMIN_USER_IDS.",
        )
    return uid


def _check_key(key: str) -> str:
    if not _KEY_RE.match(key or ""):
        raise HTTPException(404, "Unknown custom solution.")
    return key


# ── Request models (module scope: test_route_bindings) ─────────────────────

class GrantRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)
    note: Optional[str] = Field(None, max_length=200)


# ── Reads ───────────────────────────────────────────────────────────────────

def _emails_for(client: Any, ids: List[str]) -> Dict[str, str]:
    if not ids:
        return {}
    rows = client.rpc("admin_user_emails", {"_ids": ids}) or []
    return {str(r.get("id")): r.get("email") or "" for r in rows if r.get("id")}


def list_solutions(client: Any) -> List[Dict[str, Any]]:
    """Every solution with the accounts linked to it, oldest grant first."""
    solutions = client.select(
        "custom_solutions", columns="key,name,description,created_at", order="name.asc",
    )
    grants = client.select(
        "custom_solution_grants",
        columns="solution_key,user_id,granted_by,granted_at,note",
        order="granted_at.asc",
    )
    ids = sorted({str(g["user_id"]) for g in grants}
                 | {str(g["granted_by"]) for g in grants if g.get("granted_by")})
    emails = _emails_for(client, ids)
    by_key: Dict[str, List[Dict[str, Any]]] = {}
    for g in grants:
        by_key.setdefault(g["solution_key"], []).append({
            "user_id": str(g["user_id"]),
            "email": emails.get(str(g["user_id"]), ""),
            "granted_at": g.get("granted_at"),
            "granted_by_email": emails.get(str(g.get("granted_by") or ""), None),
            "note": g.get("note"),
        })
    return [{
        "key": s["key"],
        "name": s["name"],
        "description": s.get("description"),
        "accounts": by_key.get(s["key"], []),
    } for s in solutions]


# ── Router ──────────────────────────────────────────────────────────────────

def build_router() -> APIRouter:
    router = APIRouter(tags=["admin"])

    @router.get("/api/admin/me")
    def admin_me(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        uid = _user_id_from_jwt(_require_jwt(authorization))
        return {"is_admin": is_admin(uid)}

    @router.get("/api/admin/custom-solutions")
    def admin_list(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        _require_admin(authorization)
        with _supabase.admin() as client:
            return {"solutions": list_solutions(client)}

    @router.post("/api/admin/custom-solutions/{key}/grants")
    def admin_grant(key: str, req: GrantRequest,
                    authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        admin_uid = _require_admin(authorization)
        key = _check_key(key)
        email = (req.email or "").strip().lower()
        if not _EMAIL_RE.match(email):
            raise HTTPException(422, "A valid email address is required.")
        note = (req.note or "").strip() or None
        with _supabase.admin() as client:
            if not client.select("custom_solutions", filters={"key": f"eq.{key}"},
                                 columns="key", limit=1):
                raise HTTPException(404, "Unknown custom solution.")
            found = client.rpc("admin_find_user_by_email", {"_email": email}) or []
            if not found:
                raise HTTPException(
                    404,
                    "No CFO AI account uses this e-mail. The person must sign up first.",
                )
            user_id = str(found[0]["id"])
            client.upsert("custom_solution_grants", {
                "solution_key": key,
                "user_id": user_id,
                "granted_by": admin_uid,
                "note": note,
            }, on_conflict="solution_key,user_id")
            logger.info("[custom-solutions] %s linked %s to %s", admin_uid, user_id, key)
            return {"ok": True, "solutions": list_solutions(client)}

    @router.delete("/api/admin/custom-solutions/{key}/grants/{user_id}")
    def admin_revoke(key: str, user_id: str,
                     authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        admin_uid = _require_admin(authorization)
        key = _check_key(key)
        if not _UUID_RE.match(user_id or ""):
            raise HTTPException(404, "Unknown account.")
        with _supabase.admin() as client:
            client.delete("custom_solution_grants", filters={
                "solution_key": f"eq.{key}",
                "user_id": f"eq.{user_id}",
            })
            logger.info("[custom-solutions] %s unlinked %s from %s", admin_uid, user_id, key)
            return {"ok": True, "solutions": list_solutions(client)}

    return router


__all__ = ["GrantRequest", "admin_user_ids", "build_router", "is_admin", "list_solutions"]
