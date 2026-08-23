"""PERFORMANCE BUDGET micro-suite (C4) — measurement, not optimization.

pytest-benchmark benchmarks over three altitude levels of the engine:

  * Money arithmetic batch — the IR's integer-cents kernel (add / neg /
    compare over 10k values);
  * canonical build per corpus fixture — parse ONCE per session, then
    benchmark the pure `assemble_parsed_tb` composition (shape →
    classify → canonical envelope → canonical_bs v2) on three
    deterministic corpus inputs of different sizes;
  * full corpus-case replay end-to-end — the REAL offline pipeline the
    golden corpus runs (parse → assemble → auto-reconcile →
    stage_persist against the fake admin → serve → FactsGateway) for
    three representative cases: the frozen production golden
    (saga_10_col), the real-export golden (saga_10_col_agras), and the
    fully-mocked HU AI lane (hu_ai_lane — scripted model client, no
    live calls ever).

The committed baseline lives in tests/engine/bench/baseline.json
(machine-tied — see its _meta.caveat). scripts/check_perf_budget.py
re-runs this suite and fails when any benchmark's median regresses
beyond +20% of the baseline median.

The suite skips cleanly when pytest-benchmark (a dev extra) is not
installed, so the runtime image / minimal environments never error on
collection.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

pytest.importorskip(
    "pytest_benchmark",
    reason="pytest-benchmark (dev extra) not installed — perf suite skipped",
)

REPO = Path(__file__).resolve().parents[3]
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.ir import Money  # noqa: E402

CORPUS = REPO / "corpus"

# Reuse the corpus replay runner's REAL composition helpers (the same
# code objects the golden-corpus gate runs) — loaded by path, same
# pattern as tests/engine/test_corpus_replay.py.
sys.path.insert(0, str(REPO / "tests" / "engine")) if str(
    REPO / "tests" / "engine"
) not in sys.path else None
from test_corpus_replay import load_module_from_path  # noqa: E402

corpus_replay = load_module_from_path(
    "corpus_replay", REPO / "scripts" / "corpus_replay.py"
)

_BUILD_CASES = ("saga_10_col", "saga_10_col_agras", "saga_compact_6_col")
_REPLAY_CASES = ("saga_10_col", "saga_10_col_agras", "hu_ai_lane")


# ── Money arithmetic batch ─────────────────────────────────────────────


def test_bench_money_arithmetic_batch(benchmark):
    """10k-value integer-cents batch: fold add, neg, compare — the hot
    kernel every statements accumulation rides on."""
    values = [
        Money.from_minor("RON", (i * 37) % 1_000_000 - 250_000) for i in range(10_000)
    ]
    zero = Money.zero("RON")

    def batch():
        total = zero
        negatives = 0
        for m in values:
            total = total + m
            if m < zero:
                negatives += 1
                total = total - (-m)
        return total.amount_minor, negatives

    result = benchmark(batch)
    # Deterministic workload guard: (i*37) % 1e6 stays == i*37 for
    # i < 10k, so exactly the i < 250_000/37 values fold negative.
    assert result[1] == 6757


# ── Canonical build per corpus fixture ─────────────────────────────────


@pytest.fixture(scope="session")
def parsed_corpus_tb(pack):
    """Parse each bench fixture once per session; assemble is pure on
    the parsed result (verified: repeated assembles are byte-identical),
    so the benchmark times ONLY the build."""
    cache = {}

    def _get(case_id: str):
        if case_id not in cache:
            input_path = sorted((CORPUS / case_id).glob("input.*"))[0]
            cache[case_id] = pack.parse_trial_balance(
                input_path.read_bytes(), input_path.name
            )
        return cache[case_id]

    return _get


@pytest.mark.parametrize("case_id", _BUILD_CASES)
def test_bench_canonical_build(benchmark, pack, parsed_corpus_tb, case_id):
    tb = parsed_corpus_tb(case_id)

    def build():
        _tb, _shaped, assembled = pack.assemble_parsed_tb(
            tb, company_name="Bench", period_label="BENCH"
        )
        return assembled

    assembled = benchmark.pedantic(build, rounds=10, iterations=1, warmup_rounds=1)
    assert "canonical_bs" in assembled["assembled_canonical_v1"]


# ── Full corpus-case replay end-to-end ─────────────────────────────────


def _replay_case(case_id: str):
    """One corpus case through the FULL offline pipeline — the exact
    engine composition run_case exercises (parse → assemble →
    auto-reconcile inside stage_persist → serve → FactsGateway), minus
    the golden byte-compare and repo-hygiene checks (measurement, not
    verification — the corpus gate itself stays the verifier)."""
    case_dir = CORPUS / case_id
    meta = corpus_replay._load_meta(case_dir)
    input_path = corpus_replay._input_path(case_dir)
    content = input_path.read_bytes()
    with corpus_replay.no_live_api_guard():
        if str(meta["expected_parser"]) == "hu_ai_lane":
            extraction, classification, envelope, currency = (
                corpus_replay._run_hu_ai_lane(case_id, meta, input_path, content)
            )
        else:
            extraction, classification, envelope, currency = (
                corpus_replay._run_deterministic(case_id, meta, input_path, content)
            )
        served = corpus_replay._reconcile.served_canonical_bs(envelope)
        facts = corpus_replay._gateway_facts(envelope, currency)
    return served, facts


@pytest.mark.parametrize("case_id", _REPLAY_CASES)
def test_bench_corpus_replay_end_to_end(benchmark, case_id):
    served, facts = benchmark.pedantic(
        lambda: _replay_case(case_id), rounds=5, iterations=1, warmup_rounds=1
    )
    assert isinstance(served, dict) and served.get("status")
    assert isinstance(facts.get("total_assets_cents"), int)
