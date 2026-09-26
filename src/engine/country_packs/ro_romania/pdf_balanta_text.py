"""Text-line reader for Romanian "Balanta de verificare" PDFs.

WHY THIS EXISTS (2026-09-21)
----------------------------
Every trial-balance PDF the position-based ingester (`pdf_ingester`) could
not read fell through to the Claude extractor. With the Anthropic account
out of credit that meant every such upload failed; and even with credit the
Claude path captures no account-121 anchor. Measured on a real book (a
Bucharest real-estate SRL, Dec 2025): `pdf_ingester` found no account rows,
because its word grouping splits space-thousands numbers ("12 345.00") into
separate tokens.

This reader works on the PDF's TEXT LINES instead. One account per line:

    <cont> <name ...> <si_d> <si_c> <rl_d> <rl_c> <st_d> <st_c> <sf_d> <sf_c>

numbers in the "1 234 567.89" (space thousands, dot decimals) or
"1.234.567,89" (dot thousands, comma decimals) shape, continuation lines
extending the name, and "Total sume clasa N" lines carrying the document's
own per-class totals.

IT REFUSES RATHER THAN APPROXIMATES. It returns None — and the caller keeps
the existing path — unless every check passes:

  * the document names itself a balanta de verificare with the four
    column blocks (solduri initiale / rulaje / sume totale / solduri finale);
  * every account line carries exactly eight numbers in ONE number format;
  * at least MIN_ACCOUNTS account lines;
  * the document prints a per-class total for every class that has
    accounts, and the accounts of each class sum to it exactly (this is
    what catches a parent listed beside its own children, a split row or a
    misread number);
  * for each of the four column pairs, total debit == total credit.

On success it returns the balance as a SAGA 10-column workbook (bytes), so
the caller hands it to the SAME `parse_trial_balance` call an .xlsx upload
takes: detection, anchor, mapping and rebuild are the Excel path, unchanged.
The engine reads the RC pair as "sume totale" (opening + cumulated rulaj),
which is exactly the document's own column, so every figure is copied
verbatim — nothing is derived here.

SECOND LAYOUT — FIVE PAIRS (2026-09-21)
---------------------------------------
WinMentor / SceptrumERP "Balanta analitica" and "Balanta sintetica" print
five column pairs under the header

    Cont Denumire Sold initial Rulaj anterior Rulaj curent Total rulaj Sold final

with the figures in ONE of the number shapes this reader accepts
(`_FORMATS_5PAIR`): comma-thousands, dot-decimals ("1,234,567.89",
"-250.00" — the layout's native print), unseparated ("1234567.89"), the
Romanian locale ("1.234.567,89") or space-thousands ("1 234 567.89",
whose figures the text extraction splits into words — `_cells` reads them
back as one figure each);
dotted analytic codes ("1015.03", "167.305"), the code repeated inside or
after the name ("121 121 Profit sau pierdere", a continuation line holding
only the code), "Clasa N" section headings and "Total clasa N:" totals.

The layout is chosen by header tokens AND by structure: a document whose
rows carry ten figure columns (`_STRUCTURAL_MIN_ROWS` lines led by an
account code and ending in ten figures of any one accepted shape) is a
five-pair book whatever its column header says — a wording variant (an
abbreviation, a header wrapped over two lines) must not let a five-pair
book escape this reader to one that approximates, and neither must the
shape its figures are printed in (a Romanian-locale or an unseparated
print is as much a five-pair book as the native one). A document whose
header names both layouts, or neither and has no such rows, is refused.
Once the five-pair layout is named, by either signal, the book is read
strictly or refused: a header this reader cannot read as the five-pair
column order is a refusal, not a fall-through.

ONE five-pair dialect is not this reader's: the WinMENTOR ENTERPRISE
"Balanta analitica" print, whose column header reads "Simbol Denumire
Sold initial Rulaj precedent Rulaj curent Total sume Sold final" over a
"Debitor Creditor" sub-header (`_POSITIONAL_DIALECT_HEADER` /
`_POSITIONAL_DIALECT_SUB_HEADER`). That exporter draws every "Clasa N"
heading and "Total clasa N" line several times over itself, so its text
lines carry no heading or total this reader could verify a class
against. It is the layout the position-based ingester (`pdf_ingester`,
F3.8) was built on, and the pipeline has always served it through that
ingester — the golden corpus case `pdf_positional` is such a book. A
document printing that header with that sub-header directly under it
names LAYOUT_FIVE_PAIR_POSITIONAL: not this reader's, not a refusal —
left to the positional path exactly as before this reader existed,
whatever its rows' figures look like. That path serves under the
positional lane's own policy (F3.8), which is not a verified read, and
this reader does not make it one: it declines to claim a layout whose
headings and totals it cannot verify, and leaves the book where the
pipeline has always sent it. The signature is the exporter's column
order AND side order: the same header over "Creditor Debitor", with
"Rulaj curent" printed before "Rulaj precedent", or without its
sub-header, is NOT that dialect — it is a five-pair book this reader
claims structurally and refuses, never one the positional ingester
reads with its sides or columns assumed.

The five-pair reader is stricter than the eight-figure one because the
document states two identities per row that can be checked to the
cent — and it refuses unless ALL of these hold:

  * the document prints EVERY figure in one shape (`_number_format`: the
    first accepted shape that fits every line ending in ten figures —
    account rows, printed totals, a wrapped row's figure line); a line
    whose figures fit another shape than the lines before it refuses
    the book, and a figure of one shape is never a figure in another
    ("1234.00" in a comma-thousands book is not a figure at all);

  * the column order is READ, never assumed: every line naming a column
    (not led by an account code) is exactly "Cont Denumire Sold initial
    Rulaj anterior Rulaj curent Total rulaj Sold final", and no account
    line precedes the first one (no arithmetic check can see Rulaj
    anterior and Rulaj curent swapped — their sum is the same);
  * the side order is read too: each column header is directly followed
    by exactly "Debit Credit" five times, and no other line reads like a
    sub-header (a credit-first book passes every other check with every
    side flipped);
  * every account line carries exactly ten figures;
  * Total rulaj == Rulaj anterior + Rulaj curent, per side, per row;
  * Sold final net == Sold initial net + Total rulaj net, per row;
  * every class with accounts has a printed "Total clasa N:" and its rows
    sum to it on all ten columns (a printed total for a class with no
    accounts must be zero); a printed "Total general:", if any, equals the
    sum of every row on all ten columns;
  * total debit == total credit on each of the five pairs;
  * no account code appears twice, none is listed beside its parent (an
    undotted code that prefixes another's base: "100" / "1000.01", "121" /
    "121.07"), and no subtotal is listed beside the rows it sums, however
    it is coded (`_subtotal_refusal`): a non-zero row is refused when its
    ten figures equal, to the cent, the sum of its children — the codes
    extending its own ("401.1" / "401.101", "401.102") or, for an all-zero
    suffix, every code sharing its base ("401.000" / "401.04", "401.02") —
    or the sum of two or more other rows under the same three-digit root
    ("401.99" / "401.04", "401.02"; "4010" / "4011", "4012"); at least
    MIN_ACCOUNTS accounts;
  * no other line carries two or more figures (a figure row this reader
    could not attribute to an account is a refusal, never a skip) — and
    neither does the NAME part of an account line, nor does it hold a
    code followed by a figure (two rows merged onto one text line);
  * a wrapped row cannot hand its figures to another code, and only the
    layout's own STRUCTURE — the column a line's first word is printed
    in, read from the words' x-positions — says which code a line belongs
    to; never the text (a number that recurs in a name, a line that
    happens to end with a code). See `_WRAP_RULE` below: the layout
    prints every account's code in ONE column and every continuation
    line in the name column, so a line led by a code-shaped token is an
    account line when that token sits in the code column and name text
    when it sits in the name column. Whatever cannot be placed — a line
    without positions, a first word between the two columns, a code-
    column line without its ten figures that is not followed by them —
    is refused, never settled by a text heuristic.

The PERIOD comes from the document when it prints one: the title block
(the lines before the first column header) carries it as "<Luna> <an>"
("Decembrie 2025") at the end of a line — on the real layout merged by the
text extraction onto the "Adresa:" line. It is read only there, only as a
Romanian month name followed by a year, never when a day number precedes
the month ("1 Decembrie 1918" is a street), and only when exactly one
period is printed; the month's last day is the period end
(`_printed_period`). Otherwise there is none, and the caller keeps the
filename's.

Negative figures are carried verbatim: a storno is a negative movement on
its own side, never a flipped side. The workbook maps SI = Sold initial,
RL = Rulaj curent, RC = Total rulaj (cumulated turnover WITHOUT the opening
balance — exactly how the same ERP's Excel export fills "Rulaj cumulat",
which the Excel path already reads), SF = Sold final. "Rulaj anterior" is
not carried: it is Total rulaj minus Rulaj curent, checked above.

THIRD LAYOUT — FOUR PAIRS, EACH FIGURE PLACED BY ITS COLUMN (2026-09-26)
-----------------------------------------------------------------------
A SAGA-style balanta prints four column pairs under the headings "Sold
initial" / "Rulaje" / "Total" / "Solduri finale", sub-headed "1 Ianuarie"
/ "luna curenta" / "sume cumulate", over a line of four "Debit Credit"
pairs (LAYOUT_FOUR_PAIR_COLUMNS, named by that header in the first 40
lines, `_four_pair_named`). It prints a zero as a BLANK cell, so an
account line carries anywhere from none to eight figures and the
eight-figure reader's "eight numbers per line" never holds: which figure
is which can only be read from where it is printed. Each account prints
its code in three parts — account, analytic, level: "4518. 2. 0" — then
its name, its figures, and the three parts again right of the figures.
Lines marked "*" are totals: an account's over its analytics, and a
three-digit group's ("TOTAL 451.0.0") over its four-digit accounts;
"Total clasa N" and "TOTAL GENERAL" close each class and the book.

The columns are READ, never assumed (`_four_columns`). The headings are
printed centred over their pairs, so a heading's centre is the edge
between its Debit and Credit columns and the midpoint between two
headings the edge between two pairs; the order of the pairs is the
order the headings are printed in. Every word right of the names is
placed in the column its centre falls in. The words are split at a
visible gap wider than 1 pt (`_FOUR_X_TOLERANCE`) — the words and the
text lines they must rebuild alike: pdfplumber's default split glues a
code part to the name printed a space's width after it, and the last
figure of a line to a label printed just right of its column.

It refuses unless ALL of these hold:

  * the header names this layout and no other; each heading and sub-
    heading is printed once, over its own pair, in the order Sold initial
    / Rulaje / Total / Solduri finale, with "Cont" and "Denumire" left of
    the figure columns and "Cont" again right of them; every page's
    header puts the columns where the first page's does;
  * every line carries word positions (a page whose words do not rebuild
    its text lines is refused), and no word of an account or total line
    is printed across a column edge — a figure between two columns;
  * every figure of a column ends at one x (within 1 pt: the columns are
    right-aligned) and within 3 pt of the edge the header puts it at —
    a figure printed out of its column refuses the book; a blank cell is
    0.00, and only number words are printed in a figure column;
  * every figure is printed in ONE of the number shapes the five-pair
    reader accepts (`_FORMATS_5PAIR`), the same one throughout;
  * the code repeated right of the figures reads as the code printed left
    of them, with 0 as its third part, and a total's label is repeated
    the same way;
  * no line carrying a figure is anything but an account, a total or the
    grand total, and no account or total follows the grand total;
  * per account: Sold final debit - credit == Total debit - credit (the
    Total pair carries the opening balance, like "sume totale") — a
    figure read on the wrong side of a pair breaks it;
  * every account with analytics has its "*" total, and it equals its
    analytics netted: an account has ONE balance, so their opening and
    closing balances are netted onto one side while their turnover is
    summed per side, and Total = the netted opening + the turnover;
  * every group with four-digit accounts has its "TOTAL" line, equal to
    the sum of those accounts' lines; every class with accounts has its
    "Total clasa N", equal to the sum of its three-digit lines (a class
    total with no accounts must be zero); the "TOTAL GENERAL", when
    printed, equals the sum of every class;
  * no account appears twice, and none beside a line of its own: a three-
    digit account printed beside its four-digit accounts, or an account
    printed on its own line (analytic 0) beside its analytics — whether
    that line is the account's own postings or its total cannot be read
    from the layout — nor any row that is a subtotal of others
    (`_subtotal_refusal`);
  * debit == credit on all four pairs; at least MIN_ACCOUNTS accounts.

The workbook carries the accounts printed without analytics and the
analytics — never a "*" line — as SI = Sold initial, RL = Rulaje (luna
curenta), RC = Total (sume cumulate: the opening balance plus the
cumulated turnover, the eight-figure layout's "sume totale"), SF =
Solduri finale, every figure verbatim; the code is "4518" for analytic
0, else "4518.2". The PERIOD is the one "<date> - <date>" range printed
in the title block, its end date the period end (`_printed_date_range`);
otherwise there is none, and the caller keeps the filename's.
"""
from __future__ import annotations

