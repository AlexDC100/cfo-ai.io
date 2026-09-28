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

THE ONE EBITDA (owner ruling 2026-09-26). EBIT and EBITDA are read as the
served body STATES them: the assembled P&L's `operating_result` / `ebitda`
(net 711 and net 72x inside), and ABSENT when it serves `ebitda_refusal` —
then Altman (X3), coverage, DSCR and, with net debt, leverage are OUT of
their domain and must refuse. Until the ruling this law rebuilt EBIT from
the incomeStatement leaves WITHOUT 711 / 72x — a second definition. A block
assembled before the ruling (no `ebitda_definition`) is read from the
leaves plus 72x, and absent where the book posts to 711.
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
    ebit, ebitda = _one_ebit_ebitda(statements)
    interest = _f(pl.get("interestExpense"))
    return {
        "total_assets": ta, "current_liabilities": cl, "total_liabilities": tl,
        "total_equity": eq, "total_debt": debt, "net_debt": debt - _f(bs.get("cash")),
        "revenue": revenue, "ebit": ebit, "ebitda": ebitda,
        "interest": interest, "invested_capital": debt + eq,
        "current_assets": sum(_f(bs.get(k)) for k in _TA[:4]),
        "cash": _f(bs.get("cash")), "inventory": _f(bs.get("inventory")),
        # the two unbounded Altman terms, from the leaves, for the Z'' bound
        "x2": (_f(bs.get("retainedEarnings")) / ta) if ta > 0 else None,
        "x3": (ebit / ta) if ta > 0 and ebit is not None else None,
    }


def _one_ebit_ebitda(statements: Mapping[str, Any]):
    """(EBIT, EBITDA) as the served body states them — None, None when the
    served one-EBITDA is refused (never a figure rebuilt without 711)."""
    apl = statements.get("assembled_pl") or {}
    pl = statements.get("incomeStatement") or {}
    if "ebitda_definition" in apl:
        if apl.get("ebitda_refusal") or apl.get("ebitda") is None:
            return None, None
        return _f(apl.get("operating_result")), _f(apl.get("ebitda"))
    if abs(_f(pl.get("inventoryVariationMemo"))) >= 0.005:
        return None, None
    ebitda = (_f(pl.get("revenue")) - _f(pl.get("costOfGoodsSold")) - _f(pl.get("operatingExpenses"))
              + _f(pl.get("otherIncome")) + _f(pl.get("capitalizedOwnWork")))
    return ebitda - _f(pl.get("depreciationAmortization")), ebitda


# ── domain predicates: True when the score MUST be served ────────────────────

def _model_runs(o: Mapping[str, Any]) -> bool:
    return o["total_assets"] > 0


def _altman_defined(o: Mapping[str, Any]) -> bool:
    return _model_runs(o) and o["total_liabilities"] > 0 and o["ebit"] is not None and \
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
    return o["total_debt"] == 0 and o["interest"] == 0 and o["ebit"] is not None and o["ebit"] > 0


def _coverage_defined(o: Mapping[str, Any]) -> bool:
    return _model_runs(o) and o["ebit"] is not None and o["ebitda"] is not None and \
        (o["interest"] > 0 or _d1_rung(o))


def _leverage_defined(o: Mapping[str, Any]) -> bool:
    # net cash scores whatever EBITDA is; net debt needs the one EBITDA
    return _model_runs(o) and (o["ebitda"] is not None or o["net_debt"] <= 0)


def _composite_defined(o: Mapping[str, Any]) -> bool:
    return all(p(o) for p in (_altman_defined, _liquidity_defined, _profitability_defined,
                              _coverage_defined, _leverage_defined))


def _roic_defined(o: Mapping[str, Any]) -> bool:
    return o["invested_capital"] > 0 and o["ebit"] is not None


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
                   "revenue_not_positive", "interest_expense_not_positive", "credit_out_of_range",
                   "ebitda_refused"]
COMPOSITE_CODES = ["credit_component_undefined", "credit_out_of_range", "credit_inputs_absent"]

