"""AI MOVEMENT REVIEW — advisory second reader over the movement
(rulaje) identity results. Role: ``movement_review``.

JURISDICTION-BLIND: the module carries no account-code literals and no
jurisdiction branches; everything the model sees comes from the
movement-checks result (engine.passes.movements) plus a capped sample of
canonical rows the CALLER selects. ADVISORY ONLY: the output is a plain
dict of flags + proposals — it never mutates rows, layers, statuses or
classifications, and nothing downstream may consume it for gating.

ENV GATE: ``AI_MOVEMENT_REVIEW=1`` (default OFF — flipping it on is a
deliberate ops action). :func:`maybe_run_movement_review` is the
integration-ready entry: returns ``None`` unless enabled, degrades to
``None`` on ANY failure (breaker open, missing registry role, missing
credentials, model error) — the honest "advisory unavailable" state, the
same failure-isolation contract as engine.ai.advisory.

CLIENT DISCIPLINE: all model interaction goes through an injectable
``client_factory`` (the ai_lane pattern — tests use scripted clients,
never the network). The default factory is breaker-guarded via
``engine.ai.breaker.guarded_client_factory(ROLE)``; the call itself uses
the shared strict-JSON helper ``engine.ai_lane._client.call_strict_json``
(one malformed-JSON retry, full per-attempt audit capture).

OUTPUT SHAPE (whitelist-projected — unknown keys from the model are
STRIPPED, never forwarded):

    {
      "schema": "movement_review_v1",
      "role": "movement_review",
      "prompt_version": "movement_review_v1",
      "generated_at": <ISO UTC>,
      "flags": [{"pattern", "explanation_en", "explanation_ro",
                 "citation"}],
      "proposals": [{"rule_kind": "movement_conditioned_classification",
                     "condition": <declarative JSON bag>,
                     "target": <line id str>,
                     "rationale", "citation"}],
      "audit": [<per-attempt ai_lane audit entries>],
    }

PROPOSAL ROUTING (documented, not built here): proposals are the same
three-state review payload as the existing calibration flow — they map
onto the ``calibration_rules`` pending→approved/rejected state machine
(engine.api.pipeline propose/approve/reject routes) with
``source="movement_review"``; an approved movement-conditioned rule then
becomes pack DATA via a new pack version, never an engine branch.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional

ROLE = "movement_review"
SCHEMA = "movement_review_v1"
PROMPT_VERSION = "movement_review_v1"
ENABLE_ENV = "AI_MOVEMENT_REVIEW"

RULE_KIND = "movement_conditioned_classification"

_FLAG_KEYS = ("pattern", "explanation_en", "explanation_ro", "citation")
_PROPOSAL_KEYS = ("rule_kind", "condition", "target", "rationale", "citation")

_MAX_FLAGS = 20
_MAX_PROPOSALS = 10
_MAX_SAMPLE_ROWS = 40
_MAX_TOKENS = 4096

_ROW_KEYS = (
    "cont", "nume_cont",
    "si_d", "si_c", "r_d", "r_c", "st_d", "st_c", "sf_d", "sf_c",
)

_SYSTEM = (
    "You are the movement_review advisor for a financial-statements "
    "engine. Input: (1) the engine's deterministic movement-identity "
    "results over a trial balance (a document-wide column-convention "
    "probe plus per-account identity findings, amounts in integer minor "
    "units), and (2) a small sample of raw rows with opening / period "
    "movement / cumulative / closing column pairs. The chart of accounts "
    "belongs to an arbitrary jurisdiction — never assume one. You are "
    "ADVISORY ONLY: you cannot change any amount, status, total or "
    "classification. Emit (a) flags describing movement patterns worth a "
    "human's attention, and (b) optional declarative rule proposals of "
    'kind "movement_conditioned_classification" whose condition is a '
    "pure-JSON predicate over the row's column pairs and whose target "
    "names a statement line. Every flag and proposal must cite the "
    "specific accounts or findings it is grounded in. Respond with ONLY "
    'the JSON object {"flags": [{"pattern": str, "explanation_en": str, '
    '"explanation_ro": str, "citation": str}], "proposals": '
    '[{"rule_kind": "movement_conditioned_classification", "condition": '
    '<json object>, "target": str, "rationale": str, "citation": str}]} '
    "— no prose. explanation_en is English; explanation_ro is the same "
    "explanation in Romanian (a display language, not a jurisdiction "
    "assumption)."
)


class MovementReviewUnavailable(Exception):
    """The advisory pass cannot run (env, breaker, registry, client or
    model failure). Callers degrade honestly; serving never blocks."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__("%s: %s" % (reason, detail) if detail else reason)
        self.reason = reason
        self.detail = detail


