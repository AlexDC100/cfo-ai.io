# Auth + email verification — operator handoff

> Diagnostic + FE fix for "sign up doesn't deliver emails / verification doesn't work."
> FE code changes shipped 2026-05-27. The remaining work is operator-side configuration
> on the Supabase Dashboard + DNS at the registrar — Claude cannot perform either
> without dashboard access.

## What got shipped (FE)

| Gap (from code audit) | Fix |
|---|---|
| `emailRedirectTo: window.location.origin` — sent users back to `/` with a long token-laden hash | Now `${window.location.origin}/auth/callback` |
| No `/auth/callback` route existed | New route + page (`src/pages/cfo/AuthCallback.tsx`) — exchanges the URL fragment, forwards to `/onboarding` (or `/login?reset=1` for password recovery) |
| Resend button had no cooldown | 60s cooldown with live countdown label + accessible `aria-label` + positive "Sent" chip on success |
| Resend mis-treated `User already registered` as failure | Now silently swallowed (Supabase returns it on every resend; the email goes out regardless) |
| Confirmation panel copy said "wait 60s and try again" without enforcing it | Now both the copy and the disabled button agree on the 60s window |

Files touched (FE only — no engine code, no deploy required beyond the standard
`docker compose build frontend && docker compose up -d frontend`):

- `src/pages/cfo/AuthCallback.tsx` (new)
- `src/App.tsx` (+ sync import + route)
- `src/lib/auth.tsx` (emailRedirectTo)
- `src/components/cfo/AuthCard.tsx` (cooldown + positive chip + isAlreadyRegistered guard)
- `src/i18n/locales/{en,ro,fr}.json` (`authCallback.*` keys)

## What still needs the operator (you)

Even with the FE fixes shipped, an email won't reach the user unless **all** of the
following are true on the Supabase project. The FE changes are necessary but not
sufficient — Supabase needs to be told *how* to send the mail and *where* to send
the user back to.

### 1. Confirm email is ON in Supabase Auth

**Supabase Dashboard → Authentication → Providers → Email**

- "Confirm email" toggle must be **ON**. (You confirmed this already.)
- Verify "Secure email change" is ON if you want email-change requests to be
  double-confirmed (recommended).

### 2. Custom SMTP must be configured

> This is almost certainly the cause if signup succeeds but no email arrives.

**Supabase Dashboard → Project Settings → Auth → SMTP Settings**

Supabase's built-in SMTP relay has a **2 emails/hour project-wide cap** and is
not for production use. If left on the default, signups quietly drop most
verification emails — they just don't get sent. Symptoms:

- Signup completes, FE shows "Check your email"
- `auth.users` row exists in the DB
- Nothing arrives in the inbox, ever
- No error visible anywhere except Supabase's internal logs

Options (pick one; configure the credentials in the Supabase Dashboard form):

| Provider | Best for | Pricing | DKIM setup |
|---|---|---|---|
| **Resend** (recommended) | Modern, dev-friendly, great deliverability | Free up to 3K/mo | One DNS record |
| Postmark | Transactional-only, top-tier deliverability | $15/mo for 10K | One DNS record |
| AWS SES | Cheapest at scale, more setup | $0.10 per 1K | More DNS records |
| SendGrid | Established, lots of docs | Free up to 100/day | Multiple DNS records |

Pick one, set up the account, copy the SMTP credentials into Supabase's form,
hit "Send test email" — if that test arrives, signup confirmation will too.

### 3. Redirect URLs must be whitelisted

**Supabase Dashboard → Authentication → URL Configuration → Redirect URLs**

Add these entries (one per line):

```
https://cfo-ai.io/auth/callback
https://www.cfo-ai.io/auth/callback
http://localhost:5180/auth/callback
http://localhost:5173/auth/callback
```

Supabase refuses to redirect to any URL not in this list. If the entry is missing,
the email link will refuse to redirect and Supabase shows its own error page
instead of bouncing back to our `/auth/callback` route.

Also set the **Site URL** to `https://cfo-ai.io` (no trailing slash). This is the
fallback Supabase uses if `emailRedirectTo` is missing from a request.

### 4. SPF / DKIM / DMARC on cfo-ai.io

Without these, mailbox providers (Gmail, Outlook) silently drop or spam-bin our
mail because they can't verify it actually came from us. Even with a great SMTP
provider, delivery to corporate inboxes will be ~30-50% without DKIM.

At the domain registrar (where cfo-ai.io is hosted — likely Cloudflare or a
similar DNS panel), add three TXT records:

**SPF** (one record — replace `_spf.resend.com` with whatever your SMTP provider
specifies in their docs):

```
TXT  @  "v=spf1 include:_spf.resend.com ~all"
```

If you already have an SPF record (e.g. for Google Workspace), MERGE it — you
can only have one SPF record per domain. The merged form looks like:

