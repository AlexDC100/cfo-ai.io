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

THE LAW (S9 is O6 of test_rerun_ownership.py; S22 — "an UPLOAD's takeover
is unchanged" — is the G4 laws of test_workspace_v2_gates.py and the
re-upload laws of the writers file, which run unmodified).

  The mechanism, through the REAL route and the REAL run:
  S1  A re-run whose narration FAILS: one staged row is inserted (no source,
      the marker), the document is never pinned to it and never re-statused,
      no statement touches the month before the commit point; then the
      month's statements ARE the run's (new line items and metrics, alerts
      keyed to the MONTH), on the SAME period id, its envelope without the
      marker; the briefing and the recommendations are the SAME rows; the
      locked industry still hangs on the period; the cached benchmark report
      is cleared; the unique (org, month, document) tuple is never violated.
  S2  …whose narration WORKS: the new briefing and recommendations.
  S3  The run fails in ANY stage up to its commit point (twelve places):
      the month is exactly what it was — row, rows under it (same ids),
      what a reader is served; no staged row is left; the document is not
      re-statused and ends `analyzed` with `rerun_failed: …` on its row.
      S21 — the withdrawn in-place design stays withdrawn — is S3's cells
      past the persist: the month's line items and metrics are the OLD ids.
  S4  A narrative write the database refuses: only what the run STORED
      replaces the month's (`write_refused` on a kept briefing).
  S5  The run's last status write times out AFTER the takeover: analysed.
  S6  A second click while the run is in flight starts nothing; a hand-off
      that fails leaves no note of a staged re-run.
  S7  A re-run that reads the file as another month which ANOTHER document
      holds is refused (`rerun_month_taken`); both months are identical.
  S8  Overtaken by a newer upload — before the run executes, or in the
      middle of it: the month is the newer document's exactly; the archived
      document keeps the marker naming its replacement.
  S10 The document deleted for good takes its staged rows with it (both
      routes; a committed row too); a document or period deleted MID-RUN is
      never resurrected.
      A re-run is not started over an interrupted takeover that cannot be
      completed (503 `rerun_unavailable`).

  The readers' side — a staged row is never a month:
  S11 another upload stages beside the SERVED row and takes THAT over;
  S12 the monthly inventory-days basis ignores a staged row;
  S13 the orphan audit, a move's destination and the ownership look ignore
      it; the unique-tuple model these worlds enforce is live (control).

  The takeover's rerun mode and the resume, at their own seam — the REAL
  functions over a recording double, the process killed after EVERY write in
  turn, four variants (the narration worked / failed / the run stored
  nothing in three tables / the re-run re-filed the document):
  S15 THE COMMIT POINT: staged-only deletes, then the marker gains
      `takeover_began_at` (+ why a kept briefing is stale, + the tables the
      run stored nothing in), then the document's row says `interrupted`,
      then the first statement on the month; the staged row's delete LAST.
  ·   Killed BEFORE the commit point: dropped, the month untouched.
  S16 Killed AFTER it: RESUMED to exactly the uninterrupted result — and a
      resume killed itself is resumed again.
  S17 Nothing to resume ONTO (the month cleared, another document's, the
      document gone): dropped, nothing moved.
  S18 The failure handler: a failed staged re-run is said on the row, never
      by its status, never over an archived copy's marker; a write refused
      inside the apply is completed by the handler's own resume; refused
      again, the committed row is LEFT and the row says `interrupted`.
  S14 The company pass (every `stage_persist` of the company): only rows of
      runs that are dead — never one whose document is in flight here
      (unless the pass is that document's own run); a COMMITTED row resumed
      at once, an uncommitted one dropped once it is fifteen minutes old or
      its document is gone. Never raises.
  S19 A first analysis pays ONE light read for it and no write.
  S20 Censuses: no `_RERUN_CARRY` (nor its helpers) in the engine;
      `recommendations` are inserted in the narrative stage only;
      `_STAGED_RERUNS` is reset per test; the codes a row can carry are the
      literals the Docs panel holds.

WHAT RUNS HERE. The `gw` world of test_workspace_v2_gates (the real routes,
the real `_run_pipeline_sync`, the PostgREST double) with the helpers of the
writers file of gate briefing-keep-last-good and of test_rerun_ownership;
seam laws on the writers file's `RecordingDouble`.

THREE THINGS THE DOUBLE DOES NOT MODEL ARE MODELLED BY HAND:
  · a period's children going with it and `documents.period_id` set NULL
    when its period is deleted (`test_rerun_ownership._production_foreign_keys`);
  · production's `unique (org_id, period_end, source_document_id)`
    (schema.sql; NULLs distinct): `_enforce_the_unique_period_tuple` refuses
    a write that would leave two rows with one NON-NULL tuple;
  · the foreign key on INSERT, where a law needs it (`_refuse_children_of_a_
    missing_period`).

  THE REVIEW OF 2026-10-05 (the end of this file) — what the three stages
  left unheld, each measured on the stage-3 tip first:
  S23 ONE takeover of a company's months at a time: two REAL threads — a
      newer upload's takeover waits at the door while a re-run is inside its
      apply, then takes over a month that is whole.
  S24 The marker is browser-writable: a committed marker forged in one
      company never reaches another company's month (every way a staged row
      is cleaned up, both directions); the applier's reads name the company.
  S25 A run settles its OWN document's leftover before it writes (an
      in-place run was later resumed OVER by an older re-run's row); when
      that cannot be done, it stops before writing.
  S26 An apply never re-dates its row onto a month that became another
      row's (two live periods for one month).
  S27 A staged re-run's alerts replace the month's where the legacy unique
      (org_id, alert_key) is still on `alerts` — keyed to the staged row
      while the run goes, re-keyed to the month by the takeover.
  S28 Five ways to weaken the mechanism that every law let through: one
      document's cleanup touching another's staged row; a re-run started
      although its leftovers could not be listed; the handler saying "the
      previous analysis is still served" over an interrupted takeover it
      cannot read; the month check gone from the mint; T0 accepting any
      period of the document's.
  S29 The page-mount watchdog completes an interrupted re-run of the
      caller's own company — and of nobody else's.
  S30 The month's row takes the run's columns only while it still names the
      document: changed hands mid-apply (a second process), nothing more is
      written and no marker is erased.

THE MARKER'S KEY AND SHAPE AND THE STORED CODES ARE WRITTEN OUT HERE
(`MARKER_KEY`, `INTERRUPTED`, …), never read from the code under test.

