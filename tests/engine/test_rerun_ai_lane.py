"""A RE-RUN THROUGH THE AI LANE KEEPS WHAT THE LANE NEVER WRITES — gate `rerun-data-loss`, stage 3.

THE DEFECT (hand-over 2026-10-04, item 3). A non-Romanian document is
analysed by the AI lane, which stores the STATEMENTS and nothing else: no
briefing, no recommendations, no alerts. Its exit returned `analyzed` right
after the persist and never reached the narrative stage. So:

  · the Docs panel's "Re-run analysis" reset the document's period first —
    the cascade took the briefing its user had GENERATED for it (an explicit,
    metered request) — and nothing put it back;
  · once the re-run was staged (stage 2) the takeover was still called with
    no arguments: it replaced the month's ALERTS with none, and stamped a
    kept briefing with a narration failure (`empty_reply`) that never
    happened;
  · with the month's row left in place, the lane's own cache — which IS that
    row — answered the re-run of an unchanged file: a silent no-op;
  · a re-run of a document that now reads as a PUBLIC-RECORDS summary ended
    "analysed with no period", over a month that still named it.

THE ORDER NOW. The same staged re-run as every other document's
(`test_rerun_staged`), through the same takeover — told what the lane is:
it narrated nothing, so the month's briefing is kept and marked
`not_renarrated` (not a narration code), and its recommendations and alerts
stay where they are. A staged re-run tells the extract stage to RE-EXTRACT.
A re-run that reads as a public-records summary is refused before any write.

THE LAW.
  A1  A Docs-panel re-run that goes through the lane: ONE period, the same
      id, the run's statements; the SAME briefing row (stale,
      `not_renarrated`), the SAME recommendation rows (what a user set on
      them), the SAME alert rows; the document never re-statused. Both
      states of the stale migration.
  ·   The same takeover at its own seam, killed after EVERY write: dropped
      before the commit point, resumed to the uninterrupted result after it
      (the kept briefing marked with the reason the marker recorded).
  A2  Only a STAGED re-run tells the extract stage to re-extract — never a
      first analysis, an upload, or a retry of a document with no period —
      and the flag is never stored. Through the REAL lane (its model
      scripted): the cache is live (control), the re-run calls the model
      again, the non-Romanian meter is not touched, the generated briefing
      is kept. And with the lane's model REFUSING — production's state on
      2026-10-04 — the re-run changes nothing: before, its reset had already
      deleted the month.
  A3  A staged re-run that now reads as a public-records summary is refused
      before any write (`rerun_failed: rerun_not_a_trial_balance`); the
      month is exactly what it was. A first upload of such a file — and a
      retry of a document that holds no period — is what it always was.
  A4  A same-month re-UPLOAD through the lane keeps the month's alerts,
      recommendations and briefing (stale) the same way.
  A5  The workspace's plan refuses the re-run: the lane is never reached,
      the month and its briefing are exactly what they were, the row carries
      the neutral code and no plan's name.
  A6  A REAL restart (a second process, `rerun_restart_lib`) of a re-run of
      a non-Romanian document, the real lane on both sides: killed before
      the commit point the reader is served what they were served; killed
      inside the takeover it is completed by the document's next re-run, or
      by another document's run fifteen minutes later — and the generated
      briefing is there, marked.

WHAT RUNS HERE. The `gw` world (real routes, real `_run_pipeline_sync`, the
PostgREST double) with the helpers of the other files of this gate. The lane
is reached in two ways, both through the REAL `stage_extract`, its REAL
jurisdiction gate and the REAL plan gate:
  · "the first run's statements, handed back by the lane": a Romanian book
    analysed normally, whose NEXT run the resolver routes to the lane (what a
    jurisdiction override on the balance-sheet badge does) — `run_ai_lane`
    itself replaced by a stand-in that returns the first run's own parse and
    assembly as the lane's payload. This is the month that HAS alerts and
    recommendations for the lane to lose;
  · THE REAL LANE: the Hungarian fixture ledger uploaded on the card, read by
    `engine.ai_lane.run_ai_lane` itself — format detection, extraction,
    classification, the cache — with only its MODEL scripted (the canned
    replies of tests/engine/test_ai_lane.py).

THE EXPECTED VALUES ARE WRITTEN OUT HERE (`not_renarrated`,
`rerun_not_a_trial_balance`, the stored refusal), never read from the code
under test.

WHAT THESE RED ON, with the defect repaired (TC-11):
  · the lane's takeover replacing the month's alerts, recommendations or
    briefing with none; a kept briefing marked with a narration code;
  · a staged re-run answered from the lane's cache (no model call, nothing
    replaced), or the re-extract flag reaching a first analysis, an upload,
    the store, or the journal's copy of the row;
  · a re-run reserving on the non-Romanian meter;
  · a staged re-run ending "analysed with no period" (the public-records
    exit), or writing its summary before it is refused;
  · a plan refusal that marks the document failed, touches the month, or
    stores a plan's name;
  · a lane takeover dropped after its commit point, or resumed without
    marking the kept briefing.

CANNOT SEE.
  · The lane's MODEL: its replies are canned; what a real extraction of a
    changed file returns, and what a model call costs.
  · The plan METER (`reserve_nonro_document` and its RPCs): replaced by a
    recorder; the WORKSPACE plan read of a re-run is real.
  · `keep_recommendations` on its own: the lane stores no briefing, which
    already keeps the month's recommendations — the argument is belt and
    braces and is pinned by a census of the call, not by behaviour.
  · The month's METRICS and VALUATION after a lane takeover: the lane
    computes neither, and what was computed from the replaced statements
    goes with them (asserted: never one run's statements beside another's
    figures). A month first analysed as Romanian and re-run through the lane
    therefore loses its ratios — the lane's stated contract, not kept.
  · POST /api/period/{id}/reextract (the jurisdiction badge's own entry): it
    re-runs IN PLACE, not staged — not this gate's entry.
  · Everything `test_rerun_staged` / `test_rerun_restart` cannot see
    (Postgres itself, two live processes, the window after a commit point).

PLANT LOG: docs/engine_book/gates.md "rerun-data-loss".
"""
from __future__ import annotations

import ast
import copy
import json
from typing import Any, Callable, Dict, List, Tuple

import pytest

import _real_app_comparatives as RA
import rerun_restart_lib as R
import test_ai_lane as LANE
import test_briefing_keep_last_good_writers as W
import test_rerun_ownership as O
import test_rerun_staged as S
import test_workspace_v2_gates as V
from test_workspace_v2_gates import app, gw  # noqa: F401 — pytest fixtures
from engine import ai_lane as AL
from engine.ai_lane import config as lane_config
from engine.api import _usage_gate
from engine.api import pipeline as P

# ── THE EXPECTED VALUES, stated here — never read from the code under test ──

MARKER_KEY = "staged_rerun"
#: `briefings.stale_reason` of a briefing kept across a run that narrates nothing.
NOT_RENARRATED = "not_renarrated"
#: The neutral codes a narration failure stores — the reason above is none of them.
NARRATION_CODES = ("no_api_key", "sdk_missing", "provider_error", "unparseable_reply", "empty_reply",
                   "withheld_numerals")
