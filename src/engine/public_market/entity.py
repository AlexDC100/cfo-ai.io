# -*- coding: utf-8 -*-
"""Entity resolution for the public_market spine — one canonical
entity per company, across sources (EDGAR, GLEIF, ESEF, exchange
feeds, …).

Laws this module enforces
-------------------------
* **Deterministic keys FIRST.** ISIN / LEI / CIK exact-match linking
  is the ONLY auto-link authority. ``entity_id`` is minted as a
  stable hash of the first deterministic key seen (idempotent across
  runs and machines, so re-ingest never re-mints).
* **Name matching never links.** The deterministic normalizer
  (legal-suffix stripping, diacritics, casing) only *finds
  candidates*; the pluggable ``ai_matcher`` hook — shipped DARK as a
  stub returning ``None`` — only *scores* them. Below the 0.9 gate
  the record is UNLINKED and queued; above the gate WITHOUT a
  deterministic key the auto-link is still blocked and the suggestion
  is queued for human review (PM6). This is PM1's "AI is never
  numeric-authoritative" applied to identity: AI is never
  LINK-authoritative.
* **Merge safety.** External ids ({source: id}) and entity history
  are append-only. Any conflict — a key straddling two entities, a
  second CIK claim on the same ISIN, a same-source external-id
  mismatch — refuses the WHOLE record: typed CONFLICT status, a
  review-queue entry, zero mutation. Nothing is ever guessed and
  history is never rewritten. (Merging two entities that review
  later proves identical is a future *reviewed* operation — there is
  deliberately no automatic merge path here.)
* **Fail closed / ABSENT != ZERO.** Malformed keys and incomplete
  provenance are typed refusals raised BEFORE any write. An absent
  AI confidence is recorded as ``None`` (JSON ``null``), never 0.0.
  An all-zero CIK normalizes to nothing and is refused, not treated
  as CIK zero.

Review queue
------------
The queue is this lane's own JSONL file (append-only, one
sorted-keys JSON object per line) at the ``review_queue_path`` the
caller provides — deliberately NOT a spine-store table: the
public_market store lane owns that schema and can ingest this JSONL
verbatim later (each line already carries the full record, its
provenance, the candidates and the AI annotation). With
``review_queue_path=None`` entries still accumulate on
``registry.review_queue`` (in-memory mirror) so embedded/test use
never loses a refusal.

Cross-lane note: the adapter lanes' ``_refusal.Refusal`` is a typed
"no" VALUE for feed reads; this module's typed EXCEPTIONS refuse
malformed input records and its ``ResolutionStatus`` types the
outcome. Same house law, different axis — flagged (both sides) as a
merge point if the spine later unifies refusal types.

Python 3.9 module: stdlib only, no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

__all__ = [
    "AI_CONFIDENCE_GATE",
    "DETERMINISTIC_KEY_PRECEDENCE",
    "REASON_AI_ABOVE_GATE_BLOCKED",
    "REASON_AI_BELOW_GATE",
    "REASON_EXTERNAL_ID_CONFLICT",
    "REASON_KEY_STRADDLE",
    "REASON_KEY_VALUE_CONFLICT",
    "REASON_NAME_MATCH_REQUIRES_REVIEW",
    "REASON_NO_DETERMINISTIC_KEY",
    "AiMatch",
    "AutoLinkBlockedError",
    "Entity",
    "EntityRegistry",
    "EntityResolutionError",
    "MalformedKeyError",
    "MalformedProvenanceError",
    "NameCandidate",
    "Provenance",
    "ResolutionResult",
    "ResolutionStatus",
    "SourceRecord",
    "ai_matcher_stub",
    "mint_entity_id",
    "normalize_cik",
    "normalize_isin",
    "normalize_lei",
    "normalize_name",
]

# ── constants ───────────────────────────────────────────────────────

#: Minting precedence — "the first deterministic key seen" on a
#: creating record is the first of these that is present. Fixed order
#: so the minted id never depends on dict/field iteration order.
DETERMINISTIC_KEY_PRECEDENCE = ("isin", "lei", "cik")

#: PM6 confidence gate. At or above it a name suggestion is *strong*,
#: but still never auto-links without a deterministic key.
AI_CONFIDENCE_GATE = 0.9

REASON_NO_DETERMINISTIC_KEY = "no_deterministic_key"
REASON_NAME_MATCH_REQUIRES_REVIEW = "name_match_requires_review"
REASON_AI_BELOW_GATE = "ai_confidence_below_gate"
REASON_AI_ABOVE_GATE_BLOCKED = "autolink_blocked_no_deterministic_key"
REASON_KEY_STRADDLE = "deterministic_key_straddle"
REASON_KEY_VALUE_CONFLICT = "deterministic_key_value_conflict"
REASON_EXTERNAL_ID_CONFLICT = "external_id_conflict"


# ── typed refusals ──────────────────────────────────────────────────


class EntityResolutionError(Exception):
    """Base for every typed refusal this module raises."""


class MalformedKeyError(EntityResolutionError):
    """A supplied deterministic key fails its format/checksum rules.

    Raised BEFORE any registry write — a record carrying a corrupt
    key is refused whole, never partially ingested. Absent keys are
    fine (ABSENT != ZERO); present-but-invalid is a data defect the
    caller must fix upstream.
    """

    def __init__(self, kind: str, value: Any, why: str) -> None:
        self.kind = kind
        self.value = value
        self.why = why
        super().__init__("malformed %s %r: %s" % (kind, value, why))


class MalformedProvenanceError(EntityResolutionError):
    """Provenance is mandatory and complete or the record is refused.

    Every registration must carry {source, as_of, fetched_at} plus at
    least one of {accession, dataset_version} — the same provenance
    contract every public_market figure carries.
    """


class AutoLinkBlockedError(EntityResolutionError):
    """PM6 structural ban: name evidence can never auto-link.

    Raised by :meth:`EntityRegistry.autolink_by_name` unconditionally.
    The method exists precisely so a future AI layer has a typed wall
    to hit instead of a soft convention to forget.
    """


# ── value types ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class Provenance:
    """Where a registration came from. Required on every record."""

    source: str
    as_of: str          # ISO date the data speaks for
    fetched_at: str     # ISO datetime the bytes were pulled
    accession: Optional[str] = None       # e.g. an EDGAR accession no.
    dataset_version: Optional[str] = None  # e.g. a bulk-file version tag

    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "as_of": self.as_of,
            "fetched_at": self.fetched_at,
            "accession": self.accession,
            "dataset_version": self.dataset_version,
        }


@dataclass(frozen=True)
class SourceRecord:
    """One source's claim about one company."""

    source: str
    source_entity_id: str
    provenance: Optional[Provenance]
    name: Optional[str] = None
    isin: Optional[str] = None
    lei: Optional[str] = None
    cik: Optional[str] = None


