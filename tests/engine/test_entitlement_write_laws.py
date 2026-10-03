"""ENTITLEMENT-WRITE LAWS — the plan row and the meters are written by the
service role, and by nothing a browser session can reach.

The incident (2026-10-03): ``supabase/schema.sql`` created an INSERT and an
UPDATE policy on a user's own ``public.subscriptions`` row and Supabase's
default grants let ``authenticated`` use them — a ``PATCH`` of
``{"tier": "multi", "status": "active"}`` from the browser was a paid plan
with no payment. ``frontend/lib/billing.ts`` still carried two writers of
that row (``cancel()``, ``reactivate()`` — the second wrote
``status: "active"``); neither had a caller.

``supabase/schema_phase_subscriptions_write_lockdown.sql`` closes the
database, and ``scripts/check_subscriptions_write_lockdown.sh`` proves it on
a local stack through real PostgREST. That gate is VACUOUS where no stack is
named, and it cannot see the SOURCE. These are the static laws for that half:

  A. THE LIST. It is written in the migration; the pre-flight report and the
     pre-flight grids carry the same names, and the same three kept policies.
  B. THE BROWSER. No file under ``frontend/``, ``mobile/`` or
     ``supabase/functions/`` writes a listed table through a supabase-js
     client or names its REST path; no browser file calls an RPC that writes
     one; and no file that names a listed table in quotes also makes a
     supabase-js write, a write ``fetch`` or a GraphQL call.
  C. THE SQL. No committed ``supabase/**/*.sql`` re-opens a listed table: a
     non-select policy, a grant to an API role (quoted identifiers
     included), ``on all tables in schema public``, ``disable row level
     security``, an ``execute`` string that names one, a view over one (or
     over such a view) that nothing closes, a SECURITY DEFINER function that
     names one and is granted to an API role.
  D. THE POLICIES THE REPOSITORY CREATES are the three the lockdown keeps,
     in the form it keeps them (``to authenticated``).
  E. THE MIGRATION is one batch: no psql meta-command; ``lock_timeout``
     before anything else; ``enable row level security`` only where it is
     off; its LAST statement returns the row ``applied``.
  F. THE READ-ONLY FILES are read-only: the two report files are ONE
     SELECT / WITH statement each, the grids file is SELECTs only, and no
     statement — nor any query string handed to ``query_to_xml`` — holds a
     keyword or a function that writes.
  G. THE CONSOLE PROBE, run in a mocked browser: CLOSED on a refusal, OPEN on
     an accepted write, INCONCLUSIVE when it cannot tell — never an uncaught
     error, never a write of anything but the value it just read.
  H. THE GATE addresses no stack by default.
  I. THE ENGINE reaches a listed table with the service role only.

PLANTS (each RED, then reverted — docs/engine_book/gates.md,
"entitlement-write-laws").

Hermetic: reads files; law G runs ``node`` on a mocked page (skipped where
there is no node — the battery's floor then reds); law H runs the gate
script with no stack named, which exits before it opens anything.
"""
from __future__ import annotations

import ast
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SUPABASE = REPO / "supabase"
MIGRATION = SUPABASE / "schema_phase_subscriptions_write_lockdown.sql"
PREFLIGHT_REPORT = SUPABASE / "schema_phase_subscriptions_write_lockdown_preflight_report.sql"
AUDIT_REPORT = SUPABASE / "schema_phase_subscriptions_write_lockdown_audit_report.sql"
PREFLIGHT_GRIDS = SUPABASE / "schema_phase_subscriptions_write_lockdown_preflight.sql"
PROBE = SUPABASE / "schema_phase_subscriptions_write_lockdown_probe.js"
GATE = REPO / "scripts" / "check_subscriptions_write_lockdown.sh"

# RPCs that WRITE a listed table. A browser has no business calling them (the
# database refuses: none is granted to `authenticated`); an edge function
# calls the chat ones with the service role.
WRITER_RPCS = (
    "reserve_user_upload", "reserve_user_upload_extra", "commit_user_upload",
    "release_user_upload", "reserve_user_nonro_upload", "commit_user_nonro_upload",
    "release_user_nonro_upload", "reserve_user_chat", "commit_user_chat",
    "release_user_chat", "increment_user_usage", "increment_plan_chat_daily",
    "claim_founding_seat", "assign_internal_plan", "revoke_internal_plan",
)
# SECURITY DEFINER functions that name a listed table and that an API role may
# be granted: the workspace cap READS the plan; account deletion removes the
# caller's own rows.
API_FUNCTIONS_ALLOWED = {"create_workspace", "delete_my_account"}
API_ROLES = {"anon", "authenticated", "public"}
SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
SKIP_DIRS = {"node_modules", "dist", "build", ".expo", ".vite", "coverage"}


# ── A. THE LIST ──────────────────────────────────────────────────────────

def _block(marker: str, path: Path = MIGRATION) -> list[str]:
    text = path.read_text(encoding="utf-8")
    m = re.search(r"%s-BEGIN(.*?)%s-END" % (marker, marker), text, re.S)
    assert m, "%s lost its %s markers — the list has one place" % (path.name, marker)
    return re.findall(r"^\s*\(?'([a-z_0-9]+)'", m.group(1), re.M)


USER_READABLE = _block("ENTITLEMENT-TABLES-USER-READABLE")
SERVICE_ONLY = _block("ENTITLEMENT-TABLES-SERVICE-ONLY")
TABLES = USER_READABLE + SERVICE_ONLY
TABLES_RX = "|".join(re.escape(t) for t in TABLES)


def _kept(path: Path) -> list[tuple]:
    """(table, policy, using) of the kept-policies block, whichever of the two
    spellings the file uses (jsonb_build_object in plpgsql, VALUES in SQL)."""
    text = path.read_text(encoding="utf-8")
    m = re.search(r"ENTITLEMENT-KEPT-POLICIES-BEGIN(.*?)ENTITLEMENT-KEPT-POLICIES-END", text, re.S)
    assert m, "%s lost its kept-policies markers" % path.name
    body = m.group(1)
    out = re.findall(r"'([a-z_]+)',\s*jsonb_build_object\('policy', '([^']+)',\s*'using', '([^']+)'\)", body)
    if not out:
        out = re.findall(r"\('([a-z_]+)', '([^']+)', '([^']+)'\)", body)
    return sorted(out)


