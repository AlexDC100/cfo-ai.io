"""Unit tests for the metrics module — written first per CLAUDE.md.

The math IS the product. Each formula has a known-input/known-output test
including the worked example from the brief.
"""

from __future__ import annotations

import math

import pytest

from engine.metrics import (
    absolute_profit,
    cash_conversion_cycle,
    composite_score,
    gmroii,
    net_real_margin,
    real_margin,
)


# ─────────── real_margin ───────────


def test_real_margin_brief_example() -> None:
    """CLAUDE.md worked example: 5% margin, 100 DIO, 6.5% CoC → 3.22%."""
    assert real_margin(5.0, 100, 6.5) == pytest.approx(3.219, abs=0.01)


def test_real_margin_zero_dio_equals_gross() -> None:
    assert real_margin(15.0, 0, 6.5) == pytest.approx(15.0)


def test_real_margin_high_dio_compresses_margin() -> None:
    """365 DIO at 6.5% CoC consumes the full 6.5% from gross margin."""
    assert real_margin(10.0, 365, 6.5) == pytest.approx(3.5, abs=0.001)


def test_real_margin_can_go_negative() -> None:
    assert real_margin(2.0, 365, 6.5) == pytest.approx(-4.5, abs=0.001)


def test_real_margin_macrou_calibration() -> None:
    """Macrou: 5.2% gross, 90 DIO, 6.5% CoC → 3.3% real margin (fixture)."""
    assert real_margin(5.2, 90, 6.5) == pytest.approx(3.6, abs=0.4)


def test_real_margin_calamar_calibration() -> None:
    """Calamar: -90.7% gross, 100 DIO, 6.5% CoC → -92.7% real margin (fixture)."""
    assert real_margin(-90.7, 100, 6.5) == pytest.approx(-92.48, abs=0.3)


# ─────────── absolute_profit ───────────


def test_absolute_profit_basic() -> None:
    """real_margin% × sales = absolute profit in same units as sales."""
    assert absolute_profit(10.0, 1000.0) == pytest.approx(100.0)


def test_absolute_profit_negative_margin() -> None:
    assert absolute_profit(-5.0, 1000.0) == pytest.approx(-50.0)


def test_absolute_profit_zero_sales() -> None:
    assert absolute_profit(20.0, 0.0) == 0.0


# ─────────── gmroii ───────────


def test_gmroii_basic() -> None:
    """100 GM × 4 turns / 200 inventory = 200% GMROII."""
    assert gmroii(gross_margin=100.0, inventory_turns=4.0, avg_inventory=200.0) == pytest.approx(
        200.0
    )


def test_gmroii_zero_inventory_returns_none() -> None:
    """Division by zero is undefined — return None, do not crash."""
    assert gmroii(gross_margin=100.0, inventory_turns=4.0, avg_inventory=0.0) is None


# ─────────── composite_score ───────────


def test_composite_score_basic() -> None:
    """(real_margin × sales) / DIO."""
    assert composite_score(real_margin_pct=10.0, sales=1000.0, dio_days=100) == pytest.approx(100.0)


def test_composite_score_dio_zero_uses_floor_of_one() -> None:
    """Avoid div-by-zero; per CLAUDE.md formula uses max(DIO, 1)."""
    assert composite_score(real_margin_pct=10.0, sales=1000.0, dio_days=0) == pytest.approx(
        10000.0
    )


# ─────────── ccc ───────────


def test_ccc_basic() -> None:
    assert cash_conversion_cycle(dio=90, dso=30, dpo=45) == 75


def test_ccc_can_be_negative() -> None:
    """Pay suppliers later than customers pay you = negative CCC, free working capital."""
    assert cash_conversion_cycle(dio=10, dso=10, dpo=60) == -40


# ─────────── property: real margin is monotone in DIO ───────────


# ─────────── net_real_margin (CCC-based) ───────────


def test_net_real_margin_muraturi_matches_excel() -> None:
    """MURATURI: 1.07% gross, CCC=55 → 0.09% (matches Excel WOCA stored value)."""
    assert net_real_margin(1.07, 55, 6.5) == pytest.approx(0.09, abs=0.02)


def test_net_real_margin_calamar_matches_excel() -> None:
    """Calamar: -90.72% gross, CCC=115 → -92.77% (Excel stored: -92.7%)."""
    assert net_real_margin(-90.72, 115, 6.5) == pytest.approx(-92.77, abs=0.05)


def test_net_real_margin_caras_below_warning_floor() -> None:
    """Caras: 4.99% gross, CCC=115 → 2.94% (CCC formula puts it below 3%).

    The Excel's stored value (3.00%) keeps Caras above the threshold; this is
    why production runs prefer the stored value over recomputing.
    """
    assert net_real_margin(4.99, 115, 6.5) == pytest.approx(2.94, abs=0.02)


def test_net_real_margin_more_severe_than_real_margin() -> None:
    """For positive CCC > DIO, net_real_margin is always lower than real_margin."""
    rm = real_margin(10.0, 100, 6.5)
    nrm = net_real_margin(10.0, 115, 6.5)  # CCC = DIO + 15
    assert nrm < rm


def test_real_margin_decreases_as_dio_grows() -> None:
    base = real_margin(10.0, 30, 6.5)
    longer = real_margin(10.0, 90, 6.5)
    longest = real_margin(10.0, 180, 6.5)
    assert base > longer > longest
    # And differences should be approximately linear in DIO
    diff_1 = base - longer
    diff_2 = longer - longest
    assert math.isclose(diff_1 * 1.5, diff_2, rel_tol=0.01)
