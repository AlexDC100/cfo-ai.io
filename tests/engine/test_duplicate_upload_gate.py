"""G3 — THE SAME FILE TWICE IS ONE DOCUMENT, and a failure is never counted.

MEASURED IN PRODUCTION (read-only audit, 2026-09-21): the owner's account
read "51 documents used" for September; 31 rows carried `metered_extra`, 18
of them re-uploads of a file the company already held (the EEI balance 13
times into one company) and 12 of them failures. Two defects made that one
number:

  * nothing stopped a duplicate — the browser's `window.confirm` uploaded
    the copy on OK and the server never looked;
  * the counter moved twice per success and once per failure:
    `POST /api/pipeline/run` bumped `user_usage.uploads` through the legacy
    `increment_user_usage` at ENQUEUE time and the terminal
    `commit_user_upload` bumped it again; a retry / correction re-run —
    which reserves nothing — still committed (and re-billed a stale
    `metered_extra`) at its terminal.

Driven through the REAL routes (`pipeline.build_router`) and the REAL
settlement (`_run_pipeline_sync` → `_commit_pipeline_quota`), over
`dedupe_fakes.FakeDB` and a `Meter` that mirrors the SQL of the upload RPCs.

WHAT THESE RED ON, with the defects repaired (TC-11):
  * a second copy of the same bytes (same account, company, period) being
    stored, reserved, enqueued or counted — at the pre-storage check, at
    /run, at retry, at recover-stuck;
  * the same bytes in ANOTHER company, by ANOTHER account, or confirmed for
    ANOTHER period being refused as a duplicate;
  * two identical uploads racing each other analysing twice or reserving twice;
  * a failed run moving `uploads`, `extra_docs_billed_period` or reaching
    Stripe; a success moving `uploads` by more than one;
  * a re-run of a counted document counting (or billing) again;
  * an archived duplicate being committed or billed;
  * a refused run (402) leaving a claim behind that locks the file out.
"""
from __future__ import annotations

import inspect
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.api import _doc_dedupe, _plan_state, _pricing_config, _supabase, _usage_gate, _usage_limits, pipeline

from dedupe_fakes import FakeDB, Meter

OWNER = "fd91f61f-489d-46d2-8bd3-58f922afa03e"
OTHER_USER = "c8a7883b-5198-40db-be3a-b08a78bfe4e2"
ORG = "e23280a9-3f16-4564-b0a7-3f528863c29f"
ORG_B = "98c06428-9bf4-420d-ad2f-06964e8cbd05"
EEI = "6cba603c5e7ff593d387e724dbfd9e37649e9a0c9110600232787a9b49dd7c5e"
SCANDIA = "a81554d0d8aaa8049dd1bee2184dd6beeee9c797fc6ae199a1e8fa57d4205847"
PERIOD = "ce72e080-32a2-4d5c-8c7f-a10d84212b2e"


def _doc(doc_id: str, *, h: str = SCANDIA, org: str = ORG, user: str = OWNER, status: str = "queued",
         created: str = "2026-09-21T13:05:58.272122+00:00", started: Any = None, period_id: Any = None,
         hint: Any = None, deleted: Any = None, error: Any = None, metered_extra: bool = False) -> Dict[str, Any]:
    return {"id": doc_id, "org_id": org, "uploaded_by": user, "status": status, "created_at": created,
            "pipeline_started_at": started, "period_id": period_id, "period_end_hint": hint,
            "deleted_at": deleted, "error": error, "content_hash": h, "metered_extra": metered_extra,
            "storage_path": "%s/uploads/%s.xls" % (org, doc_id), "original_filename": "Balanta Scandia Food_31.12.2025 LV.xls",
            "scope": "financial"}


