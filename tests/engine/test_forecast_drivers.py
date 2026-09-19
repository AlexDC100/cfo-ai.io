"""LANE D GATE — the forecast assumption set, and the law that a default
can never be emitted without the basis that produced it.

WHAT THIS GATE REDS ON (TC-11), stated after the repair, not before:

  * a `Driver` constructed without a `Derivation`, or with a `basis`
    passed in alongside the derivation instead of generated from it — the
    exact shape in which a number and its stated reason drift apart;
  * `status == "absent"` carrying a value, or a non-absent status
    carrying `None` — the ABSENT != ZERO law, in the type;
  * any driver, on any of the four committed REAL books, in any of the
    three cases, whose rendered `basis` is empty;
  * a driver that could not be measured coming back as `0.0` instead of
    `None` (measured specifically on `headcount`, which no committed book
    carries a source for);
  * a case that is a DELTA against base rather than a full assumption set
    — the three must be comparable in one view;
  * a `hold` driver moving between cases (capex, tax, the contracted rate
    on existing debt), i.e. the "fixed +/-20% on every driver" gesture;
  * a directional driver whose upside is worse than base, or whose
    downside is better — including the sign trap on `dso`/`dio`, where
    favourable is DOWN;
  * a history handed over newest-first silently inverting a growth rate;
  * the derivation ladder picking the wrong rung: 1 period must be
    `pack_macro` + `fallback` (never a silent 0%), 2 periods `yoy`,
    3 periods `cagr`;
  * output that is not byte-identical across two builds of one payload;
  * any model/AI import appearing inside the package;
  * provenance losing a period: a 3-period CAGR must record all three
    source periods, not just the newest.

WHAT IT CANNOT SEE:

  * whether the macro anchor in `packs/forecast/ro_macro.yaml` is still
    the current published figure — it checks the anchor is USED and
    LABELLED, not that the world still agrees with it;
  * whether lane M's projection consumes these drivers correctly; that is
    lane M's gate;
  * a genuinely multi-period real workspace. No such fixture exists in
    this repo, so the multi-period rungs are exercised against histories
    CONSTRUCTED by scaling the real agras payload's own monetary values.
    The arithmetic is real and the shapes are real; the second period is
    synthetic and this file says so rather than implying otherwise.

Python 3.9. No network, no clock, no database.
"""

from __future__ import annotations

import copy
import json
import os
import re
import sys

import pytest

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))
if os.path.join(_ROOT, "src") not in sys.path:
    sys.path.insert(0, os.path.join(_ROOT, "src"))

from engine.forecast_drivers import (  # noqa: E402
    CASE_KINDS, DISPERSION_BAND, DISPERSION_OBSERVED, AssumptionSet, CaseSet,
    Derivation, DerivationInput, Driver, DriverError, build_case_set,
    driver_keys, load_pack)

_FIXTURES = os.path.join(_ROOT, "tests", "engine", "fixtures", "firm")
_BOOKS = ("agras", "carniprod", "realestate", "retail")

#: The book every measured expectation in this file is recorded against.
_CALIBRATION_BOOK = "agras"


# ──────────────────────────────────────────────────────────────────────
# fixtures — REAL engine output, provenance stated (TC-1)
# ──────────────────────────────────────────────────────────────────────

def _load(book):
    """A committed real Romanian trial balance through the real engine.

    Source: `tests/engine/fixtures/firm/saga_10_col_<book>.json`, produced
    by the pipeline from `corpus/<book>/input.xlsx`. Not hand-written.
    """
    path = os.path.join(_FIXTURES, "saga_10_col_%s.json" % (book,))
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


#: Subtrees of the served payload that hold MONEY. Everything else is
#: left alone on purpose: `methodology.ratios` is dimensionless,
#: `assembled_bands` holds the verdict thresholds (scaling those would
#: move the goalposts along with the company and hide exactly the
#: band-traverse behaviour the case tests check), and `assembled_piotroski`
#: is a score.
_MONEY_SUBTREES = (
    ("statements", "assembled_pl"),
    ("statements", "assembled_bs"),
    ("statements", "assembled_cf"),
    ("statements", "balanceSheet"),
    ("statements", "incomeStatement"),
    ("statements", "subAggregates"),
    ("envelope", "canonical_bs"),
    ("envelope", "leaves"),
    ("envelope", "aggregates"),
    ("line_items",),
)

#: Numeric fields inside those subtrees that are NOT money — counts,
#: versions and day-counts must survive a scaling untouched.
_NOT_MONEY = frozenset((
    "ras_line_items_count", "mapping_version", "schema_version",
    "periodDays", "period_days", "count", "ordinal",
))


def _scale_numbers(node, factor):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in _NOT_MONEY:
                continue
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                node[key] = value * factor
            else:
                _scale_numbers(value, factor)
    elif isinstance(node, list):
        for item in node:
            _scale_numbers(item, factor)
    return node


def _scale_money(payload, factor):
    """Scale the monetary subtrees of a served payload, in place.

    This makes a synthetic EARLIER period out of a real one. Level drivers
    are then re-derived from the scaled values by the same builder the
    base set uses, which is the point: the case bounds and the base value
    can never come from different rules.
    """
    for path in _MONEY_SUBTREES:
        node = payload
        for step in path[:-1]:
            node = node.get(step) if isinstance(node, dict) else None
            if node is None:
                break
        if not isinstance(node, dict):
            continue
        target = node.get(path[-1])
        if target is not None:
            _scale_numbers(target, factor)
    return payload


def _prior_period(payload, factor, years_back):
    """A synthetic EARLIER period built by scaling the real payload.

    `factor` < 1 makes the newest period the larger one, i.e. growth.
    Dates are shifted whole years so the span arithmetic is exact.
    """
    older = copy.deepcopy(payload)
    _scale_money(older, factor)

    def _shift(text):
        return "%04d%s" % (int(text[0:4]) - years_back, text[4:])

    older["period_start"] = _shift(payload["period_start"])
    older["period_end"] = _shift(payload["period_end"])
    prov = older.get("envelope", {}).get("provenance")
    if isinstance(prov, dict):
        prov["source_document_id"] = "doc-synthetic-minus%dy" % (years_back,)
        prov["content_hash"] = "sha256-synthetic-minus%dy" % (years_back,)
    return older


def _history(payload, factors):
    """`factors` maps years-back -> scale. Returns OLDEST FIRST."""
    out = []
    for years_back in sorted(factors, reverse=True):
        out.append(_prior_period(payload, factors[years_back], years_back))
    out.append(copy.deepcopy(payload))
    return out


@pytest.fixture(scope="module")
def agras():
    return _load(_CALIBRATION_BOOK)


@pytest.fixture(scope="module")
def pack():
    return load_pack()


# ──────────────────────────────────────────────────────────────────────
# A. THE TYPE LAW — a number cannot be emitted without its reason
# ──────────────────────────────────────────────────────────────────────

def _derivation(note=""):
    return Derivation(
        method="ratio", method_label="trade receivables over revenue",
        periods_used=("2025-12-31",),
        inputs=(DerivationInput("revenue", "2025-12-31", 100.0,
                                "assembled_pl"),),
        source="book", note=note)


def test_a1_a_driver_cannot_exist_without_a_derivation():
    with pytest.raises(DriverError) as excinfo:
        Driver(key="dso", label="DSO", unit="days", kind="level",
               favourable_direction="down", value=30.0, status="derived",
               derivation=None)
    assert "no derivation" in str(excinfo.value)
    # The message must say WHY, not just what — it is the sentence a future
    # engineer reads when tempted to add a `basis=""` escape hatch.
    assert "mistake for a fact" in str(excinfo.value)


def test_a2_absent_never_carries_a_value_and_a_value_is_never_absent():
    with pytest.raises(DriverError) as absent_with_value:
        Driver("dso", "DSO", "days", "level", "down", 0.0, "absent",
               _derivation())
    assert "absent but carries a value" in str(absent_with_value.value)

    with pytest.raises(DriverError) as derived_without_value:
        Driver("dso", "DSO", "days", "level", "down", None, "derived",
               _derivation())
    # ABSENT != ZERO stated in the type's own error text.
    assert "ABSENT != ZERO" in str(derived_without_value.value)


def test_a3_basis_is_generated_from_the_derivation_so_they_cannot_drift():
    driver = Driver("dso", "DSO", "days", "level", "down", 26.2, "derived",
                    _derivation())
    assert driver.basis == (
        "trade receivables over revenue, from 2025-12-31")
    # There is no setter and no constructor argument: the ONLY way to
    # change the sentence is to change the derivation that produced it.
    assert "basis" not in Driver.__slots__
    with pytest.raises(AttributeError):
        driver.basis = "8.2% because I said so"


def test_a3b_the_note_is_appended_to_the_basis_not_hidden_beside_it():
    driver = Driver("dso", "DSO", "days", "level", "down", 26.2, "fallback",
                    _derivation(note="Held at the pack anchor."))
    assert driver.basis.endswith("Held at the pack anchor.")


def test_a4_a_case_with_no_stated_construction_is_refused():
    driver = Driver("dso", "DSO", "days", "level", "down", 26.2, "derived",
                    _derivation())
    with pytest.raises(DriverError) as excinfo:
        AssumptionSet("base", "Base", "", (driver,))
    assert "no stated basis" in str(excinfo.value)


def test_a5_a_case_set_is_exactly_base_upside_downside_in_that_order():
    driver = Driver("dso", "DSO", "days", "level", "down", 26.2, "derived",
                    _derivation())

    def _case(kind):
        return AssumptionSet(kind, kind.title(), "stated", (driver,))

    with pytest.raises(DriverError):
        CaseSet((_case("base"), _case("downside"), _case("upside")),
                {}, "m", "l")
    with pytest.raises(DriverError):
        CaseSet((_case("base"), _case("upside")), {}, "m", "l")


# ──────────────────────────────────────────────────────────────────────
# B. THE REAL BOOKS — every default carries its basis, absent stays absent
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("book", _BOOKS)
def test_b1_every_driver_of_every_case_carries_a_non_empty_basis(book):
    case_set = build_case_set([_load(book)])
    for case in case_set.cases:
        for driver in case.drivers:
            assert driver.basis.strip(), (
                "%s/%s/%s emitted a number with no stated basis"
                % (book, case.case_kind, driver.key))
            # A basis that is only the method name tells a reader nothing
            # about where it came from.
            assert len(driver.basis) > 12, (book, case.case_kind, driver.key)


@pytest.mark.parametrize("book", _BOOKS)
def test_b2_absent_is_none_and_never_zero(book):
    case_set = build_case_set([_load(book)])
    for case in case_set.cases:
        for driver in case.drivers:
            if driver.status == "absent":
                assert driver.value is None, (book, driver.key)
            else:
                assert driver.value is not None, (book, driver.key)


def test_b2b_headcount_is_absent_on_the_real_book_not_zero(agras):
    """The measured case. No committed book carries a headcount source, so
    the honest answer is `absent`. A 0 here would make lane M project a
    company with no employees and a full payroll."""
    base = build_case_set([agras]).case("base")
    headcount = base.driver("headcount")
    assert headcount.status == "absent"
    assert headcount.value is None
    assert headcount.basis.strip()
    # And the reason is stated, not implied by the empty value.
    assert headcount.derivation.note.strip()


@pytest.mark.parametrize("book", _BOOKS)
def test_b3_requires_review_is_exactly_the_non_derived_keys(book):
    for case in build_case_set([_load(book)]).cases:
        expected = tuple(d.key for d in case.drivers if d.status != "derived")
        assert case.requires_review() == expected


