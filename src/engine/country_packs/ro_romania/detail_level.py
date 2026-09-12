"""WHICH BOOK IS THIS — synthetic, analytic, or mixed.

OMFP 1802 numbers the Romanian chart by grade: one digit is a class
(6 — expenses), two a group (60 — purchases), three a synthetic account
of grade I (601 — raw materials), four a synthetic account of grade II
(6021 — auxiliary materials). Everything DEEPER than four digits is an
analytic account: the entity's own subdivision, one code per supplier,
contract, plant or cost centre. That boundary is the whole content of
this module, and it is a chart-of-accounts fact, which is why it lives in
the pack and not in `engine.comparatives`.

WHAT IT IS FOR. A client sends two years and one of them is the external
condensed balanță (the one that goes to the bank) while the other is the
internal analytic export. Nothing in either file says so. The detection
below says so, deterministically, from the codes themselves — and
`engine.comparatives` then refuses to strike a comparison at a level
either book cannot support.

THE SIGNALS, and which of them decide.

  DECISIVE — modal account-code depth, and the share of rows on each side
  of the synthetic boundary. Depth is what the boundary is defined on;
  the share is what separates a pure book from a mixed one.

  CORROBORATING, NEVER DECISIVE — row count and the presence of a header
  identity block (the company name / address / `Cod fiscal` rows that a
  report-generator stamps above the column headers of an externally-
  issued balanță; an internal export starts at the header row). Both
  correlate strongly with the condensed external book — on the two real
  Scandia books, perfectly — and neither is evidence. A 3,000-row book
  can be synthetic (a group with many entities' worth of accounts); an
  internal export can carry an identity banner. Letting a banner flip a
  classification would be guessing dressed as detection, so these two are
  recorded in the signals, quoted in the reason, and never consulted by
  the branch.

REFUSAL. A book with no usable account codes is INDETERMINATE, not
synthetic. "We could not tell" and "it is the coarse one" are different
facts and only one of them permits a comparison.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from engine.comparatives.levels import (
    ANALYTIC,
    INDETERMINATE,
    MIXED,
    SYNTHETIC,
)

__all__ = [
    "SYNTHETIC_MAX_DIGITS",
    "MIXED_MINORITY_FLOOR",
    "account_code_depth",
    "DetailLevelSignals",
    "DetailLevel",
    "classify_detail_level",
    "detail_level_from_rows",
]

#: OMFP 1802: grade-II synthetic accounts are four digits. Five or more is
#: the entity's own analytic subdivision. This is the boundary the whole
#: module is defined on; it is a chart fact, not a tuning knob.
SYNTHETIC_MAX_DIGITS = 4

#: A book is PURE when fewer than this share of its classifiable rows sit
#: on the far side of the boundary from its modal depth; at or above it,
#: the book is MIXED. Real analytic exports carry a handful of accounts
#: that were never subdivided (121, 129, 691), and one un-subdivided
#: account does not make a book mixed. Five percent of a 247-row book is
#: 13 rows — enough to be a habit, not enough to be a rounding error.
MIXED_MINORITY_FLOOR = 0.05

#: Separators a report generator may print inside a code ("601.01",
#: "601 01", "601-01"). Stripped before the digits are counted; a code is
#: usable only if what remains is all digits.
_SEPARATORS = re.compile(r"[\s.\-/_]")


def account_code_depth(code: Any) -> Optional[int]:
    """Digit count of an account code, or None when it is not one.

    None — never 0 — for a blank cell, a totals row ("TOTAL"), a NaN, or
    anything left holding a non-digit after separators are stripped. A
    depth of 0 would be a code of zero digits, which is a different claim.
    """
    if code is None:
        return None
    text = _SEPARATORS.sub("", str(code).strip())
    if not text or not text.isdigit():
        return None
    return len(text)


@dataclass(frozen=True)
class DetailLevelSignals:
    """Everything the classification looked at, kept so a reader can
    re-derive the verdict rather than trust it."""

    #: Rows offered, including the ones that carried no usable code.
    row_count: int
    #: Rows that carried a usable account code — the classification base.
    classifiable_count: int
    #: ((digits, rows), …) ascending by digits. A tuple of tuples so the
    #: whole signals record stays frozen and hashable.
    depth_histogram: Tuple[Tuple[int, int], ...]
    modal_depth: Optional[int]
    modal_share: Optional[float]
    #: Share of classifiable rows at or below `SYNTHETIC_MAX_DIGITS`.
    synthetic_share: Optional[float]
    #: Share above it. `synthetic_share + analytic_share == 1.0`.
    analytic_share: Optional[float]
    #: CORROBORATING ONLY — see the module docstring.
    header_identity_block: bool


@dataclass(frozen=True)
class DetailLevel:
    """The verdict for one period."""

    level: str
    modal_depth: Optional[int]
    signals: DetailLevelSignals
    reason: str

    @property
    def is_indeterminate(self) -> bool:
        return self.level == INDETERMINATE


def _histogram(depths: Sequence[int]) -> Tuple[Tuple[int, int], ...]:
    counts = {}  # type: Dict[int, int]
    for d in depths:
        counts[d] = counts.get(d, 0) + 1
    return tuple(sorted(counts.items()))


def _modal_depth(histogram: Tuple[Tuple[int, int], ...]) -> Optional[int]:
    """The most common depth. TIES BREAK TO THE SMALLER DEPTH, always —
    determinism first (the same book must classify identically on every
    run and every host), and the smaller depth is also the conservative
    side: it can only pull a verdict toward SYNTHETIC, which withholds
    breakdowns rather than inventing them."""
    if not histogram:
        return None
    best_depth, best_count = histogram[0]
    for depth, count in histogram[1:]:
        if count > best_count:
            best_depth, best_count = depth, count
    return best_depth


def classify_detail_level(
    account_codes: Iterable[Any],
    header_identity_block: bool = False,
    row_count: Optional[int] = None,
) -> DetailLevel:
    """THE PURE FUNCTION. Codes in, verdict out — no file access, no
    clock, no global state, no jurisdiction lookup.

    `header_identity_block` and `row_count` are recorded and quoted; they
    never move the verdict (module docstring, "CORROBORATING").
    """
    codes = list(account_codes)
    depths = []  # type: List[int]
    for code in codes:
        d = account_code_depth(code)
        if d is not None:
            depths.append(d)

    offered = len(codes) if row_count is None else int(row_count)
    histogram = _histogram(depths)
    classifiable = len(depths)

    banner = (
        "; a header identity block is present" if header_identity_block
        else "; no header identity block"
    )

    if classifiable == 0:
        return DetailLevel(
            level=INDETERMINATE,
            modal_depth=None,
            signals=DetailLevelSignals(
                row_count=offered,
                classifiable_count=0,
                depth_histogram=(),
                modal_depth=None,
                modal_share=None,
                synthetic_share=None,
                analytic_share=None,
                header_identity_block=header_identity_block,
            ),
            reason=(
                "none of the %d rows carried a usable account code, so no "
                "detail level was established%s" % (offered, banner)
            ),
        )

    modal = _modal_depth(histogram)
    modal_count = dict(histogram)[modal]
    modal_share = modal_count / float(classifiable)
    synthetic_count = sum(c for d, c in histogram if d <= SYNTHETIC_MAX_DIGITS)
    synthetic_share = synthetic_count / float(classifiable)
    analytic_share = 1.0 - synthetic_share

    signals = DetailLevelSignals(
        row_count=offered,
        classifiable_count=classifiable,
        depth_histogram=histogram,
        modal_depth=modal,
        modal_share=modal_share,
        synthetic_share=synthetic_share,
        analytic_share=analytic_share,
        header_identity_block=header_identity_block,
    )

    modal_is_synthetic = modal <= SYNTHETIC_MAX_DIGITS
    minority_share = analytic_share if modal_is_synthetic else synthetic_share

    if minority_share >= MIXED_MINORITY_FLOOR:
        level = MIXED
        reason = (
            "modal depth %d over %d classifiable rows, but %.1f%% sit on "
            "the other side of the %d-digit synthetic boundary — at or "
            "above the %.1f%% floor, so the book carries both kinds and "
            "neither can be relied on account by account%s"
            % (modal, classifiable, minority_share * 100.0,
               SYNTHETIC_MAX_DIGITS, MIXED_MINORITY_FLOOR * 100.0, banner)
        )
    elif modal_is_synthetic:
        level = SYNTHETIC
        reason = (
            "modal depth %d (%.1f%% of %d classifiable rows) is at or "
            "below the %d-digit synthetic boundary and only %.1f%% of "
            "rows are deeper, under the %.1f%% mixed floor%s"
            % (modal, modal_share * 100.0, classifiable,
               SYNTHETIC_MAX_DIGITS, analytic_share * 100.0,
               MIXED_MINORITY_FLOOR * 100.0, banner)
        )
    else:
        level = ANALYTIC
        reason = (
            "modal depth %d (%.1f%% of %d classifiable rows) is deeper "
            "than the %d-digit synthetic boundary and only %.1f%% of rows "
            "are shallower, under the %.1f%% mixed floor%s"
            % (modal, modal_share * 100.0, classifiable,
               SYNTHETIC_MAX_DIGITS, synthetic_share * 100.0,
               MIXED_MINORITY_FLOOR * 100.0, banner)
        )

    return DetailLevel(level=level, modal_depth=modal, signals=signals,
                       reason=reason)


#: Keys a parsed trial-balance row may carry the account code under. The
#: deterministic parser emits `cont`; the assemble shape emits `code`.
_CODE_KEYS = ("cont", "code", "account_code", "ro_account_code")


def detail_level_from_rows(
    rows: Iterable[Any],
    extraction: Optional[Mapping[str, Any]] = None,
) -> DetailLevel:
    """Convenience over `classify_detail_level` for a parsed period.

    Accepts the deterministic parser's `TrialBalanceParseResult` (or any
    iterable of row dicts). When `extraction` is omitted it is read off
    the result's own `.extraction` attribute if there is one.

    The header identity block is inferred from `extraction.
    header_row_index`: a report generator that stamps the company name,
    address and `Cod fiscal` above the column headers pushes the header
    row down, so an index above zero means rows preceded it. It is
    corroborating only, and `classify_detail_level` does not branch on it.
    """
    row_list = list(rows)

    if extraction is None:
        extraction = getattr(rows, "extraction", None)
    header_index = None
    if isinstance(extraction, Mapping):
        header_index = extraction.get("header_row_index")
    try:
        banner = header_index is not None and int(header_index) > 0
    except (TypeError, ValueError):
        banner = False

    codes = []  # type: List[Any]
    for row in row_list:
        if isinstance(row, Mapping):
            value = None
            for key in _CODE_KEYS:
                if key in row:
                    value = row[key]
                    break
            codes.append(value)
        else:
            codes.append(getattr(row, "code", None))

    return classify_detail_level(
        codes,
        header_identity_block=banner,
        row_count=len(row_list),
    )
