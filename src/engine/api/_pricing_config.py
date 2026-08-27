"""Pricing & Plan Limits — single source of truth (V2; tiers restructured 2026-08).

Current tier table (THE spec — tests/engine/test_pricing_tiers.py locks it):
  · Free trial  — €0,    1 doc total, no card, chat 3/day 5/mo, 1 workspace
  · Intro       — €0.99 one-time 7-day, +1 doc, chat 5/10 (NOT recurring)
  · RO Solo     — €4.99/mo,  3 docs/mo,  €1.49 extra, chat 10/50,  1 ws
  · Pro         — €9.99/mo,  15 docs/mo, €0.99 extra, chat 25/150, 5 ws
  · Multi-Country — €16.99/mo, 15 docs/mo €0.99 extra + 8 non-RO docs/mo
                    (€1.49 extra non-RO), chat 40/200, 5 ws
  · Starter     — €14.99 era, RETIRED from purchase (purchasable=False);
                  legacy subscribers resolve to the Pro entitlement set.
  Legacy 39.99-era Pro subs (webhook key 'pro_legacy') resolve to the
  Multi-Country entitlement set — grandfathered UP, never downgraded.

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
    PRICING_CHAT_DAILY_CAP_PRO=30
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

PlanKey = Literal["trial", "intro", "starter", "solo", "pro", "multi"]


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
    # ── 2026-08 tier restructure — all additive, env-overridable ──────
    # Workspaces (organizations) the user may hold concurrently. The
    # hard floor is enforced in SQL (create_workspace(), see
    # supabase/schema_phase_plan_caps.sql); this field drives the
    # backend/FE soft gates + the plan-state payload.
    max_workspaces: int = 1
    # Non-Romanian documents (jurisdiction resolver != RO). ONLY the
    # multi tier may run them; every other tier gets the typed refusal
    # {"error": "non_ro_not_included", "upgrade_to": "multi"}.
    allows_non_ro: bool = False
    # Monthly included non-RO docs (multi only), then overage at
    # `extra_nonro_doc_eur` per doc via the Stripe metered meter.
    included_nonro_docs: int = 0
    extra_nonro_doc_eur: Optional[float] = None
    # False = kept as a plan DEF for legacy subscription-state rendering
    # but REFUSED at checkout (410) — the 'starter' retirement path.
    purchasable: bool = True


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
    # COGS anchor re-measured 2026-08-25: RO doc ≈ $0.02, non-RO doc
    # $0.43–0.97 worst-case, chat turn ~$0.012–0.03. €0.90 sits at the
    # worst-case non-RO unit cost, so the import-time below-COGS guard
    # stays meaningful (a planted €0.01 extra price still fires) without
    # false-positives on the €0.99 extra-doc price. The previous 1.62
    # default predated the AI-first reader's cost work.
    cogs = _env_float("PRICING_COGS_EUR", 0.90)

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

    # ── 2026-08 restructure — RETIRED from purchase, kept for legacy
    # subscription-state rendering only. Existing 14.99 subscribers keep
    # billing on their old Stripe price; their ENTITLEMENTS resolve via
    # legacy_tier_map (starter → pro: 15 docs vs the old 5 — an upgrade,
    # never a downgrade). Checkout returns 410 for this key.
    starter = PlanConfig(
        key="starter",
        display_name="Starter",
        blurb="Retired plan — existing subscribers get the Pro allowance.",
        price_eur=_env_float("PRICING_STARTER_MONTHLY_EUR", 14.99),
        recurring=True,
        requires_card=True,
        included_docs=_env_int("PRICING_STARTER_INCLUDED_DOCS", 5),
        extra_doc_eur=_env_float("PRICING_STARTER_EXTRA_DOC_EUR", 3.00),
        chat=ChatCaps(
            daily=_env_int("PRICING_CHAT_DAILY_CAP_STARTER", 10),
            monthly=_env_int("PRICING_CHAT_MONTHLY_CAP_STARTER", 50),
        ),
        max_workspaces=_env_int("PRICING_MAX_WORKSPACES_STARTER", 5),
        purchasable=False,
    )

    solo = PlanConfig(
        key="solo",
        display_name="RO Solo",
        blurb="Three Romanian analyses per month, extras at €1.49/doc.",
        price_eur=_env_float("PRICING_SOLO_MONTHLY_EUR", 4.99),
        recurring=True,
        requires_card=True,
        included_docs=_env_int("PRICING_SOLO_INCLUDED_DOCS", 3),
        extra_doc_eur=_env_float("PRICING_SOLO_EXTRA_DOC_EUR", 1.49),
        chat=ChatCaps(
            daily=_env_int("PRICING_CHAT_DAILY_CAP_SOLO", 10),
            monthly=_env_int("PRICING_CHAT_MONTHLY_CAP_SOLO", 50),
        ),
        max_workspaces=_env_int("PRICING_MAX_WORKSPACES_SOLO", 1),
    )

    # User directive (2026-08): the second paid tier is named exactly
    # "Pro" — NOT "RO Pro". Re-priced 39.99 → 9.99; the 39.99-era
    # subscribers are grandfathered UP to the multi entitlement set via
    # the `pro_legacy` synthetic key (stamped by the webhook from the
    # STRIPE_PRICE_PRO_LEGACY price id — see _billing.py).
    pro = PlanConfig(
        key="pro",
        display_name="Pro",
        blurb="Fifteen Romanian analyses per month, extras at €0.99/doc.",
        price_eur=_env_float("PRICING_PRO_MONTHLY_EUR", 9.99),
        recurring=True,
        requires_card=True,
        included_docs=_env_int("PRICING_PRO_INCLUDED_DOCS", 15),
        extra_doc_eur=_env_float("PRICING_PRO_EXTRA_DOC_EUR", 0.99),
        chat=ChatCaps(
            daily=_env_int("PRICING_CHAT_DAILY_CAP_PRO", 25),
            monthly=_env_int("PRICING_CHAT_MONTHLY_CAP_PRO", 150),
        ),
        max_workspaces=_env_int("PRICING_MAX_WORKSPACES_PRO", 5),
    )

    multi = PlanConfig(
        key="multi",
        display_name="Multi-Country",
        blurb=("Fifteen analyses per month plus eight non-Romanian "
               "documents included; overages metered."),
        price_eur=_env_float("PRICING_MULTI_MONTHLY_EUR", 16.99),
        recurring=True,
        requires_card=True,
        included_docs=_env_int("PRICING_MULTI_INCLUDED_DOCS", 15),
        extra_doc_eur=_env_float("PRICING_MULTI_EXTRA_DOC_EUR", 0.99),
        chat=ChatCaps(
            daily=_env_int("PRICING_CHAT_DAILY_CAP_MULTI", 40),
            monthly=_env_int("PRICING_CHAT_MONTHLY_CAP_MULTI", 200),
        ),
        max_workspaces=_env_int("PRICING_MAX_WORKSPACES_MULTI", 5),
        allows_non_ro=True,
        included_nonro_docs=_env_int("PRICING_MULTI_INCLUDED_NONRO_DOCS", 8),
        extra_nonro_doc_eur=_env_float("PRICING_MULTI_EXTRA_NONRO_DOC_EUR", 1.49),
    )

    legacy_tier_map: Dict[str, PlanKey] = {
        # 2026-08 restructure. Rule: NEVER downgrade an active
        # subscriber's entitlements.
        #   · starter (14.99, retired) → pro (15 docs vs old 5 — up).
        #   · pro_legacy — synthetic key the webhook stamps for a
        #     subscription still billing on the OLD 39.99 pro price id
        #     (env STRIPE_PRICE_PRO_LEGACY). The old-pro entitlement set
        #     (15 docs, 40/200 chat) now lives at `multi`, so they map
        #     there — they paid more, they get more (incl. non-RO docs).
        #   · business/professional were mapped to the OLD pro; mapping
        #     them to the NEW pro (25/150 chat) would silently downgrade
        #     their chat caps → they follow the old-pro set to multi.
        # NOTE: the pre-restructure alias "solo" → starter was REMOVED
        # because "solo" is now a first-class plan key (CONFIG.plans is
        # checked before this map in plan_for(), so the alias was
        # unreachable anyway). Any pre-V2 legacy `solo` rows resolve to
        # the new RO Solo plan.
        "pro_legacy": "multi",
        "business": "multi",
        "professional": "multi",
        "professional_contact": "multi",
        "starter": "pro",
    }

    return PricingConfig(
        cogs_estimate_per_doc_eur=cogs,
        plans={"trial": trial, "intro": intro, "starter": starter,
               "solo": solo, "pro": pro, "multi": multi},
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
        for label, price in (("Extra-doc", plan.extra_doc_eur),
                             ("Extra-non-RO-doc", plan.extra_nonro_doc_eur)):
            if price is None:
                continue
            if price < cfg.cogs_estimate_per_doc_eur:
                out.append(
                    f"{label} price €{price:.2f} for tier "
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
        plan = CONFIG.plans[k]  # type: ignore[index]
        # A retired (non-purchasable) plan resolves through the legacy
        # map for ENTITLEMENTS — e.g. a 14.99 'starter' subscriber gets
        # the Pro allowance (grandfathered up, never down). The plan DEF
        # itself stays in CONFIG.plans for state/pricing-page rendering.
        if not plan.purchasable:
            mapped = CONFIG.legacy_tier_map.get(k)
            if mapped:
                return CONFIG.plans[mapped]
        return plan
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
                # 2026-08 tier restructure — additive fields.
                "max_workspaces": p.max_workspaces,
                "allows_non_ro": p.allows_non_ro,
                "included_nonro_docs": p.included_nonro_docs,
                "extra_nonro_doc_eur": p.extra_nonro_doc_eur,
                "purchasable": p.purchasable,
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
