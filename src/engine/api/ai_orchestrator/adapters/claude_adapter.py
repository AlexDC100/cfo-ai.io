"""ClaudeAdapter — wraps anthropic-python SDK for the orchestrator.

Important defaults (preserved from the existing engine's Claude usage
in src/engine/api/_detect.py + ask.py):
  · model: claude-opus-4-7 (per CLAUDE.md skill default)
  · max_retries=5 (SDK default of 2 is insufficient during sustained
    Opus 529 overloads — we saw this in production during F3.x deploys)
  · timeout=120s (long enough for adaptive-thinking tasks)
  · cache_control on system prompt (substantial discount on repeats)
  · output_config={"effort": "high"} default (re-tunable per task)

Structured output is delivered via tool_use (the most reliable pattern
on Claude — strict JSON schema enforced server-side via the tool's
input_schema).
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, List, Optional

from ..errors import ProviderTransientError, ProviderUnavailableError, SchemaValidationError
from ..types import AIRequest, AIResponse, ContentPart, ImagePart, TextPart, TokenUsage
from .base import BaseAdapter

logger = logging.getLogger(__name__)


# ── Pricing (Claude Opus 4.7 — per CLAUDE.md skill defaults) ───────────
# $5/M input, $25/M output. Cached prefix reads are ~10% of input price.
_INPUT_PRICE = 5.00
_OUTPUT_PRICE = 25.00
_CACHED_INPUT_PRICE = 0.50  # ~10% of base input


class ClaudeAdapter(BaseAdapter):
    name = "claude-opus-4-7"
    supports_structured_output = True
    supports_long_context = True  # 1M context
    supports_vision = True

    input_price_per_m = _INPUT_PRICE
    output_price_per_m = _OUTPUT_PRICE
    cached_input_price_per_m = _CACHED_INPUT_PRICE

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        model: str = "claude-opus-4-7",
        max_retries: int = 5,
        timeout: float = 120.0,
        default_effort: str = "high",
    ):
        self._api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self._model = model
        self._max_retries = max_retries
        self._timeout = timeout
        self._default_effort = default_effort
        # Override base.name with the actual model string
        self.name = model

        # Lazy SDK import — keep module importable even when the SDK
        # isn't installed (e.g., during dev when only the GPT path is
        # being exercised).
        self._client: Any = None
        if self._api_key:
            try:
                from anthropic import Anthropic  # type: ignore

                self._client = Anthropic(
                    api_key=self._api_key,
                    max_retries=self._max_retries,
                    timeout=self._timeout,
                )
            except ImportError:
                logger.warning("[claude_adapter] anthropic SDK not installed")
                self._client = None

    @property
    def available(self) -> bool:
        return self._client is not None

    def call(self, req: AIRequest) -> AIResponse:
        if not self.available:
            raise ProviderUnavailableError(
                "Claude adapter unavailable (no API key or SDK)",
                details={"model": self._model},
            )

        # — Build the call payload —
        # System prompt with cache_control for the prefix discount.
        system = [{
            "type": "text",
            "text": req.system_prompt,
            "cache_control": {"type": "ephemeral"},
        }]

        # User content: string or multimodal parts.
        messages = [{
            "role": "user",
            "content": self._format_user_content(req.user_message),
        }]

        # Structured output via tool_use (strict schema enforcement).
        kwargs: Dict[str, Any] = {
            "model": self._model,
            "max_tokens": req.max_tokens,
            "system": system,
            "messages": messages,
            # Effort knob — controls overall token spend + reasoning depth.
            # Default "high" balances quality + cost; per-task overrides
            # via req.metadata.get("effort") in future.
            "output_config": {"effort": self._default_effort},
        }

        if req.output_schema:
            # Forced tool_choice + thinking is incompatible on Opus 4.7
            # ("Thinking may not be enabled when tool_choice forces tool use").
            # For structured output, omit thinking entirely; effort still
            # controls reasoning depth.
            kwargs["tools"] = [{
                "name": "submit_response",
                "description": "Submit the structured response per the schema.",
                "input_schema": req.output_schema,
            }]
            kwargs["tool_choice"] = {"type": "tool", "name": "submit_response"}
        else:
            # Plain-text path: adaptive thinking is the recommended default
            # for Opus 4.7 (per CLAUDE.md skill).
            kwargs["thinking"] = {"type": "adaptive"}

        # — Make the call —
        start = time.monotonic()
        try:
            resp = self._client.messages.create(**kwargs)
        except Exception as e:  # noqa: BLE001
            # The SDK already retried per max_retries. If we get here,
            # this is a real failure — surface as transient so the
            # orchestrator can decide whether to fall back to GPT.
            logger.warning("[claude_adapter] call failed: %s", e)
            raise ProviderTransientError(
                f"Claude call failed after {self._max_retries} retries",
                cause=e,
                details={"model": self._model, "task_type": req.task_type.value},
            )
        latency_ms = int((time.monotonic() - start) * 1000)

        # — Parse response —
        content: Any = ""
        if req.output_schema:
            # Expected: a tool_use block with parsed args.
            tool_block = next(
                (b for b in resp.content if getattr(b, "type", None) == "tool_use"),
                None,
            )
            if tool_block is None:
                # Model returned text instead of using the tool — uncommon
                # but possible if the prompt confused it.
                text_block = next(
                    (b for b in resp.content if getattr(b, "type", None) == "text"),
                    None,
                )
                raise SchemaValidationError(
                    "Claude returned text instead of structured tool_use",
                    details={
                        "model": self._model,
                        "task_type": req.task_type.value,
                        "text_excerpt": (getattr(text_block, "text", "") or "")[:200],
                    },
                )
            content = getattr(tool_block, "input", {}) or {}
        else:
            # Plain text path: concatenate all text blocks.
            text_blocks = [
                getattr(b, "text", "")
                for b in resp.content
                if getattr(b, "type", None) == "text"
            ]
            content = "".join(text_blocks).strip()

        # — Token usage + cost —
        usage_raw = getattr(resp, "usage", None)
        cached = getattr(usage_raw, "cache_read_input_tokens", 0) or 0
        usage = TokenUsage(
            input_tokens=getattr(usage_raw, "input_tokens", 0) or 0,
            output_tokens=getattr(usage_raw, "output_tokens", 0) or 0,
            cached_input_tokens=cached,
        )
        usage.estimated_cost_usd = self._compute_cost(usage)

        return AIResponse(
            task_id=req.task_id,
            model=self._model,
            content=content,
            finish_reason=getattr(resp, "stop_reason", "stop") or "stop",
            usage=usage,
            latency_ms=latency_ms,
            raw=resp,
        )

    # ── Helpers ────────────────────────────────────────────────────────

    def _format_user_content(self, user_message: Any) -> Any:
        """Convert orchestrator content parts → Anthropic content blocks.

        String input → single text block.
        Multimodal input → list of blocks matching Anthropic's shape:
          {type: "text", text: "..."} | {type: "image", source: {...}}
        """
        if isinstance(user_message, str):
            return user_message

        blocks: List[Dict[str, Any]] = []
        for part in user_message:
            if isinstance(part, TextPart):
                blocks.append({"type": "text", "text": part.text})
            elif isinstance(part, ImagePart):
                if part.data_b64:
                    blocks.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": part.media_type,
                            "data": part.data_b64,
                        },
                    })
                elif part.url:
                    blocks.append({
                        "type": "image",
                        "source": {"type": "url", "url": part.url},
                    })
            # DocumentPart could be supported via Anthropic's PDF beta,
            # but we keep this MVP path text-only for now; the upstream
            # parser already produces text from PDFs.
        return blocks
