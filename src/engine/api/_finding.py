"""THE ANTI-GENERIC LAW, as a type.

A finding is not a sentence. It is seven facts that happen to render as a
sentence. This module holds those seven as TYPED FIELDS, a validator that
reports which of them are missing, and a deterministic renderer that
composes them into prose — so a surfaced finding cannot be missing an
element, because the prose is BUILT FROM the elements rather than
authored beside them.

THE SEVEN
    subject      accounts, with codes and names — who this is about
    evidence     >= 2 native-unit figures + provenance + the comparison
                 basis actually used
    threshold    the rule, its parameter, the limit, the observed value
    impact       a quantified consequence: a recomputed ratio or a money
                 delta, computed through `_ratio_units` (never by hand)
    why_here     why it matters for THIS company profile, anchored to a
                 profile signal so the sentence cannot be reused verbatim
                 for a different company
    action       concrete steps, each naming the artefact to obtain and
                 who typically provides it
    confidence   a data-quality position, explicitly stated (a null
                 CAVEAT is allowed; a null POSITION is not)

DEMOTION IS THE DEFAULT PATH
There is no way to ask this module for a surfaced finding. The only
serializer, :meth:`Finding.to_payload`, runs :meth:`Finding.validate`
itself and stamps ``surfaced`` from the result. `surfaced` is not a
constructor argument, not a settable attribute, and not something a
caller can pass in. Forgetting to validate therefore cannot surface a
bad finding — the worst a forgetful caller achieves is a demoted row on
the raw "All checks" list, which is exactly where an incomplete finding
belongs.

SILENCE IS VALID
:class:`FindingSet` collects the CHECKS PERFORMED alongside the findings,
so "nothing material" is answerable with the list of what was actually
examined rather than with filler.

AI CANNOT TOUCH A NUMBER
:func:`apply_advisory_narrative` is the ONLY seam an advisory model may
use. It rewrites the why-here rationale and the action wording, then
re-validates and refuses (``NarrativeMutationError``) if any cited fact,
figure, threshold or impact moved by so much as a float bit. Detection,
quantification, materiality and ranking stay deterministic.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field, replace
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import _ratio_units

# Re-exported so detectors never need to reach past this module for the
# unit vocabulary they cite.
UNIT_MONEY = _ratio_units.UNIT_MONEY
UNIT_RATIO = _ratio_units.UNIT_RATIO
UNIT_PERCENT = _ratio_units.UNIT_PERCENT
UNIT_DAYS = _ratio_units.UNIT_DAYS
UNIT_COUNT = _ratio_units.UNIT_COUNT
UNIT_SCORE = _ratio_units.UNIT_SCORE
UNIT_UNKNOWN = _ratio_units.UNIT_UNKNOWN


# ── The seven element names ──────────────────────────────────────────────

ELEMENT_SUBJECT = "subject"
ELEMENT_EVIDENCE = "evidence"
ELEMENT_THRESHOLD = "threshold"
ELEMENT_IMPACT = "impact"
ELEMENT_WHY_HERE = "why_here"
ELEMENT_ACTION = "action"
ELEMENT_CONFIDENCE = "confidence"
#: Not one of the seven — the prose gates the seven have to survive once
#: rendered (>= 2 figures, >= 1 imperative verb, no boilerplate, and at
#: least one account code so the sentence cannot be about another
#: company). Reported the same way so one list answers "why demoted?".
ELEMENT_PROSE = "prose"

CONTRACT_ELEMENTS = (
    ELEMENT_SUBJECT, ELEMENT_EVIDENCE, ELEMENT_THRESHOLD, ELEMENT_IMPACT,
    ELEMENT_WHY_HERE, ELEMENT_ACTION, ELEMENT_CONFIDENCE,
)
ALL_GATES = CONTRACT_ELEMENTS + (ELEMENT_PROSE,)

MIN_FIGURES = 2


# ── Refusals ─────────────────────────────────────────────────────────────


class UnknownUnitError(ValueError):
    """A cited figure carries a unit the registry refuses to name. Money
    must be DECLARED in `_ratio_units`; an unknown unit is never rendered
    (a number with no unit is a number with no meaning)."""


class NarrativeMutationError(ValueError):
    """An advisory rewrite changed a number. Refused: the model explains,
    it does not compute."""


class OrphanCurrencyLabelError(ValueError):
    """The rendered prose left a currency LABEL outside the placeholder
    that carries its figure.

    This is the Critical-461 defect in its general form. `templatize`
    lifts "RON 7,692,203" into `{{money:...}}` label and all — but only
    when it can see the label. Put a bare number immediately before the
    label ("...on 461 RON 7,692,203") and the token regex's suffix branch
    binds the label to the WRONG number, leaving `RON {{money:x|bare}}`:
    at display time the figure converts to EUR and the word RON does not.
    One claim, two currencies.

    So the renderer refuses. A finding whose prose defeats templatization
    is DEMOTED, never shipped — the same disposition as any other missing
    element.
    """


# ── Banned phrasing and the imperative lexicon ───────────────────────────

#: Substrings that make a sentence generic. The first four are named in
#: the law; the rest are the same move wearing different clothes. Matched
#: case-insensitively against the rendered title + body.
BANNED_PHRASES = (
    "should be monitored",
    "may warrant review",
    "may warrant",
    "consider evaluating",
    "best practice suggests",
    "best practice",
    "should be confirmed",
    "should be reviewed",
    "should be considered",
    "is recommended",
    "recommended",
    "keep an eye",
    "monitor closely",
    "close monitoring",
    "as appropriate",
    "where appropriate",
    "if necessary",
    "it is advisable",
    "due diligence is warranted",
    "warrants attention",
    "requires attention",
    "bears watching",
)

#: A leading verb that commits the reader to nothing. Rejected as the
#: head of an action step even though each is grammatically imperative —
#: "review the aging" is the banned sentence with the hedge removed.
WEAK_LEAD_VERBS = frozenset([
    "consider", "monitor", "evaluate", "assess", "review", "explore",
    "examine", "watch", "note", "understand", "be", "ensure", "maintain",
])

#: Verbs that name an act with an artefact attached. A step whose first
#: word is outside this set is not an action.
IMPERATIVE_VERBS = frozenset([
    "pull", "request", "obtain", "collect", "extract", "export",
    "confirm", "verify", "trace", "tie", "match", "reconcile", "test",
    "recompute", "compute", "calculate", "quantify", "measure", "model",
    "compare", "benchmark", "rank", "split", "separate", "reclassify",
    "restate", "write", "book", "provision", "impair", "capitalise",
    "capitalize", "amortise", "amortize", "settle", "collectible",
    "negotiate", "refinance", "renegotiate", "hedge", "fix", "lock",
    "draw", "repay", "convert", "escalate", "convene", "file", "draft",
    "schedule", "diarise", "diarize", "agree", "commission", "instruct",
    "cap", "limit", "raise", "release", "disclose", "document",
    "reconfirm", "recover", "invoice", "chase", "net", "offset",
    "present", "publish", "send", "ask", "map", "list", "count",
])

_NUMBER_RX = re.compile(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?")
_ACCOUNT_CODE_RX = re.compile(r"^[0-9][0-9A-Za-z._-]*$")

COMPARATORS = {
    ">": "above",
    ">=": "at or above",
    "<": "below",
    "<=": "at or below",
    "!=": "away from",
}

COMPARISON_BASIS_KINDS = (
    "profile_threshold",   # the rule's own parameter for this profile
    "self_total",          # a share of one of the company's own totals
    "prior_period",        # the same company, an earlier period
    "peer_band",           # a published sector band
    "regulatory",          # a statutory limit
    "covenant",            # a lender's contractual limit
)

IMPACT_KINDS = ("recomputed_ratio", "money_delta", "headroom")

CONFIDENCE_LEVELS = ("high", "medium", "low")


# ── Element types ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Account:
    """One ledger account the finding is about. `code` is the thing that
    makes a finding un-reusable across companies: a sentence naming 461
    with a native figure is about one book."""

    code: str
    name: str
    statement: Optional[str] = None      # "BS" | "PL" | "CF"
    bucket: Optional[str] = None         # canonical bucket, when known

    def render(self) -> str:
        return "%s (%s)" % (self.code, self.name)


@dataclass(frozen=True)
class Subject:
    accounts: Tuple[Account, ...]
    scope: str                            # short noun phrase

    def codes(self) -> Tuple[str, ...]:
        return tuple(a.code for a in self.accounts)

    def render(self) -> str:
        return ", ".join(a.render() for a in self.accounts)


@dataclass(frozen=True)
class Figure:
    """A cited number, in the period's OWN units. `fact` is the key under
    which it also appears in `facts_cited`, which is what lets
    `_ratio_units.templatize` bind the printed token to a typed
    placeholder instead of leaving digits in the prose."""

    fact: str
    value: float
    unit: str
    label: str

    def render(self, currency: str) -> str:
        return _format_value(self.value, self.unit, currency)


@dataclass(frozen=True)
class Provenance:
    """Where the figures came from. `period_id` plus at least one of
    (`snapshot_id`, `line_refs`) — a figure with no traceable origin is
    an assertion, not evidence."""

    period_id: str
    snapshot_id: Optional[str] = None
    line_refs: Tuple[str, ...] = ()
    source: str = "assembled_canonical_v1"

    def render(self) -> str:
        bits = ["period %s" % self.period_id]
        if self.snapshot_id:
            bits.append("snapshot %s" % self.snapshot_id)
        if self.line_refs:
            bits.append("accounts %s" % ", ".join(self.line_refs))
        bits.append(self.source)
        return "; ".join(bits)


@dataclass(frozen=True)
class ComparisonBasis:
    kind: str
    description: str
    basis_value: Optional[float] = None
    basis_unit: Optional[str] = None


@dataclass(frozen=True)
class Evidence:
    figures: Tuple[Figure, ...]
    provenance: Provenance
    comparison_basis: ComparisonBasis


@dataclass(frozen=True)
class Threshold:
    """The rule, stated. The baseline's worst habit was firing a rule and
    never telling the reader what the rule WAS."""

    rule_id: str
    parameter: str
    parameter_label: str
    comparator: str
    limit: float
    observed: float
    unit: str
    source: str          # "profiles.yaml#detectors.<id>.thresholds..."

    def holds(self) -> bool:
        c, o, l = self.comparator, self.observed, self.limit
        if c == ">":
            return o > l
        if c == ">=":
            return o >= l
        if c == "<":
            return o < l
        if c == "<=":
            return o <= l
        if c == "!=":
            return o != l
        return False


@dataclass(frozen=True)
class Impact:
    """A quantified consequence. Built only by :func:`ratio_impact` /
    :func:`money_impact` / :func:`headroom_impact`, which route every
    division through `_ratio_units` so an impact cannot be computed
    across a currency or scale boundary."""

    kind: str
    metric: str
    metric_label: str
    baseline: float
    adjusted: float
    delta: float
    unit: str
    currency: Optional[str] = None
    #: For a MONEY impact, the `facts_cited` names its two endpoints are
    #: stored under. Required, because a money number that is not a cited
    #: fact prints as raw digits with a raw currency word and never
    #: converts — see OrphanCurrencyLabelError. Filled automatically from
    #: the `Quantity.name` of the operands, so a detector using
    #: `money_impact` gets it for free.
    baseline_fact: Optional[str] = None
    adjusted_fact: Optional[str] = None

    def render(self, currency: str) -> str:
        cur = self.currency or currency
        moves = "%s moves from %s to %s" % (
            self.metric_label,
            _format_value(self.baseline, self.unit, cur),
            _format_value(self.adjusted, self.unit, cur),
        )
        if self.unit == UNIT_MONEY:
            # The delta is deliberately NOT printed for a money impact.
            # Both endpoints are cited facts (enforced in `_check_impact`)
            # and therefore templatize into placeholders; the DIFFERENCE
            # of two facts is not itself a fact, so printing it would
            # leave a third money figure that no placeholder covers — an
            # unconvertible number beside two converted ones. It stays in
            # `Impact.delta` on the payload, where nothing renders it as
            # currency text.
            return moves
        return "%s (%s)" % (moves, _format_signed(self.delta, self.unit, cur))


@dataclass(frozen=True)
class WhyHere:
    """Profile-derived. `anchors` are the tokens that make the rationale
    about THIS company — the profile label, a size label, a signal label,
    an account code. The validator requires at least one to appear in the
    rationale text, which is what structurally blocks "a sentence that
    would read identically for a different company"."""

    profile_id: str
    profile_label: str
    rationale: str
    signals: Tuple[str, ...] = ()
    anchors: Tuple[str, ...] = ()


