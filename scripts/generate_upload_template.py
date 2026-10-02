"""Generate the canonical CFO AI upload template (.xlsx).

Why this script exists
----------------------
Before today, users uploaded random Excel files and we hoped the parser
figured them out. That's brittle and produced the kind of "DIO didn't
extract because the sheet name is YTD Oct'25 instead of YTD Mar'26" bug
that just burned five sessions to find.

The fix is a canonical template — one file with known sheet names, known
column names, known row offsets — that the parser knows it can lean on.
This script generates that template. The output (.xlsx) is committed at:

    public/templates/cfo_ai_upload_template.xlsx

and served by the FE at:

    https://cfo-ai.io/templates/cfo_ai_upload_template.xlsx

    .venv/bin/python scripts/generate_upload_template.py
    .venv/bin/python scripts/generate_upload_template.py --check

EVERY EXAMPLE VALUE IS FICTIONAL (2026-10-02). The file is public — anyone
can download it — so its example rows are invented here: the customers,
the brands, the products, the categories, the volumes, the stock values
and the DIO days belong to no company, and the workbook says so on its
first sheet. Until this date the example rows had been copied from a real
workbook (a brand, retailers, an ERP report's selection header and DIO
figures to the cent). Nothing in this script may be copied from a book
again: an example is typed as a round, obviously illustrative number.

The bytes are stable: the DIO sheet's as-of date is a constant, the
document properties carry the product name and nothing else, and the
archive is rebuilt with fixed member timestamps — so `--check` can compare
the committed file with a rebuild byte for byte.

What the parser actually reads (src/engine/api/_sales_extract.py)
-----------------------------------------------------------------
- "Trading" sheet — SKU-level rows. Columns identified by name:
    Canal, Client, Tip client, CLIENT_PARINTE, BU, Categ_Pr, Brand,
    Denumire_Produs, PackSize, Sold in KG, GR Gross Revenue finished
    goods, Net Invoice Value, Cost of Sales, Gross Margin.
- "DIO" sheet — two regions in ONE sheet:
    Region 1 (rows 2..N): per-category inventory snapshot.
        col A = category name (Grupa_Pr)
        col D = inventory value (Stoc Valoric Standard (RON))
        col H = inventory kg (Stoc KG)
    Region 2 (rows 28..52): per-category DIO days.
        col B = category name
        col D = DIO days
- "Trial Balance" sheet (optional) — Cont/Denumire/Sold debitor/Sold creditor.

Region 2 is the source for the DIO days the Products view reads
(`extract_category_dio`: a row with column A empty, a category name in
column B and a positive number in column D). Region 1 rows carry the
category in column A, which is what keeps the two regions apart.
"""
from __future__ import annotations

import argparse
import io
import sys
from datetime import date, datetime
from pathlib import Path
from typing import List, Optional

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter


REPO = Path(__file__).resolve().parents[1]
if str(REPO / "scripts") not in sys.path:
    sys.path.insert(0, str(REPO / "scripts"))

# Output goes inside `public/` so Vite serves it at
# /templates/cfo_ai_upload_template.xlsx without any extra config.
OUTPUT = REPO / "public" / "templates" / "cfo_ai_upload_template.xlsx"

#: The only name the workbook's document properties and comment authors
#: carry.
PRODUCT_NAME = "CFO AI"

#: The DIO sheet's as-of date and the document properties' date. A
#: constant: the template says nothing about when this script ran.
AS_OF = date(2026, 1, 31)
DOC_DATE = "2026-01-31T00:00:00Z"

#: Printed on the first sheet, in both languages.
FICTIONAL_NOTICE = (
    "All example rows in this workbook are fictional — invented customers, "
    "brands, products and figures. Replace them with your own data. "
    "Toate rândurile-exemplu din acest fișier sunt fictive — clienți, mărci, "
    "produse și cifre inventate. Înlocuiește-le cu datele tale."
)


# ──────────────────────────────────────────────────────────────────────
# Styling helpers — kept tight so every sheet renders with the same
# typography. Hex colors mirror the v5 site palette (navy header / amber
# warnings) so the file feels like an extension of the product, not a
# random spreadsheet.
# ──────────────────────────────────────────────────────────────────────

