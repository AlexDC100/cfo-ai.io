"""ENTITLEMENT-HOLE LAWS — the source half of five restrict-only migrations.

An adversarial review of the subscriptions lockdown (2026-10-03) measured
four more holes beside it, and the census behind the third found a fifth
class. Each is closed by ONE migration that only removes or restricts
access, read before and after by ONE read-only report:

  H1  supabase/schema_phase_workspace_cap_guard.sql
        the plan's workspace cap, held on the way back from the archive and
        for two requests at once; no direct write of the archive / firm
        columns of ``organizations``;
  H2  supabase/schema_phase_dashboard_config_caller.sql
        ``upsert_dashboard_config`` writes the caller's own row, and the anon
        key writes nothing;
  H3  supabase/schema_phase_public_tables_write_revoke.sql
        the anon key (and a signed-in session) lose the write privileges on
        the public-market / intelligence tables and the calibration queue;
  H3b supabase/schema_phase_derived_tables_write_revoke.sql
        the same revoke on the six tables that hold what the ENGINE computes
        (not one of the four measured holes — the rest of the same census,
        applied on its own decision);
  H4  supabase/schema_phase_signup_tier_trial.sql
        a NEW signup's subscription row says tier 'trial' — forward only.

``scripts/check_hole_*.sh`` prove each one in a scratch database: the hole
shown OPEN, then closed. Those gates are VACUOUS where no database is named,
and they cannot see the SOURCE. These are the laws for that half:

  A. THE FILES ARE WHAT THE COORDINATOR'S TOOL NEEDS. A migration is one DO
     block (all or nothing, ``lock_timeout`` first, ``notify pgrst``) and one
     SELECT that returns what it did; a report is ONE read-only statement
     returning one jsonb row with ``hole_open``.
  B. RESTRICT ONLY. No migration touches a table row, creates or drops a
     policy, switches row level security, or grants anything — except the two
     grants in H2 that give back, by name, what the revoke from PUBLIC took
     from a role that held it.
  C. THE PAIRS AGREE. A report recognises exactly the function body its
     migration installs (and the repository's originals), and names exactly
     the tables its migration lists.
  D. NOBODY WITH A USER'S JWT WRITES WHAT THE FILES CLOSE. No browser, mobile
     or edge-function code and no ``_supabase.per_user(jwt)`` client in the
     engine writes a table H3 / H3b / H2 revoke — a writer that appears later
     would answer 403 in production; and every user-JWT writer of
     ``organizations`` writes only columns H1 does not guard.
  E. NO OTHER COMMITTED SQL RE-OPENS ONE. No grant of a write privilege on a
     closed table to an API role, nothing that drops, disables or replaces
     the guard, no second definition of the dashboard function, no new
     signup function that seeds a subscription without a tier — and the files
     that ARE known to re-open one (they create the tables / the original
     functions) are each named in the migration's own re-run warning.
  F. THE ENGINE GIVES THE ROW H4 SEEDS THE TRIAL. The real
     ``_pricing_config.plan_for`` over ``tier or plan`` — the engine's own
     expression — answers ``trial`` for the patched statement, and ``multi``
     for the statement the repository ships (the hole this law exists for).
  G. THE GATES ADDRESS NO DATABASE BY DEFAULT, refuse one that is not local,
     and never run a request in a ``postgres`` session (a refused function
     call under ``set role`` there crashes the local Supabase Postgres).

PLANTS (each RED, then reverted — docs/engine_book/gates.md,
"entitlement-hole-laws").

Hermetic: reads files; law G runs each gate script with no database named
(it exits before it opens anything) and with URLs it must refuse (it exits
before it connects).
"""
from __future__ import annotations

import ast
import hashlib
import os
import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SUPABASE = REPO / "supabase"
PREFLIGHT = SUPABASE / "preflight"
SCRIPTS = REPO / "scripts"
LIB = SCRIPTS / "entitlement_holes" / "lib.sh"

#: (hole, migration stem, gate script, gate id)
HOLES = [
    ("H1", "schema_phase_workspace_cap_guard", "check_hole_workspace_cap.sh", "hole-workspace-cap"),
    ("H2", "schema_phase_dashboard_config_caller", "check_hole_dashboard_config.sh", "hole-dashboard-config"),
    ("H3", "schema_phase_public_tables_write_revoke", "check_hole_public_tables.sh", "hole-public-tables"),
    ("H3b", "schema_phase_derived_tables_write_revoke", "check_hole_derived_tables.sh", "hole-derived-tables"),
    ("H4", "schema_phase_signup_tier_trial", "check_hole_signup_tier.sh", "hole-signup-tier"),
]
STEMS = [h[1] for h in HOLES]


def migration(stem: str) -> Path:
    return SUPABASE / (stem + ".sql")


