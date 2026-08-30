"""THE MULTI-PERIOD LANE, UNDER TEST.

The baseline this lane extends (`design_review/findings/BASELINE.md`) had
no history at all: every one of the 59 live findings was computed from a
single period, so "receivables are 19.6% of assets" could not say whether
that was a new development or the way the company has always run. These
tests fix the two things that fact makes possible and the one thing it
makes dangerous:

  * WITH history — direction, magnitude, decoupling, velocity, reversal,
    dormancy, trend and seasonality, each producing a finding that passes
    the full seven-element contract rather than a sentence with a number
    in it;
  * WITHOUT history — a typed refusal naming every waiting analysis, and
    NOTHING computed. F6 is enforced by shape here, not by care: the
    windows refuse to be built short, so the tests prove the refusal
    rather than the absence of a call;
  * ABSENT != ZERO — a gap in the spine truncates a run, never bridges
    it, and never reads as a zero balance.

The spines are built from the REAL Agras FY2025 canonical envelope with
individual lines moved period to period, so every denominator (total
assets, revenue, equity) is a real number from a real book.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import ast
import copy
import json
from pathlib import Path

import pytest
import yaml

from engine.api import _company_profile as CP
from engine.api import _finding as F
from engine.api import _finding_rank as R
from engine.api import _ratio_units
from engine.api.findings import m_detect as D
from engine.api.findings import m_engine as E
from engine.api.findings import m_policy as P
from engine.api.findings import m_series as S
from engine.api.findings import m_stats as ST

REPO = Path(__file__).resolve().parents[2]
FIXTURES = (REPO / "src" / "engine" / "country_packs" / "ro_romania"
            / "fixtures" / "regression_baselines")


def _base_statements():
    with open(str(FIXTURES / "agras_fy2025.json"), encoding="utf-8") as fh:
        return json.load(fh)["assembled"]["statements"]


BASE = _base_statements()


def _view_of(key):
    """Which canonical sub-view carries this line in the real fixture."""
    for view in S.VIEW_ORDER:
        block = BASE.get(view) or {}
        for name in S.LINES_BY_KEY[key].names:
            if name in block:
                return view, name
    raise AssertionError("fixture does not carry %r" % key)


def spine(lines, labels=None, days_covered=365, months=None):
    """Build a SeriesSet from the real envelope with named lines moved.

    `lines` maps a canonical key to a per-period list; `None` in a list is
    a GAP — the key is removed from that period's views entirely, which is
    what an absent line actually looks like coming out of the assembler.
    """
    length = max(len(v) for v in lines.values())
    labels = labels or ["P%d" % i for i in range(length)]
    periods, by_id = [], {}
    year, previous_month = 2021, None
    for i in range(length):
        month = (months[i] if months else 12)
        if months is None:
            year = 2021 + i
        elif previous_month is not None and month <= previous_month:
            year += 1
        previous_month = month
        period = S.PeriodRef(period_id="p%d" % i, label=labels[i], ordinal=i,
                             year=year, month=month, snapshot_id="snap-agras",
                             days_covered=days_covered)
        periods.append(period)
        stmts = copy.deepcopy(BASE)
        for key, values in lines.items():
            view, name = _view_of(key)
            value = values[i] if i < len(values) else values[-1]
            if value is None:
                for v in S.VIEW_ORDER:
                    block = stmts.get(v) or {}
                    for candidate in S.LINES_BY_KEY[key].names:
                        block.pop(candidate, None)
            else:
                stmts[view][name] = float(value)
        by_id[period.period_id] = stmts
    return S.build_series_set(periods, by_id)


def profile_of(period_id="p0"):
    return CP.build_company_profile(BASE, period_id=period_id,
                                    snapshot_id="snap-agras")


def run(series_set, **kwargs):
    return E.analyse_multi_period(series_set, profile_of(), **kwargs)


def surfaced_rules(result):
    return [r.finding.rule_id for r in result.report.surfaced]


def find(result, rule_id):
    for r in result.report.surfaced:
        if r.finding.rule_id == rule_id:
            return r
    return None


# ═════════════════════════════════════════════════════════════════════════
# 1. COLD START (F6) — nothing runs, and the refusal is typed
# ═════════════════════════════════════════════════════════════════════════


def test_one_period_returns_needs_history_and_no_report():
    result = run(spine({"ar_net": [8_000_000]}))
    assert result.cold_start() is True
    assert result.report is None
    assert result.needs_history is not None
    assert result.needs_history.period_count == 1


def test_cold_start_names_every_waiting_analysis_with_its_bill():
    result = run(spine({"ar_net": [8_000_000]}))
    blocked = result.needs_history.blocked()
    assert len(blocked) == len(P.ANALYSIS_IDS)
    statement = result.needs_history.statement()
    for spec_id in P.ANALYSIS_IDS:
        assert P.ANALYSES[spec_id].label in statement
    assert "No trend, no median and no year-over-year figure was computed" \
        in statement


def test_cold_start_reports_the_year_bill_for_the_seasonal_analysis():
    result = run(spine({"ar_net": [8_000_000]}))
    seasonal = [r for r in result.needs_history.requirements
                if r.analysis_id == P.M_SEASONAL.id][0]
    assert seasonal.needs_years == 2
    assert "2 calendar years" in result.needs_history.statement()


def test_cold_start_still_records_what_was_checked():
    """Silence is a claim. A single-period upload gets the list of
    analyses that did not run, not an empty page."""
    result = run(spine({"ar_net": [8_000_000]}))
    checks = result.finding_set.all_checks()
    assert len(checks) == len(P.ANALYSIS_IDS)
    assert all(c["note"].startswith("not run:") for c in checks)
    assert result.silence() is not None


def test_a_window_cannot_be_built_from_one_period_at_all():
    """The structural half of F6: even reaching past the entry point, the
    arithmetic has no object to run on."""
    series = spine({"ar_net": [8_000_000]}).require("ar_net")
    with pytest.raises(S.NeedsHistoryError) as exc:
        S.History.of(series, "m_direction", 4)
    assert exc.value.needed == 4 and exc.value.have == 1


def test_a_window_of_one_point_is_rejected_by_signature():
    series = spine({"ar_net": [1.0, 2.0]}).require("ar_net")
    with pytest.raises(ValueError):
        S.History.of(series, "m_direction", 1)


def test_two_periods_leaves_cold_start_but_still_blocks_the_long_analyses():
    result = run(spine({"ar_net": [8_000_000, 9_000_000]}))
    assert result.cold_start() is False
    blocked = [r.analysis_id for r in result.requirements if not r.satisfied]
    assert P.M_MAGNITUDE.id in blocked      # needs 5
    assert P.M_TREND.id in blocked          # needs 4


# ═════════════════════════════════════════════════════════════════════════
# 2. ABSENT != ZERO — gaps break runs, they do not bridge them
# ═════════════════════════════════════════════════════════════════════════


def test_a_gap_is_none_and_never_becomes_zero():
    series = spine({"ar_net": [1.0, None, 3.0]}).require("ar_net")
    values = [o.value for o in series.observations]
    assert values == [1.0, None, 3.0]
    assert series.n_present() == 2
    assert [p.label for p in series.gaps()] == ["P1"]


def test_the_contiguous_tail_stops_at_a_gap():
    series = spine({"ar_net": [1.0, 2.0, None, 4.0, 5.0]}).require("ar_net")
    assert [o.value for o in series.contiguous_tail()] == [4.0, 5.0]


def test_a_run_is_not_measured_across_a_gap():
    """Four rising periods with a hole in the middle is not a four-period
    run — the analysis refuses for want of contiguous history."""
    rising = [1.0, 2.0, None, 4.0, 5.0]
    series_set = spine({"ar_net": [v and v * 1_000_000 for v in rising]})
    with pytest.raises(S.NeedsHistoryError):
        D.direction(series_set, "ar_net", {})


def test_a_paired_window_refuses_when_one_side_has_a_gap():
    series_set = spine({"cogs": [1.0, 2.0, 3.0], "revenue": [1.0, None, 3.0]})
    with pytest.raises(S.NeedsHistoryError):
        S.PairedHistory.of(series_set.require("cogs"),
                           series_set.require("revenue"), "m_decouple", 2)


def test_movements_never_span_a_hole():
    series = spine({"ar_net": [10.0, 20.0, 30.0, 40.0]}).require("ar_net")
    history = S.History.of(series, "probe", 2)
    assert history.movements() == (10.0, 10.0, 10.0)


# ═════════════════════════════════════════════════════════════════════════
# 3. ENTITY MATCHING AND UNITS
# ═════════════════════════════════════════════════════════════════════════


def test_a_mixed_currency_spine_is_refused():
    series_set = spine({"ar_net": [1.0, 2.0]})
    periods = list(series_set.periods)
    stmts_a = copy.deepcopy(BASE)
    stmts_b = copy.deepcopy(BASE)
    stmts_b["currency"] = "EUR"
    with pytest.raises(S.SeriesCurrencyError):
        S.build_series_set(periods, {periods[0].period_id: stmts_a,
                                     periods[1].period_id: stmts_b})


def test_a_paired_window_refuses_two_currencies():
    left = spine({"ar_net": [1.0, 2.0]}).require("ar_net")
    right = spine({"revenue": [1.0, 2.0]}).require("revenue")
    other = S.AccountTimeSeries(spec=right.spec, currency="EUR",
                               observations=right.observations)
    with pytest.raises(S.SeriesCurrencyError):
        S.PairedHistory.of(left, other, "m_decouple", 2)


def test_year_over_year_refuses_a_spine_with_no_calendar():
    periods = [S.PeriodRef(period_id="a", label="A", ordinal=0),
               S.PeriodRef(period_id="b", label="B", ordinal=1)]
    series_set = S.build_series_set(
        periods, {"a": copy.deepcopy(BASE), "b": copy.deepcopy(BASE)})
    with pytest.raises(S.NeedsHistoryError) as exc:
        S.YearOverYear.of(series_set.require("ar_net"), "m_seasonal")
    assert "calendar year and month" in str(exc.value)


def test_year_over_year_matches_the_month_not_the_row_offset():
    months = [1, 4, 7, 10, 1, 4, 7, 10]
    series_set = spine({"ar_net": [8e6, 9e6, 9e6, 9e6, 12e6, 9e6, 9e6, 9e6]},
                       months=months)
    yoy = S.YearOverYear.of(series_set.require("ar_net"), "m_seasonal")
    assert yoy.current.period.month == yoy.prior_year.period.month
    assert yoy.current.period.year == yoy.prior_year.period.year + 1


# ═════════════════════════════════════════════════════════════════════════
# 4. ROBUST STATISTICS — refusals, not degradations
# ═════════════════════════════════════════════════════════════════════════


def test_median_and_scaled_mad():
    assert ST.median([3.0, 1.0, 2.0]) == 2.0
    assert ST.median([4.0, 1.0, 2.0, 3.0]) == 2.5
    assert ST.mad([1.0, 1.0, 1.0]) == 0.0
    assert ST.mad([1.0, 2.0, 3.0]) == pytest.approx(ST.MAD_TO_SIGMA * 1.0)


def test_median_of_nothing_refuses():
    with pytest.raises(ValueError):
        ST.median([])


def test_zero_dispersion_refuses_rather_than_returning_an_enormous_z():
    with pytest.raises(ST.DispersionUndefinedError):
        ST.robust_z(500.0, [100.0, 100.0, 100.0, 100.0], "RON")


def test_a_robust_z_is_immune_to_the_outlier_it_is_measuring():
    """The point of MAD over standard deviation: one huge movement must
    not widen the band that is supposed to catch it."""
    moves = [10.0, 11.0, 9.0, 10.0, 400.0]
    assert ST.robust_z(400.0, moves, "RON") > 100.0


def test_per_period_refuses_a_zero_span():
    with pytest.raises(_ratio_units.UndefinedRatioError):
        ST.per_period(1.0, 0)


def test_theil_sen_slope_and_agreement():
    points = [(0.0, 0.10), (1.0, 0.12), (2.0, 0.14), (3.0, 0.16)]
    slope, agreement = ST.theil_sen(points)
    assert slope == pytest.approx(0.02)
    assert agreement == 1.0


def test_theil_sen_agreement_falls_when_the_points_disagree():
    noisy = [(0.0, 0.10), (1.0, 0.30), (2.0, 0.08), (3.0, 0.31)]
    _slope, agreement = ST.theil_sen(noisy)
    assert agreement < 1.0


def test_theil_sen_refuses_a_single_point():
    with pytest.raises(ValueError):
        ST.theil_sen([(0.0, 0.1)])


def test_a_flat_step_ends_a_run():
    assert ST.trailing_run([1.0, 2.0, 3.0, 3.0], "up") == 0
    assert ST.trailing_run([1.0, 2.0, 3.0, 4.0], "up") == 3


def test_unchanged_run_uses_a_relative_tolerance():
    assert ST.unchanged_run([100.0, 100.2, 100.1, 100.3], 0.005) == 3
    assert ST.unchanged_run([100.0, 100.0, 100.0, 140.0], 0.005) == 0


def test_projection_is_floored_where_asked():
    assert ST.project(0.1, -0.2, 3, floor=0.0) == 0.0
    assert ST.project(0.1, 0.02, 3) == pytest.approx(0.16)


# ═════════════════════════════════════════════════════════════════════════
# 5. EACH ANALYSIS FIRES, AND WHAT IT PRODUCES PASSES THE CONTRACT
# ═════════════════════════════════════════════════════════════════════════


RISING_AR = [8e6, 10e6, 12e6, 14e6, 16e6]


def _assert_contract_complete(finding):
    verdict = finding.verdict()
    assert verdict.surfaced, verdict.reasons()
    rendered = finding.render()
    text = (rendered.title + " " + rendered.body).lower()
    for phrase in F.BANNED_PHRASES:
        assert phrase not in text, phrase
    assert len([n for n in F._NUMBER_RX.findall(rendered.body)]) >= 2
    verbs = [s.lead_verb() for s in finding.action.steps]
    assert any(v in text for v in verbs)
    assert any(a.code in rendered.body for a in finding.subject.accounts)


def test_direction_fires_on_a_sustained_rise_and_passes_the_contract():
    result = run(spine({"ar_net": RISING_AR}))
    ranked = find(result, "m_direction.ar_net") or find(result, "m_trend.ar_net")
    assert ranked is not None
    _assert_contract_complete(ranked.finding)


def test_direction_states_the_run_and_the_cumulative_move():
    outcome = D.direction(spine({"ar_net": RISING_AR}), "ar_net", {})
    m = outcome.measurement
    assert m.observed["min_consecutive_periods"] == 4.0
    assert m.observed["min_cumulative_change"] == pytest.approx(1.0)
    assert m.impact.kind == "recomputed_ratio"
    assert m.impact.baseline == pytest.approx(1.0)
    assert m.impact.adjusted == pytest.approx(2.0)


def test_magnitude_fires_on_an_outlier_movement():
    values = [8e6, 8.4e6, 8.8e6, 9.2e6, 20e6]
    outcome = D.magnitude(spine({"ar_net": values}), "ar_net", {})
    assert outcome.measured()
    assert outcome.measurement.observed["k_mad"] > 3.0


def test_magnitude_refuses_a_line_whose_movements_are_constant():
    flat = [8e6, 9e6, 10e6, 11e6, 12e6]      # identical movements
    outcome = D.magnitude(spine({"ar_net": flat}), "ar_net", {})
    assert not outcome.measured()
    assert "the series is constant" in outcome.reason


def test_a_tied_sample_falls_back_to_a_named_weaker_estimator():
    """MAD collapses to zero when at least half the movements are
    identical. Refusing there would throw away the clearest outlier in
    the series, so the fallback is used AND disclosed."""
    tied = [8e6, 8.4e6, 8.8e6, 9.2e6, 20e6]   # three identical steps, one jump
    outcome = D.magnitude(spine({"ar_net": tied}), "ar_net", {})
    assert outcome.measured()
    caveats = outcome.measurement.caveats
    assert any("mean absolute deviation" in c for c in caveats)
    assert ST.dispersion(
        S.History.of(spine({"ar_net": tied}).require("ar_net"), "probe", 5)
        .movements()).method == ST.METHOD_MEAN_AD


def test_decouple_fires_when_cost_outgrows_revenue():
    series_set = spine({"cogs": [70e6, 95e6], "revenue": [118e6, 120e6]})
    outcome = D.decouple(series_set, ("cogs", "revenue"), {})
    m = outcome.measurement
    assert m.observed["divergence_high"] > 0.3
    assert m.impact.baseline < m.impact.adjusted
    assert m.contributors == ("cogs", "revenue")


def test_decouple_is_direction_aware_for_a_line_where_more_is_better():
    """Revenue falling behind is adverse; revenue running ahead is not.
    The sign comes from the line table, not from the arithmetic."""
    behind = D.decouple(spine({"ar_net": [8e6, 8.1e6], "revenue": [118e6, 150e6]}),
                        ("ar_net", "revenue"), {})
    assert behind.measurement.observed["divergence_high"] < 0


def test_velocity_fires_when_the_cycle_breaks_from_its_own_median():
    series_set = spine({"ar_net": [8e6, 8e6, 8e6, 30e6],
                        "revenue": [118e6] * 4})
    outcome = D.velocity(series_set, D.CYCLES[0], {})
    m = outcome.measurement
    assert m.observed["days_break_high"] > 30
    assert m.impact.kind == "headroom"
    assert m.impact.unit == F.UNIT_DAYS


def test_velocity_declares_the_annualisation_assumption_when_the_spine_is_silent():
    series_set = spine({"ar_net": [8e6, 8e6, 30e6], "revenue": [118e6] * 3},
                       days_covered=None)
    outcome = D.velocity(series_set, D.CYCLES[0], {})
    assert any("annualised at 365 days" in c for c in outcome.measurement.caveats)


def test_reversal_finds_a_period_end_entry_given_back():
    series_set = spine({"ar_net": [8e6, 20e6, 8.2e6]})
    outcome = D.reversal(series_set, "ar_net", {})
    m = outcome.measurement
    assert m.observed["reversal_share_min"] > 0.9
    assert m.observed["spike_share_of_basis_min"] > 0.02


def test_reversal_reports_the_biggest_giveback_not_the_latest_wobble():
    """8M to 25M and back, then a 0.1M drift. The 16.8M reversal is the
    finding; the drift is a sign change of no consequence."""
    outcome = D.reversal(spine({"ar_net": [8e6, 25e6, 8.2e6, 8.3e6]}),
                         "ar_net", {})
    m = outcome.measurement
    assert m.observed["reversal_share_min"] > 0.9
    assert m.periods_used == ("P0", "P1", "P2")


def test_reversal_says_so_when_nothing_reversed():
    outcome = D.reversal(spine({"ar_net": RISING_AR}), "ar_net", {})
    assert not outcome.measured()
    assert "opposite movement" in outcome.reason


def test_dormant_fires_on_a_frozen_receivable():
    frozen = [7.7e6, 7.7e6, 7.7e6, 7.7e6]
    outcome = D.dormant(spine({"ar_intercompany": frozen}),
                        "ar_intercompany", {"movement_tolerance": 0.005})
    m = outcome.measurement
    assert m.observed["min_dormant_periods"] == 3.0
    assert m.impact.metric.startswith("equity_ratio_ex_")


def test_dormant_refuses_a_line_where_standing_still_is_normal():
    outcome = D.dormant(spine({"cash": [1e6] * 4}), "cash", {})
    assert not outcome.measured()
    assert "not an aging problem" in outcome.reason


def test_trend_reports_slope_agreement_and_a_projection():
    rising = [8e6, 10e6, 12e6, 14e6, 16e6]
    outcome = D.trend(spine({"ar_net": rising}), "ar_net",
                      {"projection_periods": 3.0})
    m = outcome.measurement
    assert m.observed["min_agreement"] == 1.0
    assert m.observed["min_slope_per_period"] > 0
    projected = [f for f in m.figures if f.fact == "projected_share_pct"][0]
    current = [f for f in m.figures if f.fact == "line_share_pct"][0]
    assert projected.value > current.value
    assert m.impact.kind == "headroom"


def test_trend_reports_no_adverse_slope_when_the_line_improves():
    falling = [16e6, 14e6, 12e6, 10e6, 8e6]
    outcome = D.trend(spine({"ar_net": falling}), "ar_net",
                      {"projection_periods": 3.0})
    assert outcome.measurement.observed["min_slope_per_period"] == 0.0


def test_seasonal_compares_the_same_month_a_year_earlier():
    months = [3, 6, 9, 12, 3, 6, 9, 12]
    values = [8e6, 9e6, 9e6, 9e6, 9e6, 9e6, 9e6, 14e6]
    series_set = spine({"ar_net": values}, months=months)
    outcome = D.seasonal(series_set, "ar_net", {})
    m = outcome.measurement
    # The latest period is P7 (December of year two); its counterpart is
    # P3, December of year one — FOUR rows back on this quarterly spine,
    # not one row back and not twelve.
    assert m.periods_used == ("P3", "P7")
    assert m.observed["yoy_change_high"] > 0.2


def test_every_analysis_that_fires_produces_a_contract_complete_finding():
    """The whole point. Each analysis, on data built to trip it, must
    reach a finding the contract lets through — not a sentence with two
    numbers and a hedge."""
    spines = {
        P.M_DIRECTION.id: spine({"ar_net": RISING_AR}),
        P.M_MAGNITUDE.id: spine({"ar_net": [8e6, 8.4e6, 8.8e6, 9.2e6, 25e6]}),
        P.M_DECOUPLE.id: spine({"cogs": [70e6, 95e6, 120e6, 150e6],
                                "revenue": [118e6, 119e6, 120e6, 121e6]}),
        P.M_VELOCITY.id: spine({"ar_net": [8e6, 8e6, 8e6, 30e6],
                                "revenue": [118e6] * 4}),
        P.M_REVERSAL.id: spine({"ar_net": [8e6, 25e6, 8.2e6, 8.3e6]}),
        P.M_DORMANT.id: spine({"ar_intercompany": [7.7e6] * 5}),
        P.M_TREND.id: spine({"ar_net": RISING_AR}),
    }
    for analysis_id, series_set in spines.items():
        result = run(series_set)
        assert result.report.surfaced, analysis_id
        for ranked in result.report.surfaced:
            _assert_contract_complete(ranked.finding)
        # The analysis must have produced a finding — either surfaced in
        # its own right, or merged into the primary for the same root
        # cause, or held back below the cap. Never silently absent.
        produced = set()
        for ranked in result.report.surfaced + result.report.demoted:
            produced.add(ranked.finding.rule_id.split(".")[0])
            produced.update(r.split(".")[0] for r in ranked.merged_from)
        assert analysis_id in produced, (analysis_id, sorted(produced))


# ═════════════════════════════════════════════════════════════════════════
# 6. THE THRESHOLD IS THE ONE THAT FIRED, AND IT HAS AN ADDRESS
# ═════════════════════════════════════════════════════════════════════════


def test_a_surfaced_finding_reports_a_threshold_that_actually_holds():
    result = run(spine({"ar_net": RISING_AR}))
    for ranked in result.report.surfaced:
        assert ranked.finding.threshold.holds()


def test_the_severe_band_is_preferred_when_both_hold():
    result = run(spine({"ar_net": RISING_AR}))
    ranked = find(result, "m_trend.ar_net")
    assert ranked.finding.threshold.parameter == "severe_slope"
    assert ranked.finding.severity == "high"


def test_a_threshold_always_states_where_its_number_came_from():
    result = run(spine({"ar_net": RISING_AR}))
    for ranked in result.report.surfaced:
        assert ranked.finding.threshold.source
        assert P.POLICY_SOURCE in ranked.finding.threshold.source


def test_the_country_pack_overrides_the_table_when_it_registers_the_analysis(
        tmp_path):
    """PACK FIRST. Register `m_trend` as a detector with a tuned value and
    the finding must cite the pack's address, not this lane's."""
    with open(str(CP.DEFAULT_PROFILES_PATH), encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    raw["detectors"].append({
        "detector": P.M_TREND.id,
        "category": "leverage",
        "applies_to": {"profiles": ["all"]},
        "thresholds": {
            "units": {"min_slope_per_period": "percent", "severe_slope": "percent",
                      "min_agreement": "percent", "projection_periods": "count"},
            "labels": {"min_slope_per_period": "packed slope ceiling",
                       "severe_slope": "packed severe slope ceiling",
                       "min_agreement": "packed agreement floor",
                       "projection_periods": "packed horizon"},
            "default": {"min_slope_per_period": 0.5, "severe_slope": 0.9,
                        "min_agreement": 0.7, "projection_periods": 3},
        },
        "why_here": {"default": "A {profile_label} reads this from the pack."},
    })
    target = tmp_path / "profiles.yaml"
    with open(str(target), "w", encoding="utf-8") as fh:
        yaml.safe_dump(raw, fh, allow_unicode=True)
    catalog = CP.load_catalog(str(target))
    profile = CP.build_company_profile(BASE, period_id="p0", catalog=catalog)

    resolved = P.resolve_threshold(profile, P.M_TREND.id, "severe_slope")
    assert resolved.value == 0.9
    assert resolved.source.startswith("profiles.yaml#detectors.m_trend")
    assert resolved.label == "packed severe slope ceiling"

    # And the tuned ceiling actually changes the verdict.
    result = E.analyse_multi_period(spine({"ar_net": RISING_AR}), profile)
    assert "m_trend.ar_net" not in surfaced_rules(result)


def test_a_check_that_ran_and_did_not_fire_is_recorded_with_its_number():
    result = run(spine({"ar_net": [8e6, 8.01e6, 8.02e6, 8.03e6, 8.04e6]}))
    notes = [c for c in result.finding_set.all_checks()
             if c["rule_id"] == "m_direction.ar_net"]
    assert notes and notes[0]["fired"] is False
    assert notes[0]["note"]
    assert notes[0]["observed"] is not None


def test_a_non_firing_check_cites_the_ordinary_limit_not_the_severe_one():
    """The number a reader wants on a quiet row is the one the line came
    closest to, not the alarm it was nowhere near."""
    result = run(spine({"ar_net": [8e6, 8.01e6, 8.02e6, 8.03e6, 8.04e6]}))
    row = [c for c in result.finding_set.all_checks()
           if c["rule_id"] == "m_direction.ar_net"][0]
    assert row["parameter"] == P.M_DIRECTION.bands[-1] == "min_consecutive_periods"
    assert row["limit"] == P.M_DIRECTION.parameter(
        "min_consecutive_periods").default


def test_an_analysis_whose_lines_could_not_be_measured_says_why():
    """"We could not measure this" must not look like "we measured it and
    it was fine"."""
    result = run(spine({"ar_net": [8e6, 8e6, 8e6, 8e6, 8e6]}))
    magnitude = [r for r in result.requirements
                 if r.analysis_id == P.M_MAGNITUDE.id][0]
    assert magnitude.satisfied is False
    assert magnitude.reason
    unmeasured = [c for c in result.finding_set.all_checks()
                  if c["rule_id"] == "m_magnitude.ar_net"]
    assert unmeasured and unmeasured[0]["note"].startswith("not measured:")


