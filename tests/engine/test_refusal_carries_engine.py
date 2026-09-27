"""GATE refusal-carries-engine — a refused net 711 refuses EBITDA, EBIT and
every margin / ratio built on them on EVERY engine surface, with the same
typed reason (design A8, the engine half of `refusal-carries`).

RULING (owner, 2026-09-26) and design A3: "If net 711 is refused on a book
with 711 activity, EBITDA, EBIT, gross profit and every margin/ratio built
on them REFUSE with the same typed reason. Remove every fallback chain
first" — never 0, never a fallback to another definition.

INCIDENT. The fallback chains the ruling named: `float(ebitda_statutory or
0)` in the pipeline's alerts and the confidence roll-up (a refused EBITDA
read as a loss of the whole build-up), the valuation's legacy recompute on
0.0 (a second EBITDA without 711), `float(apl_ebitda)` in the ratio table,
`?? 0` in the browser. A refused figure that becomes 0 is a verdict: "EBITDA
RON 0", Debt/EBITDA "not meaningful", a covenant breach.

LAW. On the two refused CONSTRUCTED books (SYNTHETIC, no client data —
`unanchored`: account 121 absent, G2; `g6_uncleared`: 121's opening not
cleared, G6), through the real write path and GET /api/period, every engine
surface states EBITDA / EBIT (and the margins and ratios built on them) as
absent, and where it carries a code, the 711 refusal's (or its cause):
the assembled P&L and its aliases, the GET /api/period metrics block, the
reconciliation line and bridge, the stored metric rows, the ratio table
rows (reason `ebitda_refused`, cause = the 711 code), the credit model,
the methodology views and its refusals, FactsGateway (RefusedFactError),
the valuation (EV/EBITDA refused, routed with the reason), the Section 9
benchmark (not graded), the forecast's year 0, the briefing's citable
ratios (the engine's reason, never "not reported") and the confidence
roll-up (not emitted — never a delta against 0).

REDS ON (TC-11): any of those surfaces carrying a number (a 0 above all)
for a refused EBITDA, EBIT or a ratio built on them; a surface carrying a
different code than the 711 refusal; a scope without both refusal kinds
(vacuous, TC-3).
CANNOT SEE: whether the engine was right to refuse (net-711-rule); the
browser (the frontend `refusal-carries` gate).
"""
from __future__ import annotations

from typing import Any, Dict, List

import pytest

from _one_definition_served import (
    EBIT_SURFACES, EBITDA_SURFACES, REFUSED_BOOKS, Refused, served)

WORK: Dict[str, Any] = {"checks": 0, "books": [], "codes": {}}

#: Ratio-table rows built on EBITDA / EBIT / gross profit.
RATIO_ROWS = ("ebitda_margin", "operating_margin", "gross_margin", "core_ebitda_margin",
              "debt_to_ebitda", "net_debt_to_ebitda", "interest_coverage",
              "ebitda_to_interest", "dscr")
#: Stored metric rows built on them.
METRIC_ROWS = ("ebitda", "ebitda_cash", "ebitda_statutory", "operating_profit",
               "gross_margin", "ebitda_margin", "operating_margin", "core_ebitda",
               "core_ebitda_margin", "adjusted_ebitda", "debt_to_ebitda",
               "net_debt_to_ebitda", "interest_coverage", "ebitda_to_interest", "dscr")


def test_refusal_carries_the_witnesses_exist(capsys):
    codes = {}
    for name in REFUSED_BOOKS:
        inv = served(name).apl["inventory_variation"]
        assert inv.get("value") is None and inv.get("refusal"), (name, inv)
        codes[name] = inv["refusal"]["code"]
        # the buckets WOULD rebuild a number: a surface that fell back
        # would carry one
        assert served(name).apl["ebitda_before_stock_variation"] > 0
    WORK["codes"] = codes
    with capsys.disabled():
        print("\nSCOPE refusal-carries-engine: refused books %s"
              % "; ".join("%s (%s)" % kv for kv in sorted(codes.items())))
    assert set(codes.values()) == {"account_121_anchor_absent", "account_121_opening_not_cleared"}


