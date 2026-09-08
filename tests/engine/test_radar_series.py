"""RADAR PART A — the cross-period spine (`engine.radar.series`).

Every subject here is a REAL book: the frozen extraction artifacts under
`corpus/<case>/expected/extraction.json`, which are the deterministic
parser's own output for `corpus/<case>/input.xlsx` (TC-1). No trial
balance is invented anywhere in this file; the one multi-period spine is
CONSTRUCTED from a single real book's OWN opening column and is labelled
as such at its point of use.

What each gate reds on, AFTER the module is correct (TC-11):

  entity        a build that admits a second CUI, or one that admits a
                period with no CUI at all. It CANNOT see a caller who
                lies about the CUI on the input — identity plumbing is
                the next wave's job.
  gaps          a `points` tuple shorter than `periods`; a gap rendered
                as a zero; a run measured across a hole.
  absent        an opening or movement figure appearing on a served-tier
                period, where the engine does not produce one; a missing
                column pair read as 0-0.
  semantics     a movement served from an undeclared cumulative pair.
                It CANNOT see a front-end that DECLARES the wrong
                semantics — that is what `identity()`'s residual is for,
                and the gate pins the residual's behaviour instead.
  rollup        an analytic account that stops being addressable once it
                rolls up; a synthetic sum that disagrees with its
                contributors by a cent; a synthetic that invents a
                figure none of its contributors served.
  units         a set that admits two currencies; a ratio formed across
                a converted operand.
  determinism   a key or a payload that differs between two builds of
                the same inputs, or that depends on input order.
  cold start    a spine under three periods that does not say so.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine.api import _ratio_units as U
from engine.consensus.selfcheck import (
    CUMULATIVE_MOVEMENTS,
    CUMULATIVE_WITH_OPENING,
)
from engine.ir.money import Money
from engine.radar import series as S

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"

WORKSPACE = "ws-radar-series"
CUI = "12345678"

#: The five real 10-column books, with the cumulative-pair semantics each
#: one actually uses. Not a preference — a MEASUREMENT: the identity
#: `closing == opening + cumulative` holds for every account of four of
#: them and for none of carniprod's balance-sheet accounts, where
#: `closing == cumulative` holds instead. Both readings are legal SAGA
#: exports and they differ by the entire opening balance.
BOOKS = {
    "saga_10_col": CUMULATIVE_MOVEMENTS,
    "saga_10_col_agras": CUMULATIVE_MOVEMENTS,
    "saga_10_col_carniprod": CUMULATIVE_WITH_OPENING,
    "saga_10_col_realestate": CUMULATIVE_MOVEMENTS,
    "saga_10_col_retail": CUMULATIVE_MOVEMENTS,
}

#: Recorded expectations (TC-6), measured from the real books on
#: 2026-09-08 with `engine.radar.series.build`. source rows -> (analytic
#: series, synthetic series). A change to any of these is a change to
#: what the spine says a book contains, and must be re-recorded on
#: purpose.
EXPECTED_SHAPE = {
    "saga_10_col": (382, 382, 113),
    "saga_10_col_agras": (331, 331, 82),
    "saga_10_col_carniprod": (367, 367, 91),
    "saga_10_col_realestate": (165, 165, 74),
    "saga_10_col_retail": (582, 582, 83),
}

#: One worked account of one real book, to the cent. agras `4111.01`:
#: opening 2,739,136.01 + movements 1,861,508.58 = closing 4,600,644.59
#: RON, and it rolls into `411` beside three siblings while staying its
#: own series.
WORKED_CODE = "4111.01"
WORKED_OPENING_MINOR = 273913601
WORKED_MOVEMENTS_MINOR = 186150858
WORKED_CLOSING_MINOR = 460064459
WORKED_SYNTHETIC = "411"
WORKED_SIBLINGS = ("4111.01", "4111.02", "4111.03", "4111.10")


def rows_of(case):  # type: (str) -> list
    path = CORPUS / case / "expected" / "extraction.json"
    with open(str(path), "r", encoding="utf-8") as handle:
        return json.load(handle)["rows"]


def entity():  # type: () -> S.EntityKey
    return S.EntityKey.of(WORKSPACE, CUI)


def ledger_period(case, period_id="p-2025", fiscal_end="2025-12-31",
                  ordinal=1, semantics=None, rows=None, currency="RON",
                  cui=CUI):
    return S.LedgerPeriodInput(
        period_id=period_id, fiscal_end=fiscal_end, ordinal=ordinal,
        currency=currency, cui=cui,
        rows=(rows_of(case) if rows is None else rows),
        snapshot_key="content:%s:%s" % (case, period_id),
        cumulative_semantics=(BOOKS.get(case) if semantics is None
                              else semantics),
        source_document_id="doc-%s" % case)


# ── The shape of a real book ─────────────────────────────────────────────


@pytest.mark.parametrize("case", sorted(BOOKS))
def test_a_real_book_builds_both_levels(case):
    """Every real 10-column book yields one analytic series per source
    row and a synthetic layer above it, and the counts are recorded."""
    built = S.build(entity(), [ledger_period(case)])
    rows, analytic, synthetic = EXPECTED_SHAPE[case]
    assert len(rows_of(case)) == rows
    assert len(built.analytic_codes()) == analytic, (
        "%s: %d analytic series for %d source rows — every source account "
        "must stay addressable at its own code AFTER it rolls up"
        % (case, len(built.analytic_codes()), rows))
    assert len(built.synthetic_codes()) == synthetic, (
        "%s: %d synthetic series, recorded %d"
        % (case, len(built.synthetic_codes()), synthetic))
    assert len(built.series) == analytic + synthetic
    assert built.currency == "RON"
    assert built.period_count() == 1


@pytest.mark.parametrize("case", sorted(BOOKS))
def test_opening_plus_movements_equals_closing_to_the_cent(case):
    """The layout-conditional identity, per account, in integer minor
    units — the same two forms `engine.consensus.selfcheck.movement_leg`
    runs, applied one account at a time so a residual is attributable.

    Every account of every real book is EXACT. A residual of one cent
    anywhere reds this."""
    built = S.build(entity(), [ledger_period(case)])
    checked = 0
    for code in built.codes():
        check = built.require(code).points[0].identity()
        assert check.checkable, (code, check.reason)
        assert check.semantics == BOOKS[case]
        assert check.residual_minor == 0, (
            "%s %s: closing - (opening + movements) = %d minor"
            % (case, code, check.residual_minor))
        checked += 1
    assert checked == sum(EXPECTED_SHAPE[case][1:])


def test_the_worked_account_to_the_cent():
    """agras 4111.01, verbatim, with its rollup."""
    built = S.build(entity(), [ledger_period("saga_10_col_agras")])
    point = built.require(WORKED_CODE).points[0]
    assert point.net(S.SLOT_OPENING).amount_minor == WORKED_OPENING_MINOR
    assert point.net(S.SLOT_MOVEMENTS).amount_minor == WORKED_MOVEMENTS_MINOR
    assert point.net(S.SLOT_CLOSING).amount_minor == WORKED_CLOSING_MINOR
    assert (WORKED_OPENING_MINOR + WORKED_MOVEMENTS_MINOR
            == WORKED_CLOSING_MINOR)
    assert point.identity().residual_minor == 0
    # Both levels retained: the analytic is still its own series, and the
    # synthetic knows exactly who it is made of.
    assert built.require(WORKED_CODE).level == S.LEVEL_ANALYTIC
    assert built.require(WORKED_SYNTHETIC).level == S.LEVEL_SYNTHETIC
    assert built.children_of(WORKED_SYNTHETIC) == WORKED_SIBLINGS
    assert built.require(WORKED_SYNTHETIC).points[0].contributors == WORKED_SIBLINGS


@pytest.mark.parametrize("case", sorted(BOOKS))
def test_a_synthetic_is_exactly_the_sum_of_its_contributors(case):
    """Rollup is a sum of the period's own analytic points, to the cent,
    on both legs — not a re-read of anything."""
    built = S.build(entity(), [ledger_period(case)])
    for synthetic in built.synthetic_codes():
        children = built.children_of(synthetic)
        assert children, synthetic
        parent = built.require(synthetic).points[0]
        for slot in S.SLOTS:
            figure = parent.net(slot)
            if figure is None:
                continue
            total = sum(built.require(c).points[0].net(slot).amount_minor
                        for c in children)
            assert figure.amount_minor == total, (synthetic, slot)


# ── ABSENT != ZERO ───────────────────────────────────────────────────────


def served_period(period_id="p-2025", fiscal_end="2025-12-31", ordinal=1,
                  items=None, cui=CUI, currency="RON"):
    return S.ServedPeriodInput(
        period_id=period_id, fiscal_end=fiscal_end, ordinal=ordinal,
        currency=currency, cui=cui,
        line_items=(items if items is not None else [
            {"ro_account_code": "4111.01", "ro_account_name": "Client A",
             "amount": 4600644.59, "bucket": "ar", "statement": "BS"},
            {"ro_account_code": "4111.02", "ro_account_name": "Client B",
             "amount": 0.0, "bucket": "ar", "statement": "BS"},
        ]),
        snapshot_key="content:served:%s" % period_id,
        source_document_id="doc-served")


def test_the_served_tier_refuses_opening_and_movements_naming_the_producer():
    """The engine does not produce a per-account opening or movement on a
    persisted period. The spine says so, with a typed refusal that names
    the producer — it never fills the hole with a zero."""
    built = S.build(entity(), [served_period()])
    point = built.require("4111.01").points[0]
    assert point.tier == S.TIER_SERVED
    for slot in (S.SLOT_OPENING, S.SLOT_MOVEMENTS):
        held = getattr(point, slot)
        assert isinstance(held, S.NotServed)
        assert held.reason == S.REASON_TIER_SERVED_CLOSING_ONLY
        assert "canonical_adapter.py:1360" in held.detail
        assert point.net(slot) is None
    assert point.net(S.SLOT_CLOSING).amount_minor == 460064459
    assert point.closing.bucket == "ar"
    assert not point.identity().checkable


def test_a_stated_zero_is_a_figure_and_an_absent_column_is_not():
    """4111.02 is served as 0.00 — the book STATES nil, and that is a
    Money. The opening column of the same period is ABSENT, and that is
    a NotServed. The two must never be the same object."""
    built = S.build(entity(), [served_period()])
    zero = built.require("4111.02").points[0]
    assert zero.net(S.SLOT_CLOSING) == Money.from_minor("RON", 0)
    assert zero.has(S.SLOT_CLOSING)
    assert not zero.has(S.SLOT_OPENING)
    assert isinstance(zero.opening, S.NotServed)


def test_a_missing_column_pair_refuses_rather_than_reading_zero_minus_zero():
    """A four-column closing-only export carries no opening pair. Reading
    it as 0 - 0 = 0 would turn 'we don't know' into 'the book says nil'."""
    rows = [{"cont": "5121.01", "nume_cont": "Banca", "sf_d": 1000.0,
             "sf_c": 0.0}]
    built = S.build(entity(), [ledger_period(
        "saga_10_col_agras", rows=rows, semantics=CUMULATIVE_MOVEMENTS)])
    point = built.require("5121.01").points[0]
    assert isinstance(point.opening, S.NotServed), (
        "the source row carries no opening pair, so the opening slot must "
        "REFUSE; it holds %r — an absent column read as 0 - 0 = 0"
        % (point.opening,))
    assert point.opening.reason == S.REASON_COLUMN_ABSENT
    assert isinstance(point.movements, S.NotServed), (
        "the source row carries no cumulative pair, so the movement slot "
        "must REFUSE; it holds %r" % (point.movements,))
    assert point.net(S.SLOT_CLOSING).amount_minor == 100000


