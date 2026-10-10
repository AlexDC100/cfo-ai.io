"""New pricing tiers (2026-08) — spec-table invariants, legacy maps,
non-RO gating, workspace caps, plan-state payload.

THE TIER SPEC (single source of truth — mirrored from the build brief):

| key   | display        | EUR/mo | docs incl | extra doc | non-RO docs          | chat d/m | ws |
|-------|----------------|--------|-----------|-----------|----------------------|----------|----|
| trial | Free Trial     | 0      | 1 total   | none      | no                   | 3 / 5    | 1  |
| intro | Intro (7 days) | 0.99*  | +1        | none      | no                   | 5 / 10   | 1  |
| solo  | RO Solo        | 4.99   | 3 /mo     | 1.49      | no                   | 10 / 50  | 1  |
| pro   | Pro            | 9.99   | 15 /mo    | 0.99      | no                   | 25 / 150 | 5  |
| multi | Multi-Country  | 16.99  | 15 /mo    | 0.99      | 8 /mo incl, 1.49 ex. | 40 / 200 | 5  |
(* one-time)

Also locked here:
· "starter" (14.99) is RETIRED from purchase (purchasable=False) but kept
  as a plan def for legacy state rendering; legacy_tier_map starter->pro.
· legacy 39.99-era "pro" Stripe subs resolve (via price id, see
  test_billing_stripe.py) to the synthetic key "pro_legacy" which maps to
  the MULTI entitlement set — grandfathered UP, never downgraded.
· Non-RO uploads are ONLY allowed on multi; solo/pro get the typed
  refusal {"error": "non_ro_not_included", "upgrade_to": "multi"}.
· COGS anchor re-measured 2026-08-25 (RO doc $0.02, non-RO worst $0.97):
  default cogs_estimate_per_doc_eur = 0.90 so the 0.99 extra price does
  NOT trip the below-COGS import guard, while a planted 0.01 still does.
"""

from __future__ import annotations

import copy
import json
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest

from engine.api import _plan_state, _pricing_config, _usage_gate


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _pristine_config(monkeypatch):
    """Every test starts from the default (env-free) pricing config and
    leaves the module singleton restored afterwards."""
    for var in list(__import__("os").environ):
        if var.startswith("PRICING_"):
            monkeypatch.delenv(var, raising=False)
    monkeypatch.delenv("USAGE_LIMITS_ENABLED", raising=False)
    _pricing_config.reload_for_test()
    yield
    _pricing_config.reload_for_test()


def _plan(key: str) -> _pricing_config.PlanConfig:
    return _pricing_config.CONFIG.plans[key]  # type: ignore[index]


def _mk_state(plan_key: str, **over: Any) -> _plan_state.PlanState:
    plan = _pricing_config.plan_for(plan_key)
    assert plan is not None
    kw: Dict[str, Any] = dict(
        user_id="u-tiers", plan_key=plan.key, plan=plan,
        window_expires_at=None, docs_used_this_period=0,
        extra_docs_billed_this_period=0, chat_used_today=0,
        chat_used_this_period=0, today_iso="2026-08-27",
        period_month_bucket="2026-08",
    )
    kw.update(over)
    return _plan_state.PlanState(**kw)


# ══════════════════════════════════════════════════════════════════════
# [1] Spec table — exact values
# ══════════════════════════════════════════════════════════════════════


def test_spec_table_trial():
    p = _plan("trial")
    assert p.price_eur == 0.0
    assert p.recurring is False
    assert p.included_docs == 1
    assert p.extra_doc_eur is None
    assert (p.chat.daily, p.chat.monthly) == (3, 5)
    assert p.max_workspaces == 1
    assert p.allows_non_ro is False
    assert p.included_nonro_docs == 0
    assert p.extra_nonro_doc_eur is None


def test_spec_table_intro():
    p = _plan("intro")
    assert p.price_eur == 0.99
    assert p.recurring is False       # one-time, never a subscription
    assert p.window_days == 7
    assert p.included_docs == 1
    assert p.extra_doc_eur is None
    assert (p.chat.daily, p.chat.monthly) == (5, 10)
    assert p.max_workspaces == 1
    assert p.allows_non_ro is False


