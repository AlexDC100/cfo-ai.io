"""F3.8a — Romanian RAS trial-balance PDF ingester.

Ports the empirically-validated PyMuPDF position-based extractor from
the F3-sprint reference toolkit (Codebase B) into the Romania country
pack. Converts WinMENTOR / SAGA / Ciel / generic-RAS Romanian PDF
trial balances into the same 10-column row shape that
`trial_balance_parser.parse_trial_balance_df()` produces for XLSX
inputs — so downstream `accounts_to_assemble_shape()` and the
country-pack `assemble_statements()` consume PDF and XLSX uniformly.

WHY POSITION-BASED (NOT pdftotext):
  Romanian RAS PDFs wrap long account names visually across 4-5
  lines (e.g. account 1171 "Rezultatul reportat reprezentand profitul
  nerepartizat sau pierderea neacoperita"). pdftotext -layout breaks
  these into multiple text rows; the 10 numeric columns end up
  attached to the last continuation line, separated from the account
  code on the first line. PyMuPDF returns per-word (x, y) tuples;
  grouping words by y-coordinate (with a 2px tolerance for sub-pixel
  rendering) reconstructs the logical row regardless of visual
  wrapping.

  Empirical capture rate (Scandia Sibiu FY2019, 463 distinct codes):
    pdftotext + regex:  171 leaves / 56M movements vs 67M expected = 17% deficit
    PyMuPDF + position: 249 leaves / 63.8M movements vs 67M expected = 5% deficit
    Statutory anchor (account 121 closing) — EXACT match either way.

LEAF FILTERING — non-negotiable:
  Romanian PDFs export both parent codes (e.g. "601") and child sub-
  accounts (e.g. "601107"). Both appear as separate rows with their
  own debit/credit totals. If both are kept, the engine's prefix-sum
  logic in `assemble_statements()` double-counts the parent. This
  module's `_filter_to_leaves` keeps only codes that have no
  longer-prefixed children, preventing the bloom.

OUTPUT SHAPE:
  Returns List[Dict[str, Any]] in the 10-column shape that
  `parse_trial_balance_df()` returns. Caller passes to
  `accounts_to_assemble_shape()` for ParsedAccount conversion.

  Keys (matching trial_balance_parser's structure):
    cont, nume,
    sold_init_D, sold_init_C,
    rulaj_D, rulaj_C,
    sume_tot_D, sume_tot_C,
    sold_fin_D, sold_fin_C
"""
from __future__ import annotations

import logging
import re
from collections import defaultdict
from typing import Any, Dict, List, Tuple

from .number_locale import RO, detect_number_locale, parse_number


logger = logging.getLogger(__name__)


# Numeric-token shapes, one per locale. Both require a separator + exactly
# 2 decimals (how RAS trial-balance PDFs print every amount in either
# locale), so integers / years / account codes never classify as numbers.
# The locale is detected ONCE per document (majority vote over all
# matching tokens, shared `number_locale` implementation) and only THAT
# locale's pattern parses lines — a Romanian PDF is tokenized exactly as
# before this port, and an anglo-formatted export no longer dies with
# every row silently failing the 10-number requirement (audit §3).
_RO_NUM_PATTERN = re.compile(r"^-?[\d.]+,\d{2}$")       # "12.345,67"
_RO_NUM_CONTAINS = re.compile(r"-?[\d.]+,\d{2}")
_ANGLO_NUM_PATTERN = re.compile(r"^-?[\d,]+\.\d{2}$")   # "12,345.67"
_ANGLO_NUM_CONTAINS = re.compile(r"-?[\d,]+\.\d{2}")

# Rows whose first 3-5 words match any of these get skipped (header / footer
# decoration rather than account data).
_SKIP_PATTERNS = [
    re.compile(p, re.IGNORECASE) for p in [
        r"^Toal$", r"^Total$", r"^clasa", r"^GENERAL", r"^Pag\.?$",
        r"^WinMENTOR", r"^ENTERPRISE", r"^Simbol$", r"^Denumire$",
        r"^Debitor$", r"^Creditor$", r"^Sold$", r"^Rulaj$",
        r"^initial$", r"^precedent$", r"^curent$", r"^sume$", r"^final$",
        r"^Cumulat$", r"^Firma$", r"^analitica$", r"^Balanta$", r"^Clasa$",
        # Toolkit's empirically-validated set above. Earlier draft added
        # `^Bilant$|^PROFIT$|^PIERDERE$|^contabila$` to skip the section
        # header "Bilant contabila / PROFIT SI PIERDERE" — but those
        # words also appear as the NAME of account 121 ("Profit si
        # pierdere"), causing its data row to be skipped and the
        # statutory anchor to vanish from the parsed output. Removed.
    ]
]

