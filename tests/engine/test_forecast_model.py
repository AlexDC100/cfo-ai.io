"""LANE M — the projection model, and the four gates it must not fail.

MEASURED ON REAL BOOKS (TC-1). Every figure below is read at test time
out of ``tests/engine/fixtures/firm/saga_10_col_*.json`` — four real
Romanian trial balances through the real engine — through the real
``engine.serving.facts.FactsGateway``. Nothing here is hand-typed except
the driver values a caller would type.

THE GATES
=========
F1  Every projected period closes to ZERO. Not "within tolerance and
    annotated" — zero, to the cent, or the projection is refused and
    says which period and by how much.
F3  Determinism: the same book and the same assumptions produce
    byte-identical output, across processes and across PYTHONHASHSEED.
F6  The opening position IS the source period's closing balances, to the
    cent, taken from the CANONICAL balance sheet.
F8  Cash never silently goes negative: the funding line appears, is
    named on the balance sheet, and is priced.
LP1  Every named income the payload carries reaches a projected line. At
    0% growth the plan's first year re-earns the book's own EBITDA and
    its own pre-tax result.
LP2  A tax rate is `derived` only when spending it on this book's own
    pre-tax result reproduces the profit this book FILED in account 121.
    A rate measured across an unattributable gap is not a measurement.
LP3  Working-capital day drivers carry sub-day precision, a derivation
    and a caller override round by the SAME rule, and 0 — the value that
    liquidates a balance — is unreachable by rounding.
LP4  Growth below -100% is refused rather than projected as negative
    revenue.
LP5  A funding line the book cannot price is REFUSED, never charged 0%.
LP6  No rate the book could not measure is ever spent as 0%. Where the
    driver governs a BALANCE the line is HELD; where it governs a P&L
    flow, or a programme the model creates itself, the plan is REFUSED.
LP7  A rate that is nil at opening is spent on the balance THE PLAN
    creates. Where a default rests on a balance being absent — no
    interest-bearing debt, no depreciable base — and the caller has a
    lever that creates it (a DebtSchedule draw, the capital programme),
    the rate is a refusal and the plan is refused at the period where
    the balance appears, never charged 0%.

WHAT THESE GATES RED ON, AFTER THE REPAIR (TC-11)
=================================================
F1 reds on any break in the articulation between the three statements —
   an opening that does not tie (proved here with the exact 46,613.06 the
   legacy ``assembled_bs`` drops on the agras book), a one-cent opening
   error, a roll-forward whose movement does not reach the cash-flow
   statement. It does NOT red on an economically silly plan: a projection
   built on a 900% growth rate balances perfectly and is nonsense. That
   judgement is not this gate's, and no gate in this file claims it.
F3 reds on a clock, a ``hash()``, or a ``set`` whose iteration order
   reaches output. It cannot see non-determinism that is stable within
   one interpreter build — a C-level ordering, say — because it runs
   five processes of the same interpreter.
F6 reds when the opening partition loses or double-counts a served row,
   when a row sits in a section the model cannot place, and when the
   source is switched to the legacy assembly. It does NOT check that the
   canonical statement is itself right; that is the canonical BS suite's
   job.
F8 reds when a period closes below the cash floor, and when the funding
   line is drawn without appearing on the balance sheet. It does NOT
   judge whether a lender would actually extend the line.
LP1 reds on a named P&L figure the payload carries that no projected line
   consumes — wherever it is dropped: in `history.py`'s reader, in the
   driver set, or in the roll-forward. It reds per book, through the
   difference between the book's own result and the model's, sized
   against the model's own micro-resolution rather than a chosen
   tolerance. It does NOT judge the ECONOMICS of holding a financial
   item flat rather than growing it; that is a stated convention with
   its own gate, and a reader may disagree with it in the open.
LP2 reds on a tax rate stamped `derived` while the reconstruction
   leaves an unattributable difference against account 121, on a
   demotion whose basis does not carry the gap and the displaced rate as
   NUMBERS, on the model's own gap disagreeing with the engine's
   `net_income_unexplained_vs_121`, and on a plan the model itself
   forecasts into profit being charged nothing. It does NOT check that
   16% is the right statutory rate for the year; it does NOT attribute
   the gap to tax (nothing here charges the 51.6379% agras' filed profit
   would imply); it does not implement Romanian loss carry-forward; and
   it cannot see a book whose account-121 anchor is itself wrong. No
   committed book reconciles, so the `derived` branch is exercised by a
   CONSTRUCTED history, labelled as one.
LP3 reds when a day count is stored, derived or coerced at whole-day
   resolution, when a derivation and an override round by different
   rules, and when a positive day count collapses into the refusal value
   0. It does NOT police whether a supplied DSO is commercially
   plausible, and it cannot see a book whose own receivables balance is
   wrong.
LP4 reds when revenue would be projected negative. It does NOT bound
   growth from above (F1's disclaimer above still stands), and it does
   not bound the other rates: a caller may still supply a negative COGS
   percentage, which this gate does not see.
LP5 reds when a plan draws a funding line the book cannot price. It does
   NOT invent a market rate, and it deliberately does not fire when the
   line is never drawn — an unpriceable rate on an undrawn line costs
   nothing, and refusing that plan would refuse a perfectly well-defined
   one.
LP6 reds when an `unavailable` RATE carries a spendable 0 instead of
   nothing, when ``AssumptionSet.micros`` resolves such a rate to zero
   instead of refusing, and when a book that cannot measure one of the
   rates the model spends is projected anyway — proved per driver by
   removing from a REAL book the figure that driver's own derivation
   names, and watching the projection refuse by that driver's name. It
   also reds in the OTHER direction: an absent LINE — no other operating
   income named, no depreciation charge to replace — must still project,
   because a gate that refuses a correct plan is the gate that is wrong.
   It does NOT judge whether a supplied rate is sensible; it does not
   police the MONEY drivers still held at 0 when their line is absent
   (``interest_income_annual`` and the two other-financial lines —
   stated in NOT CLOSED); and it cannot see a rate that is measurable
   but measured from the wrong base. It could not see LP7 at all: every
   check it makes reads the ASSUMPTION OBJECT, and both defects LP7
   closes were invisible until a projection was driven and a PERIOD read.
LP7 reds when a rate that prices a balance is stored as a spendable
   literal instead of a refusal; when ``project`` guards such a rate by
   its SOURCE WORD rather than by whether it has a value (the word and
   the value can disagree, and that gap is where the 0 was charged);
   when a plan that creates the balance projects instead of being
   refused; when the refusal does not name the balance the plan really
   carries; and when a projection the model ACCEPTS prints "this book
   carries none" on its face while its own balance sheet carries some.
   It reds in the other direction too: a plan that leaves the balance
   nil must still project and must charge nothing. And it holds the two
   defaults that SURVIVED the same audit to the test they passed: with
   every lever pulled at once, nothing creates other operating income
   and nothing gives the book a depreciation charge to replace, so their
   0 stays the absence preserved — that gate reds the day a lever is
   added that falsifies either sentence. It does NOT judge whether a
   supplied rate is a market rate; it does not check WHERE the guard
   sits (the behavioural halves do that); it cannot see a default whose
   sentence is falsified by something OUTSIDE the plan (a recaptured
   fixture, a change in the assembly upstream); and no committed book
   opens with a nil depreciable base, so that half runs on a book
   CONSTRUCTED from a real one and labelled as constructed.
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from engine.forecast import (EL_LINES, LINES, AssumptionError,
                             BalanceViolation, DebtMove, DebtSchedule,
                             OpeningPosition, OpeningPositionError,
                             derive_assumptions, pl_history_from_payload,
                             project, project_payload)
from engine.forecast.money import (MICRO_DAY, apply_rate, cents_from,
                                   days_fmt, fmt, micro_days_from,
                                   micros_from, mul_div)
from engine.forecast.opening import OpeningLine
from engine.forecast.project import _slice_by_days, context_for_payload
from engine.forecast.timeline import add_months, build_timeline
from engine.serving.facts import FactsGateway

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
BOOKS = ("agras", "carniprod", "realestate", "retail")

#: The gap between the canonical balance sheet and the legacy assembly on
#: the agras book — the unclassified account-413 balance the legacy path
#: drops. Read at test time from the fixture, never typed, so it stays
#: true if the book is ever recaptured.
def _legacy_gap_cents(payload):
    canonical = FactsGateway.from_envelope(payload["envelope"]).total_assets()
    legacy = payload["statements"]["assembled_bs"]["total_assets"]
    return canonical.amount_minor - cents_from(legacy)


@pytest.fixture(autouse=True)
def _no_access_log(monkeypatch):
    """The gateway's audit seam writes JSONL under data/obs/. This suite
    constructs a gateway per book per test and has nothing to say about
    the log, so it is switched off rather than left to litter the repo."""
    monkeypatch.setenv("ENGINE_ACCESS_LOG", "0")


def load(name):
    return json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text())


def gateway_for(payload):
    return FactsGateway.from_envelope(payload["envelope"],
                                      currency=str(payload.get("currency") or "RON"))


def opening_for(payload):
    return OpeningPosition.from_gateway(gateway_for(payload),
                                        str(payload["period_end"]))


def context_for(payload):
    """The book's own context — its jurisdiction, read from the anchor
    envelope (plan_contract_v2 0.3). A projection built without it records
    no jurisdiction, so no macro or statutory rung applies (plan/2 B3)."""
    return context_for_payload(payload)


#: A caller's borrowing rate, for the books whose own trial balance
#: cannot price a funding line. Supplying one is what a caller must now
#: do: an unpriced draw is REFUSED rather than charged 0% (see
#: test_an_unpriced_funding_line_is_refused_rather_than_charged_nothing).
_CALLER_REVOLVER_RATE = 0.09
_CAN_PRICE_THE_LINE = {}


def can_price_the_funding_line(name):
    """Read off the REAL derivation for this book, never declared. A
    hand-written list of books would go stale the moment a fixture is
    recaptured, and the staleness would look like a passing test."""
    if name not in _CAN_PRICE_THE_LINE:
        base = project_payload(load(name))
        _CAN_PRICE_THE_LINE[name] = base.assumptions.is_available(
            "revolver_rate")
    return _CAN_PRICE_THE_LINE[name]


def plan(name, horizon_years=5, monthly_months=12, **drivers):
    """One projection of one book, with a caller rate supplied only where
    the book cannot price its own line. Every matrix below runs through
    here so the matrices keep exercising the BALANCE guarantee rather
    than re-testing the refusal, which has its own gate.

    The horizon is the request's two fields (plan_contract_v2 2.2), never
    a driver: at a twelve-month window it goes through ``project_payload``
    (whose ``horizon_years`` keyword is ``total_years``), and at any other
    window straight to ``project()``, which takes both as arguments."""
    if "revolver_rate" not in drivers and not can_price_the_funding_line(name):
        drivers = dict(drivers, revolver_rate=_CALLER_REVOLVER_RATE)
    payload = load(name)
    if monthly_months == 12:
        return project_payload(payload, horizon_years=horizon_years, **drivers)
    return project(opening_for(payload), pl_history_from_payload(payload),
                   total_years=horizon_years, monthly_months=monthly_months,
                   context=context_for(payload), **drivers)


def plan_year_total(projection, statement, line, year):
    """A flow line's plan-year total: the sum of the year's periods (the FY
    aggregate of contract 3.6), computed by the test from the periods."""
    return sum(getattr(p, statement)[line] for p in projection.periods
               if p.period.year_offset == year)


def _forecast_sources():
    """Every module of the package, parsed. Structural checks read the
    tree; a substring scan would red on the docstrings that explain the
    rules."""
    source = REPO / "src" / "engine" / "forecast"
    out = []
    for path in sorted(source.glob("*.py")):
        out.append((path, ast.parse(path.read_text(encoding="utf-8"))))
    assert len(out) >= 7, "the package lost a module: %s" % (out,)
    return out


# ──────────────────────────────────────────────────────────────────────
# money — the rounding discipline the balance guarantee rests on
# ──────────────────────────────────────────────────────────────────────


def test_rounding_is_half_away_from_zero_in_both_directions():
    assert mul_div(5, 1, 10) == 1        # 0.5 -> 1
    assert mul_div(-5, 1, 10) == -1      # -0.5 -> -1
    assert mul_div(4, 1, 10) == 0
    assert mul_div(-4, 1, 10) == 0
    assert mul_div(15, 1, 10) == 2       # 1.5 -> 2 (not banker's 2 by luck)
    assert mul_div(25, 1, 10) == 3       # 2.5 -> 3 (banker's would say 2)


def test_a_rate_never_passes_through_binary_floating_point():
    # 0.085 is not representable in binary. The float route gives
    # 85000.00000000001; micros_from must give exactly 85_000.
    assert micros_from(0.085) == 85000
    assert micros_from("8.5%") == 85000
    assert micros_from(0.1) + micros_from(0.2) == micros_from(0.3)
    assert apply_rate(100_00, micros_from(0.085)) == 850


def test_slicing_an_annual_amount_over_a_year_loses_nothing():
    timeline = build_timeline(__import__("datetime").date(2025, 12, 31), 1,
                              12)
    for total in (118_576_819_64, 1, -7, 999_999_99, 0):
        slices = _slice_by_days(total, timeline)
        assert sum(slices) == total, (total, slices)


def test_a_leap_day_is_counted_and_not_invented():
    from datetime import date
    timeline = build_timeline(date(2027, 12, 31), 2, 12)
    # 2028 is a leap year: its twelve months hold 366 days, February 29 of
    # them, and the annual period after the monthly window holds 365.
    assert sum(p.days for p in timeline if p.year_offset == 1) == 366
    assert [p.days for p in timeline][1] == 29
    assert [(p.label, p.days) for p in timeline if p.granularity == "annual"] \
        == [("FY2029", 365)]
    assert add_months(date(2028, 1, 31), 1) == date(2028, 2, 29)


# ──────────────────────────────────────────────────────────────────────
# F6 — the opening position
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", BOOKS)
def test_f6_opening_equals_the_source_periods_closing_balances(name):
    payload = load(name)
    gateway = gateway_for(payload)
    opening = opening_for(payload)
    assert opening.total_assets_cents() == gateway.total_assets().amount_minor
    assert (opening.total_el_cents()
            == gateway.equity_plus_liabilities().amount_minor)
    assert opening.total_assets_cents() - opening.total_el_cents() == 0


@pytest.mark.parametrize("name", BOOKS)
def test_f6_every_served_row_lands_in_exactly_one_forecast_line(name):
    payload = load(name)
    gateway = gateway_for(payload)
    opening = opening_for(payload)
    served_ids = [str(r["id"]) for r in gateway.served_canonical_bs["rows"]]
    placed = []
    for line in opening.lines:
        placed.extend(row_id for row_id, _cents in line.rows)
    assert sorted(placed) == sorted(served_ids)
    assert len(placed) == len(set(placed)), "a row was placed twice"


def test_f6_the_opening_comes_from_canonical_not_the_legacy_assembly():
    """The two assemblies disagree on the agras book by the unclassified
    account-413 balance. This pins WHICH one the projection opens on."""
    payload = load("agras")
    opening = opening_for(payload)
    legacy = cents_from(payload["statements"]["assembled_bs"]["total_assets"])
    gap = _legacy_gap_cents(payload)
    assert gap != 0, "the two assemblies agree on this book; re-pick the gate"
    assert opening.total_assets_cents() != legacy
    assert opening.total_assets_cents() - legacy == gap


def test_f6_plant_a_row_the_gateway_under_reports_and_the_opening_refuses():
    """PLANT: one served row reports a cent less than the totals say. The
    partition must notice and REFUSE, naming the side and the amount."""
    payload = load("agras")
    gateway = gateway_for(payload)
    real_statement_line = gateway.statement_line

    def short_by_one_cent(line_id):
        fact = real_statement_line(line_id)
        if line_id == "ppe_land":
            return type(fact)(fact.amount_minor - 1, fact.currency,
                              fact.provenance)
        return fact

    gateway.statement_line = short_by_one_cent
    with pytest.raises(OpeningPositionError) as excinfo:
        OpeningPosition.from_gateway(gateway, str(payload["period_end"]))
    assert excinfo.value.side == "assets"
    assert excinfo.value.delta_cents == -1
    assert "lost -0.01 on the assets side" in str(excinfo.value)


def test_f6_plant_a_row_in_an_unknown_section_and_the_opening_refuses():
    """PLANT: a served row in a section the model cannot place. Refusing
    is the only honest answer — a guess would move a statement total."""
    import copy
    payload = copy.deepcopy(load("agras"))
    payload["envelope"]["canonical_bs"]["rows"].append({
        "id": "some_new_row", "section": "quasi_equity",
        "label": "Quasi-equity", "amount": 1000.0, "leaf_ids": [],
    })
    gateway = gateway_for(payload)
    with pytest.raises(OpeningPositionError) as excinfo:
        OpeningPosition.from_gateway(gateway, str(payload["period_end"]))
    message = str(excinfo.value)
    assert "some_new_row" in message and "quasi_equity" in message
    assert "Refusing" in message


def test_f6_a_serving_with_no_balance_sheet_is_refused_not_defaulted():
    class NoStatement(object):
        tier = "methodology"
        served_canonical_bs = None

    with pytest.raises(OpeningPositionError) as excinfo:
        OpeningPosition.from_gateway(NoStatement(), "2025-12-31")
    assert "nothing" not in str(excinfo.value).lower() or True
    assert "canonical balance sheet" in str(excinfo.value)


# ──────────────────────────────────────────────────────────────────────
# F6 — PERIOD ZERO IS HELD TO THE SAME EXACT-ZERO LAW AS EVERY
#      PROJECTED PERIOD
#
# WHAT THESE TWO GATES RED ON, stated after the repair (TC-11):
#
#   * a source period whose served balance sheet does not close being
#     ACCEPTED as an opening position — the shape in which the gap is
#     carried, unchanged, into every projected period and surfaces one
#     period later as a `BalanceViolation` naming a PROJECTED period for
#     a defect that was already there at period zero;
#   * that same source reaching `project_payload` and coming back as a
#     `BalanceViolation` instead of an `OpeningPositionError` — the
#     mis-attribution itself, which is what cost the reading time.
#
# They do NOT red on a wide account-121 gap: all four committed books
# carry one (agras 6,572,426.01; realestate 29,589,814.24) and all four
# close to 0.00, because account 121 is a ledger row and the sheet's own
# residual IS its closing balance. The anchor is what makes them close.
# ──────────────────────────────────────────────────────────────────────


def _serve_the_reconstruction_as_the_result(payload):
    """PLANT: serve the class-6/7 RECONSTRUCTION as the current-year
    result instead of account 121 — precisely the statement the engine
    emitted for any book inside the old 5% anchor band, before the anchor
    became unconditional (`chart_of_accounts.py`, 2026-09-09).

    Returns (planted payload, the step in cents). Nothing else is
    touched, so the difference the gateway then reports IS the anchor
    step and cannot be anything else.
    """
    import copy as _copy
    planted = _copy.deepcopy(payload)
    pl = planted["statements"]["assembled_pl"]
    step = (cents_from(pl["net_income_operational"])
            - cents_from(pl["net_income_statutory"]))
    assert step != 0, (
        "this book's reconstruction already equals its filed balance, so "
        "the plant would change nothing — re-pick the book")
    cbs = planted["envelope"]["canonical_bs"]
    for row in cbs["rows"]:
        if row.get("id") in ("current_year_profit", "current_year_loss"):
            row["amount"] = round(float(row["amount"] or 0.0) + step / 100.0, 2)
            break
    else:  # pragma: no cover - every committed book carries a result row
        pytest.fail("no current-year result row to plant into")
    totals = cbs["totals"]
    for key in ("equity", "equity_plus_liabilities"):
        totals[key] = round(float(totals[key]) + step / 100.0, 2)
    cbs["difference"] = round(
        float(totals["assets"]) - float(totals["equity_plus_liabilities"]), 2)
    return planted, step


@pytest.mark.parametrize("book", BOOKS)
def test_f6_every_committed_book_opens_on_a_sheet_that_closes(book):
    """The positive law, and the reason the plant below is not vacuous.

    Each of these books' class-6/7 run-down misses the profit it filed
    in account 121 by millions. The served sheet closes anyway — the
    anchored figure is the one the remaining closing balances imply — so
    the opening position starts at exactly zero and has nothing to carry.
    """
    payload = load(book)
    opening = opening_for(payload)
    assert opening.total_assets_cents() - opening.total_el_cents() == 0, (
        "%s opens out by %s" % (book, fmt(opening.total_assets_cents()
                                          - opening.total_el_cents())))
    pl = payload["statements"]["assembled_pl"]
    # plan/2 B4a: retail now reproduces account 121 to the cent (its
    # 609/709 double count is repaired), so on a tying book the anchored
    # figure and the reconstruction coincide and this book says nothing
    # about which one the sheet closes on; the three others still miss 121
    # (agras by the hidden 711 net, carniprod likewise, realestate by
    # 29.6M) and carry the distinction. test_f6_scope_has_a_book_that_does_not_tie
    # keeps the parametrization non-vacuous (TC-3).
    if cents_from(pl["net_income_operational"]) == cents_from(pl["net_income_statutory"]):
        assert cents_from(pl["net_income_unexplained_vs_121"]) == 0, (
            "%s: the two views agree but the book records an unexplained step" % book)
        return
    assert cents_from(pl["net_income_operational"]) != cents_from(
        pl["net_income_statutory"]), (
        "%s: the reconstruction and the filed figure agree on this book, "
        "so it says nothing about which of the two the sheet closes on"
        % (book,))


def test_f6_scope_has_a_book_that_does_not_tie():
    """TC-3 for the test above: at least one committed book must miss its
    filed figure, or 'the sheet closes on the anchored figure' is asserted
    on nothing. Printed per book."""
    differing = []
    for book in BOOKS:
        pl = load(book)["statements"]["assembled_pl"]
        if cents_from(pl["net_income_operational"]) != cents_from(pl["net_income_statutory"]):
            differing.append(book)
    print("books whose reconstruction misses account 121: %s" % ", ".join(differing))
    assert differing, "every committed book ties to 121; the f6 distinction is vacuous"



def test_f6_plant_an_unbalanced_source_sheet_and_the_opening_refuses():
    """PLANT: the pre-anchor statement. The opening must REFUSE, and say
    both how far out the sheet is and which two numbers disagree."""
    payload = load("agras")
    planted, step = _serve_the_reconstruction_as_the_result(payload)
    gateway = gateway_for(planted)
    assert gateway.difference().amount_minor == -step, (
        "the plant did not move the served difference; it is testing "
        "nothing (%s vs %s)" % (fmt(gateway.difference().amount_minor),
                                fmt(-step)))
    try:
        OpeningPosition.from_gateway(gateway, str(planted["period_end"]))
    except OpeningPositionError as err:
        message = str(err)
    else:
        pytest.fail(
            "the source balance sheet is out by %s and the opening took "
            "it anyway. Period zero must be held to the same exact-zero "
            "law every projected period is held to — otherwise this gap "
            "is carried into the plan and re-emerges as a "
            "BalanceViolation blaming the first projected period for it."
            % (fmt(-step),))
    assert "does not balance" in message
    assert fmt(-step) in message, (
        "the refusal must carry the size of the gap: %r" % (message,))
    #: TC-10 — the two disagreeing numbers, rendered from the served
    #: statement rather than described.
    assert fmt(gateway.net_result().amount_minor) in message
    assert fmt(gateway.net_result().amount_minor - step) in message


def test_f6_an_unbalanced_source_is_refused_at_period_zero_not_blamed_on_a_projected_period():
    """The mis-attribution itself. Before the repair this same payload
    produced `BalanceViolation: projected period ... does not balance`,
    which sends the reader after a driver defect that does not exist."""
    payload = load("agras")
    planted, step = _serve_the_reconstruction_as_the_result(payload)
    with pytest.raises(OpeningPositionError) as excinfo:
        project_payload(planted, revolver_rate=_CALLER_REVOLVER_RATE)
    assert not isinstance(excinfo.value, BalanceViolation)
    assert "period zero" in str(excinfo.value)


# ──────────────────────────────────────────────────────────────────────
# F1 — every projected period balances, to the cent
# ──────────────────────────────────────────────────────────────────────

_DRIVER_SETS = (
    {},
    {"revenue_growth": 0.08},
    {"revenue_growth": -0.12, "dividend_payout_pct": 0.9},
    {"revenue_growth": 0.15, "capex_pct_of_revenue": 0.18,
     "dividend_payout_pct": 0.5, "min_cash": 250_000.0},
    {"revenue_growth": 0.03, "tax_rate": 0.16, "interest_income_rate": 0.02,
     "intangible_additions_pct_of_revenue": 0.01},
)


@pytest.mark.parametrize("name", BOOKS)
@pytest.mark.parametrize("monthly_months", (12, 24))
@pytest.mark.parametrize("drivers", _DRIVER_SETS)
def test_f1_every_projected_period_closes_to_zero(name, monthly_months, drivers):
    projection = plan(name, horizon_years=5, monthly_months=monthly_months,
                      **drivers)
    assert projection.periods, "a 5-year projection produced no periods"
    for period in projection.periods:
        delta = period.total_assets_cents() - period.total_el_cents()
        assert delta == 0, (
            "%s %s did not close: %s" % (name, period.label, fmt(delta)))
        assert period.checks["balance_delta_cents"] == 0


@pytest.mark.parametrize("name", BOOKS)
def test_f1_the_cash_flow_statement_articulates_the_balance_sheet(name):
    """The projected cash movement must BE the cash-flow statement — not
    agree with it to a tolerance. This is what makes the balance
    structural rather than plugged."""
    projection = project_payload(load(name), revenue_growth=0.05,
                                 horizon_years=5)
    previous_cash = projection.opening.cents("cash")
    for period in projection.periods:
        assert period.cf["opening_cash"] == previous_cash
        assert (period.cf["closing_cash"]
                == period.cf["opening_cash"] + period.cf["net_change_in_cash"])
        assert (period.cf["net_change_in_cash"]
                == period.cf["cash_from_operating"]
                + period.cf["cash_from_investing"]
                + period.cf["cash_from_financing"])
        assert period.cf["closing_cash"] == period.bs["cash"]
        previous_cash = period.cf["closing_cash"]


@pytest.mark.parametrize("name", BOOKS)
def test_f1_the_roll_forwards_are_the_movements_the_cash_flow_reports(name):
    projection = project_payload(load(name), revenue_growth=0.05,
                                 capex_pct_of_revenue=0.06, horizon_years=3)
    previous = projection.opening.balances()
    for period in projection.periods:
        assert (period.bs["ppe_net"] == previous["ppe_net"]
                - period.cf["capital_expenditure"] - period.cf["depreciation"])
        assert (period.bs["intangibles_net"] == previous["intangibles_net"]
                - period.cf["intangible_additions"] - period.cf["amortisation"])
        assert (period.bs["equity_retained"] == previous["equity_retained"]
                + period.cf["net_income"] + period.cf["dividends_paid"])
        previous = period.bs


def test_f1_plant_the_legacy_opening_and_every_period_reds():
    """PLANT: open the projection on the LEGACY assembly's total instead
    of the canonical one — the exact defect this lane exists to prevent.
    The first projected period must refuse, through F1's own message,
    naming the period and the amount."""
    payload = load("agras")
    gap = _legacy_gap_cents(payload)
    honest = opening_for(payload)
    planted = OpeningPosition(
        lines=tuple(
            OpeningLine(line.line,
                        line.amount_cents - (gap if line.line
                                             == "other_current_assets" else 0),
                        line.rows)
            for line in honest.lines),
        currency=honest.currency, period_end=honest.period_end,
        snapshot_id=honest.snapshot_id, totals=honest.totals)
    assert planted.total_assets_cents() - planted.total_el_cents() == -gap

    with pytest.raises(BalanceViolation) as excinfo:
        project(planted, pl_history_from_payload(payload), total_years=1,
                monthly_months=12, context=context_for(payload))
    violation = excinfo.value
    assert violation.period_label == "2026-01"
    assert violation.delta_cents == -gap
    assert "does not balance" in str(violation)
    assert fmt(-gap) in str(violation)
    assert "must be exactly 0" in str(violation)


def test_f1_one_cent_is_enough_to_red_it():
    """No tolerance band. A single cent refuses the projection."""
    payload = load("agras")
    honest = opening_for(payload)
    planted = OpeningPosition(
        lines=tuple(
            OpeningLine(line.line,
                        line.amount_cents + (1 if line.line == "cash" else 0),
                        line.rows)
            for line in honest.lines),
        currency=honest.currency, period_end=honest.period_end,
        snapshot_id=honest.snapshot_id, totals=honest.totals)
    with pytest.raises(BalanceViolation) as excinfo:
        project(planted, pl_history_from_payload(payload), total_years=1,
                monthly_months=12, context=context_for(payload))
    assert excinfo.value.delta_cents == 1
    assert "0.01" in str(excinfo.value)


def test_f1_the_honest_opening_does_not_red_reverting_the_plant():
    """REVERT: the same book, the same drivers, the canonical opening —
    green. The gate fails on the defect, not on the product."""
    payload = load("agras")
    projection = project(opening_for(payload), pl_history_from_payload(payload),
                         total_years=1, monthly_months=12,
                         context=context_for(payload))
    assert [p.checks["balance_delta_cents"] for p in projection.periods] \
        == [0] * 12


# ──────────────────────────────────────────────────────────────────────
# F8 — cash never silently goes negative
# ──────────────────────────────────────────────────────────────────────

#: A plan the book's own cash cannot carry: build a second plant, keep
#: distributing, and amortise the opening term loan through year one.
_EXPANSION = {
    "revenue_growth": 0.03,
    "capex_pct_of_revenue": 0.22,
    "dividend_payout_pct": 0.70,
    "min_cash": 500_000.0,
}


def _expansion_schedule():
    return DebtSchedule([DebtMove(i, lt_repay=120_000_00) for i in range(12)])


@pytest.mark.parametrize("name", BOOKS)
@pytest.mark.parametrize("drivers", _DRIVER_SETS + (_EXPANSION,))
def test_f8_cash_never_closes_below_the_floor(name, drivers):
    projection = plan(name, horizon_years=5, **drivers)
    floor = projection.assumptions.cents("min_cash")
    for period in projection.periods:
        assert period.bs["cash"] >= floor, (
            "%s %s closed at %s, below the floor of %s"
            % (name, period.label, fmt(period.bs["cash"]), fmt(floor)))
        assert period.bs["cash"] >= 0
        assert period.checks["cash_went_negative"] is False
        assert period.as_dict()["checks"]["cash_went_negative"] is False


def test_f8_the_funding_line_appears_named_and_priced():
    projection = project_payload(load("agras"), horizon_years=5,
                                 debt_schedule=_expansion_schedule(),
                                 **_EXPANSION)
    drawn = projection.funding_periods()
    assert drawn, "this driver set was chosen to exhaust cash and did not"
    assert "revolver" in EL_LINES, "the funding line must be a named BS line"
    first = drawn[0]
    # It draws EXACTLY the shortfall, and lands exactly on the floor.
    floor = projection.assumptions.cents("min_cash")
    cash_before = (first.cf["opening_cash"] + first.cf["net_change_in_cash"]
                   - first.cf["funding_line_movement"])
    assert first.checks["funding_line_draw_cents"] == floor - cash_before
    assert first.bs["cash"] == floor
    assert first.bs["revolver"] > 0
    # And it is priced from the period after it is drawn.
    later = projection.periods[first.period.index + 1]
    assert later.pl["interest_expense_funding_line"] < 0
    assert projection.peak_funding_cents() > 0


def test_f8_the_funding_line_is_repaid_when_the_cash_comes_back():
    """A gap that closes must close the line too — otherwise the plan
    reports borrowing the company no longer needs."""
    payload = load("agras")
    opening = opening_for(payload)
    # A BULLET MATURITY in the first month: the whole opening debt falls
    # due at once. A profitable company still cannot pay it out of one
    # month's cash, so the line draws — and then, as the following months
    # generate cash, it is repaid. A permanent overspend would never
    # exercise the repayment branch, which is the branch under test.
    schedule = DebtSchedule([DebtMove(
        0, st_repay=opening.cents("st_debt"), lt_repay=opening.cents("lt_debt"))])
    projection = project_payload(payload, horizon_years=1,
                                 revenue_growth=0.0,
                                 min_cash=500_000.0,
                                 debt_schedule=schedule)
    balances = [p.bs["revolver"] for p in projection.periods]
    assert max(balances) > 0, "no gap was opened by this driver set"
    repaid = [p for p in projection.periods
              if p.checks["funding_line_repay_cents"] > 0]
    assert repaid, "the line was never repaid: %s" % (balances,)
    # ...and once repaid it is GONE, not left standing on the statement.
    assert balances[-1] == 0, balances
    assert projection.periods[-1].pl["interest_expense_funding_line"] == 0


def test_f8_a_negative_cash_floor_is_refused_not_honoured():
    with pytest.raises(AssumptionError) as excinfo:
        project_payload(load("agras"), min_cash=-100.0, horizon_years=1)
    assert "min_cash" in str(excinfo.value)


# ──────────────────────────────────────────────────────────────────────
# F3 — determinism
# ──────────────────────────────────────────────────────────────────────

_DETERMINISM_SCRIPT = """
import json, sys
sys.path.insert(0, %(src)r)
from engine.forecast import project_payload
payload = json.load(open(%(book)r))
projection = project_payload(payload, revenue_growth=0.08,
                             capex_pct_of_revenue=0.11,
                             dividend_payout_pct=0.4, min_cash=750000.0,
                             horizon_years=5)
