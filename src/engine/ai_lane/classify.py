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

PROMPT-FROM-PACK (Phase 4): the jurisdiction knowledge is DATA, not
code. The classification vocabulary (statement-map leaves, labels,
document order), the chart-logic class map, the notable-account lines
(base exact rules + any human-confirmed overlay from
confirmed_mappings.yaml) and the guidance prose all render from the
resolved CompiledPack:

  · HU    — packs/hu/actc2000-v1 (Act C of 2000 számlatükör logic,
            ported from the deleted classification_map module — frozen
            snapshot in scripts/port_hu_pack.py)
  · OTHER — packs/intl/ifrs-captions-v1 (IFRS-caption guidance)

and the stage's prompt_version derives from the pack content hash
(engine.ai_lane.config.classify_prompt_version), so a pack edit —
including adding a confirmed mapping — re-versions the prompt and
invalidates the AI cache automatically.

Statement SIDE stays schema-owned: each leaf's asset/liability/equity/
revenue/expense/memo annotation (and the envelope's placement math in
engine.ai_lane.build_ai_envelope) reads engine.canonical BucketType —
placement logic, not jurisdiction data (the same split the RO cutover
drew around its engine-side placement tables). Pack leaves and the
schema are pinned 1:1 by tests/engine/test_hu_pack.py, and an unknown
leaf fails the render loudly.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from engine.canonical import BS_BUCKETS, PL_BUCKETS
from engine.packs.schema import CompiledPack, StatementNode

from . import config
from ._client import call_strict_json
from .schemas import AiLaneError, ClassifiedAccount, ClassifyResult, ExtractedRow

# Special vocabulary token for control/technical accounts that must stay
# OUT of the statement (HU 49x opening/closing, classes 6/7 management
# accounting, class 0 memo; IFRS suspense/clearing accounts).
EXCLUDED_CONTROL = "excluded_control"

#: Statement-map section id whose leaves are the excluded vocabulary —
#: they render LAST in the prompt with side "excluded" and are never
#: summed into any statement total.
EXCLUDED_SECTION_ID = "excluded"


def vocabulary() -> Dict[str, Any]:
    """line_id → CanonicalBucket for every BS + PL leaf. Built from the
    schema so the classify vocabulary can never drift from canonical_bs."""
    vocab: Dict[str, Any] = {}
    for b in list(BS_BUCKETS) + list(PL_BUCKETS):
        vocab[b.canonical_name] = b
    return vocab


def _walk_leaves(nodes, out: List[StatementNode]) -> None:
    for node in nodes:
        if node.is_leaf:
            out.append(node)
        else:
            _walk_leaves(node.children, out)


def _vocabulary_block(pack: CompiledPack) -> str:
    """The CANONICAL LINE VOCABULARY prompt block, rendered from the
    pack's statement map: leaves in document order with their pack
    labels; leaves under the `excluded` section render last with side
    "excluded"; every other leaf's side is its schema BucketType. A pack
    leaf the schema does not know is a hard error — the vocabulary must
    never silently diverge from what build_ai_envelope can place."""
    side_by_id = {
        b.canonical_name: b.bucket_type.value
        for b in list(BS_BUCKETS) + list(PL_BUCKETS)
    }
    lines: List[str] = ["CANONICAL LINE VOCABULARY (line_id — label — side):"]
    excluded: List[StatementNode] = []
    for tree in (pack.balance_sheet, pack.profit_loss):
        for section in tree:
            leaves: List[StatementNode] = []
            _walk_leaves((section,), leaves)
            if section.id == EXCLUDED_SECTION_ID:
                excluded.extend(leaves)
                continue
            for leaf in leaves:
                side = side_by_id.get(leaf.id)
                if side is None:
                    raise AiLaneError(
                        "classification pack %s@%s carries statement leaf %r "
                        "that is not in the canonical schema — the classify "
                        "vocabulary cannot include lines the envelope builder "
                        "cannot place." % (
                            pack.identity.pack_id, pack.identity.version,
                            leaf.id,
                        )
                    )
                lines.append("  %s — %s — %s" % (leaf.id, leaf.label, side))
    for leaf in excluded:
        lines.append("  %s — %s — excluded" % (leaf.id, leaf.label))
    return "\n".join(lines)


def _guidance_block(pack: CompiledPack) -> str:
    """The jurisdiction chart-logic prompt block, rendered from the
    pack's prompt_guidance + its exact rules:

        <header prose>
        [  class <digit> — <name>: <guidance>   per class_map entry]
        [Notable accounts:
           <code> = <description>               per exact rule, sorted]
        [<footer prose>]

    Exact rules include any confirmed_mappings.yaml overlay entries
    (rule_id "confirmed.<code>") — a human confirmation feeds the next
    prompt, and because it changes pack_hash it also re-versions the
    prompt and invalidates the cache."""
    guidance = pack.prompt_guidance
    if guidance is None:
        raise AiLaneError(
            "classification pack %s@%s has no prompt_guidance — an LLM-driven "
            "jurisdiction pack must carry its prompt data."
            % (pack.identity.pack_id, pack.identity.version)
        )
    lines: List[str] = [guidance["header"]]
    for entry in guidance.get("class_map") or ():
        lines.append(
            "  class %s — %s: %s"
            % (entry["digit"], entry["name"], entry["guidance"])
        )
    exact_rules = sorted(
        (r for r in pack.rules if r.kind == "exact"),
        key=lambda r: r.exact or "",
    )
    if exact_rules:
        lines.append("Notable accounts:")
        for rule in exact_rules:
            lines.append("  %s = %s" % (rule.exact, rule.description))
    footer = guidance.get("footer")
    if footer:
        lines.append(footer)
    return "\n".join(lines)


def _system_prompt(pack: CompiledPack) -> str:
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
        + _guidance_block(pack)
        + "\n\n"
        + _vocabulary_block(pack)
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
    # ONE pack resolve per run: the prompt text and the prompt_version
    # recorded beside it must come from the SAME pack content.
    pack = config.classify_pack(jurisdiction)
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
        prompt_version=config.classify_prompt_version_for(pack),
        system=_system_prompt(pack),
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
