// CFO AI backend client. Wraps the /api/cfo/* router exposed by the engine.
//
// All endpoints take the same TodayRequest body (company + skus + categories +
// period). Responses are typed; the Today page is the canonical source of
// truth for the executive_summary block, and the others are scoped to their
// section's data.

import type { CanonicalBs } from "./financialReport";

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
  /** null when the run's ROIC was refused (DailyRun.roicPct null); readers
   *  state that rather than format a number. */
  roic_pct: number | null;
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
      //
      // 2026-08-02: resolve through currentOrgId() rather than the bare
      // localStorage cache. On a cold device the cache is empty, and
      // requests fired before org.ts finished resolving went out WITHOUT
      // the header — transiently scoping a multi-workspace user's first
      // calls to their oldest company. currentOrgId() reads the same cache
      // first (zero cost when warm) and otherwise resolves + remembers the
      // oldest LIVE membership, so every request carries a workspace.
      const uid = data.session?.user?.id;
      if (uid && !headers["X-Org-Id"]) {
        const { currentOrgId } = await import("@/lib/supabase");
        const orgId = await currentOrgId();
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

/** What the chat function answers on success. */
export interface ChatLlmResponse {
  answer: string;
  model: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null;
}

/** "ro" or "en" — the UI language, read where i18n keeps it: the
 *  <html lang> it syncs (i18n/LanguageSync), then the stored choice
 *  (i18n LANGUAGE_STORAGE_KEY). Deliberately not an import of the i18n
 *  instance: this module stays free of it. */
function uiLanguage(): "ro" | "en" {
  let raw = "";
  try {
    raw = (typeof document !== "undefined" && document.documentElement.lang) || "";
    if (!raw && typeof localStorage !== "undefined") raw = localStorage.getItem("cfo.userLanguage") ?? "";
  } catch {
    /* storage blocked — English */
  }
  return raw.toLowerCase().startsWith("ro") ? "ro" : "en";
}

/** Ask Supabase for a fresh session — once. True when one came back. Only
 *  when a session exists: a signed-out caller has nothing to refresh. */
async function refreshSessionOnce(): Promise<boolean> {
  try {
    const { getSupabase } = await import("@/lib/supabase");
    const sb = getSupabase();
    if (!sb) return false;
    const { data: current } = await sb.auth.getSession();
    if (!current.session) return false;
    const { data, error } = await sb.auth.refreshSession();
    return !error && Boolean(data.session?.access_token);
  } catch {
    return false;
  }
}

/** RECONCILIATION FLOW (docs/CANONICAL_BS_V2_CONTRACT.md §"RECONCILIATION
 *  FLOW") — response of POST /api/period/{id}/reconcile/undo (and the
 *  ops-only /reconcile). The engine serves the freshly rebuilt
 *  canonical_bs (either bare or wrapped under `canonical_bs`) — after an
 *  undo that is the honest raw state with the true source imbalance. */
export type ReconcileApiResponse = Partial<CanonicalBs> & { canonical_bs?: CanonicalBs };

/** Normalize a reconcile/undo response to its canonical_bs object.
 *  Returns null when the payload carries none (caller then falls back to
 *  a plain period refetch instead of trusting a partial shape). */
export function extractCanonicalBsFromReconcile(
  resp: ReconcileApiResponse | null | undefined,
): CanonicalBs | null {
  if (!resp || typeof resp !== "object") return null;
  if (resp.canonical_bs && resp.canonical_bs.schema === "bs_v2") return resp.canonical_bs;
  if (resp.schema === "bs_v2") return resp as CanonicalBs;
  return null;
}

/** THE FORECAST HORIZONS THE ENGINE OFFERS.
 *
 *  Mirrors `engine.api._forecast_routes.ALLOWED_HORIZONS`. The engine
 *  REFUSES anything else by name rather than clamping — silently serving
 *  three years to someone who asked for seven is the class of defect this
 *  repo keeps finding — so this list is the surface's half of that
 *  contract, not a convenience. */
export const FORECAST_HORIZONS = [3, 5] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];

/** The body of an EXPLICIT briefing regeneration (owner ruling 2026-10-02).
 *  `intent: "user"` is what makes the call a model call at all: the engine
 *  answers the bodiless shape older bundles auto-fired with the stored
 *  briefing and narrates nothing. Extra fields are refused (422). */
export interface RegenerateBriefingBody {
  intent: "user";
  /** The language to narrate in — the reader's UI language. */
  language?: string;
  /** The display currency to narrate in; only RON is persisted. */
  currency?: string;
}

