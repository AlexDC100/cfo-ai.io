"""NO HARD DELETE IN AN ARCHIVED WORKSPACE (2026-09-26).

An archived workspace — in its 30-day recovery window, or HELD by the
one-company-per-workspace migration (``archived_at`` set, ``purge_after``
NULL: the holding workspace "Arhivă (migrare <date>)", the workspaces it
split, the workspaces its rollback archived) — is shown nowhere. What is
in it is exactly what the migration's rollback points documents back at,
and ``financial_periods.source_document_id`` is ON DELETE CASCADE.
``DELETE /api/documents/clear-deleted`` already answered an archived
workspace with nothing (2026-09-21); three more hard-delete paths did
not: ``DELETE /api/period/{id}`` (the period row and its derivatives
hard-deleted, its documents trashed), ``DELETE /api/documents/{id}/
permanent`` (blob + row), and the empty-period drop that follows a
soft-delete. Each now refuses when the target workspace is archived.

Driven against the REAL ``create_app()`` over the tenancy suite's
SQL-derived double with verified identities (test_identity_wall's
fixtures), as the owner of the workspace — a member, past the write wall
— so every refusal below is the archived check and nothing else. Positive
controls: the same call on the live workspace lands, so the gate cannot
pass by refusing everything.

TC-11 — what reds here after the repair: the archived check removed from
any of the three sites (the period / document row is gone, or the period
dropped), or the check refusing the live workspace too.
"""
from __future__ import annotations

import copy

from fastapi.testclient import TestClient

import test_firm_tenancy as T
import test_identity_wall as W
from test_identity_wall import app, world  # noqa: F401 — the fixtures, by name
from engine.api import pipeline

ARCHIVED_AT = "2026-09-21T00:00:00+00:00"


def _org(w, org_id):
    return next(o for o in w.rows("organizations") if o["id"] == org_id)


def _period(w, pid):
    return next((p for p in w.rows("financial_periods") if p["id"] == pid), None)


def _doc(w, did):
    return next((d for d in w.rows("documents") if d["id"] == did), None)


def test_delete_period_refuses_an_archived_workspace_and_leaves_it_whole(app, world):
    client = TestClient(app)
    before = copy.deepcopy(world.tables)
    _org(world, T.ORG_A2)["archived_at"] = ARCHIVED_AT          # held: purge_after stays NULL
    r = client.delete("/api/period/%s" % T.PERIOD_A2, headers=W.hdr(T.A_OWNER, T.ORG_A2))
    assert r.status_code == 409 and "archived" in r.text, (r.status_code, r.text[:200])
    after = copy.deepcopy(world.tables)
    after["organizations"] = before["organizations"] = []        # the archive stamp is the only planted change
    assert after == before, "a refused DELETE /api/period changed a row"
    assert _period(world, T.PERIOD_A2) is not None
    # positive control: the live workspace's period is cleared
    _org(world, T.ORG_A2)["archived_at"] = None
    r = client.delete("/api/period/%s" % T.PERIOD_A2, headers=W.hdr(T.A_OWNER, T.ORG_A2))
    assert r.status_code == 200 and r.json()["ok"] is True, (r.status_code, r.text[:200])
    assert _period(world, T.PERIOD_A2) is None
    assert _period(world, T.PERIOD_A1) is not None, "a sibling period was touched"


def test_permanent_delete_refuses_an_archived_workspace_and_keeps_the_trashed_document(app, world):
    client = TestClient(app)
    gone = _doc(world, W.DOC_A1_GONE)
    assert gone is not None and gone["deleted_at"], "the seed is a soft-deleted document"
    _org(world, T.ORG_A1)["archived_at"] = ARCHIVED_AT
    r = client.delete("/api/documents/%s/permanent" % W.DOC_A1_GONE, headers=W.hdr(T.A_OWNER, T.ORG_A1))
    assert r.status_code == 409 and "archived" in r.text, (r.status_code, r.text[:200])
    assert _doc(world, W.DOC_A1_GONE) is not None and _doc(world, W.DOC_A1_GONE)["deleted_at"] == gone["deleted_at"]
    # positive control: live workspace, the two-step delete lands
    _org(world, T.ORG_A1)["archived_at"] = None
    r = client.delete("/api/documents/%s/permanent" % W.DOC_A1_GONE, headers=W.hdr(T.A_OWNER, T.ORG_A1))
    assert r.status_code == 200 and r.json()["permanently_deleted"] is True, (r.status_code, r.text[:200])
    assert _doc(world, W.DOC_A1_GONE) is None
    assert _doc(world, W.DOC_A1) is not None, "the live document was touched"


def test_the_empty_period_drop_refuses_an_archived_workspace(app, world):
    """The helper behind the soft-delete's orphan cleanup, called as the
    route calls it (the period id and its workspace). PERIOD_A2 has no
    document and no created_at (older than the 5-minute window), so on a
    live workspace it is dropped — and on an archived one it stays."""
    assert not [d for d in world.rows("documents") if d.get("period_id") == T.PERIOD_A2]
    _org(world, T.ORG_A2)["archived_at"] = ARCHIVED_AT
    pipeline._maybe_drop_empty_period(T.PERIOD_A2, org_id=T.ORG_A2)
    assert _period(world, T.PERIOD_A2) is not None, "the empty-period drop reached an archived workspace"
    # a call that names no workspace reads it off the period row
    pipeline._maybe_drop_empty_period(T.PERIOD_A2)
    assert _period(world, T.PERIOD_A2) is not None
    # positive control
    _org(world, T.ORG_A2)["archived_at"] = None
    pipeline._maybe_drop_empty_period(T.PERIOD_A2, org_id=T.ORG_A2)
    assert _period(world, T.PERIOD_A2) is None
    assert _period(world, T.PERIOD_A1) is not None


def test_a_workspace_that_cannot_be_named_counts_as_archived(world):
    """The wall fails closed: no org, an unknown org — no hard delete."""
    with W._supabase.admin() as ac:
        assert pipeline._workspace_is_archived(ac, "") is True
        assert pipeline._workspace_is_archived(ac, None) is True
        assert pipeline._workspace_is_archived(ac, T.U(999)) is True
        assert pipeline._workspace_is_archived(ac, T.ORG_A1) is False
        _org(world, T.ORG_A1)["archived_at"] = ARCHIVED_AT
        assert pipeline._workspace_is_archived(ac, T.ORG_A1) is True