INTERRUPTED = "rerun_failed: interrupted_replacing"
#: `documents.error` of a staged re-run that now reads as a public-records summary.
NOT_A_TRIAL_BALANCE = "rerun_failed: rerun_not_a_trial_balance"
#: … and of one the workspace's plan refused (the neutral code, nothing of the plan).
PLAN_REFUSED = 'rerun_failed: NonRoNotIncludedError: {"error": "non_ro_not_included"}'

#: What the jurisdiction resolver answers for a document its user set to
#: Hungarian on the balance-sheet badge.
HU_RESOLUTION = {"jurisdiction": "HU", "source": "user", "confidence": 1.0}

HU_NAME = "hu_szamlatukor_tb_2025.csv"
#: The briefing a user GENERATED for a non-Romanian month (invented prose).
GENERATED_BODY = ("The generated briefing: equity covers the fixed assets, payables are short and "
                  "the cash at bank is ample for the quarter.")


# ══════════════════════════════════════════════════════════════════════
# The worlds
# ══════════════════════════════════════════════════════════════════════


def _capture_the_first_runs_statements(monkeypatch) -> Dict[str, Any]:
    """The parse and the assembly of the FIRST run — what the lane's stand-in
    hands back as its payload for the runs that follow."""
    captured = {}  # type: Dict[str, Any]
    real_map = P.stage_map

    def stage_map(doc: Dict[str, Any], parsed: Dict[str, Any], industry: Any) -> Dict[str, Any]:
        out = real_map(doc, parsed, industry)
        captured.setdefault("parsed", copy.deepcopy(parsed))
        captured.setdefault("assembled", copy.deepcopy(out))
        return out

    monkeypatch.setattr(P, "stage_map", stage_map)
    return captured


def _the_plan_includes_non_romanian_documents(gw) -> None:
    """The workspace's OWNER is on the plan that includes them — the row the
    REAL plan gate of a re-run reads (`_usage_gate.workspace_nonro_refusal`)."""
    gw.db.add("subscriptions", {"user_id": V.USER, "tier": "multi", "status": "active"})


def _the_non_romanian_meter(monkeypatch) -> List[Tuple[str, str]]:
    """The non-Romanian METER, recorded (its RPCs are not in the double): a
    first analysis reserves and commits one unit; a re-run of a counted book
    must touch nothing here."""
    calls = []  # type: List[Tuple[str, str]]

    def reserve(user_id: str) -> Any:
        calls.append(("reserve", user_id))
        return _usage_gate.NonRoReserveDecision(
            kind="allowed", plan_key="multi", used=1, cap=5, extra_nonro_doc_eur=None,
            was_extra=False, refusal=None, message="")

    monkeypatch.setattr(_usage_gate, "reserve_nonro_document", reserve)
    monkeypatch.setattr(_usage_gate, "commit_nonro_document",
                        lambda uid, was_extra=False, month=None: calls.append(("commit", uid)))
    monkeypatch.setattr(_usage_gate, "release_nonro_document",
                        lambda uid, was_extra=False, month=None: calls.append(("release", uid)))
    return calls


def _route_the_next_runs_through_the_lane(monkeypatch, captured: Dict[str, Any]) -> List[Dict[str, Any]]:
    """From here on the resolver answers HU and the lane hands back the first
    run's own statements as its payload — through the REAL `stage_extract`,
    its jurisdiction gate and the plan gate. Returns what the lane was
    handed, run by run."""
    handed = []  # type: List[Dict[str, Any]]
    monkeypatch.setattr(AL, "resolve_jurisdiction",
                        lambda doc, file_bytes, user_choice=None: dict(HU_RESOLUTION))

    def run_ai_lane(*, doc: Dict[str, Any], file_bytes: bytes, kind: str, resolution: Dict[str, Any],
                    client_factory: Any = None, admin_factory: Any = None) -> Dict[str, Any]:
        handed.append({"document_id": doc.get("id"), "force_reextract": doc.get("force_reextract"),
                       "kind": kind})
        return dict(copy.deepcopy(captured["parsed"]), detected_type=AL.AI_LANE_DETECTED_TYPE, accounts=[],
                    ai_lane={"cached": False, "jurisdiction": "HU", "resolution": dict(resolution),
                             "content_hash": AL.content_hash_of(file_bytes),
                             "assembled": copy.deepcopy(captured["assembled"])})

    monkeypatch.setattr(AL, "run_ai_lane", run_ai_lane)
    return handed


def _a_month_whose_next_run_is_the_lanes(app, gw, monkeypatch, *, entitled: bool = True,
                                         outcomes: Any = ()) -> Dict[str, Any]:
    """Agras's December analysed normally — a briefing (BODY_A), its
    recommendations (one worked by a user), its deterministic alerts, its
    metrics — and then set to another jurisdiction: every later run of the
    company goes through the lane."""
    captured = _capture_the_first_runs_statements(monkeypatch)
    w = O._own_month(app, gw, monkeypatch, list(outcomes))
    if entitled:
        _the_plan_includes_non_romanian_documents(gw)
    w["handed"] = _route_the_next_runs_through_the_lane(monkeypatch, captured)
    w["alerts"] = copy.deepcopy(gw.db.rows("alerts"))
    (w["briefing"],) = copy.deepcopy(gw.db.rows("briefings"))
    assert w["alerts"] and w["recommendations"], "the month holds nothing for the lane to lose"
    return w


def _a_non_romanian_month(app, gw, monkeypatch) -> Dict[str, Any]:
    """THE REAL LANE. A Hungarian ledger uploaded on the card into a company
    whose owner's plan includes non-Romanian documents, analysed by
    `engine.ai_lane.run_ai_lane` itself (its model scripted) — and then the
    briefing its user GENERATED for the month: the row the regenerate route
    stores, written as that route writes it."""
    O._production_foreign_keys(gw, monkeypatch)
    _the_plan_includes_non_romanian_documents(gw)
    meter = _the_non_romanian_meter(monkeypatch)
    clients = R.scripted_lane_model(monkeypatch)
    committed = V.commit(app, LANE.HU_BYTES, HU_NAME, mime="text/csv", target_org_id=V.ORG_AGRAS,
                         period_end="2025-12-31", output_language="en")
    assert committed.status_code == 200 and committed.json()["status"] == "queued", committed.text[:300]
    doc = V.run_analysis(gw, committed.json()["document_id"])
    assert (doc["status"], doc["error"]) == ("analyzed", None), (doc["status"], doc["error"])
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == doc["period_id"] and period["source_document_id"] == doc["id"], period
    assert period["assembled_canonical_v1"]["ai_audit"]["content_hash"] == AL.content_hash_of(LANE.HU_BYTES)
    assert [len(c.messages.calls) for c in clients] == [3], "the first analysis did not go through the lane"
    assert meter == [("reserve", V.USER), ("commit", V.USER)], meter
    # The lane stored the statements and nothing else.
    assert gw.db.rows("statement_line_items") and not gw.db.rows("briefings") and not gw.db.rows("alerts")
    gw.db.upsert("briefings", {
        "period_id": period["id"], "org_id": doc["org_id"], "body": GENERATED_BODY, "language": "en",
        "model": "the-model-of-the-generate-request", "ebitda_definition": W.CURRENT_DEFINITION},
        on_conflict="period_id", returning=False)
    return {"org": doc["org_id"], "doc1": doc["id"], "month": period["id"], "clients": clients, "meter": meter}


