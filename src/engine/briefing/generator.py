"""Prompt construction + briefing generation.

Hard rule: the LLM only receives PRE-COMPUTED facts. Never raw rows it could
re-classify, and never the engine's source code or thresholds. The model
narrates; it does not decide.
"""

from __future__ import annotations

from typing import Any, Dict, List


# Persona / format spec — stable across every daily run, so it's cacheable.
_SYSTEM_PROMPT = """You are the daily briefing writer for the CFO AI Decision Engine.

Your only job is to summarize the engine's pre-computed decisions for a non-technical executive (the CFO) in English. You do NOT make decisions, change classifications, or recommend anything the engine did not.

Output format (strict):
1. ONE-LINE HEADLINE — the most important fact (capital impact or biggest alert).
2. ANCHOR ALERTS — list each anchor_alert with category name, real margin %, and the recommendation.
3. ELIMINATE — list each category to eliminate, with capital freed.
4. WARNING — list categories needing attention and why (long DIO vs thin margin).
5. SCALE — categories the engine flagged for growth.
6. CLOSING — one sentence on overall ROIC vs cost of capital.

Be terse. No filler. No emojis. Use British English. Currencies as 'EUR 1.2M' or 'kEUR' as appropriate."""


def generate_briefing(
    payload: Dict[str, Any],
    client: "BriefingClient",  # type: ignore[name-defined]
    language: str = "en",
) -> str:
    """Generate the daily briefing from a daily-decisions payload.

    The `language` parameter is retained for backward compatibility but
    only English is supported. Any other value raises ValueError.
    """
    if language != "en":
        raise ValueError(
            f"Only English briefings are supported (got language={language!r})."
        )
    user = _build_user_facts(payload)
    return client.complete(system=_SYSTEM_PROMPT, user=user)


def generate_briefings_all_languages(
    payload: Dict[str, Any],
    client: "BriefingClient",  # type: ignore[name-defined]
    languages: List[str],
) -> Dict[str, str]:
    """Returns {'en': briefing}. Kept as a dict for caller compatibility."""
    return {"en": generate_briefing(payload, client, "en")}


def _build_user_facts(payload: Dict[str, Any]) -> str:
    """Turn the JSON payload into a flat list of facts the model can narrate.

    Deliberately uses plain text + numbers — no JSON. The model gets less room
    to invent structure or re-interpret fields.
    """
    s = payload.get("summary", {})
    lines: List[str] = []
    lines.append(f"Run date: {payload.get('run_date')}")
    lines.append(f"Data period: {payload.get('data_period')}")
    lines.append(
        f"Capital blocked: {s.get('capital_blocked_RON', 0):,.0f} RON; "
        f"recoverable in 30 days: {s.get('capital_recoverable_30d_RON', 0):,.0f} RON"
    )
    lines.append(
        f"ROIC: {s.get('total_roic_pct', 0)}% vs cost of capital "
        f"{s.get('cost_of_capital_pct', 0)}%"
    )
    lines.append(
        f"Counts — anchors {s.get('anchors_count', 0)} "
        f"({s.get('anchors_with_alerts', 0)} with alerts), "
        f"eliminate {s.get('eliminate_count', 0)}, "
        f"warning {s.get('warning_count', 0)}, "
        f"scale {s.get('scale_count', 0)}, "
        f"keep {s.get('keep_count', 0)}"
    )

    lines.append("")
    lines.append("ANCHOR_ALERTS (do_not_eliminate):")
    for d in payload.get("anchor_alerts", []):
        lines.append(
            f"  - {d['id']}: real_margin {d['real_margin_pct']}%, vol {d['volume_tons']}t, "
            f"reason={d.get('reason')}, rec={d.get('recommendation')}"
        )

    lines.append("")
    lines.append("ELIMINATE:")
    for d in payload.get("eliminate", []):
        cap = d.get("capital_freed_kron")
        cap_str = f"{cap:.1f} kRON freed" if cap is not None else "(no capital estimate)"
        lines.append(
            f"  - {d['id']}: real_margin {d['real_margin_pct']}%, "
            f"vol {d['volume_tons']}t, reason={d.get('reason')}, {cap_str}"
        )

    lines.append("")
    lines.append("WARNING:")
    for d in payload.get("warning", []):
        lines.append(
            f"  - {d['id']}: real_margin {d['real_margin_pct']}%, "
            f"vol {d['volume_tons']}t, dio {d['dio_days']}d, reason={d.get('reason')}"
        )

    lines.append("")
    lines.append("SCALE:")
    for d in payload.get("scale", []):
        lines.append(
            f"  - {d['id']}: real_margin {d['real_margin_pct']}%, "
            f"vol {d['volume_tons']}t, reason={d.get('reason')}"
        )

    return "\n".join(lines)
