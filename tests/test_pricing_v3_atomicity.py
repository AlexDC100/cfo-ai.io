"""Pricing V3 atomicity + gap-D failure-handling + per-user isolation.

These tests exercise the contract the refined-spec gates G6 / G7 / G8
require to pass before Phase 3 can start. They do NOT need a live
Supabase — the atomic RPCs themselves are tested by their Postgres
definitions (the WHERE-guarded UPDATE is atomic by Postgres MVCC, a
property of the database, not our Python).

What we DO test here:
  · G6 atomicity contract: `reserve_document` returns either ALLOWED
    once OR (EXTRA_REQUIRED|BLOCKED) once — never two ALLOWED
    responses at the cap boundary. We stub the RPC to simulate
    Postgres serializing two concurrent attempts at cap=1 and prove
    the Python wrapper surfaces the correct decisions.
  · G7 gap-D contract: commit_document is called only on success;
    release_document is called on failure. The pipeline orchestrator's
    `_commit_pipeline_quota` dispatches correctly based on the
    `success` flag.
  · G8 per-user isolation: two distinct user_ids → two distinct
    state reads → no cross-talk. Verified by stubbing the supabase
    client and observing that `reserve_document(user_a)` does not
    touch user_b's counters.
  · Below-COGS warning fires when env override drops the extra-doc
    price under €1.62 — covered in the existing
    test_features_status.py file but re-asserted here against the
    refined config shape (`billing_scope` present, etc.).
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch


def _ensure_env() -> None:
    os.environ.setdefault("VITE_SUPABASE_URL", "http://stub")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "stub")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


# ──────────────────────────────────────────────────────────────────────
# Config-level invariants — gap A + B
# ──────────────────────────────────────────────────────────────────────

def test_pricing_config_has_billing_scope_user():
    _ensure_env()
    from engine.api import _pricing_config
    _pricing_config.reload_for_test()
    pub = _pricing_config.to_public_dict()
    assert pub.get("billing_scope") == "user", (
        f"billing_scope must be 'user' per gap B; got {pub.get('billing_scope')!r}"
    )


def test_pricing_config_intro_is_one_time():
    _ensure_env()
    from engine.api import _pricing_config
    _pricing_config.reload_for_test()
    intro = _pricing_config.CONFIG.plans["intro"]
    assert intro.recurring is False
    assert _pricing_config.is_recurring_eligible_for_stripe_subscription("intro") is False, (
        "intro €0.99 must NEVER be recurring — gap from the source spec"
    )


def test_pricing_config_trial_window_is_7_days():
    """Owner decision (May 2026 redesign): free trial window is 7 days.

    Previously was 30 days during the V2 rollout; tightened to match
    the "Try CFO AI with one document" framing. Env var override
    PRICING_TRIAL_WINDOW_DAYS still applies — this test asserts the
    default in absence of overrides.
    """
    _ensure_env()
    os.environ.pop("PRICING_TRIAL_WINDOW_DAYS", None)
    from engine.api import _pricing_config
    _pricing_config.reload_for_test()
    trial = _pricing_config.CONFIG.plans["trial"]
    assert trial.window_days == 7, (
        f"trial.window_days default must be 7 (owner decision); got {trial.window_days}"
    )


def test_pricing_config_starter_pro_recurring():
    _ensure_env()
    from engine.api import _pricing_config
    _pricing_config.reload_for_test()
    assert _pricing_config.CONFIG.plans["starter"].recurring is True
    assert _pricing_config.CONFIG.plans["pro"].recurring is True
    assert _pricing_config.is_recurring_eligible_for_stripe_subscription("starter") is True
    assert _pricing_config.is_recurring_eligible_for_stripe_subscription("pro") is True


def test_below_cogs_warning_fires_when_extra_under_cogs():
    _ensure_env()
    os.environ["PRICING_STARTER_EXTRA_DOC_EUR"] = "1.00"
    try:
        from engine.api import _pricing_config
        _pricing_config.reload_for_test()
        warns = _pricing_config.below_cogs_warnings()
        assert len(warns) == 1
        assert "Starter" in warns[0]
    finally:
        del os.environ["PRICING_STARTER_EXTRA_DOC_EUR"]
        # Restore baseline.
        from engine.api import _pricing_config
        _pricing_config.reload_for_test()


# ──────────────────────────────────────────────────────────────────────
# Gap C — atomicity contract
# ──────────────────────────────────────────────────────────────────────

class _FakeSupabaseClient:
    """In-process stand-in for the admin client that just shuttles
    requests into a stub RPC handler. The Python wrapper around the
    RPC is what we're testing; the RPC itself is Postgres."""

    def __init__(self, rpc_handler):
        self.url = "http://stub"
        self._headers = {}
        self._rpc_handler = rpc_handler
        self._client = MagicMock()
        self._client.post = MagicMock(side_effect=self._post)

    def _post(self, url, json=None, headers=None):
        # url looks like ".../rest/v1/rpc/<name>"
        name = url.rsplit("/", 1)[-1]
        body = self._rpc_handler(name, json or {})
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = body
        resp.text = ""
        return resp

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def _enable_enforcement():
    os.environ["USAGE_LIMITS_ENABLED"] = "1"


