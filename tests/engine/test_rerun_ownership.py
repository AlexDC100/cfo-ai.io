"""A RE-RUN ACTS ONLY ON A PERIOD THAT IS THE DOCUMENT'S OWN — gate `rerun-data-loss`.

THE DEFECT (hand-over 2026-10-04, item 1; measured on 7ca386ec through the
real routes). `POST /api/pipeline/retry` reset "the period the document is
pinned to" — `documents.period_id`, a column the BROWSER writes — filtered by
id and company alone. Nothing asked whether that period was still the
analysis of THIS document (`financial_periods.source_document_id`, the
pointer the engine writes):

  · doc1 analysed; the same company's month uploaded again (doc2) took the
    month over — doc1 archived with the superseded marker, STILL pinned to
    the month's row; doc1 restored from the shelf; "Re-run analysis" on doc1
    answered 202, DELETED doc2's period (doc2 left `analyzed`, pinned to
    nothing), carried doc2's briefing and recommendations for doc1, and the
    month came back as the OLDER file's statements under them;
  · a pin the company filter rejected, or no pin at all, matched nothing —
    and the run then found the document's real period by its own tuple and
    ran IN PLACE (the withdrawn design: a failing run leaves a FAILED
    document over a served period).

The sibling sweep found the same question unanswered in three more places:
`make-active` / `move-period` of a DELETED document (the month is emptied and
nothing rebuilds it — every entry refuses a deleted document), `move-period`
deleting the period it leaves when the month's own document is in the bin,
and `stage_persist`'s race-loser adopting ANY row of the month.

THE LAW.
  O1  A re-run of a restored, superseded document is REFUSED: 409, the body
      is the committed fixture, nothing is written, the month is served
      exactly as before. (Control: the month's own document re-runs.) The
      same for a sales document the Products upload pinned to the month.
  O2  The refusal is ONE answer whatever the pin names — another company's
      period, or an id that names nothing: same status, same body, no id.
  O3  The refusal comes BEFORE the claim and the meter: no write at all.
  O4  The period changing hands between the route's look and the claim is
      refused under the claim, and the claim — and a metered re-run's
      reservation — is given back.
  O5  The reset deletes only a period this document is the source of: the
      DELETE names id, company and source, and is followed by a re-read — a
      period that changed hands a moment before the delete is not deleted,
      the carry is as it was, the re-run is refused.
  O6  A document with NO pin is never re-run in place: its period is found
      by the pointer the engine wrote, and reset.
  O7  A period that names no source is the document's only when its
      analysis says so, or — with no stamp — when no other document of the
      company, live or deleted, is pinned to it. NULL is never "anyone's".
  O8  When ownership cannot be read the re-run is not started (503).
  O9  `make-active` and `move-period` of a deleted document are refused
      before any write.
  O10 A move never deletes a period whose analysis is another document's.
  O11 A run whose period insert failed adopts only its OWN row.
  O12 Census: every `delete("financial_periods", …)` in the engine is one of
      the six sites stated here, each with its ownership rule.

STAGE 1 OF 3 (design of 2026-10-04). The reset and the in-memory carry are
still production's; stage 2 replaces the reset with a re-run STAGED beside
the document's own month (O5 then becomes "no delete at all"), stage 3 takes
the AI lane through the same mechanism.

WHAT RUNS HERE. The REAL `create_app()` routes (`POST /api/pipeline/retry`,
`/api/documents/{id}/restore`, `DELETE /api/documents/{id}`, the upload
card's identify + commit), the real `_run_pipeline_sync` from `stage_extract`
to the takeover, the real `GET /api/period` and year tiles — in the `gw`
world of test_workspace_v2_gates with the helpers of the writers file of
gate briefing-keep-last-good. Doubled: PostgREST + Storage (the projection-
faithful double), the provider (scripted per run), the meter, the daemon
thread. `make-active` / `move-period` are driven as the FUNCTIONS the routes
call (`_period_move`), over the same store: the routes bind the service-role
client when the app is built, before the `gw` fixture replaces it.

Two things the double does not model are modelled here by hand
(`_production_foreign_keys`): a period's children going with it (ON DELETE
CASCADE), and `documents.period_id` set NULL when its period is deleted.

WHAT THESE RED ON, with the defect repaired (TC-11):
  · a re-run that reads, carries from, deletes or resets a period whose
    source is another document — at the route, under the claim, or at the
    DELETE itself;
  · a refusal that writes, claims, meters, enqueues, or tells "another
    company's period" from "no such period";
  · a refusal body carrying a message, a period id or a document id;
  · a document with no pin, or with a pin that names nothing of its
    company, re-running in place;
  · a source-less period treated as anyone's;
  · a deleted document promoted or moved; a move deleting a period whose
    analysis is another document's, or deleting by id alone;
  · the race-loser adopting another document's row;
  · a new `delete("financial_periods"` site nobody classified.

CANNOT SEE.
  · Postgres itself: the foreign keys (modelled by hand here), row security,
    whether production holds source-less periods or documents pinned to a
    period that names another document (the owner's read-only count).
  · A hand-over INSIDE one HTTP statement, and two backend processes: the
    look, the carry and the delete are three statements; the DELETE's own
    filter and the re-read are what hold between them.
  · `make-active` on a LIVE attachment, which deletes the month's briefing
    before its own re-run by design (ticket), and an OLDER document's FIRST
    run replacing a newer document's month through `/api/pipeline/run` or
    recover-stuck (G4's rule; owner ruling needed).
  · The Docs panel printing the refusal: gate `rerun-refusal-surfaces`
    (vitest), which reads the same fixture file O1 holds the route to.
  · A restart between the reset and the run (the carry is in memory until
    stage 2).

PLANT LOG: docs/engine_book/gates.md "rerun-data-loss".
"""
from __future__ import annotations

import ast
import copy
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
import pytest

import test_briefing_keep_last_good_writers as W
import test_workspace_v2_gates as V
from test_workspace_v2_gates import app, gw  # noqa: F401 — pytest fixtures
from engine.api import _doc_dedupe
from engine.api import _period_move as PM
from engine.api import pipeline as P
from engine.workspaces.migration_plan import empty_live_periods

REPO = Path(__file__).resolve().parents[2]
ENGINE_SRC = REPO / "src" / "engine"

#: What the REAL route answers a re-run of a superseded document with —
#: committed, and read by the Docs panel's own law (gate
#: rerun-refusal-surfaces): an intercepted route is a route with no gate.
REFUSED_SUPERSEDED_FIXTURE = REPO / "tests" / "engine" / "fixtures" / "rerun" / "retry_refused_superseded.json"

# ── THE EXPECTED ANSWERS, stated here — never read from the code under test ──
REFUSED_SUPERSEDED = {"detail": {"code": "document_superseded"}}
REFUSED_NOT_OWN = {"detail": {"code": "rerun_period_not_own"}}
REFUSED_UNAVAILABLE = {"detail": {"code": "rerun_unavailable"}}

FOREIGN_PID = "f0e16000-0000-4000-8000-00000000f0e1"    # a period of ANOTHER company
NOTHING_PID = "0badc0de-0000-4000-8000-000000000404"    # an id that names nothing
OTHER_DOC = "0d0c0000-0000-4000-8000-0000000000d2"      # another document of the SAME company
OTHER_PID = "0d0c0000-0000-4000-8000-0000000000b2"      # … and a period of its own


