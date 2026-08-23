"""Run-journal suite (Part A) — event spine, hash chain, duplicate
short-circuit (K3), serve observation, and as-of time travel (K9 seed).

Everything below drives the REAL production compositions — the pack
parse/assemble seams, ``pipeline.stage_persist`` and the shared serve
hook ``_apply_envelope_truth_to_statements`` — against the fake-admin
harness (the same in-memory Supabase stand-in the reconciliation suite
and scripts/corpus_replay.py use). The journal is enabled per-test via
``ENGINE_JOURNAL_DIR`` pointing at a tmp dir; every other test in the
battery (and the corpus replay / determinism gates) runs with it unset,
which the no-op test locks in.

Envelope byte-identity uses the corpus replay's volatile-key
normalization discipline: run-time write stamps (``written_at`` …) are
placeholder-stripped, every other byte is compared exactly.
"""
from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import pytest

from engine.core.country_pack_registry import get_pack
from engine.api import pipeline as _pipeline
from engine.api import _reconcile
from engine.journal import (
    EVENT_TYPES,
    Journal,
    canonical_bytes,
    normalized_envelope,
)
from engine.journal import hooks as _hooks

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"


# ── fake-admin harness (mirrors test_reconciliation.py / corpus_replay) ─


class FakeAdminClient:
    def __init__(self) -> None:
        self.period_rows: List[Dict[str, Any]] = []
        self.updates: List[Any] = []

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
            new["id"] = "period-1"
            self.period_rows.append(new)
            return [new]
        return rows_list if returning else []

    def update(self, table, patch, *, filters=None):
        self.updates.append((table, copy.deepcopy(patch), dict(filters or {})))
        if table == "financial_periods":
            for row in self.period_rows:
                if (filters or {}).get("id") == "eq.%s" % row.get("id"):
                    row.update(copy.deepcopy(patch))

    def delete(self, table, *, filters=None):
        return None

    def envelope(self) -> Dict[str, Any]:
        return self.period_rows[0]["assembled_canonical_v1"]


@pytest.fixture()
def fake_admin(monkeypatch):
    fake = FakeAdminClient()

    @contextlib.contextmanager
    def _fake_admin():
        yield fake

    monkeypatch.setattr(_pipeline._supabase, "admin", _fake_admin)
    return fake


@pytest.fixture()
def journal_dir(monkeypatch, tmp_path):
    root = tmp_path / "journal"
    monkeypatch.setenv(_hooks.ENV_VAR, str(root))
    _hooks.reset_cache()
    yield root
    _hooks.reset_cache()


# ── corpus-fixture stage composition (the REAL seams) ──────────────────


def load_case(case_id: str):
    """(doc, parsed, tb_rows) for a corpus case, via the real pack
    parse seam + pipeline's shared parsed-payload builder."""
    pack = get_pack("RO")
    case_dir = CORPUS / case_id
    input_path = sorted(case_dir.glob("input.*"))[0]
    content = input_path.read_bytes()
    if input_path.suffix == ".csv":
        tb_rows = pack.parse_trial_balance_csv(content, input_path.name)
    else:
        tb_rows = pack.parse_trial_balance(content, input_path.name)
    shaped = pack.accounts_to_assemble_shape(tb_rows)
    doc = {
        "id": "doc-%s" % case_id,
        "org_id": "org-journal",
        "original_filename": input_path.name,
        "content_hash": "sha256-%s" % hashlib.sha256(content).hexdigest(),
        "period_end_hint": "2025-12-31",
    }
    parsed = _pipeline._deterministic_tb_parsed(
        doc, tb_rows, shaped,
        pack.compute_statutory_net_profit_anchor(tb_rows),
        pack.compute_source_imbalance(tb_rows),
    )
    return doc, parsed


def deliver(doc: Dict[str, Any], parsed: Dict[str, Any]) -> str:
    """One full journaled pipeline delivery through the REAL stage
    composition: hooks at the boundaries + stage_map + stage_persist
    (whose internal reconcile/snapshot hooks fire on the same run)."""
    _hooks.on_run_started(doc, industry=None)
    _hooks.on_frontend_done(doc, parsed)
    assembled = _pipeline.stage_map(doc, copy.deepcopy(parsed), None)
    _hooks.on_pass_done(doc, assembled)
    return _pipeline.stage_persist(doc, copy.deepcopy(parsed), assembled)


def serve(fake: FakeAdminClient) -> Dict[str, Any]:
    """The REAL shared serve hook over the persisted period row (fires
    the SERVED journal seam)."""
    statements: Dict[str, Any] = {"assembled_bs": {}, "assembled_pl": {"revenue": 0.0}}
    _pipeline._apply_envelope_truth_to_statements(
        statements, {"assembled_canonical_v1": fake.envelope()}
    )
    return statements


