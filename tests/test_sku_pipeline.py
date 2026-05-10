"""Tests for the SKU-level drill pipeline."""

from __future__ import annotations

from pathlib import Path

import pytest

from engine.config import load_config
from engine.loader import load_categories_from_excel, load_skus_from_excel
from engine.sku_pipeline import drill_category

REPO_ROOT = Path(__file__).resolve().parent.parent
EXCEL_PATH = REPO_ROOT / "files" / "Trading_analysis_YTDOct'25_LV.xlsx"
CONFIG = REPO_ROOT / "config.yaml"


@pytest.fixture
def loaded():
    cfg = load_config(CONFIG)
    cats = load_categories_from_excel(EXCEL_PATH)
    skus = load_skus_from_excel(EXCEL_PATH)
    return cfg, cats, skus


@pytest.mark.skipif(not EXCEL_PATH.exists(), reason="Excel workbook not shipped")
def test_drill_calamar_returns_at_least_one_sku(loaded) -> None:
    cfg, cats, skus = loaded
    metrics, decisions = drill_category("Calamar", skus, cats, cfg, period_months=10)
    assert len(decisions) >= 1
    # Calamar's only SKU has -88.7% gross margin → must be ELIMINATE for negative real margin
    assert decisions[0].flag == "ELIMINATE"
    assert decisions[0].reason == "real_margin_negative"


@pytest.mark.skipif(not EXCEL_PATH.exists(), reason="Excel workbook not shipped")
def test_drill_unknown_category_returns_empty(loaded) -> None:
    cfg, cats, skus = loaded
    _, decisions = drill_category("DoesNotExist", skus, cats, cfg, period_months=10)
    assert decisions == []


@pytest.mark.skipif(not EXCEL_PATH.exists(), reason="Excel workbook not shipped")
def test_drill_legume_finds_sku_anchor_alert(loaded) -> None:
    """LEGUME has a Macrou-style SKU: high volume, thin real margin → SKU-level alert."""
    cfg, cats, skus = loaded
    _, decisions = drill_category("LEGUME CONSERVATE", skus, cats, cfg, period_months=10)
    alerts = [d for d in decisions if d.flag == "ANCHOR_ALERT"]
    assert len(alerts) >= 1, "Expected at least one SKU-level ANCHOR_ALERT in LEGUME"


@pytest.mark.skipif(not EXCEL_PATH.exists(), reason="Excel workbook not shipped")
def test_drill_inherits_dio_from_parent_category(loaded) -> None:
    """Every drilled SKU's DIO must equal its parent category's DIO (inheritance)."""
    cfg, cats, skus = loaded
    metrics, _ = drill_category("Macrou", skus, cats, cfg, period_months=10)
    parent_dio = next(c.dio_days for c in cats if c.category == "Macrou")
    for m in metrics:
        assert m.dio_days == parent_dio
        assert m.dio_source == "category_inherited"


@pytest.mark.skipif(not EXCEL_PATH.exists(), reason="Excel workbook not shipped")
def test_drill_decisions_sorted_by_abs_profit_desc(loaded) -> None:
    cfg, cats, skus = loaded
    _, decisions = drill_category("Ton", skus, cats, cfg, period_months=10)
    assert len(decisions) >= 2
    profits = [d.abs_profit_kron for d in decisions]
    assert profits == sorted(profits, reverse=True)
