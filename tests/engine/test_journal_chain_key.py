"""THE JOURNAL CHAIN KEY IS (ORGANISATION, CONTENT HASH) — battery gate
``journal-chain-key``.

THE DEFECT THIS FILE EXISTS FOR. Until 2026-10-02 a run-journal chain
was keyed by the document's content hash ALONE (``index/<file_hash>
.jsonl``). Two organisations uploading byte-identical documents shared
one chain. Measured on the unchanged code (main @ 72a29c72), all five:

  1. organisation B's run named organisation A's as its predecessor and
     continued A's hash chain — and ``verify_chain`` called it intact;
  2. A's member, asking the as-of route for A's own period, was answered
     B's envelope; B's member, asking about a moment BEFORE B uploaded
     anything, was answered A's;
  3. a byte-identical analysis by B was swallowed as a "duplicate" of
     A's — B's run left nothing on disk, and the route's content-hash
     fallback answered B with A's entry;
  4. B's success filed A's dead letter as resolved;
  5. A's page view found B's snapshot at the head of "its" chain and
     recorded a new era on it.

The journal was never enabled in production (``ENGINE_JOURNAL_DIR``
unset), so no tenant was ever affected. This file is what stands between
that key and the day someone sets the variable.

WHAT IS REAL HERE. The journal (``engine.journal`` — Journal, hooks,
layout, resume) on a real temporary directory; the real
``pipeline.stage_map`` / ``stage_persist`` / serve seam over a corpus
trial balance; the real ``GET /api/period/{id}/asof`` endpoint function;
the real ``boot_verify`` and the real ``create_app()``; the real CLI.
Only the database is a double (the in-memory stand-in the journal suite
uses, holding one period row per organisation) — the subject under test
is the filesystem journal, and nothing about it is doubled. The old-key
journal under ``fixtures/journal_content_hash_key/`` is REAL: written by
the unchanged code at 72a29c72 (its README says how).

Two invented organisations, ``org-a`` and ``org-b``; one document,
byte-for-byte.

PLANT (TC-2) — docs/engine_book/gates.md § journal-chain-key. The first:
``Journal._index_path`` returns ``index/<file_hash>.jsonl`` again.
"""
from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import pytest

from engine import boot_verify
from engine.api import _journal_routes
from engine.api import pipeline as _pipeline
from engine.core.country_pack_registry import get_pack
from engine.journal import (
    PLATFORM_ORG,
    ChainKey,
    Journal,
    JournalLayoutError,
    ResumeRefused,
    chain_key,
    inspect_layout,
    resume_run,
)
from engine.journal import hooks as _hooks

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"
OLD_KEY_JOURNAL = (
    Path(__file__).resolve().parent / "fixtures" / "journal_content_hash_key" / "journal"
)

ORG_A = "org-a"
ORG_B = "org-b"


# ── the world: one database double, one journal directory ──────────────


class Db:
    """``financial_periods`` for several organisations (one row each)."""

    def __init__(self) -> None:
        self.period_rows: List[Dict[str, Any]] = []

    def select(self, table, *, filters=None, columns="*", limit=None,
               order=None, single=False):
        if table != "financial_periods":
            return []

        def _matches(row):
            for key, value in (filters or {}).items():
                if not str(value).startswith("eq."):
                    return False
                if str(row.get(key)) != str(value)[3:]:
                    return False
            return True

        return [r for r in self.period_rows if _matches(r)]

    def insert(self, table, rows, returning=True):
        rows_list = rows if isinstance(rows, list) else [rows]
        if table == "financial_periods":
            new = dict(rows_list[0])
            new["id"] = "period-of-%s" % new["org_id"]
            self.period_rows.append(new)
            return [new]
        return rows_list if returning else []

    def update(self, table, patch, *, filters=None):
        if table == "financial_periods":
            for row in self.period_rows:
                if (filters or {}).get("id") == "eq.%s" % row.get("id"):
                    row.update(copy.deepcopy(patch))

    def delete(self, table, *, filters=None):
        return None

    def row(self, org: str) -> Dict[str, Any]:
        return [r for r in self.period_rows if r["org_id"] == org][0]


@pytest.fixture()
def db(monkeypatch):
    fake = Db()

    @contextlib.contextmanager
    def _admin():
        yield fake

    monkeypatch.setattr(_pipeline._supabase, "admin", _admin)
    return fake


@pytest.fixture()
def journal_dir(monkeypatch, tmp_path):
    root = tmp_path / "journal"
    monkeypatch.setenv(_hooks.ENV_VAR, str(root))
    _hooks.reset_cache()
    yield root
    _hooks.reset_cache()