def report(stem: str) -> Path:
    return PREFLIGHT / (stem + "_preflight_report.sql")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def md5(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


# ── SQL reading ──────────────────────────────────────────────────────────

_DOLLAR = re.compile(r"\$[A-Za-z_]*\$")


def strip_sql_comments(text: str) -> str:
    """`-- …` and `/* … */` removed; quoted strings and dollar-quoted bodies
    are kept as they are (a `--` inside one is text, not a comment)."""
    out, i, n = [], 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "'":
            j = i + 1
            while j < n:
                if text[j] == "'" and j + 1 < n and text[j + 1] == "'":
                    j += 2
                    continue
                if text[j] == "'":
                    break
                j += 1
            out.append(text[i:j + 1])
            i = j + 1
        elif ch == "$" and _DOLLAR.match(text, i):
            # a dollar-quoted body is SQL / plpgsql: its comments go too (a
            # keyword in a body's comment is not a statement)
            tag = _DOLLAR.match(text, i).group(0)
            close = text.find(tag, i + len(tag))
            if close < 0:
                out.append(text[i:])
                i = n
            else:
                out.append(tag + strip_sql_comments(text[i + len(tag):close]) + tag)
                i = close + len(tag)
        elif text.startswith("--", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def split_sql(text: str) -> list[str]:
    """Top-level statements of comment-free SQL (`;` inside a quoted string or
    a dollar-quoted body does not end one)."""
    stmts, buf, i, n = [], [], 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "'":
            j = i + 1
            while j < n:
                if text[j] == "'" and j + 1 < n and text[j + 1] == "'":
                    j += 2
                    continue
                if text[j] == "'":
                    break
                j += 1
            buf.append(text[i:j + 1])
            i = j + 1
        elif ch == "$" and _DOLLAR.match(text, i):
            tag = _DOLLAR.match(text, i).group(0)
            end = text.find(tag, i + len(tag))
            end = n if end < 0 else end + len(tag)
            buf.append(text[i:end])
            i = end
        elif ch == ";":
            s = "".join(buf).strip()
            if s:
                stmts.append(s)
            buf = []
            i += 1
        else:
            buf.append(ch)
            i += 1
    s = "".join(buf).strip()
    if s:
        stmts.append(s)
    return stmts


def mask_strings(stmt: str) -> str:
    """Single-quoted strings blanked (their words are data, not SQL)."""
    return re.sub(r"'(?:[^']|'')*'", "''", stmt)


def mask_nested_bodies(do_block: str) -> str:
    """Inside a `do $migration$ … $migration$` block: every nested
    dollar-quoted body (a function the block CREATES — its statements run
    when the function is called, not when the migration is) blanked."""
    m = re.match(r"(?is)\s*do\s+(\$[A-Za-z_]+\$)(.*)\1\s*$", do_block)
    assert m, "not a do block"
    inner = m.group(2)
    return re.sub(r"(?s)(\$[A-Za-z_]*\$).*?\1", "$$ $$", inner)


def function_body(path: Path, name: str) -> str:
    """The text Postgres stores as prosrc: between the `$$` of
    `create or replace function <name>( … ) … as $$ … $$`."""
    m = re.search(
        r"create\s+or\s+replace\s+function\s+(?:public\.)?%s\s*\(.*?\bas\s+\$\$(.*?)\$\$" % re.escape(name),
        read(path), re.S | re.I)
    assert m, "%s defines no function %s" % (path.name, name)
    return m.group(1)


def tables_between(path: Path, marker: str) -> list[str]:
    text = read(path)
    a, b = text.index(marker + "-BEGIN"), text.index(marker + "-END")
    return re.findall(r"^\s*'([a-z_0-9]+)'", text[a:b], re.M)


RLS_OFF = tables_between(migration("schema_phase_public_tables_write_revoke"), "PUBLIC-TABLES-RLS-OFF")
UNSCOPED = tables_between(migration("schema_phase_public_tables_write_revoke"), "PUBLIC-TABLES-UNSCOPED-POLICY")
DERIVED = tables_between(migration("schema_phase_derived_tables_write_revoke"), "DERIVED-TABLES")
#: every table a user's JWT loses the write privileges on
CLOSED_TABLES = RLS_OFF + UNSCOPED + DERIVED + ["dashboard_configs"]
#: the columns of organizations H1 refuses a direct write of
GUARDED_COLUMNS = ["archived_at", "purge_after", "firm_id", "cui"]
#: the columns a user's JWT writes today (frontend/lib/org.ts, engine _uploads.py)
ORG_COLUMNS_A_USER_WRITES = {"name", "industry_key", "industry_display_name", "caen_code"}

#: the five the review measured on a database built from this repository
MEASURED_TWELVE = {
    "company_exposure_profiles", "company_signal_links", "intelligence_signals",
    "macro_signal_cache", "nasdaq_responses", "public_companies",
    "public_company_opportunity_scores", "public_company_periods",
    "public_company_quotes", "public_company_risk_scores", "risk_interpretations",
    "sector_risk_models",
}


# ═════════════════════════════════════════════════════════════════════════
# A. THE FILES ARE WHAT THE COORDINATOR'S TOOL NEEDS
# ═════════════════════════════════════════════════════════════════════════

def test_the_five_pairs_exist_and_the_gate_library_tests_exactly_them():
    for _hole, stem, gate, _gid in HOLES:
        assert migration(stem).is_file(), "missing supabase/%s.sql" % stem
        assert report(stem).is_file(), "missing its preflight report"
        assert (SCRIPTS / gate).is_file(), "missing scripts/%s" % gate
    lib = read(LIB)
    block = lib[lib.index("HOLES_UNDER_TEST=("):]
    block = block[:block.index(")")]
    under_test = set(re.findall(r"(schema_phase_[a-z_0-9]+)\.sql", block))
    assert under_test == set(STEMS), (
        "scripts/entitlement_holes/lib.sh HOLES_UNDER_TEST is not the five migrations — a file "
        "missing there is applied in the BASE build, and its gate then never sees the hole open: %s"
        % sorted(under_test ^ set(STEMS)))
    assert len(RLS_OFF) >= 12 and len(DERIVED) >= 6 and UNSCOPED, "the lists were not read from the migrations"


def migration_statements(stem: str) -> list[str]:
    return split_sql(strip_sql_comments(read(migration(stem))))


@pytest.mark.parametrize("stem", STEMS)
def test_each_migration_is_one_do_block_and_one_select_that_says_what_it_did(stem):
    raw = read(migration(stem))
    assert not re.search(r"(?m)^\s*\\", strip_sql_comments(raw)), "a psql meta-command: the Management API runs SQL, not psql"
    stmts = migration_statements(stem)
    assert len(stmts) == 2, (
        "%s.sql must be ONE do block and ONE select (the tool returns only the LAST statement's "
        "rows, and a second DDL statement outside the block is not covered by its all-or-nothing): "
        "found %d statements" % (stem, len(stmts)))
    do, last = stmts
    assert re.match(r"(?is)do\s+\$migration\$.*\$migration\$$", do), "the first statement is not `do $migration$ … $migration$`"
    body = mask_nested_bodies(do)
    first = re.search(r"(?is)\bbegin\b\s*(.*?);", body)
    assert first and re.sub(r"\s+", " ", first.group(1)).strip().lower() == \
        "perform set_config('lock_timeout', '5s', true)", (
        "the block's FIRST statement must be the lock timeout (a migration waiting behind an "
        "open transaction stalls every reader queued behind it): found %r" % (first and first.group(1)))
    assert re.search(r"(?i)\bnotify\s+pgrst\s*,\s*'reload schema'", body), "no `notify pgrst, 'reload schema'` (CLAUDE.md §14)"
    assert not re.search(r"(?i)\b(commit|rollback|start\s+transaction|begin\s+transaction)\b", mask_strings(body)), \
        "transaction control inside the block"
    assert re.search(r"(?i)set_config\('cfo_holes\.result',\s*''\s*,\s*false\)", body), \
        "the block must clear cfo_holes.result first — or a failed run answers with the previous file's result"
    norm = re.sub(r"\s+", " ", last).strip().lower()
    assert norm.startswith("select coalesce(nullif(current_setting('cfo_holes.result', true), ''),") \
        and norm.endswith("::jsonb as result"), "the LAST statement must return the result row: %r" % norm[:160]
    assert "'migration', '%s.sql'" % stem in do, "the result row does not name its own file"


_WRITE_WORDS = re.compile(
    r"(?i)\b(insert\s+into|update\s+(?:only\s+)?[a-z_\"][a-z_0-9.\"]*\s+set|delete\s+from|truncate|copy\s|merge\s+into)\b")
_WRITE_FUNCTIONS = re.compile(r"(?i)\b(set_config|nextval|setval|pg_advisory\w*|lo_\w+|dblink\w*|pg_notify)\s*\(")
_DDL_WORDS = re.compile(r"(?i)\b(create|alter|drop|grant|revoke|comment\s+on|reindex|vacuum|cluster|refresh|lock\s+table|notify|listen|call|do)\b")


def read_only_violations(stmt: str) -> list[str]:
    """Why a statement is not read-only (empty when it is). The query strings
    handed to query_to_xml are statements too: they are checked, not masked."""
    found = []
    for q in re.findall(r"(?is)query_to_xml\(\s*(\$[A-Za-z_]*\$)(.*?)\1", stmt):
        inner = q[1]
        if not re.match(r"(?is)\s*select\b", inner):
            found.append("a query_to_xml string that is not a select")
        found += ["in a query_to_xml string: " + v for v in read_only_violations(inner)]
    bare = mask_strings(re.sub(r"(?s)(\$[A-Za-z_]*\$).*?\1", "''", stmt))
    for rx, what in ((_WRITE_WORDS, "writes"), (_WRITE_FUNCTIONS, "calls a function that writes"), (_DDL_WORDS, "is not a query")):
        m = rx.search(bare)
        if m:
            found.append("%s: %r" % (what, m.group(0)))
    return found


def test_the_read_only_law_sees_a_write():
    assert read_only_violations("select 1 as report") == []
    assert read_only_violations("with x as (select count(*) from t) select jsonb_build_object('a', 'insert into t') as report") == []
    for bad in ("with x as (update subscriptions set tier = 'multi' returning 1) select 1",
                "select set_config('lock_timeout', '5s', false)",
                "with d as (delete from organizations returning 1) select count(*) from d",
                "select (xpath('/x', query_to_xml($q$ update t set a = 1 returning 1 $q$, false, true, '')))[1]",
                "select nextval('s')",
                "grant insert on t to anon"):
        assert read_only_violations(bad), "the law does not see: %s" % bad


@pytest.mark.parametrize("stem", STEMS)
def test_each_report_is_one_read_only_statement_returning_one_jsonb_row(stem):
    stmts = split_sql(strip_sql_comments(read(report(stem))))
    assert len(stmts) == 1, "%s must be ONE statement (the tool returns the last one's rows; the report is run where nothing may be written): %d" % (report(stem).name, len(stmts))
    stmt = stmts[0]
    assert re.match(r"(?is)\s*(with|select)\b", stmt), "the report does not start with WITH / SELECT"
    assert re.search(r"(?is)select\s+jsonb_build_object\(.*\)\s+as\s+report\s*$", stmt), "the report must end in one `select jsonb_build_object(…) as report`"
    assert "'hole_open'" in stmt, "the report computes no hole_open"
    assert "'migration', 'supabase/%s.sql'" % stem in stmt, "the report does not name its migration"
    violations = read_only_violations(stmt)
    assert not violations, "%s is not read-only: %s" % (report(stem).name, violations)


# ═════════════════════════════════════════════════════════════════════════
# B. RESTRICT ONLY
# ═════════════════════════════════════════════════════════════════════════

#: statements a migration's own block may not hold (function bodies it
#: creates are masked: they run when the function is called)
_NOT_RESTRICT_ONLY = [
    (re.compile(r"(?i)\binsert\s+into\b"), "inserts a row"),
    (re.compile(r"(?i)\bupdate\s+(?:only\s+)?[a-z_\"][a-z_0-9.\"]*\s+set\b"), "updates a row"),
    (re.compile(r"(?i)\bdelete\s+from\b"), "deletes a row"),
    (re.compile(r"(?i)\btruncate\b(?!')"), "truncates"),
    (re.compile(r"(?i)\b(create|drop|alter)\s+policy\b"), "creates, drops or alters a policy"),
    (re.compile(r"(?i)\b(enable|disable|force|no\s+force)\s+row\s+level\s+security\b"), "switches row level security"),
    (re.compile(r"(?i)\bdrop\s+(table|column|function|schema|view|type|index|constraint)\b"), "drops an object"),
    (re.compile(r"(?i)\balter\s+table\b(?!\s+public\.organizations\s+enable\s+trigger\s+organizations_guard_write)"), "alters a table"),
    (re.compile(r"(?i)\balter\s+default\s+privileges\b"), "alters default privileges"),
    (re.compile(r"(?i)\bcreate\s+(table|view|materialized|role|extension|schema|index)\b"), "creates an object that is not a guard"),
]
#: a quoted string that is itself a statement which is not a revoke (the
#: migrations build their revokes with `execute format('revoke …')`)
_STATEMENT_STRING = re.compile(
    r"(?i)^\s*(grant\s|insert\s+into\s|update\s+\S+\s+set\s|delete\s+from\s|truncate\s+\S|create\s+policy\s|drop\s+\S|alter\s+\S)")
_GRANT = re.compile(r"(?i)\bgrant\b[^;]*;")
#: the ONLY grants in the five files: H2 gives back, by name, what the revoke
#: from PUBLIC took from a role that held the privilege before the file ran
_H2_RESTORING_GRANT = re.compile(
    r"(?is)if\s+v_(auth|svc)_had\s+and\s+not\s+has_function_privilege\('(authenticated|service_role)',\s*v_fn,\s*'execute'\)\s+then\s+"
    r"grant\s+execute\s+on\s+function\s+public\.upsert_dashboard_config\(uuid,\s*jsonb\)\s+to\s+(authenticated|service_role)\s*;")


def restrict_only_violations(stem: str) -> list[str]:
    do = migration_statements(stem)[0]
    body = mask_nested_bodies(do)
    # words inside format('…') strings are statements too (execute format('revoke …')):
    # scan the block WITH its strings for the verbs, and without them for the rest.
    found = []
    for rx, what in _NOT_RESTRICT_ONLY:
        m = rx.search(mask_strings(body))
        if m:
            found.append("%s (%r)" % (what, m.group(0)))
    for s in re.findall(r"'((?:[^']|'')*)'", body):
        if _STATEMENT_STRING.search(s):
            found.append("an execute string that is not a revoke: %r" % s[:80])
    grants = _GRANT.findall(mask_strings(body))
    restoring = [m.group(0) for m in _H2_RESTORING_GRANT.finditer(body)]
    if stem == "schema_phase_dashboard_config_caller":
        if len(grants) != 2 or len(restoring) != 2:
            found.append("H2 must hold exactly the two restoring grants (authenticated, service_role), each "
                         "behind `v_…_had and not has_function_privilege(…)`: %d grant(s), %d restoring" % (len(grants), len(restoring)))
    elif grants:
        found.append("grants: %r" % grants[0][:100])
    return found


def test_the_restrict_only_law_sees_a_row_write_a_policy_and_a_grant():
    """The scanner, on planted blocks — so a scanner that stops seeing reds."""
    def violations(block_body: str) -> list[str]:
        do = "do $migration$\nbegin\n%s\nend\n$migration$" % block_body
        body = mask_nested_bodies(do)
        found = [what for rx, what in _NOT_RESTRICT_ONLY if rx.search(mask_strings(body))]
        found += ["execute string" for s in re.findall(r"'((?:[^']|'')*)'", body)
                  if _STATEMENT_STRING.search(s)]
        found += ["grant" for _g in _GRANT.findall(mask_strings(body))]
        return found
    assert violations("revoke insert on table public.t from anon;") == []
    assert violations("execute format('revoke %s on table public.%I from %I', a, b, c);") == []
    for bad in ("update public.subscriptions set tier = 'trial' where tier is null;",
                "insert into public.subscriptions (user_id) values (x);",
                "delete from public.organizations where archived_at is not null;",
                "create policy p on public.t for insert with check (true);",
                "alter table public.t enable row level security;",
                "grant insert on public.public_companies to authenticated;",
                "execute format('grant %s on table public.%I to %I', a, b, c);",
                "drop table public.t;"):
        assert violations(bad), "the law does not see: %s" % bad


@pytest.mark.parametrize("stem", STEMS)
def test_no_migration_touches_a_row_or_widens_access(stem):
    found = restrict_only_violations(stem)
    assert not found, (
        "%s.sql is not restrict-only — the owner's fence is 'migrations that only remove or "
        "restrict access'; no customer row, no policy, no grant: %s" % (stem, found))


def test_the_signup_migration_says_it_alters_no_existing_row_and_the_others_say_what_they_leave():
    h4 = read(migration("schema_phase_signup_tier_trial"))
    assert "'existing_rows_altered', 0" in h4
    for stem in STEMS:
        text = read(migration(stem))
        assert "ROLLBACK" in text or stem == "schema_phase_dashboard_config_caller", "%s.sql names no rollback" % stem
        assert "preflight/%s_preflight_report.sql" % stem in text, "%s.sql does not name its preflight report" % stem


# ═════════════════════════════════════════════════════════════════════════
# C. THE PAIRS AGREE
# ═════════════════════════════════════════════════════════════════════════

_H4_INSERT = (r"(insert\s+into\s+(?:public\.)?subscriptions\s*\(\s*user_id\s*,\s*plan\s*,)"
              r"(\s*billing_cycle\s*,\s*status\s*,\s*trial_start\s*,\s*trial_end\s*,"
              r"\s*current_period_start\s*,\s*current_period_end\s*\)\s*values\s*\(\s*new\.id\s*,\s*'professional'\s*,)"
              r"(\s*'monthly'\s*,\s*'trial'\s*,)")


def h4_replacement() -> str:
    """The replacement string of the migration's regexp_replace, as Python's."""
    text = read(migration("schema_phase_signup_tier_trial"))
    m = re.search(r"regexp_replace\(v_def,\s*c_insert,\s*'((?:[^']|'')*)',\s*'i'\)", text)
    assert m, "the migration's patch statement was not found"
    return m.group(1).replace("''", "'")


def h4_patched(body: str) -> str:
    return re.sub(_H4_INSERT, lambda m: re.sub(r"\\(\d)", lambda g: m.group(int(g.group(1))), h4_replacement()),
                  body, count=1, flags=re.I)


def test_the_signup_pattern_in_this_file_is_the_migrations():
    text = read(migration("schema_phase_signup_tier_trial"))
    m = re.search(r"c_insert\s+constant\s+text\s*:=\s*(.*?);", text, re.S)
    assert m
    sql_pattern = "".join(re.findall(r"'((?:[^']|'')*)'", m.group(1))).replace("''", "'")
    assert sql_pattern == _H4_INSERT, "the migration's c_insert changed: this file must test the same pattern"


def test_each_report_recognises_exactly_the_body_its_migration_installs():
    # H2 — the checked body, and the repository's original
    h2_new = md5(function_body(migration("schema_phase_dashboard_config_caller"), "upsert_dashboard_config"))
    h2_old = md5(function_body(SUPABASE / "schema_phase_dashboard_config.sql", "upsert_dashboard_config"))
    h2_report = read(report("schema_phase_dashboard_config_caller"))
    assert h2_new != h2_old
    assert set(re.findall(r"body_md5\s*(?:<>|=)\s*'([0-9a-f]{32})'", h2_report)) == {h2_new, h2_old}, (
        "the dashboard report tests a body md5 that is not the migration's (%s) / the original's (%s): after the "
        "migration it would keep saying hole_open: true — or say false over an unchecked body" % (h2_new, h2_old))
    assert "fn.body_md5 <> '%s'" % h2_new in h2_report, "function_open must be decided by the migration's body"

    # H1 — the guard
    h1 = md5(function_body(migration("schema_phase_workspace_cap_guard"), "_organizations_guard_write"))
    h1_report = read(report("schema_phase_workspace_cap_guard"))
    assert re.findall(r"md5\(p\.prosrc\)\s*=\s*'([0-9a-f]{32})'", h1_report) == [h1], (
        "the workspace report's guard_in_place tests another body than the migration installs (%s)" % h1)
    assert "t.tgtype = 23" in h1_report and "tgtype <> 23" in read(migration("schema_phase_workspace_cap_guard")), \
        "the report and the migration must agree on the trigger's events (BEFORE INSERT OR UPDATE, ROW = 23)"
    assert "before insert or update on public.organizations" in read(migration("schema_phase_workspace_cap_guard"))

    # H4 — the two functions the repository defines, and each as patched
    v2 = function_body(SUPABASE / "schema_phase3.sql", "handle_new_user_v2")
    v1 = function_body(SUPABASE / "schema.sql", "handle_new_user")
    assert len(re.findall(_H4_INSERT, v2, re.I)) == 1 and len(re.findall(_H4_INSERT, v1, re.I)) == 1, \
        "the repository's signup functions no longer hold the statement the migration patches"
    h4_report = read(report("schema_phase_signup_tier_trial"))
    labelled = dict(re.findall(r"when\s+'([0-9a-f]{32})'\s+then\s+'([^']+)'", h4_report))
    want = {md5(v2): "handle_new_user_v2 as", md5(v1): "handle_new_user as",
            md5(h4_patched(v2)): "handle_new_user_v2, patched", md5(h4_patched(v1)): "handle_new_user, patched"}
    assert set(labelled) == set(want), "the signup report labels bodies the repository does not define: %s" % sorted(set(labelled) ^ set(want))
    for digest, prefix in want.items():
        assert labelled[digest].startswith(prefix), "%s is labelled %r" % (digest, labelled[digest])


def report_values(stem: str, cte: str) -> list[tuple]:
    text = strip_sql_comments(read(report(stem)))
    m = re.search(r"(?is)\b%s\s*\([^)]*\)\s+as\s*\(\s*values(.*?)\)\s*\)\s*,?\s*(?:[a-z_]+\s*(?:\(|as)|select)" % cte, text)
    assert m, "the report has no %s(…) as (values …)" % cte
    return [tuple(v.replace("''", "'") for v in re.findall(r"'((?:[^']|'')*)'", row))
            for row in re.findall(r"\(([^()]*)\)", m.group(1) + ")")]


def test_each_report_names_exactly_the_tables_its_migration_lists():
    listed = report_values("schema_phase_public_tables_write_revoke", "listed")
    assert sorted(n for n, _b in listed) == sorted(RLS_OFF + UNSCOPED), \
        "the public-tables report lists other tables than the migration closes"
    assert {n for n, b in listed if b == "row level security off"} == set(RLS_OFF)
    assert MEASURED_TWELVE <= set(RLS_OFF), "a table the review measured open is no longer on the list: %s" % sorted(MEASURED_TWELVE - set(RLS_OFF))
    derived = report_values("schema_phase_derived_tables_write_revoke", "listed")
    assert sorted(n for (n,) in derived) == sorted(DERIVED), "the derived-tables report lists other tables than the migration closes"

    known = dict(report_values("schema_phase_public_tables_write_revoke", "known"))
    assert not set(known) & set(RLS_OFF + UNSCOPED), "a table is both on the list and in the census classification"
    by_file = {n for n, what in known.items() if what == "closed by schema_phase_derived_tables_write_revoke.sql"}
    assert by_file == set(DERIVED), "the census says the derived-tables file closes %s; it closes %s" % (sorted(by_file), sorted(DERIVED))
    assert known.get("dashboard_configs") == "closed by schema_phase_dashboard_config_caller.sql"
    assert known.get("organizations") == "a user's JWT writes it"


def test_the_guarded_columns_are_the_same_in_the_guard_and_in_the_report():
    body = function_body(migration("schema_phase_workspace_cap_guard"), "_organizations_guard_write")
    m = re.search(r"foreach\s+v_col\s+in\s+array\s+array\[([^\]]*)\]", body)
    assert m and re.findall(r"'([a-z_]+)'", m.group(1)) == GUARDED_COLUMNS, "the guard's column list changed"
    rep = read(report("schema_phase_workspace_cap_guard"))
    m = re.search(r"a\.attname\s+in\s*\(([^)]*)\)", rep)
    assert m and re.findall(r"'([a-z_]+)'", m.group(1)) == GUARDED_COLUMNS, "the report's guarded column list is not the guard's"
    assert not set(GUARDED_COLUMNS) & ORG_COLUMNS_A_USER_WRITES


def test_the_guard_asks_create_workspace_under_a_lock_and_replaces_no_workspace_function():
    """ONE cap authority: the guard calls create_workspace (it holds no cap
    number of its own), one request at a time per user."""
    body = function_body(migration("schema_phase_workspace_cap_guard"), "_organizations_guard_write")
    lock = body.find("pg_advisory_xact_lock(")
    probe = body.find("perform public.create_workspace(")
    assert 0 < lock < probe, "the per-user lock must be taken BEFORE create_workspace is asked — or two requests at once both pass"
    assert re.search(r"when\s+sqlstate\s+'ZC001'\s+then\s+null", body), "the probe's own exception is the only one swallowed"
    assert not re.search(r"\bthen\s+\d+\b|\belse\s+\d+\s+end\b", body), "a cap number in the guard: the numbers are create_workspace's"
    assert "security definer" not in read(migration("schema_phase_workspace_cap_guard")).split("create or replace function public._organizations_guard_write()")[1].split("as $$")[0].lower(), \
        "the guard must be SECURITY INVOKER: current_user is how it tells a browser session from a workspace function"
    text = strip_sql_comments(read(migration("schema_phase_workspace_cap_guard")))
    created = re.findall(r"(?i)create\s+or\s+replace\s+function\s+([a-z_.]+)", text)
    assert created == ["public._organizations_guard_write"], "the workspace migration replaces a function that is not its guard: %s" % created
    assert "raise exception 'workspace cap guard: a workspace function body changed during this file" in text


# ═════════════════════════════════════════════════════════════════════════
# D. NOBODY WITH A USER'S JWT WRITES WHAT THE FILES CLOSE
# ═════════════════════════════════════════════════════════════════════════

SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
SKIP_DIRS = {"node_modules", "dist", "build", ".expo", ".vite", "coverage"}
_FROM = re.compile(r"""\.from\(\s*["'`]([A-Za-z_0-9]+)["'`]\s*\)""")
_WRITE_VERB = re.compile(r"\.\s*(insert|update|upsert|delete)\s*\(")
_RPC = re.compile(r"""\.rpc\(\s*["'`]([A-Za-z_0-9]+)["'`]""")


def source_files(*roots: str) -> list[Path]:
    out = []
    for root in roots:
        base = REPO / root
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            rel = p.relative_to(REPO)
            if p.suffix not in SOURCE_SUFFIXES or not p.is_file() or SKIP_DIRS & set(rel.parts):
                continue
            if "__tests__" in rel.parts or ".test." in p.name or ".spec." in p.name:
                continue
            out.append(p)
    return out


def chain_after(text: str, start: int) -> str:
    """The method chain that follows `.from("t")`: up to the statement's end."""
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


def client_writes(text: str, tables) -> list[tuple[str, str]]:
    out = []
    for m in _FROM.finditer(text):
        if m.group(1) in tables:
            for verb in sorted(set(_WRITE_VERB.findall(chain_after(text, m.end())))):
                out.append((m.group(1), verb))
    return out


def names_a_closed_table_and_writes(text: str, tables) -> list[str]:
    """The evasions a chain scan misses: the table name in a constant or a
    variable, a REST path, a GraphQL mutation — any file that names a closed
    table in quotes AND makes a write call."""
    bare = re.sub(r"(?s)/\*.*?\*/", "", re.sub(r"(?m)^\s*//.*$", "", text))
    named = sorted({t for t in tables if re.search(r"""["'`/]%s["'`?]""" % re.escape(t), bare)})
    if not named:
        return []
    # `.delete(` / `.update(` are also Map, Set and hash methods: a write call
    # counts where the file holds a supabase-js table handle or names the
    # REST / GraphQL endpoint itself.
    talks_to_the_api = ".from(" in bare or "/rest/v1" in bare or "/graphql/v1" in bare
    writes = bool(_WRITE_VERB.search(bare)) or bool(re.search(r"""method:\s*["'`](POST|PATCH|PUT|DELETE)["'`]""", bare)) \
        or "/graphql/v1" in bare
    return named if (writes and talks_to_the_api) else []


def test_the_browser_scanner_sees_a_writer_and_the_evasions():
    t = ["briefings", "public_companies"]
    assert client_writes('await sb.from("briefings").update({ body }).eq("org_id", o);', t) == [("briefings", "update")]
    assert client_writes("sb.from('public_companies')\n  .upsert(rows)", t) == [("public_companies", "upsert")]
    assert client_writes('await sb.from("briefings").select("*").eq("org_id", o);', t) == []
    assert names_a_closed_table_and_writes('const T = "briefings"; const q = sb.from(T); q.update({ body });', t) == ["briefings"]
    assert names_a_closed_table_and_writes('fetch(url + "/rest/v1/public_companies?id=eq.1", { method: "PATCH" })', t) == ["public_companies"]
    assert names_a_closed_table_and_writes('// we never write "briefings" here\nsb.from("x").update({})', t) == []
    assert names_a_closed_table_and_writes('const rows = await sb.from("briefings").select("*");', t) == []


def test_no_browser_mobile_or_edge_function_code_writes_a_closed_table():
    files = source_files("frontend", "mobile", "supabase/functions")
    assert len(files) > 300, "the source walk found %d files — it is not reading the frontend" % len(files)
    seen_org = False
    offenders = []
    for p in files:
        text = read(p)
        rel = p.relative_to(REPO).as_posix()
        seen_org = seen_org or bool(client_writes(text, ["organizations"]))
        for table, verb in client_writes(text, CLOSED_TABLES):
            offenders.append("%s: .from(%r).%s()" % (rel, table, verb))
        for table in names_a_closed_table_and_writes(text, CLOSED_TABLES):
            offenders.append("%s names %r and makes a write call" % (rel, table))
        if "upsert_dashboard_config" in _RPC.findall(text):
            offenders.append("%s calls rpc upsert_dashboard_config" % rel)
    assert seen_org, "the scanner no longer sees frontend/lib/org.ts writing organizations — it sees nothing"
    assert not offenders, (
        "a browser / mobile / edge-function file writes a table whose write privileges the hole "
        "migrations REVOKE from anon and authenticated — it answers 403 where they are applied. "
        "Write it through the engine (service role), or take the table off the migration's list "
        "and say who scopes the write:\n  " + "\n  ".join(sorted(set(offenders))))


# ── the engine: per_user(jwt) clients ────────────────────────────────────

ENGINE = REPO / "src" / "engine"
_WRITE_METHODS = {"insert", "update", "upsert", "delete", "update_returning", "insert_returning", "upsert_returning"}


class _EngineCensus:
    """Every `with _supabase.per_user(…) as c:` block: the table calls made
    on `c` inside it, and — to a fixpoint — inside every function `c` is
    passed to (matched by name across the engine: over-approximate)."""

    def __init__(self) -> None:
        self.trees = {}
        self.functions = {}
        for p in sorted(ENGINE.rglob("*.py")):
            try:
                tree = ast.parse(read(p))
            except SyntaxError:
                continue
            self.trees[p] = tree
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    self.functions.setdefault(node.name, []).append((p, node))
        self.consts = {p: {n.targets[0].id: n.value.value for n in t.body
                           if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)
                           and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str)}
                       for p, t in self.trees.items()}
        self.blocks = 0
        #: (table, verb, where, the call node, the path)
        self.writes = []
        for path, tree in self.trees.items():
            for node in ast.walk(tree):
                if not isinstance(node, (ast.With, ast.AsyncWith)):
                    continue
                for item in node.items:
                    call = item.context_expr
                    if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                            and call.func.attr == "per_user" and isinstance(item.optional_vars, ast.Name)):
                        self.blocks += 1
                        self._walk(node.body, item.optional_vars.id, path, set(), None)

    def _table(self, arg, path) -> str:
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            return arg.value
        if isinstance(arg, ast.Name):
            return self.consts[path].get(arg.id, "<%s>" % arg.id)
        return "<expr>"

    def _walk(self, body, var, path, seen, via) -> None:
        rel = path.relative_to(REPO).as_posix()
        for stmt in body:
            for node in ast.walk(stmt):
                if not isinstance(node, ast.Call):
                    continue
                f = node.func
                on_client = isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == var
                if on_client and f.attr in _WRITE_METHODS and node.args:
                    self.writes.append((self._table(node.args[0], path), f.attr,
                                        "%s:%d%s" % (rel, node.lineno, " (via %s)" % via if via else ""), node, path, stmt))
                if on_client and f.attr == "rpc" and node.args:
                    self.writes.append(("rpc:" + self._table(node.args[0], path), "rpc",
                                        "%s:%d" % (rel, node.lineno), node, path, stmt))
                passed = None
                for i, a in enumerate(node.args):
                    if isinstance(a, ast.Name) and a.id == var:
                        passed = i
                for kw in node.keywords:
                    if isinstance(kw.value, ast.Name) and kw.value.id == var:
                        passed = kw.arg
                if passed is None or on_client:
                    continue
                name = f.attr if isinstance(f, ast.Attribute) else (f.id if isinstance(f, ast.Name) else None)
                for hpath, fn in self.functions.get(name or "", []):
                    params = [a.arg for a in fn.args.posonlyargs + fn.args.args]
                    if params and params[0] in ("self", "cls"):
                        params = params[1:]
                    if isinstance(passed, int):
                        if passed >= len(params):
                            continue
                        hvar = params[passed]
                    else:
                        hvar = passed
                        if hvar not in params + [a.arg for a in fn.args.kwonlyargs]:
                            continue
                    key = (hpath, fn.name, hvar)
                    if key in seen:
                        continue
                    seen.add(key)
                    self._walk(fn.body, hvar, hpath, seen, "%s:%d" % (rel, node.lineno))


