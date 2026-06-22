// planState.ts — frontend typed client for the new plan-state surface.
//
// PAIRS WITH
//   · `_plan_state.py` (backend reader)
//   · `_pricing_routes.py` (HTTP surface)
//   · `pricingConfig.ts` (public pricing config)
//
// HTTP MAP
//   GET  /api/plan/state              → usePlanState() hook
//   GET  /api/plan/check-doc          → checkDocQuota() one-shot
//   POST /api/plan/confirm-extra-doc  → confirmExtraDoc()
//
// All routes require the Supabase JWT; the helpers below attach it
// automatically (same pattern as `industryApi.ts`).

import { useCallback, useEffect, useState } from "react";

import { getSupabase } from "@/lib/supabase";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// ─────────────────────────────────────────────────────────────────────
// Types — mirror the backend `state_to_public_dict` shape
// ─────────────────────────────────────────────────────────────────────

export type PlanKey = "trial" | "intro" | "starter" | "pro";

export interface PlanState {
  plan_key: PlanKey;
  plan_display_name: string;
  plan_price_eur: number;
  plan_recurring: boolean;
  included_docs: number;
  extra_doc_eur: number | null;
  docs_used: number;
  extra_docs_billed_this_period: number;
  /** Pricing V3 (gap D) — extras the user confirmed but whose analysis
   *  is still running. They count toward usage but haven't been
   *  billed yet. Falls back to `undefined` if the backend hasn't
   *  surfaced this field yet (V2 deployments). */
  extra_docs_pending_this_period?: number;
  chat_used_today: number;
  chat_daily_cap: number | null;
  chat_used_this_period: number;
  chat_monthly_cap: number | null;
  window_expires_at: string | null;
  today: string;
  period_month: string;
}

export type DocQuotaKind = "allowed" | "extra_doc_bill_prompt" | "blocked";

export interface DocQuotaCheck {
  kind: DocQuotaKind;
  plan_key: string;
  docs_used: number;
  docs_included: number;
  extra_doc_eur: number | null;
  message: string;
}

export class PlanApiError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = "PlanApiError";
    this.status = status;
    this.detail = detail;
  }
}

// ─────────────────────────────────────────────────────────────────────
// fetch helper (same shape as industryApi)
// ─────────────────────────────────────────────────────────────────────

async function authedFetch<T>(method: "GET" | "POST", path: string): Promise<T> {
  const sb = getSupabase();
  if (!sb) throw new PlanApiError("Supabase not configured", 401, null);
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new PlanApiError("Not signed in", 401, null);
  const r = await fetch(`${API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    let detail: unknown = null;
    try { detail = await r.json(); } catch { detail = await r.text(); }
    throw new PlanApiError(`HTTP ${r.status} on ${method} ${path}`, r.status, detail);
  }
  const text = await r.text();
  return (text ? JSON.parse(text) : null) as T;
}

// ─────────────────────────────────────────────────────────────────────
// Hook + one-shot helpers
// ─────────────────────────────────────────────────────────────────────

export function usePlanState(): {
  state: PlanState | null;
  loading: boolean;
  error: PlanApiError | null;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<PlanState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<PlanApiError | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await authedFetch<PlanState>("GET", "/api/plan/state");
      setState(s);
    } catch (e) {
      if (e instanceof PlanApiError) setError(e);
      else setError(new PlanApiError(String(e), 0, null));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const s = await authedFetch<PlanState>("GET", "/api/plan/state");
        if (mounted) { setState(s); setLoading(false); }
      } catch (e) {
        if (!mounted) return;
        if (e instanceof PlanApiError) setError(e);
        else setError(new PlanApiError(String(e), 0, null));
        setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  return { state, loading, error, refresh };
}

export async function checkDocQuota(): Promise<DocQuotaCheck> {
  return authedFetch<DocQuotaCheck>("GET", "/api/plan/check-doc");
}

export async function confirmExtraDoc(): Promise<{
  ok: boolean;
  extra_doc_eur_marked: number | null;
  plan_key: string;
}> {
  return authedFetch("POST", "/api/plan/confirm-extra-doc");
}

// ─────────────────────────────────────────────────────────────────────
// Helpers for UI formatting
// ─────────────────────────────────────────────────────────────────────

export function planUsagePct(used: number, cap: number | null): number {
  if (!cap || cap <= 0) return 0;
  return Math.min(100, Math.round((used / cap) * 100));
}

/** Plain-English message for a 429 chat-cap-reached response from /api/ask. */
export function chatCapMessage(detail: Record<string, unknown> | null): string {
  if (!detail) return "Daily or monthly Ask CFO AI limit reached for your plan.";
  const msg = typeof detail.message === "string" ? detail.message : "";
  return msg || "Daily or monthly Ask CFO AI limit reached for your plan.";
}
