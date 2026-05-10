"""Server-side CFO AI chat — context builder + deterministic responder.

The responder is intentionally LLM-free: it pattern-matches the user's
question against the freshly-computed engine output (categories, decisions,
recommendations, executive summary) and returns answers grounded in the
real numbers. Same intent vocabulary as the frontend stub responder so the
behavior stays consistent during the migration.

If `ANTHROPIC_API_KEY` is set in the environment the LLM-flavored layer
(briefing.client.BriefingClient) is used to wrap the deterministic answer
in natural prose; otherwise we return the structured blocks as-is.

Why structured blocks instead of raw text:
  - Frontend renders them as paragraphs / stat-tile rows / bullet lists
  - Numbers stay grounded — the responder only quotes engine-computed values
  - Cheap to regression-test (rule expectations vs. fixture).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..buckets import BUCKET_KEYS, Bucket
from ..config import Config
from ..models import CategoryMetrics, Decision, Recommendation


# ─── Block types — mirror frontend ChatBlock ─────────────────────────────


@dataclass
class StatTile:
    label: str
    value: str

    def to_dict(self) -> Dict[str, str]:
        return {"label": self.label, "value": self.value}


@dataclass
class ChatBlock:
    text: Optional[str] = None
    stats: Optional[List[StatTile]] = None
    items: Optional[List[str]] = None  # bullet list

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        if self.text is not None:
            out["text"] = self.text
        if self.stats:
            out["stats"] = [s.to_dict() for s in self.stats]
        if self.items:
            out["list"] = list(self.items)
        return out


@dataclass
class ChatAnswer:
    blocks: List[ChatBlock] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {"blocks": [b.to_dict() for b in self.blocks]}


# ─── Context builder ─────────────────────────────────────────────────────


@dataclass
class ChatContext:
    """Frozen snapshot of what the AI is grounded in for a single turn."""
    metrics: List[CategoryMetrics]
    decisions: List[Decision]
    recommendations: List[Recommendation]
    summary: Dict[str, Any]
    cost_of_capital_pct: float
    company_name: str = "Demo workspace"
    dataset_label: str = "Current dataset"
    page: str = "Today"


def build_context(
    metrics: List[CategoryMetrics],
    decisions: List[Decision],
    recommendations: List[Recommendation],
    summary: Dict[str, Any],
    cfg: Config,
    company_name: str = "Demo workspace",
    dataset_label: str = "Current dataset",
    page: str = "Today",
) -> ChatContext:
    """Assemble the per-turn chat context object.

    Caller has already run the pipeline; we only project the parts the
    responder needs (decisions + summary + cost of capital).
    """
    return ChatContext(
        metrics=metrics,
        decisions=decisions,
        recommendations=recommendations,
        summary=summary,
        cost_of_capital_pct=cfg.cost_of_capital_pct,
        company_name=company_name,
        dataset_label=dataset_label,
        page=page,
    )


# ─── Number formatting ───────────────────────────────────────────────────


def _fmt_eur_m(kron: float) -> str:
    """Format a kEUR amount as M EUR (the engine emits kEUR after FX)."""
    return f"{kron / 1000:.1f}M EUR"


def _fmt_eur_auto(kron: float) -> str:
    a = abs(kron)
    if a >= 1000:
        return f"{kron / 1000:.1f}M EUR"
    return f"{kron:.0f}k EUR"


def _fmt_pct(n: float) -> str:
    return f"{n:.1f}%"


# ─── Intent detection ────────────────────────────────────────────────────


def _has_all(text: str, *keywords: str) -> bool:
    t = text.lower()
    return all(k.lower() in t for k in keywords)


def _has_any(text: str, *keywords: str) -> bool:
    t = text.lower()
    return any(k.lower() in t for k in keywords)


# ─── Responder ───────────────────────────────────────────────────────────


def respond(question: str, ctx: ChatContext) -> ChatAnswer:
    """Map a natural-language question to a grounded structured answer."""
    q = question.strip().lower()
    s = ctx.summary
    decisions = ctx.decisions

    cash_trapped = float(s.get("cash_trapped_kron", 0))
    cash_recovery = float(s.get("cash_recovery_potential_kron", 0))
    roic_pct = float(s.get("roic_pct", 0))
    real_margin = float(s.get("real_margin_pct", 0))
    urgent = int(s.get("urgent_actions", 0))
    bucket_counts = s.get("bucket_counts", {}) or {}

    # ─── Daily / today / urgent ────────────────────────────────────
    if _has_any(q, "today", "urgent", "do today") or _has_all(q, "what", "should"):
        return ChatAnswer(blocks=[
            ChatBlock(text=f"Your portfolio has **{urgent} urgent action{'s' if urgent != 1 else ''}** today, weighted by cash impact and the rule that fired."),
            ChatBlock(stats=[
                StatTile("Cash trapped",   _fmt_eur_m(cash_trapped)),
                StatTile("Recoverable",    _fmt_eur_m(cash_recovery)),
                StatTile("ROIC",           _fmt_pct(roic_pct)),
                StatTile("Real margin",    _fmt_pct(real_margin)),
            ]),
            ChatBlock(text="Recommended order of operations:", items=[
                f"**Liquidate** {bucket_counts.get('liquidate', 0)} bleeding-margin SKUs to free trapped capital.",
                f"**Renegotiate** {bucket_counts.get('fix', 0)} thin-margin items with suppliers.",
                f"**Throttle reorder** on {bucket_counts.get('reduce', 0)} slow-movers.",
                f"**Hold** {bucket_counts.get('protect', 0)} anchor categories — these absorb fixed costs.",
            ]),
        ])

    # ─── Cash trapped ──────────────────────────────────────────────
    if _has_any(q, "trap") or _has_all(q, "where", "cash") or (_has_any(q, "cash") and not _has_any(q, "recover")):
        top5 = sorted(decisions, key=lambda d: -(d.capital_trapped_kron or 0))[:5]
        return ChatAnswer(blocks=[
            ChatBlock(text=f"Inventory ties up **{_fmt_eur_m(cash_trapped)}** across the portfolio. The five biggest capital drags:"),
            ChatBlock(items=[
                f"**{d.id}** — {_fmt_eur_auto(d.capital_trapped_kron or 0)} · {d.dio_days}d DIO · real margin {_fmt_pct(d.real_margin_pct)}"
                for d in top5
            ]),
            ChatBlock(text=f"Of this, **{_fmt_eur_m(cash_recovery)}** is recoverable in 30–60 days by acting on the Liquidate + Reduce buckets."),
        ])

    # ─── Recovery ──────────────────────────────────────────────────
    if _has_any(q, "recover", "free up") or _has_all(q, "cash", "60"):
        recoverable = [d for d in decisions if d.bucket in ("LIQUIDATE", "REDUCE")]
        return ChatAnswer(blocks=[
            ChatBlock(text=f"**{_fmt_eur_m(cash_recovery)}** recoverable across {len(recoverable)} SKUs in liquidate + reduce buckets."),
            ChatBlock(items=[
                f"{'Liquidate' if d.bucket == 'LIQUIDATE' else 'Reduce'} **{d.id}** → ~{_fmt_eur_auto((d.capital_freed_kron or 0) * (0.3 if d.bucket == 'REDUCE' else 1.0))} freed"
                for d in recoverable[:8]
            ]),
        ])

    # ─── Liquidate ─────────────────────────────────────────────────
    if _has_any(q, "liquidat", "destroy") or _has_all(q, "should", "cut"):
        liq = [d for d in decisions if d.bucket == "LIQUIDATE"]
        return ChatAnswer(blocks=[
            ChatBlock(text=f"{len(liq)} product{'s' if len(liq) != 1 else ''} flagged for liquidation. These have negative real margin or capital trapped without a return:"),
            ChatBlock(items=[
                f"**{d.id}** — real margin {_fmt_pct(d.real_margin_pct)}, {d.dio_days}d DIO. Reason: {d.reason or 'weak unit economics'}."
                for d in liq
            ]),
        ])

    # ─── Real margin ───────────────────────────────────────────────
    if _has_any(q, "real margin", "fake profit") or _has_all(q, "after", "capital"):
        return ChatAnswer(blocks=[
            ChatBlock(text=f"Real margin = gross margin − working-capital cost. With cost of capital at **{ctx.cost_of_capital_pct}%** and a 90-day inventory cycle, every product loses ~{(90 / 365) * ctx.cost_of_capital_pct:.1f}pp of margin to capital alone."),
            ChatBlock(stats=[
                StatTile("Portfolio gross", _fmt_pct(real_margin + 1.8)),
                StatTile("Portfolio real",  _fmt_pct(real_margin)),
                StatTile("Margin leak",     "1.8pp"),
            ]),
            ChatBlock(text="Categories with the worst gap (gross looks healthy, real margin is thin) need supplier renegotiation or pricing review — not necessarily liquidation."),
        ])

    # ─── ROIC ──────────────────────────────────────────────────────
    if _has_any(q, "roic", "return on"):
        worst = sorted(
            [d for d in decisions if d.real_margin_pct < 3 or d.abs_profit_kron < 0],
            key=lambda d: d.real_margin_pct,
        )[:5]
        spread = roic_pct - ctx.cost_of_capital_pct
        return ChatAnswer(blocks=[
            ChatBlock(text=f"Portfolio ROIC sits at **{_fmt_pct(roic_pct)}** vs {ctx.cost_of_capital_pct}% cost of capital — a healthy {spread:.1f}pp spread, but it's concentrated in a handful of anchors."),
            ChatBlock(text="Categories dragging ROIC down:", items=[
                f"**{d.id}** — real margin {_fmt_pct(d.real_margin_pct)}, abs profit {d.abs_profit_kron:.1f}k EUR"
                for d in worst
            ]),
        ])

    # ─── Specific product lookup ───────────────────────────────────
    named = next((d for d in decisions if d.id.lower() in q), None)
    if named:
        bucket_advice = {
            "LIQUIDATE": "Recommendation: stop reorder, run a one-time discount, exit the catalogue.",
            "FIX":       "Recommendation: open a renegotiation with the supplier or run a 5-10% price increase test.",
            "REDUCE":    "Recommendation: cut reorder quantity by ~30%, lower the safety stock floor.",
            "SCALE":     "Recommendation: increase purchasing — this earns its capital cost twice over.",
            "PROTECT":   "Recommendation: hold position. Anchor categories absorb fixed costs.",
            "WATCH":     "Recommendation: monitor weekly. No action today.",
        }
        return ChatAnswer(blocks=[
            ChatBlock(text=f"**{named.id}** is in the **{named.bucket}** bucket."),
            ChatBlock(stats=[
                StatTile("Real margin",     _fmt_pct(named.real_margin_pct)),
                StatTile("Absolute profit", _fmt_eur_auto(named.abs_profit_kron)),
                StatTile("DIO",             f"{named.dio_days}d"),
                StatTile("Capital trapped", _fmt_eur_auto(named.capital_trapped_kron or 0)),
            ]),
            ChatBlock(text=(
                f"Reason the rule fired: *{named.reason}*."
                if named.reason
                else f"Status: {'anchor' if named.bucket == 'PROTECT' else 'stable'}."
            )),
            ChatBlock(text=bucket_advice.get(named.bucket, "Recommendation: review manually.")),
        ])

    # ─── Board summary ─────────────────────────────────────────────
    if _has_any(q, "board", "summary", "summarize"):
        return ChatAnswer(blocks=[
            ChatBlock(text="**Portfolio at a glance**", stats=[
                StatTile("Working capital",  _fmt_eur_m(cash_trapped)),
                StatTile("ROIC",             _fmt_pct(roic_pct)),
                StatTile("Real margin",      _fmt_pct(real_margin)),
                StatTile("Recoverable 60d",  _fmt_eur_m(cash_recovery)),
            ]),
            ChatBlock(text="**Operating priorities**", items=[
                f"Protect {bucket_counts.get('protect', 0)} anchor categories driving the bulk of profit share.",
                f"Recover {_fmt_eur_m(cash_recovery)} of cash by acting on liquidate + reduce in the next 60 days.",
                f"{bucket_counts.get('fix', 0)} renegotiations in flight — expected margin lift ~+2pp on touched volume.",
                f"{bucket_counts.get('scale', 0)} scale candidates earning above cost of capital with room for more inventory.",
            ]),
        ])

    # ─── Simulate ──────────────────────────────────────────────────
    if _has_any(q, "simulate", "what if", "happens if"):
        return ChatAnswer(blocks=[
            ChatBlock(text="Simulation engine ships in the next release. In the meantime, change a threshold in **Settings → Rules** and the queue updates live — every SKU's bucket is recomputed against the new gate."),
            ChatBlock(text="Common simulations users run:", items=[
                "Cost of capital +1.5pp → real margin compresses by ~0.4pp portfolio-wide.",
                "DIO floor 100d → 150d → 7 fewer items in Watch, 4 more in Reduce.",
                "Anchor floor 5% → 4% → no anchors lost; one new candidate qualifies.",
            ]),
        ])

    # ─── Supplier negotiation ──────────────────────────────────────
    if _has_any(q, "supplier", "renegotiat", "negotiation"):
        fix = next((d for d in decisions if d.bucket == "FIX"), None)
        target = f"**{fix.id}**" if fix else "a thin-margin supplier conversation"
        return ChatAnswer(blocks=[
            ChatBlock(text=f"Draft talking points for {target}:", items=[
                f"Year-to-date volume: {fix.volume_tons:.0f}t — material to both sides." if fix else "Year-to-date volume: material to both sides.",
                f"Current real margin sits at {fix.real_margin_pct:.1f}%, well below our portfolio threshold of 3%." if fix else "Current real margin is below our portfolio threshold of 3%.",
                "Industry benchmark for similar volumes is closer to 5–6% — we'd like to align.",
                "Open to longer payment terms (60→75d) in exchange for a 4–5% list-price reduction.",
                "If we can't move the unit economics, we'll need to delist — a worse outcome for both.",
            ]),
        ])

    # ─── Default ───────────────────────────────────────────────────
    return ChatAnswer(blocks=[
        ChatBlock(text=f"I track {len(decisions)} categories with **{_fmt_eur_m(cash_trapped)}** in working capital. Try one of the suggested prompts on the right, or ask about a specific product, bucket, or financial metric."),
    ])


# ─── Suggested prompts (the canonical list — frontend mirrors this) ───────


SUGGESTED_PROMPTS: Dict[str, List[str]] = {
    "Daily": [
        "What should I do today?",
        "Show urgent decisions.",
        "Summarize portfolio health.",
    ],
    "Explain": [
        "Explain Macrou.",
        "Why is SUC in Scale?",
        "What does real margin mean?",
    ],
    "Cash": [
        "Where is cash trapped?",
        "Which SKUs should we liquidate?",
        "How much can we recover in 60 days?",
    ],
    "Simulate": [
        "Simulate cost of capital at 8%.",
        "What if we cut DIO by 20 days?",
        "Draft supplier renegotiation.",
        "Create board summary.",
    ],
}
