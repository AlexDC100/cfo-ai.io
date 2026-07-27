"""HTML email templates (inline-CSS, email-client safe).

Rebranded 2026-07 to the LIVE app / marketing palette (frontend/index.css +
frontend/styles/marketing-tokens.css) — the old navy #003366 / amber #f39c12
shell no longer existed anywhere in the product.

Palette (from marketing-tokens.css):
  page      #f5f4f2   --m-surface-page
  card      #ffffff   --m-surface-card
  ink       #1a1a1a   --m-text-primary   (also the primary CTA fill)
  ink-2     #454545   --m-text-secondary
  muted     #808080   --m-text-muted
  teal      #5CD3C5   --m-accent-coral   (accent dot / rules)
  teal-dark #2AA89B   --m-accent-sage    (links, wordmark "AI", on-white teal)
  border    #ededea   ≈ rgba(0,0,0,0.06) flattened for Outlook

Type: Instrument Serif 400 (headings, upright only — never italic) over
Inter (body/UI), matching --m-font-serif / --m-font-sans. Web fonts are
linked for clients that honour them; Georgia / Helvetica are the fallbacks.

Every template is a pure function returning an HTML string. Marketing mail
(welcome / broadcast) carries a visible unsubscribe link in the footer —
required for CAN-SPAM / GDPR and for inbox-provider trust.

These cover APPLICATION-originated mail only. Supabase Auth templates
(password reset, signup confirm) are configured in the Supabase dashboard —
paste-ready HTML lives in supabase-auth-email-templates.html at the repo
root, and scripts/setup_auth_smtp.py installs the same markup through the
Management API. Keep those in step with password_reset() / signup_confirm()
below, which are the previewable twins.
"""

from __future__ import annotations

import html as _html

# ── Tokens ──────────────────────────────────────────────────────────────────

INK = "#1a1a1a"
INK_2 = "#454545"
MUTED = "#808080"
PAGE = "#f5f4f2"
CARD = "#ffffff"
TEAL = "#5CD3C5"
TEAL_DARK = "#2AA89B"
BORDER = "#ededea"

SANS = "'Inter',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"
SERIF = "'Instrument Serif','Cormorant Garamond',Georgia,'Times New Roman',serif"
MONO = "'JetBrains Mono','IBM Plex Mono',Consolas,monospace"

_FONT_LINK = (
    '<link href="https://fonts.googleapis.com/css2?'
    "family=Inter:wght@400;500;600&family=Instrument+Serif&display=swap"
    '" rel="stylesheet">'
)


def _wordmark() -> str:
    """Typographic logo — ink "CFO", teal-dark "AI", mono tagline beneath.

    Mirrors <Logo> / <Mark> in the app. Kept as text (not an image) so it
    survives image-blocking, which is on by default in most inboxes.
    """
    return f"""\
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr><td style="font-family:{SANS};font-size:17px;font-weight:500;letter-spacing:-0.005em;color:{INK};line-height:1;">
    CFO <span style="color:{TEAL_DARK};">AI</span>
  </td></tr>
  <tr><td style="padding-top:6px;font-family:{MONO};font-size:9px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:{MUTED};line-height:1;">
    Financial Intelligence
  </td></tr>
</table>"""


def _eyebrow(label: str) -> str:
    """Mono uppercase eyebrow with the teal square dot (.m-eyebrow)."""
    return f"""\
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px 0;">
  <tr>
    <td width="8" valign="middle" style="width:8px;font-size:0;line-height:0;"><div style="width:8px;height:8px;background:{TEAL};font-size:0;line-height:8px;">&nbsp;</div></td>
    <td style="padding-left:12px;font-family:{MONO};font-size:11px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:{INK_2};">
      {_html.escape(label)}
    </td>
  </tr>
</table>"""


def _h1(text: str) -> str:
    return (
        f'<h1 style="margin:0 0 14px 0;font-family:{SERIF};font-size:30px;'
        f"font-weight:400;font-style:normal;line-height:1.15;letter-spacing:-0.01em;"
        f'color:{INK};">{_html.escape(text)}</h1>'
    )


def _p(html_text: str, *, muted: bool = False, small: bool = False,
       gap: int = 18) -> str:
    color = MUTED if muted else INK_2
    size = 14 if small else 16
    return (
        f'<p style="margin:0 0 {gap}px 0;font-family:{SANS};font-size:{size}px;'
        f'line-height:1.55;color:{color};">{html_text}</p>'
    )


