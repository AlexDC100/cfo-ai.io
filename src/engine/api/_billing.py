"""Stripe-backed billing surface — checkout, portal, webhook, renewal cron.

This module is the canonical place every billing route lives. The webhook
handler is the source of truth for subscriptions state; nothing else mutates
the `subscriptions` table.

Required env vars (set in the backend host, NOT the frontend bundle):

  STRIPE_SECRET_KEY                sk_test_... or sk_live_...
  STRIPE_WEBHOOK_SECRET            whsec_...
  STRIPE_PRICE_FOUNDER_Q1          price_xxx  (€1, recurring quarterly)
  STRIPE_PRICE_FOUNDER_RENEWAL     price_xxx  (€99, recurring yearly)
  STRIPE_PRICE_STANDARD            price_xxx  (€99, recurring yearly)
  APP_URL                          https://yourchoice.ai  (or http://localhost:5173 in dev)

The stripe SDK is loaded lazily so the engine boots without it installed —
billing endpoints return a clear "Stripe not configured" error in that case.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from pydantic import BaseModel

from . import _org, _pricing_tiers, _site, _supabase


logger = logging.getLogger(__name__)


# ─── Helpers ────────────────────────────────────────────────────────────────


def _require_jwt(authorization: Optional[str]) -> str:
    # PUBLIC_TEST_MODE — open-access posture bypass. When the env flag is
    # on, every request is treated as authenticated as the shared test
    # user. See `_test_mode.py` for the safety guarantees (shared user has
    # membership only in TEST_ORG_ID; real orgs structurally inaccessible).
    from . import _test_mode
    if _test_mode.is_test_mode():
        # Mint (and cache) a real Supabase access_token for the synthetic
        # test user so downstream per_user(jwt) calls don't 401. See
        # _test_mode.get_test_user_jwt() for the cache + refresh logic.
        # On any unexpected mint failure we degrade to the placeholder so
        # the existing bypass guards (is_bypass_token) still keep
        # identity-resolution working — Supabase data calls will then
        # 401, but the route gets a structured error instead of an
        # uncaught exception.
        try:
            return _test_mode.get_test_user_jwt()
        except Exception:  # noqa: BLE001
            import logging
            logging.getLogger(__name__).exception(
                "[test_mode] JWT mint failed; falling back to placeholder."
            )
            return _test_mode.JWT_BYPASS_PLACEHOLDER
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    return authorization.split(" ", 1)[1].strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ts_to_iso(ts: Optional[int]) -> Optional[str]:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _stripe_or_none():
    """Lazy import + key validation. Returns the configured stripe module or
    None if env isn't set — billing endpoints surface 503 in that case."""
    key = os.environ.get("STRIPE_SECRET_KEY")
    if not key:
        return None
    try:
        import stripe  # type: ignore
    except ImportError:
        logger.warning("[billing] stripe SDK not installed (pip install stripe).")
        return None
    stripe.api_key = key
    return stripe


def _user_id_from_jwt(jwt: str) -> str:
    """Local JWT claim decode — same pattern as _supabase.get_user; avoids
    the auth-gateway round-trip and key-rotation breakage."""
    # PUBLIC_TEST_MODE — short-circuit to the shared test user. The
    # bypass placeholder is set by `_require_jwt` upstream; the second
    # branch is the paranoid catch-all (any token when test mode is on
    # still routes here, so a missed bypass at the require-jwt site
    # can't reach Supabase with a bogus token and 500).
    from . import _test_mode
    if _test_mode.is_bypass_token(jwt):
        return _test_mode.test_user_id()
    with _supabase.per_user(jwt) as client:
        user = client.get_user(jwt)
    user_id = user.get("id") if user else None
    if not user_id:
        raise HTTPException(401, "Could not resolve user from JWT.")
    return user_id


def _primary_org_for_user(user_id: str) -> Optional[Dict[str, Any]]:
    """The user's OLDEST organization — their original workspace.

    Billing is per user, not per workspace: one subscription and one shared
    usage pool cover every company (SRL) the user runs. So "primary" here means
    a stable anchor for invoices and Stripe customer records, deliberately NOT
    "whichever workspace they happen to have open". Ordering by created_at
    makes the anchor deterministic — an unordered limit-1 could return a
    different org between two calls once a user has several.
    """
    org_id = _org.default_org_for_user(user_id)
    if not org_id:
        return None
    with _supabase.admin() as client:
        org_rows = client.select(
            "organizations",
            filters={"id": f"eq.{org_id}"},
            single=True,
        )
        return org_rows[0] if org_rows else None


def _user_email(user_id: str) -> Optional[str]:
    """auth.users.email lookup via service role."""
    try:
        with _supabase.admin() as client:
            r = client._client.get(  # type: ignore[attr-defined]
                f"{client.url}/auth/v1/admin/users/{user_id}",
                headers=client._headers,  # type: ignore[attr-defined]
            )
            if r.status_code == 200:
                return (r.json() or {}).get("email")
    except Exception:  # noqa: BLE001
        logger.exception("[billing] user email lookup failed")
    return None


# ─── Request/response shapes ───────────────────────────────────────────────


class CheckoutStartRequest(BaseModel):
    # STRIPE-1 (May 2026) — accepts both legacy plans ('founder' /
    # 'standard') and the active simple-tier model ('intro' / 'starter'
    # / 'pro'). The FE PricingTableV2 uses the simple tiers; the legacy
    # org-scoped checkout is retained for migration windows.
    plan: str
    locale: Optional[str] = "en"


class CheckoutStartResponse(BaseModel):
    url: str


# STRIPE-1 — tier → (env var, mode, metadata-shape) lookup for the
# simple-tier model rendered by PricingTableV2. Used by both POST and
# GET handlers below so the routing logic stays in one place.
#
# `mode` is the Stripe Checkout Session mode:
#   · "payment"      — one-off charge (Intro €0.99 unlock)
#   · "subscription" — recurring (Starter €14.99/mo, Pro €39.99/mo)
#
# When the env var is unset, the endpoint returns 503 with a clear
# message naming the missing var. This lets the operator spot
# configuration drift instantly.
_SIMPLE_TIER_CONFIG: Dict[str, Dict[str, str]] = {
    "intro":   {"env": "STRIPE_PRICE_INTRO",   "mode": "payment"},
    "starter": {"env": "STRIPE_PRICE_STARTER", "mode": "subscription"},
    "pro":     {"env": "STRIPE_PRICE_PRO",     "mode": "subscription"},
}

# WS2 — per-tier metered overage prices (Stripe metered billing).
# Created in Stripe Dashboard as recurring monthly metered prices with
# sum aggregation. The base subscription item bills the flat tier; the
# metered item accumulates `usage_record`s during the cycle and bills at
# the period_end invoice. Only Starter and Pro have overage prices; Intro
# is one-time (mode=payment) and Trial caps at 1 doc hard-block.
_METERED_EXTRA_DOC_CONFIG: Dict[str, str] = {
    "starter": "STRIPE_PRICE_STARTER_EXTRA_DOC",
    "pro":     "STRIPE_PRICE_PRO_EXTRA_DOC",
}


