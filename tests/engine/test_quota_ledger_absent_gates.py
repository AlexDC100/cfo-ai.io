"""THE ENGINE WITHOUT ITS LEDGER TABLE — quiet and bounded (P2-A NO-TABLE
AMPLIFICATION, 2026-09-26).

PRODUCTION TODAY: USAGE_LIMITS_ENABLED=true and `document_quota_ledger`
(supabase/schema_phase_document_quota_ledger.sql) does NOT exist yet. Every
ledger call answers 404 PGRST205. Before this fix:

  * every settlement parked its failed record in `_PENDING` FOREVER, and
    every 60 s maintenance tick re-issued one failing PostgREST call per
    settled document — plus the heartbeat and the sweep — logging a
    traceback for each; the tick's cost grew with every analysis;
  * every entry's `_needs_metering` read logged an ERROR with a traceback;
  * `record_commit` / `record_release` called `logger.exception` OUTSIDE an
    except block.

THE FIX: a PGRST205 / 404 from the table sets a module-level ABSENT window
(`absent()`, re-probed every ABSENT_REPROBE_S with ONE INFO line per
window); ledger reads answer None and writes are skipped meanwhile; the
maintenance tick makes no call; a parked write whose failure is a 404 is
dropped (nowhere to write it — the migration's backfill records the
analysed documents); `_PENDING` is bounded (PENDING_MAX), retried with
backoff (PENDING_BACKOFF_S) and dropped after PENDING_MAX_AGE_S, each drop
one ERROR line for scripts/recompute_document_quota.py.

WHAT THESE RED ON, with the defect repaired (TC-11):
  * more than one ledger call per probe window across 20 settlements, or
    any call from the maintenance tick while the window is open;
  * more than one log line per probe window about the absent table, or any
    WARNING+ line (a traceback) from the ledger for it;
  * a 404-failed write parked; a parking lot that grows past PENDING_MAX;
    a transient failure retried without backoff or kept past its max age;
  * (positive controls) the meter still moving without the table, and a
    transient 5xx still parked and landing on retry.
"""
from __future__ import annotations

import logging

import httpx
import pytest

from engine.api import _quota_ledger, _usage_gate, pipeline

from test_duplicate_upload_gate import (  # noqa: F401 — the fixture
    EEI, OWNER, _doc, _row, world,
)


def _pgrst205(method: str = "GET") -> httpx.HTTPStatusError:
    """What `SupabaseClient.select/update/upsert` raise (`raise_for_status`)
    when PostgREST does not know the table."""
    req = httpx.Request(method, "https://fake.supabase/rest/v1/%s" % _quota_ledger.TABLE)
    resp = httpx.Response(404, request=req, json={
        "code": "PGRST205", "details": None, "hint": None,
        "message": "Could not find the table 'public.%s' in the schema cache" % _quota_ledger.TABLE})
    return httpx.HTTPStatusError("Client error '404 Not Found'", request=req, response=resp)


def _no_table(world, monkeypatch):
    """Production today: every call at the ledger table is a 404. Returns
    the list of ledger calls made (method names) and a `restore()` that
    puts the table back (the owner applied the migration)."""
    db = world["db"]
    calls = []
    reals = {}
    for name in ("select", "update", "upsert", "insert", "delete"):
        real = reals[name] = getattr(db, name)

        def wrapped(table, *a, _real=real, _name=name, **kw):
            if table == _quota_ledger.TABLE:
                calls.append(_name)
                if _name == "insert":  # `SupabaseClient.insert` wraps the status in a RuntimeError
                    raise RuntimeError("Supabase insert into %s failed (HTTP 404): {'code': 'PGRST205'}"
                                       % _quota_ledger.TABLE)
                raise _pgrst205()
            return _real(table, *a, **kw)

        monkeypatch.setattr(db, name, wrapped)

    def restore():
        for name, real in reals.items():
            monkeypatch.setattr(db, name, real)

    return calls, restore


def _uncapped(world, monkeypatch, cap=100):
    """Twenty settlements, none at the plan's 15-document cap: the cap the
    meter is asked to enforce travels in the RPC payload."""
    real_rpc = world["meter"].rpc
    monkeypatch.setattr(_usage_gate, "_rpc", lambda name, payload: real_rpc(
        name, {**payload, "p_base_cap": cap} if name == "reserve_user_upload" else payload))


