"""StructuralMap cache — content-addressed, deterministic (E2 seed).

Key = sha256 over (sha256(file_bytes), role, prompt_version, model_id).
Same key ⇒ byte-identical map JSON forever: the stored text is the map's
canonical serialization (:meth:`StructuralMap.to_json_text`), written
once (first-write-wins) and never rewritten.

Stores:
  · :class:`FileCacheStore` — a NEW local store under
    ``<repo>/data/interp_cache/`` (a gitignored runtime path, same
    ``data/`` convention as the AI spend breaker), atomic writes
    (tmp + os.replace). ``INTERP_CACHE_DIR`` overrides (ops + tests).
  · :class:`MemoryCacheStore` — pure in-memory injectable store for
    tests.

:func:`interpret_with_cache` is the lazy orchestration: the cache is
consulted BEFORE any client/factory is touched, so a hit never
constructs a client and never makes an AI call (mirrors the AI lane's
cache-before-client discipline).

This store is deliberately SEPARATE from the AI lane's envelope cache
(Supabase ``financial_periods.assembled_canonical_v1.ai_audit``) — the
lane cache is a per-document serving artifact; this one is a pure
content-addressed function cache with no Supabase dependency.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

from engine.ai import registry as _registry

from .interpreter import InterpError, role_for_framing, run_structural_interpretation
from .structmap import StructMapError, StructuralMap

logger = logging.getLogger("engine.interp.cache")

#: Env override for the file store's directory (ops + tests).
CACHE_DIR_ENV = "INTERP_CACHE_DIR"


def _repo_root() -> Path:
    # src/engine/interp/cache.py -> parents[3] == the repo root (== /app
    # in the container; same convention as engine.ai.breaker).
    return Path(__file__).resolve().parents[3]


def _default_cache_dir() -> Path:
    env = os.environ.get(CACHE_DIR_ENV)
    if env:
        return Path(env)
    return _repo_root() / "data" / "interp_cache"


def cache_key(
    file_bytes: bytes, *, role: str, prompt_version: str, model_id: str
) -> str:
    """Deterministic content-addressed key. Any change to the document
    bytes, the role (framing), the prompt version, or the model id yields
    a different key — a template/prompt edit invalidates automatically."""
    composite = json.dumps(
        {
            "content_sha256": hashlib.sha256(file_bytes).hexdigest(),
            "role": role,
            "prompt_version": prompt_version,
            "model_id": model_id,
        },
        sort_keys=True, ensure_ascii=False, separators=(",", ":"),
    )
    return hashlib.sha256(composite.encode("utf-8")).hexdigest()


class MemoryCacheStore:
    """Pure in-memory store (tests + ephemeral runs)."""

    def __init__(self) -> None:
        self.data: Dict[str, str] = {}

    def get(self, key: str) -> Optional[str]:
        return self.data.get(key)

    def put(self, key: str, text: str) -> None:
        # First-write-wins: a stored map is immutable for its key.
        self.data.setdefault(key, text)


class FileCacheStore:
    """File-backed store: one ``<key>.json`` per entry, atomic writes.

    Read/write trouble degrades to a miss / a skipped write (logged) —
    the cache must never take extraction down with it."""

    def __init__(self, root: Optional[Any] = None) -> None:
        self.root = Path(root) if root is not None else _default_cache_dir()

    def _path(self, key: str) -> Path:
        # Keys are sha256 hexdigests — validate before touching the fs so
        # a corrupt key can never traverse paths.
        if not (isinstance(key, str) and len(key) == 64
                and all(c in "0123456789abcdef" for c in key)):
            raise ValueError("interp cache key must be a sha256 hexdigest")
        return self.root / ("%s.json" % key)

    def get(self, key: str) -> Optional[str]:
        path = self._path(key)
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except Exception:  # noqa: BLE001 — degrade to miss, never raise
            logger.warning("[interp.cache] unreadable entry %s — treating as miss", path)
            return None

    def put(self, key: str, text: str) -> None:
        path = self._path(key)
        try:
            if path.exists():
                return  # first-write-wins
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(text, encoding="utf-8")
            os.replace(str(tmp), str(path))
        except Exception:  # noqa: BLE001 — best-effort, never raise
            logger.warning("[interp.cache] could not persist entry %s", path)


def interpret_with_cache(
    file_bytes: bytes,
    filename: str,
    *,
    jurisdiction: str,
    framing: str,
    store: Any,
    client: Any = None,
    client_factory: Optional[Callable[[], Any]] = None,
    audit: Optional[Dict[str, Any]] = None,
) -> Tuple[StructuralMap, Dict[str, Any]]:
    """Cache-through structural interpretation.

    A hit deserializes the stored canonical JSON and makes ZERO client
    calls (the client/factory is never touched). A miss runs
    :func:`run_structural_interpretation` and stores the map's canonical
    text under the content-addressed key.
    """
    role = role_for_framing(framing)
    try:
        params = _registry.params_for(role)
    except _registry.RegistryError as e:
        raise InterpError(
            "structural interpreter role '%s' is not configured in the "
            "model registry: %s" % (role, e)
        )
    key = cache_key(
        file_bytes,
        role=role,
        prompt_version=params["prompt_version"],
        model_id=params["model_id"],
    )

    cached_text = store.get(key)
    if cached_text is not None:
        try:
            smap = StructuralMap.from_json_text(cached_text)
        except StructMapError:
            logger.warning(
                "[interp.cache] entry %s failed validation — treating as miss", key
            )
        else:
            meta: Dict[str, Any] = {
                "cached": True,
                "cache_key": key,
                "role": role,
                "framing": framing,
                "model_id": params["model_id"],
                "prompt_version": params["prompt_version"],
                "map_hash": smap.map_hash,
            }
            if isinstance(audit, dict):
                audit.update(meta)
            return smap, meta

    smap, audit_dict = run_structural_interpretation(
        file_bytes,
        filename,
        jurisdiction=jurisdiction,
        framing=framing,
        client=client,
        client_factory=client_factory,
        audit=audit,
    )
    store.put(key, smap.to_json_text())
    meta = dict(audit_dict)
    meta.update({"cached": False, "cache_key": key})
    return smap, meta
