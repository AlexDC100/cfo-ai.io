"""Per-document number-locale detection and strict numeric parsing.

Single shared implementation for every deterministic ingestion path
(XLSX/CSV trial-balance parser, PDF ingester). Implements the
`extraction.number_locale` block of docs/CANONICAL_BS_V2_CONTRACT.md:
the locale is detected ONCE per document by majority vote over its
numeric cells, and every cell is then parsed under that one locale —
never re-guessed per cell.

Why this exists (BS_ENGINE_AUDIT_MAP.md, Ingestion §3): the engine
previously carried three independent per-cell heuristics
(`trial_balance_parser._to_number`, `pdf_ingester._parse_ro_number`,
`_statutory_parser._to_float`) that could disagree inside one file and
produced concrete 1000× misparses on ambiguous cells ('1,234' /
'1.234'). The ONLY genuinely ambiguous shapes are a single separator
followed by exactly one 3-digit group — those are decided by the
document locale here. Every other shape is parsed by its own grammar
(thousands separators group exactly 3 digits; the rightmost separator
is the decimal when both appear), identically in both locales, so a
document's unambiguous cells can never be corrupted by the vote.

Deliberately dependency-free (stdlib `re` only) so the PDF ingester can
import it without pulling pandas.
"""

from __future__ import annotations

import re
from typing import Iterable, Optional, Tuple, Union

# The two supported locales. "ro": dot=thousands, comma=decimal
# ('1.234,56'). "anglo": comma=thousands, dot=decimal ('1,234.56').
RO = "ro"
ANGLO = "anglo"

# Space-class characters used as thousands separators by SAGA / EEI /
# WinMENTOR exports: regular space, nbsp, thin space, narrow no-break
# space, figure space. Stripped before any grammar decision.
_WS_RE = re.compile(r"[\s    ]")

# A cleaned cell body must be digits + separators only to carry any
# locale signal — this keeps free-text cells (account names that happen
# to contain commas) from ever voting.
_NUMERIC_BODY_RE = re.compile(r"^\d[\d.,]*$")

# The ONLY ambiguous shapes: one separator, one leading 1-3 digit group,
# one trailing 3-digit group. '1,234' is anglo-thousands OR ro-decimal;
# '1.234' is ro-thousands OR anglo-decimal. Everything else self-parses.
_AMBIG_COMMA_RE = re.compile(r"^\d{1,3},\d{3}$")
_AMBIG_DOT_RE = re.compile(r"^\d{1,3}\.\d{3}$")


def _prepare(value) -> Optional[Union[float, Tuple[str, bool]]]:
    """Normalize a raw cell to either a passthrough float (cell already
    numeric), a ``(body, negative)`` string pair ready for grammar
    rules, or None when the cell carries no number (blank, 'nan', '-').
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if value != value:  # NaN — float("nan") never equals itself
            return None
        return float(value)
    s = str(value).strip()
    if not s or s.lower() in ("nan", "none", "-", "—", "–"):
        return None
    # Parenthesized negatives, common in accounting reports.
    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative = True
        s = s[1:-1].strip()
    if s.startswith("-"):
        negative = True
        s = s[1:].strip()
    s = _WS_RE.sub("", s)
    if not s:
        return None
    return (s, negative)


def _vote(body: str) -> Optional[str]:
    """One cell's locale vote: RO, ANGLO, or None (no signal).

    Unambiguous-by-grammar cells vote for the locale their shape
    implies; the ambiguous single-3-digit-group shapes and bare
    integers abstain — they are what the vote exists to decide.
    """
    if not _NUMERIC_BODY_RE.match(body):
        return None
    has_dot = "." in body
    has_comma = "," in body
    if has_dot and has_comma:
        # Both separators: the rightmost is structurally the decimal.
        return RO if body.rfind(",") > body.rfind(".") else ANGLO
    if has_comma:
        if body.count(",") > 1:
            return ANGLO  # repeated groups can only be anglo thousands
        if _AMBIG_COMMA_RE.match(body):
            return None
        return RO  # decimal comma ('1234,56', '0,5', '1,2345')
    if has_dot:
        if body.count(".") > 1:
            return RO  # repeated groups can only be ro thousands
        if _AMBIG_DOT_RE.match(body):
            return None
        return ANGLO  # decimal dot ('1234.56', '0.5', '3.14159')
    return None  # bare integer — carries no locale signal


def detect_number_locale(cells: Iterable, default: str = ANGLO) -> str:
    """Majority vote over a document's numeric cells → "ro" | "anglo".

    `default` breaks ties and covers documents with zero votes (all
    integers / all true-numeric cells). The XLSX path passes "anglo"
    because pandas dtype=str renders true numeric cells as dot-decimal
    repr strings; the PDF path passes "ro" (Romanian RAS PDFs are
    ro-formatted; stay ro-biased when detection is impossible).
    """
    ro_votes = 0
    anglo_votes = 0
    for cell in cells:
        prep = _prepare(cell)
        if not isinstance(prep, tuple):
            continue  # blank / already-numeric cells carry no textual form
        v = _vote(prep[0])
        if v == RO:
            ro_votes += 1
        elif v == ANGLO:
            anglo_votes += 1
    if ro_votes > anglo_votes:
        return RO
    if anglo_votes > ro_votes:
        return ANGLO
    return default


def parse_number(value, locale: str) -> float:
    """Parse one cell under the DOCUMENT locale. Never guesses per cell:
    the only locale-dependent decision is the ambiguous
    single-3-digit-group shape ('1,234' / '1.234'); every other shape is
    resolved by separator grammar, identically in both locales.

    Handles: '1.234,56' / '1,234.56' / '1234.56' / '1,56' /
    '3 980 157,61' (space or nbsp thousands) / '(1.234,56)'
    parenthesized negatives / NaN, None, '', '-', 'nan' → 0.0.
    Unparseable text → 0.0 (matching the legacy `_to_number` contract:
    a garbage cell degrades to zero, never raises mid-document).
    """
    if locale not in (RO, ANGLO):
        raise ValueError(f"unknown number locale: {locale!r}")
    prep = _prepare(value)
    if prep is None:
        return 0.0
    if isinstance(prep, float):
        return prep
    s, negative = prep

    has_dot = "." in s
    has_comma = "," in s
    if has_dot and has_comma:
        # Rightmost separator is the decimal — unambiguous in any locale
        # (thousands separators never appear right of the decimal).
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif has_comma:
        if s.count(",") > 1:
            s = s.replace(",", "")  # repeated commas = thousands groups
        elif _AMBIG_COMMA_RE.match(s):
            # THE ambiguous shape — document locale decides.
            s = s.replace(",", ".") if locale == RO else s.replace(",", "")
        else:
            s = s.replace(",", ".")  # decimal comma by grammar
    elif has_dot:
        if s.count(".") > 1:
            s = s.replace(".", "")  # repeated dots = thousands groups
        elif _AMBIG_DOT_RE.match(s):
            # THE ambiguous shape — document locale decides.
            if locale == RO:
                s = s.replace(".", "")
            # anglo: dot stays the decimal point.
        # else: single dot with a non-3-digit tail is a decimal in both
        # locales ('1234.56', '0.5', '3.14159') — float() handles it.

    try:
        n = float(s)
    except ValueError:
        return 0.0
    return -n if negative else n