@pytest.fixture(scope="module")
def census() -> _EngineCensus:
    return _EngineCensus()


def test_the_engine_census_sees_the_user_jwt_writers_that_exist(census):
    """DISCOVERY CANARY: a census that finds nothing passes every law below."""
    assert census.blocks >= 60, "only %d per_user(jwt) blocks found — the census is not reading the engine" % census.blocks
    tables = {t for t, _v, _w, _n, _p, _s in census.writes}
    for must in ("documents", "organizations", "company_industry_assignments", "rpc:create_workspace", "rpc:set_org_pref"):
        assert must in tables, "the census no longer sees the user-JWT write of %r" % must


def test_no_user_jwt_client_in_the_engine_writes_a_closed_table(census):
    offenders = sorted({"%s %s — %s" % (t, v, w) for t, v, w, _n, _p, _s in census.writes
                        if t in CLOSED_TABLES or t == "rpc:upsert_dashboard_config"})
    assert not offenders, (
        "a per_user(jwt) client in the engine writes a table the hole migrations revoke from "
        "authenticated — the request answers 403 where they are applied. Use the service role "
        "after verifying the caller (the pattern every other writer of these tables follows):\n  "
        + "\n  ".join(offenders))
    dynamic = sorted({w for t, _v, w, _n, _p, _s in census.writes if t.startswith("<")})
    assert not dynamic, "a per_user(jwt) write whose table is not a literal — the census cannot classify it: %s" % dynamic


