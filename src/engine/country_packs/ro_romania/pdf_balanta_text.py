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

with comma-thousands, dot-decimal figures ("1,234,567.89", "-250.00"),
dotted analytic codes ("1015.03", "167.305"), the code repeated inside or
after the name ("121 121 Profit sau pierdere", a continuation line holding
only the code), "Clasa N" section headings and "Total clasa N:" totals.

The layout is chosen by header tokens; a document whose header matches both
layouts, or neither, is refused. The five-pair reader is stricter than the
eight-figure one because the document states two identities per row that
can be checked to the cent — and it refuses unless ALL of these hold:

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
    layout's own structure — never a number that happens to recur — says
    which code a line belongs to. A figure-less line led by a code-shaped
    token X (not the current account's code) is the current account's
    continuation only when it ENDS with that account's code, as the
    layout ends its continuation lines; the next account line must then
    repeat its own code where the layout prints it (right after the
    code, right before the figures, or ending a continuation line).
    Otherwise the line is held, and the ONLY thing that may follow it is
    account X's figure line — not another account, not a class heading or
    total (a wrapped row split by a heading), not the end of the document.

Negative figures are carried verbatim: a storno is a negative movement on
its own side, never a flipped side. The workbook maps SI = Sold initial,
RL = Rulaj curent, RC = Total rulaj (cumulated turnover WITHOUT the opening
balance — exactly how the same ERP's Excel export fills "Rulaj cumulat",
which the Excel path already reads), SF = Sold final. "Rulaj anterior" is
not carried: it is Total rulaj minus Rulaj curent, checked above.
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
_FIG_5PAIR = re.compile(r"^-?\d{1,3}(?:,\d{3})*\.\d{2}$")      # 1,234,567.89
_CODE_5PAIR = re.compile(r"^\d{3,6}(?:\.\d{1,3})?$")             # 121, 1015.03, 167.305
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
# _WRAP_RULE — a wrapped row cannot hand its figures to another code. A
# figure-less line led by a code-shaped token X that is not the current
# account's code is either the current account's continuation (a name
# that goes on with a number, a year) or the first line of a wrapped row
# X whose figures follow on a line led by some number from its name:
# "4111.05 Client" / "404 Media SRL <ten figures>" would read as account
# 404 with 4111.05's figures, and every total would still tie.
#
# Only STRUCTURE decides, never a number that happens to recur on the
# figure line ("404 Media 404 SRL" repeats 404 by coincidence):
#   * the layout ends a continuation line with the account's code
#     ("... 1006.01"), so a line led by X that ENDS with the current
#     account's code is that account's continuation — and the next account
#     line must then repeat its own code in one of the layout's slots
#     (`_repeats_in_a_slot`: right after the code, right before the
#     figures, or ending one of its continuation lines);
#   * any other such line is HELD, and the only thing that may follow it
#     is account X's figure line (the held line was that row's first
#     line). Another account's line refuses the book — and so does a
#     "Clasa N" heading, a class or grand total, or the end of the
#     document: a row whose two lines straddle a heading is exactly the
#     wrap this rule exists to catch, and settling the held line into the
#     previous account's name there let the figure line through unchecked.
_HELD_REFUSAL = ("account %s follows a line led by the code-shaped %s, which neither ends with the "
                 "previous account's code nor is followed by its own figures (a wrapped row could "
                 "hand its figures to another code)")
_HELD_UNRESOLVED_REFUSAL = ("the line led by the code-shaped %s is followed by %s, not by its own "
                            "figures (a wrapped row whose lines straddle a heading or total could "
                            "hand its figures to another code)")
_WRAP_REFUSAL = ("account %s follows a line led by the code-shaped %s but never repeats its own "
                 "code where the layout prints it — right after the code, right before the "
                 "figures, or ending a continuation line (a wrapped row could hand its figures "
                 "to another code)")
# Document column order, five (debit, credit) pairs.
_SI_D, _SI_C, _RA_D, _RA_C, _RL_D, _RL_C, _TR_D, _TR_C, _SF_D, _SF_C = range(10)


def _fold(text: str) -> str:
    table = str.maketrans("ăâîșşțţĂÂÎȘŞȚŢ", "aaisstt" + "AAISSTT")
    return text.translate(table).lower()


def _to_decimal(token: str, euro: bool) -> Decimal:
    t = token.replace(".", "").replace(",", ".") if euro else token.replace(" ", "")
    return Decimal(t)


def _extract_lines(pdf_bytes: bytes) -> Optional[List[str]]:
    try:
        import pdfplumber  # type: ignore
    except ImportError:
        return None
    try:
        lines: List[str] = []
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                lines.extend((page.extract_text() or "").splitlines())
        return lines
    except Exception:  # noqa: BLE001 — an unreadable PDF is a refusal, never a crash
        logger.info("[pdf_balanta_text] text extraction failed", exc_info=True)
        return None


LAYOUT_FIVE_PAIR = "five_pair"
LAYOUT_EIGHT_FIGURE = "eight_figure"
LAYOUT_BOTH = "both"

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
    LAYOUT_EIGHT_FIGURE, LAYOUT_BOTH) or None when it names neither;
    `parsed` the verified read, or None; `refusal` why a five-pair (or
    both-layouts) document was refused. A caller that recognises the
    five-pair layout must treat a refusal as final: the positional
    fast-path reads only undotted codes and would serve a partial balance
    on the 121 anchor alone.
    """

    layout: Optional[str]
    parsed: Optional[Dict[str, Any]]
    refusal: Optional[str]


class _FivePairRefusal(Exception):
    """Raised by `_refuse5`; carries the logged reason."""


def names_five_pair(layout: Optional[str]) -> bool:
    """True when a document's header names the five-pair layout (alone or
    with the eight-figure one). Such a document is read by the strict
    five-pair reader or refused — never handed to another reader."""
    return layout in (LAYOUT_FIVE_PAIR, LAYOUT_BOTH)


def _layout_of(folded: str) -> Optional[str]:
    eight = all(tok in folded for tok in _HEADER_TOKENS)
    five = all(tok in folded for tok in _HEADER_TOKENS_5PAIR)
    if eight and five:
        return LAYOUT_BOTH
    return LAYOUT_FIVE_PAIR if five else LAYOUT_EIGHT_FIGURE if eight else None


def detect_layout(lines: List[str]) -> Optional[str]:
    """The layout a document's header names, from its first 40 text lines
    (LAYOUT_FIVE_PAIR, LAYOUT_EIGHT_FIGURE, LAYOUT_BOTH), or None. Pure and
    total: it cannot raise, so the layout is known before any reading can
    go wrong."""
    return _layout_of(_fold("\n".join(str(x) for x in lines[:40])))


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

    Never raises for a document whose header names the five-pair layout:
    anything the reader throws is a refusal (the caller must not fall
    through to a reader that approximates). An eight-figure read that
    throws is None, and keeps its fall-back.
    """
    layout = detect_layout(lines)
    if layout == LAYOUT_BOTH:
        logger.info("[pdf_balanta_text] refused: header matches both layouts")
        return TextRead(LAYOUT_BOTH, None, "the header matches both balanta layouts")
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
            line = raw.strip()
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


