"""PERIOD MOVE — the correction path (Part D, gate W4) — the red suite.

WHAT THIS LANE EXISTS FOR
-------------------------
The 2026-08-30 production audit found a 2025 Carniprod trial balance
filed under 2017-12, and a 2025-12 period holding two different
companies' files. Part B stopped NEW uploads from being misfiled. This
lane is the only way a human can fix the rows that already exist.

A move is not a label edit. `period_end` IS the period's identity — it
keys `financial_periods`, the header label, YoY alignment and the
benchmark's fiscal match — so moving a document means re-filing it: the
document's analysis has to leave one period and land in another, and
BOTH periods' derivatives have to end up describing documents that are
actually attached to them.

THE GATE (W4)
-------------
NO ORPHANED SNAPSHOT MAY BE SERVED AFTERWARDS. An orphaned snapshot is
a period still serving an analysis that no live attached document backs:

  · its persisted envelope's `provenance.source_document_id` names a
    document that is no longer attached to it (this is the real
    2026-08-13 incident — a period served a deleted document's numbers
    under a newer document's name), or
  · it has no live documents at all but still carries an envelope or
    line items, or
  · derivative rows survive a period row that is gone.

`find_orphaned_snapshots` is that predicate, and every move test below
ends by asserting it returns nothing.

THE HINT, USED CORRECTLY
------------------------
`documents.period_end_hint` means "a human confirmed THIS document
belongs to THIS month". The frontend bug filled it with the DROP
TARGET's date — a number read off the UI, never off the document. A
move is the one place the channel is legitimately written: the user is
looking at this document and stating its month. So the move writes the
hint, and the test suite pins that it writes ONLY a date the caller
explicitly supplied — never today, never the open period, never a
default.
"""

from __future__ import annotations

import inspect
import json
import os
import re
from datetime import date
from typing import Any, Dict, List, Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.api import _period_move


AUTH = {"Authorization": "Bearer test-token"}

ORG = "org-1"
DOC_CARNIPROD = "doc-carniprod"
DOC_SCANDIA = "doc-scandia"
PERIOD_2017 = "period-2017-12"
PERIOD_2025 = "period-2025-12"


# ── the store double ───────────────────────────────────────────────────
#
# Deliberately STRICTER than PostgREST, never looser. Two rules make it
# safe to trust:
#
#   1. An unknown filter operator, an unknown table or an unsupported
#      argument RAISES. The `FakeStore` postmortem in CLAUDE.md §21 is
#      the reason: a double that silently accepted an unsupported call
#      hid two total outages behind green tests. A filter this store
#      cannot express must fail loudly, never match everything.
#   2. Deleting a `financial_periods` row does NOT cascade here, even
#      though the real schema does (`on delete cascade`). Modelling the
#      cascade would HIDE a missing explicit derivative delete; not
#      modelling it can only raise a false alarm, never grant false
#      confidence. The engine deletes derivatives explicitly for exactly
#      that reason (see `delete_period`'s "explicit per-table is safer"
#      comment).

_TABLES = {
    "documents",
    "financial_periods",
    "statement_line_items",
    "calculated_metrics",
    "briefings",
    "valuations",
    "user_valuation_assumptions",
}


