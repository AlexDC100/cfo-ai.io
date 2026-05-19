"""Plan state — read/write the per-user plan + usage counters.

PAIRS WITH
  · `_pricing_config.py` (the tier definitions)
  · `_usage_limits.py`   (existing monthly counters via `user_usage`)
  · `supabase/schema_phase_pricing_v2.sql` (additive columns + new table)

WHAT THIS PROVIDES
==================
  get_plan_state(user_id) -> PlanState
      One read that resolves the user's current plan, billing anchor,
      intro-unlock expiry, monthly doc usage, daily+monthly chat usage.
      Read-only — never writes.

  check_doc_quota(user_id) -> DocQuotaDecision
      Returns ALLOWED / EXTRA_DOC_BILL_PROMPT / BLOCKED. Caller must
      honour the decision BEFORE invoking the analysis pipeline.

  record_doc_consumed(user_id, billed_extra: bool) -> None
      Bumps the appropriate monthly counter. Idempotent failure mode:
      logs + continues (matches `_usage_limits.record_usage`).

  check_chat_cap(user_id) -> ChatCapDecision
      Returns ALLOWED / DAILY_CAP_REACHED / MONTHLY_CAP_REACHED. Caller
      MUST call BEFORE the Opus API request — the spec is explicit that
      tokens must not be spent on a request that's about to be rejected.

  record_chat_used(user_id) -> None
      Bumps daily + monthly counters atomically (two RPC calls).

DESIGN NOTES
============
· The plan-state read uses the existing `subscriptions` + `user_usage`
  tables. Daily chat counter uses the new `plan_chat_daily_usage` table
  added by the V2 migration.
· The new tier keys (trial/intro/starter/pro) co-exist with legacy
  keys (solo/business/professional) via `_pricing_config.plan_for()`.
· When `USAGE_LIMITS_ENABLED` is not flipped on, every check returns
  ALLOWED so deploying this code is non-breaking. The kill-switch
  matches `_usage_limits.py` exactly.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any, Dict, Literal, Optional

from . import _pricing_config, _pricing_tiers, _supabase


logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Master kill-switch — shared with _usage_limits
# ──────────────────────────────────────────────────────────────────────

def enforcement_enabled() -> bool:
    """Mirror of `_usage_limits.usage_limits_enabled` — both gate on
    the SAME env var so a single flip enables the whole limit stack."""
    return os.environ.get("USAGE_LIMITS_ENABLED", "").strip().lower() in (
        "1", "true", "yes", "on",
    )


# ──────────────────────────────────────────────────────────────────────
# Shapes
# ──────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class PlanState:
    """Everything a caller needs to know about a user's billing state."""
    user_id: str
    plan_key: _pricing_config.PlanKey
    plan: _pricing_config.PlanConfig
    # Trial / Intro one-shot windows. None when on a recurring plan.
    window_expires_at: Optional[datetime]
    # docs already consumed in the current period (monthly for recurring,
    # cumulative for trial/intro).
    docs_used_this_period: int
    extra_docs_billed_this_period: int
    chat_used_today: int
    chat_used_this_period: int
    # Useful for the FE — when the next reset happens (date for daily,
    # YYYY-MM string for monthly).
    today_iso: str
    period_month_bucket: str
    # Pricing V3 (gap D) — confirmed extras whose analysis is still
    # running. Counted toward usage display but not yet billed; the
    # commit_user_upload(was_extra=True) RPC moves the count from
    # pending → billed on analysis success.
    # Placed at the end of the field list (with a default) so existing
    # call sites that don't pass it keep working — `frozen=True` +
    # required positional args break otherwise.
    extra_docs_pending_this_period: int = 0


DocQuotaDecisionKind = Literal["allowed", "extra_doc_bill_prompt", "blocked"]


@dataclass(frozen=True)
class DocQuotaDecision:
    kind: DocQuotaDecisionKind
    plan_key: str
    docs_used: int
    docs_included: int
    extra_doc_eur: Optional[float]
    message: str


ChatCapDecisionKind = Literal["allowed", "daily_cap_reached", "monthly_cap_reached"]


