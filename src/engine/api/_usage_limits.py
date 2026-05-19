"""Phase 5 — Per-user monthly usage enforcement.

Counts uploads, LLM calls, and exports per user per calendar month against
the limits defined in `_pricing_tiers.TIERS`. Caps our Anthropic API spend
and storage cost without us having to babysit individual accounts.

Architecture
------------
1. Every protected route calls `check_quota(user_id, action)` BEFORE doing
   work. If the user is over their limit, raise a 429 with a clear error
   payload the FE can render ("Upgrade to keep going").
2. After the action succeeds, the route calls `record_usage(user_id, action)`
   to bump the counter atomically (PostgREST → `increment_user_usage` RPC).

The middleware is env-flag gated: when `USAGE_LIMITS_ENABLED != 'true'` every
call is a no-op so we can ship the code without breaking existing users
while we still iterate on the Stripe side. Flip the flag once the migration
has been applied AND the pricing page is live.

NOTE: `record_usage` is best-effort — if the counter bump fails (network
blip, RPC missing), we LOG and continue rather than failing the user's
action. We'd rather under-bill than reject a paid request because Supabase
hiccupped.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Literal, Optional

from fastapi import HTTPException

from . import _pricing_tiers, _supabase


logger = logging.getLogger(__name__)


ActionKind = Literal["upload", "llm_call", "export"]


def usage_limits_enabled() -> bool:
    """Master kill-switch. Off by default so deploying this code does not
    block any existing user — flip via env once you're ready to enforce."""
    return os.environ.get("USAGE_LIMITS_ENABLED", "").strip().lower() in (
        "1", "true", "yes", "on",
    )


def _fetch_active_tier_and_usage(
    user_id: str,
    month: str,
) -> tuple[Optional[_pricing_tiers.Tier], _pricing_tiers.TierLimits, Dict[str, int]]:
    """Pull the user's active tier + current-month counters. Returns
    `(None, default_limits, {...})` when the user has no subscription row.
    Pro contracts get their `custom_limits` overlay applied here."""
    tier: Optional[_pricing_tiers.Tier] = None
    effective: _pricing_tiers.TierLimits = _pricing_tiers.TIERS["solo"].limits
    counters = {"uploads": 0, "llm_calls": 0, "exports": 0, "storage_bytes": 0}
    try:
        with _supabase.admin() as client:
            sub_rows = client.select(
                "subscriptions",
                filters={"user_id": f"eq.{user_id}"},
                single=True,
            )
            if sub_rows:
                row = sub_rows[0]
                raw_tier = row.get("tier") or row.get("plan")
                tier = _pricing_tiers.get_tier(raw_tier)
                custom = row.get("custom_limits") or None
                tier_key = _pricing_tiers.db_tier_key(tier.key) if tier else "solo"
                effective = _pricing_tiers.effective_limits(tier_key, custom)

            usage_rows = client.select(
                "user_usage",
                filters={
                    "user_id": f"eq.{user_id}",
                    "month": f"eq.{month}",
                },
                single=True,
            )
            if usage_rows:
                u = usage_rows[0]
                counters["uploads"] = int(u.get("uploads") or 0)
                counters["llm_calls"] = int(u.get("llm_calls") or 0)
                counters["exports"] = int(u.get("exports") or 0)
                counters["storage_bytes"] = int(u.get("storage_bytes") or 0)
    except Exception:  # noqa: BLE001
        logger.exception("[usage] tier/usage lookup failed for user=%s", user_id)
        # Fail open: if we can't fetch the row, let the action through.
        return None, effective, counters

    return tier, effective, counters


def _limit_for(limits: _pricing_tiers.TierLimits, action: ActionKind) -> Optional[int]:
    if action == "upload":
        return limits.uploads_per_month
    if action == "llm_call":
        return limits.llm_calls_per_month
    return None  # No hard cap on exports in this spec.


def _column_for(action: ActionKind) -> str:
    if action == "upload":
        return "uploads"
    if action == "llm_call":
        return "llm_calls"
    return "exports"


