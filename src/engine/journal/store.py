"""Content-addressed snapshot object store (filesystem, existing storage
conventions — locally the gitignored ``data/`` tree, in-container the
mounted ``/app/data`` volume; NO new datastore).

Layout:  ``<journal root>/objects/<sha256[:2]>/<sha256>``

Objects are canonical JSON bytes (see ``events.canonical_bytes``); the
filename IS the sha256 of the content, so the store deduplicates by
construction and a stored object can always be re-verified against its
own address.

Write discipline (the crash-safety ordering rule depends on it):
  * atomic — bytes land in a same-directory temp file, fsync, then
    ``os.replace`` onto the final name. A crash mid-write leaves only a
    temp file (swept by the collector), NEVER a half-written object
    under a valid address.
  * write-once — an existing address is never rewritten (identical
    content by construction).

An object that exists without a journal event referencing it is
invisible garbage — harmless, collectable via ``Journal.gc_orphans`` /
``journal_cli.py gc`` (list-only by default). The reverse (an event
without its object) is impossible by ordering: the journal writer
commits the object FIRST, then the event (see ``Journal.record_snapshot``
and tests/engine/test_crash_safety.py).
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Iterator, Union

from .events import hash_bytes


class SnapshotStore:
    def __init__(self, root: Union[str, Path]) -> None:
        self.root = Path(root)
        self.objects_dir = self.root / "objects"

    # ── writes ─────────────────────────────────────────────────────

    def write_object(self, data: bytes) -> str:
        """Store ``data`` content-addressed; returns its sha256 hex.
        Idempotent: an already-present address is left untouched."""
        digest = hash_bytes(data)
        path = self._path_for(digest)
        if path.is_file():
            return digest
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix=".tmp-%s-" % digest[:8], dir=str(path.parent)
        )
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_name, str(path))
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
        return digest

    # ── reads ──────────────────────────────────────────────────────

    def read_object(self, digest: str) -> bytes:
        path = self._path_for(digest)
        if not path.is_file():
            raise KeyError("snapshot object %s not in store %s" % (digest, self.root))
        data = path.read_bytes()
        if hash_bytes(data) != digest:
            raise ValueError(
                "snapshot object %s failed content re-verification" % digest
            )
        return data

    def has(self, digest: str) -> bool:
        return self._path_for(digest).is_file()

    def iter_digests(self) -> Iterator[str]:
        if not self.objects_dir.is_dir():
            return
        for shard in sorted(self.objects_dir.iterdir()):
            if not shard.is_dir():
                continue
            for obj in sorted(shard.iterdir()):
                name = obj.name
                if obj.is_file() and len(name) == 64 and not name.startswith("."):
                    yield name

    def iter_temp_files(self) -> Iterator[Path]:
        """Leftover atomic-write temp files (crash mid-object-write)."""
        if not self.objects_dir.is_dir():
            return
        for shard in sorted(self.objects_dir.iterdir()):
            if not shard.is_dir():
                continue
            for obj in sorted(shard.iterdir()):
                if obj.is_file() and obj.name.startswith(".tmp-"):
                    yield obj

    def delete_object(self, digest: str) -> bool:
        """Physical removal — reserved for the ORPHAN collector only
        (objects no journal event references). Never called on a
        referenced object; the journal itself is append-only forever."""
        path = self._path_for(digest)
        try:
            path.unlink()
            return True
        except OSError:
            return False

    # ── internals ──────────────────────────────────────────────────

    def _path_for(self, digest: str) -> Path:
        if not digest or len(digest) < 3:
            raise ValueError("invalid object digest %r" % (digest,))
        return self.objects_dir / digest[:2] / digest