WHAT THESE RED ON, with the defect repaired (TC-11):
  · the reset coming back, or anything of the month written, deleted or
    re-statused before the commit point;
  · the document pinned to the staged row; the staged row naming a source;
    the marker reaching the month's envelope; alerts keyed to the staged id;
  · a failed run leaving a staged row, re-statusing the document, or
    writing over a superseded / duplicate marker;
  · a committed staged row DROPPED (the measured loss: the month's briefing
    deleted, the run's own under the staged id) — by the cleanup, by the
    handler, by the company pass; an uncommitted row APPLIED;
  · the commit marker written after the month was touched, or not at all;
  · a resume that leaves old rows in a table the run stored nothing in,
    clears an error that is not a re-run's, or writes into a month that is
    gone or another document's;
  · a takeover that does not look at ownership again, or re-dates its row
    onto a month another document holds;
  · the company pass dropping a row of a run that may be alive;
  · a staged row taken for a month by the persist lookup, the inventory
    basis, the orphan audit, a move, or the ownership look;
  · the cached benchmark report surviving a takeover;
  · the carry — or anything held in process memory across a re-run — back.

CANNOT SEE.
  · Postgres itself: NULL semantics of the unique constraint (modelled),
    cascades (modelled), PostgREST's parsing of the json-path select, row
    security, realtime; whether production's `financial_periods` accepts a
    second source-less row for a month (the owner's read-only check).
  · Two backend PROCESSES alive at once (the takeover lock and in-flight
    are per process): a second process's pass can resume a committed row
    under a live apply of the first. The guarded table loop and S30 narrow
    what the two can do to each other; only one transaction excludes it.
    (Two THREADS of one process — production's model — are held by S23.)
  · A kill INSIDE one HTTP statement; the takeover as ONE transaction — the
    window between the commit point and the end of the apply is observable
    (tests/engine/test_rerun_restart.py records what is served there).
  · The readers that are NOT guarded against a staged row: forecast history,
    the sector benchmark's prior period, the Capsule tools, the firm lists —
    and `empty_live_periods` / scripts/check_no_empty_periods.py, which
    REPORT a stranded staged row as a period with no source document until
    it is cleaned up (asserted as such in the restart laws).
  · The AI lane (its own file of this gate: test_rerun_ai_lane.py),
    move-period filing a document under a month another document holds
    (the user's explicit command; staged, replaced only on success — G4),
    the browser after a re-run.
  · Whether production's `alerts` still carries the legacy unique key (S27
    models it by hand; with or without it the laws hold).

PLANT LOG: docs/engine_book/gates.md "rerun-data-loss".
"""
from __future__ import annotations

import ast
import copy
import json
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


# ══════════════════════════════════════════════════════════════════════
# The takeover's RERUN MODE and the resume — at their own seam
# ══════════════════════════════════════════════════════════════════════
#
# The takeover is a sequence of statements, not a transaction. These laws
# drive the REAL `_finalize_same_month_takeover` and the REAL cleanup over a
# recording double and kill the process after EVERY write in turn.

DOC_ID = W.DOC_ID
PID = W.PID                         # the month's own row — DOC_ID's analysis
STAGED = W.STAGED_PID               # the staged row of a re-run of DOC_ID
OTHER_ORG, OTHER_PID = W.OTHER_ORG, W.OTHER_PID

#: The neutral codes written out (`documents.error` of a re-run that did not
#: finish; frontend/lib/rerunRefusals.ts holds the same).
RERUN_FAILED_PREFIX = "rerun_failed: "
INTERRUPTED = "rerun_failed: interrupted_replacing"

#: Every table a run persists under a period id.
_RUN_TABLES = ("statement_line_items", "calculated_metrics", "alerts", "recommendations",
               "briefings", "valuations")
_SEAM_TABLES = _RUN_TABLES + ("financial_periods", "documents", "benchmark_reports")


class _Kill(BaseException):
    """The process dies here (never caught by `except Exception`)."""


class _KillingDouble(W.RecordingDouble):
    """`RecordingDouble` whose process dies right AFTER its Nth write was
    stored (counted from `arm()`), or whose database REFUSES that write
    (`refuse=True`: the write is not performed and raises like a timeout)."""

    def __init__(self, **kwargs: Any) -> None:
        super(_KillingDouble, self).__init__(**kwargs)
        self.at = None  # type: Optional[int]
        self.refuse = False
        self.seen = 0
        self.fired = False

    def arm(self, at: Optional[int], *, refuse: bool = False) -> None:
        self.at, self.refuse, self.seen, self.fired = at, refuse, 0, False

    def _due(self) -> bool:
        if self.at is None or self.fired:
            return False
        self.seen += 1
        if self.seen == self.at:
            self.fired = True
            return True
        return False

    def _write(self, op: str, table: str, *args: Any, **kwargs: Any) -> Any:
        due = self._due()
        if due and self.refuse:
            import httpx
            raise httpx.ReadTimeout("The read operation timed out")
        out = getattr(super(_KillingDouble, self), op)(table, *args, **kwargs)
        if due:
            raise _Kill("killed after write #%d (%s %s)" % (self.at, op, table))
        return out

    def insert(self, table: str, rows: Any, *, returning: bool = True) -> Any:
        return self._write("insert", table, rows, returning=returning)

    def upsert(self, table: str, rows: Any, *, on_conflict: Optional[str] = None, returning: bool = True) -> Any:
        return self._write("upsert", table, rows, on_conflict=on_conflict, returning=returning)

    def update(self, table: str, patch: Dict[str, Any], *, filters: Dict[str, str]) -> Any:
        return self._write("update", table, patch, filters=filters)

    def delete(self, table: str, *, filters: Dict[str, str]) -> Any:
        return self._write("delete", table, filters=filters)


#: variant -> (the run's narration, what the call tells the takeover).
_SEAM_VARIANTS = {
    # The narration worked: everything of the month is replaced.
    "the_narration_worked": dict(),
    # The narration failed: the month's briefing and recommendations are KEPT
    # (the briefing marked stale), its statements and alerts replaced.
    "the_narration_failed": dict(narration_unavailable="provider_error"),
    # The run stored NOTHING in three tables (no alert fired, the narration
    # recommended nothing, the valuation failed): the month's rows there go.
    "the_run_stored_nothing_in_three_tables": dict(),
    # The re-run read the file as December 2024: the row is re-dated.
    "the_rerun_refiled_the_document": dict(),
}  # type: Dict[str, Dict[str, Any]]


def _seam_world(variant: str, *, document_error: Optional[str] = None) -> _KillingDouble:
    """The month (PID) — DOC_ID's own analysis: line items, metrics, a
    valuation, alerts, its usable briefing, two worked recommendations, a
    cached benchmark report — and beside it the STAGED row of a re-run of
    DOC_ID with what that run stored. Another tenant's rows stand beside."""
    failed = variant == "the_narration_failed"
    nothing = variant == "the_run_stored_nothing_in_three_tables"
    staged_month = "2024-12-31" if variant == "the_rerun_refiled_the_document" else "2025-12-31"
    d = _KillingDouble(every_table=True)
    d.add("financial_periods", {
        "id": PID, "org_id": ORG, "source_document_id": DOC_ID, "currency": "RON",
        "period_start": "2025-12-01", "period_end": "2025-12-31", "extraction_confidence": 0.5,
        "created_at": "2026-09-01T09:00:00+00:00", "updated_at": "2026-09-01T09:00:00+00:00",
        "methodology_version": "the-first-runs", "detection_envelope": {"run": "first"},
        "assembled_canonical_v1": {"canonical_bs": {"run": "first"},
                                   "provenance": {"source_document_id": DOC_ID}}})
    d.add("financial_periods", {
        "id": STAGED, "org_id": ORG, "source_document_id": None, "currency": "RON",
        "period_start": staged_month, "period_end": staged_month, "extraction_confidence": 0.9,
        "created_at": "2026-10-04T10:00:00+00:00", "updated_at": "2026-10-04T10:00:05+00:00",
        "methodology_version": "the-reruns", "detection_envelope": {"run": "rerun"},
        "assembled_canonical_v1": {"canonical_bs": {"run": "rerun"},
                                   "provenance": {"source_document_id": DOC_ID},
                                   MARKER_KEY: _marker(DOC_ID, PID, staged_at="2026-10-04T10:00:00+00:00")}})
    d.add("financial_periods", {"id": OTHER_PID, "org_id": OTHER_ORG, "currency": "RON",
                                "source_document_id": "doc-of-the-other-tenant",
                                "period_start": "2025-12-31", "period_end": "2025-12-31"})
    d.add("documents", {"id": DOC_ID, "org_id": ORG, "status": "analyzed", "period_id": PID,
                        "deleted_at": None, "error": document_error, "scope": "financial"})
    for period_id, n, tag in ((PID, 2, "first"), (STAGED, 3, "rerun")):
        for i in range(n):
            d.add("statement_line_items", {"id": "li-%s-%d" % (tag, i), "period_id": period_id, "statement": "pl",
                                           "bucket": "revenue", "ro_account_code": "70%d" % i, "amount": float(i)})
            d.add("calculated_metrics", {"id": "metric-%s-%d" % (tag, i), "period_id": period_id, "org_id": ORG,
                                         "name": "metric_%d" % i, "value": float(i), "unit": "RON",
                                         "direction": "higher"})
    d.add("valuations", {"id": "valuation-first", "period_id": PID, "org_id": ORG})
    for key in ("cash_ratio_low", "leverage_high"):
        d.add("alerts", {"id": "alert-first-%s" % key, "org_id": ORG, "period_id": PID,
                         "alert_key": "%s:%s" % (key, PID), "severity": "high", "category": "liquidity",
                         "title": key, "body": "…", "document_id": DOC_ID})
    if not nothing:
        d.add("valuations", {"id": "valuation-rerun", "period_id": STAGED, "org_id": ORG})
        # (keyed to the row it is STORED under — the staged one — as the run
        # writes it; the takeover re-keys it to the month once it sits there)
        d.add("alerts", {"id": "alert-rerun", "org_id": ORG, "period_id": STAGED,
                         "alert_key": "margin_thin:%s" % STAGED, "severity": "high", "category": "margin",
                         "title": "margin_thin", "body": "…", "document_id": DOC_ID})
    d.add("briefings", {"id": "briefing-of-the-month", "period_id": PID, "org_id": ORG, "body": W.GOOD_BODY,
                        "language": "ro", "model": "the-model-of-the-stored-write",
                        "ebitda_definition": W.CURRENT_DEFINITION})
    d.add("briefings", {"id": "briefing-of-the-rerun", "period_id": STAGED, "org_id": ORG,
                        "body": W.SENTINEL if failed else W.NEW_BODY, "language": "ro",
                        "model": "the-model-of-the-rerun", "ebitda_definition": W.CURRENT_DEFINITION})
    for rec_id, status in (("rec-1", "in_progress"), ("rec-2", "new")):
        d.add("recommendations", {"id": rec_id, "org_id": ORG, "period_id": PID, "target_type": "dataset",
                                  "target_id": PID, "title": rec_id, "explanation": "…", "urgency": "high",
                                  "status": status, "owner": "CFO", "due_date": "2026-11-15"})
    if not failed and not nothing:
        d.add("recommendations", {"id": "rec-of-the-rerun", "org_id": ORG, "period_id": STAGED,
                                  "target_type": "dataset", "target_id": STAGED, "title": W.NEW_RECOMMENDATION,
                                  "explanation": "…", "urgency": "high", "status": "new"})
    d.add("benchmark_reports", {"id": "report-of-the-month", "period_id": PID, "org_id": ORG,
                                "caen_code": "1011", "report_data": {"run": "first"}})
    # the other tenant
    d.add("briefings", {"id": "briefing-of-the-other-tenant", "period_id": OTHER_PID, "org_id": OTHER_ORG,
                        "body": "The other tenant's briefing.", "language": "en"})
    d.add("recommendations", {"id": "rec-of-the-other-tenant", "org_id": OTHER_ORG, "period_id": OTHER_PID,
                              "target_type": "dataset", "target_id": OTHER_PID, "title": "Theirs",
                              "explanation": "Theirs.", "urgency": "low", "status": "new"})
    d.add("alerts", {"id": "alert-of-the-other-tenant", "org_id": OTHER_ORG, "period_id": OTHER_PID,
                     "alert_key": "cash_ratio_low:%s" % OTHER_PID, "severity": "high", "category": "liquidity",
                     "title": "Theirs", "body": "Theirs.", "document_id": "doc-of-the-other-tenant"})
    d.add("benchmark_reports", {"id": "report-of-the-other-tenant", "period_id": OTHER_PID, "org_id": OTHER_ORG,
                                "caen_code": "1011", "report_data": {"theirs": True}})
    d.writes[:] = []
    return d


def _staged_takeover(double: _KillingDouble, variant: str) -> str:
    """The REAL `_finalize_same_month_takeover`, called as the orchestrator
    calls it for a staged re-run."""
    P._record_takeover(DOC_ID, staged=STAGED, served=PID, superseded_document=None, rerun=True)
    try:
        with RA.installed(double):
            return P._finalize_same_month_takeover({"id": DOC_ID, "org_id": ORG}, STAGED,
                                                   **_SEAM_VARIANTS[variant])
    finally:
        P._pop_takeover(DOC_ID)


#: Columns that hold "when", not "what".
_CLOCKS = {"financial_periods": ("updated_at",), "briefings": ("stale_since",)}


def _state(double: W.RecordingDouble) -> Dict[str, List[Dict[str, Any]]]:
    """Everything stored, the clocks aside (a clock that is SET stays
    visible as set)."""
    out = {}  # type: Dict[str, List[Dict[str, Any]]]
    for table in _SEAM_TABLES:
        rows = []
        for r in copy.deepcopy(double.rows(table)):
            for clock in _CLOCKS.get(table, ()):
                if r.get(clock) is not None:
                    r[clock] = "<set>"
            rows.append(r)
        out[table] = sorted(rows, key=lambda r: str(r.get("id")))
    return out


def _month_of(state: Dict[str, List[Dict[str, Any]]]) -> Dict[str, List[Dict[str, Any]]]:
    """What a reader of the MONTH is served from: its row, its document and
    every row under its id."""
    out = dict((t, [r for r in state[t] if r.get("period_id") == PID]) for t in _RUN_TABLES + ("benchmark_reports",))
    out["financial_periods"] = [r for r in state["financial_periods"] if r["id"] == PID]
    out["documents"] = state["documents"]
    return out


def _commit_index(double: W.RecordingDouble) -> int:
    """The 1-based index of THE COMMIT WRITE among `double.writes`: the
    update of the staged row whose marker gains `takeover_began_at`."""
    hits = [i + 1 for i, w in enumerate(double.writes)
            if w["op"] == "update" and w["table"] == "financial_periods"
            and w["filters"].get("id") == "eq.%s" % STAGED
            and ((w["payload"] or {}).get("assembled_canonical_v1") or {}).get(MARKER_KEY, {}).get("takeover_began_at")]
    assert len(hits) == 1, "expected ONE commit write on the staged row, saw %r" % hits
    return hits[0]


def _names_the_month(write: Dict[str, Any]) -> bool:
    payload = write["payload"] if isinstance(write["payload"], dict) else {}
    return ("eq.%s" % PID in (write["filters"] or {}).values()) or payload.get("period_id") == PID


def _uninterrupted(variant: str) -> _KillingDouble:
    double = _seam_world(variant)
    assert _staged_takeover(double, variant) == PID
    return double


@pytest.mark.parametrize("variant", sorted(_SEAM_VARIANTS))
def test_a_staged_takeover_replaces_its_own_months_analysis_and_leaves_nothing_behind(variant):
    """POSITIVE CONTROL of the kill laws below — the takeover, uninterrupted:
    ONE row for the month, the same id, still naming the document; the run's
    statements under it; the staged row and everything under its id gone;
    the envelope WITHOUT the marker; the cached benchmark report cleared;
    the document pinned, analysed, no marker; nobody archived."""
    before = _state(_seam_world(variant))
    double = _uninterrupted(variant)
    after = _state(double)
    (month,) = [p for p in after["financial_periods"] if p["org_id"] == ORG]
    assert month["id"] == PID and month["source_document_id"] == DOC_ID, month
    assert month["assembled_canonical_v1"] == {"canonical_bs": {"run": "rerun"},
                                               "provenance": {"source_document_id": DOC_ID}}, (
        "the month's envelope is not the run's, or the marker rode along: %r" % month["assembled_canonical_v1"])
    assert (month["methodology_version"], month["detection_envelope"], month["extraction_confidence"]) == \
        ("the-reruns", {"run": "rerun"}, 0.9), month
    assert month["created_at"] == "2026-09-01T09:00:00+00:00"            # the row's identity
    refiled = variant == "the_rerun_refiled_the_document"
    assert (month["period_start"], month["period_end"]) == (
        ("2024-12-31", "2024-12-31") if refiled else ("2025-12-01", "2025-12-31")), month
    for table in _RUN_TABLES:
        assert [r for r in after[table] if r.get("period_id") == STAGED] == [], "%s left under the staged id" % table
    assert sorted(r["id"] for r in after["statement_line_items"]) == ["li-rerun-0", "li-rerun-1", "li-rerun-2"]
    assert sorted(r["id"] for r in after["calculated_metrics"]) == ["metric-rerun-0", "metric-rerun-1", "metric-rerun-2"]
    mine = lambda table: sorted(r["id"] for r in after[table] if r["org_id"] == ORG)   # noqa: E731
    if variant == "the_narration_failed":
        # KEPT, where they were: the same rows, the briefing marked stale.
        (kept,) = [b for b in after["briefings"] if b["org_id"] == ORG]
        assert W._sans_marker(kept) == W._sans_marker(
            [b for b in before["briefings"] if b["id"] == "briefing-of-the-month"][0]), kept
        assert kept["stale_reason"] == "provider_error" and kept["stale_since"] == "<set>", kept
        assert [r for r in after["recommendations"] if r["org_id"] == ORG] == \
            [r for r in before["recommendations"] if r["period_id"] == PID]
        assert mine("alerts") == ["alert-rerun"] and mine("valuations") == ["valuation-rerun"]
    elif variant == "the_run_stored_nothing_in_three_tables":
        assert mine("briefings") == ["briefing-of-the-rerun"]
        assert mine("alerts") == [] and mine("recommendations") == [] and mine("valuations") == [], (
            "the month kept rows of a table the run stored nothing in: %r"
            % [mine(t) for t in ("alerts", "recommendations", "valuations")])
    else:
        assert mine("briefings") == ["briefing-of-the-rerun"] and mine("valuations") == ["valuation-rerun"]
        assert [(r["id"], r["period_id"], r["target_id"]) for r in after["recommendations"]
                if r["org_id"] == ORG] == [("rec-of-the-rerun", PID, PID)]
        assert mine("alerts") == ["alert-rerun"]
    # AN ALERT'S KEY NAMES THE PERIOD IT SITS ON: the run's alert, written
    # under a key that named the staged row, is re-keyed to the month.
    assert [a["alert_key"] for a in after["alerts"] if a["org_id"] == ORG] == (
        [] if variant == "the_run_stored_nothing_in_three_tables" else ["margin_thin:%s" % PID]), (
        "an alert that moved onto the month still names the staged row in its key: %r"
        % [a["alert_key"] for a in after["alerts"] if a["org_id"] == ORG])
    assert [r["id"] for r in after["benchmark_reports"]] == ["report-of-the-other-tenant"], (
        "the benchmark report cached for the month was not cleared (or another tenant's was)")
    assert after["documents"] == [dict(before["documents"][0], period_id=PID, status="analyzed", error=None)]
    # the other tenant: exactly what it was
    for table in ("briefings", "recommendations", "alerts"):
        assert [r for r in after[table] if r["org_id"] == OTHER_ORG] == \
            [r for r in before[table] if r["org_id"] == OTHER_ORG]


@pytest.mark.parametrize("variant", sorted(_SEAM_VARIANTS))
def test_the_commit_point_comes_after_the_staged_only_work_and_before_the_month(variant):
    """THE ORDER (S15): every delete that touches only the staged id, THEN
    the marker with `takeover_began_at` on the staged row, THEN the
    document's row saying the replacement was interrupted, THEN the first
    statement that touches the month. The marker records why a kept
    briefing is stale and which tables the run stored nothing in."""
    double = _uninterrupted(variant)
    writes = double.writes
    commit = _commit_index(double)
    marker = writes[commit - 1]["payload"]["assembled_canonical_v1"][MARKER_KEY]
    assert marker["document_id"] == DOC_ID and marker["served_period_id"] == PID, marker
    assert W._is_a_timestamp(marker["takeover_began_at"]) and marker["staged_at"] == "2026-10-04T10:00:00+00:00"
    assert marker["keep_briefing_reason"] == ("provider_error" if variant == "the_narration_failed" else None)
    assert marker["emptied"] == (["alerts", "recommendations", "valuations"]
                                 if variant == "the_run_stored_nothing_in_three_tables" else []), marker
    # … and which tables the month KEEPS its own rows of (never touched by the apply).
    assert marker["kept"] == (["recommendations", "briefings"]
                              if variant == "the_narration_failed" else []), marker
    # the commit write carries the run's envelope too — it is not replaced by the marker alone
    assert writes[commit - 1]["payload"]["assembled_canonical_v1"]["canonical_bs"] == {"run": "rerun"}
    assert writes[commit - 1]["filters"] == {"id": "eq.%s" % STAGED, "org_id": "eq.%s" % ORG}
    interrupted = writes[commit]
    assert (interrupted["op"], interrupted["table"], interrupted["payload"], interrupted["filters"]) == (
        "update", "documents", {"error": INTERRUPTED}, {"id": "eq.%s" % DOC_ID, "org_id": "eq.%s" % ORG}), interrupted
    before_commit, after_commit = writes[:commit - 1], writes[commit + 1:]
    touching = [(w["op"], w["table"], w["filters"]) for w in before_commit if _names_the_month(w)]
    assert touching == [], "a statement touched the month BEFORE the commit point: %r" % touching
    staged_only = [w for w in writes if w["op"] == "delete" and w["table"] in ("briefings", "recommendations", "alerts")
                   and w["filters"] == {"period_id": "eq.%s" % STAGED, "org_id": "eq.%s" % ORG}]
    assert all(writes.index(w) < commit - 1 for w in staged_only), "a staged-only delete came after the commit point"
    if variant == "the_narration_failed":
        assert [w["table"] for w in staged_only] == ["briefings", "recommendations"]
    assert after_commit and _names_the_month(after_commit[0]), after_commit[:1]
    # THE LAST WRITE is the staged row's delete — naming the row, its company
    # and "no source"; the document's write comes just before it.
    assert (writes[-1]["op"], writes[-1]["table"], writes[-1]["filters"]) == (
        "delete", "financial_periods",
        {"id": "eq.%s" % STAGED, "org_id": "eq.%s" % ORG, "source_document_id": "is.null"}), writes[-1]
    assert (writes[-2]["table"], writes[-2]["payload"]) == (
        "documents", {"period_id": PID, "status": "analyzed", "error": None}), writes[-2]


@pytest.mark.parametrize("variant", sorted(_SEAM_VARIANTS))
def test_a_takeover_killed_before_its_commit_point_is_dropped_and_the_month_is_what_it_was(variant):
    """The process dies after ANY write before the commit point: the month
    has not been touched. The cleanup DROPS the staged row and everything
    under it — an uncommitted row is never applied — and the month, its
    document and the other tenant are exactly what they were."""
    commit = _commit_index(_uninterrupted(variant))
    month_before = _month_of(_state(_seam_world(variant)))
    for k in range(0, commit):                      # 0 = dead before the takeover's first write
        double = _seam_world(variant)
        if k:
            double.arm(k)
            with pytest.raises(_Kill):
                _staged_takeover(double, variant)
        assert _month_of(_state(double)) == month_before, "killed after write #%d: the month was touched" % k
        foreign = [copy.deepcopy([r for r in double.rows(t) if r.get("org_id") == OTHER_ORG]) for t in _SEAM_TABLES]
        double.arm(None)

        out = P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID)

        assert (out["resumed"], out["dropped"], out["left"], out["unreadable"]) == (0, 1, 0, False), (k, out)
        state = _state(double)
        assert _month_of(state) == month_before, "killed after write #%d: the cleanup touched the month" % k
        assert [p["id"] for p in state["financial_periods"] if p["org_id"] == ORG] == [PID], k
        for table in _RUN_TABLES:
            assert [r for r in state[table] if r.get("period_id") == STAGED] == [], (k, table)
        assert foreign == [[r for r in double.rows(t) if r.get("org_id") == OTHER_ORG] for t in _SEAM_TABLES]


@pytest.mark.parametrize("variant", sorted(_SEAM_VARIANTS))
def test_a_takeover_killed_after_its_commit_point_is_resumed_to_the_same_result(variant):
    """THE RESUME (S16). The process dies after ANY write from the commit
    point on — between a table's delete and its move, between two tables,
    before the row's columns, before the document's write, before the staged
    row's delete. The cleanup never drops such a row: it completes the
    takeover, and what is stored is EXACTLY what the uninterrupted takeover
    stores (the clocks aside). Dropped instead (the design's first shape),
    the month lost its briefing or its recommendations for good."""
    whole = _uninterrupted(variant)
    expected, commit, total = _state(whole), _commit_index(whole), len(whole.writes)
    assert total - commit >= 8, "the scenario is too short to mean anything: %d writes after the commit" % (total - commit)
    for k in range(commit, total):
        double = _seam_world(variant)
        double.arm(k)
        with pytest.raises(_Kill):
            _staged_takeover(double, variant)
        (doc,) = double.rows("documents")
        if k > commit:
            # The reader is told at once: the row says the replacement was interrupted.
            assert doc["error"] in (INTERRUPTED, None) and (doc["error"] == INTERRUPTED or k == total - 1), (k, doc)
        double.arm(None)

        out = P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID)

        assert (out["resumed"], out["dropped"], out["left"]) == (1, 0, 0), (k, out)
        assert _state(double) == expected, "killed after write #%d of %d (%s): the resume did not reach the " \
            "uninterrupted takeover's result" % (k, total, whole.writes[k - 1]["table"])
        # … and a resume that is run AGAIN finds nothing to do.
        assert P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID) == {
            "resumed": 0, "dropped": 0, "left": 0, "unreadable": False, "left_documents": []}


def test_a_resume_interrupted_itself_is_resumed_again():
    """Every statement of the resume is safe to repeat: the process dies
    after ANY write of the resume too, and the next cleanup still reaches
    the uninterrupted takeover's result."""
    variant = "the_narration_worked"
    whole = _uninterrupted(variant)
    expected, commit = _state(whole), _commit_index(whole)
    probe = _seam_world(variant)
    probe.arm(commit + 2)                                    # dead between a table's delete and its move
    with pytest.raises(_Kill):
        _staged_takeover(probe, variant)
    probe.arm(None)
    probe.writes[:] = []
    P._clear_staged_rerun_rows(probe, ORG, document_id=DOC_ID)
    resume_writes = len(probe.writes)
    assert resume_writes >= 8, resume_writes
    for k in range(1, resume_writes):
        double = _seam_world(variant)
        double.arm(commit + 2)
        with pytest.raises(_Kill):
            _staged_takeover(double, variant)
        double.arm(k)
        with pytest.raises(_Kill):
            P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID)
        double.arm(None)
        out = P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID)
        assert (out["resumed"], out["left"]) == (1, 0), (k, out)
        assert _state(double) == expected, "the resume killed after its write #%d was not completed" % k


#: What happened to the month between the kill and the cleanup.
_NOTHING_TO_RESUME_ONTO = {
    # DELETE /api/period: the user cleared the month (its children cascade).
    "the_month_was_cleared": lambda d: [d.delete(t, filters={"period_id": "eq.%s" % PID}) for t in _RUN_TABLES]
    + [d.delete("financial_periods", filters={"id": "eq.%s" % PID})],
    # A newer upload's takeover: the month names another document now.
    "the_month_is_another_documents": lambda d: d.update(
        "financial_periods", {"source_document_id": "a-newer-upload"}, filters={"id": "eq.%s" % PID}),
    # The document was deleted for good.
    "the_document_is_gone": lambda d: d.delete("documents", filters={"id": "eq.%s" % DOC_ID}),
}


@pytest.mark.parametrize("what", sorted(_NOTHING_TO_RESUME_ONTO))
def test_a_resume_with_nothing_to_resume_onto_drops_and_moves_nothing(what):
    """S17. A committed row whose month was cleared by its user, taken over
    by a newer upload, or whose document is gone for good: the staged row is
    dropped with everything under it and NOTHING is moved — a month its user
    removed is never brought back, another document's month never written."""
    variant = "the_narration_worked"
    double = _seam_world(variant)
    double.arm(_commit_index(_uninterrupted(variant)))        # dead right after the commit write
    with pytest.raises(_Kill):
        _staged_takeover(double, variant)
    double.arm(None)
    _NOTHING_TO_RESUME_ONTO[what](double)
    month_before = _month_of(_state(double))
    double.writes[:] = []

    out = P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID)

    assert (out["resumed"], out["dropped"], out["left"]) == (0, 1, 0), out
    state = _state(double)
    assert _month_of(state) == month_before, "%s: the resume wrote into the month" % what
    assert [p["id"] for p in state["financial_periods"] if p["id"] == STAGED] == []
    for table in _RUN_TABLES:
        assert [r for r in state[table] if r.get("period_id") == STAGED] == [], table
    assert [w for w in double.writes if w["op"] != "delete"] == [], \
        "%s: the cleanup did more than delete: %r" % (what, [w for w in double.writes if w["op"] != "delete"])
    assert all("eq.%s" % PID not in w["filters"].values() for w in double.writes), double.writes


