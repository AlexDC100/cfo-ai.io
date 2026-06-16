"""F4.8 Signal 2 aggregator — Per-row confidence computation.

Computes a row's confidence score from its parse_flags. Row confidence
is the PRODUCT of all flag multipliers (so multiple soft flags compound
into low confidence). Floor at ROW_CONFIDENCE_FLOOR for rows with no
explicit flags — that's the default uncertainty of any parsed number.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .parse_flags import ParseFlag, parse_flag_multiplier, ROW_CONFIDENCE_FLOOR


@dataclass
class RowConfidenceResult:
    """Confidence breakdown for a single parsed row."""
    row_id: str
    confidence: float                        # 0.0 - 1.0
    flags: List[str] = field(default_factory=list)
    rationale: str = ""


def compute_row_confidence(
    flags: Optional[List[str]] = None,
    fallback_confidence: Optional[float] = None,
) -> float:
    """Compute confidence as product of flag multipliers, clamped [0, 1].

    Args:
        flags: list of flag strings (enum values). Unknown strings get
               the default 0.5 multiplier so future-version flags don't
               crash older readers.
        fallback_confidence: if provided AND flags is empty, use this
               value (e.g. an LLM-emitted confidence score). Otherwise
               empty flags → ROW_CONFIDENCE_FLOOR.

    Returns:
        Confidence in [0, 1].
    """
    if not flags:
        if fallback_confidence is not None:
            return max(0.0, min(1.0, float(fallback_confidence)))
        return ROW_CONFIDENCE_FLOOR

    product = 1.0
    for f in flags:
        try:
            flag_enum = ParseFlag(f)
            product *= parse_flag_multiplier(flag_enum)
        except (ValueError, KeyError):
            product *= 0.5   # unknown flag — neither penalise nor credit
    return max(0.0, min(1.0, product))


def derive_row_confidence_from_line_item(line_item: Dict[str, Any]) -> RowConfidenceResult:
    """Inspect a line_item dict and derive its confidence + flags from
    observable signals.

    This is the POST-HOC path: we don't have explicit parse_flags from
    the parser yet (F4.8b adds those), but we can infer some flags from
    existing metadata on the line_item:

      - `via_semantic_fallback=True` (F3.10) → SEMANTIC_FALLBACK flag
      - `bucket_override` set → SIDE_FLIPPED flag
      - amount magnitude is tiny + non-zero (<1 RON) → potentially
        VALUE_COERCED (could be a parse artifact)

    When F4.8b lands explicit flags on every row, this function shifts
    to reading them directly. The post-hoc inference is the transitional
    bridge that lets F4.8a ship without waiting for the parser refactor.
    """
    flags: List[str] = []
    code = str(line_item.get("ro_account_code") or "")
    name = str(line_item.get("ro_account_name") or "")
    row_id = f"{code}:{name[:30]}" if code else f"unknown:{name[:30]}"

    if line_item.get("via_semantic_fallback"):
        flags.append(ParseFlag.SEMANTIC_FALLBACK.value)
    if line_item.get("bucket_override"):
        flags.append(ParseFlag.SIDE_FLIPPED.value)
    # Pass-through explicit flags if the parser emitted them (F4.8b path)
    explicit_flags = line_item.get("parse_flags")
    if isinstance(explicit_flags, list):
        flags.extend(str(f) for f in explicit_flags)

    confidence = compute_row_confidence(flags) if flags else ROW_CONFIDENCE_FLOOR

    rationale_parts: List[str] = []
    if ParseFlag.SEMANTIC_FALLBACK.value in flags:
        rationale_parts.append("classified by name (no code match)")
    if ParseFlag.SIDE_FLIPPED.value in flags:
        rationale_parts.append("side-flipped to liability bucket")
    if not flags:
        rationale_parts.append("clean parse")
    rationale = "; ".join(rationale_parts)

    return RowConfidenceResult(
        row_id=row_id, confidence=confidence,
        flags=flags, rationale=rationale,
    )
