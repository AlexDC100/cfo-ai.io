#!/usr/bin/env python3
"""CHAT-CAP-REAL GATE — the Ask CFO AI Edge Function, the file that is
deployed, against the REAL auth server, the REAL plan row and the REAL
metering functions of the LOCAL Supabase stack.

WHY THIS EXISTS
===============
Owner, 2026-10-03: "Fix the chat function so it enforces its cap on every
call, signed in or not, and deploy it. Only after that will I add the
Anthropic key."

CLAUDE.md, Milestone D, had said since July: "the cap-reject path
(`reserve_user_chat` returning `daily_cap_reached`/`monthly_cap_reached`) has
only been read-reviewed against the SQL signatures, not exercised against a
real capped user." The vitest laws (frontend/lib/__tests__/chatLlm*.test.ts)
hold the DECISION with injected dependencies; they cannot see the Deno wiring
(index.ts: supabase-js, the RPC payloads, the fetch) or the SQL. This gate
runs exactly those.

WHAT IT RUNS
============
  A. THE SQL IS THIS REPOSITORY'S. The stack's three chat functions are
     compared, body for body, with supabase/schema_phase_pricing_v3_atomic.sql
     (nothing is applied to the stack — it is shared; a stack whose functions
     differ FAILS here instead of being quietly "fixed"). Their EXECUTE grant
     is service_role's only.
  P. THE PREFLIGHT REPORT the coordinator runs on production before the
     deploy (supabase/preflight/chat_cap_always_preflight_report.sql): it is
     ONE read-only statement; its three md5 literals are this repository's
     function bodies; on the stack it says ready; on a database with none of
     the objects (the cluster's template1 — read, never written) it answers
     "ready": false and names what is missing instead of erroring; it counts
     the users whose plan read would be ambiguous (two rows: the function
     refuses them) — none on this stack; and, read while this run's users,
     plan rows and counters are on the stack, its answer holds no user id and
     no e-mail address: counts only — counts that ARE the tables', with no
     reservation of this run left open. And what it says about the plan row
     and the two counter tables being closed to a browser's roles
     (`plan_and_counters_closed_to_browser_roles`) is held twice: to what a
     signed-in user of THIS stack could actually write (the driver tries every
     door), and — because one stack is one state — to a truth table of eleven
     shapes built in a SCRATCH database (a write policy, FOR ALL to public,
     row security off, production's stopgap shape, a column grant, a
     restrictive policy, another role's policy, a missing table).
  B. THE ENGINE, EXECUTED. The real `_plan_state.get_plan_state` (this
     checkout's src/, a stub standing only where the HTTP read would be)
     resolves a matrix of subscription rows; the driver holds the function's
     plans.ts to it row for row.
  C. THE DRIVER (scripts/chat_cap_real/driver.ts, under Deno, network
     restricted to 127.0.0.1): index.ts itself, served on a loopback port,
     with a RECORDER where the model would be — unauthenticated → 401 and no
     upstream request (no header, the anon key, a forged, an unsigned, an
     expired token, the real token of a user since deleted); a trial user's
     calls up to the cap served and counted; the next refused with the typed
     body and no upstream request; the monthly cap; a model failure released;
     two concurrent calls at cap − 1 and six concurrent first calls; the caps
     a default signup row / no row / tier 'pro' get; invalid requests; FAIL
     CLOSED with a meter, a plan row or an auth server the function cannot
     reach; the user at the cap trying to move their own counter through
     PostgREST; a token that was SERVED and then revoked (its user deleted, or
     signed out); a trial user who names a paying user in every field a
     request has; the plan row re-read on every call; the two signed-in
     checks of the deploy (a real session with an unsendable request; a real
     message while the key is dead); and an upstream that never answers — the
     function's own deadline aborts it and releases the reservation.

LOCAL ONLY, AND ONE STACK. The API is CHAT_CAP_API_URL (default
http://127.0.0.1:54321) and the database is the container
CHAT_CAP_DB_CONTAINER (default supabase_db_cfo-ai-test). A host that is not a
loopback address is REFUSED (exit 2) before anything is opened: this gate
creates users. So is an API that is not the gateway of the stack that
container belongs to (supabase_kong_<project>, or
CHAT_CAP_GATEWAY_CONTAINER): users created through one stack's API and
"removed" through another stack's database would stay where they were made
while the gate reported none left. Both refusals are cases of the gate
itself (W): it runs this file against a non-loopback name and against a
loopback port that is not the gateway, and expects exit 2 from each.

VACUOUS, never green, when the local stack or Deno is not there: it prints
`GATE-WORK chat-cap-real units=0` and exits 0; scripts/run_battery.py reports
that as PASS(VACUOUS).

It creates its own users (…@chat-gate.invalid) and removes them, their
workspaces and their counters on exit and at start. On the stack's own
database it never resets, drops or alters a table or a function, and applies
no migration. The preflight report is also run on the cluster's `template1` —
a read; nothing is created there — and in ONE scratch database this gate
creates from template0 and drops again (chat_gate_scratch_<run>): three empty
tables, policies built and rolled back inside a transaction per shape. No row
of anybody is in it.

NOTHING HERE CAN SPEND: the model upstream is a recorder in the driver's own
process; Deno is run with --allow-net=127.0.0.1, so no other host is
reachable; no production value is read (the keys are minted from the local
stack's own JWT secret and never printed).

Exit: 0 every case passed (or vacuous) · 1 a case failed · 2 refused.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

GATE = "chat-cap-real"
REPO = Path(__file__).resolve().parents[1]
FUNCTION = REPO / "supabase" / "functions" / "chat-llm" / "index.ts"
DRIVER = REPO / "scripts" / "chat_cap_real" / "driver.ts"
ATOMIC_SQL = REPO / "supabase" / "schema_phase_pricing_v3_atomic.sql"
PREFLIGHT = REPO / "supabase" / "preflight" / "chat_cap_always_preflight_report.sql"
API_URL = os.environ.get("CHAT_CAP_API_URL", "http://127.0.0.1:54321").rstrip("/")
CONTAINER = os.environ.get("CHAT_CAP_DB_CONTAINER", "supabase_db_cfo-ai-test")
GATEWAY = os.environ.get("CHAT_CAP_GATEWAY_CONTAINER") or (
    "supabase_kong_" + CONTAINER[len("supabase_db_"):] if CONTAINER.startswith("supabase_db_") else "")
SELFTEST = bool(os.environ.get("CHAT_CAP_SELFTEST"))
DOMAIN = "chat-gate.invalid"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
CHAT_FUNCTIONS = ("reserve_user_chat", "commit_user_chat", "release_user_chat")

units = 0
fails = 0


def passed(name: str) -> None:
    global units
    units += 1
    print("PASS %s" % name)


def failed(name: str, *why: str) -> None:
    global units, fails
    units += 1
    fails += 1
    print("FAIL %s" % name)
    for w in why:
        print("     | %s" % w)


def vacuous(why: str) -> "None":
    print("VACUOUS — %s" % why)
    print("The chat function was NOT run against the real metering functions on this")
    print("host. Start the local stack (supabase start), install Deno, and run this")
    print("gate again; this line is not a pass.")
    print("GATE-WORK %s units=0" % GATE)
    sys.exit(0)


def refuse(why: str) -> "None":
    print("REFUSED — %s" % why)
    print("GATE-WORK %s units=0" % GATE)
    sys.exit(2)


def psql(sql: str, database: str = "postgres") -> str:
    """One statement batch on the local stack's database (or a named one of
    its cluster), as the gate's setup / cleanup / catalog reader. Raises on a
    psql error."""
    out = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", database,
         "-X", "-At", "-q", "-v", "ON_ERROR_STOP=1"],
        input=sql, capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError("psql failed: %s" % (out.stderr.strip() or out.stdout.strip())[:400])
    return out.stdout.strip()


def psql_file(database: str, path: Path) -> str:
    """One FILE, as it is, on a database of the local cluster — the way the
    coordinator's `supabase db query -f` hands it to production: one batch."""
    out = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", database,
         "-X", "-At", "-q", "-v", "ON_ERROR_STOP=1"],
        input=path.read_text(encoding="utf-8"), capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError("psql failed: %s" % (out.stderr.strip() or out.stdout.strip())[:400])
    return out.stdout.strip()