@pytest.mark.parametrize("error_on_the_row,cleared", [
    (INTERRUPTED, True),
    ("rerun_failed: RuntimeError: compute failed", True),     # a staged re-run's own text
    ("superseded_by:another-document", False),
    ("duplicate_of:another-document", False),
    ("Something a person wrote", False),
    (None, False),
])
def test_the_resume_clears_only_a_marker_a_staged_rerun_wrote(error_on_the_row, cleared):
    """The document's `error` is browser-writable and other entries write it
    too. The resume clears a `rerun_failed:` text (the interrupted marker is
    one) and nothing else: an archived copy's marker is not this resume's to
    erase."""
    variant = "the_narration_worked"
    double = _seam_world(variant)
    double.arm(_commit_index(_uninterrupted(variant)) + 3)
    with pytest.raises(_Kill):
        _staged_takeover(double, variant)
    double.arm(None)
    (doc,) = double.rows("documents")
    doc["error"] = error_on_the_row

    assert P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID)["resumed"] == 1

    (doc,) = double.rows("documents")
    assert doc["error"] == (None if cleared or error_on_the_row is None else error_on_the_row), doc
    assert doc["period_id"] == PID and doc["status"] == "analyzed"


def test_a_committed_row_is_never_dropped_unless_its_document_is_being_deleted_for_good():
    """`resume=False` is the hard delete of the document (its month goes with
    it): the only caller that may drop a committed row."""
    variant = "the_narration_worked"
    commit = _commit_index(_uninterrupted(variant))
    double = _seam_world(variant)
    double.arm(commit + 2)
    with pytest.raises(_Kill):
        _staged_takeover(double, variant)
    double.arm(None)
    out = P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID, resume=False)
    assert (out["resumed"], out["dropped"]) == (0, 1), out
    assert [p["id"] for p in double.rows("financial_periods") if p["org_id"] == ORG] == [PID]
    for table in _RUN_TABLES:
        assert [r for r in double.rows(table) if r.get("period_id") == STAGED] == [], table


def test_a_resume_the_database_refuses_leaves_the_committed_row_and_says_so():
    """S18, at the seam. The cleanup is refused a write (a timeout): the
    committed row is LEFT — never dropped — and counted, so the caller
    neither starts another re-run over it nor says the previous analysis is
    still served. It never raises. The next cleanup completes it."""
    variant = "the_narration_worked"
    whole = _uninterrupted(variant)
    expected, commit = _state(whole), _commit_index(whole)
    double = _seam_world(variant)
    double.arm(commit + 2)
    with pytest.raises(_Kill):
        _staged_takeover(double, variant)
    double.arm(2, refuse=True)                                # the resume's second write times out

    out = P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID)

    assert out == {"resumed": 0, "dropped": 0, "left": 1, "unreadable": False,
                   "left_documents": [DOC_ID]}, out
    (staged,) = [p for p in double.rows("financial_periods") if p["id"] == STAGED]
    assert staged["assembled_canonical_v1"][MARKER_KEY]["takeover_began_at"], "the committed row was dropped"
    double.arm(None)
    assert P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID)["resumed"] == 1
    assert _state(double) == expected


def test_the_cleanup_never_raises_when_the_store_cannot_be_read():
    class _Unreadable(W.RecordingDouble):
        def select(self, table: str, **kwargs: Any) -> Any:
            import httpx
            raise httpx.ReadTimeout("The read operation timed out")

    double = _Unreadable(every_table=True)
    for kwargs in (dict(document_id=DOC_ID), dict(ttl=True), dict(document_id=DOC_ID, resume=False)):
        assert P._clear_staged_rerun_rows(double, ORG, **kwargs) == {
            "resumed": 0, "dropped": 0, "left": 0, "unreadable": True, "left_documents": []}
    assert double.writes == []
    # No company, nothing to do — and nothing read.
    assert P._clear_staged_rerun_rows(double, "", ttl=True)["unreadable"] is False


# ── S14 — the company pass ────────────────────────────────────────────


def _aged(seconds: int) -> str:
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


#: cell -> (staged this many seconds ago, committed, the document exists,
#:          the document is in flight in this process, the pass is made by
#:          THIS document's own run (under its claim), what the pass does)
_COMPANY_PASS = {
    "young_and_its_run_may_be_alive": (30, False, True, False, False, "left"),
    "young_and_in_flight": (30, False, True, True, False, "left"),
    "old_but_in_flight_in_this_process": (3600, False, True, True, False, "left"),
    "old_and_nobody_runs_it": (3600, False, True, False, False, "dropped"),
    "just_over_the_fifteen_minutes": (901, False, True, False, False, "dropped"),
    "just_under_the_fifteen_minutes": (880, False, True, False, False, "left"),
    "young_and_its_document_is_gone": (30, False, False, False, False, "dropped"),
    "committed_and_old": (3600, True, True, False, False, "resumed"),
    # A COMMITTED row does not wait the fifteen minutes: its month is
    # mid-replacement, and its document is not in flight here — a dead
    # process's (S24: left to wait, the next upload for the month cost it
    # the last good briefing).
    "committed_and_young": (30, True, True, False, False, "resumed"),
    "committed_young_and_its_document_is_gone": (30, True, False, False, False, "dropped"),
    "committed_old_but_in_flight": (3600, True, True, True, False, "left"),
    "committed_young_and_in_flight": (30, True, True, True, False, "left"),
    # THE PASS OF THE DOCUMENT'S OWN RUN (it holds the claim: no other run of
    # it is alive here) — its leftover is dead whatever its age (S25).
    "young_and_the_pass_is_its_own_documents_run": (30, False, True, True, True, "dropped"),
    "committed_young_and_the_pass_is_its_own_documents_run": (30, True, True, True, True, "resumed"),
}


@pytest.mark.parametrize("cell", sorted(_COMPANY_PASS))
def test_the_company_pass_clears_only_the_staged_rows_of_dead_runs(cell, monkeypatch):
    """S14. Every analysis of a company first clears the staged rows dead
    re-runs left in it (`ttl=True`). A row whose document is in flight in
    this process may be a live run's and is left — unless the pass is made
    by that document's OWN run. Otherwise: a COMMITTED row is RESUMED at
    once; an uncommitted one is dropped once it is fifteen minutes old (or
    its document no longer exists)."""
    from engine.api import _doc_dedupe
    age, committed, document_exists, in_flight, own_run, expected = _COMPANY_PASS[cell]
    variant = "the_narration_worked"
    double = _seam_world(variant)
    if committed:
        double.arm(_commit_index(_uninterrupted(variant)) + 2)
        with pytest.raises(_Kill):
            _staged_takeover(double, variant)
        double.arm(None)
    (staged,) = [p for p in double.rows("financial_periods") if p["id"] == STAGED]
    staged["assembled_canonical_v1"][MARKER_KEY]["staged_at"] = _aged(age)
    if not document_exists:
        double.delete("documents", filters={"id": "eq.%s" % DOC_ID})
    if in_flight:
        assert _doc_dedupe.try_mark_in_flight(DOC_ID)
    before = _state(double)

    out = P._clear_staged_rerun_rows(double, ORG, ttl=True,
                                     claimed_document_id=DOC_ID if own_run else "another-documents-run")

    assert out == {"resumed": int(expected == "resumed"), "dropped": int(expected == "dropped"),
                   "left": 0, "unreadable": False, "left_documents": []}, (cell, out)
    if expected == "left":
        assert _state(double) == before, "%s: the pass touched a row it must leave" % cell
    elif expected == "dropped":
        assert _month_of(_state(double)) == _month_of(before)
        assert [p["id"] for p in double.rows("financial_periods") if p["id"] == STAGED] == []
    else:
        assert _state(double) == _state(_uninterrupted(variant))
    # Another company's pass never reaches this company's staged row.
    other = _seam_world(variant)
    (row,) = [p for p in other.rows("financial_periods") if p["id"] == STAGED]
    row["assembled_canonical_v1"][MARKER_KEY]["staged_at"] = _aged(3600)
    untouched = _state(other)
    assert P._clear_staged_rerun_rows(other, OTHER_ORG, ttl=True)["dropped"] == 0 and _state(other) == untouched


def test_the_fifteen_minutes_are_what_this_file_says():
    assert P.STAGED_RERUN_TTL_S == 900


# ── S18 — the failure handler of a staged re-run ──────────────────────

_HANDLER_DOC = {"id": DOC_ID, "org_id": ORG}


def _handle_failure(double: W.RecordingDouble, message: str = "RuntimeError: compute failed") -> str:
    with RA.installed(double):
        return P._staged_rerun_failed(DOC_ID, dict(_HANDLER_DOC), message, 1234)


@pytest.mark.parametrize("error_before", [None, "rerun_failed: an earlier re-run's text"])
def test_a_staged_rerun_that_fails_is_said_on_the_row_and_never_by_its_status(error_before):
    """The run failed before its takeover began (extract, map, compute, a
    narration stage…): the staged row is dropped, the month is what it was,
    and the document is NOT marked failed — it stays analysed over the month
    it still serves; its row says the last re-run did not finish."""
    double = _seam_world("the_narration_worked", document_error=error_before)
    month_before = _month_of(_state(double))

    assert _handle_failure(double) == "failed"

    (doc,) = double.rows("documents")
    assert doc["status"] == "analyzed" and doc["period_id"] == PID, doc
    assert doc["error"] == "rerun_failed: RuntimeError: compute failed" and doc["duration_ms"] == 1234, doc
    assert _month_of(_state(double)) == dict(month_before, documents=[
        dict(month_before["documents"][0], error=doc["error"], duration_ms=1234)])
    assert [p["id"] for p in double.rows("financial_periods") if p["org_id"] == ORG] == [PID]
    assert [w for w in double.writes if "status" in (w["payload"] if isinstance(w["payload"], dict) else {})] == [], \
        "the handler of a staged re-run wrote a status"


@pytest.mark.parametrize("marker", ["superseded_by:a-newer-upload", "duplicate_of:the-original"])
def test_a_failed_staged_rerun_never_writes_over_an_archived_copys_marker(marker):
    """Overtaken by a newer upload while it ran, the document was archived
    with the marker that names its replacement. That is what its row says."""
    double = _seam_world("the_narration_worked", document_error=marker)
    assert _handle_failure(double, "document_superseded") == "failed"
    (doc,) = double.rows("documents")
    assert doc["error"] == marker and doc["status"] == "analyzed", doc
    assert [p["id"] for p in double.rows("financial_periods") if p["org_id"] == ORG] == [PID]


def test_a_takeover_refused_a_write_after_its_commit_point_is_completed_by_the_handler():
    """The database refuses ONE write inside the apply (a timeout): the
    takeover raises, the handler's own cleanup resumes the committed row,
    and the run's analysis IS the month — the outcome is `analyzed`."""
    variant = "the_narration_worked"
    whole = _uninterrupted(variant)
    expected, commit = _state(whole), _commit_index(whole)
    double = _seam_world(variant)
    double.arm(commit + 3, refuse=True)
    import httpx
    with pytest.raises(httpx.ReadTimeout):
        _staged_takeover(double, variant)
    double.arm(None)

    assert _handle_failure(double, "ReadTimeout: The read operation timed out") == "analyzed"

    after = _state(double)
    assert after["documents"][0]["duration_ms"] == 1234
    after["documents"][0]["duration_ms"] = expected["documents"][0]["duration_ms"]
    assert after == expected


def test_a_handler_that_cannot_complete_a_committed_takeover_leaves_the_row_and_the_marker():
    """…and when the resume is refused too, the committed row is LEFT (never
    dropped: the month's briefing may already be gone, the run's own under
    the staged id) and the document's row says the replacement was
    interrupted — never that the previous analysis is still served."""
    variant = "the_narration_worked"
    whole = _uninterrupted(variant)
    # The refused write: the MOVE of the run's briefing onto the month — the
    # month's own briefing was deleted one statement earlier.
    (move_of_the_briefing,) = [i + 1 for i, w in enumerate(whole.writes)
                               if (w["op"], w["table"], w["payload"]) == ("update", "briefings", {"period_id": PID})]
    double = _seam_world(variant)
    double.arm(move_of_the_briefing, refuse=True)
    import httpx
    with pytest.raises(httpx.ReadTimeout):
        _staged_takeover(double, variant)
    double.arm(1, refuse=True)                                # … and the resume's first write is refused

    assert _handle_failure(double, "ReadTimeout: The read operation timed out") == "failed"

    (doc,) = double.rows("documents")
    assert doc["error"] == INTERRUPTED and doc["status"] == "analyzed", doc
    (staged,) = [p for p in double.rows("financial_periods") if p["id"] == STAGED]
    assert staged["assembled_canonical_v1"][MARKER_KEY]["takeover_began_at"]
    # … what the run stored and had not yet moved is still safe under the staged id.
    assert [b["id"] for b in double.rows("briefings") if b["period_id"] in (PID, STAGED)] == ["briefing-of-the-rerun"]


@pytest.mark.parametrize("interrupted", [False, True], ids=["the_takeover_completes", "the_takeover_is_resumed"])
def test_a_document_that_was_failed_over_its_period_is_analysed_once_its_rerun_took_over(interrupted):
    """A document can be `failed` OVER a period it owns (an in-place
    correction re-run that failed — make-active, move-period, recover). Its
    staged re-run does not re-status it while it runs; once the takeover has
    replaced the month, the document IS analysed — written by the takeover
    itself, with the pin, so that a lost last status write of the
    orchestrator cannot leave `failed`, with its error cleared, over the new
    analysis. The same after a resume."""
    variant = "the_narration_worked"
    double = _seam_world(variant, document_error="RuntimeError: an earlier in-place run failed")
    (doc,) = double.rows("documents")
    doc["status"] = "failed"
    if interrupted:
        double.arm(_commit_index(_uninterrupted(variant)) + 4)
        with pytest.raises(_Kill):
            _staged_takeover(double, variant)
        double.arm(None)
        (doc,) = double.rows("documents")
        assert (doc["status"], doc["error"]) == ("failed", INTERRUPTED), doc
        assert P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID)["resumed"] == 1
    else:
        assert _staged_takeover(double, variant) == PID
    (doc,) = double.rows("documents")
    assert (doc["status"], doc["error"], doc["period_id"]) == ("analyzed", None, PID), doc


# ── the takeover's own refusals (T0) ──────────────────────────────────

_OVERTAKEN = {
    "a_newer_upload_took_the_month": lambda d: d.update(
        "financial_periods", {"source_document_id": "a-newer-upload"}, filters={"id": "eq.%s" % PID}),
    "the_month_was_cleared": lambda d: d.delete("financial_periods", filters={"id": "eq.%s" % PID}),
    "the_document_is_gone": lambda d: d.delete("documents", filters={"id": "eq.%s" % DOC_ID}),
    "the_pin_names_another_period": lambda d: d.update(
        "documents", {"period_id": OTHER_PID}, filters={"id": "eq.%s" % DOC_ID}),
}


@pytest.mark.parametrize("what", sorted(_OVERTAKEN))
def test_a_staged_takeover_looks_at_ownership_again_and_writes_nothing_when_overtaken(what):
    """T0. The month must still be this document's own at the takeover — the
    look of the route and of the mint, made once more. Overtaken, the
    takeover raises with the neutral code and writes NOTHING: never "the
    staged row stands" (a staged row names no source; it is nobody's month)."""
    double = _seam_world("the_narration_worked")
    _OVERTAKEN[what](double)
    before = _state(double)
    double.writes[:] = []

    with pytest.raises(P.RerunOvertaken) as refused:
        _staged_takeover(double, "the_narration_worked")

    assert str(refused.value) == "document_superseded" and isinstance(refused.value, P.PlainRefusal)
    assert double.writes == [] and _state(double) == before, double.writes


def test_a_refiled_rerun_never_takes_over_a_month_that_is_another_rows():
    """The re-run reads the file as December 2024 — and by the takeover a
    period for December 2024 exists (another document's). The re-run is
    refused with its own code; neither month changes. (Before 2026-10-04
    such a re-run replaced that other month and archived its document.)"""
    variant = "the_rerun_refiled_the_document"
    double = _seam_world(variant)
    double.add("financial_periods", {"id": "december-2024", "org_id": ORG, "currency": "RON",
                                     "source_document_id": "the-other-months-document",
                                     "period_start": "2024-12-31", "period_end": "2024-12-31"})
    before = _state(double)
    double.writes[:] = []

    with pytest.raises(P.RerunMonthTaken) as refused:
        _staged_takeover(double, variant)

    assert str(refused.value) == "rerun_month_taken" and isinstance(refused.value, P.PlainRefusal)
    assert double.writes == [] and _state(double) == before
    # CONTROL: a STAGED row of that month (another dead re-run's) is nobody's month.
    free = _seam_world(variant)
    free.add("financial_periods", {"id": "another-staged-row", "org_id": ORG, "currency": "RON",
                                   "source_document_id": None,
                                   "period_start": "2024-12-31", "period_end": "2024-12-31",
                                   "assembled_canonical_v1": {MARKER_KEY: _marker("another-document", "its-month")}})
    assert _staged_takeover(free, variant) == PID


def test_an_uploads_takeover_clears_the_months_cached_benchmark_report_and_is_otherwise_what_it_was():
    """A same-month re-UPLOAD's takeover (the record without `rerun`) is the
    one of gate briefing-keep-last-good — its laws run unchanged — plus ONE
    statement: the benchmark report cached for the month is cleared (the
    period keeps its id; the cache is keyed on it). No commit marker, no
    interrupted marker, the superseded document archived as before."""
    double = W._takeover_world(staged_body=W.NEW_BODY, staged_recommendations=True)
    double.add("benchmark_reports", {"id": "report-of-the-month", "period_id": PID, "org_id": ORG,
                                     "caen_code": "1011", "report_data": {"run": "first"}})
    double.add("benchmark_reports", {"id": "report-of-the-other-tenant", "period_id": OTHER_PID,
                                     "org_id": OTHER_ORG, "caen_code": "1011", "report_data": {}})
    double.writes[:] = []

    assert W._take_over(double) == PID

    W._assert_the_takeover_happened(double)
    assert [r["id"] for r in double.rows("benchmark_reports")] == ["report-of-the-other-tenant"]
    (bust,) = W._writes(double, "benchmark_reports")
    assert (bust["op"], bust["filters"]) == ("delete", {"period_id": "eq.%s" % PID, "org_id": "eq.%s" % ORG})
    assert not [w for w in double.writes if w["table"] == "documents" and "rerun_failed" in repr(w["payload"])]
    assert not [w for w in double.writes if MARKER_KEY in repr(w["payload"])]
    (first_doc,) = [d for d in double.rows("documents") if d["id"] == W.FIRST_DOC_ID]
    assert first_doc["deleted_at"] is not None and first_doc["error"] == "superseded_by:%s" % DOC_ID


