"""engine.security — trust-boundary primitives (E1).

Public seam (the names future at-rest callers import):

  · :func:`wrap_at_rest` / :func:`unwrap_at_rest` — THE at-rest seam for
    snapshot objects (engine.journal.store) and ai_audit payloads.
    Today: single-tenant passthrough (encryption NOT enabled — see
    encryption.py's module docstring for why and for the flip protocol).
  · :func:`derive_key` / :func:`hkdf_sha256` — deterministic per-purpose
    key derivation (RFC 5869), ready for the day a vetted cipher lands.
  · :class:`PassthroughProvider` / :class:`KeyedProviderStub` /
    :func:`provider_from_env` — the provider seam itself.
"""

from .encryption import (
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

__all__ = [
    "ENC_MAGIC",
    "PURPOSE_AI_AUDIT",
    "PURPOSE_SNAPSHOT",
    "EncryptedBlobWithoutKey",
    "KeyedProviderStub",
    "PassthroughProvider",
    "derive_key",
    "hkdf_sha256",
    "provider_from_env",
    "unwrap_at_rest",
    "wrap_at_rest",
]