import io
import logging
import re
from decimal import Decimal
from typing import Any, Dict, List, NamedTuple, NoReturn, Optional, Tuple

logger = logging.getLogger(__name__)

MIN_ACCOUNTS = 20

# One number shape per locale; a document must use exactly one.
_NUM_SPACE = r"-?\d{1,3}(?: \d{3})*\.\d{2}"      # 1 234 567.89
_NUM_EURO = r"-?\d{1,3}(?:\.\d{3})*,\d{2}"        # 1.234.567,89

_HEADER_TOKENS = ("balanta de verificare", "solduri", "rulaj", "sume totale", "finale")
_SKIP_PREFIXES = (
    "balanta de verificare", "solduri initiale", "cont denumirea", "debitoare",
    "intocmit", "întocmit", "pagina", "page",
)
_TOTAL_CLASS = re.compile(r"^total\s+sume\s+clasa\s+(\d)\b", re.I)

# ── five-pair layout (WinMentor / SceptrumERP "Balanta analitica") ──────
_HEADER_TOKENS_5PAIR = ("balanta", "sold initial", "rulaj anterior", "rulaj curent",
                        "total rulaj", "sold final")
_CODE_5PAIR = re.compile(r"^\d{3,6}(?:\.\d{1,3})?$")             # 121, 1015.03, 167.305


class _Format(NamedTuple):
    """One number shape a five-pair book may print its figures in. A
    document prints every figure in exactly one (`_number_format`)."""

    name: str
    label: str
    figure: Any      # compiled and anchored: one cell of a line is one figure
    source: str      # the same shape, unanchored (the flattened second opinion)
    grouped: bool    # thousands groups separated by spaces: one figure spans several words


def _format(name: str, label: str, source: str, grouped: bool = False) -> _Format:
    return _Format(name, label, re.compile("^%s$" % source), source, grouped)


# The shapes this reader accepts — in the order that names a book whose
# every figure fits more than one (a book of figures below a thousand fits
# the first, second and fourth alike, and reads the same in each): the
# layout's native print first.
_FORMATS_5PAIR: Tuple[_Format, ...] = (
    _format("comma", "comma-thousands", r"-?\d{1,3}(?:,\d{3})*\.\d{2}"),               # 1,234,567.89
    _format("unseparated", "unseparated", r"-?\d+\.\d{2}"),                              # 1234567.89
    _format("euro", "dot-thousands, comma-decimals", r"-?\d{1,3}(?:\.\d{3})*,\d{2}"),  # 1.234.567,89
    _format("space", "space-thousands", r"-?\d{1,3}(?: \d{3})*\.\d{2}", grouped=True),  # 1 234 567.89
)
_FORMAT_COMMA = _FORMATS_5PAIR[0]
_FIG_5PAIR = _FORMAT_COMMA.figure   # the native shape's figure, one whole token
# The words of one space-thousands figure: a lead group of one to three
# digits, any number of three-digit groups, and the last group with the
# decimals — "1", "234", "567.89".
_GROUP_LEAD = re.compile(r"^-?\d{1,3}$")
_GROUP_MID = re.compile(r"^\d{3}$")
_GROUP_LAST = re.compile(r"^\d{3}\.\d{2}$")
_TOTAL_CLASS_5PAIR = re.compile(r"^total\s+clasa\s+(\d)\s*:\s*(.*)$")
_TOTAL_GENERAL_5PAIR = re.compile(r"^total\s+general\s*:\s*(.*)$")
_CLASS_HEADING_5PAIR = re.compile(r"^clasa\s+(\d)$")
_SKIP_PREFIXES_5PAIR = (
    "balanta analitica", "balanta sintetica", "balanta de verificare", "societate:",
    "adresa:", "c.u.i", "data si ora", "cod raport",
    "pagina", "\u00ae",
)
# The column ORDER is read from the document, never assumed. Every line
# that names a column (any of these phrases, on a line that is not led by
# an account code) must be exactly the five-pair column header, in this
# order — otherwise the figures could be copied into the wrong columns:
# a book printing "Rulaj curent" before "Rulaj anterior" passes every
# arithmetic check (Total rulaj = anterior + curent reads the same either
# way round) while the prior-period turnover goes out as the period's.
_COLUMN_HEADER_5PAIR = ("cont denumire sold initial rulaj anterior rulaj curent "
                        "total rulaj sold final")
_COLUMN_PHRASES_5PAIR = ("cont denumire", "sold initial", "rulaj anterior", "rulaj curent",
                         "total rulaj", "sold final")
# The SIDE order inside each pair is read the same way: the column header
# must be directly followed by exactly "Debit Credit" five times, and no
# other line may read like a sub-header. A book printed credit-first passes
# every arithmetic check with every side flipped (total rulaj, sold final,
# class sums and debit == credit are all symmetric), so a profit would read
# as a loss and the bank as a negative asset.
_SUB_HEADER_5PAIR = " ".join(["debit credit"] * 5)
_SIDE_WORDS_5PAIR = frozenset({"debit", "credit"})
# The WinMENTOR ENTERPRISE five-pair dialect — the positional ingester's
# own layout (see the module docstring): this column header, directly
# over this sub-header, folded and whitespace-normalised.
_POSITIONAL_DIALECT_HEADER = ("simbol denumire sold initial rulaj precedent rulaj curent "
                              "total sume sold final")
_POSITIONAL_DIALECT_SUB_HEADER = " ".join(["debitor creditor"] * 5)
# _WRAP_RULE — a wrapped row cannot hand its figures to another code. A
# figure-less line led by a code-shaped token X that is not the current
# account's code is either the current account's continuation (a name
# that goes on with a number, a year) or the first line of a wrapped row
# X whose figures follow on a line led by some number from its name:
# "4111.05 Client" / "404 Media SRL <ten figures>" would read as account
# 404 with 4111.05's figures, and every total would still tie.
#
# Only the layout's STRUCTURE decides — never the text. The text rules
# tried before (round 3: "a line ending with the previous code is its
# continuation, and the next account must repeat its own code in a slot")
# still steered a row's figures to the wrong account when a name happened
# to end with the previous code and the figure line repeated a number
# from the name ("4111.05 Client 4011.09" / "404 Media SRL 404 <figures>"
# read as account 404). The layout fixes two columns, and pdfplumber gives
# every word's x-position (`Line.words`):
#   * the CODE column: every account line starts with its code there
#     (`_Geometry.code_x`, the leftmost lead among the ten-figure lines);
#   * the NAME column: every continuation line — the rest of a wrapped
#     name, the code printed again — starts there (`_Geometry.name_x`,
#     the leftmost first name word of the account lines).
# So a line led by a code-shaped token is an account line when that token
# sits in the code column, and name text when it sits in the name column,
# whatever the token reads. A code-column line without its ten figures is
# HELD (the row's first line) and only its own figures may follow, on a
# name-column line; anything else — another code-column line, a heading
# or total, a page header, the end of the document — refuses the book.
# Anything the structure cannot place is refused: a line that carries no
# positions (a caller handing plain text), a first word printed between
# the two columns, a line in the code column that is not an account line.
_HELD_REFUSAL = ("account %s follows a line led by the code-shaped %s that is printed in the code "
                 "column without its ten figures (a wrapped row could hand its figures to "
                 "another code)")
_HELD_UNRESOLVED_REFUSAL = ("the line led by the code-shaped %s is followed by %s, not by its own "
                            "figures (a wrapped row whose lines straddle a heading or total could "
                            "hand its figures to another code)")
_UNPLACED_REFUSAL = ("the line led by the code-shaped %s carries no column position, so whether it "
                     "starts account %s or continues account %s cannot be read from the layout "
                     "(a wrapped row could hand its figures to another code)")
_BETWEEN_REFUSAL = ("the line %r starts between the code column (x=%.1f) and the name column "
                    "(x=%.1f), in neither")
_CODE_COLUMN_REFUSAL = ("the line %r is printed in the code column but is not an account line, "
                        "a heading or a total")
# A first word within this many points of a column's x is in that column;
# the real layout's spread is 0.1 pt and the columns are 65 pt apart.
_COLUMN_TOLERANCE = 2.0
# A book whose rows carry ten figure columns is a five-pair book whatever
# its header says (round-4 critic, second defect): this many lines led by
# an account code and ending in ten figures of any one accepted shape
# name the layout structurally.
_STRUCTURAL_MIN_ROWS = 3
# Document column order, five (debit, credit) pairs.
_SI_D, _SI_C, _RA_D, _RA_C, _RL_D, _RL_C, _TR_D, _TR_C, _SF_D, _SF_C = range(10)


def _fold(text: str) -> str:
    table = str.maketrans("ăâîșşțţĂÂÎȘŞȚŢ", "aaisstt" + "AAISSTT")
    return text.translate(table).lower()


def _to_decimal(token: str, euro: bool) -> Decimal:
    t = token.replace(".", "").replace(",", ".") if euro else token.replace(" ", "")
    return Decimal(t)


class Word(NamedTuple):
    """One word of a text line with its horizontal extent on the page."""

    text: str
    x0: float
    x1: float


class Line(NamedTuple):
    """One text line: its text, and its words with x-positions when the
    source carries them (`None` for plain text — then nothing that needs
    the layout's columns can be decided, and is refused)."""

    text: str
    words: Optional[Tuple[Word, ...]]


def _as_line(raw: Any) -> Line:
    if isinstance(raw, Line):
        return raw
    return Line(str(raw), None)


def _extract_lines(pdf_bytes: bytes) -> Optional[List[Line]]:
    """The PDF's text lines, each with its words' x-positions
    (`_extract_lines_at` with pdfplumber's default word split).

    Built the way `page.extract_text()` builds its lines — the same words
    (`extract_words`, default tolerances) clustered on `doctop` with the
    same y-tolerance, joined with single spaces — so the TEXT the reader
    sees is exactly what it saw when it read plain `extract_text()` lines;
    the positions are added, never a different segmentation. That is
    checked per page: a page whose rebuilt lines are not `extract_text()`'s
    keeps the text lines and carries no positions, so the five-pair reader
    refuses anything on it that needs the columns rather than read a
    layout it cannot place.
    """
    return _extract_lines_at(pdf_bytes, None)


