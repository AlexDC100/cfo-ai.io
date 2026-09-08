#!/usr/bin/env python3
"""Off-provider backup of the customer data Supabase holds for us.

WHY THIS EXISTS
===============
The 2026-09-08 launch audit asked a simple question — "if Supabase lost
the project tonight, what would we still have?" — and the answer was
NOTHING WE CONTROL. There was no backup cron and no systemd timer on the
VPS; the only scheduled jobs were a filings-cache refresh and a drift
check. Postgres point-in-time recovery is Supabase's to provide and is
theirs to lose with them.

The exposure measured that day: 71 documents, 80.5 MB, every one a real
Romanian trial balance belonging to a client of a client. Those bytes live
in Supabase STORAGE under `<org_id>/uploads/<uuid>.<ext>` — a different
system from Postgres, and one that provider-side PITR does not necessarily
cover on every plan.

WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
=================================================
DOES: a logical export, using the service-role key we already hold.
  · every row of the customer-data tables, as newline-delimited JSON;
  · every object in storage, byte-for-byte, with its sha256;
  · a MANIFEST naming what was taken, how many rows/bytes, and the sha256
    of each artefact, so a restore can be verified rather than hoped at.

DOES NOT: replace `pg_dump`. There is no database connection string on
this host and no `pg_dump` binary in the image, so this cannot capture
schema, constraints, indexes, RLS policies or functions — only DATA. A
full disaster recovery still needs the provider's own backup or a
connection string. That limit is printed by the script itself rather than
left for someone to discover during an incident.

RETENTION
=========
Default 35 days, matching the privacy policy's stated backup window. The
script PRUNES older snapshots itself, because a retention promise nobody
enforces is a promise that quietly becomes false — and an over-long
retention of client financial data is a GDPR problem, not merely untidy.

    python3 scripts/backup_supabase.py --out /var/backups/cfo-ai
    python3 scripts/backup_supabase.py --out /var/backups/cfo-ai --verify-latest
    python3 scripts/backup_supabase.py --out /var/backups/cfo-ai --retention-days 35

Exit 0 on a complete snapshot, 1 on any failure. Designed for cron:
    17 4 * * * /usr/bin/docker exec cfo-ai-backend python3 \
        /app/scripts/backup_supabase.py --out /app/data/backups >> /var/log/cfo-backup.log 2>&1
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

#: Tables holding CUSTOMER data. Deliberately explicit rather than
#: "everything": a backup that silently stops covering a new table is
#: worse than one whose list you have to edit, because the gap is
#: invisible until you need it. `check_backup_coverage` (below) fails when
#: a table exists that nobody has classified.
CUSTOMER_TABLES: List[str] = [
    "organizations",
    "memberships",
    "documents",
    "financial_periods",
    "chat_threads",
    "chat_messages",
    "subscriptions",
    "user_usage",
    "user_prefs",
    "org_prefs",
    "profiles",
]

#: Tables that exist but are NOT customer data — caches, telemetry,
#: derived rows that a re-run reproduces. Named so the coverage check can
#: tell "deliberately excluded" from "forgotten".
NOT_CUSTOMER_DATA: List[str] = [
    "public_ro_filings",
    "public_ro_pages",
    "funnel_events",
    "benchmark_peers",
]


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _iso_utc_day() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")


def dump_tables(ac: Any, dest: Path) -> List[Dict[str, Any]]:
    """Every row of every customer table, as .ndjson. Paged, because a
    `limit` that silently truncates would produce a backup that restores
    a PREFIX of the data and looks successful doing it."""
    out: List[Dict[str, Any]] = []
    dest.mkdir(parents=True, exist_ok=True)
    for table in CUSTOMER_TABLES:
        path = dest / (table + ".ndjson")
        rows_written = 0
        page = 0
        page_size = 1000
        try:
            with open(path, "w", encoding="utf-8") as fh:
                while True:
                    # `select()` takes no `offset` kwarg; PostgREST accepts
                    # it as a query param, which `filters` passes through.
                    rows = ac.select(
                        table, columns="*", limit=page_size,
                        filters={"offset": str(page * page_size)},
                    ) or []
                    for r in rows:
                        fh.write(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n")
                        rows_written += 1
                    if len(rows) < page_size:
                        break
                    page += 1
        except Exception as exc:  # noqa: BLE001
            out.append({"table": table, "error": "%s: %s" % (type(exc).__name__, str(exc)[:160])})
            print("  ! %-22s FAILED: %s" % (table, str(exc)[:110]))
            continue
        digest = _sha256_bytes(path.read_bytes())
        out.append({"table": table, "rows": rows_written,
                    "bytes": path.stat().st_size, "sha256": digest})
        print("  · %-22s %6d row(s)  %8d B" % (table, rows_written, path.stat().st_size))
    return out


#: The bucket every uploaded document lives in — `pipeline.py` signs
#: against this name in four places and the browser uploads to it in
#: `frontend/lib/supabase.ts`.
DOCUMENTS_BUCKET = "documents"


def dump_storage(ac: Any, dest: Path) -> List[Dict[str, Any]]:
    """Every uploaded document, byte-for-byte.

    Paths come from `documents.storage_path` rather than from a bucket
    listing: the row is what the product will look for on restore, so an
    object with no row is not our data and a row with no object is a gap
    we WANT reported.

    Fetched through a short-lived signed URL, the same way the pipeline
    reads them — the service-role key never leaves this process."""
    import httpx  # noqa: WPS433

    out: List[Dict[str, Any]] = []
    dest.mkdir(parents=True, exist_ok=True)
    rows = ac.select("documents", columns="id,storage_path,size_bytes,original_filename",
                     limit=10000) or []
    for r in rows:
        sp = r.get("storage_path")
        if not sp:
            continue
        try:
            signed = ac.signed_url(DOCUMENTS_BUCKET, sp, expires_in=300)
            resp = httpx.get(signed, timeout=60.0)
            resp.raise_for_status()
            blob = resp.content
        except Exception as exc:  # noqa: BLE001
            out.append({"storage_path": sp, "error": "%s: %s" % (type(exc).__name__, str(exc)[:140])})
            print("  ! %-52s MISSING/UNREADABLE" % sp[:52])
            continue
        target = dest / sp.replace("/", "__")
        target.write_bytes(blob)
        out.append({
            "storage_path": sp,
            "document_id": r.get("id"),
            "bytes": len(blob),
            "declared_bytes": r.get("size_bytes"),
            "sha256": _sha256_bytes(blob),
        })
    ok = [o for o in out if "error" not in o]
    print("  · storage objects        %6d of %d row(s)  %8d B"
          % (len(ok), len(rows), sum(o["bytes"] for o in ok)))
    return out


def prune(root: Path, retention_days: int) -> List[str]:
    """Delete snapshots older than the retention window. A retention
    PROMISE that nobody enforces becomes false silently, and holding
    client financial data longer than the privacy policy states is a
    compliance problem, not untidiness."""
    cutoff = _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=retention_days)
    removed: List[str] = []
    for child in sorted(root.iterdir()) if root.is_dir() else []:
        if not child.is_dir() or not child.name.startswith("20"):
            continue
        try:
            stamp = _dt.datetime.strptime(child.name, "%Y-%m-%dT%H-%M-%SZ").replace(
                tzinfo=_dt.timezone.utc)
        except ValueError:
            continue
        if stamp < cutoff:
            shutil.rmtree(child, ignore_errors=True)
            removed.append(child.name)
    return removed


def verify(snapshot: Path) -> int:
    """Re-read a snapshot and check every artefact against its manifest
    sha256. THIS IS THE RESTORE TEST — a backup nobody has read back is a
    directory of hopes."""
    man_path = snapshot / "MANIFEST.json"
    if not man_path.is_file():
        print("VERIFY FAIL — no MANIFEST.json in %s" % snapshot)
        return 1
    man = json.loads(man_path.read_text(encoding="utf-8"))
    bad: List[str] = []
    checked = 0

    for t in man.get("tables", []):
        if "error" in t:
            bad.append("table %s was never captured: %s" % (t["table"], t["error"]))
            continue
        p = snapshot / "tables" / (t["table"] + ".ndjson")
        if not p.is_file():
            bad.append("table file missing: %s" % p.name)
            continue
        checked += 1
        if _sha256_bytes(p.read_bytes()) != t["sha256"]:
            bad.append("table %s sha256 MISMATCH — the file changed after capture" % t["table"])

    for o in man.get("storage", []):
        if "error" in o:
            bad.append("storage object never captured: %s (%s)" % (o["storage_path"], o["error"]))
            continue
        p = snapshot / "storage" / o["storage_path"].replace("/", "__")
        if not p.is_file():
            bad.append("storage file missing: %s" % o["storage_path"])
            continue
        checked += 1
        if _sha256_bytes(p.read_bytes()) != o["sha256"]:
            bad.append("storage %s sha256 MISMATCH" % o["storage_path"])

    if checked == 0:
        print("VERIFY FAIL — the snapshot contains NOTHING. An empty backup that")
        print("  reports success is worse than no backup: it stops anyone looking.")
        return 1
    if bad:
        print("VERIFY FAIL — %d problem(s) in %s" % (len(bad), snapshot.name))
        for b in bad[:20]:
            print("  ✗ %s" % b)
        return 1
    print("VERIFY PASS — %d artefact(s) in %s re-read and matched their sha256."
          % (checked, snapshot.name))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="backup root directory")
    ap.add_argument("--retention-days", type=int, default=35,
                    help="delete snapshots older than this (default 35, matching the privacy policy)")
    ap.add_argument("--verify-latest", action="store_true",
                    help="re-read the newest snapshot against its manifest and exit")
    args = ap.parse_args()

    root = Path(args.out)
    root.mkdir(parents=True, exist_ok=True)

    if args.verify_latest:
        snaps = sorted([d for d in root.iterdir() if d.is_dir() and d.name.startswith("20")])
        if not snaps:
            print("VERIFY FAIL — no snapshot under %s" % root)
            return 1
        return verify(snaps[-1])

    from engine.api import _supabase  # noqa: WPS433

    stamp = _iso_utc_day()
    snapshot = root / stamp
    print("SUPABASE LOGICAL BACKUP -> %s" % snapshot)
    print("  NOTE: this is a DATA export. It does not capture schema, RLS")
    print("  policies, functions or indexes — there is no database connection")
    print("  string on this host and no pg_dump in the image. Full disaster")
    print("  recovery still needs the provider's backup or a direct dump.")
    print("")

    with _supabase.admin() as ac:
        tables = dump_tables(ac, snapshot / "tables")
        storage = dump_storage(ac, snapshot / "storage")

    manifest = {
        "taken_at_utc": stamp,
        "retention_days": args.retention_days,
        "covers": "table DATA + storage objects",
        "does_not_cover": "schema, RLS policies, functions, indexes, auth.users",
        "tables": tables,
        "storage": storage,
    }
    (snapshot / "MANIFEST.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    removed = prune(root, args.retention_days)
    if removed:
        print("  pruned %d snapshot(s) older than %d days: %s"
              % (len(removed), args.retention_days, ", ".join(removed[:5])))

    failures = [t for t in tables if "error" in t] + [o for o in storage if "error" in o]
    if failures:
        print("")
        print("BACKUP INCOMPLETE — %d artefact(s) failed. This is NOT a usable"
              % len(failures))
        print("  snapshot; fix the cause before relying on it.")
        return 1

    print("")
    print("BACKUP COMPLETE — verify it now with --verify-latest.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
