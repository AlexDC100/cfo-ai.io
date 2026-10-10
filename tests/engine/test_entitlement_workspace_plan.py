"""THE WORKSPACE'S PLAN GATES A RE-RUN — and the refusal it stores names nobody's.

OWNER RULING (2026-10-02, verbatim): "the WORKSPACE's plan gates a re-run,
never whoever uploaded_by names; the caller must be a member. Never write
plan names into the shared documents.error — store a neutral code, render
the message per viewer."

THE DEFECT (tenancy sweep 2026-10-02, measured on the release head). A run
that holds no document slot — /retry or a correction of a counted book, the
ai-lane force-reextract, an operator script — reached the non-RO plan gate
(`pipeline._enforce_nonro_plan_gate`) on the daemon thread, which carries
only the document id. It read the subscription of whoever
`documents.uploaded_by` named — a column the BROWSER writes (the
`documents member update` policy has no column restriction):

  · `uploaded_by` = a Multi user who is not a member → the run was entitled
    by a stranger's plan;
  · `uploaded_by` = a colleague on Solo → the Multi owner's own workspace
    was refused;
  · `uploaded_by` NULL (the uploader's account deleted: `on delete set
    null`, or one PATCH) → the gate PASSED with no plan check at all;
  · the refusal stored `plan_key` and "…aren't included in the RO Solo
    plan" in `documents.error` — a row every member and every firm viewer
    reads — from BOTH branches of the gate;
  · an unreachable meter stored `ValueError: dictionary update sequence
    element #0 has length 1; 2 is required` instead of its code.

WHAT RUNS HERE. Nothing of the gate is stubbed. `_run_pipeline_sync` →
`_run_pipeline_stages` → the REAL `stage_extract` over a Hungarian ledger
(the REAL jurisdiction resolver routes it by its language) →
`_maybe_route_ai_lane` → `_enforce_nonro_plan_gate` →
`_usage_gate.workspace_nonro_refusal` → `_org.workspace_owner_ids` and the
REAL `_plan_state.get_plan_state`, both reading an in-memory PostgREST
double that RECORDS every read → the REAL failure handler → the REAL
`_admin_set_status` → `documents.error`. Two seams are replaced: the storage
download (bytes in hand) and `ai_lane.run_ai_lane`, which raises
`_ReachedTheAiLane` — so "the gate let the run through" is a recorded fact
(`documents.error` starts with that class name), not an inference.

WHAT THESE RED ON, with the defect repaired (TC-11):
  · the gate reading `documents.uploaded_by`, or any subscription other than
    the workspace owner's, on a run that holds no document slot;
  · a non-member's plan entitling a workspace, or a member's (non-owner's)
    plan refusing or entitling it;
  · a NULL `uploaded_by`, a workspace with no owner row, or a document with
    no `org_id` passing the gate;
  · the owner being picked by sort order (`order=role.asc` returns the
    'admin' — the firm's responsible accountant) instead of by role;
  · `documents.error` carrying `plan_key`, a plan's display name, `message`
    or `upgrade_to`, from either branch;
  · the unreachable meter storing anything but its code;
  · the first, metered run being gated by anyone but its verified reserver
    (D2 — that branch never read `uploaded_by` and is unchanged);
  · a non-member starting a re-run through the route.
"""
from __future__ import annotations

import json
import types
from typing import Any, Dict, List, Optional, Tuple

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.api import _doc_dedupe, _org, _pricing_config, _supabase, _usage_gate, pipeline

from dedupe_fakes import FakeDB

ORG = "0a0a0a0a-0000-4000-8000-0000000000a1"          # the workspace under test
ELSEWHERE = "0b0b0b0b-0000-4000-8000-0000000000b2"    # where the strangers live
OWNER = "11111111-1111-4111-8111-111111111111"
SECOND_OWNER = "22222222-2222-4222-8222-222222222222"
COLLEAGUE = "33333333-3333-4333-8333-333333333333"    # a member, never the owner
ACCOUNTANT = "44444444-4444-4444-8444-444444444444"   # role 'admin' (firm import)
STRANGER_SOLO = "55555555-5555-4555-8555-555555555555"   # not a member of ORG
STRANGER_MULTI = "66666666-6666-4666-8666-666666666666"  # not a member of ORG
PERIOD = "77777777-7777-4777-8777-777777777777"
DOC = "hu-book"

