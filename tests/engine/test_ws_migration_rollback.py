"""The rollback of the workspace migration is the undo of the plan's own
operations (``rowstore.undo_ops``) — pure, on the synthetic world.

Verifier p2 (2026-09-26): the rollback was a table-wide snapshot restore
and reached users' data written after the run. The undo names only the
rows the plan named, inverts each operation exactly, and never overwrites
a row that changed since.
"""
from __future__ import annotations

import copy

import pytest

from engine.workspaces.migration_plan import build_plan, holding_org_id, new_org_id
from engine.workspaces.rowstore import (
    apply_ops,
    at_planned_state,
    pk_for,
    row_key,
    rows_equal,
    undo_ops,
    undo_remaining,
)

from ws_migration_fixture import BETA, OWNER, SOLO, build_world, facts_for

DATE = "2026-09-21"
RUN = "2026-09-21T15:00:00+00:00"
UNDO_AT = "2026-09-22T00:00:00+00:00"


@pytest.fixture(scope="module")
def world():
    tables, storage, rules = build_world()
    facts = facts_for(tables, storage, rules)
    plan = build_plan(tables, facts, migration_date=DATE)
    post = apply_ops(tables, plan.ops, now=RUN)
    return {"tables": tables, "facts": facts, "plan": plan, "post": post}


def _row(tables, table, **key):
    hits = [r for r in tables[table] if all(r.get(k) == v for k, v in key.items())]
    assert len(hits) == 1, (table, key, hits)
    return hits[0]


def _named(plan):
    return {(op["table"], row_key(op.get("row") or op.get("key"), pk_for(op["table"])))
            for op in plan.ops if op["op"] != "copy_object"}


def test_the_undo_puts_every_named_row_back_and_names_nothing_else(world):
    pre, post, plan = world["tables"], world["post"], world["plan"]
    undo = undo_ops(plan.ops, post, pre)
    assert undo["conflicts"] == [] and undo["reinserted"] == []
    # only rows the plan named are in the undo
    keys = {(op["table"], row_key(op.get("key") or op.get("row"), pk_for(op["table"]))) for op in undo["ops"]}
    assert keys <= _named(plan)
    assert {op["op"] for op in undo["ops"]} == {"update"}
    restored = apply_ops(post, undo["ops"], now=UNDO_AT)
    pre_orgs = {o["id"] for o in pre["organizations"]}
    for table, rows in pre.items():
        pk = pk_for(table)
        now_rows = {row_key(r, pk): r for r in restored[table]}
        for r in rows:
            if (table, row_key(r, pk)) in _named(plan):
                assert rows_equal(r, now_rows[row_key(r, pk)]), (table, r)
    # created workspaces: archived, held; the holding one was never live
    for o in restored["organizations"]:
        if o["id"] not in pre_orgs:
            assert o["archived_at"] is not None and o["purge_after"] is None, o
    assert _row(restored, "organizations", id=holding_org_id(OWNER))["archived_at"] == RUN
    # the identity stamp on the pre-existing solo workspace is gone; the
    # bags of created workspaces are empty (an empty bag is no row)
    assert _row(restored, "org_prefs", org_id="org-solo")["prefs"] == {}
    assert _row(restored, "org_prefs", org_id=new_org_id(OWNER, "cui:" + BETA))["prefs"] == {}
    assert _row(restored, "org_prefs", org_id="org-sf")["prefs"] == {"display_currency": "RON"}
    # residue: memberships of created workspaces, copies, empty bags
    assert undo["residue"]["storage copies (never deleted)"] == sum(1 for op in plan.ops if op["op"] == "copy_object")
    assert undo["residue"]["memberships rows the plan inserted (no archive column)"] == 5
    # a second undo finds nothing
    again = undo_ops(plan.ops, restored, pre)
    assert again["ops"] == [] and again["conflicts"] == []
    assert undo_remaining(plan.ops, restored, pre) == []


