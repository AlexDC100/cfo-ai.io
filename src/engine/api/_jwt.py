"""THE IDENTITY VERIFIER — a bearer is an identity only after its signature
verifies. Nothing in this package may derive ``auth.uid()`` any other way.

THE DEFECT (critic D5, 2026-09-05). Until today every route derived the
caller's user id from a LOCAL, UNVERIFIED base64 decode of the JWT payload
(``_supabase._decode_jwt_claims``), on the theory that PostgREST verifies
the signature on the next per-user read. Four routes never made that read
and wrote as the decoded ``sub`` through the service role:
``POST /api/documents/clear-mine``, ``GET``/``PUT /api/dashboard/config``,
``POST /api/firm/email/drain``. A forged, unsigned token carrying a
victim's ``sub`` soft-deleted the victim's documents — prod-identical, no
key involved (``crit_pipeline_widening.py``). Every ``/api/firm`` route
passed the Python wall on the same forged bearer; only PostgREST's check on
the per-user read stood — one wall, not two.

WHAT THIS MODULE DOES.

  * ES256 (ECDSA P-256 / SHA-256) against the keys Supabase publishes at
    ``{VITE_SUPABASE_URL}/auth/v1/.well-known/jwks.json``. Measured in
    production 2026-09-05 04:40 EEST: exactly one key — kty EC, crv P-256,
    alg ES256 — and no ``SUPABASE_JWT_SECRET`` in the container (no HS256
    path exists there). Verified with ``cryptography`` ONLY: the image has
    no pyjwt / jose / authlib and the requirements lock is hash-pinned, so a
    new dependency is its own deploy risk. JWS signatures are raw
    ``r || s`` (32 + 32 bytes); ``cryptography`` wants DER, so they are
    converted with ``encode_dss_signature``.
  * HS256 ONLY when ``SUPABASE_JWT_SECRET`` is set (a self-hosted GoTrue).
    Never ``none``. Never HS256 against the public key bytes — the classic
    alg-confusion — because HS256 is refused outright when no secret is
    configured, and a configured secret is never a public key.
  * Keys are cached in-process with a TTL and kept STALE-WHILE-ERROR: a
    failed refetch keeps the last good key set (and backs off before the
    next attempt). An unknown ``kid`` triggers ONE forced refetch (rate
    limited, so a flood of forged ``kid``s cannot turn this process into a
    JWKS crawler) and is then refused.
  * FAIL CLOSED. With no key obtainable and an empty cache the identity is
    UNAVAILABLE — 503 naming this verifier — NEVER a decode fallback.

REFUSED, each as 401 ``InvalidToken``: alg other than ES256 (or HS256 when
enabled); bad signature; ``exp`` passed (60 s leeway); ``nbf`` in the
future; ``iss`` != ``{URL}/auth/v1``; ``aud`` not carrying
``authenticated``; missing / empty ``sub``; unknown ``kid``; malformed.

Both exceptions subclass ``fastapi.HTTPException`` so every handler that
calls ``get_user`` / ``resolve_user_id`` answers 401 / 503 by construction
— there is no call site that could turn a refusal into a 500 or, worse,
into ``{}`` read as "no id, carry on".

``unverified_claims_for_logging`` is the old decode under its honest name.
It is for log lines about a REFUSED bearer (which ``sub`` was claimed) and
for nothing else; ``tests/engine/test_identity_wall.py`` reds on any other
caller under ``src/engine/api``.

Test seam: ``_fetch_jwks`` and ``expected_issuer`` are module attributes;
``tests/engine/firm_postgrest_double.install_test_jwks`` points them at a
per-process P-256 test key so no test ever fetches, and ``reset_cache``
clears the key cache between tests.

Operator note: this process now makes ONE outbound HTTPS GET to the
project's own ``/auth/v1/.well-known/jwks.json`` on the first bearer it
sees (and every ``JWKS_TTL_S`` after). Same host as every PostgREST call,
so no new egress allowance is needed anywhere the backend already reaches
Supabase.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import threading
import time
from typing import Any, Dict, Optional

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from fastapi import HTTPException

logger = logging.getLogger(__name__)

#: Named in every 503 so an operator reading a log knows WHICH wall is down.
VERIFIER = "engine.api._jwt"
JWKS_PATH = "/auth/v1/.well-known/jwks.json"
#: How long a fetched key set is trusted before a refresh is attempted.
JWKS_TTL_S = 600.0
#: After a failed refetch, serve the stale set for this long before trying
#: the endpoint again (an unknown ``kid`` has its own, separate cooldown).
JWKS_RETRY_AFTER_ERROR_S = 30.0
#: At most one forced refetch per this window for tokens naming a ``kid``
#: the cache does not hold.
UNKNOWN_KID_REFETCH_COOLDOWN_S = 30.0
#: Clock skew tolerated on ``exp`` / ``nbf``.
EXP_LEEWAY_S = 60
EXPECTED_AUD = "authenticated"
FETCH_TIMEOUT_S = 5.0
_SIG_LEN_P256 = 64


class InvalidToken(HTTPException):
    """401 — the bearer is not a verified identity. ``reason`` names why."""

    def __init__(self, reason: str) -> None:
        HTTPException.__init__(self, 401, "Invalid bearer token: %s." % reason)
        self.reason = reason


class IdentityUnavailable(HTTPException):
    """503 — no signing key can be obtained, so no identity can be
    verified. The response names the verifier; there is no fallback."""

    def __init__(self, reason: str) -> None:
        HTTPException.__init__(
            self, 503, "Identity verifier (%s) unavailable: %s." % (VERIFIER, reason))
        self.reason = reason


# ── Configuration ────────────────────────────────────────────────────────


def supabase_url() -> str:
    url = (os.environ.get("VITE_SUPABASE_URL") or "").strip().rstrip("/")
    if not url:
        raise IdentityUnavailable(
            "VITE_SUPABASE_URL is not set, so neither the JWKS URL nor the expected "
            "issuer is known")
    return url


def jwks_url() -> str:
    return supabase_url() + JWKS_PATH


def expected_issuer() -> str:
    """Supabase signs ``iss`` as ``{project url}/auth/v1``."""
    return supabase_url() + "/auth/v1"


# ── Encoding helpers ─────────────────────────────────────────────────────


def _b64url_decode(segment: str) -> bytes:
    padded = segment + "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def unverified_claims_for_logging(token: str) -> Dict[str, Any]:
    """The payload as CLAIMED by the bearer, signature NOT checked.

    For log lines about a refused token ("which ``sub`` did it claim?")
    and nothing else. Authorization never reads this: the census in
    ``tests/engine/test_identity_wall.py`` reds on any caller under
    ``src/engine/api`` other than this module. Never raises — a log line
    must not turn a refusal into a 500."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return {}
        claims = json.loads(_b64url_decode(parts[1]).decode("utf-8"))
        return claims if isinstance(claims, dict) else {}
    except Exception:  # noqa: BLE001 — logging only
        return {}


