"""Typed errors for the AI orchestration layer.

Each error has a stable code + an i18n key so the FE can localize the
message. Never embed user-facing copy here — the FE catalog owns wording.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class OrchestratorError(Exception):
    """Base class. Every orchestrator-raised error inherits from this
    so the API layer can catch a single type."""
    code: str = "orchestrator.unknown"
    i18n_key: str = "errors.aiOrchestrator.unknown"
    # HTTP status the FastAPI route should return when this bubbles up.
    http_status: int = 500

    def __init__(
        self,
        message: str,
        *,
        details: Optional[Dict[str, Any]] = None,
        cause: Optional[BaseException] = None,
    ):
        super().__init__(message)
        self.message = message
        self.details = details or {}
        self.cause = cause

    def to_dict(self) -> Dict[str, Any]:
        """Serialize for API responses. Cause is NOT serialized
        (might leak provider trace IDs)."""
        return {
            "code": self.code,
            "i18n_key": self.i18n_key,
            "message": self.message,
            "details": self.details,
        }


class BudgetExceededError(OrchestratorError):
    """User has exceeded their daily / monthly AI spend cap.
    Surfaces as 402 Payment Required with the user's plan + the cap
    they hit, so the FE can prompt upgrade or wait-til-tomorrow."""
    code = "orchestrator.budget_exceeded"
    i18n_key = "errors.aiOrchestrator.budgetExceeded"
    http_status = 402


class ProviderUnavailableError(OrchestratorError):
    """Both Anthropic + OpenAI returned non-retryable errors, OR the
    only model configured for this task is offline. Orchestrator has
    exhausted fallbacks."""
    code = "orchestrator.provider_unavailable"
    i18n_key = "errors.aiOrchestrator.providerUnavailable"
    http_status = 503


class ProviderTransientError(OrchestratorError):
    """Single-call failure that COULD be retried (429 rate limit,
    5xx, network timeout). The orchestrator catches this internally
    and falls back; should not normally surface to the user."""
    code = "orchestrator.provider_transient"
    i18n_key = "errors.aiOrchestrator.providerTransient"
    http_status = 503


class SchemaValidationError(OrchestratorError):
    """The model returned content that doesn't match the requested
    output_schema. Usually means the prompt needs tightening; flagged
    in telemetry for prompt-author follow-up."""
    code = "orchestrator.schema_validation_failed"
    i18n_key = "errors.aiOrchestrator.schemaValidation"
    http_status = 502


class ArbitrationFailedError(OrchestratorError):
    """Two models disagreed AND the arbitration pass also failed (e.g.,
    returned malformed output). The FE should surface the disagreement
    to the user with both candidates + ask for manual resolution."""
    code = "orchestrator.arbitration_failed"
    i18n_key = "errors.aiOrchestrator.arbitrationFailed"
    http_status = 502


class TaskUnroutableError(OrchestratorError):
    """The task_type isn't in the routing config and no default is
    available. Programmer error — caught at startup by router tests."""
    code = "orchestrator.task_unroutable"
    i18n_key = "errors.aiOrchestrator.taskUnroutable"
    http_status = 500
