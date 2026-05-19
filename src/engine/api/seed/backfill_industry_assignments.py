"""Phase F backfill — populate company_industry_assignments from the
legacy `organizations.caen_code` column for every financial_period that
doesn't already have an assignment.

WHY
===
Phases A–E layered the new industry-intelligence tables on top of the
legacy `organizations.caen_code` field without migrating data. New
analyses go through the new path; existing periods still resolve via
the legacy fallback. This script closes that gap by writing one
auto-detected assignment row per orphan period so:

  · The UI surface (IndustryBadge, IndustryPicker) is meaningful for
    historical periods, not just newly-uploaded ones.
  · The dual-read in `_benchmarks.py::_resolve_effective_caen` starts
    returning ``source='period_assignment'`` for backfilled periods
    (was always ``'org_default'`` before).
  · The audit log gets a clean "initial assignment by backfill" entry
    so subsequent user overrides have a coherent prior-source.

WHAT IT WRITES
==============
For each (org, period) pair where:
  · `financial_periods.id` has NO row in `company_industry_assignments`
  · The org has a non-null `organizations.caen_code`
  · That CAEN resolves through `caen_industry_mappings`

…inserts one row into `company_industry_assignments` with:
    source = 'auto_caen'              (NOT user_override — this is a
                                       system migration, not a user act)
    locked_by_user = false            (lets future re-detection upgrade
                                       it without 409s)
    selected_industry_key   = mapping.industry_key
    detected_industry_key   = mapping.industry_key  (same — no other signal)
    confidence              = mapping.confidence    (typically 0.85-0.95)
    caen_code               = org.caen_code         (denormalized)
    company_name            = org.name              (denormalized)

…and one row into `industry_change_audit_log` with:
    prev_industry_key = null
    new_industry_key  = (above)
    prev_source = null
    new_source = 'auto_caen'
    reason = 'Phase F backfill from organizations.caen_code'
    payload = { backfill: true, mapping: {...}, org_caen: '…' }

IDEMPOTENCY
===========
Periods with an existing assignment row are skipped (logged at INFO).
Re-running the script is a no-op for them. Safe to cron.

USAGE
=====
    # Plan + count, no DB writes:
    .venv/bin/python -m engine.api.seed.backfill_industry_assignments --dry-run

    # Real run:
    .venv/bin/python -m engine.api.seed.backfill_industry_assignments

    # Real run scoped to a single org (useful for staged rollout):
    .venv/bin/python -m engine.api.seed.backfill_industry_assignments \
        --org-id 12345678-1234-1234-1234-123456789012

    # Post-load verify only — reports orphan counts without writing:
    .venv/bin/python -m engine.api.seed.backfill_industry_assignments --verify

EXIT CODES
==========
  0 — success (or dry-run completed). Final orphan count is logged.
  1 — at least one period failed to backfill. See stderr for details.
  2 — missing prerequisites (env vars, catalog not yet loaded).
"""

from __future__ import annotations

import argparse
import logging
import sys
from typing import Any, Dict, List, Optional, Tuple


logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Pre-flight helpers
# ──────────────────────────────────────────────────────────────────────

def _ensure_catalog_loaded(client: Any) -> None:
    """Confirm Phase A's catalog has been loaded before we try to FK against it.
    Aborts with a clear message if industry_profiles or caen_industry_mappings
    are empty — running the backfill against an empty catalog would write
    every row with `industry_key=NULL` (impossible per the schema) or fail
    every insert silently."""
    profiles = client.select("industry_profiles", columns="key", limit=1)
    if not profiles:
        raise SystemExit(
            "industry_profiles is empty — load Phase A first via "
            "`python -m engine.api.seed.load_industry_catalog`."
        )
    mappings = client.select("caen_industry_mappings", columns="caen_code", limit=1)
    if not mappings:
        raise SystemExit(
            "caen_industry_mappings is empty — load Phase A first."
        )


# ──────────────────────────────────────────────────────────────────────
# Bulk-fetch helpers — PostgREST is happier with N small queries than
# one giant IN list, but we still page so 10k-period orgs don't OOM.
# ──────────────────────────────────────────────────────────────────────

def _fetch_all(client: Any, table: str, columns: str,
               filters: Optional[Dict[str, str]] = None,
               page_size: int = 1000) -> List[Dict[str, Any]]:
    """Page-walk a PostgREST table. Uses `order=id.asc` for a stable cursor
    and `offset=N` for paging — simpler than range headers and good enough
    for backfill cardinalities (<100k rows typical)."""
    all_rows: List[Dict[str, Any]] = []
    offset = 0
    while True:
        rows = client.select(
            table,
            filters={**(filters or {})},
            columns=columns,
            order="id.asc",
            limit=page_size,
        )
        # PostgREST `limit` without `offset` always returns from row 0,
        # so on the second iteration we use `id=gt.<last>` to advance.
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < page_size:
            break
        last_id = rows[-1].get("id")
        if not last_id:
            break
        # Advance cursor — overwrite the id filter (preserves caller filters).
        filters = {**(filters or {}), "id": f"gt.{last_id}"}
        offset += len(rows)
    return all_rows