def _dict_keys(node, enclosing) -> set | None:
    """The keys a patch dict can hold: a literal's, or — for a name — the
    literal it is assigned plus every `name.update({...})` / `name[k] = …`
    in the enclosing statements."""
    if isinstance(node, ast.Dict):
        if not all(isinstance(k, ast.Constant) and isinstance(k.value, str) for k in node.keys):
            return None
        return {k.value for k in node.keys}
    if isinstance(node, ast.Name):
        keys, found = set(), False
        for n in ast.walk(enclosing):
            if isinstance(n, (ast.Assign, ast.AnnAssign)):
                targets = n.targets if isinstance(n, ast.Assign) else [n.target]
                if any(isinstance(t, ast.Name) and t.id == node.id for t in targets) and n.value is not None:
                    k = _dict_keys(n.value, enclosing) if not isinstance(n.value, ast.Name) else None
                    if k is None:
                        return None
                    keys |= k
                    found = True
                if any(isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == node.id for t in targets):
                    sub = [t for t in targets if isinstance(t, ast.Subscript)][0]
                    if not (isinstance(sub.slice, ast.Constant) and isinstance(sub.slice.value, str)):
                        return None
                    keys.add(sub.slice.value)
            if (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "update"
                    and isinstance(n.func.value, ast.Name) and n.func.value.id == node.id and n.args):
                k = _dict_keys(n.args[0], enclosing) if isinstance(n.args[0], ast.Dict) else None
                if k is None:
                    return None
                keys |= k
        return keys if found else None
    return None


