"""A RE-RUN SURVIVES A RESTART AT ANY POINT — gate `rerun-data-loss`, the restart laws.

THE DEFECT (hand-over 2026-10-04, item 2). The Docs panel's "Re-run analysis"
deleted the document's period first and held what the delete cascaded away —
the last good briefing, the worked recommendations — in the backend PROCESS.
A restart (every deploy is one) between the click and the run's narrative
stage, or between a failed run and the document's next one, lost them for
good.

WHAT RUNS HERE — A REAL RESTART (`rerun_restart_lib`). The REAL
`POST /api/pipeline/retry` and the real `_run_pipeline_sync` in the `gw`
world; the process "dies" right after one write was stored (a
`BaseException`: no handler of the engine runs) and the store is frozen at
that instant; a SECOND python process — fresh imports, a second
`create_app()`, empty registries — thaws it and goes on through the real
routes. Nothing is cleared by hand.

THE LAW.
  T1  Killed at any point UP TO the takeover's commit point — after the
      claim, after the staged row's insert, its line items, its envelope,
      its metrics, the run's own briefing, a staged-only delete of the
      takeover — the second process serves EXACTLY what was served before
      the click. The frozen store holds the month untouched and, beside it,
      at most the one staged row (uncommitted).
  T2  …and the document's next "Re-run analysis" there, with the provider
      refusing: 202, ONE period (the same id), nothing left under any other
      id, the last good briefing kept (stale), every recommendation with its
      id and what a user set on it.
  T3  Killed AFTER the commit point — between any two statements of the
      apply — the document's row says so at once (`rerun_failed:
      interrupted_replacing`), and the document's next re-run first
      COMPLETES the interrupted takeover: the month is that run's analysis,
      whole — its briefing, its recommendations, its statements.
  T4  The same, healed with no re-run of that document at all: ANOTHER
      document's analysis in the company, fifteen minutes later.
  T5  Killed after the apply, before the run's last status write: the
      finished result; nothing to clean.
  T6  The second process is a second process: another pid, the engine of
      the tree under test, every registry empty, no `_RERUN_CARRY`.
  T7  A METERED re-run that died is never counted. A staged re-run leaves
      its document `analyzed` the whole time — the status the quota sweep
      used to read as "the orphaned run's analysis finished". A reservation
      whose staged row is still there (never applied, or interrupted) is
      RELEASED; one whose takeover completed — only the settlement was lost
      — is counted, once.

WHAT THESE RED ON, with the defect repaired (TC-11):
  · the reset, or any write on the month before the commit point (T1: the
    reader view differs);
  · the staged row applied although its takeover never began, or left
    behind by the next re-run (T2: two rows, or rows under a dead id);
  · a committed staged row DROPPED instead of resumed (T3/T4: the run's
    briefing or recommendations are gone — the measured loss);
  · the interrupted marker not written at the commit point, or not cleared
    by the resume;
  · the company pass not resuming (T4), or resuming before the fifteen
    minutes while the document's run may be alive (seam law S14);
  · a carry coming back in process memory (T6).

CANNOT SEE.
  · A kill INSIDE one HTTP statement (PostgREST's own atomicity), and
    Postgres itself — the store is the double; the foreign keys' cascade is
    modelled by hand (`test_rerun_ownership._production_foreign_keys`).
  · Two backend processes ALIVE at once (in-flight is per process): the
    second process here starts after the first is dead.
  · What a reader is served BETWEEN the commit point and the resume: it is
    recorded (printed with `-s`), not asserted — the month can be mid-
    replacement there; only one transaction (a database function, i.e. a
    migration) removes that window.
  · Real time: "fifteen minutes later" is the constant moved, not the clock.

PLANT LOG: docs/engine_book/gates.md "rerun-data-loss".
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest

import rerun_restart_lib as R
import test_briefing_keep_last_good_writers as W
import test_rerun_ownership as O
import test_workspace_v2_gates as V
from test_workspace_v2_gates import app, gw  # noqa: F401 — pytest fixtures
from engine.api import pipeline as P

# ── THE EXPECTED VALUES, stated here — never read from the code under test ──
MARKER_KEY = "staged_rerun"
INTERRUPTED = "rerun_failed: interrupted_replacing"

REFUSES = "refuses"
WORKS = {"body": W.BODY_B, "titles": W.TITLES_B}


def _outcome(spec: Any) -> Any:
    return RuntimeError(W.PROVIDER_ERROR_TEXT) if spec == REFUSES else W._reply(spec["body"], spec["titles"])


def _world(app, gw, monkeypatch, rerun_narration: Any) -> Dict[str, Any]:
    """Agras's December analysed (BODY_A, TITLES_A), one recommendation
    worked by a user, production's foreign keys, the provider scripted for
    the re-run — and what a reader is served before the click."""
    w = O._own_month(app, gw, monkeypatch, [_outcome(rerun_narration)])
    w["reader_before"] = R.reader_view(app, gw, w["org"], w["month"])
    w["store_before"] = R.store_view(gw, w["org"])
    assert w["reader_before"]["briefing"]["body"] == W.BODY_A
    # What a user set on one recommendation — its status is served; its owner
    # and due date are stored (the page reads them through the row).
    assert [x[1:3] for x in w["reader_before"]["recommendations"] if x[2] == "in_review"] == [
        [w["worked_title"], "in_review"]]
    (month,) = w["store_before"]["periods"]
    assert [x[1:] for x in month["recommendations"] if x[2] == "in_review"] == [
        [w["worked_title"], "in_review", "CFO", "2026-11-15", w["month"]]]
    return w


def _click_and_die(app, gw, w: Dict[str, Any], seen: Dict[str, Any]) -> None:
    """The REAL POST /api/pipeline/retry, then the run it queued — which
    dies where `seen` was armed."""
    r = O._retry(app, w["org"], w["doc1"])
    assert r.status_code == 202 and r.json()["status"] == "queued", (r.status_code, r.text[:300])
    with pytest.raises(R.Kill):
        P._run_pipeline_sync(w["doc1"])
    assert seen["fired"], "the scenario never happened: the run was not killed where it should be"


def _staged_rows(tables: Dict[str, List[Dict[str, Any]]], org_id: str) -> List[Dict[str, Any]]:
    return [p for p in tables.get("financial_periods") or []
            if p["org_id"] == org_id and p.get("source_document_id") is None
            and isinstance(p.get("assembled_canonical_v1"), dict) and MARKER_KEY in p["assembled_canonical_v1"]]


# ══════════════════════════════════════════════════════════════════════
# T1 / T2 — killed before the commit point
# ══════════════════════════════════════════════════════════════════════

#: point -> (the re-run's narration, how the kill is armed, staged rows the
#: frozen store holds). `month` is the id of the month's own row.
_BEFORE_THE_COMMIT_POINT = {
    "1_after_the_claim": (
        WORKS, lambda gw, mp, store, month: R.kill_when(gw, mp, store, P, "stage_extract"), 0),
    "2_after_the_staged_rows_insert": (
        WORKS, lambda gw, mp, store, month: R.kill_after(gw, mp, store, "insert", "financial_periods"), 1),
    "3_after_the_line_items": (
        WORKS, lambda gw, mp, store, month: R.kill_after(gw, mp, store, "insert", "statement_line_items"), 1),
    "4_after_the_envelope": (
        WORKS, lambda gw, mp, store, month: R.kill_after(
            gw, mp, store, "update", "financial_periods",
            when=lambda payload, filters: "assembled_canonical_v1" in (payload or {})), 1),
    "5_after_the_metrics": (
        WORKS, lambda gw, mp, store, month: R.kill_after(gw, mp, store, "insert", "calculated_metrics"), 1),
    "6_after_the_runs_own_briefing": (
        WORKS, lambda gw, mp, store, month: R.kill_after(gw, mp, store, "upsert", "briefings"), 1),
    # The takeover has started; the narration failed, so the staged run's
    # sentinel is deleted under the STAGED id — before the commit point.
    "7_after_a_staged_only_delete_of_the_takeover": (
        REFUSES, lambda gw, mp, store, month: R.kill_after(
            gw, mp, store, "delete", "briefings",
            when=lambda payload, filters: "org_id" in filters and filters.get("period_id") != "eq.%s" % month), 1),
}  # type: Dict[str, Tuple[Any, Callable[..., Dict[str, Any]], int]]


@pytest.mark.parametrize("point", sorted(_BEFORE_THE_COMMIT_POINT))
def test_a_rerun_killed_before_its_commit_point_serves_what_was_served_and_the_next_rerun_keeps_everything(
        app, gw, monkeypatch, tmp_path, point):
    narration, arm, staged_rows = _BEFORE_THE_COMMIT_POINT[point]
    w = _world(app, gw, monkeypatch, narration)
    store = tmp_path / ("%s.pickle" % point)
    seen = arm(gw, monkeypatch, store, w["month"])

    _click_and_die(app, gw, w, seen)

    # THE FROZEN STORE: the month untouched; beside it at most the staged row,
    # uncommitted; the document as it was — analysed, pinned to its month.
    tables = R.frozen_tables(store)
    staged = _staged_rows(tables, w["org"])
    assert len(staged) == staged_rows, "%s: %d staged row(s) in the frozen store" % (point, len(staged))
    assert [p["id"] for p in tables["financial_periods"] if p["org_id"] == w["org"]
            and p.get("source_document_id") is not None] == [w["month"]]
    assert all("takeover_began_at" not in p["assembled_canonical_v1"][MARKER_KEY] for p in staged), staged
    (doc,) = [d for d in tables["documents"] if d["id"] == w["doc1"]]
    assert (doc["status"], doc["period_id"], doc["error"]) == ("analyzed", w["month"], None), doc

    report = R.second_process(store, [
        {"op": "view", "label": "after the restart", "org": w["org"], "period": w["month"]},
        {"op": "provider", "outcomes": [REFUSES]},
        {"op": "retry", "org": w["org"], "doc": w["doc1"]},
        {"op": "view", "label": "after the next re-run", "org": w["org"], "period": w["month"]},
    ], tmp_path)
    restarted, retry, healed = report["steps"]

    # T1 — exactly what was served before the click.
    assert restarted["reader"] == w["reader_before"], (
        "%s: after the restart the reader is not served what they were served before the click" % point)
    # (A stranded staged row is what the production check reports as a
    # period with no source document until it is cleaned up — stated.)
    assert restarted["empty_live_periods"] == [[p["id"], "no source document"] for p in staged]

    # T2 — the document's next re-run, the provider refusing.
    assert retry["status_code"] == 202 and retry["body"]["status"] == "queued", retry
    assert retry["document"] == {"status": "analyzed", "error": None, "period_id": w["month"]}, retry["document"]
    (period,) = healed["store"]["periods"]
    assert period["id"] == w["month"] and period["source"] == w["doc1"] and period["marker"] is None, period
    assert all(v == [] for v in healed["store"]["strays"].values()), healed["store"]["strays"]
    assert healed["empty_live_periods"] == []
    briefing = healed["reader"]["briefing"]
    assert briefing["body"] == W.BODY_A and briefing["unavailable"] is False, briefing
    assert (briefing["stale"] or {}).get("reason") == "provider_error", briefing
    assert healed["reader"]["recommendations"] == w["reader_before"]["recommendations"], (
        "%s: the recommendations did not come through the restart and the next re-run with their ids "
        "and what a user set on them: %r" % (point, healed["reader"]["recommendations"]))
    assert period["recommendations"] == w["store_before"]["periods"][0]["recommendations"]
    assert (healed["reader"]["revenue"], healed["reader"]["line_items"], healed["reader"]["metrics"]) == (
        w["reader_before"]["revenue"], w["reader_before"]["line_items"], w["reader_before"]["metrics"])


# ══════════════════════════════════════════════════════════════════════
# T3 / T4 — killed after the commit point
# ══════════════════════════════════════════════════════════════════════


def _commit_write(payload: Any, filters: Dict[str, str]) -> bool:
    envelope = (payload or {}).get("assembled_canonical_v1")
    return isinstance(envelope, dict) and "takeover_began_at" in (envelope.get(MARKER_KEY) or {})


#: point -> (how the kill is armed, what the document's row says at the kill).
_AFTER_THE_COMMIT_POINT = {
    "1_after_the_commit_write_itself": (
        lambda gw, mp, store, month: R.kill_after(gw, mp, store, "update", "financial_periods", when=_commit_write),
        None),
    "2_after_the_months_line_items_were_deleted": (
        lambda gw, mp, store, month: R.kill_after(
            gw, mp, store, "delete", "statement_line_items",
            when=lambda payload, filters: filters == {"period_id": "eq.%s" % month}), INTERRUPTED),
    "3_after_the_runs_line_items_were_moved": (
        lambda gw, mp, store, month: R.kill_after(
            gw, mp, store, "update", "statement_line_items",
            when=lambda payload, filters: payload == {"period_id": month}), INTERRUPTED),
    "4_after_the_months_recommendations_were_deleted": (
        lambda gw, mp, store, month: R.kill_after(
            gw, mp, store, "delete", "recommendations",
            when=lambda payload, filters: filters == {"period_id": "eq.%s" % month}), INTERRUPTED),
    "5_after_the_months_briefing_was_deleted": (
        lambda gw, mp, store, month: R.kill_after(
            gw, mp, store, "delete", "briefings",
            when=lambda payload, filters: filters == {"period_id": "eq.%s" % month}), INTERRUPTED),
    "6_after_the_months_row_took_the_runs_columns": (
        lambda gw, mp, store, month: R.kill_after(
            gw, mp, store, "update", "financial_periods",
            when=lambda payload, filters: filters.get("id") == "eq.%s" % month
            and "assembled_canonical_v1" in (payload or {})), INTERRUPTED),
    "7_after_the_documents_write_before_the_staged_rows_delete": (
        lambda gw, mp, store, month: R.kill_after(
            gw, mp, store, "update", "documents",
            when=lambda payload, filters: (payload or {}).get("period_id") == month), None),
}  # type: Dict[str, Tuple[Callable[..., Dict[str, Any]], Optional[str]]]


def _killed_after_the_commit_point(app, gw, monkeypatch, tmp_path, point: str) -> Tuple[Dict[str, Any], Any]:
    """A re-run whose narration WORKED (BODY_B, TITLES_B), killed inside its
    takeover. Returns the world and the frozen store's path."""
    arm, error_at_the_kill = _AFTER_THE_COMMIT_POINT[point]
    w = _world(app, gw, monkeypatch, WORKS)
    store = tmp_path / ("%s.pickle" % point)
    seen = arm(gw, monkeypatch, store, w["month"])
    _click_and_die(app, gw, w, seen)
    tables = R.frozen_tables(store)
    (staged,) = _staged_rows(tables, w["org"])
    assert staged["assembled_canonical_v1"][MARKER_KEY].get("takeover_began_at"), (
        "%s: the frozen staged row is not committed — the kill came before the commit point" % point)
    (doc,) = [d for d in tables["documents"] if d["id"] == w["doc1"]]
    assert doc["status"] == "analyzed" and doc["error"] == error_at_the_kill, (point, doc)
    return w, store