#: A Hungarian general-ledger extract. The REAL resolver routes it into the
#: non-RO lane by its language (Számla / Megnevezés / Tartozik / Követel /
#: Egyenleg / Összesen) — no `jurisdiction_hint`, nothing injected.
HU_LEDGER = ("Számla;Megnevezés;Tartozik;Követel;Egyenleg\n"
             "311;Vevők;1000;0;1000\n"
             "454;Szállítók;0;1000;-1000\n"
             "Összesen;;1000;1000;0\n").encode("utf-8")

#: THE EXPECTED STORED STRINGS, stated here — never taken from the function
#: that prints them (a printer compared with itself agrees with its defect).
STORED = {
    "non_ro_not_included": 'NonRoNotIncludedError: {"error": "non_ro_not_included"}',
    "nonro_quota_exhausted": 'NonRoNotIncludedError: {"error": "nonro_quota_exhausted"}',
    "metering_unavailable": 'NonRoNotIncludedError: {"error": "metering_unavailable"}',
}


class _ReachedTheAiLane(Exception):
    """Raised in place of `ai_lane.run_ai_lane`: the plan gate let the run
    through. The failure handler stores `_ReachedTheAiLane: …`."""


class RecordingDB(FakeDB):
    """`dedupe_fakes.FakeDB` (the PostgREST filter grammar, in memory) that
    records every select — table, filters, order, limit — and can make one
    table unreadable. It serves `admin()` and `per_user(jwt)` alike: these
    gates are about WHICH rows the engine asks for, and it applies no
    row-level security of its own."""

    def __init__(self, tables: Dict[str, List[Dict[str, Any]]]) -> None:
        super().__init__(tables)
        self.reads: List[Tuple[str, Dict[str, str], Optional[str], Optional[int]]] = []
        self.unreadable: set = set()

    def select(self, table: str, *, filters: Optional[Dict[str, str]] = None, columns: str = "*",
               limit: Optional[int] = None, order: Optional[str] = None,
               single: bool = False) -> List[Dict[str, Any]]:
        self.reads.append((table, dict(filters or {}), order, limit))
        if table in self.unreadable:
            raise RuntimeError("PostgREST 503: upstream connect error (%s)" % table)
        return super().select(table, filters=filters, columns=columns, limit=limit,
                              order=order, single=single)

    def signed_url(self, bucket: str, path: str, *, org_id: Any = None, expires_in: int = 300) -> str:
        return "https://not-fetched.invalid/%s" % path


class _Download:
    """`httpx.Client` as stage_extract uses it: one GET of the signed URL."""

    def __init__(self, *a: Any, **k: Any) -> None:
        pass

    def __enter__(self) -> "_Download":
        return self

    def __exit__(self, *a: Any) -> bool:
        return False

    def get(self, url: str) -> Any:
        return types.SimpleNamespace(content=HU_LEDGER, raise_for_status=lambda: None)


def _member(user: str, role: str, created: str, org: str = ORG) -> Dict[str, Any]:
    return {"user_id": user, "org_id": org, "role": role, "created_at": created}


def _sub(user: str, tier: str) -> Dict[str, Any]:
    return {"user_id": user, "tier": tier, "stripe_subscription_id": None,
            "extra_docs_billed_period": 0, "extra_docs_pending": 0}


def _document(*, uploaded_by: Any, org: Any = ORG, status: str = "queued",
              period_id: Any = None) -> Dict[str, Any]:
    return {"id": DOC, "org_id": org, "uploaded_by": uploaded_by, "status": status,
            "created_at": "2026-10-01T09:00:00+00:00", "pipeline_started_at": None,
            "period_id": period_id, "period_end_hint": None, "deleted_at": None, "error": None,
            "content_hash": "a" * 64, "metered_extra": False, "scope": "financial",
            "storage_path": "%s/uploads/fokonyvi_kivonat.csv" % org,
            "original_filename": "fokonyvi_kivonat.csv", "mime_type": "text/csv"}


