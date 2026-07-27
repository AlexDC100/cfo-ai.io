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


def _email_shell(eyebrow: str, heading: str, body: str, button_label: str,
                 note: str) -> str:
    """The branded shell — cream page, white card, teal hairline, pill CTA.

    Rebranded 2026-07 alongside src/engine/api/_email_templates.py; the old
    navy #003366 / amber gradient shell no longer exists in the product.
    This markup is byte-for-byte what supabase-auth-email-templates.html
    holds — that file is the manual-paste fallback, this is the automated
    path. Change one, change the other, or the dashboard and the repo drift.

    `{{{{ .ConfirmationURL }}}}` escapes to a literal `{{ .ConfirmationURL }}`
    for Supabase to substitute — it carries the secure token, never remove it.
    """
    return f"""<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f4f2;padding:40px 0;font-family:'Inter',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
  <tr><td align="center" style="padding:0 16px;">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #ededea;border-radius:16px;overflow:hidden;">
      <tr><td style="height:3px;background:#5CD3C5;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:26px 36px 0 36px;">
        <table cellpadding="0" cellspacing="0" border="0">
          <tr><td style="font-size:17px;font-weight:500;letter-spacing:-0.005em;color:#1a1a1a;line-height:1;">CFO <span style="color:#2AA89B;">AI</span></td></tr>
          <tr><td style="padding-top:6px;font-family:Consolas,monospace;font-size:9px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:#808080;line-height:1;">Financial Intelligence</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:26px 36px 0 36px;">
        <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px 0;">
          <tr>
            <td width="8" valign="middle" style="width:8px;font-size:0;line-height:0;"><div style="width:8px;height:8px;background:#5CD3C5;font-size:0;line-height:8px;">&nbsp;</div></td>
            <td style="padding-left:12px;font-family:Consolas,monospace;font-size:11px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:#454545;">{eyebrow}</td>
          </tr>
        </table>
        <h1 style="margin:0 0 14px 0;font-family:'Instrument Serif',Georgia,'Times New Roman',serif;font-size:30px;font-weight:400;line-height:1.15;letter-spacing:-0.01em;color:#1a1a1a;">{heading}</h1>
        <p style="margin:0 0 24px 0;font-size:16px;line-height:1.55;color:#454545;">{body}</p>
        <table cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#1a1a1a" style="background:#1a1a1a;border-radius:999px;">
          <a href="{{{{ .ConfirmationURL }}}}" style="display:inline-block;padding:15px 30px;font-size:15px;font-weight:500;color:#ffffff;text-decoration:none;border-radius:999px;">{button_label}</a>
        </td></tr></table>
        <p style="margin:18px 0 0 0;font-size:14px;line-height:1.55;color:#808080;">{note}</p>
      </td></tr>
      <tr><td style="padding:32px 36px 30px 36px;">
        <div style="height:1px;background:#ededea;font-size:0;line-height:0;">&nbsp;</div>
        <p style="margin:18px 0 0 0;font-size:12px;line-height:1.6;color:#808080;">CFO AI — financial analysis for small and mid-sized companies.</p>
        <p style="margin:8px 0 0 0;font-size:12px;line-height:1.6;color:#808080;"><a href="https://cfo-ai.io" style="color:#2AA89B;text-decoration:none;">cfo-ai.io</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>"""


RECOVERY_HTML = _email_shell(
    "Account security",
    "Reset your password",
    "We received a request to reset your CFO AI password. Choose a new one "
    "below — the link expires in 60 minutes.",
    "Reset password",
    "If you didn't request this, you can safely ignore this email — your "
    "password stays unchanged.",
)

CONFIRMATION_HTML = _email_shell(
    "Welcome",
    "Confirm your email",
    "Welcome to CFO AI. Confirm your email address to activate your account "
    "and start turning a trial balance into CFO-grade analysis.",
    "Confirm email",
    "If you didn't create this account, you can ignore this email.",
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