class MemoryStore:
    def __init__(self, rows: Dict[str, List[Dict[str, Any]]]) -> None:
        unknown = set(rows) - _TABLES
        if unknown:
            raise AssertionError("unknown table(s) in seed: %s" % sorted(unknown))
        self.rows: Dict[str, List[Dict[str, Any]]] = {
            t: [dict(r) for r in rows.get(t, [])] for t in _TABLES
        }
        self.calls: List[str] = []

    # context-manager shape of engine.api._supabase.SupabaseClient
    def __enter__(self) -> "MemoryStore":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    # ── filtering ──
    @staticmethod
    def _match(row: Dict[str, Any], column: str, expr: str) -> bool:
        if expr == "is.null":
            return row.get(column) is None
        if expr == "not.is.null":
            return row.get(column) is not None
        if expr.startswith("eq."):
            return str(row.get(column)) == expr[3:]
        if expr.startswith("neq."):
            return str(row.get(column)) != expr[4:]
        if expr.startswith("in.("):
            wanted = [v for v in expr[4:-1].split(",") if v]
            return str(row.get(column)) in wanted
        raise AssertionError(
            "MemoryStore cannot express filter %r on %r — the real client "
            "would send it to PostgREST. Teach the store or change the "
            "query; never let it match everything." % (expr, column)
        )

    def _select_rows(
        self, table: str, filters: Optional[Dict[str, str]]
    ) -> List[Dict[str, Any]]:
        if table not in _TABLES:
            raise AssertionError("unknown table %r" % table)
        out = self.rows[table]
        for column, expr in (filters or {}).items():
            out = [r for r in out if self._match(r, column, expr)]
        return out

    # ── the SupabaseClient surface actually used ──
    def select(
        self,
        table: str,
        *,
        filters: Optional[Dict[str, str]] = None,
        columns: str = "*",
        limit: Optional[int] = None,
        order: Optional[str] = None,
        single: bool = False,
    ) -> List[Dict[str, Any]]:
        self.calls.append("select:%s" % table)
        out = [dict(r) for r in self._select_rows(table, filters)]
        if order:
            for spec in reversed(order.split(",")):
                key = spec.split(".")[0]
                desc = spec.endswith(".desc")
                out.sort(key=lambda r: (r.get(key) is None, r.get(key) or ""), reverse=desc)
        if limit is not None:
            out = out[:limit]
        if single:
            out = out[:1]
        return out

    def update(self, table: str, patch: Dict[str, Any], *, filters: Dict[str, str]) -> None:
        self.calls.append("update:%s" % table)
        for row in self._select_rows(table, filters):
            row.update(patch)

    def delete(self, table: str, *, filters: Dict[str, str]) -> None:
        self.calls.append("delete:%s" % table)
        doomed = {id(r) for r in self._select_rows(table, filters)}
        self.rows[table] = [r for r in self.rows[table] if id(r) not in doomed]

    def insert(
        self, table: str, rows: Any, *, returning: bool = True
    ) -> List[Dict[str, Any]]:
        self.calls.append("insert:%s" % table)
        body = rows if isinstance(rows, list) else [rows]
        stored = [dict(r) for r in body]
        self.rows[table].extend(stored)
        return [dict(r) for r in stored] if returning else []


def envelope(source_document_id: str, *, period_end: str) -> Dict[str, Any]:
    """A minimally faithful persisted envelope: the provenance stamp is
    the field the orphan predicate reads, and it is the field the real
    `stage_persist` writes."""
    return {
        "canonical_bs": {"mapping_version": "v2"},
        "provenance": {
            "source_document_id": source_document_id,
            "original_filename": "whatever.xlsx",
            "content_hash": "abc",
            "written_at": "2026-08-30T00:00:00+00:00",
        },
        "period_detection": {
            "resolved_period_end": period_end,
            "signal_used": "user_confirmed",
            "confidence": 1.0,
            "evidence_snippet": None,
            "hint": period_end,
            "detected": {"proposed_period_end": "2025-12-31"},
            "mismatch": period_end != "2025-12-31",
        },
    }


def production_store() -> MemoryStore:
    """The audited production shape: a 2025 Carniprod trial balance filed
    under 2017-12 (alone in its period), and a 2025-12 period already
    holding a different company's file."""
    return MemoryStore(
        {
            "documents": [
                {
                    "id": DOC_CARNIPROD,
                    "org_id": ORG,
                    "period_id": PERIOD_2017,
                    "original_filename": "Carniprod Trial Balance 2025.xlsx",
                    "period_end_hint": "2017-12-31",
                    "status": "analyzed",
                    "scope": "financial",
                    "deleted_at": None,
                    "created_at": "2026-08-01T00:00:00+00:00",
                },
                {
                    "id": DOC_SCANDIA,
                    "org_id": ORG,
                    "period_id": PERIOD_2025,
                    "original_filename": "Scandia RealEstate 2025.xlsx",
                    "period_end_hint": "2025-12-31",
                    "status": "analyzed",
                    "scope": "financial",
                    "deleted_at": None,
                    "created_at": "2026-08-02T00:00:00+00:00",
                },
            ],
            "financial_periods": [
                {
                    "id": PERIOD_2017,
                    "org_id": ORG,
                    "period_end": "2017-12-31",
                    "period_start": "2017-12-31",
                    "source_document_id": DOC_CARNIPROD,
                    "assembled_canonical_v1": envelope(
                        DOC_CARNIPROD, period_end="2017-12-31"
                    ),
                },
                {
                    "id": PERIOD_2025,
                    "org_id": ORG,
                    "period_end": "2025-12-31",
                    "period_start": "2025-12-31",
                    "source_document_id": DOC_SCANDIA,
                    "assembled_canonical_v1": envelope(
                        DOC_SCANDIA, period_end="2025-12-31"
                    ),
                },
            ],
            "statement_line_items": [
                {"id": "li-1", "period_id": PERIOD_2017, "bucket": "cash", "amount": 1},
                {"id": "li-2", "period_id": PERIOD_2025, "bucket": "cash", "amount": 2},
            ],
            "calculated_metrics": [
                {"id": "m-1", "period_id": PERIOD_2017, "name": "total_assets", "value": 1},
                {"id": "m-2", "period_id": PERIOD_2025, "name": "total_assets", "value": 2},
            ],
            "briefings": [{"id": "b-1", "period_id": PERIOD_2017}],
            "valuations": [{"id": "v-1", "period_id": PERIOD_2017}],
            "user_valuation_assumptions": [{"id": "ua-1", "period_id": PERIOD_2017}],
        }
    )


