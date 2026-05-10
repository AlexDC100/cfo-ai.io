"""Deterministic SKU classification.

Per the build prompt: classification is engine-driven, NOT LLM-driven, so
it's fast, predictable, and re-runnable. Opus only generates the rationale
text — the bucket assignment is a pure function of the SKU's economics
relative to its peer portfolio.

Within-portfolio percentiles drive the thresholds (not industry benchmarks)
because actionable groupings are relative to what THIS company sells.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass
class PeerPercentiles:
    """Computed across the active portfolio for one period."""
    real_margin_p25: float
    real_margin_p50: float
    real_margin_p75: float
    real_margin_p90: float
    volume_p10: float
    dio_p75: float


def _percentile(values: List[float], p: float) -> float:
    """Linear-interp percentile (0..1). Returns 0.0 for an empty list."""
    if not values:
        return 0.0
    s = sorted(v for v in values if v is not None)
    if not s:
        return 0.0
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * p
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def compute_peer_percentiles(skus: List[Dict[str, Any]]) -> PeerPercentiles:
    real_margins = [s.get("real_margin", 0.0) or 0.0 for s in skus]
    real_margin_pcts = [s.get("real_margin_pct", 0.0) or 0.0 for s in skus]
    volumes = [s.get("volume", 0.0) or 0.0 for s in skus]
    dios = [s.get("days_inventory_on_hand", 0.0) or 0.0 for s in skus if s.get("days_inventory_on_hand")]
    return PeerPercentiles(
        real_margin_p25=_percentile(real_margin_pcts, 0.25),
        real_margin_p50=_percentile(real_margin_pcts, 0.50),
        real_margin_p75=_percentile(real_margin_pcts, 0.75),
        real_margin_p90=_percentile(real_margins, 0.90),
        volume_p10=_percentile(volumes, 0.10),
        dio_p75=_percentile(dios, 0.75) if dios else 90.0,
    )


def compute_real_margin(
    sku: Dict[str, Any],
    *,
    total_revenue: float,
    total_sga: float,
    cost_of_capital: float = 0.065,
) -> Dict[str, float]:
    """Compute gross + real margin in absolute and pct terms. Idempotent —
    fills in missing fields without overwriting non-null values from extract.
    """
    revenue = float(sku.get("revenue", 0) or 0)
    cogs = float(sku.get("cogs", 0) or 0)
    inventory_value = float(sku.get("inventory_value", 0) or 0)
    dio = float(sku.get("days_inventory_on_hand", 0) or 0)

    gross_margin = sku.get("gross_margin")
    if gross_margin is None:
        gross_margin = revenue - cogs
    gross_margin = float(gross_margin)

    gross_margin_pct = sku.get("gross_margin_pct")
    if gross_margin_pct is None and revenue:
        gross_margin_pct = gross_margin / revenue
    gross_margin_pct = float(gross_margin_pct) if gross_margin_pct is not None else 0.0

    # Allocated SG&A (proportional to revenue share)
    allocated_overhead = (revenue / total_revenue) * total_sga if total_revenue > 0 else 0.0

    # Capital cost on tied-up inventory
    capital_cost = inventory_value * cost_of_capital * (dio / 365.0) if dio > 0 else 0.0
    capital_tied_up = inventory_value * (dio / 365.0) if dio > 0 else inventory_value * 0.25

    real_margin = gross_margin - allocated_overhead - capital_cost
    real_margin_pct = real_margin / revenue if revenue else 0.0

    return {
        "gross_margin": round(gross_margin, 2),
        "gross_margin_pct": round(gross_margin_pct, 4),
        "real_margin": round(real_margin, 2),
        "real_margin_pct": round(real_margin_pct, 4),
        "capital_tied_up": round(capital_tied_up, 2),
    }


def classify(sku: Dict[str, Any], peer: PeerPercentiles) -> Dict[str, Any]:
    """Returns { classification, classification_reason, classification_confidence }.
    Pure function of the SKU + peer percentiles. No LLM.
    """
    rm_pct = float(sku.get("real_margin_pct", 0) or 0)
    rm_abs = float(sku.get("real_margin", 0) or 0)
    volume = float(sku.get("volume", 0) or 0)
    dio = float(sku.get("days_inventory_on_hand", 0) or 0)

    # 1. Eliminate vs wind-down — real margin is the kill signal.
    if rm_pct < -0.05 and volume > peer.volume_p10:
        return {
            "classification": "eliminate",
            "classification_reason": f"Real margin {rm_pct*100:.1f}% — bleeds money on every unit. Material volume ({volume:.1f}) makes this a priority cut.",
            "classification_confidence": 0.95,
        }
    if rm_pct < 0 and volume <= peer.volume_p10:
        return {
            "classification": "wind_down",
            "classification_reason": f"Negative real margin ({rm_pct*100:.1f}%) and sub-decile volume — wind down rather than urgent cut.",
            "classification_confidence": 0.85,
        }
    if rm_pct < -0.02:
        return {
            "classification": "eliminate",
            "classification_reason": f"Negative real margin {rm_pct*100:.1f}% — every unit costs the business.",
            "classification_confidence": 0.85,
        }

    # 2. Anchor — top-decile profit + healthy margin.
    is_top_profit = rm_abs >= peer.real_margin_p90 and peer.real_margin_p90 > 0
    has_healthy_margin = rm_pct > 0.10
    if is_top_profit and has_healthy_margin:
        # No trend data yet → straight anchor. anchor_alert kicks in when
        # multi-period trends are available (Step 3 follow-up).
        return {
            "classification": "anchor",
            "classification_reason": f"Top-decile profit (P90+ in portfolio) with healthy real margin {rm_pct*100:.1f}%. Protect this SKU.",
            "classification_confidence": 0.90,
        }

    # 3. Scale — high margin (without yet having QoQ trend data).
    if rm_pct > 0.20:
        return {
            "classification": "scale",
            "classification_reason": f"Real margin {rm_pct*100:.1f}% — well above portfolio median. Allocate more capital here.",
            "classification_confidence": 0.75,
        }

    # 4. Watch — marginal economics or working-capital drag.
    if rm_pct < 0.05:
        return {
            "classification": "watch",
            "classification_reason": f"Thin real margin ({rm_pct*100:.1f}%) — monitor. Small cost pressure flips this negative.",
            "classification_confidence": 0.70,
        }
    if dio > peer.dio_p75 and dio > 0:
        return {
            "classification": "watch",
            "classification_reason": f"DIO {dio:.0f} days exceeds portfolio P75. Working capital drag erodes the {rm_pct*100:.1f}% real margin.",
            "classification_confidence": 0.70,
        }

    # 5. Keep — profitable and ordinary.
    return {
        "classification": "keep",
        "classification_reason": f"Profitable ({rm_pct*100:.1f}% real margin) but not a portfolio leader. Keep without action.",
        "classification_confidence": 0.80,
    }


def classify_portfolio(
    raw_skus: List[Dict[str, Any]],
    *,
    cost_of_capital: float = 0.065,
    sga_ratio: float = 0.05,  # crude default: 5% of revenue is SGA
) -> List[Dict[str, Any]]:
    """Take the raw extracted SKUs, compute economics + classify, return the
    enriched list ready for persistence. Pure function — no I/O.
    """
    if not raw_skus:
        return []

    total_revenue = sum(float(s.get("revenue", 0) or 0) for s in raw_skus)
    total_sga = total_revenue * sga_ratio

    enriched: List[Dict[str, Any]] = []
    for raw in raw_skus:
        if not raw.get("sku"):
            continue
        margins = compute_real_margin(raw, total_revenue=total_revenue, total_sga=total_sga, cost_of_capital=cost_of_capital)
        merged = {**raw, **margins}
        enriched.append(merged)

    peer = compute_peer_percentiles(enriched)
    for sku in enriched:
        sku.update(classify(sku, peer))

    return enriched


def portfolio_totals(skus: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Top-of-page totals for the Products header."""
    classifications = [s.get("classification") for s in skus]
    counts = {c: classifications.count(c) for c in set(classifications) if c}
    eliminate_skus = [s for s in skus if s.get("classification") in ("eliminate", "wind_down")]
    losses = sum(s.get("real_margin", 0) for s in eliminate_skus if (s.get("real_margin") or 0) < 0)
    total_revenue = sum(s.get("revenue", 0) or 0 for s in skus)
    total_profit = sum(s.get("real_margin", 0) or 0 for s in skus)
    total_volume = sum(s.get("volume", 0) or 0 for s in skus)
    categories = {s.get("category") for s in skus if s.get("category")}
    return {
        "sku_count": len(skus),
        "category_count": len(categories),
        "categories": sorted([c for c in categories if c]),
        "classification_counts": counts,
        "losses_from_eliminate": round(losses, 2),
        "revenue": round(total_revenue, 2),
        "profit": round(total_profit, 2),
        "volume": round(total_volume, 2),
    }