HEADER_FILL = PatternFill("solid", start_color="1F2937")   # slate-800
HEADER_FONT = Font(bold=True, color="FFFFFF", size=11)
ACCENT_FILL = PatternFill("solid", start_color="003366")   # navy
ACCENT_FONT = Font(bold=True, color="FFFFFF", size=18)
SUBTLE_FONT = Font(italic=True, color="6B7280", size=10)   # slate-500
NOTE_FONT = Font(italic=True, color="9CA3AF", size=9)      # slate-400
BOLD = Font(bold=True, size=11)


def _style_header_row(ws, row: int, headers: list[str], comments: dict[str, str] | None = None) -> None:
    """Apply the standard header style + optional cell comments."""
    for col, header in enumerate(headers, start=1):
        cell = ws.cell(row=row, column=col)
        cell.value = header
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
        if comments and header in comments:
            cell.comment = Comment(comments[header], PRODUCT_NAME)
    ws.row_dimensions[row].height = 32


def _set_widths(ws, widths: list[int]) -> None:
    for col, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(col)].width = w


# ──────────────────────────────────────────────────────────────────────
# Sheet builders. Each function adds one sheet to the workbook. The order
# of `wb.create_sheet()` calls determines tab order — Instructions is
# created first so it's the sheet that opens by default.
# ──────────────────────────────────────────────────────────────────────


def add_instructions_sheet(wb: Workbook) -> None:
    """Plain-English/Romanian overview. First tab the user sees on open."""
    ws = wb.create_sheet("Instructions", 0)

    # Big navy header banner across A1:D1
    ws["A1"] = "CFO AI UPLOAD TEMPLATE"
    ws["A1"].font = ACCENT_FONT
    ws["A1"].fill = ACCENT_FILL
    ws["A1"].alignment = Alignment(horizontal="left", vertical="center", indent=1)
    ws.merge_cells("A1:D1")
    ws.row_dimensions[1].height = 44

    ws["A3"] = (
        "This is the canonical format CFO AI expects. "
        "Acesta este formatul canonic pe care CFO AI îl așteaptă."
    )
    ws["A3"].font = SUBTLE_FONT
    ws.merge_cells("A3:D3")

    rows: list[tuple[str, str]] = [
        ("EXAMPLE DATA", FICTIONAL_NOTICE),
        ("HOW TO USE", ""),
        ("1.", 'Fill in the "Trading" sheet with your SKU-level sales data.'),
        ("2.", 'Fill in the "DIO" sheet with your per-category inventory days.'),
        ("3.", '(Optional) Fill in "Trial Balance" if you want Dashboard financial reports.'),
        ("4.", "Save the file and upload it at https://cfo-ai.io/products"),
        ("", ""),
        ("SHEETS IN THIS WORKBOOK", ""),
        (
            "Trading",
            "Your SKU-level sales rows. REQUIRED. One row per SKU × channel × period.",
        ),
        (
            "DIO",
            "Days inventory outstanding per category. REQUIRED for DIO in Products view.",
        ),
        (
            "Trial Balance",
            "OPTIONAL. Standard Romanian chart of accounts. Only for Dashboard reports.",
        ),
        (
            "Field Reference",
            "Column dictionary — types, units, examples. Useful for ERP exports.",
        ),
        ("", ""),
        ("COMMON MISTAKES", ""),
        (
            "✗",
            'Renaming the sheets — keep them as "Trading", "DIO", "Trial Balance".',
        ),
        (
            "✗",
            'Capital mismatch between Trading and DIO (e.g., "Cafea" vs "CAFEA"). '
            "Parser handles common variants but exact match is safest.",
        ),
        (
            "✗",
            "Putting anything in column A of the DIO days block (rows 28-52) — "
            "a DIO-days row is read only when column A is empty, column B holds "
            "the category and column D holds the days.",
        ),
        (
            "✗",
            'Adding columns before "Categ_Pr" in the Trading sheet — column order '
            "matters for the column-position fallback parser.",
        ),
        ("", ""),
        ("QUESTIONS?", "contact@cfo-ai.io"),
    ]
    for i, (label, body) in enumerate(rows, start=4):
        ws[f"A{i}"] = label
        ws[f"B{i}"] = body
        if label in ("HOW TO USE", "SHEETS IN THIS WORKBOOK", "COMMON MISTAKES", "QUESTIONS?"):
            ws[f"A{i}"].font = BOLD
            ws[f"A{i}"].fill = PatternFill("solid", start_color="F3F4F6")
            ws.merge_cells(start_row=i, start_column=1, end_row=i, end_column=4)
        else:
            ws[f"A{i}"].alignment = Alignment(horizontal="right", vertical="top")
            ws[f"B{i}"].alignment = Alignment(vertical="top", wrap_text=True)
            ws.merge_cells(start_row=i, start_column=2, end_row=i, end_column=4)
        ws.row_dimensions[i].height = 22
        if label == "EXAMPLE DATA":
            ws[f"A{i}"].font = BOLD
            ws.row_dimensions[i].height = 62

    _set_widths(ws, [18, 32, 32, 24])

    # Hide gridlines on the cover — looks more like a printed page.
    ws.sheet_view.showGridLines = False


