"""Observability & drift sentinels suite (Part D) — engine.obs.

Covers the four obs surfaces plus their ops mounts:

  · tracing    — journal-hook seams: inert by default, memory recorder
                 spans per stage on the REAL pipeline composition, OTel
                 degrade path, never-breaks-the-hook contract;
  · metrics    — registry (counters/histograms, JSON-dumpable) + the
                 on-demand collector over a REAL journaled run;
  · sentinels  — baseline seed / steady / departure lifecycle, EWMA
                 update, corruption reset, read-only mode, never-raise;
  · status     — battery-record parsing conventions + ops_snapshot
                 read-only guarantee;
  · route/CLI  — GET /api/ops (auth injection, degrade-open) and
                 scripts/engine_ops.py exit codes (0 even on drift
                 departures — notices, never red).

Harness mirrors tests/engine/test_journal.py: the fake-admin Supabase
stand-in + the REAL pack parse / stage_map / stage_persist seams, with
the journal enabled per-test via ENGINE_JOURNAL_DIR. Everything runs
with ENGINE_OBS_TRACE unset unless a test opts in — the same inert
default the corpus replay and determinism gates rely on.
"""
from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

from engine.core.country_pack_registry import get_pack
from engine.api import pipeline as _pipeline
from engine.journal import Journal
from engine.journal import hooks as _hooks
from engine.obs import metrics as _metrics
from engine.obs import sentinels as _sentinels
from engine.obs import status as _status
from engine.obs import tracing as _tracing
from engine.obs.metrics import MetricsRegistry, collect_metrics

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"


# ── harness (mirrors test_journal.py — the REAL seams) ─────────────────


class FakeAdminClient:
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
            new["id"] = "period-1"
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


@pytest.fixture()
def obs_dir(monkeypatch, tmp_path):
    """Point data/obs at a tmp dir so no test touches the repo tree."""
    root = tmp_path / "obs"
    monkeypatch.setenv(_sentinels.OBS_DIR_ENV, str(root))
    return root


@pytest.fixture(autouse=True)
def _clean_tracing():
    """Every test starts and ends with pristine hooks + empty recorder.
    (The wrappers are pass-throughs when ENGINE_OBS_TRACE is unset, but
    span state must never bleed between tests.)"""
    _tracing.reset_for_tests()
    yield
    _tracing.uninstall()
    _tracing.reset_for_tests()


@pytest.fixture()
def traced(monkeypatch):
    """Install the hook seams in memory mode (no OTel involvement)."""
    monkeypatch.setenv(_tracing.ENABLE_ENV, "memory")
    assert _tracing.install() is True
    return _tracing


def load_case(case_id: str):
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
        "id": "doc-obs-%s" % case_id,
        "org_id": "org-obs",
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
    """One full delivery through the REAL stage composition (the same
    boundaries production crosses — hook calls resolve through the
    module attribute, so installed tracing seams are exercised)."""
    _hooks.on_run_started(doc, industry=None)
    _hooks.on_frontend_done(doc, parsed)
    assembled = _pipeline.stage_map(doc, copy.deepcopy(parsed), None)
    _hooks.on_pass_done(doc, assembled)
    return _pipeline.stage_persist(doc, copy.deepcopy(parsed), assembled)


def spans_by_name(name: str) -> List[Dict[str, Any]]:
    return [s for s in _tracing.recent_spans() if s["name"] == name]


# ── metrics registry ───────────────────────────────────────────────────


def test_registry_counters_histograms_are_json_dumpable():
    reg = MetricsRegistry()
    reg.inc("frontend_mix", "saga_10_col")
    reg.inc("frontend_mix", "saga_10_col")
    reg.inc("frontend_mix", "pdf_scan")
    reg.inc("runs_started")
    reg.observe("imbalance_ratio", 0.0)
    reg.observe("imbalance_ratio", 0.004)
    reg.observe("imbalance_ratio", 99.0)  # lands in the +Inf overflow
    reg.observe("custom", 3.0, buckets=(1.0, 5.0))

    snap = reg.snapshot()
    encoded = json.dumps(snap)  # must never raise
    assert json.loads(encoded) == snap

    assert snap["counters"]["frontend_mix"] == {"saga_10_col": 2, "pdf_scan": 1}
    assert reg.counter_total("frontend_mix") == 3
    hist = snap["histograms"]["imbalance_ratio"]
    assert hist["count"] == 3
    assert hist["min"] == 0.0 and hist["max"] == 99.0
    assert hist["buckets"][-1] == {"le": "+Inf", "count": 1}
    # 0.0 falls in the first bucket (le 0.0); 0.004 within le 0.005.
    assert hist["buckets"][0]["count"] == 1
    custom = snap["histograms"]["custom"]
    assert [b["le"] for b in custom["buckets"]] == [1.0, 5.0, "+Inf"]
    assert custom["buckets"][1]["count"] == 1


