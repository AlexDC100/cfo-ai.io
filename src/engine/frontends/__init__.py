"""engine.frontends — Phase 1 of the compiler restructure: front-end
adapters that WRAP the existing parsers and EMIT the `engine.ir`
LedgerDoc, plus the legacy adapter that derives the exact legacy
structures back from the IR.

NOTHING ROUTES THROUGH THIS PACKAGE YET. The old pipeline keeps running
exactly as-is (zero behavior change — the golden corpus is untouched by
construction, since no production module imports this package); the
adapters exist so N2 equivalence

    parser-direct legacy structures == derive_legacy(front_end.parse(bytes))

is proven over the full corpus (tests/engine/test_frontends.py) BEFORE
any routing moves. Cutover — relocating format detection into the
registry, feeding stages from the IR, re-keying the 'llm => never
BALANCED' serving cap off `engine.ir.has_llm_atoms` — is a later phase.

Contract (uniform across adapters):

    front_end.parse(data: bytes, hints: dict) -> (LedgerDoc, diagnostics)

Front-ends do NO classification and NO totals logic beyond copying the
file's own totals row verbatim into `header.document_totals`. See
`saga10` (the reference adapter, hosting the shared machinery and the
column-pair mapping + float-exactness documentation), `positional_pdf`
(the PDF geometry lane), `llm_extractor` (the AI-lane extract stage)
and `legacy_adapter` (the keystone derivation).
"""
from .csv_fe import CsvFrontEnd
from .generic4 import Generic4FrontEnd
from .legacy_adapter import (
    LegacyExtractView,
    LegacyTbView,
    derive_legacy,
)
from .llm_extractor import LlmExtractFrontEnd
from .positional_pdf import PositionalPdfFrontEnd
from .registry import FRONT_ENDS, front_end_specs, resolve_front_end
from .saga10 import (
    FrontEndError,
    Saga10FrontEnd,
    float_to_money,
    money_to_float,
)
from .saga6 import Saga6FrontEnd

__all__ = [
    # contract + registry
    "FRONT_ENDS",
    "front_end_specs",
    "resolve_front_end",
    "FrontEndError",
    # adapters
    "Saga10FrontEnd",
    "Saga6FrontEnd",
    "Generic4FrontEnd",
    "CsvFrontEnd",
    "PositionalPdfFrontEnd",
    "LlmExtractFrontEnd",
    # legacy derivation
    "derive_legacy",
    "LegacyTbView",
    "LegacyExtractView",
    # exact float bridge
    "float_to_money",
    "money_to_float",
]
