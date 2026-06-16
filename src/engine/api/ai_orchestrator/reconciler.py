"""Reconciler — decides what to do when primary + verifier disagree.

Three branches:
  · full agreement       → use primary, no extra work
  · partial agreement    → use primary, log conflicts for telemetry
                           (these are low-severity diffs within
                           tolerance bands, not real errors)
  · conflict             → arbitrate: send BOTH candidates to a third
                           pass with an explicit "which is correct"
                           prompt; use the arbiter's verdict

The arbitration prompt is designed to be model-agnostic — it shows
both candidates without identifying which model produced which, so
the arbiter judges purely on content quality and reasoning, not on
"trust this model more by default".
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import TYPE_CHECKING

from .errors import ArbitrationFailedError
from .types import (
    AIRequest,
    AIResponse,
    ExecutionResult,
    Provenance,
    VerificationResult,
)

if TYPE_CHECKING:
    from .router import Router

logger = logging.getLogger(__name__)


def reconcile(
    req: AIRequest,
    primary: AIResponse,
    verifier: AIResponse,
    verification: VerificationResult,
    router: "Router",
) -> ExecutionResult:
    """Pick the final answer + record provenance.

    Confidence thresholds:
      · full agreement → primary
      · partial + confidence > 0.95 → primary (the diff is noise)
      · everything else → arbitrate
    """
    sources = [primary.model, verifier.model]

    if verification.agreement == "full":
        return ExecutionResult(
            response=primary,
            provenance=Provenance(
                sources=sources,
                agreed=True,
                notes="Full agreement between primary and verifier",
            ),
        )

    if verification.agreement == "partial" and verification.confidence > 0.95:
        return ExecutionResult(
            response=primary,
            provenance=Provenance(
                sources=sources,
                agreed=False,
                partial=True,
                conflicts=verification.conflicts,
                notes=(
                    f"Partial agreement (confidence {verification.confidence:.2f}); "
                    f"{len(verification.conflicts)} minor diff(s) within noise"
                ),
            ),
        )

    # — Real conflict — third pass with arbitration prompt —
    return _arbitrate(req, primary, verifier, verification, router)


def _arbitrate(
    req: AIRequest,
    primary: AIResponse,
    verifier: AIResponse,
    verification: VerificationResult,
    router: "Router",
) -> ExecutionResult:
    """Send both candidates + the conflict list to a third model.
    The arbiter's job is to pick the correct candidate OR provide a
    corrected version. Same output_schema is enforced so the result
    is drop-in compatible."""
    arbiter = router.pick_arbiter(req.task_type)
    logger.info(
        "[reconciler] arbitrating task %s with %s (conflicts=%d)",
        req.task_type.value, arbiter.name, len(verification.conflicts),
    )

    # — Build arbitration prompt —
    # Note: we DON'T tell the arbiter which model produced which output.
    # Forces judgment based on content, not on model-name bias.
    primary_str = _serialize_content(primary.content)
    verifier_str = _serialize_content(verifier.content)
    conflict_str = json.dumps(
        [{
            "field": c.field,
            "source_a": c.primary,
            "source_b": c.verifier,
            "severity": c.severity,
            "notes": c.notes,
        } for c in verification.conflicts],
        ensure_ascii=False, indent=2,
    )

    user_payload = (
        "Two models produced analyses of the same task. They disagree on "
        "some fields. Your job is to pick the more accurate values OR "
        "provide corrected values where neither is right.\n\n"
        "ORIGINAL TASK:\n"
        f"{_serialize_user_message(req.user_message)}\n\n"
        "SOURCE A:\n"
        f"{primary_str}\n\n"
        "SOURCE B:\n"
        f"{verifier_str}\n\n"
        "CONFLICTS:\n"
        f"{conflict_str}\n\n"
        "Return the corrected analysis using the SAME schema as the "
        "original task. For each field where you chose a value, be "
        "ready to defend your choice based on the source data."
    )

    arbitration_req = AIRequest(
        task_id=str(uuid.uuid4()),
        task_type=req.task_type,
        system_prompt=(
            (req.system_prompt or "") + "\n\n"
            "You are reconciling two prior analyses. Be conservative — "
            "pick the value supported by the source data, not the more "
            "elaborate one. When in doubt, return the value with the "
            "stronger documentary support."
        ),
        user_message=user_payload,
        output_schema=req.output_schema,
        max_tokens=req.max_tokens,
        temperature=0.0,  # arbitration is deterministic
        metadata={**req.metadata, "arbitration_for": req.task_id},
    )

    try:
        arbitration = arbiter.call(arbitration_req)
    except Exception as e:  # noqa: BLE001
        raise ArbitrationFailedError(
            "Arbitration call failed",
            details={
                "arbiter": arbiter.name,
                "task_type": req.task_type.value,
                "conflict_count": len(verification.conflicts),
            },
            cause=e,
        )

    return ExecutionResult(
        response=arbitration,
        provenance=Provenance(
            sources=[primary.model, verifier.model, arbiter.name],
            agreed=False,
            arbitrated=True,
            conflicts=verification.conflicts,
            notes=(
                f"Arbitrated by {arbiter.name} after {len(verification.conflicts)} "
                f"conflict(s); confidence={verification.confidence:.2f}"
            ),
        ),
    )


# ── Helpers ────────────────────────────────────────────────────────────

def _serialize_content(content) -> str:
    """Render content (str or dict) for the arbitration prompt."""
    if isinstance(content, str):
        return content
    try:
        return json.dumps(content, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        return repr(content)


def _serialize_user_message(user_message) -> str:
    """Flatten the original user_message for the arbitration prompt."""
    if isinstance(user_message, str):
        return user_message
    # Multimodal: just describe what's there; the arbiter only needs
    # the textual context for judgment.
    parts = []
    for p in user_message:
        text = getattr(p, "text", None)
        if text:
            parts.append(text)
        else:
            parts.append(f"[{getattr(p, 'type', 'unknown')} content]")
    return "\n".join(parts)
