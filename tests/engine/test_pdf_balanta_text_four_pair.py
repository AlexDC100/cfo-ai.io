"""The four-pair column balanta PDF: every figure placed by its column, read strictly or refused.

2026-09-26: with the Anthropic credit balance empty, every balanta PDF the
deterministic readers refuse fails for the user. A prospect uploaded a
balanta printed with four column pairs — "Sold initial" / "Rulaje" /
"Total" / "Solduri finale", sub-headed "1 Ianuarie" / "luna curenta" /
"sume cumulate" — whose zeros print as BLANK cells: an account line
carries anywhere from none to eight figures, so no text-line reader can
tell which figure is which. `pdf_balanta_text` now reads that layout
(LAYOUT_FOUR_PAIR_COLUMNS) from the words' x-positions: each figure goes
to the column the header puts it in, a blank cell is 0.00, and every
check the other readers make — and the layout's own "*" totals — must
hold, or the book is refused.

Every PDF here is synthetic (`_four_pair_book`: an invented company,
invented codes and figures, this module's own page geometry). Each
refusal below plants ONE defect in an otherwise readable book, and the
untampered book (`test_the_synthetic_book_is_read`) is the control.
"""
from __future__ import annotations

import functools
import io
from decimal import Decimal
from typing import Callable, List

import pytest

pytest.importorskip("fitz")
pytest.importorskip("pdfplumber")

import _four_pair_book as B  # noqa: E402
from engine.country_packs.ro_romania import pdf_balanta_text as P  # noqa: E402

D = Decimal
Z = B.Z


def _verdict(content: bytes) -> P.TextReadResult:
    return P.read_balanta_text_verdict(content)


def _rows(content: bytes):
    got = _verdict(content)
    assert got.workbook is not None, got.refusal
    import openpyxl

    ws = openpyxl.load_workbook(io.BytesIO(got.workbook)).active
    return got, {r[0]: r for r in ws.iter_rows(min_row=3, values_only=True)}


@functools.lru_cache(maxsize=None)
def _control():
    """The untampered book's read (read once: every test that compares
    against it shares it)."""
    return _rows(B.pdf())


def _book(**kw) -> List[List[B.Line]]:
    return B.pages(B.book_lines(**kw))


def _tampered(fn: Callable[[List[B.Line]], List[B.Line]], **kw) -> bytes:
    return B.render(B.pages(fn(B.book_lines(**kw))))


def _account(table: List[B.Line], base: str, analytic: str = "0", kind: str = "account") -> B.Line:
    return next(l for l in table if l.kind == kind and l.meta.get("base") == base
                and l.meta.get("analytic") == analytic)


def _figure(line: B.Line, column: int):
    """The segment printing the figure of `column` (0..7) on `line`."""
    edge = B.EDGES[column + 1] - B.PAD
    return next(i for i, (x, _, right) in enumerate(line.segments) if right and abs(x - edge) < 1e-6)


def _refusal(content: bytes) -> str:
    got = _verdict(content)
    assert got.layout == P.LAYOUT_FOUR_PAIR_COLUMNS and got.workbook is None, (got.layout, got.refusal)
    return got.refusal or ""


# ── the control ─────────────────────────────────────────────────────────


def test_the_synthetic_book_is_read():
    got, rows = _control()
    assert got.layout == P.LAYOUT_FOUR_PAIR_COLUMNS and got.refusal is None
    assert got.meta["layout"] == "four_pair_columns" and got.meta["number_format"] == "space"
    assert got.meta["accounts"] == len(B.balanced_book()) == 50
    assert got.meta["classes"] == ["1", "2", "3", "4", "5", "6", "7"]
    # the period the title block prints, its end date the period end
    assert (got.meta["period_text"], got.meta["period_end"]) == ("01/12/2025 - 31/12/2025", "2025-12-31")
    # every account line verbatim, in the SAGA column order SI RL RC SF —
    # analytics as "<account>.<analytic>", an account without analytics bare
    for code, analytic, _, v in B.balanced_book():
        key = code if analytic == "0" else "%s.%s" % (code, analytic)
        assert [D(str(x)).quantize(D("0.01")) for x in rows[key][2:]] == v, key
    # the "*" totals are checks, never rows: no account line for an account
    # printed with analytics, no group line
    assert "4518" not in rows and "472" not in rows and "451" not in rows and "104" not in rows
    assert rows["121"][9] == pytest.approx(12345.67)          # SF credit: the account-121 anchor
    g = got.meta["grand_totals"]
    assert [g[i] == g[i + 1] for i in (0, 2, 4, 6)] == [True] * 4


