"""A BOOK IS COUNTED ONCE — whatever happens to its analysis afterwards.

Verifier lens S (2026-09-21, fix/dedupe-quota @ f8c7276b) found the count
paths the dedupe lane left open. Every one ran through the REAL routes
(`pipeline.build_router`), the REAL settlement (`_run_pipeline_sync` →
`_commit_pipeline_quota`) and a `Meter` that mirrors the SQL of the upload
RPCs (tests/engine/dedupe_fakes.py):

  S1  /run ok → free correction re-run fails → /retry ok     uploads 2
  S2  the same, the last entry through /run (failed banner)  uploads 2
  S3  the same at the plan cap: 402 → confirm → billed as a PAID EXTRA
  S4  after S1 the banner said 1 and the meter (the 402) said 2
  S5  move-period correction fails → /retry                  uploads 2
  S10 re-upload of the bytes after the failed correction     uploads 2

ROOT CAUSE: "is this re-run metered?" was read from `documents.status`
(`_holds_no_analysis`: status != analyzed). A correction re-run that fails
leaves a counted book `failed` — its period already deleted by the re-run —
so the next entry took it for the book's FIRST analysis. The fact that the
book was counted lived nowhere the engine could read it back.

THE FIX: the settlement writes that fact, per document, into
`document_quota_ledger` — a service-role-only table the browser cannot
write (supabase/schema_phase_document_quota_ledger.sql). An entry meters
only a book none of whose live copies (same company, uploader, content,
scope, period) was ever committed; the settlement refuses to commit a book
that already was; the €-dialog's confirm refuses a counted book (409); the
banner and the restore count a committed document even after its analysis
is gone, as the meter does.

WHAT THESE RED ON, with the defect repaired (TC-11):
  * a book moving `uploads`, `extra_docs_billed_period` or reaching Stripe
    a second time after its analysis failed, by any entry;
  * the banner disagreeing with the meter after such a sequence;
  * a genuinely new book — or the same bytes for a DIFFERENT confirmed
    period, or after the user deleted the counted copy — NOT being metered.
"""
from __future__ import annotations

from engine.api import _doc_dedupe, _quota_ledger, pipeline  # noqa: F401

from test_duplicate_upload_gate import (  # noqa: F401 — the fixture
    EEI, ORG, OWNER, PERIOD, _banner, _confirm, _doc, _row, world,
)


def _counted_book(world, doc_id="book", **kw):
    """A book analysed through /run and counted once."""
    world["db"].rows("documents").append(_doc(doc_id, h=EEI, **kw))
    assert world["post"]("/api/pipeline/run", {"document_id": doc_id}).json()["status"] == "queued"
    world["finish"](doc_id, "analyzed")
    assert world["meter"].snapshot()["uploads"] >= 1


def _failed_correction(world, doc_id="book"):
    """The Docs panel's Re-run of an analysed book (a free correction) —
    and the re-run fails (a PDF on an empty Anthropic balance, §24)."""
    assert world["post"]("/api/pipeline/retry", {"document_id": doc_id}).json()["status"] == "queued"
    world["finish"](doc_id, "failed")
    assert _row(world, doc_id)["status"] == "failed"


def test_s1_a_retry_after_a_failed_correction_never_counts_the_book_again(world):
    meter = world["meter"]
    _counted_book(world)
    _failed_correction(world)
    assert meter.snapshot()["uploads"] == 1
    assert world["post"]("/api/pipeline/retry", {"document_id": "book"}).json()["status"] == "queued"
    world["finish"]("book", "analyzed")
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}, meter.calls
    assert meter.calls == ["reserve_user_upload", "commit_user_upload"], meter.calls


def test_s2_the_failed_banners_run_never_counts_the_book_again(world):
    meter = world["meter"]
    _counted_book(world)
    _failed_correction(world)
    assert world["post"]("/api/pipeline/run", {"document_id": "book"}).json()["status"] == "queued"
    world["finish"]("book", "analyzed")
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}, meter.calls


