// useActivePeriod — single source of truth for "which period is the user
// currently looking at" across every authenticated page.
//
// Reads `?period=<id>` from the URL (sync source) and resolves it to the
// loaded period's Statements + metrics + briefing + recommendations + alerts.
//
// Three resolvers chain:
//   1. SAMPLE_DATASETS — synthetic dev samples (only when VITE_ENABLE_SAMPLES=true)
//   2. API — when ?period=<uuid>, fetch /api/period/:id from the backend
//      (RLS-scoped). React Query caches this so the same period_id fetched
//      from Dashboard, Cash, Profit, Decisions, Alerts all share one
//      network round-trip. Navigation between pages reads from cache and
//      paints instantly; the bottleneck used to be every page mount kicking
//      off a fresh fetch via useEffect + raw fetch().
//
// Why URL-keyed: switching periods in one page propagates to every other
// page automatically because they all subscribe to the same query-param
// hook. No global event bus, no Zustand store, no React context required.

import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SAMPLE_DATASETS, type SampleEntry } from "@/data/sampleStatements";
import type { DocumentType } from "@/lib/financialStatementTabs";
import type { Statements } from "@/lib/financialReport";
import type { Invoice } from "@/lib/invoiceAnalytics";
import { getSupabase } from "@/lib/supabase";

export interface PeriodMetric {
  name: string;
  value: number | null;
  unit: string | null;
  direction: "higher" | "lower" | "neutral" | null;
}

export interface PeriodRecommendation {
  id: string;
  title: string;
  explanation: string | null;
  urgency: "low" | "medium" | "high" | "critical" | null;
  expected_cash_impact_kron: number | null;
  status: string | null;
}

export interface PeriodAlertItem {
  id: string;
  alert_key: string;
  rule_key?: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  title: string;
  body: string | null;
  /** Exact numbers from period_facts backing this alert. Rendered in
   *  the "Facts backing this alert" expander on the alert card. */
  facts_cited?: Record<string, number> | null;
  industry?: string | null;
}

export interface ValuationFootballRow {
  method: string;
  primary: boolean;
  low: number | null;
  mid: number | null;
  high: number | null;
  subtitle: string | null;
}

export interface PeriodValuation {
  primary_method: "ev_ebitda" | "asset_based" | string;
  primary_label?: string;
  primary_equity_value?: number | null;
  primary_equity_low?: number | null;
  primary_equity_high?: number | null;
  method_warnings?: string[];
  // FCF breakdown — Valuation tab tiles read from here verbatim. Real
  // CapEx (CIP additions), NOT D&A. Statutory net income (positive).
  fcf_breakdown?: {
    net_income: number;
    depreciation: number;
    net_wc_change: number;
    cash_from_operating: number;
    capex_real: number;
    free_cash_flow: number;
    is_development_phase: boolean;
    stabilized_fcf: number;
  } | null;
  // Three EBITDA views — so the user can audit which one EV/EBITDA used.
  ebitda_statutory?: number | null;
  ebitda_operational?: number | null;
  ebitda_operating_view?: number | null;
  confidence: "high" | "medium" | "low" | null;
  multiples_source: string | null;
  multiples_as_of_date: string | null;
  formula_text: string;
  inputs: {
    ebitda_used: number | null;
    revenue_used: number | null;
    total_debt_used: number | null;
    cash_used: number | null;
  };
  primary: {
    method: string;
    multiple_p25: number | null;
    multiple_p50: number | null;
    multiple_p75: number | null;
    ev_p25: number | null;
    ev_p50: number | null;
    ev_p75: number | null;
    equity_p25: number | null;
    equity_p50: number | null;
    equity_p75: number | null;
  };
  cross_checks: {
    revenue_multiple: {
      multiple_p25: number | null;
      multiple_p50: number | null;
      multiple_p75: number | null;
      equity_p25: number | null;
      equity_p50: number | null;
      equity_p75: number | null;
    };
    dcf: {
      wacc: number | null;
      terminal_growth: number | null;
      enterprise_value: number | null;
      equity_value: number | null;
      sensitivity_low: number | null;
      sensitivity_high: number | null;
    };
  };
  football_field: ValuationFootballRow[];
  user_assumptions: {
    ebitda_used: number | null;
    multiple_used: number | null;
    debt_used: number | null;
    cash_used: number | null;
  } | null;
}

