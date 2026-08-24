"""Encryption-at-rest SEAM for snapshots + ai_audit (E1) — passthrough default.

WHAT THIS IS
    The single place at-rest encryption will live when it is turned on:
    a key-derivation module (RFC 5869 HKDF-SHA256, stdlib-only) plus a
    provider seam (``wrap_at_rest`` / ``unwrap_at_rest``) that the
    snapshot object store (engine.journal.store) and any ai_audit
    persist path adopt as their byte boundary.

WHAT THIS IS NOT — ENCRYPTION IS **NOT ENABLED** BY THIS MODULE
    The active provider is :class:`PassthroughProvider` — identity on
    write, identity on read — and :func:`provider_from_env` returns it
    UNCONDITIONALLY, even when ``ENGINE_ENCRYPTION_KEY`` is set in the
    environment.  That is deliberate (single-tenant deployment, operator
    spec: seam + tests only this wave) and is LOCKED by
    tests/engine/test_encryption_seam.py::test_do_not_flip_*.

WHY PASSTHROUGH AND NOT A STDLIB CIPHER
    The Python standard library ships no authenticated cipher.  Shipping
    a homemade XOR/CTR construction would be a fake control — worse than
    an honest passthrough, because it would LOOK like protection.  The
    real cipher (AES-256-GCM via the `cryptography` wheel) arrives only
    with a vetted, hash-locked dependency addition; until then
    :class:`KeyedProviderStub` refuses to wrap rather than pretending.

FLIP PROTOCOL (for the wave that turns this on — read before wiring):
  1. Add the vetted crypto dependency to pyproject AND regenerate
     requirements-lock.txt (scripts/generate_lock.py — the supply-chain
     gate fails on a drifted lock).
  2. Implement a real provider here (AES-256-GCM; nonce prefix inside
     the ENC_MAGIC frame), selected by ``provider_from_env`` ONLY when
     ``ENGINE_ENCRYPTION_KEY`` is set.
  3. MIGRATION TRAP — content-addressed snapshots: the journal store
     names objects by the sha256 OF THE STORED BYTES.  Encrypting
     changes the stored bytes, so addresses change; the journal event's
     recorded hash must then be the hash of the WRAPPED bytes (write
     side wraps FIRST, then hashes), and old plaintext objects stay
     readable because ``unwrap_at_rest`` detects the frame:  bytes that
     do not start with :data:`ENC_MAGIC` pass through unchanged.
  4. A wrapped blob read WITHOUT a configured key must fail LOUDLY
     (:class:`EncryptedBlobWithoutKey`) — never be returned as if it
     were plaintext.  Already enforced by the passthrough provider.

KEY DERIVATION (usable today, deterministic, tested against the RFC
5869 vectors): one master key, one derived key per PURPOSE — snapshots
and ai_audit never share a key, so a future compromise of one surface
does not open the other.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from typing import Optional

#: Frame magic for wrapped (encrypted) blobs.  Version byte included so
#: a future format bump is detectable.  Plaintext passthrough blobs are
#: NEVER framed — identity means identity.
ENC_MAGIC = b"ENGENC\x01"

#: Purpose labels — the domain-separation vocabulary for derive_key.
PURPOSE_SNAPSHOT = "journal.snapshot"
PURPOSE_AI_AUDIT = "ai_audit"

#: Env var a FUTURE keyed provider will read.  provider_from_env
#: deliberately ignores it today (DO-NOT-FLIP — see module docstring).
ENV_KEY = "ENGINE_ENCRYPTION_KEY"

_HASH_LEN = 32  # SHA-256 output size


class EncryptedBlobWithoutKey(RuntimeError):
    """A frame-magic (encrypted) blob was read while no decryption
    capability is configured.  Refusing loudly beats returning
    ciphertext as if it were plaintext."""


class CipherNotAvailable(NotImplementedError):
    """The keyed provider was asked to encrypt before a vetted cipher
    dependency exists in the locked dependency set."""


# ── RFC 5869 HKDF-SHA256 (stdlib-only; vectors locked in tests) ────────


def hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    """HKDF-Extract: PRK = HMAC-SHA256(salt, IKM).  An empty salt is
    replaced by HashLen zero bytes per the RFC."""
    if not salt:
        salt = b"\x00" * _HASH_LEN
    return hmac.new(salt, ikm, hashlib.sha256).digest()


def hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    """HKDF-Expand: OKM of ``length`` bytes (max 255 * HashLen)."""
    if length <= 0:
        raise ValueError("HKDF length must be positive")
    if length > 255 * _HASH_LEN:
        raise ValueError("HKDF length exceeds 255 * HashLen")
    okm = b""
    block = b""
    counter = 1
    while len(okm) < length:
        block = hmac.new(
            prk, block + info + bytes([counter]), hashlib.sha256
        ).digest()
        okm += block
        counter += 1
    return okm[:length]


def hkdf_sha256(ikm: bytes, *, salt: bytes = b"", info: bytes = b"",
                length: int = 32) -> bytes:
    """Full HKDF (extract + expand) per RFC 5869 with SHA-256."""
    return hkdf_expand(hkdf_extract(salt, ikm), info, length)


def derive_key(master_key: bytes, purpose: str, *, length: int = 32) -> bytes:
    """One derived key per PURPOSE from one master key.

    Domain separation is the point: ``derive_key(m, PURPOSE_SNAPSHOT)``
    and ``derive_key(m, PURPOSE_AI_AUDIT)`` are unrelated keys, so the
    two at-rest surfaces can never be opened with each other's key.
    Deterministic — same (master, purpose) always yields the same key.
    """
    if not isinstance(master_key, (bytes, bytearray)) or not master_key:
        raise ValueError("master_key must be non-empty bytes")
    if not purpose or not isinstance(purpose, str):
        raise ValueError("purpose must be a non-empty string")
    info = b"engine-at-rest:v1:" + purpose.encode("utf-8")
    return hkdf_sha256(bytes(master_key), salt=b"", info=info, length=length)


# ── The provider seam ──────────────────────────────────────────────────


class PassthroughProvider(object):
    """The single-tenant DEFAULT: identity in both directions.

    The one thing it refuses: unwrapping a blob that carries the
    encrypted-frame magic — that blob was written by a keyed provider
    and returning its ciphertext as plaintext would be silent
    corruption.  This makes a future partial rollback safe by
    construction."""

    name = "passthrough"
    encrypts = False

    def wrap(self, data: bytes, *, purpose: str) -> bytes:  # noqa: ARG002
        return data

    def unwrap(self, blob: bytes, *, purpose: str) -> bytes:
        if blob.startswith(ENC_MAGIC):
            raise EncryptedBlobWithoutKey(
                "blob for purpose %r carries the encrypted frame magic but "
                "no decryption key/provider is configured — refusing to "
                "return ciphertext as plaintext" % (purpose,)
            )
        return blob


class KeyedProviderStub(object):
    """Where the real cipher lands.  Constructible (so key handling and
    derivation are testable today) but refuses to produce ciphertext
    until a vetted cipher dependency exists — an honest stub, never a
    homemade cipher."""

    name = "keyed-stub"
    encrypts = False  # flips to True only with a real cipher

    def __init__(self, master_key: bytes) -> None:
        # Derivation runs NOW so key-handling bugs surface in tests
        # today, not on flip day.
        self._keys = {
            PURPOSE_SNAPSHOT: derive_key(master_key, PURPOSE_SNAPSHOT),
            PURPOSE_AI_AUDIT: derive_key(master_key, PURPOSE_AI_AUDIT),
        }

    def key_for(self, purpose: str) -> bytes:
        if purpose not in self._keys:
            self._keys[purpose] = derive_key(
                b"".join(sorted(self._keys.values())) or b"\x00", purpose
            )
        return self._keys[purpose]

    def wrap(self, data: bytes, *, purpose: str) -> bytes:  # noqa: ARG002
        raise CipherNotAvailable(
            "at-rest encryption is a seam only in this build — the cipher "
            "arrives with a vetted, hash-locked crypto dependency (see "
            "module docstring FLIP PROTOCOL)"
        )

    def unwrap(self, blob: bytes, *, purpose: str) -> bytes:
        if blob.startswith(ENC_MAGIC):
            raise CipherNotAvailable(
                "encrypted blob for purpose %r cannot be decrypted in this "
                "build (cipher dependency not yet locked)" % (purpose,)
            )
        return blob  # plaintext-era blob: readable forever (migration rule)


def provider_from_env() -> PassthroughProvider:
    """THE provider used by at-rest callers.

    Returns :class:`PassthroughProvider` UNCONDITIONALLY — including
    when ``ENGINE_ENCRYPTION_KEY`` is set.  Flipping this to a keyed
    provider is a deliberate future wave (module docstring FLIP
    PROTOCOL), never a side effect of an env var appearing.  Locked by
    tests/engine/test_encryption_seam.py.
    """
    # Read (and deliberately ignore) the env so the future wiring point
    # is explicit and grep-able.
    _future_key = os.environ.get(ENV_KEY)  # noqa: F841
    return PassthroughProvider()


# ── The at-rest seam (what journal.store / ai_audit persist will call) ─


def wrap_at_rest(data: bytes, *, purpose: str,
                 provider: Optional[object] = None) -> bytes:
    """Byte boundary for WRITING an at-rest object (snapshot / ai_audit
    payload).  Passthrough today — callers adopting this seam gain
    encryption on flip day with no further code change."""
    active = provider if provider is not None else provider_from_env()
    return active.wrap(data, purpose=purpose)  # type: ignore[attr-defined]


def unwrap_at_rest(blob: bytes, *, purpose: str,
                   provider: Optional[object] = None) -> bytes:
    """Byte boundary for READING an at-rest object.  Passthrough today;
    frame-magic blobs fail loudly rather than leak ciphertext."""
    active = provider if provider is not None else provider_from_env()
    return active.unwrap(blob, purpose=purpose)  # type: ignore[attr-defined]
