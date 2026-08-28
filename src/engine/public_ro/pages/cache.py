"""Page cache — pure function of
(cui, year, dataset_version, lang, percentiles_epoch).

Two tiers (PS3): an in-process LRU (bounded OrderedDict) in front of a
disk cache under data/public_pages/ (override: PUBLIC_RO_PAGES_DIR).
The key embeds dataset_version, so a re-ingest naturally invalidates by
changing the key; stale files for old versions are inert leftovers (a
future ops sweep may prune them — they are never served).

percentiles_epoch joined the key on 2026-08-28. A page renders SECTOR
percentile bars sourced from a job that reruns independently of any
filing, so its output changes with no dataset_id change: keyed on
dataset_version alone, recomputed percentiles could never reach an
already-cached page. The epoch is optional in the tuple so callers
(and tests) built before it still work — those key on "0".
"""
from __future__ import annotations

import os
import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Optional, Tuple

_ENV_PAGES_DIR = "PUBLIC_RO_PAGES_DIR"
_DEFAULT_PAGES_DIR = Path("data") / "public_pages"

# (cui, year, dataset_version, lang[, percentiles_epoch])
Key = Tuple[Any, ...]


def pages_dir(path: Optional[Path] = None) -> Path:
    if path is not None:
        return Path(path)
    override = os.environ.get(_ENV_PAGES_DIR)
    return Path(override) if override else _DEFAULT_PAGES_DIR


def _safe(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", s)[:80] or "0"


class PageCache:
    def __init__(self, *, max_entries: int = 256,
                 directory: Optional[Path] = None) -> None:
        self._max = max(1, int(max_entries))
        self._dir = directory  # None -> resolve per call (env may change in tests)
        self._lru: "OrderedDict[Key, str]" = OrderedDict()
        self._lock = threading.Lock()

    def _path(self, key: Key) -> Path:
        cui, year, dsv, lang = key[:4]
        epoch = str(key[4]) if len(key) > 4 else "0"
        return pages_dir(self._dir) / (
            "%d-%d-%s-%s-p%s.html"
            % (int(cui), int(year), _safe(dsv), lang, _safe(epoch)))

    def get(self, key: Key) -> Optional[str]:
        with self._lock:
            html = self._lru.get(key)
            if html is not None:
                self._lru.move_to_end(key)
                return html
        try:
            html = self._path(key).read_text(encoding="utf-8")
        except OSError:
            return None
        with self._lock:
            self._lru[key] = html
            self._lru.move_to_end(key)
            while len(self._lru) > self._max:
                self._lru.popitem(last=False)
        return html

    def put(self, key: Key, html: str) -> None:
        with self._lock:
            self._lru[key] = html
            self._lru.move_to_end(key)
            while len(self._lru) > self._max:
                self._lru.popitem(last=False)
        path = self._path(key)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(".tmp-" + path.name)
            tmp.write_text(html, encoding="utf-8")
            os.replace(tmp, path)
        except OSError:  # pragma: no cover — disk tier is best-effort
            pass

    def clear(self) -> None:
        with self._lock:
            self._lru.clear()
