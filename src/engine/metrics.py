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


def composite_score(real_margin_pct: float, sales: float, dio_days: int) -> float:
    """Ranking heuristic: (real_margin × sales) / max(DIO, 1).

    Combines profitability AND velocity. Used for SKU prioritization.
    """
    return (real_margin_pct * sales) / max(dio_days, 1)


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
