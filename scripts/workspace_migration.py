#!/usr/bin/env python3
r"""One company per workspace — the migration of existing data.

    # 0. once, in Supabase Studio, each followed by Dashboard -> Settings -> API
    #    -> "Reload schema cache": the two hold guards (in this order)
    #      supabase/schema_phase_workspace_purge_now_hold.sql
    #      supabase/schema_phase_archive_hold_guard.sql
    #    (--execute refuses to create a held archive while either marker is
    #    missing from PostgREST's OpenAPI document. When the SQL can only be
    #    applied AFTER the run, --i-accept-missing-archive-guard executes
    #    anyway: a loud WARNING block heads and ends the run output naming
    #    the SQL still to apply, and until it is applied a held archive can
    #    be purged by a direct RPC call. Every run whose guard is missing
    #    ends with "SQL STILL TO APPLY: <files>".)
    # 1. snapshot (read-only)
    python3 scripts/db_snapshot.py --out /app/data/ws_migration/snap.json.gz
    # 2. plan (read-only; downloads documents to identify them, writes nothing
    #    to Supabase; the plan / facts / report land in --out-dir)
    python3 scripts/workspace_migration.py --snapshot /app/data/ws_migration/snap.json.gz \
        --known-identities /app/data/ws_migration/known_identities.json
    # 3. execute exactly the reviewed plan (--expect-plan-sha is required);
    #    the run ends with the RECOUNT (production equals the plan)
    python3 scripts/workspace_migration.py --execute --snapshot /app/data/ws_migration/snap.json.gz \
        --known-identities /app/data/ws_migration/known_identities.json --expect-plan-sha <sha>
    # 4. a re-run on a FRESH snapshot plans zero operations (NOTHING TO DO)
    # rollback: undo exactly that plan's own operations, never a row it did
    # not name (dry-run first; --apply then re-reads: UNDO CHECK, STORAGE CHECK)
    python3 scripts/db_restore.py /app/data/ws_migration/snap.json.gz \
        --plan /app/data/ws_migration/plan_<date>.json [--apply]

--dry-run (the default) identifies every stored document from its own bytes
(``engine.workspaces.company_identity``), plans the migration
(``engine.workspaces.migration_plan``), prints the plan as a table, writes
``plan_<date>.json``, ``facts_<date>.json`` and ``report_<date>.txt`` to
--out-dir, and writes NOTHING to production (GET requests only).

--execute refuses unless: the snapshot exists and ``db_snapshot --verify``
would call it EQUAL to production (no drift since the dry-run — override
only with --resume after an interrupted run), the recomputed plan's
operations hash equals --expect-plan-sha (REQUIRED: the plan is recomputed
at execute time, and a transient storage error during that recomputation
once dropped a copy from it — an un-reviewed plan never runs), and the
plan has no blocking item (a document mid-analysis, a document whose
object could not be read). It then applies the operations in order —
FIRST every storage copy of every user (idempotent: an object already at
its new path is skipped; a source gone or different by then stops the run
before any row has moved, for any user), then per user workspaces +
memberships + org_prefs, period-scoped rows, periods, documents,
re-dates, workspace archives, user_prefs — reading every row before
writing it (an op already in effect is skipped, so a re-run is a no-op; a
row in neither the planned-from nor the planned-to state stops the run). Finally it RE-READS production and compares every
row the plan touched, and every touched table's row count, with the plan's
expected post-state, and checks that every copied object holds the bytes
the plan read, that EVERY moved document's storage_path resolves, and
that every re-dated period's stored records (period_detection, the
detection envelope) say the row's date: exit 1 with the diff otherwise.
Rows the plan did not touch that changed meanwhile are reported as drift.

Never: a DELETE of a row or a storage object, a write to subscriptions /
user_usage / billing_events / auth, a Stripe or Anthropic call.

KNOWN IDENTITIES FILE (--known-identities). Operator-verified company
identities, layered over what each document's own bytes say. JSON:

    {"version": 2, "note": "...", "rules": [
      {"user_id": "<auth user uuid>",       REQUIRED: the rule applies to this
                                            user's documents only
       "content_sha256": "<64 hex>",        EXACTLY ONE OF: the bytes' sha256
       "filename_glob": "Balanta X_*",        (exact) / a case-insensitive
                                            fnmatch glob on original_filename
       "cui": "16070576" | null,            REQUIRED: digits ("RO" prefix
                                            accepted), must pass the control
                                            digit; null = a company with no
                                            known CUI, keyed by company_name
       "company_name": "X SRL",             required when cui is null; with a
                                            cui the registry's name wins
       "caen_code": "1013",                 optional; decides the industry the
                                            created workspace gets
       "evidence": "why the operator is sure"}]}

Per document: a content_sha256 rule beats a filename_glob rule; a CUI the
document itself prints beats any rule (a disagreeing rule is logged as a
conflict and not applied); a rule with cui null pins a name AND blocks a
registry name-match from handing the book a stranger's CUI. The file is
validated on load (unknown keys, a missing user_id, neither or both
matchers, a CUI failing its control digit, a null CUI without a name:
refused, naming the rule). It is operator data — real CUIs — never
committed; it lives beside the snapshot under /app/data/ws_migration/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence


def _add_src_to_path() -> None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "src" / "engine").is_dir():
            sys.path.insert(0, str(parent / "src"))
            return


_add_src_to_path()

from engine.workspaces import pgrest_io  # noqa: E402
from engine.workspaces.company_identity import normalize_cui  # noqa: E402
from engine.workspaces.migration_plan import (  # noqa: E402
    DocFacts,
    build_plan,
    cross_workspace_links,
    empty_live_periods,
    facts_from_documents,
    new_cascade_hazards,
    period_record_disagreements,
    redated_period_ids,
    render_report,
)
from engine.workspaces.rowstore import (  # noqa: E402
    NOW,
    apply_ops,
    canonical_json,
    pk_for,
    row_key,
    same_value,
)

DEFAULT_OUT_DIR = "/app/data/ws_migration"
PROTECTED_TABLES = frozenset({"subscriptions", "user_usage", "billing_events"})
#: Installed by supabase/schema_phase_workspace_purge_now_hold.sql, next to
#: the purge_workspace guard that refuses a HELD archive (archived,
#: purge_after NULL). Read from the OpenAPI document, never called.
HOLD_GUARD_RPC = "workspace_hold_guard_version"
#: Installed by supabase/schema_phase_archive_hold_guard.sql, next to the
#: archive_workspace guard (a held archive is never archived again with a
#: deletion date) and the restore_workspace guard (a held archive is not
#: restored by its owner). Read from the OpenAPI document, never called.
ARCHIVE_HOLD_GUARD_RPC = "workspace_archive_hold_guard_version"
#: The SQL that installs each guard — named in every run whose guard is
#: missing, and in the WARNING block of a run made without them.
PURGE_HOLD_SQL = "supabase/schema_phase_workspace_purge_now_hold.sql"
ARCHIVE_HOLD_SQL = "supabase/schema_phase_archive_hold_guard.sql"


def held_archives(ops: Sequence[Mapping[str, Any]]) -> int:
    """How many workspaces the plan archives with no deletion date (the
    holding archive, a split workspace) — each one "Delete forever" or one
    direct RPC call from erasure unless the hold guards are installed."""
    n = 0
    for op in ops:
        if op.get("table") != "organizations":
            continue
        vals = op.get("row") or op.get("set") or {}
        if vals.get("archived_at") == NOW and vals.get("purge_after") is None:
            n += 1
    return n


def archives_held_workspaces(ops: Sequence[Mapping[str, Any]]) -> bool:
    return held_archives(ops) > 0


def still_to_apply_line(missing_sql: Sequence[str]) -> str:
    return "SQL STILL TO APPLY: %s" % ", ".join(missing_sql)


def guard_warning_block(missing_sql: Sequence[str], held: int) -> List[str]:
    """The loud block that heads and ends a run made with
    --i-accept-missing-archive-guard while a hold guard is not installed."""
    bar = "#" * 78
    return [
        bar,
        "WARNING: HOLD GUARD(S) NOT INSTALLED — --i-accept-missing-archive-guard given, the run proceeds.",
        "  This plan archives %d workspace(s) with no deletion date (HELD). Until the SQL below is applied" % held,
        "  (Supabase Studio, then Dashboard -> Settings -> API -> \"Reload schema cache\"), a held archive can",
        "  be purged by a direct RPC call: purge_workspace() (\"Delete forever\") erases it, archive_workspace()",
        "  gives it the deletion date the cron purge keys on, restore_workspace() brings it back live — with",
        "  the archived periods and the ORIGINAL storage objects the rollback points documents back at.",
        "  " + still_to_apply_line(missing_sql),
        bar,
    ]


# ── identities ─────────────────────────────────────────────────────────

RULE_KEYS = frozenset({"user_id", "content_sha256", "filename_glob", "cui", "company_name", "caen_code",
                       "evidence"})


def load_known_identities(path: Optional[str]) -> List[Dict[str, Any]]:
    """The operator-verified identities (see KNOWN IDENTITIES FILE in the
    module docstring), validated: a rule that could never match, or that
    would name a company wrongly, is refused by index — never silently
    ignored."""
    if not path:
        return []
    raw = json.loads(Path(path).read_text())
    rules = raw.get("rules") if isinstance(raw, dict) else raw
    if not isinstance(rules, list):
        raise SystemExit('%s: expected {"rules": [...]} (or a bare list of rules)' % path)
    out: List[Dict[str, Any]] = []
    for i, r in enumerate(rules):
        where = "%s rule #%d" % (path, i)
        if not isinstance(r, dict):
            raise SystemExit("%s: not an object" % where)
        unknown = sorted(set(r) - RULE_KEYS)
        if unknown:
            raise SystemExit("%s: unknown key(s) %s — a misspelt key never matches anything (known: %s)"
                             % (where, unknown, sorted(RULE_KEYS)))
        if not str(r.get("user_id") or "").strip():
            raise SystemExit("%s: user_id is required — a rule applies to one user's documents only" % where)
        sha, glob = r.get("content_sha256"), r.get("filename_glob")
        if bool(sha) == bool(glob):
            raise SystemExit("%s: exactly one of content_sha256 / filename_glob" % where)
        if sha and not re.fullmatch(r"[0-9a-fA-F]{64}", str(sha)):
            raise SystemExit("%s: content_sha256 must be the 64 hex digits of the bytes' sha256" % where)
        if "cui" not in r:
            raise SystemExit("%s: cui is required — a digits string, or null for a company with no known CUI"
                             % where)
        if r["cui"] is not None and normalize_cui(r["cui"]) is None:
            raise SystemExit("%s: cui %r fails the control digit" % (where, r["cui"]))
        if r["cui"] is None and not str(r.get("company_name") or "").strip():
            raise SystemExit("%s: a rule with cui null must name the company (company_name)" % where)
        if r.get("caen_code") is not None and not re.fullmatch(r"\d{2,4}", str(r["caen_code"]).strip()):
            raise SystemExit("%s: caen_code must be 2 to 4 digits" % where)
        out.append(dict(r))
    return out


def open_registry(path: Optional[str], disabled: bool) -> Any:
    """The public RO company spine, or None. Never CREATED here: a missing
    file means no registry (PublicRoStore would otherwise make an empty one)."""
    if disabled:
        return None
    from engine.public_ro.store import PublicRoStore, default_db_path

    p = Path(path) if path else default_db_path()
    if not p.is_file():
        return None
    return PublicRoStore(p)


def compute_facts(db: pgrest_io.PgRest, tables: Mapping[str, List[Dict[str, Any]]], *,
                  registry: Any, rules: Sequence[Mapping[str, Any]], log: Callable[[str], None],
                  objects: Optional[Mapping[str, Mapping[str, Any]]] = None) -> Dict[str, DocFacts]:
    """Download every financial document (GET only) and identify it.
    ``objects`` is the snapshot's storage object inventory."""
    def fetch(d: Mapping[str, Any]):
        path = d.get("storage_path")
        if not path:
            return None, None, "no storage_path"
        try:
            content = db.download("documents", path, org_id=str(d["org_id"]))
        except Exception as exc:  # noqa: BLE001 — recorded; the planner decides
            return None, None, "%s: %s" % (type(exc).__name__, str(exc)[:200])
        if content is None:
            return None, False, "storage object missing"
        return content, True, None

    return facts_from_documents(tables, fetch, registry=registry, rules=rules,
                                log=lambda m: log("  " + m), objects=objects)


