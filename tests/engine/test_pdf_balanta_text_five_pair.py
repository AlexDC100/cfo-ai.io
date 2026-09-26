"""Text-line balanta PDF reader, five-pair layout — every check refuses
rather than approximates.

The WinMentor / SceptrumERP "Balanta analitica" prints five (debit, credit)
pairs: Sold initial / Rulaj anterior / Rulaj curent / Total rulaj / Sold
final, comma-thousands figures, dotted analytic codes, the code repeated
inside or after the name, "Clasa N" headings and "Total clasa N:" totals.

Synthetic book only (invented company, invented figures). Each refusal test
tampers ONE thing and recomputes every printed total from the tampered rows,
so the check under test is the only one that can fail — and each has a
control asserting the untampered book is read.
"""
from __future__ import annotations

import io
import logging
from decimal import Decimal
from typing import Iterable, List, Optional, Tuple

import openpyxl
import pytest

from engine.country_packs.ro_romania import pdf_balanta_text as P

Z = Decimal(0)

HEADER = [
    "Balanta analitica",
    "Societate: EXEMPLU TEST SRL",
    # the period prints at the end of the address line, as the text
    # extraction merges the title block's "Decembrie 2025" onto it
    "Adresa: Str. Exemplu 12 Oras Decembrie 2025",
    "C.U.I: RO1234567",
    "Cont Denumire Sold initial Rulaj anterior Rulaj curent Total rulaj Sold final",
    "Debit Credit Debit Credit Debit Credit Debit Credit Debit Credit",
]
FOOTER = [
    "®ExempluERP Utilizator: test.user",
    "Data si ora tiparirii: 02/01/2026 10:00 1 / 1",
    "Cod raport: exemplu/balantaAnalitica.rpt",
]


def fmt(v: Decimal) -> str:
    return f"{v:,.2f}"


class Row:
    """One account: the five pairs, with Total rulaj and Sold final derived
    from the identities unless a test overrides them."""

    def __init__(self, cont: str, text: str, si=(Z, Z), ra=(Z, Z), rl=(Z, Z),
                 tr: Optional[tuple] = None, sf: Optional[tuple] = None,
                 cont_lines: tuple = ()):
        self.cont, self.text, self.cont_lines = cont, text, cont_lines
        tr = tr or (ra[0] + rl[0], ra[1] + rl[1])
        if sf is None:
            net = (si[0] - si[1]) + (tr[0] - tr[1])
            sf = (net, Z) if net >= 0 else (Z, -net)
        self.v: List[Decimal] = [*si, *ra, *rl, *tr, *sf]

    def line(self) -> str:
        return f"{self.cont} {self.text} " + " ".join(fmt(x) for x in self.v)


def rows(n: int = 12) -> List[Row]:
    """n class-1 credit accounts, each mirrored by a class-5 debit account,
    so every pair balances. Row 3 carries a storno (negative Rulaj curent on
    its own side); the special spellings of the real layout are included."""
    out: List[Row] = []
    for i in range(n):
        a = Decimal(1000 + 137 * i) + Decimal("0.25")
        b = Decimal(1_234_567) + i
        c = Decimal(-250) if i == 3 else Decimal(20_000 + 11 * i) + Decimal("0.10")
        out.append(Row(f"10{i:02d}.01", f"CAPITAL {i}", si=(Z, a), ra=(Z, b), rl=(Z, c)))
        out.append(Row(f"51{i:02d}.01", f"CONT BANCAR {i}", si=(a, Z), ra=(b, Z), rl=(c, Z)))
    # the code repeated before the name, and a profit closing in credit
    out.append(Row("121", "121 Profit sau pierdere", ra=(Z, Decimal("5000.00")),
                   rl=(Z, Decimal("345.67"))))
    # a figure-shaped code ("531.01" reads like a figure) repeated after the name
    out.append(Row("531.01", "Casa in lei 531.01", ra=(Decimal("5000.00"), Z),
                   rl=(Decimal("345.67"), Z)))
    # the code repeated twice inside the name, and a wrapped name whose
    # continuation line holds the rest of the name and the code again
    out.append(Row("1068.07", "Rezerva de test - 1068.07 1068.07", rl=(Z, Decimal("77.00")),
                   cont_lines=("pentru exemplu fictiv 1068.07",)))
    out.append(Row("5125.01", "Sume in curs de decontare", rl=(Decimal("77.00"), Z),
                   cont_lines=("5125.01",)))
    return out


def _layout(rs: List[Row], *, grand: bool = True,
            page_break_after: Optional[str] = None) -> List[Tuple[str, str]]:
    """(column, text) per line: every line starts in the code column except
    a name's continuation lines, which the layout prints in the name
    column."""
    out = [("code", l) for l in HEADER]
    for cls in sorted({r.cont[0] for r in rs}):
        out.append(("code", f"Clasa {cls}"))
        mine = [r for r in rs if r.cont[0] == cls]
        for r in mine:
            out.append(("code", r.line()))
            if r.cont == page_break_after:
                out.extend(("code", l) for l in FOOTER + HEADER[4:])
            out.extend(("name", c) for c in r.cont_lines)
        tot = [sum((r.v[i] for r in mine), Z) for i in range(10)]
        out.append(("code", f"Total clasa {cls}: " + " ".join(fmt(x) for x in tot)))
    if grand:
        tot = [sum((r.v[i] for r in rs), Z) for i in range(10)]
        out.append(("code", "Total general: " + " ".join(fmt(x) for x in tot)))
    return out + [("code", l) for l in FOOTER]


def render(rs: List[Row], **kw) -> List[str]:
    """The book as plain text lines — no positions, as a caller handing
    the reader text alone would (the eight-figure tests' shape)."""
    return [text for _, text in _layout(rs, **kw)]


# ── positioned lines: the layout's two columns, as `_extract_lines` reads them ──
#
# The real layout prints every account's code at one x (the code column)
# and every name, and every continuation line, at another (the name
# column); pdfplumber gives each word's x-position and the reader decides
# what a line is by the column its first word is printed in.
CODE_X, NAME_X = 10.0, 75.0


def at(text: str, x: float) -> P.Line:
    """`text` as a positioned line whose first word starts at `x`; on a
    code-column line the second word starts at the name column, as the
    layout prints a name after its code."""
    words: List[P.Word] = []
    cursor = x
    for i, tok in enumerate(text.split()):
        if i == 1 and x == CODE_X:
            cursor = NAME_X
        words.append(P.Word(tok, cursor, cursor + 5.0 * len(tok)))
        cursor = words[-1].x1 + 4.0
    return P.Line(text, tuple(words))


def in_code_column(text: str) -> P.Line:
    return at(text, CODE_X)


def in_name_column(text: str) -> P.Line:
    return at(text, NAME_X)


def render_positioned(rs: List[Row], **kw) -> List[P.Line]:
    return [in_code_column(t) if col == "code" else in_name_column(t) for col, t in _layout(rs, **kw)]


def positioned(lines: List[str], name_column: Iterable[str] = ()) -> List[P.Line]:
    """Plain lines given positions: every line in the code column except
    those listed in `name_column`, which start at the name column."""
    nc = set(name_column)
    return [in_name_column(l) if l in nc else in_code_column(l) for l in lines]


