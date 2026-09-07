"""R3 — THE AI WRITES THE EXPLANATION, NEVER THE NUMBER.

The insight layer's detection, its figures, its severity and its ranking
are deterministic. Exactly two fields per insight are model-authored: the
WHY-THIS-MATTERS paragraph and the SO-WHAT. This gate proves a model
cannot get a numeral past them.

It does NOT install a second guard. `engine.ai.numerals` already refuses
model-authored digits with typed facts and a deterministic fallback, and
`engine.insights.narrative` calls it — in `enforce`, unconditionally,
because this channel was specified in placeholder form from its first
line and has no legacy prompts to protect.

WHAT THIS GATE REDS ON, after the repair (TC-11):
  · a bare numeral in a model draft reaching the served block (R3, the
    plant);
  · a placeholder naming a fact the engine did not author, or naming one
    whose value is ABSENT — an absent fact must never render as 0;
  · a currency code written into the model's own prose rather than
    carried by a money fact;
  · half a refused draft surviving beside half a template — the refusal
    replaces BOTH paragraphs or the card reads as one voice with one
    unverified half;
  · the default build calling a model at all (`drafter=None` must produce
    the deterministic template, so every other gate stays a pure
    function of the book).

WHAT IT CANNOT SEE (TC-11): whether the model's accepted prose is any
GOOD — specificity scoring lives in `engine.ai.finding_sharpen`'s
adversarial pass and is not wired into this lane yet. It cannot see a
model asserting a false CLAIM in words with no digits in it ("materially
worse than last year"); the guard is a numeral guard, not a truth oracle.
It does not make a network call and never will — the drafter is injected.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, Optional

import pytest

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
sys.path.insert(0, str(REPO / "src"))

from engine.insights import build_insights  # noqa: E402


def _book(name: str = "agras") -> Dict[str, Any]:
    return json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text())


def _insight(block: Dict[str, Any], detector_id: str) -> Dict[str, Any]:
    for i in block["insights"]:
        if i["id"] == detector_id:
            return i
    raise AssertionError("%s did not fire" % detector_id)


# ── the default: no model, no network, deterministic prose ────────────


def test_the_default_build_invokes_no_model_and_says_so():
    block = build_insights(_book())
    for insight in block["insights"]:
        narrative = insight["narrative"]
        assert narrative["source"] == "deterministic", insight["id"]
        assert narrative["reason"], insight["id"]
        assert narrative["explanation"], insight["id"]
        assert narrative["so_what"], insight["id"]


def test_the_deterministic_so_what_is_advice_not_an_apology():
    """The fallback ships to real readers whenever the lane is off or a
    draft is refused, so it has to stand on its own."""
    block = build_insights(_book())
    for insight in block["insights"]:
        so_what = insight["narrative"]["so_what"]
        assert len(so_what.split()) >= 15, (insight["id"], so_what)
        assert "unavailable" not in so_what.lower(), insight["id"]


# ── R3: THE PLANT ─────────────────────────────────────────────────────


def _drafter_writing_a_bare_numeral(_detector_id: str, _view: Dict[str, Any]):
    """A model that does what models do: writes a figure it invented."""
    return {
        "explanation": (
            "This asset base is 70.4% depreciated, which is 12 points worse "
            "than the sector."
        ),
        "so_what": "Budget about 4 years of replacement capex.",
    }


def test_a_model_authored_numeral_is_refused_and_the_template_is_served():
    block = build_insights(_book(), drafter=_drafter_writing_a_bare_numeral)
    for insight in block["insights"]:
        narrative = insight["narrative"]
        assert narrative["source"] == "deterministic", (
            "%s served model prose containing a numeral the engine never "
            "authored: %r" % (insight["id"], narrative["explanation"])
        )
        assert "numeral guard" in (narrative["reason"] or ""), narrative
        assert "12 points worse than the sector" not in (
            narrative["explanation"] or ""
        )


def test_the_refusal_names_the_rejection_code_it_fired_on():
    block = build_insights(_book(), drafter=_drafter_writing_a_bare_numeral)
    reason = _insight(block, "asset_age")["narrative"]["reason"]
    assert "bare_numeral" in reason, reason


# ── the accepted path: placeholders only ──────────────────────────────


def _drafter_using_placeholders(_detector_id: str, view: Dict[str, Any]):
    """A model doing it right: it names figures by placeholder and lets
    the engine render them."""
    present = [v["placeholder"] for v in view["vocabulary"] if v["present"]]
    first = present[0] if present else ""
    return {
        "explanation": "The figure that matters here is %s." % first,
        "so_what": "Ask the finance team for the supporting schedule.",
    }


def test_a_draft_that_only_names_placeholders_is_accepted_and_rendered():
    block = build_insights(_book(), drafter=_drafter_using_placeholders)
    accepted = [i for i in block["insights"]
                if i["narrative"]["source"] == "ai"]
    assert accepted, "no draft survived the guard at all"
    for insight in accepted:
        text = insight["narrative"]["explanation"]
        assert "{" not in text, text
        assert "The figure that matters here is" in text


def test_an_accepted_draft_renders_the_engines_own_figure_not_the_models():
    block = build_insights(_book(), drafter=_drafter_using_placeholders)
    insight = _insight(block, "asset_age")
    if insight["narrative"]["source"] != "ai":
        pytest.skip("asset_age's first placeholder is absent on this book")
    # The first present measure on asset_age is the depreciated share.
    assert "70.4%" in insight["narrative"]["explanation"], insight["narrative"]


def test_the_env_var_cannot_disarm_this_channel(monkeypatch):
    """`AI_NUMERAL_GUARD=off` turns the SHARED guard into a passthrough.

    It must not turn this channel into one. This module reads
    `GuardResult.accepted` and substitutes the template itself rather
    than serving `result.text`, so a refused draft has no path to a
    reader regardless of how the environment is set. Found by planting:
    downgrading the mode argument reds nothing, which meant the mode was
    never what was holding the line."""
    for mode in ("off", "observe", "enforce", "nonsense"):
        monkeypatch.setenv("AI_NUMERAL_GUARD", mode)
        block = build_insights(_book(),
                               drafter=_drafter_writing_a_bare_numeral)
        for insight in block["insights"]:
            assert insight["narrative"]["source"] == "deterministic", (
                "AI_NUMERAL_GUARD=%s let a model numeral through on %s"
                % (mode, insight["id"])
            )
            assert "12 points worse" not in (
                insight["narrative"]["explanation"] or ""
            )


# ── the ways a draft must still be refused ────────────────────────────


def _drafter_naming_an_unknown_fact(_detector_id: str, _view: Dict[str, Any]):
    return {"explanation": "It is {sector_median} that matters.",
            "so_what": "Compare with peers."}


def test_a_placeholder_the_engine_never_authored_is_refused():
    block = build_insights(_book(), drafter=_drafter_naming_an_unknown_fact)
    for insight in block["insights"]:
        assert insight["narrative"]["source"] == "deterministic", insight["id"]
        assert "unresolved_placeholder" in insight["narrative"]["reason"], (
            insight["narrative"]["reason"]
        )


def _drafter_naming_an_absent_fact(_detector_id: str, view: Dict[str, Any]):
    absent = [v["placeholder"] for v in view["vocabulary"] if not v["present"]]
    if not absent:
        return {"explanation": "Nothing absent here.", "so_what": "Proceed."}
    return {"explanation": "The gap is %s." % absent[0],
            "so_what": "Chase the missing input."}


def test_a_placeholder_naming_an_absent_fact_is_refused_not_rendered_as_zero():
    """ABSENT != ZERO, at the narrative boundary. On the realestate book
    `trade_float` cannot compute DPO — cost of goods sold is nil — and a
    model naming that measure must be refused, never handed a 0."""
    block = build_insights(_book("realestate"),
                           drafter=_drafter_naming_an_absent_fact)
    insight = _insight(block, "trade_float")
    assert insight["narrative"]["source"] == "deterministic"
    assert "absent_fact" in insight["narrative"]["reason"], (
        insight["narrative"]["reason"]
    )


def _drafter_writing_a_currency_code(_detector_id: str, _view: Dict[str, Any]):
    return {"explanation": "The exposure is large in RON terms.",
            "so_what": "Review it."}


def test_a_currency_code_in_the_models_own_prose_is_refused():
    """The 461 lesson: a currency label belongs to the fact, never to the
    prose around it."""
    block = build_insights(_book(), drafter=_drafter_writing_a_currency_code)
    for insight in block["insights"]:
        assert insight["narrative"]["source"] == "deterministic", insight["id"]
        assert "loose_currency_label" in insight["narrative"]["reason"]


def _drafter_with_one_clean_half(_detector_id: str, view: Dict[str, Any]):
    present = [v["placeholder"] for v in view["vocabulary"] if v["present"]]
    return {
        "explanation": "The figure is %s." % (present[0] if present else ""),
        "so_what": "Expect this to cost 2 million next year.",
    }


def test_one_refused_half_refuses_the_whole_narrative():
    """Half a model paragraph beside half a template reads as one voice
    and hides which half was not verified."""
    block = build_insights(_book(), drafter=_drafter_with_one_clean_half)
    for insight in block["insights"]:
        narrative = insight["narrative"]
        assert narrative["source"] == "deterministic", insight["id"]
        assert "2 million" not in (narrative["so_what"] or "")
        assert "so_what" in (narrative["reason"] or ""), narrative["reason"]


def _drafter_that_explodes(_detector_id: str, _view: Dict[str, Any]):
    raise RuntimeError("upstream is down")


def test_a_drafter_that_raises_degrades_to_the_template_calmly():
    block = build_insights(_book(), drafter=_drafter_that_explodes)
    for insight in block["insights"]:
        assert insight["narrative"]["source"] == "deterministic"
        assert "RuntimeError" in insight["narrative"]["reason"]


# ── the model is never shown a figure to copy ─────────────────────────


def test_the_prompt_view_withholds_every_value():
    seen = {}  # type: Dict[str, Any]

    def _capture(detector_id: str, view: Dict[str, Any]):
        seen[detector_id] = view
        return None

    build_insights(_book(), drafter=_capture)
    assert seen, "the drafter was never called"
    for detector_id, view in seen.items():
        blob = json.dumps(view)
        for entry in view["vocabulary"]:
            assert set(entry) == {"placeholder", "label", "unit", "present"}, (
                detector_id, entry,
            )
        # No amount from the book appears anywhere in what the model sees.
        assert "7,692,202.74" not in blob and "7692202.74" not in blob, detector_id
        assert "46,613.06" not in blob and "46613.06" not in blob, detector_id
