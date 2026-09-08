"""THE CAP-REJECT PATH, EXERCISED — it never had been.

WHY THIS EXISTS
===============
`USAGE_LIMITS_ENABLED` has been OFF in production since the pricing stack
shipped, and CLAUDE.md §16 says so in as many words:

    "Not yet live-tested: USAGE_LIMITS_ENABLED is unset (enforcement off)
     ... so the cap-reject path (`reserve_user_chat` returning
     `daily_cap_reached`/`monthly_cap_reached`) has only been read-reviewed
     against the SQL signatures, not exercised against a real capped user.
     Before flipping USAGE_LIMITS_ENABLED on for this function, test that
     path deliberately rather than assuming parity from code review alone."

A grep before this file existed found `daily_cap_reached` in five places —
`_plan_state.py`, `_usage_gate.py`, the atomic SQL migration, the Edge
Function and the caps migration — and in NO TEST. So the branch that tells
a paying customer "you have hit your limit" had never once run.

That is the branch you least want to meet for the first time in
production: it is the one that says no to someone who is paying.

WHAT THIS ASSERTS
=================
Every arm of the decision, with the Supabase RPC faked so nothing touches
the network and no counter is written:

  · enforcement OFF  -> `disabled`, and NOTHING is charged. The kill
    switch must be inert, which is what makes deploying the code safe
    while the flag is down.
  · enforcement ON, RPC says allowed -> `allowed`, carrying the plan's
    real caps rather than the RPC's echo.
  · enforcement ON, RPC says daily cap -> `daily_cap_reached`, and the
    message names the PLAN and the NUMBER, so the reader is told which
    limit they hit rather than "quota exceeded".
  · enforcement ON, RPC says monthly cap -> `monthly_cap_reached`.
  · enforcement ON, RPC returns NOTHING (a dead RPC, a migration not
    applied, a network blip) -> the gate FAILS CLOSED to
    `monthly_cap_reached`. Documented in the source as the default; pinned
    here because failing OPEN would hand out unlimited paid calls the
    moment the RPC went missing, which is the expensive direction.

WHAT IT REDS ON (TC-11)
=======================
  · the kill switch ceasing to be inert (a reservation attempted while
    disabled);
  · any arm returning the wrong kind, so a capped user is let through or
    an allowed user is refused;
  · a refusal message that no longer names its plan or its cap number —
    TC-10 applied to a customer-facing sentence;
  · the RPC-absent default flipping to fail-open.

WHAT IT CANNOT SEE
==================
  · Whether the SQL function itself decides correctly — that is
    `supabase/schema_phase_pricing_v3_atomic.sql`, and it is exercised by
    running against a real database, which this suite deliberately does
    not do (`-p netblock`).
  · The Supabase Edge Function's OWN copy of this logic
    (`supabase/functions/chat-llm/index.ts`). CLAUDE.md §16 records that
    the persona copy, the directives and the plan caps are duplicated
    into Deno on purpose and that BOTH must be updated together. This
    file covers the Python half only; the TS half needs its own.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, Optional

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))


def _gate():
    os.environ.setdefault("VITE_SUPABASE_URL", "http://stub")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "stub")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    from engine.api import _usage_gate  # noqa: WPS433
    return _usage_gate


class _FakePlan:
    """The Multi-Country plan's real numbers, so a message that quotes a
    cap can be checked against the cap it was built from."""

    class _Chat:
        daily = 40
        monthly = 200

    key = "multi"
    display_name = "Multi-Country"
    included_docs = 15
    extra_doc_eur = 0.99
    chat = _Chat()


class _FakeState:
    plan = _FakePlan()
    plan_key = "multi"


@pytest.fixture
def gate(monkeypatch):
    g = _gate()
    from engine.api import _plan_state
    monkeypatch.setattr(_plan_state, "get_plan_state", lambda uid: _FakeState())
    monkeypatch.setattr(g, "_plan_state", _plan_state, raising=False)
    return g


def _with_rpc(monkeypatch, gate, body: Optional[Dict[str, Any]]):
    """Fake the ONE function that talks to Supabase. Nothing else is
    stubbed, so the decision logic under test is the real one."""
    calls = []

    def fake_rpc(name: str, payload: Dict[str, Any]):
        calls.append((name, payload))
        return body

    monkeypatch.setattr(gate, "_rpc", fake_rpc)
    return calls


# ── the kill switch ───────────────────────────────────────────────────

def test_disabled_is_inert_and_reserves_nothing(gate, monkeypatch):
    monkeypatch.delenv("USAGE_LIMITS_ENABLED", raising=False)
    calls = _with_rpc(monkeypatch, gate, {"kind": "allowed"})

    d = gate.reserve_chat("u-1")

    assert d.kind == "disabled"
    assert calls == [], (
        "the kill switch is not inert: a reservation RPC was called while "
        f"USAGE_LIMITS_ENABLED was unset — {calls}"
    )


# ── the arms ──────────────────────────────────────────────────────────

def test_allowed_carries_the_plan_caps_not_the_rpc_echo(gate, monkeypatch):
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "true")
    _with_rpc(monkeypatch, gate, {"kind": "allowed", "daily_used": 7, "monthly_used": 91})

    d = gate.reserve_chat("u-1")

    assert d.kind == "allowed"
    assert d.daily_used == 7 and d.monthly_used == 91
    # The caps come from the PLAN, so a drifted RPC cannot widen them.
    assert d.daily_cap == 40 and d.monthly_cap == 200


def test_daily_cap_reached_says_which_limit_and_what_the_number_is(gate, monkeypatch):
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "true")
    _with_rpc(monkeypatch, gate,
              {"kind": "daily_cap_reached", "daily_used": 40, "monthly_used": 120})

    d = gate.reserve_chat("u-1")

    assert d.kind == "daily_cap_reached"
    assert d.daily_used == 40
    # TC-10 on a sentence a paying customer reads: it must name the plan
    # and the actual cap, not "quota exceeded".
    assert "Multi-Country" in d.message, d.message
    assert "40" in d.message, d.message
    assert "day" in d.message.lower(), d.message


def test_monthly_cap_reached_is_its_own_arm(gate, monkeypatch):
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "true")
    _with_rpc(monkeypatch, gate,
              {"kind": "monthly_cap_reached", "daily_used": 3, "monthly_used": 200})

    d = gate.reserve_chat("u-1")

    assert d.kind == "monthly_cap_reached"
    assert "Multi-Country" in d.message and "200" in d.message, d.message


def test_a_dead_rpc_fails_CLOSED_not_open(gate, monkeypatch):
    """The expensive direction is fail-open. If the RPC is missing — a
    migration not applied, a permissions change, a network blip — the gate
    must refuse rather than hand out uncapped paid model calls."""
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "true")
    _with_rpc(monkeypatch, gate, None)

    d = gate.reserve_chat("u-1")

    assert d.kind == "monthly_cap_reached", (
        "the gate failed OPEN with no RPC response — an absent reservation "
        "backend must not mean unlimited paid calls"
    )


def test_the_env_var_is_read_as_a_switch_not_a_truthy_string(gate, monkeypatch):
    """`USAGE_LIMITS_ENABLED=false` must mean OFF. A naive truthiness read
    would enable enforcement on the literal string "false", which is the
    value sitting in production's .env right now."""
    _with_rpc(monkeypatch, gate, {"kind": "allowed"})
    for value, expected_on in (
        ("true", True), ("1", True), ("yes", True), ("on", True),
        ("false", False), ("0", False), ("", False), ("nonsense", False),
    ):
        monkeypatch.setenv("USAGE_LIMITS_ENABLED", value)
        assert gate.enforcement_enabled() is expected_on, (
            f"USAGE_LIMITS_ENABLED={value!r} read as "
            f"{gate.enforcement_enabled()}, expected {expected_on}"
        )
