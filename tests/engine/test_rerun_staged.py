"""A RE-RUN IS STAGED BESIDE ITS OWN MONTH — gate `rerun-data-loss`, stage 2.

THE DEFECT (hand-over 2026-10-04, item 2; a stated limit of the briefing
hotfix). `POST /api/pipeline/retry` RESET before it re-ran: it deleted the
document's period — production's foreign keys cascade the line items, the
metrics, the briefing and the recommendations away — and what a reader would
lose was held in the backend PROCESS (`_RERUN_CARRY`) until the run had
narrated. A restart or a deploy between the reset and the narrative stage, or
between a failed run and the document's next one, lost the last good briefing
and the worked recommendations for good; and from the click until a run
succeeded the month was not served at all.

THE ORDER NOW. The re-run persists under a STAGED row beside the month — a
`financial_periods` row that names NO source document and carries a marker in
its envelope (`engine.api._staged_rerun`) — and takes the month over only once
it has succeeded. Nothing is reset, so nothing is carried.

THIS FILE, SO FAR — the readers' side (C2.1). A staged row must never be
taken for a month:
  S11 another upload for the month stages beside the SERVED row and takes
      THAT row over — never a stranded staged row;
  S12 the monthly inventory-days basis ignores a staged row;
  S13 the orphan audit and a move's destination ignore a staged row; a staged
      row is never a document's "own" period; and the unique-tuple model this
      file's worlds enforce is live (positive control).

WHAT RUNS HERE. The `gw` world of test_workspace_v2_gates (the real routes,
the real `_run_pipeline_sync`, the PostgREST double) with the helpers of the
writers file of gate briefing-keep-last-good and of test_rerun_ownership;
seam laws on the writers file's `RecordingDouble`.

TWO THINGS THE DOUBLE DOES NOT MODEL ARE MODELLED BY HAND:
  · a period's children going with it and `documents.period_id` set NULL
    when its period is deleted (`test_rerun_ownership._production_foreign_keys`);
  · production's `unique (org_id, period_end, source_document_id)`
    (schema.sql; NULLs distinct): `_enforce_the_unique_period_tuple` refuses
    a write that would leave two rows with one NON-NULL tuple.

THE MARKER'S KEY AND SHAPE ARE WRITTEN OUT HERE (`MARKER_KEY`), never read
from the code under test.

PLANT LOG: docs/engine_book/gates.md "rerun-data-loss".
"""
from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional

import pytest

import _real_app_comparatives as RA
import test_briefing_keep_last_good_writers as W
import test_rerun_ownership as O
import test_workspace_v2_gates as V
from test_workspace_v2_gates import app, gw  # noqa: F401 — pytest fixtures
from engine.api import _period_move as PM
from engine.api import _staged_rerun as SR
from engine.api import pipeline as P

# ── THE EXPECTED VALUES, stated here — never read from the code under test ──

#: The envelope key a staged row's marker lives under, and the select term
#: that reads it alone.
MARKER_KEY = "staged_rerun"
MARKER_SELECT = "staged_rerun:assembled_canonical_v1->staged_rerun"

STRANDED_PID = "57a6ed00-0000-4000-8000-0000000057a6"    # a staged row a dead run left
ORG = W.ORG


# ══════════════════════════════════════════════════════════════════════
# The worlds
# ══════════════════════════════════════════════════════════════════════


def _enforce_the_unique_period_tuple(gw, monkeypatch) -> List[str]:
    """Production's `unique (org_id, period_end, source_document_id)`, which
    the double does not model: a write that would leave two rows with one
    NON-NULL tuple is refused (and undone), as Postgres refuses it. Two rows
    that name NO source are distinct, as NULLs are. Returns the refusals."""
    db = gw.db
    refused = []  # type: List[str]

    def violation() -> Optional[str]:
        seen = {}  # type: Dict[Any, str]
        for r in db.rows("financial_periods"):
            if r.get("source_document_id") is None:
                continue
            key = (str(r["org_id"]), str(r["period_end"])[:10], str(r["source_document_id"]))
            if key in seen:
                return "%s and %s share %r" % (seen[key], r["id"], key)
            seen[key] = str(r["id"])
        return None

    for op in ("insert", "update", "upsert"):
        real = getattr(db, op)

        def call(table: str, *args: Any, _real: Any = real, _op: str = op, **kwargs: Any) -> Any:
            if table != "financial_periods":
                return _real(table, *args, **kwargs)
            before = copy.deepcopy(db.tables.get("financial_periods") or [])
            out = _real(table, *args, **kwargs)
            broken = violation()
            if broken:
                db.tables["financial_periods"] = before
                refused.append("%s: %s" % (_op, broken))
                raise RuntimeError("duplicate key value violates unique constraint "
                                   "(org_id, period_end, source_document_id)")
            return out

        monkeypatch.setattr(db, op, call)
    return refused