# ── The key cache ────────────────────────────────────────────────────────


def _fetch_jwks(url: str) -> Dict[str, Any]:
    """One HTTP GET of the JWKS. The test double replaces this attribute;
    no test fetches."""
    with httpx.Client(timeout=FETCH_TIMEOUT_S) as client:
        response = client.get(url)
    response.raise_for_status()
    body = response.json()
    if not isinstance(body, dict):
        raise ValueError("JWKS body is not a JSON object")
    return body


def _public_key_from_jwk(jwk: Dict[str, Any]) -> Any:
    x = int.from_bytes(_b64url_decode(str(jwk["x"])), "big")
    y = int.from_bytes(_b64url_decode(str(jwk["y"])), "big")
    return ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()


def _parse_jwks(body: Dict[str, Any]) -> Dict[str, Any]:
    """``kid -> EC public key`` for every usable P-256 signing key. Keys
    of another type or curve are skipped and named in the log — they
    cannot verify an ES256 token, so silently keeping them would only
    turn "unknown kid" into a wrong-curve exception later."""
    keys = {}  # type: Dict[str, Any]
    for jwk in body.get("keys") or []:
        if not isinstance(jwk, dict):
            continue
        kid = jwk.get("kid")
        alg = jwk.get("alg")
        if (jwk.get("kty") != "EC" or jwk.get("crv") != "P-256"
                or (alg is not None and alg != "ES256") or not isinstance(kid, str) or not kid):
            logger.warning("[%s] skipping JWKS entry kid=%r kty=%r crv=%r alg=%r (not a P-256/ES256 key)",
                           VERIFIER, kid, jwk.get("kty"), jwk.get("crv"), alg)
            continue
        try:
            keys[kid] = _public_key_from_jwk(jwk)
        except Exception as exc:  # noqa: BLE001 — one bad entry must not drop the set
            logger.warning("[%s] JWKS entry kid=%r unusable: %s: %s", VERIFIER, kid,
                           type(exc).__name__, exc)
    return keys


