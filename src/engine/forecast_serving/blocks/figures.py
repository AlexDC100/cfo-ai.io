"""figures (plan_contract_v2 3.6): every projected line of every served
period, then the FY aggregates of each monthly plan year.

Integer minor units read straight off ``ProjectedPeriod`` (3.12); no float.
A figure carries ids, never basis prose: its reasons resolve through
``drivers`` and ``conventions`` at the root.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

__all__ = ["Attribution", "build_figures", "monthly_years", "amount_of"]

FLOW_SECTIONS = ("pl", "cf")
#: cash-flow lines that are balances, not flows: an FY aggregate takes the
#: first month's opening and the last month's closing, never a sum.
CF_OPENING, CF_CLOSING = "cf.opening_cash", "cf.closing_cash"


def _totals(period: Any) -> Dict[str, int]:
    """The five balance-sheet totals, summed BY THE ENGINE in integer minor
    units over the engine's own line groups (F2: the browser never sums)."""
    from engine.forecast.project import (CURRENT_ASSET_LINES,
                                         CURRENT_LIABILITY_LINES, EQUITY_LINES)
    return {"assets": period.total_assets_cents(),
            "equity_plus_liabilities": period.total_el_cents(),
            "current_assets": sum(period.bs[l] for l in CURRENT_ASSET_LINES),
            "current_liabilities": sum(period.bs[l] for l in CURRENT_LIABILITY_LINES),
            "equity": sum(period.bs[l] for l in EQUITY_LINES)}


def amount_of(period: Any, line: str) -> int:
    section, name = line.split(".", 1)
    if section == "bs_totals":
        return _totals(period)[name]
    return getattr(period, section)[name]


def monthly_years(timeline: Sequence[Any]) -> "List[Tuple[int, str, List[Any]]]":
    """(plan year, FY label, its monthly timeline periods) per monthly year."""
    years = {}  # type: Dict[int, List[Any]]
    for period in timeline:
        if period.granularity == "monthly":
            years.setdefault(period.year_offset, []).append(period)
    return [(n, "FY%d" % max(p.end for p in years[n]).year, years[n])
            for n in sorted(years)]


class Attribution(object):
    """driver_ids and lever_ids of a (line, period) for one response."""

    def __init__(self, line_assumptions, inert, plan_periods, base_periods,
                 removals, static_levers):
        self._static = line_assumptions
        self._inert = inert
        self._plan = dict((p.label, p) for p in plan_periods)
        self._base = dict((p.label, p) for p in base_periods)
        #: [(lever id, {label: period} or None)]
        self._removals = [(lever_id,
                           None if run is None else dict((p.label, p) for p in run.periods))
                          for lever_id, run, _keys in removals]
        self._levers_of_driver = static_levers

    def driver_ids(self, line: str) -> List[str]:
        return [i for i in self._static.get(line, ()) if not self._inert.get(i)]

    def lever_ids(self, line: str, label: str) -> Tuple[List[str], bool]:
        served = amount_of(self._plan[label], line)
        found = []  # type: List[str]
        for lever_id, periods in self._removals:
            without = None if periods is None else periods.get(label)
            # a removal run that refused, or stopped short of this period,
            # is a run the lever changed: the lever reaches the figure
            if without is None or amount_of(without, line) != served:
                found.append(lever_id)
        if found:
            return found, False
        base = self._base.get(label)
        if self._removals and (base is None or amount_of(base, line) != served):
            reach = []  # type: List[str]
            for driver in self._static.get(line, ()):
                for lever_id in self._levers_of_driver.get(driver, ()):
                    if lever_id not in reach:
                        reach.append(lever_id)
            order = [lever_id for lever_id, _p in self._removals]
            return sorted(reach, key=order.index), True
        return [], False


def build_figures(lines: Sequence[Tuple[str, str]], projection: Any,
                  attribution: Attribution, formulas: Dict[str, str],
                  not_fully_served: Dict[str, str]) -> List[Dict[str, Any]]:
    """``formulas`` = {"flow", "balance", "opening"} from the pack (TC-10)."""
    served = dict((p.label, p) for p in projection.periods)
    years = monthly_years(projection.timeline)
    out = []  # type: List[Dict[str, Any]]
    for line, formula in lines:
        emitted = set()  # type: set
        for period in projection.timeline:
            item = served.get(period.label)
            if item is not None:
                lever_ids, joint = attribution.lever_ids(line, period.label)
                out.append({"line": line, "period": period.label, "kind": "projected",
                            "amount_minor": amount_of(item, line),
                            "driver_ids": attribution.driver_ids(line),
                            "lever_ids": lever_ids, "joint": joint,
                            "formula": formula})
            for _n, fy, months in years:
                if fy in emitted or months[-1].label != period.label:
                    continue
                emitted.add(fy)
                out.append(_aggregate(line, fy, months, served, attribution,
                                      formulas, not_fully_served))
    return out


def _aggregate(line, fy, months, served, attribution, formulas,
               not_fully_served):
    if any(m.label not in served for m in months):
        return {"line": line, "period": fy, "kind": "projected_aggregate",
                "refused": dict(not_fully_served)}
    items = [served[m.label] for m in months]
    is_flow = (line.split(".", 1)[0] in FLOW_SECTIONS
               and line not in (CF_OPENING, CF_CLOSING))
    if is_flow:
        amount = sum(amount_of(i, line) for i in items)
    elif line == CF_OPENING:
        amount = amount_of(items[0], line)
    else:
        amount = amount_of(items[-1], line)
    lever_ids = []  # type: List[str]
    joint = False
    for m in months:
        ids, j = attribution.lever_ids(line, m.label)
        joint = joint or j
        for lever_id in ids:
            if lever_id not in lever_ids:
                lever_ids.append(lever_id)
    formula = formulas["flow"] if is_flow else (
        formulas["opening"] if line == CF_OPENING else formulas["balance"])
    return {"line": line, "period": fy, "kind": "projected_aggregate",
            "amount_minor": amount, "driver_ids": attribution.driver_ids(line),
            "lever_ids": lever_ids, "joint": joint, "formula": formula}