SUBSCORE_SOURCE = "CLAUDE.md Appendix A §7: seven sub-scores on a 0-100 scale"
COMPOSITE_SOURCE = "CLAUDE.md Appendix A §7: composite 0-100, weights sum to 1"

#: `path` is dotted from a served CreditBlock (ratio_table.credit).
LAW: List[Row] = [
    Row("credit_composite", "composite", 0, 100, _composite_defined, COMPOSITE_SOURCE, COMPOSITE_CODES),
    Row("credit_subscore_altman", "subscores.altman", 0, 100, _altman_defined, SUBSCORE_SOURCE, COMPONENT_CODES),
    Row("credit_subscore_profitability", "subscores.profitability", 0, 100, _profitability_defined,
        SUBSCORE_SOURCE, COMPONENT_CODES),
    Row("credit_subscore_leverage", "subscores.leverage", 0, 100, _leverage_defined, SUBSCORE_SOURCE,
        COMPONENT_CODES),
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

#: THE AS-FILED EVIDENCE (`credit.as_filed`, served only when the persisted
#: figures differ from the served ones). A filed figure is held to the SAME
#: bound as its served twin: it is either inside it, or WITHDRAWN — null on
#: `as_filed`, named in `as_filed.withdrawn` with the value it was filed
#: at. A withdrawn Z'' lies OUTSIDE its bound; a withdrawn composite lies
#: outside its bound OR was composed over a withdrawn Z'' (an in-range 88.5
#: built on X4 1500 is not a score). A withdrawal of any other in-range
#: figure is as much a defect as a reprint of an exploded one. A filed
#: letter exists only beside a filed composite.
AS_FILED_LAW: List[Row] = [
    Row("credit_composite", "as_filed.composite", 0, 100, lambda o: True, COMPOSITE_SOURCE, []),
    Row("altman_z_score", "as_filed.altman_z", None, None, lambda o: True,
        "finite and <= the bound derived with the book's own X2 and X3 (as the served Z'')", [],
        hi_of=z_bound),
]

#: THE UNSWITCHED PATH (`assembled_metrics.credit` with `basis: as_filed`,
#: served when the serve-time model cannot run or the ratio table fails):
#: the PERSISTED rows are what the reader sees, in the envelope AND in the
#: `metrics[]` rows the FE reads first. The same rows of `LAW` apply, read
#: at the envelope's own paths: a figure is either absent, or inside its
#: domain AND inside its bound. There is no third state - a persisted
#: figure is not exempt from the range because nothing recomputed it.
ENVELOPE_PATHS: Dict[str, str] = {
    "credit_composite": "composite_score",
    "credit_subscore_altman": "subscores.altman",
    "credit_subscore_profitability": "subscores.profitability",
    "credit_subscore_leverage": "subscores.leverage",
    "credit_subscore_coverage": "subscores.coverage",
    "credit_subscore_dscr": "subscores.dscr",
    "credit_subscore_liquidity": "subscores.liquidity",
    "credit_subscore_equity": "subscores.equity",
    "altman_x1": "altman_components.x1",
    "altman_x4": "altman_components.x4",
    "altman_z_score": "altman_z_score",
}


def persisted_figure_may_be_served(row: "Row", v: Any, o: Mapping[str, Any]) -> bool:
    """A persisted figure on the unswitched path: absent, or in its domain
    and inside its bound."""
    return v is None or (row.domain(o) and row.in_range(v, o))


#: Non-credit rows the same law holds on the served ratio table.
RATIO_LAW = [
    ("roic", _roic_defined, "defined only for invested capital (debt + equity) > 0 and a served EBIT",
     ["zero_denominator", "nonpositive_denominator", "operand_absent", "engine_metric_absent",
      "ebitda_refused"]),
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


# ── EVERY SURFACE OF A BODY (owner, 2026-09-20: the range gate sits at the
# serving boundary, so the law is read off WHATEVER left the engine) ─────────
#
# `served_figures(body)` lists every place a period body or a comparatives
# body carries a `LAW` figure, as `(surface, key, value)`. It reads the body
# only - never the product - and it SKIPS the disclosure records
# (`withdrawn`, `withheld`), which name a figure that is NOT served. The
# same rows of `LAW` then hold on every entry, on the switched path, the
# unswitched path, every model-failure path and the comparatives prior.

#: comparatives composite key -> the LAW key it carries
COMPARE_KEYS: Dict[str, str] = {"altman_z": "altman_z_score", "credit_composite": "credit_composite",
                                "letter_grade": "credit_composite"}


def _block_figures(surface: str, block: Any) -> List[Any]:
    if not isinstance(block, Mapping):
        return []
    return [(surface, row.key, read_path(block, row.path)) for row in LAW]


def _row_figures(surface: str, rows: Any) -> List[Any]:
    keys = {row.key for row in LAW}
    return [(surface, r["name"], r.get("value")) for r in rows or []
            if isinstance(r, Mapping) and r.get("name") in keys]


def served_figures(body: Mapping[str, Any]) -> List[Any]:
    """`[(surface, LAW key, value)]` for every credit figure a served period
    body or comparatives body carries as a figure."""
    out: List[Any] = []
    am = body.get("assembled_metrics") if isinstance(body.get("assembled_metrics"), Mapping) else {}
    env = am.get("credit")
    if isinstance(env, Mapping):
        out += [("assembled_metrics.credit", k, read_path(env, p)) for k, p in ENVELOPE_PATHS.items()]
    out += _block_figures("assembled_metrics.ratio_table.credit", (am.get("ratio_table") or {}).get("credit"))
    out += _row_figures("metrics[]", body.get("metrics"))
    out += _row_figures("credit_metrics_as_filed[]", body.get("credit_metrics_as_filed"))
    out += _row_figures("prior_metrics[]", body.get("prior_metrics"))
    ratios = body.get("ratios") if isinstance(body.get("ratios"), Mapping) else {}
    for which in ("current", "prior"):
        out += _block_figures("ratios.credit.%s" % which, (ratios.get("credit") or {}).get(which))
    for group in ("composites", "subscores"):
        for r in ratios.get(group) or []:
            key = COMPARE_KEYS.get(r.get("key"), r.get("key"))
            for which in ("current", "prior"):
                side = r.get(which) or {}
                out.append(("ratios.%s.%s.%s" % (group, r.get("key"), which), key, side.get("value")))
                if r.get("key") == "altman_z":
                    for op in side.get("operands") or []:
                        if op.get("name") in ("x1", "x4"):
                            out.append(("ratios.composites.altman_z.%s.operands" % which,
                                        "altman_%s" % op["name"], op.get("value")))
    return out


def side_of(surface: str) -> str:
    """Which period's statements a surface's figures are read against."""
    return "prior" if (".prior" in surface or surface.startswith("prior_")) else "current"


def zones_and_letters(body: Mapping[str, Any]) -> List[Any]:
    """`[(surface, the figure it rests on, the zone or letter)]`: a zone is
    minted only beside a served Z'', a letter only beside a served
    composite - on every surface."""
    out: List[Any] = []
    am = body.get("assembled_metrics") if isinstance(body.get("assembled_metrics"), Mapping) else {}
    env = am.get("credit")
    if isinstance(env, Mapping):
        out.append(("assembled_metrics.credit.zone", env.get("altman_z_score"), env.get("altman_zone")))
        out.append(("assembled_metrics.credit.letter", env.get("composite_score"), env.get("letter_grade")))
    ratios = body.get("ratios") if isinstance(body.get("ratios"), Mapping) else {}
    blocks = [("assembled_metrics.ratio_table.credit", (am.get("ratio_table") or {}).get("credit"))]
    blocks += [("ratios.credit.%s" % w, (ratios.get("credit") or {}).get(w)) for w in ("current", "prior")]
    for surface, block in blocks:
        if isinstance(block, Mapping):
            out.append((surface + ".zone", read_path(block, "altman.z"), read_path(block, "altman.zone")))
            out.append((surface + ".letter", block.get("composite"), block.get("letter")))
    for r in ratios.get("composites") or []:
        for which in ("current", "prior"):
            side = r.get(which) or {}
            if r.get("key") in ("altman_z", "letter_grade"):
                out.append(("ratios.composites.%s.%s.band" % (r["key"], which), side.get("value"), side.get("band")))
    return out