def test_the_book_spans_pages_and_prints_its_header_on_each():
    pages = _book()
    assert len(pages) >= 3
    lines = P._extract_lines_at(B.pdf(), P._FOUR_X_TOLERANCE)
    assert sum(1 for l in lines if l.text == "Debit Credit Debit Credit Debit Credit Debit Credit") == len(pages)


def test_an_account_total_nets_its_analytics_and_the_book_is_read():
    # the analytics of 4518 sit on opposite sides: the account's "*" total
    # prints ONE opening and ONE closing balance, while the plain sum of
    # its analytics carries both sides — the book is read, the analytics
    # go to the workbook, the total is a check only
    book = {(c, a): v for c, a, _, v in B.balanced_book()}
    lines = [book[("4518", "1")], book[("4518", "2")]]
    assert B.plain(lines) != B.netted(lines)
    got, rows = _control()
    assert {"4518.1", "4518.2"} <= set(rows) and "4518" not in rows


@pytest.mark.parametrize("shape", B.SHAPES)
def test_every_number_shape_is_read(shape):
    got, rows = _rows(B.pdf(shape=shape))
    assert got.meta["number_format"] == shape
    assert rows["5113"][2] == pytest.approx(3994.83)


@pytest.mark.parametrize("column", range(8), ids=["%s-%s" % (h, s) for h in ("sold-initial", "rulaje", "total", "solduri-finale")
                                                   for s in ("debit", "credit")])
def test_a_zero_printed_blank_in_any_column_is_read_as_zero(column):
    # the control prints every zero of an account line but the closing
    # balance's as 0.00; here the zeros of one more column print blank too
    got, rows = _rows(B.pdf(row_blank={column, 6, 7}))
    assert rows == _control()[1]
    blanks = sum(1 for _, _, _, v in B.balanced_book() if v[column] == 0)
    assert blanks >= 1  # the column really carries blank cells in this book


def test_every_zero_printed_blank_everywhere_is_read():
    # every zero of every line — account, "*" total, class and grand
    # total — printed blank
    got, rows = _rows(B.pdf(row_blank=range(8), total_blank=range(8)))
    assert rows == _control()[1]


def test_a_wrapped_name_is_read_whole():
    got, rows = _control()
    assert rows["453"][1] == "Decontari cu entitatile asociate si cu entitatile controlate in comun"


def test_a_group_total_printed_on_the_page_after_its_accounts_is_read():
    table = B.book_lines()
    i = next(k for k, l in enumerate(table) if l.kind == "group" and l.meta["root"] == "437")
    content = B.render(B.pages(table, rows_per_page=i))   # the group's total opens the next page
    got, rows = _rows(content)
    assert "4371" in rows and "4372" in rows


# ── why the column-level word split ─────────────────────────────────────


def test_the_default_word_split_glues_words_across_column_edges():
    # the layout prints the level digit a space's width before the name,
    # and the grand total's label a space's width after its last figure:
    # pdfplumber's default split reads each as ONE word across two columns
    default = [l.text for l in P._extract_lines(B.pdf())]
    assert any(" 0Prime de emisiune " in t for t in default)
    assert any(t.split()[-2].endswith("TOTAL") for t in default if t.startswith("TOTAL GENERAL"))
    assert "three code parts" in (P._four_pair_verdict(P._extract_lines(B.pdf())).refusal or "")
    fine = [l.text for l in P._extract_lines_at(B.pdf(), P._FOUR_X_TOLERANCE)]
    assert any(" 0 Prime de emisiune " in t for t in fine)


# ── refusals: one planted defect each ───────────────────────────────────


def _shift(base, analytic, column, dx, kind="account"):
    def fn(table):
        line = _account(table, base, analytic, kind)
        i = _figure(line, column)
        x, text, right = line.segments[i]
        line.segments[i] = (x + dx, text, right)
        return table
    return fn


def test_a_figure_that_does_not_end_at_its_columns_x_is_refused():
    why = _refusal(_tampered(_shift("5113", "0", 4, -6.0)))
    assert "do not end at one x" in why and "Total Debit" in why


def test_a_figure_printed_across_a_column_edge_is_refused():
    why = _refusal(_tampered(_shift("5113", "0", 4, +8.0)))
    assert "is printed across the edge of the Total Debit column" in why


def _drop(pred):
    return lambda table: [l for l in table if not pred(l)]


