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

from . import _pricing_tiers, _supabase


logger = logging.getLogger(__name__)


# ─── Helpers ────────────────────────────────────────────────────────────────


def _require_jwt(authorization: Optional[str]) -> str:
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
    with _supabase.per_user(jwt) as client:
        user = client.get_user(jwt)
    user_id = user.get("id") if user else None
    if not user_id:
        raise HTTPException(401, "Could not resolve user from JWT.")
    return user_id


def _primary_org_for_user(user_id: str) -> Optional[Dict[str, Any]]:
    with _supabase.admin() as client:
        rows = client.select(
            "memberships",
            filters={"user_id": f"eq.{user_id}"},
            limit=1,
        )
        if not rows:
            return None
        org_rows = client.select(
            "organizations",
            filters={"id": f"eq.{rows[0]['org_id']}"},
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
    if not customer_id:
        customer = stripe.Customer.create(
            email=email or "",
            metadata={"user_id": user_id, **({"org_id": org_id} if org_id else {})},
        )
        customer_id = customer["id"]

    session_kwargs: Dict[str, Any] = {
        "customer": customer_id,
        "mode": config["mode"],
        "line_items": [{"price": price, "quantity": 1}],
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
        # Portal session ends → land back on /settings where BillingSection
        # is rendered. We don't have a dedicated /settings/billing route
        # today; the page-level Settings surface is the single billing
        # entry point.
        session = stripe.billing_portal.Session.create(
            customer=existing["stripe_customer_id"],
            return_url=f"{app_url}/settings",
        )
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
        stripe.Subscription.modify(
            existing["stripe_subscription_id"],
            cancel_at_period_end=True,
        )
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
            raise HTTPException(503, "Couldn't save your message. Please email hello@cfoai.app directly.")

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
    sales_inbox = os.environ.get("SALES_INBOX_EMAIL", "hello@cfoai.app")
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
