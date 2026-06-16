"""Usage gate service — atomic reserve / commit / release for documents + chat.

WHY THIS EXISTS (gaps C + D from the refined spec)
==================================================
The Pricing V2 path (`_plan_state.check_doc_quota` + `record_doc_consumed`)
was non-atomic: a read-then-write through PostgREST. Two concurrent
uploads near the quota boundary could both pass the check, both
increment the counter, and both run analysis — one of them free of
charge. That's a money leak.

The refined spec requires:
  · Gap C — atomic check-and-consume. Two concurrent requests at the
    boundary must serialize so exactly one wins.
  · Gap D — quota is consumed / extra-doc is billed only on
    SUCCESSFUL completion of analysis. Failed runs (parse error,
    pipeline exception, unrecognized format) release the reservation
    with no bill.

This module is the new path. It calls the V3 atomic RPCs
(`reserve_user_upload`, `commit_user_upload`, `release_user_upload`,
and the chat trio) defined in
`supabase/schema_phase_pricing_v3_atomic.sql`. The legacy
`_plan_state` helpers stay on disk for read-only state reads; the
write path migrates here.

CALL SHAPES
===========
DOCUMENTS:
    reserve_document(user_id) -> ReserveDecision
        ALLOWED          → caller may enqueue the pipeline immediately
        EXTRA_REQUIRED   → over base cap; caller must surface confirm
                           dialog. NO reservation made. After user
                           confirms, caller re-invokes via
                           `confirm_extra_document(user_id)`.
        BLOCKED          → no extras allowed (trial/intro). NO reservation.

    confirm_extra_document(user_id) -> ReserveDecision
        Caller has shown the confirm dialog and got explicit consent.
        Reserves above the base cap + marks the reservation as billable.

    commit_document(user_id, was_extra) -> None
        Pipeline reported analysis success. Reservation → consumed.
        If was_extra=True, also bumps extra_docs_billed_period.

    release_document(user_id, was_extra) -> None
        Pipeline reported failure. Reservation evaporates; no bill.

CHAT (same shape):
    reserve_chat(user_id) -> ChatReserveDecision
    commit_chat(user_id) -> None
    release_chat(user_id) -> None

ENFORCEMENT IS GATED on `enforcement_enabled()` (shared with
`_usage_limits` + `_plan_state`). Off by default — deploying this
code does not block any existing user; flip the env to enforce.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any, Dict, Literal, Optional

from . import _plan_state, _pricing_config, _supabase


logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Shared kill-switch — mirrors `_plan_state.enforcement_enabled`.
# ──────────────────────────────────────────────────────────────────────

def enforcement_enabled() -> bool:
    return _plan_state.enforcement_enabled()


# ──────────────────────────────────────────────────────────────────────
# Result shapes
# ──────────────────────────────────────────────────────────────────────

DocReserveKind = Literal["allowed", "extra_required", "blocked", "disabled"]


@dataclass(frozen=True)
class DocReserveDecision:
    kind: DocReserveKind
    plan_key: str
    used: int
    reserved: int
    cap: int
    extra_doc_eur: Optional[float]
    message: str
    # When kind == "allowed" with `was_extra=True`, the caller should
    # remember this so the eventual commit/release call passes the same
    # flag (which controls subscriptions.extra_docs_billed_period).
    was_extra: bool = False


ChatReserveKind = Literal[
    "allowed", "daily_cap_reached", "monthly_cap_reached", "disabled"
]


@dataclass(frozen=True)
class ChatReserveDecision:
    kind: ChatReserveKind
    plan_key: str
    daily_used: int
    daily_cap: Optional[int]
    monthly_used: int
    monthly_cap: Optional[int]
    message: str


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────

def _today() -> date:
    return datetime.now(timezone.utc).date()


def _month_bucket(d: Optional[date] = None) -> str:
    return (d or _today()).strftime("%Y-%m")


def _rpc(name: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Invoke a Postgres RPC via the existing PostgREST admin client.

    Returns the parsed JSON body, or None on transport / decode failure.
    The atomic RPCs in V3 all return a single jsonb object (not a list).
    """
    try:
        with _supabase.admin() as client:
            r = client._client.post(  # type: ignore[attr-defined]
                f"{client.url}/rest/v1/rpc/{name}",
                json=payload,
                headers=client._headers,  # type: ignore[attr-defined]
            )
            if r.status_code >= 400:
                logger.warning(
                    "[usage-gate] RPC %s failed: %s %s",
                    name, r.status_code, r.text[:300],
                )
                return None
            try:
                body = r.json()
            except Exception:  # noqa: BLE001
                return None
            # PostgREST wraps a single-row return as a single object —
            # most of the time. When it returns a list, take the first
            # element (defensive).
            if isinstance(body, list):
                return body[0] if body else None
            if isinstance(body, dict):
                return body
            return None
    except Exception:  # noqa: BLE001
        logger.exception("[usage-gate] RPC %s exception", name)
        return None