@pytest.fixture()
def world(monkeypatch):
    db = FakeDB({
        "memberships": [{"user_id": OWNER, "org_id": ORG}, {"user_id": OWNER, "org_id": ORG_B},
                        {"user_id": OTHER_USER, "org_id": ORG}],
        "financial_periods": [{"id": PERIOD, "org_id": ORG, "period_end": "2025-12-31"}],
        "documents": [],
        "subscriptions": [{"user_id": OWNER, "tier": "pro", "stripe_subscription_id": None,
                           "extra_docs_billed_period": 0, "extra_docs_pending": 0}],
    })
    meter = Meter(cap=15)
    enqueued: List[str] = []
    legacy: List[tuple] = []
    billed: List[Dict[str, Any]] = []

    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "1")
    monkeypatch.delenv("USAGE_UNMETERED_USER_IDS", raising=False)
    monkeypatch.setattr(_supabase, "admin", lambda: db)
    monkeypatch.setattr(_supabase, "per_user", lambda jwt: db)
    monkeypatch.setattr(pipeline, "_require_jwt", lambda authorization=None: (authorization or "").split(" ", 1)[-1])
    monkeypatch.setattr(pipeline._org, "verified_user_id", lambda jwt: jwt.split(":", 1)[-1])
    monkeypatch.setattr(pipeline._org, "resolve_user_id", lambda jwt: jwt.split(":", 1)[-1])
    monkeypatch.setattr(pipeline, "_enqueue", lambda doc_id: enqueued.append(doc_id))
    monkeypatch.setattr(_usage_gate, "_rpc", meter.rpc)
    monkeypatch.setattr(_usage_limits, "check_quota", lambda uid, action: {"enforced": False})
    # The legacy soft counter is modelled, not stubbed away: if anything
    # still calls it for an upload, the Meter's `uploads` moves and the
    # count assertions below red.
    monkeypatch.setattr(_usage_limits, "record_usage",
                        lambda uid, action, amount=1: (legacy.append((uid, action)),
                                                       meter.rpc("increment_user_usage", {"p_amount": amount})
                                                       if action == "upload" else None))
    from engine.api import _billing
    monkeypatch.setattr(_billing, "record_metered_extra_doc",
                        lambda user_id, reservation_id, kind="extra_doc": (billed.append(
                            {"user_id": user_id, "reservation_id": reservation_id, "kind": kind})
                            or {"ok": True, "billed": False, "reason": "no_stripe_subscription"}))
    plan = _pricing_config.CONFIG.plans["pro"]

    def plan_state(uid):
        return _plan_state.PlanState(
            user_id=uid, plan_key=plan.key, plan=plan, window_expires_at=None,
            docs_used_this_period=meter.uploads, extra_docs_billed_this_period=meter.extra_billed,
            chat_used_today=0, chat_used_this_period=0, today_iso="2026-09-21",
            period_month_bucket="2026-09", extra_docs_pending_this_period=meter.pending)

    monkeypatch.setattr(_plan_state, "get_plan_state", plan_state)
    # Process-wide state, isolated per test (and restored after it).
    monkeypatch.setattr(pipeline, "_QUOTA_RUNS", {})
    monkeypatch.setattr(_doc_dedupe, "_ARCHIVED_HERE", set())

    app = FastAPI()
    app.include_router(pipeline.build_router())
    client = TestClient(app)

    def post(path, body, user=OWNER, org=None):
        headers = {"Authorization": "Bearer jwt:%s" % user}
        if org:
            headers["X-Org-Id"] = org
        return client.post(path, json=body, headers=headers)

    def finish(doc_id: str, outcome: str) -> None:
        """The daemon thread's terminal, for real: `_run_pipeline_sync` with
        the stages replaced by their persisted outcome."""
        def stages(document_id):
            db.update("documents", {"status": outcome, **({"period_id": PERIOD} if outcome == "analyzed" else {}),
                                    **({"error": "HTTPException: 502: Claude extraction failed"} if outcome == "failed" else {})},
                      filters={"id": "eq.%s" % document_id})
            return outcome
        monkeypatch.setattr(pipeline, "_run_pipeline_stages", stages)
        pipeline._run_pipeline_sync(doc_id)

    return {"db": db, "meter": meter, "enqueued": enqueued, "legacy": legacy, "billed": billed,
            "post": post, "finish": finish, "app": app}


