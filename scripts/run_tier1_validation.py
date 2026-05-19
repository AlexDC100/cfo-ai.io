"""run_tier1_validation — orchestrates compare_to_fixture across Tier-1 fixtures.

Two run modes:

  --period-id <uuid>           Use an already-analyzed period (CI fast path)
  --upload <path-to-pdf>       Upload, run pipeline, then validate (full E2E)

CLI examples:

  # Single fixture, existing period
  python scripts/run_tier1_validation.py \\
    --fixture ro_eei_dec_2025 \\
    --period-id 2ca84010-e46f-4796-ad09-8b8d7460d03d

  # All Tier-1 fixtures (--fixture all)
  python scripts/run_tier1_validation.py --fixture all --strict

Exit codes:
  0  every fixture passed
  1  at least one fixture failed (--strict mode required to enforce)
  2  configuration / invocation error

Writes ./out/tier1_report.json with the full per-fixture report.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from scripts.compare_to_fixture import compare, FIXTURE_ROOT  # noqa: E402


# The Tier-1 launch set. Period IDs come from CI env vars (CI_<COA>_PERIOD_ID).
# Stubs for non-Romania fixtures are disabled until each fixture's expected_*.json
# files land — see TODO_FIXTURE_COMPLETION.md.
TIER1_FIXTURES = [
    {
        "fixture": "ro_eei_dec_2025",
        "country": "RO",
        "coa": "omfp_1802",
        "enabled": True,
        "period_id_env": "CI_RO_EEI_PERIOD_ID",
    },
    {
        "fixture": "fr_synthetic_pcg",
        "country": "FR",
        "coa": "pcg_2014",
        "enabled": False,
        "period_id_env": "CI_FR_PCG_PERIOD_ID",
    },
    {
        "fixture": "de_skr03_synthetic",
        "country": "DE",
        "coa": "skr_03",
        "enabled": False,
        "period_id_env": "CI_DE_SKR03_PERIOD_ID",
    },
    {
        "fixture": "de_skr04_synthetic",
        "country": "DE",
        "coa": "skr_04",
        "enabled": False,
        "period_id_env": "CI_DE_SKR04_PERIOD_ID",
    },
    {
        "fixture": "es_pgc_synthetic",
        "country": "ES",
        "coa": "pgc_2007",
        "enabled": False,
        "period_id_env": "CI_ES_PGC_PERIOD_ID",
    },
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Tier-1 launch validation runner.")
    parser.add_argument("--fixture", required=True,
                        help="Fixture name (ro_eei_dec_2025 / fr_synthetic_pcg / etc) or 'all'")
    parser.add_argument("--period-id", default=None,
                        help="Period UUID to validate against. Only for single-fixture mode.")
    parser.add_argument("--strict", action="store_true",
                        help="Exit non-zero on any fixture failure.")
    parser.add_argument("--out", default=str(REPO_ROOT / "out" / "tier1_report.json"))
    args = parser.parse_args()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    targets = _resolve_targets(args.fixture, args.period_id)
    if not targets:
        print(json.dumps({"error": "no targets resolved", "fixture": args.fixture}, indent=2), file=sys.stderr)
        return 2

    summary: Dict[str, Any] = {"fixtures": {}}
    total_failed = 0

    for fx, period_id in targets:
        print(f"\n=== {fx['country']} / {fx['coa']} — fixture={fx['fixture']} period={period_id} ===")
        try:
            report = compare(fx["fixture"], period_id)
        except Exception as e:  # noqa: BLE001
            print(f"  RUNTIME ERROR: {e}", file=sys.stderr)
            summary["fixtures"][fx["fixture"]] = {"error": str(e), "passed": False}
            total_failed += 1
            continue

        passed = report["total_issues"] == 0
        summary["fixtures"][fx["fixture"]] = {
            "country": fx["country"],
            "coa": fx["coa"],
            "period_id": period_id,
            "passed": passed,
            "total_issues": report["total_issues"],
            "checks": [
                {"name": c["name"], "passed": c["passed"]}
                for c in report["checks"]
            ],
        }
        if not passed:
            total_failed += 1
        # Print human-readable summary
        for c in report["checks"]:
            mark = "✓" if c["passed"] else "✗"
            print(f"  {mark} {c['name']}")
            if not c["passed"]:
                issues = c.get("issues") or c.get("misses") or c.get("false_positives") \
                         or c.get("must_contain_misses") or c.get("missing_buckets")
                if issues:
                    snippet = json.dumps(issues, default=str)[:200]
                    print(f"      {snippet}")

    summary["total_fixtures"] = len(targets)
    summary["passing_fixtures"] = len(targets) - total_failed
    summary["failing_fixtures"] = total_failed
    summary["launch_gate_status"] = "PASS" if total_failed == 0 else "FAIL"

    out_path.write_text(json.dumps(summary, indent=2, default=str))
    print(f"\nWrote {out_path}")
    print(f"Tier-1 launch gate: {summary['launch_gate_status']} "
          f"({summary['passing_fixtures']}/{summary['total_fixtures']} fixtures green)")

    return 0 if (total_failed == 0 or not args.strict) else 1


def _resolve_targets(name: str, period_id: Optional[str]) -> List[Tuple[Dict[str, Any], str]]:
    """Return [(fixture_meta, period_id), ...] for the run."""
    if name == "all":
        out = []
        for fx in TIER1_FIXTURES:
            if not fx["enabled"]:
                print(f"  (skipping disabled fixture {fx['fixture']})", file=sys.stderr)
                continue
            pid = os.environ.get(fx["period_id_env"])
            if not pid:
                print(f"  (skipping {fx['fixture']} — env var {fx['period_id_env']} not set)", file=sys.stderr)
                continue
            out.append((fx, pid))
        return out

    fx = next((f for f in TIER1_FIXTURES if f["fixture"] == name), None)
    if not fx:
        print(f"unknown fixture: {name}", file=sys.stderr)
        return []
    pid = period_id or os.environ.get(fx["period_id_env"])
    if not pid:
        print(f"missing --period-id (and {fx['period_id_env']} unset)", file=sys.stderr)
        return []
    return [(fx, pid)]


if __name__ == "__main__":
    sys.exit(main())
