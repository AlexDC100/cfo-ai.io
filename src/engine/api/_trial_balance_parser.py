"""Deterministic Romanian trial-balance parser.

Replaces the "let Claude figure it out from raw TSV" path for known
trial-balance shapes. Handles:

  - SAGA (4-digit account codes, single-block layout)
  - Crystal Reports / SAP exports (6-digit codes, paired Debit/Credit
    columns with no explicit Solduri-Initiale/Finale labels)
  - CIEL / WinMentor (typical Romanian column ordering)
  - Generic pasted text from Excel (auto-delimiter)

When this parser succeeds, the orchestrator skips the Claude extraction
step and feeds the structured rows directly to the mapping stage. When
detection fails (non-standard layout, P&L, balance sheet), the caller
falls back to the Claude-based extraction.

The module is deliberately stateless and side-effect-free so the FastAPI
endpoint can call it on raw bytes / text without touching Supabase.
"""

from __future__ import annotations

import csv
import io
import logging
import re
from dataclasses import dataclass
from typing import Dict, List, Optional

import pandas as pd  # type: ignore


logger = logging.getLogger(__name__)


# ─── Errors ─────────────────────────────────────────────────────────────────


class ParseError(Exception):
    """Raised when a file can't be parsed. Carries both a user-facing
    message (rendered as a toast) and a technical detail (logged server-
    side, never shown to end users)."""

    def __init__(self, user_message: str, technical_detail: str = ""):
        self.user_message = user_message
        self.technical_detail = technical_detail
        super().__init__(user_message)


# ─── Format detection (magic bytes, not extension) ──────────────────────────