def _row(world, doc_id):
    return next(d for d in world["db"].rows("documents") if d["id"] == doc_id)


# ── G3: the pre-storage check ───────────────────────────────────────────


def test_g3_the_same_file_twice_is_reported_before_a_byte_is_stored(world):
    world["db"].rows("documents").append(_doc("orig", status="analyzed", period_id=PERIOD,
                                               created="2026-09-20T12:00:12.551442+00:00"))
    r = world["post"]("/api/documents/duplicate-check", {"content_hash": SCANDIA}, org=ORG)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["duplicate"] is True and body["existing_document_id"] == "orig" and body["period_id"] == PERIOD
    # read-only: no row, no update, no reservation
    assert len(world["db"].rows("documents")) == 1 and world["db"].updates == [] and world["meter"].calls == []


@pytest.mark.parametrize("label, org, user, hint, expected", [
    ("same company, account and period", ORG, OWNER, None, True),
    ("same confirmed period", ORG, OWNER, "2025-12-31", True),
    ("another company (not a duplicate)", ORG_B, OWNER, None, False),
    ("another account in the same company (not a duplicate)", ORG, OTHER_USER, None, False),
    ("another confirmed period (not a duplicate)", ORG, OWNER, "2024-12-31", False),
])
def test_g3_the_definition_is_file_account_company_period(world, label, org, user, hint, expected):
    world["db"].rows("documents").append(_doc("orig", status="analyzed", period_id=PERIOD))
    r = world["post"]("/api/documents/duplicate-check", {"content_hash": SCANDIA, "period_end_hint": hint},
                      user=user, org=org)
    assert r.status_code == 200, (label, r.text)
    assert r.json()["duplicate"] is expected, label


@pytest.mark.parametrize("label, row", [
    ("a failed copy", _doc("orig", status="failed")),
    ("a deleted copy", _doc("orig", status="analyzed", deleted="2026-09-21T08:06:15+00:00")),
    ("a queued copy whose run was refused (never started)", _doc("orig", status="queued", started=None)),
])
def test_g3_only_a_live_copy_is_an_original(world, label, row):
    world["db"].rows("documents").append(row)
    r = world["post"]("/api/documents/duplicate-check", {"content_hash": SCANDIA}, org=ORG)
    assert r.json() == {"duplicate": False}, label


def test_the_pre_check_refuses_a_workspace_the_caller_is_not_a_member_of(world):
    stranger = "11111111-2222-4333-8444-555555555555"
    r = world["post"]("/api/documents/duplicate-check", {"content_hash": SCANDIA}, user=stranger, org=ORG)
    assert r.status_code == 403


def test_the_pre_check_rejects_a_malformed_hash(world):
    r = world["post"]("/api/documents/duplicate-check", {"content_hash": "not-a-hash"}, org=ORG)
    assert r.status_code == 422


# ── G3: the server-side check at /run ───────────────────────────────────


def test_g3_run_archives_a_duplicate_without_reserving_analysing_or_counting(world):
    db, meter = world["db"], world["meter"]
    db.rows("documents").extend([
        _doc("orig", status="analyzed", period_id=PERIOD, created="2026-09-20T12:00:12.551442+00:00"),
        _doc("copy", created="2026-09-21T13:05:58.272122+00:00"),
    ])
    before = meter.snapshot()
    r = world["post"]("/api/pipeline/run", {"document_id": "copy"})
    assert r.status_code == 202, r.text
    assert r.json() == {"document_id": "copy", "status": "duplicate",
                        "existing_document_id": "orig", "period_id": PERIOD}
    assert world["enqueued"] == [], "a duplicate was analysed"
    assert meter.calls == [], "a duplicate reached the meter: %s" % meter.calls
    assert meter.snapshot() == before
    assert world["legacy"] == [], "the enqueue-time soft counter still moves"
    copy_row = _row(world, "copy")
    assert copy_row["deleted_at"] and _doc_dedupe.duplicate_of(copy_row["error"]) == "orig"
    assert db.deleted_objects == [], "a duplicate's storage object was deleted"
    assert "copy" not in pipeline._QUOTA_RUNS
    # the original is untouched
    assert _row(world, "orig")["deleted_at"] is None and _row(world, "orig")["status"] == "analyzed"