class World:
    def __init__(self, db: RecordingDB, meter: List[Tuple[str, Dict[str, Any]]],
                 enqueued: List[str], rpc_answers: Dict[str, Any]) -> None:
        self.db = db
        self.meter = meter
        self.enqueued = enqueued
        self.rpc_answers = rpc_answers

    # ── seeding ────────────────────────────────────────────────────────
    def members(self, *rows: Dict[str, Any]) -> "World":
        self.db.tables["memberships"] = [dict(r) for r in rows] + [
            # The strangers own a workspace of their own — they are real
            # accounts with real plans, just not members of ORG.
            _member(STRANGER_SOLO, "owner", "2025-01-01T00:00:00+00:00", ELSEWHERE),
            _member(STRANGER_MULTI, "owner", "2025-01-02T00:00:00+00:00", ELSEWHERE),
        ]
        return self

    def plans(self, **tiers: str) -> "World":
        """`plans(OWNER="multi")` by the module-level names above."""
        ids = globals()
        self.db.tables["subscriptions"] = [_sub(ids[name], tier) for name, tier in tiers.items()] + [
            _sub(STRANGER_SOLO, "solo"), _sub(STRANGER_MULTI, "multi")]
        return self

    def document(self, **kw: Any) -> "World":
        self.db.tables["documents"] = [_document(**kw)]
        return self

    # ── the run ────────────────────────────────────────────────────────
    def run(self, *, staged_rerun: bool = False) -> str:
        """The daemon thread's whole run, for real. Returns what it stored
        in `documents.error`.

        `staged_rerun`: the run a Docs-panel re-run queued for a document
        that OWNS its period (gate rerun-data-loss, stage 2, 2026-10-04). It
        is staged beside the month: refused or failed, the document is NOT
        marked failed — it stays `analyzed` over the month it still serves —
        and its row carries `rerun_failed: ` in front of the very text a
        first run stores. Returned WITHOUT that prefix, so the assertions on
        the stored refusal are the same ones."""
        self.db.reads.clear()
        pipeline._run_pipeline_sync(DOC)
        row = self.db.rows("documents")[0]
        if staged_rerun:
            assert row["status"] == "analyzed" and str(row["error"]).startswith("rerun_failed: "), row
            return str(row["error"])[len("rerun_failed: "):]
        assert row["status"] == "failed", row
        return str(row["error"])

    # ── what was read ──────────────────────────────────────────────────
    def plans_read(self) -> List[str]:
        return sorted({f["user_id"][3:] for t, f, _o, _l in self.db.reads if t == "subscriptions"})

    def owner_lookups(self) -> List[Dict[str, str]]:
        return [f for t, f, _o, _l in self.db.reads if t == "memberships"]

    def ids_in_any_filter(self, user_id: str) -> List[Any]:
        return [(t, f) for t, f, _o, _l in self.db.reads if any(user_id in str(v) for v in f.values())]


def _passed(stored: str) -> bool:
    return stored.startswith("_ReachedTheAiLane")


