"""Dev-mode runtime assertion for gateway-internal envelope fields.

INTERNAL module — importable only from inside ``src/engine/serving/``
(scripts/check_import_boundary.py rejects outside imports).

``guard_envelope(envelope, internal_keys)`` wraps a served/persisted
envelope dict so that DIRECT reads (``[]`` / ``.get`` / ``.pop`` /
``.setdefault``) of a marked-internal key from code OUTSIDE
``src/engine/serving/`` raise :class:`InternalFieldAccessError` with a
pointer to the gateway public API. The wrap is:

  * OFF unless the environment flag ``ENGINE_DEV_ASSERT`` equals exactly
    ``"1"`` — disabled, the SAME object is returned (zero production
    overhead, no wrapper, no per-read work);
  * frame-aware — the nearest calling frame outside this module decides:
    frames whose filename lives under ``src/engine/serving/`` read
    freely (the gateway is the read authority);
  * idempotent — wrapping a wrapped envelope returns it unchanged;
  * passthrough for non-dict values.

The static half of the same boundary is scripts/check_import_boundary.py
(grep guard over PRIVATE_SNAPSHOT_FIELDS); this module is the dynamic
half for dev/test runs that want reads to fail LOUDLY at the exact call
site instead of at CI time.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Iterable, Optional

#: The opt-in switch. Exactly "1" enables the guard; anything else
#: (unset, "true", "0", …) keeps it off.
ENV_FLAG = "ENGINE_DEV_ASSERT"

#: Path fragment that marks a frame as gateway-resident. Compared on
#: forward-slash-normalized frame filenames.
_GATEWAY_PATH_FRAGMENT = "src/engine/serving/"

#: This module's own filename — frames inside the guard machinery are
#: skipped when resolving the caller.
_SELF_FILE = __file__


class InternalFieldAccessError(RuntimeError):
    """A gateway-internal envelope field was read directly from code
    outside src/engine/serving/ while ENGINE_DEV_ASSERT=1."""


def dev_assert_enabled() -> bool:
    """True iff the ``ENGINE_DEV_ASSERT`` environment flag is exactly "1"."""
    return os.environ.get(ENV_FLAG) == "1"


def _caller_is_gateway() -> bool:
    """True when the nearest calling frame outside this module lives
    under src/engine/serving/ (the read authority)."""
    frame = sys._getframe(1)  # noqa: SLF001 — CPython frame walk, dev-only path
    while frame is not None:
        filename = frame.f_code.co_filename
        if filename != _SELF_FILE:
            return _GATEWAY_PATH_FRAGMENT in filename.replace("\\", "/")
        frame = frame.f_back
    return False


class _GuardedEnvelope(dict):
    """dict subclass that rejects direct reads of internal keys from
    non-gateway frames. Only READ paths are guarded ([], get, pop,
    setdefault); writes stay unrestricted (the builder owns writes)."""

    # Stored on the instance dict of the subclass (not slots — dict
    # subclasses carry an instance __dict__ anyway).
    _internal_keys: frozenset

    def _check(self, key: Any) -> None:
        if key in self._internal_keys and not _caller_is_gateway():
            raise InternalFieldAccessError(
                "direct read of gateway-internal envelope field %r outside "
                "src/engine/serving/ — read served facts through the gateway "
                "public API (src/engine/serving/facts.py) instead. This "
                "assertion is active because %s=1." % (key, ENV_FLAG)
            )

    def __getitem__(self, key: Any) -> Any:
        self._check(key)
        return dict.__getitem__(self, key)

    def get(self, key: Any, default: Any = None) -> Any:
        self._check(key)
        return dict.get(self, key, default)

    def pop(self, key: Any, *args: Any) -> Any:
        self._check(key)
        return dict.pop(self, key, *args)

    def setdefault(self, key: Any, default: Any = None) -> Any:
        self._check(key)
        return dict.setdefault(self, key, default)


def guard_envelope(envelope: Any, internal_keys: Iterable[str]) -> Any:
    """Wrap ``envelope`` with the dev-mode internal-field guard.

    Returns the SAME object when the flag is off, when ``envelope`` is
    not a plain dict, or when it is already guarded (idempotent)."""
    if not dev_assert_enabled():
        return envelope
    if isinstance(envelope, _GuardedEnvelope) or not isinstance(envelope, dict):
        return envelope
    guarded = _GuardedEnvelope(envelope)
    guarded._internal_keys = frozenset(internal_keys or ())
    return guarded


def internal_keys_of(guarded: Any) -> Optional[frozenset]:
    """The internal-key set of a guarded envelope, or None (introspection
    helper for tests)."""
    if isinstance(guarded, _GuardedEnvelope):
        return guarded._internal_keys
    return None
