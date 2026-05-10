"""End-to-end pipeline: raw rows → CategoryMetrics → classifications → output dict.

Kept separate from `actions.py` (which writes JSON) so the pipeline returns
plain Python objects that tests can introspect.

The classifier still emits the legacy flag (ANCHOR / WARNING / ELIMINATE / …);
the CFO bucket (PROTECT / WATCH / FIX / REDUCE / LIQUIDATE / SCALE) is computed
from (flag, reason, abs_profit) via `buckets.map_bucket`.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from .anchors import classify_anchors
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
from .models import CategoryMetrics, CategoryRow, Decision, MasterOverride
from .rules import classify


def compute_category_metrics(
    rows: List[CategoryRow], cost_of_capital_pct: float
) -> List[CategoryMetrics]:
    """Pure transform: input rows → enriched CategoryMetrics with real_margin.

    Real-margin source priority (most accurate first):
      1. `real_margin_pct_stored` — the Excel/fixture WOCA-corrected value
      2. CCC formula — `gm_pct - (CCC/365) * CoC`, valid when DSO/DPO known
      3. DIO formula — `gm_pct - (DIO/365) * CoC`

    CFO-AI extension fields (capital_trapped, roic, gmroii, inventory_turns)
    are populated when the underlying data is available; otherwise left None
    so the UI can show "—" rather than fabricated zeros.
    """
    out: List[CategoryMetrics] = []
    for r in rows:
        if r.real_margin_pct_stored is not None:
            rm_raw = r.real_margin_pct_stored
            source = "excel_woca"
        elif r.ccc_days is not None:
            rm_raw = net_real_margin(r.gm_pct, r.ccc_days, cost_of_capital_pct)
            source = "computed_ccc"
        else:
            rm_raw = real_margin(r.gm_pct, r.dio_days, cost_of_capital_pct)
            source = "computed_dio"
        rm = round(rm_raw, 1)
        ap = absolute_profit(rm, r.niv_kron)

        # CFO-AI fields. avg_inventory_kron is approximated from NIV*DIO/365
        # when not supplied directly — same shape the engine has used for
        # capital_freed estimates since v0.
        avg_inv_approx = r.niv_kron * r.dio_days / 365.0
        cap_trapped = capital_trapped(avg_inv_approx, 0.0, 0.0)
        # Operating profit after working-capital cost ≈ abs_profit (kRON).
        # Invested capital ≈ avg_inventory + receivables - payables.
        # When we have nothing else, ROIC reduces to abs_profit / avg_inv.
        roic_val = roic(ap, cap_trapped) if cap_trapped > 0 else None
        # GMROII expects raw GM value over inventory; we have GM% so use
        # gm_pct * niv / avg_inv as the equivalent. Returns % already.
        gm_value = (r.gm_pct / 100.0) * r.niv_kron
        gmroii_val = (gm_value / avg_inv_approx * 100.0) if avg_inv_approx > 0 else None
        # Inventory turns ≈ COGS / avg_inv. We approximate COGS as NIV - GM.
        cogs = max(r.niv_kron - gm_value, 0.0)
        inv_turns = inventory_turns(cogs, avg_inv_approx) if avg_inv_approx > 0 else None

        out.append(
            CategoryMetrics(
                category=r.category,
                business_unit=r.business_unit,
                volume_tons=r.volume_tons,
                niv_kron=r.niv_kron,
                gm_pct=r.gm_pct,
                dio_days=r.dio_days,
                ccc_days=r.ccc_days,
                real_margin_pct=rm,
                abs_profit_kron=ap,
                dio_source="category",
                real_margin_source=source,
                dso_days=r.dso_days,
                dpo_days=r.dpo_days,
                avg_inventory_kron=avg_inv_approx,
                woca_kron=r.woca_kron,
                capital_trapped_kron=cap_trapped,
                roic_pct=roic_val,
                gmroii_pct=gmroii_val,
                inventory_turns=inv_turns,
            )
        )
    return out


def run_pipeline(
    rows: List[CategoryRow],
    cfg: Config,
    period_months: int,
    overrides: Optional[Dict[str, MasterOverride]] = None,
) -> Tuple[List[CategoryMetrics], List[Decision]]:
    """Run anchor classification + rule application across all categories.

    Returns the enriched metrics (with profit_share populated) and the
    per-category decisions in the same order as input. Each Decision carries
    both the legacy `flag` and the CFO `bucket`.
    """
    metrics = compute_category_metrics(rows, cfg.cost_of_capital_pct)
    anchors = classify_anchors(metrics, cfg.anchor, period_months, overrides=overrides)

    decisions: List[Decision] = []
    for m in metrics:
        is_anchor = anchors[m.category]
        flag, reason, recommendation = classify(m, cfg, is_anchor=is_anchor)
        capital_freed = (
            _capital_freed_estimate(m, cfg) if flag == "ELIMINATE" else None
        )
        do_not_eliminate = flag in ("ANCHOR", "ANCHOR_ALERT", "ANCHOR_REVIEW")
        bucket = map_bucket(flag, reason, m.abs_profit_kron).value
        decisions.append(
            Decision(
                level="category",
                id=m.category,
                flag=flag,
                bucket=bucket,
                reason=reason,
                recommendation=recommendation,
                real_margin_pct=round(m.real_margin_pct, 2),
                volume_tons=round(m.volume_tons, 1),
                abs_profit_kron=round(m.abs_profit_kron, 2),
                dio_days=m.dio_days,
                do_not_eliminate=do_not_eliminate,
                capital_freed_kron=capital_freed,
                alert_reason=reason if flag == "ANCHOR_ALERT" else None,
                context=_context_string(m, flag),
                capital_trapped_kron=m.capital_trapped_kron,
                roic_pct=m.roic_pct,
                gmroii_pct=m.gmroii_pct,
                gross_margin_pct=m.gm_pct,
                niv_kron=m.niv_kron,
            )
        )
    return metrics, decisions


def _capital_freed_estimate(m: CategoryMetrics, cfg: Config) -> float:
    """Rough estimate of working capital freed by discontinuing the category.

    NIV × DIO/365 — the same shape as WOCA but without the cost-of-capital
    multiplier, since we want freed *capital*, not freed *cost*.
    """
    return round(m.niv_kron * m.dio_days / 365.0, 2)


def _context_string(m: CategoryMetrics, flag: str) -> Optional[str]:
    """Human-readable one-liner attached to each decision."""
    if flag == "ANCHOR_ALERT":
        return (
            f"{m.volume_tons:.1f}t volume, {m.gm_pct:.1f}% gross margin "
            f"compressed to {m.real_margin_pct:.1f}% by {m.dio_days}-day DIO"
        )
    if flag == "WARNING":
        return (
            f"{m.volume_tons:.1f}t volume, {m.real_margin_pct:.2f}% real margin, "
            f"DIO {m.dio_days}d"
        )
    if flag == "ELIMINATE":
        return (
            f"vol {m.volume_tons:.2f}t, real_margin {m.real_margin_pct:.1f}%, "
            f"abs_profit {m.abs_profit_kron:.2f} kRON"
        )
    return None