sys.stdout.write(json.dumps(projection.as_dict(), sort_keys=False))
"""


def test_f3_the_same_assumptions_produce_byte_identical_output():
    """Five separate processes, five different PYTHONHASHSEEDs. A
    ``hash()``, a ``set`` iteration order or a clock reaching output
    would show up as a differing byte."""
    script = _DETERMINISM_SCRIPT % {
        "src": str(REPO / "src"),
        "book": str(FIRM / "saga_10_col_agras.json"),
    }
    outputs = []
    for seed in range(5):
        env = dict(os.environ)
        env["PYTHONHASHSEED"] = str(seed)
        env["ENGINE_ACCESS_LOG"] = "0"
        result = subprocess.run([sys.executable, "-c", script], env=env,
                                capture_output=True, timeout=120)
        assert result.returncode == 0, result.stderr.decode("utf-8")[-2000:]
        outputs.append(result.stdout)
    assert len(set(outputs)) == 1, (
        "the projection is not deterministic across processes: %d distinct "
        "outputs from 5 runs" % len(set(outputs)))
    assert len(outputs[0]) > 5000, "the compared payload was suspiciously thin"


def test_f3_no_clock_is_read_and_the_calendar_comes_from_the_book():
    projection = project_payload(load("agras"), horizon_years=3)
    assert projection.opening.period_end == "2025-12-31"
    months_2026 = ["2026-%02d" % m for m in range(1, 13)]
    assert [p.label for p in projection.periods] == months_2026 + [
        "FY2027", "FY2028"]
    wide = plan("agras", horizon_years=3, monthly_months=24)
    assert [p.label for p in wide.periods] == months_2026 + [
        "2027-%02d" % m for m in range(1, 13)] + ["FY2028"]
    # year_offset keys the plan year, never the granularity (contract 6.1)
    assert [p.period.year_offset for p in wide.periods] \
        == [1] * 12 + [2] * 12 + [3]
    # AST, not grep: this file's own prose says the words "hash()" and
    # "clock", and a substring scan that reds on a docstring is a gate
    # that reds on the explanation of the rule it enforces.
    for path, tree in _forecast_sources():
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if isinstance(func, ast.Name):
                assert func.id != "hash", "%s calls hash()" % path.name
            elif isinstance(func, ast.Attribute):
                assert func.attr not in ("now", "today", "utcnow", "time",
                                         "monotonic"), (
                    "%s calls %s() — a clock" % (path.name, func.attr))


# ──────────────────────────────────────────────────────────────────────
# assumptions — FACT vs ASSUMPTION, and ABSENT != ZERO
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", BOOKS)
def test_every_driver_states_where_it_came_from(name):
    payload = load(name)
    assumptions = derive_assumptions(opening_for(payload),
                                     pl_history_from_payload(payload),
                                     context=context_for(payload))
    for item in assumptions.items():
        assert item.source in ("derived", "caller", "engine_default",
                              "unavailable"), item.key
        assert item.basis.strip(), "%s has no stated basis" % item.key
        # plan/2 B3 (contract 3.4): and its tier, set at the put() site
        assert item.tier in ("book", "sector", "macro", "user",
                             "convention", "absent"), item.key


def test_growth_is_never_derived_from_a_single_period_book():
    """RETIRED AND REWRITTEN (plan/2 B3, contract R1/3.4). This asserted
    ``source == "engine_default"`` and ``exact == 0``: a silent zero, which
    R1 rules out. A one-period book still measures no growth — the book
    rung is absent and says why — and the ladder now takes the macro
    anchor on a Romanian book and the convention rung where no anchor is
    packed for the book's jurisdiction, each with its rungs recorded."""
    from engine.forecast.levers_pack import macro_pack, terminal_rung
    payload = load("agras")
    assumptions = derive_assumptions(opening_for(payload),
                                     pl_history_from_payload(payload),
                                     context=context_for(payload))
    growth = assumptions["revenue_growth"]
    anchor = macro_pack().anchors["inflation"]
    assert context_for(payload).jurisdiction == "RO"
    assert growth.tier == "macro"
    assert growth.exact == int(anchor.value * 1_000_000)
    assert growth.evidence["series_id"] == anchor.series_id
    steps = [(s["tier"], s["outcome"]) for s in growth.fallback_steps]
    assert steps == [("book", "absent"), ("sector", "absent")]
    # no recorded jurisdiction: the convention rung, never a silent zero
    silent = derive_assumptions(opening_for(payload),
                                pl_history_from_payload(payload))
    rung = terminal_rung("revenue_growth")
    assert silent["revenue_growth"].tier == "convention"
    assert silent["revenue_growth"].rule_id == rung.rule_id
    assert silent["revenue_growth"].basis == rung.sentence
    assert [s["tier"] for s in silent["revenue_growth"].fallback_steps] \
        == ["book", "sector", "macro"]