def test_a_synthetic_refuses_when_any_contributor_refuses():
    """Summing over a refusal would read the absence as a zero and make
    the parent look smaller than the book. The parent refuses, carrying
    the contributor's own reason."""
    rows = [
        {"cont": "411.01", "nume_cont": "A", "si_d": 10.0, "si_c": 0.0,
         "st_d": 5.0, "st_c": 0.0, "sf_d": 15.0, "sf_c": 0.0},
        {"cont": "411.02", "nume_cont": "B", "sf_d": 7.0, "sf_c": 0.0},
    ]
    built = S.build(entity(), [ledger_period(
        "saga_10_col_agras", rows=rows, semantics=CUMULATIVE_MOVEMENTS)])
    parent = built.require("411").points[0]
    assert isinstance(parent.opening, S.NotServed), (
        "411.02 serves no opening, so the synthetic 411 must REFUSE its "
        "opening; it holds %r — summing over the refusal read the absence "
        "as a zero and made the parent smaller than the book"
        % (parent.opening,))
    assert parent.opening.reason == S.REASON_COLUMN_ABSENT
    assert parent.net(S.SLOT_CLOSING).amount_minor == 2200


# ── The cumulative-pair semantics ────────────────────────────────────────


def test_an_undeclared_cumulative_pair_yields_no_movement():
    """The `sume totale` pair means two different things in real books.
    Undeclared, it is not a movement — and the refusal says why, so the
    reader is not told merely that something is missing."""
    built = S.build(entity(), [ledger_period("saga_10_col_agras",
                                             semantics="")])
    point = built.require(WORKED_CODE).points[0]
    assert isinstance(point.movements, S.NotServed), (
        "the front-end declared no cumulative semantics, so the movement "
        "slot must REFUSE; it holds %r — a guess between "
        "cumulative_with_opening and cumulative_movements is wrong by the "
        "whole opening balance on one of every five real books"
        % (point.movements,))
    assert point.movements.reason == S.REASON_CUMULATIVE_SEMANTICS_UNKNOWN
    assert CUMULATIVE_WITH_OPENING in point.movements.detail
    assert CUMULATIVE_MOVEMENTS in point.movements.detail
    check = point.identity()
    assert not check.checkable
    # The refusal's own reason survives into the identity check rather
    # than being flattened into "no movement figure".
    assert CUMULATIVE_WITH_OPENING in check.reason
    # The opening and the closing are untouched — one refused slot does
    # not blank the point.
    assert point.net(S.SLOT_OPENING).amount_minor == WORKED_OPENING_MINOR
    assert point.net(S.SLOT_CLOSING).amount_minor == WORKED_CLOSING_MINOR


