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


def _confirm(world, doc_id=None, user=OWNER):
    """The €-dialog's Confirm, through the REAL route: POST
    /api/plan/confirm-extra-doc naming the document it was shown for."""
    from engine.api import _pricing_routes
    app = FastAPI()
    app.include_router(_pricing_routes.build_router())
    body = {"document_id": doc_id} if doc_id else None
    return TestClient(app).post("/api/plan/confirm-extra-doc", json=body,
                                headers={"Authorization": "Bearer jwt:%s" % user})


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
    (`enter_analysis`) makes the second look see the first run."""
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


def _ago(seconds):
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


def test_recover_stuck_and_a_twin_run_analyse_the_same_bytes_once(world, monkeypatch):
    """recover-stuck used to look for a duplicate WITHOUT claiming and stamp
    `pipeline_started_at` only after its reservation, outside the lock. A
    twin's /run landing in that window (forced here: inside recover-stuck's
    reservation) found the stuck row unstarted, claimed itself — both ran,
    both counted."""
    db = world["db"]
    db.rows("documents").append(_doc("stuck", created=_ago(60)))
    db.rows("documents").append(_doc("twin", created=_ago(1)))
    real = _usage_gate.reserve_document
    state = {"n": 0, "twin": None}

    def reserve(uid):
        state["n"] += 1
        if state["n"] == 1:  # recover-stuck's reservation for `stuck`
            state["twin"] = world["post"]("/api/pipeline/run", {"document_id": "twin"}).json()
        return real(uid)

    monkeypatch.setattr(_usage_gate, "reserve_document", reserve)
    body = world["post"]("/api/pipeline/recover-stuck", None).json()
    assert state["twin"]["status"] == "duplicate" and state["twin"]["existing_document_id"] == "stuck", state
    assert body["recovered_count"] == 1
    for d in list(world["enqueued"]):
        world["finish"](d, "analyzed")
    assert world["enqueued"] == ["stuck"]
    assert world["meter"].snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}


def test_one_products_mount_reserves_a_stuck_document_once(world, monkeypatch):
    """Products fires GET /api/sku-analysis/inflight (the watchdog) AND POST
    /api/pipeline/recover-stuck on the same mount. Both saw the row
    unstarted and both reserved and enqueued it; one ledger entry settled
    one of the two reservations."""
    import time
    db, meter = world["db"], world["meter"]
    db.rows("documents").append(dict(_doc("sku-stuck", created=_ago(60)), scope="sku"))
    real = meter.rpc

    def rpc(name, payload):
        if name == "reserve_user_upload":
            time.sleep(0.25)  # the PostgREST round trip
        return real(name, payload)

    monkeypatch.setattr(_usage_gate, "_rpc", rpc)
    client = TestClient(world["app"])
    hdr = {"Authorization": "Bearer jwt:%s" % OWNER}
    gate = threading.Barrier(2)

    def inflight():
        gate.wait()
        return client.get("/api/sku-analysis/inflight", headers=hdr)

    def recover():
        gate.wait()
        return client.post("/api/pipeline/recover-stuck", headers=hdr)

    with ThreadPoolExecutor(max_workers=2) as pool:
        a, b = pool.submit(inflight), pool.submit(recover)
        assert a.result().status_code == 200 and b.result().status_code == 200
    assert world["enqueued"] == ["sku-stuck"], world["enqueued"]
    assert meter.calls.count("reserve_user_upload") == 1, meter.calls
    world["finish"]("sku-stuck", "analyzed")
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}


def test_a_recovery_refused_by_the_meter_gives_its_claim_back(world):
    world["meter"].uploads = 15
    world["db"].rows("documents").append(_doc("refused", created=_ago(60)))
    body = world["post"]("/api/pipeline/recover-stuck", None).json()
    assert [n["id"] for n in body["needs_confirmation"]] == ["refused"]
    row = _row(world, "refused")
    assert row["pipeline_started_at"] is None and _doc_dedupe.in_flight("refused") is None
    # ... so it is still "stuck" for the next page load, and not an original
    assert world["post"]("/api/documents/duplicate-check", {"content_hash": SCANDIA}, org=ORG).json() == \
        {"duplicate": False}


# ── An archived duplicate stays archived (verifier P-F, 2026-09-21) ──────


@pytest.mark.parametrize("route", ["/api/pipeline/run", "/api/pipeline/retry"])
def test_an_archived_duplicate_is_never_run_even_after_a_restart(world, monkeypatch, route):
    """The only guard used to be this process's memory (`_ARCHIVED_HERE`),
    emptied by every restart or deploy — and the re-run's
    `_admin_set_status('queued')` erased the `duplicate_of:` marker."""
    db = world["db"]
    db.rows("documents").extend([
        _doc("orig", status="analyzed", period_id=PERIOD, created="2026-09-20T12:00:12+00:00"),
        _doc("copy", created="2026-09-21T13:05:58+00:00"),
    ])
    assert world["post"]("/api/pipeline/run", {"document_id": "copy"}).json()["status"] == "duplicate"
    monkeypatch.setattr(_doc_dedupe, "_ARCHIVED_HERE", set())  # the engine restarted
    world["meter"].calls.clear()
    r = world["post"](route, {"document_id": "copy"})
    assert r.status_code == 202, r.text
    assert r.json() == {"document_id": "copy", "status": "duplicate",
                        "existing_document_id": "orig", "period_id": PERIOD}
    assert world["enqueued"] == [] and world["meter"].calls == []
    row = _row(world, "copy")
    assert _doc_dedupe.duplicate_of(row["error"]) == "orig" and row["deleted_at"], row


@pytest.mark.parametrize("route", ["/api/pipeline/run", "/api/pipeline/retry"])
def test_a_deleted_document_is_not_analysed(world, route):
    world["db"].rows("documents").append(_doc("gone", status="failed", deleted="2026-09-21T10:00:00+00:00"))
    r = world["post"](route, {"document_id": "gone"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "document_deleted", r.text
    assert world["enqueued"] == [] and world["meter"].calls == []
    assert _row(world, "gone")["status"] == "failed"


# ── The firm request link lands once (verifier P-D / P-G, 2026-09-21) ────


def _landing(world, monkeypatch):
    import types
    from engine.api import _firm_requests as FR
    insp = types.SimpleNamespace(
        entity=types.SimpleNamespace(verdict="match", reason="", to_payload=lambda: {}),
        period={}, detected_type="trial_balance", to_payload=lambda: {})
    monkeypatch.setattr(FR, "inspect_upload", lambda *a, **k: insp)
    stored: List[str] = []
    deps = FR.production_deps()
    deps.upload_object = lambda bucket, path, content, ctype, org_id=None: stored.append(path)
    deps.insert_document = lambda row: (world["db"].insert("documents", dict(row, created_at=_ago(0))) or [row])[0]
    request_row = {"client_org_id": ORG, "period_end": "2025-12-31", "requested_by": OWNER,
                   "expected_identity": {}}
    return FR, deps, request_row, stored


def test_two_simultaneous_landings_of_one_file_count_once(world, monkeypatch):
    """A double click (or a browser retry) on the single-use request link:
    both submissions used to pass the unlocked duplicate look — the request
    flips to RECEIVED only after the landing — and both were reserved,
    stored, analysed and counted to the accountant."""
    FR, deps, request_row, stored = _landing(world, monkeypatch)
    both_looked = threading.Barrier(2, timeout=1.0)
    real_find = deps.find_duplicate

    def find(*a):
        out = real_find(*a)
        try:
            both_looked.wait()  # inspect_upload of a real file takes seconds
        except threading.BrokenBarrierError:
            pass  # the other landing is held behind the lock — the point of it
        return out

    deps.find_duplicate = find

    def land(_):
        try:
            return FR.land_file(request_row, b"balanta scandia 31.12.2025", "b.xls",
                                "application/vnd.ms-excel", deps).document_id
        except FR.LandingRefused as exc:
            return ("refused", exc.status, exc.detail.get("code"))

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(land, [0, 1]))
    refused = [r for r in results if isinstance(r, tuple)]
    assert refused == [("refused", 409, "already_uploaded")], results
    assert len(world["enqueued"]) == 1 and len(stored) == 1, (world["enqueued"], stored)
    assert world["meter"].calls.count("reserve_user_upload") == 1
    world["finish"](world["enqueued"][0], "analyzed")
    assert world["meter"].snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}


@pytest.mark.parametrize("fails_at", ["upload_object", "insert_document", "enqueue"])
def test_a_landing_that_fails_gives_its_reservation_back(world, monkeypatch, fails_at):
    FR, deps, request_row, _ = _landing(world, monkeypatch)

    def boom(*a, **k):
        raise RuntimeError("storage 503")

    setattr(deps, fails_at, boom)
    with pytest.raises(RuntimeError):
        FR.land_file(request_row, b"x" * 10, "b.xls", "application/vnd.ms-excel", deps,
                     document_id="landed")
    assert world["meter"].snapshot()["reserved"] == 0, "a failed landing holds a slot"
    assert "landed" not in pipeline._QUOTA_RUNS and _doc_dedupe.in_flight("landed") is None


# ── A re-run never counts on the non-RO meter (verifier P-E, 2026-09-21) ─


@pytest.fixture()
def multi_nonro(world, monkeypatch):
    """The Multi-Country plan at its included non-RO cap, with the non-RO
    meter mirrored from its SQL (reserve / commit / release)."""
    meter = world["meter"]
    nonro = {"uploads": 8, "reserved": 0, "billed": 0, "calls": []}
    real_rpc = meter.rpc

    def rpc(name, payload):
        if "nonro" in name:
            nonro["calls"].append(name)
            if name == "reserve_user_nonro_upload":
                extra = nonro["uploads"] + nonro["reserved"] >= payload["p_base_cap"]
                nonro["reserved"] += 1
                return {"kind": "allowed", "used": nonro["uploads"], "extra": extra}
            if name == "commit_user_nonro_upload":
                nonro["uploads"] += 1
                nonro["reserved"] = max(0, nonro["reserved"] - 1)
                nonro["billed"] += 1 if payload["p_was_extra"] else 0
                return {}
            if name == "release_user_nonro_upload":
                nonro["reserved"] = max(0, nonro["reserved"] - 1)
                return {}
        return real_rpc(name, payload)

    monkeypatch.setattr(_usage_gate, "_rpc", rpc)
    multi = _pricing_config.CONFIG.plans["multi"]
    monkeypatch.setattr(_plan_state, "get_plan_state", lambda uid: _plan_state.PlanState(
        user_id=uid, plan_key="multi", plan=multi, window_expires_at=None,
        docs_used_this_period=meter.uploads, extra_docs_billed_this_period=meter.extra_billed,
        chat_used_today=0, chat_used_this_period=0, today_iso="2026-09-21",
        period_month_bucket="2026-09", extra_docs_pending_this_period=meter.pending,
        nonro_used_this_period=nonro["uploads"]))

    def stages(document_id):  # the real gate, at the seam _maybe_route_ai_lane calls it
        pipeline._enforce_nonro_plan_gate(_row(world, document_id))
        world["db"].update("documents", {"status": "analyzed", "period_id": PERIOD},
                           filters={"id": "eq.%s" % document_id})
        return "analyzed"

    monkeypatch.setattr(pipeline, "_run_pipeline_stages", stages)
    return nonro


def test_a_retry_of_a_counted_non_ro_document_settles_nothing(world, multi_nonro):
    world["db"].rows("documents").append(_doc("hu-book", h=EEI, status="analyzed", period_id=PERIOD,
                                              started="2026-09-21T10:00:00+00:00"))
    assert world["post"]("/api/pipeline/retry", {"document_id": "hu-book"}).json()["status"] == "queued"
    pipeline._run_pipeline_sync("hu-book")
    assert multi_nonro["calls"] == [], multi_nonro["calls"]
    assert multi_nonro["uploads"] == 8 and world["billed"] == []


def test_the_first_run_of_a_non_ro_document_counts_it_once(world, multi_nonro):
    """Positive control: the first metered run reserves the non-RO meter
    under its verified reserver and commits it once (billed as an extra
    above the included cap)."""
    world["db"].rows("documents").append(_doc("hu-new", h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": "hu-new"}).json()["status"] == "queued"
    pipeline._run_pipeline_sync("hu-new")
    assert multi_nonro["calls"] == ["reserve_user_nonro_upload", "commit_user_nonro_upload"]
    assert multi_nonro["uploads"] == 9 and multi_nonro["billed"] == 1
    assert [b["kind"] for b in world["billed"]] == ["extra_nonro"]


# ── A colleague's upload is theirs (verifier, ACCOUNT clause, 2026-09-21) ─


def test_a_colleagues_page_load_never_archives_or_runs_my_upload(world):
    """OTHER_USER's upload was refused by the 402 (queued, never started).
    OWNER — a member of the same company holding an analysed copy of the
    same bytes — merely opens the dashboard, which calls recover-stuck on
    mount. It used to archive OTHER_USER's upload as a duplicate of OWNER's
    copy (and hide it from the Recently-deleted shelf) — or run it on
    OWNER's quota."""
    db = world["db"]
    db.rows("documents").extend([
        _doc("owner-copy", user=OWNER, status="analyzed", period_id=PERIOD, created=_ago(172800)),
        _doc("colleague-upload", user=OTHER_USER, created=_ago(120)),
    ])
    body = world["post"]("/api/pipeline/recover-stuck", None, user=OWNER).json()
    row = _row(world, "colleague-upload")
    assert row["deleted_at"] is None and row["error"] is None, row
    assert not _doc_dedupe.is_archived_duplicate(row)
    assert body["duplicates"] == [] and body["recovered"] == [] and body["needs_confirmation"] == []
    assert world["enqueued"] == [] and world["meter"].calls == []
    # ... and the colleague's own page load recovers it, under THEIR meter
    body = world["post"]("/api/pipeline/recover-stuck", None, user=OTHER_USER).json()
    assert [r["id"] for r in body["recovered"]] == ["colleague-upload"]


