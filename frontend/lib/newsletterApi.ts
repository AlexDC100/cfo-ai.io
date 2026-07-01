// Newsletter API client — mirrors src/engine/api/_newsletter.py.
//
//   Public:    subscribe(email)             → double opt-in (confirmation email)
//   Per-user:  getStatus / subscribeMe / unsubscribeMe  (Bearer JWT)
//   Admin:     getSubscriberCounts / broadcast          (Bearer + allowlist)
//
// The public subscribe call needs NO auth (landing-page footer uses it).
// Per-user calls attach the Supabase session token.

import { getSupabase } from "@/lib/supabase";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

export class NewsletterApiError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = "NewsletterApiError";
    this.status = status;
    this.detail = detail;
  }
}

export type SubscriptionStatus = "none" | "pending" | "confirmed" | "unsubscribed";

async function authHeader(): Promise<Record<string, string>> {
  const sb = getSupabase();
  if (!sb) throw new NewsletterApiError("Supabase not configured", 401, null);
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new NewsletterApiError("Not signed in", 401, null);
  return { Authorization: `Bearer ${token}` };
}

async function parse<T>(resp: Response, method: string, path: string): Promise<T> {
  if (!resp.ok) {
    let detail: unknown = null;
    try { detail = await resp.json(); } catch { detail = await resp.text(); }
    throw new NewsletterApiError(
      `Newsletter API ${method} ${path} failed (HTTP ${resp.status})`,
      resp.status,
      detail,
    );
  }
  return (await resp.json()) as T;
}

// ── Public: subscribe (no auth) ─────────────────────────────────────────────

export async function subscribe(
  email: string,
  source = "web",
): Promise<{ status: "confirmation_sent" | "already_subscribed"; delivered?: boolean }> {
  const resp = await fetch(`${API_URL}/api/newsletter/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, source }),
  });
  return parse(resp, "POST", "/api/newsletter/subscribe");
}

// ── Per-user (signed-in) ────────────────────────────────────────────────────

export async function getStatus(): Promise<SubscriptionStatus> {
  const resp = await fetch(`${API_URL}/api/newsletter/status`, {
    headers: await authHeader(),
  });
  const data = await parse<{ status: SubscriptionStatus }>(resp, "GET", "/api/newsletter/status");
  return data.status;
}

export async function subscribeMe(): Promise<SubscriptionStatus> {
  const resp = await fetch(`${API_URL}/api/newsletter/subscribe-me`, {
    method: "POST",
    headers: await authHeader(),
  });
  const data = await parse<{ status: SubscriptionStatus }>(resp, "POST", "/api/newsletter/subscribe-me");
  return data.status;
}

export async function unsubscribeMe(): Promise<SubscriptionStatus> {
  const resp = await fetch(`${API_URL}/api/newsletter/unsubscribe-me`, {
    method: "POST",
    headers: await authHeader(),
  });
  const data = await parse<{ status: SubscriptionStatus }>(resp, "POST", "/api/newsletter/unsubscribe-me");
  return data.status;
}

// ── Admin ───────────────────────────────────────────────────────────────────

export interface SubscriberCounts {
  pending: number;
  confirmed: number;
  unsubscribed: number;
  total: number;
}

export async function getSubscriberCounts(): Promise<SubscriberCounts> {
  const resp = await fetch(`${API_URL}/api/newsletter/subscribers`, {
    headers: await authHeader(),
  });
  return parse(resp, "GET", "/api/newsletter/subscribers");
}

export interface BroadcastResult {
  status: "sent" | "partial" | "failed" | "skipped";
  recipients: number;
  sent: number;
  failed: number;
}

export async function broadcast(input: {
  subject: string;
  heading: string;
  content_html: string;
}): Promise<BroadcastResult> {
  const resp = await fetch(`${API_URL}/api/newsletter/broadcast`, {
    method: "POST",
    headers: { ...(await authHeader()), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parse(resp, "POST", "/api/newsletter/broadcast");
}

// ── Debug: preview every mail type by sending it to yourself ────────────────
//
// Backed by POST /api/newsletter/debug-send. The backend always delivers to
// the caller's own verified email (no recipient field), so this can never be
// used to mail anyone else. Handy for eyeballing the branded templates.

// Keep in step with _DEBUG_MAIL_KINDS in src/engine/api/_newsletter.py.
export type DebugMailKind =
  | "newsletter_confirm"
  | "newsletter_welcome"
  | "newsletter_broadcast"
  | "renewal_reminder"
  | "password_reset"
  | "signup_confirm";

export interface DebugSendResult {
  status: "sent";
  to: string;
  kind: DebugMailKind;
  id: string | null;
}

export async function debugSendMail(kind: DebugMailKind): Promise<DebugSendResult> {
  const resp = await fetch(`${API_URL}/api/newsletter/debug-send`, {
    method: "POST",
    headers: { ...(await authHeader()), "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  return parse(resp, "POST", "/api/newsletter/debug-send");
}
