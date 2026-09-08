"""The projection calendar. Deterministic, and derived from the BOOK.

The anchor is the source period's END DATE, read off the book being
projected — never ``date.today()``. A forecast produced in March and the
same forecast produced in November must be byte-identical, so no clock
is consulted anywhere in this package (F3).

GRANULARITY: cash timing matters in year one and stops mattering after
it, so year one is monthly or quarterly (configurable) and every later
year is annual. That is the shape a Romanian bank's credit file and an
EU grant application both ask for.

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

import calendar as _calendar
from datetime import date, timedelta
from typing import List, Tuple

from .errors import AssumptionError

__all__ = ["Period", "GRANULARITIES", "build_timeline", "add_months"]

#: Year-one granularities. Annual is allowed (a grant annex that only
#: wants years), but monthly is the default because the funding-gap line
#: is invisible at annual resolution — a company can be cash-negative in
#: March and cash-positive on 31 December.
GRANULARITIES = ("monthly", "quarterly", "annual")

_MONTHS_PER = {"monthly": 1, "quarterly": 3, "annual": 12}


def add_months(anchor: date, months: int) -> date:
    """``anchor`` shifted by whole months, clamped to the target month's
    length. A 31 December anchor + 1 month is 31 January; a 31 January
    anchor + 1 month is 28 (or 29) February. Pure arithmetic."""
    total = anchor.month - 1 + months
    year = anchor.year + total // 12
    month = total % 12 + 1
    last = _calendar.monthrange(year, month)[1]
    return date(year, month, min(anchor.day, last))


class Period(object):
    """One projected period: its dates, its day count, its label."""

    __slots__ = ("index", "label", "start", "end", "days", "granularity",
                 "year_offset")

    def __init__(self, index: int, label: str, start: date, end: date,
                 granularity: str, year_offset: int) -> None:
        self.index = index
        self.label = label
        self.start = start
        self.end = end
        self.days = (end - start).days + 1
        self.granularity = granularity
        self.year_offset = year_offset

    def as_dict(self):
        return {
            "index": self.index,
            "label": self.label,
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "days": self.days,
            "granularity": self.granularity,
            "year_offset": self.year_offset,
        }

    def __repr__(self):  # pragma: no cover - debugging aid
        return "Period(%d, %r, %s..%s, %dd)" % (
            self.index, self.label, self.start, self.end, self.days)


def _label(granularity: str, start: date, end: date) -> str:
    if granularity == "monthly":
        return "%04d-%02d" % (end.year, end.month)
    if granularity == "quarterly":
        return "%04d-Q%d" % (end.year, (end.month - 1) // 3 + 1)
    return "FY%04d" % end.year


def build_timeline(anchor_period_end: date, horizon_years: int,
                   year_one_granularity: str = "monthly") -> Tuple[Period, ...]:
    """Periods covering ``horizon_years`` years after ``anchor_period_end``.

    Year one is split per ``year_one_granularity``; every subsequent year
    is one annual period. The first period starts the day after the
    anchor, and periods tile the horizon with no gap and no overlap —
    asserted by :func:`assert_contiguous`, which the projector runs.
    """
    if horizon_years < 1:
        raise AssumptionError("horizon_years", "must be at least 1, got %r"
                              % (horizon_years,))
    if year_one_granularity not in GRANULARITIES:
        raise AssumptionError(
            "year_one_granularity",
            "must be one of %s, got %r" % (", ".join(GRANULARITIES),
                                           year_one_granularity),
        )
    step = _MONTHS_PER[year_one_granularity]
    periods = []  # type: List[Period]
    cursor = anchor_period_end
    index = 0
    for k in range(12 // step):
        start = cursor + timedelta(days=1)
        end = add_months(anchor_period_end, (k + 1) * step)
        periods.append(Period(index, _label(year_one_granularity, start, end),
                              start, end, year_one_granularity, 1))
        cursor = end
        index += 1
    for year in range(2, horizon_years + 1):
        start = cursor + timedelta(days=1)
        end = add_months(anchor_period_end, year * 12)
        periods.append(Period(index, _label("annual", start, end), start, end,
                              "annual", year))
        cursor = end
        index += 1
    assert_contiguous(anchor_period_end, periods)
    return tuple(periods)


def assert_contiguous(anchor_period_end: date, periods) -> None:
    """No gap, no overlap, nothing before the anchor. A day that belongs
    to no period is a day of revenue the projection silently loses."""
    cursor = anchor_period_end
    for period in periods:
        if period.start != cursor + timedelta(days=1):
            raise AssumptionError(
                "timeline",
                "period %s starts %s but the previous period ends %s"
                % (period.label, period.start, cursor),
            )
        if period.end < period.start:
            raise AssumptionError(
                "timeline",
                "period %s ends %s before it starts %s"
                % (period.label, period.end, period.start),
            )
        cursor = period.end
