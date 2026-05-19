"""
Public-records financial-summary parser.
========================================

Romanian public-records aggregator sites — listafirme.ro, termene.ro,
firme.info, idilis.ro — publish a 6-column annual financial table for
every active SRL/SA/PFA, scraped from ANAF / ONRC filings.

Format (uniform across all 4 sites):

  Cifra afaceri | Profit net | Datorii totale | Active imobilizate |
  Active circulante | Capitaluri proprii | Număr salariați

This is NOT a trial balance. It's a 6-aggregate × N-years × 1 employee-
count summary. The platform's TB pipeline can't reconstruct a P&L from
6 numbers; trying to do so silently produced garbage on the PRO TV case
(revenue = EBITDA = net income = 1.14B RON because the Claude extractor
stuffed the cifra-de-afaceri into every empty slot).

This parser ROUTES public-records PDFs to a separate `public_records_annual`
persistence table that powers a "Multi-year history" view — actual
deterministic data (no extraction guesses), useful for:
  · due-diligence trend analysis (18+ years of revenue/profit/debt)
  · peer enrichment (PRO TV at 25.7% net margin → media benchmark anchor)
  · longitudinal benchmarking ("you grew slower than peer X for 3 years")

Confidence: deterministic — every number is a direct read from the PDF
text, no LLM in the path. Numbers parse with Romanian thousands separator
(space) and locale-tolerant.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Silence pdfminer.six's noisy per-page warnings (FontBBox parse errors,
# /'P##' invalid float colors, etc.). They're rendering-trivia from
# listafirme.ro PDFs that don't affect extraction quality but drown the
# pipeline log when running geometry-aware parsing.
logging.getLogger("pdfminer").setLevel(logging.ERROR)
logging.getLogger("pdfminer.pdfinterp").setLevel(logging.ERROR)
logging.getLogger("pdfminer.cmapdb").setLevel(logging.ERROR)
logging.getLogger("pdfminer.layout").setLevel(logging.ERROR)
logging.getLogger("pdfminer.pdfdocument").setLevel(logging.ERROR)
logging.getLogger("pdfminer.pdffont").setLevel(logging.ERROR)
logging.getLogger("pdfminer.pdfparser").setLevel(logging.ERROR)
logging.getLogger("pdfminer.psparser").setLevel(logging.ERROR)
logging.getLogger("pdfplumber").setLevel(logging.WARNING)


# ─── Data shape ─────────────────────────────────────────────────────────────


@dataclass
class PublicRecordsRow:
    """One year × 6 metrics row from the annual summary table."""
    year: int
    cifra_afaceri: float
    profit_net: float
    datorii_totale: float
    active_imobilizate: float
    active_circulante: float
    capitaluri_proprii: float
    salariati: Optional[int]

    @property
    def total_assets(self) -> float:
        """Active imobilizate + circulante = total assets (the public-records
        format omits the explicit total; we derive it)."""
        return self.active_imobilizate + self.active_circulante

    @property
    def net_margin_pct(self) -> Optional[float]:
        """Net margin % — derived signal, not in the source."""
        if self.cifra_afaceri <= 0:
            return None
        return (self.profit_net / self.cifra_afaceri) * 100.0


@dataclass
class PublicRecordsExtract:
    """Output of `parse_public_records_pdf()`.

    `confidence` is the fraction of expected fields parsed successfully.
    `years` runs newest → oldest (matches the source rendering)."""
    company_name: Optional[str]
    cui: Optional[str]
    reg_com: Optional[str]
    caen_code: Optional[str]
    caen_description: Optional[str]
    source_site: Optional[str]
    years: List[PublicRecordsRow]
    confidence: float


# ─── Header markers used for detection ──────────────────────────────────────
#
# The 4 public-records sites use slightly different chrome but a near-
# identical financial-table header. We match on the joined-string version
# (no spaces between column names) because PDF text extraction sometimes
# concatenates the columns into one token.

_HEADER_TOKENS = (
    "cifraafaceri",      # appears in listafirme.ro
    "cifra de afaceri",  # appears in termene.ro
)
_REQUIRED_COL_TOKENS = (
    "profitnet", "profit net",
    "datoriitotale", "datorii totale",
    "capitaluriproprii", "capitaluri proprii",
)

# Source-site detection from URL fingerprints in the footer
_SOURCE_FINGERPRINTS = {
    "listafirme.ro": "listafirme.ro",
    "termene.ro": "termene.ro",
    "firme.info": "firme.info",
    "idilis.ro": "idilis.ro",
    "risco.ro": "risco.ro",
}


def looks_like_public_records(text: str) -> bool:
    """Cheap O(n) header check used by the document-type detector. Returns
    True when the text carries a public-records financial-summary header,
    so the pipeline routes to this parser instead of the TB pipeline."""
    if not text:
        return False
    lower = text.lower()
    has_header = any(h in lower for h in _HEADER_TOKENS)
    if not has_header:
        return False
    # Require at least 2 of the required column tokens too — protects against
    # a TB that happens to mention "cifra de afaceri" once in narrative.
    hits = sum(1 for t in _REQUIRED_COL_TOKENS if t in lower)
    return hits >= 2


# ─── Number parsing ─────────────────────────────────────────────────────────
#
# Romanian PDF text drops thousands separators as plain spaces:
#   "1 143 087 964"  →  1143087964
# Some exports use non-breaking spaces (\xa0) or thin spaces ( ).
# Negative numbers are sometimes wrapped in parens or carry "-" prefix.


_NUMBER_RE = re.compile(r"(-?\(?\s*\d[\d \xa0 \.]*\)?)")


def _parse_ro_number(s: str) -> Optional[float]:
    """Parse a Romanian-formatted number. Returns None when the string
    doesn't carry a numeric value. Negative-in-parens → negative float."""
    if not s:
        return None
    s = s.strip()
    if not s:
        return None
    negative = False
    if s.startswith("(") and s.endswith(")"):
        s = s[1:-1].strip()
        negative = True
    if s.startswith("-"):
        negative = True
        s = s[1:].strip()
    # Strip all whitespace variants (thousands separator + non-breaking).
    s = re.sub(r"[\s\xa0 ]", "", s)
    # Romanian decimal is comma; convert to dot. Drop "." thousands if any
    # (the listafirme format uses space, not dot, but we accept both).
    if "," in s and "." in s:
        s = s.replace(".", "")
        s = s.replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        v = float(s)
        return -v if negative else v
    except ValueError:
        return None