export interface ActivePeriod {
  /** Period id from `?period=...` (sample id, uuid, or null). */
  id: string | null;
  /** Friendly label — drives the page header. */
  label: string | null;
  /** Industry string from the period metadata (drives industry-aware briefing). */
  industry: string | null;
  /** Statements payload (BS + P&L) — null when this period has no financials. */
  statements: Statements | null;
  /** Invoice register — null when this period has no invoice data. */
  invoices: Invoice[] | null;
  /** Server-computed headline metrics. Empty when sample-only or sample lacks them. */
  metrics: PeriodMetric[];
  /** Server-generated recommendations. Empty for samples. */
  recommendations: PeriodRecommendation[];
  /** Server-generated alerts. Empty for samples. */
  alerts: PeriodAlertItem[];
  /** Server-generated CFO briefing string. */
  briefing: string | null;
  /** Document types this period exposes — drives downstream tab visibility. */
  availableTypes: DocumentType[];
  /** True if a period is loaded. Pages use this as the empty-state flag. */
  isLoaded: boolean;
  /** True while the API fetch is in flight. */
  isLoading: boolean;
  /** Source kind — distinguishes a fictional sample from a real upload. */
  source: "sample" | "upload" | null;
  /** Valuation payload — EBITDA-multiple primary + DCF + EV/Revenue cross-checks. */
  valuation: PeriodValuation | null;
  /** Per-account line items from the assembled statements — drives the
   *  reference-format P&L renderer with account-code drill-down. Empty
   *  when this period is a sample or has no extracted accounts. */
  lineItems: PeriodLineItem[];
  /** Source-document type as detected at ingestion. `"statutory_f30_f10"`
   *  triggers the aggregate-only banner; `"trial_balance"` is the
   *  full-granularity path; null when unknown. */
  detectedType: string | null;
  /** Filename of the source document that produced this period (e.g.
   *  "Carniprod Trial Balance 2025.xlsx"). Surfaced for the dashboard's
   *  "Extracted from" banner so it shows the actual uploaded file, not
   *  the workspace or org label. Null for sample periods or when the
   *  backend payload omits source_document. */
  sourceDocumentFilename: string | null;
  /** True when the URL referenced a period id (UUID) that the backend
   *  could not resolve (HTTP 404). The most common cause is a stale URL
   *  whose underlying period row was hard-deleted by
   *  `_maybe_drop_empty_period` after every linked document was
   *  permanent-deleted. Callers should distinguish this from
   *  "no period selected" — the former needs a redirect or banner,
   *  the latter is just the empty state. */
  notFound: boolean;
  /** F1.i envelope — canonical metrics bundle (PL/BS/CF/ratios/credit/
   *  piotroski/bands). F2.4 reads .credit + .piotroski for the Risks
   *  panel; F2.6 will read .valuation. */
  assembled_metrics: Record<string, unknown> | null;
}

export interface PeriodLineItem {
  statement: "BS" | "PL" | "IGNORED";
  bucket: string;
  ro_account_code: string;
  ro_account_name?: string;
  amount: number;
  is_derived?: boolean;
}

const EMPTY: ActivePeriod = {
  id: null,
  label: null,
  industry: null,
  statements: null,
  invoices: null,
  metrics: [],
  recommendations: [],
  alerts: [],
  briefing: null,
  availableTypes: [],
  isLoaded: false,
  isLoading: false,
  source: null,
  valuation: null,
  lineItems: [],
  detectedType: null,
  sourceDocumentFilename: null,
  notFound: false,
  assembled_metrics: null,
};

// ─── Resolvers ──────────────────────────────────────────────────────────────

