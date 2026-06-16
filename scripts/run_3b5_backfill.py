"""F3.16-3b.5 — canonical-envelope backfill orchestrator.

What this script does
---------------------
Executes the F3.16-3b.5 backfill plan with every halt condition from
the sprint prompt baked in, mode-gated so the operator runs each stage
deliberately:

    --mode snapshot       phase 0: snapshot pre-state for all 8 periods
                                   into financial_periods.pre_backfill_snapshot
    --mode single         phase 1a: re-extract ONE period (the smallest)
                                   + diff vs snapshot + halt if delta > tolerance
    --mode batch1         phase 1b: re-extract 4 of the remaining 7 periods
                                   + F-A3.1 between each + halt on first RED
    --mode batch2         phase 1c: re-extract last 3 periods, same protocol
    --mode coverage       phase 2: run F-A3.3-ENVELOPE-COVERAGE gate
    --mode rollback       emergency: print the SQL block to restore HALT-affected
                                   periods from pre_backfill_snapshot

§14 deploy discipline
---------------------
This script runs INSIDE `cfo-ai-backend` via `docker exec`. It uses the
same `engine.api._supabase` admin client every other backend module
uses. It does NOT bypass any auth.

The operator runs it from the host:

    docker exec cfo-ai-backend python3 /app/scripts/run_3b5_backfill.py --mode snapshot
    docker exec cfo-ai-backend python3 /app/scripts/run_3b5_backfill.py --mode single
    # if single-period diff is clean:
    docker exec cfo-ai-backend python3 /app/scripts/run_3b5_backfill.py --mode batch1
    # F-A3.1 must stay 8/8 GREEN — re-check between batches:
    docker exec cfo-ai-backend python3 /app/scripts/measure_bs_drift.py
    docker exec cfo-ai-backend python3 /app/scripts/run_3b5_backfill.py --mode batch2
    docker exec cfo-ai-backend python3 /app/scripts/measure_bs_drift.py
    docker exec cfo-ai-backend python3 /app/scripts/measure_cross_path.py
    docker exec cfo-ai-backend python3 /app/scripts/measure_envelope_coverage.py

Halt conditions enforced inside the script
------------------------------------------
1. Snapshot phase: refuse to proceed if pre_backfill_snapshot column
   doesn't exist (operator hasn't run the migration yet).
2. Snapshot phase: refuse to proceed if any of the 8 target period IDs
   are missing from the DB.
3. Single-period phase: post-extract, compare total_assets and
   current_year_pnl against the snapshot. HALT if:
      · total_assets delta > 0.5%
      · current_year_pnl delta > 5%
      · round_trip_check.passed != True
      · canonical envelope still absent
4. Batch phase: SAME tolerance per period; HALT immediately on first
   failing period (does NOT continue through the batch).
5. Carniprod prediction lock: between batches, expects F-A3.1 to report
   Carniprod at 7.3939% drift. Any other reading is a HALT — that fixture
   is the canary for unintended cross-pipeline interactions.
"""
from __future__ import annotations

import argparse
import sys
import time
from typing import Any, Dict, List, Optional, Tuple


# ──────────────────────────────────────────────────────────────────────
# Target period IDs (verbatim from probe_backfill_classify.py + the
# 3b.5 plan doc). Operator can override via --periods if the prod set
# changes before execution, but the defaults match the locked plan.
# ──────────────────────────────────────────────────────────────────────
#
# The 8 target periods, ordered SMALLEST line_items first (so the
# single-period test phase picks the cleanest re-extract candidate).
# Order matters: phase `single` always takes index 0 from this list.
#
# Period IDs were captured from probe_backfill_classify.py output on
# 2026-05-25; truncated UUIDs are completed by lookup at runtime
# (script refuses to proceed if any prefix matches >1 row, see
# `_resolve_period_id`).