# ──────────────────────────────────────────────────────────────────────
# Documents — reserve / commit / release
# ──────────────────────────────────────────────────────────────────────

def reserve_document(user_id: str) -> DocReserveDecision:
    """Atomic check-and-reserve for ONE document slot.

    The actual atomicity is in the Postgres RPC `reserve_user_upload`:
    its UPDATE ... WHERE uploads+reserved < cap is one transactional
    statement, so two concurrent calls cannot both pass at the boundary.
    """
    if not enforcement_enabled():
        return DocReserveDecision(
            kind="disabled", plan_key="trial", used=0, reserved=0, cap=0,
            extra_doc_eur=None, message="",
        )

    state = _plan_state.get_plan_state(user_id)
    plan = state.plan
    allow_extra = plan.extra_doc_eur is not None
    month = _month_bucket()

    # 2026-05-26 — gap-D follow-up. When the user already saw the
    # extra-doc confirm dialog and clicked Confirm, the upstream call to
    # `confirm_extra_document` ran `reserve_user_upload_extra`, which
    # incremented BOTH `user_usage.uploads_reserved` AND
    # `subscriptions.extra_docs_pending`. The FE then retries
    # `POST /api/pipeline/run`, landing here a second time. If we just
    # re-call `reserve_user_upload`, the SQL guard
    # `(uploads + uploads_reserved) < base_cap` is still false (the
    # confirmed extra pushed us further over cap) — it returns
    # `extra_required` AGAIN and the FE shows the confirm dialog a
    # second time, OR worse, the user gets billed twice for one upload.
    #
    # Short-circuit: if there's a pending pre-confirmed extra slot
    # waiting for an upload to claim it, treat THIS upload as the
    # claimant. Return `allowed` directly with `was_extra=True` so the
    # orchestrator's terminal callback runs
    # `commit_user_upload(was_extra=True)` and the pending → billed
    # transition happens cleanly. No new reservation increment is
    # needed because `reserve_user_upload_extra` already took one.
    if allow_extra and state.extra_docs_pending_this_period > 0:
        return DocReserveDecision(
            kind="allowed",
            plan_key=plan.key,
            used=state.docs_used_this_period,
            # Reflect the existing reservation count for the response
            # envelope; the caller doesn't act on this directly.
            reserved=state.extra_docs_pending_this_period,
            cap=plan.included_docs,
            extra_doc_eur=plan.extra_doc_eur,
            message="",
            was_extra=True,
        )

    body = _rpc("reserve_user_upload", {
        "p_user_id":     user_id,
        "p_month":       month,
        "p_base_cap":    plan.included_docs,
        "p_allow_extra": allow_extra,
    }) or {}

    kind = body.get("kind", "blocked")

    if kind == "allowed":
        return DocReserveDecision(
            kind="allowed",
            plan_key=plan.key,
            used=int(body.get("used") or 0),
            reserved=int(body.get("reserved") or 0),
            cap=plan.included_docs,
            extra_doc_eur=plan.extra_doc_eur,
            message="",
            was_extra=False,
        )

    if kind == "extra_required":
        msg = (
            f"You've used {body.get('used', 0)} of {plan.included_docs} "
            f"documents on the {plan.display_name} plan. This extra "
            f"analysis costs €{plan.extra_doc_eur:.2f}. Confirm to proceed."
        )
        return DocReserveDecision(
            kind="extra_required",
            plan_key=plan.key,
            used=int(body.get("used") or 0),
            reserved=int(body.get("reserved") or 0),
            cap=plan.included_docs,
            extra_doc_eur=plan.extra_doc_eur,
            message=msg,
        )

    # blocked (or unknown — treat as blocked closed-failure)
    msg = (
        f"You've used all {plan.included_docs} document"
        f"{'s' if plan.included_docs != 1 else ''} on the "
        f"{plan.display_name} plan. Upgrade to keep going."
    )
    return DocReserveDecision(
        kind="blocked",
        plan_key=plan.key,
        used=int(body.get("used") or 0),
        reserved=int(body.get("reserved") or 0),
        cap=plan.included_docs,
        extra_doc_eur=None,
        message=msg,
    )


def confirm_extra_document(user_id: str) -> DocReserveDecision:
    """User has seen the extra-doc confirm dialog and clicked Confirm.
    Reserve a slot above the base cap and mark it billable.

    This is a SEPARATE RPC (`reserve_user_upload_extra`) — not a flag
    on `reserve_user_upload` — because the original reserve call
    returned `extra_required` deliberately WITHOUT reserving. The
    explicit two-step keeps the "user confirmed" intent visible in
    server logs.
    """
    if not enforcement_enabled():
        return DocReserveDecision(
            kind="disabled", plan_key="trial", used=0, reserved=0, cap=0,
            extra_doc_eur=None, message="", was_extra=True,
        )

    state = _plan_state.get_plan_state(user_id)
    plan = state.plan
    if plan.extra_doc_eur is None:
        # Defence in depth — caller should never hit this path on
        # trial/intro, but if they do, refuse.
        return DocReserveDecision(
            kind="blocked", plan_key=plan.key, used=0, reserved=0,
            cap=plan.included_docs, extra_doc_eur=None,
            message="This plan doesn't allow extra documents.",
        )

    body = _rpc("reserve_user_upload_extra", {
        "p_user_id": user_id,
        "p_month":   _month_bucket(),
    }) or {}

    return DocReserveDecision(
        kind="allowed",
        plan_key=plan.key,
        used=int(body.get("used") or 0),
        reserved=int(body.get("reserved") or 0),
        cap=plan.included_docs,
        extra_doc_eur=plan.extra_doc_eur,
        message="",
        was_extra=True,
    )


