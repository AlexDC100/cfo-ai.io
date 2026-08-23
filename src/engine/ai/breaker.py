"""Per-role daily spend circuit breaker (engine.ai.breaker).

Cost armor for every AI role, never a serving gate: when a role's daily
cap is exhausted (or the account has no credits), the caller degrades
to the honest "advisory unavailable" state and the deterministic
serving path proceeds untouched. Decision record:
docs/decisions/ADR-ai-spend-breaker.md.

  · CAPS ARE CONFIG — engine.ai/models.yaml `breaker` per role
    (max_calls_per_day / max_tokens_per_day; defaults merged by the
    registry). 0 == the role is fully closed (ops kill switch; also how
    the trip tests force the state).
  · THE COUNTER IS A FILE under the existing data/ dir convention — no
    new datastore. Default `<repo>/data/ai_spend/ai_spend_breaker.json`
    (== /app/data/ai_spend/... in the container, the same volume the
    gdelt cache uses); `AI_BREAKER_STATE_DIR` overrides (tests use a
    tmp dir). Shape: {"day": "YYYY-MM-DD" (UTC), "roles": {role:
    {"calls": int, "tokens": int}}}. Day rollover resets in place.
  · Writes are atomic (tmp + os.replace) and serialized through an
    advisory flock when the platform has fcntl. Counting is best-effort
    by design — a lost increment can only UNDER-count spend for the
    single-process backend this runs in; the caps are armor, not
    ledgers. A corrupt/unreadable state file resets to zero counters
    (loud log), never raises into the caller.
  · FAILURE ISOLATION: `check` raises only :class:`BreakerOpen` (the
    caller's degrade signal). Every I/O problem inside the breaker
    itself degrades to "open for business, counted best-effort" —
    the breaker must never take serving down.

Consumers: engine.ai.advisory (role "ai_validator", per call), the
guarded client factory below (trips BEFORE a client is even
constructed), and — once the coordinator lands the one-line wiring —
the reconcile proposal path (`engine.ai.breaker.check(
"reconcile_proposal")` at the top of `_reconcile._ai_propose`; its trip
already degrades through the stage's existing calm needs_review path,
proven by tests/engine/test_breaker.py).
"""
from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from . import registry

logger = logging.getLogger("engine.ai.breaker")

#: Env override for the state directory (tests + ops).
STATE_DIR_ENV = "AI_BREAKER_STATE_DIR"

#: The one state file (per state dir).
STATE_FILENAME = "ai_spend_breaker.json"

#: The degraded-state marker vocabulary (shared with engine.ai.advisory).
DEGRADED_MARKER = "ai_advisory_unavailable"

_LOCK = threading.Lock()


class BreakerOpen(RuntimeError):
    """The role's daily spend cap is exhausted (or forced closed).

    Callers map this to the honest "advisory unavailable" degraded
    state — never to an error surface, never to a serving block.
    """

    def __init__(self, role: str, reason: str) -> None:
        super().__init__("AI spend breaker open for role '%s': %s" % (role, reason))
        self.role = role
        self.reason = reason


def _repo_root() -> Path:
    # src/engine/ai/breaker.py -> parents[3] == the repo root (== /app in
    # the container, whose data/ volume matches the gdelt-cache habit).
    return Path(__file__).resolve().parents[3]


def _state_dir(state_dir: Optional[Any] = None) -> Path:
    if state_dir is not None:
        return Path(state_dir)
    env = os.environ.get(STATE_DIR_ENV)
    if env:
        return Path(env)
    return _repo_root() / "data" / "ai_spend"


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _empty_state() -> Dict[str, Any]:
    return {"day": _today(), "roles": {}}