def test_spec_table_solo():
    p = _plan("solo")
    assert p.display_name == "RO Solo"
    assert p.price_eur == 4.99
    assert p.recurring is True
    assert p.included_docs == 3
    assert p.extra_doc_eur == 1.49
    assert (p.chat.daily, p.chat.monthly) == (10, 50)
    assert p.max_workspaces == 1
    assert p.allows_non_ro is False
    assert p.purchasable is True


def test_spec_table_pro():
    p = _plan("pro")
    # User directive: the second paid tier is named exactly "Pro".
    assert p.display_name == "Pro"
    assert p.price_eur == 9.99
    assert p.recurring is True
    assert p.included_docs == 15
    assert p.extra_doc_eur == 0.99
    assert (p.chat.daily, p.chat.monthly) == (25, 150)
    assert p.max_workspaces == 5
    assert p.allows_non_ro is False
    assert p.purchasable is True


def test_spec_table_multi():
    p = _plan("multi")
    assert p.display_name == "Multi-Country"
    assert p.price_eur == 16.99
    assert p.recurring is True
    assert p.included_docs == 15
    assert p.extra_doc_eur == 0.99
    assert (p.chat.daily, p.chat.monthly) == (40, 200)
    assert p.max_workspaces == 5
    assert p.allows_non_ro is True
    assert p.included_nonro_docs == 8
    assert p.extra_nonro_doc_eur == 1.49
    assert p.purchasable is True


def test_starter_retired_but_defined():
    """starter stays a plan DEF (legacy subscription rows render) but is
    flagged not-purchasable; every live tier stays purchasable."""
    p = _plan("starter")
    assert p.purchasable is False
    assert p.recurring is True        # existing subs keep billing
    for key in ("intro", "solo", "pro", "multi"):
        assert _plan(key).purchasable is True, key


# ══════════════════════════════════════════════════════════════════════
# [2] Legacy tier maps — never downgrade an active subscriber
# ══════════════════════════════════════════════════════════════════════


def test_legacy_map_starter_resolves_to_pro():
    assert _pricing_config.CONFIG.legacy_tier_map["starter"] == "pro"
    plan = _pricing_config.plan_for("starter_legacy_alias_does_not_exist")
    assert plan is None
    # The starter DEF stays in CONFIG.plans (state / pricing-page
    # rendering) but ENTITLEMENT resolution follows the legacy map:
    # a 14.99 starter subscriber gets the Pro allowance (15 docs > 5 —
    # grandfathered up, never down).
    assert _pricing_config.plan_for("starter").key == "pro"


def test_legacy_map_pro_legacy_resolves_to_multi_entitlements():
    """A 39.99-era pro subscription (webhook stamps tier='pro_legacy'
    from the STRIPE_PRICE_PRO_LEGACY price id) gets the multi
    entitlement set — grandfathered UP."""
    assert _pricing_config.CONFIG.legacy_tier_map["pro_legacy"] == "multi"
    plan = _pricing_config.plan_for("pro_legacy")
    assert plan is not None
    assert plan.key == "multi"
    assert plan.allows_non_ro is True
    assert (plan.chat.daily, plan.chat.monthly) == (40, 200)


def test_legacy_business_professional_map_to_multi():
    """business/professional were mapped to the OLD pro (40/200 chat).
    The old-pro entitlement set now lives at 'multi' — mapping them to
    the NEW pro (25/150) would be a silent downgrade."""
    m = _pricing_config.CONFIG.legacy_tier_map
    assert m["business"] == "multi"
    assert m["professional"] == "multi"


# ══════════════════════════════════════════════════════════════════════
# [3] Env overrides + below-COGS guard
# ══════════════════════════════════════════════════════════════════════