# ═════════════════════════════════════════════════════════════════════════
# 7. THE RENDER SURVIVES THE TYPED-PLACEHOLDER PATH (F5)
# ═════════════════════════════════════════════════════════════════════════


def test_every_surfaced_body_round_trips_through_templatize_byte_for_byte():
    result = run(spine({"ar_net": RISING_AR, "ar_intercompany": RISING_AR}))
    assert result.report.surfaced
    for ranked in result.report.surfaced:
        rendered = ranked.finding.render()
        facts = ranked.finding.facts_cited
        currency = ranked.finding.currency
        assert _ratio_units.render_native(
            rendered.body_template, facts, currency) == rendered.body
        assert _ratio_units.render_native(
            rendered.title_template, facts, currency) == rendered.title


def test_no_title_carries_a_currency_label():
    """Every multi-period threshold is dimensionless on purpose, so the
    adjacency that produced the Critical-461 render defect cannot occur
    in a title."""
    result = run(spine({"ar_net": RISING_AR}))
    for ranked in result.report.surfaced:
        assert "RON" not in ranked.finding.render().title


def test_a_line_with_no_declared_money_name_never_prints_a_currency_figure():
    """`inventory` is not in the `_ratio_units` money registry. Its
    findings therefore speak in shares and counts — printing it would
    emit a currency word that the display path never converts."""
    assert S.LINES_BY_KEY["inventory"].money_fact is None
    outcome = D.direction(spine({"inventory": [8e6, 9e6, 10e6, 11e6, 12e6]}),
                          "inventory", {})
    assert all(f.unit != F.UNIT_MONEY for f in outcome.measurement.figures)


