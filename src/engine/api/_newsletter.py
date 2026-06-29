"""Newsletter + app-mail HTTP routes (Resend-backed).

PUBLIC (no auth)
  POST /api/newsletter/subscribe            {email, source?}  → double opt-in
  GET  /api/newsletter/confirm?token=…      confirm link from the email
  GET  /api/newsletter/unsubscribe?token=…  one-click unsubscribe

PER-USER (Bearer JWT)
  GET  /api/newsletter/status               caller's subscription status
  POST /api/newsletter/subscribe-me         subscribe the signed-in user
                                            (email already verified → no
                                            double opt-in, instant confirm)
  POST /api/newsletter/unsubscribe-me       unsubscribe the signed-in user

ADMIN (Bearer JWT + PRICING_ADMIN_USER_IDS allowlist)
  GET  /api/newsletter/subscribers          counts by status
  POST /api/newsletter/broadcast            {subject, heading, content_html}
                                            → send to all confirmed subscribers
  POST /api/newsletter/drain-renewals       drain renewal_email_queue via Resend

All writes use the service-role Supabase client (subscribe is public, so
there's no user RLS context). Email delivery is best-effort: a Resend
outage never fails the HTTP request — it's logged to email_send_log.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from . import _email, _email_templates, _supabase


logger = logging.getLogger(__name__)

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ── Auth helpers (local copy — same pattern as _pricing_routes.py) ──────────

def _require_jwt(authorization: Optional[str]) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    return authorization.split(" ", 1)[1].strip()


def _user_from_jwt(jwt: str) -> Dict[str, Any]:
    with _supabase.per_user(jwt) as client:
        user = client.get_user(jwt)
    if not user or not user.get("id"):
        raise HTTPException(401, "Could not resolve user from JWT.")
    return user


def _is_admin(user_id: str) -> bool:
    allow = os.environ.get("PRICING_ADMIN_USER_IDS", "")
    return user_id in {u.strip() for u in allow.split(",") if u.strip()}


# ── Link builders ───────────────────────────────────────────────────────────

def _api_base(request: Request) -> str:
    """Origin the confirm/unsubscribe links point at — the backend itself.
    Prefer an explicit PUBLIC_API_URL (set in prod behind a proxy); fall
    back to the request's own base URL (correct in local dev)."""
    explicit = os.environ.get("PUBLIC_API_URL", "").strip()
    return (explicit or str(request.base_url)).rstrip("/")


def _app_url() -> str:
    return os.environ.get("APP_URL", "http://localhost:5173").rstrip("/")


def _confirm_url(request: Request, token: str) -> str:
    return f"{_api_base(request)}/api/newsletter/confirm?token={token}"


def _unsubscribe_url(request: Request, token: str) -> str:
    return f"{_api_base(request)}/api/newsletter/unsubscribe?token={token}"


# ── Logging helper ──────────────────────────────────────────────────────────

def _log_send(client: "_supabase.SupabaseClient", *, to: str, kind: str,
              subject: str, result: Dict[str, Any]) -> None:
    status = "skipped" if result.get("skipped") else ("sent" if result.get("ok") else "failed")
    try:
        client.insert("email_send_log", {
            "to_email": to,
            "kind": kind,
            "subject": subject,
            "provider_id": result.get("id"),
            "status": status,
            "error": (None if result.get("ok") else str(result.get("error") or result.get("reason"))),
        }, returning=False)
    except Exception:  # noqa: BLE001 — logging must never break a send
        logger.exception("[newsletter] email_send_log insert failed")


def _normalize_email(raw: str) -> str:
    e = (raw or "").strip().lower()
    if not _EMAIL_RE.match(e):
        raise HTTPException(422, "A valid email address is required.")
    return e


# ── Request models ──────────────────────────────────────────────────────────

class SubscribeRequest(BaseModel):
    email: str
    source: Optional[str] = None