def test_g3_the_same_file_in_another_company_runs(world):
    world["db"].rows("documents").extend([
        _doc("orig", status="analyzed", period_id=PERIOD),
        _doc("other-co", org=ORG_B),
    ])
    r = world["post"]("/api/pipeline/run", {"document_id": "other-co"})
    assert r.json()["status"] == "queued"
    assert world["enqueued"] == ["other-co"] and world["meter"].calls == ["reserve_user_upload"]


def test_g3_two_identical_uploads_at_once_analyse_once_and_reserve_once(world, monkeypatch):
    """The worst interleaving, forced: each run's look for an original waits
    for the other's before it may claim, and no reservation is made until
    both have looked. Only "look, else claim" as ONE step under the lock
    (`claim_or_duplicate`) makes the second look see the first run."""
    db, meter = world["db"], world["meter"]
    db.rows("documents").extend([
        _doc("twin-a", created="2026-09-21T13:05:58.100000+00:00"),
        _doc("twin-b", created="2026-09-21T13:05:58.200000+00:00"),
    ])
    looked = threading.Semaphore(0)
    # Each look waits (0.5 s at most) for the other to look too, BEFORE it
    # can claim: without the lock both looks see nothing and both claim.
    both_looked = threading.Barrier(2, timeout=0.5)
    real_find = _doc_dedupe.find_live_original

    def find(**kw):
        result = real_find(**kw)
        try:
            both_looked.wait()
        except threading.BrokenBarrierError:
            pass  # the other run is held behind the lock — the point of it
        looked.release()
        return result

    real_rpc = meter.rpc

    def rpc(name, payload):
        if name == "reserve_user_upload":
            # hold every reservation until both runs have looked (2 s cap)
            for _ in range(2):
                looked.acquire(timeout=2.0)
        return real_rpc(name, payload)

    monkeypatch.setattr(_doc_dedupe, "find_live_original", find)
    monkeypatch.setattr(_usage_gate, "_rpc", rpc)
    barrier = threading.Barrier(2)

    def go(doc_id):
        barrier.wait()
        return world["post"]("/api/pipeline/run", {"document_id": doc_id}).json()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(go, ["twin-a", "twin-b"]))
    statuses = sorted(r["status"] for r in results)
    assert statuses == ["duplicate", "queued"], results
    assert len(world["enqueued"]) == 1, world["enqueued"]
    assert meter.calls.count("reserve_user_upload") == 1, meter.calls
    archived = [d for d in db.rows("documents") if d["deleted_at"]]
    assert len(archived) == 1 and archived[0]["id"] != world["enqueued"][0]


@pytest.mark.parametrize("order", [("twin-a", "twin-b"), ("twin-b", "twin-a")])
def test_g3_sequential_twins_run_once_whichever_arrives_first(world, order):
    world["db"].rows("documents").extend([
        _doc("twin-a", created="2026-09-21T13:05:58.100000+00:00"),
        _doc("twin-b", created="2026-09-21T13:05:58.200000+00:00"),
    ])
    first = world["post"]("/api/pipeline/run", {"document_id": order[0]}).json()
    second = world["post"]("/api/pipeline/run", {"document_id": order[1]}).json()
    assert (first["status"], second["status"]) == ("queued", "duplicate")
    assert second["existing_document_id"] == order[0]
    assert world["enqueued"] == [order[0]]