def moved_objects_missing(db: pgrest_io.PgRest, ops: Sequence[Mapping[str, Any]],
                          missing_sources: Iterable[str]) -> List[str]:
    """Every document the plan MOVED whose new ``storage_path`` does not
    resolve — not only the planned copies: a plan that lost a copy (a
    transient storage error in its facts pass) still moved the row, and the
    copy check alone said nothing (verifier p6, 2026-09-26). Documents whose
    source the snapshot recorded missing and the copy step found missing
    again (``missing_sources``) are the one exception — they never had a
    file to move."""
    exempt = set(missing_sources)
    sources = {op["document_id"]: op["from_path"] for op in ops if op["op"] == "copy_object"}
    out: List[str] = []
    for op in ops:
        if op["op"] != "update" or op.get("table") != "documents" or "storage_path" not in (op.get("set") or {}):
            continue
        did = str(op["key"].get("id"))
        path = op["set"]["storage_path"]
        if sources.get(did) in exempt:
            continue
        org = op["set"].get("org_id") or str(path).split("/", 1)[0]
        try:
            ok = db.object_exists("documents", path, org_id=str(org))
        except Exception as exc:  # noqa: BLE001 — a check that cannot answer is a failure
            ok = False
            out.append("storage %s: could not be checked for document %s (%s: %s)"
                       % (path, did, type(exc).__name__, str(exc)[:120]))
            continue
        if not ok:
            out.append("storage %s: the moved document %s points at a path with no object" % (path, did))
    return out


