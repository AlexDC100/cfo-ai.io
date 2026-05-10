"""Reorder point recommendation.

Standard formula (variable demand AND lead time, normal-approximation):

    ROP = µ_d * µ_LT + z * sqrt(µ_LT * σ_d² + µ_d² * σ_LT²)

where µ_d, σ_d are daily-demand mean/stddev and µ_LT, σ_LT are lead-time
mean/stddev. z is the z-score for the desired service level.

If a SeasonalityResult is supplied, the daily-demand mean is multiplied by
the index for the upcoming month — protects against ordering at trough rates
right before peak demand.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from .lead_time import LeadTimeStats
from .seasonality import SeasonalityResult, seasonal_index


# z-scores for common service levels — encoded so we don't pull in scipy.
# (Right-tail of standard normal; e.g. 95% service ≈ 1.645 σ above mean demand.)
_SERVICE_LEVEL_Z = {
    0.50: 0.000,
    0.80: 0.842,
    0.90: 1.282,
    0.95: 1.645,
    0.97: 1.881,
    0.98: 2.054,
    0.99: 2.326,
    0.995: 2.576,
}


@dataclass(frozen=True)
class ReorderRecommendation:
    rop_units: float
    safety_stock_units: float
    expected_demand_during_lead_time: float
    service_level: float
    z_score: float
    rationale: str


def recommend_reorder_point(
    daily_demand_mean: float,
    daily_demand_stdev: float,
    lead_time: LeadTimeStats,
    service_level: float = 0.95,
    seasonality: Optional[SeasonalityResult] = None,
    upcoming_month: Optional[int] = None,
) -> ReorderRecommendation:
    """Compute ROP + safety stock for a single SKU.

    `service_level` must be one of the supported keys (0.50..0.995). Anything
    else raises — picking an arbitrary z by interpolation hides intent.
    """
    if service_level not in _SERVICE_LEVEL_Z:
        raise ValueError(
            f"Unsupported service_level {service_level}. "
            f"Choose from {sorted(_SERVICE_LEVEL_Z)}"
        )
    if lead_time.n == 0:
        return ReorderRecommendation(
            rop_units=0.0,
            safety_stock_units=0.0,
            expected_demand_during_lead_time=0.0,
            service_level=service_level,
            z_score=_SERVICE_LEVEL_Z[service_level],
            rationale="no lead-time history — cannot recommend",
        )

    z = _SERVICE_LEVEL_Z[service_level]

    # Apply seasonal index if available — reorder for the *upcoming* month's demand.
    seasonal_factor = 1.0
    if seasonality is not None and upcoming_month is not None and seasonality.is_seasonal:
        seasonal_factor = seasonal_index(seasonality, upcoming_month)
    adjusted_mean = daily_demand_mean * seasonal_factor

    expected_demand = adjusted_mean * lead_time.mean_days
    variance = (
        lead_time.mean_days * (daily_demand_stdev ** 2)
        + (adjusted_mean ** 2) * (lead_time.stdev_days ** 2)
    )
    safety = z * math.sqrt(variance)
    rop = expected_demand + safety

    rationale_parts = [
        f"µ_d={daily_demand_mean:.2f}",
        f"σ_d={daily_demand_stdev:.2f}",
        f"µ_LT={lead_time.mean_days:.1f}d",
        f"σ_LT={lead_time.stdev_days:.1f}d",
        f"z={z}",
    ]
    if seasonal_factor != 1.0:
        rationale_parts.append(f"seasonal×{seasonal_factor:.2f}")
    if lead_time.is_drifting:
        rationale_parts.append(f"⚠ supplier drifting {lead_time.drift_pct:+.0f}%")

    return ReorderRecommendation(
        rop_units=rop,
        safety_stock_units=safety,
        expected_demand_during_lead_time=expected_demand,
        service_level=service_level,
        z_score=z,
        rationale=", ".join(rationale_parts),
    )
