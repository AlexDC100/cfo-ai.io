"""PERIOD DETECTION SERVICE (Part B) — the one place that answers
"which period does THIS document belong to?" from the document's own
evidence.

WHY THIS EXISTS
---------------
`documents.period_end_hint` is a CONFIRMATION channel: it means "a human
confirmed that THIS document belongs to THIS month". `stage_persist`
ranks it first and deliberately overrides its own detection because of
that meaning. The frontend was filling it with the DROP TARGET's date —
a number read off the UI, never off the document — so the engine
correctly discarded correct detections. The 2026-08-30 production audit
found every mismatched row carrying `hint == stored`, including a 2025
Carniprod trial balance filed under 2017-12.

The fix is semantic, and this module is its foundation: a hint-free
detection service that both the engine and the upload UI call, so the
two can never disagree, and whose SIGNATURE makes UI state
unrepresentable.

INVARIANTS
----------
W1  UI STATE IS NOT AN INPUT. `detect_period` takes exactly two
    keyword-only arguments — `extracted` and `filename`. No positional
    call, no ``**kwargs``. The currently-open period, the drop target
    and the last-used month have no way in.

W2  RANKED RESOLUTION, hint-free:
      1. in_document      — a period end the document itself states
      2. closing_balance  — a date sitting next to closing-balance
                            vocabulary in the document's own text
      3. filename         — via the engine's own helper, reused
      4. none             — ABSENT

W3  ABSENT != ZERO. "Not detected" is a first-class answer
    (`proposed_period_end=None`, `confidence=0.0`, `signal_used="none"`)
    that forces an explicit human choice. It is never today, never the
    open period, never a guess.

W4  TODAY IS NEVER A DETECTION. The engine's filename helper falls back
    to `date.today()` when it finds nothing; a date equal to today is
    therefore indistinguishable from "I found nothing" and is refused by
    every tier. The deliberate cost is one false negative: a document
    genuinely dated today resolves as ABSENT and asks the human. That is
    the safe direction — the alternative is exactly the silent
    misfiling this module exists to end.

W5  NO REIMPLEMENTATION. Every date is produced by the engine's own
    `_detect_period_end_from_filename` and clamped by its own
    `_sane_period_end`. This module contributes RANKING and LEXICAL
    NORMALIZATION only: it rewrites text into the vocabulary the engine
    helper already understands ("2025-12" -> "dec 2025") and lets the
    helper decide what that means, so month-end convention and sanity
    bounds keep living in exactly one place.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

#: The complete, closed set of signals `signal_used` can carry.
SIGNALS = ("in_document", "closing_balance", "filename", "none")

#: Confidence per tier. Stable numbers — the UI renders them and the
#: persisted detection record stores them, so they are contract, not
#: taste. Ordered strictly by tier so a lower-ranked signal can never
#: out-score a higher-ranked one.
CONFIDENCE = {
    "in_document": 0.95,
    "closing_balance": 0.85,
    "filename": 0.60,
    "none": 0.0,
}

#: Keys read off `extracted` for the in-document tier, in order. Both
#: the engine's snake_case parse output and a camelCase preview from the
#: frontend are accepted so one contract serves both callers.
_IN_DOCUMENT_KEYS = ("period_end", "periodEnd", "period_label", "periodLabel")

#: Keys read off `extracted` for the closing-balance tier, in order.
#: `closing_balance_date` is a resolved date; the rest are free text
#: lifted from the document (title block, column header, preamble).
_CLOSING_DATE_KEYS = ("closing_balance_date", "closingBalanceDate")
_CLOSING_TEXT_KEYS = (
    "closing_balance_label", "closingBalanceLabel",
    "header_text", "headerText",
    "period_text", "periodText",
    "document_text", "documentText",
    "preamble",
)

#: Phrases that mark a date as the period's CLOSING date rather than a
#: print timestamp or an invoice date. A date is only read from free
#: text when it sits inside the window opened by one of these.
_CLOSING_VOCABULARY = (
    # Romanian (with and without diacritics — exports vary)
    "balanta de verificare", "balanță de verificare",
    "la data de", "la datele de",
    "sold final", "solduri finale", "soldurile finale",
    "incheiat la", "încheiat la",
    "la sfarsitul", "la sfârșitul",
    "perioada", "luna",
    # International
    "closing balance", "balance as at", "balance as of",
    "as at", "as of", "period ended", "period end",
    "year ended", "year end",
)

#: Width of the text window opened after a vocabulary hit. Wide enough
#: to reach the date on the same line, narrow enough that an unrelated
#: date further down the page can't be captured.
_WINDOW = 80

#: Month number -> the tag the engine helper's own month table uses
#: (see `_detect_period_end_from_filename`). Used ONLY to rewrite
#: numeric year-month text into the helper's vocabulary; the helper
#: still decides which day of the month that means.
#: `test_month_tags_match_the_engine_helper` pins this against the
#: helper so it cannot drift.
_MONTH_TAGS = {
    1: "ian", 2: "feb", 3: "mar", 4: "apr", 5: "mai", 6: "iun",
    7: "iul", 8: "aug", 9: "sep", 10: "oct", 11: "noi", 12: "dec",
}


# ── engine helpers, imported lazily to avoid an import cycle ───────────
# `pipeline` imports this module at module level; importing back at
# module level would deadlock the import graph. The helpers are resolved
# on first use and cached.

_HELPERS = None  # type: Optional[Tuple[Any, Any]]


def _helpers():
    """(_detect_period_end_from_filename, _sane_period_end) — the
    engine's own. Never reimplemented, never forked."""
    global _HELPERS
    if _HELPERS is None:
        from .pipeline import (  # noqa: WPS433 — deliberate lazy import
            _detect_period_end_from_filename,
            _sane_period_end,
        )
        _HELPERS = (_detect_period_end_from_filename, _sane_period_end)
    return _HELPERS


