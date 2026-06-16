"""F4.8 Signal 2 — Per-row parse flags.

Each row in a parsed trial balance carries a list of flags describing
HOW the value was extracted. Each flag has a confidence multiplier.
Row confidence = product of all flag multipliers, clamped [0, 1].

The flag enum is intentionally explicit and small — adding a new flag
is a deliberate decision (it forces the multiplier choice to be made
in one place). The multipliers below are calibrated against the
spec's per-flag confidence guidance.
"""
from __future__ import annotations

from enum import Enum
from typing import Dict


class ParseFlag(str, Enum):
    """Per-row parse provenance markers. String-valued for JSON
    serialisation; the FE renders human-readable labels via i18n keys
    keyed on the value (e.g. `confidence.flag.clean_numeric`)."""

    CLEAN_NUMERIC = "clean_numeric"
    EUROPEAN_DECIMAL_INFERRED = "european_decimal_inferred"
    CURRENCY_SYMBOL_STRIPPED = "currency_symbol_stripped"
    PARENTHESES_NEGATIVE = "parentheses_negative"
    TRAILING_MINUS = "trailing_minus"
    MERGED_CELL_SPLIT = "merged_cell_split"
    OCR_LOW_CONFIDENCE = "ocr_low_confidence"
    VALUE_COERCED = "value_coerced"
    VALUE_IMPUTED = "value_imputed"
    UNIT_ASSUMED = "unit_assumed"
    PERIOD_AMBIGUOUS = "period_ambiguous"
    SEMANTIC_FALLBACK = "semantic_fallback"   # F3.10 — name-based classification
    UNMAPPED = "unmapped"                      # F4.1 — adapter could not route
    SIDE_FLIPPED = "side_flipped"             # F3.7 — mixed-side class-4 account


# Per-flag confidence multipliers. Product of all flags' multipliers
# is the row's confidence score, clamped [0, 1].
_MULTIPLIERS: Dict[ParseFlag, float] = {
    ParseFlag.CLEAN_NUMERIC:              1.00,
    ParseFlag.EUROPEAN_DECIMAL_INFERRED:  0.97,
    ParseFlag.CURRENCY_SYMBOL_STRIPPED:   1.00,
    ParseFlag.PARENTHESES_NEGATIVE:       0.99,
    ParseFlag.TRAILING_MINUS:             0.99,
    ParseFlag.MERGED_CELL_SPLIT:          0.90,
    ParseFlag.OCR_LOW_CONFIDENCE:         0.60,
    ParseFlag.VALUE_COERCED:              0.50,
    ParseFlag.VALUE_IMPUTED:              0.30,
    ParseFlag.UNIT_ASSUMED:               0.95,
    ParseFlag.PERIOD_AMBIGUOUS:           0.70,
    ParseFlag.SEMANTIC_FALLBACK:          0.85,   # name-based routing is ~85% reliable
    ParseFlag.UNMAPPED:                   0.00,   # unmapped = no confidence
    ParseFlag.SIDE_FLIPPED:               0.92,   # side-flip detection is mostly reliable
}


# Rows that hit no positive flag get this floor — represents the base
# uncertainty of any parsed number that wasn't subjected to confidence-
# building parsing. Practically: if we have ZERO information about how
# a number was parsed, we treat it as 70% confident (better than coin
# flip; worse than verified clean).
ROW_CONFIDENCE_FLOOR = 0.70


def parse_flag_multiplier(flag: ParseFlag) -> float:
    """Return the confidence multiplier for a parse flag.
    Unknown flags (future versions) default to 0.5 — neither penalising
    nor crediting the row, while logging the unknown flag elsewhere."""
    return _MULTIPLIERS.get(flag, 0.5)


def all_flags_with_multipliers() -> Dict[str, float]:
    """For diagnostic + i18n surface — returns the full flag catalog
    as a string-keyed dict (string values are the enum's `.value`)."""
    return {flag.value: mult for flag, mult in _MULTIPLIERS.items()}