@pytest.mark.parametrize("name", REFUSED_BOOKS)
def test_refusal_carries_every_engine_surface_refuses_with_the_711_reason(name):
    from engine.api import pipeline as P

    b = served(name)
    apl = b.apl
    code = apl["inventory_variation"]["refusal"]["code"]
    problems: List[str] = []

    def refused(label: str, got: Any, carries_code: bool = True) -> None:
        WORK["checks"] += 1
        if isinstance(got, Refused) and got.code == "bench:ebitda_refused":
            return  # the benchmark's own code + RO/EN sentence (its rows carry no cause)
        if isinstance(got, Refused):
            if carries_code and got.code not in (code, None):
                problems.append("%s: %s refuses with %r, the 711 refusal is %r"
                                % (name, label, got.code, code))
            if carries_code and got.code is None:
                problems.append("%s: %s refuses without the 711 reason" % (name, label))
        elif got is not None:
            problems.append("%s: %s carries %r for a REFUSED figure (711 refused: %s)"
                            % (name, label, got, code))

    # 1. The assembled P&L: every EBITDA-family field None, the refusal typed.
    if (apl.get("ebitda_refusal") or {}).get("code") != code:
        problems.append("%s: ebitda_refusal %r, expected the 711 code %r"
                        % (name, apl.get("ebitda_refusal"), code))
    for fld in ("ebitda", "ebit", "operating_result", "gross_profit", "pretax", "core_ebitda",
                "adjusted_ebitda"):
        refused("assembled_pl.%s" % fld, apl.get(fld), carries_code=False)

    # 2. Every EBITDA / EBIT surface of the one-ebitda gate refuses. Those
    #    that carry no code of their own (a plain None) are held to None.
    no_code = {"assembled_pl.ebitda_statutory (alias)", "assembled_pl.ebitda_operational (alias)",
               "assembled_pl.ebitda_operating_view (alias)", "assembled_pl.ebitda_cash (alias)",
               "assembled_pl.operating_ebitda (alias)", "GET /api/period assembled_metrics.pl.ebitda",
               "metric row 'ebitda' (stage_compute)", "metric row 'ebitda_statutory'",
               "metric row 'ebitda_cash'", "ratio table Debt / EBITDA operand",
               "assembled_pl.ebit", "assembled_pl.operating_ebit (alias)",
               "metric row 'operating_profit'", "GET /api/period assembled_metrics.pl.ebit",
               "assembled_pl.ebitda_reconciliation bridge (before + 711 + 72x)",
               "confidence check ebitda_rollup (computed side)",
               "assembled_pl.ebitda_reconciliation line 'ebitda'",
               "assembled_pl.ebitda_reconciliation line 'operating_result'"}
    for label, read in EBITDA_SURFACES + EBIT_SURFACES:
        refused(label, read(b), carries_code=label not in no_code)

    # 3. The ratio table: refused, reason ebitda_refused with the 711 cause.
    rows = dict((r["key"], r) for r in (b.am.get("ratio_table") or {}).get("rows") or [])
    for key in RATIO_ROWS:
        WORK["checks"] += 1
        row = rows.get(key)
        if row is None:
            problems.append("%s: the ratio table serves no %r row" % (name, key))
            continue
        reason = row.get("reason") or {}
        if row.get("value") is not None:
            problems.append("%s: ratio table %s = %r for a refused EBITDA" % (name, key, row["value"]))
        elif reason.get("code") != "ebitda_refused" or reason.get("cause") != code:
            problems.append("%s: ratio table %s refuses with %r / cause %r, expected "
                            "ebitda_refused / %r" % (name, key, reason.get("code"),
                                                    reason.get("cause"), code))

    # 4. The stored metric rows: absent, never 0.
    for key in METRIC_ROWS:
        refused("metric row %r" % key, b.metrics.get(key), carries_code=False)

    # 5. The credit model: the components on EBITDA refused, no letter on them.
    if (b.credit.get("refusal") or {}).get("cause", (b.credit.get("refusal") or {}).get("code")) \
            not in (code,):
        problems.append("%s: credit operating_figures refusal %r" % (name, b.credit.get("refusal")))

    # 6. The valuation: no EV/EBITDA figure, routed with the reason.
    for key in ("ev_ebitda_p25", "ev_ebitda_p50", "ev_ebitda_p75",
                "equity_ebitda_p25", "equity_ebitda_p50", "equity_ebitda_p75"):
        refused("valuation %s" % key, b.valuation.get(key), carries_code=False)
    if (b.valuation.get("routing") or {}).get("basis") != "ebitda_refused":
        problems.append("%s: valuation routing %r" % (name, b.valuation.get("routing")))

    # 7. The benchmark: not graded, refusals typed.
    for key in ("ebitda", "ebitda_margin", "debt_to_ebitda"):
        WORK["checks"] += 1
        if b.bench.get(key) is not None or key not in (b.bench.get("refusals") or {}):
            problems.append("%s: benchmark %s = %r (refusals %r)"
                            % (name, key, b.bench.get(key), sorted(b.bench.get("refusals") or {})))

    # 8. The briefing's citable ratios: None, with the ENGINE's reason.
    ratios, refusals = P._briefing_ratios(apl, b.statements.get("assembled_bs") or {}, None)
    text = apl["inventory_variation"]["refusal"].get("text_en") or code
    for key in ("ebitda_margin_pct", "debt_to_ebitda"):
        WORK["checks"] += 1
        if ratios.get(key) is not None or text not in (refusals.get(key) or ""):
            problems.append("%s: briefing %s = %r (%r) — expected the engine's reason"
                            % (name, key, ratios.get(key), refusals.get(key)))

    # 9. The methodology names the refusal on every view it withholds.
    meth_refusals = (b.envelope.get("methodology") or {}).get("refusals") or {}
    for view in ("ebitda.reported", "ebitda.cash", "totals.gross_profit",
                 "totals.operating_profit_reported", "ratios.ebitda_margin_reported"):
        WORK["checks"] += 1
        if (meth_refusals.get(view) or {}).get("code") != code:
            problems.append("%s: methodology refusal for %s is %r" % (name, view, meth_refusals.get(view)))

    WORK["books"].append(name)
    assert not problems, "\n".join(problems)


def test_refusal_carries_zz_work(capsys):
    with capsys.disabled():
        print("\nREFUSAL-CARRIES-ENGINE books judged: %s" % ", ".join(WORK["books"]))
        print("GATE-WORK refusal-carries-engine units=%d" % WORK["checks"])
    assert sorted(WORK["books"]) == sorted(REFUSED_BOOKS), WORK["books"]
