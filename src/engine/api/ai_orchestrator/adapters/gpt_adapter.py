"""GPTAdapter — wraps openai-python SDK for the orchestrator.

GPT-5 is used as the cross-check verifier on high-stakes extractions
(see routing_config.py). It's intentionally NOT the primary on any
finance-extraction task — Claude has stronger structured-extraction
reliability on Romanian/EU document layouts. GPT's value is providing
an independent second opinion: if both models agree, confidence is
high; if they disagree, the reconciler escalates.

Graceful degradation: when OPENAI_API_KEY is missing OR the openai
SDK isn't installed, `available` returns False and `call()` raises
ProviderUnavailableError. The orchestrator's verifier path checks
availability before scheduling the second call, so the system runs
fine on Claude-only mode if needed.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, Optional

from ..errors import ProviderTransientError, ProviderUnavailableError, SchemaValidationError
from ..types import AIRequest, AIResponse, TokenUsage
from .base import BaseAdapter

logger = logging.getLogger(__name__)


# ── Pricing (GPT-5 published rates; conservative defaults) ─────────────
# These should be re-verified against current OpenAI pricing on cost
# review. The orchestrator's BudgetGuard relies on this being roughly
# accurate; off-by-2x is OK for the gate, off-by-10x is not.
_INPUT_PRICE = 5.00
_OUTPUT_PRICE = 15.00
_CACHED_INPUT_PRICE = 0.50  # OpenAI's automatic prompt cache discount


class GPTAdapter(BaseAdapter):
    name = "gpt-5"
    supports_structured_output = True
    supports_long_context = True
    supports_vision = True

    input_price_per_m = _INPUT_PRICE
    output_price_per_m = _OUTPUT_PRICE
    cached_input_price_per_m = _CACHED_INPUT_PRICE

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        model: str = "gpt-5",
        max_retries: int = 5,
        timeout: float = 120.0,
    ):
        self._api_key = api_key or os.environ.get("OPENAI_API_KEY")
        self._model = model
        self._max_retries = max_retries
        self._timeout = timeout
        self.name = model

        # Lazy SDK import — same pattern as ClaudeAdapter.
        self._client: Any = None
        if self._api_key:
            try:
                from openai import OpenAI  # type: ignore

                self._client = OpenAI(
                    api_key=self._api_key,
                    max_retries=self._max_retries,
                    timeout=self._timeout,
                )
            except ImportError:
                logger.warning("[gpt_adapter] openai SDK not installed")
                self._client = None

    @property
    def available(self) -> bool:
        return self._client is not None

    def call(self, req: AIRequest) -> AIResponse:
        if not self.available:
            raise ProviderUnavailableError(
                "GPT adapter unavailable (no OPENAI_API_KEY or SDK)",
                details={"model": self._model},
            )

        # — Build call —
        # Multimodal: the orchestrator's user_message can be a string or
        # a list of parts; we flatten to text-only for the MVP. Vision
        # support is planned for a future task type that needs it.
        user_text = self._format_user_content_for_text_only(req.user_message)

        kwargs: Dict[str, Any] = {
            "model": self._model,
            "input": user_text,
            "instructions": req.system_prompt,
            "max_output_tokens": req.max_tokens,
        }
        # GPT-5 (and other reasoning models) reject the `temperature`
        # parameter outright with HTTP 400. Older non-reasoning models
        # (gpt-4o, gpt-4.1-mini) accept it. Conservative default: send
        # temperature ONLY for non-reasoning models. The orchestrator
        # default temp=0 makes structured output deterministic anyway,
        # so reasoning models still produce stable output.
        if not self._is_reasoning_model():
            kwargs["temperature"] = req.temperature

        if req.output_schema:
            # OpenAI Responses API uses `text={"format": {...}}` for
            # structured output (Chat Completions used `response_format`,
            # but the Responses API moved to `text` — verified against
            # openai-python's Responses.create signature on 2026-05-24).
            kwargs["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": "response",
                    "schema": req.output_schema,
                    "strict": True,
                },
            }

        # — Make the call —
        start = time.monotonic()
        try:
            resp = self._client.responses.create(**kwargs)
        except Exception as e:  # noqa: BLE001
            logger.warning("[gpt_adapter] call failed: %s", e)
            raise ProviderTransientError(
                f"GPT call failed after {self._max_retries} retries",
                cause=e,
                details={"model": self._model, "task_type": req.task_type.value},
            )
        latency_ms = int((time.monotonic() - start) * 1000)

        # — Parse response —
        # Responses API exposes `output_text` as a convenience accessor.
        raw_text = getattr(resp, "output_text", None)
        if raw_text is None:
            # Fallback path: walk the structured `output` list.
            raw_text = self._extract_text_from_output(resp)

        content: Any
        if req.output_schema:
            try:
                content = json.loads(raw_text) if isinstance(raw_text, str) else raw_text
            except (json.JSONDecodeError, TypeError) as e:
                raise SchemaValidationError(
                    "GPT returned non-JSON despite json_schema enforcement",
                    details={
                        "model": self._model,
                        "task_type": req.task_type.value,
                        "text_excerpt": (raw_text or "")[:200],
                    },
                    cause=e,
                )
        else:
            content = raw_text or ""

        # — Token usage + cost —
        usage_raw = getattr(resp, "usage", None)
        # OpenAI Responses API exposes `input_tokens`, `output_tokens`,
        # and (for cached prefix) `input_tokens_details.cached_tokens`.
        cached = 0
        if usage_raw is not None:
            details = getattr(usage_raw, "input_tokens_details", None)
            if details is not None:
                cached = getattr(details, "cached_tokens", 0) or 0

        usage = TokenUsage(
            input_tokens=getattr(usage_raw, "input_tokens", 0) or 0 if usage_raw else 0,
            output_tokens=getattr(usage_raw, "output_tokens", 0) or 0 if usage_raw else 0,
            cached_input_tokens=cached,
        )
        usage.estimated_cost_usd = self._compute_cost(usage)

        return AIResponse(
            task_id=req.task_id,
            model=self._model,
            content=content,
            finish_reason=getattr(resp, "status", "stop") or "stop",
            usage=usage,
            latency_ms=latency_ms,
            raw=resp,
        )

    # ── Helpers ────────────────────────────────────────────────────────

    def _is_reasoning_model(self) -> bool:
        """Reasoning models (gpt-5*, o1*, o3*) don't accept `temperature`
        and a few other sampling params. Conservative match list — add
        new model families as they release."""
        m = (self._model or "").lower()
        return (
            m.startswith("gpt-5")
            or m.startswith("o1")
            or m.startswith("o3")
            or m.startswith("o4")
        )

    def _extract_text_from_output(self, resp: Any) -> str:
        """Walk the Responses API output list to assemble text.
        Used only when `output_text` accessor isn't populated (rare)."""
        out = getattr(resp, "output", None) or []
        chunks = []
        for item in out:
            content = getattr(item, "content", None) or []
            for block in content:
                text = getattr(block, "text", None)
                if isinstance(text, str):
                    chunks.append(text)
        return "".join(chunks)