def test_every_cited_money_fact_is_declared_money_in_the_registry():
    for spec in S.DEFAULT_LINES:
        if spec.money_fact:
            assert _ratio_units.unit_for_fact(spec.money_fact) == \
                _ratio_units.UNIT_MONEY, spec.key


def test_every_non_money_fact_name_resolves_to_a_declared_unit():
    """A fact whose unit is UNKNOWN would demote its own finding. Sweep
    every name the analyses can emit."""
    series_sets = [
        spine({"ar_net": RISING_AR, "ar_intercompany": RISING_AR}),
        spine({"ar_net": [8e6, 25e6, 8.2e6, 8.3e6]}),
        spine({"cogs": [70e6, 95e6], "revenue": [118e6, 120e6]}),
        spine({"ar_net": [8e6, 8e6, 8e6, 30e6], "revenue": [118e6] * 4}),
    ]
    names = set()
    for series_set in series_sets:
        for analysis_id, runner, targets in E.ROSTER:
            params = E._resolved_params(profile_of(), analysis_id)
            for target in targets(series_set):
                try:
                    outcome = runner(series_set, target, params)
                except S.NeedsHistoryError:
                    continue
                if outcome.measured():
                    names.update(f.fact for f in outcome.measurement.figures)
    assert names
    for name in names:
        assert _ratio_units.unit_for_fact(name) != _ratio_units.UNIT_UNKNOWN, name


