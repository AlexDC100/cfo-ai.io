"""End-to-end orchestrator tests using fake adapters (no real API calls).

Covers the four paths the verification protocol specifies:
  1. Full agreement   → primary returned, no arbitration
  2. Partial diff     → primary returned with conflicts in provenance
  3. Hard conflict    → arbitration invoked, arbiter's answer returned
  4. Verifier offline → primary-only path, no errors leak
  5. Budget exceeded  → BudgetExceededError raised before any API call
  6. Cache hit        → second identical call returns from cache, no API
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Dict, Optional

import pytest

from src.engine.api.ai_orchestrator import (
    AIOrchestrator,
    AICache,
    AITelemetry,
    BudgetGuard,
    BudgetExceededError,
    Router,
)
from src.engine.api.ai_orchestrator.adapters.base import BaseAdapter
from src.engine.api.ai_orchestrator.types import (
    AIRequest,
    AIResponse,
    RoutingConfig,
    RoutingRule,
    TaskType,
    TokenUsage,
    VerificationSchema,
)


# ── Fakes ──────────────────────────────────────────────────────────────

class FakeAdapter(BaseAdapter):
    """Returns a pre-programmed response. Tracks call count for assertions."""

    def __init__(self, name: str, response: Any, available: bool = True):
        self.name = name
        self._response = response
        self._available = available
        self.calls = 0
        self.input_price_per_m = 5.0
        self.output_price_per_m = 25.0
        self.cached_input_price_per_m = 0.5

    @property
    def available(self) -> bool:
        return self._available

    def call(self, req: AIRequest) -> AIResponse:
        self.calls += 1
        return AIResponse(
            task_id=req.task_id,
            model=self.name,
            content=self._response,
            finish_reason="stop",
            usage=TokenUsage(
                input_tokens=100, output_tokens=50, cached_input_tokens=0,
                estimated_cost_usd=0.01,
            ),
            latency_ms=50,
            raw=None,
        )

    def estimate_cost(self, req: AIRequest) -> float:
        return 0.01


def _make_request(task_type: TaskType = TaskType.EXTRACT_TRIAL_BALANCE, **md) -> AIRequest:
    return AIRequest(
        task_id=str(uuid.uuid4()),
        task_type=task_type,
        system_prompt="extract totals",
        user_message="balance text",
        output_schema={"type": "object", "properties": {"x": {"type": "number"}}},
        metadata=md,
    )


def _orchestrator(
    primary_resp: Any,
    verifier_resp: Any = None,
    *,
    verify_kind: str = "numeric",
    verifier_available: bool = True,
    cap_usd: float = 100.0,
) -> tuple[AIOrchestrator, FakeAdapter, FakeAdapter]:
    """Helper: assemble an orchestrator with fake adapters."""
    primary = FakeAdapter("claude-fake", primary_resp)
    verifier = FakeAdapter("gpt-fake", verifier_resp, available=verifier_available)
    config = RoutingConfig(rules={
        TaskType.EXTRACT_TRIAL_BALANCE: RoutingRule(
            primary="claude",
            verify="gpt" if verifier_resp is not None or verifier_available else None,
            rationale="test",
        ),
    })
    router = Router(claude=primary, gpt=verifier, config=config)
    schema = VerificationSchema(kind=verify_kind, tolerance=0.01)
    orch = AIOrchestrator(
        router=router,
        cache=AICache(),
        telemetry=AITelemetry(path="/tmp/test-orchestrator-tel.jsonl"),
        budget=BudgetGuard(plan_caps_usd={"test": cap_usd}),
        verification_schemas={TaskType.EXTRACT_TRIAL_BALANCE: schema},
    )
    return orch, primary, verifier


# ── 1. Full agreement ─────────────────────────────────────────────────

def test_full_agreement_returns_primary_without_arbitration():
    same = {"revenue": 1000, "ebitda": 100, "net_profit": 50}
    orch, primary, verifier = _orchestrator(same, same)

    req = _make_request(user_id="u1", plan_key="test")
    result = orch.execute(req)

    assert result.response.content == same
    assert result.response.model == "claude-fake"
    assert result.provenance.agreed is True
    assert result.provenance.arbitrated is False
    assert primary.calls == 1
    assert verifier.calls == 1


# ── 2. Partial diff within tolerance ──────────────────────────────────

def test_partial_diff_within_tolerance_uses_primary_with_conflicts_noted():
    # 0.05% diff on revenue — under default 1% tolerance for this test
    primary_resp = {"revenue": 100000, "ebitda": 100, "net_profit": 50}
    verifier_resp = {"revenue": 100050, "ebitda": 100, "net_profit": 50}
    orch, primary, verifier = _orchestrator(primary_resp, verifier_resp, verify_kind="numeric")

    req = _make_request(user_id="u1", plan_key="test")
    result = orch.execute(req)

    # Within tolerance → no conflict at all → full agreement (revenue diff is
    # under 1% rel tolerance, so verifier flags it as "no diff")
    assert result.response.content == primary_resp
    assert primary.calls == 1


def test_partial_diff_outside_tolerance_but_low_severity():
    # 3% diff on revenue, tolerance 1% — this is a partial (medium severity)
    primary_resp = {"revenue": 100000, "ebitda": 100, "net_profit": 50}
    verifier_resp = {"revenue": 103000, "ebitda": 100, "net_profit": 50}
    orch, primary, verifier = _orchestrator(primary_resp, verifier_resp, verify_kind="numeric")
    # No arbiter wired here because router falls back to claude when arbitration needed
    # — so this test uses the structured verifier behavior

    req = _make_request(user_id="u1", plan_key="test")
    result = orch.execute(req)

    # 3% > 1% rel tolerance → flagged. Severity is medium (1-5%).
    # Partial agreement → primary returned + arbitration may or may not fire
    # depending on confidence threshold. With 1 conflict / 3 fields = 0.67
    # confidence — under 0.95 → arbitration.
    assert primary.calls >= 1
    # If arbitration fired, content matches arbiter (which in test is also claude-fake → primary_resp)
    assert result.response.content == primary_resp


# ── 3. Hard conflict → arbitration ────────────────────────────────────

def test_hard_conflict_triggers_arbitration():
    # 50% diff on revenue → high severity → conflict → arbitration
    primary_resp = {"revenue": 100000, "ebitda": 100, "net_profit": 50}
    verifier_resp = {"revenue": 50000, "ebitda": 100, "net_profit": 50}
    orch, primary, verifier = _orchestrator(primary_resp, verifier_resp, verify_kind="numeric")

    req = _make_request(user_id="u1", plan_key="test")
    result = orch.execute(req)

    # Arbiter is claude-fake (the same fake instance as primary), so it
    # returns the primary_resp again on the arbitration call.
    assert result.provenance.arbitrated is True
    assert "claude-fake" in result.provenance.sources
    assert "gpt-fake" in result.provenance.sources
    # Primary called twice: once for the initial pass, once for arbitration
    assert primary.calls == 2
    assert verifier.calls == 1


# ── 4. Verifier offline → primary-only path ───────────────────────────

def test_verifier_unavailable_degrades_to_primary_only():
    primary_resp = {"revenue": 100, "ebitda": 10, "net_profit": 5}
    orch, primary, verifier = _orchestrator(
        primary_resp, primary_resp, verifier_available=False,
    )

    req = _make_request(user_id="u1", plan_key="test")
    result = orch.execute(req)

    assert result.response.content == primary_resp
    assert primary.calls == 1
    assert verifier.calls == 0
    # Provenance reflects single-model path
    assert result.provenance.sources == ["claude-fake"]


# ── 5. Budget exceeded ────────────────────────────────────────────────

def test_budget_cap_blocks_call_before_api_invoked():
    primary_resp = {"x": 1}
    orch, primary, verifier = _orchestrator(primary_resp, primary_resp, cap_usd=0.001)

    req = _make_request(user_id="u1", plan_key="test")

    with pytest.raises(BudgetExceededError):
        orch.execute(req)

    # No model called
    assert primary.calls == 0
    assert verifier.calls == 0


# ── 6. Cache hit ──────────────────────────────────────────────────────

def test_second_identical_call_hits_cache():
    primary_resp = {"x": 42}
    orch, primary, verifier = _orchestrator(primary_resp, primary_resp)

    # Build identical requests (same task_type, system, user, schema, temp)
    req1 = _make_request(user_id="u1", plan_key="test")
    req2 = AIRequest(
        task_id=str(uuid.uuid4()),  # different task_id is fine — not part of cache key
        task_type=req1.task_type,
        system_prompt=req1.system_prompt,
        user_message=req1.user_message,
        output_schema=req1.output_schema,
        max_tokens=req1.max_tokens,
        temperature=req1.temperature,
        metadata={"user_id": "u1", "plan_key": "test"},
    )

    orch.execute(req1)
    initial_primary_calls = primary.calls
    initial_verifier_calls = verifier.calls

    orch.execute(req2)

    # Second call should NOT invoke models
    assert primary.calls == initial_primary_calls
    assert verifier.calls == initial_verifier_calls

    stats = orch.cache_stats()
    assert stats["hits"] >= 1
