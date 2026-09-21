"""stage_extract reads a text-layer balanta PDF WITHOUT Claude.

Production 2026-09-21: every balanta PDF the positional ingester could not
read went to the Claude extractor, and with the Anthropic account out of
credit every such upload failed (502). This drives the REAL stage_extract
PDF branch on a synthetic balanta PDF (generated here with PyMuPDF, an
invented company and invented figures) with storage faked and the
`anthropic` module made unimportable: if any code path reaches Claude, the
test fails. It asserts the text-line reader produced the Excel-path parse
(source_format saga_10_col) with the account-121 anchor — for both layouts
the reader knows: the eight-figure "sume totale" balanta and the five-pair
WinMentor/SceptrumERP one (Sold initial / Rulaj anterior / Rulaj curent /
Total rulaj / Sold final, comma-thousands figures, dotted analytic codes).
"""
from __future__ import annotations

import sys
from decimal import Decimal

import pytest

fitz = pytest.importorskip("fitz")

from engine.api import pipeline  # noqa: E402


def _fmt(v: Decimal) -> str:
    return f"{v:,.2f}".replace(",", " ")


def _synthetic_balanta_lines(n: int = 12):
    lines = [
        "EXEMPLU TEST SRL c.f. 1234567",
        "Balanta de verificare",
        "01.12.2025 -- 31.12.2025",
        "Solduri initiale an Rulaje perioada Sume totale Solduri finale",
        "Cont Denumirea contului",
        "Debitoare Creditoare Debitoare Creditoare Debitoare Creditoare Debitoare Creditoare",
    ]
    c1, c5 = [], []
    for i in range(n):
        amt = Decimal(1000 + 137 * i) + Decimal("0.25")
        big = Decimal(45_200) + i
        c1.append((f"10{i:02d}", f"CAPITAL {i}", [Decimal(0), amt, Decimal(0), big, Decimal(0), amt + big, Decimal(0), amt + big]))
        c5.append((f"51{i:02d}", f"CONT BANCAR {i}", [amt, Decimal(0), big, Decimal(0), amt + big, Decimal(0), amt + big, Decimal(0)]))
    # account 121 closes in credit (a profit) — the anchor the Excel path reads
    profit = Decimal("12345.67")
    c1.append(("121", "PROFIT SI PIERDERE", [Decimal(0), Decimal(0), Decimal(0), profit, Decimal(0), profit, Decimal(0), profit]))
    c5.append(("5311", "CASA IN LEI", [Decimal(0), Decimal(0), profit, Decimal(0), profit, Decimal(0), profit, Decimal(0)]))
    for cls, rows in (("1", c1), ("5", c5)):
        for cont, name, v in rows:
            lines.append(f"{cont} {name} " + " ".join(_fmt(x) for x in v))
        tot = [sum((r[2][i] for r in rows), Decimal(0)) for i in range(8)]
        lines.append(f"Total sume clasa {cls} " + " ".join(_fmt(x) for x in tot))
    return lines


def _pdf_bytes(lines) -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=1400, height=1000)
    y = 30
    for line in lines:
        page.insert_text((20, y), line, fontsize=8)
        y += 14
    return doc.tobytes()


class _FakeAdmin:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def signed_url(self, *a, **k):
        return "https://storage.invalid/balanta.pdf"


class _FakeResponse:
    def __init__(self, content: bytes):
        self.content = content

    def raise_for_status(self):
        return None


def _fake_client_factory(content: bytes):
    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get(self, url):
            return _FakeResponse(content)

    return _FakeClient


def _arm(monkeypatch, content: bytes) -> bytes:
    monkeypatch.setattr(pipeline._supabase, "admin", lambda: _FakeAdmin())
    monkeypatch.setattr(pipeline.httpx, "Client", _fake_client_factory(content))
    monkeypatch.setattr(pipeline, "_maybe_route_ai_lane", lambda *a, **k: None)
    monkeypatch.setitem(sys.modules, "anthropic", None)  # any Claude path now raises
    return content


