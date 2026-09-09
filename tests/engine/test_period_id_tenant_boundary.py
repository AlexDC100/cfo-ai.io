"""`documents.period_id` is browser-written; a service-role operation may
not act on the period it names without checking whose period it is.

THE DEFECT (P0, 2026-09-09 — the storage-path bug's twin, found by
sweeping for the pattern after fixing that one).

`documents` RLS is `is_member_of(org_id)` for INSERT/UPDATE with NO column
restriction (supabase/schema_phase3.sql:209-212), and
frontend/lib/supabase.ts inserts the row from the browser including
`period_id`. The FK `documents.period_id -> financial_periods(id)` is
EXISTENCE-only; nothing constrains it to the same organization.

The write wall `_verify_user_may_write_document` validates membership in
the DOCUMENT's org and never looks at `period_id`. So a row filed in your
own workspace carrying another workspace's period id walked through it,
and then:

  · POST /api/documents/{id}/make-active  hard-deleted that period's
    statement_line_items, calculated_metrics, briefings and valuations,
    nulled assembled_canonical_v1 and re-pointed source_document_id at
    the attacker's file;
  · POST /api/pipeline/retry              deleted the financial_periods
    row outright, cascading its derivatives away.

A firm viewer holding only a read cell has every client period id by
design (schema_phase_firm.sql), so the adversary is exactly the one the
write wall was written for.

WHAT THESE RED ON, with the defect repaired (TC-11):
  · `_period_row` losing its required `org_id`, or accepting a period
    whose org differs from the caller's
  · a service-role delete of `financial_periods` filtered by id alone
  · a new call site fetching a period by a caller-supplied id without
    naming the tenant
"""
from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest

from engine.api import _period_move
from engine.api._period_move import MoveRefused, _period_row, make_document_active

MINE = "11111111-1111-1111-1111-111111111111"
THEIRS = "22222222-2222-2222-2222-222222222222"
SRC = Path(__file__).parents[2] / "src" / "engine" / "api"


class _Client:
    """Records what a service-role client would have been asked to do."""

    def __init__(self, period):
        self._period = period
        self.deletes = []
        self.updates = []

    def select(self, table, *, filters=None, columns="*", single=False, **_):
        if table == "financial_periods":
            return [self._period] if self._period else []
        return []

    def delete(self, table, *, filters=None):
        self.deletes.append((table, dict(filters or {})))

    def update(self, table, patch, *, filters=None):
        self.updates.append((table, dict(patch), dict(filters or {})))


VICTIM_PERIOD = {
    "id": "period-belonging-to-someone-else",
    "org_id": THEIRS,
    "period_end": "2025-12-31",
    "source_document_id": "their-doc",
    "assembled_canonical_v1": {"real": "analysis"},
}

MY_DOC_POINTING_AT_THEIRS = {
    "id": "my-doc",
    "org_id": MINE,                       # the wall checks THIS and passes
    "period_id": VICTIM_PERIOD["id"],     # ...and never checked THIS
}


# ── the attack ──────────────────────────────────────────────────────

def test_make_active_refuses_a_period_in_another_workspace():
    client = _Client(VICTIM_PERIOD)
    with pytest.raises(MoveRefused) as e:
        make_document_active(client, document=MY_DOC_POINTING_AT_THEIRS,
                             now="2026-09-09T00:00:00Z")
    assert e.value.code == "period_not_in_workspace"
    # The refusal must happen BEFORE anything is written.
    assert client.deletes == [], (
        "refused, but derived tables were already deleted: %s" % (client.deletes,)
    )
    assert client.updates == [], (
        "refused, but the period was already re-pointed: %s" % (client.updates,)
    )


def test_make_active_still_works_inside_my_own_workspace():
    """The guard must not break the legitimate correction path."""
    mine = dict(VICTIM_PERIOD, org_id=MINE)
    client = _Client(mine)
    record = make_document_active(client, document=MY_DOC_POINTING_AT_THEIRS,
                                  now="2026-09-09T00:00:00Z")
    assert record["changed"] is True
    assert [t for t, _f in client.deletes] == list(_period_move._DERIVED_TABLES)
    assert client.updates, "the period should have been re-pointed"


def test_period_row_refuses_a_foreign_period_and_allows_my_own():
    client = _Client(VICTIM_PERIOD)
    with pytest.raises(MoveRefused):
        _period_row(client, VICTIM_PERIOD["id"], org_id=MINE)
    assert _period_row(_Client(dict(VICTIM_PERIOD, org_id=MINE)),
                       VICTIM_PERIOD["id"], org_id=MINE) is not None


@pytest.mark.parametrize("org", [None, "", "   "])
def test_an_absent_caller_org_refuses_rather_than_waving_through(org):
    """ABSENT is not a permit — the same rule as the storage guard."""
    with pytest.raises(MoveRefused):
        _period_row(_Client(VICTIM_PERIOD), VICTIM_PERIOD["id"], org_id=org)


def test_a_missing_period_is_still_reported_as_missing_not_as_foreign():
    assert _period_row(_Client(None), "nope", org_id=MINE) is None


# ── the seam cannot be re-opened ────────────────────────────────────

def test_period_row_requires_the_tenant_with_no_default():
    sig = inspect.signature(_period_row)
    p = sig.parameters["org_id"]
    assert p.kind is inspect.Parameter.KEYWORD_ONLY
    assert p.default is inspect.Parameter.empty, (
        "org_id acquired a default — a call site can now omit the tenant"
    )


def test_no_service_role_delete_of_a_period_is_filtered_by_id_alone():
    """Static sweep of pipeline.py. A service-role delete on
    `financial_periods` keyed only by an id the caller can influence is
    the retry-path defect; the org must be in the filter."""
    src = (SRC / "pipeline.py").read_text()
    tree = ast.parse(src)
    offenders = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "delete"):
            continue
        if not node.args or not isinstance(node.args[0], ast.Constant):
            continue
        if node.args[0].value != "financial_periods":
            continue
        filters = next((k.value for k in node.keywords if k.arg == "filters"), None)
        rendered = ast.dump(filters) if filters is not None else ""
        if "org_id" not in rendered:
            offenders.append(f"pipeline.py:{node.lineno}")
    assert offenders == [], (
        "service-role delete of financial_periods filtered without org_id at "
        + ", ".join(offenders)
        + " — under the service role the filter IS the access control"
    )


def test_the_delete_sweep_is_not_vacuous():
    """TC-3: the walk must actually find the delete it is guarding."""
    src = (SRC / "pipeline.py").read_text()
    tree = ast.parse(src)
    found = sum(
        1 for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
        and n.func.attr == "delete" and n.args
        and isinstance(n.args[0], ast.Constant)
        and n.args[0].value == "financial_periods"
    )
    assert found >= 1, "no financial_periods delete found — the sweep guards nothing"