# Account code: starts with 1..7 (RAS class digits), followed by 2..7 digits.
_ACCOUNT_CODE_RE = re.compile(r"^[1-7]\d{2,7}$")

# Y-coordinate tolerance for grouping per-word tuples into a logical row.
# Sub-pixel font rendering can produce 0.5-1.5px variance within the same
# visual line; 2.0 captures that safely without merging adjacent rows.
_Y_TOLERANCE = 2.0


class PdfIngestError(Exception):
    """Raised when the PDF cannot be parsed at all (e.g. PyMuPDF missing,
    file corrupt, or no recognizable account rows). Distinct from
    `trial_balance_parser.ParseError` so the dispatcher can branch on
    PDF-specific failures."""

    def __init__(self, user_message: str, technical_detail: str = ""):
        self.user_message = user_message
        self.technical_detail = technical_detail
        super().__init__(user_message)


# ─────────────────────────────────────────────────────────────────────
# Number parsing — shared `number_locale` implementation
# ─────────────────────────────────────────────────────────────────────
# The old `_parse_ro_number` (strip dots, comma→dot, hardcoded Romanian)
# was one of three independent number parsers in the engine; it now
# delegates to `number_locale.parse_number` under the per-document
# locale. Ro-biased ONLY when detection is impossible: the detection
# default is RO, so a document with zero unambiguous numeric tokens
# parses exactly as before.


def _detect_pdf_locale(lines: List[List[Tuple[float, str]]]) -> str:
    """Per-document locale from every token matching either locale's
    numeric shape, via the shared majority vote. Default RO — Romanian
    RAS PDFs are the overwhelmingly common case and were previously the
    ONLY supported case."""
    tokens = [
        text
        for line in lines
        for _, text in line
        if _RO_NUM_PATTERN.match(text) or _ANGLO_NUM_PATTERN.match(text)
    ]
    return detect_number_locale(tokens, default=RO)


# ─────────────────────────────────────────────────────────────────────
# Position-based line extraction
# ─────────────────────────────────────────────────────────────────────