def test_registry_ignores_unparseable_observations():
    reg = MetricsRegistry()
    reg.observe("h", "not-a-number")
    reg.observe("h", None)
    assert reg.snapshot()["histograms"] == {}


# ── tracing: inert by default ──────────────────────────────────────────


def test_tracing_disabled_records_nothing(monkeypatch, journal_dir, fake_admin):
    monkeypatch.delenv(_tracing.ENABLE_ENV, raising=False)
    assert _tracing.install() is True
    assert _tracing.enabled() is False
    doc, parsed = load_case("csv")
    period_id = deliver(doc, parsed)
    assert period_id == "period-1"
    assert fake_admin.envelope()  # pipeline outcome untouched
    assert _tracing.recent_spans() == []


def test_tracing_install_is_idempotent_and_uninstall_restores():
    assert _tracing.install() is True
    wrapped = {name: getattr(_hooks, name) for name in _tracing._HOOK_NAMES}
    assert all(getattr(fn, _tracing._WRAP_MARK, False) for fn in wrapped.values())
    assert _tracing.install() is True  # second install: no double-wrap
    for name in _tracing._HOOK_NAMES:
        assert getattr(_hooks, name) is wrapped[name]
    _tracing.uninstall()
    for name in _tracing._HOOK_NAMES:
        assert not getattr(getattr(_hooks, name), _tracing._WRAP_MARK, False)


# ── tracing: memory recorder over the real run ─────────────────────────


def test_traced_run_emits_stage_spans_sharing_the_journal_run_id(
    traced, journal_dir, fake_admin
):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)

    names = [s["name"] for s in _tracing.recent_spans()]
    for expected in (
        "stage.extract", "stage.map", "stage.reconcile", "stage.persist",
        "pipeline.run",
    ):
        assert expected in names, "missing span %s in %s" % (expected, names)

    (root,) = spans_by_name("pipeline.run")
    journal = Journal(journal_dir)
    (chain_key,) = journal.list_chains()
    run_id = journal.chain_events(chain_key)[0]["run_id"]
    # One trace per run — the trace id IS the journal run id.
    assert root["trace_id"] == run_id
    assert root["status"] == "ok"
    assert root["attributes"]["file_hash"] == doc["content_hash"]
    assert root["attributes"]["final_status"] == "BALANCED"
    # Model ids from the registry ride on the root span.
    assert root["attributes"]["ai.model.extract"]
    assert root["attributes"]["ai.model.ai_validator"]

    (extract,) = spans_by_name("stage.extract")
    assert extract["trace_id"] == run_id
    assert extract["parent_id"] == root["span_id"]  # real parent linkage
    assert extract["attributes"]["front_end_id"] == "saga_10_col"
    assert extract["attributes"]["cache_hit"] is False
    assert str(extract["attributes"]["ir_hash"])  # content-addressed digest

    (mapped,) = spans_by_name("stage.map")
    pack_prov = fake_admin.envelope()["pack_provenance"]
    assert mapped["attributes"]["pack_hash"] == pack_prov["pack_hash"]

    (reconcile,) = spans_by_name("stage.reconcile")
    assert reconcile["attributes"]["outcome"] == "balanced_noop"
    (persist,) = spans_by_name("stage.persist")
    assert persist["attributes"]["status"] == "BALANCED"
    assert persist["attributes"]["period_id"] == "period-1"
    # Stage spans tile the run: each starts where the previous ended.
    assert extract["end"] <= mapped["start"] + 1e-6
    assert root["start"] <= extract["start"] and persist["end"] <= root["end"] + 1e-6


def test_traced_run_works_with_journal_disabled(traced, monkeypatch, fake_admin):
    monkeypatch.delenv(_hooks.ENV_VAR, raising=False)
    _hooks.reset_cache()
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    (root,) = spans_by_name("pipeline.run")
    assert root["trace_id"]  # a synthesized trace id — no journal run behind it
    assert spans_by_name("stage.extract") and spans_by_name("stage.persist")