def test_a_takeover_does_not_depend_on_the_benchmark_cache_table():
    """Best effort: a store with no `benchmark_reports` table (or one that
    refuses the delete) does not fail a takeover."""
    double = _seam_world("the_narration_worked")
    del double.columns["benchmark_reports"]
    double.tables.pop("benchmark_reports", None)
    assert _staged_takeover(double, "the_narration_worked") == PID
    assert [p["id"] for p in double.rows("financial_periods") if p["org_id"] == ORG] == [PID]


# ── S19 — what the company pass costs a first analysis ────────────────


def test_a_first_analysis_pays_two_light_reads_for_the_staged_rows_and_no_write(app, gw, monkeypatch):
    """What the staged-row passes cost a run that has nothing to do with a
    re-run: one look at its OWN document's leftover before its first stage
    (S25) and the company pass on its `stage_persist`. With no staged row in
    the company each is exactly one read — the source-less rows of the
    company, the id and the marker alone (never an envelope) — and no write."""
    W._script_the_provider(monkeypatch, [W._reply(W.BODY_A, W.TITLES_A)])
    real = P._clear_staged_rerun_rows
    passes = []  # type: List[Any]

    def watched(admin_client: Any, org_id: Any, **kwargs: Any) -> Any:
        before = len(gw.db.calls)
        out = real(admin_client, org_id, **kwargs)
        passes.append((kwargs, list(gw.db.calls[before:]), out))
        return out

    monkeypatch.setattr(P, "_clear_staged_rerun_rows", watched)

    first = W._first_analysis(app, gw)

    assert [kwargs for kwargs, _calls, _out in passes] == [
        # before the first stage: this document's own leftover, whatever its age
        {"document_id": first["doc"]["id"]},
        # at the persist: the company pass — told whose run is making it
        {"ttl": True, "claimed_document_id": first["doc"]["id"]}], [k for k, _c, _o in passes]
    for _kwargs, calls, out in passes:
        assert calls == [("select", "financial_periods",
                          {"org_id": "eq.%s" % first["org_id"], "source_document_id": "is.null"},
                          "id,org_id,source_document_id," + MARKER_SELECT)], calls
        assert out == {"resumed": 0, "dropped": 0, "left": 0, "unreadable": False, "left_documents": []}


# ══════════════════════════════════════════════════════════════════════
# THROUGH THE REAL ROUTE AND THE REAL RUN (the `gw` world)
# ══════════════════════════════════════════════════════════════════════
#
# POST /api/pipeline/retry on the real app, then `_run_pipeline_sync` — every
# stage real, the provider scripted, every write spied. The Docs-panel laws
# of gate briefing-keep-last-good (the writers file, W6) hold the reader's
# side of the same runs; these hold the mechanism.


def _watch_statuses(monkeypatch) -> List[str]:
    """Every status the engine writes through `_admin_set_status`."""
    seen = []  # type: List[str]
    real = P._admin_set_status

    def status(document_id: str, value: str, **kwargs: Any) -> None:
        seen.append(value)
        return real(document_id, value, **kwargs)

    monkeypatch.setattr(P, "_admin_set_status", status)
    return seen


def _staged_ids(spy: W._Spy) -> List[str]:
    """The id(s) of the staged row(s) the run inserted — read off what the
    database answered its `financial_periods` inserts with."""
    return [str(row["id"]) for w in spy.writes
            if w["op"] == "insert" and w["table"] == "financial_periods" and not w["refused"]
            for row in (w["returned"] or [])]


def _hangs_on_the_period(gw, w: Dict[str, Any]) -> Dict[str, Any]:
    """What else is keyed by the period's id and must come through a re-run
    untouched — or, for the cache, be cleared: the benchmark report cached
    for the period, and the industry a user LOCKED for it (a member's
    valuation overrides hang on the same id, the same way: the reset's
    cascade used to take both)."""
    gw.db.add("benchmark_reports", {"id": "cached-report", "period_id": w["month"], "org_id": w["org"],
                                    "caen_code": "1011", "report_data": {"of": "the first run"}})
    gw.db.add("company_industry_assignments", {
        "id": "locked-industry", "organization_id": w["org"], "period_id": w["month"],
        "selected_industry_key": "food_manufacturing", "source": "user_override", "locked_by_user": True})
    return {"company_industry_assignments": copy.deepcopy(gw.db.rows("company_industry_assignments"))}


def _rows_by_id(gw, table: str, period_id: str) -> List[str]:
    return sorted(str(r["id"]) for r in gw.db.rows(table) if str(r.get("period_id")) == str(period_id))


@pytest.mark.parametrize("narration", ["the_narration_fails", "the_narration_works"])
def test_a_staged_rerun_replaces_its_months_statements_through_a_staged_row_and_a_commit_point(
        app, gw, monkeypatch, narration):
    """S1 / S2 — THE MECHANISM, end to end. The run inserts ONE row beside
    the month — no source, the marker — and persists under it; the document
    is never pinned to it and never re-statused; no statement touches the
    month before the commit point; the takeover then replaces the month's
    statements (new line items, new metrics, alerts keyed to the MONTH) and
    the row takes the run's envelope WITHOUT the marker. What hangs on the
    period id — the locked industry, a member's valuation overrides — is
    still there (the reset used to cascade it away); the cached benchmark
    report is cleared. The unique (org, month, document) tuple is never
    violated. A failed narration keeps the month's briefing (stale) and its
    recommendations — the same rows; a usable one replaces them."""
    fails = narration == "the_narration_fails"
    w = O._own_month(app, gw, monkeypatch,
                     [RuntimeError(W.PROVIDER_ERROR_TEXT) if fails else W._reply(W.BODY_B, W.TITLES_B)])
    unique_refusals = _enforce_the_unique_period_tuple(gw, monkeypatch)
    hangs = _hangs_on_the_period(gw, w)
    (briefing_before,) = copy.deepcopy(gw.db.rows("briefings"))
    line_items_before = _rows_by_id(gw, "statement_line_items", w["month"])
    metrics_before = _rows_by_id(gw, "calculated_metrics", w["month"])
    served_before = V._served(app, w["org"], w["month"])
    statuses = _watch_statuses(monkeypatch)
    spy = W._Spy(gw.db, monkeypatch)

    r = O._retry(app, w["org"], w["doc1"])
    assert r.status_code == 202 and r.json()["status"] == "queued", (r.status_code, r.text[:300])
    rerun = V.run_analysis(gw, w["doc1"])

    assert (rerun["status"], rerun["error"], rerun["period_id"]) == ("analyzed", None, w["month"]), rerun
    W._assert_every_run_reached_the_provider(2)
    assert unique_refusals == [], unique_refusals
    # THE DOCUMENT WAS NEVER RE-STATUSED: one status write, the last one.
    assert statuses == ["analyzed"], "the staged re-run wrote statuses %r" % statuses
    # THE STAGED ROW: one insert, no source, the marker naming the document and its month.
    (staged,) = _staged_ids(spy)
    (insert,) = [x for x in spy.writes if x["op"] == "insert" and x["table"] == "financial_periods"]
    assert insert["payload"]["source_document_id"] is None and insert["payload"]["org_id"] == w["org"], insert
    marker = insert["payload"]["assembled_canonical_v1"][MARKER_KEY]
    assert (marker["document_id"], marker["served_period_id"]) == (w["doc1"], w["month"]), marker
    assert W._is_a_timestamp(marker["staged_at"]) and "takeover_began_at" not in marker
    # … every envelope write on the staged row carries the marker; none on the month does.
    for x in spy.writes:
        if x["op"] == "update" and x["table"] == "financial_periods" and "assembled_canonical_v1" in (x["payload"] or {}):
            carries = MARKER_KEY in (x["payload"]["assembled_canonical_v1"] or {})
            assert carries is (x["filters"].get("id") == "eq.%s" % staged), (x["filters"], carries)
    # THE DOCUMENT WAS NEVER PINNED TO THE STAGED ROW.
    assert [x for x in spy.writes if x["table"] == "documents"
            and (x["payload"] or {}).get("period_id") == staged] == [], "the document was pinned to the staged row"
    # NOTHING TOUCHED THE MONTH BEFORE THE COMMIT POINT.
    (commit,) = [i for i, x in enumerate(spy.writes)
                 if x["op"] == "update" and x["table"] == "financial_periods"
                 and ((x["payload"] or {}).get("assembled_canonical_v1") or {}).get(MARKER_KEY, {}).get("takeover_began_at")]
    early = [(x["op"], x["table"], x["filters"]) for x in spy.writes[:commit] if O._names_the_period(x, w["month"])]
    assert early == [], "a write touched the month before the commit point: %r" % early
    assert (spy.writes[commit + 1]["table"], spy.writes[commit + 1]["payload"]) == ("documents", {"error": INTERRUPTED})
    # ONE PERIOD — the same id — and nothing under any other.
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == w["month"] and period["source_document_id"] == w["doc1"], period
    envelope = period["assembled_canonical_v1"]
    assert MARKER_KEY not in envelope and envelope["provenance"]["source_document_id"] == w["doc1"], sorted(envelope)
    for table in W._PERIOD_CHILD_TABLES:
        assert [x for x in gw.db.rows(table) if x.get("period_id") != w["month"]] == [], table
    # THE STATEMENTS ARE THE RE-RUN'S: new rows, the same figures (the same file).
    assert _rows_by_id(gw, "statement_line_items", w["month"]) != line_items_before
    assert _rows_by_id(gw, "calculated_metrics", w["month"]) != metrics_before
    assert len(_rows_by_id(gw, "statement_line_items", w["month"])) == len(line_items_before)
    assert V._served(app, w["org"], w["month"]) == served_before
    # THE ALERTS are keyed to the month they sit on.
    alerts = gw.db.rows("alerts")
    assert sorted(a["alert_key"] for a in alerts) == w["alert_keys"], (
        "the re-run's alerts are not keyed as the month's were (a key that names its period must "
        "name the MONTH, never the staged row): %r" % sorted(a["alert_key"] for a in alerts))
    assert any(w["month"] in key for key in w["alert_keys"]), "no alert key names its period: the check is vacuous"
    assert all(staged not in a["alert_key"] and a["period_id"] == w["month"] for a in alerts)
    # WHAT HANGS ON THE PERIOD ID.
    assert gw.db.rows("benchmark_reports") == [], "the benchmark report cached for the period was not cleared"
    for table, rows in hangs.items():
        assert gw.db.rows(table) == rows, "%s did not come through the re-run" % table
    # THE NARRATIVE.
    (briefing,) = gw.db.rows("briefings")
    if fails:
        assert W._sans_marker(briefing) == W._sans_marker(briefing_before), briefing
        assert briefing["stale_reason"] == "provider_error"
        assert gw.db.rows("recommendations") == w["recommendations"]
    else:
        assert briefing["body"] == W.BODY_B and briefing["id"] != briefing_before["id"] and \
            briefing["stale_since"] is None, briefing
        recs = gw.db.rows("recommendations")
        assert sorted(x["title"] for x in recs) == W.TITLES_B
        assert all(x["period_id"] == x["target_id"] == w["month"] for x in recs), recs
    assert P._STAGED_RERUNS == {}


# ── S3 / S21 — a run that fails, wherever it fails ────────────────────


def _raise(message: str) -> Any:
    def boom(*a: Any, **kw: Any) -> Any:
        raise RuntimeError(message)
    return boom


def _refuse_writes(gw, monkeypatch, op: str, table: str, when: Any = None, *, land: bool = False) -> List[Any]:
    """The database refuses EVERY `op` on `table` that `when(payload,
    filters)` accepts (a timeout). `land`: the write is stored and only its
    reply is lost."""
    import httpx
    refused = []  # type: List[Any]
    real = getattr(gw.db, op)

    def call(tbl: str, *args: Any, **kwargs: Any) -> Any:
        payload = args[0] if args else None
        if tbl == table and (when is None or when(payload, dict(kwargs.get("filters") or {}))):
            refused.append(copy.deepcopy(payload))
            if land:
                real(tbl, *args, **kwargs)
            raise httpx.ReadTimeout("The read operation timed out")
        return real(tbl, *args, **kwargs)

    monkeypatch.setattr(gw.db, op, call)
    return refused


#: where the run fails -> how. `month` is the id of the month's own row.
_FAILURES = {
    "01_extract": lambda gw, mp, month: mp.setattr(P, "stage_extract", _raise("extract failed")),
    "02_map": lambda gw, mp, month: mp.setattr(P, "stage_map", _raise("map failed")),
    "03_the_staged_rows_insert_is_refused": lambda gw, mp, month: _refuse_writes(
        gw, mp, "insert", "financial_periods"),
    "04_the_staged_rows_insert_landed_and_its_reply_was_lost": lambda gw, mp, month: _refuse_writes(
        gw, mp, "insert", "financial_periods", land=True),
    "05_the_line_items_are_refused": lambda gw, mp, month: _refuse_writes(
        gw, mp, "insert", "statement_line_items"),
    # … from here on the run HAS persisted its statements under the staged row
    # (S21: the withdrawn in-place design left them on the month).
    "06_compute": lambda gw, mp, month: mp.setattr(P, "stage_compute", _raise("compute failed")),
    "07_the_metrics_are_refused": lambda gw, mp, month: _refuse_writes(gw, mp, "insert", "calculated_metrics"),
    "08_validate": lambda gw, mp, month: mp.setattr(P, "stage_validate", _raise("validate failed")),
    "09_narrate_raises": lambda gw, mp, month: mp.setattr(P, "stage_narrate", _raise("narrate failed")),
    "10_the_runs_touch_of_its_row": lambda gw, mp, month: _refuse_writes(
        gw, mp, "update", "financial_periods",
        lambda payload, filters: "updated_at" in payload and "assembled_canonical_v1" not in payload),
    "11_a_staged_only_delete_of_the_takeover": lambda gw, mp, month: _refuse_writes(
        gw, mp, "delete", "briefings",
        lambda payload, filters: "org_id" in filters and filters.get("period_id") != "eq.%s" % month),
    "12_the_commit_write": lambda gw, mp, month: _refuse_writes(
        gw, mp, "update", "financial_periods",
        lambda payload, filters: "takeover_began_at" in (
            (payload.get("assembled_canonical_v1") or {}).get(MARKER_KEY) or {})),
}


@pytest.mark.parametrize("where", sorted(_FAILURES))
def test_a_staged_rerun_that_fails_leaves_the_month_exactly_as_it_was(app, gw, monkeypatch, where):
    """S3. The run fails in ANY stage up to its commit point — before it
    persisted anything, after its statements and metrics were stored (S21:
    the in-place design left those on the month, beside the old ones), in
    the narrative stage, inside the takeover's staged-only work, at the
    commit write itself. The month is EXACTLY what it was: its row, every
    row under it (the same ids), what a reader is served. No staged row and
    nothing under one is left. The document is not re-statused at any point
    and ends `analyzed`, pinned to its month, its row saying the re-run did
    not finish; no period of the company lacks an analysed source."""
    from engine.workspaces.migration_plan import empty_live_periods

    w = O._own_month(app, gw, monkeypatch, [RuntimeError(W.PROVIDER_ERROR_TEXT)])
    before = W._month_as_served(app, gw, w)
    with pytest.MonkeyPatch.context() as failing:        # lifted again before the month is read back
        _FAILURES[where](gw, failing, w["month"])
        statuses = _watch_statuses(failing)

        r = O._retry(app, w["org"], w["doc1"])
        assert r.status_code == 202, (r.status_code, r.text[:300])
        failed = V.run_analysis(gw, w["doc1"])

    assert statuses == [], "%s: the failed staged re-run wrote statuses %r" % (where, statuses)
    assert (failed["status"], failed["period_id"]) == ("analyzed", w["month"]), (failed["status"], failed["period_id"])
    assert str(failed["error"]).startswith(RERUN_FAILED_PREFIX) and failed["error"] != INTERRUPTED, failed["error"]
    assert [p["id"] for p in gw.db.rows("financial_periods")] == [w["month"]], (
        "%s: a staged row was left behind: %r" % (where, [p["id"] for p in gw.db.rows("financial_periods")]))
    for table in W._PERIOD_CHILD_TABLES:
        assert [x for x in gw.db.rows(table) if x.get("period_id") != w["month"]] == [], (where, table)
    assert W._month_as_served(app, gw, w) == before, "%s: the month is not what it was before the click" % where
    assert empty_live_periods(gw.db.tables) == []
    assert P._STAGED_RERUNS == {}


# ── S4 — a narrative write the database refuses ───────────────────────

#: the refused write -> (how, whose briefing the month holds, whose
#: recommendations, are the month's alerts the old rows)
_REFUSED_NARRATIVE = {
    "the_briefing_upsert": (("upsert", "briefings"), "the_months", "the_months", False),
    "the_recommendations_insert": (("insert", "recommendations"), "the_runs", "the_months", False),
    "the_alerts_upsert": (("upsert", "alerts"), "the_runs", "the_runs", True),
}