class _KeyCache(object):
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.keys = {}  # type: Dict[str, Any]
        self.fetched_at = 0.0
        self.failed_at = 0.0
        self.unknown_kid_refetch_at = 0.0
        #: Every fetch ATTEMPT, for the gate that counts them.
        self.fetches = 0

    def reset(self) -> None:
        with self.lock:
            self.keys = {}
            self.fetched_at = 0.0
            self.failed_at = 0.0
            self.unknown_kid_refetch_at = 0.0
            self.fetches = 0


_CACHE = _KeyCache()


def reset_cache() -> None:
    """Forget every cached key (tests; a manual key rotation drill)."""
    _CACHE.reset()


def cache_stats() -> Dict[str, Any]:
    with _CACHE.lock:
        return {"kids": sorted(_CACHE.keys), "fetched_at": _CACHE.fetched_at,
                "failed_at": _CACHE.failed_at, "fetches": _CACHE.fetches}


def _load_keys(force: bool = False, now: Optional[float] = None) -> Dict[str, Any]:
    """The current key set. Fresh from the cache when inside the TTL;
    otherwise refetched — and on a failed refetch the LAST GOOD set is
    kept (stale-while-error) with a back-off before the next attempt.
    With nothing cached and nothing fetchable: ``IdentityUnavailable``."""
    now = time.time() if now is None else now
    with _CACHE.lock:
        if _CACHE.keys and not force:
            if (now - _CACHE.fetched_at) < JWKS_TTL_S:
                return dict(_CACHE.keys)
            if _CACHE.failed_at and (now - _CACHE.failed_at) < JWKS_RETRY_AFTER_ERROR_S:
                return dict(_CACHE.keys)
        url = jwks_url()
        _CACHE.fetches += 1
        try:
            keys = _parse_jwks(_fetch_jwks(url))
            if not keys:
                raise ValueError("no usable P-256 signing key in the JWKS")
        except Exception as exc:  # noqa: BLE001 — every failure shape is "no fresh keys"
            _CACHE.failed_at = now
            if _CACHE.keys:
                logger.warning(
                    "[%s] JWKS refetch from %s failed (%s: %s); keeping the last good key set "
                    "(%d key(s), fetched %.0fs ago)", VERIFIER, url, type(exc).__name__, exc,
                    len(_CACHE.keys), now - _CACHE.fetched_at)
                return dict(_CACHE.keys)
            raise IdentityUnavailable(
                "JWKS at %s could not be fetched (%s: %s) and no key is cached"
                % (url, type(exc).__name__, exc))
        _CACHE.keys = keys
        _CACHE.fetched_at = now
        _CACHE.failed_at = 0.0
        return dict(keys)


def _key_for(kid: str, now: float) -> Any:
    keys = _load_keys(now=now)
    key = keys.get(kid)
    if key is not None:
        return key
    # Unknown kid: the key may have rotated since the cache was filled.
    # Refetch ONCE per cooldown window, then refuse — a forged token can
    # name any kid it likes and must not make this process crawl the JWKS.
    with _CACHE.lock:
        allowed = (now - _CACHE.unknown_kid_refetch_at) >= UNKNOWN_KID_REFETCH_COOLDOWN_S
        if allowed:
            _CACHE.unknown_kid_refetch_at = now
    if allowed:
        key = _load_keys(force=True, now=now).get(kid)
        if key is not None:
            return key
    raise InvalidToken("unknown key id %r" % (kid,))


# ── Verification ─────────────────────────────────────────────────────────


