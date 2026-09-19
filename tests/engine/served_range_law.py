"""THE SERVED-RANGE LAW — one row per credit score, stated here and nowhere
else in the gate (ruling R-RANGE, 2026-09-15; owner 2026-09-18: range gate
absolute).

INDEPENDENT BY CONSTRUCTION. This file imports NOTHING from the product:
not `credit_model`, not `credit_pack`, not the pack file. Two checks that
share code agree by construction; the product's own `score_out_of_range`
would pass its own bug. Every bound below is a literal with its source,
every domain predicate reads OPERANDS FROM THE SAME SERVED BODY the score
came from (the statements' leaves), and every row names the refusal code
the surface must carry when the score is absent inside its domain.

The Altman materiality share (1%) is copied here as a literal ON PURPOSE:
the gate must red if the product's pack moves it without this law moving
too — that is a ruling change, not a refactor.
"""
from __future__ import annotations

import math
from typing import Any, Callable, Dict, List, Mapping, Optional

#: The share of total assets total liabilities must reach for X4 to be
#: defined (R-D4; CLAUDE.md §3 Step 5 Gate 2 balance-sheet materiality).
X4_MATERIALITY_SHARE = 0.01

_CL = ("accountsPayable", "shortTermDebt", "otherCurrentLiabilities")
_NCL = ("longTermDebt", "otherNonCurrentLiabilities")
_TA = ("cash", "accountsReceivable", "inventory", "otherCurrentAssets",
       "propertyPlantEquipment", "intangibles", "otherNonCurrentAssets")
_EQ = ("shareCapital", "retainedEarnings", "otherEquity")


def _f(v: Any) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0


def operands(statements: Mapping[str, Any]) -> Dict[str, Any]:
    """The operands every domain predicate reads, from the served
    statements' LEAVES (never from a served total or a served ratio)."""
    bs = statements.get("balanceSheet") or {}
    pl = statements.get("incomeStatement") or {}
    cl = sum(_f(bs.get(k)) for k in _CL)
    tl = cl + sum(_f(bs.get(k)) for k in _NCL)
    ta = sum(_f(bs.get(k)) for k in _TA)
    eq = sum(_f(bs.get(k)) for k in _EQ)
    debt = _f(bs.get("shortTermDebt")) + _f(bs.get("longTermDebt"))
    revenue = _f(pl.get("revenue"))
    ebit = (revenue - _f(pl.get("costOfGoodsSold")) - _f(pl.get("operatingExpenses"))
            - _f(pl.get("depreciationAmortization")) + _f(pl.get("otherIncome")))
    interest = _f(pl.get("interestExpense"))
    return {
        "total_assets": ta, "current_liabilities": cl, "total_liabilities": tl,
        "total_equity": eq, "total_debt": debt, "net_debt": debt - _f(bs.get("cash")),
        "revenue": revenue, "ebit": ebit, "ebitda": ebit + _f(pl.get("depreciationAmortization")),
        "interest": interest, "invested_capital": debt + eq,
        "current_assets": sum(_f(bs.get(k)) for k in _TA[:4]),
        "cash": _f(bs.get("cash")), "inventory": _f(bs.get("inventory")),
        # the two unbounded Altman terms, from the leaves, for the Z'' bound
        "x2": (_f(bs.get("retainedEarnings")) / ta) if ta > 0 else None,
        "x3": (ebit / ta) if ta > 0 else None,
    }


# ── domain predicates: True when the score MUST be served ────────────────────

def _model_runs(o: Mapping[str, Any]) -> bool:
    return o["total_assets"] > 0


def _altman_defined(o: Mapping[str, Any]) -> bool:
    return _model_runs(o) and o["total_liabilities"] > 0 and \
        o["total_liabilities"] >= X4_MATERIALITY_SHARE * o["total_assets"]


def _liquidity_defined(o: Mapping[str, Any]) -> bool:
    if not (_model_runs(o) and o["current_liabilities"] > 0):
        return False
    cl = o["current_liabilities"]
    return all(t >= 0 for t in (o["current_assets"] / cl, (o["current_assets"] - o["inventory"]) / cl,
                                o["cash"] / cl))


def _profitability_defined(o: Mapping[str, Any]) -> bool:
    return _model_runs(o) and o["revenue"] > 0


def _d1_rung(o: Mapping[str, Any]) -> bool:
    return o["total_debt"] == 0 and o["interest"] == 0 and o["ebit"] > 0


def _coverage_defined(o: Mapping[str, Any]) -> bool:
    return _model_runs(o) and (o["interest"] > 0 or _d1_rung(o))


def _composite_defined(o: Mapping[str, Any]) -> bool:
    return all(p(o) for p in (_altman_defined, _liquidity_defined, _profitability_defined,
                              _coverage_defined))


def _roic_defined(o: Mapping[str, Any]) -> bool:
    return o["invested_capital"] > 0


#: Altman Z'' coefficients (Appendix A section 7), copied here on purpose.
_Z_COEF = (6.56, 3.26, 6.72, 1.05)