@dataclass(frozen=True)
class ChatCapDecision:
    kind: ChatCapDecisionKind
    plan_key: str
    daily_used: int
    daily_cap: Optional[int]
    monthly_used: int
    monthly_cap: Optional[int]
    message: str


# ──────────────────────────────────────────────────────────────────────
# Read — plan state
# ──────────────────────────────────────────────────────────────────────

def _today() -> date:
    return datetime.now(timezone.utc).date()


def _month_bucket(d: Optional[date] = None) -> str:
    d = d or _today()
    return d.strftime("%Y-%m")


def get_plan_state(user_id: str) -> PlanState:
    """Single read that resolves the user's billing state. Failures
    degrade to the trial tier — better to under-bill than to reject
    a paying user because Supabase hiccupped."""
    plan: Optional[_pricing_config.PlanConfig] = None
    window_expires_at: Optional[datetime] = None
    docs_used = 0
    extra_docs_billed = 0
    extra_docs_pending = 0
    chat_used_today = 0
    chat_used_month = 0
    today = _today()
    month = _month_bucket(today)

    try:
        with _supabase.admin() as client:
            # subscriptions row — current plan + windows
            sub_rows = client.select(
                "subscriptions",
                filters={"user_id": f"eq.{user_id}"},
                single=True,
            )
            if sub_rows:
                row = sub_rows[0]
                raw_tier = row.get("tier") or row.get("plan") or ""
                plan = _pricing_config.plan_for(str(raw_tier))
                expires_raw = row.get("intro_unlock_expiry")
                if expires_raw:
                    try:
                        window_expires_at = _parse_ts(expires_raw)
                    except Exception:  # noqa: BLE001
                        window_expires_at = None
                extra_docs_billed = int(row.get("extra_docs_billed_period") or 0)
                # V3 — pending extras (reserved + confirmed but
                # analysis not yet successful). Field may be absent
                # on V2-only deployments.
                extra_docs_pending = int(row.get("extra_docs_pending") or 0)

            # user_usage row — monthly counters (uploads + llm_calls)
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
                docs_used = int(u.get("uploads") or 0)
                chat_used_month = int(u.get("llm_calls") or 0)

            # plan_chat_daily_usage row — today's chat counter
            try:
                daily_rows = client.select(
                    "plan_chat_daily_usage",
                    filters={
                        "user_id": f"eq.{user_id}",
                        "day": f"eq.{today.isoformat()}",
                    },
                    single=True,
                )
                if daily_rows:
                    chat_used_today = int(daily_rows[0].get("count") or 0)
            except Exception:  # noqa: BLE001
                # Table may not exist yet (migration not yet applied) —
                # degrade silently to "no daily counter".
                chat_used_today = 0

    except Exception:  # noqa: BLE001
        logger.exception("[plan-state] read failed for user=%s — degrading to trial", user_id)

    if plan is None:
        plan = _pricing_config.CONFIG.plans["trial"]

    return PlanState(
        user_id=user_id,
        plan_key=plan.key,
        plan=plan,
        window_expires_at=window_expires_at,
        docs_used_this_period=docs_used,
        extra_docs_billed_this_period=extra_docs_billed,
        extra_docs_pending_this_period=extra_docs_pending,
        chat_used_today=chat_used_today,
        chat_used_this_period=chat_used_month,
        today_iso=today.isoformat(),
        period_month_bucket=month,
    )


def _parse_ts(raw: Any) -> datetime:
    """Tolerate both string ISO and datetime values from PostgREST."""
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    s = str(raw).replace("Z", "+00:00")
    return datetime.fromisoformat(s)


# ──────────────────────────────────────────────────────────────────────
# Document quota
# ──────────────────────────────────────────────────────────────────────

