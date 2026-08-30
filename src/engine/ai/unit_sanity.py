"""Advisory unit-sanity validator (engine.ai.unit_sanity).

WHAT IT IS
----------
A reader's-eye check on a finished claim. It reads narrative the way a
CFO reads it — as a sentence — and asks two questions:

  (a) does ONE sentence cite two different currencies?
  (b) is a stated percentage plausible against the operands stated
      beside it?

It exists because the failure it catches is invisible to every upstream
check. The live 461 note —

    "holds RON 7,692,203 — 19.6% of total assets 7.467.122,25 EUR"

— has a correct ratio (both engine operands are native RON, and
7,692,202.74 / 39,194,178.46 really is 19.63%), correct facts, and a
correct rule. The defect appears only at the rendering boundary, in the
assembled sentence. So the sentence is what this validator reads.

HARD LIMITS (all three are load-bearing)
----------------------------------------
  · ADVISORY. It emits findings. There is no rewrite surface in this
    module — no `fix`, no `rewrite`, no mutation of the text it reads.
    The text comes back on the report exactly as it went in.
  · NEVER BLOCKS. Every finding is `blocking=False`. Nothing here can
    change a status, gate a serve, or fail a pipeline stage.
  · NO MODEL. Every check is deterministic string work; no anthropic
    client is ever constructed, no key is read, no network is touched.
    So it runs identically with credits ABSENT — and says so through a
    TYPED :class:`Availability`, never a silent bool.

HONEST ABOUT AMBIGUITY
----------------------
`1,234` is 1234 to an English reader and 1.234 to a Romanian one.
:func:`parse_number` returns ``None`` for that — typed unknown, not a
guess — and a check with an unparseable operand is SKIPPED rather than
decided. ABSENT != ZERO, and absent is also not "probably". A validator
that guesses produces false flags, and a false flag on a correct claim
is worse than no validator at all.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

logger = logging.getLogger("engine.ai.unit_sanity")

#: Finding codes.
CODE_MIXED_CURRENCY = "mixed_currency_sentence"
CODE_IMPLAUSIBLE_PCT = "implausible_percentage"

#: Advisory vocabulary — the same three levels the advisory pass uses.
SEVERITIES = ("info", "warn", "flag")

#: Symbols resolve to codes so "RON … €" reads as RON vs EUR.
_SYMBOL_TO_CODE = {"€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY"}
_CODES = (
    "RON", "EUR", "USD", "GBP", "CHF", "HUF", "PLN", "BGN", "CZK",
    "MDL", "TRY", "JPY", "CNY", "SEK", "NOK", "DKK", "RSD",
)
_CURRENCY_RE = re.compile(
    r"(?<![A-Za-z])(?:%s)(?![A-Za-z])|[€£¥$]|(?<![A-Za-z])lei(?![A-Za-z])"
    % "|".join(_CODES),
    re.IGNORECASE,
)

_PCT_RE = re.compile(r"(\d[\d.,]*)\s*%")
_NUM_RE = re.compile(r"\d[\d.,]*\d|\d")
#: Sentence boundary: terminator + whitespace. A dot INSIDE a number is
#: followed by a digit, never whitespace, so `7.467.122,25` survives.
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

#: A stated percentage may differ from the computed one by rounding. The
#: tolerance is derived from the precision the claim itself states —
#: "46%" can be half a point out by construction, "19.6%" only a
#: twentieth — plus a small relative allowance for operand rounding
#: (engine bodies print whole units while the ratio uses full precision).
_PCT_REL_TOL = 0.01


# ── Typed result surface ───────────────────────────────────────────────


@dataclass(frozen=True)
class Availability(object):
    """Why this validator can (or cannot) run. Always constructible —
    the answer never depends on credits."""

    available: bool
    reason: str
    uses_model: bool = False


@dataclass(frozen=True)
class Finding(object):
    code: str
    severity: str
    message: str
    sentence: str = ""
    pointer: str = ""
    currencies: Tuple[str, ...] = ()
    stated_pct: Optional[float] = None
    computed_pct: Optional[float] = None
    #: Structural, not a flag someone can flip: advisory findings never
    #: block. Nothing in the engine reads this as a gate.
    blocking: bool = False


@dataclass(frozen=True)
class SanityReport(object):
    text: str
    findings: Tuple[Finding, ...]
    availability: Availability


def availability() -> Availability:
    """Typed availability. Deterministic string work only, so this is
    `True` with credits present, absent, exhausted or refused."""
    return Availability(True, "deterministic", False)


# ── Number parsing — typed unknown over a guess ────────────────────────


def parse_number(raw: Any) -> Optional[float]:
    """Parse a money/number token written in either an English
    (`1,234,567.89`) or a Romanian (`1.234.567,89`) locale.

    Returns ``None`` — typed unknown — when the token is genuinely
    ambiguous between the two (`1,234`), when it is malformed, or when
    it is not a string. It never guesses.
    """
    if not isinstance(raw, str):
        return None
    s = raw.strip().replace(" ", "").replace(" ", "").replace("'", "")
    if not s:
        return None
    negative = s.startswith("-")
    if negative or s.startswith("+"):
        s = s[1:]
    if not s or not re.match(r"^[\d.,]+$", s) or not any(c.isdigit() for c in s):
        return None

    dots, commas = s.count("."), s.count(",")
    if dots and commas:
        decimal_sep = "." if s.rfind(".") > s.rfind(",") else ","
        value = _compose(s, decimal_sep, "," if decimal_sep == "." else ".")
    elif commas:
        value = _single_separator(s, ",")
    elif dots:
        value = _single_separator(s, ".")
    else:
        try:
            value = float(s)
        except ValueError:
            return None
    if value is None:
        return None
    return -value if negative else value


def _compose(s: str, decimal_sep: str, group_sep: str) -> Optional[float]:
    left, _, right = s.rpartition(decimal_sep)
    if not right.isdigit() or decimal_sep in left:
        return None
    groups = left.split(group_sep)
    if len(groups) > 1:
        if not groups[0].isdigit() or not 1 <= len(groups[0]) <= 3:
            return None
        if any((not g.isdigit() or len(g) != 3) for g in groups[1:]):
            return None
    elif not groups[0].isdigit():
        return None
    try:
        return float("".join(groups) + "." + right)
    except ValueError:
        return None


def _single_separator(s: str, sep: str) -> Optional[float]:
    parts = s.split(sep)
    if any(not p.isdigit() for p in parts):
        return None
    if len(parts) > 2:
        # Repeated separator can only be grouping.
        if not 1 <= len(parts[0]) <= 3 or any(len(p) != 3 for p in parts[1:]):
            return None
        return float("".join(parts))
    left, right = parts
    if not left or not right:
        return None
    if len(right) == 3 and len(left) <= 3 and not left.startswith("0"):
        # "1,234" — 1234 to one reader, 1.234 to another. Unknowable.
        return None
    return float(left + "." + right)


# ── The two checks ─────────────────────────────────────────────────────


def _currencies_in(sentence: str) -> Tuple[str, ...]:
    found: List[str] = []
    for match in _CURRENCY_RE.finditer(sentence):
        token = match.group(0)
        code = _SYMBOL_TO_CODE.get(token)
        if code is None:
            upper = token.upper()
            code = "RON" if upper == "LEI" else upper
        if code not in found:
            found.append(code)
    return tuple(found)


def _check_mixed_currency(sentence: str, pointer: str) -> Optional[Finding]:
    currencies = _currencies_in(sentence)
    if len(currencies) < 2:
        return None
    return Finding(
        code=CODE_MIXED_CURRENCY,
        severity="flag",
        message=(
            "one claim cites %s — a converted figure and a native figure "
            "cannot stand in the same sentence" % " and ".join(sorted(currencies))
        ),
        sentence=sentence.strip(),
        pointer=pointer,
        currencies=tuple(sorted(currencies)),
    )


def _stated_precision_tol(token: str) -> float:
    """Half of the last digit place the claim actually states. "46%" is
    a half-point claim; "19.6%" is a twentieth-of-a-point claim."""
    tail = re.split(r"[.,]", token.strip())
    decimals = len(tail[-1]) if len(tail) > 1 and tail[-1].isdigit() else 0
    return 0.5 * (10.0 ** -decimals)


def _money_operands(sentence: str, skip_spans: Sequence[Tuple[int, int]]):
    """Numbers that carry a currency label, immediately before or after.

    Currency-adjacency is what makes this check honest. Engine bodies are
    full of bare digits that are NOT amounts — account codes ("Account
    461", "on 628"), law articles ("Art. 153^24"), day counts. Comparing
    those against a percentage manufactures false flags on correct
    claims. A figure a reader weighs against a percentage is a figure
    written with its currency; nothing else qualifies.

    Returns ``(operands, skipped)`` — `skipped` counts currency-labelled
    numbers that could not be parsed unambiguously.
    """
    currency_spans = [(m.start(), m.end()) for m in _CURRENCY_RE.finditer(sentence)]
    operands: List[float] = []
    skipped = 0
    for match in _NUM_RE.finditer(sentence):
        if any(start <= match.start() < end for start, end in skip_spans):
            continue
        before = sentence[:match.start()]
        after = sentence[match.end():]
        adjacent = any(
            end <= match.start() and not before[end:].strip()
            for _, end in currency_spans
        ) or any(
            start >= match.end() and not after[:start - match.end()].strip()
            for start, _ in currency_spans
        )
        if not adjacent:
            continue
        value = parse_number(match.group(0))
        if value is None:
            skipped += 1
            continue
        operands.append(value)
    return operands, skipped


def _check_percentage(sentence: str, pointer: str) -> Optional[Finding]:
    pct_spans = [(m.start(), m.end(), m.group(1)) for m in _PCT_RE.finditer(sentence)]
    if len(pct_spans) != 1:
        return None                      # nothing to attribute, or too many
    stated = parse_number(pct_spans[0][2])
    if stated is None:
        return None

    operands, skipped = _money_operands(
        sentence, [(s, e) for s, e, _ in pct_spans])
    # Exactly two known money operands, none skipped: anything else and
    # we cannot say which figure is meant to be which. Stay silent.
    if skipped or len(operands) != 2:
        return None
    a, b = operands
    if a == 0 or b == 0:
        return None

    tolerance = (_stated_precision_tol(pct_spans[0][2])
                 + abs(stated) * _PCT_REL_TOL)
    forward = a / b * 100.0
    reverse = b / a * 100.0
    if min(abs(forward - stated), abs(reverse - stated)) <= tolerance:
        return None
    return Finding(
        code=CODE_IMPLAUSIBLE_PCT,
        severity="flag",
        message=(
            "the claim states %.4g%% but its own operands give %.4g%% — the "
            "two figures are not on the same footing" % (stated, forward)
        ),
        sentence=sentence.strip(),
        pointer=pointer,
        stated_pct=stated,
        computed_pct=forward,
    )


# ── Public entry points ────────────────────────────────────────────────


def check(text: Any, pointer: str = "") -> SanityReport:
    """Read one claim and return advisory findings. Never raises, never
    rewrites, never blocks."""
    avail = availability()
    if not isinstance(text, str) or not text.strip():
        return SanityReport(text if isinstance(text, str) else "", (), avail)
    findings: List[Finding] = []
    try:
        for sentence in _SENTENCE_SPLIT_RE.split(text):
            if not sentence.strip():
                continue
            mixed = _check_mixed_currency(sentence, pointer)
            if mixed is not None:
                findings.append(mixed)
            pct = _check_percentage(sentence, pointer)
            if pct is not None:
                findings.append(pct)
    except Exception:  # noqa: BLE001 — advisory: a failed check is silence
        logger.exception("[ai.unit_sanity] check failed (non-fatal)")
        return SanityReport(text, tuple(findings), avail)
    return SanityReport(text, tuple(findings), avail)


#: The narrative fields an alert row carries.
_ALERT_FIELDS = ("title", "body")


def check_alerts(alerts: Any) -> Tuple[Finding, ...]:
    """Scan a batch of alert-shaped rows. Each finding carries a
    `pointer` of the form ``"<index>:<field>"`` so an operator can find
    the row it came from. Never raises."""
    findings: List[Finding] = []
    if not isinstance(alerts, (list, tuple)):
        return ()
    for index, row in enumerate(alerts):
        if not isinstance(row, dict):
            continue
        for name in _ALERT_FIELDS:
            value = row.get(name)
            if not isinstance(value, str) or not value.strip():
                continue
            findings.extend(check(value, pointer="%d:%s" % (index, name)).findings)
    if findings:
        logger.info(
            "[ai.unit_sanity] %d advisory unit finding(s) across %d row(s)",
            len(findings), len(alerts),
        )
    return tuple(findings)


def findings_as_dicts(findings: Sequence[Finding]) -> List[Dict[str, Any]]:
    """JSON-serialisable projection, for logs and additive envelope
    fields. Advisory shape only — no status key exists to forge."""
    return [
        {
            "code": f.code,
            "severity": f.severity,
            "message": f.message,
            "sentence": f.sentence,
            "pointer": f.pointer,
            "currencies": list(f.currencies),
            "stated_pct": f.stated_pct,
            "computed_pct": f.computed_pct,
            "blocking": False,
        }
        for f in findings
    ]
