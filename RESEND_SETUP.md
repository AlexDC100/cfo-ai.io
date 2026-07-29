# Resend Email — Setup Guide

This app sends email through **[Resend](https://resend.com)**. This guide takes you
from zero to working email: Resend account → **Hostinger DNS** → backend env →
Supabase Auth (password-reset / signup emails) → testing.

Everything is already coded. Until you complete **Steps 1–4**, the app runs fine
but **every email is silently skipped** (logged, never delivered) — that's by design.

---

## What was built

| Surface | How it sends | Where |
|---|---|---|
| **Password reset / signup confirm** | Supabase Auth → **Resend SMTP** (custom templates) | Supabase dashboard (Step 5) |
| **Newsletter** (subscribe → confirm → welcome → broadcast) | Resend API | `src/engine/api/_newsletter.py` |
| **Subscription renewal reminders** | Resend API (drains `renewal_email_queue`) | `POST /api/newsletter/drain-renewals` |
| Shared sender + templates | — | `src/engine/api/_email.py`, `_email_templates.py` |

**Why two paths?** Auth emails must keep Supabase's secure token flow, so we only
swap the *delivery* to Resend (SMTP) and customize the *look*. Everything else is
app-originated and goes through the Resend API directly.

---

## Step 1 — Create a Resend account + API key

1. Sign up at <https://resend.com>.
2. **API Keys → Create API Key** → name it `cfo-ai-prod`, permission **Full access**.
3. Copy the key (`re_...`). You'll paste it into `.env` in Step 4. **It's shown once.**

---

## Step 2 — Add your sending domain in Resend

1. Resend → **Domains → Add Domain** → enter `cfo-ai.io` (or a subdomain like
   `mail.cfo-ai.io` — a subdomain is recommended so marketing mail can't hurt
   your root domain's reputation).
2. Resend shows a **set of DNS records** to add. They look like this (your DKIM
   value will be unique — **copy the exact values Resend shows you**):

   | Type | Name / Host | Value | Priority |
   |---|---|---|---|
   | `MX` | `send` | `feedback-smtp.eu-west-1.amazonses.com` | `10` |
   | `TXT` | `send` | `v=spf1 include:amazonses.com ~all` | — |
   | `TXT` | `resend._domainkey` | `p=MIGfMA0GCSq…` (long DKIM key) | — |
   | `TXT` | `_dmarc` | `v=DMARC1; p=none;` | — |

   > The region (`eu-west-1`) and exact DKIM string come from **your** Resend
   > screen. Don't copy the table above verbatim — copy Resend's.

Keep that Resend tab open; you'll enter these in Hostinger next.

---

## Step 3 — Add the DNS records in Hostinger

1. Log in to **Hostinger → hPanel**.
2. **Domains** → select `cfo-ai.io` → **DNS / Nameservers** → **DNS Zone Editor**
   (also reachable via **hPanel → Advanced → DNS Zone Editor**).
3. For **each** record Resend gave you, click **Add Record** and fill it in.
   Hostinger-specific notes:

   - **Type**: pick `TXT`, `MX`, or `CNAME` to match Resend.
   - **Name / Host**: enter the **subdomain part only** — Hostinger appends your
     domain automatically. So if Resend says `send.cfo-ai.io`, you type `send`.
     If Resend says `resend._domainkey.cfo-ai.io`, you type `resend._domainkey`.
     For a record on the root, type `@`.
   - **Points to / Value / Content**: paste Resend's value exactly. For long DKIM
     TXT values, paste the whole string (Hostinger handles the length).
   - **Priority** (MX only): set to `10` (or whatever Resend shows).
   - **TTL**: leave Hostinger's default (e.g. 3600 / 14400).

4. Save each record. **Remove any conflicting old record** first (e.g. an existing
   `TXT @ v=spf1 ...` SPF record — you can only have one SPF record per host; if
   you already send mail from Hostinger, merge the includes rather than duplicating).

5. Back in **Resend → Domains**, click **Verify**. DNS can take **5 minutes to a few
   hours** to propagate. When all records go green, the domain is **Verified** and
   you can send from any address on it (e.g. `noreply@cfo-ai.io`).

> **Check propagation:** `nslookup -type=TXT resend._domainkey.cfo-ai.io`
> (or use <https://dnschecker.org>) should return your DKIM value.

---

## Step 4 — Configure the backend (`.env`)

The root `.env` already has placeholders (appended by setup). Fill them:

```bash
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx          # from Step 1
RESEND_FROM=CFO AI <noreply@cfo-ai.io>          # any address on your verified domain
PUBLIC_API_URL=https://cfo-ai.io                # public origin of the BACKEND API
# APP_URL is already set — used for post-confirm/unsubscribe redirects to the site
# PRICING_ADMIN_USER_IDS is already set — these users can broadcast / drain
```

- `PUBLIC_API_URL` is the origin used to build the **confirm** and **unsubscribe**
  links inside emails. In local dev you can leave it blank (links fall back to the
  request's own host, e.g. `http://127.0.0.1:8000`).
- Newsletter **admin** endpoints (`/broadcast`, `/drain-renewals`, `/subscribers`)
  are gated on the existing `PRICING_ADMIN_USER_IDS` allowlist — add the Supabase
  `auth.users.id` of whoever should be able to send broadcasts.

Restart the backend after editing `.env`:

```bash
.venv/Scripts/python.exe scripts/dev_backend.py      # local dev launcher
# or, in Docker/prod: docker compose build backend && docker compose up -d backend
```

---

## Step 5 — Apply the Supabase migration

Run `supabase/schema_phase_newsletter.sql` in **Supabase → SQL Editor**, then
**Settings → API → Reload schema cache** (per the project's schema-migration
discipline — the `NOTIFY pgrst` at the bottom is the optimistic complement; the
dashboard click is the deterministic step).

This creates `newsletter_subscribers`, `email_send_log`, `newsletter_broadcasts`,
and `renewal_email_queue`.

---

## Step 6 — Custom auth emails (password reset / signup) via Resend SMTP

This keeps Supabase's secure token flow but delivers branded mail through Resend.

### 6a. Point Supabase Auth at Resend SMTP

**Supabase → Project Settings → Authentication → SMTP Settings → Enable Custom SMTP:**

| Field | Value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` (SSL) — or `587` for STARTTLS |
| Username | `resend` |
| Password | **your Resend API key** (`re_...`) |
| Sender email | `noreply@cfo-ai.io` (on your verified domain) |
| Sender name | `CFO AI` |

Save. Supabase now sends all auth emails through Resend.

### 6b. Customize the auth email templates

**Supabase → Authentication → Email Templates.** Paste branded HTML for at least
**Reset Password** and **Confirm signup**. Keep the Supabase template variables
(`{{ .ConfirmationURL }}`, `{{ .Token }}`) — those carry the secure link.

Reset-password template (paste into the **Reset Password** template body):

```html
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafbfc;padding:24px 0;font-family:Helvetica,Arial,sans-serif;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid #d6dde6;border-radius:8px;overflow:hidden;">
      <tr><td style="background:linear-gradient(135deg,#003366,#1a5490);padding:22px 28px;">
        <span style="color:#fff;font-size:18px;font-weight:700;">CFO&nbsp;AI</span>
      </td></tr>
      <tr><td style="padding:28px;">
        <h1 style="font-size:20px;color:#003366;margin:0 0 12px;">Reset your password</h1>
        <p style="font-size:14px;line-height:1.6;color:#33404f;margin:0 0 20px;">
          We received a request to reset your CFO AI password. Click below to choose a new one.
          This link expires in 60 minutes. If you didn't request it, you can ignore this email.
        </p>
        <p style="margin:0 0 8px;">
          <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#003366;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:6px;">Reset password</a>
        </p>
      </td></tr>
      <tr><td style="padding:0 28px 28px;">
        <hr style="border:none;border-top:1px solid #e0e6ed;margin:8px 0 16px;">
        <p style="font-size:11px;color:#8a97a8;margin:0;">CFO AI — Romanian SME financial analysis.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
```

Confirm-signup template — same shell, swap the heading/copy to "Confirm your email"
and keep `{{ .ConfirmationURL }}`.

> **No app code is needed for password reset** — triggering it is the standard
> `supabase.auth.resetPasswordForEmail(email, { redirectTo })`. Resend + these
> templates only change how that email looks and who delivers it.

---

## Step 7 — (Optional) Add the public signup form

A ready component exists. Drop it anywhere public — the landing footer is ideal:

```tsx
import { NewsletterSignup } from "@/components/NewsletterSignup";
// ...
<NewsletterSignup source="landing-footer" />
```

Signed-in users already get a **Newsletter** toggle in **Settings** (no work needed).

---

## Step 8 — Test it

With the backend running and `RESEND_API_KEY` set:

```bash
# 1. Public subscribe → sends a confirmation email (double opt-in)
curl -X POST http://127.0.0.1:8000/api/newsletter/subscribe \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}'
#    → {"status":"confirmation_sent","delivered":true}
#    Click the link in the email → status becomes "confirmed" → welcome email.

# 2. Admin: subscriber counts  (TOKEN = a Supabase access_token for an admin user)
curl http://127.0.0.1:8000/api/newsletter/subscribers -H "Authorization: Bearer $TOKEN"

# 3. Admin: broadcast to all confirmed subscribers
curl -X POST http://127.0.0.1:8000/api/newsletter/broadcast \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"subject":"Hello","heading":"Product update","content_html":"<p>News here.</p>"}'

# 4. Admin: drain queued renewal reminders
curl -X POST http://127.0.0.1:8000/api/newsletter/drain-renewals -H "Authorization: Bearer $TOKEN"
```

Every send is recorded in `email_send_log` (status `sent` / `failed` / `skipped`)
— query that table to audit deliverability.

---

## Reference

### Endpoints (`src/engine/api/_newsletter.py`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/newsletter/subscribe` | public | start double opt-in |
| GET | `/api/newsletter/confirm?token=` | public | confirm (email link) |
| GET | `/api/newsletter/unsubscribe?token=` | public | one-click unsubscribe |
| GET | `/api/newsletter/status` | user | caller's status |
| POST | `/api/newsletter/subscribe-me` | user | subscribe self (instant) |
| POST | `/api/newsletter/unsubscribe-me` | user | unsubscribe self |
| GET | `/api/newsletter/subscribers` | admin | counts by status |
| POST | `/api/newsletter/broadcast` | admin | send to all confirmed |
| POST | `/api/newsletter/drain-renewals` | admin | drain renewal queue |

### Environment variables

| Var | Required | Notes |
|---|---|---|
| `RESEND_API_KEY` | yes (to send) | from Resend; without it, sends are no-ops |
| `RESEND_FROM` | yes | sender on your verified domain |
| `PUBLIC_API_URL` | prod | origin for email confirm/unsubscribe links |
| `APP_URL` | already set | post-confirm/unsubscribe redirect target |
| `PRICING_ADMIN_USER_IDS` | already set | who can broadcast / drain |

### Graceful degradation

No `RESEND_API_KEY` → every send returns `{"skipped": true}`, is logged, and the
HTTP request still succeeds. The app never crashes on a missing key or a Resend
outage — delivery is always best-effort and audited in `email_send_log`.