# ══════════════════════════════════════════════════════════════════════
# The worlds
# ══════════════════════════════════════════════════════════════════════


def _production_foreign_keys(gw, monkeypatch) -> None:
    """What production's foreign keys do when a period row is deleted and
    the double does not: its children go with it (ON DELETE CASCADE) and
    every document pinned to it is unpinned (`documents.period_id` ON DELETE
    SET NULL, schema_phase3.sql). Install BEFORE `_Spy`: these are the
    database's writes, not the engine's."""
    real = gw.db.delete

    def delete(table: str, *args: Any, **kwargs: Any) -> Any:
        gone = []  # type: List[str]
        if table == "financial_periods":
            gone = [str(r["id"]) for r in gw.db.select("financial_periods",
                                                       filters=kwargs.get("filters") or {})]
        out = real(table, *args, **kwargs)
        for period_id in gone:
            for child in W._PERIOD_CHILD_TABLES:
                real(child, filters={"period_id": "eq.%s" % period_id})
            for doc in gw.db.rows("documents"):
                if str(doc.get("period_id")) == period_id:
                    doc["period_id"] = None
        return out

    monkeypatch.setattr(gw.db, "delete", delete)


def _own_month(app, gw, monkeypatch, outcomes: List[Any]) -> Dict[str, Any]:
    """doc1: Agras's December analysed with a narration that worked (BODY_A),
    one recommendation worked by a user; the database behaving as
    production's; the provider scripted with `outcomes` for what follows."""
    monkeypatch.setattr(P, "_RERUN_CARRY", {})
    _production_foreign_keys(gw, monkeypatch)
    W._script_the_provider(monkeypatch, [W._reply(W.BODY_A, W.TITLES_A)] + list(outcomes))
    first = W._first_analysis(app, gw)
    worked_title = W._work_a_recommendation(gw)
    return dict(first, worked_title=worked_title, doc1=first["doc"]["id"], org=first["org_id"],
                month=first["period_id"],
                recommendations=copy.deepcopy(gw.db.rows("recommendations")))


def _superseded(app, gw, monkeypatch, outcomes: List[Any]) -> Dict[str, Any]:
    """…then the same company's December uploaded AGAIN with other figures
    (doc2) takes the month over: the month's row names doc2, doc1 is archived
    with the superseded marker and is STILL pinned to the month's row. A user
    works one of doc2's recommendations."""
    w = _own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B)] + list(outcomes))
    doc2 = W._reupload(app, gw, w["org"])
    assert doc2["status"] == "analyzed" and doc2["period_id"] == w["month"], (doc2["status"], doc2.get("error"))
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == w["month"] and period["source_document_id"] == doc2["id"], period
    (d1,) = gw.docs(id=w["doc1"])
    assert d1["deleted_at"] is not None and str(d1["error"]).startswith("superseded_by:") and \
        d1["period_id"] == w["month"], d1            # archived, and STILL pinned to the month
    assert [b["body"] for b in gw.db.rows("briefings")] == [W.BODY_B]
    W._work_a_recommendation(gw)
    return dict(w, doc2=doc2["id"])


def _restore(app, gw, org_id: str, document_id: str) -> None:
    """The Docs panel's "Recently deleted" shelf: POST …/restore."""
    r = V._http(app).post("/api/documents/%s/restore" % document_id, headers=V._headers(V.USER, org_id))
    assert r.status_code == 200, r.text[:300]
    (doc,) = gw.docs(id=document_id)
    assert doc["deleted_at"] is None, doc


def _superseded_then_restored(app, gw, monkeypatch, outcomes: List[Any]) -> Dict[str, Any]:
    """…and doc1 is restored from "Recently deleted": a live, analysed
    document pinned to a month that is another document's — the state the
    hand-over's re-run destroyed the newer month from."""
    w = _superseded(app, gw, monkeypatch, outcomes)
    _restore(app, gw, w["org"], w["doc1"])
    (d1,) = gw.docs(id=w["doc1"])
    assert d1["deleted_at"] is None and d1["status"] == "analyzed" and d1["period_id"] == w["month"], d1
    return w


def _retry(app, org_id: str, document_id: str):
    """What `DocsPanel.tsx` sends for "Re-run analysis" on an analysed row."""
    return V._http(app).post("/api/pipeline/retry", headers=V._headers(V.USER, org_id),
                             json={"document_id": document_id})


def _month_view(app, gw, org_id: str, period_id: str) -> Dict[str, Any]:
    """Everything a reader is served of a month, and every row stored under
    it: the year tiles, the dashboard body's figures, briefing,
    recommendations and alerts."""
    body = W._served_period(app, org_id, period_id)
    return {"tiles_and_figures": V._served(app, org_id, period_id),
            "briefing": body["briefing"], "recommendations": body["recommendations"],
            "alerts": body.get("alerts"), "rows": V._rows_under(gw, period_id)}


def _nothing_was_started(gw, document_id: str, enqueued_before: List[str]) -> None:
    assert gw.enqueued == enqueued_before, "a refused re-run was enqueued: %r" % gw.enqueued[len(enqueued_before):]
    assert _doc_dedupe.in_flight(document_id) is None, "a refused re-run left the document in flight"


def _claim_writes_only(spy: W._Spy, document_id: str) -> None:
    """The only writes of a re-run refused UNDER the claim: the claim's stamp
    and its release — `pipeline_started_at` on the document, twice."""
    assert [(w["op"], w["table"], sorted(w["payload"] or {})) for w in spy.writes] == \
        [("update", "documents", ["pipeline_started_at"])] * 2, spy.writes
    assert all(w["filters"].get("id") == "eq.%s" % document_id for w in spy.writes), spy.writes


# ══════════════════════════════════════════════════════════════════════
# O1 — the hand-over's reproduction, as a law
# ══════════════════════════════════════════════════════════════════════


def test_the_fixture_the_docs_panel_law_reads_is_the_answer_stated_here():
    """The committed body is what this file expects of the route — and what
    the vitest law of gate rerun-refusal-surfaces feeds the Docs panel."""
    assert json.loads(REFUSED_SUPERSEDED_FIXTURE.read_text(encoding="utf-8")) == REFUSED_SUPERSEDED


