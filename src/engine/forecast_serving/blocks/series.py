"""series (plan_contract_v2 3.7): the chart series, each the integer walk
over the SAME projected periods the figures block serves (F2: the browser
never sums, accumulates or differences a served value).

Served over monthly and annual periods, never FY aggregates. A period the
partial serve of 6.5 does not reach is ``{period, refused}``. ``dscr`` joins
in B8 with metrics.py; the key is absent until then.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Sequence, Tuple

from .figures import Attribution, amount_of

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


def _value(key: str, item: Any, min_cash: int, running: int) -> int:
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
    return amount_of(item, lines[0])


def build_series(projection: Any, attribution: Attribution, min_cash: int,
                 min_cash_ids: Sequence[str], partial: Any) -> Dict[str, List[Dict[str, Any]]]:
    served = dict((p.label, p) for p in projection.periods)
    out = dict((key, []) for key, _lines in SERIES)  # type: Dict[str, List[Dict[str, Any]]]
    running = 0
    for period in projection.timeline:
        item = served.get(period.label)
        if item is not None:
            running += item.cf["cash_from_operating"] + item.cf["cash_from_investing"]
        for key, lines in SERIES:
            if item is None:
                out[key].append({"period": period.label, "refused": dict(partial)})
                continue
            driver_ids = []  # type: List[str]
            lever_ids = []  # type: List[str]
            joint = False
            for line in lines:
                for i in attribution.driver_ids(line):
                    if i not in driver_ids:
                        driver_ids.append(i)
                ids, j = attribution.lever_ids(line, period.label)
                joint = joint or j
                for i in ids:
                    if i not in lever_ids:
                        lever_ids.append(i)
            if key == "min_cash":
                driver_ids = list(min_cash_ids)
            out[key].append({"period": period.label,
                             "amount_minor": _value(key, item, min_cash, running),
                             "driver_ids": driver_ids, "lever_ids": lever_ids,
                             "joint": joint})
    return out
