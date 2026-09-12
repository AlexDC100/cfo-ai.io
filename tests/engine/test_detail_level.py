"""PART A — DETAIL LEVEL, detected per period, from the codes themselves.

A client sends two years of one company and one file is the external
condensed balanță while the other is the internal analytic export.
Nothing in either file says so. `classify_detail_level` says so.

WHAT THESE TESTS PIN, and why each one is here rather than being obvious:

  * the 4-digit boundary is OMFP 1802's, not a tuning choice, and the
    reason string RENDERS it rather than restating it in prose — change
    the constant and the sentence changes with it (TC-10);
  * a book with no usable codes REFUSES. It does not fall back to
    synthetic. "We could not tell" and "it is the coarse one" are
    different facts and only the second permits a comparison;
  * the two corroborating signals — row count and the header identity
    block — are recorded and quoted and NEVER move the verdict. A
    detector that lets a company-name banner decide the answer is
    guessing with a straight face;
  * the verdict does not depend on row order, so two hosts agree.

REAL DATA. Two committed regression baselines carry real account codes at
the two levels: `eei_dec_2025` is a 62-line book of 3- and 4-digit
synthetics, `scandia_fy2025` is a 653-line book of 6-digit analytics.
Those are the corpus cases here. The two client trial balances that
motivated the work stay outside the repo; `test_real_client_books_*`
reads them only when an operator points an env var at them and asserts
NOTHING but the classification.
"""
from __future__ import annotations

import json
import os
import random
from pathlib import Path

import pytest

from engine.comparatives.levels import ANALYTIC, INDETERMINATE, MIXED, SYNTHETIC
from engine.country_packs.ro_romania import detail_level as DL

REPO = Path(__file__).resolve().parents[2]
BASELINES = (REPO / "src" / "engine" / "country_packs" / "ro_romania"
             / "fixtures" / "regression_baselines")


def _codes_from_baseline(name):
    with open(str(BASELINES / (name + ".json")), encoding="utf-8") as fh:
        env = json.load(fh)["assembled"]
    return [str(li.get("ro_account_code") or "") for li in env["lineItems"]]


# ── account_code_depth — None is not zero ────────────────────────────

def test_depth_counts_digits():
    assert DL.account_code_depth("601") == 3
    assert DL.account_code_depth("6021") == 4
    assert DL.account_code_depth("601001") == 6


def test_depth_strips_the_separators_a_report_generator_prints():
    assert DL.account_code_depth("601.01") == 5
    assert DL.account_code_depth("601 01") == 5
    assert DL.account_code_depth("601-01") == 5
    assert DL.account_code_depth("  4111  ") == 4


@pytest.mark.parametrize("junk", [None, "", "   ", "TOTAL", "Total general",
                                  "60X", float("nan"), "-", "cont"])
def test_unusable_codes_are_none_never_zero(junk):
    """A depth of 0 would be the claim 'a code of zero digits'. There is
    no such account; the honest answer is that this row carries no code."""
    assert DL.account_code_depth(junk) is None


# ── the three levels ─────────────────────────────────────────────────

def test_a_book_of_synthetics_is_synthetic():
    d = DL.classify_detail_level(["101", "121", "4111", "6021", "707"])
    assert d.level == SYNTHETIC
    assert d.modal_depth in (3, 4)


def test_a_book_of_analytics_is_analytic():
    d = DL.classify_detail_level(["101201", "411101", "601001", "707001"])
    assert d.level == ANALYTIC
    assert d.modal_depth == 6


def test_a_book_of_both_is_mixed():
    codes = ["1011", "1012", "121", "129", "419"] + ["601%03d" % i for i in range(5)]
    d = DL.classify_detail_level(codes)
    assert d.level == MIXED
    assert d.signals.synthetic_share == pytest.approx(0.5)
    assert d.signals.analytic_share == pytest.approx(0.5)


def test_one_unsubdivided_account_does_not_make_a_book_mixed():
    """Real analytic exports carry a handful of accounts that were never
    subdivided — 121, 129, 691. One of them is a habit of the chart, not
    a second detail level."""
    codes = ["601%03d" % i for i in range(99)] + ["121"]
    d = DL.classify_detail_level(codes)
    assert d.level == ANALYTIC
    assert d.signals.synthetic_share == pytest.approx(0.01)


def test_the_mixed_floor_is_the_boundary_and_it_is_inclusive():
    """Just under the floor the book is pure; AT the floor it is mixed.
    The counts are derived from the constant, so moving the constant
    moves the test with it rather than leaving a stale literal behind."""
    n = 200
    at_floor = int(round(DL.MIXED_MINORITY_FLOOR * n))          # 10
    below = at_floor - 1                                         # 9

    def book(minority):
        return (["601%03d" % i for i in range(n - minority)]
                + ["12%d" % (i % 10) for i in range(minority)])

    assert DL.classify_detail_level(book(below)).level == ANALYTIC
    assert DL.classify_detail_level(book(at_floor)).level == MIXED


def test_no_usable_codes_refuses_instead_of_defaulting_to_synthetic():
    d = DL.classify_detail_level(["TOTAL", "", None, "Total general"])
    assert d.level == INDETERMINATE
    assert d.is_indeterminate
    assert d.modal_depth is None
    assert d.signals.classifiable_count == 0
    assert d.signals.synthetic_share is None
    assert "no detail level was established" in d.reason


def test_an_empty_book_refuses():
    assert DL.classify_detail_level([]).level == INDETERMINATE


# ── the corroborating signals are corroborating ──────────────────────

