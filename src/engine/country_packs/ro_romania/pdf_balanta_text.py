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
    if not all(tok in folded_all for tok in _HEADER_TOKENS):
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


def to_saga_xlsx(rows: List[Dict[str, Any]]) -> bytes:
    """SAGA 10-column workbook, figures verbatim (RC = the document's sume totale)."""
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
        "accounts": len(parsed["rows"]),
        "number_format": parsed["number_format"],
        "classes": parsed["classes"],
        "grand_totals": [str(x) for x in parsed["grand"]],
    }
    return to_saga_xlsx(parsed["rows"]), meta
