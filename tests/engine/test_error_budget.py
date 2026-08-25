"""Part E error budget — the silent-error-rate gate + its ops wiring.

Covers, in order:
  · scripts/measure_error_budget.py (NEW): Wilson interval correctness
    vs hand-computed cases, the sufficiency boundary, E5 reproducibility
    (two in-process runs produce the identical report dict), a planted
    SILENT corruption (monkeypatched served value ⇒ exit 1 naming the
    field), a planted FLAGGED corruption (needs_review present ⇒ counted
    flagged, exit 0), and lane separation (an llm-lane mismatch never
    pollutes the deterministic lane).
  · src/engine/obs/metrics.py: the three new KPI rates
    (consensus_agreement_rate / interpreter_call_rate /
    template_hit_rate) — honest None without coverage, journal-derived
    when the envelope carries the markers.
  · src/engine/obs/status.py: ops_snapshot's "error_budget" section —
    honest "not measured" when the record is absent.
  · scripts/run_battery.py: the ("error-budget", …) gate tuple.

RED-FIRST NOTE: every test below that touches an EXISTING file
(metrics.py / status.py / run_battery.py) was written and verified
failing before the corresponding edit landed.

No AI clients anywhere here — the error-budget script runs the corpus
machinery, which structurally nulls `anthropic` per case.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

CORPUS = REPO / "corpus"
SCRIPT = REPO / "scripts" / "measure_error_budget.py"
BATTERY = REPO / "scripts" / "run_battery.py"


def load_module_from_path(name: str, path: Path):
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


meb = load_module_from_path("measure_error_budget", SCRIPT)
run_battery = load_module_from_path("run_battery", BATTERY)

from engine.obs import metrics as _metrics  # noqa: E402
from engine.obs import status as _status  # noqa: E402
from engine.obs.metrics import collect_metrics  # noqa: E402


# ── Wilson interval: hand-computed cases ───────────────────────────────


def test_wilson_zero_mismatches_in_100():
    low, high = meb.wilson(0, 100)
    assert low == 0.0
    assert high == pytest.approx(0.03699349820698565, abs=1e-9)


def test_wilson_one_mismatch_in_50():
    low, high = meb.wilson(1, 50)
    assert low == pytest.approx(0.003539259271646236, abs=1e-9)
    assert high == pytest.approx(0.1049544358963781, abs=1e-9)


def test_wilson_small_n_never_claims_certainty():
    # 0 mismatches on 10 fields still leaves a wide upper bound.
    low, high = meb.wilson(0, 10)
    assert low == 0.0
    assert high > 0.25


def test_wilson_empty_n_is_honest_none():
    assert meb.wilson(0, 0) == (None, None)


def test_sufficiency_boundary_for_the_extraction_budget():
    # The smallest N whose k=0 Wilson upper bound certifies <0.01%.
    n_min = meb.sufficient_n(meb.EXTRACTION_BUDGET)
    assert n_min == 38411
    assert meb.wilson(0, n_min)[1] <= meb.EXTRACTION_BUDGET
    assert meb.wilson(0, n_min - 1)[1] > meb.EXTRACTION_BUDGET


def test_sufficiency_boundary_for_the_classification_budget():
    n_min = meb.sufficient_n(meb.CLASSIFICATION_BUDGET)
    assert n_min == 7680
    assert meb.wilson(0, n_min)[1] <= meb.CLASSIFICATION_BUDGET


# ── E5: reproducibility ────────────────────────────────────────────────


def test_two_consecutive_runs_produce_identical_reports():
    kwargs = dict(
        corpus_root=CORPUS,
        case_ids=["csv", "exact_zero"],
        include_anchors=False,
    )
    first = meb.measure(**kwargs)
    second = meb.measure(**kwargs)
    assert first == second
    # And the report is JSON-clean (the atomic record write depends on it).
    assert json.loads(json.dumps(first)) == first


def test_clean_corpus_subset_has_zero_mismatches_and_honest_insufficiency():
    report = meb.measure(
        corpus_root=CORPUS, case_ids=["csv"], include_anchors=False
    )
    det = report["per_lane"]["deterministic"]
    assert det["n"] > 0
    assert det["silent_mismatches"] == 0
    assert det["flagged_mismatches"] == 0
    assert det["rate"] == 0.0
    # One case can never reach the ~38k clean fields the budget needs.
    assert det["sufficient"] is False
    assert det["ci_low"] == 0.0 and det["ci_high"] > 0.0
    # A lane with no measurement source stays honest.
    mm = report["per_lane"]["mechanical_mapped"]
    assert mm["n"] == 0 and mm["rate"] is None and mm["sufficient"] is False
    assert meb.gate_exit(report) == 0


# ── planted corruptions (monkeypatched served value) ───────────────────


def _corrupting_serve(real_serve, *, flag: bool):
    """Wrap the module's serve seam: nudge one numeric field on the way
    out (a wrongly-served value the goldens will catch) and optionally
    stamp the review flag."""

    def _serve(envelope):
        served = real_serve(envelope)
        if isinstance(served, dict):
            totals = served.get("totals")
            if isinstance(totals, dict) and "assets" in totals:
                totals["assets"] = float(totals["assets"]) + 1.0
            if flag:
                served["needs_review"] = True
        return served

    return _serve


def test_planted_silent_corruption_exits_1_and_names_the_field(
    monkeypatch, capsys
):
    monkeypatch.setattr(meb, "_serve", _corrupting_serve(meb._serve, flag=False))
    code = meb.main(["--case", "csv", "--skip-anchors", "--no-record"])
    out = capsys.readouterr().out
    assert code == 1
    assert "$.totals.assets" in out
    assert "SILENT" in out


def test_planted_flagged_corruption_is_counted_flagged_not_silent(monkeypatch):
    monkeypatch.setattr(meb, "_serve", _corrupting_serve(meb._serve, flag=True))
    report = meb.measure(
        corpus_root=CORPUS, case_ids=["csv"], include_anchors=False
    )
    det = report["per_lane"]["deterministic"]
    assert det["silent_mismatches"] == 0
    assert det["flagged_mismatches"] >= 1
    # A flagged wrong field is the system WORKING — the gate stays green.
    assert meb.gate_exit(report) == 0


def test_lane_separation_llm_mismatch_never_pollutes_deterministic(monkeypatch):
    real_serve = meb._serve
    calls: List[str] = []

    def _serve(envelope):
        served = real_serve(envelope)
        calls.append("case")
        # Cases run in sorted order: csv (deterministic) first, then
        # llm_fallback_scanned_pdf (llm; its golden serves
        # needs_review=False, so the corruption lands SILENT). Corrupt
        # only the second — the llm case.
        if len(calls) == 2 and isinstance(served, dict):
            totals = served.get("totals")
            if isinstance(totals, dict) and "assets" in totals:
                totals["assets"] = float(totals["assets"]) + 1.0
        return served

    monkeypatch.setattr(meb, "_serve", _serve)
    report = meb.measure(
        corpus_root=CORPUS,
        case_ids=["csv", "llm_fallback_scanned_pdf"],
        include_anchors=False,
    )
    assert report["cases"]["csv"]["lane"] == "deterministic"
    assert report["cases"]["llm_fallback_scanned_pdf"]["lane"] == "llm"
    det = report["per_lane"]["deterministic"]
    llm = report["per_lane"]["llm"]
    assert det["silent_mismatches"] == 0
    assert llm["silent_mismatches"] >= 1
    assert meb.gate_exit(report) == 1


# ── anchors degrade honestly when the (gitignored) labels are absent ───


def test_missing_anchor_labels_are_a_notice_never_a_crash(tmp_path):
    report = meb.measure(
        corpus_root=CORPUS,
        case_ids=["csv"],
        include_anchors=True,
        labels_path=tmp_path / "no_such_labels.json",
    )
    assert report["anchors"]["available"] is False
    assert any("anchor labels" in n for n in report["notices"])
    assert meb.gate_exit(report) == 0


# ── record write (battery-record pattern: atomic, honest) ──────────────


def test_record_written_atomically(tmp_path, monkeypatch):
    monkeypatch.setenv("ENGINE_OBS_DIR", str(tmp_path))
    report = meb.measure(
        corpus_root=CORPUS, case_ids=["csv"], include_anchors=False
    )
    target = meb.write_record(report)
    assert target == tmp_path / "error_budget_last.json"
    on_disk = json.loads(target.read_text(encoding="utf-8"))
    assert on_disk["per_lane"]["deterministic"]["n"] > 0
    assert on_disk["schema"] == "error_budget_v1"


# ── run_battery: the gate tuple (RED before the edit) ──────────────────


def test_battery_gate_list_includes_error_budget():
    gates = dict(run_battery._gates(True))
    assert "error-budget" in gates
    assert gates["error-budget"][-1].endswith("scripts/measure_error_budget.py")


# ── metrics: the three new KPI rates (RED before the edit) ─────────────


def test_new_kpi_rates_present_and_none_without_coverage(monkeypatch):
    monkeypatch.setattr(_metrics, "default_journal_root", lambda: None)
    rates = collect_metrics(None)["rates"]
    for key in (
        "consensus_agreement_rate",
        "interpreter_call_rate",
        "template_hit_rate",
    ):
        assert key in rates
        assert rates[key] is None


class _StubStore:
    def __init__(self, objects: Dict[str, Dict[str, Any]]) -> None:
        self._objects = objects

    def read_object(self, digest: str) -> bytes:
        return json.dumps(self._objects[digest]).encode("utf-8")


class _StubJournal:
    """The minimal journal surface collect_metrics walks."""

    def __init__(self, envelope: Dict[str, Any]) -> None:
        self.root = "<stub>"
        self.store = _StubStore({"d1": envelope})

    def list_chains(self) -> List[str]:
        return ["chain-1"]

    def chain_events(self, chain_key: str) -> List[Dict[str, Any]]:
        return [
            {"type": "RUN_STARTED", "payload": {}},
            {"type": "SNAPSHOT_PERSISTED", "payload": {"content_hash": "d1"}},
        ]

    def verify_chain(self, chain_key: str) -> List[str]:
        return []

    def dlq_depth(self) -> int:
        return 0


def _envelope_with_markers() -> Dict[str, Any]:
    return {
        "canonical_bs": {
            "status": "BALANCED",
            "extraction": {"method": "deterministic"},
            "rows": [],
            "unmapped": [],
        },
        # The additive markers the consensus / interpretation lanes stamp.
        "consensus": {"agreement": True},
        "interpretation": {"template_hit": True},
    }


def test_new_kpi_rates_derive_from_envelope_markers(monkeypatch):
    stub = _StubJournal(_envelope_with_markers())
    monkeypatch.setattr(_metrics, "_open_journal", lambda root: stub)
    out = collect_metrics("ignored")
    rates = out["rates"]
    assert rates["consensus_agreement_rate"] == 1.0
    assert rates["interpreter_call_rate"] == 1.0
    assert rates["template_hit_rate"] == 1.0
    cov = out["coverage"]
    assert cov["consensus_compared"] == 1
    assert cov["consensus_agreements"] == 1
    assert cov["interpreter_calls"] == 1
    assert cov["template_lookups"] == 1
    assert cov["template_hits"] == 1
    counters = out["counters"]
    assert counters["consensus_compare"] == {"agree": 1}
    assert counters["template_lookup"] == {"hit": 1}
    assert counters["interpreter_calls"] == {"_": 1}


def test_disagreement_and_template_miss_count_honestly(monkeypatch):
    env = _envelope_with_markers()
    env["consensus"] = {"agreement": False}
    env["interpretation"] = {"template_hit": False}
    stub = _StubJournal(env)
    monkeypatch.setattr(_metrics, "_open_journal", lambda root: stub)
    rates = collect_metrics("ignored")["rates"]
    assert rates["consensus_agreement_rate"] == 0.0
    assert rates["interpreter_call_rate"] == 1.0
    assert rates["template_hit_rate"] == 0.0


def test_envelope_without_markers_leaves_new_rates_none(monkeypatch):
    env = _envelope_with_markers()
    del env["consensus"]
    del env["interpretation"]
    stub = _StubJournal(env)
    monkeypatch.setattr(_metrics, "_open_journal", lambda root: stub)
    rates = collect_metrics("ignored")["rates"]
    assert rates["consensus_agreement_rate"] is None
    assert rates["template_hit_rate"] is None
    # interpreter_call_rate has a real denominator (docs=1) — honest 0.0.
    assert rates["interpreter_call_rate"] == 0.0


# ── ops_snapshot: the error_budget section (RED before the edit) ───────


def test_ops_snapshot_error_budget_not_measured(tmp_path, monkeypatch):
    monkeypatch.setenv("ENGINE_OBS_DIR", str(tmp_path))
    monkeypatch.setattr(_metrics, "default_journal_root", lambda: None)
    snap = _status.ops_snapshot(None)
    eb = snap["error_budget"]
    assert eb["measured"] is False
    assert "path" in eb


def test_ops_snapshot_error_budget_reads_the_record(tmp_path, monkeypatch):
    monkeypatch.setenv("ENGINE_OBS_DIR", str(tmp_path))
    monkeypatch.setattr(_metrics, "default_journal_root", lambda: None)
    record = {
        "schema": "error_budget_v1",
        "budgets": {"extraction": 0.0001, "classification": 0.0005},
        "per_lane": {
            "deterministic": {
                "rate": 0.0,
                "n": 2000,
                "ci_low": 0.0,
                "ci_high": 0.0019,
                "sufficient": False,
                "silent_mismatches": 0,
                "flagged_mismatches": 0,
            }
        },
    }
    (tmp_path / "error_budget_last.json").write_text(
        json.dumps(record), encoding="utf-8"
    )
    snap = _status.ops_snapshot(None)
    eb = snap["error_budget"]
    assert eb["measured"] is True
    assert eb["per_lane"]["deterministic"]["n"] == 2000
    assert eb["budgets"]["extraction"] == 0.0001


def test_ops_snapshot_error_budget_unreadable_record_is_honest(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("ENGINE_OBS_DIR", str(tmp_path))
    monkeypatch.setattr(_metrics, "default_journal_root", lambda: None)
    (tmp_path / "error_budget_last.json").write_text("{not json", encoding="utf-8")
    snap = _status.ops_snapshot(None)
    assert snap["error_budget"]["measured"] is False


# ── engine_ops CLI renders the section (RED before the edit) ───────────


def test_engine_ops_status_renders_error_budget(tmp_path, monkeypatch, capsys):
    engine_ops = load_module_from_path(
        "engine_ops", REPO / "scripts" / "engine_ops.py"
    )
    monkeypatch.setenv("ENGINE_OBS_DIR", str(tmp_path))
    monkeypatch.setattr(_metrics, "default_journal_root", lambda: None)

    # Not measured → the honest line.
    assert engine_ops.main(["status"]) == 0
    out = capsys.readouterr().out
    assert "error budget" in out
    assert "not measured" in out

    # Measured but insufficient → the calm insufficiency copy.
    record = {
        "schema": "error_budget_v1",
        "budgets": {"extraction": 0.0001, "classification": 0.0005},
        "per_lane": {
            "deterministic": {
                "rate": 0.0, "n": 2154, "ci_low": 0.0, "ci_high": 0.0018,
                "sufficient": False, "silent_mismatches": 0,
                "flagged_mismatches": 0,
            },
            "llm": {
                "rate": None, "n": 0, "ci_low": None, "ci_high": None,
                "sufficient": False, "silent_mismatches": 0,
                "flagged_mismatches": 0,
            },
        },
    }
    (tmp_path / "error_budget_last.json").write_text(
        json.dumps(record), encoding="utf-8"
    )
    assert engine_ops.main(["status"]) == 0
    out = capsys.readouterr().out
    assert "deterministic" in out
    assert "N insufficient" in out
    # The three new KPI rates appear on the rates surface.
    for label in ("consensus agreement", "interpreter calls", "template hits"):
        assert label in out