def book(**kw) -> List[str]:
    return render(rows(), **kw)


def by_cont(got, cont):
    return next(r for r in got["rows"] if r["cont"] == cont)


# ── accepted ────────────────────────────────────────────────────────────


def test_a_verifiable_five_pair_balanta_is_read_verbatim():
    got = P.parse_lines(book())
    assert got is not None
    assert got["layout"] == "five_pair" and got["number_format"] == "comma"
    assert len(got["rows"]) == 28 and got["classes"] == ["1", "5"]
    first = by_cont(got, "1000.01")
    assert first["figures"] == [Z, Decimal("1000.25"), Z, Decimal(1_234_567), Z, Decimal("20000.10"),
                                Z, Decimal("1254567.10"), Z, Decimal("1255567.35")]
    for i in range(0, 10, 2):
        assert got["grand"][i] == got["grand"][i + 1]


def test_the_row_carries_sold_initial_rulaj_curent_total_rulaj_sold_final():
    got = P.parse_lines(book())
    r = by_cont(got, "1000.01")
    f = r["figures"]
    assert r["v"] == [f[0], f[1], f[4], f[5], f[6], f[7], f[8], f[9]]  # Rulaj anterior not carried


def test_the_grand_total_is_optional():
    assert P.parse_lines(book(grand=False)) is not None


def test_repeated_codes_are_stripped_from_names():
    got = P.parse_lines(book())
    assert by_cont(got, "121")["name"] == "Profit sau pierdere"
    assert by_cont(got, "531.01")["name"] == "Casa in lei"
    assert by_cont(got, "1068.07")["name"] == "Rezerva de test pentru exemplu fictiv"
    assert by_cont(got, "5125.01")["name"] == "Sume in curs de decontare"


def test_a_figure_shaped_code_repeated_after_the_name_is_not_read_as_a_figure():
    got = P.parse_lines(book())
    assert by_cont(got, "531.01")["figures"][:4] == [Z, Z, Decimal("5000.00"), Z]


def test_a_storno_is_carried_verbatim_on_its_own_side():
    got = P.parse_lines(book())
    debit, credit = by_cont(got, "5103.01"), by_cont(got, "1003.01")
    assert debit["figures"][4:6] == [Decimal(-250), Z]     # negative Rulaj curent, debit side
    assert credit["figures"][4:6] == [Z, Decimal(-250)]    # never flipped to the other side


def test_a_name_continues_across_a_page_header():
    lines = render(rows(), page_break_after="1068.07")
    got = P.parse_lines(lines)
    assert got is not None
    assert by_cont(got, "1068.07")["name"] == "Rezerva de test pentru exemplu fictiv"


def test_the_workbook_maps_si_rulaj_curent_total_rulaj_sf():
    got = P.parse_lines(book())
    ws = openpyxl.load_workbook(io.BytesIO(P.to_saga_xlsx(got["rows"]))).active
    out = list(ws.iter_rows(values_only=True))
    assert out[0] == ("BLN_CONT", "BLN_DENUMIRE", "SI DEBIT", "SI CREDIT", "RL DEBIT", "RL CREDIT",
                      "RC DEBIT", "RC CREDIT", "SF DEBIT", "SF CREDIT")
    row = next(x for x in out[2:] if x[0] == "1000.01")
    assert row[2:] == (0.0, 1000.25, 0.0, 20000.10, 0.0, 1254567.10, 0.0, 1255567.35)
    storno = next(x for x in out[2:] if x[0] == "5103.01")
    assert storno[4] == -250.0 and storno[5] == 0.0
    assert len(out) == 2 + 28


# ── refused ─────────────────────────────────────────────────────────────
#
# Every refusal asserts WHICH check refused (the reader logs its reason), so
# a tamper that trips some other check first can never pass for the one
# under test.


def refused(caplog, lines: List[str], why: str) -> bool:
    caplog.clear()
    with caplog.at_level(logging.INFO, logger=P.logger.name):
        out = P.parse_lines(lines)
    assert out is None, "the tampered book was read"
    assert why in caplog.text, caplog.text
    return True


def _tamper(cont: str, col: int, delta: Decimal, mirror: str, mirror_col: int) -> List[str]:
    """Move one figure of `cont` and the same amount on `mirror` (the other
    side), then recompute every printed total — class sums and debit ==
    credit stay true, so only a per-row check can refuse."""
    rs = rows()
    for r in rs:
        if r.cont == cont:
            r.v[col] += delta
        if r.cont == mirror:
            r.v[mirror_col] += delta
    return render(rs)


def _replace_line(prefix: str, fn) -> List[str]:
    lines = book()
    i = next(k for k, l in enumerate(lines) if l.startswith(prefix))
    lines[i] = fn(lines[i])
    return lines


def test_the_untampered_book_is_read():  # the control for every refusal below
    assert P.parse_lines(book()) is not None


def test_total_rulaj_that_is_not_anterior_plus_curent_refuses(caplog):
    # Rulaj anterior moves one ban; Total rulaj and Sold final do not
    lines = _tamper("5102.01", P._RA_D, Decimal("0.01"), "1002.01", P._RA_C)
    assert refused(caplog, lines, "account 1002.01: total rulaj != rulaj anterior + rulaj curent")


def test_sold_final_that_is_not_initial_plus_total_rulaj_refuses(caplog):
    lines = _tamper("5104.01", P._SF_D, Decimal("0.01"), "1004.01", P._SF_C)
    assert refused(caplog, lines, "account 1004.01: sold final != sold initial + total rulaj")


def test_a_class_total_that_disagrees_refuses(caplog):
    def bump_si_debit(line):
        parts = line.split(" ")
        parts[3] = fmt(Decimal(parts[3].replace(",", "")) + Decimal("0.01"))
        return " ".join(parts)
    assert refused(caplog, _replace_line("Total clasa 5:", bump_si_debit), "class 5 sums")


def test_a_grand_total_that_disagrees_refuses(caplog):
    lines = _replace_line("Total general:", lambda l: l.replace("Total general: ", "Total general: 1", 1))
    assert refused(caplog, lines, "!= printed grand total")


def test_a_missing_class_total_refuses(caplog):
    lines = [l for l in book() if not l.startswith("Total clasa 5:")]
    assert refused(caplog, lines, "no printed total for class 5")


def test_a_class_total_printed_twice_refuses(caplog):
    lines = book()
    i = next(k for k, l in enumerate(lines) if l.startswith("Total clasa 1:"))
    lines.insert(i, lines[i])
    assert refused(caplog, lines, "class 1 total printed twice")


def test_a_nonzero_total_for_a_class_with_no_accounts_refuses(caplog):
    lines = book()
    i = next(k for k, l in enumerate(lines) if l.startswith("Clasa 5"))
    lines.insert(i, "Total clasa 3: " + " ".join(["1.00"] * 10))
    assert refused(caplog, lines, "class 3 sums")


def test_a_total_line_without_ten_figures_refuses(caplog):
    lines = _replace_line("Total clasa 1:", lambda l: l.rsplit(" ", 1)[0])
    assert refused(caplog, lines, "class 1 total does not carry exactly ten figures")


