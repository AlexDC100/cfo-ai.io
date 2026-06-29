"""Transactional + marketing email sender, backed by Resend.

ONE PROVIDER, ONE SECRET
========================
All app-sent mail (newsletter confirm/welcome/broadcast, subscription
renewal reminders, and any future digest) goes through this module. The
only secret it needs is ``RESEND_API_KEY``; the sending identity is
``RESEND_FROM`` (e.g. ``"CFO AI <noreply@cfo-ai.io>"``).

NOTE — auth emails are NOT sent here. Password-reset and signup-confirm
mail is delivered by Supabase Auth via Resend SMTP (configured in the
Supabase dashboard, see RESEND_SETUP.md). Supabase owns the token; Resend
only delivers it. This module is for mail the *application* originates.

GRACEFUL DEGRADATION
====================
When ``RESEND_API_KEY`` is unset, every send is a no-op that returns
``{"ok": False, "skipped": True, "reason": "RESEND_API_KEY not set"}`` and
logs a warning — the app keeps working, mail just isn't delivered. This
mirrors the billing/Anthropic soft-degrade pattern so dev environments
without a key don't crash.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Sequence

import httpx


logger = logging.getLogger(__name__)

_RESEND_API = "https://api.resend.com"
_DEFAULT_FROM = "CFO AI <onboarding@resend.dev>"  # Resend's shared sandbox sender


def _api_key() -> str:
    return os.environ.get("RESEND_API_KEY", "").strip()


def _from_addr() -> str:
    # RESEND_FROM should be a verified-domain address once DNS is set up,
    # e.g. "CFO AI <noreply@cfo-ai.io>". Falls back to Resend's sandbox
    # sender so a keyless/dev send still has a syntactically valid From.
    return os.environ.get("RESEND_FROM", "").strip() or _DEFAULT_FROM


def is_configured() -> bool:
    """True when a Resend API key is present. Surfaces in /health-style
    probes and lets routers return a clean 503 instead of a silent drop
    when an operator explicitly requested a send."""
    return bool(_api_key())


def send_email(
    *,
    to: str | Sequence[str],
    subject: str,
    html: str,
    text: Optional[str] = None,
    from_: Optional[str] = None,
    reply_to: Optional[str] = None,
    headers: Optional[Dict[str, str]] = None,
    tags: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Send one email through Resend. Never raises on a delivery problem —
    returns a result dict the caller can inspect/log. Raises only on a
    programming error (missing subject/to/html)."""
    if not subject or not to or not html:
        raise ValueError("send_email requires non-empty to, subject, and html")

    key = _api_key()
    if not key:
        logger.warning("[email] RESEND_API_KEY not set — skipping send to %s (%r)", to, subject)
        return {"ok": False, "skipped": True, "reason": "RESEND_API_KEY not set"}

    payload: Dict[str, Any] = {
        "from": from_ or _from_addr(),
        "to": [to] if isinstance(to, str) else list(to),
        "subject": subject,
        "html": html,
    }
    if text:
        payload["text"] = text
    if reply_to:
        payload["reply_to"] = reply_to
    if headers:
        payload["headers"] = headers
    if tags:
        payload["tags"] = tags

    try:
        with httpx.Client(timeout=20.0) as client:
            r = client.post(
                f"{_RESEND_API}/emails",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json=payload,
            )
        if r.status_code >= 400:
            detail = _safe_json(r)
            logger.error("[email] Resend send failed (HTTP %s) to %s: %s", r.status_code, to, detail)
            return {"ok": False, "skipped": False, "status": r.status_code, "error": detail}
        data = _safe_json(r)
        return {"ok": True, "skipped": False, "id": (data or {}).get("id"), "raw": data}
    except Exception as e:  # noqa: BLE001 — delivery is best-effort; never crash the request
        logger.exception("[email] Resend send raised for %s", to)
        return {"ok": False, "skipped": False, "error": str(e)}


def send_batch(messages: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Send up to 100 emails in one Resend `/emails/batch` call.

    Each item: {"to": str|list, "subject": str, "html": str, optional
    "from"/"text"/"reply_to"/"headers"}. Defaults are filled from
    RESEND_FROM. Returns {"ok", "sent", "failed", ...}. For >100 recipients
    the caller chunks (see _newsletter.broadcast)."""
    if not messages:
        return {"ok": True, "sent": 0, "failed": 0, "skipped": False}
    if len(messages) > 100:
        raise ValueError("send_batch accepts at most 100 messages; chunk larger lists")

    key = _api_key()
    if not key:
        logger.warning("[email] RESEND_API_KEY not set — skipping batch of %d", len(messages))
        return {"ok": False, "skipped": True, "reason": "RESEND_API_KEY not set", "sent": 0,
                "failed": len(messages)}

    default_from = _from_addr()
    batch = []
    for m in messages:
        item = {
            "from": m.get("from") or default_from,
            "to": [m["to"]] if isinstance(m["to"], str) else list(m["to"]),
            "subject": m["subject"],
            "html": m["html"],
        }
        for opt in ("text", "reply_to", "headers", "tags"):
            if m.get(opt):
                item[opt] = m[opt]
        batch.append(item)

    try:
        with httpx.Client(timeout=30.0) as client:
            r = client.post(
                f"{_RESEND_API}/emails/batch",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json=batch,
            )
        if r.status_code >= 400:
            detail = _safe_json(r)
            logger.error("[email] Resend batch failed (HTTP %s): %s", r.status_code, detail)
            return {"ok": False, "skipped": False, "status": r.status_code, "error": detail,
                    "sent": 0, "failed": len(batch)}
        data = _safe_json(r)
        sent = len((data or {}).get("data", [])) or len(batch)
        return {"ok": True, "skipped": False, "sent": sent, "failed": 0, "raw": data}
    except Exception as e:  # noqa: BLE001
        logger.exception("[email] Resend batch raised")
        return {"ok": False, "skipped": False, "error": str(e), "sent": 0, "failed": len(batch)}


def _safe_json(r: httpx.Response) -> Optional[Dict[str, Any]]:
    try:
        return r.json()
    except Exception:
        return {"raw": r.text[:500]}
