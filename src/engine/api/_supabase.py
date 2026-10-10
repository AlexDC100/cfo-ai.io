"""Minimal Supabase REST client for the FastAPI backend.

Two clients:
  - service_role: bypasses RLS for pipeline writes (compute, narrate, status).
  - per_user(jwt):  honors RLS; used to validate the caller actually owns the
                    document they're asking us to process.

Surface is intentionally narrow — only the methods the pipeline needs.
PostgREST URL pattern: <SUPABASE_URL>/rest/v1/<table>?select=*&col=eq.value

A read (`select`, the client's one GET, through `_get`) that times out is
logged at WARNING and retried ONCE (ruling R5, 2026-09-28); a write is never
retried (gate supabase-read-retry).
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx


logger = logging.getLogger(__name__)


class CrossTenantStoragePath(RuntimeError):
    """A storage path was asked for under an org that does not own it.

    Raised INSTEAD of performing the operation. Never caught to continue —
    a caller that sees this has been handed a path belonging to another
    tenant and must fail the request.
    """


#: Buckets whose object keys are tenant-scoped as `{org_id}/...`.
#: `documents` is written by lib/supabase.ts's uploadDocument and by
#: `_firm_requests`, both using `{org_id}/uploads/{document_id}.{ext}`.
TENANT_SCOPED_BUCKETS = frozenset({"documents"})


def assert_tenant_path(bucket: str, path: str, org_id: Optional[str],
                       *, op: str) -> None:
    """Refuse a service-role storage operation on another tenant's object.

    WHY THIS EXISTS (P0, 2026-09-09). `documents.storage_path` is written
    by the BROWSER. RLS on the `documents` table constrains which org a
    row may be filed under, and the storage bucket's own RLS binds the
    first path segment to `is_member_of(...)` — but the engine signs and
    deletes with the SERVICE ROLE, which bypasses storage RLS entirely,
    and it took the path straight off the row without ever checking it
    against that row's `org_id`. Filing a row in your own workspace with
    `storage_path` pointing at another workspace's folder therefore
    yielded a signed URL to their raw file, and the permanent-delete path
    destroyed it. Both org id and document id travel in URLs, so the
    values needed are not secret.

    The tenant is a REQUIRED keyword on every storage method precisely so
    a new call site cannot forget it: there is no default to inherit.
    """
    if bucket not in TENANT_SCOPED_BUCKETS:
        return
    first = (path or "").split("/", 1)[0].strip()
    owner = str(org_id or "").strip()
    if owner and first and first == owner:
        return
    # A security event, not a debug line: this is either a bug that would
    # have crossed a tenant boundary, or someone probing for one.
    logger.error(
        "[security] REFUSED cross-tenant storage %s: bucket=%s path=%r "
        "first_segment=%r declared_org=%r",
        op, bucket, path, first, owner,
    )
    raise CrossTenantStoragePath(
        "refused to %s %s/%s: the object's first path segment (%r) is not "
        "the declared owning organization (%r)" % (op, bucket, path, first, owner)
    )


#: Ruling R5 (owner, 2026-09-28; ops log 2026-09-28, two incidents): a READ
#: that times out is logged at WARNING and retried exactly ONCE. Reads only —
#: `select` is the client's one GET. A write (insert / upsert / update /
#: delete / rpc / storage) is never retried: a timed-out write may have
#: landed, and replaying it could apply it twice.
READ_TIMEOUT_RETRIES = 1


def _env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"{name} is not set in environment.")
    return v


@dataclass
class SupabaseConfig:
    url: str
    anon_key: str
    service_key: str


def load_config() -> SupabaseConfig:
    return SupabaseConfig(
        url=_env("VITE_SUPABASE_URL").rstrip("/"),
        anon_key=_env("VITE_SUPABASE_ANON_KEY"),
        service_key=_env("SUPABASE_SERVICE_ROLE_KEY"),
    )


class SupabaseClient:
    """One client per (URL, key). Use admin() / per_user(jwt) factories."""

    def __init__(self, url: str, api_key: str, *, jwt: Optional[str] = None) -> None:
        self.url = url.rstrip("/")
        # `apikey` header is always required; `Authorization` carries the
        # actual identity (service role for admin, user JWT for per-user).
        self._headers = {
            "apikey": api_key,
            "Authorization": f"Bearer {jwt or api_key}",
            "Content-Type": "application/json",
        }
        self._client = httpx.Client(timeout=30.0, headers=self._headers)

    def __enter__(self) -> "SupabaseClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    # ── REST (PostgREST) ──────────────────────────────────────────────────

    def rpc(self, fn: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """Call a Postgres function via PostgREST (`/rest/v1/rpc/<fn>`).

        Used for the SECURITY DEFINER workspace functions, which exist
        precisely because the tables they touch have no client-writable RLS
        policy. Returns the function's decoded JSON result (scalar, object or
        array, depending on the function's return type).
        """
        r = self._client.post(
            f"{self.url}/rest/v1/rpc/{fn}",
            json=params or {},
            headers=self._headers,
        )
        if r.status_code >= 400:
            try:
                detail = r.json()
            except Exception:
                detail = r.text
            raise RuntimeError(f"rpc {fn} failed ({r.status_code}): {detail}")
        if not r.content:
            return None
        return r.json()

    def select(self, table: str, *, filters: Optional[Dict[str, str]] = None,
               columns: str = "*", limit: Optional[int] = None,
               order: Optional[str] = None, single: bool = False) -> List[Dict[str, Any]]:
        params: Dict[str, str] = {"select": columns}
        if filters:
            params.update(filters)
        if limit is not None:
            params["limit"] = str(limit)
        if order is not None:
            params["order"] = order
        headers = dict(self._headers)
        if single:
            headers["Accept"] = "application/vnd.pgrst.object+json"
        r = self._get(f"{self.url}/rest/v1/{table}", table=table, params=params, headers=headers)
        if r.status_code == 406 and single:
            return []
        r.raise_for_status()
        data = r.json()
        return [data] if single and isinstance(data, dict) else data

    def _get(self, url: str, *, table: str, params: Dict[str, str],
             headers: Dict[str, str]) -> httpx.Response:
        """A PostgREST read, retried ONCE on a read timeout (ruling R5).

        Two transient `httpx.ReadTimeout`s hit production on 2026-09-28 (the
        same selects answer in 0.07-0.4 s between them): a stalled read is
        logged at WARNING — the table and the query's parameter NAMES, never
        their values or the headers (the service key rides in them) — and
        sent again once. A second timeout raises, as before. Only a read
        timeout is retried: a connect error, an HTTP error status or any
        other exception propagates on the first attempt."""
        attempt = 0
        while True:
            try:
                return self._client.get(url, params=params, headers=headers)
            except httpx.ReadTimeout:
                if attempt >= READ_TIMEOUT_RETRIES:
                    raise
                attempt += 1
                logger.warning(
                    "[supabase] read timeout on GET %s (params: %s) — retrying once "
                    "(attempt %d of %d)",
                    table, ",".join(sorted(params)), attempt + 1, READ_TIMEOUT_RETRIES + 1,
                )

    def insert(self, table: str, rows: List[Dict[str, Any]] | Dict[str, Any], *,
               returning: bool = True) -> List[Dict[str, Any]]:
        headers = dict(self._headers)
        if returning:
            headers["Prefer"] = "return=representation"
        body = rows if isinstance(rows, list) else [rows]
        r = self._client.post(f"{self.url}/rest/v1/{table}", json=body, headers=headers)
        if r.status_code >= 400:
            # PostgREST returns the actual SQL error in the body — surface
            # it so we can see why the row was rejected (CHECK constraint
            # violation, unknown column, etc.).
            try:
                detail = r.json()
            except Exception:
                detail = {"raw": r.text[:500]}
            # First row payload (for debugging which column/value tripped it)
            sample = body[0] if body else None
            raise RuntimeError(
                f"Supabase insert into {table} failed (HTTP {r.status_code}): {detail} "
                f"| sample row: {sample}"
            )
        return r.json() if returning else []

    def upsert(self, table: str, rows: List[Dict[str, Any]] | Dict[str, Any], *,
               on_conflict: str, returning: bool = False) -> List[Dict[str, Any]]:
        headers = dict(self._headers)
        prefer = ["resolution=merge-duplicates"]
        if returning:
            prefer.append("return=representation")
        headers["Prefer"] = ",".join(prefer)
        body = rows if isinstance(rows, list) else [rows]
        r = self._client.post(
            f"{self.url}/rest/v1/{table}",
            json=body,
            headers=headers,
            params={"on_conflict": on_conflict},
        )
        r.raise_for_status()
        return r.json() if returning else []

    def update(self, table: str, patch: Dict[str, Any], *, filters: Dict[str, str]) -> None:
        params = {**filters}
        r = self._client.patch(f"{self.url}/rest/v1/{table}", params=params, json=patch)
        r.raise_for_status()

    def update_returning(self, table: str, patch: Dict[str, Any], *,
                         filters: Dict[str, str]) -> List[Dict[str, Any]]:
        """PATCH that answers with the rows it CHANGED (`Prefer:
        return=representation`) — the compare-and-swap primitive.

        `update` answers 204 whether it touched one row or none, so a
        caller cannot tell "I moved this row from queued" from "someone
        else already had". Here the filter is the condition and the answer
        is the proof: Postgres re-checks the WHERE under the row lock, so
        of two callers racing on `status=eq.queued` exactly one gets the
        row back and the other gets []. The mail drains CLAIM a queued row
        this way before the provider is called (gate scheduled-mail-tenancy).
        """
        headers = dict(self._headers)
        headers["Prefer"] = "return=representation"
        r = self._client.patch(f"{self.url}/rest/v1/{table}", params={**filters},
                               json=patch, headers=headers)
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else [data]

    def delete(self, table: str, *, filters: Dict[str, str]) -> None:
        params = {**filters}
        r = self._client.delete(f"{self.url}/rest/v1/{table}", params=params)
        r.raise_for_status()

    # ── Auth (a VERIFIED identity from a JWT) ─────────────────────────────
    #
    # We do NOT call /auth/v1/user (the legacy anon-JWT `apikey` no longer
    # authenticates against the auth gateway after Supabase's key
    # rotation). Until 2026-09-05 this decoded the payload LOCALLY WITHOUT
    # VERIFYING THE SIGNATURE, on the theory that PostgREST verifies it on
    # the next per-user read. Four routes never made that read (clear-mine,
    # GET/PUT dashboard config, the firm e-mail drain) and wrote as the
    # decoded `sub` through the service role — a forged, unsigned token
    # carrying a victim's id soft-deleted the victim's documents (critic
    # D5, crit_pipeline_widening.py).
    #
    # The identity now comes from `_jwt.verified_identity`: ES256 against
    # the JWKS Supabase publishes (HS256 only with SUPABASE_JWT_SECRET set),
    # exp / iss / aud / sub checked. This method RAISES — 401 InvalidToken,
    # 503 IdentityUnavailable when no signing key can be obtained — instead
    # of returning {}: no caller reading `user["id"]` ever sees an
    # unverified id, and there is no decode fallback. Every double that
    # stands in for this client must verify the same way
    # (tests/engine/firm_postgrest_double.verified_identity).

    def get_user(self, jwt: str) -> Dict[str, Any]:
        from . import _jwt
        return _jwt.verified_identity(jwt)

    # ── Storage (signed URL minting) ──────────────────────────────────────

    def signed_url(self, bucket: str, path: str, *, org_id: str,
                   expires_in: int = 300) -> str:
        assert_tenant_path(bucket, path, org_id, op="sign")
        r = self._client.post(
            f"{self.url}/storage/v1/object/sign/{bucket}/{path}",
            json={"expiresIn": expires_in},
        )
        r.raise_for_status()
        signed = r.json().get("signedURL")
        if not signed:
            raise RuntimeError(f"Storage sign returned no signedURL for {bucket}/{path}")
        # Returned as a relative path like "/object/sign/..."; absolutize.
        if signed.startswith("/"):
            signed = f"{self.url}/storage/v1{signed}"
        return signed

    # ── Storage upload ────────────────────────────────────────────────────
    # Server-side object write, used by the firm file-request flow: the
    # uploader there is an external contact with no membership in the
    # client workspace, so the browser cannot write the bucket under RLS
    # the way lib/supabase.ts's uploadDocument does. Same bucket, same
    # `{org_id}/uploads/{document_id}.{ext}` path convention, never
    # upsert — a request token is single-use, so a second write to the
    # same path is a bug, not a retry.
    def upload_object(self, bucket: str, path: str, content: bytes, *,
                      org_id: str,
                      content_type: str = "application/octet-stream") -> None:
        assert_tenant_path(bucket, path, org_id, op="upload")
        headers = dict(self._headers)
        headers["Content-Type"] = content_type or "application/octet-stream"
        headers["x-upsert"] = "false"
        r = self._client.post(
            f"{self.url}/storage/v1/object/{bucket}/{path}",
            content=content,
            headers=headers,
        )
        if r.status_code >= 400:
            try:
                detail = r.json()
            except Exception:
                detail = r.text[:300]
            raise RuntimeError(
                f"Storage upload to {bucket}/{path} failed (HTTP {r.status_code}): {detail}"
            )

    # ── Storage delete ────────────────────────────────────────────────────
    # Hard-delete an object from a bucket. Used by the permanent-delete
    # endpoint after a document has been soft-deleted — removes the
    # underlying blob from storage so the user's quota is reclaimed and
    # the file is genuinely gone (not just hidden behind `deleted_at`).
    def delete_object(self, bucket: str, path: str, *, org_id: str) -> None:
        assert_tenant_path(bucket, path, org_id, op="delete")
        r = self._client.delete(f"{self.url}/storage/v1/object/{bucket}/{path}")
        # Some Supabase deployments return 200 with `{message: "Successfully deleted"}`,
        # others 204; 404 is also acceptable (object already gone).
        if r.status_code not in (200, 204, 404):
            r.raise_for_status()


# `_decode_jwt_claims` (the unverified payload decode) was REMOVED
# 2026-09-05 (FC1x, critic D5). Its one honest use — a log line about a
# REFUSED bearer — lives in `_jwt.unverified_claims_for_logging`, named for
# what it is; the census in tests/engine/test_identity_wall.py reds on any
# other caller under src/engine/api. Authorization never reads an
# unverified claim again.


def admin() -> SupabaseClient:
    """Service-role client. Bypasses RLS — use with care, only server-side."""
    cfg = load_config()
    return SupabaseClient(cfg.url, cfg.service_key)


def per_user(jwt: str) -> SupabaseClient:
    """Per-request client honoring the calling user's RLS scope."""
    cfg = load_config()
    return SupabaseClient(cfg.url, cfg.anon_key, jwt=jwt)
