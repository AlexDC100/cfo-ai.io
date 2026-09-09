"""Every service-role call on a tenant-scoped table names its tenant.

THE ANATOMY, proven twice in one day (2026-09-09):

    a browser-written column, consumed by raw value inside a service-role
    operation, behind a wall that checks a DIFFERENT object.

  · `documents.storage_path` -> service-role signed_url / delete_object.
    The wall checked the document; the path pointed at another org's
    folder. Read, and destroy, across the tenant boundary.
  · `documents.period_id`    -> service-role delete / make-active.
    The wall checked the document; the period belonged to another org.
    That one deleted the victim's whole analysis.
  · `documents.uploaded_by`  -> quota consumption and Stripe metering.
    No wall at all: the orchestrator thread has no JWT and the column was
    the only identity available.

Under the service role RLS DOES NOT APPLY, so **the filter IS the access
control**. A guard that lives in an earlier early-return, or in a wall
over a neighbouring object, is one edit away from being bypassed — both
P0s were exactly that.

HOW THIS GATE WORKS. It enumerates every call made on a client bound from
`_supabase.admin()` against a tenant-scoped table. A call whose `filters`
name `org_id` passes automatically. A call that does NOT must appear in
`DECLARED_UNFILTERED` with a reason. A NEW undeclared one fails.

That is a ratchet, not an audit: it does not claim the declared sites
have been proven safe, only that no new one is added silently and that
each existing one carries a written justification the next reader can
challenge. Sites are declared by (file, table, op) rather than by line
number so ordinary edits do not churn the list.

WHAT IT REDS ON, with the defect repaired (TC-11):
  · a new service-role read/write on a tenant table with no org filter
  · a declared site that has disappeared (stale declaration)
  · the AST walk ceasing to recognise `_supabase.admin()` bindings, which
    would make the whole sweep silently vacuous
"""
from __future__ import annotations

import ast
import collections
from pathlib import Path

import pytest

API = Path(__file__).parents[2] / "src" / "engine" / "api"

#: Tables holding one tenant's business data. Superset of
#: test_firm_tenancy.CLIENT_DATA_TABLES — that list is about which
#: modules may NAME a client table; this one is about which tables must
#: be tenant-filtered under the service role.
TENANT_SCOPED_TABLES = frozenset({
    "organizations", "financial_periods", "documents", "statement_line_items",
    "alerts", "recommendations", "calculated_metrics", "briefings",
    "valuations", "user_valuation_assumptions", "sales_datasets",
    "sku_analyses", "org_prefs", "chat_threads", "chat_messages",
})

MUTATING_OR_READING = frozenset({"select", "insert", "update", "upsert", "delete"})

#: (file, table, op) -> why this service-role call may omit org_id.
#: Adding an entry is a claim you are making in review. Each one is a
#: candidate for the same treatment the three P0s got.
DECLARED_UNFILTERED = {
    # ── pipeline.py — the analysis write path ────────────────────────
    ("pipeline.py", "documents", "select"):
        "keyed by document_id obtained from _verify_user_may_write_document "
        "/ _verify_user_may_read_document. The DOCUMENT is the authorized "
        "object here — unlike period_id and storage_path, which were COLUMNS "
        "of it pointing elsewhere.",
    ("pipeline.py", "documents", "update"): "same: the document is the authorized object.",
    ("pipeline.py", "documents", "delete"):
        "hard-delete of an already-authorized document by its own id "
        "(clear-deleted / permanent delete), after _verify_user_may_write_document.",
    ("pipeline.py", "financial_periods", "select"):
        "period_id validated by _verify_user_may_write_period (per-user "
        "select under RLS + require_org_member) or derived from an "
        "authorized document.",
    ("pipeline.py", "financial_periods", "update"): "same period authorization as its select.",
    ("pipeline.py", "financial_periods", "insert"): "server-built row; org_id is in the payload.",
    ("pipeline.py", "statement_line_items", "select"): "period-keyed; the period was authorized upstream.",
    ("pipeline.py", "statement_line_items", "insert"): "server-built rows for an authorized period.",
    ("pipeline.py", "statement_line_items", "delete"): "period-keyed rebuild of an authorized period.",
    ("pipeline.py", "calculated_metrics", "select"): "period-keyed; authorized upstream.",
    ("pipeline.py", "calculated_metrics", "insert"): "server-built rows for an authorized period.",
    ("pipeline.py", "calculated_metrics", "delete"): "period-keyed rebuild.",
    ("pipeline.py", "briefings", "select"): "period-keyed; authorized upstream.",
    ("pipeline.py", "briefings", "upsert"): "period-keyed; authorized upstream.",
    ("pipeline.py", "recommendations", "select"): "period-keyed; authorized upstream.",
    ("pipeline.py", "recommendations", "insert"): "server-built rows.",
    ("pipeline.py", "recommendations", "delete"): "period-keyed rebuild.",
    ("pipeline.py", "alerts", "select"): "period/document-keyed; authorized upstream.",
    ("pipeline.py", "alerts", "upsert"): "server-built rows for an authorized period.",
    ("pipeline.py", "alerts", "delete"): "document-keyed; authorized upstream.",
    ("pipeline.py", "valuations", "select"): "period-keyed; authorized upstream.",
    ("pipeline.py", "user_valuation_assumptions", "select"):
        "period-keyed; the period passed _verify_user_may_write_period.",
    ("pipeline.py", "user_valuation_assumptions", "upsert"): "same period authorization.",
    ("pipeline.py", "user_valuation_assumptions", "delete"): "same period authorization.",
    ("pipeline.py", "sku_analyses", "upsert"):
        "document-keyed; org_id is written INTO the row from the authorized "
        "document rather than used as a filter.",
    ("pipeline.py", "sku_analyses", "select"): "document-keyed; authorized upstream.",
    ("pipeline.py", "sales_datasets", "select"): "document-keyed; authorized upstream.",
    ("pipeline.py", "sales_datasets", "update"): "document-keyed; authorized upstream.",
    ("pipeline.py", "sales_datasets", "insert"): "server-built rows.",

    # ── _reconcile.py — VERIFIED 2026-09-09 ──────────────────────────
    # `_resolve` (_reconcile.py:1480) is a real wall on the PERIOD itself:
    # verified_user_id, then a per-user select under RLS, then
    # require_org_member on that period's org. The service-role calls below
    # act on the same period_id that wall authorized.
    ("_reconcile.py", "financial_periods", "select"): "period authorized by _resolve (_reconcile.py:1480).",
    ("_reconcile.py", "financial_periods", "update"): "period authorized by _resolve (_reconcile.py:1480).",

    # ── _valuation.py ────────────────────────────────────────────────
    ("_valuation.py", "valuations", "upsert"):
        "persist_valuation(period_id, org_id, ...) takes the org as an "
        "argument and writes it into the row; the caller supplies the org "
        "it already authorized.",

    # ── _firm_requests.py ────────────────────────────────────────────
    ("_firm_requests.py", "documents", "insert"):
        "server-built row for the firm file-request flow; org_id is set "
        "from client_org_id in the payload, not used as a filter.",
}


