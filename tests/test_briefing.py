"""Briefing generator tests — mocked LLM, real prompt content."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from engine.actions import build_output
from engine.briefing import (
    MockBriefingClient,
    generate_briefing,
    generate_briefings_all_languages,
)
from engine.config import load_config
from engine.loader import load_categories_from_csv
from engine.pipeline import run_pipeline

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def payload() -> dict:
    cfg = load_config(REPO_ROOT / "config.yaml")
    rows = load_categories_from_csv(REPO_ROOT / "data" / "validation_fixture_categories.csv")
    metrics, decisions = run_pipeline(rows, cfg, period_months=10)
    return build_output(decisions, metrics, cfg, run_date=date(2026, 5, 4),
                        data_period="YTD October 2025")


def test_user_prompt_includes_macrou_alert(payload: dict) -> None:
    """The model must see Macrou in the alerts so it can narrate it."""
    client = MockBriefingClient()
    generate_briefing(payload, client, language="en")
    prompt = client.calls[0]["user"]
    assert "Macrou" in prompt
    assert "high_volume_anchor_below_floor" in prompt


def test_user_prompt_includes_eliminate_list(payload: dict) -> None:
    client = MockBriefingClient()
    generate_briefing(payload, client, language="en")
    prompt = client.calls[0]["user"]
    # Pastrav and Plachie reclassified to KEEP under niche-margin protection;
    # Calamar (real margin -92.7%) is the only ELIMINATE in the prompt.
    assert "Calamar" in prompt


def test_user_prompt_includes_capital_facts(payload: dict) -> None:
    client = MockBriefingClient()
    generate_briefing(payload, client, language="en")
    prompt = client.calls[0]["user"]
    assert "Capital blocked" in prompt
    assert "ROIC" in prompt
    assert "cost of capital 6.5" in prompt


def test_system_prompt_constrains_decisions(payload: dict) -> None:
    """Critical: the system prompt must say 'do NOT make decisions'."""
    client = MockBriefingClient()
    generate_briefing(payload, client, language="en")
    sys_prompt = client.calls[0]["system"]
    assert "do NOT make decisions" in sys_prompt or "not make decisions" in sys_prompt.lower()


def test_non_english_language_raises(payload: dict) -> None:
    """Briefing module is English-only; any other language should error."""
    client = MockBriefingClient()
    with pytest.raises(ValueError, match="Only English"):
        generate_briefing(payload, client, language="ro")
    with pytest.raises(ValueError, match="Only English"):
        generate_briefing(payload, client, language="fr")


def test_generate_all_languages_returns_english_only(payload: dict) -> None:
    """The wrapper used to fan out per language; now it always returns {'en'}."""
    client = MockBriefingClient(response="(test response)")
    out = generate_briefings_all_languages(payload, client, languages=["en", "ro"])
    assert set(out.keys()) == {"en"}
    assert out["en"] == "(test response)"
    assert len(client.calls) == 1


def test_briefing_returns_client_response(payload: dict) -> None:
    client = MockBriefingClient(response="HEADLINE: capital blocked 9.3M RON.")
    out = generate_briefing(payload, client, language="en")
    assert out == "HEADLINE: capital blocked 9.3M RON."
