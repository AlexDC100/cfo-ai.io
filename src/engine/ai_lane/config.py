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

# ── Registry-backed constants — RESOLVED ON FIRST TOUCH (PEP 562) ──────
#
# The model this lane records on ai_audit + canonical_bs.extraction and
# uses as its envelope-level cache-key half (MODEL_ID), the per-stage
# prompt versions and the per-stage output ceilings are REGISTRY reads
# (engine/ai/models.yaml) with a VALUE-IDENTICAL cutover — the corpus
# goldens and stored envelopes byte-freeze the strings, so a model
# change is a deliberate registry edit + golden refreeze, never a code
# edit here. Locked by tests/engine/test_model_registry.py.
#
# They are read at FIRST TOUCH, not at import (critic D6, 2026-09-05).
# This module sits in the import closure of `from engine.api import
# create_app` (server -> pipeline -> engine.ai_lane -> here), and a
# module-level registry read made the WHOLE APP depend on models.yaml
# resolving at import: a missing role, an unreadable file or a role with
# no breaker caps was a RegistryError before uvicorn had a process to
# serve — the deterministic firm board included. Every name below is
# still a module attribute (`config.MODEL_ID` reads as before, `from
# .config import MODEL_ID` too, a monkeypatch still wins — it lands in
# globals, which are consulted first), and the registry's failure stays
# LOUD at the first AI call that touches one. Same shape as
# engine.api._reconcile and engine.api.pipeline.
#
# `_CLASSIFY_PROMPT_VERSION_ALIASES` composes on CLASSIFY_PROMPT_VERSION
# and is resolved the same way. Inside THIS module every read goes
# through `_registry_constant` — a bare global read never consults
# `__getattr__`.

#: name -> (registry role, params key)
_REGISTRY_CONSTANTS = {
    "MODEL_ID": ("extract", "model_id"),
    "FORMAT_DETECT_PROMPT_VERSION": ("format_detect", "prompt_version"),
    "EXTRACT_PROMPT_VERSION": ("extract", "prompt_version"),
    "CLASSIFY_PROMPT_VERSION": ("classify", "prompt_version"),
    "FORMAT_DETECT_MAX_TOKENS": ("format_detect", "max_tokens"),
    "EXTRACT_MAX_TOKENS": ("extract", "max_tokens"),
    "CLASSIFY_MAX_TOKENS": ("classify", "max_tokens"),
}

#: The pack content hashes whose exact v1 contents alias to the FROZEN
#: classify base version (see classify_prompt_version_for). Keyed by
#: CONTENT HASH, not identity: only the byte-exact v1 pack data keeps the
#: frozen name — ANY in-place edit (even keeping "version: v1") changes
#: the hash, misses the alias, and derives a fresh version, which is
#: exactly the cache-invalidation guarantee. The hashes are pinned to the
#: generated packs by tests/engine/test_hu_pack.py; scripts/port_hu_pack.py
#: --check pins the pack bytes themselves.
_CLASSIFY_ALIAS_PACK_HASHES = (
    # packs/hu/actc2000-v1
    "d2367f22d245620139be2a6bf7dfe5898dec18548fd34b19b6a3f473dfb5095f",
    # packs/intl/ifrs-captions-v1
    "9f27cb46a010db189fe3d9ed60d4af0db6e9d4f996a72e03c8453f9e64751512",
)

_LAZY_NAMES = tuple(_REGISTRY_CONSTANTS) + ("_CLASSIFY_PROMPT_VERSION_ALIASES",)


def _resolve(name: str) -> Any:
    """Read one lazy constant from the registry and pin it into this
    module's globals (later reads are plain attribute reads). Raises the
    registry's own RegistryError when it cannot resolve — at the seam.
    Lazy import on purpose: engine.ai.registry is touched here and
    nowhere else in this module."""
    from engine.ai import registry as _model_registry  # the ONE registry read of this module

    if name in _REGISTRY_CONSTANTS:
        role, key = _REGISTRY_CONSTANTS[name]
        value = _model_registry.params_for(role)[key]
    elif name == "_CLASSIFY_PROMPT_VERSION_ALIASES":
        frozen = _registry_constant("CLASSIFY_PROMPT_VERSION")
        value = dict((h, frozen) for h in _CLASSIFY_ALIAS_PACK_HASHES)
    else:
        raise AttributeError("module %r has no attribute %r" % (__name__, name))
    globals().setdefault(name, value)
    return globals()[name]


def _registry_constant(name: str) -> Any:
    """The pinned module global when one exists (a monkeypatch, or an
    earlier resolution), else the registry read — which pins it."""
    value = globals().get(name)
    if value is not None:
        return value
    return _resolve(name)


def __getattr__(name: str) -> Any:
    if name in _LAZY_NAMES:
        return _resolve(name)
    raise AttributeError("module %r has no attribute %r" % (__name__, name))


# Version stamp for the lane's own deterministic post-processing (row
# shaping, self-check, envelope assembly) — the LLM analog of the RO
# parser_version. Bump on any lane-logic change.
AI_LANE_PARSER_VERSION = "ai_lane_v1"

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
    alias = _registry_constant("_CLASSIFY_PROMPT_VERSION_ALIASES").get(pack.pack_hash)
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
        "format_detect": _registry_constant("FORMAT_DETECT_PROMPT_VERSION"),
        "extract": _registry_constant("EXTRACT_PROMPT_VERSION"),
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
