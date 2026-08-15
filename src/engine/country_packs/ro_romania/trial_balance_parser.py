"""Deterministic Romanian trial-balance parser.

Replaces the "let Claude figure it out from raw TSV" path for known
trial-balance shapes. Handles:

  - SAGA (4-digit account codes, single-block layout)
  - Crystal Reports / SAP exports (6-digit codes, paired Debit/Credit
    columns with no explicit Solduri-Initiale/Finale labels)
  - CIEL / WinMentor (typical Romanian column ordering)
  - Generic 4-column closing-only exports (cont, denumire, SF D/C)
  - CSV exports (`parse_trial_balance_csv`) and pasted text
    (auto-delimiter) — same grid, same detection machinery

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
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd  # type: ignore

from .number_locale import ANGLO, detect_number_locale, parse_number


logger = logging.getLogger(__name__)


# Contract `extraction.parser_version` (docs/CANONICAL_BS_V2_CONTRACT.md).
# Bump whenever parser logic changes what rows/values are extracted.
PARSER_VERSION = "tb_parser_v4"


# ─── Errors ─────────────────────────────────────────────────────────────────


class ParseError(Exception):
    """Raised when a file can't be parsed. Carries both a user-facing
    message (rendered as a toast) and a technical detail (logged server-
    side, never shown to end users)."""

    def __init__(self, user_message: str, technical_detail: str = ""):
        self.user_message = user_message
        self.technical_detail = technical_detail
        super().__init__(user_message)


# ─── Result carriers (backward-compatible list subclasses) ──────────────────
# Every existing caller consumes the parse output as a plain list of row
# dicts and the assemble-shape output as a plain list of account dicts.
# These subclasses keep that contract byte-for-byte (iteration, len,
# indexing all unchanged) while carrying the CANONICAL_BS_V2_CONTRACT
# `extraction` / `source_anchor` metadata and the unmapped/excluded
# telemetry as attributes for the pipeline to consume.


class TrialBalanceParseResult(list):
    """List of 10-column row dicts ({cont, nume_cont, si_d, si_c, r_d,
    r_c, st_d, st_c, sf_d, sf_c}) plus parse metadata:

      .extraction      — contract `extraction` block: {method,
                         parser_version, source_format, number_locale,
                         sheet, header_row_index}
      .source_anchor   — contract `source_anchor` block (see
                         `compute_source_anchor` for the exact shape)
      .normalized_rows — property; contract NORMALIZED-stage rows with
                         both sides of every column pair (rl/rc naming),
                         so assembly can consume closing balances by SIDE
    """

    def __init__(self, rows=(), extraction: Optional[Dict] = None,
                 source_anchor: Optional[Dict] = None):
        super().__init__(rows)
        self.extraction: Dict[str, Any] = extraction or {}
        self.source_anchor: Dict[str, Any] = source_anchor or {}

    @property
    def normalized_rows(self) -> List[Dict]:
        return normalize_rows(self)


class AssembleShapeResult(list):
    """List of collapsed {code, name, amount[, bucket_override]} account
    dicts (unchanged legacy shape) plus the account-census telemetry the
    deterministic path previously discarded:

      .unmapped — [{code, name, sf_d, sf_c, reason}] accounts with no
                  mapping rule (previously silently skipped)
      .excluded — [{code, name, sf_d, sf_c, reason}] off-balance class 8
                  (incl. 891/892) and deliberate ignore-bucket accounts
    """

    def __init__(self, accounts=()):
        super().__init__(accounts)
        self.unmapped: List[Dict] = []
        self.excluded: List[Dict] = []


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
        # F3.9c — switch from `\bcont(?!\w)` to a letter-boundary
        # variant. `\b` treats `_` as a word char, so `\bcont\b`
        # never matches `BLN_CONT` (the SAGA / ContSal XLSX dialect's
        # account-code header). `(?<![A-Za-z])cont(?![A-Za-z])`
        # accepts `cont` preceded/followed by start/space/underscore
        # — matches `cont`, `BLN_CONT`, `cod cont` — while still
        # rejecting `continuare`.
        r"(?<![A-Za-z])cont(?![A-Za-z])",
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
    # Contract `extraction.source_format`: how many distinct D/C column
    # pairs the file carries. "saga_10_col" = all four (SI/RL/RC/SF),
    # "saga_compact_6_col" = 2-3 pairs (closing synthesized when the SF
    # block is absent), "generic_4_col" = a single closing pair.
    source_format: str = "saga_10_col"


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
        """Return 'debit' / 'credit' if the header marks a numeric
        column of that type.

        Recognises:
          - Bare 'Debit' / 'Credit' (Crystal Reports / Scandia 8-col)
          - 'Debitoare' / 'Creditoare' (SAGA 6-col Layout B)
          - F3.9c: SAGA / ContSal abbreviated headers ('SI DEBIT',
            'RL CREDIT', 'RC DEBIT', 'SF CREDIT', etc.). Any header
            containing `debit` or `credit` as a standalone whole
            word qualifies. Positional pairing in the caller still
            maps the four pairs to initial / period / cumulative /
            final in the canonical SI → RL → RC → SF order.
        """
        s = h.strip().lower()
        if s in ("debit", "debitoare"):  return "debit"
        if s in ("credit", "creditoare"): return "credit"
        # Treat `_` as a non-letter boundary too, so 'bln_debit' would
        # also classify cleanly if a future export uses that style.
        if re.search(r"(?<![A-Za-z])debit(?![A-Za-z])", s):
            return "debit"
        if re.search(r"(?<![A-Za-z])credit(?![A-Za-z])", s):
            return "credit"
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
    # `explicit_labels` records which semantic names were matched by their
    # own wording (vs. inferred positionally) — the generic-4-col remap
    # below must never repurpose an explicitly-labelled pair.
    explicit_labels: set[str] = set()
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
                explicit_labels.add(semantic_name)
                break

    # Resolve double-labelled pairs: when an explicit Pass-3 label (e.g.
    # 'Sold final Debit') landed on the same physical columns that the
    # positional Pass-2 pairing had already assigned to an earlier pair
    # slot, the earlier slot is a misattribution of the SAME pair — drop
    # it so pair counting (and the generic-4-col remap) sees the real
    # number of distinct column pairs.
    for target in ("final", "cumulative"):
        td = column_map.get(f"{target}_debit")
        tc = column_map.get(f"{target}_credit")
        if td is None or tc is None:
            continue
        for p in ("initial", "period", "cumulative"):
            if p == target:
                continue
            if column_map.get(f"{p}_debit") == td and column_map.get(f"{p}_credit") == tc:
                del column_map[f"{p}_debit"]
                del column_map[f"{p}_credit"]

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
        # Generic 4-column TB (cont, denumire, one bare Debit/Credit
        # pair): the positional pairing above labels the lone pair
        # "initial", which used to fail this validation. A single
        # UNLABELLED pair on a trial balance is its closing balances —
        # remap it to final. Guarded on `explicit_labels`: a file whose
        # lone pair is explicitly headed 'Sold initial' really is an
        # opening-only extract and must still be rejected (no closing
        # data to build a balance sheet from).
        lone_positional_pair = (
            "initial_debit" in column_map and "initial_credit" in column_map
            and "period_debit" not in column_map
            and "period_credit" not in column_map
            and not explicit_labels
        )
        if lone_positional_pair:
            column_map["final_debit"] = column_map.pop("initial_debit")
            column_map["final_credit"] = column_map.pop("initial_credit")
            has_final = True
        else:
            raise ParseError(
                user_message=(
                    "Couldn't find a 'Sume totale' / total-sums column pair (or "
                    "a closing-balance pair). This file's structure wasn't "
                    "recognized as a supported trial balance — compare it to "
                    "the downloadable example."
                ),
                technical_detail=f"headers={headers}, mapped={column_map}",
            )

    # Contract `extraction.source_format` — classified by how many
    # distinct D/C pairs survived (post-dedup, post-remap).
    pair_count = sum(
        1 for p in ("initial", "period", "cumulative", "final")
        if f"{p}_debit" in column_map and f"{p}_credit" in column_map
    )
    if pair_count <= 1:
        source_format = "generic_4_col"
    elif pair_count >= 4:
        source_format = "saga_10_col"
    else:
        source_format = "saga_compact_6_col"

    data_start = header_idx + 1
    data_end = _find_data_end(df, data_start, column_map["account_code"])
    has_totals_row = data_end < len(df)

    return TbStructure(
        header_row_index=header_idx,
        data_start_index=data_start,
        data_end_index=data_end,
        columns=column_map,
        has_totals_row=has_totals_row,
        source_format=source_format,
    )


def _find_header_row(df: pd.DataFrame, max_search: int = 20) -> Optional[int]:
    """Header row contains both an account-code label and the words
    'debit'+'credit' somewhere on the same line.

    F3.9c: letter-boundary form `(?<![A-Za-z])cont(?![A-Za-z])`
    instead of `\\bcont\\b`. The `\\b` form treats `_` as a word
    character, so `bln_cont` (the SAGA/ContSal XLSX dialect) failed
    detection. The letter-boundary form accepts underscore-prefixed
    variants while still rejecting `continuare` etc.
    """
    cont_re = re.compile(r"(?<![A-Za-z])cont(?![A-Za-z])")
    limit = min(max_search, len(df))
    for i in range(limit):
        cells = [str(x).lower() for x in df.iloc[i] if pd.notna(x)]
        row_text = " ".join(cells)
        has_cont = bool(cont_re.search(row_text))
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


def parse_trial_balance_df(
    df: pd.DataFrame,
    structure: TbStructure,
    number_locale: Optional[str] = None,
) -> List[Dict]:
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

    `number_locale`: the per-DOCUMENT locale ("ro"/"anglo") every cell is
    parsed under — one decision for the whole file, never re-guessed per
    cell (contract `extraction.number_locale`). None → detect here.
    """
    accounts: List[Dict] = []
    cols = structure.columns
    locale = number_locale or _detect_df_locale(df, structure)

    def col_or_zero(row: pd.Series, key: str) -> float:
        idx = cols.get(key)
        if idx is None:
            return 0.0
        return parse_number(row.iloc[idx], locale)

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
        # Account codes are 3-8 digits, optionally followed by any number
        # of dot-separated sub-code segments and an optional trailing
        # apostrophe (which some legacy SAGA exports emit to mark "auto-
        # archived but still active" accounts). Examples:
        #   `1012`           — bare 4-digit code (EEI, Scandia, Sibiu)
        #   `1012.01`        — single-level analytical (F3.7d)
        #   `5121.04.01`     — multi-level bank sub-account (Carniprod)
        #   `7584.1.1.1`     — 4-level subsidy bucket (Carniprod)
        #   `701.00'`        — apostrophe-suffixed legacy code (Carniprod)
        #   `581.2.21`       — per-counterparty internal transfer (Carniprod)
        # The downstream chart-of-accounts matches by
        # `code.startswith(prefix)` so any depth of sub-account routes to
        # the same bucket as the base prefix (e.g. `5121.04.01` → "5121"
        # bank-RON bucket). Drop banner / footer rows that Crystal Reports
        # interleaves (those don't start with digits).
        #
        # Regression history:
        #   F3.7d:   `^\d{3,8}$` → `^\d{3,8}(\.\d{1,4})?$`
        #            Unlocked single-level analytics.
        #   F3.26:   `^\d{3,8}(\.\d{1,4})?$` → `^\d{3,8}(\.\d{1,5})*'?$`
        #            Unlocked multi-level + apostrophe suffix. Carniprod
        #            dropped 43 of 367 rows pre-fix (incl. ALL 5121/5124
        #            cash sub-accounts and the 13.2M `701.00'` revenue
        #            line), causing the dashboard to show 56K cash vs
        #            10.1M real and revenue 86.2M vs 99.4M real.
        # Byte-identical for EEI / Scandia / Sibiu (no dots, no
        # apostrophe; the bare `\d{3,8}` still matches).
        if not re.match(r"^\d{3,8}(\.\d{1,5})*'?$", code):
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


