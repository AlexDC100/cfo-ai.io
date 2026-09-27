"""scripts/reprocess_periods_definition.py — the deploy's reprocessing of
stored periods under the ONE EBITDA (owner ruling 2026-09-26, design A9).

Runs over the tenancy double of test_workspace_v2_gates (every migration's
columns, tenant-guarded storage, the network closed, the Anthropic SDK a
stand-in, quota recorded): a REAL corpus book (corpus/saga_10_col_agras) is
uploaded and analysed by the real pipeline, then made to look like a period
persisted BEFORE the ruling (no stock-variation evidence, no definition
stamp, the pre-ruling `ebitda.reported`) — the shape every production
period has at deploy time.

WHAT THIS REDS ON (TC-11):
  · a dry run that writes anything;
  · a dry run that does not report anchor status, book state, net 711 and
    its provenance, old vs new EBITDA and the credit letter before/after;
  · an apply that does not leave the envelope carrying the evidence and the
    stamp, the metric rows on the one EBITDA, the council alerts and the
    briefing untouched;
  · an apply that is not idempotent (a second run rewrites);
  · any quota call; any model call; a document that needs the model being
    written; a period whose stored document now resolves to another month
    being written; a turnover move applied without a ruling.
"""
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path
from typing import Any, Dict

import pytest

import test_workspace_v2_gates as V
from test_workspace_v2_gates import app, gw  # noqa: F401 — pytest fixtures

REPO = Path(__file__).resolve().parents[2]
WORK = {"units": 0}