def test_a_colleagues_retry_never_archives_my_document(world):
    world["db"].rows("documents").extend([
        _doc("owner-copy", user=OWNER, status="analyzed", period_id=PERIOD, created="2026-09-19T10:00:00+00:00"),
        _doc("colleague-doc", user=OTHER_USER, status="failed", created="2026-09-20T10:00:00+00:00",
             started="2026-09-20T10:00:01+00:00"),
    ])
    r = world["post"]("/api/pipeline/retry", {"document_id": "colleague-doc"}, user=OWNER).json()
    assert r["status"] == "queued", r
    assert _row(world, "colleague-doc")["deleted_at"] is None


def test_my_own_second_copy_is_still_a_duplicate(world):
    """Positive control for the ACCOUNT clause: the uploader's own entry
    still archives their own copy."""
    world["db"].rows("documents").extend([
        _doc("orig", user=OTHER_USER, status="analyzed", period_id=PERIOD, created="2026-09-19T10:00:00+00:00"),
        _doc("copy", user=OTHER_USER, created="2026-09-21T10:00:00+00:00"),
    ])
    r = world["post"]("/api/pipeline/run", {"document_id": "copy"}, user=OTHER_USER).json()
    assert r["status"] == "duplicate" and r["existing_document_id"] == "orig"