def _line_item_ids(gw, period_id: str) -> List[str]:
    return S._rows_by_id(gw, "statement_line_items", period_id)


# ══════════════════════════════════════════════════════════════════════
# The reason, the code, and the call
# ══════════════════════════════════════════════════════════════════════


def test_the_reason_of_a_run_that_narrates_nothing_is_not_a_narration_code():
    """`not_renarrated` says "no narration was attempted" — it must never be
    one of the codes a FAILED narration stores (the card would say the
    provider failed), never be returned by the predicate that decides whether
    a narration is usable, and never make a kept briefing read as
    unavailable: it is served as prose, marked stale."""
    assert P.BRIEFING_STALE_NOT_RENARRATED == NOT_RENARRATED
    assert tuple(P.NARRATION_UNAVAILABLE_CODES) == NARRATION_CODES and NOT_RENARRATED not in NARRATION_CODES
    assert NOT_RENARRATED != P.BRIEFING_STALE_WRITE_REFUSED
    for narration in ({"unavailable": NOT_RENARRATED, "briefing": ""}, {"unavailable": "anything else"},
                      {"briefing": ""}, None):
        assert P.narration_unavailable_code(narration) in NARRATION_CODES, narration
    served = P.served_briefing({"body": GENERATED_BODY, "language": "en", "model": "m",
                                "stale_since": "2026-10-04T10:00:00+00:00", "stale_reason": NOT_RENARRATED})
    assert (served["body"], served["unavailable"], served["unavailable_reason"]) == (GENERATED_BODY, False, None)
    assert served["stale"] == {"since": "2026-10-04T10:00:00+00:00", "reason": NOT_RENARRATED}
    # … and the code a refused public-records re-run stores.
    assert P.RERUN_FAILED_PREFIX + P.RERUN_NOT_A_TRIAL_BALANCE == NOT_A_TRIAL_BALANCE


def test_census_the_lanes_takeover_is_told_what_the_lane_is():
    """STRUCTURAL (the one law here that reads the source): the orchestrator
    calls the takeover in two places — the lane's exit and the end of a
    narrated run — and the lane's call names all three arguments. Two of them
    are observable (A1, A4: the alerts, the stale reason); `keep_
    recommendations` is not on its own — a run that stores no briefing
    already keeps the month's recommendations — so it is pinned here.
    THE ALERTS ARE KEPT ONLY ACROSS A RE-RUN OF THE SAME DOCUMENT (`staged_of`
    — the id of the document's own month, None for every other run): a
    same-month re-upload is another FILE, and the archived file's alerts
    never stay on its statements (A4)."""
    tree = ast.parse((O.ENGINE_SRC / "api" / "pipeline.py").read_text(encoding="utf-8"))
    (stages,) = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_run_pipeline_stages"]
    calls = [dict((k.arg, ast.unparse(k.value)) for k in n.keywords) for n in ast.walk(stages)
             if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
             and n.func.id == "_finalize_same_month_takeover"]
    assert len(calls) == 2, calls
    assert {"narration_unavailable": "BRIEFING_STALE_NOT_RENARRATED", "keep_recommendations": "True",
            "keep_alerts": "staged_of is not None"} in calls, calls


# ══════════════════════════════════════════════════════════════════════
# A1 — a Docs-panel re-run through the lane
# ══════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("migration", W._MIGRATION_STATES)
def test_a_docs_panel_rerun_through_the_ai_lane_keeps_the_months_briefing_recommendations_and_alerts(
        app, gw, monkeypatch, migration):
    """A1. The month has a briefing, recommendations a user worked, and
    alerts. Its document's re-run goes through the lane — which writes none
    of the three. The run's STATEMENTS replace the month's, on the same
    period id; the briefing is the same row, marked `not_renarrated`; the
    recommendations and the alerts are the same rows. (Before: the reset
    cascaded all three away and nothing put them back; staged with no
    arguments, the takeover deleted the alerts — measured 4 → 0 — and
    stamped the briefing `empty_reply`, a narration failure that never
    happened.)"""
    applied = migration == "stale_migration_applied"
    if not applied:
        W._before_the_stale_migration(gw)
    w = _a_month_whose_next_run_is_the_lanes(app, gw, monkeypatch)
    line_items_before = _line_item_ids(gw, w["month"])
    metrics_before = S._rows_by_id(gw, "calculated_metrics", w["month"])
    assert line_items_before and metrics_before
    statuses = S._watch_statuses(monkeypatch)
    spy = W._Spy(gw.db, monkeypatch)

    r = O._retry(app, w["org"], w["doc1"])
    assert r.status_code == 202 and r.json()["status"] == "queued", (r.status_code, r.text[:300])
    rerun = V.run_analysis(gw, w["doc1"])

    assert (rerun["status"], rerun["error"], rerun["period_id"]) == ("analyzed", None, w["month"]), rerun
    # THE RUN WENT THROUGH THE LANE, re-extracting — and narrated nothing.
    assert w["handed"] == [{"document_id": w["doc1"], "force_reextract": True, "kind": "xlsx"}], w["handed"]
    assert len(W._ScriptedProvider.narrate_requests) == 1, "the lane's run reached the narrator"
    # The document was never re-statused (the lane's own progress write included).
    assert statuses == ["analyzed"], "the staged re-run wrote statuses %r" % statuses
    # ONE PERIOD, THE SAME ID — staged beside it, then taken over.
    (staged,) = S._staged_ids(spy)
    assert staged != w["month"]
    W._assert_one_period_and_nothing_beside_it(gw, w["month"], w["doc1"])
    # THE STATEMENTS ARE THE RUN'S …
    line_items = _line_item_ids(gw, w["month"])
    assert len(line_items) == len(line_items_before) and not set(line_items) & set(line_items_before)
    # … and nothing computed from the REPLACED statements stays beside them
    # (the lane computes no metrics: never one run's statements beside
    # another's figures).
    assert not set(S._rows_by_id(gw, "calculated_metrics", w["month"])) & set(metrics_before)
    # THE BRIEFING: the same row, marked — with a reason that is not a narration code.
    (briefing,) = gw.db.rows("briefings")
    if applied:
        assert W._sans_marker(briefing) == W._sans_marker(w["briefing"]), briefing
        assert briefing["stale_reason"] == NOT_RENARRATED and W._is_a_timestamp(briefing["stale_since"]), briefing
    else:
        assert briefing == w["briefing"], "before the migration, the re-run changed the stored briefing"
    (marker,) = W._marker_updates(spy)
    assert marker["payload"]["stale_reason"] == NOT_RENARRATED and marker["refused"] is (not applied), marker
    assert marker["filters"] == {"period_id": "eq.%s" % w["month"], "org_id": "eq.%s" % w["org"]}
    # THE RECOMMENDATIONS (what a user set on them) AND THE ALERTS: the same rows.
    assert gw.db.rows("recommendations") == w["recommendations"], "the lane's re-run cost the recommendations"
    assert gw.db.rows("alerts") == w["alerts"], (
        "the lane's re-run replaced the month's alerts with %d" % len(gw.db.rows("alerts")))
    # … and NOTHING of the month was written in those three tables but the marker.
    for table in ("briefings", "recommendations", "alerts"):
        on_the_month = [(x["op"], sorted(x["payload"] or {})) for x in spy.writes
                        if x["table"] == table and O._names_the_period(x, w["month"])]
        assert on_the_month == ([("update", sorted(marker["payload"]))] if table == "briefings" else []), (
            table, on_the_month)
    # WHAT THE READER IS SERVED.
    body = W._served_period(app, w["org"], w["month"])
    assert (body["briefing"]["body"], body["briefing"]["unavailable"], body["briefing"]["unavailable_reason"]) == (
        W.BODY_A, False, None), body["briefing"]
    if applied:
        assert body["briefing"]["stale"] == {"since": briefing["stale_since"], "reason": NOT_RENARRATED}
    assert sorted(x["title"] for x in body["recommendations"]) == W.TITLES_A
    assert [x["status"] for x in body["recommendations"] if x["title"] == w["worked_title"]] == ["in_review"]
    assert sorted(a["alert_key"] for a in body["alerts"]) == w["alert_keys"]
    assert P._STAGED_RERUNS == {}


