#!/usr/bin/env python3
"""Put tables back to a snapshot taken by db_snapshot.py — the rollback of
the workspace migration.

    python3 scripts/db_restore.py SNAP.json.gz                       # dry-run (default)
    python3 scripts/db_restore.py SNAP.json.gz --apply --tables migration
    python3 scripts/db_restore.py SNAP.json.gz --apply --tables documents,financial_periods

DRY-RUN (default, GET only): per table, the rows whose current state differs
from the snapshot (by primary key — composite for memberships / org_prefs /
user_prefs — with the differing columns), rows the snapshot has that are
gone, and rows created since.

--apply --tables T,...: every changed or vanished row is upserted back to
its snapshot value; rows created since the snapshot are ARCHIVED, never
deleted (organizations: archived_at = now, purge_after NULL; documents:
deleted_at = now). A created row in a table with no archive column is
reported and left in place. ``--tables migration`` = every snapshot table
except the billing ones (user_usage, subscriptions, billing_events), which
are only restored when named.

Storage objects: the migration copies objects and never deletes one, so a
restored storage_path should find its original object — unless something
ELSE erased it meanwhile (a workspace purge deletes every object under
'<org>/'). So the rows are not the whole rollback: every document whose
object existed when the snapshot was taken (``db_snapshot`` records an
object inventory) must still resolve. A snapshot without an inventory
(older format) checks every document row this run restores. Missing
objects are listed as STORAGE MISSING; with --apply they make the exit 1.

After --apply the tables are re-read and every snapshot row is compared;
exit 1 if any differs, or if any object above is missing.

RESIDUE. A restore never deletes, so rows created since the snapshot stay:
organizations / documents archived (held: purge_after NULL — listed
nowhere, never purgeable from the hub), and memberships / org_prefs rows,
which have no archive column (they belong to those archived workspaces and
are inert). They are counted on a RESIDUE line — the rollback is "every
snapshot row is back", never "production is the snapshot".
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable, List, Optional


def _add_src_to_path() -> None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "src" / "engine").is_dir():
            sys.path.insert(0, str(parent / "src"))
            return


_add_src_to_path()

from engine.workspaces import pgrest_io  # noqa: E402
from engine.workspaces.rowstore import canonical_json, restore_diff, restore_ops  # noqa: E402


def _tables(spec: Optional[str], snap_tables: List[str]) -> List[str]:
    if not spec:
        return list(snap_tables)
    if spec == "all":
        return list(snap_tables)
    if spec == "migration":
        return [t for t in snap_tables if t not in pgrest_io.BILLING_TABLES]
    names = [t.strip() for t in spec.split(",") if t.strip()]
    unknown = [t for t in names if t not in snap_tables]
    if unknown:
        raise SystemExit("not in the snapshot: %s" % ", ".join(unknown))
    return names


def print_diff(diff, out=print, limit: int = 50) -> int:
    total = 0
    for t in sorted(diff):
        d = diff[t]
        n = len(d["changed"]) + len(d["missing"]) + len(d["created"])
        total += n
        if not n:
            out("%-32s unchanged" % t)
            continue
        out("%-32s changed=%d missing=%d created_since=%d" % (t, len(d["changed"]), len(d["missing"]),
                                                              len(d["created"])))
        for ch in d["changed"][:limit]:
            cols = ", ".join("%s: %s -> %s" % (c, canonical_json(v["now"])[:60], canonical_json(v["snapshot"])[:60])
                             for c, v in sorted(ch["columns"].items()))
            out("    ~ %s  %s" % (canonical_json(ch["key"]), cols))
        for k in d["missing"][:limit]:
            out("    + %s (gone since the snapshot; restore re-inserts it)" % canonical_json(k))
        for k in d["created"][:limit]:
            out("    - %s (created since the snapshot; restore archives it)" % canonical_json(k))
    return total


def storage_missing(db: Any, snap: Any, rows: Any, tables: List[str], ops: List[Any]) -> List[str]:
    """Documents whose snapshot storage object does not resolve now."""
    if "documents" not in tables:
        return []
    snap_docs = {str(d["id"]): d for d in rows.get("documents") or []}
    objects = snap.get("objects")
    if objects is not None:
        want = [(did, o["path"], o["org_id"], "existed at the snapshot")
                for did, o in sorted(objects.items()) if o.get("exists") is True and did in snap_docs]
    else:
        touched = set()
        for op in ops:
            if op.get("table") == "documents":
                touched.add(str((op.get("row") or op.get("key") or {}).get("id")))
        want = [(did, d["storage_path"], str(d["org_id"]),
                 "restored by this run; the snapshot has no object inventory")
                for did, d in sorted(snap_docs.items()) if did in touched and d.get("storage_path")]
    out: List[str] = []
    for did, path, org, basis in want:
        try:
            ok = db.object_exists("documents", path, org_id=org)
        except Exception as exc:  # noqa: BLE001 — a check that cannot answer is a failure
            ok, basis = False, "%s; %s: %s" % (basis, type(exc).__name__, str(exc)[:120])
        if not ok:
            out.append("document %s -> %s (%s)" % (did, path, basis))
    return out


def main(argv=None, *, client_factory: Optional[Callable[[], Any]] = None, out=print,
         now: Optional[str] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("snapshot")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True)
    mode.add_argument("--apply", action="store_true")
    ap.add_argument("--tables", help="comma list, 'migration' or 'all' (required with --apply)")
    ap.add_argument("--json", help="also write the diff as JSON here")
    args = ap.parse_args(argv)

    snap = pgrest_io.load_snapshot(args.snapshot)
    names = list(snap["tables"])
    if args.apply and not args.tables:
        raise SystemExit("--apply needs --tables (a comma list, 'migration' or 'all')")
    tables = _tables(args.tables, names)
    pks = pgrest_io.snapshot_pks(snap)
    rows = pgrest_io.snapshot_rows(snap)

    if client_factory is None:
        from engine.api import _supabase
        client_factory = _supabase.admin
    client = client_factory()
    try:
        db = pgrest_io.PgRest(client)
        current = pgrest_io.read_tables(db, tables, pks)
        diff = restore_diff(rows, current, pks=pks, tables=tables)
        out("RESTORE %s against %s (snapshot %s)" % ("APPLY" if args.apply else "DRY-RUN",
                                                     client.url, snap["created_at"]))
        n = print_diff(diff, out)
        if args.json:
            Path(args.json).write_text(json.dumps(diff, indent=1, default=str, ensure_ascii=False))
        if not args.apply:
            for m in storage_missing(db, snap, rows, tables, []):
                out("  STORAGE MISSING: %s" % m)
            out("DRY-RUN: %d row(s) differ; nothing written." % n)
            return 0
        ops, notes = restore_ops(rows, current, pks=pks, tables=tables)
        for note in notes:
            out("  note: %s" % note)
        run_ts = now or pgrest_io.utc_now_iso()
        done = pgrest_io.apply_live(db, ops, now=run_ts, pks=pks, log=out)
        out("applied=%d skipped=%d" % (done["applied"], done["skipped"]))
        after = restore_diff(rows, pgrest_io.read_tables(db, tables, pks), pks=pks, tables=tables)
        bad = sum(len(after[t]["changed"]) + len(after[t]["missing"]) for t in tables)
        out("RESTORE CHECK: %s" % ("every snapshot row is back" if not bad else
                                   "%d snapshot row(s) still differ" % bad))
        residue = {t: len(after[t]["created"]) for t in tables if after[t]["created"]}
        if residue:
            out("RESIDUE: %d row(s) created since the snapshot remain (a restore never deletes): %s"
                % (sum(residue.values()), ", ".join("%s %d" % kv for kv in sorted(residue.items()))))
        missing = storage_missing(db, snap, rows, tables, ops)
        for m in missing:
            out("  STORAGE MISSING: %s" % m)
        out("STORAGE CHECK: %s" % ("every document object resolves" if not missing else
                                   "%d document object(s) missing — the rows are back, the files are not"
                                   % len(missing)))
        return 0 if not bad and not missing else 1
    finally:
        close = getattr(client, "close", None)
        if close:
            close()


if __name__ == "__main__":
    sys.exit(main())
