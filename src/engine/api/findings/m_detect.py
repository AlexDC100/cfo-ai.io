"""THE EIGHT MULTI-PERIOD ANALYSES.

Each one takes a window from `m_series` — never a raw list — measures a
DIMENSIONLESS observable, and hands back a :class:`Measurement`: the
figures a reader needs, the impact already computed through
`_ratio_units`, the materiality amount, and the tokens the prose is
filled from. It does NOT decide whether it fired. Comparing an observable
to a threshold is the engine's job, which is what makes the "All checks"
list complete: an analysis that ran and found nothing still returns its
observed value, so silence can be stated with the numbers behind it.

    M-DIRECTION   the same direction, unbroken, for N periods
    M-MAGNITUDE   the latest movement against the line's OWN dispersion
    M-DECOUPLE    a line and its driver growing apart
    M-VELOCITY    a working-capital cycle breaking from its own median
    M-REVERSAL    a period-end entry given back after the date
    M-DORMANT     an asset that has not moved while the book has
    M-TREND       a fitted slope, its agreement, and a projection
    M-SEASONAL    the same period one year earlier

THREE RULES THAT ARE NOT NEGOTIABLE HERE

1.  EVERY money quotient goes through `_ratio_units.ratio`. A zero
    denominator returns an outcome that says the ratio is UNDEFINED — it
    never returns zero, and it never returns a large number because the
    denominator was nearly nothing.

2.  A measurement whose inputs are missing is NOT APPLICABLE, with the
    reason spelled out. `Outcome.reason` reaches the "All checks" list, so
    "we could not measure this" is visible rather than looking like "we
    measured this and it was fine".

3.  NOTHING here reads a clock, a profile id or a company name. The same
    series always produces the same measurement, and the sentence about
    WHY it matters is added one layer up from the company profile.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .. import _finding as F
from .. import _ratio_units
from . import m_policy as P
from . import m_series as S
from . import m_stats as ST


# ── What an analysis returns ─────────────────────────────────────────────


@dataclass(frozen=True)
class MeasuredFigure:
    """A figure destined for the finding's evidence. `fact` is the key it
    also appears under in `facts`, which is what lets the renderer bind a
    printed money token to a typed placeholder."""

    fact: str
    value: float
    unit: str
    label: str


@dataclass(frozen=True)
class Measurement:
    """One analysis, one line (or one pair of lines), one period spine.

    `observed` holds a value for EVERY parameter the analysis declares —
    bands and gates alike — so the engine can pick the band that actually
    fired and record the rest on the checks list.
    """

    analysis_id: str
    series_key: str
    scope: str
    accounts: Tuple[F.Account, ...]
    observed: Dict[str, float]
    figures: Tuple[MeasuredFigure, ...]
    facts: Dict[str, float]
    basis_description: str
    basis_value: Optional[float]
    basis_unit: Optional[str]
    impact: F.Impact
    materiality_amount: float
    materiality_basis_id: str
    materiality_basis_value: Optional[float]
    tokens: Dict[str, str]
    root_cause: str
    contributors: Tuple[str, ...] = ()
    caveats: Tuple[str, ...] = ()
    line_refs: Tuple[str, ...] = ()
    periods_used: Tuple[str, ...] = ()


@dataclass(frozen=True)
class Outcome:
    """Either a measurement, or the stated reason there is none. Never
    both, never neither."""

    analysis_id: str
    series_key: str
    measurement: Optional[Measurement] = None
    reason: str = ""

    def measured(self) -> bool:
        return self.measurement is not None


def _na(analysis_id: str, series_key: str, reason: str) -> Outcome:
    return Outcome(analysis_id=analysis_id, series_key=series_key,
                   measurement=None, reason=reason)


# ── Shared arithmetic ────────────────────────────────────────────────────


def _q(value: float, currency: str, name: str) -> "_ratio_units.Quantity":
    return _ratio_units.money(float(value), currency, name=name)


def _share(part: float, whole: Optional[float], currency: str,
           part_name: str = "part", whole_name: str = "whole"
           ) -> Optional[float]:
    """A share of a total. `None` when the total is absent or zero — an
    undefined share, which is not the same claim as a share of zero."""
    if whole is None:
        return None
    return _ratio_units.safe_ratio(_q(part, currency, part_name),
                                  _q(whole, currency, whole_name))


def _relative_change(new: float, old: float, currency: str) -> Optional[float]:
    """(new - old) / old, as a fraction. `None` when `old` is zero: a
    percentage move away from nothing is undefined, and reporting it as
    infinite growth is how a 4 RON opening balance becomes a critical
    alert."""
    quotient = _ratio_units.safe_ratio(_q(new, currency, "new"),
                                       _q(old, currency, "old"))
    if quotient is None:
        return None
    return quotient - 1.0


def _basis_for(series_set: "S.SeriesSet", spec: "S.LineSpec",
               declared: str) -> Optional["S.AccountTimeSeries"]:
    basis_key = spec.basis if declared == "line" else declared
    return series_set.get(basis_key)


def _value_at(series: Optional["S.AccountTimeSeries"],
              period: "S.PeriodRef") -> Optional[float]:
    if series is None:
        return None
    obs = series.at(period.period_id)
    if obs is None or obs.is_gap():
        return None
    return float(obs.value)


def _cycle_days(stock: float, flow: float, currency: str,
                period: "S.PeriodRef") -> Optional[float]:
    """A working-capital cycle in days.

    The quotient is money over money and goes through the ratio law; the
    multiplier converts the resulting fraction-of-a-period into days. When
    the spine declares how many days the period covers, that number is
    used; otherwise `DAYS_IN_YEAR` is assumed and the caller attaches the
    caveat.
    """
    fraction = _ratio_units.safe_ratio(_q(stock, currency, "stock"),
                                       _q(flow, currency, "flow"))
    if fraction is None:
        return None
    span = period.days_covered if period.days_covered else S.DAYS_IN_YEAR
    return fraction * float(span)


def _tokens(spec: "S.LineSpec", periods: Tuple["S.PeriodRef", ...],
            **extra) -> Dict[str, str]:
    tokens = {
        "line": spec.label,
        "codes": ", ".join(a.code for a in spec.accounts) or spec.key,
        "latest_label": periods[-1].label if periods else "",
        "prior_label": periods[-2].label if len(periods) > 1 else "",
        "first_label": periods[0].label if periods else "",
        "periods": str(len(periods)),
    }
    for key, value in extra.items():
        tokens[key] = str(value)
    return tokens


# ── M-DIRECTION ──────────────────────────────────────────────────────────


def direction(series_set: "S.SeriesSet", series_key: str,
              params: Dict[str, float]) -> Outcome:
    """The same direction, unbroken, for N periods.

    A run counts MOVEMENTS, so a run of three means four readings each
    worse than the last, and it is measured on the CONTIGUOUS tail of the
    spine — a gap ends the run rather than being stepped over.
    """
    aid = P.M_DIRECTION.id
    series = series_set.get(series_key)
    if series is None:
        return _na(aid, series_key, "no series for this line")
    spec = series.spec
    if spec.role != S.ROLE_SUBJECT:
        return _na(aid, series_key, "%s is a denominator, not a subject" % spec.key)
    if spec.adverse_direction == S.DIRECTION_NONE:
        return _na(aid, series_key,
                   "direction carries no verdict for %s" % spec.label)
    history = S.History.of(series, aid, int(P.M_DIRECTION.min_periods))

    values = history.values()
    run = ST.trailing_run(values, spec.adverse_direction)
    idx = len(values) - 1 - run
    run_start = values[idx]
    latest = values[-1]
    change = _relative_change(latest, run_start, series.currency)
    if change is None:
        return _na(aid, series_key,
                   "the run starts from a zero balance, so a relative move "
                   "across it is undefined")

    periods = history.periods()
    basis = _basis_for(series_set, spec, P.M_DIRECTION.materiality_basis)
    basis_latest = _value_at(basis, periods[-1])
    share = _share(latest, basis_latest, series.currency, spec.key,
                   basis.key if basis else "basis")

    figures = [
        MeasuredFigure("run_periods_count", float(run), F.UNIT_COUNT,
                       "consecutive periods moving the same way"),
        MeasuredFigure("cumulative_change_pct", change, F.UNIT_PERCENT,
                       "cumulative move since %s" % periods[idx].label),
    ]
    if share is not None:
        figures.append(MeasuredFigure(
            "line_share_pct", share, F.UNIT_PERCENT,
            "share of %s" % (basis.label.lower() if basis else "the basis")))
    if spec.money_fact:
        figures.append(MeasuredFigure(
            spec.money_fact, latest, F.UNIT_MONEY,
            "%s at %s" % (spec.label.lower(), periods[-1].label)))

    try:
        impact = F.ratio_impact(
            metric="%s_vs_run_start" % spec.key,
            metric_label="%s measured against its level at %s"
                         % (spec.label, periods[idx].label),
            numerator=_q(run_start, series.currency, "run_start"),
            denominator=_q(run_start, series.currency, "run_start"),
            adjusted_numerator=_q(latest, series.currency, "latest"),
            adjusted_denominator=_q(run_start, series.currency, "run_start"),
            unit=F.UNIT_PERCENT)
    except _ratio_units.UndefinedRatioError as exc:
        return _na(aid, series_key, str(exc))

    return Outcome(aid, series_key, Measurement(
        analysis_id=aid, series_key=series_key,
        scope="%s (account %s)"
              % (spec.label, ", ".join(a.code for a in spec.accounts)),
        accounts=spec.accounts,
        observed={"min_consecutive_periods": float(run),
                  "severe_consecutive_periods": float(run),
                  "min_cumulative_change": abs(change)},
        figures=tuple(figures),
        facts=_facts(figures),
        basis_description="measured against the company's own reading of "
                          "%s at %s, the start of the run"
                          % (spec.label.lower(), periods[idx].label),
        basis_value=run_start, basis_unit=F.UNIT_MONEY,
        impact=impact,
        materiality_amount=abs(latest - run_start),
        materiality_basis_id=(basis.key if basis else ""),
        materiality_basis_value=basis_latest,
        tokens=_tokens(spec, periods, run=run),
        root_cause=spec.scope_key(),
        line_refs=tuple(a.code for a in spec.accounts),
        periods_used=tuple(p.label for p in periods[idx:]),
    ))


# ── M-MAGNITUDE ──────────────────────────────────────────────────────────


def magnitude(series_set: "S.SeriesSet", series_key: str,
              params: Dict[str, float]) -> Outcome:
    """The latest movement against the line's OWN dispersion.

    Robust median +- k * scaled MAD, with a minimum-history guard. A line
    that has never moved has no dispersion, and the answer to "how
    unusual is this move" is then UNDEFINED rather than infinite — which
    is the difference between a real outlier and a first-ever posting.
    """
    aid = P.M_MAGNITUDE.id
    series = series_set.get(series_key)
    if series is None:
        return _na(aid, series_key, "no series for this line")
    spec = series.spec
    if spec.role != S.ROLE_SUBJECT:
        return _na(aid, series_key, "%s is a denominator, not a subject" % spec.key)
    history = S.History.of(series, aid, int(P.M_MAGNITUDE.min_periods))

    moves = history.movements()
    latest_move = moves[-1]
    try:
        spread = ST.dispersion(moves)
        score = ST.robust_z(latest_move, moves, series.currency,
                            name="latest_movement")
    except ST.DispersionUndefinedError as exc:
        return _na(aid, series_key, str(exc))
    caveats = tuple(c for c in (spread.caveat(),) if c)

    periods = history.periods()
    basis = _basis_for(series_set, spec, P.M_MAGNITUDE.materiality_basis)
    basis_latest = _value_at(basis, periods[-1])
    basis_prev = _value_at(basis, periods[-2])
    if basis_latest is None or basis_prev is None:
        return _na(aid, series_key,
                   "%s is not carried in both periods, so the movement cannot "
                   "be restated as a share of it"
                   % (basis.label.lower() if basis else "the basis"))

    move_share = _share(abs(latest_move), basis_latest, series.currency,
                        "movement", basis.key)
    share = _share(history.latest(), basis_latest, series.currency,
                   spec.key, basis.key)
    figures = [
        MeasuredFigure("movement_score", score, F.UNIT_SCORE,
                       "robust deviation of the %s movement" % periods[-1].label),
        MeasuredFigure("move_share_pct", move_share or 0.0, F.UNIT_PERCENT,
                       "the movement as a share of %s" % basis.label.lower()),
    ]
    if share is not None:
        figures.append(MeasuredFigure(
            "line_share_pct", share, F.UNIT_PERCENT,
            "share of %s at %s" % (basis.label.lower(), periods[-1].label)))
    if spec.money_fact:
        figures.append(MeasuredFigure(
            spec.money_fact, history.latest(), F.UNIT_MONEY,
            "%s at %s" % (spec.label.lower(), periods[-1].label)))

    try:
        impact = F.ratio_impact(
            metric="%s_share_of_%s" % (spec.key, basis.key),
            metric_label="%s as a share of %s" % (spec.label, basis.label.lower()),
            numerator=_q(history.previous(), series.currency, "previous"),
            denominator=_q(basis_prev, series.currency, "basis_previous"),
            adjusted_numerator=_q(history.latest(), series.currency, "latest"),
            adjusted_denominator=_q(basis_latest, series.currency, "basis_latest"),
            unit=F.UNIT_PERCENT)
    except _ratio_units.UndefinedRatioError as exc:
        return _na(aid, series_key, str(exc))

    return Outcome(aid, series_key, Measurement(
        analysis_id=aid, series_key=series_key,
        scope="%s movement (account %s)"
              % (spec.label, ", ".join(a.code for a in spec.accounts)),
        accounts=spec.accounts,
        observed={"k_mad": score, "severe_k_mad": score},
        figures=tuple(figures), facts=_facts(figures),
        basis_description="measured against the median and the %s of this "
                          "line's own %d movements, not against a sector table"
                          % (spread.method.replace("_", " "), len(moves)),
        basis_value=spread.centre, basis_unit=F.UNIT_MONEY,
        impact=impact,
        materiality_amount=abs(latest_move),
        materiality_basis_id=basis.key,
        materiality_basis_value=basis_latest,
        caveats=caveats,
        tokens=_tokens(spec, periods),
        root_cause=spec.scope_key(),
        line_refs=tuple(a.code for a in spec.accounts),
        periods_used=tuple(p.label for p in periods),
    ))


# ── M-DECOUPLE ───────────────────────────────────────────────────────────

#: (driven line, driver line). Declared, not discovered: a correlation
#: found by search across every pair of canonical lines would produce a
#: finding for any two series that happened to move together, which is
#: the generic-finding failure in a new costume.
DECOUPLE_PAIRS = (
    ("cogs", "revenue"),
    ("opex_third_party", "revenue"),
    ("inventory", "revenue"),
    ("inventory", "cogs"),
    ("ar_net", "revenue"),
    ("interest_expense", "revenue"),
)


def decouple(series_set: "S.SeriesSet", pair: Tuple[str, str],
             params: Dict[str, float]) -> Outcome:
    """Two lines that are supposed to move together, growing apart.

    The observable is the GAP between their growth rates, not the growth
    of either one: revenue up 4% with cost up 19% is the same finding as
    revenue down 12% with cost flat, and both are invisible to a rule
    that looks at one line at a time.
    """
    aid = P.M_DECOUPLE.id
    driven_key, driver_key = pair
    key = "%s~%s" % (driven_key, driver_key)
    driven = series_set.get(driven_key)
    driver = series_set.get(driver_key)
    if driven is None or driver is None:
        return _na(aid, key, "one of the two lines is not carried")
    paired = S.PairedHistory.of(driven, driver, aid,
                                int(P.M_DECOUPLE.min_periods))

    prior_period, prior_driven, prior_driver = paired.previous()
    latest_period, latest_driven, latest_driver = paired.latest()
    g_driven = _relative_change(latest_driven, prior_driven, driven.currency)
    g_driver = _relative_change(latest_driver, prior_driver, driver.currency)
    if g_driven is None or g_driver is None:
        return _na(aid, key,
                   "one of the two lines reads zero at %s, so its growth rate "
                   "is undefined" % prior_period.label)
    intensity_prior = _share(prior_driven, prior_driver, driven.currency,
                             driven_key, driver_key)
    intensity_latest = _share(latest_driven, latest_driver, driven.currency,
                              driven_key, driver_key)
    if intensity_prior is None or intensity_latest is None:
        return _na(aid, key, "%s reads zero, so the intensity ratio is "
                             "undefined" % driver.label.lower())

    # Adverse = the driven line outgrew its driver when the driven line is
    # a cost or a working-capital asset; the reverse for a line where more
    # is better. Direction comes from the line table, never from a guess.
    sign = -1.0 if driven.spec.adverse_direction == S.DIRECTION_DOWN else 1.0
    divergence = (g_driven - g_driver) * sign

    figures = [
        MeasuredFigure("divergence_pct", divergence, F.UNIT_PERCENT,
                       "growth gap between %s and %s"
                       % (driven.label.lower(), driver.label.lower())),
        MeasuredFigure("intensity_latest_pct", intensity_latest, F.UNIT_PERCENT,
                       "%s as a share of %s at %s"
                       % (driven.label.lower(), driver.label.lower(),
                          latest_period.label)),
        MeasuredFigure("intensity_prior_pct", intensity_prior, F.UNIT_PERCENT,
                       "the same share at %s" % prior_period.label),
    ]
    if driver.spec.money_fact:
        figures.append(MeasuredFigure(
            driver.spec.money_fact, latest_driver, F.UNIT_MONEY,
            "%s at %s" % (driver.label.lower(), latest_period.label)))

    try:
        impact = F.ratio_impact(
            metric="%s_intensity" % driven_key,
            metric_label="%s as a share of %s"
                         % (driven.label, driver.label.lower()),
            numerator=_q(prior_driven, driven.currency, "prior_driven"),
            denominator=_q(prior_driver, driver.currency, "prior_driver"),
            adjusted_numerator=_q(latest_driven, driven.currency, "latest_driven"),
            adjusted_denominator=_q(latest_driver, driver.currency, "latest_driver"),
            unit=F.UNIT_PERCENT)
    except _ratio_units.UndefinedRatioError as exc:
        return _na(aid, key, str(exc))

    accounts = driven.accounts + driver.accounts
    tokens = _tokens(driven.spec, tuple(p for p, _a, _b in paired.points),
                     driver=driver.label.lower())
    return Outcome(aid, key, Measurement(
        analysis_id=aid, series_key=key,
        scope="%s against %s (accounts %s)"
              % (driven.label, driver.label.lower(),
                 ", ".join(a.code for a in accounts)),
        accounts=accounts,
        observed={"divergence_high": divergence, "severe_divergence": divergence},
        figures=tuple(figures), facts=_facts(figures),
        basis_description="measured against the same two lines one period "
                          "earlier, at %s" % prior_period.label,
        basis_value=intensity_prior, basis_unit=F.UNIT_PERCENT,
        impact=impact,
        materiality_amount=abs(intensity_latest - intensity_prior) * abs(latest_driver),
        materiality_basis_id=S.BASIS_REVENUE,
        materiality_basis_value=_value_at(series_set.get(S.BASIS_REVENUE),
                                          latest_period),
        tokens=tokens,
        root_cause="%s+%s" % (driven.spec.scope_key(), driver.spec.scope_key()),
        contributors=(driven_key, driver_key),
        line_refs=tuple(a.code for a in accounts),
        periods_used=(prior_period.label, latest_period.label),
    ))


# ── M-VELOCITY ───────────────────────────────────────────────────────────

#: (cycle id, label, stock line, flow line). DSO, DIO and DPO, named the
#: way a treasurer names them.
CYCLES = (
    ("dso", "Days sales outstanding", "ar_net", "revenue"),
    ("dio", "Days inventory outstanding", "inventory", "cogs"),
    ("dpo", "Days payables outstanding", "accounts_payable", "cogs"),
)


def velocity(series_set: "S.SeriesSet", cycle: Tuple[str, str, str, str],
             params: Dict[str, float]) -> Outcome:
    """A working-capital cycle breaking from the company's OWN median.

    Not from a sector band: a distributor running a structural 90-day
    cycle is not in trouble, and the same distributor at 120 days is. The
    comparison that carries information is against its own history.
    """
    aid = P.M_VELOCITY.id
    cycle_id, cycle_label, stock_key, flow_key = cycle
    stock = series_set.get(stock_key)
    flow = series_set.get(flow_key)
    if stock is None or flow is None:
        return _na(aid, cycle_id, "the balance or the flow line is not carried")
    paired = S.PairedHistory.of(stock, flow, aid, int(P.M_VELOCITY.min_periods))

    days = []  # type: List[Tuple[S.PeriodRef, float]]
    assumed_span = False
    for period, stock_v, flow_v in paired.points:
        value = _cycle_days(stock_v, flow_v, stock.currency, period)
        if value is None:
            return _na(aid, cycle_id,
                       "%s reads zero at %s, so the cycle is undefined there"
                       % (flow.label.lower(), period.label))
        if not period.days_covered:
            assumed_span = True
        days.append((period, value))

    latest_period, latest_days = days[-1]
    history_days = [v for _p, v in days[:-1]]
    median_days = ST.median(history_days)
    break_days = latest_days - median_days

    figures = [
        MeasuredFigure("cycle_days", latest_days, F.UNIT_DAYS,
                       "%s at %s" % (cycle_label.lower(), latest_period.label)),
        MeasuredFigure("median_cycle_days", median_days, F.UNIT_DAYS,
                       "the company's own median across %d earlier period(s)"
                       % len(history_days)),
        MeasuredFigure("cycle_break_days", break_days, F.UNIT_DAYS,
                       "break from that median"),
    ]
    _p_latest, _s_latest, flow_latest = paired.latest()
    if flow.spec.money_fact:
        figures.append(MeasuredFigure(
            flow.spec.money_fact, flow_latest, F.UNIT_MONEY,
            "%s at %s" % (flow.label.lower(), latest_period.label)))

    impact = F.headroom_impact(
        metric=cycle_id, metric_label=cycle_label,
        observed=_ratio_units.days(latest_days, name="observed_cycle"),
        limit=_ratio_units.days(median_days, name="median_cycle"))

    caveats = ()  # type: Tuple[str, ...]
    if assumed_span:
        caveats = ("The cycle is annualised at %d days because the period "
                   "spine does not declare how many days each period covers."
                   % S.DAYS_IN_YEAR,)

    accounts = stock.accounts
    tokens = _tokens(stock.spec, tuple(p for p, _a, _b in paired.points),
                     cycle=cycle_label.lower(), driver=flow.label.lower())
    return Outcome(aid, cycle_id, Measurement(
        analysis_id=aid, series_key=cycle_id,
        scope="%s (account %s)"
              % (cycle_label, ", ".join(a.code for a in accounts)),
        accounts=accounts,
        observed={"days_break_high": break_days, "severe_days_break": break_days},
        figures=tuple(figures), facts=_facts(figures),
        basis_description="measured against this company's own median %s "
                          "across %d earlier period(s)"
                          % (cycle_label.lower(), len(history_days)),
        basis_value=median_days, basis_unit=F.UNIT_DAYS,
        impact=impact,
        # The cash the lengthened cycle ties up: the extra days as a
        # fraction of the period the FLOW actually covers, times that
        # flow. Using a hard 365 here on a monthly spine would
        # understate it twelvefold.
        materiality_amount=(abs(break_days)
                            / float(latest_period.days_covered
                                    or S.DAYS_IN_YEAR)
                            * abs(flow_latest)),
        materiality_basis_id=(stock.spec.basis),
        materiality_basis_value=_value_at(
            series_set.get(stock.spec.basis), latest_period),
        tokens=tokens,
        root_cause=stock.spec.scope_key(),
        contributors=(stock_key, flow_key),
        caveats=caveats,
        line_refs=tuple(a.code for a in accounts),
        periods_used=tuple(p.label for p, _v in days),
    ))


# ── M-REVERSAL ───────────────────────────────────────────────────────────


def reversal(series_set: "S.SeriesSet", series_key: str,
             params: Dict[str, float]) -> Outcome:
    """A period-end move given back after the date.

    Scans the interior of the contiguous tail for a movement followed by
    an opposite movement of comparable size, and reports the MOST RECENT
    one. This is the shape of a reclassification booked to make a period
    end look a particular way; the giveback in the next period is the
    evidence, and it is only visible with the periods side by side.
    """
    aid = P.M_REVERSAL.id
    series = series_set.get(series_key)
    if series is None:
        return _na(aid, series_key, "no series for this line")
    spec = series.spec
    if spec.role != S.ROLE_SUBJECT:
        return _na(aid, series_key, "%s is a denominator, not a subject" % spec.key)
    history = S.History.of(series, aid, int(P.M_REVERSAL.min_periods))

    values = history.values()
    periods = history.periods()
    basis = _basis_for(series_set, spec, P.M_REVERSAL.materiality_basis)

    # Selected by the AMOUNT that actually went out and came back —
    # min(|spike|, |unwind|) — with the most recent winning a tie.
    #
    # Not "the most recent sign change": on a line that spikes and then
    # settles, the tiny wobble in the last two periods is a sign change
    # too, and taking it would report a 0.6% giveback while the 16.8M
    # reversal one period earlier went unmentioned. The money that left
    # and returned is what the finding is about, so that is what selects
    # the candidate.
    found = None  # type: Optional[Tuple[int, float, float, float]]
    best_amount = 0.0
    for i in range(len(values) - 2, 0, -1):
        spike = values[i] - values[i - 1]
        unwind = values[i + 1] - values[i]
        if spike == 0.0 or unwind == 0.0:
            continue
        if (spike > 0) == (unwind > 0):
            continue
        given_back = _ratio_units.safe_ratio(
            _q(abs(unwind), series.currency, "unwind"),
            _q(abs(spike), series.currency, "spike"))
        if given_back is None:
            continue
        amount = min(abs(spike), abs(unwind))
        if amount > best_amount:
            found, best_amount = (i, spike, unwind, given_back), amount

    if found is None:
        return _na(aid, series_key,
                   "no movement on this line was followed by an opposite "
                   "movement across the %d contiguous periods examined"
                   % len(values))
    basis_spike = _value_at(basis, periods[found[0]])
    basis_after = _value_at(basis, periods[found[0] + 1])
    if basis_spike is None or basis_after is None:
        return _na(aid, series_key,
                   "%s is not carried in both periods, so the reversal cannot "
                   "be restated as a share of it"
                   % (basis.label.lower() if basis else "the basis"))

    idx, spike, unwind, given_back = found
    spike_share = _share(abs(spike), basis_spike, series.currency,
                         "spike", basis.key)
    if spike_share is None:
        return _na(aid, series_key,
                   "%s reads zero at %s" % (basis.label.lower(),
                                            periods[idx].label))

    figures = [
        MeasuredFigure("reversed_share_pct", given_back, F.UNIT_PERCENT,
                       "share of the %s move given back by %s"
                       % (periods[idx].label, periods[idx + 1].label)),
        MeasuredFigure("spike_share_pct", spike_share, F.UNIT_PERCENT,
                       "the %s move as a share of %s"
                       % (periods[idx].label, basis.label.lower())),
    ]
    if spec.money_fact:
        figures.append(MeasuredFigure(
            spec.money_fact, values[idx], F.UNIT_MONEY,
            "%s at %s" % (spec.label.lower(), periods[idx].label)))

    try:
        impact = F.ratio_impact(
            metric="%s_share_of_%s" % (spec.key, basis.key),
            metric_label="%s as a share of %s, across the reversal"
                         % (spec.label, basis.label.lower()),
            numerator=_q(values[idx], series.currency, "at_spike"),
            denominator=_q(basis_spike, series.currency, "basis_at_spike"),
            adjusted_numerator=_q(values[idx + 1], series.currency, "after"),
            adjusted_denominator=_q(basis_after, series.currency, "basis_after"),
            unit=F.UNIT_PERCENT)
    except _ratio_units.UndefinedRatioError as exc:
        return _na(aid, series_key, str(exc))

    tokens = _tokens(spec, periods, spike_label=periods[idx].label)
    tokens["latest_label"] = periods[idx + 1].label
    return Outcome(aid, series_key, Measurement(
        analysis_id=aid, series_key=series_key,
        scope="%s reversal (account %s)"
              % (spec.label, ", ".join(a.code for a in spec.accounts)),
        accounts=spec.accounts,
        observed={"reversal_share_min": given_back,
                  "severe_reversal_share": given_back,
                  "spike_share_of_basis_min": spike_share},
        figures=tuple(figures), facts=_facts(figures),
        basis_description="measured against the same account one period after "
                          "the entry, at %s" % periods[idx + 1].label,
        basis_value=values[idx - 1], basis_unit=F.UNIT_MONEY,
        impact=impact,
        materiality_amount=best_amount,
        materiality_basis_id=basis.key,
        materiality_basis_value=basis_spike,
        tokens=tokens,
        root_cause=spec.scope_key(),
        line_refs=tuple(a.code for a in spec.accounts),
        periods_used=(periods[idx - 1].label, periods[idx].label,
                      periods[idx + 1].label),
    ))


# ── M-DORMANT ────────────────────────────────────────────────────────────


def dormant(series_set: "S.SeriesSet", series_key: str,
            params: Dict[str, float]) -> Outcome:
    """An asset that has not moved while the book around it has.

    Restricted to ASSETS on purpose. A payable that has not moved is a
    supplier who has not invoiced; a receivable that has not moved for
    four periods is money the company has stopped collecting, and it is
    still sitting in the current-asset total.
    """
    aid = P.M_DORMANT.id
    series = series_set.get(series_key)
    if series is None:
        return _na(aid, series_key, "no series for this line")
    spec = series.spec
    if spec.role != S.ROLE_SUBJECT or spec.side != S.SIDE_ASSET:
        return _na(aid, series_key,
                   "dormancy is a claim about an asset; %s is %s"
                   % (spec.label.lower(), spec.side))
    if not spec.dormancy:
        return _na(aid, series_key,
                   "a flat %s balance is not an aging problem; the line table declares dormancy meaningless here" % spec.label.lower())
    history = S.History.of(series, aid, int(P.M_DORMANT.min_periods))

    tolerance = float(params.get("movement_tolerance", 0.005))
    values = history.values()
    periods = history.periods()
    run = ST.unchanged_run(values, tolerance)
    latest = values[-1]

    equity = _value_at(series_set.get(S.BASIS_EQUITY), periods[-1])
    assets = _value_at(series_set.get(S.BASIS_ASSETS), periods[-1])
    if equity is None or assets is None:
        return _na(aid, series_key,
                   "total equity or total assets is not carried at %s, so the "
                   "haircut cannot be recomputed" % periods[-1].label)
    share = _share(latest, assets, series.currency, spec.key, "total_assets")
    if share is None:
        return _na(aid, series_key,
                   "total assets reads zero at %s" % periods[-1].label)

    figures = [
        MeasuredFigure("dormant_periods_count", float(run), F.UNIT_COUNT,
                       "consecutive periods without movement"),
        MeasuredFigure("line_share_pct", share, F.UNIT_PERCENT,
                       "share of total assets"),
    ]
    if spec.money_fact:
        figures.append(MeasuredFigure(
            spec.money_fact, latest, F.UNIT_MONEY,
            "%s standing at %s" % (spec.label.lower(), periods[-1].label)))

    try:
        impact = F.ratio_impact(
            metric="equity_ratio_ex_%s" % spec.key,
            metric_label="Equity ratio once the dormant balance is written off "
                         "against equity",
            numerator=_q(equity, series.currency, "total_equity"),
            denominator=_q(assets, series.currency, "total_assets"),
            adjusted_numerator=_q(equity - latest, series.currency,
                                  "equity_ex_line"),
            adjusted_denominator=_q(assets - latest, series.currency,
                                    "assets_ex_line"),
            unit=F.UNIT_PERCENT)
    except _ratio_units.UndefinedRatioError as exc:
        return _na(aid, series_key, str(exc))

    return Outcome(aid, series_key, Measurement(
        analysis_id=aid, series_key=series_key,
        scope="Dormant %s (account %s)"
              % (spec.label.lower(), ", ".join(a.code for a in spec.accounts)),
        accounts=spec.accounts,
        observed={"min_dormant_periods": float(run),
                  "severe_dormant_periods": float(run),
                  "min_share_of_basis": share,
                  "movement_tolerance": tolerance},
        figures=tuple(figures), facts=_facts(figures),
        basis_description="measured against this account's own balance in each "
                          "of the %d periods to %s"
                          % (len(values), periods[-1].label),
        basis_value=float(run), basis_unit=F.UNIT_COUNT,
        impact=impact,
        materiality_amount=abs(latest),
        materiality_basis_id=S.BASIS_ASSETS,
        materiality_basis_value=assets,
        tokens=_tokens(spec, periods, run=run),
        root_cause=spec.scope_key(),
        line_refs=tuple(a.code for a in spec.accounts),
        periods_used=tuple(p.label for p in periods[len(values) - run - 1:]),
    ))


# ── M-TREND ──────────────────────────────────────────────────────────────


def trend(series_set: "S.SeriesSet", series_key: str,
          params: Dict[str, float]) -> Outcome:
    """A fitted slope, its agreement, and where it lands.

    The slope is Theil–Sen (the median of all pairwise slopes), so one
    restated period cannot set the direction on its own, and it is fitted
    to the line's SHARE of its basis rather than to the raw amount — a
    company that doubled in size has not deteriorated because its
    receivable doubled with it.

    `agreement` is reported and gated: a steep slope through points that
    disagree about the direction is noise with a line drawn through it.
    """
    aid = P.M_TREND.id
    series = series_set.get(series_key)
    if series is None:
        return _na(aid, series_key, "no series for this line")
    spec = series.spec
    if spec.role != S.ROLE_SUBJECT:
        return _na(aid, series_key, "%s is a denominator, not a subject" % spec.key)
    if spec.adverse_direction == S.DIRECTION_NONE:
        return _na(aid, series_key,
                   "direction carries no verdict for %s" % spec.label)
    history = S.History.of(series, aid, int(P.M_TREND.min_periods))

    basis = _basis_for(series_set, spec, P.M_TREND.materiality_basis)
    periods = history.periods()
    points = []  # type: List[Tuple[float, float]]
    for index, obs in enumerate(history.points):
        whole = _value_at(basis, obs.period)
        part_share = _share(float(obs.value), whole, series.currency,
                            spec.key, basis.key if basis else "basis")
        if part_share is None:
            return _na(aid, series_key,
                       "%s is not carried at %s, so the share cannot be fitted"
                       % (basis.label.lower() if basis else "the basis",
                          obs.period.label))
        points.append((float(index), part_share))

    slope, agreement = ST.theil_sen(points)
    latest_share = points[-1][1]
    adverse = (slope > 0) if spec.adverse_direction == S.DIRECTION_UP else (slope < 0)
    horizon = int(params.get("projection_periods", 3))
    projected = ST.project(latest_share, slope, horizon, floor=0.0)
    clamped = projected == 0.0 and latest_share + slope * horizon < 0.0

    figures = [
        MeasuredFigure("slope_per_period_pct", abs(slope), F.UNIT_PERCENT,
                       "fitted move in the share of %s per period"
                       % (basis.label.lower() if basis else "the basis")),
        MeasuredFigure("agreement_pct", agreement, F.UNIT_PERCENT,
                       "share of pairwise slopes agreeing on the direction"),
        MeasuredFigure("line_share_pct", latest_share, F.UNIT_PERCENT,
                       "share at %s" % periods[-1].label),
        MeasuredFigure("projected_share_pct", projected, F.UNIT_PERCENT,
                       "share projected %d periods forward" % horizon),
    ]

    impact = F.headroom_impact(
        metric="%s_projected_share" % spec.key,
        metric_label="%s as a share of %s, projected %d periods forward on the "
                     "fitted slope"
                     % (spec.label, basis.label.lower() if basis else "the basis",
                        horizon),
        observed=_ratio_units.percent_q(projected, name="projected_share"),
        limit=_ratio_units.percent_q(latest_share, name="current_share"))

    caveats = []  # type: List[str]
    if clamped:
        caveats.append(
            "The projection is floored at zero: held at the fitted rate the "
            "share would run below zero inside the horizon, which is "
            "arithmetic leaving its own domain rather than a forecast.")

    basis_latest = _value_at(basis, periods[-1])
    return Outcome(aid, series_key, Measurement(
        analysis_id=aid, series_key=series_key,
        scope="%s trend (account %s)"
              % (spec.label, ", ".join(a.code for a in spec.accounts)),
        accounts=spec.accounts,
        observed={"min_slope_per_period": abs(slope) if adverse else 0.0,
                  "severe_slope": abs(slope) if adverse else 0.0,
                  "min_agreement": agreement,
                  "projection_periods": float(horizon)},
        figures=tuple(figures), facts=_facts(figures),
        basis_description="fitted across this company's own %d periods to %s, "
                          "as a share of %s in each one"
                          % (len(points), periods[-1].label,
                             basis.label.lower() if basis else "the basis"),
        basis_value=latest_share, basis_unit=F.UNIT_PERCENT,
        impact=impact,
        materiality_amount=(abs(projected - latest_share) * abs(basis_latest)
                            if basis_latest else 0.0),
        materiality_basis_id=(basis.key if basis else ""),
        materiality_basis_value=basis_latest,
        tokens=_tokens(spec, periods, horizon=horizon),
        root_cause=spec.scope_key(),
        caveats=tuple(caveats),
        line_refs=tuple(a.code for a in spec.accounts),
        periods_used=tuple(p.label for p in periods),
    ))


# ── M-SEASONAL ───────────────────────────────────────────────────────────


def seasonal(series_set: "S.SeriesSet", series_key: str,
             params: Dict[str, float]) -> Outcome:
    """The same period one calendar year earlier.

    Matched on (year, month), never on "twelve rows back". A spine with a
    gap in it, or one that mixes quarterly and monthly periods, would make
    positional matching compare December with March — and the resulting
    "year-over-year collapse" would be a calendar artefact reported as a
    business event.
    """
    aid = P.M_SEASONAL.id
    series = series_set.get(series_key)
    if series is None:
        return _na(aid, series_key, "no series for this line")
    spec = series.spec
    if spec.role != S.ROLE_SUBJECT:
        return _na(aid, series_key, "%s is a denominator, not a subject" % spec.key)
    if spec.adverse_direction == S.DIRECTION_NONE:
        return _na(aid, series_key,
                   "direction carries no verdict for %s" % spec.label)
    yoy = S.YearOverYear.of(series, aid)

    current = float(yoy.current.value)
    prior = float(yoy.prior_year.value)
    change = _relative_change(current, prior, series.currency)
    if change is None:
        return _na(aid, series_key,
                   "%s read zero at %s, so the year-over-year move is undefined"
                   % (spec.label.lower(), yoy.prior_year.period.label))
    adverse = (change > 0) if spec.adverse_direction == S.DIRECTION_UP else (change < 0)

    basis = _basis_for(series_set, spec, P.M_SEASONAL.materiality_basis)
    basis_now = _value_at(basis, yoy.current.period)
    basis_then = _value_at(basis, yoy.prior_year.period)
    if basis_now is None or basis_then is None:
        return _na(aid, series_key,
                   "%s is not carried in both years, so the share cannot be "
                   "compared" % (basis.label.lower() if basis else "the basis"))
    share_now = _share(current, basis_now, series.currency, spec.key, basis.key)
    share_then = _share(prior, basis_then, series.currency, spec.key, basis.key)
    if share_now is None or share_then is None:
        return _na(aid, series_key, "%s reads zero in one of the two years"
                                    % basis.label.lower())

    figures = [
        MeasuredFigure("yoy_change_pct", change, F.UNIT_PERCENT,
                       "move against %s" % yoy.prior_year.period.label),
        MeasuredFigure("line_share_pct", share_now, F.UNIT_PERCENT,
                       "share of %s at %s" % (basis.label.lower(),
                                              yoy.current.period.label)),
        MeasuredFigure("line_share_prior_pct", share_then, F.UNIT_PERCENT,
                       "the same share at %s" % yoy.prior_year.period.label),
    ]
    if spec.money_fact:
        figures.append(MeasuredFigure(
            spec.money_fact, current, F.UNIT_MONEY,
            "%s at %s" % (spec.label.lower(), yoy.current.period.label)))

    try:
        impact = F.ratio_impact(
            metric="%s_share_year_on_year" % spec.key,
            metric_label="%s as a share of %s, year on year"
                         % (spec.label, basis.label.lower()),
            numerator=_q(prior, series.currency, "prior_year"),
            denominator=_q(basis_then, series.currency, "basis_prior_year"),
            adjusted_numerator=_q(current, series.currency, "current"),
            adjusted_denominator=_q(basis_now, series.currency, "basis_current"),
            unit=F.UNIT_PERCENT)
    except _ratio_units.UndefinedRatioError as exc:
        return _na(aid, series_key, str(exc))

    tokens = _tokens(spec, (yoy.prior_year.period, yoy.current.period))
    return Outcome(aid, series_key, Measurement(
        analysis_id=aid, series_key=series_key,
        scope="%s year on year (account %s)"
              % (spec.label, ", ".join(a.code for a in spec.accounts)),
        accounts=spec.accounts,
        observed={"yoy_change_high": abs(change) if adverse else 0.0,
                  "severe_yoy_change": abs(change) if adverse else 0.0},
        figures=tuple(figures), facts=_facts(figures),
        basis_description="measured against %s, the same calendar period one "
                          "year earlier" % yoy.prior_year.period.label,
        basis_value=prior, basis_unit=F.UNIT_MONEY,
        impact=impact,
        materiality_amount=abs(current - prior),
        materiality_basis_id=(basis.key if basis else ""),
        materiality_basis_value=basis_now,
        tokens=tokens,
        root_cause=spec.scope_key(),
        line_refs=tuple(a.code for a in spec.accounts),
        periods_used=(yoy.prior_year.period.label, yoy.current.period.label),
    ))


# ── helpers ──────────────────────────────────────────────────────────────


def _facts(figures: List[MeasuredFigure]) -> Dict[str, float]:
    return dict((f.fact, float(f.value)) for f in figures)


__all__ = [
    "CYCLES", "DECOUPLE_PAIRS", "MeasuredFigure", "Measurement", "Outcome",
    "decouple", "direction", "dormant", "magnitude", "reversal", "seasonal",
    "trend", "velocity",
]
