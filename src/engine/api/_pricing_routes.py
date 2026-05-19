"""Pricing & plan-state HTTP routes.

THREE READ ENDPOINTS + ONE WRITE
================================
  GET  /api/pricing/config              → public pricing config (no COGS)
  GET  /api/pricing/admin               → admin config (incl. COGS + warnings)
  GET  /api/plan/state                  → caller's current usage / caps
  POST /api/plan/confirm-extra-doc      → confirms a chargeable extra
                                          BEFORE the pipeline runs

AUTH
====
  /api/pricing/config        — public (no auth required). Landing page
                                pulls this; auth gating would create a
                                first-paint flicker for unauthenticated
                                visitors.
  /api/pricing/admin         — admin-only. Today: gated on an env
                                allowlist `PRICING_ADMIN_USER_IDS`
                                (comma-separated). When a real admin
                                role model lands, swap to that.
  /api/plan/state            — Bearer token; reads the caller's state.
  /api/plan/confirm-extra-doc — Bearer token; flags the next upload as
                                a billed extra.

WHAT THIS FILE DOES NOT DO
==========================
- Does NOT integrate Stripe for the new tiers. The existing
  `_billing.py` routes still drive Stripe; the spec says "reuse the
  existing payment integration" and "no new payment provider invented".
  The actual Stripe checkout for the new tiers is wired in `_billing.py`
  using `is_recurring_eligible_for_stripe_subscription()` from the new
  pricing config — see the call-site there.
- Does NOT enforce caps. Enforcement is at the existing call sites
  (`/api/pipeline/run`, `/api/ask`) — see those routes for the wiring.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

from fastapi import APIRouter, Header, HTTPException

from . import _pricing_config, _plan_state, _supabase


logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Auth helpers (local copy — same pattern as _benchmarks.py)
# ──────────────────────────────────────────────────────────────────────

def _require_jwt(authorization: Optional[str]) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    return authorization.split(" ", 1)[1].strip()


def _user_id_from_jwt(jwt: str) -> str:
    with _supabase.per_user(jwt) as client:
        user = client.get_user(jwt)
    uid = user.get("id") if user else None
    if not uid:
        raise HTTPException(401, "Could not resolve user from JWT.")
    return uid


def _is_admin(user_id: str) -> bool:
    """Stub admin check — gates on a comma-separated env allowlist.
    Replaces this when a real role model lands."""
    allow = os.environ.get("PRICING_ADMIN_USER_IDS", "")
    return user_id in {u.strip() for u in allow.split(",") if u.strip()}


# ──────────────────────────────────────────────────────────────────────
# Router
# ──────────────────────────────────────────────────────────────────────

def build_router() -> APIRouter:
    router = APIRouter(tags=["pricing"])

    # ─── Public config (landing page reads this; no auth) ──────────
    @router.get("/api/pricing/config")
    def pricing_config() -> Dict[str, Any]:
        return _pricing_config.to_public_dict()

    # ─── Admin config (internal — includes COGS + warnings) ────────
    @router.get("/api/pricing/admin")
    def pricing_admin(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        uid = _user_id_from_jwt(jwt)
        if not _is_admin(uid):
            raise HTTPException(
                403,
                "Admin-only endpoint. Add the user_id to PRICING_ADMIN_USER_IDS.",
            )
        return _pricing_config.to_admin_dict()

    # ─── Caller's plan state ───────────────────────────────────────
    @router.get("/api/plan/state")
    def plan_state(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        uid = _user_id_from_jwt(jwt)
        state = _plan_state.get_plan_state(uid)
        return _plan_state.state_to_public_dict(state)

    # ─── Doc-quota dry-run preview (used by the FE before upload) ──
    @router.get("/api/plan/check-doc")
    def plan_check_doc(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Returns the current doc-quota decision WITHOUT side effects.
        FE calls this on the Upload screen to show the cap state before
        the user even picks a file."""
        jwt = _require_jwt(authorization)
        uid = _user_id_from_jwt(jwt)
        d = _plan_state.check_doc_quota(uid)
        return {
            "kind": d.kind,
            "plan_key": d.plan_key,
            "docs_used": d.docs_used,
            "docs_included": d.docs_included,
            "extra_doc_eur": d.extra_doc_eur,
            "message": d.message,
        }

    # ─── Caller confirms a chargeable extra-doc upload ─────────────
    @router.post("/api/plan/confirm-extra-doc")
    def plan_confirm_extra_doc(
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """User has seen the "this will be a €X.XX extra" dialog and
        clicked Confirm.

        Pricing V3 (refined-spec gap C + D): this reserves an extra
        slot ATOMICALLY via `_usage_gate.confirm_extra_document` and
        flags the reservation as billable. The actual decrement /
        billing happens only when the analysis succeeds — the
        orchestrator's `_commit_pipeline_quota(success=True, was_extra=True)`
        bumps `subscriptions.extra_docs_billed_period` and moves the
        reservation from `extra_docs_pending` to consumed. If analysis
        fails, the release path zeros the pending tally and DOES NOT
        bill.

        TODO: Stripe usage-record integration. The current charge
        motion fires on `commit_user_upload(was_extra=True)` —
        wire it into _billing.py when the Stripe price_id for
        metered extras is published.
        """
        from . import _usage_gate as _ug

        jwt = _require_jwt(authorization)
        uid = _user_id_from_jwt(jwt)

        # Pre-flight: the user must actually be over base quota; we
        # don't want to bill someone for nothing. `reserve_document`
        # is a read of the gated decision — non-mutating because we
        # don't store the reservation when the decision is
        # `extra_required`.
        decision = _ug.reserve_document(uid)
        if decision.kind != "extra_required":
            raise HTTPException(
                409,
                {
                    "code": "no_extra_needed",
                    "decision_kind": decision.kind,
                    "message": (
                        "You're not currently over quota — no extra charge "
                        "needed for the next document."
                    ),
                },
            )

        # Reserve a billable extra slot atomically. The flag travels
        # to the orchestrator via documents.metered_extra and is honoured
        # by `_commit_pipeline_quota` at the success/failure terminal.
        extra = _ug.confirm_extra_document(uid)
        logger.info(
            "[pricing] user=%s confirmed extra-doc charge €%.2f — "
            "reservation made; will commit on analysis success",
            uid, decision.extra_doc_eur or 0.0,
        )
        return {
            "ok": True,
            "extra_doc_eur_marked": decision.extra_doc_eur,
            "plan_key": decision.plan_key,
            "reservation": {
                "used": extra.used,
                "reserved": extra.reserved,
            },
        }

    # ─── Idempotent commit/release endpoints (admin/diagnostic) ────
    # Exposed for tests + retries — the orchestrator handles the
    # normal commit/release lifecycle, but a stuck reservation
    # (e.g., the daemon thread died before reaching the terminal
    # state) can be cleaned up by an admin or the recover-stuck
    # endpoint via these routes.
    @router.post("/api/plan/commit-document-usage")
    def plan_commit_document_usage(
        authorization: Optional[str] = Header(None),
        was_extra: bool = False,
    ) -> Dict[str, Any]:
        from . import _usage_gate as _ug
        jwt = _require_jwt(authorization)
        uid = _user_id_from_jwt(jwt)
        _ug.commit_document(uid, was_extra=was_extra)
        return {"ok": True, "scope": "user", "user_id": uid}

    @router.post("/api/plan/release-document-reservation")
    def plan_release_document_reservation(
        authorization: Optional[str] = Header(None),
        was_extra: bool = False,
    ) -> Dict[str, Any]:
        from . import _usage_gate as _ug
        jwt = _require_jwt(authorization)
        uid = _user_id_from_jwt(jwt)
        _ug.release_document(uid, was_extra=was_extra)
        return {"ok": True, "scope": "user", "user_id": uid}

    return router
