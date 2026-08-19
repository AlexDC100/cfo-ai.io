"""AI extraction lane — shared strict-JSON model-call helper.

One code path for every stage so retry semantics, fence-stripping, audit
capture and error wrapping can't drift between format_detect / extract /
classify. The FULL raw response text of every attempt is appended to the
run's `ai_audit.stages` list (task contract: complete audit trail).

Retry policy (task contract): ONE retry on malformed JSON, with the
parse error included in the retry prompt; a second malformed response
raises `AiLaneError` → the pipeline marks the document failed with a
clear message. Numbers are never repaired or invented client-side.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from . import config
from .schemas import AiLaneError

logger = logging.getLogger("engine.api")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _response_text(resp: Any) -> str:
    """Join the text blocks of a Messages API response (mock-friendly:
    only relies on `.content[*].type/.text`)."""
    parts: List[str] = []
    for block in getattr(resp, "content", None) or []:
        if getattr(block, "type", None) == "text":
            parts.append(getattr(block, "text", "") or "")
    return "".join(parts).strip()


def _strip_fences(text: str) -> str:
    """Tolerate a ```json fenced reply — same normalization the existing
    freeform pipeline path applies before json.loads."""
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`")
        if t.startswith("json"):
            t = t[4:]
        t = t.strip()
    return t


def call_strict_json(
    client: Any,
    *,
    stage: str,
    prompt_version: str,
    system: str,
    user_text: str,
    max_tokens: int,
    audit_stages: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """One strict-JSON model call with ONE malformed-JSON retry.

    Returns the parsed JSON object. Raises AiLaneError on transport /
    API errors and on a second malformed response. Appends one audit
    entry per ATTEMPT to `audit_stages` (model id + prompt version +
    full raw response), fulfilling the persist-everything contract.
    """
    messages: List[Dict[str, Any]] = [
        {"role": "user", "content": [{"type": "text", "text": user_text}]},
    ]
    last_error: Optional[str] = None
    for attempt in (1, 2):
        try:
            resp = client.messages.create(
                model=config.MODEL_ID,
                max_tokens=max_tokens,
                system=[{"type": "text", "text": system}],
                messages=messages,
                output_config={"effort": "high"},
            )
        except Exception as e:  # noqa: BLE001 — wrap EVERY client failure honestly
            raise AiLaneError(
                "AI extraction failed at stage '%s' (model %s): %s"
                % (stage, config.MODEL_ID, e)
            )
        text = _response_text(resp)
        if audit_stages is not None:
            audit_stages.append({
                "stage": stage,
                "attempt": attempt,
                "model": config.MODEL_ID,
                "prompt_version": prompt_version,
                "at": _now_iso(),
                "raw_response": text,
            })
        try:
            data = json.loads(_strip_fences(text))
            if not isinstance(data, dict):
                raise json.JSONDecodeError("top-level JSON must be an object", text, 0)
            logger.info(
                "[ai_lane] stage=%s ok (model=%s prompt=%s attempt=%d)",
                stage, config.MODEL_ID, prompt_version, attempt,
            )
            return data
        except json.JSONDecodeError as e:
            last_error = str(e)
            logger.warning(
                "[ai_lane] stage=%s returned malformed JSON on attempt %d: %s",
                stage, attempt, last_error,
            )
            if attempt == 1:
                # Retry prompt carries the parse error (task contract).
                messages = [
                    {"role": "user", "content": [{"type": "text", "text": user_text}]},
                    {"role": "assistant", "content": [{"type": "text", "text": text[:2000]}]},
                    {"role": "user", "content": [{"type": "text", "text": (
                        "Your previous response was not valid JSON. Parse error: "
                        + last_error
                        + ". Respond again with ONLY the JSON object — no prose, "
                        "no markdown fences, no trailing commentary."
                    )}]},
                ]
    raise AiLaneError(
        "AI extraction failed at stage '%s': the model returned malformed "
        "JSON twice (last parse error: %s). No figures were persisted — "
        "retry the scan or upload a cleaner export." % (stage, last_error)
    )
