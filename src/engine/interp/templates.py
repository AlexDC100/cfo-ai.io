"""TemplateStore — fingerprint -> confirmed structural map (format learning loop).

One JSON file per layout fingerprint under ``data/format_templates/``
(runtime data — the top-level ``/data/`` gitignore already covers it;
``ENGINE_TEMPLATES_DIR`` overrides the location, mirroring the
``ENGINE_OBS_DIR`` idiom in engine.obs.sentinels).

Entry lifecycle::

    record_candidate(...)   status="candidate"   — NEVER served
        confirm(...) x N    confirmations accumulate (dedup by doc hash)
    promote(...)            status="confirmed"   — only after the bar:
                            >= N confirmations across >= M DISTINCT
                            company_keys, and only with an explicit
                            promoter identity
    lookup(...)             serves CONFIRMED entries only

Trust rules enforced here (E7), each with a test in
tests/engine/test_templates.py:

    * ``confirm`` refuses without an explicit confirmer identity, doc
      content hash, and company key — anonymous confirmations do not exist.
    * A duplicate ``doc_content_hash`` never double-counts: confirming the
      same document twice is one confirmation.
    * ``promotable`` / ``promote`` require >= N confirmations across
      >= M DISTINCT company keys — one enthusiastic company cannot promote
      a template on its own.
    * Candidates never serve: ``lookup`` returns None for them (and counts
      a miss).

Writes are atomic (tmp file + ``os.replace`` in the same directory).
Stats (hits / misses / interpreter_calls_saved) live in ``_stats.json``
inside the store directory — best-effort counters, not a ledger: the
read-modify-write is not cross-process locked; last writer wins.

No AI, no network. Jurisdiction-blind (N7): the structural maps stored
here are opaque dicts produced and validated by the interpreter/consensus
lanes; this module never inspects their semantics.
"""

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

__all__ = [
    "TemplateStoreError",
    "TemplateStore",
    "resolve_map",
    "TEMPLATES_DIR_ENV",
    "DEFAULT_N_CONFIRMATIONS",
    "DEFAULT_M_COMPANIES",
    "TEMPLATE_SCHEMA",
    "STATS_SCHEMA",
]

#: Env override for the store directory (mirrors ENGINE_OBS_DIR).
TEMPLATES_DIR_ENV = "ENGINE_TEMPLATES_DIR"

#: Default promotion bar: N confirmations across M distinct companies.
DEFAULT_N_CONFIRMATIONS = 3
DEFAULT_M_COMPANIES = 2

TEMPLATE_SCHEMA = "format_template_v1"
STATS_SCHEMA = "template_stats_v1"

STATUS_CANDIDATE = "candidate"
STATUS_CONFIRMED = "confirmed"

_STATS_FILENAME = "_stats.json"

#: Fingerprints are sha256 hex digests — anything else is refused, which
#: also makes path traversal through the fingerprint impossible.
_FINGERPRINT_RE = re.compile(r"^[0-9a-f]{64}$")


