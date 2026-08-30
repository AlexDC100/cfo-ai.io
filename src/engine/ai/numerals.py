"""The numeral-rejection guard (engine.ai.numerals) — the AI boundary.

THE INVARIANT THIS ENFORCES
---------------------------
    AI carries narrative; it never authors digits.

Model output destined for narrative must reference facts BY ID, as
`{fact_id}` placeholders. At parse time the guard:

  1. resolves every placeholder against a TYPED fact supplied by the
     engine (:class:`MoneyFact` / :class:`RatioFact` / :class:`CountFact`
     / :class:`LabelFact`);
  2. rejects any numeral the model wrote ITSELF — a digit that is not a
     resolved placeholder is, by definition, a number the engine did not
     author and cannot vouch for;
  3. logs the rejection and serves the caller's DETERMINISTIC TEMPLATE
     fallback instead.

WHY THE TYPES ARE THE POINT (and not just plumbing)
---------------------------------------------------
A :class:`MoneyFact` carries its amount AND its currency, and it renders
them as ONE inseparable token. There is no API for "give me the amount
without the label". That is the structural answer to the class of defect
behind the 461 note — a native RON figure standing beside a
display-converted EUR figure inside one claim. A narrative built from
money facts cannot pair fact A's amount with fact B's label, because a
narrative built this way never touches a bare amount at all.

Two further rules fall out of the same principle:

  · a currency code/symbol written in the TEMPLATE is refused
    (:data:`CODE_LOOSE_CURRENCY`) — the label belongs to the fact, never
    to the prose around it;
  · two distinct currencies among the facts one claim resolves is a
    rejection (:data:`CODE_MIXED_CURRENCY`), not a warning.

ABSENT != ZERO. A placeholder naming a fact whose value is absent is
rejected outright; it is never rendered as 0, and never quietly dropped.

MODES (env: ``AI_NUMERAL_GUARD``)
---------------------------------
  off       no analysis, passthrough. Nothing is reported.
  observe   full analysis, honest verdict, but the text is passed
            through BYTE-IDENTICAL and no fallback is substituted.
            THE DEFAULT — today's narrative prompts still ask the model
            for literal figures, so enforcing would replace every live
            briefing. Observe makes the invariant a live detector
            without changing a single served byte.
  enforce   rejected narrative is replaced by the deterministic
            fallback. The flip to `enforce` is the ops action that
            completes the migration to placeholder-form prompts.

The guard NEVER raises. Whatever the model returns — bytes, a list, a
number, nothing at all — a :class:`GuardResult` comes back.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

logger = logging.getLogger("engine.ai.numerals")

#: Env gate + the three modes.
MODE_ENV = "AI_NUMERAL_GUARD"
MODE_OFF = "off"
MODE_OBSERVE = "observe"
MODE_ENFORCE = "enforce"
MODES = (MODE_OFF, MODE_OBSERVE, MODE_ENFORCE)

#: Rejection codes.
CODE_NOT_TEXT = "not_text"
CODE_BARE_NUMERAL = "bare_numeral"
CODE_UNRESOLVED = "unresolved_placeholder"
CODE_ABSENT = "absent_fact"
CODE_BAD_FACT = "untyped_fact"
CODE_LOOSE_CURRENCY = "loose_currency_label"
CODE_MIXED_CURRENCY = "mixed_currency_claim"

#: Dotted names address the flattened ratio keys (`{ratios.net_debt}`).
_PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_.]*)\}")
#: A run of digits with the separators a model would write inside one.
_NUMERAL_RE = re.compile(r"\d(?:[\d.,' ]*\d)?")
#: Currency codes/symbols a model might write into the prose itself.
_CURRENCY_TOKEN_RE = re.compile(
    r"(?:(?<![A-Za-z])(?:RON|EUR|USD|GBP|CHF|HUF|PLN|BGN|CZK|MDL|TRY|"
    r"JPY|CNY|SEK|NOK|DKK|RSD)(?![A-Za-z]))|[€£¥$]"
    r"|(?<![A-Za-z])lei(?![A-Za-z])",
    re.IGNORECASE,
)
#: The mask a placeholder wears during scanning — carries no digits and
#: no currency, so it can never be mistaken for either.
_MASK = " "


# ── Typed facts: the only legal source of a digit ──────────────────────


@dataclass(frozen=True)
class MoneyFact(object):
    """An amount and its currency, inseparable. `currency` has NO default
    — a money fact without a currency cannot be constructed."""

    amount: Optional[float]
    currency: str

    def is_absent(self) -> bool:
        return self.amount is None

    def render(self) -> str:
        return "%s %s" % (str(self.currency).upper(), _group(float(self.amount), 2))


@dataclass(frozen=True)
class RatioFact(object):
    """A dimensionless figure. `kind`: 'ratio' (0..1 -> percent), 'pct'
    (already percent), or 'multiple' (rendered with the times sign)."""

    value: Optional[float]
    kind: str = "ratio"

    def is_absent(self) -> bool:
        return self.value is None

    def render(self) -> str:
        v = float(self.value)
        if self.kind == "multiple":
            return "%s×" % _group(v, 2)
        if self.kind == "pct":
            return "%s%%" % _group(v, 1)
        return "%s%%" % _group(v * 100.0, 1)


@dataclass(frozen=True)
class CountFact(object):
    """A plain count (accounts, days, counterparties)."""

    value: Optional[float]
    unit: str = ""

    def is_absent(self) -> bool:
        return self.value is None

    def render(self) -> str:
        v = float(self.value)
        text = _group(v, 0) if float(v).is_integer() else _group(v, 2)
        return ("%s %s" % (text, self.unit)).strip()


@dataclass(frozen=True)
class LabelFact(object):
    """An ENGINE-AUTHORED literal echoed into prose — a period label, an
    account code, a rule name. It may carry digits precisely because the
    engine wrote it; the model merely names it."""

    text: Optional[str]

    def is_absent(self) -> bool:
        return self.text is None or str(self.text).strip() == ""

    def render(self) -> str:
        return str(self.text)


_FACT_TYPES = (MoneyFact, RatioFact, CountFact, LabelFact)


def _group(value: float, decimals: int) -> str:
    return ("{:,.%df}" % decimals).format(value)


# ── Result types ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class Rejection(object):
    code: str
    detail: str
    excerpt: str = ""


@dataclass(frozen=True)
class GuardResult(object):
    accepted: bool
    text: str
    rejections: Tuple[Rejection, ...] = ()
    fallback_used: bool = False
    resolved: Tuple[str, ...] = ()
    currencies: Tuple[str, ...] = ()
    mode: str = MODE_OBSERVE


def active_mode() -> str:
    """The mode from the environment. Unknown values fall back to
    `observe` — the safest setting that still detects."""
    raw = (os.environ.get(MODE_ENV) or "").strip().lower()
    if raw in MODES:
        return raw
    return MODE_OBSERVE


# ── The guard ──────────────────────────────────────────────────────────


def guard(
    text: Any,
    facts: Optional[Dict[str, Any]] = None,
    *,
    fallback: str = "",
    mode: Optional[str] = None,
) -> GuardResult:
    """Resolve `text` against `facts` and reject any numeral the model
    authored. Never raises."""
    try:
        return _guard(text, facts or {}, fallback, mode)
    except Exception:  # noqa: BLE001 — a guard that can fail is not a guard
        logger.exception("[ai.numerals] guard failed (non-fatal; refusing text)")
        safe = text if isinstance(text, str) else ""
        resolved_mode = mode or active_mode()
        if resolved_mode == MODE_ENFORCE:
            return GuardResult(False, fallback, (Rejection(CODE_NOT_TEXT,
                               "guard error"),), True, (), (), resolved_mode)
        return GuardResult(False, safe, (Rejection(CODE_NOT_TEXT, "guard error"),),
                           False, (), (), resolved_mode)


def _guard(text: Any, facts: Dict[str, Any], fallback: str,
           mode: Optional[str]) -> GuardResult:
    resolved_mode = mode if mode in MODES else (mode or active_mode())
    if resolved_mode not in MODES:
        resolved_mode = MODE_OBSERVE

    if resolved_mode == MODE_OFF:
        return GuardResult(True, text if isinstance(text, str) else "",
                           (), False, (), (), MODE_OFF)

    if not isinstance(text, str):
        rej = (Rejection(CODE_NOT_TEXT,
                         "narrative field is %s, not text" % type(text).__name__),)
        return _decide("", fallback, rej, (), (), resolved_mode)

    rejections: List[Rejection] = []
    used_ids: List[str] = []
    currencies: List[str] = []
    renderings: Dict[str, str] = {}

    # 1. Resolve placeholders against typed facts.
    for name in _PLACEHOLDER_RE.findall(text):
        if name in renderings or any(r.detail == name for r in rejections):
            continue
        fact = facts.get(name)
        if fact is None and name not in facts:
            rejections.append(Rejection(CODE_UNRESOLVED, name, "{%s}" % name))
            continue
        if not isinstance(fact, _FACT_TYPES):
            rejections.append(Rejection(
                CODE_BAD_FACT, name,
                "{%s} -> %s" % (name, type(fact).__name__)))
            continue
        if fact.is_absent():
            rejections.append(Rejection(
                CODE_ABSENT, name,
                "{%s} is absent — absent is not zero" % name))
            continue
        renderings[name] = fact.render()
        used_ids.append(name)
        if isinstance(fact, MoneyFact):
            currencies.append(str(fact.currency).upper())

    # 2. Scan the TEMPLATE (placeholders masked) for digits and currency
    #    labels the model wrote itself.
    masked = _PLACEHOLDER_RE.sub(_MASK, text)
    for match in _NUMERAL_RE.finditer(masked):
        rejections.append(Rejection(
            CODE_BARE_NUMERAL,
            "the model authored this figure; no fact backs it",
            match.group(0)))
    for match in _CURRENCY_TOKEN_RE.finditer(masked):
        rejections.append(Rejection(
            CODE_LOOSE_CURRENCY,
            "a currency label belongs to its fact, not to the prose",
            match.group(0)))

    # 3. One claim, one currency.
    distinct = sorted(set(currencies))
    if len(distinct) > 1:
        rejections.append(Rejection(
            CODE_MIXED_CURRENCY,
            "one claim cites %s" % " and ".join(distinct),
            ", ".join(distinct)))

    rendered = _PLACEHOLDER_RE.sub(
        lambda m: renderings.get(m.group(1), m.group(0)), text)
    return _decide(rendered if not rejections else text, fallback,
                   tuple(rejections), tuple(used_ids), tuple(distinct),
                   resolved_mode, raw=text, rendered=rendered)


def _decide(text: str, fallback: str, rejections: Tuple[Rejection, ...],
            used_ids: Tuple[str, ...], currencies: Tuple[str, ...],
            mode: str, raw: str = "", rendered: str = "") -> GuardResult:
    accepted = not rejections
    if accepted:
        return GuardResult(True, rendered or text, (), False, used_ids,
                           currencies, mode)
    _log(rejections, raw or text)
    if mode == MODE_ENFORCE:
        return GuardResult(False, fallback, rejections, True, used_ids,
                           currencies, mode)
    # observe: byte-identical passthrough, honest verdict.
    return GuardResult(False, raw or text, rejections, False, used_ids,
                       currencies, mode)


def _log(rejections: Sequence[Rejection], excerpt: str) -> None:
    codes = sorted({r.code for r in rejections})
    logger.warning(
        "[ai.numerals] narrative rejected (%s): %r",
        ",".join(codes), (excerpt or "")[:160],
    )


# ── The narrate seam ───────────────────────────────────────────────────
#
# `stage_narrate` accepts model output as `json.loads(text)` and returns
# {briefing, recommendations[], alerts[]}. These are the narrative fields
# in that payload; `estimated_ron_impact` is deliberately NOT among them
# — it is a number the engine consumes as a number, not prose it renders.

_BRIEFING_FALLBACK = (
    "The briefing was withheld: the model cited figures the engine did "
    "not author. The statements, ratios and alerts on this page are "
    "unaffected and remain engine-computed."
)
_RATIONALE_FALLBACK = (
    "Rationale withheld — the model cited figures the engine did not "
    "author. The underlying metric is unchanged."
)
_TITLE_FALLBACK = "Recommendation (narrative withheld)"
_ACTION_FALLBACK = "Review this item against the engine-computed figures."


#: Keys inside `briefing_facts.ratios` that are NOT money. This mirrors
#: `pipeline._convert_briefing_facts` exactly — that function is the
#: engine's existing authority on which briefing fields carry a currency
#: (it converts those and leaves the dimensionless ones alone). Reusing
#: its classification is deliberate: two different answers to "is this
#: money?" is how a figure ends up with the wrong label.
_RATIO_MONEY_KEYS = ("net_debt",)


def facts_from_briefing(
    briefing_facts: Any,
    currency: str,
) -> Dict[str, Any]:
    """Type the briefing's fact block: money fields become
    :class:`MoneyFact` carrying `currency`, dimensionless fields become
    :class:`RatioFact`. `briefing_facts` is already FX-converted to the
    display currency by the caller, so `currency` is the display code —
    the amount and the label are typed together from the same source and
    cannot drift apart.

    Ratio keys are flattened as ``ratios.<key>`` so a prompt can name
    them. Never raises; an unusable block yields an empty dict.
    """
    out: Dict[str, Any] = {}
    if not isinstance(briefing_facts, dict):
        return out
    code = str(currency or "").upper() or "RON"
    for key, value in briefing_facts.items():
        if key == "ratios" and isinstance(value, dict):
            for rkey, rvalue in value.items():
                name = "ratios.%s" % rkey
                if rkey in _RATIO_MONEY_KEYS:
                    out[name] = MoneyFact(_number(rvalue), code)
                elif str(rkey).endswith("_pct"):
                    out[name] = RatioFact(_number(rvalue), "pct")
                else:
                    out[name] = RatioFact(_number(rvalue), "multiple")
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        out[key] = MoneyFact(float(value), code)
    return out


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def guard_narrate_result(
    payload: Any,
    facts: Optional[Dict[str, Any]] = None,
    *,
    mode: Optional[str] = None,
) -> Tuple[Any, Dict[str, Any]]:
    """Guard every narrative field of a parsed narrate payload.

    Returns ``(payload, report)``. In `observe` the payload comes back
    byte-identical; in `enforce` each rejected field carries its
    deterministic template instead. Structure is never changed and no
    field is ever dropped. Never raises.
    """
    resolved_mode = mode if mode in MODES else (mode or active_mode())
    report: Dict[str, Any] = {
        "mode": resolved_mode,
        "fields_checked": 0,
        "fields_rejected": 0,
        "rejected_fields": [],
        "codes": [],
    }
    if not isinstance(payload, dict):
        return payload, report

    facts = facts or {}
    codes: List[str] = []

    def _run(value: Any, fallback: str, pointer: str) -> Any:
        report["fields_checked"] += 1
        result = guard(value, facts, fallback=fallback, mode=resolved_mode)
        if not result.accepted:
            report["fields_rejected"] += 1
            report["rejected_fields"].append(pointer)
            codes.extend(r.code for r in result.rejections)
        return result.text if result.accepted or resolved_mode == MODE_ENFORCE \
            else value

    out = dict(payload)

    if "briefing" in out:
        out["briefing"] = _run(out["briefing"], _BRIEFING_FALLBACK, "briefing")

    recs = out.get("recommendations")
    if isinstance(recs, list):
        new_recs: List[Any] = []
        for i, rec in enumerate(recs):
            if not isinstance(rec, dict):
                new_recs.append(rec)
                continue
            rec = dict(rec)
            if "title" in rec:
                rec["title"] = _run(rec["title"], _TITLE_FALLBACK,
                                    "recommendations[%d].title" % i)
            if "rationale" in rec:
                rec["rationale"] = _run(rec["rationale"], _RATIONALE_FALLBACK,
                                        "recommendations[%d].rationale" % i)
            actions = rec.get("actions")
            if isinstance(actions, list):
                rec["actions"] = [
                    _run(a, _ACTION_FALLBACK,
                         "recommendations[%d].actions[%d]" % (i, j))
                    for j, a in enumerate(actions)
                ]
            new_recs.append(rec)
        out["recommendations"] = new_recs

    report["codes"] = sorted(set(codes))
    if report["fields_rejected"]:
        logger.warning(
            "[ai.numerals] narrate seam: %d/%d narrative fields rejected "
            "(mode=%s, codes=%s)",
            report["fields_rejected"], report["fields_checked"],
            resolved_mode, ",".join(report["codes"]),
        )
    return out, report