# ── Only a LIVE original blocks a re-upload (verifier, 2026-09-21) ───────


def test_a_run_killed_by_a_restart_is_not_an_original_forever(world):
    """Every deploy recreates the container and kills the daemon thread: the
    row stays 'extracting' with pipeline_started_at set and nothing ever
    marks it failed. Twenty days later the user re-uploads the file."""
    world["db"].rows("documents").append(
        _doc("zombie", status="extracting", started="2026-09-01T09:00:05+00:00",
             created="2026-09-01T09:00:00+00:00"))
    r = world["post"]("/api/documents/duplicate-check",
                      {"content_hash": SCANDIA, "period_end_hint": "2025-12-31"}, org=ORG).json()
    assert r == {"duplicate": False}, r
    world["db"].rows("documents").append(_doc("again"))
    assert world["post"]("/api/pipeline/run", {"document_id": "again"}).json()["status"] == "queued"
    assert _row(world, "zombie")["deleted_at"] is None


def test_a_run_in_flight_is_still_the_original(world):
    world["db"].rows("documents").append(_doc("first", created="2026-09-21T13:00:00+00:00"))
    assert world["post"]("/api/pipeline/run", {"document_id": "first"}).json()["status"] == "queued"
    r = world["post"]("/api/documents/duplicate-check", {"content_hash": SCANDIA}, org=ORG).json()
    assert r["duplicate"] is True and r["existing_document_id"] == "first", r


