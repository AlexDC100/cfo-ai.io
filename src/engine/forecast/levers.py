"""The one entry point of the forecast engine: ``project_plan`` (plan/2 B5).

plan_contract_v2 1.1: a Scenario is a lever set applied to the forecast's
linked three-statement model. This module compiles a :class:`PlanRequest`
(overrides, shocks, behaviour overrides, a debt schedule) onto one timeline
(2.3-2.6), runs the base plan once and the levered plan once through
:func:`engine.forecast.project.project`, and returns a :class:`Plan`.

It performs no I/O and imports nothing from ``engine.api``. Every refusal
sentence, bound and placement rule it uses is pack data
(packs/forecast/levers.yaml, TC-10). No float touches a request value: they
arrive as exact fractions and are rounded once to the model unit.

Python 3.9 - no ``match``, no ``X | Y``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from fractions import Fraction
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .assumptions import (KEYS, AssumptionSet, BookContext, DebtMove,
                          DebtSchedule)
from .errors import (AssumptionError, BalanceViolation, ForecastError,
                     PlanRequestError)
from .levers_pack import PackError, RegistryEntry, plan_pack
from .money import MICRO, MICRO_DAY, _exact_fraction
from .pools import (FIXED_SHARE_PREFIX, LEVEL_PREFIX, TEMPLATE_FIXED_SHARE,
                    TEMPLATE_LEVEL, PoolSplit)
from .project import (INDEX_KEYS, LINE_ASSUMPTIONS, CompiledPlan, Projection,
                      ShortfallRefusal, _opening_and_history, _parse_date,
                      _round, context_for_payload, expand_line_assumptions,
                      project)
from .resolve import resolve_defaults
from .timeline import Period, add_months, build_timeline

__all__ = ["BehaviourOverride", "DebtRow", "Plan", "PlanContext", "PlanRequest",
           "Shock", "plan_request_from_body", "project_plan", "registry_for",
           "OP_RANK", "RESERVED_ID_PREFIXES"]

#: 2.5 step 7: shocks apply by op rank, then by id.
OP_RANK = {"set": 0, "level_pct": 1, "growth_pp": 2, "add_days": 3, "add_pp": 3}
#: 2.4: prefixes a client may not send.
RESERVED_ID_PREFIXES = ("override:", "behaviour:", "proposal:", "case:",
                        "debt:", "spread:", "capsule:", "probe:")
_GROWTH_SOURCES = ("template:", "preset:")


# ── the request ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Shock(object):
    id: str
    driver_key: str
    op: str
    value: Fraction
    start_month: int = 1
    ramp_months: int = 0
    end_month: Optional[int] = None
    source: str = "user"
    group_id: Optional[str] = None


@dataclass(frozen=True)
class BehaviourOverride(object):
    pool: str
    fixed_share: Optional[Fraction] = None
    volume_elasticity: Optional[int] = None


@dataclass(frozen=True)
class DebtRow(object):
    """One plan year's scheduled debt movements, in major units."""
    year: int
    st_draw: Fraction = Fraction(0)
    st_repay: Fraction = Fraction(0)
    lt_draw: Fraction = Fraction(0)
    lt_repay: Fraction = Fraction(0)


@dataclass(frozen=True)
class PlanRequest(object):
    """Contract section 2, as exact fractions and integers. ``overrides`` is
    a tuple of (driver_key, values) with one value (or None) per plan year,
    or one value for a scalar driver."""
    total_years: int
    monthly_months: int = 12
    case: str = "base"
    case_id: Optional[str] = None
    overrides: Tuple[Tuple[str, Tuple[Optional[Fraction], ...]], ...] = ()
    shocks: Tuple[Shock, ...] = ()
    behaviour_overrides: Tuple[BehaviourOverride, ...] = ()
    accept_proposals: Tuple[str, ...] = ()
    debt_schedule: Tuple[DebtRow, ...] = ()
    spread: Optional[Mapping[str, Any]] = None
    compare_case_ids: Tuple[str, ...] = ()
    tornado_metric: Optional[str] = None
    breakeven_from: str = "baseline"
    want: Optional[Tuple[str, ...]] = None

    def has_levers(self) -> bool:
        return bool(self.overrides or self.shocks or self.behaviour_overrides
                    or self.debt_schedule)


@dataclass(frozen=True)
class PlanContext(object):
    """What the route loads beside the anchor (1.1). ``jurisdiction`` None
    with ``jurisdiction_source`` None means "read it from the anchor
    envelope", which is what an in-process caller with no loader wants."""
    jurisdiction: Optional[str] = None
    jurisdiction_source: Optional[str] = None
    covenant_rows: Tuple[Mapping[str, Any], ...] = ()
    covenant_migration_state: Optional[str] = None
    industry_key: Optional[str] = None
    saved_case: Optional[Mapping[str, Any]] = None
    proposals: Tuple[Mapping[str, Any], ...] = ()