# ── lexical normalization (W5) ────────────────────────────────────────


def _ym_to_tag(year: str, month: str) -> str:
    return "%s %s" % (_MONTH_TAGS[int(month)], year)


def _normalize_for_helper(text: str) -> str:
    """Rewrite date-ish text into the vocabulary the engine helper
    already parses. Purely lexical — it never decides a date.

    Runs ONLY as a second pass, after the helper has already been given
    the raw text and found nothing, so no currently-working filename can
    change meaning:

      "tb_2025-12.xlsx"  -> "tb dec 2025.xlsx"   (year-month)
      "TB 09-2024.xlsx"  -> "TB sep 2024.xlsx"   (month-year)
      "balanta_2025.xls" -> "balanta 2025.xls"   ('_' is a word char, so
                                                  the helper's \\b anchors
                                                  never fire on '_2025')
      "dec2025.xls"      -> "dec 2025.xls"       (letter/digit run split)
      "FY2025.xlsx"      -> "FY 2025.xlsx"
    """
    s = str(text)
    # YYYY-MM not followed by a day part.
    s = re.sub(
        r"(?<!\d)(20\d{2})[._\-](0?[1-9]|1[0-2])(?![._\-]?\d)",
        lambda m: _ym_to_tag(m.group(1), m.group(2)),
        s,
    )
    # MM-YYYY.
    s = re.sub(
        r"(?<!\d)(0?[1-9]|1[0-2])[._\-](20\d{2})(?!\d)",
        lambda m: _ym_to_tag(m.group(2), m.group(1)),
        s,
    )
    # '_' is a word character, so it suppresses the helper's \b anchors.
    s = s.replace("_", " ")
    # Split letter<->digit runs so "dec2025" / "FY2025" gain boundaries.
    s = re.sub(r"(?<=[A-Za-z])(?=\d)", " ", s)
    s = re.sub(r"(?<=\d)(?=[A-Za-z])", " ", s)
    return s


