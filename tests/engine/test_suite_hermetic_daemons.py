"""The suite starts no process-wide daemon that outlives the test that built
the app.

THE FLAKE (measured in the full battery, 2026-10-01 and 2026-10-02).
`server.create_app()` starts the quota ledger's maintenance daemon once per
process when the Supabase variables are set. Tests set placeholders for
them, so the first app built in the pytest process started a thread that
ticked every 60 seconds until the process ended, sending
`document_quota_ledger` requests through whatever HTTP double the test
running at that moment had installed. Victims so far, each green alone:
`test_public_egress` (a ledger GET counted inside a zero-cost window),
`test_check_served_periods` ("asked ['document_quota_ledger']" where the
production handler's first read was expected) and
`test_launch_anonymous_egress` (a `test.supabase.co` call charged to an
anonymous route). The full `pytest` gate was red at random.

`tests/engine/conftest.py` sets the engine's own switch,
`ENGINE_QUOTA_LEDGER_MAINTENANCE=0`, for the suite.

WHAT THIS REDS ON, after the repair (TC-11): the switch missing from the
suite's environment; the real `create_app()` — built here with the
placeholders that used to start the daemon — leaving a
"quota-ledger-maintenance" thread behind; the switch no longer turning the
daemon off. The positive control starts the daemon deliberately (switch on,
a fake clock-free loop it stops at once), so the law cannot pass because the
daemon simply never starts under any setting.
"""
from __future__ import annotations

import os
import threading

import pytest


def _maintenance_threads() -> list:
    return [t for t in threading.enumerate() if t.name == "quota-ledger-maintenance" and t.is_alive()]


def test_the_suite_runs_with_the_maintenance_daemon_switched_off():
    assert os.environ.get("ENGINE_QUOTA_LEDGER_MAINTENANCE") == "0", (
        "tests/engine/conftest.py must switch the quota-ledger maintenance daemon off for the suite"
    )


def test_building_the_real_app_leaves_no_maintenance_daemon_behind(monkeypatch):
    from engine.api import _quota_ledger
    from engine.api.server import create_app

    # The placeholders under which the daemon used to start.
    monkeypatch.setenv("VITE_SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("VITE_SUPABASE_ANON_KEY", "anon-placeholder")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-placeholder")
    monkeypatch.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")
    assert _maintenance_threads() == [], "a maintenance daemon is already running in this process"
    create_app()
    assert _quota_ledger._MAINTENANCE["thread"] is None
    assert _maintenance_threads() == []


def test_the_switch_is_what_keeps_it_off_positive_control(monkeypatch):
    """With the switch ON and the same placeholders, `start_maintenance`
    DOES start the thread — so the law above measures the switch, not an
    environment in which the daemon could never start. The thread is stopped
    and the module state restored before the test ends."""
    from engine.api import _quota_ledger

    monkeypatch.setenv("VITE_SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-placeholder")
    monkeypatch.setitem(_quota_ledger._MAINTENANCE, "thread", None)

    monkeypatch.setenv("ENGINE_QUOTA_LEDGER_MAINTENANCE", "0")
    assert _quota_ledger.start_maintenance(live_ids=lambda: [], is_live=lambda d: False) is False
    assert _maintenance_threads() == []

    monkeypatch.setenv("ENGINE_QUOTA_LEDGER_MAINTENANCE", "1")
    try:
        assert _quota_ledger.start_maintenance(live_ids=lambda: [], is_live=lambda d: False) is True
        assert len(_maintenance_threads()) == 1
    finally:
        stop = _quota_ledger._MAINTENANCE.get("stop")
        thread = _quota_ledger._MAINTENANCE.get("thread")
        if stop is not None:
            stop.set()
        if thread is not None:
            thread.join(timeout=5)
        _quota_ledger._MAINTENANCE.pop("stop", None)
    assert _maintenance_threads() == [], "the positive control left its thread running"


# ── a run's per-process notes do not outlive the test that made them ──────
#
# THE LEAK (whole-pytest gate, 2026-10-10, release/r-next 471273f4). The
# pipeline keeps four per-run notes in process memory, each popped when the
# run ends: `_STAGED_RERUNS` and `_NO_TAKEOVER_RUNS` in `_run_pipeline_sync`'s
# `finally` (so even a kill pops them); `_TAKEOVERS_BY_RUN` and
# `_PERIODS_MINTED_BY_RUN` by the takeover and by the `except Exception`
# failure handler — NOT by a `_Kill`, the tests' BaseException model of a
# process death. test_rerun_restart.py killed six staged re-runs inside their
# takeover; the staged takeover law three files later asserted
# `P._TAKEOVERS_BY_RUN == {}` and was red — green alone, green in gate
# `rerun-data-loss`, whose file order ran the staged laws before the kills.
# `tests/engine/conftest.py::_one_run_per_document_registries_are_per_test`
# now hands every test a fresh dict for all four.
#
# These two laws run in THIS order in one file (pytest's definition order; the
# suite loads no random-order plugin): the first leaves a note in every
# registry exactly as a killed run does and pops nothing; the second finds
# none. WHAT THEY RED ON, after the repair (TC-11): a registry dropped from
# the fixture's list (the second finds the first's note); a registry or its
# writer renamed in the pipeline (the first cannot leave its note).

_PLANTED_RUN = "hermetic-planted-run"


def test_a_killed_run_leaves_its_note_in_every_per_run_registry_PLANT():
    from engine.api import pipeline as P

    P._record_takeover(_PLANTED_RUN, staged="fp-staged", served="fp-served",
                       superseded_document=None, rerun=True)
    P._record_period_minted(_PLANTED_RUN, "fp-staged")
    P._set_staged_rerun(_PLANTED_RUN, "fp-served")
    P._set_no_takeover_run(_PLANTED_RUN)
    assert P._TAKEOVERS_BY_RUN[_PLANTED_RUN]["staged"] == "fp-staged"
    assert P._PERIODS_MINTED_BY_RUN[_PLANTED_RUN] == "fp-staged"
    assert P._staged_rerun_of(_PLANTED_RUN) == "fp-served" and P._is_no_takeover_run(_PLANTED_RUN)
    # No pop: the process "died" here (`_Kill`, test_rerun_staged.py).


def test_the_next_test_finds_no_note_of_a_run_it_did_not_start():
    from engine.api import pipeline as P

    for name in ("_TAKEOVERS_BY_RUN", "_PERIODS_MINTED_BY_RUN", "_STAGED_RERUNS", "_NO_TAKEOVER_RUNS"):
        assert getattr(P, name) == {}, (name, getattr(P, name))
