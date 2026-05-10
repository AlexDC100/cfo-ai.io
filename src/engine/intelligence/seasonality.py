"""Monthly seasonality detection.

Algorithm:
  1. Aggregate the time-series to month-of-year (Jan..Dec).
  2. Compute multiplicative seasonal index per month: mean(month) / mean(all).
  3. Declare the series 'seasonal' if max/min index ratio exceeds a threshold.

This is intentionally simple — no FFT, no STL, no statsmodels dependency.
Once the warehouse has 2+ years of weekly data we can swap in a real STL/ETS
fit; the public API (`SeasonalityResult`) stays the same.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Tuple

import pandas as pd


# Minimum amplitude for the seasonality flag to fire.
# A peak month 30% above the trough → "seasonal enough to plan around".
DEFAULT_AMPLITUDE_RATIO = 1.30


@dataclass(frozen=True)
class SeasonalityResult:
    is_seasonal: bool
    amplitude_ratio: float  # max_index / min_index
    peak_month: int  # 1..12
    trough_month: int  # 1..12
    monthly_indices: Dict[int, float] = field(default_factory=dict)
    n_periods_observed: int = 0
    notes: str = ""


def detect_seasonality(
    series: pd.Series,
    amplitude_threshold: float = DEFAULT_AMPLITUDE_RATIO,
) -> SeasonalityResult:
    """Detect monthly seasonality in a date-indexed numeric Series.

    `series.index` must be datetime-like; values can be sales (units, RON, kRON).
    """
    if not isinstance(series.index, pd.DatetimeIndex):
        raise TypeError("series must have a DatetimeIndex")
    if series.empty:
        return SeasonalityResult(
            is_seasonal=False,
            amplitude_ratio=1.0,
            peak_month=0,
            trough_month=0,
            n_periods_observed=0,
            notes="empty series",
        )

    monthly = series.groupby(series.index.month).mean()
    overall = series.mean()
    if overall == 0:
        return SeasonalityResult(
            is_seasonal=False,
            amplitude_ratio=1.0,
            peak_month=0,
            trough_month=0,
            n_periods_observed=len(series),
            notes="zero mean — undefined seasonality",
        )

    indices: Dict[int, float] = {int(m): float(v / overall) for m, v in monthly.items()}
    max_m, max_v = max(indices.items(), key=lambda kv: kv[1])
    min_m, min_v = min(indices.items(), key=lambda kv: kv[1])
    ratio = max_v / min_v if min_v > 0 else float("inf")

    months_covered = series.index.month.nunique()
    notes = (
        ""
        if months_covered >= 12
        else f"only {months_covered}/12 calendar months observed — pattern may be biased"
    )

    return SeasonalityResult(
        is_seasonal=ratio >= amplitude_threshold,
        amplitude_ratio=ratio,
        peak_month=max_m,
        trough_month=min_m,
        monthly_indices=indices,
        n_periods_observed=len(series),
        notes=notes,
    )


def seasonal_index(result: SeasonalityResult, month: int) -> float:
    """Lookup index for a month; defaults to 1.0 if month not observed."""
    return result.monthly_indices.get(month, 1.0)