def enabled() -> bool:
    return os.environ.get(ENABLE_ENV, "").strip() == "1"


def default_client_factory() -> Any:
    """Breaker-guarded production factory for the movement_review role.
    Fails honestly (BreakerOpen / RegistryError / missing key) — the
    caller degrades, never fabricates."""
    from engine.ai import breaker as _breaker

    return _breaker.guarded_client_factory(ROLE)()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _compact_movement_result(movement_result: Mapping[str, Any]) -> Dict[str, Any]:
    """The deterministic result, trimmed to what the model needs."""
    out: Dict[str, Any] = {
        "schema": movement_result.get("schema"),
        "pairs_present": movement_result.get("pairs_present"),
        "convention": movement_result.get("convention"),
        "findings": movement_result.get("findings"),
        "class_signals": movement_result.get("class_signals"),
    }
    return {k: v for k, v in out.items() if v is not None}


def _compact_rows(sample_rows: Any) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for raw in list(sample_rows or [])[:_MAX_SAMPLE_ROWS]:
        if not isinstance(raw, Mapping):
            continue
        rows.append({k: raw.get(k) for k in _ROW_KEYS if k in raw})
    return rows


def _str_or_none(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _sanitize_flags(raw: Any) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        flag: Dict[str, str] = {}
        for key in _FLAG_KEYS:
            v = _str_or_none(item.get(key))
            if v is not None:
                flag[key] = v
        if flag.get("pattern") and flag.get("explanation_en"):
            out.append(flag)
        if len(out) >= _MAX_FLAGS:
            break
    return out


def _sanitize_proposals(raw: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        if item.get("rule_kind") != RULE_KIND:
            continue  # only the declared declarative kind is forwarded
        condition = item.get("condition")
        target = _str_or_none(item.get("target"))
        if not isinstance(condition, Mapping) or not condition or target is None:
            continue
        proposal: Dict[str, Any] = {
            "rule_kind": RULE_KIND,
            "condition": dict(condition),
            "target": target,
        }
        for key in ("rationale", "citation"):
            v = _str_or_none(item.get(key))
            if v is not None:
                proposal[key] = v
        out.append(proposal)
        if len(out) >= _MAX_PROPOSALS:
            break
    return out


def run_movement_review(
    movement_result: Mapping[str, Any],
    sample_rows: Any,
    *,
    client_factory: Callable[[], Any],
) -> Dict[str, Any]:
    """One advisory model pass. Pure over its inputs: reads the movement
    result + sample rows, returns the sanitized advisory dict. Raises
    :class:`MovementReviewUnavailable` on any client/model failure —
    the caller decides how to degrade. NEVER mutates its inputs."""
    import json as _json

    from engine.ai_lane._client import call_strict_json
    from engine.ai_lane.schemas import AiLaneError

    try:
        client = client_factory()
    except Exception as e:  # noqa: BLE001 — every construction failure degrades
        raise MovementReviewUnavailable("client_unavailable", str(e))

    payload = {
        "movement_checks": _compact_movement_result(movement_result or {}),
        "sample_rows": _compact_rows(sample_rows),
    }
    audit: List[Dict[str, Any]] = []
    try:
        data = call_strict_json(
            client,
            stage=ROLE,
            prompt_version=PROMPT_VERSION,
            system=_SYSTEM,
            user_text=_json.dumps(payload, ensure_ascii=True, sort_keys=True),
            max_tokens=_MAX_TOKENS,
            audit_stages=audit,
        )
    except AiLaneError as e:
        raise MovementReviewUnavailable("model_error", str(e))

    try:
        from engine.ai import breaker as _breaker

        _breaker.record(ROLE, tokens=0)
    except Exception:  # noqa: BLE001 — spend accounting must never fail the pass
        pass

    return {
        "schema": SCHEMA,
        "role": ROLE,
        "prompt_version": PROMPT_VERSION,
        "generated_at": _now_iso(),
        "flags": _sanitize_flags(data.get("flags")),
        "proposals": _sanitize_proposals(data.get("proposals")),
        "audit": audit,
    }


def maybe_run_movement_review(
    movement_result: Optional[Mapping[str, Any]],
    sample_rows: Any,
    *,
    client_factory: Optional[Callable[[], Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Env-gated, never-raising wrapper: ``None`` unless
    ``AI_MOVEMENT_REVIEW=1`` and the pass succeeds end-to-end."""
    if not enabled() or not isinstance(movement_result, Mapping):
        return None
    try:
        return run_movement_review(
            movement_result,
            sample_rows,
            client_factory=client_factory or default_client_factory,
        )
    except Exception:  # noqa: BLE001 — advisory: degrade, never break the caller
        return None