def test_a_refused_run_gives_its_claim_back_so_it_never_becomes_an_original(world):
    """A 402 the user dismisses leaves the row queued and unstarted — the
    stuck-upload watchdog's definition of "refused" — and the next upload of
    the same file is NOT answered "already uploaded"."""
    meter = world["meter"]
    meter.uploads = 15  # the plan's included documents are used
    world["db"].rows("documents").append(_doc("first"))
    r = world["post"]("/api/pipeline/run", {"document_id": "first"})
    assert r.status_code == 402
    assert _row(world, "first")["pipeline_started_at"] is None
    assert world["enqueued"] == [] and meter.reserved == 0
    r = world["post"]("/api/documents/duplicate-check", {"content_hash": SCANDIA}, org=ORG)
    assert r.json() == {"duplicate": False}


def test_g3_retry_of_a_copy_is_archived_not_re_run(world):
    world["db"].rows("documents").extend([
        _doc("orig", status="analyzed", period_id=PERIOD, created="2026-09-20T12:00:12+00:00"),
        _doc("old-copy", status="failed", created="2026-09-21T07:45:52+00:00", started="2026-09-21T07:45:53+00:00"),
    ])
    r = world["post"]("/api/pipeline/retry", {"document_id": "old-copy"})
    assert r.json()["status"] == "duplicate" and r.json()["existing_document_id"] == "orig"
    assert world["enqueued"] == [] and world["meter"].calls == []


def test_retrying_the_first_of_two_legacy_analysed_copies_keeps_it(world):
    world["db"].rows("documents").extend([
        _doc("first", status="analyzed", period_id=PERIOD, created="2026-09-20T12:00:12+00:00"),
        _doc("later", status="analyzed", created="2026-09-21T13:05:58+00:00"),
    ])
    assert world["post"]("/api/pipeline/retry", {"document_id": "first"}).json()["status"] == "queued"
    assert world["post"]("/api/pipeline/retry", {"document_id": "later"}).json()["status"] == "duplicate"


def test_g3_recover_stuck_archives_a_duplicate_instead_of_enqueuing_it(world):
    world["db"].rows("documents").extend([
        _doc("orig", status="analyzed", period_id=PERIOD, created="2026-09-20T12:00:12+00:00"),
        _doc("stuck-copy", created="2026-09-21T07:00:00+00:00"),
    ])
    body = world["post"]("/api/pipeline/recover-stuck", None).json()
    assert body["recovered_count"] == 0 and body["duplicates_count"] == 1
    assert body["duplicates"][0]["existing_document_id"] == "orig"
    assert world["enqueued"] == [] and world["meter"].calls == []


# ── One run per document (verifier P-A, 2026-09-21) ──────────────────────


def test_run_twice_on_the_same_analysed_document_counts_once(world):
    """The failed-upload banner's Retry posts /run on the SAME id
    (FinancialStatements.retryFailedUpload), and a `failed` banner can be a
    lost response for a run the server did start (CLAUDE.md §24). The second
    /run answers where the document stands and reserves nothing."""
    world["db"].rows("documents").append(_doc("book"))
    assert world["post"]("/api/pipeline/run", {"document_id": "book"}).json()["status"] == "queued"
    world["finish"]("book", "analyzed")
    calls_after_first = list(world["meter"].calls)
    r = world["post"]("/api/pipeline/run", {"document_id": "book"})
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "analyzed" and r.json()["period_id"] == PERIOD, r.json()
    assert world["enqueued"] == ["book"], "an analysed document was analysed again"
    assert world["meter"].calls == calls_after_first, "a second /run reached the meter"
    assert world["meter"].snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}


def test_run_twice_while_the_first_is_in_flight_reserves_once(world):
    """The first response was lost; Retry posts /run again while thread 1
    runs. One claim, one reservation, one ledger entry, one terminal."""
    world["db"].rows("documents").append(_doc("book"))
    assert world["post"]("/api/pipeline/run", {"document_id": "book"}).json()["status"] == "queued"
    second = world["post"]("/api/pipeline/run", {"document_id": "book"})
    assert second.status_code == 202 and second.json()["status"] == "queued", second.text
    assert world["enqueued"] == ["book"], "one document handed to two daemon threads"
    assert world["meter"].calls == ["reserve_user_upload"], world["meter"].calls
    world["finish"]("book", "analyzed")
    assert world["meter"].snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}
    assert _doc_dedupe.in_flight("book") is None, "the terminal left the document claimed"


