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

On the book with NO account 121 (`unanchored`) the NET RESULT refuses too
— the build-up lacks the refused 711 — with net margin, ROE, ROA, the free
cash flow, the cash-flow totals, the profitability sub-score, the benchmark's
headline profit, the briefing's net margin, FactsGateway.net_result and the
Piotroski checks 1-4 (fixer round 1, 2026-09-27) — and (fixer round 2) the
Piotroski SCORE (None with the reason, never 0 off nine uncertain checks),
the balance sheet's current-year result (assembled_bs, subAggregates, the
canonical_v1 leaf and the canonical_bs row: the build-up is not closed into
equity) and the briefing's facts (no current_year_pnl to cite; the net
result None with net_income_refusal beside it). With 121 (`g6_uncleared`)
the filed figure stands and is closed into equity, cited and scored.

TOTAL EQUITY SHORT BY THE REFUSED RESULT (fixer round 1 of the critic,
2026-09-27). The `unanchored` book was rebuilt to balance WITHOUT account
121, so its equity is complete and it could not see a consumer reading
the missing result as 0. `unanchored_unbalanced` is the export with the 121
row dropped: the sheet is short by the year's result (bs_balance_delta
170,000.00). There the assembler serves a completeness refusal beside
total equity (`assembled_bs.total_equity_refusal`, the net result's code),
and everything that divides or scores total equity refuses with it: Altman
X2 (the served credit block's `altman_component_refusals.x2`), the equity
sub-score (`refused_subscores.equity`), the metric rows total_equity /
equity_ratio / debt_to_equity / lt_debt_to_equity / altman_x2 /
credit_subscore_equity, the ratio table's equity rows, and the book-equity
valuation (`asset_based_refusal`, no primary value). Where the sheet
balances (`unanchored`, `g6_uncleared`) equity is complete and every one
of them is served — asserted beside it (non-vacuity).

EVERY OTHER READER OF TOTAL EQUITY (critic round 2, 2026-09-27). Round 1
stopped at the gated surfaces; the briefing's facts still handed the model
total equity as a citable MoneyFact and Debt / Equity 0.45, the methodology
graded the equity ratio 0.4925 against its band, FactsGateway.equity (the
Capsule's equity and equity_ratio) served the short figure, the insights
related-party haircut printed "the equity ratio moves from 49.3% to 49.2%",
and stage_validate R4 / the findings detector judged the Art. 153^24 floor
on it. Section 12 holds each to the refusal on short equity and to the
figure on complete equity (the Art. 153^24 checks on a share capital set so
the floor WOULD fire on the figure; the related-party insight measured on
the corpus developer WITH 121). The second witness is the REAL developer:
`realestate_no121`, corpus/saga_10_col_realestate with account 121101
deleted from the FILE (bs_balance_delta -801,604.14); the one margin rule
refuses its margins first, with its own code — still refused, never a
number.

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

WORK: Dict[str, Any] = {"checks": 0, "books": [], "codes": {}, "net_result_refused": [],
                        "equity_incomplete": [], "equity_complete": [], "equity_readers": []}

#: Every stored metric row that divides or reports TOTAL EQUITY (or, for
#: X2, the cumulative book it holds).
EQUITY_METRIC_ROWS = ("total_equity", "equity_ratio", "debt_to_equity", "lt_debt_to_equity",
                      "altman_x2", "credit_subscore_equity")
#: Ratio-table rows on total equity.
EQUITY_RATIO_ROWS = ("equity_ratio", "debt_to_equity", "lt_debt_to_equity")

#: Books whose margins the ONE MARGIN RULE refuses before EBITDA does (the
#: developer: turnover 0.6 % of its operating activity). Their margin rows,
#: briefing margins and valuation routing refuse with the margin rule's own
#: code — still refused, never a number; every other surface carries the
#: 711 cause.
MARGIN_RULE_BOOKS = frozenset({"realestate_no121"})
MARGIN_KEYS = frozenset({"ebitda_margin", "operating_margin", "gross_margin",
                         "core_ebitda_margin", "net_margin"})

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
        assert abs(served(name).apl["ebitda_before_stock_variation"]) > 0
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
    rows_by_key = rows
    for key in RATIO_ROWS:
        WORK["checks"] += 1
        row = rows.get(key)
        if row is None:
            problems.append("%s: the ratio table serves no %r row" % (name, key))
            continue
        reason = row.get("reason") or {}
        if row.get("value") is not None:
            problems.append("%s: ratio table %s = %r for a refused EBITDA" % (name, key, row["value"]))
        elif name in MARGIN_RULE_BOOKS and key in MARGIN_KEYS \
                and reason.get("code") == "margin_not_meaningful":
            pass  # refused first by the one margin rule — still refused
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
    if (b.valuation.get("routing") or {}).get("basis") not in (
            ("ebitda_refused", "margin_not_meaningful") if name in MARGIN_RULE_BOOKS
            else ("ebitda_refused",)):
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
        if name in MARGIN_RULE_BOOKS and key.endswith("_pct") and ratios.get(key) is None \
                and "margin not meaningful" in (refusals.get(key) or ""):
            continue
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

    # 10. THE NET RESULT (fixer round 1, 2026-09-27). With account 121 the
    #     filed figure stands whatever 711 is (g6_uncleared). WITHOUT it
    #     (unanchored) the net result is the class-6/7 build-up, which
    #     lacks the refused 711 — the developer with its 121 rows dropped
    #     served -30,391,418.38 where 121 holds -801,604.14 — so it refuses
    #     with the same reason, and so does everything built on it.
    anchored = apl.get("net_income_anchor_status") == "anchored"
    abs_ = b.statements.get("assembled_bs") or {}
    sub_agg = b.statements.get("subAggregates") or {}
    gt = P._briefing_grand_totals(
        {"statements": b.statements, "assembled_canonical_v1": b.envelope}, abs_)
    bfacts = P._briefing_facts_raw(apl, abs_, gt)
    pio = b.statements.get("assembled_piotroski") or {}
    if anchored:
        WORK["checks"] += 1
        if apl.get("net_income_refusal") is not None or not isinstance(
                apl.get("net_income_statutory"), (int, float)):
            problems.append("%s: an ANCHORED net result was refused (%r / %r)"
                            % (name, apl.get("net_income_statutory"), apl.get("net_income_refusal")))
        # Non-vacuity of the round-2 laws below: with 121 the filed result
        # IS closed into equity, the briefing may cite it and Piotroski
        # scores its evaluated checks.
        WORK["checks"] += 1
        if abs_.get("current_year_pnl") != apl.get("net_income_statutory") \
                or abs_.get("current_year_pnl_refusal") is not None:
            problems.append("%s: an ANCHORED current-year result on the balance sheet is %r "
                            "(net result %r)" % (name, abs_.get("current_year_pnl"),
                                                 apl.get("net_income_statutory")))
        WORK["checks"] += 1
        if bfacts.get("current_year_pnl") != apl.get("net_income_statutory") \
                or "net_income_refusal" in bfacts:
            problems.append("%s: the briefing's current_year_pnl %r on an ANCHORED book"
                            % (name, bfacts.get("current_year_pnl")))
        WORK["checks"] += 1
        if not isinstance(pio.get("score"), int) or pio.get("refusal") is not None:
            problems.append("%s: Piotroski score %r / refusal %r on an ANCHORED book"
                            % (name, pio.get("score"), pio.get("refusal")))
    else:
        WORK["checks"] += 1
        if (apl.get("net_income_refusal") or {}).get("code") != code:
            problems.append("%s: net_income_refusal %r, expected the 711 code %r"
                            % (name, apl.get("net_income_refusal"), code))
        for fld in ("net_income_statutory", "net_income_reconstructed",
                    "net_income_reconciliation_to_121", "net_income_unexplained_vs_121",
                    "free_cash_flow_proxy"):
            refused("assembled_pl.%s" % fld, apl.get(fld), carries_code=False)
        for fld in ("net_income_statutory",):
            refused("GET /api/period assembled_metrics.pl.%s" % fld,
                    (b.am.get("pl") or {}).get(fld), carries_code=False)
        cf = b.statements.get("assembled_cf") or {}
        for fld in ("net_profit", "cf_before_wc", "cash_from_operating", "free_cash_flow",
                    "net_change_in_cash"):
            refused("assembled_cf.%s" % fld, cf.get(fld), carries_code=False)
        for key in ("net_income_statutory", "net_margin", "roe", "roa", "free_cash_flow",
                    "credit_subscore_profitability"):
            refused("metric row %r" % key, b.metrics.get(key), carries_code=False)
        for key in ("net_margin", "roe", "roa"):
            WORK["checks"] += 1
            row = rows.get(key) or {}
            reason = row.get("reason") or {}
            if row.get("value") is None and name in MARGIN_RULE_BOOKS and key in MARGIN_KEYS \
                    and reason.get("code") == "margin_not_meaningful":
                continue
            if row.get("value") is not None or reason.get("code") != "ebitda_refused" \
                    or reason.get("cause") != code:
                problems.append("%s: ratio table %s = %r refused %r / cause %r, expected "
                                "ebitda_refused / %r" % (name, key, row.get("value"),
                                                        reason.get("code"), reason.get("cause"), code))
        for key in ("net_margin", "net_income_statutory", "net_income_operating"):
            WORK["checks"] += 1
            if b.bench.get(key) is not None or key not in (b.bench.get("refusals") or {}):
                problems.append("%s: benchmark %s = %r (refusals %r)"
                                % (name, key, b.bench.get(key), sorted(b.bench.get("refusals") or {})))
        WORK["checks"] += 1
        if name in MARGIN_RULE_BOOKS and ratios.get("net_margin_pct") is None \
                and "margin not meaningful" in (refusals.get("net_margin_pct") or ""):
            pass
        elif ratios.get("net_margin_pct") is not None or text not in (refusals.get("net_margin_pct") or ""):
            problems.append("%s: briefing net_margin_pct = %r (%r) — expected the engine's reason"
                            % (name, ratios.get("net_margin_pct"), refusals.get("net_margin_pct")))
        from engine.serving.facts import MissingFactError
        WORK["checks"] += 1
        try:
            got = b.gateway.net_result().amount_minor
        except MissingFactError as err:
            if (getattr(err, "refusal", None) or {}).get("code") != code:
                problems.append("%s: FactsGateway.net_result refuses with %r"
                                % (name, getattr(err, "refusal", None)))
        else:
            problems.append("%s: FactsGateway.net_result serves %r for a REFUSED net result"
                            % (name, got))
        for check in (pio.get("checks") or [])[:4]:
            WORK["checks"] += 1
            if check.get("result") != "uncertain":
                problems.append("%s: Piotroski %s is %r on a refused net result"
                                % (name, check.get("key"), check.get("result")))
        # Fixer round 2 (2026-09-27): NO SCORE off zero evaluated checks —
        # the block served `score: 0`, banded "Distressed (0-2)".
        refused("assembled_piotroski.score", pio.get("score"), carries_code=False)
        WORK["checks"] += 1
        if (pio.get("refusal") or {}).get("code") != code:
            problems.append("%s: assembled_piotroski refusal %r, expected the 711 code %r"
                            % (name, pio.get("refusal"), code))
        refused("GET /api/period assembled_metrics.piotroski.score",
                (b.am.get("piotroski") or {}).get("score"), carries_code=False)
        # Fixer round 2: the build-up is not closed into equity — the
        # report's balance sheet printed it as "Current-year P&L" and the
        # briefing could cite it as the year's result.
        refused("assembled_bs.current_year_pnl", abs_.get("current_year_pnl"), carries_code=False)
        WORK["checks"] += 1
        if (abs_.get("current_year_pnl_refusal") or {}).get("code") != code:
            problems.append("%s: assembled_bs.current_year_pnl_refusal %r, expected the 711 code %r"
                            % (name, abs_.get("current_year_pnl_refusal"), code))
        refused("subAggregates.current_year_pnl", sub_agg.get("current_year_pnl"), carries_code=False)
        leaves = b.envelope.get("leaves") or {}
        for leaf in ("current_year_profit", "current_year_loss"):
            WORK["checks"] += 1
            if leaf in leaves:
                problems.append("%s: canonical_v1 carries a %s leaf %r for a REFUSED net result"
                                % (name, leaf, leaves[leaf]))
        rows = [r for r in ((b.envelope.get("canonical_bs") or {}).get("rows") or [])
                if isinstance(r, dict) and r.get("id") in ("current_year_profit", "current_year_loss")]
        WORK["checks"] += 1
        if rows:
            problems.append("%s: canonical_bs serves the result row %r for a REFUSED net result"
                            % (name, rows))
        WORK["checks"] += 1
        if "current_year_pnl" in bfacts:
            problems.append("%s: the briefing's facts carry current_year_pnl %r for a REFUSED "
                            "net result (a citable MoneyFact)" % (name, bfacts["current_year_pnl"]))
        refused("briefing facts net_income_statutory", bfacts.get("net_income_statutory"),
                carries_code=False)
        WORK["checks"] += 1
        if (bfacts.get("net_income_refusal") or {}).get("code") != code:
            problems.append("%s: the briefing's facts carry net_income_refusal %r, expected %r"
                            % (name, bfacts.get("net_income_refusal"), code))
        WORK["net_result_refused"].append(name)

    # 11. TOTAL EQUITY (fixer round 1 of the critic, 2026-09-27): short by
    #     the refused result exactly when the sheet does not balance
    #     without it; complete (and served) otherwise.
    delta = abs_.get("bs_balance_delta")
    incomplete = (apl.get("net_income_refusal") is not None
                  and isinstance(delta, (int, float)) and abs(delta) >= 1.0)
    ter = abs_.get("total_equity_refusal")
    credit_env = b.am.get("credit") or {}
    if incomplete:
        WORK["checks"] += 1
        if (ter or {}).get("code") != code or not (ter or {}).get("text_en") \
                or not isinstance(abs_.get("total_equity"), (int, float)):
            problems.append("%s: total equity short by the refused result (delta %r) serves "
                            "total_equity %r with refusal %r, expected the 711 code %r beside it"
                            % (name, delta, abs_.get("total_equity"), ter, code))
        for key in EQUITY_METRIC_ROWS:
            refused("metric row %r (equity short by the refused result)" % key,
                    b.metrics.get(key), carries_code=False)
        for key in EQUITY_RATIO_ROWS:
            WORK["checks"] += 1
            row = rows_by_key.get(key) or {}
            reason = row.get("reason") or {}
            if row.get("value") is not None or reason.get("code") != "ebitda_refused" \
                    or reason.get("cause") != code:
                problems.append("%s: ratio table %s = %r refused %r / cause %r on equity short by "
                                "the refused result, expected ebitda_refused / %r"
                                % (name, key, row.get("value"), reason.get("code"),
                                   reason.get("cause"), code))
        WORK["checks"] += 1
        x2_ref = (credit_env.get("altman_component_refusals") or {}).get("x2") or {}
        if (credit_env.get("altman_components") or {}).get("x2") is not None \
                or x2_ref.get("cause") != code:
            problems.append("%s: the served credit block's X2 %r (refusal %r), expected None "
                            "refused with %r" % (name, (credit_env.get("altman_components") or {})
                                                 .get("x2"), x2_ref, code))
        WORK["checks"] += 1
        eq_ref = (credit_env.get("refused_subscores") or {}).get("equity") or {}
        if (credit_env.get("subscores") or {}).get("equity") is not None \
                or eq_ref.get("code") != "ebitda_refused" \
                or (eq_ref.get("ebitda_refusal") or {}).get("code") != code:
            problems.append("%s: the served equity sub-score %r refused %r, expected "
                            "ebitda_refused with the 711 cause %r"
                            % (name, (credit_env.get("subscores") or {}).get("equity"), eq_ref, code))
        for key in ("asset_based_equity", "total_equity_used", "primary_equity_value",
                    "primary_equity_low", "primary_equity_high"):
            refused("valuation %s (book equity short by the refused result)" % key,
                    b.valuation.get(key), carries_code=False)
        WORK["checks"] += 1
        if (b.valuation.get("asset_based_refusal") or {}).get("cause") != code:
            problems.append("%s: valuation asset_based_refusal %r, expected the 711 cause %r"
                            % (name, b.valuation.get("asset_based_refusal"), code))
        WORK["equity_incomplete"].append(name)
    else:
        # Non-vacuity: a sheet that balances has complete equity — served.
        WORK["checks"] += 1
        if ter is not None:
            problems.append("%s: a completeness refusal %r beside total equity on a sheet "
                            "that balances (delta %r)" % (name, ter, delta))
        for key in ("total_equity", "equity_ratio", "altman_x2"):
            WORK["checks"] += 1
            if not isinstance(b.metrics.get(key), (int, float)):
                problems.append("%s: metric row %r = %r on COMPLETE equity" % (name, key, b.metrics.get(key)))
        WORK["checks"] += 1
        if not isinstance(b.valuation.get("asset_based_equity"), (int, float)):
            problems.append("%s: the asset-based valuation %r on COMPLETE equity"
                            % (name, b.valuation.get("asset_based_equity")))
        WORK["equity_complete"].append(name)

    # 12. EVERY OTHER READER OF TOTAL EQUITY (critic round 2, 2026-09-27).
    #     Round 1 refused the metric rows, the ratio table, the credit block
    #     and the valuation; these kept printing the short figure: the
    #     briefing's facts (a citable MoneyFact) and its Debt / Equity, the
    #     methodology's graded equity ratio / debt to equity / LT debt to
    #     equity, FactsGateway.equity (Capsule get_facts equity and
    #     equity_ratio), the insights related-party haircut ("the equity
    #     ratio moves from 49.3% to 49.2%"), stage_validate's Art. 153^24
    #     alert (R4) and the findings detector equity_below_half_capital.
    _equity_readers(name, b, abs_, bfacts, bfacts.get("ratios") or {},
                    bfacts.get("ratio_refusals") or {}, code, incomplete, problems)

    WORK["books"].append(name)
    assert not problems, "\n".join(problems)


def _equity_readers(name: str, b: Any, abs_: Dict[str, Any], bfacts: Dict[str, Any],
                    ratios: Dict[str, Any], refusals: Dict[str, Any], code: str,
                    incomplete: bool, problems: List[str]) -> None:
    import copy

    from engine.api import _capsule_tools as CT
    from engine.api import pipeline as P
    from engine.api.findings import s_engine
    from engine.insights import build_insights
    from engine.serving.facts import RefusedFactError

    ter = abs_.get("total_equity_refusal") or {}
    text = ter.get("text_en") or ""
    te = abs_.get("total_equity")

    def check(ok: bool, message: str) -> None:
        WORK["checks"] += 1
        if not ok:
            problems.append("%s: %s" % (name, message))

    # a. The briefing's facts and its Debt / Equity (on the facts' own
    #    grand totals, as stage_narrate hands them to the model).
    if incomplete:
        check(bfacts.get("total_equity") is None
              and (bfacts.get("total_equity_refusal") or {}).get("code") == code,
              "the briefing's facts carry total_equity %r (refusal %r) on equity short by the "
              "refused result — a citable MoneyFact" % (bfacts.get("total_equity"),
                                                         bfacts.get("total_equity_refusal")))
        check(ratios.get("debt_to_equity") is None and text and text in (refusals.get("debt_to_equity") or ""),
              "the briefing's debt_to_equity = %r (%r), expected the engine's reason"
              % (ratios.get("debt_to_equity"), refusals.get("debt_to_equity")))
    else:
        check(isinstance(bfacts.get("total_equity"), (int, float)) and "total_equity_refusal" not in bfacts,
              "the briefing's total_equity %r on COMPLETE equity" % (bfacts.get("total_equity"),))
        check(isinstance(ratios.get("debt_to_equity"), (int, float)),
              "the briefing's debt_to_equity %r on COMPLETE equity" % (ratios.get("debt_to_equity"),))

    # b. The methodology views.
    meth = b.envelope.get("methodology") or {}
    mref = meth.get("refusals") or {}
    mtot = (meth.get("totals") or {}).get("total_equity")
    if incomplete:
        check(mtot is None and (mref.get("totals.total_equity") or {}).get("code") == code,
              "methodology totals.total_equity %r refused %r" % (mtot, mref.get("totals.total_equity")))
    else:
        check(isinstance(mtot, (int, float)) and "totals.total_equity" not in mref,
              "methodology totals.total_equity %r on COMPLETE equity" % (mtot,))
    for key in ("equity_ratio", "debt_to_equity", "lt_debt_to_equity"):
        row = (meth.get("ratios") or {}).get(key) or {}
        if incomplete:
            check(row.get("value") is None and (mref.get("ratios.%s" % key) or {}).get("code") == code,
                  "methodology ratios.%s = %r (band %r) refused %r — graded on equity short by the "
                  "refused result" % (key, row.get("value"), row.get("band"), mref.get("ratios.%s" % key)))
        else:
            check(isinstance(row.get("value"), (int, float)),
                  "methodology ratios.%s = %r on COMPLETE equity" % (key, row.get("value")))

    # c. FactsGateway.equity (Capsule get_facts, the advisory, radar); the
    #    statement's own total stays beside it.
    try:
        got = b.gateway.equity().amount_minor
    except RefusedFactError as err:
        check(incomplete and (err.refusal or {}).get("code") == code,
              "FactsGateway.equity refuses with %r on %s equity"
              % (err.refusal, "short" if incomplete else "COMPLETE"))
    else:
        check(not incomplete and got == b.gateway.statement_equity().amount_minor,
              "FactsGateway.equity serves %r on %s equity" % (got, "short" if incomplete else "complete"))
    check(isinstance(te, (int, float))
          and b.gateway.statement_equity().amount_minor == int(round(te * 100)),
          "the statement's equity total %r is not what the rows sum to (%r)"
          % (b.gateway.statement_equity().amount_minor, te))

    # d. The Capsule's get_facts: equity and the equity ratio on it.
    ref = CT.PeriodRef(period_id="p-%s" % name, label="FY2025", entity_id="e",
                       envelope=b.envelope, statements=b.statements)
    for metric in ("equity", "equity_ratio"):
        value, gap, _lim = CT._metric_value("get_facts", ref, b.gateway, metric)
        if incomplete:
            check(value is None and gap is not None and code in gap.detail
                  and (ter.get("text_en") or "") in gap.detail,
                  "Capsule get_facts %s serves %r (gap %r), expected the refusal with its reason"
                  % (metric, value, gap and gap.detail))
        else:
            check(value is not None and gap is None,
                  "Capsule get_facts %s on COMPLETE equity: %r (gap %r)"
                  % (metric, value, gap and gap.detail))

    # e. The insights related-party haircut.
    ins = build_insights({"statements": b.statements, "envelope": b.envelope,
                          "line_items": b.body.get("line_items") or []})
    fired = [i for i in ins["insights"] if i["id"] == "related_party_exposure"]
    quiet = [n for n in ins["not_fired"] if n["id"] == "related_party_exposure"]
    if incomplete:
        check(not fired and quiet and text in quiet[0]["reason"],
              "the related-party insight %r / %r on equity short by the refused result"
              % ([i["claim"] for i in fired], quiet))
    else:
        check(not (quiet and "Total equity is refused" in quiet[0]["reason"]),
              "the related-party insight refused on COMPLETE equity: %r" % (quiet,))

    # f. stage_validate's Art. 153^24 alert (R4) and the revaluation share
    #    (R6), on a share capital set so the floor WOULD fire on the figure.
    st = copy.deepcopy(b.statements)
    st["assembled_bs"]["share_capital"] = 4.0 * abs(float(te or 0.0)) + 1.0
    alerts = P.stage_validate({"industry_key": None}, {"statements": st}, "p-%s" % name)
    keys = [str(a.get("alert_key") or "").split(":")[0] for a in alerts]
    refused_alert = [a for a in alerts if str(a.get("alert_key") or "").startswith("equity_refused_net_result")]
    if incomplete:
        check("equity_below_half_capital" not in keys
              and "equity_quality_revaluation_reserves" not in keys
              and refused_alert and text in str(refused_alert[0].get("body") or refused_alert[0].get("message")
                                                or refused_alert[0]),
              "stage_validate judged equity short by the refused result: %r" % (keys,))
    else:
        check("equity_below_half_capital" in keys and not refused_alert,
              "stage_validate R4 on COMPLETE equity below half the capital: %r" % (keys,))

    # g. The findings detector equity_below_half_capital, same capital.
    res = s_engine.run_single_period(st, "p-%s" % name)
    fired_rules = [row["rule_key"] for row in res.payloads()]
    checks_ = [c for c in res.all_checks() if c.get("rule_id") == "equity_below_half_capital"]
    if incomplete:
        check("equity_below_half_capital" not in fired_rules
              and checks_ and text in (checks_[0].get("note") or ""),
              "findings equity_below_half_capital judged equity short by the refused result: "
              "fired %r, check %r" % (fired_rules, checks_))
    else:
        check("equity_below_half_capital" in fired_rules,
              "findings equity_below_half_capital did not fire on COMPLETE equity below half "
              "the capital: %r" % (checks_,))
    WORK["equity_readers"].append("%s (%s)" % (name, "refused" if incomplete else "served"))


def test_refusal_carries_the_related_party_insight_measures_complete_equity():
    """Non-vacuity of 12e: on the developer WITH account 121 (corpus
    `realestate`, complete equity, related-party balances) the insight
    fires and restates the equity ratio — the refusal on its no-121 copy
    is not an insight that never fires."""
    from engine.insights import build_insights

    b = served("realestate")
    ins = build_insights({"statements": b.statements, "envelope": b.envelope,
                          "line_items": b.body.get("line_items") or []})
    fired = [i for i in ins["insights"] if i["id"] == "related_party_exposure"]
    WORK["checks"] += 1
    assert fired, [n for n in ins["not_fired"] if n["id"] == "related_party_exposure"]
    measures = dict((m["key"], m["value"]) for m in fired[0]["measures"])
    assert isinstance(measures.get("equity_ratio"), (int, float)), measures
    WORK["related_party_complete"] = fired[0]["claim"]


def test_refusal_carries_zz_work(capsys):
    with capsys.disabled():
        print("\nREFUSAL-CARRIES-ENGINE books judged: %s" % ", ".join(WORK["books"]))
        print("NET-RESULT refused (no account 121): %s" % ", ".join(WORK["net_result_refused"]))
        print("EQUITY short by the refused result: %s; complete: %s"
              % (", ".join(WORK["equity_incomplete"]), ", ".join(sorted(WORK["equity_complete"]))))
        print("EQUITY-READERS (briefing facts + Debt/Equity, methodology, FactsGateway.equity, "
              "Capsule, insights, R4, findings): %s" % ", ".join(WORK["equity_readers"]))
        print("GATE-WORK refusal-carries-engine units=%d" % WORK["checks"])
    assert sorted(WORK["books"]) == sorted(REFUSED_BOOKS), WORK["books"]
    # TC-3: the net-result law has a witness (a refused 711 with no 121).
    assert WORK["net_result_refused"] == ["unanchored", "unanchored_unbalanced", "realestate_no121"], \
        WORK["net_result_refused"]
    # TC-3: the equity law has a witness on each side — a CONSTRUCTED one
    # and the real developer with its 121 row deleted from the file.
    assert WORK["equity_incomplete"] == ["unanchored_unbalanced", "realestate_no121"], WORK["equity_incomplete"]
    # 12e non-vacuity: the insight fires on complete equity.
    assert WORK.get("related_party_complete"), WORK.get("related_party_complete")
    assert sorted(WORK["equity_complete"]) == ["g6_uncleared", "unanchored"], WORK["equity_complete"]
