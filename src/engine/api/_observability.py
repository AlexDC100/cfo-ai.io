"""Error tracking — wired, inert, and honest about what is missing.

WHAT THIS IS
============
One function, ``init_error_tracking()``, called once from
``create_app()``. It initialises Sentry if and only if BOTH are true:

  * ``SENTRY_DSN`` is set in the environment, and
  * the ``sentry_sdk`` package is importable.

Anything else — no DSN, no package, an SDK that raises on init — leaves
the process exactly as it was and logs one line. There is no code path
here that can take the API down, which is the whole point: an
observability layer that can break the thing it observes is worse than
no observability layer.

WHY THERE IS NO DEPENDENCY ADDED
================================
``sentry-sdk`` is NOT in ``requirements-lock.txt`` (checked 2026-09-05;
the lock is hash-pinned and built with ``--require-hashes``, and adding
a package to it is a lock regeneration with the platform-marker trap
that costs a broken image if done from macOS — see CLAUDE.md's lock
note). Adding a dependency is not a launch change this lane makes on its
own. So the wiring ships against an OPTIONAL import and reports itself
as unconfigured, and the OWNER ITEM is exactly two steps:

  1. add ``sentry-sdk`` to the lock (regenerate on linux/in the build
     container, per the platform-marker trap), and
  2. set ``SENTRY_DSN`` on the backend container.

Until step 1, setting the DSN alone does nothing except make
``/api/health`` say ``{"sentry": {"configured": true, "active": false,
"reason": "sentry_sdk not installed"}}`` — which is the point of
reporting the state rather than assuming it.

The frontend counterpart (``VITE_SENTRY_DSN``) is a separate wiring in
the Vite bundle and is NOT this module's; see
``scratchpad/launch/features-note.md``.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Set once by init_error_tracking() so /api/health can report the real
# state instead of re-deriving it (and re-importing) on every probe.
_STATE: Dict[str, Any] = {
    "configured": False,   # a DSN is present in the environment
    "active": False,       # the SDK was imported AND initialised
    "reason": "not initialised",
    "environment": None,
    "release": None,
}


def _dsn() -> Optional[str]:
    dsn = (os.environ.get("SENTRY_DSN") or "").strip()
    return dsn or None


def init_error_tracking() -> Dict[str, Any]:
    """Initialise Sentry when it is both wanted and available.

    Returns the state dict (also readable later via ``state()``). Never
    raises — every failure mode is recorded as a reason and swallowed.
    """
    dsn = _dsn()
    environment = (os.environ.get("SENTRY_ENVIRONMENT")
                   or os.environ.get("APP_ENV")
                   or "production")
    release = os.environ.get("GIT_SHA") or None

    _STATE.update({
        "configured": dsn is not None,
        "active": False,
        "environment": environment,
        "release": release,
    })

    if dsn is None:
        _STATE["reason"] = "SENTRY_DSN not set"
        return dict(_STATE)

    try:
        import sentry_sdk  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001 — an optional dependency, by design
        _STATE["reason"] = (
            "sentry_sdk not installed — add it to requirements-lock.txt "
            "before the DSN can take effect"
        )
        logger.warning("[observability] %s", _STATE["reason"])
        return dict(_STATE)

    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=environment,
            release=release,
            # Errors are the launch requirement. Tracing is sampled at
            # zero so enabling this cannot add per-request cost or
            # per-request egress; the owner raises it deliberately.
            traces_sample_rate=_float_env("SENTRY_TRACES_SAMPLE_RATE", 0.0),
            # Never ship request bodies or headers: trial balances and
            # bearer tokens both travel through this API.
            send_default_pii=False,
            max_request_body_size="never",
        )
    except Exception as exc:  # noqa: BLE001 — never fatal
        _STATE["reason"] = "sentry_sdk.init failed: %s" % type(exc).__name__
        logger.warning("[observability] %s", _STATE["reason"])
        return dict(_STATE)

    _STATE.update({"active": True, "reason": "initialised"})
    logger.info("[observability] Sentry active (env=%s release=%s)",
                environment, release)
    return dict(_STATE)


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default


def state() -> Dict[str, Any]:
    """The current error-tracking state, for /api/health."""
    return dict(_STATE)


def reset_for_tests() -> None:
    _STATE.update({
        "configured": False, "active": False,
        "reason": "not initialised", "environment": None, "release": None,
    })
