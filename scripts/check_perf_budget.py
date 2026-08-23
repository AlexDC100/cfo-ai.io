#!/usr/bin/env python3
"""PERFORMANCE BUDGET gate (C4) — compare a fresh bench run to baseline.

Runs the pytest-benchmark micro-suite (tests/engine/bench/) and compares
every benchmark's MEDIAN against the committed baseline
(tests/engine/bench/baseline.json), failing when any median regresses
beyond the tolerance (+20% by default):

    fresh_median  <=  baseline_median * (1 + tolerance)

Medians (not means) are compared — a single OS scheduling hiccup must
not fail the gate. Exits non-zero NAMING the offending benchmark.

The baseline is MACHINE-TIED (see its _meta.caveat): compare only
against a baseline recorded on the same class of machine, and re-record
with --write-baseline after intentional performance-relevant changes or
when moving the gate to a new runner. The nightly deep-trend run (CI)
is the durable cross-machine home for these numbers.

Usage:
  .venv/bin/python scripts/check_perf_budget.py                  # run + compare
  .venv/bin/python scripts/check_perf_budget.py --tolerance 0.3  # looser gate
  .venv/bin/python scripts/check_perf_budget.py --from-json out.json
                                # compare an existing pytest-benchmark JSON
  .venv/bin/python scripts/check_perf_budget.py --write-baseline # re-record

Exit codes: 0 within budget (or baseline written), 1 budget exceeded /
benchmark set drifted / baseline missing, 2 internal error.
"""
from __future__ import annotations

import argparse
import datetime
import json
import platform
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO = _find_repo_root()
BENCH_DIR = REPO / "tests" / "engine" / "bench"
BASELINE_PATH = BENCH_DIR / "baseline.json"
BASELINE_SCHEMA = "perf_baseline_v1"
DEFAULT_TOLERANCE = 0.20  # +20%

_MACHINE_CAVEAT = (
    "MACHINE-TIED numbers: recorded on the machine described in _meta."
    "machine, single-process, no warm caches beyond a 1-round warmup. "
    "Compare only on the same machine class; re-record with "
    "scripts/check_perf_budget.py --write-baseline when the hardware, "
    "Python build, or an intentional performance-relevant change moves "
    "the floor. The nightly deep-trend CI run is the durable "
    "cross-machine record; this file is the local/PR tripwire."
)


def _run_bench_suite() -> Dict[str, Any]:
    """Run the bench suite fresh, returning the pytest-benchmark JSON."""
    with tempfile.TemporaryDirectory(prefix="perfbudget_") as tmp:
        out_path = Path(tmp) / "bench.json"
        cmd = [
            sys.executable, "-m", "pytest", str(BENCH_DIR),
            "-q", "--benchmark-json=%s" % out_path,
        ]
        proc = subprocess.run(cmd, cwd=str(REPO))
        if proc.returncode != 0:
            raise RuntimeError(
                "bench suite failed (pytest exit %d) — fix the tests before "
                "comparing budgets" % proc.returncode
            )
        if not out_path.is_file():
            raise RuntimeError(
                "pytest produced no --benchmark-json output (is "
                "pytest-benchmark installed? pip install -e '.[dev]')"
            )
        return json.loads(out_path.read_text(encoding="utf-8"))