/** POST /api/period/{id}/briefing/regenerate, as answered with a body. */
export interface RegenerateBriefingResponse {
  /** False when the narration failed: nothing was written, the meter was
   *  released, and `briefing` is the stored (kept) body or null. */
  ok: boolean;
  regenerated?: boolean;
  /** True when the new narration replaced the stored row (RON only). */
  persisted?: boolean;
  legacy?: boolean;
  /** A neutral code on failure (provider_error, no_api_key, …). */
  reason?: string | null;
  /** What the STORED briefing row holds when the call returns (owner ruling
   *  2026-10-03): true only when it carries the stale marker — never "a
   *  failure happened". A failed conversion marks nothing and answers
   *  false. Absent from an engine that predates the ruling. */
  stale?: boolean;
  briefing?: string | null;
  briefing_length?: number;
  language?: string;
  currency?: string;
}

/** The 429 the regenerate route refuses with when the caller's Ask CFO AI
 *  allowance is spent (`CfoApiError.detail`). The caller's own plan, in the
 *  caller's own response — never stored, never shown to anyone else. */
export interface BriefingRegenCapDetail {
  code: "briefing_regen_cap_reached";
  kind?: "daily_cap_reached" | "monthly_cap_reached" | string;
  plan_key?: string;
  daily_used?: number;
  daily_cap?: number;
  monthly_used?: number;
  monthly_cap?: number;
  upgrade_url?: string;
}