@dataclass(frozen=True)
class NameCandidate:
    """A deterministically-found candidate handed to the ai_matcher."""

    entity_id: str
    normalized_name: str


@dataclass(frozen=True)
class AiMatch:
    """What an ai_matcher returns when it has an opinion."""

    entity_id: str
    confidence: float


class ResolutionStatus(Enum):
    CREATED = "created"
    LINKED = "linked"
    UNLINKED = "unlinked"
    CONFLICT = "conflict"


@dataclass(frozen=True)
class ResolutionResult:
    """Typed outcome of one resolve() call.

    ``entity_id`` is set ONLY for CREATED/LINKED — an UNLINKED or
    CONFLICT record never claims an entity (the queue entry carries
    the suggestion/conflict detail instead).
    """

    status: ResolutionStatus
    entity_id: Optional[str] = None
    reason: Optional[str] = None
    queue_entry: Optional[Dict[str, Any]] = None

    @property
    def queued(self) -> bool:
        return self.queue_entry is not None


class Entity(object):
    """One canonical company. All mutation goes through the registry
    and is append-only; the public accessors hand out copies so a
    caller can never mutate registry state behind its back."""

    def __init__(self, entity_id: str) -> None:
        self.entity_id = entity_id
        self._isins: List[str] = []
        self._lei: Optional[str] = None
        self._cik: Optional[str] = None
        self._external_ids: List[Tuple[str, str]] = []  # append-only log
        self._names: List[str] = []        # raw, order of first sight
        self._norm_names: List[str] = []   # parallel normalized forms
        self._history: List[Dict[str, Any]] = []

    # -- read surface (copies only) ---------------------------------
    @property
    def isins(self) -> Tuple[str, ...]:
        return tuple(self._isins)

    @property
    def lei(self) -> Optional[str]:
        return self._lei

    @property
    def cik(self) -> Optional[str]:
        return self._cik

    @property
    def external_ids(self) -> Dict[str, str]:
        """{source: id} — first claim per source wins forever; a later
        different claim is a CONFLICT, never an overwrite."""
        out: Dict[str, str] = {}
        for source, ext_id in self._external_ids:
            out.setdefault(source, ext_id)
        return out

    @property
    def display_name(self) -> Optional[str]:
        return self._names[0] if self._names else None

    @property
    def name_observations(self) -> Tuple[str, ...]:
        return tuple(self._names)

    @property
    def normalized_names(self) -> Tuple[str, ...]:
        return tuple(self._norm_names)

    @property
    def history(self) -> List[Dict[str, Any]]:
        # Deep copies: history is append-only INSIDE the registry and
        # unreachable for mutation from outside it.
        return copy.deepcopy(self._history)