def test_a_superseded_original_does_not_block_restoring_the_month(world):
    """Demo day: another file analysed into Dec 2025 took over the month
    (duplicate-month REPLACE re-points the period at the newer document).
    The user re-uploads the Scandia file to put it back — it used to be
    refused "Already uploaded — open it", and the link opened a month that
    showed the OTHER document."""
    db = world["db"]
    db.rows("financial_periods")[0]["source_document_id"] = "realestate-xlsx"
    db.rows("documents").extend([
        _doc("scandia-orig", status="analyzed", period_id=PERIOD, created="2026-09-20T12:00:00+00:00"),
        _doc("realestate-xlsx", h=EEI, status="analyzed", period_id=PERIOD, created="2026-09-21T09:00:00+00:00"),
    ])
    r = world["post"]("/api/documents/duplicate-check",
                      {"content_hash": SCANDIA, "period_end_hint": "2025-12-31"}, org=ORG).json()
    assert r == {"duplicate": False}, r
    db.rows("documents").append(_doc("put-back", hint="2025-12-31"))
    assert world["post"]("/api/pipeline/run", {"document_id": "put-back"}).json()["status"] == "queued"


@pytest.mark.parametrize("source", [None, "live-later"])
def test_the_named_original_is_the_copy_that_holds_the_analysis(world, source):
    """A /retry of one copy deletes the shared period, and documents.period_id
    is ON DELETE SET NULL: the other copies stay 'analyzed' with no period.
    "Open it" must lead to the copy that owns the live period, and re-running
    that copy must not archive it against the orphan."""
    world["db"].rows("financial_periods")[0]["source_document_id"] = source
    world["db"].rows("documents").extend([
        _doc("orphan-first", status="analyzed", period_id=None, created="2026-09-18T10:00:00+00:00"),
        _doc("live-later", status="analyzed", period_id=PERIOD, created="2026-09-21T11:00:00+00:00"),
    ])
    r = world["post"]("/api/documents/duplicate-check", {"content_hash": SCANDIA}, org=ORG).json()
    assert r["duplicate"] is True and r["existing_document_id"] == "live-later" and r["period_id"] == PERIOD, r
    rr = world["post"]("/api/pipeline/retry", {"document_id": "live-later"}).json()
    assert rr["status"] == "queued", rr
    # and a re-run of the orphan IS a duplicate of the copy that holds the analysis
    rr = world["post"]("/api/pipeline/retry", {"document_id": "orphan-first"}).json()
    assert rr["status"] == "duplicate" and rr["existing_document_id"] == "live-later", rr


