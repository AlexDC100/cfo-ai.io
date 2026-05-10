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
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* leave default */ }
    throw new Error(detail);
  }
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

// ─────────── Analyze ───────────

export async function analyzeRunOnBackend(
  run: DailyRun,
  fileName?: string,
  rowCount?: number,
  language: "en" = "en",
  rows?: ClassifyRowsBody["rows"],
  overrides?: BackendOverrides,
): Promise<Analysis> {
  const data = await call<Omit<Analysis, "generatedAt">>("/api/analyze", {
    method: "POST",
    body: JSON.stringify({
      run,
      file_name: fileName,
      row_count: rowCount,
      language,
      rows,
      period_months: 10,
      overrides,
    }),
  });
  return { ...data, generatedAt: new Date().toISOString() };
}

// ─────────── Server-side upload ───────────

export interface UploadExcelResult {
  file_name: string;
  transaction_rows: number;
  run: DailyRun;
  skus: SkusResponse;
  raw_rows: Array<{
    category: string;
    sku: string;
    volume_tons: number;
    revenue_kron: number;
    gross_margin_pct: number;
  }>;
  analysis: Omit<Analysis, "generatedAt">;
  /** Server-derived alerts from the alert engine. May be empty. */
  alerts?: Alert[];
  alert_summary?: AlertSummary;
}

/** Send the Excel file straight to the backend. Pandas parses it; the API
 *  returns the full DailyRun + SKU list + AI analysis in one round-trip. */
export async function uploadExcelToBackend(
  file: File,
  periodMonths = 10,
  overrides?: BackendOverrides,
): Promise<UploadExcelResult> {
  const fd = new FormData();
  fd.append("file", file);
  const params = new URLSearchParams({ period_months: String(periodMonths) });
  if (overrides) params.set("overrides_json", JSON.stringify(overrides));
  const url = `${API_URL}/api/upload-excel?${params.toString()}`;
  const res = await fetch(url, { method: "POST", body: fd });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* leave default */ }
    throw new Error(detail);
  }
  return (await res.json()) as UploadExcelResult;
}

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
