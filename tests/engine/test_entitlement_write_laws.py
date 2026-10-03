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
the local stack through real PostgREST. That gate cannot see the SOURCE: a
browser writer put back, or a committed SQL file that re-opens a table the
next time it is applied. These are the static laws for that half.

THE LIST is read from the migration (the two blocks between its
``ENTITLEMENT-TABLES-*`` markers) — the one place it is written.

  1. no file under ``frontend/``, ``mobile/`` or ``supabase/functions/``
     calls insert / update / upsert / delete on a listed table through a
     supabase-js client, or names its REST path; no browser file calls an
     RPC that writes one (an edge function may: it holds the service role);
  2. no committed ``supabase/**/*.sql`` creates a policy on a listed table
     whose command is not SELECT, or grants an API role (anon,
     authenticated, PUBLIC) a privilege on one — except the lockdown's own
     ``grant select on public.subscriptions to authenticated``;
  3. ``supabase/schema.sql`` still DROPS the two write policies it used to
     create, so re-running the current file closes them rather than nothing;
  4. the migration's header names the same tables as its list (the
     operator's pre-flight queries cannot fall behind it);
  5. no ``_supabase.per_user(jwt)`` block in ``src/engine`` names a listed
     table: the engine reaches them with the service role only, so the
     revoke cannot break a route.

PLANTS (each RED, then reverted — docs/engine_book/gates.md,
"subscriptions-write-lockdown"): ``reactivate()`` put back in billing.ts
(law 1); the two ``create policy`` lines put back in schema.sql (law 2).

Hermetic: reads files, opens nothing.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
MIGRATION = REPO / "supabase" / "schema_phase_subscriptions_write_lockdown.sql"

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
API_ROLES = {"anon", "authenticated", "public"}
SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
SKIP_DIRS = {"node_modules", "dist", "build", ".expo", ".vite", "coverage"}


def _block(marker: str) -> list[str]:
    text = MIGRATION.read_text(encoding="utf-8")
    m = re.search(r"%s-BEGIN(.*?)%s-END" % (marker, marker), text, re.S)
    assert m, "the migration lost its %s markers — the list has one place" % marker
    return re.findall(r"^\s*'([a-z_0-9]+)'", m.group(1), re.M)


USER_READABLE = _block("ENTITLEMENT-TABLES-USER-READABLE")
SERVICE_ONLY = _block("ENTITLEMENT-TABLES-SERVICE-ONLY")
TABLES = USER_READABLE + SERVICE_ONLY


def test_the_list_is_read_from_the_migration_and_names_the_plan_row_and_the_meters():
    assert "subscriptions" in USER_READABLE
    assert {"user_usage", "plan_chat_daily_usage"} <= set(USER_READABLE)
    assert {"document_quota_ledger", "founding_members", "billing_events"} <= set(SERVICE_ONLY)
    assert len(TABLES) == len(set(TABLES)) >= 7, TABLES


# ── law 1: no browser / edge-function writer ─────────────────────────────

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
    assert not offenders, (
        "an entitlement table is written from code a browser session runs — every writer is "
        "the service role (src/engine/api/_billing.py, the reserve / commit RPCs):\n  "
        + "\n  ".join(offenders))


def test_use_subscription_exposes_no_writer():
    billing = (REPO / "frontend/lib/billing.ts").read_text(encoding="utf-8")
    m = re.search(r"return \{([^}]*)\};\s*\n\}\s*\n\s*\n// ─── Helpers", billing)
    assert m, "useSubscriptionInternal's return moved — re-anchor this law"
    exposed = {x.strip() for x in m.group(1).split(",") if x.strip()}
    assert exposed == {"subscription", "loading", "refresh", "setPlan"}, exposed


# ── law 2: no committed SQL re-opens a listed table ──────────────────────

def _sql_files() -> list[Path]:
    return sorted((REPO / "supabase").rglob("*.sql"))


def _strip_sql_comments(text: str) -> str:
    return re.sub(r"--[^\n]*", "", text)


_POLICY = re.compile(
    r"""create\s+policy\s+(?:"[^"]+"|[a-z_0-9]+)\s+on\s+(?:only\s+)?(?:public\.)?"?([a-z_0-9]+)"?\b([^;]*)""", re.I)
_GRANT = re.compile(r"\bgrant\s+([^;]*?)\s+on\s+(?!function|schema|sequence|all\s)(?:table\s+)?([^;]*?)\s+to\s+([^;]*)", re.I)


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
        targets = {x.strip().lower().replace("public.", "").strip('"') for x in m.group(2).split(",")}
        grantees = {x.strip().lower().strip('"') for x in re.split(r"[,\s]+", m.group(3)) if x.strip()}
        for table in sorted(targets & set(tables)):
            for role in sorted(grantees & API_ROLES):
                allowed = (role == "authenticated" and table in user_readable and privs == {"select"})
                if not allowed:
                    found.append("grant %s on %s to %s" % (", ".join(sorted(privs)), table, role))
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


def test_schema_sql_still_drops_the_two_write_policies_it_used_to_create():
    text = _strip_sql_comments((REPO / "supabase" / "schema.sql").read_text(encoding="utf-8"))
    for name in ("subscriptions self insert", "subscriptions self update"):
        assert re.search(r'drop\s+policy\s+if\s+exists\s+"%s"\s+on\s+subscriptions' % name, text, re.I), name
        assert not re.search(r'create\s+policy\s+"%s"' % name, text, re.I), name


# ── law 4: the runbook names the list ────────────────────────────────────

def test_the_migrations_pre_flight_queries_name_exactly_the_list():
    text = MIGRATION.read_text(encoding="utf-8")
    header = text[: text.index("set search_path = public;")]
    lists = re.findall(r"(?:tablename|relname)\s+in\s+\(((?:[^()]|\n)*?)\)", header)
    assert len(lists) == 4, "the header carries four pre-flight queries (policies, grants, row level security, views)"
    for body in lists:
        assert sorted(re.findall(r"'([a-z_0-9]+)'", body)) == sorted(TABLES), body
    # The file ends with the reload, and checks its own result.
    assert text.rstrip().endswith("notify pgrst, 'reload schema';")
    assert "write lockdown INCOMPLETE" in text


# ── law 5: the engine reaches them with the service role only ────────────

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