def _build_mapping_index(client: Any) -> Dict[str, Dict[str, Any]]:
    """Pre-load caen → mapping once (the table is small, <500 rows) so
    the inner backfill loop stays in-memory. PostgREST `in.()` filters
    have URL length limits; an in-process dict avoids that entirely."""
    rows = client.select(
        "caen_industry_mappings",
        columns=(
            "caen_code,industry_key,parent_industry_key,match_quality,confidence"
        ),
    )
    return {str(r["caen_code"]): r for r in rows}


# ──────────────────────────────────────────────────────────────────────
# Core: build the write set
# ──────────────────────────────────────────────────────────────────────

def _orphan_periods(client: Any, org_id_filter: Optional[str]) -> List[Dict[str, Any]]:
    """Return every financial_period that lacks a company_industry_assignments
    row. PostgREST doesn't expose anti-joins so we read both tables and
    diff in-process (acceptable at our scale)."""
    period_filters: Dict[str, str] = {}
    if org_id_filter:
        period_filters["org_id"] = f"eq.{org_id_filter}"
    periods = _fetch_all(
        client, "financial_periods", "id,org_id,period_start,period_end",
        filters=period_filters,
    )
    if not periods:
        return []
    # Read all existing assignments once; build a set of period_ids that
    # already have one. This is one round-trip regardless of period count.
    existing = _fetch_all(
        client, "company_industry_assignments", "id,period_id",
    )
    have_assignment = {r["period_id"] for r in existing}
    return [p for p in periods if p["id"] not in have_assignment]


def _build_assignment_rows(client: Any,
                            orphans: List[Dict[str, Any]],
                            mapping_index: Dict[str, Dict[str, Any]],
                            ) -> Tuple[List[Dict[str, Any]], List[str], List[Dict[str, Any]]]:
    """For each orphan period, look up the org and resolve its caen_code
    through `mapping_index`. Returns three lists:

      assignments   — rows ready to upsert into company_industry_assignments
      skipped       — period_ids we deliberately skipped (no caen, no mapping)
      audit_rows    — parallel audit-log rows for every successful assignment
    """
    # Bulk-fetch the orgs we care about so we don't read /organizations
    # once per period. Build a {id: org_row} map.
    org_ids = sorted({p["org_id"] for p in orphans if p.get("org_id")})
    org_index: Dict[str, Dict[str, Any]] = {}
    # PostgREST `in.(uuid1,uuid2,...)` URL has a length cap (~8KB). Chunk
    # so we never exceed it. 100 UUIDs ≈ 3.6KB → comfortable margin.
    for i in range(0, len(org_ids), 100):
        chunk = org_ids[i:i + 100]
        rows = client.select(
            "organizations",
            filters={"id": f"in.({','.join(chunk)})"},
            columns="id,name,caen_code",
        )
        for r in rows:
            org_index[r["id"]] = r

    assignments: List[Dict[str, Any]] = []
    audit_rows: List[Dict[str, Any]] = []
    skipped: List[str] = []
    for p in orphans:
        org = org_index.get(p["org_id"])
        if not org:
            skipped.append(f"{p['id']}: org {p['org_id']} not found")
            continue
        caen = org.get("caen_code")
        if not caen:
            skipped.append(f"{p['id']}: org has no caen_code")
            continue
        mapping = mapping_index.get(str(caen))
        if not mapping:
            skipped.append(f"{p['id']}: caen {caen} not in caen_industry_mappings")
            continue
        assignments.append({
            "organization_id": p["org_id"],
            "period_id": p["id"],
            "company_name": org.get("name"),
            "caen_code": caen,
            "detected_industry_key": mapping["industry_key"],
            "selected_industry_key": mapping["industry_key"],
            "source": "auto_caen",
            "confidence": float(mapping.get("confidence") or 0.85),
            "locked_by_user": False,
        })
        audit_rows.append({
            "organization_id": p["org_id"],
            "period_id": p["id"],
            "changed_by": None,
            "prev_industry_key": None,
            "new_industry_key": mapping["industry_key"],
            "prev_source": None,
            "new_source": "auto_caen",
            "reason": "Phase F backfill from organizations.caen_code",
            "payload": {
                "backfill": True,
                "org_caen": caen,
                "mapping": mapping,
            },
        })
    return assignments, skipped, audit_rows


# ──────────────────────────────────────────────────────────────────────
# Writes
# ──────────────────────────────────────────────────────────────────────

