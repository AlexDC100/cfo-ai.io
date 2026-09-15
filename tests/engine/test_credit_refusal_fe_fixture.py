"""The served credit envelopes the FE credit-reader gate reads are the
route's own bytes, not a hand-written shape.

`frontend/lib/__tests__/fixtures/served_credit_refusals.json` feeds
`frontend/lib/__tests__/creditRefusedSubscores.test.tsx`, which asserts that
every credit surface (dashboard hero and Risks tab via the one reader,
/report's CreditScoreCard, the exported report, the workbook, the report
chart) prints the weight vector the composite used and no weight on a
refused row. A hand-written envelope is how the defect hid: no FE test held a
revision-2 envelope with a refusal, so the reader's `?? <model weight>`
stayed green while printing 30/33/25/17/17/10/8 (140%) beside a 97.5.

Cases (all over the committed corpus book `saga_compact_6_col`, which carries
no liabilities):
  compact_serve        GET /api/period, serve-time model (Altman + liquidity refused)
  compact_as_filed     the same route with the serve-time model unable to run,
                       persisted revision-2 rows -> `basis: as_filed`
  compact_ltd_only     the book's statements with long-term debt planted, so
                       only liquidity refuses (Altman scored), through
                       `serve_credit_envelope(credit_block(...))` — the route's
                       own builder
  compact_metrics_only the book's revision-2 `calculated_metrics` rows with NO
                       credit envelope (the CLAUDE.md §14 production shape)

WHAT THIS REDS ON (TC-11): the committed fixture differing from what the
route and the builder serve today (re-capture:
`CREDIT_FE_FIXTURE_WRITE=1 pytest tests/engine/test_credit_refusal_fe_fixture.py`,
in a named commit); a case losing the refusal it exists to carry.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any, Dict

import _served_books as SB
import test_rebuild_net_income_anchor as ANCHOR
from engine.ratios import credit_model as CM

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "frontend" / "lib" / "__tests__" / "fixtures" / "served_credit_refusals.json"
_CREDIT_ROWS = ("credit_", "altman_")


def _credit_rows(rows):
    return [{"name": r["name"], "value": r["value"]} for r in rows if r["name"].startswith(_CREDIT_ROWS)]


def _capture(monkeypatch) -> Dict[str, Any]:
    bk = ANCHOR._Book(REPO / "corpus" / "saga_compact_6_col")
    body = SB.routed_body(bk)
    out: Dict[str, Any] = {
        "compact_serve": {"credit": body["assembled_metrics"]["credit"],
                          "metrics": _credit_rows(body["metrics"])},
    }
    statements = body["statements"]
    persisted = CM.compute_period_metrics(copy.deepcopy(statements))
    out["compact_metrics_only"] = {"credit": None, "metrics": _credit_rows(persisted)}
    # The served statements every case renders beside its credit envelope
    # (the exported report and the workbook take them; on the engine credit
    # path they decide nothing about the letter, the weights or the rows).
    out["statements"] = statements
    ltd = copy.deepcopy(statements)
    ltd["balanceSheet"]["longTermDebt"] = 1000.0
    rows = CM.compute_period_metrics(ltd)
    out["compact_ltd_only"] = {"credit": CM.serve_credit_envelope(CM.credit_block(rows)),
                               "metrics": _credit_rows(rows)}

    import engine.ratios.table as T

    def _cannot_run(_statements):
        raise RuntimeError("planted: the serve-time model cannot run on these statements")

    with monkeypatch.context() as mp:
        mp.setattr(T, "serve_time_metric_rows", _cannot_run)
        filed = SB.routed_body(bk, metrics=persisted)
    out["compact_as_filed"] = {"credit": filed["assembled_metrics"]["credit"],
                               "metrics": _credit_rows(filed["metrics"])}
    return json.loads(json.dumps(out, sort_keys=True))


def test_the_fe_credit_fixture_is_what_the_route_serves_today(monkeypatch):
    got = _capture(monkeypatch)
    assert set(got["compact_serve"]["credit"]["refused_subscores"]) == {"altman", "liquidity"}
    assert set(got["compact_ltd_only"]["credit"]["refused_subscores"]) == {"liquidity"}
    assert got["compact_as_filed"]["credit"]["basis"] == "as_filed"
    assert {r["name"]: r["value"] for r in got["compact_metrics_only"]["metrics"]}[
        CM.CREDIT_MODEL_REVISION_METRIC] == CM.CREDIT_MODEL_REVISION
    assert set(got["compact_as_filed"]["credit"]["refused_subscores"]) == {"altman", "liquidity"}
    text = json.dumps(got, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    if os.environ.get("CREDIT_FE_FIXTURE_WRITE") == "1":
        FIXTURE.write_text(text, encoding="utf-8")
    assert FIXTURE.exists(), "no committed fixture at %s" % FIXTURE
    assert FIXTURE.read_text(encoding="utf-8") == text, (
        "the committed FE credit fixture is stale against the route; re-capture with "
        "CREDIT_FE_FIXTURE_WRITE=1 in a named commit")