@pytest.mark.parametrize("book", _BOOKS)
def test_b4_every_derived_default_names_the_authority_it_was_read_from(book):
    """A default that cannot be attributed to a field of the served
    payload is not auditable, and an unauditable default is the thing this
    module exists to prevent."""
    # `assembled_bands.*` is a legitimate authority: a case driver that did
    # NOT move still records the band rungs it was compared against, and
    # that comparison is the reason it held.
    # plan/2 B4b: `line_items` — the anchor's statement_line_items rows, the
    # ONLY source of the cost pools (contract 5.1); gross_margin and
    # opex_rate are read off the engine's pool facts measured from them.
    known = ("assembled_pl", "canonical_bs", "envelope", "pack",
             "methodology.ratios", "statements", "assembled_bands", "book",
             "line_items")
    for case in build_case_set([_load(book)]).cases:
        for driver in case.drivers:
            if driver.status != "derived":
                continue
            assert driver.derivation.inputs, (book, driver.key)
            for item in driver.derivation.inputs:
                assert item.authority, (book, driver.key)
                assert any(item.authority.startswith(k) for k in known), (
                    book, driver.key, item.authority)


def test_b5_the_legacy_assembly_is_not_the_authority_for_any_default():
    """`assembled_bs` differs from `canonical_bs` on the agras book by the
    unclassified account-413 balance. Reading the legacy assembly has
    caused three production defects; no driver may cite it."""
    package = os.path.join(_ROOT, "src", "engine", "forecast_drivers")
    for name in sorted(os.listdir(package)):
        if not name.endswith(".py"):
            continue
        with open(os.path.join(package, name), "r", encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                if "assembled_bs" not in line:
                    continue
                stripped = line.strip()
                # A comment naming the trap is the documentation of it.
                assert stripped.startswith("#") or "`" in stripped, (
                    "%s:%d reads the legacy assembly: %s"
                    % (name, lineno, stripped))


# ──────────────────────────────────────────────────────────────────────
# C. DETERMINISM — same input, same bytes
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("book", _BOOKS)
def test_c1_two_builds_of_one_payload_are_byte_identical(book):
    payload = _load(book)
    first = json.dumps(build_case_set([payload]).as_dict(), sort_keys=True)
    second = json.dumps(build_case_set([payload]).as_dict(), sort_keys=True)
    assert first == second


def test_c2_order_is_fixed_everywhere_that_reaches_the_output(agras, pack):
    case_set = build_case_set([agras])
    assert tuple(c.case_kind for c in case_set.cases) == CASE_KINDS
    expected_keys = tuple(driver_keys(pack))
    for case in case_set.cases:
        assert tuple(d.key for d in case.drivers) == expected_keys
        for driver in case.drivers:
            periods = driver.derivation.periods_used
            assert list(periods) == sorted(periods), driver.key


def test_c3_the_serialised_shape_is_json_round_trippable(agras):
    """Persistence stores this as jsonb; anything that will not survive a
    round trip cannot be saved and re-compared against re-derived
    actuals."""
    payload = build_case_set([agras]).as_dict()
    assert json.loads(json.dumps(payload)) == payload


# ──────────────────────────────────────────────────────────────────────
# D. THE LADDER — 1 period, 2 periods, 3 periods
# ──────────────────────────────────────────────────────────────────────

def test_d1_one_period_falls_back_to_the_macro_anchor_never_to_zero(
        agras, pack):
    driver = build_case_set([agras]).case("base").driver("revenue_growth")
    assert driver.status == "fallback"
    assert driver.derivation.method == "pack_macro"
    assert driver.value is not None
    assert driver.value != 0.0, (
        "a book with no history does not have 0% growth; it has no "
        "measurable growth, and the two are different claims")
    spec = pack.driver("revenue_growth")
    anchor = pack.anchor(spec.macro_anchor)
    assert driver.value == pytest.approx(anchor.value)
    # The fallback declares itself as one, names its source, and says what
    # would replace it.
    assert driver.derivation.source.startswith("pack:")
    assert anchor.source in driver.basis or anchor.source in \
        driver.derivation.note
    assert "second period" in driver.derivation.note


def test_d2_two_periods_measure_the_company_and_call_it_year_on_year(agras):
    # The newest period is 1.20x the prior one: a 20% year-on-year rise.
    history = _history(agras, {1: 1.0 / 1.20})
    driver = build_case_set(history).case("base").driver("revenue_growth")
    assert driver.status == "derived"
    assert driver.derivation.method == "yoy"
    # ANNUALISED ON ACTUAL/365.25, not on "one row per year". 2024-12-31 to
    # 2025-12-31 is 365 days = 0.99932 years, so a 1.20x rise annualises a
    # shade above 20%. Pinned exactly rather than hidden behind a loose
    # tolerance: this convention is the reason two companies with the same
    # revenue ratio can report different growth when one straddles a leap
    # year, and a future change to it should red here and be argued, not
    # absorbed silently.
    # Rounded once at emit, to the dp the PACK declares for a rate — the
    # rule that makes two runs byte-identical.
    expected = round(1.20 ** (365.25 / 365.0) - 1.0,
                     load_pack().round_for("rate"))
    assert driver.value == expected
    assert driver.value == pytest.approx(0.20, abs=2e-4)
    assert "year-on-year" in driver.basis
    assert len(driver.derivation.periods_used) == 2
    # One observation is not a trend, and the basis says so.
    assert "single observation" in driver.derivation.note


def test_d3_three_periods_compound_and_call_it_a_cagr(agras):
    # 2023 -> 2025 at a true 10% per year: the oldest is 1/1.21 of newest.
    history = _history(agras, {2: 1.0 / 1.21, 1: 1.0 / 1.10})
    driver = build_case_set(history).case("base").driver("revenue_growth")
    assert driver.status == "derived"
    assert driver.derivation.method == "cagr"
    assert driver.value == pytest.approx(0.10, abs=1e-4)
    assert "2-year CAGR" in driver.basis
    # The owner's example rendered: "default 8.2% = 3-year CAGR".
    assert re.search(r"CAGR of .+, over 2023-12-31-2025-12-31", driver.basis)
    assert driver.derivation.periods_used == (
        "2023-12-31", "2024-12-31", "2025-12-31")


def test_d4_a_history_handed_over_backwards_cannot_invert_a_growth_rate(
        agras):
    history = _history(agras, {2: 1.0 / 1.21, 1: 1.0 / 1.10})
    forwards = build_case_set(history).case("base").driver("revenue_growth")
    backwards = build_case_set(list(reversed(history))).case(
        "base").driver("revenue_growth")
    assert backwards.value == pytest.approx(forwards.value)
    assert backwards.value > 0.0
    assert backwards.derivation.periods_used == forwards.derivation.periods_used


def test_d5_level_drivers_are_derived_from_a_single_period(agras):
    """A level is a state, not a change: it does not need history, and
    emitting it as a fallback would understate what the book knows."""
    base = build_case_set([agras]).case("base")
    for key in ("gross_margin", "dso", "dio", "dpo", "tax_rate"):
        driver = base.driver(key)
        assert driver.kind == "level"
        assert driver.derivation.periods_used == ("2025-12-31",), key
        if key == "tax_rate":
            # RESTATED (plan/2 B3 repair, contract 4): tax_rate is read
            # from engine.forecast's ONE derivation. agras' effective rate
            # is not measured (its build-up misses account 121 by
            # 6,572,426.01), so the engine takes the statutory rung; the
            # driver's status mirrors that tier ("derived" only for a book
            # measurement, "fallback" for the macro rung) and the refused
            # book rung is recorded, never dropped. What d5 is about — a
            # level read from ONE period — is still checked above.
            assert (driver.status == "derived") == (driver.tier == "book"), key
            if driver.tier != "book":
                assert driver.tier in ("macro", "absent"), key
                assert driver.fallback_steps[0]["tier"] == "book", key
                assert driver.fallback_steps[0]["outcome"] == "absent", key
            continue
        assert driver.status == "derived", key


# ──────────────────────────────────────────────────────────────────────
# E. THE CASES — full sets, directional, and not a gesture
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("book", _BOOKS)
def test_e1_each_case_is_a_full_assumption_set_not_a_delta(book, pack):
    """`comparable in one view` is a shape requirement: a case that only
    carried its differences would force the surface to merge two objects
    and would let a driver silently disappear from a case."""
    case_set = build_case_set([_load(book)])
    expected = tuple(driver_keys(pack))
    for case in case_set.cases:
        assert tuple(d.key for d in case.drivers) == expected
        for driver in case.drivers:
            assert driver.basis.strip()


@pytest.mark.parametrize("book", _BOOKS)
def test_e2_hold_drivers_do_not_move_between_cases(book, pack):
    """Capex, the tax rate, dividend policy and the contracted rate on
    existing debt are decisions and contracts, not trading conditions.
    Moving them by a percentage is the gesture the brief rules out."""
    case_set = build_case_set([_load(book)])
    base, upside, downside = case_set.cases
    moved = []
    for spec in pack.drivers:
        if spec.case_rule != "hold":
            continue
        values = (base.value(spec.key), upside.value(spec.key),
                  downside.value(spec.key))
        if len(set(v for v in values if v is not None)) > 1:
            moved.append((spec.key, values))
    assert not moved, "hold drivers moved between cases: %r" % (moved,)


@pytest.mark.parametrize("book", _BOOKS)
def test_e3_direction_is_respected_including_where_lower_is_better(book):
    """DSO and DIO are the sign trap: an upside case must SHORTEN them.
    A naive `upside = base * 1.2` reads as an improvement and is a
    deterioration."""
    base, upside, downside = build_case_set([_load(book)]).cases
    for driver in base.drivers:
        if driver.value is None:
            continue
        direction = driver.favourable_direction
        if direction not in ("up", "down"):
            continue
        up_value = upside.value(driver.key)
        down_value = downside.value(driver.key)
        assert up_value is not None and down_value is not None, driver.key
        if direction == "up":
            assert up_value >= driver.value >= down_value, (
                book, driver.key, up_value, driver.value, down_value)
        else:
            assert up_value <= driver.value <= down_value, (
                book, driver.key, up_value, driver.value, down_value)


@pytest.mark.parametrize("book", _BOOKS)
def test_e4_an_absent_driver_stays_absent_in_every_case(book):
    """A case does not conjure a driver the book never carried."""
    base, upside, downside = build_case_set([_load(book)]).cases
    for driver in base.drivers:
        if driver.status != "absent":
            continue
        assert upside.driver(driver.key).value is None, driver.key
        assert downside.driver(driver.key).value is None, driver.key


def test_e5_one_period_cases_come_from_the_bands_the_report_already_grades_on(
        agras):
    """TC-10: the downside is not an invented percentage, it is the rung at
    which this same report already says `watch this`."""
    case_set = build_case_set([agras])
    assert case_set.dispersion_method == DISPERSION_BAND
    assert case_set.dispersion_note.strip()
    assert "1 actuals period" in case_set.dispersion_note

    bands = agras["statements"]["assembled_bands"]["bands"]
    base, upside, downside = case_set.cases
    checked = 0
    for key in ("gross_margin", "dso", "dio", "dpo"):
        band = bands.get(key)
        if not isinstance(band, dict):
            continue
        strong = band.get("strong")
        watch = band.get("watch")
        if strong is None or watch is None:
            continue
        strong, watch = float(strong), float(watch)
        width = abs(strong - watch)
        base_value = base.value(key)
        for case in (upside, downside):
            value = case.value(key)
            if value is None or abs(value - base_value) < 1e-9:
                continue
            # EVERY admissible landing place is a number this book's own
            # bands already carry: a rung, or a step of the band's own
            # strong-to-watch width away from the measured base (the cap
            # that stops a company sitting outside the band being walked
            # into a different business). An invented constant — base*1.2,
            # a hard-coded 20% — matches neither.
            admissible = (strong, watch, base_value + width,
                          base_value - width)
            assert any(abs(value - candidate) < 1e-6
                       for candidate in admissible), (
                "%s/%s = %r is not derived from this book's own band "
                "(rungs %r, width %r off base %r)"
                % (case.case_kind, key, value, (strong, watch), width,
                   base_value))
            # And it is labelled as no longer a measurement of this company.
            driver = case.driver(key)
            assert driver.status == "fallback", (case.case_kind, key)
            assert driver.derivation.method == "band_traverse"
            cited = {i.name for i in driver.derivation.inputs}
            assert {"band_strong", "band_watch"} <= cited, (key, cited)
            checked += 1
    assert checked >= 2, "the band path was not actually exercised"


@pytest.mark.parametrize("book", _BOOKS)
def test_e5b_a_basis_never_claims_a_rung_the_number_did_not_reach(book):
    """MEASURED DEFECT, repaired: the agras downside DSO lands at 71.2057
    days because the move is capped at the band's own strong-to-watch
    width, while the watch rung is 75. The note used to prepend the cap
    explanation to the sentence "Walked to the WATCH rung", leaving a
    basis that asserted a landing place its own number contradicted.

    A reader checking a forecast checks exactly this. The gate is general:
    ANY band-traversed driver whose value is not on a rung may not say it
    walked to one.
    """
    bands = _load(book)["statements"]["assembled_bands"]["bands"]
    base = build_case_set([_load(book)]).case("base")
    for case in build_case_set([_load(book)]).cases:
        for driver in case.drivers:
            if driver.derivation.method != "band_traverse":
                continue
            if driver.value is None:
                continue
            band = bands.get(driver.key)
            if not isinstance(band, dict):
                continue
            rungs = [float(band[n]) for n in ("strong", "watch")
                     if band.get(n) is not None]
            on_a_rung = any(abs(driver.value - r) < 1e-6 for r in rungs)
            moved = abs(driver.value - base.value(driver.key)) > 1e-12
            if moved and not on_a_rung:
                assert "walked to the" not in driver.basis.lower(), (
                    "%s/%s/%s = %r claims it walked to a rung it never "
                    "reached (rungs %r): %s"
                    % (book, case.case_kind, driver.key, driver.value,
                       rungs, driver.basis))
                # and it must say what it DID do
                assert "capped" in driver.basis.lower(), (
                    book, case.case_kind, driver.key, driver.basis)


def test_e5c_the_capped_note_renders_its_cutoffs_from_the_band(agras):
    """TC-10: the rung and the width in the sentence are rendered from the
    band the verdict used, not typed in. Both must appear in the driver's
    own inputs so the arithmetic is checkable."""
    bands = agras["statements"]["assembled_bands"]["bands"]
    downside = build_case_set([agras]).case("downside")
    driver = downside.driver("dso")
    assert driver.derivation.method == "band_traverse"
    assert "capped" in driver.basis.lower()

    band = bands["dso"]
    strong, watch = float(band["strong"]), float(band["watch"])
    width = abs(strong - watch)
    # The sentence names the rung it stopped short of and the width it
    # moved by, both rendered in the driver's own unit.
    assert "75 days" in driver.basis, driver.basis
    assert "%g days" % width in driver.basis, driver.basis
    cited = dict((i.name, i.value) for i in driver.derivation.inputs)
    assert cited["band_strong"] == strong
    assert cited["band_watch"] == watch
    assert driver.value == pytest.approx(cited["base"] + width, abs=1e-6)


def test_e6_with_history_the_company_s_own_record_replaces_the_bands(agras):
    history = _history(agras, {2: 1.0 / 1.21, 1: 1.0 / 1.10})
    case_set = build_case_set(history)
    assert case_set.dispersion_method == DISPERSION_OBSERVED
    assert case_set.dispersion_label
    assert case_set.dispersion_note.strip()


def test_e7_every_case_states_how_it_was_constructed(agras):
    for case in build_case_set([agras]).cases:
        assert case.case_basis.strip()
        assert case.case_label.strip()


# ──────────────────────────────────────────────────────────────────────
# F. NO AI PRODUCES A PROJECTED NUMBER
# ──────────────────────────────────────────────────────────────────────

def test_f1_the_package_contains_no_model_call_and_no_place_for_one():
    package = os.path.join(_ROOT, "src", "engine", "forecast_drivers")
    banned = re.compile(
        r"\b(?:import\s+anthropic|from\s+anthropic|Anthropic\(|"
        r"openai|messages\.create|ANTHROPIC_API_KEY|"
        r"engine\.ai(?:_lane)?\b)")
    offenders = []
    for name in sorted(os.listdir(package)):
        if not name.endswith(".py"):
            continue
        with open(os.path.join(package, name), "r", encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                if line.lstrip().startswith("#"):
                    continue
                if banned.search(line):
                    offenders.append("%s:%d %s" % (name, lineno, line.strip()))
    assert not offenders, "AI reached the driver values: %r" % (offenders,)


def test_f2_no_network_and_no_clock_in_the_package():
    package = os.path.join(_ROOT, "src", "engine", "forecast_drivers")
    banned = re.compile(
        r"\b(?:requests\.|urllib|httpx|socket\.|datetime\.now|"
        r"datetime\.utcnow|time\.time|random\.)")
    offenders = []
    for name in sorted(os.listdir(package)):
        if not name.endswith(".py"):
            continue
        with open(os.path.join(package, name), "r", encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                if line.lstrip().startswith("#"):
                    continue
                if banned.search(line):
                    offenders.append("%s:%d %s" % (name, lineno, line.strip()))
    assert not offenders, offenders


# ──────────────────────────────────────────────────────────────────────
# G. PROVENANCE — a forecast traces to the facts it started from
# ──────────────────────────────────────────────────────────────────────

def test_g1_provenance_records_the_source_document_of_the_real_book(agras):
    provenance = build_case_set([agras]).provenance
    assert provenance["period_count"] == 1
    assert provenance["newest_period_end"] == "2025-12-31"
    assert provenance["currency"]
    source = provenance["actuals_periods"][0]
    assert source["source_document_id"] == "doc-saga_10_col_agras"
    assert str(source["content_hash"]).startswith("sha256-")
    assert provenance["driver_schema_version"]
    assert provenance["pack_id"] and provenance["pack_version"]


def test_g2_a_three_period_cagr_records_all_three_source_periods(agras):
    """One column could not hold this: a forecast built on a 3-year CAGR is
    traceable to three uploads or it is not traceable."""
    history = _history(agras, {2: 1.0 / 1.21, 1: 1.0 / 1.10})
    provenance = build_case_set(history).provenance
    assert provenance["period_count"] == 3
    ends = [p["period_end"] for p in provenance["actuals_periods"]]
    assert ends == ["2023-12-31", "2024-12-31", "2025-12-31"]
    ids = [p["source_document_id"] for p in provenance["actuals_periods"]]
    assert len(ids) == len(set(ids)), "two periods share one document id"


# ──────────────────────────────────────────────────────────────────────
# H. THE PACK, AND THE REFUSALS
# ──────────────────────────────────────────────────────────────────────

def test_h1_the_pack_is_internally_consistent(pack):
    keys = [s.key for s in pack.drivers]
    assert len(keys) == len(set(keys)), "duplicate driver key in the pack"
    for spec in pack.drivers:
        assert spec.kind in ("rate", "level"), spec.key
        assert spec.favourable_direction in ("up", "down", "neutral"), spec.key
        assert spec.case_rule in ("hold", "band_traverse", "macro_band"), \
            spec.key
        assert spec.why.strip(), "%s has no stated purpose" % (spec.key,)
        if spec.case_rule == "band_traverse":
            assert spec.band_key, spec.key
        if spec.case_rule == "macro_band":
            assert spec.macro_anchor, spec.key
            assert pack.anchor(spec.macro_anchor) is not None, spec.key


def test_h2_a_forecast_with_no_actuals_behind_it_is_refused():
    with pytest.raises(DriverError) as excinfo:
        build_case_set([])
    assert "at least one actuals period" in str(excinfo.value)


def test_h3_every_macro_anchor_declares_its_external_source(pack):
    for spec in pack.drivers:
        if not spec.macro_anchor:
            continue
        anchor = pack.anchor(spec.macro_anchor)
        assert anchor.source.strip(), spec.key
        assert anchor.stated_as_of.strip(), spec.key
        assert anchor.band_half_width >= 0.0, spec.key


# ──────────────────────────────────────────────────────────────────────
# J. ONE CONCEPT, ONE AUTHORITY
#
# Two packages derived forecast drivers from the same book and published
# them under overlapping names. Measured on the committed books before
# `engine.forecast_drivers.authority` existed:
#
#   driver              this package              engine.forecast
#   revenue_growth      0.025      fallback       0.0     engine_default
#   depreciation_rate   0.073739   derived        0.251979  derived
#   capex               0.024957   fallback       0.024923  derived
#
# and the gross-margin / cost-of-sales share disagreed on three of the
# four books. Two of those were stamped `derived` on BOTH sides, so a
# reader could be shown two measured rates for one policy with nothing
# saying which was which.
#
# The section below is the law that stops it recurring. It runs BOTH
# producers on the real books and checks the crossing, rather than
# checking a list against another list.
# ──────────────────────────────────────────────────────────────────────

from engine.forecast_drivers.authority import (  # noqa: E402
    CONCEPTS, RULED_MODEL_KEYS, AbsentHandover, AuthorityError, Concept,
    blocked_model_keys, concept_for_model_key, model_overrides,
    model_owned_keys, unrepresentable)


def _model_assumptions(payload, **overrides):
    """The projection model's own driver set for one served payload.

    Imported inside the helper, not at module scope: this file's other 66
    tests are about THIS package, and a broken sibling package should not
    stop them collecting. plan/2 B3: with the book's own context (its
    jurisdiction, contract 0.3), exactly as ``project_payload`` builds it.
    """
    from engine.forecast.project import assumptions_for_payload

    return assumptions_for_payload(payload, **overrides)


def _model_keys():
    """KEYS plus the pool FACTS the model publishes for the `read` concepts
    (plan/2 B4b, contract 4): measured by the pool split, read by key."""
    from engine.forecast.assumptions import KEYS, AssumptionSet
    return tuple(KEYS) + tuple(AssumptionSet.POOL_FACTS)


def _base(book):
    return build_case_set([_load(book)]).case("base")


# ── the registry itself ───────────────────────────────────────────────

def test_j1_no_model_key_is_claimed_by_two_concepts():
    """The registry cannot itself contain the shape it forbids."""
    seen = {}
    for concept in CONCEPTS:
        assert concept.why, concept.concept_id
        for key in concept.model_keys:
            assert key not in seen, (
                "model key %r is claimed by both %r and %r"
                % (key, seen.get(key), concept.concept_id))
            seen[key] = concept.concept_id
    assert len(RULED_MODEL_KEYS) == len(seen)


def test_j2_every_ruled_key_still_exists_in_the_model():
    """A key renamed or dropped on the model side must red HERE, not in
    production, because a ruling about a key nobody has is not a ruling."""
    real = set(_model_keys())
    missing = sorted(k for k in RULED_MODEL_KEYS if k not in real)
    assert not missing, (
        "the registry rules on model key(s) the model no longer has: %s. "
        "The ownership ruling is stale." % (", ".join(missing),))


def test_j3_every_concept_this_package_owns_is_a_driver_it_publishes(pack):
    keys = set(s.key for s in pack.drivers)
    for concept in CONCEPTS:
        if concept.driver_key is None:
            continue
        assert concept.driver_key in keys, (
            "concept %r claims to be published as driver %r, which this "
            "pack does not declare" % (concept.concept_id,
                                       concept.driver_key))


def test_j4_a_model_only_concept_cannot_also_be_published_here(pack):
    keys = set(s.key for s in pack.drivers)
    for concept in CONCEPTS:
        if concept.status != "model_only":
            continue
        for key in concept.model_keys:
            assert key not in keys, (
                "%r is declared the model's own, but this pack publishes a "
                "driver of the same name" % (key,))


def test_j5_a_concept_cannot_be_registered_without_its_argument():
    with pytest.raises(AuthorityError) as excinfo:
        Concept("x", "engine.forecast_drivers", "supplied", "dso",
                ("dso_days",), "identity", "")
    assert "no stated reason" in str(excinfo.value)


# ── the crossing, measured on real books ──────────────────────────────

@pytest.mark.parametrize("book", _BOOKS)
def test_j6_after_the_handover_the_model_measures_nothing_this_package_owns(book):
    """THE LAW. A key may be measured from the book by ONE package.

    After the assumption set is handed over, any key the model still
    derives for itself must be one the registry has already argued is a
    DIFFERENT quantity under the same name (`blocked`). The check is a
    SUBSET, deliberately: closing a blocked concept must leave this
    green, so the gate never becomes a reason to revert a repair.
    """
    payload = _load(book)
    base = build_case_set([payload]).case("base")
    after = _model_assumptions(payload, **model_overrides(base))

    ours = set(concept.driver_key for concept in CONCEPTS
               if concept.driver_key is not None)
    still = tuple(a.key for a in after.items() if a.source == "derived")
    collisions = tuple(
        k for k in still
        if k in ours or (concept_for_model_key(k) is not None
                         and concept_for_model_key(k).status != "model_only"))
    unexpected = tuple(k for k in collisions if k not in blocked_model_keys())
    assert not unexpected, (
        "%s: the model still measures %s from the book, and this package "
        "publishes the same concept. One book, two authorities, no reader "
        "able to tell which number they are looking at. Either hand it "
        "over in authority.model_overrides() or register the concept as "
        "blocked with the measured reason it cannot cross."
        % (book, ", ".join(unexpected)))


@pytest.mark.parametrize("book", _BOOKS)
def test_j7_every_supplied_concept_arrives_with_this_packages_value(book):
    """The handover is not just a keyword — the model must end up holding
    OUR number, under its own name, stamped as a caller's."""
    payload = _load(book)
    base = build_case_set([payload]).case("base")
    after = _model_assumptions(payload, **model_overrides(base))

    checked = 0
    for concept in CONCEPTS:
        if concept.status != "supplied":
            continue
        driver = base.driver(concept.driver_key)
        assert driver is not None, concept.driver_key
        if driver.value is None:
            continue
        want = concept.convert(driver.value)
        for model_key in concept.model_keys:
            got = after[model_key]
            assert got.source == "caller", (
                "%s/%s: handed over but the model kept its own %s value"
                % (book, model_key, got.source))
            if driver.exact is not None:
                # plan/2 B3 (contract 4): the crossing carries the EXACT
                # integer, unrounded. This asserted the model held the
                # display value within 5e-7, which a day count rounded to
                # four places (26.2057 for 26.205674) can never meet once
                # the crossing stops rounding — the gate is restated on the
                # integer it is now about.
                assert got.exact == concept.convert_exact(
                    driver.exact, driver.unit), (
                    "%s/%s: this package publishes %r exactly, the model "
                    "holds %r" % (book, model_key, driver.exact, got.exact))
                # and a hand-over never demotes the engine's tier to a
                # caller's
                assert got.tier == driver.tier, (book, model_key, got.tier)
            else:
                assert got.value() == pytest.approx(want, abs=5e-7), (
                    "%s/%s: this package publishes %r, the model holds %r"
                    % (book, model_key, want, got.value()))
            checked += 1
    assert checked, "%s: nothing crossed at all" % (book,)


@pytest.mark.parametrize("book", _BOOKS)
def test_j8_an_absent_driver_never_becomes_a_number_in_the_handover(book):
    """ABSENT != ZERO, at the boundary between the two packages.

    RETIRED AND RESTATED (plan/2 B3, contract 4: "an absent concept
    crosses as an explicit absent object, never dropped"). This asserted
    an absent driver did not appear in the overrides at all, because the
    model's channel dropped a None. That drop is gone; the law it guarded
    survives in the stronger form — an absent driver crosses, but only as
    an AbsentHandover carrying its reason, never as a number or a None.
    """
    base = _base(book)
    overrides = model_overrides(base)
    crossed_absent = 0
    for concept in CONCEPTS:
        if concept.status == "model_only":
            continue
        driver = base.driver(concept.driver_key)
        if driver is None or driver.value is not None:
            continue
        for model_key in concept.model_keys:
            value = overrides.get(model_key)
            assert isinstance(value, AbsentHandover), (
                "%s: %r is ABSENT here but was handed to the model as %r"
                % (book, concept.driver_key, value))
            assert value.reason == driver.basis
            crossed_absent += 1
    for value in overrides.values():
        assert value is not None
        if isinstance(value, AbsentHandover):
            assert not isinstance(value, float)
    assert crossed_absent, "%s: no absent concept crossed (TC-3)" % (book,)


def test_j9_the_models_channel_refuses_a_none_and_honours_an_absent_handover():
    """RETIRED AND RESTATED (plan/2 B3). This proved the model's channel
    DROPPED a None — the silence contract 4 removes ("the None check is
    removed"). After the repair: a None is refused by name, and the
    explicit absent hand-over removes the model's book rung, recording the
    authority's reason, while its ladder continues.

    RESTATED AGAIN (B3 repair): tax_rate now reads the engine, so on the
    calibration book it crosses the engine's statutory value, not an
    absence. The absence is built where it is real — a copy whose
    jurisdiction is not recorded, where both packages end absent — and
    handed to the RO book, whose ladder continues to the statutory rung."""
    from engine.forecast.errors import AssumptionError

    payload = _load(_CALIBRATION_BOOK)
    with pytest.raises(AssumptionError) as caught:
        _model_assumptions(payload, tax_rate=None)
    assert "None is not a driver value" in str(caught.value)
    unrecorded = copy.deepcopy(payload)
    unrecorded["envelope"].pop("pack_provenance", None)
    unrecorded["envelope"].pop("ai_audit", None)
    handover = model_overrides(
        build_case_set([unrecorded]).case("base"))["tax_rate"]
    assert isinstance(handover, AbsentHandover)
    after = _model_assumptions(payload, tax_rate=handover)
    assert after["tax_rate"].tier == "macro"
    assert after["tax_rate"].fallback_steps[0]["tier"] == "book"
    assert after["tax_rate"].fallback_steps[0]["reason"] == handover.reason


@pytest.mark.parametrize("book", _BOOKS)
def test_j10_what_cannot_cross_is_named_rather_than_silently_asserted(book):
    """Every absence the model's shape cannot be told about is reported,
    with this package's own basis attached, so a surface can print the
    refusal beside whatever the model asserted instead."""
    base = _base(book)
    reported = unrepresentable(base)
    absent_supplied = tuple(
        c.driver_key for c in CONCEPTS
        if c.status == "supplied"
        and base.driver(c.driver_key) is not None
        and base.driver(c.driver_key).value is None)
    assert tuple(r["driver_key"] for r in reported) == absent_supplied
    for row in reported:
        assert row["status"] == "absent"
        assert row["basis"].strip(), row["driver_key"]
        assert row["model_keys"]


def test_j11_a_blocked_concept_must_argue_the_change_that_would_close_it():
    """A refusal to cross is only legitimate while it says what would
    make it unnecessary. Otherwise `blocked` becomes a permanent excuse
    for two authorities.

    RETIRED AS ITS OWN DOCSTRING INSTRUCTED (plan/2 B3, contract 4:
    "blocked_model_keys is emptied"). The one blocked concept,
    depreciation_rate, crosses since B3: this package's gross-base rate
    was renamed depreciation_share_of_gross_depreciable_base and the
    engine's closing-NBV rate is published under the name. What survives
    is the rule for any FUTURE blocked concept, and the record that none
    remains."""
    blocked = tuple(c for c in CONCEPTS if c.status == "blocked")
    assert blocked_model_keys() == ()
    for concept in blocked:  # pragma: no cover - none remain at B3
        assert "Closing it needs" in concept.why, (
            "%s is blocked with no stated route out" % (concept.concept_id,))


def test_j12_the_model_owns_only_the_projections_own_mechanics(pack):
    """A model-only key must not be a property of the COMPANY. The proof
    used here is behavioural: on every real book the model reaches these
    keys without measuring anything from that book."""
    owned = model_owned_keys()
    assert owned, "the registry rules nothing as the model's own"
    for book in _BOOKS:
        after = _model_assumptions(_load(book))
        for key in owned:
            assert after[key].source != "derived", (
                "%s: %r is registered as the projection's own mechanic but "
                "the model measured it from the book" % (book, key))


# ── A3: a stated basis whose arithmetic reproduces its own number ─────

#: Derivation methods whose arithmetic this file can redo, and the shape
#: it redoes them in. A base-case driver whose method is not here cannot
#: be checked, and test_j13 reds rather than skipping it.
#: plan/2 B3: ``engine_forecast`` — a shared concept read from the model's
#: own resolution, whose first input is the engine's exact value (the
#: arithmetic behind it is gated by the model's own tests and by
#: forecast-authority); ``pack_convention`` — the convention rung.
_ONE_INPUT_METHODS = ("published_ratio", "pack_macro", "engine_assumption",
                      "pack_default", "engine_forecast", "pack_convention")
_QUOTIENT_METHODS = ("period_ratio",)
_SHARE_METHODS = ("nature_split",)
_ARITHMETIC_METHODS = (_ONE_INPUT_METHODS + _QUOTIENT_METHODS
                       + _SHARE_METHODS)


def _recompute(derivation):
    """The value the derivation's OWN stated inputs produce, or None when
    the method is not one of the arithmetic shapes."""
    inputs = derivation.inputs
    if derivation.method in _QUOTIENT_METHODS and len(inputs) == 2:
        if inputs[0].value is None or not inputs[1].value:
            return None
        return inputs[0].value / inputs[1].value
    if derivation.method in _SHARE_METHODS and len(inputs) == 2:
        base = (inputs[0].value or 0.0) + (inputs[1].value or 0.0)
        return (inputs[0].value / base) if base else None
    if derivation.method in _ONE_INPUT_METHODS and inputs:
        return inputs[0].value
    return None


@pytest.mark.parametrize("book", _BOOKS)
def test_j13_every_base_value_reproduces_from_its_own_stated_inputs(book, pack):
    """A3. The sentence beside a number is only worth something if you
    can redo the arithmetic it describes and land on the same number.

    Every BASE driver that carries a value must be redoable — a new
    derivation whose method this file does not know reds here rather than
    slipping through unchecked. The two case sets are excluded on
    purpose: their arithmetic is the band traverse, which the E-series
    tests above already gate against the report's own rungs.
    """
    base = build_case_set([_load(book)]).case("base")
    checked = 0
    for driver in base.drivers:
        if driver.value is None:
            continue
        assert driver.derivation.method in _ARITHMETIC_METHODS, (
            "%s/%s carries a value by method %r, which nothing here can "
            "redo. Either it is not arithmetic — in which case say how the "
            "number was arrived at — or this gate has to learn it."
            % (book, driver.key, driver.derivation.method))
        recomputed = _recompute(driver.derivation)
        assert recomputed is not None, (
            "%s/%s: method %r but its inputs do not form that shape"
            % (book, driver.key, driver.derivation.method))
        places = pack.round_for(driver.unit)
        assert round(recomputed, places) == pytest.approx(
            driver.value, abs=10 ** -places), (
            "%s/%s: stored %r, but its own inputs give %r"
            % (book, driver.key, driver.value, recomputed))
        checked += 1
    assert checked == len([d for d in base.drivers if d.value is not None])
    assert checked, "%s: no base driver carried a value at all" % (book,)


@pytest.mark.parametrize("book", _BOOKS)
def test_j14_a_derived_driver_never_rests_on_a_pack_constant(book):
    """`derived` means measured from THIS company. A default read out of
    the pack is `fallback`, and the distinction is the whole point of the
    three-way status."""
    case_set = build_case_set([_load(book)])
    for case in case_set.cases:
        for driver in case.drivers:
            if driver.status != "derived":
                continue
            for item in driver.derivation.inputs:
                assert not item.authority.startswith("pack"), (
                    "%s/%s/%s is stamped derived but reads %r from %s"
                    % (book, case.case_kind, driver.key, item.name,
                       item.authority))


@pytest.mark.parametrize("book", _BOOKS)
def test_j15_a_basis_that_names_the_engine_must_read_the_engine(book):
    """The defect this reds on, after the repair: `debt_repayment_years`
    claimed to reuse "the tenor the engine's own DSCR already amortises
    debt over" while taking 8.0 from a constant in this package's pack.
    The two agreed on the day it was written and nothing would have
    noticed when they stopped."""
    case_set = build_case_set([_load(book)])
    for case in case_set.cases:
        for driver in case.drivers:
            label = driver.derivation.method_label.lower()
            if "the engine's own" not in label:
                continue
            authorities = [i.authority for i in driver.derivation.inputs]
            assert authorities, driver.key
            for authority in authorities:
                assert not authority.startswith("pack"), (
                    "%s/%s/%s says its basis is %r but reads it from %s"
                    % (book, case.case_kind, driver.key,
                       driver.derivation.method_label, authority))


@pytest.mark.parametrize("book", _BOOKS)
def test_j16_the_debt_tenor_is_the_one_the_served_dscr_note_declares(book):
    """TC-10, and the concrete form of test_j15: the tenor is RENDERED
    from the engine's own published note, never typed here. Change the
    engine's DSCR tenor and this driver follows it."""
    payload = _load(book)
    note = str((((payload.get("envelope") or {}).get("methodology") or {})
                .get("ratios") or {}).get("dscr_approx", {}).get("note") or "")
    match = re.search(r"(\d+(?:\.\d+)?)\s*y", note, re.IGNORECASE)
    driver = _base(book).driver("debt_repayment_years")
    if match is None:
        assert driver.derivation.source.startswith("pack:")
        return
    assert driver.value == pytest.approx(float(match.group(1)))
    assert driver.derivation.source == "envelope:methodology.ratios.dscr_approx"


@pytest.mark.parametrize("book", _BOOKS)
def test_j17_every_percentage_written_into_a_note_is_one_of_its_own_numbers(book):
    """TC-10. A percentage in prose that no input carries is a threshold
    someone typed, and the next reader cannot tell it from a measurement."""
    percent = re.compile(r"(-?\d[\d,]*(?:\.\d+)?)\s*%")
    case_set = build_case_set([_load(book)])
    for case in case_set.cases:
        for driver in case.drivers:
            note = driver.derivation.note or ""
            if not percent.search(note):
                continue
            known = set()
            for item in driver.derivation.inputs:
                if item.value is None:
                    continue
                for places in range(0, 7):
                    known.add(round(item.value, places))
                    known.add(round(item.value * 100.0, places))
            if driver.value is not None:
                known.add(round(driver.value, 6))
                known.add(round(driver.value * 100.0, 6))
            for token in percent.findall(note):
                number = float(token.replace(",", ""))
                # a case clone does not carry the pedigree; its steps are
                # the base driver's (the rungs are resolved once, B3-8)
                rejected = [step["reason"] for source in
                            (driver, case_set.case("base").driver(driver.key))
                            for step in
                            (getattr(source, "fallback_steps", None) or ())
                            if step.get("outcome") in ("absent", "rejected")]
                if any(token + "%" in reason or token + " %" in reason
                       for reason in rejected):
                    # plan/2 B3 repair: a driver read from the engine quotes
                    # the reason each rung it did NOT take was refused
                    # (tax: "an effective rate of 9.4465% read off two
                    # figures inside that build-up"). That percentage is
                    # the measurement the rung REJECTS, computed by the
                    # engine from the book's own figures, and it is quoted
                    # verbatim from the recorded fallback step, never typed.
                    continue
                if driver.status == "absent" and number == 0.0:
                    # plan/2 B3: an ABSENT driver read from the engine
                    # quotes the engine's refusal ("it is not taken to be
                    # 0%"). The 0% is the value the refusal REJECTS, not a
                    # threshold, and an absent driver carries no value to
                    # match it against. Any other percentage still reds.
                    continue
                assert any(abs(number - k) < 1e-6 for k in known), (
                    "%s/%s/%s: the note says %s%% and no input, and not the "
                    "driver's own value, carries it"
                    % (book, case.case_kind, driver.key, token))


@pytest.mark.parametrize("book", _BOOKS)
def test_j18_the_pedigree_travels_with_the_numbers(book):
    """The model stamps everything handed to it "supplied by the caller",
    which erases the difference between a measurement, a proxy the engine
    itself warns about, and a central bank's anchor. `handover_basis`
    carries that difference across, keyed by the name the consuming
    surface will hold, and it must cover EVERY key that crossed."""
    from engine.forecast_drivers.authority import handover_basis

    base = _base(book)
    overrides = model_overrides(base)
    carried = handover_basis(base)
    assert set(carried) == set(overrides), (
        "%s: %s crossed with no pedigree behind it"
        % (book, sorted(set(overrides) - set(carried))))
    for model_key, entry in carried.items():
        driver = base.driver(entry["driver_key"])
        assert entry["basis"].strip(), model_key
        assert entry["basis"] == driver.basis
        assert entry["status"] == driver.status
        if entry["status"] == "absent":
            # plan/2 B3: an absent concept crosses with its reason and no
            # value; it has no authority to cite and no exact integer.
            assert isinstance(overrides[model_key], AbsentHandover)
            assert entry["exact"] is None, model_key
            continue
        assert entry["status"] in ("derived", "fallback"), model_key
        assert entry["authority"], model_key
        assert entry["periods_used"], model_key


def test_j19_a_fallback_does_not_cross_over_looking_like_a_measurement():
    """The concrete case: on every committed book `capex_rate` is a
    fallback carrying the engine's own note that it is a D&A proxy, and
    `revenue_growth` is the macro anchor. Neither may reach a reader as
    an unqualified number."""
    from engine.forecast_drivers.authority import handover_basis

    base = _base(_CALIBRATION_BOOK)
    carried = handover_basis(base)
    assert carried["capex_pct_of_revenue"]["status"] == "fallback"
    assert carried["revenue_growth"]["status"] == "fallback"
    non_derived = sorted(k for k, v in carried.items()
                         if v["status"] != "derived")
    assert non_derived, (
        "nothing crossing is a fallback any more — if that is real, the "
        "drivers improved; check it before loosening this")


# ══════════════════════════════════════════════════════════════════════
# SECTION HX — THE HANDOVER MUST NOT LOSE, OR INVENT, A REASON
#
# `hx`, not `h`: this file already has a Section H (the pack and its
# macro anchors, `test_h1_the_pack_is_internally_consistent` onward) and
# two sections answering to `-k h1` is a way to run half a gate and
# believe it was all of it.
#
# Two defects, one family: an ABSENCE or an UNATTRIBUTED figure resolving
# to a number that flatters the plan.
#
#   H1  `assembled_pl.income_tax == 0.00` on a book carrying no class-69
#       account crossed as a `derived` 0% effective rate, over the
#       model's own stated statutory default, and deleted both parties'
#       reasons on the way. MEASURED on the committed retail book before
#       the repair: 5y net income 4,874,067.83 / tax -928,393.86 with the
#       model alone, against 5,802,461.69 / 0.00 with the 0.0 crossed.
#   H2  every crossed driver reached the wire stamped "supplied by the
#       caller" with an empty derivation — 10 of 21 on agras and retail,
#       8 on carniprod, 7 on realestate.
# ══════════════════════════════════════════════════════════════════════

# ── H1: an unattributed zero is an absence ────────────────────────────

#: The class the Romanian chart of accounts holds the profit-tax charge in
#: (691 impozit pe profit, 698). The rule that read it was retired by the
#: B3 repair (contract 4: one derivation); the tests keep it only to build
#: and describe their books.
_TAX_ACCOUNT_CLASS = ("69",)


@pytest.mark.parametrize("book", _BOOKS)
def test_hx1_a_zero_tax_charge_no_account_stands_behind_is_refused(book):
    """UNATTRIBUTED != MEASURED.

    RESTATED (plan/2 B3 repair, contract 4, R16). This package's second
    tax rule (a class-69 account must stand behind the charge) is retired:
    the concept has ONE derivation, the engine's effective-rate rule. The
    law that survives: a 0.00 charge no class-69 account stands behind is
    never published as a measured rate unless the book's pre-tax result
    less that nil charge IS the profit it filed in account 121 (the tie is
    then the measurement). On the corpus books realestate and retail carry
    no class-69 account; realestate does not tie, so it measures no rate.
    RESTATED (plan/2 B4a): retail TIES once its mirrored 609/709 rows are
    read as reductions (the 2,043,254.64 gap was the double count), so on
    retail the nil charge is now the measurement — book 0, on both paths —
    exactly the hx2b law. Which branch a book takes is read off the book
    (its unexplained step against 121), never off its name.
    """
    from engine.forecast_drivers.reader import ActualsPeriod

    payload = _load(book)
    period = ActualsPeriod(payload)
    driver = _base(book).driver("tax_rate")
    tax = period.pl("income_tax")
    if period.accounts_with_prefix(_TAX_ACCOUNT_CLASS) or tax is None \
            or abs(tax) > 1e-9:
        return
    model = _model_assumptions(payload)["tax_rate"]
    unexplained = float(payload["statements"]["assembled_pl"].get(
        "net_income_unexplained_vs_121") or 0.0)
    if abs(unexplained) < 0.005:
        assert model.tier == "book" and driver.tier == "book", (
            "%s ties to account 121 with a nil charge and no class-69 "
            "account: the tie is the measurement (book 0), got %r / %r"
            % (book, model.tier, driver.tier))
        assert driver.value == 0, (book, driver.value)
        return
    assert model.tier != "book" and driver.tier != "book", (
        "%s: income_tax is %r, no class-69 account stands behind it and "
        "the build-up does not tie, but a rate was measured (%r / %r)"
        % (book, tax, driver.value, driver.tier))
    assert driver.fallback_steps and \
        driver.fallback_steps[0]["tier"] == "book", (book,
                                                     driver.fallback_steps)


def test_hx2_a_nil_charge_an_account_does_stand_behind_still_measures_zero():
    """A nil charge on a book that ties is a measurement.

    RESTATED (B3 repair): the value now comes from the engine's rule, so
    the note is the engine's measured-nil sentence, and the integer and
    tier are the engine's."""
    payload = _retail_that_ties()
    payload["line_items"].append({
        "ro_account_code": "691",
        "label": "Cheltuieli cu impozitul pe profit",
        "amount": 0.0,
        "is_derived": False,
    })
    driver = build_case_set([payload]).case("base").driver("tax_rate")
    assert driver.status == "derived" and driver.value == 0.0, (
        "a nil charge on a book that ties is a measurement: got %r / %r"
        % (driver.value, driver.status))
    assert driver.tier == "book" and driver.exact == 0
    assert "the charge it measures is nil" in driver.derivation.note


def _retail_that_ties():
    """The retail book with its build-up made to reach account 121.

    Retail's own reconstruction misses the 3,205,212.62 it filed by
    2,043,254.64, and that gap alone refuses the rate — which means the
    ATTRIBUTION condition is not independently load-bearing on any
    committed book, and a gate written only against them would pass
    whether or not it existed. This copy removes the gap so the other
    condition is the only thing left standing, and `test_hx2` /
    `test_hx2b` differ from each other in exactly the class-69 account.

    THE FILED FIGURE IS MOVED, NOT THE FIELD THAT REPORTS ON IT. This
    helper used to tie the book by zeroing
    `assembled_pl.net_income_unexplained_vs_121` while leaving the
    account-121 closing balance in the envelope at 3,205,212.62. That is
    not a book that ties — it is exactly the shape the Romanian assembly
    emits when its anchor override does NOT fire, which is the defect
    `test_hg1` now reds on. Making the FILED balance the reconstruction
    is the only edit that produces a book whose two statements of its own
    profit agree; `_micro_book` builds the old shape from the real
    assembly, under its true name.
    """
    payload = copy.deepcopy(_load("retail"))
    pl = payload["statements"]["assembled_pl"]
    reconstructed = round(pl["pretax"] - pl["income_tax"], 2)
    pl["net_income_statutory"] = reconstructed
    pl["net_income_unexplained_vs_121"] = 0.0
    pl["net_income_reconciliation_to_121"] = 0.0
    block = _p121_block(payload)
    block["p121"] = reconstructed
    block["cls7_minus_cls6"] = round(
        reconstructed + (pl.get("capitalized_own_work_memo") or 0.0)
        + (pl.get("inventory_variation_memo") or 0.0), 2)
    block["ok"] = True
    return payload


def _p121_block(payload):
    """The account-121 cross-check block, in place, for a test to shape."""
    return (((payload["envelope"]["canonical_bs"])["invariants"])
            ["p121_cross_check"])


def test_hx2b_a_tying_book_measures_the_same_nil_rate_with_or_without_a_charge_account():
    """RETIRED: test_hx2b_a_tying_book_with_no_charge_account_still_refuses.

    It pinned this package's second tax rule (class-69 attribution) as
    law, which gave the drivers path an absence where GET measured 0% and,
    once absences crossed (B3), a 16% statutory charge on the drivers path
    against 0 on GET for the same book (549,384.54 RON of tax over three
    years on this copy). Contract 3.4 and R16 name the engine's existing
    effective-rate rule as the book rung, so that rule is the one
    derivation (contract 4).

    NEW ASSERTION: on a book whose pre-tax result less a nil charge IS the
    profit it filed in account 121, both packages hold the same measured
    0% (tier book, integer 0) whether or not a class-69 account is in the
    chart — the tie itself shows no charge was booked against the filed
    profit — and the plan they project charges the same tax.
    """
    from engine.forecast import project_payload

    bare = _retail_that_ties()
    charged = _retail_that_ties()
    charged["line_items"].append({
        "ro_account_code": "691", "label": "Cheltuieli cu impozitul pe profit",
        "amount": 0.0, "is_derived": False})
    seen = []
    for name, payload in (("no class-69 account", bare),
                          ("a nil class-69 account", charged)):
        base = build_case_set([payload]).case("base")
        driver = base.driver("tax_rate")
        model = _model_assumptions(payload)["tax_rate"]
        crossed = _model_assumptions(payload, **model_overrides(base))[
            "tax_rate"]
        got = ((driver.tier, driver.exact), (model.tier, model.exact),
               (crossed.tier, crossed.exact))
        assert got == (("book", 0),) * 3, (name, got)
        get_tax = sum(p.pl["income_tax"] for p in
                      project_payload(payload, horizon_years=3).periods)
        drv_tax = sum(p.pl["income_tax"] for p in project_payload(
            payload, horizon_years=3, **model_overrides(base)).periods)
        assert get_tax == drv_tax, (name, get_tax, drv_tax)
        seen.append(got)
    assert seen[0] == seen[1]


@pytest.mark.parametrize("book", _BOOKS)
def test_hx3_the_two_producers_hold_one_tax_rate_or_neither_holds_one(book):
    """One concept, one value, across both producers.

    RESTATED (plan/2 B3 repair, contract 4): the two packages used to
    carry two conditions for when the rate is measurable. There is now one
    derivation, so the law is exact: both producers hold the same tier and
    the same integer (or both are absent), and what crosses is that value
    with its tier — an absence crosses as an AbsentHandover, never a
    number.
    """
    payload = _load(book)
    ours = _base(book).driver("tax_rate")
    theirs = _model_assumptions(payload)["tax_rate"]
    assert (ours.tier, ours.exact) == (theirs.tier, theirs.exact), (
        "%s: this package holds %r/%r and the model %r/%r — one book, two "
        "answers" % (book, ours.tier, ours.exact, theirs.tier, theirs.exact))
    crossed = model_overrides(_base(book)).get("tax_rate")
    if ours.value is None:
        assert isinstance(crossed, AbsentHandover), (book, crossed)
        return
    after = _model_assumptions(payload, tax_rate=crossed)["tax_rate"]
    assert (after.tier, after.exact) == (theirs.tier, theirs.exact), (
        book, after.tier, after.exact)
    if theirs.tier != "book":
        assert theirs.basis.strip(), (
            "%s: the model substitutes a rate, so it owes the reason"
            % (book,))


@pytest.mark.parametrize("book", _BOOKS)
def test_hx4_a_profitable_projected_plan_is_never_charged_nothing(book):
    """The consequence, on the real wire rather than in the driver set.

    A five-year plan that earns a positive pre-tax result and pays 0.00
    of tax is the shape H1 produced. Reds if any absent-or-unattributed
    rate ever reaches the projection as a zero again, from any route.
    """
    from engine.forecast import project_payload

    payload = _load(book)
    projection = project_payload(payload, **model_overrides(_base(book)))
    pretax = tax = 0.0
    for period in projection.periods:
        pl = period.as_dict()["pl"]
        pretax += float(pl["pretax_result"])
        tax += float(pl["income_tax"])
    if pretax <= 0.0 or abs(tax) > 0.0:
        return
    #: A plan CAN honestly be charged nothing — but only when the rate in
    #: force is a measured zero, which under the engine's effective-rate
    #: rule (the one derivation, plan/2 B3 repair) means a nil charge on a
    #: build-up that reached account 121. Anything else means an absence
    #: became a number.
    #: Written this way so the gate cannot red on a correct product: it
    #: refuses the unexplained zero, not the zero.
    rate = projection.assumptions["tax_rate"]
    driver = _base(book).driver("tax_rate")
    assert (rate.source == "caller" and rate.value() == 0.0
            and driver.status == "derived" and driver.value == 0.0), (
        "%s: the plan earns %.2f of pre-tax profit over the horizon and "
        "is charged %.2f of tax, and the rate in force is %r from %r "
        "rather than a measured nil. Either a rate was read out of a "
        "charge nothing stands behind, or one crossed that should not "
        "have." % (book, pretax, tax, rate.value(), rate.source))


# ── H2: the pedigree survives the hop ─────────────────────────────────

@pytest.mark.parametrize("book", _BOOKS)
def test_hx5_every_crossed_value_carries_its_own_pedigree(book):
    """The number and the reason travel together, through one channel.

    `handover_basis` published the reasons in a second dict beside the
    values; nothing plumbed it, so the reasons were simply not rendered.
    Now the value IS the pedigree's carrier, and the two routes are built
    by one function — checked here by comparing them, not by trusting it.
    """
    from engine.forecast_drivers.authority import (SuppliedValue,
                                                   handover_basis)

    base = _base(book)
    overrides = model_overrides(base)
    carried = handover_basis(base)
    assert set(overrides) == set(carried)
    for model_key, value in overrides.items():
        if isinstance(value, AbsentHandover):
            # plan/2 B3: an absence crosses with its reason attached
            assert value.pedigree == carried[model_key]
            assert value.reason == base.driver(
                value.pedigree["driver_key"]).basis
            continue
        assert isinstance(value, SuppliedValue), (
            "%s/%s crossed as a bare %s — the reason it is that number is "
            "gone the moment it leaves this package"
            % (book, model_key, type(value).__name__))
        assert value.pedigree == carried[model_key], (
            "%s/%s: the value's pedigree and the published map disagree — "
            "two reasons for one number" % (book, model_key))
        driver = base.driver(value.pedigree_driver_key)
        assert value.pedigree["basis"] == driver.basis
        assert value.pedigree_status == driver.status
        assert value.pedigree_status in ("derived", "fallback")
        assert value.pedigree_basis.strip(), model_key
        assert value.pedigree_from, (
            "%s/%s crossed with no served field path behind it"
            % (book, model_key))
        if value.pedigree["translation"] not in (None, "identity"):
            assert value.pedigree_basis != driver.basis, (
                "%s/%s holds a different quantity than the driver it came "
                "from, so the sentence beside it must say so"
                % (book, model_key))


def test_hx6_a_crossed_value_is_indistinguishable_from_a_float():
    """The trap this type sets for its own author, pinned.

    `engine.forecast.money._exact_fraction` parses a float through
    `Fraction(str(value))`. A friendlier `__repr__` was written on
    `SuppliedValue` first and every crossed driver died with
    `ValueError: Invalid literal for Fraction:
    'SuppliedValue(0.025, fallback, revenue_growth)'`, because `float`
    takes `__str__` from `__repr__`. Nothing else in the suite saw it
    until the model was actually asked to coerce one.
    """
    from engine.forecast.money import _exact_fraction
    from engine.forecast_drivers.authority import SuppliedValue

    plain = 0.603717
    carried = SuppliedValue(plain, {"basis": "b", "authority": ["a"],
                                    "status": "derived",
                                    "driver_key": "gross_margin"})
    assert str(carried) == str(plain)
    assert repr(carried) == repr(plain)
    assert json.dumps(carried) == json.dumps(plain)
    assert _exact_fraction(carried, "a rate", True) == _exact_fraction(
        plain, "a rate", True)
    assert float(carried) == plain and carried == plain


@pytest.mark.parametrize("book", _BOOKS)
# THE MARKER IS GONE BECAUSE THE DEFECT IS. It was
# `xfail(strict=True)` naming the exact one-line change owed by
# `engine.forecast.assumptions._build`, precisely so it could not
# outlive the repair — a strict xfail XPASSES, and reports red, the
# moment the product becomes correct. It did, in the same commit that
# landed the change: the pedigree is now read off the value
# (`SuppliedValue.pedigree_basis` / `.pedigree_from`) instead of
# being stamped "supplied by the caller" with an empty derivation.
#
# Measured before: 15 of 21 drivers reached the wire with no
# derivation, 9 of them saying "supplied by the caller". After: 0
# on all four books.
def test_hx7_the_pedigree_reaches_the_wire(book):
    """A projected figure must resolve to the assumptions behind it.

    Measured after the handover, before the change above: 15 of 21
    drivers reach `fp1_assumptions()` with an empty derivation and 10 of
    them (agras / retail; 8 carniprod, 7 realestate) say "supplied by the
    caller", which resolves to nothing at all.
    """
    from engine.forecast import project_payload

    overrides = model_overrides(_base(book))
    projection = project_payload(_load(book), **overrides)
    # plan/2 B3: an AbsentHandover crosses a REASON, not a measurement, so
    # the model keeps its own ladder's rung (with its own pedigree) for it;
    # only a crossed VALUE must arrive with a measured derivation.
    crossed = set(k for k, v in overrides.items()
                  if not isinstance(v, AbsentHandover))
    absent = set(overrides) - crossed
    blank = sorted(
        row["id"] for row in projection.fp1_assumptions()
        if (row["id"] in crossed
            and (row["basis"].startswith("supplied by the caller")
                 or not row["derived_from"]))
        or (row["id"] in absent
            and row["basis"].startswith("supplied by the caller")))
    assert not blank, (
        "%s: %s crossed with a measured pedigree and reached the wire "
        "with none" % (book, ", ".join(blank)))


# ══════════════════════════════════════════════════════════════════════
# SECTION HG — THE CONDITION RESTED ON A FIELD THAT IS SET TO ZERO
#              WITHOUT ANYTHING HAVING BEEN MEASURED
#
# MEASURED BEFORE (through the REAL Romanian assembly, not a fixture
# edit — `_micro_book` below calls `assemble_statements`):
#
#   filed in 121   build-up   miss                assembled_pl says   driver
#   19,000.00      19,000.00      0.00            unexplained 0.00    derived 5%
#   15,000.00      19,000.00  4,000.00 (26.7%)    unexplained 0.00    derived 5%
#   (no 121 row)   19,000.00  not measurable      unexplained 0.00    derived 5%
#
# The middle and bottom rows are the defect. `chart_of_accounts.py`
# replaces the reconstruction with the filed figure only when the two
# differ by more than `max(|account 121|, 100_000) * 0.05`; in every
# other case — INCLUDING the case where there is no account 121 to
# compare against — it writes a literal `0.0` into
# `net_income_unexplained_vs_121`. Both producers read that field and
# both concluded "the build-up ties". The 100,000 floor is what makes
# the tolerated miss unbounded as a share of the profit on a small book,
# and this platform serves small books.
#
# The repair reads the account's own closing balance
# (`canonical_bs.invariants.p121_cross_check.p121`), which is published
# whether or not the override fired and is None — not zero — when no
# account-121 row survived extraction.
#
# ── ADDENDUM 2026-09-09: THE BAND IS GONE, so two rows of the table
#    above are now HISTORY, not current engine behaviour. ──────────────
#
# `chart_of_accounts.py` now anchors `net_income_statutory` to account
# 121 ALWAYS; the 5% / 100,000-floor band was removed. Re-measured on
# the same three shapes:
#
#   filed in 121   build-up   miss       assembled_pl says   driver
#   19,000.00      19,000.00      0.00   unexplained     0.00  derived 5%
#   15,000.00      19,000.00  4,000.00   unexplained −4,000.00 absent
#   (no 121 row)   19,000.00  not meas.  unexplained     0.00  absent
#
# So the middle row's blind spot is REPAIRED UPSTREAM. The bottom row is
# not, and cannot be: with no account 121 there is nothing to compare
# against, and the field still says 0.00. That is the one surviving
# shape in which this field reports "nothing unexplained" without a
# comparison having been made, and it is why the drivers below read
# `p121_cross_check.p121` — which is None, not zero — instead of it.
# The gates below are unchanged in what they CLAIM; `test_hg0` was
# rewritten to state the premise that survives (see the note on it).
# ══════════════════════════════════════════════════════════════════════

#: A micro-SRL, assembled by the SAME function the pipeline calls.
#: revenue 200,000 − services 170,000 − depreciation 10,000 = pre-tax
#: 20,000; a class-69 charge of 1,000 leaves a build-up of 19,000.
_MICRO = {"revenue": 200000.0, "opex": 170000.0, "depreciation": 10000.0,
          "ppe_gross": 50000.0, "ppe_acc_dep": 10000.0, "cash": 20000.0,
          "capital": 200.0}


def _micro_book(filed_121, tax=1000.0, with_charge_account=True,
                extra_accounts=()):
    """A REAL assembled payload whose filed account-121 balance is placed
    by the caller and whose SHAPE is then decided by the engine.

    TC-1: `assemble_statements` is the production assembly, so the anchor
    override — the thing under test — runs for real. Nothing here edits
    an assembled field afterwards; the tests assert on what the engine
    emitted.

    THE PAYABLES LINE IS SIZED FROM WHAT THE ENGINE SAYS 121 CLOSES TO,
    not from this file's own idea of it (2026-09-09). It used to read
    `assets - (capital + (pretax - tax))` — the class-6/7 RECONSTRUCTION
    — while the caller separately declared a DIFFERENT filed account-121
    balance. That made every non-tying shape a book that is not a trial
    balance: its closing balances imply one current-year result and its
    121 declares another, so assets − (equity + liabilities) ≠ 0.
    Nothing noticed while the anchor override had a 5% band, because
    below the band the engine served the reconstruction and the sheet
    closed by accident. With the anchor always applied, the served sheet
    carries the filed figure and the 4,000.00 this fixture built in
    became visible — as a forecast BalanceViolation blaming a projected
    period for it.

    A real book cannot have this shape: account 121 IS a ledger row, so
    the sheet's own residual is its closing balance whatever the class-6/7
    run-down reaches (measured: all four committed books close to 0.00,
    with 121 gaps up to 29,589,814.24). Reading the engine's own
    `current_year_pnl` back in a first pass reproduces that property here
    and, unlike an arithmetic copy, cannot drift from the engine again.
    """
    from engine.country_packs.ro_romania.chart_of_accounts import (
        assemble_statements)

    m = _MICRO
    pretax = m["revenue"] - m["opex"] - m["depreciation"]
    assets = (m["ppe_gross"] - m["ppe_acc_dep"]) + m["cash"]

    def _assemble(payables):
        rows = _micro_accounts(m, tax, with_charge_account, extra_accounts,
                               payables)
        return assemble_statements(
            rows, company_name="Micro SRL", period_label="FY2025",
            account_121_anchor_override=filed_121)

    # Pass 1 — any payables figure; account 401 is a class-4 liability and
    # cannot move the current-year result. Pass 2 sizes the ledger so the
    # residual IS that result, which is what makes this a trial balance.
    probe = _assemble(0.0)
    closes_to = float(
        probe["statements"]["assembled_bs"].get("current_year_pnl") or 0.0)
    assembled = _assemble(assets - (m["capital"] + closes_to))
    return {
        "case_id": "micro", "currency": "RON",
        "period_start": "2025-01-01", "period_end": "2025-12-31",
        "statements": assembled["statements"],
        "envelope": assembled["assembled_canonical_v1"],
        "line_items": assembled.get("lineItems") or [],
    }


def _micro_accounts(m, tax, with_charge_account, extra_accounts, payables):
    """The micro ledger, with the payables line supplied by the caller."""
    accounts = [
        {"code": "704", "name": "Venituri din servicii",
         "amount": m["revenue"]},
        {"code": "628", "name": "Alte cheltuieli cu servicii",
         "amount": m["opex"]},
        {"code": "6811", "name": "Cheltuieli privind amortizarea",
         "amount": m["depreciation"]},
        {"code": "2131", "name": "Echipamente tehnologice",
         "amount": m["ppe_gross"]},
        {"code": "2813", "name": "Amortizarea instalatiilor",
         "amount": m["ppe_acc_dep"]},
        {"code": "5121", "name": "Conturi la banci in lei",
         "amount": m["cash"]},
        {"code": "1012", "name": "Capital subscris varsat",
         "amount": m["capital"]},
        {"code": "401", "name": "Furnizori", "amount": payables},
    ]
    if with_charge_account:
        accounts.append({"code": "691",
                         "name": "Cheltuieli cu impozitul pe profit",
                         "amount": tax})
    accounts.extend(extra_accounts)
    return accounts


def _build_up(payload):
    """The build-up the rate sits in, bridged the way the ASSEMBLY bridges
    it: pre-tax result less the charge, plus capitalised own work.

    That is `chart_of_accounts.py`'s own definition of statutory net
    income, so this file measures the same quantity the engine does and
    the two cannot mean different things by "reaches account 121".
    """
    pl = payload["statements"]["assembled_pl"]
    return round(pl["pretax"] - pl["income_tax"]
                 + (pl.get("capitalized_own_work_memo") or 0.0), 2)


#: The three shapes, named by what the ENGINE does with them rather than
#: by a number: the filed balance is chosen so the first is corrected by
#: the anchor override, the second is inside its band, the third has no
#: balance at all. Each test asserts the shape it got.
def _micro_over_threshold():
    return _micro_book(5000.0)


def _micro_sub_threshold():
    return _micro_book(15000.0)


def _micro_that_ties():
    return _micro_book(19000.0)


def _micro_without_a_filed_balance():
    return _micro_book(None)


#: REWRITTEN 2026-09-09 — this test used to be
#: `test_hg0_the_blind_spot_is_real_and_this_is_it` and asserted, on all
#: three shapes:
#:
#:     assert pl["net_income_unexplained_vs_121"] == 0.00
#:
#: That was the 5% anchor band stated as a law. The band was removed
#: (`chart_of_accounts.py`, "ALWAYS ANCHOR"), so the sub-threshold shape
#: now reports its real −4,000.00 and the old assertion reds — correctly,
#: exactly as its own docstring promised it would when the premise
#: changed. It is rewritten rather than relaxed: the premise below is
#: STRICTER than the one it replaces, because it pins the field to the
#: measured distance wherever a filed balance exists instead of pinning
#: it to a constant. A test that kept asserting 0.00 here would be
#: pinning a repaired defect as the product's law.
def test_hg0_the_premise_this_section_rests_on():
    """The premise, measured on the engine rather than asserted.

    Every gate below rests on two claims about the upstream assembly:

      * where account 121 exists, `net_income_unexplained_vs_121` is the
        real distance from the build-up to the filed balance — so the
        packages that measure that distance themselves can be pinned
        against it (`test_hg6`);
      * where account 121 does NOT exist, that same field still reads
        0.00, with nothing having been compared. That is the surviving
        ABSENT-as-ZERO shape, and it is why the drivers read
        `p121_cross_check.p121` — None, not zero — instead.

    If either stops being true these fixtures stop testing what they say
    they test, and this reds first and says so.
    """
    ties = _micro_that_ties()
    missed = _micro_sub_threshold()
    absent = _micro_without_a_filed_balance()
    corrected = _micro_over_threshold()

    for name, payload in (("ties", ties), ("missed", missed),
                          ("corrected", corrected)):
        pl = payload["statements"]["assembled_pl"]
        filed = _p121_block(payload)["p121"]
        assert filed is not None, name
        assert pl["net_income_unexplained_vs_121"] == round(
            filed - _build_up(payload), 2), (
            "%s: the field must be the measured distance from the build-up "
            "%s to the filed %s; got %r"
            % (name, _build_up(payload), filed,
               pl["net_income_unexplained_vs_121"]))

    absent_pl = absent["statements"]["assembled_pl"]
    assert _p121_block(absent)["p121"] is None, (
        "the third shape must carry no account-121 balance at all; "
        "ABSENT != ZERO is the whole point of it")
    assert absent_pl["net_income_unexplained_vs_121"] == 0.0, (
        "with no account 121 the field is expected to still read 0.00 "
        "without having compared anything — the shape the drivers below "
        "must not condition on; got %r"
        % (absent_pl["net_income_unexplained_vs_121"],))

    assert _p121_block(ties)["p121"] == _build_up(ties)
    assert _p121_block(missed)["p121"] != _build_up(missed), (
        "the sub-threshold fixture must actually MISS its filed balance, "
        "or it is the tying book under another name")

    #: And every one of these books is a TRIAL BALANCE: the closing
    #: balances close on the figure account 121 filed. `_micro_book` used
    #: to size its payables line from the class-6/7 reconstruction
    #: instead, which left the served sheet out by exactly the anchor
    #: step and reached the forecast as a BalanceViolation blaming a
    #: projected period for it.
    for name, payload in (("ties", ties), ("missed", missed),
                          ("absent", absent), ("corrected", corrected)):
        assert payload["statements"]["assembled_bs"]["bs_balance_delta"] == 0.0, (
            "%s: this book does not balance by %s — it is not a trial "
            "balance and nothing measured on it is measured on a company"
            % (name,
               payload["statements"]["assembled_bs"]["bs_balance_delta"]))


def test_hg1_a_sub_threshold_miss_refuses_the_rate():
    """The live defect: a rate measured across a gap nothing reported.

    RESTATED (plan/2 B3 repair): the rate is the engine's one derivation,
    so "refuses" now means the BOOK rung is refused, with the engine's
    reason recorded as the first fallback step, and the ladder takes the
    statutory rung. The reason quotes the filed balance and the build-up
    at the engine's own rendering (TC-10: both are the book's figures).
    """
    from engine.forecast.money import cents_from, fmt

    payload = _micro_sub_threshold()
    driver = build_case_set([payload]).case("base").driver("tax_rate")
    filed = _p121_block(payload)["p121"]
    assert driver.tier != "book", (
        "this book's build-up reaches %s and it filed %s, and the driver "
        "published %r as a book measurement"
        % (_build_up(payload), filed, driver.value))
    step = driver.fallback_steps[0]
    assert (step["tier"], step["outcome"]) == ("book", "absent"), step
    for amount in (filed, _build_up(payload)):
        assert fmt(cents_from(amount)) in step["reason"], (amount, step)


def test_hg2_a_book_with_no_filed_balance_refuses_rather_than_ties():
    """ABSENT != ZERO, in its sharpest form.

    RESTATED (plan/2 B3 repair): no account-121 row survived extraction,
    so the engine's rule has nothing to check the build-up against and
    refuses the book rung, saying so; the ladder takes the statutory rung.
    """
    payload = _micro_without_a_filed_balance()
    driver = build_case_set([payload]).case("base").driver("tax_rate")
    assert driver.tier != "book", (
        "no account-121 balance survived extraction, so the build-up was "
        "checked against nothing; the driver published %r as %r"
        % (driver.value, driver.tier))
    step = driver.fallback_steps[0]
    assert (step["tier"], step["outcome"]) == ("book", "absent"), step
    assert "nothing to check an effective rate against" in step["reason"], (
        "the refusal must say there is nothing to compare against rather "
        "than say the book missed one: %r" % (step["reason"],))


def test_hg3_a_book_that_does_reproduce_its_filed_profit_still_measures():
    """The other direction, and the reason this rule is not vacuous.

    A gate that only refuses is uninformative. This is the same micro
    book with the balance it actually filed: the build-up reproduces it
    to the cent, so the rate IS a measurement of the company, is
    published, and reaches the plan.
    """
    payload = _micro_that_ties()
    base = build_case_set([payload]).case("base")
    driver = base.driver("tax_rate")
    pl = payload["statements"]["assembled_pl"]
    implied = pl["income_tax"] / pl["pretax"]
    assert driver.status == "derived", (
        "this book's pre-tax result less its charge IS the %s it filed, "
        "so the rate is measurable and refusing it would be the mirror "
        "defect: got %r / %r"
        % (_p121_block(payload)["p121"], driver.value, driver.status))
    assert driver.value == pytest.approx(implied, abs=5e-7)
    assert "tax_rate" in model_overrides(base), (
        "a measured rate that never crosses is a measurement nothing "
        "spends")


def test_hg4_the_plan_never_spends_a_rate_this_package_refused():
    """GATE THE SPEND, not the assumption object.

    RESTATED (plan/2 B3 repair): the plan never spends a BOOK rate on a
    book whose rate is not measured. What crosses is the engine's own
    statutory rung with its tier and evidence, and the plan holds exactly
    that — never a book or user rate made out of it.
    """
    from engine.forecast import project_payload

    for name, payload in (("sub-threshold", _micro_sub_threshold()),
                          ("no filed balance",
                           _micro_without_a_filed_balance())):
        base = build_case_set([payload]).case("base")
        assert base.driver("tax_rate").tier != "book", name
        overrides = model_overrides(base)
        projection = project_payload(payload, **overrides)
        held = projection.assumptions["tax_rate"]
        alone = project_payload(payload).assumptions["tax_rate"]
        assert held.tier not in ("book", "user"), (
            "%s: the plan is taxed at a rate stamped %s on a book whose "
            "rate is not measured" % (name, held.tier))
        assert (held.tier, held.exact) == (alone.tier, alone.exact), name


def test_hg5_the_model_does_not_measure_a_rate_this_package_refused():
    """One book, one answer — the `test_hx3` law, on the shape that
    breaks it. RESTATED (plan/2 B3 repair): both producers hold the same
    non-book tier and integer on the sub-threshold book.
    """
    payload = _micro_sub_threshold()
    ours = build_case_set([payload]).case("base").driver("tax_rate")
    theirs = _model_assumptions(payload)["tax_rate"]
    assert theirs.tier != "book"
    assert (ours.tier, ours.exact) == (theirs.tier, theirs.exact)


# ── HG6-8: the bridge — one concept across both readers ───────────────

@pytest.mark.parametrize("book", _BOOKS)
def test_hg6_the_distance_is_the_engines_own_unexplained_step(book):
    """Two readers of one quantity, pinned equal wherever the engine
    measured it.

    RESTATED (plan/2 B3 repair): this package no longer measures the
    distance itself (its rule is retired), so the pin moves to the one
    reader left, engine.forecast.history.unexplained_vs_filed, against the
    assembly's published field wherever the assembly measured one.
    """
    from engine.forecast.money import cents_from
    from engine.forecast.project import _opening_and_history

    payload = _load(book)
    pl = payload["statements"]["assembled_pl"]
    filed = _p121_block(payload)["p121"]
    if filed is None or round(pl["net_income_statutory"] - filed, 2) != 0.0:
        pytest.skip("the assembly did not measure a distance on this book")
    _, history = _opening_and_history(payload)
    gap = history.unexplained_vs_filed()
    assert gap is not None, book
    assert abs(gap) == abs(cents_from(pl["net_income_unexplained_vs_121"])), (
        "%s: the engine measures %s from account 121 and the assembly "
        "publishes %s — two authorities for one number"
        % (book, gap, pl["net_income_unexplained_vs_121"]))


def test_hg7_capitalised_own_work_does_bridge_the_distance():
    """The assembly's own bridge is honoured, so this condition is not a
    second, stricter rule wearing the same name.

    A book whose build-up reaches its filed profit only once capitalised
    own work is added HAS reproduced it — that component is named on the
    statement. Refusing it would be the mirror defect, and this book is
    also inside the anchor override's blind band, so nothing upstream
    would have caught the difference either way.
    """
    payload = _micro_book(22000.0, extra_accounts=[
        {"code": "722", "name": "Venituri din productia de imobilizari",
         "amount": 3000.0}])
    pl = payload["statements"]["assembled_pl"]
    assert pl["capitalized_own_work_memo"] == 3000.0, pl
    driver = build_case_set([payload]).case("base").driver("tax_rate")
    assert driver.status == "derived", (
        "the build-up reaches %s once the %s of capitalised own work the "
        "statement names is added, which is the assembly's own bridge to "
        "account 121: got %r / %r"
        % (_p121_block(payload)["p121"], pl["capitalized_own_work_memo"],
           driver.value, driver.status))
    assert driver.value == pytest.approx(
        pl["income_tax"] / pl["pretax"], abs=5e-7)


def test_hg8_an_inventory_variation_does_not_bridge_the_distance():
    """And the component that is NOT part of that bridge does not close it.

    Same book, same distance, 711 instead of 722. The assembly's
    reconciliation to statutory net income does not carry the inventory
    variation, so the build-up does not reproduce the filed figure.

    RESTATED (plan/2 B3 repair): the refusal is the engine's (book rung
    absent, statutory rung taken). The retired second rule also NAMED the
    inventory variation in its sentence; the engine's sentence names the
    unattributed distance instead, and that loss is recorded in the
    as-built log (B3R) for the sentence work of B6.
    """
    from engine.forecast.money import cents_from, fmt

    payload = _micro_book(22000.0, extra_accounts=[
        {"code": "711", "name": "Venituri aferente costurilor stocurilor",
         "amount": 3000.0}])
    pl = payload["statements"]["assembled_pl"]
    assert pl["inventory_variation_memo"] == 3000.0, pl
    distance = round(_p121_block(payload)["p121"] - _build_up(payload), 2)
    assert pl["net_income_unexplained_vs_121"] == distance != 0.0, (
        "the assembly must itself report the inventory variation as NOT "
        "bridging the distance to the filed balance; got %r"
        % (pl["net_income_unexplained_vs_121"],))
    driver = build_case_set([payload]).case("base").driver("tax_rate")
    assert driver.tier != "book", (
        "the inventory variation is not in the assembly's reconciliation "
        "to the filed figure, so the build-up of %s does not reach the %s "
        "filed: got %r / %r"
        % (_build_up(payload), _p121_block(payload)["p121"],
           driver.value, driver.tier))
    step = driver.fallback_steps[0]
    assert fmt(cents_from(abs(distance))) in step["reason"], step


# ── plan/2 B3: printed scope (TC-12/TC-13; B0-16 assigned it to B3) ─────

def test_zz_scope(capsys):
    """The scope this gate ran on, printed. The work count stays pytest's
    junit count (a printed count would not see a collapse of one section)."""
    with capsys.disabled():
        print("\nSCOPE forecast-drivers (plan/2 B3): books %s, one period "
              "each; multi-period rungs on SYNTHETIC histories scaled from "
              "agras (constructed, labelled in this file); micro-SRL books "
              "assembled through the real Romanian assembly; shared concepts "
              "read from engine.forecast (contract 4)"
              % ", ".join(_BOOKS))
    assert _BOOKS