def _marker(document_id: str, served_period_id: str, *, staged_at: Optional[str] = None,
            **more: Any) -> Dict[str, Any]:
    return dict({"document_id": document_id, "served_period_id": served_period_id,
                 "staged_at": staged_at or P._now_iso()}, **more)


def _plant_a_staged_row(gw, w: Dict[str, Any], *, staged_id: str = STRANDED_PID,
                        period_end: Optional[str] = None, **marker: Any) -> Dict[str, Any]:
    """A staged row as a dead re-run of `w["doc1"]` left it: the month's own
    row copied under another id, naming NO source, the marker in its
    envelope — and the NEWEST row of the month by `updated_at`."""
    (served,) = [p for p in gw.db.rows("financial_periods") if p["id"] == w["month"]]
    row = copy.deepcopy(served)
    envelope = dict(row.get("assembled_canonical_v1") or {})
    envelope[MARKER_KEY] = _marker(w["doc1"], w["month"], **marker)
    row.update({"id": staged_id, "source_document_id": None, "assembled_canonical_v1": envelope,
                "updated_at": "2099-01-01T00:00:00+00:00"})
    if period_end:
        row.update({"period_start": period_end, "period_end": period_end})
    return gw.db.add("financial_periods", row)


def _periods(gw, org_id: str) -> Dict[str, Dict[str, Any]]:
    return dict((str(p["id"]), p) for p in gw.db.rows("financial_periods") if p["org_id"] == org_id)


# ══════════════════════════════════════════════════════════════════════
# The marker itself
# ══════════════════════════════════════════════════════════════════════


def test_the_marker_is_read_from_a_source_less_row_alone():
    """The key and the select term are what this file states; a row that
    NAMES a source is never a staged row, whatever its envelope carries."""
    assert (SR.MARKER_KEY, SR.MARKER_SELECT) == (MARKER_KEY, MARKER_SELECT)
    marker = _marker("doc", "period")
    in_envelope = {"id": "p", "source_document_id": None, "assembled_canonical_v1": {MARKER_KEY: marker}}
    as_alias = {"id": "p", "source_document_id": None, MARKER_KEY: marker}
    assert SR.marker_of(in_envelope) == marker and SR.marker_of(as_alias) == marker
    for not_staged in (
            dict(in_envelope, source_document_id="doc"),          # a period that names its document
            dict(as_alias, source_document_id="doc"),
            {"id": "p", "source_document_id": None, "assembled_canonical_v1": None},   # an empty container
            {"id": "p", "source_document_id": None, "assembled_canonical_v1": {"canonical_bs": {}}},
            {"id": "p", "source_document_id": None, "assembled_canonical_v1": {MARKER_KEY: "not-a-marker"}},
            None, "a string", []):
        assert SR.marker_of(not_staged) is None, not_staged


# ══════════════════════════════════════════════════════════════════════
# S13 — the unique-tuple model is live; the audit, the move and the
#        ownership look ignore a staged row
# ══════════════════════════════════════════════════════════════════════


def test_the_unique_tuple_model_refuses_a_second_row_with_one_non_null_tuple(app, gw, monkeypatch):
    """POSITIVE CONTROL of every law in this file that says "the staged row
    does not collide with the month's own": the model does refuse a
    collision — and lets two source-less rows of one month stand."""
    w = O._own_month(app, gw, monkeypatch, [])
    refused = _enforce_the_unique_period_tuple(gw, monkeypatch)
    (served,) = copy.deepcopy(gw.db.rows("financial_periods"))
    twin = dict(served, id="another-row-of-the-same-tuple")
    with pytest.raises(RuntimeError):
        gw.db.insert("financial_periods", twin)
    assert refused and [p["id"] for p in gw.db.rows("financial_periods")] == [w["month"]]
    # Re-pointing a row AT a tuple another row holds is refused too.
    gw.db.insert("financial_periods", dict(twin, source_document_id=None))
    with pytest.raises(RuntimeError):
        gw.db.update("financial_periods", {"source_document_id": w["doc1"]},
                     filters={"id": "eq.another-row-of-the-same-tuple"})
    # Two rows of one month that name NO source are distinct (NULLs are).
    gw.db.insert("financial_periods", dict(twin, id="a-third-row", source_document_id=None))
    assert sorted(p["id"] for p in gw.db.rows("financial_periods") if p["source_document_id"] is None) == [
        "a-third-row", "another-row-of-the-same-tuple"]


