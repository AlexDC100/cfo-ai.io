"""The frontend's constructed one-EBITDA books ARE what the route serves.

``frontend/lib/__tests__/fixtures/oneEbitda/constructed_books.json`` holds
``GET /api/period`` for seven constructed books of the ``net-711-rule`` gate
(a bridge, no 711 postings with a 121 remainder, 72x beside a bridge, an
open book, and three refusals — one without account 121, one with it, and
the export with 121 dropped whose total equity is short by the refused
result). The
frontend P&L gate (``pl-one-ebitda-page``) renders them. A fixture written
once and never re-read would let the page agree with a route that has
moved on, so this test regenerates it through the real write seam and the
real route and reds when the committed bytes differ.

Regenerate: ``tests/engine/fixtures/one_ebitda/capture_constructed.py``.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CAPTURE = REPO / "tests" / "engine" / "fixtures" / "one_ebitda" / "capture_constructed.py"


def _capture_module():
    spec = importlib.util.spec_from_file_location("capture_constructed", CAPTURE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_the_constructed_books_fixture_is_what_the_route_serves():
    cap = _capture_module()
    assert cap.OUT.is_file(), "the frontend fixture is missing — run %s" % CAPTURE
    fresh = cap.serialise(cap.capture())
    assert cap.OUT.read_text("utf-8") == fresh, (
        "constructed_books.json no longer matches GET /api/period for the "
        "constructed books — rerun tests/engine/fixtures/one_ebitda/"
        "capture_constructed.py and re-read the frontend gate it feeds")


def test_the_fixture_carries_every_case_the_page_must_print():
    """Non-vacuity: a refusal with and without an anchor, a 121 remainder
    on a book with no 711 postings, 72x beside a bridge, an open book."""
    import json

    books = json.loads(_capture_module().OUT.read_text("utf-8"))
    pl = dict((name, body["statements"]["assembled_pl"]) for name, body in books.items())
    assert pl["unanchored"]["ebitda"] is None
    assert pl["unanchored"]["inventory_variation"]["refusal"]["code"] == "account_121_anchor_absent"
    assert pl["g6_uncleared"]["ebitda"] is None
    assert pl["g6_uncleared"]["inventory_variation"]["refusal"]["code"] == "account_121_opening_not_cleared"
    assert pl["closed_no_activity"]["inventory_variation"]["provenance"] == "no_711_activity"
    assert abs(pl["closed_no_activity"]["net_income_unexplained_vs_121"]) > 1.0
    assert pl["bridge_with_722"]["capitalized_own_work"]["value"] > 0
    assert pl["bridge_with_722"]["inventory_variation"]["provenance"] == "account_121_bridge"
    assert pl["open"]["inventory_variation"]["provenance"] == "711_net_movement"
    # The export with account 121 dropped: the net result refused AND total
    # equity short by it (the sheet does not balance without the result).
    assert pl["unanchored_unbalanced"]["net_income_refusal"]["code"] == "account_121_anchor_absent"
    abs_ = books["unanchored_unbalanced"]["statements"]["assembled_bs"]
    assert abs_["total_equity_refusal"]["code"] == "account_121_anchor_absent"
    assert abs(abs_["bs_balance_delta"]) > 1.0
    assert "total_equity_refusal" not in books["unanchored"]["statements"]["assembled_bs"]