def test_a_retry_of_a_document_in_flight_starts_no_second_thread(world):
    world["db"].rows("documents").append(_doc("book"))
    assert world["post"]("/api/pipeline/run", {"document_id": "book"}).json()["status"] == "queued"
    assert world["post"]("/api/pipeline/retry", {"document_id": "book"}).json()["status"] == "queued"
    assert world["enqueued"] == ["book"]


def test_a_run_whose_row_patch_fails_releases_its_reservation(world, monkeypatch):
    """The browser always sends output_language, so /run patches the row
    after reserving. A transient PostgREST error there is a 500 — and the
    reservation must already be in the ledger for the finally to release."""
    db, meter = world["db"], world["meter"]
    db.rows("documents").append(_doc("book"))
    real_update = db.update

    def update(table, patch, *, filters):
        if table == "documents" and "detected_language" in patch:
            raise RuntimeError("PostgREST 503")
        return real_update(table, patch, filters=filters)

    monkeypatch.setattr(db, "update", update)
    client = TestClient(world["app"], raise_server_exceptions=False)
    r = client.post("/api/pipeline/run", json={"document_id": "book", "output_language": "ro"},
                    headers={"Authorization": "Bearer jwt:%s" % OWNER})
    assert r.status_code == 500
    assert meter.snapshot()["reserved"] == 0, "an errored /run left its reservation counted"
    assert _row(world, "book")["pipeline_started_at"] is None and _doc_dedupe.in_flight("book") is None


# ── Failures and duplicates are never counted ────────────────────────────


def test_a_failed_analysis_leaves_every_counter_unchanged(world):
    world["db"].rows("documents").append(_doc("eei", h=EEI))
    before = world["meter"].snapshot()
    assert world["post"]("/api/pipeline/run", {"document_id": "eei"}).json()["status"] == "queued"
    assert world["meter"].reserved == 1
    world["finish"]("eei", "failed")
    assert world["meter"].snapshot() == before, world["meter"].snapshot()
    assert world["billed"] == [] and world["legacy"] == []


def test_a_failed_paid_extra_is_released_and_never_billed(world):
    meter = world["meter"]
    meter.uploads = 15
    meter.rpc("reserve_user_upload_extra", {})  # the user confirmed the €-dialog
    meter.calls.clear()
    world["db"].rows("documents").append(_doc("eei", h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": "eei"}).json()["status"] == "queued"
    world["finish"]("eei", "failed")
    assert meter.snapshot() == {"uploads": 15, "reserved": 0, "extra_billed": 0, "pending": 0}
    assert world["billed"] == []


def test_a_success_counts_exactly_once_and_a_re_run_never_again(world):
    world["db"].rows("documents").append(_doc("book"))
    assert world["post"]("/api/pipeline/run", {"document_id": "book"}).json()["status"] == "queued"
    world["finish"]("book", "analyzed")
    assert world["meter"].snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}
    assert world["legacy"] == [], "an upload still bumps the legacy counter"
    # a retry / correction re-run reserves nothing and settles nothing
    assert world["post"]("/api/pipeline/retry", {"document_id": "book"}).json()["status"] == "queued"
    world["finish"]("book", "analyzed")
    assert world["meter"].snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}


def test_a_re_run_of_a_once_paid_extra_is_not_billed_again(world):
    meter = world["meter"]
    world["db"].rows("documents").append(_doc("paid", status="analyzed", period_id=PERIOD, metered_extra=True))
    assert world["post"]("/api/pipeline/retry", {"document_id": "paid"}).json()["status"] == "queued"
    world["finish"]("paid", "analyzed")
    assert meter.snapshot()["extra_billed"] == 0 and world["billed"] == [] and meter.calls == []


