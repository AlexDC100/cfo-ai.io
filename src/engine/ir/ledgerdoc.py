"""LedgerDoc — the immutable intermediate representation of ONE source
ledger document (compiler restructure, Phase 0).

A `LedgerDoc` is what every front-end adapter (deterministic RO parser,
PDF ingester, AI lane) will EMIT in Phase 1 and what every later stage
consumes: a frozen header (jurisdiction, period, currency, the file's
own verbatim totals row, source metadata, IR version) plus a tuple of
`AccountAtom`s — one atom per source account row.

Two invariants this module owns:

1.  ABSENT is not ZERO. Every per-column-pair amount slot is
    `Optional[Money]`: `None` means the source document does not carry
    that column (e.g. a closing-only 4-column export has no opening
    pair), while `Money(amount_minor=0)` means the document STATES zero.
    Serialization (schema.py) preserves the distinction by omitting the
    key entirely when the slot is None.

2.  Deep immutability. All dataclasses are frozen (attribute assignment
    raises `dataclasses.FrozenInstanceError`), atoms live in a tuple,
    and `source_meta` is deep-frozen on construction (dict ->
    `types.MappingProxyType` over a private copy, list -> tuple), so
    mutation attempts raise (`TypeError` on the proxy) and no caller
    can alias-mutate a doc after construction.

Provenance travels with every atom: WHERE the row came from
(`SourceRef` — spreadsheet cell {sheet,row,col}, PDF {page,bbox}, or a
synthetic pipeline {stage}), HOW (`method` 'mechanical' | 'llm'), with
what `confidence` (mechanical reads are exact by definition and MUST
carry 1.0), and whether a human should look (`needs_review`).

This package is a LEAF: nothing imports it yet (Phase 0 is types only),
and it imports nothing from parsers, pipeline, or serving.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Dict, Mapping, Optional, Tuple

from .money import Money, _check_currency


__all__ = [
    "IR_VERSION",
    "MONEY_FIELDS",
    "PROVENANCE_METHODS",
    "LedgerDocError",
    "SourceRef",
    "Provenance",
    "AccountAtom",
    "DocumentTotals",
    "DocHeader",
    "LedgerDoc",
    "has_llm_atoms",
]


#: IR shape version. Single source of truth (re-exported by schema.py,
#: which owns serialization for exactly this version). Bump ONLY with a
#: migration note + golden refreeze in the phase that changes the shape.
IR_VERSION = "ir1"

#: The six per-column-pair amount slots, in canonical (serialization)
#: order. Shared by `AccountAtom` and `DocumentTotals`.
MONEY_FIELDS: Tuple[str, ...] = (
    "opening_debit",
    "opening_credit",
    "period_debit",
    "period_credit",
    "closing_debit",
    "closing_credit",
)

PROVENANCE_METHODS: Tuple[str, ...] = ("mechanical", "llm")


class LedgerDocError(ValueError):
    """Any IR construction-time validation failure."""


# --- deep freeze / thaw for source_meta -------------------------------------


def _deep_freeze(value: Any, path: str = "source_meta") -> Any:
    """Recursively convert JSON-shaped data into immutable equivalents:
    dict -> MappingProxyType over a fresh dict, list/tuple -> tuple.
    Scalars pass through. Anything non-JSON-shaped raises — the IR must
    stay serializable and hash-stable."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return tuple(_deep_freeze(v, "%s[%d]" % (path, i)) for i, v in enumerate(value))
    if isinstance(value, (dict, MappingProxyType)):
        frozen: Dict[str, Any] = {}
        for k in value:
            if not isinstance(k, str):
                raise LedgerDocError(
                    "%s: mapping keys must be str, got %s" % (path, type(k).__name__)
                )
            frozen[k] = _deep_freeze(value[k], "%s.%s" % (path, k))
        return MappingProxyType(frozen)
    raise LedgerDocError(
        "%s: unsupported value type %s — source_meta must be JSON-shaped"
        % (path, type(value).__name__)
    )


