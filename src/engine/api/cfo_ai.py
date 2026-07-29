"""CFO AI router — endpoints for the Today / Cash / Profit / Decisions / Products screens.

Lives alongside the legacy `frontend.py` router. The legacy one stays working
until the existing inventory deployment migrates over.

All endpoints accept an `EngineOverrides` block (Settings drawer adjustments)
plus the company / SKU rows that drive the dashboard. State (recommendations,
their statuses) lives in Postgres via the storage adapter.
"""

from __future__ import annotations

from datetime import date as Date, datetime
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException

logger = logging.getLogger(__name__)
from pydantic import BaseModel, Field
from sqlalchemy.engine import Engine

from ..buckets import BUCKET_KEYS, Bucket, bucket_priority
from ..config import Config
from ..models import (
    CategoryRow,
    Recommendation,
    RecommendationStatus,
    SkuRow,
)
from ..pipeline import run_pipeline
from ..recommendations import generate_recommendations, reconcile
from ..sku_pipeline import run_sku_pipeline
from ..storage import PostgresAdapter
from .chat import SUGGESTED_PROMPTS


# ─── Request models ──────────────────────────────────────────────────────


class CompanyContext(BaseModel):
    """Tenant-level info the frontend ships back so dashboards stay neutral."""

    name: str = "Demo Company"
    industry: str = "fmcg"
    currency: str = "RON"
    cost_of_capital_pct: Optional[float] = None
    fiscal_year_start_month: int = 1


class SkuRowIn(BaseModel):
    sku_id: str
    sku_name: Optional[str] = None
    category: str
    brand: Optional[str] = None
    supplier: Optional[str] = None
    customer: Optional[str] = None
    channel: Optional[str] = None
    volume_tons: float = Field(ge=0)
    revenue_kron: float = Field(ge=0)
    cogs_kron: Optional[float] = None
    gross_margin_pct: float
    dio_days: Optional[int] = None
    dso_days: Optional[int] = None
    dpo_days: Optional[int] = None
    woca_kron: Optional[float] = None
    avg_inventory_kron: Optional[float] = None


class CategoryRowIn(BaseModel):
    """Category-level baseline. The CFO dashboard always wants both — SKU
    rows tell us what to act on, category rows hold the WOCA / DIO / CCC
    that SKU rows inherit when not provided directly.
    """

    category: str
    business_unit: Optional[str] = None
    volume_tons: float = Field(ge=0)
    niv_kron: float = Field(ge=0)
    gm_pct: float
    dio_days: int = Field(ge=0)
    dso_days: Optional[int] = None
    dpo_days: Optional[int] = None
    ccc_days: Optional[int] = None
    woca_kron: Optional[float] = None


class TodayRequest(BaseModel):
    company: CompanyContext = Field(default_factory=CompanyContext)
    skus: List[SkuRowIn] = Field(default_factory=list)
    categories: List[CategoryRowIn] = Field(default_factory=list)
    period_months: int = 12
    persist_recommendations: bool = True


class StatusUpdate(BaseModel):
    status: str
    owner: Optional[str] = None


# ─── Conversion helpers ──────────────────────────────────────────────────


def _to_sku_rows(rows: List[SkuRowIn]) -> List[SkuRow]:
    return [
        SkuRow(
            sku_id=r.sku_id,
            sku_name=r.sku_name or r.sku_id,
            category=r.category,
            brand=r.brand,
            supplier=r.supplier,
            customer=r.customer,
            channel=r.channel,
            volume_tons=r.volume_tons,
            niv_kron=r.revenue_kron,
            gm_pct=r.gross_margin_pct,
            dio_days=r.dio_days,
            dso_days=r.dso_days,
            dpo_days=r.dpo_days,
            woca_kron=r.woca_kron,
            avg_inventory_kron=r.avg_inventory_kron,
        )
        for r in rows
    ]