def test_copies_without_any_analysis_still_dedupe_on_the_first(world):
    """When NO copy holds a period (e.g. rows whose analysis carries none),
    the first analysed copy is still the original."""
    world["db"].rows("documents").extend([
        _doc("first", status="analyzed", period_id=None, created="2026-09-18T10:00:00+00:00"),
        _doc("again", created="2026-09-21T11:00:00+00:00"),
    ])
    r = world["post"]("/api/pipeline/run", {"document_id": "again"}).json()
    assert r["status"] == "duplicate" and r["existing_document_id"] == "first", r


def test_a_legacy_original_without_a_content_hash_is_compared(world, monkeypatch):
    """The module promised "a row stored without one is hashed from its
    storage object before it is compared" — but the candidates query
    filtered content_hash=eq.<h>, so a hash-less ORIGINAL was never read."""
    hashed: List[str] = []
    world["db"].rows("documents").extend([
        dict(_doc("legacy-orig", h=None, status="analyzed", period_id=PERIOD,
                  created="2026-03-01T10:00:00+00:00"), size_bytes=4096),
        dict(_doc("other-size", h=None, status="analyzed", created="2026-03-02T10:00:00+00:00"),
             size_bytes=999),
        dict(_doc("new-copy", created="2026-09-21T13:05:58+00:00"), size_bytes=4096),
    ])

    def stored_bytes_hash(doc):
        hashed.append(doc.get("id"))
        return SCANDIA  # the stored bytes ARE the same file

    monkeypatch.setattr(_doc_dedupe, "hash_stored_object", stored_bytes_hash)
    r = world["post"]("/api/pipeline/run", {"document_id": "new-copy"}).json()
    assert r["status"] == "duplicate" and r["existing_document_id"] == "legacy-orig", (r, hashed)
    assert hashed == ["legacy-orig"], "only same-size hash-less copies are hashed: %s" % hashed
    assert _row(world, "legacy-orig")["content_hash"] == SCANDIA, "the computed hash is written back"
    assert world["meter"].calls == []


