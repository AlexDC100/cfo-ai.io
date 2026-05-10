"""CFO Alert Engine — detect financial deviations across the dataset.

This module turns the engine's classification output into actionable alerts
covering ten deviation types (margin, price, cost, working capital,
slow-moving, anchor health, opportunity, customer profitability, supplier,
data quality).

Alerts are stateless and re-derived on every run — the React app may persist
user-side state (acknowledged / dismissed) on top of these in a future pass.
"""

from __future__ import annotations

import hashlib
from typing import Dict, List, Optional, Sequence, Union

from pydantic import BaseModel, ConfigDict, Field

from .config import Config
from .models import CategoryMetrics, Decision, SkuRow


# ─── Alert model ─────────────────────────────────────────────────────────


AlertType = str  # "margin" | "price" | "cost" | "working_capital" | "slow_moving"
                 # | "anchor_health" | "opportunity" | "customer_profitability"
                 # | "supplier" | "data_quality"
Severity = str   # "low" | "medium" | "high" | "critical"
ActionType = str # "price_increase" | "cost_optimization" | "supplier_renegotiation"
                 # | "reduce_stock" | "liquidate" | "protect_review" | "scale"
                 # | "data_fix" | "manual_review"


class ExpectedImpact(BaseModel):
    cash_impact_kron: Optional[float] = None
    margin_impact_pct: Optional[float] = None
    roic_impact_pct: Optional[float] = None


class Alert(BaseModel):
    """A single financial / operational warning surfaced to the CFO."""

    model_config = ConfigDict(frozen=True)

    id: str
    alert_type: AlertType
    severity: Severity
    status: str = "new"  # new | acknowledged | assigned | in_progress | resolved | dismissed

    target_type: str  # sku | category | customer | supplier | channel | dataset
    target_id: str
    target_name: str

    title: str
    summary: str
    explanation: str

    metric_name: str
    current_value: Union[float, str]
    benchmark_value: Optional[Union[float, str]] = None
    threshold_value: Optional[Union[float, str]] = None
    delta_value: Optional[Union[float, str]] = None

    recommended_action: str
    action_type: ActionType

    expected_impact: Optional[ExpectedImpact] = None

    owner: Optional[str] = None
    created_at: str
    updated_at: str


# ─── Severity & threshold helpers ────────────────────────────────────────


# Working capital absolute thresholds in kRON. The dataset numbers used by the
# UI are kEUR-equivalent so these are intentionally calibrated for that scale.
CAPITAL_TRAP_HIGH_KRON = 200_000.0   # 200k EUR equivalent
CAPITAL_TRAP_CRITICAL_KRON = 400_000.0  # 400k EUR

# Slow-moving thresholds — DIO ladder.
DIO_HIGH = 100
DIO_CRITICAL = 150

# Anchor health margin floor — an anchor SKU/category whose real margin drops
# below this is a "watch" rather than a delisting candidate.
ANCHOR_HEALTH_FLOOR_PCT = 5.0

# Margin compression — gross margin below this with a non-trivial volume is
# a Margin Alert.
THIN_MARGIN_HIGH_PCT = 5.0
THIN_MARGIN_CRITICAL_PCT = 0.0  # negative real margin

# Opportunity SKU thresholds.
OPPORTUNITY_REAL_MARGIN_PCT = 12.0
OPPORTUNITY_DIO_MAX = 80


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _id_for(*parts: str) -> str:
    """Stable id from the alert's target + type so re-runs return the same id."""
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def _category_real_margin_avg(metrics: Sequence[CategoryMetrics]) -> float:
    """Volume-weighted real margin across the dataset — used as benchmark."""
    total_niv = sum(m.niv_kron for m in metrics) or 1.0
    return sum(m.real_margin_pct * m.niv_kron for m in metrics) / total_niv


# ─── Detectors ───────────────────────────────────────────────────────────