def test_the_dividend_policy_is_not_read_back_out_of_the_engines_own_guess():
    """``assembled_cf.dividends_paid`` is exactly half of net profit on
    this book — the cash-flow assembly's own approximation, not a fact.
    Deriving a payout ratio from it would launder a guess into history."""
    payload = load("agras")
    guessed = cents_from(payload["statements"]["assembled_cf"]["dividends_paid"])
    profit = cents_from(payload["statements"]["assembled_cf"]["net_profit"])
    assert guessed * 2 == -profit, "the approximation changed; re-check"
    assumptions = derive_assumptions(opening_for(payload),
                                     pl_history_from_payload(payload),
                                     context=context_for(payload))
    payout = assumptions["dividend_payout_pct"]
    # RETIRED AND REWRITTEN (plan/2 B3, 3.4): the engine_default 0 is now
    # the convention terminal rung, with the book rung recorded absent.
    from engine.forecast.levers_pack import (dividend_book_rung_absent,
                                             terminal_rung)
    assert payout.source == "engine_default"
    assert payout.tier == "convention"
    assert payout.rule_id == terminal_rung("dividend_payout_pct").rule_id
    assert payout.exact == 0
    assert payout.fallback_steps[0]["tier"] == "book"
    assert payout.fallback_steps[0]["reason"] == dividend_book_rung_absent()


def test_a_book_with_no_cost_of_sales_holds_inventory_instead_of_zeroing_it():
    """ABSENT != ZERO, applied to a driver. The realestate book reports no
    cost of sales, so days-inventory cannot be measured. A DIO of 0 would
    liquidate 67.8m of inventory in the first period and print the cash."""
    payload = load("realestate")
    opening = opening_for(payload)
    assumptions = derive_assumptions(opening, pl_history_from_payload(payload),
                                     context=context_for(payload))
    assert pl_history_from_payload(payload).cogs == 0
    assert assumptions["dio_cogs_days"].source == "unavailable"
    assert assumptions["dio_cogs_days"].exact is None
    assert "HELD" in assumptions["dio_cogs_days"].basis

    projection = project_payload(payload, horizon_years=3)
    held = opening.cents("inventory")
    assert held > 0
    for period in projection.periods:
        assert period.bs["inventory"] == held


def test_an_override_never_inherits_a_derivations_pedigree():
    payload = load("agras")
    assumptions = derive_assumptions(opening_for(payload),
                                     pl_history_from_payload(payload),
                                     context=context_for(payload))
    assert assumptions["dso_days"].source == "derived"
    overridden = assumptions.with_overrides(dso_days=90)
    assert overridden["dso_days"].source == "caller"
    assert overridden["dso_days"].exact == 90 * MICRO_DAY  # micro-days
    assert overridden["dso_days"].value() == 90.0
    assert assumptions["dso_days"].exact != 90 * MICRO_DAY  # original intact


def test_an_unknown_driver_is_refused_rather_than_ignored():
    payload = load("agras")
    with pytest.raises(AssumptionError) as excinfo:
        project_payload(payload, revenu_growth=0.08)  # typo on purpose
    assert "revenu_growth" in str(excinfo.value)


def test_the_serving_contracts_units_are_the_ones_this_model_emits():
    """The fp1 bridge is only useful if it fits. Asserted against the real
    contract so a change on either side reds here rather than in prod."""
    from engine.forecast_serving.contract import UNITS
    from engine.forecast.assumptions import Assumption
    assert set(Assumption.FP1_UNITS.values()) <= set(UNITS)
    projection = project_payload(load("agras"), horizon_years=2)
    shaped = projection.fp1_assumptions()
    assert shaped
    labels = {p.label for p in projection.periods}
    for driver in shaped:
        assert driver["unit"] in UNITS
        assert driver["id"] and driver["basis"].strip()
        assert set(driver["values"]) == labels


# ──────────────────────────────────────────────────────────────────────
# the shape wave 2 reads
# ──────────────────────────────────────────────────────────────────────


def test_the_projection_serializes_to_a_json_round_trippable_shape():
    projection = plan("agras", horizon_years=3, monthly_months=24)
    payload = projection.as_dict()
    assert json.loads(json.dumps(payload)) == payload
    assert payload["summary"]["balances_every_period"] is True
    assert payload["summary"]["period_count"] == len(projection.periods)
    assert [p["period"]["label"] for p in payload["periods"]] \
        == payload["summary"]["labels"]


def test_the_cents_and_units_vocabularies_never_share_a_name():
    """In memory the checks are integer cents and every money key says so
    in its name; serialized they are currency units under the name
    without the suffix. A key that means cents in one place and units in
    the other, under ONE name, is how a wrong figure gets rendered
    confidently — so the two vocabularies are asserted disjoint."""
    from engine.forecast.project import CHECK_KEYS
    projection = project_payload(load("agras"), horizon_years=1,
                                 min_cash=100.0)
    period = projection.periods[0]
    assert set(period.checks) == set(CHECK_KEYS)
    served = period.as_dict()["checks"]
    assert set(served).isdisjoint(
        k for k in CHECK_KEYS if k.endswith("_cents"))
    for key in CHECK_KEYS:
        if not key.endswith("_cents"):
            continue
        assert isinstance(period.checks[key], int)
        assert served[key[:-len("_cents")]] == period.checks[key] / 100.0


def test_the_projected_series_are_one_value_per_period_per_line():
    projection = project_payload(load("agras"), horizon_years=5)
    series = projection.series()
    count = len(projection.periods)
    for key, values in series.items():
        assert len(values) == count, key
    for line in LINES:
        assert ("bs." + line) in series
    assert "bs.revolver" in series and "cf.funding_line_movement" in series


