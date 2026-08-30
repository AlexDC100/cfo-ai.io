#!/usr/bin/env python3
"""F2 — THE SPECIFICITY LINT, and the scorer the BEFORE/AFTER table is
measured with.

WHAT IT IS FOR
`design_review/findings/BASELINE.md` measured the live surface and found
80% of findings carrying no imperative verb, 58% citing fewer than two
figures, and the worked 461 note scoring 1.5 of the seven contract
elements. Those were numbers taken by hand, once. This script is the
same measurement, taken automatically, over the REBUILT engine, on every
run of the battery — so the improvement is a gate rather than a claim in
a document that ages.

FOUR THINGS IT CHECKS, over every finding the real engine surfaces from
the committed regression fixtures:

  BANNED PHRASING   the four phrases the law names, plus the rest of
                    `_finding.BANNED_PHRASES` — the same list the engine
                    demotes on, so the lint and the runtime cannot drift
                    apart.
  TWO FIGURES       at least two distinct numbers reach the prose.
  ONE IMPERATIVE    at least one verb from `_finding.IMPERATIVE_VERBS`
                    leads a clause. A verb from `WEAK_LEAD_VERBS`
                    ("review the aging") does not count: it is the banned
                    sentence with the hedge removed.
  ONE LEDGER CODE   the sentence names an account, which is the single
                    property that makes it un-reusable for another book.

  SWAP TEST         a rule that fires on two different companies must
                    produce materially different text. Two measured
                    requirements, and one deliberate NON-requirement:

                    S1 FIGURES   at least half the cited numbers differ.
                    S2 ANCHORED  with every numeral masked out, the two
                                 renderings must STILL differ — so the
                                 text carries something that identifies
                                 the book (the accounts named, the
                                 profile the reader is graded as, the
                                 threshold band that judged them, the
                                 period and snapshot the figures came
                                 from) and is not one fixed sentence
                                 with the numbers swapped.

                    NOT required: novel wording. Two companies that
                    resolve to the SAME profile and trip the SAME rule
                    on the SAME accounts should read alike — the
                    narrative is the profile's, and forcing it to differ
                    would mean inventing difference, which is precisely
                    what the deterministic layer refuses to do. The
                    5-gram overlap is therefore REPORTED, not gated.

                    This is the gate the baseline fails hardest:
                    `risk_inventory_fx_exposure` shipped a body that is
                    byte-identical across every company it fired on, and
                    `risk_inventory_cash_tight` shipped one whose only
                    company content was a single percentage.

THE SCORER
:func:`score_text` gives a finding 0..7, one point per contract element,
from PROSE ALONE — because a legacy row has no typed elements to inspect
and the two eras have to be measured on the same ruler. It is calibrated
against the baseline's own hand audit: `--self-test` asserts the legacy
461 body scores exactly 1.5, the number BASELINE.md recorded. If a
future edit makes the scorer generous, the self-test fails before the
distribution it prints can flatter anything.

NO NETWORK, NO CLOCK, NO MODEL. The fixtures are committed, the engine is
deterministic, and this script neither imports nor constructs an AI
client (F9 covers that as a gate; it is also simply true here).

Usage:
    python scripts/check_finding_specificity.py            # lint + report
    python scripts/check_finding_specificity.py --self-test
    python scripts/check_finding_specificity.py --json

Exit codes: 0 = clean; 1 = at least one violation.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from engine.api import _finding as F  # noqa: E402
from engine.api.findings import s_engine  # noqa: E402

FIXTURES = (SRC / "engine" / "country_packs" / "ro_romania" / "fixtures"
            / "regression_baselines")

#: Every committed regression fixture, by the workspace it mirrors.
#: `scandia_frozen_fy2025` is here and not in the single-period suite's
#: own list on purpose: it is the third production workspace the
#: BEFORE/AFTER table is drawn from, so the lint must cover it.
FIXTURE_NAMES = (
    "scandia_fy2025",
    "scandia_frozen_fy2025",
    "agras_fy2025",
    "eei_dec_2025",
    "carniprod_fy2025",
    "sibiu_dec_2019",
    "scandia_realestate_fy2025",
    "scandia_retail_fy2025",
)

#: The four the law names by hand. Held separately from
#: `_finding.BANNED_PHRASES` so that trimming the engine's list cannot
#: quietly narrow this gate — the gates test asserts each of these is
#: still in the engine list too.
LAW_BANNED_PHRASES = (
    "should be monitored",
    "may warrant review",
    "consider evaluating",
    "best practice suggests",
)

MIN_FIGURES = 2
SPECIFICITY_MAX = 7.0

#: Numbers, as they are printed. Grouped thousands first so "7,692,203"
#: counts once rather than three times.
NUMBER_RX = re.compile(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?")

#: A Romanian ledger code as it appears in prose: three or four digits
#: opening with a class digit, not embedded in a larger number. The
#: lookarounds are what keep "7,692,203" from reading as accounts 692 and
#: 203, and "0.09x" from reading as anything at all.
ACCOUNT_CODE_RX = re.compile(r"(?<![\d.,\-])\b([1-7]\d{2,3})\b(?![\d.,%])")

_WORD_RX = re.compile(r"[a-z0-9]+")

#: S1 — at least this share of the cited numbers must differ between two
#: companies. Two companies graded against the same profile legitimately
#: share a THRESHOLD figure; they cannot legitimately share their
#: observations, their balances or their recomputed impact.
SWAP_MIN_FIGURE_DIVERGENCE = 0.50
#: 5-gram window for the REPORTED overlap. Reported, never gated — see
#: the module docstring on why novel wording is not the property under
#: test.
SHINGLE = 5

#: The live body of the note the whole contract was designed around,
#: quoted from BASELINE.md / production period 11b8e759. The scorer's
#: calibration anchor — see `--self-test`.
LEGACY_461_BODY = (
    "Account 461 (Debitori diverși) holds RON 7,692,203 due from related "
    "parties — 19.6% of total assets RON 39,194,178. Recoverability and "
    "intent on settlement should be confirmed. Lenders typically haircut "
    "related-party receivables during covenant measurement."
)
LEGACY_461_SCORE = 1.5


# ── Text probes ──────────────────────────────────────────────────────────


def figures_in(text: str) -> Tuple[str, ...]:
    """Distinct printed numbers, in order of first appearance."""
    seen = []  # type: List[str]
    for hit in NUMBER_RX.findall(text or ""):
        if hit not in seen:
            seen.append(hit)
    return tuple(seen)


def account_codes_in(text: str) -> Tuple[str, ...]:
    seen = []  # type: List[str]
    for hit in ACCOUNT_CODE_RX.findall(text or ""):
        if hit not in seen:
            seen.append(hit)
    return tuple(seen)


def banned_phrases_in(text: str) -> Tuple[str, ...]:
    low = (text or "").lower()
    hits = []  # type: List[str]
    for phrase in tuple(LAW_BANNED_PHRASES) + tuple(F.BANNED_PHRASES):
        if phrase in low and phrase not in hits:
            hits.append(phrase)
    return tuple(hits)


def _clauses(text: str) -> List[str]:
    """Sentence-ish fragments. Split on the punctuation an action step is
    actually separated by in rendered prose, including the numbered "1)"
    list `Finding._render_body` produces."""
    parts = re.split(r"(?:[.;:!?]|\d\)|—)\s+", text or "")
    return [p.strip() for p in parts if p.strip()]


def imperative_verbs_in(text: str) -> Tuple[str, ...]:
    """Lead verbs from the engine's own lexicon that actually open a
    clause. A weak lead ("review …") is not counted — the whole point of
    `WEAK_LEAD_VERBS` is that it reads as an action and commits to
    nothing."""
    hits = []  # type: List[str]
    for clause in _clauses(text):
        head = clause.split(" ", 1)[0].strip(",.;:()").lower()
        if head in F.WEAK_LEAD_VERBS:
            continue
        if head in F.IMPERATIVE_VERBS and head not in hits:
            hits.append(head)
    return tuple(hits)


# ── The 0..7 score ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class ElementScore:
    """One finding, scored from prose alone, on the seven elements.

    Prose-only on purpose. A legacy alert row has a title, a body and a
    `facts_cited` map and nothing else; scoring the rebuilt findings off
    their typed fields and the legacy ones off their text would compare
    two different rulers and prove nothing.
    """

    subject: float
    evidence: float
    threshold: float
    impact: float
    why_here: float
    action: float
    confidence: float

    def total(self) -> float:
        return round(self.subject + self.evidence + self.threshold
                     + self.impact + self.why_here + self.action
                     + self.confidence, 2)

    def to_payload(self) -> Dict[str, Any]:
        return {
            "subject": self.subject, "evidence": self.evidence,
            "threshold": self.threshold, "impact": self.impact,
            "why_here": self.why_here, "action": self.action,
            "confidence": self.confidence, "total": self.total(),
        }

    def missing(self) -> Tuple[str, ...]:
        out = []  # type: List[str]
        for name in ("subject", "evidence", "threshold", "impact",
                     "why_here", "action", "confidence"):
            if getattr(self, name) < 1.0:
                out.append("%s=%.2f" % (name, getattr(self, name)))
        return tuple(out)


_PROVENANCE_RX = re.compile(r"\bperiod \S+", re.I)
_PROV_DETAIL_RX = re.compile(r"\b(snapshot|accounts)\b", re.I)
_BASIS_RX = re.compile(r"\bBasis:", re.I)
_RULE_RX = re.compile(
    r"\bfires when\b.*\b(above|below|at or above|at or below|away from)\b", re.I)
_LIMIT_WORD_RX = re.compile(r"\b(threshold|ceiling|floor|limit|covenant alarm)\b", re.I)
_MOVES_RX = re.compile(r"\bmoves from\b.+\bto\b", re.I)
_CONTRAST_RX = re.compile(r"\b(vs|versus|would|produces|after a full)\b", re.I)
_CONFIDENCE_RX = re.compile(r"\bConfidence (high|medium|low)\b", re.I)


def score_text(text: str, anchors: Sequence[str] = ()) -> ElementScore:
    """Score one finding's rendered prose on the seven elements.

    `anchors` are the company-specific tokens the profile supplies. A
    legacy row has none — which is not a scoring artefact but the finding
    itself: BASELINE.md's audit of the 461 note recorded WHY-HERE as
    "absent (identical for any company)", and a note produced without a
    company profile cannot be anything else.
    """
    body = text or ""
    low = body.lower()
    figures = figures_in(body)
    banned = banned_phrases_in(body)

    subject = 1.0 if account_codes_in(body) else 0.0

    evidence = 0.0
    if len(figures) >= MIN_FIGURES:
        evidence += 0.5
    if _PROVENANCE_RX.search(body) and _PROV_DETAIL_RX.search(body):
        evidence += 0.25
    if _BASIS_RX.search(body):
        evidence += 0.25

    if _RULE_RX.search(body):
        threshold = 1.0
    elif _LIMIT_WORD_RX.search(body) and figures:
        threshold = 0.5
    else:
        threshold = 0.0

    if _MOVES_RX.search(body):
        impact = 1.0
    elif _CONTRAST_RX.search(body) and figures:
        impact = 0.5
    else:
        impact = 0.0

    why_here = 0.0
    for anchor in anchors:
        token = (anchor or "").strip().lower()
        if token and token in low:
            why_here = 1.0
            break

    if banned or not imperative_verbs_in(body):
        action = 0.0
    elif " from " in low or ", from" in low:
        action = 1.0
    else:
        action = 0.5

    confidence = 1.0 if _CONFIDENCE_RX.search(body) else 0.0

    return ElementScore(subject=subject, evidence=evidence,
                        threshold=threshold, impact=impact,
                        why_here=why_here, action=action,
                        confidence=confidence)


# ── The prose lint ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class Violation:
    where: str
    rule: str
    detail: str

    def render(self) -> str:
        return "%-26s %-18s %s" % (self.where, self.rule, self.detail)


def lint_text(where: str, text: str) -> List[Violation]:
    """The four prose gates, over one rendered finding."""
    out = []  # type: List[Violation]
    for phrase in banned_phrases_in(text):
        out.append(Violation(where, "F2-BANNED", "contains %r" % phrase))
    figures = figures_in(text)
    if len(figures) < MIN_FIGURES:
        out.append(Violation(where, "F2-FIGURES",
                             "%d distinct figure(s), need %d"
                             % (len(figures), MIN_FIGURES)))
    if not imperative_verbs_in(text):
        out.append(Violation(where, "F2-IMPERATIVE",
                             "no clause leads with a verb from "
                             "_finding.IMPERATIVE_VERBS"))
    if not account_codes_in(text):
        out.append(Violation(where, "F2-SUBJECT",
                             "names no ledger account code, so the sentence "
                             "is not about a specific book"))
    return out


# ── The swap test ────────────────────────────────────────────────────────


def _shingles(text: str, n: int = SHINGLE) -> set:
    words = _WORD_RX.findall((text or "").lower())
    if len(words) < n:
        return set([" ".join(words)]) if words else set()
    return set(" ".join(words[i:i + n]) for i in range(len(words) - n + 1))


def shingle_jaccard(a: str, b: str) -> float:
    sa, sb = _shingles(a), _shingles(b)
    if not sa and not sb:
        return 1.0
    union = sa | sb
    if not union:
        return 1.0
    return len(sa & sb) / float(len(union))


def figure_divergence(a: str, b: str) -> float:
    """Share of the two texts' cited numbers that appear in only one of
    them. 0.0 means the same company's numbers were printed twice."""
    fa, fb = set(figures_in(a)), set(figures_in(b))
    union = fa | fb
    if not union:
        return 0.0
    return len(fa ^ fb) / float(len(union))