def test_the_list_is_read_from_the_migration_and_names_the_plan_row_and_the_meters():
    assert "subscriptions" in USER_READABLE
    assert {"user_usage", "plan_chat_daily_usage"} <= set(USER_READABLE)
    assert {"document_quota_ledger", "founding_members", "billing_events",
            "renewal_email_queue"} <= set(SERVICE_ONLY)
    assert len(TABLES) == len(set(TABLES)) >= 8, TABLES


def test_the_files_beside_the_migration_name_exactly_the_list_and_the_kept_policies():
    assert _block("ENTITLEMENT-TABLES-USER-READABLE", PREFLIGHT_REPORT) == USER_READABLE
    assert _block("ENTITLEMENT-TABLES-SERVICE-ONLY", PREFLIGHT_REPORT) == SERVICE_ONLY
    kept = _kept(MIGRATION)
    assert [k[0] for k in kept] == sorted(USER_READABLE), kept
    assert _kept(PREFLIGHT_REPORT) == kept
    grids = _strip_sql_comments(PREFLIGHT_GRIDS.read_text(encoding="utf-8"))
    lists = re.findall(r"(?:tablename|relname)\s+in\s+\(((?:[^()]|\n)*?)\)", grids)
    assert len(lists) >= 5, "the grids file lost a block: %d table lists" % len(lists)
    for body in lists:
        assert sorted(re.findall(r"'([a-z_0-9]+)'", body)) == sorted(TABLES), body
    alternation = re.search(r"\\m\(([a-z_|]+)\)\\M", grids)
    assert alternation and sorted(alternation.group(1).split("|")) == sorted(TABLES)


# ── B. THE BROWSER ───────────────────────────────────────────────────────

def _source_files(*roots: str) -> list[Path]:
    out = []
    for root in roots:
        base = REPO / root
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if p.suffix not in SOURCE_SUFFIXES or not p.is_file():
                continue
            if SKIP_DIRS & set(p.relative_to(REPO).parts):
                continue
            out.append(p)
    return sorted(out)


_FROM = re.compile(r"""\.from\(\s*["'`]([a-z_0-9]+)["'`]\s*\)""")
_WRITE = re.compile(r"\.\s*(insert|update|upsert|delete)\s*\(")


def _chain_after(text: str, start: int) -> str:
    """The method chain that follows a `.from("t")`: up to the statement's
    end (a `;` or a blank line at bracket depth 0), bounded."""
    depth, i, end = 0, start, min(len(text), start + 1500)
    while i < end:
        ch = text[i]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth < 0:
                break
        elif depth == 0 and (ch == ";" or text.startswith("\n\n", i)):
            break
        i += 1
    return text[start:i]


def client_writes(text: str, tables=TABLES) -> list[tuple[str, str]]:
    """(table, verb) for every supabase-js write to a listed table."""
    found = []
    for m in _FROM.finditer(text):
        if m.group(1) not in tables:
            continue
        w = _WRITE.search(_chain_after(text, m.end()))
        if w:
            found.append((m.group(1), w.group(1)))
    return found


