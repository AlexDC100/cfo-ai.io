"""forecast-base-parity — the base projection moves only where a batch said
it would (plan_contract_v2 5.3; battery gate ``forecast-base-parity``).

DELTA MODE (B2, CHANGED set extended by B3)
===========================================
Reference: ``tests/engine/fixtures/forecast/base_get_b0.json``, every line of
every period in minor units, recorded by B0 from the engine in process with
no overrides on the four committed books at total_years 5 and a twelve-month
window (the one year-one split the B0 engine has, so delta mode runs at
``monthly_months`` 12 only).

Today's engine is run on the same payloads at the same horizon. Every
(line, period) and every plan-year total is compared, revenue included, and
every difference is printed. A difference is legal only on a line inside the
DOWNSTREAM CLOSURE of the drivers and conventions in ``CHANGED``: the lines
whose static attribution (``engine.forecast.project.LINE_ASSUMPTIONS``, the
inverse of consumed_by) names at least one of them. Any difference outside
it reds, naming book, line and period.

Plan-year totals follow the FY aggregate of contract 3.6: the sum of the
year's periods for a flow, its closing period for a balance.

The ``checks.*`` series the reference also holds are not served lines, so
each is attributed through the served line it measures (declared below and
printed): the pre-funding cash through ``bs.cash``, the three funding-line
checks through ``bs.revolver``, and the balance difference through nothing —
it may never move.

WHAT THIS GATE REDS ON AFTER THE REPAIR (TC-11)
-----------------------------------------------
Any change to a base figure on a line no CHANGED driver or convention
reaches (the plant: one minor unit of other financial expense in plan year
1, which no B2 entry attributes); a revenue slice that is not exact to the
plan year (the plant: revenue sliced by days over the days basis moves the
366-day plan year); a CHANGED entry that names nothing the engine knows; a
scope with no 366-day plan year, no book or no compared cell (TC-3).

IT CANNOT SEE: whether a move inside the closure is the intended one (the
batch's own gates and the blast radius judge that); the served bytes (the
GET is measured by scripts/measure_plan_blast_radius.py); a twenty-four-
month window (parity mode, B4).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Tuple

import pytest

from engine.forecast import CF_LINES, LINES, PL_LINES, project_payload
from engine.forecast.assumptions import KEYS
from engine.forecast.project import FP1_CONVENTIONS, LINE_ASSUMPTIONS

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
REFERENCE = REPO / "tests" / "engine" / "fixtures" / "forecast" / "base_get_b0.json"
BOOKS = ("agras", "carniprod", "realestate", "retail")

# ── CHANGED: each batch appends under its own anchor (contract 5.3) ──────
CHANGED = []  # type: List[str]
# ── plan/2 B2: year-to-date tax conventions; the horizon leaves KEYS ─────
CHANGED += [
    "tax_accrued_year_to_date",
    "tax_no_loss_carry_forward",
]
#: Keys B2 removed from KEYS (contract 2.2). They attribute no line, so
#: their closure is empty: a horizon that became an argument may move no
#: base figure at all.
REMOVED_KEYS_B2 = ("year_one_granularity", "horizon_years")
CHANGED += list(REMOVED_KEYS_B2)
# ── end plan/2 B2 ────────────────────────────────────────────────────────

#: The reference's check series, attributed through the served line each
#: one measures. ``balance_delta_cents`` has no attribution: it is 0 by law.
CHECK_ATTRIBUTION = {
    "checks.cash_before_funding_line_cents": "bs.cash",
    "checks.funding_line_draw_cents": "bs.revolver",
    "checks.funding_line_repay_cents": "bs.revolver",
    "checks.funding_line_balance_cents": "bs.revolver",
    "checks.balance_delta_cents": None,
}

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
            "period_end": book["period_end"],
            "currency": book.get("currency") or "RON"}


def _lines_now(name: str, total_years: int) -> Tuple[List[Dict], Dict[str, List[int]]]:
    projection = project_payload(_payload(name), horizon_years=total_years)
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
    return [p.period.as_dict() for p in projection.periods], lines


def known_ids() -> set:
    return (set(KEYS) | set(cid for cid, _b in FP1_CONVENTIONS)
            | set(REMOVED_KEYS_B2))


def closure(changed) -> set:
    """Served lines whose static attribution names a CHANGED id."""
    wanted = set(changed)
    lines = set(line for line, ids in LINE_ASSUMPTIONS.items()
                if wanted & set(ids))
    for check, served in CHECK_ATTRIBUTION.items():
        if served is not None and served in lines:
            lines.add(check)
    return lines


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


def compare(reference: Dict, lines_now, changed) -> Tuple[int, List[str], List[str]]:
    """(cells compared, printed differences, reds). Pure: the plants call it
    with a doctored engine output."""
    allowed = closure(changed)
    compared = 0
    printed = []  # type: List[str]
    reds = []  # type: List[str]
    for name in BOOKS:
        record = reference["books"][name]
        periods_now, now = lines_now(name)
        labels = [p["label"] for p in record["periods"]]
        if [p["label"] for p in periods_now] != labels:
            reds.append("%s: the period axis moved: %s -> %s" % (
                name, labels, [p["label"] for p in periods_now]))
            continue
        for line in sorted(record["lines"]):
            before = record["lines"][line]
            after = now.get(line)
            if after is None:
                reds.append("%s: %s is no longer produced" % (name, line))
                continue
            cells = [(labels[i], before[i], after[i]) for i in range(len(labels))]
            totals_before = plan_year_totals(record["periods"], before, line)
            totals_after = plan_year_totals(periods_now, after, line)
            cells += [("plan year %d" % y, totals_before[y], totals_after[y])
                      for y in sorted(totals_before)]
            for where, b, a in cells:
                compared += 1
                if a == b:
                    continue
                verdict = "inside closure" if line in allowed else "OUTSIDE CLOSURE"
                row = "%s %s %s: %d -> %d (delta %+d minor) [%s]" % (
                    name, line, where, b, a, a - b, verdict)
                printed.append(row)
                if line not in allowed:
                    reds.append(row)
    return compared, printed, reds


def _scope_366(reference: Dict) -> Dict[str, List[str]]:
    out = {}
    for name in BOOKS:
        days = {}  # type: Dict[int, int]
        for p in reference["books"][name]["periods"]:
            days[p["year_offset"]] = days.get(p["year_offset"], 0) + p["days"]
        out[name] = ["plan year %d" % y for y, d in sorted(days.items()) if d == 366]
    return out


def test_base_parity_delta_mode_moves_only_the_changed_closure(capsys):
    reference = _reference()
    assert reference["total_years"] == 5 and reference["monthly_months"] == 12
    unknown = sorted(set(CHANGED) - known_ids())
    assert not unknown, (
        "CHANGED names ids the engine does not know (neither a driver, a "
        "convention nor a declared removed key): %s" % unknown)
    total_years = reference["total_years"]
    compared, printed, reds = compare(
        reference, lambda name: _lines_now(name, total_years), CHANGED)
    leap = _scope_366(reference)
    with capsys.disabled():
        print("\nSCOPE forecast-base-parity (delta mode): books %s; total_years %d; "
              "monthly_months 12 (delta mode's only window); reference %s; "
              "366-day plan year per book: %s"
              % (", ".join(BOOKS), total_years, REFERENCE.name,
                 "; ".join("%s %s" % (n, ", ".join(v) or "NONE")
                           for n, v in sorted(leap.items()))))
        print("CHANGED: %s" % ", ".join(CHANGED))
        print("closure (%d served lines + attributed checks): %s"
              % (len(closure(CHANGED)), ", ".join(sorted(closure(CHANGED)))))
        print("check attribution: %s" % ", ".join(
            "%s->%s" % (k, v) for k, v in sorted(CHECK_ATTRIBUTION.items())))
        for row in printed:
            print("DIFF " + row)
        print("differences: %d (%d outside closure)" % (len(printed), len(reds)))
        print("GATE-WORK forecast-base-parity units=%d" % compared)
    assert all(leap.values()), "a book's scope covers no 366-day plan year: %s" % leap
    assert compared > 0, "nothing was compared (TC-3)"
    assert not reds, "base figures moved outside the CHANGED closure:\n" + "\n".join(reds)


def _agras_plus(line: str, label: str, minor: int):
    """A doctored engine output: one cell of agras moved by ``minor``."""
    def lines_now(name):
        periods, lines = _lines_now(name, 5)
        if name == "agras":
            index = [p["label"] for p in periods].index(label)
            lines[line] = list(lines[line])
            lines[line][index] += minor
        return periods, lines
    return lines_now


def test_plant_one_minor_unit_of_other_financial_expense_reds_naming_line_and_period():
    """Contract 5.3's plant, held in the file: other financial expense is
    attributed only to other_financial_expense_annual, which no B2 entry
    names, so one minor unit in plan year 1 reds by line and period."""
    reference = _reference()
    b2_only = ["tax_accrued_year_to_date", "tax_no_loss_carry_forward",
               "year_one_granularity", "horizon_years"]
    _compared, _printed, reds = compare(
        reference, _agras_plus("pl.other_financial_expense", "2026-03", -1), b2_only)
    assert any("agras pl.other_financial_expense 2026-03" in r for r in reds), reds
    assert any("agras pl.other_financial_expense plan year 1" in r for r in reds), reds


def test_a_move_inside_the_closure_is_printed_not_red():
    reference = _reference()
    _compared, printed, reds = compare(
        reference, _agras_plus("pl.income_tax", "2026-02", 1), CHANGED)
    assert any("agras pl.income_tax 2026-02" in r and "inside closure" in r
               for r in printed), printed
    assert not [r for r in reds if "pl.income_tax" in r]


def test_revenue_is_outside_the_b2_closure_and_every_removed_key_attributes_nothing():
    lines = closure(CHANGED)
    assert "pl.revenue" not in lines
    assert "pl.income_tax" in lines and "pl.net_income" in lines
    for key in REMOVED_KEYS_B2:
        assert key not in KEYS
        assert not closure([key]), key