# ── the same takeover at its own seam, killed after every write ───────

#: What the orchestrator tells the takeover for a run of the lane.
_LANE_TAKEOVER = dict(narration_unavailable=NOT_RENARRATED, keep_recommendations=True, keep_alerts=True)


def _lane_seam_world() -> S._KillingDouble:
    """`test_rerun_staged`'s month — line items, metrics, a valuation, two
    alerts, its briefing, two worked recommendations, a cached benchmark
    report — and beside it the staged row of a re-run THROUGH THE LANE: its
    statements and nothing else."""
    double = S._seam_world("the_narration_worked")
    for table in ("calculated_metrics", "valuations", "alerts", "briefings", "recommendations"):
        double.delete(table, filters={"period_id": "eq.%s" % S.STAGED})
    double.writes[:] = []
    return double


def _lane_takeover(double: S._KillingDouble) -> str:
    P._record_takeover(S.DOC_ID, staged=S.STAGED, served=S.PID, superseded_document=None, rerun=True)
    try:
        with RA.installed(double):
            return P._finalize_same_month_takeover({"id": S.DOC_ID, "org_id": S.ORG}, S.STAGED,
                                                   **_LANE_TAKEOVER)
    finally:
        P._pop_takeover(S.DOC_ID)


def test_a_lane_takeover_killed_after_any_write_is_dropped_or_resumed_to_the_same_result():
    """THE SAME MECHANISM (R3). The lane's takeover has the staged re-run's
    commit point: killed before it, the staged row is dropped and the month
    is what it was; killed after it — between a table's delete and its move,
    before the row's columns, before the document's write — the cleanup
    RESUMES it to exactly what the uninterrupted takeover stores: the run's
    statements, the tables the lane stores nothing in emptied, the month's
    alerts and recommendations never touched, its briefing marked
    `not_renarrated` (the reason the commit marker recorded — a resume has no
    orchestrator to ask)."""
    before = S._state(_lane_seam_world())
    whole = _lane_seam_world()
    assert _lane_takeover(whole) == S.PID
    expected, commit, total = S._state(whole), S._commit_index(whole), len(whole.writes)

    # THE UNINTERRUPTED RESULT.
    own = lambda table: [r for r in expected[table] if r.get("org_id") == S.ORG]   # noqa: E731
    assert sorted(r["id"] for r in expected["statement_line_items"]) == ["li-rerun-0", "li-rerun-1", "li-rerun-2"]
    assert own("calculated_metrics") == [] and own("valuations") == []
    assert own("alerts") == [r for r in before["alerts"] if r["period_id"] == S.PID] and len(own("alerts")) == 2
    assert own("recommendations") == [r for r in before["recommendations"] if r["period_id"] == S.PID]
    (kept,) = own("briefings")
    assert kept["id"] == "briefing-of-the-month" and kept["stale_reason"] == NOT_RENARRATED and \
        kept["stale_since"] == "<set>", kept
    assert W._sans_marker(kept) == W._sans_marker(
        [b for b in before["briefings"] if b["id"] == "briefing-of-the-month"][0])
    assert [p["id"] for p in expected["financial_periods"] if p["org_id"] == S.ORG] == [S.PID]
    assert expected["documents"] == [dict(before["documents"][0], period_id=S.PID, status="analyzed", error=None)]
    # THE COMMIT MARKER: why the kept briefing is stale, and the tables the lane stored nothing in.
    marker = whole.writes[commit - 1]["payload"]["assembled_canonical_v1"][MARKER_KEY]
    assert marker["keep_briefing_reason"] == NOT_RENARRATED, marker
    assert marker["emptied"] == ["calculated_metrics", "valuations"], marker
    # The month's briefing, recommendations and alerts: one write among them — the marker.
    kept_tables = [(w["op"], w["table"]) for w in whole.writes
                   if w["table"] in ("briefings", "recommendations", "alerts") and S._names_the_month(w)]
    assert kept_tables == [("update", "briefings")], kept_tables
    assert total - commit >= 8, "the scenario is too short to mean anything"

    month_before = S._month_of(before)
    for k in range(1, total):
        double = _lane_seam_world()
        double.arm(k)
        with pytest.raises(S._Kill):
            _lane_takeover(double)
        double.arm(None)

        out = P._clear_staged_rerun_rows(double, S.ORG, document_id=S.DOC_ID)

        if k < commit:
            assert (out["resumed"], out["dropped"], out["left"]) == (0, 1, 0), (k, out)
            state = S._state(double)
            assert S._month_of(state) == month_before, "killed after write #%d: the month was touched" % k
            assert [p["id"] for p in state["financial_periods"] if p["org_id"] == S.ORG] == [S.PID], k
        else:
            assert (out["resumed"], out["dropped"], out["left"]) == (1, 0, 0), (k, out)
            assert S._state(double) == expected, (
                "killed after write #%d of %d (%s): the resume did not reach the uninterrupted "
                "takeover's result" % (k, total, whole.writes[k - 1]["table"]))


# ══════════════════════════════════════════════════════════════════════
# A2 — "Re-run analysis" re-extracts
# ══════════════════════════════════════════════════════════════════════