def _assert_the_month_is_the_reruns_analysis_whole(w: Dict[str, Any], view: Dict[str, Any], *,
                                                 stale_reason: Optional[str]) -> None:
    december = [p for p in view["store"]["periods"] if p["period_end"] == "2025-12-31"]
    assert [(p["id"], p["source"], p["marker"]) for p in december] == [(w["month"], w["doc1"], None)], december
    assert all(p["marker"] is None for p in view["store"]["periods"]), view["store"]["periods"]
    assert all(v == [] for v in view["store"]["strays"].values()), view["store"]["strays"]
    reader = view["reader"]
    assert reader["briefing"]["body"] == W.BODY_B and reader["briefing"]["unavailable"] is False, (
        "the interrupted re-run's own briefing is gone: %r" % (reader["briefing"],))
    assert (reader["briefing"]["stale"] or {}).get("reason") == stale_reason, reader["briefing"]
    assert sorted(x[1] for x in reader["recommendations"]) == W.TITLES_B, (
        "the interrupted re-run's own recommendations are gone: %r" % (reader["recommendations"],))
    assert all(x[5] == w["month"] for x in december[0]["recommendations"]), december[0]["recommendations"]
    assert (reader["revenue"], reader["line_items"], reader["metrics"]) == (
        w["reader_before"]["revenue"], w["reader_before"]["line_items"], w["reader_before"]["metrics"]), reader
    assert reader["alerts"] == w["reader_before"]["alerts"]
    (doc,) = [d for d in view["store"]["documents"] if d["id"] == w["doc1"]]
    assert (doc["status"], doc["error"], doc["period_id"]) == ("analyzed", None, w["month"]), doc