def _enclosing_function(tree, node):
    best = None
    for fn in ast.walk(tree):
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and fn.lineno <= node.lineno <= (fn.end_lineno or fn.lineno):
            if best is None or fn.lineno > best.lineno:
                best = fn
    return best


def test_every_user_jwt_writer_of_organizations_writes_only_columns_the_guard_leaves(census):
    # the engine
    sites = [(w, n, p) for t, v, w, n, p, _s in census.writes if t == "organizations"]
    assert len(sites) >= 3, "the census sees %d user-JWT writes of organizations (the upload commit makes at least 3)" % len(sites)
    for where, call, path in sites:
        assert call.func.attr == "update", "%s: a user-JWT %s of organizations (only UPDATE has a policy)" % (where, call.func.attr)
        fn = _enclosing_function(census.trees[path], call)
        keys = _dict_keys(call.args[1], fn) if len(call.args) > 1 and fn is not None else None
        assert keys is not None, "%s: the columns of this organizations update cannot be read from the source — write a literal" % where
        assert keys <= ORG_COLUMNS_A_USER_WRITES, (
            "%s writes organizations.%s with the user's JWT. A guarded column (%s) is refused by "
            "organizations_guard_write; any other new column must be added to "
            "ORG_COLUMNS_A_USER_WRITES here after checking the guard does not need it."
            % (where, sorted(keys - ORG_COLUMNS_A_USER_WRITES), ", ".join(GUARDED_COLUMNS)))

    # the browser
    found = 0
    for p in source_files("frontend", "mobile", "supabase/functions"):
        text = read(p)
        for m in _FROM.finditer(text):
            if m.group(1) != "organizations":
                continue
            chain = chain_after(text, m.end())
            for verb, arg in re.findall(r"\.\s*(insert|update|upsert|delete)\s*\(\s*([^)]*)\)", chain):
                found += 1
                where = "%s:%d" % (p.relative_to(REPO).as_posix(), text.count("\n", 0, m.start()) + 1)
                assert verb == "update", "%s: the browser makes a %s on organizations" % (where, verb)
                arg = arg.strip()
                if arg.startswith("{"):
                    keys = set(re.findall(r"([A-Za-z_][A-Za-z_0-9]*)\s*:", arg))
                else:
                    # a named patch: its declared type, in the lines above the call
                    before = text[max(0, m.start() - 1500):m.start()]
                    decl = re.findall(r"\b%s\s*:\s*\{([^}]*)\}" % re.escape(arg), before)
                    assert decl, "%s: organizations.update(%s) — the patch's columns cannot be read from the source" % (where, arg)
                    keys = set(re.findall(r"([A-Za-z_][A-Za-z_0-9]*)\??\s*:", decl[-1]))
                assert keys and keys <= ORG_COLUMNS_A_USER_WRITES, (
                    "%s writes organizations.%s from the browser — a guarded column is refused by "
                    "organizations_guard_write (use archive_workspace / restore_workspace / the firm functions)"
                    % (where, sorted(keys - ORG_COLUMNS_A_USER_WRITES)))
    assert found >= 3, "the scanner sees %d browser writes of organizations (frontend/lib/org.ts makes 3)" % found


