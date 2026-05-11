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
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  title: string;
  body: string | null;
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
  period: { id: string; period_end: string; currency: string };
  organization: { id: string; name: string; industry_display_name: string | null } | null;
  statements: Statements;
  metrics: PeriodMetric[];
  briefing: { body: string; language: string; model: string | null } | null;
  recommendations: PeriodRecommendation[];
  alerts: PeriodAlertItem[];
}

async function fetchPeriodFromApi(periodId: string): Promise<PeriodApiResponse | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  try {
    const res = await fetch(`${apiUrl}/api/period/${periodId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn("[activePeriod] /api/period failed:", res.status);
      return null;
    }
    return (await res.json()) as PeriodApiResponse;
  } catch (err) {
    console.warn("[activePeriod] /api/period error:", err);
    return null;
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
      if (!remote) return { ...EMPTY, id: periodId, isLoading: loading };
      return {
        id: remote.period.id,
        label: remote.statements.companyName ?? remote.organization?.name ?? null,
        industry: remote.organization?.industry_display_name ?? null,
        statements: remote.statements,
        invoices: null,
        metrics: remote.metrics,
        recommendations: remote.recommendations,
        alerts: remote.alerts,
        briefing: remote.briefing?.body ?? null,
        availableTypes: ["bilant", "pl"] as DocumentType[],
        isLoaded: true,
        isLoading: false,
        source: "upload",
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
