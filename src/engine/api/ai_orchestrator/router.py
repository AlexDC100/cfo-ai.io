"""Router — picks the primary + verifier models for a given task.

The router is intentionally dumb: it's a config lookup, not a model
in itself. The intelligence is in (a) the routing_config.py rules
and (b) the telemetry feedback loop that tunes those rules over time.

Default behavior when a task isn't in the config: Claude-only, no
verifier. Matches the pre-orchestrator engine behavior so adding a
new task without updating the routing config is safe (just suboptimal).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from .adapters import ClaudeAdapter, GPTAdapter
from .adapters.base import BaseAdapter
from .errors import ProviderUnavailableError
from .routing_config import ROUTING_CONFIG
from .types import AIRequest, ModelName, RoutingConfig, TaskType

logger = logging.getLogger(__name__)


@dataclass
class RoutingDecision:
    """What the orchestrator gets back. `verifier` is None when:
      (a) the routing rule doesn't request one, OR
      (b) the verifier model is unavailable (degrades gracefully to
          single-model mode)."""
    primary: BaseAdapter
    verifier: Optional[BaseAdapter]
    rationale: str


class Router:
    def __init__(
        self,
        claude: ClaudeAdapter,
        gpt: GPTAdapter,
        config: RoutingConfig = ROUTING_CONFIG,
    ):
        self._claude = claude
        self._gpt = gpt
        self._config = config

    def decide(self, req: AIRequest) -> RoutingDecision:
        """Pick (primary, verifier) for this request. Falls back to
        Claude-only when the task type is unmapped."""
        rule = self._config.rules.get(req.task_type)

        if rule is None:
            logger.info(
                "[router] no rule for task %s, falling back to claude-only",
                req.task_type.value,
            )
            primary = self._adapter_for("claude")
            return RoutingDecision(
                primary=primary,
                verifier=None,
                rationale="default fallback (no rule)",
            )

        primary = self._adapter_for(rule.primary)
        verifier: Optional[BaseAdapter] = None

        if rule.verify is not None:
            v = self._adapter_for(rule.verify)
            if v.available:
                verifier = v
            else:
                logger.info(
                    "[router] verifier %s unavailable for task %s; degrading to single-model",
                    rule.verify,
                    req.task_type.value,
                )

        # If the rule's primary is unavailable, swap to the other model
        # (better degraded than nothing). This is the resilience layer.
        if not primary.available:
            fallback = self._claude if rule.primary == "gpt" else self._gpt
            if fallback.available:
                logger.warning(
                    "[router] primary %s unavailable for task %s; swapping to %s",
                    rule.primary, req.task_type.value, fallback.name,
                )
                primary = fallback
                # No verifier when we just swapped — the verifier IS our
                # surviving model.
                verifier = None
            else:
                raise ProviderUnavailableError(
                    "Both Claude and GPT unavailable",
                    details={"task_type": req.task_type.value},
                )

        return RoutingDecision(
            primary=primary,
            verifier=verifier,
            rationale=rule.rationale,
        )

    def pick_arbiter(self, task_type: TaskType) -> BaseAdapter:
        """Arbitrator for the reconciler's third pass on conflicts.

        Strategy: prefer Claude (per CLAUDE.md, it's the strongest
        reasoning engine for CFO-grade analysis). If Claude is offline,
        use GPT. If both offline, the orchestrator never gets here
        (router.decide would have raised earlier).
        """
        if self._claude.available:
            return self._claude
        if self._gpt.available:
            return self._gpt
        raise ProviderUnavailableError(
            "No arbiter available", details={"task_type": task_type.value}
        )

    def _adapter_for(self, name: ModelName) -> BaseAdapter:
        return self._claude if name == "claude" else self._gpt