def check_doc_quota(user_id: str) -> DocQuotaDecision:
    """Decide whether to allow an upload + analysis for `user_id`.

      · ALLOWED                     — within the included quota, proceed.
      · EXTRA_DOC_BILL_PROMPT       — over quota AND the plan allows
                                       extras. Caller must surface a
                                       confirmation dialog showing the
                                       price; only on explicit confirm
                                       should the caller charge + proceed.
      · BLOCKED                     — over quota AND no extras allowed
                                       (trial / intro). Caller must show
                                       upgrade prompt.
    """
    if not enforcement_enabled():
        # Kill-switch off — every call passes through.
        return DocQuotaDecision(
            kind="allowed", plan_key="trial", docs_used=0, docs_included=0,
            extra_doc_eur=None, message="",
        )

    state = get_plan_state(user_id)
    plan = state.plan

    if state.docs_used_this_period < plan.included_docs:
        return DocQuotaDecision(
            kind="allowed",
            plan_key=plan.key,
            docs_used=state.docs_used_this_period,
            docs_included=plan.included_docs,
            extra_doc_eur=plan.extra_doc_eur,
            message="",
        )

    # Over quota.
    if plan.extra_doc_eur is None:
        # Trial / intro / any plan that disallows overage.
        msg = (
            f"You've used all {plan.included_docs} document"
            f"{'s' if plan.included_docs != 1 else ''} on the "
            f"{plan.display_name} plan. Upgrade to keep going."
        )
        return DocQuotaDecision(
            kind="blocked",
            plan_key=plan.key,
            docs_used=state.docs_used_this_period,
            docs_included=plan.included_docs,
            extra_doc_eur=None,
            message=msg,
        )

    msg = (
        f"This will be an extra document. €{plan.extra_doc_eur:.2f} "
        f"will be charged. Confirm to proceed."
    )
    return DocQuotaDecision(
        kind="extra_doc_bill_prompt",
        plan_key=plan.key,
        docs_used=state.docs_used_this_period,
        docs_included=plan.included_docs,
        extra_doc_eur=plan.extra_doc_eur,
        message=msg,
    )


def record_doc_consumed(user_id: str, *, billed_extra: bool) -> None:
    """Bump the user's doc counter after a successful analysis run.

    When `billed_extra=True`, ALSO bump `subscriptions.extra_docs_billed_period`
    so the next renewal invoice sees the extras tally.
    """
    if not enforcement_enabled():
        return

    # Reuse the existing RPC for the monthly counter.
    try:
        from . import _usage_limits
        _usage_limits.record_usage(user_id, "upload")
    except Exception:  # noqa: BLE001
        logger.exception("[plan-state] record monthly upload failed user=%s", user_id)

    if not billed_extra:
        return

    # Increment the extras tally on subscriptions. Best-effort; failure
    # is logged but doesn't propagate to the caller.
    try:
        with _supabase.admin() as client:
            # PostgREST upsert with `extra_docs_billed_period = current + 1`.
            # Two-step read-then-write is acceptable here — collision risk
            # is microscopic (one user rarely triggers two extras in the
            # same millisecond), and the alternative (SQL RPC) requires
            # another migration step.
            sub_rows = client.select(
                "subscriptions",
                filters={"user_id": f"eq.{user_id}"},
                single=True,
            )
            current = int((sub_rows[0].get("extra_docs_billed_period") if sub_rows else 0) or 0)
            client.update(
                "subscriptions",
                {"extra_docs_billed_period": current + 1},
                filters={"user_id": f"eq.{user_id}"},
            )
    except Exception:  # noqa: BLE001
        logger.exception(
            "[plan-state] extras tally bump failed user=%s — accept undercount", user_id,
        )


# ──────────────────────────────────────────────────────────────────────
# Chat caps (daily AND monthly)
# ──────────────────────────────────────────────────────────────────────

