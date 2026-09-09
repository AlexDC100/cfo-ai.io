"""Problem reports (2026-09-10 per operator): ``POST /api/report``.

The in-app "Report a problem" page sends a message plus optional
screenshots / files; this mails it — attachments inline — to the reports
inbox (``SITE_REPORTS_EMAIL``, default reports@cfo-ai.io) through Resend
(``_email.send_email``). Signed-in reporters are identified from their JWT
and set as Reply-To; guests may give an email. Files travel as base64 in
the JSON body (no multipart dependency); five files, 12 MB in total.
"""

from __future__ import annotations

import base64
import html
import logging
import os
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from . import _email, _site
from ._newsletter import _require_jwt, _user_from_jwt

logger = logging.getLogger("cfo.report")

MAX_FILES = 5
MAX_TOTAL_BYTES = 12 * 1024 * 1024
MAX_MESSAGE_CHARS = 8000


class ReportFile(BaseModel):
    name: str
    type: str = "application/octet-stream"
    content: str  # base64


class ReportRequest(BaseModel):
    message: str
    email: Optional[str] = None
    page: Optional[str] = None
    platform: Optional[str] = None
    app_version: Optional[str] = None
    files: List[ReportFile] = Field(default_factory=list)


def _safe_filename(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", (name or "").strip())[:120]
    return name or "attachment"


def build_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/report")
    def submit_report(req: ReportRequest, request: Request,
                      authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        message = (req.message or "").strip()
        if not message:
            raise HTTPException(400, "Write what went wrong first.")
        if len(message) > MAX_MESSAGE_CHARS:
            raise HTTPException(400, f"Keep the message under {MAX_MESSAGE_CHARS} characters.")
        if len(req.files) > MAX_FILES:
            raise HTTPException(400, f"Attach at most {MAX_FILES} files.")

        attachments: List[Dict[str, str]] = []
        total = 0
        for f in req.files:
            try:
                raw = base64.b64decode(f.content, validate=True)
            except Exception:  # noqa: BLE001
                raise HTTPException(400, f"Attachment {f.name!r} is not valid.")
            total += len(raw)
            if total > MAX_TOTAL_BYTES:
                raise HTTPException(413, "Attachments are too large (12 MB in total).")
            attachments.append({"filename": _safe_filename(f.name), "content": f.content})

        # Who is reporting: the signed-in account when there is one.
        reporter_id: Optional[str] = None
        reporter_email: Optional[str] = (req.email or "").strip() or None
        if authorization:
            try:
                user = _user_from_jwt(_require_jwt(authorization))
                reporter_id = user.get("id")
                reporter_email = (user.get("email") or reporter_email or "").strip() or None
            except Exception:  # noqa: BLE001 — a stale token still gets its report through
                logger.info("[report] JWT not resolved; sending as guest")

        to = os.environ.get("REPORTS_INBOX_EMAIL", _site.SITE["reports_email"])
        first_line = message.splitlines()[0][:80]
        meta = {
            "From": reporter_email or "guest",
            "User id": reporter_id or "—",
            "Page": req.page or "—",
            "Platform": req.platform or "—",
            "App version": req.app_version or "—",
            "User agent": request.headers.get("user-agent", "—")[:200],
            "Attachments": ", ".join(a["filename"] for a in attachments) or "none",
        }
        meta_text = "\n".join(f"{k}: {v}" for k, v in meta.items())
        meta_html = "".join(
            f"<tr><td style=\"padding:2px 12px 2px 0;color:#666\">{html.escape(k)}</td>"
            f"<td style=\"padding:2px 0\">{html.escape(str(v))}</td></tr>"
            for k, v in meta.items()
        )
        body_html = (
            f"<div style=\"font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111\">"
            f"<pre style=\"white-space:pre-wrap;font:inherit;margin:0 0 16px\">{html.escape(message)}</pre>"
            f"<table style=\"border-collapse:collapse;font-size:12px\">{meta_html}</table></div>"
        )
        result = _email.send_email(
            to=to,
            subject=f"[Report] {first_line}",
            html=body_html,
            text=f"{message}\n\n{meta_text}",
            reply_to=reporter_email,
            attachments=attachments or None,
            tags=[{"name": "kind", "value": "problem-report"}],
        )
        if not result.get("ok"):
            logger.error("[report] send failed: %s", result)
            raise HTTPException(
                503,
                f"Couldn't send the report right now. Please email {to} directly.",
            )
        return {"ok": True}

    return router
