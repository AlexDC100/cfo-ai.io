"""AI SHARPENING for findings (engine.ai.finding_sharpen).

The deterministic lane already produces the whole finding: the accounts,
the figures, the rule, the threshold, the recomputed impact, the
materiality, the rank. This module changes exactly two of the seven
contract elements — the WHY-HERE paragraph and the ACTION list — and
produces them in Romanian as well as English.

It cannot do anything else, and that is enforced by shape rather than by
discipline:

  A READ-ONLY VIEW GOES IN, TWO TEXT FIELDS COME OUT.
      :func:`build_view` projects the finding, the company profile and
      the facts-gateway reads into frozen JSON primitives. The projector
      NEVER INVOKES anything it projects: a callable found anywhere in
      the input becomes :data:`CALLABLE_WITHHELD` — it is not called, not
      repr'd, not attribute-walked. There is therefore no mutation API in
      scope at all, and `tests/engine/test_finding_sharpen.py` proves it
      by planting a tripwire at three seams (the Finding, the profile
      payload, the gateway reads) and asserting none of them fires.

  NO MONEY DIGIT ENTERS THE LANGUAGE CHANNEL.
      The view carries the TEMPLATIZED deterministic prose
      (``{{money:total_assets}}``, not ``RON 39,194,178``), money facts
      by NAME + LABEL + PLACEHOLDER with the value withheld, and the
      gateway reads as PRESENT / ABSENT rather than as cents. The model
      is handed the token vocabulary it is allowed to emit and nothing
      it could copy a figure out of.

  NUMERALS ARE RESOLVED PLACEHOLDERS ONLY.
      Model text may contain ``{{money:FACT}}`` (resolved through
      ``_ratio_units.render_native``, so the printed figure is the
      engine's own) and the subject's ledger account codes, which are
      identifiers rather than quantities. ANY other numeral —
      "grown 47% since last year", "within 30 days", "2024" — is a
      number the engine never computed. It is rejected at parse, logged,
      and the deterministic template is used instead. That is the 461
      lesson generalised: a figure the engine did not produce cannot be
      converted, cannot be traced, and must never reach a reader.

  THE ADVERSARIAL SELF-REVIEW — the anti-generic net.
      A second, flagship pass reads the candidate text back and scores
      it for specificity: would this sentence read identically for a
      DIFFERENT company? Text below the floor is returned for ONE
      regeneration carrying the critique; a second failure falls back to
      the deterministic template. Every score is appended to the AI
      journal (:func:`journal_record`), so the distribution is
      reportable (:func:`score_distribution`) rather than anecdotal.

  EVERY RESULT GOES THROUGH THE SEAM.
      Nothing here constructs a Finding. The only way text becomes a
      finding is ``_finding.apply_advisory_narrative``, which
      fingerprints the numerics before and after and raises
      ``NarrativeMutationError`` if a figure, a threshold, an impact, a
      severity or the profile moved. A DEMOTED finding is never
      sharpened at all — the model cannot rescue one, cannot create one,
      cannot rank one and cannot suppress one.

THREE STATES, ONE BEHAVIOUR
    live            the model drafts and the reviewer scores.
    credits absent  the client factory fails honestly.
    breaker open    the role's daily cap is spent (:class:`BreakerOpen`).
  All three degrade to the deterministic template calmly, carrying a
  human-readable reason. A raw model payload NEVER appears in a reason;
  raw text goes to the journal, which is an audit surface.

ROMANIAN IS ADDITIVE, AND ABSENT WHEN IT CANNOT BE EARNED
    The deterministic templates are authored in English. When the
    advisory pass cannot run, there is no Romanian rendering to show and
    this module says so rather than shipping a machine-shaped guess.
    ABSENT is not ZERO; silence is valid.

IMPORT DISCIPLINE
    ``engine.api`` is imported LAZILY (its package ``__init__`` builds
    the FastAPI app). This module is safe to import from anywhere in
    ``engine.ai``; it pulls the finding types only when it actually runs.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from . import breaker, registry

logger = logging.getLogger("engine.ai.finding_sharpen")


# ── Roles ────────────────────────────────────────────────────────────────

#: The DRAFTING role. `narrative` already declares itself as the role
#: that "writes the briefing AND backs finding sharpening" in models.yaml
#: and carries deliberate caps (300 calls / 3,000,000 tokens per day).
ROLE_DRAFT = "narrative"

#: The ADVERSARIAL SELF-REVIEW role — a second, flagship pass whose only
#: job is to answer "would this read identically for another company?".
#: Separate from the drafting role on purpose: a writer grading its own
#: output is not a net, and the two have different cost profiles.
ROLE_REVIEW = "finding_specificity"

#: Prompt versions. Bump on ANY change to the prompt text below — the
#: journal records them, so a score distribution can be attributed to
#: the prompt that produced it.
DRAFT_PROMPT_VERSION = "finding_sharpen_draft_v1"
REVIEW_PROMPT_VERSION = "finding_sharpen_review_v1"


# ── Knobs ────────────────────────────────────────────────────────────────

#: Specificity below this is refused. One regeneration, then the
#: deterministic template. Env-overridable for an ops dial.
SPECIFICITY_FLOOR_ENV = "AI_SHARPEN_SPECIFICITY_FLOOR"
DEFAULT_SPECIFICITY_FLOOR = 0.60

#: The AI journal directory (same data/ convention as the spend breaker;
#: no new datastore). Tests point it at a tmp dir.
JOURNAL_DIR_ENV = "AI_SHARPEN_JOURNAL_DIR"
JOURNAL_FILENAME = "finding_sharpen.jsonl"

#: Ceilings. A view larger than this is a bug upstream, not a prompt.
MAX_VIEW_CHARS = 60_000
MAX_STEPS = 4
MAX_RATIONALE_CHARS = 900
MAX_STEP_FIELD_CHARS = 240

#: What a projected callable becomes. It is NOT called to produce this.
CALLABLE_WITHHELD = "<callable withheld — the view is data, not behaviour>"
#: What a money figure becomes in the language channel.
MONEY_WITHHELD = "<money withheld — cite the placeholder>"
#: What an object the projector does not understand becomes. Built from
#: `type(value).__name__` only: no repr, no attribute access, no call.
OBJECT_WITHHELD = "<%s withheld>"

#: The languages this lane produces.
LANGUAGES = ("en", "ro")


# ── Refusals ─────────────────────────────────────────────────────────────


class SharpenUnavailable(Exception):
    """The advisory pass cannot run (breaker / credits / client / model).

    Carries a HUMAN-READABLE reason. Never a raw model payload — raw
    text belongs in the journal, which is an audit surface, not in a
    sentence a reader sees.
    """

    def __init__(self, reason: str, kind: str = "unavailable") -> None:
        super().__init__(reason)
        self.reason = reason
        self.kind = kind


class AdvisoryNumeralError(ValueError):
    """A model rewrite carried a numeral that is not a resolved
    placeholder (and is not one of the subject's ledger account codes).

    The fingerprint in ``_finding.apply_advisory_narrative`` covers every
    number the ENGINE computed; it cannot see a number the MODEL
    invented, because inventing one moves none of the cited facts. This
    is the guard for that hole.

    A ``ValueError``, like ``NarrativeMutationError`` itself — a caller
    already catching ``ValueError`` around an advisory rewrite keeps
    catching this one. It is not a subclass of ``NarrativeMutationError``
    because that type lives behind a lazy import (``engine.api``'s
    package init builds the FastAPI app) and a base class cannot be
    resolved lazily.
    """

    def __init__(self, violations: Sequence[str]) -> None:
        self.violations = tuple(violations)
        super().__init__(
            "advisory text carries %d numeral(s) the engine never computed: %s"
            % (len(self.violations), "; ".join(self.violations)))


# ── Lazy engine.api access (engine.api.__init__ builds the FastAPI app) ──

_MODULES_LOCK = threading.Lock()
_MODULES = {}  # type: Dict[str, Any]


def _lazy(name: str) -> Any:
    with _MODULES_LOCK:
        mod = _MODULES.get(name)
        if mod is None:
            import importlib

            mod = importlib.import_module(name)
            _MODULES[name] = mod
        return mod


def _F() -> Any:
    """`engine.api._finding`, with the raw seam bound on first sight."""
    module = _lazy("engine.api._finding")
    _bind_raw_apply(module)
    return module


def _bind_raw_apply(module: Any) -> None:
    """Remember the function object `_finding` itself defines.

    Bound ONCE, and never re-read per call, so that installing this
    module's guarded twin onto ``_finding.apply_advisory_narrative``
    (:func:`install_guard`) cannot make the guard call itself. Binding
    the twin would be a stack overflow rather than an error, so it is
    refused loudly instead.
    """
    with _MODULES_LOCK:
        if "__raw_apply__" in _MODULES:
            return
        current = getattr(module, "apply_advisory_narrative", None)
        if current is apply_advisory_narrative:
            raise RuntimeError(
                "engine.api._finding.apply_advisory_narrative is already the "
                "guarded twin and the original was never captured — call "
                "engine.ai.finding_sharpen.install_guard() to install it "
                "instead of assigning the attribute directly")
        _MODULES["__raw_apply__"] = current


def _raw_apply(finding: Any, rationale: Optional[str] = None,
               action_steps: Optional[Sequence[Any]] = None) -> Any:
    """THE seam. Every advisory application in this module goes through
    here, and it is always ``_finding``'s own function."""
    _F()
    return _MODULES["__raw_apply__"](finding, rationale=rationale,
                                     action_steps=action_steps)


def install_guard(finding_module: Any = None) -> Any:
    """Install :func:`apply_advisory_narrative` as ``_finding``'s advisory
    seam, so EVERY caller gets the numeral guard rather than only this
    lane's callers.

    This is the one line the findings gate lane needs to close F9 (see
    ``tests/engine/test_findings_gates.py``'s
    ``_NUMERAL_GUARD_CANDIDATES``). It captures the original function
    BEFORE overwriting it, and is idempotent, so importing the shim twice
    is harmless.

    Deliberately NOT called at import: an engine module that rewires
    another module's public function as a side effect of being imported
    is a trap. Installing it is an explicit act, made in
    ``engine.api``'s own tree by whoever owns that decision.
    """
    module = finding_module if finding_module is not None \
        else _lazy("engine.api._finding")
    with _MODULES_LOCK:
        _MODULES.setdefault("engine.api._finding", module)
        current = getattr(module, "apply_advisory_narrative", None)
        if current is not apply_advisory_narrative:
            _MODULES["__raw_apply__"] = current
        module.apply_advisory_narrative = apply_advisory_narrative
    return module.apply_advisory_narrative


def _RU() -> Any:
    """`engine.api._ratio_units`."""
    return _lazy("engine.api._ratio_units")


# ══ 1. THE READ-ONLY VIEW ════════════════════════════════════════════════


_PLACEHOLDER_RX = re.compile(r"\{\{money:(?P<name>[A-Za-z0-9_]+)(?P<opts>(?:\|[^}]*)?)\}\}")
#: The same numeral shape `_finding` lints prose with, so the guard and
#: the runtime cannot drift apart.
_NUMBER_RX = re.compile(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?")
#: Currency words that must never sit loose beside a figure (the 461
#: class of defect: one claim, two currencies).
_CURRENCY_WORDS = ("RON", "LEI", "EUR", "USD", "GBP", "HUF")


@dataclass(frozen=True)
class SharpenView:
    """Everything the model is allowed to see, as frozen primitives.

    There is no engine object in here and no callable in here. Building
    one is the ONLY way into the model call, which is what makes "the
    model cannot create, rank, suppress or alter a finding" a property of
    the shape rather than a promise in a docstring.
    """

    payload: Dict[str, Any]
    money_facts: Tuple[str, ...]
    account_codes: Tuple[str, ...]
    anchors: Tuple[str, ...]
    currency: str
    rule_id: str
    profile_id: str
    period_id: str

    def as_json(self) -> str:
        return json.dumps(self.payload, sort_keys=True, ensure_ascii=False,
                          indent=1)[:MAX_VIEW_CHARS]

    def fingerprint(self) -> str:
        return hashlib.sha256(
            json.dumps(self.payload, sort_keys=True,
                       ensure_ascii=False).encode("utf-8")).hexdigest()


def _freeze(value: Any, depth: int = 0) -> Any:
    """Project any value into JSON primitives WITHOUT EXECUTING IT.

    A callable is replaced, never called. An object the projector does
    not understand is named by its TYPE — no `repr`, which would run
    user code on the way out. Dataclasses are walked by their declared
    fields; mappings and sequences are walked structurally.
    """
    if depth > 8:
        return "<depth limit>"
    if value is None or isinstance(value, (str, int, float, bool)):
        # bool is an int; both are safe primitives. A float subclass that
        # happens to be callable is still a number here — it is never
        # called, which is the property under test.
        return value
    if callable(value):
        return CALLABLE_WITHHELD
    if isinstance(value, dict):
        out = {}  # type: Dict[str, Any]
        for key in value:
            if not isinstance(key, str):
                key = OBJECT_WITHHELD % type(key).__name__
            out[key] = _freeze(value[key], depth + 1)
        return out
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_freeze(v, depth + 1) for v in value]
    fields = getattr(type(value), "__dataclass_fields__", None)
    if fields:
        return dict((name, _freeze(getattr(value, name, None), depth + 1))
                    for name in fields)
    return OBJECT_WITHHELD % type(value).__name__


def _money_fact_names(facts: Dict[str, Any]) -> Tuple[str, ...]:
    RU = _RU()
    names = []  # type: List[str]
    for name in sorted(facts or {}):
        try:
            if RU.unit_for_fact(name) == RU.UNIT_MONEY:
                names.append(name)
        except Exception:  # noqa: BLE001 — an unclassifiable name is not money
            continue
    return tuple(names)


def _is_money_unit(unit: Any) -> bool:
    return unit == _RU().UNIT_MONEY


def _figure_refs(finding: Any) -> List[Dict[str, Any]]:
    """The cited figures, with MONEY VALUES WITHHELD and replaced by the
    placeholder token the model is allowed to write."""
    out = []  # type: List[Dict[str, Any]]
    evidence = getattr(finding, "evidence", None)
    for fig in (getattr(evidence, "figures", ()) or ()):
        entry = {"fact": _freeze(getattr(fig, "fact", None)),
                 "unit": _freeze(getattr(fig, "unit", None)),
                 "label": _freeze(getattr(fig, "label", None))}
        if _is_money_unit(getattr(fig, "unit", None)):
            entry["value"] = MONEY_WITHHELD
            entry["placeholder"] = "{{money:%s}}" % getattr(fig, "fact", "")
        else:
            entry["value"] = _freeze(getattr(fig, "value", None))
        out.append(entry)
    return out


def _threshold_ref(finding: Any) -> Optional[Dict[str, Any]]:
    t = getattr(finding, "threshold", None)
    if t is None:
        return None
    money = _is_money_unit(getattr(t, "unit", None))
    return {
        "rule_id": _freeze(t.rule_id),
        "parameter": _freeze(t.parameter),
        "parameter_label": _freeze(t.parameter_label),
        "comparator": _freeze(t.comparator),
        "unit": _freeze(t.unit),
        "limit": MONEY_WITHHELD if money else _freeze(t.limit),
        "observed": MONEY_WITHHELD if money else _freeze(t.observed),
        "source": _freeze(t.source),
    }


def _impact_ref(finding: Any) -> Optional[Dict[str, Any]]:
    i = getattr(finding, "impact", None)
    if i is None:
        return None
    money = _is_money_unit(getattr(i, "unit", None))
    return {
        "kind": _freeze(i.kind),
        "metric": _freeze(i.metric),
        "metric_label": _freeze(i.metric_label),
        "unit": _freeze(i.unit),
        "baseline": MONEY_WITHHELD if money else _freeze(i.baseline),
        "adjusted": MONEY_WITHHELD if money else _freeze(i.adjusted),
        "delta": MONEY_WITHHELD if money else _freeze(i.delta),
        "baseline_fact": _freeze(getattr(i, "baseline_fact", None)),
        "adjusted_fact": _freeze(getattr(i, "adjusted_fact", None)),
    }


#: A three-digit pure-numeric token — the RO synthetic-account shape.
#: Deliberately NOT four digits: 5121 and 5124 are real accounts but so
#: are 1990 and 2024, and a year is a quantity wearing an account's
#: clothes. Four-digit codes reach the whitelist only when the ENGINE
#: named them structurally, through `Subject.accounts` or
#: `Provenance.line_refs`.
_SYNTHETIC_CODE_RX = re.compile(r"(?<![\d.,])(\d{3})(?!\d)(?![.,]\d)")


def allowed_ledger_codes(finding: Any) -> Tuple[str, ...]:
    """The ledger codes a model rewrite may write.

    An account code is an IDENTIFIER, not a quantity: it carries no unit,
    it never converts, and it is the single token that makes a sentence
    about one book rather than about companies in general. So codes are
    whitelisted — but only the ones the ENGINE ITSELF already put in this
    finding:

      · the subject's accounts (structural),
      · the provenance line refs (structural),
      · three-digit synthetic accounts the deterministic why-here and
        action steps already print — the affiliate-income detector cites
        761/762/763 as its subject and names 261/263 in its own action
        step, and refusing the model a code the engine wrote two
        paragraphs earlier buys nothing but a wasted regeneration.

    Anything else is a number the engine never wrote, and the guard
    refuses it. This was measured, not guessed: on the first live run of
    this lane, four of thirteen findings burned their one regeneration
    on a code the deterministic prose had already printed.
    """
    codes = []  # type: List[str]

    def _add(value: Any) -> None:
        text = str(value or "").strip()
        if text and text not in codes:
            codes.append(text)

    subject = getattr(finding, "subject", None)
    for account in (getattr(subject, "accounts", ()) or ()):
        _add(getattr(account, "code", None))
    provenance = getattr(getattr(finding, "evidence", None), "provenance", None)
    for ref in (getattr(provenance, "line_refs", ()) or ()):
        _add(ref)

    engine_prose = [str(getattr(getattr(finding, "why_here", None),
                                "rationale", "") or "")]
    for step in (getattr(getattr(finding, "action", None), "steps", ()) or ()):
        for attr in ("imperative", "artefact", "provider", "horizon"):
            engine_prose.append(str(getattr(step, attr, "") or ""))
    for chunk in engine_prose:
        for match in _SYNTHETIC_CODE_RX.finditer(chunk):
            _add(match.group(1))
    return tuple(codes)


def _comparison_basis_ref(finding: Any) -> Optional[Dict[str, Any]]:
    """The comparison basis, with a MONEY basis value withheld.

    `self_total` bases carry the company's own total as `basis_value` —
    money, and therefore not something the language channel gets to see.
    """
    cb = getattr(getattr(finding, "evidence", None), "comparison_basis", None)
    if cb is None:
        return None
    money = _is_money_unit(getattr(cb, "basis_unit", None))
    return {
        "kind": _freeze(cb.kind),
        "description": _attributable(str(cb.description or ""), finding),
        "basis_unit": _freeze(cb.basis_unit),
        "basis_value": MONEY_WITHHELD if money else _freeze(cb.basis_value),
    }


#: The facts-gateway accessors this lane consults. A WHITELIST, mirroring
#: `engine.ai.advisory._FACT_ACCESSORS` — a gateway attribute outside this
#: list is never touched, so a stand-in carrying a tripwire accessor is
#: never invoked either.
GATEWAY_ACCESSORS = (
    "total_assets", "total_liabilities", "equity", "equity_plus_liabilities",
    "current_assets", "current_liabilities", "working_capital", "difference",
    "net_result", "revenue", "expenses", "ebitda",
)


def gateway_presence(gateway: Any) -> Dict[str, str]:
    """The gateway reads, as PRESENT / ABSENT — never as cents.

    Two reasons the amounts do not come through. First, they are money,
    and no money digit enters the language channel (see the module
    docstring). Second, presence is the honest signal anyway: ABSENT is
    not ZERO, and "the engine has no revenue total for this period" is
    exactly the context that should change how a why-here is written.
    """
    out = {}  # type: Dict[str, str]
    if gateway is None:
        return out
    for name in GATEWAY_ACCESSORS:
        accessor = getattr(gateway, name, None)
        if accessor is None or not callable(accessor):
            out[name] = "unknown"
            continue
        try:
            fact = accessor()
        except Exception:  # noqa: BLE001 — MissingFactError and friends
            out[name] = "absent"
            continue
        out[name] = "present" if fact is not None else "absent"
    return out


def build_view(finding: Any,
               profile: Any,
               gateway: Any = None,
               gateway_facts: Optional[Dict[str, Any]] = None
               ) -> SharpenView:
    """Project a fully-quantified Finding + its company profile + the
    facts-gateway reads into the frozen, execution-free view.

    NOTHING in the inputs is invoked except the profile's own declared
    accessors and the gateway's whitelisted accessors. Every value that
    is projected is projected as data.
    """
    F = _F()
    facts = dict(getattr(finding, "facts_cited", {}) or {})
    money_facts = _money_fact_names(facts)

    subject = getattr(finding, "subject", None)
    accounts = list(getattr(subject, "accounts", ()) or ())
    codes = allowed_ledger_codes(finding)

    try:
        rendered = finding.render()
        title_template = rendered.title_template
        body_template = rendered.body_template
    except Exception as exc:  # noqa: BLE001 — a finding that cannot render
        # is a finding this lane must not touch; the caller sees it in
        # the reason and keeps the deterministic disposition.
        raise SharpenUnavailable(
            "The finding could not be rendered deterministically (%s), so "
            "there is nothing to sharpen." % type(exc).__name__,
            kind="unrenderable")

    why = getattr(finding, "why_here", None)
    action = getattr(finding, "action", None)
    conf = getattr(finding, "confidence", None)

    profile_payload = _freeze(profile.to_payload())
    # Signal VALUES are money on several signals (bank_debt, related_party,
    # revaluation_reserve, cash_fx_component). Keep the state and the basis,
    # drop the amount.
    signals = profile_payload.get("signals")
    if isinstance(signals, dict):
        for sig in signals.values():
            if isinstance(sig, dict) and "value" in sig:
                sig["value"] = MONEY_WITHHELD if sig.get("state") == "present" \
                    else None

    anchors = tuple(str(a) for a in (profile.anchors() or ()) if str(a).strip())

    payload = {
        "contract": {
            "note": ("You may rewrite ONLY why_here.rationale and the action "
                     "steps. Everything else here is fixed and already "
                     "computed."),
            "languages": list(LANGUAGES),
        },
        "finding": {
            "rule_id": _freeze(getattr(finding, "rule_id", None)),
            "severity": _freeze(getattr(finding, "severity", None)),
            "category": _freeze(getattr(finding, "category", None)),
            "currency": _freeze(getattr(finding, "currency", None)),
            "subject": {
                "scope": _attributable(
                str(getattr(subject, "scope", "") or ""), finding),
                "accounts": [
                    {"code": _freeze(getattr(a, "code", None)),
                     "name": _freeze(getattr(a, "name", None)),
                     "statement": _freeze(getattr(a, "statement", None)),
                     "bucket": _freeze(getattr(a, "bucket", None))}
                    for a in accounts],
            },
            "figures": _figure_refs(finding),
            "comparison_basis": _comparison_basis_ref(finding),
            "provenance": _freeze(
                getattr(getattr(finding, "evidence", None), "provenance", None)),
            "threshold": _threshold_ref(finding),
            "impact": _impact_ref(finding),
            "deterministic_why_here": {
                "profile_id": _freeze(getattr(why, "profile_id", None)),
                "profile_label": _freeze(getattr(why, "profile_label", None)),
                "rationale": _attributable(
                    str(getattr(why, "rationale", "") or ""), finding),
                "signals": _freeze(getattr(why, "signals", ())),
                "anchors": list(anchors),
            },
            "deterministic_action_steps": [
                {"imperative": _attributable(
                    str(getattr(step, "imperative", "") or ""), finding),
                 "artefact": _attributable(
                     str(getattr(step, "artefact", "") or ""), finding),
                 "provider": _attributable(
                     str(getattr(step, "provider", "") or ""), finding),
                 "horizon": _attributable(
                     str(getattr(step, "horizon", "") or ""), finding) or None}
                for step in (getattr(action, "steps", ()) or ())],
            "confidence": {
                "level": _freeze(getattr(conf, "level", None)),
                "basis": _attributable(
                    str(getattr(conf, "basis", "") or ""), finding),
                "caveat": _attributable(
                    str(getattr(conf, "caveat", "") or ""), finding) or None,
            },
            "deterministic_title_template": title_template,
            "deterministic_body_template": body_template,
        },
        "company_profile": profile_payload,
        "facts_gateway": (dict(gateway_facts) if gateway_facts is not None
                          else gateway_presence(gateway)),
        "vocabulary": {
            "money_placeholders": ["{{money:%s}}" % n for n in money_facts],
            "money_fact_labels": dict(
                (n, _figure_label(finding, n)) for n in money_facts),
            "account_codes": list(codes),
            "allowed_imperative_verbs_EN": sorted(F.IMPERATIVE_VERBS),
            "banned_lead_verbs_EN": sorted(F.WEAK_LEAD_VERBS),
            "allowed_imperative_verbs_RO": sorted(RO_IMPERATIVE_VERBS),
            "banned_lead_verbs_RO": sorted(RO_WEAK_LEAD_VERBS),
            "ro_verb_note": ("The RO lists are written without diacritics; "
                             "write the real Romanian form (solicita -> "
                             "Solicita/Solicită). Both the singular and the "
                             "-ti plural form are accepted."),
            "banned_phrases": list(F.BANNED_PHRASES),
        },
    }
    # The gateway reads are projected too — a caller-supplied mapping is
    # data like everything else and is never executed.
    payload["facts_gateway"] = _freeze(payload["facts_gateway"])

    return SharpenView(
        payload=payload,
        money_facts=money_facts,
        account_codes=codes,
        anchors=anchors,
        currency=str(getattr(finding, "currency", "RON") or "RON").upper(),
        rule_id=str(getattr(finding, "rule_id", "") or ""),
        profile_id=str(getattr(finding, "profile_id", "") or ""),
        period_id=str(getattr(getattr(getattr(finding, "evidence", None),
                                      "provenance", None), "period_id", "") or ""),
    )


def _figure_label(finding: Any, fact: str) -> str:
    for fig in (getattr(getattr(finding, "evidence", None), "figures", ()) or ()):
        if getattr(fig, "fact", None) == fact:
            return str(getattr(fig, "label", "") or fact)
    return fact


# ══ 2. THE NUMERAL GUARD ═════════════════════════════════════════════════


def numeral_violations(text: str,
                       allowed_codes: Sequence[str] = (),
                       money_facts: Sequence[str] = ()) -> Tuple[str, ...]:
    """Every numeral in `text` that is not a resolved placeholder and not
    one of the subject's ledger account codes.

    Account codes are whitelisted DELIBERATELY and narrowly: "461" is an
    identifier, not a quantity. It carries no unit, never converts, and
    is the single token that makes a sentence about one book rather than
    about companies in general. A YEAR, a PERCENTAGE, a DAY COUNT or a
    MULTIPLE is a quantity, and if the engine did not compute it, it does
    not ship.
    """
    if not text:
        return ()
    violations = []  # type: List[str]
    known = set(str(m) for m in money_facts)

    # 1. Placeholders must name a money fact this finding actually cites.
    for m in _PLACEHOLDER_RX.finditer(text):
        if m.group("name") not in known:
            violations.append(
                "placeholder {{money:%s}} names a fact this finding does not "
                "cite" % m.group("name"))

    # 2. A bare number immediately before a placeholder is the 461
    #    collision: `templatize` binds the currency label to the wrong
    #    number and one claim ends up in two currencies.
    for m in re.finditer(r"\d\s*\{\{money:", text):
        violations.append(
            "a bare number sits immediately before a money placeholder at "
            "offset %d — the label would bind to the wrong figure" % m.start())

    # 3. A currency WORD written by the model is never allowed: the
    #    placeholder carries its own label and converts; a loose word
    #    does not.
    for word in _CURRENCY_WORDS:
        for m in re.finditer(r"\b%s\b\s*(?=\{\{money:|-?\d)" % word, text):
            violations.append(
                "currency label %r written beside a figure at offset %d — the "
                "placeholder carries its own label" % (word, m.start()))
        for m in re.finditer(r"(?:\}\}|\d)\s*\b%s\b" % word, text):
            violations.append(
                "currency label %r written after a figure at offset %d"
                % (word, m.start()))

    # 4. A placeholder that lost its currency label prints a bare figure
    #    beside converted ones. `templatize` marks that case `|bare`; the
    #    finding renderer refuses it, and so does this guard, earlier and
    #    with a reason a person can read.
    for m in re.finditer(r"\{\{money:[A-Za-z0-9_]+\|[^}]*\bbare\b", text):
        violations.append(
            "a money figure at offset %d carries no currency label — it "
            "would print unconverted beside figures that convert" % m.start())

    # 5. Strip the sanctioned tokens, then anything numeric left over is
    #    a number the engine never computed.
    stripped = _PLACEHOLDER_RX.sub(" ", text)
    for code in sorted(set(str(c) for c in allowed_codes if str(c).strip()),
                       key=len, reverse=True):
        # Not a fragment of a longer number ("451" inside "1451" or
        # "451.25"), but a sentence-final "451." is still the code.
        stripped = re.sub(
            r"(?<![\d.,])%s(?!\d)(?![.,]\d)" % re.escape(code), " ", stripped)
    for m in _NUMBER_RX.finditer(stripped):
        violations.append(
            "numeral %r at offset %d is neither a resolved placeholder nor a "
            "subject account code" % (m.group(0), m.start()))
    # Deduplicate while preserving order — one repeated numeral is one
    # defect, not five.
    seen = []  # type: List[str]
    for v in violations:
        if v not in seen:
            seen.append(v)
    return tuple(seen)


def _narrative_text(rationale: Optional[str],
                    action_steps: Optional[Sequence[Any]]) -> str:
    parts = [rationale or ""]
    for step in (action_steps or ()):
        for attr in ("imperative", "artefact", "provider", "horizon"):
            parts.append(str(getattr(step, attr, "") or ""))
    return "\n".join(parts)


def _attributable(text: str, finding: Any) -> str:
    """Lift every CORRECTLY-RENDERED engine figure back into its
    placeholder before the guard looks at the text.

    This is what makes the guard a test of ATTRIBUTION rather than a ban
    on digits. `templatize` is the engine's own authority on which
    printed figure belongs to which cited fact: a figure the engine
    computed disappears into `{{money:fact}}` and the guard never sees a
    numeral; a figure it did not compute stays as digits and is refused.
    An orphaned currency label survives templatization intact, which is
    precisely how the 461 collision announces itself.

    Idempotent, so passing already-placeholdered model text through it is
    a no-op.
    """
    RU = _RU()
    try:
        return RU.templatize(text or "",
                             dict(getattr(finding, "facts_cited", {}) or {}),
                             str(getattr(finding, "currency", "RON") or "RON").upper())
    except Exception:  # noqa: BLE001 — an untemplatizable text is judged raw
        return text or ""


def assert_no_new_numerals(finding: Any,
                           rationale: Optional[str] = None,
                           action_steps: Optional[Sequence[Any]] = None
                           ) -> None:
    """Raise :class:`AdvisoryNumeralError` when an advisory rewrite carries
    a numeral the engine never computed.

    This is the guard the F9 gate looks for. It is deliberately a pure
    predicate: it decides nothing about the finding, it only refuses.
    """
    violations = numeral_violations(
        _attributable(_narrative_text(rationale, action_steps), finding),
        allowed_codes=allowed_ledger_codes(finding),
        money_facts=_money_fact_names(getattr(finding, "facts_cited", {}) or {}),
    )
    if violations:
        raise AdvisoryNumeralError(violations)


def apply_advisory_narrative(finding: Any,
                             rationale: Optional[str] = None,
                             action_steps: Optional[Sequence[Any]] = None
                             ) -> Any:
    """The GUARDED twin of ``_finding.apply_advisory_narrative``.

    Same contract, one addition: a rewrite carrying a numeral the engine
    never computed is REFUSED BY DEMOTION rather than by raising. The
    rewrite is applied through the real seam (so the numeric fingerprint
    is still enforced) and the rationale is then cleared, which the
    contract's own validator reports as a missing why-here — the finding
    lands on the raw "All checks" list instead of on a reader's screen.

    Demotion rather than an exception is deliberate: this function sits
    where a demoted finding is the correct disposition, and an exception
    there would take a whole period's findings down for one bad sentence.
    Callers that want the refusal loudly call
    :func:`assert_no_new_numerals` first — which is what
    :func:`sharpen_finding` does, so a refused draft is regenerated
    rather than demoted.
    """
    violations = numeral_violations(
        _attributable(_narrative_text(rationale, action_steps), finding),
        allowed_codes=allowed_ledger_codes(finding),
        money_facts=_money_fact_names(getattr(finding, "facts_cited", {}) or {}),
    )
    out = _raw_apply(finding, rationale=rationale,
                     action_steps=action_steps)
    if violations:
        logger.warning(
            "[ai.finding_sharpen] REFUSED an advisory rewrite of %s: %s",
            getattr(finding, "rule_id", "?"), "; ".join(violations))
        journal_record({
            "event": "numeral_refusal",
            "rule_id": getattr(finding, "rule_id", None),
            "profile_id": getattr(finding, "profile_id", None),
            "violations": list(violations),
        })
        # Clearing the rationale is the demotion lever the contract
        # already owns: `_check_why_here` reports "why-here has no
        # rationale" and `to_payload` stamps `surfaced=False`.
        out = _raw_apply(out, rationale="")
    return out


# ══ 3. THE AI JOURNAL ════════════════════════════════════════════════════


_JOURNAL_LOCK = threading.Lock()


def _repo_root() -> Path:
    # src/engine/ai/finding_sharpen.py -> parents[3] == repo root (== /app).
    return Path(__file__).resolve().parents[3]


def journal_path(journal_dir: Optional[Any] = None) -> Path:
    if journal_dir is not None:
        return Path(journal_dir) / JOURNAL_FILENAME
    env = os.environ.get(JOURNAL_DIR_ENV)
    if env:
        return Path(env) / JOURNAL_FILENAME
    return _repo_root() / "data" / "ai_journal" / JOURNAL_FILENAME


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def journal_record(entry: Dict[str, Any],
                   journal_dir: Optional[Any] = None) -> None:
    """Append one line to the AI journal. NEVER raises.

    The journal is the audit surface: it is where a raw candidate and a
    rejected draft go, and it is what makes the score distribution
    reportable instead of anecdotal. Nothing here reaches a reader.
    """
    try:
        path = journal_path(journal_dir)
        row = {"v": 1, "at": _now_iso(), "lane": "finding_sharpen"}
        row.update(entry)
        line = json.dumps(row, sort_keys=True, ensure_ascii=False,
                          default=str)
        with _JOURNAL_LOCK:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(str(path), "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
    except Exception:  # noqa: BLE001 — an audit trail never takes serving down
        logger.warning("[ai.finding_sharpen] could not append to the AI journal")


def journal_entries(journal_dir: Optional[Any] = None) -> List[Dict[str, Any]]:
    """Every readable journal line. A corrupt line is skipped, not fatal."""
    path = journal_path(journal_dir)
    out = []  # type: List[Dict[str, Any]]
    try:
        with open(str(path), encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict):
                    out.append(row)
    except FileNotFoundError:
        return []
    except Exception:  # noqa: BLE001
        logger.warning("[ai.finding_sharpen] AI journal unreadable at %s", path)
        return out
    return out


def score_distribution(journal_dir: Optional[Any] = None) -> Dict[str, Any]:
    """The measured specificity distribution — what the anti-generic net
    actually scored, not what it was hoped to score."""
    rows = [r for r in journal_entries(journal_dir)
            if r.get("event") == "specificity_score"
            and isinstance(r.get("specificity"), (int, float))]
    scores = sorted(float(r["specificity"]) for r in rows)
    outcomes = {}  # type: Dict[str, int]
    by_rule = {}  # type: Dict[str, List[float]]
    for r in rows:
        outcome = str(r.get("outcome") or "unknown")
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
        rule = str(r.get("rule_id") or "?")
        by_rule.setdefault(rule, []).append(float(r["specificity"]))
    summary = {
        "count": len(scores),
        "floor": specificity_floor(),
        "outcomes": outcomes,
        "by_rule": dict((k, {"count": len(v), "mean": _mean(v),
                             "min": min(v), "max": max(v)})
                        for k, v in sorted(by_rule.items())),
    }
    if scores:
        summary.update({
            "min": scores[0],
            "max": scores[-1],
            "mean": _mean(scores),
            "median": _quantile(scores, 0.5),
            "p10": _quantile(scores, 0.1),
            "p90": _quantile(scores, 0.9),
            "below_floor": sum(1 for s in scores if s < specificity_floor()),
            "scores": scores,
        })
    return summary


def _mean(values: Sequence[float]) -> float:
    return round(sum(values) / float(len(values)), 4) if values else 0.0


def _quantile(sorted_values: Sequence[float], q: float) -> float:
    if not sorted_values:
        return 0.0
    idx = int(round(q * (len(sorted_values) - 1)))
    return float(sorted_values[max(0, min(idx, len(sorted_values) - 1))])


def specificity_floor() -> float:
    raw = os.environ.get(SPECIFICITY_FLOOR_ENV)
    if raw:
        try:
            return max(0.0, min(1.0, float(raw)))
        except ValueError:
            logger.warning("[ai.finding_sharpen] %s=%r is not a number; using %.2f",
                           SPECIFICITY_FLOOR_ENV, raw, DEFAULT_SPECIFICITY_FLOOR)
    return DEFAULT_SPECIFICITY_FLOOR


# ══ 4. THE PROMPTS ═══════════════════════════════════════════════════════


_DRAFT_SYSTEM = (
    "You sharpen ONE element pair of an already-complete financial "
    "finding: the WHY-HERE paragraph and the ACTION list. Everything "
    "else — the accounts, the figures, the rule, the threshold, the "
    "recomputed impact, the severity — is already computed by a "
    "deterministic engine and is NOT yours to change, question, rank or "
    "suppress.\n"
    "\n"
    "HARD RULES.\n"
    "1. NEVER write a numeral. Not a percentage, not a year, not a date, "
    "not a day count, not a multiple, not a money amount, not a statute "
    "or article number, and not a ledger account code that is not in the "
    "list below. The ONLY numerals you may write are (a) the placeholder "
    "tokens listed in vocabulary.money_placeholders, copied verbatim, "
    "and (b) the ledger account codes listed in "
    "vocabulary.account_codes (the codes the engine itself already named "
    "in this finding). Any other digit causes your whole answer "
    "to be discarded, so name other accounts and laws in WORDS ('the "
    "trade payables account', 'the companies act') rather than by "
    "number.\n"
    "2. NEVER write a currency word (RON, EUR, LEI, USD). The "
    "placeholder carries its own label.\n"
    "3. NEVER put a placeholder immediately after a bare number or an "
    "account code — put a word, a dash or a comma between them.\n"
    "4. The English rationale MUST contain, verbatim, at least one "
    "string from finding.deterministic_why_here.anchors. Both language "
    "rationales must name at least one account code.\n"
    "5. Every ENGLISH action step's `imperative` MUST begin with a verb "
    "from vocabulary.allowed_imperative_verbs_EN and MUST NOT begin with "
    "one from vocabulary.banned_lead_verbs_EN. Every ROMANIAN action "
    "step's `imperative` MUST begin with a ROMANIAN verb from "
    "vocabulary.allowed_imperative_verbs_RO and MUST NOT begin with one "
    "from vocabulary.banned_lead_verbs_RO — an English verb at the head "
    "of a Romanian step discards the whole Romanian block. Every step "
    "needs a concrete `artefact` (the document or calculation to obtain) "
    "and a `provider` (who typically hands it over), written in that "
    "step's own language.\n"
    "6. None of vocabulary.banned_phrases may appear in any language.\n"
    "7. Say what is true for THIS company: this profile, this financing "
    "shape, these signals, these accounts. A sentence that would read "
    "identically for a different company is a failure.\n"
    "8. The Romanian text is a peer, not a translation artefact: same "
    "meaning, natural Romanian accounting register, same account codes "
    "and the same placeholder tokens.\n"
    "\n"
    "Respond with ONLY this JSON object and no prose:\n"
    '{"en": {"rationale": "<one paragraph>", "steps": [{"imperative": '
    '"<verb-led clause>", "artefact": "<document or calculation>", '
    '"provider": "<who provides it>", "horizon": "<when, or null>"}]}, '
    '"ro": {"rationale": "<un paragraf>", "steps": [{"imperative": "...", '
    '"artefact": "...", "provider": "...", "horizon": "... sau null"}]}}'
)


_REVIEW_SYSTEM = (
    "You are the ADVERSARIAL REVIEWER for financial findings. You are "
    "not here to be encouraging. Your single question is: WOULD THIS "
    "TEXT READ IDENTICALLY FOR A DIFFERENT COMPANY?\n"
    "\n"
    "Score `specificity` from 0.0 to 1.0.\n"
    "  0.0-0.3  generic advisory prose. Swap the company and nothing "
    "changes. Naming an account code while saying nothing that depends "
    "on this company's structure still scores here.\n"
    "  0.4-0.6  partly anchored: it references the profile or the "
    "accounts, but the reasoning would survive a swap.\n"
    "  0.7-1.0  the sentence is load-bearing on THIS company's "
    "structure, financing shape, signals and accounts. Moving it to "
    "another company would make it wrong, not merely vague.\n"
    "\n"
    "Set `reads_identically_for_another_company` true whenever the text "
    "could be pasted, unchanged and still accurate, into a finding about "
    "another company that tripped the same rule. If a DECOY company "
    "profile is supplied, test the text literally against it.\n"
    "\n"
    "List the offending phrases in `generic_spans` and give one "
    "actionable sentence in `critique` telling the writer what company-"
    "specific fact to make the sentence depend on.\n"
    "\n"
    "Respond with ONLY this JSON object and no prose:\n"
    '{"specificity": <number 0..1>, '
    '"reads_identically_for_another_company": <true|false>, '
    '"generic_spans": ["..."], "critique": "..."}'
)


# ══ 5. THE MODEL CALLS ═══════════════════════════════════════════════════


def _estimated_tokens(user_text: str, max_tokens: int) -> int:
    """A conservative UPPER-BOUND estimate for the spend breaker.

    `engine.ai.advisory` records `tokens=0`, which counts calls but
    leaves `max_tokens_per_day` inert. The breaker's own docstring calls
    counting best-effort, so this lane records an estimate instead of
    nothing: prompt characters / 4 plus the output ceiling. It
    over-counts, which is the safe direction for a cost cap.
    """
    return int(len(user_text or "") / 4) + int(max_tokens or 0)


def _client_for(role: str,
                client_factory: Optional[Callable[[], Any]],
                state_dir: Optional[Any]) -> Any:
    """Breaker-guarded client construction. Raises
    :class:`SharpenUnavailable` with a human-readable reason for every
    failure mode — a tripped cap, a missing key, an SDK that is not
    installed."""
    guarded = breaker.guarded_client_factory(role, client_factory,
                                             state_dir=state_dir)
    try:
        return guarded()
    except breaker.BreakerOpen as exc:
        raise SharpenUnavailable(
            "Advisory sharpening is paused: the daily spend cap for the "
            "'%s' role is exhausted (%s). The deterministic why-here and "
            "action list are shown instead." % (role, exc.reason),
            kind="breaker_open")
    except Exception as exc:  # noqa: BLE001 — missing key / missing SDK
        raise SharpenUnavailable(
            "Advisory sharpening is unavailable: no usable model client "
            "could be built for the '%s' role (%s). The deterministic "
            "why-here and action list are shown instead."
            % (role, type(exc).__name__),
            kind="credits_absent")


def _call_json(client: Any, role: str, system: str, user_text: str,
               state_dir: Optional[Any]) -> Dict[str, Any]:
    """One strict-JSON model call through the shared lane helper, with the
    registry supplying the model and the breaker counting the spend."""
    from engine.ai_lane.schemas import AiLaneError

    params = registry.params_for(role)
    max_tokens = int(params["max_tokens"])
    prompt_version = str(params["prompt_version"])
    try:
        from engine.ai_lane._client import call_strict_json

        data = call_strict_json(
            client, stage=role, prompt_version=prompt_version,
            system=system, user_text=user_text, max_tokens=max_tokens,
        )
    except AiLaneError as exc:
        raise SharpenUnavailable(
            "Advisory sharpening did not complete: the '%s' model did not "
            "return usable JSON. The deterministic why-here and action "
            "list are shown instead. (%s)" % (role, type(exc).__name__),
            kind="model_error")
    finally:
        breaker.record(role, tokens=_estimated_tokens(user_text, max_tokens),
                       state_dir=state_dir)
    if not isinstance(data, dict):
        raise SharpenUnavailable(
            "Advisory sharpening did not complete: the '%s' model returned "
            "a shape this lane does not accept. The deterministic why-here "
            "and action list are shown instead." % role,
            kind="model_error")
    return data


# ── Whitelist projection of the model's answer (the forge-strip) ─────────

_DRAFT_STEP_KEYS = ("imperative", "artefact", "provider", "horizon")


def _project_draft(data: Dict[str, Any], language: str) -> Dict[str, Any]:
    """Keep the two text fields and nothing else.

    A model that returns `severity`, `surfaced`, `rank`, `dismissed` or a
    figure gets those keys DROPPED here — they never reach a Finding,
    because the only constructor this lane uses takes prose parameters
    only.
    """
    block = data.get(language)
    if not isinstance(block, dict):
        raise SharpenUnavailable(
            "Advisory sharpening did not complete: the model returned no "
            "%s block. The deterministic why-here and action list are "
            "shown instead." % language.upper(),
            kind="model_error")
    rationale = block.get("rationale")
    if not isinstance(rationale, str) or not rationale.strip():
        raise SharpenUnavailable(
            "Advisory sharpening did not complete: the model returned no "
            "%s rationale. The deterministic why-here and action list are "
            "shown instead." % language.upper(),
            kind="model_error")
    steps_raw = block.get("steps")
    if not isinstance(steps_raw, list) or not steps_raw:
        raise SharpenUnavailable(
            "Advisory sharpening did not complete: the model returned no "
            "%s action steps. The deterministic why-here and action list "
            "are shown instead." % language.upper(),
            kind="model_error")
    steps = []  # type: List[Dict[str, Optional[str]]]
    for raw in steps_raw[:MAX_STEPS]:
        if not isinstance(raw, dict):
            continue
        step = {}  # type: Dict[str, Optional[str]]
        for key in _DRAFT_STEP_KEYS:
            value = raw.get(key)
            step[key] = (value.strip()[:MAX_STEP_FIELD_CHARS]
                         if isinstance(value, str) and value.strip() else None)
        steps.append(step)
    steps = [s for s in steps if s.get("imperative")]
    if not steps:
        raise SharpenUnavailable(
            "Advisory sharpening did not complete: no usable %s action step "
            "survived projection. The deterministic why-here and action "
            "list are shown instead." % language.upper(),
            kind="model_error")
    return {"rationale": rationale.strip()[:MAX_RATIONALE_CHARS],
            "steps": steps}


# ══ 6. LANGUAGE GATES ════════════════════════════════════════════════════


def _strip_diacritics(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text or "")
                   if unicodedata.category(c) != "Mn").lower()


#: Romanian imperative heads that name an act with an artefact attached.
#: The English lexicon in `_finding` cannot judge Romanian, so the RO
#: gate carries its own — same shape, same intent.
RO_IMPERATIVE_VERBS = frozenset([
    "solicita", "solicitati", "obtine", "obtineti", "extrage", "extrageti",
    "cere", "cereti", "confirma", "confirmati", "verifica", "verificati",
    "recalculeaza", "recalculati", "reconciliaza", "reconciliati",
    "compara", "comparati", "reclasifica", "reclasificati", "retrateaza",
    "renegociaza", "renegociati", "negociaza", "refinanteaza",
    "documenteaza", "documentati", "intocmeste", "intocmiti", "depune",
    "depuneti", "transmite", "transmiteti", "prezinta", "prezentati",
    "convoaca", "convocati", "programeaza", "programati", "separa",
    "separati", "imparte", "limiteaza", "plafoneaza", "constituie",
    "constituiti", "ajusteaza", "ajustati", "achita", "incaseaza",
    "factureaza", "recupereaza", "escaladeaza", "blocheaza", "acopera",
    "fixeaza", "stabileste", "stabiliti", "consemneaza", "cuantifica",
    "cuantificati", "masoara", "modeleaza", "testeaza", "trage",
    "ramburseaza", "publica", "trimite", "trimiteti", "listeaza",
])

#: The Romanian half of `WEAK_LEAD_VERBS` — the banned sentence with the
#: hedge removed reads the same in either language.
RO_WEAK_LEAD_VERBS = frozenset([
    "monitorizeaza", "monitorizati", "analizeaza", "analizati",
    "evalueaza", "evaluati", "revizuieste", "revizuiti", "considera",
    "considerati", "examineaza", "examinati", "urmareste", "urmariti",
    "asigura", "asigurati", "mentine", "mentineti", "observa", "noteaza",
    "intelege", "fii", "verificarea",
])

#: The Romanian half of `BANNED_PHRASES`.
RO_BANNED_PHRASES = (
    "ar trebui monitorizat", "ar trebui monitorizata", "ar trebui analizat",
    "ar trebui revizuit", "ar trebui confirmat", "ar trebui luat in considerare",
    "se recomanda", "este recomandat", "buna practica", "bunele practici",
    "dupa caz", "daca este necesar", "daca este cazul", "este indicat",
    "merita atentie", "necesita atentie", "monitorizare atenta",
)


def _ro_gate(draft: Dict[str, Any], view: SharpenView) -> Tuple[str, ...]:
    """Language-aware gate for the Romanian draft.

    The engine's own validator judges English: its imperative lexicon,
    its banned phrases and its anchor strings are English. Running it
    against Romanian would reject correct Romanian for being Romanian, so
    the RO half is judged on the same four properties in its own
    language, plus the two that are language-free — a ledger account code
    (the token that makes a sentence about one book) and the numeral
    rule.
    """
    problems = []  # type: List[str]
    text = draft["rationale"]
    flat = _strip_diacritics(text + " " + " ".join(
        " ".join(str(s.get(k) or "") for k in _DRAFT_STEP_KEYS)
        for s in draft["steps"]))
    for phrase in RO_BANNED_PHRASES:
        if phrase in flat:
            problems.append("Romanian hedge %r" % phrase)
    if not any(code in text for code in view.account_codes):
        problems.append(
            "the Romanian rationale names none of the subject accounts %r — "
            "it would read identically for another company"
            % (view.account_codes,))
    for step in draft["steps"]:
        head = _strip_diacritics(
            str(step.get("imperative") or "").strip().split(" ", 1)[0]).strip(",.;:")
        if not head:
            problems.append("a Romanian step has no imperative")
        elif head in RO_WEAK_LEAD_VERBS:
            problems.append("Romanian step leads with the non-committal verb %r"
                            % head)
        elif head not in RO_IMPERATIVE_VERBS:
            problems.append("Romanian step leads with %r, which is not in the "
                            "Romanian imperative lexicon" % head)
        if not (step.get("artefact") or "").strip():
            problems.append("a Romanian step names no artefact")
        if not (step.get("provider") or "").strip():
            problems.append("a Romanian step names no provider")
    return tuple(problems)


# ══ 7. RESOLUTION AND APPLICATION ════════════════════════════════════════


def _resolve(text: str, finding: Any) -> str:
    """Turn `{{money:FACT}}` into the engine's OWN printed figure.

    `render_native` is the byte-exact inverse of the templatizer the
    finding renderer runs afterwards, so a resolved placeholder round
    trips to the same placeholder — the model never chooses how a figure
    prints, only where it goes.
    """
    RU = _RU()
    return RU.render_native(text, dict(finding.facts_cited),
                            (finding.currency or "RON").upper())


def _to_steps(draft, finding, lang="en"):
    # type: (Dict[str, Any], Any, str) -> Tuple[Any, ...]
    """Structured steps, stamped with the language of their own words.

    The stamp is what lets `ActionStep.render()` pick the right joiner. A
    Romanian step rendered with the English one came out as "…, from
    controlorul financiar" — half-translated, and plausible enough to
    ship. The language now travels with the text instead of being
    inferred from which code path did the rendering.
    """
    F = _F()
    out = []  # type: List[Any]
    for step in draft["steps"]:
        out.append(F.ActionStep(
            imperative=_resolve(str(step.get("imperative") or ""), finding),
            artefact=_resolve(str(step.get("artefact") or ""), finding),
            provider=_resolve(str(step.get("provider") or ""), finding),
            horizon=(_resolve(str(step["horizon"]), finding)
                     if step.get("horizon") else None),
            lang=lang,
        ))
    return tuple(out)


#: Verdict reasons a Romanian rendering is ALLOWED to carry, because they
#: are artefacts of judging Romanian with an ENGLISH lexicon. Anything
#: else demotes the RO draft — it is not laundering, it is scoping.
#:
#: The anchor reason is on this list for a specific reason worth stating.
#: ``WhyHere.anchors`` are English profile labels ("mid-size
#: inventory-heavy operator"), so a correct Romanian sentence can never
#: contain one, and the English validator would reject Romanian for being
#: Romanian. The guarantee that check exists to give — "this sentence
#: could not be about another company" — is NOT dropped: it is re-imposed
#: on the Romanian half by two language-free substitutes, a subject
#: account code (:func:`_ro_gate`) and the SAME adversarial specificity
#: reviewer that grades the English (:func:`_apply_ro`).
_RO_TOLERATED_REASON_MARKERS = (
    "which is not in the imperative lexicon",
    "no imperative verb reaches the prose",
    "leads with the non-committal verb",
    "mentions none of its anchors",
)


def _ro_reasons_are_language_only(missing: Sequence[Any]) -> bool:
    for m in missing:
        reason = getattr(m, "reason", "") or ""
        if not any(marker in reason for marker in _RO_TOLERATED_REASON_MARKERS):
            return False
    return True


# ══ 8. THE RESULT TYPES ══════════════════════════════════════════════════


@dataclass(frozen=True)
class Narrative:
    """The two text fields, in one language, with their provenance."""

    language: str
    rationale: str
    steps: Tuple[Any, ...]
    source: str                       # "deterministic" | "advisory"
    reason: str                       # always populated, always readable
    specificity: Optional[float] = None
    attempts: int = 0

    def to_payload(self) -> Dict[str, Any]:
        return {
            "language": self.language,
            "rationale": self.rationale,
            "steps": [{"imperative": s.imperative, "artefact": s.artefact,
                       "provider": s.provider, "horizon": s.horizon}
                      for s in self.steps],
            "source": self.source,
            "reason": self.reason,
            "specificity": self.specificity,
            "attempts": self.attempts,
        }


@dataclass(frozen=True)
class SharpenedFinding:
    """What one finding came back as.

    `finding` is ALWAYS a Finding — the input one when the advisory pass
    could not run, the advisory-narrated one when it could. It is never
    constructed here: it comes out of
    ``_finding.apply_advisory_narrative``.
    """

    finding: Any
    en: Narrative
    ro: Optional[Narrative]
    ro_finding: Optional[Any]
    degraded: bool
    reason: str
    scores: Tuple[Dict[str, Any], ...] = ()
    view_fingerprint: str = ""

    def to_payload(self) -> Dict[str, Any]:
        return {
            "rule_id": getattr(self.finding, "rule_id", None),
            "narrative_source": getattr(self.finding, "narrative_source", None),
            "degraded": self.degraded,
            "reason": self.reason,
            "en": self.en.to_payload(),
            "ro": self.ro.to_payload() if self.ro else None,
            "scores": list(self.scores),
            "view_fingerprint": self.view_fingerprint,
        }


def _deterministic_narrative(finding: Any, reason: str) -> Narrative:
    why = getattr(finding, "why_here", None)
    action = getattr(finding, "action", None)
    return Narrative(
        language="en",
        rationale=str(getattr(why, "rationale", "") or ""),
        steps=tuple(getattr(action, "steps", ()) or ()),
        source="deterministic",
        reason=reason,
    )


def _degraded(finding: Any, reason: str, view_fp: str = "",
              scores: Sequence[Dict[str, Any]] = ()) -> SharpenedFinding:
    """The calm fallback. Every state that cannot produce advisory text
    lands here: the deterministic template, carrying all seven contract
    elements, with a sentence saying why."""
    return SharpenedFinding(
        finding=finding,
        en=_deterministic_narrative(finding, reason),
        ro=None,
        ro_finding=None,
        degraded=True,
        reason=reason,
        scores=tuple(scores),
        view_fingerprint=view_fp,
    )


#: The one sentence a reader sees when Romanian could not be earned.
RO_ABSENT_REASON = (
    "No Romanian rendering is shown: the deterministic templates are "
    "authored in English and the advisory pass did not produce a "
    "Romanian draft that met the contract. An absent translation is "
    "stated rather than guessed.")


# ══ 9. THE ENTRY POINT ═══════════════════════════════════════════════════


def sharpen_finding(finding: Any,
                    profile: Any,
                    gateway: Any = None,
                    gateway_facts: Optional[Dict[str, Any]] = None,
                    client_factory: Optional[Callable[[], Any]] = None,
                    reviewer_factory: Optional[Callable[[], Any]] = None,
                    decoy_profile: Any = None,
                    state_dir: Optional[Any] = None,
                    journal_dir: Optional[Any] = None,
                    floor: Optional[float] = None) -> SharpenedFinding:
    """Sharpen ONE finding's why-here paragraph and action list.

    Returns a :class:`SharpenedFinding` in every state. It never raises
    for an AI reason: a tripped breaker, an absent credential, a model
    error, a refused numeral and a generic sentence all land on the
    deterministic template with a human-readable reason.
    """
    F = _F()   # binds the raw seam before anything can rewire it
    floor_value = specificity_floor() if floor is None else float(floor)
    scores = []  # type: List[Dict[str, Any]]

    # A DEMOTED finding is never sharpened. The model cannot rescue one,
    # and dressing an incomplete finding in better prose is exactly the
    # failure this whole contract exists to prevent.
    verdict = finding.verdict()
    if not verdict.surfaced:
        return _degraded(
            finding,
            "This finding is demoted (%s), so no advisory narrative was "
            "requested — an incomplete finding is not made complete by "
            "better wording." % "; ".join(verdict.missing_elements()))

    try:
        view = build_view(finding, profile, gateway=gateway,
                          gateway_facts=gateway_facts)
    except SharpenUnavailable as exc:
        return _degraded(finding, exc.reason)

    view_fp = view.fingerprint()
    base_user_text = _draft_user_text(view, decoy_profile)

    try:
        client = _client_for(ROLE_DRAFT, client_factory, state_dir)
    except SharpenUnavailable as exc:
        journal_record({"event": "degraded", "kind": exc.kind,
                        "rule_id": view.rule_id, "reason": exc.reason},
                       journal_dir)
        return _degraded(finding, exc.reason, view_fp)

    reviewer = None
    try:
        reviewer = _client_for(ROLE_REVIEW, reviewer_factory, state_dir)
    except SharpenUnavailable as exc:
        # The net is not optional: without the reviewer there is no
        # anti-generic gate, and shipping ungated model prose is the
        # baseline failure this lane replaces.
        journal_record({"event": "degraded", "kind": exc.kind,
                        "rule_id": view.rule_id, "reason": exc.reason},
                       journal_dir)
        return _degraded(
            finding,
            "Advisory sharpening was not applied: the adversarial "
            "specificity reviewer is unavailable (%s), and model prose is "
            "never shipped ungated. The deterministic why-here and action "
            "list are shown instead." % exc.kind, view_fp)

    critique = None  # type: Optional[str]
    last_reason = ""
    for attempt in (1, 2):
        user_text = base_user_text if critique is None else (
            base_user_text
            + "\n\nYOUR PREVIOUS ANSWER WAS REFUSED. Fix exactly this and "
              "answer again:\n" + critique)
        try:
            data = _call_json(client, ROLE_DRAFT, _DRAFT_SYSTEM, user_text,
                              state_dir)
            en_draft = _project_draft(data, "en")
            ro_draft = None  # type: Optional[Dict[str, Any]]
            try:
                ro_draft = _project_draft(data, "ro")
            except SharpenUnavailable as ro_exc:
                logger.info("[ai.finding_sharpen] no usable RO draft: %s",
                            ro_exc.kind)
        except SharpenUnavailable as exc:
            journal_record({"event": "degraded", "kind": exc.kind,
                            "rule_id": view.rule_id, "reason": exc.reason},
                           journal_dir)
            return _degraded(finding, exc.reason, view_fp, scores)

        # ── the numeral guard, before anything is applied ──────────────
        en_violations = numeral_violations(
            _draft_text(en_draft), view.account_codes, view.money_facts)
        if en_violations:
            journal_record({
                "event": "numeral_refusal", "rule_id": view.rule_id,
                "profile_id": view.profile_id, "attempt": attempt,
                "language": "en", "violations": list(en_violations),
                "rejected_draft": _draft_text(en_draft)[:2000],
            }, journal_dir)
            last_reason = _numeral_reason(en_violations)
            critique = ("You wrote numerals the engine never computed: %s. "
                        "Use only the listed {{money:...}} placeholders and "
                        "the listed account codes." % last_reason)
            continue

        # ── apply through the ONE seam ────────────────────────────────
        try:
            candidate = _raw_apply(
                finding,
                rationale=_resolve(en_draft["rationale"], finding),
                action_steps=_to_steps(en_draft, finding))
        except F.NarrativeMutationError as exc:
            journal_record({"event": "mutation_refusal", "rule_id": view.rule_id,
                            "attempt": attempt, "detail": str(exc)[:400]},
                           journal_dir)
            last_reason = ("The advisory rewrite moved a figure the engine "
                           "computed and was refused.")
            critique = ("Your answer changed a number. Never restate a "
                        "figure; cite the placeholder or say nothing.")
            continue

        cand_verdict = candidate.verdict()
        if not cand_verdict.surfaced:
            reasons = "; ".join(cand_verdict.reasons())
            journal_record({"event": "contract_refusal", "rule_id": view.rule_id,
                            "attempt": attempt, "missing": reasons[:800],
                            "rejected_draft": _draft_text(en_draft)[:2000]},
                           journal_dir)
            last_reason = ("The advisory rewrite did not carry the seven-"
                           "element contract (%s)."
                           % ", ".join(cand_verdict.missing_elements()))
            critique = ("Your answer failed the finding contract: %s. Fix "
                        "exactly these." % reasons)
            continue

        # ── the adversarial self-review ───────────────────────────────
        try:
            review = _review_specificity(reviewer, view, en_draft,
                                         decoy_profile, state_dir)
        except SharpenUnavailable as exc:
            journal_record({"event": "degraded", "kind": exc.kind,
                            "rule_id": view.rule_id, "reason": exc.reason},
                           journal_dir)
            return _degraded(finding, exc.reason, view_fp, scores)

        accepted = (review["specificity"] >= floor_value
                    and not review["reads_identically"])
        outcome = ("accepted" if accepted
                   else ("regenerated" if attempt == 1 else "fallback"))
        score_row = {
            "event": "specificity_score",
            "rule_id": view.rule_id,
            "profile_id": view.profile_id,
            "period_id": view.period_id,
            "view_fingerprint": view_fp,
            "language": "en",
            "attempt": attempt,
            "specificity": review["specificity"],
            "reads_identically": review["reads_identically"],
            "generic_spans": review["generic_spans"],
            "critique": review["critique"],
            "floor": floor_value,
            "accepted": accepted,
            "outcome": outcome,
            "draft_model": registry.model_for(ROLE_DRAFT),
            "review_model": registry.model_for(ROLE_REVIEW),
            "draft_prompt_version": DRAFT_PROMPT_VERSION,
            "review_prompt_version": REVIEW_PROMPT_VERSION,
            "candidate": en_draft["rationale"][:2000],
        }
        scores.append(score_row)
        journal_record(score_row, journal_dir)

        if not accepted:
            last_reason = (
                "The advisory why-here scored %.2f on the adversarial "
                "specificity review, below the %.2f floor."
                % (review["specificity"], floor_value))
            critique = ("An adversarial reviewer judged your answer generic "
                        "(score %.2f, floor %.2f). Offending phrases: %s. "
                        "Fix: %s"
                        % (review["specificity"], floor_value,
                           "; ".join(review["generic_spans"]) or "(none named)",
                           review["critique"]))
            continue

        # ── Romanian, additive and independently gated ────────────────
        ro_narrative, ro_finding, ro_score = _apply_ro(
            finding, ro_draft, view, reviewer, decoy_profile, state_dir,
            floor_value, journal_dir)
        if ro_score is not None:
            scores.append(ro_score)

        return SharpenedFinding(
            finding=candidate,
            en=Narrative(language="en",
                         rationale=candidate.why_here.rationale,
                         steps=tuple(candidate.action.steps),
                         source="advisory",
                         reason="Sharpened by the advisory pass and cleared "
                                "by the adversarial specificity review.",
                         specificity=review["specificity"],
                         attempts=attempt),
            ro=ro_narrative,
            ro_finding=ro_finding,
            degraded=False,
            reason=("Advisory narrative applied; every figure, threshold and "
                    "impact is the engine's own."
                    + ("" if ro_narrative is not None
                       else " " + RO_ABSENT_REASON)),
            scores=tuple(scores),
            view_fingerprint=view_fp,
        )

    return _degraded(
        finding,
        "%s The deterministic why-here and action list are shown instead."
        % (last_reason or "The advisory pass did not produce usable text."),
        view_fp, scores)


def _numeral_reason(violations: Sequence[str]) -> str:
    """A readable reason built from the VIOLATIONS, never from the model's
    text — the reason is a sentence a person reads, not a payload dump."""
    shown = list(violations)[:4]
    return ("The advisory rewrite carried %d numeral(s) the engine never "
            "computed (%s)." % (len(violations), "; ".join(shown)))


def _draft_text(draft: Dict[str, Any]) -> str:
    parts = [draft["rationale"]]
    for step in draft["steps"]:
        for key in _DRAFT_STEP_KEYS:
            parts.append(str(step.get(key) or ""))
    return "\n".join(parts)


def _apply_ro(finding: Any, ro_draft: Optional[Dict[str, Any]],
              view: SharpenView, reviewer: Any, decoy_profile: Any,
              state_dir: Optional[Any], floor_value: float,
              journal_dir: Optional[Any]
              ) -> Tuple[Optional[Narrative], Optional[Any],
                         Optional[Dict[str, Any]]]:
    """Apply the Romanian draft through the SAME seam, so the numeric
    fingerprint is enforced on it too, then gate it in its own language
    and put it through the SAME adversarial reviewer.

    Returns `(None, None, score_or_None)` whenever Romanian cannot be
    earned. There is no Romanian regeneration: the Romanian half is
    additive, so its failure mode is honest absence, not a second budget.
    """
    if ro_draft is None:
        return None, None, None
    F = _F()
    violations = numeral_violations(_draft_text(ro_draft), view.account_codes,
                                    view.money_facts)
    if violations:
        journal_record({"event": "numeral_refusal", "language": "ro",
                        "rule_id": view.rule_id,
                        "violations": list(violations),
                        "rejected_draft": _draft_text(ro_draft)[:2000]},
                       journal_dir)
        return None, None, None
    problems = _ro_gate(ro_draft, view)
    if problems:
        journal_record({"event": "ro_gate_refusal", "language": "ro",
                        "rule_id": view.rule_id,
                        "problems": list(problems),
                        "rejected_draft": _draft_text(ro_draft)[:2000]},
                       journal_dir)
        return None, None, None
    try:
        ro_finding = _raw_apply(
            finding,
            rationale=_resolve(ro_draft["rationale"], finding),
            action_steps=_to_steps(ro_draft, finding, lang="ro"))
    except F.NarrativeMutationError as exc:
        journal_record({"event": "mutation_refusal", "language": "ro",
                        "rule_id": view.rule_id, "detail": str(exc)[:400]},
                       journal_dir)
        return None, None, None
    # The English validator judges English. A Romanian rendering may only
    # carry the reasons that ARE the English lexicon meeting Romanian; a
    # substantive miss (a lost figure, an unrenderable body, a hedge)
    # demotes it exactly as it would demote English.
    missing = ro_finding.validate()
    if not _ro_reasons_are_language_only(missing):
        journal_record({"event": "contract_refusal", "language": "ro",
                        "rule_id": view.rule_id,
                        "missing": "; ".join(m.render() for m in missing)[:800]},
                       journal_dir)
        return None, None, None
    # The anti-generic net is language-agnostic; the English anchor list
    # is not. So the Romanian half is graded by the SAME reviewer.
    try:
        review = _review_specificity(reviewer, view, ro_draft, decoy_profile,
                                     state_dir)
    except SharpenUnavailable as exc:
        journal_record({"event": "degraded", "language": "ro", "kind": exc.kind,
                        "rule_id": view.rule_id, "reason": exc.reason},
                       journal_dir)
        return None, None, None
    accepted = (review["specificity"] >= floor_value
                and not review["reads_identically"])
    score_row = {
        "event": "specificity_score",
        "rule_id": view.rule_id,
        "profile_id": view.profile_id,
        "period_id": view.period_id,
        "view_fingerprint": view.fingerprint(),
        "language": "ro",
        "attempt": 1,
        "specificity": review["specificity"],
        "reads_identically": review["reads_identically"],
        "generic_spans": review["generic_spans"],
        "critique": review["critique"],
        "floor": floor_value,
        "accepted": accepted,
        "outcome": "accepted" if accepted else "fallback",
        "draft_model": registry.model_for(ROLE_DRAFT),
        "review_model": registry.model_for(ROLE_REVIEW),
        "draft_prompt_version": DRAFT_PROMPT_VERSION,
        "review_prompt_version": REVIEW_PROMPT_VERSION,
        "candidate": ro_draft["rationale"][:2000],
    }
    journal_record(score_row, journal_dir)
    if not accepted:
        return None, None, score_row
    narrative = Narrative(
        language="ro",
        rationale=ro_finding.why_here.rationale,
        steps=tuple(ro_finding.action.steps),
        source="advisory",
        reason=("Romanian rendering of the same finding; judged against the "
                "Romanian imperative lexicon, the language-free gates "
                "(account code, numerals, figures) and the same "
                "adversarial specificity review as the English."),
        specificity=review["specificity"],
        attempts=1,
    )
    return narrative, ro_finding, score_row


# ── Prompt payload builders ──────────────────────────────────────────────


def _decoy_summary(decoy_profile: Any) -> Optional[Dict[str, Any]]:
    """A DIFFERENT company, projected the same way — the reviewer's
    literal test surface for "would this read identically?"."""
    if decoy_profile is None:
        return None
    try:
        payload = _freeze(decoy_profile.to_payload())
    except Exception:  # noqa: BLE001 — a decoy is a nicety, never a gate
        return None
    if isinstance(payload, dict):
        signals = payload.get("signals")
        if isinstance(signals, dict):
            for sig in signals.values():
                if isinstance(sig, dict) and "value" in sig:
                    sig["value"] = MONEY_WITHHELD if sig.get("state") == "present" \
                        else None
    return payload


def _draft_user_text(view: SharpenView, decoy_profile: Any = None) -> str:
    blob = view.as_json()
    decoy = _decoy_summary(decoy_profile)
    if decoy is None:
        return "FINDING VIEW (read-only):\n" + blob
    return ("FINDING VIEW (read-only):\n" + blob
            + "\n\nDECOY COMPANY — a DIFFERENT company an adversarial "
              "reviewer will test your sentence against. If your text would "
              "be equally true of this one, it is not specific enough:\n"
            + json.dumps(decoy, sort_keys=True, ensure_ascii=False, indent=1))


def _review_specificity(reviewer: Any, view: SharpenView,
                        draft: Dict[str, Any], decoy_profile: Any,
                        state_dir: Optional[Any]) -> Dict[str, Any]:
    decoy = _decoy_summary(decoy_profile)
    payload = {
        "rule_id": view.rule_id,
        "subject_accounts": list(view.account_codes),
        "company_profile": view.payload.get("company_profile"),
        "candidate_why_here": draft["rationale"],
        "candidate_action_steps": draft["steps"],
    }
    if decoy is not None:
        payload["decoy_company_profile"] = decoy
    user_text = ("CANDIDATE FINDING TEXT AND ITS COMPANY:\n"
                 + json.dumps(payload, sort_keys=True, ensure_ascii=False,
                              indent=1)[:MAX_VIEW_CHARS])
    data = _call_json(reviewer, ROLE_REVIEW, _REVIEW_SYSTEM, user_text,
                      state_dir)
    raw = data.get("specificity")
    try:
        score = float(raw)
    except (TypeError, ValueError):
        raise SharpenUnavailable(
            "Advisory sharpening did not complete: the specificity reviewer "
            "returned no score. The deterministic why-here and action list "
            "are shown instead.", kind="model_error")
    score = max(0.0, min(1.0, score))
    spans = data.get("generic_spans")
    return {
        "specificity": score,
        "reads_identically": bool(data.get("reads_identically_for_another_company")),
        "generic_spans": [str(s)[:200] for s in spans][:6]
                         if isinstance(spans, list) else [],
        "critique": str(data.get("critique") or "")[:600],
    }


# ══ 10. BATCH ════════════════════════════════════════════════════════════


def sharpen_result(result: Any, **kwargs: Any) -> List[SharpenedFinding]:
    """Sharpen every SURFACED finding of a `SinglePeriodResult`.

    The demoted ones are deliberately not passed through: the advisory
    pass has no opinion about which findings exist.
    """
    profile = result.profile
    out = []  # type: List[SharpenedFinding]
    for finding in result.finding_set.surfaced:
        out.append(sharpen_finding(finding, profile, **kwargs))
    return out


__all__ = [
    "ROLE_DRAFT", "ROLE_REVIEW", "DRAFT_PROMPT_VERSION", "REVIEW_PROMPT_VERSION",
    "LANGUAGES", "CALLABLE_WITHHELD", "MONEY_WITHHELD", "OBJECT_WITHHELD",
    "GATEWAY_ACCESSORS", "RO_ABSENT_REASON",
    "RO_IMPERATIVE_VERBS", "RO_WEAK_LEAD_VERBS", "RO_BANNED_PHRASES",
    "SharpenUnavailable", "AdvisoryNumeralError",
    "SharpenView", "Narrative", "SharpenedFinding",
    "build_view", "gateway_presence", "allowed_ledger_codes",
    "numeral_violations", "assert_no_new_numerals", "apply_advisory_narrative",
    "install_guard",
    "sharpen_finding", "sharpen_result",
    "journal_record", "journal_entries", "journal_path", "score_distribution",
    "specificity_floor", "DEFAULT_SPECIFICITY_FLOOR",
]