@pytest.fixture
def balanta_pdf(monkeypatch):
    return _arm(monkeypatch, _pdf_bytes(_synthetic_balanta_lines()))


def _fmt5(v: Decimal) -> str:
    return f"{v:,.2f}"


def _synthetic_five_pair_lines(n: int = 12):
    """Five (debit, credit) pairs per account: Sold initial, Rulaj anterior,
    Rulaj curent, Total rulaj (= anterior + curent), Sold final (= initial +
    Total rulaj). Invented company, invented figures."""
    z = Decimal(0)
    lines = [
        "Balanta analitica",
        "Societate: EXEMPLU TEST SRL",
        "Adresa: Str. Exemplu 1 Decembrie 2025",
        "C.U.I: RO1234567",
        "Cont Denumire Sold initial Rulaj anterior Rulaj curent Total rulaj Sold final",
        "Debit Credit Debit Credit Debit Credit Debit Credit Debit Credit",
    ]

    def row(si_d, si_c, ra_d, ra_c, rl_d, rl_c):
        tr_d, tr_c = ra_d + rl_d, ra_c + rl_c
        net = (si_d - si_c) + (tr_d - tr_c)
        return [si_d, si_c, ra_d, ra_c, rl_d, rl_c, tr_d, tr_c, max(net, z), max(-net, z)]

    c1, c5 = [], []
    for i in range(n):
        a = Decimal(1000 + 137 * i) + Decimal("0.25")
        b = Decimal(1_234_567) + i
        c = Decimal(-250) if i == 3 else Decimal(20_000 + 11 * i)  # row 3: a storno
        c1.append((f"10{i:02d}.01", f"Capital {i} 10{i:02d}.01", row(z, a, z, b, z, c)))
        c5.append((f"51{i:02d}.01", f"Cont bancar {i} 51{i:02d}.01", row(a, z, b, z, c, z)))
    # account 121 closes in credit (a profit) — the anchor the Excel path reads
    c1.append(("121", "121 Profit sau pierdere", row(z, z, z, Decimal("12000.00"), z, Decimal("345.67"))))
    c5.append(("5311.07", "Casa in lei 5311.07", row(z, z, Decimal("12000.00"), z, Decimal("345.67"), z)))
    grand = [z] * 10
    for cls, rows in (("1", c1), ("5", c5)):
        lines.append(f"Clasa {cls}")
        for cont, name, v in rows:
            lines.append(f"{cont} {name} " + " ".join(_fmt5(x) for x in v))
        tot = [sum((r[2][i] for r in rows), z) for i in range(10)]
        grand = [g + t for g, t in zip(grand, tot)]
        lines.append(f"Total clasa {cls}: " + " ".join(_fmt5(x) for x in tot))
    lines.append("Total general: " + " ".join(_fmt5(x) for x in grand))
    lines.append("Data si ora tiparirii: 02/01/2026 10:00 1 / 1")
    return lines


@pytest.fixture
def five_pair_pdf(monkeypatch):
    return _arm(monkeypatch, _pdf_bytes(_synthetic_five_pair_lines()))


def _doc():
    return {
        "id": "00000000-0000-4000-8000-00000000pdf1",
        "org_id": "00000000-0000-4000-8000-0000000000aa",
        "storage_path": "org/balanta verificare test dec 2025.pdf",
        "original_filename": "balanta verificare test dec 2025.pdf",
        "mime_type": "application/pdf",
    }


def test_a_balanta_pdf_is_read_on_the_excel_path_without_claude(balanta_pdf):
    parsed = pipeline.stage_extract(_doc())
    ext = parsed.get("extraction") or {}
    assert ext.get("source_format") == "saga_10_col", ext
    assert ext.get("method") == "deterministic", ext
    assert Decimal(str(parsed["statutory_net_profit_anchor"])).quantize(Decimal("0.01")) == Decimal("12345.67")
    assert str(parsed.get("period_end")) == "2025-12-31"
    assert parsed.get("accounts"), "no mapped accounts"