@dataclass(frozen=True)
class ActionStep:
    imperative: str          # begins with a real imperative verb
    artefact: str            # what to obtain / check / compute
    provider: str            # who typically provides it
    horizon: Optional[str] = None
    #: Language of THIS step's three text fields. Defaults to "en", so
    #: every deterministic detector — all 38 construction sites — is
    #: byte-identical to before this field existed.
    #:
    #: It exists because the sharpening layer returns Romanian steps, and
    #: `render()` used to splice them with an English joiner: a correct
    #: Romanian step came out as "…, from controlorul financiar". Nothing
    #: renders RO steps through here today (the frontend joins the
    #: structured steps itself), so this was a trap rather than a live
    #: bug — and a trap that produces a plausible half-English sentence
    #: is exactly the kind that ships. Stamping the language on the step
    #: makes the joiner follow the words instead of the code path.
    lang: str = "en"

    #: Joiner per language. A language absent here REFUSES in `render()`
    #: rather than falling back to English, on the house rule: a missing
    #: translation is ABSENT, and absent is not "the English one".
    _JOINERS = {
        "en": ("%s — %s, from %s", "(%s)"),
        "ro": ("%s — %s, de la %s", "(%s)"),
    }

    def lead_verb(self) -> str:
        head = self.imperative.strip().split(" ", 1)[0] if self.imperative.strip() else ""
        return head.strip(",.;:").lower()

    def render(self) -> str:
        shape = self._JOINERS.get(self.lang)
        if shape is None:
            raise ValueError(
                "ActionStep.render(): no joiner for lang %r. Add one to "
                "ActionStep._JOINERS — do not fall back to English, which "
                "would emit a sentence that is half one language and half "
                "another and read as correct." % (self.lang,))
        body, horizon_fmt = shape
        text = body % (self.imperative.rstrip(". "),
                       self.artefact.rstrip(". "), self.provider)
        if self.horizon:
            text += " " + (horizon_fmt % self.horizon)
        return text + "."