# ═════════════════════════════════════════════════════════════════════════
# E. NO OTHER COMMITTED SQL RE-OPENS ONE
# ═════════════════════════════════════════════════════════════════════════

def other_sql_files() -> list[Path]:
    mine = {migration(s) for s in STEMS}
    files = [p for p in sorted(SUPABASE.rglob("*.sql")) if p not in mine and PREFLIGHT not in p.parents]
    assert len(files) >= 40, "only %d committed SQL files found" % len(files)
    return files


_GRANT_STMT = re.compile(r"(?is)\bgrant\s+(.*?)\s+on\s+(.*?)\s+to\s+(.*)$")
_API_ROLE = re.compile(r"(?i)\b(anon|authenticated|public)\b")
_WRITE_PRIV = re.compile(r"(?i)\b(insert|update|delete|truncate|all)\b")


def sql_reopenings(text: str, name: str = "") -> list[str]:
    """What in a committed SQL file would re-open one of the holes."""
    found = []
    stmts = split_sql(strip_sql_comments(text))
    # statements inside DO blocks and function bodies count too
    inner = []
    for s in stmts:
        for m in re.finditer(r"(?s)(\$[A-Za-z_]*\$)(.*?)\1", s):
            inner += split_sql(m.group(2))
    for s in stmts + inner:
        bare = re.sub(r"\s+", " ", mask_strings(s).replace('"', "")).strip()
        g = _GRANT_STMT.search(bare)      # `begin grant …` inside a block is a grant too
        if g and not re.match(r"(?i)\s*(function|schema|sequence|usage)\b", g.group(2)) and _WRITE_PRIV.search(g.group(1)) \
                and _API_ROLE.search(g.group(3)):
            objs = re.sub(r"(?i)^table\s+", "", g.group(2))
            if re.search(r"(?i)all\s+tables\s+in\s+schema\s+public", objs):
                found.append("grants %s on ALL tables in schema public to an API role" % g.group(1))
            for t in CLOSED_TABLES:
                if re.search(r"(?i)(^|[\s,.])%s($|[\s,])" % re.escape(t), objs):
                    found.append("grants %s on %s to an API role" % (g.group(1).strip(), t))
        if re.search(r"(?i)organizations_guard_write", bare):
            found.append("names the workspace guard (%s…): nothing but its migration may drop, disable or replace it" % bare[:50])
        if re.search(r"(?i)alter\s+table\s+(only\s+)?(public\.)?organizations\s+disable\s+trigger", bare):
            found.append("disables a trigger on organizations")
    for m in re.finditer(r"(?is)create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?upsert_dashboard_config\b", strip_sql_comments(text)):
        if name != "schema_phase_dashboard_config.sql":
            found.append("defines upsert_dashboard_config (the caller check lives in schema_phase_dashboard_config_caller.sql)")
    return found


