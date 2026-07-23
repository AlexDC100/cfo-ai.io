"""Minimal Supabase REST client for the FastAPI backend.

Two clients:
  - service_role: bypasses RLS for pipeline writes (compute, narrate, status).
  - per_user(jwt):  honors RLS; used to validate the caller actually owns the
                    document they're asking us to process.

Surface is intentionally narrow — only the methods the pipeline needs.
PostgREST URL pattern: <SUPABASE_URL>/rest/v1/<table>?select=*&col=eq.value
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx


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
        r = self._client.get(f"{self.url}/rest/v1/{table}", params=params, headers=headers)
        if r.status_code == 406 and single:
            return []
        r.raise_for_status()
        data = r.json()
        return [data] if single and isinstance(data, dict) else data

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

    def delete(self, table: str, *, filters: Dict[str, str]) -> None:
        params = {**filters}
        r = self._client.delete(f"{self.url}/rest/v1/{table}", params=params)
        r.raise_for_status()

    # ── Auth (resolve user identity from a JWT) ──────────────────────────
    #
    # We do NOT call /auth/v1/user — Supabase rotated to ES256-signed
    # tokens + new-format publishable/secret API keys, and the legacy
    # anon-JWT used as `apikey` no longer authenticates against the auth
    # gateway (returns 403). The user id is in the JWT's `sub` claim
    # anyway; we read it locally and rely on Postgres RLS for the actual
    # authorization check on every subsequent query.
    #
    # Local decode is safe because we don't trust the result for security
    # — every downstream SELECT uses the per_user client which sends the
    # raw JWT to PostgREST, where Supabase verifies the signature before
    # applying RLS. We're only using the decoded claims to populate
    # convenience fields (id, email) that the caller wants to log or echo.

    def get_user(self, jwt: str) -> Dict[str, Any]:
        return _decode_jwt_claims(jwt)

    # ── Storage (signed URL minting) ──────────────────────────────────────

    def signed_url(self, bucket: str, path: str, *, expires_in: int = 300) -> str:
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

    # ── Storage delete ────────────────────────────────────────────────────
    # Hard-delete an object from a bucket. Used by the permanent-delete
    # endpoint after a document has been soft-deleted — removes the
    # underlying blob from storage so the user's quota is reclaimed and
    # the file is genuinely gone (not just hidden behind `deleted_at`).
    def delete_object(self, bucket: str, path: str) -> None:
        r = self._client.delete(f"{self.url}/storage/v1/object/{bucket}/{path}")
        # Some Supabase deployments return 200 with `{message: "Successfully deleted"}`,
        # others 204; 404 is also acceptable (object already gone).
        if r.status_code not in (200, 204, 404):
            r.raise_for_status()


def _decode_jwt_claims(jwt: str) -> Dict[str, Any]:
    """Parse a JWT's payload claims without verifying the signature.

    Signature verification happens server-side at Supabase/PostgREST on
    every downstream request — we only need the claims to populate the
    caller's user_id / email locally. Bypasses /auth/v1/user (which has
    apikey/format compatibility issues after Supabase's key rotation).
    """
    import base64
    import json as _json
    try:
        # JWTs are three base64url-encoded segments separated by dots.
        # The middle segment is the payload (claims).
        parts = jwt.split(".")
        if len(parts) != 3:
            return {}
        # base64url needs padding for the standard decoder
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        payload_bytes = base64.urlsafe_b64decode(payload_b64.encode("ascii"))
        claims = _json.loads(payload_bytes.decode("utf-8"))
        # Supabase puts the user id in `sub`. Also surface `email`.
        return {
            "id": claims.get("sub"),
            "email": claims.get("email"),
            "claims": claims,
        }
    except Exception:
        return {}


def admin() -> SupabaseClient:
    """Service-role client. Bypasses RLS — use with care, only server-side."""
    cfg = load_config()
    return SupabaseClient(cfg.url, cfg.service_key)


def per_user(jwt: str) -> SupabaseClient:
    """Per-request client honoring the calling user's RLS scope."""
    cfg = load_config()
    return SupabaseClient(cfg.url, cfg.anon_key, jwt=jwt)