export const cfoApi = {
  /** The explicit, metered briefing regeneration. One Ask CFO AI message of
   *  the caller's allowance per call; never fired without a click
   *  (components/cfo/CFOBriefingCard). `orgId` is the PERIOD's company, sent
   *  as X-Org-Id — never the ambient workspace, which can be another company
   *  in a second tab. */
  regenerateBriefing: (
    periodId: string,
    body: RegenerateBriefingBody,
    orgId?: string | null,
  ) =>
    call<RegenerateBriefingResponse>(
      `/api/period/${encodeURIComponent(periodId)}/briefing/regenerate`,
      {
        method: "POST",
        body: JSON.stringify(body),
        ...(orgId ? { headers: { "X-Org-Id": orgId } } : {}),
      },
    ),
  /** One fp1 projection over one persisted period.
   *
   *  Returns the raw payload. It is NOT typed as anything the rest of this
   *  module returns, and that is deliberate: every figure inside is
   *  PROJECTED, and the only sanctioned way to read one is
   *  `readProjection()` in `lib/forecastFacts.ts`, whose opaque
   *  `ProjectedMinor` type makes `actual + projected` a compile error.
   *  Handing this back as a shaped object with plain `number` fields would
   *  undo that in one line. */
  /** The Radar payload for one period: ranked findings, the checks that
   *  did NOT fire, the cap decision and the materiality basis.
   *
   *  Returns the raw payload for the same reason `forecast` does — the
   *  shape is `buildFindingsReport`'s to parse (`lib/findings.ts`), and
   *  a second typed mirror here would be a second opinion about it.
   *
   *  404 when `ANOMALY_RADAR_ENABLED` is unset on the engine, which is
   *  its state today: the surface is absent rather than half-present. */
  radar: (periodId: string) =>
    call<unknown>(`/api/radar/${encodeURIComponent(periodId)}`),
  forecast: (periodId: string, horizon: ForecastHorizon) =>
    call<unknown>(
      `/api/forecast/${encodeURIComponent(periodId)}?horizon=${horizon}`,
    ),
  /** plan/2 B6: POST /api/forecast/{id}/recompute (plan_contract_v2 1.2, 2.1).
   *  The body is a PlanRequestBody: every decimal a STRING, unknown fields
   *  422. Returns the raw fp1.2 payload; `readProjection()` is its one
   *  reader. GET `forecast` above is exactly this with a bare horizon. */
  forecastRecompute: (
    periodId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) =>
    call<unknown>(`/api/forecast/${encodeURIComponent(periodId)}/recompute`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  /** POST /api/forecast/{id}/scenario (R6): a template the ENGINE compiles
   *  over this book (packs/scenarios/templates.yaml) plus the reader's lever
   *  overrides, projected through the same `project_levers` the forecast GET
   *  runs — `template: "base"` IS the forecast. Body: {template, horizon,
   *  overrides, want}; the page sends no shock and no number of its own.
   *  Returns the raw fp1.2 payload with its `scenario` block; read it through
   *  `readProjection()` only. */
  forecastScenario: (
    periodId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) =>
    call<unknown>(`/api/forecast/${encodeURIComponent(periodId)}/scenario`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  /** POST /api/forecast/{id}/cockpit — the Forecast cockpit (owner-approved
   *  spec 2026-09-21, `forecast_cockpit/1`). Body: {case_id, levers:
   *  {<lever id>: "<exact decimal>"}} — an engine case or "saved:<id>", and
   *  the sliders the reader moved; the page sends positions and no number of
   *  its own. The answer is the engine's cockpit: the four numbers (served
   *  formatted), the chart, the sentence, every lever with its basis, the
   *  cases, the bridge from base and the annual statements. Returns the raw
   *  payload: `readCockpit()` in lib/forecastCockpit.ts is its one reader. */
  forecastCockpit: (
    periodId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) =>
    call<unknown>(`/api/forecast/${encodeURIComponent(periodId)}/cockpit`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  /** POST /api/forecast/{id}/cockpit/export — the bank export's DATA for the
   *  same body: {document, cockpit, assumptions_page}. The page renders it in
   *  the CFO Report's print style (lib/forecastBankExport.ts) and posts the
   *  HTML to /api/report/pdf; no figure is computed outside the engine. */
  forecastCockpitExport: (periodId: string, body: Record<string, unknown>) =>
    call<unknown>(`/api/forecast/${encodeURIComponent(periodId)}/cockpit/export`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** GET /api/forecast/templates/scenarios: the templates this engine serves,
   *  each with its declared shocks and the display value to print (pack
   *  data; no figure of any book). */
  forecastScenarioTemplates: () =>
    call<unknown>("/api/forecast/templates/scenarios"),
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
      const send = () =>
        callUrl<ChatLlmResponse>(`${SUPABASE_FUNCTIONS_URL}/chat-llm`, {
          method: "POST",
          // `language`: the function words its refusals for a caller with no
          // words of its own in the request's language. The app renders its
          // own sentence from the refusal's CODE (lib/chatRefusal.ts); the
          // field is never part of the prompt.
          body: JSON.stringify({ ...req, language: uiLanguage() }),
          // Deleting the conversation mid-reply aborts the request (see
          // chatPendingStore.abortChatReply) so "thinking" stops instantly.
          signal,
        });
      // The function answers 401 when the bearer does not verify (it calls
      // no model and meters nothing for that request). A signed-in reader's
      // token can simply have expired: refresh the session ONCE and send the
      // request ONCE more. No loop — a second 401 is the answer, and the
      // chat renders "sign in again" from its code.
      return send().catch(async (err: unknown) => {
        if (!(err instanceof CfoApiError) || err.status !== 401) throw err;
        if (signal?.aborted) throw err;
        if (!(await refreshSessionOnce())) throw err;
        return send();
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

  // AUTO-RECONCILE (2026-08-19): reconciliation is a fully automatic
  // server-side stage — the UI never POSTs /reconcile anymore (the former
  // reconcilePeriod client was removed with the manual Reconcile button;
  // the route remains curl-able for ops). Only undo stays user-facing.

  /** Reverse an auto-applied reconciliation — removes the stored synthetic
   *  entry and serves the honest raw state (the true source imbalance).
   *  The server suppresses re-auto-reconcile for the same content_hash +
   *  versions after an explicit undo, so a refetch cannot silently
   *  re-apply it. Source cents were never touched, so undo is always
   *  exact. */
  undoReconcilePeriod: (periodId: string) =>
    call<ReconcileApiResponse>(
      `/api/period/${encodeURIComponent(periodId)}/reconcile/undo`,
      { method: "POST" },
    ),

  /** AI LANE (2026-08-19) — re-read the period's source document with the
   *  AI extraction lane under an explicitly chosen jurisdiction (country
   *  pack code: "RO" | "HU" | "INTL"). Called from the BS jurisdiction
   *  badge's override confirm ("Re-extraction re-reads the document with
   *  AI"). The engine replaces the period's canonical result; callers
   *  reset the period query afterwards. Response typed loosely — the
   *  engine side ships in parallel; the FE relies on nothing beyond
   *  success/failure plus an optional fresh canonical_bs. */
  reextractPeriod: (periodId: string, jurisdiction: string) =>
    call<ReconcileApiResponse & { ok?: boolean; period_id?: string }>(
      `/api/period/${encodeURIComponent(periodId)}/reextract`,
      { method: "POST", body: JSON.stringify({ jurisdiction }) },
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

