"""The plan calendar and year-to-date tax (plan_contract_v2 6.1, 6.3, 2.2).

Part of battery gate ``forecast-model`` (its command runs this file beside
``test_forecast_model.py``).

TIMELINE (6.1)
==============
``build_timeline(anchor, total_years, monthly_months)``: monthly periods
k = 1..monthly_months with ``year_offset = (k - 1) // 12 + 1``, then one
annual period per remaining plan year, contiguous. The horizon is two
request fields and never a driver (2.2): neither ``horizon_years`` nor
``year_one_granularity`` is a key, and naming either as an override is an
unknown driver.

TAX (6.3)
=========
``income_tax_p = max(0, tax on the year-to-date pre-tax result through p)``
less the tax already charged earlier in the same plan year; an annual
period is charged ``max(0, pre-tax x rate)``; nothing about a loss year
reaches the next one. Conventions ``tax_accrued_year_to_date`` and
``tax_no_loss_carry_forward`` (packs/forecast/levers.yaml#tax).

No committed book has a loss month inside a profitable year, so the
loss-then-profit year is CONSTRUCTED from the real agras book, and labelled
as constructed: the opening interest-bearing debt is repaid in the first
month and priced at a caller rate, which only that month's opening balance
bears, sized from the run itself so the month's interest is twice its
pre-tax result (TC-10: the
rate is rendered from the base run's own integers, never typed).

WHAT THIS FILE REDS ON AFTER THE REPAIR (TC-11)
-----------------------------------------------
A plan year whose periods' tax does not sum to max(0, tax on the year's
result) to the minor unit (the plant: per-period positive-only tax, which
taxes the profit months of a loss-then-profit year and ignores the loss); a
period whose cumulative tax differs from the tax on its year-to-date result;
a loss carried into the next plan year; a monthly period whose year_offset
is not (k - 1) // 12 + 1; a gap or overlap in the calendar; a horizon
accepted as a driver override; a sweep that met no loss month, no reversal
or no cell (TC-3).

IT CANNOT SEE: whether the tax RATE is right (forecast-defaults, B3); the
served figures (forecast-route, forecast-serving-boundary).
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import pytest

from engine.forecast import (AssumptionError, DebtMove, DebtSchedule,
                             OpeningPosition, pl_history_from_payload, project,
                             project_payload)
from engine.forecast.assumptions import KEYS
from engine.forecast.levers_pack import tax_conventions
from engine.forecast.money import MICRO, apply_rate, mul_div
from engine.forecast.project import (FP1_CONVENTIONS, LINE_ASSUMPTIONS,
                                     context_for_payload)
from engine.forecast.timeline import MONTHLY_MONTHS, add_months, build_timeline
from engine.serving.facts import FactsGateway

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
BOOKS = ("agras", "carniprod", "realestate", "retail")
_CALLER_REVOLVER_RATE = 0.09

_SWEEP = {"cells": 0, "loss_years": 0, "reversals": 0}


@pytest.fixture(autouse=True)
def _no_access_log(monkeypatch):
    monkeypatch.setenv("ENGINE_ACCESS_LOG", "0")


def load(name):
    return json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text())


def inputs(payload):
    gateway = FactsGateway.from_envelope(
        payload["envelope"], currency=str(payload.get("currency") or "RON"))
    opening = OpeningPosition.from_gateway(gateway, str(payload["period_end"]))
    return opening, pl_history_from_payload(payload)


def run(name, total_years, monthly_months, payload=None, **drivers):
    payload = payload or load(name)
    opening, history = inputs(payload)
    base = project(opening, history, context=context_for_payload(payload),
                   total_years=1, monthly_months=12)
    if not base.assumptions.is_available("revolver_rate"):
        drivers.setdefault("revolver_rate", _CALLER_REVOLVER_RATE)
    return project(opening, history, context=context_for_payload(payload),
                   total_years=total_years,
                   monthly_months=monthly_months, **drivers)


def ytd_law_violations(projection):
    """Every (period, reason) where tax departs from the 6.3 law, and the
    number of periods checked. The test's own integer walk."""
    rate = projection.assumptions.micros("tax_rate")
    bad = []
    checked = 0
    year = None
    ytd_pretax = ytd_tax = 0
    for p in projection.periods:
        if p.period.year_offset != year:
            year = p.period.year_offset
            ytd_pretax = ytd_tax = 0
        ytd_pretax += p.pl["pretax_result"]
        ytd_tax += -p.pl["income_tax"]
        due = max(0, mul_div(ytd_pretax, rate, MICRO))
        checked += 1
        if ytd_tax != due:
            bad.append("%s: cumulative tax %d, due on year-to-date pre-tax %d "
                       "at %d micros is %d" % (p.label, ytd_tax, ytd_pretax,
                                               rate, due))
    return bad, checked


