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
  B. THE ENGINE, EXECUTED. The real `_plan_state.get_plan_state` (this
     checkout's src/, a stub standing only where the HTTP read would be)
     resolves a matrix of subscription rows; the driver holds the function's
     plans.ts to it row for row.
  C. THE DRIVER (scripts/chat_cap_real/driver.ts, under Deno, network
     restricted to 127.0.0.1): index.ts itself, served on a loopback port,
     with a RECORDER where the model would be — unauthenticated → 401 and no
     upstream request; a trial user's calls up to the cap served and counted;
     the next refused with the typed body and no upstream request; the
     monthly cap; a model failure released; two concurrent calls at cap − 1;
     the caps a default signup row / no row / tier 'pro' get; invalid
     requests; and FAIL CLOSED with a meter, a plan row or an auth server the
     function cannot reach.

LOCAL ONLY. The API is CHAT_CAP_API_URL (default http://127.0.0.1:54321) and
the database is the container CHAT_CAP_DB_CONTAINER (default
supabase_db_cfo-ai-test). A host that is not a loopback address is REFUSED
(exit 2) before anything is opened: this gate creates users.

VACUOUS, never green, when the local stack or Deno is not there: it prints
`GATE-WORK chat-cap-real units=0` and exits 0; scripts/run_battery.py reports
that as PASS(VACUOUS).

It creates its own users (…@chat-gate.invalid) and removes them, their
workspaces and their counters on exit and at start. It never resets, drops or
alters a table or a function, and applies no migration.

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
API_URL = os.environ.get("CHAT_CAP_API_URL", "http://127.0.0.1:54321").rstrip("/")
CONTAINER = os.environ.get("CHAT_CAP_DB_CONTAINER", "supabase_db_cfo-ai-test")
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


def psql(sql: str) -> str:
    """One statement batch on the local stack's database, as the gate's
    setup / cleanup / catalog reader. Raises on a psql error."""
    out = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres",
         "-X", "-At", "-q", "-v", "ON_ERROR_STOP=1"],
        input=sql, capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError("psql failed: %s" % (out.stderr.strip() or out.stdout.strip())[:400])
    return out.stdout.strip()


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


def remaining_users() -> str:
    return psql("select count(*) from auth.users where email like '%%@%s';" % DOMAIN)


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
    real_admin = _plan_state._supabase.admin
    try:
        for row in rows:
            _plan_state._supabase.admin = lambda row=row: _Admin(row)
            state = _plan_state.get_plan_state("00000000-0000-4000-8000-000000000000")
            out.append({"row": row, "key": state.plan.key,
                        "daily": state.plan.chat.daily, "monthly": state.plan.chat.monthly})
    finally:
        _plan_state._supabase.admin = real_admin
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
    for f in (FUNCTION, DRIVER, ATOMIC_SQL):
        if not f.is_file():
            failed("the file exists — %s" % f.relative_to(REPO))
            print("GATE-WORK %s units=%d" % (GATE, units))
            return 1

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
    grants = psql("select string_agg(distinct routine_name || ':' || grantee, ' ' order by routine_name || ':' || grantee) "
                  "from information_schema.routine_privileges where routine_schema = 'public' "
                  "and routine_name in ('reserve_user_chat','commit_user_chat','release_user_chat') "
                  "and grantee in ('anon','authenticated','PUBLIC','service_role');")
    want_grants = " ".join(sorted("%s:service_role" % n for n in CHAT_FUNCTIONS))
    if grants == want_grants:
        passed("A. the three functions are executable by service_role and by no API role a browser holds")
    else:
        failed("A. the three functions are executable by service_role and by no API role a browser holds",
               "got:  %s" % grants, "want: %s" % want_grants)

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
    except subprocess.TimeoutExpired:
        failed("C. the driver finished within 240 s")
    finally:
        cleanup()
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
    if left == "0":
        passed("Z. the gate left none of its users behind")
    else:
        failed("Z. the gate left none of its users behind", "%s user(s) @%s remain" % (left, DOMAIN))

    print("")
    if fails == 0:
        print("PASS — %d cases." % units)
    else:
        print("FAIL — see the FAIL lines above.")
    print("GATE-WORK %s units=%d" % (GATE, units))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