@pytest.mark.parametrize("pred, why", [
    (lambda l: l.kind == "class" and l.meta["class"] == "3", "no printed total for class 3"),
    (lambda l: l.kind == "star" and l.meta["base"] == "4518", "the analytics of account 4518 carry no printed total"),
    (lambda l: l.kind == "group" and l.meta["root"] == "302", "group 302 carry no printed group total"),
], ids=["class-total", "account-total", "group-total"])
def test_a_missing_total_is_refused(pred, why):
    assert why in _refusal(_tampered(_drop(pred)))


def test_two_number_shapes_are_refused():
    def comma(table):
        line = _account(table, "212")
        i = _figure(line, 0)
        x, text, right = line.segments[i]
        line.segments[i] = (x, B.fmt(D(text.replace(" ", "")), "comma"), right)
        return table
    why = _refusal(_tampered(comma))
    assert "not in the number format of the figures before it" in why


def test_an_account_total_off_by_a_cent_is_refused():
    def cent(table):
        line = _account(table, "5112", "0", kind="star")
        i = _figure(line, 4)
        x, text, right = line.segments[i]
        line.segments[i] = (x, B.fmt(D(text.replace(" ", "")) + D("0.01")), right)
        return table
    assert "account 5112's printed total" in _refusal(_tampered(cent))


def _cent(kind, key, value, column):
    def fn(table):
        line = next(l for l in table if l.kind == kind and l.meta.get(key) == value)
        i = _figure(line, column)
        x, text, right = line.segments[i]
        line.segments[i] = (x, B.fmt(D(text.replace(" ", "")) + D("0.01")), right)
        return table
    return fn


@pytest.mark.parametrize("tamper, why", [
    (_cent("group", "root", "302", 2), "group 302's printed total"),
    (_cent("class", "class", "6", 5), "class 6 sums"),
    (_cent("grand", "kind", None, 3), "!= printed grand total"),
], ids=["group-total", "class-total", "grand-total"])
def test_a_total_off_by_a_cent_is_refused(tamper, why):
    assert why in _refusal(_tampered(tamper))


def test_a_closing_balance_read_on_the_wrong_side_is_refused():
    # 463 closes in debit and 464 in credit by the same amount: printing
    # each on the other side keeps every class total and debit == credit —
    # only the account's own Total pair says which side is right
    def swap(table):
        for base, src, dst in (("463", 6, 7), ("464", 7, 6)):
            line = _account(table, base)
            i = _figure(line, src)
            _, text, right = line.segments[i]
            line.segments[i] = (B.EDGES[dst + 1] - B.PAD, text, right)
        return table
    why = _refusal(_tampered(swap))
    assert "account 463.0: sold final" in why


def test_an_account_printed_on_its_own_line_beside_its_analytics_is_refused():
    # "5321. 0." and "5321. 1." both printed, no "*" total: is the first
    # line the account's own postings or its total? The class total cannot
    # settle that — the layout does not say
    def own_line(table):
        i = table.index(_account(table, "5321"))
        extra = B.account_line("5321", "1", "Timbre postale", B.account(D("35.27"), D("10.13"), Z),
                               {6, 7}, "space")
        return table[:i + 1] + [extra] + table[i + 1:]
    why = _refusal(_tampered(own_line))
    assert "account 5321 is printed both on its own line (analytic 0) and with the analytics 1" in why


def test_a_three_digit_account_beside_its_four_digit_accounts_is_refused():
    def parent(table):
        i = table.index(_account(table, "4371"))
        extra = B.account_line("437", "0", "Contributii somaj", B.account(D("-641.37"), D("7915.13"), D("8071.69")),
                               {6, 7}, "space")
        return table[:i] + [extra] + table[i:]
    assert "account 437 is listed beside its accounts 4371, 4372" in _refusal(_tampered(parent))


def test_a_subtotal_listed_as_an_account_is_refused():
    # "5413" prints the sum of 5411 and 5412, and the document's own totals
    # count it as an account: every total ties, only the figures say it
    book = B.balanced_book()
    v = B.plain([v for c, _, _, v in book if c in ("5411", "5412")])
    i = next(k for k, r in enumerate(book) if r[0] == "5412")
    planted = B.balanced_book(book[:i + 1] + [("5413", "0", "Acreditive totale", v)] + book[i + 1:])
    why = _refusal(B.render(B.pages(B.book_lines(book=planted))))
    assert "account 5413 equals the sum of 5411, 5412" in why


@pytest.mark.parametrize("sides, headings, why", [
    (("Credit", "Debit") * 4, None, "side labels read"),
    (None, ("Rulaje", "Sold initial", "Total", "Solduri finale"), "does not print 'Sold initial' over its own"),
], ids=["credit-first", "headings-out-of-order"])
def test_a_column_header_this_reader_cannot_read_is_refused(sides, headings, why):
    kw = {}
    if sides:
        kw["sides"] = sides
    if headings:
        kw["headings"] = headings
    content = B.render(B.pages(B.book_lines(), header=B.header_lines(**kw)))
    assert why in _refusal(content)


