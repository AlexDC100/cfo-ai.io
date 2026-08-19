"""Unit tests for engine.serving._internal_guard — the dev-mode runtime
assertion behind ENGINE_DEV_ASSERT=1.

Contract under test:
  * OFF by default: guard_envelope() returns the SAME object (zero prod
    overhead, no wrapper).
  * ON: direct reads ([], .get, .pop, .setdefault) of a marked-internal key
    from code outside src/engine/serving/ raise InternalFieldAccessError with
    a pointer to the gateway public API (facts.py); public keys stay readable.
  * Code whose frames live under src/engine/serving/ reads freely.
"""

from __future__ import annotations

import pytest

from engine.serving._internal_guard import (
    ENV_FLAG,
    InternalFieldAccessError,
    dev_assert_enabled,
    guard_envelope,
)

INTERNAL = ["_raw_totals", "_envelope_secret"]


def _sample():
    return {"_raw_totals": {"assets": 1.0}, "status": "BALANCED", "_envelope_secret": 7}


# ── OFF by default ───────────────────────────────────────────────────

def test_off_by_default_returns_same_object(monkeypatch):
    monkeypatch.delenv(ENV_FLAG, raising=False)
    env = _sample()
    assert not dev_assert_enabled()
    out = guard_envelope(env, INTERNAL)
    assert out is env  # identical object — no wrapper, no overhead
    assert out["_raw_totals"] == {"assets": 1.0}  # and no assertion either


def test_flag_must_be_exactly_1(monkeypatch):
    monkeypatch.setenv(ENV_FLAG, "true")
    env = _sample()
    assert guard_envelope(env, INTERNAL) is env


# ── ON: outside-gateway reads raise ──────────────────────────────────

@pytest.fixture
def guarded(monkeypatch):
    monkeypatch.setenv(ENV_FLAG, "1")
    return guard_envelope(_sample(), INTERNAL)


def test_subscript_read_of_internal_key_raises(guarded):
    with pytest.raises(InternalFieldAccessError) as exc:
        guarded["_raw_totals"]
    msg = str(exc.value)
    assert "src/engine/serving/facts.py" in msg
    assert ENV_FLAG in msg


def test_get_pop_setdefault_raise(guarded):
    with pytest.raises(InternalFieldAccessError):
        guarded.get("_raw_totals")
    with pytest.raises(InternalFieldAccessError):
        guarded.get("_envelope_secret", None)
    with pytest.raises(InternalFieldAccessError):
        guarded.pop("_raw_totals", None)
    with pytest.raises(InternalFieldAccessError):
        guarded.setdefault("_raw_totals", {})


def test_public_keys_stay_readable(guarded):
    assert guarded["status"] == "BALANCED"
    assert guarded.get("status") == "BALANCED"
    assert guarded.get("missing", "d") == "d"


def test_wrap_is_idempotent(monkeypatch):
    monkeypatch.setenv(ENV_FLAG, "1")
    g1 = guard_envelope(_sample(), INTERNAL)
    g2 = guard_envelope(g1, INTERNAL)
    assert g2 is g1


def test_non_dict_passthrough(monkeypatch):
    monkeypatch.setenv(ENV_FLAG, "1")
    assert guard_envelope(None, INTERNAL) is None


# ── ON: gateway-resident code reads freely ───────────────────────────

def test_gateway_frames_are_allowed(monkeypatch):
    """Simulate a read from inside the gateway by exec-ing code whose
    compile-time filename lives under src/engine/serving/."""
    monkeypatch.setenv(ENV_FLAG, "1")
    guarded = guard_envelope(_sample(), INTERNAL)
    code = compile(
        "result = env['_raw_totals']",
        "/repo/src/engine/serving/facts.py",  # frame filename decides
        "exec",
    )
    scope = {"env": guarded}
    exec(code, scope)  # must NOT raise
    assert scope["result"] == {"assets": 1.0}
