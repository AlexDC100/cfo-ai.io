"""Claude-powered analysis layer.

The engine's rules pick WHICH SKUs to flag (deterministic, auditable). The
Claude API writes the WHY — turning facts into a business narrative the user
can act on. Per CLAUDE.md the model never makes a decision; it summarizes
decisions the engine already made.

Model: Claude Opus 4.7 — most capable model in the lineup, used for the
narrative layer that lands in front of the CFO. We use prompt caching on the
system prompt (instructions + analytical framework) so each regenerate after
the first is cheap.

Falls back to deterministic prose when ANTHROPIC_API_KEY is unset.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional


# JSON schema enforced via output_config.format on the API call. Mirrors the
# structure documented in the SYSTEM_PROMPT — the prompt remains for clarity
# but the schema is what guarantees parseable output on Opus 4.7.
_ANALYSIS_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "summary_en": {"type": "string"},
        "sku_reasons": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "sku": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["sku", "reason"],
                "additionalProperties": False,
            },
        },
        "propositions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                    "impact": {"type": "string"},
                    "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                },
                "required": ["title", "detail", "impact", "priority"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["headline", "summary_en", "sku_reasons", "propositions"],
    "additionalProperties": False,
}


SYSTEM_PROMPT = """You are an analyst for an inventory-heavy business.
You are reviewing decisions a deterministic decision engine has ALREADY made
about which SKUs to keep, eliminate, scale, or flag for review.

Your job is to translate the engine's findings into specific, actionable
recommendations. You NEVER override the engine's decisions — you explain them.

Style:
- English only.
- Direct and specific. No filler. No "may" / "might" / "could potentially".
- Use the actual SKU names and numbers given to you.
- One paragraph per major theme. Never more than 4 sentences per paragraph.
- Reference specific kEUR / volume figures from the data.

Format your response as a single JSON object with these keys:
{
  "headline": "<one sentence, ~15 words, captures the most important finding>",
  "summary_en": "<2-3 short paragraphs, English, executive-level>",
  "sku_reasons": [
    {"sku": "<exact SKU id>", "reason": "<1-2 sentences explaining why this SKU should be removed/reviewed, citing its specific numbers>"}
  ],
  "propositions": [
    {
      "title": "<imperative action verb + target>",
      "detail": "<1-2 sentences with specific numbers>",
      "impact": "<expected impact in kEUR or other concrete unit>",
      "priority": "high" | "medium" | "low"
    }
  ]
}

Constraints:
- Output ONLY valid JSON. No markdown fences. No prose before or after.
- sku_reasons must include every SKU in the candidates list.
- propositions: 4-7 items, ordered by priority then impact.
"""


def claude_analysis(
    run: Dict[str, Any],
    sku_candidates: List[Dict[str, Any]],
    api_key: Optional[str] = None,
    model: str = "claude-opus-4-7",
    max_tokens: int = 6000,
) -> Optional[Dict[str, Any]]:
    """Hit Claude and return a structured analysis. Returns None if no API key.

    The model gets the engine's daily run summary plus the top-30 SKU
    candidates (worst real margins / largest losses) and is asked to write
    per-SKU reasoning + 4-7 prioritized propositions.
    """
    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None

    try:
        from anthropic import Anthropic
    except ImportError:
        return None

    client = Anthropic(api_key=key)

    # Trim SKU candidates to the top ~30 worst — keep prompt focused.
    candidates_compact = [
        {
            "sku": s.get("sku") or s.get("id"),
            "category": s["category"],
            "volume_t": s.get("volume_t") or s.get("volume_tons"),
            "real_margin_pct": s.get("real_margin_pct"),
            "abs_profit_kron": s.get("absolute_profit_kron") or s.get("abs_profit_kron"),
            "dio_days": s.get("dio_days") or s.get("category_dio_days"),
            "category_flag": s.get("category_flag"),
            "engine_verdict": s.get("verdict"),
        }
        for s in sku_candidates[:30]
    ]

    user_prompt = (
        "Engine output:\n"
        f"```json\n{json.dumps(_run_compact(run), indent=2)}\n```\n\n"
        "Top SKU removal candidates the engine flagged (from most to least urgent):\n"
        f"```json\n{json.dumps(candidates_compact, indent=2)}\n```\n\n"
        "Write the analysis as specified."
    )

    try:
        # Opus 4.7 with effort=high — the analyst persona benefits from
        # depth-of-reasoning on the structured per-SKU narrative. The JSON
        # schema constrains the output shape so we never have to fix up
        # markdown fences or stray prose at parse time.
        resp = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=[
                {
                    "type": "text",
                    "text": SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_prompt}],
            output_config={
                "effort": "high",
                "format": {
                    "type": "json_schema",
                    "schema": _ANALYSIS_SCHEMA,
                },
            },
        )
    except Exception as e:  # noqa: BLE001 — network/auth/rate-limit all return None gracefully
        return {"_error": f"Claude call failed: {e}"}

    # Extract text content + parse JSON
    text_parts = []
    for block in resp.content:
        if getattr(block, "type", None) == "text":
            text_parts.append(block.text)
    raw = "".join(text_parts).strip()

    # The model occasionally wraps in markdown fences despite instructions
    if raw.startswith("```"):
        raw = raw.strip("`")
        # Drop optional language hint
        if "\n" in raw:
            raw = raw.split("\n", 1)[1]
        raw = raw.rsplit("```", 1)[0].strip()

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        return {"_error": f"Claude returned malformed JSON: {e}", "_raw": raw[:500]}

    return parsed


def _run_compact(run: Dict[str, Any]) -> Dict[str, Any]:
    """Trim the DailyRun payload to essentials so the prompt stays small."""
    return {
        "period": run.get("period"),
        "working_capital_M_RON": run.get("workingCapitalMRon"),
        "roic_pct": run.get("roicPct"),
        "cost_of_capital_pct": run.get("costOfCapitalPct"),
        "anchor_profit_share": run.get("anchorProfitShare"),
        "counts": {
            "anchors": len(run.get("anchors", [])),
            "anchor_alerts": len([a for a in run.get("anchors", []) if a.get("status") == "alert"]),
            "eliminate": len(run.get("eliminate", [])),
            "review": len(run.get("review", [])),
            "scale": len(run.get("scale", [])),
        },
        "anchor_alerts": [
            {"name": a["name"], "real_margin_pct": a.get("realMargin"),
             "volume_t": a.get("volumeT"), "alert_reason": a.get("alertReason")}
            for a in run.get("anchors", []) if a.get("status") == "alert"
        ],
        "category_eliminations": [
            {"name": c["name"], "real_margin_pct": c.get("realMargin"),
             "abs_profit_kron": c.get("absoluteProfit"), "reason": c.get("reason")}
            for c in run.get("eliminate", [])
        ],
        "scale_opportunities": [
            {"name": c["name"], "real_margin_pct": c.get("realMargin"),
             "abs_profit_kron": c.get("absoluteProfit")}
            for c in run.get("scale", [])
        ],
    }