# ──────────────────────────────────────────────────────────────────────
# THE EXAMPLE DATA — fictional, typed here, copied from nowhere.
# Customers are "RETAILER A" / "DISTRIBUITOR A", brands "MARCA A",
# products "… (exemplu)"; every figure is a round illustrative number.
# ──────────────────────────────────────────────────────────────────────

TRADING_EXAMPLES = [
    ["KA",   "RETAILER A",     "KA",   "RETAILER A",     "Alimentare", "CAFEA",     "MARCA A", "Cafea macinata 250g (exemplu)", "250g", 6000,  150000, 141000, 112800,  28200],
    ["KA",   "RETAILER B",     "KA",   "RETAILER B",     "Alimentare", "CAFEA",     "MARCA B", "Cafea boabe 1kg (exemplu)",     "1kg",  4500,  135000, 126000, 100800,  25200],
    ["DIST", "DISTRIBUITOR A", "DIST", "DISTRIBUITOR A", "Alimentare", "PASTE",     "MARCA C", "Paste scurte 500g (exemplu)",   "500g", 12000, 96000,  90000,  72000,   18000],
    ["KA",   "RETAILER C",     "KA",   "RETAILER C",     "Alimentare", "CIOCOLATA", "MARCA A", "Ciocolata neagra 100g (exemplu)", "100g", 400, 30000,  28000,  29500,   -1500],
    ["KA",   "RETAILER D",     "KA",   "RETAILER D",     "Alimentare", "OREZ",      "MARCA B", "Orez bob lung 1kg (exemplu)",   "1kg",  5000,  45000,  42000,  35700,   6300],
]

#: Region 1 — (category, stock units, 0, stock value RON, 0, RON per unit, 0, stock kg).
#: RON per unit = value ÷ units, to the cent.
DIO_REGION1 = [
    ("CAFEA",     40000, 0, 800000.00, 0, 20.00, 0, 10000.00),
    ("CIOCOLATA", 9000,  0, 63000.00,  0, 7.00,  0, 900.00),
    ("PASTE",     25000, 0, 100000.00, 0, 4.00,  0, 12500.00),
    ("OREZ",      6000,  0, 42000.00,  0, 7.00,  0, 6000.00),
    ("CEAI",      2000,  0, 30000.00,  0, 15.00, 0, 200.00),
]

#: Region 2 — (category, DIO days). 25 rows: rows 28..52.
DIO_REGION2 = [
    ("CAFEA",          60.0),
    ("CEAI",           45.0),
    ("PASTE",          40.0),
    ("OREZ",           35.0),
    ("FAINA",          25.0),
    ("ZAHAR",          30.0),
    ("CIOCOLATA",      410.0),  # the slow mover of the example
    ("BISCUITI",       55.0),
    ("NAPOLITANE",     50.0),
    ("CEREALE",        70.0),
    ("MIERE",          120.0),
    ("CONDIMENTE",     150.0),
    ("SARE",           20.0),
    ("APA MINERALA",   15.0),
    ("BAUTURI RACORITOARE", 28.0),
    ("SNACKS",         65.0),
    ("ALUNE SI SEMINTE", 90.0),
    ("FRUCTE USCATE",  110.0),
    ("CONSERVE CARNE", 180.0),
    ("LACTATE UHT",    38.0),
    ("MALAI",          32.0),
    ("LEGUMINOASE",    85.0),
    ("DROJDIE",        12.0),
    ("ARTICOLE SEZONIERE", 240.0),
    ("ALTE PRODUSE",   100.0),
]