def test_env_overrides_still_work(monkeypatch):
    monkeypatch.setenv("PRICING_SOLO_MONTHLY_EUR", "5.49")
    monkeypatch.setenv("PRICING_SOLO_INCLUDED_DOCS", "4")
    monkeypatch.setenv("PRICING_CHAT_DAILY_CAP_PRO", "30")
    monkeypatch.setenv("PRICING_MULTI_INCLUDED_NONRO_DOCS", "10")
    monkeypatch.setenv("PRICING_MAX_WORKSPACES_PRO", "7")
    cfg = _pricing_config.reload_for_test()
    assert cfg.plans["solo"].price_eur == 5.49
    assert cfg.plans["solo"].included_docs == 4
    assert cfg.plans["pro"].chat.daily == 30
    assert cfg.plans["multi"].included_nonro_docs == 10
    assert cfg.plans["pro"].max_workspaces == 7


def test_cogs_default_updated_to_measured_2026_08_25():
    assert _pricing_config.CONFIG.cogs_estimate_per_doc_eur == 0.90


def test_below_cogs_guard_quiet_on_spec_prices():
    """Every spec extra price (1.49 / 0.99 / nonro 1.49) sits ABOVE the
    0.90 COGS anchor — the guard must be silent."""
    assert _pricing_config.below_cogs_warnings() == []


def test_below_cogs_guard_fires_on_planted_low_price(monkeypatch):
    monkeypatch.setenv("PRICING_PRO_EXTRA_DOC_EUR", "0.01")
    cfg = _pricing_config.reload_for_test()
    warnings = _pricing_config.below_cogs_warnings(cfg)
    assert any("0.01" in w for w in warnings)


def test_below_cogs_guard_covers_nonro_extra_price(monkeypatch):
    monkeypatch.setenv("PRICING_MULTI_EXTRA_NONRO_DOC_EUR", "0.05")
    cfg = _pricing_config.reload_for_test()
    warnings = _pricing_config.below_cogs_warnings(cfg)
    assert any("0.05" in w for w in warnings)


# ══════════════════════════════════════════════════════════════════════
# [4] Public dict shapes (pricing config + plan state)
# ══════════════════════════════════════════════════════════════════════


def test_to_public_dict_gains_new_fields_additively():
    pub = _pricing_config.to_public_dict()
    assert "cogs_estimate_per_doc_eur" not in json.dumps(pub)
    plans = {p["key"]: p for p in pub["plans"]}
    assert set(plans) == {"trial", "intro", "starter", "solo", "pro", "multi"}
    multi = plans["multi"]
    # Pre-existing fields survive…
    assert multi["price_eur"] == 16.99
    assert multi["chat_daily_cap"] == 40
    # …new fields ride along additively.
    assert multi["max_workspaces"] == 5
    assert multi["allows_non_ro"] is True
    assert multi["included_nonro_docs"] == 8
    assert multi["extra_nonro_doc_eur"] == 1.49
    assert multi["purchasable"] is True
    assert plans["starter"]["purchasable"] is False


def test_plan_state_public_dict_gains_workspace_and_nonro_fields():
    state = _mk_state("multi", nonro_used_this_period=3)
    pub = _plan_state.state_to_public_dict(state)
    assert pub["max_workspaces"] == 5
    assert pub["allows_non_ro"] is True
    assert pub["nonro_used"] == 3
    assert pub["nonro_included"] == 8


def test_max_workspaces_for_helper():
    f = _plan_state.max_workspaces_for
    assert f("trial") == 1
    assert f("intro") == 1
    assert f("solo") == 1
    assert f("pro") == 5
    assert f("multi") == 5
    assert f("starter") == 5      # legacy subscribers keep 5 (SQL mirror)
    assert f("pro_legacy") == 5
    assert f("") == 1             # no subscription row → trial default
    assert f("garbage-tier") == 1


# ══════════════════════════════════════════════════════════════════════
# [5] Non-RO gate — _usage_gate.reserve_nonro_document
# ══════════════════════════════════════════════════════════════════════


def test_nonro_reserve_disabled_when_flag_off():
    d = _usage_gate.reserve_nonro_document("u-x")
    assert d.kind == "disabled"


