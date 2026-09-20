"""Pure formulas — the numerical core of the engine.

Each function maps directly to a formula in CLAUDE.md. No I/O, no DataFrames,
no logging — easy to unit-test, easy to reason about. Side-effect-free.
"""

from __future__ import annotations

from typing import Optional


def real_margin(gross_margin_pct: float, dio_days: int, cost_of_capital_pct: float) -> float:
    """Margin after inventory holding cost (DIO only — partial WOCA).

    real_margin% = gross_margin% - (DIO / 365) * cost_of_capital%

    Worked example (CLAUDE.md): 5% margin, 100 DIO, 6.5% CoC → 5 - (100/365)*6.5 ≈ 3.22%.

    NOTE: this formula deducts ONLY inventory holding cost. The legacy Excel
    `Analysis` sheet uses a fuller WOCA model that also accounts for receivables
    and payables (see `net_real_margin` for the CCC-based version). Prefer the
    stored Excel value over either formula when classifying production data.
    """
    return gross_margin_pct - (dio_days / 365.0) * cost_of_capital_pct


def net_real_margin(
    gross_margin_pct: float, ccc_days: int, cost_of_capital_pct: float
) -> float:
    """Margin after FULL working-capital cost (DIO + DSO − DPO).

    net_real_margin% = gross_margin% - (CCC / 365) * cost_of_capital%

    This is the "WOCA-corrected" margin. Receivables (DSO) cost capital while you
    wait to be paid; payables (DPO) free capital because suppliers finance you.
    For the legacy categories, CCC = DIO + 15 (DSO 45, DPO 30) so this trims
    ~0.27pp off `real_margin` per category.

    Worked example: 1.1% gross, CCC=55, 6.5% CoC → 1.1 - (55/365)*6.5 ≈ 0.12%.
    Matches Excel-stored MURATURI real margin of 0.12%.
    """
    return gross_margin_pct - (ccc_days / 365.0) * cost_of_capital_pct


def absolute_profit(real_margin_pct: float, sales: float) -> float:
    """Volume-adjusted profit. Sales unit determines output unit (RON or kRON)."""
    return (real_margin_pct / 100.0) * sales


def gmroii(
    gross_margin: float, inventory_turns: float, avg_inventory: float
) -> Optional[float]:
    """Gross Margin Return on Inventory Investment, expressed as a percentage.

    Returns None if inventory is zero (undefined, not zero).
    """
    if avg_inventory == 0:
        return None
    return (gross_margin * inventory_turns / avg_inventory) * 100.0


def composite_score(real_margin_pct: float, sales: float, dio_days: int) -> Optional[float]:
    """Ranking heuristic: (real_margin × sales) / DIO.

    Combines profitability AND velocity. Used for SKU prioritization.

    Returns None when DIO is not positive. The original spec
    (files/CLAUDE.md) floored the divisor at ``max(DIO, 1)``, which ranked
    a 0-day DIO exactly like a 1-day one and let a DIO of 0 manufactured
    upstream (the zero-volume weighted-DIO defect) rank by margin × sales
    alone. Owner ruling 2026-09-15: absent is never zero and never a floor —
    a velocity ratio over a non-positive day count is undefined, not 1.
    """
    if dio_days is None or dio_days <= 0:
        return None
    return (real_margin_pct * sales) / dio_days


def cash_conversion_cycle(dio: int, dso: int, dpo: int) -> int:
    """CCC = DIO + DSO - DPO. Negative means suppliers finance the working capital."""
    return dio + dso - dpo


# ─── CFO AI metrics ──────────────────────────────────────────────────────
# These are surfaced on the Cash and Profit pages and used by the
# recommendation generator to estimate expected impact.


def capital_trapped(
    avg_inventory_value: float,
    receivables: float = 0.0,
    payables: float = 0.0,
) -> float:
    """Capital tied up in the working-capital cycle.

    capital_trapped = average_inventory_value + receivables - payables

    Inventory and receivables consume cash; payables are supplier-financed
    working capital that offsets it. When DSO/DPO data is missing (categories
    today), pass receivables=payables=0 and the formula collapses to inventory
    only.
    """
    return avg_inventory_value + receivables - payables


def working_capital_cost(
    avg_working_capital: float,
    cost_of_capital_pct: float,
    period_days: int = 365,
) -> float:
    """Cost (in capital units) of holding working capital for the period.

    Used for the WOCA-corrected real margin when WOCA is supplied directly
    (rather than derived from DIO).
    """
    return avg_working_capital * (cost_of_capital_pct / 100.0) * (period_days / 365.0)


def real_margin_after_woca(
    gross_margin_value: float,
    avg_working_capital: float,
    cost_of_capital_pct: float,
    sales_value: float,
    period_days: int = 365,
) -> Optional[float]:
    """WOCA-aware real margin %.

        real_margin = (gross_margin - working_capital_cost) / sales

    Returns None if sales is zero. Prefer this when WOCA is known directly.
    """
    if sales_value == 0:
        return None
    wcc = working_capital_cost(avg_working_capital, cost_of_capital_pct, period_days)
    return (gross_margin_value - wcc) / sales_value * 100.0


