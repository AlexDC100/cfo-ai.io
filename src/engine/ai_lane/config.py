"""AI extraction lane — the ONE config module for model id + prompt
versions.

HARD RULE (task contract): the model id and every per-stage prompt
version live HERE and nowhere else. Every run logs them and persists
them into the envelope's `ai_audit` block, and the cache key is
(provenance/content_hash + these versions + the model id) — bump a
PROMPT_VERSION whenever its prompt text changes so stale cached
extractions are transparently re-run.
"""
from __future__ import annotations

import os
from typing import Any, Dict

from .schemas import AiLaneError

# The model this lane calls. Pinned by the operator spec; used verbatim
# on every stage call and recorded in ai_audit + canonical_bs.extraction.
MODEL_ID = "claude-opus-4-7"

# Version stamp for the lane's own deterministic post-processing (row
# shaping, self-check, envelope assembly) — the LLM analog of the RO
# parser_version. Bump on any lane-logic change.
AI_LANE_PARSER_VERSION = "ai_lane_v1"

# Per-stage prompt versions. Bump on ANY change to the stage's prompt.
FORMAT_DETECT_PROMPT_VERSION = "format_detect_v1"
EXTRACT_PROMPT_VERSION = "extract_v1"
CLASSIFY_PROMPT_VERSION = "classify_v1"

# Output ceilings per stage (extract carries the account rows).
FORMAT_DETECT_MAX_TOKENS = 2000
EXTRACT_MAX_TOKENS = 16000
CLASSIFY_MAX_TOKENS = 16000

# Text payload ceiling (chars) fed to the model per stage.
MAX_DOC_CHARS = 200_000


def prompt_versions() -> Dict[str, str]:
    """The cache-key half that lives in code. Recorded on ai_audit and
    compared verbatim on re-runs."""
    return {
        "parser_version": AI_LANE_PARSER_VERSION,
        "format_detect": FORMAT_DETECT_PROMPT_VERSION,
        "extract": EXTRACT_PROMPT_VERSION,
        "classify": CLASSIFY_PROMPT_VERSION,
    }


def default_client_factory() -> Any:
    """Build the production Anthropic client. Injectable in every stage
    (tests pass a fake factory; NO live calls in tests). Fails honestly
    when the key is absent — the lane must never fabricate numbers."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise AiLaneError(
            "AI extraction lane unavailable: ANTHROPIC_API_KEY is not "
            "configured on the backend."
        )
    try:
        from anthropic import Anthropic  # type: ignore
    except ImportError:
        raise AiLaneError("AI extraction lane unavailable: anthropic SDK not installed.")
    # max_retries covers transient 529 overloads; the lane surfaces any
    # terminal API error as a failed document, never partial numbers.
    return Anthropic(api_key=api_key, max_retries=3, timeout=180.0)