def the_same_bytes_for(org: str):
    """One corpus trial balance. The document row differs by organisation
    and document id only — the BYTES, and so the content hash, are
    identical for every organisation."""
    pack = get_pack("RO")
    path = sorted((CORPUS / "csv").glob("input.*"))[0]
    content = path.read_bytes()
    tb_rows = pack.parse_trial_balance_csv(content, path.name)
    shaped = pack.accounts_to_assemble_shape(tb_rows)
    doc = {
        "id": "doc-of-%s" % org,
        "org_id": org,
        "original_filename": path.name,
        "content_hash": "sha256-%s" % hashlib.sha256(content).hexdigest(),
        "period_end_hint": "2025-12-31",
    }
    parsed = _pipeline._deterministic_tb_parsed(
        doc, tb_rows, shaped,
        pack.compute_statutory_net_profit_anchor(tb_rows),
        pack.compute_source_imbalance(tb_rows),
    )
    return doc, parsed


def deliver(doc, parsed) -> str:
    """One journaled delivery through the REAL stage composition."""
    _hooks.on_run_started(doc, industry=None)
    _hooks.on_frontend_done(doc, parsed)
    assembled = _pipeline.stage_map(doc, copy.deepcopy(parsed), None)
    _hooks.on_pass_done(doc, assembled)
    return _pipeline.stage_persist(doc, copy.deepcopy(parsed), assembled)


def serve(db: Db, org: str) -> None:
    """The REAL serve seam over that organisation's period ROW."""
    statements: Dict[str, Any] = {"assembled_bs": {}, "assembled_pl": {"revenue": 0.0}}
    _pipeline._apply_envelope_truth_to_statements(statements, db.row(org))


