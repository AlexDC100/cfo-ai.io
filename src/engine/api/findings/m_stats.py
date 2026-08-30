"""ROBUST STATISTICS FOR SHORT, DIRTY SERIES.

A company history is four to eight points long, at least one of which is
a year-end reclassification. Mean and standard deviation are the wrong
tools for that shape: a single restatement drags the mean toward itself
and inflates the standard deviation, so the outlier hides its own
detection. Everything here is therefore MEDIAN-based —

    median          the centre
    MAD             the spread (median absolute deviation, scaled by
                    1.4826 so it estimates the same quantity as a normal
                    standard deviation)
    robust z        deviation over scaled MAD
    Theil–Sen       the slope, as the median of all pairwise slopes

— and every one of them REFUSES rather than degrades:

    * a CONSTANT series is a refusal, not an infinite z. A line that has
      not moved has no dispersion to measure a movement against, and a
      divide-by-almost-nothing is how a rounding difference becomes a
      "critical" alert. The narrower case where ties have collapsed the
      MAD to zero but the series is not constant falls back to a named,
      weaker estimator that the finding discloses — see
      :class:`Dispersion`.
    * fewer points than the caller declared is a refusal, raised as
      `NeedsHistoryError` from the window types in `m_series`, so it
      never reaches this module.

THE RATIO LAW (F5)
Every quotient of two MONEY quantities in this module goes through
`_ratio_units.ratio`, so a currency or scale boundary raises instead of
producing a number. The single division whose operands are deliberately
of different kinds — a dimensionless share over a COUNT of periods — is
:func:`per_period`, which is written out explicitly with its own guard
precisely so it cannot be mistaken for an unchecked division.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

from .. import _ratio_units

#: Consistency constant: for normally distributed data,
#: 1.4826 * MAD estimates the standard deviation. Named rather than
#: inlined so the assumption it encodes is visible.
MAD_TO_SIGMA = 1.4826

#: The same job for the MEAN absolute deviation, used only in the tie
#: case below. sqrt(pi/2), to 4 places.
MEANAD_TO_SIGMA = 1.2533

METHOD_MAD = "scaled_mad"
METHOD_MEAN_AD = "scaled_mean_absolute_deviation"


class DispersionUndefinedError(ValueError):
    """The series has no spread to measure a deviation against. Refused
    rather than returned as an enormous z — ABSENT dispersion is not
    ZERO dispersion with a very large quotient."""


@dataclass(frozen=True)
class Dispersion:
    """A scale estimate WITH the method that produced it.

    The method matters to a reader, and it matters honestly: MAD has a
    known breakdown when at least half the sample is identical. Four
    movements of 400k, 400k, 400k and 10.8M have a MAD of exactly ZERO —
    the three ties are the median, their deviations are zero, and the
    median deviation is zero too. Refusing there would throw away the
    clearest outlier in the series; pretending the MAD was usable would
    divide by nothing.

    So a tied sample falls back to the scaled MEAN absolute deviation,
    which is not resistant to the outlier it is measuring and therefore
    UNDERSTATES the score — a conservative direction — and the method is
    carried out of here so the finding can disclose it. Only a genuinely
    CONSTANT sample is refused, because that one really does have no
    spread.
    """

    scale: float
    method: str
    centre: float
    n: int

    def is_fallback(self) -> bool:
        return self.method != METHOD_MAD

    def caveat(self) -> Optional[str]:
        if not self.is_fallback():
            return None
        return ("The spread of this line's own history was measured with the "
                "mean absolute deviation because at least half of its %d "
                "movements are identical, which collapses the median "
                "absolute deviation to zero; the deviation score is therefore "
                "understated rather than overstated." % self.n)


def median(values: Sequence[float]) -> float:
    """The middle value; the mean of the two middle values for an even
    count. Refuses an empty sequence — a median of nothing is not zero."""
    if not values:
        raise ValueError("median of an empty series is undefined, not zero")
    ordered = sorted(float(v) for v in values)
    n = len(ordered)
    mid = n // 2
    if n % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def mad(values: Sequence[float], centre: Optional[float] = None) -> float:
    """Median absolute deviation, SCALED to sigma-equivalent units.

    Returned in the same units as the input (money in, money out), so the
    z-score below is a money/money quotient and goes through the ratio
    law like every other one.
    """
    if not values:
        raise ValueError("MAD of an empty series is undefined, not zero")
    med = median(values) if centre is None else float(centre)
    return MAD_TO_SIGMA * median([abs(float(v) - med) for v in values])


def dispersion(values: Sequence[float]) -> Dispersion:
    """The series' own spread, with the method named.

    Scaled MAD where it works; the scaled mean absolute deviation where
    ties have collapsed it; a refusal where the sample is constant. See
    :class:`Dispersion` for why the middle case is not simply refused.
    """
    if not values:
        raise DispersionUndefinedError(
            "an empty series has no dispersion to measure against")
    med = median(values)
    scale = mad(values, centre=med)
    if scale > 0.0:
        return Dispersion(scale=scale, method=METHOD_MAD, centre=med,
                          n=len(values))
    deviations = [abs(float(v) - med) for v in values]
    total = sum(deviations)
    if total <= 0.0:
        raise DispersionUndefinedError(
            "the series is constant (%d point(s), every value %r); a robust z "
            "against it is undefined, not infinite" % (len(values), med))
    mean_ad = MEANAD_TO_SIGMA * (total / float(len(deviations)))
    return Dispersion(scale=mean_ad, method=METHOD_MEAN_AD, centre=med,
                      n=len(values))


def robust_z(value: float, values: Sequence[float], currency: str,
             name: str = "deviation") -> float:
    """How far `value` sits from the series' own centre, in sigma-
    equivalent units. Both operands are money in the SAME currency, so
    the quotient is dimensionless and is taken by `_ratio_units.ratio`."""
    spread = dispersion(values)
    return _ratio_units.ratio(
        _ratio_units.money(abs(float(value) - spread.centre), currency,
                           name=name),
        _ratio_units.money(spread.scale, currency, name=spread.method),
    )


def per_period(delta: float, periods: int) -> float:
    """A change PER PERIOD.

    The one division in the lane whose operands are deliberately of
    different kinds: a dimensionless share in the numerator and a COUNT
    of periods in the denominator. `_ratio_units.ratio` refuses that pair
    by design — it exists to stop a money/percent or a RON/kRON quotient
    — so the guard is written out here instead: the span must be a
    positive whole number of periods, and a zero span refuses rather than
    returning an infinity that would render as a slope.
    """
    span = int(periods)
    if span <= 0:
        raise _ratio_units.UndefinedRatioError(
            "a change across %d period(s) is not a rate — the span must be "
            "at least one period" % span)
    return float(delta) / float(span)


def theil_sen(points: Sequence[Tuple[float, float]]) -> Tuple[float, float]:
    """Slope and agreement of the median pairwise slope.

    `points` are (x, y) with x a period INDEX and y a dimensionless share.
    Returns `(slope_per_period, agreement)` where agreement is the share
    of pairwise slopes carrying the same sign as the median — a
    consistency measure that a least-squares fit does not give you, and
    the thing that separates "declining for four periods" from "noisy
    around a flat line with one bad quarter".

    Refuses fewer than two points: a slope through one point is a
    fabrication, which is the failure this whole lane is built to remove.
    """
    if len(points) < 2:
        raise ValueError(
            "a slope needs at least two points; %d supplied" % len(points))
    slopes = []  # type: List[float]
    ordered = sorted((float(x), float(y)) for x, y in points)
    for i in range(len(ordered)):
        for j in range(i + 1, len(ordered)):
            dx = ordered[j][0] - ordered[i][0]
            if dx <= 0:
                continue
            slopes.append(per_period(ordered[j][1] - ordered[i][1], int(round(dx))))
    if not slopes:
        raise ValueError(
            "every pair of points shares an x value; there is no span to "
            "measure a slope across")
    slope = median(slopes)
    if slope == 0.0:
        agreement = _share_of([s for s in slopes if s == 0.0], slopes)
    else:
        sign = 1.0 if slope > 0 else -1.0
        agreement = _share_of([s for s in slopes if s * sign > 0], slopes)
    return slope, agreement


def project(latest: float, slope: float, horizon: int,
            floor: Optional[float] = None) -> float:
    """Extend the fitted slope `horizon` periods forward.

    A projection, labelled as one everywhere it is rendered. `floor`
    clamps the result (a share of total assets below zero is not a
    forecast, it is arithmetic running off the end of its own domain);
    the caller carries the clamp into its confidence caveat.
    """
    value = float(latest) + float(slope) * int(horizon)
    if floor is not None and value < floor:
        return float(floor)
    return value


def trailing_run(values: Sequence[float], direction: str) -> int:
    """Length of the run of ADJACENT movements at the end of the series
    that all go the declared way.

    `values` are the levels; the run counts MOVEMENTS, so a run of 3
    means four readings each worse than the last. A flat step (exactly
    zero movement) ends the run — a line that did not move did not
    continue a decline.
    """
    count = 0
    for i in range(len(values) - 1, 0, -1):
        step = float(values[i]) - float(values[i - 1])
        if direction == "up" and step > 0:
            count += 1
        elif direction == "down" and step < 0:
            count += 1
        else:
            break
    return count


def unchanged_run(values: Sequence[float], tolerance_share: float) -> int:
    """Length of the run of adjacent movements at the end of the series
    that are all inside `tolerance_share` of the standing balance.

    Dormancy, in other words. The tolerance is relative to the balance so
    a rounding cent on a 7 million balance is dormant and a 3% move on
    the same balance is not.
    """
    count = 0
    for i in range(len(values) - 1, 0, -1):
        level = abs(float(values[i]))
        step = abs(float(values[i]) - float(values[i - 1]))
        if level == 0.0:
            break
        if step <= abs(float(tolerance_share)) * level:
            count += 1
        else:
            break
    return count


def _share_of(subset: Sequence[float], whole: Sequence[float]) -> float:
    """A count over a count. Both are `count` quantities, so the quotient
    is taken by the ratio law like every other one in the lane."""
    return _ratio_units.ratio(
        _ratio_units.count(float(len(subset)), name="matching"),
        _ratio_units.count(float(len(whole)), name="total"),
    )


__all__ = [
    "Dispersion", "DispersionUndefinedError", "MAD_TO_SIGMA",
    "MEANAD_TO_SIGMA", "METHOD_MAD", "METHOD_MEAN_AD",
    "dispersion", "mad", "median", "per_period", "project", "robust_z",
    "theil_sen", "trailing_run", "unchanged_run",
]