@dataclass(frozen=True)
class Action:
    steps: Tuple[ActionStep, ...]


@dataclass(frozen=True)
class Confidence:
    """An explicit data-quality POSITION. `caveat` may be null; the
    position may not — "we did not think about it" and "we thought about
    it and there is nothing to flag" are different claims, and only the
    second one is allowed to reach a reader."""

    level: str
    basis: str
    caveat: Optional[str] = None

    def render(self) -> str:
        if self.caveat:
            return "Confidence %s — %s (%s)." % (self.level, self.caveat, self.basis)
        return "Confidence %s — %s." % (self.level, self.basis)


# ── Rendering primitives ─────────────────────────────────────────────────


def _format_value(value: float, unit: str, currency: str) -> str:
    """One printer for every unit. Money prints with its label so
    `templatize` can lift the pair into a placeholder; percentages and
    multiples print with a trailing marker so it never claims them."""
    v = float(value)
    if unit == UNIT_MONEY:
        return "%s %s" % ((currency or "RON").upper(), format(v, ",.0f"))
    if unit == UNIT_PERCENT:
        return "%.1f%%" % (v * 100.0)
    if unit == UNIT_RATIO:
        return "%.2f×" % v
    if unit == UNIT_DAYS:
        return "%.0f days" % v
    if unit == UNIT_COUNT:
        return "%.0f" % v
    if unit == UNIT_SCORE:
        return "%.1f" % v
    raise UnknownUnitError(
        "refusing to render %r: unit %r is not declared in _ratio_units"
        % (value, unit)
    )


def _format_signed(value: float, unit: str, currency: str) -> str:
    body = _format_value(abs(float(value)), unit, currency)
    return ("+" if float(value) >= 0 else "-") + body


def _orphan_currency_labels(template: str, currency: str) -> List[str]:
    """Currency labels the templatizer did NOT absorb.

    Three signatures, all of them the same failure — a word that will not
    convert sitting beside a number that will:

      `RON {{money:x}}`   the label was bound to the wrong number
      `{{money:x}} RON`   the same, on the suffix side
      `RON 7,692,203`     a money figure the templatizer could not bind
      `|bare`             a placeholder that lost its label

    Prose that merely MENTIONS the currency ("a company reporting in RON
    carries this position at the closing rate") is untouched: the checks
    are adjacency-based, so a currency word followed by an ordinary word
    is not a hit.
    """
    cur = re.escape((currency or "RON").upper())
    hits = []  # type: List[str]
    patterns = (
        (r"\b" + cur + r"\s*\{\{money:", "label before a placeholder"),
        (r"\}\}\s*" + cur + r"\b", "label after a placeholder"),
        (r"\b" + cur + r"\s+-?\d", "unbound money figure"),
        (r"\{\{money:[A-Za-z0-9_]+\|[^}]*\bbare\b", "placeholder stripped of its label"),
    )
    for pattern, reason in patterns:
        for m in re.finditer(pattern, template or ""):
            hits.append("%s at %d (%r)" % (reason, m.start(), m.group(0)))
    return hits


# ── Impact constructors (the only sanctioned ones) ───────────────────────


