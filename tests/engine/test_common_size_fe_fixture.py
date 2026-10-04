"""The two frontend fixtures of the single-period share lane are the
engine's bytes, today.

`frontend/lib/__tests__/fixtures/comparatives/` gains two files beside
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
      lists empty, every figure served) and the body of the period on
      screen, in `pair_served.json`'s own shape so the same helpers load
      it. Trimmed of what its readers do not read (`_trimmed` names each):
      line items on both sides, and the two-period ratio block.

A frontend gate over a hand-written document is a gate over a product that
does not exist (CLAUDE.md 21), so this test rebuilds both and reds when the
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

PRIOR_LATER_TRIMMED = ("current_body.line_items", "comparatives.prior_line_items", "comparatives.ratios")


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
    doc.pop("ratios", None)
    return {"_trimmed": list(PRIOR_LATER_TRIMMED), "current_body": earlier, "comparatives": doc}


def period_blocks_fixture_text() -> str:
    return FX._dump(build_period_blocks_fixture())


def prior_later_fixture_text() -> str:
    return FX._dump(build_prior_later_fixture())


OUTPUTS = ((PERIOD_BLOCKS_FIXTURE, period_blocks_fixture_text),
           (PRIOR_LATER_FIXTURE, prior_later_fixture_text))


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
    # (the prior's block also rides `prior_statements` today; nothing may
    # require it there — a prior share is read from the document's rows)
    for doc, pid in ((pair["comparatives"], pri_id), (later["comparatives"], cur_id)):
        if "common_size" in doc["prior_statements"]:
            assert doc["prior_statements"]["common_size"] == blocks[pid]["common_size"]

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
    assert "ratios" not in later["comparatives"] and later["_trimmed"] == list(PRIOR_LATER_TRIMMED)


if __name__ == "__main__":
    if "--write" in sys.argv:
        for path, text in OUTPUTS:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text(), encoding="utf-8")
            print("wrote", path, path.stat().st_size)