def _read_state(path: Path) -> Dict[str, Any]:
    """Read + day-normalize the state. Corruption or I/O trouble resets
    to zero counters (logged loudly) — the breaker never raises I/O."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or not isinstance(raw.get("roles"), dict):
            raise ValueError("state shape invalid")
    except FileNotFoundError:
        return _empty_state()
    except Exception:  # noqa: BLE001 — reset, never raise into the caller
        logger.warning(
            "[ai.breaker] state file %s unreadable — resetting counters", path
        )
        return _empty_state()
    if raw.get("day") != _today():
        return _empty_state()
    return raw


def _write_state(path: Path, state: Dict[str, Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(
            json.dumps(state, sort_keys=True, ensure_ascii=False), encoding="utf-8"
        )
        os.replace(str(tmp), str(path))
    except Exception:  # noqa: BLE001 — best-effort counting, never raise
        logger.warning("[ai.breaker] could not persist state to %s", path)


class _FileLock(object):
    """Advisory flock around read-modify-write, when fcntl exists."""

    def __init__(self, path: Path) -> None:
        self._path = path.with_name(path.name + ".lock")
        self._handle = None

    def __enter__(self) -> "_FileLock":
        try:
            import fcntl

            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._handle = open(str(self._path), "a+")
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX)
        except Exception:  # noqa: BLE001 — lockless best-effort fallback
            self._handle = None
        return self

    def __exit__(self, *args: Any) -> bool:
        if self._handle is not None:
            try:
                import fcntl

                fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
            except Exception:  # noqa: BLE001
                pass
            try:
                self._handle.close()
            except Exception:  # noqa: BLE001
                pass
        return False


def _counters(state: Dict[str, Any], role: str) -> Dict[str, int]:
    entry = state["roles"].get(role)
    if not isinstance(entry, dict):
        entry = {"calls": 0, "tokens": 0}
        state["roles"][role] = entry
    entry["calls"] = int(entry.get("calls") or 0)
    entry["tokens"] = int(entry.get("tokens") or 0)
    return entry


def check(role: str, *, state_dir: Optional[Any] = None) -> None:
    """Raise :class:`BreakerOpen` when the role's daily caps are spent.

    Call BEFORE constructing a client / making a model call. Cap 0
    trips immediately (fully closed role).
    """
    limits = registry.breaker_limits_for(role)
    path = _state_dir(state_dir) / STATE_FILENAME
    state = _read_state(path)
    entry = _counters(state, role)
    if entry["calls"] >= limits["max_calls_per_day"]:
        raise BreakerOpen(
            role,
            "max_calls_per_day reached (%d/%d)"
            % (entry["calls"], limits["max_calls_per_day"]),
        )
    if entry["tokens"] >= limits["max_tokens_per_day"]:
        raise BreakerOpen(
            role,
            "max_tokens_per_day reached (%d/%d)"
            % (entry["tokens"], limits["max_tokens_per_day"]),
        )


def record(role: str, *, tokens: int = 0, state_dir: Optional[Any] = None) -> None:
    """Count one call (+ tokens when known) against the role's day."""
    path = _state_dir(state_dir) / STATE_FILENAME
    with _LOCK:
        with _FileLock(path):
            state = _read_state(path)
            entry = _counters(state, role)
            entry["calls"] += 1
            entry["tokens"] += max(0, int(tokens or 0))
            _write_state(path, state)


def consume(role: str, *, tokens: int = 0, state_dir: Optional[Any] = None) -> None:
    """check() then record() — the one-shot guard for a single call."""
    check(role, state_dir=state_dir)
    record(role, tokens=tokens, state_dir=state_dir)


def status_snapshot(state_dir: Optional[Any] = None) -> Dict[str, Any]:
    """Read-only snapshot {day, roles{role: {calls, tokens, limits}}} —
    for ops surfaces and the deploy probe."""
    path = _state_dir(state_dir) / STATE_FILENAME
    state = _read_state(path)
    out: Dict[str, Any] = {"day": state["day"], "roles": {}}
    try:
        reg = registry.load_registry()
    except registry.RegistryError:
        reg = {}
    for role in sorted(set(list(reg.keys()) + list(state["roles"].keys()))):
        entry = dict(_counters(state, role))
        if role in reg:
            entry["limits"] = dict(reg[role]["breaker"])
        out["roles"][role] = entry
    return out


def degraded_marker(role: str, reason: str) -> Dict[str, Any]:
    """The honest "advisory unavailable" degraded state — the ONE shape
    every AI consumer attaches when it cannot run (breaker trip, missing
    credits, model failure). Serving proceeds regardless."""
    return {
        "marker": DEGRADED_MARKER,
        "available": False,
        "role": role,
        "reason": reason,
    }


def guarded_client_factory(
    role: str,
    base_factory: Optional[Callable[[], Any]] = None,
    state_dir: Optional[Any] = None,
) -> Callable[[], Any]:
    """A zero-arg client factory that consults the breaker BEFORE any
    client is constructed. Raises :class:`BreakerOpen` on a tripped
    role; otherwise defers to `base_factory` (default: the production
    Anthropic factory from engine.ai_lane.config, which itself fails
    honestly when the key is absent)."""

    def factory() -> Any:
        check(role, state_dir=state_dir)
        if base_factory is not None:
            return base_factory()
        from engine.ai_lane.config import default_client_factory

        return default_client_factory()

    return factory
