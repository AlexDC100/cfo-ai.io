"""A synthetic balanta PDF in the four-pair column layout, built with PyMuPDF.

The LAYOUT is the one `pdf_balanta_text` reads as LAYOUT_FOUR_PAIR_COLUMNS
(see "THIRD LAYOUT" in its docstring); the company, the codes, the names and
every figure are invented here. Four pairs headed "Sold initial" / "Rulaje" /
"Total" / "Solduri finale", sub-headed "1 Ianuarie" / "luna curenta" / "sume
cumulate", over four "Debit Credit" pairs; each account printed as its three
code parts (account, analytic, level), its name, its figures right-aligned in
their columns — a zero printed BLANK in the columns the book leaves blank —
and its code again right of the figures; "*" lines for an account's total
over its analytics (netted: one balance) and a group's "TOTAL" over its
four-digit accounts; "Total clasa N" and "TOTAL GENERAL".

The geometry is this module's own (a 66 pt figure column, a 236 pt code and
name block): the reader reads the columns from the header, never from
constants. Two joints are printed a space's width apart on purpose, as the
layout prints them — the level digit before the name, and the last figure of
the grand total before its label — so pdfplumber's default word split glues
them and only the reader's column-level split reads them.

`Book` holds the lines; `pdf()` renders them; the tests tamper with a Book
(or with the rendered lines) to plant each defect the reader must refuse.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import fitz  # PyMuPDF

Z = Decimal(0)
FONT, SIZE = "helv", 7.0
PAGE_W, PAGE_H = 900.0, 620.0
# The code and name block, the eight figure columns' right edges, the code
# repeated on the right.
STAR_X = 12.0
BASE_RIGHT, ANALYTIC_RIGHT, LEVEL_X = 46.0, 66.0, 72.0
NAME_GAP = 2.0          # the level digit and the name: a space's width apart, no space printed
EDGES = tuple(236.0 + 66.0 * k for k in range(9))   # EDGES[0] the name column's right edge
PAD = 1.0               # a figure ends this far left of its column's edge
R_BASE_RIGHT, R_ANALYTIC_RIGHT, R_LEVEL_X = 802.0, 824.0, 834.0
LINE_STEP = 12.0
ROWS_PER_PAGE = 34
SHAPES = ("comma", "unseparated", "euro", "space")


def fmt(v: Decimal, shape: str = "space") -> str:
    """`v` printed in one number shape: "1 234 567.89" (space), "1,234,567.89"
    (comma), "1234567.89" (unseparated), "1.234.567,89" (euro)."""
    s = f"{v:,.2f}"
    if shape == "space":
        return s.replace(",", " ")
    if shape == "unseparated":
        return s.replace(",", "")
    if shape == "euro":
        return s.replace(",", "\0").replace(".", ",").replace("\0", ".")
    return s


def width(text: str) -> float:
    return fitz.get_text_length(text, fontname=FONT, fontsize=SIZE)


def account(si: Decimal, cum_d: Decimal, cum_c: Decimal, rl_d: Decimal = Z, rl_c: Decimal = Z) -> List[Decimal]:
    """An account's eight figures: its opening balance on one side, this
    month's turnover, Total = the opening + the cumulated turnover, and the
    closing balance netted onto one side."""
    si_d, si_c = (si, Z) if si > 0 else (Z, -si)
    tot_d, tot_c = si_d + cum_d, si_c + cum_c
    net = tot_d - tot_c
    return [si_d, si_c, rl_d, rl_c, tot_d, tot_c, max(net, Z), max(-net, Z)]


def netted(group: Sequence[Sequence[Decimal]]) -> List[Decimal]:
    si = sum((v[0] - v[1] for v in group), Z)
    cum_d = sum((v[4] - v[0] for v in group), Z)
    cum_c = sum((v[5] - v[1] for v in group), Z)
    return account(si, cum_d, cum_c, sum((v[2] for v in group), Z), sum((v[3] for v in group), Z))


def plain(group: Sequence[Sequence[Decimal]]) -> List[Decimal]:
    return [sum((v[i] for v in group), Z) for i in range(8)]


D = Decimal
# The invented book: (code, analytic, name, eight figures) per account line —
# the lines of one account's analytics together — class by class. Every
# figure is invented; the codes are chart codes chosen for this test.
_BOOK: List[Tuple[str, str, str, List[Decimal]]] = [
    ("1041", "0", "Prime de emisiune", account(D("-41268.07"), Z, D("3279.79"), Z, D("465.13"))),
    ("1043", "0", "Prime de conversie", account(D("-6368.73"), D("133.41"), D("793.67"), D("16.47"), D("77.97"))),
    ("1511", "1", "Provizioane litigii furnizori", account(D("-2994.89"), D("314.71"), D("1054.37"), Z, D("86.23"))),
    ("1511", "2", "Provizioane litigii personal", account(D("-1208.59"), D("79.53"), D("367.59"), D("99.83"), Z)),
    ("1512", "0", "Provizioane garantii", account(D("-3593.07"), D("446.31"), D("1246.73"), D("44.31"), D("97.23"))),
    ("121", "0", "Profit sau pierdere", account(Z, D("83392.77"), D("95738.44"), D("7627.05"), D("9471.62"))),
    ("1661", "0", "Datorii entitati afiliate", account(D("-61937.61"), D("4430.31"), D("13638.37"), D("430.59"), Z)),
    ("212", "0", "Constructii", account(D("167530.83"), D("23068.13"), D("1205.41"), D("2877.47"), Z)),
    ("223", "0", "Instalatii in curs de aprovizionare", account(D("8285.13"), D("1831.29"), D("10543.23"), D("1482.89"), Z)),
    ("2801", "0", "Amortizare cheltuieli constituire", account(D("-3506.41"), Z, D("986.37"), Z, D("78.71"))),
    ("2803", "0", "Amortizare alte imobilizari", account(D("-19739.19"), D("564.29"), D("3778.59"), Z, D("244.73"))),
    ("3022", "0", "Combustibili", account(D("2260.61"), D("10105.47"), D("9105.83"), D("822.97"), D("814.67"))),
    ("3025", "0", "Piese de schimb", account(D("6012.83"), D("3956.31"), D("2614.07"), D("322.89"), D("285.47"))),
    ("3026", "0", "Seminte si materiale de plantat", account(D("831.31"), D("1075.73"), D("1510.07"), D("86.53"), D("174.83"))),
    ("321", "0", "Produse in curs de executie", account(D("11306.89"), D("30492.31"), D("30075.47"), D("2092.23"), D("2987.47"))),
    ("331", "0", "Lucrari in curs de executie", account(D("7551.31"), D("13728.07"), D("16072.07"), D("1129.97"), D("1328.13"))),
    ("405", "0", "Efecte de platit pentru imobilizari", account(D("-9357.97"), D("5892.59"), D("2054.79"), D("945.43"), Z)),
    ("424", "0", "Prime privind participarea personalului la profit", account(Z, D("3453.61"), D("3453.61"))),
    ("426", "0", "Drepturi de personal neridicate", account(D("-685.07"), D("638.89"), D("241.71"), Z, D("239.67"))),
    ("4371", "0", "Contributia angajatorului somaj", account(D("-342.71"), D("5907.97"), D("4461.71"), D("474.67"), D("457.61"))),
    ("4372", "0", "Contributia angajatilor somaj", account(D("-256.07"), D("2454.37"), D("2523.19"), D("212.43"), D("224.29"))),
    ("445", "0", "Subventii", account(D("4419.13"), D("2450.97"), D("6730.07"), Z, D("1924.83"))),
    ("447", "0", "Fonduri speciale taxe si varsaminte asimilate", account(D("-100.59"), D("884.79"), D("784.61"), D("79.89"), D("69.13"))),
    ("463", "0", "Creante din dividende repartizate", account(D("1427.61"), Z, Z)),
    ("464", "0", "Datorii din dividende repartizate", account(D("-1427.61"), Z, Z)),
    ("4518", "1", "Dobanzi afiliate de incasat", account(D("3366.79"), D("3047.31"), D("1417.97"), D("243.73"), D("141.07"))),
    ("4518", "2", "Dobanzi afiliate de platit", account(D("-1832.59"), D("1224.19"), D("2483.97"), D("84.07"), D("229.31"))),
    ("453", "0", "Decontari cu entitatile asociate si cu entitatile controlate in comun", account(D("13546.53"), D("3612.47"), D("8512.37"), D("260.53"), D("542.89"))),
    ("472", "1", "Venituri in avans chirii", account(D("-2707.13"), D("1184.97"), D("1901.97"), D("108.37"), D("174.59"))),
    ("472", "2", "Venituri in avans abonamente", account(D("-713.13"), D("215.73"), D("478.73"), D("22.43"), D("40.23"))),
    ("5112", "1", "Cecuri de incasat banca A", account(D("1436.19"), D("8386.79"), D("7748.89"), D("636.79"), D("696.71"))),
    ("5112", "2", "Cecuri de incasat banca B", account(D("818.13"), D("2975.61"), D("3201.07"), D("295.31"), D("265.47"))),
    ("5113", "0", "Efecte de incasat", account(D("3994.83"), D("8145.43"), D("11991.37"), D("941.47"), D("904.37"))),
    ("5114", "0", "Efecte remise spre scontare", account(D("556.79"), D("1382.47"), D("1650.19"), D("104.19"), D("156.71"))),
    ("5321", "0", "Timbre fiscale si postale", account(D("66.37"), D("127.13"), D("122.37"), D("8.73"), D("14.89"))),
    ("5411", "0", "Acreditive in lei", account(D("2277.89"), D("5632.41"), D("5549.41"), D("361.23"), D("417.61"))),
    ("5412", "0", "Acreditive in valuta", account(D("2208.07"), D("2586.61"), D("2402.83"), D("168.67"), D("246.97"))),
    ("6025", "0", "Cheltuieli privind piesele de schimb", account(Z, D("25160.43"), D("25160.43"), D("2517.89"), D("2517.89"))),
    ("6026", "0", "Cheltuieli privind semintele", account(Z, D("16826.43"), D("16826.43"), D("1280.79"), D("1280.79"))),
    ("605", "0", "Cheltuieli privind energia si apa", account(Z, D("15008.83"), D("15008.83"), D("1243.97"), D("1243.97"))),
    ("606", "0", "Cheltuieli privind activele biologice", account(Z, D("2752.53"), D("2752.53"), D("274.29"), D("274.29"))),
    ("614", "0", "Cheltuieli cu studiile si cercetarile", account(Z, D("2543.47"), D("2543.47"), D("215.61"), D("215.61"))),
    ("621", "0", "Cheltuieli cu colaboratorii", account(Z, D("17498.67"), D("17498.67"), D("1484.61"), D("1484.61"))),
    ("642", "0", "Cheltuieli cu tichetele acordate", account(Z, D("3602.41"), D("3602.41"), D("609.89"), D("609.89"))),
    ("701", "0", "Venituri din vanzarea produselor finite", account(Z, D("53804.31"), D("53804.31"), D("5768.53"), D("5768.53"))),
    ("702", "0", "Venituri din vanzarea semifabricatelor", account(Z, D("21148.43"), D("21148.43"), D("1827.47"), D("1827.47"))),
    ("705", "0", "Venituri din studii si cercetari", account(Z, D("8028.79"), D("8028.79"), D("853.29"), D("853.29"))),
    ("741", "0", "Venituri din subventii de exploatare", account(Z, D("6996.37"), D("6996.37"), D("560.07"), D("560.07"))),
    ("7812", "0", "Venituri din ajustari pentru active circulante", account(Z, D("2964.71"), D("2964.71"), D("280.07"), D("280.07"))),
    ("7813", "0", "Venituri din ajustari pentru imobilizari", account(Z, D("2795.83"), D("2795.83"), D("182.19"), D("182.19"))),
]
# The account whose line closes the book (debit == credit on every pair).
BALANCING = ("5114", "0")
# A name printed over two lines: its second line starts in the name column.
WRAPPED = {"453": ("Decontari cu entitatile asociate si cu", "entitatile controlate in comun")}
TITLE = ["EXEMPLU TEST SRL", "Str. Exemplu 7, Oras", "BALANTA DE VERIFICARE", "01/12/2025 - 31/12/2025"]


def balanced_book(rows: Optional[List[Tuple[str, str, str, List[Decimal]]]] = None
                  ) -> List[Tuple[str, str, str, List[Decimal]]]:
    """`rows` (the whole of `_BOOK` by default; it must hold BALANCING) with
    the balancing account's figures set so that debit == credit on all four
    pairs (its opening, turnover and cumulated turnover take up every other
    line's difference)."""
    rows = [(c, a, n, list(v)) for c, a, n, v in (_BOOK if rows is None else rows)]
    others = [v for c, a, _, v in rows if (c, a) != BALANCING]
    si = -sum((v[0] - v[1] for v in others), Z)
    rl_d, rl_c = sum((v[2] for v in others), Z), sum((v[3] for v in others), Z)
    cum_d = sum((v[4] - v[0] for v in others), Z)
    cum_c = sum((v[5] - v[1] for v in others), Z)
    # its own turnover: large enough to be positive on both sides
    own, own_rl = D("24613.37"), D("913.29")
    fig = account(si, own + max(cum_c - cum_d, Z), own + max(cum_d - cum_c, Z),
                  own_rl + max(rl_c - rl_d, Z), own_rl + max(rl_d - rl_c, Z))
    return [(c, a, n, fig if (c, a) == BALANCING else v) for c, a, n, v in rows]


class Line:
    """One printed line: its segments as (x, text, right_aligned) and a y
    offset (a heading printed a little lower than its line's baseline)."""

    def __init__(self, kind: str, segments: List[Tuple[float, str, bool]], dy: float = 0.0,
                 meta: Optional[Dict[str, Any]] = None):
        self.kind, self.segments, self.dy, self.meta = kind, segments, dy, dict(meta or {})


def _centre(text: str, x: float) -> Tuple[float, str, bool]:
    return (x - width(text) / 2, text, False)


def header_lines(sides: Sequence[str] = ("Debit", "Credit") * 4,
                 headings: Sequence[str] = ("Sold initial", "Rulaje", "Total", "Solduri finale")) -> List[Line]:
    e = EDGES
    pair_centres = (e[1], e[3], e[5], e[7])
    return [
        Line("header", [_centre(h, x) for h, x in zip(headings[:3], pair_centres[:3])]),
        Line("header", [_centre(headings[3], pair_centres[3])], dy=-7.5),
        Line("header", [_centre("1 Ianuarie", e[1]), _centre("luna curenta", e[3]),
                        _centre("sume cumulate", e[5])], dy=-3.5),
        Line("header", [_centre("Cont", 40.0), _centre("Denumire", 150.0), _centre("Cont", 816.0)], dy=-1.0),
        Line("side", [_centre(s, (e[k] + e[k + 1]) / 2) for k, s in enumerate(sides)]),
    ]


def _figures(v: Sequence[Decimal], blank: Set[int], shape: str) -> List[Tuple[float, str, bool]]:
    return [(EDGES[k + 1] - PAD, fmt(x, shape), True) for k, x in enumerate(v) if not (x == 0 and k in blank)]


def _code(base: str, analytic: str, star: bool = False) -> List[Tuple[float, str, bool]]:
    out = [(STAR_X, "*", False)] if star else []
    return out + [(BASE_RIGHT, base + ".", True), (ANALYTIC_RIGHT, analytic + ".", True), (LEVEL_X, "0", False)]


def _right_code(base: str, analytic: str) -> List[Tuple[float, str, bool]]:
    return [(R_BASE_RIGHT, base + ".", True), (R_ANALYTIC_RIGHT, analytic + ".", True), (R_LEVEL_X, "0", False)]


def _name(text: str) -> Tuple[float, str, bool]:
    return (LEVEL_X + width("0") + NAME_GAP, text, False)


def account_line(base: str, analytic: str, name: str, v: Sequence[Decimal], blank: Set[int], shape: str,
                 star: bool = False) -> Line:
    return Line("star" if star else "account",
                _code(base, analytic, star) + [_name(name)] + _figures(v, blank, shape) + _right_code(base, analytic),
                meta={"base": base, "analytic": analytic, "v": list(v)})


def book_lines(shape: str = "space", row_blank: Iterable[int] = (6, 7), total_blank: Iterable[int] = (),
               book: Optional[List[Tuple[str, str, str, List[Decimal]]]] = None) -> List[Line]:
    """The table: every account line, the "*" totals, the class totals and
    the grand total, in document order. Zeros print blank in `row_blank`
    columns on account and "*" lines, in `total_blank` columns on the class
    and grand totals."""
    row_blank, total_blank = set(row_blank), set(total_blank)
    rows = book if book is not None else balanced_book()
    out: List[Line] = []
    account_level: Dict[str, List[Decimal]] = {}   # an account's line (its "*" total when it has analytics)
    group_level: Dict[str, List[Decimal]] = {}     # a three-digit line
    order: List[str] = []
    for base in dict.fromkeys(c for c, _, _, _ in rows):
        lines = [(a, n, v) for c, a, n, v in rows if c == base]
        for a, n, v in lines:
            if base in WRAPPED and a == "0":
                first, rest = WRAPPED[base]
                out.append(account_line(base, a, first, v, row_blank, shape))
                out.append(Line("wrap", [_name(rest)]))
            else:
                out.append(account_line(base, a, n, v, row_blank, shape))
        if lines[0][0] != "0":
            account_level[base] = netted([v for _, _, v in lines])
            out.append(account_line(base, "0", lines[0][1].rsplit(" ", 1)[0], account_level[base],
                                    row_blank, shape, star=True))
        else:
            account_level[base] = lines[0][2]
        order.append(base)
        root = base[:3]
        following = [c for c in dict.fromkeys(c for c, _, _, _ in rows)]
        nxt = following[following.index(base) + 1] if following.index(base) + 1 < len(following) else None
        if len(base) == 4 and (nxt is None or nxt[:3] != root):
            fours = [b for b in order if len(b) == 4 and b[:3] == root]
            group_level[root] = plain([account_level[b] for b in fours])
            out.append(Line("group", _code(root, "0", star=True)
                            + [_name("TOTAL %s.0.0" % root)] + _figures(group_level[root], row_blank, shape)
                            + _right_code(root, "0"), meta={"root": root}))
        elif len(base) == 3:
            group_level[root] = account_level[base]
        if nxt is None or nxt[0] != base[0]:
            cls = base[0]
            total = plain([v for r, v in group_level.items() if r[0] == cls])
            label = "Total clasa %s" % cls
            out.append(Line("class", [(28.0, label, False)] + _figures(total, total_blank, shape)
                            + [(EDGES[8] + 8.0, label, False)], meta={"class": cls, "v": total}))
    grand = plain(list(group_level.values()))
    figs = _figures(grand, total_blank, shape)
    # the grand total's label starts a space's width after its last figure
    label_x = EDGES[8] - PAD + NAME_GAP + 0.9
    out.append(Line("grand", [(21.0, "TOTAL GENERAL", False)] + figs + [(label_x, "TOTAL GENERAL", False)],
                    meta={"v": grand}))
    out.append(Line("sign", [(115.0, "Intocmit,", False), (667.0, "Verificat,", False)]))
    return out


def pages(table: List[Line], title: Sequence[str] = TITLE, header: Optional[List[Line]] = None,
          rows_per_page: int = ROWS_PER_PAGE) -> List[List[Line]]:
    """The table split into pages: the title block and the column header on
    the first, the column header again on every later one (after a lone
    page mark), and a two-line footer on each."""
    header = header if header is not None else header_lines()
    chunks = [table[i:i + rows_per_page] for i in range(0, len(table), rows_per_page)] or [[]]
    out = []
    for n, chunk in enumerate(chunks, start=1):
        top = [Line("title", [(18.0, t, False)]) for t in title] if n == 1 else [Line("mark", [(19.0, ".", False)])]
        foot = [Line("footer", [(18.0, "BALANTA DE VERIFICARE", False)]),
                Line("footer", [(18.0, "Program de test", False), (790.0, "Pagina: %d din %d" % (n, len(chunks)), False)])]
        out.append(top + list(header) + chunk + foot)
    return out


def render(page_lines: List[List[Line]]) -> bytes:
    doc = fitz.open()
    for lines in page_lines:
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        y = 24.0
        for ln in lines:
            for x, text, right in ln.segments:
                page.insert_text((x - width(text) if right else x, y + ln.dy), text, fontname=FONT, fontsize=SIZE)
            y += LINE_STEP
    return doc.tobytes()


def pdf(**kw: Any) -> bytes:
    """The synthetic book, rendered (keywords as `book_lines`)."""
    return render(pages(book_lines(**kw)))