# What a read-only report may not contain, anywhere outside its comments
# (the queries it hands to query_to_xml included).
_WRITES = re.compile(
    r"\b(insert|update|delete|truncate|merge|alter|create|drop|grant|revoke|notify|listen|lock|copy|call|do|"
    r"vacuum|analyze|refresh|reindex|cluster|comment|set|reset|begin|commit|rollback|prepare|"
    r"set_config|nextval|setval|pg_notify|pg_sleep|pg_advisory\w*|pg_terminate_backend|pg_cancel_backend|"
    r"pg_reload_conf|dblink\w*|lo_\w+)\b|\bfor\s+(update|share|no\s+key)\b|\binto\b",
    re.I,
)


def preflight_statement() -> str:
    """The report file without its `--` comments."""
    return "\n".join(line.split("--", 1)[0] for line in PREFLIGHT.read_text(encoding="utf-8").splitlines()).strip()


CLEANUP_SQL = """
do $$
declare
  v_users uuid[] := array(select id from auth.users where email like '%%@%(domain)s');
  v_orgs  uuid[] := array(select org_id from public.memberships where user_id = any(v_users));
begin
  if array_length(v_users, 1) is null then
    return;
  end if;
  delete from public.memberships where user_id = any(v_users);
  delete from public.organizations where id = any(v_orgs);
  if to_regclass('public.plan_chat_daily_usage') is not null then
    delete from public.plan_chat_daily_usage where user_id = any(v_users);
  end if;
  delete from public.user_usage where user_id = any(v_users);
  delete from public.subscriptions where user_id = any(v_users);
  delete from auth.users where id = any(v_users);
end
$$;
""" % {"domain": DOMAIN}


def cleanup() -> None:
    try:
        psql(CLEANUP_SQL)
    except Exception as e:  # noqa: BLE001
        print("WARNING — cleanup of the gate's own users failed: %s" % e)