def test_the_wrong_semantics_shows_up_as_a_residual_not_as_silence():
    """Declaring the wrong reading does not corrupt quietly: the identity
    residual is exactly the opening balance, on every account that has
    one. That is the whole reason the residual is reported per account.

    Measured on the real agras book: 176 of its 413 series fail."""
    built = S.build(entity(), [ledger_period(
        "saga_10_col_agras", semantics=CUMULATIVE_WITH_OPENING)])
    failures = 0
    for code in built.codes():
        point = built.require(code).points[0]
        check = point.identity()
        assert check.checkable
        opening = point.net(S.SLOT_OPENING)
        assert check.residual_minor == opening.amount_minor
        if check.residual_minor:
            failures += 1
    assert failures == 176


# ── Gaps ─────────────────────────────────────────────────────────────────


def flat_rows(amount=1000.0):
    return [{"cont": "5121.01", "nume_cont": "Banca", "sf_d": amount,
             "sf_c": 0.0}]


def monthly(period_id, fiscal_end, ordinal, rows=None):
    return S.LedgerPeriodInput(
        period_id=period_id, fiscal_end=fiscal_end, ordinal=ordinal,
        currency="RON", cui=CUI,
        rows=(flat_rows() if rows is None else rows),
        snapshot_key="content:%s" % period_id)


