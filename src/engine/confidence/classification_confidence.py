"""F4.8 Signal 3 — Account classification confidence.

Per-line-item confidence in the canonical-bucket assignment. The
mapping ladder (per spec):

  - Exact match in pack's chart of accounts                → 1.00
  - Code prefix match with matching name keyword           → 0.95
  - Code prefix match only (name doesn't match expected)   → 0.90
  - Name match only (via semantic fallback / F3.10)        → 0.75
  - Fuzzy match (Levenshtein <3)                            → 0.60
  - LLM-classified fallback                                 → 0.50
  - Unmapped (no rule fired)                                → 0.00

In the current engine the per-row classification mode isn't always
tagged; we infer from the available metadata on the line_item.
"""
from __future__ import annotations

from typing import Any, Dict


def classification_confidence_for_line_item(
    line_item: Dict[str, Any],
    *,
    in_unmapped_list: bool = False,
) -> float:
    """Derive classification confidence from a line_item's metadata.

    Args:
        line_item: the dict that landed in `assembled.lineItems` OR
                   `assembled.assembled_canonical_v1.leaves` — both
                   carry `ro_account_code` + `ro_account_name`.
        in_unmapped_list: True when this account showed up in
                          `assembled.unmapped` instead of being routed
                          to a bucket. Caller decides.

    Returns:
        Confidence in [0, 1].
    """
    if in_unmapped_list:
        return 0.0

    # Explicit override: if the engine attached a confidence score, use it.
    explicit = line_item.get("classification_confidence")
    if isinstance(explicit, (int, float)):
        return max(0.0, min(1.0, float(explicit)))

    # Semantic fallback (F3.10 keyword-based routing).
    if line_item.get("via_semantic_fallback"):
        return 0.75

    # bucket_override means engine recognised a side-flip pattern.
    if line_item.get("bucket_override"):
        return 0.90   # side-flip detection is mostly reliable

    # Default path: the engine matched via the chart of accounts.
    # Without per-row tagging of "exact code+name" vs "code prefix only",
    # we credit the path at 0.95 — high but not certain. F4.8b can
    # refine when the engine tags the match mode explicitly.
    return 0.95