def test_a_rerun_of_a_restored_superseded_document_is_refused_and_changes_nothing(app, gw, monkeypatch):
    """Measured on 7ca386ec: 202, the month's period — the NEWER document's —
    deleted, and after the run the month was the OLDER file's statements
    under the newer document's briefing and recommendations."""
    w = _superseded_then_restored(app, gw, monkeypatch, [RuntimeError(W.PROVIDER_ERROR_TEXT)])
    month_before = _month_view(app, gw, w["org"], w["month"])
    assert month_before["tiles_and_figures"]["source_document"] == w["doc2"]
    assert month_before["briefing"]["body"] == W.BODY_B
    state_before, enqueued_before = gw.state(), list(gw.enqueued)
    spy = W._Spy(gw.db, monkeypatch)

    r = _retry(app, w["org"], w["doc1"])

    assert r.status_code == 409, (r.status_code, r.text[:300])
    assert r.json() == json.loads(REFUSED_SUPERSEDED_FIXTURE.read_text(encoding="utf-8")) == REFUSED_SUPERSEDED
    # A code, and nothing else: no sentence of the server's, no id of anything.
    for leaked in (w["month"], w["doc1"], w["doc2"], w["org"], "message"):
        assert leaked not in r.text, "the refusal names %r: %s" % (leaked, r.text)
    assert spy.writes == [], "a refused re-run wrote: %r" % spy.writes
    assert gw.state() == state_before, "a refused re-run changed the store"
    _nothing_was_started(gw, w["doc1"], enqueued_before)
    assert P._RERUN_CARRY == {}, "a refused re-run carried the newer document's briefing: %r" % P._RERUN_CARRY
    assert _month_view(app, gw, w["org"], w["month"]) == month_before, \
        "the month is not served as it was before the refused re-run"

    # CONTROL: the month's OWN document still re-runs — accepted, analysed,
    # and (the provider refusing) its briefing and recommendations kept.
    r = _retry(app, w["org"], w["doc2"])
    assert r.status_code == 202 and r.json()["status"] == "queued", (r.status_code, r.text[:300])
    rerun = V.run_analysis(gw, w["doc2"])
    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    (period,) = gw.db.rows("financial_periods")
    assert period["source_document_id"] == w["doc2"], period
    after = _month_view(app, gw, w["org"], period["id"])
    assert after["tiles_and_figures"]["revenue"] == month_before["tiles_and_figures"]["revenue"]
    assert after["briefing"]["body"] == W.BODY_B
    assert sorted(x["title"] for x in after["recommendations"]) == W.TITLES_B
    worked = [x for x in gw.db.rows("recommendations")
              if dict((k, x[k]) for k in W.WORKED) == W.WORKED]
    assert len(worked) == 1, "the worked recommendation did not come through the owner's re-run"
    # doc1 is still what it was: live, analysed, the superseded marker on it.
    (d1,) = gw.docs(id=w["doc1"])
    assert d1["status"] == "analyzed" and str(d1["error"]).startswith("superseded_by:"), d1


def test_a_sales_document_pinned_to_the_month_never_resets_the_months_period(app, gw, monkeypatch):
    """The Products upload pins a sales (SKU) workbook to the month that is
    open (`uploadDocument`'s `periodId`), so it nests under that month's
    source files: its `documents.period_id` names the month's FINANCIAL
    period — the trial balance's analysis. Sent through this route, its
    re-run reset "the period it is pinned to": the month's financial
    analysis, deleted by re-running a sales file. A sales document owns no
    period; the month is another document's, so the re-run is refused and
    nothing is written. (No screen sends a sales document here — its re-run
    is POST /api/sales-datasets/{id}/rerun; the refusal's CODE is the one
    today's rule answers for any pin that names another document's period.)"""
    w = _own_month(app, gw, monkeypatch, [])
    gw.db.insert("documents", dict(w["doc"], id=OTHER_DOC, scope="sku", original_filename="vanzari.xlsx",
                                   content_hash="%064x" % 0x5c0, detected_type="sales_dataset"))
    (sales,) = gw.docs(id=OTHER_DOC)
    assert sales["period_id"] == w["month"] and sales["status"] == "analyzed"
    month_before = _month_view(app, gw, w["org"], w["month"])
    state_before, enqueued_before = gw.state(), list(gw.enqueued)
    spy = W._Spy(gw.db, monkeypatch)

    r = _retry(app, w["org"], OTHER_DOC)

    assert r.status_code == 409 and r.json() == REFUSED_SUPERSEDED, (r.status_code, r.text[:300])
    assert spy.writes == [], "a refused re-run wrote: %r" % spy.writes
    assert gw.state() == state_before
    _nothing_was_started(gw, OTHER_DOC, enqueued_before)
    assert P._RERUN_CARRY == {}
    assert _month_view(app, gw, w["org"], w["month"]) == month_before


# ══════════════════════════════════════════════════════════════════════
# O2 — one answer whatever the pin names
# ══════════════════════════════════════════════════════════════════════


def test_the_refusal_is_one_answer_whatever_the_pin_names(app, gw, monkeypatch):
    """`documents.period_id` is browser-written. Pointed at ANOTHER COMPANY's
    period, or at an id that names nothing, the re-run is refused with the
    same status and the same body — the caller learns nothing about whether
    that other period exists — and nothing of either company changes.
    (Before: the reset matched nothing and the run went IN PLACE.)"""
    w = _own_month(app, gw, monkeypatch, [])
    gw.db.add("financial_periods", {"id": FOREIGN_PID, "org_id": V.WU.ORG_OUTSIDE, "currency": "RON",
                                    "period_start": "2025-12-31", "period_end": "2025-12-31",
                                    "source_document_id": None})
    gw.db.add("briefings", {"period_id": FOREIGN_PID, "org_id": V.WU.ORG_OUTSIDE,
                            "body": "Comentariul altei companii.", "language": "ro"})
    gw.db.add("statement_line_items", {"period_id": FOREIGN_PID, "statement": "pl", "bucket": "revenue",
                                       "ro_account_code": "707", "amount": 1.0})
    enqueued_before = list(gw.enqueued)
    spy = W._Spy(gw.db, monkeypatch)
    answers = {}  # type: Dict[str, Tuple[int, str]]
    for what, pin in (("another_companys_period", FOREIGN_PID), ("an_id_that_names_nothing", NOTHING_PID)):
        (d1,) = gw.docs(id=w["doc1"])
        d1["period_id"] = pin                       # what a browser can write
        state_before = gw.state()
        del spy.writes[:]

        r = _retry(app, w["org"], w["doc1"])

        answers[what] = (r.status_code, r.text)
        assert spy.writes == [], "%s: a refused re-run wrote: %r" % (what, spy.writes)
        assert gw.state() == state_before, "%s: a refused re-run changed the store" % what
        _nothing_was_started(gw, w["doc1"], enqueued_before)
    assert answers["another_companys_period"] == answers["an_id_that_names_nothing"], answers
    status, text = answers["another_companys_period"]
    assert status == 409 and json.loads(text) == REFUSED_NOT_OWN, answers
    for leaked in (FOREIGN_PID, NOTHING_PID, w["month"], w["doc1"], V.WU.ORG_OUTSIDE, "message"):
        assert leaked not in text, "the refusal names %r: %s" % (leaked, text)
    # The document's own month is still there, whole: nothing ran in place.
    assert [p["id"] for p in gw.db.rows("financial_periods") if p["org_id"] == w["org"]] == [w["month"]]
    assert P._RERUN_CARRY == {}


# ══════════════════════════════════════════════════════════════════════
# O3 — before the claim and the meter
# ══════════════════════════════════════════════════════════════════════