def doc_of(store: MemoryStore, doc_id: str) -> Dict[str, Any]:
    return store.select("documents", filters={"id": "eq.%s" % doc_id})[0]


# ── target validation: only a date the human actually supplied ─────────


def test_normalize_accepts_a_month_end_iso_date():
    assert _period_move.normalize_target_period_end("2025-12-31") == "2025-12-31"


def test_normalize_accepts_a_bare_month_and_resolves_its_last_day():
    assert _period_move.normalize_target_period_end("2025-02") == "2025-02-28"
    assert _period_move.normalize_target_period_end("2024-02") == "2024-02-29"


@pytest.mark.parametrize(
    "bad",
    ["", None, "not-a-date", "31.12.2025", "2025-13-01", "2025-12-32", 20251231],
)
def test_normalize_refuses_anything_that_is_not_a_date(bad):
    with pytest.raises(_period_move.MoveRefused) as ei:
        _period_move.normalize_target_period_end(bad)
    assert ei.value.code == "invalid_period_end"


@pytest.mark.parametrize("bad", ["2050-12-31", "5309-03-31", "1999-12-31"])
def test_normalize_refuses_implausible_years_via_the_engines_own_clamp(bad):
    """The legacy 2050-12-31 rows exist because an unclamped date reached
    the persist path. A correction tool that can mint one is not a
    correction tool."""
    with pytest.raises(_period_move.MoveRefused) as ei:
        _period_move.normalize_target_period_end(bad)
    assert ei.value.code == "implausible_period_end"


def test_normalize_never_invents_a_date_from_the_clock():
    """ABSENT != ZERO at the API boundary: no target, no move. Today is
    not a fallback here any more than it is in detection."""
    with pytest.raises(_period_move.MoveRefused):
        _period_move.normalize_target_period_end(None)
    source = inspect.getsource(_period_move.normalize_target_period_end)
    assert "today" not in source


# ── the plan (pure) ────────────────────────────────────────────────────


def test_plan_is_pure_and_takes_no_clock():
    sig = inspect.signature(_period_move.plan_move)
    assert set(sig.parameters) == {
        "document", "from_period", "siblings", "target_period_end"
    }
    for param in sig.parameters.values():
        assert param.kind is inspect.Parameter.KEYWORD_ONLY


def test_plan_moving_the_only_document_out_deletes_the_emptied_period():
    store = production_store()
    plan = _period_move.plan_move(
        document=doc_of(store, DOC_CARNIPROD),
        from_period=store.select("financial_periods", filters={"id": "eq.%s" % PERIOD_2017})[0],
        siblings=[],
        target_period_end="2025-12-31",
    )
    assert plan.moved is True
    assert plan.source_action == "deleted"
    assert plan.source_period_id == PERIOD_2017
    assert plan.rebuild_document_id is None


