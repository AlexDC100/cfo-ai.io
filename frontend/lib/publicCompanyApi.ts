// Public-company API client — wraps /api/public/*.
//
// Same env-var convention as the rest of the codebase: VITE_API_URL is the
// backend origin (empty string in prod since Caddy proxies same-origin).
//
// Every endpoint may return a §24-aligned error envelope shape:
//   {"error": {"code": "nasdaq_xxx", "message": "...", "details": {...}}}
// instead of the success shape. Callers should switch on `error.code` to
// pick the right empty-state component (NasdaqKeyMissing, NasdaqEntitlement,
// NasdaqNotFound, NasdaqRateLimited).

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

// ── Response types ─────────────────────────────────────────────────────

export type Dimension = "ARY" | "ARQ" | "ART" | "MRY" | "MRQ" | "MRT";

export interface PublicCompanyHit {
  ticker: string;
  name: string;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  country: string | null;
  currency: string;
  is_active: boolean;
}

export interface PublicCompanyTickerInfo {
  name: string;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  country: string | null;
  currency: string;
}

export interface PublicCompanyHealth {
  service: "public-company-pipeline";
  key_configured: boolean;
  key_tag: string;
  daily_budget_remaining: number;
}

/**
 * One period's assembled_canonical_v1 envelope. Same shape as private
 * periods carry — every existing renderer (PLStatementView, computeRatios,
 * NavCascade) consumes this without source-branching.
 */
export interface PublicCompanyPeriod {
  schema_version: string;
  normalizer_version: string;
  source: "nasdaq_sharadar_sf1";
  ticker: string;
  dimension: Dimension;
  fiscal_period_end: string; // ISO date
  currency: string;
  headline: {
    revenue: number | null;
    ebitda: number | null;
    ebit: number | null;
    net_income: number | null;
    total_assets: number | null;
    total_equity: number | null;
    total_debt: number | null;
    cash: number | null;
    operating_cash_flow: number | null;
    free_cash_flow: number | null;
  };
  leaves: Record<string, { magnitude: number; sign_meaning: string; source_field: string }>;
  aggregates: Record<string, { net: number; leaves: string[] }>;
  unmapped: Array<{ code: string; name: string; amount: number; reason: string }>;
  market_metrics: null | {
    as_of: string;
    market_cap: number | null;
    enterprise_value: number | null;
    ev_ebitda: number | null;
    // Emitted by `engine/public/normalizer.py` alongside ev_ebitda (both
    // read off `DailyMetrics`), but omitted here — so PublicCompanyDashboard
    // read them through a type error and the EV/EBIT and EV/Revenue tiles
    // were typed as though the data could not exist. It does.
    ev_ebit: number | null;
    ev_revenue: number | null;
    pe_ratio: number | null;
    pb_ratio: number | null;
    ps_ratio: number | null;
    dividend_yield: number | null;
    currency: string;
  };
  round_trip_check: { passed: boolean | null; max_deviation_pct?: number };
}

export interface PublicCompanyEnvelope {
  ticker: string;
  ticker_info: PublicCompanyTickerInfo;
  dimension: Dimension;
  periods: PublicCompanyPeriod[];
  subscription_required: boolean;
  synced_at: string;
}

export interface PublicCompanySyncStats {
  ticker: string;
  dimensions_synced: Dimension[];
  periods_per_dimension: Record<string, number>;
  periods_total: number;
  subscription_required: boolean;
  elapsed_ms: number;
}

export interface NasdaqErrorEnvelope {
  error: {
    code:
      | "nasdaq_error"
      | "nasdaq_key_missing"
      | "nasdaq_entitlement_missing"
      | "nasdaq_not_found"
      | "nasdaq_rate_limited"
      | "nasdaq_partial_data";
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ApiOk<T> = { ok: true; value: T };
export type ApiErr = { ok: false; error: NasdaqErrorEnvelope["error"] };
export type ApiResult<T> = ApiOk<T> | ApiErr;

/** Narrow an `ApiResult` to its failure member.
 *
 *  `if (r.ok) { … } else { r.error }` reads as correct and IS correct at
 *  runtime, but does not typecheck in this project: with `strict: false`
 *  (so `strictNullChecks: false`) TypeScript declines to subtract the
 *  `ok: true` member from a boolean-discriminated union in the else-branch.
 *  Verified directly — the identical snippet compiles clean under
 *  `--strict true` and reports TS2339 under `--strict false`, so this is a
 *  compiler-mode artefact, not a defect in the call sites.
 *
 *  A user-defined type predicate narrows under BOTH modes and compiles to a
 *  plain `!r.ok`, so it costs nothing and does not suppress anything: an
 *  actually-wrong access still fails to typecheck. Preferred over widening
 *  the union or casting at each call site. */
export function isApiError<T>(r: ApiResult<T>): r is ApiErr {
  return !r.ok;
}

// ── Helpers ────────────────────────────────────────────────────────────

async function _fetchJson<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API_URL}${path}`, init);
    const body = await res.json();
    if (!res.ok || body?.error) {
      const err = body?.error ?? {
        code: "nasdaq_error" as const,
        message: `HTTP ${res.status}`,
        details: { status: res.status },
      };
      return { ok: false, error: err };
    }
    return { ok: true, value: body as T };
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "nasdaq_error",
        message: e instanceof Error ? e.message : "Network error",
        details: {},
      },
    };
  }
}

// ── Endpoints ──────────────────────────────────────────────────────────

export async function getPublicCompanyHealth(): Promise<ApiResult<PublicCompanyHealth>> {
  return _fetchJson<PublicCompanyHealth>("/api/public/health");
}

export async function searchPublicCompanies(
  query: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<ApiResult<{ query: string; count: number; results: PublicCompanyHit[] }>> {
  const params = new URLSearchParams({ q: query });
  if (opts.limit) params.set("limit", String(opts.limit));
  return _fetchJson(`/api/public/search?${params}`, { signal: opts.signal });
}

export async function getPublicCompany(
  ticker: string,
  opts: { dimension?: Dimension; limit?: number; signal?: AbortSignal } = {},
): Promise<ApiResult<PublicCompanyEnvelope>> {
  const params = new URLSearchParams({
    dimension: opts.dimension ?? "ARY",
  });
  if (opts.limit) params.set("limit", String(opts.limit));
  return _fetchJson<PublicCompanyEnvelope>(
    `/api/public/companies/${encodeURIComponent(ticker)}?${params}`,
    { signal: opts.signal },
  );
}

export async function syncPublicCompany(
  ticker: string,
  opts: { dimensions?: Dimension[]; signal?: AbortSignal } = {},
): Promise<ApiResult<PublicCompanySyncStats>> {
  const params = new URLSearchParams();
  if (opts.dimensions?.length) params.set("dimensions", opts.dimensions.join(","));
  const qs = params.toString();
  return _fetchJson<PublicCompanySyncStats>(
    `/api/public/companies/${encodeURIComponent(ticker)}/sync${qs ? `?${qs}` : ""}`,
    { method: "POST", signal: opts.signal },
  );
}
