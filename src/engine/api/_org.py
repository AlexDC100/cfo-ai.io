"""Shared workspace (organization) resolution for every authenticated route.

A workspace IS an organization. A user can be a member of several — one per
company (SRL) — so "which org is this request about?" can no longer be answered
by taking the first membership row. The client tells us via the `X-Org-Id`
header (set once in frontend/lib/cfoApi.ts) and we VALIDATE that the caller is
actually a member of it.

This replaces five near-identical `_resolve_user_org()` / `_primary_org_for_user()`
helpers that each did `memberships … limit=1` and silently picked an arbitrary
org:

    _benchmarks.py, _industry_intelligence.py, _billing.py,
    pipeline.py (x2, inlined to dodge a circular import)

Compatibility: when the header is absent (an older cached bundle, a server-to-
server call, or test mode — see _test_mode.py, which seeds exactly one org) we
fall back to the user's oldest membership. That keeps every existing route
working while the frontend rolls out. What we never do is accept an org the
caller doesn't belong to.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, Header, HTTPException

from . import _supabase

logger = logging.getLogger(__name__)


def resolve_user_id(jwt: str) -> str:
    """User id from a JWT, or 401."""
    with _supabase.per_user(jwt) as client:
        user = client.get_user(jwt)
    user_id = user.get("id") if user else None
    if not user_id:
        raise HTTPException(401, "Could not resolve user from JWT.")
    return str(user_id)


def user_is_member(user_id: str, org_id: str) -> bool:
    """True when `user_id` holds a membership in `org_id`."""
    with _supabase.admin() as ac:
        rows = ac.select(
            "memberships",
            filters={"user_id": f"eq.{user_id}", "org_id": f"eq.{org_id}"},
            limit=1,
        )
    return bool(rows)


def default_org_for_user(user_id: str) -> Optional[str]:
    """The user's oldest membership — the fallback when no org was requested.

    Ordered by created_at so the answer is stable rather than whatever
    Postgres happens to return first; an unordered `limit 1` could hand back a
    different workspace between two requests in the same session.
    """
    with _supabase.admin() as ac:
        rows = ac.select(
            "memberships",
            filters={"user_id": f"eq.{user_id}"},
            order="created_at.asc",
            limit=1,
        )
    return rows[0]["org_id"] if rows else None


def resolve_org(jwt: str, requested_org_id: Optional[str] = None) -> Tuple[str, str]:
    """Resolve ``(user_id, org_id)`` for an authenticated request.

    `requested_org_id` is the `X-Org-Id` header. If present it must name an org
    the caller belongs to — otherwise 403, never a silent fallback to a
    different workspace, which would return one company's numbers under
    another's name.
    """
    user_id = resolve_user_id(jwt)

    requested = (requested_org_id or "").strip()
    if requested:
        if not user_is_member(user_id, requested):
            raise HTTPException(403, "Not a member of the requested workspace.")
        return user_id, requested

    org_id = default_org_for_user(user_id)
    if not org_id:
        raise HTTPException(404, "User has no organization membership.")
    return user_id, org_id


# ──────────────────────────────────────────────────────────────────────
# Workspace lifecycle cron
# ──────────────────────────────────────────────────────────────────────

def create_workspaces_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/workspaces/cron/purge-expired")
    def purge_expired_workspaces(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Permanently delete workspaces whose 30-day recovery window has
        closed. Schedule a daily call (e.g. 03:30 UTC).

        Auth is the engine bearer token (ENGINE_API_TOKEN), not a user JWT —
        this is scheduler-only.

        Unlike the renewal-reminder cron in _billing.py, which runs open when
        ENGINE_API_TOKEN is unset, this endpoint FAILS CLOSED: it erases
        customer data irreversibly, so an unconfigured deployment must not be
        able to trigger it anonymously.
        """
        token = os.environ.get("ENGINE_API_TOKEN")
        if not token:
            raise HTTPException(
                503,
                "ENGINE_API_TOKEN is not configured; refusing to run a destructive purge.",
            )
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "Missing Bearer token.")
        if authorization.split(" ", 1)[1].strip() != token:
            raise HTTPException(401, "Invalid scheduler token.")

        # service_role — purge_expired_workspaces() is revoked from anon and
        # authenticated in schema_phase_multi_workspace.sql.
        with _supabase.admin() as client:
            purged = client.rpc("purge_expired_workspaces")
        count = int(purged or 0)
        if count:
            logger.info("[workspaces] purged %s expired workspace(s)", count)
        return {"purged": count}

    return router