def add_trading_sheet(wb: Workbook) -> None:
    """SKU-level transactions. The parser's primary source of revenue,
    volume, gross margin, and category attribution.

    Column order matters: the parser has a positional fallback that maps
    column INDEX → semantic when header names don't match exactly. So
    even if a user renames "Categ_Pr" to "Category" we still pick it up
    — as long as it stays in position 6. Don't reorder these headers.
    """
    ws = wb.create_sheet("Trading")

    headers = [
        "Canal",                           # 1
        "Client",                          # 2
        "Tip client",                      # 3
        "CLIENT_PARINTE",                  # 4
        "BU",                              # 5
        "Categ_Pr",                        # 6  ← MUST match DIO sheet
        "Brand",                           # 7
        "Denumire_Produs",                 # 8
        "PackSize",                        # 9
        "Sold in KG",                      # 10
        "GR Gross Revenue finished goods", # 11
        "Net Invoice Value",               # 12
        "Cost of Sales",                   # 13
        "Gross Margin",                    # 14
    ]

    comments = {
        "Canal": "Sales channel. KA = key accounts, DIST = distributors, EXPORT, HORECA, etc.",
        "Categ_Pr": (
            "Category name. MUST match a row in the DIO sheet (case-insensitive). "
            "If a SKU's category doesn't appear in DIO, it inherits null DIO."
        ),
        "Sold in KG": "Total volume sold in this row, in kilograms.",
        "Net Invoice Value": "NIV in RON. Revenue net of discounts, excluding VAT.",
        "Cost of Sales": "COGS in RON for this row.",
        "Gross Margin": "GM in RON. Computed as NIV − Cost of Sales.",
    }

    _style_header_row(ws, 1, headers, comments)

    # FICTIONAL rows. Net Invoice Value − Cost of Sales = Gross Margin on
    # every row; one row carries a negative margin so the example shows
    # what a loss-making SKU looks like.
    examples = TRADING_EXAMPLES
    for row_data in examples:
        ws.append(row_data)

    # Cell-level number formatting on the numeric columns. Tabular-num
    # so values right-align cleanly when users add their own rows.
    money_fmt = '#,##0.00;-#,##0.00;"—"'
    int_fmt = '#,##0;-#,##0;"—"'
    for r in range(2, 2 + len(examples)):
        ws.cell(row=r, column=10).number_format = int_fmt   # Sold in KG
        for c in (11, 12, 13, 14):
            ws.cell(row=r, column=c).number_format = money_fmt

    _set_widths(ws, [8, 14, 10, 14, 10, 22, 12, 36, 10, 12, 24, 18, 14, 14])
    ws.freeze_panes = "A2"

    # Mark example rows with subtle styling so the user knows to replace
    # them rather than appending below.
    example_note_font = Font(italic=True, color="9CA3AF", size=10)
    for r in range(2, 2 + len(examples)):
        for c in range(1, len(headers) + 1):
            ws.cell(row=r, column=c).font = example_note_font


