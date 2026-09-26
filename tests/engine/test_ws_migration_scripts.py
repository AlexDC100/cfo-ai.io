"""The three operator scripts end to end, against a PostgREST + Storage
double (tests/engine/ws_migration_fixture.FakeSupabase) that pages with a
small db-max-rows cap, refuses unknown columns, records every write and
REFUSES every DELETE.

The double is not production: it cannot prove what PostgREST accepts. What
these prove is the scripts' own contract — the dry-run writes nothing, the
execute refuses on drift / a different plan / no reviewed plan sha, applies
exactly the plan, is a no-op when re-run, survives an interruption, the
recount agrees (rows, copies, every moved document's object), and the
rollback undoes exactly the plan's own writes — without a single delete,
and without touching what users did after the run.
"""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

import pytest

from engine.workspaces import pgrest_io
from engine.workspaces.migration_plan import (
    cross_workspace_links,
    empty_live_periods,
    holding_org_id,
    new_org_id,
    period_source_hazards,
)
from engine.workspaces.rowstore import OpConflict, pk_for, row_key, rows_equal, same_value, undo_ops

from ws_migration_fixture import (
    BETA, GAMMA, OWNER, SOLO, SOLO_USER, FakeSupabase, build_world, plant_second_user_move,
)

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


def _plan_path(env):
    return str(env["tmp"] / "out" / "plan_2026-09-21.json")


def _plan(env):
    return json.loads(Path(_plan_path(env)).read_text())


def _plan_sha(env):
    return _plan(env)["ops_sha256"]


def _rollback(env, snap, *extra, now="2026-09-22T00:00:00+00:00"):
    return restore_cli.main([snap, "--plan", _plan_path(env)] + list(extra), client_factory=env["fake"].client,
                            out=env["out"], now=now)


def _migrated(env):
    """snapshot -> dry-run -> execute; returns the snapshot path."""
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    assert _migrate(env, "--execute", "--expect-plan-sha", _plan_sha(env), snap=snap) == 0, \
        "\n".join(env["lines"][-20:])
    return snap


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
    assert empty_live_periods(live, orgs=owner_orgs, current_month="2026-09") == []
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
    assert _migrate(env, snap=snap2) == 0      # the empty plan, reviewed like any other
    assert _migrate(env, "--execute", "--expect-plan-sha", _plan_sha(env), snap=snap2) == 0
    assert any("NOTHING TO DO" in l for l in env["lines"])
    assert len(env["fake"].writes) == writes


def test_execute_refuses_without_the_reviewed_plan_sha(env):
    """Verifier p6-g (2026-09-26): the plan is recomputed at execute time,
    and one transient storage 404 in that facts pass dropped a copy from it
    (604 ops instead of the reviewed 605); with --expect-plan-sha optional
    the un-reviewed plan ran and a document row moved to a path with no
    object. --execute without the reviewed sha is refused before anything
    is read."""
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    with pytest.raises(SystemExit, match="--expect-plan-sha"):
        _migrate(env, "--execute", snap=snap)
    with pytest.raises(SystemExit, match="--expect-plan-sha"):
        _migrate(env, "--execute", "--resume", snap=snap)
    assert env["fake"].writes == []


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


def test_execute_refuses_while_the_purge_hold_guard_is_missing(env):
    """The plan archives workspaces with purge_after NULL (the holding
    archive, the split Q&A). Without supabase/schema_phase_workspace_purge_
    now_hold.sql, purge_workspace() lets the owner erase them with one
    "Delete forever". The dry-run says so; --execute refuses before any
    write."""
    env["fake"].rpcs = set()
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    assert any(l.startswith("HOLD GUARD MISSING") for l in env["lines"])
    assert _migrate(env, "--execute", "--expect-plan-sha", _plan_sha(env), snap=snap) == 2
    assert any("hold guard is not installed" in l for l in env["lines"])
    assert env["fake"].writes == []


def _interrupt_on(monkeypatch, nth):
    real = pgrest_io.PgRest.update
    calls = {"n": 0}

    def flaky(self, table, key, patch):
        calls["n"] += 1
        if calls["n"] == nth:
            raise RuntimeError("connection reset (simulated)")
        return real(self, table, key, patch)

    monkeypatch.setattr(pgrest_io.PgRest, "update", flaky)
    return real