# Cell-to-float conversion lives in `number_locale.parse_number` — ONE
# shared implementation for the XLSX/CSV and PDF paths. The legacy
# per-cell `_to_number` heuristic (comma-only → always Romanian decimal,
# dot-only → float() verbatim) was retired because it decided the locale
# independently per cell — the exact 1000× misparse class documented in
# BS_ENGINE_AUDIT_MAP.md Ingestion §3. The locale is now detected once
# per document (`_detect_df_locale`) and applied uniformly.


def _detect_df_locale(df: pd.DataFrame, structure: TbStructure) -> str:
    """Detect the document's number locale by majority vote over every
    cell of every mapped numeric column (data rows AND totals row).
    Default is "anglo" because pandas' dtype=str renders true numeric
    Excel cells as dot-decimal repr strings — a workbook with no text-
    formatted number cells carries no other locale signal.
    """
    cols = structure.columns
    numeric_idx = [cols[k] for k in cols if k not in ("account_code", "account_name")]
    cells: List[Any] = []
    for i in range(structure.data_start_index, len(df)):
        row = df.iloc[i]
        for idx in numeric_idx:
            cells.append(row.iloc[idx])
    return detect_number_locale(cells, default=ANGLO)


# ─── Source anchor (external conservation invariant) ────────────────────────
# Contract `source_anchor` block: the file's own TOTALS ROW is the
# external truth extraction must reconcile against. An extraction that
# balances internally but diverges from these anchors has FAILED
# (BS_ENGINE_ROOT_CAUSE.md Layer 2 — the prod run that claimed 70.2M SF
# against a file stating 60.2M while self-validating warn:false).

