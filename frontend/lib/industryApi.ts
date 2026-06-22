// industryApi.ts — typed client for the Phase B + C industry-intelligence
// endpoints exposed by the FastAPI backend (src/engine/api/_industry_intelligence.py).
//
// SURFACE (10 routes)
//   GET  /api/industry/profiles                            → listProfiles
//   GET  /api/industry/profiles/{key}                      → getProfile
//   GET  /api/industry/caen/{caen_code}                    → resolveCaen
//   GET  /api/industry/search?q=…                          → searchIndustries
//   GET  /api/industry/detect/{period_id}                  → detectIndustry
//   GET  /api/industry/assignment/{period_id}              → getAssignment
//   GET  /api/industry/audit-log/{period_id}               → getAuditLog
//   POST /api/industry/assignment/{period_id}              → upsertAssignment
//   POST /api/industry/assignment/{period_id}/lock         → toggleAssignmentLock
//   POST /api/industry/assignment/{period_id}/recalc       → recalcAssignment
//
// AUTH
//   Every call attaches the Supabase JWT as `Authorization: Bearer …`.
//   Routes that read tenant tables (assignment, audit log, detect) rely on
//   that JWT for RLS scoping. Catalog reads (profiles, caen, search) only
//   need a valid session — RLS allows any authenticated SELECT.
//
// ERROR SHAPE
//   Helpers throw `IndustryApiError` with `status` + parsed `detail` so
//   callers can branch on 404 (no assignment yet), 409 (locked), 422
//   (bad industry_key), and the rest.

import { getSupabase } from "@/lib/supabase";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// ─────────────────────────────────────────────────────────────────────
// Shared types — mirror Pydantic models in _industry_intelligence.py
// ─────────────────────────────────────────────────────────────────────

export interface IndustryProfileSummary {
  key: string;
  display_name: string;
  display_name_ro?: string | null;
  sector: string;
  parent_key?: string | null;
  benchmark_depth?: string | null;
  confidence_default?: number | null;
}

export interface CaenMappingRow {
  caen_code: string;
  caen_label_en: string;
  caen_label_ro?: string | null;
  industry_key: string;
  parent_industry_key?: string | null;
  match_quality: "exact" | "close" | "sector_fallback";
  confidence: number;
}

export interface PeerCandidateRow {
  id: string;
  company_name: string;
  country?: string | null;
  source?: string | null;
  is_internal_brand_default: boolean;
  has_uploaded_financials: boolean;
  notes?: string | null;
}

export interface BenchmarkSetRow {
  id: string;
  revision: number;
  effective_from?: string | null;
  effective_to?: string | null;
  source_label: string;
  source_year: number;
  confidence: string;
}

export interface IndustryProfileDetail extends IndustryProfileSummary {
  description?: string | null;
  caen_codes: string[];
  caen_mappings: CaenMappingRow[];
  peers: PeerCandidateRow[];
  latest_benchmark_set?: BenchmarkSetRow | null;
}

export type DetectionSource =
  | "user_override"
  | "auto_caen"
  | "auto_keyword"
  | "auto_account_structure"
  | "auto_activity_text"
  | "fallback";

export interface CandidateRow {
  industry_key: string;
  parent_industry_key?: string | null;
  display_name?: string | null;
  source: DetectionSource;
  confidence: number;
  match_quality?: "exact" | "close" | "sector_fallback" | null;
  rationale?: string;
}

export interface DetectResponse {
  period_id: string;
  primary: CandidateRow | null;
  candidates: CandidateRow[];
  inputs: Record<string, unknown>;
  locked: boolean;
}

export interface AssignmentRow {
  period_id: string;
  organization_id: string;
  company_name?: string | null;
  caen_code?: string | null;
  detected_industry_key?: string | null;
  selected_industry_key: string;
  source: DetectionSource;
  confidence: number;
  locked_by_user: boolean;
  updated_at?: string | null;
}

export interface AuditLogRow {
  id: string;
  period_id: string;
  organization_id: string;
  changed_at: string;
  changed_by?: string | null;
  prev_industry_key?: string | null;
  new_industry_key: string;
  prev_source?: string | null;
  new_source: string;
  reason?: string | null;
}

export interface AssignmentUpsertBody {
  selected_industry_key: string;
  source?: DetectionSource;
  confidence?: number;
  locked_by_user?: boolean;
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────

export class IndustryApiError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = "IndustryApiError";
    this.status = status;
    this.detail = detail;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Auth + fetch helpers
// ─────────────────────────────────────────────────────────────────────

async function authHeaders(): Promise<Record<string, string>> {
  const sb = getSupabase();
  if (!sb) {
    throw new IndustryApiError("Supabase not configured", 401, null);
  }
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new IndustryApiError("Not signed in", 401, null);
  }
  return { Authorization: `Bearer ${token}` };
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = await authHeaders();
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail: unknown = null;
    try {
      detail = await resp.json();
    } catch {
      detail = await resp.text();
    }
    throw new IndustryApiError(
      `Industry API ${method} ${path} failed (HTTP ${resp.status})`,
      resp.status,
      detail,
    );
  }
  // 204 / empty body — return null cast (callers know their endpoints).
  const text = await resp.text();
  return (text ? JSON.parse(text) : null) as T;
}