def mask_numerals(text: str) -> str:
    """Every printed number replaced by `#`. What is left is the part of
    the sentence that is not a numeral — and S2 asks whether ANY of it
    identifies the company."""
    return NUMBER_RX.sub("#", text or "")


@dataclass(frozen=True)
class SwapResult:
    rule_id: str
    left: str
    right: str
    jaccard: float
    divergence: float
    masked_identical: bool

    def failures(self) -> Tuple[str, ...]:
        out = []  # type: List[str]
        if self.divergence < SWAP_MIN_FIGURE_DIVERGENCE:
            out.append("S1 figures: only %.2f of the cited numbers differ, "
                       "need %.2f" % (self.divergence,
                                      SWAP_MIN_FIGURE_DIVERGENCE))
        if self.masked_identical:
            out.append("S2 anchored: with the numerals masked the two "
                       "renderings are byte-identical — the text carries "
                       "nothing that identifies either book")
        return tuple(out)

    def passed(self) -> bool:
        return not self.failures()

    def render(self) -> str:
        return ("%-38s %-24s %-24s figures-differ %.2f  anchored %-3s  "
                "overlap %.2f  %s"
                % (self.rule_id, self.left, self.right, self.divergence,
                   "no" if self.masked_identical else "yes", self.jaccard,
                   "ok" if self.passed() else "FAIL"))


