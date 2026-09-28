"""GATE turnover-denominator-engine — every ENGINE margin divides NET
TURNOVER (design A8, the engine half of `turnover-denominator`).

RULING (owner, 2026-09-26): 711 and 722 "stay OUT of cifra de afaceri —
margins and growth use net turnover (701–708 minus 709) as the
denominator, per the Romanian statutory P&L".

INCIDENT. Before the ruling the engine divided margins by
`total_operating_revenue` (turnover + 72x + other operating income) in the
briefing's citable ratios, the Section 9 benchmark, FactsGateway.revenue()
(which added a P&L-placed reconciliation delta) and the stored metric rows'
EBITDA margin — EEI's EBITDA margin read 78.0 % over turnover and a
different figure over its 4.89M of "operating revenue".

LAW. On every served book (four corpus books, four CONSTRUCTED books):
  · every served "revenue" in the engine IS turnover (70x − 709): the metric
    row, FactsGateway.revenue() (Capsule get_facts "revenue" and the
    Capsule's net-margin denominator), the valuation's revenue_used, the
    forecast's year-0 revenue, the methodology's revenue_net, the
    benchmark's turnover;
  · every served margin = its served numerator / turnover: the metric rows
    (EBITDA, operating, gross, net, core EBITDA), the ratio table's four
    margin rows, the Section 9 benchmark's EBITDA and net margins, the
    briefing's citable margins, the methodology's EBITDA and gross margins;
  · where the ONE margin rule refuses a book (the developer: turnover
    negligible against its operating activity), every DISPLAYED margin
    refuses it — the ratio table, the benchmark AND the briefing's citable
    ratios (which handed the model 339.34 % until this gate).

REDS ON (TC-11): a margin or growth divided by total operating revenue (or
anything other than turnover) on any served book; a "revenue" that is not
turnover; a displayed margin the one margin rule refuses elsewhere; a scope
with fewer than three books whose total operating revenue differs from
turnover (vacuous, TC-3).
CANNOT SEE: the numerators (one-ebitda-engine); the browser (the frontend
`turnover-denominator` gate); the company-years route's growth (its own
tests in test_company_years*).
"""
from __future__ import annotations

from typing import Any, Dict, List

import pytest

from _one_definition_served import SERVED_BOOKS, served

WORK: Dict[str, Any] = {"checks": 0, "books": [], "refused_by_rule": []}

#: Tolerances: the metric rows are stored to 4 places of a fraction, the
#: ratio table and the briefing to 2 places of a percent.
FRACTION_TOL = 0.00006
PERCENT_TOL = 0.0051


def _margin_rule_refuses(b) -> bool:
    from engine.ratios import margin_meaning as mm

    verdict, _inputs = mm.period_verdict(b.statements)
    return verdict.refused


def test_turnover_denominator_the_witnesses_exist(capsys):
    """Non-vacuity: a margin over total operating revenue would print a
    DIFFERENT number on these books (72x, other operating income)."""
    differing = []
    for name in SERVED_BOOKS:
        apl = served(name).apl
        t, tor = apl["turnover"], apl["total_operating_revenue"]
        if abs(tor - t) > max(1.0, 0.001 * abs(t)):
            differing.append("%s (turnover %.2f, total operating revenue %.2f)" % (name, t, tor))
    with capsys.disabled():
        print("\nSCOPE turnover-denominator-engine: %d served books; total operating revenue "
              "differs from net turnover on %d: %s"
              % (len(SERVED_BOOKS), len(differing), "; ".join(differing)))
    assert len(differing) >= 3, differing
    assert any(d.startswith("bridge_with_722 ") for d in differing), differing


