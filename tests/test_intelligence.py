"""Phase 3 intelligence tests — synthetic series with known patterns."""

from __future__ import annotations

import math
from datetime import date, timedelta
from typing import List, Tuple

import numpy as np
import pandas as pd
import pytest

from engine.intelligence import (
    LeadTimeStats,
    ReorderRecommendation,
    SeasonalityResult,
    detect_seasonality,
    fit_lead_time,
    recommend_reorder_point,
    seasonal_index,
)


# ─────────── Seasonality ───────────


def _monthly_series(monthly_values_2y: List[float]) -> pd.Series:
    """Build a Series of 24 monthly observations starting Jan 2024."""
    idx = pd.date_range("2024-01-01", periods=len(monthly_values_2y), freq="MS")
    return pd.Series(monthly_values_2y, index=idx)


def test_flat_series_is_not_seasonal() -> None:
    flat = _monthly_series([100.0] * 24)
    r = detect_seasonality(flat)
    assert r.is_seasonal is False
    assert r.amplitude_ratio == pytest.approx(1.0)


def test_strong_summer_peak_detected() -> None:
    """Series with 2x summer peak vs winter — clearly seasonal."""
    pattern = [50, 50, 60, 70, 90, 110, 120, 110, 90, 70, 60, 50]  # winter low, summer high
    r = detect_seasonality(_monthly_series(pattern * 2))  # 2 years
    assert r.is_seasonal is True
    assert r.peak_month in (6, 7)
    assert r.trough_month in (1, 2, 12)
    assert r.amplitude_ratio > 2.0


def test_seasonality_threshold_respects_minor_variation() -> None:
    """Tiny 10% variation should not be flagged seasonal at default threshold."""
    pattern = [100, 102, 103, 105, 108, 110, 109, 107, 104, 102, 101, 100]
    r = detect_seasonality(_monthly_series(pattern * 2))
    assert r.is_seasonal is False


def test_partial_year_warns() -> None:
    """Only 6 months observed → pattern flagged as biased."""
    series = _monthly_series([100, 200, 100, 200, 100, 200])
    r = detect_seasonality(series)
    assert "biased" in r.notes


def test_zero_mean_handled() -> None:
    series = _monthly_series([0.0] * 12)
    r = detect_seasonality(series)
    assert r.is_seasonal is False
    assert "zero mean" in r.notes


def test_seasonal_index_lookup() -> None:
    pattern = [50, 50, 60, 70, 90, 110, 120, 110, 90, 70, 60, 50]
    r = detect_seasonality(_monthly_series(pattern * 2))
    assert seasonal_index(r, r.peak_month) > 1.0
    assert seasonal_index(r, r.trough_month) < 1.0
    assert seasonal_index(r, 99) == 1.0  # unknown month → neutral


def test_non_datetime_index_raises() -> None:
    bad = pd.Series([1, 2, 3], index=[1, 2, 3])
    with pytest.raises(TypeError):
        detect_seasonality(bad)


# ─────────── Lead time ───────────


def _po_pairs(lead_days: List[int], start: date = date(2025, 1, 1)) -> List[Tuple[date, date]]:
    return [(start + timedelta(days=i * 7), start + timedelta(days=i * 7 + ld))
            for i, ld in enumerate(lead_days)]


def test_lead_time_no_data() -> None:
    r = fit_lead_time([])
    assert r.n == 0
    assert r.mean_days == 0.0
    assert r.is_drifting is False


def test_lead_time_constant() -> None:
    r = fit_lead_time(_po_pairs([10] * 8))
    assert r.n == 8
    assert r.mean_days == pytest.approx(10.0)
    assert r.stdev_days == pytest.approx(0.0)
    assert r.p50_days == pytest.approx(10.0)


def test_lead_time_p95_higher_than_p50() -> None:
    leads = [5, 6, 6, 7, 7, 8, 8, 9, 10, 30]  # one outlier
    r = fit_lead_time(_po_pairs(leads))
    assert r.p95_days > r.p50_days
    assert r.mean_days < r.p95_days  # outlier inflates p95 more than mean


