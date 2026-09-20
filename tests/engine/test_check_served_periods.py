"""GATE for the gate — scripts/check_served_periods.py.

Fails on: a failing period not turning the run red; an empty scope passing
(vacuous green); the read-only proxy letting a write through; the script no
longer driving the REAL `get_period` handler; `get_period` opening its own
service-role client (which would bypass the read-only proxy).
"""
from __future__ import annotations

import importlib.util
import inspect
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("check_served_periods", ROOT / "scripts" / "check_served_periods.py")
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

P1 = {"id": "p-1", "org_id": "o-1", "period_label": "Dec 2025"}
P2 = {"id": "p-2", "org_id": "o-2", "period_label": "Dec 2024"}
ok = lambda pid: (200, {"period": {"id": pid}})  # noqa: E731


def test_every_period_served_is_green():
    report = gate.check_periods([P1, P2], ok)
    assert (report["checked"], report["orgs"], report["failed"]) == (2, 2, 0)
    assert gate.exit_code(report) == 0


@pytest.mark.parametrize("bad", [
    lambda pid: (500, {"detail": "KeyError: 'org_id'"}),
    lambda pid: (404, {"detail": "Period not found."}),
    lambda pid: (200, {"period": {"id": "someone-else"}}),
    lambda pid: (200, ["not", "an", "object"]),
    lambda pid: (_ for _ in ()).throw(RuntimeError("assembly exploded")),
])
def test_one_failing_period_reds_the_run_and_is_named(bad):
    fetch = lambda pid: bad(pid) if pid == "p-2" else ok(pid)  # noqa: E731
    report = gate.check_periods([P1, P2], fetch)
    assert report["failed"] == 1 and report["failures"][0]["period_id"] == "p-2"
    assert report["failures"][0]["org_id"] == "o-2" and report["failures"][0]["problem"]
    assert gate.exit_code(report) == 1


def test_an_empty_scope_is_red_not_green():
    assert gate.exit_code(gate.check_periods([], ok)) == 2


def test_the_proxy_reads_and_refuses_every_write():
    class Inner:
        def select(self, *a, **k): return [{"id": 1}]
        def insert(self, *a, **k): raise AssertionError("write reached the database")
        update = delete = upsert = rpc = insert
    ro = gate.ReadOnlyClient(Inner())
    with ro as client:
        assert client.select("t") == [{"id": 1}]
        for verb in ("insert", "update", "delete", "upsert", "rpc"):
            with pytest.raises(PermissionError, match="READ-ONLY"):
                getattr(client, verb)
    with pytest.raises(PermissionError):
        ro.anything = 1


def test_it_drives_the_real_handler(monkeypatch):
    from engine.api import _supabase, pipeline

    asked = []

    class Empty:
        def __enter__(self): return self
        def __exit__(self, *exc): return None
        def select(self, table, **kw):
            asked.append(table)
            return []

    monkeypatch.setattr(_supabase, "admin", lambda: Empty())
    monkeypatch.setattr(_supabase, "per_user", _supabase.per_user)
    monkeypatch.setattr(pipeline, "_require_jwt", pipeline._require_jwt)
    status, body = gate._served_fetch()("00000000-0000-0000-0000-000000000000")
    assert status == 404 and "not found" in str(body).lower()
    assert asked[:1] == ["financial_periods"], "the gate is not calling the production get_period"


def test_get_period_opens_no_client_of_its_own():
    from engine.api import pipeline
    src = inspect.getsource(pipeline.build_router)
    start = src.index('@router.get("/api/period/{period_id}")')
    end = src.index("@router.", start + 10)
    body = src[start:end]
    assert "_supabase.per_user(jwt)" in body
    assert not re.search(r"_supabase\.admin\(\)", body), \
        "get_period opened a service-role client — the gate's read-only proxy no longer covers it"


def test_the_credit_snapshot_reads_what_is_served_and_invents_nothing():
    body = {"assembled_metrics": {"credit": {"letter_grade": "A", "composite_score": 71.9, "altman_z_score": 3.11}}}
    assert gate.credit_snapshot(body) == {"letter_grade": "A", "composite_score": 71.9,
                                          "altman_z_score": 3.11, "model_revision": None}
    for absent in (None, [], {}, {"assembled_metrics": None}, {"assembled_metrics": {"credit": "refused"}}):
        assert set(gate.credit_snapshot(absent).values()) == {None}, "an absent verdict is None, never a default"


def test_observe_sees_every_period_including_the_failing_one():
    seen = []
    fetch = lambda pid: (500, {"detail": "boom"}) if pid == "p-2" else ok(pid)  # noqa: E731
    gate.check_periods([P1, P2], fetch, observe=lambda row, status, body: seen.append((row["id"], status)))
    assert seen == [("p-1", 200), ("p-2", 500)]


def test_the_listing_asks_only_for_columns_get_period_itself_reads():
    """Found on the first production run: `period_label` is computed by an API, it is not a column —
    PostgREST answered 400 and the gate (correctly) went red as COULD NOT RUN. The listing may name only
    columns the served handler itself dereferences on the row."""
    asked = {}

    class Admin:
        def __enter__(self): return self
        def __exit__(self, *exc): return None
        def select(self, table, **kw):
            asked.update(kw, table=table)
            return []

    gate._list_periods(lambda: Admin(), None, None)
    assert asked["table"] == "financial_periods"
    assert set(asked["columns"].split(",")) == {"id", "org_id", "period_end"}
    assert "created_at" not in asked["order"] and "period_label" not in asked["columns"]


def test_an_image_that_cannot_boot_is_red_before_any_period_is_read(monkeypatch, capsys):
    """Production 2026-09-20: GREEN was printed inside an image that crash-looped on boot_verify."""
    from engine import boot_verify
    from engine.api import _supabase

    def refuse():
        raise RuntimeError("[boot_verify] the credit pack at /app/packs/credit/model.yaml is unusable")

    monkeypatch.setattr(boot_verify, "verify_config", refuse)
    monkeypatch.setattr(_supabase, "admin", lambda: pytest.fail("a period was read from an image that cannot boot"))
    assert gate.main([]) == 2
    assert "cannot boot" in capsys.readouterr().out
