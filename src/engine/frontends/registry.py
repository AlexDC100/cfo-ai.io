"""Front-end registry — format id -> adapter, with id@version specs.

Phase 1 exposes the mapping only: the EXISTING format detection
(magic-byte dispatch in `RomaniaPack.parse_trial_balance`, the
structure detector's `source_format` classification, the AI-lane
jurisdiction gate) stays exactly where it is — relocation into this
registry happens at cutover, in a later phase. Nothing in the pipeline
imports this module yet.

Keys are the platform's format-id vocabulary (the contract
`extraction.source_format` values for the deterministic lanes, per
docs/CANONICAL_BS_V2_CONTRACT.md and `corpus_replay.py`'s
DETERMINISTIC_PARSERS), plus `llm_extract` for the AI lane's extract
stage. Versions derive from the wrapped implementation: the four
trial-balance formats and the positional PDF carry the parser's
PARSER_VERSION; the LLM extractor carries the lane's parser + extract
prompt versions.
"""
from __future__ import annotations

from typing import Any, Dict

from .csv_fe import CsvFrontEnd
from .generic4 import Generic4FrontEnd
from .llm_extractor import LlmExtractFrontEnd
from .positional_pdf import PositionalPdfFrontEnd
from .saga10 import FrontEndError, Saga10FrontEnd
from .saga6 import Saga6FrontEnd


__all__ = [
    "FRONT_ENDS",
    "front_end_specs",
    "require_single_currency",
    "resolve_front_end",
]


#: format id -> front-end instance. Each instance carries `.format_id`,
#: `.version`, `.spec` ("<id>@<version>") and the Phase-1 contract
#: method `parse(data: bytes, hints: dict) -> (LedgerDoc, diagnostics)`.
FRONT_ENDS: Dict[str, Any] = {
    "saga_10_col": Saga10FrontEnd(),
    "saga_compact_6_col": Saga6FrontEnd(),
    "generic_4_col": Generic4FrontEnd(),
    "csv": CsvFrontEnd(),
    "pdf_positional": PositionalPdfFrontEnd(),
    "llm_extract": LlmExtractFrontEnd(),
}


def front_end_specs() -> Dict[str, str]:
    """{format_id: "<id>@<version>"} for every registered front-end."""
    return {format_id: fe.spec for format_id, fe in FRONT_ENDS.items()}


def resolve_front_end(format_id: str) -> Any:
    """Look a front-end up by format id. Raises FrontEndError naming the
    known ids on a miss — never guesses."""
    try:
        return FRONT_ENDS[format_id]
    except KeyError:
        raise FrontEndError(
            "no front-end registered for format id %r (known: %s)"
            % (format_id, ", ".join(sorted(FRONT_ENDS)))
        )


def require_single_currency(doc: Any) -> None:
    """Front-end CONTRACT guard: every Money a front-end emits — the six
    atom amount slots and the verbatim `header.document_totals` — must
    carry the header's declared currency.

    A front-end adapts ONE source document stated in ONE currency (every
    registered adapter constructs all its Money values from the single
    resolved `currency`), so a mixed-currency atom set can only mean an
    adapter bug or a hand-built doc that never went through an adapter.
    Reject it here with the typed `FrontEndError` instead of letting it
    flow downstream, where per-atom Money algebra would eventually raise
    `MoneyCurrencyMismatch` at some distant, unhelpful seam.

    Mixed SCALES within the one currency stay legal by design: a
    0-decimal currency document may still carry fractional cells via the
    per-document scale override (`engine.ir.money.scale_for_currency`).
    ABSENT (None) slots are ignored — absence carries no currency.

    Locked by tests/engine/test_ir_invariants.py (N6), which also runs
    the guard over every corpus-built document.
    """
    from engine.ir import MONEY_FIELDS, LedgerDoc

    if not isinstance(doc, LedgerDoc):
        raise FrontEndError(
            "require_single_currency takes a LedgerDoc, got %s"
            % type(doc).__name__
        )
    expected = doc.header.currency
    offenders = []
    totals = doc.header.document_totals
    if totals is not None:
        for name in MONEY_FIELDS:
            money = getattr(totals, name)
            if money is not None and money.currency != expected:
                offenders.append(
                    "document_totals.%s carries %s" % (name, money.currency)
                )
    for atom in doc.atoms:
        for name in MONEY_FIELDS:
            money = getattr(atom, name)
            if money is not None and money.currency != expected:
                offenders.append(
                    "atom %s.%s carries %s" % (atom.atom_id, name, money.currency)
                )
    if offenders:
        shown = "; ".join(offenders[:5])
        if len(offenders) > 5:
            shown += "; … %d more" % (len(offenders) - 5)
        raise FrontEndError(
            "mixed-currency atom set: header declares %s but %s — a "
            "front-end emits ONE currency per document" % (expected, shown)
        )