# ── the post-state check ───────────────────────────────────────────────

_NOW_MARK = "<<ws-migration-now>>"


def post_check(snapshot: Mapping[str, List[Dict[str, Any]]], current: Mapping[str, List[Dict[str, Any]]],
               ops: Sequence[Mapping[str, Any]], pks: Mapping[str, Sequence[str]]) -> Dict[str, Any]:
    """Compare production with the plan's expected post-state.

    Returns {"problems": [...], "drift": [...]} — problems are rows the plan
    touched that are not as planned, and row-count differences in tables the
    plan touched; drift is everything else that changed since the snapshot."""
    expected = apply_ops(snapshot, ops, now=_NOW_MARK, pks=pks, strict=False)
    touched: Dict[str, set] = {}
    inserted_cols: Dict[tuple, set] = {}
    for op in ops:
        if op["op"] == "copy_object":
            continue
        t = op["table"]
        pk = pk_for(t, pks)
        src = op.get("row") or op.get("key")
        key = row_key(src, pk)
        touched.setdefault(t, set()).add(key)
        if op["op"] == "insert":
            inserted_cols[(t, key)] = set(op["row"])
    problems: List[str] = []
    drift: List[str] = []
    for t in sorted(expected):
        pk = pk_for(t, pks)
        exp = {row_key(r, pk): r for r in expected[t]}
        cur = {row_key(r, pk): r for r in current.get(t) or []}
        snap = {row_key(r, pk): r for r in snapshot.get(t) or []}
        for key in sorted(touched.get(t, ())):
            want, got = exp.get(key), cur.get(key)
            if got is None:
                problems.append("%s %s: missing after the run" % (t, list(key)))
                continue
            cols = inserted_cols.get((t, key)) or (set(want) - {"updated_at"})
            bad = []
            for c in sorted(cols):
                w, g = want.get(c), got.get(c)
                if w == _NOW_MARK:
                    if g is None:
                        bad.append("%s: expected a timestamp, found NULL" % c)
                elif not same_value(g, w):
                    bad.append("%s: expected %s, found %s" % (c, canonical_json(w)[:80], canonical_json(g)[:80]))
            if bad:
                problems.append("%s %s: %s" % (t, list(key), "; ".join(bad)))
        if t in touched and len(exp) != len(cur):
            problems.append("%s: %d rows expected, %d found" % (t, len(exp), len(cur)))
        for key, row in cur.items():
            if key in touched.get(t, ()):
                continue
            before = snap.get(key)
            if before is None:
                drift.append("%s %s: created since the snapshot" % (t, list(key)))
            elif canonical_json({k: v for k, v in before.items() if k != "updated_at"}) != \
                    canonical_json({k: v for k, v in row.items() if k != "updated_at"}):
                drift.append("%s %s: changed since the snapshot (not by the migration)" % (t, list(key)))
        for key in snap:
            if key not in cur:
                (problems if t in touched else drift).append("%s %s: gone since the snapshot" % (t, list(key)))
    return {"problems": problems, "drift": drift}