// ─────────────────────────────────────────────────────────────────────
// READ — catalog
// ─────────────────────────────────────────────────────────────────────

export async function listProfiles(opts?: {
  sector?: string;
  includeInactive?: boolean;
  /** When true, the backend returns only profiles whose caen_codes
   *  array overlaps with the seeded `industry_benchmarks` catalog.
   *  The picker uses this so users can't choose an industry that
   *  would render an empty "not calibrated" benchmark. */
  seededOnly?: boolean;
}): Promise<IndustryProfileSummary[]> {
  const qs = new URLSearchParams();
  if (opts?.sector) qs.set("sector", opts.sector);
  if (opts?.includeInactive) qs.set("include_inactive", "true");
  if (opts?.seededOnly) qs.set("seeded_only", "true");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<IndustryProfileSummary[]>("GET", `/api/industry/profiles${suffix}`);
}

export async function getProfile(key: string): Promise<IndustryProfileDetail> {
  return request<IndustryProfileDetail>("GET", `/api/industry/profiles/${encodeURIComponent(key)}`);
}

export async function resolveCaen(caen: string): Promise<CaenMappingRow> {
  return request<CaenMappingRow>("GET", `/api/industry/caen/${encodeURIComponent(caen)}`);
}

export async function searchIndustries(
  q: string,
  limit = 20,
  opts?: { seededOnly?: boolean },
): Promise<IndustryProfileSummary[]> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  if (opts?.seededOnly) qs.set("seeded_only", "true");
  return request<IndustryProfileSummary[]>(
    "GET",
    `/api/industry/search?${qs.toString()}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// READ — per period
// ─────────────────────────────────────────────────────────────────────

export async function detectIndustry(periodId: string): Promise<DetectResponse> {
  return request<DetectResponse>("GET", `/api/industry/detect/${encodeURIComponent(periodId)}`);
}

export async function getAssignment(periodId: string): Promise<AssignmentRow | null> {
  try {
    return await request<AssignmentRow>(
      "GET",
      `/api/industry/assignment/${encodeURIComponent(periodId)}`,
    );
  } catch (err) {
    // 404 = no assignment yet. Callers always pair this with detect(); a
    // missing row is a normal first-render state, not an error.
    if (err instanceof IndustryApiError && err.status === 404) return null;
    throw err;
  }
}

export async function getAuditLog(
  periodId: string,
  limit = 50,
): Promise<AuditLogRow[]> {
  const qs = new URLSearchParams({ limit: String(limit) });
  return request<AuditLogRow[]>(
    "GET",
    `/api/industry/audit-log/${encodeURIComponent(periodId)}?${qs.toString()}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────────────

export async function upsertAssignment(
  periodId: string,
  body: AssignmentUpsertBody,
): Promise<AssignmentRow> {
  return request<AssignmentRow>(
    "POST",
    `/api/industry/assignment/${encodeURIComponent(periodId)}`,
    body,
  );
}

export async function toggleAssignmentLock(
  periodId: string,
  locked: boolean,
  reason?: string,
): Promise<AssignmentRow> {
  return request<AssignmentRow>(
    "POST",
    `/api/industry/assignment/${encodeURIComponent(periodId)}/lock`,
    { locked, reason },
  );
}

export async function recalcAssignment(periodId: string): Promise<AssignmentRow> {
  return request<AssignmentRow>(
    "POST",
    `/api/industry/assignment/${encodeURIComponent(periodId)}/recalc`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// UI helper utilities — formatters reused across the 4 components
// ─────────────────────────────────────────────────────────────────────

/** Human-readable label for a DetectionSource value. */
export function sourceLabel(source: DetectionSource): string {
  switch (source) {
    case "user_override": return "Manual override";
    case "auto_caen": return "CAEN code";
    case "auto_keyword": return "Keyword match";
    case "auto_account_structure": return "Cost structure";
    case "auto_activity_text": return "Activity description";
    case "fallback": return "Fallback";
    default: return source;
  }
}

/** Tailwind color triple for visualizing source confidence. */
export function sourceTone(source: DetectionSource): {
  text: string;
  bg: string;
  border: string;
} {
  switch (source) {
    case "user_override":
      return { text: "text-blue-700", bg: "bg-blue-50", border: "border-blue-200" };
    case "auto_caen":
      return { text: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200" };
    case "auto_keyword":
    case "auto_activity_text":
      return { text: "text-violet-700", bg: "bg-violet-50", border: "border-violet-200" };
    case "auto_account_structure":
      return { text: "text-sky-700", bg: "bg-sky-50", border: "border-sky-200" };
    case "fallback":
    default:
      return { text: "text-amber-700", bg: "bg-amber-50", border: "border-amber-200" };
  }
}

/** Format a 0..1 confidence as `83%`. */
export function formatConfidence(c: number): string {
  if (!Number.isFinite(c)) return "—";
  return `${Math.round(c * 100)}%`;
}