# Extracted column sums must match the file's totals to the cent — the
# only legitimate difference is float summation noise (~1e-6 on 60M).
_ANCHOR_MATCH_TOLERANCE_RON = 0.01
# The FILE's own per-pair D vs C comparison gets 1 RON, matching the
# platform's long-standing "balanced within 1 RON" convention.
_SOURCE_BALANCE_TOLERANCE_RON = 1.0

# (contract pair key, row debit key, row credit key) in canonical order.
_ANCHOR_PAIR_SPEC: Tuple[Tuple[str, str, str], ...] = (
    ("si", "si_d", "si_c"),
    ("rl", "r_d", "r_c"),
    ("rc", "st_d", "st_c"),
    ("sf", "sf_d", "sf_c"),
)

# Contract pair key → the structure/column-map semantic names, used to
# look file values up in the parsed totals row.
_ANCHOR_PAIR_COLUMNS: Dict[str, Tuple[str, str]] = {
    "si": ("initial_debit", "initial_credit"),
    "rl": ("period_debit", "period_credit"),
    "rc": ("cumulative_debit", "cumulative_credit"),
    "sf": ("final_debit", "final_credit"),
}


def _find_totals_row(
    df: pd.DataFrame, structure: TbStructure, locale: str
) -> Optional[Tuple[int, Dict[str, Optional[float]]]]:
    """Locate the file's totals row and parse its per-column values.

    A candidate is any row in the data region (or after it) whose
    account-code cell is blank OR reads 'Total…', with at least 2 nonzero
    mapped numeric cells. SAGA/ContSal prints the grand-totals row FIRST
    (right under the header, blank code — the frozen fixture), classic
    exports print it LAST; per-class subtotal rows can also match.
    Because every trial-balance column is a sum of nonnegative values,
    the GRAND totals row is the candidate with the largest total
    magnitude — that rule picks it deterministically wherever it sits
    (first hit wins ties).

    Returns (row_index, {semantic_column_name: value|None}) or None.
    Blank cells map to None (absent), never 0 — a totals row that doesn't
    span a column must not fabricate a zero file total for it.
    """
    cols = structure.columns
    code_col = cols["account_code"]
    numeric_keys = [k for k in cols if k not in ("account_code", "account_name")]
    best: Optional[Tuple[int, Dict[str, Optional[float]], float]] = None
    for i in range(structure.data_start_index, len(df)):
        raw_code = df.iloc[i, code_col]
        code_text = "" if pd.isna(raw_code) else str(raw_code).strip()
        if code_text and not code_text.lower().startswith("total"):
            continue
        row = df.iloc[i]
        values: Dict[str, Optional[float]] = {}
        nonzero = 0
        magnitude = 0.0
        for k in numeric_keys:
            raw = row.iloc[cols[k]]
            if pd.isna(raw) or not str(raw).strip():
                values[k] = None
                continue
            v = parse_number(raw, locale)
            values[k] = v
            if v != 0:
                nonzero += 1
                magnitude += abs(v)
        if nonzero < 2:
            continue
        if best is None or magnitude > best[2]:
            best = (i, values, magnitude)
    if best is None:
        return None
    return best[0], best[1]