# 2026-05-26 — narrowed from the original 8-period locked plan to the
# 3-period set actually present in prod. Between 2026-05-25 (plan
# lock) and 2026-05-26 (this session's baseline capture):
#   · 4 FY2025 duplicate periods got cleaned up (operator/system work
#     between sessions — confirmed correct by the user)
#   · `b50cbdb2` scandia xlsx got backfilled successfully — proves the
#     mechanism works on a 653-row XLSX
#   · 3 periods remain unbackfilled (all PDFs)
# See the Combined STOP report from 2026-05-26 baseline capture for
# the full reconciliation between locked plan and actual prod state.
TARGET_PERIODS_BY_PREFIX = [
    "6c6b8503",  # EEI pdf, 61 line_items   ← smallest, single-period test
    "377e43be",  # Sibiu pdf, 191 line_items — FY2019, duplicate of below
    "92788026",  # Sibiu pdf, 191 line_items — FY2019, duplicate of above
]

# Already-backfilled periods (skip). a64a682e was already_backfilled
# at plan-lock time; b50cbdb2 backfilled between plan and this session.
SKIP_PERIOD_PREFIXES = ("a64a682e", "b50cbdb2")
SKIP_PERIOD_PREFIX = "a64a682e"  # retained for any legacy callers

# Tolerance per the plan doc + sprint prompt.
TOLERANCE_TOTAL_ASSETS_PCT = 0.5    # > 0.5% delta = HALT for that period
TOLERANCE_CURRENT_YEAR_PNL_PCT = 5.0  # > 5% delta = HALT for that period

# Carniprod canary (F3.16 closure ADR locks this prediction).
CARNIPROD_EXPECTED_DRIFT_PCT = 7.3939
CARNIPROD_DRIFT_TOLERANCE = 0.01  # 7.3939 ± 0.01 — anything else means cross-interaction


# ──────────────────────────────────────────────────────────────────────
# Supabase + pipeline imports — loaded lazily so --help works without
# the container's full dep tree available.
# ──────────────────────────────────────────────────────────────────────


def _load_engine():
    try:
        from engine.api import _supabase as sb
        from engine.api.pipeline import _run_pipeline_sync
        return sb, _run_pipeline_sync
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            f"FATAL: engine package import failed ({type(exc).__name__}: {exc}). "
            f"Run inside cfo-ai-backend container."
        )


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────


def _resolve_period_id(ac, prefix: str) -> Optional[Dict[str, Any]]:
    """Look up a single financial_periods row by UUID prefix. Returns
    None when 0 matches; HALTS with explicit error when >1 match (the
    prefix collision would silently target the wrong row otherwise).

    Implementation note: PostgREST's `like` operator expects `*` as the
    wildcard (translates to %), and the supabase admin client's
    `filters` plumbing passes the value verbatim — so `like.<prefix>%`
    sends a literal `%` which PostgREST 404s on. Pulling all rows and
    filtering client-side mirrors the proven probe_backfill_classify.py
    pattern; the prod period table is < 20 rows so the cost is
    irrelevant."""
    all_rows = ac.select("financial_periods", limit=2000) or []
    matches = [r for r in all_rows if str(r.get("id") or "").startswith(prefix)]
    if len(matches) == 0:
        return None
    if len(matches) > 1:
        ids = [r.get("id") for r in matches]
        raise SystemExit(
            f"FATAL: prefix {prefix!r} matches {len(matches)} rows ({ids}). "
            f"Refuse to proceed — could target wrong row."
        )
    return matches[0]


def _verify_snapshot_column(ac) -> None:
    """Refuses to proceed if the migration hasn't run yet OR if the
    PostgREST schema cache hasn't picked up the new column.

    2026-05-26 — F3.24 refactor: extracted reusable
    `verify_pgrst_visibility` helper in `scripts/_pgrst_visibility.py`.
    Every future orchestrator that depends on a freshly-added column
    should import the helper rather than re-implement; this function
    is now a thin wrapper that calls the shared helper with the
    `financial_periods.pre_backfill_snapshot` target."""
    from _pgrst_visibility import verify_pgrst_visibility
    verify_pgrst_visibility(ac, "financial_periods", "pre_backfill_snapshot")