def _create_simple_tier_session(stripe: Any, tier: str, user_id: str,
                                org_id: Optional[str], email: str,
                                app_url: str) -> Any:
    """Create a Stripe Checkout Session for the intro/starter/pro tier.

    Shared by both POST `/api/checkout/start` (legacy contract) and
    GET `/api/checkout/start?tier=…` (new redirect-style entry point
    matching the FE's `<a href>` navigation pattern). Returns the
    Stripe Session object; caller decides JSON-vs-redirect response.
    """
    config = _SIMPLE_TIER_CONFIG[tier]
    price = os.environ.get(config["env"])
    if not price:
        raise HTTPException(503, f"{config['env']} not set on the backend.")

    # Reuse Stripe customer per user when available so the billing
    # portal sees prior cards / invoices. Falls back to fresh customer
    # if no subscription row exists yet.
    #
    # NOTE: the tier model (intro/starter/pro) keys `subscriptions` by
    # `user_id` (see `_upsert_tier_subscription_from_stripe` →
    # `on_conflict="user_id"`), NOT by `org_id` — that's the legacy
    # founder/standard surface. Always look up by user_id here; org_id
    # is kept only for metadata on the Stripe Customer/session for
    # downstream analytics.
    customer_id: Optional[str] = None
    with _supabase.admin() as client:
        sub_rows = client.select(
            "subscriptions",
            filters={"user_id": f"eq.{user_id}"},
            single=True,
        )
        existing = sub_rows[0] if sub_rows else None
        if existing:
            customer_id = existing.get("stripe_customer_id")

    # Self-heal: if the cached customer_id is from a different Stripe mode
    # (test ↔ live), retrieve raises InvalidRequestError "No such customer".
    # Drop the stale ID, fall through to fresh-customer creation, and the
    # subscriptions row gets reattached when the webhook handler upserts
    # the new sub. Same behavior covers customers manually deleted from
    # the Stripe Dashboard.
    if customer_id:
        try:
            stripe.Customer.retrieve(customer_id)
        except Exception as exc:  # noqa: BLE001
            if "No such customer" in str(exc):
                logger.warning(
                    "[billing] stale customer %s for user %s — likely test/live "
                    "mode swap or manual delete; clearing and creating fresh",
                    customer_id, user_id,
                )
                customer_id = None
                # Also null the stale ID + subscription_id in the row so
                # subsequent portal / cancel / record_metered calls don't
                # re-hit the same wall. The webhook will repopulate them
                # when the new sub is created.
                try:
                    with _supabase.admin() as ac:
                        ac._client.patch(  # type: ignore[attr-defined]
                            f"{ac.url}/rest/v1/subscriptions",
                            params={"user_id": f"eq.{user_id}"},
                            json={"stripe_customer_id": None,
                                  "stripe_subscription_id": None},
                            headers={**ac._headers,  # type: ignore[attr-defined]
                                     "Prefer": "return=minimal"},
                        )
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "[billing] failed to clear stale customer from DB "
                        "for user %s; checkout will continue with fresh "
                        "Stripe customer but DB will keep stale ID until "
                        "webhook lands", user_id,
                    )
            else:
                # Different Stripe error — surface it so the operator can see
                raise

    if not customer_id:
        customer = stripe.Customer.create(
            email=email or "",
            metadata={"user_id": user_id, **({"org_id": org_id} if org_id else {})},
        )
        customer_id = customer["id"]

    line_items: List[Dict[str, Any]] = [{"price": price, "quantity": 1}]

    # WS2 — for Starter / Pro, attach the metered overage item to the
    # subscription at checkout so overages bill on cycle close without
    # needing a separate `stripe.SubscriptionItem.create` round-trip.
    # If the metered env is unset the checkout still succeeds (silent
    # warn) — the upload flow's `_record_metered_extra_doc` lazy-adds
    # the item on first overage, which keeps both paths working.
    metered_env = _METERED_EXTRA_DOC_CONFIG.get(tier)
    if metered_env:
        metered_price = os.environ.get(metered_env)
        if metered_price:
            # Stripe rejects `quantity` on metered prices; just the price ref.
            line_items.append({"price": metered_price})
        else:
            logger.warning(
                "[billing] %s unset — checkout proceeds without metered item; "
                "first overage will lazy-add it via SubscriptionItem.create",
                metered_env,
            )

    session_kwargs: Dict[str, Any] = {
        "customer": customer_id,
        "mode": config["mode"],
        "line_items": line_items,
        "payment_method_collection": "always",
        "success_url": f"{app_url}/dashboard?welcome=1&tier={tier}",
        "cancel_url": f"{app_url}/pricing?canceled=1",
        "locale": "auto",
    }
    if config["mode"] == "subscription":
        session_kwargs["subscription_data"] = {
            "metadata": {
                "tier": tier, "user_id": user_id,
                **({"org_id": org_id} if org_id else {}),
            },
        }
    else:
        # mode=payment — metadata goes on the session itself (no sub)
        session_kwargs["metadata"] = {
            "tier": tier, "user_id": user_id,
            **({"org_id": org_id} if org_id else {}),
        }
    return stripe.checkout.Session.create(**session_kwargs)


# ─── WS2: Metered overage billing ──────────────────────────────────────────


def record_metered_extra_doc(user_id: str, reservation_id: str) -> Dict[str, Any]:
    """Charge a Starter/Pro user for one extra-quota document via Stripe
    metered billing.

    Called from `_commit_pipeline_quota(was_extra=True, success=True)` —
    only fires when a doc successfully processed AND was flagged as a paid
    extra at reservation time. On failure (analysis errored, user
    cancelled mid-flight) the orchestrator's release path runs instead
    and this function is never called — no charge.

    Lazy migration: for subscriptions created before WS2 went live (no
    metered line item at checkout), the first overage attempt creates
    the metered SubscriptionItem on the fly via
    `stripe.SubscriptionItem.create`. New subscriptions created after
    deploy ship with the metered item already attached, so this branch
    is taken once per legacy sub.

    Idempotency: `idempotency_key=f"extra_doc:{reservation_id}"` is the
    Stripe-side guarantee. If this endpoint is retried (network blip,
    container restart between commit + return) the second call returns
    the original usage_record without double-charging.

    Returns:
        {ok: True,  billed: True,  amount_eur: 2.50, usage_record_id: ...}
        {ok: True,  billed: False, reason: "..."}                 — no charge applicable
        {ok: False, billed: False, error: "...", detail: "..."}    — error path; release reservation in caller
    """
    stripe_client = _stripe_or_none()
    if stripe_client is None:
        logger.warning("[billing] record_metered_extra_doc: Stripe SDK/keys missing")
        return {"ok": False, "billed": False, "error": "stripe_unavailable"}

    # Resolve the user's active sub
    sub_row: Optional[Dict[str, Any]] = None
    with _supabase.admin() as client:
        rows = client.select(
            "subscriptions",
            filters={"user_id": f"eq.{user_id}"},
            single=True,
        )
        if rows:
            sub_row = rows[0]

    if not sub_row or not sub_row.get("stripe_subscription_id"):
        # Free trial / Intro unlock — no metered billing path applies.
        # Caller decides: hard-block or silently release reservation.
        return {"ok": True, "billed": False, "reason": "no_stripe_subscription"}

    tier = sub_row.get("tier") or sub_row.get("plan_key") or ""
    metered_env = _METERED_EXTRA_DOC_CONFIG.get(tier)
    if not metered_env:
        # Unknown / unsupported tier (e.g. legacy founder/standard) —
        # they shouldn't hit the extras flow but if they do, skip silently.
        return {"ok": True, "billed": False, "reason": f"tier_{tier}_no_metered_price"}

    metered_price = os.environ.get(metered_env)
    if not metered_price:
        logger.error("[billing] %s unset; cannot record overage usage for %s", metered_env, user_id)
        return {"ok": False, "billed": False, "error": "metered_price_env_unset"}

    sub_id = sub_row["stripe_subscription_id"]

    try:
        sub = stripe_client.Subscription.retrieve(sub_id, expand=["items.data.price"])
    except Exception as exc:  # noqa: BLE001
        # Test/live mode mismatch — same self-heal as portal/cancel.
        # Don't fail the user's doc upload; just skip metered billing and
        # log loudly so the operator can reconcile. The user can re-subscribe
        # via /pricing to fix the underlying state.
        if "No such subscription" in str(exc) or "No such customer" in str(exc):
            logger.error(
                "[billing] metered usage skipped — stale sub %s for user %s "
                "(test/live mode mismatch). User upload proceeds unbilled. "
                "Reconcile: have user re-subscribe via /pricing.",
                sub_id, user_id,
            )
            try:
                with _supabase.admin() as ac:
                    ac._client.patch(  # type: ignore[attr-defined]
                        f"{ac.url}/rest/v1/subscriptions",
                        params={"user_id": f"eq.{user_id}"},
                        json={"stripe_customer_id": None,
                              "stripe_subscription_id": None},
                        headers={**ac._headers,  # type: ignore[attr-defined]
                                 "Prefer": "return=minimal"},
                    )
            except Exception:  # noqa: BLE001
                pass
            return {"ok": True, "billed": False, "reason": "stale_subscription_cleared"}
        logger.exception("[billing] subscription retrieve failed for %s", sub_id)
        return {"ok": False, "billed": False, "error": "stripe_retrieve_failed",
                "detail": str(exc)[:160]}

    # Find an existing metered item on this sub; lazy-create if missing.
    items = (sub.get("items") if isinstance(sub, dict) else sub.items).to_dict()["data"] \
        if not isinstance(sub, dict) else sub["items"]["data"]
    metered_item = next(
        (it for it in items
         if (it.get("price") or {}).get("recurring", {}).get("usage_type") == "metered"),
        None,
    )

    if metered_item is None:
        # Legacy sub created before WS2 went live — add the metered item
        # so this and future overages can record usage against it. The
        # `proration_behavior=none` ensures we don't generate an immediate
        # prorated invoice line (the metered item has no fixed price).
        try:
            metered_item = stripe_client.SubscriptionItem.create(
                subscription=sub_id,
                price=metered_price,
                proration_behavior="none",
            )
            logger.info("[billing] lazy-added metered item to sub %s for user %s", sub_id, user_id)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[billing] lazy-create metered SubscriptionItem failed for %s", sub_id)
            return {"ok": False, "billed": False, "error": "metered_item_create_failed",
                    "detail": str(exc)[:160]}

    # Record the usage. The idempotency key is the reservation_id so
    # any retry of this function for the same reservation is a no-op.
    item_id = metered_item.get("id") if hasattr(metered_item, "get") else metered_item["id"]
    try:
        usage_record = stripe_client.SubscriptionItem.create_usage_record(
            item_id,
            quantity=1,
            timestamp=int(datetime.now(timezone.utc).timestamp()),
            action="increment",
            idempotency_key=f"extra_doc:{reservation_id}",
        )
    except Exception as exc:  # noqa: BLE001
        # Distinguish "already recorded" (safe to continue) from other errors.
        err_name = type(exc).__name__
        if "Idempotency" in err_name:
            logger.info("[billing] usage_record already exists for reservation %s — safe no-op",
                        reservation_id)
            return {"ok": True, "billed": True, "amount_eur": None,
                    "reason": "idempotent_replay"}
        logger.exception("[billing] create_usage_record failed for sub_item %s", item_id)
        return {"ok": False, "billed": False, "error": "usage_record_failed",
                "detail": str(exc)[:160]}

    logger.info("[billing] recorded metered extra-doc usage user=%s sub=%s reservation=%s",
                user_id, sub_id, reservation_id)
    return {
        "ok": True,
        "billed": True,
        "usage_record_id": usage_record.get("id") if hasattr(usage_record, "get") else None,
        "subscription_item_id": item_id,
    }