def test_a_header_identity_block_never_moves_the_verdict():
    """The banner correlates perfectly with the condensed book on the two
    real files, and correlation is not evidence. It is recorded and
    quoted; it does not branch."""
    analytic = ["601%03d" % i for i in range(40)]
    with_banner = DL.classify_detail_level(analytic, header_identity_block=True)
    without = DL.classify_detail_level(analytic, header_identity_block=False)

    assert with_banner.level == without.level == ANALYTIC
    assert with_banner.signals.header_identity_block is True
    assert without.signals.header_identity_block is False
    assert "a header identity block is present" in with_banner.reason
    assert "no header identity block" in without.reason


def test_row_count_never_moves_the_verdict():
    codes = ["1011", "121", "4111"]
    small = DL.classify_detail_level(codes, row_count=3)
    huge = DL.classify_detail_level(codes, row_count=9000)
    assert small.level == huge.level == SYNTHETIC
    assert small.signals.row_count == 3
    assert huge.signals.row_count == 9000


def test_row_count_records_rows_offered_not_rows_classified():
    d = DL.classify_detail_level(["1011", "TOTAL", "121"])
    assert d.signals.row_count == 3
    assert d.signals.classifiable_count == 2


# ── determinism ──────────────────────────────────────────────────────

def test_the_verdict_does_not_depend_on_row_order():
    codes = (["601%03d" % i for i in range(60)] + ["1011"] * 3
             + ["TOTAL", "", "4111"])
    reference = DL.classify_detail_level(codes)
    rng = random.Random(20260909)
    for _ in range(25):
        shuffled = list(codes)
        rng.shuffle(shuffled)
        assert DL.classify_detail_level(shuffled) == reference


def test_modal_depth_ties_break_to_the_smaller_depth():
    """Determinism first; the smaller depth is also the conservative side
    — it can only pull a verdict toward SYNTHETIC, which withholds
    breakdowns rather than inventing them."""
    d = DL.classify_detail_level(["1011", "1012", "101201", "101202"])
    assert d.modal_depth == 4
    assert d.level == MIXED  # 50/50 is far above the floor


# ── the reason renders the rule, it does not restate it ──────────────

def test_the_reason_renders_the_thresholds_from_the_constants(monkeypatch):
    before = DL.classify_detail_level(["1011"] * 10).reason
    assert "4-digit synthetic boundary" in before
    assert "5.0% mixed floor" in before

    monkeypatch.setattr(DL, "MIXED_MINORITY_FLOOR", 0.25)
    after = DL.classify_detail_level(["1011"] * 10).reason
    assert "25.0% mixed floor" in after
    assert after != before


# ── the parser-shaped convenience ────────────────────────────────────

def test_detail_level_from_rows_reads_the_parser_row_shape():
    rows = [{"cont": "601001", "nume_cont": "x"} for _ in range(10)]
    assert DL.detail_level_from_rows(rows).level == ANALYTIC


def test_detail_level_from_rows_infers_the_banner_from_the_header_index():
    """An externally-issued balanță stamps company name / address / Cod
    fiscal above the column headers, which pushes the header row down."""
    rows = [{"cont": "1011"} for _ in range(10)]
    external = DL.detail_level_from_rows(rows, extraction={"header_row_index": 5})
    internal = DL.detail_level_from_rows(rows, extraction={"header_row_index": 0})
    assert external.signals.header_identity_block is True
    assert internal.signals.header_identity_block is False
    assert external.level == internal.level == SYNTHETIC


def test_detail_level_from_rows_survives_a_junk_header_index():
    rows = [{"cont": "1011"}]
    d = DL.detail_level_from_rows(rows, extraction={"header_row_index": "n/a"})
    assert d.signals.header_identity_block is False


# ── REAL committed books ─────────────────────────────────────────────

def test_a_real_synthetic_book_classifies_synthetic():
    """EEI Dec-2025: 62 line items, 3- and 4-digit codes only."""
    d = DL.classify_detail_level(_codes_from_baseline("eei_dec_2025"))
    assert d.level == SYNTHETIC
    assert d.signals.classifiable_count == 62
    assert d.signals.analytic_share == 0.0


def test_a_real_analytic_book_classifies_analytic():
    """Scandia FY2025: 653 line items, 6-digit codes throughout."""
    d = DL.classify_detail_level(_codes_from_baseline("scandia_fy2025"))
    assert d.level == ANALYTIC
    assert d.modal_depth == 6
    assert d.signals.classifiable_count == 653
    assert d.signals.synthetic_share == 0.0


#: Operator hook for the two CONFIDENTIAL client books that motivated
#: this work. They are not in the repo and never will be; point the env
#: var at them to re-verify, e.g.
#:   CFO_AI_DETAIL_LEVEL_REAL_BOOKS="/path/2024.xlsx=synthetic::/path/2025.xls=analytic"
#: Only the classification is asserted — no row, balance or byte of those
#: files reaches this suite or its output.
_REAL_BOOKS_ENV = "CFO_AI_DETAIL_LEVEL_REAL_BOOKS"


@pytest.mark.skipif(not os.environ.get(_REAL_BOOKS_ENV),
                    reason="%s not set — client books are not in the repo"
                           % _REAL_BOOKS_ENV)
def test_real_client_books_classify_as_expected():
    from engine.country_packs.ro_romania.trial_balance_parser import (
        parse_trial_balance_file,
    )
    spec = os.environ[_REAL_BOOKS_ENV]
    pairs = [p for p in spec.split("::") if p.strip()]
    assert pairs, "%s was set but named no book" % _REAL_BOOKS_ENV
    for pair in pairs:
        path, _, expected = pair.rpartition("=")
        with open(path, "rb") as fh:
            parsed = parse_trial_balance_file(fh.read(), os.path.basename(path))
        got = DL.detail_level_from_rows(parsed)
        assert got.level == expected, (
            "%s classified %s, expected %s"
            % (os.path.basename(path), got.level, expected))