def check_quota(user_id: str, action: ActionKind) -> Dict[str, Any]:
    """Raise HTTPException(429) if the user has hit their limit for `action`
    this calendar month. Returns the usage snapshot so callers can echo it
    in their response if useful.

    No-op when USAGE_LIMITS_ENABLED is off — returns an empty snapshot.
    """
    if not usage_limits_enabled():
        return {"enforced": False}

    month = _pricing_tiers.current_month_bucket()
    tier, effective, counters = _fetch_active_tier_and_usage(user_id, month)

    if tier is None:
        # Unknown / missing tier — fail open so the user isn't blocked by
        # our own state corruption. The webhook should ensure every paid
        # user has a row; pre-payment users get tier-less and we let them
        # through during the trial.
        return {"enforced": False, "reason": "no_active_tier"}

    cap = _limit_for(effective, action)
    used = counters[_column_for(action)]

    if cap is None:
        return {"enforced": True, "tier": tier.key, "used": used, "cap": None}

    if used >= cap:
        overage_eur = effective.overage_price_per_doc_eur if action == "upload" else None
        raise HTTPException(
            status_code=429,
            detail={
                "code": "usage_limit_exceeded",
                "action": action,
                "tier": tier.key,
                "tier_name": tier.display_name,
                "used": used,
                "cap": cap,
                "month": month,
                "overage_available": overage_eur is not None,
                "overage_price_eur": overage_eur,
                "upgrade_url": "/pricing",
                "message": (
                    f"You've used all {cap} {action.replace('_', ' ')}s on the "
                    f"{tier.display_name} plan this month. "
                    + (
                        f"Buy extras at €{overage_eur}/document or upgrade to keep going."
                        if overage_eur is not None
                        else "Upgrade to keep going."
                    )
                ),
            },
        )

    return {
        "enforced": True,
        "tier": tier.key,
        "used": used,
        "cap": cap,
        "month": month,
    }


def record_usage(user_id: str, action: ActionKind, amount: int = 1) -> None:
    """Atomically increment the user's counter via the `increment_user_usage`
    RPC. Best-effort: failure is logged, never re-raised.

    No-op when USAGE_LIMITS_ENABLED is off."""
    if not usage_limits_enabled():
        return
    if amount <= 0:
        return

    column = _column_for(action)
    month = _pricing_tiers.current_month_bucket()

    try:
        with _supabase.admin() as client:
            r = client._client.post(  # type: ignore[attr-defined]
                f"{client.url}/rest/v1/rpc/increment_user_usage",
                json={
                    "p_user_id": user_id,
                    "p_month": month,
                    "p_action": column,
                    "p_amount": amount,
                },
                headers=client._headers,  # type: ignore[attr-defined]
            )
            if r.status_code >= 400:
                logger.warning(
                    "[usage] RPC increment_user_usage failed: %s %s",
                    r.status_code, r.text[:300],
                )
    except Exception:  # noqa: BLE001
        logger.exception("[usage] record_usage failed user=%s action=%s", user_id, action)


def record_storage_bytes(user_id: str, delta_bytes: int) -> None:
    """Storage isn't blocking on its own — it's reported to the UI for
    capacity awareness. Treated like other counters here for atomic bumps."""
    if not usage_limits_enabled():
        return
    if delta_bytes == 0:
        return
    month = _pricing_tiers.current_month_bucket()
    try:
        with _supabase.admin() as client:
            r = client._client.post(  # type: ignore[attr-defined]
                f"{client.url}/rest/v1/rpc/increment_user_usage",
                json={
                    "p_user_id": user_id,
                    "p_month": month,
                    "p_action": "storage_bytes",
                    "p_amount": int(delta_bytes),
                },
                headers=client._headers,  # type: ignore[attr-defined]
            )
            if r.status_code >= 400:
                logger.warning(
                    "[usage] storage_bytes RPC failed: %s %s",
                    r.status_code, r.text[:300],
                )
    except Exception:  # noqa: BLE001
        logger.exception("[usage] record_storage_bytes failed user=%s", user_id)