def _assert_units_compatible(a: "_ratio_units.Quantity",
                             b: "_ratio_units.Quantity") -> None:
    """Public-API-only compatibility probe. `ratio` raises
    `UnitMismatchError` on a unit / currency / scale boundary and
    `UndefinedRatioError` on a zero denominator; only the first is a bug
    here, so the second is swallowed."""
    try:
        _ratio_units.ratio(a, b)
    except _ratio_units.UndefinedRatioError:
        pass


def ratio_impact(metric: str, metric_label: str,
                 numerator: "_ratio_units.Quantity",
                 denominator: "_ratio_units.Quantity",
                 adjusted_numerator: Optional["_ratio_units.Quantity"] = None,
                 adjusted_denominator: Optional["_ratio_units.Quantity"] = None,
                 unit: str = UNIT_RATIO) -> Impact:
    """A RECOMPUTED ratio: the metric as reported, and the metric with the
    finding's subject removed (or restated). Both quotients go through
    `_ratio_units.ratio`, so both operands of each are same-unit,
    same-currency, same-scale or the impact is not produced at all."""
    baseline = _ratio_units.ratio(numerator, denominator)
    adj_num = adjusted_numerator if adjusted_numerator is not None else numerator
    adj_den = adjusted_denominator if adjusted_denominator is not None else denominator
    adjusted = _ratio_units.ratio(adj_num, adj_den)
    return Impact(
        kind="recomputed_ratio", metric=metric, metric_label=metric_label,
        baseline=baseline, adjusted=adjusted, delta=adjusted - baseline,
        unit=unit, currency=None,
    )


def money_impact(metric: str, metric_label: str,
                 baseline: "_ratio_units.Quantity",
                 adjusted: "_ratio_units.Quantity") -> Impact:
    """A money delta. Both operands must be the same currency at the same
    scale — the kRON/RON collision `_ratio_units` was built for applies
    to a subtraction exactly as it does to a division."""
    _assert_units_compatible(baseline, adjusted)
    if baseline.unit != UNIT_MONEY:
        raise _ratio_units.UnitMismatchError(
            baseline, adjusted, "money_impact needs money operands")
    return Impact(
        kind="money_delta", metric=metric, metric_label=metric_label,
        baseline=baseline.value, adjusted=adjusted.value,
        delta=adjusted.value - baseline.value,
        unit=UNIT_MONEY, currency=baseline.currency,
        baseline_fact=baseline.name, adjusted_fact=adjusted.name,
    )


def headroom_impact(metric: str, metric_label: str,
                    observed: "_ratio_units.Quantity",
                    limit: "_ratio_units.Quantity") -> Impact:
    """How far past (or short of) a limit the company sits, in the
    limit's own units. `baseline` is the limit, `adjusted` the observed
    value, so `delta` reads as the breach."""
    _assert_units_compatible(observed, limit)
    return Impact(
        kind="headroom", metric=metric, metric_label=metric_label,
        baseline=limit.value, adjusted=observed.value,
        delta=observed.value - limit.value,
        unit=limit.unit, currency=limit.currency,
    )


# ── Validation results ───────────────────────────────────────────────────


@dataclass(frozen=True)
class Missing:
    element: str
    reason: str

    def render(self) -> str:
        return "%s: %s" % (self.element, self.reason)


@dataclass(frozen=True)
class Verdict:
    surfaced: bool
    missing: Tuple[Missing, ...]

    def missing_elements(self) -> Tuple[str, ...]:
        out = []  # type: List[str]
        for m in self.missing:
            if m.element not in out:
                out.append(m.element)
        return tuple(out)

    def reasons(self) -> Tuple[str, ...]:
        return tuple(m.render() for m in self.missing)


@dataclass(frozen=True)
class RenderedFinding:
    title: str
    body: str
    title_template: str
    body_template: str
    fact_units: Dict[str, str]