def test_only_a_staged_rerun_tells_the_extract_stage_to_re_extract_and_the_flag_is_never_stored(
        app, gw, monkeypatch):
    """A2. The lane's cache is the period row. The reset used to delete that
    row, which is what made a re-run re-extract; a staged re-run leaves it —
    so the run itself says "re-extract" (the lane's own switch, on the
    in-memory row). Only a STAGED re-run: a first analysis, a same-month
    re-upload and a retry of a document that holds no period are handed the
    row as it is stored. The flag is never written anywhere, and the
    journal's copy of the row (taken when the run starts) never carries it."""
    seen = []  # type: List[Tuple[str, Any]]
    journalled = []  # type: List[Tuple[str, bool]]
    real_extract, real_started = P.stage_extract, P._journal_hooks.on_run_started

    def stage_extract(doc: Dict[str, Any]) -> Dict[str, Any]:
        seen.append((str(doc["id"]), doc.get("force_reextract")))
        return real_extract(doc)

    def on_run_started(doc: Dict[str, Any], **kwargs: Any) -> None:
        journalled.append((str(doc["id"]), "force_reextract" in doc))
        return real_started(doc, **kwargs)

    monkeypatch.setattr(P, "stage_extract", stage_extract)
    monkeypatch.setattr(P._journal_hooks, "on_run_started", on_run_started)
    w = O._own_month(app, gw, monkeypatch, [RuntimeError(W.PROVIDER_ERROR_TEXT), W._reply(W.BODY_B, W.TITLES_B),
                                            W._reply("Comentariul lunii noiembrie.", ["Pentru noiembrie"])])
    # 1. THE FIRST ANALYSIS.
    assert seen == [(w["doc1"], None)], seen
    spy = W._Spy(gw.db, monkeypatch)

    # 2. THE DOCS PANEL'S RE-RUN of a document that owns its month: staged.
    assert O._retry(app, w["org"], w["doc1"]).status_code == 202
    rerun = V.run_analysis(gw, w["doc1"])
    assert (rerun["status"], rerun["period_id"]) == ("analyzed", w["month"]), rerun
    assert seen[-1] == (w["doc1"], True), "the staged re-run did not tell the extract stage to re-extract"

    # 3. A SAME-MONTH RE-UPLOAD (staged beside the month too — but an upload).
    doc2 = W._reupload(app, gw, w["org"])
    assert doc2["status"] == "analyzed", doc2.get("error")
    assert seen[-1] == (doc2["id"], None), seen[-1]

    # 4. A RETRY OF A DOCUMENT THAT HOLDS NO PERIOD (its first run failed).
    november = V.one_tap(app, V.agras_workbook(period_line="Balanta de verificare la data de 30.11.2025"),
                         "balanta_noiembrie.xlsx")
    doc3 = november["commit"]["document_id"]
    with pytest.MonkeyPatch.context() as failing:
        failing.setattr(P, "stage_map", S._raise("map failed"))
        assert V.run_analysis(gw, doc3)["status"] == "failed"
    assert O._retry(app, w["org"], doc3).status_code == 202
    retried = V.run_analysis(gw, doc3)
    assert retried["status"] == "analyzed" and retried["period_id"] not in (None, w["month"]), retried
    assert [flag for doc_id, flag in seen if doc_id == doc3] == [None, None], seen

    # THE FLAG IS IN MEMORY ONLY: never written, never in the journal's copy.
    assert [x for x in spy.writes if "force_reextract" in json.dumps(x["payload"], default=str)] == []
    assert "force_reextract" not in json.dumps(gw.db.tables, default=str)
    assert journalled and all(carried is False for _doc, carried in journalled), journalled


def test_a_rerun_of_a_non_romanian_document_re_extracts_through_the_real_lane_and_keeps_its_generated_briefing(
        app, gw, monkeypatch):
    """A2 / A1 on THE REAL LANE (hand-over item 3, as its user meets it). A
    Hungarian ledger analysed by the lane; its user generated a briefing for
    it. "Re-run analysis": the lane reads the file AGAIN — the model is
    called, although the month's row would answer from the cache — the
    statements are replaced on the same period id, the generated briefing is
    the same row (marked), and the plan's non-Romanian meter is not touched
    (the book was counted once)."""
    w = _a_non_romanian_month(app, gw, monkeypatch)
    (briefing_before,) = copy.deepcopy(gw.db.rows("briefings"))
    line_items_before = _line_item_ids(gw, w["month"])
    content_hash = AL.content_hash_of(LANE.HU_BYTES)
    # POSITIVE CONTROL — THE CACHE IS LIVE. Handed the stored row, the lane
    # answers from the month (no model, nothing to persist): that is the
    # silent no-op a staged re-run would be. Told to re-extract, it does not.
    (row,) = copy.deepcopy(gw.docs(id=w["doc1"]))
    hit = AL._cache_lookup(row, content_hash, P._supabase.admin, "HU")
    assert hit and hit["ai_lane"] == {"cached": True, "period_id": w["month"], "content_hash": content_hash}, hit
    assert AL._cache_lookup(dict(row, force_reextract=True), content_hash, P._supabase.admin, "HU") is None
    statuses = S._watch_statuses(monkeypatch)
    spy = W._Spy(gw.db, monkeypatch)

    r = O._retry(app, w["org"], w["doc1"])
    assert r.status_code == 202 and r.json()["status"] == "queued", (r.status_code, r.text[:300])
    rerun = V.run_analysis(gw, w["doc1"])

    assert (rerun["status"], rerun["error"], rerun["period_id"]) == ("analyzed", None, w["month"]), rerun
    assert [len(c.messages.calls) for c in w["clients"]] == [3, 3], (
        "the re-run was answered from the lane's cache — nothing was re-read: %r"
        % [len(c.messages.calls) for c in w["clients"]])
    assert w["meter"] == [("reserve", V.USER), ("commit", V.USER)], (
        "the re-run of a counted book touched the non-Romanian meter: %r" % w["meter"])
    assert statuses == ["analyzed"], statuses
    (staged,) = S._staged_ids(spy)
    period = W._assert_one_period_and_nothing_beside_it(gw, w["month"], w["doc1"])
    assert staged != w["month"] and period["assembled_canonical_v1"]["ai_audit"]["content_hash"] == content_hash
    line_items = _line_item_ids(gw, w["month"])
    assert len(line_items) == len(line_items_before) and not set(line_items) & set(line_items_before)
    (briefing,) = gw.db.rows("briefings")
    assert W._sans_marker(briefing) == W._sans_marker(briefing_before), briefing
    assert briefing["stale_reason"] == NOT_RENARRATED and W._is_a_timestamp(briefing["stale_since"]), briefing
    served = W._served_period(app, w["org"], w["month"])["briefing"]
    assert (served["body"], served["unavailable"]) == (GENERATED_BODY, False), served
    assert served["stale"] == {"since": briefing["stale_since"], "reason": NOT_RENARRATED}
    assert "force_reextract" not in json.dumps(gw.db.tables, default=str)