def check_chat_cap(user_id: str) -> ChatCapDecision:
    """Decide whether to allow ONE Ask-CFO-AI Opus call.

    The cap check MUST run before the Opus request is initiated — the
    spec explicitly says "do not spend tokens then reject". A return of
    `daily_cap_reached` or `monthly_cap_reached` is fatal: caller MUST
    NOT proceed.
    """
    if not enforcement_enabled():
        return ChatCapDecision(
            kind="allowed", plan_key="trial",
            daily_used=0, daily_cap=None,
            monthly_used=0, monthly_cap=None,
            message="",
        )

    state = get_plan_state(user_id)
    plan = state.plan

    daily_cap = plan.chat.daily
    monthly_cap = plan.chat.monthly

    if monthly_cap is not None and state.chat_used_this_period >= monthly_cap:
        return ChatCapDecision(
            kind="monthly_cap_reached",
            plan_key=plan.key,
            daily_used=state.chat_used_today,
            daily_cap=daily_cap,
            monthly_used=state.chat_used_this_period,
            monthly_cap=monthly_cap,
            message=(
                f"Monthly Ask CFO AI limit reached for the {plan.display_name} "
                f"plan ({monthly_cap} messages / month). Resets at the start of "
                f"your next billing period. Upgrade for more headroom."
            ),
        )

    if daily_cap is not None and state.chat_used_today >= daily_cap:
        return ChatCapDecision(
            kind="daily_cap_reached",
            plan_key=plan.key,
            daily_used=state.chat_used_today,
            daily_cap=daily_cap,
            monthly_used=state.chat_used_this_period,
            monthly_cap=monthly_cap,
            message=(
                f"Daily Ask CFO AI limit reached for the {plan.display_name} "
                f"plan ({daily_cap} messages / day). Resets at midnight UTC. "
                f"Upgrade for more headroom."
            ),
        )

    return ChatCapDecision(
        kind="allowed",
        plan_key=plan.key,
        daily_used=state.chat_used_today,
        daily_cap=daily_cap,
        monthly_used=state.chat_used_this_period,
        monthly_cap=monthly_cap,
        message="",
    )


def record_chat_used(user_id: str) -> None:
    """Increment BOTH daily and monthly counters. Two-call atomicity is
    relaxed — daily and monthly bumps are independent best-effort calls.
    If one fails the other still lands; the user gets at worst slightly
    under-counted toward their cap, never over-counted."""
    if not enforcement_enabled():
        return

    # Monthly counter — reuse the existing RPC (`increment_user_usage`).
    try:
        from . import _usage_limits
        _usage_limits.record_usage(user_id, "llm_call")
    except Exception:  # noqa: BLE001
        logger.exception("[plan-state] monthly chat bump failed user=%s", user_id)

    # Daily counter — the new RPC from the V2 migration.
    today_iso = _today().isoformat()
    try:
        with _supabase.admin() as client:
            r = client._client.post(  # type: ignore[attr-defined]
                f"{client.url}/rest/v1/rpc/increment_plan_chat_daily",
                json={
                    "p_user_id": user_id,
                    "p_day": today_iso,
                    "p_amount": 1,
                },
                headers=client._headers,  # type: ignore[attr-defined]
            )
            if r.status_code >= 400:
                logger.warning(
                    "[plan-state] increment_plan_chat_daily RPC failed: %s %s",
                    r.status_code, r.text[:300],
                )
    except Exception:  # noqa: BLE001
        logger.exception("[plan-state] daily chat bump failed user=%s", user_id)


# ──────────────────────────────────────────────────────────────────────
# Public-shaped state for `GET /api/plan/state`
# ──────────────────────────────────────────────────────────────────────

def state_to_public_dict(state: PlanState) -> Dict[str, object]:
    """Shape the state for FE consumption."""
    return {
        "plan_key": state.plan_key,
        "plan_display_name": state.plan.display_name,
        "plan_price_eur": state.plan.price_eur,
        "plan_recurring": state.plan.recurring,
        "included_docs": state.plan.included_docs,
        "extra_doc_eur": state.plan.extra_doc_eur,
        "docs_used": state.docs_used_this_period,
        "extra_docs_billed_this_period": state.extra_docs_billed_this_period,
        "extra_docs_pending_this_period": state.extra_docs_pending_this_period,
        "chat_used_today": state.chat_used_today,
        "chat_daily_cap": state.plan.chat.daily,
        "chat_used_this_period": state.chat_used_this_period,
        "chat_monthly_cap": state.plan.chat.monthly,
        "window_expires_at": (
            state.window_expires_at.isoformat() if state.window_expires_at else None
        ),
        "today": state.today_iso,
        "period_month": state.period_month_bucket,
    }
