"""F4.2 methodology layer — declarative recipes (YAML) that compose
named views (EBITDA variants, ratios) from canonical buckets.

The engine becomes a reader; methodology authors don't touch engine
source. See `CANONICAL_SCHEMA_V1.md` §6 for design rationale and
`methodology/ro_ras_2025_v1.yaml` for the first methodology file
(doubles as format spec).

Public API:
    load_methodology(methodology_id) -> MethodologyDoc
    evaluate(methodology, canonical_envelope) -> dict   # views + ratios
"""
from .loader import load_methodology, MethodologyDoc, MethodologyError
from .evaluator import evaluate

__all__ = ["load_methodology", "MethodologyDoc", "MethodologyError", "evaluate"]