def test_debit_not_equal_credit_refuses(caplog):
    rs = [r for r in rows() if r.cont != "5100.01"]  # class totals follow their rows; grand D != C
    assert refused(caplog, render(rs), "pair 0 debit")


def test_a_row_with_nine_figures_refuses(caplog):
    lines = _replace_line("1004.01 ", lambda l: l.rsplit(" ", 1)[0])
    assert refused(caplog, lines, "account 1004.01 carries 9 figures, not 10")


def test_a_row_with_eleven_figures_refuses(caplog):
    lines = _replace_line("1004.01 ", lambda l: l.replace("CAPITAL 4 ", "CAPITAL 4 7.00 ", 1))
    assert refused(caplog, lines, "account 1004.01 carries 11 figures, not 10")


def test_an_account_listed_twice_refuses(caplog):
    rs = rows()
    rs += [r for r in rows() if r.cont in ("1005.01", "5105.01")]  # sums and D == C still hold
    assert refused(caplog, render(rs), "an account appears twice")


def test_a_figure_line_that_is_neither_account_nor_total_refuses(caplog):
    lines = book()
    i = next(k for k, l in enumerate(lines) if l.startswith("1006.01 "))
    lines.insert(i + 1, "Subtotal " + " ".join(["0.00"] * 10))
    assert refused(caplog, lines, "neither an account nor a total")


def test_an_account_line_without_its_code_refuses(caplog):
    lines = _replace_line("1006.01 ", lambda l: l.split(" ", 1)[1])
    assert refused(caplog, lines, "neither an account nor a total")


def test_a_page_footer_carrying_figures_refuses(caplog):
    lines = book()
    lines.insert(len(lines) - 1, "Pagina 1 " + " ".join(["0.00"] * 10))
    assert refused(caplog, lines, "a page header/footer line carries figures")


def test_a_second_number_format_refuses(caplog):
    # one figure without thousands separators — never read as a figure
    lines = _replace_line("1007.01 ", lambda l: l.replace("1,234,574.00", "1234574.00", 1))
    assert refused(caplog, lines, "account 1007.01 carries 6 figures, not 10")


def _swap_columns(line: str, order: List[int]) -> str:
    """Reprint a row's (or total's) ten figures in another column order."""
    parts = line.split(" ")
    tail = parts[-10:]
    if len(parts) < 11 or not all(P._FIG_5PAIR.match(t) for t in tail):
        return line
    return " ".join(parts[:-10] + [tail[i] for i in order])


RULAJ_CURENT_FIRST = [0, 1, 4, 5, 2, 3, 6, 7, 8, 9]


def test_rulaj_curent_printed_before_rulaj_anterior_refuses(caplog):
    # Every row and total reprinted curent-first under a header that says
    # so: Total rulaj = anterior + curent still holds, so only the header
    # can tell — and the prior period's turnover would go out as RL.
    swapped = "Cont Denumire Sold initial Rulaj curent Rulaj anterior Total rulaj Sold final"
    lines = [swapped if l.startswith("Cont Denumire") else _swap_columns(l, RULAJ_CURENT_FIRST)
             for l in book()]
    assert refused(caplog, lines, "column header reads")


def test_the_curent_first_book_is_otherwise_consistent():
    # the control for the test above: with the canonical header restored,
    # the swapped figures pass every arithmetic check — proof that the
    # header is the only thing that refuses them
    lines = [_swap_columns(l, RULAJ_CURENT_FIRST) for l in book()]
    got = P.parse_lines(lines)
    assert got is not None
    assert by_cont(got, "1000.01")["figures"][2:6] == [Z, Decimal("20000.10"), Z, Decimal(1_234_567)]


def test_a_reworded_column_header_refuses(caplog):
    lines = _replace_line("Cont Denumire", lambda l: l + " Observatii")
    assert refused(caplog, lines, "column header reads")


def test_a_column_header_split_over_two_lines_refuses(caplog):
    lines = book()
    i = lines.index(HEADER[4])
    lines[i:i + 1] = ["Cont Denumire Sold initial Rulaj anterior",
                      "Rulaj curent Total rulaj Sold final"]
    assert refused(caplog, lines, "column header reads")


def test_an_account_printed_before_the_column_header_refuses(caplog):
    lines = book()
    first = next(k for k, l in enumerate(lines) if l.startswith("1000.01 "))
    row = lines.pop(first)
    lines.insert(1, row)  # still inside the first 40 lines; totals unchanged
    assert refused(caplog, lines, "account 1000.01 is printed before the column header")


CREDIT_FIRST = [1, 0, 3, 2, 5, 4, 7, 6, 9, 8]


def test_a_book_printed_credit_first_refuses(caplog):
    # Every pair reprinted credit-first under a sub-header that says so.
    # Total rulaj, sold final, class sums and debit == credit are all
    # symmetric in the sides, so only the sub-header can tell — read as
    # debit-first, the 121 profit would serve as a loss.
    lines = [" ".join(["Credit Debit"] * 5) if l.startswith("Debit Credit")
             else _swap_columns(l, CREDIT_FIRST) for l in book()]
    assert refused(caplog, lines, "the column header is not followed by the Debit/Credit sub-header")


def test_the_credit_first_book_is_otherwise_consistent():
    # the control: under the canonical sub-header the flipped figures pass
    # every arithmetic check, so the sub-header is the only thing that
    # refuses them
    got = P.parse_lines([_swap_columns(l, CREDIT_FIRST) for l in book()])
    assert got is not None
    assert by_cont(got, "121")["figures"][8:] == [Decimal("5345.67"), Z]  # a profit read as a loss


def test_a_book_without_the_debit_credit_sub_header_refuses(caplog):
    lines = [l for l in book() if not l.startswith("Debit Credit")]
    assert refused(caplog, lines, "the column header is not followed by the Debit/Credit sub-header")


def test_a_mixed_sub_header_refuses(caplog):
    mixed = "Debit Credit Debit Credit Credit Debit Debit Credit Debit Credit"
    lines = [mixed if l.startswith("Debit Credit") else l for l in book()]
    assert refused(caplog, lines, "the column header is not followed by the Debit/Credit sub-header")


def test_a_sub_header_away_from_the_column_header_refuses(caplog):
    lines = book()
    i = next(k for k, l in enumerate(lines) if l.startswith("Clasa 5"))
    lines.insert(i, HEADER[5])
    assert refused(caplog, lines, "does not directly follow the column header")


def _book_with_a_zero_row_and_a_payable() -> List[Row]:
    rs = rows()
    rs.append(Row("4111.07", "Clienti interni"))  # printed, all zeros
    rs.append(Row("4011.01", "Furnizori interni", si=(Z, Decimal("900.00")), rl=(Z, Decimal("100.00"))))
    rs.append(Row("5199.01", "Banca Y", si=(Decimal("900.00"), Z), rl=(Decimal("100.00"), Z)))
    return rs


def _merge(lines: List[str], first: str, second: str) -> List[str]:
    """Put two account rows on ONE text line, `first` leading."""
    out = list(lines)
    i = next(k for k, l in enumerate(out) if l.startswith(first + " "))
    j = next(k for k, l in enumerate(out) if l.startswith(second + " "))
    merged = out[i] + " " + out[j]
    out[min(i, j)] = merged
    del out[max(i, j)]
    return out