def swap_test(rule_id: str, left_name: str, left_text: str,
              right_name: str, right_text: str) -> SwapResult:
    """Render the same rule against two different companies' data and ask
    whether the text is materially different."""
    return SwapResult(
        rule_id=rule_id, left=left_name, right=right_name,
        jaccard=shingle_jaccard(left_text, right_text),
        divergence=figure_divergence(left_text, right_text),
        masked_identical=(mask_numerals(left_text)
                          == mask_numerals(right_text)))


# ── Running the real engine ──────────────────────────────────────────────


def statements_for(name: str) -> Dict[str, Any]:
    with open(str(FIXTURES / (name + ".json")), encoding="utf-8") as fh:
        return json.load(fh)["assembled"]["statements"]


def run_fixture(name: str):
    return s_engine.run_single_period(
        statements_for(name), period_id="p-" + name,
        snapshot_id="snap-" + name)


@dataclass(frozen=True)
class Scored:
    fixture: str
    rule_id: str
    severity: str
    text: str
    score: ElementScore


def collect(names: Sequence[str] = FIXTURE_NAMES) -> List[Scored]:
    """Every surfaced finding from every fixture, scored."""
    out = []  # type: List[Scored]
    for name in names:
        result = run_fixture(name)
        anchors = result.profile.anchors()
        for row in result.surfaced():
            text = "%s\n%s" % (row.get("title") or "", row.get("body") or "")
            out.append(Scored(fixture=name, rule_id=row["rule_key"],
                              severity=row["severity"], text=text,
                              score=score_text(text, anchors)))
    return out


