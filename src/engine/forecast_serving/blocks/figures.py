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


def amount_of(period: Any, line: str, totals: Any) -> int:
    """``totals``: period -> the five balance-sheet totals, summed BY THE
    ENGINE in integer minor units (F2: the browser never sums). This package
    imports no producer module, so the callable is handed in by the producer
    and carried by the response's Attribution - never a module global (a
    request-scoped value in a module global is a cross-request race the day
    it captures anything per plan)."""
    section, name = line.split(".", 1)
    if section == "bs_totals":
        return totals(period)[name]
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
                 removals, static_levers, totals, plan_run=None):
        self._totals = totals
        self._static = line_assumptions
        self._inert = inert
        self._plan = dict((p.label, p) for p in plan_periods)
        self._base = dict((p.label, p) for p in base_periods)
        #: [(lever id, {label: period} or None)]
        self._removals = [(lever_id,
                           None if run is None else dict((p.label, p) for p in run.periods))
                          for lever_id, run, _keys in removals]
        #: the RUN objects themselves, kept beside the period maps so a
        #: removal test can read a run's own ShortfallRefusal — the only
        #: place a value exists for a period no run serves (6.5).
        self._plan_run = plan_run
        self._removal_runs = [(lever_id, run) for lever_id, run, _keys in removals]
        self._levers_of_driver = static_levers

    def driver_ids(self, line: str) -> List[str]:
        return [i for i in self._static.get(line, ()) if not self._inert.get(i)]

    def amount(self, period: Any, line: str) -> int:
        return amount_of(period, line, self._totals)

    def lever_ids(self, line: str, label: str) -> Tuple[List[str], bool]:
        return self.lever_ids_of(line, lambda periods: (
            None if label not in periods else self.amount(periods[label], line)))

    def levers_naming(self, driver: str) -> List[str]:
        """The levers of this request that set ``driver``, plus every lever
        whose removal run refused (it changed the plan everywhere)."""
        out = [lever_id for lever_id, periods in self._removals if periods is None]
        for lever_id in self._levers_of_driver.get(driver, ()):
            if lever_id not in out:
                out.append(lever_id)
        order = [lever_id for lever_id, _p in self._removals]
        return sorted(out, key=order.index)

    def refused_removals(self) -> List[str]:
        return [lever_id for lever_id, periods in self._removals if periods is None]

    def lever_ids_at_refusal(self, read) -> Tuple[List[str], bool]:
        """3.6 at the period a partial serve does NOT reach.

        The removal test is the same one 3.6 states — removing the lever
        changes THIS amount — but read off each run's own
        :class:`~engine.forecast.project.ShortfallRefusal` rather than off a
        served period, because no run serves this period. A run that does
        not refuse here at all (the lever lifted or moved the shortfall) is
        a run the lever changed, so ``read`` returns None for it and the
        lever is found. Never the joint fallback: the base run has no
        refusal to compare against, so there is nothing to be joint about.
        """
        served = read(self._plan_run)
        found = []  # type: List[str]
        for lever_id, run in self._removal_runs:
            if run is None or read(run) != served:
                found.append(lever_id)
        return found, False

    def lever_ids_of(self, line, read) -> Tuple[List[str], bool]:
        """3.6: a lever reaches a served amount when removing it changes THAT
        amount. ``read`` takes {label: period} of one run and returns the
        amount (a period figure, or an FY aggregate computed the way the
        served one is), or None when that run does not reach it."""
        # ``line``: one line, or the lines a derived value is read off (a
        # series point); used only for the joint fallback's static reach.
        served = read(self._plan)
        found = []  # type: List[str]
        for lever_id, periods in self._removals:
            # a removal run that refused, or stopped short of this amount,
            # is a run the lever changed: the lever reaches the figure
            if periods is None or read(periods) != served:
                found.append(lever_id)
        if found:
            return found, False
        if self._removals and read(self._base) != served:
            reach = []  # type: List[str]
            lines = (line,) if isinstance(line, str) else tuple(line)
            for driver in [d for l in lines for d in self._static.get(l, ())]:
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
                            "amount_minor": attribution.amount(item, line),
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
    is_flow = (line.split(".", 1)[0] in FLOW_SECTIONS
               and line not in (CF_OPENING, CF_CLOSING))

    def read(periods):
        if any(m.label not in periods for m in months):
            return None
        if is_flow:
            return sum(attribution.amount(periods[m.label], line) for m in months)
        edge = months[0] if line == CF_OPENING else months[-1]
        return attribution.amount(periods[edge.label], line)

    amount = read(served)
    # the aggregate's OWN removal test, never the union of its months: a
    # closing balance is reached only by what reaches the closing month
    lever_ids, joint = attribution.lever_ids_of(line, read)
    formula = formulas["flow"] if is_flow else (
        formulas["opening"] if line == CF_OPENING else formulas["balance"])
    return {"line": line, "period": fy, "kind": "projected_aggregate",
            "amount_minor": amount, "driver_ids": attribution.driver_ids(line),
            "lever_ids": lever_ids, "joint": joint, "formula": formula}
