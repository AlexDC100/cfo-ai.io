// F5.0 Phase 1.5 — Reporting context provider.
//
// Exposes the active period's canonical metric snapshot to every
// LearnableNumber popover via `useReportingMetrics()`. Without this
// provider, computation() functions can still run — they receive an
// empty ReportingMetrics — and the popover formula gracefully shows the
// structural skeleton with "—" placeholders for missing child values.
//
// Mount this provider inside FinancialStatements / ComprehensiveReport
// after the active period loads, so popovers can render full recursion.
// The provider is intentionally lightweight: pass the parsed metric
// snapshot via the `metrics` prop, currency, locale, and trace data.
// No fetching here — read-only consumer of state owned elsewhere.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type {
  ReportingMetrics,
  AccountTrace,
} from "@/lib/learning/concepts/_schema";
import type { PeriodLineItem } from "@/lib/activePeriod";

interface ReportingContextValue {
  metrics: ReportingMetrics;
  currency: string;
  locale: "en" | "ro";
  /** LEARN-FIX-1 (2026-06-08) — Engine-emitted per-account amounts for
   *  the active period, keyed by ro_account_code with single resolved
   *  `amount`. Populated from `period.lineItems`. When present, the
   *  popover's source-account composition reads real RON figures
   *  instead of falling back to the 0-RON placeholder from
   *  `staticSourceAccounts()`. Optional so popovers outside a hydrated
   *  period (e.g. landing-page previews) still render structurally. */
  lineItems: PeriodLineItem[];
}

const ReportingContext = createContext<ReportingContextValue | null>(null);

interface Props {
  children: ReactNode;
  metrics?: ReportingMetrics;
  currency?: string;
  locale?: "en" | "ro";
  /** LEARN-FIX-1 — see ReportingContextValue.lineItems. */
  lineItems?: PeriodLineItem[];
}

export function ReportingContextProvider({
  children,
  metrics = {},
  currency = "RON",
  locale = "en",
  lineItems = [],
}: Props) {
  const value = useMemo<ReportingContextValue>(
    () => ({ metrics, currency, locale, lineItems }),
    [metrics, currency, locale, lineItems],
  );
  return (
    <ReportingContext.Provider value={value}>
      {children}
    </ReportingContext.Provider>
  );
}

export function useReportingMetrics(): ReportingContextValue {
  const ctx = useContext(ReportingContext);
  if (!ctx) {
    return { metrics: {}, currency: "RON", locale: "en", lineItems: [] };
  }
  return ctx;
}

export type { AccountTrace };