def test_traced_failed_run_closes_root_with_error(traced, journal_dir, fake_admin):
    doc, parsed = load_case("csv")
    _hooks.on_run_started(doc, industry=None)
    _hooks.on_run_failed(doc["id"], RuntimeError("boom at extract"))
    (root,) = spans_by_name("pipeline.run")
    assert root["status"] == "error"
    assert root["attributes"]["error_type"] == "RuntimeError"
    assert "boom at extract" in root["attributes"]["error_message"]


def test_tracing_fault_never_breaks_the_hook(traced, monkeypatch, journal_dir,
                                             fake_admin):
    # Blow up INSIDE the span derivations (extract + map both hash
    # content) — the wrapper must swallow it and the pipeline must land.
    def _raiser(obj):
        raise ValueError("derivation exploded")

    monkeypatch.setattr(_tracing, "_content_hash_of", _raiser)
    doc, parsed = load_case("csv")
    period_id = deliver(doc, parsed)  # must not raise
    assert period_id == "period-1"
    assert fake_admin.envelope()
    assert spans_by_name("stage.extract") == []  # the faulty spans dropped
    assert spans_by_name("stage.map") == []
    assert spans_by_name("pipeline.run")  # the rest of the trace survives


def test_tracing_export_mode_degrades_without_otel_sdk(monkeypatch, journal_dir,
                                                       fake_admin):
    monkeypatch.setenv(_tracing.ENABLE_ENV, "console")
    monkeypatch.setattr(_tracing, "_otel_disabled_for_tests", True)
    assert _tracing.install() is True
    doc, parsed = load_case("csv")
    deliver(doc, parsed)  # no SDK -> memory recorder only, never a crash
    assert spans_by_name("pipeline.run")


def test_tracing_console_export_with_sdk_if_installed(monkeypatch, journal_dir,
                                                      fake_admin, capsys):
    pytest.importorskip("opentelemetry.sdk")
    monkeypatch.setenv(_tracing.ENABLE_ENV, "console")
    assert _tracing.install() is True
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    assert spans_by_name("pipeline.run")  # memory recorder still primary
    out = capsys.readouterr().out
    assert '"pipeline.run"' in out or "pipeline.run" in out  # exporter printed


# ── metrics collector ──────────────────────────────────────────────────


def test_collect_metrics_without_any_journal_is_honest(monkeypatch):
    monkeypatch.setattr(_metrics, "default_journal_root", lambda: None)
    out = collect_metrics(None)
    assert out["journal"] == {"enabled": False, "root": None, "chains": 0}
    assert out["dlq_depth"] == 0
    assert all(v is None for v in out["rates"].values())
    assert out["coverage"]["docs"] == 0
    json.dumps(out)  # the whole payload is JSON-clean


def test_collect_metrics_honors_explicit_empty_root(tmp_path):
    out = collect_metrics(tmp_path / "fresh-journal")
    assert out["journal"]["enabled"] is True
    assert out["journal"]["chains"] == 0


def test_collect_metrics_over_a_real_run(journal_dir, fake_admin):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)

    out = collect_metrics(journal_dir)
    assert out["schema"] == "obs_metrics_v1"
    assert out["journal"]["enabled"] is True and out["journal"]["chains"] == 1
    counters = out["counters"]
    assert counters["runs_started"] == {"_": 1}
    assert counters["frontend_mix"] == {"saga_10_col": 1}
    assert counters["status_mix"] == {"BALANCED": 1}
    assert counters["extraction_method_mix"] == {"deterministic": 1}
    assert counters["reconcile_outcomes"] == {"balanced_noop": 1}

    hist = out["histograms"]["imbalance_ratio"]
    assert hist["count"] == 1
    assert hist["max"] == 0.0  # the csv case serves an exactly balanced BS

    rates = out["rates"]
    assert rates["unclassified_rate"] == 0.0
    assert rates["frontend_fallback_rate"] == 0.0
    assert rates["ai_proposal_rate"] == 0.0
    assert rates["cache_hit_rate"] is None  # no AI-lane runs in this chain

    verification = out["verification"]
    assert verification == {"checked": 1, "failed": 0, "errors": []}
    assert out["dlq_depth"] == 0
    assert isinstance(out.get("ai_spend"), dict)
    json.dumps(out)