class Plan(object):
    """What ``project_plan`` returns. ``base`` is the request's base run
    (no levers, same horizon); ``projection`` the levered run, which is the
    same object when the request carries no lever. Nothing here is
    serialised by B5: B6 builds fp1.2 from it."""

    __slots__ = ("request", "base", "projection", "compiled", "refusal",
                 "runway", "summary", "line_assumptions", "driver_order",
                 "conventions", "notes", "inputs")

    def __init__(self, request, base, projection, compiled, refusal, runway,
                 summary, line_assumptions, driver_order, conventions, notes,
                 inputs=None):
        #: plan/2 B6: what the in-process probes (removal runs, inert
        #: nudges) re-run ``project`` with. Never serialised.
        self.inputs = inputs
        self.request = request
        self.base = base
        self.projection = projection
        self.compiled = compiled
        self.refusal = refusal
        self.runway = runway
        self.summary = summary
        self.line_assumptions = line_assumptions
        self.driver_order = driver_order
        self.conventions = conventions
        self.notes = notes


# ── refusals (sentences from the pack) ────────────────────────────────────

def _refuse(code: str, field_name: Optional[str] = None, **facts: Any) -> PlanRequestError:
    template = plan_pack().refusals.get(code)
    if template is None:
        raise PackError("packs/forecast/levers.yaml#request_refusals: no sentence "
                        "for %r" % (code,))
    return PlanRequestError(code, template.format(**facts), field_name)


def _text(value: Fraction) -> str:
    """An exact rational as the shortest exact decimal, else a ratio."""
    value = Fraction(value)
    scaled = value * 10 ** 12
    if scaled.denominator != 1:
        return "%d/%d" % (value.numerator, value.denominator)
    digits = "%d" % abs(scaled.numerator)
    digits = digits.rjust(13, "0")
    whole, frac = digits[:-12], digits[-12:].rstrip("0")
    return ("-" if value < 0 else "") + whole + ("." + frac if frac else "")


# ── the registry, checked against the engine's own attribution ────────────

_CHECKED = {}  # type: Dict[int, Tuple[RegistryEntry, ...]]


def _checked_registry() -> Tuple[RegistryEntry, ...]:
    """3a.1: model_key exists, and every declared consumer line really is
    attributed to the key. Run once per loaded pack."""
    pack = plan_pack()
    cached = _CHECKED.get(id(pack))
    if cached is not None:
        return cached
    known = set(KEYS) | set(INDEX_KEYS) | {TEMPLATE_FIXED_SHARE, TEMPLATE_LEVEL}
    for entry in pack.registry:
        if entry.model_key not in known or entry.model_key != entry.key:
            raise PackError("%s.model_key: %r is not a key this engine projects"
                            % (entry.rule_id, entry.model_key))
        for line in entry.consumers:
            ids = LINE_ASSUMPTIONS.get(line)
            if ids is None:
                raise PackError("%s.consumers: the engine projects no line %r"
                                % (entry.rule_id, line))
            if entry.key not in ids:
                raise PackError("%s.consumers: %s is not attributed to %s "
                                "(LINE_ASSUMPTIONS)" % (entry.rule_id, line, entry.key))
    _CHECKED[id(pack)] = pack.registry
    return pack.registry


def registry_for(pools: Optional[PoolSplit]) -> "List[Tuple[str, RegistryEntry]]":
    """The served keys of one book, templates expanded at their position
    (3a.2): pool_fixed_share over cost_of_sales then the opex pools,
    pool_level over the opex pools."""
    out = []  # type: List[Tuple[str, RegistryEntry]]
    for entry in _checked_registry():
        if entry.key == TEMPLATE_FIXED_SHARE:
            names = [p.name for p in pools.pools()] if pools is not None else []
            out.extend((FIXED_SHARE_PREFIX + n, entry) for n in names)
        elif entry.key == TEMPLATE_LEVEL:
            names = [p.name for p in pools.opex] if pools is not None else []
            out.extend((LEVEL_PREFIX + n, entry) for n in names)
        else:
            out.append((entry.key, entry))
    return out


# ── units ─────────────────────────────────────────────────────────────────

def _scale_of(unit: str) -> int:
    return {"ratio": MICRO, "index": MICRO, "days": MICRO_DAY, "money": 100}[unit]


def _unit_name(unit: str) -> str:
    return {"ratio": "micros", "index": "micros", "days": "micro-days",
            "money": "minor units"}[unit]


def _exact_units(key: str, unit: str, value: Fraction) -> Fraction:
    """2.3: a request value must be exactly representable in the model unit;
    it is refused, never rounded."""
    value = Fraction(value)
    if (value * _scale_of(unit)).denominator != 1:
        raise _refuse("not_exact", key, key=key, value=_text(value),
                      unit=_unit_name(unit))
    return value


# ── compilation (2.5, 2.6) ────────────────────────────────────────────────

def _month_days(anchor: date, total_years: int) -> List[int]:
    out = []
    for k in range(1, total_years * 12 + 1):
        out.append((add_months(anchor, k) - add_months(anchor, k - 1)).days)
    return out


