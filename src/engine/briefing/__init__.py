"""Briefing generator — turns the daily JSON into a RO/EN narrative.

Per CLAUDE.md: Claude API ONLY writes the briefing. It NEVER makes a decision.
Inputs to the model are pre-computed facts; the model just narrates them.
"""

from .client import BriefingClient, ClaudeBriefingClient, MockBriefingClient
from .generator import generate_briefing, generate_briefings_all_languages

__all__ = [
    "BriefingClient",
    "ClaudeBriefingClient",
    "MockBriefingClient",
    "generate_briefing",
    "generate_briefings_all_languages",
]