def test_the_zero_row_book_is_read():  # the control for the two tests below
    got = P.parse_lines(render(_book_with_a_zero_row_and_a_payable()))
    assert by_cont(got, "4011.01")["figures"][9] == Decimal("1000.00")
    assert by_cont(got, "4111.07")["figures"] == [Z] * 10


def test_two_rows_on_one_line_refuses(caplog):
    # The all-zero client row leads; without the check its code took the
    # payable's figures (a 1,000 payable served as a negative receivable)
    # and 4011.01 vanished — class sums still tie, both are class 4.
    lines = _merge(render(_book_with_a_zero_row_and_a_payable()), "4111.07", "4011.01")
    assert refused(caplog, lines, "account 4111.07: its name carries 10 figure-shaped tokens")


def test_a_name_holding_a_code_and_a_figure_refuses(caplog):
    lines = _replace_line("1004.01 ", lambda l: l.replace("CAPITAL 4 ", "CAPITAL 4 4011.01 7.00 EXEMPLU ", 1))
    assert refused(caplog, lines, "account 1004.01: its name holds a code followed by a figure")


def test_a_single_figure_shaped_word_in_a_name_is_still_read():
    lines = _replace_line("1004.01 ", lambda l: l.replace("CAPITAL 4 ", "CAPITAL 4.50 PROCENT ", 1))
    got = P.parse_lines(lines)
    assert got is not None and by_cont(got, "1004.01")["name"] == "CAPITAL 4.50 PROCENT"


def _client_rows(client_text: str = "Client 404 Media SRL") -> List[Row]:
    rs = rows()
    rs.append(Row("4011.09", "Furnizor Y", si=(Z, Decimal("7000.00")), rl=(Z, Decimal("500.00"))))
    rs.append(Row("4111.05", client_text, si=(Decimal("7000.00"), Z), rl=(Decimal("500.00"), Z)))
    return rs


def _book_with_a_client(client_text: str = "Client 404 Media SRL") -> List[str]:
    return render(_client_rows(client_text))


def _wrap(lines: List[str], cont: str, first_line: str) -> List[str]:
    """Wrap `cont`'s row: `first_line` on its own text line, the rest of
    the row (after "<cont> Client") on the next — which starts with
    whatever the name continues with."""
    out = list(lines)
    i = next(k for k, l in enumerate(out) if l.startswith(cont + " "))
    toks = out[i].split(" ")
    out[i:i + 1] = [first_line, " ".join(toks[2:])]
    return out


def _wrap_placed(pairs: List[Tuple[str, str]], cont: str, first_line: str,
                 figure_line_column: float) -> List[P.Line]:
    """`_layout` pairs with `cont`'s row wrapped: `first_line` in the code
    column, the rest of the row (after "<cont> Client") on a line printed
    in `figure_line_column`; every other line where the layout prints
    it."""
    out: List[P.Line] = []
    for col, text in pairs:
        if text.startswith(cont + " "):
            out.append(in_code_column(first_line))
            out.append(at(" ".join(text.split(" ")[2:]), figure_line_column))
        else:
            out.append(in_code_column(text) if col == "code" else in_name_column(text))
    return out


def _wrapped_client(client_text: str = "Client 404 Media SRL", first_line: str = "4111.05 Client",
                    figure_line_column: float = NAME_X) -> List[P.Line]:
    """The client book with 4111.05's row wrapped — `first_line` in the
    code column, the rest of the row on a line printed in
    `figure_line_column` — every other line where the layout prints it."""
    return _wrap_placed(_layout(_client_rows(client_text)), "4111.05", first_line, figure_line_column)


def test_the_client_book_is_read():  # the control for the wrap tests below
    got = P.parse_lines(_book_with_a_client())
    assert by_cont(got, "4111.05")["figures"][8] == Decimal("7500.00")


def test_the_positioned_book_is_read_like_the_plain_one():
    plain, placed = P.parse_lines(render(rows())), P.parse_lines(render_positioned(rows()))
    assert placed is not None
    assert [(r["cont"], r["name"], r["v"]) for r in placed["rows"]] == \
        [(r["cont"], r["name"], r["v"]) for r in plain["rows"]]
    assert by_cont(placed, "1068.07")["name"] == "Rezerva de test pentru exemplu fictiv"


# ── only the layout's STRUCTURE decides a wrap — the column a line's first
#    word is printed in — never the text ──
#
# Round 3 settled a figure-less line led by a code-shaped word by TEXT: it
# was the previous account's continuation when it ended with that
# account's code, and the next account line then had to repeat its own
# code in one of the layout's slots. Round 4 found the coincidence that
# still steers a row's figures to the wrong account: a wrapped client row
# whose first line happens to end with the previous code, and whose figure
# line repeats a number from the name right before the figures —
#     4011.09 Furnizor Y <figures>
#     4111.05 Client 4011.09
#     404 Media SRL 404 <figures>
# read as account 404 (fixed-asset suppliers, a liability) carrying the
# receivable, "4111.05 Client" folded into the supplier's name, every total
# tied. Now the layout's columns decide: "4111.05" is printed in the code
# column (that row's first line), "404" in the name column (name text), so
# the figures are 4111.05's — and plain text, which has no columns, is
# refused rather than settled.


def test_a_wrapped_row_whose_first_line_ends_with_the_previous_code_is_refused_in_plain_text(caplog):
    # the round-4 coincidence, as plain text: no text rule may settle it
    lines = _wrap(_book_with_a_client("Client 404 Media SRL 404"), "4111.05", "4111.05 Client 4011.09")
    assert refused(caplog, lines, "the line led by the code-shaped 4111.05 carries no column position")


def test_a_wrapped_row_whose_first_line_ends_with_the_previous_code_is_read_by_its_columns():
    # the same book with the layout's positions: the held first line is in
    # the code column, its figure line in the name column — the receivable
    # is 4111.05's, whole, and no account 404 exists
    got = P.parse_lines(_wrapped_client("Client 404 Media SRL 404", "4111.05 Client 4011.09"))
    assert got is not None
    client = by_cont(got, "4111.05")
    assert client["name"] == "Client 4011.09 404 Media SRL 404" and client["figures"][8] == Decimal("7500.00")
    assert by_cont(got, "4011.09")["name"] == "Furnizor Y"
    assert not any(r["cont"] == "404" for r in got["rows"])


@pytest.mark.parametrize("client_text, first_line", [
    ("Client 404 Media SRL", "4111.05 Client"),
    ("Client 404 Media SRL", "4111.05"),
    ("Client 404 Media 404 SRL", "4111.05 Client"),   # 404 recurs mid-line
    ("Client 404 Media SRL 404", "4111.05 Client"),   # 404 recurs right before the figures
], ids=["name-then-number", "code-alone", "number-recurs-mid-line", "number-recurs-before-figures"])
def test_a_wrapped_row_in_plain_text_refuses_whatever_the_figure_line_repeats(caplog, client_text, first_line):
    # "4111.05 Client" / "404 Media SRL <ten figures>": read naively, the
    # receivable is served as account 404 and 4111.05 vanishes — both
    # class 4, every total ties; and no recurrence of 404 is evidence
    lines = _wrap(_book_with_a_client(client_text), "4111.05", first_line)
    assert refused(caplog, lines, "the line led by the code-shaped 4111.05 carries no column position")