def _extract_lines_at(pdf_bytes: bytes, x_tolerance: Optional[float]) -> Optional[List[Line]]:
    """`_extract_lines` with pdfplumber's word split at `x_tolerance` —
    the default (3 pt) when None — on BOTH sides of the per-page check:
    the words are split, and `extract_text()` builds the lines they must
    rebuild, with the same tolerance."""
    try:
        import pdfplumber  # type: ignore
        from pdfplumber.utils import cluster_objects  # type: ignore
    except ImportError:
        return None
    split: Dict[str, Any] = {} if x_tolerance is None else {"x_tolerance": x_tolerance}
    try:
        from operator import itemgetter

        lines: List[Line] = []
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                text_lines = (page.extract_text(**split) or "").splitlines()
                built: List[Line] = []
                try:
                    words = page.extract_words(**split)
                    for cluster in cluster_objects(words, itemgetter("doctop"), 3):
                        built.append(Line(" ".join(w["text"] for w in cluster),
                                          tuple(Word(w["text"], float(w["x0"]), float(w["x1"]))
                                                for w in cluster)))
                except Exception:  # noqa: BLE001 — positions are additive; the text stays
                    logger.info("[pdf_balanta_text] word positions unavailable on a page", exc_info=True)
                    built = []
                if [b.text for b in built] == text_lines:
                    lines.extend(built)
                else:
                    logger.info("[pdf_balanta_text] word positions do not rebuild the page's text "
                                "lines — the page is read without positions")
                    lines.extend(Line(t, None) for t in text_lines)
        return lines
    except Exception:  # noqa: BLE001 — an unreadable PDF is a refusal, never a crash
        logger.info("[pdf_balanta_text] text extraction failed", exc_info=True)
        return None


LAYOUT_FIVE_PAIR = "five_pair"
LAYOUT_EIGHT_FIGURE = "eight_figure"
LAYOUT_BOTH = "both"
# The WinMENTOR five-pair dialect the positional ingester reads (module
# docstring): named so the pipeline leaves it to that ingester, never
# claimed by this reader, never a refusal.
LAYOUT_FIVE_PAIR_POSITIONAL = "five_pair_positional"
# The four-pair layout whose zeros print as blank cells, each figure read
# from the column it is printed in (module docstring, "THIRD LAYOUT").
LAYOUT_FOUR_PAIR_COLUMNS = "four_pair_columns"

# THE PARSER THIS LAYOUT NEEDS. The five-pair books this reader was built
# for print their 709 commercial reductions as mirrored entry magnitudes.
# tb_parser_v5 and earlier ADD such reductions to revenue (the real FY2025
# five-pair book served revenue millions above the filed turnover on v5);
# tb_parser_v6 reads each contra family by the document's own convention.
# The owner ruled this reader ships AFTER parser v6, as its own deploy —
# `five_pair_servable_on` makes that ordering mechanical: on an older
# parser the pipeline refuses a five-pair PDF instead of serving it.
MIN_PARSER_FOR_FIVE_PAIR = 6
_PARSER_VERSION_RE = re.compile(r"^tb_parser_v(\d+)$")


def five_pair_servable_on(parser_version: str) -> bool:
    """True only for tb_parser_v6 or later; anything unreadable is False."""
    m = _PARSER_VERSION_RE.match(parser_version or "")
    return bool(m) and int(m.group(1)) >= MIN_PARSER_FOR_FIVE_PAIR


class TextRead(NamedTuple):
    """What the header names, and what came of reading it.

    `layout` is the layout the document's header names (LAYOUT_FIVE_PAIR,
    LAYOUT_EIGHT_FIGURE, LAYOUT_BOTH, LAYOUT_FOUR_PAIR_COLUMNS,
    LAYOUT_FIVE_PAIR_POSITIONAL — the positional ingester's own dialect,
    read by nothing here) or None when it names neither; `parsed` the
    verified read, or None; `refusal` why a document of a strictly read
    layout (`names_strict_layout`) was refused. A caller that recognises
    such a layout must treat a refusal as final: the positional fast-path
    reads only undotted codes and would serve a partial balance on the
    account-121 anchor alone.
    """

    layout: Optional[str]
    parsed: Optional[Dict[str, Any]]
    refusal: Optional[str]


class _FivePairRefusal(Exception):
    """Raised by `_refuse5`; carries the logged reason."""


def names_five_pair(layout: Optional[str]) -> bool:
    """True when a document's header names the five-pair layout (alone or
    with the eight-figure one). Such a document is read by the strict
    five-pair reader or refused — never handed to another reader. The
    positional ingester's own dialect (LAYOUT_FIVE_PAIR_POSITIONAL) is
    not this reader's: False, and the pipeline keeps its positional
    path."""
    return layout in (LAYOUT_FIVE_PAIR, LAYOUT_BOTH)


def names_strict_layout(layout: Optional[str]) -> bool:
    """True for every layout this module reads STRICTLY — the five-pair
    layout (alone or with the eight-figure one) and the four-pair column
    layout. Such a document is read by its strict reader or refused, never
    handed to another reader: the positional fast-path would serve a
    partial read of it on the account-121 anchor alone."""
    return names_five_pair(layout) or layout == LAYOUT_FOUR_PAIR_COLUMNS


def _positional_dialect(normalized_lines: List[str]) -> bool:
    """The WinMENTOR dialect's signature in folded, whitespace-normalised
    text lines: its column header directly over its sub-header."""
    return any(a == _POSITIONAL_DIALECT_HEADER and b == _POSITIONAL_DIALECT_SUB_HEADER
               for a, b in zip(normalized_lines, normalized_lines[1:]))


def _flattened_positional_dialect(flattened: str) -> bool:
    """The same signature in a whitespace-flattened page text."""
    return (_POSITIONAL_DIALECT_HEADER + " " + _POSITIONAL_DIALECT_SUB_HEADER) in flattened


# Ten consecutive figures of one accepted shape in a whitespace-flattened
# text — the five-pair layout's rows as PyMuPDF / pypdf flatten a page
# (row by row, one run per row; or each figure column's cells run
# together, and a page yields many such runs).
_TEN_FIGURE_RUN = re.compile("|".join(
    r"(?:(?:(?<!\S)%s(?!\S)\s+){9}%s(?!\S))" % (f.source, f.source) for f in _FORMATS_5PAIR))


def _cells(tokens: List[str], fmt: _Format) -> List[str]:
    """A line's cells in the shape `fmt`: its whitespace tokens — except
    that in a grouped shape the words of one figure ("1", "234",
    "567.89") are one cell. Read left to right: a lead group followed by
    three-digit groups and a last group with the decimals is one figure;
    so a name that ends in a one-to-three-digit number right before a
    three-digit figure ("CONT 12" then "234.00") reads as the figure
    12 234.00 — and the row's identities then refuse the book, which is
    what the words can honestly say."""
    if not fmt.grouped:
        return tokens
    out: List[str] = []
    i = 0
    while i < len(tokens):
        j = i + 1
        if _GROUP_LEAD.match(tokens[i]):
            while j < len(tokens) and _GROUP_MID.match(tokens[j]):
                j += 1
            if j < len(tokens) and _GROUP_LAST.match(tokens[j]):
                out.append(" ".join(tokens[i:j + 1]))
                i = j + 1
                continue
        out.append(tokens[i])
        i += 1
    return out


def _decimal5(cell: str, fmt: _Format) -> Decimal:
    if fmt.name == "euro":
        return Decimal(cell.replace(".", "").replace(",", "."))
    return Decimal(cell.replace(",", "").replace(" ", ""))


def _ends_in_ten_figures(cells: List[str], fmt: _Format) -> bool:
    return len(cells) >= 10 and all(fmt.figure.match(t) for t in cells[-10:])


def _ten_figure_row(text: str, fmt: Optional[_Format] = None) -> bool:
    """A line led by an account code and ending in ten figures of the
    shape `fmt` — of any one accepted shape when None — one row of the
    five-pair layout, whatever the header says."""
    tokens = text.split()
    for f in ((fmt,) if fmt is not None else _FORMATS_5PAIR):
        cells = _cells(tokens, f)
        if len(cells) >= 11 and _CODE_5PAIR.match(cells[0]) and _ends_in_ten_figures(cells, f):
            return True
    return False


def _flattened_names_five_pair(flattened: str) -> bool:
    """The five-pair STRUCTURE in a whitespace-flattened page text (the
    second opinions): `_STRUCTURAL_MIN_ROWS` runs of ten figures, each run
    in one accepted shape. An eight-figure page flattens to no such run —
    its rows carry eight figures, and a run breaks at every account
    code."""
    return len(_TEN_FIGURE_RUN.findall(flattened)) >= _STRUCTURAL_MIN_ROWS


def _number_format(lines: List[Line]) -> _Format:
    """The one shape the document prints its figures in: the first of
    `_FORMATS_5PAIR` that fits every line ending in ten figures — an
    account row, a printed total, a wrapped row's figure line. A line
    whose figures fit a shape the lines before it do not is a refusal (a
    document prints one shape; a figure of one shape is not a figure in
    another). A document with no such line — a header-named book too
    short to read — keeps the layout's native shape, and is refused
    further on for what it lacks."""
    fitting = list(_FORMATS_5PAIR)
    for ln in lines:
        tokens = ln.text.split()
        fits = [f for f in _FORMATS_5PAIR if _ends_in_ten_figures(_cells(tokens, f), f)]
        if not fits:
            continue
        kept = [f for f in fitting if f.name in {g.name for g in fits}]
        if not kept:
            _refuse5("the line %r prints its figures in another number format (%s) than the "
                     "lines before it (%s)", ln.text.strip()[:60],
                     " / ".join(f.label for f in fits), " / ".join(f.label for f in fitting))
        fitting = kept
    return fitting[0]


def _layout_of(folded: str, structural_five: bool = False,
               positional_dialect: bool = False, four_pair: bool = False) -> Optional[str]:
    """The layout named by header tokens in `folded`, or — when the header
    names only the eight-figure layout, or neither — by the five-pair
    STRUCTURE the caller found (`structural_five`). A header naming both
    layouts is LAYOUT_BOTH regardless; a header naming the eight-figure
    layout over rows of ten figures is a five-pair book whose header this
    reader then refuses. The positional ingester's own dialect
    (`positional_dialect`, the caller found its signature) is
    LAYOUT_FIVE_PAIR_POSITIONAL unless the header also names a layout of
    this reader's — then the header decides, as for any other book. The
    four-pair column header (`four_pair`, the caller found it) names
    LAYOUT_FOUR_PAIR_COLUMNS before anything else: that reader refuses a
    book whose header names another layout too."""
    if four_pair:
        return LAYOUT_FOUR_PAIR_COLUMNS
    eight = all(tok in folded for tok in _HEADER_TOKENS)
    five = all(tok in folded for tok in _HEADER_TOKENS_5PAIR)
    if eight and five:
        return LAYOUT_BOTH
    if positional_dialect and not (eight or five):
        return LAYOUT_FIVE_PAIR_POSITIONAL
    if five or structural_five:
        return LAYOUT_FIVE_PAIR
    return LAYOUT_EIGHT_FIGURE if eight else None


def detect_layout(lines: List[Any]) -> Optional[str]:
    """The layout a document names (LAYOUT_FIVE_PAIR, LAYOUT_EIGHT_FIGURE,
    LAYOUT_BOTH, LAYOUT_FOUR_PAIR_COLUMNS), or None: by its header, from
    the first 40 text lines (the four-pair column header first,
    `_four_pair_named`), and by its STRUCTURE — `_STRUCTURAL_MIN_ROWS`
    lines anywhere in the document led by an account code and ending in
    ten figures of any one accepted shape name the five-pair layout
    however the column header is worded, spaced, abbreviated or wrapped,
    and whatever shape the figures are printed in — except the positional
    ingester's own dialect (its signature in the first 40 lines:
    LAYOUT_FIVE_PAIR_POSITIONAL). Pure and total: it cannot raise, so the
    layout is known before any reading can go wrong."""
    texts = [_as_line(x).text for x in lines]
    structural = sum(1 for t in texts if _ten_figure_row(t)) >= _STRUCTURAL_MIN_ROWS
    head = texts[:40]
    dialect = _positional_dialect([" ".join(_fold(t).split()) for t in head])
    return _layout_of(_fold("\n".join(head)), structural, dialect, _four_pair_named(head))


