"""Generator for the synthetic canonical_bs v2 golden fixtures.

Phase-5 of docs/CANONICAL_BS_V2_CONTRACT.md: targeted, minimal fixtures
for the failure classes the whole-company fixtures in files/ exercise
only incidentally (BS_ENGINE_AUDIT_MAP.md, "Phase-5 spec fixtures — all
named classes MISSING"). Each builder returns raw file bytes; running
this module as a script re-writes every fixture file next to it:

    .venv/bin/python src/engine/country_packs/ro_romania/fixtures/synthetic/make_synthetic_fixtures.py

The EXPECTED_* constants below are the single source of truth the tests
in tests/engine/ assert the parsed output against — the committed
binary files and these constants must move together.

Fixture inventory:
  synthetic_tb_ro_locale.xlsx     — 10-col Layout A, every numeric cell a
                                    Romanian-formatted TEXT string
                                    ('1.234.567,89'), incl. one deliberately
                                    AMBIGUOUS cell ('4.568') that only the
                                    per-document locale vote can resolve.
  synthetic_tb_anglo_locale.xlsx  — the SAME logical numbers, anglo text
                                    ('1,234,567.89', ambiguous '4,568').
  synthetic_tb_ro_locale.csv      — the same TB as semicolon CSV, cp1250-
                                    encoded (SAGA export code page), TOTAL
                                    row labelled in the Cont column.
  synthetic_tb_generic_4col.xlsx  — cont/denumire + ONE bare Debit/Credit
                                    pair (closing-only export).
  synthetic_tb_imbalanced_source.xlsx — the FILE's own sf totals row shows
                                    D≠C by 300 RON (missing counter-entry);
                                    extraction is faithful → anchor MATCHED
                                    + source_balanced false → D1.
  synthetic_tb_missigned_account.xlsx — account 371 posted on the CREDIT
                                    side (sign flip); no totals row →
                                    NO_ANCHOR; the assembled difference is
                                    2× the amount → MATERIAL_IMBALANCE with
                                    the D2 sign-flip fingerprint.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Dict, List, Optional, Tuple


HEADER_10COL: List[str] = [
    "Cont", "Denumire cont",
    "Solduri initiale Debit", "Solduri initiale Credit",
    "Rulaje Debit", "Rulaje Credit",
    "Sume totale Debit", "Sume totale Credit",
    "Solduri finale Debit", "Solduri finale Credit",
]

_NUMERIC_FIELDS: Tuple[str, ...] = (
    "si_d", "si_c", "r_d", "r_c", "st_d", "st_c", "sf_d", "sf_c",
)

# ── The RO/anglo locale pair — one logical TB, two textual renderings ──
# Balanced on EVERY column pair (si / rl / rc / sf each sum to the same
# value on both sides), so the only variable between the two files is
# the number formatting. 5121's 4,568.00 is written as the AMBIGUOUS
# one-separator form ('4.568' / '4,568') — the shape the document-level
# locale vote exists to resolve (number_locale._AMBIG_*_RE).
LOCALE_PAIR_ACCOUNTS: List[Tuple[str, str, Dict[str, float]]] = [
    ("1012", "Capital subscris varsat",
     {"si_c": 1_000_000.00, "r_c": 234_567.89, "st_c": 1_234_567.89, "sf_c": 1_234_567.89}),
    ("212", "Constructii",
     {"si_d": 800_000.00, "r_d": 200_000.00, "st_d": 1_000_000.00, "sf_d": 1_000_000.00}),
    ("2813", "Amortizarea constructiilor",
     {"si_c": 100_000.00, "r_c": 23_456.78, "st_c": 123_456.78, "sf_c": 123_456.78}),
    ("371", "Marfuri",
     {"si_d": 300_000.00, "r_d": 54_024.67, "st_d": 354_024.67, "sf_d": 354_024.67}),
    ("5121", "Conturi la banci in lei",
     {"r_d": 4_568.00, "st_d": 4_568.00, "sf_d": 4_568.00}),
    ("401", "Furnizori",
     {"r_c": 568.00, "st_c": 568.00, "sf_c": 568.00}),
]

# (cont, field) cells rendered in the ambiguous one-separator form.
_AMBIGUOUS_CELLS = {("5121", "r_d"), ("5121", "st_d"), ("5121", "sf_d")}

# Parsed-row expectation: cont → all 8 numeric fields (zeros explicit).
EXPECTED_ROWS: Dict[str, Dict[str, float]] = {
    cont: {f: float(vals.get(f, 0.0)) for f in _NUMERIC_FIELDS}
    for cont, _name, vals in LOCALE_PAIR_ACCOUNTS
}

# Per-pair column totals (both sides equal — the TB balances everywhere).
EXPECTED_TOTALS: Dict[str, float] = {
    "si": 1_100_000.00,
    "rl": 258_592.67,
    "rc": 1_358_592.67,
    "sf": 1_358_592.67,
}

# Assembled expectation: assets = 212 − 2813 + 371 + 5121.
EXPECTED_ASSETS = 1_235_135.89
EXPECTED_EQUITY = 1_234_567.89
EXPECTED_LIABILITIES = 568.00


def _fmt(value: float, locale: str) -> str:
    """Render a float as a thousands-grouped 2-decimal TEXT cell in the
    given locale ('ro' → '1.234.567,89', 'anglo' → '1,234,567.89')."""
    anglo = f"{value:,.2f}"
    if locale == "anglo":
        return anglo
    return anglo.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def _fmt_ambiguous(value: float, locale: str) -> str:
    """Render an exact-thousands value in the AMBIGUOUS one-separator
    form ('4.568' RO-thousands / '4,568' anglo-thousands) — parseable
    correctly only under the right document locale."""
    n = int(round(value))
    if n % 1000 == n or n >= 1_000_000:  # keep the fixture honest: one group only
        raise ValueError(f"ambiguous form needs a 4-6 digit thousands value, got {value}")
    sep = "." if locale == "ro" else ","
    return f"{n // 1000}{sep}{n % 1000:03d}"


def _cell(cont: str, field: str, value: float, locale: str) -> Optional[str]:
    """One numeric cell: None (blank) for zero, ambiguous form where the
    fixture demands it, locale-formatted text otherwise."""
    if value == 0:
        return None
    if (cont, field) in _AMBIGUOUS_CELLS:
        return _fmt_ambiguous(value, locale)
    return _fmt(value, locale)


def _locale_grid(locale: str) -> List[List[Optional[str]]]:
    """The shared 10-col grid (header + accounts + blank-code totals row)
    for the RO/anglo pair, all numbers as locale-formatted text."""
    grid: List[List[Optional[str]]] = [list(HEADER_10COL)]
    for cont, name, _vals in LOCALE_PAIR_ACCOUNTS:
        row = EXPECTED_ROWS[cont]
        grid.append(
            [cont, name] + [_cell(cont, f, row[f], locale) for f in _NUMERIC_FIELDS]
        )
    totals = [
        EXPECTED_TOTALS["si"], EXPECTED_TOTALS["si"],
        EXPECTED_TOTALS["rl"], EXPECTED_TOTALS["rl"],
        EXPECTED_TOTALS["rc"], EXPECTED_TOTALS["rc"],
        EXPECTED_TOTALS["sf"], EXPECTED_TOTALS["sf"],
    ]
    grid.append([None, "TOTAL"] + [_fmt(v, locale) for v in totals])
    return grid


def _workbook_bytes(grid: List[List[Optional[str]]], sheet_title: str) -> bytes:
    """Write a grid of text cells to a single-sheet XLSX in memory."""
    from openpyxl import Workbook  # deferred — test/generator dependency only

    wb = Workbook()
    ws = wb.active
    ws.title = sheet_title
    for row in grid:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_locale_workbook(locale: str) -> bytes:
    return _workbook_bytes(_locale_grid(locale), f"TB_{locale}")


def build_ro_csv() -> bytes:
    """Semicolon-delimited CSV of the SAME logical TB, cp1250-encoded.
    Differences on purpose: the totals row is labelled 'TOTAL' in the
    Cont column (exercises the parser's Total-labelled branch, vs the
    blank-code branch the XLSX pair uses) and 371's name carries a
    diacritic that is valid cp1250 but invalid UTF-8 (forces the
    decode-fallback chain)."""
    lines: List[str] = [";".join(HEADER_10COL)]
    for cont, name, _vals in LOCALE_PAIR_ACCOUNTS:
        if cont == "371":
            name = "Mărfuri"  # ă — cp1250 0xE3; invalid as UTF-8 here
        row = EXPECTED_ROWS[cont]
        cells = [_cell(cont, f, row[f], "ro") or "" for f in _NUMERIC_FIELDS]
        lines.append(";".join([cont, name] + cells))
    totals = [
        EXPECTED_TOTALS["si"], EXPECTED_TOTALS["si"],
        EXPECTED_TOTALS["rl"], EXPECTED_TOTALS["rl"],
        EXPECTED_TOTALS["rc"], EXPECTED_TOTALS["rc"],
        EXPECTED_TOTALS["sf"], EXPECTED_TOTALS["sf"],
    ]
    lines.append(";".join(["TOTAL", ""] + [_fmt(v, "ro") for v in totals]))
    return "\r\n".join(lines).encode("cp1250")


# ── Generic 4-column closing-only export ───────────────────────────────
GENERIC_4COL_ACCOUNTS: List[Tuple[str, str, float, float]] = [
    ("1012", "Capital subscris varsat", 0.0, 1_000.00),
    ("5121", "Conturi la banci in lei", 600.00, 0.0),
    ("371", "Marfuri", 400.00, 0.0),
]


def build_generic_4col_workbook() -> bytes:
    grid: List[List[Optional[str]]] = [["Cont", "Denumire cont", "Debit", "Credit"]]
    for cont, name, d, c in GENERIC_4COL_ACCOUNTS:
        grid.append([cont, name,
                     _fmt(d, "anglo") if d else None,
                     _fmt(c, "anglo") if c else None])
    grid.append([None, "TOTAL", _fmt(1_000.00, "anglo"), _fmt(1_000.00, "anglo")])
    return _workbook_bytes(grid, "TB_4col")


# ── Deliberately imbalanced source ─────────────────────────────────────
# The file's OWN sf totals row prints D 700 vs C 1000 — a 300 RON missing
# counter-entry in the source itself. The account rows sum to exactly the
# totals row, so extraction is faithful: anchor MATCHED, source_balanced
# false → diagnosis D1_SOURCE_IMBALANCED ('pereche sf'), and the 300 gap
# lands in `difference` (MATERIAL_IMBALANCE at this magnitude).
IMBALANCED_GAP_RON = 300.00


def build_imbalanced_source_workbook() -> bytes:
    grid: List[List[Optional[str]]] = [list(HEADER_10COL)]
    grid.append(["1012", "Capital subscris varsat",
                 None, None, None, None, None, None, None, _fmt(1_000.00, "anglo")])
    grid.append(["5121", "Conturi la banci in lei",
                 None, None, None, None, None, None, _fmt(700.00, "anglo"), None])
    grid.append([None, "TOTAL",
                 None, None, None, None, None, None,
                 _fmt(700.00, "anglo"), _fmt(1_000.00, "anglo")])
    return _workbook_bytes(grid, "TB_imbalanced")


# ── Mis-signed account (sign-flip fingerprint) ─────────────────────────
# 371 Marfuri belongs on the DEBIT side; here it is posted as a 600 RON
# CREDIT balance. Assets lose 2×600 relative to E+L (−600 instead of
# +600) → difference −1,200 → MATERIAL_IMBALANCE, and |600| ≈ |diff|/2 is
# exactly the D2_FINGERPRINT sign-flip signature. No totals row on
# purpose: the file offers no anchor (NO_ANCHOR), so the sign flip — not
# a source imbalance — is the only story the diagnosis can tell.
MISSIGNED_AMOUNT_RON = 600.00


def build_missigned_workbook() -> bytes:
    grid: List[List[Optional[str]]] = [list(HEADER_10COL)]
    grid.append(["1012", "Capital subscris varsat",
                 None, None, None, None, None, None, None, _fmt(1_000.00, "anglo")])
    grid.append(["5121", "Conturi la banci in lei",
                 None, None, None, None, None, None, _fmt(400.00, "anglo"), None])
    grid.append(["371", "Marfuri (postat gresit pe credit)",
                 None, None, None, None, None, None, None, _fmt(600.00, "anglo")])
    return _workbook_bytes(grid, "TB_missigned")


# ── File manifest ──────────────────────────────────────────────────────
FIXTURE_BUILDERS = {
    "synthetic_tb_ro_locale.xlsx": lambda: build_locale_workbook("ro"),
    "synthetic_tb_anglo_locale.xlsx": lambda: build_locale_workbook("anglo"),
    "synthetic_tb_ro_locale.csv": build_ro_csv,
    "synthetic_tb_generic_4col.xlsx": build_generic_4col_workbook,
    "synthetic_tb_imbalanced_source.xlsx": build_imbalanced_source_workbook,
    "synthetic_tb_missigned_account.xlsx": build_missigned_workbook,
}


def write_all(target_dir: Optional[Path] = None) -> List[Path]:
    target = target_dir or Path(__file__).resolve().parent
    written: List[Path] = []
    for name in sorted(FIXTURE_BUILDERS):
        path = target / name
        path.write_bytes(FIXTURE_BUILDERS[name]())
        written.append(path)
    return written


if __name__ == "__main__":
    for p in write_all():
        print(f"wrote {p}")
