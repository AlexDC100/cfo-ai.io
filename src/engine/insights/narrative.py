"""The AI channel for insights — explanation and "so what", never a digit.

WHAT THE MODEL IS ALLOWED TO PRODUCE
====================================
Two paragraphs per insight: WHY THIS MATTERS and SO WHAT. It is handed the
insight's measures as a PLACEHOLDER VOCABULARY (`{depreciated_share}`,
`{net_book_value}`) with the values withheld from the prompt, and it may
emit those placeholders. It may not emit a numeral of its own.

The refusal is not a new guard. `engine.ai.numerals.guard` already does
exactly this job, with typed facts, an ABSENT-is-not-ZERO rule and a
deterministic fallback, and it is what this module calls. Writing a second
one would have given the codebase two answers to "is this numeral the
engine's?", which is the defect class this whole wave is about.

MODE — AND WHY THE ENV VAR CANNOT DISARM THIS CHANNEL
=====================================================
`engine.ai.numerals` defaults to `observe`, because the LEGACY briefing
prompts still ask the model for literal figures and enforcing there would
replace every served narrative. This channel is NEW: it was specified in
placeholder form from its first line, so it passes `mode=MODE_ENFORCE`
explicitly rather than reading `AI_NUMERAL_GUARD`.

The stronger property, and the one that actually holds the line: this
module reads `GuardResult.accepted` and substitutes the deterministic
template ITSELF. It never serves `result.text` for a refused draft. So
even if the mode argument were dropped, or the environment set the guard
to `off`, a refused draft still cannot reach a reader through here —
there is no code path that returns model text the guard did not accept.

That was found by planting: downgrading `MODE_ENFORCE` to `"observe"`
did not red a single test, because the mode is belt to this module's own
braces. The plant that DOES red is removing the `accepted` check, which
is the regression a future edit would actually make.
`tests/engine/test_insights_narrative_guard.py::
test_the_env_var_cannot_disarm_this_channel` pins it.

THE DRAFTER IS INJECTED
=======================
`build_narrative` takes an optional `drafter` callable. There is no model
client constructed in this module and no network call anywhere in this
package: with no drafter (the default, and what every gate runs under) the
deterministic template is served and `reason` says the lane did not run.
That keeps `build_insights` a pure function of the book — which is what
lets `tests/engine/test_insights_determinism.py` assert byte-identical
output across runs.

Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from engine.ai.numerals import (
    MODE_ENFORCE,
    CountFact,
    LabelFact,
    MoneyFact,
    RatioFact,
    guard,
)

from .measures import Measure

__all__ = ["build_narrative", "Narrative", "facts_for", "Drafter"]

#: (detector_id, prompt_view) -> {"explanation": str, "so_what": str}
Drafter = Callable[[str, Dict[str, Any]], Optional[Dict[str, str]]]


class Narrative(object):
    __slots__ = ("explanation", "so_what", "source", "reason")

    def __init__(self, explanation: Optional[str], so_what: Optional[str],
                 source: str, reason: Optional[str]) -> None:
        self.explanation = explanation
        self.so_what = so_what
        self.source = source
        self.reason = reason

    def as_dict(self) -> Dict[str, Any]:
        out = {
            "explanation": self.explanation,
            "so_what": self.so_what,
            "source": self.source,
        }  # type: Dict[str, Any]
        if self.reason:
            out["reason"] = self.reason
        return out


def facts_for(measures: Sequence[Measure], currency: str,
              extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The typed facts the guard resolves placeholders against.

    A money measure becomes a `MoneyFact` carrying the currency, so a
    narrative can never pair one measure's amount with another's label.
    ABSENT measures are passed through as absent facts — the guard rejects
    a placeholder naming one rather than rendering it as 0."""
    facts = {}  # type: Dict[str, Any]
    for measure in measures:
        if measure.unit == "money":
            facts[measure.key] = MoneyFact(measure.value, currency)
        elif measure.unit in ("ratio", "pct", "multiple"):
            facts[measure.key] = RatioFact(measure.value, measure.unit)
        elif measure.unit == "days":
            facts[measure.key] = CountFact(measure.value, "days")
        elif measure.unit == "years":
            facts[measure.key] = CountFact(measure.value, "years")
        else:
            facts[measure.key] = CountFact(measure.value, "")
    for key, value in (extra or {}).items():
        facts[key] = LabelFact(str(value))
    return facts


def _prompt_view(detector_id: str, title: str, formula: str, claim: str,
                 level: str, basis_label: str, measures: Sequence[Measure],
                 accounts: Sequence[Any]) -> Dict[str, Any]:
    """What the model is shown. The measures are named and typed; their
    VALUES are withheld, so there is nothing in the prompt for a model to
    copy a figure out of."""
    return {
        "detector": detector_id,
        "title": title,
        "formula": formula,
        "claim_template": claim,
        "severity_level": level,
        "severity_basis": basis_label,
        "vocabulary": [
            {"placeholder": "{%s}" % m.key, "label": m.label, "unit": m.unit,
             "present": m.value is not None}
            for m in measures
        ],
        "accounts": [getattr(a, "code", "") for a in accounts][:24],
        "instruction": (
            "Write two short paragraphs. The first says why this matters for "
            "this company. The second says what to do about it. Refer to any "
            "figure ONLY by its placeholder from `vocabulary`. Do not write a "
            "digit of your own."
        ),
    }


def build_narrative(detector_id: str, title: str, formula: str, claim: str,
                    level: str, basis_label: str, measures: Sequence[Measure],
                    accounts: Sequence[Any], currency: str,
                    fallback_explanation: str, fallback_so_what: str,
                    drafter: Optional[Drafter] = None) -> Narrative:
    if drafter is None:
        return Narrative(fallback_explanation, fallback_so_what,
                         "deterministic",
                         "the advisory lane was not invoked for this build")

    view = _prompt_view(detector_id, title, formula, claim, level, basis_label,
                        measures, accounts)
    try:
        drafted = drafter(detector_id, view)
    except Exception as exc:  # noqa: BLE001 — a drafter that fails is a fallback
        return Narrative(fallback_explanation, fallback_so_what,
                         "deterministic",
                         "the advisory lane failed: %s" % type(exc).__name__)
    if not isinstance(drafted, dict):
        return Narrative(fallback_explanation, fallback_so_what,
                         "deterministic",
                         "the advisory lane returned no draft")

    facts = facts_for(measures, currency)
    explanation = guard(drafted.get("explanation"), facts,
                        fallback=fallback_explanation, mode=MODE_ENFORCE)
    so_what = guard(drafted.get("so_what"), facts,
                    fallback=fallback_so_what, mode=MODE_ENFORCE)

    rejected = []  # type: List[str]
    for result, which in ((explanation, "explanation"), (so_what, "so_what")):
        if not result.accepted:
            codes = sorted(set(r.code for r in result.rejections))
            rejected.append("%s (%s)" % (which, ", ".join(codes) or "refused"))

    if rejected:
        # Refuse BOTH halves together. Half a model paragraph beside half a
        # template reads as one voice and hides which half was refused.
        return Narrative(fallback_explanation, fallback_so_what,
                         "deterministic",
                         "the advisory draft was refused by the numeral "
                         "guard: %s" % "; ".join(rejected))

    return Narrative(explanation.text, so_what.text, "ai", None)
