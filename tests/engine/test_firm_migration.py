"""supabase/schema_phase_firm_requests.sql — checked against the code
that writes to it, without a database.

There is no Postgres in this checkout, so the migration is held to the
things a static read CAN prove: every table the code writes exists with
every column the code writes, every CHECK list equals the Python
constant that feeds it, RLS is on everywhere, no policy repeats the
memberships self-reference trap, the tenancy FK is guarded, and the file
ends with the locked NOTIFY. Applying it is the operator's Studio step
(runbook in the file header).

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List

import pytest

from engine.api import _firm_requests as FR

REPO = Path(__file__).resolve().parents[2]
SQL = REPO / "supabase" / "schema_phase_firm_requests.sql"


@pytest.fixture(scope="module")
def sql() -> str:
    return SQL.read_text("utf-8")


def _tables(sql: str) -> Dict[str, str]:
    out = {}  # type: Dict[str, str]
    for m in re.finditer(r"create table if not exists (\w+) \((.*?)\n\);", sql, flags=re.S):
        out[m.group(1)] = m.group(2)
    return out


def _columns(block: str) -> List[str]:
    cols = []  # type: List[str]
    for line in block.splitlines():
        line = line.strip()
        m = re.match(r"^([a-z_]+)\s+(uuid|text|date|int|jsonb|boolean|timestamptz)\b", line)
        if m:
            cols.append(m.group(1))
    return cols


#: Every column the backend writes, per table — read this list against
#: the code when it changes; the test fails loudly on drift.
WRITTEN = {
    "firm_client_cadence": ["client_org_id", "firm_id", "cadence", "deadline_days_after_period_end",
                            "fiscal_year_end_month", "nudge_days_before", "set_by"],
    "firm_file_requests": ["id", "firm_id", "client_org_id", "period_end", "requested_by", "requested_at",
                           "expires_at", "token_hash", "to_email", "note", "status", "expected_identity",
                           "reminders_sent", "reminder_count", "last_reminded_at", "refusal_count",
                           "consumed_at", "document_id", "entity_guard", "period_guard"],
    "firm_file_request_tokens": ["request_id", "token"],
    "firm_digest_prefs": ["user_id", "firm_id", "enabled", "frequency", "send_hour_utc", "last_sent_at",
                          "last_item_set_hash", "last_item_ids"],
    "firm_digest_log": ["user_id", "firm_id", "sent_for_date", "item_set_hash", "item_count",
                        "queued_email_id"],
    "firm_email_queue": ["kind", "firm_id", "client_org_id", "request_id", "user_id", "to_email", "send_at",
                         "template", "payload", "status", "error", "sent_at"],
    "firm_briefs": ["firm_key", "firm_id", "client_org_ids", "user_id", "brief_date", "item_set_hash",
                    "payload", "model_id", "prompt_version", "degraded"],
}


def test_every_table_the_code_writes_exists_with_every_column(sql):
    tables = _tables(sql)
    assert set(WRITTEN) <= set(tables), sorted(set(WRITTEN) - set(tables))
    for table, written in WRITTEN.items():
        declared = set(_columns(tables[table]))
        missing = sorted(set(written) - declared)
        assert not missing, "%s lacks %s (declared: %s)" % (table, missing, sorted(declared))


def test_the_written_column_lists_are_not_stale(sql):
    """The census above must find what the code actually writes: a
    canary per table, read from the code."""
    source = (REPO / "src" / "engine" / "api" / "_firm_requests.py").read_text("utf-8")
    for needle in ('"reminders_sent"', '"token_hash"', '"last_item_ids"', '"expected_identity"',
                   '"period_guard"', '"entity_guard"', '"queued_email_id"'):
        assert needle in source, needle
    brief = (REPO / "src" / "engine" / "api" / "_firm_brief.py").read_text("utf-8")
    for needle in ('"firm_key"', '"brief_date"', '"item_set_hash"', '"degraded"', '"client_org_ids"'):
        assert needle in brief, needle


def test_check_lists_match_the_python_constants(sql):
    tables = _tables(sql)
    status = re.search(r"status\s+text not null default 'requested'\s+check \(status in \((.*?)\)\)",
                       tables["firm_file_requests"], flags=re.S).group(1)
    statuses = sorted(re.findall(r"'(\w+)'", status))
    assert statuses == sorted([FR.STATUS_REQUESTED, FR.STATUS_REMINDED, FR.STATUS_RECEIVED,
                               FR.STATUS_EXPIRED, FR.STATUS_REVOKED])
    kinds = re.search(r"kind\s+text not null\s+check \(kind in \((.*?)\)\)", tables["firm_email_queue"],
                      flags=re.S).group(1)
    assert sorted(re.findall(r"'(\w+)'", kinds)) == sorted([FR.EMAIL_KIND_REQUEST, FR.EMAIL_KIND_REMINDER,
                                                             FR.EMAIL_KIND_DIGEST])
    open_idx = re.search(r"firm_file_requests_open_uidx.*?where status in \((.*?)\)", sql, flags=re.S).group(1)
    assert sorted(re.findall(r"'(\w+)'", open_idx)) == sorted(FR.OPEN_STATUSES)
    cadences = re.search(r"check \(cadence in \((.*?)\)\)", tables["firm_client_cadence"]).group(1)
    from engine.firm import cadence as C
    assert sorted(re.findall(r"'(\w+)'", cadences)) == sorted(C.load_cadence_pack().cadences)


def test_rls_is_enabled_on_every_table(sql):
    for table in _tables(sql):
        assert ("alter table %s enable row level security;" % table) in sql, table


#: The SECOND WALL ON WRITES (W1): every client write policy this file
#: declares, by table and command, with the predicates each must carry.
#: A write policy outside this table is red (an unreviewed grant); one
#: missing a predicate is red (a loosened wall). The secret token table
#: and the e-mail queue carry NONE (service-role only).
WRITE_POLICIES = {
    ("firm_client_cadence", "insert"): ("set_by = auth.uid()", "firm_id = firm_of_org(client_org_id)",
                                        "firm_can(firm_id, 'request_file')",
                                        "firm_id is null and is_member_of(client_org_id)"),
    ("firm_client_cadence", "update"): ("is_member_of(client_org_id)",
                                        "firm_can(firm_of_org(client_org_id), 'request_file')",
                                        "set_by = auth.uid()", "firm_id = firm_of_org(client_org_id)"),
    ("firm_file_requests", "insert"): ("requested_by = auth.uid()", "firm_id = firm_of_org(client_org_id)",
                                       "firm_can(firm_id, 'request_file')",
                                       "firm_id is null and is_member_of(client_org_id)"),
    ("firm_file_requests", "update"): ("firm_id = firm_of_org(client_org_id)",
                                       "firm_can(firm_id, 'request_file')",
                                       "firm_id is null and is_member_of(client_org_id)"),
    ("firm_digest_prefs", "insert"): ("user_id = auth.uid()", "firm_id is null or is_firm_member_of(firm_id)"),
    ("firm_digest_prefs", "update"): ("user_id = auth.uid()", "firm_id is null or is_firm_member_of(firm_id)"),
    ("firm_briefs", "insert"): ("user_id = auth.uid()", "firm_id is null or firm_can(firm_id, 'read')",
                                "firm_key = cast(coalesce(firm_id, user_id) as text)",
                                "firm_brief_clients_readable(firm_id, client_org_ids)"),
    ("firm_briefs", "update"): ("firm_can(firm_id, 'read')", "user_id = auth.uid()",
                                "firm_key = cast(coalesce(firm_id, user_id) as text)",
                                "firm_brief_clients_readable(firm_id, client_org_ids)"),
}


#: THE COLUMN PRIVILEGES (D1): what `authenticated` may UPDATE per table,
#: after the file narrows the Supabase default (table-wide) grant. A set
#: is a column grant; True is table-wide ON PURPOSE (the route upserts
#: the whole row — ON CONFLICT DO UPDATE sets every payload column);
#: None is no UPDATE at all. Recorded (TC-6), asserted against the SQL.
UPDATE_GRANTS = {
    "firm_file_requests": {"status"},
    "firm_digest_prefs": {"enabled", "frequency", "send_hour_utc"},
    "firm_client_cadence": True,
    "firm_briefs": True,
    "firm_file_request_tokens": None,
    "firm_email_queue": None,
    "firm_digest_log": None,
}


def test_column_privileges_narrow_the_supabase_default(sql):
    """Every table of this file: DELETE revoked from both API roles; UPDATE
    revoked table-wide and granted back per column exactly as recorded —
    or kept table-wide only where the route upserts; the no-policy tables
    lose INSERT too. After the repair this reds on (TC-11): a table-wide
    UPDATE grant returning on a PATCHed table, a column joining or leaving
    a grant, a DELETE grant anywhere, a new table without a privilege
    line, and the code's own per-user PATCHes naming a column outside the
    grant."""
    tables = set(_tables(sql))
    assert tables == set(UPDATE_GRANTS), sorted(tables ^ set(UPDATE_GRANTS))
    body = "\n".join(line.split("--", 1)[0] for line in sql.splitlines())
    for table, grant in UPDATE_GRANTS.items():
        assert re.search(r"revoke [\w, ]*\bdelete\b[\w, ]* on %s from [\w, ]*authenticated\s*;" % table, body), (
            "%s: DELETE must be revoked from authenticated" % table)
        assert re.search(r"revoke [\w, ]*\bdelete\b[\w, ]* on %s from anon" % table, body), table
        if grant is True:
            assert not re.search(r"revoke [\w, ]*\bupdate\b[\w, ]* on %s from [\w, ]*authenticated" % table, body), (
                "%s is upserted whole by the route: UPDATE must stay table-wide for authenticated" % table)
            assert re.search(r"revoke update, delete on %s from anon\s*;" % table, body), table
            continue
        assert re.search(r"revoke [\w, ]*\bupdate\b[\w, ]* on %s from anon, authenticated\s*;" % table, body), (
            "%s: UPDATE must be revoked table-wide before any column grant" % table)
        m = re.search(r"grant update \(([^)]*)\) on %s to authenticated\s*;" % table, body)
        if grant is None:
            assert m is None, "%s has no update policy: no column may be granted" % table
            assert re.search(r"revoke insert, update, delete on %s from anon, authenticated\s*;" % table, body), table
        else:
            assert m, "%s: the column grant is missing" % table
            assert set(c.strip() for c in m.group(1).split(",")) == grant, (table, m.group(1))
    assert not re.search(r"grant [\w, ()]*delete on firm_", body), "no DELETE grant anywhere in this file"
    # the per-user writes the code makes fit the grants: the revocation, the digest patch
    source = (REPO / "src" / "engine" / "api" / "_firm_requests.py").read_text("utf-8")
    assert 'client.update("firm_file_requests", {"status": STATUS_REVOKED}' in source
    assert 'patch = {"enabled": body.enabled, "frequency": body.frequency,' in source
    assert '"send_hour_utc": body.send_hour_utc}' in source


def test_every_client_write_policy_is_declared_and_carries_its_predicates(sql):
    """No delete policy anywhere; every insert / update policy is one the
    table above expects, with every predicate it must carry."""
    found = {}  # type: Dict[Tuple[str, str], str]
    for m in re.finditer(r'create policy "([^"]+)"\s+on (\w+) for (insert|update|delete)(.*?);', sql, flags=re.S):
        name, table, command, body = m.group(1), m.group(2), m.group(3), " ".join(m.group(4).split())
        assert command != "delete", "a client DELETE policy on %s: %s" % (table, name)
        assert (table, command) not in found, "two %s policies on %s" % (command, table)
        found[(table, command)] = body
    assert set(found) == set(WRITE_POLICIES), (
        "write policies drifted from the declaration: extra %s, missing %s"
        % (sorted(set(found) - set(WRITE_POLICIES)), sorted(set(WRITE_POLICIES) - set(found))))
    for key, needles in WRITE_POLICIES.items():
        for needle in needles:
            assert needle in found[key], (key, needle, found[key])
    for table in ("firm_file_request_tokens", "firm_email_queue", "firm_digest_log"):
        assert not [k for k in found if k[0] == table], "%s must have no write policy" % table


def test_the_brief_policy_helper_is_security_definer_pinned_and_revoked_from_anon(sql):
    m = re.search(r"create or replace function firm_brief_clients_readable\(_firm_id uuid, _client_org_ids uuid\[\]\)"
                  r"\s+returns boolean\s+language sql\s+stable\s+security definer\s+set search_path = public"
                  r"\s+as \$\$(.*?)\$\$;", sql, flags=re.S)
    assert m, "firm_brief_clients_readable must be a STABLE SECURITY DEFINER sql function pinned to public"
    body = m.group(1)
    assert "unnest(_client_org_ids) as u(id)" in body
    assert "firm_of_org(u.id) is distinct from _firm_id" in body and "not is_member_of(u.id)" in body
    assert "revoke execute on function firm_brief_clients_readable(uuid, uuid[]) from public, anon;" in sql
    assert "grant  execute on function firm_brief_clients_readable(uuid, uuid[]) to authenticated;" in sql


def test_no_policy_touches_memberships_directly(sql):
    """The 42P17 trap: a policy that selects from memberships. Only the
    SECURITY DEFINER is_member_of() may read them."""
    policies = re.findall(r"create policy .*?;", sql, flags=re.S)
    assert policies
    for policy in policies:
        assert "from memberships" not in policy, policy


def test_secret_token_table_has_no_policy(sql):
    assert "create policy" not in sql.split("firm_file_request_tokens (")[1].split("-- 3.")[0]
    assert "alter table firm_file_request_tokens enable row level security;" in sql


def test_tenancy_fk_is_guarded_and_the_file_ends_with_the_notify(sql):
    assert "to_regclass('public.firms')" in sql
    for name in ("firm_client_cadence_firm_fk", "firm_file_requests_firm_fk", "firm_digest_prefs_firm_fk",
                 "firm_digest_log_firm_fk", "firm_email_queue_firm_fk", "firm_briefs_firm_fk"):
        assert name in sql, name
    assert sql.rstrip().endswith("NOTIFY pgrst, 'reload schema';")
    assert "Reload schema cache" in sql, "the runbook must name the Dashboard step"
    assert "schema_phase_firm.sql → THIS FILE" in sql, "the runbook must state the apply order"
    assert "PRE-FLIGHT" in sql and "can_read_client_org" in sql.split("APPLY ORDER")[0], (
        "the runbook must pre-flight the tenancy helpers this file's policies call")


#: The SECOND WALL on the cockpit surface (critic C2): every table a
#: signed-in user reads through /api/firm/requests|cadence|brief carries a
#: firm-scoped select policy routed through the tenancy helpers, beside
#: the workspace-member one. tests/engine/test_firm_tenancy.py EVALUATES
#: these bodies; this pins their shape so a loosening is a visible diff.
FIRM_READ_POLICIES = {
    "firm_file_requests": ("firm_id is not null", "firm_id = firm_of_org(client_org_id)",
                           "firm_can(firm_id, 'read')"),
    # W3: the cadence row is the client's own (firm_id null) or the CURRENT firm's
    "firm_client_cadence": ("can_read_client_org(client_org_id)",
                            "firm_id is null or firm_id = firm_of_org(client_org_id)"),
    # W5: every client the brief names is still the reader's
    "firm_briefs": ("firm_id is not null and firm_can(firm_id, 'read')",
                    "firm_id is null and user_id = auth.uid()",
                    "firm_brief_clients_readable(firm_id, client_org_ids)"),
}


def test_every_cockpit_read_table_has_a_firm_read_policy_beside_the_member_one(sql):
    policies = re.findall(r'create policy "([^"]+)"\s+on (\w+) for (\w+)\s+using \((.*?)\);', sql, flags=re.S)
    by_table = {}  # type: Dict[str, Dict[str, str]]
    for name, table, action, using in policies:
        if action == "select":
            by_table.setdefault(table, {})[name] = " ".join(using.split())
    for table, needles in FIRM_READ_POLICIES.items():
        name = "%s firm read" % table
        assert name in by_table.get(table, {}), (table, sorted(by_table.get(table, {})))
        for needle in needles:
            assert needle in by_table[table][name], (name, needle, by_table[table][name])
        assert 'drop policy if exists "%s" on %s;' % (name, table) in sql
    # the pre-firm member policies are KEPT (RLS ORs them)
    assert "firm_file_requests member select" in by_table["firm_file_requests"]
    assert "is_member_of(client_org_id)" in by_table["firm_file_requests"]["firm_file_requests member select"]
    assert "firm_client_cadence member select" in by_table["firm_client_cadence"]
    # and the secret half / the queue still have none
    assert "firm_file_request_tokens" not in by_table and "firm_email_queue" not in by_table
    # the brief cache gained the columns the policies pin on
    assert "alter table firm_briefs add column if not exists firm_id uuid;" in sql
    assert "alter table firm_briefs add column if not exists client_org_ids uuid[] not null default '{}'::uuid[];" in sql


def test_idempotent_shapes(sql):
    assert "create table " not in sql.replace("create table if not exists", "")
    assert sql.count("drop policy if exists") == sql.count("create policy")
    assert "create index " not in sql.replace("create index if not exists", "").replace(
        "create unique index if not exists", "")


def test_brief_cache_key_has_a_unique_index_for_the_upsert(sql):
    assert re.search(r"create unique index if not exists firm_briefs_key_day_hash_uidx\s+on firm_briefs "
                     r"\(firm_key, brief_date, item_set_hash\)", sql)
    brief = (REPO / "src" / "engine" / "api" / "_firm_brief.py").read_text("utf-8")
    assert 'on_conflict="firm_key,brief_date,item_set_hash"' in brief