# ── The Finding ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Finding:
    """Seven typed elements, plus the identity a stored alert needs.

    NOTE the absence of a `surfaced` field. Surfacing is a VERDICT this
    object computes about itself, never a property a caller sets. The
    only serializer stamps it from `validate()`.
    """

    rule_id: str
    severity: str
    category: str
    currency: str

    subject: Optional[Subject] = None
    evidence: Optional[Evidence] = None
    threshold: Optional[Threshold] = None
    impact: Optional[Impact] = None
    why_here: Optional[WhyHere] = None
    action: Optional[Action] = None
    confidence: Optional[Confidence] = None

    #: The profile that QUALIFIED this finding (law point 4). Empty
    #: string is a missing why-here, not a default.
    profile_id: str = ""
    profile_fingerprint: str = ""

    #: Everything the templates may bind to, name -> native value.
    facts_cited: Dict[str, float] = field(default_factory=dict)

    #: Set by `apply_advisory_narrative`; audit only, never trusted.
    narrative_source: str = "deterministic"

    # ── validation ──────────────────────────────────────────────────

    def validate(self) -> List[Missing]:
        """Every element that is missing or malformed. Empty list == the
        finding may be surfaced. This is the ONLY definition of
        'complete'; nothing else in the codebase gets to have an
        opinion."""
        missing = []  # type: List[Missing]
        missing.extend(self._check_subject())
        missing.extend(self._check_evidence())
        missing.extend(self._check_threshold())
        missing.extend(self._check_impact())
        missing.extend(self._check_why_here())
        missing.extend(self._check_action())
        missing.extend(self._check_confidence())
        # Prose gates run only when the seven are structurally present —
        # otherwise `render()` cannot run and the reasons would be noise.
        if not missing:
            missing.extend(self._check_prose())
        return missing

    def verdict(self) -> Verdict:
        missing = self.validate()
        return Verdict(surfaced=not missing, missing=tuple(missing))

    # -- element checks --------------------------------------------------

    def _check_subject(self) -> List[Missing]:
        s = self.subject
        if s is None:
            return [Missing(ELEMENT_SUBJECT, "no subject supplied")]
        out = []  # type: List[Missing]
        if not s.accounts:
            out.append(Missing(ELEMENT_SUBJECT, "no accounts named"))
        for a in s.accounts:
            if not a.code or not _ACCOUNT_CODE_RX.match(a.code):
                out.append(Missing(ELEMENT_SUBJECT,
                                   "account code %r is not a ledger code" % a.code))
            if not (a.name or "").strip():
                out.append(Missing(ELEMENT_SUBJECT,
                                   "account %s has no name" % a.code))
        if not (s.scope or "").strip():
            out.append(Missing(ELEMENT_SUBJECT, "no scope phrase"))
        return out

    def _check_evidence(self) -> List[Missing]:
        e = self.evidence
        if e is None:
            return [Missing(ELEMENT_EVIDENCE, "no evidence supplied")]
        out = []  # type: List[Missing]
        if len(e.figures) < MIN_FIGURES:
            out.append(Missing(
                ELEMENT_EVIDENCE,
                "%d figure(s) cited, contract requires %d" % (len(e.figures), MIN_FIGURES)))
        for fig in e.figures:
            if fig.unit == UNIT_UNKNOWN or not fig.unit:
                out.append(Missing(ELEMENT_EVIDENCE,
                                   "figure %r has an undeclared unit" % fig.fact))
            declared = _ratio_units.unit_for_fact(fig.fact)
            if declared != UNIT_UNKNOWN and declared != fig.unit:
                out.append(Missing(
                    ELEMENT_EVIDENCE,
                    "figure %r declared %s in _ratio_units but cited as %s"
                    % (fig.fact, declared, fig.unit)))
            if fig.fact not in self.facts_cited:
                out.append(Missing(ELEMENT_EVIDENCE,
                                   "figure %r is not in facts_cited" % fig.fact))
            elif not _close(float(self.facts_cited[fig.fact]), float(fig.value)):
                out.append(Missing(
                    ELEMENT_EVIDENCE,
                    "figure %r disagrees with facts_cited (%r vs %r)"
                    % (fig.fact, fig.value, self.facts_cited[fig.fact])))
            if not (fig.label or "").strip():
                out.append(Missing(ELEMENT_EVIDENCE,
                                   "figure %r has no label" % fig.fact))
        p = e.provenance
        if p is None or not (p.period_id or "").strip():
            out.append(Missing(ELEMENT_EVIDENCE, "provenance has no period_id"))
        elif not p.snapshot_id and not p.line_refs:
            out.append(Missing(ELEMENT_EVIDENCE,
                               "provenance names neither a snapshot nor a line"))
        cb = e.comparison_basis
        if cb is None:
            out.append(Missing(ELEMENT_EVIDENCE, "no comparison basis"))
        else:
            if cb.kind not in COMPARISON_BASIS_KINDS:
                out.append(Missing(ELEMENT_EVIDENCE,
                                   "comparison basis kind %r is not known" % cb.kind))
            if not (cb.description or "").strip():
                out.append(Missing(ELEMENT_EVIDENCE,
                                   "comparison basis has no description"))
        return out

    def _check_threshold(self) -> List[Missing]:
        t = self.threshold
        if t is None:
            return [Missing(ELEMENT_THRESHOLD, "no threshold supplied")]
        out = []  # type: List[Missing]
        if not (t.rule_id or "").strip():
            out.append(Missing(ELEMENT_THRESHOLD, "no rule_id"))
        if not (t.parameter or "").strip():
            out.append(Missing(ELEMENT_THRESHOLD, "no parameter name"))
        if not (t.parameter_label or "").strip():
            out.append(Missing(ELEMENT_THRESHOLD, "no parameter label"))
        if t.comparator not in COMPARATORS:
            out.append(Missing(ELEMENT_THRESHOLD,
                               "comparator %r is not known" % t.comparator))
        if not _finite(t.limit) or not _finite(t.observed):
            out.append(Missing(ELEMENT_THRESHOLD, "limit or observed is not finite"))
        if t.unit == UNIT_UNKNOWN or not t.unit:
            out.append(Missing(ELEMENT_THRESHOLD, "threshold unit is undeclared"))
        if not (t.source or "").strip():
            out.append(Missing(ELEMENT_THRESHOLD,
                               "threshold does not say where its parameter came from"))
        if not out and not t.holds():
            out.append(Missing(
                ELEMENT_THRESHOLD,
                "observed %r does not satisfy %s %r — the rule did not actually fire"
                % (t.observed, t.comparator, t.limit)))
        return out

    def _check_impact(self) -> List[Missing]:
        i = self.impact
        if i is None:
            return [Missing(ELEMENT_IMPACT, "no impact supplied")]
        out = []  # type: List[Missing]
        if i.kind not in IMPACT_KINDS:
            out.append(Missing(ELEMENT_IMPACT, "impact kind %r is not known" % i.kind))
        if not (i.metric_label or "").strip():
            out.append(Missing(ELEMENT_IMPACT, "impact has no metric label"))
        if not _finite(i.baseline) or not _finite(i.adjusted) or not _finite(i.delta):
            out.append(Missing(ELEMENT_IMPACT, "impact values are not finite"))
        elif not _close(i.delta, i.adjusted - i.baseline):
            out.append(Missing(ELEMENT_IMPACT,
                               "delta %r != adjusted - baseline" % i.delta))
        elif _close(i.delta, 0.0):
            out.append(Missing(ELEMENT_IMPACT,
                               "delta is zero — that is not a consequence"))
        if i.unit == UNIT_UNKNOWN or not i.unit:
            out.append(Missing(ELEMENT_IMPACT, "impact unit is undeclared"))
        if i.unit == UNIT_MONEY:
            if not (i.currency or "").strip():
                out.append(Missing(ELEMENT_IMPACT, "money impact carries no currency"))
            # A money endpoint that is not a CITED fact prints as raw
            # digits beside a raw currency word, and only the cited half
            # of the sentence converts for display. Both ends must be
            # facts, and both names must be declared money in
            # `_ratio_units` — the registry stays the authority on what
            # money is.
            for role, name, value in (("baseline", i.baseline_fact, i.baseline),
                                      ("adjusted", i.adjusted_fact, i.adjusted)):
                if not name:
                    out.append(Missing(
                        ELEMENT_IMPACT,
                        "money impact does not say which fact holds its %s" % role))
                    continue
                if _ratio_units.unit_for_fact(name) != UNIT_MONEY:
                    out.append(Missing(
                        ELEMENT_IMPACT,
                        "impact %s cites %r, which _ratio_units does not declare "
                        "as money" % (role, name)))
                if name not in self.facts_cited:
                    out.append(Missing(
                        ELEMENT_IMPACT,
                        "impact %s cites %r, which is not in facts_cited"
                        % (role, name)))
                elif not _close(float(self.facts_cited[name]), float(value)):
                    out.append(Missing(
                        ELEMENT_IMPACT,
                        "impact %s %r disagrees with facts_cited" % (role, name)))
        return out

    def _check_why_here(self) -> List[Missing]:
        w = self.why_here
        if w is None:
            return [Missing(ELEMENT_WHY_HERE, "no why-here supplied")]
        out = []  # type: List[Missing]
        if not (w.profile_id or "").strip():
            out.append(Missing(ELEMENT_WHY_HERE, "why-here names no profile"))
        if not (w.rationale or "").strip():
            out.append(Missing(ELEMENT_WHY_HERE, "why-here has no rationale"))
        if not w.signals:
            out.append(Missing(ELEMENT_WHY_HERE, "why-here cites no profile signal"))
        anchors = [a for a in w.anchors if (a or "").strip()]
        if not anchors:
            out.append(Missing(ELEMENT_WHY_HERE,
                               "why-here declares no company-specific anchor"))
        elif w.rationale:
            low = w.rationale.lower()
            if not any(a.lower() in low for a in anchors):
                out.append(Missing(
                    ELEMENT_WHY_HERE,
                    "rationale mentions none of its anchors %r — it would read "
                    "identically for another company" % (tuple(anchors),)))
        if not (self.profile_id or "").strip():
            out.append(Missing(ELEMENT_WHY_HERE,
                               "finding does not record the qualifying profile"))
        elif w.profile_id and w.profile_id != self.profile_id:
            out.append(Missing(
                ELEMENT_WHY_HERE,
                "why-here profile %r != qualifying profile %r"
                % (w.profile_id, self.profile_id)))
        return out

    def _check_action(self) -> List[Missing]:
        a = self.action
        if a is None:
            return [Missing(ELEMENT_ACTION, "no action supplied")]
        out = []  # type: List[Missing]
        if not a.steps:
            out.append(Missing(ELEMENT_ACTION, "action has no steps"))
        for step in a.steps:
            verb = step.lead_verb()
            if not verb:
                out.append(Missing(ELEMENT_ACTION, "a step has no imperative"))
                continue
            if verb in WEAK_LEAD_VERBS:
                out.append(Missing(
                    ELEMENT_ACTION,
                    "step leads with the non-committal verb %r" % verb))
            elif verb not in IMPERATIVE_VERBS:
                out.append(Missing(
                    ELEMENT_ACTION,
                    "step leads with %r, which is not in the imperative lexicon" % verb))
            if not (step.artefact or "").strip():
                out.append(Missing(ELEMENT_ACTION,
                                   "step %r names no artefact" % step.imperative))
            if not (step.provider or "").strip():
                out.append(Missing(ELEMENT_ACTION,
                                   "step %r names no provider" % step.imperative))
        return out

    def _check_confidence(self) -> List[Missing]:
        c = self.confidence
        if c is None:
            return [Missing(ELEMENT_CONFIDENCE,
                            "no confidence position — a null caveat is allowed, "
                            "a null position is not")]
        out = []  # type: List[Missing]
        if c.level not in CONFIDENCE_LEVELS:
            out.append(Missing(ELEMENT_CONFIDENCE,
                               "level %r is not one of %r" % (c.level, CONFIDENCE_LEVELS)))
        if not (c.basis or "").strip():
            out.append(Missing(ELEMENT_CONFIDENCE, "confidence states no basis"))
        if c.level in ("medium", "low") and not (c.caveat or "").strip():
            out.append(Missing(ELEMENT_CONFIDENCE,
                               "level %r without a caveat" % c.level))
        return out

    def _check_prose(self) -> List[Missing]:
        out = []  # type: List[Missing]
        try:
            rendered = self.render()
        except (UnknownUnitError, OrphanCurrencyLabelError,
                _ratio_units.MissingFactError) as exc:
            return [Missing(ELEMENT_PROSE, "render refused: %s" % exc)]
        text = rendered.title + "\n" + rendered.body
        low = text.lower()
        for phrase in BANNED_PHRASES:
            if phrase in low:
                out.append(Missing(ELEMENT_PROSE, "banned phrasing %r" % phrase))
        shown = [f for f in (self.evidence.figures if self.evidence else ())
                 if f.render(self.currency) in text]
        if len(shown) < MIN_FIGURES:
            out.append(Missing(
                ELEMENT_PROSE,
                "only %d cited figure(s) reach the prose, contract requires %d"
                % (len(shown), MIN_FIGURES)))
        if len(_NUMBER_RX.findall(text)) < MIN_FIGURES:
            out.append(Missing(ELEMENT_PROSE, "fewer than %d numbers in the text"
                               % MIN_FIGURES))
        verbs = [s.lead_verb() for s in (self.action.steps if self.action else ())]
        if not any(v in low for v in verbs if v):
            out.append(Missing(ELEMENT_PROSE, "no imperative verb reaches the prose"))
        codes = self.subject.codes() if self.subject else ()
        if not any(c in text for c in codes):
            out.append(Missing(ELEMENT_PROSE,
                               "no subject account code reaches the prose — the "
                               "sentence is not about a specific book"))
        return out

    # ── rendering ───────────────────────────────────────────────────

    def render(self) -> RenderedFinding:
        """Compose the seven elements into prose, then DERIVE the typed
        placeholders from that prose with `_ratio_units.templatize` — so
        `render_native(template) == body` byte-for-byte and the template
        cannot drift from the fallback string."""
        cur = (self.currency or "RON").upper()
        title = self._render_title(cur)
        body = self._render_body(cur)
        facts = dict(self.facts_cited)
        title_template = _ratio_units.templatize(title, facts, cur)
        body_template = _ratio_units.templatize(body, facts, cur)
        orphans = (_orphan_currency_labels(title_template, cur)
                   + _orphan_currency_labels(body_template, cur))
        if orphans:
            raise OrphanCurrencyLabelError(
                "currency label(s) left outside a placeholder: %s"
                % "; ".join(orphans))
        return RenderedFinding(
            title=title,
            body=body,
            title_template=title_template,
            body_template=body_template,
            fact_units=_ratio_units.units_for(facts),
        )

    def _render_title(self, cur: str) -> str:
        t = self.threshold
        s = self.subject
        w = self.why_here
        return "%s at %s — %s the %s %s for %s" % (
            s.scope,
            _format_value(t.observed, t.unit, cur),
            COMPARATORS[t.comparator],
            _format_value(t.limit, t.unit, cur),
            t.parameter_label,
            w.profile_label,
        )

    def _render_body(self, cur: str) -> str:
        e, t, i, w, a, c = (self.evidence, self.threshold, self.impact,
                            self.why_here, self.action, self.confidence)
        # An em dash, not a space, between a figure's LABEL and its value.
        # A label may legitimately end in an account code ("balance on
        # 461"), and `templatize`'s token regex would then bind the
        # following currency word to that code as a suffix — see
        # OrphanCurrencyLabelError. The dash breaks the adjacency.
        figs = "; ".join("%s — %s" % (f.label, f.render(cur)) for f in e.figures)
        paras = []  # type: List[str]
        paras.append(
            "%s: %s. Basis: %s. Source: %s."
            % (self.subject.render(), figs, e.comparison_basis.description,
               e.provenance.render()))
        paras.append(
            "Rule %s fires when %s is %s %s; observed %s."
            % (t.rule_id, t.parameter_label, COMPARATORS[t.comparator],
               _format_value(t.limit, t.unit, cur),
               _format_value(t.observed, t.unit, cur)))
        paras.append("Impact: %s." % i.render(cur))
        paras.append(w.rationale.rstrip(".") + ".")
        steps = " ".join("%d) %s" % (n + 1, step.render())
                         for n, step in enumerate(a.steps))
        paras.append("Do this: " + steps)
        paras.append(c.render())
        return " ".join(paras)

    # ── serialization — the ONLY exit, and it validates ─────────────

    def to_payload(self) -> Dict[str, Any]:
        """The alert row. `surfaced` is computed HERE from `validate()`;
        it is not an argument and there is no other serializer, so a
        caller who forgets to validate gets a demoted row rather than a
        generic finding on someone's dashboard."""
        verdict = self.verdict()
        payload = {
            "rule_key": self.rule_id,
            "severity": self.severity,
            "category": self.category,
            "source_currency": (self.currency or "RON").upper(),
            "facts_cited": dict(self.facts_cited),
            "profile_id": self.profile_id,
            "profile_fingerprint": self.profile_fingerprint,
            "narrative_source": self.narrative_source,
            "surfaced": verdict.surfaced,
            "demoted": not verdict.surfaced,
            "missing_elements": list(verdict.missing_elements()),
            "demotion_reasons": list(verdict.reasons()),
            "contract_elements": {
                ELEMENT_SUBJECT: _as_dict(self.subject),
                ELEMENT_EVIDENCE: _as_dict(self.evidence),
                ELEMENT_THRESHOLD: _as_dict(self.threshold),
                ELEMENT_IMPACT: _as_dict(self.impact),
                ELEMENT_WHY_HERE: _as_dict(self.why_here),
                ELEMENT_ACTION: _as_dict(self.action),
                ELEMENT_CONFIDENCE: _as_dict(self.confidence),
            },
        }
        if verdict.surfaced:
            rendered = self.render()
            payload["title"] = rendered.title
            payload["body"] = rendered.body
            payload["title_template"] = rendered.title_template
            payload["body_template"] = rendered.body_template
            payload["fact_units"] = rendered.fact_units
        else:
            # A demoted finding still reaches the raw "All checks" list —
            # with the rule and the numbers, and without prose that would
            # pretend to be an insight.
            payload["title"] = None
            payload["body"] = None
            payload["check_summary"] = self.check_record().to_payload()
        return payload

    def check_record(self) -> "CheckRecord":
        """The raw "All checks" row — what a demoted finding degrades to.
        Carries the rule and the numbers, and no prose."""
        t = self.threshold
        verdict = self.verdict()
        note = ""
        if verdict.missing:
            note = "demoted: " + "; ".join(verdict.reasons())
        return CheckRecord(
            rule_id=(self.rule_id if t is None else t.rule_id),
            parameter=("" if t is None else t.parameter),
            comparator=("" if t is None else t.comparator),
            limit=(None if t is None else t.limit),
            observed=(None if t is None else t.observed),
            unit=(UNIT_UNKNOWN if t is None else t.unit),
            fired=bool(t is not None and t.holds()),
            profile_id=self.profile_id,
            note=note,
        )