def norm_dump(envelope: Dict[str, Any]) -> bytes:
    data, _lossy = canonical_bytes(normalized_envelope(envelope))
    return data


def event_types(journal: Journal, file_hash: str) -> List[str]:
    return [e["type"] for e in journal.chain_events(file_hash)]


# ── no-op guarantee (corpus replay / determinism gates depend on it) ───


def test_hooks_are_noops_when_journal_disabled(monkeypatch, tmp_path, fake_admin):
    monkeypatch.delenv(_hooks.ENV_VAR, raising=False)
    _hooks.reset_cache()
    doc, parsed = load_case("csv")
    period_id = deliver(doc, parsed)
    serve(fake_admin)
    assert period_id == "period-1"
    assert fake_admin.envelope()  # pipeline result unaffected
    assert _hooks.active_run() is None
    # No journal artifacts anywhere near the tmp tree.
    assert not (tmp_path / "journal").exists()
    default_root = REPO / "data" / "journal"
    assert not default_root.exists() or _no_new_runs(default_root)


def _no_new_runs(root: Path) -> bool:
    runs = root / "runs"
    return not runs.exists() or not any(runs.iterdir())


# ── K1: typed hash-chained events + tamper detection ───────────────────


def test_k1_event_sequence_and_chain_verifies(journal_dir, fake_admin):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    serve(fake_admin)

    journal = Journal(journal_dir)
    fh = doc["content_hash"]
    types = event_types(journal, fh)
    assert types == [
        "RUN_STARTED", "FRONTEND_DONE", "PASS_DONE",
        "RECONCILE_SKIPPED", "SNAPSHOT_PERSISTED",
        "RUN_STARTED", "SERVED",  # the serve-observation run
    ]
    for t in types:
        assert t in EVENT_TYPES
    events = journal.chain_events(fh)
    started = events[0]
    assert started["payload"]["file_hash"] == fh
    assert started["payload"]["engine_version"].startswith("scandia-engine@")
    assert started["prev_event_hash"] is None
    frontend = events[1]
    assert frontend["payload"]["front_end_id"] == "saga_10_col"
    assert journal.store.has(frontend["payload"]["ir_hash"])
    passed = events[2]
    assert passed["payload"]["pass"] == "assemble"
    assert passed["payload"]["pack_hash"]
    assert journal.store.has(passed["payload"]["layer_hash"])
    reconcile = events[3]
    assert reconcile["payload"]["reason"] == "balanced_noop"
    snapshot = events[4]
    assert snapshot["payload"]["snapshot_id"].startswith("snap_")
    assert snapshot["payload"]["key"]["pack_hash"]
    served = events[6]
    assert served["payload"]["envelope_version"] == "sv1"
    # Cross-run linkage: serve run's first event chains onto the
    # pipeline run's tail.
    assert events[5]["prev_event_hash"] == events[4]["event_hash"]

    # The snapshot object IS the persisted envelope, byte-for-byte.
    stored = json.loads(
        journal.store.read_object(snapshot["payload"]["content_hash"]).decode("utf-8")
    )
    assert stored == fake_admin.envelope()

    assert journal.verify_chain(fh) == []


def test_k1_tamper_detection(journal_dir, fake_admin):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    journal = Journal(journal_dir)
    fh = doc["content_hash"]
    assert journal.verify_chain(fh) == []

    run_id = journal.registered_runs(fh)[0]["run_id"]
    run_path = journal._run_path(run_id)
    lines = run_path.read_text(encoding="utf-8").splitlines()
    tampered = json.loads(lines[1])
    tampered["payload"]["front_end_id"] = "doctored_format"
    lines[1] = json.dumps(tampered, sort_keys=True, ensure_ascii=False,
                          separators=(",", ":"))
    run_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    errors = journal.verify_chain(fh)
    assert errors, "tampered chain must fail verification"
    assert any("event_hash mismatch" in e for e in errors)

    # The CLI mirrors this as a non-zero exit.
    cli = _load_cli()
    assert cli.main(["--journal-root", str(journal_dir), "verify", "--all"]) == 1


def _load_cli():
    scripts = REPO / "scripts"
    if str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    import importlib

    return importlib.import_module("journal_cli")


# ── K3: duplicate delivery short-circuits to the existing chain ────────


