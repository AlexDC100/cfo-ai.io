"""A COPY THAT HOLDS NO ANALYSIS IS NEVER THE ORIGINAL.

Verifier lens R3 (2026-09-21; probes test_after_the_live_copy_failed_its_
retry_an_orphan_twin_does_not_block_the_reupload, test_run_orphan_twin_
archives_the_reupload). Legacy twins exist in production (EEI x13, Scandia
x3-4). The copy that owns the period is re-run (Docs panel / failed-banner
Retry): `_retry_rerun` deletes the shared period — `documents.period_id` is
ON DELETE SET NULL, so every twin loses it — and the re-run FAILS (a PDF on
an empty Anthropic balance, §24). No copy holds an analysis and the month is
gone, yet a re-upload of the file was refused "Already uploaded — open it"
naming a twin with period_id=null (a link to /dashboard where the month no
longer exists); a /run of the re-upload archived it with
`duplicate_of:older`, which also keeps it off the Recently-deleted shelf.

ROOT CAUSE: `pick_original` counted an _ORPHAN analysed copy (no period, or
a period that no longer exists) as the original whenever no other copy held
a period. The rule was written for analyses that are period-less BY KIND
(the public-records summary short-circuit, which persists to sku_analyses
and never files a period), but it could not tell those apart from a trial
balance whose period was deleted.

THE FIX: an analysed financial copy holds its analysis only when its period
exists and names it (or names no source), or when its analysis is
period-less by kind — `detected_type = public_records_summary`, or a
`public_records_summary` row in sku_analyses for that document. Any other
period-less or period-gone copy is an ORPHAN and never an original.

WHAT THESE RED ON, with the defect repaired (TC-11):
  * a re-upload refused — or archived — against a copy that holds no
    analysis (period null or gone);
  * "open it" naming a copy with no analysis;
  * a period-less-by-kind analysis (public records) NOT deduplicating on
    its first copy.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from engine.api import _doc_dedupe

from test_duplicate_upload_gate import (  # noqa: F401 — the fixture
    ORG, PERIOD, SCANDIA, _doc, _row, world,
)


def _ago(**kw) -> str:
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat()


def _pre(world, h=SCANDIA):
    return world["post"]("/api/documents/duplicate-check", {"content_hash": h}, org=ORG).json()


def _twins_whose_live_copy_failed_its_retry(world):
    """Two copies of one book that shared a period; the period is GONE, both
    are pinned to nothing, and the live copy is `failed` — what a re-run that
    RESET the period and then failed left behind.

    CONSTRUCTED DIRECTLY since 2026-10-04 (gate rerun-data-loss, stage 2).
    This used to be reached through POST /api/pipeline/retry, as a way to
    delete the shared period: the retry's reset deleted it and a failed run
    left nothing. A re-run is STAGED now — it never deletes its period and a
    failed one leaves the document analysed over its month — so the route no
    longer produces this state. Stored data still holds it (every failed
    re-run before that date), and what these two laws say about it is
    unchanged."""
    db = world["db"]
    del db.rows("financial_periods")[:]
    db.rows("documents").extend([
        _doc("older", status="analyzed", period_id=None, created=_ago(days=3)),
        _doc("live", status="failed", period_id=None, created=_ago(days=1), started=_ago(hours=2),
             error="HTTPException: 502: Claude extraction failed"),
    ])


def test_after_the_live_twin_failed_its_retry_the_re_upload_is_not_a_duplicate(world):
    _twins_whose_live_copy_failed_its_retry(world)
    assert _pre(world) == {"duplicate": False}


def test_after_the_live_twin_failed_its_retry_the_re_upload_is_analysed_not_archived(world):
    _twins_whose_live_copy_failed_its_retry(world)
    world["db"].rows("documents").append(_doc("reupload", created=_ago(seconds=1)))
    r = world["post"]("/api/pipeline/run", {"document_id": "reupload"}).json()
    assert r["status"] == "queued", r
    row = _row(world, "reupload")
    assert row["deleted_at"] is None and row["error"] is None


def test_a_trial_balance_whose_period_was_deleted_is_never_the_original(world):
    world["db"].rows("documents").append(
        _doc("gone", status="analyzed", period_id="dead-period-id", created=_ago(days=2)))
    assert _pre(world) == {"duplicate": False}
    world["db"].rows("documents").append(_doc("again", created=_ago(seconds=1)))
    assert world["post"]("/api/pipeline/run", {"document_id": "again"}).json()["status"] == "queued"


def test_a_trial_balance_with_no_period_is_never_the_original(world):
    world["db"].rows("documents").append(_doc("first", status="analyzed", period_id=None, created=_ago(days=2)))
    world["db"].rows("documents").append(_doc("again", created=_ago(seconds=1)))
    r = world["post"]("/api/pipeline/run", {"document_id": "again"}).json()
    assert r["status"] == "queued", ("'open it' would name a copy with no analysis", r)


def test_a_public_records_summary_still_dedupes_on_its_first_copy(world):
    """Positive control: an analysis that is period-less BY KIND (the
    listafirme / termene summary) holds its analysis without a period."""
    db = world["db"]
    db.rows("documents").append(_doc("first", status="analyzed", period_id=None, created=_ago(days=2)))
    db.rows("sku_analyses").append({"org_id": ORG, "document_id": "first",
                                    "summary": {"kind": "public_records_summary", "year_count": 5}})
    pre = _pre(world)
    assert pre["duplicate"] is True and pre["existing_document_id"] == "first", pre
    db.rows("documents").append(_doc("again", created=_ago(seconds=1)))
    r = world["post"]("/api/pipeline/run", {"document_id": "again"}).json()
    assert r["status"] == "duplicate" and r["existing_document_id"] == "first", r


def test_a_public_records_summary_tagged_on_the_row_still_dedupes(world):
    db = world["db"]
    db.rows("documents").append(dict(_doc("first", status="analyzed", period_id=None, created=_ago(days=2)),
                                     detected_type="public_records_summary"))
    assert _pre(world)["existing_document_id"] == "first"


def test_the_copy_that_holds_the_period_is_still_named_over_an_orphan(world):
    """Positive control (unchanged): an orphan twin never displaces — or
    archives — the copy that owns the live period."""
    db = world["db"]
    db.rows("financial_periods")[0]["source_document_id"] = "live-later"
    db.rows("documents").extend([
        _doc("orphan-first", status="analyzed", period_id=None, created=_ago(days=3)),
        _doc("live-later", status="analyzed", period_id=PERIOD, created=_ago(days=1)),
    ])
    pre = _pre(world)
    assert pre["existing_document_id"] == "live-later" and pre["period_id"] == PERIOD, pre
    assert _doc_dedupe.pick_original(db.rows("documents"), self_row=None) is not None
