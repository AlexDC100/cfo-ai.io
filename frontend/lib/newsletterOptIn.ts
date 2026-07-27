// Signup newsletter opt-in — single opt-in, no confirmation email.
//
// WHY THIS EXISTS
// ===============
// Ticking "Subscribe to the newsletter" during signup IS the consent. The
// user should never receive a second "confirm your subscription" email on
// top of the account-confirmation one they already have to click.
//
// The obvious implementation — call the public POST /api/newsletter/subscribe
// from AuthCard — cannot do that: it is the double opt-in route and always
// mails a confirm link. The endpoint that skips the double opt-in
// (POST /api/newsletter/subscribe-me, "email already verified by Supabase
// Auth") needs a Bearer JWT, and at the moment signUp() returns there is no
// session yet whenever email confirmation is on (mailer_autoconfirm=false).
//
// So the intent is parked here and flushed the first time a real session
// exists. That ordering is not a workaround, it's the correct one: by the
// time the user has a session they have clicked the account-confirmation
// link, so their ownership of the address is proven — exactly the condition
// subscribe-me documents as its reason for skipping double opt-in. We get
// verified-email quality with one email instead of two.
//
// Deliberately NOT changed: the public NewsletterSignup form keeps double
// opt-in. There, anyone can type anyone's address with no proof of
// ownership, so the confirm click is the only thing standing between the
// list and subscription injection.

import { subscribeMe, NewsletterApiError } from "@/lib/newsletterApi";

const KEY = "cfo-ai-newsletter-optin-pending-v1";

/** Record that this address ticked the newsletter box during signup. */
export function markNewsletterOptInPending(email: string): void {
  try {
    localStorage.setItem(KEY, email.trim().toLowerCase());
  } catch {
    /* private mode / quota — opting in is best-effort, never blocks signup */
  }
}

export function clearNewsletterOptInPending(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

function readPending(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * Flush a parked opt-in now that `sessionEmail` is signed in. No-op when
 * nothing is pending, so this is safe to call on every auth state change.
 */
export async function flushNewsletterOptIn(sessionEmail: string | null | undefined): Promise<void> {
  const pending = readPending();
  if (!pending) return;

  // Guard against subscribing the wrong person. Someone can sign up on a
  // shared browser, never confirm, and a different account can sign in
  // before the flag is consumed — without this check that second person
  // silently lands on the list.
  const current = (sessionEmail ?? "").trim().toLowerCase();
  if (!current) return;
  if (current !== pending) {
    clearNewsletterOptInPending();
    return;
  }

  try {
    await subscribeMe();
    clearNewsletterOptInPending();
  } catch (err) {
    // Keep the flag on 401 (token not ready yet) and on transport failures
    // (engine down) so the next sign-in retries. Drop it on any other 4xx,
    // which means the request itself is bad and will never succeed.
    const status = err instanceof NewsletterApiError ? err.status : 0;
    if (status >= 400 && status !== 401) clearNewsletterOptInPending();
  }
}
