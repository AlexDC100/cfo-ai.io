"""R4 — SEVERITY IS SCALED TO THIS COMPANY, NOT TO AN ABSOLUTE CUTOFF.

THE DEFECT THIS PREVENTS. A threshold written in currency ("flag any
unclassified balance over 25,000 RON") grades a corner-shop rounding error
and a mid-cap's genuine hole identically, and it grades them both wrong.
The same is true of a ladder that LOOKS relative but reads a fixed number
underneath.

WHAT THIS GATE REDS ON, after the repair (TC-11):
  · the SAME absolute delta grading the same on two books of different
    size — the direct R4 assertion, run on two real committed books
    (agras, 39.3M of assets; carniprod, 125.9M) with one planted figure;
  · a severity that stops carrying the basis it was scaled against, its
    value, or the ladder — a bare level is a threshold claim a reader
    cannot check;
  · a basis that is zero or negative being used as a scale rather than
    refused (dividing by a negative EBITDA produces a "materiality" whose
    sign is meaningless);
  · a detector whose primary basis is unavailable silently grading `low`
    instead of saying the scale was unavailable.

WHAT IT CANNOT SEE (TC-11): whether the CUTOFFS are the right ones. It
proves the ladder is relative and that the ladder in the pack is the
ladder applied; it cannot tell you that 0.1% of assets is the right place
to put `high` for an unclassified balance. That number came from the
coordinator's read of these four books, and it is data in
`packs/insights/detectors.yaml` precisely so it can be re-argued without
touching code.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any, Dict

import pytest

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
sys.path.insert(0, str(REPO / "src"))

from engine.insights import build_insights  # noqa: E402
from engine.insights.book import Book  # noqa: E402
from engine.insights.packdata import load_pack  # noqa: E402
from engine.insights.severity import grade  # noqa: E402

#: The delta the two books are graded on. It is the REAL Agras figure —
#: account 413, the balance the live report never mentioned.
PLANTED_DELTA = 46613.06


def _book(name: str) -> Dict[str, Any]:
    return json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text())


def _grade_on(book_name: str, detector_id: str, magnitude: float):
    spec = load_pack().spec(detector_id)
    return grade(spec, Book(_book(book_name)), magnitude)


def test_the_same_delta_grades_differently_on_a_small_and_a_large_book():
    """THE R4 GATE.

    46,613.06 RON of unclassified balance is 0.119% of Agras' 39.3M of
    assets and 0.037% of Carniprod's 125.9M. One is a hole worth chasing;
    the other is close to a rounding artefact. A ladder that graded them
    the same would be an absolute threshold."""
    small = _grade_on("agras", "unclassified_balances", PLANTED_DELTA)
    large = _grade_on("carniprod", "unclassified_balances", PLANTED_DELTA)

    assert small.magnitude == large.magnitude == PLANTED_DELTA
    assert small.basis_value is not None and large.basis_value is not None
    assert large.basis_value > small.basis_value * 3, (
        "the two books must actually differ in size for this to test "
        "anything: %s vs %s" % (small.basis_value, large.basis_value)
    )
    assert small.level != large.level, (
        "the same %s delta graded %s on a %s book and %s on a %s book — the "
        "ladder is not scaled to the company"
        % (PLANTED_DELTA, small.level, small.basis_value, large.level,
           large.basis_value)
    )
    assert (small.level, large.level) == ("high", "medium"), (
        small.level, large.level,
    )
    assert small.materiality > large.materiality


@pytest.mark.parametrize(
    "detector_id",
    ["related_party_exposure", "trade_float", "reconstruction_gap",
     "financial_position", "earnings_quality"],
)
def test_every_money_scaled_detector_moves_with_the_books_size(detector_id: str):
    """Not just the unclassified one: any detector whose magnitude is an
    amount must grade a fixed amount differently on books of different
    size, or its ladder is absolute."""
    magnitude = 3_000_000.0
    verdicts = {}
    for name in ("agras", "carniprod", "realestate", "retail"):
        verdict = _grade_on(name, detector_id, magnitude)
        if verdict.materiality is None:
            continue
        verdicts[name] = verdict.materiality
    assert len(verdicts) >= 2, verdicts
    assert len(set(round(v, 9) for v in verdicts.values())) == len(verdicts), (
        "%s produced the same materiality on books of different size: %s"
        % (detector_id, verdicts)
    )


def test_a_basis_that_is_not_positive_is_refused_rather_than_divided_by():
    """A negative EBITDA is not a small scale — it is not a scale. The
    realestate book has one, and `earnings_quality` must fall back to the
    declared basis and SAY it fell back, not print a share whose sign is
    an artefact."""
    verdict = _grade_on("realestate", "earnings_quality", 16620.28)
    assert verdict.basis == "revenue", verdict.basis
    assert "not a usable scale" in verdict.why, verdict.why
    assert verdict.materiality is not None and verdict.materiality > 0


def test_a_book_with_no_usable_basis_at_all_grades_info_and_says_why():
    """ABSENT != ZERO at the severity layer. Not `low` — `low` would be a
    claim that the magnitude is small, which nothing here established."""
    empty = {"statements": {"currency": "RON", "assembled_pl": {},
                            "assembled_bs": {}}, "envelope": {},
             "line_items": []}
    spec = load_pack().spec("related_party_exposure")
    verdict = grade(spec, Book(empty), 1_000_000.0)
    assert verdict.level == "info"
    assert verdict.materiality is None
    assert "not available" in verdict.why, verdict.why


@pytest.mark.parametrize("book", ["agras", "carniprod", "realestate", "retail"])
def test_every_served_severity_states_its_basis_and_its_ladder(book: str):
    for insight in build_insights(_book(book))["insights"]:
        severity = insight["severity"]
        assert severity["basis"], insight["id"]
        assert severity["basis_label"], insight["id"]
        assert severity["bands"], insight["id"]
        assert len(severity["why"].split()) >= 10, (
            "%s states no reason for its scale: %r"
            % (insight["id"], severity["why"])
        )
        if severity["materiality"] is not None:
            assert severity["basis_value"] is not None, insight["id"]
            assert severity["basis_value"] > 0, insight["id"]


def test_scaling_a_book_up_moves_a_fixed_delta_down_the_ladder():
    """The property stated directly, on one book: multiply every balance
    by ten and the same planted delta must grade less severely."""
    payload = _book("agras")
    inflated = copy.deepcopy(payload)
    for key, value in list(inflated["statements"]["assembled_bs"].items()):
        if isinstance(value, (int, float)):
            inflated["statements"]["assembled_bs"][key] = value * 10.0

    before = _grade_on("agras", "unclassified_balances", PLANTED_DELTA)
    spec = load_pack().spec("unclassified_balances")
    after = grade(spec, Book(inflated), PLANTED_DELTA)
    assert after.materiality < before.materiality
    assert after.level != before.level, (before.level, after.level)
