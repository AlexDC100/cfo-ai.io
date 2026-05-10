"""Decision rules — applied AFTER anchor classification.

Order of evaluation (CLAUDE.md):
  1. Anchor classification runs first (anchors.py)
  2. For anchors: ANCHOR_ALERT > ANCHOR_REVIEW > ANCHOR
  3. For non-anchors: ELIMINATE > WARNING > SCALE > KEEP

Within each tier, rules are short-circuited — first match wins. The reason
string identifies which rule fired so the action generator can produce a
specific recommendation.
"""

from __future__ import annotations

from typing import Optional, Tuple

from .anchors import is_anchor_alert
from .config import Config
from .models import CategoryMetrics


# Returned by classifiers: (flag, reason, recommendation)
ClassifyResult = Tuple[str, Optional[str], Optional[str]]


def classify(m: CategoryMetrics, cfg: Config, is_anchor: bool) -> ClassifyResult:
    """Apply the full rule pipeline to one category."""
    if is_anchor:
        return _classify_anchor(m, cfg)
    return _classify_non_anchor(m, cfg)


def _classify_anchor(m: CategoryMetrics, cfg: Config) -> ClassifyResult:
    fires, reason = is_anchor_alert(m, cfg.anchor)
    if fires:
        rec = _anchor_alert_recommendation(reason)
        return "ANCHOR_ALERT", reason, rec

    if _anchor_review_fires(m, cfg):
        return "ANCHOR_REVIEW", "long_dio_anchor", "monitor_inventory_turnover"

    return "ANCHOR", None, "maintain"


def _anchor_review_fires(m: CategoryMetrics, cfg: Config) -> bool:
    """Anchors with watch flags but no breach."""
    # Long DIO but margin still acceptable — review, not alert
    if m.dio_days > cfg.warning.long_dio_days and m.real_margin_pct >= cfg.anchor.high_volume_anchor_floor_pct:
        return True
    return False


def _classify_non_anchor(m: CategoryMetrics, cfg: Config) -> ClassifyResult:
    """Classify a non-anchor SKU/category.

    ┌─────────────────────────────────────────────────────────────────────┐
    │  PRESET DECISION MATRIX (first match wins, top-down)                │
    │                                                                     │
    │  1. ELIMINATE — every rule requires a margin OR contribution gate.  │
    │     Volume alone NEVER eliminates a SKU.                            │
    │                                                                     │
    │       a. real margin negative                                       │
    │       b. micro volume (<5 t) AND micro profit (<5 kRON)             │
    │            → both must fail; a tiny SKU with healthy profit stays   │
    │       c. capital trap: long DIO (>150d) AND thin margin (<5%)       │
    │            → margin gate protects healthy items from this rule      │
    │       d. CCC red zone AND low contribution (<5 kRON profit)         │
    │       e. thin margin (0-3%) AND below volume/profit floor           │
    │            → only thin-margin items can be culled by volume         │
    │                                                                     │
    │  2. WARNING — review signals, not death sentences                   │
    │                                                                     │
    │       a. thin margin (0-3%) in mid-volume band → renegotiate        │
    │       b. thin margin + > max_volume_tons → renegotiate URGENTLY     │
    │            (the MURATURI 188 t @ 0.1% RM working-capital trap)      │
    │       c. long DIO (>100d) → review inventory turnover               │
    │            → no volume gate here. A high-margin low-volume niche    │
    │              with long DIO (THE GOMMY S, JELEURI) is a review item, │
    │              never an elimination. Volume alone doesn't kill it.    │
    │                                                                     │
    │  3. SCALE — high-margin big volume / volume play / fast velocity    │
    │                                                                     │
    │  4. KEEP — default                                                  │
    │                                                                     │
    │  Why: a SKU classified ELIMINATE is going to be cut from the        │
    │  catalogue. That's irreversible. Cutting a high-margin niche        │
    │  product on a volume technicality destroys real money. Always       │
    │  pair volume gates with a margin or profit gate before eliminating. │
    └─────────────────────────────────────────────────────────────────────┘
    """
    # ─── 1. ELIMINATE ──────────────────────────────────────────────────
    # Rule 1a: negative real margin always eliminates. Catches Calamar at
    # -90.7%: every unit sold loses money, no defence works against this.
    if m.real_margin_pct < 0:
        return "ELIMINATE", "real_margin_negative", "discontinue"

    # ─── HEALTHY GROSS MARGIN SHIELD ───────────────────────────────────
    # User-pinned policy: any SKU with gross GM ≥ 10% is a niche premium
    # product whose per-unit economics earn the right to stay in the
    # catalogue. Volume / DIO / CCC issues alone can never eliminate it.
    # The only override is rule 1a above (negative real margin = bleeding).
    # WARNING rules below still apply (long DIO is still a review signal),
    # but ELIMINATE is off the table.
    HEALTHY_GROSS_MARGIN_PCT = 10.0
    if m.gm_pct >= HEALTHY_GROSS_MARGIN_PCT:
        return _classify_non_anchor_warn_scale_keep(m, cfg)

    if (
        m.volume_tons < cfg.eliminate.micro_volume_tons
        and m.abs_profit_kron < cfg.eliminate.micro_profit_kron
        # Margin gate — a tiny SKU with healthy per-unit margin is a niche
        # premium product, not an elimination target. Only cut when ALL three
        # are weak: tiny volume, tiny absolute profit, AND thin real margin.
        and m.real_margin_pct < cfg.warning.thin_real_margin_max_pct
    ):
        return "ELIMINATE", "micro_volume_micro_profit", "discontinue"

    if (
        m.dio_days > cfg.eliminate.dio_capital_trap
        and m.real_margin_pct < cfg.eliminate.capital_trap_real_margin
    ):
        return "ELIMINATE", "capital_trap", "discontinue_or_renegotiate"

    if (
        m.ccc_days is not None
        and m.ccc_days > cfg.eliminate.ccc_category_red_days
        and m.abs_profit_kron < cfg.eliminate.micro_profit_kron
        # Margin gate — same logic as micro_volume_micro_profit. Long CCC +
        # low profit ALONE is not enough; we also require a thin per-unit
        # margin.
        and m.real_margin_pct < cfg.warning.thin_real_margin_max_pct
    ):
        return "ELIMINATE", "ccc_red_low_contribution", "discontinue"

    return _classify_non_anchor_warn_scale_keep(m, cfg)