def remove_memberless(org_ids: list) -> None:
    """The workspaces the driver named (`GATE-CLEANUP organization=<id>`):
    each belonged to a gate user the driver deleted through the auth server.
    Removed by id, and only while it has no member."""
    if not org_ids:
        return
    try:
        psql("delete from public.organizations o where o.id = any ('{%s}'::uuid[]) "
             "and not exists (select 1 from public.memberships m where m.org_id = o.id);" % ",".join(org_ids))
    except Exception as e:  # noqa: BLE001
        print("WARNING — cleanup of a deleted gate user's workspace failed: %s" % e)


def remove_rows_of_deleted(user_ids: list) -> None:
    """The users the driver named (`GATE-CLEANUP user=<id>`): each was a gate
    user the driver deleted through the auth server AFTER the function had
    served them, so their daily counter (no foreign key to the user) stayed.
    Removed by id, and only where no user with that id exists any more."""
    if not user_ids:
        return
    ids = ",".join(user_ids)
    try:
        psql("\n".join(
            "delete from public.%s c where c.user_id = any ('{%s}'::uuid[]) "
            "and not exists (select 1 from auth.users u where u.id = c.user_id);" % (table, ids)
            for table in ("plan_chat_daily_usage", "user_usage", "subscriptions")))
    except Exception as e:  # noqa: BLE001
        print("WARNING — cleanup of a deleted gate user's counter rows failed: %s" % e)


def rows_without_a_user() -> str:
    """How many plan / counter rows on the stack belong to no user."""
    return psql("select %s;" % " + ".join(
        "(select count(*) from public.%s c where not exists (select 1 from auth.users u where u.id = c.user_id))" % table
        for table in ("plan_chat_daily_usage", "user_usage", "subscriptions")))


# ── the scratch database: the report's row-write fact, shape by shape ──
SCRATCH_PREFIX = "chat_gate_scratch_"
SCRATCH_SETUP = """
create table public.subscriptions (user_id uuid primary key, tier text, plan text);
create table public.user_usage (user_id uuid not null, month text not null, llm_calls integer not null default 0,
                                llm_calls_reserved integer not null default 0, unique (user_id, month));
create table public.plan_chat_daily_usage (user_id uuid not null, day date not null, count integer not null default 0,
                                           reserved integer not null default 0, updated_at timestamptz not null default now(),
                                           primary key (user_id, day));
alter table public.subscriptions enable row level security;
alter table public.user_usage enable row level security;
alter table public.plan_chat_daily_usage enable row level security;
grant all on public.subscriptions, public.user_usage, public.plan_chat_daily_usage to anon, authenticated, service_role;
create policy "own select" on public.subscriptions for select using (true);
create policy "own select" on public.user_usage for select using (true);
create policy "own select" on public.plan_chat_daily_usage for select using (true);
"""
# (what a shape is, the SQL that makes it, closed?, the doors the report must name — exactly)
_WRITES3 = ("DELETE", "INSERT", "UPDATE")
SCRATCH_SHAPES = [
    ("row security on, a SELECT policy only, the default grants (the counters of a repository-built database)", "", True, []),
    ("an UPDATE policy on the plan row for authenticated (a user raises their own tier)",
     "create policy w on public.subscriptions for update to authenticated using (true);", False,
     ["authenticated may UPDATE public.subscriptions (policy w)"]),
    ("a policy FOR ALL to public on the daily counter",
     "create policy every on public.plan_chat_daily_usage for all using (true) with check (true);", False,
     ["%s may %s public.plan_chat_daily_usage (policy every)" % (r, c) for r in ("anon", "authenticated") for c in _WRITES3]),
    ("row security switched OFF on the monthly counter",
     "alter table public.user_usage disable row level security;", False,
     ["%s may %s public.user_usage (row security is off)" % (r, c) for r in ("anon", "authenticated") for c in _WRITES3]),
    ("production's stopgap shape: the write policies still there, the three privileges revoked — a policy with no privilege is no door",
     "create policy i on public.subscriptions for insert with check (true); "
     "create policy u on public.subscriptions for update using (true); "
     "revoke insert, update, delete on public.subscriptions from anon, authenticated;", True, []),
    ("a COLUMN-level UPDATE grant on tier (the table-level one revoked), with a policy",
     "revoke update on public.subscriptions from anon, authenticated; "
     "grant update (tier) on public.subscriptions to authenticated; "
     "create policy u on public.subscriptions for update using (true);", False,
     ["authenticated may UPDATE public.subscriptions (policy u)"]),
    ("a RESTRICTIVE write policy alone: it admits nobody",
     "create policy r on public.subscriptions as restrictive for update using (true);", True, []),
    ("a write policy for service_role only: no browser role is in it",
     "create policy s on public.user_usage for all to service_role using (true) with check (true);", True, []),
    ("an INSERT policy for anon on the monthly counter",
     "create policy a on public.user_usage for insert to anon with check (true);", False,
     ["anon may INSERT public.user_usage (policy a)"]),
    ("a DELETE policy on the plan row for authenticated",
     "create policy d on public.subscriptions for delete to authenticated using (true);", False,
     ["authenticated may DELETE public.subscriptions (policy d)"]),
    ("one of the three tables is not there: it cannot say — null, not 'closed'",
     "drop table public.user_usage;", None, []),
]


