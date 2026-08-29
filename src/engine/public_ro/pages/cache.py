"""Page cache — keyed by a digest of the inputs the page RENDERS.

Two tiers (PS3): an in-process LRU (bounded OrderedDict) in front of a
disk cache under data/public_pages/ (override: PUBLIC_RO_PAGES_DIR).

``page_cache_key`` is the ONE authority for what a cached page depends
on, and it takes the whole company row and the whole filings list rather
than a hand-picked list of columns. That shape is the fix for the bug
class this module kept reproducing: every earlier key named the columns
someone remembered at the time, so the next rendered field silently
outgrew it.

  - keyed on dataset_version alone, a percentile recompute (its own job,
    no dataset_id change) could never reach a cached page — 2026-08-28;
  - keyed on (cui, year, dataset_version, lang, percentiles_epoch), a
    `public_ingest.py ident` run — which calls set_identification and
    touches neither filings nor percentiles — moved nothing in the key,
    so a renamed company kept serving its OLD name and a
    <link rel="canonical"> built from the OLD slug, i.e. a canonical
    pointing at a URL that now 301-redirects. A public page must never
    state a fact the open data no longer supports.

Digesting the row means a companies column that nothing renders yet
(``sector_label`` is read by the page model and populated by no store
column today) is already in the key on the day it starts rendering.

The digest is hashlib, never ``hash()``: PYTHONHASHSEED varies per
process and the disk tier outlives the process that wrote it.

Key shape: (cui, year, dataset_version, lang, percentiles_epoch, digest).
dataset_version stays in it — redundant against the digest, but it keeps
the on-disk filename diagnosable for ops. Shorter tuples still address a
file (callers built before the epoch / the digest keep working).

A superseded key's file is never addressed again: stale files are inert
leftovers, not stale hits (a future ops sweep may prune them).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, List, Mapping, Optional, Sequence, Tuple

_ENV_PAGES_DIR = "PUBLIC_RO_PAGES_DIR"
_DEFAULT_PAGES_DIR = Path("data") / "public_pages"

# (cui, year, dataset_version, lang[, percentiles_epoch[, digest]])
Key = Tuple[Any, ...]

_DIGEST_CHARS = 16

# Company columns that are WRITE BOOKKEEPING, not render inputs.
# set_identification re-stamps updated_at on every row it touches,
# changed or not; keying on it would throw the whole storefront cache
# away on each annual ident run while producing byte-identical pages.
# ``provenance`` is the store's derived {name_source, updated_at} wrapper
# — name_source is digested under its own top-level key.
# Everything NOT listed here is in the key: a new column costs a cache
# miss at worst, while a forgotten one serves a wrong fact.
_NOT_RENDERED = frozenset(("updated_at", "provenance"))


def pages_dir(path: Optional[Path] = None) -> Path:
    if path is not None:
        return Path(path)
    override = os.environ.get(_ENV_PAGES_DIR)
    return Path(override) if override else _DEFAULT_PAGES_DIR


def _safe(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", s)[:80] or "0"


def inputs_digest(*parts: Any) -> str:
    """Short, process-stable digest of render inputs.

    Dict ORDER is preserved (no sort_keys): for some inputs the order is
    itself rendered — og.render_og_png draws its KPI rows in dict order —
    so canonicalising it away would serve one artefact for two layouts.
    Callers that know order is irrelevant (a row addressed by column
    name) normalise it themselves before calling; see _identity_inputs.

    ``default=str`` covers the sqlite scalars this data path carries
    (str/int/float/None/bytes). An exotic object whose repr embeds its
    address would make the digest unstable — a permanent cache MISS,
    never a stale hit, which is the direction this cache must fail in.
    """
    blob = json.dumps(parts, sort_keys=False, ensure_ascii=True,
                      separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:_DIGEST_CHARS]


def _identity_inputs(company: Mapping[str, Any]) -> List[Any]:
    """Every company field except write bookkeeping, key-sorted — the
    template addresses fields by name, so a schema column reorder must
    not invalidate the cache."""
    return [[k, company[k]] for k in sorted(company) if k not in _NOT_RENDERED]


def _filing_versions(filings: Sequence[Mapping[str, Any]]) -> List[Any]:
    """(year, dataset_id) per filing.

    Per FILING, not just the latest one: the page renders five-year trend
    blocks, so a restatement of an older year under a new dataset_id must
    move the key even though the latest year's dataset_id did not.
    """
    out: List[Any] = []
    for f in filings:
        prov = f.get("provenance") or {}
        dsv = prov.get("dataset_id")
        if dsv is None:
            dsv = f.get("dataset_id")
        out.append([int(f.get("year") or 0), str(dsv or "0")])
    out.sort()
    return out


def _latest_dataset_version(filings: Sequence[Mapping[str, Any]]) -> str:
    versions = _filing_versions(filings)
    return versions[-1][1] if versions else "0"


def page_cache_key(
    *,
    cui: int,
    year: int,
    lang: str,
    company: Mapping[str, Any],
    filings: Sequence[Mapping[str, Any]],
    percentiles_epoch: Any = "0",
) -> Key:
    """The cache key for one rendered company page.

    Takes the whole rows on purpose — see the module docstring. The
    percentile distributions are NOT passed (the router reads them only
    after a cache miss); ``percentiles_epoch`` stands in for them, and
    store.replace_percentiles bumps it inside the same transaction as the
    rows it replaces.
    """
    digest = inputs_digest(_identity_inputs(company),
                           _filing_versions(filings))
    return (int(cui), int(year), _latest_dataset_version(filings), str(lang),
            str(percentiles_epoch), digest)


class PageCache:
    def __init__(self, *, max_entries: int = 256,
                 directory: Optional[Path] = None) -> None:
        self._max = max(1, int(max_entries))
        self._dir = directory  # None -> resolve per call (env may change in tests)
        self._lru: "OrderedDict[Key, str]" = OrderedDict()
        self._lock = threading.Lock()

    def _path(self, key: Key) -> Path:
        cui, year, dsv, lang = key[:4]
        # Every component past the fourth lands in the filename, so the
        # key gaining one can never collide with the old key's file and
        # _path never needs editing again.
        extra = [_safe(str(part)) for part in key[4:]] or ["0"]
        return pages_dir(self._dir) / (
            "%d-%d-%s-%s-p%s.html"
            % (int(cui), int(year), _safe(str(dsv)), _safe(str(lang)),
               "-".join(extra)))

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