def roic(
    operating_profit_after_wcc: float,
    invested_capital: float,
) -> Optional[float]:
    """Return on Invested Capital, expressed as a percentage.

    ROIC = operating_profit_after_working_capital_cost / invested_capital

    Returns None if invested_capital is zero.
    """
    if invested_capital == 0:
        return None
    return (operating_profit_after_wcc / invested_capital) * 100.0


def inventory_turns(cogs: float, avg_inventory: float) -> Optional[float]:
    """Inventory turnover (times per period).

    inventory_turns = COGS / average_inventory.

    Returns None if avg_inventory is zero.
    """
    if avg_inventory == 0:
        return None
    return cogs / avg_inventory


def cash_recovery_potential(decisions: list) -> float:
    """Sum of capital_freed_kron across SKUs flagged REDUCE or LIQUIDATE.

    Rough first pass: anything in those two buckets that has a freed-capital
    estimate. The product surface labels this "recoverable in 30–60 days
    based on today's rules" — recovery cadence is set per-tenant later.
    """
    total = 0.0
    for d in decisions:
        bucket = getattr(d, "bucket", None)
        if bucket in ("REDUCE", "LIQUIDATE"):
            freed = getattr(d, "capital_freed_kron", None)
            if freed is not None:
                total += freed
    return total


# ─── Portfolio aggregates (one authority for every summary surface) ─────
# actions.py (POST /run-daily + CLI), api/cfo_ai.py (/today, /profit,
# /exports/board-summary) and api/frontend.py (DailyRun) each used to
# rebuild these with their own divisor floor (`or 1.0`, `if d > 0 else
# 0.0`), serving 0.00 — or, for a NIV book that nets to zero, 20,000% —
# where the value is undefined. They now read these helpers, which return
# ``(value, refusal)``: exactly one of the two is None.

PORTFOLIO_REAL_MARGIN_UNDEFINED = "portfolio_real_margin_undefined"
PORTFOLIO_ROIC_UNDEFINED = "portfolio_roic_undefined"
ANCHOR_PROFIT_SHARE_UNDEFINED = "anchor_profit_share_undefined"


def _refusal(code: str, component: str, inputs: dict, text: str) -> dict:
    return {"code": code, "component": component, "inputs": inputs, "text": text}


def niv_weighted_margin(
    pairs: "list[tuple[float, float]]",
    component: str = "real_margin_pct",
    label: str = "Portfolio real margin",
) -> "tuple[Optional[float], Optional[dict]]":
    """NIV-weighted average of ``(margin_pct, niv_kron)`` pairs.

    A weighted average is defined only over non-negative weights with a
    positive total: then it is bounded by the smallest and largest margin
    in the book. A zero total has no average (it used to divide by a 1.0
    floor and serve 0.00 while every category said otherwise), and a
    negative weight makes the "average" unbounded (measured: category
    margins 29.3 and 9.3 over NIV +1000/-1000 served 20,000.00).
    """
    total = sum(niv for _, niv in pairs)
    negatives = [niv for _, niv in pairs if niv < 0]
    if negatives:
        return None, _refusal(
            PORTFOLIO_REAL_MARGIN_UNDEFINED, component,
            {"total_niv_kron": round(total, 2), "negative_niv_count": len(negatives)},
            f"{label} unavailable: {len(negatives)} categor"
            f"{'y carries' if len(negatives) == 1 else 'ies carry'} a negative NIV, "
            f"so a NIV-weighted average is not bounded by the category margins.",
        )
    if total <= 0:
        return None, _refusal(
            PORTFOLIO_REAL_MARGIN_UNDEFINED, component,
            {"total_niv_kron": round(total, 2)},
            f"{label} unavailable: total NIV is zero, so there is nothing to weight "
            f"the category margins by.",
        )
    return sum(m * niv for m, niv in pairs) / total, None


def portfolio_roic(
    total_abs_profit_kron: float,
    total_capital_trapped_kron: float,
    component: str = "roic_pct",
) -> "tuple[Optional[float], Optional[dict]]":
    """Portfolio ROIC % = absolute profit / capital trapped.

    Undefined — not 0.00 — when no capital is trapped: 300 kRON of profit on
    zero capital is not a 0% return.
    """
    if total_capital_trapped_kron <= 0:
        return None, _refusal(
            PORTFOLIO_ROIC_UNDEFINED, component,
            {"total_abs_profit_kron": round(total_abs_profit_kron, 2),
             "total_capital_trapped_kron": round(total_capital_trapped_kron, 2)},
            "Portfolio ROIC unavailable: capital trapped is zero, so there is no "
            "invested capital to return on.",
        )
    return total_abs_profit_kron / total_capital_trapped_kron * 100.0, None