# ── timeline (6.1) ────────────────────────────────────────────────────


@pytest.mark.parametrize("monthly_months", MONTHLY_MONTHS)
@pytest.mark.parametrize("total_years", (1, 2, 3, 4, 5))
def test_the_calendar_is_monthly_months_then_one_period_per_plan_year(
        total_years, monthly_months):
    anchor = date(2025, 12, 31)
    if total_years * 12 < monthly_months:
        with pytest.raises(AssumptionError) as caught:
            build_timeline(anchor, total_years, monthly_months)
        message = str(caught.value)
        assert "monthly_months" in message
        # TC-10: the refusal renders the numbers the check compared
        assert str(monthly_months) in message and str(total_years * 12) in message
        return
    periods = build_timeline(anchor, total_years, monthly_months)
    _SWEEP["cells"] += len(periods)
    monthly = [p for p in periods if p.granularity == "monthly"]
    annual = [p for p in periods if p.granularity == "annual"]
    assert len(monthly) == monthly_months
    assert len(annual) == total_years - monthly_months // 12
    assert [p.granularity for p in periods] == (
        ["monthly"] * monthly_months + ["annual"] * len(annual))
    for k, p in enumerate(monthly, start=1):
        assert p.year_offset == (k - 1) // 12 + 1, p
        assert p.label == "%04d-%02d" % (p.end.year, p.end.month)
        assert p.end == add_months(anchor, k)
    for p in annual:
        assert p.label == "FY%04d" % p.end.year
        assert p.end == add_months(anchor, p.year_offset * 12)
    assert [p.year_offset for p in annual] == list(
        range(monthly_months // 12 + 1, total_years + 1))
    cursor = anchor
    for index, p in enumerate(periods):
        assert p.index == index
        assert p.start == cursor + timedelta(days=1)
        cursor = p.end
    assert cursor == add_months(anchor, total_years * 12)


@pytest.mark.parametrize("args,field", (
    ((0, 12), "total_years"),
    ((3, 6), "monthly_months"),
    ((3, 36), "monthly_months"),
    ((2.0, 12), "total_years"),
    ((3, 12.0), "monthly_months"),
    ((True, 12), "total_years"),
))
def test_an_impossible_horizon_is_refused_by_field(args, field):
    with pytest.raises(AssumptionError) as caught:
        build_timeline(date(2025, 12, 31), *args)
    assert field in str(caught.value)
    if field == "monthly_months" and isinstance(args[1], int):
        # the allowed windows are rendered from the constant the check used
        for allowed in MONTHLY_MONTHS:
            assert str(allowed) in str(caught.value)


def test_the_horizon_is_an_argument_and_never_a_driver():
    assert "horizon_years" not in KEYS
    assert "year_one_granularity" not in KEYS
    opening, history = inputs(load("agras"))
    for key, value in (("horizon_years", 3), ("year_one_granularity", "annual")):
        with pytest.raises(AssumptionError) as caught:
            project(opening, history, total_years=1, monthly_months=12,
                    **{key: value})
        assert "unknown driver" in str(caught.value) and key in str(caught.value)
    with pytest.raises(TypeError):
        project(opening, history)  # the horizon has no hidden default here


@pytest.mark.parametrize("name", BOOKS)
def test_a_24_month_window_keys_every_schedule_on_the_plan_year(name):
    """Revenue, held lines, dividends and tax all key on year_offset: the
    plan-year totals of the lines sliced from an annual amount at a 24-month
    window equal the same plan years at a 12-month window, and dividends
    land on each plan year's last month. (Cost of sales is a share of each
    period's revenue, rounded per period until the pools of B4, so its
    plan-year total is not window-invariant to the minor unit and is not
    asserted here.)"""
    drivers = dict(revenue_growth=0.07, dividend_payout_pct=0.4)
    narrow = run(name, 3, 12, **drivers)
    wide = run(name, 3, 24, **drivers)
    for year in (1, 2, 3):
        for line in ("revenue", "other_financial_income",
                     "other_financial_expense"):
            assert (sum(p.pl[line] for p in narrow.periods
                        if p.period.year_offset == year)
                    == sum(p.pl[line] for p in wide.periods
                           if p.period.year_offset == year)), (name, line, year)
    paid = [p.label for p in wide.periods if p.cf["dividends_paid"] != 0]
    ends = [p.label for p in wide.periods
            if p.period.index in (11, 23) or p.period.granularity == "annual"]
    assert set(paid) <= set(ends), (name, paid)
    bad, checked = ytd_law_violations(wide)
    _SWEEP["cells"] += checked
    assert not bad, bad


# ── tax (6.3) ─────────────────────────────────────────────────────────


def test_the_tax_conventions_are_the_packs_and_attribute_every_tax_line():
    ids = [c.convention_id for c in tax_conventions()]
    assert ids == ["tax_accrued_year_to_date", "tax_no_loss_carry_forward"]
    declared = dict(FP1_CONVENTIONS)
    for convention in tax_conventions():
        assert declared[convention.convention_id] == convention.sentence
        assert convention.rule_id == (
            "packs/forecast/levers.yaml#tax." + convention.key)
        for line in ("pl.income_tax", "pl.net_income"):
            assert convention.convention_id in LINE_ASSUMPTIONS[line], line
    assert "tax_charged_when_it_arises" not in declared


@pytest.mark.parametrize("name", BOOKS)
@pytest.mark.parametrize("monthly_months", MONTHLY_MONTHS)
@pytest.mark.parametrize("total_years", (3, 5))
def test_every_period_is_charged_the_tax_on_its_year_to_date_result(
        name, monthly_months, total_years):
    projection = run(name, total_years, monthly_months)
    bad, checked = ytd_law_violations(projection)
    _SWEEP["cells"] += checked
    assert not bad, "%s: %s" % (name, bad[:3])
    rate = projection.assumptions.micros("tax_rate")
    for year in sorted(set(p.period.year_offset for p in projection.periods)):
        periods = [p for p in projection.periods if p.period.year_offset == year]
        pretax = sum(p.pl["pretax_result"] for p in periods)
        if pretax < 0:
            _SWEEP["loss_years"] += 1
        assert (sum(-p.pl["income_tax"] for p in periods)
                == max(0, apply_rate(pretax, rate))), (name, year)
        if len(periods) == 1:
            assert -periods[0].pl["income_tax"] == max(
                0, apply_rate(periods[0].pl["pretax_result"], rate))


def _loss_then_profit(total_years=1):
    """CONSTRUCTED on the real agras book: the opening debt is repaid in
    month one and priced so that month's interest is twice its pre-tax
    result, which makes month one a loss inside a profitable year."""
    payload = load("agras")
    opening, history = inputs(payload)
    base = project(opening, history, context=context_for_payload(payload),
                   total_years=total_years, monthly_months=12)
    first = base.periods[0]
    debt = opening.cents("st_debt") + opening.cents("lt_debt")
    assert debt > 0, "the fixture changed: agras carries no debt to price"
    days_basis = base.assumptions.count("days_basis")
    target = 2 * first.pl["pretax_result"] - first.pl["interest_expense_debt"]
    # rate = target x days_basis / (debt x days), in micros, rendered from
    # the run's own integers; one micro above so the charge clears target
    rate_micros = mul_div(target * days_basis, MICRO, debt * first.period.days) + 1
    schedule = DebtSchedule([DebtMove(0, st_repay=opening.cents("st_debt"),
                                      lt_repay=opening.cents("lt_debt"))])
    rate_text = "%d.%06d" % (rate_micros // MICRO, rate_micros % MICRO)
    projection = project(opening, history, context=context_for_payload(payload),
                   total_years=total_years,
                         monthly_months=12, interest_rate_debt=rate_text,
                         debt_schedule=schedule)
    return projection, rate_text


def test_a_loss_month_then_profit_months_is_taxed_on_the_years_result():
    """Contract 6.3's gate: the year's tax equals max(0, annual pre-tax) x
    rate to the minor unit, and the loss month is shielded inside its year."""
    projection, rate_text = _loss_then_profit()
    months = projection.periods
    pretax = [p.pl["pretax_result"] for p in months]
    assert pretax[0] < 0 < min(pretax[1:]), (
        "the construction did not produce a loss month followed by profit "
        "months (rate %s): %s" % (rate_text, pretax))
    assert sum(pretax) > 0
    rate = projection.assumptions.micros("tax_rate")
    charged = sum(-p.pl["income_tax"] for p in months)
    assert charged == max(0, apply_rate(sum(pretax), rate)), (
        "the year's tax %d is not the tax on the year's pre-tax %d at %d "
        "micros (%d); the loss month was not shielded"
        % (charged, sum(pretax), rate, apply_rate(sum(pretax), rate)))
    # per-period positive-only tax would have charged strictly more
    positive_only = sum(apply_rate(x, rate) for x in pretax if x > 0)
    assert positive_only > charged
    assert months[0].pl["income_tax"] == 0  # year-to-date never below zero
    bad, checked = ytd_law_violations(projection)
    _SWEEP["cells"] += checked
    assert not bad, bad


def test_a_loss_after_profit_reverses_tax_within_the_year_and_never_below_zero():
    """A period may be credited (negative charge) within its year; the
    cumulative charge never goes below zero. Constructed on agras: a draw in
    the eleventh month, at the book's own rate, sized from the run so
    December's interest is twice December's pre-tax result."""
    payload = load("agras")
    opening, history = inputs(payload)
    base = project(opening, history, context=context_for_payload(payload),
                   total_years=1, monthly_months=12)
    last = base.periods[11]
    rate = base.assumptions.micros_or_none("interest_rate_debt")
    assert rate, "agras prices its own debt"
    days_basis = base.assumptions.count("days_basis")
    need = 2 * last.pl["pretax_result"]
    draw = mul_div(need * days_basis, MICRO, rate * last.period.days) + 100
    projection = project(opening, history, context=context_for_payload(payload),
                   total_years=1, monthly_months=12,
                         debt_schedule=DebtSchedule([DebtMove(10, lt_draw=draw)]))
    december = projection.periods[11]
    assert december.pl["pretax_result"] < 0
    year_pretax = sum(p.pl["pretax_result"] for p in projection.periods)
    credits = [p.label for p in projection.periods if p.pl["income_tax"] > 0]
    assert credits == ["2026-12"], credits
    _SWEEP["reversals"] += len(credits)
    tax_rate = projection.assumptions.micros("tax_rate")
    assert (sum(-p.pl["income_tax"] for p in projection.periods)
            == max(0, apply_rate(year_pretax, tax_rate)))
    bad, checked = ytd_law_violations(projection)
    _SWEEP["cells"] += checked
    assert not bad, bad


def test_no_loss_is_carried_into_the_next_plan_year():
    """Year one a loss (the opening debt priced high all year and repaid in
    its last month), plan year two a profit: year two is charged the full
    tax on its own result, and year one nothing."""
    payload = load("agras")
    opening, history = inputs(payload)
    base = project(opening, history, context=context_for_payload(payload),
                   total_years=2, monthly_months=12)
    year_one = sum(p.pl["pretax_result"] for p in base.periods
                   if p.period.year_offset == 1)
    debt = opening.cents("st_debt") + opening.cents("lt_debt")
    rate_micros = mul_div(2 * year_one, MICRO, debt) + 1
    rate_text = "%d.%06d" % (rate_micros // MICRO, rate_micros % MICRO)
    schedule = DebtSchedule([DebtMove(11, st_repay=opening.cents("st_debt"),
                                      lt_repay=opening.cents("lt_debt"))])
    projection = project(opening, history, context=context_for_payload(payload),
                   total_years=2, monthly_months=12,
                         interest_rate_debt=rate_text, debt_schedule=schedule)
    tax_rate = projection.assumptions.micros("tax_rate")
    loss = sum(p.pl["pretax_result"] for p in projection.periods
               if p.period.year_offset == 1)
    assert loss < 0, (rate_text, loss)
    _SWEEP["loss_years"] += 1
    assert sum(p.pl["income_tax"] for p in projection.periods
               if p.period.year_offset == 1) == 0
    fy = [p for p in projection.periods if p.period.year_offset == 2]
    assert len(fy) == 1 and fy[0].pl["pretax_result"] > 0
    assert -fy[0].pl["income_tax"] == apply_rate(fy[0].pl["pretax_result"],
                                                 tax_rate), (
        "plan year two was charged %d on %d; a carried loss would shield it"
        % (-fy[0].pl["income_tax"], fy[0].pl["pretax_result"]))


def test_project_payload_keeps_horizon_years_as_total_years_at_twelve_months():
    payload = load("agras")
    via_keyword = project_payload(payload, horizon_years=3)
    opening, history = inputs(payload)
    direct = project(opening, history, context=context_for_payload(payload),
                   total_years=3, monthly_months=12)
    assert ([p.label for p in via_keyword.periods]
            == [p.label for p in direct.periods])
    assert (json.dumps(via_keyword.as_dict(), sort_keys=True)
            == json.dumps(direct.as_dict(), sort_keys=True))


def test_zz_scope_and_work(capsys):
    """Printed last (TC-12, TC-13); reds on a sweep that measured nothing."""
    with capsys.disabled():
        print("\nSCOPE forecast-model/timeline-tax: books %s (committed "
              "saga_10_col fixtures, FY2025 anchors); monthly_months %s; "
              "total_years 1-5 (calendar), 3 and 5 (tax sweep); CONSTRUCTED "
              "on agras: loss-then-profit month, in-year reversal, loss year "
              "then profit year; no SYNTHETIC pair"
              % (", ".join(BOOKS), "/".join(str(m) for m in MONTHLY_MONTHS)))
        print("timeline-tax coverage: %d periods checked, %d loss plan years, "
              "%d in-year reversals" % (_SWEEP["cells"], _SWEEP["loss_years"],
                                        _SWEEP["reversals"]))
    assert _SWEEP["cells"] > 0, "no period was checked (TC-3)"
    assert _SWEEP["loss_years"] > 0, "no loss plan year was met (TC-3)"
    assert _SWEEP["reversals"] > 0, "no in-year reversal was met (TC-3)"
