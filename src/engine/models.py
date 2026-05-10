"""Domain models for the CFO AI decision engine.

Pydantic gives us schema validation at the loader boundary; inside the engine
we treat these as plain immutable records. Models are organized in three
groups:

  1. Inputs — `CategoryRow`, `SkuRow`, `MasterOverride` (what loaders return)
  2. Computed — `CategoryMetrics` (what the rules consume)
  3. Outputs — `Decision`, `Recommendation` (what the API and UI render)

Recommendation is a *stateful* entity: it's persisted across runs so the CFO
can approve / assign / close actions over time, and the engine reconciles new
runs against the open queue (auto-update where possible, or archive+replace).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


# ─── Inputs ──────────────────────────────────────────────────────────────


class CategoryRow(BaseModel):
    """One leaf category from the Analysis sheet (or fixture)."""

    model_config = ConfigDict(frozen=True)

    category: str
    business_unit: Optional[str] = None
    volume_tons: float
    niv_kron: float
    gm_pct: float
    dio_days: int
    dso_days: Optional[int] = None
    dpo_days: Optional[int] = None
    ccc_days: Optional[int] = None
    woca_kron: Optional[float] = None
    abs_profit_kron: Optional[float] = None  # GM after WOCA, in kRON
    real_margin_pct_stored: Optional[float] = None  # Excel-stored WOCA-corrected margin


class SkuRow(BaseModel):
    """One SKU from the YTD sheet or upload.

    `dio_days` is optional — if absent, the SKU inherits its parent
    category's DIO. `woca_kron` is also optional; when missing, the SKU is
    allocated a proportional share of the parent's WOCA based on its
    revenue share (handled in the SKU pipeline).
    """

    model_config = ConfigDict(frozen=True)

    sku_id: str
    sku_name: str
    brand: Optional[str] = None
    pack_size_g: Optional[int] = None
    category: str
    business_unit: Optional[str] = None
    supplier: Optional[str] = None
    customer: Optional[str] = None
    channel: Optional[str] = None
    volume_tons: float
    niv_kron: float
    direct_margin_kron: float = 0.0
    direct_margin_pct: float = 0.0
    gm_kron: float = 0.0
    gm_pct: float = 0.0
    dio_days: Optional[int] = None
    dso_days: Optional[int] = None
    dpo_days: Optional[int] = None
    woca_kron: Optional[float] = None  # If supplied, used directly (overrides allocation)
    avg_inventory_kron: Optional[float] = None


class MasterOverride(BaseModel):
    """Manual override for strategic SKUs/categories."""

    model_config = ConfigDict(frozen=True)

    sku_id: str  # Or category name; this is a free-form key
    strategic_flag: bool = False
    protected_until: Optional[str] = None
    override_reason: Optional[str] = None


# ─── Computed ────────────────────────────────────────────────────────────


class CategoryMetrics(BaseModel):
    """Computed per-category (or per-SKU) metrics — what the rules consume.

    Carries both the legacy fields (volume_tons / dio_days / real_margin_pct)
    that the rule engine reads, and the CFO-AI extension fields
    (capital_trapped, roic, gmroii, …) that the new product surfaces.
    """

    category: str
    business_unit: Optional[str]
    volume_tons: float
    niv_kron: float
    gm_pct: float
    dio_days: int
    ccc_days: Optional[int]
    real_margin_pct: float
    abs_profit_kron: float
    gmroii_pct: Optional[float] = None
    revenue_share_pct: float = 0.0
    profit_share_pct: float = 0.0
    dio_source: str = "category"
    real_margin_source: str = "computed_dio"
    # ── CFO AI extension fields ──────────────────────────────────────
    dso_days: Optional[int] = None
    dpo_days: Optional[int] = None
    avg_inventory_kron: Optional[float] = None
    woca_kron: Optional[float] = None
    capital_trapped_kron: Optional[float] = None
    roic_pct: Optional[float] = None
    inventory_turns: Optional[float] = None


# ─── Outputs ─────────────────────────────────────────────────────────────


class Decision(BaseModel):
    """A single classification decision for a SKU or category.

    `flag` keeps the legacy taxonomy (ANCHOR/WARNING/...). `bucket` exposes
    the CFO-facing taxonomy (PROTECT/WATCH/FIX/REDUCE/LIQUIDATE/SCALE).
    Both are emitted so existing consumers (PG, tests, n8n) keep working.
    """

    level: str  # "category" | "sku"
    id: str
    flag: str  # ANCHOR | ANCHOR_ALERT | ANCHOR_REVIEW | SCALE | KEEP | WARNING | ELIMINATE
    bucket: str = "WATCH"  # PROTECT | WATCH | FIX | REDUCE | LIQUIDATE | SCALE
    reason: Optional[str] = None
    recommendation: Optional[str] = None
    real_margin_pct: float
    volume_tons: float
    abs_profit_kron: float
    dio_days: int
    do_not_eliminate: bool = False
    capital_freed_kron: Optional[float] = None
    context: Optional[str] = None
    alert_reason: Optional[str] = None
    # ── CFO AI extensions ────────────────────────────────────────────
    capital_trapped_kron: Optional[float] = None
    roic_pct: Optional[float] = None
    gmroii_pct: Optional[float] = None
    gross_margin_pct: Optional[float] = None
    niv_kron: Optional[float] = None
    category: Optional[str] = None  # for SKU-level decisions, the parent category


# ─── Recommendation (stateful action queue) ──────────────────────────────


class RecommendationStatus(str):
    NEW = "new"
    IN_REVIEW = "in_review"
    APPROVED = "approved"
    ASSIGNED = "assigned"
    DONE = "done"
    REJECTED = "rejected"
    ARCHIVED = "archived"  # superseded by a newer recommendation


class ActionType(str):
    STOP_REORDER = "stop_reorder"
    REDUCE_REORDER_QTY = "reduce_reorder_qty"
    LIQUIDATE = "liquidate"
    RENEGOTIATE_SUPPLIER = "renegotiate_supplier"
    INCREASE_PRICE = "increase_price"
    PUSH_SALES = "push_sales"
    PROTECT_ANCHOR = "protect_anchor"
    SCALE_PURCHASING = "scale_purchasing"
    TRANSFER_STOCK = "transfer_stock"
    REVIEW_MANUALLY = "review_manually"


class Urgency(str):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class Recommendation(BaseModel):
    """A stateful action item in the CFO's queue.

    Distinct from Decision (a stateless classification). One Decision may
    spawn one Recommendation; recommendations persist across runs and
    track owner, status, and outcome.
    """

    id: Optional[int] = None  # PG auto-id; None until persisted
    target_type: str  # "sku" | "category" | "supplier" | "customer"
    target_id: str
    bucket: str  # PROTECT | WATCH | FIX | REDUCE | LIQUIDATE | SCALE
    action_type: str
    title: str
    explanation: str  # human-language reason — references the rule that fired
    expected_cash_impact_kron: Optional[float] = None
    expected_margin_impact_pct: Optional[float] = None
    urgency: str = Urgency.MEDIUM
    owner: Optional[str] = None
    status: str = RecommendationStatus.NEW
    due_date: Optional[date] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    closed_at: Optional[datetime] = None
    # When a new run reclassifies the same target, the older recommendation
    # is either updated in place (option A) or archived and superseded
    # (option B). superseded_by points at the replacement.
    superseded_by: Optional[int] = None
    # The decision_hash makes it cheap to detect "nothing changed since last run"
    decision_hash: Optional[str] = None


# Convenience: list of all six buckets (kept here so callers don't need
# to import from buckets.py if they only want the model schema).
ALL_BUCKETS: List[str] = ["PROTECT", "WATCH", "FIX", "REDUCE", "LIQUIDATE", "SCALE"]
