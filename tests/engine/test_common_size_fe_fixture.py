"""The three frontend fixtures of the single-period share lane are the
engine's bytes, today.

`frontend/lib/__tests__/fixtures/comparatives/` gains three files beside
`pair_served.json`, built from the SAME committed corpus pair by the same
builder (`test_ratio_compare_fe_fixture._labelled_pair`: agras as Dec 2025,
carniprod as Dec 2024, each read back through the real router):

  period_common_size.json
      `statements.common_size` (schema common_size/1) as GET /api/period
      serves it for each of the two periods — the block the dashboard's
      share column prints when no comparison is on screen. Small on
      purpose: the block and the period's label, nothing else.

  pair_prior_later.json
      The pair the OTHER way round: Dec 2024 on screen, compared with Dec
      2025 — a prior that closes LATER. The served comparatives document
      (`direction.order == "prior_is_later"`, every mover verdict null, both
      lists empty, the ratio block's band verdicts withheld under the same
      reason, every figure served) and the body of the period on screen, in
      `pair_served.json`'s own shape so the same helpers load it. Trimmed
      of what its readers do not read (`_trimmed` names each): the line
      items on both sides. The two-period ratio block stays: the Ratios tab
      renders it, and what it must NOT list under a later prior is the
      frontend gate's law.

  period_line_items.json
      The line items GET /api/period serves for each of the two periods —
      the one field the pair fixtures trim. The frontend gate that mounts
      THE REAL dashboard page (`pages/cfo/__tests__/singleYearSharePage.
      test.tsx`) puts them back, so the body its mocked network answers
      with is the route's whole body: the page's balance-sheet tab paints
      the canonical rows (and their shares) only for a period that carries
      line items.

A frontend gate over a hand-written document is a gate over a product that
does not exist (CLAUDE.md 21), so this test rebuilds all three and reds when the
committed bytes differ — and holds, on the committed bytes, the two facts
the frontend gate relies on: the comparison document's current share IS
the period's own block (one figure per page), and the later-prior document
serves no verdict.

Regenerate after an intended engine change (also rewrites nothing else):
    PYTHONPATH=src:tests/engine python tests/engine/test_common_size_fe_fixture.py --write
or, with the two older fixtures of the same pair:
    PYTHONPATH=src python scripts/capture_comparatives_pair.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict

import test_ratio_compare_fe_fixture as FX

REPO = Path(__file__).resolve().parents[2]
PERIOD_BLOCKS_FIXTURE = FX.FIXTURE.with_name("period_common_size.json")
PRIOR_LATER_FIXTURE = FX.FIXTURE.with_name("pair_prior_later.json")
LINE_ITEMS_FIXTURE = FX.FIXTURE.with_name("period_line_items.json")

PRIOR_LATER_TRIMMED = ("current_body.line_items", "comparatives.prior_line_items")


def build_period_blocks_fixture() -> Dict[str, Any]:
    cur, pri = FX._labelled_pair()
    periods = {}
    for body in (cur, pri):
        periods[body["period"]["id"]] = {
            "label": body["statements"]["periodLabel"],
            "period_end": body["period"]["period_end"],
            "common_size": body["statements"]["common_size"],
        }
    return {
        "_source": "GET /api/period/{id} -> statements.common_size, for the two periods of pair_served.json",
        "periods": periods,
    }


def build_prior_later_fixture() -> Dict[str, Any]:
    later, earlier = FX._labelled_pair()
    # The earlier period on screen, the later one as its comparison.
    doc = FX._compare(earlier, later)
    earlier.pop("line_items", None)
    doc.pop("prior_line_items", None)
    return {"_trimmed": list(PRIOR_LATER_TRIMMED), "current_body": earlier, "comparatives": doc}


def build_line_items_fixture() -> Dict[str, Any]:
    cur, pri = FX._labelled_pair()
    return {
        "_source": "GET /api/period/{id} -> line_items, for the two periods of pair_served.json "
                   "(the field pair_served.json and pair_prior_later.json trim)",
        "periods": dict((body["period"]["id"], {"line_items": body["line_items"]}) for body in (cur, pri)),
    }


def line_items_fixture_text() -> str:
    return FX._dump(build_line_items_fixture())


def period_blocks_fixture_text() -> str:
    return FX._dump(build_period_blocks_fixture())


def prior_later_fixture_text() -> str:
    return FX._dump(build_prior_later_fixture())


OUTPUTS = ((PERIOD_BLOCKS_FIXTURE, period_blocks_fixture_text),
           (PRIOR_LATER_FIXTURE, prior_later_fixture_text),
           (LINE_ITEMS_FIXTURE, line_items_fixture_text))


def test_the_committed_period_blocks_fixture_is_todays_served_block():
    assert PERIOD_BLOCKS_FIXTURE.is_file(), "missing %s: run this file with --write" % PERIOD_BLOCKS_FIXTURE
    assert PERIOD_BLOCKS_FIXTURE.read_text(encoding="utf-8") == period_blocks_fixture_text(), (
        "period_common_size.json drifted from the block GET /api/period serves; "
        "re-run with --write after an intended change and review the frontend gate")


def test_the_committed_prior_later_fixture_is_todays_served_document():
    assert PRIOR_LATER_FIXTURE.is_file(), "missing %s: run this file with --write" % PRIOR_LATER_FIXTURE
    assert PRIOR_LATER_FIXTURE.read_text(encoding="utf-8") == prior_later_fixture_text(), (
        "pair_prior_later.json drifted from the engine's served comparatives document; "
        "re-run with --write after an intended change and review the frontend gate")


def test_the_committed_line_items_fixture_is_todays_served_line_items():
    assert LINE_ITEMS_FIXTURE.is_file(), "missing %s: run this file with --write" % LINE_ITEMS_FIXTURE
    assert LINE_ITEMS_FIXTURE.read_text(encoding="utf-8") == line_items_fixture_text(), (
        "period_line_items.json drifted from the line items GET /api/period serves; "
        "re-run with --write after an intended change and review the frontend gate")


def test_the_committed_fixtures_carry_what_the_frontend_gate_needs():
    """On the COMMITTED bytes (what vitest reads): one figure per page, and
    a later prior with every figure and no verdict."""
    blocks = json.loads(PERIOD_BLOCKS_FIXTURE.read_text(encoding="utf-8"))["periods"]
    pair = json.loads(FX.FIXTURE.read_text(encoding="utf-8"))
    later = json.loads(PRIOR_LATER_FIXTURE.read_text(encoding="utf-8"))

    cur_id = pair["current_body"]["period"]["id"]
    pri_id = pair["comparatives"]["prior"]["period_id"]
    assert set(blocks) == {cur_id, pri_id} and cur_id != pri_id
    for entry in blocks.values():
        assert entry["common_size"]["schema"] == "common_size/1"
        assert sum(1 for r in entry["common_size"]["rows"] if r["status"] == "share") >= 60

    # the period body the dashboard gates render carries the same block
    assert pair["current_body"]["statements"]["common_size"] == blocks[cur_id]["common_size"]
    assert later["current_body"]["statements"]["common_size"] == blocks[pri_id]["common_size"]
    # (the prior's block does not ride `prior_statements` a second time: a
    # prior share is read from the document's rows)
    for doc in (pair["comparatives"], later["comparatives"]):
        assert "common_size" not in doc["prior_statements"]

    # ONE FIGURE PER PAGE: with a document on screen, the share it serves
    # for the period on screen is that period's own block, key by key.
    for doc, cur, pri in ((pair["comparatives"], cur_id, pri_id), (later["comparatives"], pri_id, cur_id)):
        mine = dict((r["key"], r) for r in blocks[cur]["common_size"]["rows"])
        theirs = dict((r["key"], r) for r in blocks[pri]["common_size"]["rows"])
        shared = 0
        for row in doc["common_size"]:
            assert row["current_share"] == (mine[row["key"]]["share"] if row["key"] in mine else None), row["key"]
            assert row["prior_share"] == (theirs[row["key"]]["share"] if row["key"] in theirs else None), row["key"]
            shared += row["current_share"] is not None
        assert shared >= 60, shared

    # THE REAL PAGE'S BODIES: the trimmed field, for both periods — and each
    # period carries the canonical rows its balance-sheet tab paints.
    items = json.loads(LINE_ITEMS_FIXTURE.read_text(encoding="utf-8"))["periods"]
    assert set(items) == {cur_id, pri_id}
    for pid, body in ((cur_id, pair["current_body"]), (pri_id, later["current_body"])):
        assert "line_items" not in body  # trimmed there, kept here
        assert len(items[pid]["line_items"]) >= 200, len(items[pid]["line_items"])
        assert set(items[pid]["line_items"][0]) >= {"statement", "bucket", "amount"}
        assert len(body["statements"]["canonical_bs"]["rows"]) >= 30

    # which way time runs
    assert pair["comparatives"]["direction"]["order"] == "prior_is_earlier"
    assert pair["comparatives"]["direction"]["verdicts_served"] is True
    assert pair["comparatives"]["movers"]["verdicts_withheld"] is None
    assert pair["comparatives"]["movers"]["improved"] and pair["comparatives"]["movers"]["deteriorated"]
    d = later["comparatives"]["direction"]
    assert (d["order"], d["verdicts_served"], d["reason"]) == ("prior_is_later", False, "prior_is_later")
    assert (d["current_period_end"], d["prior_period_end"]) == ("2024-12-31", "2025-12-31")
    mv = later["comparatives"]["movers"]
    assert mv["verdicts_withheld"] == "prior_is_later"
    assert len(mv["top"]) >= 5 and all(m["verdict"] is None for m in mv["top"])
    assert mv["improved"] == [] and mv["deteriorated"] == []
    assert later["comparatives"]["current"]["label"] == "Dec 2024"
    assert later["comparatives"]["prior"]["label"] == "Dec 2025"
    for name in ("pl", "bs_assets", "bs_liabilities_equity"):
        assert later["comparatives"]["bridges"][name]["closes"] is True, name
    assert later["_trimmed"] == list(PRIOR_LATER_TRIMMED)
    # THE RATIO BLOCK reads the same direction: forwards, ratios are listed
    # improved / deteriorated with a finding each; backwards, none is — the
    # crossings sit under `not_comparable` with the reason, and no delta
    # carries the adjective.
    fbm = pair["comparatives"]["ratios"]["band_movements"]
    assert fbm["verdicts_withheld"] is None and fbm["improved"] and fbm["deteriorated"] and fbm["findings"]
    bbm = later["comparatives"]["ratios"]["band_movements"]
    assert bbm["verdicts_withheld"] == "prior_is_later"
    assert bbm["improved"] == [] and bbm["deteriorated"] == [] and bbm["findings"] == []
    withheld = set(e["key"] for e in bbm["not_comparable"] if e["reason_code"] == "prior_is_later")
    assert withheld == set(fbm["improved"]) | set(fbm["deteriorated"]) and len(withheld) >= 5
    block = later["comparatives"]["ratios"]
    for row in block["rows"] + block["composites"] + block["subscores"]:
        assert row["delta"]["favourable"] not in ("improved", "deteriorated"), row["key"]
        assert row["movement"]["status"] not in ("crossed_up", "crossed_down"), row["key"]


if __name__ == "__main__":
    if "--write" in sys.argv:
        for path, text in OUTPUTS:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text(), encoding="utf-8")
            print("wrote", path, path.stat().st_size)
