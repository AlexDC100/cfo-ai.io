"""A meter that cannot record must refuse the work, not do it for free.

MEASURED IN PRODUCTION, 2026-09-10. `USAGE_LIMITS_ENABLED=true`, all three
`*_user_nonro_upload` RPCs absent, all three meter columns absent — because
`supabase/schema_phase_plan_caps.sql` was never applied. Twenty-seven
non-RO documents (detected_country=BE) were analysed between 2026-05-19
and 2026-09-08 and none was metered: a 113-day window.

The code knew. `reserve_nonro_document` logged a warning naming the exact
missing migration and then returned `allowed`:

    logger.warning("... reserve_user_nonro_upload unavailable (migration
        schema_phase_plan_caps.sql not applied?) — degrading OPEN,
        non-RO doc unmetered for user=%s", user_id)

Degrading open is a defensible default for a READ. On a billing path with
a live Stripe key it is the gate deciding, on its own, to do the work for
free indefinitely and tell nobody who was listening. Nobody was
overcharged; the company simply was not paid, silently.

WHAT THESE RED ON, with the behaviour repaired (TC-11):
  · the reservation returning `allowed` when the meter is unreachable
  · the refusal losing its typed code, so the FE cannot tell a
    configuration fault from a plan limit
  · the refusal message implying the USER did something wrong
  · a new degrade-open branch appearing anywhere in the usage gate
"""
from __future__ import annotations

import inspect

import pytest

from engine.api import _usage_gate as ug


@pytest.fixture
def enforcing(monkeypatch):
    """Enforcement ON — the production posture, contrary to a docstring in
    pipeline.py that still says it is off."""
    monkeypatch.setattr(ug, "enforcement_enabled", lambda: True)
    return monkeypatch


def _entitled(monkeypatch, plan_key="multi"):
    """A plan that DOES include non-RO documents, so any refusal below can
    only come from the meter being unreachable — never from entitlement.

    Patched at `_usage_gate._plan_state.get_plan_state`, the seam the
    reservation actually reads (`state = _plan_state.get_plan_state(...)`,
    `plan = state.plan`). Patching a name that does not exist would make
    every assertion here pass against the real Supabase-reading path and
    fail for the wrong reason.
    """
    class _Plan(object):
        key = plan_key
        allows_non_ro = True
        included_nonro_docs = 10
        extra_nonro_doc_eur = 5.0

    class _State(object):
        nonro_used_this_period = 0
        plan = _Plan()

    monkeypatch.setattr(ug._plan_state, "get_plan_state", lambda *_a, **_k: _State())
    return _Plan, _State


def test_an_unreachable_meter_refuses_rather_than_allowing(enforcing, monkeypatch):
    """THE GATE. The RPC is unavailable; the document must not proceed."""
    _entitled(monkeypatch)
    monkeypatch.setattr(ug, "_rpc", lambda *_a, **_k: None)
    try:
        decision = ug.reserve_nonro_document("user-1")
    except Exception as e:  # a raise is also "not allowed", and acceptable
        assert "metering" in str(e).lower() or "unavailable" in str(e).lower()
        return
    assert decision.kind != "allowed", (
        "the meter could not record and the document was allowed through "
        "anyway — this is the 113-day unmetered window, reopened"
    )
    assert decision.kind == "refused"
    assert decision.refusal == "metering_unavailable", (
        "the refusal must carry a TYPED code so the frontend can tell a "
        "configuration fault from a plan limit; got %r" % (decision.refusal,)
    )


def test_the_refusal_does_not_blame_the_user(enforcing, monkeypatch):
    """A configuration fault on our side must not read as a limit on their
    plan, and must say nothing was charged."""
    _entitled(monkeypatch)
    monkeypatch.setattr(ug, "_rpc", lambda *_a, **_k: None)
    msg = ug.reserve_nonro_document("user-1").message.lower()
    assert "not been charged" in msg or "nothing has been charged" in msg, msg
    for blame in ("you have reached", "your plan does not", "upgrade"):
        assert blame not in msg, (
            "the message blames the user for our missing migration: %r" % msg)


def test_the_meter_still_works_when_the_rpc_answers(enforcing, monkeypatch):
    """POSITIVE CONTROL. Without this, 'refuse everything' would pass every
    assertion above — and a gate that refuses all work is an outage, not a
    meter."""
    _entitled(monkeypatch)
    monkeypatch.setattr(
        ug, "_rpc",
        lambda *_a, **_k: {"kind": "allowed", "used": 1, "cap": 10,
                           "was_extra": False})
    decision = ug.reserve_nonro_document("user-1")
    assert decision.kind == "allowed", (
        "a working meter refused the document — the fail-closed branch is "
        "swallowing the healthy path too"
    )


def test_no_degrade_open_branch_survives_in_the_usage_gate():
    """Structural. The phrase names the decision; if it comes back, so has
    the behaviour."""
    src = inspect.getsource(ug)
    lowered = src.lower()
    assert "degrading open" not in lowered, (
        "a 'degrading OPEN' branch is back in the usage gate — on a billing "
        "path that means doing the work for free and telling nobody"
    )


def test_the_unavailable_path_logs_at_error_not_warning(enforcing, monkeypatch, caplog):
    """A warning is what nobody read for 113 days."""
    import logging

    _entitled(monkeypatch)
    monkeypatch.setattr(ug, "_rpc", lambda *_a, **_k: None)
    with caplog.at_level(logging.ERROR):
        ug.reserve_nonro_document("user-1")
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert errors, "the unreachable meter did not log at ERROR"
    joined = " ".join(r.getMessage() for r in errors)
    assert "schema_phase_plan_caps.sql" in joined, (
        "the log must name the migration to apply; got %r" % joined)