def scratch_cases(run: str) -> None:
    """The report's `plan_and_counters_closed_to_browser_roles`, held to a
    truth table. Each shape is built inside a transaction in a scratch
    database, the report read in it, and the transaction rolled back."""
    name = SCRATCH_PREFIX + run
    label = "P. the report's plan_and_counters_closed_to_browser_roles, in a scratch database — %s"
    try:
        for stale in psql("select datname from pg_database where datname like '%s%%';" % SCRATCH_PREFIX).split():
            psql('drop database if exists "%s" with (force);' % stale)
        psql('create database "%s" template template0;' % name)
        psql(SCRATCH_SETUP, name)
    except Exception as e:  # noqa: BLE001
        failed(label % "the scratch database could be made", "%s: %s" % (type(e).__name__, e))
        try:
            psql('drop database if exists "%s" with (force);' % name)
        except Exception:  # noqa: BLE001
            pass
        return
    try:
        report = PREFLIGHT.read_text(encoding="utf-8")
        for what, shape, want_closed, want_doors in SCRATCH_SHAPES:
            try:
                rep = json.loads(psql("begin;\n%s\n%s\nrollback;" % (shape, report), name))
                got = [rep.get("plan_and_counters_closed_to_browser_roles", "(key missing)"), rep.get("browser_role_row_writes")]
                if got == [want_closed, want_doors]:
                    passed(label % what)
                else:
                    failed(label % what, "got:  %s" % json.dumps(got), "want: %s" % json.dumps([want_closed, want_doors]))
            except Exception as e:  # noqa: BLE001
                failed(label % what, "%s: %s" % (type(e).__name__, e))
    finally:
        try:
            psql('drop database if exists "%s" with (force);' % name)
        except Exception as e:  # noqa: BLE001
            print("WARNING — the scratch database %s could not be dropped: %s" % (name, e))


def scratch_databases() -> str:
    return psql("select count(*) from pg_database where datname like '%s%%';" % SCRATCH_PREFIX)


def remaining_users() -> str:
    return psql("select count(*) from auth.users where email like '%%@%s';" % DOMAIN)


def memberless_workspaces() -> str:
    """How many workspaces on the stack have no member. The signup trigger
    gives every user one; a gate user deleted without it would leave one more
    than there was."""
    return psql("select count(*) from public.organizations o where not exists "
                "(select 1 from public.memberships m where m.org_id = o.id);")


# ── B. the engine, executed ──────────────────────────────────────────────

TIERS = [None, "", "   ", "trial", "intro", "solo", "pro", "multi", "starter", "pro_legacy",
         "business", "professional", "professional_contact", " PRO ", "Multi", "enterprise",
         "owner", "toString", "__proto__"]
PLANS = [None, "", "professional", "solo", "starter", "nonsense"]


def engine_matrix() -> list:
    """What `_plan_state.get_plan_state` resolves for each row — the REAL
    function of THIS checkout, with a stub only where the HTTP read is."""
    for k in list(os.environ):
        if k.startswith("PRICING_"):
            del os.environ[k]  # the table's own numbers, on both sides
    os.environ.setdefault("VITE_SUPABASE_URL", "http://stub.invalid")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "stub")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    sys.path.insert(0, str(REPO / "src"))
    from engine.api import _plan_state  # noqa: WPS433

    assert Path(_plan_state.__file__).resolve().is_relative_to(REPO / "src"), (
        "the engine imported is not this checkout's: %s" % _plan_state.__file__)

    class _Client:
        def __init__(self, row):
            self.row = row

        def select(self, table, filters=None, single=False, **_kw):
            if table == "subscriptions":
                return [dict(self.row)] if self.row is not None else []
            return []

    class _Admin:
        def __init__(self, row):
            self.client = _Client(row)

        def __enter__(self):
            return self.client

        def __exit__(self, *_a):
            return False

    rows = [None] + [{"tier": t, "plan": p} for t in TIERS for p in PLANS]
    out = []
    reads = []
    real_admin = _plan_state._supabase.admin
    try:
        for row in rows:
            admin = _Admin(row)
            real_select = admin.client.select
            admin.client.select = lambda table, *a, _s=real_select, **k: (reads.append(table), _s(table, *a, **k))[1]
            _plan_state._supabase.admin = lambda admin=admin: admin
            state = _plan_state.get_plan_state("00000000-0000-4000-8000-000000000000")
            out.append({"row": row, "key": state.plan.key,
                        "daily": state.plan.chat.daily, "monthly": state.plan.chat.monthly})
    finally:
        _plan_state._supabase.admin = real_admin
    # get_plan_state swallows a failed read and answers "trial": a matrix that
    # is all trial, or a row the engine never read, is a broken run — not parity.
    asked = sum(1 for t in reads if t == "subscriptions")
    if asked != len(rows):
        raise RuntimeError("the engine read the plan row %d times for %d rows — the stub is not where its read is" % (asked, len(rows)))
    keys = sorted({m["key"] for m in out})
    if len(keys) < 5:
        raise RuntimeError("the engine resolved every row to %s — its plan read failed and degraded to trial" % keys)
    return out