# ── deterministic key normalizers (fail closed) ─────────────────────

_ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")
_LEI_RE = re.compile(r"^[A-Z0-9]{18}[0-9]{2}$")


def normalize_isin(value: Any) -> str:
    """Validate + canonicalize an ISIN (ISO 6166): 2-letter prefix,
    9 alphanumerics, Luhn check digit over the base-36 expansion."""
    if not isinstance(value, str) or not value.strip():
        raise MalformedKeyError("isin", value, "absent or not a string")
    isin = value.strip().upper()
    if not _ISIN_RE.match(isin):
        raise MalformedKeyError("isin", value, "must be 2 letters + 9 alnum + digit")
    digits = "".join(str(int(ch, 36)) for ch in isin)
    total = 0
    for idx, ch in enumerate(reversed(digits)):
        d = int(ch)
        if idx % 2 == 1:  # double every second digit from the right
            d *= 2
            if d > 9:
                d -= 9
        total += d
    if total % 10 != 0:
        raise MalformedKeyError("isin", value, "check digit failed (Luhn)")
    return isin


def normalize_lei(value: Any) -> str:
    """Validate + canonicalize an LEI (ISO 17442): 20 chars, ISO 7064
    mod 97-10 over the base-36 expansion must equal 1."""
    if not isinstance(value, str) or not value.strip():
        raise MalformedKeyError("lei", value, "absent or not a string")
    lei = value.strip().upper()
    if not _LEI_RE.match(lei):
        raise MalformedKeyError("lei", value, "must be 18 alnum + 2 check digits")
    if int("".join(str(int(ch, 36)) for ch in lei)) % 97 != 1:
        raise MalformedKeyError("lei", value, "checksum failed (ISO 7064 mod 97-10)")
    return lei


def normalize_cik(value: Any) -> str:
    """Validate + canonicalize an SEC CIK: digits only, at most 10;
    canonical form drops the zero padding EDGAR sometimes presents.
    An all-zero CIK normalizes to nothing and is refused —
    ABSENT != ZERO, and CIK 0 does not exist."""
    if not isinstance(value, str) or not value.strip():
        raise MalformedKeyError("cik", value, "absent or not a string")
    cik = value.strip()
    if not cik.isdigit():
        raise MalformedKeyError("cik", value, "must be digits only")
    if len(cik) > 10:
        raise MalformedKeyError("cik", value, "longer than 10 digits")
    canonical = cik.lstrip("0")
    if not canonical:
        raise MalformedKeyError("cik", value, "all-zero CIK is no CIK")
    return canonical


_KEY_NORMALIZERS = {
    "isin": normalize_isin,
    "lei": normalize_lei,
    "cik": normalize_cik,
}


# ── deterministic name normalizer ───────────────────────────────────

#: Legal-form tails stripped (repeatedly) from the END of a name.
#: Single tokens only — after punctuation collapse, "S.R.L." is "srl",
#: "sp. z o.o." is "sp z o o" (its tokens are each in the set).
_LEGAL_SUFFIX_TOKENS = frozenset(
    (
        "inc", "incorporated", "corp", "corporation", "co", "company",
        "ltd", "limited", "llc", "llp", "lp", "plc", "pcl",
        "sa", "se", "nv", "bv", "ag", "gmbh", "kgaa", "spa", "srl",
        "sarl", "sas", "ab", "asa", "as", "oyj", "oy", "aps",
        "ad", "jsc", "pjsc", "psc", "bhd", "tbk", "kk", "dd", "doo",
        "zrt", "nyrt", "rt", "sp", "z", "o", "oo",
    )
)

