"""F4.8 — Per-document extraction quality module.

Replaces the hardcoded "90%+ accurate" marketing claim with a real,
measured confidence score computed from the just-uploaded document.

Principle (verbatim from operator spec):
  Never display an accuracy number that wasn't measured on the actual
  document the user just uploaded. If we can't measure it for this
  document, say so. If it's low, show it as low.

Public API:
    build_extraction_quality(assembled, line_items, history) -> dict
    parse_flags  — enum of per-row parse provenance markers
    ParseFlag    — enum class

The envelope is shaped per the spec's TypeScript interface and lands on
the /api/period response under `statements.extraction_quality`. The FE
popup + badges + export footer read from this single source of truth.
"""
from .parse_flags import ParseFlag, parse_flag_multiplier, ROW_CONFIDENCE_FLOOR
from .row_confidence import (
    compute_row_confidence,
    RowConfidenceResult,
)
from .classification_confidence import (
    classification_confidence_for_line_item,
)
from .reconciliation_checks import (
    run_reconciliation_checks,
    ReconciliationCheck,
)
# NOTE (2026-08-21) — F4.8's `anomalies` and `quality_envelope` modules
# were NEVER WRITTEN. This __init__ was authored against the full planned
# API, so `import engine.confidence` raised ModuleNotFoundError in every
# clean checkout, silently breaking every consumer that imports through
# the package: the jurisdiction packs' CHECK_IMPLS binding (registered
# check impls could not load for ANY jurisdiction — RO/HU/INTL alike) and
# canonical_adapter's run_bs_diagnosis import. Two call sites had already
# grown by-file-path importlib workarounds for exactly this reason
# without the root cause being fixed.
#
# The eager imports are removed rather than stubbed: nothing in the repo
# consumes `detect_anomalies` / `build_extraction_quality` / their
# siblings (verified by grep across src/, scripts/ and tests/), so the
# only thing they did was break the package. Restore these lines when —
# and only when — the modules actually land.
__all__ = [
    "ParseFlag", "parse_flag_multiplier", "ROW_CONFIDENCE_FLOOR",
    "compute_row_confidence", "RowConfidenceResult",
    "classification_confidence_for_line_item",
    "run_reconciliation_checks", "ReconciliationCheck",
]
