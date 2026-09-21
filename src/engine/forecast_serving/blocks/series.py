"""series (plan_contract_v2 3.7): the chart series, each the integer walk
over the SAME projected periods the figures block serves (F2: the browser
never sums, accumulates or differences a served value).

Served over monthly and annual periods, never FY aggregates. A period the
partial serve of 6.5 does not reach is ``{period, refused}`` — EXCEPT the
refusal's own period, where three points are served because the engine can
defend them without the rate it cannot price (see :func:`_refusal_value`).
``dscr`` joins in B8 with metrics.py; the key is absent until then.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Sequence, Tuple

from .figures import Attribution

__all__ = ["SERIES", "build_series"]

#: key -> the figure lines the point is attributed to, and how its amount is
#: read off one projected period (``running`` is the cumulative fcf so far).
SERIES = (
    ("revenue", ("pl.revenue",)),
    ("ebitda", ("pl.ebitda",)),
    ("net_income", ("pl.net_income",)),
    ("closing_cash", ("bs.cash",)),
    ("revolver", ("bs.revolver",)),
    ("funding_draw", ("cf.funding_line_movement",)),
    ("cash_before_funding", ("bs.cash", "bs.revolver")),
    ("min_cash", ()),
    ("fcf", ("cf.cash_from_operating", "cf.cash_from_investing")),
    ("fcf_cumulative", ("cf.cash_from_operating", "cf.cash_from_investing")),
    ("st_debt", ("bs.st_debt",)),
    ("lt_debt", ("bs.lt_debt",)),
    ("capex", ("cf.capital_expenditure",)),
    ("depreciation", ("pl.depreciation",)),
)


def _value(key: str, item: Any, min_cash: int, running: int,
           attribution: Attribution) -> int:
    if key == "funding_draw":
        return item.checks["funding_line_draw_cents"]
    if key == "cash_before_funding":
        return item.bs["cash"] - item.bs["revolver"]
    if key == "min_cash":
        return min_cash
    if key == "fcf":
        return item.cf["cash_from_operating"] + item.cf["cash_from_investing"]
    if key == "fcf_cumulative":
        return running
    lines = dict(SERIES)[key]
    return attribution.amount(item, lines[0])


#: The keys a ShortfallRefusal can answer AT its own period (6.5, B6RV2-5
#: repair). ``ShortfallRefusal``'s docstring carries the argument: the first
#: shortfall accrues no funding interest (the line opens at zero), so the
#: draw and the cash before it are computable without the rate this book
#: cannot price. ``closing_cash`` and ``revolver`` are NOT — they need the
#: priced line — and nothing after this period is, because the line's
#: balance from here on depends on the rate.
REFUSAL_SERVED = ("cash_before_funding", "funding_draw", "min_cash")


def _refusal_value(key: str, shortfall: Any, min_cash: int) -> Any:
    """The point's amount at the refusal period, or None when the engine
    cannot defend one there."""
    if key == "cash_before_funding":
        return shortfall.cash_before_funding_minor
    if key == "funding_draw":
        return shortfall.amount_minor
    if key == "min_cash":
        return min_cash
    return None


def _read_refusal(key: str, label: str) -> Callable[[Any], Any]:
    """The refusal point recomputed from ANY run, the way the served one is:
    a run that refuses at the SAME period answers its own numbers, a run
    that does not refuse there answers None. That comparison is the point's
    own removal test at a period no run serves. ``min_cash`` never comes
    here — its floor is not a line of a period, so it keeps the same
    comparison the served points use."""
    def read(run: Any) -> Any:
        shortfall = None if run is None else getattr(run, "shortfall", None)
        if shortfall is None or shortfall.period.label != label:
            return None
        return _refusal_value(key, shortfall, 0)
    return read


def _read(key: str, label: str, walk: Sequence[str], min_cash: int,
          attribution: Attribution) -> Callable[[Dict[str, Any]], Any]:
    """The point's value recomputed from ANY run's {label: period}, the way
    the served one is computed; None when that run does not reach it. This is
    what makes the point's lever_ids its OWN removal test (3.7, rule of 3.6):
    a running sum still carries a lever whose window has ended, and a
    difference of two lines can stand still while both move."""
    def read(periods: Dict[str, Any]) -> Any:
        if any(l not in periods for l in walk):
            return None
        running = 0
        if key == "fcf_cumulative":
            running = sum(periods[l].cf["cash_from_operating"]
                          + periods[l].cf["cash_from_investing"] for l in walk)
        return _value(key, periods[label], min_cash, running, attribution)
    return read


def build_series(projection: Any, attribution: Attribution, min_cash: int,
                 min_cash_ids: Sequence[str], partial: Any,
                 min_cash_moved: bool) -> Dict[str, List[Dict[str, Any]]]:
    """``min_cash_moved``: the served floor differs from the book's own
    resolved one (a lever of this request set it). The floor is not a line of
    a projected period, so its removal test is that comparison."""
    served = dict((p.label, p) for p in projection.periods)
    shortfall = getattr(projection, "shortfall", None)
    cut = None if shortfall is None else shortfall.period.label
    out = dict((key, []) for key, _lines in SERIES)  # type: Dict[str, List[Dict[str, Any]]]
    running = 0
    walk = []  # type: List[str]
    for period in projection.timeline:
        item = served.get(period.label)
        if item is not None:
            running += item.cf["cash_from_operating"] + item.cf["cash_from_investing"]
            walk.append(period.label)
        for key, lines in SERIES:
            driver_ids = []  # type: List[str]
            for line in lines:
                for i in attribution.driver_ids(line):
                    if i not in driver_ids:
                        driver_ids.append(i)
            if item is None:
                amount = (None if period.label != cut
                          else _refusal_value(key, shortfall, min_cash))
                if amount is None:
                    out[key].append({"period": period.label, "refused": dict(partial)})
                    continue
                if key == "min_cash":
                    driver_ids = list(min_cash_ids)
                    lever_ids = (attribution.levers_naming("min_cash") if min_cash_moved
                                 else attribution.refused_removals())
                    joint = False
                else:
                    lever_ids, joint = attribution.lever_ids_at_refusal(
                        _read_refusal(key, period.label))
                out[key].append({"period": period.label, "amount_minor": amount,
                                 "driver_ids": driver_ids, "lever_ids": lever_ids,
                                 "joint": joint})
                continue
            if key == "min_cash":
                driver_ids = list(min_cash_ids)
                lever_ids = (attribution.levers_naming("min_cash") if min_cash_moved
                             else attribution.refused_removals())
                joint = False
            else:
                lever_ids, joint = attribution.lever_ids_of(
                    lines, _read(key, period.label,
                                 tuple(walk) if key == "fcf_cumulative" else (period.label,),
                                 min_cash, attribution))
            out[key].append({"period": period.label,
                             "amount_minor": _value(key, item, min_cash, running,
                                                    attribution),
                             "driver_ids": driver_ids, "lever_ids": lever_ids,
                             "joint": joint})
    return out
