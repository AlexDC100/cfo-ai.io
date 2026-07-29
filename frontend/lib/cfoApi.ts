// CFO AI backend client. Wraps the /api/cfo/* router exposed by the engine.
//
// All endpoints take the same TodayRequest body (company + skus + categories +
// period). Responses are typed; the Today page is the canonical source of
// truth for the executive_summary block, and the others are scoped to their
// section's data.

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// Ask CFO AI chat runs as a Supabase Edge Function (supabase/functions/chat-llm),
// not the FastAPI engine — it needs no backend running at all, locally or in
// prod. Every other cfoApi call still goes through the engine at API_URL.
const SUPABASE_FUNCTIONS_URL = (() => {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  return base ? `${base.replace(/\/$/, "")}/functions/v1` : undefined;
})();

/** Bare liveness probe against the FastAPI engine's `/health` — no auth,
 *  no `/api` prefix, deliberately bypasses the `call()`/`callUrl()`
 *  wrappers above (no JWT/org headers to attach, and a failed probe is an
 *  expected, routine outcome here, not an error to throw). Used by
 *  `useBackendStatus` to drive the TopHeader connection indicator. */
export async function checkBackendHealth(timeoutMs = 4000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type Bucket = "PROTECT" | "WATCH" | "FIX" | "REDUCE" | "LIQUIDATE" | "SCALE";
export type Urgency = "low" | "medium" | "high" | "critical";
export type RecStatus =
  | "new"
  | "in_review"
  | "approved"
  | "assigned"
  | "done"
  | "rejected"
  | "archived";

export interface CompanyContext {
  name: string;
  industry?: string;
  currency?: string;
  cost_of_capital_pct?: number;
  fiscal_year_start_month?: number;
}

export interface SkuRowIn {
  sku_id: string;
  sku_name?: string;
  category: string;
  brand?: string;
  supplier?: string;
  customer?: string;
  channel?: string;
  volume_tons: number;
  revenue_kron: number;
  cogs_kron?: number;
  gross_margin_pct: number;
  dio_days?: number;
  dso_days?: number;
  dpo_days?: number;
  woca_kron?: number;
  avg_inventory_kron?: number;
}

export interface CategoryRowIn {
  category: string;
  business_unit?: string;
  volume_tons: number;
  niv_kron: number;
  gm_pct: number;
  dio_days: number;
  dso_days?: number;
  dpo_days?: number;
  ccc_days?: number;
  woca_kron?: number;
}

export interface TodayRequest {
  company: CompanyContext;
  skus: SkuRowIn[];
  categories: CategoryRowIn[];
  period_months?: number;
  persist_recommendations?: boolean;
}

export interface ExecutiveSummary {
  cash_trapped_kron: number;
  cash_recovery_potential_kron: number;
  roic_pct: number;
  real_margin_pct: number;
  products_analyzed: number;
  categories_analyzed: number;
  urgent_actions: number;
  bucket_counts: Record<string, number>;
}

export interface Briefing {
  headline: string;
  body: string;
}

export interface Recommendation {
  id: number | null;
  target_type: string;
  target_id: string;
  bucket: Bucket;
  action_type: string;
  title: string;
  explanation: string;
  expected_cash_impact_kron: number | null;
  expected_margin_impact_pct: number | null;
  urgency: Urgency;
  owner: string | null;
  status: RecStatus;
  due_date: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface TodayResponse {
  company: { name: string; industry?: string; currency: string; cost_of_capital: number };
  executive_summary: ExecutiveSummary;
  briefing: Briefing;
  top_actions: Recommendation[];
  run_at: string;
}

export interface CapitalByCategory {
  category: string;
  capital_trapped_kron: number;
  dio_days: number;
  ccc_days: number | null;
  real_margin_pct: number;
  niv_kron: number;
}

export interface CashItem {
  id: string;
  category: string | null;
  capital_trapped_kron: number;
  dio_days: number;
  real_margin_pct: number;
  bucket: Bucket;
}

export interface CashResponse {
  company: TodayResponse["company"];
  working_capital_bridge: {
    inventory_kron: number;
    total_capital_trapped_kron: number;
    recoverable_kron: number;
  };
  capital_by_category: CapitalByCategory[];
  dead_stock: CashItem[];
  slow_moving: CashItem[];
  recoverable: { id: string; category: string | null; freed_kron: number; bucket: Bucket }[];
}

export interface MarginRow {
  category: string;
  gross_margin_pct: number;
  real_margin_pct: number;
  margin_leak_pp: number;
  niv_kron: number;
  dio_days: number;
}

export interface ProfitResponse {
  company: TodayResponse["company"];
  portfolio: {
    weighted_gross_margin_pct: number;
    weighted_real_margin_pct: number;
    margin_leak_pp: number;
    cost_of_capital_pct: number;
  };
  margin_comparison: MarginRow[];
  roic_ranking: { category: string; roic_pct: number; abs_profit_kron: number }[];
  gmroii_ranking: { category: string; gmroii_pct: number; inventory_turns: number | null }[];
}

export interface ProductRow {
  id: string;
  category: string | null;
  bucket: Bucket;
  real_margin_pct: number;
  gross_margin_pct: number | null;
  volume_tons: number;
  niv_kron: number | null;
  abs_profit_kron: number;
  dio_days: number;
  ccc_days: number | null;
  capital_trapped_kron: number | null;
  roic_pct: number | null;
  gmroii_pct: number | null;
  reason: string | null;
  recommendation: string | null;
}

export interface ProductsResponse {
  company: TodayResponse["company"];
  rows: ProductRow[];
}

/**
 * Pricing V3 — typed error so chat-cap 429s can be rendered as a
 * friendly cap-reached message instead of a generic "Couldn't reach
 * the assistant" string. Carries the parsed `detail` object so the
 * UI can show the right reset timing + upgrade CTA.
 */
export class CfoApiError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = "CfoApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function callUrl<T>(url: string, init: RequestInit = {}): Promise<T> {
  // Pricing V3 — attach the Supabase JWT to every cfoApi call so
  // server-side caps (chat reserve/commit) can resolve the user.
  // Endpoints that don't require auth simply ignore the header.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined ?? {}),
  };
  try {
    const { getSupabase } = await import("@/lib/supabase");
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.auth.getSession();
      const token = data.session?.access_token;
      if (token && !headers.Authorization) {
        headers.Authorization = `Bearer ${token}`;
      }
      // Which workspace (organization) this request is about. The engine
      // validates it against the caller's memberships and 403s on a
      // non-member org — it is a selector, never a grant. Without it the
      // backend falls back to the user's oldest workspace, which is wrong
      // for anyone running more than one company.
      const uid = data.session?.user?.id;
      if (uid && !headers["X-Org-Id"]) {
        const { getActiveOrgId } = await import("@/lib/activeOrg");
        const orgId = getActiveOrgId(uid);
        if (orgId) headers["X-Org-Id"] = orgId;
      }
    }
  } catch { /* supabase not loaded — proceed unauthenticated */ }

  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let detail: unknown = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail !== undefined) detail = body.detail;
    } catch {
      /* leave default */
    }
    const msg =
      typeof detail === "string"
        ? detail
        : typeof detail === "object" && detail !== null && "message" in detail
        ? String((detail as { message?: unknown }).message ?? `${res.status} ${res.statusText}`)
        : JSON.stringify(detail);
    throw new CfoApiError(msg, res.status, detail);
  }
  return (await res.json()) as T;
}

