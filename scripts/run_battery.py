#!/usr/bin/env python3
"""The full engine battery, one command — and the writer of the battery
record the ops surface reads.

Runs every gate in the canonical order, prints one legible
``PASS <gate>`` / ``FAIL <gate>`` line per gate (the same text shape
``engine.obs.status`` accepts), and drops the JSON record at
``data/obs/battery_last.json`` (``ENGINE_OBS_DIR`` moves the directory,
``ENGINE_BATTERY_LOG`` points at an explicit file) so ``/ops`` and
``scripts/engine_ops.py status`` show per-gate results instead of
"not recorded". This closes the documented convention in
``src/engine/obs/status.py`` — before this wrapper existed, nothing in
the repo wrote the record.

Usage:
  python scripts/run_battery.py                # full battery (host)
  python scripts/run_battery.py --engine-only  # skip the frontend gates
                                               # (tsc + npm build)
  python scripts/run_battery.py --list         # print the gate list

Exit codes: 0 = every gate green; 1 = at least one FAIL (the record is
written either way — an honest red record beats a stale green one).

NOT in the default battery (deliberately): the mutation kernel
(scripts/run_mutation_kernel.py — ~16 min full run; nightly CI owns it,
the PR profile needs a diff base) and the DST deep profile
(DST_PROFILE=deep — nightly). The per-PR DST profile IS included.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parents[1]

# The two deselects mirror .github/workflows/tier1-validation.yml — the
# pre-existing SHARADAR market-cap scaling defect in the public-companies
# adapter (unrelated to the BS engine); re-enable when that is fixed.
PYTEST_DESELECTS = [
    "--deselect",
    "tests/engine/public/test_adapter.py::test_get_daily_metrics_parses_aapl",
    "--deselect",
    "tests/engine/public/test_adapter.py::"
    "test_normalizer_emits_envelope_shape_from_aapl_fixture",
]

PY = sys.executable


def _gates(engine_only: bool) -> List[Tuple[str, List[str]]]:
    gates: List[Tuple[str, List[str]]] = [
        ("pytest", [PY, "-m", "pytest", "tests/engine", "-q"] + PYTEST_DESELECTS),
        ("corpus-replay", [PY, "scripts/corpus_replay.py"]),
        # W1-W6 — PERIOD-ASSIGNMENT INTEGRITY. `period_end` is the period's
        # identity, and the 2026-08-30 audit found it being set from UI
        # state (the drop target's date written into the human-confirmation
        # channel), filing a 2025 trial balance under 2017-12. These gates
        # pin the law: the period comes from the DOCUMENT, absence forces an
        # explicit choice, wrong rows are surfaced and never rewritten. Named
        # separately from `pytest` so the battery record shows it by name —
        # this class of defect is silent, so its gate must not be.
        # Contract + plant log: design_review/period/GATES.md
        ("period-integrity",
         [PY, "-m", "pytest", "tests/engine/test_period_integrity_gates.py", "-q"]),
        ("determinism", [PY, "scripts/verify_determinism.py"]),
        ("bs-drift", [PY, "scripts/measure_bs_drift.py"]),
        ("error-budget", [PY, "scripts/measure_error_budget.py"]),
        ("import-boundary", [PY, "scripts/check_import_boundary.py"]),
        ("pack-lint", [PY, "scripts/pack_lint.py", "--root", "packs"]),
        ("shadow-report", [PY, "scripts/shadow_report.py", "--all"]),
        ("pack-drift-ro", [PY, "scripts/port_ro_pack.py", "--check"]),
        ("pack-drift-hu", [PY, "scripts/port_hu_pack.py", "--check"]),
        ("corpus-policy", [PY, "scripts/check_corpus_policy.py"]),
        ("scrub-unreachable", [PY, "scripts/check_scrub_tooling_unreachable.py"]),
        ("supply-chain-selftest", [PY, "scripts/check_supply_chain.py", "--self-test"]),
        ("supply-chain", [PY, "scripts/check_supply_chain.py"]),
        ("engine-book", [PY, "scripts/generate_engine_book.py", "--check"]),
        ("dst-explore", [PY, "scripts/dst_explore.py"]),
        # PS6 — every sitemapped public company URL must serve 200 with
        # real content; thin/unpublishable/taken-down CUIs must be absent.
        # Passes with a NOTICE on a host that has ingested no public data.
        ("public-sitemaps", [PY, "scripts/check_public_sitemaps.py"]),
    # End-to-end against the REAL PublicRoStore. The unit suites drive a
    # FakeStore that "mirrors" it; the mirror drifted and hid two total
    # outages (every hub page 500, every funnel event dropped) behind
    # 244 green tests. This gate fakes nothing.
    ("public-e2e", [PY, "scripts/check_public_e2e.py"]),
    # PM1-PM7 — GLOBAL PUBLIC MARKETS. Real registry, real sqlite store, real
    # router, real SEC bytes; --no-replay because PM7's corpus check is the
    # `corpus-replay` gate above and must not run twice per battery.
    ("public-market-gates", [PY, "scripts/check_public_market_gates.py", "--no-replay"]),
    ]
    if not engine_only:
        gates += [
            # Global-positioning gates (2026-08-29): Hungary never in a headline
    # (G2), certification verbs never beside global claims (G3). G1 is
    # the existing pack-drift hash freeze; G4/G5 live in vitest.
    # Unit-declaration gate — makes the 2026-08-30 "1553.0%" double-scale
    # collision unwritable at the producer (see check_metric_units.py).
    ("metric-units", [PY, "scripts/check_metric_units.py"]),
    ("global-positioning", ["node", "scripts/check_global_positioning.mjs"]),
    ("tsc", ["npx", "tsc", "--noEmit"]),
            ("npm-build", ["npm", "run", "build"]),
        ]
    return gates


def _record_path() -> Path:
    env = os.environ.get("ENGINE_BATTERY_LOG")
    if env:
        return Path(env)
    obs = os.environ.get("ENGINE_OBS_DIR")
    base = Path(obs) if obs else REPO / "data" / "obs"
    return base / "battery_last.json"


def _write_record(gates: Dict[str, Dict[str, object]], notices: List[str]) -> Optional[Path]:
    target = _record_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "ran_at": datetime.now(timezone.utc).isoformat(),
            "gates": gates,
            "notices": notices,
        }
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, target)
        return target
    except OSError as exc:  # record failure must not mask gate results
        print("NOTICE battery record not written (%s)" % exc)
        return None


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--engine-only", action="store_true",
                    help="skip the frontend gates (tsc, npm build)")
    ap.add_argument("--list", action="store_true", help="print the gate list")
    args = ap.parse_args(argv)

    gates = _gates(args.engine_only)
    if args.list:
        for name, cmd in gates:
            print("%-22s %s" % (name, " ".join(cmd)))
        return 0

    results: Dict[str, Dict[str, object]] = {}
    notices: List[str] = []
    failed: List[str] = []
    for name, cmd in gates:
        t0 = time.monotonic()
        try:
            proc = subprocess.run(
                cmd, cwd=REPO, capture_output=True, text=True, timeout=3600
            )
            code: Optional[int] = proc.returncode
            tail = (proc.stdout + proc.stderr).strip().splitlines()[-12:]
        except FileNotFoundError as exc:
            code, tail = None, ["command not found: %s" % exc]
        except subprocess.TimeoutExpired:
            code, tail = None, ["gate timed out after 3600s"]
        elapsed = round(time.monotonic() - t0, 1)
        ok = code == 0
        results[name] = {"ok": ok, "exit_code": code, "seconds": elapsed}
        if ok:
            print("PASS %s (%.1fs)" % (name, elapsed))
        else:
            failed.append(name)
            print("FAIL %s (exit %s, %.1fs)" % (name, code, elapsed))
            for line in tail:
                print("     | %s" % line)

    if args.engine_only:
        notices.append("NOTICE frontend gates (tsc, npm-build) skipped: --engine-only")

    written = _write_record(results, notices)
    for n in notices:
        print(n)
    print(
        "BATTERY: %s — %d/%d gates green%s"
        % (
            "FAIL" if failed else "PASS",
            len(gates) - len(failed),
            len(gates),
            "  (record: %s)" % written if written else "",
        )
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