@pytest.fixture()
def world(monkeypatch) -> World:
    for var in list(__import__("os").environ):
        if var.startswith("PRICING_"):
            monkeypatch.delenv(var, raising=False)
    _pricing_config.reload_for_test()
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "1")
    monkeypatch.delenv("USAGE_UNMETERED_USER_IDS", raising=False)
    monkeypatch.delenv("ENGINE_JOURNAL_DIR", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-never-be-used")
    monkeypatch.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")

    db = RecordingDB({
        "memberships": [], "subscriptions": [], "documents": [], "user_usage": [],
        "plan_chat_daily_usage": [], "document_quota_ledger": [],
        "organizations": [{"id": ORG, "name": "Kft", "archived_at": None,
                           "industry_key": None, "industry_display_name": None}],
        "financial_periods": [{"id": PERIOD, "org_id": ORG, "period_end": "2025-12-31",
                               "source_document_id": DOC}],
    })
    meter: List[Tuple[str, Dict[str, Any]]] = []
    enqueued: List[str] = []
    rpc_answers: Dict[str, Any] = {}

    def rpc(name: str, payload: Dict[str, Any]) -> Any:
        meter.append((name, dict(payload)))
        return rpc_answers.get(name, {})

    def reached(**kw: Any) -> Any:
        raise _ReachedTheAiLane("the plan gate let this run into the non-RO lane")

    monkeypatch.setattr(_supabase, "admin", lambda: db)
    monkeypatch.setattr(_supabase, "per_user", lambda jwt: db)
    monkeypatch.setattr(pipeline, "httpx", types.SimpleNamespace(Client=_Download))
    monkeypatch.setattr(pipeline._ai_lane, "run_ai_lane", reached)
    monkeypatch.setattr(_usage_gate, "_rpc", rpc)
    monkeypatch.setattr(pipeline, "_QUOTA_RUNS", {})
    monkeypatch.setattr(_doc_dedupe, "_ARCHIVED_HERE", set())
    monkeypatch.setattr(pipeline, "_enqueue", lambda doc_id: enqueued.append(doc_id))
    monkeypatch.setattr(pipeline, "_require_jwt",
                        lambda authorization=None: (authorization or "").split(" ", 1)[-1])
    monkeypatch.setattr(pipeline._org, "verified_user_id", lambda jwt: jwt.split(":", 1)[-1])
    monkeypatch.setattr(pipeline._org, "resolve_user_id", lambda jwt: jwt.split(":", 1)[-1])
    try:  # no test here may reach a model, whatever path a defect opens
        import anthropic as _anthropic

        def _no_client(*a: Any, **k: Any) -> Any:
            raise AssertionError("a non-RO entitlement test constructed an Anthropic client")

        monkeypatch.setattr(_anthropic, "Anthropic", _no_client)
    except ImportError:
        pass
    yield World(db, meter, enqueued, rpc_answers)
    _pricing_config.reload_for_test()


#: `uploaded_by` as the browser can leave it. None of these four may decide.
UPLOADERS = {
    "a_non_member_on_solo": STRANGER_SOLO,
    "a_non_member_on_multi": STRANGER_MULTI,
    "null": None,
    "a_colleague_on_the_other_plan": COLLEAGUE,
}


# ── 1. The owner's plan decides, whoever `uploaded_by` names ─────────────


@pytest.mark.parametrize("uploader", sorted(UPLOADERS))
@pytest.mark.parametrize("owner_tier,entitled", [("multi", True), ("solo", False)])
def test_the_workspace_owners_plan_decides_whoever_uploaded_by_names(world, owner_tier, entitled, uploader):
    """A holder-less non-RO re-run in ORG. The outcome is the OWNER's plan in
    every row; the id `uploaded_by` names is asked nothing."""
    colleague_tier = "solo" if owner_tier == "multi" else "multi"
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"),
                  _member(COLLEAGUE, "member", "2026-01-02T00:00:00+00:00"))
    world.plans(OWNER=owner_tier, COLLEAGUE=colleague_tier)
    world.document(uploaded_by=UPLOADERS[uploader])

    stored = world.run()

    assert _passed(stored) is entitled, (owner_tier, uploader, stored)
    if not entitled:
        assert stored == STORED["non_ro_not_included"], stored
    # The gate's subject was really exercised (not a vacuous "nothing read")…
    assert world.plans_read() == [OWNER], world.db.reads
    assert world.owner_lookups() == [{"org_id": "eq.%s" % ORG, "role": "eq.owner"}], world.db.reads
    # …and whoever the row names was never asked anything, in any table.
    named = UPLOADERS[uploader]
    if named is not None:
        assert world.ids_in_any_filter(named) == [], world.ids_in_any_filter(named)
    # A re-run reserves and settles nothing (verifier P-E, 2026-09-21).
    assert world.meter == [], world.meter


def test_a_null_uploader_is_gated_by_the_workspace_not_waved_through(world):
    """The bypass, by name: `uploaded_by` NULL used to RETURN before any plan
    read — a non-Romanian re-run with no check at all. It is refused in a
    Solo owner's workspace and passes in a Multi owner's, like every row."""
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"))
    world.plans(OWNER="solo").document(uploaded_by=None)
    assert world.run() == STORED["non_ro_not_included"]
    world.plans(OWNER="multi").document(uploaded_by=None)
    assert _passed(world.run())


# ── 2. Fail closed: no owner, no workspace, an unreadable owner ──────────


def test_a_workspace_with_no_owner_row_is_refused(world):
    """Members and an admin — every one of them on Multi — and nobody holds
    the owner role. Nobody's plan stands in for the workspace's."""
    world.members(_member(COLLEAGUE, "member", "2026-01-02T00:00:00+00:00"),
                  _member(ACCOUNTANT, "admin", "2026-01-01T00:00:00+00:00"))
    world.plans(COLLEAGUE="multi", ACCOUNTANT="multi").document(uploaded_by=STRANGER_MULTI)
    assert world.run() == STORED["non_ro_not_included"]
    assert world.owner_lookups() == [{"org_id": "eq.%s" % ORG, "role": "eq.owner"}]
    assert world.plans_read() == [], "a plan was read for a workspace nobody owns: %r" % world.db.reads


def test_a_document_with_no_workspace_is_refused(world):
    """No `org_id` on the row → refused, and no `memberships` read at all: an
    unfiltered one under the service role would answer every workspace's
    owner, and the oldest of them would then entitle the run."""
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"))
    world.plans(OWNER="multi").document(uploaded_by=STRANGER_MULTI, org=None)
    assert world.run() == STORED["non_ro_not_included"]
    assert world.owner_lookups() == [] and world.plans_read() == [], world.db.reads
    # The gate itself, for the shapes a row cannot have but a caller can pass.
    for doc in ({"id": "x"}, {"id": "x", "org_id": ""}, {"id": "x", "org_id": "   "},
                {"id": "x", "uploaded_by": STRANGER_MULTI}):
        world.db.reads.clear()
        with pytest.raises(_usage_gate.NonRoNotIncludedError) as exc:
            pipeline._enforce_nonro_plan_gate(doc)
        assert str(exc.value) == '{"error": "non_ro_not_included"}', doc
        assert world.db.reads == [], world.db.reads