@pytest.mark.parametrize("name", SERVED_BOOKS)
def test_turnover_denominator_every_engine_revenue_and_margin(name):
    from engine.api import pipeline as P

    b = served(name)
    apl = b.apl
    turnover = apl["turnover"]
    problems: List[str] = []

    def same(label: str, got: Any, want: float, tol: float) -> None:
        WORK["checks"] += 1
        if got is None or abs(float(got) - float(want)) > tol:
            problems.append("%s: %s = %r, expected %.6f over net turnover %.2f"
                            % (name, label, got, want, turnover))

    # 1. Every served "revenue" IS turnover.
    same("metric row 'revenue'", b.metrics.get("revenue"), turnover, 0.005)
    same("FactsGateway.revenue() (Capsule get_facts 'revenue')",
         b.gateway.revenue().amount_minor / 100.0, turnover, 0.005)
    same("valuation revenue_used", b.valuation.get("revenue_used"), turnover, 0.005)
    same("forecast PlHistory.revenue (year 0)",
         None if b.history.revenue is None else b.history.revenue / 100.0, turnover, 0.005)
    same("methodology totals.revenue_net",
         ((b.envelope.get("methodology") or {}).get("totals") or {}).get("revenue_net"),
         turnover, 0.005)
    same("benchmark company metrics turnover", b.bench.get("turnover"), turnover, 0.005)

    # 2. Every margin = its served numerator / turnover.
    numerators = {
        "ebitda_margin": apl["ebitda"],
        "operating_margin": apl["operating_result"],
        "gross_margin": apl["gross_profit"],
        "net_margin": apl["net_income_statutory"],
        "core_ebitda_margin": apl["core_ebitda"],
    }
    for key, num in numerators.items():
        same("metric row %r (fraction)" % key, b.metrics.get(key), num / turnover, FRACTION_TOL)

    meth = b.envelope.get("methodology") or {}
    mr, mt = meth.get("ratios") or {}, meth.get("totals") or {}

    def meth_ratio(key: str) -> Any:
        v = mr.get(key)
        return v.get("value") if isinstance(v, dict) else v

    same("methodology ratios.ebitda_margin_reported",
         meth_ratio("ebitda_margin_reported"), apl["ebitda"] / turnover, 0.000001)
    same("methodology ratios.gross_margin (its own gross profit over turnover)",
         meth_ratio("gross_margin"), (mt.get("gross_profit") or 0.0) / turnover, 0.000001)

    ratios, refusals = P._briefing_ratios(apl, b.statements.get("assembled_bs") or {}, None)
    rows = dict((r["key"], r) for r in (b.am.get("ratio_table") or {}).get("rows") or [])
    if _margin_rule_refuses(b):
        # The ONE margin rule refuses this book: every displayed margin
        # refuses it — the ratio table, the benchmark, the briefing.
        WORK["refused_by_rule"].append(name)
        for key in ("ebitda_margin", "operating_margin", "gross_margin", "net_margin"):
            WORK["checks"] += 1
            row = rows[key]
            if row.get("value") is not None or (row.get("reason") or {}).get("code") != "margin_not_meaningful":
                problems.append("%s: ratio table %s = %r / %r, the margin rule refuses it"
                                % (name, key, row.get("value"), row.get("reason")))
        for key in ("ebitda_margin", "net_margin"):
            WORK["checks"] += 1
            if b.bench.get(key) is not None or key not in (b.bench.get("refusals") or {}):
                problems.append("%s: benchmark %s = %r, the margin rule refuses it"
                                % (name, key, b.bench.get(key)))
        for key in ("ebitda_margin_pct", "net_margin_pct"):
            WORK["checks"] += 1
            if ratios.get(key) is not None or "not meaningful" not in (refusals.get(key) or ""):
                problems.append("%s: the briefing hands the model %s = %r (%r) — the margin "
                                "rule refuses it on every page" % (name, key, ratios.get(key),
                                                                  refusals.get(key)))
    else:
        for key in ("ebitda_margin", "operating_margin", "gross_margin", "net_margin"):
            same("ratio table %s (percent)" % key, rows[key].get("value"),
                 100.0 * numerators[key] / turnover, PERCENT_TOL)
        same("benchmark ebitda_margin (percent)", b.bench.get("ebitda_margin"),
             100.0 * apl["ebitda"] / turnover, 0.0001)
        same("benchmark net_margin (percent, account 121)", b.bench.get("net_margin"),
             100.0 * apl["net_income_statutory"] / turnover, 0.0001)
        same("briefing ebitda_margin_pct", ratios.get("ebitda_margin_pct"),
             100.0 * apl["ebitda"] / turnover, PERCENT_TOL)
        same("briefing net_margin_pct", ratios.get("net_margin_pct"),
             100.0 * apl["net_income_statutory"] / turnover, PERCENT_TOL)
    WORK["books"].append(name)
    assert not problems, "\n".join(problems)


def test_turnover_denominator_zz_work(capsys):
    with capsys.disabled():
        print("\nTURNOVER-DENOMINATOR-ENGINE books judged: %s; refused by the one margin rule "
              "on every displayed surface: %s"
              % (", ".join(WORK["books"]), ", ".join(WORK["refused_by_rule"]) or "none"))
        print("GATE-WORK turnover-denominator-engine units=%d" % WORK["checks"])
    assert len(WORK["books"]) == len(SERVED_BOOKS), WORK["books"]
    assert "realestate" in WORK["refused_by_rule"], WORK["refused_by_rule"]