class _RefusingModel(object):
    """The lane's model as production has it on 2026-10-04: every request
    refused. Nothing leaves the process."""

    calls = []  # type: List[Any]

    def __init__(self) -> None:
        self.messages = self

    def create(self, **kwargs: Any) -> Any:
        _RefusingModel.calls.append(kwargs.get("model"))
        raise RuntimeError("Your credit balance is too low to access the Anthropic API.")


def test_a_rerun_of_a_non_romanian_document_whose_model_refuses_leaves_the_month_exactly_as_it_was(
        app, gw, monkeypatch):
    """A2's other half, on THE REAL LANE. "Re-run analysis" re-extracts — and
    the lane's model refuses (production's state when this was written: every
    model call fails). The run fails in its extract stage. Staged, that costs
    the reader nothing: the month's row, every row under it, the generated
    briefing (unmarked — nothing replaced the statements it was written for)
    and what is served are exactly what they were; the document stays
    `analyzed` over its month and its row says the re-run did not finish.
    (On production's code the re-run's reset had already deleted the period
    when the model refused: the month was gone and the document `failed`.)"""
    from engine.workspaces.migration_plan import empty_live_periods

    w = _a_non_romanian_month(app, gw, monkeypatch)
    served_before = R.reader_view(app, gw, w["org"], w["month"])
    rows_before = V._rows_under(gw, w["month"])
    (period_before,) = copy.deepcopy(gw.db.rows("financial_periods"))
    monkeypatch.setattr(_RefusingModel, "calls", [])
    monkeypatch.setattr(lane_config, "default_client_factory", _RefusingModel)
    statuses = S._watch_statuses(monkeypatch)

    assert O._retry(app, w["org"], w["doc1"]).status_code == 202
    failed = V.run_analysis(gw, w["doc1"])

    assert _RefusingModel.calls, "the scenario never happened: the lane's model was not called (the cache answered)"
    assert (failed["status"], failed["period_id"]) == ("analyzed", w["month"]), (
        "the failed re-run left %r" % ((failed["status"], failed["period_id"]),))
    assert str(failed["error"]).startswith("rerun_failed: AiLaneError") and failed["error"] != INTERRUPTED, (
        failed["error"])
    assert statuses == [], "the failed re-run wrote statuses %r" % statuses
    assert gw.db.rows("financial_periods") == [period_before], "the month's row changed, or a staged row was left"
    assert V._rows_under(gw, w["month"]) == rows_before, "rows under the month changed"
    served = R.reader_view(app, gw, w["org"], w["month"])
    # (The Docs panel's feed carries the row's own text — the one thing that changed.)
    assert dict(served, panel=None) == dict(served_before, panel=None), "the month is not served as before"
    assert served["briefing"]["body"] == GENERATED_BODY and served["briefing"]["stale"] is None
    assert [[doc[1] for doc in p["documents"]] for p in served["panel"]] == [["analyzed"]], served["panel"]
    assert empty_live_periods(gw.db.tables) == [] and P._STAGED_RERUNS == {}
    assert w["meter"] == [("reserve", V.USER), ("commit", V.USER)], w["meter"]


# ══════════════════════════════════════════════════════════════════════
# A3 — a re-run that now reads as a public-records summary
# ══════════════════════════════════════════════════════════════════════


def _public_records_summary(doc: Dict[str, Any]) -> Dict[str, Any]:
    """What `stage_extract` returns for a multi-year aggregate table (a few
    figures per year, no accounts). Invented figures."""
    return {"detected_type": "public_records_summary", "company_name": "Agras SRL", "cui": V.CUI_AGRAS,
            "reg_com": None, "caen_code": "1011", "caen_description": None, "source_site": "listafirme.ro",
            "confidence": 0.9, "years": [{"year": 2024, "turnover": 1000.0}, {"year": 2023, "turnover": 900.0}]}


def test_a_rerun_that_now_reads_as_a_public_records_summary_is_refused_before_any_write(app, gw, monkeypatch):
    """A3. The public-records exit ends by marking the document analysed
    with NO period. For a re-run of a document that OWNS a month that is a
    month left without its document's analysis — the period still names the
    document, the document names nothing. The staged re-run is refused before
    anything is written: no summary row, the month exactly what it was, the
    document analysed and pinned, its row saying the re-run did not finish.
    The next re-run (the file read normally again) completes."""
    from engine.workspaces.migration_plan import empty_live_periods

    w = O._own_month(app, gw, monkeypatch, [RuntimeError(W.PROVIDER_ERROR_TEXT)])
    before = W._month_as_served(app, gw, w)
    with pytest.MonkeyPatch.context() as reading:
        reading.setattr(P, "stage_extract", _public_records_summary)
        statuses = S._watch_statuses(reading)
        spy = W._Spy(gw.db, reading)

        assert O._retry(app, w["org"], w["doc1"]).status_code == 202
        refused = V.run_analysis(gw, w["doc1"])

    assert (refused["status"], refused["period_id"]) == ("analyzed", w["month"]), (
        "the re-run left its month without its document: %r" % ((refused["status"], refused["period_id"]),))
    assert refused["error"] == NOT_A_TRIAL_BALANCE, refused["error"]
    assert statuses == [], "the refused re-run wrote statuses %r" % statuses
    assert gw.db.rows("sku_analyses") == [], "the summary was written before the refusal"
    # The only writes: the document's own row (the claim's stamp, what the row says).
    assert sorted(set(x["table"] for x in spy.writes)) == ["documents"], sorted(set(x["table"] for x in spy.writes))
    assert all("period_id" not in (x["payload"] or {}) and "status" not in (x["payload"] or {})
               for x in spy.writes), spy.writes
    assert [p["id"] for p in gw.db.rows("financial_periods")] == [w["month"]]
    assert W._month_as_served(app, gw, w) == before, "the month is not what it was before the click"
    assert empty_live_periods(gw.db.tables) == [] and P._STAGED_RERUNS == {}

    # THE NEXT RE-RUN — the file read as the trial balance it is; the provider refusing.
    again = W._docs_panel_rerun(app, gw, w)
    assert (again["status"], again["error"], again["period_id"]) == ("analyzed", None, w["month"]), again
    (briefing,) = gw.db.rows("briefings")
    assert briefing["body"] == W.BODY_A and briefing["stale_reason"] == "provider_error"
    assert gw.db.rows("recommendations") == w["recommendations"]