@pytest.mark.parametrize("client_text, first_line", [
    ("Client 404 Media SRL", "4111.05 Client"),
    ("Client 404 Media SRL", "4111.05"),
    ("Client 404 Media 404 SRL", "4111.05 Client"),
    ("Client 404 Media SRL 404", "4111.05 Client"),
], ids=["name-then-number", "code-alone", "number-recurs-mid-line", "number-recurs-before-figures"])
def test_a_wrapped_row_is_read_whole_when_its_figure_line_is_in_the_name_column(client_text, first_line):
    got = P.parse_lines(_wrapped_client(client_text, first_line))
    assert got is not None
    client = by_cont(got, "4111.05")
    # the name as the two lines print it ("4111.05" alone on the first
    # line leaves the figure line to carry the name from its second word)
    printed = client_text if first_line.endswith(" Client") else client_text.split(" ", 1)[1]
    assert client["name"] == printed and client["figures"][8] == Decimal("7500.00")
    assert not any(r["cont"] == "404" for r in got["rows"])


def test_a_wrapped_rows_figure_line_in_the_code_column_refuses(caplog):
    # "404 Media SRL <figures>" printed in the CODE column is account 404's
    # line — and then 4111.05's first line never got its figures
    lines = _wrapped_client(figure_line_column=CODE_X)
    assert refused(caplog, lines, "account 404 follows a line led by the code-shaped 4111.05 that is "
                                  "printed in the code column without its ten figures")


def test_the_coincidence_books_are_read_unwrapped():
    # the control: printed on one line, both names are read whole on
    # 4111.05, and no account 404 appears
    for text in ("Client 404 Media 404 SRL", "Client 404 Media SRL 404"):
        got = P.parse_lines(_book_with_a_client(text))
        assert got is not None and by_cont(got, "4111.05")["name"] == text
        assert not any(r["cont"] == "404" for r in got["rows"])


def _continued_by(cont_line: str, next_text: str = "CAPITAL 7", cont_lines: tuple = ()) -> List[Row]:
    """1006.01 continued by `cont_line` (led by a code-shaped word, a
    year), then 1007.01 printed as `next_text` — the real layout's one
    such line per book."""
    rs = rows()
    for r in rs:
        if r.cont == "1006.01":
            r.cont_lines = (cont_line,)
        if r.cont == "1007.01":
            r.text, r.cont_lines = next_text, cont_lines
    return rs


@pytest.mark.parametrize("cont_line", ["2019 1006.01", "2019 extins", "2019"],
                         ids=["ends-with-the-code", "does-not", "number-alone"])
def test_a_continuation_led_by_a_number_is_name_text_in_the_name_column(cont_line):
    # whatever the line reads — ending with the previous code or not — its
    # column says it is name text; and 1007.01 need not repeat its code
    got = P.parse_lines(render_positioned(_continued_by(cont_line)))
    assert got is not None
    assert by_cont(got, "1006.01")["name"] == ("CAPITAL 6 " + cont_line.replace(" 1006.01", "")).strip()
    assert by_cont(got, "1007.01")["name"] == "CAPITAL 7"


@pytest.mark.parametrize("cont_line, next_text, cont_lines", [
    ("2019 1006.01", "CAPITAL 7 1007.01", ()),         # round 3 read this: ends with the code, repeat before the figures
    ("2019 1006.01", "1007.01 CAPITAL 7", ()),         # ... repeat right after the code
    ("2019 1006.01", "CAPITAL 7", ("REZERVA 1007.01",)),  # ... repeat ending a continuation line
    ("2019 1006.01", "CAPITAL 7", ()),
    ("2019 extins", "CAPITAL 7 1007.01", ()),
    ("2019 1006.01", "CAPITAL 1007.01 SAPTE", ()),
], ids=["repeat-before-figures", "repeat-after-code", "repeat-on-continuation", "no-repeat",
        "no-code-at-the-end", "repeat-mid-name"])
def test_a_continuation_led_by_a_number_is_refused_in_plain_text_whatever_the_text_says(
        caplog, cont_line, next_text, cont_lines):
    # no text rule settles a code-shaped first word: not the line ending
    # with the previous code, not the next account repeating its own
    lines = render(_continued_by(cont_line, next_text, cont_lines))
    assert refused(caplog, lines, "the line led by the code-shaped 2019 carries no column position")


def test_a_continuation_holding_only_the_accounts_own_code_is_read_in_plain_text():
    # the one code-led line plain text CAN place: the current account's
    # own code (the layout's repeat) — a second row with that code would
    # be a duplicate, refused
    got = P.parse_lines(book())
    assert got is not None and by_cont(got, "5125.01")["name"] == "Sume in curs de decontare"


def test_a_code_alone_in_the_code_column_is_a_held_first_line_not_a_repeat(caplog):
    # the layout prints the repeated code in the NAME column; in the code
    # column it is a row's first line without its figures
    lines = render_positioned(rows())
    i = next(k for k, l in enumerate(lines) if l.text == "5125.01")
    lines[i] = in_code_column("5125.01")
    assert refused(caplog, lines, "the line led by the code-shaped 5125.01 is followed by 'Total clasa 5:'")


# ── anything the structure cannot place is refused ──────────────────────


def test_a_line_between_the_columns_refuses(caplog):
    lines = render_positioned(_continued_by("2019 extins"))
    i = next(k for k, l in enumerate(lines) if l.text == "2019 extins")
    lines[i] = at("2019 extins", (CODE_X + NAME_X) / 2)
    assert refused(caplog, lines, "starts between the code column (x=10.0) and the name column (x=75.0)")


def test_a_line_in_the_code_column_that_is_not_an_account_refuses(caplog):
    lines = render_positioned(rows())
    i = next(k for k, l in enumerate(lines) if l.text == "pentru exemplu fictiv 1068.07")
    lines[i] = in_code_column("pentru exemplu fictiv 1068.07")
    assert refused(caplog, lines, "is printed in the code column but is not an account line")


def test_an_account_line_in_the_name_column_refuses(caplog):
    # ten figures on a name-column line with no row held: figures the
    # layout attributes to no account
    lines = render_positioned(rows())
    i = next(k for k, l in enumerate(lines) if l.text.startswith("1007.01 "))
    lines[i] = in_name_column(lines[i].text)
    assert refused(caplog, lines, "a line with figures is neither an account nor a total")


def test_columns_that_cannot_be_told_apart_refuse(caplog):
    lines = [P.Line(l.text, tuple(P.Word(w.text, min(w.x0, CODE_X + 3.0), w.x1) for w in l.words))
             for l in render_positioned(rows())]
    assert refused(caplog, lines, "the code column (x=10.0) and the name column (x=13.0) cannot be told apart")


