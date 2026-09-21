"""The one-company-per-workspace planner, on a synthetic world with the
owner's production shapes (tests/engine/ws_migration_fixture.py).

WHAT THESE RED ON, with the planner correct (TC-11):
  * a served period replaced, moved or re-dated;
  * a live workspace left holding two companies, or a company+month left
    with two live documents;
  * an empty period left in a live workspace (G4);
  * a document pointing at a period in another workspace, or a
    period-scoped row filed under a workspace its period left;
  * a plan of the post-state that is not empty (idempotency);
  * a restore that does not reproduce the pre-state (G8);
  * any hard delete, any write to a billing table;
  * the holding workspace becoming purgeable.
"""
from __future__ import annotations

import copy
import re
from pathlib import Path

import pytest

from engine.workspaces.company_identity import CompanyIdentity, industry_key_for_caen
from engine.workspaces.migration_plan import (
    DocFacts,
    HOLDING_NAME,
    build_plan,
    cross_workspace_links,
    empty_live_periods,
    holding_org_id,
    new_org_id,
    period_source_hazards,
)
from engine.workspaces.rowstore import (
    apply_ops,
    pk_for,
    restore_ops,
    row_key,
    rows_equal,
)

from ws_migration_fixture import (
    ALFA, BETA, DELTA, GAMMA, OWNER, SOLO, SOLO_USER, TEAM_A, build_world, facts_for,
)

DATE = "2026-09-21"
RUN = "2026-09-21T15:00:00+00:00"
REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def world():
    tables, storage, rules = build_world()
    facts = facts_for(tables, storage, rules)
    plan = build_plan(tables, facts, migration_date=DATE)
    post = apply_ops(tables, plan.ops, now=RUN)
    return {"tables": tables, "storage": storage, "rules": rules, "facts": facts,
            "plan": plan, "post": post}


def _row(tables, table, **key):
    hits = [r for r in tables[table] if all(r.get(k) == v for k, v in key.items())]
    assert len(hits) == 1, (table, key, hits)
    return hits[0]


def _decision(plan, kind, id_):
    return next(x for x in getattr(plan, kind) if x["id"] == id_)


# ── the decisions ──────────────────────────────────────────────────────

def test_the_company_workspace_keeps_its_served_periods_untouched(world):
    pre, post = world["tables"], world["post"]
    for pid in ("per-sf24", "per-sf25"):
        assert rows_equal(_row(pre, "financial_periods", id=pid), _row(post, "financial_periods", id=pid))
        src = _row(post, "financial_periods", id=pid)["source_document_id"]
        d = _row(post, "documents", id=src)
        assert d["org_id"] == "org-sf" and d["deleted_at"] is None and d["period_id"] == pid


def test_same_month_periods_elsewhere_are_archived_not_the_served_ones(world):
    plan = world["plan"]
    q25 = _decision(plan, "periods", "per-q25")
    assert q25["action"] == "archive" and q25["reason"] == "month_already_served (per-sf25)"
    q24 = _decision(plan, "periods", "per-q24")
    assert q24["action"] == "archive" and q24["reason"] == "month_already_served (per-sf24)"
    holding = holding_org_id(OWNER)
    assert _row(world["post"], "financial_periods", id="per-q25")["org_id"] == holding
    # its source travels with it, and is NOT put in a trash: the source is
    # ON DELETE CASCADE for the period, and "Clear all" on any trash the
    # owner can reach hard-deletes what is in it (2026-09-21 verifier P0 —
    # this line used to assert deleted_at IS NOT NULL, i.e. the defect).
    src = _row(world["post"], "documents", id="q-sf25-src")
    assert src["org_id"] == holding and src["deleted_at"] is None


def test_workspaces_created_per_company_with_prefs(world):
    post = world["post"]
    for cui, name in ((BETA, "BETA IMOBILIARE SRL"), (GAMMA, "GAMMA AGRO SRL"), (DELTA, "DELTA DEVELOPMENT SRL")):
        oid = new_org_id(OWNER, "cui:" + cui)
        org = _row(post, "organizations", id=oid)
        assert org["name"] == name and org["archived_at"] is None
        prefs = _row(post, "org_prefs", org_id=oid)["prefs"]
        assert prefs["cui"] == cui and prefs["company_name"] == name and prefs["identity_sources"]
        assert _row(post, "memberships", org_id=oid, user_id=OWNER)["role"] == "owner"
    carnex = new_org_id(OWNER, "name:CARNEX")
    assert _row(post, "org_prefs", org_id=carnex)["prefs"]["cui"] is None
    assert _row(post, "org_prefs", org_id=carnex)["prefs"]["company_name"] == "Carnex"
    # the existing company workspace is stamped too, its other prefs kept
    sf = _row(post, "org_prefs", org_id="org-sf")["prefs"]
    assert sf["cui"] == ALFA and sf["display_currency"] == "RON"