def test_an_unreadable_owner_lookup_is_refused_with_its_code(world):
    """The `memberships` read fails. The run is refused — never waved
    through — and the row stores the code, not the transport error."""
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"))
    world.plans(OWNER="multi").document(uploaded_by=STRANGER_MULTI)
    world.db.unreadable.add("memberships")
    stored = world.run()
    assert stored == STORED["metering_unavailable"], stored
    assert "503" not in stored and "RuntimeError" not in stored


def test_an_owner_with_no_subscription_row_is_the_trial_plan(world):
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"))
    world.plans().document(uploaded_by=STRANGER_MULTI)
    assert world.run() == STORED["non_ro_not_included"]
    assert world.plans_read() == [OWNER]


# ── 3. WHO the owner is ───────────────────────────────────────────────────


@pytest.mark.parametrize("owner_tier,accountant_tier,entitled",
                         [("multi", "solo", True), ("solo", "multi", False)])
def test_the_owner_is_resolved_by_role_never_by_sort_order(world, owner_tier, accountant_tier, entitled):
    """A firm client workspace: the importing firm member is the owner, the
    responsible accountant holds 'admin' — and joined FIRST. `order=role.asc,
    limit=1` (the renewal recipient's shape in `_billing.py`) answers the
    accountant, because 'admin' sorts before 'owner'."""
    world.members(_member(ACCOUNTANT, "admin", "2025-06-01T00:00:00+00:00"),
                  _member(COLLEAGUE, "member", "2025-07-01T00:00:00+00:00"),
                  _member(OWNER, "owner", "2026-01-01T00:00:00+00:00"))
    world.plans(OWNER=owner_tier, ACCOUNTANT=accountant_tier, COLLEAGUE=accountant_tier)
    world.document(uploaded_by=ACCOUNTANT)
    stored = world.run()
    assert _passed(stored) is entitled, stored
    assert world.plans_read() == [OWNER], world.db.reads


@pytest.mark.parametrize("first,second,entitled",
                         [("solo", "multi", True), ("multi", "solo", True), ("solo", "pro", False)])
def test_any_owner_entitles_the_workspace_and_none_refuses_it(world, first, second, entitled):
    """The schema does not constrain a workspace to one owner. Entitled if
    ANY owner is — in either order — and refused when none is."""
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"),
                  _member(SECOND_OWNER, "owner", "2026-03-01T00:00:00+00:00"),
                  _member(COLLEAGUE, "member", "2026-02-01T00:00:00+00:00"))
    world.plans(OWNER=first, SECOND_OWNER=second, COLLEAGUE="multi")
    world.document(uploaded_by=COLLEAGUE)
    stored = world.run()
    assert _passed(stored) is entitled, stored
    assert COLLEAGUE not in world.plans_read(), world.db.reads


def test_an_operator_exempt_owner_entitles_the_workspace_and_an_exempt_uploader_does_not(world, monkeypatch):
    """USAGE_UNMETERED_USER_IDS: the operator's own workspaces are not
    metered. The exemption is the OWNER's — the exempt account named in
    `uploaded_by` of somebody else's workspace opens nothing."""
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"))
    world.plans(OWNER="solo").document(uploaded_by=STRANGER_SOLO)
    monkeypatch.setenv("USAGE_UNMETERED_USER_IDS", STRANGER_SOLO)
    assert world.run() == STORED["non_ro_not_included"]
    monkeypatch.setenv("USAGE_UNMETERED_USER_IDS", OWNER)
    assert _passed(world.run())
    assert world.plans_read() == [], "an exempt owner's plan need not be read"


