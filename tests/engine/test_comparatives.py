"""PARTS B, C, D — the comparability rule and the column model.

THE PROBLEM THIS LANE EXISTS FOR. A client sends two years because they
want to see two years. One file is the external condensed balanță, the
other is the internal analytic export. Put them side by side naively and
the product does not report less than it should — it reports MORE, and
what it adds is false.

The measured case, on the two real Scandia books: of 35 classification
buckets, exactly ONE differs. `ar_doubtful` — receivables flagged
doubtful — is present in the analytic year and absent from the condensed
one, because the condensed chart has no such row. The assembled envelope
is DENSE: every field exists, so the field reads 0.00. Compare that 0.00
against the analytic year's balance and the product announces that the
company wrote its entire doubtful-receivable position down to nothing, or
conjured one out of nothing, depending on which year you put in the prior
column. Both readings are news. Both are fabrications.

So this suite pins three refusals and one permission:

  PART B  statement-line YoY PROCEEDS across a detail-level difference,
          because the roll-up is lossless — and the losslessness is
          MEASURED here on the real 653-line committed book, not
          asserted;
  PART C  ABSENT is not ZERO; a zero base yields no percentage; a figure
          that needs analytic depth reports that it was not disclosed at
          this detail level;
  PART D  the dangerous pair, constructed and swept: for every
          analytic-only figure, across both orientations, NO movement is
          served.

FIXTURES ARE REAL AND COMMITTED. `scandia_fy2025` (653 six-digit lines,
analytic) and `eei_dec_2025` (62 three- and four-digit lines, synthetic)
are regression baselines already in the tree. The condensed counterpart
in Part D is DERIVED from the analytic book by the one transformation the
real condensed book applies — roll every code to the synthetic boundary
and drop the doubtful-receivable row into trade receivables — so the
shape under test is the measured shape, and no confidential byte is
needed to reproduce it.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import pytest

from engine.comparatives import columns as CO
from engine.comparatives import lines as LN
from engine.comparatives.levels import (
    ANALYTIC,
    INDETERMINATE,
    MIXED,
    SYNTHETIC,
    assess_comparability,
    carries_analytic_detail,
    effective_level,
)
from engine.country_packs.ro_romania.chart_of_accounts import bucket_for
from engine.country_packs.ro_romania.detail_level import (
    SYNTHETIC_MAX_DIGITS,
    classify_detail_level,
)

REPO = Path(__file__).resolve().parents[2]
BASELINES = (REPO / "src" / "engine" / "country_packs" / "ro_romania"
             / "fixtures" / "regression_baselines")

#: The four analytic-only families Part D names. Each must be in the
#: registry; a registry that quietly loses one would make this suite
#: pass over an empty sweep.
REQUIRED_ANALYTIC_FAMILIES = (
    "analytic.related_party_exposure",       # related-party exposure
    "analytic.receivables_by_counterparty",  # counterparty concentration
    "analytic.payables_by_counterparty",     # counterparty concentration
    "analytic.receivable_ageing",            # receivable ageing
    "analytic.non_trade_receivable_split",   # non-trade receivable splits
)


def _baseline(name):
    with open(str(BASELINES / (name + ".json")), encoding="utf-8") as fh:
        return json.load(fh)["assembled"]


def _codes(envelope):
    return [str(li.get("ro_account_code") or "") for li in envelope["lineItems"]]


def _condense(envelope):
    """The one transformation the external condensed balanță applies.

    Roll every account code to the synthetic boundary, and fold the
    doubtful-receivable rows back into trade receivables — the condensed
    chart carries no 'clienti incerti' row. The `ar_doubtful_gross` FIELD
    survives, dense, holding 0.00, which is exactly the trap: a number
    that looks like a balance and is the absence of one.
    """
    out = copy.deepcopy(envelope)
    for li in out["lineItems"]:
        code = str(li.get("ro_account_code") or "")
        if code.isdigit():
            li["ro_account_code"] = code[:SYNTHETIC_MAX_DIGITS]
        if (li.get("canonical_bucket") or li.get("bucket")) == "ar_doubtful":
            li["canonical_bucket"] = "ar"
            li["bucket"] = "ar"
    out["statements"]["assembled_bs"]["ar_doubtful_gross"] = 0.0
    return out


def _with_analytic_breakdowns(envelope, seed=1.0):
    """Populate every analytic-only path with a real number.

    Today the engine assembles none of these, so leaving them empty would
    make Part D sweep an empty set and pass for the wrong reason (TC-3: a
    census that finds nothing is a broken gate). This is the day they
    land, brought forward.
    """
    out = copy.deepcopy(envelope)
    supp = out["statements"].setdefault("supplementary", {})
    for i, spec in enumerate(s for s in LN.LINE_SPECS if s.requires == ANALYTIC):
        supp[spec.path[-1]] = seed * (1000.0 + i)
    return out


ANALYTIC_BOOK = _baseline("scandia_fy2025")
SYNTHETIC_BOOK = _baseline("eei_dec_2025")
CONDENSED_BOOK = _condense(ANALYTIC_BOOK)


# ══════════════════════════════════════════════════════════════════════
# PART B — the comparability rule
# ══════════════════════════════════════════════════════════════════════

def test_the_rollup_is_lossless_on_the_real_analytic_book():
    """THE MEASURED PREMISE of the whole comparability rule.

    Statement-line YoY may cross a detail-level difference only because
    truncating an analytic code to the synthetic boundary changes no
    account's classification bucket and no account's sign. A statement
    line is a sum over buckets, so a sum whose every term survives the
    truncation survives it too.

    653 real committed codes. If this ever reds, the rule in
    `levels.assess_comparability` is no longer true and statement-line
    comparison across levels must stop, not be tolerated.
    """
    codes = [c for c in _codes(ANALYTIC_BOOK) if c.isdigit()]
    assert len(codes) >= 600, "census floor: the real book carries 653 codes"

    changed = []
    for code in codes:
        deep = bucket_for(code)
        rolled = bucket_for(code[:SYNTHETIC_MAX_DIGITS])
        if (deep is None) != (rolled is None):
            changed.append(code)
        elif deep is not None and (deep.bucket != rolled.bucket
                                   or deep.sign != rolled.sign):
            changed.append(code)
    assert changed == [], (
        "%d of %d accounts change bucket or sign when rolled from analytic "
        "depth to %d digits: %s"
        % (len(changed), len(codes), SYNTHETIC_MAX_DIGITS, changed[:10]))


def test_two_analytic_periods_compare_at_the_analytic_level():
    c = assess_comparability(ANALYTIC, ANALYTIC)
    assert c.comparable and c.level == ANALYTIC
    assert c.statement_lines is True
    assert c.analytic_detail is True


def test_two_synthetic_periods_compare_at_the_synthetic_level():
    c = assess_comparability(SYNTHETIC, SYNTHETIC)
    assert c.comparable and c.level == SYNTHETIC
    assert c.statement_lines is True
    assert c.analytic_detail is False


@pytest.mark.parametrize("cur,pri", [(ANALYTIC, SYNTHETIC), (SYNTHETIC, ANALYTIC)])
def test_different_levels_are_comparable_at_the_synthetic_level_only(cur, pri):
    c = assess_comparability(cur, pri)
    assert c.comparable and c.level == SYNTHETIC
    assert c.statement_lines is True, "the roll-up is lossless; YoY proceeds"
    assert c.analytic_detail is False, "nothing below the boundary proceeds"


def test_mixed_floors_to_synthetic():
    """A book that carries analytics for SOME accounts tells you nothing
    about the account you are about to read."""
    assert effective_level(MIXED) == SYNTHETIC
    assert carries_analytic_detail(MIXED) is False
    assert assess_comparability(ANALYTIC, MIXED).analytic_detail is False
    assert assess_comparability(MIXED, MIXED).level == SYNTHETIC


@pytest.mark.parametrize("cur,pri", [
    (INDETERMINATE, ANALYTIC), (ANALYTIC, INDETERMINATE),
    (INDETERMINATE, INDETERMINATE), ("who knows", SYNTHETIC),
])
def test_an_undetermined_level_yields_no_comparison_at_all(cur, pri):
    c = assess_comparability(cur, pri)
    assert c.comparable is False
    assert c.level is None
    assert c.statement_lines is False and c.analytic_detail is False
    assert "not a coarse level" in c.reason


def test_the_two_real_books_are_the_cross_level_case():
    cur = classify_detail_level(_codes(ANALYTIC_BOOK))
    pri = classify_detail_level(_codes(CONDENSED_BOOK))
    assert (cur.level, pri.level) == (ANALYTIC, SYNTHETIC)
    c = assess_comparability(cur.level, pri.level)
    assert c.statement_lines is True and c.analytic_detail is False


# ══════════════════════════════════════════════════════════════════════
# the registry itself
# ══════════════════════════════════════════════════════════════════════

def test_every_spec_declares_a_known_unit():
    """An undeclared money fact is one a ranker cannot order and a
    renderer will eventually format as a percentage."""
    for spec in LN.LINE_SPECS:
        assert spec.unit in LN.UNITS, "%s declares unit %r" % (spec.key, spec.unit)


def test_spec_keys_are_unique_and_levels_are_known():
    keys = [s.key for s in LN.LINE_SPECS]
    assert len(keys) == len(set(keys))
    for spec in LN.LINE_SPECS:
        assert spec.requires in (SYNTHETIC, ANALYTIC)
        assert spec.statement in ("PL", "BS")


def test_the_registry_carries_every_analytic_only_family():
    present = set(s.key for s in LN.LINE_SPECS if s.requires == ANALYTIC)
    missing = [k for k in REQUIRED_ANALYTIC_FAMILIES if k not in present]
    assert missing == [], "analytic-only families dropped from the registry: %s" % missing


def test_unwrap_refuses_a_shape_it_does_not_recognise():
    """Defaulting to an empty envelope would mark every line absent —
    the most dangerous failure this module has."""
    with pytest.raises(ValueError):
        LN.unwrap_envelope({"nope": 1})
    with pytest.raises(TypeError):
        LN.unwrap_envelope(["statements"])


def test_coverage_unknown_is_not_coverage_empty():
    assert LN.coverage_from_envelope({"statements": {}}) is None
    assert LN.coverage_from_envelope({"statements": {}, "lineItems": []}) == frozenset()


def test_read_value_returns_none_not_zero_for_an_uncovered_line():
    spec = LN.spec_for("bs.ar_doubtful_gross")
    dense = {"statements": {"assembled_bs": {"ar_doubtful_gross": 0.0}}}
    assert LN.read_value(dense, spec, frozenset(["ar"])) is None
    assert LN.read_value(dense, spec, frozenset(["ar_doubtful"])) == 0.0
    # Coverage UNKNOWN (no lineItems): a dense 0.0 cannot be told from a
    # disclosed zero, so it reads absent. This line used to pin `== 0.0` —
    # the absent-read-as-zero defect as law — and was reversed in review.
    assert LN.read_value(dense, spec, None) is None
    # A non-zero value under unknown coverage is plainly disclosed.
    held = {"statements": {"assembled_bs": {"ar_doubtful_gross": 133858.47}}}
    assert LN.read_value(held, spec, None) == 133858.47
    # A DERIVED line (no buckets) is decided by the number alone, so its
    # zero survives unknown coverage: 0.00 EBITDA is a statement, not a gap.
    derived = LN.spec_for("pl.ebitda")
    assert LN.read_value({"statements": {"assembled_pl": {"ebitda": 0.0}}}, derived, None) == 0.0


def test_read_value_never_calls_a_non_zero_served_figure_absent():
    """COVERAGE DECIDES ZEROS, AND ONLY ZEROS. An assembled field is a sum
    over the leaves the book holds, so a value above the floor is proof a
    leaf fed the line; a coverage set without the bucket is an incomplete
    vocabulary, not evidence of absence. The measured case (2026-09-26):
    line items served by `GET /api/period` carry the PERSISTENCE names
    (`ar_intercompany` persists as `otherCurrentAssets`), and matched on
    those, nine fine-bucket lines read "neither period reported" beside
    non-zero served fields on a real client pair. The first version of
    `read_value` ran the coverage check before reading the field."""
    spec = LN.spec_for("bs.ar_intercompany")
    held = {"statements": {"assembled_bs": {"ar_intercompany": 1234567.89}}}
    assert LN.read_value(held, spec, frozenset(["otherCurrentAssets"])) == 1234567.89
    assert LN.read_value(held, spec, frozenset()) == 1234567.89
    assert LN.read_value(held, spec, None) == 1234567.89
    # The zero stays coverage-decided: fed is a disclosed 0.00, unfed is absent.
    zero = {"statements": {"assembled_bs": {"ar_intercompany": 0.0}}}
    assert LN.read_value(zero, spec, frozenset(["otherCurrentAssets"])) is None
    assert LN.read_value(zero, spec, frozenset(["ar_intercompany"])) == 0.0
    assert LN.read_value(zero, spec, None) is None
    # Sub-floor is a zero, not a balance.
    tiny = {"statements": {"assembled_bs": {"ar_intercompany": LN.ZERO_FLOOR / 2.0}}}
    assert LN.read_value(tiny, spec, frozenset(["otherCurrentAssets"])) is None


@pytest.mark.parametrize("bad", [None, float("nan"), float("inf"), "12", True, {}])
def test_read_value_refuses_a_non_number(bad):
    spec = LN.spec_for("pl.revenue")
    env = {"statements": {"assembled_pl": {"revenue": bad}}}
    assert LN.read_value(env, spec, None) is None


# ══════════════════════════════════════════════════════════════════════
# PART C — the column model
# ══════════════════════════════════════════════════════════════════════

def _env(pl=None, bs=None, buckets=None, supplementary=None):
    """A minimal envelope. `buckets` becomes the coverage; None means the
    envelope carries no lineItems and coverage is unknown."""
    statements = {"assembled_pl": dict(pl or {}),
                  "assembled_bs": dict(bs or {}),
                  "supplementary": dict(supplementary or {})}
    env = {"statements": statements}
    if buckets is not None:
        env["lineItems"] = [{"bucket": b, "canonical_bucket": b} for b in buckets]
    return env


def _col(table, key):
    col = table.by_key(key)
    assert col is not None, "no column for %s" % key
    return col


def test_both_periods_reported_gives_a_delta_and_a_percentage():
    t = CO.build_comparative_columns(
        _env(pl={"revenue": 120.0}, buckets=["revenue"]),
        _env(pl={"revenue": 100.0}, buckets=["revenue"]),
        current_level=ANALYTIC, prior_level=ANALYTIC)
    col = _col(t, "pl.revenue")
    assert col.status == CO.STATUS_COMPARED
    assert col.delta == 20.0
    assert col.delta_pct == 0.2
    assert col.has_movement


def test_a_line_present_in_one_period_only_is_absent_never_a_delta():
    """ABSENT != ZERO. The prior book fed nothing into this line, so
    there is no base to move from — not 0.00, not minus a hundred
    percent."""
    t = CO.build_comparative_columns(
        _env(bs={"ar_doubtful_gross": 133858.47}, buckets=["ar_doubtful"]),
        _env(bs={"ar_doubtful_gross": 0.0}, buckets=["ar"]),
        current_level=ANALYTIC, prior_level=ANALYTIC)
    col = _col(t, "bs.ar_doubtful_gross")
    assert col.status == CO.STATUS_ABSENT_PRIOR
    assert col.prior is None and col.prior_disclosure == CO.DISCLOSURE_ABSENT
    assert col.delta is None and col.delta_pct is None
    assert not col.has_movement
    assert "absent, which is not zero" in col.note


def test_the_mirror_orientation_is_absent_current_not_plus_infinity():
    t = CO.build_comparative_columns(
        _env(bs={"ar_doubtful_gross": 0.0}, buckets=["ar"]),
        _env(bs={"ar_doubtful_gross": 133858.47}, buckets=["ar_doubtful"]),
        current_level=ANALYTIC, prior_level=ANALYTIC)
    col = _col(t, "bs.ar_doubtful_gross")
    assert col.status == CO.STATUS_ABSENT_CURRENT
    assert col.current is None
    assert col.delta is None and col.delta_pct is None


def test_absent_in_both_periods_is_its_own_answer():
    t = CO.build_comparative_columns(
        _env(bs={"ar_doubtful_gross": 0.0}, buckets=["ar"]),
        _env(bs={"ar_doubtful_gross": 0.0}, buckets=["ar"]),
        current_level=ANALYTIC, prior_level=ANALYTIC)
    col = _col(t, "bs.ar_doubtful_gross")
    assert col.status == CO.STATUS_ABSENT_BOTH
    assert (col.current, col.prior, col.delta, col.delta_pct) == (None, None, None, None)


def test_a_zero_base_yields_no_percentage_only_an_amount():
    """Disclosed and zero is a real reading — it just cannot be a
    denominator. The change is stated as an amount; there is no
    percentage, and specifically not '+100%'."""
    t = CO.build_comparative_columns(
        _env(pl={"revenue": 500.0}, buckets=["revenue"]),
        _env(pl={"revenue": 0.0}, buckets=["revenue"]),
        current_level=ANALYTIC, prior_level=ANALYTIC)
    col = _col(t, "pl.revenue")
    assert col.status == CO.STATUS_COMPARED_NO_BASE
    assert col.prior == 0.0 and col.prior_disclosure == CO.DISCLOSURE_REPORTED
    assert col.delta == 500.0
    assert col.delta_pct is None


def test_a_sub_cent_base_is_a_zero_base():
    """Half a cent, so float dust cannot mint a percentage in the
    millions. The floor renders from the constant."""
    t = CO.build_comparative_columns(
        _env(pl={"revenue": 500.0}, buckets=["revenue"]),
        _env(pl={"revenue": CO.PCT_BASE_FLOOR / 2.0}, buckets=["revenue"]),
        current_level=ANALYTIC, prior_level=ANALYTIC)
    col = _col(t, "pl.revenue")
    assert col.status == CO.STATUS_COMPARED_NO_BASE
    assert col.delta_pct is None
    assert ("%.3f" % CO.PCT_BASE_FLOOR) in col.note


def test_a_negative_base_percentage_uses_magnitude_so_the_sign_is_the_movement():
    t = CO.build_comparative_columns(
        _env(pl={"pretax": -50.0}, buckets=["revenue"]),
        _env(pl={"pretax": -100.0}, buckets=["revenue"]),
        current_level=ANALYTIC, prior_level=ANALYTIC)
    col = _col(t, "pl.pretax")
    assert col.delta == 50.0
    assert col.delta_pct == 0.5, "a loss halving is +50% of the magnitude, not -50%"


# ── plan/2 B1 (plan_contract_v2 section 7, S7): cross-sign columns ─────
#
# Defect 0.4: a column whose two periods sit on opposite sides of zero
# served (current - prior) / |prior| as its percentage — a profit of
# 6,104,815.29 becoming a loss of 107,630,000 read -18.63, which the FE
# printed as "-19x". The column keeps its disclosure status (both periods
# reported it) and carries the classifier's kind with NO percentage.

def test_a_cross_sign_column_carries_its_kind_and_no_percentage():
    t = CO.build_comparative_columns(
        _env(pl={"ebitda": -107630000.0}, buckets=["revenue"]),
        _env(pl={"ebitda": 6104815.29}, buckets=["revenue"]),
        current_level=ANALYTIC, prior_level=ANALYTIC)
    col = _col(t, "pl.ebitda")
    assert col.status == CO.STATUS_COMPARED
    assert col.delta == -113734815.29
    assert col.delta_pct is None, "a sign flip served a percentage: %r" % col.delta_pct
    assert col.change_kind == "flip_to_negative"
    assert col.has_movement and "%" not in col.note

    mirror = CO.build_comparative_columns(
        _env(pl={"ebitda": 6104815.29}, buckets=["revenue"]),
        _env(pl={"ebitda": -107630000.0}, buckets=["revenue"]),
        current_level=ANALYTIC, prior_level=ANALYTIC)
    m = _col(mirror, "pl.ebitda")
    assert (m.status, m.delta_pct, m.change_kind) == (
        CO.STATUS_COMPARED, None, "flip_to_positive")


def test_a_move_to_zero_or_from_zero_is_a_kind_never_a_hundred_percent():
    to_zero = CO.build_comparative_columns(
        _env(pl={"revenue": CO.PCT_BASE_FLOOR / 2.0}, buckets=["revenue"]),
        _env(pl={"revenue": 500.0}, buckets=["revenue"]),
        current_level=ANALYTIC, prior_level=ANALYTIC)
    col = _col(to_zero, "pl.revenue")
    assert (col.delta_pct, col.change_kind) == (None, "to_zero")
    from_zero = CO.build_comparative_columns(
        _env(pl={"revenue": 500.0}, buckets=["revenue"]),
        _env(pl={"revenue": 0.0}, buckets=["revenue"]),
        current_level=ANALYTIC, prior_level=ANALYTIC)
    col = _col(from_zero, "pl.revenue")
    assert (col.status, col.delta_pct, col.change_kind) == (
        CO.STATUS_COMPARED_NO_BASE, None, "from_zero")


def test_change_kind_is_set_exactly_on_movement_statuses_over_every_orientation():
    """The sweep. change_kind is orthogonal to the disclosure status: set
    only on compared / compared_no_base, and a percentage only rides the
    kind "compared"."""
    seen = kinds = words = 0
    for cur, pri, cl, pl_ in (
        (ANALYTIC_BOOK, CONDENSED_BOOK, ANALYTIC, SYNTHETIC),
        (CONDENSED_BOOK, ANALYTIC_BOOK, SYNTHETIC, ANALYTIC),
        (ANALYTIC_BOOK, SYNTHETIC_BOOK, ANALYTIC, SYNTHETIC),
        (ANALYTIC_BOOK, ANALYTIC_BOOK, ANALYTIC, ANALYTIC),
        (ANALYTIC_BOOK, ANALYTIC_BOOK, INDETERMINATE, ANALYTIC),
    ):
        t = CO.build_comparative_columns(cur, pri, current_level=cl, prior_level=pl_)
        for col in t.columns:
            seen += 1
            if col.status in CO.MOVEMENT_STATUSES:
                assert col.change_kind is not None, col.key
                kinds += 1
                words += col.change_kind != "compared"
            else:
                assert col.change_kind is None, (col.key, col.status, col.change_kind)
            if col.delta_pct is not None:
                assert col.change_kind == "compared", (col.key, col.change_kind)
    assert seen >= 5 * len(LN.LINE_SPECS) and kinds > 0
    print("SIGN-FLIP comparatives sweep: %d columns, %d carrying a change kind, %d of them "
          "a word kind (no percentage)" % (seen, kinds, words))
    print("GATE-WORK sign-flip units=%d label=comparative-columns" % seen)


def test_no_column_anywhere_carries_a_non_finite_number():
    """The sweep. Every column of every orientation of the real pair."""
    seen = 0
    for cur, pri, cl, pl_ in (
        (ANALYTIC_BOOK, CONDENSED_BOOK, ANALYTIC, SYNTHETIC),
        (CONDENSED_BOOK, ANALYTIC_BOOK, SYNTHETIC, ANALYTIC),
        (ANALYTIC_BOOK, SYNTHETIC_BOOK, ANALYTIC, SYNTHETIC),
        (ANALYTIC_BOOK, ANALYTIC_BOOK, ANALYTIC, ANALYTIC),
    ):
        t = CO.build_comparative_columns(cur, pri, current_level=cl, prior_level=pl_)
        for col in t.columns:
            seen += 1
            for name in ("current", "prior", "delta", "delta_pct"):
                v = getattr(col, name)
                assert v is None or (isinstance(v, float) and math.isfinite(v)), (
                    "%s.%s is %r" % (col.key, name, v))
    assert seen >= 4 * len(LN.LINE_SPECS)


def test_an_undetermined_level_makes_every_column_incomparable():
    t = CO.build_comparative_columns(
        _env(pl={"revenue": 120.0}, buckets=["revenue"]),
        _env(pl={"revenue": 100.0}, buckets=["revenue"]),
        current_level=INDETERMINATE, prior_level=ANALYTIC)
    assert t.comparability.comparable is False
    assert t.movements() == ()
    for col in t.columns:
        assert col.status == CO.STATUS_INCOMPARABLE
        assert col.delta is None and col.delta_pct is None


def test_movements_excludes_every_refusal():
    t = CO.build_comparative_columns(
        ANALYTIC_BOOK, CONDENSED_BOOK,
        current_level=ANALYTIC, prior_level=SYNTHETIC)
    assert t.movements(), "the statement spine must still compare"
    for col in t.movements():
        assert col.status in CO.MOVEMENT_STATUSES
        assert col.delta is not None
    for col in t.refusals():
        assert col.delta is None and col.delta_pct is None
    assert len(t.movements()) + len(t.refusals()) == len(t.columns)


def test_the_statement_spine_compares_across_the_level_difference():
    """PART B's permission, exercised: the roll-up is lossless, so
    revenue, EBITDA and total assets still move."""
    t = CO.build_comparative_columns(
        ANALYTIC_BOOK, CONDENSED_BOOK,
        current_level=ANALYTIC, prior_level=SYNTHETIC)
    for key in ("pl.revenue", "pl.ebitda", "bs.total_assets", "bs.total_equity"):
        col = _col(t, key)
        assert col.status in CO.MOVEMENT_STATUSES, "%s: %s" % (key, col.status)


def test_the_table_is_deterministic():
    a = CO.build_comparative_columns(ANALYTIC_BOOK, CONDENSED_BOOK,
                                     current_level=ANALYTIC, prior_level=SYNTHETIC)
    b = CO.build_comparative_columns(ANALYTIC_BOOK, CONDENSED_BOOK,
                                     current_level=ANALYTIC, prior_level=SYNTHETIC)
    assert a == b


def test_coverage_provenance_is_recorded_per_side():
    t = CO.build_comparative_columns(
        _env(pl={"revenue": 1.0}, buckets=["revenue"]),
        _env(pl={"revenue": 1.0}),
        current_level=ANALYTIC, prior_level=ANALYTIC)
    assert t.current_coverage_source == CO.COVERAGE_FROM_LINE_ITEMS
    assert t.prior_coverage_source == CO.COVERAGE_UNKNOWN


# ══════════════════════════════════════════════════════════════════════
# PART D — THE DANGEROUS CASE, GATED
# ══════════════════════════════════════════════════════════════════════

def test_no_false_movement_is_served_for_any_analytic_only_figure():
    """THE GATE.

    A synthetic period against an analytic one whose analytic-only
    breakdowns are FULLY POPULATED — related-party exposure, counterparty
    concentration on both sides, receivable ageing, non-trade receivable
    splits. Every one of them must report that the period did not
    disclose it at this detail level: no delta, no percentage, no
    direction, in either orientation.

    Populating the analytic side is what makes this gate non-vacuous. An
    empty supplementary block would sweep nothing and pass.
    """
    rich = _with_analytic_breakdowns(ANALYTIC_BOOK)
    analytic_keys = [s.key for s in LN.LINE_SPECS if s.requires == ANALYTIC]
    assert len(analytic_keys) >= len(REQUIRED_ANALYTIC_FAMILIES)

    examined = 0
    for cur, pri, cl, pl_ in (
        (rich, CONDENSED_BOOK, ANALYTIC, SYNTHETIC),
        (CONDENSED_BOOK, rich, SYNTHETIC, ANALYTIC),
        (rich, _with_analytic_breakdowns(SYNTHETIC_BOOK, 7.0), ANALYTIC, MIXED),
    ):
        t = CO.build_comparative_columns(cur, pri, current_level=cl, prior_level=pl_)
        for key in analytic_keys:
            col = _col(t, key)
            examined += 1
            assert col.status == CO.STATUS_NOT_DISCLOSED, (
                "%s served %s at levels %s/%s" % (key, col.status, cl, pl_))
            assert col.delta is None, "%s served a delta of %r" % (key, col.delta)
            assert col.delta_pct is None
            assert not col.has_movement
            assert col not in t.movements()
            assert CO.DISCLOSURE_NOT_AT_LEVEL in (
                col.current_disclosure, col.prior_disclosure)
            assert "not disclosed at this detail level" in col.note

    assert examined == 3 * len(analytic_keys)
    assert examined >= 15, "census floor: %d analytic-only columns swept" % examined


def test_two_analytic_periods_do_get_their_breakdowns_compared():
    """The refusal must be about the DETAIL LEVEL, not a blanket ban —
    otherwise the gate above would pass with the feature switched off."""
    a = _with_analytic_breakdowns(ANALYTIC_BOOK, 1.0)
    b = _with_analytic_breakdowns(ANALYTIC_BOOK, 2.0)
    t = CO.build_comparative_columns(b, a, current_level=ANALYTIC, prior_level=ANALYTIC)
    moved = [c for c in t.columns
             if c.requires == ANALYTIC and c.status == CO.STATUS_COMPARED]
    assert len(moved) == len(REQUIRED_ANALYTIC_FAMILIES)
    for col in moved:
        assert col.delta is not None and col.delta_pct is not None


def test_the_condensed_book_does_not_zero_out_the_doubtful_receivables():
    """THE MEASURED CASE, both ways round.

    `ar_doubtful` is the one bucket that differs between the two real
    Scandia books. The condensed envelope's field is dense and reads
    0.00. It must never become a hundred-percent write-off, and never a
    balance appearing from nothing.
    """
    for cur, pri, cl, pl_, expected in (
        (ANALYTIC_BOOK, CONDENSED_BOOK, ANALYTIC, SYNTHETIC, CO.STATUS_ABSENT_PRIOR),
        (CONDENSED_BOOK, ANALYTIC_BOOK, SYNTHETIC, ANALYTIC, CO.STATUS_ABSENT_CURRENT),
    ):
        t = CO.build_comparative_columns(cur, pri, current_level=cl, prior_level=pl_)
        col = _col(t, "bs.ar_doubtful_gross")
        assert col.status == expected
        assert col.delta is None and col.delta_pct is None
        assert col.delta_pct != -1.0 and col.delta_pct != 1.0


def test_no_refusal_ever_reads_as_a_movement():
    """No note on a refusal may contain a word of direction. The column
    model states facts and statuses; the day someone adds 'improved' to a
    note, this reds."""
    banned = ("improved", "improve", "worsened", "better", "worse",
              "increased", "decreased", "grew", "fell", "rose", "declined",
              "up ", "down ", "%")
    rich = _with_analytic_breakdowns(ANALYTIC_BOOK)
    for cur, pri, cl, pl_ in (
        (rich, CONDENSED_BOOK, ANALYTIC, SYNTHETIC),
        (CONDENSED_BOOK, rich, SYNTHETIC, ANALYTIC),
        (rich, rich, INDETERMINATE, ANALYTIC),
    ):
        t = CO.build_comparative_columns(cur, pri, current_level=cl, prior_level=pl_)
        for col in t.refusals():
            low = col.note.lower()
            for word in banned:
                assert word not in low, "%s note says %r: %s" % (col.key, word, col.note)
