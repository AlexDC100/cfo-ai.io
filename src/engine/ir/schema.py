"""LedgerDoc IR serialization + content hash (compiler restructure, Phase 0).

One versioned wire shape (`IR_VERSION` = 'ir1'):

    {
      "header": {
        "jurisdiction": "RO",
        "period_start": "2025-01-01",        # omitted when ABSENT
        "period_end": "2025-12-31",          # omitted when ABSENT
        "currency": "RON",
        "document_totals": {                 # omitted when the file has no
          "closing_debit": {...Money...},    #   totals row; per-pair slots
          "closing_credit": {...Money...}    #   omitted when that pair is
        },                                   #   absent from the totals row
        "source_meta": { ... },              # always present (may be {})
        "ir_version": "ir1"
      },
      "atoms": [
        {
          "atom_id": "a0001",
          "account_code": "5121",
          "label": "Conturi la banci in lei",
          "closing_debit": {"currency": "RON", "amount_minor": 123456, "scale": 2},
          ...                                # ABSENT slots OMITTED — never null
          "provenance": {
            "source_ref": {"sheet": "Sheet1", "row": 12, "col": 8},
            "method": "mechanical",
            "confidence": 1.0,
            "needs_review": false
          }
        }
      ]
    }

DETERMINISM. `serialize` builds every dict in a FIXED, documented
insertion order (the order shown above), producing byte-identical
`json.dumps` output for equal documents without needing sort_keys; the
ABSENT-vs-ZERO distinction is preserved by OMITTING absent keys (never
emitting null for an amount slot). Round-trip guarantee:
`serialize(deserialize(serialize(x)))` is byte-identical to
`serialize(x)`.

`content_hash(doc)` is sha256 over the NORMALIZED serialization:
canonical JSON (`sort_keys=True`, compact separators, ensure_ascii)
with the volatile `source_meta` keys removed first — see
`VOLATILE_SOURCE_META_KEYS` for the exclusion list and its rationale.
Two ingestions of the same document content therefore hash identically
even when run-specific metadata (timestamps, storage paths, job ids)
differs, while ANY change to an amount, code, label, provenance, or
non-volatile metadata changes the hash.

`deserialize` is STRICT: this is a version-locked shape ('ir1'), so an
unknown key, a missing required key, or a foreign ir_version raises
`SchemaError` instead of being silently tolerated — forward
compatibility is handled by bumping IR_VERSION with a migration, never
by lenient parsing.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional

from .ledgerdoc import (
    IR_VERSION,
    MONEY_FIELDS,
    AccountAtom,
    DocHeader,
    DocumentTotals,
    LedgerDoc,
    Provenance,
    SourceRef,
    _deep_thaw,
)
from .money import Money


__all__ = [
    "IR_VERSION",
    "VOLATILE_SOURCE_META_KEYS",
    "SchemaError",
    "serialize",
    "deserialize",
    "content_hash",
]


class SchemaError(ValueError):
    """A payload does not conform to the 'ir1' wire shape."""


#: TOP-LEVEL `source_meta` keys excluded from `content_hash` because they
#: legitimately differ between two ingestions of the SAME document content
#: (the hash must answer "is this the same document?", not "is this the
#: same run?"). Exclusion is top-level-only by design — nested structures
#: are hashed verbatim. Three families:
#:
#:   * wall-clock timestamps of the processing run itself;
#:   * per-run / infrastructure identifiers (retry of the same upload gets
#:     a fresh job id);
#:   * storage/transport addresses (the same bytes at a different path or
#:     behind a fresh signed URL are still the same document).
#:
#: Deliberately NOT excluded: `original_filename` (content-bearing — the
#: pipeline's period detection reads it), sheet names, parser/detector
#: versions, and anything describing the document rather than the run.
VOLATILE_SOURCE_META_KEYS = frozenset(
    {
        # timestamps of the run
        "ingested_at",
        "parsed_at",
        "extracted_at",
        "uploaded_at",
        "created_at",
        "updated_at",
        # per-run / infra identifiers
        "request_id",
        "job_id",
        "run_id",
        "trace_id",
        "session_id",
        # storage / transport addresses
        "storage_path",
        "signed_url",
        "document_id",
        "upload_id",
        # host environment
        "hostname",
        "pid",
    }
)


# --- serialize --------------------------------------------------------------


def _serialize_source_ref(ref: SourceRef) -> Dict[str, Any]:
    if ref.stage is not None:
        return {"stage": ref.stage}
    if ref.page is not None:
        return {"page": ref.page, "bbox": list(ref.bbox)}
    return {"sheet": ref.sheet, "row": ref.row, "col": ref.col}


def _serialize_provenance(prov: Provenance) -> Dict[str, Any]:
    return {
        "source_ref": _serialize_source_ref(prov.source_ref),
        "method": prov.method,
        "confidence": prov.confidence,
        "needs_review": prov.needs_review,
    }


def _serialize_money_slots(obj: Any) -> Dict[str, Any]:
    """The six per-pair slots in canonical order, ABSENT keys OMITTED."""
    out: Dict[str, Any] = {}
    for name in MONEY_FIELDS:
        value: Optional[Money] = getattr(obj, name)
        if value is not None:
            out[name] = value.to_dict()
    return out


def _serialize_atom(atom: AccountAtom) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "atom_id": atom.atom_id,
        "account_code": atom.account_code,
        "label": atom.label,
    }
    out.update(_serialize_money_slots(atom))
    out["provenance"] = _serialize_provenance(atom.provenance)
    return out


def serialize(doc: LedgerDoc) -> Dict[str, Any]:
    """LedgerDoc -> plain JSON-shaped dict, deterministic key order, no
    aliasing into the frozen document (safe to mutate the result)."""
    if not isinstance(doc, LedgerDoc):
        raise SchemaError("serialize takes a LedgerDoc, got %s" % type(doc).__name__)
    h = doc.header
    header: Dict[str, Any] = {"jurisdiction": h.jurisdiction}
    if h.period_start is not None:
        header["period_start"] = h.period_start
    if h.period_end is not None:
        header["period_end"] = h.period_end
    header["currency"] = h.currency
    if h.document_totals is not None:
        header["document_totals"] = _serialize_money_slots(h.document_totals)
    header["source_meta"] = _deep_thaw(h.source_meta)
    header["ir_version"] = h.ir_version
    return {
        "header": header,
        "atoms": [_serialize_atom(a) for a in doc.atoms],
    }


# --- deserialize ------------------------------------------------------------


def _require_dict(value: Any, path: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise SchemaError("%s must be an object, got %s" % (path, type(value).__name__))
    return value


def _reject_unknown(payload: Dict[str, Any], allowed: frozenset, path: str) -> None:
    unknown = set(payload.keys()) - set(allowed)
    if unknown:
        raise SchemaError(
            "%s carries unknown key(s) %s — 'ir1' is strict; bump IR_VERSION "
            "with a migration instead of extending the shape ad hoc"
            % (path, sorted(unknown))
        )


def _money_or_error(value: Any, path: str) -> Money:
    try:
        return Money.from_dict(_require_dict(value, path))
    except ValueError as exc:  # MoneyError subclasses ValueError
        raise SchemaError("%s: %s" % (path, exc))


_SOURCE_REF_KEYS = frozenset({"sheet", "row", "col", "page", "bbox", "stage"})
_PROVENANCE_KEYS = frozenset({"source_ref", "method", "confidence", "needs_review"})
_ATOM_KEYS = frozenset({"atom_id", "account_code", "label", "provenance"}) | frozenset(
    MONEY_FIELDS
)
_TOTALS_KEYS = frozenset(MONEY_FIELDS)
_HEADER_KEYS = frozenset(
    {
        "jurisdiction",
        "period_start",
        "period_end",
        "currency",
        "document_totals",
        "source_meta",
        "ir_version",
    }
)
_TOP_KEYS = frozenset({"header", "atoms"})


def _deserialize_source_ref(payload: Any, path: str) -> SourceRef:
    payload = _require_dict(payload, path)
    _reject_unknown(payload, _SOURCE_REF_KEYS, path)
    try:
        if "stage" in payload:
            return SourceRef(stage=payload.get("stage"))
        if "page" in payload or "bbox" in payload:
            bbox = payload.get("bbox")
            return SourceRef(
                page=payload.get("page"),
                bbox=tuple(bbox) if isinstance(bbox, list) else bbox,
            )
        return SourceRef(
            sheet=payload.get("sheet"),
            row=payload.get("row"),
            col=payload.get("col"),
        )
    except ValueError as exc:
        raise SchemaError("%s: %s" % (path, exc))


def _deserialize_provenance(payload: Any, path: str) -> Provenance:
    payload = _require_dict(payload, path)
    _reject_unknown(payload, _PROVENANCE_KEYS, path)
    for key in ("source_ref", "method", "confidence", "needs_review"):
        if key not in payload:
            raise SchemaError("%s missing required key %r" % (path, key))
    try:
        return Provenance(
            source_ref=_deserialize_source_ref(payload["source_ref"], path + ".source_ref"),
            method=payload["method"],
            confidence=payload["confidence"],
            needs_review=payload["needs_review"],
        )
    except SchemaError:
        raise
    except ValueError as exc:
        raise SchemaError("%s: %s" % (path, exc))


def _money_slots_kwargs(payload: Dict[str, Any], path: str) -> Dict[str, Optional[Money]]:
    """ABSENT (key omitted) -> None; an explicit null is REJECTED — 'ir1'
    encodes absence by omission only, so a null amount slot is malformed."""
    out: Dict[str, Optional[Money]] = {}
    for name in MONEY_FIELDS:
        if name in payload:
            if payload[name] is None:
                raise SchemaError(
                    "%s.%s is null — 'ir1' encodes ABSENT by omitting the key"
                    % (path, name)
                )
            out[name] = _money_or_error(payload[name], "%s.%s" % (path, name))
    return out


def _deserialize_atom(payload: Any, path: str) -> AccountAtom:
    payload = _require_dict(payload, path)
    _reject_unknown(payload, _ATOM_KEYS, path)
    for key in ("atom_id", "account_code", "label", "provenance"):
        if key not in payload:
            raise SchemaError("%s missing required key %r" % (path, key))
    try:
        return AccountAtom(
            atom_id=payload["atom_id"],
            account_code=payload["account_code"],
            label=payload["label"],
            provenance=_deserialize_provenance(payload["provenance"], path + ".provenance"),
            **_money_slots_kwargs(payload, path)
        )
    except SchemaError:
        raise
    except ValueError as exc:
        raise SchemaError("%s: %s" % (path, exc))


def deserialize(payload: Dict[str, Any]) -> LedgerDoc:
    """Plain dict (as produced by `serialize`) -> LedgerDoc. Strict 'ir1'
    parse; see module docstring."""
    payload = _require_dict(payload, "doc")
    _reject_unknown(payload, _TOP_KEYS, "doc")
    for key in ("header", "atoms"):
        if key not in payload:
            raise SchemaError("doc missing required key %r" % key)

    raw_header = _require_dict(payload["header"], "doc.header")
    _reject_unknown(raw_header, _HEADER_KEYS, "doc.header")
    for key in ("jurisdiction", "currency", "source_meta", "ir_version"):
        if key not in raw_header:
            raise SchemaError("doc.header missing required key %r" % key)
    if raw_header["ir_version"] != IR_VERSION:
        raise SchemaError(
            "unsupported ir_version %r — this build reads exactly %r"
            % (raw_header["ir_version"], IR_VERSION)
        )

    totals: Optional[DocumentTotals] = None
    if "document_totals" in raw_header:
        if raw_header["document_totals"] is None:
            raise SchemaError(
                "doc.header.document_totals is null — 'ir1' encodes ABSENT "
                "by omitting the key"
            )
        raw_totals = _require_dict(raw_header["document_totals"], "doc.header.document_totals")
        _reject_unknown(raw_totals, _TOTALS_KEYS, "doc.header.document_totals")
        totals = DocumentTotals(
            **_money_slots_kwargs(raw_totals, "doc.header.document_totals")
        )

    raw_atoms = payload["atoms"]
    if not isinstance(raw_atoms, list):
        raise SchemaError(
            "doc.atoms must be an array, got %s" % type(raw_atoms).__name__
        )
    atoms: List[AccountAtom] = [
        _deserialize_atom(a, "doc.atoms[%d]" % i) for i, a in enumerate(raw_atoms)
    ]

    try:
        header = DocHeader(
            jurisdiction=raw_header["jurisdiction"],
            currency=raw_header["currency"],
            period_start=raw_header.get("period_start"),
            period_end=raw_header.get("period_end"),
            document_totals=totals,
            source_meta=_require_dict(raw_header["source_meta"], "doc.header.source_meta"),
            ir_version=raw_header["ir_version"],
        )
        return LedgerDoc(header=header, atoms=tuple(atoms))
    except SchemaError:
        raise
    except ValueError as exc:
        raise SchemaError("doc.header: %s" % exc)


# --- content hash -----------------------------------------------------------


def content_hash(doc: LedgerDoc) -> str:
    """sha256 hex digest of the document CONTENT: canonical JSON
    (sorted keys, compact separators, ascii-only) of the serialization
    with `VOLATILE_SOURCE_META_KEYS` removed from the top level of
    `source_meta` first. Stable across runs, processes, and hosts for
    the same content; changes whenever any amount, code, label,
    provenance, or non-volatile metadata changes."""
    payload = serialize(doc)  # fresh structures — safe to mutate
    meta = payload["header"]["source_meta"]
    payload["header"]["source_meta"] = {
        k: v for k, v in meta.items() if k not in VOLATILE_SOURCE_META_KEYS
    }
    blob = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()
