"""LLM client abstraction.

Two implementations:
  - ClaudeBriefingClient: hits the real Anthropic API (uses prompt caching).
  - MockBriefingClient:    returns a canned response — for tests / dry runs.

The Protocol decouples the generator from anthropic SDK details so the rest
of the engine never imports anthropic, and tests don't need an API key.
"""

from __future__ import annotations

import os
from typing import List, Optional, Protocol


class BriefingClient(Protocol):
    """Minimal interface — single one-shot completion with system + user."""

    def complete(self, system: str, user: str) -> str: ...


class ClaudeBriefingClient:
    """Real Anthropic API client.

    System prompt is marked for prompt caching so the daily run pays the cache
    write once and gets cache hits for the rest of the day's invocations.

    Defaults to Claude Opus 4.7 — most capable model, used for the executive
    briefing where the wording lands on the operator's desk.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "claude-opus-4-7",
        max_tokens: int = 1200,
    ):
        # Imported lazily so anthropic is only required when actually used.
        from anthropic import Anthropic

        self._client = Anthropic(api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"))
        self.model = model
        self.max_tokens = max_tokens

    def complete(self, system: str, user: str) -> str:
        # System prompt cached: the persona + format instructions are stable
        # across every daily run; the user message is the only thing that
        # varies, so caching saves ~all input tokens after the first call.
        # Effort=medium keeps the briefing tight without burning tokens — this
        # is a structured summary, not an open-ended reasoning task.
        resp = self._client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            system=[
                {
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user}],
            output_config={"effort": "medium"},
        )
        # SDK returns a list of content blocks; concatenate the text blocks.
        parts: List[str] = []
        for block in resp.content:
            if getattr(block, "type", None) == "text":
                parts.append(block.text)
        return "".join(parts).strip()


class MockBriefingClient:
    """Returns a canned response — used in tests and `--dry-run` briefings.

    The response embeds the user prompt so tests can assert that prompts
    contain the expected facts (anchor names, capital impact, etc.).
    """

    def __init__(self, response: Optional[str] = None):
        self._response = response
        self.calls: List[dict] = []  # captured for assertions

    def complete(self, system: str, user: str) -> str:
        self.calls.append({"system": system, "user": user})
        if self._response is not None:
            return self._response
        # Default canned response — echoes a recognizable token + the user fact list.
        return f"[mock briefing]\n{user}"