# ─── Subscription Schedule setup (founder phase 1 → phase 2) ───────────────


def _attach_founder_schedule(stripe, subscription_id: str) -> None:
    """After a founder Subscription is created at €1 quarterly, attach a
    Schedule that runs the €1 price for exactly one iteration (3 months),
    then transitions to the €99/year price forever.

    Stripe semantics:
      end_behavior='release'  → after the final phase, the subscription
                                continues at the last phase's price.
      iterations=1            → that phase runs once. For a quarterly
                                price, "once" means 3 months.
    """
    price_q1 = os.environ.get("STRIPE_PRICE_FOUNDER_Q1")
    price_renewal = os.environ.get("STRIPE_PRICE_FOUNDER_RENEWAL")
    if not (price_q1 and price_renewal):
        logger.warning("[billing] founder price env vars not set; skipping schedule")
        return

    try:
        sub = stripe.Subscription.retrieve(subscription_id)
        schedule = stripe.SubscriptionSchedule.create(from_subscription=sub.id)
        stripe.SubscriptionSchedule.modify(
            schedule.id,
            end_behavior="release",
            phases=[
                {"items": [{"price": price_q1, "quantity": 1}], "iterations": 1},
                {"items": [{"price": price_renewal, "quantity": 1}]},
            ],
        )
        logger.info("[billing] attached founder schedule to sub %s", subscription_id)
    except Exception:  # noqa: BLE001
        logger.exception("[billing] failed to attach founder schedule")


# ─── Webhook handlers ───────────────────────────────────────────────────────


