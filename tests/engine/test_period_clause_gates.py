"""THE PERIOD CLAUSE REFUSES ONLY WHAT IT CAN PROVE.

Verifier lens R3 (2026-09-21; probes test_probe_r3_lens::
test_different_confirmed_period_while_the_original_is_still_running,
..._when_periods_cannot_be_read, test_probe_r3_run::
test_run_unreadable_periods_archive_a_different_period_upload,
test_run_running_original_different_period_archives_then_orphans_the_upload,
test_probe_r3_landing::test_firm_landing_compares_a_legacy_hashless_original).

  * The user confirms a closing date for an upload (`period_end_hint`) and
    the original's own date is UNKNOWN — it is still running with no hint,
    or `financial_periods` could not be read. `same_period` answered "unknown
    matches": the FY2024 upload was refused / ARCHIVED as a duplicate of a
    run that then landed in FY2025 — or of a FY2025 book behind one 503.
    Refusing is the claim that needs proof; an unknown date proves nothing.
  * The firm request link's look (`_prod_find_duplicate`) never compared a
    legacy original stored without a content hash (the /run path hashes
    them — `_unhashed_candidates` — the landing had no row to pass), and
    no /run follows a landing: the same file was stored, reserved,
    analysed and counted.

THE FIX: when the new upload carries a confirmed date, an original matches
only if its own date is KNOWN and equal. The count stays safe: a book is
counted once whatever the look let through — the settlement refuses to
commit a book already counted, comparing each copy's hint, else the period
it was analysed into (`pipeline._book_already_counted`). The landing looks
with a stand-in for the row it is about to create, so hash-less originals
are hashed and compared exactly as at /run.

WHAT THESE RED ON, with the defect repaired (TC-11):
  * an upload confirmed for another period refused or archived against an
    original whose period is not known;
  * the same bytes with the SAME known period no longer refused;
  * two copies of one book confirmed for the same period counted twice;
  * the landing storing a file its account already holds without a hash.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from engine.api import _doc_dedupe

from test_duplicate_upload_gate import (  # noqa: F401 — the fixture
    ORG, PERIOD, SCANDIA, _doc, _landing, _row, world,
)


def _ago(**kw) -> str:
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat()


def _pre(world, hint=None):
    return world["post"]("/api/documents/duplicate-check",
                         {"content_hash": SCANDIA, "period_end_hint": hint}, org=ORG).json()


def test_a_confirmed_period_is_not_refused_against_a_running_original_of_unknown_month(world):
    world["db"].rows("documents").append(_doc("running", created=_ago(seconds=30)))
    assert world["post"]("/api/pipeline/run", {"document_id": "running"}).json()["status"] == "queued"
    assert _pre(world, "2024-12-31") == {"duplicate": False}
    world["db"].rows("documents").append(_doc("fy24", hint="2024-12-31", created=_ago(seconds=1)))
    r = world["post"]("/api/pipeline/run", {"document_id": "fy24"}).json()
    assert r["status"] == "queued", r
    assert _row(world, "fy24")["deleted_at"] is None


def test_a_confirmed_period_is_not_refused_when_the_periods_cannot_be_read(world, monkeypatch):
    world["db"].rows("documents").append(_doc("orig", status="analyzed", period_id=PERIOD, created=_ago(days=1)))
    real = world["db"].select

    def select(table, **kw):
        if table == "financial_periods":
            raise RuntimeError("PostgREST 503")
        return real(table, **kw)

    monkeypatch.setattr(world["db"], "select", select)
    assert _pre(world, "2024-12-31") == {"duplicate": False}
    world["db"].rows("documents").append(_doc("fy24", hint="2024-12-31", created=_ago(seconds=1)))
    assert world["post"]("/api/pipeline/run", {"document_id": "fy24"}).json()["status"] == "queued"


def test_the_same_known_period_is_still_a_duplicate(world):
    """Positive control: an original analysed into 31.12.2025 refuses the
    same bytes confirmed for 31.12.2025 — and a running original that
    carries the same confirmed date does too."""
    world["db"].rows("documents").append(_doc("orig", status="analyzed", period_id=PERIOD, created=_ago(days=1)))
    assert _pre(world, "2025-12-31")["existing_document_id"] == "orig"
    world["db"].rows("documents").append(_doc("r", h="%064x" % 5, hint="2024-12-31", created=_ago(seconds=9)))
    assert world["post"]("/api/pipeline/run", {"document_id": "r"}).json()["status"] == "queued"
    world["db"].rows("documents").append(_doc("r2", h="%064x" % 5, hint="2024-12-31", created=_ago(seconds=1)))
    assert world["post"]("/api/pipeline/run", {"document_id": "r2"}).json()["status"] == "duplicate"


def _land(world, monkeypatch, doc_id, period_id):
    """The daemon thread's terminal, the run's analysis landing in
    `period_id` (the world's own `finish` always lands in PERIOD)."""
    from engine.api import pipeline

    def stages(document_id):
        world["db"].update("documents", {"status": "analyzed", "period_id": period_id},
                           filters={"id": "eq.%s" % document_id})
        return "analyzed"

    monkeypatch.setattr(pipeline, "_run_pipeline_stages", stages)
    pipeline._run_pipeline_sync(doc_id)


def _running_and_a_confirmed_copy(world):
    world["db"].rows("financial_periods").append({"id": "p24", "org_id": ORG, "period_end": "2024-12-31"})
    world["db"].rows("documents").append(_doc("running", created=_ago(seconds=30)))
    assert world["post"]("/api/pipeline/run", {"document_id": "running"}).json()["status"] == "queued"
    world["db"].rows("documents").append(_doc("fy24", hint="2024-12-31", created=_ago(seconds=1)))
    assert world["post"]("/api/pipeline/run", {"document_id": "fy24"}).json()["status"] == "queued"


def test_two_copies_that_land_in_the_same_month_are_counted_once(world, monkeypatch):
    """The look let the confirmed-period copy through (the running original's
    month was unknown); both land in 31.12.2024. The settlement counts the
    book once — whichever finishes first."""
    meter = world["meter"]
    _running_and_a_confirmed_copy(world)
    _land(world, monkeypatch, "running", "p24")
    _land(world, monkeypatch, "fy24", "p24")
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}


