"""THE REGISTRY'S NAMES, NORMALIZED ONCE — a persisted index beside the
ONRC/MF registry (``engine.public_ro.store.PublicRoStore``).

``company_identity`` decides "EXACTLY ONE registered company carries this
name" over EVERY registered name, normalized — the only way uniqueness is a
fact rather than a guess about what a capped prefix page left out (verifier
finding, 2026-09-21). That map used to be built in memory for each registry
OBJECT, and the upload route opens a new registry per request: every
identify — and the commit after it — pushed the whole registry (~1M names)
through the normalizer. Measured 5.1-5.6 s per book on a 1M-name registry on
a laptop, 15-20 s in production (live walkthrough, 2026-09-26).

The map is now PERSISTED next to the registry
(``<registry>.names-v<INDEX_VERSION>.sqlite``): built once per state of the
registry's names, then read with one indexed query per name. It is a derived
file — delete it and it is rebuilt; nothing else reads it.

CURRENT, OR NOT USED
  The sidecar records the registry's names fingerprint
  (``PublicRoStore.names_fingerprint``: row count, latest write, position-
  weighted checksums) and the normalizer's own fingerprint (the caller's
  ``normalizer_tag``). A sidecar whose recorded fingerprint is not the live
  one is rebuilt before use; a build during which the registry changed is
  not persisted (its map still answers the request that built it, exactly
  as the in-memory build did). The map is the SAME map the in-memory build
  gives: the same iteration, the same normalizer, the same "ambiguous" rule.

Nothing here reads a clock or the network. Python 3.9 — no ``X | Y``.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Mapping, Optional, Tuple

logger = logging.getLogger(__name__)

#: Bump when the sidecar's layout changes (not when the normalizer does —
#: the normalizer's own fingerprint covers that).
INDEX_VERSION = 1
#: A normalized name several registered companies carry.
AMBIGUOUS = -1

_BUILD_LOCK = threading.Lock()
#: sidecar path -> the open, current index (one read connection per file).
_OPEN = {}  # type: Dict[str, PersistedNameIndex]


def sidecar_path(registry_path: Any) -> Path:
    """Where the persisted index of the registry at ``registry_path`` lives."""
    p = Path(registry_path)
    return p.with_name("%s.names-v%d.sqlite" % (p.name, INDEX_VERSION))


def _read_only_uri(path: Path) -> str:
    return path.resolve().as_uri() + "?mode=ro"


class PersistedNameIndex(object):
    """A read-only sidecar: ``get(normalized_name)`` -> the one CUI
    registered under it, ``AMBIGUOUS``, or ``default`` (not registered)."""

    def __init__(self, path: Path, fingerprint: str) -> None:
        self.path = path
        self.fingerprint = fingerprint
        self._conn = sqlite3.connect(_read_only_uri(path), uri=True, check_same_thread=False)
        self._lock = threading.Lock()

    def get(self, norm: str, default: Optional[int] = None) -> Optional[int]:
        with self._lock:
            row = self._conn.execute("SELECT cui FROM names WHERE norm = ?", (norm,)).fetchone()
        return int(row[0]) if row else default

    def __len__(self) -> int:
        with self._lock:
            return int(self._conn.execute("SELECT COUNT(*) FROM names").fetchone()[0])


def build_name_map(names: Iterable[Tuple[Any, Any]], normalize: Callable[[Any], str]) -> Dict[str, int]:
    """normalized name -> the one CUI registered under it, or AMBIGUOUS when
    several are. Names that normalize to nothing are skipped."""
    index = {}  # type: Dict[str, int]
    for cui, raw in names:
        norm = normalize(raw)
        if not norm:
            continue
        cui = int(cui)
        prev = index.get(norm)
        index[norm] = cui if prev is None or prev == cui else AMBIGUOUS
    return index


def _recorded(path: Path) -> Dict[str, str]:
    """The sidecar's meta rows, or {} when it is absent or unreadable."""
    if not path.is_file():
        return {}
    try:
        con = sqlite3.connect(_read_only_uri(path), uri=True)
        try:
            return dict((str(k), str(v)) for k, v in con.execute("SELECT key, value FROM meta").fetchall())
        finally:
            con.close()
    except sqlite3.Error:
        return {}


def _write(path: Path, index: Mapping[str, int], fingerprint: str) -> None:
    """Write the sidecar beside a temporary name and move it into place in
    one step, so a reader never sees half a file."""
    tmp = path.with_name("%s.tmp-%d-%d" % (path.name, os.getpid(), threading.get_ident()))
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(str(tmp))
    try:
        con.execute("PRAGMA journal_mode=OFF")
        con.execute("PRAGMA synchronous=OFF")
        con.execute("CREATE TABLE names (norm TEXT PRIMARY KEY, cui INTEGER NOT NULL) WITHOUT ROWID")
        con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        con.executemany("INSERT INTO names(norm, cui) VALUES (?, ?)", sorted(index.items()))
        con.executemany("INSERT INTO meta(key, value) VALUES (?, ?)",
                        [("version", str(INDEX_VERSION)), ("fingerprint", fingerprint),
                         ("names", str(len(index)))])
        con.commit()
    finally:
        con.close()
    os.replace(str(tmp), str(path))


def registry_name_index(registry: Any, normalize: Callable[[Any], str],
                        normalizer_tag: str) -> Optional[Mapping[str, int]]:
    """The current map of ``registry``'s normalized names: the persisted
    sidecar when it is current; otherwise built (from
    ``registry.iter_company_names()`` through ``normalize``), persisted, and
    returned. None when the registry has no file or cannot fingerprint its
    names (a test double, another store) — the caller then builds in memory.

    A registry that changed while its map was being built answers that
    request with the map built, and persists nothing."""
    path = getattr(registry, "path", None)
    fingerprint_of = getattr(registry, "names_fingerprint", None)
    names = getattr(registry, "iter_company_names", None)
    if path is None or fingerprint_of is None or names is None:
        return None
    try:
        live = "%s|%s" % (fingerprint_of(), normalizer_tag)
    except Exception:  # noqa: BLE001 — a registry that cannot say is not indexed here
        logger.exception("[registry_names] names fingerprint unreadable")
        return None
    side = sidecar_path(path)
    key = str(side)
    cached = _OPEN.get(key)
    if cached is not None and cached.fingerprint == live:
        return cached
    with _BUILD_LOCK:
        cached = _OPEN.get(key)
        if cached is not None and cached.fingerprint == live:
            return cached
        recorded = _recorded(side)
        if recorded.get("version") != str(INDEX_VERSION) or recorded.get("fingerprint") != live:
            built = build_name_map(names(), normalize)
            try:
                still = "%s|%s" % (fingerprint_of(), normalizer_tag)
            except Exception:  # noqa: BLE001
                still = None
            if still != live:
                logger.info("[registry_names] the registry changed during the build — not persisted")
                return built
            try:
                _write(side, built, live)
            except (OSError, sqlite3.Error):
                logger.exception("[registry_names] the name index could not be written beside %s", path)
                return built
            logger.info("[registry_names] name index built: %d names -> %s", len(built), side)
        try:
            opened = PersistedNameIndex(side, live)
        except sqlite3.Error:
            logger.exception("[registry_names] the name index could not be opened")
            return None
        # A previously open index stays open for any reader holding it; it is
        # simply no longer handed out.
        _OPEN[key] = opened
        return opened
