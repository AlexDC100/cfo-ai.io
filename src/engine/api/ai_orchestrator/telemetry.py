"""AITelemetry — append-only structured log of every orchestrator call.

Output: JSON-lines file at AI_TELEMETRY_PATH (default
/var/log/cfo-ai/orchestrator.jsonl). One record per call. The file is
rotated externally (logrotate); the orchestrator just appends.

What gets logged (per spec §Telemetry):
  · routing decision (primary, verifier, rationale)
  · per-model latency + token usage + cost
  · verification verdict (agreement, conflict count)
  · arbitration usage
  · cache hit/miss
  · NEVER: full content, full system prompt, API keys, user PII

The dashboard reads this file (or its Redis-mirrored counterpart) to
compute per-task agreement rates, cost trends, latency distributions —
the data that drives router-config tuning over time.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from .types import (
    AIRequest,
    AIResponse,
    VerificationResult,
)

logger = logging.getLogger(__name__)


_DEFAULT_PATH = "/var/log/cfo-ai/orchestrator.jsonl"


@dataclass
class _ModelLeg:
    """One model's contribution to a call (primary, verifier, or arbiter)."""
    model: str
    latency_ms: int
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int
    cost_usd: float


@dataclass
class TelemetryRecord:
    """Single orchestrator-call log line. JSON-serialized to one
    line of orchestrator.jsonl."""
    timestamp: float
    task_id: str
    task_type: str

    # Routing
    router_primary: str
    router_verifier: Optional[str]
    router_rationale: str

    # Outcomes
    primary: Optional[_ModelLeg]
    verifier: Optional[_ModelLeg]
    arbiter: Optional[_ModelLeg]

    # Verification
    agreement: str  # full | partial | conflict | no_verifier
    conflict_count: int
    arbitration_used: bool

    # Cache
    cache_hit: bool

    # Total per-call cost (primary + verifier + arbiter)
    total_cost_usd: float

    # Free-form context for slicing dashboards
    user_id: Optional[str] = None
    org_id: Optional[str] = None
    document_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


class AITelemetry:
    def __init__(self, path: Optional[str] = None) -> None:
        self._path = path or os.environ.get("AI_TELEMETRY_PATH", _DEFAULT_PATH)
        self._lock = threading.Lock()
        # Best-effort: create the dir; degrade gracefully if not writable.
        try:
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        except (OSError, PermissionError) as e:
            logger.warning("[telemetry] couldn't create dir for %s: %s", self._path, e)

    # ── Public ────────────────────────────────────────────────────────

    def record_cache_hit(self, req: AIRequest) -> None:
        """Quick path: cache hit, no model calls. One-line record so
        the per-task hit-rate dashboard stays accurate."""
        record = TelemetryRecord(
            timestamp=time.time(),
            task_id=req.task_id,
            task_type=req.task_type.value,
            router_primary="cache",
            router_verifier=None,
            router_rationale="cache hit",
            primary=None,
            verifier=None,
            arbiter=None,
            agreement="no_verifier",
            conflict_count=0,
            arbitration_used=False,
            cache_hit=True,
            total_cost_usd=0.0,
            user_id=req.metadata.get("user_id"),
            org_id=req.metadata.get("org_id"),
            document_id=req.metadata.get("document_id"),
            metadata=_safe_metadata(req.metadata),
        )
        self._write(record)

    def record(
        self,
        req: AIRequest,
        router_primary: str,
        router_verifier: Optional[str],
        router_rationale: str,
        primary: AIResponse,
        verifier: Optional[AIResponse] = None,
        arbiter: Optional[AIResponse] = None,
        verification: Optional[VerificationResult] = None,
    ) -> None:
        """Standard path: log the full orchestrator call."""
        primary_leg = _leg_from_response(primary)
        verifier_leg = _leg_from_response(verifier) if verifier else None
        arbiter_leg = _leg_from_response(arbiter) if arbiter else None

        agreement = verification.agreement if verification else "no_verifier"
        conflict_count = len(verification.conflicts) if verification else 0
        total_cost = primary_leg.cost_usd
        if verifier_leg:
            total_cost += verifier_leg.cost_usd
        if arbiter_leg:
            total_cost += arbiter_leg.cost_usd

        record = TelemetryRecord(
            timestamp=time.time(),
            task_id=req.task_id,
            task_type=req.task_type.value,
            router_primary=router_primary,
            router_verifier=router_verifier,
            router_rationale=router_rationale,
            primary=primary_leg,
            verifier=verifier_leg,
            arbiter=arbiter_leg,
            agreement=agreement,
            conflict_count=conflict_count,
            arbitration_used=arbiter is not None,
            cache_hit=False,
            total_cost_usd=round(total_cost, 6),
            user_id=req.metadata.get("user_id"),
            org_id=req.metadata.get("org_id"),
            document_id=req.metadata.get("document_id"),
            metadata=_safe_metadata(req.metadata),
        )
        self._write(record)

    # ── Internal ──────────────────────────────────────────────────────

    def _write(self, record: TelemetryRecord) -> None:
        try:
            line = json.dumps(_to_jsonable(record), ensure_ascii=False)
            with self._lock:
                with open(self._path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
        except (OSError, PermissionError) as e:
            # Telemetry MUST NEVER take down a request. Log + carry on.
            logger.warning("[telemetry] write failed: %s", e)


# ── Helpers ────────────────────────────────────────────────────────────

def _leg_from_response(resp: AIResponse) -> _ModelLeg:
    return _ModelLeg(
        model=resp.model,
        latency_ms=resp.latency_ms,
        input_tokens=resp.usage.input_tokens,
        output_tokens=resp.usage.output_tokens,
        cached_input_tokens=resp.usage.cached_input_tokens,
        cost_usd=round(resp.usage.estimated_cost_usd, 6),
    )


def _safe_metadata(md: Dict[str, Any]) -> Dict[str, Any]:
    """Strip anything that smells like PII or secrets. Allow simple
    scalar tags useful for telemetry slicing."""
    DENY = {"api_key", "token", "password", "session", "secret", "content", "raw"}
    clean: Dict[str, Any] = {}
    for k, v in md.items():
        if any(d in k.lower() for d in DENY):
            continue
        # Only keep small scalars; skip big blobs
        if isinstance(v, (str, int, float, bool)) or v is None:
            if isinstance(v, str) and len(v) > 200:
                continue
            clean[k] = v
    return clean


def _to_jsonable(record: TelemetryRecord) -> Dict[str, Any]:
    """asdict(record) but with nested dataclasses flattened."""
    d = asdict(record)
    return d