def test_plan_leaving_siblings_behind_rebuilds_the_period_from_one_of_them():
    """The period's envelope was built from the document that is leaving,
    so what stays behind describes a file that is no longer there. The
    period must be rebuilt from a document still attached — not left
    serving the mover's numbers."""
    store = production_store()
    sibling = {
        "id": "doc-sibling",
        "org_id": ORG,
        "period_id": PERIOD_2017,
        "status": "analyzed",
        "scope": "financial",
        "deleted_at": None,
        "created_at": "2026-08-03T00:00:00+00:00",
    }
    plan = _period_move.plan_move(
        document=doc_of(store, DOC_CARNIPROD),
        from_period=store.select("financial_periods", filters={"id": "eq.%s" % PERIOD_2017})[0],
        siblings=[sibling],
        target_period_end="2025-12-31",
    )
    assert plan.source_action == "rebuilt"
    assert plan.rebuild_document_id == "doc-sibling"


def test_plan_keeps_a_period_whose_analysis_belongs_to_a_document_that_stays():
    """Not every departure orphans a snapshot. If the envelope was built
    from a document that remains attached, the period is still honest and
    must not be wiped — never rewrite data that is correct."""
    store = production_store()
    period = store.select("financial_periods", filters={"id": "eq.%s" % PERIOD_2017})[0]
    period["source_document_id"] = "doc-sibling"
    period["assembled_canonical_v1"] = envelope("doc-sibling", period_end="2017-12-31")
    sibling = {
        "id": "doc-sibling",
        "org_id": ORG,
        "period_id": PERIOD_2017,
        "status": "analyzed",
        "scope": "financial",
        "deleted_at": None,
        "created_at": "2026-08-03T00:00:00+00:00",
    }
    plan = _period_move.plan_move(
        document=doc_of(store, DOC_CARNIPROD),
        from_period=period,
        siblings=[sibling],
        target_period_end="2025-12-31",
    )
    assert plan.source_action == "kept"
    assert plan.rebuild_document_id is None


def test_plan_refuses_a_move_that_would_not_move_anything():
    store = production_store()
    plan = _period_move.plan_move(
        document=doc_of(store, DOC_SCANDIA),
        from_period=store.select("financial_periods", filters={"id": "eq.%s" % PERIOD_2025})[0],
        siblings=[],
        target_period_end="2025-12-31",
    )
    assert plan.moved is False
    assert plan.source_action == "none"


def test_plan_handles_a_document_with_no_period_at_all():
    store = production_store()
    orphan_doc = dict(doc_of(store, DOC_CARNIPROD), period_id=None)
    plan = _period_move.plan_move(
        document=orphan_doc,
        from_period=None,
        siblings=[],
        target_period_end="2025-12-31",
    )
    assert plan.moved is True
    assert plan.source_action == "none"
    assert plan.source_period_id is None


# ── W4 — the orphan predicate itself ───────────────────────────────────


def test_orphan_finder_is_quiet_on_a_healthy_workspace():
    assert _period_move.find_orphaned_snapshots(production_store(), org_id=ORG) == []


def test_orphan_finder_catches_an_envelope_whose_document_left():
    """The 2026-08-13 incident, reproduced: the period keeps serving an
    analysis built from a document that is no longer attached to it."""
    store = production_store()
    store.update(
        "documents", {"period_id": PERIOD_2025}, filters={"id": "eq.%s" % DOC_CARNIPROD}
    )
    found = _period_move.find_orphaned_snapshots(store, org_id=ORG)
    assert [f["period_id"] for f in found] == [PERIOD_2017]
    assert found[0]["reason"] == "envelope_from_detached_document"


def test_orphan_finder_catches_a_period_with_no_live_documents_still_serving():
    store = production_store()
    store.update(
        "documents", {"deleted_at": "2026-08-30T00:00:00+00:00", "period_id": None},
        filters={"id": "eq.%s" % DOC_CARNIPROD},
    )
    found = _period_move.find_orphaned_snapshots(store, org_id=ORG)
    assert [f["period_id"] for f in found] == [PERIOD_2017]
    assert found[0]["reason"] == "period_has_no_live_documents"


def test_orphan_finder_catches_derivatives_that_outlived_their_period():
    """`audit_period_ids` names periods that may no longer exist — a
    caller that just deleted one asks about it explicitly. The finder
    never scans the derivative tables blind: they are not org-scoped, so
    an unfiltered sweep would read other tenants' rows and would grow
    with the whole database."""
    store = production_store()
    store.delete("financial_periods", filters={"id": "eq.%s" % PERIOD_2017})
    found = _period_move.find_orphaned_snapshots(
        store, org_id=ORG, audit_period_ids=[PERIOD_2017]
    )
    reasons = {f["reason"] for f in found}
    assert "derivatives_without_period" in reasons