def test_s3_a_counted_book_is_never_billed_as_a_paid_extra(world):
    meter = world["meter"]
    meter.uploads = 14
    _counted_book(world)
    assert meter.snapshot()["uploads"] == 15
    _failed_correction(world)
    r = world["post"]("/api/pipeline/retry", {"document_id": "book"})
    assert r.status_code == 202 and r.json()["status"] == "queued", (
        "a counted book met the €-dialog again", r.status_code, r.text)
    world["finish"]("book", "analyzed")
    assert meter.snapshot() == {"uploads": 15, "reserved": 0, "extra_billed": 0, "pending": 0}
    assert world["billed"] == []


def test_s3b_the_confirm_refuses_a_counted_book(world):
    """Even a stale tab holding the €-dialog for it: a book the plan already
    counted is never reserved or granted as an extra."""
    meter = world["meter"]
    meter.uploads = 14
    _counted_book(world)
    _failed_correction(world)
    calls = list(meter.calls)
    r = _confirm(world, "book")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "document_already_counted", r.text
    assert meter.calls == calls and meter.snapshot()["pending"] == 0


def test_s4_the_banner_and_the_meter_agree_after_a_failed_correction(world):
    meter = world["meter"]
    _counted_book(world)
    _failed_correction(world)
    # the book is counted and currently holds no analysis: both say 1
    assert _banner(world)["docs_used"] == meter.snapshot()["uploads"] == 1
    world["post"]("/api/pipeline/retry", {"document_id": "book"})
    world["finish"]("book", "analyzed")
    assert _banner(world)["docs_used"] == meter.snapshot()["uploads"] == 1


def test_s5_a_failed_move_period_correction_then_retry_counts_once(world):
    meter = world["meter"]
    _counted_book(world)
    r = world["post"]("/api/documents/book/move-period", {"period_end": "2024-12-31"})
    assert r.status_code == 200, r.text
    world["finish"]("book", "failed")
    world["post"]("/api/pipeline/retry", {"document_id": "book"})
    world["finish"]("book", "analyzed")
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}, meter.calls


def test_s10_re_uploading_a_counted_book_after_its_correction_failed_counts_nothing(world):
    """The failed copy is not an original (it holds no analysis), so the
    re-upload IS analysed — the user gets the book back — but the book was
    counted at its first /run and is never counted again."""
    meter = world["meter"]
    _counted_book(world, "a", created="2026-09-21T09:00:00+00:00")
    _failed_correction(world, "a")
    pre = world["post"]("/api/documents/duplicate-check", {"content_hash": EEI}, org=ORG).json()
    assert pre == {"duplicate": False}, pre
    world["db"].rows("documents").append(_doc("b", h=EEI, created="2026-09-21T10:00:00+00:00"))
    assert world["post"]("/api/pipeline/run", {"document_id": "b"}).json()["status"] == "queued"
    world["finish"]("b", "analyzed")
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}, meter.calls
    assert _banner(world)["docs_used"] == 1


def test_the_settlement_never_commits_a_book_that_is_already_counted(world):
    """Defence in depth: whatever entry reserved (a stale bundle, a path
    added later), the terminal refuses to count a book twice — released,
    never committed or billed."""
    meter = world["meter"]
    _counted_book(world, "a", created="2026-09-21T09:00:00+00:00")
    world["db"].rows("documents").append(_doc("b", h=EEI, status="extracting",
                                              created="2026-09-21T10:00:00+00:00"))
    meter.reserved = 1
    pipeline._register_quota_run("b", user_id=OWNER, was_extra=True)
    world["db"].update("documents", {"status": "analyzed"}, filters={"id": "eq.b"})
    pipeline._commit_pipeline_quota("b", success=True)
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}
    assert world["billed"] == []


# ── Positive controls: what must still count ────────────────────────────


def test_a_new_book_is_still_counted_and_its_retry_is_free(world):
    meter = world["meter"]
    _counted_book(world)
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}
    row = world["db"].rows(_quota_ledger.TABLE)
    assert [(r["document_id"], bool(r.get("committed_at"))) for r in row] == [("book", True)], row


