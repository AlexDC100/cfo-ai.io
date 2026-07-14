"""Point Supabase Auth at Resend SMTP + install branded auth email templates.

Implements RESEND_SETUP.md Step 6 via the Supabase Management API instead of
dashboard clicks. Idempotent — safe to re-run.

REQUIREMENTS (all in the root .env):
  RESEND_API_KEY          re_...   (already set) — becomes the SMTP password
  SUPABASE_ACCESS_TOKEN   sbp_...  personal access token, create at
                          https://supabase.com/dashboard/account/tokens
                          (must be an account with access to project
                          cjclenykwlngqvapmisb)

GUARD: refuses to run until the cfo-ai.io domain is Verified in Resend,
because Resend rejects SMTP mail from an unverified domain — flipping
Supabase Auth to Resend SMTP early would silently break password-reset and
signup emails. Override with --allow-unverified only if you know better.

USAGE:
    .venv/Scripts/python.exe scripts/setup_auth_smtp.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import httpx

PROJECT_REF = "cjclenykwlngqvapmisb"
DOMAIN = "cfo-ai.io"
SENDER_EMAIL = f"noreply@{DOMAIN}"
SENDER_NAME = "CFO AI"
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def _load_env(path: Path) -> dict:
    env = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = re.split(r"\s+#", v)[0].strip()
    return env


def _email_shell(heading: str, body: str, button_label: str) -> str:
    """The branded shell from RESEND_SETUP.md Step 6b (navy/amber v5 styling)."""
    return f"""<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafbfc;padding:24px 0;font-family:Helvetica,Arial,sans-serif;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid #d6dde6;border-radius:8px;overflow:hidden;">
      <tr><td style="background:linear-gradient(135deg,#003366,#1a5490);padding:22px 28px;">
        <span style="color:#fff;font-size:18px;font-weight:700;">CFO&nbsp;AI</span>
      </td></tr>
      <tr><td style="padding:28px;">
        <h1 style="font-size:20px;color:#003366;margin:0 0 12px;">{heading}</h1>
        <p style="font-size:14px;line-height:1.6;color:#33404f;margin:0 0 20px;">
          {body}
        </p>
        <p style="margin:0 0 8px;">
          <a href="{{{{ .ConfirmationURL }}}}" style="display:inline-block;background:#003366;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:6px;">{button_label}</a>
        </p>
      </td></tr>
      <tr><td style="padding:0 28px 28px;">
        <hr style="border:none;border-top:1px solid #e0e6ed;margin:8px 0 16px;">
        <p style="font-size:11px;color:#8a97a8;margin:0;">CFO AI — Romanian SME financial analysis.</p>
      </td></tr>
    </table>
  </td></tr>
</table>"""


RECOVERY_HTML = _email_shell(
    "Reset your password",
    "We received a request to reset your CFO AI password. Click below to choose a new one. "
    "This link expires in 60 minutes. If you didn't request it, you can ignore this email.",
    "Reset password",
)

CONFIRMATION_HTML = _email_shell(
    "Confirm your email",
    "Welcome to CFO AI. Click below to confirm your email address and activate your account. "
    "If you didn't create an account, you can ignore this email.",
    "Confirm email",
)


def main() -> int:
    allow_unverified = "--allow-unverified" in sys.argv

    env = _load_env(ENV_PATH)
    resend_key = env.get("RESEND_API_KEY", "")
    sb_token = env.get("SUPABASE_ACCESS_TOKEN", "")

    if not resend_key.startswith("re_"):
        print("ERROR: RESEND_API_KEY missing/invalid in .env")
        return 1
    if not sb_token.startswith("sbp_"):
        print("ERROR: SUPABASE_ACCESS_TOKEN missing in .env.")
        print("       Create one at https://supabase.com/dashboard/account/tokens")
        print("       and add a line: SUPABASE_ACCESS_TOKEN=sbp_...")
        return 1

    with httpx.Client(timeout=30) as c:
        # Guard: domain must be verified in Resend
        r = c.get("https://api.resend.com/domains",
                  headers={"Authorization": f"Bearer {resend_key}"})
        r.raise_for_status()
        doms = {d["name"]: d["status"] for d in r.json().get("data", [])}
        status = doms.get(DOMAIN, "missing")
        print(f"Resend domain {DOMAIN}: {status}")
        if status != "verified" and not allow_unverified:
            print("ABORT: domain is not verified in Resend. Applying SMTP now would")
            print("       silently break password-reset/signup emails. Finish the DNS")
            print("       records in Hostinger (RESEND_SETUP.md Step 3), wait for")
            print("       Resend -> Domains to show Verified, then re-run this script.")
            return 2

        payload = {
            # Custom SMTP -> Resend
            "external_email_enabled": True,
            "smtp_host": "smtp.resend.com",
            "smtp_port": "465",
            "smtp_user": "resend",
            "smtp_pass": resend_key,
            "smtp_admin_email": SENDER_EMAIL,
            "smtp_sender_name": SENDER_NAME,
            # Branded templates (keep {{ .ConfirmationURL }} — Supabase owns the token)
            "mailer_subjects_recovery": "Reset your CFO AI password",
            "mailer_templates_recovery_content": RECOVERY_HTML,
            "mailer_subjects_confirmation": "Confirm your CFO AI email",
            "mailer_templates_confirmation_content": CONFIRMATION_HTML,
        }
        r = c.patch(
            f"https://api.supabase.com/v1/projects/{PROJECT_REF}/config/auth",
            headers={"Authorization": f"Bearer {sb_token}",
                     "Content-Type": "application/json"},
            json=payload,
        )
        if r.status_code >= 400:
            print(f"ERROR: PATCH config/auth -> HTTP {r.status_code}: {r.text[:400]}")
            return 1

        # Verify what stuck
        r = c.get(
            f"https://api.supabase.com/v1/projects/{PROJECT_REF}/config/auth",
            headers={"Authorization": f"Bearer {sb_token}"},
        )
        r.raise_for_status()
        cfg = r.json()
        print("Applied. Current auth config:")
        for k in ("smtp_host", "smtp_port", "smtp_user",
                  "smtp_admin_email", "smtp_sender_name"):
            print(f"  {k} = {cfg.get(k)}")
        for k in ("mailer_subjects_recovery", "mailer_subjects_confirmation"):
            print(f"  {k} = {cfg.get(k)}")
        ok = cfg.get("smtp_host") == "smtp.resend.com"
        print("STATUS:", "OK — Supabase Auth now sends via Resend SMTP"
              if ok else "WARNING — smtp_host did not persist, check output above")
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