@pytest.mark.parametrize("keep_state", [True, False], ids=["state-file", "no-state-file"])
def test_a_resume_later_in_the_day_finishes_the_run(env, monkeypatch, keep_state):
    """The resume happens minutes later: a fresh clock. Updates already
    applied carry the FIRST run's "$now" (documents.deleted_at, organizations.
    archived_at). The 10fd52ab --resume compared them with its own clock and
    stopped half-migrated with OpConflict (verifier probe_resume.py). Now the
    run's timestamp is recorded before the first write and reused; without
    that file a "$now" column holding any timestamp counts as applied."""
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    sha = _plan_sha(env)
    real = _interrupt_on(monkeypatch, 21)   # after three document archive stamps
    with pytest.raises(RuntimeError):
        _migrate(env, "--execute", "--expect-plan-sha", sha, snap=snap)
    monkeypatch.setattr(pgrest_io.PgRest, "update", real)
    stamped = [d for d in env["fake"].tables["documents"] if d.get("error", "") and
               str(d.get("error")).startswith("archived:") and d.get("deleted_at") == RUN]
    assert stamped, "the interruption must come after some $now writes"
    if not keep_state:
        for f in (env["tmp"] / "out").glob("run_state_*.json"):
            f.unlink()
    later = "2026-09-21T15:07:00+00:00"
    rc = migration_cli.main(["--execute", "--resume", "--expect-plan-sha", sha, "--known-identities", env["rules"],
                             "--out-dir", str(env["tmp"] / "out"), "--migration-date", "2026-09-21",
                             "--snapshot", snap],
                            client_factory=env["fake"].client, out=env["out"], now=later, registry=None)
    assert rc == 0, "\n".join(env["lines"][-20:])
    assert any(l.startswith("RECOUNT: production equals the plan") for l in env["lines"])
    # the first run's stamps are not rewritten
    for d in stamped:
        assert next(x for x in env["fake"].tables["documents"] if x["id"] == d["id"])["deleted_at"] == RUN
    if keep_state:
        assert any(l.startswith("RESUME: reusing the interrupted run's timestamp %s" % RUN) for l in env["lines"])
    assert env["fake"].deletes == []


def test_a_copy_whose_source_vanished_after_planning_stops_before_any_row_moves(env, monkeypatch):
    """PLANT (verifier probe_copy_miss.py): the facts pass reads
    org-qa/uploads/q-carnex-src.xlsx; the copy step's download of the same
    object returns None (a 400/404 at apply time). The 10fd52ab run logged
    "row still moves", repointed the KEPT live source of per-carnex at a
    path with no object and reported "production equals the plan". Now the
    run stops at the copy, before any document row moves."""
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    real = pgrest_io.PgRest.download
    seen = {"n": 0}

    def vanishing(self, bucket, path, *, org_id):
        if path == "org-qa/uploads/q-carnex-src.xlsx":
            seen["n"] += 1
            if seen["n"] > 1:          # the facts pass got it; the copy does not
                return None
        return real(self, bucket, path, org_id=org_id)

    monkeypatch.setattr(pgrest_io.PgRest, "download", vanishing)
    with pytest.raises(OpConflict, match="q-carnex-src.xlsx: the object the plan read"):
        _migrate(env, "--execute", "--expect-plan-sha", _plan_sha(env), snap=snap)
    doc = next(d for d in env["fake"].tables["documents"] if d["id"] == "q-carnex-src")
    assert doc["storage_path"] == "org-qa/uploads/q-carnex-src.xlsx" and doc["org_id"] == "org-qa"
    assert not [w for w in env["fake"].writes if w[0] == "patch" and w[1] == "documents"]


def _second_user_moves_too(env):
    """The second user's workspace gets a document of another company (a
    copy in ITS block of the plan); the snapshot is taken after."""
    fake = env["fake"]
    storage = {k[len("documents/"):]: v for k, v in fake.objects.items()}
    did = plant_second_user_move(fake.tables, storage)
    path = "org-solo/uploads/%s.pdf" % did
    fake.objects["documents/" + path] = storage[path]
    env["pre"] = copy.deepcopy(fake.tables)
    return did


def test_every_storage_copy_lands_before_the_first_row_write(env):
    """Rule 9's order on the wire: on a full run every upload the double
    records precedes every row write — the copies of BOTH users."""
    did = _second_user_moves_too(env)
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    plan = _plan(env)
    copies = [op for op in plan["ops"] if op["op"] == "copy_object"]
    assert {op["from_org"] for op in copies} >= {"org-qa", "org-solo"}
    assert _migrate(env, "--execute", "--expect-plan-sha", plan["ops_sha256"], snap=snap) == 0, \
        "\n".join(env["lines"][-20:])
    kinds = [w[0] for w in env["fake"].writes]
    assert "upload" in kinds and kinds.index("upload") == 0
    last_upload = max(i for i, k in enumerate(kinds) if k == "upload")
    first_row = min(i for i, k in enumerate(kinds) if k != "upload")
    assert last_upload < first_row, kinds[:40]
    moved = next(d for d in env["fake"].tables["documents"] if d["id"] == did)
    assert moved["org_id"] == new_org_id(SOLO_USER, "cui:" + BETA)
    assert ("documents/" + moved["storage_path"]) in env["fake"].objects


def test_a_copy_conflict_in_a_later_users_block_leaves_no_user_half_applied(env, monkeypatch):
    """Verifier (2026-09-26): the plan was emitted per user — the first
    user's inserts and row moves, THEN the second user's copies. The
    second user's copy source vanishing at copy time stopped the run with
    the first user fully migrated and the second not at all: a half-applied
    production that only --resume could finish. Now every copy of every
    user precedes the first row operation: the same conflict stops the run
    before ONE row has been written, for anybody."""
    did = _second_user_moves_too(env)
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    sha = _plan_sha(env)
    real = pgrest_io.PgRest.download
    seen = {"n": 0}

    def vanishing(self, bucket, path, *, org_id):
        if path == "org-solo/uploads/%s.pdf" % did:
            seen["n"] += 1
            if seen["n"] > 1:          # the facts pass read it; the copy step does not find it
                return None
        return real(self, bucket, path, org_id=org_id)

    monkeypatch.setattr(pgrest_io.PgRest, "download", vanishing)
    with pytest.raises(OpConflict, match="%s.pdf: the object the plan read" % did):
        _migrate(env, "--execute", "--expect-plan-sha", sha, snap=snap)
    fake = env["fake"]
    assert fake.row_writes() == [], "rows were written before the copy conflict: %s" % fake.row_writes()[:5]
    assert [w for w in fake.writes if w[0] == "upload"], "the earlier copies did land (idempotent residue)"
    # production is still the snapshot: no --resume needed, a plain re-run
    # (once the object is back) applies the whole reviewed plan
    assert snapshot_cli.main(["--verify", snap], client_factory=fake.client, out=env["out"]) == 0
    monkeypatch.setattr(pgrest_io.PgRest, "download", real)
    assert _migrate(env, "--execute", "--expect-plan-sha", sha, snap=snap) == 0, "\n".join(env["lines"][-12:])
    assert any(l.startswith("RECOUNT: production equals the plan") for l in env["lines"])