def _first_page_texts(pdf_bytes: bytes) -> List[str]:
    """The first page as PyMuPDF and pypdf extract it, each folded and
    whitespace-flattened — a second opinion on the layout when the text
    lines name none. Both print a five-pair book's column header as a run
    of words (at the END of the page on the real layout), never as the one
    line `detect_layout` looks for. An extractor that is missing or fails
    contributes nothing."""
    texts: List[str] = []
    try:
        import fitz  # type: ignore  # PyMuPDF — the positional ingester's own reader
        with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
            if doc.page_count:
                texts.append(doc[0].get_text() or "")
    except Exception:  # noqa: BLE001 — a second opinion that fails is no opinion
        logger.info("[pdf_balanta_text] PyMuPDF first-page text unavailable", exc_info=True)
    try:
        from pypdf import PdfReader  # type: ignore
        reader = PdfReader(io.BytesIO(pdf_bytes))
        if reader.pages:
            texts.append(reader.pages[0].extract_text() or "")
    except Exception:  # noqa: BLE001
        logger.info("[pdf_balanta_text] pypdf first-page text unavailable", exc_info=True)
    return [" ".join(_fold(t).split()) for t in texts]


def parse_lines_verdict(lines: List[str]) -> TextRead:
    """`parse_lines`, with the recognised layout and the refusal reason.

    Never raises for a document whose header names the five-pair layout
    or the four-pair column one: anything the reader throws is a refusal
    (the caller must not fall through to a reader that approximates). An
    eight-figure read that throws is None, and keeps its fall-back. The
    four-pair reader needs lines split at `_FOUR_X_TOLERANCE`
    (`read_balanta_text_verdict` extracts them so).

    `lines` are `Line`s (text with word x-positions, as `_extract_lines`
    builds them) or plain strings; plain strings carry no positions, so
    the five-pair reader refuses anything on them that only the layout's
    columns could decide.
    """
    lines = [_as_line(x) for x in lines]
    layout = detect_layout(lines)
    if layout == LAYOUT_FIVE_PAIR_POSITIONAL:
        return TextRead(LAYOUT_FIVE_PAIR_POSITIONAL, None, None)
    if layout == LAYOUT_BOTH:
        logger.info("[pdf_balanta_text] refused: header matches both layouts")
        return TextRead(LAYOUT_BOTH, None, "the header matches both balanta layouts")
    if layout == LAYOUT_FOUR_PAIR_COLUMNS:
        return _four_pair_verdict(lines)
    if layout == LAYOUT_FIVE_PAIR:
        try:
            return TextRead(LAYOUT_FIVE_PAIR, _parse_five_pair(lines), None)
        except _FivePairRefusal as refusal:
            return TextRead(LAYOUT_FIVE_PAIR, None, str(refusal))
        except Exception as crash:  # noqa: BLE001 — a crash is a refusal, never a fall-through
            logger.info("[pdf_balanta_text] five-pair reader failed", exc_info=True)
            return TextRead(LAYOUT_FIVE_PAIR, None, "the reader failed on it (%s)" % type(crash).__name__)
    if layout == LAYOUT_EIGHT_FIGURE:
        try:
            return TextRead(LAYOUT_EIGHT_FIGURE, _parse_eight_figure(lines), None)
        except Exception:  # noqa: BLE001 — the eight-figure layout keeps its fall-back
            logger.info("[pdf_balanta_text] eight-figure reader failed", exc_info=True)
            return TextRead(LAYOUT_EIGHT_FIGURE, None, None)
    return TextRead(None, None, None)


def parse_lines(lines: List[str]) -> Optional[Dict[str, Any]]:
    """The pure core: text lines in, verified rows out (or None).

    Returned rows carry the eight figures verbatim as Decimals in document
    order: si_d, si_c, rl_d, rl_c, st_d, st_c, sf_d, sf_c.
    """
    return parse_lines_verdict(lines).parsed