def test_the_qa_workspace_is_split_and_archived(world):
    post = world["post"]
    qa = _row(post, "organizations", id="org-qa")
    assert qa["archived_at"] == RUN and qa["purge_after"] is None
    live_in_qa = [d for d in post["documents"] if d["org_id"] == "org-qa" and d["deleted_at"] is None]
    assert live_in_qa == []
    assert _row(post, "user_prefs", user_id=OWNER)["active_org_id"] is None
    # the user's chat thread stays where it was (archived with the workspace)
    assert _row(post, "chat_threads", id="ct-1")["org_id"] == "org-qa"


def test_the_2025_book_filed_under_2017_is_re_dated_and_its_hint_corrected(world):
    p = _row(world["post"], "financial_periods", id="per-carnex")
    assert p["period_end"] == p["period_start"] == "2025-12-31"
    assert p["org_id"] == new_org_id(OWNER, "name:CARNEX")
    assert _row(world["post"], "documents", id="q-carnex-src")["period_end_hint"] == "2025-12-31"


def test_the_re_date_rewrites_the_engines_period_detection_record(world):
    """P1 (verifier, 2026-09-21): the Carniprod row was re-dated but its
    stored period_detection still said resolved 2017-12-31, mismatch true —
    served verbatim by /api/org/periods-with-documents (the mismatch chip)
    and read by firm/attention.detect_period_mismatch ('period the file is
    filed under: 2017-12-31'). The record now says what the row says, and
    mismatch is the engine's own rule: a detection pointing elsewhere."""
    pre = _row(world["tables"], "financial_periods", id="per-carnex")["assembled_canonical_v1"]
    env = _row(world["post"], "financial_periods", id="per-carnex")["assembled_canonical_v1"]
    rec = env["period_detection"]
    assert rec["resolved_period_end"] == "2025-12-31" and rec["mismatch"] is False
    assert rec["signal_used"] == "filename" and rec["hint"] == "2025-12-31"
    assert rec["detected"] == pre["period_detection"]["detected"]
    assert rec["migration"]["from"] == "2017-12-31" and rec["migration"]["to"] == "2025-12-31"
    assert rec["migration"]["previous"]["mismatch"] is True
    # the rest of the envelope is untouched
    assert {k: v for k, v in env.items() if k != "period_detection"} == \
        {k: v for k, v in pre.items() if k != "period_detection"}
    # what the attention layer reads: no mismatch item any more
    assert not (isinstance(rec, dict) and rec.get("mismatch") is True)


def test_duplicates_failed_copies_and_non_balances_are_archived_with_reasons(world):
    post = world["post"]
    expect = {
        "d-sf24-copy": "archived: duplicate_of_source (d-sf24-src)",
        "d-sf25-xls": "archived: other_file_same_period (d-sf25-lv)",
        "d-beta-fail-1": "archived: duplicate_of_source (q-beta-src)",
        "d-gamma-pdf": "archived: failed_superseded (q-gamma)",
        "q-carnex-old": "archived: duplicate_of_source (q-carnex-src)",
        "q-delta-2": "archived: duplicate (d-delta-1)",
        "q-itin": "archived: not_a_balance (q-itin)",
    }
    for did, err in expect.items():
        d = _row(post, "documents", id=did)
        assert d["deleted_at"] == RUN and d["error"] == err, did


def test_an_unreadable_copy_inherits_the_identity_of_identical_bytes(world):
    """d-beta-fail-2's object is gone; its content hash is BETA's."""
    d = _row(world["post"], "documents", id="d-beta-fail-2")
    assert d["org_id"] == new_org_id(OWNER, "cui:" + BETA)
    assert d["error"] == "archived: duplicate_of_source (q-beta-src)"


def test_the_itinerary_is_filed_with_the_company_it_names(world):
    assert _row(world["post"], "documents", id="q-itin")["org_id"] == "org-sf"


def test_companies_with_documents_but_no_period_need_reanalysis(world):
    items = {(n["company"], n["document_id"]) for n in world["plan"].needs_reanalysis}
    assert items == {("cui:" + DELTA, "d-delta-1"), ("cui:" + GAMMA, "q-gamma")}
    for did in ("d-delta-1", "q-gamma"):
        d = _row(world["post"], "documents", id=did)
        assert d["deleted_at"] is None and d["period_id"] is None


def test_period_scoped_rows_follow_their_period(world):
    post = world["post"]
    beta = new_org_id(OWNER, "cui:" + BETA)
    holding = holding_org_id(OWNER)
    assert _row(post, "alerts", id="al-2")["org_id"] == beta
    assert _row(post, "alert_states", alert_id="al-2")["org_id"] == beta
    assert _row(post, "briefings", id="br-1")["org_id"] == beta
    assert _row(post, "company_industry_assignments", id="cia-1")["organization_id"] == beta
    assert _row(post, "alerts", id="al-1")["org_id"] == holding
    assert all(m["org_id"] == _row(post, "financial_periods", id=m["period_id"])["org_id"]
               for m in post["calculated_metrics"])


def test_holding_workspace_is_archived_and_never_purgeable(world):
    holding = _row(world["post"], "organizations", id=holding_org_id(OWNER))
    assert holding["name"] == HOLDING_NAME.format(date=DATE)
    assert holding["archived_at"] == RUN and holding["purge_after"] is None
    assert _row(world["post"], "memberships", org_id=holding["id"], user_id=OWNER)["role"] == "owner"


