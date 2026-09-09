"""Served net income IS account 121, on every book that files one.

THE DEFECT (2026-09-09, found on a real client's two consecutive years):
the anchor was applied only when the reconstruction diverged from account
121 by more than 5% of max(|121|, 100_000 RON). Under that band the field
labelled "Net Income (account 121, as filed)" served the RECONSTRUCTION
on any book whose gap happened to land under the threshold — the value
contradicted its own name.

Worse, it made two periods of ONE company incomparable. Scandia FY2024's
gap was 2,832,404.19 against a 1,605,402.98 threshold, so the override
fired and the filed figure was served. FY2025's was 519,389.11 against
1,839,367.64, so it did not, and the reconstruction was served.
Subtracting the two understated the year's move by 1.618pp.

And `net_income_unexplained_vs_121` was inverted against its own name: it
reported 2,832,404.19 on FY2024, where the anchor had just CLOSED the
gap, and 0.00 on FY2025, where 519,389.11 was genuinely unexplained.

WHAT THESE RED ON, with the defect repaired (TC-11):
  · any threshold, band or tolerance returning to the anchor decision
  · served net income drifting from account 121 on a book that has one
  · `net_income_unexplained_vs_121` reporting 0.00 while the
    reconstruction and the filed figure actually differ
  · the anchor treating a MISSING account 121 as 0.00 (absent ≠ zero) —
    which would force net income to zero on every book without the row
"""
from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest

from engine.country_packs.ro_romania import chart_of_accounts as coa
from engine.country_packs.ro_romania.pack import RomaniaPack
from engine.country_packs.ro_romania.trial_balance_parser import (
    compute_statutory_net_profit_anchor,
)

CORPUS = Path(__file__).parents[2] / "corpus"


def _books():
    """Every corpus book the deterministic Romanian path can parse."""
    out = []
    if not CORPUS.is_dir():
        return out
    for case_dir in sorted(CORPUS.iterdir()):
        if not case_dir.is_dir() or case_dir.name.startswith("_"):
            continue
        inp = next((p for p in case_dir.iterdir()
                    if p.name.startswith("input.")), None)
        if inp is None:
            continue
        out.append((case_dir.name, inp))
    return out


BOOKS = _books()
BOOK_IDS = [b[0] for b in BOOKS]


def _assembled(inp: Path):
    return RomaniaPack().run_deterministic_tb(inp.read_bytes(), filename=inp.name)


# ── the anchor is unconditional ─────────────────────────────────────

def test_no_threshold_survives_in_the_anchor_decision():
    """Structural. A band is what made the label lie; it must not return
    in any form — percentage, absolute floor, or 'materiality'."""
    src = inspect.getsource(coa)
    marker = "anchor_override_applied = False"
    assert marker in src, "the anchor block was restructured — re-read this gate"
    block = src[src.index(marker):]
    block = block[:block.index("net_income_reconciliation_to_121")]
    for banned in ("0.05", "threshold", "100_000", "abs(net_income_statutory"):
        assert banned not in block, (
            f"a band is back in the anchor decision ({banned!r}) — the served "
            f"figure will silently become the reconstruction on some books"
        )


@pytest.mark.parametrize("name,inp", BOOKS, ids=BOOK_IDS)
def test_served_net_income_equals_account_121_on_every_book_that_files_one(name, inp):
    try:
        tb, _shaped, assembled = _assembled(inp)
    except Exception as e:  # a book this deterministic path cannot read
        pytest.skip(f"{name}: not parseable on the RO deterministic path ({type(e).__name__})")
    anchor = compute_statutory_net_profit_anchor(tb)
    pl = assembled["statements"]["assembled_pl"]
    served = pl.get("net_income_statutory")
    if anchor is None:
        # No filed figure in this document. The reconstruction stands, and
        # the field that would bridge to a filed figure must say nothing.
        assert pl.get("net_income_unexplained_vs_121") == 0.0, (
            f"{name} carries no account 121, so there is no gap to explain"
        )
        return
    assert served == pytest.approx(anchor, abs=0.005), (
        f"{name}: served net income {served:,.2f} is not account 121's "
        f"closing balance {anchor:,.2f} — the field is labelled 'as filed'"
    )