def test_k3_duplicate_delivery_one_chain_one_snapshot(journal_dir, fake_admin):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    journal = Journal(journal_dir)
    fh = doc["content_hash"]
    baseline_events = event_types(journal, fh)
    assert baseline_events.count("SNAPSHOT_PERSISTED") == 1

    # Same upload, same engine versions — delivered again.
    deliver(doc, parsed)

    handle = _hooks.active_run()
    assert handle is not None and handle.short_circuited
    assert handle.duplicate_of == journal.registered_runs(fh)[0]["run_id"]

    # Exactly one chain: one registered pipeline run, one run file, one
    # snapshot event, and the store deduplicated the envelope object.
    assert event_types(journal, fh) == baseline_events
    assert [e["run_kind"] for e in journal.registered_runs(fh)] == ["pipeline"]
    assert len(list((journal_dir / "runs").glob("*.jsonl"))) == 1
    assert len(journal.snapshots(fh)) == 1
    assert journal.verify_chain(fh) == []

    # The pipeline itself still re-persisted (serving source of truth
    # untouched by the journal's dedup).
    envelope_writes = [
        p for t, p, _f in fake_admin.updates
        if t == "financial_periods" and "assembled_canonical_v1" in p
    ]
    assert len(envelope_writes) == 2


# ── SERVED dedupe + out-of-band self-heal ──────────────────────────────


def test_served_emitted_once_per_distinct_state(journal_dir, fake_admin):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    serve(fake_admin)
    serve(fake_admin)
    serve(fake_admin)
    journal = Journal(journal_dir)
    fh = doc["content_hash"]
    assert event_types(journal, fh).count("SERVED") == 1


def test_serve_observes_out_of_band_envelope_mutation(journal_dir, fake_admin):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    serve(fake_admin)
    journal = Journal(journal_dir)
    fh = doc["content_hash"]
    assert len(journal.snapshots(fh)) == 1

    # Out-of-band mutation (the undo route's write shape) — no
    # stage_persist involved.
    mutated = copy.deepcopy(fake_admin.envelope())
    mutated["reconciliation_suppressed"] = [
        {"content_hash": fh, "suppressed_by": "user-1"}
    ]
    fake_admin.update(
        "financial_periods",
        {"assembled_canonical_v1": mutated},
        filters={"id": "eq.period-1"},
    )
    serve(fake_admin)

    snaps = journal.snapshots(fh)
    assert len(snaps) == 2
    assert snaps[-1]["payload"]["origin"] == "serve_observed"
    assert event_types(journal, fh).count("SERVED") == 2
    assert journal.verify_chain(fh) == []


# ── reconcile events on a case that actually auto-reconciles ───────────


def test_reconcile_applied_event_carries_receipt_hash(journal_dir, fake_admin):
    doc, parsed = load_case("rounding_004pct")
    deliver(doc, parsed)
    journal = Journal(journal_dir)
    fh = doc["content_hash"]
    events = journal.chain_events(fh)
    applied = [e for e in events if e["type"] == "RECONCILE_APPLIED"]
    assert len(applied) == 1
    assert applied[0]["payload"]["diagnosis_code"] == "R1_ROUNDING_CENTS"
    assert applied[0]["payload"]["origin"] == "deterministic"
    assert len(applied[0]["payload"]["receipt_hash"]) == 64
    assert fake_admin.envelope().get("reconciliation")


# ── K9 seed: scan → undo → re-scan, then as-of each era ────────────────


def test_k9_asof_returns_each_eras_envelope(journal_dir, fake_admin):
    doc, parsed = load_case("rounding_004pct")
    journal = Journal(journal_dir)
    fh = doc["content_hash"]

    t0 = datetime.now(timezone.utc).isoformat()  # before any history
    time.sleep(0.01)

    # Era 1 — scan: auto-reconciled envelope persisted + served.
    deliver(doc, parsed)
    serve(fake_admin)
    era1 = copy.deepcopy(fake_admin.envelope())
    assert isinstance(era1.get("reconciliation"), dict)
    time.sleep(0.01)
    t1 = datetime.now(timezone.utc).isoformat()
    time.sleep(0.01)

    # Era 2 — undo (the real reconcile-undo mutation, written the way
    # the route writes it: straight to the period row, no stage_persist).
    updated, _served = _reconcile.perform_undo(
        copy.deepcopy(fake_admin.envelope()), "user-1"
    )
    fake_admin.update(
        "financial_periods",
        {"assembled_canonical_v1": updated},
        filters={"id": "eq.period-1"},
    )
    serve(fake_admin)  # the serve seam self-heals the chain
    era2 = copy.deepcopy(fake_admin.envelope())
    assert "reconciliation" not in era2
    assert era2.get("reconciliation_suppressed")
    time.sleep(0.01)
    t2 = datetime.now(timezone.utc).isoformat()
    time.sleep(0.01)

    # Era 3 — re-scan of the same file: suppression carried forward, the
    # auto stage honors the user's choice, raw state persists.
    deliver(doc, parsed)
    serve(fake_admin)
    era3 = copy.deepcopy(fake_admin.envelope())
    assert "reconciliation" not in era3
    assert era3.get("reconciliation_suppressed")
    time.sleep(0.01)
    t3 = datetime.now(timezone.utc).isoformat()

    # As-of resolution: the envelope that was live at each moment,
    # byte-compared under the corpus volatile-normalization discipline.
    assert journal.asof(fh, t0) is None  # pre-journal history is absent

    got1 = journal.asof(fh, t1)
    assert got1 is not None
    assert norm_dump(got1["assembled_canonical_v1"]) == norm_dump(era1)
    assert isinstance(got1["assembled_canonical_v1"].get("reconciliation"), dict)

    got2 = journal.asof(fh, t2)
    assert got2 is not None
    assert norm_dump(got2["assembled_canonical_v1"]) == norm_dump(era2)
    assert "reconciliation" not in got2["assembled_canonical_v1"]
    assert got2["snapshot"]["origin"] == "serve_observed"

    got3 = journal.asof(fh, t3)
    assert got3 is not None
    assert norm_dump(got3["assembled_canonical_v1"]) == norm_dump(era3)

    # Chain lookup also works by document id and by period id.
    assert journal.resolve_chain(doc["id"]) == fh
    assert journal.resolve_chain("period-1") == fh
    got_by_period = journal.asof("period-1", t1)
    assert got_by_period is not None
    assert norm_dump(got_by_period["assembled_canonical_v1"]) == norm_dump(era1)

    assert journal.verify_chain(fh) == []