class TemplateStoreError(RuntimeError):
    """A refused operation or a corrupt store entry."""


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def default_templates_dir() -> Path:
    env = os.environ.get(TEMPLATES_DIR_ENV)
    if env:
        return Path(env)
    return _repo_root() / "data" / "format_templates"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require_nonempty_str(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TemplateStoreError(
            "%s is required and must be a non-empty string (got %r) — "
            "anonymous/blank values are refused by design" % (field, value)
        )
    return value.strip()


def _atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(
        payload, sort_keys=True, ensure_ascii=False, indent=2, allow_nan=False
    )
    fd, tmp_name = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        os.replace(tmp_name, str(path))
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


class TemplateStore:
    """Filesystem-backed store of layout templates, keyed by fingerprint."""

    def __init__(self, root: Optional[Any] = None) -> None:
        self.root = Path(root) if root is not None else default_templates_dir()

    # ── paths / io ────────────────────────────────────────────────────

    def _entry_path(self, fingerprint: str) -> Path:
        fp = _require_nonempty_str(fingerprint, "fingerprint")
        if not _FINGERPRINT_RE.match(fp):
            raise TemplateStoreError(
                "fingerprint must be a 64-char lowercase sha256 hex digest, "
                "got %r" % fingerprint
            )
        return self.root / ("%s.json" % fp)

    def _read_entry(self, fingerprint: str) -> Optional[Dict[str, Any]]:
        path = self._entry_path(fingerprint)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            raise TemplateStoreError(
                "template entry %s is unreadable: %s: %s"
                % (path, type(exc).__name__, exc)
            ) from exc
        if not isinstance(raw, dict) or raw.get("schema") != TEMPLATE_SCHEMA:
            raise TemplateStoreError(
                "template entry %s has an unexpected shape/schema" % path
            )
        return raw

    def _write_entry(self, entry: Dict[str, Any]) -> None:
        entry = dict(entry)
        entry["updated_at"] = _now_iso()
        _atomic_write_json(self._entry_path(entry["fingerprint"]), entry)

    # ── stats ─────────────────────────────────────────────────────────

    def _stats_path(self) -> Path:
        return self.root / _STATS_FILENAME

    def stats(self) -> Dict[str, Any]:
        try:
            raw = json.loads(self._stats_path().read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return {
                    "schema": STATS_SCHEMA,
                    "hits": int(raw.get("hits") or 0),
                    "misses": int(raw.get("misses") or 0),
                    "interpreter_calls_saved": int(
                        raw.get("interpreter_calls_saved") or 0
                    ),
                }
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError):
            pass  # corrupt counters reset — they are telemetry, not a ledger
        return {
            "schema": STATS_SCHEMA,
            "hits": 0,
            "misses": 0,
            "interpreter_calls_saved": 0,
        }

    def _bump_stats(self, *, hit: bool) -> None:
        stats = self.stats()
        if hit:
            stats["hits"] += 1
            stats["interpreter_calls_saved"] += 1
        else:
            stats["misses"] += 1
        _atomic_write_json(self._stats_path(), stats)

    # ── API ───────────────────────────────────────────────────────────

    def lookup(
        self, fingerprint: str, *, record_stats: bool = True
    ) -> Optional[Dict[str, Any]]:
        """Return the CONFIRMED structural map for a fingerprint, or None.

        Candidates NEVER serve — an unpromoted entry is a miss.
        """
        entry = self._read_entry(fingerprint)
        hit = bool(entry) and entry.get("status") == STATUS_CONFIRMED
        if record_stats:
            self._bump_stats(hit=hit)
        if not hit:
            return None
        return copy.deepcopy(entry["structural_map"])

    def get_entry(self, fingerprint: str) -> Optional[Dict[str, Any]]:
        """Full entry (any status) for inspection — never for serving."""
        entry = self._read_entry(fingerprint)
        return copy.deepcopy(entry) if entry else None

    def record_candidate(
        self,
        fingerprint: str,
        structural_map: Dict[str, Any],
        *,
        created_from: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Store a candidate template. Additive-only-when-absent.

        If an entry already exists (candidate OR confirmed) it is returned
        UNTOUCHED — a re-run may never clobber accumulated confirmations
        or a promoted map.
        """
        if not isinstance(structural_map, dict) or not structural_map:
            raise TemplateStoreError(
                "structural_map must be a non-empty dict (the full validated "
                "map), got %r" % type(structural_map).__name__
            )
        if not isinstance(created_from, dict):
            raise TemplateStoreError(
                "created_from must be a dict ({roles, prompt_versions, "
                "map_hash}), got %r" % type(created_from).__name__
            )
        existing = self._read_entry(fingerprint)
        if existing is not None:
            return copy.deepcopy(existing)
        entry: Dict[str, Any] = {
            "schema": TEMPLATE_SCHEMA,
            "fingerprint": _require_nonempty_str(fingerprint, "fingerprint"),
            "structural_map": copy.deepcopy(structural_map),
            "confirmations": [],
            "created_from": copy.deepcopy(created_from),
            "status": STATUS_CANDIDATE,
            "created_at": _now_iso(),
        }
        self._write_entry(entry)
        return copy.deepcopy(entry)

    def confirm(
        self,
        fingerprint: str,
        *,
        confirmed_by: str,
        doc_content_hash: str,
        company_key: str,
    ) -> Dict[str, Any]:
        """Record a human confirmation. Refuses anonymous/blank identity.

        Duplicate ``doc_content_hash`` values never double-count — the
        existing entry is returned unchanged.
        """
        confirmer = _require_nonempty_str(confirmed_by, "confirmed_by")
        doc_hash = _require_nonempty_str(doc_content_hash, "doc_content_hash")
        company = _require_nonempty_str(company_key, "company_key")
        entry = self._read_entry(fingerprint)
        if entry is None:
            raise TemplateStoreError(
                "cannot confirm unknown template %r — record_candidate first"
                % fingerprint
            )
        existing_hashes = {
            c.get("doc_content_hash") for c in entry.get("confirmations", [])
        }
        if doc_hash in existing_hashes:
            return copy.deepcopy(entry)
        entry.setdefault("confirmations", []).append(
            {
                "confirmed_by": confirmer,
                "confirmed_at": _now_iso(),
                "doc_content_hash": doc_hash,
                "company_key": company,
            }
        )
        self._write_entry(entry)
        return copy.deepcopy(entry)

    # ── promotion ─────────────────────────────────────────────────────

    @staticmethod
    def _meets_bar(
        entry: Dict[str, Any], n_confirm: int, m_companies: int
    ) -> bool:
        confirmations = entry.get("confirmations") or []
        companies = {
            c.get("company_key")
            for c in confirmations
            if c.get("company_key")
        }
        return len(confirmations) >= n_confirm and len(companies) >= m_companies

    def promotable(
        self,
        n_confirm: int = DEFAULT_N_CONFIRMATIONS,
        m_companies: int = DEFAULT_M_COMPANIES,
    ) -> List[Dict[str, Any]]:
        """Candidates meeting the promotion bar (sorted by fingerprint)."""
        if n_confirm < 1 or m_companies < 1:
            raise TemplateStoreError(
                "promotion bar must be at least 1 confirmation and 1 company "
                "(got n_confirm=%r, m_companies=%r)" % (n_confirm, m_companies)
            )
        out: List[Dict[str, Any]] = []
        for entry in self.entries():
            if entry.get("status") != STATUS_CANDIDATE:
                continue
            if self._meets_bar(entry, n_confirm, m_companies):
                out.append(entry)
        return out

    def promote(
        self,
        fingerprint: str,
        *,
        promoted_by: str,
        n_confirm: int = DEFAULT_N_CONFIRMATIONS,
        m_companies: int = DEFAULT_M_COMPANIES,
    ) -> Dict[str, Any]:
        """Flip candidate -> confirmed. Refuses below the bar or anonymously."""
        promoter = _require_nonempty_str(promoted_by, "promoted_by")
        if n_confirm < 1 or m_companies < 1:
            raise TemplateStoreError(
                "promotion bar must be at least 1 confirmation and 1 company "
                "(got n_confirm=%r, m_companies=%r)" % (n_confirm, m_companies)
            )
        entry = self._read_entry(fingerprint)
        if entry is None:
            raise TemplateStoreError(
                "cannot promote unknown template %r" % fingerprint
            )
        if entry.get("status") == STATUS_CONFIRMED:
            return copy.deepcopy(entry)
        if not self._meets_bar(entry, n_confirm, m_companies):
            confirmations = entry.get("confirmations") or []
            companies = {
                c.get("company_key")
                for c in confirmations
                if c.get("company_key")
            }
            raise TemplateStoreError(
                "template %s does not meet the promotion bar: "
                "%d confirmation(s) across %d distinct company key(s); "
                "required >= %d across >= %d"
                % (
                    fingerprint,
                    len(confirmations),
                    len(companies),
                    n_confirm,
                    m_companies,
                )
            )
        entry["status"] = STATUS_CONFIRMED
        entry["promoted_by"] = promoter
        entry["promoted_at"] = _now_iso()
        self._write_entry(entry)
        return copy.deepcopy(entry)

    # ── enumeration ───────────────────────────────────────────────────

    def entries(self) -> List[Dict[str, Any]]:
        """All entries, sorted by fingerprint. Missing dir -> []."""
        if not self.root.is_dir():
            return []
        out: List[Dict[str, Any]] = []
        for path in sorted(self.root.glob("*.json")):
            if path.name == _STATS_FILENAME:
                continue
            stem = path.stem
            if not _FINGERPRINT_RE.match(stem):
                continue
            entry = self._read_entry(stem)
            if entry is not None:
                out.append(entry)
        return out


def resolve_map(
    store: TemplateStore,
    fingerprint: str,
    fallback: Callable[[], Dict[str, Any]],
) -> Tuple[Dict[str, Any], str]:
    """The no-AI-call-on-hit seam for the extraction lane.

    Template hit  -> (stored confirmed map, "template_hit"); ``fallback``
    is NEVER invoked — no interpreter, no AI call.
    Template miss -> (fallback(), "template_miss"); the caller's fallback
    runs the dual-map interpreter path and should then
    ``store.record_candidate(...)`` its validated map.

    NOTE for the caller (the consensus lane): a template hit does NOT skip
    the totals-leg check — mechanical extraction from a stored map must
    still reconcile against the file's own totals row.
    """
    served = store.lookup(fingerprint)
    if served is not None:
        return served, "template_hit"
    return fallback(), "template_miss"