def _same(a: Mapping[str, Any], b: Mapping[str, Any], cols: Optional[Sequence[str]] = None) -> bool:
    """Row equality ignoring updated_at; a column the plan stamps "$now"
    accepts any timestamp (an interrupted run wrote its own)."""
    names = cols if cols is not None else sorted((set(a) | set(b)) - {"updated_at"})
    for c in names:
        want, got = b.get(c), a.get(c)
        if want == _NOW_MARK:
            if got is None:
                return False
        elif not same_value(got, want):
            return False
    return True


def resume_drift(snapshot: Mapping[str, List[Dict[str, Any]]], current: Mapping[str, List[Dict[str, Any]]],
                 ops: Sequence[Mapping[str, Any]], pks: Mapping[str, Sequence[str]]) -> List[str]:
    """What --resume may NOT accept: every row that is neither its snapshot
    row nor a state the plan's own operations produce on the way to the
    post-state (an interrupted run stops anywhere in that sequence — a
    period moved but not yet re-dated is fine). A row the plan does not
    touch must be its snapshot row; a row gone is never acceptable (the
    migration deletes nothing)."""
    by_key: Dict[tuple, List[Mapping[str, Any]]] = {}
    for op in ops:
        if op["op"] == "copy_object":
            continue
        t = op["table"]
        by_key.setdefault((t, row_key(op.get("row") or op.get("key"), pk_for(t, pks))), []).append(op)
    bad: List[str] = []
    for t in sorted(set(snapshot) | set(current)):
        pk = pk_for(t, pks)
        snap = {row_key(r, pk): r for r in snapshot.get(t) or []}
        cur = {row_key(r, pk): r for r in current.get(t) or []}
        for key in sorted(set(snap) | set(cur)):
            got, before = cur.get(key), snap.get(key)
            plan_ops = by_key.get((t, key), [])
            if got is None:
                if before is not None:
                    bad.append("%s %s: gone since the snapshot" % (t, list(key)))
                continue   # a row the plan inserts, not inserted yet
            if before is not None and _same(got, before):
                continue
            states = []
            rows = [dict(before)] if before is not None else []
            inserted: Optional[List[str]] = None
            for op in plan_ops:
                if op["op"] == "insert":
                    inserted = sorted(op["row"])
                rows = apply_ops({t: rows}, [op], now=_NOW_MARK, pks=pks, strict=False)[t]
                if rows:
                    states.append(rows[0])
            # compared on the columns the plan's state names (as the
            # recount does): the database fills defaults (created_at …)
            # into rows the plan creates.
            if not any(_same(got, st, inserted if inserted else sorted(set(st) - {"updated_at"}))
                       for st in states):
                bad.append("%s %s: %s" % (t, list(key), "changed since the snapshot, not by this plan"
                                          if plan_ops else "changed since the snapshot (the plan does not touch it)"))
    return bad


