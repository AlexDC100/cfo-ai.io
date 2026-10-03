"""The journal's chain key, and the on-disk layout that carries it.

THE KEY. A chain is identified by ``ChainKey(org_id, file_hash)`` — the
organisation that owns the document AND the document's content hash.
Never the content hash alone, never a period id, never a file name.

Until 2026-10-02 the key was the content hash alone
(``index/<file_hash>.jsonl``). Two organisations uploading byte-identical
documents therefore shared ONE chain: the second organisation's run named
the first's as its predecessor, each was answered the other's envelope by
the as-of route, a byte-identical analysis was swallowed as a "duplicate"
of the other organisation's, one's success filed the other's dead letter
as resolved, and one's page view recorded a new era on the other's
chain. The journal was never enabled in production (``ENGINE_JOURNAL_DIR``
unset), so none of that ever happened to a real tenant; it is measured on
the unchanged code in ``docs/engine_book/gates.md`` § journal-chain-key.

THE LAYOUT (version 2):

    LAYOUT.json                              the marker (written before
                                             anything else, by the code
                                             that owns this key)
    index/<org_id>/<file_hash>.jsonl         one chain per (org, document)
    runs/<run_id>.jsonl                      unchanged (run ids are random;
                                             a run is reached through its
                                             chain's index, and its
                                             RUN_STARTED names its org)
    objects/<sha[:2]>/<sha>                  unchanged (content-addressed)
    dlq/<run_id>.json                        unchanged path; entries name
                                             their org

Version 1 was ``index/<file_hash>.jsonl`` and no marker. A root holding a
version-1 index file, or holding any journal content with no marker, was
written under the retired key and is REFUSED — by ``Journal(root)``, and
at boot by ``engine.boot_verify.verify_journal_layout``. It is never
adopted, re-keyed or read: a version-1 chain interleaves organisations
inside one hash chain, and re-keying it would mean rewriting committed,
hash-bound events — the one thing this journal never does.

MIGRATION NOTE (no production journal exists; this is for local
directories only — ``<repo>/data/journal`` or wherever a developer
pointed ``ENGINE_JOURNAL_DIR``):

    python scripts/journal_cli.py --journal-root <dir> layout

prints the verdict. A ``legacy`` root is moved aside as a unit
(``mv data/journal data/journal.v1-content-hash-key``) or deleted, and
the next run starts a fresh version-2 root. There is no in-place
upgrade, by design. History recorded under the old key stays readable
only by the code that wrote it (any commit before this one) and is
otherwise honestly absent — the as-of route answers 404 for it, exactly
as it does for every period analysed before the journal existed.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Union

#: The layout this code reads and writes.
LAYOUT_VERSION = 2
#: The fields of the chain key, in order — recorded in the marker so a
#: root says what it is keyed by, not merely which version wrote it.
CHAIN_KEY_FIELDS = ("org_id", "file_hash")
LAYOUT_FILE = "LAYOUT.json"

#: The scope of runs that belong to no customer organisation (the public
#: open-data ingest). The leading underscore keeps it outside the space
#: an organisation id can occupy (``org_component``).
PLATFORM_ORG = "_platform"

#: An organisation id as a directory name. Lower-case only, so two ids
#: can never meet on a case-insensitive filesystem; no leading dot or
#: underscore (reserved); nothing ``sanitize_key`` would have to rewrite —
#: an id is used verbatim or refused, never mapped, so two different ids
#: can never share a directory.
_ORG_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")

_CONTENT_DIRS = ("runs", "index", "dlq", "objects")


class JournalLayoutError(RuntimeError):
    """The journal root was not written under the (org_id, file_hash)
    chain key. Never caught-and-continued: the root is not used."""


class ChainKey(NamedTuple):
    """The identity of one journal chain. Both halves, always."""

    org_id: str
    file_hash: str

    def label(self) -> str:
        return "%s/%s" % (self.org_id, self.file_hash)


def org_component(org_id: Any) -> str:
    """``org_id`` as the directory that holds its chains — or ValueError.

    Refuses rather than repairs: an empty, missing or unsafe id has no
    chain. There is no shared fallback chain for "organisation unknown".
    """
    if isinstance(org_id, str) and (org_id == PLATFORM_ORG or _ORG_ID.match(org_id)):
        return org_id
    raise ValueError(
        "journal chain needs an organisation id (lower-case letters, "
        "digits, '.', '_' or '-'; at most 128 characters); got %r" % (org_id,)
    )


def tenant_org(org_id: Any) -> str:
    """An organisation id taken from a DATABASE ROW (documents.org_id, the
    served period's org_id) — or ValueError. The platform scope is not a
    tenant: a row can never name it."""
    if org_id == PLATFORM_ORG:
        raise ValueError(
            "%r is the platform scope, not an organisation — a document or "
            "period row cannot chain under it" % (org_id,)
        )
    return org_component(org_id)


def chain_key(org_id: Any, file_hash: Any) -> ChainKey:
    """Build a validated ChainKey. Both halves are required."""
    if not isinstance(file_hash, str) or not file_hash:
        raise ValueError("journal chain needs a document content hash; got %r" % (file_hash,))
    return ChainKey(org_component(org_id), file_hash)


def require_chain(chain: Any) -> ChainKey:
    """Every chain read and write goes through this. A bare string — the
    retired key — is a TypeError, not a lookup."""
    if not isinstance(chain, ChainKey):
        raise TypeError(
            "journal chains are keyed by ChainKey(org_id, file_hash); got %r. "
            "A content hash (or a period id, or a file name) alone is the "
            "retired key." % (chain,)
        )
    org_component(chain.org_id)
    if not isinstance(chain.file_hash, str) or not chain.file_hash:
        raise ValueError("journal chain needs a document content hash; got %r" % (chain.file_hash,))
    return chain


def _expected_marker() -> Dict[str, Any]:
    return {"layout_version": LAYOUT_VERSION, "chain_key": list(CHAIN_KEY_FIELDS)}


def _has_file(directory: Path) -> bool:
    if not directory.is_dir():
        return False
    for _dirpath, _dirnames, filenames in os.walk(str(directory)):
        if filenames:
            return True
    return False


def inspect_layout(root: Union[str, Path]) -> Dict[str, Any]:
    """Read-only verdict on a journal root. Writes nothing, creates
    nothing.

    ``state`` is one of:
      absent   the directory does not exist
      empty    it exists and holds no journal content and no marker
      current  marker present and equal to this code's, no version-1
               index file
      legacy   written under the retired content-hash key: a version-1
               index file (``index/<file_hash>.jsonl``) is present, or
               there is journal content and no marker (the old code
               never wrote one)
      unknown  a marker this code does not recognise (another layout
               version, or unreadable)

    Only ``absent``, ``empty`` and ``current`` are usable.
    """
    root = Path(root)
    report: Dict[str, Any] = {
        "root": str(root),
        "state": "absent",
        "usable": True,
        "layout_version": None,
        "reasons": [],
    }
    if not root.exists():
        return report
    if not root.is_dir():
        report.update(state="unknown", usable=False)
        report["reasons"].append("%s is not a directory" % root)
        return report

    marker: Optional[Any] = None
    marker_unreadable = False
    marker_path = root / LAYOUT_FILE
    if marker_path.is_file():
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            marker_unreadable = True
        if isinstance(marker, dict):
            report["layout_version"] = marker.get("layout_version")

    index_dir = root / "index"
    flat: List[str] = (
        sorted(p.name for p in index_dir.glob("*.jsonl") if p.is_file())
        if index_dir.is_dir()
        else []
    )
    content = [name for name in _CONTENT_DIRS if _has_file(root / name)]

    if flat:
        report.update(state="legacy", usable=False)
        report["reasons"].append(
            "%d chain(s) keyed by content hash alone: index/%s%s"
            % (len(flat), flat[0], " …" if len(flat) > 1 else "")
        )
        return report
    if marker is None and not marker_unreadable:
        if content:
            report.update(state="legacy", usable=False)
            report["reasons"].append(
                "journal content under %s/ and no %s — the code that keys "
                "chains by (org_id, file_hash) writes the marker before "
                "anything else" % ("/, ".join(content), LAYOUT_FILE)
            )
        else:
            report["state"] = "empty"
        return report
    if marker_unreadable or marker != _expected_marker():
        report.update(state="unknown", usable=False)
        report["reasons"].append(
            "%s does not say layout_version %d keyed by %s (found %s)"
            % (
                LAYOUT_FILE,
                LAYOUT_VERSION,
                "+".join(CHAIN_KEY_FIELDS),
                "unreadable" if marker_unreadable else json.dumps(marker, sort_keys=True),
            )
        )
        return report
    report["state"] = "current"
    return report


def refusal_text(report: Dict[str, Any]) -> str:
    return (
        "the run journal at %s was not written under the (org_id, "
        "file_hash) chain key [%s: %s]. It is not used. Move the directory "
        "aside (or delete it) and start a fresh one — there is no in-place "
        "upgrade; see engine/journal/layout.py, MIGRATION NOTE."
        % (report["root"], report["state"], "; ".join(report["reasons"]) or "no detail")
    )


def assert_usable(root: Union[str, Path]) -> Dict[str, Any]:
    """Raise JournalLayoutError unless the root is absent, empty or
    current. Read-only."""
    report = inspect_layout(root)
    if not report["usable"]:
        raise JournalLayoutError(refusal_text(report))
    return report


def adopt(root: Union[str, Path]) -> None:
    """Refuse a root written under another key; otherwise make sure the
    marker is on disk BEFORE the caller writes anything else. The marker's
    bytes are fixed, so two processes adopting one fresh root write the
    same file."""
    root = Path(root)
    report = assert_usable(root)
    if report["state"] == "current":
        return
    root.mkdir(parents=True, exist_ok=True)
    data = json.dumps(_expected_marker(), sort_keys=True).encode("utf-8") + b"\n"
    fd, tmp = tempfile.mkstemp(prefix=".layout-", dir=str(root))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, str(root / LAYOUT_FILE))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