# ═════════════════════════════════════════════════════════════════════════
# 8. PERSISTENCE IS SIGNAL
# ═════════════════════════════════════════════════════════════════════════


def test_a_recurring_finding_is_labelled_with_its_run():
    series_set = spine({"ar_net": RISING_AR})
    prior = [E.PriorFinding(period_ordinal=3, rule_id="m_trend.ar_net",
                            scope_key="411"),
             E.PriorFinding(period_ordinal=2, rule_id="m_trend.ar_net",
                            scope_key="411")]
    result = run(series_set, prior_findings=prior)
    ranked = find(result, "m_trend.ar_net")
    assert ranked.persistence == 3
    assert ranked.persistence_label == "3rd consecutive period"
    assert "3rd consecutive period" in ranked.finding.why_here.rationale


def test_persistence_counts_on_the_spine_not_on_the_calendar():
    """A period the company never uploaded is not a period in which the
    finding was absent."""
    series_set = spine({"ar_net": RISING_AR})
    prior = [E.PriorFinding(period_ordinal=3, rule_id="m_trend.ar_net",
                            scope_key="411"),
             E.PriorFinding(period_ordinal=1, rule_id="m_trend.ar_net",
                            scope_key="411")]
    ranked = find(run(series_set, prior_findings=prior), "m_trend.ar_net")
    assert ranked.persistence == 2          # ordinal 2 is missing, run stops