@pytest.mark.parametrize("point", sorted(_AFTER_THE_COMMIT_POINT))
def test_a_rerun_killed_after_its_commit_point_is_completed_by_the_documents_next_rerun(
        app, gw, monkeypatch, tmp_path, point):
    w, store = _killed_after_the_commit_point(app, gw, monkeypatch, tmp_path, point)

    report = R.second_process(store, [
        {"op": "view", "label": "after the restart", "org": w["org"], "period": w["month"]},
        {"op": "provider", "outcomes": [REFUSES]},
        {"op": "retry", "org": w["org"], "doc": w["doc1"]},
        {"op": "view", "label": "after the next re-run", "org": w["org"], "period": w["month"]},
    ], tmp_path)
    restarted, retry, healed = report["steps"]

    # RECORDED, not asserted: between the commit point and the resume the
    # month can be mid-replacement (see CANNOT SEE).
    print("\n[%s] served between the kill and the resume: %s" % (point, json.dumps(
        {k: restarted["reader"][k] for k in ("briefing", "recommendations", "line_items", "metrics", "revenue")},
        ensure_ascii=False, default=str)[:900]))
    # The document's next re-run: accepted — and BEFORE it ran, the
    # interrupted takeover was completed. Its own narration then failed (the
    # provider refuses): the month's briefing — the interrupted run's — is
    # kept and marked.
    assert retry["status_code"] == 202, retry
    assert healed["empty_live_periods"] == []
    _assert_the_month_is_the_reruns_analysis_whole(w, healed, stale_reason="provider_error")