def test_a_second_user_only_gets_the_identity_stamp_and_a_team_is_untouched(world):
    plan = world["plan"]
    solo_ops = [op for op in plan.ops if "org-solo" in repr(op)]
    assert [op["op"] for op in solo_ops] == ["merge_prefs"]
    assert solo_ops[0]["merge"]["cui"] == SOLO
    assert not [op for op in plan.ops if "org-team" in repr(op) or TEAM_A in repr(op)]
    assert any("org-team" in w and "not migrated" in w for w in plan.warnings)


def test_another_users_rule_never_applies(world):
    assert world["facts"]["s-src"].identity.cui == SOLO


# ── gates on the post-state ────────────────────────────────────────────

def _live_orgs(tables):
    return {o["id"] for o in tables["organizations"] if not o.get("archived_at")}


def test_one_company_per_live_workspace_and_one_live_document_per_company_month(world):
    post, facts = world["post"], world["facts"]
    prefs = {p["org_id"]: p["prefs"] for p in post["org_prefs"]}
    owner_orgs = {m["org_id"] for m in post["memberships"] if m["user_id"] == OWNER}
    seen = {}
    for d in post["documents"]:
        if d["org_id"] not in owner_orgs or d["org_id"] not in _live_orgs(post):
            continue
        ident = facts[d["id"]].identity if d["id"] in facts else None
        key = ident.company_key if ident else None
        want = ("cui:" + prefs[d["org_id"]]["cui"]) if prefs[d["org_id"]].get("cui") else \
            "name:" + prefs[d["org_id"]]["company_name"].upper()
        if key and key.startswith("name:ALFA"):
            key = "cui:" + ALFA
        if d["deleted_at"] is None and d.get("scope") == "financial":
            assert key in (None, want), (d["id"], key, want)
            month = (ident.period_end or "")[:7] if ident else None
            assert (key, month) not in seen, (d["id"], seen.get((key, month)))
            seen[(key, month)] = d["id"]


def test_g4_no_empty_period_survives_in_a_live_workspace(world):
    month = DATE[:7]
    before = empty_live_periods(world["tables"], orgs={"org-sf", "org-qa"}, current_month=month)
    assert {p for p, _ in before} >= {"per-sf21", "per-qa-empty-b"}, \
        "the gate must see the planted empties (and the EXTRA placeholder) in the pre-state"
    # without the current-month exemption the placeholders are empties too
    assert {"per-sf-empty", "per-qa-empty-a"} <= {p for p, _ in empty_live_periods(world["tables"],
                                                                                 orgs={"org-sf", "org-qa"})}
    owner_live = {m["org_id"] for m in world["post"]["memberships"] if m["user_id"] == OWNER}
    assert empty_live_periods(world["post"], orgs=owner_live, current_month=month) == []


def test_the_current_month_placeholder_stays_and_an_extra_one_is_archived(world):
    """P2 (verifier, 2026-09-21): the planner archived every workspace's
    current-month placeholder as "empty: no source document". The operator
    rule (2026-07-26, frontend/lib/orgPeriods.ts): every workspace always
    has a period for the current month, and it can't be deleted —
    useEnsureCurrentPeriod re-creates it, so every re-run archived the new
    one and a rollback left two. One per workspace stays; extras go."""
    post, plan = world["post"], world["plan"]
    assert _row(post, "financial_periods", id="per-sf-empty")["org_id"] == "org-sf"
    assert _decision(plan, "periods", "per-sf-empty")["action"] == "untouched"
    assert _row(post, "financial_periods", id="per-qa-empty-a")["org_id"] == "org-qa"      # archived with Q&A
    assert _decision(plan, "periods", "per-qa-empty-b")["reason"] == \
        "empty: extra current-month placeholder (per-qa-empty-a kept)"
    assert _row(post, "financial_periods", id="per-qa-empty-b")["org_id"] == holding_org_id(OWNER)


def test_no_period_is_one_hard_delete_from_erasure(world):
    """Every period's source document ends in the period's own workspace and
    out of every trash — a source in a trash (or elsewhere) is erased by the
    next "Clear all" / purge, and ON DELETE CASCADE takes the period with it.
    The pre-state HAS such periods (per-sf21's source is in the user's
    trash); the post-state has none, and the already-trashed source came
    out of the trash as it moved with its archived period."""
    pre_hazards = period_source_hazards(world["tables"])
    assert ("per-sf21", "source document d-omega-trash is in the trash") in pre_hazards, \
        "the gate must see the planted trashed source in the pre-state"
    assert period_source_hazards(world["post"]) == []
    omega = _row(world["post"], "documents", id="d-omega-trash")
    assert omega["org_id"] == holding_org_id(OWNER) and omega["deleted_at"] is None
    assert _row(world["post"], "financial_periods", id="per-sf21")["org_id"] == holding_org_id(OWNER)
    assert world["plan"].blocking == []
    # PLANT: the migration trashing one archived period's source — exactly
    # the 10fd52ab behaviour — is seen by the gate.
    planted = copy.deepcopy(world["post"])
    _row(planted, "documents", id="q-sf25-src")["deleted_at"] = RUN
    assert period_source_hazards(planted) == [("per-q25", "source document q-sf25-src is in the trash")]