def _deep_thaw(value: Any) -> Any:
    """Inverse of `_deep_freeze` for serialization: MappingProxyType ->
    fresh dict, tuple -> fresh list. Produces plain JSON-shaped data with
    NO aliasing into the frozen document."""
    if isinstance(value, (dict, MappingProxyType)):
        return {k: _deep_thaw(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_deep_thaw(v) for v in value]
    return value


# --- small validators -------------------------------------------------------


def _req_str(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LedgerDocError("%s must be a non-empty str, got %r" % (what, value))
    return value


def _opt_str(value: Any, what: str) -> Optional[str]:
    if value is None:
        return None
    return _req_str(value, what)


def _req_int(value: Any, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise LedgerDocError("%s must be an int, got %r" % (what, value))
    return value


def _opt_money(value: Any, what: str) -> Optional[Money]:
    if value is None or isinstance(value, Money):
        return value
    raise LedgerDocError(
        "%s must be Money or None (ABSENT), got %s" % (what, type(value).__name__)
    )


# --- provenance -------------------------------------------------------------


@dataclass(frozen=True)
class SourceRef:
    """WHERE a value came from — exactly ONE of three shapes:

      cell  {sheet, row, col}  — spreadsheet/grid extraction (row/col are
                                 0-based integer indices into the parsed
                                 grid, matching the parsers' dataframe
                                 coordinates; sheet is the sheet name)
      pdf   {page, bbox}       — positional PDF extraction (page 0-based,
                                 bbox = (x0, y0, x1, y1) floats in PDF
                                 points, PyMuPDF convention)
      stage {stage}            — synthetic/pipeline-produced values with
                                 no single source cell (named after the
                                 producing stage)

    Use the `cell` / `pdf` / `stage` constructors. Mixing shapes, or
    populating none, raises `LedgerDocError`.
    """

    sheet: Optional[str] = None
    row: Optional[int] = None
    col: Optional[int] = None
    page: Optional[int] = None
    bbox: Optional[Tuple[float, float, float, float]] = None
    stage: Optional[str] = None

    def __post_init__(self) -> None:
        is_cell = self.sheet is not None or self.row is not None or self.col is not None
        is_pdf = self.page is not None or self.bbox is not None
        is_stage = self.stage is not None
        if sum((is_cell, is_pdf, is_stage)) != 1:
            raise LedgerDocError(
                "SourceRef must be exactly one of {sheet,row,col} | "
                "{page,bbox} | {stage}; got sheet=%r row=%r col=%r page=%r "
                "bbox=%r stage=%r"
                % (self.sheet, self.row, self.col, self.page, self.bbox, self.stage)
            )
        if is_cell:
            _req_str(self.sheet, "SourceRef.sheet")
            _req_int(self.row, "SourceRef.row")
            _req_int(self.col, "SourceRef.col")
        elif is_pdf:
            _req_int(self.page, "SourceRef.page")
            bbox = self.bbox
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                raise LedgerDocError(
                    "SourceRef.bbox must be a 4-tuple (x0, y0, x1, y1), got %r"
                    % (bbox,)
                )
            coords = []
            for i, c in enumerate(bbox):
                if isinstance(c, bool) or not isinstance(c, (int, float)):
                    raise LedgerDocError(
                        "SourceRef.bbox[%d] must be a number, got %r" % (i, c)
                    )
                # Canonicalize to float so serialization is byte-stable
                # regardless of int/float input mix (json '10' vs '10.0').
                coords.append(float(c))
            object.__setattr__(self, "bbox", tuple(coords))
        else:
            _req_str(self.stage, "SourceRef.stage")

    @classmethod
    def cell(cls, sheet: str, row: int, col: int) -> "SourceRef":
        return cls(sheet=sheet, row=row, col=col)

    @classmethod
    def pdf(cls, page: int, bbox: Tuple[float, float, float, float]) -> "SourceRef":
        return cls(page=page, bbox=bbox)

    @classmethod
    def pipeline_stage(cls, stage: str) -> "SourceRef":
        return cls(stage=stage)


@dataclass(frozen=True)
class Provenance:
    """HOW a value was produced. `method` 'mechanical' means a
    deterministic cell read — exact by definition, so confidence MUST be
    1.0 (anything else is a bug and raises). 'llm' carries the model's
    calibrated confidence in [0, 1]. `needs_review` flags atoms a human
    should look at before the numbers are trusted downstream."""

    source_ref: SourceRef
    method: str
    confidence: float = 1.0
    needs_review: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.source_ref, SourceRef):
            raise LedgerDocError(
                "Provenance.source_ref must be a SourceRef, got %s"
                % type(self.source_ref).__name__
            )
        if self.method not in PROVENANCE_METHODS:
            raise LedgerDocError(
                "Provenance.method must be one of %s, got %r"
                % (list(PROVENANCE_METHODS), self.method)
            )
        conf = self.confidence
        if isinstance(conf, bool) or not isinstance(conf, (int, float)):
            raise LedgerDocError(
                "Provenance.confidence must be a number, got %r" % (conf,)
            )
        # Canonicalize to float (json byte-stability: 1 vs 1.0).
        conf = float(conf)
        if not (0.0 <= conf <= 1.0):
            raise LedgerDocError(
                "Provenance.confidence must be within [0, 1], got %r" % (conf,)
            )
        if self.method == "mechanical" and conf != 1.0:
            raise LedgerDocError(
                "mechanical provenance is exact by definition — confidence "
                "must be 1.0, got %r" % (conf,)
            )
        object.__setattr__(self, "confidence", conf)
        if not isinstance(self.needs_review, bool):
            raise LedgerDocError(
                "Provenance.needs_review must be a bool, got %r"
                % (self.needs_review,)
            )

    @classmethod
    def mechanical(cls, source_ref: SourceRef) -> "Provenance":
        return cls(source_ref=source_ref, method="mechanical")


# --- atoms ------------------------------------------------------------------


@dataclass(frozen=True)
class AccountAtom:
    """One source account row. The six amount slots mirror the trial
    balance column pairs (opening / period-movement / closing, debit and
    credit sides); each is `Optional[Money]` where None == ABSENT (the
    document has no such column) and `Money(0)` == the document states
    zero. `atom_id` is the IR's own identifier, unique within one doc
    (duplicate ACCOUNT CODES stay legal — that is downstream diagnosis
    D5's business, not the IR's)."""

    atom_id: str
    account_code: str
    label: str
    provenance: Provenance
    opening_debit: Optional[Money] = None
    opening_credit: Optional[Money] = None
    period_debit: Optional[Money] = None
    period_credit: Optional[Money] = None
    closing_debit: Optional[Money] = None
    closing_credit: Optional[Money] = None

    def __post_init__(self) -> None:
        _req_str(self.atom_id, "AccountAtom.atom_id")
        _req_str(self.account_code, "AccountAtom.account_code")
        if not isinstance(self.label, str):
            raise LedgerDocError(
                "AccountAtom.label must be a str, got %r" % (self.label,)
            )
        if not isinstance(self.provenance, Provenance):
            raise LedgerDocError(
                "AccountAtom.provenance must be a Provenance, got %s"
                % type(self.provenance).__name__
            )
        for name in MONEY_FIELDS:
            _opt_money(getattr(self, name), "AccountAtom.%s" % name)
        # ABSENT-vs-ZERO postcondition: every slot is either genuinely
        # ABSENT (None) or a Money whose minor units are still an exact
        # int — a Money corrupted after ITS construction must not be
        # frozen into an atom, where it would poison every downstream
        # integer-cents accumulation.
        assert all(
            m is None
            or (isinstance(m.amount_minor, int)
                and not isinstance(m.amount_minor, bool))
            for m in (getattr(self, n) for n in MONEY_FIELDS)
        ), (
            "A-010: AccountAtom %r amount slots must each be ABSENT (None) "
            "or Money with exact int minor units" % (self.atom_id,)
        )


@dataclass(frozen=True)
class DocumentTotals:
    """The file's OWN totals row, verbatim — never recomputed from atoms
    (that recomputation is the anchor check's job, later). Same six
    slots and the same ABSENT-vs-ZERO semantics as `AccountAtom`: a pair
    the file's totals row does not carry stays None."""

    opening_debit: Optional[Money] = None
    opening_credit: Optional[Money] = None
    period_debit: Optional[Money] = None
    period_credit: Optional[Money] = None
    closing_debit: Optional[Money] = None
    closing_credit: Optional[Money] = None

    def __post_init__(self) -> None:
        for name in MONEY_FIELDS:
            _opt_money(getattr(self, name), "DocumentTotals.%s" % name)
        # Same ABSENT-vs-ZERO integrality postcondition as AccountAtom
        # (A-010): the file's own totals row must carry exact integers.
        assert all(
            m is None
            or (isinstance(m.amount_minor, int)
                and not isinstance(m.amount_minor, bool))
            for m in (getattr(self, n) for n in MONEY_FIELDS)
        ), (
            "A-011: DocumentTotals amount slots must each be ABSENT (None) "
            "or Money with exact int minor units"
        )


# --- document ---------------------------------------------------------------


@dataclass(frozen=True)
class DocHeader:
    """Document-level facts. `currency` is the header/declared document
    currency (atoms carry their own Money currency — the IR does not
    force them equal; cross-checking is a validator-stage concern).
    `period_start` / `period_end` are ISO 'YYYY-MM-DD' strings when
    known, None when the source does not state them (format is NOT
    enforced here — the IR carries what upstream detected).
    `source_meta` is free-form JSON-shaped metadata (filename, parser
    version, timestamps, ...), deep-frozen on construction; the
    content-hash exclusion list for its volatile keys lives in
    schema.py."""

    jurisdiction: str
    currency: str
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    document_totals: Optional[DocumentTotals] = None
    source_meta: Mapping[str, Any] = field(default_factory=dict)
    ir_version: str = IR_VERSION

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "jurisdiction",
            _req_str(self.jurisdiction, "DocHeader.jurisdiction").strip().upper(),
        )
        object.__setattr__(self, "currency", _check_currency(self.currency))
        _opt_str(self.period_start, "DocHeader.period_start")
        _opt_str(self.period_end, "DocHeader.period_end")
        if self.document_totals is not None and not isinstance(
            self.document_totals, DocumentTotals
        ):
            raise LedgerDocError(
                "DocHeader.document_totals must be DocumentTotals or None, got %s"
                % type(self.document_totals).__name__
            )
        if not isinstance(self.source_meta, (dict, MappingProxyType)):
            raise LedgerDocError(
                "DocHeader.source_meta must be a mapping, got %s"
                % type(self.source_meta).__name__
            )
        object.__setattr__(self, "source_meta", _deep_freeze(self.source_meta))
        # Deep-immutability postcondition: after the freeze, source_meta
        # must be a MappingProxyType — a plain dict here would mean a
        # caller can alias-mutate the "immutable" document.
        assert isinstance(self.source_meta, MappingProxyType), (
            "A-012: DocHeader.source_meta must be deep-frozen to a "
            "MappingProxyType after construction, got %s"
            % type(self.source_meta).__name__
        )
        if self.ir_version != IR_VERSION:
            raise LedgerDocError(
                "DocHeader.ir_version must be %r for this build, got %r"
                % (IR_VERSION, self.ir_version)
            )


@dataclass(frozen=True)
class LedgerDoc:
    """One immutable parsed source document: frozen header + tuple of
    atoms. List input is coerced to tuple; every mutation path raises
    (`FrozenInstanceError` on fields, `AttributeError` on tuple mutation,
    `TypeError` on the source_meta proxy)."""

    header: DocHeader
    atoms: Tuple[AccountAtom, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.header, DocHeader):
            raise LedgerDocError(
                "LedgerDoc.header must be a DocHeader, got %s"
                % type(self.header).__name__
            )
        atoms = self.atoms
        if isinstance(atoms, list):
            atoms = tuple(atoms)
            object.__setattr__(self, "atoms", atoms)
        if not isinstance(atoms, tuple):
            raise LedgerDocError(
                "LedgerDoc.atoms must be a tuple, got %s" % type(atoms).__name__
            )
        seen: Dict[str, int] = {}
        for i, atom in enumerate(atoms):
            if not isinstance(atom, AccountAtom):
                raise LedgerDocError(
                    "LedgerDoc.atoms[%d] must be an AccountAtom, got %s"
                    % (i, type(atom).__name__)
                )
            if atom.atom_id in seen:
                raise LedgerDocError(
                    "duplicate atom_id %r at atoms[%d] (first at atoms[%d]) — "
                    "atom ids must be unique within a document"
                    % (atom.atom_id, i, seen[atom.atom_id])
                )
            seen[atom.atom_id] = i
        # Uniqueness census postcondition: after the loop every atom is
        # registered under exactly one id. A mismatch means an atom's
        # reported atom_id changed between the membership check and the
        # registration (a TOCTOU on an impure/evil atom subclass) — the
        # uniqueness guarantee downstream code relies on would be void.
        assert len(seen) == len(atoms), (
            "A-013: LedgerDoc atom census mismatch — %d unique atom ids "
            "registered for %d atoms; atom identity must be stable and "
            "unique" % (len(seen), len(atoms))
        )


# --- provenance queries ------------------------------------------------------


def has_llm_atoms(doc: LedgerDoc) -> bool:
    """True when ANY atom in the document carries LLM provenance.

    This is the data-keyed groundwork for the serving cap ('llm ⇒ never
    BALANCED', docs/CANONICAL_BS_V2_CONTRACT.md): once the pipeline cuts
    over to the IR, the cap keys off the atoms' own provenance instead
    of a lane-level extraction.method stamp — a document with even one
    model-extracted row among mechanical ones is capped. The re-key
    itself lands at cutover; only the helper (and its test) land in
    Phase 1.
    """
    if not isinstance(doc, LedgerDoc):
        raise LedgerDocError(
            "has_llm_atoms takes a LedgerDoc, got %s" % type(doc).__name__
        )
    return any(atom.provenance.method == "llm" for atom in doc.atoms)