def test_the_undo_is_the_plan_in_reverse(world):
    pre, post, plan = world["tables"], world["post"], world["plan"]
    undo = undo_ops(plan.ops, post, pre)

    def inverted(undo_op):
        """The index of the plan operation this undo inverts: same table
        and key, and the columns it puts back are the ones that op set."""
        key = row_key(undo_op["key"], pk_for(undo_op["table"]))
        hits = [i for i, op in enumerate(plan.ops) if op["op"] != "copy_object" and op["table"] == undo_op["table"]
                and row_key(op.get("key") or op.get("row"), pk_for(op["table"])) == key
                and (op["op"] != "update" or set(op["set"]) == set(undo_op["set"]))]
        assert len(hits) == 1, (undo_op, hits)
        return hits[0]

    indices = [inverted(op) for op in undo["ops"]]
    assert indices == sorted(indices, reverse=True)
    assert len(set(indices)) == len(indices)
    # the guard of every undo is the exact value the row holds now
    cur = {t: {row_key(r, pk_for(t)): r for r in rows} for t, rows in post.items()}
    for op in undo["ops"]:
        row = cur[op["table"]][row_key(op["key"], pk_for(op["table"]))]
        assert all(row.get(c) == v for c, v in op["expect"].items()), op


def test_a_row_that_changed_since_the_run_is_left_and_named(world):
    pre, post, plan = world["tables"], world["post"], world["plan"]
    changed = copy.deepcopy(post)
    # the owner restores an archived duplicate from the trash
    _row(changed, "documents", id="d-sf24-copy")["deleted_at"] = None
    # the owner renames the moved conversation: not a plan column, undone fine
    _row(changed, "chat_threads", id="ct-1")["title"] = "renamed"
    # another key in a stamped bag: kept, the plan's keys go
    sf = _row(changed, "org_prefs", org_id="org-sf")
    sf["prefs"] = dict(sf["prefs"], display_currency="EUR")
    undo = undo_ops(plan.ops, changed, pre)
    assert [c[:2] for c in undo["conflicts"]] == [("documents", {"id": "d-sf24-copy"})]
    assert "neither what the plan wrote nor the pre-image" in undo["conflicts"][0][2]
    assert not [op for op in undo["ops"] if op["key"] == {"id": "d-sf24-copy"}]
    restored = apply_ops(changed, undo["ops"], now=UNDO_AT)
    th = _row(restored, "chat_threads", id="ct-1")
    assert th["org_id"] == "org-qa" and th["active_period_id"] == "per-q25" and th["title"] == "renamed"
    assert _row(restored, "org_prefs", org_id="org-sf")["prefs"] == {"display_currency": "EUR"}
    assert _row(restored, "documents", id="d-sf24-copy")["deleted_at"] is None
    assert undo_remaining(plan.ops, restored, pre) == ["documents {\"id\":\"d-sf24-copy\"}: "
                                                       + undo["conflicts"][0][2]]


def test_rows_the_plan_never_named_are_not_read_for_undo(world):
    pre, post, plan = world["tables"], world["post"], world["plan"]
    planted = copy.deepcopy(post)
    planted["documents"].append(dict(_row(post, "documents", id="d-sf25-lv"), id="d-new", period_id="per-new",
                                     created_at="2026-09-22T08:00:00+00:00"))
    planted["financial_periods"].append(dict(_row(post, "financial_periods", id="per-sf25"), id="per-new",
                                             period_end="2026-01-31", source_document_id="d-new"))
    planted["organizations"].append(dict(_row(post, "organizations", id="org-sf"), id="org-new"))
    planted["org_prefs"].append({"org_id": "org-team", "prefs": {"workspace_onboarded": True}})
    undo = undo_ops(plan.ops, planted, pre)
    keys = {(op["table"], row_key(op["key"], pk_for(op["table"]))) for op in undo["ops"]}
    for k in (("documents", ("d-new",)), ("financial_periods", ("per-new",)), ("organizations", ("org-new",)),
              ("org_prefs", ("org-team",))):
        assert k not in keys
    restored = apply_ops(planted, undo["ops"], now=UNDO_AT)
    assert _row(restored, "documents", id="d-new")["deleted_at"] is None
    assert _row(restored, "organizations", id="org-new")["archived_at"] is None
    assert _row(restored, "org_prefs", org_id="org-team")["prefs"] == {"workspace_onboarded": True}


