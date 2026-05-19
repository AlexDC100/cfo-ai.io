// Stripe-backed subscription read + portal + cancel helpers. Side-by-side
// with the legacy `lib/billing.ts` (which uses a 3-tier `PlanId` model);
// this file is the source of truth for the new founder/standard model.
//
// Read shape comes from /api/billing/subscription; the route returns the
// row from the `subscriptions` table (RLS-scoped — caller only sees their
// own org's subscription).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabase } from "@/lib/supabase";

export type StripePlanKey = "founder" | "standard";

export interface StripeSubscription {
  plan_key: StripePlanKey;
  status: string;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
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