def test_the_orphan_audit_and_a_moves_destination_ignore_a_staged_row(app, gw, monkeypatch):
    """A staged row carries an envelope and line items and has no document
    attached — by design. The audit a move runs must not report it as "a
    period nobody backs", and a move must never name it as the destination
    (it is about to stop existing)."""
    w = O._own_month(app, gw, monkeypatch, [])
    assert PM.find_orphaned_snapshots(gw.db, org_id=w["org"]) == []
    # … a re-run of this document that re-filed it under December 2024, dead.
    _plant_a_staged_row(gw, w, period_end="2024-12-31")
    assert PM.find_orphaned_snapshots(gw.db, org_id=w["org"]) == [], \
        "the audit reports a re-run's staged row as an orphaned period"
    # POSITIVE CONTROL: the same row WITHOUT the marker is what the audit is for.
    (stranded,) = [p for p in gw.db.rows("financial_periods") if p["id"] == STRANDED_PID]
    marker = stranded["assembled_canonical_v1"].pop(MARKER_KEY)
    assert [f["period_id"] for f in PM.find_orphaned_snapshots(gw.db, org_id=w["org"])] == [STRANDED_PID]
    stranded["assembled_canonical_v1"][MARKER_KEY] = marker

    (row,) = copy.deepcopy(gw.docs(id=w["doc1"]))
    record = PM.move_document_to_period(gw.db, document=row, target_period_end="2024-12", now=P._now_iso())

    assert record["moved"] is True and record["to"] == {"period_end": "2024-12-31", "period_id": None}, (
        "the move names a re-run's staged row as its destination: %r" % (record["to"],))
    assert record["orphaned_after"] == [], record["orphaned_after"]


def test_a_staged_row_is_never_a_documents_own_period(app, gw, monkeypatch):
    """`documents.period_id` is browser-written. Pinned to a staged row —
    whose envelope carries the provenance stamp of the very document it was
    built from — the document's re-run is refused, like every pin that is
    not provably its own period, and nothing is written."""
    w = O._own_month(app, gw, monkeypatch, [])
    _plant_a_staged_row(gw, w)
    (stranded,) = [p for p in gw.db.rows("financial_periods") if p["id"] == STRANDED_PID]
    assert stranded["assembled_canonical_v1"]["provenance"]["source_document_id"] == w["doc1"]
    (d1,) = gw.docs(id=w["doc1"])
    d1["period_id"] = STRANDED_PID                   # what a browser can write
    state_before, enqueued_before = gw.state(), list(gw.enqueued)
    spy = W._Spy(gw.db, monkeypatch)

    r = O._retry(app, w["org"], w["doc1"])

    assert r.status_code == 409 and r.json() == O.REFUSED_NOT_OWN, (r.status_code, r.text[:300])
    assert spy.writes == [] and gw.state() == state_before, spy.writes
    O._nothing_was_started(gw, w["doc1"], enqueued_before)
    # CONTROL: with the marker gone the row is a legacy source-less period
    # whose analysis names this document — the re-run is accepted.
    stranded["assembled_canonical_v1"].pop(MARKER_KEY)
    assert O._retry(app, w["org"], w["doc1"]).status_code == 202


# ══════════════════════════════════════════════════════════════════════
# S11 — a stranded staged row is never "the month"
# ══════════════════════════════════════════════════════════════════════