def test_an_absent_period_holds_its_place_and_is_never_a_zero():
    """A missing month is a FACT the series carries. `points` stays the
    same length as `periods`, the hole is an AccountGap with a reason,
    and it is not a Money."""
    built = S.build(entity(), [
        monthly("jan", "2025-01-31", 1),
        S.AbsentPeriodInput(period_id="feb", fiscal_end="2025-02-28",
                            ordinal=2, cui=CUI),
        monthly("mar", "2025-03-31", 3),
    ])
    points = built.require("5121.01").points
    assert len(points) == len(built.periods) == 3, (
        "%d points for %d periods — a missing month must hold its place as "
        "a stated gap, never shorten the list silently"
        % (len(points), len(built.periods)))
    assert isinstance(points[1], S.AccountGap)
    assert points[1].reason == S.REASON_PERIOD_ABSENT
    assert [p.period_id for p in points] == ["jan", "feb", "mar"]
    assert len(built.periods_with_data()) == 2
    assert built.periods[1].present is False


def test_no_movement_and_no_data_are_different_objects():
    """Two equal closings are a flat account. A gap is no reading at all.
    A consumer must be able to tell them apart without guessing."""
    built = S.build(entity(), [
        monthly("jan", "2025-01-31", 1),
        monthly("feb", "2025-02-28", 2),
        S.AbsentPeriodInput(period_id="mar", fiscal_end="2025-03-31",
                            ordinal=3, cui=CUI),
    ])
    jan, feb, mar = built.require("5121.01").points
    assert isinstance(jan, S.AccountPoint) and isinstance(feb, S.AccountPoint)
    assert jan.net(S.SLOT_CLOSING) == feb.net(S.SLOT_CLOSING)  # no movement
    assert isinstance(mar, S.AccountGap)                        # no data
    assert built.require("5121.01").closing_series() == (
        ("jan", Money.from_minor("RON", 100000)),
        ("feb", Money.from_minor("RON", 100000)),
        ("mar", None),
    )