def _ramp(shock: Shock, month: int) -> Fraction:
    if shock.ramp_months == 0:
        return Fraction(1)
    return min(Fraction(1), Fraction(month - shock.start_month + 1, shock.ramp_months))


def _in_window(shock: Shock, month: int) -> bool:
    return month >= shock.start_month and (
        shock.end_month is None or month <= shock.end_month)


def _default_value(key: str, entry: RegistryEntry, assumptions: AssumptionSet,
                   pools: PoolSplit) -> Optional[Fraction]:
    if entry.unit == "index":
        return Fraction(1)
    if entry.unit == "ratio":
        if key.startswith(FIXED_SHARE_PREFIX):
            return Fraction(pools.pool(key[len(FIXED_SHARE_PREFIX):]).fixed_share_micros, MICRO)
        raw = assumptions.micros_or_none(key)
        return None if raw is None else Fraction(raw, MICRO)
    if entry.unit == "days":
        raw = assumptions.micro_days_or_none(key)
        return None if raw is None else Fraction(raw, MICRO_DAY)
    return Fraction(assumptions.cents(key), 100)


def _validate_shock(shock: Shock, entry: Optional[RegistryEntry], months: int,
                    client_sent: bool) -> None:
    if entry is None:
        raise _refuse("unknown_driver", shock.driver_key, key=shock.driver_key)
    if shock.op not in entry.allowed_ops:
        raise _refuse("op_not_allowed", shock.id, op=shock.op, key=shock.driver_key,
                      allowed=", ".join(entry.allowed_ops) or "none")
    for name, value, low in (("start_month", shock.start_month, 1),
                             ("end_month", shock.end_month, shock.start_month),
                             ("ramp_months", shock.ramp_months, 0)):
        if value is None:
            continue
        if not isinstance(value, int) or isinstance(value, bool) \
                or value < low or value > months:
            raise _refuse("shock_window", shock.id, id=shock.id, field=name,
                          value=value, low=low, high=months)
    if entry.shape == "scalar" and entry.granularity == "monthly" \
            and entry.unit == "money":
        if shock.start_month != 1 or shock.end_month is not None or shock.ramp_months:
            raise _refuse("scalar_window", shock.id, id=shock.id, key=shock.driver_key)
    if entry.granularity == "annual":
        aligned = ((shock.start_month - 1) % 12 == 0 and shock.ramp_months == 0
                   and (shock.end_month is None or shock.end_month % 12 == 0))
        if not aligned:
            raise _refuse("annual_alignment", shock.id, id=shock.id,
                          key=shock.driver_key)
    if shock.driver_key == "revenue_growth":
        if shock.source == "user":
            raise _refuse("growth_change_is_an_override", shock.id)
        if not shock.source.startswith(_GROWTH_SOURCES):
            raise _refuse("growth_pp_source", shock.id, id=shock.id)
    elif shock.op == "growth_pp" and not shock.source.startswith(_GROWTH_SOURCES):
        raise _refuse("growth_pp_source", shock.id, id=shock.id)
    if client_sent and (shock.id == "spread"
                        or shock.id.startswith(RESERVED_ID_PREFIXES)):
        raise _refuse("reserved_shock_id", shock.id, id=shock.id)


def _not_landed(request: PlanRequest) -> None:
    """2.9: a field whose batch has not landed must hold its default."""
    defaults = (("case", request.case, "base"), ("case_id", request.case_id, None),
                ("accept_proposals", tuple(request.accept_proposals), ()),
                ("spread", request.spread, None),
                ("compare_case_ids", tuple(request.compare_case_ids), ()),
                ("tornado_metric", request.tornado_metric, None),
                ("breakeven_from", request.breakeven_from, "baseline"))
    for name, value, default in defaults:
        if value != default:
            raise _refuse("not_served_in_this_build", name)