@pytest.mark.parametrize("point", ["4_after_the_months_recommendations_were_deleted",
                                   "5_after_the_months_briefing_was_deleted"])
def test_a_rerun_killed_after_its_commit_point_is_completed_by_another_documents_run_after_the_ttl(
        app, gw, monkeypatch, tmp_path, point):
    """T4. Nobody re-runs the document again. Fifteen minutes later ANOTHER
    document of the company is analysed (its November): the company pass of
    that run completes the interrupted takeover. Nothing of December is
    narrated again — its briefing is the interrupted run's, current."""
    w, store = _killed_after_the_commit_point(app, gw, monkeypatch, tmp_path, point)

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
    assert december["empty_live_periods"] == []
    _assert_the_month_is_the_reruns_analysis_whole(w, december, stale_reason=None)


# ══════════════════════════════════════════════════════════════════════
# T8 / T9 — the next writer on the month, and the next reader of the app
# ══════════════════════════════════════════════════════════════════════


def test_a_rerun_killed_inside_its_apply_keeps_its_briefing_through_a_same_month_upload_minutes_later(
        app, gw, monkeypatch, tmp_path):
    """T8 — measured on the stage-3 tip with a real second process (review
    2026-10-05). The re-run narrated (BODY_B) and died right after the
    month's briefing was deleted: the month holds NO briefing, the run's
    good one sits under the committed staged row. BEFORE anything resumes it
    — inside the fifteen minutes — another file for the same month is
    uploaded, the provider refusing (production's state). The upload's pass
    LEFT the committed row ("it may be a live run's"), its takeover found
    nothing usable on the month and moved its own failure sentinel there,
    and the later pass dropped the staged row: the last good briefing AND
    the run's new one gone, `unavailable: true`.

    A committed row whose document is not in flight is a dead process's: it
    is completed BEFORE the upload stages beside the month. The upload then
    takes over a month that is whole, and — its narration having failed —
    KEEPS the re-run's briefing (marked) and its recommendations."""
    w, store = _killed_after_the_commit_point(app, gw, monkeypatch, tmp_path,
                                              "5_after_the_months_briefing_was_deleted")
    (month_at_the_kill,) = [p for p in R.frozen_tables(store)["financial_periods"] if p["id"] == w["month"]]
    assert [b for b in R.frozen_tables(store)["briefings"] if b["period_id"] == w["month"]] == [],         "the scenario: at the kill the month holds no briefing"

    report = R.second_process(store, [
        {"op": "provider", "outcomes": [REFUSES]},
        {"op": "same_month_reupload", "label": "another file for December, minutes later", "org": w["org"]},
        {"op": "view", "label": "December afterwards", "org": w["org"], "period": w["month"]},
    ], tmp_path)
    upload, december = report["steps"]

    doc2 = upload["document"]
    assert (doc2["status"], doc2["error"], doc2["period_id"]) == ("analyzed", None, w["month"]), doc2
    (period,) = december["store"]["periods"]
    assert (period["id"], period["source"], period["marker"]) == (w["month"], doc2["id"], None), period
    assert all(v == [] for v in december["store"]["strays"].values()), december["store"]["strays"]
    assert december["empty_live_periods"] == []
    reader = december["reader"]
    assert reader["source_document"] == doc2["id"] and reader["revenue"] != w["reader_before"]["revenue"], reader
    # THE INTERRUPTED RE-RUN'S BRIEFING AND RECOMMENDATIONS CAME THROUGH.
    assert reader["briefing"]["body"] == W.BODY_B and reader["briefing"]["unavailable"] is False, (
        "the last good briefing did not survive the restart and the upload: %r" % (reader["briefing"],))
    assert (reader["briefing"]["stale"] or {}).get("reason") == "provider_error", reader["briefing"]
    assert sorted(x[1] for x in reader["recommendations"]) == W.TITLES_B, reader["recommendations"]
    assert all(x[5] == w["month"] for x in period["recommendations"]), period["recommendations"]
    (d1,) = [d for d in december["store"]["documents"] if d["id"] == w["doc1"]]
    assert d1["deleted"] is True and d1["error"] == "superseded_by:%s" % doc2["id"], d1
    assert month_at_the_kill["source_document_id"] == w["doc1"]