function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  return callUrl<T>(`${API_URL}${path}`, init);
}

export const cfoApi = {
  today: (req: TodayRequest) =>
    call<TodayResponse>("/api/cfo/today", { method: "POST", body: JSON.stringify(req) }),
  cash: (req: TodayRequest) =>
    call<CashResponse>("/api/cfo/cash", { method: "POST", body: JSON.stringify(req) }),
  profit: (req: TodayRequest) =>
    call<ProfitResponse>("/api/cfo/profit", { method: "POST", body: JSON.stringify(req) }),
  products: (req: TodayRequest) =>
    call<ProductsResponse>("/api/cfo/products", {
      method: "POST",
      body: JSON.stringify(req),
    }),
  listDecisions: (params: { status?: string; bucket?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.bucket) qs.set("bucket", params.bucket);
    if (params.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return call<{ count: number; recommendations: Recommendation[] }>(
      `/api/cfo/decisions${suffix}`,
    );
  },
  setDecisionStatus: (id: number, status: RecStatus, owner?: string) =>
    call<Recommendation>(`/api/cfo/decisions/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status, owner }),
    }),

  // `chat` (structured intent-block turn, POST /api/cfo/chat) was removed
  // 2026-07-24 — it was defined here but never actually invoked anywhere
  // in the app, and the backend route it called is now deleted too
  // (see root CLAUDE.md "Backend cleanup"). Ask CFO AI uses `chatLlm` below.

  /** Conversational chat backed by Claude Opus 4.7. Multi-turn — pass the
   *  full message history each call. Returns plain markdown text.
   *
   *  `mode` selects the system-prompt persona on the backend:
   *    · undefined / "inventory"  — SKU/inventory-CFO drawer persona
   *    · "workspace"              — universal Ask-CFO-AI tab persona
   *      (open-domain, grounded in workspace snapshot, never fabricates
   *      the user's own figures). */
  /** CUR-FIX — `display_currency` + `fx_context` lets the backend system
   *  prompt instruct the model to cite figures in the user's chosen
   *  currency. Without these, the model defaults to the source currency
   *  it sees in `dataset_summary`, which is wrong any time display ≠ RON.
   *  Backend signature accepts these as optional so older clients still
   *  work; backend uses them to inject:
   *    "User is viewing data in {display}. Source data is in {source}.
   *     Rate: 1 {source} = N {display} (BNR, YYYY-MM-DD).
   *     Cite money figures in {display}; for ratios/multiples/days use
   *     unchanged. Never invent rates." */
  chatLlm: (req: {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    dataset_summary?: string;
    page?: string;
    company_name?: string;
    mode?: "inventory" | "workspace";
    display_currency?: "RON" | "EUR" | "USD";
    fx_context?: {
      source_currency: "RON" | "EUR" | "USD";
      display_currency: "RON" | "EUR" | "USD";
      rate: number;
      rate_date: string | null;
      provider: string | null;
    };
    /** NASDAQ-13 — when the user is viewing a Nasdaq ticker on the
     *  /public-companies page, the FE bundles its currently-loaded
     *  snapshot and posts it as `public_company`. Backend turns it
     *  into a system-prompt block so Claude can cite live SF1 numbers
     *  (or FY2024-indicative demo numbers) without the user pasting
     *  them in. Omit when not relevant — workspace chat unchanged. */
    public_company?: {
      ticker: string;
      company_name?: string | null;
      sector?: string | null;
      industry?: string | null;
      exchange?: string | null;
      currency?: string | null;
      latest_period?: string | null;
      latest_period_end?: string | null;
      revenue?: number | null;
      ebitda?: number | null;
      net_income?: number | null;
      total_assets?: number | null;
      total_equity?: number | null;
      cash?: number | null;
      net_debt?: number | null;
      free_cash_flow?: number | null;
      market_cap?: number | null;
      enterprise_value?: number | null;
      pe_ratio?: number | null;
      ev_to_ebitda?: number | null;
      ebitda_margin?: number | null;
      net_margin?: number | null;
      roe?: number | null;
      net_debt_to_ebitda?: number | null;
      source?: "nasdaq" | "demo" | null;
    };
  }, signal?: AbortSignal) =>
    (() => {
      if (!SUPABASE_FUNCTIONS_URL) {
        return Promise.reject(
          new CfoApiError(
            "Chat isn't configured — VITE_SUPABASE_URL is missing.",
            0,
            null,
          ),
        );
      }
      return callUrl<{
        answer: string;
        model: string | null;
        usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null;
      }>(`${SUPABASE_FUNCTIONS_URL}/chat-llm`, {
        method: "POST",
        body: JSON.stringify(req),
        // Deleting the conversation mid-reply aborts the request (see
        // chatPendingStore.abortChatReply) so "thinking" stops instantly.
        signal,
      });
    })(),

  chatPrompts: () =>
    call<{ groups: Record<string, string[]> }>("/api/cfo/chat/prompts"),

  exportBoardSummary: (req: TodayRequest) =>
    call<{ markdown: string; format: string }>("/api/cfo/exports/board-summary", {
      method: "POST",
      body: JSON.stringify(req),
    }),

  exportActionList: (req: TodayRequest) =>
    call<{ csv: string; format: string; row_count: number }>(
      "/api/cfo/exports/action-list",
      {
        method: "POST",
        body: JSON.stringify(req),
      },
    ),

  /** Delete a month (period): hard-deletes the period + all derivatives and
   *  soft-deletes its attached documents (recoverable from "Recently deleted"
   *  for 30 days). Backend: DELETE /api/period/{id}. */
  deletePeriod: (periodId: string) =>
    call<{ ok: boolean; period_id: string; documents_soft_deleted: number }>(
      `/api/period/${encodeURIComponent(periodId)}`,
      { method: "DELETE" },
    ),
};

