"""engine.ir — the LedgerDoc intermediate representation (Phase 0: types).

The compiler-restructure IR: exact-integer `Money` (no floats on the
value path), immutable `AccountAtom` / `LedgerDoc` with per-atom
provenance and ABSENT-vs-ZERO amount semantics, and the versioned
'ir1' wire shape with a volatile-key-excluding `content_hash`.

Phase 0 ships the types only — this package is a LEAF: it imports
nothing from parsers, pipeline, or serving, and nothing imports it yet
(zero behavior change; the golden corpus is untouched by construction).
Phase 1 adds the front-end adapters that EMIT LedgerDoc from the
deterministic parser / PDF ingester / AI lane and derive the legacy
shapes from the IR.
"""
from .money import (
    CURRENCY_SCALES,
    DEFAULT_SCALE,
    Money,
    MoneyCurrencyMismatch,
    MoneyError,
    MoneyParseError,
    scale_for_currency,
)
from .ledgerdoc import (
    IR_VERSION,
    MONEY_FIELDS,
    PROVENANCE_METHODS,
    AccountAtom,
    DocHeader,
    DocumentTotals,
    LedgerDoc,
    LedgerDocError,
    Provenance,
    SourceRef,
    has_llm_atoms,
)
from .schema import (
    VOLATILE_SOURCE_META_KEYS,
    SchemaError,
    content_hash,
    deserialize,
    serialize,
)

__all__ = [
    # money
    "Money",
    "MoneyError",
    "MoneyCurrencyMismatch",
    "MoneyParseError",
    "CURRENCY_SCALES",
    "DEFAULT_SCALE",
    "scale_for_currency",
    # ledgerdoc
    "IR_VERSION",
    "MONEY_FIELDS",
    "PROVENANCE_METHODS",
    "AccountAtom",
    "DocHeader",
    "DocumentTotals",
    "LedgerDoc",
    "LedgerDocError",
    "Provenance",
    "SourceRef",
    "has_llm_atoms",
    # schema
    "VOLATILE_SOURCE_META_KEYS",
    "SchemaError",
    "serialize",
    "deserialize",
    "content_hash",
]