def test_the_settlement_refuses_to_commit_or_bill_an_archived_duplicate(world):
    """Defence in depth: a run in flight that is archived as a duplicate
    (a retry / the watchdog found an earlier copy) is released at its
    terminal even though its stages reported success."""
    row = _doc("dup-in-flight", status="extracting", started="2026-09-21T13:06:00+00:00")
    world["db"].rows("documents").append(row)
    world["meter"].reserved = 1
    pipeline._register_quota_run("dup-in-flight", user_id=OWNER, was_extra=True)
    _doc_dedupe.archive_as_duplicate(row, _doc_dedupe.DuplicateHit("orig", PERIOD, None, "analyzed"),
                                     now_iso="2026-09-21T13:06:01+00:00")
    pipeline._commit_pipeline_quota("dup-in-flight", success=True)
    assert world["meter"].calls == ["release_user_upload"]
    assert world["meter"].snapshot()["uploads"] == 0 and world["billed"] == []


def test_a_marker_the_browser_writes_cannot_make_a_success_free(world):
    """Every documents column is browser-writable (RLS is_member_of, no
    column restriction). Writing the duplicate marker onto your own row
    while it runs must not turn a successful analysis into a release."""
    world["db"].rows("documents").append(_doc("sneaky"))
    assert world["post"]("/api/pipeline/run", {"document_id": "sneaky"}).json()["status"] == "queued"
    world["db"].update("documents", {"error": _doc_dedupe.duplicate_marker("anything"),
                                     "deleted_at": "2026-09-21T13:06:01+00:00"},
                       filters={"id": "eq.sneaky"})
    pipeline._commit_pipeline_quota("sneaky", success=True)
    assert world["meter"].snapshot()["uploads"] == 1, "a browser-written marker bought a free analysis"


def test_a_settlement_happens_once(world):
    world["db"].rows("documents").append(_doc("book", status="analyzed", period_id=PERIOD))
    world["meter"].reserved = 1
    pipeline._register_quota_run("book", user_id=OWNER, was_extra=False)
    pipeline._commit_pipeline_quota("book", success=True)
    pipeline._commit_pipeline_quota("book", success=True)
    assert world["meter"].calls == ["commit_user_upload"]


def test_early_successes_settle_their_reservation(world):
    """SKU scope, the AI lane and the public-records summary used to
    `return` past the commit — their reservation stayed in
    `uploads_reserved` forever and counted against the plan."""
    world["db"].rows("documents").append(dict(_doc("sku-book"), scope="sku"))
    world["post"]("/api/pipeline/run", {"document_id": "sku-book"})
    world["finish"]("sku-book", "analyzed")
    assert world["meter"].snapshot()["reserved"] == 0 and world["meter"].snapshot()["uploads"] == 1


def test_a_future_subscriber_is_metered_for_a_success_only(world):
    """Stripe forward fix: with a subscription on file, a paid extra that
    FAILS or is a DUPLICATE never reaches `record_metered_extra_doc`; the
    one that succeeds does, once, keyed by its own document id."""
    db, meter = world["db"], world["meter"]
    db.rows("subscriptions")[0]["stripe_subscription_id"] = "sub_future"
    meter.uploads = 15
    db.rows("documents").extend([_doc("fails", h=EEI), _doc("works")])
    for doc_id, outcome in (("fails", "failed"), ("works", "analyzed")):
        meter.rpc("reserve_user_upload_extra", {})
        assert world["post"]("/api/pipeline/run", {"document_id": doc_id}).json()["status"] == "queued"
        world["finish"](doc_id, outcome)
    db.rows("documents").append(_doc("dup-of-works", created="2026-09-21T14:00:00+00:00"))
    assert world["post"]("/api/pipeline/run", {"document_id": "dup-of-works"}).json()["status"] == "duplicate"
    assert world["billed"] == [{"user_id": OWNER, "reservation_id": "works", "kind": "extra_doc"}]
    assert meter.snapshot()["extra_billed"] == 1