def test_nonro_reserve_refused_on_solo_and_pro(monkeypatch):
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "1")
    for plan_key in ("solo", "pro"):
        with patch.object(_usage_gate._plan_state, "get_plan_state",
                          return_value=_mk_state(plan_key)):
            with patch.object(_usage_gate, "_rpc",
                              side_effect=AssertionError("RPC must not run")):
                d = _usage_gate.reserve_nonro_document("u-x")
        assert d.kind == "refused", plan_key
        assert d.refusal == {"error": "non_ro_not_included",
                             "upgrade_to": "multi"}


def test_nonro_reserve_allowed_and_metered_on_multi(monkeypatch):
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "1")
    calls: List[Any] = []

    def fake_rpc(name: str, payload: Dict[str, Any]):
        calls.append((name, payload))
        return {"kind": "allowed", "used": 2, "reserved": 1, "extra": False}

    with patch.object(_usage_gate._plan_state, "get_plan_state",
                      return_value=_mk_state("multi")):
        with patch.object(_usage_gate, "_rpc", side_effect=fake_rpc):
            d = _usage_gate.reserve_nonro_document("u-x")
    assert d.kind == "allowed"
    assert d.was_extra is False
    name, payload = calls[0]
    assert name == "reserve_user_nonro_upload"
    assert payload["p_base_cap"] == 8
    assert payload["p_allow_extra"] is True


def test_nonro_reserve_overage_flags_was_extra(monkeypatch):
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "1")
    with patch.object(_usage_gate._plan_state, "get_plan_state",
                      return_value=_mk_state("multi")):
        with patch.object(_usage_gate, "_rpc",
                          return_value={"kind": "allowed", "used": 8,
                                        "reserved": 1, "extra": True}):
            d = _usage_gate.reserve_nonro_document("u-x")
    assert d.kind == "allowed"
    assert d.was_extra is True


def test_nonro_reserve_rpc_unavailable_refuses(monkeypatch):
    """REVERSED 2026-09-10, and the reversal is the point.

    This test used to be named `..._degrades_open` and asserted
    `d.kind == "allowed"` — it pinned the defect as the law. Its
    reasoning was "better to under-bill than to block a paying multi
    user", which is a real trade-off and was decided the wrong way:
    under-billing is not a bounded cost, it is an unbounded one that
    reports itself only in a log line at WARNING.

    MEASURED before the reversal, in production: USAGE_LIMITS_ENABLED=true,
    all three `*_user_nonro_upload` RPCs absent and all three meter columns
    absent, because schema_phase_plan_caps.sql was never applied — with a
    live Stripe key. (The "27 documents / 113 days" first reported here was
    a misread of `documents.detected_country`, a coa_registries stamp on
    Romanian books; see test_metering_fails_closed.py. The rule stands
    without it.)

    The meter now refuses, with a TYPED code the frontend can tell apart
    from a plan limit, and a message that does not blame the user for our
    missing migration. Blocking is loud, bounded, and fixed by one
    migration; the alternative was silent and open-ended.
    """
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "1")
    with patch.object(_usage_gate._plan_state, "get_plan_state",
                      return_value=_mk_state("multi")):
        with patch.object(_usage_gate, "_rpc", return_value=None):
            d = _usage_gate.reserve_nonro_document("u-x")
    assert d.kind == "refused", (
        "an unreachable meter allowed the document through — this is the "
        "degrade-open branch, reopened"
    )
    assert d.refusal == "metering_unavailable"
    assert d.was_extra is False
    # It must not read as a plan limit: the user's entitlement is fine.
    assert "upgrade" not in (d.message or "").lower()


def test_nonro_commit_and_release_call_rpcs(monkeypatch):
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "1")
    calls: List[Any] = []
    with patch.object(_usage_gate, "_rpc",
                      side_effect=lambda n, p: calls.append((n, p)) or {}):
        _usage_gate.commit_nonro_document("u-x", was_extra=True)
        _usage_gate.release_nonro_document("u-x", was_extra=False)
    assert calls[0][0] == "commit_user_nonro_upload"
    assert calls[0][1]["p_was_extra"] is True
    assert calls[1][0] == "release_user_nonro_upload"
    assert calls[1][1]["p_was_extra"] is False