def distribution(scored: Sequence[Scored]) -> Dict[str, Any]:
    totals = [s.score.total() for s in scored]
    buckets = {}  # type: Dict[str, int]
    for total in totals:
        key = "%.1f" % total
        buckets[key] = buckets.get(key, 0) + 1
    return {
        "count": len(totals),
        "min": min(totals) if totals else 0.0,
        "max": max(totals) if totals else 0.0,
        "mean": round(sum(totals) / float(len(totals)), 3) if totals else 0.0,
        "at_seven": len([t for t in totals if t >= SPECIFICITY_MAX]),
        "buckets": dict(sorted(buckets.items())),
    }


# ── Self-test — the scorer's own calibration ─────────────────────────────


def self_test() -> List[str]:
    """Prove the ruler before trusting the measurement.

    Three assertions, each of which the baseline supplies the answer to:
      · the legacy 461 body scores exactly 1.5 (BASELINE.md's hand audit)
      · it trips the prose lint on three of the four gates
      · two legacy renderings of one rule fail the swap test — the same
        sentence with the numbers swapped is the failure mode the gate
        exists to catch.
    """
    failures = []  # type: List[str]
    got = score_text(LEGACY_461_BODY).total()
    if abs(got - LEGACY_461_SCORE) > 1e-9:
        failures.append(
            "scorer drifted: the legacy 461 body scores %.2f, BASELINE.md "
            "recorded %.2f" % (got, LEGACY_461_SCORE))
    rules = set(v.rule for v in lint_text("legacy-461", LEGACY_461_BODY))
    for expected in ("F2-BANNED", "F2-IMPERATIVE"):
        if expected not in rules:
            failures.append("the legacy 461 body no longer trips %s" % expected)
    # The production `risk_inventory_fx_exposure` body, verbatim, as it
    # shipped to two different companies. Fails S1 (no figures at all in
    # the body, so none of them can differ) and S2.
    fx = ("Significant FX cash position. Movements in EUR/RON or USD/RON "
          "create P&L volatility. Consider an FX hedging policy or "
          "natural-hedge alignment with foreign-currency liabilities.")
    clone = swap_test("risk_inventory_fx_exposure", "b967905e", fx,
                      "11b8e759", fx)
    if clone.passed():
        failures.append(
            "the swap test passed two byte-identical legacy bodies; it "
            "cannot detect anything")
    # The production `risk_inventory_cash_tight` body, both companies.
    # This one DOES carry a company number, so it passes S1 — it is S2
    # that has to catch it, which is why S2 exists.
    tight = ("Cash covers only %s of current liabilities — heavy dependence "
             "on revolvers. A 15-day disruption could push the company past "
             "covenants or payment terms.")
    near = swap_test("risk_inventory_cash_tight", "b967905e", tight % "4.3%",
                     "11b8e759", tight % "9.0%")
    if near.divergence < SWAP_MIN_FIGURE_DIVERGENCE:
        failures.append(
            "the legacy cash-tight pair was expected to PASS S1 — it is the "
            "case S2 exists for; the self-test is no longer testing S2")
    if near.passed():
        failures.append(
            "the swap test passed two legacy bodies whose only difference is "
            "one percentage; S2 is not detecting an unanchored sentence")
    return failures