def commit_document(user_id: str, *, was_extra: bool) -> None:
    """Pipeline reported analysis SUCCESS. Convert reservation →
    consumed (and, if `was_extra`, bump the billed-extras tally so the
    next renewal invoice sees this charge — gap D: bill only on success).
    Idempotency: floors prevent underflow; calling twice is a no-op
    after the first call.
    """
    if not enforcement_enabled():
        return
    _rpc("commit_user_upload", {
        "p_user_id":   user_id,
        "p_month":     _month_bucket(),
        "p_was_extra": was_extra,
    })


def release_document(user_id: str, *, was_extra: bool) -> None:
    """Pipeline reported analysis FAILURE. Drop the reservation; no
    quota consumed, no charge (gap D).
    """
    if not enforcement_enabled():
        return
    _rpc("release_user_upload", {
        "p_user_id":   user_id,
        "p_month":     _month_bucket(),
        "p_was_extra": was_extra,
    })


# ──────────────────────────────────────────────────────────────────────
# Chat — reserve / commit / release
# ──────────────────────────────────────────────────────────────────────

def reserve_chat(user_id: str) -> ChatReserveDecision:
    """Atomic check-and-reserve for one Ask-CFO-AI message.

    The RPC `reserve_user_chat` locks both the monthly and daily rows
    (FOR UPDATE) before deciding, so concurrent calls serialize on the
    lock — gap C atomicity holds across the two-counter dual-cap check.
    """
    if not enforcement_enabled():
        return ChatReserveDecision(
            kind="disabled", plan_key="trial",
            daily_used=0, daily_cap=None,
            monthly_used=0, monthly_cap=None,
            message="",
        )

    state = _plan_state.get_plan_state(user_id)
    plan = state.plan

    body = _rpc("reserve_user_chat", {
        "p_user_id":     user_id,
        "p_month":       _month_bucket(),
        "p_day":         _today().isoformat(),
        "p_daily_cap":   plan.chat.daily,
        "p_monthly_cap": plan.chat.monthly,
    }) or {}

    kind = body.get("kind", "monthly_cap_reached")

    if kind == "allowed":
        return ChatReserveDecision(
            kind="allowed",
            plan_key=plan.key,
            daily_used=int(body.get("daily_used") or 0),
            daily_cap=plan.chat.daily,
            monthly_used=int(body.get("monthly_used") or 0),
            monthly_cap=plan.chat.monthly,
            message="",
        )

    if kind == "daily_cap_reached":
        return ChatReserveDecision(
            kind="daily_cap_reached",
            plan_key=plan.key,
            daily_used=int(body.get("daily_used") or 0),
            daily_cap=plan.chat.daily,
            monthly_used=int(body.get("monthly_used") or 0),
            monthly_cap=plan.chat.monthly,
            message=(
                f"Daily Ask CFO AI limit reached for the {plan.display_name} "
                f"plan ({plan.chat.daily} messages / day). Resets at midnight UTC."
            ),
        )

    return ChatReserveDecision(
        kind="monthly_cap_reached",
        plan_key=plan.key,
        daily_used=int(body.get("daily_used") or 0),
        daily_cap=plan.chat.daily,
        monthly_used=int(body.get("monthly_used") or 0),
        monthly_cap=plan.chat.monthly,
        message=(
            f"Monthly Ask CFO AI limit reached for the {plan.display_name} "
            f"plan ({plan.chat.monthly} messages / month). Resets at the "
            f"start of your next billing period."
        ),
    )


def commit_chat(user_id: str) -> None:
    """Opus call returned a complete response. Convert reservation →
    consumed in both the daily and monthly counters."""
    if not enforcement_enabled():
        return
    _rpc("commit_user_chat", {
        "p_user_id": user_id,
        "p_month":   _month_bucket(),
        "p_day":     _today().isoformat(),
    })


def release_chat(user_id: str) -> None:
    """Opus call errored before producing a complete response (gap D,
    optional principle applied to chat). Drop the reservation; nothing
    counted against the user."""
    if not enforcement_enabled():
        return
    _rpc("release_user_chat", {
        "p_user_id": user_id,
        "p_month":   _month_bucket(),
        "p_day":     _today().isoformat(),
    })
