"""Phase 3 intelligence layer — seasonality, lead-time learning, reorder points.

Each module is pure (numpy/pandas in, dataclasses out) so it can run in batch
or be wrapped in HTTP/PG layers later. They depend on time-series inputs that
the Phase 1 fixture doesn't carry — synthetic generators in tests provide
known-pattern data so the algorithms have something to fit against.
"""

from .seasonality import (
    SeasonalityResult,
    detect_seasonality,
    seasonal_index,
)
from .lead_time import (
    LeadTimeStats,
    fit_lead_time,
)
from .reorder import (
    ReorderRecommendation,
    recommend_reorder_point,
)

__all__ = [
    "SeasonalityResult",
    "detect_seasonality",
    "seasonal_index",
    "LeadTimeStats",
    "fit_lead_time",
    "ReorderRecommendation",
    "recommend_reorder_point",
]