def detect_excel_format(file_bytes: bytes) -> str:
    """Returns 'xlsx', 'xls', or raises ValueError. Filename extensions
    lie; the first 8 bytes don't."""
    if len(file_bytes) < 8:
        raise ValueError("File too small to be a valid Excel file")
    if file_bytes[:4] == b"PK\x03\x04":
        return "xlsx"
    if file_bytes[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        return "xls"
    raise ValueError(
        f"File is neither .xlsx nor .xls. First bytes: {file_bytes[:8].hex()}."
    )


def read_excel_robust(file_bytes: bytes, filename: str = "") -> pd.DataFrame:
    """Reads either .xls or .xlsx into a header-less, all-string DataFrame.
    Headers are parsed downstream by `detect_trial_balance_structure` so we
    can tolerate banner rows and merged-cell artefacts."""
    try:
        fmt = detect_excel_format(file_bytes)
    except ValueError as e:
        raise ParseError(
            user_message=(
                "We couldn't read this file. It doesn't look like a valid Excel "
                "workbook. If it's a PDF, please use the upload-PDF flow."
            ),
            technical_detail=str(e),
        )

    engine = "openpyxl" if fmt == "xlsx" else "xlrd"
    try:
        df = pd.read_excel(
            io.BytesIO(file_bytes),
            engine=engine,
            sheet_name=0,
            header=None,
            dtype=str,
        )
    except Exception as e:  # noqa: BLE001
        raise ParseError(
            user_message=(
                "Couldn't read this Excel file. It may be corrupted, "
                "password-protected, or in an unsupported sub-format. Try "
                "re-saving in Excel and re-uploading."
            ),
            technical_detail=f"{type(e).__name__}: {e} (engine={engine}, name={filename})",
        )

    if df.empty:
        raise ParseError(
            user_message="The Excel file is empty or has no readable sheets.",
            technical_detail="DataFrame returned empty after read",
        )
    return df


# ─── Column-header pattern catalogue ────────────────────────────────────────
# Romanian trial balances drift between dialects. The pattern list below
# captures the wording variants we've actually seen in customer files.

COLUMN_PATTERNS: Dict[str, List[str]] = {
    "account_code": [
        r"\bcont(?!\w)",       # 'Cont' alone (not 'Continuare')
        r"symbol\s*cont",
        r"cod\s*cont",
        r"account\s*code",
    ],
    "account_name": [
        r"(?:nume\s+)?cont(?:ul)?",  # 'Nume Cont' / 'Contul'
        r"denumire",
        r"description",
        r"account\s*name",
    ],
    "initial_debit": [
        r"sold(?:uri)?\s*ini[tț]ial.*debit",
        r"initial.*debit",
        r"^debit.*ini",
    ],
    "initial_credit": [
        r"sold(?:uri)?\s*ini[tț]ial.*credit",
        r"initial.*credit",
        r"^credit.*ini",
    ],
    "period_debit": [r"rulaj.*debit", r"rulaj.*lun.*debit", r"period.*debit", r"mov.*debit"],
    "period_credit": [r"rulaj.*credit", r"rulaj.*lun.*credit", r"period.*credit", r"mov.*credit"],
    "cumulative_debit": [r"(?:sume\s*)?(?:total|cumul).*debit", r"cumulative.*debit"],
    "cumulative_credit": [r"(?:sume\s*)?(?:total|cumul).*credit", r"cumulative.*credit"],
    "final_debit": [
        r"sold(?:uri)?\s*final.*debit",
        r"final.*debit",
        r"closing.*debit",
    ],
    "final_credit": [
        r"sold(?:uri)?\s*final.*credit",
        r"final.*credit",
        r"closing.*credit",
    ],
}


@dataclass
class TbStructure:
    header_row_index: int
    data_start_index: int
    data_end_index: int
    columns: Dict[str, int]
    has_totals_row: bool


def detect_trial_balance_structure(df: pd.DataFrame) -> TbStructure:
    """Find the header row + map each semantic column (account code, name,
    paired debit/credit blocks) to its DataFrame column index.

    Two passes:
      1. Look for unique semantic labels (account_code, account_name).
      2. Pair up bare 'Debit' / 'Credit' columns in order — Crystal Reports
         emits four such pairs (initial / period / cumulative / final)
         without explicit labels.
    """
    header_idx = _find_header_row(df)
    if header_idx is None:
        raise ParseError(
            user_message=(
                "Couldn't find the column headers in this file. Expected "
                "columns like 'Cont', 'Nume Cont', 'Debit', 'Credit'."
            ),
            technical_detail="Header detection failed across all candidate rows",
        )

    headers = [str(x).strip().lower() if pd.notna(x) else "" for x in df.iloc[header_idx]]
    column_map: Dict[str, int] = {}
    used_indices: set[int] = set()

    # Pass 1 — explicit semantic columns
    for semantic_name in ("account_code", "account_name"):
        for col_idx, header in enumerate(headers):
            if col_idx in used_indices:
                continue
            if any(
                re.search(pat, header, re.IGNORECASE) for pat in COLUMN_PATTERNS[semantic_name]
            ):
                column_map[semantic_name] = col_idx
                used_indices.add(col_idx)
                break

    # Pass 2 — paired Debit/Credit columns (positional pairing).
    # Crystal Reports / Scandia-style layout: headers are bare
    # 'Debit' 'Credit' × 4 pairs (initial / period / cumulative / final).
    # SAGA-style layout: headers are 'Debitoare' 'Creditoare' × 3 pairs
    # (initial / period / cumulative — no `final` block).
    # We pair them in order; the missing-final case is tolerated by
    # the validation below (`cumulative` is the column the engine math
    # actually consumes; `final` is just used as a Layout-A sanity rail).
    def _classify(h: str) -> Optional[str]:
        # Accept both Romanian variants and the EN form. Stem on the
        # longer word so 'debitoare' matches 'debit' but 'debit' alone
        # doesn't accidentally claim 'credit'-like headers.
        s = h.strip().lower()
        if s in ("debit", "debitoare"):  return "debit"
        if s in ("credit", "creditoare"): return "credit"
        return None

    debit_credit_cols: List[tuple[int, str]] = []
    for col_idx, header in enumerate(headers):
        if col_idx in used_indices:
            continue
        kind = _classify(header)
        if kind is not None:
            debit_credit_cols.append((col_idx, kind))

    pair_names = ["initial", "period", "cumulative", "final"]
    pair_idx = 0
    i = 0
    while i < len(debit_credit_cols) - 1 and pair_idx < len(pair_names):
        d_col, d_type = debit_credit_cols[i]
        c_col, c_type = debit_credit_cols[i + 1]
        if d_type == "debit" and c_type == "credit":
            # Only set the pair if it's not already filled by Pass 3 below.
            column_map.setdefault(f"{pair_names[pair_idx]}_debit", d_col)
            column_map.setdefault(f"{pair_names[pair_idx]}_credit", c_col)
            pair_idx += 1
            i += 2
        else:
            i += 1

    # Pass 3 — explicit-label pattern matches (Solduri Initiale Debit, etc.)
    # These take precedence over the positional pairing — overwrite if found.
    for semantic_name in (
        "initial_debit", "initial_credit",
        "period_debit", "period_credit",
        "cumulative_debit", "cumulative_credit",
        "final_debit", "final_credit",
    ):
        for col_idx, header in enumerate(headers):
            if col_idx in column_map.values() and column_map.get(semantic_name) != col_idx:
                # Don't steal a column already mapped to something else.
                if col_idx in (column_map.get("account_code"), column_map.get("account_name")):
                    continue
            if any(
                re.search(pat, header, re.IGNORECASE) for pat in COLUMN_PATTERNS[semantic_name]
            ):
                column_map[semantic_name] = col_idx
                break

    # Validate the essentials.
    # Layout A (8-col / Scandia / Crystal Reports) has all four block
    # pairs incl. final closing balances. Layout B (6-col / SAGA / EEI)
    # ends at cumulative (Sume totale) — there's no Solduri finale block.
    # The engine math reads from CUMULATIVE (`st_d`/`st_c` in the row
    # dict, mapped from `cumulative_debit`/`cumulative_credit`); the
    # final block is only used as a Layout-A sanity-rail when present.
    # So accept any file that has account_code + account_name + at
    # least ONE total-pair (cumulative OR final). Conservative-fail
    # if neither is present — never fall through to math on partial data.
    required_always = ("account_code", "account_name")
    missing = [r for r in required_always if r not in column_map]
    if missing:
        raise ParseError(
            user_message=(
                f"Couldn't identify these columns: {', '.join(missing)}. "
                "Compare this file to the downloadable example trial balance "
                "and match the column structure (Cont, Nume Cont/Denumirea "
                "contului, plus Debit/Credit or Debitoare/Creditoare columns)."
            ),
            technical_detail=f"headers={headers}, mapped={column_map}",
        )
    has_cumulative = "cumulative_debit" in column_map and "cumulative_credit" in column_map
    has_final      = "final_debit"      in column_map and "final_credit"      in column_map
    if not (has_cumulative or has_final):
        raise ParseError(
            user_message=(
                "Couldn't find a 'Sume totale' / total-sums column pair (or "
                "a closing-balance pair). This file's structure wasn't "
                "recognized as a supported trial balance — compare it to "
                "the downloadable example."
            ),
            technical_detail=f"headers={headers}, mapped={column_map}",
        )

    data_start = header_idx + 1
    data_end = _find_data_end(df, data_start, column_map["account_code"])
    has_totals_row = data_end < len(df)

    return TbStructure(
        header_row_index=header_idx,
        data_start_index=data_start,
        data_end_index=data_end,
        columns=column_map,
        has_totals_row=has_totals_row,
    )


def _find_header_row(df: pd.DataFrame, max_search: int = 20) -> Optional[int]:
    """Header row contains both an account-code label and the words
    'debit'+'credit' somewhere on the same line."""
    limit = min(max_search, len(df))
    for i in range(limit):
        cells = [str(x).lower() for x in df.iloc[i] if pd.notna(x)]
        row_text = " ".join(cells)
        has_cont = bool(re.search(r"\bcont\b", row_text))
        has_debit = "debit" in row_text
        has_credit = "credit" in row_text
        if has_cont and has_debit and has_credit:
            return i
    return None


def _find_data_end(df: pd.DataFrame, data_start: int, account_code_col: int) -> int:
    """Return exclusive end index of the data block — stops before the
    totals row (which has empty Cont but populated number columns)."""
    last_data_row = data_start
    for i in range(data_start, len(df)):
        code = df.iloc[i, account_code_col]
        if pd.notna(code) and str(code).strip() and not _is_totals_row(df.iloc[i], account_code_col):
            last_data_row = i + 1
    return last_data_row


def _is_totals_row(row: pd.Series, account_code_col: int) -> bool:
    code = row.iloc[account_code_col]
    return pd.isna(code) or str(code).strip() == ""


# ─── Row → typed account dict ───────────────────────────────────────────────


def parse_trial_balance_df(df: pd.DataFrame, structure: TbStructure) -> List[Dict]:
    """Convert the detected trial-balance frame into typed account dicts.

    Output schema (compatible with the rest of the pipeline's expectations):
        {
            'cont': str,             # account code, e.g. '101201'
            'nume_cont': str,        # account name
            'si_d': float,           # sold initial debit
            'si_c': float,           # sold initial credit
            'r_d':  float,           # rulaj perioada debit
            'r_c':  float,           # rulaj perioada credit
            'st_d': float,           # sume totale (cumulative) debit
            'st_c': float,           # sume totale (cumulative) credit
            'sf_d': float,           # sold final debit
            'sf_c': float,           # sold final credit
        }

    Filters out: rows with empty Cont, non-numeric account codes (banner
    rows from Crystal Reports), and the totals row at the bottom.
    """
    accounts: List[Dict] = []
    cols = structure.columns

    def col_or_zero(row: pd.Series, key: str) -> float:
        idx = cols.get(key)
        if idx is None:
            return 0.0
        return _to_number(row.iloc[idx])

    # SAGA 6-col Layout B has no `Solduri finale` block; only cumulative
    # (`Sume totale`) columns are present. The BS aggregation downstream
    # reads sf_d/sf_c exclusively (see _build_accounts_from_tb in this
    # file, lines ~689/695). Without final columns, every BS account
    # collapses to amount=0 and is silently dropped. Synthesize the
    # closing balance from the accounting identity
    #     net = (si_d + r_d) - (si_c + r_c)
    # and land it on whichever side carries the natural balance. The
    # 8-col path (Crystal Reports) leaves sf_d/sf_c on the recorded
    # values — the synthesis only fires when final_* columns are absent.
    has_final_cols = "final_debit" in cols and "final_credit" in cols

    for i in range(structure.data_start_index, structure.data_end_index):
        row = df.iloc[i]
        code_raw = row.iloc[cols["account_code"]]
        if pd.isna(code_raw):
            continue
        code = str(code_raw).strip()
        if not code or code.lower() == "nan":
            continue
        # Account codes are always pure digits (3-6). Drop banner / footer
        # rows that Crystal Reports sometimes interleaves.
        if not re.match(r"^\d{3,8}$", code):
            continue

        name = ""
        name_raw = row.iloc[cols["account_name"]] if cols.get("account_name") is not None else None
        if pd.notna(name_raw):
            name = str(name_raw).strip()

        si_d = col_or_zero(row, "initial_debit")
        si_c = col_or_zero(row, "initial_credit")
        r_d  = col_or_zero(row, "period_debit")
        r_c  = col_or_zero(row, "period_credit")
        st_d = col_or_zero(row, "cumulative_debit")
        st_c = col_or_zero(row, "cumulative_credit")
        sf_d = col_or_zero(row, "final_debit")
        sf_c = col_or_zero(row, "final_credit")

        if not has_final_cols:
            net = (si_d + r_d) - (si_c + r_c)
            if net >= 0:
                sf_d, sf_c = net, 0.0
            else:
                sf_d, sf_c = 0.0, -net

        accounts.append(
            {
                "cont": code,
                "nume_cont": name,
                "si_d": si_d,
                "si_c": si_c,
                "r_d": r_d,
                "r_c": r_c,
                "st_d": st_d,
                "st_c": st_c,
                "sf_d": sf_d,
                "sf_c": sf_c,
            }
        )
    return accounts


def _to_number(value) -> float:
    """Locale-tolerant cell-to-float conversion.

    Handles:
      - '1.234,56'    (Romanian: dot=thousands, comma=decimal) → 1234.56
      - '1,234.56'    (English: comma=thousands, dot=decimal)  → 1234.56
      - '1234.56'     (Crystal Reports clean)                  → 1234.56
      - '1,56'        (Romanian short)                         → 1.56
      - '3 980 157,61'    (SAGA: space-thousands, comma decimal) → 3980157.61
      - '3\xa0980\xa0157.61' (SAGA nbsp variant)               → 3980157.61
      - '(1,234.56)'  (parenthesized negative)                 → -1234.56
      - NaN / None / '-' / '' / 'nan'                          → 0.0

    Note: this helper is used ONLY by the trial-balance parser. The
    public-records parser (_public_records_parser.py) has its own
    `_parse_ro_number`; changes here cannot regress Bug B's behavior.
    """
    if pd.isna(value) or value is None:
        return 0.0
    s = str(value).strip()
    if not s or s.lower() in ("nan", "none", "-", "—"):
        return 0.0

    # Parenthesized negatives, common in accounting reports.
    is_negative = False
    if s.startswith("(") and s.endswith(")"):
        is_negative = True
        s = s[1:-1].strip()
    if s.startswith("-"):
        is_negative = True
        s = s[1:].strip()

    # SAGA / EEI / WinMentor often render thousands as a regular space or
    # non-breaking space (e.g. '3 980 157,61' or '3\xa0980\xa0157.61').
    # Strip both — the only meaningful punctuation left is `,` and `.`,
    # which are disambiguated below by position.
    s = s.replace("\xa0", "").replace(" ", "").replace(" ", "").replace(" ", "")

    if "," in s and "." in s:
        # Both separators present — the rightmost is the decimal.
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        # Only comma — assume Romanian decimal.
        s = s.replace(",", ".")

    try:
        n = float(s)
    except ValueError:
        return 0.0
    return -n if is_negative else n


# ─── Pasted-text path ───────────────────────────────────────────────────────


def parse_pasted_trial_balance(text: str) -> List[Dict]:
    """Parse text pasted from Excel / Word / a CSV. Auto-detects delimiter
    (tab / comma / semicolon / pipe) so the user doesn't have to think
    about format. Reuses the same structure detector + row parser as
    Excel uploads — single source of truth for column mapping."""
    if not text or not text.strip():
        raise ParseError(
            user_message="Paste area is empty. Please paste trial-balance data first.",
            technical_detail="Empty input to parse_pasted_trial_balance",
        )

    sample = text[:2000]
    delimiter = "\t"
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters="\t,;|")
        delimiter = dialect.delimiter
    except csv.Error:
        # Fallback: pick whatever appears most often in the sample.
        counts = {d: sample.count(d) for d in ("\t", ";", ",", "|")}
        delimiter = max(counts, key=counts.get)

    try:
        df = pd.read_csv(
            io.StringIO(text),
            sep=delimiter,
            dtype=str,
            header=None,
            skip_blank_lines=True,
            engine="python",
            quoting=csv.QUOTE_MINIMAL,
        )
    except Exception as e:  # noqa: BLE001
        raise ParseError(
            user_message=(
                "Couldn't parse the pasted text. Make sure you copied from "
                "Excel with columns intact, or export as CSV and use the "
                "file upload instead."
            ),
            technical_detail=f"pandas.read_csv failed: {type(e).__name__}: {e}",
        )

    if df.empty or len(df.columns) < 4:
        raise ParseError(
            user_message=(
                "The pasted data doesn't have enough columns. Expected at "
                "least: account code, account name, debit, credit."
            ),
            technical_detail=f"shape={df.shape}",
        )

    structure = detect_trial_balance_structure(df)
    return parse_trial_balance_df(df, structure)


