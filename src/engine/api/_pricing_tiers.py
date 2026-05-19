"""Phase 5 — Final tier definitions (Python mirror).

MUST stay byte-identical (limits/features/prices) with
`scandi-desk-main/src/lib/pricingTiers.ts`. See PART A of the pricing spec.

Two public self-serve tiers (solo, business) + one contact-sales tier
(professional). The Stripe checkout endpoint refuses `tier='professional'`
— Pro signups go through the contact-sales form instead.

DB rows store the tier as one of {'solo', 'business', 'professional'}; the
UI uses `professional_contact` as the display key so it never tries to
self-serve Pro.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Literal, Optional


# UI key — distinguishes the contact-sales tier from a self-serve Pro.
TierKey = Literal["solo", "business", "professional_contact"]
# DB key — what gets stored in `subscriptions.tier`.
DbTierKey = Literal["solo", "business", "professional"]


@dataclass(frozen=True)
class TierLimits:
    max_users: int
    max_companies: int
    uploads_per_month: int
    llm_calls_per_month: int
    history_retention_months: int
    overage_price_per_doc_eur: Optional[float]  # None => no overage (custom)


@dataclass(frozen=True)
class TierFeatures:
    pl_bs_cf: bool
    essential_ratios: bool
    full_ratios: bool
    ebitda_evaluation: bool
    altman_basic: bool
    altman_piotroski_full: bool
    nav_cascade: bool
    valuation_suite: bool
    industry_benchmarks: bool
    ai_mastermind: bool
    recommendations_engine: bool
    monthly_email_reports: bool
    multi_entity_view: bool
    api_access: bool
    share_readonly_links: bool
    comments_mentions: bool


@dataclass(frozen=True)
class TierSupport:
    email_sla_hours: int
    live_chat: bool
    dedicated_onboarding: bool
    phone_support: bool


@dataclass(frozen=True)
class Tier:
    key: TierKey
    display_name: str
    audience: str
    cta_type: Literal["self_serve", "contact_sales"]
    monthly_eur: Optional[float]
    annual_eur: Optional[float]
    limits: TierLimits
    features: TierFeatures
    support: TierSupport


TIERS: Dict[str, Tier] = {
    "solo": Tier(
        key="solo",
        display_name="Solo",
        audience="Individual investors, freelance analysts, founders doing personal due diligence",
        cta_type="self_serve",
        monthly_eur=19.99,
        annual_eur=199.0,
        limits=TierLimits(
            max_users=1,
            max_companies=1,
            uploads_per_month=10,
            llm_calls_per_month=30,
            history_retention_months=12,
            overage_price_per_doc_eur=4.0,
        ),
        features=TierFeatures(
            pl_bs_cf=True,
            essential_ratios=True,
            full_ratios=False,
            ebitda_evaluation=True,
            altman_basic=True,
            altman_piotroski_full=False,
            nav_cascade=False,
            valuation_suite=False,
            industry_benchmarks=False,
            ai_mastermind=False,
            recommendations_engine=False,
            monthly_email_reports=False,
            multi_entity_view=False,
            api_access=False,
            share_readonly_links=False,
            comments_mentions=False,
        ),
        support=TierSupport(
            email_sla_hours=48,
            live_chat=False,
            dedicated_onboarding=False,
            phone_support=False,
        ),
    ),
    "business": Tier(
        key="business",
        display_name="Business",
        audience="SMB owners, internal finance teams, real estate holdings, family-group portfolios",
        cta_type="self_serve",
        monthly_eur=59.0,
        annual_eur=590.0,
        limits=TierLimits(
            max_users=2,
            max_companies=5,
            uploads_per_month=25,
            llm_calls_per_month=100,
            history_retention_months=60,
            overage_price_per_doc_eur=3.0,
        ),
        features=TierFeatures(
            pl_bs_cf=True,
            essential_ratios=True,
            full_ratios=True,
            ebitda_evaluation=True,
            altman_basic=True,
            altman_piotroski_full=True,
            nav_cascade=True,
            valuation_suite=True,
            industry_benchmarks=True,
            ai_mastermind=True,
            recommendations_engine=True,
            monthly_email_reports=True,
            multi_entity_view=False,
            api_access=False,
            share_readonly_links=True,
            comments_mentions=True,
        ),
        support=TierSupport(
            email_sla_hours=24,
            live_chat=True,
            dedicated_onboarding=False,
            phone_support=False,
        ),
    ),
    "professional_contact": Tier(
        key="professional_contact",
        display_name="Professional",
        audience="Advisory firms, accountants, multi-entity holdings, M&A boutiques managing 5+ companies",
        cta_type="contact_sales",
        monthly_eur=None,
        annual_eur=None,
        limits=TierLimits(
            max_users=10,
            max_companies=25,
            uploads_per_month=200,
            llm_calls_per_month=1000,
            history_retention_months=60,
            overage_price_per_doc_eur=None,
        ),
        features=TierFeatures(
            pl_bs_cf=True,
            essential_ratios=True,
            full_ratios=True,
            ebitda_evaluation=True,
            altman_basic=True,
            altman_piotroski_full=True,
            nav_cascade=True,
            valuation_suite=True,
            industry_benchmarks=True,
            ai_mastermind=True,
            recommendations_engine=True,
            monthly_email_reports=True,
            multi_entity_view=True,
            api_access=True,
            share_readonly_links=True,
            comments_mentions=True,
        ),
        support=TierSupport(
            email_sla_hours=4,
            live_chat=True,
            dedicated_onboarding=True,
            phone_support=True,
        ),
    ),
}


SELF_SERVE_TIER_KEYS = ("solo", "business")


def db_tier_key(ui_key: str) -> str:
    """UI key → DB key. The UI uses 'professional_contact' to mark a tier
    as non-self-serve; persisted rows just use 'professional'."""
    return "professional" if ui_key == "professional_contact" else ui_key


def normalize_tier_key(raw: Optional[str]) -> Optional[TierKey]:
    if not raw:
        return None
    if raw in TIERS:
        return raw  # type: ignore[return-value]
    if raw == "professional":
        return "professional_contact"
    return None


def get_tier(key: Optional[str]) -> Optional[Tier]:
    norm = normalize_tier_key(key)
    if norm is None:
        return None
    return TIERS[norm]


def effective_limits(tier_key: str, custom_limits: Optional[Dict[str, int]] = None) -> TierLimits:
    """Tier defaults overlaid with any per-customer custom limits.
    Only Pro contracts should have custom_limits populated."""
    tier = get_tier(tier_key)
    base = tier.limits if tier else TIERS["solo"].limits
    if not custom_limits:
        return base
    return TierLimits(
        max_users=int(custom_limits.get("max_users") or base.max_users),
        max_companies=int(custom_limits.get("max_companies") or base.max_companies),
        uploads_per_month=int(
            custom_limits.get("uploads_per_month") or base.uploads_per_month
        ),
        llm_calls_per_month=int(
            custom_limits.get("llm_calls_per_month") or base.llm_calls_per_month
        ),
        history_retention_months=int(
            custom_limits.get("history_retention_months")
            or base.history_retention_months
        ),
        overage_price_per_doc_eur=custom_limits.get(
            "overage_price_per_doc_eur", base.overage_price_per_doc_eur
        ),
    )


def current_month_bucket(now: Optional[datetime] = None) -> str:
    dt = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return f"{dt.year:04d}-{dt.month:02d}"


ActionKind = Literal["upload", "llm_call", "export"]


def limit_for_action(limits: TierLimits, action: ActionKind) -> Optional[int]:
    if action == "upload":
        return limits.uploads_per_month
    if action == "llm_call":
        return limits.llm_calls_per_month
    return None  # No hard cap on exports in the current spec.


def usage_column_for_action(action: ActionKind) -> str:
    if action == "upload":
        return "uploads"
    if action == "llm_call":
        return "llm_calls"
    if action == "export":
        return "exports"
    raise ValueError(f"Unknown action: {action}")


FOUNDING_MEMBER_CAP = 500