def test_a_first_upload_of_a_public_records_summary_and_its_retry_are_what_they_were(app, gw, monkeypatch):
    """POSITIVE CONTROL of A3: the refusal is the STAGED re-run's alone. A
    first upload that reads as a public-records summary is stored as one —
    analysed, no period — and "Re-run analysis" on it (a document that holds
    no period is never staged) stores it again."""
    monkeypatch.setattr(P, "stage_extract", _public_records_summary)
    out = V.one_tap(app, V.agras_workbook(), "extras_listafirme.xlsx")
    doc_id, org = out["commit"]["document_id"], out["commit"]["org_id"]

    first = V.run_analysis(gw, doc_id)

    def assert_a_stored_summary(doc: Dict[str, Any]) -> None:
        assert (doc["status"], doc["error"], doc["period_id"]) == ("analyzed", None, None), doc
        (summary,) = gw.db.rows("sku_analyses")
        assert summary["document_id"] == doc_id and summary["org_id"] == org
        assert summary["briefing"]["kind"] == "public_records_summary" and len(summary["briefing"]["years"]) == 2
        assert gw.db.rows("financial_periods") == []

    assert_a_stored_summary(first)
    r = O._retry(app, org, doc_id)
    assert r.status_code == 202, (r.status_code, r.text[:300])
    assert doc_id not in P._STAGED_RERUNS, "a document that holds no period was handed off as a staged re-run"
    assert_a_stored_summary(V.run_analysis(gw, doc_id))


# ══════════════════════════════════════════════════════════════════════
# A4 — a same-month re-upload through the lane
# ══════════════════════════════════════════════════════════════════════


def test_a_same_month_reupload_through_the_ai_lane_keeps_the_briefing_marked_and_never_the_old_files_alerts(
        app, gw, monkeypatch):
    """A4. The same company's December uploaded again — ANOTHER file — and
    this file goes through the lane. The upload's takeover replaces the
    month's statements and archives the first file, as every same-month
    re-upload does. The lane brought no briefing and no recommendations: the
    month's are kept, the briefing marked `not_renarrated` (never a
    narration failure that did not happen). THE ARCHIVED FILE'S ALERTS DO NOT
    STAY: they cite the old file's figures and carry its document id, and
    kept they sat unmarked on the new file's statements (review 2026-10-05;
    what stage 3 first did). They go with the statements they were derived
    from, as on 7ca386ec — the lane writes none. An UPLOAD is not told to
    re-extract."""
    w = _a_month_whose_next_run_is_the_lanes(app, gw, monkeypatch)
    meter = _the_non_romanian_meter(monkeypatch)
    line_items_before = _line_item_ids(gw, w["month"])

    doc2 = W._reupload(app, gw, w["org"])

    assert (doc2["status"], doc2["error"], doc2["period_id"]) == ("analyzed", None, w["month"]), (
        doc2["status"], doc2.get("error"), doc2["period_id"])
    assert w["handed"] == [{"document_id": doc2["id"], "force_reextract": None, "kind": "xlsx"}], w["handed"]
    assert meter[:1] == [("reserve", V.USER)], meter          # a first analysis of a non-Romanian file
    # THE TAKEOVER HAPPENED: the month is the new file's, the first file is archived.
    W._assert_one_period_and_nothing_beside_it(gw, w["month"], doc2["id"])
    (d1,) = gw.docs(id=w["doc1"])
    assert d1["deleted_at"] is not None and str(d1["error"]).startswith("superseded_by:"), d1
    line_items = _line_item_ids(gw, w["month"])
    assert line_items and not set(line_items) & set(line_items_before)
    # THE OLD FILE'S ALERTS ARE NOT ON THE NEW FILE'S STATEMENTS — none of
    # the archived document's rows, under the month or anywhere.
    assert w["alerts"] and all(a["document_id"] == w["doc1"] for a in w["alerts"]), (
        "the month held no alerts of the first file: the check is vacuous")
    assert gw.db.rows("alerts") == [], (
        "the archived file's alerts stayed on the new file's statements: %r"
        % sorted(a["alert_key"] for a in gw.db.rows("alerts")))
    # THE BRIEFING AND THE RECOMMENDATIONS ARE KEPT (the briefing says so).
    assert gw.db.rows("recommendations") == w["recommendations"]
    (briefing,) = gw.db.rows("briefings")
    assert W._sans_marker(briefing) == W._sans_marker(w["briefing"]) and \
        briefing["stale_reason"] == NOT_RENARRATED, briefing
    body = W._served_period(app, w["org"], w["month"])
    assert body["period"]["source_document"]["id"] == doc2["id"]
    assert body["briefing"]["body"] == W.BODY_A and body["briefing"]["stale"]["reason"] == NOT_RENARRATED


# ══════════════════════════════════════════════════════════════════════
# A5 — the workspace's plan refuses the re-run
# ══════════════════════════════════════════════════════════════════════


def test_a_rerun_the_workspaces_plan_refuses_leaves_the_month_and_its_briefing_as_they_were(app, gw, monkeypatch):
    """A5. The document reads as non-Romanian now and the workspace's plan
    does not include such documents (the REAL plan gate: the owner holds no
    plan row here). A re-run re-extracts, so it re-enters that gate — and is
    refused before the lane is reached. Staged: the document is NOT marked
    failed, the month and its briefing are exactly what they were, and the
    row carries the neutral code — no plan's name. With the plan in place the
    very next re-run goes through the lane."""
    w = _a_month_whose_next_run_is_the_lanes(app, gw, monkeypatch, entitled=False)
    before = W._month_as_served(app, gw, w)
    with pytest.MonkeyPatch.context() as watching:
        statuses = S._watch_statuses(watching)

        assert O._retry(app, w["org"], w["doc1"]).status_code == 202
        refused = V.run_analysis(gw, w["doc1"])

    assert w["handed"] == [], "the lane was reached although the plan refuses it"
    assert (refused["status"], refused["period_id"]) == ("analyzed", w["month"]), refused
    assert refused["error"] == PLAN_REFUSED, refused["error"]
    assert statuses == [], statuses
    assert [p["id"] for p in gw.db.rows("financial_periods")] == [w["month"]]
    assert W._month_as_served(app, gw, w) == before, "the refused re-run changed the month"
    assert P._STAGED_RERUNS == {}

    # CONTROL: the refusal was the plan's.
    _the_plan_includes_non_romanian_documents(gw)
    assert O._retry(app, w["org"], w["doc1"]).status_code == 202
    rerun = V.run_analysis(gw, w["doc1"])
    assert (rerun["status"], rerun["error"], rerun["period_id"]) == ("analyzed", None, w["month"]), rerun
    assert w["handed"] == [{"document_id": w["doc1"], "force_reextract": True, "kind": "xlsx"}], w["handed"]
    (briefing,) = gw.db.rows("briefings")
    assert briefing["body"] == W.BODY_A and briefing["stale_reason"] == NOT_RENARRATED, briefing
    assert gw.db.rows("recommendations") == w["recommendations"] and gw.db.rows("alerts") == w["alerts"]


# ══════════════════════════════════════════════════════════════════════
# A6 — a REAL restart of a re-run of a non-Romanian document
# ══════════════════════════════════════════════════════════════════════


def _staged_rows(tables: Dict[str, List[Dict[str, Any]]], org_id: str) -> List[Dict[str, Any]]:
    return [p for p in tables.get("financial_periods") or []
            if p["org_id"] == org_id and p.get("source_document_id") is None
            and isinstance(p.get("assembled_canonical_v1"), dict) and MARKER_KEY in p["assembled_canonical_v1"]]


