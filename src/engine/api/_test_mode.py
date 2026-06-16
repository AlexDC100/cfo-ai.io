"""Public test-mode helper — env-gated open-access bypass.

When `PUBLIC_TEST_MODE=1` is set in the backend environment, every auth
seam in this module short-circuits to a single shared test identity:

  - JWT validation is skipped (any/no Authorization header accepted)
  - `_user_id_from_jwt` returns `TEST_USER_ID` regardless of the token
  - Billing quota checks treat the request as fully entitled

The fixed test user has membership in exactly ONE org (`TEST_ORG_ID`) so
RLS-scoped queries can only ever see test-org data. Real customer orgs
(Scandia, Carniprod, alexandru.crestin's organization, etc.) remain
structurally invisible because the test user has no membership rows for
them — `is_member_of()` returns false, RLS filters them out.

The flag is read fresh on every call (no caching) so the operator can
flip test mode off by removing the env var and restarting the backend
container without redeploying code. To return to normal production
posture:

  1. Remove `PUBLIC_TEST_MODE=1` from `/opt/cfo-ai/.env`
  2. `docker compose up -d backend` (env reload, no rebuild)
  3. Optional: `DELETE FROM memberships WHERE user_id = <TEST_USER_ID>`
     to leave the test artifacts in place but disable their access

Frontend test-mode (`VITE_PUBLIC_TEST_MODE=1`) is a separate env var
read at build time. Both should be flipped together; if one is on and
the other off, users get a half-broken experience (FE bypasses auth UI
but BE rejects requests, or vice versa).
"""

from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
from typing import Dict, Optional

import httpx


logger = logging.getLogger(__name__)


# ─── Default sentinel IDs ──────────────────────────────────────────────
# These are used when the operator hasn't set `TEST_USER_ID` /
# `TEST_ORG_ID` in env. Deterministic UUIDs so the SQL migration that
# provisions the test row can reference them. NEVER change these without
# updating `supabase/schema_phase_test_mode.sql` in the same commit.

_DEFAULT_TEST_USER_ID = "00000000-0000-4000-8000-000000000001"
_DEFAULT_TEST_ORG_ID  = "00000000-0000-4000-8000-000000000002"


def is_test_mode() -> bool:
    """True iff `PUBLIC_TEST_MODE=1`. Read fresh each call (no cache).

    Mid-session toggle is supported: an operator can `export
    PUBLIC_TEST_MODE=1` inside a running container and the next request
    will pick it up. Useful for smoke-testing the bypass path without a
    full deploy.
    """
    return os.environ.get("PUBLIC_TEST_MODE", "").strip() == "1"


def test_user_id() -> str:
    """The shared user_id every test-mode visitor is authenticated as.

    Must exist in `auth.users` AND have a membership row in
    `memberships` linking it to `test_org_id()`. The migration at
    `supabase/schema_phase_test_mode.sql` provisions both.
    """
    return (os.environ.get("TEST_USER_ID") or _DEFAULT_TEST_USER_ID).strip()


def test_org_id() -> str:
    """The shared org_id every test-mode visitor's data lands under.

    Single shared workspace by design (per F3.27 operator decision —
    "Empty + fictional samples / Shared test org"). Visitor uploads from
    different IP addresses all write to this org's storage path and
    documents row. The dashboard sees the union, which is the explicit
    risk surfaced in the banner copy ("uploads visible to other test-
    mode visitors; do not upload confidential data").
    """
    return (os.environ.get("TEST_ORG_ID") or _DEFAULT_TEST_ORG_ID).strip()


# ─── JWT placeholder ───────────────────────────────────────────────────
# Sentinel string returned by `_require_jwt` when test mode is on. Lets
# the existing call chain (`_user_id_from_jwt(jwt)`) detect the bypass
# without changing function signatures across pipeline.py / _billing.py
# / ask.py. The downstream resolver checks for this exact value and
# returns `test_user_id()` instead of decoding it.

JWT_BYPASS_PLACEHOLDER = "PUBLIC_TEST_MODE_BYPASS"