def add_dio_sheet(wb: Workbook) -> None:
    """Per-category inventory + DIO days. Two regions in one sheet.

    Region 1 (rows 1..end-of-data) — inventory snapshot.
    Region 2 (rows 28..52) — DIO days. Read by `extract_category_dio`
    from _sales_extract.py: col A empty, col B = category name,
    col D = days.
    """
    ws = wb.create_sheet("DIO")
    today = datetime(AS_OF.year, AS_OF.month, AS_OF.day)

    # ──────────────────────────────────────────────────────────────
    # Row 1 — as-of dates across the value columns. Helps the
    # operator know when the snapshot was taken.
    # ──────────────────────────────────────────────────────────────
    ws["A1"] = ""
    for col in (2, 4, 5, 6, 7, 8):
        cell = ws.cell(row=1, column=col, value=today)
        cell.number_format = "dd.mm.yyyy"
        cell.font = BOLD
    ws.row_dimensions[1].height = 22

    # ──────────────────────────────────────────────────────────────
    # Row 2 — Region 1 headers. Wide spacing (empty cols) preserved
    # exactly because the parser reads named columns by header
    # match, not by column index — and the spacing makes Excel
    # render the snapshot readably.
    # ──────────────────────────────────────────────────────────────
    region1_headers = [
        "Grupa_Pr",                       # A
        "Stoc Cantitativ (UM)",           # B
        " ",                              # C
        "Stoc Valoric Standard (RON)",    # D
        " ",                              # E
        "Stoc RON / UM",                  # F
        " ",                              # G
        "Stoc KG",                        # H
    ]
    for col, h in enumerate(region1_headers, start=1):
        cell = ws.cell(row=2, column=col, value=h)
        cell.font = BOLD
        cell.fill = PatternFill("solid", start_color="F3F4F6")
        cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
    ws.row_dimensions[2].height = 32
    ws["A2"].comment = Comment(
        "Region 1: per-category inventory snapshot. "
        "Used for inventory value × financing cost in the Decision Rules engine.",
        PRODUCT_NAME,
    )

    # ──────────────────────────────────────────────────────────────
    # Region 1 data (rows 3..7) — same example categories as Trading
    # sheet so end-to-end smoke test shows matching values.
    # ──────────────────────────────────────────────────────────────
    region1_data = DIO_REGION1
    money_fmt = '#,##0.00;-#,##0.00;"—"'
    int_fmt = '#,##0;-#,##0;"—"'
    for i, row in enumerate(region1_data, start=3):
        for col, val in enumerate(row, start=1):
            cell = ws.cell(row=i, column=col, value=val)
            if col == 1:
                cell.font = BOLD
            elif col in (2, 8):
                cell.number_format = int_fmt
            elif col in (4, 6):
                cell.number_format = money_fmt

    # Rows 8-26 stay empty: a visible gap between the two regions. No
    # operator-context lines — the template carries no report header of
    # anyone's ERP.

    # ──────────────────────────────────────────────────────────────
    # Row 27 — annotation above Region 2. Plain English so the
    # operator knows what they're looking at.
    # ──────────────────────────────────────────────────────────────
    annotate = ws.cell(
        row=27,
        column=2,
        value="DIO days per category — canonical source (rows 28-52):",
    )
    annotate.font = Font(bold=True, italic=True, color="4B5563", size=10)
    annotate.comment = Comment(
        "Region 2: per-category DIO days. THIS is the canonical source "
        "the Products view reads from. Column B = category name, "
        "Column D = DIO days. Rows 28-52.",
        PRODUCT_NAME,
    )

    # Region 2 data (rows 28..52) — fictional categories and days.
    region2_data = DIO_REGION2
    assert len(region2_data) == 25, "Region 2 must fill rows 28..52 exactly"

    for i, (cat, days) in enumerate(region2_data, start=28):
        name_cell = ws.cell(row=i, column=2, value=cat)
        name_cell.font = BOLD
        days_cell = ws.cell(row=i, column=4, value=days)
        days_cell.number_format = "0.0"
        # Highlight the "days" cell faintly so it stands out as the
        # actual value the operator should care about.
        days_cell.fill = PatternFill("solid", start_color="FEF3C7")  # amber-100

    _set_widths(ws, [22, 24, 4, 28, 4, 16, 4, 16])
    ws.freeze_panes = "A3"


