"""Anchor classifier — runs FIRST in the decision pipeline.

An anchor is a category (or SKU) that the engine must NEVER auto-eliminate.
Anchor decisions follow ANCHOR / ANCHOR_ALERT / ANCHOR_REVIEW paths instead.

CLAUDE.md anchor criteria for a category (any one is sufficient):
  1. Profit share > min_revenue_share_pct of total absolute profit
  2. Monthly volume > volume_threshold_tons_default AND real_margin > 0
  3. strategic_flag = True (manual override)

Note on volume units:
  - The ANCHOR rule uses MONTHLY throughput (volume_tons / period_months).
    Otherwise high-volume but thin-margin categories like SUC/MURATURI/PET FOOD
    would be auto-anchored, which contradicts the calibrated fixture.
  - The ANCHOR_ALERT high-volume floor uses TOTAL volume (period-as-loaded).
    Macrou (352.8t YTD, 35t/month) clears the alert floor (50t total) but does
    NOT clear the anchor volume rule (50 t/month) — the asymmetry is intentional.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from .config import AnchorConfig
from .models import CategoryMetrics, MasterOverride


def classify_anchors(
    metrics: List[CategoryMetrics],
    cfg: AnchorConfig,
    period_months: int = 1,
    overrides: Optional[Dict[str, MasterOverride]] = None,
) -> Dict[str, bool]:
    """Return {category_name: is_anchor}.

    Mutates each `CategoryMetrics.profit_share_pct` so downstream code can read it.
    """
    overrides = overrides or {}
    total_abs_profit = sum(m.abs_profit_kron for m in metrics)
    total_niv = sum(m.niv_kron for m in metrics)

    out: Dict[str, bool] = {}
    for m in metrics:
        # Compute shares (mutating the model in-place; intentional for downstream use)
        m.profit_share_pct = (
            (m.abs_profit_kron / total_abs_profit * 100.0) if total_abs_profit else 0.0
        )
        m.revenue_share_pct = (m.niv_kron / total_niv * 100.0) if total_niv else 0.0

        out[m.category] = _is_category_anchor(m, cfg, period_months, overrides)
    return out


def _is_category_anchor(
    m: CategoryMetrics,
    cfg: AnchorConfig,
    period_months: int,
    overrides: Dict[str, MasterOverride],
) -> bool:
    # 3. Manual override wins
    ov = overrides.get(m.category)
    if ov and ov.strategic_flag:
        return True

    # 1. Profit-share rule — the dominant rule in practice
    if m.profit_share_pct >= cfg.min_revenue_share_pct:
        return True

    # 2. Volume + positive real margin (monthly throughput)
    monthly_vol = m.volume_tons / max(period_months, 1)
    if (
        monthly_vol > cfg.volume_threshold_tons_default
        and m.real_margin_pct > 0
    ):
        return True

    return False


def is_anchor_alert(
    m: CategoryMetrics,
    cfg: AnchorConfig,
) -> Tuple[bool, Optional[str]]:
    """Decide whether an anchor needs an alert (and why).

    Returns (fires, reason) — reason is None when no alert.
    Alert reasons checked in order of severity.
    """
    # Absolute floor: losing real money beats any other concern
    if m.real_margin_pct < cfg.floor_real_margin_pct:
        return True, "absolute_floor_breach"

    # High-volume anchor below margin floor (the Macrou case)
    if (
        m.real_margin_pct < cfg.high_volume_anchor_floor_pct
        and m.volume_tons > cfg.volume_threshold_tons_default
    ):
        return True, "high_volume_anchor_below_floor"

    return False, None
