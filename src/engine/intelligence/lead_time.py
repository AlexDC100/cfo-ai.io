"""Supplier lead-time learning.

Inputs: a sequence of (po_date, delivery_date) pairs per supplier (and
optionally per SKU).
Outputs: mean, stddev, p50, p95, plus a stationarity flag (is the supplier
getting slower? a simple split-half mean comparison).

No external dependencies — plain statistics over a list of integers.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from datetime import date
from typing import Iterable, List, Sequence, Tuple


@dataclass(frozen=True)
class LeadTimeStats:
    n: int
    mean_days: float
    stdev_days: float
    p50_days: float
    p95_days: float
    is_drifting: bool  # True if the second half's mean differs >20% from the first
    drift_pct: float


def fit_lead_time(
    po_delivery_pairs: Sequence[Tuple[date, date]],
    drift_threshold_pct: float = 20.0,
) -> LeadTimeStats:
    """Fit lead-time distribution from POs.

    Pairs ordered by po_date — drift detection compares first half vs second half.
    Negative or zero lead times are dropped (data quality issue).
    """
    if not po_delivery_pairs:
        return LeadTimeStats(0, 0.0, 0.0, 0.0, 0.0, False, 0.0)

    sorted_pairs = sorted(po_delivery_pairs, key=lambda t: t[0])
    leads: List[int] = [
        (delivery - po).days
        for po, delivery in sorted_pairs
        if (delivery - po).days > 0
    ]
    n = len(leads)
    if n == 0:
        return LeadTimeStats(0, 0.0, 0.0, 0.0, 0.0, False, 0.0)

    mean = statistics.fmean(leads)
    stdev = statistics.pstdev(leads) if n > 1 else 0.0
    p50 = float(_percentile(leads, 50))
    p95 = float(_percentile(leads, 95))

    drift_pct = 0.0
    is_drifting = False
    if n >= 6:  # need a few datapoints per half before a comparison is meaningful
        half = n // 2
        first = statistics.fmean(leads[:half])
        second = statistics.fmean(leads[half:])
        if first > 0:
            drift_pct = (second - first) / first * 100.0
            is_drifting = abs(drift_pct) > drift_threshold_pct

    return LeadTimeStats(
        n=n,
        mean_days=mean,
        stdev_days=stdev,
        p50_days=p50,
        p95_days=p95,
        is_drifting=is_drifting,
        drift_pct=drift_pct,
    )


def _percentile(values: Sequence[int], q: float) -> float:
    """Linear-interpolation percentile. Returns float — sorted in O(n log n)."""
    if not values:
        return 0.0
    s = sorted(values)
    if len(s) == 1:
        return float(s[0])
    pos = (q / 100.0) * (len(s) - 1)
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return float(s[lo])
    frac = pos - lo
    return s[lo] + (s[hi] - s[lo]) * frac
