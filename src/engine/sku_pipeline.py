"""SKU-level decision pipeline — drill INTO a category to per-product granularity.

Reuses the same rules as the category pipeline but operates per SKU. SKUs
inherit `dio_days` and `ccc_days` from their parent category when not
provided directly; WOCA is allocated proportionally to the SKU's revenue
share within its parent category, unless the SKU supplies its own WOCA
(via the optional upload column).

Anchor classification at SKU level uses two paths:
  1. Within-category: top N% by absolute profit inside the SKU's own category
  2. Strategic override: master_skus.csv flag

The category-level "5% of division revenue" rule does NOT apply at SKU level
in Phase 1 — that's a SKU-of-SKUs comparison and the brief reserves it for
a future "global rank" pass.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from .buckets import map_bucket
from .config import Config
from .metrics import (
    absolute_profit,
    capital_trapped,
    gmroii,
    inventory_turns,
    net_real_margin,
    real_margin,
    roic,
)
from .models import CategoryMetrics, CategoryRow, Decision, MasterOverride, SkuRow
from .rules import classify


def compute_sku_metrics(
    skus: List[SkuRow],
    categories: List[CategoryRow],
    cost_of_capital_pct: float,
) -> List[CategoryMetrics]:
    """Build CategoryMetrics records from SKU rows.

    We reuse the CategoryMetrics shape because the rules engine is built
    around it — a SKU is just a "category-shaped" record at finer granularity.
    Each metric carries `dio_source = "category_inherited"` to make the
    inheritance auditable.

    WOCA allocation:
      - If the SKU supplies its own woca_kron, use it directly.
      - Otherwise, allocate the parent's woca_kron pro rata to the SKU's
        revenue share within the category (Σ niv_kron of SKUs in cat).
      - When the parent has no WOCA either, fall back to the DIO-based
        approximation (same as the category pipeline).
    """
    cat_by_name: Dict[str, CategoryRow] = {c.category: c for c in categories}

    # Pre-compute revenue totals per category for proportional WOCA allocation
    cat_niv_totals: Dict[str, float] = {}
    for s in skus:
        cat_niv_totals[s.category] = cat_niv_totals.get(s.category, 0.0) + s.niv_kron

    out: List[CategoryMetrics] = []
    for s in skus:
        parent = cat_by_name.get(s.category)
        if parent is None:
            continue

        # Real margin: prefer CCC if available, else DIO
        if parent.ccc_days is not None:
            rm_raw = net_real_margin(s.gm_pct, parent.ccc_days, cost_of_capital_pct)
            source = "computed_ccc"
        else:
            rm_raw = real_margin(s.gm_pct, parent.dio_days, cost_of_capital_pct)
            source = "computed_dio"
        rm = round(rm_raw, 1)
        ap = absolute_profit(rm, s.niv_kron)

        # WOCA: prefer SKU-supplied → proportional from parent → DIO approx.
        cat_total_niv = cat_niv_totals.get(s.category, 0.0) or 1.0
        share = s.niv_kron / cat_total_niv
        if s.woca_kron is not None:
            sku_woca = s.woca_kron
            woca_source = "sku_supplied"
        elif parent.woca_kron is not None:
            sku_woca = parent.woca_kron * share
            woca_source = "allocated"
        else:
            sku_woca = None
            woca_source = "estimated_dio"

        # Average inventory: SKU-supplied if present, else share of parent's
        # NIV*DIO/365 approximation
        if s.avg_inventory_kron is not None:
            avg_inv = s.avg_inventory_kron
        else:
            avg_inv = (parent.niv_kron * parent.dio_days / 365.0) * share

        cap_trapped = capital_trapped(avg_inv)
        roic_val = roic(ap, cap_trapped) if cap_trapped > 0 else None
        gm_value = (s.gm_pct / 100.0) * s.niv_kron
        gmroii_val = (gm_value / avg_inv * 100.0) if avg_inv > 0 else None
        cogs = max(s.niv_kron - gm_value, 0.0)
        inv_turns = inventory_turns(cogs, avg_inv) if avg_inv > 0 else None

        out.append(
            CategoryMetrics(
                category=s.sku_id,  # SKU id used as the unique record key
                business_unit=s.business_unit or parent.business_unit,
                volume_tons=s.volume_tons,
                niv_kron=s.niv_kron,
                gm_pct=s.gm_pct,
                dio_days=s.dio_days if s.dio_days is not None else parent.dio_days,
                ccc_days=parent.ccc_days,
                real_margin_pct=rm,
                abs_profit_kron=ap,
                dio_source=("sku" if s.dio_days is not None else "category_inherited"),
                real_margin_source=source,
                dso_days=s.dso_days or parent.dso_days,
                dpo_days=s.dpo_days or parent.dpo_days,
                avg_inventory_kron=avg_inv,
                woca_kron=sku_woca,
                capital_trapped_kron=cap_trapped,
                roic_pct=roic_val,
                gmroii_pct=gmroii_val,
                inventory_turns=inv_turns,
            )
        )
    return out


def classify_sku_anchors(
    skus: List[CategoryMetrics],
    parent_category: str,
    cfg: Config,
    period_months: int,
    overrides: Optional[Dict[str, MasterOverride]] = None,
) -> Dict[str, bool]:
    """Mark which SKUs in a category are anchors.

    Top-N% by absolute profit within the category. Volume rule and strategic
    override also apply. The "5% of division revenue" rule is NOT applied here
    (see module docstring).
    """
    overrides = overrides or {}
    skus = [s for s in skus]
    if not skus:
        return {}

    sorted_skus = sorted(skus, key=lambda s: s.abs_profit_kron, reverse=True)
    n_anchors = max(
        1, int(len(sorted_skus) * cfg.anchor.top_pct_by_absolute_profit / 100.0)
    )
    top_set = {s.category for s in sorted_skus[:n_anchors]}

    out: Dict[str, bool] = {}
    for s in skus:
        ov = overrides.get(s.category)
        if ov and ov.strategic_flag:
            out[s.category] = True
            continue
        if s.category in top_set and s.abs_profit_kron > 0:
            out[s.category] = True
            continue
        monthly_vol = s.volume_tons / max(period_months, 1)
        if (
            monthly_vol > cfg.anchor.volume_threshold_tons_default
            and s.real_margin_pct > 0
        ):
            out[s.category] = True
            continue
        out[s.category] = False
    return out


def drill_category(
    category_name: str,
    skus: List[SkuRow],
    categories: List[CategoryRow],
    cfg: Config,
    period_months: int,
    overrides: Optional[Dict[str, MasterOverride]] = None,
) -> Tuple[List[CategoryMetrics], List[Decision]]:
    """Run the full SKU-level classification for ONE category.

    Returns (metrics, decisions) — one entry per SKU in the named category,
    ordered from highest absolute profit to lowest.
    """
    in_cat = [
        s for s in skus
        if s.category.strip().lower() == category_name.strip().lower()
    ]
    if not in_cat:
        return [], []

    metrics = compute_sku_metrics(in_cat, categories, cfg.cost_of_capital_pct)
    anchors = classify_sku_anchors(metrics, category_name, cfg, period_months, overrides)

    # Parent category for back-reference
    parent_name = categories[0].category if categories else category_name

    decisions: List[Decision] = []
    for m in metrics:
        is_anchor = anchors.get(m.category, False)
        flag, reason, recommendation = classify(m, cfg, is_anchor=is_anchor)
        bucket = map_bucket(flag, reason, m.abs_profit_kron).value
        decisions.append(
            Decision(
                level="sku",
                id=m.category,
                flag=flag,
                bucket=bucket,
                reason=reason,
                recommendation=recommendation,
                real_margin_pct=round(m.real_margin_pct, 1),
                volume_tons=round(m.volume_tons, 3),
                abs_profit_kron=round(m.abs_profit_kron, 2),
                dio_days=m.dio_days,
                do_not_eliminate=is_anchor,
                alert_reason=reason if flag == "ANCHOR_ALERT" else None,
                capital_trapped_kron=m.capital_trapped_kron,
                roic_pct=m.roic_pct,
                gmroii_pct=m.gmroii_pct,
                gross_margin_pct=m.gm_pct,
                niv_kron=m.niv_kron,
                category=category_name,
            )
        )

    paired = sorted(zip(metrics, decisions), key=lambda p: p[0].abs_profit_kron, reverse=True)
    metrics_sorted = [m for m, _ in paired]
    decisions_sorted = [d for _, d in paired]
    return metrics_sorted, decisions_sorted


def run_sku_pipeline(
    skus: List[SkuRow],
    categories: List[CategoryRow],
    cfg: Config,
    period_months: int,
    overrides: Optional[Dict[str, MasterOverride]] = None,
) -> Tuple[List[CategoryMetrics], List[Decision]]:
    """Classify ALL SKUs across ALL categories.

    Wraps drill_category over each unique category present in the SKU list,
    so the entire portfolio gets a SKU-level decision in one call. Used by
    the new /api/today endpoint and by the v1 SKU-first product surface.
    """
    seen_cats: List[str] = []
    for s in skus:
        if s.category not in seen_cats:
            seen_cats.append(s.category)

    all_metrics: List[CategoryMetrics] = []
    all_decisions: List[Decision] = []
    for cat_name in seen_cats:
        ms, ds = drill_category(
            cat_name, skus, categories, cfg, period_months, overrides=overrides
        )
        all_metrics.extend(ms)
        all_decisions.extend(ds)
    return all_metrics, all_decisions