def test_a_wrapped_row_may_continue_over_several_name_column_lines():
    lines = _wrapped_client("Client 404 Media SRL", "4111.05 Client")
    j = next(k for k, l in enumerate(lines) if l.text == "4111.05 Client") + 1
    figure_line = lines[j].text
    lines[j:j + 1] = [in_name_column("404 Media"), in_name_column("SRL " + figure_line.split(" ", 3)[3])]
    got = P.parse_lines(lines)
    assert got is not None and by_cont(got, "4111.05")["name"] == "Client 404 Media SRL"
    assert by_cont(got, "4111.05")["figures"][8] == Decimal("7500.00")


# ── a wrapped row whose two lines straddle a heading or total ────────────
#
# A heading or total between a held line and its figure line must never
# settle the held line into the previous account's name and let the figure
# line through as an account of its own: the client's figures would go to
# account 404 and 4111.05 vanish — every total still tied.


def _client_after_a_supplier() -> List[str]:
    return render(_client_rows())


def _split_client_by(between: str, move: bool = False) -> List[P.Line]:
    """Wrap 4111.05 as "4111.05 Client" / "404 Media SRL <ten figures>", with
    `between` printed between the two lines (in the code column, where the
    layout prints headings, totals and page headers) — moved there from
    where the book prints it when `move`."""
    out = _wrap_placed(_layout(_client_rows()), "4111.05", "4111.05 Client", NAME_X)
    if move:
        out.remove(in_code_column(between))
    i = next(k for k, l in enumerate(out) if l.text == "4111.05 Client")
    out.insert(i + 1, in_code_column(between))
    return out


def test_the_supplier_then_client_book_is_read():  # the control for the tests below
    got = P.parse_lines(_client_after_a_supplier())
    assert by_cont(got, "4111.05")["figures"][8] == Decimal("7500.00")
    assert by_cont(got, "4011.09")["name"] == "Furnizor Y"


def test_a_class_heading_between_the_two_lines_of_a_wrapped_row_refuses(caplog):
    # the heading repeated where a page breaks inside the row
    assert refused(caplog, _split_client_by("Clasa 4"),
                   "the line led by the code-shaped 4111.05 is followed by 'Clasa 4'")


def test_a_class_total_between_the_two_lines_of_a_wrapped_row_refuses(caplog):
    # the printed class-4 total still counts the client's figures, and so
    # does 404 (a class-4 code): every sum ties
    total = next(l for l in _client_after_a_supplier() if l.startswith("Total clasa 4:"))
    assert refused(caplog, _split_client_by(total, move=True),
                   "the line led by the code-shaped 4111.05 is followed by 'Total clasa 4:")


def test_a_page_header_between_the_two_lines_of_a_wrapped_row_refuses(caplog):
    assert refused(caplog, _split_client_by(FOOTER[1]),
                   "the line led by the code-shaped 4111.05 is followed by a page header or footer")


def test_a_column_header_between_the_two_lines_of_a_wrapped_row_refuses(caplog):
    assert refused(caplog, _split_client_by(HEADER[4]),
                   "the line led by the code-shaped 4111.05 is followed by a page header")


def test_a_held_line_at_the_end_of_the_document_refuses(caplog):
    lines = render_positioned(rows()) + [in_code_column("4111.05 Client")]
    assert refused(caplog, lines, "the line led by the code-shaped 4111.05 is followed by the end of the document")


def test_a_held_line_before_the_page_footer_refuses(caplog):
    lines = render_positioned(rows())
    lines.insert(next(k for k, l in enumerate(lines) if l.text == FOOTER[0]), in_code_column("4111.05 Client"))
    assert refused(caplog, lines, "the line led by the code-shaped 4111.05 is followed by a page header or footer")


def test_a_parent_beside_its_children_refuses_even_when_the_totals_count_both(caplog):
    # parents 100 and 510 printed beside their children, the document's own
    # class totals and grand total counting BOTH levels: every sum ties,
    # debit == credit — only the codes show the double count
    rs = rows()
    for pre in ("100", "510"):
        kids = [r for r in rs if r.cont.startswith(pre)]
        parent = Row(pre, "SINTETIC " + pre)
        parent.v = [sum((k.v[i] for k in kids), Z) for i in range(10)]
        rs.insert(rs.index(kids[0]), parent)
    assert refused(caplog, render(rs), "is listed beside its parent")


def test_a_dotted_child_beside_its_undotted_parent_refuses(caplog):
    rs = rows()
    rs.append(Row("121.07", "Profit analitic", ra=(Z, Decimal("1.00"))))
    rs.append(Row("5311.07", "Casa", ra=(Decimal("1.00"), Z)))
    assert refused(caplog, render(rs), "account 121.07 is listed beside its parent 121")


def _credit(cont: str, text: str, amount: str) -> Row:
    return Row(cont, text, ra=(Z, Decimal(amount)))


def _bank(amount: str) -> Row:
    return Row("5199.05", "Banca test", ra=(Decimal(amount), Z))


def _sum_of(parent: Row, *kids: Row) -> Row:
    parent.v = [sum((k.v[i] for k in kids), Z) for i in range(10)]
    return parent


def test_a_dotted_parent_beside_its_children_refuses_even_when_the_totals_count_both(caplog):
    # "401.1" printed beside its children, the class and grand totals
    # counting BOTH levels: every sum ties and debit == credit, and there
    # is no undotted code for the rule above — only the figures show that
    # the served 401 balance would be doubled
    k1, k2 = _credit("401.101", "Furnizor A", "300.00"), _credit("401.102", "Furnizor B", "200.00")
    lines = render(rows() + [_sum_of(Row("401.1", "Furnizori grup 1"), k1, k2), k1, k2, _bank("1000.00")])
    assert refused(caplog, lines, "account 401.1 is listed beside its children 401.101, 401.102")


def test_dotted_siblings_whose_codes_prefix_one_another_are_read():
    # the control: "401.20" and "401.201" are two accounts (the layout
    # prints such pairs) — the shorter code's figures are not the longer
    # one's, so both are read and served
    lines = render(rows() + [_credit("401.20", "Furnizor C", "300.00"),
                             _credit("401.201", "Furnizor D", "200.00"), _bank("500.00")])
    got = P.parse_lines(lines)
    assert got is not None
    assert by_cont(got, "401.20")["figures"][9] == Decimal("300.00")
    assert by_cont(got, "401.201")["figures"][9] == Decimal("200.00")


def test_a_dotted_parent_beside_a_sibling_that_shares_its_prefix_still_refuses(caplog):
    # "401.2" is the sum of its children 401.21 and 401.22; "401.201", a
    # separate account whose code also starts with "401.2", spoils the sum
    # over every extension — the children at one suffix length still match
    k1, k2 = _credit("401.21", "Furnizor A", "300.00"), _credit("401.22", "Furnizor B", "200.00")
    lines = render(rows() + [_sum_of(Row("401.2", "Furnizori grup 2"), k1, k2), k1, k2,
                             _credit("401.201", "Furnizor E", "70.00"), _bank("1070.00")])
    assert refused(caplog, lines, "account 401.2 is listed beside its children 401.21, 401.22")


