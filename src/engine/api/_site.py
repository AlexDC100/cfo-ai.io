"""Single source of truth for site-wide identity strings (backend mirror).

Counterpart of `scandi-desk-main/src/config/site.ts`. The FE constant is
the surface customers see; this module is for backend touchpoints —
HTTPException messages that quote the support email, transactional
email From/Reply-To headers (when an email provider is wired), and the
SALES_INBOX_EMAIL default. Keep the two files in sync — single grep
catches any drift:

    grep -rn "contact@cfo-ai" src/engine scandi-desk-main/src/config

The values can be overridden via env without code edits (useful for
staging where you might want a `staging@` mailbox), defaulting to the
production prod values so a fresh `.env` still produces sane output.
"""
from __future__ import annotations

import os

SITE = {
    # Canonical support inbox. Same address as FE `SITE.supportEmail`.
    # Override via SITE_SUPPORT_EMAIL on staging if needed.
    "support_email": os.environ.get("SITE_SUPPORT_EMAIL", "contact@cfo-ai.io"),
    # Noreply alias — used as From header for one-way transactional
    # emails where replies don't make sense (welcome, password reset).
    # Replies-To still resolves to support_email.
    "noreply_email": os.environ.get("SITE_NOREPLY_EMAIL", "noreply@cfo-ai.io"),
    # Public-facing app name (greeting copy, email subject prefixes).
    "app_name": os.environ.get("SITE_APP_NAME", "CFO AI"),
    # Public domain + URL — mirror FE `SITE.domain` / `SITE.url`.
    "domain": os.environ.get("SITE_DOMAIN", "cfo-ai.io"),
    "url": os.environ.get("SITE_URL", "https://cfo-ai.io"),
}