def _margin_alerts(
    metrics: Sequence[CategoryMetrics],
    decisions: Sequence[Decision],
) -> List[Alert]:
    """Real margin below benchmark or below thin-margin threshold."""
    out: List[Alert] = []
    if not metrics:
        return out
    benchmark = _category_real_margin_avg(metrics)
    now = _now_iso()
    dec_by_id = {d.id: d for d in decisions if d.level == "category"}

    for m in metrics:
        d = dec_by_id.get(m.category)
        # Skip categories the engine already wants to liquidate — they're
        # covered by the Liquidate flow, not a margin alert.
        if d and d.flag == "ELIMINATE":
            continue
        # Fire only when the absolute real-margin number is thin. Benchmark is
        # used for context in the summary line, not as the trigger — otherwise
        # healthy categories sitting below an above-average benchmark would
        # spam alerts.
        if m.real_margin_pct >= THIN_MARGIN_HIGH_PCT:
            continue

        if m.real_margin_pct < THIN_MARGIN_CRITICAL_PCT:
            severity = "critical"
        elif m.real_margin_pct < THIN_MARGIN_HIGH_PCT * 0.5:
            severity = "high"
        else:
            severity = "medium"

        delta = round(m.real_margin_pct - benchmark, 1)
        out.append(Alert(
            id=_id_for("margin", m.category),
            alert_type="margin",
            severity=severity,
            target_type="category",
            target_id=m.category,
            target_name=m.category,
            title=f"{m.category} real margin {m.real_margin_pct:.1f}%",
            summary=(
                f"Real margin {m.real_margin_pct:.1f}% sits {abs(delta):.1f}pp below the "
                f"{benchmark:.1f}% portfolio average."
            ),
            explanation=(
                f"After working-capital cost ({m.dio_days}d DIO at the engine's cost-of-capital "
                f"rate), {m.category} is delivering {m.real_margin_pct:.1f}% real margin on "
                f"{m.niv_kron:.0f}k revenue. Either raise price or reduce trapped capital."
            ),
            metric_name="real_margin_pct",
            current_value=round(m.real_margin_pct, 1),
            benchmark_value=round(benchmark, 1),
            threshold_value=THIN_MARGIN_HIGH_PCT,
            delta_value=delta,
            recommended_action=(
                "Run a price-and-cost review for this category — start with the lowest-margin SKU."
            ),
            action_type="manual_review",
            expected_impact=ExpectedImpact(
                margin_impact_pct=max(0.0, THIN_MARGIN_HIGH_PCT - m.real_margin_pct),
            ),
            created_at=now,
            updated_at=now,
        ))
    return out


def _price_alerts(
    metrics: Sequence[CategoryMetrics],
    decisions: Sequence[Decision],
) -> List[Alert]:
    """Gross margin healthy but real margin compressed — DIO/CCC eats it.

    With per-period cost data we'd compare cost trend vs. price trend; until
    that's wired we use the gap between gross margin and real margin as the
    proxy: a wide gap means working-capital cost is doing the damage and a
    price action would close it.
    """
    out: List[Alert] = []
    if not metrics:
        return out
    now = _now_iso()
    for m in metrics:
        gap = m.gm_pct - m.real_margin_pct
        if gap < 6.0:           # less than 6pp of WOCA drag — not price-actionable
            continue
        if m.gm_pct < 4.0:      # too thin to begin with — handled by Margin Alert
            continue
        severity = "high" if gap >= 10 else "medium"
        out.append(Alert(
            id=_id_for("price", m.category),
            alert_type="price",
            severity=severity,
            target_type="category",
            target_id=m.category,
            target_name=m.category,
            title=f"{m.category} losing {gap:.1f}pp to working-capital cost",
            summary=(
                f"Gross margin {m.gm_pct:.1f}% but real margin only {m.real_margin_pct:.1f}% — "
                f"{gap:.1f}pp drag from {m.dio_days}d DIO."
            ),
            explanation=(
                "A price increase that recovers the working-capital cost would lift real "
                "margin without changing the cost base. Test elasticity on the largest SKU first."
            ),
            metric_name="real_margin_pct",
            current_value=round(m.real_margin_pct, 1),
            benchmark_value=round(m.gm_pct, 1),
            delta_value=round(-gap, 1),
            recommended_action=(
                f"Raise price on {m.category} by ~{min(gap, 5):.1f}% or cut DIO below "
                f"{max(60, m.dio_days - 30)} days."
            ),
            action_type="price_increase",
            expected_impact=ExpectedImpact(margin_impact_pct=round(gap * 0.4, 1)),
            created_at=now,
            updated_at=now,
        ))
    return out