class _Compiler(object):
    def __init__(self, request: PlanRequest, assumptions: AssumptionSet,
                 pools: PoolSplit, timeline: Sequence[Period], anchor: date,
                 client_sent: bool) -> None:
        self.request = request
        self.assumptions = assumptions
        self.pools = pools
        self.timeline = timeline
        self.months = request.total_years * 12
        self.month_days = _month_days(anchor, request.total_years)
        self.entries = dict(registry_for(pools))
        self.client_sent = client_sent
        #: every driver a lever of this request moved, with the lever ids
        self.moved = {}  # type: Dict[str, List[str]]

    # -- layers -----------------------------------------------------------
    def _override_months(self, key: str, entry: RegistryEntry,
                         values: Sequence[Optional[Fraction]],
                         series: List[Optional[Fraction]]) -> None:
        if entry.set_via != "overrides":
            raise _refuse("override_not_settable", key, key=key, set_via=entry.set_via)
        expected = self.request.total_years if entry.shape == "per_year" else 1
        if len(values) != expected:
            raise _refuse("override_length", key, key=key, expected=expected,
                          got=len(values))
        for position, value in enumerate(values):
            if value is None:
                continue
            value = _exact_units(key, entry.unit, value)
            months = (range(position * 12, position * 12 + 12)
                      if entry.shape == "per_year" else range(self.months))
            for m in months:
                series[m] = value
            self.moved.setdefault(key, []).append("override:%s" % key)

    def _apply_shocks(self, key: str, entry: RegistryEntry, shocks: Sequence[Shock],
                      series: List[Optional[Fraction]],
                      level: List[Fraction]) -> None:
        sets = [s for s in shocks if s.op == "set"]
        for i, first in enumerate(sets):
            for second in sets[i + 1:]:
                for month in range(1, self.months + 1):
                    if _in_window(first, month) and _in_window(second, month):
                        a, b = sorted((first.id, second.id))
                        raise _refuse("overlapping_sets", key, first=a, second=b,
                                      key=key, month=month)
        for shock in sorted(shocks, key=lambda s: (OP_RANK[s.op], s.id)):
            self.moved.setdefault(key, []).append(shock.id)
            for month in range(1, self.months + 1):
                if not _in_window(shock, month):
                    continue
                m = month - 1
                if shock.op == "set":
                    series[m] = _exact_units(key, entry.unit, shock.value)
                    continue
                if series[m] is None:
                    # by the driver's unit: a rate the book does not price
                    # is not refused in a days driver's words (B5V-7b)
                    raise _refuse("days_not_measured" if entry.unit == "days"
                                  else "rate_not_measured", key, key=key)
                if shock.op == "level_pct":
                    factor = 1 + shock.value * _ramp(shock, month)
                    if entry.unit == "money":
                        level[m] *= factor
                    else:
                        series[m] *= factor
                elif shock.op == "growth_pp":
                    if entry.unit == "index":
                        steps = (month - 1) // 12 - (shock.start_month - 1) // 12 + 1
                        series[m] *= (1 + shock.value) ** steps
                    else:
                        series[m] += shock.value
                else:  # add_days, add_pp
                    series[m] += shock.value * _ramp(shock, month)

    def _check_bounds(self, key: str, entry: RegistryEntry,
                      series: Sequence[Optional[Fraction]]) -> None:
        low, high = entry.bounds
        for value in series:
            if value is None:
                continue
            if (low is not None and value < low) or (high is not None and value > high):
                raise _refuse("out_of_bounds", key, key=key, value=_text(value),
                              low="no lower bound" if low is None else _text(low),
                              high="no upper bound" if high is None else _text(high))

    # -- per period -------------------------------------------------------
    def _period_value(self, period: Period, series: Sequence[Optional[Fraction]]
                      ) -> Optional[Fraction]:
        if period.granularity == "monthly":
            return series[period.index]
        first = (period.year_offset - 1) * 12
        months = range(first, first + 12)
        if any(series[m] is None for m in months):
            return None
        days = sum(self.month_days[m] for m in months)
        # 2.6: the day-weighted mean of the compiled monthly schedule.
        return sum(series[m] * self.month_days[m] for m in months) / days

    def compile(self, nudge: Optional[Tuple[str, Fraction, Fraction]] = None
                ) -> CompiledPlan:
        """``nudge`` = (driver key, reach_step, probe_value): the lever-reach
        probe of contract 12. The key's compiled value is moved by reach_step
        (down when up leaves its bounds), or set to probe_value where its
        default is null. In process only; a request never carries it."""
        request = self.request
        nudge_key = None if nudge is None else nudge[0]
        by_key = {}  # type: Dict[str, List[Shock]]
        seen = set()  # type: set
        for shock in request.shocks:
            if shock.id in seen:
                raise _refuse("duplicate_shock_id", shock.id, id=shock.id)
            seen.add(shock.id)
            _validate_shock(shock, self.entries.get(shock.driver_key), self.months,
                            self.client_sent)
            by_key.setdefault(shock.driver_key, []).append(shock)
        overrides = dict(request.overrides)
        if len(overrides) != len(request.overrides):
            raise _refuse("override_length", None, key="overrides", expected=1, got=2)
        for key in overrides:
            if key not in self.entries:
                raise _refuse("unknown_driver", key, key=key)

        plan = CompiledPlan()
        for key, entry in self.entries.items():
            if key.startswith(FIXED_SHARE_PREFIX) and key == nudge_key:
                continue  # nudged after the behaviour overrides, below
            if key not in overrides and key not in by_key and key != nudge_key:
                continue
            default = _default_value(key, entry, self.assumptions, self.pools)
            series = [default] * self.months  # type: List[Optional[Fraction]]
            level = [Fraction(1)] * self.months
            if key in overrides:
                self._override_months(key, entry, overrides[key], series)
            self._apply_shocks(key, entry, by_key.get(key, ()), series, level)
            if key == nudge_key:
                series = self._nudged(entry, series, nudge[1], nudge[2])
            self._check_bounds(key, entry, series)
            scale = _scale_of(entry.unit)

            def rounded(value):
                return None if value is None else _round(value * scale)

            if entry.unit == "money" and entry.shape == "scalar":
                plan.scalars[key] = rounded(series[0])
            elif entry.unit == "money":
                plan.money[key] = tuple(
                    (rounded(self._period_value(p, series)),
                     _round(self._period_value(p, level) * MICRO))
                    for p in self.timeline)
            elif entry.granularity == "annual" and entry.shape == "scalar":
                plan.scalars[key] = rounded(series[0])
            elif entry.granularity == "annual":
                plan.years[key] = tuple(rounded(series[(n - 1) * 12])
                                        for n in range(1, request.total_years + 1))
            else:
                plan.periods[key] = tuple(rounded(self._period_value(p, series))
                                          for p in self.timeline)

        served = [p.name for p in self.pools.pools()]
        pools_seen = set()  # type: set
        for item in request.behaviour_overrides:
            if item.pool not in served or item.pool in pools_seen:
                raise _refuse("unknown_pool", item.pool, pool=item.pool,
                              served=", ".join(served))
            pools_seen.add(item.pool)
            if item.fixed_share is not None:
                share = Fraction(item.fixed_share)
                if share < 0 or share > 1:
                    raise _refuse("fixed_share_range", item.pool,
                                  value=_text(share), pool=item.pool)
                key = FIXED_SHARE_PREFIX + item.pool
                plan.scalars[key] = _round(_exact_units(key, "ratio", share) * MICRO)
                self.moved.setdefault(key, []).append("behaviour:%s" % item.pool)
            if item.volume_elasticity is not None:
                if item.volume_elasticity not in (0, 1) \
                        or isinstance(item.volume_elasticity, bool):
                    raise _refuse("elasticity_value", item.pool,
                                  value=item.volume_elasticity, pool=item.pool)
                plan.elasticity[item.pool] = int(item.volume_elasticity)
                self.moved.setdefault(FIXED_SHARE_PREFIX + item.pool, []).append(
                    "behaviour:%s" % item.pool)

        if nudge_key is not None and nudge_key.startswith(FIXED_SHARE_PREFIX):
            pool = nudge_key[len(FIXED_SHARE_PREFIX):]
            now = plan.scalars.get(nudge_key)
            if now is None:
                now = self.pools.pool(pool).fixed_share_micros
            step = _round(nudge[1] * MICRO)
            plan.scalars[nudge_key] = now + step if now + step <= MICRO else now - step

        if request.debt_schedule:
            plan.debt_schedule = self._debt_schedule()
        return plan

    @staticmethod
    def _nudged(entry: RegistryEntry, series: Sequence[Optional[Fraction]],
                step: Fraction, probe: Fraction) -> List[Optional[Fraction]]:
        low, high = entry.bounds
        out = []  # type: List[Optional[Fraction]]
        for value in series:
            if value is None:
                out.append(probe)
            elif high is not None and value + step > high:
                out.append(value - step)
            else:
                out.append(value + step)
        return out

    def _debt_schedule(self) -> DebtSchedule:
        """6.7: where a plan year's draws and repayments land is pack data
        (levers.yaml#debt_timing)."""
        pack = plan_pack()
        first = {}  # type: Dict[int, int]
        last = {}  # type: Dict[int, int]
        for period in self.timeline:
            first.setdefault(period.year_offset, period.index)
            last[period.year_offset] = period.index
        where = {"first_period": first, "last_period": last}
        moves = {}  # type: Dict[int, Dict[str, int]]
        years = set()  # type: set
        for row in self.request.debt_schedule:
            if not isinstance(row.year, int) or row.year < 1 \
                    or row.year > self.request.total_years:
                raise _refuse("debt_year", "debt_schedule", year=row.year,
                              total_years=self.request.total_years)
            if row.year in years:
                raise _refuse("debt_duplicate_year", "debt_schedule", year=row.year)
            years.add(row.year)
            for name, placement in (("st_draw", pack.debt_draws),
                                    ("lt_draw", pack.debt_draws),
                                    ("st_repay", pack.debt_repayments),
                                    ("lt_repay", pack.debt_repayments)):
                amount = _exact_units("debt_schedule", "money", getattr(row, name))
                if amount < 0:
                    raise _refuse("debt_negative", "debt_schedule", year=row.year,
                                  field=name)
                if amount == 0:
                    continue
                index = where[placement][row.year]
                slot = moves.setdefault(index, {})
                slot[name] = slot.get(name, 0) + _round(amount * 100)
            self.moved.setdefault("debt_schedule", []).append("debt:%d" % row.year)
        return DebtSchedule([DebtMove(i, **moves[i]) for i in sorted(moves)])


