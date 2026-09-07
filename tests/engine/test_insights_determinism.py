"""The block is a pure function of the book, and the committed fixture is
what the engine actually emits.

WHAT THIS GATE REDS ON, after the repair (TC-11):
  · a non-deterministic block — a clock, a `hash()`, a set iteration or a
    dict ordering leaking into the output. A report whose section order
    or figures move between two runs over one book is not an artefact;
  · `tests/engine/fixtures/firm/insights.json` going stale, which would
    let the FRONTEND gates pass over a block the engine no longer
    produces (the failure mode `capture_industry_signal.py` was written
    to prevent, applied to this lane);
  · an ABSENT input becoming a plausible figure — every measure the book
    cannot support must be `null`, and the block must still render;
  · a payload carrying only `statements` (no envelope, no line items)
    crashing instead of reporting its gaps;
  · the pack losing its floor band, or listing bands out of descending
    order, which would make the strictest band unreachable.

WHAT IT CANNOT SEE (TC-11): whether the fixture's CONTENT is right — that
is `test_insights_detectors.py`. It cannot see the served route: nothing
in this lane is wired into `pipeline.py` yet, so "what the API returns"
is out of its reach by construction.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict

import pytest

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
sys.path.insert(0, str(REPO / "src"))

from engine.insights import build_insights, load_pack  # noqa: E402
from engine.insights.packdata import InsightPack, PackError  # noqa: E402

BOOKS = ("agras", "carniprod", "realestate", "retail")


def _book(name: str) -> Dict[str, Any]:
    return json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text())


@pytest.mark.parametrize("book", BOOKS)
def test_two_runs_over_one_book_are_byte_identical(book: str):
    payload = _book(book)
    first = json.dumps(build_insights(payload), sort_keys=True)
    second = json.dumps(build_insights(_book(book)), sort_keys=True)
    assert first == second


@pytest.mark.parametrize("book", BOOKS)
def test_the_committed_fixture_is_what_the_engine_emits_today(book: str):
    committed = json.loads((FIRM / "insights.json").read_text())
    assert book in committed, "insights.json carries no %s block" % book
    live = json.loads(json.dumps(build_insights(_book(book))))
    assert live == committed[book], (
        "tests/engine/fixtures/firm/insights.json is STALE for %s — re-run "
        "tests/engine/fixtures/firm/capture_insights.py. A frontend gate "
        "rendering this file would otherwise stay green over a block the "
        "engine no longer produces." % book
    )


def test_the_capture_script_agrees_with_its_own_check_mode():
    result = subprocess.run(
        [sys.executable, str(FIRM / "capture_insights.py"), "--check"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "FRESH" in result.stdout


def test_a_statements_only_payload_reports_its_gaps_instead_of_crashing():
    """The canonical rows and the line items are what the balance-sheet
    detectors read. Without them the block still builds, and every
    detector that needed them lands in `not_fired` with a reason."""
    payload = {"statements": _book("agras")["statements"]}
    block = build_insights(payload)
    assert block["schema_version"] == "insights/1"
    fired = set(i["id"] for i in block["insights"])
    silent = set(n["id"] for n in block["not_fired"])
    assert fired | silent == {
        "asset_age", "earnings_quality", "financial_position",
        "liquidity_quality", "reconstruction_gap", "related_party_exposure",
        "trade_float", "unclassified_balances",
    }
    assert "asset_age" in silent, "no canonical rows, so no asset base to age"
    # The P&L-only detectors still work off the assembled P&L.
    assert "reconstruction_gap" in fired
    assert "financial_position" in fired


def test_an_absent_measure_is_null_and_never_a_zero():
    """The realestate book cannot compute DPO — cost of goods sold is
    nil. The measure must be null, and the rendered claim must say so in
    words rather than printing a plausible 0.0 days."""
    block = build_insights(_book("realestate"))
    trade = [i for i in block["insights"] if i["id"] == "trade_float"][0]
    dpo = [m for m in trade["measures"] if m["key"] == "dpo"][0]
    assert dpo["value"] is None
    assert "not reported" in trade["claim"], trade["claim"]
    assert "0.0 days of payables" not in trade["claim"]


@pytest.mark.parametrize("book", BOOKS)
def test_no_insight_carries_a_nan_or_an_infinity(book: str):
    text = json.dumps(build_insights(_book(book)))
    for token in ("NaN", "Infinity", "-Infinity"):
        assert token not in text, "%s leaked %s" % (book, token)


def test_the_absent_safe_divide_refuses_rather_than_returning_zero():
    """`_div` is the shared ABSENT != ZERO helper. No committed book
    currently drives it to its None branch — found by planting: turning
    its two `return None` into `return 0.0` reds NOTHING on the four real
    books, which means that branch had no gate at all. It has one now."""
    from engine.insights.detectors import _div

    assert _div(None, 10.0) is None
    assert _div(10.0, None) is None
    assert _div(10.0, 0.0) is None, "a zero denominator is ABSENT, not infinity"
    assert _div(10.0, 1e-12) is None
    assert _div(0.0, 10.0) == 0.0, "a real zero numerator is a real zero"
    assert _div(10.0, 4.0) == 2.5


def test_the_book_view_refuses_a_basis_that_is_zero_or_negative():
    """A negative EBITDA is not a small scale. Dividing by it produces a
    materiality whose sign is an artefact of the loss, not a reading."""
    from engine.insights.book import Book

    negative = Book({"statements": {"currency": "RON",
                                    "assembled_pl": {"ebitda": -5.0,
                                                     "revenue": 0.0},
                                    "assembled_bs": {"total_assets": -1.0}}})
    assert negative.basis("ebitda_positive") is None
    assert negative.basis("revenue") is None
    assert negative.basis("total_assets") is None
    # The ABSOLUTE variant is a different question and stays answerable.
    assert negative.basis("ebitda") == 5.0


def test_row_sum_over_rows_that_do_not_exist_is_absent_not_zero():
    """A book that never carried a row and a book whose row is nil are
    different facts."""
    from engine.insights.book import Book

    empty = Book({"statements": {}, "envelope": {}, "line_items": []})
    assert empty.row_sum(("ppe_land", "ppe_buildings")) is None

    present = Book({
        "statements": {},
        "envelope": {"canonical_bs": {"rows": [
            {"id": "ppe_land", "label": "Land", "amount": 0.0,
             "section": "non_current_assets", "leaf_ids": ["211"]},
        ]}},
        "line_items": [],
    })
    assert present.row_sum(("ppe_land", "ppe_buildings")) == 0.0


# ── the pack refuses to load a ladder nobody can audit ────────────────


def _pack_with(detector: Dict[str, Any]) -> InsightPack:
    return InsightPack({"schema_version": "insights/1", "pack_id": "t",
                        "pack_version": "1", "detectors": [detector],
                        "ranking": {"statement": "s", "summary_limit": 5}})


_BASE = {
    "id": "x", "title": "t", "formula": "f", "basis": "revenue",
    "basis_label": "Revenue", "basis_why": "because " * 12,
    "magnitude": "m", "magnitude_label": "M", "claim": "c",
}


def test_a_ladder_with_no_floor_band_is_refused():
    with pytest.raises(PackError) as caught:
        _pack_with(dict(_BASE, bands=[{"level": "high", "at_least": 0.5}]))
    assert "no floor band" in str(caught.value)


def test_a_ladder_listed_out_of_descending_order_is_refused():
    with pytest.raises(PackError) as caught:
        _pack_with(dict(_BASE, bands=[
            {"level": "low", "at_least": 0.1},
            {"level": "high", "at_least": 0.5},
            {"level": "info", "at_least": None},
        ]))
    assert "descending order" in str(caught.value)


def test_the_shipped_pack_loads_and_every_detector_has_an_implementation():
    from engine.insights.detectors import DETECTORS

    pack = load_pack()
    declared = set(d.id for d in pack.detectors)
    implemented = set(DETECTORS)
    assert declared == implemented, (
        "pack declares %s; the module implements %s"
        % (sorted(declared - implemented), sorted(implemented - declared))
    )
