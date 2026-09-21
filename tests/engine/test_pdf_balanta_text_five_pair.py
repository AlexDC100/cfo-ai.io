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
from typing import List, Optional

import openpyxl

from engine.country_packs.ro_romania import pdf_balanta_text as P

Z = Decimal(0)

HEADER = [
    "Balanta analitica",
    "Societate: EXEMPLU TEST SRL",
    "Adresa: Str. Exemplu 1 Decembrie 2025",
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


def render(rs: List[Row], *, grand: bool = True, page_break_after: Optional[str] = None) -> List[str]:
    lines = list(HEADER)
    for cls in sorted({r.cont[0] for r in rs}):
        lines.append(f"Clasa {cls}")
        mine = [r for r in rs if r.cont[0] == cls]
        for r in mine:
            lines.append(r.line())
            if r.cont == page_break_after:
                lines.extend(FOOTER + HEADER[4:])
            lines.extend(r.cont_lines)
        tot = [sum((r.v[i] for r in mine), Z) for i in range(10)]
        lines.append(f"Total clasa {cls}: " + " ".join(fmt(x) for x in tot))
    if grand:
        tot = [sum((r.v[i] for r in rs), Z) for i in range(10)]
        lines.append("Total general: " + " ".join(fmt(x) for x in tot))
    return lines + FOOTER


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


def _book_with_a_client(client_text: str = "Client 404 Media SRL") -> List[str]:
    rs = rows()
    rs.append(Row("4111.05", client_text, si=(Decimal("7000.00"), Z), rl=(Decimal("500.00"), Z)))
    rs.append(Row("4011.09", "Furnizor Y", si=(Z, Decimal("7000.00")), rl=(Z, Decimal("500.00"))))
    return render(rs)


def _wrap(lines: List[str], cont: str, first_line: str) -> List[str]:
    """Wrap `cont`'s row: `first_line` on its own text line, the rest of
    the row (after "<cont> Client") on the next — which starts with
    whatever the name continues with."""
    out = list(lines)
    i = next(k for k, l in enumerate(out) if l.startswith(cont + " "))
    toks = out[i].split(" ")
    out[i:i + 1] = [first_line, " ".join(toks[2:])]
    return out


def test_the_client_book_is_read():  # the control for the wrap tests below
    got = P.parse_lines(_book_with_a_client())
    assert by_cont(got, "4111.05")["figures"][8] == Decimal("7500.00")


def test_a_wrapped_row_whose_second_line_starts_with_a_number_refuses(caplog):
    # "4111.05 Client" / "404 Media SRL <ten figures>": read naively, the
    # receivable is served as account 404 (fixed-asset suppliers, a
    # liability) and 4111.05 vanishes — both class 4, every total ties.
    lines = _wrap(_book_with_a_client(), "4111.05", "4111.05 Client")
    assert refused(caplog, lines, "account 404 follows a line led by the code-shaped 4111.05")


def test_a_wrapped_row_with_the_code_alone_on_its_first_line_refuses(caplog):
    lines = _wrap(_book_with_a_client(), "4111.05", "4111.05")
    assert refused(caplog, lines, "account 404 follows a line led by the code-shaped 4111.05")


def test_a_wrapped_row_that_prints_its_code_again_is_read_whole():
    # the figure line repeats the held line's code: the held line was the
    # row's first line, and its text is the start of that account's name
    lines = _book_with_a_client()
    i = next(k for k, l in enumerate(lines) if l.startswith("4111.05 "))
    toks = lines[i].split(" ")
    lines[i:i + 1] = ["4111.05 Client 404", "4111.05 " + " ".join(toks[3:])]
    got = P.parse_lines(lines)
    assert got is not None
    client = by_cont(got, "4111.05")
    assert client["name"] == "Client 404 Media SRL" and client["figures"][8] == Decimal("7500.00")
    assert not any(r["cont"] == "404" for r in got["rows"])


def test_a_code_plus_name_line_then_a_code_plus_figures_line_names_the_right_account():
    lines = book()
    i = next(k for k, l in enumerate(lines) if l.startswith("1007.01 "))
    toks = lines[i].split(" ")
    lines[i:i + 1] = [" ".join(toks[:3]), "1007.01 " + " ".join(toks[3:])]
    got = P.parse_lines(lines)
    assert by_cont(got, "1007.01")["name"] == "CAPITAL 7"
    assert by_cont(got, "1006.01")["name"] == "CAPITAL 6"


def _held_line_then(next_text: str, cont_lines: tuple = ()) -> List[str]:
    """A continuation of 1006.01 led by a code-shaped word (a year), then
    account 1007.01 printed as `next_text` — the real layout's one such
    line per book, where the next account repeats its code."""
    rs = rows()
    for r in rs:
        if r.cont == "1006.01":
            r.cont_lines = ("2019 1006.01",)
        if r.cont == "1007.01":
            r.text, r.cont_lines = next_text, cont_lines
    return render(rs)


def test_a_held_line_before_an_account_that_repeats_its_code_is_a_continuation():
    got = P.parse_lines(_held_line_then("CAPITAL 7 1007.01"))
    assert got is not None
    assert by_cont(got, "1006.01")["name"] == "CAPITAL 6 2019"
    assert by_cont(got, "1007.01")["name"] == "CAPITAL 7"


def test_the_repeat_may_come_on_the_accounts_continuation_line():
    got = P.parse_lines(_held_line_then("CAPITAL 7", cont_lines=("REZERVA 1007.01",)))
    assert got is not None and by_cont(got, "1007.01")["name"] == "CAPITAL 7 REZERVA"


def test_a_held_line_before_an_account_that_never_repeats_its_code_refuses(caplog):
    lines = _held_line_then("CAPITAL 7")
    assert refused(caplog, lines, "account 1007.01 follows a line led by the code-shaped 2019")


def test_too_few_accounts_refuses(caplog):
    assert refused(caplog, render(rows(n=5)[:10]), "10 account lines (< 20)")


def test_a_header_matching_both_layouts_refuses(caplog):
    lines = book()
    lines.insert(1, "Balanta de verificare Solduri initiale Rulaje perioada Sume totale Solduri finale")
    assert refused(caplog, lines, "header matches both layouts")


def test_a_header_matching_neither_layout_refuses():
    lines = [l for l in book() if not l.startswith("Cont Denumire")]
    assert P.parse_lines(lines) is None


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