class BroadcastRequest(BaseModel):
    subject: str
    heading: str
    content_html: str


# ── Router ──────────────────────────────────────────────────────────────────

def build_router() -> APIRouter:
    router = APIRouter(tags=["newsletter"])

    # ─── PUBLIC: subscribe (double opt-in) ─────────────────────────────
    @router.post("/api/newsletter/subscribe")
    def subscribe(req: SubscribeRequest, request: Request) -> Dict[str, Any]:
        email = _normalize_email(str(req.email))
        with _supabase.admin() as client:
            rows = client.select(
                "newsletter_subscribers",
                filters={"email": f"eq.{email}"},
                columns="id,status,confirm_token,unsubscribe_token",
            )
            if rows:
                row = rows[0]
                if row["status"] == "confirmed":
                    return {"status": "already_subscribed"}
                # pending or previously unsubscribed → (re)send confirmation
                client.update(
                    "newsletter_subscribers",
                    {"status": "pending"},
                    filters={"id": f"eq.{row['id']}"},
                )
                confirm_token = row["confirm_token"]
            else:
                created = client.insert("newsletter_subscribers", {
                    "email": email,
                    "status": "pending",
                    "source": req.source or "web",
                }, returning=True)
                confirm_token = created[0]["confirm_token"]

            result = _email.send_email(
                to=email,
                subject="Confirm your CFO AI newsletter subscription",
                html=_email_templates.newsletter_confirm(
                    confirm_url=_confirm_url(request, confirm_token)),
            )
            _log_send(client, to=email, kind="newsletter_confirm",
                      subject="Confirm your CFO AI newsletter subscription", result=result)

        return {"status": "confirmation_sent", "delivered": bool(result.get("ok"))}

    # ─── PUBLIC: confirm link ──────────────────────────────────────────
    # Clicked directly from an email → on ANY failure we redirect to the
    # site with an error flag rather than show a raw 500 page.
    @router.get("/api/newsletter/confirm")
    def confirm(request: Request, token: str = Query(...)) -> RedirectResponse:
        try:
            with _supabase.admin() as client:
                rows = client.select(
                    "newsletter_subscribers",
                    filters={"confirm_token": f"eq.{token}"},
                    columns="id,email,status,unsubscribe_token",
                )
                if not rows:
                    return RedirectResponse(f"{_app_url()}/?newsletter=invalid", status_code=302)
                row = rows[0]
                if row["status"] != "confirmed":
                    client.update(
                        "newsletter_subscribers",
                        {"status": "confirmed", "confirmed_at": "now()"},
                        filters={"id": f"eq.{row['id']}"},
                    )
                    result = _email.send_email(
                        to=row["email"],
                        subject="Welcome to the CFO AI newsletter",
                        html=_email_templates.newsletter_welcome(
                            unsubscribe_url=_unsubscribe_url(request, row["unsubscribe_token"])),
                    )
                    _log_send(client, to=row["email"], kind="newsletter_welcome",
                              subject="Welcome to the CFO AI newsletter", result=result)
            return RedirectResponse(f"{_app_url()}/?newsletter=confirmed", status_code=302)
        except Exception:  # noqa: BLE001 — never show a raw 500 to an email click
            logger.exception("[newsletter] confirm failed for token")
            return RedirectResponse(f"{_app_url()}/?newsletter=error", status_code=302)

    # ─── PUBLIC: unsubscribe link ──────────────────────────────────────
    @router.get("/api/newsletter/unsubscribe")
    def unsubscribe(token: str = Query(...)) -> RedirectResponse:
        try:
            with _supabase.admin() as client:
                rows = client.select(
                    "newsletter_subscribers",
                    filters={"unsubscribe_token": f"eq.{token}"},
                    columns="id,status",
                )
                if rows and rows[0]["status"] != "unsubscribed":
                    client.update(
                        "newsletter_subscribers",
                        {"status": "unsubscribed", "unsubscribed_at": "now()"},
                        filters={"id": f"eq.{rows[0]['id']}"},
                    )
            return RedirectResponse(f"{_app_url()}/?newsletter=unsubscribed", status_code=302)
        except Exception:  # noqa: BLE001
            logger.exception("[newsletter] unsubscribe failed for token")
            return RedirectResponse(f"{_app_url()}/?newsletter=error", status_code=302)

    # ─── PER-USER: status ──────────────────────────────────────────────
    @router.get("/api/newsletter/status")
    def my_status(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        user = _user_from_jwt(_require_jwt(authorization))
        email = (user.get("email") or "").strip().lower()
        if not email:
            return {"status": "none"}
        with _supabase.admin() as client:
            rows = client.select(
                "newsletter_subscribers",
                filters={"email": f"eq.{email}"},
                columns="status",
            )
        return {"status": rows[0]["status"] if rows else "none"}

    # ─── PER-USER: subscribe self (instant confirm) ────────────────────
    @router.post("/api/newsletter/subscribe-me")
    def subscribe_me(request: Request,
                     authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        user = _user_from_jwt(_require_jwt(authorization))
        email = (user.get("email") or "").strip().lower()
        if not email:
            raise HTTPException(400, "No email on the signed-in account.")
        with _supabase.admin() as client:
            # Email is already verified by Supabase Auth → skip double opt-in.
            client.upsert("newsletter_subscribers", {
                "email": email,
                "status": "confirmed",
                "confirmed_at": "now()",
                "user_id": user["id"],
                "source": "settings",
            }, on_conflict="email")
            rows = client.select(
                "newsletter_subscribers",
                filters={"email": f"eq.{email}"},
                columns="unsubscribe_token",
            )
            unsub = rows[0]["unsubscribe_token"] if rows else ""
            result = _email.send_email(
                to=email,
                subject="Welcome to the CFO AI newsletter",
                html=_email_templates.newsletter_welcome(
                    unsubscribe_url=_unsubscribe_url(request, unsub)),
            )
            _log_send(client, to=email, kind="newsletter_welcome",
                      subject="Welcome to the CFO AI newsletter", result=result)
        return {"status": "confirmed"}

    # ─── PER-USER: unsubscribe self ────────────────────────────────────
    @router.post("/api/newsletter/unsubscribe-me")
    def unsubscribe_me(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        user = _user_from_jwt(_require_jwt(authorization))
        email = (user.get("email") or "").strip().lower()
        with _supabase.admin() as client:
            client.update(
                "newsletter_subscribers",
                {"status": "unsubscribed", "unsubscribed_at": "now()"},
                filters={"email": f"eq.{email}"},
            )
        return {"status": "unsubscribed"}

    # ─── ADMIN: subscriber counts ──────────────────────────────────────
    @router.get("/api/newsletter/subscribers")
    def subscriber_counts(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        user = _user_from_jwt(_require_jwt(authorization))
        if not _is_admin(user["id"]):
            raise HTTPException(403, "Admin-only. Add the user_id to PRICING_ADMIN_USER_IDS.")
        counts: Dict[str, int] = {"pending": 0, "confirmed": 0, "unsubscribed": 0}
        with _supabase.admin() as client:
            for st in counts:
                rows = client.select(
                    "newsletter_subscribers",
                    filters={"status": f"eq.{st}"},
                    columns="id",
                )
                counts[st] = len(rows)
        counts["total"] = sum(counts.values())
        return counts

    # ─── ADMIN: broadcast to all confirmed subscribers ─────────────────
    @router.post("/api/newsletter/broadcast")
    def broadcast(req: BroadcastRequest, request: Request,
                  authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        user = _user_from_jwt(_require_jwt(authorization))
        if not _is_admin(user["id"]):
            raise HTTPException(403, "Admin-only. Add the user_id to PRICING_ADMIN_USER_IDS.")
        if not _email.is_configured():
            raise HTTPException(503, "RESEND_API_KEY is not configured on the backend.")

        with _supabase.admin() as client:
            subs = client.select(
                "newsletter_subscribers",
                filters={"status": "eq.confirmed"},
                columns="email,unsubscribe_token",
            )
            recipients = [s for s in subs if s.get("email")]
            sent = failed = 0
            # Each recipient needs their OWN unsubscribe link → build per-
            # recipient messages and chunk into batches of 100 (Resend's cap).
            for i in range(0, len(recipients), 100):
                chunk = recipients[i:i + 100]
                messages = [{
                    "to": s["email"],
                    "subject": req.subject,
                    "html": _email_templates.newsletter_broadcast(
                        heading=req.heading,
                        content_html=req.content_html,
                        unsubscribe_url=_unsubscribe_url(request, s["unsubscribe_token"]),
                    ),
                } for s in chunk]
                result = _email.send_batch(messages)
                if result.get("ok"):
                    sent += result.get("sent", len(chunk))
                else:
                    failed += result.get("failed", len(chunk))

            status = ("sent" if failed == 0 and sent > 0
                      else "partial" if sent > 0 else "failed")
            try:
                client.insert("newsletter_broadcasts", {
                    "heading": req.heading,
                    "subject": req.subject,
                    "content_html": req.content_html,
                    "sent_by": user["id"],
                    "recipient_count": len(recipients),
                    "sent_count": sent,
                    "failed_count": failed,
                    "status": status,
                }, returning=False)
            except Exception:  # noqa: BLE001
                logger.exception("[newsletter] broadcast record insert failed")

        return {"status": status, "recipients": len(recipients), "sent": sent, "failed": failed}

    # ─── ADMIN: drain the renewal-email queue ──────────────────────────
    @router.post("/api/newsletter/drain-renewals")
    def drain_renewals(limit: int = Query(200, ge=1, le=1000),
                       authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        user = _user_from_jwt(_require_jwt(authorization))
        if not _is_admin(user["id"]):
            raise HTTPException(403, "Admin-only. Add the user_id to PRICING_ADMIN_USER_IDS.")

        drained = failed = 0
        with _supabase.admin() as client:
            try:
                pending = client.select(
                    "renewal_email_queue",
                    filters={"status": "eq.queued"},
                    columns="id,payload",
                    limit=limit,
                    order="send_at.asc",
                )
            except Exception:  # noqa: BLE001 — table may not exist in older envs
                logger.exception("[newsletter] renewal_email_queue read failed")
                return {"drained": 0, "failed": 0, "note": "renewal_email_queue unavailable"}

            for row in pending:
                payload = row.get("payload") or {}
                to = payload.get("to")
                if not to:
                    continue
                vars_ = payload.get("vars") or {}
                html = _email_templates.renewal_reminder(
                    renewal_date=vars_.get("renewal_date", ""),
                    amount_label=vars_.get("renewal_price", "€99"),
                    manage_url=vars_.get("manage_url", f"{_app_url()}/settings/billing"),
                    days_ahead=int(vars_.get("days_ahead", 0) or 0),
                )
                result = _email.send_email(
                    to=to,
                    subject=payload.get("subject", "Your CFO AI subscription renews soon"),
                    html=html,
                )
                _log_send(client, to=to, kind="renewal_reminder",
                          subject=payload.get("subject", ""), result=result)
                if result.get("ok"):
                    client.update("renewal_email_queue",
                                  {"status": "sent", "sent_at": "now()"},
                                  filters={"id": f"eq.{row['id']}"})
                    drained += 1
                else:
                    client.update("renewal_email_queue",
                                  {"status": "failed", "error": str(result.get("error") or result.get("reason"))},
                                  filters={"id": f"eq.{row['id']}"})
                    failed += 1

        return {"drained": drained, "failed": failed}

    return router