def _as_dict(obj: Any) -> Optional[Dict[str, Any]]:
    if obj is None:
        return None
    out = {}  # type: Dict[str, Any]
    for key in obj.__dataclass_fields__:  # type: ignore[attr-defined]
        value = getattr(obj, key)
        if isinstance(value, tuple):
            out[key] = [_as_dict(v) if hasattr(v, "__dataclass_fields__") else v
                        for v in value]
        elif hasattr(value, "__dataclass_fields__"):
            out[key] = _as_dict(value)
        else:
            out[key] = value
    return out


def _finite(value: Any) -> bool:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return False
    return v == v and v not in (float("inf"), float("-inf"))


def _close(a: float, b: float, tol: float = 1e-9) -> bool:
    return abs(float(a) - float(b)) <= tol * max(1.0, abs(float(a)), abs(float(b)))


# ── "All checks" — the demotion floor, and the proof of silence ──────────


@dataclass(frozen=True)
class CheckRecord:
    """One check that RAN, whether or not it fired. This is what makes
    silence a claim instead of an absence: 'nothing material' is only
    honest next to the list of what was examined."""

    rule_id: str
    parameter: str = ""
    comparator: str = ""
    limit: Optional[float] = None
    observed: Optional[float] = None
    unit: str = UNIT_UNKNOWN
    fired: bool = False
    profile_id: str = ""
    note: str = ""

    def to_payload(self) -> Dict[str, Any]:
        return {
            "rule_id": self.rule_id, "parameter": self.parameter,
            "comparator": self.comparator, "limit": self.limit,
            "observed": self.observed, "unit": self.unit,
            "fired": self.fired, "profile_id": self.profile_id,
            "note": self.note,
        }