# ── runway and summary (6.6, 3.8) ─────────────────────────────────────────

def _runway(projection: Projection, monthly_months: int, min_cash: int) -> Dict[str, Any]:
    pack = plan_pack()
    breach = None  # type: Optional[Period]
    for item in projection.periods:
        if item.checks["cash_before_funding_line_cents"] < min_cash:
            breach = item.period
            break
    if breach is None and projection.shortfall is not None:
        breach = projection.shortfall.period
    limit = {"refused": dict(pack.runway["facility_limit"])}
    if breach is None:
        return {"months": monthly_months, "bound": "at_least",
                "first_shortfall_period": None, "window_months": monthly_months,
                "sentence": {"code": "runway_none", "text": pack.runway["none"]},
                "facility_limit": limit}
    if breach.granularity == "monthly":
        return {"months": breach.index, "bound": "exact",
                "first_shortfall_period": breach.label,
                "window_months": monthly_months,
                "sentence": {"code": "runway_exact",
                             "text": pack.runway["exact"].format(period=breach.label)},
                "facility_limit": limit}
    return {"months": monthly_months, "bound": "at_least",
            "first_shortfall_period": breach.label, "window_months": monthly_months,
            "sentence": {"code": "runway_annual_tail",
                         "text": pack.runway["annual_tail"].format(period=breach.label)},
            "facility_limit": limit}