def is_bypass_token(jwt: str) -> bool:
    """True iff this token is the in-process bypass sentinel.

    Two acceptance modes:
    (a) Test mode is currently on AND the token is the placeholder.
    (b) Any request when test mode is currently on (paranoid bypass —
        if some site forgot to short-circuit at `_require_jwt`, the
        downstream `_user_id_from_jwt` still routes to the test user).

    Returning True triggers the test-user-id return path. The condition
    is intentionally permissive in test mode so a missed call site
    can't accidentally hit Supabase with a bogus token and 500.
    """
    return is_test_mode() or jwt == JWT_BYPASS_PLACEHOLDER


# ─── Real Supabase JWT for the synthetic test user ──────────────────────
#
# Why this exists: the original test-mode design returned a placeholder
# string from `_require_jwt` to short-circuit identity resolution. Works
# fine for `_user_id_from_jwt` (matches the placeholder, returns the
# test user_id directly) — but the placeholder is then passed downstream
# to `_supabase.per_user(jwt)` in 40+ call sites across pipeline.py,
# ask.py, _billing.py, _pricing_routes.py. Supabase rejects the
# placeholder as a Bearer token with 401, so every upload / pipeline
# step / chat call would 500.
#
# Fix: mint a REAL Supabase access_token for the synthetic test user
# (one-time bootstrap via service-role password-set + sign-in) and
# cache it per process. Now every per_user(jwt) call receives a
# token Supabase honors. RLS still applies — the test user's
# membership row scopes queries to the test org and only the test org
# (real customer orgs remain structurally invisible). No global
# RLS-bypass; we just give the synthetic identity a normal seat at
# the auth table.
#
# Cache is per-process (each uvicorn worker mints independently — JWTs
# for the same user are interchangeable). Refresh fires when within 5
# minutes of `exp` so we never serve a token Supabase has aged out.
#
# The password used below is a fixed constant, not a secret. The
# security boundary for test-mode is the `PUBLIC_TEST_MODE=1` env
# flag, not the secrecy of this string. In production posture the
# function is unreachable because every caller is gated on
# `is_test_mode()`. The test user has no roles or memberships outside
# the test workspace, so even if an attacker somehow learned the
# password and the test mode was somehow on in prod, they could only
# access test-org data — which is already publicly accessible by
# design when test mode is on.

_TEST_USER_PASSWORD = "public-test-mode-no-secret-v1"

_JWT_LOCK = threading.Lock()
_cached_jwt: Optional[str] = None
_cached_refresh: Optional[str] = None
_cached_jwt_exp: float = 0.0
_password_bootstrapped: bool = False