def test_collect_metrics_reads_ai_signals_from_a_crafted_chain(tmp_path):
    """AI agreement, verification coverage, unclassified + fallback rates
    and token estimates — driven through the journal's own public write
    path (an adhoc run recording a crafted envelope)."""
    root = tmp_path / "journal-ai"
    journal = Journal(root)
    envelope = {
        "canonical_bs": {
            "status": "BALANCED",
            "extraction": {"method": "llm", "source_format": "pdf_scan"},
            "unmapped": [{"account": "9999"}, {"account": "8888"}],
            "rows": [{"a": 1}, {"a": 2}, {"a": 3}],
        },
        "reconciliation": {"origin": "ai", "applied": True},
        "ai_audit": {"stages": [{"raw_response": "y" * 800}]},
        "ai_review": {
            "extraction_verification": {"ran": True, "agreement_score": 0.97},
            "audit": {"stages": [{"raw_response": "x" * 400}]},
        },
    }
    handle = journal.begin_run(
        file_hash="sha256-crafted-ai-doc",
        document_id="doc-ai",
        engine_version="test",
        run_kind="adhoc",
    )
    handle.record_snapshot(envelope, period_id="period-ai", origin="pipeline")

    out = collect_metrics(root)
    rates = out["rates"]
    assert rates["unclassified_rate"] == 1.0
    assert rates["unclassified_account_rate"] == pytest.approx(2 / 5)
    assert rates["frontend_fallback_rate"] == 1.0
    assert rates["ai_proposal_rate"] == 1.0
    assert rates["verification_coverage"] == 1.0
    agreement = out["histograms"]["ai_agreement_score"]
    assert agreement["count"] == 1 and agreement["max"] == 0.97
    # chars/4 across BOTH audit transcripts: (800 + 400) / 4.
    assert rates["avg_ai_tokens_per_doc"] == 300.0
    assert out["counters"]["reconciled_docs"] == {"ai": 1}
    assert out["counters"]["unclassified_accounts"] == {"_": 2}


def test_collect_metrics_survives_a_corrupted_snapshot_object(
    journal_dir, fake_admin
):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    # Flip bytes in every stored object — chain verification must fail
    # loudly while collection degrades to zero-coverage, never raises.
    objects_root = journal_dir / "objects"
    corrupted = 0
    for path in objects_root.rglob("*"):
        if path.is_file():
            path.write_bytes(b"not json at all \xff")
            corrupted += 1
    assert corrupted > 0
    out = collect_metrics(journal_dir)
    assert out["verification"]["checked"] == 1
    assert out["verification"]["failed"] == 1
    assert out["verification"]["errors"]
    assert out["coverage"]["docs"] == 0  # unreadable envelope = no coverage
    json.dumps(out)


def test_sentinel_rate_keys_are_a_subset_of_collector_rates(monkeypatch):
    monkeypatch.setattr(_metrics, "default_journal_root", lambda: None)
    rates = collect_metrics(None)["rates"]
    for key in _metrics.SENTINEL_RATE_KEYS:
        assert key in rates


# ── drift sentinels ────────────────────────────────────────────────────


def _fake_metrics(**rates: Any) -> Dict[str, Any]:
    base = {
        "unclassified_rate": None,
        "ai_proposal_rate": None,
        "frontend_fallback_rate": None,
    }
    base.update(rates)
    return {"rates": base}


