"""Text-line reader for Romanian "Balanta de verificare" PDFs.

WHY THIS EXISTS (2026-09-21)
----------------------------
Every trial-balance PDF the position-based ingester (`pdf_ingester`) could
not read fell through to the Claude extractor. With the Anthropic account
out of credit that meant every such upload failed; and even with credit the
Claude path captures no account-121 anchor. Measured on a real book (a
Bucharest real-estate SRL, Dec 2025): `pdf_ingester` found no account rows,
because its word grouping splits space-thousands numbers ("45 200.00") into
separate tokens.

This reader works on the PDF's TEXT LINES instead. One account per line:

    <cont> <name ...> <si_d> <si_c> <rl_d> <rl_c> <st_d> <st_c> <sf_d> <sf_c>

numbers in the "1 523 085.88" (space thousands, dot decimals) or
"1.523.085,88" (dot thousands, comma decimals) shape, continuation lines
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
  * every account line carries exactly ten figures;
  * Total rulaj == Rulaj anterior + Rulaj curent, per side, per row;
  * Sold final net == Sold initial net + Total rulaj net, per row;
  * every class with accounts has a printed "Total clasa N:" and its rows
    sum to it on all ten columns (a printed total for a class with no
    accounts must be zero); a printed "Total general:", if any, equals the
    sum of every row on all ten columns;
  * total debit == total credit on each of the five pairs;
  * no account code appears twice; at least MIN_ACCOUNTS accounts;
  * no other line carries two or more figures (a figure row this reader
    could not attribute to an account is a refusal, never a skip).

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
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

MIN_ACCOUNTS = 20

# One number shape per locale; a document must use exactly one.
_NUM_SPACE = r"-?\d{1,3}(?: \d{3})*\.\d{2}"      # 1 523 085.88
_NUM_EURO = r"-?\d{1,3}(?:\.\d{3})*,\d{2}"        # 1.523.085,88

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
    "adresa:", "c.u.i", "debit credit", "data si ora", "cod raport",
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


def parse_lines(lines: List[str]) -> Optional[Dict[str, Any]]:
    """The pure core: text lines in, verified rows out (or None).

    Returned rows carry the eight figures verbatim as Decimals in document
    order: si_d, si_c, rl_d, rl_c, st_d, st_c, sf_d, sf_c.
    """
    folded_all = _fold("\n".join(lines[:40]))
    eight = all(tok in folded_all for tok in _HEADER_TOKENS)
    five = all(tok in folded_all for tok in _HEADER_TOKENS_5PAIR)
    if eight and five:
        logger.info("[pdf_balanta_text] refused: header matches both layouts")
        return None
    if five:
        return _parse_five_pair(lines)
    if not eight:
        return None

    candidates = []
    for euro, num in ((False, _NUM_SPACE), (True, _NUM_EURO)):
        row_re = re.compile(r"^(\d{3,9})\s+(.*?)((?:\s+" + num + r"){8})\s*$")
        # The class digit is consumed by the prefix, so it can never be read
        # as the leading group of the first figure ("clasa 1 269 375.40").
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


def _refuse5(reason: str, *args: Any) -> None:
    logger.info("[pdf_balanta_text] five-pair refused: " + reason, *args)
    return None


def _five_figures(body: str) -> Optional[List[Decimal]]:
    """A printed total's body: exactly ten figures and nothing else."""
    tokens = body.split()
    if len(tokens) != 10 or not all(_FIG_5PAIR.match(t) for t in tokens):
        return None
    return [_fig5(t) for t in tokens]


def _parse_five_pair(lines: List[str]) -> Optional[Dict[str, Any]]:
    """The five-pair layout: every check in the module docstring, or None."""
    rows: List[Dict[str, Any]] = []
    class_totals: Dict[str, List[Decimal]] = {}
    grand_printed: Optional[List[Decimal]] = None
    last: Optional[Dict[str, Any]] = None
    column_headers = 0

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        f = _fold(line)
        tokens = line.split()

        if not _CODE_5PAIR.match(tokens[0]):
            norm = " ".join(f.split())
            if any(p in norm for p in _COLUMN_PHRASES_5PAIR):
                if norm != _COLUMN_HEADER_5PAIR:
                    return _refuse5("column header reads %r, not the five-pair column order", line[:120])
                column_headers += 1
                continue  # page header — a name may continue after it

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
                extra = rest[len(rest) - run:len(rest) - 10]
                if any(x != code for x in extra):
                    return _refuse5("account %s carries %d figures, not 10", code, run)
                name = [x for x in rest[:len(rest) - 10] if x != code]
                last = {
                    "cont": code,
                    "name": " ".join(name).rstrip(" -"),
                    "figures": [_fig5(x) for x in rest[len(rest) - 10:]],
                }
                rows.append(last)
                continue
            known = {code} | ({last["cont"]} if last is not None else set())
            if run and any(x not in known for x in rest[len(rest) - run:]):
                return _refuse5("account %s carries %d figures, not 10", code, run)
            # a continuation that starts with a number: the repeated code, or a wrapped name

        # A continuation line: the rest of the previous account's name.
        own = last["cont"] if last is not None else None
        kept = [x for x in tokens if x != own]
        if sum(1 for x in kept if _FIG_5PAIR.match(x)) >= 2:
            return _refuse5("a line with figures is neither an account nor a total: %r", line[:60])
        if last is not None and kept:
            last["name"] = (last["name"] + " " + " ".join(kept)).strip().rstrip(" -")

    if len(rows) < MIN_ACCOUNTS:
        return _refuse5("%d account lines (< %d)", len(rows), MIN_ACCOUNTS)
    if len({r["cont"] for r in rows}) != len(rows):
        return _refuse5("an account appears twice")
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


def read_balanta_text_pdf(pdf_bytes: bytes) -> Optional[Tuple[bytes, Dict[str, Any]]]:
    """(xlsx_bytes, meta) when the PDF is a verifiable balanta, else None."""
    lines = _extract_lines(pdf_bytes)
    if not lines:
        return None
    parsed = parse_lines(lines)
    if parsed is None:
        return None
    meta = {
        "layout": parsed.get("layout", "eight_figure"),
        "accounts": len(parsed["rows"]),
        "number_format": parsed["number_format"],
        "classes": parsed["classes"],
        "grand_totals": [str(x) for x in parsed["grand"]],
    }
    return to_saga_xlsx(parsed["rows"]), meta