#: where the re-run's process dies -> (how, has the takeover passed its commit point)
_LANE_KILLS = {
    "before_the_commit_point": (
        lambda gw, mp, store, month: R.kill_after(gw, mp, store, "insert", "statement_line_items"), False),
    "inside_the_takeover": (
        lambda gw, mp, store, month: R.kill_after(
            gw, mp, store, "delete", "statement_line_items",
            when=lambda payload, filters: filters == {"period_id": "eq.%s" % month}), True),
}  # type: Dict[str, Tuple[Callable[..., Dict[str, Any]], bool]]


def _a_lane_rerun_killed(app, gw, monkeypatch, tmp_path, kill: str) -> Tuple[Dict[str, Any], Any]:
    """The REAL POST /api/pipeline/retry of a non-Romanian document, then the
    run it queued through the real lane — which dies where `kill` says. The
    store is frozen at that instant. Returns the world and the store's path."""
    arm, committed = _LANE_KILLS[kill]
    w = _a_non_romanian_month(app, gw, monkeypatch)
    w["reader_before"] = R.reader_view(app, gw, w["org"], w["month"])
    assert w["reader_before"]["briefing"]["body"] == GENERATED_BODY and w["reader_before"]["line_items"] > 0
    store = tmp_path / ("%s.pickle" % kill)
    seen = arm(gw, monkeypatch, store, w["month"])
    r = O._retry(app, w["org"], w["doc1"])
    assert r.status_code == 202, (r.status_code, r.text[:300])
    with pytest.raises(R.Kill):
        P._run_pipeline_sync(w["doc1"])
    assert seen["fired"], "the scenario never happened: the run was not killed where it should be"
    tables = R.frozen_tables(store)
    (staged,) = _staged_rows(tables, w["org"])
    marker = staged["assembled_canonical_v1"][MARKER_KEY]
    assert bool(marker.get("takeover_began_at")) is committed, marker
    (doc,) = [d for d in tables["documents"] if d["id"] == w["doc1"]]
    assert (doc["status"], doc["period_id"]) == ("analyzed", w["month"]), doc
    if committed:
        # What the resume will need is ON THE ROW: why the kept briefing is stale.
        assert marker["keep_briefing_reason"] == NOT_RENARRATED and doc["error"] == INTERRUPTED, (marker, doc)
    else:
        assert doc["error"] is None, doc
    return w, store


def _assert_the_month_is_whole_and_keeps_its_generated_briefing(w: Dict[str, Any], view: Dict[str, Any]) -> None:
    december = [p for p in view["store"]["periods"] if p["id"] == w["month"]]
    assert [(p["source"], p["marker"]) for p in december] == [(w["doc1"], None)], view["store"]["periods"]
    assert all(p["marker"] is None for p in view["store"]["periods"]), view["store"]["periods"]
    assert all(v == [] for v in view["store"]["strays"].values()), view["store"]["strays"]
    assert view["empty_live_periods"] == []
    briefing = view["reader"]["briefing"]
    assert (briefing["body"], briefing["unavailable"]) == (GENERATED_BODY, False), (
        "the generated briefing did not come through the restart: %r" % (briefing,))
    assert (briefing["stale"] or {}).get("reason") == NOT_RENARRATED, briefing
    assert (view["reader"]["line_items"], view["reader"]["revenue"]) == (
        w["reader_before"]["line_items"], w["reader_before"]["revenue"]), view["reader"]
    (doc,) = [d for d in view["store"]["documents"] if d["id"] == w["doc1"]]
    assert (doc["status"], doc["error"], doc["period_id"]) == ("analyzed", None, w["month"]), doc


@pytest.mark.parametrize("kill", sorted(_LANE_KILLS))
def test_a_lane_rerun_killed_by_a_restart_is_healed_by_the_documents_next_rerun(
        app, gw, monkeypatch, tmp_path, kill):
    """A6. The backend restarts (every deploy is one) in the middle of a
    re-run of a non-Romanian document. A SECOND process over the store frozen
    at the kill: killed before the commit point, the reader is served exactly
    what they were served before the click; then the document's next "Re-run
    analysis" there — the lane re-extracting again — leaves ONE period, the
    run's statements, and the generated briefing, marked."""
    w, store = _a_lane_rerun_killed(app, gw, monkeypatch, tmp_path, kill)

    report = R.second_process(store, [
        {"op": "view", "label": "after the restart", "org": w["org"], "period": w["month"]},
        {"op": "lane_model"},
        {"op": "retry", "org": w["org"], "doc": w["doc1"]},
        {"op": "view", "label": "after the next re-run", "org": w["org"], "period": w["month"]},
    ], tmp_path)
    restarted, retry, healed = report["steps"]

    if not _LANE_KILLS[kill][1]:
        assert restarted["reader"] == w["reader_before"], (
            "after the restart the reader is not served what they were served before the click")
    else:
        # RECORDED, not asserted: the month is mid-replacement until the resume.
        print("\n[%s] served between the kill and the resume: %s" % (kill, json.dumps(
            {k: restarted["reader"][k] for k in ("briefing", "line_items", "panel")},
            ensure_ascii=False, default=str)[:700]))
    assert retry["status_code"] == 202 and retry["body"]["status"] == "queued", retry
    assert retry["document"] == {"status": "analyzed", "error": None, "period_id": w["month"]}, retry["document"]
    assert retry["lane_extractions"] == [3], "the next re-run did not re-extract: %r" % (retry["lane_extractions"],)
    _assert_the_month_is_whole_and_keeps_its_generated_briefing(w, healed)


def test_a_lane_takeover_killed_by_a_restart_is_completed_by_another_documents_run_and_the_briefing_says_so(
        app, gw, monkeypatch, tmp_path):
    """A6, with nobody re-running that document again. Fifteen minutes later
    ANOTHER document of the company is analysed (a Romanian November): its
    company pass completes the interrupted takeover. Nothing ran for
    December — its generated briefing is marked `not_renarrated` by the
    RESUME, from the reason the commit marker recorded."""
    w, store = _a_lane_rerun_killed(app, gw, monkeypatch, tmp_path, "inside_the_takeover")

    report = R.second_process(store, [
        {"op": "ttl_elapsed"},
        {"op": "provider", "outcomes": [{"body": "Comentariul lunii noiembrie.", "titles": ["Pentru noiembrie"]}]},
        {"op": "another_documents_run", "label": "November, fifteen minutes later"},
        {"op": "view", "label": "December afterwards", "org": w["org"], "period": w["month"]},
    ], tmp_path)
    november, december = report["steps"]

    assert november["document"]["status"] == "analyzed" and november["document"]["org_id"] == w["org"], november
    assert november["document"]["period_id"] not in (None, w["month"])
    assert sorted(p["period_end"] for p in december["store"]["periods"]) == ["2025-11-30", "2025-12-31"]
    _assert_the_month_is_whole_and_keeps_its_generated_briefing(w, december)
