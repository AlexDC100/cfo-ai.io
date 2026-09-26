"""A CORRECTION RE-RUN IS ONE RUN — it claims its document like every entry.

Verifier lens S (2026-09-21, S6 / S7 / S11) and lens R3: move-period and
make-active re-ran an ANALYSED document through `_admin_set_status('queued')`
+ `_enqueue` with no one-run-per-document claim (`try_mark_in_flight` /
`mark_running`), unlike /retry and the ai-lane re-extract. While that
correction ran, any other entry found the document neither in flight nor
`analyzed`:

  S6  a Docs-panel /retry → claimed, metered as the book's first analysis,
      3 enqueues, two daemon threads on one document
  S7  the failed banner's /run → the same
  S11 a second move-period before the first finished → the same, and the
      correction's terminal `clear_in_flight` dropped the metered run's claim
  R3  the same bytes uploaded during the correction were analysed (and
      counted) as a second copy — the running original was invisible

THE FIX: the analysed branch goes through the same entry as /retry
(`_start_rerun` → `_doc_dedupe.enter_analysis(RERUN)`: the claim, then
`mark_running`, then the enqueue — BUSY means not started). And a move or
make-active of a document whose run is in flight is refused 409
`analysis_in_progress` BEFORE anything is re-filed: the run in flight read
the document's month when it started, so re-filing it under that run would
land the analysis in the month the user just corrected away from.

WHAT THESE RED ON, with the defect repaired (TC-11):
  * a second daemon thread (a second enqueue) for a document whose
    correction re-run is in flight, through any entry;
  * a correction re-run that is not in the in-flight registry;
  * a move / make-active that re-files a document whose run is in flight;
  * the same bytes uploaded during a correction not being the duplicate of
    the running original.
"""
from __future__ import annotations

from engine.api import _doc_dedupe, pipeline

from test_duplicate_upload_gate import (  # noqa: F401 — the fixture
    EEI, OWNER, PERIOD, SCANDIA, _counted, _doc, _row, world,
)


def _analysed_book(world, doc_id="book"):
    world["db"].rows("documents").append(_doc(doc_id, h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": doc_id}).json()["status"] == "queued"
    world["finish"](doc_id, "analyzed")
    world["enqueued"].clear()


def test_a_move_period_correction_claims_its_document(world):
    _analysed_book(world)
    r = world["post"]("/api/documents/book/move-period", {"period_end": "2024-12-31"})
    assert r.status_code == 200, r.text
    assert world["enqueued"] == ["book"]
    assert _doc_dedupe.in_flight("book") == _doc_dedupe.RUNNING
    world["finish"]("book", "analyzed")
    assert _doc_dedupe.in_flight("book") is None


def test_s6_a_retry_during_a_correction_starts_no_second_run(world):
    meter = world["meter"]
    _analysed_book(world)
    calls = list(meter.calls)
    assert world["post"]("/api/documents/book/move-period", {"period_end": "2024-12-31"}).status_code == 200
    r = world["post"]("/api/pipeline/retry", {"document_id": "book"})
    assert r.status_code == 202, r.text
    assert world["enqueued"] == ["book"], ("two daemon threads on one document", world["enqueued"])
    world["finish"]("book", "analyzed")
    assert meter.calls == calls and meter.snapshot()["uploads"] == 1


def test_s7_the_failed_banners_run_during_a_correction_starts_no_second_run(world):
    meter = world["meter"]
    _analysed_book(world)
    calls = list(meter.calls)
    assert world["post"]("/api/documents/book/move-period", {"period_end": "2024-12-31"}).status_code == 200
    r = world["post"]("/api/pipeline/run", {"document_id": "book"})
    assert r.status_code == 202, r.text
    assert world["enqueued"] == ["book"], world["enqueued"]
    assert meter.calls == calls


def test_s11_a_second_move_while_the_first_correction_runs_is_refused_before_it_refiles(world):
    meter = world["meter"]
    _analysed_book(world)
    calls = list(meter.calls)
    assert world["post"]("/api/documents/book/move-period", {"period_end": "2024-12-31"}).status_code == 200
    r = world["post"]("/api/documents/book/move-period", {"period_end": "2023-12-31"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "analysis_in_progress", r.text
    assert _row(world, "book")["period_end_hint"] == "2024-12-31", "the refused move re-filed the document"
    assert world["enqueued"] == ["book"] and meter.calls == calls
    world["finish"]("book", "analyzed")
    # once the correction finished, the user can move it again
    r = world["post"]("/api/documents/book/move-period", {"period_end": "2023-12-31"})
    assert r.status_code == 200, r.text
    assert world["enqueued"] == ["book", "book"] and meter.calls == calls


def test_make_active_of_a_running_document_is_refused(world):
    world["db"].rows("documents").extend([
        _doc("source", status="analyzed", period_id=PERIOD, created="2026-09-20T10:00:00+00:00"),
        _doc("attachment", h=EEI, status="analyzed", period_id=PERIOD, created="2026-09-20T11:00:00+00:00"),
    ])
    world["db"].rows("financial_periods")[0]["source_document_id"] = "source"
    # the attachment's own run is in flight (a re-extract, a recovery …)
    assert _doc_dedupe.try_mark_in_flight("attachment")
    _doc_dedupe.mark_running("attachment")
    r = world["post"]("/api/documents/attachment/make-active", None)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "analysis_in_progress", r.text
    assert world["db"].rows("financial_periods")[0]["source_document_id"] == "source"


def test_the_same_bytes_uploaded_during_a_correction_are_its_duplicate(world):
    """R3: the correction re-run of an analysed book IS the running original."""
    db = world["db"]
    db.rows("documents").append(_doc("book", status="analyzed", period_id=PERIOD,
                                     created="2026-09-20T10:00:00+00:00"))
    _counted(world, "book")
    pipeline._correction_rerun("jwt:%s" % OWNER, "book", "2026-09-21T10:00:00+00:00")
    assert world["enqueued"] == ["book"] and _doc_dedupe.in_flight("book") == _doc_dedupe.RUNNING
    pre = world["post"]("/api/documents/duplicate-check", {"content_hash": SCANDIA},
                        org=_row(world, "book")["org_id"]).json()
    assert pre.get("duplicate") is True and pre["existing_document_id"] == "book", pre
    db.rows("documents").append(_doc("again", created="2026-09-21T10:00:01+00:00"))
    r = world["post"]("/api/pipeline/run", {"document_id": "again"}).json()
    assert r["status"] == "duplicate" and r["existing_document_id"] == "book", r
    assert world["enqueued"] == ["book"] and world["meter"].calls == []


def test_a_correction_that_finds_its_document_busy_starts_nothing(world):
    """The claim is the gate even when the route's pre-check raced: a
    correction re-run of a document another entry holds is not started."""
    db = world["db"]
    db.rows("documents").append(_doc("book", status="analyzed", period_id=PERIOD))
    assert _doc_dedupe.try_mark_in_flight("book")
    pipeline._correction_rerun("jwt:%s" % OWNER, "book", "2026-09-21T10:00:00+00:00")
    assert world["enqueued"] == [] and _row(world, "book")["status"] == "analyzed"