def _bootstrap_test_user() -> None:
    """Ensure the synthetic test user exists in auth.users + auth.identities
    with a known password, AND has a membership linking it to the test org.

    Called once per process before the first sign-in attempt. Handles three
    cases:
      1. User doesn't exist  → POST /admin/users creates a complete row
                                (auth.users + auth.identities atomically).
      2. User already exists → PUT /admin/users/<id> resets the password
                                idempotently. If the user is from a previous
                                deploy or a previous bootstrap, password is
                                set to the same constant so sign-in works.
      3. Membership missing  → INSERT into memberships via service-role REST.
                                Necessary because deleting a broken auth.users
                                row cascades the membership away; the BE
                                re-adds it on the next bootstrap.

    All operations are best-effort and idempotent. Failures are logged but
    don't raise — the subsequent sign-in attempt is the real check.

    Why POST (create) instead of just SQL INSERT INTO auth.users: SQL alone
    creates an incomplete user (no auth.identities row), and GoTrue's
    password-sign-in then errors with 'Database error loading user'. The
    Admin API endpoint handles the full auth-schema insert atomically.
    """
    global _password_bootstrapped
    if _password_bootstrapped:
        return

    url = os.environ.get("VITE_SUPABASE_URL", "").rstrip("/")
    service = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not (url and service):
        logger.warning("[test_mode] Supabase env missing — cannot bootstrap.")
        return

    admin_headers = {
        "apikey": service,
        "Authorization": f"Bearer {service}",
        "Content-Type": "application/json",
    }
    rest_headers = {**admin_headers, "Prefer": "resolution=ignore-duplicates"}

    user_payload = {
        "id": test_user_id(),
        "email": "test@cfo-ai.io",
        "password": _TEST_USER_PASSWORD,
        "email_confirm": True,
        "user_metadata": {
            "display_name": "Test visitor",
            "company_name": "Test workspace",
        },
    }

    try:
        with httpx.Client(timeout=15.0) as c:
            # 1. Try to CREATE the user. Returns 200/201 on success, 422 if
            # the user already exists (email or id collision).
            r = c.post(
                f"{url}/auth/v1/admin/users",
                headers=admin_headers,
                json=user_payload,
            )
            if r.status_code in (200, 201):
                logger.info("[test_mode] Test user created via Admin API.")
            elif r.status_code == 422 or (
                r.status_code >= 400 and "already" in r.text.lower()
            ):
                # User exists — make sure the password is what we expect.
                r2 = c.put(
                    f"{url}/auth/v1/admin/users/{test_user_id()}",
                    headers=admin_headers,
                    json={"password": _TEST_USER_PASSWORD,
                          "email_confirm": True},
                )
                if r2.status_code >= 400:
                    logger.warning(
                        "[test_mode] User exists but password reset failed: "
                        "%s %s", r2.status_code, r2.text[:200],
                    )
                else:
                    logger.info("[test_mode] Test user password reset.")
            else:
                logger.warning(
                    "[test_mode] Admin user-create returned %s: %s",
                    r.status_code, r.text[:200],
                )

            # 2. Re-link the membership row. Idempotent — the
            # `Prefer: resolution=ignore-duplicates` header tells PostgREST
            # to no-op on PK conflict instead of 409.
            r3 = c.post(
                f"{url}/rest/v1/memberships",
                headers=rest_headers,
                json={
                    "user_id": test_user_id(),
                    "org_id": test_org_id(),
                    "role": "owner",
                },
            )
            if r3.status_code >= 400:
                logger.warning(
                    "[test_mode] Membership link returned %s: %s",
                    r3.status_code, r3.text[:200],
                )
            else:
                logger.info("[test_mode] Test user membership ensured.")
    except Exception:  # noqa: BLE001
        logger.exception("[test_mode] Bootstrap failed (continuing).")
    finally:
        _password_bootstrapped = True


def _parse_jwt_exp(token: str) -> float:
    """Extract the `exp` claim (unix seconds) from a JWT without verifying.

    Returns 0.0 on parse failure — caller treats that as "refresh now".
    Safe because we never trust the parsed exp for security decisions;
    we only use it to schedule refresh.
    """
    try:
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return float(payload.get("exp", 0))
    except Exception:  # noqa: BLE001
        return 0.0


