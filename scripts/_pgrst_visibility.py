"""verify_pgrst_visibility — reusable pre-write safety check.

Why this helper exists
----------------------
Every backfill orchestrator that writes to a newly-added column hits the
same risk: the SQL migration ran successfully, the column exists in
`pg_catalog`, but PostgREST (the Supabase REST API layer) hasn't picked
up the schema change yet. Writes through the admin client then silently
drop the column from the payload — partial-capture data corruption that
the orchestrator doesn't notice.

F3.16-3b.5 hit this exactly. The `_verify_snapshot_column` helper in
`run_3b5_backfill.py` caught it before any writes (the discipline
working). But the pattern repeats every time an orchestrator adds a
new column. This module extracts the helper so the next orchestrator
imports it instead of re-implementing.

How to use
----------

    from _pgrst_visibility import verify_pgrst_visibility

    with _supabase.admin() as ac:
        # Halts the script with a clear SystemExit if the column isn't
        # visible via PostgREST API yet, regardless of pg_catalog state.
        verify_pgrst_visibility(ac, "financial_periods", "pre_backfill_snapshot")
        # safe to write below here

Two probes per call:
  1. Wildcard `SELECT *` — checks whether PostgREST includes the column
     in the returned row keys.
  2. Explicit `SELECT id,<new_col>` — checks whether PostgREST recognizes
     the column name as queryable (raises 400 if not).

Both must succeed for the helper to return. If either fails, the
helper raises SystemExit with a message that points the operator at
the F3.24 escalation path:
  1. Run `NOTIFY pgrst, 'reload schema';` in Supabase Studio
  2. Click "Reload schema cache" in Supabase Dashboard → Settings → API
  3. Toggle any API setting (Path C) to force PostgREST restart

If all three fail, the issue is Bug #4 territory
([F3.25-SUPABASE-POSTGREST-CACHE-PERSISTENT-STALENESS]) — open a
Supabase support ticket with the evidence trail.
"""
from __future__ import annotations

from typing import Any


def verify_pgrst_visibility(ac: Any, table: str, column: str) -> None:
    """Raise SystemExit if `column` is not visible via PostgREST API on
    `table`. Two probes: wildcard select + explicit column select.

    Pure-read; no DB writes. Idempotent; safe to call any number of
    times pre-write.

    Args:
        ac:     `_supabase.admin()` context-managed client (already
                inside a `with` block).
        table:  Table name (e.g. `"financial_periods"`).
        column: Column name expected to be present (e.g.
                `"pre_backfill_snapshot"`).
    """
    # Probe 1: wildcard select. If PostgREST's schema cache knows the
    # column, the returned row dict includes it (value may be None on
    # rows that haven't been populated yet — that's fine, the KEY's
    # presence is the check).
    rows = ac.select(table, limit=1) or []
    if rows and column not in rows[0]:
        raise SystemExit(_build_message(table, column, reason="wildcard select returned row without the column key"))

    # Probe 2: explicit column select. If PostgREST doesn't know the
    # column, it returns 400 Bad Request. Our admin client raises an
    # httpx.HTTPStatusError from r.raise_for_status() — let it bubble
    # but convert to a clean SystemExit so the orchestrator emits a
    # readable message instead of a stack trace.
    try:
        ac.select(table, limit=1, columns=f"id,{column}")
    except Exception as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if "400" in msg or "bad request" in msg or column.lower() in msg:
            raise SystemExit(_build_message(table, column, reason=f"explicit select rejected — {type(exc).__name__}"))
        raise  # Different failure class; let it surface


def _build_message(table: str, column: str, *, reason: str) -> str:
    return (
        f"FATAL: column `{table}.{column}` is not visible to PostgREST API ({reason}).\n"
        f"\n"
        f"The column may exist in pg_catalog but PostgREST's schema cache hasn't picked it up.\n"
        f"This is the F3.24 schema-migration class of failure. Operator escalation steps:\n"
        f"\n"
        f"  1. Run in Supabase Studio:\n"
        f"     NOTIFY pgrst, 'reload schema';\n"
        f"\n"
        f"  2. If still stale after 10 seconds:\n"
        f"     Supabase Dashboard → Settings → API → 'Reload schema cache' button\n"
        f"\n"
        f"  3. If still stale (Bug #4 territory):\n"
        f"     Supabase Dashboard → Settings → API → toggle any setting (e.g. Max Rows)\n"
        f"     to force a PostgREST worker restart. Wait 15 s then re-probe.\n"
        f"\n"
        f"  4. If all three exhausted:\n"
        f"     File [F3.25-SUPABASE-POSTGREST-CACHE-PERSISTENT-STALENESS] and open a\n"
        f"     Supabase support ticket. Pause the orchestrator until the cache flips.\n"
        f"     Carniprod canary (7.3939 %) and pre-baseline F-A3.1 / F-A3.2 readings\n"
        f"     are preserved; resume from this gate on the next session.\n"
    )