# ─── Public entry point: bytes → accounts ───────────────────────────────────


def parse_trial_balance_file(file_bytes: bytes, filename: str = "") -> List[Dict]:
    """High-level entry: take raw Excel bytes, return the typed account
    list. Wraps read_excel_robust + detect_trial_balance_structure +
    parse_trial_balance_df. Raises ParseError on any failure."""
    df = read_excel_robust(file_bytes, filename)
    structure = detect_trial_balance_structure(df)
    accounts = parse_trial_balance_df(df, structure)
    if not accounts:
        raise ParseError(
            user_message=(
                "We detected the file format but couldn't find any numeric "
                "account rows. Are you sure this is a trial balance?"
            ),
            technical_detail=f"structure={structure}, df_shape={df.shape}",
        )
    return accounts


def compute_statutory_net_profit_anchor(tb_rows: List[Dict]) -> float:
    """Return account 121's net closing balance (sf_c − sf_d) — the
    LEGALLY FILED net profit on Romanian books.

    Account 121 (PROFIT SI PIERDERE) closes to the year-end statutory net
    profit. The COA mapping routes 121 to `ignore_control` so it's never
    summed elsewhere; the closing balance is the canonical anchor a
    Romanian CFO recognizes from their filings.

    Two distinct values come into play:
      · Reconstructed net profit (= class 7 credit movements minus class 6
        debit movements minus tax): the "build it up" view stage_compute
        produces. Typically lands within ±2% of 121 — the gap is class-65
        provision movements + 781 reversals that don't flow cleanly.
      · Statutory net profit (= this function): the source of truth. The
        platform persists this as `net_income_statutory` so the briefing
        cites the same number the user sees on their account 121 balance.
    """
    total = 0.0
    for r in tb_rows:
        code = (r.get("cont") or "").strip()
        if code.startswith("121"):
            sf_d = float(r.get("sf_d") or 0)
            sf_c = float(r.get("sf_c") or 0)
            total += (sf_c - sf_d)
    return total