def test_a_first_time_finding_says_nothing_about_a_run():
    ranked = find(run(spine({"ar_net": RISING_AR})), "m_trend.ar_net")
    assert ranked.persistence == 1
    assert "consecutive period" not in ranked.finding.why_here.rationale


def test_persistence_raises_the_rank_of_an_otherwise_identical_finding():
    series_set = spine({"ar_net": RISING_AR})
    fresh = find(run(series_set), "m_trend.ar_net")
    prior = [E.PriorFinding(period_ordinal=o, rule_id="m_trend.ar_net",
                            scope_key="411") for o in (1, 2, 3)]
    repeated = find(run(series_set, prior_findings=prior), "m_trend.ar_net")
    assert repeated.score.total > fresh.score.total


# ═════════════════════════════════════════════════════════════════════════
# 9. THE WHY-HERE IS ABOUT THIS COMPANY
# ═════════════════════════════════════════════════════════════════════════


def test_the_rationale_carries_a_profile_anchor():
    profile = profile_of()
    result = run(spine({"ar_net": RISING_AR}))
    for ranked in result.report.surfaced:
        rationale = ranked.finding.why_here.rationale.lower()
        assert any(a.lower() in rationale for a in profile.anchors())


def test_the_finding_records_the_profile_that_qualified_it():
    profile = profile_of()
    ranked = find(run(spine({"ar_net": RISING_AR})), "m_trend.ar_net")
    assert ranked.finding.profile_id == profile.profile_id
    assert ranked.finding.profile_fingerprint == profile.fingerprint()