def test_the_refusal_comes_before_the_claim_and_the_meter(app, gw, monkeypatch):
    """A document whose re-run WOULD be metered — a second upload for the
    month whose first run failed, pinned by the browser to the month's
    period (the upload card files a row with the open period's id) — is
    refused before anything is claimed, reserved or written. (Refused only
    under the claim, the claim's stamp is a write and the meter is asked.)"""
    w = _own_month(app, gw, monkeypatch, [])
    second = V.one_tap(app, W._corrected_december(), "balanta_corectata.xlsx")
    doc2 = second["commit"]["document_id"]
    real_compute = P.stage_compute

    def _boom(*a: Any, **kw: Any) -> Any:
        raise RuntimeError("compute failed")

    monkeypatch.setattr(P, "stage_compute", _boom)
    failed = V.run_analysis(gw, doc2)
    monkeypatch.setattr(P, "stage_compute", real_compute)
    assert failed["status"] == "failed" and failed["period_id"] is None, failed
    assert [p["source_document_id"] for p in gw.db.rows("financial_periods")] == [w["doc1"]]
    (d2,) = gw.docs(id=doc2)
    d2["period_id"] = w["month"]                    # what a browser can write
    stamp_before = d2.get("pipeline_started_at")
    meter_before = (list(gw.meter.reserved), list(gw.meter.committed), list(gw.meter.released))
    state_before, enqueued_before = gw.state(), list(gw.enqueued)
    spy = W._Spy(gw.db, monkeypatch)

    r = _retry(app, w["org"], doc2)

    assert r.status_code == 409 and r.json() == REFUSED_SUPERSEDED, (r.status_code, r.text[:300])
    assert spy.writes == [], "the refusal came after a write (the claim's stamp?): %r" % spy.writes
    assert (list(gw.meter.reserved), list(gw.meter.committed), list(gw.meter.released)) == meter_before, \
        "the refusal came after the meter was asked"
    (d2,) = gw.docs(id=doc2)
    assert d2.get("pipeline_started_at") == stamp_before and d2["status"] == "failed", d2
    assert gw.state() == state_before
    _nothing_was_started(gw, doc2, enqueued_before)


# ══════════════════════════════════════════════════════════════════════
# O4 — the look is repeated under the claim
# ══════════════════════════════════════════════════════════════════════


def test_a_period_that_changes_hands_between_the_look_and_the_claim_is_refused_under_the_claim(
        app, gw, monkeypatch):
    """The route's look comes before the claim; a newer upload's takeover
    can land in between. The look is made AGAIN under the claim: 409, no
    delete even attempted, the month's briefing and recommendations never
    read into a carry, and the claim given back."""
    w = _own_month(app, gw, monkeypatch, [RuntimeError(W.PROVIDER_ERROR_TEXT)])
    gw.db.insert("documents", dict(w["doc"], id=OTHER_DOC, content_hash="%064x" % 0xd0c2))
    (d1_before,) = copy.deepcopy(gw.docs(id=w["doc1"]))
    enqueued_before = list(gw.enqueued)
    real_start = P._start_rerun
    landed = []  # type: List[str]

    def start_after_a_takeover_landed(doc: Dict[str, Any], caller_id: str, start: Any) -> Any:
        if not landed:
            landed.append(str(doc["id"]))
            # A newer upload's run has just become the month.
            gw.db.update("financial_periods", {"source_document_id": OTHER_DOC},
                         filters={"id": "eq.%s" % w["month"]})
        return real_start(doc, caller_id, start)

    monkeypatch.setattr(P, "_start_rerun", start_after_a_takeover_landed)
    rows_before = V._rows_under(gw, w["month"])
    spy = W._Spy(gw.db, monkeypatch)
    reads = []  # type: List[str]
    real_select = gw.db.select

    def select(table: str, *args: Any, **kwargs: Any) -> Any:
        if table in ("briefings", "recommendations"):
            reads.append(table)
        return real_select(table, *args, **kwargs)

    monkeypatch.setattr(gw.db, "select", select)

    r = _retry(app, w["org"], w["doc1"])

    assert landed == [w["doc1"]], "the scenario never happened"
    assert r.status_code == 409 and r.json() == REFUSED_SUPERSEDED, (r.status_code, r.text[:300])
    assert [x for x in spy.writes if x["op"] == "delete"] == [], \
        "a delete was attempted on a period that is another document's: %r" % spy.writes
    spy.writes = [x for x in spy.writes if x["table"] != "financial_periods"]   # the test's own hand-over
    _claim_writes_only(spy, w["doc1"])
    assert reads == [], "the other document's %s were read into a carry" % sorted(set(reads))
    assert P._RERUN_CARRY == {}
    _nothing_was_started(gw, w["doc1"], enqueued_before)
    assert gw.docs(id=w["doc1"]) == [d1_before], "the refusal did not give the claim back"
    assert V._rows_under(gw, w["month"]) == rows_before
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == w["month"] and period["source_document_id"] == OTHER_DOC

    # CONTROL: the claim was given back — once the month is the document's
    # again, its re-run is accepted and runs.
    monkeypatch.setattr(gw.db, "select", real_select)
    gw.db.update("financial_periods", {"source_document_id": w["doc1"]}, filters={"id": "eq.%s" % w["month"]})
    again = W._docs_panel_rerun(app, gw, w)
    assert again["status"] == "analyzed", (again["status"], again.get("error"))
    assert W._served_period(app, w["org"], again["period_id"])["briefing"]["body"] == W.BODY_A


def test_a_metered_rerun_refused_under_the_claim_gives_its_reservation_back(app, gw, monkeypatch):
    """A re-run that is the book's FIRST analysis reserves on the meter
    between the claim and the reset. Refused under the claim, it must leave
    nothing behind: the reservation released (never committed), the claim
    given back, the month untouched. Here a failed, uncounted upload holds
    no period at the route's look; the browser pins it to the month's
    period a moment later."""
    w = _own_month(app, gw, monkeypatch, [])
    second = V.one_tap(app, W._corrected_december(), "balanta_corectata.xlsx")
    doc2 = second["commit"]["document_id"]
    real_compute = P.stage_compute

    def _boom(*a: Any, **kw: Any) -> Any:
        raise RuntimeError("compute failed")

    monkeypatch.setattr(P, "stage_compute", _boom)
    failed = V.run_analysis(gw, doc2)
    monkeypatch.setattr(P, "stage_compute", real_compute)
    assert failed["status"] == "failed" and failed["period_id"] is None, failed
    (d2_before,) = copy.deepcopy(gw.docs(id=doc2))
    month_before = _month_view(app, gw, w["org"], w["month"])
    reserved, committed, released = (list(gw.meter.reserved), list(gw.meter.committed), list(gw.meter.released))
    enqueued_before = list(gw.enqueued)
    real_start = P._start_rerun
    pinned = []  # type: List[str]

    def start_after_the_browser_pinned_it(doc: Dict[str, Any], caller_id: str, start: Any) -> Any:
        if not pinned:
            pinned.append(str(doc["id"]))
            for row in gw.docs(id=doc2):
                row["period_id"] = w["month"]           # what a browser can write
        return real_start(doc, caller_id, start)

    monkeypatch.setattr(P, "_start_rerun", start_after_the_browser_pinned_it)

    r = _retry(app, w["org"], doc2)

    assert pinned == [doc2], "the scenario never happened"
    assert r.status_code == 409 and r.json() == REFUSED_SUPERSEDED, (r.status_code, r.text[:300])
    # The meter WAS asked (this is the book's first analysis) — and the
    # reservation went straight back; nothing was counted.
    assert gw.meter.reserved == reserved + [V.USER], "the scenario never happened: the re-run was not metered"
    assert gw.meter.released == released + [(V.USER, False)], \
        "a re-run refused under the claim kept its reservation: %r" % (gw.meter.released,)
    assert gw.meter.committed == committed
    _nothing_was_started(gw, doc2, enqueued_before)
    assert gw.docs(id=doc2) == [dict(d2_before, period_id=w["month"])], "the refusal did not give the claim back"
    assert _month_view(app, gw, w["org"], w["month"]) == month_before
    assert P._RERUN_CARRY == {}


