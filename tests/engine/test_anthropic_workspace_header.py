"""The identity-linked-key shim: env-gated, once, caller-respecting."""
import importlib
import os
import sys

import pytest

anthropic = pytest.importorskip("anthropic")


def _reload_engine_with(monkeypatch, workspace):
    if workspace is None:
        monkeypatch.delenv("ANTHROPIC_WORKSPACE_ID", raising=False)
    else:
        monkeypatch.setenv("ANTHROPIC_WORKSPACE_ID", workspace)
    # Undo any prior wrap so each case observes a fresh install.
    if getattr(anthropic.Anthropic, "_cfo_workspace_wrapped", False):
        importlib.reload(anthropic)
    import engine

    engine._install_anthropic_workspace_header()


def test_unset_env_changes_nothing(monkeypatch):
    _reload_engine_with(monkeypatch, None)
    assert not getattr(anthropic.Anthropic, "_cfo_workspace_wrapped", False)


def test_header_injected_on_every_client(monkeypatch):
    _reload_engine_with(monkeypatch, "wrkspc_test123")
    c = anthropic.Anthropic(api_key="sk-ant-test")
    assert c.default_headers.get("anthropic-workspace-id") == "wrkspc_test123"


def test_caller_supplied_header_wins(monkeypatch):
    _reload_engine_with(monkeypatch, "wrkspc_test123")
    c = anthropic.Anthropic(
        api_key="sk-ant-test",
        default_headers={"anthropic-workspace-id": "wrkspc_caller"},
    )
    assert c.default_headers.get("anthropic-workspace-id") == "wrkspc_caller"


def test_wrap_is_idempotent(monkeypatch):
    _reload_engine_with(monkeypatch, "wrkspc_test123")
    import engine

    engine._install_anthropic_workspace_header()
    engine._install_anthropic_workspace_header()
    c = anthropic.Anthropic(api_key="sk-ant-test")
    # A double wrap would nest inits; the flag prevents it.
    assert c.default_headers.get("anthropic-workspace-id") == "wrkspc_test123"