def test_a_header_naming_another_layout_too_is_refused():
    title = B.TITLE[:3] + ["Solduri, rulaje, sume totale"] + B.TITLE[3:]
    content = B.render(B.pages(B.book_lines(), title=title))
    assert "also names another balanta layout" in _refusal(content)


def test_a_code_repeated_on_the_right_that_differs_is_refused():
    def other_code(table):
        line = _account(table, "3025")
        line.segments = [(x, "3026." if text == "3025." and x > B.EDGES[8] else text, r)
                         for x, text, r in line.segments]
        return table
    assert "account 3025.0: the code repeated right of its figures reads" in _refusal(_tampered(other_code))


def test_a_third_code_part_other_than_zero_is_refused():
    def level(table):
        line = _account(table, "331")
        line.segments = [(x, "2" if text == "0" and not r and x in (B.LEVEL_X, B.R_LEVEL_X) else text, r)
                         for x, text, r in line.segments]
        return table
    assert "third code part 2" in _refusal(_tampered(level))


def test_figures_on_a_line_that_is_no_account_or_total_are_refused():
    def footer(table):
        out = list(table)
        out.insert(3, B.Line("footer", [(18.0, "Report", False), (B.EDGES[2] - B.PAD - B.width("1 234.57"), "1 234.57", False)]))
        return out
    assert "carries figures but is neither an account nor a total" in _refusal(_tampered(footer))


def test_an_account_after_the_grand_total_is_refused():
    def after(table):
        i = next(k for k, l in enumerate(table) if l.kind == "grand")
        return table[:i + 1] + [B.account_line("5412", "7", "Acreditive", B.account(Z, Z, Z), {6, 7}, "space")] + table[i + 1:]
    assert "follows the grand total" in _refusal(_tampered(after))


def test_fewer_than_min_accounts_is_refused():
    book = B.balanced_book()
    keep = [r for r in book if r[0][0] in "12" or r[0] == B.BALANCING[0]]
    assert len(keep) < P.MIN_ACCOUNTS
    content = B.render(B.pages(B.book_lines(book=B.balanced_book(keep))))
    assert "account lines (< %d)" % P.MIN_ACCOUNTS in _refusal(content)


def test_a_page_whose_words_do_not_rebuild_its_text_is_refused():
    lines = P._extract_lines_at(B.pdf(), P._FOUR_X_TOLERANCE)
    k = next(i for i, l in enumerate(lines) if l.text.startswith("3022."))
    lines[k] = P.Line(lines[k].text, None)          # that page's lines read without positions
    why = P._four_pair_verdict(lines).refusal or ""
    assert "carries no word positions" in why


# ── naming the layout ───────────────────────────────────────────────────


def test_the_layout_is_named_by_its_headings_whatever_its_side_labels_read():
    content = B.render(B.pages(B.book_lines(), header=B.header_lines(sides=("Credit", "Debit") * 4)))
    assert P.detect_layout(P._extract_lines(content)) == P.LAYOUT_FOUR_PAIR_COLUMNS
    assert P.names_strict_layout(P.LAYOUT_FOUR_PAIR_COLUMNS)
    assert not P.names_five_pair(P.LAYOUT_FOUR_PAIR_COLUMNS)


def test_a_book_whose_text_lines_are_unavailable_is_refused_by_the_second_opinion(monkeypatch):
    monkeypatch.setattr(P, "_extract_lines", lambda _b: None)
    got = _verdict(B.pdf())
    assert got.layout == P.LAYOUT_FOUR_PAIR_COLUMNS and got.workbook is None
    assert "another text extraction of its first page names the four-pair column layout" in got.refusal


def test_the_printed_period_is_one_date_range_or_none():
    assert P._printed_date_range(["01/12/2025 - 31/12/2025"]) == {"text": "01/12/2025 - 31/12/2025",
                                                                   "end": "2025-12-31"}
    assert P._printed_date_range(["Perioada: 01.11.2025 - 30.11.2025"])["end"] == "2025-11-30"
    assert P._printed_date_range(["01/12/2025 - 31/12/2025", "01/01/2025 - 31/12/2025"]) is None
    assert P._printed_date_range(["31/12/2025 - 01/12/2025"]) is None      # an end before its start
    assert P._printed_date_range(["31/02/2025 - 31/03/2025"]) is None      # no such date
    assert P._printed_date_range(["EXEMPLU TEST SRL"]) is None