def test_the_models_own_conventions_are_stated_on_every_projection():
    """A convention a reader has to reverse-engineer from the arithmetic
    is a convention that is not disclosed. Each one must reach the face
    of the plan, not just this module's docstring."""
    from engine.forecast.levers_pack import tax_conventions
    from engine.forecast.project import MODEL_CONVENTIONS
    projection = project_payload(load("agras"), horizon_years=1)
    notes = projection.as_dict()["notes"]
    for convention in MODEL_CONVENTIONS:
        assert any(convention in note for note in notes), convention
    # the tax conventions are the pack's (levers.yaml#tax), served under
    # their renamed ids beside the figures they produce, with the same
    # sentence on the face of the plan
    served = dict((a["id"], a["basis"]) for a in projection.fp1_assumptions())
    ids = [c.convention_id for c in tax_conventions()]
    assert ids == ["tax_accrued_year_to_date", "tax_no_loss_carry_forward"]
    assert "tax_charged_when_it_arises" not in served
    for convention in tax_conventions():
        assert convention.sentence in served[convention.convention_id]
        assert convention.sentence in MODEL_CONVENTIONS
        assert convention.convention_id in projection.as_dict()[
            "line_assumptions"]["pl.income_tax"]
    # ...and the tax convention is not merely claimed: the tax payable
    # balance really is held, so the claim and the arithmetic agree.
    held = projection.opening.cents("other_current_liabilities")
    assert projection.periods[0].bs["other_current_liabilities"] == held
    assert projection.periods[0].pl["income_tax"] < 0


def test_no_model_authors_a_projected_number():
    """There is no AI in this package, and no path by which one could
    reach a figure. Asserted structurally, not promised in prose."""
    for path, tree in _forecast_sources():
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            for name in names:
                root = name.split(".")[0]
                assert root not in ("anthropic", "openai", "requests", "httpx",
                                    "urllib", "socket", "http"), (
                    "%s imports %s" % (path.name, name))


# ──────────────────────────────────────────────────────────────────────
# LP1 — THE PROJECTED P&L CARRIES EVERY NAMED INCOME THE BOOK CARRIES
#
# What this reds on AFTER the repair (TC-11): a named P&L figure the
# payload carries that no projected line consumes. It reds through the
# per-book difference between the book's own result and the model's, so
# a line dropped from `history.py`, from the driver set, or from the
# roll-forward is caught wherever it is dropped. It does NOT judge
# whether holding a financial item flat is the right ECONOMICS — that is
# a stated convention, pinned separately by the conventions gate below.
# ──────────────────────────────────────────────────────────────────────


def _book_pl(name):
    return load(name)["statements"]["assembled_pl"]


def _year_one(projection, line):
    return sum(p.pl[line] for p in projection.periods
               if p.period.year_offset == 1)


