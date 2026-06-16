"""F4.4 confidence-based fan-out routing.

Per F3.15 operator decision 3d:
  - High confidence (>85%): fast path, single pack
  - Medium confidence (60-85%): fan-out to top 2 packs, pick cleanest
  - Low confidence (<60%): surface to operator with top 3 candidates

Public API:
    route_with_fan_out(classification, content, filename) -> RoutingResult
    routing_decision_dict(result) -> dict  (slots into detection envelope)
"""
from .fan_out import (
    route_with_fan_out, routing_decision_dict,
    RoutingResult, PackCandidate, RoutingMode,
    HIGH_CONFIDENCE, MEDIUM_CONFIDENCE,
)

__all__ = [
    "route_with_fan_out", "routing_decision_dict",
    "RoutingResult", "PackCandidate", "RoutingMode",
    "HIGH_CONFIDENCE", "MEDIUM_CONFIDENCE",
]