@pytest.mark.parametrize("refused_write", sorted(_REFUSED_NARRATIVE))
def test_a_staged_rerun_whose_narrative_write_is_refused_replaces_only_what_it_stored(
        app, gw, monkeypatch, refused_write):
    """S4. The narration WORKED and the database refused ONE narrative write
    under the staged row. The run still succeeds (the narrative layer is
    non-fatal) — and the takeover replaces only what the run STORED:
      · the briefing not stored → the month's stays, marked `write_refused`
        (no narration failed — the reason is not a narration code);
      · the recommendations not stored → the month's stay, the same rows;
      · the alerts not stored → the month's stay."""
    (op, table), briefing_is, recommendations_are, alerts_kept = _REFUSED_NARRATIVE[refused_write]
    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B)])
    (briefing_before,) = copy.deepcopy(gw.db.rows("briefings"))
    alerts_before = copy.deepcopy(gw.db.rows("alerts"))
    assert O._retry(app, w["org"], w["doc1"]).status_code == 202
    refused = W._refuse_once(gw, monkeypatch, op, table)

    rerun = V.run_analysis(gw, w["doc1"])

    assert refused, "the scenario never happened: no %s on %s was refused" % (op, table)
    assert (rerun["status"], rerun["error"], rerun["period_id"]) == ("analyzed", None, w["month"]), rerun
    assert [p["id"] for p in gw.db.rows("financial_periods")] == [w["month"]]
    for t in W._PERIOD_CHILD_TABLES:
        assert [x for x in gw.db.rows(t) if x.get("period_id") != w["month"]] == [], t
    (briefing,) = gw.db.rows("briefings")
    if briefing_is == "the_months":
        assert W._sans_marker(briefing) == W._sans_marker(briefing_before), briefing
        assert briefing["stale_reason"] == "write_refused" and W._is_a_timestamp(briefing["stale_since"]), briefing
    else:
        assert briefing["body"] == W.BODY_B and briefing["stale_since"] is None, briefing
    if recommendations_are == "the_months":
        assert gw.db.rows("recommendations") == w["recommendations"]
    else:
        assert sorted(x["title"] for x in gw.db.rows("recommendations")) == W.TITLES_B
    if alerts_kept:
        assert gw.db.rows("alerts") == alerts_before, "the month's alerts were replaced by none"
    else:
        assert sorted(a["alert_key"] for a in gw.db.rows("alerts")) == w["alert_keys"] and \
            not set(a["id"] for a in gw.db.rows("alerts")) & set(a["id"] for a in alerts_before)


# ── S5 — the run's last status write is lost ──────────────────────────


def test_a_staged_rerun_whose_last_status_write_times_out_is_still_analysed(app, gw, monkeypatch):
    """S5. The takeover is complete — the month IS the run's analysis, the
    document pinned, analysed, no marker — when the run's own last write
    (the duration on the document's row) times out. Before, that timeout
    failed the run and rolled its period back. The outcome is `analyzed`:
    the plan settles the run as a success, and nothing is left to clean."""
    import httpx
    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B)])
    real_status = P._admin_set_status
    timed_out = []  # type: List[str]

    def status(document_id: str, value: str, **kwargs: Any) -> None:
        if value == "analyzed" and not timed_out:
            timed_out.append(document_id)
            raise httpx.ReadTimeout("The read operation timed out")
        return real_status(document_id, value, **kwargs)

    monkeypatch.setattr(P, "_admin_set_status", status)
    real_stages = P._run_pipeline_stages
    outcomes = []  # type: List[str]
    monkeypatch.setattr(P, "_run_pipeline_stages",
                        lambda document_id: outcomes.append(real_stages(document_id)) or outcomes[-1])

    assert O._retry(app, w["org"], w["doc1"]).status_code == 202
    rerun = V.run_analysis(gw, w["doc1"])

    assert timed_out == [w["doc1"]], "the scenario never happened"
    assert outcomes == ["analyzed"], outcomes
    assert (rerun["status"], rerun["error"], rerun["period_id"]) == ("analyzed", None, w["month"]), rerun
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == w["month"] and MARKER_KEY not in period["assembled_canonical_v1"]
    assert [b["body"] for b in gw.db.rows("briefings")] == [W.BODY_B]
    assert sorted(x["title"] for x in gw.db.rows("recommendations")) == W.TITLES_B


# ── S6 — one run per document, and the note that it is staged ─────────


def test_a_second_click_while_the_rerun_is_in_flight_starts_nothing(app, gw, monkeypatch):
    """S6. "Re-run analysis" clicked again before the first run has ended:
    answered 202 like the first (the panel shows the same toast), and
    NOTHING is started or written — one enqueue, the note of the staged
    re-run unchanged."""
    w = O._own_month(app, gw, monkeypatch, [RuntimeError(W.PROVIDER_ERROR_TEXT)])
    enqueued_before = list(gw.enqueued)
    assert O._retry(app, w["org"], w["doc1"]).status_code == 202
    assert gw.enqueued == enqueued_before + [w["doc1"]]
    state, noted = gw.state(), dict(P._STAGED_RERUNS)
    spy = W._Spy(gw.db, monkeypatch)

    again = O._retry(app, w["org"], w["doc1"])

    assert again.status_code == 202, (again.status_code, again.text[:300])
    assert spy.writes == [] and gw.state() == state, spy.writes
    assert gw.enqueued == enqueued_before + [w["doc1"]] and P._STAGED_RERUNS == noted
    rerun = V.run_analysis(gw, w["doc1"])
    assert rerun["status"] == "analyzed" and rerun["error"] is None, (rerun["status"], rerun.get("error"))


def test_a_hand_off_that_fails_leaves_no_note_of_a_staged_rerun(app, gw, monkeypatch):
    """The run could not be handed to its thread: the claim is given back
    and the note that the document's next run is a staged re-run goes with
    it — it must not make a LATER run of the document (a correction, a
    recovery) behave as a staged one."""
    w = O._own_month(app, gw, monkeypatch, [])
    (doc_before,) = copy.deepcopy(gw.docs(id=w["doc1"]))
    monkeypatch.setattr(P, "_enqueue", _raise("no thread could be started"))

    r = O._retry(app, w["org"], w["doc1"])

    assert r.status_code == 500, (r.status_code, r.text[:200])
    assert P._STAGED_RERUNS == {}, "the note of a staged re-run outlived a hand-off that failed"
    from engine.api import _doc_dedupe
    assert _doc_dedupe.in_flight(w["doc1"]) is None
    assert gw.docs(id=w["doc1"]) == [doc_before]
    assert [p["id"] for p in gw.db.rows("financial_periods")] == [w["month"]]


# ── S7 — the re-run reads the file as another month ───────────────────

OTHER_DOC, OTHER_PID = O.OTHER_DOC, O.OTHER_PID


def _another_documents_december(gw, w: Dict[str, Any]) -> None:
    """ANOTHER document's analysed period for December 2025."""
    gw.db.insert("documents", dict(w["doc"], id=OTHER_DOC, period_id=OTHER_PID, content_hash="%064x" % 0xd0c2))
    gw.db.insert("financial_periods", {
        "id": OTHER_PID, "org_id": w["org"], "source_document_id": OTHER_DOC, "currency": "RON",
        "period_start": "2025-12-31", "period_end": "2025-12-31",
        "assembled_canonical_v1": {"provenance": {"source_document_id": OTHER_DOC}}})
    gw.db.insert("statement_line_items", {"period_id": OTHER_PID, "statement": "pl", "bucket": "revenue",
                                          "ro_account_code": "707", "amount": 123.0})
    gw.db.insert("briefings", {"period_id": OTHER_PID, "org_id": w["org"], "language": "ro",
                               "body": "Comentariul celuilalt document."})


@pytest.mark.parametrize("when", ["the_month_is_taken_when_the_run_persists", "the_month_is_taken_while_the_run_is_going"])
def test_a_refiled_rerun_is_refused_when_its_new_month_is_another_documents(app, gw, monkeypatch, when):
    """S7. The document's period is filed under December 2024 (an earlier
    run's detection); the re-run reads the file as December 2025 — which
    ANOTHER document holds. Before 2026-10-04 the re-run replaced that other
    month and archived its document. It is refused with its own code:
    BOTH months are exactly what they were, nothing is left staged, and the
    document's row says why."""
    w = O._own_month(app, gw, monkeypatch, [RuntimeError(W.PROVIDER_ERROR_TEXT)])
    (own,) = gw.db.rows("financial_periods")
    own["period_start"] = own["period_end"] = "2024-12-31"
    taken = []  # type: List[str]
    if when == "the_month_is_taken_when_the_run_persists":
        _another_documents_december(gw, w)
        taken.append(when)
    else:
        real_compute = P.stage_compute

        def compute(*a: Any, **kw: Any) -> Any:
            if not taken:
                _another_documents_december(gw, w)           # another upload lands while the run is going
                taken.append(when)
            return real_compute(*a, **kw)

        monkeypatch.setattr(P, "stage_compute", compute)
    (own_before,) = copy.deepcopy([p for p in gw.db.rows("financial_periods") if p["id"] == w["month"]])
    own_rows = V._rows_under(gw, w["month"])

    assert O._retry(app, w["org"], w["doc1"]).status_code == 202
    rerun = V.run_analysis(gw, w["doc1"])

    assert taken == [when], "the scenario never happened"
    periods = _periods(gw, w["org"])
    assert sorted(periods) == sorted([w["month"], OTHER_PID]), sorted(periods)
    assert periods[w["month"]] == own_before, "the re-run re-dated (or rewrote) its period onto a month that is taken"
    assert V._rows_under(gw, w["month"]) == own_rows
    assert periods[OTHER_PID]["source_document_id"] == OTHER_DOC and \
        [x["amount"] for x in gw.db.rows("statement_line_items") if x["period_id"] == OTHER_PID] == [123.0]
    (other_doc,) = gw.docs(id=OTHER_DOC)
    assert other_doc["deleted_at"] is None and other_doc["period_id"] == OTHER_PID, other_doc
    for table in W._PERIOD_CHILD_TABLES:
        assert [x for x in gw.db.rows(table) if x.get("period_id") not in (w["month"], OTHER_PID)] == [], table
    assert (rerun["status"], rerun["period_id"], rerun["error"]) == (
        "analyzed", w["month"], "rerun_failed: rerun_month_taken"), rerun


# ── S8 — overtaken by a newer upload ──────────────────────────────────


@pytest.mark.parametrize("when", ["before_the_run_executes", "in_the_middle_of_the_run"])
def test_a_rerun_overtaken_by_a_newer_upload_leaves_the_newer_documents_month_exactly(app, gw, monkeypatch, when):
    """S8. The re-run was accepted. Then the same company's December is
    uploaded AGAIN (a newer file) and its run takes the month over — before
    the re-run's own run executes, or while it is going. The re-run is
    refused where it would insert its staged row, or at its takeover: the
    month is the NEWER document's analysis exactly, nothing is left staged,
    and the superseded document keeps the marker that names its replacement
    (never "the re-run did not finish" over it)."""
    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B), RuntimeError(W.PROVIDER_ERROR_TEXT)])
    assert O._retry(app, w["org"], w["doc1"]).status_code == 202
    newer = {}  # type: Dict[str, Any]

    def the_newer_upload_takes_the_month() -> None:
        second = V.one_tap(app, W._corrected_december(), "balanta_corectata.xlsx")
        doc2 = second["commit"]["document_id"]
        P._run_pipeline_sync(doc2)
        (d2,) = gw.docs(id=doc2)
        assert d2["status"] == "analyzed" and d2["period_id"] == w["month"], (d2["status"], d2.get("error"))
        newer.update(id=doc2, month=O._month_view(app, gw, w["org"], w["month"]))

    if when == "before_the_run_executes":
        the_newer_upload_takes_the_month()
    else:
        real_compute = P.stage_compute

        def compute(doc: Dict[str, Any], *a: Any, **kw: Any) -> Any:
            if not newer and doc["id"] == w["doc1"]:
                newer["started"] = True
                the_newer_upload_takes_the_month()
            return real_compute(doc, *a, **kw)

        monkeypatch.setattr(P, "stage_compute", compute)

    P._run_pipeline_sync(w["doc1"])

    assert newer.get("id"), "the scenario never happened"
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == w["month"] and period["source_document_id"] == newer["id"], (
        [(p["id"], p["source_document_id"]) for p in gw.db.rows("financial_periods")])
    assert O._month_view(app, gw, w["org"], w["month"]) == newer["month"], \
        "the overtaken re-run changed the newer document's month"
    assert newer["month"]["briefing"]["body"] == W.BODY_B
    for table in W._PERIOD_CHILD_TABLES:
        assert [x for x in gw.db.rows(table) if x.get("period_id") != w["month"]] == [], table
    (d1,) = gw.docs(id=w["doc1"])
    assert d1["deleted_at"] is not None and d1["error"] == "superseded_by:%s" % newer["id"], d1
    assert d1["status"] == "analyzed"
    assert P._STAGED_RERUNS == {}


# ── S10 — the document, or its period, deleted while (or after) a re-run ──


def _a_stranded_committed_row(app, gw, monkeypatch, tmp_path, w: Dict[str, Any]) -> str:
    """A re-run of `w["doc1"]` whose process died inside its takeover, right
    after the month's briefing was deleted (the commit point is behind it).
    Returns the staged row's id."""
    import rerun_restart_lib as R
    with pytest.MonkeyPatch.context() as mp:
        seen = R.kill_after(gw, mp, tmp_path / "unused.pickle", "delete", "briefings",
                            when=lambda payload, filters: filters == {"period_id": "eq.%s" % w["month"]})
        assert O._retry(app, w["org"], w["doc1"]).status_code == 202
        with pytest.raises(R.Kill):
            P._run_pipeline_sync(w["doc1"])
        assert seen["fired"]
    (staged,) = [p for p in gw.db.rows("financial_periods") if SR.marker_of(p)]
    assert staged["assembled_canonical_v1"][MARKER_KEY]["takeover_began_at"]
    return str(staged["id"])


@pytest.mark.parametrize("route", ["permanent", "clear_deleted"])
@pytest.mark.parametrize("stranded", ["an_uncommitted_row", "a_committed_row"])
def test_a_permanent_delete_takes_the_documents_staged_rows_with_it(app, gw, monkeypatch, tmp_path, route, stranded):
    """S10. A staged row names NO source: no foreign key takes it with its
    document. A document deleted for good — "Delete forever", or "Clear all"
    on the shelf — takes the staged row of a re-run of it along, at once and
    explicitly (never resumed: the month goes with the document)."""
    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B)])
    if stranded == "an_uncommitted_row":
        staged = str(_plant_a_staged_row(gw, w)["id"])
        gw.db.add("statement_line_items", {"period_id": staged, "statement": "pl", "bucket": "revenue",
                                           "ro_account_code": "707", "amount": 1.0})
    else:
        staged = _a_stranded_committed_row(app, gw, monkeypatch, tmp_path, w)
    headers = V._headers(V.USER, w["org"])
    assert V._http(app).delete("/api/documents/%s" % w["doc1"], headers=headers).status_code == 200

    if route == "permanent":
        r = V._http(app).delete("/api/documents/%s/permanent" % w["doc1"], headers=headers)
    else:
        r = V._http(app).delete("/api/documents/clear-deleted", headers=headers)

    assert r.status_code == 200, (r.status_code, r.text[:300])
    assert gw.docs(id=w["doc1"]) == []
    assert [p["id"] for p in gw.db.rows("financial_periods") if p["id"] == staged] == [], (
        "the staged row of a document deleted for good is still there")
    for table in W._PERIOD_CHILD_TABLES:
        assert [x for x in gw.db.rows(table) if str(x.get("period_id")) == staged] == [], table


def _refuse_children_of_a_missing_period(gw, monkeypatch) -> None:
    """Production's foreign keys once more, the INSERT side (the double models
    none): a row for a period that does not exist is refused. After a period
    row is gone, a run that is still going cannot leave rows under its id."""
    for op in ("insert", "upsert"):
        real = getattr(gw.db, op)

        def call(table: str, rows: Any, *args: Any, _real: Any = real, **kwargs: Any) -> Any:
            if table in W._PERIOD_CHILD_TABLES:
                known = set(str(p["id"]) for p in gw.db.rows("financial_periods"))
                for row in (rows if isinstance(rows, list) else [rows]):
                    if str(row.get("period_id")) not in known:
                        raise RuntimeError('insert or update on table "%s" violates foreign key constraint '
                                           '(period_id)' % table)
            return _real(table, rows, *args, **kwargs)

        monkeypatch.setattr(gw.db, op, call)


#: What the user does while the staged run is going.
_MID_RUN = {
    # "Delete" in the Docs panel: restorable; the run completes on the month.
    "the_document_is_soft_deleted": "soft",
    # "Delete", then "Delete forever": the document — and, by production's
    # foreign key, the period it is the source of — are gone.
    "the_document_is_deleted_for_good": "permanent",
    # "Clear period" on the month.
    "the_period_is_cleared": "period",
}


@pytest.mark.parametrize("what", sorted(_MID_RUN))
def test_a_document_or_period_deleted_mid_run_is_never_resurrected(app, gw, monkeypatch, what):
    """S10. The user acts on the document or its month while the staged
    re-run is going. Soft-deleted: the run completes on the month (the file
    is restorable with its fresh analysis). Deleted for good, or its period
    cleared: the month is gone by the user's action — the run does not bring
    it back, and leaves nothing under its staged id."""
    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B)])
    _refuse_children_of_a_missing_period(gw, monkeypatch)
    headers = V._headers(V.USER, w["org"])
    real_compute = P.stage_compute
    acted = []  # type: List[int]

    def compute(*a: Any, **kw: Any) -> Any:
        if not acted:
            http = V._http(app)
            if _MID_RUN[what] == "period":
                acted.append(http.delete("/api/period/%s" % w["month"], headers=headers).status_code)
            else:
                acted.append(http.delete("/api/documents/%s" % w["doc1"], headers=headers).status_code)
                if _MID_RUN[what] == "permanent":
                    acted.append(http.delete("/api/documents/%s/permanent" % w["doc1"], headers=headers).status_code)
                    # production's foreign key: the period goes with the
                    # document it names as its source (ON DELETE CASCADE).
                    gw.db.delete("financial_periods", filters={"source_document_id": "eq.%s" % w["doc1"]})
        return real_compute(*a, **kw)

    monkeypatch.setattr(P, "stage_compute", compute)
    assert O._retry(app, w["org"], w["doc1"]).status_code == 202

    P._run_pipeline_sync(w["doc1"])

    assert acted and all(code == 200 for code in acted), acted
    periods = gw.db.rows("financial_periods")
    assert [p for p in periods if SR.marker_of(p)] == [], "a staged row was left behind"
    known = set(str(p["id"]) for p in periods)
    for table in W._PERIOD_CHILD_TABLES:
        assert [x for x in gw.db.rows(table) if str(x.get("period_id")) not in known] == [], table
    if _MID_RUN[what] == "soft":
        (period,) = periods
        assert period["id"] == w["month"] and period["source_document_id"] == w["doc1"]
        (doc,) = gw.docs(id=w["doc1"])
        assert doc["deleted_at"] is not None and doc["status"] == "analyzed" and doc["error"] is None, doc
        assert [b["body"] for b in gw.db.rows("briefings")] == [W.BODY_B]      # the run's analysis
    else:
        assert [p["id"] for p in periods if p["org_id"] == w["org"]] == [], (
            "a month its user removed was brought back: %r" % [(p["id"], p["source_document_id"]) for p in periods])
        assert [b for b in gw.db.rows("briefings") if b["org_id"] == w["org"]] == []