def test_an_upload_takes_over_the_served_row_never_a_stranded_staged_row(app, gw, monkeypatch):
    """A re-run died and left its staged row — the NEWEST row of the month.
    The same company's December uploaded again must stage beside the month's
    OWN row and take THAT over: the month serves the new file, the first
    file is archived, and the stranded row is neither adopted nor named.
    (Read as "the month", the stranded row became the upload's period and
    the month's own row stayed beside it: two rows for one month, the old
    file still served.)"""
    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B)])
    _enforce_the_unique_period_tuple(gw, monkeypatch)
    _plant_a_staged_row(gw, w)
    spy = W._Spy(gw.db, monkeypatch)

    doc2 = W._reupload(app, gw, w["org"])

    assert doc2["status"] == "analyzed" and doc2["period_id"] == w["month"], (
        doc2["status"], doc2.get("error"), doc2["period_id"])
    periods = _periods(gw, w["org"])
    assert periods[w["month"]]["source_document_id"] == doc2["id"], periods[w["month"]]["source_document_id"]
    assert [p for p in periods.values() if p["source_document_id"] is not None] == [periods[w["month"]]], (
        "more than one row of the month names a document: %r"
        % [(p["id"], p["source_document_id"]) for p in periods.values()])
    assert MARKER_KEY not in (periods[w["month"]]["assembled_canonical_v1"] or {})
    (d1,) = gw.docs(id=w["doc1"])
    assert d1["deleted_at"] is not None and str(d1["error"]).startswith("superseded_by:"), d1
    # The stranded row: never pinned to, never given a source, never written.
    assert [d["id"] for d in gw.db.rows("documents") if d.get("period_id") == STRANDED_PID] == []
    named = [x for x in spy.writes
             if x["op"] != "delete" and STRANDED_PID in repr([x["payload"], x["filters"]])]
    assert named == [], "the upload wrote into / onto the stranded staged row: %r" % named
    if STRANDED_PID in periods:
        assert periods[STRANDED_PID]["source_document_id"] is None
    body = W._served_period(app, w["org"], w["month"])
    assert body["briefing"]["body"] == W.BODY_B and body["period"]["source_document"]["id"] == doc2["id"]


# ══════════════════════════════════════════════════════════════════════
# S12 — the monthly inventory-days basis ignores a staged row
# ══════════════════════════════════════════════════════════════════════

_MONTH_ENDS = ["2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30", "2025-05-31", "2025-06-30",
               "2025-07-31", "2025-08-31", "2025-09-30", "2025-10-31", "2025-11-30", "2025-12-31"]


def _inventory_block(month: int, closing: float) -> Dict[str, Any]:
    """A served inventory-days block of one month, as `stage_persist` stores
    it in the envelope — the shape `monthly_points_from_periods` reads."""
    def stock(value: float) -> Dict[str, Any]:
        return {"opening": 100.0 if month == 1 else None, "closing": value}

    return {"schema": "inventory_days/1", "reconciliation": {"status": "reconciled"},
            "groups": [{"key": "materials", "stock": stock(closing)}],
            "other": {"key": "other", "stock": stock(0.0)}}


def _twelve_months() -> W.RecordingDouble:
    double = W.RecordingDouble(every_table=True)
    for i, end in enumerate(_MONTH_ENDS):
        double.add("financial_periods", {
            "id": "month-%02d" % (i + 1), "org_id": ORG, "currency": "RON",
            "source_document_id": "doc-of-month-%02d" % (i + 1), "period_start": end, "period_end": end,
            "assembled_canonical_v1": {"inventory_days": _inventory_block(i + 1, 110.0 + i)}})
    return double


def test_the_monthly_inventory_basis_ignores_a_staged_row():
    """Twelve month-ends of one fiscal year yield the 13 points of the
    monthly average. A re-run of December's document is in flight (or died):
    its staged row is a second `financial_periods` row for December — read
    as a period, the month was "ambiguous" and December's basis silently
    fell from the monthly average to the year-end snapshot."""
    december = {"org_id": ORG, "period_end": "2025-12-31"}
    double = _twelve_months()
    points = P._monthly_inventory_points(double, december)
    assert points == {"materials": [100.0] + [110.0 + i for i in range(12)], "other": [100.0] + [0.0] * 12}

    double.add("financial_periods", {
        "id": STRANDED_PID, "org_id": ORG, "currency": "RON", "source_document_id": None,
        "period_start": "2025-12-31", "period_end": "2025-12-31",
        "assembled_canonical_v1": {"inventory_days": _inventory_block(12, 999.0),
                                   MARKER_KEY: _marker("doc-of-month-12", "month-12")}})
    assert P._monthly_inventory_points(double, december) == points, \
        "a staged row changed the month's inventory-days basis"

    # POSITIVE CONTROL: a REAL second period for December (no marker) is the
    # ambiguity the reader refuses — the guard is about the marker alone.
    double.update("financial_periods", {"assembled_canonical_v1": {"inventory_days": _inventory_block(12, 999.0)}},
                  filters={"id": "eq.%s" % STRANDED_PID})
    assert P._monthly_inventory_points(double, december) is None
