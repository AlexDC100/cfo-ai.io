"""Helpers shared by the frontend router. Kept separate so the router
file stays focused on HTTP concerns and these can be unit-tested.
"""

from __future__ import annotations

from typing import Any, Dict, List

from ..config import Config
from ..models import CategoryRow, SkuRow
from ..sku_pipeline import compute_sku_metrics, classify_sku_anchors
from ..rules import classify


def classify_skus_within_category(
    category: CategoryRow,
    skus: List[SkuRow],
    cfg: Config,
    period_months: int,
) -> List[Dict[str, Any]]:
    """Classify each SKU within a single category and return flat dicts.

    SKUs inherit DIO/CCC from the category. Anchor selection is per-category
    (top N% by absolute profit). Other rules use config thresholds directly.
    """
    metrics = compute_sku_metrics(skus, [category], cfg.cost_of_capital_pct)
    if not metrics:
        return []

    anchors = classify_sku_anchors(metrics, category.category, cfg, period_months)

    out: List[Dict[str, Any]] = []
    metrics_by_id = {m.category: m for m in metrics}  # category field carries sku_id
    for s in skus:
        m = metrics_by_id.get(s.sku_id)
        if m is None:
            continue
        is_anchor = anchors.get(s.sku_id, False)
        flag, reason, recommendation = classify(m, cfg, is_anchor=is_anchor)
        out.append({
            "id": s.sku_id,
            "sku_name": s.sku_name,
            "brand": s.brand,
            "category": category.category,
            "category_dio_days": category.dio_days,
            "category_ccc_days": category.ccc_days,
            "volume_tons": round(m.volume_tons, 3),
            "revenue_kron": round(m.niv_kron, 1),
            "gross_margin_pct": round(m.gm_pct, 1),
            "real_margin_pct": round(m.real_margin_pct, 1),
            "abs_profit_kron": round(m.abs_profit_kron, 2),
            "flag": flag,
            "reason": reason,
            "recommendation": recommendation,
            "is_anchor": is_anchor,
        })
    return out