def test_the_owner_resolver_trusts_no_row_it_did_not_ask_for():
    """`_org.workspace_owner_ids`, over a client that IGNORES its filters (a
    double that waves everything through, a policy that changes): rows of
    another workspace or another role are dropped; oldest first; once each;
    a blank workspace is never read."""
    calls: List[Dict[str, Any]] = []
    rows = [_member(ACCOUNTANT, "admin", "2025-01-01T00:00:00+00:00"),
            _member(STRANGER_MULTI, "owner", "2025-02-01T00:00:00+00:00", ELSEWHERE),
            _member(OWNER, "owner", "2026-01-01T00:00:00+00:00"),
            _member(SECOND_OWNER, "owner", "2026-03-01T00:00:00+00:00"),
            _member(OWNER, "owner", "2026-04-01T00:00:00+00:00"),
            {"user_id": None, "org_id": ORG, "role": "owner", "created_at": "2026-05-01"}]

    class _Sloppy:
        def __enter__(self) -> "_Sloppy":
            return self

        def __exit__(self, *a: Any) -> None:
            return None

        def select(self, table: str, **kw: Any) -> List[Dict[str, Any]]:
            calls.append({"table": table, **kw})
            return [dict(r) for r in rows]

    real = _supabase.admin
    _supabase.admin = lambda: _Sloppy()  # type: ignore[assignment]
    try:
        assert _org.workspace_owner_ids(ORG) == [OWNER, SECOND_OWNER]
        assert [c["table"] for c in calls] == ["memberships"]
        assert calls[0]["filters"] == {"org_id": "eq.%s" % ORG, "role": "eq.owner"}
        assert calls[0].get("limit") is None, "a limit can cut the owner off"
        for blank in (None, "", "   "):
            assert _org.workspace_owner_ids(blank) == []
        assert len(calls) == 1, "a blank workspace was read: %r" % calls[1:]
    finally:
        _supabase.admin = real  # type: ignore[assignment]


# ── 4. What `documents.error` stores ──────────────────────────────────────


def _forbidden_in_a_shared_row() -> List[str]:
    """Everything that says whose plan it was — derived from the pricing
    config, so a plan added later is covered without editing this list."""
    out = ["plan_key", "message", "upgrade_to", "Upgrade", "plan"]
    for plan in _pricing_config.CONFIG.plans.values():
        out.append(str(plan.display_name))
        out.append('"%s"' % plan.key)
    assert len(out) >= 10, out
    return out


def _assert_names_no_plan(stored: str) -> None:
    prefix = "NonRoNotIncludedError: "
    assert stored.startswith(prefix), stored
    payload = json.loads(stored[len(prefix):])
    assert sorted(payload) == ["error"], payload
    assert payload["error"] in ("non_ro_not_included", "nonro_quota_exhausted",
                                "metering_unavailable"), payload
    hits = [word for word in _forbidden_in_a_shared_row() if word in stored]
    assert hits == [], "documents.error is read by every member — it names %r: %s" % (hits, stored)


@pytest.mark.parametrize("tier", ["no_row", "intro", "solo", "pro", "starter"])
def test_a_refused_rerun_stores_the_code_and_no_plan(world, tier):
    """The re-run branch, through the real failure handler, for every plan
    that does not include non-RO documents. It used to store `plan_key` and
    "…aren't included in the <display name> plan" of whoever the row named."""
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"),
                  _member(COLLEAGUE, "member", "2026-01-02T00:00:00+00:00"))
    world.plans(**({} if tier == "no_row" else {"OWNER": tier}))
    world.document(uploaded_by=COLLEAGUE)
    stored = world.run()
    assert stored == STORED["non_ro_not_included"], stored
    _assert_names_no_plan(stored)


def _first_metered_run(world: World, reserver: str) -> None:
    """THIS run holds a document-slot reservation made under the verified
    `reserver` (a first analysis through /run): the in-process ledger, as
    `_meter_first_analysis` leaves it."""
    assert pipeline._register_quota_run(DOC, user_id=reserver, was_extra=False) is True


@pytest.mark.parametrize("case,code", [("the_reservers_plan_excludes_non_ro", "non_ro_not_included"),
                                       ("the_monthly_non_ro_cap_is_reached", "nonro_quota_exhausted")])
def test_a_refused_first_run_stores_the_code_and_no_plan(world, case, code):
    """The reserving branch published the RESERVER's plan the same way:
    `plan_key` plus "You've used all 8 non-Romanian documents included in the
    Multi-Country plan this month." on the shared row."""
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"))
    if case == "the_reservers_plan_excludes_non_ro":
        world.plans(OWNER="pro")
    else:
        world.plans(OWNER="multi")
        world.rpc_answers["reserve_user_nonro_upload"] = {"kind": "blocked", "used": 8}
    world.document(uploaded_by=OWNER)
    _first_metered_run(world, OWNER)
    stored = world.run()
    assert stored == STORED[code], stored
    _assert_names_no_plan(stored)
    # The refused run gives its document slot back (nothing counted).
    assert "release_user_upload" in [name for name, _ in world.meter], world.meter
    assert "commit_user_upload" not in [name for name, _ in world.meter], world.meter