def _stats_by_name(bench_json: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for bench in bench_json.get("benchmarks") or []:
        name = str(bench.get("name") or "")
        stats = bench.get("stats") or {}
        if not name or "median" not in stats:
            continue
        out[name] = {
            "median_s": float(stats["median"]),
            "mean_s": float(stats.get("mean") or 0.0),
            "stddev_s": float(stats.get("stddev") or 0.0),
            "rounds": int(stats.get("rounds") or 0),
        }
    return out


def _write_baseline(fresh: Dict[str, Dict[str, Any]],
                    machine_info: Optional[Dict[str, Any]]) -> None:
    payload = {
        "_meta": {
            "schema": BASELINE_SCHEMA,
            "caveat": _MACHINE_CAVEAT,
            "recorded_at": datetime.datetime.now(datetime.timezone.utc)
            .replace(microsecond=0).isoformat(),
            "machine": machine_info or {
                "node": platform.node(),
                "system": platform.system(),
                "release": platform.release(),
                "machine": platform.machine(),
                "python": platform.python_version(),
            },
            "tolerance_default": DEFAULT_TOLERANCE,
        },
        "benchmarks": {name: fresh[name] for name in sorted(fresh)},
    }
    BASELINE_PATH.write_text(
        json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )
    print("baseline written: %s (%d benchmarks)" % (BASELINE_PATH, len(fresh)))


def _compare(fresh: Dict[str, Dict[str, Any]], tolerance: float) -> int:
    if not BASELINE_PATH.is_file():
        print("FAIL: no baseline at %s — record one with --write-baseline"
              % BASELINE_PATH)
        return 1
    baseline_doc = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    if baseline_doc.get("_meta", {}).get("schema") != BASELINE_SCHEMA:
        print("FAIL: baseline schema is not %r — re-record with "
              "--write-baseline" % BASELINE_SCHEMA)
        return 1
    baseline = baseline_doc.get("benchmarks") or {}

    failures = []
    for name in sorted(baseline):
        if name not in fresh:
            failures.append(
                "MISSING  %s — benchmark in baseline but absent from the "
                "fresh run (deleted/renamed? re-record the baseline "
                "deliberately)" % name
            )
            continue
        base_median = float(baseline[name]["median_s"])
        fresh_median = float(fresh[name]["median_s"])
        budget = base_median * (1.0 + tolerance)
        verdict = "ok" if fresh_median <= budget else "OVER BUDGET"
        print("%-55s baseline %8.2fms  fresh %8.2fms  budget %8.2fms  %s"
              % (name, base_median * 1e3, fresh_median * 1e3,
                 budget * 1e3, verdict))
        if fresh_median > budget:
            failures.append(
                "OVER BUDGET  %s: fresh median %.2fms > %.2fms "
                "(baseline %.2fms +%d%%)"
                % (name, fresh_median * 1e3, budget * 1e3,
                   base_median * 1e3, round(tolerance * 100))
            )
    for name in sorted(set(fresh) - set(baseline)):
        failures.append(
            "UNBASELINED  %s — new benchmark with no committed baseline "
            "entry; record it with --write-baseline" % name
        )

    if failures:
        print("\nPERF BUDGET: FAIL")
        for f in failures:
            print("  ✗ %s" % f)
        return 1
    print("\nPERF BUDGET: PASS — %d benchmark(s) within +%d%% of baseline"
          % (len(baseline), round(tolerance * 100)))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE,
                        help="allowed median regression fraction "
                             "(default %.2f == +%d%%)"
                             % (DEFAULT_TOLERANCE, round(DEFAULT_TOLERANCE * 100)))
    parser.add_argument("--from-json", default=None,
                        help="compare an existing pytest-benchmark JSON "
                             "instead of running the suite")
    parser.add_argument("--write-baseline", action="store_true",
                        help="record the fresh run as the new committed "
                             "baseline instead of comparing")
    args = parser.parse_args(argv)

    try:
        if args.from_json:
            bench_json = json.loads(Path(args.from_json).read_text(encoding="utf-8"))
        else:
            bench_json = _run_bench_suite()
        fresh = _stats_by_name(bench_json)
        if not fresh:
            print("FAIL: the run produced no benchmark stats")
            return 1
        if args.write_baseline:
            _write_baseline(fresh, bench_json.get("machine_info"))
            return 0
        return _compare(fresh, args.tolerance)
    except RuntimeError as exc:
        print("FAIL: %s" % exc)
        return 1
    except Exception as exc:  # noqa: BLE001 — internal error is exit 2
        import traceback
        traceback.print_exc()
        print("INTERNAL ERROR: %s: %s" % (type(exc).__name__, exc))
        return 2


if __name__ == "__main__":
    sys.exit(main())
