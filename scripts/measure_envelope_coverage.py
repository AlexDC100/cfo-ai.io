"""F-A3.3-ENVELOPE-COVERAGE — Read-only gate verifying that every
analyzed financial_period carries a valid canonical envelope.

Spec (per `docs/F3.16-3b5-backfill-plan.md` Phase 2 + the F3.16 ADR
discipline that bans threshold widening):

    For each row in `financial_periods` WHERE status = 'analyzed':
      · assembled_canonical_v1 IS NOT NULL                                   (REQUIRED)
      · assembled_canonical_v1->>'schema_version' == 'canonical_v1.0.0'       (REQUIRED)
      · (assembled_canonical_v1->'round_trip_check'->>'passed')::bool == TRUE (REQUIRED)
      · methodology_version IS NOT NULL                                       (REQUIRED)

Any failing assertion is RED. Total RED count > 0 fails the gate.

**Threshold widening is explicitly forbidden** — mirrors F-A3.1 / F-A3.2
discipline locked in the F3.16 closure ADR. The point of this gate is
to keep every analyzed period reading from the canonical envelope path,
which is a prerequisite for 3b.6's F3.15 fallback deletion. Loosening
the gate (e.g. allowing schema_version='canonical_v0.9.0' or
round_trip_check.passed=False) would silently re-introduce the
legacy-fallback dependency.

Run modes
---------
- Container (canonical): `docker exec cfo-ai-backend python3 /app/scripts/measure_envelope_coverage.py`
- Local: same script path, requires the engine packages available
  (the script imports `engine.api._supabase`).

Exits 0 on GREEN, 1 on RED. Stdout is a per-period table + summary.

§14 discipline
--------------
This script READS prod state via the admin Supabase client. It does
NOT write. It does NOT trigger re-extracts. It does NOT modify any
row. Safe to run any time. Mirrors the pattern of
`scripts/probe_backfill_classify.py` (also read-only).
"""
from __future__ import annotations

import sys
from typing import Any, Dict, List, Tuple


# ── Required schema constants ─────────────────────────────────────────
# Hardcoded here, not pulled from the engine, so the gate's pass
# criteria are reviewable as plain text in the diff — no "what does
# CANONICAL_SCHEMA_VERSION import as?" indirection.
EXPECTED_SCHEMA_VERSION = "canonical_v1.0.0"


# ── Per-period verdict ────────────────────────────────────────────────


def _check_period(p: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """Returns (passed, reasons). reasons is empty on pass; populated
    on fail with one human-readable line per failed assertion."""
    reasons: List[str] = []

    canonical = p.get("assembled_canonical_v1")
    if not isinstance(canonical, dict):
        reasons.append("assembled_canonical_v1 missing or not a dict")
        return False, reasons  # Can't check anything else if the blob isn't there.

    schema_version = canonical.get("schema_version")
    if schema_version != EXPECTED_SCHEMA_VERSION:
        reasons.append(
            f"schema_version={schema_version!r} (expected {EXPECTED_SCHEMA_VERSION!r})"
        )

    round_trip = canonical.get("round_trip_check") or {}
    if not isinstance(round_trip, dict):
        reasons.append("round_trip_check absent")
    else:
        passed = round_trip.get("passed")
        if passed is not True:
            reasons.append(f"round_trip_check.passed={passed!r} (expected True)")

    methodology_version = p.get("methodology_version")
    if not methodology_version:
        reasons.append("methodology_version missing")

    return len(reasons) == 0, reasons


# ── Main ──────────────────────────────────────────────────────────────


def main() -> int:
    try:
        from engine.api import _supabase
    except Exception as exc:  # noqa: BLE001
        print(f"FATAL: couldn't import engine.api._supabase ({type(exc).__name__}: {exc})")
        print("       Run this from the cfo-ai-backend container, not the host.")
        return 2

    with _supabase.admin() as ac:
        # Pull all analyzed periods. Limit 2000 is overkill — we have <50
        # prod periods today; the cap is safety for future growth.
        all_periods = ac.select("financial_periods", limit=2000) or []
        analyzed = [p for p in all_periods if p.get("status") == "analyzed"]

        if not analyzed:
            print("F-A3.3-ENVELOPE-COVERAGE: no analyzed periods in DB; gate vacuously GREEN.")
            return 0

        green: List[Dict[str, Any]] = []
        red: List[Tuple[Dict[str, Any], List[str]]] = []

        for p in analyzed:
            ok, reasons = _check_period(p)
            if ok:
                green.append(p)
            else:
                red.append((p, reasons))

        print("F-A3.3-ENVELOPE-COVERAGE — every analyzed period must have a valid canonical envelope")
        print("=" * 100)
        print(f"  Total analyzed periods:  {len(analyzed)}")
        print(f"  GREEN (envelope valid):  {len(green)}")
        print(f"  RED   (envelope absent or invalid): {len(red)}")
        print()

        if red:
            print("Failing periods:")
            print("-" * 100)
            for p, reasons in red:
                pid = (p.get("id") or "?")[:8]
                pe = p.get("period_end") or "?"
                org = (p.get("organization_id") or "?")[:8]
                print(f"  period_id={pid}  end={pe}  org={org}")
                for r in reasons:
                    print(f"      · {r}")
            print()
            print("Overall: RED — F-A3.3 fails. F3.15 fallback CANNOT be deleted until all rows GREEN.")
            print("         Threshold widening is forbidden (see F3.16 ADR). Fix the underlying periods.")
            return 1

        print("Overall: GREEN — every analyzed period carries a valid envelope.")
        print("         F3.15 fallback safe to schedule for deletion (3b.5 phase 3, separate PR).")
        return 0


if __name__ == "__main__":
    sys.exit(main())
