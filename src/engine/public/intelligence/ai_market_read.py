"""Claude Opus orchestrator for the per-ticker AI Market Read.

Per brief §12: "Use Claude / Opus for interpretation only. AI can interpret
and explain." Per brief §10: "Do not let AI produce the numeric score
alone." This module respects both: it takes the deterministic risk score +
opportunity score + sector exposure profile + signal IDs as INPUT and
produces narrative + watch-list as OUTPUT. It never computes any number.

Prompt rules (per brief §12):
  · No invented facts
  · Cite source signal IDs (we pass them in via the prompt; the model
    must reference them by ID, not name)
  · Separate verified from inferred
  · State confidence
  · Identify financial impact channel

Architecture invariants:
  · The Anthropic SDK import is LAZY — the module imports clean without
    `anthropic` installed (test_risk_scoring_engine.py asserts no network
    deps at import time for the scoring engine; ai_market_read mirrors that
    pattern via lazy import).
  · When ANTHROPIC_API_KEY is missing OR the call fails, the orchestrator
    falls back to the deterministic narrative so the FE always renders
    something. The fallback is the SAME shape as the Opus output.
  · A `MockAIMarketReadClient` lives here so tests don't need the SDK or
    a key — mirrors briefing/client.py's two-impl Protocol pattern.

Output shape: AIMarketRead dataclass from models.py. Same shape regardless
of whether Opus or the deterministic fallback produced it; only `model_id`
and `confidence` differ.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional, Protocol

from .models import (
    AIMarketRead,
    CompanyExposureProfile,
    IntelligenceSignal,
    OpportunityItem,
    PublicCompanyOpportunityScore,
    PublicCompanyRiskScore,
    RiskItem,
)

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────
# Protocol — keeps the orchestrator decoupled from anthropic SDK details
# so tests don't need a live key and the rest of the engine never imports
# anthropic directly.
# ─────────────────────────────────────────────────────────────────────────

class AIMarketReadClient(Protocol):
    """Single one-shot completion: system + user prompt → response text."""

    model_id: str

    def complete(self, system: str, user: str) -> str: ...


# ─────────────────────────────────────────────────────────────────────────
# Real Claude Opus client
# ─────────────────────────────────────────────────────────────────────────

class ClaudeMarketReadClient:
    """Real Anthropic API client — Claude Opus 4.7 by default.

    System prompt is marked for prompt caching so a session that
    generates reads for multiple tickers pays the cache write once.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "claude-opus-4-7",
        max_tokens: int = 1500,
    ):
        # Lazy SDK import — module loads without anthropic installed.
        from anthropic import Anthropic

        resolved_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not resolved_key:
            raise RuntimeError(
                "ClaudeMarketReadClient requires ANTHROPIC_API_KEY. "
                "Fall back to MockAIMarketReadClient or the deterministic "
                "orchestrator path when the env is missing."
            )
        self._client = Anthropic(api_key=resolved_key)
        self.model_id = model
        self._max_tokens = max_tokens

    def complete(self, system: str, user: str) -> str:
        # Adaptive thinking — per claude-api skill default. Claude decides
        # how much to think; we don't preset a budget. xhigh effort because
        # the read is a synthesis task across many signals — not a deep
        # reasoning task but more demanding than a summary.
        resp = self._client.messages.create(
            model=self.model_id,
            max_tokens=self._max_tokens,
            system=[
                {
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user}],
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
        )
        parts: list[str] = []
        for block in resp.content:
            if getattr(block, "type", None) == "text":
                parts.append(block.text)
        return "".join(parts).strip()


# ─────────────────────────────────────────────────────────────────────────
# Mock client — for tests + dry runs
# ─────────────────────────────────────────────────────────────────────────

class MockAIMarketReadClient:
    """Canned response. Tests can pass a fixed string + assert on the
    prompts the orchestrator sent in via .calls."""

    model_id = "mock_opus"

    def __init__(self, response: Optional[str] = None):
        self._response = response
        self.calls: list[dict[str, str]] = []

    def complete(self, system: str, user: str) -> str:
        self.calls.append({"system": system, "user": user})
        if self._response is not None:
            return self._response
        # Default canned response is a valid JSON envelope so the parser
        # doesn't choke on test runs that don't override.
        return json.dumps({
            "headline": "Mock headline — deterministic fixture",
            "summary": "Mock summary for tests. References sector exposure model.",
            "what_to_watch": [
                "Mock watch item 1",
                "Mock watch item 2",
            ],
            "confidence": 0.7,
        })


# ─────────────────────────────────────────────────────────────────────────
# Prompts
# ─────────────────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """You are CFO AI's Market Read analyst. Your job is to take a deterministic risk score + opportunity score + sector exposure profile for one public company and produce a 2-4 sentence interpretation of what could change the numbers in the next 12 months.