def _disable_enforcement():
    os.environ.pop("USAGE_LIMITS_ENABLED", None)


def test_g6_concurrent_boundary_one_passes_atomic_contract():
    """Two concurrent reserves at cap=1 — the simulated RPC honours
    the WHERE-guarded UPDATE semantics (only one wins). The Python
    wrapper surfaces the winner as 'allowed' and the loser as
    'extra_required' (Starter plan) or 'blocked' (Trial)."""
    _ensure_env()
    _enable_enforcement()
    try:
        from engine.api import _usage_gate, _pricing_config, _plan_state

        # Simulate Postgres: a single counter that supports the
        # atomic conditional. The "first" call to reserve wins; the
        # second sees over-cap.
        state: Dict[str, int] = {"uploads": 0, "reserved": 0}

        def handler(name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
            if name == "reserve_user_upload":
                cap = payload["p_base_cap"]
                if (state["uploads"] + state["reserved"]) < cap:
                    state["reserved"] += 1
                    return {
                        "kind": "allowed",
                        "used": state["uploads"],
                        "reserved": state["reserved"],
                        "cap": cap,
                        "total": state["uploads"] + state["reserved"],
                    }
                # Over cap
                return {
                    "kind": "extra_required" if payload["p_allow_extra"] else "blocked",
                    "used": state["uploads"],
                    "reserved": state["reserved"],
                    "cap": cap,
                    "total": state["uploads"] + state["reserved"],
                }
            return {}

        # Stub _plan_state.get_plan_state to return a Starter plan
        # (cap=5, extras allowed). For this race test we use cap=1
        # by tweaking the included_docs.
        starter_plan = _pricing_config.CONFIG.plans["starter"]
        fake_plan = type(starter_plan)(
            key="starter", display_name="Starter",
            blurb="", price_eur=14.99, recurring=True, requires_card=True,
            included_docs=1,                  # ← tight cap for the race test
            extra_doc_eur=3.00,
            chat=starter_plan.chat,
            window_days=None,
        )
        fake_state = _plan_state.PlanState(
            user_id="u1", plan_key="starter", plan=fake_plan,
            window_expires_at=None,
            docs_used_this_period=0, extra_docs_billed_this_period=0,
            chat_used_today=0, chat_used_this_period=0,
            today_iso="2026-05-18", period_month_bucket="2026-05",
        )
        with patch.object(_plan_state, "get_plan_state", return_value=fake_state):
            with patch.object(_usage_gate._supabase, "admin",
                              return_value=_FakeSupabaseClient(handler)):
                # First reserve — should be 'allowed'
                d1 = _usage_gate.reserve_document("u1")
                # Second reserve — over cap (already 1 reserved, cap=1)
                d2 = _usage_gate.reserve_document("u1")

        assert d1.kind == "allowed"
        assert d2.kind == "extra_required"  # Starter allows extras
        # The "winner" count is exactly 1, not 2.
        assert state["reserved"] == 1
    finally:
        _disable_enforcement()


def test_g6_blocked_when_trial_over_quota():
    """Trial doesn't allow extras — second reserve at cap returns
    BLOCKED not EXTRA_REQUIRED."""
    _ensure_env()
    _enable_enforcement()
    try:
        from engine.api import _usage_gate, _pricing_config, _plan_state
        state = {"uploads": 0, "reserved": 0}

        def handler(name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
            if name == "reserve_user_upload":
                cap = payload["p_base_cap"]
                if (state["uploads"] + state["reserved"]) < cap:
                    state["reserved"] += 1
                    return {"kind": "allowed", "used": state["uploads"],
                            "reserved": state["reserved"], "cap": cap,
                            "total": state["uploads"] + state["reserved"]}
                return {"kind": "blocked" if not payload["p_allow_extra"] else "extra_required",
                        "used": state["uploads"], "reserved": state["reserved"],
                        "cap": cap, "total": state["uploads"] + state["reserved"]}
            return {}

        trial = _pricing_config.CONFIG.plans["trial"]
        fake_state = _plan_state.PlanState(
            user_id="u_trial", plan_key="trial", plan=trial,
            window_expires_at=None,
            docs_used_this_period=0, extra_docs_billed_this_period=0,
            chat_used_today=0, chat_used_this_period=0,
            today_iso="2026-05-18", period_month_bucket="2026-05",
        )
        with patch.object(_plan_state, "get_plan_state", return_value=fake_state):
            with patch.object(_usage_gate._supabase, "admin",
                              return_value=_FakeSupabaseClient(handler)):
                d1 = _usage_gate.reserve_document("u_trial")
                d2 = _usage_gate.reserve_document("u_trial")

        assert d1.kind == "allowed"
        assert d2.kind == "blocked"  # No extras on trial
    finally:
        _disable_enforcement()


# ──────────────────────────────────────────────────────────────────────
# Gap D — failure handling
# ──────────────────────────────────────────────────────────────────────

def test_g7_commit_called_on_success_release_on_failure():
    """Drives `_commit_pipeline_quota` and asserts which terminal
    helper fires."""
    _ensure_env()
    _enable_enforcement()
    try:
        from engine.api import pipeline as pipe

        # Stub the document lookup so _commit_pipeline_quota finds
        # uploaded_by + metered_extra.
        doc_row = {
            "id": "doc-1",
            "uploaded_by": "user-A",
            "metered_extra": True,
        }
        fake_admin = MagicMock()
        fake_admin.__enter__ = MagicMock(return_value=fake_admin)
        fake_admin.__exit__ = MagicMock(return_value=False)
        fake_admin.select = MagicMock(return_value=[doc_row])

        with patch.object(pipe._supabase, "admin", return_value=fake_admin):
            from engine.api import _usage_gate as _ug
            with patch.object(_ug, "commit_document") as commit, \
                 patch.object(_ug, "release_document") as release:
                pipe._commit_pipeline_quota("doc-1", success=True)
                commit.assert_called_once_with("user-A", was_extra=True)
                release.assert_not_called()

            with patch.object(_ug, "commit_document") as commit, \
                 patch.object(_ug, "release_document") as release:
                pipe._commit_pipeline_quota("doc-1", success=False)
                commit.assert_not_called()
                release.assert_called_once_with("user-A", was_extra=True)
    finally:
        _disable_enforcement()


def test_g7_commit_no_extra_flag_when_doc_not_metered():
    """`metered_extra=False` should NOT bump extra_docs_billed_period
    even on success — caller passes was_extra=False through to the RPC."""
    _ensure_env()
    _enable_enforcement()
    try:
        from engine.api import pipeline as pipe

        doc_row = {"id": "doc-2", "uploaded_by": "user-B", "metered_extra": False}
        fake_admin = MagicMock()
        fake_admin.__enter__ = MagicMock(return_value=fake_admin)
        fake_admin.__exit__ = MagicMock(return_value=False)
        fake_admin.select = MagicMock(return_value=[doc_row])

        with patch.object(pipe._supabase, "admin", return_value=fake_admin):
            from engine.api import _usage_gate as _ug
            with patch.object(_ug, "commit_document") as commit:
                pipe._commit_pipeline_quota("doc-2", success=True)
                commit.assert_called_once_with("user-B", was_extra=False)
    finally:
        _disable_enforcement()


# ──────────────────────────────────────────────────────────────────────
# Gap B — per-user isolation
# ──────────────────────────────────────────────────────────────────────

def test_g8_per_user_isolation_distinct_uids_distinct_state():
    """reserve_document for user-A must never touch user-B's row.
    Verified by checking the payload of the RPC call."""
    _ensure_env()
    _enable_enforcement()
    try:
        from engine.api import _usage_gate, _pricing_config, _plan_state

        calls: List[Dict[str, Any]] = []

        def handler(name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
            calls.append({"name": name, **payload})
            if name == "reserve_user_upload":
                return {"kind": "allowed", "used": 0, "reserved": 1,
                        "cap": payload["p_base_cap"], "total": 1}
            return {}

        starter = _pricing_config.CONFIG.plans["starter"]
        state_a = _plan_state.PlanState(
            user_id="user-A", plan_key="starter", plan=starter,
            window_expires_at=None,
            docs_used_this_period=0, extra_docs_billed_this_period=0,
            chat_used_today=0, chat_used_this_period=0,
            today_iso="2026-05-18", period_month_bucket="2026-05",
        )
        state_b = _plan_state.PlanState(
            user_id="user-B", plan_key="starter", plan=starter,
            window_expires_at=None,
            docs_used_this_period=0, extra_docs_billed_this_period=0,
            chat_used_today=0, chat_used_this_period=0,
            today_iso="2026-05-18", period_month_bucket="2026-05",
        )

        def fake_get_state(uid: str):
            return state_a if uid == "user-A" else state_b

        with patch.object(_plan_state, "get_plan_state", side_effect=fake_get_state):
            with patch.object(_usage_gate._supabase, "admin",
                              return_value=_FakeSupabaseClient(handler)):
                _usage_gate.reserve_document("user-A")
                _usage_gate.reserve_document("user-B")

        assert len(calls) == 2
        assert calls[0]["p_user_id"] == "user-A"
        assert calls[1]["p_user_id"] == "user-B"
        # No call ever conflates the two user ids.
        for c in calls:
            assert c["p_user_id"] in ("user-A", "user-B")
    finally:
        _disable_enforcement()


# ──────────────────────────────────────────────────────────────────────
# Kill-switch — every gate is a no-op when env flag is off
# ──────────────────────────────────────────────────────────────────────

def test_kill_switch_disabled_returns_disabled_decision():
    _ensure_env()
    _disable_enforcement()
    from engine.api import _usage_gate
    d = _usage_gate.reserve_document("any-user")
    assert d.kind == "disabled"
    c = _usage_gate.reserve_chat("any-user")
    assert c.kind == "disabled"