def test_a_copy_with_the_wrong_bytes_fails_the_recount(env, monkeypatch):
    """PLANT: the storage write lands different bytes (a truncated upload).
    The recount compares every copied object with the sha256 the plan read."""
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    real = pgrest_io.PgRest.upload

    def truncating(self, bucket, path, content, *, org_id, content_type):
        if path.endswith("/uploads/q-carnex-src.xlsx"):
            content = content[: len(content) // 2]
        return real(self, bucket, path, content, org_id=org_id, content_type=content_type)

    monkeypatch.setattr(pgrest_io.PgRest, "upload", truncating)
    assert _migrate(env, "--execute", "--expect-plan-sha", _plan_sha(env), snap=snap) == 1
    assert any("MISMATCH: storage" in l and "q-carnex-src" in l and "the plan read" in l for l in env["lines"])


def test_resume_refuses_drift_that_this_plan_did_not_write(env, monkeypatch):
    """Verifier finding (2026-09-21): --resume switched the drift gate off
    entirely — ANY difference from the snapshot was accepted. Now a resume
    accepts only rows the plan's own operations explain (a prefix of them,
    per row); a row the plan never touches that changed, is refused."""
    snap = _snapshot(env)
    assert _migrate(env, snap=snap) == 0
    sha = _plan_sha(env)
    real = _interrupt_on(monkeypatch, 21)
    with pytest.raises(RuntimeError):
        _migrate(env, "--execute", "--expect-plan-sha", sha, snap=snap)
    monkeypatch.setattr(pgrest_io.PgRest, "update", real)
    # someone renames the second user's document meanwhile (the plan never touches it)
    next(d for d in env["fake"].tables["documents"] if d["id"] == "s-src")["display_name"] = "renamed"
    writes = len(env["fake"].writes)
    assert _migrate(env, "--execute", "--resume", "--expect-plan-sha", sha, snap=snap) == 2
    assert any("foreign drift: documents ['s-src']" in l for l in env["lines"])
    assert len(env["fake"].writes) == writes


def test_execute_refuses_a_snapshot_of_another_database(env):
    snap_path = _snapshot(env)
    import gzip
    raw = json.loads(gzip.open(snap_path).read().decode("utf-8"))
    raw["source"] = "https://another-project.supabase.co"
    with gzip.open(snap_path, "wb") as fh:
        fh.write(json.dumps(raw).encode("utf-8"))
    assert _migrate(env, "--execute", "--resume", "--expect-plan-sha", "0" * 64, snap=snap_path) == 2
    assert any(l.startswith("SOURCE MISMATCH") for l in env["lines"])
    assert env["fake"].writes == []


def test_a_document_whose_object_cannot_be_read_when_planning_blocks_the_plan(env):
    """Verifier p6 (2026-09-26): a document identified by an operator rule
    keeps its identity without its bytes, so a 404 during the facts pass
    silently dropped its copy_object (the planner's "object_exists is
    False -> no copy, row still moves" branch) while the row still moved.
    The snapshot's object inventory recorded the object: the plan is
    BLOCKING for that document — the row does not move without its file —
    and --execute refuses."""
    snap = _snapshot(env)
    fake = env["fake"]
    assert pgrest_io.load_snapshot(snap)["objects"]["q-carnex-src"]["exists"] is True
    gone = fake.objects.pop("documents/org-qa/uploads/q-carnex-src.xlsx")   # a 404 from now on
    assert _migrate(env, snap=snap) == 0
    plan = _plan(env)
    blocking = [b for b in plan["blocking"] if b.startswith("document q-carnex-src ")]
    assert blocking and "could not be read when planning" in blocking[0] \
        and "inventory recorded it" in blocking[0], plan["blocking"]
    assert not [op for op in plan["ops"] if op.get("table") == "documents" and op.get("key") == {"id": "q-carnex-src"}]
    assert not [op for op in plan["ops"] if op["op"] == "copy_object" and op["document_id"] == "q-carnex-src"]
    assert _migrate(env, "--execute", "--expect-plan-sha", plan["ops_sha256"], snap=snap) == 2
    assert any("REFUSED" in l and "blocking" in l for l in env["lines"])
    assert fake.writes == []
    # the object is back: the plan moves the document with a verified copy
    fake.objects["documents/org-qa/uploads/q-carnex-src.xlsx"] = gone
    assert _migrate(env, snap=snap) == 0
    plan = _plan(env)
    assert plan["blocking"] == []
    copy_op = next(op for op in plan["ops"] if op["op"] == "copy_object" and op["document_id"] == "q-carnex-src")
    assert copy_op["expect_sha256"] and copy_op["must_exist"] is True
    # ... and a transient 404 during the EXECUTE-time facts pass changes the
    # plan (blocking, fewer ops): the reviewed sha refuses it, nothing written
    sha = plan["ops_sha256"]
    real = fake.handle
    hits = {"n": 0}

    def transient(req):
        if req.method == "POST" and req.url.path.endswith("/object/sign/documents/org-qa/uploads/q-carnex-src.xlsx"):
            hits["n"] += 1
            if hits["n"] == 1:
                import httpx
                return httpx.Response(400, json={"statusCode": "404", "error": "not_found"})
        return real(req)

    fake.handle = transient
    assert _migrate(env, "--execute", "--expect-plan-sha", sha, snap=snap) == 2
    fake.handle = real
    assert fake.writes == []
    assert any(l.startswith("REFUSED") for l in env["lines"])


def test_a_document_the_snapshot_recorded_without_an_object_still_moves(env):
    """The one case a row moves without a file: the object was missing when
    the snapshot was taken AND when planning (a failed upload whose object
    never landed). Its copy is opportunistic (must_exist false), the run
    logs it, and the recount does not require the object."""
    snap = _snapshot(env)
    assert pgrest_io.load_snapshot(snap)["objects"]["d-beta-fail-2"]["exists"] is False
    assert _migrate(env, snap=snap) == 0
    plan = _plan(env)
    copy_op = next(op for op in plan["ops"] if op["op"] == "copy_object" and op["document_id"] == "d-beta-fail-2")
    assert copy_op["must_exist"] is False and copy_op["expect_sha256"] is None
    assert any("d-beta-fail-2" in w and "was missing when the snapshot was taken" in w for w in plan["warnings"])
    assert _migrate(env, "--execute", "--expect-plan-sha", plan["ops_sha256"], snap=snap) == 0
    assert any("[" in l and "d-beta-fail-2" in l and "row still moves" in l for l in env["lines"])
    assert any(l.startswith("RECOUNT: production equals the plan") for l in env["lines"])
    moved = next(d for d in env["fake"].tables["documents"] if d["id"] == "d-beta-fail-2")
    assert moved["org_id"] == new_org_id(OWNER, "cui:" + BETA)


def test_a_copy_the_snapshot_recorded_that_is_gone_at_copy_time_stops_the_run(env, monkeypatch):
    """A copy without a sha (the facts pass never read the bytes — a
    non-financial source, say) whose source is gone at copy time: the
    inventory recorded the object, so the run stops before any document
    row moves — never "row still moves"."""
    snap = _snapshot(env)
    real_build = migration_cli.build_plan

    def unread(*a, **kw):
        built = real_build(*a, **kw)
        built.ops = [dict(op, expect_sha256=None) if op["op"] == "copy_object" and op["document_id"] == "q-carnex-src"
                     else op for op in built.ops]
        return built

    monkeypatch.setattr(migration_cli, "build_plan", unread)
    assert _migrate(env, snap=snap) == 0
    sha = _plan_sha(env)
    op = next(op for op in _plan(env)["ops"] if op["op"] == "copy_object" and op["document_id"] == "q-carnex-src")
    assert op["expect_sha256"] is None and op["must_exist"] is True
    real = pgrest_io.PgRest.download
    seen = {"n": 0}

    def vanishing(self, bucket, path, *, org_id):
        if path == "org-qa/uploads/q-carnex-src.xlsx":
            seen["n"] += 1
            if seen["n"] > 1:          # the facts pass got it; the copy does not
                return None
        return real(self, bucket, path, org_id=org_id)

    monkeypatch.setattr(pgrest_io.PgRest, "download", vanishing)
    with pytest.raises(OpConflict, match="q-carnex-src.xlsx: the object is gone, and the snapshot recorded it present"):
        _migrate(env, "--execute", "--expect-plan-sha", sha, snap=snap)
    assert not [w for w in env["fake"].writes if w[0] == "patch" and w[1] == "documents"]


def test_the_recount_checks_a_re_dated_periods_records_not_only_the_plans_columns(env, monkeypatch):
    """PLANT: a plan that re-dates the row but forgot the §7 detection
    envelope (its op stripped of the column, set and expect alike). The
    plan is internally consistent, so it runs; the recount must read the
    period's stored records against its row and fail naming the envelope
    — never "production equals the plan" over a period whose envelope
    still says another date."""
    snap = _snapshot(env)
    real_build = migration_cli.build_plan

    def forgetting_the_envelope(*a, **kw):
        built = real_build(*a, **kw)
        for op in built.ops:
            if op.get("table") == "financial_periods" and op.get("key") == {"id": "per-carnex"} \
                    and "period_end" in op["set"]:
                op["set"].pop("detection_envelope", None)
                op["expect"].pop("detection_envelope", None)
        return built

    monkeypatch.setattr(migration_cli, "build_plan", forgetting_the_envelope)
    assert _migrate(env, snap=snap) == 0
    assert _plan(env)["blocking"] == []
    assert _migrate(env, "--execute", "--expect-plan-sha", _plan_sha(env), snap=snap) == 1
    row = next(p for p in env["fake"].tables["financial_periods"] if p["id"] == "per-carnex")
    assert row["period_end"] == "2025-12-31" and row["detection_envelope"]["period_end"] == "2026-09-20"
    assert any(l.startswith("RECOUNT: FAILED") for l in env["lines"])
    assert any("MISMATCH: RE-DATED period per-carnex: detection_envelope.period_end says 2026-09-20, the row "
               "2025-12-31" in l for l in env["lines"]), "\n".join(env["lines"][-12:])
    # the real plan carries the envelope: the run ends with every record agreeing
    monkeypatch.setattr(migration_cli, "build_plan", real_build)
    env["lines"].clear()


def test_the_recount_checks_every_moved_documents_object_not_only_the_planned_copies(env, monkeypatch):
    """PLANT the p6 shape at the recount: a plan that LOST a copy (its copy
    op stripped) but still moves the row. 8ff706e3's recount verified the
    planned copies only, so it said "production equals the plan" while the
    document pointed at a path with nothing under it. Every moved
    document's storage_path must resolve."""
    snap = _snapshot(env)
    real_build = migration_cli.build_plan

    def losing_a_copy(*a, **kw):
        built = real_build(*a, **kw)
        built.ops = [op for op in built.ops
                     if not (op["op"] == "copy_object" and op["document_id"] == "q-carnex-src")]
        return built

    monkeypatch.setattr(migration_cli, "build_plan", losing_a_copy)
    assert _migrate(env, snap=snap) == 0
    assert _migrate(env, "--execute", "--expect-plan-sha", _plan_sha(env), snap=snap) == 1
    moved = next(d for d in env["fake"].tables["documents"] if d["id"] == "q-carnex-src")
    assert moved["org_id"] != "org-qa" and ("documents/" + moved["storage_path"]) not in env["fake"].objects
    assert any(l.startswith("RECOUNT: FAILED") for l in env["lines"])
    assert any("MISMATCH: storage" in l and "q-carnex-src" in l and "no object" in l for l in env["lines"]), \
        "\n".join(env["lines"][-12:])


# ── rollback ───────────────────────────────────────────────────────────


def test_the_snapshot_records_which_document_objects_existed(env):
    snap = pgrest_io.load_snapshot(_snapshot(env))
    objects = snap["objects"]
    assert objects["q-carnex-src"] == {"path": "org-qa/uploads/q-carnex-src.xlsx", "org_id": "org-qa",
                                       "exists": True}
    assert objects["d-beta-fail-2"]["exists"] is False      # never stored
    assert env["fake"].writes == []


def _plant_after_the_run(env):
    """What users do between the run and a rollback: a new upload in the
    company workspace (document + period + metric + object), a workspace
    the owner creates (with membership and prefs), a preference changed
    on a row the plan stamped, an onboarding prefs row on a pre-existing
    workspace the plan never named, a renamed and continued conversation."""
    fake = env["fake"]
    tmpl = next(d for d in fake.tables["documents"] if d["id"] == "d-sf25-lv")
    doc = dict(tmpl, id="d-new-upload", original_filename="Balanta Alfa Food_31.01.2026.xlsx",
               period_id="per-new", content_hash="f" * 64, created_at="2026-09-22T08:00:00+00:00",
               updated_at="2026-09-22T08:00:00+00:00", storage_path="org-sf/uploads/d-new-upload.xlsx",
               period_end_hint="2026-01-31", deleted_at=None, error=None)
    fake.tables["documents"].append(doc)
    fake.objects["documents/" + doc["storage_path"]] = b"PK-new-upload-bytes"
    per = dict(next(p for p in fake.tables["financial_periods"] if p["id"] == "per-sf25"), id="per-new",
               period_start="2026-01-31", period_end="2026-01-31", source_document_id="d-new-upload",
               created_at="2026-09-22T08:01:00+00:00", updated_at="2026-09-22T08:01:00+00:00")
    fake.tables["financial_periods"].append(per)
    fake.tables["calculated_metrics"].append(dict(next(m for m in fake.tables["calculated_metrics"]
                                                       if m["period_id"] == "per-sf25"),
                                                  id="cm-new", period_id="per-new"))
    fake.tables["organizations"].append(dict(next(o for o in fake.tables["organizations"] if o["id"] == "org-sf"),
                                             id="org-new", name="Alfa Retail SRL", archived_at=None,
                                             purge_after=None, created_at="2026-09-22T09:00:00+00:00"))
    fake.tables["memberships"].append({"org_id": "org-new", "user_id": OWNER, "role": "owner",
                                       "created_at": "2026-09-22T09:00:00+00:00"})
    fake.tables["org_prefs"].append({"org_id": "org-new", "prefs": {"display_currency": "EUR"},
                                     "updated_at": "2026-09-22T09:00:10+00:00"})
    sf = next(p for p in fake.tables["org_prefs"] if p["org_id"] == "org-sf")
    assert sf["prefs"].get("cui") == "2000001" + sf["prefs"]["cui"][-1]   # stamped by the plan
    sf["prefs"] = dict(sf["prefs"], display_currency="EUR")
    assert not any(p["org_id"] == "org-team" for p in fake.tables["org_prefs"])
    fake.tables["org_prefs"].append({"org_id": "org-team", "prefs": {"workspace_onboarded": True},
                                     "updated_at": "2026-09-22T10:30:00+00:00"})
    th = next(t for t in fake.tables["chat_threads"] if t["id"] == "ct-1")
    assert th["org_id"] == "org-sf"                                        # moved by the plan
    th["title"] = "renamed by the owner after the migration"
    fake.tables["chat_messages"].append({"id": "cm-q-3", "thread_id": "ct-1", "role": "user", "content": "more",
                                         "grounded_period": None, "created_at": "2026-09-22T11:00:00+00:00"})
    return copy.deepcopy(fake.tables)


def test_the_rollback_undoes_the_plans_own_writes_and_nothing_else(env):
    """Verifier p2 (2026-09-26): the 8ff706e3 rollback was a table-wide
    snapshot restore. After a real run it trashed a document uploaded
    AFTER the snapshot (leaving its period with its source in the trash:
    a cascade hazard and a G4 offender), archived a workspace the owner had
    created as a HELD archive (listed nowhere, no user recovery), reverted
    another user's post-run preference, emptied a pre-existing workspace's
    NEW org_prefs row (onboarding) and reverted a conversation's title —
    while printing "every snapshot row is back" and exiting 0. The rollback
    is now the undo of exactly the plan's operations."""
    fake = env["fake"]
    snap = _migrated(env)
    plan = _plan(env)
    planted = _plant_after_the_run(env)
    pks = pgrest_io.snapshot_pks(pgrest_io.load_snapshot(snap))
    # dry-run: writes nothing
    env["lines"].clear()
    writes = len(fake.writes)
    assert _rollback(env, snap) == 0
    assert len(fake.writes) == writes and any(l.startswith("DRY-RUN") for l in env["lines"])
    assert any(l.startswith("UNDO: ") and "0 conflict(s)" in l for l in env["lines"]), env["lines"][-3:]
    # apply
    env["lines"].clear()
    assert _rollback(env, snap, "--apply") == 0, "\n".join(env["lines"][-25:])
    assert fake.deletes == []
    assert any(l.startswith("UNDO CHECK: every row the plan touched is back") for l in env["lines"])
    assert any(l.startswith("STORAGE CHECK: every moved document finds its object") for l in env["lines"])
    after = fake.tables
    # every column the plan wrote is back at its pre-image (a second undo finds nothing)
    again = undo_ops(plan["ops"], after, env["pre"], pks=pks)
    assert again["ops"] == [] and again["conflicts"] == []
    for op in plan["ops"]:
        if op["op"] != "update":
            continue
        row = next(r for r in after[op["table"]] if row_key(r, pk_for(op["table"], pks)) ==
                   row_key(op["key"], pk_for(op["table"], pks)))
        for c, v in op["expect"].items():
            assert same_value(row.get(c), v), (op["table"], op["key"], c, row.get(c), v)
    # the workspaces the plan created are held; the stamp on org-solo is gone
    pre_orgs = {o["id"] for o in env["pre"]["organizations"]}
    for w in plan["workspaces"]:
        if w["action"] == "create":
            o = next(x for x in after["organizations"] if x["id"] == w["org_id"])
            assert o["archived_at"] and o["purge_after"] is None, o
    assert next(p for p in after["org_prefs"] if p["org_id"] == "org-solo")["prefs"] == {}
    # PLANTED: everything users did after the run is untouched
    d = next(x for x in after["documents"] if x["id"] == "d-new-upload")
    assert d["deleted_at"] is None and d["period_id"] == "per-new" and d["error"] is None
    assert ("documents/" + d["storage_path"]) in fake.objects
    assert next(p for p in after["financial_periods"] if p["id"] == "per-new")["source_document_id"] == "d-new-upload"
    assert any(m["id"] == "cm-new" for m in after["calculated_metrics"])
    assert [h for h in period_source_hazards(after) if h[0] == "per-new"] == []
    assert [g for g in empty_live_periods(after, current_month="2026-09") if g[0] == "per-new"] == []
    o = next(x for x in after["organizations"] if x["id"] == "org-new")
    assert o["archived_at"] is None and o["purge_after"] is None
    assert next(p for p in after["org_prefs"] if p["org_id"] == "org-new")["prefs"] == {"display_currency": "EUR"}
    sf = next(p for p in after["org_prefs"] if p["org_id"] == "org-sf")["prefs"]
    assert sf == {"display_currency": "EUR"}, sf        # the user's change kept, the plan's keys gone
    assert next(p for p in after["org_prefs"] if p["org_id"] == "org-team")["prefs"] == {"workspace_onboarded": True}
    th = next(t for t in after["chat_threads"] if t["id"] == "ct-1")
    assert th["org_id"] == "org-qa" and th["active_period_id"] == "per-q25"      # undone
    assert th["title"] == "renamed by the owner after the migration"           # kept
    assert any(m["id"] == "cm-q-3" for m in after["chat_messages"])
    # rows the plan never named are exactly as planted (updated_at aside)
    named = {(op["table"], row_key(op.get("row") or op.get("key"), pk_for(op["table"], pks)))
             for op in plan["ops"] if op["op"] != "copy_object"}
    for table, rows in planted.items():
        cur = {row_key(r, pk_for(table, pks)): r for r in after[table]}
        for r in rows:
            key = row_key(r, pk_for(table, pks))
            if (table, key) not in named:
                assert rows_equal(r, cur[key]), (table, key)
    # what stays is counted, never deleted
    residue = [l for l in env["lines"] if l.startswith("RESIDUE: ")]
    assert residue and "memberships" in residue[0] and "storage copies" in residue[0], env["lines"][-6:]
    assert all(("documents/" + x["storage_path"]) in fake.objects for x in planted["documents"]
               if ("documents/" + x["storage_path"]) in fake.objects)
    # a second rollback finds nothing to do
    env["lines"].clear()
    writes = len(fake.writes)
    assert _rollback(env, snap, "--apply") == 0
    assert len(fake.writes) == writes
    assert any(l.startswith("UNDO: 0 operation(s) to apply") for l in env["lines"]), env["lines"][:3]


def test_the_rollback_refuses_while_a_row_the_plan_touched_changed_since(env):
    """A row the plan wrote that a user changed afterwards holds neither
    the plan's values nor its pre-image: the rollback names it and refuses
    to write anything; --leave-conflicts undoes everything else, leaves
    that row as the user left it, and exits 1 (not exact)."""
    fake = env["fake"]
    snap = _migrated(env)
    dup = next(d for d in fake.tables["documents"] if d["id"] == "d-sf24-copy")
    assert dup["deleted_at"] and dup["error"].startswith("archived: duplicate")   # archived by the plan
    dup["deleted_at"] = None                                                     # the owner restores it
    env["lines"].clear()
    writes = len(fake.writes)
    assert _rollback(env, snap, "--apply") == 2
    assert len(fake.writes) == writes
    assert any(l.startswith("  CONFLICT: documents") and "d-sf24-copy" in l for l in env["lines"])
    assert any(l.startswith("REFUSED") for l in env["lines"])
    env["lines"].clear()
    assert _rollback(env, snap, "--apply", "--leave-conflicts") == 1
    assert next(d for d in fake.tables["documents"] if d["id"] == "d-sf24-copy")["deleted_at"] is None
    assert next(p for p in fake.tables["financial_periods"] if p["id"] == "per-beta")["org_id"] == "org-qa"
    assert any(l.startswith("UNDO CHECK: 1 row(s)") for l in env["lines"]), env["lines"][-6:]
    assert fake.deletes == []


def test_a_rollback_after_a_purge_erased_the_originals_is_not_a_clean_rollback(env):
    """The owner "Delete forever"s the archived Q&A workspace after the
    migration (verifier case 2): _purge_org_data deletes its rows by org_id
    and every object under 'org-qa/'. The rollback re-inserts the rows the
    plan named from the snapshot (their pre-image) — and must exit 1 naming
    the documents whose objects no longer exist, never "every row is back"
    alone."""
    snap = _migrated(env)
    fake = env["fake"]
    for key in [k for k in fake.objects if k.startswith("documents/org-qa/")]:
        del fake.objects[key]
    for table in ("documents", "financial_periods", "chat_threads", "org_prefs", "organizations"):
        col = "id" if table == "organizations" else "org_id"
        fake.tables[table] = [r for r in fake.tables[table] if r.get(col) != "org-qa"]
    env["lines"].clear()
    assert _rollback(env, snap, "--apply") == 1
    assert any(l.startswith("  re-insert organizations") and "org-qa" in l for l in env["lines"])
    assert any(l.startswith("UNDO CHECK: every row the plan touched is back") for l in env["lines"])
    missing = [l for l in env["lines"] if l.startswith("  STORAGE MISSING: document q-carnex-src ")]
    assert missing, "\n".join(env["lines"][-20:])
    assert any(l.startswith("STORAGE CHECK: ") and "missing" in l for l in env["lines"])
    assert next(o for o in fake.tables["organizations"] if o["id"] == "org-qa")["archived_at"] is None
    assert fake.deletes == []


def test_a_run_after_a_rollback_ends_where_the_first_run_ended(env):
    """Found while repairing: migrate -> db_restore -> a fresh snapshot ->
    migrate --execute (the documented recovery). The rollback archives the
    workspaces the first run created; the second run used to 'insert' them
    (a no-op on the archived rows) and move every surviving period into a
    workspace nobody can see — with RECOUNT agreeing. It now brings them
    back, and production ends where the first run ended."""
    fake = env["fake"]
    snap = _migrated(env)
    first = copy.deepcopy(fake.tables)
    assert _rollback(env, snap, "--apply") == 0, env["lines"][-10:]
    snap2 = _snapshot(env, "snap2.json.gz")
    assert _migrate(env, snap=snap2) == 0
    plan = _plan(env)
    assert sorted(w["action"] for w in plan["workspaces"] if w["action"] in ("create", "unarchive")) == \
        ["unarchive"] * 4 and plan["blocking"] == []
    env["lines"].clear()
    assert _migrate(env, "--execute", "--expect-plan-sha", _plan_sha(env), snap=snap2) == 0, env["lines"][-10:]
    assert any(l.startswith("RECOUNT: production equals the plan") for l in env["lines"])
    for table in ("financial_periods", "documents"):
        assert {r["id"]: r["org_id"] for r in fake.tables[table]} == \
            {r["id"]: r["org_id"] for r in first[table]}, table
    live = lambda t: sorted(o["id"] for o in t["organizations"] if not o["archived_at"])  # noqa: E731
    assert live(fake.tables) == live(first)
    assert fake.deletes == []


def test_a_rollback_that_leaves_a_stamp_on_a_pre_existing_workspace_fails(env, monkeypatch):
    """PLANT: the undo of the plan's merge_prefs on org-solo does not
    happen (an op dropped, a write swallowed). The dry-run names the undo,
    and --apply must end in exit 1 — never "every row ... is back"."""
    snap = _migrated(env)
    env["lines"].clear()
    assert _rollback(env, snap) == 0
    assert any(l.startswith("  undo org_prefs") and "org-solo" in l and "company_name" in l for l in env["lines"]), \
        env["lines"][:12]
    real = restore_cli.undo_ops

    def dropping(*a, **kw):
        undo = real(*a, **kw)
        undo["ops"] = [op for op in undo["ops"] if not (op.get("table") == "org_prefs"
                                                        and op["key"].get("org_id") == "org-solo")]
        return undo

    monkeypatch.setattr(restore_cli, "undo_ops", dropping)
    env["lines"].clear()
    assert _rollback(env, snap, "--apply") == 1
    check = [l for l in env["lines"] if l.startswith("UNDO CHECK: ")]
    assert check and "not at their pre-image" in check[0], check
    assert any(l.startswith("  NOT UNDONE: org_prefs") and "org-solo" in l for l in env["lines"])
    assert next(p for p in env["fake"].tables["org_prefs"] if p["org_id"] == "org-solo")["prefs"]["cui"] == SOLO


def test_the_rollback_refuses_a_plan_that_is_not_the_one_that_ran(env):
    snap = _migrated(env)
    plan = _plan(env)
    plan["ops"] = plan["ops"][:-1]
    Path(_plan_path(env)).write_text(json.dumps(plan))
    with pytest.raises(SystemExit, match="not the plan that ran"):
        _rollback(env, snap, "--apply")
    with pytest.raises(SystemExit, match="--plan"):
        restore_cli.main([snap], client_factory=env["fake"].client, out=env["out"])
    assert not [w for w in env["fake"].writes if w[0] != "upload"][len(env["fake"].row_writes()):]


def test_the_whole_table_restore_is_explicit_and_refuses_users_rows_created_since(env):
    """The table-wide restore stays as an operator tool behind
    --whole-tables. It archives rows created since the snapshot — users'
    data — so --apply refuses them unless --i-accept-user-data-changes."""
    fake = env["fake"]
    snap = _migrated(env)
    _plant_after_the_run(env)
    env["lines"].clear()
    writes = len(fake.writes)
    assert restore_cli.main([snap, "--whole-tables"], client_factory=fake.client, out=env["out"]) == 0
    assert len(fake.writes) == writes
    assert any(l.startswith("USER DATA:") and "documents: created 1" in l for l in env["lines"]), env["lines"][-4:]
    env["lines"].clear()
    assert restore_cli.main([snap, "--whole-tables", "--apply", "--tables", "migration"], client_factory=fake.client,
                            out=env["out"], now="2026-09-22T00:00:00+00:00") == 2
    assert len(fake.writes) == writes and any(l.startswith("REFUSED") for l in env["lines"])
    assert next(d for d in fake.tables["documents"] if d["id"] == "d-new-upload")["deleted_at"] is None
    env["lines"].clear()
    assert restore_cli.main([snap, "--whole-tables", "--apply", "--tables", "migration",
                             "--i-accept-user-data-changes"], client_factory=fake.client,
                            out=env["out"], now="2026-09-22T00:00:00+00:00") == 0, env["lines"][-8:]
    assert any(l.startswith("RESTORE CHECK: every snapshot row is back") for l in env["lines"])
    assert next(d for d in fake.tables["documents"] if d["id"] == "d-new-upload")["deleted_at"]   # accepted
    assert fake.deletes == []


def test_the_whole_table_restore_refuses_a_row_a_user_changed_since_the_snapshot(env):
    """P1-A (2026-09-26): --whole-tables refused only rows CREATED since
    the snapshot. A user's edit of a row the snapshot has (a renamed
    workspace, a restored document, a changed preference) is not a
    creation, so --apply went ahead and silently reverted it. Now ANY row
    created, changed or vanished since the snapshot refuses --apply unless
    --i-accept-user-data-changes; the dry-run names them."""
    fake = env["fake"]
    snap = _snapshot(env)                                   # no migration ran
    ws = next(o for o in fake.tables["organizations"] if o["id"] == "org-sf")
    ws["name"] = "alfa food (renamed by its owner)"          # a change, not a creation
    env["lines"].clear()
    writes = len(fake.writes)
    assert restore_cli.main([snap, "--whole-tables"], client_factory=fake.client, out=env["out"]) == 0
    assert len(fake.writes) == writes
    assert any(l.startswith("USER DATA:") and "organizations: created 0, changed 1" in l for l in env["lines"]), \
        env["lines"][-4:]
    env["lines"].clear()
    assert restore_cli.main([snap, "--whole-tables", "--apply", "--tables", "migration"], client_factory=fake.client,
                            out=env["out"], now="2026-09-22T00:00:00+00:00") == 2
    assert len(fake.writes) == writes and any(l.startswith("REFUSED") and "changed" in l for l in env["lines"])
    assert ws["name"] == "alfa food (renamed by its owner)"
    env["lines"].clear()
    assert restore_cli.main([snap, "--whole-tables", "--apply", "--tables", "migration",
                             "--i-accept-user-data-changes"], client_factory=fake.client,
                            out=env["out"], now="2026-09-22T00:00:00+00:00") == 0, env["lines"][-8:]
    assert ws["name"] == "alfa food"                         # accepted explicitly
    assert fake.deletes == []


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