# ── CLI surface ────────────────────────────────────────────────────────


def test_cli_verify_asof_dlq_notice(journal_dir, fake_admin, capsys):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    time.sleep(0.01)
    t = datetime.now(timezone.utc).isoformat()
    cli = _load_cli()

    assert cli.main(["--journal-root", str(journal_dir), "verify", "--all"]) == 0
    capsys.readouterr()

    assert cli.main(["--journal-root", str(journal_dir), "asof", doc["content_hash"], t]) == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["snapshot"]["origin"] == "pipeline"
    assert payload["assembled_canonical_v1"]["provenance"]["source_document_id"] == doc["id"]

    # No coverage → exit 3 (honest absence).
    assert cli.main(["--journal-root", str(journal_dir), "asof", "sha256-unknown", t]) == 3
    capsys.readouterr()

    # DLQ list prints the battery NOTICE line and never fails.
    assert cli.main(["--journal-root", str(journal_dir), "dlq", "list"]) == 0
    out = capsys.readouterr().out
    assert "NOTICE  journal: DLQ depth 0" in out

    assert cli.main(["--journal-root", str(journal_dir), "notice"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("NOTICE  journal: DLQ depth")

    # gc is list-only by default.
    assert cli.main(["--journal-root", str(journal_dir), "gc"]) == 0
    out = capsys.readouterr().out
    assert "LIST-ONLY" in out


# ── the as-of API route (auth-injected, RLS-visible period) ────────────


def _mounted_asof_endpoint(monkeypatch, period_row):
    from fastapi import APIRouter
    from engine.api import _journal_routes

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

    monkeypatch.setattr(
        _journal_routes._supabase, "per_user", lambda jwt: _PerUser()
    )
    endpoint = None
    for route in router.routes:
        if getattr(route, "path", "") == "/api/period/{period_id}/asof":
            endpoint = route.endpoint
    assert endpoint is not None, "asof route not mounted"
    return endpoint


def test_asof_route_serves_journal_snapshot(journal_dir, fake_admin, monkeypatch):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    time.sleep(0.01)
    t = datetime.now(timezone.utc).isoformat()

    endpoint = _mounted_asof_endpoint(monkeypatch, fake_admin.period_rows[0])
    result = endpoint(period_id="period-1", t=t, authorization="Bearer x")
    assert result["period_id"] == "period-1"
    assert result["as_of"] == t
    assert result["snapshot"]["origin"] == "pipeline"
    assert norm_dump(result["assembled_canonical_v1"]) == norm_dump(fake_admin.envelope())


def test_asof_route_404s_without_coverage(journal_dir, fake_admin, monkeypatch):
    from fastapi import HTTPException

    # A visible period that the journal has never seen (pre-journal).
    period_row = {"id": "period-legacy", "assembled_canonical_v1": None}
    endpoint = _mounted_asof_endpoint(monkeypatch, period_row)
    t = datetime.now(timezone.utc).isoformat()
    with pytest.raises(HTTPException) as exc_info:
        endpoint(period_id="period-legacy", t=t, authorization="Bearer x")
    assert exc_info.value.status_code == 404

    # Unparseable timestamp → 422.
    with pytest.raises(HTTPException) as exc_info:
        endpoint(period_id="period-legacy", t="not-a-time", authorization="Bearer x")
    assert exc_info.value.status_code == 422


def test_asof_route_mounted_in_pipeline_router():
    router = _pipeline.build_router()
    paths = {getattr(r, "path", "") for r in router.routes}
    assert "/api/period/{period_id}/asof" in paths
