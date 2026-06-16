"""F4.3 detection envelope — country/standard/doc_type/industry metadata
that carries forward from upload classification through canonical
assembly into methodology rendering.

Schema contract: CANONICAL_SCHEMA_V1.md §7. Single source of truth for
"which methodology applies here" — every consumer downstream of
assemble_statements reads from this envelope rather than re-deriving.

Public API:
    build_detection_envelope(classification, assembled, methodology_id) -> Dict
"""
from .envelope import build_detection_envelope, DETECTION_ENVELOPE_VERSION

__all__ = ["build_detection_envelope", "DETECTION_ENVELOPE_VERSION"]