def _date_from_text(text: Optional[str]) -> Optional[str]:
    """Resolve an ISO period-end date out of arbitrary text, or None.

    Order: exact ISO date -> engine helper on the raw text -> engine
    helper on the lexically normalized text. Every candidate passes
    through `_sane_period_end`, and a candidate equal to today is
    refused (W4: today is the helper's "found nothing" value and can
    never be evidence)."""
    if text is None:
        return None
    s = str(text).strip()
    if not s or not any(ch.isdigit() for ch in s):
        # A date needs digits. Short-circuiting here also keeps the
        # helper's "no date pattern" warning out of the logs for the
        # ordinary case of prose with no date in it.
        return None

    detect_from_filename, sane = _helpers()
    today = date.today().isoformat()

    # 1. An exact ISO date (the common `parsed["period_end"]` shape).
    try:
        iso = date.fromisoformat(s[:10]).isoformat()
    except (TypeError, ValueError):
        iso = None
    if iso is not None:
        clamped = sane(iso)
        if clamped and clamped != today:
            return clamped
        if clamped == today:
            return None
        # Out of range (the legacy 2050-12-31 / 2115-03-31 rows): fall
        # through rather than propose a corrupt period.

    # 2/3. The engine's own text date extractor, raw then normalized.
    def _run(candidate_text: str) -> Optional[str]:
        value = sane(detect_from_filename(candidate_text))
        return value if value and value != today else None

    raw_value = _run(s)
    normalized = _normalize_for_helper(s)
    norm_value = _run(normalized) if normalized != s else None

    if raw_value and norm_value and norm_value != raw_value:
        # The normalized pass may only REFINE the month inside the year
        # the helper already found — never move the year.
        #
        # Refinement is the point: on "TB 09-2024.xlsx" the helper's
        # own patterns have no month-year rule, so it falls through to
        # its year-only rule and answers 2024-12-31 — filing a
        # September trial balance in December, which is precisely the
        # misfiling class this lane exists to end. Normalizing to
        # "TB sep 2024.xlsx" lets the HELPER read the month it already
        # knows how to read.
        #
        # The same-year guard is the safety rail: a lexical rewrite
        # must never be able to relabel a document's YEAR, so a
        # disagreeing year always loses to the raw pass.
        if norm_value[:4] == raw_value[:4]:
            return norm_value
        return raw_value
    return raw_value or norm_value


# ── tiers ─────────────────────────────────────────────────────────────


def _snippet(text: Any, limit: int = 140) -> str:
    """The literal evidence, whitespace-collapsed, for the UI's 'why'
    line. Never paraphrased — the reader must be able to find it in the
    document."""
    s = re.sub(r"\s+", " ", str(text)).strip()
    if len(s) > limit:
        s = s[: limit - 1].rstrip() + "…"
    return s


def _filename_candidate(filename: Optional[str]) -> Optional[Dict[str, Any]]:
    if not filename:
        return None
    value = _date_from_text(filename)
    if not value:
        return None
    return {
        "signal": "filename",
        "period_end": value,
        "evidence_snippet": _snippet(filename),
    }


def _in_document_candidate(
    extracted: Optional[Dict[str, Any]],
    filename_value: Optional[str],
) -> Optional[Dict[str, Any]]:
    """A period end the document itself states.

    A value identical to the filename's own answer is NOT emitted here.
    On the deterministic trial-balance path the engine seeds
    `parsed["period_end"]` with `_detect_period_end_from_filename(...)`
    (pipeline.py ~line 672), so an equal value carries zero independent
    evidence; reporting it as `in_document` would tell the operator the
    document said something it never said."""
    if not isinstance(extracted, dict):
        return None
    for key in _IN_DOCUMENT_KEYS:
        raw = extracted.get(key)
        if raw is None or raw == "":
            continue
        value = _date_from_text(raw)
        if not value or value == filename_value:
            continue
        return {
            "signal": "in_document",
            "period_end": value,
            "evidence_snippet": _snippet(raw),
        }
    return None