def test_two_copies_that_land_in_the_same_month_are_counted_once_in_either_order(world, monkeypatch):
    meter = world["meter"]
    _running_and_a_confirmed_copy(world)
    _land(world, monkeypatch, "fy24", "p24")
    _land(world, monkeypatch, "running", "p24")
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}


def test_two_copies_that_land_in_different_months_are_two_books(world, monkeypatch):
    """Positive control: the running original lands in 31.12.2025 (its own
    detected period) — the FY2024 copy is a different book and counts, in
    either order."""
    meter = world["meter"]
    _running_and_a_confirmed_copy(world)
    _land(world, monkeypatch, "fy24", "p24")
    _land(world, monkeypatch, "running", PERIOD)
    assert meter.snapshot()["uploads"] == 2


def test_the_firm_landing_compares_a_legacy_original_stored_without_a_hash(world, monkeypatch):
    content = b"balanta scandia 31.12.2025"
    h = hashlib.sha256(content).hexdigest()
    world["db"].rows("documents").append(dict(_doc("legacy", h=None, status="analyzed", period_id=PERIOD,
                                                   created="2026-03-01T10:00:00+00:00"),
                                              size_bytes=len(content)))
    monkeypatch.setattr(_doc_dedupe, "hash_stored_object", lambda d: h)
    FR, deps, request_row, stored = _landing(world, monkeypatch)
    try:
        FR.land_file(request_row, content, "b.xls", "application/vnd.ms-excel", deps)
        outcome = "landed"
    except FR.LandingRefused as exc:
        outcome = exc.detail.get("code")
    assert outcome == "already_uploaded", (outcome, stored, world["meter"].calls, world["enqueued"])
    assert stored == [] and world["meter"].calls == [] and world["enqueued"] == []
    assert _row(world, "legacy")["content_hash"] == h
