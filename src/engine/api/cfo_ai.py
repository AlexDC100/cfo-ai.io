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

from fastapi import APIRouter, Depends, Header, HTTPException

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
from .chat import (
    SUGGESTED_PROMPTS,
    build_context,
    respond as chat_respond,
)


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


class ChatRequest(BaseModel):
    """Chat turn — frontend posts the question + the per-page data context.

    The data shape is the same one /api/cfo/today returns: SKU + category rows
    plus the company context. The endpoint re-runs the pipeline so the answer
    is always grounded in the freshly-computed engine output.
    """
    question: str = Field(..., min_length=1, max_length=2000)
    company: CompanyContext = Field(default_factory=CompanyContext)
    skus: List[SkuRowIn] = Field(default_factory=list)
    categories: List[CategoryRowIn] = Field(default_factory=list)
    period_months: int = 12
    page: str = "Today"


class LlmChatMessage(BaseModel):
    """One turn of the multi-turn conversation. Mirrors Anthropic's shape so
    we can pass these straight through to messages.create()."""
    role: str  # "user" | "assistant"
    content: str


class LlmFxContext(BaseModel):
    """CUR-FIX — FX context the FE sends with every chat turn so the
    system prompt can instruct Claude to cite figures in the user's
    chosen display currency. Without these fields the model defaulted
    to the source currency it saw in ``dataset_summary`` — which was
    wrong any time the user toggled the TopHeader currency away from
    the period's native currency (always RON for Romanian uploads).

    Optional for back-compat: pre-CUR-FIX clients don't send the block
    and the prompt builder falls back to the source-currency default.
    """
    source_currency: str = "RON"
    display_currency: str = "RON"
    rate: float = 1.0           # 1 source_currency = `rate` display_currency
    rate_date: Optional[str] = None
    provider: Optional[str] = None


class LlmPublicCompanyContext(BaseModel):
    """NASDAQ-13 — public-company context the FE sends when the user
    has a Nasdaq ticker open on /public-companies and asks CFO AI a
    question. Lets the model ground answers in the selected company's
    headline figures without the operator having to paste them in.

    The FE looks up the ticker from the public-company snapshot it
    already has loaded (no extra HTTP needed) and bundles the headline
    + market_metrics + a few derived ratios. The backend turns this
    into a system-prompt block so Claude can cite figures like "AAPL
    FY2024 revenue of $391B (Sharadar SF1)" without inventing them.

    All fields optional — pre-NASDAQ-13 clients omit the block and the
    chat falls back to its normal workspace persona.
    """
    ticker: str
    company_name: Optional[str] = None
    sector: Optional[str] = None
    industry: Optional[str] = None
    exchange: Optional[str] = None
    currency: Optional[str] = "USD"
    latest_period: Optional[str] = None        # "FY2024" / "Q4 2024"
    latest_period_end: Optional[str] = None    # YYYY-MM-DD
    # Headline (raw USD)
    revenue: Optional[float] = None
    ebitda: Optional[float] = None
    net_income: Optional[float] = None
    total_assets: Optional[float] = None
    total_equity: Optional[float] = None
    cash: Optional[float] = None
    net_debt: Optional[float] = None
    free_cash_flow: Optional[float] = None
    # Market
    market_cap: Optional[float] = None
    enterprise_value: Optional[float] = None
    pe_ratio: Optional[float] = None
    ev_to_ebitda: Optional[float] = None
    # Ratios (% points where applicable)
    ebitda_margin: Optional[float] = None
    net_margin: Optional[float] = None
    roe: Optional[float] = None
    net_debt_to_ebitda: Optional[float] = None
    source: Optional[str] = None               # "nasdaq" | "demo"