# ══════════════════════════════════════════════════════════════════════
# O5 — the reset itself names the source, and looks again
# ══════════════════════════════════════════════════════════════════════

_EARLIER_CARRY = {"an_earlier_carry_is_held": True, "no_carry_is_held": False}


@pytest.mark.parametrize("cell", sorted(_EARLIER_CARRY))
def test_the_reset_deletes_only_a_period_this_document_is_the_source_of(app, gw, monkeypatch, cell):
    """Both looks passed; the month changes hands just before the DELETE
    executes. The delete names id, company AND source, so it matches
    nothing; the re-read finds the row still there: 409, the carry exactly
    what it was before this re-run, the document as it was, nothing
    enqueued, the other document's month whole."""
    w = _own_month(app, gw, monkeypatch, [])
    gw.db.insert("documents", dict(w["doc"], id=OTHER_DOC, content_hash="%064x" % 0xd0c2))
    earlier = None  # type: Optional[Dict[str, Any]]
    if _EARLIER_CARRY[cell]:
        # What a previous re-run of this document that failed before it
        # narrated still holds for it.
        earlier = {"org_id": w["org"], "recommendations": [],
                   "briefing": {"period_id": "an-earlier-period", "org_id": w["org"],
                                "body": "Comentariul purtat de o rulare anterioară.", "language": "ro"}}
        P._RERUN_CARRY[w["doc1"]] = copy.deepcopy(earlier)
    (d1_before,) = copy.deepcopy(gw.docs(id=w["doc1"]))
    rows_before = V._rows_under(gw, w["month"])
    enqueued_before = list(gw.enqueued)
    under_the_database = gw.db.delete
    handed_over = []  # type: List[Dict[str, str]]

    def delete(table: str, *args: Any, **kwargs: Any) -> Any:
        if table == "financial_periods" and not handed_over:
            handed_over.append(dict(kwargs.get("filters") or {}))
            for p in gw.db.rows("financial_periods"):
                if p["id"] == w["month"]:
                    p["source_document_id"] = OTHER_DOC     # a newer upload's takeover lands NOW
        return under_the_database(table, *args, **kwargs)

    monkeypatch.setattr(gw.db, "delete", delete)
    spy = W._Spy(gw.db, monkeypatch)

    r = _retry(app, w["org"], w["doc1"])

    assert handed_over == [{"id": "eq.%s" % w["month"], "org_id": "eq.%s" % w["org"],
                            "source_document_id": "eq.%s" % w["doc1"]}], \
        "the reset's DELETE does not name the period, its company and its source: %r" % handed_over
    assert r.status_code == 409 and r.json() == REFUSED_SUPERSEDED, (r.status_code, r.text[:300])
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == w["month"] and period["source_document_id"] == OTHER_DOC, \
        "the reset deleted a period that is another document's"
    assert V._rows_under(gw, w["month"]) == rows_before, "the other document's month is not whole"
    assert (P._RERUN_CARRY.get(w["doc1"]) == earlier) and \
        (set(P._RERUN_CARRY) == ({w["doc1"]} if earlier else set())), \
        "the carry is not what it was before the refused re-run: %r" % P._RERUN_CARRY
    assert gw.docs(id=w["doc1"]) == [d1_before], "a refused reset touched the document"
    _nothing_was_started(gw, w["doc1"], enqueued_before)
    # Nothing but the claim's stamp, the one delete that matched nothing,
    # and the claim's release.
    assert [(x["op"], x["table"]) for x in spy.writes] == [
        ("update", "documents"), ("delete", "financial_periods"), ("update", "documents")], spy.writes


# ══════════════════════════════════════════════════════════════════════
# O6 — no pin is not "no period": never in place
# ══════════════════════════════════════════════════════════════════════


def test_a_document_with_no_pin_is_reset_by_the_pointer_the_engine_wrote_never_run_in_place(
        app, gw, monkeypatch):
    """`documents.period_id` lost (a browser write, an earlier defect): the
    reset used to match nothing, the run found the document's period by its
    own tuple and went IN PLACE — and a run that failed left a FAILED
    document over a served month. The period is found by
    `financial_periods.source_document_id` and reset; the carry is read from
    it, and the next re-run serves the last good briefing."""
    w = _own_month(app, gw, monkeypatch, [RuntimeError(W.PROVIDER_ERROR_TEXT)])
    (d1,) = gw.docs(id=w["doc1"])
    d1["period_id"] = None
    real_compute = P.stage_compute

    def _boom(*a: Any, **kw: Any) -> Any:
        raise RuntimeError("compute failed")

    monkeypatch.setattr(P, "stage_compute", _boom)

    r = _retry(app, w["org"], w["doc1"])

    assert r.status_code == 202, (r.status_code, r.text[:300])
    assert gw.db.rows("financial_periods") == [], \
        "the document's own period was not reset: the run goes in place on %r" % gw.db.rows("financial_periods")
    failed = V.run_analysis(gw, w["doc1"])
    assert failed["status"] == "failed", (failed["status"], failed.get("error"))
    assert gw.db.rows("financial_periods") == [], "a failed re-run left a period"
    assert empty_live_periods(gw.db.tables) == []
    held = P._RERUN_CARRY.get(w["doc1"]) or {}
    assert (held.get("briefing") or {}).get("body") == W.BODY_A, \
        "the carry was not read from the document's own period: %r" % (held,)

    monkeypatch.setattr(P, "stage_compute", real_compute)
    again = W._docs_panel_rerun(app, gw, w)
    assert again["status"] == "analyzed", (again["status"], again.get("error"))
    body = W._served_period(app, w["org"], again["period_id"])
    assert body["briefing"]["body"] == W.BODY_A and body["briefing"]["unavailable"] is False, body["briefing"]
    assert W._rec_view(gw.db.rows("recommendations")) == W._rec_view(w["recommendations"])


# ══════════════════════════════════════════════════════════════════════
# O7 — a period that names no source
# ══════════════════════════════════════════════════════════════════════


def _no_stamp(period: Dict[str, Any]) -> None:
    period["assembled_canonical_v1"].pop("provenance", None)


def _pin_another(gw, w: Dict[str, Any], *, org: Optional[str] = None, deleted: bool = False) -> None:
    gw.db.insert("documents", dict(w["doc"], id=OTHER_DOC, org_id=org or w["org"], period_id=w["month"],
                                   content_hash="%064x" % 0xd0c2,
                                   deleted_at="2026-10-01T00:00:00+00:00" if deleted else None))


#: cell -> (what the store holds, the answer). The period's `source_document_id`
#: is NULL in every cell.
_SOURCELESS = {
    "its_analysis_names_this_document": (lambda gw, w, p: None, 202),
    "its_analysis_names_another_document":
        (lambda gw, w, p: p["assembled_canonical_v1"]["provenance"].update(source_document_id=OTHER_DOC), 409),
    "no_stamp_and_nobody_else_is_pinned": (lambda gw, w, p: _no_stamp(p), 202),
    "no_envelope_and_nobody_else_is_pinned": (lambda gw, w, p: p.update(assembled_canonical_v1=None), 202),
    "no_stamp_and_another_live_document_is_pinned": (lambda gw, w, p: (_no_stamp(p), _pin_another(gw, w)), 409),
    "no_stamp_and_another_deleted_document_is_pinned":
        (lambda gw, w, p: (_no_stamp(p), _pin_another(gw, w, deleted=True)), 409),
    # Another COMPANY's row pointing at this period (browser-written) proves
    # nothing about it and must not be able to block the owner's re-run.
    "no_stamp_and_only_another_companys_document_is_pinned":
        (lambda gw, w, p: (_no_stamp(p), _pin_another(gw, w, org=V.WU.ORG_OUTSIDE)), 202),
}  # type: Dict[str, Tuple[Any, int]]