def _cost_alerts(
    metrics: Sequence[CategoryMetrics],
    decisions: Sequence[Decision],
) -> List[Alert]:
    """Direct margin / gross margin abnormally low for the category type.

    Without trend data we treat any category with gm_pct < 6% AND non-trivial
    volume as a cost-side alert (the gross margin itself is the deviation).
    """
    out: List[Alert] = []
    if not metrics:
        return out
    now = _now_iso()
    for m in metrics:
        if m.gm_pct >= 6.0:
            continue
        if m.volume_tons < 1.0:  # micro-volume — handled by Slow-Moving / Liquidate
            continue
        severity = "critical" if m.gm_pct < 0 else ("high" if m.gm_pct < 3 else "medium")
        out.append(Alert(
            id=_id_for("cost", m.category),
            alert_type="cost",
            severity=severity,
            target_type="category",
            target_id=m.category,
            target_name=m.category,
            title=f"{m.category} gross margin only {m.gm_pct:.1f}%",
            summary=(
                f"COGS pressure has compressed gross margin to {m.gm_pct:.1f}% on "
                f"{m.volume_tons:.1f}t of volume."
            ),
            explanation=(
                "Suppliers, packaging, or production yield should be reviewed. Compare quotes "
                "against the last contracted prices and look for bulk-buy or alternative-source "
                "options."
            ),
            metric_name="gross_margin_pct",
            current_value=round(m.gm_pct, 1),
            threshold_value=6.0,
            delta_value=round(m.gm_pct - 6.0, 1),
            recommended_action="Renegotiate top suppliers or move to a lower-cost source.",
            action_type="cost_optimization",
            expected_impact=ExpectedImpact(margin_impact_pct=round(max(0.0, 6.0 - m.gm_pct), 1)),
            created_at=now,
            updated_at=now,
        ))
    return out


def _working_capital_alerts(
    metrics: Sequence[CategoryMetrics],
) -> List[Alert]:
    """DIO and capital-trapped above thresholds."""
    out: List[Alert] = []
    if not metrics:
        return out
    now = _now_iso()
    for m in metrics:
        capital = (m.capital_trapped_kron or (m.niv_kron * m.dio_days / 365.0))
        if m.dio_days < DIO_HIGH and capital < CAPITAL_TRAP_HIGH_KRON:
            continue

        if capital >= CAPITAL_TRAP_CRITICAL_KRON or m.dio_days >= DIO_CRITICAL:
            severity = "critical"
        elif m.dio_days >= DIO_HIGH or capital >= CAPITAL_TRAP_HIGH_KRON:
            severity = "high"
        else:
            severity = "medium"

        out.append(Alert(
            id=_id_for("working_capital", m.category),
            alert_type="working_capital",
            severity=severity,
            target_type="category",
            target_id=m.category,
            target_name=m.category,
            title=f"{m.category} has {capital/1000:.0f}k trapped at {m.dio_days}d DIO",
            summary=(
                f"Working capital tied in {m.category} is high relative to its profit "
                f"contribution — review reorder size and payment terms."
            ),
            explanation=(
                f"At {m.dio_days} days of inventory and {m.niv_kron:.0f}k revenue, the "
                f"category is locking up roughly {capital/1000:.0f}k of capital. Cutting DIO "
                "by 20 days would release a meaningful slug."
            ),
            metric_name="capital_trapped_kron",
            current_value=round(capital, 0),
            threshold_value=CAPITAL_TRAP_HIGH_KRON,
            delta_value=round(capital - CAPITAL_TRAP_HIGH_KRON, 0),
            recommended_action=(
                f"Reduce reorder quantities for {m.category} until DIO sits under "
                f"{max(60, DIO_HIGH - 20)} days."
            ),
            action_type="reduce_stock",
            expected_impact=ExpectedImpact(
                cash_impact_kron=round(capital * 0.25, 0),
            ),
            created_at=now,
            updated_at=now,
        ))
    return out


