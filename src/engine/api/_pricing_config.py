"""Pricing & Plan Limits — single source of truth (V2).

Implements the validated structure from IMPLEMENT_PRICING_AND_LIMITS.md:
  · Free trial  — €0,    1 doc total,        no card, very low chat
  · Intro       — €0.99 one-time 7-day,      +1 doc, low chat (NOT recurring)
  · Starter     — €14.99/mo, 5 docs/mo,      €3.00 extra,  daily+monthly chat caps
  · Pro         — €39.99/mo, 15 docs/mo,     €2.50 extra,  daily+monthly chat caps

DESIGN RULES (from the spec)
============================
1. ONE config file. Every price, included-doc count, extra-doc price,
   chat cap, intro-window length, and the COGS estimate lives in this
   module. Changing a value here = no code change elsewhere.
2. €0.99 is ONE-TIME, not recurring. The data model encodes this via
   `recurring: False` on the intro tier; the billing layer must refuse
   to create a recurring Stripe subscription for it.
3. Below-COGS warning fires at IMPORT TIME when any extra-doc price
   drops below `cogs_estimate_per_doc_eur`. Internal-only — logs go to
   stderr / structured logger, never to a customer surface.

CONFIG OVERRIDE
===============
Values can be overridden at runtime via environment variables (without
a code change), e.g.:
    PRICING_STARTER_MONTHLY_EUR=12.99
    PRICING_STARTER_EXTRA_DOC_EUR=2.99
    PRICING_CHAT_DAILY_CAP_STARTER=15
    PRICING_COGS_EUR=1.80

The env-override layer is in `_load()` at the bottom of this file. Use
this for staged price experiments without redeploys.

WHAT THIS FILE IS NOT
=====================
NOT the engine. NOT the canonical metric object. NOT Bug A. NOT the
P&L footing / Products / chat-tab / dashboard-restyle / valuation
prompts. This config wraps LIMITS around the existing pipeline; it
does not modify the pipeline.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Dict, List, Literal, Optional


logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Types
# ──────────────────────────────────────────────────────────────────────

PlanKey = Literal["trial", "intro", "starter", "pro"]


@dataclass(frozen=True)
class ChatCaps:
    """Daily AND monthly caps, whichever hits first.

    Both are server-side counted. `None` means unlimited (not used by any
    tier today — kept for forward compatibility).
    """
    daily: Optional[int]
    monthly: Optional[int]


@dataclass(frozen=True)
class PlanConfig:
    key: PlanKey
    display_name: str
    # Acquisition headline copy — single source for the landing page.
    blurb: str
    # Monthly price when `recurring=True`, one-time price when `recurring=False`.
    price_eur: float
    recurring: bool
    requires_card: bool
    # Documents allowed in the current period. For trial/intro this is
    # the TOTAL allowance (one-shot window). For starter/pro this is the
    # MONTHLY allowance that resets on the billing anchor.
    included_docs: int
    # Per-doc charge when the user goes over `included_docs`. `None`
    # means no overage is allowed — caller hard-stops and prompts upgrade.
    extra_doc_eur: Optional[float]
    # Chat caps — daily AND monthly, both enforced server-side.
    chat: ChatCaps
    # For intro-style one-shot windows. None for recurring plans.
    window_days: Optional[int] = None


@dataclass(frozen=True)
class PricingConfig:
    """The whole pricing surface in one object."""
    cogs_estimate_per_doc_eur: float
    plans: Dict[PlanKey, PlanConfig]
    # Billing scope — DECIDED, per-user (gap B from the refined spec).
    # ─────────────────────────────────────────────────────────────────
    # Plans, document quotas, extra-doc charges and chat caps are
    # ATTACHED TO THE INDIVIDUAL USER ACCOUNT, not the org / workspace.
    # The data model reflects this: `subscriptions(user_id)`,
    # `user_usage(user_id, month)`, `plan_chat_daily_usage(user_id, day)`
    # are all per-user keyed. Adding a second user to an org does NOT
    # grant them analyses or chat headroom — each has their own plan.
    #
    # Recorded tradeoff: multi-person review of one company requires
    # each reviewer to have their own subscription. Inviting a teammate
    # to view an analysis works (RLS scopes by membership) but if they
    # want to RUN their own analyses or chat, they hit their own
    # paywall. This is the chosen model; if it ever needs to flip to
    # org-scoped billing, the migration is a JOIN on memberships and a
    # rewrite of every reserve/commit/release call site — non-trivial.
    billing_scope: str   # always "user" today; kept as a field so a
                         # future switch is a one-line change + migration
    # Legacy mapping — if the user has a row in `subscriptions` with one
    # of the old tier keys, this maps it onto the new schema for
    # enforcement. Keeps existing paid users from accidentally being
    # downgraded to "trial" when this rolls out.
    legacy_tier_map: Dict[str, PlanKey]


# ──────────────────────────────────────────────────────────────────────
# Env override helpers
# ──────────────────────────────────────────────────────────────────────

def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        logger.warning("[pricing] %s=%r is not a valid float — using default %s", name, raw, default)
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        logger.warning("[pricing] %s=%r is not a valid int — using default %s", name, raw, default)
        return default


# ──────────────────────────────────────────────────────────────────────
# Build the config (env-overridable)
# ──────────────────────────────────────────────────────────────────────

def _load() -> PricingConfig:
    """Build the canonical pricing config. Env vars override defaults so
    prices/limits can change without a redeploy."""
    cogs = _env_float("PRICING_COGS_EUR", 1.62)

    trial = PlanConfig(
        key="trial",
        display_name="Free trial",
        blurb="Try the platform on one document. No card required.",
        price_eur=0.0,
        recurring=False,
        requires_card=False,
        included_docs=_env_int("PRICING_TRIAL_INCLUDED_DOCS", 1),
        # Trial does NOT allow extras — user hits the wall and must upgrade.
        extra_doc_eur=None,
        chat=ChatCaps(
            daily=_env_int("PRICING_CHAT_DAILY_CAP_TRIAL", 3),
            monthly=_env_int("PRICING_CHAT_MONTHLY_CAP_TRIAL", 5),
        ),
        # Owner decision (May 2026 redesign): trial window is 7 days.
        # Was 30 days during the initial V2 rollout; tightened to match
        # the "Try CFO AI with one document" framing — a 30-day idle
        # account on the trial plan wasn't generating signal. Env var
        # PRICING_TRIAL_WINDOW_DAYS still overrides per-environment.
        window_days=_env_int("PRICING_TRIAL_WINDOW_DAYS", 7),
    )

    intro = PlanConfig(
        key="intro",
        display_name="Intro unlock",
        blurb="One-time 7-day single-document unlock. Not a subscription.",
        price_eur=_env_float("PRICING_INTRO_PRICE_EUR", 0.99),
        # ⚠️ Hard rule from the spec: intro is ONE-TIME. The billing layer
        # MUST refuse to create a recurring Stripe subscription for this
        # plan. See `is_recurring_eligible_for_stripe_subscription()` below.
        recurring=False,
        requires_card=True,
        included_docs=_env_int("PRICING_INTRO_INCLUDED_DOCS", 1),
        extra_doc_eur=None,
        chat=ChatCaps(
            daily=_env_int("PRICING_CHAT_DAILY_CAP_INTRO", 5),
            monthly=_env_int("PRICING_CHAT_MONTHLY_CAP_INTRO", 10),
        ),
        window_days=_env_int("PRICING_INTRO_WINDOW_DAYS", 7),
    )

    starter = PlanConfig(
        key="starter",
        display_name="Starter",
        blurb="Five analyses per month, with metered extras at €3.00/doc.",
        price_eur=_env_float("PRICING_STARTER_MONTHLY_EUR", 14.99),
        recurring=True,
        requires_card=True,
        included_docs=_env_int("PRICING_STARTER_INCLUDED_DOCS", 5),
        extra_doc_eur=_env_float("PRICING_STARTER_EXTRA_DOC_EUR", 3.00),
        chat=ChatCaps(
            daily=_env_int("PRICING_CHAT_DAILY_CAP_STARTER", 10),
            monthly=_env_int("PRICING_CHAT_MONTHLY_CAP_STARTER", 50),
        ),
    )

    pro = PlanConfig(
        key="pro",
        display_name="Pro",
        blurb="Fifteen analyses per month, with metered extras at €2.50/doc.",
        price_eur=_env_float("PRICING_PRO_MONTHLY_EUR", 39.99),
        recurring=True,
        requires_card=True,
        included_docs=_env_int("PRICING_PRO_INCLUDED_DOCS", 15),
        extra_doc_eur=_env_float("PRICING_PRO_EXTRA_DOC_EUR", 2.50),
        chat=ChatCaps(
            daily=_env_int("PRICING_CHAT_DAILY_CAP_PRO", 40),
            monthly=_env_int("PRICING_CHAT_MONTHLY_CAP_PRO", 200),
        ),
    )

    legacy_tier_map: Dict[str, PlanKey] = {
        # Legacy `solo` / `business` / `professional` subscriptions
        # continue to work. The map below is the upgrade-path baseline —
        # everyone who paid for `solo` lands on at least `starter`, paid
        # `business` lands on `pro`. Customers will be re-charged on
        # their next renewal at the new rates; for now this is read-only
        # so the migration is non-destructive.
        "solo": "starter",
        "business": "pro",
        "professional": "pro",
        "professional_contact": "pro",
    }

    return PricingConfig(
        cogs_estimate_per_doc_eur=cogs,
        plans={"trial": trial, "intro": intro, "starter": starter, "pro": pro},
        # Billing scope is fixed at "user" per gap B of the refined spec.
        # Kept as a field so the data model + every reserve/commit call
        # site reads from one source, instead of hardcoding the choice
        # at 30+ call sites.
        billing_scope="user",
        legacy_tier_map=legacy_tier_map,
    )


# Module-level singleton. Reloaded ONLY by `reload_for_test()` below;
# production code uses this constant.
CONFIG: PricingConfig = _load()


# ──────────────────────────────────────────────────────────────────────
# Below-COGS warning (admin-only, internal)
# ──────────────────────────────────────────────────────────────────────

def below_cogs_warnings(cfg: Optional[PricingConfig] = None) -> List[str]:
    """Return a list of internal warning strings for any tier whose
    extra-doc price is below the COGS estimate. Empty list means every
    tier is margin-positive on extras.

    These warnings are logged at INFO on module import and are surfaced
    on the admin features-status endpoint. Never shown to customers.

    Default arg resolves to the LIVE module-level CONFIG, so a call
    after `reload_for_test()` sees the updated config (a default arg
    of `CONFIG` would be bound at function-def time and miss reloads).
    """
    cfg = cfg or CONFIG
    out: List[str] = []
    for plan in cfg.plans.values():
        if plan.extra_doc_eur is None:
            continue
        if plan.extra_doc_eur < cfg.cogs_estimate_per_doc_eur:
            out.append(
                f"Extra-doc price €{plan.extra_doc_eur:.2f} for tier "
                f"'{plan.display_name}' is below estimated COGS "
                f"€{cfg.cogs_estimate_per_doc_eur:.2f} — margin-negative "
                f"until prompt caching ships."
            )
    return out


# Boot-time emission. Loud enough to land in logs / Sentry, soft enough
# not to fail startup. Customers never see this.
for _w in below_cogs_warnings():
    logger.warning("[pricing][below-cogs] %s", _w)


# ──────────────────────────────────────────────────────────────────────
# Hard-rule guards — keep recurring €0.99 from ever being created
# ──────────────────────────────────────────────────────────────────────

def is_recurring_eligible_for_stripe_subscription(plan_key: str) -> bool:
    """Return True only when the plan is a real recurring subscription.

    The Stripe checkout endpoint MUST call this before creating a
    subscription. Returning False forces the caller to create a
    one-time charge instead — that's the path for `intro` (€0.99) and
    the only legal billing motion for it.

    Accepts both new keys (trial/intro/starter/pro) and legacy aliases
    (solo/business/professional). Legacy aliases map through
    `legacy_tier_map` so existing recurring Stripe subs keep working.
    """
    plan = plan_for(plan_key)
    return bool(plan and plan.recurring)


def plan_for(key: str) -> Optional[PlanConfig]:
    """Resolve any incoming tier string (new keys + legacy aliases) to a
    PlanConfig. Returns None when the key is genuinely unknown — the
    caller should treat that as "no active subscription" and apply the
    trial limits."""
    if not key:
        return None
    k = key.strip().lower()
    if k in CONFIG.plans:
        return CONFIG.plans[k]  # type: ignore[index]
    legacy = CONFIG.legacy_tier_map.get(k)
    if legacy:
        return CONFIG.plans[legacy]
    return None


# ──────────────────────────────────────────────────────────────────────
# Public-shaped dict (for the GET /api/pricing/config endpoint)
# ──────────────────────────────────────────────────────────────────────

def to_public_dict(cfg: Optional[PricingConfig] = None) -> Dict[str, object]:
    """Shape the config for the public-facing pricing page.

    EXCLUDES the COGS estimate — that's an internal value and must
    never appear on customer-facing surfaces.
    """
    cfg = cfg or CONFIG
    return {
        "billing_scope": cfg.billing_scope,
        "plans": [
            {
                "key": p.key,
                "display_name": p.display_name,
                "blurb": p.blurb,
                "price_eur": p.price_eur,
                "recurring": p.recurring,
                "requires_card": p.requires_card,
                "included_docs": p.included_docs,
                "extra_doc_eur": p.extra_doc_eur,
                "chat_daily_cap": p.chat.daily,
                "chat_monthly_cap": p.chat.monthly,
                "window_days": p.window_days,
            }
            for p in cfg.plans.values()
        ],
    }


def to_admin_dict(cfg: Optional[PricingConfig] = None) -> Dict[str, object]:
    """Shape for admin / diagnostic surfaces — includes the COGS
    estimate and the below-COGS warnings."""
    cfg = cfg or CONFIG
    pub = to_public_dict(cfg)
    pub["cogs_estimate_per_doc_eur"] = cfg.cogs_estimate_per_doc_eur
    pub["below_cogs_warnings"] = below_cogs_warnings(cfg)
    return pub


# ──────────────────────────────────────────────────────────────────────
# Test helper
# ──────────────────────────────────────────────────────────────────────

def reload_for_test() -> PricingConfig:
    """Re-read env vars and rebuild the singleton. Used by unit tests
    that need to flip a price/limit mid-run. Production code MUST NOT
    call this."""
    global CONFIG
    CONFIG = _load()
    return CONFIG