def test_sentinels_seed_steady_departure_lifecycle(obs_dir):
    baseline_file = obs_dir / "baseline.json"

    # Night 1 — first observation SEEDS silently (no departure).
    first = _sentinels.evaluate_sentinels(
        _fake_metrics(unclassified_rate=0.0, frontend_fallback_rate=0.30),
        baseline_file=baseline_file,
    )
    assert first["departures"] == []
    assert any("seeded" in n for n in first["notices"])
    assert first["baseline_updated"] is True
    assert baseline_file.is_file()

    # Night 2 — same rates: steady, no departures, EWMA keeps the mean.
    second = _sentinels.evaluate_sentinels(
        _fake_metrics(unclassified_rate=0.0, frontend_fallback_rate=0.30),
        baseline_file=baseline_file,
    )
    assert second["departures"] == []
    assert all("seeded" not in n for n in second["notices"] if "unclassified" in n)

    # Night 3 — unclassified jumps 0 -> 0.5: the "new SAGA variant in the
    # wild" NOTICE (alert-level, never red) plus a structured departure.
    third = _sentinels.evaluate_sentinels(
        _fake_metrics(unclassified_rate=0.5, frontend_fallback_rate=0.30),
        baseline_file=baseline_file,
    )
    (departure,) = third["departures"]
    assert departure["sentinel"] == "unclassified_rate"
    assert departure["current"] == 0.5 and departure["baseline_mean"] == 0.0
    assert any(
        n.startswith("NOTICE") and "unclassified_rate" in n and "variant" in n
        for n in third["notices"]
    )
    # EWMA absorbed the night: 0.7 * 0.0 + 0.3 * 0.5.
    stored = json.loads(baseline_file.read_text())["rates"]["unclassified_rate"]
    assert stored["mean"] == pytest.approx(0.15)
    assert stored["samples"] == 3

    # A COLLAPSE departs too (both directions are newsworthy):
    # 0.0 vs mean 0.30 -> |delta| 0.30 > max(0.10, 0.15).
    collapse = _sentinels.evaluate_sentinels(
        _fake_metrics(frontend_fallback_rate=0.0, unclassified_rate=0.15),
        baseline_file=baseline_file,
    )
    assert any(
        d["sentinel"] == "frontend_fallback_rate" and d["delta"] < 0
        for d in collapse["departures"]
    )


def test_sentinels_within_relative_band_is_steady(obs_dir):
    baseline_file = obs_dir / "baseline.json"
    _sentinels.save_baseline(
        {
            "schema": _sentinels.BASELINE_SCHEMA,
            "updated_at": None,
            "rates": {"frontend_fallback_rate": {"mean": 0.40, "samples": 9}},
        },
        baseline_file,
    )
    # 0.55 vs 0.40: |delta| 0.15 <= max(0.10, 0.5*0.40 = 0.20) — inside.
    result = _sentinels.evaluate_sentinels(
        _fake_metrics(frontend_fallback_rate=0.55),
        baseline_file=baseline_file,
    )
    assert result["departures"] == []


def test_sentinels_no_coverage_skips_and_keeps_baseline(obs_dir):
    baseline_file = obs_dir / "baseline.json"
    _sentinels.save_baseline(
        {
            "schema": _sentinels.BASELINE_SCHEMA,
            "updated_at": "2026-01-01T00:00:00+00:00",
            "rates": {"unclassified_rate": {"mean": 0.2, "samples": 4}},
        },
        baseline_file,
    )
    before = baseline_file.read_text()
    result = _sentinels.evaluate_sentinels(
        _fake_metrics(), baseline_file=baseline_file
    )
    assert result["departures"] == []
    assert all("no coverage" in n for n in result["notices"])
    assert baseline_file.read_text() == before  # untouched


def test_sentinels_corrupt_baseline_resets_never_raises(obs_dir):
    baseline_file = obs_dir / "baseline.json"
    obs_dir.mkdir(parents=True, exist_ok=True)
    baseline_file.write_text("{ not json !!!", encoding="utf-8")
    result = _sentinels.evaluate_sentinels(
        _fake_metrics(unclassified_rate=0.1), baseline_file=baseline_file
    )
    assert any("seeded" in n for n in result["notices"])  # fresh start
    assert json.loads(baseline_file.read_text())["schema"] == (
        _sentinels.BASELINE_SCHEMA
    )


def test_sentinels_read_only_mode_never_writes(obs_dir):
    baseline_file = obs_dir / "baseline.json"
    result = _sentinels.evaluate_sentinels(
        _fake_metrics(unclassified_rate=0.3),
        baseline_file=baseline_file,
        update_baseline=False,
    )
    assert result["baseline_updated"] is False
    assert not baseline_file.exists()  # the /api/ops path stays read-only


def test_sentinels_never_raise_even_when_collection_explodes(monkeypatch):
    def _boom(*args, **kwargs):
        raise RuntimeError("collector down")

    monkeypatch.setattr(_sentinels, "collect_metrics", _boom)
    result = _sentinels.evaluate_sentinels()  # metrics=None -> collector path
    assert result["departures"] == []
    assert any("evaluation failed" in n for n in result["notices"])


# ── status: battery record + ops snapshot ──────────────────────────────


def test_battery_record_absent_reads_not_recorded(obs_dir):
    record = _status.read_battery_record()
    assert record["recorded"] is False
    assert str(obs_dir) in record["path"]