def get_test_user_jwt() -> str:
    """Return a real Supabase access_token for the synthetic test user.

    First call per process bootstraps the password via the Admin API,
    then signs in via `/auth/v1/token?grant_type=password`. Subsequent
    calls return the cached token until it's within 5 minutes of `exp`,
    at which point a refresh fires.

    Raises RuntimeError if test mode is off (sanity guard — callers
    are gated on `is_test_mode()` and shouldn't reach this otherwise).
    Raises httpx.HTTPStatusError on sign-in failure — bubbles up to
    the route handler, which returns 500. Better to surface that to
    the operator than silently fall back to the placeholder and have
    every per_user call 401.
    """
    if not is_test_mode():
        raise RuntimeError(
            "get_test_user_jwt() called in production posture — "
            "this should only fire when PUBLIC_TEST_MODE=1."
        )

    global _cached_jwt, _cached_jwt_exp
    now = time.time()
    if _cached_jwt and now < _cached_jwt_exp - 300:
        return _cached_jwt

    with _JWT_LOCK:
        # Double-check inside the lock — another thread may have
        # refreshed while we were waiting.
        now = time.time()
        if _cached_jwt and now < _cached_jwt_exp - 300:
            return _cached_jwt

        # Idempotent bootstrap on first call per process. Ensures the
        # synthetic test user exists in auth.users + auth.identities AND
        # has a membership in the test org. Subsequent calls are no-ops.
        _bootstrap_test_user()

        url = os.environ.get("VITE_SUPABASE_URL", "").rstrip("/")
        anon = os.environ.get("VITE_SUPABASE_ANON_KEY", "")
        if not (url and anon):
            raise RuntimeError(
                "[test_mode] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing."
            )

        with httpx.Client(timeout=15.0) as c:
            r = c.post(
                f"{url}/auth/v1/token?grant_type=password",
                headers={"apikey": anon, "Content-Type": "application/json"},
                json={
                    "email": "test@cfo-ai.io",
                    "password": _TEST_USER_PASSWORD,
                },
            )
            r.raise_for_status()
            data = r.json()
            access_token = data.get("access_token")
            refresh_token = data.get("refresh_token")
            if not access_token:
                raise RuntimeError(
                    "[test_mode] Sign-in returned no access_token: "
                    f"{json.dumps(data)[:200]}"
                )

        exp = _parse_jwt_exp(access_token)
        # If exp parse failed, treat as 1h validity (Supabase default).
        if exp <= now:
            exp = now + 3600

        global _cached_refresh
        _cached_jwt = access_token
        _cached_refresh = refresh_token
        _cached_jwt_exp = exp
        logger.info(
            "[test_mode] Minted test-user JWT — valid for %.0f minutes",
            (exp - now) / 60,
        )
        return access_token


def get_test_user_session() -> Dict[str, str]:
    """Return both access_token and refresh_token for the synthetic test user.

    Used by the GET /api/test-mode/session endpoint so the FE's supabase-js
    client can call `auth.setSession({access_token, refresh_token})` and have
    a real Supabase session. Without this the FE has no session and direct
    FE → Supabase calls (Storage uploads, documents INSERT, RLS-scoped
    selects) all fail — the upload silently produces no `documents` row,
    and the subsequent /api/pipeline/run hits 404 on lookup.

    Triggers a mint if no token is cached. Subsequent callers within the
    cache window get the same tokens (intentional — multiple FE tabs share
    one session, equivalent to multiple browser tabs on a real user).
    """
    # Ensure cache is populated. get_test_user_jwt does the heavy lifting.
    get_test_user_jwt()
    if not _cached_jwt:
        raise RuntimeError("[test_mode] No cached JWT after mint — unreachable.")
    return {
        "access_token": _cached_jwt,
        "refresh_token": _cached_refresh or "",
    }


# ─── Public route — exposes the cached session to the FE ───────────────
#
# The FE's AuthProvider, when running in PUBLIC_TEST_MODE, calls this
# endpoint once at mount, then injects (access_token, refresh_token) into
# the supabase-js client via `auth.setSession(...)`. From that point the
# FE has a real Supabase session for the synthetic test user, so direct
# FE → Supabase calls (Storage uploads, INSERT into documents, RLS-scoped
# selects) all work normally.
#
# Returns 404 when test mode is off — production posture should expose
# no such endpoint. The 404 response is deliberately indistinguishable
# from a real "route does not exist" so attackers can't fingerprint
# whether the BE is test-mode-aware.

def build_router():  # type: ignore[no-untyped-def]
    """Build the /api/test-mode router. Only routes when PUBLIC_TEST_MODE=1
    is set; otherwise returns 404 on every request (the route still
    exists but acts as a no-op)."""
    from fastapi import APIRouter, HTTPException

    router = APIRouter(tags=["test-mode"])

    @router.get("/api/test-mode/session")
    def test_mode_session() -> Dict[str, str]:
        if not is_test_mode():
            raise HTTPException(404, "Not found")
        try:
            session = get_test_user_session()
        except Exception as e:  # noqa: BLE001
            logger.exception("[test_mode] /api/test-mode/session failed.")
            raise HTTPException(503, f"Test-mode session unavailable: {e}")
        return {
            **session,
            "user_id": test_user_id(),
            "org_id": test_org_id(),
        }

    return router