def _classify_non_anchor_warn_scale_keep(
    m: CategoryMetrics, cfg: Config
) -> ClassifyResult:
    """WARNING / SCALE / KEEP block.

    Reachable by both the normal path (after ELIMINATE rules failed) AND
    by the healthy-gross-margin shield (which short-circuits straight here
    so a 10%+ GM SKU can never be eliminated except by negative real margin).
    """
    # ─── 2. WARNING ────────────────────────────────────────────────────
    # 2a/b. Thin-margin band — gated by volume floor (below floor → eliminate)
    # and ceiling (above ceiling → urgent renegotiation).
    if 0 <= m.real_margin_pct < cfg.warning.thin_real_margin_max_pct:
        if (
            m.volume_tons < cfg.warning.min_volume_tons
            or m.abs_profit_kron < cfg.warning.min_profit_kron
        ):
            return "ELIMINATE", "thin_margin_micro_volume", "discontinue"
        if m.volume_tons > cfg.warning.max_volume_tons:
            return (
                "WARNING",
                "thin_margin_high_volume",
                "renegotiate_supplier_urgently",
            )
        return (
            "WARNING",
            "thin_real_margin",
            "renegotiate_supplier_or_price_adjustment",
        )

    # 2c. Long DIO. NO volume gate here — eliminating a high-margin niche
    # for being small was the GOMMY S bug. Long DIO is always a review
    # signal, never an automatic elimination.
    if m.dio_days > cfg.warning.long_dio_days:
        return "WARNING", "long_dio", "review_inventory_turnover"

    # ─── 3. SCALE ──────────────────────────────────────────────────────
    if (
        m.real_margin_pct > cfg.scale.high_margin_min_pct
        and m.volume_tons > cfg.scale.high_margin_min_volume
    ):
        return "SCALE", "high_margin_high_volume", "scale_aggressively"

    if (
        m.real_margin_pct > cfg.scale.volume_play_min_pct
        and m.volume_tons > cfg.scale.volume_play_min_volume
    ):
        return "SCALE", "volume_play", "scale_distribution"

    if (
        m.dio_days < cfg.scale.high_volume_dio_max
        and m.volume_tons > cfg.scale.volume_play_min_volume
    ):
        return "SCALE", "fast_velocity", "scale_distribution"

    # ─── 4. KEEP (default) ─────────────────────────────────────────────
    return "KEEP", None, "monitor"


def _anchor_alert_recommendation(reason: Optional[str]) -> str:
    """Map an alert reason to its recommendation phrase.

    Per CLAUDE.md: language must be 'review urgently' / 'renegotiate' / 'monitor',
    NEVER 'eliminate' for anchors.
    """
    if reason == "high_volume_anchor_below_floor":
        return "review_pricing_or_sourcing"
    if reason == "absolute_floor_breach":
        return "renegotiate_urgently"
    return "review_urgently"