def test_orphan_finder_never_sweeps_the_derivative_tables_unscoped():
    """Every derivative read must carry a period_id filter. The store
    double raises on a filter it cannot express, but an UNFILTERED select
    is silently legal there and catastrophic in production."""
    store = production_store()
    store.delete("financial_periods", filters={"id": "eq.%s" % PERIOD_2017})
    _period_move.find_orphaned_snapshots(store, org_id=ORG)
    source = inspect.getsource(_period_move.find_orphaned_snapshots)
    for table in ("statement_line_items", "calculated_metrics"):
        for line in source.splitlines():
            if table in line and "select" in line:
                assert "filters" in source


def test_orphan_finder_treats_an_empty_period_as_absent_not_orphaned():
    """ABSENT != ZERO. A period container with no files and no analysis is
    an invitation to attach, not a defect."""
    store = production_store()
    store.rows["financial_periods"].append(
        {
            "id": "period-empty",
            "org_id": ORG,
            "period_end": "2026-01-31",
            "source_document_id": None,
            "assembled_canonical_v1": None,
        }
    )
    assert _period_move.find_orphaned_snapshots(store, org_id=ORG) == []


# ── the move, end to end, on the audited production shape ──────────────


def test_the_reported_carniprod_row_can_actually_be_corrected():
    store = production_store()
    record = _period_move.move_document_to_period(
        store,
        document=doc_of(store, DOC_CARNIPROD),
        target_period_end="2025-12-31",
        now="2026-08-30T12:00:00+00:00",
    )
    assert record["moved"] is True
    assert record["to"]["period_end"] == "2025-12-31"
    assert record["from"]["period_end"] == "2017-12-31"
    assert record["from"]["action"] == "deleted"

    moved = doc_of(store, DOC_CARNIPROD)
    # The hint is the human's confirmation for THIS document — the one
    # legitimate write of the channel the frontend was abusing.
    assert moved["period_end_hint"] == "2025-12-31"
    # Detached until the re-run files it; nothing may claim it meanwhile.
    assert moved["period_id"] is None


def test_the_move_leaves_no_orphaned_snapshot_behind():
    store = production_store()
    record = _period_move.move_document_to_period(
        store,
        document=doc_of(store, DOC_CARNIPROD),
        target_period_end="2025-12-31",
        now="2026-08-30T12:00:00+00:00",
    )
    # The move audits its own work — W4 is checked in production, not
    # only in this test.
    assert record["orphaned_after"] == []
    assert (
        _period_move.find_orphaned_snapshots(
            store, org_id=ORG, audit_period_ids=[PERIOD_2017]
        )
        == []
    )
    # The emptied period and every derivative of it are gone — not left
    # for a later reader to mistake for real data.
    assert store.select("financial_periods", filters={"id": "eq.%s" % PERIOD_2017}) == []
    for table in ("statement_line_items", "calculated_metrics", "briefings", "valuations"):
        assert store.select(table, filters={"period_id": "eq.%s" % PERIOD_2017}) == []


def test_the_move_does_not_touch_the_other_periods_data():
    """W6 — existing correct periods are untouched."""
    store = production_store()
    before = json.dumps(
        store.select("financial_periods", filters={"id": "eq.%s" % PERIOD_2025}),
        sort_keys=True,
    )
    _period_move.move_document_to_period(
        store,
        document=doc_of(store, DOC_CARNIPROD),
        target_period_end="2025-12-31",
        now="2026-08-30T12:00:00+00:00",
    )
    after = json.dumps(
        store.select("financial_periods", filters={"id": "eq.%s" % PERIOD_2025}),
        sort_keys=True,
    )
    assert before == after
    assert store.select("statement_line_items", filters={"period_id": "eq.%s" % PERIOD_2025})