# ─── Account list → canonical TSV (for Claude downstream stages) ────────────


def accounts_to_assemble_shape(tb_rows: List[Dict]) -> List[Dict]:
    """Convert deterministic parser output → {code, name, amount} dicts the
    `_ro_coa.assemble_statements` mapper consumes. Skips Claude entirely.

    The amount is signed to match the existing MAPPING_RULES convention:
      · credit-positive buckets (equity, debt, payables, income) →
        `amount = closing_credit − closing_debit` (positive for normal
        accounts; negative for contra accounts like 709 commercial discounts)
      · debit-positive buckets (assets, expenses) →
        `amount = closing_debit − closing_credit` (positive for normal
        accounts; positive for accumulated depreciation 28x because rule
        sign=−1 then subtracts it from ppe)
      · P&L accounts read YTD movement (sume totale), not closing balance.

    Unmapped accounts are skipped (matching Claude path behavior).
    """
    from . import _ro_coa  # lazy to avoid any import-order surprise

    CREDIT_POS_BS = {
        "shareCapital", "otherEquity", "retainedEarnings", "equity_revaluation",
        "retained_earnings", "ltDebt", "stDebt", "ap", "ap_dividends",
        "otherCurrentLiab", "otherNonCurrentLiab",
    }
    DEBIT_POS_BS = {
        "cash", "cash_fx", "ar", "ar_doubtful", "ar_provisions", "ar_intercompany",
        "inventory", "ppe", "ppe_investment", "ppe_under_construction",
        "ppe_advances", "intangibles", "otherCurrentAssets", "otherNonCurrentAssets",
    }
    CREDIT_POS_PL = {
        "revenue", "otherIncome", "inventoryVariationMemo", "financialIncome",
        "financial_income", "interest_income", "fx_gain", "capitalizedOwnWork",
    }
    DEBIT_POS_PL = {
        "cogs", "operatingExpenses", "opex_third_party", "depreciation",
        "interestExpense", "interest_expense", "financialExpense", "fx_loss",
        "taxExpense",
    }

    # ── Side-flip prefixes ──────────────────────────────────────────────
    # These class-4 codes are MIXED-SIDE. The mapping rule encodes the
    # natural debit-side bucket (because that's the textbook usage), but
    # on a given trial balance any one of them might land on the credit
    # side and IS a liability for that period. When sf_c > sf_d we redirect
    # to a liability bucket; the asset bucket only fires when D > C.
    # Without this layer:
    #   - 418 customer accruals on C-side → sat in AR (asset) when they're
    #     actually liabilities, swinging assets by 2× the amount.
    #   - 451/452/455 affiliated balances — the D-side from group-receivable
    #     positions never landed in receivables at all because the rule
    #     hardcoded a single bucket.
    SIDE_FLIP_TO_LIAB_PREFIXES = (
        "418",        # Clienți facturi de întocmit — D=accrued AR, C=customer accrual liab
        "451",        # Decontări afiliate — D=group rec, C=group pay
        "452",        # Decontări participanți — D=rec, C=pay
        "455",        # Asociați conturi curente — D=rec, C=pay
        "461",        # Debitori diverși — D=rec, C=pay (also goes to ar_intercompany)
        "467",        # Datorii întreprinderi asociate — mixed
        "425",        # Avansuri salarii — D=advance to employee (asset), C=overpayment to employer
        "1687",       # Dobânzi de plată (interest accruals) — usually C, occasionally D
    )

    # ── Inventory contra-asset prefixes ─────────────────────────────────
    # 348 (diferențe preț materiale) and 378 (diferențe preț mărfuri) are
    # price-variance accounts that can sit on EITHER side: D-side means
    # actual cost > standard (inventory ↑), C-side means actual < standard
    # (inventory ↓). Use SIGNED amount (sf_d - sf_c) so credit balances
    # naturally subtract. 391-398 inventory provisions are handled via
    # explicit sign=-1 rules in _ro_coa so they don't need this special case.
    INVENTORY_CONTRA_SIGNED_PREFIXES = ("348", "378")

    out: List[Dict] = []
    for r in tb_rows:
        code = (r.get("cont") or "").strip()
        if not code:
            continue
        rule = _ro_coa.bucket_for(code)
        if not rule:
            continue
        bucket = rule.bucket
        sf_d = float(r.get("sf_d") or 0)
        sf_c = float(r.get("sf_c") or 0)
        st_d = float(r.get("st_d") or 0)
        st_c = float(r.get("st_c") or 0)

        # Bucket-override for SIDE_FLIP prefixes when balance is on credit
        # side. We emit a synthetic `bucket_override` so the downstream
        # assemble_statements step routes to the right bucket regardless
        # of what bucket_for(code) returned. The amount is the absolute
        # credit balance and goes into the override bucket as positive
        # (matching the liability-positive convention).
        bucket_override: Optional[str] = None
        if any(code.startswith(p) for p in SIDE_FLIP_TO_LIAB_PREFIXES) and sf_c > sf_d:
            bucket_override = "otherCurrentLiab"
            amount = sf_c - sf_d
            if amount > 0:
                out.append({
                    "code": code,
                    "name": (r.get("nume_cont") or "").strip(),
                    "amount": round(amount, 2),
                    "bucket_override": bucket_override,
                })
            continue

        # Inventory contra (348/378) — use signed amount so credit balances
        # subtract from inventory. Bucket override left None; rule routes
        # to "inventory" already, and the signed amount carries direction.
        if any(code.startswith(p) for p in INVENTORY_CONTRA_SIGNED_PREFIXES):
            amount = sf_d - sf_c
            if amount != 0:
                out.append({
                    "code": code,
                    "name": (r.get("nume_cont") or "").strip(),
                    "amount": round(amount, 2),
                })
            continue

        if bucket in CREDIT_POS_BS:
            # Liabilities/equity: normal balance on credit side. For contra
            # accounts like 129 (Repartizare profit) the balance may be on
            # debit — emit whichever side carries it, the rule's sign field
            # handles direction. (Crystal Reports puts the closing balance
            # on ONE side; the other is zero.)
            amount = sf_c if sf_c != 0 else sf_d
        elif bucket in DEBIT_POS_BS:
            # Assets: normal balance on debit side. For contra-asset accounts
            # (28x accumulated depreciation, 29x impairment, 491 receivables
            # allowance) the balance is on the credit side; their rule has
            # sign=−1 to subtract. Emit whichever side has the value.
            amount = sf_d if sf_d != 0 else sf_c
        elif bucket in CREDIT_POS_PL or bucket in DEBIT_POS_PL:
            # Crystal Reports puts the SAME signed value in both st_d and st_c
            # for class-6/7 accounts (because the year-end closing entry
            # mirrors the natural-side accumulation). SAGA-style puts the
            # movement on one side only. Pick the side with the larger
            # absolute value so both formats work; the sign of that value
            # is the real direction (709 contra-revenue shows as negative).
            amount = st_c if abs(st_c) >= abs(st_d) else st_d
            # SAGA fallback: contra-revenue / contra-expense end up on the
            # "wrong" side. Sign-flip when the bucket's expected direction
            # disagrees with where the value showed up.
            if abs(st_c) < 0.01 and st_d != 0:  # SAGA-only path (one side zero)
                if bucket in CREDIT_POS_PL:
                    amount = -st_d  # debit-balance on credit-positive bucket
            elif abs(st_d) < 0.01 and st_c != 0:
                if bucket in DEBIT_POS_PL:
                    amount = -st_c  # credit-balance on debit-positive bucket
        else:
            continue  # ignore_control (121), ignore_transit (581), unknown

        if amount == 0:
            continue
        out.append({
            "code": code,
            "name": (r.get("nume_cont") or "").strip(),
            "amount": round(amount, 2),
        })
    return out