# ── a dead run's committed row, at the document's next click ──────────


def test_a_rerun_is_not_started_over_an_interrupted_takeover_that_cannot_be_completed(
        app, gw, monkeypatch, tmp_path):
    """A re-run of the document died inside its takeover; its committed row
    is stranded. The document's next "Re-run analysis" FIRST completes that
    takeover. When the completion is refused (the database times out), the
    re-run is NOT started — a second staged run over a month that is mid-
    replacement would later be resumed over by the older one: 503
    `rerun_unavailable`, the committed row still there, the row still saying
    "interrupted". A moment later it completes and the re-run starts."""
    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B), RuntimeError(W.PROVIDER_ERROR_TEXT)])
    staged = _a_stranded_committed_row(app, gw, monkeypatch, tmp_path, w)
    (doc,) = gw.docs(id=w["doc1"])
    assert doc["error"] == INTERRUPTED and doc["status"] == "analyzed", doc
    assert P._STAGED_RERUNS == {}                               # the dead run's note went with it
    enqueued_before = list(gw.enqueued)
    with pytest.MonkeyPatch.context() as mp:
        _refuse_writes(gw, mp, "update", "briefings")           # the resume's move of the briefing times out

        r = O._retry(app, w["org"], w["doc1"])

    assert r.status_code == 503 and r.json() == O.REFUSED_UNAVAILABLE, (r.status_code, r.text[:300])
    assert gw.enqueued == enqueued_before and w["doc1"] not in P._STAGED_RERUNS
    assert [p["id"] for p in gw.db.rows("financial_periods") if SR.marker_of(p)] == [staged], \
        "the committed row was dropped"
    assert gw.docs(id=w["doc1"])[0]["error"] == INTERRUPTED

    again = W._docs_panel_rerun(app, gw, dict(w, org_id=w["org"]))

    assert again["status"] == "analyzed" and again["error"] is None, (again["status"], again.get("error"))
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == w["month"] and MARKER_KEY not in period["assembled_canonical_v1"]
    # The interrupted run's OWN briefing and recommendations are the month's
    # (this re-run's narration failed: kept, and marked).
    (briefing,) = gw.db.rows("briefings")
    assert briefing["body"] == W.BODY_B and briefing["stale_reason"] == "provider_error", briefing
    assert sorted(x["title"] for x in gw.db.rows("recommendations")) == W.TITLES_B


# ══════════════════════════════════════════════════════════════════════
# S20 — censuses
# ══════════════════════════════════════════════════════════════════════

ENGINE_SRC = O.ENGINE_SRC


def test_census_nothing_of_a_rerun_is_held_in_process_memory_or_reinserted():
    """THE CARRY IS GONE, and nothing like it is back.
      · no `_RERUN_CARRY` (and none of its helpers) in the engine — every
        `assert P._RERUN_CARRY == {}` of gate briefing-keep-last-good became
        this one line;
      · `recommendations` rows are INSERTED in one place only, the narrative
        stage — a recommendation a user worked is never re-inserted by id
        (the carry did; a primary-key conflict waited there);
      · the one in-process note a re-run has (`_STAGED_RERUNS`: which entry
        started the run — nothing a restart needs) is reset per test."""
    for name in ("_RERUN_CARRY", "_RERUN_CARRY_LOCK", "_carry_before_rerun_reset", "_rerun_carry_of",
                 "_drop_rerun_carry", "_restore_carried_recommendations", "_write_carried_briefing",
                 "_restore_rerun_carry", "_RECOMMENDATION_REKEYED_COLUMNS"):
        assert not hasattr(P, name), "pipeline.%s is back" % name
    source = (ENGINE_SRC / "api" / "pipeline.py").read_text(encoding="utf-8")
    assert "carry_settled" not in source
    inserts = []  # type: List[str]
    for path in sorted(ENGINE_SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for node in ast.walk(fn):
                if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                        and node.func.attr in ("insert", "upsert") and node.args
                        and isinstance(node.args[0], ast.Constant) and node.args[0].value == "recommendations"):
                    inserts.append("%s:%s" % (path.relative_to(ENGINE_SRC).as_posix(), fn.name))
    assert sorted(set(inserts)) == ["api/pipeline.py:stage_persist_narrative"], (
        "recommendations are inserted outside the narrative stage: %r" % sorted(set(inserts)))
    conftest = (O.REPO / "tests" / "engine" / "conftest.py").read_text(encoding="utf-8")
    assert 'monkeypatch.setattr(_pipeline, "_STAGED_RERUNS", {})' in conftest
    assert P._STAGED_RERUNS == {}


def test_the_codes_a_reruns_row_can_carry_are_the_ones_the_docs_panel_knows():
    """`documents.error` of a re-run that did not finish: the prefix and the
    two codes the Docs panel has a sentence for (frontend/lib/
    rerunRefusals.ts holds the same three literals — gate
    rerun-refusal-surfaces reads them there)."""
    assert (P.RERUN_FAILED_PREFIX, P.RERUN_INTERRUPTED, P.RERUN_MONTH_TAKEN) == (
        RERUN_FAILED_PREFIX, "interrupted_replacing", "rerun_month_taken")
    assert str(P.RerunMonthTaken()) == "rerun_month_taken" and str(P.RerunOvertaken()) == "document_superseded"
    frontend = (O.REPO / "frontend" / "lib" / "rerunRefusals.ts").read_text(encoding="utf-8")
    for literal in ('"rerun_failed: "', '"interrupted_replacing"', '"rerun_month_taken"'):
        assert literal in frontend, "frontend/lib/rerunRefusals.ts does not hold %s" % literal


# ══════════════════════════════════════════════════════════════════════
# REVIEW OF 2026-10-05 — what the first three stages left unheld
# ══════════════════════════════════════════════════════════════════════
#
# S23 — ONE TAKEOVER OF A COMPANY'S MONTHS AT A TIME: two real threads
# ──────────────────────────────────────────────────────────────────────

THIRD_BODY = "Al treilea comentariu: cel al fișierului încărcat din nou."
THIRD_TITLES = ["Recomandarea fișierului nou"]

#: How long the re-run's thread waits, inside its apply, for the other
#: writer to either FINISH its takeover (no lock: milliseconds on this
#: store) or stand at the takeover's door (the lock: for ever).
_GRACE_S = 1.5


def _ids_added(db: Any, table: str, call: Any) -> List[str]:
    before = set(str(r.get("id")) for r in db.rows(table))
    call()
    return sorted(set(str(r.get("id")) for r in db.rows(table)) - before)


@pytest.mark.parametrize("at", ["the_first_statement_on_the_month", "before_the_months_row_takes_the_columns"])
def test_a_newer_uploads_takeover_never_runs_through_the_middle_of_a_reruns_apply(app, gw, monkeypatch, at):
    """TWO WRITERS ON ONE MONTH, as production runs them: each run is its own
    thread (`_enqueue`). doc1's staged re-run is past its last ownership look
    and INSIDE its apply when doc2 — the same December, another file — is
    uploaded and its whole run reaches its takeover.

    Unserialised (review 2026-10-05, measured at these two statement
    boundaries): the month's row named doc2 over doc1's statements, briefing
    and recommendations (or doc2's rows under doc1's envelope), doc1 archived
    with its superseded marker erased, no staged row left to resume and
    nothing saying so.

    The takeover — T0 included — runs under the company's lock: the upload's
    takeover WAITS at the door (asserted: it was standing there while the
    re-run was still applying), then takes over a month that is whole. The
    end state is exactly an upload over a finished re-run: the month is
    doc2's — its row, its envelope, every line item and metric its run
    wrote, its briefing and recommendations — and doc1 is archived, the
    marker naming its replacement."""
    import threading

    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B), W._reply(THIRD_BODY, THIRD_TITLES)])
    revenue_before = V._served(app, w["org"], w["month"])["revenue"]
    second = V.one_tap(app, W._corrected_december(), "balanta_corectata.xlsx")   # committed, not yet run
    doc2 = second["commit"]["document_id"]
    assert O._retry(app, w["org"], w["doc1"]).status_code == 202
    month = w["month"]
    a_in_apply, b_at_its_takeover = threading.Event(), threading.Event()
    seen = {"paused": False, "b_was_waiting_at_the_door": None, "errors": []}  # type: Dict[str, Any]
    written_by = {}  # type: Dict[str, List[str]]
    threads = {}  # type: Dict[str, Any]
    real_insert, real_delete, real_update = gw.db.insert, gw.db.delete, gw.db.update
    real_finalize = P._finalize_same_month_takeover

    def pause_the_rerun() -> None:
        """The re-run's thread, inside its apply, lets the other writer go."""
        seen["paused"] = True
        a_in_apply.set()
        if not b_at_its_takeover.wait(120):
            seen["errors"].append("the upload's run never reached its takeover")
            return
        threads["b"].join(timeout=_GRACE_S)
        seen["b_was_waiting_at_the_door"] = threads["b"].is_alive()

    def on_thread_a() -> bool:
        return threading.current_thread() is threads.get("a") and not seen["paused"]

    def delete(table: str, *a: Any, **kw: Any) -> Any:
        if (at == "the_first_statement_on_the_month" and on_thread_a() and table == "statement_line_items"
                and (kw.get("filters") or {}) == {"period_id": "eq.%s" % month}):
            pause_the_rerun()
        return real_delete(table, *a, **kw)

    def update(table: str, *a: Any, **kw: Any) -> Any:
        payload = a[0] if a else None
        if (at == "before_the_months_row_takes_the_columns" and on_thread_a() and table == "financial_periods"
                and (kw.get("filters") or {}).get("id") == "eq.%s" % month
                and isinstance(payload, dict) and "assembled_canonical_v1" in payload):
            pause_the_rerun()
        return real_update(table, *a, **kw)

    def insert(table: str, *a: Any, **kw: Any) -> Any:
        if table not in ("statement_line_items", "calculated_metrics") or threading.current_thread() is not threads.get("b"):
            return real_insert(table, *a, **kw)
        out = []  # type: List[Any]
        written_by.setdefault(table, []).extend(_ids_added(gw.db, table, lambda: out.append(real_insert(table, *a, **kw))))
        return out[0]

    def finalize(doc: Dict[str, Any], period_id: str, **kw: Any) -> Any:
        if threading.current_thread() is threads.get("b"):
            b_at_its_takeover.set()
        return real_finalize(doc, period_id, **kw)

    monkeypatch.setattr(gw.db, "delete", delete)
    monkeypatch.setattr(gw.db, "update", update)
    monkeypatch.setattr(gw.db, "insert", insert)
    monkeypatch.setattr(P, "_finalize_same_month_takeover", finalize)

    def run(name: str, document_id: str, wait_for: Any = None) -> None:
        try:
            if wait_for is not None and not wait_for.wait(120):
                seen["errors"].append("%s: the re-run never reached its apply" % name)
                return
            P._run_pipeline_sync(document_id)
        except BaseException as exc:  # noqa: BLE001 — reported in the main thread
            seen["errors"].append("%s: %r" % (name, exc))

    threads["a"] = threading.Thread(target=run, args=("the re-run", w["doc1"]))
    threads["b"] = threading.Thread(target=run, args=("the upload", doc2, a_in_apply))
    for t in threads.values():
        t.start()
    for t in threads.values():
        t.join(300)
    assert not any(t.is_alive() for t in threads.values()), "a run never ended (a deadlock?)"
    assert seen["errors"] == [], seen["errors"]
    assert seen["paused"], "the scenario never happened: the re-run never reached that statement"
    # THE UPLOAD'S TAKEOVER WAITED while the re-run was inside its apply.
    assert seen["b_was_waiting_at_the_door"] is True, (
        "the upload's takeover ran THROUGH the re-run's apply (it finished while the re-run stood "
        "between two statements of its own)")

    # THE END STATE: an upload over a finished re-run — the month is doc2's, whole.
    (period,) = [p for p in gw.db.rows("financial_periods") if p["org_id"] == w["org"]]
    assert period["id"] == month and period["source_document_id"] == doc2, period
    envelope = period["assembled_canonical_v1"]
    assert MARKER_KEY not in envelope and envelope["provenance"]["source_document_id"] == doc2, (
        "the month's row names the new file over an envelope built from %r"
        % envelope["provenance"]["source_document_id"])
    for table in ("statement_line_items", "calculated_metrics"):
        assert written_by.get(table), "the upload's run wrote no %s: the check is vacuous" % table
        under_the_month = _rows_by_id(gw, table, month)
        # (a run replaces one of its own metric rows — the statutory anchor —
        # so what it WROTE is a superset of what it left)
        assert under_the_month and set(under_the_month) <= set(written_by[table]), (
            "%s under the month hold rows the upload's run did not write: %r"
            % (table, sorted(set(under_the_month) - set(written_by[table]))[:3]))
    for table in W._PERIOD_CHILD_TABLES:
        assert [x for x in gw.db.rows(table) if x.get("period_id") != month] == [], table
    served = V._served(app, w["org"], month)
    assert served["source_document"] == doc2 and served["revenue"] != revenue_before, served
    (briefing,) = gw.db.rows("briefings")
    assert briefing["body"] == THIRD_BODY and briefing["stale_since"] is None, briefing
    assert sorted(x["title"] for x in gw.db.rows("recommendations")) == THIRD_TITLES
    (d1,) = gw.docs(id=w["doc1"])
    assert d1["deleted_at"] is not None and d1["error"] == "superseded_by:%s" % doc2 and \
        d1["status"] == "analyzed", "the archived document does not say what replaced it: %r" % (
            (d1["status"], d1["error"], d1["deleted_at"]),)
    (d2,) = gw.docs(id=doc2)
    assert (d2["status"], d2["error"], d2["period_id"], d2["deleted_at"]) == ("analyzed", None, month, None), d2
    assert P._STAGED_RERUNS == {} and P._TAKEOVERS_BY_RUN == {}


# ──────────────────────────────────────────────────────────────────────
# S24 — a marker is browser-writable: a forged one never crosses companies
# ──────────────────────────────────────────────────────────────────────

FOREIGN_DOC = "f0e16000-0000-4000-8000-00000000d0c1"
FOREIGN_PID = "f0e16000-0000-4000-8000-00000000f0e1"


def _a_month_of_the_other_company(gw) -> None:
    """A whole month of ANOTHER company (the outsider's), with children."""
    org = V.WU.ORG_OUTSIDE
    gw.db.add("documents", {"id": FOREIGN_DOC, "org_id": org, "status": "analyzed", "period_id": FOREIGN_PID,
                            "scope": "financial", "original_filename": "balanta_lor.xlsx", "deleted_at": None,
                            "error": None})
    gw.db.add("financial_periods", {"id": FOREIGN_PID, "org_id": org, "currency": "RON",
                                    "period_start": "2025-12-31", "period_end": "2025-12-31",
                                    "source_document_id": FOREIGN_DOC,
                                    "assembled_canonical_v1": {"provenance": {"source_document_id": FOREIGN_DOC}}})
    gw.db.add("briefings", {"period_id": FOREIGN_PID, "org_id": org, "body": "Comentariul altei companii.",
                            "language": "ro"})
    gw.db.add("statement_line_items", {"period_id": FOREIGN_PID, "statement": "pl", "bucket": "revenue",
                                       "ro_account_code": "707", "amount": 1.0})
    gw.db.add("recommendations", {"period_id": FOREIGN_PID, "org_id": org, "title": "A lor", "status": "in_review"})
    gw.db.add("alerts", {"period_id": FOREIGN_PID, "org_id": org, "alert_key": "x:%s" % FOREIGN_PID,
                         "document_id": FOREIGN_DOC})


def _forge_a_committed_marker(gw, *, in_org: str, row_id: str, document_id: str, served: str) -> None:
    """What a member can INSERT for their own company (`financial_periods`
    is member-writable, envelope included): a source-less row whose marker
    says a takeover of `served` by `document_id` has begun and that the run
    stored nothing in ANY table — applied, it empties the month."""
    gw.db.add("financial_periods", {
        "id": row_id, "org_id": in_org, "currency": "RON", "period_start": "2025-12-31",
        "period_end": "2025-12-31", "source_document_id": None,
        "assembled_canonical_v1": {MARKER_KEY: {
            "document_id": document_id, "served_period_id": served, "staged_at": "2020-01-01T00:00:00+00:00",
            "takeover_began_at": "2020-01-01T00:00:01+00:00", "keep_briefing_reason": None,
            "emptied": list(_RUN_TABLES), "kept": []}}})


def _everything_of(gw, org_id: str, period_id: str, document_id: str) -> str:
    return json.dumps({"rows": V._rows_under(gw, period_id),
                       "period": [p for p in gw.db.rows("financial_periods") if p["id"] == period_id],
                       "document": [d for d in gw.db.rows("documents") if d["id"] == document_id],
                       "org": org_id}, sort_keys=True, default=str)