def _button(label: str, url: str) -> str:
    """Pill CTA — near-black fill, matching .m-pill-cta."""
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td align="center" bgcolor="{INK}" style="background:{INK};border-radius:999px;">'
        f'<a href="{_html.escape(url)}" style="display:inline-block;padding:15px 30px;'
        f"font-family:{SANS};font-size:15px;font-weight:500;color:#ffffff;"
        f'text-decoration:none;border-radius:999px;">{_html.escape(label)}</a>'
        f"</td></tr></table>"
    )


def _fallback_link(url: str) -> str:
    """Plain-text URL under the CTA — for clients that strip the button."""
    safe = _html.escape(url)
    return (
        f'<p style="margin:16px 0 0 0;font-family:{SANS};font-size:12px;'
        f'line-height:1.5;color:{MUTED};word-break:break-all;">'
        f'Button not working? Paste this into your browser:<br>'
        f'<a href="{safe}" style="color:{TEAL_DARK};text-decoration:none;">{safe}</a></p>'
    )


def _layout(*, title: str, body_html: str, footer_html: str = "",
            preheader: str = "") -> str:
    """Shared shell — cream page, white card, wordmark header, teal hairline."""
    pre = (
        f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;">'
        f"{_html.escape(preheader)}</div>"
        if preheader
        else ""
    )
    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>{_html.escape(title)}</title>
{_FONT_LINK}
</head>
<body style="margin:0;padding:0;background:{PAGE};font-family:{SANS};color:{INK};-webkit-font-smoothing:antialiased;">
{pre}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{PAGE};padding:40px 0;">
    <tr><td align="center" style="padding:0 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;width:100%;background:{CARD};border:1px solid {BORDER};border-radius:16px;overflow:hidden;">
        <tr><td style="height:3px;background:{TEAL};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:26px 36px 0 36px;">{_wordmark()}</td></tr>
        <tr><td style="padding:26px 36px 0 36px;">{body_html}</td></tr>
        <tr><td style="padding:32px 36px 30px 36px;">
          <div style="height:1px;background:{BORDER};line-height:0;font-size:0;">&nbsp;</div>
          <p style="margin:18px 0 0 0;font-family:{SANS};font-size:12px;line-height:1.6;color:{MUTED};">
            CFO AI — financial analysis for small and mid-sized companies.{(' ' + footer_html) if footer_html else ''}
          </p>
          <p style="margin:8px 0 0 0;font-family:{SANS};font-size:12px;line-height:1.6;color:{MUTED};">
            <a href="https://cfo-ai.io" style="color:{TEAL_DARK};text-decoration:none;">cfo-ai.io</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def _unsubscribe_footer(unsubscribe_url: str) -> str:
    return (
        "You are receiving this because you subscribed at cfo-ai.io. "
        f'<a href="{_html.escape(unsubscribe_url)}" style="color:{TEAL_DARK};'
        'text-decoration:none;">Unsubscribe</a>.'
    )


# ── Newsletter: double opt-in confirmation ──────────────────────────────────

def newsletter_confirm(*, confirm_url: str) -> str:
    body = f"""
      {_eyebrow("Newsletter")}
      {_h1("Confirm your subscription")}
      {_p("Thanks for signing up to the CFO AI newsletter — product updates, "
          "SME finance insights, and the occasional benchmark deep-dive. "
          "Confirm your email below and we'll start sending.", gap=24)}
      {_button("Confirm subscription", confirm_url)}
      {_p("If you didn't request this, you can safely ignore this email — no "
          "subscription is created until you confirm.", muted=True, small=True, gap=0)}
      {_fallback_link(confirm_url)}
    """
    return _layout(
        title="Confirm your subscription",
        body_html=body,
        preheader="One click to confirm your CFO AI newsletter subscription.",
    )


# ── Newsletter: welcome (after confirm) ─────────────────────────────────────

def newsletter_welcome(*, unsubscribe_url: str) -> str:
    body = f"""
      {_eyebrow("Newsletter")}
      {_h1("You're in")}
      {_p("Your subscription to the CFO AI newsletter is confirmed. You'll hear "
          "from us when there's something genuinely useful — not on a fixed "
          "schedule, and never spam.")}
      {_p("— The CFO AI team", gap=0)}
    """
    return _layout(
        title="Welcome to the CFO AI newsletter",
        body_html=body,
        footer_html=_unsubscribe_footer(unsubscribe_url),
        preheader="Your CFO AI newsletter subscription is confirmed.",
    )


