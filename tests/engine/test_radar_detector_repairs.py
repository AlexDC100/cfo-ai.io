"""SIX DEFECTS AN ADVERSARIAL READ OF THE RADAR LANE FOUND, AND THEIR LAWS.

Each of the six shipped green. Every one of them produced a number a
reader would have believed, which is why none showed up as a crash: a
false HIGH on a clean book, a movement of exactly zero, a quiet run
stitched across a hole, a guard blind to the literal it was written to
catch, a consequence line that says nothing twice, and a true ratio with
no consequence at all.

The tests below are the repairs stated as law. Each was PLANTED before it
landed — the defect restored, the test run, the failure message read to
confirm it names the defect rather than merely going red somewhere — and
then reverted. What each reds on AFTER the repair (TC-11) is stated on
the test.

Numbers come from real books (``corpus/saga_10_col_<case>/input.xlsx``)
and from spines derived from them the same way
``test_radar_detectors.py`` builds its own: real atoms, one line moved.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from engine.api import _finding as F
from engine.radar import detectors as D
from engine.radar.detectors import fam_series as FSER
from engine.radar.detectors import result as RES
from engine.radar.detectors import support as SUP

from test_radar_detectors import MONTHS6, PACKS, JUR, _spine, load_case

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def pack():
    return D.load_pack(JUR, PACKS)


def _result(run, detector_id):
    for r in run.results:
        if r.detector_id == detector_id:
            return r
    raise AssertionError(
        "%s produced no result at all; the run carries %r"
        % (detector_id, [r.detector_id for r in run.results]))


# ── D1 · a cut-off share needs a year that actually closed ───────────────
#
# The measured defect: `ro_revenue_cutoff` fired HIGH on a CLEAN monthly
# book in Q1 and Q2. A year was admitted on a count of periods present
# (three), the denominator was only those periods, and the last period
# PRESENT was reported as "the final period of the year". Three months in,
# the lift read 25.0%; four months, 16.7%; from five months it fell
# silent. Every firm opening the product early in a year would have been
# handed a manufactured cut-off accusation.


def _monthly_spine(base, months):
    """N consecutive months of one real book, unmutated. Class-70 credit
    is identical in every period, so a year's activity is spread PERFECTLY
    evenly — the one shape a cut-off detector must never call a finding."""
    return _spine(base, months)


# The spine below is the realistic shape: a firm attaches the second half
# of one year and the opening months of the next. Nine periods across two
# years clears the pack's own history gate (`min_periods: 6`,
# `min_years: 2`), so the detector genuinely runs — which is what made the
# defect reachable by a customer rather than only by a test.
H2_THEN_Q1 = ([(2024, m) for m in (7, 8, 9, 10, 11, 12)]
              + [(2025, m) for m in (1, 2, 3)])
TWO_FULL_YEARS = [(y, m) for y in (2024, 2025) for m in range(1, 13)]


def test_a_part_year_never_produces_a_cutoff_finding(pack):
    """RED ON: a year admitted before it closes.

    The book is EVEN — the same class-70 credit in every period — so there
    is nothing to find. Under the defect, 2024 was admitted on its six
    months (share 1/6) and 2025 on its three (share 1/3), and the lift
    between them, 16.7%, cleared a 15% cutoff. The finding was the
    calendar talking."""
    book, profile, _c = load_case("agras")
    run = D.run_detectors(pack, _spine(book, H2_THEN_Q1), profile)
    result = _result(run, "ro_revenue_cutoff")
    assert not result.fired, (
        "a half-year and a quarter produced a cut-off finding: %s"
        % result.reason)
    assert not result.applicable, (
        "neither year in this spine has closed, so the share is not "
        "measurable — it must read NOT APPLICABLE, not 'measured and "
        "fine'. Reason given: %s" % result.reason)
    assert "complete year" in result.na_reason, result.na_reason


def test_the_reason_for_refusing_a_part_year_names_what_is_missing(pack):
    """RED ON: a refusal that does not say which periods are absent. An
    operator reading 'not applicable' with no cause cannot tell a data gap
    from a rule that does not apply to their company."""
    book, profile, _c = load_case("agras")
    run = D.run_detectors(pack, _spine(book, H2_THEN_Q1), profile)
    reason = _result(run, "ro_revenue_cutoff").na_reason
    assert "2024 (6 of its 12 period(s) absent: month 1, 2, 3, 4, 5, 6)" in reason, reason
    assert "2025 (9 of its 12 period(s) absent" in reason, reason


def test_two_closed_years_of_an_even_book_are_measured_and_stay_silent(pack):
    """The complement, and the reason this gate is not vacuous: given TWO
    genuinely complete years the detector RUNS — and finds nothing, because
    the book is even. RED ON: completeness becoming so strict that the
    detector can never speak."""
    book, profile, _c = load_case("agras")
    run = D.run_detectors(pack, _spine(book, TWO_FULL_YEARS), profile)
    result = _result(run, "ro_revenue_cutoff")
    assert result.applicable, result.na_reason
    assert not result.fired, result.reason
    # twelve even months: 1/12 of the year in its final period, both years.
    assert result.observed == pytest.approx(0.0, abs=1e-12)
    assert result.periods == ("2024", "2025")


def test_a_year_missing_one_month_is_not_measured_as_if_complete(pack):
    """RED ON: a hole treated as a shorter year. Dropping one period
    shrinks the denominator and inflates the final-period share — the same
    arithmetic that made the part-year fire, arriving as a data gap
    instead of as a calendar."""
    book, profile, _c = load_case("agras")
    full = [(y, m) for y in (2023, 2024, 2025) for m in range(1, 13)]
    holed = [ym for ym in full if ym != (2025, 6)]
    run = D.run_detectors(pack, _spine(book, holed), profile)
    result = _result(run, "ro_revenue_cutoff")
    # 2023 and 2024 are still complete, so the detector runs; 2025 must not
    # be among the years it measured.
    assert result.applicable, result.na_reason
    assert result.periods == ("2023", "2024"), (
        "a year missing June was measured as if complete: %r" % (result.periods,))


def test_the_month_that_closes_a_year_comes_from_the_pack(pack):
    """RED ON: a fiscal year end welded into the detector. December closes
    a Romanian statutory year; that is a jurisdiction fact, it lives in
    ``packs/ro/detectors.yaml``, and without it the detector refuses
    rather than assuming."""
    spec = pack.get("ro_revenue_cutoff")
    assert spec.params.get("fiscal_year_end_month") == 12
    source = (REPO / "src" / "engine" / "radar" / "detectors" /
              "fam_series.py").read_text(encoding="utf-8")
    assert "fiscal_year_end_month" in source
    assert not re.search(r"fiscal_year_end_month\s*(?:=|,)\s*1?\d\b", source), (
        "a fiscal year end is hardcoded in the detector")


def test_a_cadence_that_does_not_divide_the_year_is_refused(pack):
    """RED ON: inventing a complete year from a cadence that cannot make
    one. Five-month steps never land on a year boundary."""
    book, profile, _c = load_case("agras")
    months = [(2024, 1), (2024, 6), (2024, 11),
              (2025, 4), (2025, 9), (2026, 2)]
    run = D.run_detectors(pack, _spine(book, months), profile)
    result = _result(run, "ro_revenue_cutoff")
    assert not result.applicable
    assert "does not divide the year" in result.na_reason, result.na_reason


def test_month_cadence_refuses_a_spine_that_cannot_say_when_it_is():
    """RED ON: a cadence guessed from period ORDER. Ordinals are a sort
    key; they carry no calendar, and a year cannot be called complete
    against a sort key. A HOLE is not a lost cadence — months 1, 2, 5 is a
    monthly spine missing two periods, and the year that misses them is
    refused downstream by name."""
    book, _p, _c = load_case("agras")
    undated = D.BookSeries.of([
        D.PeriodBook(period_id="p%d" % i, label="P%d" % i, ordinal=i,
                     currency=book.currency, rows=book.rows,
                     year=None, month=None, basis=book.basis)
        for i in range(6)])
    assert FSER._month_cadence(undated) is None
    assert FSER._month_cadence(_spine(book, [(2025, 1), (2025, 2), (2025, 5)])) == 1
    assert FSER._month_cadence(_spine(book, MONTHS6)) == 1
    assert FSER._month_cadence(
        _spine(book, [(2024, 3), (2024, 6), (2024, 9), (2024, 12)])) == 3


def test_the_closed_year_month_set_is_derived_not_assumed():
    """RED ON: a quarterly spine being asked for twelve months, or a
    non-calendar year end being ignored."""
    assert FSER._months_of_closed_year(12, 1) == set(range(1, 13))
    assert FSER._months_of_closed_year(12, 3) == {3, 6, 9, 12}
    assert FSER._months_of_closed_year(6, 3) == {12, 3, 6, 9}
    assert FSER._months_of_closed_year(12, 5) is None
    assert FSER._months_of_closed_year(12, 0) is None


# ── D2 · a hole must break a quiet run ───────────────────────────────────
#
# `dormant` filtered the gaps out and then measured "consecutive" quiet
# periods over what was left, so 2023-01 and 2025-11 could read as
# neighbours. Dormancy is a claim about an UNBROKEN stretch of silence:
# an account missing from the book is not an account observed sitting
# still.


def _sundry_spine(book, months, present_in, factor_last):
    """The sundry-debtor account present only in `present_in`, flat, and
    moved in the final period."""
    def _mutate(row, i):
        if not row.code.startswith("461"):
            return row
        if i not in present_in:
            return None
        if i == len(months) - 1:
            from dataclasses import replace
            kw = dict((f, getattr(row, f) * factor_last)
                      for f in ("closing_debit", "closing_credit")
                      if getattr(row, f) is not None)
            return replace(row, **kw)
        return row

    books = []
    for i, (year, month) in enumerate(months):
        rows = tuple(r for r in (_mutate(r, i) for r in book.rows)
                     if r is not None)
        books.append(D.PeriodBook(
            period_id="p%d" % i, label="%04d-%02d" % (year, month), ordinal=i,
            currency=book.currency, rows=rows, year=year, month=month,
            basis=book.basis, days_covered=30))
    return D.BookSeries.of(books)


def test_a_gap_inside_the_quiet_stretch_breaks_the_run(pack):
    """RED ON: gaps filtered out before the run is measured. The account
    below is absent from the middle of the spine, so the longest stretch
    actually observed is shorter than the pack's `min_quiet_periods`, and
    the detector must say so instead of stitching the halves together."""
    book, profile, _c = load_case("agras")
    months = [(2025, m) for m in range(1, 9)]
    # present 0..5, ABSENT at 6, present at 7. Filtering the gap out leaves
    # seven "consecutive" periods — six flat ones and a 40x move — which is
    # a textbook reactivation. Honouring the gap leaves an unbroken tail of
    # ONE, which cannot carry a quiet run at all.
    series = _sundry_spine(book, months,
                           present_in={0, 1, 2, 3, 4, 5, 7},
                           factor_last=40.0)
    run = D.run_detectors(pack, series, profile)
    result = _result(run, "ro_sundry_debtor_reactivation")
    spec = pack.get("ro_sundry_debtor_reactivation")
    needed = int(spec.number("min_quiet_periods")) + 1
    assert not result.applicable, (
        "the unbroken run ending at the latest period is 1 period and the "
        "rule needs %d; this finding was built across a hole: %s"
        % (needed, result.reason))
    assert "no hole between" in result.na_reason, result.na_reason
    assert "is 1 period(s) long" in result.na_reason, result.na_reason
    assert "7 of 8 periods" in result.na_reason, result.na_reason


def test_an_unbroken_quiet_stretch_still_reactivates(pack):
    """The complement — RED ON: `contiguous_tail` truncating a run that
    has no hole in it. Same account, same movement, every period present."""
    book, profile, _c = load_case("agras")
    months = [(2025, m) for m in range(1, 9)]
    series = _sundry_spine(book, months, present_in=set(range(8)),
                           factor_last=40.0)
    run = D.run_detectors(pack, series, profile)
    result = _result(run, "ro_sundry_debtor_reactivation")
    assert result.applicable, result.na_reason
    assert result.fired, result.reason
    assert result.impact is not None


# ── D3 · the jurisdiction guard was blind to the literal it hunts ────────
#
# `_CODE` matched "RO"/"HU"/"ZZ" case-sensitively, but every pack loader in
# the tree LOWER-CASES the jurisdiction token before using it — so the
# shape a real weld takes is `if token == "ro":`, which the guard read
# straight past. One flag; zero hits on the current tree.


def test_the_jurisdiction_guard_sees_the_lower_case_literal():
    """RED ON: the guard's pattern losing its case-insensitivity. Asserted
    over the PATTERN rather than by planting a weld, so this test cannot
    itself leave a jurisdiction literal in the tree."""
    import test_e8_jurisdiction_blindness as E8
    quoted = E8.TOKEN_PATTERNS[0]
    for literal in ('"ro"', "'ro'", '"RO"', '"Ro"', "'hu'", '"zz"'):
        assert quoted.search("if token == %s:" % literal), (
            "the guard does not see %s — pack.py lower-cases the "
            "jurisdiction before comparing it, so lower case is the shape a "
            "real weld would take" % literal)


# ── D4 · an absent movement is not a movement of zero ────────────────────
#
# `ro_related_party_exposure` summed `abs(r.movement_signed() or 0.0)`.
# `canonical_bs` serves NO movement column on any persisted period, so
# every served book reported "related-party movement 0.0% of total assets"
# — a confident, printable, false zero, on a book where the ledger tier
# measures 2.12%.


def _strip_movements(book):
    from dataclasses import replace
    return replace(book, rows=tuple(
        replace(r, period_debit=None, period_credit=None) for r in book.rows))


def test_a_book_with_no_movement_column_omits_the_movement_figure(pack):
    """RED ON: ABSENT read as ZERO. The served tier carries closing
    balances only; the finding must simply not carry a movement figure
    rather than carry one that says nothing moved."""
    book, profile, _c = load_case("agras")
    run = D.run_detectors(pack, D.BookSeries.of([_strip_movements(book)]),
                          profile)
    result = _result(run, "ro_related_party_exposure")
    assert result.fired, result.reason
    names = [f.fact for f in result.figures]
    assert "interco_movement_share" not in names, (
        "a movement share was reported from a book that serves no movement "
        "column: %r" % [(f.fact, f.value) for f in result.figures])
    assert "interco_share" in names
    assert "interco_movement_share" not in result.facts


def test_a_book_that_does_carry_movements_reports_them(pack):
    """The complement — RED ON: the honest-absence rule swallowing a
    movement that IS served. The ledger tier carries the rulaj pair."""
    book, profile, _c = load_case("agras")
    run = D.run_detectors(pack, D.BookSeries.of([book]), profile)
    result = _result(run, "ro_related_party_exposure")
    assert result.fired, result.reason
    facts = result.facts
    assert "interco_movement_share" in facts, (
        "the ledger tier serves rulaj columns; the movement share must be "
        "measured from them")
    assert facts["interco_movement_share"] > 0.0


# ── D5 · a consequence that prints the same on both sides ────────────────
#
# `__post_init__` refused `impact=None` but accepted an impact whose two
# endpoints render identically, so a HIGH finding could surface reading
# "moves from 0.0% to 0.0% (-0.0%)". The check is against the RENDERER,
# not a tolerance: what the unit rounds away is exactly what the reader
# cannot see.


def test_an_impact_that_renders_the_same_on_both_sides_is_refused():
    """RED ON: a fired result carrying a tautological consequence."""
    impact = F.ratio_impact(
        metric="subject_share", metric_label="a share of total assets",
        numerator=SUP.money_q(3.26e-4, "RON", "a"),
        denominator=SUP.money_q(1.0, "RON", "b"),
        adjusted_numerator=SUP.money_q(1.38e-4, "RON", "c"),
        unit=F.UNIT_PERCENT)
    with pytest.raises(RES.UnquantifiedFindingError) as caught:
        RES.DetectorResult(detector_id="probe", family="concentration",
                           fired=True, reason="something", impact=impact)
    message = str(caught.value)
    assert "prints as '0.0%' on both sides" in message, message
    assert "probe" in message


def test_an_impact_that_moves_a_visible_amount_is_accepted():
    """RED ON: the guard rejecting a real consequence. 41.2% -> 17.5% is
    the same METRIC at a size the statement prints."""
    impact = F.ratio_impact(
        metric="subject_share", metric_label="a share of total assets",
        numerator=SUP.money_q(412.0, "RON", "a"),
        denominator=SUP.money_q(1000.0, "RON", "b"),
        adjusted_numerator=SUP.money_q(175.0, "RON", "c"),
        unit=F.UNIT_PERCENT)
    result = RES.DetectorResult(detector_id="probe", family="concentration",
                                fired=True, reason="something", impact=impact)
    assert result.impact is not None


def test_every_finding_on_every_real_book_carries_a_visible_consequence(pack):
    """The corpus statement of the same law. RED ON: any real book
    producing a finding whose impact renders identically on both sides."""
    seen = 0
    for case in ("agras", "carniprod", "retail", "realestate"):
        book, profile, _c = load_case(case)
        run = D.run_detectors(pack, D.BookSeries.of([book]), profile)
        for result in run.results:
            if not result.fired or result.impact is None:
                continue
            seen += 1
            currency = result.impact.currency or book.currency
            before = F._format_value(result.impact.baseline,
                                     result.impact.unit, currency)
            after = F._format_value(result.impact.adjusted,
                                    result.impact.unit, currency)
            assert before != after, (
                "%s on %s renders 'moves from %s to %s'"
                % (result.detector_id, case, before, after))
    assert seen > 0, "no real book produced a fired finding; gate is vacuous"


# ── D6 · a concentration inside an immaterial balance is not a finding ───
#
# Found BY the D5 guard rather than by a reader: on the realestate book
# one counterparty carries 57% of a receivable ledger that is itself
# 0.03% of total assets. A true ratio, a HIGH severity, and a consequence
# of nothing — removing that counterparty outright leaves the balance
# sheet unchanged at the precision it is printed to.


def test_a_concentration_below_the_material_floor_does_not_surface(pack):
    """RED ON: the materiality floor disappearing. The realestate book's
    receivable ledger is the measured case."""
    book, profile, _c = load_case("realestate")
    run = D.run_detectors(pack, D.BookSeries.of([book]), profile)
    result = _result(run, "ro_receivable_concentration")
    assert result.applicable, result.na_reason
    assert not result.fired, result.reason
    # the parameter reported is the one that ACTUALLY decided it
    assert result.parameter == "min_subject_share_of_basis", (
        "reporting min_share here would say the counterparty share fell "
        "short, and it did not: %s" % result.reason)
    assert result.observed < result.limit
    assert "would not move the balance sheet" in result.reason


def test_the_material_floor_is_pack_data(pack):
    """RED ON: the floor moving into the detector. How large a line must
    be before it can matter is policy about the reader's book (TC-10)."""
    spec = pack.get("ro_receivable_concentration")
    assert spec.number("min_subject_share_of_basis") > 0
    source = Path(REPO / "src" / "engine" / "radar" / "detectors" /
                  "fam_static.py").read_text(encoding="utf-8")
    assert "min_subject_share_of_basis" in source
    assert not re.search(r"min_subject\s*=\s*0?\.\d", source), (
        "a materiality floor is hardcoded in the detector")


def test_a_material_concentration_still_surfaces(pack):
    """The complement, and the proof this floor did not silence the
    family — RED ON: the floor set so high nothing can clear it."""
    fired = []
    for case in ("agras", "carniprod", "retail", "realestate"):
        book, profile, _c = load_case(case)
        run = D.run_detectors(pack, D.BookSeries.of([book]), profile)
        result = _result(run, "ro_receivable_concentration")
        if result.fired:
            fired.append((case, result))
    assert fired, (
        "the materiality floor silenced the concentration family on every "
        "real book in the corpus")
    for case, result in fired:
        assert result.impact is not None
        assert result.facts["subject_share"] >= pack.get(
            "ro_receivable_concentration").number("min_subject_share_of_basis")
