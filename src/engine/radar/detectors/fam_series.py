"""THE CROSS-PERIOD FAMILIES.

Seven of the twelve. Each one is a claim that only exists across time, so
none of them is single-period-valid and every one of them refuses on a
short history rather than fitting a line through what it has:

    direction   the same way, unbroken, for N movements
    magnitude   the latest movement against the line's OWN dispersion,
                median-and-MAD, with a MINIMUM-HISTORY GUARD
    decouple    two lines growing apart while one of them is flat
    velocity    a working-capital cycle breaking from its own median,
                per counterparty where the book carries the analytics
    reversal    a period-end movement handed back after the date, read
                from MOVEMENT PAIRS rather than from net balances
    dormant     an account that stopped, then restarted materially
    cutoff      the share of a year's activity landing in its final
                period, against the account's own history of that share

SEASONALITY, WHERE THE HISTORY SUPPORTS IT. With two or more calendar
years on the spine and a same-(year, month) counterpart present, the
comparison basis for a trend claim is THAT period, not the one before —
a December stock build compared against November is a season, and calling
it a trend break is the false positive this rule exists to prevent. The
finding says which basis judged it, every time.

The robust statistics are ``engine.api.findings.m_stats`` — median, MAD
with its named fallback, robust z, runs. They are not reimplemented here.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

from engine.api import _finding as F
from engine.api import _ratio_units
from engine.api.findings import m_stats as ST

from . import book as B
from . import support as SUP
from .pack import DetectorSpec
from .registry import register
from .result import DetectorResult, MeasuredFigure, na

DIRECTION_UP = "up"
DIRECTION_DOWN = "down"

#: Basis kinds, in the vocabulary ``_finding.COMPARISON_BASIS_KINDS``
#: declares. A detector may not invent one.
BASIS_PRIOR = "prior_period"
BASIS_SELF = "self_total"
BASIS_THRESHOLD = "profile_threshold"

#: Calendar years needed before a same-period-last-year basis is used.
SEASONAL_MIN_YEARS = 2


def _values(points: Sequence["B.SeriesPoint"]) -> List[float]:
    return [float(p.value) for p in points if p.value is not None]


def _labels(points: Sequence["B.SeriesPoint"]) -> Tuple[str, ...]:
    return tuple(p.book.label for p in points)


def _seasonal_basis(series: "B.BookSeries", points: Sequence["B.SeriesPoint"]
                    ) -> Tuple[Optional["B.SeriesPoint"], str]:
    """The reference the trend claim is judged against, and its name. The
    same-period-last-year point when the spine carries two calendar years
    and that period is present; otherwise the immediately prior period."""
    if series.years_covered() >= SEASONAL_MIN_YEARS:
        yoy = series.same_period_last_year(points)
        if yoy is not None:
            return yoy, "same period one year earlier (%s)" % yoy.book.label
    if len(points) >= 2:
        return points[-2], "the prior period (%s)" % points[-2].book.label
    return None, "no earlier period"


def _tail(series: "B.BookSeries", spec: "DetectorSpec", measure: str
          ) -> Tuple[Tuple["B.SeriesPoint", ...], Optional[str]]:
    prefixes = spec.prefixes("subject")
    if not prefixes:
        return (), "detector declares no accounts.subject prefixes"
    points = series.readings(prefixes, measure)
    tail = series.contiguous_tail(points)
    if not tail:
        return (), ("no period in the spine carries an account under %s, so "
                    "there is nothing to read across time"
                    % ", ".join(prefixes))
    return tail, None


# ── D-DIRECTION ──────────────────────────────────────────────────────────


@register("direction")
def direction(spec: "DetectorSpec", series: "B.BookSeries",
              profile: Any) -> List["DetectorResult"]:
    """The account has moved the same way for N consecutive movements, and
    the cumulative move is material against a served total."""
    measure = str(spec.params.get("measure", "closing"))
    tail, why = _tail(series, spec, measure)
    if why:
        return [na(spec.id, "direction", why)]
    min_run = int(spec.number("min_run"))
    adverse = str(spec.param("adverse_direction"))
    labels = _labels(tail)
    if len(tail) < min_run + 1:
        return [na(spec.id, "direction",
                   "a run of %d movements needs %d contiguous readings; the "
                   "spine carries %d (%s)"
                   % (min_run, min_run + 1, len(tail), ", ".join(labels)),
                   periods=labels)]
    values = _values(tail)
    run = ST.trailing_run(values, adverse)
    latest_book = tail[-1].book
    basis = SUP.basis_of(spec, latest_book)
    if basis is None:
        return [na(spec.id, "direction", SUP.basis_missing_reason(spec),
                   periods=labels)]

    start_value = values[len(values) - 1 - run] if run else values[-1]
    latest = values[-1]
    share_now = abs(latest) / basis.value
    share_then = abs(start_value) / basis.value
    min_share = spec.number("min_move_share")
    moved_share = abs(share_now - share_then)
    fired = run >= min_run and moved_share >= min_share

    reference, basis_name = _seasonal_basis(series, tail)
    if fired and reference is not None and reference.value is not None:
        # A trend break is only claimed when the reference period agrees:
        # with two years on the spine that reference is the same period a
        # year earlier, so a seasonal build cannot present as a trend.
        step = latest - float(reference.value)
        if (adverse == DIRECTION_UP and step <= 0) or (
                adverse == DIRECTION_DOWN and step >= 0):
            fired = False

    rows = latest_book.select(spec.prefixes("subject"))
    accounts = SUP.accounts_of(rows.rows)
    codes = ", ".join(c for c, _n in accounts)
    reason = ("%s moved %s for %d consecutive periods (%s); its share of %s "
              "went from %s to %s, judged against %s"
              % (codes, adverse, run, ", ".join(labels[-(run + 1):]),
                 basis.label, SUP.pct(share_then), SUP.pct(share_now),
                 basis_name))
    if not fired:
        return [DetectorResult(
            detector_id=spec.id, family="direction", fired=False,
            observed=float(run), observed_unit=F.UNIT_COUNT,
            parameter="min_run", parameter_label="consecutive movements",
            parameter_source=spec.address("min_run"), comparator=">=",
            limit=float(min_run), accounts=accounts, periods=labels,
            atom_ids=rows.atom_ids(), reason=reason)]

    figures, facts = SUP.figures_of([
        ("consecutive_move_count", float(run), F.UNIT_COUNT,
         "consecutive movements in the same direction"),
        ("subject_share", share_now, F.UNIT_PERCENT,
         "%s share of %s now" % (codes, basis.label)),
        ("run_start_subject_share", share_then, F.UNIT_PERCENT,
         "the same share when the run began (%s)" % labels[len(values) - 1 - run]),
    ])
    SUP.assert_units_declared(figures)
    impact = SUP.share_impact(
        "subject_share_of_basis", "%s share of %s" % (codes, basis.label),
        series.currency, abs(start_value), abs(latest), basis.value, basis.name)
    return [DetectorResult(
        detector_id=spec.id, family="direction", fired=True,
        observed=float(run), observed_unit=F.UNIT_COUNT,
        parameter="min_run", parameter_label="consecutive movements",
        parameter_source=spec.address("min_run"), comparator=">=",
        limit=float(min_run), accounts=accounts, periods=labels,
        atom_ids=rows.atom_ids(), figures=figures, facts=facts, impact=impact,
        basis_kind=BASIS_PRIOR,
        basis_description="the account's own readings across %s, referenced to %s"
                          % (", ".join(labels), basis_name),
        basis_value=share_then, basis_unit=F.UNIT_PERCENT,
        reason=reason,
        tokens={"codes": codes, "run": str(run), "basis_label": basis.label,
                "share_now": SUP.pct(share_now), "share_then": SUP.pct(share_then),
                "reference": basis_name, "periods": ", ".join(labels)})]


# ── D-MAGNITUDE ──────────────────────────────────────────────────────────


@register("magnitude")
def magnitude(spec: "DetectorSpec", series: "B.BookSeries",
              profile: Any) -> List["DetectorResult"]:
    """The latest movement measured against the line's OWN dispersion.

    MINIMUM-HISTORY GUARD: a MAD computed from two movements is not a
    measurement of spread, it is the spread of two numbers. The pack
    declares ``min_movements`` and the detector refuses below it.
    """
    measure = str(spec.params.get("measure", "closing"))
    tail, why = _tail(series, spec, measure)
    if why:
        return [na(spec.id, "magnitude", why)]
    labels = _labels(tail)
    min_moves = int(spec.number("min_movements"))
    values = _values(tail)
    movements = [values[i] - values[i - 1] for i in range(1, len(values))]
    if len(movements) < min_moves:
        return [na(spec.id, "magnitude",
                   "a robust dispersion needs %d movements and the spine "
                   "carries %d (%s); a MAD from fewer points is not a "
                   "measurement of spread"
                   % (min_moves, len(movements), ", ".join(labels)),
                   periods=labels)]
    history = movements[:-1]
    latest_move = movements[-1]
    try:
        spread = ST.dispersion(history)
        z = ST.robust_z(latest_move, history, series.currency,
                        name="latest movement")
    except ST.DispersionUndefinedError as exc:
        return [na(spec.id, "magnitude",
                   "%s; the line has no spread to measure this movement "
                   "against" % exc, periods=labels)]

    k = spec.number("min_robust_z")
    latest_book = tail[-1].book
    basis = SUP.basis_of(spec, latest_book)
    if basis is None:
        return [na(spec.id, "magnitude", SUP.basis_missing_reason(spec),
                   periods=labels)]
    rows = latest_book.select(spec.prefixes("subject"))
    accounts = SUP.accounts_of(rows.rows)
    codes = ", ".join(c for c, _n in accounts)
    share_before = abs(values[-2]) / basis.value
    share_now = abs(values[-1]) / basis.value
    fired = z >= k and abs(share_now - share_before) >= spec.number("min_move_share")
    caveats = ()  # type: Tuple[str, ...]
    if spread.method != ST.METHOD_MAD:
        caveats = ("dispersion fell back to the %s because tied movements "
                   "collapsed the MAD, which understates the score"
                   % spread.method,)
    reason = ("the %s movement on %s is %s median absolute deviations from "
              "the median of its previous %d movements (%s)"
              % (labels[-1], codes, SUP.num(z), len(history), spread.method))
    if not fired:
        return [DetectorResult(
            detector_id=spec.id, family="magnitude", fired=False,
            observed=float(z), observed_unit=F.UNIT_SCORE,
            parameter="min_robust_z", parameter_label="robust z against the "
            "line's own dispersion",
            parameter_source=spec.address("min_robust_z"), comparator=">=",
            limit=k, accounts=accounts, periods=labels,
            atom_ids=rows.atom_ids(), reason=reason, caveats=caveats)]

    figures, facts = SUP.figures_of([
        ("movement_robust_z_score", float(z), F.UNIT_SCORE,
         "movement in median absolute deviations from this line's own median"),
        ("subject_share", share_now, F.UNIT_PERCENT,
         "%s share of %s after the movement" % (codes, basis.label)),
        ("prior_subject_share", share_before, F.UNIT_PERCENT,
         "the same share one period earlier"),
        ("dispersion_sample_count", float(len(history)), F.UNIT_COUNT,
         "movements the dispersion was measured over"),
    ])
    SUP.assert_units_declared(figures)
    impact = SUP.share_impact(
        "subject_share_of_basis", "%s share of %s" % (codes, basis.label),
        series.currency, abs(values[-2]), abs(values[-1]), basis.value, basis.name)
    return [DetectorResult(
        detector_id=spec.id, family="magnitude", fired=True,
        observed=float(z), observed_unit=F.UNIT_SCORE,
        parameter="min_robust_z",
        parameter_label="robust z against the line's own dispersion",
        parameter_source=spec.address("min_robust_z"), comparator=">=",
        limit=k, accounts=accounts, periods=labels, atom_ids=rows.atom_ids(),
        figures=figures, facts=facts, impact=impact, basis_kind=BASIS_PRIOR,
        basis_description="the median and %s of this line's own previous %d "
                          "movements (%s)" % (spread.method, len(history),
                                              ", ".join(labels[:-1])),
        basis_value=float(spread.centre), basis_unit=F.UNIT_SCORE,
        reason=reason, caveats=caveats,
        tokens={"codes": codes, "z": SUP.num(z), "method": spread.method,
                "basis_label": basis.label, "share_now": SUP.pct(share_now),
                "share_then": SUP.pct(share_before),
                "sample": str(len(history)), "periods": ", ".join(labels)})]


# ── D-DECOUPLE ───────────────────────────────────────────────────────────


@register("decouple")
def decouple(spec: "DetectorSpec", series: "B.BookSeries",
             profile: Any) -> List["DetectorResult"]:
    """One line rising while its driver stays flat — a cost class growing
    without the revenue that is supposed to explain it, or stock growing
    against unchanged cost of sales."""
    subject_prefixes = spec.prefixes("subject")
    driver_prefixes = spec.prefixes("driver")
    if not subject_prefixes or not driver_prefixes:
        return [na(spec.id, "decouple",
                   "decoupling needs both accounts.subject and accounts.driver")]
    measure = str(spec.params.get("measure", "closing"))
    driver_measure = str(spec.params.get("driver_measure", measure))
    left = series.contiguous_tail(series.readings(subject_prefixes, measure))
    right_all = series.readings(driver_prefixes, driver_measure)
    right_by_id = dict((p.book.period_id, p) for p in right_all)
    paired = [(p, right_by_id.get(p.book.period_id)) for p in left]
    paired = [(a, b) for a, b in paired if b is not None and b.value is not None]
    if len(paired) < 2:
        return [na(spec.id, "decouple",
                   "the two lines share %d contiguous period(s); a divergence "
                   "needs at least 2" % len(paired))]
    labels = tuple(a.book.label for a, _b in paired)
    first_l, first_r = float(paired[0][0].value), float(paired[0][1].value)
    last_l, last_r = float(paired[-1][0].value), float(paired[-1][1].value)
    if first_l == 0 or first_r == 0:
        return [na(spec.id, "decouple",
                   "one of the two lines opens the window at zero, so a growth "
                   "rate against it is undefined rather than infinite",
                   periods=labels)]
    growth_l = (last_l - first_l) / abs(first_l)
    growth_r = (last_r - first_r) / abs(first_r)
    gap = growth_l - growth_r
    flat_band = spec.number("driver_flat_band")
    min_gap = spec.number("min_growth_gap")
    fired = gap >= min_gap and abs(growth_r) <= flat_band

    latest_book = paired[-1][0].book
    rows = latest_book.select(subject_prefixes)
    driver_rows = latest_book.select(driver_prefixes)
    accounts = SUP.accounts_of(rows.rows, limit=3) + SUP.accounts_of(driver_rows.rows, limit=1)
    codes = ", ".join(c for c, _n in accounts)
    subject_codes = ", ".join(c for c, _n in SUP.accounts_of(rows.rows, limit=3))
    driver_codes = ", ".join(c for c, _n in SUP.accounts_of(driver_rows.rows, limit=1))
    reason = ("%s grew %s across %s while its driver %s moved %s, inside the "
              "flat band of %s" % (subject_codes, SUP.pct(growth_l),
                                   ", ".join(labels), driver_codes,
                                   SUP.pct(growth_r), SUP.pct(flat_band)))
    if not fired:
        return [DetectorResult(
            detector_id=spec.id, family="decouple", fired=False,
            observed=float(gap), observed_unit=F.UNIT_PERCENT,
            parameter="min_growth_gap",
            parameter_label="growth gap against the driver",
            parameter_source=spec.address("min_growth_gap"), comparator=">=",
            limit=min_gap, accounts=accounts, periods=labels,
            atom_ids=rows.atom_ids() + driver_rows.atom_ids(), reason=reason)]

    figures, facts = SUP.figures_of([
        ("subject_growth_pct", growth_l, F.UNIT_PERCENT,
         "%s growth across the window" % subject_codes),
        ("driver_growth_pct", growth_r, F.UNIT_PERCENT,
         "%s growth across the same window" % driver_codes),
        ("growth_gap_pct", gap, F.UNIT_PERCENT, "the gap between them"),
    ])
    SUP.assert_units_declared(figures)
    impact = F.ratio_impact(
        metric="subject_per_driver_ratio",
        metric_label="%s per unit of %s" % (subject_codes, driver_codes),
        numerator=SUP.money_q(first_l, series.currency, "subject_window_open"),
        denominator=SUP.money_q(first_r, series.currency, "driver_window_open"),
        adjusted_numerator=SUP.money_q(last_l, series.currency, "subject_window_close"),
        adjusted_denominator=SUP.money_q(last_r, series.currency, "driver_window_close"),
        unit=F.UNIT_RATIO)
    return [DetectorResult(
        detector_id=spec.id, family="decouple", fired=True,
        observed=float(gap), observed_unit=F.UNIT_PERCENT,
        parameter="min_growth_gap",
        parameter_label="growth gap against the driver",
        parameter_source=spec.address("min_growth_gap"), comparator=">=",
        limit=min_gap, accounts=accounts, periods=labels,
        atom_ids=rows.atom_ids() + driver_rows.atom_ids(),
        figures=figures, facts=facts, impact=impact, basis_kind=BASIS_SELF,
        basis_description="%s over the same window, which is the driver this "
                          "rule holds %s against" % (driver_codes, subject_codes),
        basis_value=float(growth_r), basis_unit=F.UNIT_PERCENT,
        reason=reason,
        tokens={"codes": subject_codes, "driver_codes": driver_codes,
                "subject_growth": SUP.pct(growth_l),
                "driver_growth": SUP.pct(growth_r), "gap": SUP.pct(gap),
                "periods": ", ".join(labels)})]


# ── D-VELOCITY ───────────────────────────────────────────────────────────


def _cycle_days(stock: float, flow: float, currency: str, window_days: float
                ) -> Optional[float]:
    """stock / flow x the flow's OWN window in days, taken through the
    ratio law: both operands are money in the same currency, so the
    quotient is dimensionless before it is scaled into days."""
    try:
        return _ratio_units.ratio(
            SUP.money_q(abs(stock) * window_days, currency, "stock_days"),
            SUP.money_q(abs(flow), currency, "flow"))
    except _ratio_units.UndefinedRatioError:
        return None


@register("velocity")
def velocity(spec: "DetectorSpec", series: "B.BookSeries",
             profile: Any) -> List["DetectorResult"]:
    """A working-capital cycle (DSO / DPO / DIO) breaking from its own
    median, and — where the book carries per-counterparty analytics under
    the stock account — the counterparty whose rhythm moved the most."""
    stock_prefixes = spec.prefixes("stock")
    flow_prefixes = spec.prefixes("flow")
    if not stock_prefixes or not flow_prefixes:
        return [na(spec.id, "velocity",
                   "a cycle needs both accounts.stock and accounts.flow")]
    stock_points = series.readings(stock_prefixes, "closing")
    flow_points = series.readings(flow_prefixes, str(spec.params.get("flow_measure", "movement")))
    flow_by_id = dict((p.book.period_id, p) for p in flow_points)
    cycle = []  # type: List[Tuple[B.PeriodBook, float]]
    missing_window = []  # type: List[str]
    for point in stock_points:
        other = flow_by_id.get(point.book.period_id)
        if point.value is None or other is None or other.value is None:
            cycle = []
            continue
        window = point.book.days_covered
        if window is None or window <= 0:
            # The flow covers the period, and the cycle is that flow
            # scaled by the period's OWN window. Assuming a year for a
            # monthly movement column overstates every cycle twelvefold,
            # so the detector refuses instead of assuming.
            missing_window.append(point.book.label)
            cycle = []
            continue
        days = _cycle_days(point.value, other.value, series.currency, float(window))
        if days is None:
            cycle = []
            continue
        cycle.append((point.book, days))
    if missing_window and not cycle:
        return [na(spec.id, "velocity",
                   "no period states how many days its movement covers (%s), "
                   "so a cycle in days cannot be computed without assuming a "
                   "window" % ", ".join(missing_window[:4]))]
    min_points = int(spec.number("min_periods_for_median"))
    if len(cycle) < min_points:
        return [na(spec.id, "velocity",
                   "the cycle resolves in %d contiguous period(s) and its own "
                   "median needs %d" % (len(cycle), min_points))]
    labels = tuple(b.label for b, _d in cycle)
    history = [d for _b, d in cycle[:-1]]
    latest_days = cycle[-1][1]
    med = ST.median(history)
    break_days = latest_days - med
    limit = spec.number("min_days_break")
    fired = abs(break_days) >= limit

    latest_book = cycle[-1][0]
    rows = latest_book.select(stock_prefixes)
    accounts = SUP.accounts_of(rows.rows, limit=3)
    codes = ", ".join(c for c, _n in accounts)
    leaves = rows.leaves()
    counterparty_note = ""
    if len(leaves) > 1:
        ranked = sorted(leaves, key=lambda r: (-abs(r.closing_signed() or 0.0), r.code))
        top = ranked[0]
        counterparty_note = ("; the largest of the %d analytic accounts under "
                             "%s is %s" % (len(leaves), ", ".join(rows.prefixes),
                                           top.code))
    reason = ("the %s cycle on %s stands at %s days against a median of %s days "
              "over %s%s" % (spec.scope, codes, SUP.num(latest_days, 0),
                             SUP.num(med, 0), ", ".join(labels[:-1]),
                             counterparty_note))
    if not fired:
        return [DetectorResult(
            detector_id=spec.id, family="velocity", fired=False,
            observed=float(abs(break_days)), observed_unit=F.UNIT_DAYS,
            parameter="min_days_break", parameter_label="days away from the "
            "cycle's own median",
            parameter_source=spec.address("min_days_break"), comparator=">=",
            limit=limit, accounts=accounts, periods=labels,
            atom_ids=rows.atom_ids(), reason=reason)]

    figures, facts = SUP.figures_of([
        ("cycle_days", latest_days, F.UNIT_DAYS,
         "%s cycle in the latest period" % spec.scope),
        ("cycle_median_days", med, F.UNIT_DAYS,
         "median of the same cycle over %s" % ", ".join(labels[:-1])),
        ("cycle_break_days", abs(break_days), F.UNIT_DAYS,
         "distance from that median"),
    ])
    SUP.assert_units_declared(figures)
    # The consequence is stated in DAYS against the company's own median,
    # not as a quotient of two money figures dressed up as days: both
    # operands here are already days, and `headroom_impact` keeps them in
    # that unit through `_ratio_units`.
    impact = F.headroom_impact(
        metric="cycle_days", metric_label="%s cycle" % spec.scope,
        observed=_ratio_units.days(latest_days, "cycle_days"),
        limit=_ratio_units.days(med, "cycle_median_days"))
    return [DetectorResult(
        detector_id=spec.id, family="velocity", fired=True,
        observed=float(abs(break_days)), observed_unit=F.UNIT_DAYS,
        parameter="min_days_break",
        parameter_label="days away from the cycle's own median",
        parameter_source=spec.address("min_days_break"), comparator=">=",
        limit=limit, accounts=accounts, periods=labels,
        atom_ids=rows.atom_ids(), figures=figures, facts=facts, impact=impact,
        basis_kind=BASIS_PRIOR,
        basis_description="the median of this company's own %s cycle across %s"
                          % (spec.scope, ", ".join(labels[:-1])),
        basis_value=float(med), basis_unit=F.UNIT_DAYS, reason=reason,
        tokens={"codes": codes, "days": SUP.num(latest_days, 0),
                "median_days": SUP.num(med, 0),
                "break_days": SUP.num(abs(break_days), 0),
                "periods": ", ".join(labels)})]


# ── D-REVERSAL ───────────────────────────────────────────────────────────


@register("reversal")
def reversal(spec: "DetectorSpec", series: "B.BookSeries",
             profile: Any) -> List["DetectorResult"]:
    """A period-end movement handed back at the start of the next period.

    Read from MOVEMENT PAIRS, not from balances: the closing balance of a
    dressed period and of a clean one look alike, which is the point of
    dressing it. The signature is a movement into the account at period
    end and a movement of the opposite sign, of comparable size, in the
    period that follows, leaving the balance where it started.
    """
    prefixes = spec.prefixes("subject")
    if not prefixes:
        return [na(spec.id, "reversal", "detector declares no accounts.subject")]
    moves = series.readings(prefixes, "movement")
    closes = series.readings(prefixes, "closing")
    pairs = []  # type: List[Tuple[int, float, float]]
    for i in range(1, len(moves)):
        a, b = moves[i - 1], moves[i]
        if a.value is None or b.value is None:
            continue
        pairs.append((i, float(a.value), float(b.value)))
    if not pairs:
        return [na(spec.id, "reversal",
                   "no two adjacent periods both carry a movement on %s, so "
                   "there is no movement pair to read" % ", ".join(prefixes))]
    labels = _labels(moves)
    latest_book = moves[-1].book
    basis = SUP.basis_of(spec, latest_book)
    if basis is None:
        return [na(spec.id, "reversal", SUP.basis_missing_reason(spec),
                   periods=labels)]
    min_share = spec.number("min_movement_share")
    min_reversed = spec.number("min_reversed_share")

    best = None  # type: Optional[Tuple[int, float, float, float]]
    for index, first, second in pairs:
        if first == 0.0:
            continue
        booked_share = abs(first) / basis.value
        if booked_share < min_share:
            continue
        if (first > 0) == (second > 0):
            continue
        reversed_share = min(abs(second) / abs(first), 1.0)
        if reversed_share < min_reversed:
            continue
        if best is None or reversed_share > best[3]:
            best = (index, first, second, reversed_share)

    rows = latest_book.select(prefixes)
    accounts = SUP.accounts_of(rows.rows, limit=3)
    codes = ", ".join(c for c, _n in accounts)
    if best is None:
        return [DetectorResult(
            detector_id=spec.id, family="reversal", fired=False,
            observed=0.0, observed_unit=F.UNIT_PERCENT,
            parameter="min_reversed_share",
            parameter_label="share of the period-end movement given back",
            parameter_source=spec.address("min_reversed_share"), comparator=">=",
            limit=min_reversed, accounts=accounts, periods=labels,
            atom_ids=rows.atom_ids(),
            reason=("no movement on %s at or above %s of %s is reversed in the "
                    "following period" % (codes, SUP.pct(min_share), basis.label)))]

    index, first, second, reversed_share = best
    booked_share = abs(first) / basis.value
    before = closes[index - 1].value
    after = closes[index].value
    period_in = moves[index - 1].book.label
    period_out = moves[index].book.label
    reason = ("%s of %s was booked to %s in %s and %s of it was reversed in %s"
              % (SUP.pct(booked_share), basis.label, codes, period_in,
                 SUP.pct(reversed_share), period_out))

    figures, facts = SUP.figures_of([
        ("reversed_share", reversed_share, F.UNIT_PERCENT,
         "share of the %s movement given back in %s" % (period_in, period_out)),
        ("period_end_movement_share", booked_share, F.UNIT_PERCENT,
         "the %s movement as a share of %s" % (period_in, basis.label)),
    ])
    SUP.assert_units_declared(figures)
    impact = SUP.share_impact(
        "subject_share_of_basis", "%s share of %s" % (codes, basis.label),
        series.currency,
        abs(float(before)) if before is not None else 0.0,
        abs(float(after)) if after is not None else 0.0,
        basis.value, basis.name)
    return [DetectorResult(
        detector_id=spec.id, family="reversal", fired=True,
        observed=float(reversed_share), observed_unit=F.UNIT_PERCENT,
        parameter="min_reversed_share",
        parameter_label="share of the period-end movement given back",
        parameter_source=spec.address("min_reversed_share"), comparator=">=",
        limit=min_reversed, accounts=accounts, periods=(period_in, period_out),
        atom_ids=rows.atom_ids(), figures=figures, facts=facts, impact=impact,
        basis_kind=BASIS_PRIOR,
        basis_description="the movement pair %s -> %s on the same accounts"
                          % (period_in, period_out),
        basis_value=float(booked_share), basis_unit=F.UNIT_PERCENT,
        reason=reason,
        tokens={"codes": codes, "period_in": period_in, "period_out": period_out,
                "reversed_share": SUP.pct(reversed_share),
                "booked_share": SUP.pct(booked_share),
                "basis_label": basis.label})]


# ── D-DORMANT ────────────────────────────────────────────────────────────


@register("dormant")
def dormant(spec: "DetectorSpec", series: "B.BookSeries",
            profile: Any) -> List["DetectorResult"]:
    """An account that stopped moving and then moved materially again —
    or one that did not exist in the earlier periods and now carries a
    material balance."""
    prefixes = spec.prefixes("subject")
    if not prefixes:
        return [na(spec.id, "dormant", "detector declares no accounts.subject")]
    points = series.readings(prefixes, "closing")
    present = [p for p in points if p.value is not None]
    if len(present) < 3:
        return [na(spec.id, "dormant",
                   "dormancy needs a quiet run and a break in it; %d period(s) "
                   "carry this account" % len(present))]
    labels = tuple(p.book.label for p in present)
    values = [float(p.value) for p in present]
    tolerance = spec.number("quiet_tolerance_share")
    min_quiet = int(spec.number("min_quiet_periods"))
    quiet_run = ST.unchanged_run(values[:-1], tolerance)
    latest_book = present[-1].book
    basis = SUP.basis_of(spec, latest_book)
    if basis is None:
        return [na(spec.id, "dormant", SUP.basis_missing_reason(spec),
                   periods=labels)]
    step = abs(values[-1] - values[-2])
    step_share = step / basis.value
    min_step = spec.number("min_reactivation_share")
    fired = quiet_run >= min_quiet and step_share >= min_step

    rows = latest_book.select(prefixes)
    accounts = SUP.accounts_of(rows.rows, limit=3)
    codes = ", ".join(c for c, _n in accounts)
    reason = ("%s sat inside %s of its own balance for %d period(s) and then "
              "moved %s of %s in %s"
              % (codes, SUP.pct(tolerance), quiet_run, SUP.pct(step_share),
                 basis.label, labels[-1]))
    if not fired:
        return [DetectorResult(
            detector_id=spec.id, family="dormant", fired=False,
            observed=float(step_share), observed_unit=F.UNIT_PERCENT,
            parameter="min_reactivation_share",
            parameter_label="reactivating movement as a share of %s" % basis.label,
            parameter_source=spec.address("min_reactivation_share"),
            comparator=">=", limit=min_step, accounts=accounts, periods=labels,
            atom_ids=rows.atom_ids(), reason=reason)]

    figures, facts = SUP.figures_of([
        ("reactivation_share", step_share, F.UNIT_PERCENT,
         "the reactivating movement as a share of %s" % basis.label),
        ("quiet_period_count", float(quiet_run), F.UNIT_COUNT,
         "periods the account did not move"),
        ("subject_share", abs(values[-1]) / basis.value, F.UNIT_PERCENT,
         "%s share of %s after the movement" % (codes, basis.label)),
    ])
    SUP.assert_units_declared(figures)
    impact = SUP.share_impact(
        "subject_share_of_basis", "%s share of %s" % (codes, basis.label),
        series.currency, abs(values[-2]), abs(values[-1]), basis.value, basis.name)
    return [DetectorResult(
        detector_id=spec.id, family="dormant", fired=True,
        observed=float(step_share), observed_unit=F.UNIT_PERCENT,
        parameter="min_reactivation_share",
        parameter_label="reactivating movement as a share of %s" % basis.label,
        parameter_source=spec.address("min_reactivation_share"), comparator=">=",
        limit=min_step, accounts=accounts, periods=labels,
        atom_ids=rows.atom_ids(), figures=figures, facts=facts, impact=impact,
        basis_kind=BASIS_PRIOR,
        basis_description="the account's own quiet run across %s"
                          % ", ".join(labels[:-1]),
        basis_value=float(quiet_run), basis_unit=F.UNIT_COUNT, reason=reason,
        tokens={"codes": codes, "quiet_run": str(quiet_run),
                "step_share": SUP.pct(step_share), "basis_label": basis.label,
                "period": labels[-1]})]


# ── D-CUTOFF ─────────────────────────────────────────────────────────────


@register("cutoff")
def cutoff(spec: "DetectorSpec", series: "B.BookSeries",
           profile: Any) -> List["DetectorResult"]:
    """How much of a year's activity lands in that year's FINAL period,
    against the account's own history of that share. Recognition pushed
    across a boundary shows up here and nowhere else — the annual total is
    unchanged, so only the shape gives it away."""
    prefixes = spec.prefixes("subject")
    if not prefixes:
        return [na(spec.id, "cutoff", "detector declares no accounts.subject")]
    points = series.readings(prefixes, str(spec.params.get("measure", "movement_gross")))
    by_year = {}  # type: Dict[int, List[B.SeriesPoint]]
    for point in points:
        year = point.book.year
        if year is None or point.value is None:
            continue
        by_year.setdefault(int(year), []).append(point)
    complete = {}  # type: Dict[int, float]
    min_periods_per_year = int(spec.number("min_periods_per_year"))
    for year, rows in by_year.items():
        if len(rows) < min_periods_per_year:
            continue
        ordered = sorted(rows, key=lambda p: p.book.ordinal)
        total = sum(abs(float(p.value)) for p in ordered)
        if total <= 0:
            continue
        complete[year] = abs(float(ordered[-1].value)) / total
    if len(complete) < 2:
        return [na(spec.id, "cutoff",
                   "a final-period share needs at least two years each "
                   "carrying %d periods; the spine carries %d such year(s)"
                   % (min_periods_per_year, len(complete)))]
    years = sorted(complete)
    latest_year = years[-1]
    history = [complete[y] for y in years[:-1]]
    med = ST.median(history)
    observed = complete[latest_year]
    lift = observed - med
    limit = spec.number("min_share_lift")
    fired = lift >= limit

    latest_book = series.books[-1]
    rows = latest_book.select(prefixes)
    accounts = SUP.accounts_of(rows.rows, limit=3)
    codes = ", ".join(c for c, _n in accounts)
    labels = tuple(str(y) for y in years)
    reason = ("%s of %s activity on %s landed in the final period of %d, "
              "against a median of %s across %s"
              % (SUP.pct(observed), str(latest_year), codes, latest_year,
                 SUP.pct(med), ", ".join(str(y) for y in years[:-1])))
    if not fired:
        return [DetectorResult(
            detector_id=spec.id, family="cutoff", fired=False,
            observed=float(lift), observed_unit=F.UNIT_PERCENT,
            parameter="min_share_lift",
            parameter_label="lift in the final-period share of the year",
            parameter_source=spec.address("min_share_lift"), comparator=">=",
            limit=limit, accounts=accounts, periods=labels,
            atom_ids=rows.atom_ids(), reason=reason)]

    figures, facts = SUP.figures_of([
        ("final_period_share", observed, F.UNIT_PERCENT,
         "share of %d activity booked in its final period" % latest_year),
        ("median_final_period_share", med, F.UNIT_PERCENT,
         "the same share, median of %s" % ", ".join(str(y) for y in years[:-1])),
        ("final_period_share_lift_pct", lift, F.UNIT_PERCENT,
         "the lift against that history"),
    ])
    SUP.assert_units_declared(figures)
    impact = F.headroom_impact(
        metric="final_period_share",
        metric_label="share of the year's %s activity booked in its final period" % codes,
        observed=_ratio_units.percent_q(observed, "final_period_share"),
        limit=_ratio_units.percent_q(med, "median_final_period_share"))
    return [DetectorResult(
        detector_id=spec.id, family="cutoff", fired=True,
        observed=float(lift), observed_unit=F.UNIT_PERCENT,
        parameter="min_share_lift",
        parameter_label="lift in the final-period share of the year",
        parameter_source=spec.address("min_share_lift"), comparator=">=",
        limit=limit, accounts=accounts, periods=labels,
        atom_ids=rows.atom_ids(), figures=figures, facts=facts, impact=impact,
        basis_kind=BASIS_PRIOR,
        basis_description="this account's own final-period share in %s"
                          % ", ".join(str(y) for y in years[:-1]),
        basis_value=float(med), basis_unit=F.UNIT_PERCENT, reason=reason,
        tokens={"codes": codes, "year": str(latest_year),
                "observed": SUP.pct(observed), "median": SUP.pct(med),
                "lift": SUP.pct(lift)})]


__all__ = ["BASIS_PRIOR", "BASIS_SELF", "BASIS_THRESHOLD",
           "SEASONAL_MIN_YEARS", "cutoff", "decouple", "direction", "dormant",
           "magnitude", "reversal", "velocity"]
