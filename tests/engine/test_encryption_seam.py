"""E1 — encryption-at-rest SEAM (engine.security.encryption).

What these tests lock:
  * K1  HKDF-SHA256 is the real RFC 5869 construction — verified against
        the RFC's published test vectors (cases 1 and 3), not against
        our own output.
  * K2  derive_key gives DOMAIN SEPARATION: snapshot and ai_audit keys
        from one master are unrelated; derivation is deterministic.
  * K3  The passthrough provider is byte-identity in both directions —
        wiring the seam into the journal store / ai_audit persist can
        never change stored bytes in this build.
  * K4  DO-NOT-FLIP: provider_from_env returns the passthrough even
        when ENGINE_ENCRYPTION_KEY is set.  Turning encryption on is a
        deliberate future wave, never an env-var side effect.
  * K5  Honesty at the boundary: a frame-magic (encrypted) blob is
        REFUSED by the passthrough (never returned as plaintext), and
        the keyed stub refuses to fabricate ciphertext.
"""

from __future__ import annotations

import pytest

from engine.security import (
    ENC_MAGIC,
    PURPOSE_AI_AUDIT,
    PURPOSE_SNAPSHOT,
    EncryptedBlobWithoutKey,
    KeyedProviderStub,
    PassthroughProvider,
    derive_key,
    hkdf_sha256,
    provider_from_env,
    unwrap_at_rest,
    wrap_at_rest,
)
from engine.security.encryption import CipherNotAvailable, hkdf_extract


# ── K1: RFC 5869 vectors (SHA-256) ────────────────────────────────────


def test_k1_rfc5869_case1_basic():
    ikm = bytes.fromhex("0b" * 22)
    salt = bytes.fromhex("000102030405060708090a0b0c")
    info = bytes.fromhex("f0f1f2f3f4f5f6f7f8f9")
    prk = hkdf_extract(salt, ikm)
    assert prk.hex() == (
        "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5"
    )
    okm = hkdf_sha256(ikm, salt=salt, info=info, length=42)
    assert okm.hex() == (
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
        "34007208d5b887185865"
    )


def test_k1_rfc5869_case3_empty_salt_and_info():
    ikm = bytes.fromhex("0b" * 22)
    okm = hkdf_sha256(ikm, salt=b"", info=b"", length=42)
    assert okm.hex() == (
        "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d"
        "9d201395faa4b61a96c8"
    )


def test_k1_expand_length_bounds():
    with pytest.raises(ValueError):
        hkdf_sha256(b"x", length=0)
    with pytest.raises(ValueError):
        hkdf_sha256(b"x", length=255 * 32 + 1)


# ── K2: per-purpose derivation ────────────────────────────────────────


def test_k2_purpose_separation_and_determinism():
    master = b"m" * 32
    snap = derive_key(master, PURPOSE_SNAPSHOT)
    audit = derive_key(master, PURPOSE_AI_AUDIT)
    assert len(snap) == 32 and len(audit) == 32
    assert snap != audit  # the two surfaces never share a key
    assert snap == derive_key(master, PURPOSE_SNAPSHOT)  # deterministic
    assert derive_key(b"other-master!", PURPOSE_SNAPSHOT) != snap


def test_k2_rejects_empty_inputs():
    with pytest.raises(ValueError):
        derive_key(b"", PURPOSE_SNAPSHOT)
    with pytest.raises(ValueError):
        derive_key(b"m", "")


# ── K3: passthrough identity (the wiring-safety property) ─────────────


def test_k3_passthrough_roundtrip_is_byte_identity():
    payload = b'{"canonical_bs": {"rows": []}}\x00\xff arbitrary bytes'
    wrapped = wrap_at_rest(payload, purpose=PURPOSE_SNAPSHOT)
    assert wrapped == payload  # identity, not framed
    assert unwrap_at_rest(wrapped, purpose=PURPOSE_SNAPSHOT) == payload


# ── K4: DO-NOT-FLIP (locked operator decision) ────────────────────────


def test_k4_env_key_does_not_flip_encryption_on(monkeypatch):
    monkeypatch.setenv("ENGINE_ENCRYPTION_KEY", "0" * 64)
    provider = provider_from_env()
    assert isinstance(provider, PassthroughProvider)
    assert provider.encrypts is False
    # The seam stays byte-identity even with the key present.
    assert wrap_at_rest(b"data", purpose=PURPOSE_AI_AUDIT) == b"data"


# ── K5: honest boundaries ─────────────────────────────────────────────


def test_k5_passthrough_refuses_encrypted_frame():
    with pytest.raises(EncryptedBlobWithoutKey):
        unwrap_at_rest(ENC_MAGIC + b"ciphertext", purpose=PURPOSE_SNAPSHOT)


def test_k5_keyed_stub_refuses_to_fabricate_ciphertext():
    stub = KeyedProviderStub(b"master-key-material")
    with pytest.raises(CipherNotAvailable):
        stub.wrap(b"data", purpose=PURPOSE_SNAPSHOT)
    # Plaintext-era blobs stay readable forever (the migration rule)...
    assert stub.unwrap(b"legacy-plain", purpose=PURPOSE_SNAPSHOT) == b"legacy-plain"
    # ...while framed blobs fail loudly rather than pretending.
    with pytest.raises(CipherNotAvailable):
        stub.unwrap(ENC_MAGIC + b"ct", purpose=PURPOSE_SNAPSHOT)


def test_k5_keyed_stub_derives_separated_keys_today():
    stub = KeyedProviderStub(b"master-key-material")
    assert stub.key_for(PURPOSE_SNAPSHOT) != stub.key_for(PURPOSE_AI_AUDIT)
    assert stub.key_for(PURPOSE_SNAPSHOT) == derive_key(
        b"master-key-material", PURPOSE_SNAPSHOT
    )