def test_the_same_workbook_on_products_is_not_a_duplicate_of_its_financial_analysis(world):
    """The duplicate key ignored `scope`: a workbook analysed on the
    dashboard (financial) made the same bytes un-uploadable on Products
    (SKU) — and "open it" sent the user to /products, where the original is
    not."""
    world["db"].rows("documents").append(_doc("fin-1", status="analyzed", period_id=PERIOD))
    r = world["post"]("/api/documents/duplicate-check", {"content_hash": SCANDIA, "scope": "sku"}, org=ORG).json()
    assert r == {"duplicate": False}, r
    world["db"].rows("documents").append(dict(_doc("sku-1"), scope="sku"))
    assert world["post"]("/api/pipeline/run", {"document_id": "sku-1"}).json()["status"] == "queued"
    # ... while the same scope still dedupes, and an older bundle (no scope) means financial
    r = world["post"]("/api/documents/duplicate-check", {"content_hash": SCANDIA}, org=ORG).json()
    assert r["duplicate"] is True and r["existing_document_id"] == "fin-1"
    # and the banner counts the two analyses as two, as the meter does
    world["finish"]("sku-1", "analyzed")
    assert len(_doc_dedupe.unique_successful(world["db"].rows("documents"))) == 2


# ── One confirmation, one document (verifier P-B, 2026-09-21) ────────────


def test_one_confirmation_pays_for_the_one_document_it_was_given_for(world):
    """Two over-cap uploads, ONE dialog confirmed (for b1). b2's /run gets
    its own 402 — it used to run as a paid extra with no dialog, and both
    were billed on one confirmation."""
    meter = world["meter"]
    meter.uploads = 15
    world["db"].rows("documents").extend([_doc("b1", h="b" * 64), _doc("b2", h="c" * 64)])
    assert world["post"]("/api/pipeline/run", {"document_id": "b1"}).status_code == 402
    assert _confirm(world, "b1").status_code == 200
    assert world["post"]("/api/pipeline/run", {"document_id": "b1"}).json()["status"] == "queued"
    r2 = world["post"]("/api/pipeline/run", {"document_id": "b2"})
    assert r2.status_code == 402, ("an over-cap upload ran with no dialog of its own", r2.text)
    for d in list(world["enqueued"]):
        world["finish"](d, "analyzed")
    assert world["enqueued"] == ["b1"]
    assert meter.snapshot() == {"uploads": 16, "reserved": 0, "extra_billed": 1, "pending": 0}
    assert [b["reservation_id"] for b in world["billed"]] == ["b1"]