def test_a_move_that_leaves_siblings_wipes_the_stale_analysis_and_requeues_a_rebuild():
    store = production_store()
    store.rows["documents"].append(
        {
            "id": "doc-sibling",
            "org_id": ORG,
            "period_id": PERIOD_2017,
            "original_filename": "other.xlsx",
            "status": "analyzed",
            "scope": "financial",
            "deleted_at": None,
            "created_at": "2026-08-03T00:00:00+00:00",
        }
    )
    record = _period_move.move_document_to_period(
        store,
        document=doc_of(store, DOC_CARNIPROD),
        target_period_end="2025-12-31",
        now="2026-08-30T12:00:00+00:00",
    )
    assert record["from"]["action"] == "rebuilt"
    assert record["rebuild_document_id"] == "doc-sibling"

    period = store.select("financial_periods", filters={"id": "eq.%s" % PERIOD_2017})[0]
    # Honest emptiness while the rebuild runs — never the mover's numbers
    # under the sibling's name.
    assert period["assembled_canonical_v1"] is None
    assert period["source_document_id"] == "doc-sibling"
    assert store.select("statement_line_items", filters={"period_id": "eq.%s" % PERIOD_2017}) == []
    assert _period_move.find_orphaned_snapshots(store, org_id=ORG) == []


def test_a_no_op_move_changes_nothing_at_all():
    store = production_store()
    before = json.dumps(store.rows, sort_keys=True, default=str)
    record = _period_move.move_document_to_period(
        store,
        document=doc_of(store, DOC_SCANDIA),
        target_period_end="2025-12-31",
        now="2026-08-30T12:00:00+00:00",
    )
    assert record["moved"] is False
    assert json.dumps(store.rows, sort_keys=True, default=str) == before


def test_the_move_reports_the_destination_period_when_one_already_exists():
    store = production_store()
    record = _period_move.move_document_to_period(
        store,
        document=doc_of(store, DOC_CARNIPROD),
        target_period_end="2025-12-31",
        now="2026-08-30T12:00:00+00:00",
    )
    assert record["to"]["period_id"] == PERIOD_2025


def test_the_move_reports_no_destination_row_when_the_month_is_new():
    """It does not invent the destination period id — `stage_persist`
    creates that row on the re-run. Reporting a guess would be a fact the
    caller could not act on."""
    store = production_store()
    record = _period_move.move_document_to_period(
        store,
        document=doc_of(store, DOC_CARNIPROD),
        target_period_end="2024-06-30",
        now="2026-08-30T12:00:00+00:00",
    )
    assert record["to"]["period_id"] is None
    assert record["to"]["period_end"] == "2024-06-30"


def test_the_move_never_writes_a_hint_the_caller_did_not_supply():
    """The whole bug in one assertion: the only date the move writes is
    the one the human passed in."""
    store = production_store()
    _period_move.move_document_to_period(
        store,
        document=doc_of(store, DOC_CARNIPROD),
        target_period_end="2024-06-30",
        now="2026-08-30T12:00:00+00:00",
    )
    assert doc_of(store, DOC_CARNIPROD)["period_end_hint"] == "2024-06-30"
    assert doc_of(store, DOC_CARNIPROD)["period_end_hint"] != date.today().isoformat()


# ── "active file" is a fact, not a guess ───────────────────────────────


def test_make_active_promotes_an_attachment_to_the_periods_analysis_source():
    """ONE analysis source per period, switchable. The engine's authority
    is `financial_periods.source_document_id`; promoting a sibling
    re-points it and re-runs that document into the same period."""
    store = production_store()
    store.rows["documents"].append(
        {
            "id": "doc-sibling",
            "org_id": ORG,
            "period_id": PERIOD_2017,
            "original_filename": "other.xlsx",
            "status": "analyzed",
            "scope": "financial",
            "deleted_at": None,
            "created_at": "2026-08-03T00:00:00+00:00",
        }
    )
    record = _period_move.make_document_active(
        store,
        document=doc_of(store, "doc-sibling"),
        now="2026-08-30T12:00:00+00:00",
    )
    assert record["period_id"] == PERIOD_2017
    assert record["requeue_document_id"] == "doc-sibling"
    period = store.select("financial_periods", filters={"id": "eq.%s" % PERIOD_2017})[0]
    assert period["source_document_id"] == "doc-sibling"
    assert period["assembled_canonical_v1"] is None
    assert _period_move.find_orphaned_snapshots(store, org_id=ORG) == []