def test_an_all_zero_dotted_row_beside_its_extensions_is_read():
    # zeros listed twice add nothing to any figure: not a refusal
    got = P.parse_lines(render(rows() + [Row("401.3", "Furnizori grup 3"), Row("401.301", "Furnizor F")]))
    assert got is not None and by_cont(got, "401.3")["figures"] == [Z] * 10


# ── a subtotal beside the rows it sums, however it is coded ─────────────
#
# Before the repair the parent rule knew only parents whose code is a string
# prefix of their children's. A subtotal coded with a zero suffix ("401.000"
# beside "401.04", "401.02"), after its children ("401.99"), or as an
# undotted sibling ("4010" beside "4011", "4012") was READ — the class and
# grand totals counting both levels, every sum tied and debit == credit held,
# and the served 401 balance was doubled.


def _payables(*extra: Row, bank: str) -> List[str]:
    return render(rows() + list(extra) + [_bank(bank)])


def test_a_zero_suffix_subtotal_beside_the_accounts_it_sums_refuses(caplog):
    k1, k2 = _credit("401.04", "Furnizor A", "300.00"), _credit("401.02", "Furnizor B", "200.00")
    lines = _payables(_sum_of(Row("401.000", "Furnizori total"), k1, k2), k1, k2, bank="1000.00")
    assert refused(caplog, lines, "account 401.000 is listed beside its children 401.04, 401.02")


def test_a_zero_suffix_subtotal_of_a_single_account_refuses(caplog):
    k1 = _credit("401.04", "Furnizor A", "300.00")
    lines = _payables(_sum_of(Row("401.000", "Furnizori total"), k1), k1, bank="600.00")
    assert refused(caplog, lines, "account 401.000 is listed beside its children 401.04")


def test_a_subtotal_coded_after_the_accounts_it_sums_refuses(caplog):
    k1, k2 = _credit("401.04", "Furnizor A", "300.00"), _credit("401.02", "Furnizor B", "200.00")
    lines = _payables(k1, k2, _sum_of(Row("401.99", "Total furnizori"), k1, k2), bank="1000.00")
    assert refused(caplog, lines, "account 401.99 equals the sum of 401.04, 401.02")


def test_an_undotted_subtotal_beside_its_undotted_siblings_refuses(caplog):
    k1, k2 = _credit("4011", "Furnizor exemplu A", "300.00"), _credit("4012", "Furnizor exemplu B", "200.00")
    lines = _payables(_sum_of(Row("4010", "Furnizori"), k1, k2), k1, k2, bank="1000.00")
    assert refused(caplog, lines, "account 4010 equals the sum of 4011, 4012")


def test_a_subtotal_is_refused_when_another_base_under_its_root_spoils_the_root_sum(caplog):
    # "4011.5" sits under the same root 401, at the children's code length,
    # and spoils every root-wide sum; the rows sharing 401.99's base still
    # add up to it
    k1, k2 = _credit("401.04", "Furnizor A", "300.00"), _credit("401.02", "Furnizor B", "200.00")
    lines = _payables(k1, k2, _sum_of(Row("401.99", "Total furnizori"), k1, k2),
                      _credit("4011.5", "Furnizor C", "70.00"), bank="1070.00")
    assert refused(caplog, lines, "account 401.99 equals the sum of 401.04, 401.02")


def test_a_subtotal_is_refused_when_a_longer_code_under_its_base_spoils_the_base_sum(caplog):
    # "401.201" shares 401.99's base and spoils the base-wide sum; the rows
    # at the children's code length still add up to it
    k1, k2 = _credit("401.04", "Furnizor A", "300.00"), _credit("401.02", "Furnizor B", "200.00")
    lines = _payables(k1, k2, _sum_of(Row("401.99", "Total furnizori"), k1, k2),
                      _credit("401.201", "Furnizor D", "70.00"), bank="1070.00")
    assert refused(caplog, lines, "account 401.99 equals the sum of 401.04, 401.02")


def test_a_parent_is_refused_when_a_same_length_prefix_sibling_sits_among_its_children(caplog):
    # "401.1" is the sum of 401.11 and 401.12; "401.10", a separate account,
    # also starts with "401.1" at the children's length, so it spoils the
    # full sum AND the per-length sum — the children are the contiguous run
    # the ERP prints them in
    k1, k2 = _credit("401.11", "Furnizor A", "300.00"), _credit("401.12", "Furnizor B", "200.00")
    lines = _payables(_sum_of(Row("401.1", "Furnizori grup 1"), k1, k2),
                      _credit("401.10", "Furnizor separat", "70.00"), k1, k2, bank="1070.00")
    assert refused(caplog, lines, "account 401.1 is listed beside its children 401.11, 401.12")


def test_a_parent_prefix_beside_accounts_that_do_not_sum_to_it_is_read():
    # the control: the same codes, the short one an account of its own
    got = P.parse_lines(_payables(_credit("401.1", "Furnizor grup", "450.00"),
                                  _credit("401.10", "Furnizor separat", "70.00"),
                                  _credit("401.11", "Furnizor A", "300.00"),
                                  _credit("401.12", "Furnizor B", "200.00"), bank="1020.00"))
    assert got is not None and by_cont(got, "401.1")["figures"][9] == Decimal("450.00")


def test_a_zero_suffix_account_that_is_not_a_subtotal_is_read():
    # the control: "401.000" is an account of its own when its figures are not
    # the others' sum
    k1, k2 = _credit("401.04", "Furnizor A", "300.00"), _credit("401.02", "Furnizor B", "200.00")
    got = P.parse_lines(_payables(_credit("401.000", "Furnizori diversi", "450.00"), k1, k2, bank="950.00"))
    assert got is not None and by_cont(got, "401.000")["figures"][9] == Decimal("450.00")


def test_two_sibling_accounts_with_identical_figures_are_read():
    # the boundary: one identical sibling is not a sum — two accounts may
    # carry the same figures (and neither code extends the other)
    got = P.parse_lines(_payables(_credit("401.05", "Garantie A", "300.00"),
                                  _credit("401.06", "Garantie B", "300.00"), bank="600.00"))
    assert got is not None
    assert by_cont(got, "401.05")["figures"] == by_cont(got, "401.06")["figures"]


def test_too_few_accounts_refuses(caplog):
    assert refused(caplog, render(rows(n=5)[:10]), "10 account lines (< 20)")


def test_a_header_matching_both_layouts_refuses(caplog):
    lines = book()
    lines.insert(1, "Balanta de verificare Solduri initiale Rulaje perioada Sume totale Solduri finale")
    assert refused(caplog, lines, "header matches both layouts")


# ── the period comes from the document ──────────────────────────────────


def _with_title(*title: str) -> List[str]:
    lines = book()
    i = lines.index(HEADER[2])
    return lines[:i] + list(title) + lines[i + 1:]


def test_the_printed_period_is_read_from_the_title_block():
    got = P.parse_lines(book())
    assert got["period"] == {"text": "Decembrie 2025", "year": 2025, "month": 12, "end": "2025-12-31"}


def test_a_period_on_a_line_of_its_own_is_read():
    got = P.parse_lines(_with_title("Adresa: Str. Exemplu 12 Oras", "Februarie 2024"))
    assert got["period"]["end"] == "2024-02-29"