```
TXT  @  "v=spf1 include:_spf.google.com include:_spf.resend.com ~all"
```

**DKIM** — your SMTP provider gives you the exact record (a long base64 public
key). Resend's looks like:

```
TXT  resend._domainkey  "p=MIGfMA0GCSqGSIb3DQEBAQUAA4..."
```

**DMARC** (start in p=none reporting-only mode so you can see what's happening
without breaking anything):

```
TXT  _dmarc  "v=DMARC1; p=none; rua=mailto:dmarc@cfo-ai.io"
```

After all three propagate (5-60min), run https://www.mail-tester.com/ as a
sanity check — aim for 9/10 or higher.

### 5. Email template HTML

**Supabase Dashboard → Authentication → Email Templates → Confirm signup**

The default template is plain and uses `{{ .ConfirmationURL }}` as a bare link.
Verify two things:

- The link target uses `{{ .ConfirmationURL }}` (this is what Supabase fills with
  the redirect to `/auth/callback#access_token=...`)
- The "Subject" is something clearer than the default (e.g. "Confirm your CFO AI
  account") — the default subject lands in spam more often

Optionally style it to match the product. If you do, keep the `{{ .ConfirmationURL }}`
inside an `<a href="{{ .ConfirmationURL }}">` and test by signing up with a fresh
email.

### 6. Verify end-to-end

After all the above are in place:

1. Open an incognito window → go to https://cfo-ai.io/signup
2. Sign up with a real email you have access to (Gmail works well for testing)
3. You should see "Check your email"
4. Within ~10s, the confirmation email should arrive
5. Click the link in the email — the browser should land on https://cfo-ai.io/auth/callback
6. After ~1s of "Verifying your email…" you should be redirected to /onboarding
7. Pick an industry, hit Continue, land on the empty-state dashboard

If step 4 fails (no email arrives within 60s, including spam): SMTP not
configured or DKIM failing. Check the SMTP provider's dashboard — they log
every send attempt with success/bounce status.

If step 5 fails (email arrives but link redirects to a Supabase error page or
to `cfo-ai.io/` instead of `cfo-ai.io/auth/callback`): Redirect URLs not
whitelisted. Add them per step 3.

If step 6 fails (user lands on `/auth/callback` but stays on "We hit a snag"
forever): the SDK didn't pick up the token. Check the browser URL bar — if it
still has `#access_token=...` in it after 5s, our AuthCallback's auth state
listener didn't fire. Open browser DevTools → Console — there should be no
errors. If there are, paste them back to Claude.

## Why these are operator-side, not FE-side

Supabase Auth is a SaaS — its config lives in the Supabase Dashboard, not in
our repo. Anyone with the Supabase project's Owner / Admin role can change
SMTP, Redirect URLs, and Email Templates from the dashboard in 5 minutes.

DNS records live at the domain registrar. Both of those are explicitly outside
the boundary of code that gets `git push`'d to the FE repo, which is why this
work is captured in a handoff doc rather than a pull request.

## Onboarding errors (Part B from the original diagnostic prompt)

The FE audit also surfaced these onboarding-flow gaps. Not all are shipped in
this pass — explicitly batched here for the next session:

- ⚠️ **B-H4: No env-var boot check.** If `VITE_SUPABASE_URL` or
  `VITE_SUPABASE_ANON_KEY` is missing from the build environment, the app
  silently runs with auth disabled (`supabaseEnabled = false`). The existing
  banner in AuthCard already says "Authentication isn't configured" — but
  the env-missing case should also log a loud console warning at boot so
  it's obvious during a fresh deploy. **Status: NOT shipped this pass.**
- ⚠️ **B-H5: No react-query cache clear on signOut.** A second user signing
  in on the same browser sees the previous user's cached dashboard data
  for up to 5min (the configured `staleTime`). The fix is one line in
  `auth.tsx`'s onAuthStateChange handler: `queryClient.clear()`. **Status:
  NOT shipped this pass.**
- ⚠️ **B-H8: No route-level error boundary.** A throw inside any route nukes
  the whole app (the top-level ErrorBoundary catches it but resets the
  whole tree). A `<RouteErrorBoundary>` wrapping each `<Outlet />` would
  let a single page crash without unmounting AuthProvider / QueryClient.
  **Status: NOT shipped this pass.**
- ⚠️ **B-H1 (auth race): /onboarding briefly flashes after signup before
  the AuthGuard resolves.** Mitigated but not eliminated by AuthCallback's
  700ms delay before navigating; a more robust fix is for AuthGuard to
  show its skeleton until `status !== "loading"`. **Status: probably fine
  in the new flow; revisit if users report it.**

These can ship in the next pass once email verification is confirmed
working end-to-end (Step 6 above passes for a real user).
