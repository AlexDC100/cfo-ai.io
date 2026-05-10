// CFO AI backend client. Wraps the /api/cfo/* router exposed by the engine.
//
// All endpoints take the same TodayRequest body (company + skus + categories +
// period). Responses are typed; the Today page is the canonical source of
// truth for the executive_summary block, and the others are scoped to their
// section's data.

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

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

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) {
        detail =
          typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      }
    } catch {
      /* leave default */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
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

  chat: (req: ChatTurnRequest) =>
    call<ChatTurnResponse>("/api/cfo/chat", {
      method: "POST",
      body: JSON.stringify(req),
    }),

  /** Conversational chat backed by Claude Opus 4.7. Multi-turn — pass the
   *  full message history each call. Returns plain markdown text. */
  chatLlm: (req: {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    dataset_summary?: string;
    page?: string;
    company_name?: string;
  }) =>
    call<{
      answer: string;
      model: string | null;
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null;
    }>("/api/cfo/chat/llm", {
      method: "POST",
      body: JSON.stringify(req),
    }),

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
};

// ── Chat types ──────────────────────────────────────────────────────────

export interface ChatTurnRequest extends TodayRequest {
  question: string;
  page?: string;
}

export interface ChatStat {
  label: string;
  value: string;
}

export interface ChatBlockResponse {
  text?: string;
  stats?: ChatStat[];
  list?: string[];
}

export interface ChatTurnResponse {
  answer: { blocks: ChatBlockResponse[] };
  context: { page: string; company: string; summary: ExecutiveSummary };
}