def test_nonro_commit_release_inert_when_flag_off():
    with patch.object(_usage_gate, "_rpc",
                      side_effect=AssertionError("RPC must not run")):
        _usage_gate.commit_nonro_document("u-x", was_extra=True)
        _usage_gate.release_nonro_document("u-x", was_extra=True)


# ══════════════════════════════════════════════════════════════════════
# [6] Pipeline non-RO gate hook — inert off, typed refusal on
# ══════════════════════════════════════════════════════════════════════


class _FakeAdminCtx:
    def __init__(self) -> None:
        self.updates: List[Any] = []

    def __enter__(self):
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def update(self, table: str, patch_: Dict[str, Any], *, filters: Dict[str, str]) -> None:
        self.updates.append((table, copy.deepcopy(patch_), dict(filters)))


def test_pipeline_nonro_gate_is_noop_when_flag_off(monkeypatch):
    from engine.api import pipeline
    monkeypatch.delenv("USAGE_LIMITS_ENABLED", raising=False)
    with patch.object(_usage_gate, "reserve_nonro_document",
                      side_effect=AssertionError("gate must not consult plan")):
        # Must not raise, must not touch the reserve path.
        pipeline._enforce_nonro_plan_gate({"id": "doc-1",
                                           "uploaded_by": "u-1"})


def _first_metered_run(monkeypatch, doc_id, user_id="u-1"):
    """The run holds a document-slot reservation (a first analysis through
    /run): only such a run reserves the non-RO meter (verifier P-E)."""
    from engine.api import pipeline
    monkeypatch.setattr(pipeline, "_QUOTA_RUNS", {})
    pipeline._register_quota_run(doc_id, user_id=user_id, was_extra=False)


def test_pipeline_nonro_gate_raises_typed_refusal(monkeypatch):
    """REWRITTEN 2026-10-02 (owner ruling: never write plan names into the
    shared `documents.error` — store a neutral code). It used to assert
    `"multi" in str(exc.value)` and let the payload carry the reserver's
    `plan_key` and a sentence naming their plan. The stored text is now the
    code and nothing else, whatever the decision's own message says."""
    from engine.api import pipeline
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "1")
    _first_metered_run(monkeypatch, "doc-1")
    refusal = _usage_gate.NonRoReserveDecision(
        kind="refused", plan_key="solo", used=0, cap=0,
        extra_nonro_doc_eur=None, was_extra=False,
        refusal={"error": "non_ro_not_included", "upgrade_to": "multi"},
        message="Non-Romanian documents aren't included in the RO Solo plan.",
    )
    with patch.object(_usage_gate, "reserve_nonro_document",
                      return_value=refusal):
        with pytest.raises(_usage_gate.NonRoNotIncludedError) as exc:
            pipeline._enforce_nonro_plan_gate({"id": "doc-1",
                                               "uploaded_by": "u-1"})
    # The FE matches this typed marker inside documents.error — and it is
    # ALL the row carries: no plan key, no plan name, no message.
    assert json.loads(str(exc.value)) == {"error": "non_ro_not_included"}


def test_pipeline_nonro_gate_stores_the_cap_and_the_unreachable_meter_as_codes(monkeypatch):
    """The reserving branch's two other refusals, at the pipeline seam.
    `blocked` (the monthly non-RO cap) stored the reserver's plan key and
    "…included in the Multi-Country plan this month"; the unreachable meter
    returns the bare STRING `metering_unavailable`, `dict("metering_…")`
    raised, and `documents.error` carried that ValueError's text."""
    from engine.api import pipeline
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "1")
    blocked = _usage_gate.NonRoReserveDecision(
        kind="blocked", plan_key="multi", used=8, cap=8,
        extra_nonro_doc_eur=None, was_extra=False, refusal=None,
        message="You've used all 8 non-Romanian documents included in the "
                "Multi-Country plan this month.")
    _first_metered_run(monkeypatch, "doc-c")
    with patch.object(_usage_gate, "reserve_nonro_document", return_value=blocked):
        with pytest.raises(_usage_gate.NonRoNotIncludedError) as exc:
            pipeline._enforce_nonro_plan_gate({"id": "doc-c", "uploaded_by": "u-1"})
    assert json.loads(str(exc.value)) == {"error": "nonro_quota_exhausted"}
    # The unreachable meter, through the REAL unit (it returns the string).
    _first_metered_run(monkeypatch, "doc-m")
    with patch.object(_usage_gate._plan_state, "get_plan_state",
                      return_value=_mk_state("multi")):
        with patch.object(_usage_gate, "_rpc", return_value=None):
            with pytest.raises(_usage_gate.NonRoNotIncludedError) as exc:
                pipeline._enforce_nonro_plan_gate({"id": "doc-m", "uploaded_by": "u-1"})
    assert json.loads(str(exc.value)) == {"error": "metering_unavailable"}