def test_two_different_companies_do_not_get_the_same_sentence():
    """The anti-generic law in its operational form."""
    with open(str(FIXTURES / "eei_dec_2025.json"), encoding="utf-8") as fh:
        eei = json.load(fh)["assembled"]["statements"]
    agras_result = run(spine({"ar_net": RISING_AR}))
    eei_profile = CP.build_company_profile(eei, period_id="p0")
    periods = list(spine({"ar_net": RISING_AR}).periods)
    eei_stmts = {}
    for i, period in enumerate(periods):
        stmts = copy.deepcopy(eei)
        stmts["assembled_bs"]["ar_net"] = RISING_AR[i]
        eei_stmts[period.period_id] = stmts
    eei_result = E.analyse_multi_period(
        S.build_series_set(periods, eei_stmts), eei_profile)
    a = find(agras_result, "m_trend.ar_net")
    b = find(eei_result, "m_trend.ar_net")
    assert a is not None and b is not None
    assert a.finding.render().body != b.finding.render().body
    assert a.finding.profile_id != b.finding.profile_id


# ═════════════════════════════════════════════════════════════════════════
# 10. DETERMINISM
# ═════════════════════════════════════════════════════════════════════════


def test_the_same_spine_produces_a_byte_identical_payload_twice():
    series_set = spine({"ar_net": RISING_AR, "cogs": [70e6, 80e6, 90e6, 100e6, 110e6]})
    first = json.dumps(run(series_set).to_payload(), sort_keys=True)
    second = json.dumps(run(series_set).to_payload(), sort_keys=True)
    assert first == second


