"""GATE — the operator exemption from usage metering fails closed.

Owner ruling 2026-09-20: the owner's account uploads without caps, dialogs or
billing. The exemption is an env allowlist of user UUIDs; this gate proves it
opens the meter for a listed user ONLY.

Fails on: a wildcard / truthy / malformed entry exempting anyone; an unlisted
user passing; a listed user being reserved, confirmed, committed or released
against (a half-applied exemption would reserve on one side and skip the
other); the legacy rail 429-ing a user the V3 rail lets through.
"""
from __future__ import annotations

import pytest

from engine.api import _unmetered, _usage_gate, _usage_limits

OWNER = "0b6f1c1e-3c52-4f0a-9a57-7d0f4f1c2a11"
OTHER = "9d2a7e44-51b0-4c1f-8f3e-2b6f0e9a7c33"


@pytest.fixture(autouse=True)
def _enforcement_on(monkeypatch):
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "true")
    monkeypatch.setattr(_usage_gate._plan_state, "enforcement_enabled", lambda: True)
    monkeypatch.delenv(_unmetered.ENV_VAR, raising=False)


@pytest.mark.parametrize("raw", ["", "   ", "*", "true", "1", "all", "not-a-uuid", ",,,", OWNER[:-1]])
def test_nothing_but_a_full_uuid_exempts_anyone(monkeypatch, raw):
    monkeypatch.setenv(_unmetered.ENV_VAR, raw)
    assert _unmetered.unmetered_user_ids() == frozenset()
    assert not _unmetered.is_unmetered(OWNER)
    assert not _unmetered.is_unmetered("*")
    assert _usage_gate.enforced_for(OWNER) is True


def test_listed_user_is_exempt_and_nobody_else(monkeypatch):
    monkeypatch.setenv(_unmetered.ENV_VAR, f" {OWNER.upper()} , junk")
    assert _unmetered.is_unmetered(OWNER)
    assert not _unmetered.is_unmetered(OTHER)
    assert not _unmetered.is_unmetered(None)
    assert _usage_gate.enforced_for(OWNER) is False
    assert _usage_gate.enforced_for(OTHER) is True
    assert _usage_gate.enforcement_enabled() is True  # the global switch is untouched


def test_listed_user_touches_no_meter_on_any_side(monkeypatch):
    monkeypatch.setenv(_unmetered.ENV_VAR, OWNER)
    calls = []
    monkeypatch.setattr(_usage_gate, "_rpc", lambda name, payload: calls.append(name) or {})
    monkeypatch.setattr(_usage_gate._plan_state, "get_plan_state",
                        lambda uid: pytest.fail("plan state read for an unmetered user"))
    assert _usage_gate.reserve_document(OWNER).kind == "disabled"
    assert _usage_gate.confirm_extra_document(OWNER).kind == "disabled"
    assert _usage_gate.reserve_nonro_document(OWNER).kind == "disabled"
    _usage_gate.commit_document(OWNER, was_extra=True)
    _usage_gate.release_document(OWNER, was_extra=True)
    _usage_gate.commit_nonro_document(OWNER, was_extra=True)
    _usage_gate.release_nonro_document(OWNER, was_extra=True)
    assert _usage_gate.reserve_chat(OWNER).kind == "disabled"
    _usage_gate.commit_chat(OWNER)
    _usage_gate.release_chat(OWNER)
    assert calls == [], f"an unmetered user reached the meter: {calls}"


def test_legacy_rail_honours_the_same_list(monkeypatch):
    monkeypatch.setenv(_unmetered.ENV_VAR, OWNER)
    monkeypatch.setattr(_usage_limits, "_fetch_active_tier_and_usage",
                        lambda *a, **k: pytest.fail("legacy rail metered an unmetered user"))
    assert _usage_limits.check_quota(OWNER, "upload") == {"enforced": False, "reason": "unmetered_user"}


def test_unlisted_user_still_reaches_the_meter(monkeypatch):
    monkeypatch.setenv(_unmetered.ENV_VAR, OWNER)
    reached = []
    monkeypatch.setattr(_usage_gate._plan_state, "get_plan_state",
                        lambda uid: reached.append(uid) or (_ for _ in ()).throw(RuntimeError("metered")))
    with pytest.raises(RuntimeError, match="metered"):
        _usage_gate.reserve_document(OTHER)
    assert reached == [OTHER]
