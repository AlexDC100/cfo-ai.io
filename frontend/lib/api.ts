// HTTP client for the Python engine backend.
// Base URL is configured via VITE_API_URL (defaults to http://127.0.0.1:8000).

import type { DailyRun } from "@/data/dailyRun";
import type { Analysis } from "@/lib/runStore";
import type { RawSkuRow } from "@/lib/engine";
import type { BackendOverrides } from "@/lib/thresholds";
import type { Alert, AlertSummary } from "@/lib/alerts";
import type { ExtractedAccount } from "@/lib/trialBalanceParser";

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// ─── Financial Statement Intelligence — document parse ───────────────────

export interface ParseDocumentResponse {
  company_name: string | null;
  period_label: string;
  period_end: string | null;
  currency: string;
  confidence: number;
  detected_type: string;
  accounts: ExtractedAccount[];
  warnings: string[];
  model?: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

/** The most specific error message a failed response carries.
 *
 *  FastAPI puts it in `detail`. The SurfaceWallMiddleware in
 *  src/engine/api/server.py answers a walled surface with
 *  `{error: {code, message, details}}` and NO `detail` — so reading only
 *  `detail` collapsed "The legacy SKU analysis surface is not enabled on this
 *  deployment" into a bare "404", indistinguishable from a missing route.
 *  That is precisely how the workspace-onboarding dead end stayed invisible:
 *  the operator saw a status code where the server had sent a reason.
 *
 *  Falls back to "<status> <statusText>" when the body carries neither. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body?.detail) {
      return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    }
    if (typeof body?.error?.message === "string") return body.error.message;
  } catch {
    /* non-JSON body — fall through to the status line */
  }
  return `${res.status} ${res.statusText}`;
}

/**
 * Send a PDF to the backend extraction service. The backend calls Claude
 * Opus 4.7 with the PDF as a document content block and returns structured
 * trial-balance accounts (codes + amounts). The frontend's
 * `buildStatementsFromAccounts()` then maps to standardized buckets.
 *
 * Pass either pdf_url (preferred — backend fetches it; e.g. a Supabase
 * Storage signed URL) or pdf_b64 (when the file isn't in Storage yet).
 */