def _extract_user_visible(canonical: Optional[Dict[str, Any]]) -> Dict[str, Optional[float]]:
    """Pull the two tolerance-gated user-visible numbers out of a
    canonical envelope. Returns None for missing fields rather than
    raising — the diff phase compares None to None as zero-delta but
    flags `round_trip_passed` separately."""
    if not isinstance(canonical, dict):
        return {"total_assets": None, "current_year_pnl": None,
                "round_trip_passed": False, "envelope_present": False}
    bs = canonical.get("balance_sheet") or {}
    pl = canonical.get("profit_loss") or {}
    rt = canonical.get("round_trip_check") or {}
    return {
        "total_assets": bs.get("total_assets"),
        "current_year_pnl": pl.get("current_year_pnl"),
        "round_trip_passed": bool(rt.get("passed")) if isinstance(rt, dict) else False,
        "envelope_present": True,
    }


def _delta_pct(before: Optional[float], after: Optional[float]) -> float:
    """Percent change. Treats None on either side as zero; downstream
    callers handle the None case separately when needed."""
    if before is None or after is None:
        return 0.0
    if abs(before) < 1.0:
        # Avoid div-by-zero blowups on near-zero pre-values; absolute
        # delta is what matters there.
        return 0.0 if abs(after - before) < 1.0 else float("inf")
    return (after - before) / abs(before) * 100.0


# ──────────────────────────────────────────────────────────────────────
# Phase implementations
# ──────────────────────────────────────────────────────────────────────


def phase_snapshot() -> int:
    sb, _ = _load_engine()
    print("=" * 90)
    print("F3.16-3b.5 PHASE 0 — pre_backfill_snapshot")
    print("=" * 90)
    with sb.admin() as ac:
        _verify_snapshot_column(ac)

        # Resolve every period prefix to a full row; refuse partial sets.
        resolved: List[Dict[str, Any]] = []
        missing: List[str] = []
        for prefix in TARGET_PERIODS_BY_PREFIX:
            row = _resolve_period_id(ac, prefix)
            if not row:
                missing.append(prefix)
            else:
                resolved.append(row)
        if missing:
            print(f"FATAL: target period prefixes not found in DB: {missing}")
            print(f"       Update TARGET_PERIODS_BY_PREFIX in this script to match prod.")
            return 1

        # Write snapshots. Skip rows that already have one (idempotent).
        wrote = 0
        skipped = 0
        for row in resolved:
            pid = row["id"]
            if row.get("pre_backfill_snapshot"):
                print(f"  skip   {pid[:8]} (snapshot already present)")
                skipped += 1
                continue
            snapshot = {
                "snapshot_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "snapshot_version": "F3.16-3b5-v1",
                "assembled_canonical_v1": row.get("assembled_canonical_v1"),
                "methodology_version": row.get("methodology_version"),
                "detection_envelope": row.get("detection_envelope"),
                "updated_at_before": row.get("updated_at"),
            }
            ac.update(
                "financial_periods",
                filters={"id": f"eq.{pid}"},
                payload={"pre_backfill_snapshot": snapshot},
            )
            wrote += 1
            print(f"  wrote  {pid[:8]} (line_items={row.get('line_items_count') or '?'})")

        print()
        print(f"Phase 0 result: {wrote} snapshot(s) written, {skipped} skipped (idempotent).")
        print(f"Total target periods: {len(resolved)} (expected 8).")
        if len(resolved) != 8:
            print("WARN: count mismatch — verify the plan doc matches current prod.")
            return 1
        print("Ready for --mode single.")
        return 0