def test_no_clock_or_random_source_is_imported_anywhere_in_the_lane():
    banned = {"time", "datetime", "random", "uuid", "secrets"}
    for path in SCAN_PATHS:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name.split(".")[0] not in banned, path.name
            elif isinstance(node, ast.ImportFrom):
                assert (node.module or "").split(".")[0] not in banned, path.name


# ═════════════════════════════════════════════════════════════════════════
# 11. THE N7 GUARD — no profile name and no threshold literal in the lane
# ═════════════════════════════════════════════════════════════════════════

#: THIS lane's modules only. The sibling single-period detectors in the
#: same package (`_base.py`, `s_*.py`) carry their own copy of this guard
#: in their own test file — a guard that fails on another lane's file
#: reports the wrong owner and blocks the wrong person.
SCAN_PATHS = tuple(
    sorted((REPO / "src" / "engine" / "api" / "findings").glob("m_*.py"))
    + [REPO / "src" / "engine" / "api" / "_finding_rank.py"])


def _guarded_tokens():
    cat = CP.load_catalog()
    tokens = set(p.id for p in cat.structural_profiles)
    tokens |= set(b.id for b in cat.size_bands)
    tokens |= set(f.id for f in cat.financing_contexts)
    return tokens


def _prose_nodes(tree):
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) \
                and isinstance(node.value.value, str):
            out.add(id(node.value))
    return out