# ── Entry point ──────────────────────────────────────────────────────────


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--self-test", action="store_true",
                    help="prove the scorer and the swap test can fail")
    ap.add_argument("--json", action="store_true",
                    help="emit the distribution as JSON")
    args = ap.parse_args(list(argv) if argv is not None else None)

    calibration = self_test()
    for line in calibration:
        print("FAIL self-test  %s" % line)
    if args.self_test:
        if not calibration:
            print("PASS self-test  scorer calibrated: legacy 461 = %.1f/%.1f, "
                  "lint trips, swap test detects a clone"
                  % (LEGACY_461_SCORE, SPECIFICITY_MAX))
        return 1 if calibration else 0

    scored = collect()
    violations = []  # type: List[Violation]
    for item in scored:
        violations.extend(lint_text("%s/%s" % (item.fixture, item.rule_id),
                                    item.text))
        if item.score.total() < SPECIFICITY_MAX:
            violations.append(Violation(
                "%s/%s" % (item.fixture, item.rule_id), "F2-SCORE",
                "scored %.2f/%.1f (%s)"
                % (item.score.total(), SPECIFICITY_MAX,
                   ", ".join(item.score.missing()))))

    # Swap test: every rule that fires on more than one fixture.
    by_rule = {}  # type: Dict[str, List[Scored]]
    for item in scored:
        by_rule.setdefault(item.rule_id, []).append(item)
    swaps = []  # type: List[SwapResult]
    for rule_id in sorted(by_rule):
        members = by_rule[rule_id]
        for i in range(len(members) - 1):
            left, right = members[i], members[i + 1]
            swaps.append(swap_test(rule_id, left.fixture, left.text,
                                   right.fixture, right.text))
    for swap in swaps:
        for failure in swap.failures():
            violations.append(Violation(
                "%s/%s" % (swap.left, swap.rule_id), "F2-SWAP",
                "against %s — %s" % (swap.right, failure)))

    dist = distribution(scored)
    if args.json:
        print(json.dumps({
            "distribution": dist,
            "violations": [v.__dict__ for v in violations],
            "swaps": [s.__dict__ for s in swaps],
        }, indent=2, sort_keys=True))
        return 1 if (violations or calibration) else 0

    print("F2 SPECIFICITY — %d surfaced finding(s) over %d fixture(s)"
          % (dist["count"], len(FIXTURE_NAMES)))
    print("  score/%.1f   min %.2f  mean %.3f  max %.2f  at-full %d"
          % (SPECIFICITY_MAX, dist["min"], dist["mean"], dist["max"],
             dist["at_seven"]))
    print("  distribution %s" % dist["buckets"])
    print("  baseline for comparison: the legacy 461 note scores %.1f/%.1f"
          % (LEGACY_461_SCORE, SPECIFICITY_MAX))
    print("  swap test: %d pair(s), %d failing"
          % (len(swaps), len([s for s in swaps if not s.passed()])))
    for swap in swaps:
        print("    " + swap.render())
    if violations:
        print("")
        for v in violations:
            print("FAIL " + v.render())
        print("\n%d violation(s)." % len(violations))
        return 1
    print("\nOK — every surfaced finding carries two figures, an imperative "
          "verb, a ledger code and no boilerplate, scores %.1f/%.1f, and no "
          "rule renders text that would read the same for another book."
          % (SPECIFICITY_MAX, SPECIFICITY_MAX))
    return 0 if not calibration else 1


if __name__ == "__main__":
    raise SystemExit(main())