def _summary(projection: Projection) -> Dict[str, Any]:
    refusal = projection.shortfall
    first = None
    amount = None
    for item in projection.periods:
        if item.checks["funding_line_draw_cents"] > 0:
            first, amount = item.label, item.checks["funding_line_draw_cents"]
            break
    if first is None and refusal is not None:
        first, amount = refusal.period.label, refusal.amount_minor
    out = {"first_shortfall_period": first, "first_shortfall_amount_minor": amount}
    if refusal is not None:
        out["peak_funding_gap_minor"] = {"refused": dict(refusal.sentence)}
        out["funding_interest_total_minor"] = {"refused": dict(refusal.sentence)}
    else:
        out["peak_funding_gap_minor"] = projection.peak_funding_cents()
        out["funding_interest_total_minor"] = sum(
            -p.pl["interest_expense_funding_line"] for p in projection.periods)
    return out


# ── the entry point ───────────────────────────────────────────────────────

#: The drivers whose move needs the fixed/variable split to mean anything.
#: The drivers whose effect on cost IS the fixed/variable split: growth,
#: volume and input prices move the variable part, inflation the fixed part.
#: Over a refused split (fixed share 0) the first three move every cost and
#: inflation moves none (B5V-4: agras +10pp inflation was served unmoved).
#: B5R-4: the rates whose absence refuses a BASE plan that carries the balance
#: they price. A request that supplies one prices the base run with it.
_BASE_PRICING_RATES = ("interest_rate_debt", "revolver_rate")

_SPLIT_DEPENDENT = ("revenue_growth", "volume_index", "input_price_index",
                    "inflation")


def project_plan(anchor_payload: Dict[str, Any], prior_periods: Sequence[Dict[str, Any]],
                 request: PlanRequest, context: Optional[PlanContext] = None, *,
                 stop_at_unpriced_draw: bool = True, client_sent: bool = False,
                 assumption_overrides: Optional[Mapping[str, Any]] = None) -> Plan:
    """Contract 1.1. Builds the opening position, the P&L history, the cost
    pools and the resolved defaults once; runs the base plan, then the
    levered plan. ``assumption_overrides`` exists only for the
    ``project_payload`` wrapper (caller-stamped assumptions of the pre-plan
    API); a request never carries it."""
    _not_landed(request)
    opening, history = _opening_and_history(anchor_payload)
    book = context_for_payload(anchor_payload)
    if context is not None and context.jurisdiction_source is not None:
        book = BookContext(context.jurisdiction, context.jurisdiction_source,
                           book.ratio_table, book.pools,
                           tax_charge_rows=book.tax_charge_rows)
    assumptions, resolver_notes = resolve_defaults(
        opening, history, book, prior_periods, dict(assumption_overrides or {}))

    anchor = _parse_date(opening.period_end)
    timeline = build_timeline(anchor, request.total_years, request.monthly_months)
    base_notes = ()  # type: Tuple[str, ...]
    try:
        base = project(opening, history, assumptions,
                       total_years=request.total_years,
                       monthly_months=request.monthly_months, context=book,
                       stop_at_unpriced_draw=stop_at_unpriced_draw)
    except AssumptionError as refused:
        # B5V-7e, decision B5R-4: the base plan refuses for a rate this book
        # cannot measure, and its sentence asks for that rate. A request that
        # supplies exactly it prices the BASE run too (both runs carry the
        # same rate, so it is never a lever's delta). Nothing else is
        # inherited, and a request that does not supply it refuses as before.
        supplied = dict(request.overrides).get(refused.key)
        if refused.key not in _BASE_PRICING_RATES or supplied is None:
            raise
        only = PlanRequest(total_years=request.total_years,
                           monthly_months=request.monthly_months,
                           overrides=((refused.key, supplied),))
        base_plan = _Compiler(only, assumptions, assumptions.pools, timeline, anchor,
                              client_sent).compile()
        base = project(opening, history, assumptions,
                       total_years=request.total_years,
                       monthly_months=request.monthly_months, context=book,
                       plan=base_plan,
                       stop_at_unpriced_draw=stop_at_unpriced_draw)
        base_notes = ("base plan priced at the request's %s: this book cannot "
                      "measure it" % refused.key,)
    pools = base.assumptions.pools
    if pools is None:
        from .pools import split_pools
        pools = split_pools(None, opex_total_cents=history.opex,
                            cogs_total_cents=history.cogs,
                            revenue_cents=history.revenue or 0)

    compiled = CompiledPlan()
    moved = {}  # type: Dict[str, List[str]]
    projection = base
    if request.has_levers():
        compiler = _Compiler(request, assumptions, pools, timeline, anchor, client_sent)
        compiled = compiler.compile()
        moved = compiler.moved
        if pools.refused and any(k in moved for k in _SPLIT_DEPENDENT):
            # B4R-8a / B4RV-4 / B5V-4: over a refused split every cost is
            # fully variable and none is fixed, the optimistic end in a
            # downturn and under inflation (retail served a loss as a
            # profit). Refused by name, never labelled and served.
            raise _refuse("cost_split_refused", "shocks",
                          reason=pools.refusal_rule_id or "the split was refused")
        compiled.wc_base_targets = dict(base.wc_targets)
        unwind = plan_pack().wc_unwind_days
        compiled.wc_unwind_micro_days = (None if unwind is None
                                         else _round(unwind * MICRO_DAY))
        projection = project(opening, history, assumptions,
                             total_years=request.total_years,
                             monthly_months=request.monthly_months, context=book,
                             plan=compiled,
                             stop_at_unpriced_draw=stop_at_unpriced_draw)

    min_cash = compiled.scalars.get("min_cash")
    if min_cash is None:
        min_cash = assumptions.cents("min_cash")
    pack = plan_pack()
    conventions = [
        {"id": pack.wc_unwind_id, "rule_id": "packs/forecast/levers.yaml#wc_unwind",
         "sentence": pack.wc_unwind_sentence},
        {"id": pack.debt_timing_id, "rule_id": "packs/forecast/levers.yaml#debt_timing",
         "sentence": pack.debt_timing_sentence},
    ]
    return Plan(request=request, base=base, projection=projection, compiled=compiled,
                refusal=projection.shortfall,
                runway=_runway(projection, request.monthly_months, min_cash),
                summary=_summary(projection),
                line_assumptions=expand_line_assumptions(projection.assumptions,
                                                         fp1_view=False),
                driver_order=[key for key, _entry in registry_for(pools)],
                conventions=conventions,
                notes=tuple(projection.notes) + tuple(resolver_notes) + base_notes
                + tuple("%s <- %s" % (k, ", ".join(v)) for k, v in sorted(moved.items())),
                inputs={"opening": opening, "history": history,
                        "assumptions": assumptions, "book": book, "pools": pools,
                        "timeline": timeline, "anchor": anchor,
                        "stop_at_unpriced_draw": stop_at_unpriced_draw,
                        "moved": dict(moved)})


