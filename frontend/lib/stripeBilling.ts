// Stripe-backed subscription read + portal + cancel helpers. Side-by-side
// with the legacy `lib/billing.ts` (which uses a 3-tier `PlanId` model);
// this file is the source of truth for the new founder/standard model.
//
// Read shape comes from /api/billing/subscription; the route returns the
// row from the `subscriptions` table (RLS-scoped — caller only sees their
// own org's subscription).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabase } from "@/lib/supabase";

/** Tier values from the May 2026 pricing redesign (see `_pricing_config.py`).
 *  Legacy values (`founder`, `standard`, `solo`, `business`, `professional`)
 *  may also appear in `plan` for older cohorts; the FE renders both. */
export type StripePlanKey =
  | "trial" | "intro" | "starter" | "pro"
  | "founder" | "standard"
  | "solo" | "business" | "professional";

export interface StripeSubscription {
  /** New 4-tier model (May 2026). Null for legacy rows. */
  tier: StripePlanKey | null;
  /** `tier` if present, else `plan` (legacy). Always one of `StripePlanKey`
   *  for display purposes — never null when subscription is active. */
  plan_key: StripePlanKey | null;
  /** Legacy Phase 3 plan column — kept for backward compat. */
  plan: string | null;
  billing_cycle: string | null;
  status: string;
  current_period_end: string | null;
  current_period_start: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  is_founding_member: boolean;
  /** Legacy founder-cohort (Phase 3). */
  is_founder: boolean;
  founder_renewal_at: string | null;
  founder_renewal_price_eur: number | null;
}

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

async function authedFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

async function fetchSubscription(): Promise<StripeSubscription | null> {
  const res = await authedFetch("/api/billing/subscription");
  if (!res || !res.ok) return null;
  const body = await res.json();
  return body.subscription ?? null;
}

export function useStripeSubscription() {
  return useQuery({
    queryKey: ["stripe-subscription"],
    queryFn: fetchSubscription,
    staleTime: 60 * 1000,
  });
}

export async function openBillingPortal(): Promise<boolean> {
  const res = await authedFetch("/api/billing/portal", { method: "POST" });
  if (!res || !res.ok) return false;
  const body = await res.json();
  if (body.url) {
    window.location.href = body.url as string;
    return true;
  }
  return false;
}

export async function cancelAtPeriodEnd(): Promise<boolean> {
  const res = await authedFetch("/api/billing/cancel", { method: "POST" });
  return !!(res && res.ok);
}

export function useInvalidateBilling() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["stripe-subscription"] });
}

/** WS2 — preview of the next Stripe invoice for the caller.
 *  base_amount = flat tier price for the current cycle.
 *  extras_count / extras_amount = accumulated metered overages so far.
 *  total_estimated = what Stripe will bill on next_invoice_date.
 *  null when the user has no active subscription (trial / pre-checkout). */
export interface UpcomingInvoice {
  base_amount: number;
  extras_count: number;
  extras_amount: number;
  total_estimated: number;
  currency: string;
  next_invoice_date: string | null;
}

async function fetchUpcomingInvoice(): Promise<UpcomingInvoice | null> {
  const res = await authedFetch("/api/billing/upcoming-invoice");
  if (!res || !res.ok) return null;
  const body = await res.json();
  return body.invoice ?? null;
}

export function useUpcomingInvoice() {
  return useQuery({
    queryKey: ["stripe-upcoming-invoice"],
    queryFn: fetchUpcomingInvoice,
    // Refresh every 60s so the live counter reflects extras as they happen
    // (a user finishing an extra-doc upload should see the total tick up
    // by €2.50/€3.00 on their next Settings → Billing view).
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });
}
