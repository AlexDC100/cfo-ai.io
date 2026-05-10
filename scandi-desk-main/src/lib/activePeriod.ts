// useActivePeriod — single source of truth for "which period is the user
// currently looking at" across every authenticated page.
//
// Reads `?period=<sample_id>` from the URL (sync source) and resolves it to
// the loaded sample's Statements + Invoices + metadata. When the underlying
// `/api/period/:id` read API ships (Phase G), swap the resolver below for a
// real network fetch — the hook surface stays identical so callers don't
// have to change.
//
// Why URL-keyed: switching periods in one page propagates to every other
// page automatically because they all subscribe to the same query-param
// hook. No global event bus, no Zustand store, no React context required.

import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { SAMPLE_DATASETS, type SampleEntry } from "@/data/sampleStatements";
import type { Statements } from "@/lib/financialReport";
import type { Invoice } from "@/lib/invoiceAnalytics";

export interface ActivePeriod {
  /** Sample id from `?period=...` (e.g. "eei", "fmcg") or null when nothing loaded. */
  id: string | null;
  /** Friendly label — drives the page header. */
  label: string | null;
  /** Industry string from the sample metadata (drives industry-aware briefing). */
  industry: string | null;
  /** Statements payload (BS + P&L) — null when this period has no financials. */
  statements: Statements | null;
  /** Invoice register — null when this period has no invoice data. */
  invoices: Invoice[] | null;
  /** True if a period is loaded. Pages use this as the empty-state flag. */
  isLoaded: boolean;
}

const EMPTY: ActivePeriod = {
  id: null,
  label: null,
  industry: null,
  statements: null,
  invoices: null,
  isLoaded: false,
};

function resolveSample(id: string | null): SampleEntry | null {
  if (!id) return null;
  return SAMPLE_DATASETS.find((s) => s.id === id) ?? null;
}

/**
 * Read the active period from the URL. Returns a stable, memoized object
 * so callers can safely include it in dependency arrays.
 */
export function useActivePeriod(): ActivePeriod {
  const [params] = useSearchParams();
  const periodId = params.get("period");

  return useMemo(() => {
    const sample = resolveSample(periodId);
    if (!sample) return EMPTY;
    return {
      id: sample.id,
      label: sample.statements?.companyName ?? sample.label,
      industry: sample.statements?.industry ?? null,
      statements: sample.statements ?? null,
      invoices: sample.invoicesGetter ? sample.invoicesGetter() : null,
      isLoaded: true,
    };
  }, [periodId]);
}
