#!/usr/bin/env python3
"""Every migration in supabase/ is applied in the database it points at.

WHY THIS EXISTS (2026-09-09). `schema_phase_notes_period_scope.sql` sat in
the repository, reviewed and committed, and was never run against
production. `alerts` therefore had no `period_id`, every narrative/alerts
upsert answered 409 Conflict, and narrative persistence had been failing
silently for as long as the file had existed. Nothing anywhere compared
the migrations in the repo to the schema in the database.

That is the same false-green class as a drift check that compares one
directory: the artefact exists, the deployment does not carry it, and
every check that ran answered a question narrower than the one it
appeared to answer.

WHAT IT VERIFIES, AND WHAT IT CANNOT. PostgREST exposes tables and
columns, so those are checked EXACTLY:

  · `create table if not exists X`          -> X must be reachable
  · `alter table X ... add column ... Y`    -> X.Y must select

Indexes, policies, constraints and functions are NOT visible through
PostgREST and are reported as UNVERIFIABLE — named, counted, and excluded
from the verdict rather than silently folded into it. A gate that
pretends to have checked something it cannot see is worse than one that
says so.

SCOPE IS PRINTED, ALWAYS. A check whose verdict does not name what it
examined invites being read as broader than it is — see
`check_deploy_drift.py`, which said IN SYNC over eight stale scripts
because it compared `src/` alone and never said so.

TWO MODES, because the migrations and the database are not reachable from
the same place. `supabase/` is NOT in the image (the Dockerfile does not
COPY it) and the service-role key is NOT on the deploy operator's laptop,
so a single-process check would have to pretend one of those is true.

    # on the machine holding the repo — parses, emits the objects to probe
    python3 scripts/check_migrations_applied.py --emit

    # end to end, from the repo, probing through the container
    python3 scripts/check_migrations_applied.py --emit \
      | ssh root@HOST 'docker exec -i cfo-ai-backend python3 /app/scripts/check_migrations_applied.py --probe'

Or, simplest, the one-liner the deploy runs:
    scripts/check_migrations_applied.sh
"""
from __future__ import annotations

import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "src"))
sys.path.insert(0, "/app/src")

MIGRATIONS_DIR = None
for _c in ("/app/supabase", os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "supabase")):
    if os.path.isdir(_c):
        MIGRATIONS_DIR = _c
        break

#: `create table if not exists <schema.>name (`
_CREATE_TABLE = re.compile(
    r"create\s+table\s+if\s+not\s+exists\s+(?:public\.)?([a-z_][a-z0-9_]*)",
    re.I)
#: `alter table <name> ... add column if not exists <col>` — the ALTER and
#: the ADD may be on different lines, so the table is tracked as we scan.
_ALTER_TABLE = re.compile(
    r"alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"
    r"([a-z_][a-z0-9_]*)", re.I)
#: SQL keywords a lazy `alter table (\w+)` will happily capture as a table
#: name. Measured: `do $$ begin if not exists (...) then alter table X ...`
#: yielded a table called "if", and eight of its columns were then probed
#: against a table that does not exist and never could.
_NOT_A_TABLE = frozenset({
    "if", "not", "exists", "then", "begin", "end", "select", "from",
    "where", "and", "or", "case", "when", "else", "declare", "return",
})
_ADD_COLUMN = re.compile(
    r"add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)", re.I)
#: Things PostgREST cannot see.
_UNVERIFIABLE = re.compile(
    r"create\s+(?:unique\s+)?index|create\s+policy|add\s+constraint|"
    r"create\s+or\s+replace\s+function|create\s+trigger", re.I)