def test_recover_stuck_never_runs_a_document_whose_dialog_was_dismissed(world):
    """`refused` got a 402 the user dismissed. While the confirmed extra for
    `wanted` is in flight, a page mount calls recover-stuck: `refused` stays
    queued and asks for its own confirmation — never a paid extra."""
    from datetime import datetime, timedelta, timezone
    ago = lambda s: (datetime.now(timezone.utc) - timedelta(seconds=s)).isoformat()  # noqa: E731
    meter, db = world["meter"], world["db"]
    meter.uploads = 15
    db.rows("documents").append(_doc("refused", h="d" * 64, created=ago(120)))
    assert world["post"]("/api/pipeline/run", {"document_id": "refused"}).status_code == 402  # dismissed
    db.rows("documents").append(_doc("wanted", h="e" * 64, created=ago(1)))
    assert world["post"]("/api/pipeline/run", {"document_id": "wanted"}).status_code == 402
    assert _confirm(world, "wanted").status_code == 200
    assert world["post"]("/api/pipeline/run", {"document_id": "wanted"}).json()["status"] == "queued"
    body = world["post"]("/api/pipeline/recover-stuck", None).json()
    assert body["recovered_count"] == 0
    assert [n["id"] for n in body["needs_confirmation"]] == ["refused"]
    for d in list(world["enqueued"]):
        world["finish"](d, "analyzed")
    assert world["enqueued"] == ["wanted"]
    assert meter.snapshot()["extra_billed"] == 1 and [b["reservation_id"] for b in world["billed"]] == ["wanted"]
    assert not _row(world, "refused").get("metered_extra")


def test_a_double_click_on_confirm_reserves_one_extra(world):
    meter = world["meter"]
    meter.uploads = 15
    world["db"].rows("documents").append(_doc("b1"))
    assert world["post"]("/api/pipeline/run", {"document_id": "b1"}).status_code == 402
    assert _confirm(world, "b1").status_code == 200
    assert _confirm(world, "b1").status_code == 200
    assert meter.calls.count("reserve_user_upload_extra") == 1, meter.calls
    assert meter.snapshot()["reserved"] == 1 and meter.snapshot()["pending"] == 1


def test_a_confirmed_extra_whose_upload_turns_out_a_duplicate_is_given_back(world):
    meter, db = world["meter"], world["db"]
    meter.uploads = 15
    db.rows("documents").append(_doc("copy", created="2026-09-21T13:05:58+00:00"))
    assert world["post"]("/api/pipeline/run", {"document_id": "copy"}).status_code == 402
    assert _confirm(world, "copy").status_code == 200
    # meanwhile another tab's copy of the same bytes started first
    db.rows("documents").append(_doc("orig", status="analyzed", period_id=PERIOD,
                                     created="2026-09-21T13:00:00+00:00"))
    assert world["post"]("/api/pipeline/run", {"document_id": "copy"}).json()["status"] == "duplicate"
    assert meter.snapshot() == {"uploads": 15, "reserved": 0, "extra_billed": 0, "pending": 0}
    assert world["billed"] == []


def test_an_unclaimed_grant_expires_and_gives_its_slot_back(world, monkeypatch):
    meter = world["meter"]
    meter.uploads = 15
    world["db"].rows("documents").append(_doc("b1"))
    assert world["post"]("/api/pipeline/run", {"document_id": "b1"}).status_code == 402
    assert _confirm(world, "b1").status_code == 200
    assert meter.snapshot()["reserved"] == 1
    later = _usage_gate._now_mono() + _usage_gate.EXTRA_GRANT_TTL_S + 1
    monkeypatch.setattr(_usage_gate, "_now_mono", lambda: later)
    assert world["post"]("/api/pipeline/run", {"document_id": "b1"}).status_code == 402
    assert meter.snapshot() == {"uploads": 15, "reserved": 0, "extra_billed": 0, "pending": 0}


def test_a_confirm_from_an_older_bundle_is_for_the_document_of_the_last_402(world):
    """An older browser bundle confirms with no body: the grant goes to the
    document the caller's last 402 was about — and only to it."""
    meter = world["meter"]
    meter.uploads = 15
    world["db"].rows("documents").extend([_doc("b1", h="b" * 64), _doc("b2", h="c" * 64)])
    assert world["post"]("/api/pipeline/run", {"document_id": "b1"}).status_code == 402
    assert _confirm(world).status_code == 200
    assert world["post"]("/api/pipeline/run", {"document_id": "b2"}).status_code == 402
    assert world["post"]("/api/pipeline/run", {"document_id": "b1"}).json()["status"] == "queued"


