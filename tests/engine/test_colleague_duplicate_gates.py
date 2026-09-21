"""A COLLEAGUE'S ENTRY NEVER ANALYSES THE UPLOADER'S DUPLICATE.

Verifier lens S, S9 (2026-09-21). `dedupe_account` answers None when the
caller is not the document's uploader — so a colleague's entry must never
ARCHIVE the upload (commit 36c92257, ACCOUNT clause). But `enter_analysis`
then skipped the duplicate look altogether: OWNER holds an analysed
original and a failed copy of the same bytes (a duplicate under the owner
spec — same uploader, company, content); OTHER_USER, a member, retries the
copy from the Docs panel → 202 queued, reserved under OTHER_USER, analysed
and committed. A second analysis and a second count of one book.

THE FIX: the look always runs under the UPLOADER's account (when the
uploader is a member of the document's company). A hit answers `duplicate`
naming the original — nothing archived, reserved or enqueued — and only
the uploader's own entry archives.

WHAT THESE RED ON, with the defect repaired (TC-11):
  * a colleague's /retry or /run of the uploader's duplicate being
    reserved, enqueued or counted;
  * a colleague's entry archiving (soft-deleting) anyone's upload;
  * a colleague's entry refusing a document that duplicates nothing.
"""
from __future__ import annotations

from engine.api import _doc_dedupe

from test_duplicate_upload_gate import (  # noqa: F401 — the fixture
    OTHER_USER, OWNER, PERIOD, _doc, _row, world,
)


def _owner_holds_a_duplicate(world, copy_status="failed", started="2026-09-20T10:00:01+00:00"):
    world["db"].rows("documents").extend([
        _doc("orig", user=OWNER, status="analyzed", period_id=PERIOD, created="2026-09-19T10:00:00+00:00"),
        _doc("copy", user=OWNER, status=copy_status, created="2026-09-20T10:00:00+00:00", started=started),
    ])


def test_s9_a_colleagues_retry_of_the_uploaders_duplicate_is_not_analysed(world):
    _owner_holds_a_duplicate(world)
    r = world["post"]("/api/pipeline/retry", {"document_id": "copy"}, user=OTHER_USER)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "duplicate" and body["existing_document_id"] == "orig", body
    assert world["enqueued"] == [] and world["meter"].calls == []
    row = _row(world, "copy")
    assert row["deleted_at"] is None and row["error"] is None, "a colleague's entry archived an upload"
    assert _doc_dedupe.in_flight("copy") is None


def test_a_colleagues_run_of_the_uploaders_duplicate_is_not_analysed(world):
    _owner_holds_a_duplicate(world, copy_status="queued", started=None)
    body = world["post"]("/api/pipeline/run", {"document_id": "copy"}, user=OTHER_USER).json()
    assert body["status"] == "duplicate" and body["existing_document_id"] == "orig", body
    assert world["enqueued"] == [] and world["meter"].calls == []
    assert _row(world, "copy")["deleted_at"] is None


def test_the_uploaders_own_entry_still_archives_the_duplicate(world):
    """Positive control: the ACCOUNT clause's own archive is unchanged."""
    _owner_holds_a_duplicate(world)
    body = world["post"]("/api/pipeline/retry", {"document_id": "copy"}, user=OWNER).json()
    assert body["status"] == "duplicate"
    assert _doc_dedupe.is_archived_duplicate(_row(world, "copy"))


def test_a_colleagues_retry_of_a_document_that_duplicates_nothing_runs(world):
    """Positive control: a colleague may re-run the uploader's document —
    metered under the colleague, as before — when it duplicates nothing."""
    world["db"].rows("documents").append(
        _doc("only", user=OWNER, status="failed", created="2026-09-20T10:00:00+00:00",
             started="2026-09-20T10:00:01+00:00"))
    body = world["post"]("/api/pipeline/retry", {"document_id": "only"}, user=OTHER_USER).json()
    assert body["status"] == "queued" and world["enqueued"] == ["only"]
    assert world["meter"].calls == ["reserve_user_upload"]