def test_make_active_refuses_a_document_that_is_not_in_a_period():
    store = production_store()
    store.update("documents", {"period_id": None}, filters={"id": "eq.%s" % DOC_CARNIPROD})
    with pytest.raises(_period_move.MoveRefused) as ei:
        _period_move.make_document_active(
            store, document=doc_of(store, DOC_CARNIPROD), now="2026-08-30T12:00:00+00:00"
        )
    assert ei.value.code == "not_in_a_period"


def test_make_active_on_the_document_that_is_already_the_source_is_a_no_op():
    store = production_store()
    before = json.dumps(store.rows, sort_keys=True, default=str)
    record = _period_move.make_document_active(
        store, document=doc_of(store, DOC_CARNIPROD), now="2026-08-30T12:00:00+00:00"
    )
    assert record["changed"] is False
    assert json.dumps(store.rows, sort_keys=True, default=str) == before


# ── the routes ─────────────────────────────────────────────────────────


class _Recorder:
    def __init__(self) -> None:
        self.statuses: List[Any] = []
        self.enqueued: List[str] = []

    def set_status(self, doc_id: str, status: str, **kw: Any) -> None:
        self.statuses.append((doc_id, status, kw))

    def enqueue(self, doc_id: str) -> None:
        self.enqueued.append(doc_id)


@pytest.fixture
def wired():
    store = production_store()
    rec = _Recorder()

    def require_jwt(authorization: Optional[str]) -> str:
        from fastapi import HTTPException

        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "Missing Bearer token.")
        return authorization.split(" ", 1)[1]

    def verify_owns(jwt: str, document_id: str) -> Dict[str, Any]:
        from fastapi import HTTPException

        rows = store.select("documents", filters={"id": "eq.%s" % document_id})
        if not rows:
            raise HTTPException(404, "Document %s not found." % document_id)
        return rows[0]

    from fastapi import APIRouter

    router = APIRouter()
    _period_move.register_routes(
        router,
        require_jwt=require_jwt,
        verify_owns=verify_owns,
        set_status=rec.set_status,
        enqueue=rec.enqueue,
        admin_client=lambda: store,
    )
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), store, rec


def test_route_requires_auth(wired):
    client, _store, _rec = wired
    r = client.post(
        "/api/documents/%s/move-period" % DOC_CARNIPROD,
        json={"period_end": "2025-12-31"},
    )
    assert r.status_code == 401


def test_route_404s_on_a_document_the_caller_cannot_see(wired):
    client, _store, _rec = wired
    r = client.post(
        "/api/documents/not-a-doc/move-period",
        json={"period_end": "2025-12-31"},
        headers=AUTH,
    )
    assert r.status_code == 404


