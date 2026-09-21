"""The three operator scripts end to end, against a PostgREST + Storage
double (tests/engine/ws_migration_fixture.FakeSupabase) that pages with a
small db-max-rows cap, refuses unknown columns, records every write and
REFUSES every DELETE.

The double is not production: it cannot prove what PostgREST accepts. What
these prove is the scripts' own contract — the dry-run writes nothing, the
execute refuses on drift / a different plan, applies exactly the plan, is a
no-op when re-run, survives an interruption, the recount agrees, and the
restore puts every snapshot row back without a single delete.
"""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

import pytest

from engine.workspaces import pgrest_io
from engine.workspaces.migration_plan import cross_workspace_links, empty_live_periods, holding_org_id
from engine.workspaces.rowstore import pk_for, row_key, rows_equal

from ws_migration_fixture import OWNER, FakeSupabase, build_world

REPO = Path(__file__).resolve().parents[2]
RUN = "2026-09-21T15:00:00+00:00"


def _load(name):
    spec = importlib.util.spec_from_file_location(name, REPO / "scripts" / ("%s.py" % name))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


snapshot_cli = _load("db_snapshot")
restore_cli = _load("db_restore")
migration_cli = _load("workspace_migration")


@pytest.fixture
def env(tmp_path):
    tables, storage, rules = build_world()
    fake = FakeSupabase(tables, storage, max_rows=5)
    rules_path = tmp_path / "known.json"
    rules_path.write_text(json.dumps({"rules": rules}))
    lines = []
    return {"fake": fake, "pre": copy.deepcopy(tables), "rules": str(rules_path), "tmp": tmp_path,
            "out": lines.append, "lines": lines}


def _snapshot(env, name="snap.json.gz"):
    path = str(env["tmp"] / name)
    assert snapshot_cli.main(["--out", path], client_factory=env["fake"].client, out=env["out"]) == 0
    return path


def _migrate(env, *extra, snap=None):
    args = ["--known-identities", env["rules"], "--out-dir", str(env["tmp"] / "out"), "--migration-date",
            "2026-09-21"]
    if snap:
        args += ["--snapshot", snap]
    return migration_cli.main(list(extra) + args, client_factory=env["fake"].client, out=env["out"],
                              now=RUN, registry=None)


def _plan_sha(env):
    return json.loads((env["tmp"] / "out" / "plan_2026-09-21.json").read_text())["ops_sha256"]


# ── snapshot ───────────────────────────────────────────────────────────

def test_the_snapshot_reads_every_scoped_table_completely_and_only_reads(env):
    path = _snapshot(env)
    snap = pgrest_io.load_snapshot(path)
    names = set(snap["tables"])
    assert {"organizations", "memberships", "org_prefs", "user_prefs", "financial_periods", "documents",
            "user_usage", "subscriptions", "alerts", "alert_states", "statement_line_items",
            "user_valuation_assumptions", "company_industry_assignments", "chat_threads"} <= names
    assert "countries" not in names
    for t in names:   # paged past the 5-row cap, all of it
        assert snap["tables"][t]["count"] == len(env["pre"][t]), t
    assert snap["tables"]["memberships"]["pk"] == ["org_id", "user_id"]
    assert env["fake"].writes == [] and env["fake"].deletes == []


def test_verify_is_equal_then_reports_drift(env):
    path = _snapshot(env)
    assert snapshot_cli.main(["--verify", path], client_factory=env["fake"].client, out=env["out"]) == 0
    env["fake"].tables["documents"][0]["error"] = "touched"
    assert snapshot_cli.main(["--verify", path], client_factory=env["fake"].client, out=env["out"]) == 1
    assert any("documents" in l and "DRIFT" in l for l in env["lines"])


# ── migration ──────────────────────────────────────────────────────────

def test_the_dry_run_writes_nothing(env):
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    assert env["fake"].writes == [] and env["fake"].deletes == []
    out = env["tmp"] / "out"
    assert (out / "plan_2026-09-21.json").is_file() and (out / "facts_2026-09-21.json").is_file()
    assert any("DRY-RUN: nothing was written" in l for l in env["lines"])


def test_execute_refuses_on_drift_and_on_a_different_plan(env):
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    sha = _plan_sha(env)
    assert _migrate(env, "--execute", "--expect-plan-sha", "0" * 64, snap=snap) == 2
    env["fake"].tables["documents"][0]["error"] = "someone was here"
    assert _migrate(env, "--execute", "--expect-plan-sha", sha, snap=snap) == 2
    assert env["fake"].writes == []


def test_execute_applies_the_reviewed_plan_and_the_recount_agrees(env):
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    sha = _plan_sha(env)
    assert _migrate(env, "--execute", "--expect-plan-sha", sha, snap=snap) == 0, "\n".join(env["lines"][-30:])
    fake = env["fake"]
    assert fake.deletes == []
    assert any(l.startswith("RECOUNT: production equals the plan") for l in env["lines"])
    live = fake.tables
    owner_orgs = {m["org_id"] for m in live["memberships"] if m["user_id"] == OWNER}
    assert empty_live_periods(live, orgs=owner_orgs) == []
    assert cross_workspace_links(live) == []
    # every moved document's object exists under its new workspace; old ones kept
    for d in live["documents"]:
        before = next(x for x in env["pre"]["documents"] if x["id"] == d["id"])
        if d["storage_path"] != before["storage_path"] and ("documents/" + before["storage_path"]) in fake.objects:
            assert ("documents/" + d["storage_path"]) in fake.objects
            assert ("documents/" + before["storage_path"]) in fake.objects
    assert next(o for o in live["organizations"] if o["id"] == holding_org_id(OWNER))["purge_after"] is None
    assert not [w for w in fake.writes if w[1] in ("subscriptions", "user_usage", "billing_events")]