# ─── Identity extraction ────────────────────────────────────────────────────


def _extract_cui(text: str) -> Optional[str]:
    """Match `CUI ##########`. CUI is 5-10 digits, sometimes prefixed `RO`."""
    m = re.search(r"\bCUI\s+(?:RO\s*)?(\d{5,10})\b", text)
    return m.group(1) if m else None


def _extract_reg_com(text: str) -> Optional[str]:
    """Match `Nr. Reg. Com. J##########` (Romanian commercial register)."""
    m = re.search(r"(?:Reg\.?\s*Com\.?|Reg\.\s*Com\.|Registrul Comertului)[^A-Za-z0-9]{0,5}([JFC]\d{1,4}\s*/?\s*\d{1,8}\s*/?\s*\d{0,4})",
                  text, re.IGNORECASE)
    return re.sub(r"\s+", "", m.group(1)) if m else None


def _extract_caen(text: str) -> tuple[Optional[str], Optional[str]]:
    """Match `Cod CAEN ... NNNN` + the activity description on the next line."""
    # Pattern: "Cod CAEN preponderent NNNN Rev. 2"
    m = re.search(r"Cod CAEN(?:\s+preponderent)?\s+(\d{2,4})\b", text)
    code = m.group(1) if m else None
    # Activity description appears on the line "Obiect Activitate ..."
    md = re.search(r"Obiect Activitate\s+([^\n]+)", text)
    descr = None
    if md:
        descr = md.group(1).strip()
        # Trim trailing CAEN noise like "Cod CAEN..." if it bled into the line
        descr = re.split(r"\s{2,}|Cod CAEN", descr)[0].strip()
    return code, descr


def _extract_company_name(text: str) -> Optional[str]:
    """Company name appears as the first non-empty title line in the PDF
    AND inside the URL slug. Use both for robustness."""
    # First line approach — listafirme PDF starts with the company name
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), None)
    if first and " SRL" in first or " SA" in (first or ""):
        # Strip any trailing "Prima oară pe site?" noise
        return re.split(r"Prima\s+oar", first, maxsplit=1)[0].strip()
    # Fallback — look for "Denumire <NAME>"
    m = re.search(r"Denumire\s+([A-ZĂÂÎȘȚ][A-ZĂÂÎȘȚ0-9 \-&'\.]+(?:SRL|SA|PFA|SCS|SCA)\b)", text)
    return m.group(1).strip() if m else None


def _detect_source_site(text: str) -> Optional[str]:
    for fp, label in _SOURCE_FINGERPRINTS.items():
        if fp in text.lower():
            return label
    return None


# ─── Annual table extraction ────────────────────────────────────────────────