def _verify_es256(signing_input: bytes, signature: bytes, key: Any) -> None:
    if len(signature) != _SIG_LEN_P256:
        raise InvalidToken("signature")
    r = int.from_bytes(signature[:32], "big")
    s = int.from_bytes(signature[32:], "big")
    try:
        key.verify(encode_dss_signature(r, s), signing_input, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        raise InvalidToken("signature")
    except Exception:  # noqa: BLE001 — r/s out of range and the like: still "no"
        raise InvalidToken("signature")


def _verify_hs256(signing_input: bytes, signature: bytes) -> None:
    secret = os.environ.get("SUPABASE_JWT_SECRET") or ""
    if not secret:
        raise InvalidToken("alg HS256 is not enabled (SUPABASE_JWT_SECRET is not set)")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, signature):
        raise InvalidToken("signature")


def _check_claims(payload: Dict[str, Any], now: float) -> None:
    exp = payload.get("exp")
    if isinstance(exp, bool) or not isinstance(exp, (int, float)):
        raise InvalidToken("no exp")
    if now > float(exp) + EXP_LEEWAY_S:
        raise InvalidToken("expired")
    nbf = payload.get("nbf")
    if isinstance(nbf, (int, float)) and not isinstance(nbf, bool) and (now + EXP_LEEWAY_S) < float(nbf):
        raise InvalidToken("not yet valid")
    if payload.get("iss") != expected_issuer():
        raise InvalidToken("issuer")
    aud = payload.get("aud")
    if not (aud == EXPECTED_AUD or (isinstance(aud, list) and EXPECTED_AUD in aud)):
        raise InvalidToken("audience")
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub.strip():
        raise InvalidToken("no subject")


def verify(token: str, now: Optional[float] = None) -> Dict[str, Any]:
    """The claims of ``token`` — ONLY after its signature verified against
    a key this process obtained from Supabase and its exp / iss / aud /
    sub checked. ``InvalidToken`` (401) otherwise; ``IdentityUnavailable``
    (503) when no key can be obtained at all."""
    now = time.time() if now is None else now
    try:
        return _verify(token, now)
    except InvalidToken as refused:
        claimed = unverified_claims_for_logging(token)
        logger.info("[%s] refused bearer: %s (claimed sub=%r iss=%r)",
                    VERIFIER, refused.reason, claimed.get("sub"), claimed.get("iss"))
        raise


def _verify(token: str, now: float) -> Dict[str, Any]:
    parts = (token or "").split(".")
    if len(parts) != 3 or not all(parts):
        raise InvalidToken("malformed")
    try:
        header = json.loads(_b64url_decode(parts[0]).decode("utf-8"))
        payload = json.loads(_b64url_decode(parts[1]).decode("utf-8"))
        signature = _b64url_decode(parts[2])
        signing_input = (parts[0] + "." + parts[1]).encode("ascii")
    except Exception:  # noqa: BLE001 — any decode failure is "not a JWT"
        raise InvalidToken("malformed")
    if not isinstance(header, dict) or not isinstance(payload, dict):
        raise InvalidToken("malformed")
    alg = header.get("alg")
    if alg == "ES256":
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise InvalidToken("no key id")
        _verify_es256(signing_input, signature, _key_for(kid, now))
    elif alg == "HS256":
        _verify_hs256(signing_input, signature)
    else:
        raise InvalidToken("unsupported alg %r" % (alg,))
    _check_claims(payload, now)
    return payload


def verified_identity(token: str) -> Dict[str, Any]:
    """``{"id", "email", "claims"}`` for a VERIFIED bearer; raises otherwise.
    The shape ``SupabaseClient.get_user`` has always returned — minus the
    empty dict it used to return for a token it could not read."""
    claims = verify(token)
    return {"id": claims["sub"], "email": claims.get("email"), "claims": claims}


__all__ = [
    "EXPECTED_AUD", "EXP_LEEWAY_S", "IdentityUnavailable", "InvalidToken",
    "JWKS_PATH", "JWKS_TTL_S", "UNKNOWN_KID_REFETCH_COOLDOWN_S", "VERIFIER",
    "cache_stats", "expected_issuer", "jwks_url", "reset_cache",
    "unverified_claims_for_logging", "verified_identity", "verify",
]