def signup_seeds(text: str) -> list[str]:
    """Each `insert into subscriptions (cols) values (new.id, …)` — a signup
    trigger's seed — as its column list."""
    return [re.sub(r"\s+", " ", cols).strip()
            for cols in re.findall(r"(?is)insert\s+into\s+(?:public\.)?subscriptions\s*\(([^)]*)\)\s*values\s*\(\s*new\.id\b",
                                   strip_sql_comments(text))]


def test_the_sql_scanner_sees_the_statements_that_re_open_a_hole():
    assert sql_reopenings("revoke insert on public.public_companies from anon; grant select on public.public_companies to anon;") == []
    assert sql_reopenings("grant execute on function public.create_workspace(text, text, text) to authenticated;") == []
    for bad in ("grant insert, update on public.public_companies to anon;",
                'grant all on table "public"."briefings" to authenticated;',
                "grant update (cards) on dashboard_configs to authenticated;",
                "grant all on all tables in schema public to anon, authenticated;",
                "do $$ begin grant delete on statement_line_items to authenticated; end $$;",
                "drop trigger if exists organizations_guard_write on public.organizations;",
                "alter table public.organizations disable trigger all;",
                "create or replace function public._organizations_guard_write() returns trigger language plpgsql as $f$ begin return new; end $f$;",
                "create or replace function upsert_dashboard_config(p_user_id uuid, p_cards jsonb) returns jsonb language sql as $f$ select p_cards $f$;"):
        assert sql_reopenings(bad, "a_new_file.sql"), "the scanner does not see: %s" % bad
    assert signup_seeds("insert into public.subscriptions (user_id, plan) values (new.id, 'professional');") == ["user_id, plan"]


#: the files that DEFINE what a migration closes — re-running one re-opens
#: it, and each is named in the migration's own re-run warning
KNOWN_ORIGINALS = {
    "schema_phase_dashboard_config_caller": {"schema_phase_dashboard_config.sql"},
    "schema_phase_signup_tier_trial": {"schema.sql", "schema_phase3.sql"},
    "schema_phase_public_tables_write_revoke": {"schema_phase_nasdaq_public_companies.sql",
                                                "schema_phase_intelligence_engine.sql",
                                                "schema_phase_f3_calibration.sql"},
}


def test_no_other_committed_sql_reopens_a_hole():
    offenders = []
    seeders = set()
    creators = {}
    for p in other_sql_files():
        text = read(p)
        for why in sql_reopenings(text, p.name):
            offenders.append("%s %s" % (p.name, why))
        for cols in signup_seeds(text):
            seeders.add(p.name)
            if p.name not in KNOWN_ORIGINALS["schema_phase_signup_tier_trial"] and not re.search(r"\btier\b", cols):
                offenders.append("%s seeds a signup's subscriptions row without a tier (%s) — the engine then reads "
                                 "plan, and 'professional' is the Multi-Country allowance" % (p.name, cols))
        for t in re.findall(r"(?i)create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_0-9]+)", strip_sql_comments(text)):
            if t in RLS_OFF + UNSCOPED:
                creators.setdefault(t, set()).add(p.name)
    assert not offenders, "committed SQL re-opens a hole a migration closed:\n  " + "\n  ".join(sorted(set(offenders)))
    assert seeders == KNOWN_ORIGINALS["schema_phase_signup_tier_trial"], (
        "the files that seed a signup's subscriptions row are %s — the signup migration's re-run warning names %s"
        % (sorted(seeders), sorted(KNOWN_ORIGINALS["schema_phase_signup_tier_trial"])))
    assert set(creators) == set(RLS_OFF + UNSCOPED), "no committed file creates: %s" % sorted(set(RLS_OFF + UNSCOPED) - set(creators))
    made_by = set().union(*creators.values())
    assert made_by == KNOWN_ORIGINALS["schema_phase_public_tables_write_revoke"], (
        "the listed tables are created by %s; the migration's new-environment warning names %s"
        % (sorted(made_by), sorted(KNOWN_ORIGINALS["schema_phase_public_tables_write_revoke"])))