#: Schema the repository declares that production DELIBERATELY does not
#: have, with the reason. Anything absent and NOT named here fails.
#:
#: This is a ratchet, not an amnesty: each entry is a claim someone made
#: in review, and the gate re-checks that the surface is still off. A
#: surface that goes live with its tables missing stops being declared
#: and starts being a failure — which is the case the `public_companies`
#: entry below is deliberately NOT given.
DECLARED_NOT_APPLIED = {
    # firm_cockpit is `hidden` in the production feature registry. The
    # whole firm schema is unbuilt there on purpose.
    "schema_phase_firm.sql":
        "firm_cockpit is hidden in production; the firm surface is unbuilt",
    "schema_phase_firm_requests.sql":
        "firm_cockpit is hidden in production; the file-request flow with it",
    # anomaly_radar is `hidden`; its routes are not even mounted.
    "schema_phase_radar.sql":
        "anomaly_radar is hidden in production and its router is not mounted",
    # The intelligence engine has no live surface today.
    "schema_phase_intelligence_engine.sql":
        "no live surface reads these; the intelligence wave has not shipped",
    # A one-off backfill snapshot column from F3.16-3b.5, never needed
    # after that backfill completed.
    "schema_phase_3b5_pre_backfill_snapshot.sql":
        "one-off backfill column; the backfill it guarded is finished",
    # Funnel attribution on profiles — the public funnel writes its own
    # store (engine.public_ro), not this column.
    "schema_phase_public_funnel.sql":
        "the public funnel writes engine.public_ro's own store, not profiles",
    "schema_phase_firm_attention.sql":
        "firm_cockpit is hidden; the attention board is part of that surface",
    # _dashboard.py is a complete feature whose router server.py never
    # mounts — documented in CLAUDE.md 16 as paused work, not dead code.
    # Its table is absent for the same reason its routes are.
    "schema_phase_dashboard_config.sql":
        "the dashboard-config router is not mounted in server.py (CLAUDE.md 16)",
}

#: NOT declared, and named here so the gate's output says why: the
#: `public_companies` surface is ACTIVE in production while the four
#: tables schema_phase_nasdaq_public_companies.sql declares are absent.
#: The surface serves from EDGAR/Sharadar live, so it works — which means
#: those tables are either dead design or a cache that silently degrades.
#: That is a product decision, not a deployment one, so this gate keeps
#: reporting it rather than quietly accepting it.


def _strip_sql_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def parse_migrations(directory):
    """{'tables': {name: [files]}, 'columns': {(t, c): [files]},
        'unverifiable': {file: count}} over every .sql in `directory`."""
    tables = defaultdict(list)
    columns = defaultdict(list)
    unverifiable = {}
    files = sorted(f for f in os.listdir(directory) if f.endswith(".sql"))
    for name in files:
        raw = _strip_sql_comments(
            open(os.path.join(directory, name), encoding="utf-8").read())
        for m in _CREATE_TABLE.finditer(raw):
            tables[m.group(1).lower()].append(name)
        # Walk statement by statement so an ADD COLUMN is attributed to the
        # ALTER TABLE that opened it, not to whichever table came first.
        current = None
        for token in re.split(r";", raw):
            at = _ALTER_TABLE.search(token)
            if at and at.group(1).lower() not in _NOT_A_TABLE:
                current = at.group(1).lower()
            if current:
                for c in _ADD_COLUMN.finditer(token):
                    columns[(current, c.group(1).lower())].append(name)
        n = len(_UNVERIFIABLE.findall(raw))
        if n:
            unverifiable[name] = n
    return {"tables": tables, "columns": columns,
            "unverifiable": unverifiable, "files": files}


def _emit():
    """Parse the repo's migrations and print the objects to probe, as JSON."""
    import json
    if not MIGRATIONS_DIR:
        sys.stderr.write("no supabase/ directory found\n")
        return 1
    parsed = parse_migrations(MIGRATIONS_DIR)
    json.dump({
        "dir": MIGRATIONS_DIR,
        "files": parsed["files"],
        "tables": {t: fs for t, fs in parsed["tables"].items()},
        "columns": {"%s.%s" % k: v for k, v in parsed["columns"].items()},
        "unverifiable": parsed["unverifiable"],
    }, sys.stdout)
    return 0