class FindingSet(object):
    """Collector. Partitions by VERDICT, never by caller intent, and
    carries the checks performed so a quiet period can say what it
    looked at."""

    def __init__(self, profile_id: str = "", profile_fingerprint: str = "") -> None:
        self.profile_id = profile_id
        self.profile_fingerprint = profile_fingerprint
        self._findings = []  # type: List[Finding]
        self._checks = []  # type: List[CheckRecord]

    def add(self, finding: Finding) -> Verdict:
        self._findings.append(finding)
        self._checks.append(finding.check_record())
        return finding.verdict()

    def record_check(self, check: CheckRecord) -> None:
        """A check that ran and did NOT fire. Silence needs these."""
        self._checks.append(check)

    @property
    def surfaced(self) -> List[Finding]:
        return [f for f in self._findings if f.verdict().surfaced]

    @property
    def demoted(self) -> List[Finding]:
        return [f for f in self._findings if not f.verdict().surfaced]

    def payloads(self) -> List[Dict[str, Any]]:
        return [f.to_payload() for f in self._findings]

    def all_checks(self) -> List[Dict[str, Any]]:
        return [c.to_payload() for c in self._checks]

    def silence_statement(self) -> Optional[Dict[str, Any]]:
        """`None` when something surfaced. Otherwise the exact claim:
        nothing material, and here is what was checked. Never filler."""
        if self.surfaced:
            return None
        return {
            "material_findings": 0,
            "profile_id": self.profile_id,
            "checks_performed": len(self._checks),
            "statement": (
                "No finding met the seven-element contract for this period. "
                "%d check(s) ran; each is listed with its parameter, its limit "
                "and the observed value." % len(self._checks)
            ),
            "checks": self.all_checks(),
        }


