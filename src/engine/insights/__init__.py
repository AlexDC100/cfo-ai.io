"""engine.insights — the deterministic layer that READS the finished
statements and says what a sharp CFO would notice.

THE PROBLEM IT EXISTS FOR
=========================
The correctness pass made the report TRUE: the P&L foots, the bridge to
account 121 is a labelled row, every ratio prints its formula. It did not
make the report NOTICE. A reader was still left to spot for themselves
that 70.4% of Agras' gross PP&E is already written off, that its current
ratio of 2.11 becomes 1.51 once intercompany receivables come out, that
the bridge to account 121 is 46.6% of the profit the P&L reconstructed,
and that account 413 carries 46,613.06 RON that no statement line
explains. This package finds those, ranks them, and hands them to the
renderer with their evidence attached.

WHAT EVERY INSIGHT CARRIES
==========================
  id            stable across runs and books
  severity      LEVEL + the BASIS it was scaled against + the LADDER
                (R4: materiality-scaled, never an absolute cutoff)
  claim         a quantified sentence whose every digit is one of its own
                measures — the sentence is built FROM the figure table, so
                the two cannot disagree
  formula       the arithmetic, in words
  accounts      the RO ledger accounts it came from: code, name, balance
  facts         the gateway reads it consumed, by their address in the
                served payload
  measures      every printable number, typed
  narrative     the ONLY model-authored field, and it may not contain a
                numeral (`engine.ai.numerals`, in `enforce`)

THREE PROPERTIES THE GATES PIN
==============================
  DETERMINISTIC   `build_insights` is a pure function of the payload. No
                  clock, no `hash()`, no network, no DB. Two runs over one
                  book are byte-identical.
  ABSENT != ZERO  a detector that cannot run returns a STATED GAP in
                  `not_fired`, never silence and never a zero. A measure
                  the book does not carry is `None` and renders as
                  "not reported".
  TRACEABLE       every figure resolves to canonical rows and to the
                  account codes those rows name.

Python 3.9 — no `match`, no `X | Y`. No I/O beyond reading the pack YAML.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from .book import AccountRef, Book
from .detectors import Detection, NotFired, run_detector
from .measures import Measure, format_measure, render_claim
from .narrative import Drafter, build_narrative
from .packdata import InsightPack, PackError, load_pack
from .rank import rank_insights, sort_key
from .severity import Verdict, grade

__all__ = [
    "SCHEMA_VERSION",
    "build_insights",
    "Book",
    "InsightPack",
    "PackError",
    "load_pack",
]

SCHEMA_VERSION = "insights/1"


def build_insights(payload: Dict[str, Any], pack: Optional[InsightPack] = None,
                   drafter: Optional[Drafter] = None) -> Dict[str, Any]:
    """Read one finished book and return the insight block.

    `payload` is the shape the fixtures and the served envelope share:
    ``{"statements": {...}, "envelope": {...}, "line_items": [...]}``.
    A payload that is only ``statements`` is accepted too — every
    detector that needs the canonical rows then reports its gap rather
    than guessing.
    """
    resolved_pack = pack or load_pack()
    book = Book(payload)

    built = []  # type: List[Dict[str, Any]]
    not_fired = []  # type: List[Dict[str, Any]]

    for spec in resolved_pack.detectors:
        outcome = run_detector(spec.id, book, spec)
        if isinstance(outcome, NotFired):
            not_fired.append({
                "id": spec.id,
                "title": spec.title,
                "reason": outcome.reason,
            })
            continue
        if not isinstance(outcome, Detection):
            raise TypeError(
                "detector %r returned %r; a detector returns a Detection or a "
                "NotFired and never anything else"
                % (spec.id, type(outcome).__name__)
            )

        verdict = grade(spec, book, outcome.magnitude)
        claim_template = spec.claim_for(outcome.variant)
        claim = render_claim(claim_template, outcome.measures, book.currency,
                             spec.id)
        explanation, so_what = _deterministic_narrative(spec, verdict, claim)
        narrative = build_narrative(
            spec.id, spec.title, spec.formula, claim_template, verdict.level,
            verdict.basis_label, outcome.measures, outcome.accounts,
            book.currency, explanation, so_what, drafter,
        )

        built.append({
            "id": spec.id,
            "title": spec.title,
            "claim_template": claim_template,
            "claim": claim,
            "formula": spec.formula,
            "severity": verdict.as_dict(),
            "measures": [m.as_dict() for m in outcome.measures],
            "accounts": [a.as_dict() for a in outcome.accounts],
            "facts": [f.as_dict() for f in outcome.facts],
            "narrative": narrative.as_dict(),
        })

    ordered = rank_insights(built, resolved_pack.ranking_statement,
                            resolved_pack.summary_limit)
    summary_ids = [i["id"] for i in ordered if i["in_summary"]]

    return {
        "schema_version": SCHEMA_VERSION,
        "currency": book.currency,
        "insights": ordered,
        "summary_ids": summary_ids,
        "not_fired": sorted(not_fired, key=lambda n: n["id"]),
    }


def _deterministic_narrative(spec, verdict: Verdict, claim: str):
    """The template that ships when the advisory lane does not run — and
    the fallback the numeral guard substitutes when it refuses a draft.

    It is deliberately dull and deliberately complete: it restates the
    claim, names the ladder the verdict came off, and says what the
    reader should look at next. A reader who never sees an AI paragraph
    still gets the finding, its scale and its "so what"."""
    basis = verdict.basis_label.lower()
    if verdict.materiality is None:
        scale = ("Severity is reported as %s because %s was not available as "
                 "a scale on this book." % (verdict.level, basis))
    else:
        scale = ("Graded %s: the amount at stake is %s of %s, against the "
                 "ladder printed beside this finding."
                 % (verdict.level, _pct(verdict.materiality), basis))
    explanation = "%s %s %s" % (claim, scale, verdict.why)
    so_what = _SO_WHAT.get(spec.id, _SO_WHAT_DEFAULT)
    return " ".join(explanation.split()), so_what


def _pct(value: float) -> str:
    return "{:,.1f}%".format(value * 100.0)


_SO_WHAT_DEFAULT = (
    "Check this finding against the accounts listed beside it before acting "
    "on the ratio it moves."
)

#: One deterministic "so what" per detector. These are the fallback the
#: guard substitutes for a refused model draft, so they have to stand on
#: their own as advice — not as an apology for missing advice.
_SO_WHAT = {
    "asset_age": (
        "Ask for the fixed-asset register by acquisition year and the "
        "committed capex plan. A book this far through its depreciation life "
        "either has replacement spending ahead of it or is running assets "
        "past their useful life, and the two have very different cash "
        "consequences."
    ),
    "liquidity_quality": (
        "Read the current ratio in its trade-only form when setting covenant "
        "headroom. The non-trade balances removed here are not stock that "
        "converts on ordinary terms, and a lender will discount them."
    ),
    "related_party_exposure": (
        "Ask for the intercompany ageing and the counterparty's own ability "
        "to settle. The haircut figures beside this finding are what the "
        "ratios become if the balance is not recoverable."
    ),
    "reconstruction_gap": (
        "Ask for the year-end journals behind the step to account 121 before "
        "relying on the reconstructed P&L for anything. A large bridge means "
        "the movement columns are not the source of the reported profit."
    ),
    "trade_float": (
        "Compare the collection gap with the credit terms actually granted. "
        "Where suppliers fund the cycle, that funding is a payables line that "
        "can be withdrawn, not a permanent source."
    ),
    "financial_position": (
        "Separate the operating result from the financial one when judging "
        "the trading business. Financial income earned on assets or affiliates "
        "does not repeat because trading improved."
    ),
    "earnings_quality": (
        "Strip the non-trading income out before applying any multiple. "
        "Provision reversals and other operating income do not recur, and an "
        "EBITDA that leans on them overstates the run rate."
    ),
    "unclassified_balances": (
        "Get these accounts mapped before the next close. A balance carried "
        "under an Unclassified row is in the totals but in no statement line, "
        "so it is invisible to every ratio computed from those lines."
    ),
}
