"""ai_orchestrator — multi-model intelligence layer for the CFO AI engine.

Single entry point: `AIOrchestrator.execute(req)`. The orchestrator
routes each task to the best-fit model, cross-checks high-stakes
outputs with an independent verifier, and arbitrates disagreements
with a third pass.

USAGE
─────
    from src.engine.api.ai_orchestrator import build_default_orchestrator
    from src.engine.api.ai_orchestrator.types import AIRequest, TaskType
    from src.engine.api.ai_orchestrator.prompts.extract_trial_balance import (
        SYSTEM_PROMPT, OUTPUT_SCHEMA,
    )

    orch = build_default_orchestrator()
    result = orch.execute(AIRequest(
        task_id="ext-001",
        task_type=TaskType.EXTRACT_TRIAL_BALANCE,
        system_prompt=SYSTEM_PROMPT,
        user_message=document_text,
        output_schema=OUTPUT_SCHEMA,
        metadata={"user_id": "abc-123", "plan_key": "pro", "document_id": "doc-456"},
    ))
    # result.response.content → validated dict per OUTPUT_SCHEMA
    # result.provenance       → which models contributed + agreement notes

OVERRIDE FOR TESTS
──────────────────
Pass custom adapter / cache / telemetry / budget to `AIOrchestrator()`
directly. Tests in `tests/ai_orchestrator/` use fakes for both adapters
to avoid real API calls.

CONFIG
──────
  ANTHROPIC_API_KEY        — required for Claude adapter
  OPENAI_API_KEY           — required for GPT verifier path (degrades
                             gracefully to Claude-only if missing)
  AI_TELEMETRY_PATH        — JSONL log file (default /var/log/cfo-ai/orchestrator.jsonl)
  AI_BUDGET_DAILY_CAP_USD  — global circuit breaker (default $200)
"""

from __future__ import annotations

from .adapters import ClaudeAdapter, GPTAdapter
from .budget import BudgetGuard
from .cache import AICache
from .errors import (
    ArbitrationFailedError,
    BudgetExceededError,
    OrchestratorError,
    ProviderTransientError,
    ProviderUnavailableError,
    SchemaValidationError,
    TaskUnroutableError,
)
from .orchestrator import AIOrchestrator
from .prompts.extract_trial_balance import VERIFICATION_SCHEMA as _EXT_TB_VS
from .router import Router
from .telemetry import AITelemetry
from .types import (
    AIRequest,
    AIResponse,
    ExecutionResult,
    Provenance,
    TaskType,
    VerificationResult,
    VerificationSchema,
)


def build_default_orchestrator() -> AIOrchestrator:
    """Convenience factory: assemble the default orchestrator from
    environment-driven adapters + standard cache/telemetry/budget.

    For tests, build the orchestrator manually with fake adapters."""
    claude = ClaudeAdapter()
    gpt = GPTAdapter()
    router = Router(claude=claude, gpt=gpt)
    return AIOrchestrator(
        router=router,
        cache=AICache(),
        telemetry=AITelemetry(),
        budget=BudgetGuard(),
        verification_schemas={
            TaskType.EXTRACT_TRIAL_BALANCE: _EXT_TB_VS,
        },
    )


__all__ = [
    # Public API
    "AIOrchestrator",
    "build_default_orchestrator",
    "Router",
    "AICache",
    "AITelemetry",
    "BudgetGuard",
    # Adapters (for custom wiring)
    "ClaudeAdapter",
    "GPTAdapter",
    # Types
    "AIRequest",
    "AIResponse",
    "ExecutionResult",
    "Provenance",
    "TaskType",
    "VerificationResult",
    "VerificationSchema",
    # Errors
    "OrchestratorError",
    "BudgetExceededError",
    "ProviderUnavailableError",
    "ProviderTransientError",
    "SchemaValidationError",
    "ArbitrationFailedError",
    "TaskUnroutableError",
]