def _quoted_profile_ids(source, tokens):
    tree = ast.parse(source)
    prose = _prose_nodes(tree)
    hits = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if id(node) in prose:
            continue
        if node.value.strip() in tokens:
            hits.append((node.lineno, node.value))
    return hits


def _profile_comparisons(source):
    tree = ast.parse(source)
    hits = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Compare):
            continue
        operands = [node.left] + list(node.comparators)
        names = []
        for operand in operands:
            if isinstance(operand, ast.Name):
                names.append(operand.id)
            elif isinstance(operand, ast.Attribute):
                names.append(operand.attr)
        has_string = any(isinstance(o, ast.Constant) and isinstance(o.value, str)
                         for o in operands)
        if has_string and any(
                n in ("profile", "profile_id", "structure", "size_band",
                      "composite_id", "financing") for n in names):
            hits.append(node.lineno)
    return hits


def test_the_multi_period_lane_quotes_no_profile_id():
    tokens = _guarded_tokens()
    violations = []
    for path in SCAN_PATHS:
        for lineno, value in _quoted_profile_ids(
                path.read_text(encoding="utf-8"), tokens):
            violations.append("%s:%d quotes %r"
                              % (path.relative_to(REPO), lineno, value))
    assert not violations, (
        "N7 violation — profile names belong in profiles.yaml:\n"
        + "\n".join(violations))


def test_the_multi_period_lane_never_branches_on_a_profile_id():
    violations = []
    for path in SCAN_PATHS:
        for lineno in _profile_comparisons(path.read_text(encoding="utf-8")):
            violations.append("%s:%d" % (path.relative_to(REPO), lineno))
    assert not violations, (
        "N7 violation — branch on profile.threshold(...), never on an id:\n"
        + "\n".join(violations))


def test_the_guard_can_fail():
    tokens = _guarded_tokens()
    assert _quoted_profile_ids('X = "property_rental"\n', tokens)
    assert _profile_comparisons('if profile_id == "property_rental":\n    pass\n')
    assert not _quoted_profile_ids(
        '"""A property_rental vehicle is graded differently."""\n', tokens)


def test_the_scan_set_is_not_empty():
    assert [p for p in SCAN_PATHS if p.exists()]


def test_every_analysis_declares_a_storable_category():
    """The alert table's CHECK constraint is the authority; an analysis
    inventing a category would fail at insert rather than at review."""
    allowed = {"liquidity", "leverage", "margin", "inventory", "compliance",
               "data_quality", "working_capital", "customer", "supplier",
               "opportunity"}
    for spec in P.ANALYSES.values():
        assert spec.category in allowed, spec.id


def test_every_analysis_declares_units_labels_and_a_severity_for_each_parameter():
    valid_units = {F.UNIT_COUNT, F.UNIT_PERCENT, F.UNIT_DAYS, F.UNIT_SCORE,
                   F.UNIT_RATIO}
    for spec in P.ANALYSES.values():
        assert spec.bands, spec.id
        for name in spec.bands + spec.gates:
            param = spec.parameter(name)
            assert param.unit in valid_units, (spec.id, name)
            assert param.label.strip()
            assert param.comparator in F.COMPARATORS
            assert param.severity in R.SEVERITY_RANK


def test_every_action_template_leads_with_a_real_imperative_verb():
    for spec in P.ANALYSES.values():
        for step in spec.actions:
            verb = step.imperative.split(" ", 1)[0].lower()
            assert verb in F.IMPERATIVE_VERBS, (spec.id, verb)
            assert verb not in F.WEAK_LEAD_VERBS, (spec.id, verb)
            assert step.artefact.strip() and step.provider.strip()


def test_no_analysis_copy_contains_banned_phrasing():
    for spec in P.ANALYSES.values():
        blob = " ".join([spec.why_here]
                        + [s.imperative + " " + s.artefact for s in spec.actions]
                        ).lower()
        for phrase in F.BANNED_PHRASES:
            assert phrase not in blob, (spec.id, phrase)


def test_every_why_here_template_carries_a_company_anchor_token():
    for spec in P.ANALYSES.values():
        assert "{profile_label}" in spec.why_here, spec.id