def _admin_bound_names(tree):
    """Local names bound to a `_supabase.admin()` context manager."""
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.withitem) and isinstance(node.context_expr, ast.Call):
            call = node.context_expr
            if (isinstance(call.func, ast.Attribute) and call.func.attr == "admin"
                    and isinstance(node.optional_vars, ast.Name)):
                names.add(node.optional_vars.id)
    return names


def _service_role_calls():
    """(file, line, op, table, has_org_filter) for every service-role call
    on a tenant-scoped table."""
    out = []
    for path in sorted(API.glob("*.py")):
        tree = ast.parse(path.read_text())
        admins = _admin_bound_names(tree)
        if not admins:
            continue
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr in MUTATING_OR_READING):
                continue
            base = node.func.value
            if not (isinstance(base, ast.Name) and base.id in admins):
                continue
            if not node.args or not isinstance(node.args[0], ast.Constant):
                continue
            table = node.args[0].value
            if table not in TENANT_SCOPED_TABLES:
                continue
            filters = next((k.value for k in node.keywords if k.arg == "filters"), None)
            has_org = filters is not None and "org_id" in ast.dump(filters)
            out.append((path.name, node.lineno, node.func.attr, table, has_org))
    return out


CALLS = _service_role_calls()


def test_the_sweep_actually_finds_the_known_call_sites():
    """TC-3 non-vacuity. If `_supabase.admin()` were renamed or the walk
    broke, every assertion below would pass by inspecting nothing."""
    assert len(CALLS) >= 50, (
        f"only {len(CALLS)} service-role calls found on tenant tables — the "
        f"AST walk has stopped recognising them and this gate is vacuous"
    )
    tables = {c[3] for c in CALLS}
    assert {"documents", "financial_periods"} <= tables, (
        f"the two tables both P0s went through are missing from the sweep: {sorted(tables)}"
    )


def test_every_unfiltered_service_role_call_is_declared():
    undeclared = collections.defaultdict(list)
    for fname, lineno, op, table, has_org in CALLS:
        if has_org:
            continue
        if (fname, table, op) not in DECLARED_UNFILTERED:
            undeclared[(fname, table, op)].append(lineno)
    assert not undeclared, (
        "service-role calls on tenant-scoped tables with NO org_id in their "
        "filter, and no declaration:\n  "
        + "\n  ".join(
            f"{f}:{sorted(lines)} {op} {t}" for (f, t, op), lines in sorted(undeclared.items())
        )
        + "\n\nUnder the service role the filter IS the access control. Either "
          "put org_id in the filter, or add a (file, table, op) entry to "
          "DECLARED_UNFILTERED in this file stating precisely which already-"
          "authorized object keys the call. Note that 'the wall checked the "
          "document' did NOT save storage_path or period_id: both were COLUMNS "
          "of the authorized document, pointing elsewhere."
    )


def test_no_declaration_is_stale():
    """A declaration for a call site that no longer exists is a claim
    nobody is checking any more."""
    live = {(f, t, op) for f, _l, op, t, has in CALLS if not has}
    stale = sorted(set(DECLARED_UNFILTERED) - live)
    assert not stale, (
        "DECLARED_UNFILTERED names call sites that no longer exist: "
        + ", ".join(f"{f}/{t}.{op}" for f, t, op in stale)
        + " — delete the entries so the list keeps describing the code."
    )


@pytest.mark.parametrize("table", ["financial_periods"])
def test_every_service_role_delete_of_a_period_names_the_tenant(table):
    """The retry-path P0, pinned by table. A DELETE is the one operation
    with no undo, so it gets no declaration escape hatch."""
    offenders = [
        f"{f}:{l}" for f, l, op, t, has_org in CALLS
        if t == table and op == "delete" and not has_org
    ]
    assert offenders == [], (
        f"service-role delete of {table} without org_id in the filter at "
        + ", ".join(offenders)
    )