def _upsert_in_batches(client: Any, table: str, rows: List[Dict[str, Any]],
                        *, on_conflict: str, batch_size: int = 200) -> int:
    """Slice rows into batches so we don't blow PostgREST's request-body
    limit on large orgs. Returns the total upserted count."""
    total = 0
    for i in range(0, len(rows), batch_size):
        chunk = rows[i:i + batch_size]
        client.upsert(table, chunk, on_conflict=on_conflict, returning=False)
        total += len(chunk)
        logger.info("  upserted %d/%d into %s", total, len(rows), table)
    return total


def _insert_audit_in_batches(client: Any, rows: List[Dict[str, Any]],
                              *, batch_size: int = 200) -> int:
    """Audit table has no on-conflict key (id is generated by gen_random_uuid()).
    Plain insert in batches. A re-run that hit existing assignments would
    have skipped them upstream — so we never double-log."""
    total = 0
    for i in range(0, len(rows), batch_size):
        chunk = rows[i:i + batch_size]
        client.insert("industry_change_audit_log", chunk, returning=False)
        total += len(chunk)
        logger.info("  inserted %d/%d audit rows", total, len(rows))
    return total


# ──────────────────────────────────────────────────────────────────────
# Verification (post-load)
# ──────────────────────────────────────────────────────────────────────

def _summarize(client: Any) -> Dict[str, int]:
    """Counts that help confirm the backfill landed: total periods, total
    assignments, orphans (periods without assignment), and assignments
    whose detected_industry_key matches selected_industry_key (== was
    NOT user-overridden after backfill, useful to spot drift)."""
    periods = _fetch_all(client, "financial_periods", "id,org_id")
    assignments = _fetch_all(
        client, "company_industry_assignments",
        "period_id,selected_industry_key,detected_industry_key,source,locked_by_user",
    )
    have = {a["period_id"] for a in assignments}
    orphan_count = sum(1 for p in periods if p["id"] not in have)
    auto_caen = sum(1 for a in assignments if a.get("source") == "auto_caen")
    user_locked = sum(1 for a in assignments if a.get("locked_by_user"))
    return {
        "periods": len(periods),
        "assignments": len(assignments),
        "orphans": orphan_count,
        "auto_caen": auto_caen,
        "user_locked": user_locked,
    }


# ──────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────

def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="seed.backfill_industry_assignments",
        description=(
            "Phase F: populate company_industry_assignments from legacy "
            "organizations.caen_code for periods that lack one."
        ),
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Compute what would be written; do NOT write to DB.",
    )
    parser.add_argument(
        "--verify", action="store_true",
        help="Print orphan/assignment counts and exit. No writes.",
    )
    parser.add_argument(
        "--org-id", type=str, default=None,
        help="Backfill a single org only (UUID). Useful for staged rollout.",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="DEBUG-level logs (per-row decisions).",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        format="[%(levelname)s] %(message)s",
        level=logging.DEBUG if args.verbose else logging.INFO,
    )

    # Local import keeps `--help` working without env vars set.
    from .. import _supabase  # type: ignore

    with _supabase.admin() as client:
        _ensure_catalog_loaded(client)

        if args.verify:
            summary = _summarize(client)
            print("BACKFILL STATUS")
            for k, v in summary.items():
                print(f"  {k:14s} {v}")
            return 0

        orphans = _orphan_periods(client, args.org_id)
        if not orphans:
            print("No orphan periods — every financial_period already has an assignment.")
            return 0

        mapping_index = _build_mapping_index(client)
        assignments, skipped, audit_rows = _build_assignment_rows(
            client, orphans, mapping_index,
        )

        logger.info("Found %d orphan periods", len(orphans))
        logger.info("  → backfill candidates: %d", len(assignments))
        logger.info("  → skipped:             %d", len(skipped))
        if args.verbose:
            for s in skipped:
                logger.debug("    skip: %s", s)

        if args.dry_run:
            print(
                f"DRY RUN: would upsert {len(assignments)} assignments + "
                f"{len(audit_rows)} audit rows. Skipped: {len(skipped)}."
            )
            return 0

        if not assignments:
            print(f"Nothing to write. Skipped {len(skipped)} periods (see logs).")
            return 0

        try:
            _upsert_in_batches(
                client, "company_industry_assignments",
                assignments, on_conflict="period_id",
            )
            _insert_audit_in_batches(client, audit_rows)
        except Exception as exc:
            logger.exception("Backfill write FAILED: %s", exc)
            return 1

        # Post-write verification — confirm the orphan count went to zero
        # (or at least down by len(assignments)).
        summary_after = _summarize(client)
        print(
            f"OK: wrote {len(assignments)} assignments + "
            f"{len(audit_rows)} audit rows. "
            f"Remaining orphans: {summary_after['orphans']}"
        )
        if summary_after["orphans"] > 0 and not args.org_id:
            print(
                f"NOTE: {summary_after['orphans']} period(s) still lack an "
                f"assignment — likely because their org has no caen_code "
                f"or the caen isn't in caen_industry_mappings. Re-run with "
                f"--verbose for the skip list.",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