def asof_endpoint(monkeypatch, period_row):
    """The REAL route function. ``period_row`` is what the caller's own
    client returned for the period id (row-level visibility is the
    database's; the route's part is which chain it then reads)."""
    from fastapi import APIRouter

    router = APIRouter()
    _journal_routes.register_routes(router, require_jwt=lambda auth: "jwt-ok")

    class _PerUser:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def select(self, table, *, filters=None, single=False, **kw):
            if table == "financial_periods" and period_row is not None:
                return [period_row]
            return []

    monkeypatch.setattr(_journal_routes._supabase, "per_user", lambda jwt: _PerUser())
    for route in router.routes:
        if getattr(route, "path", "") == "/api/period/{period_id}/asof":
            return route.endpoint
    raise AssertionError("asof route not mounted")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def tree(root: Path) -> Dict[str, bytes]:
    """Every file under ``root`` with its bytes — the 'nothing was
    written' and 'nothing was touched' observable."""
    return {
        str(p.relative_to(root)): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def chain_files(root: Path, chain: ChainKey) -> Dict[str, bytes]:
    """The bytes of one chain: its index file and every run it lists."""
    journal = Journal(root)
    out = {"index": journal._index_path(chain).read_bytes()}
    for entry in journal.registered_runs(chain):
        out[entry["run_id"]] = journal._run_path(entry["run_id"]).read_bytes()
    return out


def both_deliver(db: Db):
    doc_a, parsed_a = the_same_bytes_for(ORG_A)
    doc_b, parsed_b = the_same_bytes_for(ORG_B)
    assert doc_a["content_hash"] == doc_b["content_hash"], "the bytes must be identical"
    deliver(doc_a, parsed_a)
    deliver(doc_b, parsed_b)
    return doc_a, doc_b


# ── 1. two organisations, identical bytes: two chains that never link ──


def test_two_orgs_with_identical_bytes_hold_two_chains_that_never_link(journal_dir, db):
    doc_a, doc_b = both_deliver(db)
    journal = Journal(journal_dir)
    fh = doc_a["content_hash"]
    a, b = chain_key(ORG_A, fh), chain_key(ORG_B, fh)

    # Two chains on disk, one per organisation — and none keyed by the
    # hash alone.
    assert journal.list_chains() == [a, b]
    assert sorted(p.name for p in (journal_dir / "index").iterdir()) == [ORG_A, ORG_B]
    assert not list((journal_dir / "index").glob("*.jsonl"))

    runs_a, runs_b = journal.registered_runs(a), journal.registered_runs(b)
    assert [r["document_id"] for r in runs_a] == ["doc-of-org-a"]
    assert [r["document_id"] for r in runs_b] == ["doc-of-org-b"]

    # B's run is a FIRST run: no predecessor, and its hash chain starts
    # from nothing — not from A's tail.
    assert runs_b[0]["prev_run_id"] is None
    first_of_b = journal.read_run(runs_b[0]["run_id"])[0]
    assert first_of_b["type"] == "RUN_STARTED"
    assert first_of_b["prev_event_hash"] is None
    hashes_of_a = {e["event_hash"] for e in journal.chain_events(a)}
    for event in journal.chain_events(b):
        assert event["prev_event_hash"] not in hashes_of_a
        assert event["event_hash"] not in hashes_of_a

    # Each run names its owner, hash-bound in its own RUN_STARTED.
    assert journal.chain_events(a)[0]["payload"]["org_id"] == ORG_A
    assert first_of_b["payload"]["org_id"] == ORG_B
    assert journal.verify_chain(a) == []
    assert journal.verify_chain(b) == []


# ── 2. the as-of route answers each organisation with its own entry ────


def test_each_org_is_answered_its_own_envelope_by_the_asof_route(journal_dir, db, monkeypatch):
    from fastapi import HTTPException

    doc_a, parsed_a = the_same_bytes_for(ORG_A)
    doc_b, parsed_b = the_same_bytes_for(ORG_B)
    deliver(doc_a, parsed_a)
    time.sleep(0.02)
    before_b_uploaded = now()
    time.sleep(0.02)
    deliver(doc_b, parsed_b)
    time.sleep(0.02)

    a = asof_endpoint(monkeypatch, db.row(ORG_A))(
        period_id="period-of-org-a", t=now(), authorization="Bearer a")
    assert a["assembled_canonical_v1"]["provenance"]["source_document_id"] == "doc-of-org-a"
    assert a["snapshot"]["period_id"] == "period-of-org-a"

    b = asof_endpoint(monkeypatch, db.row(ORG_B))(
        period_id="period-of-org-b", t=now(), authorization="Bearer b")
    assert b["assembled_canonical_v1"]["provenance"]["source_document_id"] == "doc-of-org-b"
    assert b["snapshot"]["period_id"] == "period-of-org-b"
    assert b["snapshot"]["run_id"] != a["snapshot"]["run_id"]

    # Before B uploaded, B has NO history — A's does not stand in for it.
    with pytest.raises(HTTPException) as refused:
        asof_endpoint(monkeypatch, db.row(ORG_B))(
            period_id="period-of-org-b", t=before_b_uploaded, authorization="Bearer b")
    assert refused.value.status_code == 404
    # ... while A, at that same moment, is answered its own.
    a_then = asof_endpoint(monkeypatch, db.row(ORG_A))(
        period_id="period-of-org-a", t=before_b_uploaded, authorization="Bearer a")
    assert a_then["snapshot"]["period_id"] == "period-of-org-a"


# ── 3. an identical analysis by another organisation is not a duplicate ─


def test_an_identical_analysis_by_another_org_is_not_a_duplicate(journal_dir, db, monkeypatch):
    """Same bytes AND a byte-identical envelope — the case the duplicate
    short-circuit matches on. Inside one organisation it is a duplicate
    (the duplicate-delivery rule); across two it is two first runs."""
    fh = "sha256-" + "ab" * 32
    envelope = {"provenance": {"content_hash": fh}, "canonical_bs": {"status": "BALANCED"}}

    handles = {}
    for org in (ORG_A, ORG_B):
        doc = {"id": "doc-%s" % org, "org_id": org, "content_hash": fh}
        _hooks.on_run_started(doc)
        handles[org] = _hooks.active_run()
        _hooks.on_snapshot_persisted(doc, "period-%s" % org, copy.deepcopy(envelope))

    journal = Journal(journal_dir)
    assert handles[ORG_B].short_circuited is False
    assert handles[ORG_B].duplicate_of is None
    assert handles[ORG_B].provisional is False     # a first run on its own chain
    for org in (ORG_A, ORG_B):
        chain = chain_key(org, fh)
        snaps = journal.snapshots(chain)
        assert len(snaps) == 1
        assert snaps[0]["payload"]["period_id"] == "period-%s" % org
        assert journal.resolve_chain("period-%s" % org, org_id=org) == chain

    # B's member is answered B's entry.
    period_b = {"id": "period-org-b", "org_id": ORG_B, "assembled_canonical_v1": envelope}
    out = asof_endpoint(monkeypatch, period_b)(
        period_id="period-org-b", t=now(), authorization="Bearer b")
    assert out["snapshot"]["period_id"] == "period-org-b"
    assert out["snapshot"]["run_id"] == handles[ORG_B].run_id

    # POSITIVE CONTROL — the short-circuit still exists, inside ONE
    # organisation: A delivering the same analysis again is a duplicate
    # of A's own run, and leaves A's chain (and B's) as they were.
    before = tree(journal_dir)
    doc_a = {"id": "doc-org-a", "org_id": ORG_A, "content_hash": fh}
    _hooks.on_run_started(doc_a)
    again = _hooks.active_run()
    _hooks.on_snapshot_persisted(doc_a, "period-org-a", copy.deepcopy(envelope))
    assert again.short_circuited is True
    assert again.duplicate_of == handles[ORG_A].run_id
    after = tree(journal_dir)
    assert {k: v for k, v in after.items() if k.startswith(("index/", "runs/"))} == \
           {k: v for k, v in before.items() if k.startswith(("index/", "runs/"))}


# ── 4. one organisation's success never resolves another's dead letter ─


def test_one_orgs_success_never_resolves_another_orgs_dead_letter(journal_dir, db):
    fh = "sha256-" + "cd" * 32
    doc_a = {"id": "doc-a", "org_id": ORG_A, "content_hash": fh}
    doc_b = {"id": "doc-b", "org_id": ORG_B, "content_hash": fh}

    _hooks.on_run_started(doc_a)
    failed_run_of_a = _hooks.active_run().run_id
    _hooks.on_run_failed("doc-a", RuntimeError("org-a's run failed"))
    journal = Journal(journal_dir)
    assert [e["org_id"] for e in journal.dlq_entries()] == [ORG_A]

    _hooks.on_run_started(doc_b)
    _hooks.on_snapshot_persisted(doc_b, "period-b", {"provenance": {"content_hash": fh}})
    assert [e["run_id"] for e in journal.dlq_entries()] == [failed_run_of_a], (
        "organisation B's success resolved organisation A's dead letter"
    )
    assert not (journal_dir / "dlq" / "resolved").exists()

    # Even naming A's document id from B's chain resolves nothing of A's.
    assert journal.resolve_dlq_for(chain=chain_key(ORG_B, fh), document_id="doc-a") == []
    assert journal.dlq_depth() == 1

    # POSITIVE CONTROL — A's own success resolves it.
    _hooks.on_run_started(doc_a)
    _hooks.on_snapshot_persisted(doc_a, "period-a", {"provenance": {"content_hash": fh}})
    assert journal.dlq_depth() == 0
    assert [p.stem for p in (journal_dir / "dlq" / "resolved").iterdir()] == [failed_run_of_a]


# ── 5. one organisation's page view writes nothing on another's chain ──


def test_one_orgs_page_view_writes_nothing_on_another_orgs_chain(journal_dir, db):
    doc_a, _doc_b = both_deliver(db)
    fh = doc_a["content_hash"]
    a, b = chain_key(ORG_A, fh), chain_key(ORG_B, fh)
    journal = Journal(journal_dir)
    b_before = chain_files(journal_dir, b)
    snapshots_of_a = len(journal.snapshots(a))

    serve(db, ORG_A)
    serve(db, ORG_A)

    events_a = journal.chain_events(a)
    assert [e["type"] for e in events_a].count("SERVED") == 1     # recorded, once, on A's
    # A's served state IS A's last snapshot: no "out-of-band change" era.
    assert len(journal.snapshots(a)) == snapshots_of_a
    assert not [e for e in events_a
                if (e.get("payload") or {}).get("origin") == "serve_observed"]
    assert chain_files(journal_dir, b) == b_before, "B's chain changed when A's page was viewed"

    # A period row that names no organisation is served — and not journaled.
    whole = tree(journal_dir)
    statements: Dict[str, Any] = {"assembled_bs": {}, "assembled_pl": {"revenue": 0.0}}
    _pipeline._apply_envelope_truth_to_statements(
        statements, {"assembled_canonical_v1": db.row(ORG_B)["assembled_canonical_v1"]})
    assert tree(journal_dir) == whole


# ── 6. one organisation re-uploading chains onto itself only ───────────


def test_one_org_reuploading_chains_onto_itself_only(journal_dir, db):
    doc_a, parsed_a = the_same_bytes_for(ORG_A)
    doc_b, parsed_b = the_same_bytes_for(ORG_B)
    fh = doc_a["content_hash"]
    a, b = chain_key(ORG_A, fh), chain_key(ORG_B, fh)

    deliver(doc_a, parsed_a)
    deliver(doc_b, parsed_b)
    journal = Journal(journal_dir)
    first_of_a = journal.registered_runs(a)[0]["run_id"]
    tail_of_a = journal.chain_tail(a)["event_hash"]
    b_before = chain_files(journal_dir, b)

    # A re-uploads the SAME bytes as a new document (a new documents row):
    # the envelope names the new document, so it is a new era on A's chain.
    again = dict(doc_a, id="doc-of-org-a-again")
    parsed_again = copy.deepcopy(parsed_a)
    deliver(again, parsed_again)

    runs_a = journal.registered_runs(a)
    assert [r["document_id"] for r in runs_a] == ["doc-of-org-a", "doc-of-org-a-again"]
    assert runs_a[1]["prev_run_id"] == first_of_a                     # onto ITS OWN run
    assert journal.read_run(runs_a[1]["run_id"])[0]["prev_event_hash"] == tail_of_a
    assert journal.verify_chain(a) == []
    assert chain_files(journal_dir, b) == b_before, "A's re-upload touched B's chain"
    assert journal.verify_chain(b) == []


# ── 7. a reference that belongs to another organisation resolves to nothing


def test_a_reference_of_another_org_resolves_to_nothing(journal_dir, db, monkeypatch):
    from fastapi import HTTPException

    doc_a, _doc_b = both_deliver(db)
    journal = Journal(journal_dir)
    fh = doc_a["content_hash"]
    t = now()

    # POSITIVE CONTROL: inside its own organisation each resolves.
    assert journal.resolve_chain("period-of-org-a", org_id=ORG_A) == chain_key(ORG_A, fh)
    assert journal.resolve_chain("doc-of-org-a", org_id=ORG_A) == chain_key(ORG_A, fh)
    assert journal.asof("period-of-org-a", t, org_id=ORG_A) is not None

    # A's period id, A's document id — asked for as organisation B.
    assert journal.resolve_chain("period-of-org-a", org_id=ORG_B) is None
    assert journal.resolve_chain("doc-of-org-a", org_id=ORG_B) is None
    assert journal.asof("period-of-org-a", t, org_id=ORG_B) is None
    assert journal.asof("doc-of-org-a", t, org_id=ORG_B) is None
    # The shared content hash, asked for as an organisation that never
    # uploaded it.
    assert journal.resolve_chain(fh, org_id="org-c") is None
    assert journal.asof(fh, t, org_id="org-c") is None
    # ... and as B it is B's own chain, never A's.
    assert journal.asof(fh, t, org_id=ORG_B)["snapshot"]["period_id"] == "period-of-org-b"

    # The route: a period row that names no organisation (or one that
    # cannot be one) has no coverage — it is never looked up by period id
    # or content hash alone.
    for bad_org in (None, "", PLATFORM_ORG, "../org-a", "ORG-A"):
        row = dict(db.row(ORG_A), org_id=bad_org)
        with pytest.raises(HTTPException) as refused:
            asof_endpoint(monkeypatch, row)(
                period_id="period-of-org-a", t=t, authorization="Bearer x")
        assert refused.value.status_code == 404, bad_org

    # The operator's cross-organisation lookup says what is true: one
    # content hash, two chains.
    assert journal.find_chains(fh) == [chain_key(ORG_A, fh), chain_key(ORG_B, fh)]


# ── 8. there is no chain without an organisation ───────────────────────


def test_there_is_no_chain_without_an_organisation(journal_dir, db):
    journal = Journal(journal_dir)
    fh = "sha256-" + "ef" * 32
    empty = tree(journal_dir)                       # the layout marker only
    assert list(empty) == ["LAYOUT.json"]

    # The retired key — a bare content hash — is not a lookup, anywhere.
    for read in (journal.read_index, journal.registered_runs, journal.chain_events,
                 journal.chain_tail, journal.last_snapshot_event,
                 journal.last_served_normalized_hash, journal.snapshots,
                 journal.verify_chain, journal._index_path):
        with pytest.raises(TypeError):
            read(fh)
    with pytest.raises(TypeError):
        journal.asof(fh, now())                     # org_id is required
    with pytest.raises(TypeError):
        journal.resolve_chain(fh)
    with pytest.raises(TypeError):
        journal.begin_run(file_hash=fh, document_id="d", engine_version="e")

    # An organisation id is used verbatim or refused — never rewritten
    # into a directory two organisations could share.
    for bad in (None, "", "ORG-A", "org/a", "../org-a", ".", "..", ".org", "_org",
                "org a", "o" * 129, 7):
        with pytest.raises(ValueError):
            journal.begin_run(org_id=bad, file_hash=fh, document_id="d", engine_version="e")
        with pytest.raises(ValueError):
            journal.observe_serving({"provenance": {"content_hash": fh}}, org_id=bad)
    with pytest.raises(ValueError):
        journal.begin_run(org_id=ORG_A, file_hash="", document_id="d", engine_version="e")

    # The hooks: a row with no organisation (or the platform scope, which
    # a row can never name) journals nothing, and never raises.
    for org in (None, "", PLATFORM_ORG, "ORG-A", "../org-a"):
        doc = {"id": "doc-x", "org_id": org, "content_hash": fh}
        _hooks.on_run_started(doc)
        assert _hooks.active_run() is None
        _hooks.on_snapshot_persisted(doc, "period-x", {"provenance": {"content_hash": fh}})
        _hooks.on_period_moved(doc, {"from": {}, "to": {}})
        _hooks.on_served({"provenance": {"content_hash": fh}}, None, org_id=org)
    _hooks.on_served({"provenance": {"content_hash": fh}})   # the old call shape
    doc_without = {"id": "doc-x", "content_hash": fh}
    _hooks.on_run_started(doc_without)
    _hooks.on_snapshot_persisted(doc_without, "period-x", {"provenance": {"content_hash": fh}})
    assert tree(journal_dir) == empty, "something was journaled with no organisation"

    # A run recorded with no organisation is not resumed onto anyone's chain.
    handle = journal.begin_run(org_id=ORG_A, file_hash=fh, document_id="d", engine_version="e")
    handle.emit("FRONTEND_DONE", {"front_end_id": "x", "ir_hash": None})
    run_path = journal._run_path(handle.run_id)
    first = json.loads(run_path.read_text(encoding="utf-8").splitlines()[0])
    del first["payload"]["org_id"]
    lines = run_path.read_text(encoding="utf-8").splitlines()
    lines[0] = json.dumps(first, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    run_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    with pytest.raises(ResumeRefused) as refused:
        resume_run(journal, handle.run_id,
                   stage_map=lambda *a: {}, stage_persist=lambda *a: "period")
    assert refused.value.reason == "chain_incomplete"
    assert "org_id" in refused.value.detail

    # A caller's extra payload cannot rename the run's owner.
    renamed = journal.begin_run(
        org_id=ORG_A, file_hash=fh, document_id="d", engine_version="e", run_kind="adhoc",
        extra_payload={"org_id": ORG_B, "file_hash": "sha256-other", "year": 2024})
    started = journal.read_run(renamed.run_id)[0]["payload"]
    assert (started["org_id"], started["file_hash"], started["year"]) == (ORG_A, fh, 2024)

    # The platform scope exists — for the platform's own runs only.
    public = journal.begin_run(org_id=PLATFORM_ORG, file_hash=fh,
                               document_id="public_ro:2024:UU", engine_version="e",
                               run_kind="public_ingest")
    assert public.chain == ChainKey(PLATFORM_ORG, fh)
    assert [r["run_id"] for r in journal.registered_runs(chain_key(ORG_A, fh))] == [
        handle.run_id, renamed.run_id]
    assert [r["run_id"] for r in journal.registered_runs(public.chain)] == [public.run_id]


# ── 9. an index line cannot adopt another organisation's run ───────────


def test_a_run_filed_under_another_orgs_index_is_not_read_and_fails_verify(journal_dir, db):
    doc_a, _doc_b = both_deliver(db)
    journal = Journal(journal_dir)
    fh = doc_a["content_hash"]
    a, b = chain_key(ORG_A, fh), chain_key(ORG_B, fh)
    own_events = journal.chain_events(b)
    run_of_a = journal.registered_runs(a)[0]

    # Hand-file A's run into B's index — once verbatim, once relabelled.
    index_b = journal._index_path(b)
    with open(str(index_b), "a", encoding="utf-8") as fh_out:
        fh_out.write(json.dumps(run_of_a, sort_keys=True) + "\n")
        fh_out.write(json.dumps(dict(run_of_a, org_id=ORG_B), sort_keys=True) + "\n")

    # Reads of B's chain return B's events only: the run's own
    # hash-bound RUN_STARTED says whose it is, the index line does not.
    assert journal.chain_events(b) == own_events
    assert journal.chain_tail(b) == own_events[-1]
    assert all(s["payload"]["period_id"] == "period-of-org-b" for s in journal.snapshots(b))
    assert journal.asof(fh, now(), org_id=ORG_B)["snapshot"]["period_id"] == "period-of-org-b"

    errors = journal.verify_chain(b)
    assert any("index line names organisation 'org-a'" in e for e in errors), errors
    assert sum("RUN_STARTED names organisation 'org-a'" in e for e in errors) == 2, errors
    assert journal.verify_chain(a) == []            # A's chain is untouched and intact


# ── 10. census: nothing on disk is keyed by the content hash alone ─────


def test_no_index_file_is_ever_keyed_by_content_hash_alone(journal_dir, db):
    doc_a, _doc_b = both_deliver(db)
    serve(db, ORG_A)
    serve(db, ORG_B)
    _hooks.on_period_moved(doc_a, {"from": {"period_id": "p1"}, "to": {"period_id": "p2"}})
    _hooks.on_run_started(dict(doc_a, id="doc-fail"))
    _hooks.on_run_failed("doc-fail", RuntimeError("boom"))

    report = inspect_layout(journal_dir)
    assert report["state"] == "current" and report["layout_version"] == 2
    assert json.loads((journal_dir / "LAYOUT.json").read_text(encoding="utf-8")) == {
        "layout_version": 2, "chain_key": ["org_id", "file_hash"]}

    index_dir = journal_dir / "index"
    assert [p.name for p in index_dir.iterdir() if p.is_file()] == []
    lines = runs_started = dead = 0
    for org_dir in sorted(index_dir.iterdir()):
        assert org_dir.name in (ORG_A, ORG_B)
        for index_file in sorted(org_dir.glob("*.jsonl")):
            for raw in index_file.read_text(encoding="utf-8").splitlines():
                entry = json.loads(raw)
                lines += 1
                assert entry["v"] == 2
                assert entry["org_id"] == org_dir.name, entry
                if entry["kind"] == "run":
                    first = json.loads(
                        (journal_dir / "runs" / ("%s.jsonl" % entry["run_id"]))
                        .read_text(encoding="utf-8").splitlines()[0])
                    assert first["type"] == "RUN_STARTED"
                    assert first["payload"]["org_id"] == org_dir.name
                    runs_started += 1
    for path in (journal_dir / "dlq").glob("*.json"):
        entry = json.loads(path.read_text(encoding="utf-8"))
        assert entry["v"] == 2 and entry["org_id"] == ORG_A
        dead += 1
    # A census that finds nothing is a broken gate (TC-3): two pipeline
    # runs, two serve runs, a move, a failure — and their period lines.
    assert lines >= 8 and runs_started >= 6 and dead == 1, (lines, runs_started, dead)
    print("GATE-WORK journal-chain-key-census index_lines=%d runs=%d dlq=%d"
          % (lines, runs_started, dead))


# ── 11. a journal written under the old key is refused — everywhere ────


@pytest.fixture()
def old_key_journal(tmp_path):
    """A COPY of the committed journal the unchanged code wrote
    (72a29c72): org-a and org-b, identical bytes, one chain."""
    assert OLD_KEY_JOURNAL.is_dir(), "the old-key fixture is missing"
    root = tmp_path / "old" / "journal"
    shutil.copytree(str(OLD_KEY_JOURNAL), str(root))
    # What makes it the defect: ONE index file, keyed by the hash alone,
    # listing two organisations' documents, the second chained to the first.
    index = list((root / "index").glob("*.jsonl"))
    assert len(index) == 1
    runs = [json.loads(l) for l in index[0].read_text(encoding="utf-8").splitlines()
            if json.loads(l).get("kind") == "run"]
    assert [r["document_id"] for r in runs] == ["doc-of-org-a", "doc-of-org-b"]
    assert runs[1]["prev_run_id"] == runs[0]["run_id"]
    return root


def test_the_committed_old_key_journal_is_refused_everywhere(old_key_journal, monkeypatch, capsys):
    from fastapi import HTTPException

    before = tree(old_key_journal)
    assert len(before) >= 7                          # index + 2 runs + 4 objects

    report = inspect_layout(old_key_journal)
    assert report["state"] == "legacy" and report["usable"] is False
    assert "keyed by content hash alone" in report["reasons"][0]

    with pytest.raises(JournalLayoutError):
        Journal(old_key_journal)

    # The hooks never raise and write nothing into it.
    monkeypatch.setenv(_hooks.ENV_VAR, str(old_key_journal))
    _hooks.reset_cache()
    try:
        fh = "sha256-143b338470815758721175bbe3375cf6a4c840f7219da01bdc52ec5e9ca225f9"
        doc = {"id": "doc-new", "org_id": ORG_A, "content_hash": fh}
        _hooks.on_run_started(doc)
        assert _hooks.active_run() is None
        _hooks.on_snapshot_persisted(doc, "period-new", {"provenance": {"content_hash": fh}})
        _hooks.on_served({"provenance": {"content_hash": fh}}, None, org_id=ORG_A)
        _hooks.on_period_moved(doc, {})
        # The as-of route answers nobody from it.
        row = {"id": "period-of-org-a", "org_id": ORG_A,
               "assembled_canonical_v1": {"provenance": {"content_hash": fh}}}
        with pytest.raises(HTTPException) as refused:
            asof_endpoint(monkeypatch, row)(
                period_id="period-of-org-a", t=now(), authorization="Bearer a")
        assert refused.value.status_code == 503
    finally:
        _hooks.reset_cache()

    # The CLI says so, and every subcommand refuses with the same verdict.
    cli = _load_cli()
    assert cli.main(["--journal-root", str(old_key_journal), "layout"]) == 5
    out = capsys.readouterr().out
    assert "legacy" in out and "REFUSED" in out
    for argv in (["verify", "--all"], ["asof", "--org", ORG_A, "period-of-org-a", now()],
                 ["dlq", "list"], ["gc"], ["notice"]):
        assert cli.main(["--journal-root", str(old_key_journal)] + argv) == 5, argv
    capsys.readouterr()

    assert tree(old_key_journal) == before, "a refused journal was written to"
    assert not (old_key_journal / "LAYOUT.json").exists()


def test_boot_refuses_a_journal_written_under_the_old_key(old_key_journal, monkeypatch):
    before = tree(old_key_journal)
    monkeypatch.setenv("ENGINE_JOURNAL_DIR", str(old_key_journal))

    with pytest.raises(RuntimeError) as refused:
        boot_verify.verify_journal_layout()
    message = str(refused.value)
    assert "ENGINE_JOURNAL_DIR" in message and str(old_key_journal) in message
    assert "content hash alone" in message

    # Inside the full boot verification (what the deploy's served-periods
    # gate calls to ask "can this image boot?") ...
    with pytest.raises(RuntimeError, match="ENGINE_JOURNAL_DIR"):
        boot_verify.verify_config()
    # ... and NOT skipped by the dev bypass.
    monkeypatch.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")
    with pytest.raises(RuntimeError, match="ENGINE_JOURNAL_DIR"):
        boot_verify.verify_config_safe()

    # THE REAL APP does not come up.
    for key, value in (("VITE_SUPABASE_URL", "https://test.supabase.co"),
                       ("VITE_SUPABASE_ANON_KEY", "test-anon"),
                       ("SUPABASE_SERVICE_ROLE_KEY", "test-service")):
        monkeypatch.setenv(key, os.environ.get(key) or value)
    from engine.api.server import create_app

    with pytest.raises(RuntimeError, match="ENGINE_JOURNAL_DIR"):
        create_app()

    assert tree(old_key_journal) == before          # the check is read-only

    # POSITIVE CONTROL — the same app boots with the variable unset
    # (production today), so the refusal above is the journal's.
    monkeypatch.delenv("ENGINE_JOURNAL_DIR")
    assert create_app() is not None


def test_boot_accepts_no_journal_a_fresh_directory_and_a_current_journal(tmp_path, monkeypatch):
    monkeypatch.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")

    monkeypatch.delenv("ENGINE_JOURNAL_DIR", raising=False)
    boot_verify.verify_journal_layout()             # disabled: a no-op
    boot_verify.verify_config_safe()

    absent = tmp_path / "not-there-yet"
    monkeypatch.setenv("ENGINE_JOURNAL_DIR", str(absent))
    boot_verify.verify_config_safe()
    assert not absent.exists(), "the boot check created the journal directory"

    empty = tmp_path / "empty"
    (empty / "runs").mkdir(parents=True)            # what an old Journal() left behind, unused
    (empty / "index").mkdir()
    monkeypatch.setenv("ENGINE_JOURNAL_DIR", str(empty))
    boot_verify.verify_config_safe()
    assert inspect_layout(empty)["state"] == "empty"

    current = tmp_path / "current"
    journal = Journal(current)
    journal.begin_run(org_id=ORG_A, file_hash="sha256-x", document_id="d", engine_version="e")
    monkeypatch.setenv("ENGINE_JOURNAL_DIR", str(current))
    boot_verify.verify_config_safe()
    assert inspect_layout(current)["state"] == "current"
    assert _load_cli().main(["--journal-root", str(current), "layout"]) == 0


@pytest.mark.parametrize("content", ["objects/ab/abcd", "runs/r1.jsonl", "dlq/r1.json",
                                     "index/sha256-x.jsonl"])
def test_journal_content_without_the_marker_is_refused(tmp_path, monkeypatch, content):
    """The old code never wrote a marker; the current code writes it
    before anything else. Content with no marker is the old key's."""
    root = tmp_path / "journal"
    target = root / content
    target.parent.mkdir(parents=True)
    target.write_text("{}\n", encoding="utf-8")
    before = tree(root)

    assert inspect_layout(root)["state"] == "legacy"
    with pytest.raises(JournalLayoutError):
        Journal(root)
    monkeypatch.setenv("ENGINE_JOURNAL_DIR", str(root))
    with pytest.raises(RuntimeError, match="ENGINE_JOURNAL_DIR"):
        boot_verify.verify_journal_layout()
    assert tree(root) == before


def test_a_marker_cannot_bless_an_old_key_index_or_another_layout(tmp_path, monkeypatch):
    # A version-1 index file under a current marker is still the old key.
    blessed = tmp_path / "blessed"
    Journal(blessed)
    (blessed / "index" / "sha256-x.jsonl").write_text("{}\n", encoding="utf-8")
    assert inspect_layout(blessed)["state"] == "legacy"
    with pytest.raises(JournalLayoutError):
        Journal(blessed)

    # A marker this code did not write (another layout, or unreadable).
    for text in ('{"layout_version": 3, "chain_key": ["org_id", "file_hash"]}',
                 '{"layout_version": 2, "chain_key": ["file_hash"]}',
                 "not json"):
        other = tmp_path / ("other-%d" % len(text))
        other.mkdir()
        (other / "LAYOUT.json").write_text(text, encoding="utf-8")
        assert inspect_layout(other)["state"] == "unknown", text
        with pytest.raises(JournalLayoutError):
            Journal(other)
        monkeypatch.setenv("ENGINE_JOURNAL_DIR", str(other))
        with pytest.raises(RuntimeError, match="ENGINE_JOURNAL_DIR"):
            boot_verify.verify_journal_layout()

    # A current root that LOST its marker under a live process: the next
    # write is refused rather than leaving it to look like an old one.
    live = tmp_path / "live"
    journal = Journal(live)
    handle = journal.begin_run(org_id=ORG_A, file_hash="sha256-x", document_id="d",
                               engine_version="e")
    (live / "LAYOUT.json").unlink()
    with pytest.raises(JournalLayoutError):
        handle.emit("PASS_DONE", {"stage": "x"})
    with pytest.raises(JournalLayoutError):
        journal.store.write_object(b"new bytes")


def _load_cli():
    scripts = REPO / "scripts"
    if str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    return importlib.import_module("journal_cli")