def _ledger_noise(caplog):
    """Every WARNING+ record the ledger or the pipeline's quota seam logged."""
    return [r for r in caplog.records
            if r.levelno >= logging.WARNING
            and ("[quota-ledger]" in r.getMessage() or "[pipeline][quota]" in r.getMessage())]


def _absent_lines(caplog):
    return [r for r in caplog.records
            if r.name == "engine.api._quota_ledger" and r.levelno == logging.INFO
            and "schema_phase_document_quota_ledger.sql" in r.getMessage()]


def test_p2a_twenty_settlements_without_the_table_make_one_call_and_one_line(world, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    _uncapped(world, monkeypatch)
    calls, _restore = _no_table(world, monkeypatch)
    for i in range(20):
        doc = "d%02d" % i
        world["db"].rows("documents").append(_doc(doc, h="%064x" % (i + 1)))
        assert world["post"]("/api/pipeline/run", {"document_id": doc}).json()["status"] == "queued"
        world["finish"](doc, "analyzed")
    # the meter still moved: nothing broke
    assert world["meter"].snapshot() == {"uploads": 20, "reserved": 0, "extra_billed": 0, "pending": 0}
    assert calls == ["select"], ("every entry and settlement re-hit the absent table", len(calls), calls[:6])
    assert _quota_ledger._PENDING == {}, ("failed records were parked forever", list(_quota_ledger._PENDING))
    assert _ledger_noise(caplog) == [], [r.getMessage()[:120] for r in _ledger_noise(caplog)]
    assert len(_absent_lines(caplog)) == 1, [r.getMessage()[:120] for r in _absent_lines(caplog)]
    # a maintenance tick meanwhile makes no call at all
    assert _quota_ledger.maintenance_tick(live_ids=pipeline._live_reservation_ids,
                                          is_live=pipeline._reservation_is_live,
                                          settle=pipeline._settle_orphaned_reservation) is False
    assert calls == ["select"]
    # the next window re-probes ONCE and says so ONCE
    later = _quota_ledger._now_mono() + _quota_ledger.ABSENT_REPROBE_S + 1
    monkeypatch.setattr(_quota_ledger, "_now_mono", lambda: later)
    assert _quota_ledger.maintenance_tick(live_ids=pipeline._live_reservation_ids,
                                          is_live=pipeline._reservation_is_live,
                                          settle=pipeline._settle_orphaned_reservation) is True
    assert len(calls) == 2, calls
    assert len(_absent_lines(caplog)) == 2
    assert _ledger_noise(caplog) == []


def test_p2a_a_record_that_fails_with_a_404_is_dropped_not_parked(world, monkeypatch, caplog):
    """The table vanishes AFTER the reservation was recorded (a restore of
    the database, a schema cache that forgot it): the settlement's record
    404s. Nowhere to write it — dropped, one line, never retried."""
    caplog.set_level(logging.DEBUG)
    world["db"].rows("documents").append(_doc("book", h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": "book"}).json()["status"] == "queued"
    calls, _restore = _no_table(world, monkeypatch)
    world["finish"]("book", "analyzed")
    assert world["meter"].snapshot()["uploads"] == 1
    assert _quota_ledger._PENDING == {}
    assert _ledger_noise(caplog) == [], [r.getMessage()[:120] for r in _ledger_noise(caplog)]
    n = len(calls)
    for _ in range(5):
        _quota_ledger.retry_pending()
    assert len(calls) == n, "a 404-failed record was retried"


def test_p2a_a_transient_failure_is_retried_with_backoff_and_dropped_after_its_max_age(world, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    meter = world["meter"]
    world["db"].rows("documents").append(_doc("book", h=EEI))
    world["post"]("/api/pipeline/run", {"document_id": "book"})
    attempts = []
    real_upsert = world["db"].upsert

    def failing(table, rows, **kw):
        if table == _quota_ledger.TABLE and rows.get("committed_at"):
            attempts.append(1)
            raise RuntimeError("PostgREST 503")
        return real_upsert(table, rows, **kw)

    monkeypatch.setattr(world["db"], "upsert", failing)
    world["finish"]("book", "analyzed")
    assert meter.snapshot()["uploads"] == 1 and len(attempts) == 1
    assert list(_quota_ledger._PENDING) == ["book"]
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR and "[quota-ledger]" in r.getMessage()]
    assert len(errors) == 1 and not errors[0].exc_info, "a parked write was logged with a traceback from outside an except block"

    clock = {"t": _quota_ledger._now_mono()}
    monkeypatch.setattr(_quota_ledger, "_now_mono", lambda: clock["t"])
    # the first retry is due at the next tick (the gate that retries at once stays green)
    _quota_ledger.retry_pending()
    assert len(attempts) == 2
    # then backoff: the next tick (60 s) skips it, the one after retries
    clock["t"] += 30
    _quota_ledger.retry_pending()
    assert len(attempts) == 2, "a failed retry was retried again before its backoff"
    clock["t"] += _quota_ledger.PENDING_BACKOFF_S[1]
    _quota_ledger.retry_pending()
    assert len(attempts) == 3
    # and after its max age the record is dropped, one ERROR line, never retried
    clock["t"] += _quota_ledger.PENDING_MAX_AGE_S + 1
    _quota_ledger.retry_pending()
    assert _quota_ledger._PENDING == {}
    dropped = [r for r in caplog.records if r.levelno >= logging.ERROR and "DROPPED" in r.getMessage()]
    assert len(dropped) == 1, [r.getMessage()[:120] for r in dropped]
    clock["t"] += 10_000
    _quota_ledger.retry_pending()
    assert len(attempts) == 3


def test_p2a_the_parking_lot_is_bounded(world, monkeypatch, caplog):
    caplog.set_level(logging.ERROR)
    real_update = world["db"].update

    def failing(table, patch, *, filters):
        if table == _quota_ledger.TABLE:
            raise RuntimeError("PostgREST 503")
        return real_update(table, patch, filters=filters)

    monkeypatch.setattr(world["db"], "update", failing)
    clock = {"t": _quota_ledger._now_mono()}
    monkeypatch.setattr(_quota_ledger, "_now_mono", lambda: clock["t"])
    for i in range(_quota_ledger.PENDING_MAX + 5):
        clock["t"] += 1
        _quota_ledger.record_release("doc-%d" % i)
    assert len(_quota_ledger._PENDING) == _quota_ledger.PENDING_MAX
    assert "doc-0" not in _quota_ledger._PENDING and "doc-%d" % (_quota_ledger.PENDING_MAX + 4) in _quota_ledger._PENDING
    dropped = [r for r in caplog.records if "DROPPED" in r.getMessage()]
    assert len(dropped) == 5


# ── Positive controls ─────────────────────────────────────────────────


def test_p2a_a_transient_failure_still_parks_and_lands_on_retry(world, monkeypatch):
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
    assert list(_quota_ledger._PENDING) == ["book"]
    assert _quota_ledger.maintenance_tick(live_ids=pipeline._live_reservation_ids,
                                          is_live=pipeline._reservation_is_live,
                                          settle=pipeline._settle_orphaned_reservation) is True
    assert _quota_ledger._PENDING == {}
    row = next(r for r in world["db"].rows(_quota_ledger.TABLE) if r["document_id"] == "book")
    assert row["committed_at"] and row["reserved_at"] is None


def test_p2a_the_window_closes_when_the_table_appears(world, monkeypatch, caplog):
    """The owner applies the migration: the next probe succeeds, the window
    closes, and the ledger is read and written again."""
    caplog.set_level(logging.DEBUG)
    db = world["db"]
    calls, restore = _no_table(world, monkeypatch)
    db.rows("documents").append(_doc("a", h=EEI))
    assert world["post"]("/api/pipeline/run", {"document_id": "a"}).json()["status"] == "queued"
    world["finish"]("a", "analyzed")
    assert _quota_ledger.absent() and calls == ["select"]
    restore()  # the table is back
    later = _quota_ledger._now_mono() + _quota_ledger.ABSENT_REPROBE_S + 1
    monkeypatch.setattr(_quota_ledger, "_now_mono", lambda: later)
    assert _quota_ledger.absent() is False
    db.rows("documents").append(_doc("b", h="%064x" % 7, created="2026-09-21T15:00:00+00:00"))
    assert world["post"]("/api/pipeline/run", {"document_id": "b"}).json()["status"] == "queued"
    world["finish"]("b", "analyzed")
    rows = {r["document_id"]: r for r in db.rows(_quota_ledger.TABLE)}
    assert rows["b"]["committed_at"] and not _quota_ledger.absent()