def _parse_eight_figure(lines: List[str]) -> Optional[Dict[str, Any]]:
    """The eight-figure "sume totale" layout — unchanged since 2026-09-21."""
    candidates = []
    for euro, num in ((False, _NUM_SPACE), (True, _NUM_EURO)):
        row_re = re.compile(r"^(\d{3,9})\s+(.*?)((?:\s+" + num + r"){8})\s*$")
        # The class digit is consumed by the prefix, so it can never be read
        # as the leading group of the first figure ("clasa 1 234 567.89").
        tot_re = re.compile(r"^total\s+sume\s+clasa\s+(\d)\s+((?:" + num + r"\s+){7}" + num + r")\s*$", re.I)
        rows: List[Dict[str, Any]] = []
        class_totals: Dict[str, List[Decimal]] = {}
        last: Optional[Dict[str, Any]] = None
        for raw in lines:
            line = _as_line(raw).text.strip()
            if not line:
                continue
            if _TOTAL_CLASS.match(_fold(line)):
                t = tot_re.match(_fold(line))
                if t:
                    class_totals[t.group(1)] = [
                        _to_decimal(x, euro) for x in re.findall(num, t.group(2))]
                last = None
                continue
            m = row_re.match(line)
            if m:
                figures = [_to_decimal(x, euro) for x in re.findall(num, m.group(3))]
                if len(figures) != 8:
                    return None
                last = {"cont": m.group(1), "name": m.group(2).strip(), "v": figures}
                rows.append(last)
                continue
            f = _fold(line)
            if f.startswith(_SKIP_PREFIXES) or f.startswith("total"):
                last = None
                continue
            if last is not None and not re.search(num, line):
                last["name"] = (last["name"] + " " + line).strip()
        candidates.append((euro, rows, class_totals))

    viable = [c for c in candidates if len(c[1]) >= MIN_ACCOUNTS]
    if len(viable) != 1:
        return None  # neither format, or both — ambiguous: refuse
    euro, rows, class_totals = viable[0]

    classes = sorted({r["cont"][0] for r in rows})
    for cls in classes:
        printed = class_totals.get(cls)
        if printed is None or len(printed) != 8:
            logger.info("[pdf_balanta_text] refused: no printed total for class %s", cls)
            return None
        summed = [sum((r["v"][i] for r in rows if r["cont"][0] == cls), Decimal(0)) for i in range(8)]
        if summed != printed:
            logger.info("[pdf_balanta_text] refused: class %s sums %s != printed %s",
                        cls, [str(x) for x in summed], [str(x) for x in printed])
            return None
    grand = [sum((r["v"][i] for r in rows), Decimal(0)) for i in range(8)]
    for i in (0, 2, 4, 6):
        if grand[i] != grand[i + 1]:
            logger.info("[pdf_balanta_text] refused: pair %d debit %s != credit %s", i // 2, grand[i], grand[i + 1])
            return None
    if len({r["cont"] for r in rows}) != len(rows):
        logger.info("[pdf_balanta_text] refused: an account appears twice")
        return None
    return {"rows": rows, "grand": grand, "number_format": "euro" if euro else "space", "classes": classes}


def _refuse5(reason: str, *args: Any) -> NoReturn:
    message = reason % args if args else reason
    logger.info("[pdf_balanta_text] five-pair refused: %s", message)
    raise _FivePairRefusal(message)


def _five_figures(body: str, fmt: _Format) -> Optional[List[Decimal]]:
    """A printed total's body: exactly ten figures of `fmt` and nothing else."""
    cells = _cells(body.split(), fmt)
    if len(cells) != 10 or not all(fmt.figure.match(t) for t in cells):
        return None
    return [_decimal5(t, fmt) for t in cells]


_MONTHS_RO = ("ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie", "august",
              "septembrie", "octombrie", "noiembrie", "decembrie")
_YEAR = re.compile(r"^(?:19|20)\d{2}$")
_DAY = re.compile(r"^\d{1,2}\.?$")


def _printed_period(title_block: List[str]) -> Optional[Dict[str, Any]]:
    """The period the document prints in its title block, or None.

    A line whose last two tokens are a Romanian month name and a year
    ("... Decembrie 2025") names a period — unless a day number precedes
    the month ("Str. 1 Decembrie 1918": a street, or a date, not a month).
    Exactly one distinct period must be printed; two different ones are
    ambiguous and read as none. The period end is the month's last day.
    """
    import calendar

    found: Dict[Tuple[int, int], str] = {}
    for raw in title_block:
        tokens = raw.split()
        if len(tokens) < 2 or not _YEAR.match(tokens[-1]):
            continue
        month = _fold(tokens[-2])
        if month not in _MONTHS_RO or (len(tokens) >= 3 and _DAY.match(tokens[-3])):
            continue
        found.setdefault((int(tokens[-1]), _MONTHS_RO.index(month) + 1), " ".join(tokens[-2:]))
    if len(found) != 1:
        return None
    (year, month), text = next(iter(found.items()))
    last = calendar.monthrange(year, month)[1]
    return {"text": text, "year": year, "month": month, "end": "%04d-%02d-%02d" % (year, month, last)}


class _Geometry(NamedTuple):
    """The two columns the five-pair layout fixes, read from the words'
    x-positions: `code_x`, where every account line's code starts, and
    `name_x`, where every name (and every continuation line) starts."""

    code_x: float
    name_x: Optional[float]


def _geometry(lines: List[Line], fmt: _Format) -> Optional[_Geometry]:
    """The layout's columns, or None when no line carries positions.

    `code_x` is the leftmost first word among the lines led by a code and
    ending in ten figures of the document's shape `fmt` (an account line
    printed with its figures on a name-column line, a wrapped row, sits
    to the right and never pulls the column left); `name_x` the leftmost
    first name word of the lines whose lead is in that column — None when
    no account line prints a name. Refuses when the two columns cannot be
    told apart.
    """
    leads: List[Tuple[Tuple[Word, ...], int]] = []
    for ln in lines:
        if not ln.words:
            continue
        tokens = ln.text.split()
        if len(tokens) != len(ln.words) or not _ten_figure_row(ln.text, fmt):
            continue
        cells = _cells(tokens, fmt)  # cells[0] is the code, one word: words[1] leads cells[1]
        run = 0
        while run < len(cells) - 1 and fmt.figure.match(cells[-1 - run]):
            run += 1
        leads.append((ln.words, len(cells) - run))  # the name is cells[1:first figure]
    if not leads:
        return None  # no account line to read the columns from: read as plain text
    code_x = min(words[0].x0 for words, _ in leads)
    names = [words[1].x0 for words, first_figure in leads
             if words[0].x0 <= code_x + _COLUMN_TOLERANCE and first_figure > 1]
    name_x = min(names) if names else None
    if name_x is not None and name_x - code_x <= 2 * _COLUMN_TOLERANCE:
        _refuse5("the code column (x=%.1f) and the name column (x=%.1f) cannot be told apart",
                 code_x, name_x)
    return _Geometry(code_x, name_x)


_ZONE_CODE, _ZONE_NAME, _ZONE_BETWEEN = "code", "name", "between"


def _zone(ln: Line, geo: Optional[_Geometry]) -> Optional[str]:
    """Which column a line's first word is printed in — _ZONE_CODE,
    _ZONE_NAME, _ZONE_BETWEEN (neither: ambiguous, refused by the caller) —
    or None when the line carries no positions."""
    if geo is None or not ln.words:
        return None
    x0 = ln.words[0].x0
    if x0 <= geo.code_x + _COLUMN_TOLERANCE:
        return _ZONE_CODE
    if geo.name_x is not None and x0 >= geo.name_x - _COLUMN_TOLERANCE:
        return _ZONE_NAME
    return _ZONE_BETWEEN


def _vsum(group: List[Dict[str, Any]]) -> List[Decimal]:
    """The column sums of a non-empty group of rows (ten figures a five-pair
    row, eight a four-pair one)."""
    return [sum((k["figures"][i] for k in group), Decimal(0)) for i in range(len(group[0]["figures"]))]


def _codes(group: List[Dict[str, Any]], limit: int = 8) -> str:
    shown = ", ".join(k["cont"] for k in group[:limit])
    return shown + (" and %d more" % (len(group) - limit) if len(group) > limit else "")


def _run_summing_to(seq: List[Dict[str, Any]], v: List[Decimal]) -> Optional[List[Dict[str, Any]]]:
    """A contiguous run of `seq` (in document order, one row or more) whose
    figures sum to `v`, or None — found from running totals in one pass:
    a run [i, j) sums to v exactly when running[j] - v == running[i]."""
    running = [Decimal(0)] * len(v)
    starts: Dict[Tuple[Decimal, ...], int] = {tuple(running): 0}
    for j, row in enumerate(seq, start=1):
        running = [a + b for a, b in zip(running, row["figures"])]
        i = starts.get(tuple(a - b for a, b in zip(running, v)))
        if i is not None:
            return seq[i:j]
        starts.setdefault(tuple(running), j)
    return None


def _parent_prefix(code: str) -> str:
    """The prefix a code's children carry: the code itself ("401.1" ->
    "401.101"), or — for an all-zero suffix, a subtotal by its very code —
    the base and the dot ("401.000" -> every "401.xx")."""
    base, dot, suffix = code.partition(".")
    return base + "." if dot and suffix and set(suffix) == {"0"} else code


def _subtotal_refusal(rows: List[Dict[str, Any]]) -> Optional[str]:
    """Why a row is a subtotal listed beside the rows it sums, or None.

    A parent listed beside its children double-counts them, and the SAGA
    path does no parent de-duplication; when the document's own class and
    grand totals count both levels, every sum still ties and debit ==
    credit holds. Codes alone cannot tell it: the layout prints sibling
    analytics whose codes prefix one another ("401.20" beside "401.201",
    each its own account), and a subtotal need not prefix what it sums
    ("401.000" or "401.99" beside "401.04" and "401.02"). The figures can.
    A row whose ten figures are not all zero is refused when they equal,
    to the cent:

      * the sum of its CHILDREN — the other rows whose code starts with
        `_parent_prefix` of its own — all of them, all at one code length
        (a sibling-by-prefix at another length would otherwise spoil the
        full sum), or any contiguous run of them in document order (a
        sibling-by-prefix at the SAME length — "401.10" beside "401.11",
        "401.12" under "401.1" — sits in the list but outside the run);
        one child is enough, a parent may have one;
      * the sum of TWO OR MORE other rows under the same three-digit root
        (the RAS synthetic account): all of them, all sharing its base
        (the code before the dot), or all of either at one code length.
        One identical sibling is not a sum — two accounts may carry the
        same figures.

    An all-zero row is exempt: listed twice or not, it adds nothing to any
    figure. Sums over a whole root are taken from running totals, so a
    root with hundreds of analytics costs no more than a small one. The
    same rule reads a four-pair row's eight figures (`_parse_four_pair`).
    """
    width = len(rows[0]["figures"]) if rows else 10  # ten figures a five-pair row, eight a four-pair one
    families: Dict[str, List[Dict[str, Any]]] = {}
    sums: Dict[Tuple[Any, ...], List[Decimal]] = {}
    members: Dict[Tuple[Any, ...], List[Dict[str, Any]]] = {}
    lengths: Dict[Tuple[str, str], set] = {}
    for r in rows:
        code = r["cont"]
        root, base = code[:3], code.split(".")[0]
        families.setdefault(root, []).append(r)
        for scope, name in (("root", root), ("base", base)):
            lengths.setdefault((scope, name), set()).add(len(code))
            for key in ((scope, name), (scope, name, len(code))):
                total = sums.setdefault(key, [Decimal(0)] * width)
                for i in range(width):
                    total[i] += r["figures"][i]
                members.setdefault(key, []).append(r)
    for r in rows:
        v = r["figures"]
        if not any(v):
            continue
        code = r["cont"]
        root, base = code[:3], code.split(".")[0]
        prefix = _parent_prefix(code)
        kids = [k for k in families[root] if k is not r and k["cont"].startswith(prefix)]
        for group in [kids] + [[k for k in kids if len(k["cont"]) == n]
                               for n in sorted({len(k["cont"]) for k in kids})]:
            if group and _vsum(group) == v:
                return "account %s is listed beside its children %s" % (code, _codes(group))
        run = _run_summing_to(kids, v)
        if run:
            return "account %s is listed beside its children %s" % (code, _codes(run))
        for scope, name in (("root", root), ("base", base)):
            keys = [(scope, name)] + [(scope, name, n) for n in sorted(lengths[(scope, name)])]
            for key in keys:
                inside = len(key) == 2 or key[2] == len(code)  # r is counted in its own groups
                if len(members[key]) - inside < 2:
                    continue
                total = sums[key]
                if [total[i] - (v[i] if inside else 0) for i in range(width)] == v:
                    group = [k for k in members[key] if k is not r]
                    return ("account %s equals the sum of %s — a subtotal listed beside the "
                            "accounts it sums" % (code, _codes(group)))
    return None


def _parse_five_pair(lines: List[Line]) -> Optional[Dict[str, Any]]:
    """The five-pair layout: every check in the module docstring, or None."""
    rows: List[Dict[str, Any]] = []
    class_totals: Dict[str, List[Decimal]] = {}
    grand_printed: Optional[List[Decimal]] = None
    last: Optional[Dict[str, Any]] = None
    column_headers = 0
    expect_sub_header = False
    title_block: List[str] = []  # the lines before the first column header — the printed period
    # _WRAP_RULE state: the layout's two columns, read from the words'
    # x-positions (None when the lines carry none), and the one row that
    # may be HELD — a code-column line printed without its ten figures,
    # waiting for them on a name-column line. Nothing else may follow it.
    # The one shape the document prints its figures in — read first, so
    # that "a figure" means the same thing on every line below.
    fmt = _number_format(lines)
    geo = _geometry(lines, fmt)
    held: Optional[Dict[str, Any]] = None

    def account_row(code: str, lead: List[str], rest: List[str], run: int) -> Dict[str, Any]:
        """A row from its code, the cells printed before this line (a held
        first line), and this line's cells after the code, whose last
        `run` are figure-shaped (ten, or more when the layout prints a
        figure-shaped code right before them)."""
        extra = rest[len(rest) - run:len(rest) - 10]
        if any(x != code for x in extra):
            _refuse5("account %s carries %d figures, not 10", code, run)
        printed = lead + rest[:len(rest) - 10]  # the name as printed, repeated codes included
        name = [x for x in printed if x != code]
        # Figures the reader cannot attribute are a refusal, never a
        # skip — and that holds for the NAME part of an account line
        # too. Two rows on one text line put the first row's ten figures
        # (and the second row's code) into the name, and the first code
        # would take the second row's figures.
        in_name = sum(1 for x in name if fmt.figure.match(x))
        if in_name >= 2:
            _refuse5("account %s: its name carries %d figure-shaped tokens "
                     "(two rows on one line?)", code, in_name)
        if any(_CODE_5PAIR.match(a) and fmt.figure.match(b) for a, b in zip(name, name[1:])):
            _refuse5("account %s: its name holds a code followed by a figure "
                     "(two rows on one line?)", code)
        return {
            "cont": code,
            "name": " ".join(name).rstrip(" -"),
            "figures": [_decimal5(x, fmt) for x in rest[len(rest) - 10:]],
        }

    for raw in lines:
        ln = _as_line(raw)
        line = ln.text.strip()
        if not line:
            continue
        f = _fold(line)
        tokens = _cells(line.split(), fmt)
        norm = " ".join(f.split())

        if not column_headers:
            title_block.append(line)
        if expect_sub_header:
            if norm != _SUB_HEADER_5PAIR:
                return _refuse5("the column header is not followed by the Debit/Credit sub-header: %r",
                                line[:120])
            expect_sub_header = False
            continue  # page header — a name may continue after it
        if not _CODE_5PAIR.match(tokens[0]):
            if any(p in norm for p in _COLUMN_PHRASES_5PAIR):
                if norm != _COLUMN_HEADER_5PAIR:
                    return _refuse5("column header reads %r, not the five-pair column order", line[:120])
                if held is not None:
                    return _refuse5(_HELD_UNRESOLVED_REFUSAL, held["x"], "a page header")
                column_headers += 1
                expect_sub_header = True
                continue  # page header — a name may continue after it
            words = f.split()
            if words and (all(w in _SIDE_WORDS_5PAIR for w in words)
                          or (len(words) >= 2 and words[0] in _SIDE_WORDS_5PAIR
                              and words[1] in _SIDE_WORDS_5PAIR)):
                return _refuse5("a Debit/Credit sub-header %r does not directly follow the column header",
                                line[:120])

        ends_block = bool(_TOTAL_CLASS_5PAIR.match(f) or _TOTAL_GENERAL_5PAIR.match(f)
                          or _CLASS_HEADING_5PAIR.match(f))
        if ends_block and held is not None:
            heading = line.split(":", 1)[0] + (":" if ":" in line else "")  # never its figures
            return _refuse5(_HELD_UNRESOLVED_REFUSAL, held["x"], repr(heading))

        t = _TOTAL_CLASS_5PAIR.match(f)
        if t:
            figures = _five_figures(t.group(2), fmt)
            if figures is None:
                return _refuse5("class %s total does not carry exactly ten figures", t.group(1))
            if t.group(1) in class_totals:
                return _refuse5("class %s total printed twice", t.group(1))
            class_totals[t.group(1)] = figures
            last = None
            continue
        g = _TOTAL_GENERAL_5PAIR.match(f)
        if g:
            figures = _five_figures(g.group(1), fmt)
            if figures is None or grand_printed is not None:
                return _refuse5("grand total is not one line of exactly ten figures")
            grand_printed = figures
            last = None
            continue
        if _CLASS_HEADING_5PAIR.match(f):
            last = None
            continue
        if f.startswith(_SKIP_PREFIXES_5PAIR) or "utilizator:" in f:
            if sum(1 for x in tokens if fmt.figure.match(x)) >= 2:
                return _refuse5("a page header/footer line carries figures: %r", line[:60])
            if held is not None:
                return _refuse5(_HELD_UNRESOLVED_REFUSAL, held["x"], "a page header or footer")
            continue  # page header / footer — a name may continue after it

        lead_is_code = bool(_CODE_5PAIR.match(tokens[0]))
        body = tokens[1:] if lead_is_code else tokens
        run = 0
        while run < len(body) and fmt.figure.match(body[-1 - run]):
            run += 1
        # The column the line's first word is printed in decides what the
        # line is (`_WRAP_RULE`) — once the column header has been read;
        # the title block before it holds no rows.
        zone = _zone(ln, geo) if column_headers else None
        if zone == _ZONE_BETWEEN:
            return _refuse5(_BETWEEN_REFUSAL, line[:60], geo.code_x, geo.name_x)

        if lead_is_code and run >= 10 and zone != _ZONE_NAME:
            # an account line: its code in the code column (or plain text,
            # where nothing else is read as one), its ten figures last
            if not column_headers:
                return _refuse5("account %s is printed before the column header", tokens[0])
            if held is not None:
                return _refuse5(_HELD_REFUSAL, tokens[0], held["x"])
            last = account_row(tokens[0], [], body, run)
            rows.append(last)
            continue
        if zone == _ZONE_NAME:
            # name text, whatever its first word reads: the continuation of
            # the held row (with its figures) or of the current account
            if held is not None:
                if run >= 10:
                    last = account_row(held["x"], held["text"], tokens, run)
                    rows.append(last)
                    held = None
                else:
                    held["text"].extend(tokens)
                continue
        else:
            if lead_is_code and run:
                known = {tokens[0]} | ({last["cont"]} if last is not None else set())
                if any(x not in known for x in body[len(body) - run:]):
                    return _refuse5("account %s carries %d figures, not 10", tokens[0], run)
            if zone == _ZONE_CODE:
                if not lead_is_code:
                    return _refuse5(_CODE_COLUMN_REFUSAL, line[:60])
                # the row's first line, printed without its figures: held
                # until they follow on a name-column line
                if held is not None:
                    return _refuse5(_HELD_REFUSAL, tokens[0], held["x"])
                held = {"x": tokens[0], "text": list(body)}
                continue
            if lead_is_code and (last is None or tokens[0] != last["cont"]):
                # plain text: a code-shaped first word that is not the
                # current account's code cannot be placed in either column
                return _refuse5(_UNPLACED_REFUSAL, tokens[0], tokens[0], last["cont"] if last else "none")

        # A continuation line: the rest of the previous account's name.
        own = last["cont"] if last is not None else None
        kept = [x for x in tokens if x != own]
        if sum(1 for x in kept if fmt.figure.match(x)) >= 2:
            return _refuse5("a line with figures is neither an account nor a total: %r", line[:60])
        if last is not None and kept:
            last["name"] = (last["name"] + " " + " ".join(kept)).strip().rstrip(" -")

    if held is not None:
        return _refuse5(_HELD_UNRESOLVED_REFUSAL, held["x"], "the end of the document")
    if expect_sub_header:
        return _refuse5("the column header is not followed by the Debit/Credit sub-header: end of document")
    if len(rows) < MIN_ACCOUNTS:
        return _refuse5("%d account lines (< %d)", len(rows), MIN_ACCOUNTS)
    if len({r["cont"] for r in rows}) != len(rows):
        return _refuse5("an account appears twice")
    # A parent listed beside its own children double-counts them, and the
    # SAGA path does no parent de-duplication — refused even when the
    # document's own totals count both levels (then every sum still ties).
    undotted = {r["cont"] for r in rows if "." not in r["cont"]}
    for r in rows:
        base = r["cont"].split(".")[0]
        for k in range(3, len(base) + 1):
            parent = base[:k]
            if parent != r["cont"] and parent in undotted:
                return _refuse5("account %s is listed beside its parent %s", r["cont"], parent)
    # A subtotal listed beside the rows it sums double-counts them the
    # same way, whatever its code — see `_subtotal_refusal`.
    subtotal = _subtotal_refusal(rows)
    if subtotal is not None:
        return _refuse5("%s", subtotal)
    for r in rows:
        v = r["figures"]
        if v[_TR_D] != v[_RA_D] + v[_RL_D] or v[_TR_C] != v[_RA_C] + v[_RL_C]:
            return _refuse5("account %s: total rulaj != rulaj anterior + rulaj curent", r["cont"])
        if v[_SF_D] - v[_SF_C] != (v[_SI_D] - v[_SI_C]) + (v[_TR_D] - v[_TR_C]):
            return _refuse5("account %s: sold final != sold initial + total rulaj", r["cont"])

    classes = sorted({r["cont"][0] for r in rows})
    for cls in sorted(set(classes) | set(class_totals)):
        printed = class_totals.get(cls)
        if printed is None:
            return _refuse5("no printed total for class %s", cls)
        summed = [sum((r["figures"][i] for r in rows if r["cont"][0] == cls), Decimal(0))
                  for i in range(10)]
        if summed != printed:
            return _refuse5("class %s sums %s != printed %s", cls,
                            [str(x) for x in summed], [str(x) for x in printed])
    grand = [sum((r["figures"][i] for r in rows), Decimal(0)) for i in range(10)]
    if grand_printed is not None and grand != grand_printed:
        return _refuse5("rows sum %s != printed grand total %s",
                        [str(x) for x in grand], [str(x) for x in grand_printed])
    for i in range(0, 10, 2):
        if grand[i] != grand[i + 1]:
            return _refuse5("pair %d debit %s != credit %s", i // 2, grand[i], grand[i + 1])

    for r in rows:
        v = r["figures"]
        r["v"] = [v[_SI_D], v[_SI_C], v[_RL_D], v[_RL_C], v[_TR_D], v[_TR_C], v[_SF_D], v[_SF_C]]
    return {"rows": rows, "grand": grand, "number_format": fmt.name, "classes": classes,
            "layout": "five_pair", "period": _printed_period(title_block)}


# ── THIRD LAYOUT: four pairs, each figure placed by its column ──────────
#
# See "THIRD LAYOUT" in the module docstring. The layout's column header,
# folded: a line of exactly four "Debit Credit" pairs (the side labels)
# under the headings "Sold initial" / "Rulaje" / "Total" / "Solduri
# finale" and their sub-headings "1 Ianuarie" / "luna curenta" / "sume
# cumulate".
_FOUR_SIDE_LINE = " ".join(["debit credit"] * 4)
_FOUR_HEADER_TOKENS = ("sold initial", "rulaje", "total", "solduri finale", "ianuarie",
                       "luna curenta", "sume cumulate")
_FOUR_HEADER_WORDS = frozenset(("sold initial rulaje total solduri finale ianuarie luna curenta "
                                "sume cumulate cont denumire").split())
_FOUR_DAY = re.compile(r"^\d{1,2}$")
# The headings over the pairs, in document order — the order is READ from
# where they are printed (`_four_columns`), never assumed — and the sub-
# headings printed over the first three pairs.
_FOUR_HEADINGS = (("sold", "initial"), ("rulaje",), ("total",), ("solduri", "finale"))
_FOUR_HEADING_NAMES = ("Sold initial", "Rulaje", "Total", "Solduri finale")
_FOUR_SUBS = (("ianuarie",), ("luna", "curenta"), ("sume", "cumulate"))
_FOUR_SUB_NAMES = ("Ianuarie", "luna curenta", "sume cumulate")
_FOUR_COLUMN_NAMES = tuple("%s %s" % (h, s) for h in _FOUR_HEADING_NAMES for s in ("Debit", "Credit"))
# The word split the columns are read with: a visible gap wider than 1 pt
# ends a word. pdfplumber's default split (3 pt) glues a code part to the
# name printed a space's width after it, and the last figure of a line to
# a label printed just right of its column — one "word" across two columns.
_FOUR_X_TOLERANCE = 1.0
_FOUR_OVERHANG = 2.0   # a word may overhang its column's edge by this much, no more
_FOUR_ALIGN = 1.0      # every figure of a column ends within this of every other ...
_FOUR_ANCHOR = 3.0     # ... and within this of the edge the column header puts it at
_FOUR_BASE = re.compile(r"^\d{3,4}\.$")          # the account:   "4518."
_FOUR_ANALYTIC = re.compile(r"^\d{1,5}\.$")      # its analytic:  "2."  ("0." — none)
_FOUR_LEVEL = re.compile(r"^\d{1,3}$")           # the third code part, "0"
_FOUR_NUMBER_WORD = re.compile(r"^-?[\d.,]*\d[\d.,]*$")
_FOUR_CLASS_DIGIT = re.compile(r"^\d$")
_FOUR_DATE = re.compile(r"^(\d{1,2})([./])(\d{1,2})\2(\d{4})$")
_FOUR_ACROSS = "%r is printed across the edge of the %s column (line %r)"


class _FourPairRefusal(Exception):
    """Raised by `_refuse4`; carries the logged reason."""


def _refuse4(reason: str, *args: Any) -> NoReturn:
    message = reason % args if args else reason
    logger.info("[pdf_balanta_text] four-pair refused: %s", message)
    raise _FourPairRefusal(message)


def _four_pair_named(head: List[str]) -> bool:
    """This layout's column header in text lines: every heading and sub-
    heading (`_FOUR_HEADER_TOKENS`). The side labels do not name it — a
    book whose pairs read "Credit Debit" is this layout's, and its reader
    refuses it rather than let it fall through to one that approximates."""
    return all(tok in "\n".join(" ".join(_fold(t).split()) for t in head) for tok in _FOUR_HEADER_TOKENS)


def _flattened_names_four_pair(flattened: str) -> bool:
    """The same header in a whitespace-flattened page text (the second
    opinions)."""
    return all(tok in flattened for tok in _FOUR_HEADER_TOKENS)


def _four_header_line(ln: Line) -> bool:
    """A line of the column header above the side labels: only header words
    (a day number only right before "Ianuarie")."""
    words = _fold(ln.text).split()
    return bool(words) and all(
        w in _FOUR_HEADER_WORDS
        or (_FOUR_DAY.match(w) is not None and i + 1 < len(words) and words[i + 1] == "ianuarie")
        for i, w in enumerate(words))


def _positioned(ln: Line) -> bool:
    return bool(ln.words) and len(ln.words) == len(ln.text.split())


class _FourColumns(NamedTuple):
    """The columns of one printed column header: `edges[0]` is the right
    edge of the name column, `edges[k]` the right edge of figure column k
    (1..8, `_FOUR_COLUMN_NAMES`)."""

    edges: Tuple[float, ...]


def _four_columns(block: List[Line]) -> _FourColumns:
    """The columns of one printed column header (`block`: its lines, the
    side-label line last), or a refusal.

    Every heading and sub-heading is printed once; each heading over its
    own Debit/Credit pair, in the order Sold initial / Rulaje / Total /
    Solduri finale; each sub-heading over the first three pairs in turn;
    "Cont" and "Denumire" left of the figure columns and "Cont" again right
    of them; and no other word. The headings are centred over their pairs,
    so a heading's centre is the edge between its Debit and Credit columns
    and the midpoint between two headings the edge between two pairs; each
    Debit/Credit label must then sit inside its own column.
    """
    if not all(_positioned(ln) for ln in block):
        _refuse4("its column header carries no word positions, so its columns cannot be read")
    rows = [[(_fold(w.text), w) for w in ln.words] for ln in block[:-1]]
    taken = set()

    def spans(seq: Tuple[str, ...], day: bool = False) -> List[Tuple[float, float]]:
        out = []
        for li, row in enumerate(rows):
            for s in range(len(row) - len(seq) + 1):
                if tuple(t for t, _ in row[s:s + len(seq)]) != seq:
                    continue
                a = s - 1 if day and s > 0 and _FOUR_DAY.match(row[s - 1][0]) else s
                taken.update((li, k) for k in range(a, s + len(seq)))
                out.append((row[a][1].x0, row[s + len(seq) - 1][1].x1))
        return out

    def once(seq: Tuple[str, ...], name: str, day: bool = False) -> Tuple[float, float, float]:
        found = spans(seq, day)
        if len(found) != 1:
            _refuse4("its column header prints %r %d times, not once", name, len(found))
        x0, x1 = found[0]
        return (x0 + x1) / 2, x0, x1

    headings = [once(seq, name) for seq, name in zip(_FOUR_HEADINGS, _FOUR_HEADING_NAMES)]
    subs = [once(seq, name, day=(j == 0)) for j, (seq, name) in enumerate(zip(_FOUR_SUBS, _FOUR_SUB_NAMES))]
    denumire = once(("denumire",), "Denumire")
    conts = sorted(spans(("cont",)))
    stray = [w.text for li, row in enumerate(rows) for k, (_, w) in enumerate(row) if (li, k) not in taken]
    if stray:
        _refuse4("its column header prints words this layout does not: %s", " ".join(stray[:6]))
    if len(conts) != 2:
        _refuse4("its column header prints 'Cont' %d times, not twice (left of the names and right "
                 "of the figures)", len(conts))
    c = [(w.x0 + w.x1) / 2 for w in block[-1].words]
    for j, (centre, _, _) in enumerate(headings):
        if not c[2 * j] < centre < c[2 * j + 1]:
            _refuse4("its column header does not print %r over its own Debit/Credit pair",
                     _FOUR_HEADING_NAMES[j])
    for j, (centre, _, _) in enumerate(subs):
        if not c[2 * j] < centre < c[2 * j + 1]:
            _refuse4("its column header does not print %r over the %r pair",
                     _FOUR_SUB_NAMES[j], _FOUR_HEADING_NAMES[j])
    e1, e3, e5, e7 = (h[0] for h in headings)
    e2, e4, e6 = (e1 + e3) / 2, (e3 + e5) / 2, (e5 + e7) / 2
    edges = (2 * e1 - e2, e1, e2, e3, e4, e5, e6, e7, 2 * e7 - e6)
    for k in range(8):
        if not edges[k] < c[k] < edges[k + 1]:
            _refuse4("its column header prints the %s label outside the column its heading spans",
                     _FOUR_COLUMN_NAMES[k])
    (left_x0, left_x1), (right_x0, _) = conts
    if not ((left_x0 + left_x1) / 2 < denumire[0] and denumire[2] <= edges[0] + _FOUR_OVERHANG
            and right_x0 >= edges[8] - _FOUR_OVERHANG):
        _refuse4("its column header does not print 'Cont' and 'Denumire' left of the figure "
                 "columns and 'Cont' again right of them")
    return _FourColumns(edges)


def _four_date(token: str) -> Any:
    import datetime

    m = _FOUR_DATE.match(token)
    if not m:
        return None
    try:
        return datetime.date(int(m.group(4)), int(m.group(3)), int(m.group(1)))
    except ValueError:
        return None


def _printed_date_range(title_block: List[str]) -> Optional[Dict[str, Any]]:
    """The period a four-pair book prints in its title block — one "<date>
    - <date>" range ("01/12/2025 - 31/12/2025"; dates day first, "/" or "."
    between their parts), whose end date is the period end — or None when
    it prints none, or more than one (ambiguous: read as none)."""
    found: Dict[Tuple[Any, Any], str] = {}
    for raw in title_block:
        tokens = raw.split()
        for i in range(len(tokens) - 2):
            start, end = _four_date(tokens[i]), _four_date(tokens[i + 2])
            if tokens[i + 1] == "-" and start is not None and end is not None and start <= end:
                found.setdefault((start, end), "%s - %s" % (tokens[i], tokens[i + 2]))
    if len(found) != 1:
        return None
    (_, end), text = next(iter(found.items()))
    return {"text": text, "end": end.isoformat()}


def _plain4(group: List[List[Decimal]]) -> List[Decimal]:
    return [sum((v[i] for v in group), Decimal(0)) for i in range(8)]


def _netted4(group: List[List[Decimal]]) -> List[Decimal]:
    """An account's line from its analytics' lines: ONE opening and ONE
    closing balance, each netted onto its side; the turnover summed per
    side; Total = the netted opening + the cumulated turnover (each
    analytic's Total less its opening)."""
    z = Decimal(0)
    si = sum((v[0] - v[1] for v in group), z)
    sf = sum((v[6] - v[7] for v in group), z)
    cum_d = sum((v[4] - v[0] for v in group), z)
    cum_c = sum((v[5] - v[1] for v in group), z)
    si_d, si_c = (si, z) if si > 0 else (z, -si)
    sf_d, sf_c = (sf, z) if sf > 0 else (z, -sf)
    return [si_d, si_c, sum((v[2] for v in group), z), sum((v[3] for v in group), z),
            si_d + cum_d, si_c + cum_c, sf_d, sf_c]


def _four_cells(bands: List[List[Word]], line: str) -> Dict[int, Tuple[str, float]]:
    """A line's figure cells: column -> (the figure as printed, its right
    edge). Only number words may be printed in a figure column; the words
    of one column are one figure (a space-thousands figure prints its
    groups as words) — two figures in one column fail its number shape."""
    cells: Dict[int, Tuple[str, float]] = {}
    for k, words in enumerate(bands):
        if not words:
            continue
        for w in words:
            if not _FOUR_NUMBER_WORD.match(w.text):
                _refuse4("%r is printed in the %s column (line %r)", w.text, _FOUR_COLUMN_NAMES[k], line[:60])
        cells[k] = (" ".join(w.text for w in words), words[-1].x1)
    return cells


def _four_zones(ln: Line, cols: _FourColumns) -> Tuple[List[Word], List[List[Word]], List[Word]]:
    """A line's words by the column their centre falls in: the code and
    name (left of the figure columns), each figure column, the code
    repeated right of them."""
    e = cols.edges
    left: List[Word] = []
    bands: List[List[Word]] = [[] for _ in range(8)]
    right: List[Word] = []
    for w in ln.words or ():
        mid = (w.x0 + w.x1) / 2
        if mid <= e[0]:
            left.append(w)
        elif mid > e[8]:
            right.append(w)
        else:
            bands[next(k for k in range(8) if mid <= e[k + 1])].append(w)
    return left, bands, right


def _four_across(ln: Line, cols: _FourColumns, left: List[Word], bands: List[List[Word]],
                 right: List[Word]) -> None:
    """Refuses a word of an account or total line printed across a column
    edge: a figure between two columns is in neither."""
    e = cols.edges
    for w in left:
        if w.x1 > e[0] + _FOUR_OVERHANG:
            _refuse4(_FOUR_ACROSS, w.text, "first figure", ln.text[:60])
    for k, words in enumerate(bands):
        for w in words:
            if w.x0 < e[k] - _FOUR_OVERHANG or w.x1 > e[k + 1] + _FOUR_OVERHANG:
                _refuse4(_FOUR_ACROSS, w.text, _FOUR_COLUMN_NAMES[k], ln.text[:60])
    for w in right:
        if w.x0 < e[8] - _FOUR_OVERHANG:
            _refuse4(_FOUR_ACROSS, w.text, "last figure", ln.text[:60])


def _parse_four_pair(lines: List[Any]) -> Dict[str, Any]:
    """The four-pair column layout: every check in the module docstring
    ("THIRD LAYOUT"), or a refusal (`_FourPairRefusal`). `lines` must be
    split at `_FOUR_X_TOLERANCE` (`_read_verdict` extracts them so)."""
    lines = [_as_line(x) for x in lines]
    head = _fold("\n".join(ln.text for ln in lines[:40]))
    if all(tok in head for tok in _HEADER_TOKENS) or all(tok in head for tok in _HEADER_TOKENS_5PAIR):
        _refuse4("its header also names another balanta layout, so which printed column holds "
                 "which figure cannot be read from it")

    # The printed column headers, each ending with its side-label line.
    headers: Dict[int, int] = {}
    for j, ln in enumerate(lines):
        if " ".join(_fold(ln.text).split()) == _FOUR_SIDE_LINE:
            s = j
            while s > 0 and _four_header_line(lines[s - 1]):
                s -= 1
            headers[s] = j
    for ln in lines:
        words = _fold(ln.text).split()
        if (len(words) >= 2 and all(w in _SIDE_WORDS_5PAIR for w in words)
                and " ".join(words) != _FOUR_SIDE_LINE):
            _refuse4("its column header's side labels read %r, not four Debit/Credit pairs", ln.text[:80])
    if not headers:
        _refuse4("no column header ends with the four Debit/Credit pairs")
    first = min(headers)
    cols = _four_columns(lines[first:headers[first] + 1])
    for s, j in headers.items():
        other = _four_columns(lines[s:j + 1])
        if any(abs(a - b) > _FOUR_ALIGN for a, b in zip(other.edges, cols.edges)):
            _refuse4("a page prints its column header elsewhere than the first page does")
    title_block = [ln.text for ln in lines[:first]]
    for text in title_block:
        tokens = [t for t in text.split() if t != "*"]
        if len(tokens) >= 2 and _FOUR_BASE.match(tokens[0]) and _FOUR_ANALYTIC.match(tokens[1]):
            _refuse4("account %s%s is printed before the column header", tokens[0], tokens[1])

    leaves: List[Dict[str, Any]] = []
    stars: Dict[Tuple[str, str], Dict[str, Any]] = {}
    classes: Dict[str, Dict[str, Any]] = {}
    grand: Optional[Dict[str, Any]] = None
    placed: List[Tuple[int, float, str]] = []   # (column, right edge, figure) of every cell, in order
    last: Optional[Dict[str, Any]] = None       # the row a continuation line may extend
    j = first
    while j < len(lines):
        if j in headers:
            j, last = headers[j] + 1, None
            continue
        ln = lines[j]
        j += 1
        if not ln.text.strip():
            continue
        if not _positioned(ln):
            _refuse4("the line %r carries no word positions (its page's words do not rebuild its "
                     "text lines)", ln.text[:60])
        left, bands, right = _four_zones(ln, cols)
        lf = [_fold(w.text) for w in left]
        is_class = len(lf) == 3 and lf[:2] == ["total", "clasa"] and bool(_FOUR_CLASS_DIGIT.match(lf[2]))
        is_grand = lf == ["total", "general"]
        is_row = bool(left) and (lf[0] == "*" or bool(_FOUR_BASE.match(left[0].text)))
        if not (is_class or is_grand or is_row):
            if (not any(bands) and not right and last is not None and left
                    and last["name_x"] is not None and abs(left[0].x0 - last["name_x"]) <= _FOUR_ALIGN):
                # the rest of a name wrapped under it, in the name column
                last["name"] = (last["name"] + " " + " ".join(w.text for w in left)).strip()
                continue
            if any(f.figure.match(w.text) for f in _FORMATS_5PAIR for words in bands for w in words):
                _refuse4("the line %r carries figures but is neither an account nor a total", ln.text[:60])
            last = None  # a title, a page footer, a signature line: no figure, no account
            continue
        if grand is not None:
            _refuse4("the line %r follows the grand total", ln.text[:60])
        _four_across(ln, cols, left, bands, right)
        cells = _four_cells(bands, ln.text)
        placed.extend((k, x1, text) for k, (text, x1) in sorted(cells.items()))
        last = None
        if is_class or is_grand:
            label = [w.text for w in left]
            if [w.text for w in right] != label:
                _refuse4("the label repeated right of the figures of %r reads %r", " ".join(label),
                         " ".join(w.text for w in right))
            if is_grand:
                grand = {"cells": cells}
            elif lf[2] in classes:
                _refuse4("class %s total printed twice", lf[2])
            else:
                classes[lf[2]] = {"cells": cells}
            continue
        star = lf[0] == "*"
        parts = left[1:4] if star else left[:3]
        if not (len(parts) == 3 and _FOUR_BASE.match(parts[0].text) and _FOUR_ANALYTIC.match(parts[1].text)
                and _FOUR_LEVEL.match(parts[2].text)):
            _refuse4("the line %r is led by an account code, but not by this layout's three code "
                     "parts (account, analytic, level)", ln.text[:60])
        base, analytic, level = parts[0].text[:-1], parts[1].text[:-1], parts[2].text
        if [w.text for w in right] != [p.text for p in parts]:
            _refuse4("account %s.%s: the code repeated right of its figures reads %r", base, analytic,
                     " ".join(w.text for w in right))
        if level != "0":
            _refuse4("account %s.%s is printed with the third code part %s; this reader reads only "
                     "accounts whose third code part is 0", base, analytic, level)
        name_words = left[4:] if star else left[3:]
        rec = {"base": base, "analytic": analytic, "name": " ".join(w.text for w in name_words),
               "name_x": name_words[0].x0 if name_words else None, "cells": cells}
        last = rec
        if not star:
            leaves.append(rec)
            continue
        if analytic != "0":
            _refuse4("the total line %r carries the analytic %s", ln.text[:60], analytic)
        kind = "group" if [_fold(w.text) for w in name_words] == ["total", "%s.0.0" % base] else "account"
        if kind == "account" and name_words and _fold(name_words[0].text) == "total":
            _refuse4("the total line %r is not labelled 'TOTAL %s.0.0'", ln.text[:60], base)
        if kind == "group" and len(base) != 3:
            _refuse4("the group total %r is not a three-digit group's", ln.text[:60])
        if (kind, base) in stars:
            _refuse4("the %s total of %s is printed twice", kind, base)
        stars[(kind, base)] = rec

    # Every figure of a column ends at one x, where the header puts the column.
    for k in range(8):
        ends = [(x1, text) for col, x1, text in placed if col == k]
        if not ends:
            continue
        lo, hi = min(ends), max(ends)
        if hi[0] - lo[0] > _FOUR_ALIGN:
            _refuse4("the figures of the %s column do not end at one x (%r and %r are %.1f pt apart), "
                     "so a figure is printed out of its column", _FOUR_COLUMN_NAMES[k], lo[1], hi[1],
                     hi[0] - lo[0])
        for x1, text in (lo, hi):
            if abs(x1 - cols.edges[k + 1]) > _FOUR_ANCHOR:
                _refuse4("the %s column's figures end %.1f pt from where its column header puts it",
                         _FOUR_COLUMN_NAMES[k], x1 - cols.edges[k + 1])
    # One number shape, the document's: the first that fits every figure.
    fitting = list(_FORMATS_5PAIR)
    for _, _, text in placed:
        kept = [f for f in fitting if f.figure.match(text)]
        if not kept:
            fits = [f.label for f in _FORMATS_5PAIR if f.figure.match(text)]
            _refuse4("the figure %r is printed in %s, not in the number format of the figures before it "
                     "(%s)", text, " / ".join(fits) or "no number format this reader reads",
                     " / ".join(f.label for f in fitting))
        fitting = kept
    fmt = fitting[0]

    def values(rec: Dict[str, Any]) -> List[Decimal]:
        return [_decimal5(rec["cells"][k][0], fmt) if k in rec["cells"] else Decimal(0) for k in range(8)]

    for rec in leaves + list(stars.values()) + list(classes.values()) + ([grand] if grand else []):
        rec["v"] = values(rec)
    # Each account's closing balance is its Total pair's net (the Total
    # carries the opening balance): a figure read on the wrong side of a
    # pair — the one thing a blank cell could hide — breaks it.
    for rec in leaves:
        v = rec["v"]
        if v[6] - v[7] != v[4] - v[5]:
            _refuse4("account %s.%s: sold final %s/%s != total (sume cumulate) debit - credit %s - %s",
                     rec["base"], rec["analytic"], v[6], v[7], v[4], v[5])

    # The accounts: one line each, never beside a line of its own.
    by_base: Dict[str, List[Dict[str, Any]]] = {}
    for rec in leaves:
        by_base.setdefault(rec["base"], []).append(rec)
    account_line: Dict[str, List[Decimal]] = {}
    for base, recs in by_base.items():
        analytics = [r["analytic"] for r in recs]
        if len(set(analytics)) != len(analytics):
            _refuse4("account %s.%s appears twice", base,
                     next(a for a in analytics if analytics.count(a) > 1))
        total = stars.get(("account", base))
        if "0" in analytics:
            if len(analytics) > 1:
                _refuse4("account %s is printed both on its own line (analytic 0) and with the analytics "
                         "%s, and whether that line is the account's own postings or its total cannot "
                         "be read from the layout", base, ", ".join(a for a in analytics if a != "0"))
            if total is not None:
                _refuse4("a total is printed for account %s, which has no analytics", base)
            account_line[base] = recs[0]["v"]
            continue
        if total is None:
            _refuse4("the analytics of account %s carry no printed total for the account", base)
        if total["v"] != _netted4([r["v"] for r in recs]):
            _refuse4("account %s's printed total %s != its analytics %s netted to %s", base,
                     [str(x) for x in total["v"]], ", ".join(r["analytic"] for r in recs),
                     [str(x) for x in _netted4([r["v"] for r in recs])])
        account_line[base] = total["v"]
    for kind, base in stars:
        if kind == "account" and base not in by_base:
            _refuse4("a total is printed for account %s, which has no analytics printed", base)
    # The three-digit lines: a group's printed total over its four-digit
    # accounts, or the three-digit account's own line.
    groups: Dict[str, List[Decimal]] = {}
    roots = sorted({b[:3] for b in by_base})
    for root in roots:
        fours = sorted(b for b in by_base if len(b) == 4 and b.startswith(root))
        printed = stars.get(("group", root))
        if not fours:
            if printed is not None:
                _refuse4("a group total is printed for %s, which has no four-digit accounts", root)
            groups[root] = account_line[root]
            continue
        if root in by_base:
            _refuse4("account %s is listed beside its accounts %s", root, ", ".join(fours))
        if printed is None:
            _refuse4("the four-digit accounts of group %s carry no printed group total (TOTAL %s.0.0)",
                     root, root)
        summed = _plain4([account_line[b] for b in fours])
        if printed["v"] != summed:
            _refuse4("group %s's printed total %s != its accounts' sum %s", root,
                     [str(x) for x in printed["v"]], [str(x) for x in summed])
        groups[root] = printed["v"]
    for kind, base in stars:
        if kind == "group" and base not in groups:
            _refuse4("a group total is printed for %s, which has no accounts printed", base)
    for cls in sorted({r[0] for r in roots} | set(classes)):
        printed = classes.get(cls)
        if printed is None:
            _refuse4("no printed total for class %s", cls)
        summed = _plain4([groups[r] for r in roots if r[0] == cls])
        if printed["v"] != summed:
            _refuse4("class %s sums %s != printed %s", cls, [str(x) for x in summed],
                     [str(x) for x in printed["v"]])
    if grand is not None:
        summed = _plain4(list(groups.values()))
        if grand["v"] != summed:
            _refuse4("the rows sum %s != printed grand total %s", [str(x) for x in summed],
                     [str(x) for x in grand["v"]])

    rows = [{"cont": r["base"] if r["analytic"] == "0" else "%s.%s" % (r["base"], r["analytic"]),
             "name": r["name"], "figures": r["v"], "v": r["v"]} for r in leaves]
    if len(rows) < MIN_ACCOUNTS:
        _refuse4("%d account lines (< %d)", len(rows), MIN_ACCOUNTS)
    subtotal = _subtotal_refusal(rows)
    if subtotal is not None:
        _refuse4("%s", subtotal)
    leaf_grand = _plain4([r["v"] for r in rows])
    for i in range(0, 8, 2):
        if leaf_grand[i] != leaf_grand[i + 1]:
            _refuse4("pair %d debit %s != credit %s", i // 2, leaf_grand[i], leaf_grand[i + 1])
    return {"rows": rows, "grand": leaf_grand, "number_format": fmt.name,
            "classes": sorted({r["cont"][0] for r in rows}), "layout": LAYOUT_FOUR_PAIR_COLUMNS,
            "period": _printed_date_range(title_block)}


def _four_pair_verdict(lines: Optional[List[Line]]) -> "TextRead":
    """The four-pair reader's verdict — NEVER RAISES: a refusal, or
    anything the reader throws, is a refusal (the layout is known)."""
    if not lines:
        return TextRead(LAYOUT_FOUR_PAIR_COLUMNS, None,
                        "its words could not be read with the column-level word split")
    try:
        return TextRead(LAYOUT_FOUR_PAIR_COLUMNS, _parse_four_pair(lines), None)
    except _FourPairRefusal as refusal:
        return TextRead(LAYOUT_FOUR_PAIR_COLUMNS, None, str(refusal))
    except Exception as crash:  # noqa: BLE001 — a crash is a refusal, never a fall-through
        logger.info("[pdf_balanta_text] four-pair reader failed", exc_info=True)
        return TextRead(LAYOUT_FOUR_PAIR_COLUMNS, None, "the reader failed on it (%s)" % type(crash).__name__)


def to_saga_xlsx(rows: List[Dict[str, Any]]) -> bytes:
    """SAGA 10-column workbook, figures verbatim.

    RC is the document's own cumulative pair: "sume totale" for the
    eight-figure layout, "Total rulaj" for the five-pair layout, "Total"
    (sume cumulate) for the four-pair column layout.
    """
    import openpyxl  # type: ignore

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Balanta"
    ws.append(["BLN_CONT", "BLN_DENUMIRE", "SI DEBIT", "SI CREDIT", "RL DEBIT", "RL CREDIT",
               "RC DEBIT", "RC CREDIT", "SF DEBIT", "SF CREDIT"])
    ws.append([None, None] + [float(sum((r["v"][i] for r in rows), Decimal(0))) for i in range(8)])
    for r in rows:
        ws.append([r["cont"], r["name"]] + [float(x) for x in r["v"]])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


class TextReadResult(NamedTuple):
    """`read_balanta_text_verdict`'s answer: the workbook and meta on
    success, else the recognised layout and (five-pair) the reason."""

    layout: Optional[str]
    workbook: Optional[bytes]
    meta: Optional[Dict[str, Any]]
    refusal: Optional[str]


def read_balanta_text_pdf(pdf_bytes: bytes) -> Optional[Tuple[bytes, Dict[str, Any]]]:
    """(xlsx_bytes, meta) when the PDF is a verifiable balanta, else None."""
    got = read_balanta_text_verdict(pdf_bytes)
    if got.workbook is None or got.meta is None:
        return None
    return got.workbook, got.meta


def read_balanta_text_verdict(pdf_bytes: bytes) -> TextReadResult:
    """The PDF's verified read, or the layout its header names and why it
    was refused (see `TextRead`).

    NEVER RAISES, and the layout is decided before anything can fail: a
    caller that sees `names_strict_layout(layout)` must treat a missing
    workbook as a final refusal. When the text lines name no layout —
    pdfplumber missing or failing on the file, or a header outside the
    first 40 lines — the first page as PyMuPDF and pypdf read it is a
    second opinion: if either names the five-pair layout (or the four-pair
    column one), the document is refused as one (its columns cannot be
    read line by line), instead of
    falling to the positional ingester, which keeps only undotted codes
    and accepts on the account-121 anchor alone. The one exception is the
    positional ingester's own five-pair dialect (see the module
    docstring): printed in the text lines' title block or on the first
    page as either extractor reads it, it is LAYOUT_FIVE_PAIR_POSITIONAL
    — no workbook, no refusal — and the caller keeps its positional path.
    """
    seen: Dict[str, Optional[str]] = {"layout": None}
    try:
        return _read_verdict(pdf_bytes, seen)
    except Exception as crash:  # noqa: BLE001 — a crash is a refusal for a five-pair document
        logger.info("[pdf_balanta_text] text-line read failed", exc_info=True)
        layout = seen["layout"]
        refusal = (("the reader failed on it (%s)" % type(crash).__name__) if names_strict_layout(layout)
                   else None)
        return TextReadResult(layout, None, None, refusal)


def _read_verdict(pdf_bytes: bytes, seen: Dict[str, Optional[str]]) -> TextReadResult:
    lines = _extract_lines(pdf_bytes) or []
    seen["layout"] = detect_layout(lines)  # known before anything below can fail
    if seen["layout"] is None:
        for text in _first_page_texts(pdf_bytes):
            other = _layout_of(text, _flattened_names_five_pair(text), _flattened_positional_dialect(text),
                               _flattened_names_four_pair(text))
            if other == LAYOUT_FIVE_PAIR_POSITIONAL:
                logger.info("[pdf_balanta_text] another text extraction of the first page prints the "
                            "positional ingester's five-pair dialect — left to that ingester")
                return TextReadResult(LAYOUT_FIVE_PAIR_POSITIONAL, None, None, None)
            if names_strict_layout(other):
                named = "four-pair column" if other == LAYOUT_FOUR_PAIR_COLUMNS else "five-pair"
                reason = ("another text extraction of its first page names the %s layout, "
                          "but its text lines do not, so its columns cannot be read line by line" % named)
                logger.info("[pdf_balanta_text] %s refused: %s", named, reason)
                return TextReadResult(other, None, None, reason)
        return TextReadResult(None, None, None, None)
    if seen["layout"] == LAYOUT_FIVE_PAIR_POSITIONAL:
        logger.info("[pdf_balanta_text] the document prints the positional ingester's five-pair "
                    "dialect — left to that ingester, not read here")
        return TextReadResult(LAYOUT_FIVE_PAIR_POSITIONAL, None, None, None)
    if seen["layout"] == LAYOUT_FOUR_PAIR_COLUMNS:
        # read again with the word split its columns need: pdfplumber's
        # default glues words printed on both sides of a column edge
        verdict = _four_pair_verdict(_extract_lines_at(pdf_bytes, _FOUR_X_TOLERANCE))
    else:
        verdict = parse_lines_verdict(lines)
    parsed = verdict.parsed
    if parsed is None:
        return TextReadResult(verdict.layout, None, None, verdict.refusal)
    meta = {
        "layout": parsed.get("layout", "eight_figure"),
        "accounts": len(parsed["rows"]),
        "number_format": parsed["number_format"],
        "classes": parsed["classes"],
        "grand_totals": [str(x) for x in parsed["grand"]],
    }
    period = parsed.get("period")
    if period:  # carried to the parse: the period comes from the document
        meta["period_text"], meta["period_end"] = period["text"], period["end"]
    return TextReadResult(verdict.layout, to_saga_xlsx(parsed["rows"]), meta, None)