def test_the_same_bytes_confirmed_for_another_period_are_a_new_book(world):
    meter = world["meter"]
    _counted_book(world, "fy25", created="2026-09-21T09:00:00+00:00")
    _failed_correction(world, "fy25")
    world["db"].rows("documents").append(_doc("fy24", h=EEI, hint="2024-12-31",
                                              created="2026-09-21T10:00:00+00:00"))
    world["db"].update("documents", {"period_end_hint": "2025-12-31"}, filters={"id": "eq.fy25"})
    assert world["post"]("/api/pipeline/run", {"document_id": "fy24"}).json()["status"] == "queued"
    world["finish"]("fy24", "analyzed")
    assert meter.snapshot()["uploads"] == 2


def test_a_re_upload_after_the_user_deleted_the_counted_copy_counts_again(world):
    """The live gate's own rule: a copy the user deleted is not an original,
    and the meter counts the re-upload."""
    meter = world["meter"]
    _counted_book(world, "first", created="2026-09-20T10:00:00+00:00")
    world["db"].update("documents", {"deleted_at": "2026-09-21T09:00:00+00:00"}, filters={"id": "eq.first"})
    world["db"].rows("documents").append(_doc("again", h=EEI, created="2026-09-21T10:00:00+00:00"))
    assert world["post"]("/api/pipeline/run", {"document_id": "again"}).json()["status"] == "queued"
    world["finish"]("again", "analyzed")
    assert meter.snapshot()["uploads"] == 2 == _banner(world)["docs_used"]


def test_an_unreadable_ledger_meters_by_status_and_never_raises(world, monkeypatch):
    """The ledger is a read the entry cannot prove anything from when it
    fails: a book that holds no analysis is metered (the status rule), and
    nothing 500s."""
    meter = world["meter"]
    real = world["db"].select

    def select(table, **kw):
        if table == _quota_ledger.TABLE:
            raise RuntimeError("PostgREST 503")
        return real(table, **kw)

    monkeypatch.setattr(world["db"], "select", select)
    world["db"].rows("documents").append(_doc("x", h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": "x"}).json()["status"] == "queued"
    world["finish"]("x", "analyzed")
    assert meter.snapshot()["uploads"] == 1


# ── THE LEDGER BEFORE THE STATUS (P-1 METERING BYPASS, 2026-09-26) ─────────
#
# `_needs_metering` used to short-circuit on `documents.status == 'analyzed'`
# BEFORE consulting the ledger. Every column of `documents` is
# browser-writable (RLS is_member_of(org_id), no column restriction): a
# member who PATCHed status='analyzed' onto a fresh upload and POSTed /retry
# got an analysis that was never reserved, committed or billed. The order is
# now: the ledger first (counted → unmetered; readable and NOT counted →
# metered like /run whatever the status says); only an unreadable or absent
# ledger falls back to the status rule. A document analysed with enforcement
# OFF (its settlement recorded a release, never a count) therefore meters
# ONCE on its next re-run — stated in the migration header.
#
# WHAT THESE RED ON, with the defect repaired (TC-11):
#   * a status the browser wrote skipping the meter on /retry (or the
#     correction re-run), at or under the cap;
#   * the €-dialog's confirm refusing that document as "not waiting";
#   * a counted book being metered again (the ledger still wins);
#   * an unreadable ledger metering an analysed document (the status rule
#     is still the fallback — never a 500, never a second count by guess).


def _forged_analyzed(world, doc_id="forged", h=EEI):
    """A fresh upload whose status the BROWSER set to `analyzed` — a PATCH
    straight at PostgREST, which the write wall does not see."""
    world["db"].rows("documents").append(_doc(doc_id, h=h))
    world["db"].update("documents", {"status": "analyzed"}, filters={"id": "eq.%s" % doc_id})


def test_p1_a_status_the_browser_wrote_never_skips_the_meter_on_retry(world):
    meter = world["meter"]
    _forged_analyzed(world)
    r = world["post"]("/api/pipeline/retry", {"document_id": "forged"})
    assert r.status_code == 202 and r.json()["status"] == "queued", r.text
    assert meter.calls == ["reserve_user_upload"], (
        "a browser-written `analyzed` skipped the meter — the run was never reserved", meter.calls)
    world["finish"]("forged", "analyzed")
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}, meter.calls
    rows = world["db"].rows(_quota_ledger.TABLE)
    assert [(r["document_id"], bool(r.get("committed_at"))) for r in rows] == [("forged", True)], rows


def test_p1_at_the_cap_a_forged_status_meets_the_dialog_and_is_billed_once_confirmed(world):
    meter = world["meter"]
    meter.uploads = 15
    _forged_analyzed(world)
    r = world["post"]("/api/pipeline/retry", {"document_id": "forged"})
    assert r.status_code == 402, ("an over-cap run of a forged `analyzed` ran unbilled", r.status_code, r.text)
    c = _confirm(world, "forged")
    assert c.status_code == 200, ("the confirm refused the document its own 402 was about", c.text)
    assert world["post"]("/api/pipeline/retry", {"document_id": "forged"}).json()["status"] == "queued"
    world["finish"]("forged", "analyzed")
    assert meter.snapshot() == {"uploads": 16, "reserved": 0, "extra_billed": 1, "pending": 0}, meter.calls
    assert [b["reservation_id"] for b in world["billed"]] == ["forged"]


def test_p1_the_move_period_correction_of_a_forged_status_is_metered_too(world):
    meter = world["meter"]
    _forged_analyzed(world)
    r = world["post"]("/api/documents/forged/move-period", {"period_end": "2024-12-31"})
    assert r.status_code == 200, r.text
    assert meter.calls == ["reserve_user_upload"], ("the correction re-run of a forged status reserved nothing", meter.calls)
    world["finish"]("forged", "analyzed")
    assert meter.snapshot()["uploads"] == 1


def test_p1_a_document_analysed_with_enforcement_off_meters_once_on_its_next_re_run(world):
    """Its settlement recorded a release (`_commit_pipeline_quota` with the
    kill-switch off), never a count: the ledger is readable and says NOT
    counted, so the first re-run under enforcement is metered — and only
    that one."""
    meter = world["meter"]
    world["db"].rows("documents").append(_doc("legacy", h=EEI, status="analyzed", period_id=PERIOD))
    world["db"].rows(_quota_ledger.TABLE).append({
        "document_id": "legacy", "user_id": OWNER, "month": "2026-08", "was_extra": False,
        "committed_at": None, "released_at": "2026-08-30T10:00:00+00:00", "reserved_at": None})
    assert world["post"]("/api/pipeline/retry", {"document_id": "legacy"}).json()["status"] == "queued"
    assert meter.calls == ["reserve_user_upload"], meter.calls
    world["finish"]("legacy", "analyzed")
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}
    # once: the book is counted now
    assert world["post"]("/api/pipeline/retry", {"document_id": "legacy"}).json()["status"] == "queued"
    world["finish"]("legacy", "analyzed")
    assert meter.snapshot()["uploads"] == 1 and meter.calls == ["reserve_user_upload", "commit_user_upload"], meter.calls