# ── in-process probes (plan/2 B6, contract 1.1, 3.6, 12) ──────────────────
# Every probe calls ``project`` with the objects project_plan already built.
# None is serialised; none goes through project_payload, a gateway or an
# adapter.

def _probe(plan: Plan, request: PlanRequest,
           nudge: Optional[Tuple[str, Fraction, Fraction]] = None
           ) -> Optional[Projection]:
    """One levered re-run. None when the variant itself refuses (a removal
    that leaves an unpriceable plan, a nudge outside what the book can
    carry): a refused probe is no evidence either way."""
    inputs = plan.inputs
    if not request.has_levers() and nudge is None:
        return plan.base
    try:
        compiled = _Compiler(request, inputs["assumptions"], inputs["pools"],
                             inputs["timeline"], inputs["anchor"], False).compile(nudge)
        compiled.wc_base_targets = dict(plan.base.wc_targets)
        unwind = plan_pack().wc_unwind_days
        compiled.wc_unwind_micro_days = (None if unwind is None
                                         else _round(unwind * MICRO_DAY))
        return project(inputs["opening"], inputs["history"], inputs["assumptions"],
                       total_years=request.total_years,
                       monthly_months=request.monthly_months,
                       context=inputs["book"], plan=compiled,
                       stop_at_unpriced_draw=inputs["stop_at_unpriced_draw"])
    except BalanceViolation:
        raise  # F1 holds on every run kind; the route answers 422
    except ForecastError:
        return None


def lever_removals(request: PlanRequest) -> "List[Tuple[str, PlanRequest, Tuple[str, ...]]]":
    """(lever id, the request without that lever, the driver keys it moves),
    one per lever or group_id (3.6), in a stable order."""
    from dataclasses import replace
    out = []  # type: List[Tuple[str, PlanRequest, Tuple[str, ...]]]
    for key, _values in request.overrides:
        out.append(("override:%s" % key,
                    replace(request, overrides=tuple(
                        o for o in request.overrides if o[0] != key)), (key,)))
    groups = {}  # type: Dict[str, List[Shock]]
    for shock in request.shocks:
        groups.setdefault(shock.group_id or shock.id, []).append(shock)
    for lever_id in sorted(groups):
        gone = set(s.id for s in groups[lever_id])
        out.append((lever_id,
                    replace(request, shocks=tuple(
                        s for s in request.shocks if s.id not in gone)),
                    tuple(sorted(set(s.driver_key for s in groups[lever_id])))))
    for item in request.behaviour_overrides:
        out.append(("behaviour:%s" % item.pool,
                    replace(request, behaviour_overrides=tuple(
                        b for b in request.behaviour_overrides if b.pool != item.pool)),
                    (FIXED_SHARE_PREFIX + item.pool,)))
    for row in request.debt_schedule:
        out.append(("debt:%d" % row.year,
                    replace(request, debt_schedule=tuple(
                        r for r in request.debt_schedule if r.year != row.year)),
                    ()))
    return out


