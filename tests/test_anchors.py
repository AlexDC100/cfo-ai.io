"""Tests for the anchor classifier.

Calibration cases come from VALIDATION_FIXTURE.md — the fixture data is the contract.
"""

from __future__ import annotations

from typing import List

import pytest

from engine.anchors import classify_anchors, is_anchor_alert
from engine.config import AnchorConfig
from engine.models import CategoryMetrics, MasterOverride


@pytest.fixture
def anchor_cfg() -> AnchorConfig:
    return AnchorConfig(
        top_pct_by_absolute_profit=20,
        min_revenue_share_pct=5.0,
        volume_threshold_tons_default=50,
        floor_real_margin_pct=-2.0,
        high_volume_anchor_floor_pct=5.0,
    )


def _cm(category: str, vol: float, niv: float, gm_pct: float, dio: int) -> CategoryMetrics:
    """Build a CategoryMetrics for tests; abs_profit derived inline."""
    real_margin_pct = gm_pct - (dio / 365.0) * 6.5
    abs_profit = real_margin_pct / 100.0 * niv
    return CategoryMetrics(
        category=category,
        business_unit=None,
        volume_tons=vol,
        niv_kron=niv,
        gm_pct=gm_pct,
        dio_days=dio,
        ccc_days=None,
        real_margin_pct=real_margin_pct,
        abs_profit_kron=abs_profit,
    )


# ─────────── classify_anchors (category level) ───────────


def test_top_5_categories_by_profit_are_anchors(anchor_cfg: AnchorConfig) -> None:
    """The top 5 by absolute profit must clear the 5% division-profit bar."""
    metrics: List[CategoryMetrics] = [
        _cm("Ton", 306.9, 10118.2, 14.2, 90),
        _cm("LEGUME CONSERVATE", 1383.9, 12915.9, 6.3, 60),
        _cm("Macrou file", 140.5, 4767.1, 10.8, 50),
        _cm("Macrou", 352.8, 7455.4, 5.2, 90),
        _cm("Sardina", 158.6, 3862.4, 9.0, 50),
        _cm("MURATURI", 185.4, 1401.0, 1.1, 40),  # high vol but tiny profit — NOT anchor
        _cm("SUC", 205.2, 881.7, 10.1, 30),  # high vol, but small abs profit
        _cm("Calamar", 0.2, 3.4, -90.7, 100),
    ]
    anchors = classify_anchors(metrics, anchor_cfg, period_months=10)
    assert anchors["Ton"] is True
    assert anchors["LEGUME CONSERVATE"] is True
    assert anchors["Macrou file"] is True
    assert anchors["Macrou"] is True
    assert anchors["Sardina"] is True


def test_high_volume_thin_margin_is_not_anchor(anchor_cfg: AnchorConfig) -> None:
    """MURATURI: 185t volume but only 1.7 kRON profit — NOT auto-anchored.

    This is the most important negative case. Volume alone must not promote.
    """
    metrics: List[CategoryMetrics] = [
        _cm("Ton", 306.9, 10118.2, 14.2, 90),
        _cm("MURATURI", 185.4, 1401.0, 1.1, 40),
    ]
    anchors = classify_anchors(metrics, anchor_cfg, period_months=10)
    assert anchors["MURATURI"] is False


def test_strategic_flag_forces_anchor(anchor_cfg: AnchorConfig) -> None:
    metrics: List[CategoryMetrics] = [
        _cm("Tiny", 0.5, 10.0, 5.0, 30),  # would not qualify on metrics alone
    ]
    overrides = {"Tiny": MasterOverride(sku_id="Tiny", strategic_flag=True)}
    anchors = classify_anchors(metrics, anchor_cfg, period_months=10, overrides=overrides)
    assert anchors["Tiny"] is True


def test_strategic_flag_false_no_effect(anchor_cfg: AnchorConfig) -> None:
    """MURATURI explicitly NOT strategic per Alex — flag must default false.

    Tested in realistic context (alongside dominant categories) so the
    profit-share denominator reflects the full division, not just MURATURI itself.
    """
    metrics: List[CategoryMetrics] = [
        _cm("Ton", 306.9, 10118.2, 14.2, 90),
        _cm("LEGUME CONSERVATE", 1383.9, 12915.9, 6.3, 60),
        _cm("MURATURI", 185.4, 1401.0, 1.1, 40),
    ]
    anchors = classify_anchors(metrics, anchor_cfg, period_months=10, overrides={})
    assert anchors["MURATURI"] is False


def test_volume_rule_uses_monthly_throughput(anchor_cfg: AnchorConfig) -> None:
    """A category at >50 t/month must be flagged anchor by the volume rule."""
    # 600t over 10 months = 60 t/month, > 50 t/month → anchor
    high_vol = _cm("Bulk", 600, 100.0, 1.0, 30)  # tiny abs_profit, but high monthly volume
    metrics: List[CategoryMetrics] = [
        _cm("Ton", 306.9, 10118.2, 14.2, 90),  # dominates total profit
        high_vol,
    ]
    anchors = classify_anchors(metrics, anchor_cfg, period_months=10)
    assert anchors["Bulk"] is True


# ─────────── is_anchor_alert ───────────


def test_macrou_high_volume_anchor_alert(anchor_cfg: AnchorConfig) -> None:
    """Macrou: 353t (high volume) but real margin 3.3% (< 5% floor) → ALERT."""
    macrou = _cm("Macrou", 352.8, 7455.4, 5.2, 90)
    assert macrou.real_margin_pct < 5.0
    fires, reason = is_anchor_alert(macrou, anchor_cfg)
    assert fires is True
    assert reason == "high_volume_anchor_below_floor"


def test_anchor_above_floor_no_alert(anchor_cfg: AnchorConfig) -> None:
    """Ton: real margin 12.4% — no alert."""
    ton = _cm("Ton", 306.9, 10118.2, 14.2, 90)
    fires, _ = is_anchor_alert(ton, anchor_cfg)
    assert fires is False


def test_anchor_below_absolute_floor_alert(anchor_cfg: AnchorConfig) -> None:
    """Anchor with real margin < -2% triggers absolute-floor alert."""
    bleeder = _cm("Bleeder", 100, 1000, -10.0, 60)
    fires, reason = is_anchor_alert(bleeder, anchor_cfg)
    assert fires is True
    assert reason == "absolute_floor_breach"


def test_low_volume_anchor_thin_margin_no_high_volume_alert(anchor_cfg: AnchorConfig) -> None:
    """A small anchor with thin margin must not trigger the HIGH-volume alert."""
    # vol=10t < 50t threshold → high-volume alert does not fire even if margin < 5%
    small = _cm("Small", 10, 200, 4.0, 30)
    fires, _ = is_anchor_alert(small, anchor_cfg)
    assert fires is False