STRICT RULES — these are non-negotiable:
1. Do NOT invent news. Every claim must be traceable to the inputs you're given (sector exposure, financial snapshot, signal IDs).
2. Do NOT produce numeric scores. The risk score is computed deterministically and given to you. You may reference it but never override it.
3. State confidence honestly. If the inputs are thin (sector_model only, no live signals), say so.
4. Identify the financial impact channel for each risk/opportunity you highlight (e.g. "would compress EBITDA margin", "puts capex at risk").
5. Cite source signal IDs in [brackets] when referencing a specific signal. If no signals provided, do not invent any.
6. When the feed_status is "sector_model_only" or "no_provider_configured", explicitly note that the analysis uses sector exposure modeling without live news input.

OUTPUT FORMAT — return ONLY valid JSON with this exact shape, no markdown fences:
{
  "headline": "1 sentence — what's the punchline?",
  "summary": "2-4 sentences — the actual interpretation.",
  "what_to_watch": ["item 1", "item 2", "item 3 (3-5 items total)"],
  "confidence": 0.0 to 1.0
}

The deterministic score is YOUR INPUT, not your output. Your job is interpretation."""


def _build_user_prompt(
    *,
    ticker: str,
    company_name: str,
    sector: str,
    industry: Optional[str],
    risk: PublicCompanyRiskScore,
    opportunity: PublicCompanyOpportunityScore,
    exposure: CompanyExposureProfile,
    signals: list[IntelligenceSignal],
    feed_status: str,
) -> str:
    """Assemble the per-ticker user prompt.

    The structure is dense + machine-parseable; the model reads it as
    structured facts rather than prose, which keeps the output grounded.
    """
    lines = [
        f"# {ticker} — {company_name}",
        f"Sector: {sector}",
        f"Industry: {industry or '(unspecified)'}",
        f"Exposure source: {exposure.source}  (confidence {exposure.confidence:.2f})",
        f"Feed status: {feed_status}",
        "",
        "## Deterministic scores (do not override)",
        f"- Risk:        {risk.overall_risk_score}/100  ({risk.risk_level})",
        f"- Opportunity: {opportunity.overall_opportunity_score}/100  ({opportunity.strength_level})",
        "",
        "## Risk category breakdown",
        f"- Macro:        {risk.categories.macro}/100",
        f"- Supply chain: {risk.categories.supply_chain}/100",
        f"- Geopolitical: {risk.categories.geopolitical}/100",
        f"- Financial:    {risk.categories.financial}/100",
        f"- Valuation:    {risk.categories.valuation}/100",
        f"- Operational:  {risk.categories.operational}/100",
        f"- Regulatory:   {risk.categories.regulatory}/100",
        "",
        "## Top deterministic risks",
    ]
    for r in risk.top_risks:
        sigs = f"  signal IDs: {r.source_signal_ids}" if r.source_signal_ids else ""
        lines.append(f"- [{r.severity}] {r.label} (channels: {', '.join(r.channels) or 'n/a'}){sigs}")

    lines.append("")
    lines.append("## Top deterministic opportunities")
    for o in opportunity.top_opportunities:
        lines.append(f"- [{o.strength}] {o.label} (channels: {', '.join(o.channels) or 'n/a'})")

    lines.append("")
    lines.append("## Geographic exposure")
    for geo, weight in sorted(exposure.geographic_exposure.items(), key=lambda x: -x[1])[:5]:
        lines.append(f"- {geo}: {weight:.0%}")

    if signals:
        lines.append("")
        lines.append("## Available macro signals tied to this ticker")
        for s in signals[:6]:
            lines.append(f"- [{s.id}] {s.title} ({s.severity}, src={s.source})")

    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────
# Orchestrator
# ─────────────────────────────────────────────────────────────────────────

def compose_ai_market_read(
    *,
    ticker: str,
    company_name: str,
    sector: str,
    industry: Optional[str],
    risk: PublicCompanyRiskScore,
    opportunity: PublicCompanyOpportunityScore,
    exposure: CompanyExposureProfile,
    signals: list[IntelligenceSignal],
    feed_status: str,
    client: Optional[AIMarketReadClient] = None,
) -> AIMarketRead:
    """Produce an AIMarketRead via Claude Opus, falling back to deterministic
    template on any failure.

    Resolution:
      1. If `client` passed in → use it (test injection point).
      2. ANTHROPIC_API_KEY set → build ClaudeMarketReadClient.
      3. Otherwise → return deterministic narrative (Phase A path).
    """
    # Pick a client.
    if client is None:
        client = _resolve_default_client()

    if client is None:
        return _deterministic_fallback(
            ticker=ticker, risk=risk, opportunity=opportunity,
            exposure=exposure, signals=signals, feed_status=feed_status,
            reason="ANTHROPIC_API_KEY not set",
        )

    # Build prompts + call.
    user = _build_user_prompt(
        ticker=ticker, company_name=company_name, sector=sector, industry=industry,
        risk=risk, opportunity=opportunity, exposure=exposure,
        signals=signals, feed_status=feed_status,
    )
    try:
        raw = client.complete(_SYSTEM_PROMPT, user)
    except Exception as e:
        logger.warning("AI Market Read LLM call failed for %s: %s", ticker, e)
        return _deterministic_fallback(
            ticker=ticker, risk=risk, opportunity=opportunity,
            exposure=exposure, signals=signals, feed_status=feed_status,
            reason=f"LLM call failed: {e.__class__.__name__}",
        )

    # Parse the LLM JSON envelope. Falls back to deterministic if it's
    # malformed — defense against an off-spec response.
    parsed = _parse_llm_envelope(raw)
    if parsed is None:
        logger.warning("AI Market Read JSON parse failed for %s; raw=%r", ticker, raw[:300])
        return _deterministic_fallback(
            ticker=ticker, risk=risk, opportunity=opportunity,
            exposure=exposure, signals=signals, feed_status=feed_status,
            reason="LLM returned malformed JSON",
        )

    return AIMarketRead(
        subject=ticker,
        subject_kind="ticker",
        headline=parsed.get("headline", "")[:280],
        summary=parsed.get("summary", "")[:1500],
        top_risks=list(risk.top_risks),
        top_opportunities=list(opportunity.top_opportunities),
        what_to_watch=list(parsed.get("what_to_watch", []))[:6],
        confidence=float(parsed.get("confidence", exposure.confidence)),
        model_id=client.model_id,
        source_signal_ids=[s.id for s in signals[:10]],
        feed_status=feed_status,                              # type: ignore[arg-type]
        computed_at=datetime.now(timezone.utc),
    )


def _resolve_default_client() -> Optional[AIMarketReadClient]:
    """Pick the production client if env is set, else None.

    Returning None → caller uses the deterministic fallback. This is the
    "works without external providers" Phase A behavior preserved when
    Phase B Anthropic key isn't configured.
    """
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        return ClaudeMarketReadClient()
    except Exception as e:
        logger.warning("Failed to build ClaudeMarketReadClient: %s", e)
        return None


def _parse_llm_envelope(raw: str) -> Optional[dict[str, Any]]:
    """Extract the JSON envelope from the LLM response.

    Tolerates: ```json fences, leading prose ("Here is the analysis:..."),
    and trailing whitespace. Returns None on any structural failure so the
    caller can fall back gracefully.
    """
    if not raw:
        return None
    text = raw.strip()
    # Strip ```json ... ``` fences if present.
    if text.startswith("```"):
        # Find the first newline + last ``` and slice between
        first_newline = text.find("\n")
        if first_newline != -1:
            text = text[first_newline + 1:]
        if text.endswith("```"):
            text = text[: -3].rstrip()
    # Try to locate the JSON object boundary if there's leading prose.
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        return json.loads(text[start: end + 1])
    except json.JSONDecodeError:
        return None