def compute_source_anchor(
    tb_rows: List[Dict],
    file_totals: Optional[Dict[str, Optional[float]]] = None,
    pairs_present: Optional[Dict[str, bool]] = None,
    totals_row_index: Optional[int] = None,
    synthesized_sf: bool = False,
) -> Dict[str, Any]:
    """Build the contract `source_anchor` block.

    Extracted per-pair sums run over ACCOUNT rows only, with class 8
    (incl. 891/892) excluded — those are off-balance memo accounts. If a
    file's own totals row DOES include class-8 rows, the per-side match
    falls back to the off-balance-inclusive sum and flags
    `file_totals_include_off_balance` instead of reporting divergence.

    This replaces the circular self-validation of
    `compute_source_imbalance` (which sums the extraction against
    itself): here the comparison is against the FILE's own numbers.
    `compute_source_imbalance` stays for backward compat; this anchor is
    authoritative.

    Shape (fixed keys, deterministic order):
      {
        "totals_row_found": bool,
        "totals_row_index": int | None,       # traceability extension
        "pairs": { "si"|"rl"|"rc"|"sf":
            None                               # format lacks the pair
            | { "file_debit": float|None, "file_credit": float|None,
                "extracted_debit": float, "extracted_credit": float,
                "delta_debit": float|None, "delta_credit": float|None,
                ["synthesized_from_identity": True] } },   # sf, Layout B
        "anchor_status": "MATCHED"|"DIVERGED"|"NO_ANCHOR",
        "source_balanced": bool | None,        # None: no file pair to judge
        "imbalanced_pairs": [pair keys],       # which pair, for the banner
        "file_totals_include_off_balance": bool,
      }
    deltas are extracted − file (positive = extraction claims more than
    the file's own totals row).
    """
    sums: Dict[str, float] = {}
    off_balance: Dict[str, float] = {}
    for _, dk, ck in _ANCHOR_PAIR_SPEC:
        sums[dk] = sums[ck] = 0.0
        off_balance[dk] = off_balance[ck] = 0.0
    for r in tb_rows:
        code = (r.get("cont") or "").strip()
        target = off_balance if code.startswith("8") else sums
        for _, dk, ck in _ANCHOR_PAIR_SPEC:
            target[dk] += float(r.get(dk) or 0)
            target[ck] += float(r.get(ck) or 0)

    pairs: Dict[str, Optional[Dict[str, Any]]] = {}
    any_file_value = False
    any_file_pair = False
    diverged = False
    used_off_balance = False
    imbalanced: List[str] = []
    for key, dk, ck in _ANCHOR_PAIR_SPEC:
        present = True if pairs_present is None else bool(pairs_present.get(key))
        if not present:
            pairs[key] = None  # contract: null pairs when the format lacks the block
            continue
        fcol_d, fcol_c = _ANCHOR_PAIR_COLUMNS[key]
        file_d = file_totals.get(fcol_d) if file_totals else None
        file_c = file_totals.get(fcol_c) if file_totals else None
        ext_d, ext_c = sums[dk], sums[ck]
        entry: Dict[str, Any] = {
            "file_debit": None if file_d is None else round(file_d, 2),
            "file_credit": None if file_c is None else round(file_c, 2),
            "extracted_debit": round(ext_d, 2),
            "extracted_credit": round(ext_c, 2),
            "delta_debit": None if file_d is None else round(ext_d - file_d, 2),
            "delta_credit": None if file_c is None else round(ext_c - file_c, 2),
        }
        if synthesized_sf and key == "sf":
            # Layout B carries no Solduri-finale block in the file; the
            # extracted sf sums come from the si+rl accounting identity.
            entry["synthesized_from_identity"] = True
        for fv, ev, xv in (
            (file_d, ext_d, off_balance[dk]),
            (file_c, ext_c, off_balance[ck]),
        ):
            if fv is None:
                continue
            any_file_value = True
            if abs(ev - fv) <= _ANCHOR_MATCH_TOLERANCE_RON:
                pass
            elif abs(ev + xv - fv) <= _ANCHOR_MATCH_TOLERANCE_RON:
                used_off_balance = True
            else:
                diverged = True
        if file_d is not None and file_c is not None:
            any_file_pair = True
            # Class-8 accounts use SINGLE-entry bookkeeping (debit-only
            # memo postings), so a file whose totals row includes them
            # can legitimately show D≠C by exactly the off-balance
            # contribution. Judge balance on the ON-balance content:
            # subtract the class-8 sums from both sides first.
            file_gap = abs(file_d - file_c)
            on_balance_gap = abs((file_d - off_balance[dk]) - (file_c - off_balance[ck]))
            if min(file_gap, on_balance_gap) > _SOURCE_BALANCE_TOLERANCE_RON:
                imbalanced.append(key)
        pairs[key] = entry

    if not any_file_value:
        anchor_status = "NO_ANCHOR"
    elif diverged:
        anchor_status = "DIVERGED"
    else:
        anchor_status = "MATCHED"

    return {
        "totals_row_found": file_totals is not None,
        "totals_row_index": totals_row_index,
        "pairs": pairs,
        "anchor_status": anchor_status,
        "source_balanced": (not imbalanced) if any_file_pair else None,
        "imbalanced_pairs": imbalanced,
        "file_totals_include_off_balance": used_off_balance,
    }