def _closing_balance_candidate(
    extracted: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """A date sitting next to closing-balance vocabulary in the
    document's own text ("BALANTA DE VERIFICARE la data de 31.12.2025",
    "Solduri finale 30.06.2025", "closing balance as at 2025-12-31").

    Free text is only mined INSIDE a vocabulary window: a bare date
    anywhere on the page (a print timestamp, an invoice date) is not
    evidence of the period and is deliberately ignored."""
    if not isinstance(extracted, dict):
        return None

    for key in _CLOSING_DATE_KEYS:
        raw = extracted.get(key)
        if raw:
            value = _date_from_text(raw)
            if value:
                return {
                    "signal": "closing_balance",
                    "period_end": value,
                    "evidence_snippet": _snippet(raw),
                }

    for key in _CLOSING_TEXT_KEYS:
        raw = extracted.get(key)
        if not raw:
            continue
        text = str(raw)
        lowered = text.lower()
        # Leftmost vocabulary hit first — reading order, and
        # deterministic regardless of the phrase list's own order.
        hits = []  # type: List[Tuple[int, str]]
        for phrase in _CLOSING_VOCABULARY:
            start = lowered.find(phrase)
            while start != -1:
                hits.append((start, phrase))
                start = lowered.find(phrase, start + 1)
        for start, _phrase in sorted(hits):
            window = text[start:start + _WINDOW]
            value = _date_from_text(window)
            if value:
                return {
                    "signal": "closing_balance",
                    "period_end": value,
                    "evidence_snippet": _snippet(window),
                }
    return None


# ── the service ───────────────────────────────────────────────────────


def detect_period(
    *,
    extracted: Optional[Dict[str, Any]],
    filename: Optional[str]
) -> Dict[str, Any]:
    """Propose the period this document belongs to, from its own
    evidence alone.

    W1: these two keyword-only parameters are the COMPLETE input. There
    is no channel — no argument, no ``**kwargs`` — through which the
    open period, the drop target or any other UI state could reach this
    decision. That absence is the fix.

    Args:
      extracted: the parse/preview of the document, or None. Read keys
        (all optional, snake_case or camelCase):
          period_end / period_label        -> in_document
          closing_balance_date             -> closing_balance
          closing_balance_label,
          header_text, period_text,
          document_text, preamble          -> closing_balance (mined
                                              inside a vocabulary window)
        Unknown keys are ignored, so callers may pass the whole parse.
      filename: the document's original filename, or None.

    Returns a dict with exactly these keys:
      proposed_period_end : ISO 'YYYY-MM-DD', or None when ABSENT
      confidence          : 0.0 .. 0.95, by tier (see CONFIDENCE)
      signal_used         : one of SIGNALS
      evidence_snippet    : the literal text that produced the answer,
                            for the UI's "why" line; None when ABSENT
      candidates          : every tier that resolved, in rank order —
                            [{signal, period_end, evidence_snippet}] —
                            so a caller can show the disagreement
                            ("the content says 2025-12, the filename
                            says 2017-12") instead of only the winner.
    """
    filename_candidate = _filename_candidate(filename)
    filename_value = filename_candidate["period_end"] if filename_candidate else None

    ranked = [
        _in_document_candidate(extracted, filename_value),
        _closing_balance_candidate(extracted),
        filename_candidate,
    ]
    candidates = [c for c in ranked if c]

    if not candidates:
        # W3 — ABSENT. Not today, not the open period, not a guess.
        return {
            "proposed_period_end": None,
            "confidence": CONFIDENCE["none"],
            "signal_used": "none",
            "evidence_snippet": None,
            "candidates": [],
        }

    winner = candidates[0]
    return {
        "proposed_period_end": winner["period_end"],
        "confidence": CONFIDENCE[winner["signal"]],
        "signal_used": winner["signal"],
        "evidence_snippet": winner["evidence_snippet"],
        "candidates": candidates,
    }