def test_pipeline_nonro_gate_allowed_stamps_document(monkeypatch):
    from engine.api import pipeline
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "1")
    _first_metered_run(monkeypatch, "doc-9")
    allowed = _usage_gate.NonRoReserveDecision(
        kind="allowed", plan_key="multi", used=8, cap=8,
        extra_nonro_doc_eur=1.49, was_extra=True, refusal=None, message="",
    )
    ctx = _FakeAdminCtx()
    with patch.object(_usage_gate, "reserve_nonro_document",
                      return_value=allowed):
        with patch.object(pipeline._supabase, "admin", return_value=ctx):
            pipeline._enforce_nonro_plan_gate({"id": "doc-9",
                                               "uploaded_by": "u-1"})
    assert ctx.updates, "documents row must be stamped for the terminal commit"
    stamps = [(t, p, f) for t, p, f in ctx.updates if t == "documents"]
    assert len(stamps) == 1, ctx.updates
    table, patch_, filters = stamps[0]
    assert patch_["nonro_doc"] is True
    assert patch_["nonro_metered_extra"] is True
    assert filters == {"id": "eq.doc-9"}
    # ... and the reservation is in the quota ledger too, so a restart
    # before the terminal cannot orphan it (verifier lens S, S8).
    ledger = [(p, f) for t, p, f in ctx.updates if t == "document_quota_ledger"]
    assert ledger and ledger[0][0]["nonro_reserved_at"] and ledger[0][0]["nonro_was_extra"] is True
    assert ledger[0][1] == {"document_id": "eq.doc-9"}


class _MembershipsCtx:
    """The service-role client as the owner resolver reads it: `memberships`
    rows, filtered the way PostgREST filters `eq.` — and a record of every
    read, so a test can say which tables and ids were consulted."""

    def __init__(self, memberships: List[Dict[str, Any]]) -> None:
        self.memberships = memberships
        self.reads: List[Any] = []

    def __enter__(self):
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def select(self, table: str, *, filters: Optional[Dict[str, str]] = None,
               columns: str = "*", limit: Optional[int] = None,
               order: Optional[str] = None, single: bool = False) -> List[Dict[str, Any]]:
        self.reads.append((table, dict(filters or {}), order, limit))
        assert table == "memberships", table
        out = [dict(r) for r in self.memberships
               if all(cond.startswith("eq.") and str(r.get(col)) == cond[3:]
                      for col, cond in (filters or {}).items())]
        if order:
            col = order.split(".")[0]
            out.sort(key=lambda r: str(r.get(col) or ""))
        return out[:limit] if limit is not None else out


