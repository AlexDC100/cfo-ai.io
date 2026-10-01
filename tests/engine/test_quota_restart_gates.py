"""A RESERVATION OUTLIVES THE PROCESS THAT MADE IT — and is given back.

Verifier lens S (2026-09-21, S8). The reservation ledger (`_QUOTA_RUNS`),
the in-flight registry and the confirmed-extra grants lived only in the
engine process. A deploy restart mid-run (`docker compose up -d`) killed the
daemon thread and lost the entry: the reservation stayed in
`user_usage.uploads_reserved`, which `reserve_user_upload` counts against
the cap, and the user's re-run reserved AGAIN. At 13/15: /run reserves, the
restart, /retry succeeds → {uploads 14, reserved 1} and the next unique
book got the 402 "You've used 14 of 15". The restore script "reconciled"
nothing — it deliberately left the current month's reservations alone. A
confirmed extra lost in a restart likewise left reserved+1 and
extra_docs_pending+1 behind.

THE FIX: every reservation is also written to the document's row of the
server-only quota ledger (`reservation_id`, `reserved_at`, `was_extra`,
`month`, the `owner` process and its `heartbeat_at`):
  * the document's next entry ADOPTS an outstanding reservation of its own
    instead of reserving again (a lost grant is still this document's paid
    extra — the user confirmed it);
  * a background sweep releases a reservation whose owner stopped
    heartbeating (STALE_AFTER_S) and that is not live in this process —
    compare-and-set on `reservation_id`, so two sweepers release it once;
  * the settlement settles into the month the reservation was made in;
  * the restore script releases stale reservations and resets the current
    month's `uploads_reserved` to the reservations still live.

WHAT THESE RED ON, with the defect repaired (TC-11):
  * a run killed by a restart leaving a slot the cap counts after its
    document was re-run, or after the sweep;
  * a live run's (or a fresh heartbeat's) reservation being released;
  * one stale reservation released twice;
  * a lost confirmed extra re-opening the dialog, or never given back.

THE MARK BEFORE THE MOVE (the second RESTART defect, 2026-09-26). The
settlement is two writes — the meter RPC and the ledger record. A record
that failed (kept in `_PENDING`, retried in-process) followed by a restart
left a row reading "reserved" for a meter that had already moved; the new
process's sweep found the analysis finished and settled it AS A COMMIT
again: uploads + 2, a confirmed extra billed twice through
`record_metered_extra_doc`. The `settling_at` gates below red on:
  * a finished analysis committed a second time, or a paid extra billed a
    second time, by the sweep after a restart;
  * the meter moving before the row is stamped SETTLING;
  * a book whose settlement is undetermined being metered again (a retry,
    a failed free correction's retry), or its row adopted;
  * the sweep's OWN commit — whose record failed — counting the book twice;
  * the restore script releasing, or failing to report, a settling row;
  * a settled row (committed or released) still carrying the mark.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from engine.api import _doc_dedupe, _quota_ledger, _usage_gate, pipeline

from test_duplicate_upload_gate import (  # noqa: F401 — the fixture
    EEI, OTHER_USER, OWNER, _confirm, _doc, _row, world,
)


def _restart():
    """What `docker compose up -d` does to the engine process: every
    in-memory registry is gone, the daemon threads died."""
    pipeline._QUOTA_RUNS.clear()
    _doc_dedupe._IN_FLIGHT.clear()
    _usage_gate._EXTRA_GRANTS.clear()
    _usage_gate._LAST_EXTRA_REQUIRED.clear()


def _later(minutes: float) -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


def _ago(seconds: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


def _ledger(world, doc_id):
    return next((r for r in world["db"].rows(_quota_ledger.TABLE) if r["document_id"] == doc_id), None)


def test_s8_a_re_run_after_a_restart_adopts_the_lost_reservation(world):
    meter = world["meter"]
    meter.uploads = 13
    world["db"].rows("documents").append(_doc("book", h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": "book"}).json()["status"] == "queued"
    assert meter.reserved == 1 and _ledger(world, "book")["reserved_at"]
    _restart()
    assert world["post"]("/api/pipeline/retry", {"document_id": "book"}).json()["status"] == "queued"
    assert meter.calls == ["reserve_user_upload"], ("the re-run reserved a second slot", meter.calls)
    world["finish"]("book", "analyzed")
    assert meter.snapshot() == {"uploads": 14, "reserved": 0, "extra_billed": 0, "pending": 0}
    world["db"].rows("documents").append(_doc("next", h="%064x" % 99, created="2026-09-21T15:00:00+00:00"))
    r = world["post"]("/api/pipeline/run", {"document_id": "next"})
    assert r.status_code == 202, ("the 15th book met the 402 — a killed run still holds a slot", r.text)


def test_the_sweep_gives_back_a_reservation_whose_run_died(world):
    meter = world["meter"]
    world["db"].rows("documents").append(_doc("book", h=EEI))
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    _restart()
    # a fresh heartbeat is another process's live run: never touched
    assert _quota_ledger.sweep_stale(is_live=pipeline._reservation_is_live) == []
    assert meter.reserved == 1
    released = _quota_ledger.sweep_stale(is_live=pipeline._reservation_is_live, now=_later(11))
    assert [r["document_id"] for r in released] == ["book"]
    assert meter.snapshot() == {"uploads": 0, "reserved": 0, "extra_billed": 0, "pending": 0}
    assert _ledger(world, "book")["reserved_at"] is None
    # once: a second sweep (another container) releases nothing more
    assert _quota_ledger.sweep_stale(is_live=pipeline._reservation_is_live, now=_later(20)) == []
    assert meter.calls == ["reserve_user_upload", "release_user_upload"]


def test_a_sweeper_that_read_the_row_before_the_adoption_releases_nothing(world, monkeypatch):
    """Two processes during a deploy: the old container's sweep reads the
    orphaned row, then the document's re-run in the new container adopts
    it, then the sweep's release lands. Adoption swaps the reservation id
    (compare-and-set), so the stale sweep matches nothing — the slot the
    adopted run holds is never given back under it."""
    meter = world["meter"]
    world["db"].rows("documents").append(_doc("book", h=EEI))
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    _restart()
    read_before = _quota_ledger.stale_outstanding(now=_later(11))
    assert [r["document_id"] for r in read_before] == ["book"]
    assert world["post"]("/api/pipeline/retry", {"document_id": "book"}).json()["status"] == "queued"
    monkeypatch.setattr(_quota_ledger, "stale_outstanding", lambda **kw: read_before)
    assert _quota_ledger.sweep_stale(is_live=lambda _d: False) == []
    assert meter.snapshot()["reserved"] == 1
    world["finish"]("book", "analyzed")
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}


def test_a_reservation_the_sweep_released_first_is_never_adopted(world, monkeypatch):
    """The other order: the re-run reads the orphaned row, a sweeper
    releases it, then the re-run takes it over. Adopting a reservation the
    meter no longer holds would let the run's commit consume ANOTHER run's
    slot. Adoption is a compare-and-set on the row still being reserved;
    it loses, and the re-run reserves its own slot."""
    meter = world["meter"]
    world["db"].rows("documents").extend([_doc("book", h=EEI), _doc("other", h="%064x" % 3)])
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    world["post"]("/api/pipeline/run", {"document_id": "other"})   # stays in flight
    pipeline._QUOTA_RUNS.pop("book")
    _doc_dedupe._IN_FLIGHT.pop("book")
    read_before = _quota_ledger.outstanding("book")
    assert [r["document_id"] for r in _quota_ledger.sweep_stale(
        is_live=pipeline._reservation_is_live, now=_later(11))] == ["book"]
    assert meter.reserved == 1                                   # only `other` holds a slot
    monkeypatch.setattr(_quota_ledger, "outstanding", lambda _d: dict(read_before))
    assert world["post"]("/api/pipeline/retry", {"document_id": "book"}).json()["status"] == "queued"
    world["finish"]("book", "analyzed")
    assert meter.snapshot()["uploads"] == 1
    assert meter.snapshot()["reserved"] == 1, ("the adopted run consumed `other`'s slot", meter.snapshot())


def test_the_sweep_never_releases_a_run_live_in_this_process(world):
    meter = world["meter"]
    world["db"].rows("documents").append(_doc("book", h=EEI))
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    assert _quota_ledger.sweep_stale(is_live=pipeline._reservation_is_live, now=_later(60)) == []
    assert meter.reserved == 1
    world["finish"]("book", "analyzed")
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}


def _run_finished_but_its_settlement_was_lost(world, doc_id="book", *, extra=False):
    """The daemon thread wrote `analyzed` and the restart killed it before
    `_commit_pipeline_quota` ran: the reservation is outstanding, the
    analysis exists."""
    meter = world["meter"]
    world["db"].rows("documents").append(_doc(doc_id, h=EEI))
    if extra:
        meter.uploads = 15
        assert world["post"]("/api/pipeline/run", {"document_id": doc_id}).status_code == 402
        assert _confirm(world, doc_id).status_code == 200
    assert world["post"]("/api/pipeline/run", {"document_id": doc_id}).json()["status"] == "queued"
    world["db"].update("documents", {"status": "analyzed", "period_id": "ce72e080-32a2-4d5c-8c7f-a10d84212b2e"},
                       filters={"id": "eq.%s" % doc_id})
    _restart()


def test_the_sweep_settles_an_orphan_whose_analysis_finished_as_a_commit(world):
    meter = world["meter"]
    _run_finished_but_its_settlement_was_lost(world)
    released = _quota_ledger.sweep_stale(is_live=pipeline._reservation_is_live,
                                         release=pipeline._settle_orphaned_reservation, now=_later(11))
    assert [r["document_id"] for r in released] == ["book"]
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}
    assert _ledger(world, "book")["committed_at"] and _ledger(world, "book")["reserved_at"] is None
    # ... and the book is counted: its re-run is free
    calls = list(meter.calls)
    world["post"]("/api/pipeline/retry", {"document_id": "book"})
    world["finish"]("book", "analyzed")
    assert meter.calls == calls


def test_the_sweep_settles_an_orphaned_paid_extra_whose_analysis_finished_once(world):
    meter = world["meter"]
    _run_finished_but_its_settlement_was_lost(world, extra=True)
    for _ in range(2):  # two containers sweeping
        _quota_ledger.sweep_stale(is_live=pipeline._reservation_is_live,
                                  release=pipeline._settle_orphaned_reservation, now=_later(11))
    assert meter.snapshot() == {"uploads": 16, "reserved": 0, "extra_billed": 1, "pending": 0}
    assert [b["reservation_id"] for b in world["billed"]] == ["book"]


def test_the_restore_leaves_an_orphan_whose_analysis_finished_to_the_engine(world, restore):
    """The restore never charges: an orphan whose analysis finished is the
    engine's to settle (as a commit, billed if it was a confirmed extra) —
    the script neither releases its slot nor counts it."""
    _run_finished_but_its_settlement_was_lost(world)
    row = _mirror_usage(world)
    for r in world["db"].rows(_quota_ledger.TABLE):
        r["heartbeat_at"] = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
    assert restore.main(["--apply", "--no-hash-missing"]) == 0
    assert world["meter"].reserved == 1 and _ledger(world, "book")["reserved_at"]
    assert row["uploads_reserved"] == 1


def test_a_commit_whose_ledger_write_failed_is_retried_never_counted_twice(world, monkeypatch):
    """`commit_user_upload` landed but the ledger write after it failed (a
    transient 5xx). The row still reads reserved; were its heartbeat to
    stop, the sweep would settle the finished analysis as a commit AGAIN.
    The process keeps the failed write, heartbeats it and retries it."""
    meter = world["meter"]
    world["db"].rows("documents").append(_doc("book", h=EEI))
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    real_upsert = world["db"].upsert
    fails = {"n": 1}

    def flaky(table, rows, **kw):
        if table == _quota_ledger.TABLE and rows.get("committed_at") and fails["n"]:
            fails["n"] -= 1
            raise RuntimeError("PostgREST 503")
        return real_upsert(table, rows, **kw)

    monkeypatch.setattr(world["db"], "upsert", flaky)
    world["finish"]("book", "analyzed")
    assert meter.snapshot()["uploads"] == 1 and _ledger(world, "book")["reserved_at"]
    assert "book" in pipeline._live_reservation_ids()
    for r in world["db"].rows(_quota_ledger.TABLE):
        r["heartbeat_at"] = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
    assert _quota_ledger.sweep_stale(is_live=pipeline._reservation_is_live,
                                     release=pipeline._settle_orphaned_reservation) == []
    _quota_ledger.retry_pending()
    assert _ledger(world, "book")["committed_at"] and _ledger(world, "book")["reserved_at"] is None
    assert "book" not in pipeline._live_reservation_ids()
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}


def test_the_heartbeat_keeps_live_reservations_fresh(world):
    world["db"].rows("documents").extend([_doc("live", h=EEI), _doc("dead", h="%064x" % 7)])
    world["post"]("/api/pipeline/run", {"document_id": "live"})
    world["post"]("/api/pipeline/run", {"document_id": "dead"})
    pipeline._QUOTA_RUNS.pop("dead")
    _doc_dedupe._IN_FLIGHT.pop("dead")
    stale = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
    for r in world["db"].rows(_quota_ledger.TABLE):
        r["heartbeat_at"] = stale
    _quota_ledger.heartbeat(pipeline._live_reservation_ids())
    assert _ledger(world, "live")["heartbeat_at"] > stale and _ledger(world, "dead")["heartbeat_at"] == stale
    released = _quota_ledger.sweep_stale(is_live=lambda _d: False)
    assert [r["document_id"] for r in released] == ["dead"]


def test_a_confirmed_extra_lost_in_a_restart_is_still_this_documents_paid_extra(world):
    meter = world["meter"]
    meter.uploads = 15
    world["db"].rows("documents").append(_doc("over", h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": "over"}).status_code == 402
    assert _confirm(world, "over").status_code == 200
    assert meter.snapshot()["pending"] == 1
    _restart()
    r = world["post"]("/api/pipeline/run", {"document_id": "over"})
    assert r.status_code == 202, ("the dialog the user already confirmed opened again", r.text)
    world["finish"]("over", "analyzed")
    assert meter.snapshot() == {"uploads": 16, "reserved": 0, "extra_billed": 1, "pending": 0}
    assert [b["reservation_id"] for b in world["billed"]] == ["over"]


def test_a_confirmed_extra_lost_in_a_restart_and_never_run_is_given_back(world):
    meter = world["meter"]
    meter.uploads = 15
    world["db"].rows("documents").append(_doc("over", h=EEI))
    world["post"]("/api/pipeline/run", {"document_id": "over"})
    _confirm(world, "over")
    _restart()
    released = _quota_ledger.sweep_stale(is_live=pipeline._reservation_is_live, now=_later(11))
    assert [r["document_id"] for r in released] == ["over"]
    assert meter.snapshot() == {"uploads": 15, "reserved": 0, "extra_billed": 0, "pending": 0}
    assert world["billed"] == []


def test_recover_stuck_never_spends_a_lost_confirmed_extra(world):
    """Only the document's own /run spends its confirmed extra — also after a
    restart lost the in-memory grant."""
    meter = world["meter"]
    meter.uploads = 15
    # A minute old, RELATIVE to the clock: a fixed date crossed the route's
    # 24h zombie cutoff and the row was marked `failed` before the grant
    # rule was ever consulted — the gate stayed green for the wrong reason.
    world["db"].rows("documents").append(_doc("over", h=EEI, created=_ago(60)))
    world["post"]("/api/pipeline/run", {"document_id": "over"})
    _confirm(world, "over")
    _restart()
    body = world["post"]("/api/pipeline/recover-stuck", None).json()
    assert body["stale_failed"] == [], ("the age rule, not the grant rule, kept it out", body)
    assert body["recovered"] == [] and body["needs_confirmation"] == [] and world["enqueued"] == []
    assert meter.snapshot()["pending"] == 1 and meter.reserved == 1


def test_the_settlement_settles_into_the_month_of_the_reservation(world, monkeypatch):
    """A run reserved in September and finished after midnight on 1 October
    releases the September reservation — the month it was made in."""
    payloads = []
    real = _usage_gate._rpc
    monkeypatch.setattr(_usage_gate, "_rpc", lambda name, p: (payloads.append((name, p.get("p_month"))),
                                                               real(name, p))[1])
    monkeypatch.setattr(_usage_gate, "_month_bucket", lambda d=None: "2026-09")
    world["db"].rows("documents").append(_doc("book", h=EEI))
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    monkeypatch.setattr(_usage_gate, "_month_bucket", lambda d=None: "2026-10")
    world["finish"]("book", "analyzed")
    assert payloads == [("reserve_user_upload", "2026-09"), ("commit_user_upload", "2026-09")], payloads
    assert _ledger(world, "book")["month"] == "2026-09"


# ── The restore script: the current month's reservations ───────────────


@pytest.fixture()
def restore(world, monkeypatch):
    from engine.api import _pricing_tiers
    monkeypatch.setattr(_pricing_tiers, "current_month_bucket", lambda now=None: "2026-09")
    # ONE month for the restore AND for the run it restores. The script's
    # month was pinned here and the engine's was not: a run reserved by a
    # test stamped its ledger row with the WALL CLOCK's month, so the two
    # agreed only while the calendar read September 2026 — from 2026-10-01
    # the restore saw "no live reservation this month" and reset the slot of
    # a live run (two reds, on a suite nothing had changed in).
    monkeypatch.setattr(_usage_gate, "_month_bucket", lambda d=None: "2026-09")
    world["db"].rows("user_usage").append({"id": "uu", "user_id": OWNER, "month": "2026-09",
                                           "uploads": 0, "uploads_reserved": 0})
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parents[2] / "scripts" / "recompute_document_quota.py"
    spec = importlib.util.spec_from_file_location("recompute_document_quota", str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _mirror_usage(world):
    """The Meter is the SQL; the restore reads and writes user_usage."""
    row = world["db"].rows("user_usage")[0]
    row["uploads"], row["uploads_reserved"] = world["meter"].uploads, world["meter"].reserved
    return row


def test_the_restore_releases_a_killed_runs_slot_in_the_current_month(world, restore):
    world["db"].rows("documents").append(_doc("book", h=EEI))
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    _restart()
    for r in world["db"].rows(_quota_ledger.TABLE):
        r["heartbeat_at"] = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
    assert restore.main(["--apply", "--no-hash-missing"]) == 0
    assert world["meter"].reserved == 0 and _ledger(world, "book")["reserved_at"] is None


def test_the_restore_resets_current_month_reservations_no_run_holds(world, restore):
    """A reservation left from before the ledger existed (or by a write that
    never reached it) belongs to no running document."""
    row = world["db"].rows("user_usage")[0]
    row["uploads_reserved"] = 2
    assert restore.main(["--apply", "--no-hash-missing"]) == 0
    assert row["uploads_reserved"] == 0


def test_the_restore_keeps_a_live_runs_reservation(world, restore):
    world["db"].rows("documents").append(_doc("book", h=EEI))
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    row = _mirror_usage(world)
    assert row["uploads_reserved"] == 1
    assert restore.main(["--apply", "--no-hash-missing"]) == 0
    assert row["uploads_reserved"] == 1 and world["meter"].reserved == 1


# ── THE MARK BEFORE THE MOVE (the second RESTART defect) ──────────────


def _commit_record_fails(world, monkeypatch):
    """The ledger's COMMIT record (the upsert carrying `committed_at`)
    fails — a transient PostgREST 5xx after the meter RPC landed. Returns
    the restore of the real upsert."""
    real_upsert = world["db"].upsert

    def flaky(table, rows, **kw):
        if table == _quota_ledger.TABLE and rows.get("committed_at"):
            raise RuntimeError("PostgREST 503")
        return real_upsert(table, rows, **kw)

    monkeypatch.setattr(world["db"], "upsert", flaky)
    return lambda: monkeypatch.setattr(world["db"], "upsert", real_upsert)


def _restart_with_pending_lost():
    """A restart before the in-process retry of the failed record landed."""
    _restart()
    _quota_ledger._PENDING.clear()


def _sweep(world, minutes=11):
    return _quota_ledger.sweep_stale(is_live=pipeline._reservation_is_live,
                                     release=pipeline._settle_orphaned_reservation, now=_later(minutes))


def test_r1_a_commit_whose_record_was_lost_in_a_restart_is_never_committed_again_by_the_sweep(
        world, monkeypatch, caplog):
    """probe_restart.py::test_R1 (laneA verify, 2026-09-26). commit_user_upload
    landed, the ledger write after it failed, the process restarted before
    the retry landed. The row reads reserved; the sweep finds the analysis
    finished — and must NOT settle it as a commit again."""
    import logging
    meter = world["meter"]
    world["db"].rows("documents").append(_doc("book", h=EEI))
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    restore_upsert = _commit_record_fails(world, monkeypatch)
    world["finish"]("book", "analyzed")
    assert meter.snapshot()["uploads"] == 1 and _ledger(world, "book")["reserved_at"]
    restore_upsert()
    _restart_with_pending_lost()
    with caplog.at_level(logging.ERROR, logger="engine.api._quota_ledger"):
        assert _sweep(world) == []
    assert meter.snapshot()["uploads"] == 1, ("the finished analysis was committed a second time", meter.calls)
    assert meter.calls == ["reserve_user_upload", "commit_user_upload"], meter.calls
    row = _ledger(world, "book")
    assert row["reserved_at"] and row["settling_at"] and row.get("committed_at") is None, (
        "the evidence for the restore script was cleared", row)
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR and "SETTLING" in r.getMessage()
              and "book" in r.getMessage()]
    assert errors, "a settling row the sweep left alone must be reported at ERROR"
    # once per process: a second tick neither settles nor reports it again
    caplog.clear()
    with caplog.at_level(logging.ERROR, logger="engine.api._quota_ledger"):
        assert _sweep(world, 20) == []
    assert not [r for r in caplog.records if "SETTLING" in r.getMessage()]
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}


def test_r2_a_paid_extra_whose_record_was_lost_in_a_restart_is_billed_once(world, monkeypatch):
    """probe_restart.py::test_R2: the same at the cap, after Confirm —
    `record_metered_extra_doc` was called twice with reservation_id='book'."""
    meter = world["meter"]
    meter.uploads = 15
    world["db"].rows("documents").append(_doc("book", h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": "book"}).status_code == 402
    assert _confirm(world, "book").status_code == 200
    assert world["post"]("/api/pipeline/run", {"document_id": "book"}).json()["status"] == "queued"
    restore_upsert = _commit_record_fails(world, monkeypatch)
    world["finish"]("book", "analyzed")
    assert meter.snapshot() == {"uploads": 16, "reserved": 0, "extra_billed": 1, "pending": 0}
    restore_upsert()
    _restart_with_pending_lost()
    for _ in range(2):  # two containers sweeping
        assert _sweep(world) == []
    assert meter.snapshot() == {"uploads": 16, "reserved": 0, "extra_billed": 1, "pending": 0}, meter.calls
    assert [b["reservation_id"] for b in world["billed"]] == ["book"], ("billed twice", world["billed"])


def test_the_settling_mark_lands_before_the_meter_moves(world, monkeypatch):
    """Every settlement stamps the row BEFORE the RPC that moves the meter
    — a commit and a release alike — with a compare-and-set on the run's
    own reservation id; a settled row carries no mark."""
    meter = world["meter"]
    seen = {}
    real = meter.rpc

    def rpc(name, payload):
        if name in ("commit_user_upload", "release_user_upload"):
            row = _ledger(world, payload_doc[0])
            seen[name] = (row.get("settling_at"), row.get("reservation_id"))
        return real(name, payload)

    payload_doc = ["book"]
    monkeypatch.setattr(_usage_gate, "_rpc", rpc)
    world["db"].rows("documents").extend([_doc("book", h=EEI), _doc("bad", h="%064x" % 5)])
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    rid = _ledger(world, "book")["reservation_id"]
    assert rid and pipeline._QUOTA_RUNS["book"].reservation_id == rid, "the run holds its ledger reservation id"
    world["finish"]("book", "analyzed")
    assert seen["commit_user_upload"] == (seen["commit_user_upload"][0], rid) and seen["commit_user_upload"][0], (
        "the meter moved before the row was stamped SETTLING", seen)
    row = _ledger(world, "book")
    assert row["committed_at"] and row["reserved_at"] is None and row["settling_at"] is None, row
    payload_doc[0] = "bad"
    world["post"]("/api/pipeline/run", {"document_id": "bad"})
    world["finish"]("bad", "failed")
    assert seen["release_user_upload"][0], ("released before the row was stamped SETTLING", seen)
    row = _ledger(world, "bad")
    assert row["released_at"] and row["reserved_at"] is None and row["settling_at"] is None, row
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}


def test_a_book_whose_settlement_is_undetermined_is_never_metered_again(world, monkeypatch):
    """After R1 (reserved + settling, record lost, restart): the meter may
    already have counted the book. Its re-run is unmetered; a free
    correction that FAILS and the retry after it are still unmetered — the
    status rule would have counted it again — and the row keeps its
    evidence for the restore script. Adoption refuses it outright."""
    meter = world["meter"]
    world["db"].rows("documents").append(_doc("book", h=EEI))
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    restore_upsert = _commit_record_fails(world, monkeypatch)
    world["finish"]("book", "analyzed")
    restore_upsert()
    _restart_with_pending_lost()
    before = dict(_ledger(world, "book"))
    assert _quota_ledger.adopt("book", user_id=OWNER, take_extra=True) is None
    assert _ledger(world, "book") == before, "adoption touched a settling row"
    calls = list(meter.calls)
    assert world["post"]("/api/pipeline/retry", {"document_id": "book"}).json()["status"] == "queued"
    world["finish"]("book", "failed")
    assert world["post"]("/api/pipeline/retry", {"document_id": "book"}).json()["status"] == "queued"
    world["finish"]("book", "analyzed")
    assert meter.calls == calls, ("a book whose settlement is undetermined was metered again", meter.calls)
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}
    row = _ledger(world, "book")
    assert row["reserved_at"] and row["settling_at"] and row.get("committed_at") is None, row


def test_the_sweeps_own_commit_whose_record_was_lost_never_counts_the_book_twice(world, monkeypatch):
    """The sweep settles an orphan whose analysis finished as a commit; ITS
    record fails; restart. The sweep used to pre-clear the row as
    *released* before committing — so the row read released, the meter read
    committed, and the failed free correction's retry metered the book
    again. Now the sweep CLAIMS the row SETTLING and leaves it so."""
    meter = world["meter"]
    _run_finished_but_its_settlement_was_lost(world)
    restore_upsert = _commit_record_fails(world, monkeypatch)
    assert [r["document_id"] for r in _sweep(world)] == ["book"]
    assert meter.snapshot()["uploads"] == 1
    row = _ledger(world, "book")
    assert row["reserved_at"] and row["settling_at"] and not row.get("committed_at") and not row.get("released_at"), row
    restore_upsert()
    _restart_with_pending_lost()
    assert _sweep(world, 20) == [] and meter.snapshot()["uploads"] == 1
    world["post"]("/api/pipeline/retry", {"document_id": "book"})
    world["finish"]("book", "failed")
    world["post"]("/api/pipeline/retry", {"document_id": "book"})
    world["finish"]("book", "analyzed")
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}, meter.calls
    assert meter.calls == ["reserve_user_upload", "commit_user_upload"], meter.calls


def test_the_restore_reports_a_settling_reservation_and_leaves_it_alone(world, restore, monkeypatch, capsys):
    """The restore script never rules on a settling row: it prints it under
    SETTLING with what a human must decide, releases nothing, and the row
    keeps its evidence."""
    meter = world["meter"]
    world["db"].rows("documents").append(_doc("book", h=EEI))
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    restore_upsert = _commit_record_fails(world, monkeypatch)
    world["finish"]("book", "analyzed")
    restore_upsert()
    _restart_with_pending_lost()
    usage = _mirror_usage(world)
    for r in world["db"].rows(_quota_ledger.TABLE):
        r["heartbeat_at"] = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
    before = dict(_ledger(world, "book"))
    assert restore.main(["--apply", "--no-hash-missing"]) == 0
    out = capsys.readouterr().out
    assert "SETTLING reservation: document book" in out and "FINISHED" in out, out
    assert "would be released" not in out and "released 1" not in out, out
    assert _ledger(world, "book") == before, "the restore touched a settling row"
    assert meter.snapshot() == {"uploads": 1, "reserved": 0, "extra_billed": 0, "pending": 0}
    assert usage["uploads"] == 1 and usage["uploads_reserved"] == 0


# ── ONE CONFIRMATION, ONE RESERVATION — across a restart (P-2B, 2026-09-26) ──
#
# The confirmed extra's GRANT lived in memory; its RESERVATION lives in the
# ledger row. A confirm re-posted after a restart (the retry of a lost
# response, a second click after the deploy) found no grant and reserved
# AGAIN — `reserve_user_upload_extra` twice for one confirmation, reserved
# + 2, extra_docs_pending + 2 — and `record_reservation`'s upsert OVERWROTE
# the outstanding row, so the first slot had no record left to be swept or
# adopted: leaked for the rest of the month. The same upsert let a run
# overwrite a colleague's outstanding reservation of the same document.
#
# THE FIX: the confirm ADOPTS an outstanding `was_extra` reservation of the
# same user instead of reserving again; `record_reservation` PATCHes only
# while `reserved_at` is null and answers `Outstanding` otherwise — the
# caller gives back the slot it just reserved and refuses 409
# `reservation_outstanding`; nothing ever overwrites a reservation.
#
# WHAT THESE RED ON, with the defect repaired (TC-11):
#   * a second `reserve_user_upload_extra` for one confirmation, or a
#     confirmed extra billed twice after a restart;
#   * an outstanding reservation's row overwritten by any record;
#   * a run or a confirm against another member's outstanding reservation
#     starting, or leaving its own slot in the meter.


def _theirs(world, doc_id, *, user=OTHER_USER, extra=False, ago=30):
    """Another member's outstanding reservation of `doc_id` (a run a restart
    orphaned, or one in flight in another container)."""
    row = {"document_id": doc_id, "user_id": user, "month": "2026-09", "was_extra": extra,
           "reservation_id": "their-rid", "reserved_at": _ago(ago), "heartbeat_at": _ago(ago),
           "owner": "other-host:1:abcd", "committed_at": None, "released_at": None,
           "settling_at": None, "release_token": None}
    world["db"].rows(_quota_ledger.TABLE).append(dict(row))
    return row


def test_p2b_a_confirm_after_a_restart_adopts_the_lost_grant_instead_of_reserving_again(world):
    meter = world["meter"]
    meter.uploads = 15
    world["db"].rows("documents").append(_doc("over", h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": "over"}).status_code == 402
    assert _confirm(world, "over").status_code == 200
    assert meter.snapshot() == {"uploads": 15, "reserved": 1, "extra_billed": 0, "pending": 1}
    rid = _ledger(world, "over")["reservation_id"]
    _restart()
    # the browser re-posts the confirmation it already made
    r = _confirm(world, "over")
    assert r.status_code == 200, r.text
    assert meter.calls.count("reserve_user_upload_extra") == 1, ("one confirmation reserved twice", meter.calls)
    assert meter.snapshot() == {"uploads": 15, "reserved": 1, "extra_billed": 0, "pending": 1}, meter.calls
    row = _ledger(world, "over")
    assert row["reserved_at"] and row["was_extra"] and row["reservation_id"] != rid \
        and row["owner"] == _quota_ledger.PROCESS_ID, row
    assert world["post"]("/api/pipeline/run", {"document_id": "over"}).json()["status"] == "queued"
    world["finish"]("over", "analyzed")
    assert meter.snapshot() == {"uploads": 16, "reserved": 0, "extra_billed": 1, "pending": 0}
    assert [b["reservation_id"] for b in world["billed"]] == ["over"]


def test_p2b_record_reservation_never_overwrites_an_outstanding_reservation(world):
    _theirs(world, "doc")
    got = _quota_ledger.record_reservation("doc", user_id=OWNER, was_extra=True, month="2026-09")
    assert isinstance(got, _quota_ledger.Outstanding) and got.user_id == OTHER_USER, got
    row = _ledger(world, "doc")
    assert (row["reservation_id"], row["user_id"], row["owner"]) == ("their-rid", OTHER_USER, "other-host:1:abcd"), row
    # a settled row is recorded over: its reservation is gone
    world["db"].update(_quota_ledger.TABLE, {"reserved_at": None, "released_at": _ago(1), "owner": None},
                       filters={"document_id": "eq.doc"})
    rid = _quota_ledger.record_reservation("doc", user_id=OWNER, was_extra=True, month="2026-09")
    assert isinstance(rid, str) and (_ledger(world, "doc")["reservation_id"], _ledger(world, "doc")["user_id"]) == (rid, OWNER)
    # and a document with no row at all gets one
    rid2 = _quota_ledger.record_reservation("new", user_id=OWNER, was_extra=False, month="2026-09")
    assert isinstance(rid2, str) and _ledger(world, "new")["reservation_id"] == rid2


def test_p2b_a_confirm_against_another_members_reservation_gives_its_slot_back_and_answers_409(world, monkeypatch):
    """The colleague's row lands between the confirm's look and its record
    (a race with a run in another container): the slot the confirm reserved
    is released, the colleague's row is untouched, no grant, 409."""
    meter = world["meter"]
    meter.uploads = 15
    world["db"].rows("documents").append(_doc("shared", h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": "shared"}).status_code == 402
    real_rpc = meter.rpc

    def racing(name, payload):
        out = real_rpc(name, payload)
        if name == "reserve_user_upload_extra":
            _theirs(world, "shared", ago=1)
        return out

    monkeypatch.setattr(_usage_gate, "_rpc", racing)
    r = _confirm(world, "shared")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "reservation_outstanding", r.text
    assert meter.calls[-2:] == ["reserve_user_upload_extra", "release_user_upload"], meter.calls
    assert meter.snapshot() == {"uploads": 15, "reserved": 0, "extra_billed": 0, "pending": 0}
    row = _ledger(world, "shared")
    assert (row["reservation_id"], row["user_id"]) == ("their-rid", OTHER_USER), row
    assert not _usage_gate.has_extra_grant("shared")


def test_p2b_a_confirm_while_the_documents_own_run_holds_its_slot_reserves_nothing(world):
    """The user's /run reserved a plain slot and a restart orphaned it; the
    re-run adopts it with no dialog. A stale tab's confirm reserves nothing:
    409, and the reservation stays for the re-run."""
    meter = world["meter"]
    meter.uploads = 14
    world["db"].rows("documents").append(_doc("book", h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": "book"}).json()["status"] == "queued"
    _restart()
    rid = _ledger(world, "book")["reservation_id"]
    r = _confirm(world, "book")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "reservation_outstanding", r.text
    assert "reserve_user_upload_extra" not in meter.calls and meter.snapshot()["pending"] == 0, meter.calls
    assert _ledger(world, "book")["reservation_id"] == rid
    assert world["post"]("/api/pipeline/retry", {"document_id": "book"}).json()["status"] == "queued"
    world["finish"]("book", "analyzed")
    assert meter.snapshot() == {"uploads": 15, "reserved": 0, "extra_billed": 0, "pending": 0}, meter.calls


def test_p2b_a_run_against_another_members_outstanding_reservation_is_refused_and_leaks_nothing(world):
    """A colleague's run of the document died in a restart; its reservation
    is theirs until the sweep frees it. The caller's run must not overwrite
    it (their slot would leak for the month) nor adopt it (they would be
    charged for the caller's run)."""
    meter = world["meter"]
    world["db"].rows("documents").append(_doc("shared", h=EEI, user=OTHER_USER, status="extracting",
                                              started=_ago(120)))
    _theirs(world, "shared", ago=120)
    r = world["post"]("/api/pipeline/run", {"document_id": "shared"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "reservation_outstanding", r.text
    assert meter.calls == ["reserve_user_upload", "release_user_upload"], meter.calls
    assert meter.snapshot() == {"uploads": 0, "reserved": 0, "extra_billed": 0, "pending": 0}
    row = _ledger(world, "shared")
    assert (row["reservation_id"], row["user_id"]) == ("their-rid", OTHER_USER) and row["reserved_at"], row
    assert pipeline._QUOTA_RUNS == {} and _doc_dedupe.in_flight("shared") is None and world["enqueued"] == []
    # once the sweep gave the colleague's slot back, the run goes through
    released = _quota_ledger.sweep_stale(is_live=pipeline._reservation_is_live, now=_later(11))
    assert [x["document_id"] for x in released] == ["shared"]
    assert world["post"]("/api/pipeline/run", {"document_id": "shared"}).json()["status"] == "queued"