@pytest.mark.parametrize("cell", sorted(_SOURCELESS))
def test_a_period_that_names_no_source_is_the_documents_only_when_that_can_be_shown(app, gw, monkeypatch, cell):
    """A row from before the pointer was written (or one a correction left
    without it). NULL is never "anyone's": the re-run is accepted only when
    the period's own analysis names this document, or — with no stamp — when
    no other document of the company, live or deleted, is pinned to it (the
    dedupe's own "names none" rule)."""
    arrange, expected = _SOURCELESS[cell]
    w = _own_month(app, gw, monkeypatch, [])
    (period,) = gw.db.rows("financial_periods")
    assert period["assembled_canonical_v1"]["provenance"]["source_document_id"] == w["doc1"]
    period["source_document_id"] = None
    arrange(gw, w, period)
    state_before, enqueued_before = gw.state(), list(gw.enqueued)
    spy = W._Spy(gw.db, monkeypatch)

    r = _retry(app, w["org"], w["doc1"])

    assert r.status_code == expected, (cell, r.status_code, r.text[:300])
    if expected == 409:
        assert r.json() == REFUSED_NOT_OWN, r.text[:300]
        assert spy.writes == [] and gw.state() == state_before, spy.writes
        _nothing_was_started(gw, w["doc1"], enqueued_before)
        assert P._RERUN_CARRY == {}
    else:
        # Reset as its own: the DELETE names the source it was read with.
        assert [x["filters"] for x in spy.writes if x["op"] == "delete" and x["table"] == "financial_periods"] == [
            {"id": "eq.%s" % w["month"], "org_id": "eq.%s" % w["org"], "source_document_id": "is.null"}], spy.writes
        assert [p for p in gw.db.rows("financial_periods") if p["org_id"] == w["org"]] == []
        assert (P._RERUN_CARRY[w["doc1"]]["briefing"] or {}).get("body") == W.BODY_A
        assert gw.enqueued == enqueued_before + [w["doc1"]]


# ══════════════════════════════════════════════════════════════════════
# O8 — ownership that cannot be read
# ══════════════════════════════════════════════════════════════════════

#: cell -> (the table whose read times out, which of the ownership reads).
_UNREADABLE = {
    "the_document_at_the_route": ("documents", 1),
    "the_period_at_the_route": ("financial_periods", 1),
    "the_period_under_the_claim": ("financial_periods", 2),
}  # type: Dict[str, Tuple[str, int]]


def _is_an_ownership_read(table: str, kwargs: Dict[str, Any]) -> bool:
    filters = kwargs.get("filters") or {}
    if table == "documents":
        return kwargs.get("columns") == "id,org_id,period_id"
    return table == "financial_periods" and str(filters.get("id", "")).startswith("eq.") and "org_id" in filters


@pytest.mark.parametrize("cell", sorted(_UNREADABLE))
def test_ownership_that_cannot_be_read_does_not_start_the_rerun(app, gw, monkeypatch, cell):
    """An unreadable period is never "own": 503 `rerun_unavailable`, nothing
    reset, nothing carried — at the route nothing written at all; under the
    claim, the claim given back. The same re-run works a moment later."""
    table, nth = _UNREADABLE[cell]
    w = _own_month(app, gw, monkeypatch, [RuntimeError(W.PROVIDER_ERROR_TEXT)])
    (d1_before,) = copy.deepcopy(gw.docs(id=w["doc1"]))
    month_before = _month_view(app, gw, w["org"], w["month"])
    enqueued_before = list(gw.enqueued)
    spy = W._Spy(gw.db, monkeypatch)
    real_select = gw.db.select
    seen = {"n": 0, "timed_out": 0}

    def select(tbl: str, *args: Any, **kwargs: Any) -> Any:
        if tbl == table and _is_an_ownership_read(tbl, kwargs):
            seen["n"] += 1
            if seen["n"] == nth:
                seen["timed_out"] += 1
                raise httpx.ReadTimeout("The read operation timed out")
        return real_select(tbl, *args, **kwargs)

    monkeypatch.setattr(gw.db, "select", select)

    r = _retry(app, w["org"], w["doc1"])

    assert seen["timed_out"] == 1, "the scenario never happened: %r" % seen
    assert r.status_code == 503 and r.json() == REFUSED_UNAVAILABLE, (r.status_code, r.text[:300])
    assert [x for x in spy.writes if x["op"] == "delete"] == [], "a re-run that could not look reset: %r" % spy.writes
    if nth == 1:
        assert spy.writes == [], spy.writes
    else:
        _claim_writes_only(spy, w["doc1"])
    assert gw.docs(id=w["doc1"]) == [d1_before]
    assert P._RERUN_CARRY == {}
    _nothing_was_started(gw, w["doc1"], enqueued_before)
    monkeypatch.setattr(gw.db, "select", real_select)
    assert _month_view(app, gw, w["org"], w["month"]) == month_before

    # CONTROL: readable again, the re-run is accepted and serves the briefing.
    again = W._docs_panel_rerun(app, gw, w)
    assert again["status"] == "analyzed", (again["status"], again.get("error"))
    assert W._served_period(app, w["org"], again["period_id"])["briefing"]["body"] == W.BODY_A


# ══════════════════════════════════════════════════════════════════════
# O9 — the siblings: a deleted document is neither promoted nor moved
# ══════════════════════════════════════════════════════════════════════

_CORRECTIONS = {
    "make_active": lambda db, row: PM.make_document_active(db, document=row, now=P._now_iso()),
    "move_period": lambda db, row: PM.move_document_to_period(
        db, document=row, target_period_end="2024-12", now=P._now_iso()),
}


@pytest.mark.parametrize("correction", sorted(_CORRECTIONS))
def test_a_deleted_document_is_neither_promoted_nor_moved(app, gw, monkeypatch, correction):
    """Measured on 7ca386ec with the superseded copy still ARCHIVED:
    make-active wiped the month's line items, metrics, briefing and
    valuations and re-pointed the month at the archived file — whose
    correction re-run is then refused as DELETED, so nothing ever rebuilt
    the month; move-period detached it and wrote its month hint. Every
    analysis entry refuses a deleted document; so do the corrections, before
    their first write."""
    w = _superseded(app, gw, monkeypatch, [])
    (row,) = copy.deepcopy(gw.docs(id=w["doc1"]))
    assert row["deleted_at"] is not None
    month_before = _month_view(app, gw, w["org"], w["month"])
    state_before = gw.state()
    spy = W._Spy(gw.db, monkeypatch)

    with pytest.raises(PM.MoveRefused) as refused:
        _CORRECTIONS[correction](gw.db, row)

    assert refused.value.code == "document_deleted", refused.value.code
    assert spy.writes == [], "%s of a deleted document wrote: %r" % (correction, spy.writes)
    assert gw.state() == state_before
    assert _month_view(app, gw, w["org"], w["month"]) == month_before

    # CONTROL: the guard is about the DELETED state — the live owner of the
    # month is still what make-active calls unchanged, and can still be moved.
    (owner,) = copy.deepcopy(gw.docs(id=w["doc2"]))
    if correction == "make_active":
        assert PM.make_document_active(gw.db, document=owner, now=P._now_iso())["changed"] is False
    else:
        record = PM.move_document_to_period(gw.db, document=owner, target_period_end="2024-12", now=P._now_iso())
        assert record["moved"] is True and record["from"]["action"] == "deleted", record


