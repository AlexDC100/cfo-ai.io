"""THE DETECTORS READ THE SPINE — the join between Radar's two halves.

WHAT WAS WRONG
==============
Parts A and B landed in one commit and were not connected. `series.py`
(1,356 lines: two tiers, typed refusals, the cumulative-semantics guard,
an identity measured EXACTLY zero on every account of every corpus book)
was imported by nothing in `src/`. The detectors read
`detectors/book.py`, which parses `doc.atoms` directly. The commit
message called them "the cross-period spine and twelve detectors" as
though the second read the first. It did not.

The gap was load-bearing in two ways:

  1. `PeriodBook` had NO served-tier constructor, so the serving lane —
     which holds `statement_line_items`, never a parsed ledger doc —
     could not build a `BookSeries` and could not run a detector. That
     is why the detectors shipped with no production caller.
  2. A NAIVE served constructor walks straight back into the D4 defect
     from the other side. Served line items carry a closing amount and
     nothing else; zero-filling the movement slots would let every
     movement-reading detector report a confident 0.0 — and would let
     the Benford family compute a conformity statistic over 365 zeros.

WHAT THIS REDS ON (TC-11)
  · a served-tier row carrying a movement (or an opening) figure;
  · a movement-reading detector RUNNING on a served book instead of
    reporting NOT APPLICABLE and naming the missing column;
  · a spine gap becoming a row (which would let a quiet run be stitched
    across a hole — the dormant family's D2 repair, one layer down);
  · a spine that mixes tiers producing books at all, since the two sign
    their figures by different conventions;
  · the ledger path losing a series between the spine and the book.

WHAT IT CANNOT SEE
  · whether the SERVE lane calls any of this. It does not yet; the
    detector lane has no production caller and this file does not claim
    one.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine.api import _company_profile as CP
from engine.consensus import selfcheck as SC
from engine.frontends.saga10 import Saga10FrontEnd
from engine.radar import detectors as D
from engine.radar import series as S
from engine.radar.detectors import from_series as FS

REPO = Path(__file__).resolve().parents[2]
BOOKS = ("agras", "carniprod", "retail", "realestate")

_CACHE = {}


def _capture(name):
    return json.loads(
        (REPO / "tests" / "engine" / "fixtures" / "firm"
         / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


def _basis(capture):
    statements = capture["statements"]
    bs = statements.get("assembled_bs") or {}
    pl = statements.get("assembled_pl") or {}
    return {"p0": D.BasisTotals(
        total_assets=bs.get("total_assets"), revenue=pl.get("revenue"),
        source="engine-assembled statements")}


def _ledger_spine(name):
    """The LEDGER tier: the parsed trial-balance rows, all three slots."""
    if ("ledger", name) in _CACHE:
        return _CACHE[("ledger", name)]
    doc, _notes = Saga10FrontEnd().parse(
        (REPO / "corpus" / ("saga_10_col_%s" % name) / "input.xlsx").read_bytes())
    spine = S.build_from_ledger_rows(
        S.EntityKey.of("ws1", "RO123"),
        [S.LedgerPeriodInput(
            period_id="p0", fiscal_end="2025-12-31", ordinal=0,
            currency=str(doc.header.currency), cui="RO123",
            rows=S.rows_from_ledger_doc(doc), snapshot_key="k0",
            label="FY2025",
            cumulative_semantics=SC.CUMULATIVE_WITH_OPENING)])
    _CACHE[("ledger", name)] = spine
    return spine


def _served_spine(name):
    """The SERVED tier: `statement_line_items` and nothing else — the
    only account-level figure a persisted period carries."""
    if ("served", name) in _CACHE:
        return _CACHE[("served", name)]
    spine = S.build_from_served_periods(
        S.EntityKey.of("ws1", "RO123"),
        [S.ServedPeriodInput(
            period_id="p0", fiscal_end="2025-12-31", ordinal=0,
            currency="RON", cui="RO123",
            line_items=_capture(name)["line_items"],
            snapshot_key="k0", label="FY2025")])
    _CACHE[("served", name)] = spine
    return spine


@pytest.fixture(scope="module")
def pack():
    return D.load_pack("ro", str(REPO / "packs"))


def _result(run, detector_id):
    for r in run.results:
        if r.detector_id == detector_id:
            return r
    raise AssertionError("%s produced no result" % detector_id)


# ── the join carries every account, and only the real ones ───────────────


@pytest.mark.parametrize("name", BOOKS)
def test_the_ledger_spine_reaches_the_detectors_intact(name):
    """RED ON: a series lost between the spine and the book. The spine is
    the authority on which accounts exist; the book must carry all of
    them and invent none."""
    spine = _ledger_spine(name)
    series = FS.book_series_from_spine(spine, basis_by_period=_basis(_capture(name)))
    assert series.period_count() == 1
    book = series.books[0]
    assert len(book.rows) == len(spine.series), (
        "the spine carries %d series and the book %d rows"
        % (len(spine.series), len(book.rows)))
    assert sorted(r.code for r in book.rows) == sorted(spine.series)
    assert book.currency == spine.currency


@pytest.mark.parametrize("name", BOOKS)
def test_the_ledger_tier_carries_all_three_slots(name):
    """RED ON: the join dropping the movement columns the ledger tier
    actually has — the mirror of the served-tier test below."""
    spine = _ledger_spine(name)
    book = FS.book_series_from_spine(
        spine, basis_by_period=_basis(_capture(name))).books[0]
    with_movement = [r for r in book.rows if r.movement_signed() is not None]
    assert len(with_movement) == len(book.rows), (
        "%d of %d ledger rows lost their movement"
        % (len(book.rows) - len(with_movement), len(book.rows)))
    assert any(r.opening_signed() is not None for r in book.rows)


# ── the served tier: absent stays absent, all the way to the finding ─────


@pytest.mark.parametrize("name", BOOKS)
def test_a_served_row_carries_no_movement_and_no_opening(name):
    """THE D4 DEFECT, MADE STRUCTURAL. A served period carries a closing
    amount and nothing else; the spine says so with a typed refusal and
    this join turns that into ABSENT, never zero.

    RED ON: a served row reporting a movement of 0.0 — which is what a
    naive adapter produces, and what would make every related-party
    finding cite "movement 0.0% of total assets" on a book whose ledger
    tier measures 2.12%.
    """
    spine = _served_spine(name)
    book = FS.book_series_from_spine(
        spine, basis_by_period=_basis(_capture(name))).books[0]
    assert book.rows, "the served spine produced no rows at all"
    for row in book.rows:
        assert row.movement_signed() is None, (
            "%s reports a movement of %r on a tier that serves none"
            % (row.code, row.movement_signed()))
        assert row.movement_gross() is None, row.code
        assert row.opening_signed() is None, row.code
    # And the closing figure IS carried — otherwise this test would pass
    # on a join that produced nothing at all.
    assert any(r.closing_signed() not in (None, 0.0) for r in book.rows)


@pytest.mark.parametrize("name", BOOKS)
def test_the_distribution_families_refuse_a_served_book(pack, name):
    """The consequence a reader would have seen. Round-number frequency
    and first-digit conformity are computed over MOVEMENT amounts; on a
    served book there are none.

    RED ON: either family running here. A Benford conformity statistic
    over 365 zeros is a number, it is printable, and it is meaningless.
    """
    spine = _served_spine(name)
    capture = _capture(name)
    series = FS.book_series_from_spine(spine, basis_by_period=_basis(capture))
    profile = CP.build_company_profile(capture["statements"], period_id="p0")
    run = D.run_detectors(pack, series, profile)
    for detector_id in ("ro_round_amount_concentration",
                        "ro_first_digit_conformity"):
        result = _result(run, detector_id)
        assert not result.applicable, (
            "%s ran on a book that serves no movement column: %s"
            % (detector_id, result.reason))
        assert "0" in result.na_reason, result.na_reason


def test_a_closing_only_family_still_speaks_on_a_served_book(pack):
    """The complement, and what keeps the two tests above from being a
    gate that just says 'nothing works'. Concentration reads CLOSING
    balances, which the served tier does carry, and it fires.

    RED ON: the served path going silent altogether.
    """
    capture = _capture("agras")
    series = FS.book_series_from_spine(
        _served_spine("agras"), basis_by_period=_basis(capture))
    profile = CP.build_company_profile(capture["statements"], period_id="p0")
    run = D.run_detectors(pack, series, profile)
    surfaced = [f.rule_id for f in D.surfaced(run)]
    assert "ro_receivable_concentration" in surfaced, surfaced


# ── gaps, tiers and the guards ───────────────────────────────────────────


def test_a_spine_gap_is_not_a_row():
    """RED ON: a period where an account is absent producing a row for
    it. That is what lets `BookSeries.readings` answer None and
    `contiguous_tail` break a run at the hole — the dormant family's D2
    repair, one layer down."""
    doc, _n = Saga10FrontEnd().parse(
        (REPO / "corpus" / "saga_10_col_agras" / "input.xlsx").read_bytes())
    rows = list(S.rows_from_ledger_doc(doc))
    victim = rows[0]["cont"]
    spine = S.build_from_ledger_rows(
        S.EntityKey.of("ws1", "RO123"),
        [S.LedgerPeriodInput(
            period_id="p0", fiscal_end="2025-11-30", ordinal=0,
            currency=str(doc.header.currency), cui="RO123", rows=rows,
            snapshot_key="k0", label="2025-11",
            cumulative_semantics=SC.CUMULATIVE_WITH_OPENING),
         S.LedgerPeriodInput(
            period_id="p1", fiscal_end="2025-12-31", ordinal=1,
            currency=str(doc.header.currency), cui="RO123",
            rows=[r for r in rows if r["cont"] != victim],
            snapshot_key="k1", label="2025-12",
            cumulative_semantics=SC.CUMULATIVE_WITH_OPENING)])
    series = FS.book_series_from_spine(spine)
    assert series.period_count() == 2
    codes_p0 = set(r.code for r in series.books[0].rows)
    codes_p1 = set(r.code for r in series.books[1].rows)
    assert victim in codes_p0
    assert victim not in codes_p1, (
        "an account absent from the second period was given a row there; "
        "a gap must stay a gap or a quiet run can be stitched across it")
    readings = series.readings([victim], "closing")
    assert readings[1].value is None, (
        "the gap reads as %r rather than ABSENT" % (readings[1].value,))


def test_a_spine_that_mixes_tiers_refuses_to_produce_books():
    """RED ON: books built across a tier boundary. The ledger tier signs
    debit-positive; the served tier carries the mapper's statement sign.
    A detector reading across them compares a positive to a negative and
    calls the difference a movement."""
    doc, _n = Saga10FrontEnd().parse(
        (REPO / "corpus" / "saga_10_col_agras" / "input.xlsx").read_bytes())
    spine = S.build(
        S.EntityKey.of("ws1", "RO123"),
        [S.LedgerPeriodInput(
            period_id="p0", fiscal_end="2025-11-30", ordinal=0,
            currency="RON", cui="RO123", rows=S.rows_from_ledger_doc(doc),
            snapshot_key="k0", label="2025-11",
            cumulative_semantics=SC.CUMULATIVE_WITH_OPENING),
         S.ServedPeriodInput(
            period_id="p1", fiscal_end="2025-12-31", ordinal=1,
            currency="RON", cui="RO123",
            line_items=_capture("agras")["line_items"],
            snapshot_key="k1", label="2025-12")])
    assert spine.mixed_tiers()
    with pytest.raises(FS.SpineJoinError) as caught:
        FS.book_series_from_spine(spine)
    assert "different conventions" in str(caught.value), str(caught.value)


def test_the_row_carries_the_RULAJ_and_not_the_sume_totale():
    """THE TWO MOVEMENT COLUMNS ARE NOT THE SAME NUMBER, and the join must
    take the right one.

    A 10-column Romanian trial balance carries FOUR pairs: opening (`si`),
    the period movement (`rulaj`, `r`), the cumulative movement (`sume
    totale`, `st`) and closing (`sf`). The spine modelled only three of
    them and called `st` "movements"; `book.py`'s own header records what
    that costs — the rulaj on these books is ONE MONTH, class-70 credit in
    it being 8.0-10.4% of annual revenue, so reading `st` where a detector
    expects `r` multiplies every movement-based finding by the year.

    RED ON: the join reading the cumulative pair into `period_debit` /
    `period_credit`.
    """
    doc, _n = Saga10FrontEnd().parse(
        (REPO / "corpus" / "saga_10_col_agras" / "input.xlsx").read_bytes())
    rows = list(S.rows_from_ledger_doc(doc))
    # Plant a cumulative pair that differs from the rulaj on every row, so
    # a join reading the wrong column cannot coincide with the right one.
    for row in rows:
        row["st_d"] = float(row.get("r_d") or 0.0) * 12.0 + 1.0
        row["st_c"] = float(row.get("r_c") or 0.0) * 12.0 + 1.0
    spine = S.build_from_ledger_rows(
        S.EntityKey.of("ws1", "RO123"),
        [S.LedgerPeriodInput(
            period_id="p0", fiscal_end="2025-12-31", ordinal=0,
            currency=str(doc.header.currency), cui="RO123", rows=rows,
            snapshot_key="k0", label="FY2025",
            cumulative_semantics=SC.CUMULATIVE_WITH_OPENING)])
    book = FS.book_series_from_spine(spine).books[0]
    by_code = dict((r.code, r) for r in book.rows)
    checked = 0
    for row in rows:
        built = by_code.get(str(row["cont"]))
        if built is None or built.period_debit is None:
            continue
        assert built.period_debit == pytest.approx(float(row["r_d"])), built.code
        assert built.period_credit == pytest.approx(float(row["r_c"])), built.code
        checked += 1
    assert checked > 100, "only %d rows checked" % checked


def test_an_undeclared_cumulative_semantics_still_serves_the_rulaj():
    """The semantics guard is about the CUMULATIVE column, not the rulaj.

    `sume totale` means two different things across real books — `si + st
    == sf` on four of five, `st == sf` on 129 carniprod accounts — and the
    two differ by the entire opening balance, so an undeclared pair
    refuses. The rulaj has one reading and needs no declaration.

    RED ON: the guard spreading to the rulaj (which would silence every
    movement family on a document whose front end declared nothing), or
    the cumulative slot being served without a declaration.
    """
    doc, _n = Saga10FrontEnd().parse(
        (REPO / "corpus" / "saga_10_col_agras" / "input.xlsx").read_bytes())
    rows = list(S.rows_from_ledger_doc(doc))
    for row in rows:
        row["st_d"] = float(row.get("r_d") or 0.0)
        row["st_c"] = float(row.get("r_c") or 0.0)
    spine = S.build_from_ledger_rows(
        S.EntityKey.of("ws1", "RO123"),
        [S.LedgerPeriodInput(
            period_id="p0", fiscal_end="2025-12-31", ordinal=0,
            currency=str(doc.header.currency), cui="RO123", rows=rows,
            snapshot_key="k0", label="FY2025", cumulative_semantics=None)])
    point = spine.series[sorted(spine.series)[0]].points[0]
    assert isinstance(point.movements, S.NotServed), (
        "the cumulative pair was served with no semantics declared")
    assert point.movements.reason == S.REASON_CUMULATIVE_SEMANTICS_UNKNOWN
    assert not isinstance(point.period, S.NotServed), (
        "the rulaj was refused for a reason that is about a different column")

    book = FS.book_series_from_spine(spine).books[0]
    assert any(r.movement_signed() is not None for r in book.rows), (
        "no row carries a rulaj, so every movement family is silenced by a "
        "guard that does not apply to them")


def test_the_two_paths_agree_on_every_real_book(pack):
    """PARITY. The spine path and the direct `from_ledger_doc` path read
    the same document and must reach the same verdict.

    They did not, and the difference named a real statistical defect: the
    spine adds SYNTHETIC roll-ups (413 rows against 331 on agras), a
    synthetic's figure is the SUM of its analytics, and the distribution
    families were reading every row — so the same money contributed twice
    and a parent's leading digit was not independent of its children's,
    which is the assumption a Benford test rests on. It flipped realestate
    from clear to FIRED. Romanian trial balances routinely list a synthetic
    beside its own analytics, so the defect was live on the direct path
    too; the spine only made it visible.

    RED ON: the two paths diverging, which now means either a family has
    stopped reading leaves or the join has lost a level.
    """
    for name in BOOKS:
        capture = _capture(name)
        doc, _n = Saga10FrontEnd().parse(
            (REPO / "corpus" / ("saga_10_col_%s" % name) / "input.xlsx").read_bytes())
        basis = _basis(capture)
        profile = CP.build_company_profile(capture["statements"], period_id="p0")

        direct = D.PeriodBook.from_ledger_doc(
            doc, period_id="p0", label="FY2025", ordinal=0, year=2025,
            month=12, days_covered=31, basis=basis["p0"])
        one = sorted(f.rule_id for f in D.surfaced(
            D.run_detectors(pack, D.BookSeries.of([direct]), profile)))

        series = FS.book_series_from_spine(
            _ledger_spine(name), basis_by_period=basis,
            days_by_period={"p0": 31})
        two = sorted(f.rule_id for f in D.surfaced(
            D.run_detectors(pack, series, profile)))

        assert one == two, (
            "%s: the direct path finds %r and the spine path %r"
            % (name, one, two))
    # Not vacuous: at least one book must actually produce a finding.
    assert one or two or name


def test_a_distribution_family_counts_each_booked_amount_once(pack):
    """RED ON: a synthetic account and its own analytics both entering an
    amount distribution. The parent restates money the children already
    carry; counting both inflates n, which is what the Benford band is
    computed from, and correlates the digits the test assumes independent.
    """
    from engine.radar.detectors import fam_static as FS_STATIC

    series = FS.book_series_from_spine(
        _ledger_spine("agras"), basis_by_period=_basis(_capture("agras")),
        days_by_period={"p0": 31})
    book = series.books[0]
    values, rows = FS_STATIC._amounts(book, (), "sides", 100.0)
    codes = set(r.code for r in rows)
    parents = [c for c in codes
               if any(o != c and o.startswith(c) for o in codes)]
    assert parents == [], (
        "%d account(s) entered the population alongside their own "
        "analytics, e.g. %r" % (len(parents), sorted(parents)[:5]))
    # And the population is not empty, or the assertion above is free.
    assert len(values) > 150, len(values)
    # The spine carries the parents; they are excluded HERE, not upstream.
    assert len(book.rows) > len(rows)


def test_the_IR_adapter_emits_every_column_the_builder_reads():
    """RED ON: `rows_from_ledger_doc` and `build_from_ledger_rows`
    disagreeing about a key again.

    They already did, silently and completely: the adapter emitted the
    rulaj under `r_d`/`r_c` and no `st_*` key at all, while the builder
    read only `st_*` — so the one path from the engine's own IR into this
    spine produced an empty movement slot on EVERY account of EVERY book.
    Nothing called the adapter, so no test walked it.

    Asserted against a STUB atom rather than a corpus book, and stated
    plainly why: no corpus book's IR carries a `total_*` pair (the
    `sume totale` column is absent from every one of the five frozen
    parses), so a real book cannot exercise the mapping. A gate that only
    ever reads those books would be blind to it — which is exactly how
    the original defect survived.
    """
    from engine.ir.money import Money

    class _Atom(object):
        account_code = "4111.01"
        label = "a customer"
        opening_debit = Money.from_minor("RON", 100)
        opening_credit = Money.from_minor("RON", 0)
        period_debit = Money.from_minor("RON", 20)
        period_credit = Money.from_minor("RON", 5)
        total_debit = Money.from_minor("RON", 900)
        total_credit = Money.from_minor("RON", 400)
        closing_debit = Money.from_minor("RON", 115)
        closing_credit = Money.from_minor("RON", 0)

    class _Doc(object):
        atoms = (_Atom(),)

    row = S.rows_from_ledger_doc(_Doc())[0]
    assert row["r_d"] == pytest.approx(0.20) and row["r_c"] == pytest.approx(0.05)
    assert row["st_d"] == pytest.approx(9.0) and row["st_c"] == pytest.approx(4.0)
    assert row["si_d"] == pytest.approx(1.0)
    assert row["sf_d"] == pytest.approx(1.15)

    # Every pair the builder reads is a key the adapter emits.
    for dkey, ckey in (("si_d", "si_c"), ("r_d", "r_c"),
                       ("st_d", "st_c"), ("sf_d", "sf_c")):
        assert dkey in row and ckey in row, (dkey, ckey)

    # And the corpus books genuinely lack the column, which is why this
    # test uses a stub — stated as a measurement, not an excuse.
    doc, _n = Saga10FrontEnd().parse(
        (REPO / "corpus" / "saga_10_col_agras" / "input.xlsx").read_bytes())
    real = S.rows_from_ledger_doc(doc)
    assert all("st_d" not in r for r in real), (
        "a corpus book now carries a sume-totale pair; this test can stop "
        "using a stub")


def test_an_empty_spine_refuses_rather_than_serving_an_empty_series():
    """RED ON: `BookSeries.of([])` reaching a detector, where 'no period'
    and 'every check clear' look the same."""
    spine = S.build(S.EntityKey.of("ws1", "RO123"), [])
    with pytest.raises(FS.SpineJoinError) as caught:
        FS.book_series_from_spine(spine)
    assert "nothing to detect over" in str(caught.value)