def test_the_failed_source_of_an_empty_period_follows_it_and_is_not_trashed():
    """An EMPTY period (its source failed) is archived into the holding
    workspace; its failed source goes WITH it — never into a live company
    workspace's trash, where "Clear all" would cascade the period away."""
    t = _mini([_doc("ok", "org-a", period="p1"),
               _doc("fail", "org-a", status="failed", period="p2", created="2026-09-02T00:00:00+00:00")],
              [{"id": "p1", "org_id": "org-a", "period_start": "2025-12-31", "period_end": "2025-12-31",
                "source_document_id": "ok"},
               {"id": "p2", "org_id": "org-a", "period_start": "2024-12-31", "period_end": "2024-12-31",
                "source_document_id": "fail"}],
              metrics=[("p1", "org-a"), ("p2", "org-a")])
    facts = {"ok": _ident(ALFA, "2025-12-31"), "fail": _ident(GAMMA, "2024-12-31")}
    plan = build_plan(t, facts, migration_date=DATE)
    assert _decision(plan, "periods", "p2")["reason"] == "empty: source document failed"
    post = apply_ops(t, plan.ops, now=RUN)
    fail = _row(post, "documents", id="fail")
    assert fail["org_id"] == _row(post, "financial_periods", id="p2")["org_id"] == holding_org_id("u")
    assert fail["deleted_at"] is None
    assert period_source_hazards(post) == [] and plan.blocking == []


def test_no_document_or_row_points_into_another_workspace(world):
    assert cross_workspace_links(world["post"]) == []
    # PLANT: the pre-state's links become cross-workspace the moment a
    # period moves without its rows — exactly what the sweep prevents.
    planted = copy.deepcopy(world["post"])
    _row(planted, "documents", id="d-delta-1")["period_id"] = "per-sf25"
    _row(planted, "briefings", id="br-1")["org_id"] = "org-qa"
    assert len(cross_workspace_links(planted)) == 2


def test_the_plan_of_the_post_state_is_empty(world):
    post_facts = dict(world["facts"])  # same bytes -> same identities
    again = build_plan(world["post"], post_facts, migration_date=DATE)
    assert again.ops == [], [op for op in again.ops][:5]
    assert again.blocking == []


def test_g8_restore_on_the_post_state_reproduces_the_pre_state(world):
    pre, post = world["tables"], world["post"]
    ops, notes = restore_ops(pre, post)
    restored = apply_ops(post, ops, now="2026-09-22T00:00:00+00:00")
    created_orgs = set()
    for table, rows in pre.items():
        pk = pk_for(table)
        now_rows = {row_key(r, pk): r for r in restored[table]}
        for r in rows:
            assert rows_equal(r, now_rows[row_key(r, pk)]), (table, r)
    pre_orgs = {o["id"] for o in pre["organizations"]}
    for o in restored["organizations"]:
        if o["id"] not in pre_orgs:
            created_orgs.add(o["id"])
            assert o["archived_at"] is not None and o["purge_after"] is None
    assert holding_org_id(OWNER) in created_orgs and len(created_orgs) == 5
    # created rows without an archive column are reported, never deleted
    assert any("memberships" in n for n in notes) and any("org_prefs" in n for n in notes)


def test_nothing_is_hard_deleted_and_billing_is_never_written(world):
    pre, post, plan = world["tables"], world["post"], world["plan"]
    for table, rows in pre.items():
        pk = pk_for(table)
        have = {row_key(r, pk) for r in post[table]}
        assert all(row_key(r, pk) in have for r in rows), table
    assert {op["op"] for op in plan.ops} <= {"insert", "merge_prefs", "update", "copy_object"}
    touched = {op.get("table") for op in plan.ops}
    assert not touched & {"subscriptions", "user_usage", "billing_events", "chat_threads", "chat_messages"}
    for table in ("subscriptions", "user_usage", "billing_events"):
        assert post[table] == pre[table]


def test_every_moved_document_gets_its_object_copied_under_the_new_workspace(world):
    pre = {d["id"]: d for d in world["tables"]["documents"]}
    copies = {op["document_id"]: op for op in world["plan"].ops if op["op"] == "copy_object"}
    for d in world["post"]["documents"]:
        old = pre[d["id"]]
        if d["org_id"] == old["org_id"]:
            assert d["storage_path"] == old["storage_path"]
            continue
        assert d["storage_path"].startswith(d["org_id"] + "/")
        assert d["storage_path"].split("/", 1)[1] == old["storage_path"].split("/", 1)[1]
        if world["facts"].get(d["id"]) and world["facts"][d["id"]].object_exists is False:
            assert d["id"] not in copies
        else:
            op = copies[d["id"]]
            assert (op["from_path"], op["from_org"], op["to_path"], op["to_org"]) == (
                old["storage_path"], old["org_id"], d["storage_path"], d["org_id"])


# ── rules in isolation ─────────────────────────────────────────────────