@pytest.mark.parametrize("point", ["2_after_the_months_line_items_were_deleted",
                                   "5_after_the_months_briefing_was_deleted"])
def test_a_rerun_killed_inside_its_apply_is_completed_when_a_member_next_opens_the_app(
        app, gw, monkeypatch, tmp_path, point):
    """T9. Nobody uploads anything and nobody clicks "Re-run" again. The
    month's page is serving a gap (no line items, or no briefing — recorded
    below). The dashboard's mount posts /api/pipeline/recover-stuck: the
    interrupted takeover is completed there and then, whatever the row's
    age — the run's analysis, whole, current."""
    w, store = _killed_after_the_commit_point(app, gw, monkeypatch, tmp_path, point)

    report = R.second_process(store, [
        {"op": "view", "label": "after the restart", "org": w["org"], "period": w["month"]},
        {"op": "watchdog", "label": "a member opens the dashboard"},
        {"op": "view", "label": "December afterwards", "org": w["org"], "period": w["month"]},
        {"op": "watchdog", "label": "…and again"},
    ], tmp_path)
    restarted, mount, december, again = report["steps"]

    print("\n[%s] served between the kill and the mount: %s" % (point, json.dumps(
        {k: restarted["reader"][k] for k in ("briefing", "line_items", "metrics", "revenue")},
        ensure_ascii=False, default=str)[:600]))
    assert restarted["reader"] != w["reader_before"], "the scenario: the month is mid-replacement"
    assert mount["status_code"] == 200 and mount["body"]["resumed_reruns"] == 1, mount
    assert december["empty_live_periods"] == []
    _assert_the_month_is_the_reruns_analysis_whole(w, december, stale_reason=None)
    assert again["body"]["resumed_reruns"] == 0, again