def test_battery_record_json_shape(tmp_path):
    target = tmp_path / "battery_last.json"
    target.write_text(json.dumps({
        "ran_at": "2026-08-23T01:00:00+00:00",
        "gates": {
            "pytest": {"ok": True, "exit_code": 0},
            "corpus_replay": {"ok": True, "exit_code": 0},
            "tsc": {"ok": False, "exit_code": 2},
        },
        "notices": ["NOTICE something informational"],
    }), encoding="utf-8")
    record = _status.read_battery_record(target)
    assert record["recorded"] is True
    assert record["ran_at"] == "2026-08-23T01:00:00+00:00"
    assert record["total"] == 3 and record["passed"] == 2
    assert record["all_green"] is False
    assert record["gates"]["tsc"]["ok"] is False


def test_battery_record_gate_list_and_plain_text_shapes(tmp_path):
    as_list = tmp_path / "list.json"
    as_list.write_text(json.dumps({
        "gates": [{"name": "pytest", "ok": True}, {"name": "build", "ok": True}],
    }), encoding="utf-8")
    record = _status.read_battery_record(as_list)
    assert record["all_green"] is True and record["total"] == 2

    as_text = tmp_path / "battery.log"
    as_text.write_text(
        "PASS pytest 1429 passed\n"
        "FAIL npm-build exit 1\n"
        "NOTICE  obs sentinel: steady\n",
        encoding="utf-8",
    )
    record = _status.read_battery_record(as_text)
    assert record["gates"]["pytest"]["ok"] is True
    assert record["gates"]["npm-build"]["ok"] is False
    assert record["all_green"] is False
    assert record["notices"] == ["NOTICE  obs sentinel: steady"]


def test_battery_env_var_points_at_explicit_file(monkeypatch, tmp_path):
    target = tmp_path / "explicit.log"
    target.write_text("PASS everything\n", encoding="utf-8")
    monkeypatch.setenv(_status.BATTERY_LOG_ENV, str(target))
    record = _status.read_battery_record()
    assert record["recorded"] is True and record["all_green"] is True


def test_ops_snapshot_sections_and_read_only(journal_dir, fake_admin, obs_dir):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)

    snap = _status.ops_snapshot(journal_dir)
    assert snap["schema"] == "obs_ops_v1"
    assert snap["battery"]["recorded"] is False  # honest "not recorded"

    versions = snap["versions"]
    assert versions["engine"].startswith("scandia-engine@")
    packs = versions["packs"]
    assert isinstance(packs, list) and packs
    for pack in packs:
        assert len(pack["pack_hash"]) == 64
        assert pack["pack_hash_short"] == pack["pack_hash"][:12]
    assert {p["jurisdiction"] for p in packs} >= {"RO", "HU"}
    models = versions["models"]
    assert "ai_validator" in models and models["ai_validator"]["model_id"]

    assert isinstance(snap["ai_spend"], dict)
    journal = snap["journal"]
    assert journal["enabled"] is True and journal["chains"] == 1
    assert journal["verified_ok"] is True and journal["dlq_depth"] == 0

    sentinels = snap["sentinels"]
    assert set(sentinels["rates"]) == set(_metrics.SENTINEL_RATE_KEYS)
    assert sentinels["departures"] == []

    assert snap["metrics"]["rates"]["unclassified_rate"] == 0.0
    json.dumps(snap, default=str)

    # READ-ONLY: the snapshot must not have seeded the rolling baseline —
    # only the nightly sentinels CLI owns that write.
    assert not (obs_dir / "baseline.json").exists()


def test_ops_snapshot_degrades_per_section_never_raises(monkeypatch, obs_dir):
    monkeypatch.setattr(_metrics, "default_journal_root", lambda: None)

    def _boom(*args, **kwargs):
        raise RuntimeError("section down")

    monkeypatch.setattr(_status, "_pack_versions", lambda: {"error": "down"})
    import engine.ai.breaker as _breaker

    monkeypatch.setattr(_breaker, "status_snapshot", _boom)
    snap = _status.ops_snapshot()
    assert snap["versions"]["packs"] == {"error": "down"}
    assert "error" in snap["ai_spend"]
    assert snap["journal"]["enabled"] is False  # everything else intact


# ── GET /api/ops (auth injection, degrade-open, mounted for real) ──────


class _PerUserOK:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def select(self, table, **kw):
        return [{"id": "p-1"}]


class _PerUserRejects:
    class _Resp:
        status_code = 401

    def __enter__(self):
        raise _RejectsError()

    def __exit__(self, *args):
        return False