# ── The advisory seam ────────────────────────────────────────────────────


def _numeric_fingerprint(f: Finding) -> str:
    payload = {
        "facts": {k: repr(float(v)) for k, v in sorted(f.facts_cited.items())},
        "figures": [[fig.fact, repr(float(fig.value)), fig.unit]
                    for fig in (f.evidence.figures if f.evidence else ())],
        "threshold": ([f.threshold.rule_id, f.threshold.parameter,
                       f.threshold.comparator, repr(float(f.threshold.limit)),
                       repr(float(f.threshold.observed)), f.threshold.unit]
                      if f.threshold else None),
        "impact": ([f.impact.kind, f.impact.metric, repr(float(f.impact.baseline)),
                    repr(float(f.impact.adjusted)), repr(float(f.impact.delta)),
                    f.impact.unit, f.impact.currency]
                   if f.impact else None),
        "severity": f.severity,
        "profile_id": f.profile_id,
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def apply_advisory_narrative(finding: Finding,
                             rationale: Optional[str] = None,
                             action_steps: Optional[Sequence[ActionStep]] = None
                             ) -> Finding:
    """The ONE thing an advisory model may do to a finding: re-word the
    why-here rationale and the action steps.

    It cannot change a figure, a threshold, an impact, a severity or the
    profile — the numeric fingerprint is taken before and after and a
    mismatch raises. It also cannot rescue a demoted finding: the result
    is re-validated, so a model that writes a hedge back into the
    rationale demotes the finding instead of laundering it.
    """
    before = _numeric_fingerprint(finding)
    out = finding
    if rationale is not None:
        if out.why_here is None:
            raise NarrativeMutationError(
                "cannot re-word a why-here that does not exist")
        out = replace(out, why_here=replace(out.why_here, rationale=rationale))
    if action_steps is not None:
        out = replace(out, action=Action(steps=tuple(action_steps)))
    out = replace(out, narrative_source="advisory")
    after = _numeric_fingerprint(out)
    if before != after:
        raise NarrativeMutationError(
            "advisory rewrite changed a number (%s -> %s); the model explains, "
            "it does not compute" % (before[:12], after[:12]))
    return out


__all__ = [
    "Account", "Action", "ActionStep", "CheckRecord", "ComparisonBasis",
    "Confidence", "Evidence", "Figure", "Finding", "FindingSet", "Impact",
    "Missing", "Provenance", "RenderedFinding", "Subject", "Threshold",
    "Verdict", "WhyHere",
    "ratio_impact", "money_impact", "headroom_impact",
    "apply_advisory_narrative",
    "NarrativeMutationError", "UnknownUnitError", "OrphanCurrencyLabelError",
    "CONTRACT_ELEMENTS", "ALL_GATES", "BANNED_PHRASES", "IMPERATIVE_VERBS",
    "WEAK_LEAD_VERBS", "COMPARATORS", "COMPARISON_BASIS_KINDS", "IMPACT_KINDS",
    "CONFIDENCE_LEVELS", "MIN_FIGURES",
    "ELEMENT_SUBJECT", "ELEMENT_EVIDENCE", "ELEMENT_THRESHOLD", "ELEMENT_IMPACT",
    "ELEMENT_WHY_HERE", "ELEMENT_ACTION", "ELEMENT_CONFIDENCE", "ELEMENT_PROSE",
    "UNIT_MONEY", "UNIT_RATIO", "UNIT_PERCENT", "UNIT_DAYS", "UNIT_COUNT",
    "UNIT_SCORE", "UNIT_UNKNOWN",
]