def _mini(docs, periods, *, metrics=(), prefs=None, orgs=("org-a",), members=None):
    tables = {
        "organizations": [{"id": o, "name": o, "archived_at": None, "purge_after": None,
                           "default_currency": "RON", "created_at": "2026-01-0%dT00:00:00+00:00" % (i + 1)}
                          for i, o in enumerate(orgs)],
        "memberships": members or [{"org_id": o, "user_id": "u", "role": "owner"} for o in orgs],
        "org_prefs": [{"org_id": k, "prefs": v} for k, v in (prefs or {}).items()],
        "user_prefs": [],
        "financial_periods": periods,
        "documents": docs,
        "calculated_metrics": [{"id": "m%d" % i, "org_id": o, "period_id": p} for i, (p, o) in enumerate(metrics)],
    }
    return tables


def _doc(did, org, *, status="analyzed", period=None, sha=None, created="2026-09-01T00:00:00+00:00"):
    return {"id": did, "org_id": org, "status": status, "period_id": period, "content_hash": sha,
            "deleted_at": None, "scope": "financial", "original_filename": did + ".xlsx",
            "storage_path": "%s/uploads/%s.xlsx" % (org, did), "created_at": created,
            "period_end_hint": None, "error": None, "mime_type": None}


def _ident(cui, end, signal="closing_balance"):
    return DocFacts(identity=CompanyIdentity(cui=cui, company_name="C" + cui, period_end=end,
                                             sources={"company_name": {"signal": "registry", "evidence": ""},
                                                      "period_end": {"signal": signal, "evidence": ""}},
                                             document_kind="trial_balance"))


def _moving_period(filename="d1.xlsx", hint=None):
    """p1 (dated 2025-06-30) sits in org-q, a workspace with no company of
    its own; its company (ALFA) lives in org-a, so p1 MOVES."""
    doc = dict(_doc("d1", "org-q", period="p1"), original_filename=filename, period_end_hint=hint)
    return _mini([doc, _doc("keep-a", "org-a")],
                 [{"id": "p1", "org_id": "org-q", "period_start": "2025-06-30", "period_end": "2025-06-30",
                   "source_document_id": "d1"}],
                 metrics=[("p1", "org-q")], orgs=("org-a", "org-q"), prefs={"org-a": {"cui": ALFA}})


def _redates(plan):
    return [op["set"] for op in plan.ops if op.get("table") == "financial_periods" and "period_end" in op["set"]]


def test_a_filename_only_disagreement_within_the_year_is_not_re_dated():
    plan = build_plan(_moving_period("Balanta_31.12.2025.xlsx"),
                      {"d1": _ident(ALFA, "2025-12-31", signal="filename")}, migration_date=DATE)
    assert _decision(plan, "periods", "p1")["to_org"] == "org-a"
    assert _redates(plan) == []
    assert any("not re-dated (same year)" in w for w in plan.warnings)


def test_a_closing_balance_date_re_dates_a_moving_period_only_when_a_second_signal_agrees():
    """P1 (verifier p8_printdate.py): a print date beside the title
    ('tiparit 15.01.2026') reads as a closing-balance date. Alone it is not
    a period: the filename or the user-confirmed hint must name the same
    month."""
    ident = {"d1": _ident(ALFA, "2025-12-31", signal="closing_balance")}
    plan = build_plan(_moving_period("d1.xlsx"), ident, migration_date=DATE)
    assert _redates(plan) == []
    assert any("no second signal agrees" in w for w in plan.warnings)
    plan = build_plan(_moving_period("Balanta_31.12.2025.xlsx"), ident, migration_date=DATE)
    assert _redates(plan) == [{"period_end": "2025-12-31", "period_start": "2025-12-31"}]
    plan = build_plan(_moving_period("d1.xlsx", hint="2025-12-31"), ident, migration_date=DATE)
    assert _redates(plan) == [{"period_end": "2025-12-31", "period_start": "2025-12-31"}]
    # the document's own period line needs no second signal
    plan = build_plan(_moving_period("d1.xlsx"), {"d1": _ident(ALFA, "2025-12-31", signal="in_document")},
                      migration_date=DATE)
    assert _redates(plan) == [{"period_end": "2025-12-31", "period_start": "2025-12-31"}]


def test_a_served_period_is_never_re_dated():
    """P1 (verifier p8_printdate.py) / P2 (data safety probe_cascade case B):
    a period already in its company's own workspace is the one being
    served. The 10fd52ab planner re-dated it on any closing-balance hit —
    'Balanta de verificare decembrie 2025  tiparit 15.01.2026' moved the
    served December to January. Served months are never re-dated, whatever
    the signal; the disagreement is a warning for an operator."""
    t = _mini([dict(_doc("d1", "org-a", period="p1"), original_filename="Balanta Alfa Food 31.12.2025.xlsx",
                    period_end_hint="2025-12-31")],
              [{"id": "p1", "org_id": "org-a", "period_start": "2025-12-31", "period_end": "2025-12-31",
                "source_document_id": "d1"}], metrics=[("p1", "org-a")])
    for signal, says in (("closing_balance", "2026-01-31"), ("in_document", "2025-11-30")):
        plan = build_plan(t, {"d1": _ident(ALFA, says, signal=signal)}, migration_date=DATE)
        assert _decision(plan, "periods", "p1")["action"] == "keep"
        assert _redates(plan) == [] and not [op for op in plan.ops if op.get("key") == {"id": "d1"}], signal
        assert any("is served in its company's workspace" in w and says in w for w in plan.warnings)