def accounts_to_canonical_tsv(accounts: List[Dict]) -> str:
    """Render parsed accounts in a fixed, unambiguous TSV layout that the
    downstream mapping stage (or Claude) can consume without ambiguity.

    The canonical layout removes the column-pairing guesswork: every row
    is `cont \\t nume_cont \\t si_d \\t si_c \\t r_d \\t r_c \\t st_d \\t
    st_c \\t sf_d \\t sf_c` so downstream code never has to detect the
    paired-Debit/Credit pattern again.
    """
    header = "Cont\tNume Cont\tSI Debit\tSI Credit\tRulaj Debit\tRulaj Credit\tSume Totale Debit\tSume Totale Credit\tSF Debit\tSF Credit"
    lines = [header]
    for a in accounts:
        lines.append(
            "\t".join(
                [
                    a["cont"],
                    a["nume_cont"].replace("\t", " "),
                    f"{a['si_d']:.2f}",
                    f"{a['si_c']:.2f}",
                    f"{a['r_d']:.2f}",
                    f"{a['r_c']:.2f}",
                    f"{a['st_d']:.2f}",
                    f"{a['st_c']:.2f}",
                    f"{a['sf_d']:.2f}",
                    f"{a['sf_c']:.2f}",
                ]
            )
        )
    return "\n".join(lines)
