"""AI extraction lane — the ONE config module for model id + prompt
versions.

HARD RULE (task contract): the model id and every per-stage prompt
version live HERE and nowhere else. Every run logs them and persists
them into the envelope's `ai_audit` block, and the cache key is
(provenance/content_hash + these versions + the model id) — bump a
PROMPT_VERSION whenever its prompt text changes so stale cached
extractions are transparently re-run.

CLASSIFY IS PACK-VERSIONED (Phase 4): the classify prompt renders from
the jurisdiction DATA PACK (packs/hu/actc2000-v1, packs/intl/
ifrs-captions-v1 — engine.ai_lane.classify), so its prompt version
DERIVES FROM THE PACK CONTENT HASH: any semantic pack edit (rules,
prompt_guidance, statement map, a confirmed_mappings.yaml overlay
entry) re-versions the prompt to 'classify_<jur>@<pack_hash[:12]>' and
with it invalidates the AI cache — no manual bump to forget. The exact
v1 pack contents alias to the frozen pre-cutover string 'classify_v1'
(same byte-stability discipline as chart_of_accounts.
_PACK_MAPPING_VERSION_ALIASES): every stored envelope and the golden
corpus already carry it, and the v1 prompt text is byte-identical to
the pre-cutover hardcoded prompt (pinned by tests/engine/
test_hu_pack.py), so the frozen name stays honest.
"""
from __future__ import annotations

import os
from typing import Any, Dict

from engine.packs.runtime import active_pack
from engine.packs.schema import CompiledPack

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

# The FROZEN classify base version — the alias value the exact v1 pack
# contents map to (see classify_prompt_version_for). Kept as a module
# constant because stored envelopes, the golden corpus and the cache
# rows all carry this string.
CLASSIFY_PROMPT_VERSION = "classify_v1"

#: pack_hash -> frozen prompt-version alias. Keyed by CONTENT HASH, not
#: identity: only the byte-exact v1 pack data keeps the frozen name —
#: ANY in-place edit (even keeping "version: v1") changes the hash,
#: misses the alias, and derives a fresh version, which is exactly the
#: cache-invalidation guarantee. The hashes are pinned to the generated
#: packs by tests/engine/test_hu_pack.py; scripts/port_hu_pack.py
#: --check pins the pack bytes themselves.
_CLASSIFY_PROMPT_VERSION_ALIASES: Dict[str, str] = {
    # packs/hu/actc2000-v1
    "d2367f22d245620139be2a6bf7dfe5898dec18548fd34b19b6a3f473dfb5095f":
        CLASSIFY_PROMPT_VERSION,
    # packs/intl/ifrs-captions-v1
    "9f27cb46a010db189fe3d9ed60d4af0db6e9d4f996a72e03c8453f9e64751512":
        CLASSIFY_PROMPT_VERSION,
}

# Output ceilings per stage (extract carries the account rows).
FORMAT_DETECT_MAX_TOKENS = 2000
EXTRACT_MAX_TOKENS = 16000
CLASSIFY_MAX_TOKENS = 16000

# Text payload ceiling (chars) fed to the model per stage.
MAX_DOC_CHARS = 200_000


def classify_pack(jurisdiction: str) -> CompiledPack:
    """THE data pack the classify stage runs off for a lane jurisdiction:
    'HU' -> the HU pack; anything else ('OTHER' from the resolver, the
    FE's 'INTL' wire code) -> the international IFRS-captions pack.
    Resolved lazily per call through the cached pack runtime — a missing
    pack fails the document loudly (NoPackFoundError), never silently."""
    jur = "HU" if str(jurisdiction or "").strip().upper() == "HU" else "INTL"
    return active_pack(jur)


def classify_prompt_version_for(pack: CompiledPack) -> str:
    """The classify prompt version for a resolved pack: the frozen alias
    for the exact v1 contents, else 'classify_<jur>@<pack_hash[:12]>' —
    mechanically derived, collision-free with the frozen name."""
    alias = _CLASSIFY_PROMPT_VERSION_ALIASES.get(pack.pack_hash)
    if alias is not None:
        return alias
    return "classify_%s@%s" % (
        pack.identity.jurisdiction.lower(), pack.pack_hash[:12],
    )


def classify_prompt_version(jurisdiction: str) -> str:
    return classify_prompt_version_for(classify_pack(jurisdiction))


def prompt_versions(jurisdiction: str) -> Dict[str, str]:
    """The cache-key half that lives in code + pack data. Recorded on
    ai_audit and compared verbatim on re-runs — jurisdiction-dependent
    because the classify entry derives from that jurisdiction's pack."""
    return {
        "parser_version": AI_LANE_PARSER_VERSION,
        "format_detect": FORMAT_DETECT_PROMPT_VERSION,
        "extract": EXTRACT_PROMPT_VERSION,
        "classify": classify_prompt_version(jurisdiction),
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
