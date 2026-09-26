"""The interest-coverage popover's corpus fixture is the engine's output, today.

`frontend/lib/__tests__/fixtures/coverage_popover_corpus.json` is what the
popover half of `interest-coverage-one-operand`
(`frontend/lib/__tests__/interestCoveragePopover.test.tsx`, "every corpus
book with interest") renders: for EVERY corpus case, the analysed GET
/api/period body the Ratios tab reads, carried through the production write
path (`stage_map` -> `stage_persist`, `test_rebuild_net_income_anchor._Book`)
and read back through the REAL router (`_served_books.routed_body`), with the
metric rows `stage_compute` persists seeded as `calculated_metrics`
(`compute_period_metrics` over the served statements — the analysed body,
exactly as `test_ratio_compare_fe_fixture` builds it).

WHY A CORPUS-WIDE FIXTURE. The popover prints `EBIT <x> ÷ Interest <y>` under
the card, and the reader checks the card by dividing the two. The four firm
fixtures (`tests/engine/fixtures/firm/`) cover three of the corpus books that
carry interest; `saga_10_col` has none, so a gate over them alone was not a
gate over the corpus. The scope is DISCOVERED here (`corpus_replay.
discover_cases`), so a corpus book added with interest joins the frontend gate
by construction: this file reds until the fixture is rewritten with it.

WHAT IS COMMITTED. Corpus books only (ruling Q10: no client book or served
capture is committed). Per case: whether the offline write path serves it
(the AI-lane and scanned cases need a model and are recorded as refused, with
the exception class); the served interest expense and the served
`interest_coverage` row (value, printed digits, refusal code). For a book whose
coverage is measured (interest > 0) the body the card and the popover read:
`statements`, `assembled_metrics.ratio_table` and `metrics`. Everything else
of the body is trimmed (`_trimmed`): no reader on this surface reads it.

Regenerate after an intended engine change:
    PYTHONPATH=src:tests/engine python tests/engine/test_coverage_popover_corpus_fixture.py --write
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import _served_books as SB
import test_rebuild_net_income_anchor as ANCHOR
from engine.ratios.credit_model import compute_period_metrics

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "frontend" / "lib" / "__tests__" / "fixtures" / "coverage_popover_corpus.json"
KEY = "interest_coverage"

#: What a measured book keeps of its served body. Everything else is trimmed.
KEPT = ("statements", "assembled_metrics.ratio_table", "metrics")
TRIMMED = ("line_items", "alerts", "briefing", "recommendations", "valuation",
           "organization", "period", "industry_signal", "credit_metrics_as_filed",
           "assembled_metrics (all but ratio_table)", "canonical_version",
           "confidence", "deprecated_fields", "pack_provenance")

#: TC-3. The corpus carries four books with interest today (saga_10_col and
#: the agras / realestate / retail twins); a corpus that stops carrying them
#: makes the frontend gate vacuous, so the count is asserted.
MEASURED_FLOOR = 4


def _analysed_body(case_id: str, case_dir: Path) -> Dict[str, Any]:
    bk = ANCHOR._book(case_id, case_dir)
    bare = SB.routed_body(bk)
    rows = compute_period_metrics(copy.deepcopy(bare["statements"]))
    return SB.routed_body(bk, metrics=rows)


def _row(body: Dict[str, Any]) -> Dict[str, Any]:
    rows = [r for r in ((body.get("assembled_metrics") or {}).get("ratio_table") or {}).get("rows") or []
            if r.get("key") == KEY]
    assert len(rows) == 1, "the served ratio table carries %d %s rows" % (len(rows), KEY)
    return rows[0]


def build_fixture() -> Dict[str, Any]:
    books: List[Dict[str, Any]] = []
    for case_dir in ANCHOR.corpus_replay.discover_cases(ANCHOR.CORPUS):
        case_id = case_dir.name
        try:
            body = _analysed_body(case_id, case_dir)
        except Exception as exc:  # the offline write path refuses this input
            books.append({"case": case_id, "served": False, "refused": type(exc).__name__})
            continue
        pl = body["statements"].get("assembled_pl") or {}
        row = _row(body)
        entry: Dict[str, Any] = {
            "case": case_id,
            "served": True,
            "interest_expense": pl.get("interest_expense"),
            KEY: {
                "value": row.get("value"),
                "value_q": row.get("value_q"),
                "reason": (row.get("reason") or {}).get("code"),
            },
        }
        if row.get("value_q") is not None:
            entry["body"] = {
                "statements": body["statements"],
                "assembled_metrics": {"ratio_table": body["assembled_metrics"]["ratio_table"]},
                "metrics": body.get("metrics") or [],
            }
        books.append(entry)
    return {
        "_about": "interest-coverage-one-operand, popover half: every corpus case through the real "
                  "write path and GET /api/period (analysed body). Writer: "
                  "tests/engine/test_coverage_popover_corpus_fixture.py --write",
        "_kept": list(KEPT),
        "_trimmed": list(TRIMMED),
        "books": books,
    }


def _dump(obj: Dict[str, Any]) -> str:
    return json.dumps(obj, sort_keys=True, indent=1, ensure_ascii=False, allow_nan=False) + "\n"


def fixture_text() -> str:
    return _dump(build_fixture())


_TEXT: Dict[str, str] = {}


def _fresh() -> str:
    if "t" not in _TEXT:
        _TEXT["t"] = fixture_text()
    return _TEXT["t"]


def test_the_committed_popover_corpus_fixture_is_todays_served_corpus():
    assert FIXTURE.is_file(), "missing %s: run this file with --write" % FIXTURE
    committed = FIXTURE.read_text(encoding="utf-8")
    assert committed == _fresh(), (
        "coverage_popover_corpus.json drifted from what the engine serves for the corpus "
        "today; re-run with --write after an intended change and re-run the popover gate "
        "(interestCoveragePopover.test.tsx)")


def test_every_corpus_case_is_in_the_fixture_and_enough_carry_interest(capsys):
    doc = json.loads(_fresh())
    cases = [b["case"] for b in doc["books"]]
    want = [p.name for p in ANCHOR.corpus_replay.discover_cases(ANCHOR.CORPUS)]
    assert cases == want, "fixture cases %s, corpus cases %s" % (cases, want)
    measured = [b for b in doc["books"] if b.get("body")]
    for b in measured:
        assert b["interest_expense"] and b["interest_expense"] > 0, b["case"]
        assert b[KEY]["value_q"] is not None, b["case"]
    # every served book with interest carries a body, every other does not
    for b in doc["books"]:
        if b.get("served") and (b.get("interest_expense") or 0) > 0:
            assert b.get("body"), "%s carries interest but no body" % b["case"]
    with capsys.disabled():
        print("\nSCOPE coverage popover corpus fixture: cases %d; served %d; interest measured on %d (%s)"
              % (len(cases), sum(1 for b in doc["books"] if b.get("served")), len(measured),
                 ", ".join(b["case"] for b in measured)))
    assert len(measured) >= MEASURED_FLOOR, (
        "only %d corpus book(s) carry interest; the popover gate needs at least %d"
        % (len(measured), MEASURED_FLOOR))


if __name__ == "__main__":
    if "--write" in sys.argv:
        FIXTURE.write_text(fixture_text(), encoding="utf-8")
        print("wrote %s" % FIXTURE)
    else:
        committed = FIXTURE.read_text(encoding="utf-8") if FIXTURE.is_file() else ""
        print("OK" if committed == fixture_text() else "DRIFT %s" % FIXTURE)