export async function parseFinancialDocument(input: {
  pdf_url?: string;
  pdf_b64?: string;
  original_filename?: string;
}): Promise<ParseDocumentResponse> {
  return await call<ParseDocumentResponse>("/api/dashboard/parse", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  return (await res.json()) as T;
}

// ─────────── Canonical category lookup ───────────

export interface CanonicalCategory {
  name: string;
  dio_days: number;
  ccc_days: number | null;
  dso_days: number | null;
  dpo_days: number | null;
  real_margin_pct_stored: number | null;
}

export async function fetchCanonicalCategories(): Promise<CanonicalCategory[]> {
  const data = await call<{ count: number; categories: CanonicalCategory[] }>(
    "/api/canonical-categories"
  );
  return data.categories;
}

// ─────────── Server-side classification ───────────

export interface ClassifyRowsBody {
  rows: Array<{
    category: string;
    sku?: string;
    volume_tons: number;
    revenue_kron: number;       // NIV in kRON
    gross_margin_pct: number;
    dio_days?: number;          // Optional — backend inherits from canonical
    strategic_flag?: boolean;
  }>;
  period_months?: number;
  data_period?: string;
  run_date?: string;            // YYYY-MM-DD
  overrides?: BackendOverrides;
}

/** Run the engine on the server (uses canonical DIO/CCC if rows omit them). */
export async function classifyRows(body: ClassifyRowsBody): Promise<DailyRun> {
  return call<DailyRun>("/api/classify-rows", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Adapter: convert in-browser RawSkuRow shape → backend's expected shape.
export function rawRowsToBackend(rows: RawSkuRow[]): ClassifyRowsBody["rows"] {
  return rows.map((r) => ({
    category: r.category,
    sku: r.sku,
    volume_tons: r.volumeT,
    // Frontend uses RON, backend uses kRON — convert if values look RON-scale.
    // Heuristic: if revenue > 100_000 assume it's RON (single SKU rarely sells > 100k kRON YTD).
    revenue_kron: r.revenue >= 100_000 ? r.revenue / 1000 : r.revenue,
    gross_margin_pct: r.grossMarginPct,
    dio_days: Number.isFinite(r.dioDays) && r.dioDays > 0 ? r.dioDays : undefined,
    strategic_flag: r.strategicFlag ?? false,
  }));
}

// ─────────── Flat SKU list (all categories) ───────────

export interface SkuRecord {
  id: string;
  sku_name: string;
  brand: string | null;
  category: string;
  category_dio_days: number;
  category_ccc_days: number | null;
  volume_tons: number;
  revenue_kron: number;
  gross_margin_pct: number;
  real_margin_pct: number;
  abs_profit_kron: number;
  flag: string;
  reason: string | null;
  recommendation: string | null;
  is_anchor: boolean;
  category_flag: string;
  category_real_margin_pct: number;
  share_of_category_profit_pct: number;
}

export interface SkusResponse {
  sku_count: number;
  category_count: number;
  totals: {
    volume_tons: number;
    revenue_kron: number;
    abs_profit_kron: number;
    loss_makers_kron: number;
  };
  flag_counts: Record<string, number>;
  skus: SkuRecord[];
}

export async function fetchAllSkus(
  rows: ClassifyRowsBody["rows"],
  periodMonths = 10,
  overrides?: BackendOverrides,
): Promise<SkusResponse> {
  return call<SkusResponse>("/api/skus", {
    method: "POST",
    body: JSON.stringify({ rows, period_months: periodMonths, overrides }),
  });
}

// ─────────── Drill ───────────

export interface SkuDecision {
  id: string;
  flag: string;
  reason: string | null;
  recommendation: string | null;
  real_margin_pct: number;
  volume_tons: number;
  abs_profit_kron: number;
  dio_days: number;
  do_not_eliminate: boolean;
  alert_reason: string | null;
  gross_margin_pct: number | null;
}

export interface DrillResult {
  category: string;
  sku_count: number;
  decisions: SkuDecision[];
}

export async function drillCategory(
  category: string,
  rows: ClassifyRowsBody["rows"],
  periodMonths = 10,
  overrides?: BackendOverrides,
): Promise<DrillResult> {
  return call<DrillResult>("/api/drill", {
    method: "POST",
    body: JSON.stringify({ category, rows, period_months: periodMonths, overrides }),
  });
}

// ─────────── Analyze / server-side upload — REMOVED 2026-09-09 ───────────
//
// `analyzeRunOnBackend` (POST /api/analyze) and `uploadExcelToBackend`
// (POST /api/upload-excel) lived here with zero call sites. Both endpoints are
// walled behind LEGACY_SKU_AI_ENABLED in src/engine/api/server.py — an
// anonymous POST to either reached an Anthropic completion with no bearer and
// no rate limit — so in production they answer a JSON 404 and nothing else.
//
// They are deleted rather than deprecated because an uncalled wrapper around a
// walled endpoint is exactly how the onboarding dead end happened: the dialog
// that called this was dead too, right up until the workspace wizard mounted
// it. Product uploads go through uploadDocument({scope:"sku"}) (Products.tsx)
// and financial documents through uploadDocument({scope:"financial"})
// (FinancialStatements.tsx, Workspace.tsx). frontend/lib/__tests__/
// noWalledEndpointCallers.test.ts keeps this true.

// ─────────── Health ───────────

export async function checkHealth(): Promise<{ status: string; version: string }> {
  return call<{ status: string; version: string }>("/health");
}

// ─────────── Config ───────────

export interface EngineConfigResponse {
  cost_of_capital_pct: number;
  anchor: {
    top_pct_by_absolute_profit: number;
    min_revenue_share_pct: number;
    volume_threshold_tons_default: number;
    floor_real_margin_pct: number;
    high_volume_anchor_floor_pct: number;
  };
  eliminate: {
    micro_volume_tons: number;
    micro_profit_kron: number;
    dio_capital_trap: number;
    capital_trap_real_margin: number;
    zero_sales_window_days: number;
    ccc_category_red_days: number;
  };
  warning: {
    thin_real_margin_max_pct: number;
    long_dio_days: number;
    trend_lookback_months: number;
  };
  scale: {
    high_margin_min_pct: number;
    high_margin_min_volume: number;
    volume_play_min_pct: number;
    volume_play_min_volume: number;
    gmroii_min_pct: number;
    high_volume_dio_max: number;
  };
}

export async function fetchEngineConfig(): Promise<EngineConfigResponse> {
  return call<EngineConfigResponse>("/api/config");
}