def test_an_unidentified_book_in_a_company_workspace_stays_live_and_unmoved():
    """P0 (verifier, 2026-09-21): a document whose bytes name no company
    used to take the company of the workspace it sits in. In production a
    Scandia Frozen book in a workspace resolving to Carniprod was archived as
    'other_file_same_period (<Carniprod's source>)'. An unknown company is
    UNKNOWN: the book stays live where it is, with a warning."""
    t = _mini([_doc("s", "org-a", period="p1", created="2026-09-01T00:00:00+00:00"),
               _doc("stranger", "org-a", created="2026-09-02T00:00:00+00:00")],
              [{"id": "p1", "org_id": "org-a", "period_start": "2025-12-31", "period_end": "2025-12-31",
                "source_document_id": "s"}], metrics=[("p1", "org-a")], orgs=("org-a", "org-b"))
    unknown = DocFacts(identity=CompanyIdentity(
        company_name="Trial Balance Frozen", period_end="2025-12-31",
        sources={"company_name": {"signal": "filename", "evidence": "x.xlsx"},
                 "period_end": {"signal": "closing_balance", "evidence": "31.12.2025"}},
        document_kind="trial_balance"))
    facts = {"s": _ident(ALFA, "2025-12-31"), "stranger": unknown}
    plan = build_plan(t, facts, migration_date=DATE)
    dec = _decision(plan, "documents", "stranger")
    assert dec["action"] == "untouched" and dec["reason"] == "company unknown", dec
    assert dec["to_org"] == "org-a"
    assert not [op for op in plan.ops if op.get("key") == {"id": "stranger"}]
    assert any("stranger" in w and "company unknown" in w for w in plan.warnings)
    post = apply_ops(t, plan.ops, now=RUN)
    d = _row(post, "documents", id="stranger")
    assert d["deleted_at"] is None and d["org_id"] == "org-a" and d["error"] is None


def test_an_operator_rule_never_reaches_another_users_copy_of_the_bytes():
    """P1 (verifier, 2026-09-21): the content-hash sibling map spanned every
    user. User v's unreadable copy of the same file took user u's
    operator-verified identity, and the plan wrote merge_prefs on v's
    workspace with u's operator evidence (production: 9cb39c90 stamped
    cui 16070576 with the owner's rule text). Rules are scoped to a user;
    so is the inheritance. Within ONE user an unreadable copy still
    inherits its twin's identity."""
    members = [{"org_id": "org-a", "user_id": "u", "role": "owner"},
               {"org_id": "org-b", "user_id": "v", "role": "owner"},
               {"org_id": "org-c", "user_id": "u", "role": "owner"}]
    t = _mini([_doc("a1", "org-a", period="pa", sha="same-bytes"),
               _doc("b1", "org-b", period="pb", sha="same-bytes"),
               _doc("c1", "org-c", sha="same-bytes", created="2026-09-02T00:00:00+00:00")],
              [{"id": "pa", "org_id": "org-a", "period_start": "2025-12-31", "period_end": "2025-12-31",
                "source_document_id": "a1"},
               {"id": "pb", "org_id": "org-b", "period_start": "2025-12-31", "period_end": "2025-12-31",
                "source_document_id": "b1"}],
              metrics=[("pa", "org-a"), ("pb", "org-b")], orgs=("org-a", "org-b", "org-c"), members=members)
    rule_ident = DocFacts(identity=CompanyIdentity(
        cui=ALFA, company_name="ALFA FOOD SRL", period_end="2025-12-31",
        sources={"cui": {"signal": "operator_verified", "evidence": "u's private filing match"},
                 "company_name": {"signal": "operator_verified", "evidence": "u's private filing match"},
                 "period_end": {"signal": "closing_balance", "evidence": "31.12.2025"}},
        document_kind="trial_balance"))
    unreadable = DocFacts(identity=CompanyIdentity(document_kind="unreadable"), object_exists=False)
    plan = build_plan(t, {"a1": rule_ident, "b1": unreadable, "c1": unreadable}, migration_date=DATE)
    assert not [op for op in plan.ops if "org-b" in repr(op)], [op for op in plan.ops if "org-b" in repr(op)]
    assert "u's private filing match" not in repr([op for op in plan.ops if "org-a" not in repr(op)
                                                    and "org-c" not in repr(op)])
    assert _decision(plan, "periods", "pb")["action"] == "unplaced"
    # the same user's unreadable copy still inherits (it is the same file)
    assert _decision(plan, "documents", "c1")["company"] == "cui:" + ALFA


