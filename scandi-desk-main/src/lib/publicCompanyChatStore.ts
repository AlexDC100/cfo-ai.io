// publicCompanyChatStore.ts — NASDAQ-13 surface state.
//
// The /public-companies page selects a ticker (PublicCompanySnapshotPanel
// is mounted with `ticker={selectedTicker}`); the persistent CFOChat
// panel (mounted in AppShell) needs to know about it so every chat turn
// can ship the public-company snapshot to the backend.
//
// Rather than thread props through AppShell → CFOChatPanel → CFOChatShell
// — or hoist a Context one level above AppShell — we keep a tiny
// module-level singleton + `useSyncExternalStore` hook. The page sets it
// when a row is selected and clears it on unmount.
//
// Why useSyncExternalStore: React 18's idiom for external stores. It
// avoids the Zustand dep (not installed in this repo), avoids restructuring
// the Provider tree, and gives React tearing-free subscriptions out of
// the box — every consumer sees the same value on a given render.

import { useSyncExternalStore } from "react";

import type { PublicCompanyFinancialSnapshot } from "./publicCompanyUniverse";

/** The exact subset of fields the chat backend `LlmPublicCompanyContext`
 *  expects. Computed from a `PublicCompanyFinancialSnapshot` via
 *  `setFromSnapshot` below — keeps a single source of truth even if the
 *  snapshot shape grows new fields. */
export interface PublicCompanyChatContext {
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
}

// ── Module singleton ────────────────────────────────────────────────────

let currentContext: PublicCompanyChatContext | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PublicCompanyChatContext | null {
  return currentContext;
}

/** Subscribe in React land. Re-renders the consumer whenever any caller
 *  calls `setPublicCompanyChatContext` or `setPublicCompanyChatFromSnapshot`. */
export function usePublicCompanyChatContext(): PublicCompanyChatContext | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Convenience selector — exported for surfaces that only need the active
 *  ticker (no headline). Avoids re-rendering when other fields change. */
export function useActivePublicCompanyTicker(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => currentContext?.ticker ?? null,
    () => currentContext?.ticker ?? null,
  );
}

/** Set the active public-company chat context. Pass null to clear. */
export function setPublicCompanyChatContext(
  ctx: PublicCompanyChatContext | null,
): void {
  currentContext = ctx;
  emit();
}

/** Convenience: lift a universe snapshot row into the chat context shape. */
export function setPublicCompanyChatFromSnapshot(
  s: PublicCompanyFinancialSnapshot,
): void {
  setPublicCompanyChatContext({
    ticker: s.ticker,
    company_name: s.companyName ?? null,
    sector: s.sector ?? null,
    industry: s.industry ?? null,
    exchange: s.exchange ?? null,
    currency: s.currency ?? "USD",
    latest_period: s.latestPeriod ?? null,
    latest_period_end: s.latestPeriodEnd ?? null,
    revenue: s.revenue ?? null,
    ebitda: s.ebitda ?? null,
    net_income: s.netIncome ?? null,
    total_assets: null, // not exposed on the flat snapshot today
    total_equity: s.equity ?? null,
    cash: s.cash ?? null,
    net_debt: s.netDebt ?? null,
    free_cash_flow: s.freeCashFlow ?? null,
    market_cap: s.marketCap ?? null,
    enterprise_value: s.enterpriseValue ?? null,
    pe_ratio: s.peRatio ?? null,
    ev_to_ebitda: s.evToEbitda ?? null,
    ebitda_margin: s.ebitdaMargin ?? null,
    net_margin: s.netMargin ?? null,
    roe: s.roe ?? null,
    net_debt_to_ebitda: s.netDebtToEbitda ?? null,
    source: (s.source as "nasdaq" | "demo" | undefined) ?? null,
  });
}