def test_lead_time_drift_detected() -> None:
    """Second half mean is 50% higher than first half — supplier slowing down."""
    leads = [10, 10, 10, 10, 10, 10, 15, 15, 15, 15, 15, 15]
    r = fit_lead_time(_po_pairs(leads))
    assert r.is_drifting is True
    assert r.drift_pct == pytest.approx(50.0, abs=1.0)


def test_lead_time_no_drift_below_threshold() -> None:
    """5% variance in second half — well under 20% threshold."""
    leads = [10, 10, 10, 10, 10, 10, 11, 10, 11, 10, 11, 10]
    r = fit_lead_time(_po_pairs(leads))
    assert r.is_drifting is False


def test_lead_time_skip_negative() -> None:
    """Bad data (delivery before PO) is dropped silently."""
    pairs = [
        (date(2025, 1, 1), date(2025, 1, 11)),
        (date(2025, 1, 8), date(2025, 1, 1)),  # negative
        (date(2025, 1, 15), date(2025, 1, 25)),
    ]
    r = fit_lead_time(pairs)
    assert r.n == 2
    assert r.mean_days == pytest.approx(10.0)


# ─────────── Reorder point ───────────


def test_rop_no_lead_time_history() -> None:
    lt = LeadTimeStats(0, 0, 0, 0, 0, False, 0)
    r = recommend_reorder_point(daily_demand_mean=10, daily_demand_stdev=2, lead_time=lt)
    assert r.rop_units == 0.0
    assert "no lead-time history" in r.rationale


def test_rop_zero_variance() -> None:
    """With deterministic demand AND lead time, ROP = µ_d × µ_LT, safety = 0."""
    lt = LeadTimeStats(n=10, mean_days=7.0, stdev_days=0.0, p50_days=7, p95_days=7,
                       is_drifting=False, drift_pct=0)
    r = recommend_reorder_point(daily_demand_mean=10, daily_demand_stdev=0,
                                lead_time=lt, service_level=0.95)
    assert r.expected_demand_during_lead_time == pytest.approx(70.0)
    assert r.safety_stock_units == pytest.approx(0.0)
    assert r.rop_units == pytest.approx(70.0)


def test_rop_safety_stock_scales_with_service_level() -> None:
    lt = LeadTimeStats(n=10, mean_days=7, stdev_days=2, p50_days=7, p95_days=11,
                       is_drifting=False, drift_pct=0)
    low = recommend_reorder_point(10, 2, lt, service_level=0.80)
    high = recommend_reorder_point(10, 2, lt, service_level=0.99)
    assert high.safety_stock_units > low.safety_stock_units
    assert high.rop_units > low.rop_units


def test_rop_unknown_service_level_raises() -> None:
    lt = LeadTimeStats(n=10, mean_days=7, stdev_days=2, p50_days=7, p95_days=11,
                       is_drifting=False, drift_pct=0)
    with pytest.raises(ValueError, match="Unsupported service_level"):
        recommend_reorder_point(10, 2, lt, service_level=0.93)


def test_rop_seasonality_lifts_demand_for_peak_month() -> None:
    """Reordering for July, with summer peak — expected demand inflated."""
    pattern = [50, 50, 60, 70, 90, 110, 120, 110, 90, 70, 60, 50]
    seas = detect_seasonality(_monthly_series(pattern * 2))
    lt = LeadTimeStats(n=10, mean_days=10, stdev_days=2, p50_days=10, p95_days=14,
                       is_drifting=False, drift_pct=0)
    july = recommend_reorder_point(10, 2, lt, service_level=0.95,
                                   seasonality=seas, upcoming_month=7)
    jan = recommend_reorder_point(10, 2, lt, service_level=0.95,
                                  seasonality=seas, upcoming_month=1)
    assert july.expected_demand_during_lead_time > jan.expected_demand_during_lead_time
    assert "seasonal×" in july.rationale


def test_rop_drift_warning_appears_in_rationale() -> None:
    lt = LeadTimeStats(n=12, mean_days=12, stdev_days=3, p50_days=12, p95_days=18,
                       is_drifting=True, drift_pct=35.0)
    r = recommend_reorder_point(10, 2, lt)
    assert "drifting" in r.rationale