function resolveSample(id: string | null): SampleEntry | null {
  if (!id) return null;
  return SAMPLE_DATASETS.find((s) => s.id === id) ?? null;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

interface PeriodApiResponse {
  period: {
    id: string;
    period_end: string;
    currency: string;
    /** Source document metadata — carries the detected document type
     *  so the FE can render limitation banners for aggregate-only
     *  inputs (statutory F30+F10) vs the full trial-balance path. */
    source_document?: {
      id: string;
      filename: string;
      status: string;
      detected_type: string | null;
    } | null;
  };
  organization: { id: string; name: string; industry_display_name: string | null } | null;
  statements: Statements;
  metrics: PeriodMetric[];
  briefing: { body: string; language: string; model: string | null } | null;
  recommendations: PeriodRecommendation[];
  alerts: PeriodAlertItem[];
  valuation: PeriodValuation | null;
  /** Per-account line items — drives the reference-format P&L drill-down. */
  line_items?: PeriodLineItem[];
  /** F1.i envelope — canonical metrics bundle. F2.4 consumes
   *  assembled_metrics.credit + .piotroski for the Risks panel. */
  assembled_metrics?: Record<string, unknown>;
  /** F1.k — canonical version stamp ("v2.0", "v2.1", ...). */
  canonical_version?: string;
}

/**
 * Result of a period fetch. The previous shape collapsed "404" and
 * "network error" into a single `null` return, which made the
 * stale-URL case look identical to "backend down". The discriminated
 * variants below let `useActivePeriod` surface a `notFound` flag so
 * the UI can render a stale-URL banner instead of a perpetual loading
 * spinner. See diagnostics/SET_INDUSTRY_PERIOD_NOT_FOUND_2026-05-18.md
 * for the root cause this fixes.
 */
type PeriodFetchResult =
  | { kind: "ok"; data: PeriodApiResponse }
  | { kind: "not_found" }
  | { kind: "error" };

async function fetchPeriodFromApi(periodId: string): Promise<PeriodFetchResult> {
  const supabase = getSupabase();
  if (!supabase) return { kind: "error" };
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { kind: "error" };
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  try {
    const res = await fetch(`${apiUrl}/api/period/${periodId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      // The period referenced in the URL doesn't exist (anymore). The
      // most common cause is `_maybe_drop_empty_period` cascading after
      // a permanent-delete. Surface this distinctly so the picker can
      // render a redirect-to-dashboard banner instead of an empty
      // detection card.
      return { kind: "not_found" };
    }
    if (!res.ok) {
      console.warn("[activePeriod] /api/period failed:", res.status);
      return { kind: "error" };
    }
    return { kind: "ok", data: (await res.json()) as PeriodApiResponse };
  } catch (err) {
    console.warn("[activePeriod] /api/period error:", err);
    return { kind: "error" };
  }
}

/** React Query key — shared across every page so they all hit one cache entry. */
export const periodQueryKey = (periodId: string) => ["period", periodId] as const;

/**
 * Read the active period from the URL. Returns a stable, memoized object
 * so callers can safely include it in dependency arrays. Backed by React
 * Query — Dashboard, Cash, Profit, Decisions, Alerts all share one cached
 * fetch per period_id, and navigation between them paints from cache.
 */
export function useActivePeriod(): ActivePeriod {
  const [params] = useSearchParams();
  const periodId = params.get("period");

  const { data: remote, isLoading: loading } = useQuery({
    queryKey: periodId ? periodQueryKey(periodId) : ["period", "__noop__"],
    queryFn: () => fetchPeriodFromApi(periodId!),
    enabled: !!periodId && isUuid(periodId),
    // staleTime tuned in the App.tsx QueryClient defaults (5 min); a re-run
    // pipeline produces a brand-new period_id (new UUID), so we don't need
    // aggressive invalidation here — the URL key changes for new data.
  });

  return useMemo(() => {
    if (!periodId) return EMPTY;

    // Server-side period (uuid + API response)
    if (isUuid(periodId)) {
      // The query is still in flight — keep the existing
      // "isLoading + id known" payload so the page can render its
      // skeleton.
      if (!remote) return { ...EMPTY, id: periodId, isLoading: loading };

      // Stale URL — the backend returned 404 for this period id.
      // Surface `notFound: true` so route guards / pickers can render
      // a "this analysis no longer exists" banner instead of treating
      // it as an empty state. See diagnostics/
      // SET_INDUSTRY_PERIOD_NOT_FOUND_2026-05-18.md (defect D1).
      if (remote.kind === "not_found") {
        return { ...EMPTY, id: periodId, notFound: true, isLoading: false };
      }
      // Transport error (network, auth) — leave EMPTY so the UI doesn't
      // commit to the wrong story. `isLoading` stays false; a soft retry
      // is the caller's job.
      if (remote.kind === "error") {
        return { ...EMPTY, id: periodId, isLoading: false };
      }
      const payload = remote.data;
      return {
        id: payload.period.id,
        label: payload.statements.companyName ?? payload.organization?.name ?? null,
        industry: payload.organization?.industry_display_name ?? null,
        statements: payload.statements,
        invoices: null,
        metrics: payload.metrics,
        recommendations: payload.recommendations,
        alerts: payload.alerts,
        briefing: payload.briefing?.body ?? null,
        availableTypes: ["bilant", "pl"] as DocumentType[],
        isLoaded: true,
        isLoading: false,
        source: "upload",
        valuation: payload.valuation ?? null,
        lineItems: payload.line_items ?? [],
        detectedType: payload.period.source_document?.detected_type ?? null,
        sourceDocumentFilename: payload.period.source_document?.filename ?? null,
        notFound: false,
        // F2.4 — Surface the F1.i canonical envelope. RisksPanel reads
        // .credit + .piotroski for engine-canonical credit scoring;
        // F2.6 will read .valuation.
        assembled_metrics: payload.assembled_metrics ?? null,
      };
    }

    // Fictional sample dataset (dev only)
    const sample = resolveSample(periodId);
    if (!sample) return EMPTY;
    return {
      id: sample.id,
      label: sample.statements?.companyName ?? sample.label,
      industry: sample.statements?.industry ?? null,
      statements: sample.statements ?? null,
      invoices: sample.invoicesGetter ? sample.invoicesGetter() : null,
      metrics: [],
      recommendations: [],
      alerts: [],
      briefing: null,
      availableTypes: sample.availableTypes,
      isLoaded: true,
      isLoading: false,
      source: "sample",
      valuation: null,
      lineItems: [],
      detectedType: null,
  sourceDocumentFilename: null,
      notFound: false,
      assembled_metrics: null,
    };
  }, [periodId, remote, loading]);
}

/**
 * Prefetch a period into the React Query cache so a subsequent navigation
 * paints instantly. Wire from sidebar link onMouseEnter so by the time the
 * user clicks the page already has its data.
 */
export function usePrefetchPeriod() {
  const qc = useQueryClient();
  return (periodId: string) => {
    if (!periodId || !isUuid(periodId)) return;
    void qc.prefetchQuery({
      queryKey: periodQueryKey(periodId),
      queryFn: () => fetchPeriodFromApi(periodId),
    });
  };
}
