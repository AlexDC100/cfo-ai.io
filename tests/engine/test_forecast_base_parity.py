"""forecast-base-parity — the base projection moves only where a batch said
it would (plan_contract_v2 5.3; battery gate ``forecast-base-parity``).

PARITY MODE (re-pointed here by plan/2 B4b; delta mode was B2 and B3)
=====================================================================
Reference: ``tests/engine/fixtures/forecast/base_b3_growth0.json``, every
line of every period in minor units, recorded by B4b's first commit
(fa2a04c) from the B3 engine in process over the B4a-repaired books with
``revenue_growth`` overridden to 0, on the four committed books at
total_years 5 and monthly windows 12 and 24.

Today's engine runs the same payloads with ``revenue_growth`` AND
``inflation`` overridden to 0 and no shocks. Revenue must match EXACTLY in
every period and plan year. Every other (line, period) and plan-year total
may differ only within a bound the test RENDERS FROM THE RUN and prints
beside the difference (TC-10): the B3 engine priced cost of sales,
operating costs and other operating income as a share of each period's
revenue slice, and the B4 engine carries them as pools of the anchor's own
amounts, so the two differ by the B3 rounding only —

  per line and period: ceil(|revenue_p| / (2 x MICRO)) for the share
  rounded to micros, + ceil(share_micros / MICRO) for the revenue slice's
  own minor-unit rounding multiplied through the share (one minor unit of
  revenue moves the B3 line by the share — on realestate operating cost is
  180x revenue), + 1 for the final rounding, + 2 per pool for slicing a
  pool in two parts (fixed and variable) instead of one;

summed over the three lines for EBITDA, and ACCUMULATED over the periods
since the anchor for balances and for every line downstream of a balance
(depreciation, interest, tax, cash and the checks), because each period's
rounding settles into the balances the next period is priced on. Tax is
accrued year to date (6.3): a period's charge is the difference of two
accumulated figures, so the tax line and the lines it reaches (net income,
retained equity, cash) carry twice the accumulated bound. Plan-year
totals: the sum of the year's per-period bounds for a flow, the closing
period's bound for a balance (contract 3.6).

WHAT THIS GATE REDS ON AFTER THE REPAIR (TC-11)
-----------------------------------------------
A revenue slice that is not exact to the plan year (the plant: revenue
sliced by days over the days basis moves the 366-day plan year, delta
printed); any line, period or plan-year total outside its rendered bound
(the plant: one minor unit above the bound on one cell reds naming line
and period); a line the reference holds that the engine no longer
produces; a period axis that moved; a scope with no 366-day plan year, no
book or no compared cell (TC-3).

IT CANNOT SEE: whether a move inside a bound is the intended one (the
batch's own gates and the blast radius judge that — forecast-pools holds
the pool arithmetic to the cent); the served bytes (the GET is measured by
scripts/measure_plan_blast_radius.py); a shock (B5).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Dict, List, Tuple

import pytest

from engine.forecast import CF_LINES, LINES, PL_LINES
from engine.forecast.money import MICRO, cents_from, mul_div
from engine.forecast.project import (_opening_and_history, _slice_by_days,
                                     context_for_payload, project)

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
REFERENCE = REPO / "tests" / "engine" / "fixtures" / "forecast" / "base_b3_growth0.json"
BOOKS = ("agras", "carniprod", "realestate", "retail")
WINDOWS = (12, 24)
TOTAL_YEARS = 5

#: The three lines the B3 engine priced as a share of revenue, each with
#: the assembled_pl field its share was measured from.
SHARE_LINES = (("pl.cost_of_sales", "cogs"),
               ("pl.operating_costs", "opex_excluding_cogs_and_da"),
               ("pl.other_operating_income", "other_operating_income"))
#: Lines priced in the same period from the operating lines alone: their
#: bound is that period's, not accumulated.
OPERATING = ("pl.cost_of_sales", "pl.operating_costs", "pl.other_operating_income",
             "pl.ebitda")
#: Lines the year-to-date tax charge reaches (6.3): twice the accumulated
#: bound, because a period's charge is a difference of two accumulated
#: figures.
TAXED = ("pl.income_tax", "pl.net_income", "cf.net_income", "bs.equity_retained",
         "bs.tax_payable", "cf.cash_from_operating", "cf.net_change_in_cash",
         "cf.closing_cash", "cf.opening_cash", "bs.cash", "bs.revolver",
         "cf.funding_line_movement", "cf.cash_from_financing",
         "checks.cash_before_funding_line_cents", "checks.funding_line_draw_cents",
         "checks.funding_line_repay_cents", "checks.funding_line_balance_cents",
         "bs.total_assets", "bs.total_equity_and_liabilities", "bs.total_equity",
         "bs.total_liabilities")

#: Balances take their closing period as the plan-year total; the opening
#: cash of a year is its first period's. Everything else is a flow.
CLOSING = ("cf.closing_cash", "checks.cash_before_funding_line_cents",
           "checks.funding_line_balance_cents", "checks.balance_delta_cents")
OPENING = ("cf.opening_cash",)


def _reference() -> Dict:
    return json.loads(REFERENCE.read_text(encoding="utf-8"))


def _payload(name: str) -> Dict:
    book = json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text())
    return {"envelope": book["envelope"], "statements": book["statements"],
            "line_items": book["line_items"], "period_end": book["period_end"],
            "currency": book.get("currency") or "RON"}


#: plan/2 B4 repair (B4V-6): the reference engine (B3 over the repaired
#: books) measured retail's tax rate as book 0 off a tying book that files
#: no profit-tax row. Today's engine records that charge ABSENT and takes
#: the statutory rung — a deliberate move of the tax rule, printed in the
#: blast radius, and not what THIS gate holds (it holds the cost pools
#: reproducing the B3 share-priced lines). So the parity request holds the
#: tax rate where the reference engine held it, on the books named here and
#: nowhere else; the tax RULE is held by forecast-model / forecast-drivers.
REFERENCE_TAX_RATE = {"retail": 0}


def _run(name: str, window: int):
    payload = _payload(name)
    opening, history = _opening_and_history(payload)
    held = ({"tax_rate": REFERENCE_TAX_RATE[name]} if name in REFERENCE_TAX_RATE else {})
    return payload, project(opening, history, total_years=TOTAL_YEARS,
                            monthly_months=window, context=context_for_payload(payload),
                            revenue_growth=0, inflation=0, **held)


def test_the_held_reference_tax_rate_names_only_books_whose_rung_moved():
    """TC-11: the hold is not a blanket. A book is named only while today's
    engine resolves a DIFFERENT tax rate than the one held; if the rule
    moves back, this reds and the entry is deleted."""
    from engine.forecast.project import assumptions_for_payload
    from engine.forecast.money import micros_from

    for name, held in REFERENCE_TAX_RATE.items():
        now = assumptions_for_payload(_payload(name))["tax_rate"].exact
        assert now != micros_from(held), (
            "%s resolves %r, the rate the parity request holds: delete its "
            "REFERENCE_TAX_RATE entry" % (name, now))


def _lines_now(name: str, window: int) -> Tuple[List[Dict], Dict[str, List[int]], Dict]:
    """(periods, lines, bound inputs) of today's engine at growth 0 and
    inflation 0."""
    payload, projection = _run(name, window)
    lines = {}  # type: Dict[str, List[int]]
    for p in projection.periods:
        for key in PL_LINES:
            lines.setdefault("pl." + key, []).append(int(p.pl[key]))
        for key in LINES:
            lines.setdefault("bs." + key, []).append(int(p.bs[key]))
        for key in CF_LINES:
            lines.setdefault("cf." + key, []).append(int(p.cf[key]))
        for key, value in p.checks.items():
            if key.endswith("_cents"):
                lines.setdefault("checks." + key, []).append(int(value))
    pl = payload["statements"]["assembled_pl"]
    revenue = cents_from(pl.get("revenue") or 0)
    shares = {}  # type: Dict[str, int]
    for line, field in SHARE_LINES:
        amount = cents_from(pl.get(field) or 0)
        shares[line] = mul_div(abs(amount), MICRO, revenue) if revenue else 0
    inputs = {"shares": shares, "revenue": revenue,
              "pools": {"pl.cost_of_sales": 1,
                        "pl.operating_costs": len(projection.assumptions.pools.opex),
                        "pl.other_operating_income": 1}}
    return [p.period.as_dict() for p in projection.periods], lines, inputs


def _is_balance(line: str) -> bool:
    return line.startswith("bs.") or line in CLOSING


def plan_year_totals(periods: List[Dict], values: List[int], line: str) -> Dict[int, int]:
    years = {}  # type: Dict[int, List[int]]
    for period, value in zip(periods, values):
        years.setdefault(period["year_offset"], []).append(value)
    out = {}
    for year, vals in years.items():
        if _is_balance(line):
            out[year] = vals[-1]
        elif line in OPENING:
            out[year] = vals[0]
        else:
            out[year] = sum(vals)
    return out


def bounds_for(line: str, revenue_ref: List[int], inputs: Dict) -> List[int]:
    """The per-period bound of one line, rendered from the run (docstring)."""
    if line == "pl.revenue":
        return [0] * len(revenue_ref)
    per_line = {}  # type: Dict[str, List[int]]
    for share_line, _field in SHARE_LINES:
        share = inputs["shares"][share_line]
        per_line[share_line] = [
            int(math.ceil(abs(r) / (2.0 * MICRO))) + int(math.ceil(share / float(MICRO)))
            + 1 + 2 * inputs["pools"][share_line] for r in revenue_ref]
    ebitda = [sum(v[i] for v in per_line.values()) for i in range(len(revenue_ref))]
    if line in per_line:
        return per_line[line]
    if line in OPERATING:
        return ebitda
    accumulated = [sum(ebitda[:i + 1]) for i in range(len(ebitda))]
    if line in TAXED:
        return [2 * a for a in accumulated]
    return accumulated


def compare(reference: Dict, lines_now, window: int) -> Tuple[int, List[str], List[str]]:
    """(cells compared, printed differences, reds). Pure: the plants call it
    with a doctored engine output."""
    compared = 0
    printed = []  # type: List[str]
    reds = []  # type: List[str]
    for name in BOOKS:
        record = reference["books"][name][str(window)]
        periods_now, now, inputs = lines_now(name, window)
        labels = [p["label"] for p in record["periods"]]
        if [p["label"] for p in periods_now] != labels:
            reds.append("%s w%d: the period axis moved: %s -> %s" % (
                name, window, labels, [p["label"] for p in periods_now]))
            continue
        revenue_ref = record["lines"]["pl.revenue"]
        for line in sorted(record["lines"]):
            before = record["lines"][line]
            after = now.get(line)
            if after is None:
                reds.append("%s w%d: %s is no longer produced" % (name, window, line))
                continue
            bound = bounds_for(line, revenue_ref, inputs)
            cells = [(labels[i], before[i], after[i], bound[i]) for i in range(len(labels))]
            totals_before = plan_year_totals(record["periods"], before, line)
            totals_after = plan_year_totals(periods_now, after, line)
            totals_bound = plan_year_totals(periods_now, bound, line) if not _is_balance(line) \
                else plan_year_totals(periods_now, bound, line)
            if line in OPENING:
                totals_bound = plan_year_totals(periods_now, bound, line)
            cells += [("plan year %d" % y, totals_before[y], totals_after[y], totals_bound[y])
                      for y in sorted(totals_before)]
            for where, b, a, limit in cells:
                compared += 1
                if a == b:
                    continue
                inside = abs(a - b) <= limit
                row = "%s w%d %s %s: %d -> %d (delta %+d minor, bound %d) [%s]" % (
                    name, window, line, where, b, a, a - b, limit,
                    "within bound" if inside else "OUTSIDE BOUND")
                printed.append(row)
                if not inside:
                    reds.append(row)
    return compared, printed, reds


def _scope_366(reference: Dict, window: int) -> Dict[str, List[str]]:
    out = {}
    for name in BOOKS:
        days = {}  # type: Dict[int, int]
        for p in reference["books"][name][str(window)]["periods"]:
            days[p["year_offset"]] = days.get(p["year_offset"], 0) + p["days"]
        out[name] = ["plan year %d" % y for y, d in sorted(days.items()) if d == 366]
    return out


_WORK = {"compared": 0}


@pytest.mark.parametrize("window", WINDOWS)
def test_base_parity_holds_at_growth_0_and_inflation_0_within_the_rendered_bounds(window, capsys):
    reference = _reference()
    assert reference["total_years"] == TOTAL_YEARS and window in reference["windows"]
    compared, printed, reds = compare(reference, _lines_now, window)
    leap = _scope_366(reference, window)
    _WORK["compared"] += compared
    with capsys.disabled():
        print("\nSCOPE forecast-base-parity (parity mode, plan/2 B4b): books %s; total_years %d; "
              "monthly_months %d; revenue_growth 0 and inflation 0 overridden, no shocks; "
              "reference %s (recorded on %s); 366-day plan year per book: %s"
              % (", ".join(BOOKS), TOTAL_YEARS, window, REFERENCE.name,
                 reference.get("recorded_on_commit", "?")[:7],
                 "; ".join("%s %s" % (n, ", ".join(v) or "NONE") for n, v in sorted(leap.items()))))
        for name in BOOKS:
            _periods, _lines, inputs = _lines_now(name, window)
            print("bound inputs %s w%d: revenue %d; shares (micros) %s; pools %s" % (
                name, window, inputs["revenue"],
                ", ".join("%s %d" % (k.split(".")[-1], v) for k, v in sorted(inputs["shares"].items())),
                ", ".join("%s %d" % (k.split(".")[-1], v) for k, v in sorted(inputs["pools"].items()))))
        for row in printed:
            print("DIFF " + row)
        print("differences w%d: %d (%d outside bound)" % (window, len(printed), len(reds)))
    assert all(leap.values()), "a book's scope covers no 366-day plan year: %s" % leap
    assert compared > 0, "nothing was compared (TC-3)"
    assert not reds, "base figures moved outside their rendered bound:\n" + "\n".join(reds)


def test_revenue_matches_the_reference_exactly_in_every_period_and_plan_year():
    reference = _reference()
    checked = 0
    for window in WINDOWS:
        for name in BOOKS:
            record = reference["books"][name][str(window)]
            periods, lines, _inputs = _lines_now(name, window)
            assert lines["pl.revenue"] == record["lines"]["pl.revenue"], (name, window)
            assert plan_year_totals(periods, lines["pl.revenue"], "pl.revenue") == \
                plan_year_totals(record["periods"], record["lines"]["pl.revenue"], "pl.revenue")
            checked += len(periods)
    assert checked > 0


def test_zz_work(capsys):
    with capsys.disabled():
        print("GATE-WORK forecast-base-parity units=%d" % _WORK["compared"])
    assert _WORK["compared"] > 0


# ── plants, held in the file ────────────────────────────────────────────


def _doctored(window: int, line: str, label: str, minor: int, book: str = "agras"):
    """A doctored engine output: one cell of one book moved by ``minor``."""
    def lines_now(name, w):
        periods, lines, inputs = _lines_now(name, w)
        if name == book:
            index = [p["label"] for p in periods].index(label)
            lines[line] = list(lines[line])
            lines[line][index] += minor
        return periods, lines, inputs
    return lines_now


def test_plant_one_minor_unit_above_the_bound_reds_naming_line_and_period():
    reference = _reference()
    record = reference["books"]["agras"]["12"]
    periods, lines, inputs = _lines_now("agras", 12)
    line, label = "pl.cost_of_sales", record["periods"][0]["label"]
    bound = bounds_for(line, record["lines"]["pl.revenue"], inputs)[0]
    delta = record["lines"][line][0] - lines[line][0]
    push = delta + bound + 1  # one minor unit past the bound
    _c, _p, reds = compare(reference, _doctored(12, line, label, push), 12)
    assert any(("agras w12 %s %s" % (line, label)) in r and "OUTSIDE BOUND" in r for r in reds), reds


def test_plant_revenue_sliced_by_days_over_the_days_basis_moves_the_366_day_plan_year():
    """Contract 5.3's plant: a revenue slice by days_m / days_basis is not
    exact to the plan year, and the 366-day year shows it (measured on
    agras)."""
    reference = _reference()
    record = reference["books"]["agras"]["12"]
    leap_years = [int(y.split()[-1]) for y in _scope_366(reference, 12)["agras"]]
    assert leap_years

    def lines_now(name, w):
        periods, lines, inputs = _lines_now(name, w)
        if name != "agras":
            return periods, lines, inputs
        _payload, projection = _run(name, w)
        days_basis = projection.assumptions["days_basis"].exact
        revenue = []
        for p in projection.periods:
            annual = sum(lines["pl.revenue"][i] for i, q in enumerate(projection.periods)
                         if q.period.year_offset == p.period.year_offset)
            revenue.append(mul_div(annual, p.period.days, days_basis))
        lines["pl.revenue"] = revenue
        return periods, lines, inputs
    _c, printed, reds = compare(reference, lines_now, 12)
    hits = [r for r in reds if "agras w12 pl.revenue plan year %d" % leap_years[0] in r]
    assert hits, reds
    assert _slice_by_days is not None


def test_a_move_inside_the_bound_is_printed_not_red():
    reference = _reference()
    _c, printed, reds = compare(reference, _doctored(12, "pl.income_tax", "2026-02", 1), 12)
    assert any("agras w12 pl.income_tax 2026-02" in r and "within bound" in r for r in printed), printed
    assert not [r for r in reds if "pl.income_tax 2026-02" in r]