def test_an_unreachable_meter_stores_its_code_not_a_value_error(world):
    """`reserve_nonro_document` answers the bare STRING `metering_unavailable`
    when the RPC is unreachable. The pipeline did `dict(<that string>)`, and
    `documents.error` read "ValueError: dictionary update sequence element #0
    has length 1; 2 is required"."""
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"))
    world.plans(OWNER="multi").document(uploaded_by=OWNER)
    world.rpc_answers["reserve_user_nonro_upload"] = None   # the meter is down
    _first_metered_run(world, OWNER)
    stored = world.run()
    assert stored == STORED["metering_unavailable"], stored
    assert "ValueError" not in stored and "dictionary" not in stored
    _assert_names_no_plan(stored)
    assert "commit_user_upload" not in [name for name, _ in world.meter], world.meter


def test_only_the_three_neutral_codes_can_be_stored():
    assert _usage_gate.STORED_NONRO_CODES == (
        "non_ro_not_included", "nonro_quota_exhausted", "metering_unavailable")
    for code in _usage_gate.STORED_NONRO_CODES:
        assert _usage_gate.stored_nonro_refusal(code) == '{"error": "%s"}' % code
    for junk in ("", "solo", "You've used all 8 non-Romanian documents", '{"plan_key": "solo"}'):
        with pytest.raises(ValueError):
            _usage_gate.stored_nonro_refusal(junk)

    def decision(kind: str, refusal: Any) -> Any:
        return _usage_gate.NonRoReserveDecision(
            kind=kind, plan_key="multi", used=8, cap=8, extra_nonro_doc_eur=None,
            was_extra=False, refusal=refusal, message="…the Multi-Country plan this month.")

    code = _usage_gate.nonro_refusal_code
    assert code(decision("refused", {"error": "non_ro_not_included", "upgrade_to": "multi"})) == "non_ro_not_included"
    assert code(decision("refused", "metering_unavailable")) == "metering_unavailable"
    assert code(decision("blocked", None)) == "nonro_quota_exhausted"
    # Whatever a later refusal carries, a free string never reaches the row.
    assert code(decision("refused", "RO Solo")) == "non_ro_not_included"
    assert code(decision("blocked", {"error": "the Multi-Country plan"})) == "nonro_quota_exhausted"


# ── 5. The first, metered run is gated by its verified reserver (D2) ─────


def test_the_first_metered_run_is_gated_by_its_reserver_not_the_owner(world):
    """UNCHANGED by the ruling, and pinned so it stays: a run that holds a
    document slot reserves the non-RO meter under the verified reserver, on
    the reserver's own plan — that was never `uploaded_by`, and it is not
    the owner's either."""
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"),
                  _member(COLLEAGUE, "member", "2026-01-02T00:00:00+00:00"))
    # A Solo colleague's first upload into a Multi owner's workspace: refused.
    world.plans(OWNER="multi", COLLEAGUE="solo").document(uploaded_by=OWNER)
    _first_metered_run(world, COLLEAGUE)
    assert world.run() == STORED["non_ro_not_included"]
    assert world.plans_read() == [COLLEAGUE] and world.owner_lookups() == [], world.db.reads
    # A Multi colleague's first upload into a Solo owner's workspace: allowed,
    # reserved under the colleague.
    world.meter.clear()
    world.plans(OWNER="solo", COLLEAGUE="multi").document(uploaded_by=OWNER)
    world.rpc_answers["reserve_user_nonro_upload"] = {"kind": "allowed", "used": 2, "extra": False}
    _first_metered_run(world, COLLEAGUE)
    assert _passed(world.run())
    reserves = [p for name, p in world.meter if name == "reserve_user_nonro_upload"]
    assert [p["p_user_id"] for p in reserves] == [COLLEAGUE], world.meter
    assert world.plans_read() == [COLLEAGUE] and world.owner_lookups() == [], world.db.reads


# ── 6. The gate never reads the column ────────────────────────────────────


class _RowThatTraps(dict):
    """A document row on which reading `uploaded_by` is an error."""

    def _trap(self, key: Any) -> None:
        if key == "uploaded_by":
            raise AssertionError("the non-RO gate read documents.uploaded_by — a column the browser writes")

    def get(self, key: Any, default: Any = None) -> Any:
        self._trap(key)
        return super().get(key, default)

    def __getitem__(self, key: Any) -> Any:
        self._trap(key)
        return super().__getitem__(key)


