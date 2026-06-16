"""AIOrchestrator — the single entry point for every LLM call.

execute(req) does:
  1. Cache check          → return cached if fresh
  2. Budget pre-check     → reject if over plan / global cap
  3. Route                → pick primary + (optional) verifier
  4. Primary call         → always runs
  5. Verifier call        → only if router said so AND verifier available
  6. Verify               → compare outputs per task's verification schema
  7. Reconcile            → primary, primary-with-conflicts, or arbitrated
  8. Cache the result
  9. Telemetry            → log everything for the feedback loop
 10. Record actual cost   → update budget counter for next call

Important: this orchestrator NEVER hides errors. If the primary fails
and the router has no fallback, the error propagates. If verification
finds a conflict and arbitration also fails, ArbitrationFailedError
propagates. The application layer (FastAPI route) translates errors
to HTTP / i18n.

Verification schemas live alongside prompts: see prompts/<task>.py
for the per-task VerificationSchema definition. The orchestrator
looks them up by task_type.
"""

from __future__ import annotations

import logging
from typing import Dict, Optional

from .budget import BudgetGuard
from .cache import AICache
from .errors import OrchestratorError, ProviderUnavailableError
from .reconciler import reconcile
from .router import Router, RoutingDecision
from .telemetry import AITelemetry
from .types import (
    AIRequest,
    AIResponse,
    ExecutionResult,
    Provenance,
    TaskType,
    VerificationSchema,
)
from .verifier import verify

logger = logging.getLogger(__name__)


class AIOrchestrator:
    def __init__(
        self,
        *,
        router: Router,
        cache: Optional[AICache] = None,
        telemetry: Optional[AITelemetry] = None,
        budget: Optional[BudgetGuard] = None,
        verification_schemas: Optional[Dict[TaskType, VerificationSchema]] = None,
    ):
        self._router = router
        self._cache = cache or AICache()
        self._telemetry = telemetry or AITelemetry()
        self._budget = budget or BudgetGuard()
        # Per-task verification schemas — populated from prompts/<task>.py.
        # If a task has no schema and the router asks for verification,
        # we fall back to structured-compare with default tolerance.
        self._verification_schemas = verification_schemas or {}

    # ── Public ────────────────────────────────────────────────────────

    def execute(self, req: AIRequest) -> ExecutionResult:
        # 1. Cache check
        cached = self._cache.get(req)
        if cached is not None:
            self._telemetry.record_cache_hit(req)
            return cached

        # 2. Route (also handles primary unavailability → fallback or raise)
        decision = self._router.decide(req)

        # 3. Budget pre-check (estimate worst-case cost based on routing)
        self._budget_precheck(req, decision)

        # 4. Primary call
        primary = self._call_with_actual_cost_record(req, decision.primary)

        # 5. Verifier? — only if router configured one AND it's available
        if decision.verifier is None or not decision.verifier.available:
            result = ExecutionResult(
                response=primary,
                provenance=Provenance(
                    sources=[primary.model],
                    agreed=True,
                    notes="Single-model path (no verifier configured)",
                ),
            )
            self._cache.set(req, result)
            self._telemetry.record(
                req,
                router_primary=decision.primary.name,
                router_verifier=None,
                router_rationale=decision.rationale,
                primary=primary,
            )
            return result

        # 6. Verifier call
        try:
            verifier_resp = self._call_with_actual_cost_record(req, decision.verifier)
        except OrchestratorError as e:
            # Verifier failed — degrade to primary-only. Better partial
            # answer than total failure.
            logger.warning(
                "[orchestrator] verifier %s failed (%s); using primary-only",
                decision.verifier.name, e.code,
            )
            result = ExecutionResult(
                response=primary,
                provenance=Provenance(
                    sources=[primary.model],
                    agreed=True,
                    notes=f"Verifier {decision.verifier.name} failed; degraded to single-model",
                ),
            )
            self._cache.set(req, result)
            self._telemetry.record(
                req,
                router_primary=decision.primary.name,
                router_verifier=decision.verifier.name,
                router_rationale=decision.rationale + " [verifier failed]",
                primary=primary,
            )
            return result

        # 7. Verify
        schema = self._verification_schemas.get(req.task_type) or _default_schema()
        verification = verify(primary, verifier_resp, schema)

        # 8. Reconcile (may invoke arbiter)
        try:
            result = reconcile(req, primary, verifier_resp, verification, self._router)
        except OrchestratorError:
            # Arbitration failed — surface to caller; FE handles via
            # ExtraDocConfirmDialog-style "models disagreed, please review"
            # UI in v2.
            raise

        # Record arbiter cost if used
        if result.provenance.arbitrated:
            self._budget.record_actual_cost(
                user_id=req.metadata.get("user_id"),
                actual_cost_usd=result.response.usage.estimated_cost_usd,
            )

        # 9. Cache the final answer
        self._cache.set(req, result)

        # 10. Telemetry
        self._telemetry.record(
            req,
            router_primary=decision.primary.name,
            router_verifier=decision.verifier.name,
            router_rationale=decision.rationale,
            primary=primary,
            verifier=verifier_resp,
            arbiter=result.response if result.provenance.arbitrated else None,
            verification=verification,
        )

        return result

    # ── Diagnostics / observability ───────────────────────────────────

    def cache_stats(self) -> Dict[str, int]:
        return self._cache.stats()

    def budget_remaining(self, *, user_id: str, plan_key: Optional[str]) -> float:
        return self._budget.remaining_for_user(user_id=user_id, plan_key=plan_key)

    # ── Internal ──────────────────────────────────────────────────────

    def _budget_precheck(self, req: AIRequest, decision: RoutingDecision) -> None:
        """Estimate worst-case cost (primary + verifier + potential
        arbitration) and reject early if it would exceed the cap.

        The arbitration estimate is generous — most calls don't need
        it — but it's better to reject upfront than partway through.
        """
        est_cost = decision.primary.estimate_cost(req)
        if decision.verifier is not None:
            est_cost += decision.verifier.estimate_cost(req)
            # Arbitration costs ~same as primary (same prompt + schema).
            est_cost += decision.primary.estimate_cost(req)
        self._budget.assert_within_budget(
            user_id=req.metadata.get("user_id"),
            plan_key=req.metadata.get("plan_key"),
            estimated_cost_usd=est_cost,
        )

    def _call_with_actual_cost_record(self, req: AIRequest, adapter) -> AIResponse:
        """Call the adapter and record the ACTUAL cost (not the estimate)
        against the budget counter so the meter stays honest."""
        if not adapter.available:
            raise ProviderUnavailableError(
                f"Adapter {adapter.name} not available",
                details={"task_type": req.task_type.value},
            )
        resp = adapter.call(req)
        self._budget.record_actual_cost(
            user_id=req.metadata.get("user_id"),
            actual_cost_usd=resp.usage.estimated_cost_usd,
        )
        return resp


def _default_schema() -> VerificationSchema:
    """Used when a task has a verifier in the routing config but no
    explicit VerificationSchema. Structured compare with default
    tolerance is the safest universal default."""
    return VerificationSchema(kind="structured", tolerance=0.001)