def normalize_rows(tb_rows: List[Dict]) -> List[Dict]:
    """Contract NORMALIZED-stage rows: the full per-account structure
    with BOTH sides of every column pair, under the contract's rl/rc
    naming (rl = rulaj, rc = rulaj cumulat / sume totale), so assembly
    can consume closing balances by SIDE instead of a collapsed amount.
    """
    out: List[Dict] = []
    for r in tb_rows:
        out.append({
            "code": (r.get("cont") or "").strip(),
            "name": (r.get("nume_cont") or "").strip(),
            "si_d": float(r.get("si_d") or 0), "si_c": float(r.get("si_c") or 0),
            "rl_d": float(r.get("r_d") or 0), "rl_c": float(r.get("r_c") or 0),
            "rc_d": float(r.get("st_d") or 0), "rc_c": float(r.get("st_c") or 0),
            "sf_d": float(r.get("sf_d") or 0), "sf_c": float(r.get("sf_c") or 0),
        })
    return out


def _parse_dataframe(
    df: pd.DataFrame, sheet_name: Optional[str], filename: str = ""
) -> TrialBalanceParseResult:
    """Shared core of the XLSX / CSV / pasted-text paths: structure
    detection → per-document locale → row parsing → totals-row anchor →
    metadata. Raises ParseError on any failure."""
    structure = detect_trial_balance_structure(df)
    locale = _detect_df_locale(df, structure)
    rows = parse_trial_balance_df(df, structure, number_locale=locale)
    if not rows:
        raise ParseError(
            user_message=(
                "We detected the file format but couldn't find any numeric "
                "account rows. Are you sure this is a trial balance?"
            ),
            technical_detail=f"structure={structure}, df_shape={df.shape}",
        )

    cols = structure.columns
    has_final_cols = "final_debit" in cols and "final_credit" in cols
    pairs_present = {
        "si": "initial_debit" in cols and "initial_credit" in cols,
        "rl": "period_debit" in cols and "period_credit" in cols,
        "rc": "cumulative_debit" in cols and "cumulative_credit" in cols,
        # Rows ALWAYS carry sf: from the file's own final block, or
        # synthesized from the si+rl identity (Layout B).
        "sf": True,
    }
    totals = _find_totals_row(df, structure, locale)
    anchor = compute_source_anchor(
        rows,
        file_totals=totals[1] if totals else None,
        pairs_present=pairs_present,
        totals_row_index=totals[0] if totals else None,
        synthesized_sf=not has_final_cols,
    )
    extraction = {
        "method": "deterministic",
        "parser_version": PARSER_VERSION,
        "source_format": structure.source_format,
        "number_locale": locale,
        "sheet": sheet_name,
        "header_row_index": structure.header_row_index,
    }
    return TrialBalanceParseResult(rows, extraction=extraction, source_anchor=anchor)


# ─── Delimited-text grid (pasted text + CSV share this) ─────────────────────