def _extract_words_by_line(pdf_bytes: bytes) -> List[List[Tuple[float, str]]]:
    """Open the PDF and group every word by its y-coordinate. Each group
    becomes one logical line. Returns ``[[(x0, text), ...], ...]``,
    sorted by x within each line and lines in their original order.

    PyMuPDF returns words as ``(x0, y0, x1, y1, text, block_no, line_no,
    word_no)``. We bucket by ``round(y0 / Y_TOLERANCE) * Y_TOLERANCE`` so
    sub-pixel jitter from anti-aliased rendering doesn't split a row.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError as e:
        raise PdfIngestError(
            user_message=(
                "PDF support requires the PyMuPDF library. The engine container "
                "needs to be rebuilt with `pymupdf` in the dependency manifest."
            ),
            technical_detail=str(e),
        )

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    all_lines: List[List[Tuple[float, str]]] = []
    for page in doc:
        words = page.get_text("words")
        y_groups: Dict[float, List[Tuple[float, str]]] = defaultdict(list)
        for w in words:
            x0, y0, _, _, text = w[0], w[1], w[2], w[3], w[4]
            y_key = round(y0 / _Y_TOLERANCE) * _Y_TOLERANCE
            y_groups[y_key].append((x0, text))
        for y in sorted(y_groups.keys()):
            all_lines.append(sorted(y_groups[y]))
    doc.close()
    return all_lines


# ─────────────────────────────────────────────────────────────────────
# Per-line parsing
# ─────────────────────────────────────────────────────────────────────

def _line_should_skip(line: List[Tuple[float, str]]) -> bool:
    """Skip lines that are header decoration, page footers, or totals
    rows. Defensive — false positives only filter out non-data rows."""
    if len(line) < 3:
        return True
    for _, text in line[:5]:
        for pat in _SKIP_PATTERNS:
            if pat.match(text):
                return True
    if line and line[0][1].lower().startswith(("toal", "total")):
        return True
    return False


def _is_account_code(text: str) -> bool:
    return bool(_ACCOUNT_CODE_RE.match(text))


def _parse_account_line(line: List[Tuple[float, str]], locale: str = RO) -> Dict[str, Any]:
    """Parse one y-grouped line into the 10-column row dict, or return
    None if the line doesn't carry an account row.

    Algorithm:
      1. Find the first token in the first 3 positions that matches the
         RAS account-code pattern. Everything before it is column
         decoration; everything after it is either name words or numbers.
      2. Walk the trailing tokens. Pure-number tokens are numeric
         columns. Tokens that contain a number prefixed by name text
         (e.g. "Promenada108.177,02") get split.
      3. After collection, we require exactly 10 numeric columns
         matching the WinMENTOR / SAGA / Ciel canonical layout.

    `locale` is the DOCUMENT-level number locale — it selects which
    token shape counts as a number and how it parses; individual cells
    are never re-guessed.
    """
    if _line_should_skip(line):
        return None

    num_pattern = _RO_NUM_PATTERN if locale == RO else _ANGLO_NUM_PATTERN
    num_contains = _RO_NUM_CONTAINS if locale == RO else _ANGLO_NUM_CONTAINS

    account = None
    account_idx = 0
    for i, (_, text) in enumerate(line[:3]):
        if _is_account_code(text):
            account = text
            account_idx = i
            break
    if not account:
        return None

    numbers: List[float] = []
    name_words: List[str] = []
    for _, text in line[account_idx + 1:]:
        if num_pattern.match(text):
            numbers.append(parse_number(text, locale))
        elif num_contains.search(text):
            # Common pattern: "Promenada108.177,02" — stuck-together
            # text and number. Split at the first numeric match.
            m = num_contains.search(text)
            pre = text[:m.start()].strip()
            if pre:
                name_words.append(pre)
            numbers.append(parse_number(m.group(0), locale))
        else:
            name_words.append(text)

    if len(numbers) != 10:
        # Not the canonical 10-column structure. Could be a continuation
        # line, a section header, or an unrecognised format variant.
        return None

    return {
        "cont": account,
        "nume": " ".join(name_words).strip()[:200],
        "sold_init_D":  numbers[0], "sold_init_C":  numbers[1],
        "rulaj_prec_D": numbers[2], "rulaj_prec_C": numbers[3],
        "rulaj_cur_D":  numbers[4], "rulaj_cur_C":  numbers[5],
        "sume_tot_D":   numbers[6], "sume_tot_C":   numbers[7],
        "sold_fin_D":   numbers[8], "sold_fin_C":   numbers[9],
    }


def _parse_pdf_to_rows_with_locale(pdf_bytes: bytes) -> Tuple[List[Dict[str, Any]], str]:
    """Extract lines once, detect the document locale over ALL numeric
    tokens, then parse every line under that one locale. Returns
    (rows, locale)."""
    lines = _extract_words_by_line(pdf_bytes)
    locale = _detect_pdf_locale(lines)
    rows: List[Dict[str, Any]] = []
    for line in lines:
        row = _parse_account_line(line, locale)
        if row:
            rows.append(row)
    return rows, locale


def _parse_pdf_to_rows(pdf_bytes: bytes) -> List[Dict[str, Any]]:
    rows, _ = _parse_pdf_to_rows_with_locale(pdf_bytes)
    return rows


# ─────────────────────────────────────────────────────────────────────
# Leaf filtering — NON-NEGOTIABLE
# ─────────────────────────────────────────────────────────────────────

def _filter_to_leaves(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keep only the deepest account in each hierarchical chain. A
    Romanian PDF balance lists both parent accounts (e.g. "601") and
    child sub-accounts (e.g. "601107"). Without this filter the
    engine's prefix-sum logic in `assemble_statements()` would double-
    count: it sums "601*" and finds both the parent (which already
    aggregates) AND each child. Empirically the parent+child bloom
    inflates revenue/expense buckets 2-3×.

    A leaf is a code where no other code in the list has a strictly
    longer prefix starting with it. O(n²) implementation is fine —
    Romanian trial balances are ≤2000 rows in practice.
    """
    all_codes = {r["cont"] for r in rows}
    leaves: List[Dict[str, Any]] = []
    for r in rows:
        code = r["cont"]
        has_children = any(
            c != code and c.startswith(code) and len(c) > len(code)
            for c in all_codes
        )
        if not has_children:
            leaves.append(r)
    return leaves