# ══════════════════════════════════════════════════════════════════════
# O10 — a move never deletes a period whose analysis is another document's
# ══════════════════════════════════════════════════════════════════════

MOVER = "0d0c0000-0000-4000-8000-0000000000a1"


def _from_period(*, source: Optional[str], stamp: Optional[str], envelope: bool = True) -> Dict[str, Any]:
    env = None  # type: Optional[Dict[str, Any]]
    if envelope:
        env = {"canonical_bs": {}}
        if stamp:
            env["provenance"] = {"source_document_id": stamp}
    return {"id": OTHER_PID, "org_id": "org", "period_end": "2025-12-31",
            "source_document_id": source, "assembled_canonical_v1": env}


_STAYING = {"id": OTHER_DOC, "deleted_at": None, "status": "analyzed", "scope": "financial",
            "created_at": "2026-01-01T00:00:00+00:00"}

#: cell -> (the period the mover leaves, the live documents that stay, the action).
_PLAN_CELLS = {
    # nobody live stays behind
    "alone_and_the_period_is_the_movers": (_from_period(source=MOVER, stamp=MOVER), [], "deleted"),
    "alone_and_the_pointer_alone_names_the_mover": (_from_period(source=MOVER, stamp=None, envelope=False), [], "deleted"),
    "alone_and_only_the_stamp_names_the_mover": (_from_period(source=None, stamp=MOVER), [], "deleted"),
    "alone_in_an_empty_container": (_from_period(source=None, stamp=None, envelope=False), [], "deleted"),
    "alone_and_the_period_is_another_documents": (_from_period(source=OTHER_DOC, stamp=OTHER_DOC), [], "kept"),
    "alone_and_the_stamp_names_another_document": (_from_period(source=None, stamp=OTHER_DOC), [], "kept"),
    "alone_and_the_pointer_names_another_document": (_from_period(source=OTHER_DOC, stamp=None, envelope=False), [], "kept"),
    "alone_beside_an_analysis_that_names_nobody": (_from_period(source=None, stamp=None), [], "kept"),
    # somebody stays (unchanged rules)
    "leaving_siblings_and_the_analysis_is_the_movers": (_from_period(source=MOVER, stamp=MOVER), [_STAYING], "rebuilt"),
    "leaving_siblings_and_the_analysis_is_theirs": (_from_period(source=OTHER_DOC, stamp=OTHER_DOC), [_STAYING], "kept"),
}  # type: Dict[str, Tuple[Dict[str, Any], List[Dict[str, Any]], str]]


@pytest.mark.parametrize("cell", sorted(_PLAN_CELLS))
def test_the_plan_deletes_the_period_left_behind_only_when_it_is_the_movers(cell):
    """`plan_move`, pure. With nobody live staying, the period the mover
    leaves used to be "deleted" whatever it held — also when its analysis is
    a document's that sits in "Recently deleted" (restorable for 30 days)."""
    from_period, siblings, action = _PLAN_CELLS[cell]
    plan = PM.plan_move(document={"id": MOVER}, from_period=from_period, siblings=siblings,
                        target_period_end="2024-12-31")
    assert plan.moved is True and plan.source_action == action, (cell, plan)
    assert plan.rebuild_document_id == (OTHER_DOC if action == "rebuilt" else None), plan


def test_a_move_never_deletes_a_period_whose_own_document_is_in_the_bin(app, gw, monkeypatch):
    """Measured on 7ca386ec: the month's own document (doc2) soft-deleted,
    the restored superseded copy (doc1) moved to another month — the month's
    period, doc2's analysis, was hard-deleted with its line items, metrics,
    briefing and valuations, and restoring doc2 then served nothing. The
    period is KEPT; restoring its document serves the month again."""
    w = _superseded_then_restored(app, gw, monkeypatch, [])
    month_before = _month_view(app, gw, w["org"], w["month"])
    r = V._http(app).delete("/api/documents/%s" % w["doc2"], headers=V._headers(V.USER, w["org"]))
    assert r.status_code == 200, r.text[:300]
    assert [p["id"] for p in gw.db.rows("financial_periods")] == [w["month"]]
    rows_before = V._rows_under(gw, w["month"])
    (row,) = copy.deepcopy(gw.docs(id=w["doc1"]))
    spy = W._Spy(gw.db, monkeypatch)

    record = PM.move_document_to_period(gw.db, document=row, target_period_end="2024-12", now=P._now_iso())

    assert record["moved"] is True and record["from"] == {
        "period_id": w["month"], "period_end": "2025-12-31", "action": "kept"}, record
    assert [x for x in spy.writes if x["op"] == "delete"] == [], \
        "the move deleted under a period that is another document's: %r" % spy.writes
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == w["month"] and period["source_document_id"] == w["doc2"], period
    assert V._rows_under(gw, w["month"]) == rows_before
    # The mover itself was detached and given its month, as a move does.
    (d1,) = gw.docs(id=w["doc1"])
    assert d1["period_id"] is None and d1["period_end_hint"] == "2024-12-31", d1

    _restore(app, gw, w["org"], w["doc2"])
    assert _month_view(app, gw, w["org"], w["month"]) == month_before, \
        "restoring the month's own document does not serve the month as it was"


def test_a_move_that_does_delete_the_emptied_period_names_its_company(app, gw, monkeypatch):
    """The mover's OWN period, nobody else attached: deleted, as before —
    and the DELETE names the company (it ran by id alone)."""
    w = _own_month(app, gw, monkeypatch, [])
    (row,) = copy.deepcopy(gw.docs(id=w["doc1"]))
    spy = W._Spy(gw.db, monkeypatch)

    record = PM.move_document_to_period(gw.db, document=row, target_period_end="2024-12", now=P._now_iso())

    assert record["from"]["action"] == "deleted", record
    assert [x["filters"] for x in spy.writes if x["op"] == "delete" and x["table"] == "financial_periods"] == [
        {"id": "eq.%s" % w["month"], "org_id": "eq.%s" % w["org"]}], spy.writes
    assert gw.db.rows("financial_periods") == []


# ══════════════════════════════════════════════════════════════════════
# O11 — the run whose period insert failed adopts only its own row
# ══════════════════════════════════════════════════════════════════════


def _fresh_upload(app, gw, monkeypatch) -> Dict[str, Any]:
    _production_foreign_keys(gw, monkeypatch)
    out = V.one_tap(app, V.agras_workbook(), "balanta.xlsx")
    assert gw.db.rows("financial_periods") == []
    return {"doc": out["commit"]["document_id"], "org": out["commit"]["org_id"]}


