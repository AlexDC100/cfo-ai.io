"""The dashboard's served comparatives fixture is the engine's output, today.

`frontend/lib/__tests__/fixtures/comparatives/pair_served.json` is what the
Ratios tab gates (`ratioCompareTab.test.tsx`) render: a real GET
/api/period body for the current period and the `compare_payloads`
document the /comparatives route serves for the pair. A frontend gate over
a stale capture is a gate over a product that no longer exists (the
FakeStore lesson, CLAUDE.md 21), so this test rebuilds the document from
the committed corpus pair through the same route core and reds when the
committed bytes differ.

The pair is the one the ratio gates already hand-check: agras (current)
against carniprod (prior), both read back through the real router over
`_served_books`, each seeded with the metric rows the pipeline persists
for it (so the body is an analysed period's, `credit_metrics_as_filed`
included). Three things are set on the served bodies before the
comparison, and only these, because the corpus workbooks carry no date in
their filename and both would otherwise label as the run date: each
side's `statements.periodLabel` ("Dec 2025" / "Dec 2024") and each side's
`period.id`, with the prior's `period.period_end` moved to 2024-12-31.
Line items are dropped from the committed file (`_trimmed` names them):
no ratio reader reads them and they are most of its size.

Regenerate after an intended engine change:
    PYTHONPATH=src python tests/engine/test_ratio_compare_fe_fixture.py --write
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any, Dict

import _served_books as SB
from engine.api import _comparatives as C
from engine.ratios.credit_model import compute_period_metrics

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "frontend" / "lib" / "__tests__" / "fixtures" / "comparatives" / "pair_served.json"

TRIMMED = ("current_body.line_items", "comparatives.prior_line_items")


def _analysed_body(name: str) -> Dict[str, Any]:
    """The body of a period the pipeline analysed: `calculated_metrics`
    carries the rows `stage_compute` persists (`compute_period_metrics`
    over the served statements), read back through the real router."""
    bare = SB.served_body(name)
    rows = compute_period_metrics(copy.deepcopy(bare["statements"]))
    return SB.routed_body(SB.book(name), metrics=rows)


def build_fixture() -> Dict[str, Any]:
    cur = _analysed_body("agras")
    pri = _analysed_body("carniprod")
    cur["statements"]["periodLabel"] = "Dec 2025"
    cur["period"]["id"] = "period-agras-fy2025"
    pri["statements"]["periodLabel"] = "Dec 2024"
    pri["period"]["id"] = "period-carniprod-fy2024"
    pri["period"]["period_end"] = "2024-12-31"
    doc = C.compare_payloads(
        cur, pri,
        current_row={"id": cur["period"]["id"], "period_end": cur["period"]["period_end"]},
        prior_row={"id": pri["period"]["id"], "period_end": pri["period"]["period_end"]},
    )
    cur.pop("line_items", None)
    doc.pop("prior_line_items", None)
    return {"_trimmed": list(TRIMMED), "current_body": cur, "comparatives": doc}


def fixture_text() -> str:
    return json.dumps(build_fixture(), sort_keys=True, indent=1, ensure_ascii=False, allow_nan=False) + "\n"


def test_the_committed_frontend_fixture_is_todays_served_document():
    assert FIXTURE.is_file(), "missing %s: run this file with --write" % FIXTURE
    committed = FIXTURE.read_text(encoding="utf-8")
    assert committed == fixture_text(), (
        "pair_served.json drifted from the engine's served comparatives document; "
        "re-run with --write after an intended change and review the frontend gates")


def test_the_fixture_carries_what_the_tab_gates_need():
    doc = json.loads(fixture_text())
    ratios = doc["comparatives"]["ratios"]
    moves = ratios["band_movements"]
    # non-vacuity: both lists populated and the prior composites valued
    assert moves["improved"] and moves["deteriorated"]
    by_key = {r["key"]: r for r in ratios["composites"]}
    for key in ("altman_z", "credit_composite", "letter_grade"):
        assert by_key[key]["prior"]["value_q"] is not None, key
    assert isinstance(doc["current_body"]["credit_metrics_as_filed"], list)
    table = doc["current_body"]["assembled_metrics"]["ratio_table"]
    assert [r["key"] for r in table["rows"]] == [r["key"] for r in ratios["rows"]]
    assert doc["comparatives"]["current"]["label"] != doc["comparatives"]["prior"]["label"]


if __name__ == "__main__":
    if "--write" in sys.argv:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(fixture_text(), encoding="utf-8")
        print("wrote", FIXTURE, FIXTURE.stat().st_size)