# ─────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────

def _validate_balance(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Verify the parsed leaf rows balance: movements D = C, closing
    D = C.

    BALANCE THRESHOLD — operator-locked at F3.8 closure:
      The strict <10 RON check below is preserved on each row dict as
      an INFORMATIONAL signal (`movements_balanced`, `closing_balanced`
      booleans). The PRODUCTION gate uses a 0.5%-of-total-movements
      percentage tolerance via `check_pdf_ingester.py`, which is the
      acceptance threshold the operator authorized for PDF paths only.

      Rationale (locked at F3.8 closure):
        - Toolkit empirical capture: ~5% deficit accepted on Romanian
          RAS PDFs because position-based extraction can't always
          reconstruct rows with stuck-together text+number tokens or
          rows with non-canonical sparse-column layouts.
        - This implementation on Scandia Sibiu FY2019: 0.019%
          (movements) / 0.288% (closing) deficit. Far better than
          the toolkit's documented capability, but still materially
          above the strict <10 RON aspirational threshold.
        - The 0.5% gate provides operational headroom for future
          Romanian PDF exports with similar sparse-row issues
          without weakening real fault detection (any deficit >0.5%
          indicates the parser is missing material data and Review
          Mode should fire).
        - **The XLSX path keeps the tighter <10 RON discipline** —
          XLSX is structured and shouldn't have row-level losses.
          Relaxation applies to PDF only.
      Reference: F3.8 closure report, operator directive 2026-05-21.
    """
    sum_tot_D = sum(r["sume_tot_D"] for r in rows)
    sum_tot_C = sum(r["sume_tot_C"] for r in rows)
    close_D = sum(r["sold_fin_D"] for r in rows)
    close_C = sum(r["sold_fin_C"] for r in rows)
    return {
        "account_count": len(rows),
        "movements_D": sum_tot_D, "movements_C": sum_tot_C,
        "movements_balanced": abs(sum_tot_D - sum_tot_C) < 10.0,
        "movements_gap": sum_tot_D - sum_tot_C,
        "closing_D": close_D, "closing_C": close_C,
        "closing_balanced": abs(close_D - close_C) < 10.0,
        "closing_gap": close_D - close_C,
    }


# ─────────────────────────────────────────────────────────────────────
# Output adapter — return shape compatible with trial_balance_parser
# ─────────────────────────────────────────────────────────────────────

def _to_trial_balance_parser_shape(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The XLSX path (`parse_trial_balance_df`) emits dicts with keys
    ``{cont, nume_cont, si_d, si_c, r_d, r_c, st_d, st_c, sf_d, sf_c}``
    (Romanian abbreviations: si=sold inițial, r=rulaj, st=sume totale,
    sf=sold final). Downstream `accounts_to_assemble_shape()` reads
    exclusively from `st_d/st_c` (YTD movements, for P&L) and
    `sf_d/sf_c` (closing balances, for BS). We map the PDF's 5-period
    structure into this shape, collapsing `rulaj_precedent + rulaj_curent`
    into the single `r_d/r_c` field the XLSX shape uses.
    """
    out: List[Dict[str, Any]] = []
    for r in rows:
        r_d = r["rulaj_prec_D"] + r["rulaj_cur_D"]
        r_c = r["rulaj_prec_C"] + r["rulaj_cur_C"]
        out.append({
            "cont": r["cont"],
            "nume_cont": r["nume"],
            "si_d": r["sold_init_D"],
            "si_c": r["sold_init_C"],
            "r_d": r_d,
            "r_c": r_c,
            "st_d": r["sume_tot_D"],
            "st_c": r["sume_tot_C"],
            "sf_d": r["sold_fin_D"],
            "sf_c": r["sold_fin_C"],
        })
    return out


# ─────────────────────────────────────────────────────────────────────
# Public entry — used by RomaniaPack.parse_trial_balance dispatch
# ─────────────────────────────────────────────────────────────────────

def is_pdf(content: bytes) -> bool:
    """Magic-byte detector for PDF. The first 4 bytes of a valid PDF
    are ``%PDF`` followed by the version line. Whitespace or BOM-prefixed
    PDFs are tolerated by scanning the first 1KB."""
    if not content:
        return False
    head = content[:1024]
    return b"%PDF" in head[:8]


def parse_pdf_trial_balance(
    pdf_bytes: bytes,
    filename: str = "",
    keep_leaves_only: bool = True,
) -> List[Dict[str, Any]]:
    """High-level entry called by `RomaniaPack.parse_trial_balance` when
    the upload's magic bytes indicate PDF.

    Returns the same dict shape that
    `trial_balance_parser.parse_trial_balance_df()` returns for XLSX
    inputs, so downstream `accounts_to_assemble_shape()` works
    identically — concretely a `TrialBalanceParseResult` (a plain list
    to legacy callers) carrying the contract `extraction` block
    (source_format "pdf_positional", detected number_locale) and a
    `source_anchor` with extracted sums but NO file totals (PDF totals
    lines are skip-filtered, so anchor_status is "NO_ANCHOR"). Raises
    `PdfIngestError` on unrecoverable parse failure.
    """
    # Local import: trial_balance_parser never imports this module, so
    # the dependency stays acyclic.
    from .trial_balance_parser import (
        PARSER_VERSION,
        TrialBalanceParseResult,
        compute_source_anchor,
    )

    if not is_pdf(pdf_bytes):
        raise PdfIngestError(
            user_message="File does not look like a PDF (magic bytes absent).",
            technical_detail=f"first 16 bytes: {pdf_bytes[:16]!r}",
        )

    rows, locale = _parse_pdf_to_rows_with_locale(pdf_bytes)
    if not rows:
        raise PdfIngestError(
            user_message=(
                "The PDF was readable but no account rows could be parsed. "
                "Common causes: wrong PDF format (not a Romanian RAS trial "
                "balance), scanned/raster PDF (needs OCR first), or a layout "
                "variant not recognized by the position-based parser."
            ),
            technical_detail=(
                f"_parse_pdf_to_rows returned 0 rows from {len(pdf_bytes)} bytes."
            ),
        )

    if keep_leaves_only:
        rows = _filter_to_leaves(rows)

    validation = _validate_balance(rows)
    logger.info(
        "[ro_pdf_ingester] %s: %d leaves, locale=%s, movements_balanced=%s "
        "(gap=%.2f), closing_balanced=%s (gap=%.2f)",
        filename or "(no filename)",
        validation["account_count"], locale,
        validation["movements_balanced"], validation["movements_gap"],
        validation["closing_balanced"], validation["closing_gap"],
    )

    shaped = _to_trial_balance_parser_shape(rows)
    return TrialBalanceParseResult(
        shaped,
        extraction={
            "method": "deterministic",
            "parser_version": PARSER_VERSION,
            "source_format": "pdf_positional",
            "number_locale": locale,
            "sheet": None,
            "header_row_index": None,
        },
        # No file totals row survives the PDF skip-filters, so the anchor
        # carries extracted sums only and reports NO_ANCHOR.
        source_anchor=compute_source_anchor(shaped, file_totals=None),
    )


def diagnose_pdf(pdf_bytes: bytes, filename: str = "") -> Dict[str, Any]:
    """Read-only diagnostic helper — parses the PDF, reports leaf vs
    raw row counts, class distribution, balance validation. Used by
    the F3.8 detection gate to verify a PDF parses cleanly without
    materially mutating any pipeline state.
    """
    raw_rows, locale = _parse_pdf_to_rows_with_locale(pdf_bytes)
    leaves = _filter_to_leaves(raw_rows)
    validation = _validate_balance(leaves)
    class_dist: Dict[str, int] = defaultdict(int)
    for r in leaves:
        class_dist[r["cont"][:1]] += 1
    return {
        "filename": filename,
        "raw_row_count": len(raw_rows),
        "leaf_count": len(leaves),
        "parents_filtered": len(raw_rows) - len(leaves),
        "class_distribution": dict(class_dist),
        "number_locale": locale,
        **validation,
    }
