"""Pack runtime — the ONE place production code resolves jurisdiction packs.

Phase 3 (RO cutover): classification no longer runs off in-code tables;
``engine.country_packs.ro_romania.chart_of_accounts`` reads the
CompiledPack this module resolves. The runtime is deliberately tiny:

    active_pack("RO")                      the latest RO pack (default —
                                           classification runs before the
                                           period's end date is final, so
                                           the production seams use latest)
    active_pack("RO", period_end="2024-06-30")
                                           effective-dated resolve for a
                                           known period end (the N-series
                                           tests exercise this seam; a
                                           future second RO window makes
                                           the pipeline thread period_end
                                           through deliberately)

Resolution is CACHED per (packs root, jurisdiction, period_end):
discovery walks the root once per root, ``resolve``/latest-pick are pure
functions of the discovered packs. ``invalidate_pack_cache()`` clears
both caches (tests that repoint the root MUST call it).

PACKS ROOT — first match wins:

    ENGINE_PACKS_ROOT   explicit override (ops / tests)
    SHADOW_PACK_ROOT    legacy alias from the shadow phase (kept so
                        existing harnesses keep working)
    <repo>/packs        the checked-in packs directory, resolved from
                        this file (src/engine/packs/runtime.py ->
                        parents[3]); in the backend image that is
                        /app/packs (Dockerfile COPYs packs/)

FAILURE MODE: loud. A missing root or an unresolvable jurisdiction
raises ``NoPackFoundError`` — there is no legacy table to fall back to
(the fallback WAS the dual path Phase 3 deletes). The engine must not
boot half-classified.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Dict, Optional, Tuple, Union

from .loader import discover_packs, resolve
from .schema import CompiledPack, NoPackFoundError

__all__ = [
    "default_packs_root",
    "active_pack",
    "invalidate_pack_cache",
]

_LOCK = threading.Lock()
_DISCOVERY_CACHE: Dict[str, Tuple[CompiledPack, ...]] = {}
_RESOLVE_CACHE: Dict[Tuple[str, str, Optional[str]], CompiledPack] = {}


def default_packs_root() -> Path:
    """The packs root per the module-docstring precedence."""
    for env_var in ("ENGINE_PACKS_ROOT", "SHADOW_PACK_ROOT"):
        override = os.environ.get(env_var)
        if override:
            return Path(override)
    return Path(__file__).resolve().parents[3] / "packs"


def _discovered(root: Path) -> Tuple[CompiledPack, ...]:
    key = str(root)
    packs = _DISCOVERY_CACHE.get(key)
    if packs is None:
        packs = discover_packs(root)
        _DISCOVERY_CACHE[key] = packs
    return packs


def _latest(packs: Tuple[CompiledPack, ...], jurisdiction: str) -> CompiledPack:
    """The jurisdiction's CURRENT pack: greatest effective_from, version
    as the deterministic tiebreak. Deliberately date-free (a today()-
    based resolve would be a determinism hazard for zero benefit — the
    latest window is the governing one for any new upload)."""
    jur = jurisdiction.strip().upper()
    candidates = [p for p in packs if p.identity.jurisdiction.upper() == jur]
    if not candidates:
        known = sorted({p.identity.jurisdiction for p in packs})
        raise NoPackFoundError(
            "no packs for jurisdiction %r (known: %s)" % (jur, known or "<none>")
        )
    return max(
        candidates,
        key=lambda p: (p.identity.effective_from.isoformat(), p.identity.version),
    )


def active_pack(
    jurisdiction: str,
    period_end: Optional[Union[str, "object"]] = None,
) -> CompiledPack:
    """THE governing pack for ``jurisdiction``: effective-dated when a
    ``period_end`` (ISO string or date) is supplied, the latest window
    otherwise. Cached; loud typed failures (see module docstring)."""
    root = default_packs_root()
    key = (str(root), jurisdiction.strip().upper(),
           str(period_end) if period_end is not None else None)
    pack = _RESOLVE_CACHE.get(key)
    if pack is not None:
        return pack
    with _LOCK:
        pack = _RESOLVE_CACHE.get(key)
        if pack is not None:
            return pack
        packs = _discovered(root)
        if period_end is None:
            pack = _latest(packs, jurisdiction)
        else:
            pack = resolve(packs, jurisdiction, period_end)  # type: ignore[arg-type]
        _RESOLVE_CACHE[key] = pack
        return pack


def invalidate_pack_cache() -> None:
    """Drop every cached discovery/resolution (tests that repoint
    ENGINE_PACKS_ROOT / SHADOW_PACK_ROOT must call this)."""
    with _LOCK:
        _DISCOVERY_CACHE.clear()
        _RESOLVE_CACHE.clear()