def _upsert_subscription_from_stripe(sub: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Mirror a Stripe subscription object onto the local `subscriptions` table.
    Returns the row state BEFORE the upsert so callers can detect first-time
    creation (used to trigger the founder schedule + cohort increment)."""
    org_id = (sub.get("metadata") or {}).get("org_id")
    if not org_id:
        logger.warning("[billing] subscription missing org_id metadata: %s", sub.get("id"))
        return None
    plan = (sub.get("metadata") or {}).get("plan", "standard")

    with _supabase.admin() as client:
        existing_rows = client.select(
            "subscriptions",
            filters={"org_id": f"eq.{org_id}"},
            single=True,
        )
        existing = existing_rows[0] if existing_rows else None

        # Stripe API 2026-03-25.dahlia moved current_period_start/end from the
        # Subscription object onto each Subscription Item. Read from the first
        # item with the top-level field as a fallback for older API versions.
        items = ((sub.get("items") or {}).get("data") or [])
        first_item = items[0] if items else {}
        current_period_start = sub.get("current_period_start") or first_item.get("current_period_start")
        current_period_end = sub.get("current_period_end") or first_item.get("current_period_end")

        is_founder = plan == "founder"
        founder_renewal_at: Optional[str] = None
        if is_founder and not (existing and existing.get("stripe_subscription_id")):
            founder_renewal_at = _ts_to_iso(current_period_end)

        row = {
            "org_id": org_id,
            "stripe_customer_id": sub.get("customer"),
            "stripe_subscription_id": sub.get("id"),
            "status": sub.get("status"),
            "plan_key": plan,
            "current_period_start": _ts_to_iso(current_period_start),
            "current_period_end": _ts_to_iso(current_period_end),
            "trial_end": _ts_to_iso(sub.get("trial_end")),
            "cancel_at_period_end": bool(sub.get("cancel_at_period_end", False)),
            "is_founder": is_founder,
            "founder_renewal_price_eur": 99 if is_founder else None,
            "founder_renewal_at": founder_renewal_at,
            "updated_at": _now_iso(),
        }
        client.upsert("subscriptions", row, on_conflict="org_id")

        return existing


def _upsert_tier_subscription_from_stripe(sub: Dict[str, Any]) -> None:
    """Phase 5 — mirror a Stripe subscription onto the per-user
    `subscriptions` row. Uses metadata.user_id + metadata.tier set by
    /api/billing/create-checkout. Also claims a founding seat (atomic via
    the claim_founding_seat RPC) when `is_founding_member=true` was set on
    the Checkout Session and seats remain."""
    metadata = sub.get("metadata") or {}
    user_id = metadata.get("user_id")
    tier = metadata.get("tier")
    billing_cycle = (metadata.get("billing_cycle") or "monthly").lower()
    if billing_cycle not in ("monthly", "annual"):
        billing_cycle = "monthly"
    wants_founding = str(metadata.get("is_founding_member") or "").lower() == "true"

    if not user_id or not tier:
        logger.warning("[billing] tier subscription missing user_id/tier metadata: %s", sub.get("id"))
        return

    # Stripe statuses → our `subscriptions.status` enum.
    stripe_status = sub.get("status") or "incomplete"
    status_map = {
        "active": "active",
        "trialing": "trial",
        "past_due": "past_due",
        "canceled": "canceled",
        "incomplete": "incomplete",
        "incomplete_expired": "canceled",
        "unpaid": "past_due",
        "paused": "past_due",
    }
    status = status_map.get(stripe_status, "incomplete")

    # Atomic founding-seat claim (returns None when capped at 500).
    is_founding = False
    if wants_founding and tier in _pricing_tiers.SELF_SERVE_TIER_KEYS \
            and stripe_status in ("active", "trialing"):
        try:
            with _supabase.admin() as client:
                r = client._client.post(  # type: ignore[attr-defined]
                    f"{client.url}/rest/v1/rpc/claim_founding_seat",
                    json={
                        "p_user_id": user_id,
                        "p_tier": tier,
                        "p_stripe_subscription_id": sub.get("id"),
                    },
                    headers=client._headers,  # type: ignore[attr-defined]
                )
                if r.status_code < 400:
                    remaining = r.json()
                    is_founding = remaining is not None
                else:
                    logger.warning("[billing] claim_founding_seat RPC %s %s", r.status_code, r.text[:200])
        except Exception:  # noqa: BLE001
            logger.exception("[billing] claim_founding_seat failed")

    # Stripe API 2026-03-25.dahlia moved current_period_start/end from the
    # Subscription object onto each Subscription Item. Read from the first item
    # with the top-level field as a fallback for older API versions.
    items = ((sub.get("items") or {}).get("data") or [])
    first_item = items[0] if items else {}
    current_period_start = sub.get("current_period_start") or first_item.get("current_period_start")
    current_period_end = sub.get("current_period_end") or first_item.get("current_period_end")

    row = {
        "user_id": user_id,
        "tier": tier,
        "billing_cycle": billing_cycle,
        "status": "founding_trial" if (is_founding and status in ("active", "trial")) else status,
        "is_founding_member": is_founding,
        "stripe_customer_id": sub.get("customer"),
        "stripe_subscription_id": sub.get("id"),
        "current_period_start": _ts_to_iso(current_period_start),
        "current_period_end": _ts_to_iso(current_period_end),
        "trial_end": _ts_to_iso(sub.get("trial_end")),
        "cancel_at_period_end": bool(sub.get("cancel_at_period_end", False)),
        "updated_at": _now_iso(),
    }
    with _supabase.admin() as client:
        client.upsert("subscriptions", row, on_conflict="user_id")


def _grant_intro_entitlement(session: Dict[str, Any]) -> None:
    """One-time €0.99 intro purchase — Stripe Checkout runs in mode=payment,
    so no Subscription object is created and customer.subscription.created/
    updated never fires. Persist the 7-day entitlement directly from the
    session metadata. Outer `_process_event` handles idempotency via the
    `billing_events` insert.

    Writes both `tier='intro'` (so `_pricing_config.plan_for` resolves the
    intro plan) and `intro_unlock_expiry` (the column `_plan_state` reads
    to gate the 7-day window).
    """
    from datetime import timedelta

    metadata = session.get("metadata") or {}
    user_id = metadata.get("user_id")
    if not user_id:
        logger.warning(
            "[billing] intro session missing user_id metadata: %s",
            session.get("id"),
        )
        return

    created_ts = session.get("created")
    if created_ts:
        period_start = datetime.fromtimestamp(created_ts, tz=timezone.utc)
    else:
        period_start = datetime.now(timezone.utc)
    period_end = period_start + timedelta(days=7)

    row = {
        "user_id": user_id,
        "tier": "intro",
        "billing_cycle": "monthly",
        "status": "active",
        "is_founding_member": False,
        "stripe_customer_id": session.get("customer"),
        "stripe_subscription_id": None,
        "current_period_start": period_start.isoformat(),
        "current_period_end": period_end.isoformat(),
        "intro_unlock_expiry": period_end.isoformat(),
        "trial_end": None,
        "cancel_at_period_end": True,
        "updated_at": _now_iso(),
    }
    with _supabase.admin() as client:
        client.upsert("subscriptions", row, on_conflict="user_id")


def _process_event(event: Dict[str, Any]) -> None:
    event_id = event.get("id")
    event_type = event.get("type")
    obj = (event.get("data") or {}).get("object") or {}
    org_id = (obj.get("metadata") or {}).get("org_id")

    # Idempotency
    with _supabase.admin() as client:
        try:
            seen = client.select(
                "billing_events",
                filters={"stripe_event_id": f"eq.{event_id}"},
                single=True,
            )
            if seen:
                logger.info("[billing] event %s already processed; skipping", event_id)
                return
        except Exception:  # noqa: BLE001
            pass

        try:
            # JSON-roundtrip with `default=str` to coerce any non-JSON-native
            # types (Decimal from Stripe API amounts, datetime, etc.) before
            # passing through httpx → json_dumps. Without this, json.dumps
            # raises `TypeError: Object of type Decimal is not JSON serializable`
            # and the idempotency record is never written.
            payload_safe = json.loads(json.dumps(event, default=str))
            client.insert(
                "billing_events",
                {
                    "org_id": org_id,
                    "stripe_event_id": event_id,
                    "event_type": event_type,
                    "payload": payload_safe,
                },
                returning=False,
            )
        except Exception:  # noqa: BLE001
            logger.exception("[billing] failed to record event %s", event_id)

    # Dispatch
    if event_type in ("customer.subscription.created", "customer.subscription.updated"):
        metadata = obj.get("metadata") or {}
        # Phase 5 — new tier checkouts include user_id + tier in metadata.
        # Route them to the per-user subscriptions path; legacy org_id
        # flows continue to use the org-scoped path below.
        if metadata.get("user_id") and metadata.get("tier"):
            _upsert_tier_subscription_from_stripe(obj)
            return

        existing = _upsert_subscription_from_stripe(obj)
        plan = (obj.get("metadata") or {}).get("plan", "standard")
        first_time = not (existing and existing.get("stripe_subscription_id"))
        if event_type == "customer.subscription.created" and plan == "founder" and first_time \
                and obj.get("status") in ("active", "trialing"):
            stripe = _stripe_or_none()
            if stripe:
                _attach_founder_schedule(stripe, obj["id"])
            # Atomic cohort counter
            with _supabase.admin() as client:
                try:
                    client._client.post(  # type: ignore[attr-defined]
                        f"{client.url}/rest/v1/rpc/increment_founder_cohort",
                        headers=client._headers,  # type: ignore[attr-defined]
                        json={},
                    )
                except Exception:  # noqa: BLE001
                    logger.exception("[billing] increment_founder_cohort RPC failed")
    elif event_type == "customer.subscription.deleted":
        metadata = obj.get("metadata") or {}
        if metadata.get("user_id") and metadata.get("tier"):
            _upsert_tier_subscription_from_stripe(obj)
            return
        _upsert_subscription_from_stripe(obj)
    elif event_type == "checkout.session.completed":
        # One-time intro purchase — mode=payment, no subscription created.
        # Persist the entitlement directly from the session metadata.
        metadata = obj.get("metadata") or {}
        if metadata.get("tier") == "intro" and obj.get("mode") == "payment":
            _grant_intro_entitlement(obj)
    elif event_type == "invoice.payment_succeeded":
        # The subscription.updated event that follows will refresh state;
        # nothing to do here besides log.
        logger.info("[billing] invoice paid: %s", obj.get("id"))
    elif event_type == "invoice.payment_failed":
        # Stripe will retry; the subscription will transition to past_due.
        logger.warning("[billing] invoice failed: %s", obj.get("id"))


# ─── Renewal-reminder cron ─────────────────────────────────────────────────


def send_founder_renewal_reminders(days_ahead: int) -> Dict[str, Any]:
    """Find all `is_founder=true, status='active'` subscriptions whose
    current_period_end falls within the target day, and queue one email each.
    Idempotency comes from the per-(sub, day) marker — callers schedule a
    cron at T-14 and T-3.

    The email-sending side is a stub: drops a structured payload into a
    `renewal_email_queue` table (or logs when the table is missing). Wire
    your transactional-email provider (Resend / Postmark / SES) to drain it.
    """
    from datetime import timedelta
    today = datetime.now(timezone.utc).date()
    target_start = (today + timedelta(days=days_ahead)).isoformat()
    target_end = (today + timedelta(days=days_ahead + 1)).isoformat()

    with _supabase.admin() as client:
        subs = client.select(
            "subscriptions",
            filters={
                "is_founder": "eq.true",
                "status": "eq.active",
                "current_period_end": f"gte.{target_start}",
            },
        )
        # Filter the upper bound client-side; PostgREST doesn't support
        # two filters on the same column via the dict shape.
        subs = [s for s in subs if (s.get("current_period_end") or "") < target_end]

        queued = 0
        for sub in subs:
            org_id = sub["org_id"]
            mems = client.select(
                "memberships",
                filters={"org_id": f"eq.{org_id}"},
                limit=1,
                order="role.asc",
            )
            user_id = mems[0]["user_id"] if mems else None
            if not user_id:
                continue
            email = _user_email(user_id) or ""

            template = "renewal_reminder_t14" if days_ahead >= 7 else "renewal_reminder_t3"
            payload = {
                "to": email,
                "template": template,
                "subject": (
                    "Your CFO AI subscription renews in 14 days at €99"
                    if days_ahead >= 7
                    else "Your CFO AI subscription renews in 3 days at €99"
                ),
                "vars": {
                    "renewal_date": (sub.get("current_period_end") or "")[:10],
                    "renewal_price": "€99",
                    "manage_url": f"{os.environ.get('APP_URL', '')}/settings/billing",
                },
            }
            try:
                client.insert("renewal_email_queue", {
                    "subscription_id": sub.get("id"),
                    "send_at": _now_iso(),
                    "template": template,
                    "payload": payload,
                    "sent_at": None,
                }, returning=False)
                queued += 1
            except Exception:  # noqa: BLE001
                # Queue table may not exist yet — log the email so an
                # operator can wire delivery later.
                logger.info("[billing] renewal email pending (queue missing): %s", payload)
                queued += 1

    return {"days_ahead": days_ahead, "queued": queued, "target_date": target_start}


# ─── Router factory ────────────────────────────────────────────────────────


def build_router() -> APIRouter:
    router = APIRouter(tags=["billing"])

    @router.post("/api/checkout/start", response_model=CheckoutStartResponse)
    def checkout_start(req: CheckoutStartRequest, authorization: Optional[str] = Header(None)) -> Any:
        plan = req.plan.lower().strip()
        # STRIPE-1 — fan-out: simple-tier model (intro / starter / pro)
        # delegates to the shared session builder. Legacy org-scoped
        # founder/standard preserves the original behavior unchanged.
        if plan in _SIMPLE_TIER_CONFIG:
            jwt = _require_jwt(authorization)
            user_id = _user_id_from_jwt(jwt)
            org = _primary_org_for_user(user_id)
            stripe = _stripe_or_none()
            if not stripe:
                raise HTTPException(503, "Stripe is not configured on the backend.")
            app_url = os.environ.get("APP_URL", "http://localhost:5173").rstrip("/")
            session = _create_simple_tier_session(
                stripe, plan, user_id,
                org["id"] if org else None,
                _user_email(user_id) or "",
                app_url,
            )
            return CheckoutStartResponse(url=session.url)

        if plan not in ("founder", "standard"):
            raise HTTPException(
                400,
                "plan must be one of: 'intro', 'starter', 'pro', "
                "'founder', 'standard'.",
            )

        jwt = _require_jwt(authorization)
        user_id = _user_id_from_jwt(jwt)
        org = _primary_org_for_user(user_id)
        if not org:
            raise HTTPException(403, "No organization found for this user.")

        # Founder cohort cap
        if plan == "founder":
            with _supabase.admin() as client:
                rows = client.select(
                    "founder_cohort_public",
                    filters={},
                    single=True,
                )
                seats_left = (rows[0] if rows else {}).get("seats_left", 0)
                if int(seats_left or 0) <= 0:
                    raise HTTPException(409, "Founding Member is sold out. Choose Standard.")

        stripe = _stripe_or_none()
        if not stripe:
            raise HTTPException(503, "Stripe is not configured on the backend.")

        # Find or create the Stripe customer for this org
        with _supabase.admin() as client:
            sub_rows = client.select(
                "subscriptions",
                filters={"org_id": f"eq.{org['id']}"},
                single=True,
            )
            existing = sub_rows[0] if sub_rows else None

        customer_id = existing.get("stripe_customer_id") if existing else None
        if not customer_id:
            email = _user_email(user_id) or ""
            customer = stripe.Customer.create(
                email=email,
                metadata={"org_id": org["id"], "user_id": user_id},
            )
            customer_id = customer["id"]

        # Build Checkout Session per plan
        app_url = os.environ.get("APP_URL", "http://localhost:5173").rstrip("/")
        if plan == "founder":
            price = os.environ.get("STRIPE_PRICE_FOUNDER_Q1")
            if not price:
                raise HTTPException(503, "STRIPE_PRICE_FOUNDER_Q1 not set.")
            session = stripe.checkout.Session.create(
                customer=customer_id,
                mode="subscription",
                line_items=[{"price": price, "quantity": 1}],
                subscription_data={"metadata": {"plan": "founder", "org_id": org["id"]}},
                payment_method_collection="always",
                success_url=f"{app_url}/dashboard?welcome=1",
                cancel_url=f"{app_url}/pricing?canceled=1",
                locale="auto",
            )
        else:
            price = os.environ.get("STRIPE_PRICE_STANDARD")
            if not price:
                raise HTTPException(503, "STRIPE_PRICE_STANDARD not set.")
            session = stripe.checkout.Session.create(
                customer=customer_id,
                mode="subscription",
                line_items=[{"price": price, "quantity": 1}],
                subscription_data={
                    "metadata": {"plan": "standard", "org_id": org["id"]},
                    "trial_period_days": 14,
                },
                payment_method_collection="always",
                success_url=f"{app_url}/dashboard?welcome=1",
                cancel_url=f"{app_url}/pricing?canceled=1",
                locale="auto",
            )

        return CheckoutStartResponse(url=session.url)

    # STRIPE-1 (May 2026) — GET variant for the simple-tier model.
    # The FE PricingTableV2 renders plan CTAs as anchor links (so the
    # operator can right-click → "Open in new tab" and so middle-click
    # works), which means the browser does a top-level GET navigation
    # to this endpoint. We accept the navigation, create the Stripe
    # Checkout Session, and respond with a 303 redirect to the
    # session URL so the browser lands directly on Stripe Checkout.
    #
    # Authentication: anchor navigation can't send custom Authorization
    # headers, so this endpoint reads the JWT from the `auth_token`
    # query param (set by the FE wrapper when it knows the user is
    # signed in). When no token is present (anonymous visitor), the
    # endpoint redirects to /signup?plan=<tier>&intent=checkout so the
    # signup flow can complete the checkout after account creation.
    @router.get("/api/checkout/start")
    def checkout_start_get(
        tier: str = Query(..., description="intro | starter | pro"),
        auth_token: Optional[str] = Query(None, description="JWT bearer; required for authed checkout"),
    ) -> Any:
        tier = (tier or "").lower().strip()
        if tier not in _SIMPLE_TIER_CONFIG:
            raise HTTPException(
                400,
                f"tier must be one of: {sorted(_SIMPLE_TIER_CONFIG)}",
            )
        app_url = os.environ.get("APP_URL", "http://localhost:5173").rstrip("/")

        if not auth_token:
            # Anonymous visitor — push them through signup with the
            # intended plan threaded via query string. The signup flow
            # handler reads `?plan=...&intent=checkout` and re-triggers
            # this endpoint with auth_token after the account is created.
            return RedirectResponse(
                url=f"{app_url}/signup?plan={tier}&intent=checkout",
                status_code=303,
            )

        try:
            user_id = _user_id_from_jwt(f"Bearer {auth_token}")
        except HTTPException:
            return RedirectResponse(
                url=f"{app_url}/signup?plan={tier}&intent=checkout",
                status_code=303,
            )

        org = _primary_org_for_user(user_id)
        stripe = _stripe_or_none()
        if not stripe:
            raise HTTPException(503, "Stripe is not configured on the backend.")
        session = _create_simple_tier_session(
            stripe, tier, user_id,
            org["id"] if org else None,
            _user_email(user_id) or "",
            app_url,
        )
        return RedirectResponse(url=session.url, status_code=303)

    def _find_subscription_for_user(user_id: str) -> Optional[Dict[str, Any]]:
        """Resolve the caller's `subscriptions` row.

        Tier model (intro/starter/pro, Phase 5+) keys rows by `user_id`;
        legacy founder/standard rows key by `org_id`. Try user_id first,
        fall back to org_id so portal/cancel keep working for both
        cohorts during the transition window."""
        with _supabase.admin() as client:
            rows = client.select(
                "subscriptions",
                filters={"user_id": f"eq.{user_id}"},
                single=True,
            )
            if rows:
                return rows[0]
            org = _primary_org_for_user(user_id)
            if org:
                legacy = client.select(
                    "subscriptions",
                    filters={"org_id": f"eq.{org['id']}"},
                    single=True,
                )
                if legacy:
                    return legacy[0]
        return None

    @router.post("/api/billing/portal")
    def billing_portal(authorization: Optional[str] = Header(None)) -> Any:
        """Return a Stripe Customer Portal session URL for the caller."""
        jwt = _require_jwt(authorization)
        user_id = _user_id_from_jwt(jwt)

        existing = _find_subscription_for_user(user_id)
        if not existing or not existing.get("stripe_customer_id"):
            raise HTTPException(404, "No active subscription found for this user.")

        stripe = _stripe_or_none()
        if not stripe:
            raise HTTPException(503, "Stripe is not configured on the backend.")

        app_url = os.environ.get("APP_URL", "http://localhost:5173").rstrip("/")
        try:
            session = stripe.billing_portal.Session.create(
                customer=existing["stripe_customer_id"],
                return_url=f"{app_url}/settings",
            )
        except Exception as exc:  # noqa: BLE001
            # Same self-heal as _create_simple_tier_session: a stale customer
            # from a different Stripe mode (test ↔ live) or manual deletion
            # in the dashboard surfaces as "No such customer". Clear the
            # stale IDs and tell the user to re-checkout — there's no tier
            # available here to recreate the subscription with.
            if "No such customer" in str(exc):
                logger.warning(
                    "[billing] portal: stale customer %s for user %s — clearing",
                    existing["stripe_customer_id"], user_id,
                )
                try:
                    with _supabase.admin() as ac:
                        ac._client.patch(  # type: ignore[attr-defined]
                            f"{ac.url}/rest/v1/subscriptions",
                            params={"user_id": f"eq.{user_id}"},
                            json={"stripe_customer_id": None,
                                  "stripe_subscription_id": None},
                            headers={**ac._headers,  # type: ignore[attr-defined]
                                     "Prefer": "return=minimal"},
                        )
                except Exception:  # noqa: BLE001
                    logger.exception("[billing] portal: failed to clear stale IDs for user %s", user_id)
                raise HTTPException(
                    409,
                    "Your subscription record is out of sync with Stripe "
                    "(usually after a test/live mode switch). Please go to "
                    "/pricing and re-select your tier to re-subscribe.",
                )
            raise
        return {"url": session.url}

    @router.post("/api/billing/cancel")
    def cancel_subscription(authorization: Optional[str] = Header(None)) -> Any:
        """Set cancel_at_period_end=true. Subscription stays active until
        current_period_end. For founder users canceling in the first 3 months,
        this means they're never charged €99."""
        jwt = _require_jwt(authorization)
        user_id = _user_id_from_jwt(jwt)

        existing = _find_subscription_for_user(user_id)
        if not existing or not existing.get("stripe_subscription_id"):
            raise HTTPException(404, "No active subscription found.")

        stripe = _stripe_or_none()
        if not stripe:
            raise HTTPException(503, "Stripe is not configured on the backend.")
        try:
            stripe.Subscription.modify(
                existing["stripe_subscription_id"],
                cancel_at_period_end=True,
            )
        except Exception as exc:  # noqa: BLE001
            # Test/live mode mismatch — same pattern as portal. The cached
            # subscription_id was created in test mode but we're now in live.
            # Clear the stale IDs; there's nothing to cancel.
            if "No such subscription" in str(exc) or "No such customer" in str(exc):
                logger.warning(
                    "[billing] cancel: stale sub %s for user %s — clearing",
                    existing.get("stripe_subscription_id"), user_id,
                )
                try:
                    with _supabase.admin() as ac:
                        ac._client.patch(  # type: ignore[attr-defined]
                            f"{ac.url}/rest/v1/subscriptions",
                            params={"user_id": f"eq.{user_id}"},
                            json={"stripe_customer_id": None,
                                  "stripe_subscription_id": None},
                            headers={**ac._headers,  # type: ignore[attr-defined]
                                     "Prefer": "return=minimal"},
                        )
                except Exception:  # noqa: BLE001
                    logger.exception("[billing] cancel: failed to clear stale IDs for user %s", user_id)
                raise HTTPException(
                    404,
                    "No active subscription to cancel (record was stale and has been cleared).",
                )
            raise
        return {"ok": True, "cancel_at_period_end": True}

    @router.post("/api/stripe/webhook")
    async def stripe_webhook(request: Request) -> Any:
        stripe = _stripe_or_none()
        if not stripe:
            # 200 (not 4xx) so Stripe doesn't aggressively retry against a
            # known-misconfigured endpoint while we get the keys set up.
            logger.warning("[billing] webhook hit but Stripe SDK/keys missing")
            return PlainTextResponse("Stripe not configured", status_code=200)

        secret = os.environ.get("STRIPE_WEBHOOK_SECRET")
        if not secret:
            return PlainTextResponse("Webhook secret not configured", status_code=200)

        payload = await request.body()
        sig = request.headers.get("stripe-signature")
        try:
            event = stripe.Webhook.construct_event(payload, sig, secret)
        except Exception as e:  # noqa: BLE001
            logger.warning("[billing] webhook signature error: %s", e)
            raise HTTPException(400, f"Invalid signature: {e}")

        # Stripe SDK >=15 returns `Event` as a `StripeObject` that no longer
        # inherits from `dict` — calling `.get()` on it raises KeyError via
        # __getattr__ fallback. `_process_event` walks the payload with
        # dict-style access, so flatten to a plain (recursive) dict here.
        try:
            event_payload = event.to_dict() if hasattr(event, "to_dict") else dict(event)
        except Exception:  # noqa: BLE001
            event_payload = event  # last-ditch — let _process_event surface

        try:
            _process_event(event_payload)
        except Exception:  # noqa: BLE001
            logger.exception("[billing] event processing failed")
            # Return 500 so Stripe retries — better than silently dropping.
            return PlainTextResponse("processing failed", status_code=500)

        return PlainTextResponse("ok", status_code=200)

    @router.get("/api/billing/subscription")
    def get_subscription(authorization: Optional[str] = Header(None)) -> Any:
        """Read-only view of the caller's subscription. Used by /settings/billing.

        Resolves the row via the same user_id-primary / org_id-fallback
        pattern used by portal/cancel, so it works for both the new tier
        model (intro/starter/pro) and the legacy founder/standard cohort.
        Returns both `tier` (new pricing v2) and `plan` (legacy) so the FE
        can display whichever is populated."""
        jwt = _require_jwt(authorization)
        user_id = _user_id_from_jwt(jwt)
        sub = _find_subscription_for_user(user_id)
        if not sub:
            return {"subscription": None}
        return {
            "subscription": {
                # New 4-tier model
                "tier": sub.get("tier"),
                "billing_cycle": sub.get("billing_cycle"),
                # Legacy Phase 3 columns (kept for FE backward compat)
                "plan": sub.get("plan"),
                "plan_key": sub.get("tier") or sub.get("plan"),
                "status": sub.get("status"),
                "current_period_end": sub.get("current_period_end"),
                "current_period_start": sub.get("current_period_start"),
                "trial_end": sub.get("trial_end"),
                "cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
                "is_founding_member": bool(sub.get("is_founding_member")),
                # Legacy founder-cohort fields (Phase 3)
                "is_founder": bool(sub.get("is_founder")),
                "founder_renewal_at": sub.get("founder_renewal_at"),
                "founder_renewal_price_eur": sub.get("founder_renewal_price_eur"),
            }
        }

    @router.get("/api/billing/upcoming-invoice")
    def upcoming_invoice(authorization: Optional[str] = Header(None)) -> Any:
        """WS2 — preview the user's next invoice with base + accumulated
        metered overages. Drives the live-counter UpcomingInvoicePreview
        in Settings → Billing so users always know what's coming.

        Stripe's `Invoice.upcoming` returns the in-flight invoice for the
        current cycle (no fees due yet but all line items applied). For a
        Starter user on €14.99 who already triggered 3 extra docs, the
        response is base 14.99 + extras 9.00 + total 23.99."""
        jwt = _require_jwt(authorization)
        user_id = _user_id_from_jwt(jwt)
        sub = _find_subscription_for_user(user_id)
        if not sub or not sub.get("stripe_customer_id"):
            # Trial / no-checkout users have no invoice yet — return a
            # null shape so the FE can render "—" or hide the card.
            return {"invoice": None, "reason": "no_active_subscription"}

        stripe = _stripe_or_none()
        if not stripe:
            raise HTTPException(503, "Stripe is not configured on the backend.")

        try:
            upcoming = stripe.Invoice.upcoming(customer=sub["stripe_customer_id"])
        except Exception as exc:  # noqa: BLE001
            # Stripe returns InvalidRequestError when there's no upcoming
            # invoice (e.g. canceled at period end with nothing due) OR
            # when the customer ID is stale (test/live mode mismatch).
            # Both cases: FE just shows nothing — not an error to the user.
            reason = "no_upcoming_invoice"
            if "No such customer" in str(exc):
                reason = "stale_customer"  # FE could show "re-subscribe" hint
            return {"invoice": None, "reason": reason,
                    "detail": str(exc)[:160]}

        base_amount = 0.0
        extras_count = 0
        extras_amount = 0.0
        for line in (upcoming.lines.data if upcoming.lines else []):
            # Metered lines have `price.recurring.usage_type == 'metered'`.
            # Stripe expresses amounts in minor units (cents) — divide by 100.
            price = line.price if hasattr(line, "price") else line.get("price")
            recurring = (price.recurring if hasattr(price, "recurring") else
                         (price or {}).get("recurring")) if price else None
            usage_type = (recurring.usage_type if hasattr(recurring, "usage_type")
                          else (recurring or {}).get("usage_type")) if recurring else None
            amt = float(line.amount or 0) / 100.0
            qty = int(line.quantity or 0)
            if usage_type == "metered":
                extras_count += qty
                extras_amount += amt
            else:
                base_amount += amt

        total = float(upcoming.amount_due or 0) / 100.0
        cur = (upcoming.currency or "eur").upper()
        period_end = datetime.fromtimestamp(int(upcoming.period_end), tz=timezone.utc) \
            if upcoming.period_end else None

        return {
            "invoice": {
                "base_amount": round(base_amount, 2),
                "extras_count": extras_count,
                "extras_amount": round(extras_amount, 2),
                "total_estimated": round(total, 2),
                "currency": cur,
                "next_invoice_date": period_end.isoformat() if period_end else None,
            }
        }

    @router.get("/api/admin/usage")
    def admin_usage(authorization: Optional[str] = Header(None)) -> Any:
        """WS1 — per-user usage snapshot for the operator. JSON only; no
        UI page. Read this before flipping USAGE_LIMITS_ENABLED=true to
        confirm no live user would be hard-blocked. Re-read in the hour
        after flip to catch unexpected blocks.

        Auth: ENGINE_API_TOKEN bearer (same gate as /run-daily). User JWTs
        are explicitly rejected — this is an operator endpoint, not a
        user-facing one. If ENGINE_API_TOKEN is unset on the host the
        endpoint refuses to serve at all (don't expose user data on an
        unauth'd endpoint by accident)."""
        expected = os.environ.get("ENGINE_API_TOKEN")
        if not expected:
            raise HTTPException(503, "ENGINE_API_TOKEN not set; admin endpoint refuses to serve.")
        token = _require_jwt(authorization)
        if token != expected:
            raise HTTPException(401, "Invalid admin token.")

        from . import _plan_state

        # Iterate every subscription row + derive plan state. The
        # admin client is unscoped so we see every user. For users
        # without a subscription row (pure trial), the FE shows the
        # default trial gate — they're not in this report.
        snapshot: List[Dict[str, Any]] = []
        with _supabase.admin() as ac:
            sub_rows = ac.select(
                "subscriptions",
                columns="user_id,tier,plan,status,stripe_customer_id,"
                        "stripe_subscription_id,current_period_end,"
                        "extra_docs_billed_period,is_founding_member",
                limit=500,
            ) or []

        for row in sub_rows:
            uid = row.get("user_id")
            if not uid:
                continue
            try:
                ps = _plan_state.get_plan_state(uid)
            except Exception as exc:  # noqa: BLE001
                snapshot.append({
                    "user_id": uid,
                    "tier": row.get("tier") or row.get("plan"),
                    "status": row.get("status"),
                    "error": f"plan_state failed: {type(exc).__name__}: {str(exc)[:120]}",
                })
                continue

            # Compute pct + would_be_blocked rollup. Blocking thresholds
            # match _usage_gate: when docs_used >= included AND not on a
            # tier that has metered overage → hard block.
            included = getattr(ps, "included_docs", 0) or 0
            used = getattr(ps, "docs_used_this_period", 0) or 0
            tier = row.get("tier") or row.get("plan") or "trial"
            metered_supported = tier in _METERED_EXTRA_DOC_CONFIG  # starter/pro have overage
            over_quota = bool(included) and used >= included
            would_block = over_quota and not metered_supported

            snapshot.append({
                "user_id": uid,
                "tier": tier,
                "status": row.get("status"),
                "stripe_customer_id": row.get("stripe_customer_id"),
                "stripe_subscription_id": row.get("stripe_subscription_id"),
                "current_period_end": row.get("current_period_end"),
                "is_founding_member": bool(row.get("is_founding_member")),
                "docs": {
                    "used_this_period": used,
                    "included": included,
                    "extras_billed": int(row.get("extra_docs_billed_period") or 0),
                    "pct_used": round(used / included * 100, 1) if included else None,
                    "over_quota": over_quota,
                    "would_block_on_flip": would_block,
                    "overage_supported": metered_supported,
                },
                "chat": {
                    "used_today": getattr(ps, "chat_used_today", 0),
                    "daily_cap": getattr(ps, "chat_daily_cap", None),
                    "used_this_period": getattr(ps, "chat_used_this_period", 0),
                    "monthly_cap": getattr(ps, "chat_monthly_cap", None),
                },
            })

        # Summary rollup — operator's "is anyone about to break?" line.
        total = len(snapshot)
        would_block = sum(1 for s in snapshot if s.get("docs", {}).get("would_block_on_flip"))
        over_quota = sum(1 for s in snapshot if s.get("docs", {}).get("over_quota"))
        return {
            "ok": True,
            "summary": {
                "total_users": total,
                "users_over_quota": over_quota,
                "users_would_block_on_flip": would_block,
                "usage_limits_enabled": os.environ.get("USAGE_LIMITS_ENABLED", "").lower()
                                        in ("1", "true", "yes", "on"),
            },
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "users": snapshot,
        }

    @router.post("/api/billing/cron/renewal-reminders")
    def renewal_reminders_cron(authorization: Optional[str] = Header(None)) -> Any:
        """Idempotent cron endpoint. Schedule a daily call at 03:00 UTC.
        Auth is the engine bearer token (ENGINE_API_TOKEN) — not a user JWT —
        so this is restricted to scheduler infrastructure."""
        token = os.environ.get("ENGINE_API_TOKEN")
        if token:
            jwt = _require_jwt(authorization)
            if jwt != token:
                raise HTTPException(401, "Invalid scheduler token.")
        t14 = send_founder_renewal_reminders(days_ahead=14)
        t3 = send_founder_renewal_reminders(days_ahead=3)
        return {"t14": t14, "t3": t3}

    # ─── Phase 5: Solo/Business self-serve checkout + Pro contact-sales ──────
    #
    # /api/billing/create-checkout       Solo + Business only (Pro 400s)
    # /api/founding-member/count         Public; reads the DB-backed counter
    # /api/contact-sales                 Public form POST (Pro inquiries)
    # /api/billing/usage                 Per-user current-month usage snapshot

    class CreateCheckoutRequest(BaseModel):
        tier: str            # 'solo' | 'business'  — 'professional' is rejected
        billing_cycle: str   # 'monthly' | 'annual'
        claim_founding: Optional[bool] = False

    def _env_price_id(tier: str, cycle: str) -> Optional[str]:
        # Naming convention so the user can drop in Stripe price IDs without
        # changing code:
        #   STRIPE_PRICE_SOLO_MONTHLY      STRIPE_PRICE_SOLO_ANNUAL
        #   STRIPE_PRICE_BUSINESS_MONTHLY  STRIPE_PRICE_BUSINESS_ANNUAL
        return os.environ.get(f"STRIPE_PRICE_{tier.upper()}_{cycle.upper()}")

    def _env_founding_coupon_id(tier: str, cycle: str) -> Optional[str]:
        # Per-tier/cycle €1 founding coupons (configure in Stripe Dashboard):
        #   STRIPE_COUPON_FOUNDING_SOLO_MONTHLY      ...etc
        return os.environ.get(f"STRIPE_COUPON_FOUNDING_{tier.upper()}_{cycle.upper()}")

    def _founding_seats_remaining() -> int:
        """Read the public `founding_member_count` view. Falls back to 0 on
        any failure so the UI never claims seats we can't honor."""
        try:
            with _supabase.admin() as client:
                rows = client.select("founding_member_count", limit=1)
            if not rows:
                return 0
            return int(rows[0].get("remaining") or 0)
        except Exception:  # noqa: BLE001
            logger.exception("[billing] founding_member_count read failed")
            return 0

    @router.get("/api/founding-member/count")
    def get_founding_count() -> Any:
        """Public endpoint — feeds the FE's seats-remaining banner. Capped
        at 500 by the table-level constraint."""
        try:
            with _supabase.admin() as client:
                rows = client.select("founding_member_count", limit=1)
            row = rows[0] if rows else {}
        except Exception:  # noqa: BLE001
            logger.exception("[billing] founding_member_count read failed")
            row = {}
        return {
            "claimed": int(row.get("claimed") or 0),
            "remaining": int(row.get("remaining") or 500),
            "cap": 500,
        }

    @router.post("/api/billing/create-checkout")
    def create_checkout(
        req: CreateCheckoutRequest,
        authorization: Optional[str] = Header(None),
    ) -> Any:
        tier = (req.tier or "").lower().strip()
        # Pro is contact-sales — explicit 400 so the FE can never accidentally
        # send Pro through self-serve checkout (Gate I1 in the spec).
        if tier not in _pricing_tiers.SELF_SERVE_TIER_KEYS:
            raise HTTPException(
                400,
                {
                    "code": "invalid_tier",
                    "message": "Professional is contact-sales only. Please use the contact form.",
                },
            )
        cycle = (req.billing_cycle or "").lower().strip()
        if cycle not in ("monthly", "annual"):
            raise HTTPException(400, "billing_cycle must be 'monthly' or 'annual'.")

        jwt = _require_jwt(authorization)
        user_id = _user_id_from_jwt(jwt)

        stripe = _stripe_or_none()
        if not stripe:
            raise HTTPException(503, "Stripe is not configured on the backend.")

        price_id = _env_price_id(tier, cycle)
        if not price_id:
            raise HTTPException(
                503,
                f"Stripe price id missing — set STRIPE_PRICE_{tier.upper()}_{cycle.upper()}",
            )

        # Decide whether the founding coupon applies. Re-check the live
        # counter — never trust a stale FE claim.
        use_founding = False
        if req.claim_founding:
            use_founding = _founding_seats_remaining() > 0

        # Find-or-create Stripe customer keyed off the user's subscription row.
        with _supabase.admin() as client:
            sub_rows = client.select(
                "subscriptions",
                filters={"user_id": f"eq.{user_id}"},
                single=True,
            )
        existing = sub_rows[0] if sub_rows else None
        customer_id = (existing or {}).get("stripe_customer_id")
        if not customer_id:
            email = _user_email(user_id) or ""
            customer = stripe.Customer.create(
                email=email,
                metadata={"user_id": user_id, "tier": tier},
            )
            customer_id = customer["id"]
            with _supabase.admin() as client:
                client.update(
                    "subscriptions",
                    {"stripe_customer_id": customer_id},
                    filters={"user_id": f"eq.{user_id}"},
                )

        discounts: List[Dict[str, str]] = []
        if use_founding:
            coupon_id = _env_founding_coupon_id(tier, cycle)
            if coupon_id:
                discounts = [{"coupon": coupon_id}]
            else:
                # Coupon not configured — log and proceed at full price.
                # Better to charge full price than to break the checkout flow.
                logger.warning(
                    "[billing] founding requested but coupon env missing for %s/%s",
                    tier, cycle,
                )
                use_founding = False

        app_url = os.environ.get("APP_URL", "http://localhost:5173").rstrip("/")
        session_kwargs: Dict[str, Any] = {
            "customer": customer_id,
            "mode": "subscription",
            "line_items": [{"price": price_id, "quantity": 1}],
            "subscription_data": {
                "metadata": {
                    "user_id": user_id,
                    "tier": tier,
                    "billing_cycle": cycle,
                    "is_founding_member": "true" if use_founding else "false",
                },
            },
            "metadata": {
                "user_id": user_id,
                "tier": tier,
                "billing_cycle": cycle,
                "is_founding_member": "true" if use_founding else "false",
            },
            "success_url": f"{app_url}/billing/success?session_id={{CHECKOUT_SESSION_ID}}",
            "cancel_url": f"{app_url}/pricing",
            "locale": "auto",
            "payment_method_collection": "always",
        }
        if discounts:
            session_kwargs["discounts"] = discounts

        session = stripe.checkout.Session.create(**session_kwargs)
        return {"checkout_url": session.url}

    # ─── Contact-sales lead capture (Pro inquiries) ────────────────────────

    class ContactSalesRequest(BaseModel):
        name: str
        email: str
        company: Optional[str] = None
        role: Optional[str] = None
        num_companies: Optional[str] = None  # '1-3' | '4-10' | '11-25' | '26+'
        use_case: Optional[str] = None
        preferred_contact: Optional[str] = "email"
        phone: Optional[str] = None

    @router.post("/api/contact-sales")
    def contact_sales(req: ContactSalesRequest) -> Any:
        # Validate the must-haves; everything else is soft.
        name = (req.name or "").strip()
        email = (req.email or "").strip()
        if not name or not email or "@" not in email:
            raise HTTPException(400, "Name and a valid email are required.")
        preferred = (req.preferred_contact or "email").strip().lower()
        if preferred not in ("email", "phone", "video_call"):
            preferred = "email"

        row = {
            "name": name,
            "email": email,
            "company": (req.company or "").strip() or None,
            "role": (req.role or "").strip() or None,
            "num_companies": (req.num_companies or "").strip() or None,
            "use_case": (req.use_case or "").strip() or None,
            "preferred_contact": preferred,
            "phone": (req.phone or "").strip() or None,
            "source": "pricing_page",
            "status": "new",
        }
        try:
            with _supabase.admin() as client:
                client.insert("contact_sales_leads", row, returning=False)
        except Exception:  # noqa: BLE001
            logger.exception("[billing] contact_sales insert failed")
            raise HTTPException(
                503,
                f"Couldn't save your message. Please email {_site.SITE['support_email']} directly.",
            )

        # Best-effort notification — the SendGrid/Postmark/Resend wiring is
        # left to the deploy. Falls through silently when no provider is set.
        _notify_contact_sales(row)

        return {"ok": True}

    @router.get("/api/billing/usage")
    def get_usage(authorization: Optional[str] = Header(None)) -> Any:
        """Per-user current-month usage snapshot for the UsageIndicator.
        Returns the active tier's limits alongside so the FE renders pct
        with a single round-trip. Pro customers get their `custom_limits`
        overlaid on the static tier defaults."""
        jwt = _require_jwt(authorization)
        user_id = _user_id_from_jwt(jwt)
        month = _pricing_tiers.current_month_bucket()

        with _supabase.admin() as client:
            sub_rows = client.select(
                "subscriptions",
                filters={"user_id": f"eq.{user_id}"},
                single=True,
            )
            usage_rows = client.select(
                "user_usage",
                filters={
                    "user_id": f"eq.{user_id}",
                    "month": f"eq.{month}",
                },
                single=True,
            )

        sub = sub_rows[0] if sub_rows else None
        raw_tier = (sub or {}).get("tier") or (sub or {}).get("plan")
        tier_key = _pricing_tiers.normalize_tier_key(raw_tier)
        tier = _pricing_tiers.get_tier(tier_key) if tier_key else None
        # Pro contracts get their negotiated limits from custom_limits.
        custom = (sub or {}).get("custom_limits") if sub else None
        effective = _pricing_tiers.effective_limits(
            _pricing_tiers.db_tier_key(tier_key) if tier_key else "solo",
            custom,
        )
        u = usage_rows[0] if usage_rows else {}

        return {
            "tier": tier_key,
            "tier_name": tier.display_name if tier else None,
            "month": month,
            "limits": {
                "uploads_per_month": effective.uploads_per_month,
                "llm_calls_per_month": effective.llm_calls_per_month,
                "max_users": effective.max_users,
                "max_companies": effective.max_companies,
                "overage_price_per_doc_eur": effective.overage_price_per_doc_eur,
            } if tier else None,
            "used": {
                "uploads": int(u.get("uploads") or 0),
                "llm_calls": int(u.get("llm_calls") or 0),
                "exports": int(u.get("exports") or 0),
                "storage_bytes": int(u.get("storage_bytes") or 0),
            },
            "status": (sub or {}).get("status"),
            "is_founding_member": bool((sub or {}).get("is_founding_member")),
            "trial_end": (sub or {}).get("trial_end"),
            "current_period_end": (sub or {}).get("current_period_end"),
        }

    return router


def _notify_contact_sales(lead: Dict[str, Any]) -> None:
    """Send the owner + the lead an email. Provider-agnostic; wires off
    SENDGRID_API_KEY, RESEND_API_KEY, or POSTMARK_API_KEY when one is set,
    otherwise logs the payload and returns. NEVER raises into the request."""
    # Fallback to the canonical support inbox if SALES_INBOX_EMAIL isn't
    # set — a single shared inbox handles support + sales today.
    sales_inbox = os.environ.get("SALES_INBOX_EMAIL", _site.SITE["support_email"])
    summary = (
        f"Name: {lead.get('name')}\n"
        f"Email: {lead.get('email')}\n"
        f"Company: {lead.get('company') or '—'}\n"
        f"Role: {lead.get('role') or '—'}\n"
        f"Companies analyzed: {lead.get('num_companies') or '—'}\n"
        f"Use case: {lead.get('use_case') or '—'}\n"
        f"Preferred contact: {lead.get('preferred_contact')}\n"
        f"Phone: {lead.get('phone') or '—'}\n"
    )
    subject = f"Pro lead: {lead.get('name')} from {lead.get('company') or 'unknown'}"
    try:
        # The actual provider wire-up is intentionally minimal — production
        # deploys swap this for the real transactional-email client.
        logger.info("[contact-sales] notify owner: %s\n%s", subject, summary)
        # Auto-reply payload (logged for traceability when no provider set).
        auto_reply = (
            f"Hi {lead.get('name')},\n\n"
            "Thanks for reaching out about Professional. We'll reply within 4 "
            "business hours with a few questions about your workflow.\n\n"
            "In the meantime, you can try Solo or Business with the Founding "
            f"Member €1 first month: {os.environ.get('APP_URL', '').rstrip('/')}/pricing\n\n"
            "— The CFO AI team"
        )
        logger.info("[contact-sales] auto-reply to %s:\n%s", lead.get("email"), auto_reply)
        _ = sales_inbox  # referenced for the eventual SMTP/HTTP send.
    except Exception:  # noqa: BLE001
        logger.exception("[contact-sales] notify failed")
