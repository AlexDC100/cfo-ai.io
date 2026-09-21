#!/usr/bin/env python3
"""READ-ONLY snapshot of every workspace-scoped table, and its drift check.

    python3 scripts/db_snapshot.py --out /app/data/ws_migration/snap.json.gz
    python3 scripts/db_snapshot.py --verify /app/data/ws_migration/snap.json.gz

What is dumped: every table PostgREST exposes that has an ``org_id``,
``period_id`` or ``organization_id`` column, plus organizations,
memberships, org_prefs, user_prefs, financial_periods, documents,
user_usage and subscriptions — ALL rows, every column, paged by primary
key until PostgREST's exact count is reached (a response is silently
capped at db-max-rows). One gzipped JSON: per table the primary key, the
columns, the row count, a sha256 over the rows sorted by key, and the rows.

``--schema prod_schema.json`` pins WHICH tables (the file written by the
schema probe: ``{"tables": {name: [columns]}}``); without it the list comes
from the live OpenAPI document.

``--verify`` re-reads production and reports, per table, equal or not (and
how many rows changed / vanished / appeared). Exit 0 only when every table
is equal. Both modes only ever issue GET requests.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable, Dict, Optional


def _add_src_to_path() -> None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "src" / "engine").is_dir():
            sys.path.insert(0, str(parent / "src"))
            return


_add_src_to_path()

from engine.workspaces import pgrest_io  # noqa: E402


def _load_schema(path: Optional[str]) -> Optional[Dict[str, Dict[str, Any]]]:
    if not path:
        return None
    raw = json.loads(Path(path).read_text())
    tables = raw.get("tables") if isinstance(raw, dict) and "tables" in raw else raw
    return {t: {"columns": list(cols if isinstance(cols, list) else cols.get("columns") or [])}
            for t, cols in tables.items()}


def report_verify(result: Dict[str, Dict[str, Any]], out=print) -> bool:
    ok = True
    for t in sorted(result):
        r = result[t]
        mark = "EQUAL" if r["equal"] else "DRIFT"
        ok = ok and r["equal"]
        extra = "" if r["equal"] else "  changed=%d missing=%d created=%d" % (
            r["changed"], r["missing"], r["created"])
        out("%-32s %-5s snapshot=%-7d now=%-7d%s" % (t, mark, r["snapshot_count"], r["current_count"], extra))
    out("VERIFY: %s" % ("EQUAL — no drift since the snapshot" if ok else "DRIFT — production changed"))
    return ok


def main(argv=None, *, client_factory: Optional[Callable[[], Any]] = None, out=print) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--out", help="write the snapshot here (.json.gz)")
    g.add_argument("--verify", help="compare production with this snapshot")
    ap.add_argument("--schema", help="prod_schema.json pinning which tables to dump")
    args = ap.parse_args(argv)

    if client_factory is None:
        from engine.api import _supabase
        client_factory = _supabase.admin
    client = client_factory()
    try:
        db = pgrest_io.PgRest(client)
        if args.verify:
            snap = pgrest_io.load_snapshot(args.verify)
            result = pgrest_io.verify_snapshot(db, snap)
            return 0 if report_verify(result, out) else 1
        snap = pgrest_io.build_snapshot(db, schema=_load_schema(args.schema))
        digest = pgrest_io.write_snapshot(snap, args.out)
        for t, meta in snap["tables"].items():
            out("%-32s %7d rows  pk=%s  sha256=%s" % (t, meta["count"], ",".join(meta["pk"]),
                                                     meta["sha256"][:16]))
        out("SNAPSHOT: %s  (%d tables, created_at %s, file sha256 %s)"
            % (args.out, len(snap["tables"]), snap["created_at"], digest))
        return 0
    finally:
        close = getattr(client, "close", None)
        if close:
            close()


if __name__ == "__main__":
    sys.exit(main())
