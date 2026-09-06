// publicCompanyUniverse.ts — types + client for the /api/public/universe endpoint.
//
// PUB-UPG (Public Companies massive upgrade) — the table on the
// /public-companies page now renders 50+ tickers hydrated from this
// endpoint. The shape matches the Python `PublicCompanyFinancialSnapshot`
// in src/engine/public/normalizer.py + demo_universe.py 1:1 — when you
// add a field on one side, mirror it on the other.

import type { Currency } from "@/lib/rates";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://127.0.0.1:8000";

export type UniverseSource = "demo" | "nasdaq" | "seed_bvb";
export type UniverseMode = "demo" | "live" | "seed";

/** Exchange code as it appears in the snapshot. The BVB workstream
 *  expands the universe beyond US tickers — surfacing the exchange
 *  explicitly lets the FE pick the right badge + currency formatting
 *  without relying on the ticker string itself. */
export type Exchange = "NASDAQ" | "NYSE" | "BVB" | string;

export interface PublicCompanyFinancialSnapshot {
  ticker: string;
  companyName: string;
  exchange?: string | null;
  sector?: string | null;
  industry?: string | null;
  country?: string | null;
  currency: string;
  mode: UniverseMode;

  // Market
  price?: number | null;
  /** Day-over-day price change as a percentage point (+1.24 = +1.24%).
   *  PUB-200 — populated in live mode from SEP; null for demo rows. */
  priceChangePct?: number | null;
  marketCap?: number | null;
  enterpriseValue?: number | null;

  // P&L
  revenue?: number | null;
  revenueGrowth?: number | null;       // % points
  grossProfit?: number | null;
  grossMargin?: number | null;         // % points
  ebitda?: number | null;
  ebitdaMargin?: number | null;        // % points
  operatingIncome?: number | null;
  netIncome?: number | null;
  netMargin?: number | null;           // % points

  // Balance sheet
  cash?: number | null;
  grossDebt?: number | null;
  netDebt?: number | null;
  equity?: number | null;

  // Cash flow
  operatingCashFlow?: number | null;
  capex?: number | null;
  freeCashFlow?: number | null;

  // Ratios / multiples (dimensionless or % points)
  peRatio?: number | null;
  evToEbitda?: number | null;
  evToSales?: number | null;
  fcfYield?: number | null;             // % points
  dividendYield?: number | null;        // % points
  roe?: number | null;                  // % points
  roa?: number | null;                  // % points
  roic?: number | null;                 // % points
  netDebtToEbitda?: number | null;
  debtToEquity?: number | null;
  currentRatio?: number | null;

  // Provenance
  latestPeriod?: string | null;         // "FY2024" / "Q4 2024"
  latestPeriodEnd?: string | null;      // YYYY-MM-DD
  /** When the row's seeded / market figures were OBSERVED: the seed's
   *  own retrieval date, the demo table's declared as-of, or the DAILY
   *  metrics' trading day. Null when the engine holds no data timestamp
   *  — it never stamps the process clock here (it did, until
   *  2026-09-04, and every card read "computed <engine boot>"). */
  lastUpdated: string | null;
  /** When the PRICE (and day change) was quoted — the Yahoo sweep for a
   *  BVB row, the DAILY trading day for a live row. Absent when the row
   *  carries no quote. A seeded market cap is NOT as of this. */
  quoteAsOf?: string | null;
  source: UniverseSource;
  confidence: number;                   // 0..1
  missingFields: string[];
}

export interface UniverseResponse {
  mode: UniverseMode;
  source: UniverseSource;
  count: number;
  /** The newest row data timestamp in the payload; null when no row
   *  carries one. Not a build time. */
  lastUpdated: string | null;
  message: string | null;
  companies: PublicCompanyFinancialSnapshot[];
}

// ── Fetch ───────────────────────────────────────────────────────────────

/** Fetch the universe. Backend handles live-vs-demo fallback per-ticker.
 *  Throws on transport error so React Query can surface it.
 *
 *  Romania-only coverage (2026-07-23, operator directive): the product
 *  surface shows BVB-listed companies ONLY. The backend still merges the
 *  NASDAQ universe into the response (other consumers may need it), so the
 *  restriction is applied here at the single fetch chokepoint — every
 *  downstream consumer (universe table, MarketsOverview themes/sectors/
 *  movers, search-within-universe) inherits it. */
export async function fetchUniverse(opts: { refresh?: boolean } = {}): Promise<UniverseResponse> {
  const qs = opts.refresh ? "?refresh=true" : "";
  const res = await fetch(`${API_URL}/api/public/universe${qs}`);
  if (!res.ok) {
    throw new Error(`Universe fetch failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as UniverseResponse;
  return { ...data, companies: data.companies.filter((c) => c.exchange === "BVB") };
}

/** Sector chips for the filter row. Live source-of-truth lives in
 *  `src/engine/public/universe.py::sectors()`; we mirror it here so
 *  the FE can render the chips without a second roundtrip. Order
 *  matches the backend's display order.
 *
 *  PUB-200 — grew to 12 sectors when the universe expanded to 200+
 *  tickers (Utilities, Real Estate, Materials added). Keep in sync
 *  with the backend's universe.py — both are flat lists so a diff
 *  is easy to spot in code review. */
export const UNIVERSE_SECTORS: string[] = [
  "Technology",
  "Semiconductors",
  "Communication",
  "Consumer Discretionary",
  "Consumer Defensive",
  "Healthcare",
  "Financials",
  "Industrials",
  "Energy",
  "Utilities",
  "Real Estate",
  "Materials",
];

// ── Display helpers ─────────────────────────────────────────────────────

/** Map a snapshot's `currency` field to the `Currency` type the Money
 *  component expects. SF1 reports in USD; the FX layer handles RON/EUR
 *  conversion via the user's TopHeader toggle. */
export function snapshotCurrency(s: PublicCompanyFinancialSnapshot): Currency {
  return (s.currency as Currency) || "USD";
}