def _strip_js_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?m)(^|[^:\"'`\\])//[^\n]*", r"\1", text)


_QUOTED_LISTED = re.compile(r"""["'`](%s)["'`]""" % TABLES_RX)
# A supabase-js write (`.delete()` takes no argument; Map / Set `.delete(key)`
# does), a write `fetch`, or the GraphQL door.
_ANY_WRITE = re.compile(
    r"""\.\s*(?:insert|update|upsert)\s*(?:<[^>]*>)?\s*\(|\.\s*delete\s*\(\s*\)"""
    r"""|method\s*:\s*["'`](?:POST|PATCH|PUT|DELETE)["'`]|graphql/v1|\bmutation\b""")


def names_a_listed_table_and_writes(text: str):
    """(table, what) when a file names a listed table in quotes AND makes a
    write of any kind — the evasions a `.from("t").update()` chain scan
    misses: the handle kept in a variable, the name in a constant, a REST path
    assembled from parts, a GraphQL mutation, `.from<any>("t")`."""
    code = _strip_js_comments(text)
    q = _QUOTED_LISTED.search(code)
    w = _ANY_WRITE.search(code)
    return (q.group(1), w.group(0).strip()) if q and w else None


def test_the_scanner_sees_the_writer_this_law_exists_for():
    # The deleted reactivate(), verbatim: a law that cannot see it is no law.
    old = '''
    const { data, error } = await sb
      .from("subscriptions")
      .update({ cancel_at_period_end: false, status: "active" })
      .eq("user_id", userId)
      .select()
      .single();
    '''
    assert client_writes(old) == [("subscriptions", "update")]
    assert client_writes('await sb.from("user_usage").delete().eq("user_id", id);') == [("user_usage", "delete")]
    assert client_writes("sb.from('subscriptions').upsert(row, { onConflict: 'user_id' })") == [("subscriptions", "upsert")]
    # A read is not a write, and a write to another table is not this law's.
    assert client_writes('await sb.from("subscriptions").select("*").eq("user_id", id).maybeSingle();') == []
    assert client_writes('await sb.from("profiles").update({ language: code }).eq("id", id);') == []
    # Two statements: the second one's update is not the first one's.
    assert client_writes('const a = sb.from("subscriptions").select("*");\nsb.from("profiles").update({});') == []


def test_the_co_occurrence_scanner_sees_the_evasions_a_chain_scan_misses():
    hit = names_a_listed_table_and_writes
    assert hit('const t = db().from("subscriptions");\nawait t.update({ tier: "multi" });')
    assert hit('const T = "subscriptions";\nawait sb.from(T).upsert(row);')
    assert hit('const url = base + "/rest/v1/" + "subscriptions";\nfetch(url, { method: "PATCH", body });')
    assert hit('fetch(api + "/graphql/v1", { body: JSON.stringify({ query: q("user_usage") }) });')
    assert hit('await sb.from<any>("subscriptions").update<any>({ status: "active" });')
    assert hit("const q = `mutation { updatesubscriptionsCollection(set: {}) { affectedCount } }`; const t = 'subscriptions';")
    # A reader, a Set, a comment, and a write next to an unlisted name are not hits.
    assert not hit('const { data } = await sb.from("subscriptions").select("*");\nlisteners.delete(cb);')
    assert not hit('// the `subscriptions` row\nawait sb.from("profiles").update({ language });')
    assert not hit('await sb.from("profiles").upsert({ id });')


def test_no_browser_or_edge_function_code_writes_an_entitlement_table():
    files = _source_files("frontend", "mobile", "supabase/functions")
    # Non-vacuity: the scan reaches the real reader of the row and the real
    # edge function, and it is a real number of files.
    names = {p.relative_to(REPO).as_posix() for p in files}
    assert "frontend/lib/billing.ts" in names and "supabase/functions/chat-llm/index.ts" in names
    assert len(files) > 300, len(files)
    billing = (REPO / "frontend/lib/billing.ts").read_text(encoding="utf-8")
    assert _FROM.search(billing) and _FROM.search(billing).group(1) == "subscriptions", (
        "billing.ts no longer reads the subscriptions row through .from() — the scanner's canary moved")

    offenders = []
    for p in files:
        text = p.read_text(encoding="utf-8", errors="replace")
        rel = p.relative_to(REPO).as_posix()
        for table, verb in client_writes(text):
            offenders.append("%s: .from(%r).%s(…)" % (rel, table, verb))
        for t in TABLES:
            if re.search(r"/rest/v1/%s\b" % re.escape(t), text):
                offenders.append("%s: names the REST path /rest/v1/%s" % (rel, t))
        if not rel.startswith("supabase/functions/"):
            for fn in WRITER_RPCS:
                if re.search(r"""\.rpc\(\s*["'`]%s["'`]""" % fn, text):
                    offenders.append("%s: .rpc(%r) — a service-role RPC" % (rel, fn))
        # Browser code only: an edge function holds the service role, reads the
        # plan and POSTs to a model provider in one file — its direct table
        # writes are the two checks above.
        both = None if rel.startswith("supabase/functions/") else names_a_listed_table_and_writes(text)
        if both:
            offenders.append("%s: names %r in quotes and also writes (%s) — read a listed table and write "
                             "anything else in two files, or send the write to the backend" % (rel, both[0], both[1]))
    assert not offenders, (
        "an entitlement table is written — or could be — from code a browser session runs; every "
        "writer is the service role (src/engine/api/_billing.py, the reserve / commit RPCs):\n  "
        + "\n  ".join(offenders))


def test_use_subscription_exposes_no_writer():
    billing = (REPO / "frontend/lib/billing.ts").read_text(encoding="utf-8")
    m = re.search(r"return \{([^}]*)\};\s*\n\}\s*\n\s*\n// ─── Helpers", billing)
    assert m, "useSubscriptionInternal's return moved — re-anchor this law"
    exposed = {x.strip() for x in m.group(1).split(",") if x.strip()}
    assert exposed == {"subscription", "loading", "refresh", "setPlan"}, exposed


# ── C. THE SQL ───────────────────────────────────────────────────────────

def _sql_files() -> list[Path]:
    return sorted(SUPABASE.rglob("*.sql"))


def _strip_sql_comments(text: str) -> str:
    return re.sub(r"--[^\n]*", "", text)


def split_sql(text: str) -> list[str]:
    """Statements of a SQL file, comments removed: `;` outside a quoted
    string, a dollar-quoted string or a comment ends one."""
    out, buf, i, n = [], [], 0, len(text)
    while i < n:
        ch = text[i]
        if text.startswith("--", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
        elif ch == "'":
            j = i + 1
            while j < n:
                if text[j] == "'" and text.startswith("''", j):
                    j += 2
                elif text[j] == "'":
                    break
                else:
                    j += 1
            buf.append(text[i:j + 1]); i = j + 1
        elif ch == "$" and re.match(r"\$[A-Za-z_]*\$", text[i:]):
            tag = re.match(r"\$[A-Za-z_]*\$", text[i:]).group(0)
            j = text.find(tag, i + len(tag))
            j = n if j < 0 else j + len(tag)
            buf.append(text[i:j]); i = j
        elif ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []; i += 1
        else:
            buf.append(ch); i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


def _mask_strings(stmt: str) -> str:
    """The statement with every string literal's CONTENT blanked."""
    stmt = re.sub(r"\$([A-Za-z_]*)\$.*?\$\1\$", lambda m: "$" + m.group(1) + "$ $" + m.group(1) + "$", stmt, flags=re.S)
    return re.sub(r"'(?:[^']|'')*'", "''", stmt)


_POLICY = re.compile(
    r"""create\s+policy\s+(?:"[^"]+"|[a-z_0-9]+)\s+on\s+(?:only\s+)?(?:"?public"?\.)?"?([a-z_0-9]+)"?\b([^;]*)""", re.I)
_GRANT = re.compile(r"\bgrant\s+([^;]*?)\s+on\s+(?!function|schema|sequence)(?:table\s+)?([^;]*?)\s+to\s+([^;]*)", re.I)


def _ident(x: str) -> str:
    """`"public"."subscriptions"` and `public.subscriptions` are one table."""
    x = x.strip().lower().replace('"', "")
    return x.split(".", 1)[1] if x.startswith("public.") else x


def sql_openings(text: str, tables=None, user_readable=None) -> list[str]:
    tables = TABLES if tables is None else tables
    user_readable = USER_READABLE if user_readable is None else user_readable
    text = _strip_sql_comments(text)
    found = []
    for m in _POLICY.finditer(text):
        table, rest = m.group(1).lower(), m.group(2)
        if table not in tables:
            continue
        cmd = re.search(r"\bfor\s+(select|insert|update|delete|all)\b", rest, re.I)
        verb = cmd.group(1).lower() if cmd else "all"     # no FOR clause is FOR ALL
        if verb != "select":
            found.append("create policy … on %s for %s" % (table, verb))
    for m in _GRANT.finditer(text):
        privs = {x.strip().lower().split("(")[0].strip() for x in m.group(1).split(",")}
        target = m.group(2).strip()
        grantees = {x.strip().lower().strip('"') for x in re.split(r"[,\s]+", m.group(3)) if x.strip()}
        if re.match(r"all\s+tables\s+in\s+schema\s+\"?public\"?\b", target, re.I):
            for role in sorted(grantees & API_ROLES):
                found.append("grant %s on all tables in schema public to %s" % (", ".join(sorted(privs)), role))
            continue
        targets = {_ident(x) for x in target.split(",")}
        for table in sorted(targets & set(tables)):
            for role in sorted(grantees & API_ROLES):
                allowed = (role == "authenticated" and table in user_readable and privs == {"select"})
                if not allowed:
                    found.append("grant %s on %s to %s" % (", ".join(sorted(privs)), table, role))
    for m in re.finditer(r"alter\s+table\s+(?:only\s+)?([\"a-z_0-9.]+)\s+disable\s+row\s+level\s+security", text, re.I):
        if _ident(m.group(1)) in tables:
            found.append("alter table %s disable row level security" % _ident(m.group(1)))
    # An `execute` string that names a listed table: SQL built at run time is
    # invisible to every other check here.
    # (`grant execute on function …` and a trigger's `execute function …` are not it.)
    for m in re.finditer(r"(?<![a-z_])execute\s+(?!on\b|function\b|procedure\b)([^;]*)", text, re.I):
        literals = re.findall(r"'((?:[^']|'')*)'|\$[A-Za-z_]*\$(.*?)\$[A-Za-z_]*\$", m.group(1), re.S)
        for a, b in literals:
            named = re.search(r"\b(%s)\b" % "|".join(re.escape(t) for t in tables), a or b)
            if named:
                found.append("execute '… %s …' — a statement built at run time names a listed table" % named.group(1))
                break
    return found


def test_the_sql_scanner_sees_the_two_policies_this_law_exists_for():
    old = '''
    create policy "subscriptions self select" on subscriptions for select using (auth.uid() = user_id);
    create policy "subscriptions self insert" on subscriptions for insert with check (auth.uid() = user_id);
    create policy "subscriptions self update" on subscriptions for update using (auth.uid() = user_id);
    '''
    assert sql_openings(old) == ["create policy … on subscriptions for insert",
                                 "create policy … on subscriptions for update"]
    assert sql_openings('create policy "p" on public.user_usage using (true);') == ["create policy … on user_usage for all"]
    assert sql_openings("grant update (cancel_at_period_end) on public.subscriptions to authenticated;") == [
        "grant update on subscriptions to authenticated"]
    assert sql_openings("grant all on subscriptions, user_usage to anon, authenticated;") == [
        "grant all on subscriptions to anon", "grant all on subscriptions to authenticated",
        "grant all on user_usage to anon", "grant all on user_usage to authenticated"]
    assert sql_openings("grant select on founding_members to authenticated;") == [
        "grant select on founding_members to authenticated"]
    # The lockdown's own grant, a comment, another table and a function grant are not openings.
    assert sql_openings("grant select on table public.subscriptions to authenticated;") == []
    assert sql_openings('-- create policy "x" on subscriptions for update using (true);') == []
    assert sql_openings('create policy "o" on organizations for update using (is_member_of(id));') == []
    assert sql_openings("grant execute on function public.create_workspace(text, text, text) to authenticated;") == []


def test_the_sql_scanner_sees_the_evasions_that_re_open_a_table():
    assert sql_openings('grant update (tier) on table "public"."subscriptions" to authenticated;') == [
        "grant update on subscriptions to authenticated"]
    assert sql_openings('create policy "p" on "public"."user_usage" as permissive for update using (true);') == [
        "create policy … on user_usage for update"]
    assert sql_openings("grant all on all tables in schema public to anon, authenticated;") == [
        "grant all on all tables in schema public to anon", "grant all on all tables in schema public to authenticated"]
    assert sql_openings("alter table user_usage disable row level security;") == [
        "alter table user_usage disable row level security"]
    assert sql_openings('alter table "public"."subscriptions" disable row level security;') == [
        "alter table subscriptions disable row level security"]
    assert sql_openings("do $$ begin execute 'grant update on public.subscriptions to authenticated'; end $$;")[-1].startswith(
        "execute '… subscriptions …'")
    assert sql_openings("execute format('alter table %I disable row level security', 'founding_members');")[0].startswith(
        "execute '… founding_members …'")
    # The lockdown's own dynamic statements name no table: they take it as a parameter.
    assert sql_openings("execute format('revoke all on table %s from public, anon', v_rel);") == []
    assert sql_openings("grant all on all tables in schema public to service_role;") == []
    assert sql_openings("alter table organizations disable row level security;") == []


def test_no_committed_sql_reopens_an_entitlement_table():
    files = _sql_files()
    names = {p.name for p in files}
    assert {"schema.sql", MIGRATION.name, "schema_phase5_usage_limits.sql"} <= names
    assert len(files) >= 45, len(files)
    offenders = []
    for p in files:
        for opening in sql_openings(p.read_text(encoding="utf-8", errors="replace")):
            offenders.append("%s: %s" % (p.relative_to(REPO).as_posix(), opening))
    assert not offenders, (
        "a committed SQL file re-opens an entitlement table to an API role — the next time it is "
        "applied the lockdown is undone (re-running it is how production is migrated):\n  "
        + "\n  ".join(offenders))


_CREATE_VIEW = re.compile(
    r"create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?([\"a-z_0-9.]+)([^;]*)", re.I)


def unclosed_views(corpus: dict, tables=None) -> list[str]:
    """Views that read a listed table — or a view that does — and that no
    committed statement closes: `security_invoker` (in the view's own WITH or
    by ALTER VIEW), or an explicit REVOKE on the view naming anon and
    authenticated (or PUBLIC). A plain view runs with its owner's rights and
    gets ALL for both roles by default."""
    tables = TABLES if tables is None else tables
    texts = {name: _strip_sql_comments(t) for name, t in corpus.items()}
    views = {}   # name → (file, statement)
    for name, text in texts.items():
        for m in _CREATE_VIEW.finditer(text):
            views[_ident(m.group(1))] = (name, m.group(0))
    derived, grew = set(), True
    while grew:
        grew = False
        for v, (_f, stmt) in views.items():
            if v in derived:
                continue
            body = stmt.split(" as ", 1)[-1] if re.search(r"\bas\b", stmt, re.I) else stmt
            body = re.split(r"\bas\b", stmt, 1, flags=re.I)[-1]
            if re.search(r"\b(%s)\b" % "|".join(re.escape(x) for x in list(tables) + sorted(derived)), body):
                derived.add(v); grew = True
    everything = "\n".join(texts.values())
    out = []
    for v in sorted(derived):
        f, stmt = views[v]
        vrx = r"(?:\"?public\"?\.)?\"?%s\"?" % re.escape(v)
        invoker = (re.search(r"security_invoker", stmt.split(" as ", 1)[0], re.I)
                   or re.search(r"alter\s+view\s+%s\s+set\s*\(\s*security_invoker\s*=\s*(?:true|on)" % vrx, everything, re.I))
        revoke = None
        for r in re.finditer(r"revoke\s+all(?:\s+privileges)?\s+on\s+(?:table\s+)?%s\s+from\s+([^;]*)" % vrx, everything, re.I):
            who = {x.strip().lower() for x in re.split(r"[,\s]+", r.group(1)) if x.strip()}
            if {"anon", "authenticated"} <= who or "public" in who:
                revoke = r
        if not (invoker or revoke):
            out.append("%s: view %s reads a listed table and nothing closes it (security_invoker, or a revoke "
                       "from anon and authenticated)" % (f, v))
    return out


def test_no_committed_view_over_an_entitlement_table_is_left_open():
    corpus = {p.relative_to(REPO).as_posix(): p.read_text(encoding="utf-8", errors="replace") for p in _sql_files()}
    # The scanner sees the door, directly and through another view …
    planted = dict(corpus)
    planted["supabase/zz_a.sql"] = "create view public.my_plan as select * from public.subscriptions;"
    assert any("view my_plan" in x for x in unclosed_views(planted))
    planted["supabase/zz_a.sql"] = ("create view va_base as select * from subscriptions;\n"
                                    "revoke all on va_base from anon, authenticated;\n"
                                    "create view va_outer as select * from va_base;")
    assert [x for x in unclosed_views(planted) if "va_" in x] == [
        "supabase/zz_a.sql: view va_outer reads a listed table and nothing closes it (security_invoker, or a revoke "
        "from anon and authenticated)"]
    # … and accepts each way of closing it.
    planted["supabase/zz_a.sql"] = ("create view my_plan with (security_invoker = true) as select * from subscriptions;\n"
                                    "create view my_seats as select count(*) from founding_members;\n"
                                    "alter view my_seats set (security_invoker = true);")
    assert not [x for x in unclosed_views(planted) if "my_" in x]
    # The two views this repository creates are over listed tables, and closed.
    seen = {m.group(1).lower() for t in corpus.values() for m in _CREATE_VIEW.finditer(_strip_sql_comments(t))}
    assert {"founding_member_count", "current_user_usage"} <= {_ident(v) for v in seen}
    assert unclosed_views(corpus) == []


_FUNCTION = re.compile(
    r"create\s+(?:or\s+replace\s+)?function\s+([\"a-z_0-9.]+)\s*\((.*?)\$([A-Za-z_]*)\$(.*?)\$\3\$", re.I | re.S)


def api_granted_functions_naming_a_listed_table(corpus: dict, tables=None) -> list[str]:
    tables = TABLES if tables is None else tables
    naming = set()
    for text in corpus.values():
        for m in _FUNCTION.finditer(_strip_sql_comments(text)):
            if re.search(r"\b(%s)\b" % "|".join(re.escape(t) for t in tables), m.group(4)):
                naming.add(_ident(m.group(1)))
    out = []
    for name, text in corpus.items():
        for m in re.finditer(r"\bgrant\s+execute\s+on\s+function\s+([\"a-z_0-9.]+)\s*\([^)]*\)\s+to\s+([^;]*)",
                             _strip_sql_comments(text), re.I):
            fn = _ident(m.group(1))
            who = {x.strip().lower() for x in re.split(r"[,\s]+", m.group(2)) if x.strip()} & API_ROLES
            if fn in naming and who and fn not in API_FUNCTIONS_ALLOWED:
                out.append("%s: grant execute on function %s to %s — its body names a listed table"
                           % (name, fn, ", ".join(sorted(who))))
    return out


def test_no_function_that_names_an_entitlement_table_is_granted_to_an_api_role():
    corpus = {p.relative_to(REPO).as_posix(): p.read_text(encoding="utf-8", errors="replace") for p in _sql_files()}
    planted = dict(corpus)
    planted["supabase/zz_f.sql"] = (
        "create or replace function public.set_my_tier(p text) returns void language sql security definer as $$\n"
        "  update public.subscriptions set tier = p where user_id = auth.uid();\n$$;\n"
        "grant execute on function public.set_my_tier(text) to authenticated;")
    assert api_granted_functions_naming_a_listed_table(planted) == [
        "supabase/zz_f.sql: grant execute on function set_my_tier to authenticated — its body names a listed table"]
    assert api_granted_functions_naming_a_listed_table(corpus) == []


# ── D. THE POLICIES THE REPOSITORY CREATES ───────────────────────────────

def test_schema_sql_still_drops_the_two_write_policies_it_used_to_create():
    text = _strip_sql_comments((SUPABASE / "schema.sql").read_text(encoding="utf-8"))
    for name in ("subscriptions self insert", "subscriptions self update"):
        assert re.search(r'drop\s+policy\s+if\s+exists\s+"%s"\s+on\s+subscriptions' % name, text, re.I), name
        assert not re.search(r'create\s+policy\s+"%s"' % name, text, re.I), name


def test_the_repository_creates_the_three_kept_policies_in_the_form_the_lockdown_keeps():
    """Re-running one of these files after the lockdown must change nothing:
    a policy created without `to authenticated` is dropped and re-created by
    the next lockdown run, and the post-check expects {authenticated}."""
    kept = {t: (pol, using) for t, pol, using in _kept(MIGRATION)}
    where = {"subscriptions": "schema.sql", "user_usage": "schema_phase5_usage_limits.sql",
             "plan_chat_daily_usage": "schema_phase_pricing_v2.sql"}
    for table, fname in where.items():
        pol, using = kept[table]
        text = re.sub(r"\s+", " ", _strip_sql_comments((SUPABASE / fname).read_text(encoding="utf-8")))
        want = 'create policy "%s" on %s for select to authenticated using %s;' % (pol, table, using)
        assert want in text, "%s does not create %r exactly as the lockdown keeps it:\n  %s" % (fname, pol, want)
    for p in _sql_files():
        if p.name.startswith(MIGRATION.stem):
            continue
        text = re.sub(r"\s+", " ", _strip_sql_comments(p.read_text(encoding="utf-8", errors="replace")))
        for table, (pol, using) in kept.items():
            for m in re.finditer(r'create policy "%s" on (?:public\.)?%s ([^;]*);' % (re.escape(pol), table), text):
                assert m.group(1) == "for select to authenticated using %s" % using, (p.name, m.group(0))


# ── E. THE MIGRATION IS ONE BATCH ────────────────────────────────────────

def test_the_migration_is_one_batch_that_ends_with_the_row_applied():
    text = MIGRATION.read_text(encoding="utf-8")
    assert not re.search(r"(?m)^\s*\\", text), "a psql meta-command: the file must run through an API, whole"
    stmts = split_sql(text)
    assert len(stmts) == 4, [s[:60] for s in stmts]
    assert re.match(r"select set_config\('entitlement_lockdown\.applied', '', false\)", stmts[0])
    assert stmts[1].startswith("do $lockdown$") and stmts[1].endswith("$lockdown$")
    assert stmts[2] == "notify pgrst, 'reload schema'"
    assert stmts[3].startswith("select coalesce(") and stmts[3].endswith(") as applied"), stmts[3][-80:]
    assert "current_setting('entitlement_lockdown.applied', true)" in stmts[3]
    body = _strip_sql_comments(stmts[1])
    # lock_timeout before anything else the block does
    first = re.search(r"\$snapshot\$;\s*begin\s+(.*?);", body, re.S)
    assert first and re.sub(r"\s+", " ", first.group(1)) == "perform set_config('lock_timeout', '5s', true)", first
    # row level security is switched on only where it is off
    enable = [m.start() for m in re.finditer(r"enable row level security", body)]
    assert len(enable) == 1
    guard = body.rfind("if not (select c.relrowsecurity from pg_class c where c.oid = v_rel) then", 0, enable[0])
    assert 0 < enable[0] - guard < 200, "`enable row level security` lost its guard: it locks even when it changes nothing"
    # the block alone is the single-statement fallback: it must ask for the reload itself
    assert "perform pg_notify('pgrst', 'reload schema')" in body
    assert "perform set_config('entitlement_lockdown.applied', v_applied::text, false)" in body
    # the error tells the owner the statement that works, three cases apart
    for needle in ("from %I cascade;", "with grant option; revoke %s (%I) on public.%I from %I cascade;",
                   "inherited through its membership in role %s", "is owned by %s"):
        assert needle in body, needle
    assert "write lockdown INCOMPLETE" in body


# ── F. THE READ-ONLY FILES ARE READ-ONLY ─────────────────────────────────

_WRITE_WORDS = re.compile(
    r"\b(insert|update|delete|merge|create|alter|drop|grant|revoke|truncate|comment|copy|call|do|vacuum|analyze|"
    r"reindex|refresh|lock|notify|listen|unlisten|execute|prepare|deallocate|begin|start|commit|rollback|savepoint|"
    r"set|reset|discard|cluster|import|security|into)\b", re.I)
_WRITE_FUNCTIONS = re.compile(
    r"\b(set_config|pg_notify|nextval|setval|pg_terminate_backend|pg_cancel_backend|pg_sleep|dblink\w*|lo_\w+|"
    r"pg_read_file|pg_write_file|pg_advisory\w*|pg_reload_conf|pg_switch_wal|query_to_xml_and_xmlschema)\s*\(", re.I)


def read_only_violations(stmt: str) -> list[str]:
    out = []
    if not re.match(r"(select|with)\b", stmt, re.I):
        out.append("starts with %r — only SELECT / WITH" % stmt.split(None, 1)[0])
    masked = _mask_strings(stmt)
    for rx, what in ((_WRITE_WORDS, "keyword"), (_WRITE_FUNCTIONS, "function")):
        for m in rx.finditer(masked):
            out.append("%s %r" % (what, m.group(1)))
    # A query handed to query_to_xml() runs too: it is held to the same law.
    for m in re.finditer(r"query_to_xml\s*\(\s*(?:'((?:[^']|'')*)'|\$([A-Za-z_]*)\$(.*?)\$\2\$)", stmt, re.S):
        inner = (m.group(1) if m.group(1) is not None else m.group(3)).strip()
        out += ["inside query_to_xml: " + v for v in read_only_violations(inner)]
    return out


def test_the_read_only_law_sees_a_write():
    assert read_only_violations("select 1") == []
    assert read_only_violations("with a as (select 1) select * from a") == []
    assert read_only_violations("select 'update me', updated_at, created_at from t") == []
    assert read_only_violations("update subscriptions set tier = 'multi'")
    assert read_only_violations("with x as (delete from t returning 1) select * from x")
    assert read_only_violations("select set_config('a.b', 'c', false)")
    assert read_only_violations("select * into t2 from t")
    assert read_only_violations("select query_to_xml('delete from public.billing_events', false, false, '')")
    assert read_only_violations("select query_to_xml($q$ with e as (select 1) select * from e $q$, false, false, '')") == []


@pytest.mark.parametrize("path, alias", [(PREFLIGHT_REPORT, "report"), (AUDIT_REPORT, "audit")])
def test_each_report_file_is_one_read_only_statement_returning_one_jsonb_row(path, alias):
    text = path.read_text(encoding="utf-8")
    assert not re.search(r"(?m)^\s*\\", text), "a psql meta-command"
    stmts = split_sql(text)
    assert len(stmts) == 1, "%s must be ONE statement (a client that sends one prepared statement takes it): %d" % (
        path.name, len(stmts))
    assert read_only_violations(stmts[0]) == [], read_only_violations(stmts[0])
    assert re.search(r"\)\s+as\s+%s(\s+from\s+v)?$" % alias, stmts[0]), stmts[0][-60:]
    assert re.match(r"with\b", stmts[0], re.I) and "jsonb_build_object(" in stmts[0]


def test_the_preflight_report_computes_the_three_verdicts_and_the_audit_report_selects_no_email_or_stripe_id():
    report = split_sql(PREFLIGHT_REPORT.read_text(encoding="utf-8"))[0]
    for key in ("'state'", "'hole_open'", "'stopgap_in_place'", "'fully_locked'", "'why_not_fully_locked'",
                "'tables_not_owned_by_runner'", "'policies_this_file_will_drop'",
                "'views_that_can_be_written_through'", "'functions_an_api_role_may_execute'",
                "'listed_tables'", "'column_acl'", "'views'", "'functions'", "'server_version_num'"):
        assert key in report, key
    assert "with recursive" in report and "walk.depth + 1" in report, "the view walk is no longer transitive"
    audit = split_sql(AUDIT_REPORT.read_text(encoding="utf-8"))[0]
    assert not re.search(r"\bemail\b", _mask_strings(audit), re.I), "the audit selects an email"
    keys = set(re.findall(r"'([a-z_]+)'\s*,", audit))
    assert not {"stripe_customer_id", "stripe_subscription_id", "email"} & keys, "a Stripe id value or an email is returned"
    assert {"has_stripe_customer", "has_stripe_subscription", "why_listed", "listed_count",
            "stripe_ids_in_no_billing_event", "tier_by_stripe_subscription", "tables_present"} <= keys
    assert audit.count("to_regclass('public.founding_members')") and audit.count("to_regclass('public.billing_events')")
    # The two optional tables are named ONLY inside strings (query_to_xml, to_regclass): a
    # plain reference would make the statement fail to parse where one is absent.
    assert not re.search(r"\b(founding_members|billing_events)\b", _mask_strings(audit))


def test_the_grids_file_is_selects_only():
    text = PREFLIGHT_GRIDS.read_text(encoding="utf-8")
    assert not re.search(r"(?m)^\s*\\", text), "a psql meta-command"
    stmts = split_sql(text)
    assert len(stmts) >= 10, len(stmts)
    for s in stmts:
        assert read_only_violations(s) == [], (s[:70], read_only_violations(s))
    assert "with recursive" in text, "the views grid is no longer transitive"
    assert "pg_get_userbyid(c.relowner) as owner" in text and "aclexplode(att.attacl)" in text


# ── G. THE CONSOLE PROBE, IN A MOCKED BROWSER ────────────────────────────

_HARNESS = r"""
const vm = require('vm'); const fs = require('fs');
const [probePath, scenarioJson] = process.argv.slice(2);
const sc = JSON.parse(scenarioJson);
const lines = []; const fetches = [];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const anonJwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon', iss: 'supabase' })}.c2lnbmF0dXJl`;
const store = sc.signedIn === false ? {} : { 'sb-abcdefghijklmnop-auth-token': JSON.stringify(sc.session === undefined ? { access_token: 'user-token', user: { id: '11111111-1111-4111-8111-111111111111' } } : sc.session) };
const resp = (status, body) => ({ status, json: async () => { if (body === undefined) throw new Error('no body'); return body; }, text: async () => String(body) });
const sandbox = {
  console: { log: (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) },
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  performance: { getEntriesByType: () => ['https://cdn.other.example/blocked.js', 'https://app.example/assets/index-abc.js'].map((name) => ({ name })) },
  fetch: async (url, opts = {}) => {
    const method = opts.method || 'GET';
    fetches.push({ url: String(url), method, body: opts.body || null });
    if (/blocked\.js/.test(url)) throw new TypeError('Failed to fetch');
    if (/\.js(\?|$)/.test(url)) return resp(200, sc.keyKind === 'none' ? 'const x = 1;' : sc.keyKind === 'publishable' ? 'k="sb_publishable_AbC123_x-y"' : `const k="${anonJwt}";`);
    if (method === 'GET') return resp(sc.readStatus || 200, sc.readRows === undefined ? [{ cancel_at_period_end: sc.current === undefined ? false : sc.current }] : sc.readRows);
    return resp(sc.writeStatus, sc.writeBody);
  },
};
sandbox.localStorage = new Proxy({ getItem: (k) => (k in store ? store[k] : null) }, {
  ownKeys: () => Object.keys(store),
  getOwnPropertyDescriptor: (t, k) => (k in store ? { enumerable: true, configurable: true, value: store[k] } : Object.getOwnPropertyDescriptor(t, k)),
});
vm.createContext(sandbox);
const finish = (extra) => { process.stdout.write(JSON.stringify(Object.assign({ last: lines[lines.length - 1] || null, lines, fetches }, extra || {}))); process.exit(0); };
process.on('unhandledRejection', (e) => finish({ uncaught: String(e) }));
process.on('uncaughtException', (e) => finish({ uncaught: String(e) }));
Promise.resolve(vm.runInContext(fs.readFileSync(probePath, 'utf8'), sandbox)).then(() => setTimeout(finish, 50)).catch((e) => finish({ uncaught: String(e) }));
"""

_PROBE_SCENARIOS = [
    # (name, scenario, the verdict's first words, PATCHes sent, the PATCH body)
    ("not signed in", {"signedIn": False}, "PROBE INCONCLUSIVE — not signed in", 0, None),
    ("a session without a token", {"session": {}}, "PROBE INCONCLUSIVE — not signed in", 0, None),
    ("the write is refused 403", {"writeStatus": 403, "writeBody": {"message": "permission denied"}}, "CLOSED", 1, {"cancel_at_period_end": False}),
    ("the write is refused 401", {"writeStatus": 401, "writeBody": {}}, "CLOSED", 1, {"cancel_at_period_end": False}),
    ("the write lands", {"writeStatus": 200, "writeBody": [{"cancel_at_period_end": False}]}, "OPEN", 1, {"cancel_at_period_end": False}),
    ("the write answers 204", {"writeStatus": 204}, "OPEN", 1, {"cancel_at_period_end": False}),
    ("the write is not refused but changes no row", {"writeStatus": 200, "writeBody": []}, "NOT CLOSED", 1, {"cancel_at_period_end": False}),
    ("the server errors 500", {"writeStatus": 500, "writeBody": {"message": "boom"}}, "PROBE INCONCLUSIVE — the write answered HTTP 500", 1, {"cancel_at_period_end": False}),
    ("the read answers two rows", {"readRows": [{"cancel_at_period_end": False}, {"cancel_at_period_end": True}], "writeStatus": 403}, "PROBE INCONCLUSIVE — the read did not answer exactly one row", 0, None),
    ("no anon key in the page's scripts", {"keyKind": "none", "writeStatus": 403}, "PROBE INCONCLUSIVE — the anon key was not found", 0, None),
    ("the publishable key format", {"keyKind": "publishable", "writeStatus": 403, "writeBody": {}}, "CLOSED", 1, {"cancel_at_period_end": False}),
    ("the value read is the value written back", {"current": True, "writeStatus": 403, "writeBody": {}}, "CLOSED", 1, {"cancel_at_period_end": True}),
]


@pytest.mark.parametrize("name, scenario, verdict, patches, body", _PROBE_SCENARIOS, ids=[s[0] for s in _PROBE_SCENARIOS])
def test_the_console_probe_in_a_mocked_browser(tmp_path, name, scenario, verdict, patches, body):
    node = shutil.which("node")
    if not node:
        pytest.skip("no node on this host — the probe was not run")
    harness = tmp_path / "harness.js"
    harness.write_text(_HARNESS, encoding="utf-8")
    out = subprocess.run([node, str(harness), str(PROBE), json.dumps(scenario)],
                         capture_output=True, text=True, timeout=30)
    got = json.loads(out.stdout or "{}")
    assert not got.get("uncaught"), "the probe ended in an uncaught error: %s" % got.get("uncaught")
    assert got.get("last") and got["last"].startswith(verdict), got.get("last")
    writes = [f for f in got["fetches"] if f["method"] != "GET"]
    assert len(writes) == patches, writes
    if patches:
        assert writes[0]["method"] == "PATCH" and json.loads(writes[0]["body"]) == body
        assert writes[0]["url"].startswith("https://abcdefghijklmnop.supabase.co/rest/v1/subscriptions?user_id=eq.")
    # every script the page loaded that could not be fetched was skipped, not fatal
    if scenario.get("signedIn") is not False and scenario.get("session") is None:
        assert got["fetches"][0]["url"].endswith("blocked.js")


def test_the_probe_writes_one_harmless_field_and_never_a_tier():
    text = PROBE.read_text(encoding="utf-8")
    assert text.count("method: 'PATCH'") == 1 and "cancel_at_period_end: rows[0].cancel_at_period_end" in text
    code = _strip_js_comments(text)
    assert not re.search(r"\b(tier|status|plan|custom_limits|stripe_)\w*\s*:", code), "the probe writes an entitlement field"


# ── H. THE GATE ADDRESSES NO STACK BY DEFAULT ────────────────────────────

def test_the_stack_gate_is_vacuous_unless_it_is_told_which_stack():
    text = GATE.read_text(encoding="utf-8")
    # No default connection: with one, a battery run on a machine whose
    # standard local stack is shared creates users there and holds the hole
    # open under other lanes' gates. STATIC FIRST — the run below must never
    # happen against a default.
    assert 'DB_URL="${SUBS_LOCKDOWN_DB_URL:-}"' in text and 'API_URL="${SUBS_LOCKDOWN_API_URL:-}"' in text
    assert not re.search(r"SUBS_LOCKDOWN_(DB|API)_URL:-[^}]", text), "the gate has a default stack again"
    assert not re.search(r"(?m)^[^#\n]*\b5432[12]\b", text), "a standard local port is written into the gate"
    env = {k: v for k, v in os.environ.items() if not k.startswith("SUBS_LOCKDOWN_")}
    out = subprocess.run(["bash", str(GATE)], capture_output=True, text=True, timeout=60, env=env)
    assert out.returncode == 0, out.stdout[-400:]
    assert "VACUOUS — SUBS_LOCKDOWN_DB_URL and SUBS_LOCKDOWN_API_URL are not both set." in out.stdout
    assert "GATE-WORK subscriptions-write-lockdown units=0" in out.stdout
    assert "PASS " not in out.stdout and "FAIL " not in out.stdout


# ── I. THE ENGINE REACHES THEM WITH THE SERVICE ROLE ONLY ────────────────

def _per_user_blocks(tree: ast.AST):
    for node in ast.walk(tree):
        if not isinstance(node, (ast.With, ast.AsyncWith)):
            continue
        for item in node.items:
            call = item.context_expr
            if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                    and call.func.attr == "per_user"):
                yield node


def test_no_user_jwt_client_in_the_engine_names_an_entitlement_table():
    blocks, offenders = 0, []
    for p in sorted((REPO / "src" / "engine").rglob("*.py")):
        text = p.read_text(encoding="utf-8")
        if "per_user(" not in text:
            continue
        for block in _per_user_blocks(ast.parse(text)):
            blocks += 1
            for node in ast.walk(block):
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in TABLES:
                    offenders.append("%s:%s names %r inside a per_user(jwt) block"
                                     % (p.relative_to(REPO).as_posix(), node.lineno, node.value))
    assert blocks >= 20, "the census found %d per_user(jwt) blocks — it is not reading the engine" % blocks
    assert not offenders, (
        "the engine touches an entitlement table with the CALLER's JWT — after the lockdown that "
        "call is refused; use the service role:\n  " + "\n  ".join(offenders))


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