# ── main ───────────────────────────────────────────────────────────────

def main(argv=None, *, client_factory: Optional[Callable[[], Any]] = None, out=print,
         now: Optional[str] = None, registry: Any = "open") -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True)
    mode.add_argument("--execute", action="store_true")
    ap.add_argument("--snapshot", help="db_snapshot.py file (required with --execute)")
    ap.add_argument("--known-identities", help="operator-verified identities JSON")
    ap.add_argument("--registry", help="public RO sqlite (default: the engine's own path, if present)")
    ap.add_argument("--no-registry", action="store_true")
    ap.add_argument("--migration-date", help="YYYY-MM-DD for the holding workspace name "
                                             "(default: the snapshot's date)")
    ap.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    ap.add_argument("--expect-plan-sha", help="the reviewed plan's ops sha256 (required with --execute): "
                                              "refuse unless the recomputed plan hashes to this")
    ap.add_argument("--keep-current-month-placeholder", action="store_true",
                    help="keep ONE source-less current-month period per workspace (rule 2). Only for a "
                         "production whose frontend still re-creates it; since the workspace redesign "
                         "(G4: no period without an analysed file) it is archived like any empty period")
    ap.add_argument("--resume", action="store_true",
                    help="execute although production drifted from the snapshot (an interrupted run)")
    ap.add_argument("--i-accept-missing-archive-guard", action="store_true",
                    help="execute although a hold guard is not installed: a loud WARNING heads and ends the run, "
                         "which proceeds; until the named SQL is applied a held archive can be purged by a "
                         "direct RPC call")
    args = ap.parse_args(argv)
    if args.execute and not args.snapshot:
        raise SystemExit("--execute needs --snapshot")
    if args.execute and not args.expect_plan_sha:
        raise SystemExit("--execute needs --expect-plan-sha <the reviewed plan's ops sha256> — the plan is "
                         "recomputed at execute time and only the reviewed one may run")

    if client_factory is None:
        from engine.api import _supabase
        client_factory = _supabase.admin
    client = client_factory()
    reg = open_registry(args.registry, args.no_registry) if registry == "open" else registry
    try:
        db = pgrest_io.PgRest(client)
        if args.snapshot:
            snap = pgrest_io.load_snapshot(args.snapshot)
        else:
            snap = pgrest_io.build_snapshot(db)  # in memory, GET only
        tables = pgrest_io.snapshot_rows(snap)
        pks = pgrest_io.snapshot_pks(snap)
        created = datetime.fromisoformat(str(snap["created_at"]).replace("Z", "+00:00"))
        date = args.migration_date or created.date().isoformat()
        stale_before = (created - timedelta(hours=1)).isoformat()

        if snap.get("source") and str(snap["source"]).rstrip("/") != str(client.url).rstrip("/"):
            out("SOURCE MISMATCH: the snapshot was taken from %s, this client writes to %s"
                % (snap["source"], client.url))
            if args.execute:
                out("REFUSED: a plan made from another database's snapshot never writes here.")
                return 2
        drifted = False
        if args.execute:
            result = pgrest_io.verify_snapshot(db, snap)
            bad = sorted(t for t, r in result.items() if not r["equal"])
            if bad:
                drifted = True
                out("DRIFT since the snapshot in: %s" % ", ".join(
                    "%s(changed=%d missing=%d created=%d)" % (t, result[t]["changed"], result[t]["missing"],
                                                              result[t]["created"]) for t in bad))
                if not args.resume:
                    out("REFUSED: production is not the snapshot the plan was made from. "
                        "Take a new snapshot and dry-run again (or --resume an interrupted run).")
                    return 2

        rules = load_known_identities(args.known_identities)
        objects = snap.get("objects")
        facts = compute_facts(db, tables, registry=reg, rules=rules, log=out, objects=objects)
        plan = build_plan(tables, facts, migration_date=date, pks=pks, stale_before=stale_before,
                          keep_current_month_placeholder=args.keep_current_month_placeholder,
                          objects=objects)
        report = render_report(plan)
        out(report)

        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / ("plan_%s.json" % date)).write_text(
            json.dumps(plan.to_dict(), indent=1, ensure_ascii=False, default=str))
        (out_dir / ("facts_%s.json" % date)).write_text(
            json.dumps({k: v.to_dict() for k, v in sorted(facts.items())}, indent=1,
                       ensure_ascii=False, default=str))
        (out_dir / ("report_%s.txt" % date)).write_text(report + "\n")
        out("PLAN: %d operations, sha256 %s -> %s" % (len(plan.ops), plan.ops_sha256(), out_dir))

        touched = {op.get("table") for op in plan.ops} & PROTECTED_TABLES
        if touched:  # structural guard; the planner never emits these
            out("REFUSED: the plan writes billing tables %s" % sorted(touched))
            return 2
        held = held_archives(plan.ops)
        missing_sql: List[str] = []
        if held and not db.has_rpc(HOLD_GUARD_RPC):
            missing_sql.append(PURGE_HOLD_SQL)
            out("HOLD GUARD MISSING: the plan archives workspaces with no deletion date, and "
                "purge_workspace() would let their owner erase them (and the originals the rollback "
                "needs). Apply %s, reload the schema cache, then execute." % PURGE_HOLD_SQL)
        if held and not db.has_rpc(ARCHIVE_HOLD_GUARD_RPC):
            missing_sql.append(ARCHIVE_HOLD_SQL)
            out("ARCHIVE HOLD GUARD MISSING: the plan archives workspaces with no deletion date, and "
                "archive_workspace() would give one a deletion date (the cron purge erases it 30 days "
                "later) while restore_workspace() would let its owner bring it back live. Apply "
                "%s, reload the schema cache, then execute." % ARCHIVE_HOLD_SQL)

        def trailer() -> None:
            """The final lines of every run whose guard is missing."""
            if missing_sql:
                if args.execute and args.i_accept_missing_archive_guard:
                    for line in guard_warning_block(missing_sql, held):
                        out(line)
                out(still_to_apply_line(missing_sql))

        if not args.execute:
            trailer()
            out("DRY-RUN: nothing was written to production.")
            return 0

        if args.expect_plan_sha != plan.ops_sha256():
            out("REFUSED: plan sha %s is not the reviewed %s" % (plan.ops_sha256(), args.expect_plan_sha))
            return 2
        if plan.blocking:
            out("REFUSED: %d blocking item(s) — see BLOCKING above" % len(plan.blocking))
            return 2
        if missing_sql and not args.i_accept_missing_archive_guard:
            if PURGE_HOLD_SQL in missing_sql:
                out("REFUSED: the purge_workspace hold guard is not installed (see HOLD GUARD MISSING).")
            else:
                out("REFUSED: the archive/restore hold guard is not installed (see ARCHIVE HOLD GUARD MISSING).")
            trailer()
            return 2
        if missing_sql:
            # Accepted explicitly: the loud block heads the run output …
            for line in guard_warning_block(missing_sql, held):
                out(line)
        if not plan.ops:
            out("NOTHING TO DO: the plan is empty (already migrated).")
            return 0
        if drifted:
            # --resume: production may differ from the snapshot ONLY by what
            # this plan's own operations wrote before the interruption.
            foreign = resume_drift(tables, pgrest_io.read_tables(db, list(tables), pks), plan.ops, pks)
            for line in foreign[:50]:
                out("  foreign drift: %s" % line)
            if foreign:
                out("REFUSED: %d row(s) changed since the snapshot by something other than this plan — "
                    "--resume only finishes an interrupted run. Take a new snapshot and dry-run again."
                    % len(foreign))
                return 2

        # ONE run timestamp per plan: an interrupted run's "$now" values are
        # already in production, so --resume reuses the timestamp recorded
        # before the first write instead of taking a fresh one.
        state_path = out_dir / ("run_state_%s.json" % plan.ops_sha256()[:16])
        run_ts = now or pgrest_io.utc_now_iso()
        if args.resume and state_path.is_file():
            state = json.loads(state_path.read_text())
            if state.get("plan_sha256") == plan.ops_sha256() and state.get("run_at"):
                run_ts = state["run_at"]
                out("RESUME: reusing the interrupted run's timestamp %s (%s)" % (run_ts, state_path))
        else:
            state_path.write_text(json.dumps({"plan_sha256": plan.ops_sha256(), "run_at": run_ts,
                                              "snapshot": args.snapshot}, indent=1))
        out("EXECUTE at %s%s" % (run_ts, " (resume)" if drifted else ""))
        done = pgrest_io.apply_live(db, plan.ops, now=run_ts, pks=pks, log=out)
        out("applied=%d skipped=%d copied=%d copy_skipped=%d missing_objects=%d" % (
            done["applied"], done["skipped"], done["copied"], done["copy_skipped"],
            len(done["missing_objects"])))

        current = pgrest_io.read_tables(db, list(tables), pks)
        check = post_check(tables, current, plan.ops, pks)
        # Every copy the plan made: the object is at its new path with the
        # bytes the plan read. Skipped only for a source that was missing
        # when planning AND when copying (no bytes were ever known).
        for op in plan.ops:
            if op["op"] != "copy_object":
                continue
            want = op.get("expect_sha256")
            if not want and op["from_path"] in done["missing_objects"]:
                continue
            got = db.download(op["bucket"], op["to_path"], org_id=op["to_org"])
            if got is None:
                check["problems"].append("storage %s: copy missing (document %s)"
                                         % (op["to_path"], op.get("document_id")))
            elif want and hashlib.sha256(got).hexdigest() != want:
                check["problems"].append("storage %s: copy holds sha256 %s, the plan read %s (document %s)"
                                         % (op["to_path"], hashlib.sha256(got).hexdigest()[:16], want[:16],
                                            op.get("document_id")))
        # Every MOVED document's path resolves — planned copy or not.
        check["problems"].extend(moved_objects_missing(db, plan.ops, done["missing_objects"]))
        g4 = empty_live_periods(current, current_month=date[:7] if args.keep_current_month_placeholder else None)
        links = cross_workspace_links(current)
        # A period whose source is trashed / in another workspace is one
        # "Clear all" or purge away from ON DELETE CASCADE. The run may not
        # leave one the snapshot did not already have.
        for pid, why in new_cascade_hazards(tables, current):
            check["problems"].append("CASCADE HAZARD period %s: %s" % (pid, why))
        # A re-dated period's stored records (period_detection, the §7
        # detection envelope) must say the row's date — whatever the plan
        # carried, this is the fact the mismatch chip and the attention
        # layer read after the run.
        for line in period_record_disagreements(current, period_ids=redated_period_ids(plan.ops)):
            check["problems"].append("RE-DATED %s" % line)
        run_log = {"run_at": run_ts, "plan_sha256": plan.ops_sha256(), "done": done,
                   "problems": check["problems"], "drift": check["drift"],
                   "g4_empty_live_periods": g4, "cross_workspace_links": links,
                   "sql_still_to_apply": missing_sql}
        (out_dir / ("run_%s.json" % run_ts.replace(":", "").replace("+", "_"))).write_text(
            json.dumps(run_log, indent=1, default=str))
        for d in check["drift"][:50]:
            out("  drift: %s" % d)
        for g in g4:
            out("  G4 (empty live period, outside the plan's reach): %s %s" % g)
        for p in check["problems"]:
            out("  MISMATCH: %s" % p)
        if check["problems"]:
            out("RECOUNT: FAILED — %d mismatch(es); rollback: db_restore.py %s --plan %s [--apply]"
                % (len(check["problems"]), args.snapshot, out_dir / ("plan_%s.json" % date)))
            trailer()   # … and ends it, whatever the verdict
            return 1
        out("RECOUNT: production equals the plan (%d drift line(s) outside it)" % len(check["drift"]))
        trailer()
        return 0
    finally:
        close = getattr(client, "close", None)
        if close:
            close()
        if registry == "open" and reg is not None:
            reg.close()


if __name__ == "__main__":
    sys.exit(main())
