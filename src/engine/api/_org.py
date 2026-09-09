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

IDENTITY (2026-09-05, FC1x, critic D5). `resolve_user_id` returns a
VERIFIED identity or raises — `_jwt.verified_identity` checks the ES256
signature against Supabase's JWKS plus exp / iss / aud / sub. It used to
read the payload without verifying it (`_supabase._decode_jwt_claims`, now
gone), so a forged bearer carrying a victim's `sub` passed every Python wall
in this package: `POST /api/documents/clear-mine` soft-deleted the victim's
documents through the service role, `GET`/`PUT /api/dashboard/config` read
and wrote the victim's layout, `POST /api/firm/email/drain` was gated only
by the forgeable `sub` ∈ PRICING_ADMIN_USER_IDS. Nothing on those paths
sent the JWT to PostgREST, so its signature check never ran — one wall, not
two. The identity is deliberately NOT routed through `per_user(jwt)`: a
signature check is a property of the verifier, never of a database client
a test double can stand in for.

THE WRITE WALL (critic D4). `require_org_member` is what every mutating
route outside /api/firm goes through: a verified identity AND a
`memberships` row in the org the write targets. Firm READ visibility
(`can_read_client_org`, schema_phase_firm.sql) is a read grant on the
client's books and never satisfies it — a firm VIEWER with a read cell and
no membership hard-deleted a client's period through DELETE /api/period/{id}
because that route asked only "is the period visible under per_user?"
(crit_pipeline_census.py). A write needs a membership row; visibility is
the READ wall.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Header, HTTPException

from . import _jwt, _supabase

logger = logging.getLogger(__name__)

TABLE_ORGS = "organizations"


def resolve_user_id(jwt: str) -> str:
    """The VERIFIED user id. 401 (`_jwt.InvalidToken`) when the bearer's
    signature does not verify or its exp / iss / aud / sub fail; 503
    (`_jwt.IdentityUnavailable`) when no signing key can be obtained. Never
    an unverified decode — there is no fallback."""
    return str(_jwt.verified_identity(jwt)["id"])


def user_is_member(user_id: str, org_id: str) -> bool:
    """True when `user_id` holds a membership in `org_id`."""
    with _supabase.admin() as ac:
        rows = ac.select(
            "memberships",
            filters={"user_id": f"eq.{user_id}", "org_id": f"eq.{org_id}"},
            limit=1,
        )
    return bool(rows)


def member_org_ids(user_id: str) -> List[str]:
    """Every org `user_id` holds a `memberships` row in — the scope a bulk
    write ("everything visible to me") must be narrowed to. Firm visibility
    is deliberately not part of it. Read as the service role: a per-user
    read of `memberships` would answer the same rows (`auth.uid() =
    user_id`), but this helper is called with an already-verified id and
    must not depend on a client a test double can wave through."""
    with _supabase.admin() as ac:
        rows = ac.select(
            "memberships",
            filters={"user_id": f"eq.{user_id}"},
            columns="org_id",
        )
    return [str(r["org_id"]) for r in rows or [] if r.get("org_id")]


def verified_user_id(jwt: str) -> str:
    """`resolve_user_id` with the PUBLIC_TEST_MODE seam every other identity
    helper carries: under test mode the shared test user stands in (its
    only membership is the test org); otherwise the VERIFIED id or 401 /
    503. Call this BEFORE any per-user table read on a mutating route — a
    forged bearer is then refused by the verifier (401) rather than by an
    anonymous read that finds nothing (404), and never reaches PostgREST."""
    from . import _test_mode
    if _test_mode.is_bypass_token(jwt):
        return _test_mode.test_user_id()
    return resolve_user_id(jwt)