def z_bound(o: Mapping[str, Any]) -> Optional[float]:
    """The Z'' upper bound DERIVED from the component bounds with this book's
    own X2 and X3: 6.56 x 1 + 3.26 x X2 + 6.72 x X3 + 1.05 x (1 / share).
    None when X2 / X3 are not defined (total assets not positive)."""
    x2, x3 = o.get("x2"), o.get("x3")
    if x2 is None or x3 is None or not (math.isfinite(x2) and math.isfinite(x3)):
        return None
    a, b, c, d = _Z_COEF
    return a * 1.0 + b * x2 + c * x3 + d * (1.0 / X4_MATERIALITY_SHARE)


# ── the law ──────────────────────────────────────────────────────────────────

class Row:
    """One score: where it is served, its bound, its domain, its source and
    the refusal code the surface must carry when it is absent in-domain."""

    def __init__(self, key: str, path: str, lo: Optional[float], hi: Optional[float],
                 domain: Callable[[Mapping[str, Any]], bool], source: str,
                 refusal_codes: List[str], integer: bool = False,
                 hi_of: Optional[Callable[[Mapping[str, Any]], Optional[float]]] = None) -> None:
        self.key, self.path, self.lo, self.hi = key, path, lo, hi
        self.domain, self.source, self.refusal_codes, self.integer = domain, source, refusal_codes, integer
        self.hi_of = hi_of

    def in_range(self, v: Any, o: Mapping[str, Any]) -> bool:
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            return False
        if self.integer and float(v) != int(v):
            return False
        hi = self.hi_of(o) if self.hi_of else self.hi
        return (self.lo is None or v >= self.lo) and (hi is None or v <= hi)

    def bound_text(self, o: Mapping[str, Any]) -> str:
        hi = self.hi_of(o) if self.hi_of else self.hi
        return "[%s, %s]" % ("-inf" if self.lo is None else self.lo, "+inf" if hi is None else hi)


#: The refusal codes a credit component may carry (the composer's vocabulary
#: as this law reads it; a code outside it is a defect).
COMPONENT_CODES = ["current_liabilities_not_positive", "total_liabilities_below_materiality",
                   "revenue_not_positive", "interest_expense_not_positive", "credit_out_of_range"]
COMPOSITE_CODES = ["credit_component_undefined", "credit_out_of_range", "credit_inputs_absent"]

SUBSCORE_SOURCE = "CLAUDE.md Appendix A §7: seven sub-scores on a 0-100 scale"
COMPOSITE_SOURCE = "CLAUDE.md Appendix A §7: composite 0-100, weights sum to 1"

#: `path` is dotted from a served CreditBlock (ratio_table.credit).
LAW: List[Row] = [
    Row("credit_composite", "composite", 0, 100, _composite_defined, COMPOSITE_SOURCE, COMPOSITE_CODES),
    Row("credit_subscore_altman", "subscores.altman", 0, 100, _altman_defined, SUBSCORE_SOURCE, COMPONENT_CODES),
    Row("credit_subscore_profitability", "subscores.profitability", 0, 100, _profitability_defined,
        SUBSCORE_SOURCE, COMPONENT_CODES),
    Row("credit_subscore_leverage", "subscores.leverage", 0, 100, _model_runs, SUBSCORE_SOURCE, COMPONENT_CODES),
    Row("credit_subscore_coverage", "subscores.coverage", 0, 100, _coverage_defined, SUBSCORE_SOURCE,
        COMPONENT_CODES),
    Row("credit_subscore_dscr", "subscores.dscr", 0, 100, _coverage_defined, SUBSCORE_SOURCE, COMPONENT_CODES),
    Row("credit_subscore_liquidity", "subscores.liquidity", 0, 100, _liquidity_defined, SUBSCORE_SOURCE,
        COMPONENT_CODES),
    Row("credit_subscore_equity", "subscores.equity", 0, 100, _model_runs, SUBSCORE_SOURCE, COMPONENT_CODES),
    Row("altman_x1", "altman.x1", None, 1, _model_runs,
        "structural: current assets are part of total assets, leaves non-negative", COMPONENT_CODES),
    Row("altman_x4", "altman.x4", None, 1 / X4_MATERIALITY_SHARE, _altman_defined,
        "derived: TL >= share x TA and BE <= TA, so BE / TL <= 1 / share", COMPONENT_CODES),
    Row("altman_z_score", "altman.z", None, None, _altman_defined,
        "finite and <= the bound derived from the component bounds with the book's own X2 and X3 "
        "(6.56 x 1 + 3.26 x X2 + 6.72 x X3 + 1.05 / share); 1.10 / 2.60 are zone thresholds, not a range",
        COMPONENT_CODES, hi_of=z_bound),
]

#: Non-credit rows the same law holds on the served ratio table.
RATIO_LAW = [
    ("roic", _roic_defined, "defined only for invested capital (debt + equity) > 0",
     ["zero_denominator", "nonpositive_denominator", "operand_absent", "engine_metric_absent"]),
]

PIOTROSKI_RANGE = (0, 9)
LETTERS = ("AAA", "AA", "A", "BBB", "BB", "B", "CCC", "CC")


def read_path(block: Mapping[str, Any], path: str) -> Any:
    cur: Any = block
    for part in path.split("."):
        if not isinstance(cur, Mapping):
            return None
        cur = cur.get(part)
    return cur


def component_of(key: str) -> Optional[str]:
    if key.startswith("credit_subscore_"):
        return key[len("credit_subscore_"):]
    if key.startswith("altman_"):
        return "altman"
    return None