_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
#: Single letters chained by "." or "/" ("s.r.l.", "s.a.", "a/s")
#: collapse to one token ("srl", "sa", "as") BEFORE punctuation
#: becomes spaces — otherwise the suffix set would need every single
#: letter, which would eat real name endings.
_LETTER_RUN_RE = re.compile(r"\b[a-z](?:[./][a-z])+\.?")
#: Letters NFKD does NOT decompose (they are letters of their own,
#: not letter+diacritic) — dropped they would maim Nordic/Slavic
#: names, so they transliterate explicitly. casefold() upstream means
#: only lowercase forms reach this table.
_NFKD_RESISTANT = {
    "ø": "o",   # ø
    "ł": "l",   # ł
    "đ": "d",   # đ
    "æ": "ae",  # æ
    "œ": "oe",  # œ
    "þ": "th",  # þ
    "ð": "d",   # ð
}


def normalize_name(name: str) -> str:
    """Deterministic company-name normalizer: NFKD-strip diacritics,
    casefold, map ``&`` to ``and``, collapse punctuation to spaces,
    then strip trailing legal-form tokens. Never strips a name down
    to nothing — a company literally named a legal-form word keeps
    that word."""
    if not isinstance(name, str):
        raise MalformedKeyError("name", name, "not a string")
    decomposed = unicodedata.normalize("NFKD", name)
    ascii_only = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    lowered = ascii_only.casefold().replace("&", " and ")
    lowered = "".join(_NFKD_RESISTANT.get(ch, ch) for ch in lowered)
    lowered = _LETTER_RUN_RE.sub(
        lambda m: re.sub(r"[./]", "", m.group(0)) + " ", lowered
    )
    spaced = _NON_ALNUM_RE.sub(" ", lowered).strip()
    tokens = spaced.split()
    while len(tokens) > 1 and tokens[-1] in _LEGAL_SUFFIX_TOKENS:
        tokens.pop()
    return " ".join(tokens)


# ── entity_id minting ───────────────────────────────────────────────


def mint_entity_id(kind: str, normalized_value: str) -> str:
    """Stable id from the first deterministic key seen. Pure hash of
    (kind, canonical value): the same key mints the same id on every
    run and every machine, so re-ingesting a source is idempotent and
    two stores built independently agree on ids."""
    if kind not in DETERMINISTIC_KEY_PRECEDENCE:
        raise MalformedKeyError(kind, normalized_value, "not a deterministic key kind")
    digest = hashlib.sha256(
        ("%s:%s" % (kind, normalized_value)).encode("utf-8")
    ).hexdigest()
    return "pme-" + digest[:16]


# ── AI hook (dark-ready) ────────────────────────────────────────────

AiMatcher = Callable[[str, Tuple[NameCandidate, ...]], Optional[AiMatch]]


def ai_matcher_stub(
    normalized_name: str, candidates: Tuple[NameCandidate, ...]
) -> Optional[AiMatch]:
    """The shipped default: the AI layer is DARK. Returning ``None``
    means "no opinion" — the record queues for review with
    ``ai_confidence: null`` (absent, never 0.0). The AI lane activates
    this hook by passing a real matcher to :class:`EntityRegistry`;
    nothing else in this module changes when it does."""
    return None