def _slow_moving_alerts(
    metrics: Sequence[CategoryMetrics],
    decisions: Sequence[Decision],
) -> List[Alert]:
    """Sub-tonne volume sitting on long DIO — slow rotation."""
    out: List[Alert] = []
    if not metrics:
        return out
    now = _now_iso()
    dec_by_id = {d.id: d for d in decisions if d.level == "category"}
    for m in metrics:
        d = dec_by_id.get(m.category)
        if d and d.flag in ("ELIMINATE",):  # already going to liquidate
            continue
        if m.dio_days < DIO_HIGH:
            continue
        if m.volume_tons >= 10:  # high volume = working capital alert covers it
            continue
        severity = "critical" if m.dio_days >= DIO_CRITICAL else "high"
        out.append(Alert(
            id=_id_for("slow_moving", m.category),
            alert_type="slow_moving",
            severity=severity,
            target_type="category",
            target_id=m.category,
            target_name=m.category,
            title=f"{m.category} is rotating slowly ({m.dio_days}d / {m.volume_tons:.1f}t)",
            summary=(
                f"Inventory sits {m.dio_days} days on {m.volume_tons:.1f}t of volume — "
                "consider promotion, transfer, or liquidation."
            ),
            explanation=(
                "Slow rotation compounds working-capital cost. If demand is genuinely soft, "
                "clearing inventory frees cash that the engine can redeploy to scale-bucket SKUs."
            ),
            metric_name="dio_days",
            current_value=m.dio_days,
            threshold_value=DIO_HIGH,
            delta_value=m.dio_days - DIO_HIGH,
            recommended_action=(
                f"Run a promotion on {m.category} or transfer stock to higher-velocity channels."
            ),
            action_type="reduce_stock",
            created_at=now,
            updated_at=now,
        ))
    return out


def _anchor_health_alerts(
    metrics: Sequence[CategoryMetrics],
    decisions: Sequence[Decision],
) -> List[Alert]:
    """Anchor categories whose real margin has slipped below health threshold."""
    out: List[Alert] = []
    now = _now_iso()
    metrics_by_id = {m.category: m for m in metrics}
    for d in decisions:
        if d.level != "category":
            continue
        if d.flag not in ("ANCHOR", "ANCHOR_ALERT", "ANCHOR_REVIEW"):
            continue
        m = metrics_by_id.get(d.id)
        if m is None:
            continue
        if m.real_margin_pct >= ANCHOR_HEALTH_FLOOR_PCT:
            continue
        severity = "high" if m.real_margin_pct >= 0 else "critical"
        out.append(Alert(
            id=_id_for("anchor_health", d.id),
            alert_type="anchor_health",
            severity=severity,
            target_type="category",
            target_id=d.id,
            target_name=d.id,
            title=f"{d.id} is a protected anchor with {m.real_margin_pct:.1f}% real margin",
            summary=(
                f"Volume keeps it protected, but margin has fallen below the {ANCHOR_HEALTH_FLOOR_PCT:.0f}% "
                "anchor-health floor. Action — not delisting."
            ),
            explanation=(
                "Anchor SKUs are kept in the assortment for traffic and revenue weight, but they "
                "still need to clear cost-of-capital. A targeted price or cost action protects "
                "the anchor without removing it."
            ),
            metric_name="real_margin_pct",
            current_value=round(m.real_margin_pct, 1),
            threshold_value=ANCHOR_HEALTH_FLOOR_PCT,
            delta_value=round(m.real_margin_pct - ANCHOR_HEALTH_FLOOR_PCT, 1),
            recommended_action=(
                f"Open a margin-recovery initiative for {d.id} — price ladder, pack-mix, or "
                "supplier renegotiation."
            ),
            action_type="protect_review",
            expected_impact=ExpectedImpact(
                margin_impact_pct=round(ANCHOR_HEALTH_FLOOR_PCT - m.real_margin_pct, 1),
            ),
            created_at=now,
            updated_at=now,
        ))
    return out