def test_route_moves_the_document_and_requeues_it(wired):
    client, store, rec = wired
    r = client.post(
        "/api/documents/%s/move-period" % DOC_CARNIPROD,
        json={"period_end": "2025-12-31"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["moved"] is True
    assert body["orphaned_after"] == []
    assert rec.enqueued == [DOC_CARNIPROD]
    assert rec.statuses[0][0] == DOC_CARNIPROD
    assert rec.statuses[0][1] == "queued"
    assert doc_of(store, DOC_CARNIPROD)["period_end_hint"] == "2025-12-31"


def test_route_requeues_both_documents_when_the_source_needs_a_rebuild(wired):
    client, store, rec = wired
    store.rows["documents"].append(
        {
            "id": "doc-sibling",
            "org_id": ORG,
            "period_id": PERIOD_2017,
            "original_filename": "other.xlsx",
            "status": "analyzed",
            "scope": "financial",
            "deleted_at": None,
            "created_at": "2026-08-03T00:00:00+00:00",
        }
    )
    r = client.post(
        "/api/documents/%s/move-period" % DOC_CARNIPROD,
        json={"period_end": "2025-12-31"},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert set(rec.enqueued) == {DOC_CARNIPROD, "doc-sibling"}


def test_route_rejects_a_body_with_no_period_end(wired):
    """No target, no move — the endpoint has no default to fall back on."""
    client, _store, _rec = wired
    r = client.post(
        "/api/documents/%s/move-period" % DOC_CARNIPROD, json={}, headers=AUTH
    )
    assert r.status_code == 422


@pytest.mark.parametrize(
    "smuggled",
    ["open_period_end", "active_period_end", "target_period_id", "period_end_hint"],
)
def test_route_forbids_smuggled_ui_state_in_the_body(wired, smuggled):
    """Same discipline as `/api/period/detect`: an unknown field is a 422,
    never a silently-ignored one. The move's date must be the one the user
    confirmed, and the body must not be able to carry a second candidate."""
    client, _store, _rec = wired
    r = client.post(
        "/api/documents/%s/move-period" % DOC_CARNIPROD,
        json={"period_end": "2025-12-31", smuggled: "2017-12-31"},
        headers=AUTH,
    )
    assert r.status_code == 422


def test_route_refuses_an_implausible_target_with_a_readable_code(wired):
    client, store, rec = wired
    r = client.post(
        "/api/documents/%s/move-period" % DOC_CARNIPROD,
        json={"period_end": "2050-12-31"},
        headers=AUTH,
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "implausible_period_end"
    # and nothing was touched
    assert doc_of(store, DOC_CARNIPROD)["period_id"] == PERIOD_2017
    assert rec.enqueued == []


def test_make_active_route_promotes_and_requeues(wired):
    client, store, rec = wired
    store.rows["documents"].append(
        {
            "id": "doc-sibling",
            "org_id": ORG,
            "period_id": PERIOD_2017,
            "original_filename": "other.xlsx",
            "status": "analyzed",
            "scope": "financial",
            "deleted_at": None,
            "created_at": "2026-08-03T00:00:00+00:00",
        }
    )
    r = client.post("/api/documents/doc-sibling/make-active", headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["changed"] is True
    assert rec.enqueued == ["doc-sibling"]
    assert r.json()["orphaned_after"] == []


def test_route_is_registered_on_the_real_pipeline_router():
    """The lane is worthless if the route only exists in the test's own
    wiring — pin that pipeline.build_router() actually mounts it."""
    from engine.api import pipeline

    paths = {
        (r.path, tuple(sorted(r.methods)))
        for r in pipeline.build_router().routes
        if hasattr(r, "methods")
    }
    assert ("/api/documents/{document_id}/move-period", ("POST",)) in paths
    assert ("/api/documents/{document_id}/make-active", ("POST",)) in paths


# ── the run journal records the move, with before and after ────────────


def test_period_moved_is_part_of_the_journal_vocabulary():
    from engine.journal.events import EVENT_TYPES

    assert "PERIOD_MOVED" in EVENT_TYPES


def test_the_journal_records_the_move_with_before_and_after(tmp_path, monkeypatch):
    from engine.journal import Journal
    from engine.journal import hooks as journal_hooks

    monkeypatch.setenv("ENGINE_JOURNAL_DIR", str(tmp_path / "journal"))
    journal_hooks.reset_cache()

    store = production_store()
    doc = doc_of(store, DOC_CARNIPROD)
    doc["content_hash"] = "f" * 64
    record = _period_move.move_document_to_period(
        store,
        document=doc,
        target_period_end="2025-12-31",
        now="2026-08-30T12:00:00+00:00",
    )
    journal_hooks.on_period_moved(doc, record)

    journal = Journal(str(tmp_path / "journal"))
    events = journal.chain_events("f" * 64)
    moved = [e for e in events if e["type"] == "PERIOD_MOVED"]
    assert len(moved) == 1
    payload = moved[0]["payload"]
    assert payload["before"]["period_end"] == "2017-12-31"
    assert payload["after"]["period_end"] == "2025-12-31"
    assert payload["document_id"] == DOC_CARNIPROD
    assert payload["source_action"] == "deleted"
    journal_hooks.reset_cache()


def test_the_journal_hook_is_a_no_op_when_the_journal_is_off(monkeypatch):
    from engine.journal import hooks as journal_hooks

    monkeypatch.delenv("ENGINE_JOURNAL_DIR", raising=False)
    journal_hooks.reset_cache()
    # must not raise, must not need a run context
    journal_hooks.on_period_moved({"id": "x", "content_hash": "a" * 64}, {})


# ── no UI state may reach the engine's own resolution ──────────────────


def test_the_move_module_never_reads_a_period_from_the_ui_beyond_the_target():
    """A structural guard, mirroring Part B's: the only date this module
    may act on is the confirmed target. Nothing named for the open /
    active / current period may appear as an input."""
    source = inspect.getsource(_period_move)
    for banned in ("open_period_end", "active_period_end", "current_period_end"):
        assert banned not in source