def test_an_account_absent_from_one_period_is_a_gap_not_a_zero():
    built = S.build(entity(), [
        monthly("jan", "2025-01-31", 1),
        monthly("feb", "2025-02-28", 2, rows=[
            {"cont": "5124.01", "nume_cont": "Banca FX", "sf_d": 5.0,
             "sf_c": 0.0}]),
    ])
    points = built.require("5121.01").points
    assert isinstance(points[1], S.AccountGap)
    assert points[1].reason == S.REASON_ACCOUNT_ABSENT


def test_a_hole_truncates_the_run_it_sits_in():
    """`contiguous_tail` is what a persistence detector counts. A movement
    measured across a hole is not a movement."""
    built = S.build(entity(), [
        monthly("jan", "2025-01-31", 1),
        S.AbsentPeriodInput(period_id="feb", fiscal_end="2025-02-28",
                            ordinal=2, cui=CUI),
        monthly("mar", "2025-03-31", 3),
        monthly("apr", "2025-04-30", 4),
    ])
    tail = built.require("5121.01").contiguous_tail()
    assert [p.period_id for p in tail] == ["mar", "apr"]
    assert built.require("5121.01").n_present() == 3


def test_a_cadence_hole_is_named_only_when_the_cadence_is_unambiguous():
    """A spine that skips April on a monthly cadence says which fiscal
    end is missing. A spine whose cadence cannot be settled claims
    nothing — inventing a cadence would invent a missing month."""
    monthly_spine = S.build(entity(), [
        monthly("jan", "2025-01-31", 1),
        monthly("feb", "2025-02-28", 2),
        monthly("mar", "2025-03-31", 3),
        monthly("may", "2025-05-31", 4),
    ])
    assert monthly_spine.cadence_months == 1
    assert monthly_spine.implied_gaps == ("2025-04",)

    ragged = S.build(entity(), [
        monthly("a", "2025-01-31", 1),
        monthly("b", "2025-03-31", 2),
        monthly("c", "2025-08-31", 3),
    ])
    assert ragged.cadence_months is None
    assert ragged.implied_gaps == ()


# ── Same entity only ─────────────────────────────────────────────────────


def test_a_second_company_is_refused():
    with pytest.raises(S.EntityMismatchError) as caught:
        S.build(entity(), [
            monthly("jan", "2025-01-31", 1),
            S.LedgerPeriodInput(
                period_id="feb", fiscal_end="2025-02-28", ordinal=2,
                currency="RON", cui="87654321", rows=flat_rows(),
                snapshot_key="k"),
        ])
    assert "87654321" in str(caught.value)
    assert CUI in str(caught.value)


def test_an_absent_cui_is_refused_rather_than_assumed_to_match():
    for missing in (None, "", "   ", "not-a-cui"):
        with pytest.raises(S.EntityUnknownError):
            S.build(entity(), [S.LedgerPeriodInput(
                period_id="jan", fiscal_end="2025-01-31", ordinal=1,
                currency="RON", cui=missing, rows=flat_rows(),
                snapshot_key="k")])


def test_the_cui_is_normalized_the_way_the_firm_importer_normalizes_it():
    """'RO 12.345.678' and '12345678' are the same company, so a spine
    may mix the two spellings. It uses the one authority
    (`engine.api._firm_import.normalize_cui`), not a second regex."""
    built = S.build(S.EntityKey.of(WORKSPACE, "RO 12.345.678"), [
        monthly("jan", "2025-01-31", 1),
        S.LedgerPeriodInput(period_id="feb", fiscal_end="2025-02-28",
                            ordinal=2, currency="RON", cui="RO12345678",
                            rows=flat_rows(), snapshot_key="k"),
    ])
    assert built.entity == S.EntityKey(workspace_id=WORKSPACE, cui=CUI)