def _opportunity_alerts(
    metrics: Sequence[CategoryMetrics],
    decisions: Sequence[Decision],
) -> List[Alert]:
    """High real margin + fast rotation — should be scaled."""
    out: List[Alert] = []
    now = _now_iso()
    metrics_by_id = {m.category: m for m in metrics}
    for d in decisions:
        if d.level != "category":
            continue
        m = metrics_by_id.get(d.id)
        if m is None:
            continue
        is_scale_flagged = d.flag == "SCALE"
        is_high_margin_fast = (
            m.real_margin_pct >= OPPORTUNITY_REAL_MARGIN_PCT
            and m.dio_days <= OPPORTUNITY_DIO_MAX
        )
        if not (is_scale_flagged or is_high_margin_fast):
            continue
        out.append(Alert(
            id=_id_for("opportunity", d.id),
            alert_type="opportunity",
            severity="medium",
            target_type="category",
            target_id=d.id,
            target_name=d.id,
            title=f"{d.id} is over-performing — scale candidate",
            summary=(
                f"{m.real_margin_pct:.1f}% real margin at {m.dio_days}d DIO. Increase allocation "
                "and confirm supply can keep up."
            ),
            explanation=(
                "Scale candidates clear cost-of-capital with headroom and rotate fast — the "
                "kind of SKUs that respond well to additional shelf space, advertising, or "
                "purchase volume."
            ),
            metric_name="real_margin_pct",
            current_value=round(m.real_margin_pct, 1),
            threshold_value=OPPORTUNITY_REAL_MARGIN_PCT,
            delta_value=round(m.real_margin_pct - OPPORTUNITY_REAL_MARGIN_PCT, 1),
            recommended_action=(
                f"Increase {d.id} purchase allocation by 10-20% next cycle."
            ),
            action_type="scale",
            expected_impact=ExpectedImpact(
                cash_impact_kron=round(m.abs_profit_kron * 0.15, 0),
            ),
            created_at=now,
            updated_at=now,
        ))
    return out


def _customer_profitability_alerts(
    sku_records: Sequence[SkuRow],
) -> List[Alert]:
    """Customer/channel margin below average — only fires if the upload carries
    customer/channel columns. Otherwise silent."""
    out: List[Alert] = []
    by_customer: Dict[str, Dict[str, float]] = {}
    has_customer_data = False
    for s in sku_records:
        cust = s.customer or s.channel
        if not cust:
            continue
        has_customer_data = True
        agg = by_customer.setdefault(cust, {"niv": 0.0, "gm": 0.0})
        agg["niv"] += s.niv_kron
        agg["gm"] += s.niv_kron * (s.gm_pct / 100.0)
    if not has_customer_data:
        return out
    total_niv = sum(a["niv"] for a in by_customer.values()) or 1.0
    portfolio_gm = sum(a["gm"] for a in by_customer.values()) / total_niv * 100.0
    now = _now_iso()
    for cust, agg in by_customer.items():
        if agg["niv"] < 1.0:
            continue
        gm = (agg["gm"] / agg["niv"]) * 100.0
        if gm >= portfolio_gm - 2.0:
            continue
        severity = "high" if gm < portfolio_gm - 5.0 else "medium"
        out.append(Alert(
            id=_id_for("customer_profitability", cust),
            alert_type="customer_profitability",
            severity=severity,
            target_type="customer",
            target_id=cust,
            target_name=cust,
            title=f"{cust} margin {gm:.1f}% vs {portfolio_gm:.1f}% portfolio average",
            summary=(
                f"This customer/channel runs {portfolio_gm - gm:.1f}pp below average — review "
                "pricing or terms."
            ),
            explanation=(
                "When a customer mix tilts toward low-margin SKUs, total revenue can grow "
                "while real profit erodes. A targeted assortment or price review usually closes "
                "the gap."
            ),
            metric_name="gross_margin_pct",
            current_value=round(gm, 1),
            benchmark_value=round(portfolio_gm, 1),
            delta_value=round(gm - portfolio_gm, 1),
            recommended_action=f"Open a commercial review with {cust}.",
            action_type="manual_review",
            created_at=now,
            updated_at=now,
        ))
    return out