def main() -> int:
    global units, fails
    print("CHAT-CAP-REAL GATE — supabase/functions/chat-llm/index.ts on the local stack, the real RPCs, a recorder for the model")

    # ── local only ──
    parts = urlsplit(API_URL)
    host = parts.hostname or ""
    if parts.scheme != "http" or host not in LOOPBACK:
        refuse("CHAT_CAP_API_URL names '%s'. This gate creates users and runs against a "
               "loopback stack only (http://127.0.0.1, localhost, ::1)." % API_URL)
    port = parts.port or 80

    # ── is everything there? ──
    deno = shutil.which("deno")
    if not deno:
        vacuous("no `deno` on this host (the function is run under Deno, as it is deployed)")
    if not shutil.which("docker"):
        vacuous("no `docker` on this host (the local stack's database is reached through its container)")
    try:
        socket.create_connection((host, port), timeout=3).close()
    except OSError:
        vacuous("nothing is listening on %s:%s (the local Supabase stack is not running)" % (host, port))
    try:
        ports = subprocess.run(["docker", "port", CONTAINER, "5432/tcp"], capture_output=True, text=True, timeout=20)
    except Exception:  # noqa: BLE001
        ports = None
    if ports is None or ports.returncode != 0 or not ports.stdout.strip():
        vacuous("the database container '%s' is not running" % CONTAINER)
    for line in ports.stdout.strip().splitlines():
        bind = line.rsplit(":", 1)[0].strip("[]")
        if bind not in ("127.0.0.1", "0.0.0.0", "::", "::1"):
            refuse("the container '%s' publishes its database on '%s' — not a local stack" % (CONTAINER, bind))
    db_port = ports.stdout.strip().splitlines()[0].rsplit(":", 1)[1].strip()

    # ── one stack: the API is the gateway of the stack this database belongs to ──
    if not GATEWAY:
        refuse("'%s' is not a supabase_db_<project> container, so its gateway cannot be named: "
               "set CHAT_CAP_GATEWAY_CONTAINER" % CONTAINER)
    try:
        gw = subprocess.run(["docker", "port", GATEWAY, "8000/tcp"], capture_output=True, text=True, timeout=20)
    except Exception:  # noqa: BLE001
        gw = None
    if gw is None or gw.returncode != 0 or not gw.stdout.strip():
        vacuous("the gateway container '%s' is not running" % GATEWAY)
    published = sorted({line.rsplit(":", 1)[1].strip() for line in gw.stdout.strip().splitlines()})
    if str(port) not in published:
        refuse("CHAT_CAP_API_URL names port %s, but the gateway of the stack whose database is '%s' publishes %s. "
               "This gate creates users through the API and removes them through that database — one stack, not two."
               % (port, CONTAINER, ", ".join(published)))
    if SELFTEST:
        # A child run of W below: everything that refuses is above this line.
        print("SELFTEST — '%s' was NOT refused" % API_URL)
        print("GATE-WORK %s units=0" % GATE)
        return 0
    try:
        have = psql("select to_regclass('public.subscriptions') is not null and "
                    "to_regclass('public.user_usage') is not null and "
                    "to_regclass('public.plan_chat_daily_usage') is not null;")
        secret = psql("select coalesce(current_setting('app.settings.jwt_secret', true), '');").splitlines()[0:1]
    except Exception as e:  # noqa: BLE001
        vacuous("the local database could not be read (%s)" % e)
    if have != "t":
        vacuous("the local stack has no pricing schema (subscriptions / user_usage / plan_chat_daily_usage) — "
                "apply the repository's SQL to it first")
    jwt_secret = secret[0] if secret else ""
    if not jwt_secret:
        vacuous("the stack does not expose app.settings.jwt_secret (the gate mints its keys from it)")
    for f in (FUNCTION, DRIVER, ATOMIC_SQL, PREFLIGHT):
        if not f.is_file():
            failed("the file exists — %s" % f.relative_to(REPO))
            print("GATE-WORK %s units=%d" % (GATE, units))
            return 1

    # ── W. the wrapper refuses what it must (this file, run as a child) ──
    for label, url, needle in (
        ("W. this gate REFUSES an API that is not a loopback address (exit 2, before anything is opened)",
         "http://stack.%s:%s" % (DOMAIN, port), "loopback"),
        ("W. this gate REFUSES a loopback API that is not this stack's gateway (exit 2, before a user is created)",
         "http://127.0.0.1:%s" % db_port, "one stack, not two"),
    ):
        try:
            child = subprocess.run([sys.executable, str(Path(__file__).resolve())],
                                   env=dict(os.environ, CHAT_CAP_API_URL=url, CHAT_CAP_SELFTEST="1"),
                                   capture_output=True, text=True, timeout=60)
            if child.returncode == 2 and "REFUSED" in child.stdout and needle in child.stdout:
                passed(label)
            else:
                failed(label, "exit %s for CHAT_CAP_API_URL=%s" % (child.returncode, url),
                       *[ln for ln in child.stdout.strip().splitlines()[-3:]])
        except Exception as e:  # noqa: BLE001
            failed(label, "%s: %s" % (type(e).__name__, e))

    # ── A. the SQL on the stack is this repository's ──
    sql_text = ATOMIC_SQL.read_text(encoding="utf-8")
    for name in CHAT_FUNCTIONS:
        m = re.search(r"create or replace function %s\(.*?\nas \$\$(.*?)\$\$;" % name, sql_text, re.S)
        if not m:
            failed("A. %s is defined in %s" % (name, ATOMIC_SQL.name))
            continue
        want = hashlib.md5(m.group(1).encode("utf-8")).hexdigest()
        got = psql("select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
                   "where n.nspname = 'public' and p.proname = '%s';" % name)
        if got == want:
            passed("A. the stack's %s is this repository's, body for body" % name)
        else:
            failed("A. the stack's %s is this repository's, body for body" % name,
                   "md5 on the stack: %s" % (got or "(no such function)"), "md5 in %s: %s" % (ATOMIC_SQL.name, want),
                   "the stack is shared: this gate does not re-apply the migration")
    # …and the repository's own file hands them to service_role alone.
    file_ok = all(
        re.search(r"revoke all on function %s\([^)]*\)\s+from public, anon, authenticated;" % n, sql_text)
        and re.search(r"grant execute on function %s\([^)]*\)\s+to service_role;" % n, sql_text)
        and not re.search(r"grant\s+[^;]*on function %s\([^)]*\)\s+to\s+(?!service_role)" % n, sql_text)
        for n in CHAT_FUNCTIONS)
    if file_ok:
        passed("A. %s revokes the three functions from public, anon and authenticated and grants them to service_role only" % ATOMIC_SQL.name)
    else:
        failed("A. %s revokes the three functions from public, anon and authenticated and grants them to service_role only" % ATOMIC_SQL.name)
    grants = psql("select string_agg(distinct routine_name || ':' || grantee, ' ' order by routine_name || ':' || grantee) "
                  "from information_schema.routine_privileges where routine_schema = 'public' "
                  "and routine_name in ('reserve_user_chat','commit_user_chat','release_user_chat') "
                  "and grantee in ('anon','authenticated','PUBLIC','service_role');")
    want_grants = " ".join(sorted("%s:service_role" % n for n in CHAT_FUNCTIONS))
    if grants == want_grants:
        passed("A. CONTROL (the stack's catalog): the three functions are executable by service_role and by no API role a browser holds")
    else:
        failed("A. CONTROL (the stack's catalog): the three functions are executable by service_role and by no API role a browser holds",
               "got:  %s" % grants, "want: %s" % want_grants)

    # ── P. the preflight report the coordinator runs on production ──
    stmt = preflight_statement()
    found = sorted({m.group(0).lower() for m in _WRITES.finditer(stmt)})
    one = stmt.count(";") == 1 and stmt.endswith(";") and stmt[:4].lower() == "with"
    name = "P. %s is ONE statement and reads only: nothing in it writes, locks, sets or notifies" % PREFLIGHT.name
    if one and not found:
        passed(name)
    else:
        failed(name, "statements (';'): %d, ends with ';': %s, starts with WITH: %s" % (stmt.count(";"), stmt.endswith(";"), stmt[:4].lower() == "with"),
               "write / lock / set tokens found: %s" % (found or "none"))
    literals = {n: (re.search(r"\('%s',\s*'public\.%s\([^']*\)',\s*array\[[^\]]*\],\s*'([0-9a-f]{32})'\)" % (n, n), stmt) or [None, None])[1]
                for n in CHAT_FUNCTIONS}
    wanted = {}
    for n in CHAT_FUNCTIONS:
        m = re.search(r"create or replace function %s\(.*?\nas \$\$(.*?)\$\$;" % n, sql_text, re.S)
        wanted[n] = hashlib.md5(m.group(1).encode("utf-8")).hexdigest() if m else "(not defined)"
    name = "P. the report's three md5 literals are the function bodies in %s" % ATOMIC_SQL.name
    if literals == wanted:
        passed(name)
    else:
        failed(name, "in the report: %s" % literals, "in the SQL:    %s" % wanted)
    name = ("P. on the stack the report answers ready: true — nothing blocking, the bodies this repository's, the meter closed to the browser's roles, "
            "no user with two plan rows")
    try:
        rep = json.loads(psql_file("postgres", PREFLIGHT))
        subs = rep.get("subscriptions") or {}
        got = [rep.get("ready"), rep.get("blocking"), rep.get("functions_are_this_repository"), rep.get("meter_closed_to_browser_roles"),
               subs.get("users_with_more_than_one_row", "(key missing)")]
        if got == [True, [], True, True, 0]:
            passed(name)
        else:
            failed(name, "got:  %s" % json.dumps(got), "want: [true, [], true, true, 0]")
    except Exception as e:  # noqa: BLE001
        failed(name, "%s: %s" % (type(e).__name__, e))
    name = ("P. on a database with NONE of it (template1 — read, never written) the report answers ready: false "
            "and names the three functions and the three tables; it does not error")
    try:
        rep = json.loads(psql_file("template1", PREFLIGHT))
        blocking = rep.get("blocking") or []
        named = [any(n in b and "does not exist" in b for b in blocking)
                 for n in CHAT_FUNCTIONS + ("public.subscriptions", "public.user_usage", "public.plan_chat_daily_usage")]
        counts = rep.get("subscriptions") or {}
        if (rep.get("ready") is False and all(named) and rep.get("functions_are_this_repository") is False
                and counts.get("users_with_more_than_one_row", "(key missing)") is None):
            passed(name)
        else:
            failed(name, "ready: %s, functions_are_this_repository: %s" % (rep.get("ready"), rep.get("functions_are_this_repository")),
                   "blocking: %s" % json.dumps(blocking))
    except Exception as e:  # noqa: BLE001
        failed(name, "%s: %s" % (type(e).__name__, e))

    scratch_cases("%d_%d" % (int(time.time()), os.getpid()))

    # ── B. the engine's resolution, executed ──
    matrix_file = None
    try:
        matrix = engine_matrix()
        fd, matrix_file = tempfile.mkstemp(prefix="chat-cap-engine-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(matrix, fh)
        default_row = next(m for m in matrix if m["row"] == {"tier": None, "plan": "professional"})
        passed("B. the engine's get_plan_state, executed over %d subscription rows "
               "(the signup trigger's row → %s %s/%s)"
               % (len(matrix), default_row["key"], default_row["daily"], default_row["monthly"]))
    except Exception as e:  # noqa: BLE001
        failed("B. the engine's get_plan_state, executed over the row matrix",
               "%s: %s" % (type(e).__name__, e),
               "run this gate with the project's interpreter (the battery does): the engine must be importable")
        print("GATE-WORK %s units=%d" % (GATE, units))
        return 1

    # ── C. the driver ──
    cleanup()  # a previous run that died mid-way
    memberless_before = memberless_workspaces()
    userless_before = rows_without_a_user()
    env = {k: v for k, v in os.environ.items() if not k.startswith("PRICING_") and k != "USAGE_LIMITS_ENABLED"}
    env.update({
        "CHAT_CAP_API_URL": API_URL,
        "CHAT_CAP_JWT_SECRET": jwt_secret,
        "CHAT_CAP_RUN": "%d%d" % (int(time.time()), os.getpid()),
        "CHAT_CAP_FUNCTION": str(FUNCTION),
        "CHAT_CAP_ENGINE_MATRIX": matrix_file,
        # The function's `npm:` import resolves from Deno's own cache, as the
        # platform's bundler resolves it — not from this checkout's node_modules.
        "DENO_NO_PACKAGE_JSON": "1",
        "DENO_NO_UPDATE_CHECK": "1",
        "NO_COLOR": "1",
    })
    driver_units = None
    rc = 1
    orphaned = []
    deleted_users = []
    browser_writes = None
    try:
        proc = subprocess.run(
            [deno, "run", "--no-prompt", "--no-config", "--allow-net=127.0.0.1", "--allow-env",
             "--allow-read=%s,%s" % (REPO, matrix_file), str(DRIVER)],
            env=env, capture_output=True, text=True, timeout=240, cwd=tempfile.gettempdir(),
        )
        rc = proc.returncode
        for line in proc.stdout.splitlines():
            m = re.match(r"GATE-WORK %s units=(\d+)$" % re.escape(GATE), line)
            if m:
                driver_units = int(m.group(1))
                continue  # the wrapper prints the one total
            m = re.match(r"GATE-CLEANUP organization=([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$", line)
            if m:
                orphaned.append(m.group(1))
                continue
            m = re.match(r"GATE-CLEANUP user=([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$", line)
            if m:
                deleted_users.append(m.group(1))
                continue
            m = re.match(r"GATE-FACT browser_writes plan=(\d+) counters=(\d+)$", line)
            if m:
                browser_writes = (int(m.group(1)), int(m.group(2)))
                continue
            print(line)
        err = proc.stderr.strip()
        if os.environ.get("CHAT_CAP_SHOW_LOGS") and err:
            print("     | the function's own log (stderr), CHAT_CAP_SHOW_LOGS:")
            for line in err.splitlines():
                print("     | %s" % line[:300])
        elif rc != 0 and err:
            print("     | deno stderr (last lines):")
            for line in err.splitlines()[-12:]:
                print("     | %s" % line)
        # COUNTS ONLY. The report reads rows of tables that hold users, and
        # what it answers goes into the coordinator's notes. Read it NOW —
        # after the driver, before the cleanup — while this gate's users, their
        # plan rows and their counters are all on the stack: none of their ids
        # or addresses may appear in it.
        name = ("P. the report returns COUNTS, never a user: with this run's users, plan rows and counters on the stack, "
                "no user id and no e-mail address anywhere in its answer")
        try:
            raw = psql_file("postgres", PREFLIGHT)
            there = psql("select (select count(*) from auth.users where email like '%%@%s') || ' ' || "
                         "(select count(*) from public.subscriptions) || ' ' || (select count(*) from public.user_usage) || ' ' || "
                         "(select count(*) from public.plan_chat_daily_usage);" % DOMAIN).split()
            ids = re.findall(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", raw)
            mails = re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+", raw)
            if all(int(n) > 0 for n in there) and not ids and not mails:
                passed(name)
            else:
                failed(name, "on the stack now — gate users, plan rows, monthly counters, daily counters: %s (each must be > 0 for this law to mean anything)" % " ".join(there),
                       "user-id-shaped strings in the report: %d, e-mail-shaped: %d" % (len(ids), len(mails)))
        except Exception as e:  # noqa: BLE001
            failed(name, "%s: %s" % (type(e).__name__, e))
            raw = None
        # THE TRACE the coordinator reads after the deploy's signed-in checks:
        # the report's meter counts ARE the tables' (read here, directly), there
        # is at least one row for today — and after every call of this run,
        # served, refused, failed upstream or timed out, NOTHING of this run's
        # users is left reserved.
        name = ("P. the report's meter counts are the tables': rows for today exist, and no call of this run — served, refused, "
                "failed upstream, timed out — left a reservation open")
        try:
            got = (json.loads(raw).get("meter") or {}) if raw else {}
            direct = json.loads(psql(
                "select jsonb_build_object("
                "'daily', (select jsonb_build_object('users', count(*), 'messages_counted', coalesce(sum(\"count\"), 0), 'reservations_open', coalesce(sum(reserved), 0)) "
                "            from public.plan_chat_daily_usage where day = (now() at time zone 'utc')::date), "
                "'monthly', (select jsonb_build_object('users_with_a_message', count(*) filter (where llm_calls > 0), 'messages_counted', coalesce(sum(llm_calls), 0), "
                "            'reservations_open', coalesce(sum(llm_calls_reserved), 0)) from public.user_usage where month = to_char(now() at time zone 'utc', 'YYYY-MM')), "
                "'gate_open', (select coalesce(sum(c.reserved), 0) from public.plan_chat_daily_usage c join auth.users u on u.id = c.user_id where u.email like '%%@%s') "
                "           + (select coalesce(sum(c.llm_calls_reserved), 0) from public.user_usage c join auth.users u on u.id = c.user_id where u.email like '%%@%s'));"
                % (DOMAIN, DOMAIN)))
            same = got.get("daily_rows_today") == direct["daily"] and got.get("monthly_rows_this_month") == direct["monthly"]
            if same and direct["daily"]["users"] >= 1 and direct["gate_open"] == 0:
                passed(name)
            else:
                failed(name, "the report: %s" % json.dumps({k: got.get(k) for k in ("daily_rows_today", "monthly_rows_this_month")}),
                       "the tables: %s" % json.dumps({"daily": direct["daily"], "monthly": direct["monthly"]}),
                       "reservations of this run's users still open: %s" % direct["gate_open"])
        except Exception as e:  # noqa: BLE001
            failed(name, "%s: %s" % (type(e).__name__, e))
        # WHAT A BROWSER CAN WRITE. The function reads the plan row and the
        # counters through the service role and believes them. The driver's
        # signed-in user tried every door PostgREST has on the three tables;
        # the report must say what is true HERE — closed where nothing could
        # be written, open (naming the table) where something could.
        name = ("P. what the report says about the plan row and the counters IS what a signed-in user could write on this stack "
                "(%s)" % ("the driver did not report its measurement" if browser_writes is None else
                          "here: nothing — closed" if browser_writes == (0, 0) else
                          "here: the plan row %d write(s), the counters %d — open, and the report names the table" % browser_writes))
        try:
            rep_now = json.loads(raw) if raw else {}
            closed = rep_now.get("plan_and_counters_closed_to_browser_roles", "(key missing)")
            doors = rep_now.get("browser_role_row_writes") or []
            if browser_writes is None:
                failed(name, "no `GATE-FACT browser_writes` line from the driver")
            else:
                plan_open, counters_open = browser_writes[0] > 0, browser_writes[1] > 0
                named_plan = any(" public.subscriptions " in d for d in doors)
                named_counters = any(" public.user_usage " in d or " public.plan_chat_daily_usage " in d for d in doors)
                if closed is (not (plan_open or counters_open)) and (not plan_open or named_plan) and (not counters_open or named_counters):
                    passed(name)
                else:
                    failed(name, "the report: plan_and_counters_closed_to_browser_roles = %s, browser_role_row_writes = %s" % (json.dumps(closed), json.dumps(doors)),
                           "measured: rows a signed-in user wrote — plan row %d, counters %d" % browser_writes)
        except Exception as e:  # noqa: BLE001
            failed(name, "%s: %s" % (type(e).__name__, e))
    except subprocess.TimeoutExpired:
        failed("C. the driver finished within 240 s")
    finally:
        cleanup()
        remove_memberless(orphaned)
        remove_rows_of_deleted(deleted_users)
        if matrix_file:
            try:
                os.unlink(matrix_file)
            except OSError:
                pass

    if driver_units is None:
        failed("C. the driver reported its cases", "exit %s and no GATE-WORK line" % rc)
    else:
        units += driver_units
        if rc != 0:
            fails += 1

    left = remaining_users()
    memberless_after = memberless_workspaces()
    userless_after = rows_without_a_user()
    scratch_left = scratch_databases()
    name = ("Z. the gate left none of its users behind, no workspace without a member and no plan or counter row without a user "
            "that was not there before, and no scratch database")
    if left == "0" and memberless_after == memberless_before and userless_after == userless_before and scratch_left == "0":
        passed(name)
    else:
        failed(name,
               "%s user(s) @%s remain" % (left, DOMAIN),
               "workspaces without a member: %s before the run, %s after" % (memberless_before, memberless_after),
               "plan / counter rows without a user: %s before the run, %s after" % (userless_before, userless_after),
               "scratch databases left: %s" % scratch_left)

    print("")
    if fails == 0:
        print("PASS — %d cases." % units)
    else:
        print("FAIL — see the FAIL lines above.")
    print("GATE-WORK %s units=%d" % (GATE, units))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