def add_trial_balance_sheet(wb: Workbook) -> None:
    """Optional. Only needed for Dashboard financial reports — Products
    view runs entirely off the Trading + DIO sheets.
    """
    ws = wb.create_sheet("Trial Balance")
    headers = ["Cont", "Denumire", "Sold debitor", "Sold creditor"]
    comments = {
        "Cont": "Romanian chart-of-accounts code. e.g. 1012, 2131, 401.",
        "Sold debitor": "Debit closing balance (RON). Use 0 if not applicable.",
        "Sold creditor": "Credit closing balance (RON). Use 0 if not applicable.",
    }
    _style_header_row(ws, 1, headers, comments)

    examples = [
        ["1012", "Capital subscris vărsat",    0,       100000],
        ["2131", "Echipamente tehnologice",    250000,  0],
        ["371",  "Mărfuri",                    1200000, 0],
        ["401",  "Furnizori",                  0,       450000],
        ["411",  "Clienți",                    340000,  0],
        ["5121", "Conturi la bănci în lei",    320000,  0],
        ["707",  "Venituri din vânzarea măr.", 0,       2400000],
        ["607",  "Cheltuieli privind măr.",    1800000, 0],
    ]
    money_fmt = '#,##0.00;-#,##0.00;"—"'
    for row in examples:
        ws.append(row)
    for r in range(2, 2 + len(examples)):
        ws.cell(row=r, column=3).number_format = money_fmt
        ws.cell(row=r, column=4).number_format = money_fmt

    _set_widths(ws, [10, 40, 18, 18])
    ws.freeze_panes = "A2"

    # Subtle note on the Trial Balance tab — it's optional, and we
    # don't want users to think they need to fill it in to use Products.
    ws.cell(row=12, column=1, value="OPTIONAL").font = BOLD
    ws.merge_cells(start_row=12, start_column=1, end_row=12, end_column=4)
    ws.cell(row=13, column=1, value=(
        "This sheet is only needed for the Dashboard's P&L / Balance Sheet / "
        "Cash Flow reports. The Products view runs entirely off the Trading "
        "and DIO sheets, so you can leave this blank if you only need SKU "
        "intelligence."
    )).font = SUBTLE_FONT
    ws.merge_cells(start_row=13, start_column=1, end_row=13, end_column=4)
    ws.row_dimensions[13].height = 44
    ws.cell(row=13, column=1).alignment = Alignment(wrap_text=True, vertical="top")


def add_field_reference_sheet(wb: Workbook) -> None:
    """Machine-readable column dictionary. Useful for users wiring up
    automated ERP → CFO AI exports — they can map their ERP columns to
    our column names by reading this sheet programmatically.
    """
    ws = wb.create_sheet("Field Reference")
    headers = ["Sheet", "Column", "Type", "Required", "Unit", "Example", "Notes"]
    _style_header_row(ws, 1, headers)

    refs = [
        # Trading sheet
        ("Trading",        "Canal",                         "text",   "yes", "—",     "KA",                       "Sales channel: KA / DIST / EXPORT / HORECA"),
        ("Trading",        "Client",                        "text",   "yes", "—",     "RETAILER A",               "Customer name"),
        ("Trading",        "Tip client",                    "text",   "no",  "—",     "KA",                       "Customer type — often duplicates Canal"),
        ("Trading",        "CLIENT_PARINTE",                "text",   "no",  "—",     "RETAILER A",               "Parent customer (for chains)"),
        ("Trading",        "BU",                            "text",   "no",  "—",     "Alimentare",               "Business unit"),
        ("Trading",        "Categ_Pr",                      "text",   "yes", "—",     "CAFEA",                    "MUST match a category in DIO sheet"),
        ("Trading",        "Brand",                         "text",   "yes", "—",     "MARCA A",                  "Product brand"),
        ("Trading",        "Denumire_Produs",               "text",   "yes", "—",     "Cafea macinata 250g",      "Product name (SKU display label)"),
        ("Trading",        "PackSize",                      "text",   "no",  "—",     "250g",                     "Package size"),
        ("Trading",        "Sold in KG",                    "number", "yes", "kg",    "6000",                     "Total volume sold (kilograms)"),
        ("Trading",        "GR Gross Revenue finished goods", "number", "yes", "RON", "150000",                   "Gross revenue before discounts"),
        ("Trading",        "Net Invoice Value",             "number", "yes", "RON",   "141000",                   "NIV — revenue net of discounts, excluding VAT"),
        ("Trading",        "Cost of Sales",                 "number", "yes", "RON",   "112800",                   "COGS for this row"),
        ("Trading",        "Gross Margin",                  "number", "yes", "RON",   "28200",                    "GM = NIV − COGS"),
        # DIO Region 1
        ("DIO Region 1",   "Grupa_Pr",                      "text",   "yes", "—",     "CAFEA",                    "Same as Categ_Pr in Trading sheet"),
        ("DIO Region 1",   "Stoc Cantitativ (UM)",          "number", "yes", "units", "40000",                    "Stock quantity in units"),
        ("DIO Region 1",   "Stoc Valoric Standard (RON)",   "number", "yes", "RON",   "800000",                   "Inventory value (used for financing-cost calc)"),
        ("DIO Region 1",   "Stoc RON / UM",                 "number", "no",  "RON",   "20.00",                    "Average per-unit inventory value"),
        ("DIO Region 1",   "Stoc KG",                       "number", "yes", "kg",    "10000",                    "Stock in kilograms"),
        # DIO Region 2 — the canonical source
        ("DIO Region 2",   "[col B] category name",         "text",   "yes", "—",     "CIOCOLATA",                "Category name. Rows 28-52."),
        ("DIO Region 2",   "[col D] DIO days",              "number", "yes", "days",  "410.0",                    "DIO days. Rows 28-52. THE canonical source."),
        # Trial Balance
        ("Trial Balance",  "Cont",                          "text",   "no",  "—",     "1012",                     "Romanian CoA code"),
        ("Trial Balance",  "Denumire",                      "text",   "no",  "—",     "Capital subscris vărsat",  "Account name"),
        ("Trial Balance",  "Sold debitor",                  "number", "no",  "RON",   "0",                        "Debit closing balance"),
        ("Trial Balance",  "Sold creditor",                 "number", "no",  "RON",   "100000",                   "Credit closing balance"),
    ]
    for row in refs:
        ws.append(row)

    # Highlight required rows with a faint amber tint — quick visual scan
    # for "what do I HAVE to fill in".
    required_fill = PatternFill("solid", start_color="FEF3C7")  # amber-100
    for r in range(2, 2 + len(refs)):
        required = ws.cell(row=r, column=4).value
        if required == "yes":
            for c in range(1, len(headers) + 1):
                ws.cell(row=r, column=c).fill = required_fill

    _set_widths(ws, [14, 32, 10, 10, 8, 26, 56])
    ws.freeze_panes = "A2"