def test_a_created_workspace_carries_the_industry_its_caen_maps_to():
    """P2 (verifier): every created organization was inserted with
    industry_key None even when the identity's CAEN mapped to one."""
    t = _mini([_doc("s", "org-a", period="p1"), _doc("g", "org-a", period="p2")],
              [{"id": "p1", "org_id": "org-a", "period_start": "2025-12-31", "period_end": "2025-12-31",
                "source_document_id": "s"},
               {"id": "p2", "org_id": "org-a", "period_start": "2024-12-31", "period_end": "2024-12-31",
                "source_document_id": "g"}],
              metrics=[("p1", "org-a"), ("p2", "org-a")], prefs={"org-a": {"cui": ALFA}})
    agras = DocFacts(identity=CompanyIdentity(
        cui=GAMMA, company_name="GAMMA AGRO SRL", period_end="2024-12-31", caen_code="1011",
        industry_key=industry_key_for_caen("1011"),
        sources={"company_name": {"signal": "registry", "evidence": ""},
                 "period_end": {"signal": "in_document", "evidence": ""}},
        document_kind="trial_balance"))
    plan = build_plan(t, {"s": _ident(ALFA, "2025-12-31"), "g": agras}, migration_date=DATE)
    row = next(op["row"] for op in plan.ops if op["op"] == "insert" and op["table"] == "organizations"
               and op["row"]["id"] == new_org_id("u", "cui:" + GAMMA))
    assert row["caen_code"] == "1011" and row["industry_key"] == "red_meat_processing"
    assert row["industry_display_name"] == "Red meat processing"


def test_a_company_with_only_failed_uploads_keeps_exactly_one_failed_copy():
    t = _mini([_doc("s", "org-a", period="p1"),
               _doc("f1", "org-a", status="failed", sha="h", created="2026-09-01T00:00:00+00:00"),
               _doc("f2", "org-a", status="failed", sha="h", created="2026-09-02T00:00:00+00:00")],
              [{"id": "p1", "org_id": "org-a", "period_start": "2025-12-31", "period_end": "2025-12-31",
                "source_document_id": "s"}], metrics=[("p1", "org-a")])
    facts = {"s": _ident(ALFA, "2025-12-31"), "f1": _ident(BETA, "2025-12-31"), "f2": _ident(BETA, "2025-12-31")}
    plan = build_plan(t, facts, migration_date=DATE)
    post = apply_ops(t, plan.ops, now=RUN)
    f1, f2 = (_row(post, "documents", id=x) for x in ("f1", "f2"))
    assert f2["deleted_at"] is None and f2["org_id"] == new_org_id("u", "cui:" + BETA)
    assert f1["deleted_at"] == RUN and f1["error"] == "archived: duplicate (f2)"
    assert plan.needs_reanalysis[0]["document_id"] == "f2" and plan.needs_reanalysis[0]["status"] == "failed"


def test_two_workspaces_claiming_one_company_keep_one_and_split_the_other():
    t = _mini([_doc("a1", "org-a", period="pa"), _doc("b1", "org-b", period="pb")],
              [{"id": "pa", "org_id": "org-a", "period_start": "2025-12-31", "period_end": "2025-12-31",
                "source_document_id": "a1"},
               {"id": "pb", "org_id": "org-b", "period_start": "2024-12-31", "period_end": "2024-12-31",
                "source_document_id": "b1"}],
              metrics=[("pa", "org-a"), ("pb", "org-b")], orgs=("org-a", "org-b"),
              prefs={"org-b": {"cui": ALFA}})
    plan = build_plan(t, {"a1": _ident(ALFA, "2025-12-31"), "b1": _ident(ALFA, "2024-12-31")},
                      migration_date=DATE)
    post = apply_ops(t, plan.ops, now=RUN)
    # org-b's prefs name the company: it keeps it; org-a's period moves there
    assert _row(post, "financial_periods", id="pa")["org_id"] == "org-b"
    assert _row(post, "organizations", id="org-a")["archived_at"] == RUN
    assert build_plan(post, {"a1": _ident(ALFA, "2025-12-31"), "b1": _ident(ALFA, "2024-12-31")},
                      migration_date=DATE).ops == []


def test_a_users_only_workspace_is_never_archived():
    t = _mini([_doc("x", "org-a", period="p1")],
              [{"id": "p1", "org_id": "org-a", "period_start": "2025-12-31", "period_end": "2025-12-31",
                "source_document_id": "x"}], metrics=[("p1", "org-a")])
    plan = build_plan(t, {"x": DocFacts(identity=CompanyIdentity(document_kind="trial_balance"))},
                      migration_date=DATE)
    assert not [op for op in plan.ops if op.get("table") == "organizations"]
    assert any("company unknown" in w for w in plan.warnings)


def test_a_document_mid_analysis_blocks_execution_unless_stale():
    t = _mini([_doc("x", "org-a", status="extracting", created="2026-09-21T09:00:00+00:00")], [])
    plan = build_plan(t, {"x": _ident(ALFA, "2025-12-31")}, migration_date=DATE,
                      stale_before="2026-09-21T08:00:00+00:00")
    assert plan.blocking
    plan = build_plan(t, {"x": _ident(ALFA, "2025-12-31")}, migration_date=DATE,
                      stale_before="2026-09-21T10:00:00+00:00")
    assert not plan.blocking