def _to_cat_rows(rows: List[CategoryRowIn]) -> List[CategoryRow]:
    return [
        CategoryRow(
            category=r.category,
            business_unit=r.business_unit,
            volume_tons=r.volume_tons,
            niv_kron=r.niv_kron,
            gm_pct=r.gm_pct,
            dio_days=r.dio_days,
            dso_days=r.dso_days,
            dpo_days=r.dpo_days,
            ccc_days=r.ccc_days,
            woca_kron=r.woca_kron,
        )
        for r in rows
    ]


def _company_block(ctx: CompanyContext, cfg: Config) -> Dict[str, Any]:
    return {
        "name": ctx.name,
        "industry": ctx.industry,
        "currency": ctx.currency,
        "cost_of_capital": ctx.cost_of_capital_pct or cfg.cost_of_capital_pct,
    }


# ─── Router factory ──────────────────────────────────────────────────────


def create_cfo_router(
    cfg: Config,
    adapter: Optional[PostgresAdapter] = None,
) -> APIRouter:
    """Build the CFO AI router.

    The adapter is optional — endpoints that need persisted state (decisions,
    recommendations) raise 503 if it isn't supplied. Useful for static demo
    deployments that don't run a database.
    """
    router = APIRouter(prefix="/api/cfo", tags=["cfo-ai"])

    def _need_adapter() -> PostgresAdapter:
        if adapter is None:
            raise HTTPException(503, "Database adapter not configured")
        return adapter

    # ── Today ───────────────────────────────────────────────────────────

    @router.post("/today")
    def today(req: TodayRequest) -> Dict[str, Any]:
        skus = _to_sku_rows(req.skus)
        cats = _to_cat_rows(req.categories)

        # Run BOTH SKU-level (the new default) and category-level (so we have
        # capital-trapped totals at category granularity for the bridge view).
        cat_metrics, cat_decisions = run_pipeline(cats, cfg, req.period_months)
        sku_metrics, sku_decisions = run_sku_pipeline(skus, cats, cfg, req.period_months)

        # Recommendations from SKU-level decisions
        fresh_recs = generate_recommendations(sku_decisions, cfg)

        if req.persist_recommendations and adapter is not None:
            existing = adapter.list_recommendations(limit=1000)
            inserts, updates, archives = reconcile(fresh_recs, existing)
            for rec in inserts:
                adapter.upsert_recommendation(rec)
            for rec in updates:
                adapter.upsert_recommendation(rec)
            for rec in archives:
                adapter.upsert_recommendation(rec)
            persisted = adapter.list_recommendations(
                status=RecommendationStatus.NEW, limit=20
            )
        else:
            persisted = fresh_recs[:20]

        # Aggregate financials
        total_capital_trapped = sum(
            (m.capital_trapped_kron or 0.0) for m in cat_metrics
        )
        cash_recovery_potential = sum(
            (d.capital_freed_kron or 0.0)
            for d in sku_decisions
            if d.bucket in ("LIQUIDATE", "REDUCE")
        )
        total_niv = sum(m.niv_kron for m in cat_metrics) or 1.0
        weighted_real_margin = (
            sum(m.real_margin_pct * m.niv_kron for m in cat_metrics) / total_niv
        )
        total_abs_profit = sum(m.abs_profit_kron for m in cat_metrics)
        portfolio_roic = (
            (total_abs_profit / total_capital_trapped * 100.0)
            if total_capital_trapped > 0
            else 0.0
        )

        bucket_counts: Dict[str, int] = {key: 0 for key in BUCKET_KEYS.values()}
        for d in sku_decisions:
            bkey = BUCKET_KEYS.get(Bucket(d.bucket), "watch")
            bucket_counts[bkey] += 1

        # Top actions: highest urgency first, then bucket priority
        top_actions = sorted(
            persisted,
            key=lambda r: (
                {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(r.urgency, 4),
                bucket_priority(Bucket(r.bucket)),
            ),
        )[:5]

        return {
            "company": _company_block(req.company, cfg),
            "executive_summary": {
                "cash_trapped_kron": round(total_capital_trapped, 2),
                "cash_recovery_potential_kron": round(cash_recovery_potential, 2),
                "roic_pct": round(portfolio_roic, 2),
                "real_margin_pct": round(weighted_real_margin, 2),
                "products_analyzed": len(sku_decisions),
                "categories_analyzed": len(cat_decisions),
                "urgent_actions": bucket_counts.get("liquidate", 0)
                + bucket_counts.get("fix", 0),
                "bucket_counts": bucket_counts,
            },
            "briefing": _build_briefing(
                cat_decisions, sku_decisions, bucket_counts,
                total_capital_trapped, cash_recovery_potential,
                weighted_real_margin, req.company.name,
            ),
            "top_actions": [_rec_to_dict(r) for r in top_actions],
            "run_at": datetime.utcnow().isoformat(),
        }

    # ── Cash ────────────────────────────────────────────────────────────

    @router.post("/cash")
    def cash(req: TodayRequest) -> Dict[str, Any]:
        cats = _to_cat_rows(req.categories)
        skus = _to_sku_rows(req.skus)
        cat_metrics, cat_decisions = run_pipeline(cats, cfg, req.period_months)
        sku_metrics, sku_decisions = run_sku_pipeline(skus, cats, cfg, req.period_months)

        capital_by_category = sorted(
            [
                {
                    "category": m.category,
                    "capital_trapped_kron": round(m.capital_trapped_kron or 0.0, 2),
                    "dio_days": m.dio_days,
                    "ccc_days": m.ccc_days,
                    "real_margin_pct": round(m.real_margin_pct, 2),
                    "niv_kron": round(m.niv_kron, 2),
                }
                for m in cat_metrics
            ],
            key=lambda x: x["capital_trapped_kron"],
            reverse=True,
        )

        dead_stock = [
            {
                "id": d.id,
                "category": d.category,
                "capital_trapped_kron": round(d.capital_trapped_kron or 0.0, 2),
                "dio_days": d.dio_days,
                "real_margin_pct": d.real_margin_pct,
                "bucket": d.bucket,
            }
            for d in sku_decisions
            if d.bucket == "LIQUIDATE"
        ][:50]

        slow_moving = [
            {
                "id": d.id,
                "category": d.category,
                "capital_trapped_kron": round(d.capital_trapped_kron or 0.0, 2),
                "dio_days": d.dio_days,
                "real_margin_pct": d.real_margin_pct,
                "bucket": d.bucket,
            }
            for d in sku_decisions
            if d.bucket == "REDUCE"
        ][:50]

        recoverable = [
            {
                "id": d.id,
                "category": d.category,
                "freed_kron": round(d.capital_freed_kron or 0.0, 2),
                "bucket": d.bucket,
            }
            for d in sku_decisions
            if d.capital_freed_kron and d.capital_freed_kron > 0
        ]
        recoverable.sort(key=lambda x: x["freed_kron"], reverse=True)

        # Working capital bridge (kRON breakdown)
        total_inventory = sum(m.avg_inventory_kron or 0.0 for m in cat_metrics)
        total_capital = sum(m.capital_trapped_kron or 0.0 for m in cat_metrics)
        total_recoverable = sum(d.capital_freed_kron or 0.0 for d in sku_decisions
                                if d.bucket in ("LIQUIDATE", "REDUCE"))

        return {
            "company": _company_block(req.company, cfg),
            "working_capital_bridge": {
                "inventory_kron": round(total_inventory, 2),
                "total_capital_trapped_kron": round(total_capital, 2),
                "recoverable_kron": round(total_recoverable, 2),
            },
            "capital_by_category": capital_by_category,
            "dead_stock": dead_stock,
            "slow_moving": slow_moving,
            "recoverable": recoverable[:50],
        }

    # ── Profit ──────────────────────────────────────────────────────────

    @router.post("/profit")
    def profit(req: TodayRequest) -> Dict[str, Any]:
        cats = _to_cat_rows(req.categories)
        cat_metrics, cat_decisions = run_pipeline(cats, cfg, req.period_months)

        # Margin comparison: gross vs real
        margin_comparison = sorted(
            [
                {
                    "category": m.category,
                    "gross_margin_pct": round(m.gm_pct, 2),
                    "real_margin_pct": round(m.real_margin_pct, 2),
                    "margin_leak_pp": round(m.gm_pct - m.real_margin_pct, 2),
                    "niv_kron": round(m.niv_kron, 2),
                    "dio_days": m.dio_days,
                }
                for m in cat_metrics
            ],
            key=lambda x: x["margin_leak_pp"],
            reverse=True,
        )

        roic_ranking = sorted(
            [
                {
                    "category": m.category,
                    "roic_pct": round(m.roic_pct or 0.0, 2),
                    "abs_profit_kron": round(m.abs_profit_kron, 2),
                }
                for m in cat_metrics
            ],
            key=lambda x: x["roic_pct"],
            reverse=True,
        )

        gmroii_ranking = sorted(
            [
                {
                    "category": m.category,
                    "gmroii_pct": round(m.gmroii_pct or 0.0, 2),
                    "inventory_turns": (
                        round(m.inventory_turns, 2) if m.inventory_turns else None
                    ),
                }
                for m in cat_metrics
            ],
            key=lambda x: x["gmroii_pct"],
            reverse=True,
        )

        total_niv = sum(m.niv_kron for m in cat_metrics) or 1.0
        weighted_gross = sum(m.gm_pct * m.niv_kron for m in cat_metrics) / total_niv
        weighted_real = (
            sum(m.real_margin_pct * m.niv_kron for m in cat_metrics) / total_niv
        )

        return {
            "company": _company_block(req.company, cfg),
            "portfolio": {
                "weighted_gross_margin_pct": round(weighted_gross, 2),
                "weighted_real_margin_pct": round(weighted_real, 2),
                "margin_leak_pp": round(weighted_gross - weighted_real, 2),
                "cost_of_capital_pct": cfg.cost_of_capital_pct,
            },
            "margin_comparison": margin_comparison,
            "roic_ranking": roic_ranking,
            "gmroii_ranking": gmroii_ranking,
        }

    # ── Decisions queue ─────────────────────────────────────────────────

    @router.get("/decisions")
    def list_decisions(
        status: Optional[str] = None,
        bucket: Optional[str] = None,
        limit: int = 200,
    ) -> Dict[str, Any]:
        a = _need_adapter()
        recs = a.list_recommendations(status=status, bucket=bucket, limit=limit)
        return {
            "count": len(recs),
            "recommendations": [_rec_to_dict(r) for r in recs],
        }

    @router.post("/decisions/{rec_id}/status")
    def set_decision_status(rec_id: int, body: StatusUpdate) -> Dict[str, Any]:
        a = _need_adapter()
        valid = {"new", "in_review", "approved", "assigned",
                 "done", "rejected", "archived"}
        if body.status not in valid:
            raise HTTPException(400, f"status must be one of {sorted(valid)}")
        updated = a.update_recommendation_status(rec_id, body.status, body.owner)
        if updated is None:
            raise HTTPException(404, f"Recommendation {rec_id} not found")
        return _rec_to_dict(updated)

    # ── Products explorer ───────────────────────────────────────────────

    # ── Chat ────────────────────────────────────────────────────────────

    @router.get("/chat/prompts")
    def chat_prompts() -> Dict[str, Any]:
        """Suggested starter prompts for the empty-state chat surface."""
        return {"groups": SUGGESTED_PROMPTS}

    # `POST /chat` (structured intent-block chat, backed by chat.py's
    # deterministic responder) was removed 2026-07-24 — `cfoApi.chat` was
    # defined in the frontend but never actually called anywhere. Ask CFO AI
    # (the workspace chat tab) never used this path either. See root
    # CLAUDE.md "Backend cleanup" for the audit that found it.

    # Conversational chat (Claude Opus 4.7) used to live here as
    # `POST /chat/llm`. Removed 2026-07-24 (Milestone D) — the FE now calls
    # `supabase/functions/chat-llm/` directly (Anthropic call + system-prompt
    # building + the same Pricing V3 cap RPCs), so this route was a pure
    # duplicate nothing called anymore. See root CLAUDE.md "Milestone D".

    # ── Exports ─────────────────────────────────────────────────────────

    @router.post("/exports/board-summary")
    def export_board_summary(req: TodayRequest) -> Dict[str, Any]:
        """One-page executive memo, Markdown.

        Frontend can post this to /chat with question='Create board summary'
        for the structured-block version, or hit this endpoint when it
        wants a paste-ready document for email / docs.
        """
        cats = _to_cat_rows(req.categories)
        skus = _to_sku_rows(req.skus)
        cat_metrics, cat_decisions = run_pipeline(cats, cfg, req.period_months)
        sku_metrics, sku_decisions = run_sku_pipeline(skus, cats, cfg, req.period_months)

        decisions = sku_decisions or cat_decisions
        total_capital = sum((m.capital_trapped_kron or 0.0) for m in cat_metrics)
        cash_recovery = sum(
            (d.capital_freed_kron or 0.0)
            for d in decisions
            if d.bucket in ("LIQUIDATE", "REDUCE")
        )
        total_niv = sum(m.niv_kron for m in cat_metrics) or 1.0
        weighted_real_margin = (
            sum(m.real_margin_pct * m.niv_kron for m in cat_metrics) / total_niv
        )
        total_abs_profit = sum(m.abs_profit_kron for m in cat_metrics)
        portfolio_roic = (
            (total_abs_profit / total_capital * 100.0) if total_capital > 0 else 0.0
        )
        bucket_counts: Dict[str, int] = {key: 0 for key in BUCKET_KEYS.values()}
        for d in decisions:
            bucket_counts[BUCKET_KEYS.get(Bucket(d.bucket), "watch")] += 1

        md = _board_summary_markdown(
            company=req.company.name,
            cash_trapped_keur=total_capital,
            cash_recovery_keur=cash_recovery,
            roic_pct=portfolio_roic,
            real_margin_pct=weighted_real_margin,
            cost_of_capital_pct=cfg.cost_of_capital_pct,
            bucket_counts=bucket_counts,
            decisions=decisions,
        )
        return {"markdown": md, "format": "markdown"}

    @router.post("/exports/action-list")
    def export_action_list(req: TodayRequest) -> Dict[str, Any]:
        """Action list as CSV (for paste-into-spreadsheet workflows)."""
        cats = _to_cat_rows(req.categories)
        skus = _to_sku_rows(req.skus)
        sku_metrics, sku_decisions = run_sku_pipeline(skus, cats, cfg, req.period_months)
        decisions = sku_decisions or run_pipeline(cats, cfg, req.period_months)[1]
        recs = generate_recommendations(decisions, cfg)
        csv_text = _action_list_csv(recs)
        return {"csv": csv_text, "format": "csv", "row_count": len(recs)}

    @router.post("/products")
    def products(req: TodayRequest) -> Dict[str, Any]:
        cats = _to_cat_rows(req.categories)
        skus = _to_sku_rows(req.skus)
        sku_metrics, sku_decisions = run_sku_pipeline(skus, cats, cfg, req.period_months)

        rows = [
            {
                "id": d.id,
                "category": d.category,
                "bucket": d.bucket,
                "real_margin_pct": d.real_margin_pct,
                "gross_margin_pct": d.gross_margin_pct,
                "volume_tons": d.volume_tons,
                "niv_kron": d.niv_kron,
                "abs_profit_kron": d.abs_profit_kron,
                "dio_days": d.dio_days,
                "ccc_days": next(
                    (m.ccc_days for m in sku_metrics if m.category == d.id),
                    None,
                ),
                "capital_trapped_kron": d.capital_trapped_kron,
                "roic_pct": d.roic_pct,
                "gmroii_pct": d.gmroii_pct,
                "reason": d.reason,
                "recommendation": d.recommendation,
            }
            for d in sku_decisions
        ]
        return {"company": _company_block(req.company, cfg), "rows": rows}

    return router


# ─── Briefing assembler (deterministic; AI flavor is layered separately) ─


def _build_briefing(
    cat_decisions: list,
    sku_decisions: list,
    bucket_counts: Dict[str, int],
    cash_trapped: float,
    cash_recovery: float,
    real_margin: float,
    company_name: str,
) -> Dict[str, Any]:
    """Plain-prose CFO briefing. The AI-flavored version layers on top."""
    fix_count = bucket_counts.get("fix", 0)
    liquidate_count = bucket_counts.get("liquidate", 0)
    reduce_count = bucket_counts.get("reduce", 0)
    scale_count = bucket_counts.get("scale", 0)

    cash_trapped_m = cash_trapped / 1000.0  # kRON → MRON for prose
    headline = (
        f"Inventory ties up {cash_trapped_m:,.1f}M; "
        f"{cash_recovery / 1000.0:,.1f}M recoverable on today's rules."
    )

    parts: List[str] = []
    if real_margin > 0:
        parts.append(
            f"Portfolio real margin sits at {real_margin:.1f}% after "
            f"working-capital cost."
        )
    else:
        parts.append(
            f"Portfolio real margin is {real_margin:.1f}% — the working-capital "
            f"cost is eating the gross margin."
        )
    if liquidate_count:
        parts.append(
            f"{liquidate_count} product{'s' if liquidate_count != 1 else ''} "
            f"flagged to liquidate."
        )
    if reduce_count:
        parts.append(
            f"{reduce_count} product{'s' if reduce_count != 1 else ''} "
            f"flagged to throttle reorder."
        )
    if fix_count:
        parts.append(
            f"{fix_count} renegotiation{'s' if fix_count != 1 else ''} "
            f"or repricing action{'s' if fix_count != 1 else ''} queued."
        )
    if scale_count:
        parts.append(
            f"{scale_count} candidate{'s' if scale_count != 1 else ''} for more capital."
        )

    return {
        "headline": headline,
        "body": " ".join(parts) or "Portfolio is steady — nothing urgent today.",
    }


def _rec_to_dict(r: Recommendation) -> Dict[str, Any]:
    return {
        "id": r.id,
        "target_type": r.target_type,
        "target_id": r.target_id,
        "bucket": r.bucket,
        "action_type": r.action_type,
        "title": r.title,
        "explanation": r.explanation,
        "expected_cash_impact_kron": r.expected_cash_impact_kron,
        "expected_margin_impact_pct": r.expected_margin_impact_pct,
        "urgency": r.urgency,
        "owner": r.owner,
        "status": r.status,
        "due_date": r.due_date.isoformat() if r.due_date else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


# ─── Export helpers ──────────────────────────────────────────────────────


def _board_summary_markdown(
    company: str,
    cash_trapped_keur: float,
    cash_recovery_keur: float,
    roic_pct: float,
    real_margin_pct: float,
    cost_of_capital_pct: float,
    bucket_counts: Dict[str, int],
    decisions: List[Any],
) -> str:
    """One-page executive memo, paste-ready Markdown."""
    spread = roic_pct - cost_of_capital_pct
    lines: List[str] = []
    lines.append(f"# {company} — CFO AI Board Summary")
    lines.append("")
    lines.append("## Headline")
    lines.append(
        f"Working capital sits at **{cash_trapped_keur / 1000:.1f}M EUR**. "
        f"**{cash_recovery_keur / 1000:.1f}M EUR** is recoverable in 30–60 days "
        f"under current rules."
    )
    lines.append("")
    lines.append("## Portfolio at a glance")
    lines.append(f"- Working capital trapped: **{cash_trapped_keur / 1000:.1f}M EUR**")
    lines.append(f"- ROIC: **{roic_pct:.1f}%** vs cost of capital {cost_of_capital_pct:.1f}% → spread {spread:.1f}pp")
    lines.append(f"- Real margin (weighted): **{real_margin_pct:.1f}%**")
    lines.append(
        f"- Decision queue: "
        f"Protect {bucket_counts.get('protect', 0)} · "
        f"Watch {bucket_counts.get('watch', 0)} · "
        f"Fix {bucket_counts.get('fix', 0)} · "
        f"Reduce {bucket_counts.get('reduce', 0)} · "
        f"Liquidate {bucket_counts.get('liquidate', 0)} · "
        f"Scale {bucket_counts.get('scale', 0)}"
    )
    lines.append("")
    lines.append("## Operating priorities (next 30 days)")
    liq = [d for d in decisions if d.bucket == "LIQUIDATE"][:5]
    fix = [d for d in decisions if d.bucket == "FIX"][:5]
    if liq:
        lines.append(f"1. **Liquidate** — exit {len(liq)} bleeding-margin SKUs:")
        for d in liq:
            lines.append(
                f"   - {d.id} (real margin {d.real_margin_pct:.1f}%, "
                f"DIO {d.dio_days}d)"
            )
    if fix:
        lines.append(f"2. **Renegotiate** — open conversations with suppliers on:")
        for d in fix:
            lines.append(
                f"   - {d.id} (real margin {d.real_margin_pct:.1f}%, "
                f"volume {d.volume_tons:.0f}t)"
            )
    lines.append(
        f"3. **Hold** {bucket_counts.get('protect', 0)} anchor categories — "
        f"these absorb fixed costs."
    )
    if bucket_counts.get("scale", 0):
        lines.append(
            f"4. **Scale** — {bucket_counts['scale']} candidate"
            f"{'s' if bucket_counts['scale'] != 1 else ''} earning above cost "
            f"of capital with room for more inventory."
        )
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("Generated by CFO AI · grounded in the engine's deterministic rules and current dataset.")
    return "\n".join(lines)


def _action_list_csv(recommendations: List[Recommendation]) -> str:
    """Flat CSV of the recommendation queue. Streaming-safe size."""
    headers = [
        "id",
        "target_type",
        "target_id",
        "bucket",
        "action_type",
        "title",
        "urgency",
        "expected_cash_impact_keur",
        "expected_margin_impact_pp",
        "owner",
        "status",
        "due_date",
    ]
    rows: List[str] = [",".join(headers)]
    for r in recommendations:
        row = [
            str(r.id or ""),
            r.target_type,
            _csv_escape(r.target_id),
            r.bucket,
            r.action_type,
            _csv_escape(r.title),
            r.urgency,
            f"{r.expected_cash_impact_kron:.2f}" if r.expected_cash_impact_kron is not None else "",
            f"{r.expected_margin_impact_pct:.2f}" if r.expected_margin_impact_pct is not None else "",
            r.owner or "",
            r.status,
            r.due_date.isoformat() if r.due_date else "",
        ]
        rows.append(",".join(row))
    return "\n".join(rows) + "\n"


def _csv_escape(s: str) -> str:
    """Minimal CSV escape — wrap in quotes if comma/quote/newline present."""
    if any(c in s for c in [",", '"', "\n", "\r"]):
        return '"' + s.replace('"', '""') + '"'
    return s


# The system-prompt builders that used to live here (_build_currency_directive,
# _build_public_company_directive, _build_chat_system_prompt,
# _build_workspace_chat_system_prompt) were removed 2026-07-24 (Milestone D)
# along with the /chat/llm route above — ported to
# supabase/functions/chat-llm/index.ts, which is what the FE actually calls
# now. See root CLAUDE.md "Milestone D" for the full rationale.