# ──────────────────────────────────────────────────────────────────────
# Driver
# ──────────────────────────────────────────────────────────────────────


def template_bytes() -> bytes:
    """The workbook, byte-stable (see the module docstring)."""
    from build_public_sample_tb import _stable_zip

    wb = Workbook()
    # `Workbook()` ships a default "Sheet" — drop it before we add ours.
    wb.remove(wb.active)

    add_instructions_sheet(wb)
    add_trading_sheet(wb)
    add_dio_sheet(wb)
    add_trial_balance_sheet(wb)
    add_field_reference_sheet(wb)

    # Make sure the Instructions tab is the one that opens by default.
    wb.active = 0

    # Document properties: the product name and nothing else.
    stamp = datetime(AS_OF.year, AS_OF.month, AS_OF.day)
    wb.properties.creator = PRODUCT_NAME
    wb.properties.lastModifiedBy = PRODUCT_NAME
    wb.properties.title = PRODUCT_NAME
    wb.properties.created = stamp
    wb.properties.modified = stamp

    raw = io.BytesIO()
    wb.save(raw)
    return _stable_zip(raw.getvalue(), DOC_DATE)


def make_template() -> Path:
    """Build the workbook + write to disk. Returns the output path."""
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(template_bytes())
    return OUTPUT


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true",
                        help="compare the committed file with a rebuild; write nothing")
    args = parser.parse_args(argv)
    if args.check:
        stale = not OUTPUT.is_file() or OUTPUT.read_bytes() != template_bytes()
        print("upload template: %s" % (
            "STALE — run scripts/generate_upload_template.py" if stale else "PASS"))
        return 1 if stale else 0
    path = make_template()
    size_kb = path.stat().st_size / 1024
    print(f"Wrote {path.relative_to(REPO)}")
    print(f"  → {size_kb:.1f} KB · 5 sheets")
    return 0


if __name__ == "__main__":
    sys.exit(main())