def test_a_confirm_for_a_document_of_another_workspace_is_refused(world):
    stranger_doc = _doc("theirs", org="99999999-0000-4000-8000-000000000000", user=OTHER_USER)
    world["db"].rows("documents").append(stranger_doc)
    world["meter"].uploads = 15
    r = _confirm(world, "theirs")
    assert r.status_code in (403, 404), r.text
    assert world["meter"].calls == []


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
    world["db"].rows("documents").append(_doc("eei", h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": "eei"}).status_code == 402
    assert _confirm(world, "eei").status_code == 200  # the user confirmed the €-dialog
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
        assert world["post"]("/api/pipeline/run", {"document_id": doc_id}).status_code == 402
        assert _confirm(world, doc_id).status_code == 200
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
    world["db"].rows("documents").append(_doc("book"))
    r = _confirm(world, "book")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "no_extra_needed"
    assert world["meter"].calls == ["reserve_user_upload", "release_user_upload"], world["meter"].calls
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


def test_the_banner_never_counts_a_copy_of_an_earlier_months_book(world):
    rows = world["db"].rows("documents")
    rows.append(_doc("aug-book", status="analyzed", created="2026-08-20T10:00:00+00:00"))
    rows.append(_doc("sep-copy", status="analyzed", created="2026-09-02T10:00:00+00:00"))
    rows.append(_doc("sep-book", h=EEI, status="analyzed", created="2026-09-03T10:00:00+00:00"))
    assert _doc_dedupe.unique_successful_docs_in_month(OWNER, "2026-08") == 1
    assert _doc_dedupe.unique_successful_docs_in_month(OWNER, "2026-09") == 1


def _banner(world):
    from engine.api import _pricing_routes
    app = FastAPI()
    app.include_router(_pricing_routes.build_router())
    return TestClient(app).get("/api/plan/state", headers={"Authorization": "Bearer jwt:%s" % OWNER}).json()


def test_the_banner_agrees_with_the_meter_after_a_delete_and_re_upload(world):
    """The live gate analyses a re-upload after the user DELETED the
    original (a deleted copy is not an original) and the meter counts it.
    The banner collapsed the two into one — the banner and the 402 must
    agree (verifier lens Q)."""
    db = world["db"]
    db.rows("documents").append(_doc("first", created="2026-09-20T10:00:00+00:00"))
    assert world["post"]("/api/pipeline/run", {"document_id": "first"}).json()["status"] == "queued"
    world["finish"]("first", "analyzed")
    db.update("documents", {"deleted_at": "2026-09-21T09:00:00+00:00"}, filters={"id": "eq.first"})
    db.rows("documents").append(_doc("again", created="2026-09-21T10:00:00+00:00"))
    assert world["post"]("/api/pipeline/run", {"document_id": "again"}).json()["status"] == "queued"
    world["finish"]("again", "analyzed")
    assert _banner(world)["docs_used"] == world["meter"].snapshot()["uploads"] == 2


def test_the_banner_agrees_with_the_meter_on_a_detected_versus_a_confirmed_period(world):
    """An undated original analysed into December 2024; the same bytes
    re-uploaded with the user-confirmed date 31.12.2025. The live gate: a
    different period, analysed and counted. The banner compared hints only
    and collapsed them."""
    db = world["db"]
    db.rows("financial_periods").append({"id": "p2024", "org_id": ORG, "period_end": "2024-12-31"})
    db.rows("documents").append(_doc("undated", created="2026-09-20T10:00:00+00:00"))
    world["post"]("/api/pipeline/run", {"document_id": "undated"})
    world["finish"]("undated", "analyzed")
    db.update("documents", {"period_id": "p2024"}, filters={"id": "eq.undated"})
    db.rows("documents").append(_doc("dated", hint="2025-12-31", created="2026-09-21T10:00:00+00:00"))
    assert world["post"]("/api/pipeline/run", {"document_id": "dated"}).json()["status"] == "queued"
    world["finish"]("dated", "analyzed")
    assert _banner(world)["docs_used"] == world["meter"].snapshot()["uploads"] == 2


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