@pytest.mark.parametrize("name,inp", BOOKS, ids=BOOK_IDS)
def test_the_unexplained_field_reports_the_real_gap(name, inp):
    """It must mean what it says: the part of the step from the
    reconstruction to the filed figure that nothing on the statement
    names. Reporting 0.00 while the two differ is the inversion."""
    try:
        tb, _shaped, assembled = _assembled(inp)
    except Exception as e:
        pytest.skip(f"{name}: not parseable ({type(e).__name__})")
    if compute_statutory_net_profit_anchor(tb) is None:
        pytest.skip(f"{name}: no account 121 to bridge to")
    pl = assembled["statements"]["assembled_pl"]
    recon = pl["net_income_statutory"] - pl["net_income_operational"]
    named = pl.get("capitalized_own_work_memo") or 0.0
    unexplained = pl["net_income_unexplained_vs_121"]
    assert unexplained == pytest.approx(recon - named, abs=0.02), (
        f"{name}: unexplained reads {unexplained:,.2f} but the step from the "
        f"reconstruction to the filed figure is {recon:,.2f}, of which "
        f"{named:,.2f} is named (722 capitalized own work)"
    )
    if abs(recon - named) > 0.02:
        assert unexplained != 0.0, (
            f"{name}: {recon - named:,.2f} RON is unattributed and the field "
            f"named for it reports zero"
        )


# ── the sub-threshold case no corpus book covers ────────────────────
#
# MEASURED: restoring the 5% band changes NO corpus book's served net
# income. Every corpus book's reconstruction either matches account 121
# exactly or diverges by far more than 5%, so the band is invisible to
# all of them. The book that distinguishes it is the real client's
# FY2025 — gap 519,389.11 against a 1,839,367.64 threshold, i.e. 1.41% —
# and that book is confidential and cannot enter this repository.
#
# So the behavioural assertion above would pass with the defect back.
# This constructed case carries the shape, and is labelled as
# constructed: a book whose reconstruction sits just inside any
# plausible band. Without it the gate is structural only.

def _shaped(rows):
    """The shape `accounts_to_assemble_shape` produces: one signed amount
    per account, which is what assemble_statements actually consumes."""
    return [{"code": c, "name": n, "amount": a} for c, n, a in rows]


def test_a_sub_five_percent_gap_still_serves_the_filed_figure():
    """CONSTRUCTED, not a corpus book — see the note above for why.

    Revenue 1,000,000 against expenses 900,000 reconstructs to 100,000,
    while account 121 closes at 102,000: a 2% gap, comfortably inside the
    old band. Under the band this served 100,000 under a label reading
    "as filed". It must serve 102,000.
    """
    accounts = _shaped([
        ("701",  "Venituri",        1_000_000.0),
        ("601",  "Cheltuieli",        900_000.0),
        ("5121", "Banca",             102_000.0),
    ])
    st = coa.assemble_statements(accounts, account_121_anchor_override=102_000.0)
    pl = st["statements"]["assembled_pl"]
    assert pl["net_income_statutory"] == pytest.approx(102_000.0, abs=0.005), (
        "a 2%% gap fell back to the reconstruction (%.2f) — the 5%% band is "
        "back, and the field labelled 'as filed' is not the filed figure"
        % pl["net_income_statutory"]
    )
    # And the remainder is reported, not zeroed.
    assert pl["net_income_unexplained_vs_121"] != 0.0, (
        "2,000.00 RON separates the reconstruction from the filed figure and "
        "the field named for it reports zero"
    )


# ── absent is not zero ──────────────────────────────────────────────

def test_a_book_with_no_account_121_yields_no_anchor_rather_than_zero():
    rows = [{"cont": "5121", "sf_d": 1000.0, "sf_c": 0.0},
            {"cont": "701",  "sf_d": 0.0, "sf_c": 0.0}]
    assert compute_statutory_net_profit_anchor(rows) is None


def test_a_book_whose_121_genuinely_closes_at_zero_yields_zero_not_none():
    """The other half of the distinction. A dormant company that filed a
    nil result HAS a filed figure, and it is 0.00."""
    rows = [{"cont": "5121", "sf_d": 1000.0, "sf_c": 0.0},
            {"cont": "121",  "sf_d": 0.0, "sf_c": 0.0}]
    assert compute_statutory_net_profit_anchor(rows) == 0.0


def test_the_corpus_book_that_carries_no_121_is_still_read_that_way():
    """corpus/saga_compact_6_col is the real instance: 5 accounts, none of
    them 121, an equity result row of 500.00. Its golden froze p121 = 0.0
    until this was fixed."""
    inp = CORPUS / "saga_compact_6_col" / "input.xlsx"
    if not inp.is_file():
        pytest.skip("corpus book not present")
    tb, _shaped, _assembled_ = _assembled(inp)
    assert not [r for r in tb if str(r.get("cont", "")).startswith("121")]
    assert compute_statutory_net_profit_anchor(tb) is None
    golden = json.loads(
        (CORPUS / "saga_compact_6_col" / "expected" / "served_envelope.json")
        .read_text(encoding="utf-8"))
    block = (golden.get("invariants") or {}).get("p121_cross_check") or {}
    assert block.get("p121") is None, (
        "the golden records a numeric p121 for a book with no 121 row — "
        "absent read as zero, frozen into a corpus expectation"
    )