@pytest.mark.parametrize("stem", sorted(KNOWN_ORIGINALS))
def test_each_migration_warns_about_the_files_that_re_open_it(stem):
    header = read(migration(stem)).split("do $migration$")[0]
    for original in sorted(KNOWN_ORIGINALS[stem]):
        assert original in header, (
            "%s.sql does not tell the operator to re-run it after supabase/%s (which re-creates what it closes)"
            % (stem, original))
    assert "⚠" in header


# ═════════════════════════════════════════════════════════════════════════
# F. THE ENGINE GIVES THE ROW H4 SEEDS THE TRIAL
# ═════════════════════════════════════════════════════════════════════════

def seeded_row(body: str) -> dict:
    m = re.search(r"(?is)insert\s+into\s+(?:public\.)?subscriptions\s*\(([^)]*)\)\s*values\s*\((.*?)\)\s*on\s+conflict", body)
    assert m, "no subscriptions seed in the function body"
    cols = [c.strip() for c in m.group(1).split(",")]
    vals = [v.strip() for v in re.split(r",(?![^()]*\))", m.group(2))]
    assert len(cols) == len(vals), "the seed's columns and values do not pair: %s / %s" % (cols, vals)
    return {c: (v[1:-1] if v.startswith("'") and v.endswith("'") else v) for c, v in zip(cols, vals)}


def test_the_engine_gives_a_new_signup_the_trial_and_gave_the_shipped_row_multi_country():
    from engine.api import _pricing_config

    plan_state = read(REPO / "src" / "engine" / "api" / "_plan_state.py")
    assert 'raw_tier = row.get("tier") or row.get("plan") or ""' in plan_state, (
        "get_plan_state no longer resolves `tier or plan` — this law models that expression; "
        "re-read what the engine gives a row with no tier")

    def engine_plan(row: dict) -> str:
        plan = _pricing_config.plan_for(str(row.get("tier") or row.get("plan") or ""))
        return (plan or _pricing_config.CONFIG.plans["trial"]).key

    shipped = function_body(SUPABASE / "schema_phase3.sql", "handle_new_user_v2")
    before = seeded_row(shipped)
    assert "tier" not in before and before["plan"] == "professional"
    assert engine_plan(before) == "multi", (
        "the hole this law exists for is no longer in the repository's signup function — then "
        "the migration and this law are to be re-read, not kept")

    after = seeded_row(h4_patched(shipped))
    assert after.get("tier") == "trial", "the migration's patch does not seed tier 'trial': %s" % after
    assert {k: v for k, v in after.items() if k != "tier"} == before, "the patch changes more than the tier: %s" % after
    assert engine_plan(after) == "trial", "the engine does not resolve the patched row to the trial plan"
    trial = _pricing_config.CONFIG.plans["trial"]
    assert engine_plan(after) == trial.key and trial.max_workspaces == 1


# ═════════════════════════════════════════════════════════════════════════
# G. THE GATES ADDRESS NO DATABASE BY DEFAULT
# ═════════════════════════════════════════════════════════════════════════

def run_gate(script: str, url: str | None) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("ENTITLEMENT_HOLES_") and not k.startswith("PG") and k != "HOLE_MIGRATION"}
    if url is not None:
        env["ENTITLEMENT_HOLES_DB_URL"] = url
    return subprocess.run(["bash", str(SCRIPTS / script)], cwd=REPO, env=env,
                          capture_output=True, text=True, timeout=60)


@pytest.mark.parametrize("script,gate", [(h[2], h[3]) for h in HOLES])
def test_each_gate_is_vacuous_unless_it_is_told_which_database(script, gate):
    r = run_gate(script, None)
    out = r.stdout + r.stderr
    assert r.returncode == 0, "the gate did not exit 0 with no database named:\n%s" % out
    assert "VACUOUS" in out and "GATE-WORK %s units=0" % gate in out, (
        "with no ENTITLEMENT_HOLES_DB_URL the gate must print VACUOUS and units=0 — never run "
        "against a default stack (it shows a hole OPEN there), never a green count:\n%s" % out)
    assert "PASS %s" % gate not in out, "a vacuous run printed a PASS line"


NOT_LOCAL = [
    "postgresql://postgres:x@db.example.com:5432/postgres",
    "postgresql://postgres:x@10.0.0.5:5432/postgres",
    "postgresql://postgres:x@127.0.0.1:5432/postgres?host=db.example.com",
    "postgresql://postgres:x@127.0.0.1,db.example.com:5432/postgres",
    "postgresql://postgres:x@127.0.0.1:5432/post%67res",
    "postgresql://postgres:x@localhost@db.example.com:5432/postgres",
    "host=db.example.com dbname=postgres user=postgres",
    "postgresql://127.0.0.1:5432/postgres",
]


@pytest.mark.parametrize("script,gate", [(h[2], h[3]) for h in HOLES])
def test_each_gate_refuses_a_database_that_is_not_plainly_local(script, gate):
    for url in NOT_LOCAL:
        r = run_gate(script, url)
        out = r.stdout + r.stderr
        assert r.returncode == 2 and "REFUSED" in out and "GATE-WORK %s units=0" % gate in out, (
            "the gate did not refuse %r with exit 2 before opening anything (it builds a database "
            "and shows a hole open — never on a hosted one):\nexit %s\n%s" % (url, r.returncode, out))
        assert "x@" not in out, "the refusal printed the URL (its password)"


def test_the_gate_library_has_no_default_database_and_requests_run_as_authenticator():
    lib = read(LIB)
    defaults = re.findall(r"\$\{ENTITLEMENT_HOLES_DB_URL:-([^}]*)\}", lib)
    assert defaults and all(d == "" for d in defaults), (
        "scripts/entitlement_holes/lib.sh gives ENTITLEMENT_HOLES_DB_URL a default (%r): a default "
        "addresses whatever stack is on that port, and the gate shows a hole OPEN there" % defaults)
    assert not re.search(r"(?i)postgres(ql)?://[^\s\"']*@(127\.0\.0\.1|localhost)[^\s\"']*", re.sub(r"(?m)^\s*#.*$|echo .*$", "", lib)), \
        "a database URL is written into the gate library"
    m = re.search(r"(?s)\nsql_as\(\) \{.*?\n\}", lib)
    assert m and "holes_api_psql" in m.group(0) and "holes_psql" not in m.group(0).replace("holes_api_psql", ""), \
        "sql_as must run its request in an authenticator session (holes_api_psql)"
    for _hole, _stem, gate, _gid in HOLES:
        text = re.sub(r"(?m)^\s*#.*$", "", read(SCRIPTS / gate))
        assert not re.search(r"(?i)\bset\s+(local\s+|session\s+)?role\b", text), (
            "scripts/%s sets a role itself. A request is made with sql_as (an authenticator session): "
            "a refused function call under `set role` in a postgres session crashes the local "
            "Supabase Postgres, and every session on that cluster with it" % gate)
        assert re.search(r'holes_build_scratch \w+', text) and "holes_finish" in text and "holes_connect" in text