def test_foreign_trash_leaves_a_company_workspace():
    tables, storage, rules = build_world()
    tables = copy.deepcopy(tables)
    extra = dict(_row(tables, "documents", id="d-beta-fail-1"), id="d-beta-trash",
                 deleted_at="2026-09-19T00:00:00+00:00", storage_path="org-sf/uploads/d-beta-trash.pdf")
    tables["documents"].append(extra)
    storage = dict(storage, **{"org-sf/uploads/d-beta-trash.pdf": storage["org-sf/uploads/d-beta-fail-1.pdf"]})
    facts = facts_for(tables, storage, rules)
    post = apply_ops(tables, build_plan(tables, facts, migration_date=DATE).ops, now=RUN)
    moved = _row(post, "documents", id="d-beta-trash")
    assert moved["org_id"] == new_org_id(OWNER, "cui:" + BETA)
    assert moved["deleted_at"] == "2026-09-19T00:00:00+00:00"  # its own trash stamp kept


# ── the SQL the holding workspace relies on ────────────────────────────

def _latest_function(name):
    """The body of the LAST `create or replace function <name>` across the
    migrations, in the order the repo applies them (file name order)."""
    body = None
    for f in sorted((REPO / "supabase").glob("*.sql")):
        text = f.read_text()
        for m in re.finditer(r"create or replace function (?:public\.)?%s\s*\(.*?\$\$(.*?)\$\$" % name,
                             text, re.S | re.I):
            body = (f.name, m.group(1))
    assert body, name
    return body


def test_the_workspace_purge_never_selects_a_null_purge_after():
    """The holding workspace is archived with purge_after NULL. The cron
    purge must key on purge_after < now() — NULL never compares — so it can
    never erase the archive. A purge rewritten to key on archived_at would
    red here before it erased anything."""
    fname, body = _latest_function("purge_expired_workspaces")
    select = re.sub(r"\s+", " ", body.lower())
    assert "purge_after is not null and purge_after < now()" in select, fname
    assert "archived_at" not in select, fname


def test_the_user_purge_refuses_a_held_archive():
    """The migration archives the holding workspace — and the workspaces it
    splits — with purge_after NULL and an 'owner' membership. The cron
    never selects them (above); "Delete forever" (purge_workspace) must not
    either: the LATEST definition refuses an archived workspace with no
    deletion date BEFORE it reaches _purge_org_data. A purge_workspace
    without that guard (schema_phase_workspace_purge_now.sql alone) reds."""
    fname, body = _latest_function("purge_workspace")
    b = re.sub(r"\s+", " ", body.lower())
    guard = b.find("archived_at is not null and purge_after is null")
    purge = b.find("perform _purge_org_data")
    assert 0 <= guard < purge, fname
    assert "raise exception" in b[guard:purge], fname
    _latest_function("workspace_hold_guard_version")   # the marker --execute requires


def test_only_known_callers_reach_the_org_purge_body():
    """A ratchet: every function whose LATEST definition performs
    _purge_org_data / _purge_org_content. purge_workspace is guarded (held
    archives refused), the cron keys on purge_after < now(); the two
    account-level calls erase everything the user owns, archives included,
    on purpose (deleting your account deletes your archive). A NEW caller
    reds here until someone decides what it does to a held archive."""
    names = set()
    for f in sorted((REPO / "supabase").glob("*.sql")):
        for m in re.finditer(r"create or replace function (?:public\.)?(\w+)\s*\(", f.read_text(), re.I):
            names.add(m.group(1).lower())
    callers = set()
    for name in sorted(names - {"_purge_org_data", "_purge_org_content"}):   # the bodies themselves
        _fname, body = _latest_function(name)
        if re.search(r"perform\s+_purge_org_(?:data|content)\s*\(", body, re.I):
            callers.add(name)
    assert callers == {"purge_workspace", "purge_expired_workspaces", "delete_all_my_data",
                       "delete_my_account"}, callers


def test_an_empty_workspace_is_not_archived_just_for_having_no_company():
    """Only a workspace that was SPLIT (a company's period or document
    moved out of it) is archived. A user's second, empty workspace — or one
    holding only an empty placeholder month — stays live."""
    t = _mini([_doc("x", "org-a", period="p1")],
              [{"id": "p1", "org_id": "org-a", "period_start": "2025-12-31", "period_end": "2025-12-31",
                "source_document_id": "x"},
               {"id": "p-empty", "org_id": "org-b", "period_start": "2026-09-30", "period_end": "2026-09-30",
                "source_document_id": None}],
              metrics=[("p1", "org-a")], orgs=("org-a", "org-b"))
    plan = build_plan(t, {"x": _ident(ALFA, "2025-12-31")}, migration_date=DATE)
    post = apply_ops(t, plan.ops, now=RUN)
    assert _row(post, "organizations", id="org-b")["archived_at"] is None
    # p-empty is org-b's current-month placeholder: it stays (G4 exempts it)
    assert _row(post, "financial_periods", id="p-empty")["org_id"] == "org-b"
    assert empty_live_periods(post, current_month=DATE[:7]) == []
    assert any("nothing to split" in w for w in plan.warnings)