class _RejectsError(Exception):
    def __init__(self):
        super().__init__("401 unauthorized")
        self.response = _PerUserRejects._Resp()


class _PerUserInfraDown:
    def __enter__(self):
        raise ConnectionError("supabase unreachable")

    def __exit__(self, *args):
        return False


def _mounted_ops_endpoint(monkeypatch, per_user_factory):
    from fastapi import APIRouter, HTTPException
    from engine.api import _ops_routes

    router = APIRouter()

    def require_jwt(authorization):
        if not authorization:
            raise HTTPException(401, "Missing Authorization header.")
        return "jwt-ok"

    _ops_routes.register_routes(router, require_jwt=require_jwt)
    monkeypatch.setattr(
        _ops_routes._supabase, "per_user", lambda jwt: per_user_factory()
    )
    endpoint = None
    for route in router.routes:
        if getattr(route, "path", "") == "/api/ops":
            endpoint = route.endpoint
    assert endpoint is not None, "/api/ops route not mounted"
    return endpoint


def test_ops_route_serves_snapshot_and_installs_tracing_seams(
    monkeypatch, obs_dir
):
    monkeypatch.setattr(_metrics, "default_journal_root", lambda: None)
    endpoint = _mounted_ops_endpoint(monkeypatch, _PerUserOK)
    # Registering the routes installed the (inert) tracing seams.
    assert getattr(
        _hooks.on_run_started, _tracing._WRAP_MARK, False
    ), "register_routes must install the tracing seams"
    body = endpoint(authorization="Bearer x")
    assert body["schema"] == "obs_ops_v1"
    assert not (obs_dir / "baseline.json").exists()  # route is read-only


def test_ops_route_requires_bearer_and_rejects_bad_tokens(monkeypatch, obs_dir):
    from fastapi import HTTPException

    monkeypatch.setattr(_metrics, "default_journal_root", lambda: None)
    endpoint = _mounted_ops_endpoint(monkeypatch, _PerUserRejects)
    with pytest.raises(HTTPException) as exc_info:
        endpoint(authorization=None)
    assert exc_info.value.status_code == 401  # no header at all
    with pytest.raises(HTTPException) as exc_info:
        endpoint(authorization="Bearer definitely-expired")
    assert exc_info.value.status_code == 401  # definitive PostgREST reject


def test_ops_route_degrades_open_on_infra_trouble(monkeypatch, obs_dir):
    monkeypatch.setattr(_metrics, "default_journal_root", lambda: None)
    endpoint = _mounted_ops_endpoint(monkeypatch, _PerUserInfraDown)
    body = endpoint(authorization="Bearer x")  # ops keeps answering
    assert body["schema"] == "obs_ops_v1"


def test_ops_route_mounted_in_pipeline_router():
    router = _pipeline.build_router()
    paths = {getattr(r, "path", "") for r in router.routes}
    assert "/api/ops" in paths


# ── scripts/engine_ops.py CLI (exit 0 always — notices, never red) ─────


def _cli():
    from conftest import load_module_from_path

    return load_module_from_path(
        "engine_ops_cli", REPO / "scripts" / "engine_ops.py"
    )


def test_cli_status_human_and_json(journal_dir, fake_admin, obs_dir, capsys):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    cli = _cli()
    assert cli.main(["--journal-root", str(journal_dir), "status"]) == 0
    out = capsys.readouterr().out
    assert "ENGINE OPS" in out
    assert "battery      not recorded" in out
    assert "chain verify OK" in out
    assert cli.main(["--journal-root", str(journal_dir), "status", "--json"]) == 0
    body = json.loads(capsys.readouterr().out)
    assert body["schema"] == "obs_ops_v1"


def test_cli_metrics_json(journal_dir, fake_admin, obs_dir, capsys):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    cli = _cli()
    assert cli.main(["--journal-root", str(journal_dir), "metrics", "--json"]) == 0
    body = json.loads(capsys.readouterr().out)
    assert body["schema"] == "obs_metrics_v1"
    assert body["counters"]["frontend_mix"] == {"saga_10_col": 1}


