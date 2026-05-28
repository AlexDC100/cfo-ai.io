"""AI Market Read orchestrator — Phase B.

Tests the Claude-or-deterministic compose path without touching the live
Anthropic API. Key invariants:

  · System prompt contains the brief §12 strict rules
  · User prompt carries the deterministic scores INTO the LLM (no
    silent recomputation)
  · Malformed LLM output → deterministic fallback (graceful degrade)
  · No ANTHROPIC_API_KEY → automatic deterministic fallback
  · `model_id` reveals whether Opus or deterministic produced the output
"""

from __future__ import annotations

import json
import os
import pytest

from engine.public.intelligence.ai_market_read import (
    MockAIMarketReadClient,
    _parse_llm_envelope,
    _resolve_default_client,
    compose_ai_market_read,
)
from engine.public.intelligence.company_exposure_service import (
    build_company_exposure_profile,
)
from engine.public.intelligence.opportunity_scoring_engine import (
    compute_opportunity_score,
)
from engine.public.intelligence.risk_scoring_engine import compute_risk_score


_FIN = {
    "net_debt_to_ebitda": -1.5,
    "ebitda_margin": 0.60,
    "ebitda": 80_000_000_000,
    "ev_to_ebitda": 35,
    "pe_ratio": 55,
    "revenue_growth": 0.95,
    "revenue": 130_000_000_000,
    "roe": 0.85,
    "fcf_yield": 0.025,
    "market_cap": 3_000_000_000_000,
    "interest_expense": 200_000_000,
    "capex": 5_000_000_000,
}


def _nvda_inputs():
    profile = build_company_exposure_profile(
        "NVDA", "NVIDIA Corp", "Semiconductors", None
    )
    risk = compute_risk_score(profile, _FIN, [])
    opp = compute_opportunity_score(profile, _FIN, [])
    return profile, risk, opp


def test_resolve_default_client_returns_none_without_env():
    """When ANTHROPIC_API_KEY is absent, _resolve_default_client → None."""
    saved = os.environ.pop("ANTHROPIC_API_KEY", None)
    try:
        assert _resolve_default_client() is None
    finally:
        if saved is not None:
            os.environ["ANTHROPIC_API_KEY"] = saved


def test_compose_with_no_client_uses_deterministic():
    """No client + no env → deterministic fallback path."""
    saved = os.environ.pop("ANTHROPIC_API_KEY", None)
    try:
        profile, risk, opp = _nvda_inputs()
        read = compose_ai_market_read(
            ticker="NVDA",
            company_name="NVIDIA Corp",
            sector="Semiconductors",
            industry=None,
            risk=risk,
            opportunity=opp,
            exposure=profile,
            signals=[],
            feed_status="sector_model_only",
            client=None,
        )
        assert read.subject == "NVDA"
        assert "deterministic_v1" in read.model_id
        assert read.headline
        assert read.summary
        assert read.what_to_watch
    finally:
        if saved is not None:
            os.environ["ANTHROPIC_API_KEY"] = saved


def test_compose_with_mock_client_uses_llm_output():
    """A successful Mock LLM call → output uses parsed LLM JSON."""
    profile, risk, opp = _nvda_inputs()
    mock_response = json.dumps({
        "headline": "Mock test headline",
        "summary": "Mock test summary referring to sector exposure model.",
        "what_to_watch": ["Watch 1", "Watch 2", "Watch 3"],
        "confidence": 0.82,
    })
    client = MockAIMarketReadClient(response=mock_response)
    read = compose_ai_market_read(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
        risk=risk,
        opportunity=opp,
        exposure=profile,
        signals=[],
        feed_status="sector_model_only",
        client=client,
    )
    assert read.headline == "Mock test headline"
    assert read.summary == "Mock test summary referring to sector exposure model."
    assert read.what_to_watch == ["Watch 1", "Watch 2", "Watch 3"]
    assert read.confidence == 0.82
    assert read.model_id == "mock_opus"


def test_system_prompt_carries_strict_rules():
    """The §12 brief rules must reach the model."""
    profile, risk, opp = _nvda_inputs()
    client = MockAIMarketReadClient()
    compose_ai_market_read(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
        risk=risk,
        opportunity=opp,
        exposure=profile,
        signals=[],
        feed_status="sector_model_only",
        client=client,
    )
    assert len(client.calls) == 1
    system = client.calls[0]["system"]
    # Each rule from brief §12 must show up
    assert "Do NOT invent news" in system
    assert "Do NOT produce numeric scores" in system
    assert "Cite source signal IDs" in system
    assert "Identify the financial impact channel" in system


def test_user_prompt_carries_deterministic_scores():
    """The deterministic risk + opportunity scores must be in the user prompt
    so the LLM cannot silently recompute them."""
    profile, risk, opp = _nvda_inputs()
    client = MockAIMarketReadClient()
    compose_ai_market_read(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
        risk=risk,
        opportunity=opp,
        exposure=profile,
        signals=[],
        feed_status="sector_model_only",
        client=client,
    )
    user = client.calls[0]["user"]
    assert f"{risk.overall_risk_score}/100" in user
    assert f"{opp.overall_opportunity_score}/100" in user
    assert "do not override" in user.lower()


def test_malformed_llm_output_triggers_fallback():
    """If the LLM returns prose instead of JSON, deterministic fallback fires."""
    profile, risk, opp = _nvda_inputs()
    client = MockAIMarketReadClient(response="Just plain prose, no JSON at all.")
    read = compose_ai_market_read(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
        risk=risk,
        opportunity=opp,
        exposure=profile,
        signals=[],
        feed_status="sector_model_only",
        client=client,
    )
    assert "deterministic_v1" in read.model_id


def test_llm_exception_triggers_fallback():
    """A raising client triggers fallback rather than 500-ing the route."""
    class RaisingClient:
        model_id = "raises"
        def complete(self, s, u):
            raise RuntimeError("simulated network error")
    profile, risk, opp = _nvda_inputs()
    read = compose_ai_market_read(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
        risk=risk,
        opportunity=opp,
        exposure=profile,
        signals=[],
        feed_status="sector_model_only",
        client=RaisingClient(),
    )
    assert "deterministic_v1" in read.model_id


# ─── Envelope parser ─────────────────────────────────────────────────────

def test_parse_envelope_plain_json():
    assert _parse_llm_envelope('{"headline":"hi"}') == {"headline": "hi"}


def test_parse_envelope_with_code_fence():
    raw = '```json\n{"headline":"hi","summary":"yo"}\n```'
    parsed = _parse_llm_envelope(raw)
    assert parsed == {"headline": "hi", "summary": "yo"}


def test_parse_envelope_with_leading_prose():
    raw = 'Here is the read:\n{"headline":"hi"}'
    assert _parse_llm_envelope(raw) == {"headline": "hi"}


def test_parse_envelope_returns_none_on_malformed():
    assert _parse_llm_envelope("not even close") is None
    assert _parse_llm_envelope("") is None
    assert _parse_llm_envelope("{") is None