def main():
    if "--emit" in sys.argv:
        return _emit()
    print("MIGRATIONS APPLIED")
    print("=" * 62)
    if not MIGRATIONS_DIR and "--probe" not in sys.argv:
        print("  SKIPPED — no supabase/ directory reachable from here, and")
        print("  --probe was not given. Not a pass: the subject was not")
        print("  examined. Pipe the repo's declarations in with --emit.")
        return 0

    if "--probe" in sys.argv:
        import json
        payload = json.load(sys.stdin)
        parsed = {
            "files": payload.get("files") or [],
            "tables": {t: fs for t, fs in (payload.get("tables") or {}).items()},
            "columns": {tuple(k.rsplit(".", 1)): v
                        for k, v in (payload.get("columns") or {}).items()},
            "unverifiable": payload.get("unverifiable") or {},
        }
        source = payload.get("dir") or "(piped from the repo)"
    else:
        parsed = parse_migrations(MIGRATIONS_DIR)
        source = MIGRATIONS_DIR
    tables, columns = parsed["tables"], parsed["columns"]

    # SCOPE, PRINTED BEFORE THE VERDICT.
    print("  SCOPE — parsed from %s" % source)
    print("    migration files        %4d" % len(parsed["files"]))
    print("    tables declared        %4d" % len(tables))
    print("    columns added          %4d" % len(columns))
    print("    index/policy/function  %4d  (NOT visible through PostgREST —"
          % sum(parsed["unverifiable"].values()))
    print("                                 reported, never counted as pass)")
    print("")

    # TC-3: a census over nothing must not read as agreement.
    if not tables and not columns:
        print("  DISCOVERY BROKEN — parsed 0 tables and 0 columns from %d"
              " file(s)." % len(parsed["files"]))
        print("  The migration syntax changed and this parser no longer"
              " recognises it.")
        return 1

    try:
        from engine.api import _supabase
    except Exception as e:  # noqa: BLE001
        print("  SKIPPED — cannot reach the Supabase client (%s)." % type(e).__name__)
        print("  Not a pass: the subject was not examined.")
        return 0

    missing_tables, missing_columns, unreachable = [], [], []
    checked = 0
    with _supabase.admin() as ac:
        for table in sorted(tables):
            try:
                ac.select(table, columns="*", limit=1)
                checked += 1
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                if "PGRST205" in msg or "404" in msg or "does not exist" in msg:
                    missing_tables.append((table, tables[table]))
                else:
                    unreachable.append((table, type(e).__name__))
        for (table, col) in sorted(columns):
            if any(t == table for t, _f in missing_tables):
                continue  # the table itself is absent; do not double-report
            try:
                ac.select(table, columns=col, limit=1)
                checked += 1
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                if "400" in msg or "does not exist" in msg or "PGRST" in msg:
                    missing_columns.append((table, col, columns[(table, col)]))
                else:
                    unreachable.append(("%s.%s" % (table, col), type(e).__name__))

    print("-" * 62)
    print("  GATE-WORK migrations units=%d floor=1 label=schema-objects-probed"
          % checked)
    if unreachable:
        print("  %d object(s) could not be probed (transport, not absence):"
              % len(unreachable))
        for name, err in unreachable[:8]:
            print("      %-40s %s" % (name, err))

    def _declared(files):
        """The reason this absence is expected, if every file that declares
        it is declared. One undeclared declarer makes the whole absence
        undeclared — a table declared in two migrations, one of them live,
        is not excused by the other."""
        reasons = [DECLARED_NOT_APPLIED.get(f) for f in files]
        return reasons[0] if reasons and all(reasons) else None

    expected, unexpected = [], []
    for table, files in missing_tables:
        (expected if _declared(files) else unexpected).append(
            ("table", table, files, _declared(files)))
    for table, col, files in missing_columns:
        (expected if _declared(files) else unexpected).append(
            ("column", "%s.%s" % (table, col), files, _declared(files)))

    if expected:
        print("")
        print("  DECLARED ABSENT — %d object(s) the repo declares and this"
              " database deliberately does not have:" % len(expected))
        seen = set()
        for _kind, _name, files, reason in expected:
            for f in files:
                if f not in seen:
                    seen.add(f)
                    print("      %-44s %s" % (f, reason))

    if unexpected:
        print("")
        print("NOT APPLIED — the repository declares schema the database does"
              " not have, and nothing declares that gap:")
        for kind, name, files, _r in unexpected:
            print("  %-7s %-30s declared in %s"
                  % (kind, name, ", ".join(files)))
        print("")
        print("Apply it in Supabase Studio, then click Settings -> API ->")
        print("'Reload schema cache'. Per CLAUDE.md the NOTIFY at the bottom of")
        print("each migration is optimistic on Supabase; the Dashboard click is")
        print("the deterministic step.")
        print("")
        print("If an absence is deliberate, add its migration to")
        print("DECLARED_NOT_APPLIED in this file WITH THE REASON. An")
        print("undeclared gap is the whole defect this gate exists for.")
        return 1
    if expected and not unexpected:
        print("")
        print("APPLIED — every table and column the migrations declare is"
              " present, except %d deliberately absent and declared above."
              % len(expected))
        return 0

    print("")
    print("APPLIED — every table and column the migrations declare is present.")
    if parsed["unverifiable"]:
        print("  %d index/policy/constraint/function declaration(s) across %d"
              " file(s) were NOT verified — PostgREST cannot see them."
              % (sum(parsed["unverifiable"].values()), len(parsed["unverifiable"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
