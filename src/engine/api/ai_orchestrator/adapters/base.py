"""Shared base class for all model adapters.

The `ModelAdapter` Protocol in types.py is the structural contract;
this `BaseAdapter` is the convenience base class that handles the
boring parts (cost estimation arithmetic, content-formatting helpers)
so individual adapters can focus on the provider-specific call.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Union

from ..types import AIRequest, AIResponse, ContentPart, TextPart, TokenUsage

logger = logging.getLogger(__name__)


class BaseAdapter(ABC):
    """Convenience base. Subclasses MUST implement `call`. They MAY
    override `estimate_cost` if their pricing model is unusual.

    Pricing constants are per-million-tokens, populated by subclasses.
    The base's `_compute_cost` does the arithmetic.
    """
    name: str = "base"
    supports_structured_output: bool = False
    supports_long_context: bool = False
    supports_vision: bool = False

    # Per-million-tokens pricing — subclasses override.
    input_price_per_m: float = 0.0
    output_price_per_m: float = 0.0
    cached_input_price_per_m: float = 0.0  # Cached-prefix discount

    @property
    def available(self) -> bool:
        """True when the adapter can actually make calls (API key
        present, SDK importable). Subclasses override."""
        return True

    @abstractmethod
    def call(self, req: AIRequest) -> AIResponse:
        """Provider-specific request. Must populate AIResponse.usage
        with real token counts + cost, AIResponse.latency_ms with
        wall-clock time, and AIResponse.raw with the full provider
        response for debugging."""
        ...

    def estimate_cost(self, req: AIRequest) -> float:
        """Cheap upfront estimate using input-token approximation.
        Used by BudgetGuard for pre-call admission; real cost is
        recorded in AIResponse.usage after the call.

        Conservative: assumes worst-case output_tokens = max_tokens
        and zero cache hits. Real call usually costs less."""
        input_chars = self._estimate_input_chars(req)
        # Rough heuristic: 4 chars/token for English; 3 for RO/multilingual.
        # We round up to be safe for budget gating.
        input_tokens = max(1, input_chars // 3)
        output_tokens = req.max_tokens
        return self._compute_cost(
            TokenUsage(
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cached_input_tokens=0,
            )
        )

    def _compute_cost(self, usage: TokenUsage) -> float:
        """Convert TokenUsage → USD using per-million-token pricing."""
        non_cached_input = usage.input_tokens - usage.cached_input_tokens
        return (
            (non_cached_input / 1_000_000) * self.input_price_per_m
            + (usage.cached_input_tokens / 1_000_000) * self.cached_input_price_per_m
            + (usage.output_tokens / 1_000_000) * self.output_price_per_m
        )

    def _estimate_input_chars(self, req: AIRequest) -> int:
        """Sum text length across system + user message."""
        total = len(req.system_prompt or "")
        if isinstance(req.user_message, str):
            total += len(req.user_message)
        else:
            for part in req.user_message:
                if isinstance(part, TextPart):
                    total += len(part.text)
                # Image/document parts don't contribute to text-char
                # estimate; their token cost is fixed by media size.
        return total

    def _format_user_content_for_text_only(self, user_message: Union[str, List[ContentPart]]) -> str:
        """Flatten content parts into a single string for adapters that
        don't (yet) implement multimodal. Image/document parts become
        a placeholder so the prompt is at least valid."""
        if isinstance(user_message, str):
            return user_message
        out: List[str] = []
        for part in user_message:
            if isinstance(part, TextPart):
                out.append(part.text)
            else:
                out.append(f"[{part.type} content — adapter does not support multimodal]")
        return "\n".join(out)