def _deterministic_fallback(
    *,
    ticker: str,
    risk: PublicCompanyRiskScore,
    opportunity: PublicCompanyOpportunityScore,
    exposure: CompanyExposureProfile,
    signals: list[IntelligenceSignal],
    feed_status: str,
    reason: str,
) -> AIMarketRead:
    """Identical-shape AIMarketRead built without any LLM call.

    Used when ANTHROPIC_API_KEY isn't set, when the SDK call fails, or
    when the LLM returns malformed output. The FE renders it the same
    way the Opus output renders; only `model_id` reveals the source.
    """
    headline = (
        f"{ticker} composite risk {risk.overall_risk_score}/100 "
        f"({risk.risk_level}), opportunity {opportunity.overall_opportunity_score}/100 "
        f"({opportunity.strength_level})."
    )
    summary_parts = [risk.explanation]
    if exposure.source == "sector_model":
        summary_parts.append(
            "Analysis uses the sector exposure model — live news feed is not configured."
        )
    summary = " ".join(summary_parts)

    watch: list[str] = []
    if risk.top_risks:
        watch.append(f"Watch {risk.top_risks[0].label} — {risk.top_risks[0].severity} severity.")
    if risk.categories.financial >= 60:
        watch.append("Watch upcoming refinancings + interest coverage trend.")
    if risk.categories.supply_chain >= 60:
        watch.append("Watch shipping cost + supplier concentration disclosures.")
    if risk.categories.geopolitical >= 60:
        watch.append("Watch regional revenue exposure breakdown in next 10-K.")
    if risk.categories.valuation >= 60:
        watch.append("Watch peer-relative valuation — multiple compression risk.")
    if not watch:
        watch.append("No specific watch flags — score is composite-low.")

    return AIMarketRead(
        subject=ticker,
        subject_kind="ticker",
        headline=headline,
        summary=summary,
        top_risks=list(risk.top_risks),
        top_opportunities=list(opportunity.top_opportunities),
        what_to_watch=watch,
        confidence=exposure.confidence,
        model_id=f"deterministic_v1 ({reason})",
        source_signal_ids=[s.id for s in signals[:10]],
        feed_status=feed_status,                              # type: ignore[arg-type]
        computed_at=datetime.now(timezone.utc),
    )
