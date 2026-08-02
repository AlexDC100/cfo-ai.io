"""Workspace-flow fixes (2026-08-02) — backend unit locks.

Covers the two backend repairs from the workspace/upload-flow audit:
  1. `_test_mode.is_bypass_token` no longer accepts the literal
     "PUBLIC_TEST_MODE_BYPASS" bearer when test mode is OFF (it was an
     unauthenticated identity bypass to the synthetic test user).
  2. `_org.default_org_for_user` skips ARCHIVED organizations — memberships
     survive an archive, so the old query could scope requests to a workspace
     scheduled for purge.

Run:  pytest tests/test_workspace_flow_fixes.py -v
(Skips locally when the engine's heavy deps aren't installed; runs in the
backend container / CI where they are.)
"""

from __future__ import annotations

import pytest

pytest.importorskip("sqlalchemy")  # engine.api package pulls it transitively

from engine.api import _org, _test_mode  # noqa: E402


class _FakeAdmin:
    """Stand-in for _supabase.admin() — returns canned rows per table."""

    def __init__(self, memberships, orgs_by_id):
        self._memberships = memberships
        self._orgs = orgs_by_id

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def select(self, table, filters=None, order=None, limit=None):
        if table == "memberships":
            return self._memberships[: (limit or len(self._memberships))]
        if table == "organizations":
            org_id = (filters or {}).get("id", "").removeprefix("eq.")
            row = self._orgs.get(org_id)
            return [row] if row else []
        return []


# ── 1. bypass token is gated on test mode ────────────────────────────────

def test_bypass_token_rejected_when_test_mode_off(monkeypatch):
    monkeypatch.setenv("PUBLIC_TEST_MODE", "0")
    assert _test_mode.is_bypass_token(_test_mode.JWT_BYPASS_PLACEHOLDER) is False
    assert _test_mode.is_bypass_token("any-other-token") is False


def test_bypass_token_accepted_when_test_mode_on(monkeypatch):
    monkeypatch.setenv("PUBLIC_TEST_MODE", "1")
    # In test mode the check is deliberately permissive (any token routes to
    # the synthetic user so a missed short-circuit can't 500 against Supabase).
    assert _test_mode.is_bypass_token(_test_mode.JWT_BYPASS_PLACEHOLDER) is True
    assert _test_mode.is_bypass_token("whatever") is True


# ── 2. default_org_for_user skips archived orgs ──────────────────────────

def _patch_admin(monkeypatch, memberships, orgs_by_id):
    monkeypatch.setattr(
        _org._supabase, "admin", lambda: _FakeAdmin(memberships, orgs_by_id)
    )


def test_default_org_skips_archived(monkeypatch):
    _patch_admin(
        monkeypatch,
        memberships=[
            {"org_id": "org-old", "created_at": "2026-01-01"},
            {"org_id": "org-new", "created_at": "2026-06-01"},
        ],
        orgs_by_id={
            "org-old": {"id": "org-old", "archived_at": "2026-07-01T00:00:00Z"},
            "org-new": {"id": "org-new", "archived_at": None},
        },
    )
    # Oldest membership is archived → the fallback must move on to the live one.
    assert _org.default_org_for_user("user-1") == "org-new"


def test_default_org_none_when_all_archived(monkeypatch):
    _patch_admin(
        monkeypatch,
        memberships=[{"org_id": "org-a", "created_at": "2026-01-01"}],
        orgs_by_id={"org-a": {"id": "org-a", "archived_at": "2026-07-01T00:00:00Z"}},
    )
    assert _org.default_org_for_user("user-1") is None


def test_default_org_prefers_oldest_live(monkeypatch):
    _patch_admin(
        monkeypatch,
        memberships=[
            {"org_id": "org-1", "created_at": "2026-01-01"},
            {"org_id": "org-2", "created_at": "2026-02-01"},
        ],
        orgs_by_id={
            "org-1": {"id": "org-1", "archived_at": None},
            "org-2": {"id": "org-2", "archived_at": None},
        },
    )
    assert _org.default_org_for_user("user-1") == "org-1"