# ══════════════════════════════════════════════════════════════════════
# T5 — killed after the apply
# ══════════════════════════════════════════════════════════════════════


def test_a_rerun_killed_after_its_takeover_has_nothing_left_to_clean(app, gw, monkeypatch, tmp_path):
    """The takeover's LAST statement is the staged row's delete; the run's
    own last status write comes after it. Killed in between: the result is
    finished — one period, the run's analysis, the document analysed with no
    marker — and there is nothing for anyone to clean up."""
    w = _world(app, gw, monkeypatch, WORKS)
    store = tmp_path / "after_the_apply.pickle"
    seen = R.kill_after(gw, monkeypatch, store, "delete", "financial_periods",
                        when=lambda payload, filters: filters.get("source_document_id") == "is.null")
    _click_and_die(app, gw, w, seen)
    assert _staged_rows(R.frozen_tables(store), w["org"]) == []

    report = R.second_process(store, [
        {"op": "view", "label": "after the restart", "org": w["org"], "period": w["month"]}], tmp_path)
    (restarted,) = report["steps"]

    assert restarted["empty_live_periods"] == []
    _assert_the_month_is_the_reruns_analysis_whole(w, restarted, stale_reason=None)


# ══════════════════════════════════════════════════════════════════════
# T7 — the reservation of a metered re-run that died
# ══════════════════════════════════════════════════════════════════════

