"""interest-coverage-one-operand — every printed interest coverage divides
the EBIT the P&L prints, and equals its own recomputation to the printed
digit.

THE SEAM (owner, 2026-09-21: "confirm the served metric equals its own
recomputation; fix the 0.32 vs 0.3257 seam")
=====================================================================
`assembled_pl` carries two EBITs. `ebit` is revenue - COGS - opex + other
operating income - D&A; `operating_ebit` is the operating VIEW, which also
folds in 722 capitalized own work and 767 discounts received. On the
retail corpus book under tb_parser_v6 they are 1,923.78 apart (786,579.83
against 788,503.61, over interest 2,421,110.34). The engine's
`interest_coverage` row divided `ebit` (0.3249 -> "0.32") while the
frontend's no-envelope credit model and the export's G4 recomputation
divided `operating_ebit` (0.3257 -> "0.33") — three printed coverages of
one book, two different numbers.

WHICH EBIT IS THE ANSWER, AND WHY THE ENGINE KEEPS ITS OPERAND
--------------------------------------------------------------
The engine is internally consistent: its row, its coverage sub-score, its
declared-rung predicate (`credit_model.operating_profit`) and the ratio
table's fallback (`table.ebit`) all divide `ebit`, and `ebit` is the EBIT
the P&L PRINTS — the line from which `ebit + net_financial_result` foots
to `pretax` (ComprehensiveReport's and the export's "EBIT" rows both read
`assembled_pl.ebit`). So the frontend moved to it, not the engine to the
operating view.

THE ONE EBITDA (owner ruling 2026-09-26)
----------------------------------------
Since the ruling the P&L carries ONE operating result: `ebit`,
`operating_result` and the legacy `operating_ebit` are one figure (net 711
"Variația stocurilor de produse" and net 72x inside, 767 financial). The
two-EBIT seam above is closed by construction; what is left to hold is that
the coverage divides THAT figure, and not the pre-ruling EBIT without 711 /
72x (`ebitda_before_stock_variation - depreciation`), which still prints a
different coverage on the manufacturers (agras 28.14 against 32.00).

WHAT THIS GATE CHECKS (the real GET /api/period, no double)
============================================================
On the four corpus books and the Scandia regression baseline, served
through `_served_books` (the production write path and the real router):
  0. ONE EBIT: `ebit`, `operating_result` and `operating_ebit` are one
     figure; where the assembly refuses the one EBITDA (the Scandia
     baseline, persisted before the stock variation was measured) all three
     and `pretax` are null and the coverage row refuses as `ebitda_refused`.
  1. `ebit` is the EBIT the P&L prints: ebit + net_financial_result ==
     pretax, to the cent.
  2. The served ratio-table row `interest_coverage` prints exactly
     quantize(ebit / interest) — the served metric equals its own
     recomputation to the printed digit — whenever interest is positive.
  2b. The table's own definition (a payload with no metric rows, so the
     row falls back to its formula and prints its operands: the assembled
     `operating_result` and interest): the operands recompute the served
     digits and the operating result is the P&L's EBIT to the cent.
  3. The serve-time credit metric row carries the same value to 4 dp.
  4. Non-vacuity (TC-3): at least one book on which quantize(ebit /
     interest) and the pre-ruling EBIT's coverage PRINT DIFFERENTLY, so a
     row re-pointed at the EBIT without 711 / 72x reds here; and at least
     two books with positive interest.
The frontend halves are held in vitest: `interestCoverageBasis.test.ts`
(the no-envelope credit model, retail strict at 0.32),
`exportRatioFormulas.test.ts` G4 (the export's printed value against its
own recomputation from `assembled_pl.ebit`) and
`interestCoveragePopover.test.tsx` (the Ratios card's "How it's computed"
popover: its printed EBIT and Interest tokens recompute the card's digits
on the same five books, and an absent interest prints "not reported",
never 0; and the operands as RENDERED — to the bani — divide, as printed,
to the card's digits on every corpus book with interest, over the corpus
fixture `test_coverage_popover_corpus_fixture.py` keeps fresh).

WHAT IT REDS ON (TC-11): the engine row, the metric row or the table
fallback dividing any EBIT other than the one operating result (the
pre-ruling EBIT without 711 / 72x included); a second EBIT served under a
legacy name; a refused EBITDA served as a coverage; a served EBIT that no
longer foots to pretax; a scope with no book that discriminates the two
operands.
IT CANNOT SEE: surfaces that recompute coverage outside the served row
(held by the three vitest halves above); books with zero interest
(carniprod is refused / declared, and is printed as such).
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List

import pytest

import _served_books as SB
from engine.ratios import table as T


def _q(value: float) -> str:
    return T.quantize_display(value, "x")


def _row(table: Dict[str, Any], key: str) -> Dict[str, Any]:
    rows = [r for r in table["rows"] if r["key"] == key]
    assert len(rows) == 1, (key, len(rows))
    return rows[0]


@pytest.fixture(scope="module")
def books() -> Dict[str, Dict[str, Any]]:
    out = {}
    for name in SB.ALL_BOOKS:
        body = SB.served_body(name)
        out[name] = body
    return out


def _cents(x: float) -> Decimal:
    return Decimal(repr(float(x))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def test_every_printed_interest_coverage_divides_the_printed_ebit(books, capsys):
    lines: List[str] = []
    measured = 0
    discriminating = 0
    failures: List[str] = []
    for name, body in books.items():
        pl = body["statements"]["assembled_pl"]
        ebit, op_ebit = pl["ebit"], pl["operating_ebit"]
        interest = pl["interest_expense"]
        served = _row(body["assembled_metrics"]["ratio_table"], "interest_coverage")
        # 0. ONE EBIT under every name — or one refusal
        if ebit != op_ebit or ebit != pl["operating_result"]:
            failures.append("%s: two EBITs served: ebit %s, operating_ebit %s, operating_result %s"
                            % (name, ebit, op_ebit, pl["operating_result"]))
        if pl.get("ebitda_refusal"):
            if ebit is not None or pl["pretax"] is not None:
                failures.append("%s: the one EBITDA is refused yet EBIT %s / pretax %s is served"
                                % (name, ebit, pl["pretax"]))
            if served.get("value") is not None or (served.get("reason") or {}).get("code") != "ebitda_refused":
                failures.append("%s: the coverage row does not refuse with the EBITDA: %s / %r"
                                % (name, served.get("value_q"), served.get("reason")))
            lines.append("  %-18s one EBITDA refused (%s): coverage refused as %s"
                         % (name, pl["ebitda_refusal"].get("code"), (served.get("reason") or {}).get("code")))
            continue
        # 1. the P&L's EBIT line is `ebit`: it foots to pretax
        foot = _cents(ebit) + _cents(pl["net_financial_result"]) - _cents(pl["pretax"])
        if foot != 0:
            failures.append("%s: ebit %s + net financial result %s != pretax %s (off %s)"
                            % (name, ebit, pl["net_financial_result"], pl["pretax"], foot))
        table = T.build_ratio_table(body, serve_time_metrics=True)
        rebuilt = _row(table, "interest_coverage")
        if not interest > 0:
            lines.append("  %-18s interest %s: not measured; served value %s, band %s, reason %s"
                         % (name, interest, served.get("value_q"), served.get("band_status"),
                            (served.get("reason") or {}).get("code")))
            continue
        measured += 1
        want = _q(ebit / interest)
        # The operating result WITHOUT 711 / 72x, on today's lines: since
        # ruling R2 (2026-09-28) the served `depreciation` is D&A without the
        # 6812 / 6814 charges and `ebitda_before_stock_variation` is without
        # the 7812 / 7814 reversals, so the net-provisions line sits between
        # them — without it retail (net provisions 272,427.11, no 711, no
        # 72x) printed a "pre-ruling" EBIT 1,059,006.94 that is no EBIT at all.
        _np = pl.get("net_provisions")
        net_provisions = float(_np.get("value") or 0.0) if isinstance(_np, dict) else 0.0
        pre_ruling_ebit = pl["ebitda_before_stock_variation"] - pl["depreciation"] - net_provisions
        other = _q(pre_ruling_ebit / interest)
        if want != other:
            discriminating += 1
        lines.append("  %-18s EBIT %s / interest %s = %s printed; served %s; the pre-ruling EBIT %s "
                     "would print %s" % (name, ebit, interest, want, served.get("value_q"),
                                         round(pre_ruling_ebit, 2), other))
        # 2. the served row prints its own recomputation
        for label, row in (("served", served), ("serve-time table", rebuilt)):
            if row.get("value_q") != want:
                failures.append("%s: %s interest_coverage prints %s, EBIT / interest recomputes %s"
                                % (name, label, row.get("value_q"), want))
        # 2b. ... and the table's own definition, from the operands it
        # prints when no metric row stands in front of it (the parity basis
        # over a payload with no persisted metrics): the assembled operating
        # result over interest expense
        bare = T.build_ratio_table({"statements": body["statements"], "metrics": []})
        fallback = _row(bare, "interest_coverage")
        if fallback.get("value_q") != want:
            failures.append("%s: the table's own EBIT / interest prints %s, recomputes %s"
                            % (name, fallback.get("value_q"), want))
        ops = dict((o["name"], o["value"]) for o in fallback.get("operands") or [])
        sources = [o["source"] for o in fallback.get("operands") or []]
        if sources != ["assembled_pl.operating_result", "incomeStatement.interestExpense"]:
            failures.append("%s: the table's fallback reads %s, not the one operating result over "
                            "interest" % (name, sources))
        else:
            if _q(ops["ebit"] / ops["interestExpense"]) != served.get("value_q"):
                failures.append("%s: the row's own operands recompute %s, the served row prints %s"
                                % (name, _q(ops["ebit"] / ops["interestExpense"]), served.get("value_q")))
            if _cents(ops["ebit"]) != _cents(ebit):
                failures.append("%s: the row's operand EBIT %s is not the P&L's %s"
                                % (name, _cents(ops["ebit"]), _cents(ebit)))
        # 3. the metric row the table reads carries the same quotient
        metric = [m for m in body.get("metrics") or [] if m.get("name") == "interest_coverage"]
        if metric:
            v = metric[0]["value"]
            if round(v, 4) != round(ebit / interest, 4):
                failures.append("%s: metric row interest_coverage %s != EBIT / interest %s"
                                % (name, v, round(ebit / interest, 4)))
    with capsys.disabled():
        print("\nSCOPE interest-coverage-one-operand: books %d (%s); interest measured on %d; "
              "books where the pre-ruling EBIT (without 711 / 72x) would print a different coverage: %d"
              % (len(books), ", ".join(books), measured, discriminating))
        print("\n".join(lines))
        print("GATE-WORK interest-coverage-one-operand units=%d" % (len(books) + measured))
    assert not failures, "\n".join(failures)
    # 4. TC-3: the gate can tell the two operands apart on this scope
    assert measured >= 2, "fewer than two books with positive interest: %d" % measured
    assert discriminating >= 1, (
        "no book prints a different coverage on the pre-ruling EBIT than on the one EBIT, "
        "so this scope cannot tell which EBIT the row divides")