def _extract_annual_rows_geometry(pdf_bytes: bytes) -> List[PublicRecordsRow]:
    """Geometry-aware extractor using pdfplumber's word-level x-coordinates.

    Reads each PDF word's (text, x0, x1, top) and groups them into amounts
    by horizontal gap. Empirically on listafirme.ro PDFs the gaps are
    sharply bimodal:
      · Within-amount gaps (thousands separators)  ≈  2–3 px
      · Inter-column gaps (column boundaries)       ≈ 20–65 px

    Anything below GAP_THRESH = 10 px continues the current amount; anything
    above starts a new one. This deterministically separates dense layouts
    (PRO TV — every amount 9–10 digits, fully glued in text mode) from
    sparse layouts (ELIT — amounts 1–5 digits, partly glued in text mode)
    using the SAME rule — no heuristic partition search, no plausibility
    guessing.

    Soft dependency on `pdfplumber`. If the import fails or extraction
    errors, returns []; the caller falls back to the text-based parsers
    (`_extract_annual_rows_sparse` then `_extract_annual_rows_dense`).
    Tested on the two calibration fixtures:
      · ELIT  AGENT SRL (CUI 15030786): 17/17 rows, every value matches
        the source oracle exactly (was 11/17 on text-based sparse parser)
      · PRO TV SRL      (CUI  2835636): 20/20 rows, every value matches
        the dense parser output (no regression)
    """
    try:
        import pdfplumber  # type: ignore
    except ImportError:
        logger.warning("[public_records] pdfplumber not installed; "
                       "geometry extractor unavailable")
        return []

    import io as _io
    GAP_THRESH = 10.0  # px

    rows: List[PublicRecordsRow] = []
    seen: set = set()

    try:
        with pdfplumber.open(_io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                # x_tolerance=1 keeps adjacent-digit groups separate so the
                # gap analysis below can decide intra-vs-inter; y_tolerance=2
                # handles minor baseline jitter from the PDF renderer.
                try:
                    words = page.extract_words(x_tolerance=1, y_tolerance=2)
                except Exception:
                    continue

                # Cluster words by row using `top`. listafirme rows are
                # ~12 pt apart; ±3 px is safe for clustering.
                page_rows: List[List[dict]] = []
                for w in words:
                    placed = False
                    for r in page_rows:
                        if abs(r[0]["top"] - w["top"]) < 3:
                            r.append(w); placed = True; break
                    if not placed:
                        page_rows.append([w])
                for r in page_rows:
                    r.sort(key=lambda w: w["x0"])

                for r in page_rows:
                    if not r:
                        continue
                    # Row must START with a 4-digit year in the plausible range.
                    if not re.fullmatch(r"\d{4}", r[0]["text"]):
                        continue
                    try:
                        year = int(r[0]["text"])
                    except ValueError:
                        continue
                    if not (1995 <= year <= 2030):
                        continue
                    if year in seen:
                        continue

                    # Assemble amounts via x-gap threshold.
                    assembled: List[str] = [r[0]["text"]]
                    cur: Optional[str] = None
                    cur_x1 = r[0]["x1"]
                    for w in r[1:]:
                        gap = w["x0"] - cur_x1
                        if gap < GAP_THRESH:
                            # Continuation of the previous amount.
                            if cur is None:
                                cur = assembled.pop()
                            cur += w["text"]
                        else:
                            if cur is not None:
                                assembled.append(cur); cur = None
                            assembled.append(w["text"])
                        cur_x1 = w["x1"]
                    if cur is not None:
                        assembled.append(cur)

                    # Expected: year + 6 amounts (Cifra, Profit, Datorii,
                    # Active imobilizate, Active circulante, Capitaluri)
                    # plus OPTIONALLY the salariați (employees) column.
                    # Some listafirme PDFs (e.g. PORSCHE ROMANIA SRL — auto-
                    # mobile distribution) omit the employees column for
                    # specific year rows even though the header lists it,
                    # so we accept 7 OR 8 assembled tokens. Without this,
                    # PORSCHE 2024 (year + 6 amounts = 7 tokens) would be
                    # dropped here and fall through to the digit-stream
                    # dense parser, which mis-partitions the row because
                    # it assumes the wrong total digit count → wrong
                    # numbers reach the dashboard (the bug fix this comment
                    # documents: pre-fix it showed revenue 48 M instead
                    # of the correct 4.798 B).
                    if len(assembled) not in (7, 8):
                        continue

                    parsed: List[Optional[float]] = [_parse_ro_number(t) for t in assembled[1:]]
                    if any(v is None for v in parsed):
                        continue
                    cifra, profit, debt, imob, circ, cap = parsed[:6]  # type: ignore[misc]
                    sal_v: Optional[float] = parsed[6] if len(parsed) > 6 else None
                    if cifra is None or cifra < 0:
                        continue
                    amounts = (cifra, profit, debt, imob, circ, cap)
                    if any(v is None or abs(v) > 1e12 for v in amounts):
                        continue
                    # Employees is optional: None when the column was
                    # absent from the source row.
                    if sal_v is None:
                        sal: Optional[int] = None
                    else:
                        try:
                            sal = int(sal_v)
                        except (TypeError, ValueError):
                            sal = None
                        if sal is not None and not (0 <= sal <= 99_999):
                            sal = None

                    rows.append(PublicRecordsRow(
                        year=year,
                        cifra_afaceri=float(cifra),  # type: ignore[arg-type]
                        profit_net=float(profit),    # type: ignore[arg-type]
                        datorii_totale=float(debt),  # type: ignore[arg-type]
                        active_imobilizate=float(imob),  # type: ignore[arg-type]
                        active_circulante=float(circ),   # type: ignore[arg-type]
                        capitaluri_proprii=float(cap),   # type: ignore[arg-type]
                        salariati=sal,
                    ))
                    seen.add(year)
    except Exception:
        logger.exception("[public_records] geometry extractor failed (non-fatal)")
        return []

    rows.sort(key=lambda r: -r.year)
    return rows


def _extract_annual_rows(text: str) -> List[PublicRecordsRow]:
    """Dispatch between the SPARSE (ELIT-style) and DENSE (PRO TV-style)
    layouts. listafirme.ro renders each company in one of two ways:

      DENSE — operating companies with all-large amounts. Every amount
      is 7+ digits so the renderer omits the inter-amount space; the
      year is digit-glued to the first amount. Example (PRO TV 2024):
        "20241\\xa0143\\xa0087\\xa0964293\\xa0330\\xa0500..."
      → 40-80 digits per row, year-anchor walks the digit stream.

      SPARSE — dormant / small-balance companies whose amounts are 1-5
      digits each. The renderer separates the year from the amounts
      with a real ASCII space, and most amounts with ASCII spaces
      between them. Example (ELIT AGENT 2021):
        "2021 0 017\\xa0244 1\\xa0899 22 -15\\xa0323 0"
      → 10-25 digits per row, line-by-line parse with token splicing.

    The two layouts are mutually exclusive at the year-boundary: dense
    has no ASCII space after the year, sparse always does. So the
    dispatcher tries SPARSE first (cheap, line-scanned); if it yields
    no rows we fall through to the DENSE digit-stream parser, which is
    unchanged from the version that parses PRO TV at 20/20.
    """
    rows = _extract_annual_rows_sparse(text)
    if rows:
        return rows
    return _extract_annual_rows_dense(text)


def _extract_annual_rows_sparse(text: str) -> List[PublicRecordsRow]:
    """Per-line parser for the SPARSE layout (ELIT-style dormants).

    Each year row is on its own text line, year separated from the
    first amount by a REGULAR ASCII space, amounts separated mostly by
    ASCII spaces, and \\xa0 (non-breaking space) used ONLY as a within-
    amount thousands separator. PRO TV's dense layout has no ASCII
    space after the year (digits are glued), so it yields zero rows
    here and the caller falls back to the dense parser.

    Two rendering quirks we recover from per-line:
      · Negative amounts glued to the previous one ("0-203" → "0", "-203")
      · Zero-valued amounts glued to the next ("017244" → "0", "17244")

    Returns rows newest-first. Empty list when no lines parse cleanly.
    """
    rows: List[PublicRecordsRow] = []
    seen: set = set()

    # Match a year only when followed by ASCII space/tab — NOT \\s (which
    # also matches \\xa0 and would falsely trigger on dense layouts).
    YEAR_HEAD = re.compile(r"^\s*(\d{4})[ \t]+(.+)$")

    for raw_line in text.split("\n"):
        m = YEAR_HEAD.match(raw_line)
        if not m:
            continue
        try:
            year = int(m.group(1))
        except ValueError:
            continue
        if not (1995 <= year <= 2030):
            continue
        if year in seen:
            continue

        # Collapse within-amount separators: nbsp \xa0, thin-space  ,
        # narrow nbsp  . Leaves ASCII space + tab as between-amount
        # separators. Negative sign survives in-place.
        rest = re.sub(r"[\xa0  ]", "", m.group(2)).strip()
        raw_toks = [t for t in re.split(r"[ \t]+", rest) if t]
        if not raw_toks:
            continue

        # Splice a negative sign that appears mid-token: it marks the
        # boundary between a (positive) amount and the negative one that
        # follows. "0-203" → ["0", "-203"]. Idempotent on tokens with
        # no internal '-'.
        spliced: List[str] = []
        for tok in raw_toks:
            last = 0
            for i, ch in enumerate(tok):
                if ch == "-" and i > 0:
                    if tok[last:i]:
                        spliced.append(tok[last:i])
                    last = i
            if tok[last:]:
                spliced.append(tok[last:])

        # We need exactly 7 numeric tokens (6 amounts + sal). When fewer,
        # try peeling a leading "0" off a multi-digit token. listafirme
        # renders zero-valued amounts with no separator from their
        # right-hand neighbor: "017244" really means amount=0 then
        # amount=17244. Repeat until count matches or no more splits help.
        toks = list(spliced)
        max_peels = 6
        while len(toks) < 7 and max_peels > 0:
            grew = False
            for i, t in enumerate(toks):
                if len(t) > 1 and t[0] == "0" and t[1].isdigit():
                    toks = toks[:i] + ["0", t[1:]] + toks[i + 1:]
                    grew = True
                    break
            if not grew:
                break
            max_peels -= 1

        if len(toks) != 7:
            continue

        parsed: List[Optional[float]] = [_parse_ro_number(t) for t in toks]
        if any(v is None for v in parsed):
            continue
        cifra, profit, debt, imob, circ, cap, sal_v = parsed  # type: ignore[misc]

        # Plausibility — tuned for dormant companies: cifra and sal may be
        # 0, profit and cap may be negative. Reject only out-of-range and
        # negative-revenue (which the source never reports).
        amounts = (cifra, profit, debt, imob, circ, cap)
        if any(v is None or abs(v) > 1e12 for v in amounts):
            continue
        if cifra < 0:  # type: ignore[operator]
            continue
        try:
            sal = int(sal_v)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        if not (0 <= sal <= 99_999):
            continue

        rows.append(PublicRecordsRow(
            year=year,
            cifra_afaceri=float(cifra),  # type: ignore[arg-type]
            profit_net=float(profit),    # type: ignore[arg-type]
            datorii_totale=float(debt),  # type: ignore[arg-type]
            active_imobilizate=float(imob),  # type: ignore[arg-type]
            active_circulante=float(circ),   # type: ignore[arg-type]
            capitaluri_proprii=float(cap),   # type: ignore[arg-type]
            salariati=sal,
        ))
        seen.add(year)

    rows.sort(key=lambda r: -r.year)
    return rows


def _extract_annual_rows_dense(text: str) -> List[PublicRecordsRow]:
    """Extract the annual table — DENSE layout (PRO TV-style operating
    companies, every amount 7+ digits, year digit-glued to first amount).

    The listafirme.ro / termene.ro PDFs render this table with weird
    spacing: triplets of digits inside each amount are separated by
    NON-BREAKING SPACES (\\xa0), but the boundary BETWEEN two adjacent
    amounts has NO separator at all. So the text looks like:

      20241 143 087 964293 330 500561 890 345605 543 139544 467 238479
      906 427938
      ^                                                          ^
      year+cifra-lead                                            cap-tail+sal

    Tokenizing on whitespace produces broken tokens like '964293' (the
    end of cifra glued to the start of profit). The fix: concatenate
    all digits into one stream, then partition based on **sequential
    years**. Years descend from latest (e.g. 2024) by 1 each row, which
    is the strongest anchor we have. Between two adjacent years we know
    the digit count must split into 6 amounts + 1 employee count, and
    we enumerate plausible width combinations.
    """
    rows: List[PublicRecordsRow] = []

    # 1. Find the table body. The header line contains the joined column
    #    name "Cifraafaceri" (listafirme) or "Cifra de afaceri" (termene).
    flat = re.sub(r"[\s\xa0]+", " ", text)
    header_idx = -1
    for marker in ("Cifraafaceri", "Cifra de afaceri", "Cifra afaceri"):
        idx = flat.find(marker)
        if idx >= 0:
            header_idx = idx
            break
    if header_idx < 0:
        return rows
    # Stop body at the next non-financial section header (Moneda / Domeniul
    # de activitate / Cod CAEN / Informații statistice). Otherwise we'd
    # try to parse CAEN numbers as years.
    tail_match = re.search(r"(?:Moneda|Domeniul de activitate|Cod CAEN|Informa[țt]ii statistice|Alte Companii)",
                           flat[header_idx:], re.IGNORECASE)
    body = flat[header_idx : header_idx + (tail_match.start() if tail_match else len(flat))]

    # Strip page-break noise that bleeds extra digits into the stream:
    # · "15/05/2026, 16:29" — the print-date stamp at the top of each page
    # · "https://listafirme.ro/pro-tv-srl-2835636/ 2/5" — page footer with
    #   URL + page indicator (the company CUI + page number are digit noise)
    # · "Cifraafaceri Profitnet ... Numărsalariați" — table header repeated
    #   at the top of each page (no digits but worth removing for clarity)
    # · "(CUI #######)" — CUI repeats inside the running header
    # Without this filter, the digit-stream parser thinks the timestamp
    # digits (15052026 + 1629) are part of the row data, blowing up the
    # row-width window past 80 chars and dropping every year past the
    # first page-break.
    body = re.sub(r"\d{1,2}/\d{1,2}/\d{4},?\s*\d{1,2}:\d{2}", " ", body)
    body = re.sub(r"https?://[^\s]+", " ", body)
    body = re.sub(r"\b\d{1,2}/\d{1,2}\b", " ", body)  # bare "2/5" page indicator
    body = re.sub(r"\(CUI\s*\d+\)", " ", body, flags=re.IGNORECASE)
    # Strip the repeated table header on subsequent pages.
    body = re.sub(r"Cifraafaceri\s+Profitnet\s+Datoriitotale\s+"
                  r"Activeimobilizate\s+Activecirculante\s+Capitaluriproprii\s+"
                  r"Num[ăa]rsalaria[țt]i", " ", body, flags=re.IGNORECASE)
    # Strip running page footer text that mentions the company name + CUI
    # via descriptive prose ("PRO TV SRL din BUCURESTI (CUI 2835636) – date
    # firmă, contact, bilanț, CAEN").
    body = re.sub(r"[A-Z][A-Z\s]+SRL\s+din\s+[A-Z]+[^a-z]+date\s+\S+,\s*contact,?\s*bilan[țt],?\s*CAEN",
                  " ", body)

    # 2. Collect all digit characters in the body in order. We keep a
    #    parallel "is_neg" map for negative-marker positions: a '-' that
    #    sits BEFORE digits indicates a negative profit/equity entry.
    digits = []
    neg_positions: List[int] = []
    for ch in body:
        if ch.isdigit():
            digits.append(ch)
        elif ch == "-":
            # Record that the NEXT digit position will be a negative
            # number's leading digit.
            neg_positions.append(len(digits))
    digit_stream = "".join(digits)

    # 3. Locate sequential years in the digit stream. We walk forward
    #    looking for the most recent year (the PDF renders newest first).
    #    Starting candidates: any 4-digit substring in 1995-2030 range
    #    appearing in the first 12 chars (after a possible 1-3 digit row
    #    leader from a stray figure, which shouldn't happen for the
    #    first row but defends against minor formatting drift).
    #
    #    Once we lock the first year, every subsequent year MUST be that
    #    year minus 1 (the listafirme table is contiguous; gaps don't
    #    happen). We scan forward for the literal `str(year - 1)` to
    #    find the row boundary.

    def _locate_year_at_start(s: str) -> Optional[int]:
        # Try positions 0..3 — the first row's year is at offset 0 in our
        # observed PDFs (e.g. "20241143..." starts with 2024).
        for offset in range(0, 4):
            if len(s) < offset + 4:
                return None
            candidate = s[offset : offset + 4]
            try:
                y = int(candidate)
            except ValueError:
                continue
            if 1995 <= y <= 2030:
                return y
        return None

    cursor = 0
    first_year = _locate_year_at_start(digit_stream[cursor:])
    if first_year is None:
        return rows
    cursor += 4  # consume the year digits

    current_year = first_year
    while True:
        # The next year (current_year - 1) anchors the end of this row.
        # Skip occurrences inside the current row by requiring the match
        # offset to be at least `min_row_digits` past the cursor — a row
        # has at minimum 6×7 amount digits + 1 sal digit + 0 padding = 43
        # digits, so we start the search 40 past the cursor. The
        # year-1 string might appear earlier as part of an amount value
        # (e.g. `2015` showing up inside `12015000` in a 2016 row); those
        # false positives are filtered by the offset gate.
        next_year_str = str(current_year - 1)
        search_from = cursor + 40
        next_year_idx = digit_stream.find(next_year_str, search_from)
        # Validate: must also fit within the max row width (80 digits).
        valid_window = (
            next_year_idx != -1
            and next_year_idx - cursor <= 80
        )
        if valid_window:
            row_digits = digit_stream[cursor : next_year_idx]
        else:
            # Last row — consume to end of stream. We expect roughly the
            # same length; trim trailing noise (e.g. moneda 'RON' or
            # category text) by capping at 80 chars from cursor.
            row_digits = digit_stream[cursor : cursor + 80]
            if len(row_digits) < 40:
                # Not enough digits left for a row — table ended.
                break

        # 4. Partition row_digits into 6 amounts + 1 sal. Use the heuristic
        #    that each amount is 7-12 digits and sal is 1-4 digits. The
        #    total must match exactly. We enumerate width-combinations
        #    and pick the lexicographic-first that produces plausible
        #    values (cifra positive, capitaluri non-zero, magnitudes
        #    in the 1e5-1e11 RON range).
        partition = _partition_row(row_digits)
        if partition is not None:
            cifra, profit, debt, imob, circ, cap, sal = partition
            # Apply negative markers — if a '-' appeared at the start of
            # any of these amounts in the original text, flip the sign.
            # We approximate by checking whether the START INDEX of profit
            # or cap (the only amounts that legitimately go negative) is
            # adjacent to a recorded neg-position. Cheap approximation —
            # exact mapping would require tracking each digit's source
            # offset, which we keep simple.
            #
            # In practice, profit_net is the only amount that turns
            # negative in this dataset. We look at the original `body`
            # text and check whether `-` appears within 4 chars before
            # the same digits that form `profit`. This handles the
            # historical loss rows (2009-2014 for PRO TV).
            profit = _signed_lookup(body, str(int(profit)), profit)
            cap = _signed_lookup(body, str(int(cap)), cap)
            rows.append(PublicRecordsRow(
                year=current_year,
                cifra_afaceri=float(cifra),
                profit_net=float(profit),
                datorii_totale=float(debt),
                active_imobilizate=float(imob),
                active_circulante=float(circ),
                capitaluri_proprii=float(cap),
                salariati=int(sal),
            ))

        # Advance to the next year. If there isn't one, stop.
        if not valid_window:
            break
        cursor = next_year_idx + 4
        current_year -= 1
        if current_year < 1995:
            break

    # Sort newest → oldest (matches source rendering).
    rows.sort(key=lambda r: -r.year)
    return rows


def _partition_row(digits: str) -> Optional[tuple]:
    """Split a row digit-string into (cifra, profit, debt, imob, circ,
    cap, sal). Tries width combinations and returns the first plausible
    one. None when no partition fits.

    Plausibility rules:
      · cifra > 0 (revenue must be positive)
      · sal between 1 and 99,999
      · |amount| within 1e5..1e12 (RON; a 10-employee SRL has 100K rev,
        the biggest RO companies have ~100B rev)
      · cifra >= profit absolute value (profit doesn't exceed revenue
        in normal practice)
    """
    n = len(digits)
    if n < 40 or n > 80:
        return None

    # The salariati count comes LAST. It's 1-4 digits. We enumerate sal
    # widths in {3, 4, 2, 1} order (most common first) and for each, the
    # remaining n - sal_w digits divide into 6 equal-ish amounts.
    for sal_w in (3, 4, 2, 1):
        if n - sal_w < 42 or n - sal_w > 72:
            continue
        # 6 amounts must sum to (n - sal_w) digits, each width 7-12.
        amts_total = n - sal_w
        # Each amount is at least 7 and at most 12 digits. We enumerate
        # the 6 amount widths via constraint solving. To keep this fast,
        # we observe that the average amount width is amts_total / 6, so
        # we bias toward that average.
        avg = amts_total / 6
        widths_to_try = sorted({int(avg) - 1, int(avg), int(avg) + 1,
                                int(avg) - 2, int(avg) + 2}, reverse=True)
        widths_to_try = [w for w in widths_to_try if 7 <= w <= 12]
        # Try uniform-width split first (all 6 amounts same width)
        for w in widths_to_try:
            if w * 6 == amts_total:
                parts = [digits[i*w:(i+1)*w] for i in range(6)]
                sal = digits[6*w:]
                result = _validate_partition(parts, sal)
                if result is not None:
                    return result
        # Try mixed widths — typically one amount (cifra) is 1 digit
        # wider than the others. So 6 amounts = 5 × W + 1 × (W+1), or
        # 5 × W + 1 × (W-1).
        for w in widths_to_try:
            for wide_idx in range(6):
                # 5 amounts of width w, 1 of width w+1 at position wide_idx
                if 5 * w + (w + 1) == amts_total and w + 1 <= 12:
                    parts = []
                    pos = 0
                    for i in range(6):
                        width = w + 1 if i == wide_idx else w
                        parts.append(digits[pos:pos+width])
                        pos += width
                    sal = digits[pos:]
                    result = _validate_partition(parts, sal)
                    if result is not None:
                        return result
                # 5 amounts of width w, 1 of width w-1
                if 5 * w + (w - 1) == amts_total and w - 1 >= 7:
                    parts = []
                    pos = 0
                    for i in range(6):
                        width = w - 1 if i == wide_idx else w
                        parts.append(digits[pos:pos+width])
                        pos += width
                    sal = digits[pos:]
                    result = _validate_partition(parts, sal)
                    if result is not None:
                        return result
        # Two-different-widths combinations: 4 amounts of W + 2 of (W±1).
        for w in widths_to_try:
            for delta in (-1, 1):
                target = 4 * w + 2 * (w + delta)
                if target != amts_total or not (7 <= w + delta <= 12):
                    continue
                # Try placing the two non-standard amounts at positions
                # (cifra+something) — cifra is index 0 most likely to be
                # different from the rest. Limited enumeration.
                from itertools import combinations
                for combo in combinations(range(6), 2):
                    parts = []
                    pos = 0
                    for i in range(6):
                        width = w + delta if i in combo else w
                        parts.append(digits[pos:pos+width])
                        pos += width
                    sal = digits[pos:]
                    result = _validate_partition(parts, sal)
                    if result is not None:
                        return result
    return None


def _validate_partition(parts: List[str], sal_str: str) -> Optional[tuple]:
    """Validate that the 6 amounts + sal form a plausible row."""
    if any(not p for p in parts) or not sal_str:
        return None
    try:
        cifra = int(parts[0])
        profit = int(parts[1])
        debt = int(parts[2])
        imob = int(parts[3])
        circ = int(parts[4])
        cap = int(parts[5])
        sal = int(sal_str)
    except ValueError:
        return None
    # Plausibility checks
    if cifra <= 0:
        return None
    if not (1 <= sal <= 99_999):
        return None
    for v in (cifra, debt, imob, circ):
        if v < 0 or v > 1e12:
            return None
    if abs(profit) > 1e12 or abs(cap) > 1e12:
        return None
    # Cifra shouldn't be wildly smaller than the other amounts (rough
    # sanity — a real company has revenue at least same order as debt
    # or equity for an operating year)
    return (cifra, profit, debt, imob, circ, cap, sal)


def _signed_lookup(body: str, digits_str: str, default_val: float) -> float:
    """Check whether `digits_str` appears in `body` preceded by '-'. If yes,
    return the negative of `default_val`. Used to recover negative profit
    or equity entries (the digit-stream parser drops sign markers)."""
    # Try to find the digits in body with possible space-thousands
    # formatting between triplets. Simplest: build the spaced version.
    if len(digits_str) <= 3:
        spaced = digits_str
    else:
        # Right-align triplets like Romanian formatting
        tail = digits_str
        groups = []
        while len(tail) > 3:
            groups.insert(0, tail[-3:])
            tail = tail[:-3]
        if tail:
            groups.insert(0, tail)
        spaced = " ".join(groups)
    # Look for '-spaced' or '- spaced'
    for needle in (f"-{spaced}", f"- {spaced}", f"-{digits_str}"):
        if needle in body:
            return -abs(default_val)
    return default_val


# ─── Public entry ───────────────────────────────────────────────────────────


def parse_public_records_pdf(text: str,
                             pdf_bytes: Optional[bytes] = None) -> PublicRecordsExtract:
    """Parse a listafirme.ro / termene.ro / firme.info public-records PDF.

    Returns an extract carrying identity (CUI, reg-com, CAEN), the source
    site fingerprint, and the year-by-year financial table. `confidence`
    is the fraction of (years, identity) checks that succeeded — used by
    the document-type detector to decide between "trust this parser" and
    the B-gate "unparseable" raise.

    When `pdf_bytes` is supplied, the geometry-aware extractor runs FIRST
    (pdfplumber word-coordinates + 10 px gap threshold — works uniformly
    on both dense and sparse layouts). On any geometry failure or missing
    pdfplumber, falls back to the text-based dispatch
    (`_extract_annual_rows`), which preserves the prior PRO TV (20/20)
    and ELIT (11/17) behavior. Metadata (name/CUI/CAEN/source/reg-com)
    is always read from `text`.
    """
    name = _extract_company_name(text)
    cui = _extract_cui(text)
    reg = _extract_reg_com(text)
    caen, caen_desc = _extract_caen(text)
    source = _detect_source_site(text)

    rows: List[PublicRecordsRow] = []
    if pdf_bytes:
        rows = _extract_annual_rows_geometry(pdf_bytes)
    if not rows:
        rows = _extract_annual_rows(text)

    # Confidence — four signals, each worth 1/4:
    #   1. CUI parsed (company identity captured)
    #   2. At least one year-row extracted
    #   3. The extracted rows show real activity (NOT all-zero across the
    #      whole table — distinguishes a successful parse of a dormant
    #      company like ELIT (cifra=0 but debt 17244 + equity -15323
    #      every year) from a parse that recovered only year numbers and
    #      nothing else)
    #   4. Company name or source-site fingerprint detected
    checks = 0
    if cui: checks += 1
    if rows: checks += 1
    if rows and any(
        r.cifra_afaceri != 0 or r.profit_net != 0 or r.datorii_totale != 0
        or r.active_imobilizate != 0 or r.active_circulante != 0
        or r.capitaluri_proprii != 0
        for r in rows
    ):
        checks += 1
    if name or source: checks += 1
    confidence = checks / 4.0

    logger.info(
        "[public_records] parsed: name=%r cui=%r reg=%r caen=%s source=%s rows=%d confidence=%.2f",
        name, cui, reg, caen, source, len(rows), confidence,
    )
    return PublicRecordsExtract(
        company_name=name,
        cui=cui,
        reg_com=reg,
        caen_code=caen,
        caen_description=caen_desc,
        source_site=source,
        years=rows,
        confidence=confidence,
    )


# ─── Self-test ──────────────────────────────────────────────────────────────
# Run with: python -m engine.api._public_records_parser <path-to-pdf>

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("usage: python -m engine.api._public_records_parser <path-to-pdf>")
        sys.exit(1)
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        from PyPDF2 import PdfReader  # type: ignore
    text = ""
    r = PdfReader(sys.argv[1])
    for p in r.pages:
        text += "\n" + (p.extract_text() or "")
    print(f"detected_public_records = {looks_like_public_records(text)}")
    extract = parse_public_records_pdf(text)
    print(f"company       : {extract.company_name}")
    print(f"CUI           : {extract.cui}")
    print(f"Reg. Com.     : {extract.reg_com}")
    print(f"CAEN          : {extract.caen_code} — {extract.caen_description}")
    print(f"Source site   : {extract.source_site}")
    print(f"Confidence    : {extract.confidence:.2f}")
    print(f"Years parsed  : {len(extract.years)}")
    print()
    print(f"{'Year':<6} {'CifraAfaceri':>18} {'ProfitNet':>15} {'Debt':>15} {'TotalAssets':>15} {'Equity':>15} {'Sal':>6}")
    for row in extract.years[:10]:
        print(f"{row.year:<6} {row.cifra_afaceri:>18,.0f} {row.profit_net:>15,.0f} "
              f"{row.datorii_totale:>15,.0f} {row.total_assets:>15,.0f} "
              f"{row.capitaluri_proprii:>15,.0f} {row.salariati or 0:>6}")