def test_a_set_carries_exactly_one_entity_and_the_series_carry_none():
    """Structural, not merely checked: there is nowhere to put a second
    company. A series has no entity field, and the only way to reach one
    is through the set that owns it."""
    built = S.build(entity(), [monthly("jan", "2025-01-31", 1)])
    fields = set(S.AccountTimeSeries.__dataclass_fields__)
    assert not fields & {"entity", "cui", "workspace_id", "company"}
    assert not (set(S.AccountPoint.__dataclass_fields__)
                & {"entity", "cui", "workspace_id", "company"})
    assert built.entity.cui == CUI


def test_a_duplicate_period_is_refused():
    for second in (
        S.LedgerPeriodInput(period_id="jan", fiscal_end="2025-02-28",
                            ordinal=2, currency="RON", cui=CUI,
                            rows=flat_rows(), snapshot_key="k"),
        S.LedgerPeriodInput(period_id="feb", fiscal_end="2025-02-28",
                            ordinal=1, currency="RON", cui=CUI,
                            rows=flat_rows(), snapshot_key="k"),
    ):
        with pytest.raises(S.DuplicatePeriodError):
            S.build(entity(), [monthly("jan", "2025-01-31", 1), second])


# ── Native units ─────────────────────────────────────────────────────────


def test_two_currencies_on_one_spine_are_refused():
    """A movement across an FX restatement is an FX artefact. The set
    refuses at build, so no consumer ever holds one."""
    with pytest.raises(S.SeriesCurrencyError) as caught:
        S.build(entity(), [
            monthly("jan", "2025-01-31", 1),
            S.LedgerPeriodInput(period_id="feb", fiscal_end="2025-02-28",
                                ordinal=2, currency="EUR", cui=CUI,
                                rows=flat_rows(), snapshot_key="k"),
        ])
    assert "EUR" in str(caught.value) and "RON" in str(caught.value)


def test_a_ratio_over_the_spine_is_invariant_under_a_display_switch():
    """The spine holds native figures only. A ratio formed from two of
    its points through `_ratio_units` is dimensionless and identical
    whatever the display currency is — and the same ratio REFUSES the
    moment a converted operand is mixed in (the 1553% / Critical-461
    laws)."""
    built = S.build(entity(), [
        monthly("jan", "2025-01-31", 1),
        monthly("feb", "2025-02-28", 2, rows=flat_rows(2500.0)),
    ])
    jan, feb = built.require("5121.01").points
    native = U.ratio(
        U.money(feb.net(S.SLOT_CLOSING).amount_minor, built.currency,
                name="closing_feb"),
        U.money(jan.net(S.SLOT_CLOSING).amount_minor, built.currency,
                name="closing_jan"))
    assert native == pytest.approx(2.5)
    # The same two figures with the display currency stamped on them are
    # the same number: nothing here converts.
    assert built.currency == jan.net(S.SLOT_CLOSING).currency == "RON"
    with pytest.raises(U.UnitMismatchError):
        U.ratio(U.money(2500, "EUR", name="converted"),
                U.money(1000, built.currency, name="native"))


def test_no_slot_is_ever_a_bare_float():
    """Every figure on the spine is exact minor units in a named
    currency. A float in a slot is how a rounding drift starts."""
    built = S.build(entity(), [ledger_period("saga_10_col_realestate")])
    for code in built.codes():
        for point in built.require(code).points:
            for slot in S.SLOTS:
                held = getattr(point, slot)
                if isinstance(held, S.NotServed):
                    continue
                assert isinstance(held.net, Money)
                assert isinstance(held.net.amount_minor, int)


# ── Determinism ──────────────────────────────────────────────────────────


def test_the_same_inputs_build_the_same_bytes_and_the_same_key():
    first = S.build(entity(), [ledger_period("saga_10_col_retail")])
    second = S.build(entity(), [ledger_period("saga_10_col_retail")])
    assert first.key == second.key
    dumped = lambda s: json.dumps(s.to_payload(include_series=True),
                                 sort_keys=True, ensure_ascii=False)
    assert dumped(first) == dumped(second)


def test_the_spine_does_not_depend_on_the_order_it_was_handed_over():
    periods = [
        monthly("mar", "2025-03-31", 3),
        monthly("jan", "2025-01-31", 1),
        monthly("feb", "2025-02-28", 2),
    ]
    forward = S.build(entity(), periods)
    backward = S.build(entity(), list(reversed(periods)))
    assert forward.key == backward.key, (
        "the same three periods handed over in two orders produced two "
        "keys (%s vs %s) — the spine's order must come from `ordinal`, "
        "never from the caller's list" % (forward.key[:12], backward.key[:12]))
    assert forward.period_ids() == ("jan", "feb", "mar") == backward.period_ids()


