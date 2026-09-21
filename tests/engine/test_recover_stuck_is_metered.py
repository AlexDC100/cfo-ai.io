"""GATE — the stuck-upload watchdog goes through the SAME meter as /run.

Measured in production 2026-09-20: a document whose /api/pipeline/run was
refused with 402 (extra-document confirmation) stays status='queued' with no
pipeline_started_at — which is exactly what POST /api/pipeline/recover-stuck
calls "stuck". It re-enqueued the refused document with no reservation: two
documents ran unbilled (metered_extra false) minutes after their 402.

Fails on: a refused (extra_required / blocked) document being enqueued; an
unreachable meter failing OPEN; an extra reservation not stamped on the row
(the daemon's commit would then bill nothing); an allowed document no longer
recovering; the refusal not being reported back to the caller.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.api import _usage_gate, pipeline

CALLER = "fd91f61f-0000-4000-8000-000000000001"
OLD = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()


def _decision(kind: str, was_extra: bool = False) -> _usage_gate.DocReserveDecision:
    return _usage_gate.DocReserveDecision(
        kind=kind, plan_key="professional", used=18, reserved=0, cap=12,
        extra_doc_eur=3.0, message="", was_extra=was_extra)


@pytest.fixture()
def harness(monkeypatch):
    state = {"enqueued": [], "status": [], "updates": [], "reserved_for": []}
    docs = [{"id": "doc-1", "org_id": "org-1", "original_filename": "tb.xlsx", "scope": "financial",
             "created_at": OLD, "pipeline_started_at": None}]

    class Client:
        def __enter__(self): return self
        def __exit__(self, *exc): return None
        def select(self, table, **kw): return list(docs) if table == "documents" else []
        def update(self, table, patch, **kw): state["updates"].append((table, patch, kw.get("filters")))

    monkeypatch.setattr(pipeline, "_require_jwt", lambda authorization=None: "jwt")
    monkeypatch.setattr(pipeline._org, "verified_user_id", lambda jwt: CALLER)
    monkeypatch.setattr(pipeline, "_only_member_orgs", lambda jwt, rows: rows)
    monkeypatch.setattr(pipeline._supabase, "per_user", lambda jwt: Client())
    monkeypatch.setattr(pipeline._supabase, "admin", lambda: Client())
    monkeypatch.setattr(pipeline, "_admin_set_status", lambda doc_id, status, **kw: state["status"].append((doc_id, status, kw)))
    monkeypatch.setattr(pipeline, "_enqueue", lambda doc_id: state["enqueued"].append(doc_id))
    # The reservation ledger is process-wide; an "allowed" recovery records
    # doc-1 there. Isolate it so no later test settles this one's entry.
    monkeypatch.setattr(pipeline, "_QUOTA_RUNS", {})

    app = FastAPI()
    app.include_router(pipeline.build_router())
    state["post"] = lambda: TestClient(app).post("/api/pipeline/recover-stuck", headers={"Authorization": "Bearer x"})
    state["meter"] = lambda fn: monkeypatch.setattr(_usage_gate, "reserve_document", fn)
    return state


@pytest.mark.parametrize("kind", ["extra_required", "blocked"])
def test_a_refused_document_is_never_enqueued(harness, kind):
    harness["meter"](lambda uid: harness["reserved_for"].append(uid) or _decision(kind))
    body = harness["post"]().json()
    assert harness["enqueued"] == [] and harness["status"] == []
    assert body["recovered_count"] == 0
    assert body["needs_confirmation"] == [{"id": "doc-1", "filename": "tb.xlsx", "scope": "financial", "reason": kind}]
    assert harness["reserved_for"] == [CALLER], "the meter must be asked about the VERIFIED caller"


def test_an_unreachable_meter_refuses(harness):
    def boom(uid): raise RuntimeError("rpc down")
    harness["meter"](boom)
    body = harness["post"]().json()
    assert harness["enqueued"] == []
    assert body["needs_confirmation"][0]["reason"] == "metering_unavailable"


@pytest.mark.parametrize("kind", ["allowed", "disabled"])
def test_an_allowed_document_still_recovers(harness, kind):
    harness["meter"](lambda uid: _decision(kind))
    body = harness["post"]().json()
    assert harness["enqueued"] == ["doc-1"] and body["recovered_count"] == 1
    assert body["needs_confirmation_count"] == 0 and harness["updates"] == []


def test_an_extra_reservation_is_stamped_so_the_commit_bills_it(harness):
    harness["meter"](lambda uid: _decision("allowed", was_extra=True))
    harness["post"]()
    assert harness["updates"] == [("documents", {"metered_extra": True}, {"id": "eq.doc-1"})]
    assert harness["enqueued"] == ["doc-1"]