def test_a_named_row_that_is_gone_comes_back_from_the_snapshot_with_the_cycle_relinked(world):
    pre, post, plan = world["tables"], world["post"], world["plan"]
    purged = copy.deepcopy(post)
    # the archived period per-beta and its source were hard-deleted (a purge)
    purged["financial_periods"] = [p for p in purged["financial_periods"] if p["id"] != "per-beta"]
    purged["documents"] = [d for d in purged["documents"] if d["id"] != "q-beta-src"]
    undo = undo_ops(plan.ops, purged, pre)
    assert sorted(undo["reinserted"]) == [("documents", {"id": "q-beta-src"}), ("financial_periods", {"id": "per-beta"})]
    kinds = [(op["op"], op["table"]) for op in undo["ops"][:3]]
    assert kinds == [("upsert", "documents"), ("upsert", "financial_periods"), ("update", "documents")]
    assert undo["ops"][0]["row"]["period_id"] is None            # cut while its period is gone
    assert undo["ops"][2] == {"op": "update", "table": "documents", "key": {"id": "q-beta-src"},
                              "set": {"period_id": "per-beta"}, "expect": {"period_id": None}}
    restored = apply_ops(purged, undo["ops"], now=UNDO_AT)
    assert rows_equal(_row(restored, "documents", id="q-beta-src"), _row(pre, "documents", id="q-beta-src"))
    assert rows_equal(_row(restored, "financial_periods", id="per-beta"), _row(pre, "financial_periods", id="per-beta"))
    assert undo_remaining(plan.ops, restored, pre) == []


def test_an_interrupted_run_is_undone_only_as_far_as_it_got(world):
    pre, plan = world["tables"], world["plan"]
    half = apply_ops(pre, plan.ops[: len(plan.ops) // 2], now=RUN)
    undo = undo_ops(plan.ops, half, pre)
    assert undo["conflicts"] == []
    assert undo["undone"], "the unwritten half is 'already at its pre-image'"
    restored = apply_ops(half, undo["ops"], now=UNDO_AT)
    assert undo_remaining(plan.ops, restored, pre) == []
    for table, rows in pre.items():
        pk = pk_for(table)
        now_rows = {row_key(r, pk): r for r in restored[table]}
        for r in rows:
            if (table, row_key(r, pk)) in _named(plan) and table != "org_prefs":
                assert rows_equal(r, now_rows[row_key(r, pk)]), (table, r)


def test_a_created_workspace_its_owner_deleted_is_left_as_the_owner_set_it(world):
    pre, post, plan = world["tables"], world["post"], world["plan"]
    changed = copy.deepcopy(post)
    beta = new_org_id(OWNER, "cui:" + BETA)
    _row(changed, "organizations", id=beta).update(archived_at="2026-09-22T00:00:00+00:00",
                                                    purge_after="2026-10-22T00:00:00+00:00")
    undo = undo_ops(plan.ops, changed, pre)
    assert ("organizations", {"id": beta}, "archived by its owner with a deletion date — left as the owner set it") \
        in undo["skipped"]
    assert not [op for op in undo["ops"] if op["key"] == {"id": beta}]
    restored = apply_ops(changed, undo["ops"], now=UNDO_AT)
    assert _row(restored, "organizations", id=beta)["purge_after"] == "2026-10-22T00:00:00+00:00"


def test_at_planned_state_reads_a_now_column_as_any_timestamp():
    assert at_planned_state({"deleted_at": "2026-01-01T00:00:00+00:00", "error": "x"},
                            {"deleted_at": "$now", "error": "x"})
    assert not at_planned_state({"deleted_at": None, "error": "x"}, {"deleted_at": "$now", "error": "x"})
    assert not at_planned_state({"deleted_at": "2026-01-01T00:00:00+00:00", "error": "y"},
                                {"deleted_at": "$now", "error": "x"})
    assert at_planned_state({"archived_at": None, "purge_after": None}, {"archived_at": None, "purge_after": None})


def test_the_next_plan_after_an_undo_decides_every_pre_existing_workspace_as_before(world):
    """Rule 1 reads org_prefs first: an identity stamp left on a pre-existing
    workspace would decide its company from the stamp the rollback was
    meant to undo (verifier, 2026-09-21)."""
    pre, post, plan = world["tables"], world["post"], world["plan"]
    restored = apply_ops(post, undo_ops(plan.ops, post, pre)["ops"], now=UNDO_AT)
    pre_orgs = {o["id"] for o in pre["organizations"]}

    def decided(tables):
        again = build_plan(tables, world["facts"], migration_date=DATE)
        return {w["org_id"]: (w["company"], w["company_source"]) for w in again.workspaces
                if w["org_id"] in pre_orgs}

    assert decided(restored) == decided(pre)
    assert decided(pre)["org-solo"] == ("cui:" + SOLO, "period sources 1/1")