def test_pipeline_nonro_gate_a_rerun_reserves_nothing_but_is_still_gated(monkeypatch):
    """A run that holds no document slot (/retry, the ai-lane reextract, a
    period-move re-run) re-analyses a document already counted: the plan
    still refuses non-RO where it is not included, but nothing is
    reserved, registered or stamped (verifier P-E).

    REWRITTEN 2026-10-02 (owner ruling: the WORKSPACE's plan gates a
    re-run, never whoever `uploaded_by` names). This test used to call the
    gate with `{"id", "uploaded_by": "u-1"}` and answer the plan of whatever
    id was asked — it pinned the read of a browser-written column as the
    law. The plan consulted is now the OWNER's of the document's own
    `org_id`; `uploaded_by` names somebody else here and is never read."""
    from engine.api import pipeline
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "1")
    monkeypatch.setattr(pipeline, "_QUOTA_RUNS", {})
    solo = _pricing_config.CONFIG.plans["solo"]
    multi = _pricing_config.CONFIG.plans["multi"]
    asked: List[str] = []

    def state(plan):
        def _state(uid):
            asked.append(uid)
            return _plan_state.PlanState(
                user_id=uid, plan_key=plan.key, plan=plan, window_expires_at=None,
                docs_used_this_period=0, extra_docs_billed_this_period=0, chat_used_today=0,
                chat_used_this_period=0, today_iso="2026-09-21", period_month_bucket="2026-09")
        return _state

    ctx = _MembershipsCtx([
        {"user_id": "u-owner", "org_id": "org-1", "role": "owner",
         "created_at": "2026-01-01T00:00:00+00:00"},
        {"user_id": "u-colleague", "org_id": "org-1", "role": "member",
         "created_at": "2026-01-02T00:00:00+00:00"},
    ])
    doc = {"id": "doc-r", "org_id": "org-1", "uploaded_by": "u-colleague"}
    with patch.object(pipeline._supabase, "admin", return_value=ctx):
        with patch.object(_usage_gate, "reserve_nonro_document",
                          side_effect=AssertionError("a re-run reserved the non-RO meter")):
            with patch.object(_usage_gate._plan_state, "get_plan_state", side_effect=state(solo)):
                with pytest.raises(_usage_gate.NonRoNotIncludedError) as exc:
                    pipeline._enforce_nonro_plan_gate(dict(doc))
                assert json.loads(str(exc.value)) == {"error": "non_ro_not_included"}
            with patch.object(_usage_gate._plan_state, "get_plan_state", side_effect=state(multi)):
                pipeline._enforce_nonro_plan_gate(dict(doc))
    assert pipeline._QUOTA_RUNS == {}
    # The workspace's owner, both times — never the id `uploaded_by` names.
    assert asked == ["u-owner", "u-owner"], asked
    assert [r[1] for r in ctx.reads] == [{"org_id": "eq.org-1", "role": "eq.owner"}] * 2, ctx.reads


def test_pipeline_nonro_gate_no_workspace_is_refused(monkeypatch):
    """REVERSED 2026-10-02 — it was `..._no_user_is_noop` and asserted that a
    holder-less run of a document with no `uploaded_by` PASSES the gate
    with enforcement on: a non-Romanian re-run with no plan check at all
    (the column goes NULL when the uploader's account is deleted, and any
    member can PATCH it to NULL). It pinned the bypass as the law.

    A run for which no workspace can be named is REFUSED, with the neutral
    code, before any plan is read: nobody's plan can stand in for it."""
    from engine.api import pipeline
    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "1")
    monkeypatch.setattr(pipeline, "_QUOTA_RUNS", {})
    ctx = _MembershipsCtx([])
    with patch.object(pipeline._supabase, "admin", return_value=ctx):
        with patch.object(_usage_gate, "reserve_nonro_document",
                          side_effect=AssertionError("must not run")):
            with patch.object(_usage_gate._plan_state, "get_plan_state",
                              side_effect=AssertionError("no plan stands in for no workspace")):
                for doc in ({"id": "doc-1"},
                            {"id": "doc-1", "uploaded_by": "u-multi"},
                            {"id": "doc-1", "org_id": "", "uploaded_by": "u-multi"},
                            # A workspace nobody owns: the memberships read
                            # answers no owner row.
                            {"id": "doc-1", "org_id": "org-nobody", "uploaded_by": "u-multi"}):
                    with pytest.raises(_usage_gate.NonRoNotIncludedError) as exc:
                        pipeline._enforce_nonro_plan_gate(doc)
                    assert json.loads(str(exc.value)) == {"error": "non_ro_not_included"}, doc
    # No workspace named → not even a memberships read (an unfiltered one
    # would answer every workspace's owner); the one read is org-nobody's.
    assert [r[1] for r in ctx.reads] == [{"org_id": "eq.org-nobody", "role": "eq.owner"}], ctx.reads