def test_cli_sentinels_updates_baseline_and_exits_zero_on_departure(
    journal_dir, fake_admin, obs_dir, capsys
):
    doc, parsed = load_case("csv")
    deliver(doc, parsed)
    cli = _cli()

    # First run seeds the baseline in ENGINE_OBS_DIR.
    assert cli.main(["--journal-root", str(journal_dir), "sentinels"]) == 0
    out = capsys.readouterr().out
    assert "seeded" in out
    baseline_file = obs_dir / "baseline.json"
    assert baseline_file.is_file()

    # Poison the baseline mean so tonight's run is a guaranteed departure
    # — the CLI must NOTICE loudly and still exit 0 (never red).
    baseline = json.loads(baseline_file.read_text())
    baseline["rates"]["unclassified_rate"] = {"mean": 0.9, "samples": 30}
    baseline_file.write_text(json.dumps(baseline), encoding="utf-8")
    assert cli.main(["--journal-root", str(journal_dir), "sentinels"]) == 0
    out = capsys.readouterr().out
    assert "NOTICE  obs sentinel: unclassified_rate" in out

    # --no-update leaves the file byte-identical.
    before = baseline_file.read_text()
    assert cli.main(
        ["--journal-root", str(journal_dir), "sentinels", "--no-update"]
    ) == 0
    assert baseline_file.read_text() == before


def test_cli_defaults_to_status(monkeypatch, obs_dir, capsys):
    monkeypatch.setattr(_metrics, "default_journal_root", lambda: None)
    cli = _cli()
    assert cli.main([]) == 0
    assert "ENGINE OPS" in capsys.readouterr().out


# ── The battery's THIRD STATE, read correctly ────────────────────────────
#
# A gate can run cleanly and examine NOTHING — its subject absent on this
# host. The battery records that as `state: "VACUOUS"` while keeping
# `ok: True`, so an environmental absence does not red the ops surface.
#
# The reader counted only `ok`, so it reported 31/31 ALL GREEN while one
# gate was evidence of nothing: the same false green the battery itself
# was taught to refuse, one layer up. The record knew; the reader did not
# ask.

def _battery_file(tmp_path, gates):
    import json
    p = tmp_path / "battery_last.json"
    p.write_text(json.dumps({"ran_at": "2026-08-31T00:00:00+00:00",
                             "gates": gates, "notices": []}),
                 encoding="utf-8")
    return p


def test_a_vacuous_gate_is_not_counted_as_passed(tmp_path):
    from engine.obs.status import read_battery_record
    r = read_battery_record(_battery_file(tmp_path, {
        "real": {"ok": True, "exit_code": 0, "state": "PASS"},
        "hollow": {"ok": True, "exit_code": 0, "state": "VACUOUS"},
    }))
    assert r["total"] == 2
    assert r["passed"] == 1, "a gate that examined nothing is not evidence"
    assert r["vacuous"] == 1
    assert r["vacuous_gates"] == ["hollow"]


def test_all_green_stays_about_failures_not_absence(tmp_path):
    # Reding on an absent subject would train people to ignore this
    # surface, which costs more than the honesty buys.
    from engine.obs.status import read_battery_record
    r = read_battery_record(_battery_file(tmp_path, {
        "real": {"ok": True, "exit_code": 0, "state": "PASS"},
        "hollow": {"ok": True, "exit_code": 0, "state": "VACUOUS"},
    }))
    assert r["all_green"] is True
    assert r["failed"] == 0
    # …but the stricter question is answered honestly.
    assert r["evidence_complete"] is False


def test_evidence_complete_is_true_only_when_everything_examined_something(tmp_path):
    from engine.obs.status import read_battery_record
    r = read_battery_record(_battery_file(tmp_path, {
        "a": {"ok": True, "exit_code": 0, "state": "PASS"},
        "b": {"ok": True, "exit_code": 0, "state": "PASS"},
    }))
    assert r["evidence_complete"] is True


def test_a_failing_gate_still_reds_all_green(tmp_path):
    from engine.obs.status import read_battery_record
    r = read_battery_record(_battery_file(tmp_path, {
        "a": {"ok": True, "exit_code": 0, "state": "PASS"},
        "b": {"ok": False, "exit_code": 1, "state": "FAIL"},
    }))
    assert r["all_green"] is False
    assert r["failed"] == 1


def test_a_record_without_state_falls_back_to_ok(tmp_path):
    # Older records predate the third state; they must still read.
    from engine.obs.status import read_battery_record
    r = read_battery_record(_battery_file(tmp_path, {
        "a": {"ok": True, "exit_code": 0},
        "b": {"ok": False, "exit_code": 1},
    }))
    assert r["passed"] == 1 and r["failed"] == 1
    assert r["vacuous"] == 0 and r["all_green"] is False