def test_the_key_moves_when_a_snapshot_moves_and_not_otherwise():
    base = S.build(entity(), [monthly("jan", "2025-01-31", 1)])
    same_data_new_label = S.build(entity(), [S.LedgerPeriodInput(
        period_id="jan", fiscal_end="2025-01-31", ordinal=1, currency="RON",
        cui=CUI, rows=flat_rows(), snapshot_key="content:jan",
        label="January")])
    assert base.key == same_data_new_label.key
    rewritten = S.build(entity(), [S.LedgerPeriodInput(
        period_id="jan", fiscal_end="2025-01-31", ordinal=1, currency="RON",
        cui=CUI, rows=flat_rows(), snapshot_key="content:jan-v2")])
    assert base.key != rewritten.key
    other_company = S.build(S.EntityKey.of(WORKSPACE, "87654321"), [
        S.LedgerPeriodInput(period_id="jan", fiscal_end="2025-01-31",
                            ordinal=1, currency="RON", cui="87654321",
                            rows=flat_rows(), snapshot_key="content:jan")])
    assert base.key != other_company.key


def test_the_key_uses_the_same_digest_discipline_as_radar_serve():
    """sha256 over canonical JSON with sorted keys — the discipline
    `engine.radar.serve._digest` already uses, reused rather than
    forked. (`series` does not import `serve`: serve pulls the whole
    findings engine and the next wave wires them the other way.)"""
    import hashlib
    built = S.build(entity(), [monthly("jan", "2025-01-31", 1)])
    material = {
        "version": S.SERIES_VERSION,
        "entity": {"workspace_id": WORKSPACE, "cui": CUI},
        "synthetic_width": S.DEFAULT_SYNTHETIC_WIDTH,
        "spine": [["jan", 1, "2025-01-31", "content:jan", S.TIER_LEDGER, True]],
    }
    blob = json.dumps(material, sort_keys=True, ensure_ascii=False,
                      default=str)
    assert built.key == hashlib.sha256(blob.encode("utf-8")).hexdigest()
    assert "serve" not in [m.split(".")[-1] for m in _series_imports()]


def _series_imports():
    import ast
    source = (REPO / "src" / "engine" / "radar" / "series.py").read_text("utf-8")
    names = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom) and node.module:
            names.append(node.module)
        elif isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
    return names


def test_the_module_reads_no_clock_and_calls_no_model():
    """Determinism at the source level: a timestamp or a model client
    inside the spine would make the same snapshot set answer differently
    on two opens."""
    source = (REPO / "src" / "engine" / "radar" / "series.py").read_text("utf-8")
    for banned in ("datetime", "time.time", "anthropic", "random",
                   "utcnow", "engine.ai"):
        assert banned not in source, banned


# ── Cold start ───────────────────────────────────────────────────────────


def test_under_three_periods_the_spine_says_so_and_draws_no_trend():
    one = S.build(entity(), [monthly("jan", "2025-01-31", 1)])
    cold = one.cold_start()
    assert cold is not None
    assert (cold.have, cold.needed) == (1, 3)
    assert "no trend" in cold.statement
    assert str(cold.have) in cold.statement and str(cold.needed) in cold.statement

    two = S.build(entity(), [monthly("jan", "2025-01-31", 1),
                             monthly("feb", "2025-02-28", 2)])
    assert two.cold_start().have == 2

    three = S.build(entity(), [monthly("jan", "2025-01-31", 1),
                               monthly("feb", "2025-02-28", 2),
                               monthly("mar", "2025-03-31", 3)])
    assert three.cold_start() is None


def test_a_declared_absent_period_does_not_count_toward_cold_start():
    """Three rows on the spine, two of them with data, is still a cold
    start. Counting the hole would let an empty month unlock a trend."""
    built = S.build(entity(), [
        monthly("jan", "2025-01-31", 1),
        monthly("feb", "2025-02-28", 2),
        S.AbsentPeriodInput(period_id="mar", fiscal_end="2025-03-31",
                            ordinal=3, cui=CUI),
    ])
    assert built.period_count() == 3
    assert built.cold_start().have == 2


# ── A multi-period spine from one real book ──────────────────────────────


