"""HTML email templates (inline-CSS, email-client safe).

Branded to the v5 site palette: navy #003366 → #1a5490, amber #f39c12.
Every template is a pure function returning an HTML string. Marketing
mail (welcome / broadcast) carries a visible unsubscribe link in the
footer — required for CAN-SPAM / GDPR and for inbox-provider trust.

These cover APPLICATION-originated mail only. Supabase Auth templates
(password reset, signup confirm) are configured in the Supabase
dashboard — their HTML lives in RESEND_SETUP.md for you to paste in.
"""

from __future__ import annotations

import html as _html
from typing import Optional


def _layout(*, title: str, body_html: str, footer_html: str = "") -> str:
    """Shared shell — navy header card + white body + grey footer."""
    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{_html.escape(title)}</title>
</head>
<body style="margin:0;padding:0;background:#fafbfc;font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafbfc;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0"
             style="max-width:600px;width:100%;background:#ffffff;border:1px solid #d6dde6;border-radius:8px;overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(135deg,#003366,#1a5490);padding:22px 28px;">
            <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.3px;">CFO&nbsp;AI</span>
          </td>
        </tr>
        <tr><td style="padding:28px 28px 8px 28px;">{body_html}</td></tr>
        <tr><td style="padding:16px 28px 28px 28px;">
          <hr style="border:none;border-top:1px solid #e0e6ed;margin:8px 0 16px 0;">
          <p style="font-size:11px;color:#8a97a8;line-height:1.5;margin:0;">
            CFO AI — Romanian SME financial analysis.{(' ' + footer_html) if footer_html else ''}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def _button(label: str, url: str) -> str:
    return (
        f'<a href="{_html.escape(url)}" '
        'style="display:inline-block;background:#003366;color:#ffffff;text-decoration:none;'
        'font-size:14px;font-weight:600;padding:12px 22px;border-radius:6px;">'
        f'{_html.escape(label)}</a>'
    )


def _unsubscribe_footer(unsubscribe_url: str) -> str:
    return (
        f'You are receiving this because you subscribed at cfo-ai.io. '
        f'<a href="{_html.escape(unsubscribe_url)}" style="color:#1a5490;">Unsubscribe</a>.'
    )


# ── Newsletter: double opt-in confirmation ──────────────────────────────────

def newsletter_confirm(*, confirm_url: str) -> str:
    body = f"""
      <h1 style="font-size:20px;color:#003366;margin:0 0 12px 0;">Confirm your subscription</h1>
      <p style="font-size:14px;line-height:1.6;color:#33404f;margin:0 0 20px 0;">
        Thanks for signing up to the CFO AI newsletter — product updates,
        Romanian SME finance insights, and the occasional benchmark deep-dive.
        Click below to confirm your email and start receiving it.
      </p>
      <p style="margin:0 0 22px 0;">{_button("Confirm subscription", confirm_url)}</p>
      <p style="font-size:12px;color:#8a97a8;line-height:1.5;margin:0;">
        If you didn't request this, you can safely ignore this email — no
        subscription is created until you confirm.
      </p>
    """
    return _layout(title="Confirm your subscription", body_html=body)


# ── Newsletter: welcome (after confirm) ─────────────────────────────────────

def newsletter_welcome(*, unsubscribe_url: str) -> str:
    body = """
      <h1 style="font-size:20px;color:#003366;margin:0 0 12px 0;">You're in 🎉</h1>
      <p style="font-size:14px;line-height:1.6;color:#33404f;margin:0 0 16px 0;">
        Your subscription to the CFO AI newsletter is confirmed. You'll hear
        from us when there's something genuinely useful — not on a fixed
        schedule, and never spam.
      </p>
      <p style="font-size:14px;line-height:1.6;color:#33404f;margin:0;">
        — The CFO AI team
      </p>
    """
    return _layout(
        title="Welcome to the CFO AI newsletter",
        body_html=body,
        footer_html=_unsubscribe_footer(unsubscribe_url),
    )


# ── Newsletter: broadcast wrapper (admin-composed content) ──────────────────

def newsletter_broadcast(*, heading: str, content_html: str, unsubscribe_url: str) -> str:
    body = f"""
      <h1 style="font-size:20px;color:#003366;margin:0 0 16px 0;">{_html.escape(heading)}</h1>
      <div style="font-size:14px;line-height:1.65;color:#33404f;">{content_html}</div>
    """
    return _layout(
        title=heading,
        body_html=body,
        footer_html=_unsubscribe_footer(unsubscribe_url),
    )


# ── Subscription renewal reminder (drains renewal_email_queue) ──────────────

def renewal_reminder(*, renewal_date: str, amount_label: str, manage_url: str,
                     days_ahead: int) -> str:
    when = f"in {days_ahead} days" if days_ahead and days_ahead > 1 else "soon"
    body = f"""
      <h1 style="font-size:20px;color:#003366;margin:0 0 12px 0;">Your subscription renews {when}</h1>
      <p style="font-size:14px;line-height:1.6;color:#33404f;margin:0 0 16px 0;">
        This is a heads-up that your CFO AI subscription renews on
        <strong>{_html.escape(renewal_date)}</strong> at
        <strong>{_html.escape(amount_label)}</strong>. No action is needed to
        continue — we'll charge the card on file.
      </p>
      <p style="margin:0 0 20px 0;">{_button("Manage subscription", manage_url)}</p>
      <p style="font-size:12px;color:#8a97a8;line-height:1.5;margin:0;">
        Want to change plans or cancel? Use the button above any time before
        the renewal date.
      </p>
    """
    return _layout(title="Your CFO AI subscription renews soon", body_html=body)
