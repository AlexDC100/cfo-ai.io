"""The served credit envelopes the FE stock-build-regime gate reads are the
route's own bytes, not a hand-written shape (credit model revision 5, owner
ruling R1, 2026-09-28).

`frontend/lib/__tests__/fixtures/served_credit_regime.json` feeds
`frontend/lib/__tests__/creditRegimeSurfaces.test.tsx`, which asserts that
every surface that prints the grade (the Risks tab, the dashboard hero,
/report's CreditScoreCard, the command bar's line) prints the regime ONCE,
with the owner's sentence, the served figures and the regime's weights — and
nothing on a book under the standard model.

Cases (committed corpus books, the production write path + GET /api/period):
  developer                the corpus developer (`saga_10_col_realestate`):
                           the regime, its cash flow approximated, so the
                           cash components and the composite refuse
  developer_measured_cash  the same statements with the cash flow stated as
                           MEASURED (`is_approximated: false`, the served
                           −3,945,493.79 unchanged) through the route's own
                           builder: the declared bottom rung on the three
                           cash components, a composite on the regime's
                           weights and a letter
  manufacturer             agras — no regime
  attention_developer      the attention document composed over the
                           developer's served body (its `credit_regime`)

WHAT THIS REDS ON (TC-11): the committed fixture differing from what the
route and the builder serve today (re-capture:
`CREDIT_REGIME_FE_FIXTURE_WRITE=1 pytest tests/engine/test_credit_regime_fe_fixture.py`,
in a named commit); a case losing the state it exists to carry.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any, Dict

import _served_books as SB
from engine.attention.now import compose_attention
from engine.ratios import credit_model as CM

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "frontend" / "lib" / "__tests__" / "fixtures" / "served_credit_regime.json"
_CREDIT_ROWS = ("credit_", "altman_")


def _credit_rows(rows):
    return [{"name": r["name"], "value": r["value"]} for r in rows if r["name"].startswith(_CREDIT_ROWS)]


def _capture() -> Dict[str, Any]:
    dev = SB.served_body("realestate")
    man = SB.served_body("agras")
    measured = copy.deepcopy(dev["statements"])
    measured["assembled_cf"]["is_approximated"] = False
    rows = CM.compute_period_metrics(copy.deepcopy(measured))
    doc = compose_attention(dev, prior={"rule": "same_length", "status": "absent", "period_id": None})
    return {
        "developer": {"credit": dev["assembled_metrics"]["credit"], "metrics": _credit_rows(dev["metrics"]),
                      "statements": dev["statements"]},
        "developer_measured_cash": {
            "credit": CM.serve_credit_envelope(CM.credit_block(rows, statements=measured)),
            "metrics": _credit_rows(rows)},
        "manufacturer": {"credit": man["assembled_metrics"]["credit"], "metrics": _credit_rows(man["metrics"]),
                         "statements": man["statements"]},
        "attention_developer": {"credit_regime": doc["credit_regime"],
                                "currency": (doc.get("period") or {}).get("currency")},
    }


def _dump(obj: Any) -> str:
    return json.dumps(obj, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def test_the_fe_regime_fixture_is_what_the_route_serves_today():
    got = _dump(_capture())
    if os.environ.get("CREDIT_REGIME_FE_FIXTURE_WRITE") == "1":
        FIXTURE.write_text(got, encoding="utf-8")
    assert FIXTURE.exists(), "no committed fixture; capture with CREDIT_REGIME_FE_FIXTURE_WRITE=1"
    assert FIXTURE.read_text(encoding="utf-8") == got, (
        "the committed FE regime fixture is stale against the route; re-capture with "
        "CREDIT_REGIME_FE_FIXTURE_WRITE=1 in a named commit")


def test_each_case_carries_the_state_it_exists_for():
    cap = json.loads(FIXTURE.read_text(encoding="utf-8"))
    dev = cap["developer"]["credit"]
    assert dev["regime"]["code"] == "stock_build" and dev["regime"]["cash"]["status"] == "approximated"
    assert dev["composite_score"] is None and dev["letter_grade"] is None
    assert set(dev["refused_subscores"]) == {"leverage", "coverage", "dscr"}
    meas = cap["developer_measured_cash"]["credit"]
    assert meas["regime"]["cash"]["status"] == "measured" and meas["composite_score"] is not None
    assert {k for k, v in (meas["declared_rungs"] or {}).items()
            if v["rung"] == "cash_from_operations_not_positive"} == {"leverage", "coverage", "dscr"}
    assert cap["manufacturer"]["credit"]["regime"] is None
    assert cap["attention_developer"]["credit_regime"] == dev["regime"]