def test_a_five_pair_balanta_pdf_is_read_on_the_excel_path_without_claude(five_pair_pdf):
    from engine.country_packs.ro_romania import pdf_balanta_text

    conv = pdf_balanta_text.read_balanta_text_pdf(five_pair_pdf)
    assert conv is not None and conv[1]["layout"] == "five_pair", "the reader refused the synthetic book"
    parsed = pipeline.stage_extract(_doc())
    ext = parsed.get("extraction") or {}
    assert ext.get("source_format") == "saga_10_col", ext
    assert ext.get("method") == "deterministic", ext
    assert Decimal(str(parsed["statutory_net_profit_anchor"])).quantize(Decimal("0.01")) == Decimal("12345.67")
    assert str(parsed.get("period_end")) == "2025-12-31"
    assert parsed.get("accounts"), "no mapped accounts"


# ── a five-pair book the reader refuses is REFUSED, never approximated ──
#
# Before 2026-09-21 (repair round) a five-pair book the verified reader
# refused fell through to the positional fast-path, which reads only
# undotted codes and accepts on the account-121 anchor alone: one row off
# by a cent came back as source_format pdf_positional with ONE account of
# twenty-eight; a book printed credit-first came back with the 121 anchor
# at -12,345.67 (a profit served as a loss).


def _tampered(fn):
    lines = _synthetic_five_pair_lines()
    return fn(lines)


def _off_by_a_cent(lines):
    out = list(lines)
    i = next(k for k, l in enumerate(out) if l.startswith("1002.01 "))
    toks = out[i].split(" ")
    whole, cents = toks[-1].split(".")
    toks[-1] = whole + "." + "%02d" % ((int(cents) + 1) % 100)
    out[i] = " ".join(toks)
    return out


def _credit_first(lines):
    def swap(line):
        parts = line.split(" ")
        tail = parts[-10:]
        if len(parts) < 11 or not all(any(ch.isdigit() for ch in t) and "." in t for t in tail):
            return line
        flipped = []
        for k in range(0, 10, 2):
            flipped += [tail[k + 1], tail[k]]
        return " ".join(parts[:-10] + flipped)
    return [" ".join(["Credit Debit"] * 5) if l.startswith("Debit Credit") else swap(l) for l in lines]


@pytest.mark.parametrize("tamper, why", [
    (_off_by_a_cent, "sold final != sold initial + total rulaj"),
    (lambda ls: [l for l in ls if not l.startswith("Total clasa 5:")], "no printed total for class 5"),
    (lambda ls: ls[:-1] + ["Pagina 1 din 1 1,000.00 2,000.00"], "a page header/footer line carries figures"),
    (_credit_first, "not followed by the Debit/Credit sub-header"),
], ids=["row-off-by-a-cent", "class-total-missing", "footer-with-figures", "credit-first"])
def test_a_five_pair_book_the_reader_refuses_is_refused_not_served(monkeypatch, tamper, why):
    _arm(monkeypatch, _pdf_bytes(_tampered(tamper)))
    with pytest.raises(pipeline.BalantaPdfRefusedError) as refused:
        pipeline.stage_extract(_doc())
    assert why in str(refused.value)
    assert "Nothing was estimated" in str(refused.value)


def test_the_untampered_five_pair_book_is_still_read(five_pair_pdf):
    # the control for the refusals above
    parsed = pipeline.stage_extract(_doc())
    assert (parsed.get("extraction") or {}).get("source_format") == "saga_10_col"


def test_an_eight_figure_refusal_keeps_its_fall_back(monkeypatch):
    # the eight-figure layout is unchanged: a book it refuses still falls
    # through (here to the Claude path, which the harness makes
    # unimportable) — it is never a BalantaPdfRefusedError
    lines = _synthetic_balanta_lines()
    lines = [l for l in lines if not l.startswith("Total sume clasa 5")]
    _arm(monkeypatch, _pdf_bytes(lines))
    with pytest.raises(Exception) as fell_through:
        pipeline.stage_extract(_doc())
    assert not isinstance(fell_through.value, pipeline.BalantaPdfRefusedError)
