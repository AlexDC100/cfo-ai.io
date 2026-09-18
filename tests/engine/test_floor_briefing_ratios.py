"""Floor-substitute fixes, batch C3 / group C4 — the AI briefing's citable
ratio block (owner ruling R-OTHER, 2026-09-15).

What this file reds on AFTER the repair (TC-11), beside the plant that
proved it (TC-2 — plant log in docs/engine_book/gates.md, `floor-valuation`):

* briefing — reds if a zero / absent revenue or EBITDA reaches the model
  as a number the numeral guard would let it cite.
"""
from __future__ import annotations

import copy
import sys
import types
from pathlib import Path
from typing import Any, Dict

import pytest

from engine.ai import numerals
from engine.api import pipeline as P

import test_rebuild_net_income_anchor as ANCHOR

REPO = Path(__file__).resolve().parents[2]

# ── AI briefing ratios (C4) ─────────────────────────────────────────────


@pytest.mark.parametrize("pl,bs,expect_none", [
    ({"operating_ebitda": 0.0, "total_operating_revenue": 1_000.0, "net_income_statutory": 1.0},
     {"total_debt": 2_000_000.0, "cash": 0.0}, ["debt_to_ebitda"]),
    ({"operating_ebitda": -120_000.0, "total_operating_revenue": 0.0, "net_income_statutory": -150_000.0},
     {"total_debt": 0.0, "cash": 0.0}, ["ebitda_margin_pct", "net_margin_pct", "debt_to_ebitda"]),
    ({}, {"total_debt": 2_000_000.0, "cash": 0.0}, ["ebitda_margin_pct", "net_margin_pct", "debt_to_ebitda"]),
])
def test_briefing_ratios_refuse_instead_of_substituting(pl, bs, expect_none):
    """Measured before the fix: debt 2,000,000 over EBITDA 0 served
    RatioFact 2e15 (multiple); revenue 0 served both margins at 0.00%."""
    ratios, refusals = P._briefing_ratios(pl, bs, 1_000_000.0)
    for key in expect_none:
        assert ratios[key] is None and refusals[key]
    facts = numerals.facts_from_briefing({"ratios": ratios}, "RON")
    for key in expect_none:
        assert facts["ratios.%s" % key].value is None


def test_briefing_ratios_on_a_measured_book_are_unchanged():
    ratios, refusals = P._briefing_ratios(
        {"operating_ebitda": 54_443_834.0, "total_operating_revenue": 413_727_560.0,
         "net_income_statutory": 36_787_353.0},
        {"total_debt": 55_345_982.91, "cash": 6_104_815.29}, 149_632_161.65)
    assert refusals == {}
    assert ratios == {"ebitda_margin_pct": 13.16, "net_margin_pct": 8.89, "debt_to_ebitda": 1.02,
                      "debt_to_equity": 0.37, "net_debt": 49_241_167.62}


def test_stage_narrate_hands_the_model_refusals_not_fabricated_ratios(monkeypatch):
    """The REAL stage_narrate on corpus imbalance_03pct (no revenue, no
    EBITDA), with a stub client that only captures the payload — no network,
    no paid call. The ratios the numeral guard types must be uncitable."""
    captured: Dict[str, Any] = {}

    class _Messages:
        def create(self, **kwargs):
            captured.update(kwargs)
            raise RuntimeError("stub: payload captured")

    class _Anthropic:
        def __init__(self, **_kw):
            self.messages = _Messages()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-not-a-key")
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=_Anthropic))
    bk = ANCHOR._Book(REPO / "corpus" / "imbalance_03pct")
    out = P.stage_narrate(bk.doc, copy.deepcopy(bk.persist_assembled), [],
                          {"industry_key": "generic"}, period_id="p-test", parsed=bk.parsed)
    assert out["briefing"] == "[NARRATIVE_UNAVAILABLE]"
    import json as _json
    payload = _json.loads(captured["messages"][0]["content"])
    facts = payload["briefing_facts"]
    for key in ("ebitda_margin_pct", "net_margin_pct", "debt_to_ebitda"):
        assert facts["ratios"][key] is None, (key, facts["ratios"][key])
        assert facts["ratio_refusals"][key]
    typed = numerals.facts_from_briefing(facts, "RON")
    assert typed["ratios.debt_to_ebitda"].value is None