def test_a_stray_extra_confirm_under_the_cap_gives_its_probe_reservation_back(world):
    """`/api/plan/confirm-extra-doc` pre-flights with `reserve_document`,
    which is not a pure read: under the cap it RESERVES. The 409 that
    follows used to leave that slot in `uploads_reserved` for good — and
    the meter counts reservations against the plan."""
    from engine.api import _pricing_routes
    app = FastAPI()
    app.include_router(_pricing_routes.build_router())
    r = TestClient(app).post("/api/plan/confirm-extra-doc", headers={"Authorization": "Bearer jwt:%s" % OWNER})
    assert r.status_code == 409, r.text
    assert world["meter"].snapshot() == {"uploads": 0, "reserved": 0, "extra_billed": 0, "pending": 0}


# ── The banner ───────────────────────────────────────────────────────────


def test_the_banner_counts_unique_successful_documents(world):
    """The owner's September, in miniature: the EEI PDF failed nine times,
    then analysed three times in another company; Scandia analysed twice in
    one company; one copy archived as a duplicate. Unique successes: EEI in
    ORG_B once, Scandia in ORG once — 2, whatever the counter says."""
    rows = world["db"].rows("documents")
    for i in range(9):
        rows.append(_doc("eei-fail-%d" % i, h=EEI, status="failed", created="2026-09-21T07:%02d:00+00:00" % i))
    for i in range(3):
        rows.append(_doc("eei-ok-%d" % i, h=EEI, org=ORG_B, status="analyzed", created="2026-09-21T14:2%d:00+00:00" % i))
    rows.append(_doc("scandia-1", status="analyzed", created="2026-09-20T12:00:12+00:00"))
    rows.append(_doc("scandia-2", status="analyzed", created="2026-09-21T13:05:58+00:00"))
    rows.append(_doc("scandia-3", status="analyzed", created="2026-09-21T13:10:00+00:00",
                     deleted="2026-09-21T13:10:01+00:00", error=_doc_dedupe.duplicate_marker("scandia-1")))
    rows.append(_doc("august", h="b" * 64, status="analyzed", created="2026-08-30T10:00:00+00:00"))
    assert _doc_dedupe.unique_successful_docs_in_month(OWNER, "2026-09") == 2
    world["meter"].uploads = 51

    from engine.api import _pricing_routes
    app = FastAPI()
    app.include_router(_pricing_routes.build_router())
    body = TestClient(app).get("/api/plan/state", headers={"Authorization": "Bearer jwt:%s" % OWNER}).json()
    assert body["docs_used"] == 2 and body["docs_used_counter"] == 51


def test_archived_duplicates_are_not_on_the_recently_deleted_shelf_or_emptied(world):
    db = world["db"]
    db.rows("documents").extend([
        _doc("user-deleted", status="analyzed", deleted="2026-09-21T10:00:00+00:00"),
        _doc("archived-dup", status="analyzed", deleted="2026-09-21T10:00:00+00:00",
             error=_doc_dedupe.duplicate_marker("user-deleted")),
    ])
    client = TestClient(world["app"])
    r = client.delete("/api/documents/clear-deleted", headers={"Authorization": "Bearer jwt:%s" % OWNER})
    assert r.status_code == 200, r.text
    assert r.json()["deleted_ids"] == ["user-deleted"]
    assert [d["id"] for d in db.rows("documents")] == ["archived-dup"]
    assert db.deleted_objects == ["%s/uploads/user-deleted.xls" % ORG]


# ── Doubles must be faithful ────────────────────────────────────────────


@pytest.mark.parametrize("method", ["select", "update", "insert", "delete", "delete_object", "signed_url"])
def test_the_fake_database_takes_the_real_clients_signature(method):
    """A double that accepts a call the real client rejects hid two outages
    once (CLAUDE.md §21, FakeStore). Same parameters, same kinds."""
    real = inspect.signature(getattr(_supabase.SupabaseClient, method))
    fake = inspect.signature(getattr(FakeDB, method))
    assert [(p.name, p.kind) for p in real.parameters.values()] == \
        [(p.name, p.kind) for p in fake.parameters.values()], (method, real, fake)
