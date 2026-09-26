#!/usr/bin/env python3
"""The rollback of the workspace migration: undo EXACTLY the operations of
the plan that ran, nothing else.

    python3 scripts/db_restore.py SNAP.json.gz --plan PLAN.json            # dry-run (default)
    python3 scripts/db_restore.py SNAP.json.gz --plan PLAN.json --apply    # the rollback

    # the table-wide restore, an operator tool — see WHOLE TABLES below
    python3 scripts/db_restore.py SNAP.json.gz --whole-tables [--apply --tables migration]

PLAN-SCOPED UNDO (--plan). ``PLAN.json`` is the ``plan_<date>.json`` the
migration wrote and executed. Its operations are inverted in reverse
order (``rowstore.undo_ops``):

  * an ``update`` puts back the values the plan recorded before writing
    (its ``expect``), guarded by what it wrote (its ``set``): a row that
    still holds the plan's values is undone; one already at its pre-image
    is skipped; one holding NEITHER — something changed it since the run
    — is a CONFLICT, listed and never overwritten;
  * a ``merge_prefs`` takes exactly its keys out of the bag (the pre-image
    of those keys comes from the snapshot); every other key stays;
  * a workspace the plan inserted is archived (held: ``purge_after`` NULL —
    a later run brings the same id back, never deleted); an inserted
    membership has no archive column and stays (RESIDUE);
  * a storage copy is never deleted (RESIDUE);
  * a row the plan named that is GONE (hard-deleted since) comes back from
    the snapshot — the snapshot is the pre-image of exactly those keys.

Rows the plan did not name are never read for writing and never written:
a document uploaded after the run, a workspace its owner created, a
preference another user changed, a conversation's new title, a message —
all stay. The 8ff706e3 restore was a table-wide snapshot restore instead:
it trashed a user's post-run upload (leaving its period one hard delete
from erasure), archived a workspace the owner had created (held: listed
nowhere, no user recovery), reverted another user's preference and a
conversation's title, and printed "every snapshot row is back" (verifier
p2, 2026-09-26). The migration never creates documents, periods or chat
rows, so archiving "created since" rows in those tables could only ever
hit users' own data.

--apply refuses (exit 2, nothing written) while there are conflicts,
unless --leave-conflicts: then the conflicting rows are left as they are
and the exit is 1. After --apply the rows are re-read: UNDO CHECK is exact
when a second undo would find nothing to do; STORAGE CHECK verifies that
every document put back at its old path finds its object there (the
migration never deletes one, but a purge could have). Exit 0 only when
both hold.

WHOLE TABLES (--whole-tables). Every changed or vanished row of the named
tables is upserted back to its snapshot value; rows created since the
snapshot are ARCHIVED, never deleted (organizations: archived_at = now,
purge_after NULL; documents: deleted_at = now); an org_prefs row created
since for a workspace the snapshot had is put back to its EMPTY bag. This
touches USERS' data written after the snapshot: --apply refuses when any
row was created since the snapshot unless --i-accept-user-data-changes.
``--tables migration`` = every snapshot table except the billing ones
(user_usage, subscriptions, billing_events), which are only restored when
named. Missing storage objects are listed as STORAGE MISSING; with --apply
they make the exit 1.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence


def _add_src_to_path() -> None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "src" / "engine").is_dir():
            sys.path.insert(0, str(parent / "src"))
            return


_add_src_to_path()

from engine.workspaces import pgrest_io  # noqa: E402
from engine.workspaces.migration_plan import new_cascade_hazards  # noqa: E402
from engine.workspaces.rowstore import (  # noqa: E402
    canonical_json,
    pk_for,
    restore_diff,
    restore_ops,
    stamped_bags,
    undo_ops,
    undo_remaining,
)


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


def load_plan(path: str) -> Dict[str, Any]:
    """The executed plan, checked against its own ops digest."""
    plan = json.loads(Path(path).read_text())
    ops = plan.get("ops")
    if not isinstance(ops, list):
        raise SystemExit("%s is not a workspace_migration plan file (no ops)" % path)
    digest = hashlib.sha256(canonical_json(ops).encode("utf-8")).hexdigest()
    if plan.get("ops_sha256") and plan["ops_sha256"] != digest:
        raise SystemExit("%s: its operations hash to %s, the file says %s — not the plan that ran"
                         % (path, digest, plan["ops_sha256"]))
    plan["ops_sha256"] = digest
    return plan


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


def undone_objects_missing(db: Any, snap: Mapping[str, Any], plan_ops: Sequence[Mapping[str, Any]]) -> List[str]:
    """After an undo: every document the plan moved must find its object at
    the path it is back on. The snapshot's inventory says which objects
    existed then; a document it recorded missing is not required."""
    objects = snap.get("objects")
    out: List[str] = []
    for op in plan_ops:
        if op["op"] != "update" or op.get("table") != "documents" or "storage_path" not in (op.get("set") or {}):
            continue
        did = str(op["key"].get("id"))
        path = (op.get("expect") or {}).get("storage_path")
        if not path:
            continue
        recorded = (objects or {}).get(did, {}).get("exists") if objects is not None else None
        if recorded is False:
            continue
        org = (op.get("expect") or {}).get("org_id") or str(path).split("/", 1)[0]
        basis = "existed at the snapshot" if recorded else "no inventory record"
        try:
            ok = db.object_exists("documents", path, org_id=str(org))
        except Exception as exc:  # noqa: BLE001
            ok, basis = False, "%s; %s: %s" % (basis, type(exc).__name__, str(exc)[:120])
        if not ok:
            out.append("document %s -> %s (%s)" % (did, path, basis))
    return out


def _fmt_key(key: Mapping[str, Any]) -> str:
    return canonical_json(key)


def print_undo(undo: Mapping[str, Any], out=print, limit: int = 60) -> None:
    for op in undo["ops"][:limit]:
        if op["op"] == "upsert":
            pk = pk_for(op["table"])
            out("  re-insert %s %s (gone since the run; from the snapshot)"
                % (op["table"], _fmt_key({c: op["row"].get(c) for c in pk})))
            continue
        cols = ", ".join("%s: %s -> %s" % (c, canonical_json(op["expect"].get(c))[:50], canonical_json(v)[:50])
                         for c, v in sorted(op["set"].items()))
        out("  undo %s %s  %s" % (op["table"], _fmt_key(op["key"]), cols))
    if len(undo["ops"]) > limit:
        out("  ... %d more" % (len(undo["ops"]) - limit))
    for t, key, why in undo["undone"][:limit]:
        out("  done %s %s — %s" % (t, _fmt_key(key), why))
    for t, key, why in undo["skipped"]:
        out("  left %s %s — %s" % (t, _fmt_key(key), why))
    for t, key, why in undo["conflicts"]:
        out("  CONFLICT: %s %s — %s" % (t, _fmt_key(key), why))


def run_undo(db: pgrest_io.PgRest, snap: Mapping[str, Any], plan: Mapping[str, Any], *, apply: bool,
             leave_conflicts: bool, out: Callable[[str], None], now: Optional[str],
             json_path: Optional[str]) -> int:
    pks = pgrest_io.snapshot_pks(snap)
    rows = pgrest_io.snapshot_rows(snap)
    ops = plan["ops"]
    tables = sorted({op["table"] for op in ops if op["op"] != "copy_object"} & set(rows))
    unknown = sorted({op["table"] for op in ops if op["op"] != "copy_object"} - set(rows))
    if unknown:
        raise SystemExit("the plan names tables the snapshot does not have: %s" % ", ".join(unknown))
    current = pgrest_io.read_tables(db, tables, pks)
    undo = undo_ops(ops, current, rows, pks=pks)
    out("ROLLBACK %s of plan %s (%d operations, migration %s) against %s (snapshot %s)"
        % ("APPLY" if apply else "DRY-RUN", plan["ops_sha256"][:16], len(ops), plan.get("migration_date"),
           db.c.url, snap["created_at"]))
    print_undo(undo, out)
    out("UNDO: %d operation(s) to apply, %d row(s) already at their pre-image, %d re-inserted, %d conflict(s)"
        % (len(undo["ops"]), len(undo["undone"]), len(undo["reinserted"]), len(undo["conflicts"])))
    if json_path:
        Path(json_path).write_text(json.dumps(undo, indent=1, default=str, ensure_ascii=False))
    if not apply:
        for m in undone_objects_missing(db, snap, ops):
            out("  STORAGE MISSING: %s" % m)
        out("DRY-RUN: nothing written.")
        return 0
    if undo["conflicts"] and not leave_conflicts:
        out("REFUSED: %d row(s) the plan touched changed since the run (see CONFLICT above); nothing written. "
            "Resolve them, or --leave-conflicts to undo everything else and leave them as they are."
            % len(undo["conflicts"]))
        return 2
    run_ts = now or pgrest_io.utc_now_iso()
    done = pgrest_io.apply_live(db, undo["ops"], now=run_ts, pks=pks, log=out)
    out("applied=%d skipped=%d" % (done["applied"], done["skipped"]))
    after = pgrest_io.read_tables(db, tables, pks)
    remaining = undo_remaining(ops, after, rows, pks=pks)
    for line in remaining[:50]:
        out("  NOT UNDONE: %s" % line)
    out("UNDO CHECK: %s" % ("every row the plan touched is back at its pre-image" if not remaining
                            else "%d row(s) the plan touched are not at their pre-image" % len(remaining)))
    residue = undo["residue"]
    if residue:
        out("RESIDUE: %s (an undo never deletes)" % ", ".join("%s %d" % (k, v) for k, v in sorted(residue.items())))
    for pid, why in new_cascade_hazards(rows, after):
        out("  CASCADE HAZARD period %s: %s" % (pid, why))
    missing = undone_objects_missing(db, snap, ops)
    for m in missing:
        out("  STORAGE MISSING: %s" % m)
    out("STORAGE CHECK: %s" % ("every moved document finds its object at its old path" if not missing else
                               "%d document object(s) missing — the rows are back, the files are not"
                               % len(missing)))
    return 0 if not remaining and not missing else 1


def run_whole_tables(db: pgrest_io.PgRest, snap: Mapping[str, Any], *, apply: bool, tables_spec: Optional[str],
                     accept_user_data: bool, out: Callable[[str], None], now: Optional[str],
                     json_path: Optional[str]) -> int:
    names = list(snap["tables"])
    if apply and not tables_spec:
        raise SystemExit("--apply needs --tables (a comma list, 'migration' or 'all')")
    tables = _tables(tables_spec, names)
    pks = pgrest_io.snapshot_pks(snap)
    rows = pgrest_io.snapshot_rows(snap)
    current = pgrest_io.read_tables(db, tables, pks)
    diff = restore_diff(rows, current, pks=pks, tables=tables)
    out("RESTORE %s (whole tables) against %s (snapshot %s)" % ("APPLY" if apply else "DRY-RUN",
                                                                db.c.url, snap["created_at"]))
    n = print_diff(diff, out)
    if json_path:
        Path(json_path).write_text(json.dumps(diff, indent=1, default=str, ensure_ascii=False))
    created = {t: len(diff[t]["created"]) for t in tables if diff[t]["created"]}
    if not apply:
        for t, key, bag in stamped_bags(rows, current, pks=pks, tables=tables):
            out("  STAMPED: %s %s carries %s on a pre-existing workspace — --apply empties it"
                % (t, canonical_json(key), ", ".join(bag)))
        for m in storage_missing(db, snap, rows, tables, []):
            out("  STORAGE MISSING: %s" % m)
        if created:
            out("USER DATA: %d row(s) were created since the snapshot (%s) — --apply archives them and needs "
                "--i-accept-user-data-changes" % (sum(created.values()),
                                                  ", ".join("%s %d" % kv for kv in sorted(created.items()))))
        out("DRY-RUN: %d row(s) differ; nothing written." % n)
        return 0
    if created and not accept_user_data:
        out("REFUSED: %d row(s) were created since the snapshot (%s) — users' data; a whole-table restore "
            "would archive them. The rollback of a migration is --plan; to restore anyway, "
            "--i-accept-user-data-changes." % (sum(created.values()),
                                               ", ".join("%s %d" % kv for kv in sorted(created.items()))))
        return 2
    ops, notes = restore_ops(rows, current, pks=pks, tables=tables)
    for note in notes:
        out("  note: %s" % note)
    run_ts = now or pgrest_io.utc_now_iso()
    done = pgrest_io.apply_live(db, ops, now=run_ts, pks=pks, log=out)
    out("applied=%d skipped=%d" % (done["applied"], done["skipped"]))
    current_after = pgrest_io.read_tables(db, tables, pks)
    after = restore_diff(rows, current_after, pks=pks, tables=tables)
    bad = sum(len(after[t]["changed"]) + len(after[t]["missing"]) for t in tables)
    stamped = stamped_bags(rows, current_after, pks=pks, tables=tables)
    for t, key, bag in stamped:
        out("  STAMPED: %s %s still carries %s on a pre-existing workspace" % (t, canonical_json(key),
                                                                             ", ".join(bag)))
    out("RESTORE CHECK: %s" % (
        "every snapshot row is back" if not bad and not stamped else
        "; ".join(x for x in (
            "%d snapshot row(s) still differ" % bad if bad else "",
            "%d pre-existing workspace(s) still carry a row created since the snapshot" % len(stamped)
            if stamped else "") if x)))
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
    return 0 if not bad and not stamped and not missing else 1


def main(argv=None, *, client_factory: Optional[Callable[[], Any]] = None, out=print,
         now: Optional[str] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("snapshot")
    what = ap.add_mutually_exclusive_group()
    what.add_argument("--plan", help="the executed plan_<date>.json: undo exactly its operations (the rollback)")
    what.add_argument("--whole-tables", action="store_true",
                      help="table-wide restore to the snapshot (an operator tool, touches users' data)")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True)
    mode.add_argument("--apply", action="store_true")
    ap.add_argument("--tables", help="--whole-tables: comma list, 'migration' or 'all' (required with --apply)")
    ap.add_argument("--leave-conflicts", action="store_true",
                    help="--plan --apply: undo everything else although some rows changed since the run")
    ap.add_argument("--i-accept-user-data-changes", action="store_true",
                    help="--whole-tables --apply: archive rows users created since the snapshot")
    ap.add_argument("--json", help="also write the diff / the undo as JSON here")
    args = ap.parse_args(argv)
    if not args.plan and not args.whole_tables:
        raise SystemExit("name --plan PLAN.json (the rollback of a migration run: undoes exactly its operations) "
                         "or --whole-tables (the table-wide restore, an operator tool)")

    snap = pgrest_io.load_snapshot(args.snapshot)
    plan = load_plan(args.plan) if args.plan else None

    if client_factory is None:
        from engine.api import _supabase
        client_factory = _supabase.admin
    client = client_factory()
    try:
        db = pgrest_io.PgRest(client)
        if snap.get("source") and str(snap["source"]).rstrip("/") != str(client.url).rstrip("/"):
            out("SOURCE MISMATCH: the snapshot was taken from %s, this client writes to %s"
                % (snap["source"], client.url))
            if args.apply:
                out("REFUSED: a rollback from another database's snapshot never writes here.")
                return 2
        if plan is not None:
            return run_undo(db, snap, plan, apply=args.apply, leave_conflicts=args.leave_conflicts,
                            out=out, now=now, json_path=args.json)
        return run_whole_tables(db, snap, apply=args.apply, tables_spec=args.tables,
                                accept_user_data=args.i_accept_user_data_changes, out=out, now=now,
                                json_path=args.json)
    finally:
        close = getattr(client, "close", None)
        if close:
            close()


if __name__ == "__main__":
    sys.exit(main())