class LlmChatRequest(BaseModel):
    """Conversational chat turn driven by Claude Opus 4.7.

    Frontend ships the full message history each turn (the API is stateless),
    plus an optional `dataset_summary` snapshot so the model is grounded in
    the operator's current portfolio. When ANTHROPIC_API_KEY isn't set the
    endpoint returns a friendly fallback so the UI never breaks.

    `mode` selects the system-prompt persona:
      · "inventory" (default) — the SKU/inventory-CFO persona used by the
        existing chat-copilot drawer; "kEUR / DIO / CCC" vocabulary.
      · "workspace" — the universal Ask-CFO-AI tab persona. Open-domain
        assistant (finance, strategy, industry, the app, general
        knowledge) that grounds company-specific answers in the active
        period's workspace context and never fabricates the user's own
        figures. Picks up dataset_summary as the workspace snapshot.

    `display_currency` + `fx_context` — CUR-FIX. When provided, the
    system prompt instructs Claude to cite figures in the user's
    chosen display currency (and note the conversion when display ≠
    source). Optional for back-compat — pre-CUR-FIX clients still work.

    `public_company` — NASDAQ-13. Optional public-company context block
    sent when the user has a Nasdaq ticker selected on /public-companies.
    Lets Claude cite live SF1 figures for that ticker without the user
    pasting them in.
    """
    messages: List[LlmChatMessage] = Field(..., min_length=1, max_length=200)
    dataset_summary: Optional[str] = None
    page: str = "Today"
    company_name: str = "Demo workspace"
    mode: Optional[str] = None  # "inventory" (default) | "workspace"
    display_currency: Optional[str] = None
    fx_context: Optional[LlmFxContext] = None
    public_company: Optional[LlmPublicCompanyContext] = None


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

    @router.post("/chat")
    def chat(req: ChatRequest) -> Dict[str, Any]:
        """One chat turn: pipeline runs, responder maps question → blocks."""
        skus = _to_sku_rows(req.skus)
        cats = _to_cat_rows(req.categories)

        cat_metrics, cat_decisions = run_pipeline(cats, cfg, req.period_months)
        sku_metrics, sku_decisions = run_sku_pipeline(skus, cats, cfg, req.period_months)

        # Same executive summary shape used by /today, in kEUR (post-FX).
        # If sku_decisions is empty (no SKU upload), fall back to category
        # decisions so chat still works against the seed-style category data.
        decisions_for_chat = sku_decisions or cat_decisions
        metrics_for_chat   = sku_metrics or cat_metrics

        total_capital_trapped = sum(
            (m.capital_trapped_kron or 0.0) for m in cat_metrics
        )
        cash_recovery_potential = sum(
            (d.capital_freed_kron or 0.0)
            for d in decisions_for_chat
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
        for d in decisions_for_chat:
            bkey = BUCKET_KEYS.get(Bucket(d.bucket), "watch")
            bucket_counts[bkey] += 1

        summary = {
            "cash_trapped_kron": round(total_capital_trapped, 2),
            "cash_recovery_potential_kron": round(cash_recovery_potential, 2),
            "roic_pct": round(portfolio_roic, 2),
            "real_margin_pct": round(weighted_real_margin, 2),
            "products_analyzed": len(decisions_for_chat),
            "categories_analyzed": len(cat_decisions),
            "urgent_actions": bucket_counts.get("liquidate", 0) + bucket_counts.get("fix", 0),
            "bucket_counts": bucket_counts,
        }

        recs = generate_recommendations(decisions_for_chat, cfg)
        ctx = build_context(
            metrics=metrics_for_chat,
            decisions=decisions_for_chat,
            recommendations=recs,
            summary=summary,
            cfg=cfg,
            company_name=req.company.name,
            page=req.page,
        )
        answer = chat_respond(req.question, ctx)
        return {
            "answer": answer.to_dict(),
            "context": {
                "page": req.page,
                "company": req.company.name,
                "summary": summary,
            },
        }

    # ── Conversational chat (Claude Opus 4.7) ──────────────────────────
    #
    # Distinct from /chat (above) which returns structured intent blocks.
    # /chat/llm runs an open-ended Claude conversation — the operator gets
    # ChatGPT-style responses grounded in their portfolio, with full
    # multi-turn history. Falls back gracefully when ANTHROPIC_API_KEY is
    # absent so the UI never shows "I track 0 categories" stubs.

    @router.post("/chat/llm")
    def chat_llm(
        req: LlmChatRequest,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        import os
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            return {
                "answer": (
                    "Conversational AI isn't configured on this build — "
                    "ANTHROPIC_API_KEY is missing. Set it in the backend "
                    "environment to chat with Claude Opus 4.7."
                ),
                "model": None,
                "usage": None,
            }

        # Pricing V3 — atomic chat-cap reservation BEFORE the Opus call.
        # When `Authorization: Bearer …` is missing the call still runs
        # (legacy callers don't auth this endpoint). When a JWT is
        # present we resolve the user and apply daily+monthly caps via
        # `_usage_gate.reserve_chat`. The reservation is committed on
        # success (Opus returned a response) or released on exception
        # (gap D, optional for chat — same principle as documents).
        # No-op while USAGE_LIMITS_ENABLED is unset.
        _v3_user_id: Optional[str] = None
        if authorization and authorization.lower().startswith("bearer "):
            from . import _usage_gate as _ug, _supabase as _sb
            jwt = authorization.split(" ", 1)[1].strip()
            try:
                with _sb.per_user(jwt) as _c:
                    user = _c.get_user(jwt)
                _v3_user_id = (user or {}).get("id") if user else None
            except Exception:  # noqa: BLE001
                _v3_user_id = None
            if _v3_user_id:
                decision = _ug.reserve_chat(_v3_user_id)
                if decision.kind not in ("allowed", "disabled"):
                    raise HTTPException(
                        status_code=429,
                        detail={
                            "code": "chat_cap_reached",
                            "kind": decision.kind,
                            "plan_key": decision.plan_key,
                            "daily_used": decision.daily_used,
                            "daily_cap": decision.daily_cap,
                            "monthly_used": decision.monthly_used,
                            "monthly_cap": decision.monthly_cap,
                            "message": decision.message,
                            "upgrade_url": "/pricing",
                        },
                    )

        try:
            from anthropic import Anthropic
        except ImportError:
            return {"answer": "anthropic SDK is not installed.", "model": None, "usage": None}

        # max_retries=5 covers transient Opus 529 overloads.
        client = Anthropic(api_key=key, max_retries=5, timeout=120.0)

        # System prompt — persona + grounding. Cached so the per-turn cost
        # is dominated by the user's question, not the system instructions.
        # `mode="workspace"` selects the universal Ask-CFO-AI persona used
        # by the /chat tab; default is the inventory-CFO persona used by
        # the legacy chat-copilot drawer.
        if (req.mode or "").strip().lower() == "workspace":
            system_text = _build_workspace_chat_system_prompt(
                page=req.page,
                company_name=req.company_name,
                dataset_summary=req.dataset_summary,
                display_currency=req.display_currency,
                fx_context=req.fx_context,
                public_company=req.public_company,
            )
        else:
            system_text = _build_chat_system_prompt(
                page=req.page,
                company_name=req.company_name,
                dataset_summary=req.dataset_summary,
                display_currency=req.display_currency,
                fx_context=req.fx_context,
                public_company=req.public_company,
            )

        try:
            resp = client.messages.create(
                model="claude-opus-4-7",
                max_tokens=2000,
                system=[
                    {
                        "type": "text",
                        "text": system_text,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                messages=[
                    {"role": m.role, "content": m.content} for m in req.messages
                ],
                output_config={"effort": "high"},
            )
        except Exception as e:  # noqa: BLE001
            # Pricing V3 gap D — Opus errored. Release the reservation
            # so this failed call doesn't count toward the user's caps.
            if _v3_user_id:
                from . import _usage_gate as _ug
                try:
                    _ug.release_chat(_v3_user_id)
                except Exception:
                    logger.exception("[chat] release_chat failed")
            return {
                "answer": f"Couldn't reach Claude: {e}. Try again in a moment.",
                "model": "claude-opus-4-7",
                "usage": None,
            }

        text = "".join(
            getattr(b, "text", "") for b in resp.content if getattr(b, "type", None) == "text"
        ).strip()

        # Pricing V3 gap D — Opus returned cleanly. Commit the
        # reservation now: this turn counts toward the user's caps.
        if _v3_user_id:
            from . import _usage_gate as _ug
            try:
                _ug.commit_chat(_v3_user_id)
            except Exception:
                logger.exception("[chat] commit_chat failed")

        return {
            "answer": text,
            "model": resp.model,
            "usage": {
                "input_tokens": resp.usage.input_tokens,
                "output_tokens": resp.usage.output_tokens,
                "cache_read_input_tokens": getattr(resp.usage, "cache_read_input_tokens", 0),
                "cache_creation_input_tokens": getattr(resp.usage, "cache_creation_input_tokens", 0),
            },
        }

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


def _build_currency_directive(
    *,
    display_currency: Optional[str],
    fx_context: Optional["LlmFxContext"],
) -> str:
    """CUR-FIX — synthesize the system-prompt block that tells Claude
    which currency to cite figures in.

    The FE owns the user's display preference (TopHeader RON/EUR/USD
    toggle) and computes the FX rate against the workspace's source
    currency (always RON for the current SME pack). It posts both to
    the chat API; this helper turns them into a one-paragraph
    directive injected at the bottom of the system prompt — after the
    persona but before the grounding snapshot, so the model treats it
    as a rendering rule rather than a topic.

    Returns an empty string when no display preference is provided
    (pre-CUR-FIX clients), so the existing prompts render unchanged
    and remain cache-eligible.
    """
    if not display_currency and not fx_context:
        return ""

    if fx_context is not None:
        source = (fx_context.source_currency or "RON").upper()
        display = (fx_context.display_currency or display_currency or source).upper()
        rate = fx_context.rate if fx_context.rate else 1.0
        rate_date = fx_context.rate_date or "today"
        provider = fx_context.provider or "BNR"
    else:
        source = "RON"
        display = (display_currency or "RON").upper()
        rate = 1.0
        rate_date = "today"
        provider = "BNR"

    # Same currency on both sides → no conversion math needed; just tell
    # the model the active surface so prose like "in EUR" or "in RON"
    # matches what the user sees on screen.
    if source == display:
        return (
            "\n\n=== Display-currency rule ===\n"
            f"The user is viewing this workspace in {display}. The underlying "
            f"data is also stored in {display}, so cite money figures in "
            f"{display} directly — no conversion needed.\n"
            "Ratios, multiples, days, counts, and percentages stay as-is "
            "regardless of currency.\n"
            "=== End rule ===\n"
        )

    return (
        "\n\n=== Display-currency rule ===\n"
        f"The user is viewing this workspace in {display}. The underlying "
        f"snapshot below is stored in {source}.\n"
        f"Reference FX rate: 1 {source} = {rate:.4f} {display} "
        f"(source: {provider}, {rate_date}).\n"
        "When you cite money figures from the snapshot:\n"
        f"  · Show the value in {display} as the primary unit.\n"
        f"  · For non-trivial conversions, note the source briefly, e.g. "
        f"\"~{display} 918k (converted from {source} 4.58M at {provider} rate)\".\n"
        "  · For ratios, multiples, days, counts, percentages: present "
        "unchanged regardless of currency.\n"
        "  · Never invent or extrapolate a different FX rate. Use only "
        "the rate provided above; if the user asks for a currency outside "
        "RON/EUR/USD, say you don't have the rate.\n"
        "=== End rule ===\n"
    )


def _build_public_company_directive(
    public_company: Optional["LlmPublicCompanyContext"],
) -> str:
    """NASDAQ-13 — synthesize a system-prompt block describing the public
    company the user is currently viewing on /public-companies.

    Returns "" when no context is provided so the existing prompt stays
    cache-eligible for the workspace path.

    Formatting notes:
      · Money figures rendered in raw USD with thousands separators —
        the FX directive (built separately) handles any RON/EUR/USD
        display conversion the user has selected in the TopHeader.
      · Ratios as %-points where applicable. Multiples as 'Nx'.
      · Provenance line names the source (Sharadar SF1 for live,
        FY2024-indicative demo when source="demo").
    """
    if public_company is None:
        return ""

    pc = public_company
    label = (pc.company_name or pc.ticker).strip()
    period = pc.latest_period or "latest available period"
    source_line = (
        "Demo (FY2024-indicative — not live SF1 data)"
        if (pc.source or "").lower() == "demo"
        else "Sharadar SF1 (live)"
    )

    def _money(v: Optional[float]) -> str:
        return f"USD {v:,.0f}" if v is not None else "—"

    def _pct(v: Optional[float]) -> str:
        return f"{v:.1f}%" if v is not None else "—"

    def _mult(v: Optional[float]) -> str:
        return f"{v:.1f}x" if v is not None else "—"

    lines = [
        f"Ticker / company: {pc.ticker}  ·  {label}",
        f"Exchange · sector · industry: "
        f"{pc.exchange or '—'} · {pc.sector or '—'} · {pc.industry or '—'}",
        f"Currency: {pc.currency or 'USD'}    Period: {period}"
        + (f"  (ended {pc.latest_period_end})" if pc.latest_period_end else ""),
        f"Source: {source_line}",
        "",
        "Headline (raw USD unless noted):",
        f"  · Revenue          {_money(pc.revenue)}",
        f"  · EBITDA           {_money(pc.ebitda)}  ({_pct(pc.ebitda_margin)} margin)",
        f"  · Net income       {_money(pc.net_income)}  ({_pct(pc.net_margin)} margin)",
        f"  · Total assets     {_money(pc.total_assets)}",
        f"  · Total equity     {_money(pc.total_equity)}",
        f"  · Cash             {_money(pc.cash)}",
        f"  · Net debt         {_money(pc.net_debt)}  ({_mult(pc.net_debt_to_ebitda)} ND/EBITDA)",
        f"  · Free cash flow   {_money(pc.free_cash_flow)}",
        "",
        "Market:",
        f"  · Market cap       {_money(pc.market_cap)}",
        f"  · Enterprise value {_money(pc.enterprise_value)}",
        f"  · P/E              {_mult(pc.pe_ratio)}",
        f"  · EV / EBITDA      {_mult(pc.ev_to_ebitda)}",
        f"  · ROE              {_pct(pc.roe)}",
    ]

    body = "\n".join(lines)
    return (
        "\n\n=== Public-company context ===\n"
        "The user is currently viewing this Nasdaq-listed company on the "
        "Public Company Intelligence page. Use the figures below when the "
        "user asks about this ticker — never invent or extrapolate beyond "
        "these numbers. If they ask for a metric not shown here (e.g. "
        "segment revenue, geographic mix), say so plainly and suggest the "
        "Sharadar SF1 query that would surface it.\n\n"
        f"{body}\n"
        "=== End public-company context ===\n"
    )


def _build_chat_system_prompt(
    *,
    page: str,
    company_name: str,
    dataset_summary: Optional[str],
    display_currency: Optional[str] = None,
    fx_context: Optional["LlmFxContext"] = None,
    public_company: Optional["LlmPublicCompanyContext"] = None,
) -> str:
    """Persona + grounding for the conversational chat.

    Kept stable across turns so the system prompt is cache-eligible — the
    only volatile bit is the user message itself, so on a typical chat
    session the model only re-bills the new user turn each round.

    CUR-FIX — `display_currency` + `fx_context` append the display-currency
    rule (see `_build_currency_directive`). Optional for back-compat.
    """
    persona = (
        "You are CFO AI, a senior financial AI advisor for inventory-heavy "
        "businesses. You help operators decide what to protect, fix, reduce, "
        "liquidate, or scale across their portfolio.\n\n"
        "Voice:\n"
        "  · Warm but direct. Specific, not vague. Skip preambles like "
        "\"Great question!\" or \"That's an interesting one\".\n"
        "  · Use real numbers when they're given. kEUR / pp / DIO / CCC "
        "are part of your everyday vocabulary.\n"
        "  · Markdown is welcome — short headers, bullet lists, bold for "
        "key numbers. Code blocks for any structured data.\n"
        "  · Multi-turn — assume the operator's previous questions are "
        "context for the next one.\n\n"
        "Scope:\n"
        "  · Engage with whatever the operator asks. Inventory, working "
        "capital, financial mentoring, general questions about CFO craft, "
        "spreadsheet help, anything they bring up. Do NOT refuse to "
        "discuss off-topic questions.\n"
        "  · When you don't know a specific number, say so plainly — "
        "don't fabricate numbers. The operator can run an upload to get "
        "fresh data if needed.\n\n"
        "Final-decision posture:\n"
        "  · Frame recommendations as analysis, not as commands. Use "
        "phrases like \"the data suggests\", \"a CFO playbook here would "
        "be\", or \"if it were my call\". Final decisions remain with the "
        "operator's management team.\n"
    )

    page_line = f"\nThe operator is currently viewing the {page} page."
    company_line = f"\nCompany context: {company_name}."

    grounding = ""
    if dataset_summary:
        grounding = (
            "\n\n=== Current portfolio snapshot ===\n"
            + dataset_summary.strip()
            + "\n=== End snapshot ===\n"
            "\n"
            "Anchor your answers in this snapshot when the operator asks "
            "about their portfolio. Don't repeat the snapshot back at them "
            "— they already know — just use it to give pointed answers.\n"
        )
    else:
        grounding = (
            "\n\nNo portfolio data is loaded yet. If the operator asks "
            "about specifics (their categories, alerts, capital trapped), "
            "tell them to upload a workbook from the sidebar to get "
            "grounded answers, then offer general CFO guidance for the "
            "topic they raised.\n"
        )

    fx_directive = _build_currency_directive(
        display_currency=display_currency, fx_context=fx_context,
    )
    public_directive = _build_public_company_directive(public_company)
    return persona + page_line + company_line + grounding + fx_directive + public_directive


def _build_workspace_chat_system_prompt(
    *,
    page: str,
    company_name: str,
    dataset_summary: Optional[str],
    display_currency: Optional[str] = None,
    fx_context: Optional["LlmFxContext"] = None,
    public_company: Optional["LlmPublicCompanyContext"] = None,
) -> str:
    """System prompt for the universal Ask-CFO-AI workspace chat tab.

    Per the human's explicit, recorded choice: this is a genuinely
    open-domain assistant ("ask anything") that also carries the user's
    active-period workspace context. Open-domain answers (general
    finance / strategy / industry / tax theory / general knowledge) are
    answered fully, ChatGPT-style.

    The single hard boundary is correctness of THIS user's own figures:
    workspace numbers must come only from the dataset_summary passed in
    here. If a requested company figure isn't in the snapshot, the model
    says so plainly — it does not guess the user's numbers.

    Standard general-answer disclosure is rendered persistently in the
    UI near the chat input (a single line, not per-message), so the
    system prompt does not need to repeat it on every turn.
    """
    persona = (
        "You are CFO AI, a capable general assistant with access to the "
        "user's CFO AI financial workspace. Answer any question helpfully "
        "— finance, strategy, industry, the app itself, general knowledge. "
        "You are NOT a refuse-everything-ungrounded bot; open-domain "
        "questions are welcome and should be answered with the same care "
        "as a knowledgeable colleague would.\n\n"
        "Voice:\n"
        "  · Direct, specific, warm. Skip preambles like \"Great "
        "question!\" or \"That's an interesting one\".\n"
        "  · Use markdown for structure when it helps — short headers, "
        "bullet lists, bold for key numbers.\n"
        "  · Multi-turn — earlier turns are context for the next one.\n\n"
        "Workspace grounding rules (non-negotiable):\n"
        "  · When you state a number about THIS user's company, it must "
        "come from the workspace snapshot below. Cite the period and the "
        "figure (e.g. \"FY2025 EBITDA of 2.13M RON, from the snapshot\").\n"
        "  · If the user asks for a specific company figure that is NOT "
        "in the snapshot, say so plainly. Do not guess, infer, or "
        "fabricate the user's own numbers. Suggest they upload the "
        "relevant document or check the active period.\n"
        "  · General-knowledge numbers (e.g. typical industry margins, "
        "WACC ranges, benchmark ratios) are fine to share as general "
        "guidance, but make clear they are NOT this user's data.\n\n"
        "Open-domain latitude:\n"
        "  · You may discuss accounting concepts, Romanian RAS / IFRS "
        "differences, tax theory, valuation methodology, M&A processes, "
        "strategy frameworks, or anything else the user asks. You are "
        "not required to refuse non-workspace topics.\n"
        "  · For Romanian regulatory / tax / legal specifics, advise the "
        "user to confirm with a qualified Romanian advisor before acting "
        "— the persistent disclosure in the UI states this; you can echo "
        "it briefly when relevant but do not nag.\n\n"
        "Final-decision posture:\n"
        "  · Frame recommendations as analysis, not commands. \"The data "
        "suggests\", \"a CFO playbook here would be\", \"if it were my "
        "call\". Final decisions remain with the user.\n"
    )

    page_line = f"\nThe operator is currently viewing the {page} page."
    company_line = f"\nCompany context: {company_name}."

    if dataset_summary and dataset_summary.strip():
        grounding = (
            "\n\n=== Active workspace snapshot ===\n"
            + dataset_summary.strip()
            + "\n=== End snapshot ===\n"
            "\n"
            "Use this snapshot for any company-specific answer. Cite the "
            "period and the figure when you do. If something the user "
            "asks about isn't in this snapshot, say so — never guess "
            "their numbers.\n"
        )
    else:
        grounding = (
            "\n\nNo workspace data is loaded yet. Open-domain questions "
            "remain fully answerable; for any question that needs THIS "
            "user's specific company figures, tell them to load a period "
            "from the Dashboard first.\n"
        )

    fx_directive = _build_currency_directive(
        display_currency=display_currency, fx_context=fx_context,
    )
    public_directive = _build_public_company_directive(public_company)
    return persona + page_line + company_line + grounding + fx_directive + public_directive
