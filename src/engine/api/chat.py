"""Suggested starter prompts for the Ask CFO AI empty-state chat surface.

Used by `GET /api/cfo/chat/prompts`. This file used to also hold a
deterministic (LLM-free) chat responder — `build_context`/`respond` and the
`StatTile`/`ChatBlock`/`ChatAnswer`/`ChatContext` types — backing
`POST /api/cfo/chat`. That endpoint was removed 2026-07-24: it had no real
caller anywhere in the frontend (`cfoApi.chat` was defined but never
invoked), superseded by the workspace Ask CFO AI chat
(`supabase/functions/chat-llm/`, see root CLAUDE.md "Milestone D"). Only the
prompt list survived, since `/chat/prompts` is still live.
"""

from __future__ import annotations

from typing import Dict, List


SUGGESTED_PROMPTS: Dict[str, List[str]] = {
    "Daily": [
        "What should I do today?",
        "Show urgent decisions.",
        "Summarize portfolio health.",
    ],
    "Explain": [
        "Explain Macrou.",
        "Why is SUC in Scale?",
        "What does real margin mean?",
    ],
    "Cash": [
        "Where is cash trapped?",
        "Which SKUs should we liquidate?",
        "How much can we recover in 60 days?",
    ],
    "Simulate": [
        "Simulate cost of capital at 8%.",
        "What if we cut DIO by 20 days?",
        "Draft supplier renegotiation.",
        "Create board summary.",
    ],
}