def test_the_gate_never_reads_uploaded_by(world):
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"))
    world.plans(OWNER="multi")
    row = _RowThatTraps(_document(uploaded_by=STRANGER_MULTI))
    pipeline._enforce_nonro_plan_gate(row)                       # the re-run branch
    world.rpc_answers["reserve_user_nonro_upload"] = {"kind": "allowed", "used": 0, "extra": False}
    world.db.tables["documents"] = [dict(row)]
    _first_metered_run(world, OWNER)
    pipeline._enforce_nonro_plan_gate(row)                       # the reserving branch
    world.plans(OWNER="solo")
    pipeline._QUOTA_RUNS.clear()
    with pytest.raises(_usage_gate.NonRoNotIncludedError):
        pipeline._enforce_nonro_plan_gate(row)


def test_the_gate_is_inert_with_enforcement_off(world, monkeypatch):
    """USAGE_LIMITS_ENABLED off: no owner lookup, no plan read, the run goes
    through — for a workspace that would be refused with it on."""
    monkeypatch.delenv("USAGE_LIMITS_ENABLED", raising=False)
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"))
    world.plans(OWNER="solo").document(uploaded_by=None)
    assert _passed(world.run())
    assert world.owner_lookups() == [] and world.plans_read() == [], world.db.reads


# ── 7. The caller must be a member (the re-run route's own wall) ─────────


def _retry(user: str) -> Any:
    app = FastAPI()
    app.include_router(pipeline.build_router())
    return TestClient(app).post("/api/pipeline/retry", json={"document_id": DOC},
                                headers={"Authorization": "Bearer jwt:%s" % user})


def _counted(world: World, user: str) -> None:
    """The plan already counted this book (the quota ledger's row): a
    re-run of it is unmetered — it reserves nothing and holds no slot."""
    world.db.rows("document_quota_ledger").append({
        "document_id": DOC, "user_id": user, "month": "2026-09", "was_extra": False,
        "committed_at": "2026-09-20T10:00:00+00:00", "reserved_at": None, "released_at": None,
        "reservation_id": None, "settling_at": None, "updated_at": "2026-09-20T10:00:00+00:00"})


def test_a_rerun_is_refused_to_a_caller_who_is_not_a_member(world):
    """A Multi user who can name the document but holds no membership in its
    workspace: 403 at the route, nothing queued, the row untouched. (This
    double applies no row-level security, so the membership read IS the
    wall under test — `_org.require_org_member`.)"""
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"))
    world.plans(OWNER="multi").document(uploaded_by=STRANGER_MULTI, status="analyzed", period_id=PERIOD)
    _counted(world, OWNER)
    before = dict(world.db.rows("documents")[0])
    r = _retry(STRANGER_MULTI)
    assert r.status_code == 403, r.text
    assert world.enqueued == [] and world.db.rows("documents")[0] == before


@pytest.mark.parametrize("owner_tier,caller_tier,entitled", [("multi", "solo", True), ("solo", "multi", False)])
def test_a_members_rerun_is_gated_by_the_workspace_not_by_the_caller(world, owner_tier, caller_tier, entitled):
    """A colleague (a member, not the owner) retries a counted non-RO book
    through the REAL route, then the run. Their own plan decides nothing: a
    Solo colleague re-runs in a Multi owner's workspace, a Multi colleague
    is refused in a Solo owner's."""
    world.members(_member(OWNER, "owner", "2026-01-01T00:00:00+00:00"),
                  _member(COLLEAGUE, "member", "2026-01-02T00:00:00+00:00"))
    world.plans(OWNER=owner_tier, COLLEAGUE=caller_tier)
    world.document(uploaded_by=COLLEAGUE, status="analyzed", period_id=PERIOD)
    _counted(world, OWNER)
    r = _retry(COLLEAGUE)
    assert r.status_code == 202 and r.json()["status"] == "queued", r.text
    assert world.enqueued == [DOC]
    # The document owns its period: the re-run is STAGED. A refusal by the
    # workspace's plan leaves it analysed over its month, the neutral code
    # on its row — never `failed`, and never the month reset first.
    stored = world.run(staged_rerun=True)
    assert _passed(stored) is entitled, stored
    if not entitled:
        assert stored == STORED["non_ro_not_included"], stored
    assert [p["id"] for p in world.db.rows("financial_periods")] == [PERIOD], world.db.rows("financial_periods")
    assert world.db.rows("documents")[0]["period_id"] == PERIOD
    assert world.plans_read() == [OWNER], world.db.reads
    assert world.meter == [], "a re-run of a counted book touched the meter: %r" % world.meter
