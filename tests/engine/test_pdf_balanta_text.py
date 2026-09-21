"""Text-line balanta PDF reader — every check refuses rather than approximates.

Synthetic book only (invented company, invented figures). The reader's job
is to hand the Excel path a balance that is EXACTLY the document, or nothing.
"""
from __future__ import annotations

from decimal import Decimal

import openpyxl
import io

from engine.country_packs.ro_romania import pdf_balanta_text as P

HEADER = [
    "EXEMPLU TEST SRL c.f. 1234567 r.c. J40/1/2020",
    "Balanta de verificare",
    "01.12.2025 -- 31.12.2025",
    "Solduri initiale an Rulaje perioada Sume totale Solduri finale",
    "Cont Denumirea contului",
    "Debitoare Creditoare Debitoare Creditoare Debitoare Creditoare Debitoare Creditoare",
]


def fmt(v: Decimal, euro: bool = False) -> str:
    s = f"{v:,.2f}"
    return s.replace(",", "X").replace(".", ",").replace("X", ".") if euro else s.replace(",", " ")


def book(euro: bool = False, n: int = 12, drop_class5: int = 0):
    """Two classes, n accounts each, balanced: every class-1 credit is mirrored by a class-5 debit."""
    lines = list(HEADER)
    c1, c5 = [], []
    for i in range(n):
        amt = Decimal(1000 + 137 * i) + Decimal("0.25")
        big = Decimal(1_234_567) + i
        c1.append((f"10{i:02d}", f"CAPITAL {i}", [Decimal(0), amt, Decimal(0), big, Decimal(0), amt + big, Decimal(0), amt + big]))
        c5.append((f"51{i:02d}", f"CONT BANCAR {i}", [amt, Decimal(0), big, Decimal(0), amt + big, Decimal(0), amt + big, Decimal(0)]))
    c5 = c5[drop_class5:]  # dropping class-5 rows keeps every class total honest but breaks D == C
    for cls, rows in (("1", c1), ("5", c5)):
        for cont, name, v in rows:
            lines.append(f"{cont} {name} " + " ".join(fmt(x, euro) for x in v))
        tot = [sum((r[2][i] for r in rows), Decimal(0)) for i in range(8)]
        lines.append(f"Total sume clasa {cls} " + " ".join(fmt(x, euro) for x in tot))
    lines.append("Intocmit, Conducatorul compartimentului financiar-contabil,")
    return lines


def test_a_verifiable_balanta_is_read_verbatim():
    got = P.parse_lines(book())
    assert got is not None
    assert len(got["rows"]) == 24 and got["number_format"] == "space"
    first = got["rows"][0]
    assert first["cont"] == "1000" and first["v"][1] == Decimal("1000.25")
    assert got["grand"][0] == got["grand"][1] and got["grand"][6] == got["grand"][7]


def test_european_number_format_reads_the_same_figures():
    a, b = P.parse_lines(book()), P.parse_lines(book(euro=True))
    assert b is not None and b["number_format"] == "euro"
    assert [r["v"] for r in a["rows"]] == [r["v"] for r in b["rows"]]


def test_the_class_digit_is_never_read_into_the_first_total():
    # "Total sume clasa 1 1 000.25 ..." must parse the total as 1 000.25, not 11 000.25
    got = P.parse_lines(book())
    assert got is not None  # would refuse on a class-sum mismatch if the digit leaked


def test_a_class_total_that_disagrees_refuses():
    lines = book()
    i = next(k for k, l in enumerate(lines) if l.startswith("1003 "))
    lines[i] = lines[i].replace("1 411.25", "1 411.26", 1)
    assert P.parse_lines(lines) is None


def test_debit_not_equal_credit_refuses():
    lines = book(drop_class5=1)  # class totals still match their rows; grand debit != credit
    assert P.parse_lines(lines) is None
    assert P.parse_lines(book()) is not None  # control: the same book, balanced, is read


def test_a_row_with_seven_figures_refuses():
    lines = book()
    i = next(k for k, l in enumerate(lines) if l.startswith("1004 "))
    parts = lines[i].rsplit(" ", 1)
    lines[i] = parts[0]  # drop the last figure
    assert P.parse_lines(lines) is None


def test_a_document_that_is_not_a_balanta_refuses():
    lines = [l for l in book() if "Balanta de verificare" not in l]
    assert P.parse_lines(lines) is None


def test_a_missing_class_total_refuses():
    lines = [l for l in book() if not l.startswith("Total sume clasa 5")]
    assert P.parse_lines(lines) is None


def test_a_parent_listed_beside_its_children_refuses():
    lines = book()
    i = next(k for k, l in enumerate(lines) if l.startswith("1001 "))
    lines.insert(i, lines[i].replace("1001 ", "100 ", 1))  # synthetic parent duplicating a child
    assert P.parse_lines(lines) is None


def test_too_few_accounts_refuses():
    assert P.parse_lines(book(n=5)) is None


def test_wrapped_names_continue_the_previous_account():
    lines = book()
    i = next(k for k, l in enumerate(lines) if l.startswith("1002 "))
    lines.insert(i + 1, "NEREPARTIZAT SAU PIERDERE")
    got = P.parse_lines(lines)
    assert got is not None
    assert next(r for r in got["rows"] if r["cont"] == "1002")["name"].endswith("NEREPARTIZAT SAU PIERDERE")


def test_the_workbook_is_the_saga_ten_column_layout_with_verbatim_figures():
    got = P.parse_lines(book())
    wb = openpyxl.load_workbook(io.BytesIO(P.to_saga_xlsx(got["rows"])))
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    assert rows[0] == ("BLN_CONT", "BLN_DENUMIRE", "SI DEBIT", "SI CREDIT", "RL DEBIT", "RL CREDIT",
                       "RC DEBIT", "RC CREDIT", "SF DEBIT", "SF CREDIT")
    assert rows[2][0] == "1000" and rows[2][3] == 1000.25 and rows[2][9] == float(Decimal("1000.25") + 1_234_567)
    assert len(rows) == 2 + 24