@pytest.mark.parametrize("through", ["the_company_pass", "the_page_mount_watchdog", "the_documents_own_cleanup"])
def test_a_forged_committed_marker_never_reaches_another_companys_month(app, gw, monkeypatch, through):
    """THE MARKER LIVES IN A COLUMN THE BROWSER WRITES. `served_period_id`
    and `document_id` of a staged row are, in the worst case, another
    tenant's input — and the apply deletes by them under the SERVICE ROLE.
    The company in the applier's two reads (the month, the document) is the
    whole wall, and no law held it (review 2026-10-05: with `org_id` removed
    there, every gate stayed green and a marker forged in one company
    emptied another company's month).

    Both directions: a marker forged in the OUTSIDER's company naming MY
    month and MY document, and one forged in MINE naming THEIRS. After every
    way a staged row is cleaned up — a company pass, the page-mount
    watchdog, a document's own cleanup — the named month, its row and its
    document are byte-identical, and the forged row is gone (there is
    nothing to apply it ONTO in the company it sits in)."""
    w = O._own_month(app, gw, monkeypatch, [])
    _a_month_of_the_other_company(gw)
    mine = _everything_of(gw, w["org"], w["month"], w["doc1"])
    theirs = _everything_of(gw, V.WU.ORG_OUTSIDE, FOREIGN_PID, FOREIGN_DOC)
    _forge_a_committed_marker(gw, in_org=V.WU.ORG_OUTSIDE, row_id="f0e16000-0000-4000-8000-0000000057a6",
                              document_id=w["doc1"], served=w["month"])
    _forge_a_committed_marker(gw, in_org=w["org"], row_id="a9a50000-0000-4000-8000-0000000057a6",
                              document_id=FOREIGN_DOC, served=FOREIGN_PID)

    if through == "the_company_pass":
        outcomes = [P._clear_staged_rerun_rows(gw.db, org, ttl=True) for org in (V.WU.ORG_OUTSIDE, w["org"])]
    elif through == "the_page_mount_watchdog":
        outcomes = []
        for user in (V.OUTSIDER, V.USER):
            r = V._http(app).post("/api/pipeline/recover-stuck", headers=V._headers(user))
            assert r.status_code == 200, r.text[:300]
            assert r.json()["resumed_reruns"] == 0, r.json()
            outcomes.append({"resumed": r.json()["resumed_reruns"]})
    else:
        outcomes = [P._clear_staged_rerun_rows(gw.db, V.WU.ORG_OUTSIDE, document_id=w["doc1"]),
                    P._clear_staged_rerun_rows(gw.db, w["org"], document_id=FOREIGN_DOC)]

    assert all(o["resumed"] == 0 for o in outcomes), "a forged marker was APPLIED: %r" % outcomes
    assert _everything_of(gw, w["org"], w["month"], w["doc1"]) == mine, \
        "a marker forged in another company changed MY month"
    assert _everything_of(gw, V.WU.ORG_OUTSIDE, FOREIGN_PID, FOREIGN_DOC) == theirs, \
        "a marker forged in my company changed ANOTHER company's month"
    assert [p["id"] for p in gw.db.rows("financial_periods") if SR.marker_of(p)] == [], \
        "a forged staged row is still there"
    # The owner's month is still served, and still re-runs.
    assert V._served(app, w["org"], w["month"])["source_document"] == w["doc1"]


def test_the_appliers_reads_of_the_month_and_the_document_name_the_company():
    """The same wall, at its own seam: every read the applier makes of the
    month its marker names and of the document its marker names carries the
    company of the STAGED row — and so does every write on either."""
    double = _seam_world("the_narration_worked")
    double.arm(_commit_index(_uninterrupted("the_narration_worked")) + 2)
    with pytest.raises(_Kill):
        _staged_takeover(double, "the_narration_worked")
    double.arm(None)
    double.calls[:] = []
    double.writes[:] = []

    assert P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID)["resumed"] == 1

    reads = [(table, filters) for op, table, filters, _columns in double.calls
             if op == "select" and table in ("financial_periods", "documents")]
    assert len(reads) >= 4, "the applier read the month and the document %d time(s)" % len(reads)
    for table, filters in reads:
        assert filters.get("org_id") == "eq.%s" % ORG, "%s was read without the company: %r" % (table, filters)
    for write in double.writes:
        if write["table"] in ("financial_periods", "documents"):
            assert write["filters"].get("org_id") == "eq.%s" % ORG, write


# ──────────────────────────────────────────────────────────────────────
# S25 — a run settles its OWN document's leftover before it writes
# ──────────────────────────────────────────────────────────────────────


def _november(app, gw) -> Dict[str, Any]:
    out = V.one_tap(app, V.agras_workbook(period_line="Balanta de verificare la data de 30.11.2025"),
                    "balanta_noiembrie.xlsx")
    return V.run_analysis(gw, out["commit"]["document_id"])


def test_an_in_place_run_first_completes_its_own_documents_interrupted_rerun(app, gw, monkeypatch, tmp_path):
    """Measured on the stage-3 tip (review 2026-10-05). A document that is
    `failed` over its period; its staged re-run dies inside its takeover (a
    committed row is stranded); the failed banner's Retry — POST
    /api/pipeline/run, a NON-staged run that writes the month in place — is
    accepted. Its own company pass skipped the stranded row (its document
    was in flight: this very run) at ANY age; the month became the in-place
    run's analysis; and the company's next analysis RESUMED the old row over
    it: the OLDER re-run's briefing on the newer run's statements and
    recommendations, unmarked.

    The run holds its document's claim, so no other run of that document is
    alive here: its leftover is settled FIRST — the interrupted takeover is
    completed, then the run writes. Nothing is left to resume; the month is
    the in-place run's analysis, whole, and stays so."""
    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B), W._reply(THIRD_BODY, THIRD_TITLES),
                                           W._reply("Comentariul lunii noiembrie.", ["Pentru noiembrie"])])
    (d1,) = gw.docs(id=w["doc1"])
    d1["status"], d1["error"] = "failed", "RuntimeError: an earlier in-place run failed"
    staged = _a_stranded_committed_row(app, gw, monkeypatch, tmp_path, w)
    assert gw.docs(id=w["doc1"])[0]["error"] == INTERRUPTED
    applied = []  # type: List[str]
    real_apply = P._apply_committed_staged_rerun

    def apply(admin_client: Any, org_id: str, staged_id: str) -> str:
        outcome = real_apply(admin_client, org_id, staged_id)
        applied.append("%s:%s" % (staged_id, outcome))
        return outcome

    monkeypatch.setattr(P, "_apply_committed_staged_rerun", apply)
    # … BEFORE ITS FIRST STAGE: while this run reads its file, every other
    # document's pass must skip the row (its document is in flight) — and a
    # same-month upload finishing in that time would take over a month that
    # is mid-replacement.
    real_extract = P.stage_extract
    staged_when_the_file_was_read = []  # type: List[List[str]]

    def extract(doc: Dict[str, Any]) -> Any:
        staged_when_the_file_was_read.append([str(p["id"]) for p in gw.db.rows("financial_periods")
                                              if SR.marker_of(p)])
        return real_extract(doc)

    monkeypatch.setattr(P, "stage_extract", extract)

    r = V._http(app).post("/api/pipeline/run", headers=V._headers(V.USER, w["org"]),
                          json={"document_id": w["doc1"], "output_language": "ro"})
    assert r.status_code == 202, (r.status_code, r.text[:300])
    assert w["doc1"] not in P._STAGED_RERUNS, "the failed banner's Retry is an in-place run"
    done = V.run_analysis(gw, w["doc1"])

    assert staged_when_the_file_was_read == [[]], (
        "the interrupted re-run was still stranded while the run read its file: %r"
        % staged_when_the_file_was_read)

    assert (done["status"], done["error"], done["period_id"]) == ("analyzed", None, w["month"]), done
    assert applied == ["%s:resumed" % staged], (
        "the run did not settle its own document's interrupted re-run before it wrote: %r" % applied)
    assert [p["id"] for p in gw.db.rows("financial_periods") if SR.marker_of(p)] == [], \
        "the older re-run's committed row is still waiting to be resumed OVER this run"

    def the_month() -> Dict[str, Any]:
        return {"briefing": [(b["body"], b.get("stale_reason")) for b in gw.db.rows("briefings")
                             if b["period_id"] == w["month"]],
                "recommendations": sorted(x["title"] for x in gw.db.rows("recommendations")
                                          if x["period_id"] == w["month"]),
                "rows": V._rows_under(gw, w["month"])}

    after_the_run = the_month()
    assert after_the_run["briefing"] == [(THIRD_BODY, None)], after_the_run["briefing"]
    assert after_the_run["recommendations"] == THIRD_TITLES
    # … AND IT STAYS: the company's next analysis, long after, changes nothing of December.
    monkeypatch.setattr(P, "STAGED_RERUN_TTL_S", -1)
    november = _november(app, gw)
    assert november["status"] == "analyzed", (november["status"], november.get("error"))
    assert the_month() == after_the_run, "a later run of the company changed the month again"
    assert applied == ["%s:resumed" % staged]


def test_a_run_whose_own_interrupted_rerun_cannot_be_completed_stops_before_it_writes(
        app, gw, monkeypatch, tmp_path):
    """…and when that leftover CANNOT be completed now (the database refuses
    a write of the resume), the run does not write its month under it —
    whatever it wrote would be undone, in part, by the later resume. Refused
    with a sentence, before the month lookup: no statement of this run names
    the month, and the committed row is still there to be completed."""
    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B), W._reply(THIRD_BODY, THIRD_TITLES)])
    (d1,) = gw.docs(id=w["doc1"])
    d1["status"], d1["error"] = "failed", "RuntimeError: an earlier in-place run failed"
    staged = _a_stranded_committed_row(app, gw, monkeypatch, tmp_path, w)
    rows_before = V._rows_under(gw, w["month"])
    r = V._http(app).post("/api/pipeline/run", headers=V._headers(V.USER, w["org"]),
                          json={"document_id": w["doc1"], "output_language": "ro"})
    assert r.status_code == 202, (r.status_code, r.text[:300])
    with pytest.MonkeyPatch.context() as mp:
        refused = _refuse_writes(gw, mp, "update", "briefings")      # the resume's move of the briefing
        spy = W._Spy(gw.db, mp)
        done = V.run_analysis(gw, w["doc1"])

    assert refused, "the scenario never happened"
    assert done["status"] == "failed" and "interrupted" in str(done["error"]) and \
        "Try again" in str(done["error"]), (done["status"], done["error"])
    assert [p["id"] for p in gw.db.rows("financial_periods") if SR.marker_of(p)] == [staged], \
        "the committed row was dropped"
    in_place = [(x["op"], x["table"]) for x in spy.writes
                if x["op"] == "insert" and x["table"] in ("statement_line_items", "calculated_metrics")]
    assert in_place == [], "the run wrote its statements under an interrupted takeover: %r" % in_place
    assert V._rows_under(gw, w["month"])["calculated_metrics"] == rows_before["calculated_metrics"]


def test_a_run_whose_staged_rows_cannot_be_listed_stops_before_it_writes(app, gw, monkeypatch, tmp_path):
    """…and when the staged rows cannot even be LISTED while this run goes
    (a store timeout), nothing is known: a committed row of this document's
    earlier re-run may be waiting. The run used to go on — the pass's
    `left_documents` being empty — write its month under its own committed
    row, and be resumed OVER by it at the company's next pass: the OLDER
    re-run's briefing on the in-place run's statements, unmarked
    (re-verification 2026-10-10, measured on S25's world). The route refuses
    the same state with 503; the run refuses it before any write — no
    statement of this run names the month, the committed row is still there
    to be completed, and the run's row says why. (The failure handler of a
    staged re-run already keeps `interrupted` in that state — S28.)"""
    import httpx
    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B), W._reply(THIRD_BODY, THIRD_TITLES)])
    (d1,) = gw.docs(id=w["doc1"])
    d1["status"], d1["error"] = "failed", "RuntimeError: an earlier in-place run failed"
    staged = _a_stranded_committed_row(app, gw, monkeypatch, tmp_path, w)
    rows_before = V._rows_under(gw, w["month"])
    r = V._http(app).post("/api/pipeline/run", headers=V._headers(V.USER, w["org"]),
                          json={"document_id": w["doc1"], "output_language": "ro"})
    assert r.status_code == 202, (r.status_code, r.text[:300])
    unlisted = []  # type: List[str]
    with pytest.MonkeyPatch.context() as mp:
        def listing(admin_client: Any, org_id: str) -> Any:
            unlisted.append(str(org_id))
            raise httpx.ReadTimeout("The read operation timed out")

        mp.setattr(P, "_staged_rerun_rows", listing)
        spy = W._Spy(gw.db, mp)
        done = V.run_analysis(gw, w["doc1"])

    assert unlisted, "the scenario never happened"
    assert done["status"] == "failed" and "could not be checked" in str(done["error"]) and \
        "Try again" in str(done["error"]), (done["status"], done["error"])
    assert [p["id"] for p in gw.db.rows("financial_periods") if SR.marker_of(p)] == [staged], \
        "the committed row was dropped or resumed blind"
    in_place = [(x["op"], x["table"]) for x in spy.writes
                if x["op"] in ("insert", "upsert") and x["table"] in _RUN_TABLES]
    assert in_place == [], "the run wrote under an interrupted takeover it could not see: %r" % in_place
    assert V._rows_under(gw, w["month"]) == rows_before, "the month changed"

    # CONTROL: the store readable again, the same Retry settles the committed
    # row first and then writes — S25's first law; nothing is left to resume.
    r = V._http(app).post("/api/pipeline/run", headers=V._headers(V.USER, w["org"]),
                          json={"document_id": w["doc1"], "output_language": "ro"})
    assert r.status_code == 202, (r.status_code, r.text[:300])
    done = V.run_analysis(gw, w["doc1"])
    assert (done["status"], done["error"], done["period_id"]) == ("analyzed", None, w["month"]), done
    assert [p["id"] for p in gw.db.rows("financial_periods") if SR.marker_of(p)] == []
    assert [b["body"] for b in gw.db.rows("briefings") if b["period_id"] == w["month"]] == [THIRD_BODY]


# ──────────────────────────────────────────────────────────────────────
# S26 — a re-filed re-run never re-dates its row onto a month that has
#       become another row's
# ──────────────────────────────────────────────────────────────────────

_ANOTHER_DECEMBER_2024 = {"id": "december-2024-of-another-upload", "org_id": ORG, "currency": "RON",
                          "source_document_id": "the-other-uploads-document",
                          "period_start": "2024-12-31", "period_end": "2024-12-31"}


@pytest.mark.parametrize("when", ["while_a_dead_runs_row_waited_to_be_resumed", "between_the_takeovers_look_and_its_row"])
def test_an_apply_never_re_dates_its_row_onto_a_month_that_became_another_rows(when):
    """Measured on the stage-3 tip (review 2026-10-05): the re-run read the
    file as another month, passed its looks (the month was free) and
    committed; an upload for THAT month then created its own period; the
    resume re-dated the document's row onto it — two live periods for one
    month, each with its document. Past the commit point the run's analysis
    is the only whole one there is, so it is applied — and the row KEEPS the
    month it had. One period per month, always."""
    variant = "the_rerun_refiled_the_document"
    whole = _uninterrupted(variant)
    expected = _state(whole)
    (re_dated,) = [p for p in expected["financial_periods"] if p["id"] == PID]
    assert re_dated["period_end"] == "2024-12-31"                  # control: unobstructed, the row IS re-dated
    double = _seam_world(variant)
    if when == "while_a_dead_runs_row_waited_to_be_resumed":
        double.arm(_commit_index(whole) + 2)
        with pytest.raises(_Kill):
            _staged_takeover(double, variant)
        double.arm(None)
        double.add("financial_periods", dict(_ANOTHER_DECEMBER_2024))
        assert P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID)["resumed"] == 1
    else:
        real_update = double.update

        def update(table: str, patch: Dict[str, Any], *, filters: Dict[str, str]) -> Any:
            out = real_update(table, patch, filters=filters)
            if table == "documents" and (patch or {}).get("error") == INTERRUPTED:
                double.add("financial_periods", dict(_ANOTHER_DECEMBER_2024))    # lands right after the commit point
            return out

        double.update = update  # type: ignore[assignment]
        assert _staged_takeover(double, variant) == PID

    after = _state(double)
    months = sorted((p["period_end"], p["id"]) for p in after["financial_periods"] if p["org_id"] == ORG)
    assert months == [("2024-12-31", _ANOTHER_DECEMBER_2024["id"]), ("2025-12-31", PID)], (
        "two live periods for one month (or a period lost): %r" % months)
    (month,) = [p for p in after["financial_periods"] if p["id"] == PID]
    assert (month["period_start"], month["period_end"]) == ("2025-12-01", "2025-12-31"), month
    # … and everything ELSE is the uninterrupted takeover's result: the run's analysis, applied.
    (other,) = [p for p in after["financial_periods"] if p["id"] == _ANOTHER_DECEMBER_2024["id"]]
    assert dict((k, other[k]) for k in _ANOTHER_DECEMBER_2024) == _ANOTHER_DECEMBER_2024, other
    for table in _SEAM_TABLES:
        if table == "financial_periods":
            assert dict(month, period_start="2024-12-31", period_end="2024-12-31") == re_dated
        else:
            assert after[table] == expected[table], table


# ──────────────────────────────────────────────────────────────────────
# S27 — the alerts of a staged re-run, where the legacy unique key is still there
# ──────────────────────────────────────────────────────────────────────


def _the_legacy_alerts_unique(gw, monkeypatch) -> List[List[str]]:
    """`alerts` as supabase/schema.sql creates it and
    schema_phase_notes_period_scope.sql deliberately KEEPS it (its drop is a
    manual step): `unique (org_id, alert_key)` BESIDE the newer
    `unique (period_id, alert_key)`. A write that would leave two rows of
    one company with one key on DIFFERENT periods is refused whole, as
    Postgres refuses it (23505). The council's keys carry no period and are
    left out of the model: only the keys that name a period are compared."""
    import httpx
    refused = []  # type: List[List[str]]

    def clashes(rows: List[Dict[str, Any]], *, ignoring: Any = None) -> List[str]:
        return [str(r.get("alert_key")) for r in rows
                if not str(r.get("alert_key")).startswith("ai_council::")
                and any(x is not ignoring and x.get("org_id") == r.get("org_id")
                        and x.get("alert_key") == r.get("alert_key")
                        and x.get("period_id") != r.get("period_id") for x in gw.db.rows("alerts"))]

    real_upsert = gw.db.upsert

    def upsert(table: str, rows: Any, **kw: Any) -> Any:
        if table == "alerts":
            hit = clashes(rows if isinstance(rows, list) else [rows])
            if hit:
                refused.append(hit)
                raise httpx.HTTPStatusError(
                    "409 duplicate key value violates unique constraint \"alerts_org_id_alert_key_key\"",
                    request=httpx.Request("POST", "https://double.invalid/rest/v1/alerts"),
                    response=httpx.Response(409, json={"code": "23505"}))
        return real_upsert(table, rows, **kw)

    monkeypatch.setattr(gw.db, "upsert", upsert)
    return refused