def removal_runs(plan: Plan) -> "List[Tuple[str, Optional[Projection], Tuple[str, ...]]]":
    """One removal run per lever (3.6): the plan re-projected without it."""
    return [(lever_id, _probe(plan, without), keys)
            for lever_id, without, keys in lever_removals(plan.request)]


def _amounts(projection: Projection) -> "List[Tuple[int, ...]]":
    return [tuple(p.pl[k] for k in sorted(p.pl)) + tuple(p.bs[k] for k in sorted(p.bs))
            + tuple(p.cf[k] for k in sorted(p.cf)) for p in projection.periods]


def inert_drivers(plan: Plan) -> Dict[str, bool]:
    """Contract 12: driver key -> True when moving it by its reach_step (or
    setting it to probe_value where its default is null) changes no amount of
    this plan. One in-process ``project`` per driver. A nudge the plan cannot
    carry (the probe refuses) is not evidence of inertness."""
    served = _amounts(plan.projection)
    out = {}  # type: Dict[str, bool]
    for key, entry in registry_for(plan.inputs["pools"]):
        probe = _probe(plan, plan.request, (key, entry.reach_step, entry.probe_value))
        out[key] = probe is not None and _amounts(probe) == served
    return out


# ── the wire form (B6 calls this once per request) ────────────────────────

def _fraction(value: Any, noun: str) -> Fraction:
    if not isinstance(value, str):
        raise _refuse("not_exact", noun, key=noun, value=repr(value),
                      unit="a decimal string")
    try:
        return _exact_fraction(value, noun, allow_percent=False)
    except (ValueError, ZeroDivisionError):
        raise _refuse("not_exact", noun, key=noun, value=repr(value),
                      unit="a decimal string")


def _elasticity(value: Any, pool: str) -> int:
    """5.2: volume elasticity is 0 or 1 and nothing between. A wire value is
    never truncated to fit (2.3): 0.5 refuses, it does not become 0."""
    exact = _fraction(value, pool)
    if exact not in (0, 1):
        raise _refuse("elasticity_value", pool, value=_text(exact), pool=pool)
    return int(exact)


def plan_request_from_body(body: Mapping[str, Any]) -> PlanRequest:
    """The validated wire fields as a plain mapping of decimal strings, to a
    PlanRequest. Never receives the Pydantic class (1.1)."""
    horizon = body.get("horizon") or {}
    overrides = []
    for key in sorted(body.get("overrides") or {}):
        values = (body["overrides"][key] or {}).get("values") or []
        overrides.append((key, tuple(None if v is None else _fraction(v, key)
                                     for v in values)))
    shocks = tuple(
        Shock(id=str(s["id"]), driver_key=str(s["driver_key"]), op=str(s["op"]),
              value=_fraction(s["value"], str(s["id"])),
              start_month=int(s.get("start_month", 1)),
              ramp_months=int(s.get("ramp_months", 0)),
              end_month=(None if s.get("end_month") is None else int(s["end_month"])),
              source=str(s.get("source", "user")), group_id=s.get("group_id"))
        for s in body.get("shocks") or [])
    behaviour = tuple(
        BehaviourOverride(
            pool=str(b["pool"]),
            fixed_share=(None if b.get("fixed_share") is None
                         else _fraction(b["fixed_share"], str(b["pool"]))),
            volume_elasticity=(None if b.get("volume_elasticity") is None
                               else _elasticity(b["volume_elasticity"], str(b["pool"]))))
        for b in body.get("behaviour_overrides") or [])
    debt = tuple(
        DebtRow(year=int(r["year"]),
                **dict((n, _fraction(r.get(n, "0"), "debt_schedule"))
                       for n in ("st_draw", "st_repay", "lt_draw", "lt_repay")))
        for r in body.get("debt_schedule") or [])
    return PlanRequest(
        total_years=int(horizon["total_years"]),
        monthly_months=int(horizon.get("monthly_months", 12)),
        case=str(body.get("case", "base")), case_id=body.get("case_id"),
        overrides=tuple(overrides), shocks=shocks, behaviour_overrides=behaviour,
        accept_proposals=tuple(body.get("accept_proposals") or ()),
        debt_schedule=debt, spread=body.get("spread"),
        compare_case_ids=tuple(body.get("compare_case_ids") or ()),
        tornado_metric=body.get("tornado_metric"),
        breakeven_from=str(body.get("breakeven_from", "baseline")),
        want=(None if body.get("want") is None else tuple(body["want"])))