def _compute_fails(*a: Any, **kw: Any) -> Any:
    raise RuntimeError("compute failed")


#: where the metered re-run dies -> (how, what the sweep does with its
#: orphaned reservation)
_METERED_DEATHS = {
    "with_its_staged_row_never_applied": (
        lambda gw, mp, store, month: R.kill_after(gw, mp, store, "insert", "calculated_metrics"), "released"),
    "inside_its_takeover": (
        lambda gw, mp, store, month: R.kill_after(
            gw, mp, store, "delete", "briefings",
            when=lambda payload, filters: filters == {"period_id": "eq.%s" % month}), "released"),
    # The run FAILED, its handler dropped the staged row and said so on the
    # document's row — and the process died before the settlement.
    "after_it_failed_and_said_so": (
        lambda gw, mp, store, month: (
            mp.setattr(P, "stage_compute", _compute_fails),
            R.kill_after(gw, mp, store, "update", "documents",
                         when=lambda payload, filters: str((payload or {}).get("error") or "").startswith(
                             "rerun_failed: ")))[1], "released"),
    # CONTROL: the analysis finished; only the settlement was lost.
    "after_its_takeover_completed": (
        lambda gw, mp, store, month: R.kill_after(
            gw, mp, store, "delete", "financial_periods",
            when=lambda payload, filters: filters.get("source_document_id") == "is.null"), "committed"),
}  # type: Dict[str, Tuple[Callable[..., Dict[str, Any]], str]]