def require_org_member(jwt: str, org_id: Optional[str]) -> str:
    """THE WRITE WALL. A verified identity that holds a `memberships` row
    in `org_id` → its user id. Otherwise 403 — never firm visibility, never
    `can_read_client_org`, never a fallback to another org the caller does
    belong to (that would re-target the write). An empty / unknown org is a
    403 too: a write whose target org cannot be named has no wall to pass.
    Under PUBLIC_TEST_MODE the shared test user stands in, exactly as every
    other identity seam does (its only membership is the test org)."""
    user_id = verified_user_id(jwt)
    org = str(org_id or "").strip()
    if not org or not user_is_member(user_id, org):
        raise HTTPException(403, "Not a member of the workspace this write targets.")
    return user_id


def default_org_for_user(user_id: str) -> Optional[str]:
    """The user's oldest LIVE membership — the fallback when no org was requested.

    Ordered by created_at so the answer is stable rather than whatever
    Postgres happens to return first; an unordered `limit 1` could hand back a
    different workspace between two requests in the same session.

    Archived organizations are excluded (2026-08-02): memberships survive a
    workspace archive, so the bare memberships query could scope a request to
    an org scheduled for purge — data read from (or attributed to) a workspace
    the user deleted. We fetch a few memberships and check archived_at per
    org; membership counts are tiny so the extra lookups are negligible.
    """
    with _supabase.admin() as ac:
        rows = ac.select(
            "memberships",
            filters={"user_id": f"eq.{user_id}"},
            order="created_at.asc",
            limit=10,
        )
        for row in rows:
            org = ac.select(
                "organizations",
                filters={"id": f"eq.{row['org_id']}"},
                limit=1,
            )
            if org and org[0].get("archived_at") is None:
                return row["org_id"]
    return None


#: The columns an org-level CAEN read needs. Named, not `select=*`, so a
#: reader can see what this touches.
CAEN_COLUMNS = "id,caen_code"


def caen_for_org(client: Any, org_id: str) -> Optional[str]:
    """The workspace's CAEN industry code, or ABSENT.

    ONE AUTHORITY, and it lives here because CAEN is a property of the
    ORGANIZATION — `schema_phase7_benchmarks.sql:17` puts it there and
    nowhere else. `financial_periods` has never carried the column.

    Three surfaces read it off a `financial_periods` row instead, and each
    failed differently:

      · `_radar.light_input` — `select=*`, so PostgREST answered 200 with
        the key simply absent. Every served radar finding ran with
        `caen=None` and was industry-unqualified, silently, forever.
      · `_capsule_tools._context` — the same shape, the same silence, on a
        router mounted UNCONDITIONALLY. Every Capsule finding too.
      · `_firm_attention.LIGHT_PERIOD_COLUMNS` — an EXPLICIT projection, so
        PostgREST answers 400 `42703 undefined column`, which
        `classify_read_error` grades `bad_column` and `get_board` turns
        into a 500. The whole Firm Attention board, not one field. Latent
        only because FIRM_COCKPIT_ENABLED is unset.

    Fails OPEN, like `load_dismissals`: a missing column or an RLS refusal
    yields None and the finding's own profile says it is unqualified.
    Raising here would take a whole payload down over a classification.
    """
    try:
        rows = client.select(TABLE_ORGS, filters={"id": "eq.%s" % org_id},
                             columns=CAEN_COLUMNS, limit=1) or []
    except Exception:  # noqa: BLE001 — a classification is not worth a 500
        logger.exception("[org] CAEN lookup failed for %s", org_id)
        return None
    if not rows:
        return None
    value = str(rows[0].get("caen_code") or "").strip()
    return value or None


def caen_of_org_row(org: Any) -> Optional[str]:
    """The same value, when the caller ALREADY holds the org row.

    `_firm_attention` reads `organizations` with `select=*` for its whole
    board, so a second round trip per client would be a query per client
    for a value already in hand."""
    if not isinstance(org, dict):
        return None
    value = str(org.get("caen_code") or "").strip()
    return value or None


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

        Like the renewal-reminder cron in _billing.py (fail-closed since
        2026-09-04), this endpoint FAILS CLOSED: it erases
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
