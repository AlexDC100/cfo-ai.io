"""Structural impossibilities in a served P&L must refuse, not render.

THE REPORT (2026-09-09). A post-closing balanță — class 6/7 closed to
account 121 every month — carries cumulative debit EQUAL to cumulative
credit on every revenue and expense account, and a closing balance of
zero. Netting the two sides gives zero; reading the closing column gives
zero. Only a ONE-SIDED read (credit for class 7, debit for class 6)
recovers the period. On the real client book that is 1,064,802,111.96 RON
of class-7 credit standing behind 413,727,560.16 of revenue, and a wrong
read serves 0.00 with no complaint from anything.

MEASURED, and it changes how exotic this is: every one of the eight real
books in this repo that carries turnover is post-closing — five corpus
books, a positional PDF, and both real Scandia years. It is not an edge
case in Romanian practice, it is the norm. Which is exactly why nothing
tested it: the product has never seen the alternative.

WHAT THESE RED ON, with the reading correct (TC-11):
  · revenue served as 0.00 while class-70 credit is material
  · EBITDA served as exactly minus total operating expense
  · revenue drifting from the one-sided class-70 credit by any amount
  · the checks losing their teeth — a book that should refuse passing
"""
from __future__ import annotations

from pathlib import Path

import pytest

from engine.country_packs.ro_romania import pl_sanity
from engine.country_packs.ro_romania.pack import RomaniaPack

CORPUS = Path(__file__).parents[2] / "corpus"


def _books():
    out = []
    if CORPUS.is_dir():
        for d in sorted(CORPUS.iterdir()):
            if not d.is_dir() or d.name.startswith("_"):
                continue
            inp = next((p for p in d.iterdir() if p.name.startswith("input.")), None)
            if inp:
                out.append((d.name, inp))
    return out


BOOKS = _books()
BOOK_IDS = [b[0] for b in BOOKS]


def _assemble(inp):
    return RomaniaPack().run_deterministic_tb(inp.read_bytes(), filename=inp.name)


# ── every real book stays servable ──────────────────────────────────

@pytest.mark.parametrize("name,inp", BOOKS, ids=BOOK_IDS)
def test_no_real_book_is_refused(name, inp):
    """A gate that refuses a legitimate book is worse than no gate. An
    earlier draft of PL3 compared served income to ALL of class 7 and
    refused corpus/saga_10_col_realestate, whose class 7 is 99% 711
    production variation (29,589,814.24 against 162,365.46 of class 70,
    served exactly). That was the check being wrong, not the book."""
    try:
        tb, _shaped, assembled = _assemble(inp)
    except Exception as e:
        pytest.skip(f"{name}: not parseable on the RO deterministic path ({type(e).__name__})")
    findings = pl_sanity.check(assembled["statements"]["assembled_pl"], tb)
    assert findings == [], (
        f"{name} would be refused: "
        + "; ".join(f["code"] + " — " + f["message"] for f in findings)
    )


def test_the_book_list_is_not_empty():
    """TC-3. Parametrising over nothing passes."""
    assert BOOKS, "no corpus books found — this suite proves nothing"


# ── the invariant the checks rest on ────────────────────────────────

@pytest.mark.parametrize("name,inp", BOOKS, ids=BOOK_IDS)
def test_revenue_is_exactly_the_one_sided_class70_credit(name, inp):
    """The identity PL3 enforces, asserted directly. Measured exact on
    all 17 books this engine can parse.

    RESTATED (plan/2 B4a, owner ruling 2026-09-18): the one-sided class-70
    credit reads each mirrored 709 row under the convention its document
    decided — on an entry-magnitude exporter (retail, agras, carniprod)
    the printed positive value IS the reduction and enters negated, as
    the assembler enters it. Before B4a this test pinned the defect as
    law: revenue equalled the PRINTED class-70 sum, so retail served
    79,510,264.65 with its 709 reductions added twice and missed account
    121 by 2,043,254.64. `pl_sanity.class_movement` and
    `accounts_to_assemble_shape` now read the row through one
    `trial_balance_parser.contra_reading`, and the identity holds on
    every book with the reductions read as reductions."""
    try:
        tb, _shaped, assembled = _assemble(inp)
    except Exception as e:
        pytest.skip(f"{name}: not parseable ({type(e).__name__})")
    mv = pl_sanity.class_movement(tb)
    revenue = float(assembled["statements"]["assembled_pl"].get("revenue") or 0.0)
    assert revenue == pytest.approx(mv["class70_credit"], abs=0.005), (
        f"{name}: served revenue {revenue:,.2f} != class-70 credit "
        f"{mv['class70_credit']:,.2f}"
    )