def test_a_staged_reruns_alerts_replace_the_months_where_the_legacy_unique_key_is_still_on_alerts(
        app, gw, monkeypatch):
    """Measured on the stage-3 tip with that constraint modelled (review
    2026-10-05). The staged run keyed its alerts to the MONTH's id while
    storing them under the STAGED id — the month's own alerts still held
    those very keys, so the whole alerts write was refused (three keys
    collided), the run ended `analyzed` with no error, and the month kept
    the PREVIOUS analysis's alerts on the new statements. A same-month
    re-upload — keyed to its own staged row — was clean.

    The run's alerts are keyed to the row they are stored under; the
    takeover re-keys them to the month once they sit on it. No write is
    refused, none of the previous rows is left, and the keys afterwards are
    what an in-place run would have written."""
    refused = _the_legacy_alerts_unique(gw, monkeypatch)
    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B)])
    assert refused == [] and any(w["month"] in key for key in w["alert_keys"]), w["alert_keys"]
    for alert in gw.db.rows("alerts"):
        alert["title"] = "THE PREVIOUS ANALYSIS'S: %s" % alert.get("title")
    spy = W._Spy(gw.db, monkeypatch)

    assert O._retry(app, w["org"], w["doc1"]).status_code == 202
    rerun = V.run_analysis(gw, w["doc1"])

    assert (rerun["status"], rerun["error"]) == ("analyzed", None), rerun
    assert refused == [], "the re-run's alerts write was refused for the legacy unique key: %r" % refused
    alerts = gw.db.rows("alerts")
    assert [a for a in alerts if str(a.get("title")).startswith("THE PREVIOUS ANALYSIS'S")] == [], \
        "the previous analysis's alerts are still on the month"
    assert sorted(a["alert_key"] for a in alerts) == w["alert_keys"] and \
        all(a["period_id"] == w["month"] for a in alerts), sorted(a["alert_key"] for a in alerts)
    # While the run was going, its alerts never claimed the month's keys.
    (staged,) = _staged_ids(spy)
    written = [row for x in spy.writes if x["op"] == "upsert" and x["table"] == "alerts"
               for row in (x["payload"] if isinstance(x["payload"], list) else [x["payload"]])]
    named = [row["alert_key"] for row in written if not row["alert_key"].startswith("ai_council::")]
    assert named and all(key.endswith(":%s" % staged) for key in named), named


# ──────────────────────────────────────────────────────────────────────
# S28 — five ways to weaken the mechanism that no law held
# ──────────────────────────────────────────────────────────────────────

OTHER_DOCUMENT = "another-document-of-the-company"
OTHER_MONTH = "the-other-documents-own-month"
OTHER_STAGED = "the-other-documents-staged-row"


def _with_another_documents_staged_row(double: _KillingDouble, *, committed: bool) -> None:
    """ANOTHER document of the same company, with its own month and the
    staged row of a re-run of it — committed (a takeover that began) or not."""
    double.add("documents", {"id": OTHER_DOCUMENT, "org_id": ORG, "status": "analyzed", "period_id": OTHER_MONTH,
                             "deleted_at": None, "error": INTERRUPTED if committed else None,
                             "scope": "financial"})
    double.add("financial_periods", {"id": OTHER_MONTH, "org_id": ORG, "source_document_id": OTHER_DOCUMENT,
                                     "currency": "RON", "period_start": "2025-11-30", "period_end": "2025-11-30",
                                     "assembled_canonical_v1": {"provenance": {"source_document_id": OTHER_DOCUMENT}}})
    more = {"takeover_began_at": "2026-10-04T10:00:09+00:00", "keep_briefing_reason": None,
            "emptied": [], "kept": []} if committed else {}
    double.add("financial_periods", {
        "id": OTHER_STAGED, "org_id": ORG, "source_document_id": None, "currency": "RON",
        "period_start": "2025-11-30", "period_end": "2025-11-30",
        "assembled_canonical_v1": {"provenance": {"source_document_id": OTHER_DOCUMENT},
                                   MARKER_KEY: _marker(OTHER_DOCUMENT, OTHER_MONTH,
                                                       staged_at="2026-10-04T10:00:00+00:00", **more)}})
    double.add("briefings", {"id": "briefing-of-the-other-documents-rerun", "period_id": OTHER_STAGED,
                             "org_id": ORG, "body": W.NEW_BODY, "language": "ro"})
    double.add("briefings", {"id": "briefing-of-the-other-month", "period_id": OTHER_MONTH, "org_id": ORG,
                             "body": W.GOOD_BODY, "language": "ro"})
    double.writes[:] = []


@pytest.mark.parametrize("committed", [True, False], ids=["a_committed_row", "an_uncommitted_row"])
@pytest.mark.parametrize("resume", [True, False], ids=["its_next_rerun_or_failure", "its_permanent_delete"])
def test_one_documents_cleanup_never_touches_another_documents_staged_row(committed, resume):
    """`_clear_staged_rerun_rows(document_id=A)` is A's next re-run, A's
    failure handler and A's permanent delete (`resume=False`). Without its
    document filter each of them would resume — or, for a delete, DROP —
    ANOTHER document's staged row, committed ones included: the loss this
    lane exists to end (the month's briefing deleted, the run's own dropped),
    for a different document. No law held the filter (review 2026-10-05)."""
    double = _seam_world("the_narration_worked")
    _with_another_documents_staged_row(double, committed=committed)

    def the_others() -> Any:
        state = _state(double)
        return ([p for p in state["financial_periods"] if p["id"] in (OTHER_MONTH, OTHER_STAGED)],
                [d for d in state["documents"] if d["id"] == OTHER_DOCUMENT],
                [b for b in state["briefings"] if b["period_id"] in (OTHER_MONTH, OTHER_STAGED)])

    others_before = the_others()

    out = P._clear_staged_rerun_rows(double, ORG, document_id=DOC_ID, resume=resume)

    assert (out["resumed"], out["dropped"], out["left"]) == (0, 1, 0), out       # A's own (uncommitted) row
    assert the_others() == others_before, "another document's staged row (or its month) was touched"
    touched = [x for x in double.writes if OTHER_STAGED in json.dumps(x, default=str)
               or OTHER_MONTH in json.dumps(x, default=str)]
    assert touched == [], touched


def test_a_rerun_is_not_started_when_its_documents_earlier_staged_rows_cannot_be_listed(app, gw, monkeypatch):
    """The route cleans up what an earlier re-run of the document left before
    it hands off. When the staged rows cannot even be LISTED (a timeout),
    nothing is known: a committed row may be there, its month
    mid-replacement. Not started — 503 `rerun_unavailable`, the claim given
    back, nothing staged. (The other half of that guard — a committed row
    that could not be completed — is the law above S20.)"""
    w = O._own_month(app, gw, monkeypatch, [RuntimeError(W.PROVIDER_ERROR_TEXT)])
    enqueued_before = list(gw.enqueued)
    real_list = P._staged_rerun_rows
    with pytest.MonkeyPatch.context() as mp:
        def unreadable(admin_client: Any, org_id: str) -> Any:
            import httpx
            raise httpx.ReadTimeout("The read operation timed out")

        mp.setattr(P, "_staged_rerun_rows", unreadable)
        spy = W._Spy(gw.db, mp)

        r = O._retry(app, w["org"], w["doc1"])

    assert r.status_code == 503 and r.json() == O.REFUSED_UNAVAILABLE, (r.status_code, r.text[:300])
    assert gw.enqueued == enqueued_before and w["doc1"] not in P._STAGED_RERUNS
    O._claim_writes_only(spy, w["doc1"])
    assert P._staged_rerun_rows is real_list
    # A moment later it is readable again and the re-run starts.
    again = W._docs_panel_rerun(app, gw, dict(w, org_id=w["org"]))
    assert again["status"] == "analyzed", (again["status"], again.get("error"))


def test_a_handler_that_cannot_read_the_staged_rows_never_says_the_previous_analysis_is_still_served():
    """The row says the takeover was INTERRUPTED (the commit point wrote
    that), the run then failed, and its handler cannot list the staged rows.
    It must not write "the re-run did not finish" over it — that sentence
    tells the reader the previous analysis is still the one served, and the
    month may be mid-replacement. The interrupted text stays until a resume
    clears it."""
    class _Unlistable(_KillingDouble):
        def select(self, table: str, **kwargs: Any) -> Any:
            if table == "financial_periods" and (kwargs.get("filters") or {}).get("source_document_id") == "is.null" \
                    and "id" not in (kwargs.get("filters") or {}):
                import httpx
                raise httpx.ReadTimeout("The read operation timed out")
            return super(_Unlistable, self).select(table, **kwargs)

    double = _Unlistable(every_table=True)
    for table in _SEAM_TABLES:
        for row in _seam_world("the_narration_worked", document_error=INTERRUPTED).rows(table):
            double.add(table, row)
    double.writes[:] = []

    assert _handle_failure(double) == "failed"

    (doc,) = double.rows("documents")
    assert doc["error"] == INTERRUPTED and doc["status"] == "analyzed", (
        "the handler said the previous analysis is still served over an interrupted takeover: %r" % (doc,))
    assert [x for x in double.writes if x["table"] == "documents"] == [], double.writes
    # CONTROL: with the rows readable and nothing committed, the same handler does say so.
    readable = _seam_world("the_narration_worked", document_error=None)
    assert _handle_failure(readable) == "failed"
    assert readable.rows("documents")[0]["error"] == "rerun_failed: RuntimeError: compute failed"


def test_a_refiled_rerun_whose_new_month_is_taken_is_refused_before_anything_is_staged_or_narrated(
        app, gw, monkeypatch):
    """S7's first cell — "the month is taken when the run persists" — passed
    with the mint-time check REMOVED: the takeover's own look answers the
    same code, after the whole run (a staged row inserted, every stage run,
    the provider called). The refusal belongs at the MINT: no period row is
    inserted, nothing is stored under any id, and the provider is never
    asked."""
    w = O._own_month(app, gw, monkeypatch, [RuntimeError(W.PROVIDER_ERROR_TEXT)])
    (own,) = gw.db.rows("financial_periods")
    own["period_start"] = own["period_end"] = "2024-12-31"
    _another_documents_december(gw, w)
    narrated_before = len(W._ScriptedProvider.narrate_requests)
    spy = W._Spy(gw.db, monkeypatch)

    assert O._retry(app, w["org"], w["doc1"]).status_code == 202
    rerun = V.run_analysis(gw, w["doc1"])

    assert rerun["error"] == "rerun_failed: rerun_month_taken" and rerun["status"] == "analyzed", rerun
    assert [x for x in spy.writes if x["op"] == "insert" and x["table"] == "financial_periods"] == [], \
        "a staged row was inserted before the month was looked at"
    assert sorted(set(x["table"] for x in spy.writes)) == ["documents"], sorted(set(x["table"] for x in spy.writes))
    assert len(W._ScriptedProvider.narrate_requests) == narrated_before, \
        "the provider was asked to narrate a re-run that could never be applied"


def test_a_takeover_is_refused_before_any_write_when_the_month_it_was_staged_beside_is_no_longer_its_own():
    """T0 asks one question: is THE MONTH THIS RUN WAS STAGED BESIDE still
    the document's own — not "does the document own a period". The document
    owns another period now (it was re-filed by a correction while the run
    was going) and the staged-beside month names another document: refused
    BEFORE the staged-only deletes and the commit point — nothing is
    written."""
    double = _seam_world("the_narration_worked")
    double.update("financial_periods", {"source_document_id": "a-newer-upload"}, filters={"id": "eq.%s" % PID})
    double.add("financial_periods", {"id": "the-documents-other-period", "org_id": ORG, "currency": "RON",
                                     "source_document_id": DOC_ID, "period_start": "2025-06-30",
                                     "period_end": "2025-06-30", "updated_at": "2026-10-04T11:00:00+00:00"})
    double.update("documents", {"period_id": "the-documents-other-period"}, filters={"id": "eq.%s" % DOC_ID})
    before = _state(double)
    double.writes[:] = []

    with pytest.raises(P.RerunOvertaken):
        _staged_takeover(double, "the_narration_worked")

    assert double.writes == [] and _state(double) == before, double.writes


# ──────────────────────────────────────────────────────────────────────
# S29 — the page-mount watchdog completes what a dead process interrupted
# ──────────────────────────────────────────────────────────────────────


def test_the_page_mount_watchdog_completes_an_interrupted_rerun_of_the_callers_own_company(
        app, gw, monkeypatch, tmp_path):
    """Between a commit point and its resume the month's page can serve a
    table with no rows; a company that uploads nothing would keep that gap
    until its next analysis (there is no sweep at boot). The dashboard posts
    /api/pipeline/recover-stuck when it mounts: the first member to open the
    app completes the takeover — the run's analysis, whole — at any age of
    the row. Somebody who is NOT a member of the company completes nothing."""
    w = O._own_month(app, gw, monkeypatch, [W._reply(W.BODY_B, W.TITLES_B)])
    staged = _a_stranded_committed_row(app, gw, monkeypatch, tmp_path, w)
    assert gw.db.rows("briefings") != [] and [b for b in gw.db.rows("briefings") if b["period_id"] == w["month"]] == [], \
        "the scenario: the month's briefing is gone, the run's own is under the staged row"
    stranded = gw.state()

    outsider = V._http(app).post("/api/pipeline/recover-stuck", headers=V._headers(V.OUTSIDER))
    assert outsider.status_code == 200 and outsider.json()["resumed_reruns"] == 0, outsider.text[:300]
    assert gw.state() == stranded, "somebody outside the company changed it"

    r = V._http(app).post("/api/pipeline/recover-stuck", headers=V._headers(V.USER))

    assert r.status_code == 200 and r.json()["resumed_reruns"] == 1, r.text[:300]
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == w["month"] and staged != w["month"] and MARKER_KEY not in period["assembled_canonical_v1"]
    (briefing,) = gw.db.rows("briefings")
    assert (briefing["body"], briefing["period_id"], briefing["stale_reason"]) == (W.BODY_B, w["month"], None)
    assert sorted(x["title"] for x in gw.db.rows("recommendations")) == W.TITLES_B
    (doc,) = gw.docs(id=w["doc1"])
    assert (doc["status"], doc["error"], doc["period_id"]) == ("analyzed", None, w["month"]), doc
    # … and a second mount finds nothing to do.
    again = V._http(app).post("/api/pipeline/recover-stuck", headers=V._headers(V.USER))
    assert again.json()["resumed_reruns"] == 0


# ──────────────────────────────────────────────────────────────────────
# S30 — the month's row takes the run's columns only while it is still
#       this document's
# ──────────────────────────────────────────────────────────────────────


def test_a_month_that_changes_hands_while_its_takeover_is_applied_is_never_written_over_nor_reported_done():
    """In ONE process the company's lock rules this out (S23). A second
    process is not serialised — and its takeover of the month can land
    between two statements of this one's apply. The row's columns were then
    written over whatever the other takeover had put there, the document
    reported analysed on a month no longer its own and its row cleared — a
    superseded marker included.

    The month's row takes the run's columns ONLY WHILE IT STILL NAMES THIS
    DOCUMENT (the source is in the filter; the row is read back): changed
    hands, nothing more is written — the row keeps the other takeover's
    columns, the document's row keeps what it says, the staged row is
    dropped (there is nothing left to apply it ONTO), and the run is
    refused as overtaken."""
    variant = "the_narration_worked"
    double = _seam_world(variant)
    real_delete = double.delete
    landed = []  # type: List[str]

    def delete(table: str, *, filters: Dict[str, str]) -> Any:
        out = real_delete(table, filters=filters)
        if not landed and table == "statement_line_items" and filters == {"period_id": "eq.%s" % PID}:
            # ANOTHER PROCESS's takeover lands here: the month is its document's now.
            landed.append(table)
            (row,) = [p for p in double.rows("financial_periods") if p["id"] == PID]
            row.update({"source_document_id": "a-newer-upload", "methodology_version": "the-newer-uploads",
                        "assembled_canonical_v1": {"canonical_bs": {"run": "the newer upload's"},
                                                   "provenance": {"source_document_id": "a-newer-upload"}}})
            (doc,) = double.rows("documents")
            doc.update({"error": "superseded_by:a-newer-upload", "deleted_at": "2026-10-05T10:00:00+00:00"})
        return out

    double.delete = delete  # type: ignore[assignment]

    with pytest.raises(P.RerunOvertaken):
        _staged_takeover(double, variant)

    assert landed, "the scenario never happened"
    (month,) = [p for p in double.rows("financial_periods") if p["id"] == PID]
    assert (month["source_document_id"], month["methodology_version"]) == ("a-newer-upload", "the-newer-uploads") \
        and month["assembled_canonical_v1"]["canonical_bs"] == {"run": "the newer upload's"}, (
        "the other takeover's row was written over with this run's columns: %r" % (month,))
    (doc,) = double.rows("documents")
    assert doc["error"] == "superseded_by:a-newer-upload" and doc["deleted_at"] is not None, (
        "the archived document's marker was erased (or it was reported analysed on a month not its own): %r" % (doc,))
    assert [p["id"] for p in double.rows("financial_periods") if p["id"] == STAGED] == []
    for table in _RUN_TABLES:
        assert [r for r in double.rows(table) if r.get("period_id") == STAGED] == [], table
    after_the_handover = [x for x in double.writes[double.writes.index(
        [x for x in double.writes if x["op"] == "delete" and x["table"] == "statement_line_items"
         and x["filters"] == {"period_id": "eq.%s" % PID}][0]) + 1:]
        if x["table"] in ("financial_periods", "documents")]
    for write in after_the_handover:
        if write["table"] == "documents":
            raise AssertionError("the document's row was written after the month changed hands: %r" % (write,))
        if write["filters"].get("id") == "eq.%s" % PID:
            assert write["filters"].get("source_document_id") == "eq.%s" % DOC_ID, (
                "a write on the month's row did not name the document it must still belong to: %r" % (write,))