def constructed_two_period_spine():
    """CONSTRUCTED, from real bytes, and labelled as such.

    No committed book in this repo carries three periods; every corpus
    case and every firm fixture is one fiscal year. But the agras FY2025
    trial balance STATES, per account, the opening balance at
    2025-01-01 — which is the closing balance at the prior fiscal end,
    2024-12-31. So one real file yields two real balance-sheet dates for
    one company. The FY2024 period is built closing-only (the book's own
    `si` pair moved into the `sf` slots, `si`/`st` absent), which is
    exactly the shape a served-tier period has."""
    rows = rows_of("saga_10_col_agras")
    prior = [{"cont": r["cont"], "nume_cont": r["nume_cont"],
              "sf_d": r.get("si_d"), "sf_c": r.get("si_c")} for r in rows]
    return S.build(entity(), [
        S.LedgerPeriodInput(
            period_id="p-2025", fiscal_end="2025-12-31", ordinal=2,
            currency="RON", cui=CUI, rows=rows,
            snapshot_key="content:agras",
            cumulative_semantics=CUMULATIVE_MOVEMENTS,
            source_document_id="doc-agras"),
        S.LedgerPeriodInput(
            period_id="p-2024", fiscal_end="2024-12-31", ordinal=1,
            currency="RON", cui=CUI, rows=prior,
            snapshot_key="content:agras-opening-column",
            source_document_id="doc-agras"),
    ])


def test_a_two_period_spine_from_one_real_books_own_columns():
    built = constructed_two_period_spine()
    assert [p.fiscal_end for p in built.periods] == ["2024-12-31",
                                                     "2025-12-31"]
    assert len(built.series) == 413
    series = built.require(WORKED_CODE)
    fy24, fy25 = series.points
    # The prior period's closing IS the current period's opening, to the
    # cent — that is what makes it the same company's spine and not two
    # unrelated readings.
    assert fy24.net(S.SLOT_CLOSING).amount_minor == WORKED_OPENING_MINOR
    assert fy25.net(S.SLOT_OPENING).amount_minor == WORKED_OPENING_MINOR
    assert fy25.net(S.SLOT_CLOSING).amount_minor == WORKED_CLOSING_MINOR
    # Two periods is still a cold start.
    assert built.cold_start().have == 2
    # And the FY2024 period, having no cumulative pair, refuses a
    # movement rather than inventing one.
    assert isinstance(fy24.movements, S.NotServed)


def test_every_series_on_the_spine_is_aligned_with_the_periods():
    """The alignment IS the contract: index i of one series and index i
    of another are the same period of the same company."""
    built = constructed_two_period_spine()
    ids = built.period_ids()
    for code in built.codes():
        points = built.require(code).points
        assert len(points) == len(ids)
        assert tuple(p.period_id for p in points) == ids


def test_a_mixed_tier_spine_says_it_is_mixed():
    """Served `.net` is the mapper's statement sign; ledger `.net` is
    debit-positive. A claim that spans both must be able to know."""
    built = S.build(entity(), [
        monthly("jan", "2025-01-31", 1),
        served_period(period_id="feb", fiscal_end="2025-02-28", ordinal=2),
    ])
    assert built.tier_counts == {S.TIER_LEDGER: 1, S.TIER_SERVED: 1}
    assert built.mixed_tiers() is True
    single = S.build(entity(), [monthly("jan", "2025-01-31", 1)])
    assert single.mixed_tiers() is False


# ── The cache ────────────────────────────────────────────────────────────


def test_an_unchanged_spine_never_rebuilds():
    """The key is taken from the spine alone, so it can be formed before
    any account row is read — and an unchanged spine is a hit."""
    cache = S.SeriesCache()
    periods = [ledger_period("saga_10_col_agras")]
    first = cache.get_or_build(entity(), periods)
    second = cache.get_or_build(entity(), periods)
    assert cache.stats() == {"hits": 1, "misses": 1, "entries": 1}
    assert first is second

    rewritten = [ledger_period("saga_10_col_agras", period_id="p-2025b")]
    third = cache.get_or_build(entity(), rewritten)
    assert cache.stats()["misses"] == 2
    assert third is not first


def test_the_cache_is_bounded_and_evicts_the_oldest():
    cache = S.SeriesCache(max_entries=2)
    for n in range(3):
        cache.get_or_build(entity(), [monthly("p%d" % n,
                                              "2025-0%d-28" % (n + 1), n + 1)])
    assert len(cache) == 2
    assert cache.stats()["misses"] == 3