def test_a_street_named_for_a_date_is_not_a_period():
    got = P.parse_lines(_with_title("Adresa: Bd. 1 Decembrie 1918"))
    assert got is not None and got["period"] is None


def test_two_different_printed_periods_are_no_period():
    got = P.parse_lines(_with_title("Adresa: Str. Exemplu 12 Oras Decembrie 2025", "Noiembrie 2025"))
    assert got is not None and got["period"] is None


def test_a_month_and_year_in_an_account_name_is_not_the_period():
    # only the title block prints the period: a name continued on its own
    # line ("... Martie 2024") is not one
    rs = rows()
    rs[0].cont_lines = ("contract Martie 2024",)
    lines = render(rs)
    lines[lines.index(HEADER[2])] = "Adresa: Str. Exemplu 12 Oras"
    got = P.parse_lines(lines)
    assert got is not None and got["period"] is None


def test_a_book_without_a_column_header_is_refused_as_a_five_pair_book():
    lines = [l for l in book() if l not in HEADER[4:]]
    verdict = P.parse_lines_verdict(lines)
    assert verdict.layout == P.LAYOUT_FIVE_PAIR and verdict.parsed is None
    assert "printed before the column header" in verdict.refusal


def test_a_reader_crash_is_a_refusal_never_an_exception(monkeypatch):
    # a five-pair document is read or refused — a caller that got an
    # exception instead could fall through to a reader that approximates
    def crash(_lines):
        raise RuntimeError("synthetic reader crash")
    monkeypatch.setattr(P, "_parse_five_pair", crash)
    verdict = P.parse_lines_verdict(book())
    assert verdict.layout == P.LAYOUT_FIVE_PAIR and verdict.parsed is None
    assert verdict.refusal == "the reader failed on it (RuntimeError)"


def test_the_layout_is_named_by_the_header_or_by_the_rows_ten_figure_columns():
    assert P.detect_layout(book()) == P.LAYOUT_FIVE_PAIR
    assert P.names_five_pair(P.LAYOUT_FIVE_PAIR) and P.names_five_pair(P.LAYOUT_BOTH)
    assert not P.names_five_pair(P.LAYOUT_EIGHT_FIGURE) and not P.names_five_pair(None)
    # no column header at all: the rows' ten figure columns name it
    assert P.detect_layout([l for l in book() if not l.startswith("Cont Denumire")]) == P.LAYOUT_FIVE_PAIR
    # neither a header nor such rows
    assert P.detect_layout([l for l in book() if not l.startswith("Cont Denumire")][:5]) is None


# ── P1 (round 4): a five-pair book never escapes this reader on the wording
#    of its column header ──
#
# Before the repair the layout was named by header tokens alone: a header
# with a wording variant — an abbreviation, a stray space inside a phrase,
# the header wrapped over two lines — named no layout, and the book left
# the reader block for the positional fast-path (undotted codes only,
# accepted on the account-121 anchor alone). The rows' ten figure columns
# now name the layout structurally; once named, the book is read strictly
# or refused with the plain refusal.


def _with_column_header(*header: str) -> List[str]:
    """The book with its column header replaced by `header` — and, when
    there is none, without the Debit/Credit sub-header either."""
    lines = book()
    i = lines.index(HEADER[4])
    return lines[:i] + list(header) + lines[i + (1 if header else 2):]


@pytest.mark.parametrize("header, why", [
    ("Cont Denumire Sold init. Rulaj ant. Rulaj crt. Total rulaj Sold final", "column header reads"),
    ("Cont Denumire Sold initial Rulaj anterior Rulaj curent Total rulaj Sold final Obs.", "column header reads"),
    ("Cont Denumire Sold initial Rulaj anterior\nRulaj curent Total rulaj Sold final", "column header reads"),
    ("", "account 1000.01 is printed before the column header"),
], ids=["abbreviated", "extra-column", "wrapped-over-two-lines", "absent"])
def test_a_five_pair_book_with_a_header_variant_is_refused_never_unnamed(caplog, header, why):
    lines = _with_column_header(*header.split("\n")) if header else _with_column_header()
    assert P.detect_layout(lines) == P.LAYOUT_FIVE_PAIR
    caplog.clear()
    with caplog.at_level(logging.INFO, logger=P.logger.name):
        verdict = P.parse_lines_verdict(lines)
    assert verdict.layout == P.LAYOUT_FIVE_PAIR and verdict.parsed is None
    assert why in (verdict.refusal or ""), verdict.refusal


@pytest.mark.parametrize("header", [
    "Cont Denumire Sold  initial Rulaj anterior Rulaj curent Total  rulaj Sold final",
    "Cont Denumire Sold iniţial Rulaj anterior Rulaj curent Total rulaj Sold final",
    "  Cont Denumire Sold initial Rulaj anterior Rulaj curent Total rulaj Sold final  ",
], ids=["double-spaces", "diacritics", "padding"])
def test_a_five_pair_book_with_a_spacing_or_diacritics_variant_is_read(header):
    verdict = P.parse_lines_verdict(_with_column_header(header))
    assert verdict.layout == P.LAYOUT_FIVE_PAIR and verdict.parsed is not None, verdict.refusal
    assert len(verdict.parsed["rows"]) == 28


def test_an_eight_figure_header_over_ten_figure_rows_is_a_five_pair_book_whose_header_is_refused():
    lines = _with_column_header("Solduri initiale an Rulaje perioada Sume totale Solduri finale",
                                "Cont Denumirea contului")
    lines[0] = "Balanta de verificare"
    assert P.detect_layout(lines) == P.LAYOUT_FIVE_PAIR
    verdict = P.parse_lines_verdict(lines)
    assert verdict.parsed is None and "column header reads" in verdict.refusal


def test_two_stray_ten_figure_lines_do_not_name_the_layout():
    lines = ["Raport", "Situatie"] + [l for l in book() if l.startswith("1000.01 ") or l.startswith("1001.01 ")]
    assert P.detect_layout(lines) is None


def test_an_eight_figure_book_keeps_its_own_reader():
    # the eight-figure layout is not claimed by the five-pair reader
    def space(v: int) -> str:
        return f"{v:,}.00".replace(",", " ")
    lines = [
        "Balanta de verificare",
        "Solduri initiale an Rulaje perioada Sume totale Solduri finale",
        "Cont Denumirea contului",
    ]
    lines += [f"10{i:02d} CAPITAL {i} 0.00 {space(1000 + i)} 0.00 0.00 0.00 {space(1000 + i)} 0.00 {space(1000 + i)}"
              for i in range(12)]
    lines.append("Total sume clasa 1 0.00 12 066.00 0.00 0.00 0.00 12 066.00 0.00 12 066.00")
    lines += [f"51{i:02d} BANCA {i} {space(1000 + i)} 0.00 0.00 0.00 {space(1000 + i)} 0.00 {space(1000 + i)} 0.00"
              for i in range(12)]
    lines.append("Total sume clasa 5 12 066.00 0.00 0.00 0.00 12 066.00 0.00 12 066.00 0.00")
    got = P.parse_lines(lines)
    assert got is not None and "layout" not in got and len(got["rows"]) == 24