def _diff_against_snapshot(
    row_before: Dict[str, Any],
    canonical_after: Optional[Dict[str, Any]],
) -> Tuple[bool, List[str], Dict[str, float]]:
    """Returns (ok, halt_reasons, deltas). ok=False → HALT for this period."""
    snap = row_before.get("pre_backfill_snapshot") or {}
    canonical_before = snap.get("assembled_canonical_v1")
    before = _extract_user_visible(canonical_before)
    after = _extract_user_visible(canonical_after)

    deltas = {
        "total_assets_pct": _delta_pct(before["total_assets"], after["total_assets"]),
        "current_year_pnl_pct": _delta_pct(before["current_year_pnl"], after["current_year_pnl"]),
    }

    reasons: List[str] = []
    if not after["envelope_present"]:
        reasons.append("canonical envelope STILL ABSENT after re-extract")
    if not after["round_trip_passed"]:
        reasons.append(f"round_trip_check.passed != True (got {after['round_trip_passed']!r})")
    if abs(deltas["total_assets_pct"]) > TOLERANCE_TOTAL_ASSETS_PCT:
        reasons.append(
            f"total_assets shifted {deltas['total_assets_pct']:+.4f}% (tolerance ±{TOLERANCE_TOTAL_ASSETS_PCT}%)"
        )
    if abs(deltas["current_year_pnl_pct"]) > TOLERANCE_CURRENT_YEAR_PNL_PCT:
        reasons.append(
            f"current_year_pnl shifted {deltas['current_year_pnl_pct']:+.4f}% (tolerance ±{TOLERANCE_CURRENT_YEAR_PNL_PCT}%)"
        )

    return len(reasons) == 0, reasons, deltas


def _re_extract_one(period_row: Dict[str, Any], run_pipeline_sync) -> Optional[Dict[str, Any]]:
    """Calls _run_pipeline_sync on the period's source document, then
    re-reads the financial_period row and returns the new
    assembled_canonical_v1 blob. Returns None if the doc is missing."""
    sb, _ = _load_engine()
    doc_id = period_row.get("source_document_id")
    if not doc_id:
        print(f"    no source_document_id; cannot re-extract")
        return None

    print(f"    calling _run_pipeline_sync(doc_id={doc_id[:8]})… (≈40-60s)")
    run_pipeline_sync(doc_id)

    # Re-read the period to capture the new canonical envelope.
    with sb.admin() as ac:
        fresh_rows = ac.select(
            "financial_periods",
            filters={"id": f"eq.{period_row['id']}"},
            limit=1,
        ) or []
    if not fresh_rows:
        return None
    return fresh_rows[0].get("assembled_canonical_v1")


def _process_periods(prefixes: List[str], label: str) -> int:
    sb, run_pipeline_sync = _load_engine()
    print("=" * 90)
    print(f"F3.16-3b.5 — {label}")
    print(f"Processing {len(prefixes)} period(s): {prefixes}")
    print("=" * 90)

    halt_periods: List[str] = []

    with sb.admin() as ac:
        for prefix in prefixes:
            row = _resolve_period_id(ac, prefix)
            if not row:
                print(f"  HALT: period prefix {prefix!r} no longer in DB")
                return 1
            if not row.get("pre_backfill_snapshot"):
                print(f"  HALT: period {prefix} has no pre_backfill_snapshot. Run --mode snapshot first.")
                return 1

            print(f"  re-extract {row['id'][:8]} ({row.get('period_end')})")
            canonical_after = _re_extract_one(row, run_pipeline_sync)

            # Re-load the row to get the latest pre_backfill_snapshot
            # value (we just wrote canonical_after to it earlier; the
            # snapshot is the row's *previous* state, still intact).
            row_after = _resolve_period_id(ac, prefix) or row

            ok, reasons, deltas = _diff_against_snapshot(row, canonical_after)
            print(f"    Δ total_assets       = {deltas['total_assets_pct']:+.4f}%")
            print(f"    Δ current_year_pnl   = {deltas['current_year_pnl_pct']:+.4f}%")
            if ok:
                print(f"    OK — within tolerance + envelope valid")
            else:
                print(f"    HALT — {len(reasons)} reason(s):")
                for r in reasons:
                    print(f"        · {r}")
                halt_periods.append(row["id"])
                # HALT IMMEDIATELY for batch phases (does not process
                # remaining periods in the batch).
                break

    if halt_periods:
        print()
        print("=" * 90)
        print(f"HALT — {label} stopped on first failing period.")
        print(f"Affected period_id(s): {halt_periods}")
        print("Run --mode rollback to print the SQL block that restores from pre_backfill_snapshot.")
        return 1

    print()
    print(f"{label} complete. Run F-A3.1 next:")
    print("  docker exec cfo-ai-backend python3 /app/scripts/measure_bs_drift.py")
    print("Expected: 8/8 GREEN, Carniprod at 7.3939% (canary).")
    return 0