# ── Newsletter: broadcast wrapper (admin-composed content) ──────────────────

def newsletter_broadcast(*, heading: str, content_html: str,
                         unsubscribe_url: str) -> str:
    body = f"""
      {_eyebrow("Newsletter")}
      {_h1(heading)}
      <div style="font-family:{SANS};font-size:16px;line-height:1.6;color:{INK_2};">{content_html}</div>
    """
    return _layout(
        title=heading,
        body_html=body,
        footer_html=_unsubscribe_footer(unsubscribe_url),
        preheader=heading,
    )


# ── Auth: password reset (branded twin of the Supabase dashboard template) ──
#
# Supabase Auth owns the *real* reset mail (it holds the secure token and
# delivers via Resend SMTP — see RESEND_SETUP.md Step 6). This function is
# the same branded HTML expressed in code so it can be previewed/tested from
# the in-app debug sender. Change the look here, then re-run
# scripts/setup_auth_smtp.py so the dashboard template matches.

def password_reset(*, reset_url: str) -> str:
    body = f"""
      {_eyebrow("Account security")}
      {_h1("Reset your password")}
      {_p("We received a request to reset your CFO AI password. Choose a new one "
          "below — the link expires in 60 minutes.", gap=24)}
      {_button("Reset password", reset_url)}
      {_p("If you didn't request this, you can safely ignore this email — your "
          "password stays unchanged.", muted=True, small=True, gap=0)}
      {_fallback_link(reset_url)}
    """
    return _layout(
        title="Reset your password",
        body_html=body,
        preheader="Reset your CFO AI password — link valid for 60 minutes.",
    )


# ── Auth: signup confirmation (branded twin of the Supabase template) ───────

def signup_confirm(*, confirm_url: str) -> str:
    body = f"""
      {_eyebrow("Welcome")}
      {_h1("Confirm your email")}
      {_p("Welcome to CFO AI. Confirm your email address to activate your account "
          "and start turning a trial balance into CFO-grade analysis.", gap=24)}
      {_button("Confirm email", confirm_url)}
      {_p("If you didn't create this account, you can ignore this email.",
          muted=True, small=True, gap=0)}
      {_fallback_link(confirm_url)}
    """
    return _layout(
        title="Confirm your email",
        body_html=body,
        preheader="Activate your CFO AI account in one click.",
    )


# ── Subscription renewal reminder (drains renewal_email_queue) ──────────────

def renewal_reminder(*, renewal_date: str, amount_label: str, manage_url: str,
                     days_ahead: int) -> str:
    when = f"in {days_ahead} days" if days_ahead and days_ahead > 1 else "soon"
    detail = f"""
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="margin:0 0 24px 0;background:{PAGE};border:1px solid {BORDER};border-radius:12px;">
        <tr>
          <td style="padding:16px 20px;font-family:{SANS};font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:{MUTED};">
            Renews on
          </td>
          <td align="right" style="padding:16px 20px;font-family:{SERIF};font-size:20px;color:{INK};">
            {_html.escape(renewal_date)}
          </td>
        </tr>
        <tr><td colspan="2" style="padding:0 20px;"><div style="height:1px;background:{BORDER};font-size:0;line-height:0;">&nbsp;</div></td></tr>
        <tr>
          <td style="padding:16px 20px;font-family:{SANS};font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:{MUTED};">
            Amount
          </td>
          <td align="right" style="padding:16px 20px;font-family:{SERIF};font-size:20px;color:{INK};">
            {_html.escape(amount_label)}
          </td>
        </tr>
      </table>"""
    body = f"""
      {_eyebrow("Billing")}
      {_h1(f"Your subscription renews {when}")}
      {_p("No action is needed to continue — we'll charge the card on file.", gap=22)}
      {detail}
      {_button("Manage subscription", manage_url)}
      {_p("Want to change plans or cancel? Use the button above any time before "
          "the renewal date.", muted=True, small=True, gap=0)}
    """
    return _layout(
        title="Your CFO AI subscription renews soon",
        body_html=body,
        preheader=f"Renews {renewal_date} at {amount_label}.",
    )
