"""Model registry — models.yaml as config (engine.ai.registry).

One schema-validated table {role -> {model_id, prompt_version,
max_tokens, temperature, breaker}} for every AI call site in the
engine. Config, not code: changing a model or bumping a base prompt
version is a YAML edit; the registry only validates and serves it.

Consumers (locked by tests/engine/test_model_registry.py):
  · engine.ai_lane.config — MODEL_ID + per-stage prompt versions +
    max-token ceilings are registry reads (value-identical cutover;
    the classify pack-hash prompt-version derivation composes ON TOP
    of the base version served here).
  · engine.ai_lane._client — per-stage model resolution on every call.
  · engine.api._reconcile — AI_MODEL / PROMPT_VERSION constants.
  · engine.ai.breaker — per-role daily spend caps.
  · engine.ai.advisory — the ai_validator role.

Failure policy: LOUD. A missing/corrupt/incomplete models.yaml raises
:class:`RegistryError` at first read — the engine must never guess a
model id silently (same discipline as pack loading). The deploy probe
(scripts/check_anthropic_probe.py) surfaces registry health as a
deploy-time notice.

Caching: one parsed+validated registry per resolved file path, keyed by
absolute path. `ENGINE_AI_MODELS_PATH` overrides the default file (ops
+ tests); tests call :func:`clear_cache` around overrides.

Stdlib + yaml ONLY — this module is imported at module level by
engine.ai_lane.config and engine.api._reconcile and must never pull the
API package, packs runtime, or any SDK.
"""
from __future__ import annotations

import copy
import os
import threading
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

#: Registry file schema tag (bump on shape changes, with a migration note).
SCHEMA = "ai_model_registry_v1"

#: Env override for the registry file (ops + tests).
PATH_ENV = "ENGINE_AI_MODELS_PATH"

#: Every role the engine calls today. Extra roles in the file are allowed
#: (forward-compat); missing REQUIRED roles fail loud.
REQUIRED_ROLES = (
    "format_detect",
    "extract",
    "classify",
    "reconcile_proposal",
    "ai_validator",
    "narrative",
)

#: Per-role keys served by params_for (breaker merged with defaults).
_ROLE_KEYS = ("model_id", "prompt_version", "max_tokens", "temperature", "breaker")


class RegistryError(RuntimeError):
    """models.yaml is missing, unreadable, or fails schema validation.

    Deliberately loud: an AI call site must never fall back to a guessed
    model id — a broken registry is a deploy bug, surfaced immediately.
    """


_LOCK = threading.Lock()
_CACHE: Dict[str, Dict[str, Dict[str, Any]]] = {}


def default_path() -> Path:
    """The packaged registry file (next to this module)."""
    return Path(__file__).resolve().with_name("models.yaml")


def _resolve_path(path: Optional[Any] = None) -> Path:
    if path is not None:
        return Path(path)
    env = os.environ.get(PATH_ENV)
    if env:
        return Path(env)
    return default_path()


def _fail(path: Path, message: str) -> None:
    raise RegistryError("model registry %s: %s" % (path, message))


def _require_str(path: Path, role: str, params: Dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value.strip():
        _fail(path, "role '%s' needs a non-empty string '%s'" % (role, key))
    return value


def _require_int(path: Path, role: str, value: Any, key: str, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        _fail(path, "role '%s' needs integer '%s' >= %d (got %r)"
              % (role, key, minimum, value))
    return value


def _validate(path: Path, raw: Any) -> Dict[str, Dict[str, Any]]:
    if not isinstance(raw, dict):
        _fail(path, "top level must be a mapping")
    if raw.get("schema") != SCHEMA:
        _fail(path, "schema must be %r (got %r)" % (SCHEMA, raw.get("schema")))
    defaults = raw.get("defaults") or {}
    if not isinstance(defaults, dict):
        _fail(path, "'defaults' must be a mapping when present")
    default_breaker = defaults.get("breaker") or {}
    if not isinstance(default_breaker, dict):
        _fail(path, "'defaults.breaker' must be a mapping when present")
    roles_raw = raw.get("roles")
    if not isinstance(roles_raw, dict) or not roles_raw:
        _fail(path, "'roles' must be a non-empty mapping")

    validated: Dict[str, Dict[str, Any]] = {}
    for role, params in roles_raw.items():
        if not isinstance(params, dict):
            _fail(path, "role '%s' must be a mapping" % role)
        model_id = _require_str(path, role, params, "model_id")
        prompt_version = _require_str(path, role, params, "prompt_version")
        max_tokens = _require_int(
            path, role, params.get("max_tokens"), "max_tokens", 1
        )
        temperature = params.get("temperature", defaults.get("temperature", 0))
        # Operator spec pins temperature 0 for every role — enforced, so a
        # stray sampling temperature can never sneak in through config.
        if temperature != 0:
            _fail(path, "role '%s' temperature must be 0 (got %r)"
                  % (role, temperature))
        breaker_raw = params.get("breaker") or {}
        if not isinstance(breaker_raw, dict):
            _fail(path, "role '%s' breaker must be a mapping" % role)
        merged_breaker = dict(default_breaker)
        merged_breaker.update(breaker_raw)
        breaker = {
            "max_calls_per_day": _require_int(
                path, role, merged_breaker.get("max_calls_per_day"),
                "breaker.max_calls_per_day", 0,
            ),
            "max_tokens_per_day": _require_int(
                path, role, merged_breaker.get("max_tokens_per_day"),
                "breaker.max_tokens_per_day", 0,
            ),
        }
        validated[str(role)] = {
            "model_id": model_id,
            "prompt_version": prompt_version,
            "max_tokens": max_tokens,
            "temperature": 0,
            "breaker": breaker,
        }

    missing = [r for r in REQUIRED_ROLES if r not in validated]
    if missing:
        _fail(path, "missing required roles: %s" % ", ".join(missing))
    return validated


def load_registry(path: Optional[Any] = None) -> Dict[str, Dict[str, Any]]:
    """Load + validate + cache the registry. Returns a DEEP COPY so a
    caller can never mutate the cached table."""
    resolved = _resolve_path(path)
    key = str(resolved)
    with _LOCK:
        cached = _CACHE.get(key)
        if cached is None:
            if not resolved.is_file():
                _fail(resolved, "file not found")
            try:
                raw = yaml.safe_load(resolved.read_text(encoding="utf-8"))
            except Exception as e:  # noqa: BLE001 — wrap into the loud typed error
                _fail(resolved, "unreadable YAML (%s)" % e)
            cached = _validate(resolved, raw)
            _CACHE[key] = cached
        return copy.deepcopy(cached)


def params_for(role: str, path: Optional[Any] = None) -> Dict[str, Any]:
    """The full validated parameter row for a role (deep copy)."""
    registry = load_registry(path)
    params = registry.get(role)
    if params is None:
        raise RegistryError(
            "model registry has no role '%s' (known: %s)"
            % (role, ", ".join(sorted(registry)))
        )
    return params


def model_for(role: str, path: Optional[Any] = None) -> str:
    """The model id string for a role."""
    return params_for(role, path)["model_id"]


def breaker_limits_for(role: str, path: Optional[Any] = None) -> Dict[str, int]:
    """The per-role daily spend caps consumed by engine.ai.breaker."""
    return params_for(role, path)["breaker"]


def clear_cache() -> None:
    """Drop every cached registry (tests that repoint PATH_ENV must call
    this before AND after the override)."""
    with _LOCK:
        _CACHE.clear()