# ── the registry ────────────────────────────────────────────────────


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class EntityRegistry(object):
    """In-memory entity spine with an append-only JSONL review queue.

    Parameters
    ----------
    review_queue_path:
        Where UNLINKED/CONFLICT records are durably queued (JSONL,
        append-only, sorted keys). ``None`` keeps the queue in memory
        only (``self.review_queue`` mirrors the log either way).
    ai_matcher:
        The pluggable name-match hook; defaults to the dark stub.
    clock:
        Injectable ``() -> ISO str`` for deterministic tests.
    """

    def __init__(
        self,
        review_queue_path: Optional[Path] = None,
        ai_matcher: Optional[AiMatcher] = None,
        clock: Optional[Callable[[], str]] = None,
    ) -> None:
        self._entities: Dict[str, Entity] = {}
        self._key_index: Dict[Tuple[str, str], str] = {}  # (kind, value) -> id
        self._queue_path = Path(review_queue_path) if review_queue_path else None
        self._ai_matcher: AiMatcher = ai_matcher if ai_matcher is not None else ai_matcher_stub
        self._clock: Callable[[], str] = clock if clock is not None else _utc_now_iso
        self.review_queue: List[Dict[str, Any]] = []

    # -- read surface ------------------------------------------------
    @property
    def entity_count(self) -> int:
        return len(self._entities)

    def get(self, entity_id: str) -> Entity:
        return self._entities[entity_id]

    # -- validation (fail closed, before any write) ------------------
    @staticmethod
    def _validate_provenance(provenance: Optional[Provenance]) -> Provenance:
        if provenance is None:
            raise MalformedProvenanceError("provenance is mandatory")
        if not isinstance(provenance.source, str) or not provenance.source.strip():
            raise MalformedProvenanceError("provenance.source is mandatory")
        try:
            date.fromisoformat(provenance.as_of)
        except (TypeError, ValueError):
            raise MalformedProvenanceError(
                "provenance.as_of must be an ISO date, got %r" % (provenance.as_of,)
            )
        fetched = provenance.fetched_at
        try:
            # 3.9 fromisoformat rejects a trailing Z; accept it explicitly.
            datetime.fromisoformat(fetched.replace("Z", "+00:00"))
        except (TypeError, ValueError, AttributeError):
            raise MalformedProvenanceError(
                "provenance.fetched_at must be an ISO datetime, got %r" % (fetched,)
            )
        if provenance.accession is None and provenance.dataset_version is None:
            raise MalformedProvenanceError(
                "provenance needs accession or dataset_version"
            )
        return provenance

    @staticmethod
    def _validated_keys(record: SourceRecord) -> Dict[str, str]:
        """Normalize every SUPPLIED key; raise on any malformed one.
        Absent keys stay absent."""
        keys: Dict[str, str] = {}
        for kind in DETERMINISTIC_KEY_PRECEDENCE:
            raw = getattr(record, kind)
            if raw is None:
                continue
            keys[kind] = _KEY_NORMALIZERS[kind](raw)
        return keys

    # -- review queue ------------------------------------------------
    def _queue(
        self,
        reason: str,
        record: SourceRecord,
        keys: Dict[str, str],
        candidates: Tuple[NameCandidate, ...] = (),
        ai_match: Optional[AiMatch] = None,
        conflict: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        entry = {
            "queued_at": self._clock(),
            "reason": reason,
            "record": {
                "source": record.source,
                "source_entity_id": record.source_entity_id,
                "name": record.name,
                "isin": keys.get("isin"),
                "lei": keys.get("lei"),
                "cik": keys.get("cik"),
                "provenance": record.provenance.to_dict()
                if record.provenance
                else None,
            },
            "candidates": [
                {"entity_id": c.entity_id, "normalized_name": c.normalized_name}
                for c in candidates
            ],
            # ABSENT != ZERO: no AI opinion is null, never 0.0.
            "ai_confidence": ai_match.confidence if ai_match else None,
            "ai_entity_id": ai_match.entity_id if ai_match else None,
            "conflict": conflict,
        }
        if self._queue_path is not None:
            # The queue is the fail-safe path — it must not itself fail
            # on a missing parent directory.
            self._queue_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self._queue_path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, sort_keys=True, ensure_ascii=False))
                handle.write("\n")
        self.review_queue.append(entry)
        return entry

    # -- resolution --------------------------------------------------
    def resolve(self, record: SourceRecord) -> ResolutionResult:
        """Resolve one source record. Typed statuses, never guesses:

        CREATED   new entity minted from the first deterministic key
        LINKED    exact deterministic-key match, record appended
        UNLINKED  no deterministic key — queued (name path is
                  queue-only by law, whatever the AI confidence)
        CONFLICT  deterministic evidence disagrees — queued, zero
                  mutation
        """
        self._validate_provenance(record.provenance)
        keys = self._validated_keys(record)

        if keys:
            return self._resolve_deterministic(record, keys)
        return self._resolve_by_name_queue_only(record)

    # deterministic path ---------------------------------------------
    def _resolve_deterministic(
        self, record: SourceRecord, keys: Dict[str, str]
    ) -> ResolutionResult:
        matched: Dict[str, str] = {}  # kind -> entity_id
        for kind, value in keys.items():
            hit = self._key_index.get((kind, value))
            if hit is not None:
                matched[kind] = hit
        matched_ids = sorted(set(matched.values()))

        if len(matched_ids) > 1:
            # The record's own keys straddle two canonical entities.
            # Deterministic evidence disagrees with itself — a human
            # (or a corrected source) decides; we never pick a side.
            entry = self._queue(
                REASON_KEY_STRADDLE,
                record,
                keys,
                conflict={
                    "kind": "straddle",
                    "entity_ids": matched_ids,
                    "matched_by": sorted(matched.keys()),
                },
            )
            return ResolutionResult(
                status=ResolutionStatus.CONFLICT,
                reason=REASON_KEY_STRADDLE,
                queue_entry=entry,
            )

        if len(matched_ids) == 1:
            return self._link(record, keys, matched_ids[0], sorted(matched.keys()))

        return self._create(record, keys)

    def _detect_link_conflicts(
        self, entity: Entity, record: SourceRecord, keys: Dict[str, str]
    ) -> Optional[Tuple[str, Dict[str, Any]]]:
        """All conflict checks BEFORE any mutation — a conflicting
        record is refused atomically, nothing half-applied."""
        # Single-valued keys: a different existing claim is a conflict
        # (e.g. same ISIN linked us here, but the CIKs disagree).
        for kind in ("lei", "cik"):
            claimed = keys.get(kind)
            existing = getattr(entity, kind)
            if claimed is not None and existing is not None and claimed != existing:
                return (
                    REASON_KEY_VALUE_CONFLICT,
                    {"kind": kind, "existing": existing, "claimed": claimed},
                )
        # Same source claiming a different external id: append-only
        # means the first claim stands and the divergence goes to
        # review, never an overwrite.
        existing_ext = entity.external_ids.get(record.source)
        if existing_ext is not None and existing_ext != record.source_entity_id:
            return (
                REASON_EXTERNAL_ID_CONFLICT,
                {
                    "kind": "external_id",
                    "source": record.source,
                    "existing": existing_ext,
                    "claimed": record.source_entity_id,
                },
            )
        return None

    def _link(
        self,
        record: SourceRecord,
        keys: Dict[str, str],
        entity_id: str,
        matched_by: List[str],
    ) -> ResolutionResult:
        entity = self._entities[entity_id]
        conflict = self._detect_link_conflicts(entity, record, keys)
        if conflict is not None:
            reason, detail = conflict
            detail["entity_id"] = entity_id
            entry = self._queue(reason, record, keys, conflict=detail)
            return ResolutionResult(
                status=ResolutionStatus.CONFLICT, reason=reason, queue_entry=entry
            )

        added = self._apply(entity, record, keys)
        entity._history.append(
            {
                "event": "linked",
                "at": self._clock(),
                "source": record.source,
                "matched_by": matched_by,
                "added_keys": added,
                "provenance": record.provenance.to_dict(),  # type: ignore[union-attr]
            }
        )
        return ResolutionResult(status=ResolutionStatus.LINKED, entity_id=entity_id)

    def _create(self, record: SourceRecord, keys: Dict[str, str]) -> ResolutionResult:
        for kind in DETERMINISTIC_KEY_PRECEDENCE:
            if kind in keys:
                entity_id = mint_entity_id(kind, keys[kind])
                minted_from = kind
                break
        entity = Entity(entity_id)
        self._entities[entity_id] = entity
        added = self._apply(entity, record, keys)
        entity._history.append(
            {
                "event": "created",
                "at": self._clock(),
                "source": record.source,
                "minted_from": minted_from,
                "added_keys": added,
                "provenance": record.provenance.to_dict(),  # type: ignore[union-attr]
            }
        )
        return ResolutionResult(status=ResolutionStatus.CREATED, entity_id=entity_id)

    def _apply(
        self, entity: Entity, record: SourceRecord, keys: Dict[str, str]
    ) -> Dict[str, str]:
        """Append-only application of a conflict-free record."""
        added: Dict[str, str] = {}
        isin = keys.get("isin")
        if isin is not None and isin not in entity._isins:
            entity._isins.append(isin)  # an entity may list many ISINs
            self._key_index[("isin", isin)] = entity.entity_id
            added["isin"] = isin
        for kind in ("lei", "cik"):
            value = keys.get(kind)
            if value is not None and getattr(entity, kind) is None:
                setattr(entity, "_" + kind, value)
                self._key_index[(kind, value)] = entity.entity_id
                added[kind] = value
        if record.source not in entity.external_ids:
            added["external_id"] = "%s:%s" % (record.source, record.source_entity_id)
        # Observation log stays append-only even for repeats we already
        # map — the {source: id} view dedupes, the log never forgets.
        entity._external_ids.append((record.source, record.source_entity_id))
        if record.name:
            norm = normalize_name(record.name)
            if norm and norm not in entity._norm_names:
                entity._names.append(record.name)
                entity._norm_names.append(norm)
        return added

    # name path — queue-only by law ----------------------------------
    def _name_candidates(self, normalized: str) -> Tuple[NameCandidate, ...]:
        """Deterministic candidate recall: exact normalized equality,
        or one name extending the other by whole words. Deliberately
        narrow — the AI layer may broaden recall later, but only INTO
        the queue, never into auto-links."""
        if not normalized:
            return ()
        found: List[NameCandidate] = []
        for entity_id in sorted(self._entities):  # sorted: stable order
            for norm in self._entities[entity_id].normalized_names:
                if (
                    norm == normalized
                    or norm.startswith(normalized + " ")
                    or normalized.startswith(norm + " ")
                ):
                    found.append(NameCandidate(entity_id, norm))
                    break
        return tuple(found)

    def _resolve_by_name_queue_only(self, record: SourceRecord) -> ResolutionResult:
        normalized = normalize_name(record.name) if record.name else ""
        candidates = self._name_candidates(normalized)

        if not candidates:
            # No deterministic key and nothing to even suggest. A
            # name-only record can never mint an entity — there is no
            # stable key to hash an id from — so it queues.
            entry = self._queue(REASON_NO_DETERMINISTIC_KEY, record, {})
            return ResolutionResult(
                status=ResolutionStatus.UNLINKED,
                reason=REASON_NO_DETERMINISTIC_KEY,
                queue_entry=entry,
            )

        ai_match = self._ai_matcher(normalized, candidates)
        if ai_match is not None:
            candidate_ids = set(c.entity_id for c in candidates)
            if (
                not isinstance(ai_match.confidence, float)
                or not 0.0 <= ai_match.confidence <= 1.0
                or ai_match.entity_id not in candidate_ids
            ):
                # Fail closed: an out-of-range or out-of-candidate AI
                # suggestion is discarded (dark path), not trusted.
                ai_match = None

        if ai_match is None:
            reason = REASON_NAME_MATCH_REQUIRES_REVIEW
        elif ai_match.confidence < AI_CONFIDENCE_GATE:
            reason = REASON_AI_BELOW_GATE
        else:
            # PM6: above the gate but with NO deterministic key the
            # auto-link is blocked — strong suggestion, queued, human
            # (or a key-carrying re-ingest) decides.
            reason = REASON_AI_ABOVE_GATE_BLOCKED

        entry = self._queue(reason, record, {}, candidates=candidates, ai_match=ai_match)
        return ResolutionResult(
            status=ResolutionStatus.UNLINKED, reason=reason, queue_entry=entry
        )

    # PM6 structural ban ---------------------------------------------
    def autolink_by_name(
        self, entity_id: str, record: SourceRecord, confidence: float
    ) -> ResolutionResult:
        """There is deliberately NO code path that links on name
        evidence. This method exists so the ban is a typed wall the
        AI layer hits, not a convention it can forget: it refuses
        unconditionally. Records that carry a deterministic key link
        through :meth:`resolve`; records that don't belong in the
        review queue."""
        raise AutoLinkBlockedError(
            "auto-link by name is blocked (PM6): record for source %r claims "
            "entity %s at confidence %s without a deterministic key — queue it "
            "for review via resolve() instead" % (record.source, entity_id, confidence)
        )