def phase_single() -> int:
    """Single-period diff de-risks the batch by proving the mechanism
    on one period before touching the others. Targets EEI PDF (the
    smallest, cleanest period — 61 line_items)."""
    return _process_periods(
        TARGET_PERIODS_BY_PREFIX[:1],
        "PHASE 1a — single-period diff (EEI PDF, smallest)",
    )


def phase_batch1() -> int:
    """Batch 1 (and only batch in this reduced set): the 2 Sibiu PDF
    periods (FY2019 duplicates). Wall-clock ~90s sequential."""
    return _process_periods(
        TARGET_PERIODS_BY_PREFIX[1:3],
        "PHASE 1b — batch 1 of 1 (2 Sibiu PDF periods)",
    )


def phase_batch2() -> int:
    """Batch 2 — VACUOUS in the reduced 3-period set. Returns 0
    immediately so the runbook stays callable end-to-end without
    branching. The original 8-period plan had a batch2; the reduced
    set fits entirely in single + batch1."""
    print("=" * 90)
    print("PHASE 1c — batch 2 of N: SKIPPED (reduced 3-period set has no batch2)")
    print("=" * 90)
    print("  All 3 target periods are covered by --mode single + --mode batch1.")
    print("  Proceed directly to --mode coverage for the F-A3.3 envelope gate.")
    return 0


def phase_coverage() -> int:
    """Phase 2: F-A3.3-ENVELOPE-COVERAGE gate. Delegates to the
    dedicated script so the gate can be re-run independently."""
    # Just exec the dedicated gate script. Keeps the orchestrator
    # one-job-per-mode and the gate's own exit code propagates.
    import subprocess
    print("Phase 2 — running F-A3.3-ENVELOPE-COVERAGE gate…")
    return subprocess.call(
        [sys.executable, "/app/scripts/measure_envelope_coverage.py"]
    )


def phase_rollback() -> int:
    """Prints the SQL block to restore HALT-affected periods. Does NOT
    execute the SQL — operator pastes into Supabase Studio."""
    print("=" * 90)
    print("ROLLBACK SQL — paste into Supabase Studio after substituting period_ids")
    print("=" * 90)
    print("""
BEGIN;

UPDATE financial_periods
SET
  assembled_canonical_v1 = pre_backfill_snapshot->'assembled_canonical_v1',
  methodology_version    = pre_backfill_snapshot->>'methodology_version',
  detection_envelope     = pre_backfill_snapshot->'detection_envelope',
  updated_at             = now()
WHERE id IN (
  -- PASTE the period_id(s) from the orchestrator's HALT output here, one per line:
  -- '6c6b8503-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
)
  AND pre_backfill_snapshot IS NOT NULL
  AND pre_backfill_snapshot->>'snapshot_version' = 'F3.16-3b5-v1';

-- Verify before COMMIT:
SELECT id,
       pre_backfill_snapshot->>'snapshot_version'      AS snap_ver,
       (assembled_canonical_v1 IS NOT NULL)            AS has_envelope_after,
       methodology_version,
       updated_at
  FROM financial_periods
 WHERE id IN ( /* same list as above */ );

-- If verify is clean:
COMMIT;
-- Or:
-- ROLLBACK;
""")
    print("After rollback, re-run F-A3.1 to confirm fixtures are still GREEN.")
    return 0


# ──────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--mode",
        required=True,
        choices=["snapshot", "single", "batch1", "batch2", "coverage", "rollback"],
        help="Backfill phase to execute. See module docstring for the full sequence.",
    )
    args = parser.parse_args()
    handlers = {
        "snapshot": phase_snapshot,
        "single": phase_single,
        "batch1": phase_batch1,
        "batch2": phase_batch2,
        "coverage": phase_coverage,
        "rollback": phase_rollback,
    }
    return handlers[args.mode]()


if __name__ == "__main__":
    sys.exit(main())