@pytest.mark.parametrize("death", sorted(_METERED_DEATHS))
def test_the_reservation_of_a_metered_rerun_that_died_is_settled_by_what_the_run_did(
        app, gw, monkeypatch, tmp_path, death):
    """T7. The document reads `analyzed` but the plan never counted its book
    (analysed with enforcement off — the ledger holds no count): its re-run
    is the book's first METERED analysis and reserves a slot. The process
    dies; the reservation is orphaned. The sweep must decide by what the RUN
    did, not by the document's status — which a staged re-run never changes:
    a staged row still in the store, or a row that says the re-run did not
    finish, means exactly that (released, nothing counted, nothing billed);
    no staged row and no such text means its takeover completed (counted,
    once)."""
    arm, expected = _METERED_DEATHS[death]
    w = _world(app, gw, monkeypatch, WORKS)
    # The plan never counted this book: no record of it in the ledger.
    gw.db.tables["document_quota_ledger"] = [
        r for r in gw.db.rows("document_quota_ledger") if r["document_id"] != w["doc1"]]
    reserved = list(gw.meter.reserved)
    store = tmp_path / ("%s.pickle" % death)
    seen = arm(gw, monkeypatch, store, w["month"])

    _click_and_die(app, gw, w, seen)

    assert gw.meter.reserved == reserved + [V.USER], "the scenario never happened: the re-run was not metered"
    (ledger,) = [r for r in R.frozen_tables(store)["document_quota_ledger"] if r["document_id"] == w["doc1"]]
    assert ledger["reserved_at"] and not ledger["committed_at"] and not ledger["released_at"], ledger
    (doc,) = [d for d in R.frozen_tables(store)["documents"] if d["id"] == w["doc1"]]
    assert doc["status"] == "analyzed", doc                    # … whatever the run had done

    report = R.second_process(store, [{"op": "settle_orphans"}], tmp_path)
    (settled,) = report["steps"]

    assert settled["outstanding"] == [w["doc1"]], settled
    if expected == "released":
        assert settled["committed"] == [] and settled["released"] == [[V.USER, False]], (
            "%s: the sweep COUNTED a re-run that never finished: %r" % (death, settled))
    else:
        assert settled["committed"] == [[V.USER, False]] and settled["released"] == [], settled


# ══════════════════════════════════════════════════════════════════════
# T6 — the second process is a second process
# ══════════════════════════════════════════════════════════════════════


def test_the_second_process_is_another_process_of_the_tree_under_test_and_starts_from_nothing(
        app, gw, monkeypatch, tmp_path):
    """The harness's own law (a harness that thaws into the SAME process, or
    into the main checkout's engine, proves nothing): another pid; the
    `engine` package of this tree; every registry empty before the thaw; no
    `_RERUN_CARRY` to be empty or not. And POSITIVE CONTROL of freeze / thaw:
    a store frozen with no kill at all is served by the second process
    exactly as this process serves it."""
    w = _world(app, gw, monkeypatch, WORKS)
    store = tmp_path / "no_kill.pickle"
    R.freeze(gw, store)

    report = R.second_process(store, [
        {"op": "view", "label": "the same store", "org": w["org"], "period": w["month"]}], tmp_path)

    registries = report["registries"]
    assert registries["pid"] != os.getpid(), "the 'second process' is this process"
    assert registries["engine_file"].startswith(R.engine_src()) and \
        os.path.realpath(P.__file__).startswith(R.engine_src()), (registries["engine_file"], P.__file__)
    assert (registries["in_flight"], registries["takeovers"], registries["periods_minted"],
            registries["staged_reruns"]) == ({}, {}, {}, {}), registries
    assert registries["has_a_rerun_carry"] is False and not hasattr(P, "_RERUN_CARRY")
    (view,) = report["steps"]
    assert view["reader"] == w["reader_before"] and view["store"] == w["store_before"]
