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

// Mirrors pricingConfig.ts — solo/multi added in the 2026-08 tier
// restructure; starter stays for legacy holders.
export type PlanKey = "trial" | "intro" | "starter" | "solo" | "pro" | "multi";

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
  // ── 2026-08 tier restructure — ALL optional so plan state from an old
  //    backend still parses. UI-side gates fail OPEN when these are
  //    absent; the server remains the enforcement floor. ────────────────
  /** Workspace cap for the plan (1 solo, 5 pro/multi). */
  max_workspaces?: number;
  /** What a grandfathered legacy subscriber actually PAYS (e.g. the
   *  39.99-era Pro on Multi-Country entitlements). Null/absent for
   *  everyone else — fall back to plan_price_eur. */
  billed_price_eur?: number | null;
  /** Whether non-Romanian documents are allowed on this plan (multi only). */
  allows_non_ro?: boolean;
  /** Non-RO docs consumed this period (multi only). */
  nonro_used?: number;
  /** Non-RO docs included per month (multi only). */
  nonro_included?: number;
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
// Session cache — keep the last-fetched plan so re-mounting the hook (e.g.
// re-opening the Command Center, which remounts AccountTab) renders the plan
// INSTANTLY from cache and revalidates in the background instead of flashing
// an empty section for the ~1s the request takes.
// ─────────────────────────────────────────────────────────────────────

const PLAN_CACHE_KEY = "cfo-ai-plan-state-v1";

let cachedState: PlanState | null = (() => {
  try {
    const raw = localStorage.getItem(PLAN_CACHE_KEY);
    return raw ? (JSON.parse(raw) as PlanState) : null;
  } catch {
    return null;
  }
})();

type PlanListener = (s: PlanState | null, e: PlanApiError | null) => void;
const listeners = new Set<PlanListener>();

/** In-flight request shared by every mounted hook. Settings → Plan alone
 *  mounts three consumers (BillingSection, UsageThisMonth, CurrentPlanCard);
 *  before this, each fired its OWN GET /api/plan/state and each kept its own
 *  error state. One of those racing requests failing was enough to blank
 *  UsageThisMonth — which hides on error — while the other two rendered
 *  fine, so the usage cards vanished the moment the plan card resolved.
 *  Now one request serves all callers and they can't disagree. */
let inflight: Promise<PlanState> | null = null;

function setCachedState(s: PlanState): void {
  cachedState = s;
  try {
    localStorage.setItem(PLAN_CACHE_KEY, JSON.stringify(s));
  } catch {
    /* ignore quota / disabled storage */
  }
  for (const l of listeners) l(s, null);
}

/** Fetch plan state, coalescing concurrent callers onto one request. */
function loadPlanState(force = false): Promise<PlanState> {
  if (inflight && !force) return inflight;
  inflight = (async () => {
    try {
      const s = await authedFetch<PlanState>("GET", "/api/plan/state");
      setCachedState(s);
      return s;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
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
  // Seed from the session cache so the plan is on screen immediately; only
  // show the loading state when we have nothing cached to render.
  const [state, setState] = useState<PlanState | null>(cachedState);
  const [loading, setLoading] = useState<boolean>(cachedState === null);
  const [error, setError] = useState<PlanApiError | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await loadPlanState(true));
    } catch (e) {
      if (e instanceof PlanApiError) setError(e);
      else setError(new PlanApiError(String(e), 0, null));
    } finally {
      setLoading(false);
    }
  }, []);

  // Adopt state fetched by ANY other mounted consumer, so a component that
  // mounts mid-flight doesn't need its own request to catch up.
  useEffect(() => {
    const l: PlanListener = (s, e) => {
      if (s) { setState(s); setError(null); setLoading(false); }
      else if (e) { setError(e); setLoading(false); }
    };
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadPlanState()
      .then((s) => { if (mounted) { setState(s); setError(null); setLoading(false); } })
      .catch((e) => {
        if (!mounted) return;
        setError(e instanceof PlanApiError ? e : new PlanApiError(String(e), 0, null));
        setLoading(false);
      });
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

/** True when creating one more workspace would exceed the plan's cap.
 *  FAILS OPEN by design: no plan state (old backend, fetch error, signed
 *  out) or no `max_workspaces` field ⇒ false, so the UI never blocks a
 *  user the server would allow. The SQL-side hard floor in
 *  `create_workspace` is the actual enforcement. */
export function workspaceCapReached(
  state: Pick<PlanState, "max_workspaces"> | null | undefined,
  currentWorkspaceCount: number,
): boolean {
  const cap = state?.max_workspaces;
  if (typeof cap !== "number" || cap <= 0) return false;
  return currentWorkspaceCount >= cap;
}

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