def test_the_witness_reads_a_mirrored_709_as_a_reduction_on_entry_magnitude_books():
    """plan/2 B4a. On a document whose exporter prints reductions positive,
    the class-70 witness must differ from the naive printed sum by twice
    the mirrored 709 rows (once to remove the wrong addition, once to
    subtract the reduction); on a natural-signed document the two agree.
    A scope with no entry-magnitude book reds (TC-3)."""
    from engine.country_packs.ro_romania import trial_balance_parser as tbp

    entry_magnitude = []
    for name, inp in BOOKS:
        try:
            tb, _shaped, _assembled = _assemble(inp)
        except Exception:
            continue
        mv = pl_sanity.class_movement(tb)
        naive = sum(float(r.get("st_c") or 0.0) for r in tb
                    if str(r.get("cont") or "").strip().startswith("70"))
        reading = tbp.contra_reading(tb)
        flipped_709 = sum(
            float(r.get("st_c") or 0.0) for r in tb
            if str(r.get("cont") or "").strip().startswith("70")
            and reading.reads_as_reduction(
                str(r["cont"]).strip(), float(r.get("st_d") or 0.0),
                float(r.get("st_c") or 0.0)))
        if mv["contra_convention"] == tbp.CONTRA_ENTRY_MAGNITUDE:
            entry_magnitude.append(name)
            assert flipped_709 > 0, name
            assert mv["class70_credit"] == pytest.approx(naive - 2 * flipped_709, abs=0.005), (
                f"{name}: witness {mv['class70_credit']:,.2f}, printed {naive:,.2f}, "
                f"mirrored 709 {flipped_709:,.2f}")
        else:
            assert flipped_709 == 0, name
            assert mv["class70_credit"] == pytest.approx(naive, abs=0.005), name
    assert entry_magnitude, "no entry-magnitude book in the corpus (TC-3)"


def test_at_least_one_corpus_book_is_post_closing():
    """The signal must actually fire on real data, or PL1's message about
    it is decoration."""
    seen = []
    for name, inp in BOOKS:
        try:
            tb, _s, _a = _assemble(inp)
        except Exception:
            continue
        if pl_sanity.class_movement(tb)["post_closing"]:
            seen.append(name)
    assert seen, "no corpus book detects as post-closing — the detector is dead"


# ── the three refusals, on constructed books ────────────────────────
#
# CONSTRUCTED, and labelled: no real book in this repo exhibits these
# shapes, because the deterministic reader has always been correct. The
# point of the gate is the reader that comes next.

def _post_closing_rows(turnover=1_000_000.0, cost=900_000.0):
    """A minimal post-closing book: both sides equal, closings zero."""
    return [
        {"cont": "701", "nume_cont": "Venituri", "si_d": 0.0, "si_c": 0.0,
         "r_d": 0.0, "r_c": 0.0, "st_d": turnover, "st_c": turnover,
         "sf_d": 0.0, "sf_c": 0.0},
        {"cont": "601", "nume_cont": "Cheltuieli", "si_d": 0.0, "si_c": 0.0,
         "r_d": 0.0, "r_c": 0.0, "st_d": cost, "st_c": cost,
         "sf_d": 0.0, "sf_c": 0.0},
    ]


def test_the_constructed_book_really_is_post_closing():
    mv = pl_sanity.class_movement(_post_closing_rows())
    assert mv["post_closing"] is True
    assert mv["class70_credit"] == pytest.approx(1_000_000.0)
    # And netting it — the wrong read — gives zero, which is the whole point.
    assert mv["class7_credit"] - mv["class7_debit"] == pytest.approx(0.0)


def test_pl1_refuses_zero_revenue_against_material_turnover():
    rows = _post_closing_rows()
    pl = {"revenue": 0.0, "total_operating_expense": 900_000.0, "ebitda": -900_000.0}
    codes = [f["code"] for f in pl_sanity.check(pl, rows)]
    assert "PL1_ZERO_REVENUE_WITH_MOVEMENT" in codes, codes
    with pytest.raises(pl_sanity.PlSanityRefused) as e:
        pl_sanity.assert_servable(pl, rows)
    assert "cannot have zero revenue" in str(e.value)


def test_pl2_refuses_ebitda_that_is_exactly_minus_opex():
    rows = _post_closing_rows()
    # Revenue present so PL1 does not fire; EBITDA still the missing-income
    # signature.
    pl = {"revenue": 1_000_000.0, "total_operating_expense": 900_000.0,
          "ebitda": -900_000.0}
    codes = [f["code"] for f in pl_sanity.check(pl, rows)]
    assert "PL2_EBITDA_IS_MINUS_OPEX" in codes, codes


def test_pl3_refuses_revenue_that_drifts_from_the_class70_credit():
    rows = _post_closing_rows()
    pl = {"revenue": 999_999.99, "total_operating_expense": 900_000.0, "ebitda": 100_000.0}
    codes = [f["code"] for f in pl_sanity.check(pl, rows)]
    assert "PL3_REVENUE_IS_NOT_THE_CLASS70_CREDIT" in codes, codes


def test_a_correct_reading_of_the_same_book_is_servable():
    """POSITIVE CONTROL. Without it the three tests above would pass on
    checks that refuse everything."""
    rows = _post_closing_rows()
    pl = {"revenue": 1_000_000.0, "total_operating_expense": 900_000.0,
          "ebitda": 100_000.0}
    assert pl_sanity.check(pl, rows) == []
    pl_sanity.assert_servable(pl, rows)  # must not raise


def test_a_balance_sheet_only_extract_is_not_refused():
    """No class 6/7 movement at all is a legitimate document, not a
    reading fault. The checks must stand down rather than refuse it."""
    rows = [{"cont": "5121", "nume_cont": "Banca", "si_d": 0.0, "si_c": 0.0,
             "r_d": 0.0, "r_c": 0.0, "st_d": 0.0, "st_c": 0.0,
             "sf_d": 10_000.0, "sf_c": 0.0}]
    assert pl_sanity.check({"revenue": 0.0, "total_operating_expense": 0.0,
                            "ebitda": 0.0}, rows) == []