# Positive controls


def test_p1_a_counted_book_still_re_runs_free_whatever_its_status(world):
    meter = world["meter"]
    _counted_book(world)
    world["db"].update("documents", {"status": "failed"}, filters={"id": "eq.book"})
    calls = list(meter.calls)
    assert world["post"]("/api/pipeline/retry", {"document_id": "book"}).json()["status"] == "queued"
    assert meter.calls == calls, ("a counted book was metered again", meter.calls)


def test_p1_an_unreadable_ledger_still_re_runs_an_analysed_document_free(world, monkeypatch):
    """The status rule is the FALLBACK, not the first word: with the ledger
    unreadable an analysed document's re-run is a free correction (metering
    it by guess would count a book twice), and nothing 500s."""
    meter = world["meter"]
    real = world["db"].select

    def select(table, **kw):
        if table == _quota_ledger.TABLE:
            raise RuntimeError("PostgREST 503")
        return real(table, **kw)

    monkeypatch.setattr(world["db"], "select", select)
    world["db"].rows("documents").append(_doc("old", h=EEI, status="analyzed", period_id=PERIOD))
    r = world["post"]("/api/pipeline/retry", {"document_id": "old"})
    assert r.status_code == 202 and r.json()["status"] == "queued", r.text
    assert meter.calls == [], meter.calls