def _sniff_delimiter(text: str) -> str:
    """Deterministic delimiter detection over the first 50 non-blank
    lines. Tab, semicolon and pipe are preferred IN THAT ORDER over the
    comma: Romanian CSV exports use ';' as the field separator precisely
    because ',' is the decimal separator — a frequency count would let
    decimal commas outvote the real delimiter."""
    lines = [ln for ln in text.splitlines() if ln.strip()][:50]
    for cand in ("\t", ";", "|"):
        hits = sum(1 for ln in lines if cand in ln)
        if lines and hits >= max(1, len(lines) // 2):
            return cand
    return ","


def _grid_from_delimited_text(text: str, context: str) -> pd.DataFrame:
    """Build the same header-less all-string DataFrame the Excel reader
    produces, from delimiter-separated text. `context` labels the error
    message ('pasted text' / 'CSV file')."""
    delimiter = _sniff_delimiter(text)
    lines = [ln for ln in text.splitlines() if ln.strip()]
    # Pre-computed width forces pandas to pad ragged banner/footer rows
    # with NaN instead of erroring on them; the raw delimiter count can
    # only overestimate (quotes hide delimiters), which just adds empty
    # columns that the structure detector ignores.
    max_width = max((ln.count(delimiter) for ln in lines), default=0) + 1
    try:
        df = pd.read_csv(
            io.StringIO(text),
            sep=delimiter,
            dtype=str,
            header=None,
            names=list(range(max_width)),
            skip_blank_lines=True,
            engine="python",
            quoting=csv.QUOTE_MINIMAL,
        )
    except Exception as e:  # noqa: BLE001
        raise ParseError(
            user_message=(
                f"Couldn't parse the {context}. Make sure you exported "
                "with columns intact (one account per line, consistent "
                "delimiter)."
            ),
            technical_detail=f"pandas.read_csv failed: {type(e).__name__}: {e}",
        )

    if df.empty or len(df.columns) < 4:
        raise ParseError(
            user_message=(
                f"The {context} doesn't have enough columns. Expected at "
                "least: account code, account name, debit, credit."
            ),
            technical_detail=f"shape={df.shape}",
        )
    return df


# ─── Pasted-text path ───────────────────────────────────────────────────────


def parse_pasted_trial_balance(text: str) -> TrialBalanceParseResult:
    """Parse text pasted from Excel / Word / a CSV. Auto-detects delimiter
    (tab / semicolon / pipe / comma) so the user doesn't have to think
    about format. Reuses the same structure detector + row parser as
    Excel uploads — single source of truth for column mapping."""
    if not text or not text.strip():
        raise ParseError(
            user_message="Paste area is empty. Please paste trial-balance data first.",
            technical_detail="Empty input to parse_pasted_trial_balance",
        )
    df = _grid_from_delimited_text(text, "pasted text")
    return _parse_dataframe(df, sheet_name=None, filename="(pasted)")


# ─── CSV path ───────────────────────────────────────────────────────────────


def parse_trial_balance_csv(data: bytes, filename: str = "") -> TrialBalanceParseResult:
    """Parse a CSV export of a trial balance. Decodes utf-8 (BOM
    tolerated) with cp1250 fallback (the Windows Central-European code
    page SAGA/WinMENTOR exports use), sniffs the delimiter, then reuses
    the exact header-detection + row-parsing machinery of the XLSX path —
    same TrialBalanceParseResult, same anchor, same metadata. This closes
    the audit's 1c defect (CSVs previously bypassed the deterministic
    parser entirely and got LLM extraction)."""
    if not data:
        raise ParseError(
            user_message="The CSV file is empty.",
            technical_detail="0 bytes passed to parse_trial_balance_csv",
        )
    text: Optional[str] = None
    # latin-1 is the never-fails last resort: digits and separators are
    # ASCII, so numeric fidelity survives even if diacritics garble.
    for encoding in ("utf-8-sig", "cp1250", "latin-1"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:  # unreachable given latin-1, kept as a guard
        raise ParseError(
            user_message="Couldn't decode this CSV file (unknown text encoding).",
            technical_detail="utf-8-sig, cp1250 and latin-1 all failed",
        )
    df = _grid_from_delimited_text(text, "CSV file")
    return _parse_dataframe(df, sheet_name=None, filename=filename)


# ─── Public entry point: bytes → accounts ───────────────────────────────────


def parse_trial_balance_file(file_bytes: bytes, filename: str = "") -> TrialBalanceParseResult:
    """High-level entry: take raw Excel bytes, return the typed account
    list (a TrialBalanceParseResult — a plain list to legacy callers,
    plus .extraction / .source_anchor metadata). Raises ParseError on
    any failure.

    Multi-sheet: sheets are tried in workbook order (deterministic) and
    the FIRST sheet with a recognizable trial-balance header wins — a TB
    on a second sheet no longer falls through to the LLM path (audit 1a
    risk)."""
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
        xl = pd.ExcelFile(io.BytesIO(file_bytes), engine=engine)
    except Exception as e:  # noqa: BLE001
        raise ParseError(
            user_message=(
                "Couldn't read this Excel file. It may be corrupted, "
                "password-protected, or in an unsupported sub-format. Try "
                "re-saving in Excel and re-uploading."
            ),
            technical_detail=f"{type(e).__name__}: {e} (engine={engine}, name={filename})",
        )

    errors: List[Tuple[str, ParseError]] = []
    for sheet_name in xl.sheet_names:  # workbook order — deterministic
        try:
            df = xl.parse(sheet_name, header=None, dtype=str)
        except Exception as e:  # noqa: BLE001
            errors.append((sheet_name, ParseError(
                user_message="Sheet could not be read.",
                technical_detail=f"{type(e).__name__}: {e}",
            )))
            continue
        if df.empty:
            errors.append((sheet_name, ParseError(
                user_message="Sheet is empty.",
                technical_detail="DataFrame returned empty after read",
            )))
            continue
        try:
            return _parse_dataframe(df, sheet_name=sheet_name, filename=filename)
        except ParseError as e:
            errors.append((sheet_name, e))
            continue

    if len(errors) == 1:
        # Single-sheet workbook: surface the sheet's own error verbatim —
        # identical UX to the pre-multi-sheet behavior.
        raise errors[0][1]
    detail = "; ".join(
        f"[{name}] {err.technical_detail or err.user_message}" for name, err in errors
    )
    raise ParseError(
        user_message=(
            "None of this workbook's sheets look like a supported trial "
            "balance. Expected columns like 'Cont', 'Nume Cont', 'Debit', "
            "'Credit' on one sheet."
        ),
        technical_detail=f"scanned {len(errors)} sheet(s): {detail}",
    )


def compute_source_imbalance(tb_rows: List[Dict]) -> Dict[str, float]:
    """F3.9 — Source-data quality telemetry: closing-side raw imbalance.

    A perfectly-extracted Romanian trial balance has Σ sf_d == Σ sf_c (every
    debit balance has a matching credit balance somewhere). Real-world
    extracts often violate this:
      · Extended-layout SAGA / WinMENTOR closes with year-end reconciliation
        entries that may be unbalanced in the snapshot (entries posted but
        counter-entries pending), producing 1-5% raw drift.
      · PDF parsing introduces position-extraction noise that can drop a
        column on some rows, breaking sf_d/sf_c symmetry.
      · Genuine source-data errors (closing entries booked to wrong sides).

    The engine cannot fix this — it's upstream. But it CAN warn the operator
    before they read the analysis: "engine drift on this file will exceed
    normal range because the source data itself is X% imbalanced."

    Returns: {
        "sum_closing_debit": float,
        "sum_closing_credit": float,
        "raw_imbalance_abs": float,
        "raw_imbalance_pct": float,    # |Σ sf_d - Σ sf_c| / max(Σ sf_d, Σ sf_c) × 100
        "warn_threshold_pct": 2.0,
        "warn": bool,                  # True when raw_imbalance_pct > warn_threshold_pct
    }

    The 2.0% warn threshold matches the F3.7g-h ceremony precedent (Sibiu
    PDF 1.0% threshold, Carniprod 8.0% threshold both above 2%; everything
    else under 2% is in "normal-extract" territory).
    """
    sum_d = 0.0
    sum_c = 0.0
    for r in tb_rows:
        sum_d += float(r.get("sf_d") or 0)
        sum_c += float(r.get("sf_c") or 0)
    imbalance_abs = abs(sum_d - sum_c)
    denom = max(abs(sum_d), abs(sum_c))
    imbalance_pct = round((imbalance_abs / denom * 100) if denom > 0 else 0.0, 4)
    threshold = 2.0
    return {
        "sum_closing_debit":  round(sum_d, 2),
        "sum_closing_credit": round(sum_c, 2),
        "raw_imbalance_abs":  round(imbalance_abs, 2),
        "raw_imbalance_pct":  imbalance_pct,
        "warn_threshold_pct": threshold,
        "warn": imbalance_pct > threshold,
    }


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


def accounts_to_assemble_shape(tb_rows: List[Dict]) -> AssembleShapeResult:
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

    Returns an AssembleShapeResult: the accounts list is byte-identical
    to the legacy return value, and the previously-silent drops are now
    surfaced on it (contract `unmapped` / `excluded` blocks):
      · .unmapped — codes with no mapping rule (previously
        `if not rule: continue`, zero telemetry — audit gap 17)
      · .excluded — off-balance class 8 incl. 891/892 (explicitly
        excluded, no longer excluded-by-fallthrough — audit gap 14) plus
        deliberate ignore-bucket accounts (581 transit), so the census
        invariant Σ classified + unmapped + excluded is checkable.
    """
    # F3.1d: chart-of-accounts now lives at the pack-local path; keep the
    # `_ro_coa` alias inside this function to leave the call sites below
    # unchanged.
    from . import chart_of_accounts as _ro_coa  # lazy to avoid any import-order surprise

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

    out = AssembleShapeResult()

    # Document-level gate for the closing-only (generic_4_col) P&L
    # fallback below: P&L buckets read YTD movements (sume totale), which
    # a closing-only file doesn't carry at all. Only when the WHOLE
    # document has no cumulative data may class 6/7 accounts fall back to
    # their closing balances (pre-year-end-closing YTD values) — a per-
    # row fallback would silently change Layout A/B files.
    has_any_cumulative = any(
        float(r.get("st_d") or 0) != 0 or float(r.get("st_c") or 0) != 0
        for r in tb_rows
    )

    for r in tb_rows:
        code = (r.get("cont") or "").strip()
        if not code:
            continue
        name = (r.get("nume_cont") or "").strip()
        sf_d = float(r.get("sf_d") or 0)
        sf_c = float(r.get("sf_c") or 0)
        st_d = float(r.get("st_d") or 0)
        st_c = float(r.get("st_c") or 0)

        # Class 8 (conturi speciale, incl. 891/892 opening/closing
        # balance-sheet accounts) is off-balance — excluded EXPLICITLY,
        # not by rules-table fallthrough, so a future class-8 rule or
        # name-keyword fallback can never leak memo amounts into the BS.
        if code.startswith("8"):
            if code.startswith("891"):
                reason = "opening_balance_sheet_account"
            elif code.startswith("892"):
                reason = "closing_balance_sheet_account"
            else:
                reason = "off_balance_class_8"
            out.excluded.append({
                "code": code, "name": name,
                "sf_d": round(sf_d, 2), "sf_c": round(sf_c, 2),
                "reason": reason,
            })
            continue

        rule = _ro_coa.bucket_for(code)
        if not rule:
            # Previously `continue` with zero telemetry — the missing
            # balance was invisible to every drift gate. Surface it.
            out.unmapped.append({
                "code": code, "name": name,
                "sf_d": round(sf_d, 2), "sf_c": round(sf_c, 2),
                "reason": "no_rule",
            })
            continue
        bucket = rule.bucket

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
            # Liabilities/equity: normal balance on credit side.
            #
            # F3.7a (Option A, baseline ceremony 2026-05-21) — sign-
            # aware emission. For sign=+1 ("natural-direction")
            # accounts, a debit balance is CONTRA / negative
            # contribution (e.g., 1171 retained earnings with sf_d>0
            # carries forward a LOSS, not positive equity). Use
            # signed math: amount = sf_c − sf_d.
            #
            # For sign=−1 ("contra-natural-direction") accounts like
            # 129 (Repartizarea profitului, balance on debit by
            # design), keep the legacy absolute-side logic. The
            # rule's sign=−1 then negates the positive amount to
            # subtract from equity.
            #
            # Empirical impact (operator-authorized re-baseline):
            #   EEI:     unchanged (0.0000% drift, byte-identical)
            #   Scandia: drift 0.3698% → 0.1389% (62% closer to
            #            physical reality; signed math correctly
            #            captures debit-side balances in 1171,
            #            105, 162 families that were previously
            #            mis-emitted as positive)
            #   Sibiu:   eliminates 3.77M equity inflation from the
            #            117 retained-earnings sub-account family
            if rule.sign == 1:
                amount = sf_c - sf_d
            else:
                amount = sf_c if sf_c != 0 else sf_d
        elif bucket in DEBIT_POS_BS:
            # Assets: normal balance on debit side. For contra-asset
            # accounts (28x accumulated depreciation, 29x impairment,
            # 491 receivables allowance) the balance is on the
            # credit side; their rule has sign=−1 to subtract.
            #
            # F3.7a (Option A) — same sign-aware rule as above: for
            # sign=+1 natural-direction assets, use signed math
            # (amount = sf_d − sf_c) so a credit-side balance
            # (overpayment, fund reversal) correctly emits negative.
            # For sign=−1 contra-assets, keep absolute-side logic
            # — the rule's sign=−1 already inverts.
            if rule.sign == 1:
                amount = sf_d - sf_c
            else:
                amount = sf_d if sf_d != 0 else sf_c
        elif bucket in CREDIT_POS_PL or bucket in DEBIT_POS_PL:
            # Closing-only fallback (generic_4_col): the document carries
            # NO cumulative block anywhere (`has_any_cumulative` gate
            # above), so a mid-year class 6/7 closing balance IS the YTD
            # movement — read the sf sides in place of st. On Layout A/B
            # files the gate is False and this line is inert.
            eff_d, eff_c = (sf_d, sf_c) if not has_any_cumulative else (st_d, st_c)
            # Crystal Reports puts the SAME signed value in both st_d and st_c
            # for class-6/7 accounts (because the year-end closing entry
            # mirrors the natural-side accumulation). SAGA-style puts the
            # movement on one side only. Pick the side with the larger
            # absolute value so both formats work; the sign of that value
            # is the real direction (709 contra-revenue shows as negative).
            amount = eff_c if abs(eff_c) >= abs(eff_d) else eff_d
            # SAGA fallback: contra-revenue / contra-expense end up on the
            # "wrong" side. Sign-flip when the bucket's expected direction
            # disagrees with where the value showed up.
            if abs(eff_c) < 0.01 and eff_d != 0:  # SAGA-only path (one side zero)
                if bucket in CREDIT_POS_PL:
                    amount = -eff_d  # debit-balance on credit-positive bucket
            elif abs(eff_d) < 0.01 and eff_c != 0:
                if bucket in DEBIT_POS_PL:
                    amount = -eff_c  # credit-balance on debit-positive bucket
        elif bucket == "ignore_control" and code.startswith("121"):
            # F3.7d: emit account 121 (PROFIT SI PIERDERE) with its signed
            # closing balance so `chart_of_accounts.assemble_statements`
            # can use it as the STATUTORY NET-INCOME ANCHOR. The bucket
            # stays `ignore_control` (still not summed into BS or PL
            # buckets) — chart_of_accounts checks `code.startswith("121")`
            # and reads the amount directly to override the reconstructed
            # `net_income_statutory` when the two diverge by more than 5%.
            #
            # Why anchor:
            #   The reconstruction (operational profit + capitalized own
            #   work) equals account 121 closing within ±5% for standard
            #   operating entities (Scandia, EEI, Sibiu, food manufacturers).
            #   It diverges by 5-50× for asset-heavy entities — real estate
            #   developers where 711 production-variation (29.6M for
            #   RealEstate) and 628 capitalization expenses don't net
            #   cleanly on the P&L. CLAUDE.md Appendix B methodology
            #   ("Section 4 / Step 11"): account 121 closing IS the
            #   statutory net profit; reconstruction is the validation
            #   check, not the authoritative number.
            #
            # Sign convention (matches CREDIT_POS_BS treatment):
            #   sf_c > sf_d → credit balance = PROFIT (positive amount)
            #   sf_d > sf_c → debit balance  = LOSS    (negative amount)
            amount = sf_c - sf_d
        else:
            # ignore_transit (581) / non-121 ignore_control: deliberately
            # off the statements — recorded in `excluded` so the census
            # invariant (classified + unmapped + excluded = source rows)
            # holds. A ruled bucket missing from every membership set is
            # a rules-table gap — surface it in `unmapped`, not silence.
            if bucket.startswith("ignore"):
                # 581 (viramente interne) normally nets to zero — excluding
                # it is free. A NONZERO closing balance is real money in
                # transit, and excluding it from the statement while the
                # source-balance judgment counts it broke the closing
                # identity (verifier probe 2026-08-15: difference −50 on a
                # balanced 581/1012 pair). Value-bearing 581 therefore goes
                # to `unmapped` — the canonical builder includes unmapped
                # balances in the totals by balance side, loudly visible.
                if bucket == "ignore_transit" and round(sf_d - sf_c, 2) != 0:
                    out.unmapped.append({
                        "code": code, "name": name,
                        "sf_d": round(sf_d, 2), "sf_c": round(sf_c, 2),
                        "reason": "transit_581_nonzero_closing",
                    })
                    continue
                out.excluded.append({
                    "code": code, "name": name,
                    "sf_d": round(sf_d, 2), "sf_c": round(sf_c, 2),
                    "reason": bucket,
                })
            else:
                out.unmapped.append({
                    "code": code, "name": name,
                    "sf_d": round(sf_d, 2), "sf_c": round(sf_c, 2),
                    "reason": f"unrouted_bucket:{bucket}",
                })
            continue

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