def resolution_bound(*bases_and_steps, **kw):
    """The most the model's OWN resolution can move a figure.

    Every derived rate is stored to one part in ``MICRO``, so applying it
    to a base can be off by half a micro-unit of that base; a day count
    is stored to one part in ``MICRO_DAY`` and behaves identically; and
    each period rounds once more, to the cent. The bound is therefore
    computed from the bases and the step count — TC-10, a tolerance
    rendered from the same resolution the model used, never a constant
    chosen until a test went green.
    """
    periods = kw.pop("periods", 0)
    assert not kw, kw
    total = periods
    for base_cents, steps in bases_and_steps:
        total += steps * (abs(base_cents) // (2 * MICRO_DAY) + 1)
    return total


@pytest.mark.parametrize("name", BOOKS)
def test_at_zero_growth_the_plans_first_year_reproduces_the_books_own_ebitda(name):
    """"Same as last year" must actually mean it. At 0% growth the model
    re-earns the book's own EBITDA, which it cannot do while an operating
    income line the same statement names is missing from the P&L."""
    book = _book_pl(name)
    # plan/2 B3: base growth is the macro anchor on these RO books (R1), so
    # "at zero growth" is now a stated override, not the default.
    # plan/2 B4b (contract 5.3, rewritten as it names): with revenue growth
    # AND inflation overridden to 0 and no shocks, the cost pools reproduce
    # the anchor's own costs and the held other operating income its own
    # amount — so plan year one re-earns the book's EBITDA TO THE CENT, no
    # share-of-revenue rounding left to tolerate.
    projection = plan(name, horizon_years=1, revenue_growth=0, inflation=0)
    modelled = _year_one(projection, "ebitda")
    reported = cents_from(book["ebitda"])
    allowed = 0
    assert abs(modelled - reported) <= allowed, (
        "%s: model EBITDA %s vs the book's own %s, short by %s — the "
        "book names other operating income of %s"
        % (name, fmt(modelled), fmt(reported), fmt(reported - modelled),
           fmt(cents_from(book["other_operating_income"]))))


@pytest.mark.parametrize("name", BOOKS)
def test_at_zero_growth_the_plans_first_year_reproduces_the_books_pretax_result(name):
    """The whole P&L, not just EBITDA. The ONE figure the model may add
    that the book never had is its own funding-line charge — a cost of
    the plan, not of the history — so it is added back explicitly rather
    than absorbed into a tolerance."""
    book = _book_pl(name)
    # plan/2 B4b (5.3): growth and inflation at 0 — the operating lines are
    # exact; only the two balance-priced rates below still round.
    projection = plan(name, horizon_years=1, revenue_growth=0, inflation=0)
    modelled = _year_one(projection, "pretax_result")
    funding_charge = -_year_one(projection, "interest_expense_funding_line")
    reported = cents_from(book["pretax"])
    opening = projection.opening
    allowed = resolution_bound(
        # capex (the one remaining share of revenue on the operating side)
        (cents_from(book["revenue"]), 1),
        # the depreciation rate, against the net book value it is charged on
        (opening.cents("ppe_net") + opening.cents("intangibles_net"), 1),
        # the borrowing rate, against the debt it is charged on
        (opening.cents("st_debt") + opening.cents("lt_debt"), 1),
        periods=len(projection.periods))
    assert abs((modelled + funding_charge) - reported) <= allowed, (
        "%s: model pre-tax %s (+ funding-line charge %s) vs the book's own "
        "%s. Unmodelled: other operating income %s, financial income %s, "
        "financial expense %s"
        % (name, fmt(modelled), fmt(funding_charge), fmt(reported),
           fmt(cents_from(book["other_operating_income"])),
           fmt(cents_from(book["financial_income"])),
           fmt(cents_from(book["financial_expense_total"]))))


@pytest.mark.parametrize("name", BOOKS)
def test_every_named_income_the_payload_carries_reaches_a_projected_line(name):
    """The producer side of the same rule, read off the payload itself:
    a figure `history.py` declines to look at is a figure the plan drops
    in silence."""
    book = _book_pl(name)
    history = pl_history_from_payload(load(name))
    assert history.other_operating_income == cents_from(
        book["other_operating_income"])
    assert history.financial_income == cents_from(book["financial_income"])
    assert history.financial_expense_total == cents_from(
        book["financial_expense_total"])
    # and each one owns a driver whose basis names where it came from
    projection = plan(name, horizon_years=1)
    for key, field in (
            ("other_operating_income_annual",
             "assembled_pl.other_operating_income"),
            ("other_financial_income_annual", "assembled_pl.financial_income"),
            ("other_financial_expense_annual",
             "assembled_pl.financial_expense_total")):
        driver = projection.assumptions[key]
        assert driver.source == "derived", "%s: %s" % (name, key)
        assert field in driver.derived_from, "%s: %s" % (name, key)


def test_the_held_financial_lines_are_held_and_not_grown():
    """They are HELD, which is a claim about arithmetic. Growing revenue
    50% must move nothing on those two lines."""
    flat = plan("agras", horizon_years=3)
    grown = plan("agras", horizon_years=3, revenue_growth=0.50)
    assert grown.periods[0].pl["revenue"] > flat.periods[0].pl["revenue"]
    for line in ("other_financial_income", "other_financial_expense",
                 "interest_income"):
        assert ([p.pl[line] for p in flat.periods]
                == [p.pl[line] for p in grown.periods]), line
    # and each year repeats the source period's own annual amount
    book = _book_pl("agras")
    carried = (cents_from(book["financial_income"])
               - cents_from(book["interest_income"]))
    for year in (1, 2, 3):
        assert plan_year_total(flat, "pl", "other_financial_income",
                               year) == carried


def test_interest_income_is_carried_or_priced_but_never_both_and_never_neither():
    """One concept, one value. The book's own interest income is carried
    when no rate is available, and REPLACED — not supplemented — when a
    caller supplies one."""
    book = _book_pl("agras")
    carried = plan("agras", horizon_years=1)
    assert carried.assumptions["interest_income_rate"].source == "unavailable"
    assert (plan_year_total(carried, "pl", "interest_income", 1)
            == cents_from(book["interest_income"]))

    priced = plan("agras", horizon_years=1, interest_income_rate=0.02)
    assert priced.assumptions["interest_income_rate"].source == "caller"
    opening_cash = priced.opening.cents("cash")
    first = priced.periods[0]
    assert first.pl["interest_income"] == mul_div(
        apply_rate(opening_cash, micros_from(0.02)), first.period.days,
        priced.assumptions.count("days_basis"))
    assert (priced.periods[0].pl["interest_income"]
            != carried.periods[0].pl["interest_income"])


def test_the_rate_a_closing_cash_balance_would_have_implied_is_shown_not_spent():
    """TC-10: the number that justifies the refusal is rendered from the
    same integers, not retyped. agras' closing cash implies a rate on
    cash that no reader would accept, and the driver says what it is."""
    projection = plan("agras", horizon_years=1)
    driver = projection.assumptions["interest_income_rate"]
    implied = mul_div(cents_from(_book_pl("agras")["interest_income"]),
                      1_000_000, projection.opening.cents("cash"))
    assert driver.source == "unavailable"
    assert ("%.4f%%" % (implied / 10_000.0)) in driver.basis
    assert driver.exact is None


# ──────────────────────────────────────────────────────────────────────
# LP2 — A TAX RATE IS `derived` ONLY WHEN IT REPRODUCES THE PROFIT THIS
#       BOOK FILED IN ACCOUNT 121
#
# The book states its profit twice: as the build-up this model reads
# (pre-tax less income tax) and as the legal figure closed into account
# 121. An effective rate is a claim about the COMPANY, so it is a
# MEASUREMENT only when spending it on the book's own pre-tax result
# reproduces the book's own net income. When it does not, both halves of
# the ratio sit inside a build-up the same payload declares unexplained,
# and `derived` — the strongest word in the closed vocabulary — would be
# stamped on a rate measured ACROSS the gap.
#
# Reds on a tax rate stamped `derived` while the reconstruction leaves an
# unattributable difference against account 121, on a demotion whose
# basis does not carry the gap and the rate it displaces as numbers, and
# on a plan the model itself forecasts into profit being charged nothing.
# It does NOT check that 16% is the right statutory rate for the year, it
# does not attribute the gap to tax (nothing here charges the implied
# 51.6379% agras would give), and it does not implement Romanian loss
# carry-forward.
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", BOOKS)
def test_the_gap_the_model_measures_is_the_engines_own_unexplained_step(name):
    """ONE CONCEPT, ONE VALUE, across two producers.

    The model recomputes the distance to account 121 from the four
    figures it already spends rather than reading the engine's own
    field, so it carries a single authority for it. That is only
    defensible while the two agree to the cent, on every book.
    """
    payload = load(name)
    pl = payload["statements"]["assembled_pl"]
    history = pl_history_from_payload(payload)
    assert history.unexplained_vs_filed() == cents_from(
        pl["net_income_unexplained_vs_121"]), (
            "the model's own gap and assembled_pl's differ — two "
            "authorities for one number")
    # and the nameable half of the bridge is where the engine says it is
    assert (cents_from(pl["net_income_reconciliation_to_121"])
            - cents_from(pl["capitalized_own_work_memo"])
            == history.unexplained_vs_filed())


@pytest.mark.parametrize("name", BOOKS)
def test_a_tax_rate_is_derived_only_when_it_reproduces_the_filed_profit(name):
    book = _book_pl(name)
    history = pl_history_from_payload(load(name))
    driver = plan(name, horizon_years=1).assumptions["tax_rate"]
    charged = cents_from(book["income_tax"])
    pretax = cents_from(book["pretax"])
    gap = history.unexplained_vs_filed()
    if driver.source == "derived":
        assert pretax > 0
        assert gap == 0, (
            "%s: the rate is stamped 'derived' while %s of this book's "
            "profit is unattributable against account 121" % (name, fmt(gap)))
        assert driver.exact == mul_div(charged, 1_000_000, pretax)
        assert cents_from(book["net_income_statutory"]) == pretax - charged
    else:
        assert driver.source == "engine_default"
        assert driver.exact == micros_from(0.16)
        # plan/2 B4 repair (B4V-6): a third stated reason — the book ties
        # but files no profit-tax row, so its 0.00 charge is absent.
        no_charge_row = (charged == 0 and not any(
            r.get("bucket") == "taxExpense" for r in load(name)["line_items"]))
        assert pretax <= 0 or gap != 0 or no_charge_row, (
            "%s: the rate was defaulted on a book that reproduces its own "
            "filed profit and books a tax charge — nothing here justifies "
            "displacing a measurement" % (name,))
        assert not driver.derived_from, "nothing was measured, so nothing is cited"


@pytest.mark.parametrize("name", ("agras", "carniprod"))
def test_the_demotion_states_the_gap_and_the_rate_it_displaces(name):
    """TC-10: both numbers in the sentence are rendered from the same
    integers the decision used, never retyped.

    RESTATED (plan/2 B4a): retail left this parametrization — it now ties
    to account 121 (the 2,043,254.64 step was its 609/709 double count) and
    is no longer demoted; its measured nil is covered by
    test_the_rate_is_measured_only_when_the_book_ties_and_defaulted_otherwise
    above; since the B4 repair it takes the statutory rung for a stated
    reason (test_a_tying_book_with_no_profit_tax_row_takes_the_statutory_rung)."""
    history = pl_history_from_payload(load(name))
    driver = plan(name, horizon_years=1).assumptions["tax_rate"]
    assert driver.source == "engine_default"
    assert fmt(history.unexplained_vs_filed()) in driver.basis
    assert fmt(history.net_income) in driver.basis
    implied = mul_div(history.income_tax, 1_000_000, history.pretax)
    assert ("%.4f%%" % (implied / 10_000.0)) in driver.basis


@pytest.mark.parametrize("name", ("agras", "carniprod"))
def test_the_unreconciled_rate_would_have_charged_a_different_tax(name):
    """The CONSEQUENCE, measured on the real book rather than argued.

    The rate the previous behaviour derived is supplied here as a caller
    override — the only way to spend it now — and the plan it produces is
    charged a DIFFERENT tax over the five years, in the direction the
    unattributed rate points: below the statutory rate it under-charges,
    above it it over-charges. RESTATED (plan/2 B4a): before the 609/709
    repair both books' pre-tax results were overstated, so the implied
    rate sat below 16% and this test read "strictly less"; read correctly
    the implied rates sit above 16% and the same unattributed figure would
    over-charge. Either way it is not a measurement, which is why it may
    not wear the word `derived`. The direction is printed from the
    integers, never assumed.
    """
    history = pl_history_from_payload(load(name))
    implied = mul_div(history.income_tax, 1_000_000, history.pretax)
    default = plan(name, horizon_years=5)
    previous = plan(name, horizon_years=5, tax_rate=implied / 1_000_000.0)
    assert default.assumptions["tax_rate"].exact == micros_from(0.16)
    assert previous.assumptions["tax_rate"].source == "caller"
    charged_now = sum(-p.pl["income_tax"] for p in default.periods)
    charged_before = sum(-p.pl["income_tax"] for p in previous.periods)
    print("%s: implied rate %.4f%% vs statutory 16.0000%%; charged %s (unattributed) vs %s (statutory)"
          % (name, implied / 10_000.0, fmt(charged_before), fmt(charged_now)))
    assert charged_before != charged_now
    if implied < micros_from(0.16):
        assert charged_before < charged_now
    else:
        assert charged_before > charged_now
    assert sum(p.pl["pretax_result"] for p in default.periods) > 0


def test_a_nil_charge_on_a_book_that_reconciles_is_a_measured_zero():
    """CONSTRUCTED, and labelled as such: no committed book ties to account
    121 with a profit-tax row closing at nil (retail ties since
    tb_parser_v6, but files NO class-69 row — an absent charge, see
    test_a_tying_book_with_no_profit_tax_row_takes_the_statutory_rung),
    so this is the only way to exercise the `derived` branch. The
    construction therefore also files its nil charge: one profit-tax row
    (class 69, a `taxExpense` line item) closing at 0.00, which is what makes
    the 0.00 a MEASUREMENT. The two controls below take that row away —
    none filed, and no rows supplied at all (B4RV-3) — and the 0.00
    becomes an absent charge the statutory rate stands in for.

    The history is the real retail book's, with the ONE field the rule
    turns on moved — net income set to what the reconstruction produces —
    so the build-up reaches the filed figure. A nil charge is then a
    MEASURED nil, and reading it as an absence would be the mirror of
    reading an absence as zero. Reds if `tax > 0` is ever restored as the
    condition: the previous repair's own justification was this gap, and
    a proxy for it let every book with a non-nil charge through.
    """
    payload = load("retail")
    opening = opening_for(payload)
    real = pl_history_from_payload(payload)
    assert real.income_tax == 0 and real.pretax > 0
    reconciling = pl_history_from_payload(payload)
    # ⚠ THE FILED BALANCE, NOT `net_income`.
    #
    # This set `reconciling.net_income = real.pretax - real.income_tax`,
    # which made the book "reconcile" by construction against the very
    # field that was the defect: `net_income_statutory` is only the FILED
    # figure when the assembly's anchor override fired. Retail's real
    # filed balance is 3,205,212.62 and its actual distance from the
    # build-up is 2,043,254.64 — so this constructed a book that does not
    # reconcile and asserted that it does.
    #
    # It is byte-for-byte the construction lane G found and repaired in
    # `_retail_that_ties()` in the twin file, left standing here; a
    # verifier predicted it would report the repair above as a regression.
    # A book that ties is one whose FILED balance equals its build-up.
    reconciling.filed_net_income_121 = real.pretax - real.income_tax
    assert reconciling.unexplained_vs_filed() == 0
    # RESTATED (plan/2 B4 repair, B4V-6): the nil is MEASURED when a
    # profit-tax row stands behind it. Retail files none, so one closing at
    # 0.00 is added to the constructed book; without it the charge is
    # absent (test_a_tying_book_with_no_profit_tax_row_takes_the_statutory_rung).
    payload["line_items"].append({"statement": "pl", "bucket": "taxExpense",
                                  "ro_account_code": "691", "amount": 0.0})
    driver = derive_assumptions(opening, reconciling,
                                context=context_for(payload))["tax_rate"]
    assert driver.source == "derived"
    assert driver.exact == 0
    # CONTROLS, the same construction without that row. Each reds if the
    # row count stops mattering, i.e. if an empty bucket's 0.00 is spent
    # as a measured nil and a profitable plan is taxed at nothing. The
    # count is BookContext's (the one the model reads), never a second one.
    no_row = dict(payload)
    no_row["line_items"] = [r for r in payload["line_items"]
                            if r.get("bucket") != "taxExpense"
                            and not str(r.get("ro_account_code") or "").startswith("69")]
    no_rows_at_all = dict(payload)
    no_rows_at_all.pop("line_items")
    for bare, rows, says in ((no_row, 0, "carries no profit-tax row"),
                             (no_rows_at_all, None,
                              "statement rows were not supplied")):
        ctx = context_for(bare)
        assert ctx.tax_charge_rows == rows, (rows, ctx.tax_charge_rows)
        absent = derive_assumptions(opening, reconciling, context=ctx)["tax_rate"]
        assert absent.source == "engine_default", (rows, absent.source)
        assert absent.exact == micros_from(0.16), (rows, absent.exact)
        assert says in absent.basis, (rows, absent.basis)
        assert fmt(reconciling.pretax) in absent.basis
        assert fmt(reconciling.filed_net_income_121) in absent.basis
        assert not absent.derived_from
    assert "carry-forward" in driver.basis, (
        "a measured 0% rate must say that no loss carry-forward is "
        "modelled either way, or the reader cannot see what it costs")


def test_the_history_counts_the_profit_tax_rows_the_statement_files():
    """The input the absent-charge rule turns on, read off the committed
    books' own line items rather than asserted: agras and carniprod file a
    class-69 profit-tax row, retail and realestate file none. With the
    rows taken out of the payload the count is None — nothing to count is
    not zero rows — and the rule reads that as absent too (B4RV-3).
    Printed per book."""
    counts = {}
    for name in BOOKS:
        payload = load(name)
        items = payload["line_items"]
        expected = sum(1 for r in items if str(r.get("bucket") or "") == "taxExpense"
                       or str(r.get("ro_account_code") or "").startswith("69"))
        counts[name] = context_for(payload).tax_charge_rows
        assert counts[name] == expected, (name, counts[name], expected)
        bare = dict(payload)
        bare.pop("line_items")
        assert context_for(bare).tax_charge_rows is None, name
    print("profit-tax rows filed: %s" % counts)
    assert any(counts.values()) and not all(counts.values()), (
        "the committed books must include both a book that files a "
        "profit-tax row and one that files none, or this is vacuous", counts)
    assert "tax_charge_rows" not in pl_history_from_payload(load("agras")).as_dict(), (
        "a row count is not a money figure, and the history keeps no second count")


def test_a_profitable_plan_is_actually_taxed():
    """The consequence, not the pedigree: on a book whose rate is above
    zero (agras, statutory 16% — its own charge does not tie) a plan the
    model itself forecasts into profit is charged tax.

    RESTATED (plan/2 B4a): this ran on retail, whose 16% came from the
    statutory rung only because its book rung was refused — the refusal
    was the 609/709 double count. Read correctly retail ties to account
    121 with a nil charge and no class-69 account, so its rate is a
    MEASURED book 0 (the hx2b law) and a profitable retail plan is charged
    nothing; the companion test below pins that consequence by name."""
    # plan/2 B4b: opex_pct_of_revenue left KEYS; agras is profitable at the
    # default GET, so no lever is needed for the assertion.
    projection = plan("agras", horizon_years=5)
    assert projection.assumptions["tax_rate"].exact > 0
    pretax = sum(p.pl["pretax_result"] for p in projection.periods)
    charged = sum(-p.pl["income_tax"] for p in projection.periods)
    assert pretax > 0
    assert charged > 0, "five profitable years and nothing charged"


def test_a_tying_book_with_no_profit_tax_row_takes_the_statutory_rung():
    """RETIRED BY NAME (plan/2 B4 repair, B4V-6):
    test_a_book_that_ties_with_a_nil_charge_is_charged_nothing pinned a
    best-case figure — retail ties to account 121 and carries NO profit-tax
    row, so its assembled tax of 0.00 is what an empty bucket sums to, and
    B4a read that ABSENT charge as a measured rate of nil: every plan year
    untaxed (before B4a the same book took the statutory rung). Owner
    ruling 2026-09-18: absent inputs refuse; a top rung only where reality
    is genuinely best-case. The book rung is now recorded absent with its
    reason and the ladder takes the statutory macro rung."""
    payload = load("retail")
    rows = [r for r in payload["line_items"] if r.get("bucket") == "taxExpense"]
    assert rows == [], "the fixture changed: retail now files a profit-tax row"
    projection = plan("retail", horizon_years=5)
    driver = projection.assumptions["tax_rate"]
    assert (driver.tier, driver.source) == ("macro", "engine_default"), (
        driver.tier, driver.source, driver.exact)
    assert driver.exact is not None and driver.exact > 0
    steps = [(s["tier"], s["outcome"]) for s in driver.fallback_steps]
    assert steps == [("book", "absent")], steps
    assert "books no profit-tax charge" in driver.basis
    assert "absent charge, not a measured rate of nil" in driver.basis
    pretax = sum(p.pl["pretax_result"] for p in projection.periods)
    charged = sum(-p.pl["income_tax"] for p in projection.periods)
    assert pretax > 0
    assert charged > 0, "five profitable years on a book with an absent charge, untaxed"
    print("retail: tax_rate %s (tier %s); five-year pre-tax %s charged %s"
          % (driver.exact, driver.tier, fmt(pretax), fmt(charged)))


def test_a_tying_book_with_no_statement_rows_at_all_cannot_show_a_nil_charge():
    """B4RV-3 (plan/2 B5 repair): retail sent with NO line_items key. The
    rows that could show a profit-tax row closing at 0.00 are not there, so
    the 0.00 on the tax line is an absent charge, exactly as it is when the
    rows are there and carry no tax row. Before the repair tax_rows None kept
    the book rung: year-one income tax 0.00 against -517,641.16 with the
    rows. Not reachable through the route, which always loads the rows."""
    payload = load("retail")
    payload.pop("line_items")
    projection = project_payload(payload, horizon_years=1,
                                 revolver_rate=_CALLER_REVOLVER_RATE)
    driver = projection.assumptions["tax_rate"]
    assert (driver.tier, driver.source) == ("macro", "engine_default"), (
        driver.tier, driver.source, driver.exact)
    assert "statement rows were not supplied" in driver.basis, driver.basis
    assert sum(-p.pl["income_tax"] for p in projection.periods) > 0


def test_a_tying_book_whose_profit_tax_row_closes_at_nil_keeps_the_book_rung():
    """TC-3 control for the rule above, on a test-built retail: the SAME
    book with a profit-tax row that closes at 0.00 has a MEASURED nil
    charge, and keeps book 0 with its basis. The rule reads whether the
    charge is there, never whether it is small."""
    payload = load("retail")
    payload["line_items"].append({"statement": "pl", "bucket": "taxExpense",
                                  "ro_account_code": "691",
                                  "ro_account_name": "Cheltuieli cu impozitul pe profit",
                                  "amount": 0.0})
    projection = project_payload(payload, horizon_years=1,
                                 revolver_rate=_CALLER_REVOLVER_RATE)
    driver = projection.assumptions["tax_rate"]
    assert (driver.exact, driver.tier, driver.source) == (0, "book", "derived"), (
        driver.exact, driver.tier, driver.source)
    assert "the charge it measures is nil" in driver.basis


# ──────────────────────────────────────────────────────────────────────
# LP3 — DAY DRIVERS HAVE SUB-DAY PRECISION, AND ZERO IS UNREACHABLE
#
# Reds when a day count is stored, derived or coerced at whole-day
# resolution, when a derivation and an override round by different rules,
# and when a positive day count collapses to the refusal value 0. It does
# NOT police whether a supplied DSO is commercially sensible.
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", BOOKS)
def test_a_day_driver_states_the_value_the_model_actually_spent(name):
    """The basis sentence and the stored value are the same number. A
    driver whose stated derivation contradicts its value is worse than
    no basis at all."""
    projection = plan(name, horizon_years=1)
    for key in ("dso_days", "dio_cogs_days", "dpo_cogs_days"):
        driver = projection.assumptions[key]
        if driver.source == "unavailable":
            assert driver.exact is None
            continue
        assert ("%s days" % days_fmt(driver.exact)) in driver.basis


@pytest.mark.parametrize("name", BOOKS)
def test_the_derived_day_count_is_exact_to_a_millionth_of_a_day(name):
    """Derived from the same two figures the basis cites, at micro-day
    resolution — so the working-capital balance the driver reproduces is
    the book's own, not one moved by a rounding rule."""
    book = _book_pl(name)
    # plan/2 B3: at the book's own flows — base growth is the macro anchor
    # now (R1), and the landing check below is a zero-growth statement.
    projection = plan(name, horizon_years=1, revenue_growth=0)
    for key, line, flow in (("dso_days", "ar", "revenue"),
                            ("dio_cogs_days", "inventory", "cogs"),
                            ("dpo_cogs_days", "ap", "cogs")):
        driver = projection.assumptions[key]
        if driver.source == "unavailable":
            continue
        balance = projection.opening.cents(line)
        annual = cents_from(book[flow])
        assert driver.exact == mul_div(balance * MICRO_DAY, 365, annual), key
        # and the first projected period lands back on the opening
        # balance, within the model's own resolution: the flow it is
        # measured against carries one micro-rounded rate, and the day
        # count itself is stored to one micro-day.
        allowed = resolution_bound((balance, 2), periods=2)
        assert abs(projection.periods[0].bs[line] - balance) <= allowed, key


def test_a_caller_override_and_the_derivation_round_by_the_SAME_rule():
    """Truncation is a second rule. Under it 26.9 and 26.4 both become 26
    — the derivation rounds, the override truncates, and one quantity has
    two meanings depending on who supplied it."""
    for supplied in (26.9, 26.4, 71.2057, 0.9, 0.5):
        driver = plan("agras", horizon_years=1,
                      dso_days=supplied).assumptions["dso_days"]
        assert driver.exact == micro_days_from(supplied)
        assert driver.value() == supplied
    # 26.9 and 26.4 are now different plans, which they always were
    high = plan("agras", horizon_years=1, dso_days=26.9).periods[0].bs["ar"]
    low = plan("agras", horizon_years=1, dso_days=26.4).periods[0].bs["ar"]
    assert high > low


def test_a_sub_day_driver_cannot_round_into_the_refusal_value_zero():
    """`None` holds the line; `0` liquidates it. Truncation turned one
    into the other: dso_days=0.5 emptied 8.5m of receivables into cash
    and posted the result as operating cash flow."""
    opening_ar = plan("agras", horizon_years=1).opening.cents("ar")
    assert opening_ar > 0
    projection = plan("agras", horizon_years=1, dso_days=0.5)
    assert projection.assumptions["dso_days"].exact == MICRO_DAY // 2
    assert projection.periods[0].bs["ar"] > 0
    # half a day of receivables, not none of them
    assert projection.periods[0].bs["ar"] < opening_ar

    with pytest.raises(AssumptionError) as excinfo:
        plan("agras", horizon_years=1, dso_days=0.0000001)
    assert "rounds to zero days" in str(excinfo.value)
    assert "dso_days" in str(excinfo.value)


def test_a_whole_count_refuses_the_truncation_a_day_count_now_allows():
    """The horizon's `total_years` really is a whole count, so a fractional
    one is a caller error rather than a silent floor to 5. It is a request
    field, never a driver (contract 2.2), so it is refused by that name."""
    with pytest.raises(AssumptionError) as excinfo:
        plan("agras", horizon_years=5.7)
    assert "whole count" in str(excinfo.value)
    assert "total_years" in str(excinfo.value)
    # ...and a count driver that remains is still refused a fraction
    with pytest.raises(AssumptionError) as excinfo:
        plan("agras", horizon_years=1, days_basis=365.5)
    assert "whole count" in str(excinfo.value)
    assert "days_basis" in str(excinfo.value)


def test_a_day_count_is_never_spendable_as_a_whole_number():
    """The two vocabularies must not meet under one name: `count()` is
    the whole-number accessor and it refuses a micro-day driver."""
    projection = plan("agras", horizon_years=1)
    with pytest.raises(AssumptionError):
        projection.assumptions.count("dso_days")
    assert projection.assumptions.count("days_basis") == 365


# ──────────────────────────────────────────────────────────────────────
# LP4 — GROWTH BELOW -100% IS REFUSED
#
# Reds when revenue is projected negative. It does NOT bound growth from
# above: a 900% plan balances and is nonsense, which F1's docstring
# already disclaims.
# ──────────────────────────────────────────────────────────────────────


def test_growth_below_minus_one_hundred_percent_is_refused():
    with pytest.raises(AssumptionError) as excinfo:
        plan("agras", horizon_years=2, revenue_growth=-1.5)
    message = str(excinfo.value)
    assert "revenue_growth" in message
    assert "-150.0000%" in message, message   # TC-10: from the same integer
    assert "-100%" in message


def test_minus_one_hundred_percent_exactly_is_a_plan_not_a_refusal():
    """The floor is where revenue STOPS, not where it reverses. A business
    that sells nothing is a projection a reader can mean."""
    projection = plan("agras", horizon_years=2, revenue_growth=-1.0)
    for period in projection.periods:
        assert period.pl["revenue"] == 0
        assert period.checks["balance_delta_cents"] == 0


def test_the_balance_check_alone_cannot_see_negative_revenue():
    """Why the guard exists rather than relying on F1: a mirror-image
    balance sheet closes to zero exactly as a real one does, so nothing
    downstream would ever have objected."""
    from engine.forecast.project import project as _project
    payload = load("agras")
    history = pl_history_from_payload(payload)
    opening = opening_for(payload)
    assumptions = derive_assumptions(opening, history,
                                     context=context_for(payload))
    # Reach past the guard the way nothing else can: hand the model an
    # assumption set already built, with the growth stamped on it.
    hostile = assumptions.with_overrides(revenue_growth=-1.5)
    with pytest.raises(AssumptionError):
        _project(opening, history, hostile, total_years=2, monthly_months=12,
                 context=context_for(payload))


# ──────────────────────────────────────────────────────────────────────
# LP5 — AN UNPRICED FUNDING LINE IS REFUSED, NOT CHARGED 0%
#
# Reds when a plan draws a line the book cannot price. It does NOT
# invent a market rate, and it does not fire when the line is never
# drawn — an unpriceable rate on an undrawn line costs nothing and
# refusing it would refuse a plan that is perfectly well defined.
# ──────────────────────────────────────────────────────────────────────


def test_a_book_with_no_debt_cannot_price_a_funding_line():
    projection = project_payload(load("carniprod"))
    driver = projection.assumptions["revolver_rate"]
    assert driver.source == "unavailable"
    assert driver.exact is None
    assert not projection.funding_periods(), "this base plan must not draw"


def test_an_unpriced_funding_line_is_refused_rather_than_charged_nothing():
    """0% is not the absence of a rate: it is an invented rate, and the
    most favourable one available.

    plan/2 B5 (contract 6.5, 28.3 B5 "Retires"): the blanket refusal of the
    whole plan became the PARTIAL refusal. ``project_plan`` serves the
    periods before the first draw it cannot price and returns a
    ShortfallRefusal naming the period and the amount, which needs no rate
    (the line opens at zero, so the first shortfall accrues no funding
    interest). RED ON: the draw charged at 0%; the plan served past the
    draw; a refusal that names no period or no amount; the fp1 wrapper
    serving the truncated plan (GET keeps its 422 until B6)."""
    from engine.forecast import PlanRequest, project_plan
    drivers = dict(dividend_payout_pct=0.95, min_cash=2_000_000.0,
                   capex_pct_of_revenue=0.20)
    plan = project_plan(load("carniprod"), (), PlanRequest(total_years=5), None,
                        assumption_overrides=drivers)
    refusal = plan.refusal
    assert refusal is not None, "the plan draws a line this book cannot price"
    shape = refusal.as_dict()
    assert shape["driver_key"] == "revolver_rate"
    assert shape["from_period"] == refusal.period.label
    assert shape["shortfall_minor"] > 0
    assert shape["shortfall_minor"] == 200_000_000 - shape["cash_before_funding_minor"]
    assert "funding line" in shape["sentence"]["text"]
    served = [p.label for p in plan.projection.periods]
    assert served == [p.label for p in plan.projection.timeline[:refusal.period.index]]
    assert all(p.bs["revolver"] == 0 and p.pl["interest_expense_funding_line"] == 0
               for p in plan.projection.periods)
    assert "refused" in plan.summary["peak_funding_gap_minor"]
    # the fp1 wrapper never serves the truncated plan: it refuses, naming
    # the same period
    with pytest.raises(AssumptionError) as excinfo:
        project_payload(load("carniprod"), horizon_years=5, **drivers)
    message = str(excinfo.value)
    assert "revolver_rate" in message
    assert "draws" in message and "funding line" in message
    assert "0%" in message
    assert excinfo.value.period_label == refusal.period.label


def test_the_same_plan_runs_and_is_charged_once_a_rate_is_supplied():
    drivers = dict(horizon_years=5, dividend_payout_pct=0.95,
                   min_cash=2_000_000.0, capex_pct_of_revenue=0.20)
    projection = project_payload(load("carniprod"), revolver_rate=0.09,
                                 **drivers)
    drawn = projection.funding_periods()
    assert drawn, "the plan that was refused must be the plan that draws"
    charged = sum(-p.pl["interest_expense_funding_line"]
                  for p in projection.periods)
    assert charged > 0, "a priced line that costs nothing is the old defect"
    assert projection.assumptions["revolver_rate"].source == "caller"


def test_a_book_that_prices_its_own_line_needs_nothing_supplied():
    """The refusal must not spread to books that CAN price the line —
    agras derives its rate from its own interest expense."""
    projection = project_payload(
        load("agras"), horizon_years=5, revenue_growth=0.03,
        capex_pct_of_revenue=0.22, dividend_payout_pct=0.70,
        min_cash=500_000.0,
        debt_schedule=DebtSchedule(
            [DebtMove(i, lt_repay=120_000_00) for i in range(12)]))
    assert projection.assumptions["revolver_rate"].source == "derived"
    assert projection.funding_periods()
    assert sum(-p.pl["interest_expense_funding_line"]
               for p in projection.periods) > 0


@pytest.mark.parametrize("name", BOOKS)
def test_no_plan_ever_draws_a_funding_line_that_costs_nothing(name):
    """The consequence, across every book, rather than the mechanism: a
    drawn line either carries a real charge or the plan does not exist.
    A 0% facility is the most favourable financing terms available
    anywhere, and no trial balance granted them."""
    drivers = dict(horizon_years=5, dividend_payout_pct=0.95,
                   min_cash=2_000_000.0, capex_pct_of_revenue=0.20)
    try:
        projection = project_payload(load(name), **drivers)
    except AssumptionError as exc:
        assert "revolver_rate" in str(exc), str(exc)
        return
    drawn = projection.funding_periods()
    if not drawn and projection.peak_funding_cents() == 0:
        return
    charged = sum(-p.pl["interest_expense_funding_line"]
                  for p in projection.periods)
    assert charged > 0, (
        "%s draws a peak funding line of %s across %d period(s) and is "
        "charged %s for it — an interest-free facility nobody extended"
        % (name, fmt(projection.peak_funding_cents()), len(drawn),
           fmt(charged)))


# ──────────────────────────────────────────────────────────────────────
# LP6 — AN UNMEASURABLE RATE IS NEVER SPENT AS 0%
#
# `unavailable` means the book could not measure the driver. Where the
# driver governs a BALANCE that is honoured by HOLDING the balance (LP3).
# Where it governs a P&L flow, or a programme the model creates itself,
# there is no balance to hold — so a 0 stored behind the refusal is
# SPENT, and for every cost the model charges it is the most favourable
# rate that exists. The argument the funding line already made for
# itself, applied to every rate that carries it.
#
# Each case below removes from a REAL book the figure the driver's own
# derivation names, and asserts the projection refuses by that driver's
# name. The last two assert the opposite direction: an absent LINE still
# projects.
# ──────────────────────────────────────────────────────────────────────


#: driver -> the assembled_pl key whose removal makes it unmeasurable,
#: and the book that carries a figure big enough for the zero to matter.
#: Nothing is hand-typed: the consequence is read off the book itself.
#: plan/2 B4b: cogs_pct_of_revenue and opex_pct_of_revenue left this table
#: with KEYS — cost of sales and operating costs are pools with an amount,
#: never a share that can fail to be measured (a missing line is a nil
#: pool, and projects).
from engine.forecast.money import MICRO as MICRO_ONE

_UNMEASURABLE = (
    ("depreciation_rate", "agras", "depreciation"),
    ("interest_rate_debt", "retail", "interest_expense"),
)


@pytest.mark.parametrize("name", BOOKS)
def test_no_unavailable_rate_carries_a_value_the_model_could_spend(name):
    """Structural, on every real book: a refusal carries nothing."""
    assumptions = plan(name, horizon_years=1).assumptions
    for driver in assumptions.items():
        if driver.source != "unavailable" or driver.unit != "ratio":
            continue
        assert driver.exact is None, (
            "%s/%s is a refusal carrying the spendable value %r"
            % (name, driver.key, driver.exact))
        with pytest.raises(AssumptionError) as caught:
            assumptions.micros(driver.key)
        assert driver.key in str(caught.value)


@pytest.mark.parametrize("key,name,pl_key", _UNMEASURABLE)
def test_a_rate_the_book_cannot_measure_refuses_the_plan(key, name, pl_key):
    payload = load(name)
    assert payload["statements"]["assembled_pl"].get(pl_key) is not None, \
        "the fixture changed: %s no longer carries %s" % (name, pl_key)
    del payload["statements"]["assembled_pl"][pl_key]
    with pytest.raises(AssumptionError) as caught:
        project_payload(payload, horizon_years=5,
                        revolver_rate=_CALLER_REVOLVER_RATE)
    message = str(caught.value)
    assert key in message, message
    # the refusal carries the driver's own basis, so the reader is told
    # what could not be measured rather than only that something was not
    assert "supply %s" % key in message.lower(), message


@pytest.mark.parametrize("key,name,pl_key", _UNMEASURABLE)
def test_the_same_plan_runs_once_that_rate_is_supplied(key, name, pl_key):
    """The refusal is a missing input, not a dead end — and the driver
    the caller supplies is stamped `caller`, never re-stamped derived."""
    payload = load(name)
    del payload["statements"]["assembled_pl"][pl_key]
    projection = project_payload(payload, horizon_years=5,
                                 revolver_rate=_CALLER_REVOLVER_RATE,
                                 **{key: 0.05})
    assert projection.assumptions[key].source == "caller"
    assert len(projection.periods) > 0


#: plan/2 B4 REPAIR (B4V-2): the two cost rows B4b dropped from
#: _UNMEASURABLE come back against the POOL keys. A pool has an amount, so
#: a nil line is a nil pool and projects — but an ABSENT total (the key
#: missing, or null) is not a nil line: B4b read it `or 0`, ran
#: rows_disagree over the coerced zero and projected the line at 0.00
#: (agras: EBITDA 83.4M against 11.0M). driver -> book -> assembled_pl key.
_ABSENT_POOL_TOTALS = (
    ("pool_fixed_share.cost_of_sales", "agras", "cogs"),
    ("pool_fixed_share.cost_of_sales", "retail", "cogs"),
    ("pool_fixed_share.operating_costs", "agras", "opex_excluding_cogs_and_da"),
    ("pool_fixed_share.operating_costs", "retail", "opex_excluding_cogs_and_da"),
)


@pytest.mark.parametrize("how", ("missing", "null"))
@pytest.mark.parametrize("key,name,pl_key", _ABSENT_POOL_TOTALS)
def test_an_absent_cost_total_refuses_the_plan_by_its_pool(key, name, pl_key, how):
    payload = load(name)
    reported = payload["statements"]["assembled_pl"].get(pl_key)
    assert reported is not None and cents_from(reported) > 0, \
        "the fixture changed: %s no longer carries %s" % (name, pl_key)
    if how == "missing":
        del payload["statements"]["assembled_pl"][pl_key]
    else:
        payload["statements"]["assembled_pl"][pl_key] = None
    with pytest.raises(AssumptionError) as caught:
        project_payload(payload, horizon_years=5,
                        revolver_rate=_CALLER_REVOLVER_RATE)
    message = str(caught.value)
    assert caught.value.key == key, message
    assert "assembled_pl.%s" % pl_key in message, message
    # the refusal quotes what the coerced zero would have hidden, read off
    # the book's own rows (never typed)
    assert "never read as nil" in message, message
    # a share the caller supplies cannot stand in for an absent AMOUNT
    with pytest.raises(AssumptionError):
        project_payload(payload, horizon_years=5,
                        revolver_rate=_CALLER_REVOLVER_RATE, **{key: 0.5})


@pytest.mark.parametrize("key,name,pl_key", _ABSENT_POOL_TOTALS)
def test_an_absent_cost_total_is_served_unavailable_carrying_nothing(key, name, pl_key):
    from engine.forecast.project import assumptions_for_payload

    payload = load(name)
    del payload["statements"]["assembled_pl"][pl_key]
    driver = assumptions_for_payload(payload)[key]
    assert driver.source == "unavailable" and driver.exact is None, (
        "%s/%s: an absent total served %r / %r" % (name, key, driver.source, driver.exact))
    assert driver.tier == "absent"


def test_a_true_nil_cost_total_still_projects():
    """TC-3 control for the refusal above: 0.00 is a measured nil, and a
    book whose cost of sales IS nil projects (realestate carries none)."""
    payload = load("realestate")
    assert payload["statements"]["assembled_pl"].get("cogs") is not None
    assert cents_from(payload["statements"]["assembled_pl"]["cogs"]) == 0
    projected = project_payload(payload, horizon_years=1,
                                revolver_rate=_CALLER_REVOLVER_RATE)
    assert sum(p.pl["cost_of_sales"] for p in projected.periods) == 0


def test_a_book_with_no_revenue_carries_its_costs_at_their_own_base():
    """The measured case the platform actually serves (CLAUDE.md §5,
    'Revenue <500K RON or no operating activity').

    Before the first repair the same payload projected five years of ZERO
    operating costs and ZERO EBITDA against a book reporting its own
    annual operating cost, because `opex_pct_of_revenue` was
    `unavailable` and spent as 0; the repair then REFUSED the plan (a
    share of nil revenue). RESTATED (plan/2 B4b, contract 5): operating
    costs are POOLS with an amount, not shares of revenue, so a book with
    no revenue projects, carrying every pool at its own base — and with
    nil revenue every pool's variable base exceeds the cap, so each is
    served fully fixed and follows inflation only. The size of what was
    once hidden is read off the book, not typed.
    """
    payload = load("realestate")
    reported_opex = cents_from(
        payload["statements"]["assembled_pl"]["opex_excluding_cogs_and_da"])
    assert reported_opex > 0
    payload["statements"]["assembled_pl"]["revenue"] = 0.0
    projected = project_payload(payload, horizon_years=5, inflation=0,
                                revolver_rate=_CALLER_REVOLVER_RATE)
    charged = sum(-p.pl["operating_costs"] for p in projected.periods)
    assert charged == reported_opex * 5, (
        "this book reports %s of operating cost a year and a five-year plan "
        "at neutral inflation charged %s" % (fmt(reported_opex), fmt(charged)))
    assert sum(p.pl["revenue"] for p in projected.periods) == 0
    assert all(p.tier == "convention" and p.fixed_share_micros == MICRO_ONE
               for p in projected.assumptions.pools.opex if p.base_cents > 0), (
        "with nil revenue every non-nil opex pool is capped fully fixed")
    # …and each remaining unmeasurable rate refuses in its own name.
    # plan/2 B3 (3.4): capex_pct_of_revenue LEFT this list. A nil revenue
    # stays nil under every lever, so no rate could size a spend, and the
    # convention terminal rung spends nothing and says what runs down.
    from engine.forecast.levers_pack import capex_rules
    capex = projected.assumptions["capex_pct_of_revenue"]
    assert (capex.tier, capex.exact) == ("convention", 0)
    assert capex.rule_id == capex_rules()[2].rule_id
    assert fmt(cents_from(payload["statements"]["assembled_pl"]
                          ["depreciation"])) in capex.basis
    assert capex.fallback_steps[0]["outcome"] == "rejected"


def test_an_absent_line_projects_rather_than_refusing():
    """The other direction. A book that names no other operating income
    has nothing to project a share OF — carrying none forward is the
    absence preserved, not an invented rate — so the plan still runs and
    the driver says `engine_default`, not the refusal word. A gate that
    refused this plan would be the gate that is wrong."""
    payload = load("agras")
    del payload["statements"]["assembled_pl"]["other_operating_income"]
    projection = project_payload(payload, horizon_years=1)
    # plan/2 B4b: the held amount, other_operating_income_annual (5.5)
    driver = projection.assumptions["other_operating_income_annual"]
    assert driver.source == "engine_default"
    assert driver.exact == 0
    assert sum(p.pl["other_operating_income"] for p in projection.periods) == 0


def test_a_nil_balance_costs_nothing_but_is_not_a_priced_zero():
    """carniprod opens with no interest-bearing debt.

    THIS GATE USED TO ENCODE THE DEFECT. It asserted
    ``source == "engine_default"`` and ``exact == 0`` under the title "a
    balance that is nil needs no rate and is not a refusal" — true only
    of a plan that never carries debt, and this model hands the caller a
    ``DebtSchedule``. It inspected the DRIVER and never a PERIOD, so it
    could not see the charge; the shipped behaviour and the corrected one
    were indistinguishable to it (LP7 below is the half it was missing).

    What survives is the half that was right: nothing is charged and no
    plan is refused while the balance stays nil.
    """
    payload = load("carniprod")
    opening = opening_for(payload)
    assert opening.cents("st_debt") + opening.cents("lt_debt") == 0
    # derived WITHOUT the caller rate plan() supplies, so the book's own
    # answer about its own funding line is the one under test
    assumptions = derive_assumptions(opening, pl_history_from_payload(payload),
                                     context=context_for(payload))
    debt_rate = assumptions["interest_rate_debt"]
    assert debt_rate.exact is None, (
        "a rate nobody measured carries no number: %r" % (debt_rate.exact,))
    assert not assumptions.is_available("interest_rate_debt")
    assert fmt(0) in debt_rate.basis or "no interest-bearing debt" in debt_rate.basis
    assert not assumptions.is_available("revolver_rate")
    # and the plan that leaves the balance nil still projects, charging
    # nothing — the refusal above costs a well-defined plan nothing
    projection = plan("carniprod", horizon_years=5)
    assert sum(p.bs["st_debt"] + p.bs["lt_debt"] for p in projection.periods) == 0
    assert sum(p.pl["interest_expense_debt"] for p in projection.periods) == 0


def test_micros_refuses_a_refusal_and_micros_or_none_reports_it():
    """The seam itself. `micros` returning 0 for an absent rate is the
    single line that turned every refusal above into a 0% rate."""
    payload = load("carniprod")
    assumptions = derive_assumptions(opening_for(payload),
                                     pl_history_from_payload(payload),
                                     context=context_for(payload))
    assert not assumptions.is_available("revolver_rate")
    assert assumptions.micros_or_none("revolver_rate") is None
    with pytest.raises(AssumptionError):
        assumptions.micros("revolver_rate")
    # a driver that IS available answers the same through both doors
    assert (assumptions.micros("tax_rate")
            == assumptions.micros_or_none("tax_rate"))


#: The unavailable-rate branch count the plan/2 B3 derivation leaves,
#: measured when B3 landed (it was >= 8 before): a scan finding fewer has
#: stopped matching the derivation.
#: plan/2 B4b: the four cogs_pct / opex_pct refusal branches are deleted
#: with their keys (cost pools have an amount, never a refused share), so
#: the floor is the branch count this commit leaves, measured and printed.
FLOOR_UNAVAILABLE_RATE_BRANCHES = 7


def test_no_branch_of_the_derivation_stores_a_number_behind_a_refusal():
    """STRUCTURAL, so it also covers the branches no committed book
    reaches. The behavioural gate above can only see the four books; this
    one reads every ``put(key, unit, value, source, ...)`` in the
    derivation and reds if any RATIO branch pairs the word `unavailable`
    with a value the model could spend.

    It cannot see a MONEY driver held at 0 when its line is absent
    (`interest_income_annual` and the two other-financial lines) — that
    is deliberate and stated in NOT CLOSED, because a held AMOUNT that is
    not there is nothing to hold, where a RATE that is not there still
    multiplies a real base.
    """
    source = REPO / "src" / "engine" / "forecast" / "assumptions.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    seen = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = getattr(node.func, "id", None)
        if name != "put" or len(node.args) < 4:
            continue
        unit, value, kind = node.args[1], node.args[2], node.args[3]
        if getattr(unit, "id", None) != "_RATIO":
            continue
        if not isinstance(kind, ast.Constant) or kind.value != "unavailable":
            continue
        seen += 1
        key = node.args[0].value if isinstance(node.args[0], ast.Constant) \
            else "<computed>"
        assert isinstance(value, ast.Constant) and value.value is None, (
            "line %d: %s is put 'unavailable' carrying a spendable value; "
            "a refusal carries nothing" % (node.lineno, key))
    # plan/2 B3: the floor is the branch count this commit leaves, printed.
    # The capex nil-revenue branch left for its convention rung, the two
    # cost-share and the two debt-rate refusal branches were each merged
    # into one put, and the tax rate gained its R16 refusal branch.
    print("unavailable-rate branches scanned: %d" % (seen,))
    print("unavailable-rate branches in derive_assumptions: %d (floor %d)"
          % (seen, FLOOR_UNAVAILABLE_RATE_BRANCHES))
    assert seen >= FLOOR_UNAVAILABLE_RATE_BRANCHES, (
        "only %d unavailable-rate branches found — the scan stopped "
        "matching the derivation" % (seen,))


# ──────────────────────────────────────────────────────────────────────
# LP7 — A RATE THAT IS NIL AT OPENING IS SPENT ON THE BALANCE THE PLAN
#       CREATES.
#
# LP6 split the `unavailable` rate branches by their cause: "cannot
# measure" refuses, "the line is genuinely absent" carries an
# `engine_default` 0. The second half is only safe IF THE ABSENCE HOLDS
# FOR THE WHOLE HORIZON, and for two of those branches it does not — the
# thing that was absent is a BALANCE, and this model hands the caller
# levers that create it:
#
#   interest_rate_debt   nil debt at opening  <- a DebtSchedule draw
#   depreciation_rate    nil fixed assets     <- the capital programme
#
# Both defaults printed a sentence about the projection ("the balance is
# nil", "the base is nil, so no depreciation is charged") that the
# projection's OWN balance sheet then contradicted, while the 0 behind
# the sentence was charged on the real balance: interest-free debt, and
# assets that never wear out.
#
# EVERY GATE BELOW DRIVES A PROJECTION AND READS A PERIOD. A gate that
# inspects the assumption object cannot see either defect — that is
# exactly how the one it replaces stayed green through both.
# ──────────────────────────────────────────────────────────────────────


#: driver -> (book, the lever that creates the balance it prices, the
#: projected balance-sheet lines that balance lands on, a rate a caller
#: would supply). Nothing about the CONSEQUENCE is typed: each case
#: measures it off the projection the lever produces.
def _no_fixed_assets(payload):
    """A REAL book (agras) whose long-term value sits on a line this
    model does not depreciate — a services or holding shape.

    CONSTRUCTED, and labelled as such: no committed book opens with a nil
    depreciable base (measured: agras 11,728,539.67, carniprod
    94,519,044.80, realestate 6,616,104.38, retail 2,557,631.52). Every
    amount is moved, never invented — the eight fixed-asset rows are
    zeroed and their net carried onto ``other_non_current_assets``, so
    the served totals, the opening partition and the balance check are
    untouched. It goes through the ordinary payload path, not a
    hand-built ``OpeningPosition``.

    The depreciation CHARGE goes with them: a company holding no fixed
    assets does not report one, and leaving agras' 2,955,290.08 behind
    would build a book that contradicts itself — and, through the
    maintenance-capital convention, one that spends capital nobody asked
    it to. Removing the line is also what makes this a test of the
    DEPRECIATION rate rather than of the capex default beside it.
    """
    del payload["statements"]["assembled_pl"]["depreciation"]
    rows = payload["envelope"]["canonical_bs"]["rows"]
    fixed = [r for r in rows if isinstance(r, dict)
             and str(r.get("id", "")).startswith(
                 ("ppe_", "intangibles_", "accumulated_depreciation_ppe",
                  "accumulated_amortization"))]
    assert fixed, "the fixture changed: agras carries no fixed-asset rows"
    moved = 0.0
    for row in fixed:
        moved += row["amount"]
        row["amount"] = 0.0
    residual = [r for r in rows if r.get("id") == "other_non_current_assets"]
    assert len(residual) == 1, "expected exactly one residual row to move it to"
    residual[0]["amount"] = round(residual[0]["amount"] + moved, 2)
    return payload


def _debt_plan():
    """carniprod, unmodified, plus a five-million long-term draw."""
    return (load("carniprod"),
            dict(debt_schedule=DebtSchedule([DebtMove(0, lt_draw=5_000_000_00)]),
                 revolver_rate=_CALLER_REVOLVER_RATE),
            "interest_rate_debt", ("st_debt", "lt_debt"),
            "interest_expense_debt", 0.09)


def _capital_plan():
    """agras with no depreciable base, plus a capital programme."""
    return (_no_fixed_assets(load("agras")),
            dict(capex_pct_of_revenue=0.11),
            "depreciation_rate", ("ppe_net", "intangibles_net"),
            "depreciation", 0.10)


_BALANCE_THE_PLAN_CREATES = (("debt", _debt_plan), ("capital", _capital_plan))


@pytest.mark.parametrize("label,case", _BALANCE_THE_PLAN_CREATES)
def test_the_book_cannot_price_a_balance_it_does_not_carry(label, case):
    """Precondition, read off the real derivation rather than declared:
    the driver is a refusal carrying nothing, and the balance it prices
    is nil at the opening date."""
    payload, _levers, key, bs_lines, _pl_line, _rate = case()
    opening = opening_for(payload)
    assert sum(opening.cents(line) for line in bs_lines) == 0
    assumptions = derive_assumptions(opening, pl_history_from_payload(payload),
                                     context=context_for(payload))
    driver = assumptions[key]
    assert driver.exact is None, (
        "%s: %s carries the spendable value %r behind a nil balance — the "
        "plan below can create that balance, and the 0 is then charged on "
        "it" % (label, key, driver.exact))
    assert not assumptions.is_available(key)


@pytest.mark.parametrize("label,case", _BALANCE_THE_PLAN_CREATES)
def test_a_plan_that_creates_the_balance_is_refused_not_charged_nothing(
        label, case):
    """THE SPEND. The plan pulls the lever, the balance appears, and the
    projection is refused by that driver's name — naming the balance it
    would have had to price and the period it appears in, both rendered
    from the projection's own integers (TC-10).

    Before the repair both plans PROJECTED, in silence: the debt plan
    charged 0.00 of interest on 5,000,000.00 for five years, and the
    capital plan carried 65,217,250.80 of assets it never depreciated.
    """
    payload, levers, key, bs_lines, _pl_line, rate = case()
    with pytest.raises(AssumptionError) as caught:
        project_payload(payload, horizon_years=5,
                        **levers)
    message = str(caught.value)
    assert key in message, message
    assert "supply %s" % key in message.lower(), message
    # the balance the refusal names is the balance the same plan really
    # carries — read out of the projection the supplied rate produces,
    # never typed here
    priced = project_payload(dict(payload), horizon_years=5,
                             **dict(levers, **{key: rate}))
    carried = [sum(p.bs[line] for line in bs_lines) for p in priced.periods]
    assert fmt(max(carried)) in message or fmt(carried[0]) in message, (
        "%s: the refusal must name the balance the plan creates; it "
        "carries %s and the message reads %r"
        % (label, [fmt(c) for c in carried], message))


@pytest.mark.parametrize("label,case", _BALANCE_THE_PLAN_CREATES)
def test_the_same_plan_charges_once_the_rate_is_supplied(label, case):
    """The refusal is a missing input, not a dead end — and what it was
    hiding is the whole charge, sized here off the two projections."""
    payload, levers, key, _bs_lines, pl_line, rate = case()
    priced = project_payload(payload, horizon_years=5,
                             **dict(levers, **{key: rate}))
    charged = -sum(p.pl[pl_line] for p in priced.periods)
    assert charged > 0, (
        "%s: supplying %s changed nothing — the gate is not reaching the "
        "charge" % (label, key))
    # the caller may still ask for 0% IN THOSE WORDS, and gets it: that is
    # a rate somebody chose, not one nobody measured
    free = project_payload(payload, horizon_years=5,
                           **dict(levers, **{key: 0.0}))
    assert sum(p.pl[pl_line] for p in free.periods) == 0
    net_priced = sum(p.pl["net_income"] for p in priced.periods)
    net_free = sum(p.pl["net_income"] for p in free.periods)
    assert net_free > net_priced, (
        "%s: the missing charge is what overstated net income, by %s over "
        "five years" % (label, fmt(net_free - net_priced)))


@pytest.mark.parametrize("label,case", _BALANCE_THE_PLAN_CREATES)
def test_a_plan_that_leaves_the_balance_nil_still_projects(label, case):
    """THE OTHER DIRECTION, and the reason the check is inside the period
    loop rather than at the top of ``project``. A book that carries no
    debt and a plan that borrows none — a book with no fixed assets and a
    plan that buys none — are perfectly well defined, and refusing them
    would be the gate that is wrong."""
    payload, _levers, key, bs_lines, pl_line, _rate = case()
    projection = project_payload(payload, horizon_years=5,
                                 revolver_rate=_CALLER_REVOLVER_RATE)
    assert not projection.assumptions.is_available(key)
    assert sum(p.bs[line]
               for p in projection.periods for line in bs_lines) == 0
    assert sum(p.pl[pl_line] for p in projection.periods) == 0


@pytest.mark.parametrize("label,case", _BALANCE_THE_PLAN_CREATES)
def test_no_accepted_projection_carries_a_balance_its_rate_could_not_price(
        label, case):
    """THE SENTENCE ON THE FACE OF THE PLAN HAS TO STAY TRUE.

    ``project`` prints every unmeasured driver's basis in ``notes``, so
    the reader is told "this book carries no interest-bearing debt at the
    opening date" beside a projection. The defect was not only the
    missing charge: the note asserted something the projection's own
    balance sheet contradicted from the first period. This gate holds the
    two together — if the model ACCEPTS a plan while the driver is
    unpriced, then that balance really is nil in every period it printed.
    """
    payload, levers, key, bs_lines, _pl_line, _rate = case()
    projection = project_payload(payload, horizon_years=5,
                                 revolver_rate=_CALLER_REVOLVER_RATE)
    assert not projection.assumptions.is_available(key)
    note = [n for n in projection.notes if n.startswith("%s:" % key)]
    assert len(note) == 1, "the driver's basis is not on the face: %r" % (note,)
    for period in projection.periods:
        carried = sum(period.bs[line] for line in bs_lines)
        assert carried == 0, (
            "%s: the projection prints %r and then carries %s in %s"
            % (label, note[0], fmt(carried), period.label))
    # and the plan that DOES create it never reaches a printed period
    with pytest.raises(AssumptionError):
        project_payload(payload, horizon_years=5,
                        **levers)


#: driver -> a plan that creates the balance ONLY in the period it is
#: published in, so no period ever OPENS with it. Under this model's
#: opening-balance convention nothing accrues, which is precisely why a
#: guard on the opening balance alone let it through.
_CREATED_IN_THE_LAST_PERIOD = (
    ("interest_rate_debt", "lt_debt",
     lambda: (load("carniprod"),
              dict(horizon_years=5, debt_schedule=DebtSchedule(
                  [DebtMove(15, lt_draw=5_000_000_00)])))),
    ("depreciation_rate", "ppe_net",
     lambda: (_no_fixed_assets(load("agras")),
              dict(horizon_years=1, capex_pct_of_revenue=0.11))),
)


@pytest.mark.parametrize("key,line,case", _CREATED_IN_THE_LAST_PERIOD)
def test_a_balance_created_in_the_period_it_is_published_in_is_refused_too(
        key, line, case):
    """ONE CONVENTION DEEPER, and the same defect wearing it.

    Interest and depreciation are charged on the balance at the START of
    a period, so a draw or a purchase in the LAST period accrues nothing
    inside the horizon — and a guard that asked only about the opening
    balance therefore never fired. Measured before this was closed: a
    five-million draw at period index 4 PROJECTED, printing
    ``lt_debt 5,000,000.00`` on FY2030's balance sheet beside a note
    saying this book carries no debt and nothing is charged. The
    arithmetic was right and the statement was a lie.

    The funding line has always guarded on the DRAW rather than on the
    opening balance; these two now do the same.
    """
    payload, levers = case()
    with pytest.raises(AssumptionError) as caught:
        project_payload(payload,
                        revolver_rate=_CALLER_REVOLVER_RATE, **levers)
    message = str(caught.value)
    assert key in message and "supply %s" % key in message.lower(), message
    # the period it names is the one that would have published the
    # balance — read off the projection the supplied rate produces
    priced = project_payload(case()[0],
                             revolver_rate=_CALLER_REVOLVER_RATE,
                             **dict(levers, **{key: 0.09}))
    carrying = [p.label for p in priced.periods if p.bs[line] > 0]
    assert carrying and carrying[0] in message, (
        "the refusal names no period that actually carries the balance; "
        "it carries in %r and the message reads %r" % (carrying, message))


def test_a_comfortable_word_over_a_missing_number_is_not_available():
    """THE SEAM ITSELF. ``is_available`` answered the SOURCE WORD while
    the charge answered the VALUE, and a driver that pairs a comfortable
    word with no number fell straight through the gap: `engine_default`
    said available, ``project``'s in-loop refusal never armed, and
    ``rate or 0`` charged the zero. Both halves are now asked."""
    payload = load("carniprod")
    base = derive_assumptions(opening_for(payload),
                              pl_history_from_payload(payload),
                              context=context_for(payload))
    from engine.forecast.assumptions import Assumption, AssumptionSet
    items = []
    for item in base.items():
        if item.key == "interest_rate_debt":
            item = Assumption(item.key, item.unit, None, "engine_default",
                              "a default that carries no number")
        items.append(item)
    forged = AssumptionSet(items, base.debt_schedule)
    assert forged["interest_rate_debt"].source == "engine_default"
    assert not forged.is_available("interest_rate_debt"), (
        "a driver with no value is not available whatever word it wears")
    # and the converse: a refusal that still carried a number is not
    # available either
    items = [Assumption("interest_rate_debt", "ratio", 0, "unavailable",
                        "a refusal carrying a spendable zero")
             if i.key == "interest_rate_debt" else i for i in base.items()]
    assert not AssumptionSet(items, base.debt_schedule).is_available(
        "interest_rate_debt")


def test_every_rate_that_prices_a_balance_is_read_as_a_value_not_a_word():
    """STRUCTURAL, and derived from the product rather than declared.

    The rates that price a BALANCE are exactly the ones ``project`` reads
    through ``micros_or_none`` — a list this gate reads out of
    ``project.py`` rather than typing, so a fifth one added tomorrow is
    covered on the day it is added. For each of them:

      · no branch of the derivation may store a LITERAL number behind it
        (a measured rate is an expression; a literal 0 is a rate nobody
        measured, and it is spent on whatever the plan creates), and
      · ``project`` must guard it by asking the VALUE — ``<rate> is
        None`` — never by asking the source word, because the word and
        the value can disagree.

    It cannot see whether the guard is in the right PLACE; the
    behavioural gates above are what prove the check fires at the period
    where the balance appears, and that it does not fire before.
    """
    proj = ast.parse((REPO / "src" / "engine" / "forecast"
                      / "project.py").read_text(encoding="utf-8"))
    priced_by_balance = {}  # local name -> driver key
    for node in ast.walk(proj):
        if not (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and isinstance(node.value, ast.Call)):
            continue
        func = node.value.func
        if getattr(func, "attr", None) != "micros_or_none":
            continue
        arg = node.value.args[0]
        assert isinstance(arg, ast.Constant), ast.dump(arg)
        priced_by_balance[node.targets[0].id] = arg.value
    assert len(priced_by_balance) >= 4, (
        "only %d balance-priced rate(s) found — the scan stopped matching "
        "project.py: %r" % (len(priced_by_balance), priced_by_balance))

    asked_by_value = set()
    for node in ast.walk(proj):
        if not (isinstance(node, ast.Compare) and len(node.ops) == 1
                and isinstance(node.ops[0], (ast.Is, ast.IsNot))
                and isinstance(node.left, ast.Name)
                and isinstance(node.comparators[0], ast.Constant)
                and node.comparators[0].value is None):
            continue
        asked_by_value.add(node.left.id)
    for name, key in sorted(priced_by_balance.items()):
        assert name in asked_by_value, (
            "%s prices a balance the plan can create, and project.py never "
            "asks whether it has a value — a source-word flag answers True "
            "for a default carrying nothing, and the charge falls through "
            "to 0%%" % (key,))
    #: and the source word must not be asked about them AT ALL. The check
    #: above only proves the value is asked SOMEWHERE; asking both, and
    #: guarding on the word, is exactly the shipped shape
    #: (``debt_rate_priced = assumptions.is_available(...)``) that left
    #: the refusal armed in the source and inert in the arithmetic.
    for node in ast.walk(proj):
        if not (isinstance(node, ast.Call)
                and getattr(node.func, "attr", None) == "is_available"
                and node.args and isinstance(node.args[0], ast.Constant)):
            continue
        assert node.args[0].value not in set(priced_by_balance.values()), (
            "line %d: %s prices a balance the plan can create and is "
            "guarded by its SOURCE WORD. The word and the value can "
            "disagree — that gap is where the 0 was charged; ask the value"
            % (node.lineno, node.args[0].value))

    derivation = ast.parse((REPO / "src" / "engine" / "forecast"
                            / "assumptions.py").read_text(encoding="utf-8"))
    checked = 0
    for node in ast.walk(derivation):
        if not (isinstance(node, ast.Call)
                and getattr(node.func, "id", None) == "put"
                and len(node.args) >= 4):
            continue
        key = node.args[0]
        if not (isinstance(key, ast.Constant)
                and key.value in set(priced_by_balance.values())):
            continue
        checked += 1
        value = node.args[2]
        if not isinstance(value, ast.Constant):
            continue  # a measured expression — that is the whole point
        assert value.value is None, (
            "line %d: %s prices a balance the plan can create and stores "
            "the literal %r; a rate nobody measured carries nothing, or it "
            "is charged on whatever the plan builds"
            % (node.lineno, key.value, value.value))
    assert checked >= 6, (
        "only %d branch(es) of the balance-priced rates were scanned" % checked)


#: The two RATE branches that still store a spendable 0 behind an
#: `engine_default`, and the projected line each of them zeroes. They were
#: audited alongside the two LP7 repairs and KEPT, because what is absent
#: is the NUMERATOR — a line this company's income statement does not
#: carry — while the base both divide by (revenue) is already there and
#: no lever a caller has can give the BOOK either one. That is a
#: MEASUREMENT, not a judgement, so it has a gate.
_DEFAULTS_THAT_SURVIVE_THE_PLAN = (
    ("other_operating_income_annual", "pl", "other_operating_income",
     lambda p: _without(p, "other_operating_income")),
    ("capex_pct_of_revenue", "cf", "capital_expenditure",
     lambda p: _without(_no_fixed_assets(p), "depreciation")),
)


def _without(payload, pl_key):
    payload["statements"]["assembled_pl"].pop(pl_key, None)
    return payload


@pytest.mark.parametrize("key,statement,line,make",
                         _DEFAULTS_THAT_SURVIVE_THE_PLAN)
def test_a_default_that_no_lever_can_falsify_keeps_its_zero(
        key, statement, line, make):
    """THE OTHER HALF OF LP7, and the reason it is not "every 0 is a bug".

    The question a default has to answer is not "flow or balance" and not
    "which word does it wear": it is whether any lever the caller has —
    an override, or the debt schedule — can make the sentence it prints
    false. This gate pulls EVERY lever at once, on the book where the
    branch fires, and reads the projected line the default zeroes. It
    stays zero because nothing in this model creates other operating
    income, and nothing gives the BOOK a depreciation charge to replace.

    It reds the day a lever is added that does — which is exactly when
    the default has to be re-argued rather than inherited.
    """
    from engine.forecast.assumptions import KEYS
    payload = make(load("agras"))
    levers = {}
    for other in KEYS:
        if other == key:
            continue  # the driver under test keeps the book's own answer
        levers[other] = {
            "days_basis": 365,
            "dso_days": 12, "dio_cogs_days": 12, "dpo_cogs_days": 12,
            "min_cash": 1000.0,
        }.get(other, 0.11)
    projection = project_payload(
        payload, horizon_years=3,
        debt_schedule=DebtSchedule([DebtMove(0, lt_draw=9_000_000_00)]),
        **levers)
    assert projection.assumptions[key].source == "engine_default"
    assert projection.assumptions[key].exact == 0
    charged = sum(getattr(p, statement)[line] for p in projection.periods)
    assert charged == 0, (
        "%s stores a spendable 0 on the ground that the line is absent, "
        "and a plan pulling every other lever put %s onto %s.%s. The "
        "default has to be re-argued: something now creates the thing it "
        "says this book does not have"
        % (key, fmt(abs(charged)), statement, line))
