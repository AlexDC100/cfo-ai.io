"""The projection calendar. Deterministic, and derived from the BOOK.

The anchor is the source period's END DATE, read off the book being
projected — never ``date.today()``. A forecast produced in March and the
same forecast produced in November must be byte-identical, so no clock
is consulted anywhere in this package (F3).

GRANULARITY: cash timing matters in the near term and stops mattering
after it, so the first ``monthly_months`` months (12 or 24) are monthly
and every later plan year is one annual period (plan_contract_v2 6.1).
Monthly periods carry ``year_offset = (k - 1) // 12 + 1`` so per-year
schedules, dividends and year-to-date tax key on the plan year, never on
the period's granularity. Quarterly periods no longer exist: the monthly
window is what the funding line and the runway read, and a quarter hides
the month a shortfall falls in.

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

import calendar as _calendar
from datetime import date, timedelta
from typing import List, Tuple

from .errors import AssumptionError

__all__ = ["Period", "MONTHLY_MONTHS", "build_timeline", "add_months"]

#: The monthly windows a plan may carry (contract 2.2). A whole number of
#: plan years, so a monthly period never straddles two of them.
MONTHLY_MONTHS = (12, 24)


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
    return "FY%04d" % end.year


def _whole(name: str, value) -> int:
    """A whole, non-boolean count, or a refusal naming the field. A float
    that happens to be integral is still refused: the request carries
    these as integers, and a silent floor is a different plan."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise AssumptionError(
            name, "is a whole count, and %r is not one" % (value,))
    return value


def build_timeline(anchor_period_end: date, total_years: int,
                   monthly_months: int) -> Tuple[Period, ...]:
    """Periods covering ``total_years`` plan years after the anchor.

    Months ``k = 1 .. monthly_months`` are monthly periods with
    ``year_offset = (k - 1) // 12 + 1``; each plan year after the monthly
    window is one annual period. The first period starts the day after
    the anchor, and periods tile the horizon with no gap and no overlap —
    asserted by :func:`assert_contiguous`, which the projector runs.
    """
    total_years = _whole("total_years", total_years)
    monthly_months = _whole("monthly_months", monthly_months)
    if total_years < 1:
        raise AssumptionError("total_years", "must be at least 1, got %r"
                              % (total_years,))
    if monthly_months not in MONTHLY_MONTHS:
        raise AssumptionError(
            "monthly_months",
            "must be one of %s, got %r"
            % (", ".join(str(m) for m in MONTHLY_MONTHS), monthly_months))
    if total_years * 12 < monthly_months:
        raise AssumptionError(
            "monthly_months",
            "%d monthly months do not fit inside %d plan year(s) of %d "
            "months" % (monthly_months, total_years, total_years * 12))
    periods = []  # type: List[Period]
    cursor = anchor_period_end
    index = 0
    for k in range(1, monthly_months + 1):
        start = cursor + timedelta(days=1)
        end = add_months(anchor_period_end, k)
        periods.append(Period(index, _label("monthly", start, end),
                              start, end, "monthly", (k - 1) // 12 + 1))
        cursor = end
        index += 1
    for year in range(monthly_months // 12 + 1, total_years + 1):
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