def test_a_run_whose_period_insert_was_refused_never_writes_into_another_documents_period(
        app, gw, monkeypatch):
    """`stage_persist`, the new-month branch. The insert is refused (a
    timeout) and by then ANOTHER document's row holds the month — an upload
    that won the race. The old "race-loser" re-selected by company and month
    alone, pinned this document to that row and rewrote its line items and
    envelope IN PLACE: another document's analysis under its name, with no
    staging and no takeover. The run fails; the other row is untouched."""
    u = _fresh_upload(app, gw, monkeypatch)
    real_insert = gw.db.insert
    raced = []  # type: List[Any]

    def insert(table: str, *args: Any, **kwargs: Any) -> Any:
        if table == "financial_periods" and not raced:
            raced.append(copy.deepcopy(args[0]))
            month = args[0]["period_end"]
            gw.db.add("documents", {"id": OTHER_DOC, "org_id": u["org"], "status": "analyzed",
                                    "period_id": OTHER_PID, "scope": "financial",
                                    "original_filename": "balanta_castigatoare.xlsx"})
            gw.db.add("financial_periods", {
                "id": OTHER_PID, "org_id": u["org"], "source_document_id": OTHER_DOC, "currency": "RON",
                "period_start": month, "period_end": month,
                "assembled_canonical_v1": {"provenance": {"source_document_id": OTHER_DOC}}})
            gw.db.add("statement_line_items", {"period_id": OTHER_PID, "statement": "pl", "bucket": "revenue",
                                               "ro_account_code": "707", "amount": 123.0})
            raise httpx.ReadTimeout("The read operation timed out")
        return real_insert(table, *args, **kwargs)

    monkeypatch.setattr(gw.db, "insert", insert)
    spy = W._Spy(gw.db, monkeypatch)

    failed = V.run_analysis(gw, u["doc"])

    assert raced, "the scenario never happened: no period insert was refused"
    (other,) = gw.db.rows("financial_periods")
    assert other["id"] == OTHER_PID and other["source_document_id"] == OTHER_DOC and \
        other["assembled_canonical_v1"] == {"provenance": {"source_document_id": OTHER_DOC}}, \
        "the run rewrote another document's period: %r" % other
    assert [x["amount"] for x in gw.db.rows("statement_line_items")] == [123.0], \
        "the run rewrote another document's line items"
    touching = [x for x in spy.writes if OTHER_PID in json.dumps([x["payload"], x["filters"]], default=str)]
    assert touching == [], "the run wrote into another document's period: %r" % touching
    assert failed["status"] == "failed" and failed["period_id"] is None, (failed["status"], failed["period_id"])


@pytest.mark.parametrize("then", ["the_run_succeeds", "the_run_fails"])
def test_a_run_whose_own_period_insert_landed_with_its_reply_lost_adopts_its_own_row(app, gw, monkeypatch, then):
    """CONTROL of the law above: the insert LANDED and only its reply was
    lost. The row that holds this document's own tuple is this run's — it is
    adopted (one period, the document's), and it is still the run's to take
    back if a later stage fails (G4: no period without an analysed file)."""
    u = _fresh_upload(app, gw, monkeypatch)
    lost = W._refuse_once(gw, monkeypatch, "insert", "financial_periods", land=True)
    if then == "the_run_fails":
        def _boom(*a: Any, **kw: Any) -> Any:
            raise RuntimeError("compute failed")

        monkeypatch.setattr(P, "stage_compute", _boom)

    doc = V.run_analysis(gw, u["doc"])

    assert lost, "the scenario never happened"
    if then == "the_run_succeeds":
        assert doc["status"] == "analyzed", (doc["status"], doc.get("error"))
        (period,) = gw.db.rows("financial_periods")
        assert period["source_document_id"] == u["doc"] and doc["period_id"] == period["id"], period
        assert V._served(app, u["org"], period["id"])["source_document"] == u["doc"]
    else:
        assert doc["status"] == "failed", doc["status"]
        assert gw.db.rows("financial_periods") == [], "the failed run left the period it had inserted"
        assert empty_live_periods(gw.db.tables) == []


# ══════════════════════════════════════════════════════════════════════
# O12 — census: who may delete a period, and by what rule
# ══════════════════════════════════════════════════════════════════════

#: (file under src/engine, function) -> (the ownership rule the site states,
#: the columns its filter must name). A NEW site is red until it is added
#: here with its rule — and every rule names the company.
PERIOD_DELETE_SITES = {
    ("api/pipeline.py", "_retry_rerun"): (
        "the re-run's reset: only a period `_own_periods_for_rerun` read as this document's, and "
        "the DELETE itself names the source (is.null for a legacy-own row); re-read afterwards",
        ("id", "org_id", "source_document_id")),
    ("api/pipeline.py", "_rollback_period_of_failed_run"): (
        "the period THIS failed run inserted, still naming the document, no other document pinned",
        ("id", "org_id", "source_document_id")),
    ("api/pipeline.py", "_finalize_same_month_takeover"): (
        "the STAGED row of this run, after its rows moved onto the month", ("id", "org_id")),
    ("api/pipeline.py", "_maybe_drop_empty_period"): (
        "a period NO document, live or deleted, is pinned to; never in an archived workspace",
        ("id", "org_id")),
    ("api/pipeline.py", "delete_period"): (
        "the user's explicit 'clear period' on a period of a company they are a member of",
        ("id", "org_id")),
    ("api/_period_move.py", "move_document_to_period"): (
        "the period a moved document leaves, only when `plan_move` says it is the mover's own "
        "analysis or an empty container", ("id", "org_id")),
}  # type: Dict[Tuple[str, str], Tuple[str, Tuple[str, ...]]]


def _period_delete_sites() -> Dict[Tuple[str, str], List[ast.Call]]:
    found = {}  # type: Dict[Tuple[str, str], List[ast.Call]]
    for path in sorted(ENGINE_SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        stack = []  # type: List[str]

        def walk(node: ast.AST) -> None:
            named = isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            if named:
                stack.append(node.name)  # type: ignore[attr-defined]
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "delete" and node.args
                    and isinstance(node.args[0], ast.Constant) and node.args[0].value == "financial_periods"):
                key = (path.relative_to(ENGINE_SRC).as_posix(), stack[-1] if stack else "<module>")
                found.setdefault(key, []).append(node)
            for child in ast.iter_child_nodes(node):
                walk(child)
            if named:
                stack.pop()

        walk(tree)
    return found


def test_census_every_delete_of_a_period_is_a_stated_site_with_its_ownership_rule():
    """A period is deleted in six places and nowhere else; a seventh is red
    until somebody states whose period it may delete. Each site's DELETE
    names the company, and the two that act for ONE document name the
    document the period must still be the analysis of."""
    found = _period_delete_sites()
    assert len(found) >= 6, "the census finds %d site(s): the walk is broken" % len(found)
    assert set(found) == set(PERIOD_DELETE_SITES), (
        "delete(\"financial_periods\", …) sites differ from the stated table.\n  unclassified: %s\n  gone: %s"
        % (sorted(set(found) - set(PERIOD_DELETE_SITES)), sorted(set(PERIOD_DELETE_SITES) - set(found))))
    for key, calls in sorted(found.items()):
        _rule, columns = PERIOD_DELETE_SITES[key]
        for call in calls:
            filters = next((k.value for k in call.keywords if k.arg == "filters"), None)
            rendered = ast.dump(filters) if filters is not None else ""
            missing = [c for c in columns if "'%s'" % c not in rendered]
            assert not missing, "%s:%d (%s): the DELETE's filter does not name %s" % (
                key[0], call.lineno, key[1], missing)