def _supplier_alerts(
    sku_records: Sequence[SkuRow],
) -> List[Alert]:
    """Supplier-level margin / rotation issues. Only fires with supplier data."""
    out: List[Alert] = []
    by_supplier: Dict[str, Dict[str, float]] = {}
    has_supplier_data = False
    for s in sku_records:
        if not s.supplier:
            continue
        has_supplier_data = True
        agg = by_supplier.setdefault(s.supplier, {"niv": 0.0, "gm": 0.0, "dio_w": 0.0, "vol": 0.0})
        agg["niv"] += s.niv_kron
        agg["gm"] += s.niv_kron * (s.gm_pct / 100.0)
        agg["vol"] += s.volume_tons
        if s.dio_days is not None:
            agg["dio_w"] += s.volume_tons * s.dio_days
    if not has_supplier_data:
        return out
    now = _now_iso()
    for sup, agg in by_supplier.items():
        if agg["niv"] < 1.0:
            continue
        gm = (agg["gm"] / agg["niv"]) * 100.0
        avg_dio = (agg["dio_w"] / agg["vol"]) if agg["vol"] > 0 else None
        if gm >= 6.0 and (avg_dio is None or avg_dio < DIO_HIGH):
            continue
        severity = "high" if gm < 3.0 or (avg_dio and avg_dio >= DIO_CRITICAL) else "medium"
        out.append(Alert(
            id=_id_for("supplier", sup),
            alert_type="supplier",
            severity=severity,
            target_type="supplier",
            target_id=sup,
            target_name=sup,
            title=f"{sup} portfolio {gm:.1f}% margin",
            summary=(
                f"Products from {sup} run {gm:.1f}% gross margin"
                + (f", rotating at {avg_dio:.0f}d DIO." if avg_dio else ".")
            ),
            explanation=(
                "Concentrate the renegotiation effort here — moving 1pp of margin on a single "
                "supplier's portfolio compounds across every SKU they ship."
            ),
            metric_name="gross_margin_pct",
            current_value=round(gm, 1),
            threshold_value=6.0,
            delta_value=round(gm - 6.0, 1),
            recommended_action=f"Open a renegotiation with {sup}.",
            action_type="supplier_renegotiation",
            created_at=now,
            updated_at=now,
        ))
    return out