def _tool():
    spec = importlib.util.spec_from_file_location(
        "reprocess_periods_definition", str(REPO / "scripts" / "reprocess_periods_definition.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["reprocess_periods_definition"] = mod
    spec.loader.exec_module(mod)
    return mod


R = _tool()


@pytest.fixture()
def no_quota(monkeypatch):
    """Arms the guard AFTER the setup's own upload (which is metered, as
    production's is): from then on every quota entry point raises, so the
    tool provably never meters."""
    from engine.api import _usage_gate

    def _boom(*a: Any, **k: Any) -> Any:
        raise AssertionError("the reprocessing tool touched the quota")

    def arm() -> None:
        for name in ("reserve_document", "commit_document", "release_document",
                     "reserve_chat", "commit_chat", "release_chat"):
            if hasattr(_usage_gate, name):
                monkeypatch.setattr(_usage_gate, name, _boom)
    return arm


def _analysed_pre_ruling(app, gw) -> Dict[str, Any]:
    """Agras analysed by the real pipeline, then shaped like a period
    persisted before the ruling: the evidence block and the definition stamp
    removed, `ebitda.reported` the pre-ruling figure (without net 711)."""
    out = V.one_tap(app, V.agras_workbook(), "balanta.xlsx", on_screen=V.ORG_AGRAS)
    V.run_analysis(gw, out["commit"]["document_id"])
    (period,) = gw.db.rows("financial_periods")
    env = period["assembled_canonical_v1"]
    before = env["methodology"]["ebitda"]["reported"]
    env.pop("stock_variation")
    env["methodology"].pop("ebitda_definition")
    env["methodology"]["ebitda"]["reported"] = 10776378.24
    for m in gw.db.rows("calculated_metrics"):
        if m["name"] == "credit_composite":
            m["value"] = 79.9
    gw.db.add("alerts", {"org_id": period["org_id"], "period_id": period["id"],
                         "alert_key": "ai_council::summary", "severity": "info",
                         "category": "data_quality", "title": "council verdict",
                         "body": "pass", "payload": {"rule_key": "ai_council"}})
    briefings = gw.db.rows("briefings")
    assert briefings, "the analysis wrote a briefing row"
    return {"period": period, "ruled_ebitda": before}


def _tables(gw) -> Dict[str, Any]:
    """Every stored row. A table the double materialises empty on a READ is
    not a write, so empty tables are left out of the comparison."""
    return dict((t, copy.deepcopy(rows)) for t, rows in gw.db.tables.items() if rows)


def test_the_dry_run_reports_the_move_and_writes_nothing(app, gw, no_quota):
    world = _analysed_pre_ruling(app, gw)
    no_quota()
    pid = world["period"]["id"]
    snapshot = _tables(gw)
    (row,) = R.run(apply=False, period=pid)
    assert _tables(gw) == snapshot, "the dry run wrote"
    assert row["status"] == R.WOULD_REPROCESS, row
    a, b = row["after"], row["before"]
    assert a["anchor_status"] == "anchored", a
    assert a["book_state"] == "closed", a
    assert a["net_711"] == pytest.approx(1071687.03, abs=0.005)
    assert a["net_711_provenance"] == "account_121_bridge"
    assert a["net_72x"] == 0.0
    assert b["ebitda"] == pytest.approx(10776378.24, abs=0.005)
    assert a["ebitda"] == pytest.approx(11848065.27, abs=0.005) == pytest.approx(world["ruled_ebitda"])
    assert b["composite"] == 79.9 and b["letter"] and a["letter"] and a["composite"] is not None
    assert b["has_evidence"] is False and b["definition_current"] is False
    assert row["turnover_move"] is None, row
    text = R.render([row])
    for needle in ("anchor anchored", "book closed", "1,071,687.03", "account_121_bridge",
                   "EBITDA 10,776,378.24 -> 11,848,065.27", "credit 79.90"):
        assert needle in text, (needle, text)
    WORK["units"] += 12


def test_apply_rewrites_the_period_with_the_engines_stages_and_is_idempotent(app, gw, no_quota):
    world = _analysed_pre_ruling(app, gw)
    no_quota()
    pid = world["period"]["id"]
    briefing_before = copy.deepcopy(gw.db.rows("briefings"))
    (row,) = R.run(apply=True, period=pid)
    assert row["status"] == R.REPROCESSED, row
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == pid
    env = period["assembled_canonical_v1"]
    assert env["stock_variation"]["schema"] == "stock_variation/1"
    from engine.country_packs.ro_romania.chart_of_accounts import EBITDA_DEFINITION_REVISION
    assert env["methodology"]["ebitda_definition"] == EBITDA_DEFINITION_REVISION
    assert env["methodology"]["ebitda"]["reported"] == pytest.approx(11848065.27, abs=0.005)
    metrics = dict((m["name"], m["value"]) for m in gw.db.rows("calculated_metrics")
                   if m["period_id"] == pid)
    assert metrics["ebitda"] == pytest.approx(11848065.27, abs=0.005)
    assert metrics["credit_composite"] == row["after"]["composite"]
    keys = [a["alert_key"] for a in gw.db.rows("alerts") if a["period_id"] == pid]
    assert "ai_council::summary" in keys, keys          # carried over
    assert not [k for k in keys if k.startswith("earnings_quality_capitalized_own_work")]
    assert gw.db.rows("briefings") == briefing_before, "the briefing is never rewritten"
    # A second run changes nothing: the period is current.
    snapshot = _tables(gw)
    (again,) = R.run(apply=True, period=pid)
    assert again["status"] == R.CURRENT, again
    assert _tables(gw) == snapshot, "the second apply rewrote a current period"
    WORK["units"] += 10


def test_a_document_that_needs_the_model_is_refused_and_nothing_is_written(app, gw, no_quota):
    no_quota()
    doc = gw.db.add("documents", {
        "id": None, "org_id": V.ORG_AGRAS, "uploaded_by": V.USER,
        "storage_path": "%s/uploads/scan.png" % V.ORG_AGRAS, "original_filename": "scan.png",
        "mime_type": "image/png", "size_bytes": 4, "status": "analyzed"})
    gw.db.storage["documents/%s" % doc["storage_path"]] = b"\x89PNG"
    period = gw.db.add("financial_periods", {
        "id": None, "org_id": V.ORG_AGRAS, "source_document_id": doc["id"],
        "period_start": "2025-12-31", "period_end": "2025-12-31", "currency": "RON",
        "assembled_canonical_v1": None, "updated_at": "2026-02-01T00:00:00+00:00"})
    snapshot = _tables(gw)
    (row,) = R.run(apply=True, period=period["id"])
    assert (row["status"], row["reason"]) == (R.REFUSED, "needs_model"), row
    assert _tables(gw) == snapshot
    WORK["units"] += 2


def test_a_period_whose_document_now_resolves_to_another_month_is_refused(app, gw, no_quota):
    world = _analysed_pre_ruling(app, gw)
    no_quota()
    (period,) = gw.db.rows("financial_periods")
    period["period_end"] = "2025-11-30"
    snapshot = _tables(gw)
    (row,) = R.run(apply=True, period=world["period"]["id"])
    assert (row["status"], row["reason"]) == (R.REFUSED, "period_end_moved"), row
    assert row["resolved_end"] == "2025-12-31"
    assert _tables(gw) == snapshot
    WORK["units"] += 3


def test_a_turnover_move_blocks_the_apply_until_it_is_ruled(app, gw, no_quota, capsys):
    world = _analysed_pre_ruling(app, gw)
    no_quota()
    pid = world["period"]["id"]
    (period,) = gw.db.rows("financial_periods")
    # An older parser's turnover (the Carniprod 7c29a71b shape): the fresh
    # run reads a different one.
    period["assembled_canonical_v1"]["methodology"]["totals"]["revenue_net"] = 99_424_740.16
    snapshot = _tables(gw)
    assert R.main(["--apply", "--period", pid]) == 3
    assert _tables(gw) == snapshot, "a blocked apply wrote"
    assert "TURNOVER MOVED: no_filed_figure" in capsys.readouterr().out
    # Moving AWAY from a known filed figure still blocks …
    assert R.main(["--apply", "--period", pid, "--filed", "%s=99424740.16" % pid]) == 3
    assert _tables(gw) == snapshot
    # … moving TOWARD it is the ruled correction and applies.
    assert R.main(["--apply", "--period", pid, "--filed", "%s=110798309" % pid]) == 0
    (period,) = gw.db.rows("financial_periods")
    assert "stock_variation" in period["assembled_canonical_v1"]
    WORK["units"] += 4


def test_zz_scope(capsys):
    with capsys.disabled():
        print("\nSCOPE reprocess-periods-definition: corpus/saga_10_col_agras analysed by the "
              "real pipeline over the workspace-v2 tenancy double, shaped pre-ruling; "
              "GATE-WORK reprocess-periods-definition units=%d" % WORK["units"])
    assert WORK["units"] >= 31
