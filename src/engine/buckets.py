"""Decision bucket taxonomy for the CFO AI product.

The engine still classifies internally with the legacy flags
(ANCHOR / ANCHOR_ALERT / ANCHOR_REVIEW / WARNING / ELIMINATE / SCALE / KEEP).
The CFO-facing product surfaces the work in six action buckets:

    PROTECT   — strategic / volume anchors, do not auto-touch
    WATCH     — important but weakening, no action today
    FIX       — actionable: renegotiate, reprice, change channel
    REDUCE    — consumes too much capital, throttle reorder/min stock
    LIQUIDATE — dead stock, negative real margin, exit
    SCALE     — high-return SKUs that deserve more capital

This module owns the mapping from (legacy flag, rule reason, absolute profit)
to a CFO bucket. The classifier still emits the legacy flag so existing tests
and storage stay green; downstream consumers read the bucket via map_bucket().
"""

from __future__ import annotations

from enum import Enum
from typing import Optional


class Bucket(str, Enum):
    PROTECT = "PROTECT"
    WATCH = "WATCH"
    FIX = "FIX"
    REDUCE = "REDUCE"
    LIQUIDATE = "LIQUIDATE"
    SCALE = "SCALE"


# Keys (lowercase) used in JSON output, frontend, and config.
BUCKET_KEYS = {
    Bucket.PROTECT: "protect",
    Bucket.WATCH: "watch",
    Bucket.FIX: "fix",
    Bucket.REDUCE: "reduce",
    Bucket.LIQUIDATE: "liquidate",
    Bucket.SCALE: "scale",
}


def map_bucket(
    flag: str,
    reason: Optional[str],
    abs_profit_kron: float,
) -> Bucket:
    """Map (legacy flag, rule reason, absolute profit) → CFO bucket.

    The mapping rules (confirmed with product):

      ANCHOR             → PROTECT
      ANCHOR_REVIEW      → PROTECT  (still protected; review is informational)
      ANCHOR_ALERT       → WATCH    (anchor with weak margin — eyes on it)

      WARNING:
        thin_real_margin / thin_margin_high_volume → FIX
        long_dio                                   → WATCH

      ELIMINATE:
        real_margin_negative           → LIQUIDATE  (bleeding cash)
        thin_margin_micro_volume       → LIQUIDATE
        micro_volume_micro_profit      → LIQUIDATE
        capital_trap | ccc_red_*       → LIQUIDATE if abs_profit ≤ 0
                                       → REDUCE    if abs_profit > 0

      SCALE              → SCALE
      KEEP               → WATCH    (default monitoring bucket)
    """
    if flag == "ANCHOR":
        return Bucket.PROTECT
    if flag == "ANCHOR_REVIEW":
        return Bucket.PROTECT
    if flag == "ANCHOR_ALERT":
        return Bucket.WATCH

    if flag == "WARNING":
        if reason in ("thin_real_margin", "thin_margin_high_volume"):
            return Bucket.FIX
        if reason == "long_dio":
            return Bucket.WATCH
        return Bucket.WATCH

    if flag == "ELIMINATE":
        if reason in ("real_margin_negative",
                      "thin_margin_micro_volume",
                      "micro_volume_micro_profit"):
            return Bucket.LIQUIDATE
        if reason in ("capital_trap", "ccc_red_low_contribution"):
            return Bucket.REDUCE if abs_profit_kron > 0 else Bucket.LIQUIDATE
        return Bucket.LIQUIDATE

    if flag == "SCALE":
        return Bucket.SCALE

    # KEEP (default) and any unrecognized flag → WATCH
    return Bucket.WATCH


def bucket_color_token(bucket: Bucket) -> str:
    """Returns the design-system color token for the bucket.

    Used by the frontend chip component. Surface here so the backend can also
    render colored CSV exports / Slack alerts consistently.
    """
    return {
        Bucket.PROTECT: "gold",
        Bucket.WATCH: "info",
        Bucket.FIX: "warning",
        Bucket.REDUCE: "warning",
        Bucket.LIQUIDATE: "danger",
        Bucket.SCALE: "success",
    }[bucket]


def bucket_priority(bucket: Bucket) -> int:
    """Sort order for surfacing buckets in the UI (lower = more urgent)."""
    return {
        Bucket.LIQUIDATE: 0,
        Bucket.FIX: 1,
        Bucket.REDUCE: 2,
        Bucket.WATCH: 3,
        Bucket.SCALE: 4,
        Bucket.PROTECT: 5,
    }[bucket]