def _data_quality_alerts(
    metrics: Sequence[CategoryMetrics],
    sku_records: Sequence[SkuRow],
) -> List[Alert]:
    """Surface dataset gaps so the operator can fix them."""
    out: List[Alert] = []
    now = _now_iso()

    missing_dio = [m.category for m in metrics if not m.dio_days or m.dio_days <= 0]
    if missing_dio:
        out.append(Alert(
            id=_id_for("data_quality", "missing_dio"),
            alert_type="data_quality",
            severity="medium",
            target_type="dataset",
            target_id="missing_dio",
            target_name="DIO coverage",
            title=f"{len(missing_dio)} categories without DIO",
            summary=f"{len(missing_dio)} categories fell back to the 90-day default.",
            explanation=(
                "Real margin and capital-trapped numbers depend on DIO. Filling these gaps "
                "tightens every downstream metric."
            ),
            metric_name="dio_coverage",
            current_value=len(metrics) - len(missing_dio),
            threshold_value=len(metrics),
            delta_value=-len(missing_dio),
            recommended_action="Add a DIO sheet to the upload or fill the canonical lookup.",
            action_type="data_fix",
            created_at=now,
            updated_at=now,
        ))

    negative_margin_skus = [s for s in sku_records if s.gm_pct < 0]
    if negative_margin_skus:
        out.append(Alert(
            id=_id_for("data_quality", "negative_gm"),
            alert_type="data_quality",
            severity="high",
            target_type="dataset",
            target_id="negative_gm",
            target_name="Negative gross margin",
            title=f"{len(negative_margin_skus)} SKUs with negative gross margin",
            summary="Negative GM almost always points at cost or pricing data being wrong.",
            explanation=(
                "Either the costs are stale, the price list is misaligned, or these SKUs are "
                "genuinely loss-making and need urgent review."
            ),
            metric_name="negative_gm_count",
            current_value=len(negative_margin_skus),
            threshold_value=0,
            delta_value=len(negative_margin_skus),
            recommended_action="Verify cost/price for the flagged SKUs before acting on them.",
            action_type="data_fix",
            created_at=now,
            updated_at=now,
        ))

    duplicates: Dict[str, int] = {}
    for s in sku_records:
        duplicates[s.sku_id] = duplicates.get(s.sku_id, 0) + 1
    dup_keys = [k for k, v in duplicates.items() if v > 1]
    if dup_keys:
        out.append(Alert(
            id=_id_for("data_quality", "duplicate_sku"),
            alert_type="data_quality",
            severity="low",
            target_type="dataset",
            target_id="duplicate_sku",
            target_name="Duplicate SKU IDs",
            title=f"{len(dup_keys)} duplicate SKU IDs",
            summary="Same SKU ID appears in more than one row — totals may double-count.",
            explanation=(
                "Duplicates usually come from importing two periods at once, or from the same "
                "SKU being listed under different categories. Pick one canonical row."
            ),
            metric_name="duplicate_count",
            current_value=len(dup_keys),
            threshold_value=0,
            delta_value=len(dup_keys),
            recommended_action="De-duplicate the upload before re-running.",
            action_type="data_fix",
            created_at=now,
            updated_at=now,
        ))

    return out


# ─── Public API ──────────────────────────────────────────────────────────


_SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def detect_alerts(
    metrics: Sequence[CategoryMetrics],
    decisions: Sequence[Decision],
    sku_records: Sequence[SkuRow] = (),
    cfg: Optional[Config] = None,
) -> List[Alert]:
    """Run all detectors and return alerts sorted by severity then alert type."""
    alerts: List[Alert] = []
    alerts.extend(_margin_alerts(metrics, decisions))
    alerts.extend(_price_alerts(metrics, decisions))
    alerts.extend(_cost_alerts(metrics, decisions))
    alerts.extend(_working_capital_alerts(metrics))
    alerts.extend(_slow_moving_alerts(metrics, decisions))
    alerts.extend(_anchor_health_alerts(metrics, decisions))
    alerts.extend(_opportunity_alerts(metrics, decisions))
    alerts.extend(_customer_profitability_alerts(sku_records))
    alerts.extend(_supplier_alerts(sku_records))
    alerts.extend(_data_quality_alerts(metrics, sku_records))

    alerts.sort(key=lambda a: (_SEVERITY_RANK.get(a.severity, 9), a.alert_type, a.target_id))
    return alerts


def alert_summary(alerts: Sequence[Alert]) -> Dict[str, int]:
    """Counts by severity + by alert type, for the dashboard hero."""
    severity: Dict[str, int] = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    by_type: Dict[str, int] = {}
    for a in alerts:
        severity[a.severity] = severity.get(a.severity, 0) + 1
        by_type[a.alert_type] = by_type.get(a.alert_type, 0) + 1
    return {**severity, "by_type": by_type, "total": len(alerts)}
