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
from .anomalies import (
    detect_anomalies,
    AnomalyFlag,
)
from .quality_envelope import (
    build_extraction_quality,
    EXTRACTION_QUALITY_VERSION,
    MetricConfidence,
    ExtractionQualityEnvelope,
)

__all__ = [
    "ParseFlag", "parse_flag_multiplier", "ROW_CONFIDENCE_FLOOR",
    "compute_row_confidence", "RowConfidenceResult",
    "classification_confidence_for_line_item",
    "run_reconciliation_checks", "ReconciliationCheck",
    "detect_anomalies", "AnomalyFlag",
    "build_extraction_quality",
    "EXTRACTION_QUALITY_VERSION",
    "MetricConfidence", "ExtractionQualityEnvelope",
]
