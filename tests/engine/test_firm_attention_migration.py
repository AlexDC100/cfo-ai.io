"""supabase/schema_phase_firm_attention.sql — the migration, unit-tested
against its own text (applying it is the owner's Studio step).

Named apart from test_firm_migration.py (Part C's, for
schema_phase_firm_requests.sql) on purpose: two lanes, two files.

What a migration for this product must carry, mechanically:
  · it ends with ``NOTIFY pgrst, 'reload schema';`` (CLAUDE.md §14);
  · its runbook names the Dashboard "Reload schema cache" click;
  · every table it creates has RLS enabled and a select policy;
  · no policy on ``memberships`` (the 42P17 recursion trap);
  · a suppression reason is NOT NULL and non-empty at the schema;
  · suppressions are revoked, never deleted (no delete policy);
  · the covenant metric ids the SQL documents are the pack's.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
SQL = REPO / "supabase" / "schema_phase_firm_attention.sql"
PACK = REPO / "packs" / "firm" / "attention.yaml"


def _sql() -> str:
    return SQL.read_text(encoding="utf-8")


def _tables(sql: str):
    return re.findall(r"create table if not exists (\w+)", sql)


def test_migration_ends_with_the_pgrst_reload_notify():
    body = _sql().rstrip()
    assert body.endswith("NOTIFY pgrst, 'reload schema';"), body[-120:]


def test_runbook_names_the_dashboard_reload_and_the_prerequisite_migrations():
    sql = _sql()
    assert "Reload schema cache" in sql
    assert "schema_phase_firm.sql" in sql and "schema_phase_multi_workspace.sql" in sql


def test_every_created_table_has_rls_and_a_select_policy():
    sql = _sql()
    tables = _tables(sql)
    assert set(tables) == {"firm_attention_suppressions", "firm_covenants"}, tables
    for table in tables:
        assert re.search(r"alter table %s enable row level security" % table, sql), table
        assert re.search(r'create policy "%s read"\s+on %s for select' % (table, table), sql), table


def test_no_policy_touches_memberships_the_42p17_trap():
    sql = _sql()
    assert not re.search(r"create policy .* on memberships", sql)
    for m in re.finditer(r"create policy(.*?);", sql, re.S):
        assert "from memberships" not in m.group(1), m.group(0)[:200]


def test_suppression_reason_is_required_and_non_empty_and_rows_are_revoked_not_deleted():
    sql = _sql()
    block = sql[sql.index("create table if not exists firm_attention_suppressions"):]
    block = block[:block.index("create table if not exists firm_covenants")]
    assert re.search(r"reason\s+text not null check \(length\(btrim\(reason\)\) > 0\)", block)
    assert "revoked_at" in block
    assert "for delete" not in block, "suppressions must be revoked, never deleted"
    assert "dismissed_by = auth.uid()" in block


def test_covenant_comparators_and_units_match_the_engine_model():
    sql = _sql()
    assert "comparator in ('>=', '>', '<=', '<')" in sql
    assert "unit in ('money', 'ratio', 'percent')" in sql
    with open(str(PACK), encoding="utf-8") as fh:
        pack = yaml.safe_load(fh)
    kinds = dict((k["kind"], k) for k in pack["kinds"])
    metrics = sorted(kinds["COVENANT_RISK"]["covenant_metrics"])
    assert metrics, "the pack declares no covenant metrics"
    for metric in metrics:
        assert metric in sql, "covenant metric %r documented in the pack but not in the SQL" % metric


def test_write_policies_use_the_firm_role_matrix_not_a_role_name():
    sql = _sql()
    assert "firm_can(firm_of_org(org_id), 'suppress')" in sql
    assert "firm_can(firm_of_org(org_id), 'assign')" in sql
    assert not re.search(r"role\s*=\s*'(owner|partner|accountant)'", sql)


def test_idempotent_shapes():
    sql = _sql()
    assert "create table " not in sql.replace("create table if not exists", "")
    assert sql.count("drop policy if exists") == sql.count("create policy")
    assert "create index " not in sql.replace("create index if not exists", "")