def test_a_second_run_on_a_fresh_snapshot_does_nothing(env):
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    assert _migrate(env, "--execute", "--expect-plan-sha", _plan_sha(env), snap=snap) == 0
    writes = len(env["fake"].writes)
    snap2 = _snapshot(env, "snap2.json.gz")
    assert _migrate(env, "--execute", snap=snap2) == 0
    assert any("NOTHING TO DO" in l for l in env["lines"])
    assert len(env["fake"].writes) == writes


def test_an_interrupted_run_resumes_to_the_same_result(env, monkeypatch):
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    sha = _plan_sha(env)
    real = pgrest_io.PgRest.update
    calls = {"n": 0}

    def flaky(self, table, key, patch):
        calls["n"] += 1
        if calls["n"] == 12:
            raise RuntimeError("connection reset (simulated)")
        return real(self, table, key, patch)

    monkeypatch.setattr(pgrest_io.PgRest, "update", flaky)
    with pytest.raises(RuntimeError):
        _migrate(env, "--execute", "--expect-plan-sha", sha, snap=snap)
    monkeypatch.setattr(pgrest_io.PgRest, "update", real)
    # the old snapshot no longer matches: a plain execute refuses, --resume finishes
    assert _migrate(env, "--execute", "--expect-plan-sha", sha, snap=snap) == 2
    assert _migrate(env, "--execute", "--resume", "--expect-plan-sha", sha, snap=snap) == 0, \
        "\n".join(env["lines"][-20:])
    assert env["fake"].deletes == []


def test_a_source_left_in_a_trash_fails_the_recount(env, monkeypatch):
    """PLANT: the database keeps an archived period's source in the trash
    (the run's un-trash PATCH is dropped). The recount must name the cascade
    hazard — a trashed source is one "Clear all" from erasing the period."""
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    fake = env["fake"]
    real = fake._rest

    def keep_in_trash(req, table):
        if req.method == "PATCH" and table == "documents":
            body = json.loads(req.content or b"{}")
            if "deleted_at" in body and body["deleted_at"] is None:
                body.pop("deleted_at")
                import httpx
                req = httpx.Request(req.method, req.url, headers=req.headers, content=json.dumps(body).encode())
        return real(req, table)

    monkeypatch.setattr(fake, "_rest", keep_in_trash)
    assert _migrate(env, "--execute", "--expect-plan-sha", _plan_sha(env), snap=snap) == 1
    assert any("CASCADE HAZARD period per-sf21" in l for l in env["lines"]), "\n".join(env["lines"][-15:])


# ── restore ────────────────────────────────────────────────────────────

def test_restore_puts_every_snapshot_row_back_without_deleting(env):
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    assert _migrate(env, "--execute", "--expect-plan-sha", _plan_sha(env), snap=snap) == 0
    env["lines"].clear()
    assert restore_cli.main([snap], client_factory=env["fake"].client, out=env["out"]) == 0
    assert any("DRY-RUN" in l for l in env["lines"])
    assert any(l.startswith("documents") and "changed=" in l for l in env["lines"])
    writes = len(env["fake"].writes)
    assert restore_cli.main([snap], client_factory=env["fake"].client, out=env["out"]) == 0
    assert len(env["fake"].writes) == writes, "the dry-run wrote"
    with pytest.raises(SystemExit):   # --apply without --tables is refused
        restore_cli.main([snap, "--apply"], client_factory=env["fake"].client, out=env["out"])
    assert restore_cli.main([snap, "--apply", "--tables", "migration"], client_factory=env["fake"].client,
                            out=env["out"], now="2026-09-22T00:00:00+00:00") == 0, "\n".join(env["lines"][-20:])
    fake = env["fake"]
    assert fake.deletes == []
    for table, rows in env["pre"].items():
        pk = pk_for(table, pgrest_io.snapshot_pks(pgrest_io.load_snapshot(snap)))
        cur = {row_key(r, pk): r for r in fake.tables[table]}
        for r in rows:
            assert rows_equal(r, cur[row_key(r, pk)]), (table, r)
    pre_orgs = {o["id"] for o in env["pre"]["organizations"]}
    for o in fake.tables["organizations"]:
        if o["id"] not in pre_orgs:
            assert o["archived_at"] and o["purge_after"] is None


def test_a_write_the_database_silently_drops_fails_the_recount(env, monkeypatch):
    """PLANT: PostgREST answers 200 to a PATCH on financial_periods but the
    row does not change (a trigger, a policy, a stale cache). The run must
    end in exit 1 naming the row — never in 'production equals the plan'."""
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    fake = env["fake"]
    real = fake._rest

    def swallowing(req, table):
        if req.method == "PATCH" and table == "financial_periods":
            hit = [r for r in fake.tables[table] if fake._match(r, fake._filters(req, table)[0])]
            import httpx
            return httpx.Response(200, json=copy.deepcopy(hit))
        return real(req, table)

    monkeypatch.setattr(fake, "_rest", swallowing)
    assert _migrate(env, "--execute", "--expect-plan-sha", _plan_sha(env), snap=snap) == 1
    assert any(l.startswith("RECOUNT: FAILED") for l in env["lines"])
    assert any("MISMATCH: financial_periods" in l for l in env["lines"])
