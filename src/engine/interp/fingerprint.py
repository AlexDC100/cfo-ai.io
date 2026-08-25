"""Layout fingerprinting — a stable identity for a spreadsheet LAYOUT.

``layout_fingerprint(file_bytes, sheet=None) -> str`` returns a sha256 hex
digest computed over the document's STRUCTURE, never its data:

    * the normalized header-row cell texts (lowercased, whitespace-collapsed),
    * the column count (trailing all-empty columns trimmed),
    * a sheet-name CLASS (lowercased, whitespace-collapsed, digit runs
      collapsed to ``#`` — so ``Sheet1`` / ``Sheet2`` re-saves collide by
      design, while a custom sheet name keeps its identity),
    * a file-extension class sniffed from magic bytes (``xlsx-zip`` /
      ``xls-ole`` / ``text-delim``) — content-derived, so the fingerprint
      does not depend on the caller knowing the original filename.

Two saves of the SAME layout with DIFFERENT data values fingerprint
identically; two different layouts fingerprint differently (both are
locked by tests/engine/test_templates.py against the real fixtures).

The header row is located MECHANICALLY and jurisdiction-blind (N7): the
first row, within the first ``_MAX_HEADER_SEARCH`` rows, whose non-empty
cells are majority letter-bearing (any Unicode letter counts — no
language- or jurisdiction-specific header words are consulted). Trial
balance data rows (a code, one label, many numbers) never qualify because
numbers dominate them. If no row qualifies the fingerprint deterministically
falls back to row 0 — a degraded but stable identity.

DESIGN TRADEOFF, documented on purpose: a company-named sheet (e.g. an
export that titles the sheet after the company) yields a company-specific
fingerprint. That errs toward template MISSES — the safe direction: a miss
routes to the dual-map interpreter path; it never serves a wrong template.

No AI, no network, no clock, no filesystem writes — pure bytes -> str.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
from typing import Any, List, Optional, Tuple, Union

import pandas as pd

__all__ = ["FingerprintError", "layout_fingerprint", "FINGERPRINT_VERSION"]

#: Bump ONLY with a deliberate migration note — changing it orphans every
#: stored template keyed by the old fingerprints.
FINGERPRINT_VERSION = "layout_fp_v1"

_XLSX_MAGIC = b"PK\x03\x04"
_XLS_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

_MAX_HEADER_SEARCH = 30
_MIN_HEADER_CELLS = 3

_WS_RE = re.compile(r"\s+")
_DIGIT_RUN_RE = re.compile(r"\d+")
# Any Unicode letter (excludes digits, punctuation, underscore).
_LETTER_RE = re.compile(r"[^\W\d_]", re.UNICODE)


class FingerprintError(ValueError):
    """The bytes could not be read as a tabular document."""


def _extension_class(data: bytes) -> str:
    if data.startswith(_XLSX_MAGIC):
        return "xlsx-zip"
    if data.startswith(_XLS_MAGIC):
        return "xls-ole"
    return "text-delim"


def _normalize_cell(value: Any) -> str:
    """Lowercase + whitespace-collapse; NaN/None -> ''."""
    if value is None:
        return ""
    if isinstance(value, float) and value != value:  # NaN without numpy import
        return ""
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    text = str(value)
    return _WS_RE.sub(" ", text).strip().lower()


def _sheet_name_class(name: str) -> str:
    normalized = _WS_RE.sub(" ", str(name)).strip().lower()
    return _DIGIT_RUN_RE.sub("#", normalized)


def _load_grid(
    data: bytes, sheet: Optional[Union[str, int]]
) -> Tuple[pd.DataFrame, str]:
    """Read the raw grid (no header interpretation) + the sheet name used."""
    ext_class = _extension_class(data)
    try:
        if ext_class in ("xlsx-zip", "xls-ole"):
            xf = pd.ExcelFile(io.BytesIO(data))
            if sheet is None:
                sheet_name = str(xf.sheet_names[0])
            elif isinstance(sheet, int):
                sheet_name = str(xf.sheet_names[sheet])
            else:
                sheet_name = str(sheet)
            df = pd.read_excel(xf, sheet_name=sheet_name, header=None, dtype=object)
            return df, sheet_name
        df = pd.read_csv(
            io.BytesIO(data),
            header=None,
            dtype=object,
            sep=None,
            engine="python",
        )
        return df, ""
    except FingerprintError:
        raise
    except Exception as exc:  # noqa: BLE001 — wrap into the typed error
        raise FingerprintError(
            "could not read bytes as a tabular document (%s): %s: %s"
            % (ext_class, type(exc).__name__, exc)
        ) from exc


def _trim_trailing_empty_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Drop trailing columns that carry no value anywhere in the sheet.

    Trailing padding columns come and go between saves of the same layout;
    interior empty columns are structure and are kept.
    """
    if df.shape[1] == 0:
        return df
    last_nonempty = -1
    for col_idx in range(df.shape[1] - 1, -1, -1):
        column = df.iloc[:, col_idx]
        if column.notna().any():
            last_nonempty = col_idx
            break
    if last_nonempty < 0:
        return df.iloc[:, 0:0]
    return df.iloc[:, : last_nonempty + 1]


def _find_header_row(df: pd.DataFrame) -> int:
    """First majority-textual row (mechanical, jurisdiction-blind).

    A row qualifies when it has at least ``_MIN_HEADER_CELLS`` non-empty
    cells and STRICTLY more than half of them contain at least one Unicode
    letter. Falls back to row 0 when nothing qualifies (deterministic).
    """
    limit = min(_MAX_HEADER_SEARCH, len(df))
    for row_idx in range(limit):
        cells = [_normalize_cell(v) for v in df.iloc[row_idx].tolist()]
        nonempty = [c for c in cells if c]
        if len(nonempty) < _MIN_HEADER_CELLS:
            continue
        lettered = sum(1 for c in nonempty if _LETTER_RE.search(c))
        if lettered * 2 > len(nonempty):
            return row_idx
    return 0


def layout_fingerprint(
    file_bytes: bytes, sheet: Optional[Union[str, int]] = None
) -> str:
    """Deterministic sha256 identity of a document's LAYOUT (not its data)."""
    if not isinstance(file_bytes, (bytes, bytearray)):
        raise FingerprintError(
            "layout_fingerprint expects bytes, got %s" % type(file_bytes).__name__
        )
    data = bytes(file_bytes)
    if not data:
        raise FingerprintError("layout_fingerprint got empty bytes")

    df, sheet_name = _load_grid(data, sheet)
    df = _trim_trailing_empty_columns(df)
    if df.shape[1] == 0 or len(df) == 0:
        raise FingerprintError("document has no non-empty cells")

    header_row = _find_header_row(df)
    headers: List[str] = [
        _normalize_cell(v) for v in df.iloc[header_row].tolist()
    ]

    payload = {
        "v": FINGERPRINT_VERSION,
        "ext_class": _extension_class(data),
        "sheet_name_class": _sheet_name_class(sheet_name),
        "column_count": int(df.shape[1]),
        "headers": headers,
    }
    canonical = json.dumps(
        payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
