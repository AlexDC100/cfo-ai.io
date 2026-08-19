"""AI lane stage 3 — canonical statement-line classification.

Maps every extracted account onto the canonical statement-line
vocabulary — the schema_v1 leaf names that canonical_bs rows/sections
are built from (engine.canonical BS_BUCKETS + PL_BUCKETS) — plus the
special token `excluded_control` for technical/closing/memo accounts.

Per-line output: {line_id, confidence 0-1, rationale}. The LANE (not
this stage) enforces the confidence gate: < 0.85 → the account joins
the needs_review list and its balance rides in the Unclassified rows
(closing-identity machinery — value never dropped) with reason
"low_confidence_llm".

Jurisdiction knowledge:
  · HU — the Act C of 2000 chart-logic block from
    engine.country_packs.hu_hungary.classification_map (data, not a
    deterministic parser).
  · OTHER — IFRS-style guidance (statement captions, no national chart).
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from engine.canonical import BS_BUCKETS, PL_BUCKETS

from . import config
from ._client import call_strict_json
from .schemas import ClassifiedAccount, ClassifyResult, ExtractedRow

# Special vocabulary token for control/technical accounts that must stay
# OUT of the statement (HU 49x opening/closing, classes 6/7 management
# accounting, class 0 memo; IFRS suspense/clearing accounts).
EXCLUDED_CONTROL = "excluded_control"


def vocabulary() -> Dict[str, Any]:
    """line_id → CanonicalBucket for every BS + PL leaf. Built from the
    schema so the classify vocabulary can never drift from canonical_bs."""
    vocab: Dict[str, Any] = {}
    for b in list(BS_BUCKETS) + list(PL_BUCKETS):
        vocab[b.canonical_name] = b
    return vocab


def _vocabulary_block() -> str:
    lines: List[str] = ["CANONICAL LINE VOCABULARY (line_id — label — side):"]
    for b in BS_BUCKETS:
        lines.append("  %s — %s — %s" % (b.canonical_name, b.display_label, b.bucket_type.value))
    for b in PL_BUCKETS:
        lines.append("  %s — %s — %s" % (b.canonical_name, b.display_label, b.bucket_type.value))
    lines.append(
        "  %s — control/technical/closing account, keep OUT of the statement — excluded"
        % EXCLUDED_CONTROL
    )
    return "\n".join(lines)


def _jurisdiction_block(jurisdiction: str) -> str:
    if jurisdiction == "HU":
        from engine.country_packs.hu_hungary.classification_map import (
            classify_prompt_block,
        )
        return classify_prompt_block()
    return (
        "INTERNATIONAL (IFRS-style) DOCUMENT. Codes may be arbitrary — "
        "classify by the account NAME's economic meaning using IFRS "
        "statement captions (IAS 1 / IAS 7). Suspense or clearing "
        "accounts are `excluded_control`."
    )


def _system_prompt(jurisdiction: str) -> str:
    return (
        "You are a financial-statement classification engine. For EVERY "
        "account you are given, choose exactly one line_id from the "
        "canonical vocabulary below. Respond with ONLY a strict JSON "
        "object — no prose, no markdown fences — shaped as:\n"
        "{\n"
        '  "assignments": [{"code": <account code>,\n'
        '                   "line_id": <one vocabulary line_id>,\n'
        '                   "confidence": <0.0-1.0 — your calibrated confidence>,\n'
        '                   "rationale": <ONE short line>}, ...]\n'
        "}\n"
        "Rules:\n"
        "- One assignment per account; cover every account you were given.\n"
        "- Balance-sheet accounts get BS line_ids (asset/liability/equity); "
        "profit-and-loss accounts get revenue/expense line_ids.\n"
        "- Use `excluded_control` for technical, closing, clearing and "
        "memo accounts.\n"
        "- Be honest with confidence: use values below 0.85 whenever the "
        "account's meaning is not certain from its code and name — those "
        "accounts are routed to human review rather than guessed.\n\n"
        + _jurisdiction_block(jurisdiction)
        + "\n\n"
        + _vocabulary_block()
    )


def run_classify(
    rows: List[ExtractedRow],
    *,
    jurisdiction: str,
    client: Any = None,
    client_factory: Optional[Callable[[], Any]] = None,
    audit_stages: Optional[List[Dict[str, Any]]] = None,
) -> ClassifyResult:
    if client is None:
        client = (client_factory or config.default_client_factory)()
    account_lines = [
        "%s\t%s\tdebit=%s\tcredit=%s\tbalance=%s"
        % (r.code, r.label, r.debit, r.credit, r.balance)
        for r in rows
    ]
    user_text = (
        "Classify these %d accounts (code, name, closing balances):\n%s"
        % (len(rows), "\n".join(account_lines))
    )
    data = call_strict_json(
        client,
        stage="classify",
        prompt_version=config.CLASSIFY_PROMPT_VERSION,
        system=_system_prompt(jurisdiction),
        user_text=user_text,
        max_tokens=config.CLASSIFY_MAX_TOKENS,
        audit_stages=audit_stages,
    )
    assignments: Dict[str, ClassifiedAccount] = {}
    for raw in data.get("assignments") or []:
        if not isinstance(raw, dict):
            continue
        code = str(raw.get("code") or "").strip()
        if not code:
            continue
        try:
            conf = float(raw.get("confidence") or 0.0)
        except (TypeError, ValueError):
            conf = 0.0
        assignments[code] = ClassifiedAccount(
            code=code,
            line_id=str(raw.get("line_id") or "").strip(),
            confidence=max(0.0, min(1.0, conf)),
            rationale=str(raw.get("rationale") or "").strip(),
        )
    return ClassifyResult(assignments=assignments, raw=data)