def _fig5(token: str) -> Decimal:
    return Decimal(token.replace(",", ""))


def _refuse5(reason: str, *args: Any) -> NoReturn:
    message = reason % args if args else reason
    logger.info("[pdf_balanta_text] five-pair refused: %s", message)
    raise _FivePairRefusal(message)


def _five_figures(body: str) -> Optional[List[Decimal]]:
    """A printed total's body: exactly ten figures and nothing else."""
    tokens = body.split()
    if len(tokens) != 10 or not all(_FIG_5PAIR.match(t) for t in tokens):
        return None
    return [_fig5(t) for t in tokens]


def _repeats_in_a_slot(code: str, printed: List[str]) -> bool:
    """True when an account line repeats its code where the layout prints
    it: right after the code ("121 121 Profit ...") or right before the
    figures ("Casa in lei 531.01 <figures>"). A repeat anywhere else in the
    name is a number that happens to recur, not the layout's evidence."""
    return bool(printed) and (printed[0] == code or printed[-1] == code)


def _vsum(group: List[Dict[str, Any]]) -> List[Decimal]:
    return [sum((k["figures"][i] for k in group), Decimal(0)) for i in range(10)]


def _codes(group: List[Dict[str, Any]], limit: int = 8) -> str:
    shown = ", ".join(k["cont"] for k in group[:limit])
    return shown + (" and %d more" % (len(group) - limit) if len(group) > limit else "")


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
        `_parent_prefix` of its own — all of them, or all at one code
        length (a sibling-by-prefix at another length would otherwise
        spoil the full sum); one child is enough, a parent may have one;
      * the sum of TWO OR MORE other rows under the same three-digit root
        (the RAS synthetic account): all of them, all sharing its base
        (the code before the dot), or all of either at one code length.
        One identical sibling is not a sum — two accounts may carry the
        same figures.

    An all-zero row is exempt: listed twice or not, it adds nothing to any
    figure. Sums over a whole root are taken from running totals, so a
    root with hundreds of analytics costs no more than a small one.
    """
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
                total = sums.setdefault(key, [Decimal(0)] * 10)
                for i in range(10):
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
        for scope, name in (("root", root), ("base", base)):
            keys = [(scope, name)] + [(scope, name, n) for n in sorted(lengths[(scope, name)])]
            for key in keys:
                inside = r in members[key]
                if len(members[key]) - inside < 2:
                    continue
                total = sums[key]
                if [total[i] - (v[i] if inside else 0) for i in range(10)] == v:
                    group = [k for k in members[key] if k is not r]
                    return ("account %s equals the sum of %s — a subtotal listed beside the "
                            "accounts it sums" % (code, _codes(group)))
    return None


def _parse_five_pair(lines: List[str]) -> Optional[Dict[str, Any]]:
    """The five-pair layout: every check in the module docstring, or None."""
    rows: List[Dict[str, Any]] = []
    class_totals: Dict[str, List[Decimal]] = {}
    grand_printed: Optional[List[Decimal]] = None
    last: Optional[Dict[str, Any]] = None
    column_headers = 0
    expect_sub_header = False
    # _WRAP_RULE state. `pending`: a HELD line — a figure-less line led by
    # a code-shaped token X that is neither the current account's code nor
    # ends with it; nothing but account X's figure line may follow it.
    # `need_repeat`: a line led by X that ended with the current account's
    # code was read as that account's continuation; the next account line
    # must repeat its own code in one of the layout's slots.
    # `unrepeated`: that account line, until one of its continuation lines
    # ends with its code — refused if its block ends first.
    pending: Optional[Dict[str, Any]] = None
    need_repeat: Optional[str] = None
    unrepeated: Optional[Dict[str, Any]] = None

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        f = _fold(line)
        tokens = line.split()
        norm = " ".join(f.split())

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
        if ends_block:
            if pending is not None:
                heading = line.split(":", 1)[0] + (":" if ":" in line else "")  # never its figures
                return _refuse5(_HELD_UNRESOLVED_REFUSAL, pending["x"], repr(heading))
            if unrepeated is not None:
                return _refuse5(_WRAP_REFUSAL, unrepeated["row"]["cont"], unrepeated["x"])

        t = _TOTAL_CLASS_5PAIR.match(f)
        if t:
            figures = _five_figures(t.group(2))
            if figures is None:
                return _refuse5("class %s total does not carry exactly ten figures", t.group(1))
            if t.group(1) in class_totals:
                return _refuse5("class %s total printed twice", t.group(1))
            class_totals[t.group(1)] = figures
            last = None
            continue
        g = _TOTAL_GENERAL_5PAIR.match(f)
        if g:
            figures = _five_figures(g.group(1))
            if figures is None or grand_printed is not None:
                return _refuse5("grand total is not one line of exactly ten figures")
            grand_printed = figures
            last = None
            continue
        if _CLASS_HEADING_5PAIR.match(f):
            last = None
            continue
        if f.startswith(_SKIP_PREFIXES_5PAIR) or "utilizator:" in f:
            if sum(1 for x in tokens if _FIG_5PAIR.match(x)) >= 2:
                return _refuse5("a page header/footer line carries figures: %r", line[:60])
            continue  # page header / footer — a name may continue after it

        if _CODE_5PAIR.match(tokens[0]):
            code, rest = tokens[0], tokens[1:]
            run = 0
            while run < len(rest) and _FIG_5PAIR.match(rest[-1 - run]):
                run += 1
            if run >= 10:
                if not column_headers:
                    return _refuse5("account %s is printed before the column header", code)
                if unrepeated is not None:
                    return _refuse5(_WRAP_REFUSAL, unrepeated["row"]["cont"], unrepeated["x"])
                extra = rest[len(rest) - run:len(rest) - 10]
                if any(x != code for x in extra):
                    return _refuse5("account %s carries %d figures, not 10", code, run)
                printed = rest[:len(rest) - 10]  # the name as printed, repeated codes included
                name = [x for x in printed if x != code]
                # Figures the reader cannot attribute are a refusal, never
                # a skip — and that holds for the NAME part of an account
                # line too. Two rows on one text line put the first row's
                # ten figures (and the second row's code) into the name,
                # and the first code would take the second row's figures.
                in_name = sum(1 for x in name if _FIG_5PAIR.match(x))
                if in_name >= 2:
                    return _refuse5("account %s: its name carries %d figure-shaped tokens "
                                    "(two rows on one line?)", code, in_name)
                if any(_CODE_5PAIR.match(a) and _FIG_5PAIR.match(b) for a, b in zip(name, name[1:])):
                    return _refuse5("account %s: its name holds a code followed by a figure "
                                    "(two rows on one line?)", code)
                row = {
                    "cont": code,
                    "name": " ".join(name).rstrip(" -"),
                    "figures": [_fig5(x) for x in rest[len(rest) - 10:]],
                }
                if pending is not None:
                    if code != pending["x"]:
                        return _refuse5(_HELD_REFUSAL, code, pending["x"])
                    # the held line was this row's first line
                    lead = [x for x in pending["text"] if x != code]
                    row["name"] = " ".join(lead + name).rstrip(" -")
                    pending = None
                if need_repeat is not None:
                    if not _repeats_in_a_slot(code, printed):
                        unrepeated = {"row": row, "x": need_repeat}
                    need_repeat = None
                last = row
                rows.append(last)
                continue
            known = {code} | ({last["cont"]} if last is not None else set())
            if run and any(x not in known for x in rest[len(rest) - run:]):
                return _refuse5("account %s carries %d figures, not 10", code, run)
            if last is None or code != last["cont"]:
                # led by a code-shaped token that is not the current
                # account's (see `_WRAP_RULE`)
                if sum(1 for x in tokens if _FIG_5PAIR.match(x) and x != code
                       and (last is None or x != last["cont"])) >= 2:
                    return _refuse5("a line with figures is neither an account nor a total: %r", line[:60])
                if pending is not None:
                    if code != pending["x"]:
                        return _refuse5(_HELD_REFUSAL, code, pending["x"])
                    pending["text"].extend(tokens)  # the held row's code printed again
                    continue
                if last is None or tokens[-1] != last["cont"]:
                    pending = {"x": code, "text": tokens}
                    continue
                # it ends with the current account's code: that account's
                # continuation, read below — and the next account line
                # must repeat its own code in a slot
                need_repeat = code
            elif pending is not None:
                return _refuse5(_HELD_REFUSAL, code, pending["x"])

        # A continuation line: the rest of the previous account's name (or
        # of the held line, while one is held).
        own = last["cont"] if last is not None else None
        kept = [x for x in tokens if x != own]
        if sum(1 for x in kept if _FIG_5PAIR.match(x)) >= 2:
            return _refuse5("a line with figures is neither an account nor a total: %r", line[:60])
        if pending is not None:
            pending["text"].extend(tokens)
            continue
        if unrepeated is not None and unrepeated["row"] is last and tokens[-1] == own:
            unrepeated = None
        if last is not None and kept:
            last["name"] = (last["name"] + " " + " ".join(kept)).strip().rstrip(" -")

    if pending is not None:
        return _refuse5(_HELD_UNRESOLVED_REFUSAL, pending["x"], "the end of the document")
    if unrepeated is not None:
        return _refuse5(_WRAP_REFUSAL, unrepeated["row"]["cont"], unrepeated["x"])
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
    return {"rows": rows, "grand": grand, "number_format": "comma", "classes": classes,
            "layout": "five_pair"}


def to_saga_xlsx(rows: List[Dict[str, Any]]) -> bytes:
    """SAGA 10-column workbook, figures verbatim.

    RC is the document's own cumulative pair: "sume totale" for the
    eight-figure layout, "Total rulaj" for the five-pair layout.
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
    caller that sees `names_five_pair(layout)` must treat a missing
    workbook as a final refusal. When the text lines name no layout —
    pdfplumber missing or failing on the file, or a header outside the
    first 40 lines — the first page as PyMuPDF and pypdf read it is a
    second opinion: if either names the five-pair layout, the document is
    refused as one (its columns cannot be read line by line), instead of
    falling to the positional ingester, which keeps only undotted codes
    and accepts on the account-121 anchor alone.
    """
    seen: Dict[str, Optional[str]] = {"layout": None}
    try:
        return _read_verdict(pdf_bytes, seen)
    except Exception as crash:  # noqa: BLE001 — a crash is a refusal for a five-pair document
        logger.info("[pdf_balanta_text] text-line read failed", exc_info=True)
        layout = seen["layout"]
        refusal = ("the reader failed on it (%s)" % type(crash).__name__) if names_five_pair(layout) else None
        return TextReadResult(layout, None, None, refusal)


def _read_verdict(pdf_bytes: bytes, seen: Dict[str, Optional[str]]) -> TextReadResult:
    lines = _extract_lines(pdf_bytes) or []
    seen["layout"] = detect_layout(lines)  # known before anything below can fail
    if seen["layout"] is None:
        for text in _first_page_texts(pdf_bytes):
            other = _layout_of(text)
            if names_five_pair(other):
                reason = ("another text extraction of its first page names the five-pair layout, "
                          "but its text lines do not, so its columns cannot be read line by line")
                logger.info("[pdf_balanta_text] five-pair refused: %s", reason)
                return TextReadResult(other, None, None, reason)
        return TextReadResult(None, None, None, None)
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
    return TextReadResult(verdict.layout, to_saga_xlsx(parsed["rows"]), meta, None)
