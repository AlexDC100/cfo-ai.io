// Demo watchlist for Public Company Intelligence.
//
// Used while the operator's Sharadar SF1 subscription isn't entitled (or
// hasn't propagated). Numbers are illustrative — last-known public figures
// from each issuer's annual reports. Replace with live /api/public/companies
// calls once the subscription is live.
//
// IMPORTANT: this is for FE rendering only. Never used for any analysis
// computation or to display as "current" data without the "Demo data" badge.

import type { PublicCompanyHit } from "@/lib/publicCompanyApi";

export interface WatchlistRow {
  ticker: string;
  name: string;
  sector: string;
  industry: string;
  exchange: string;
  // BVB Phase 2 (2026-06-01) — widened from "USD" to "USD" | "RON" to
  // admit BVB-listed tickers (CFH, TLV) in the same quick-pick chip set.
  currency: "USD" | "RON";
  // Display country — surfaces in the search-result country chip.
  // Defaults to United States via the helper if absent (back-compat).
  country?: string;
  // Snapshot metrics — illustrative public figures. Stored in NATIVE
  // currency (the field name was historically `_usd` but BVB rows
  // store RON values directly; the suffix is preserved for back-compat
  // — readers should use the row's `currency` to label values).
  market_cap_usd: number;
  revenue_usd: number;
  ebitda_margin_pct: number;
  net_debt_to_ebitda: number;
  pe_ratio: number;
  ev_ebitda: number;
  fcf_yield_pct: number;
  dividend_yield_pct: number;
  revenue_growth_pct: number;
  last_updated_iso: string;
  status: "fresh" | "stale" | "demo";
}

export const DEMO_WATCHLIST: WatchlistRow[] = [
  // ── BVB Phase 2 (2026-06-01) — Romanian quick-picks lead the chip row
  //    so the first thing a customer sees suggests a Romanian-listed peer
  //    set, not the Mag 7. Values are FY2024 statutory disclosures
  //    (mirrors src/engine/public/bvb_seed.py).
  {
    ticker: "CFH", name: "Cris-Tim Family Holding S.A.",
    sector: "Consumer Defensive", industry: "Food Processing — Meat",
    exchange: "BVB", currency: "RON", country: "Romania",
    market_cap_usd: 1_050_000_000,        // RON, despite the field suffix
    revenue_usd: 1_160_000_000,
    ebitda_margin_pct: 12.0,               // illustrative; operator can refine
    net_debt_to_ebitda: 1.2,
    pe_ratio: 12.1,
    ev_ebitda: 8.0,
    fcf_yield_pct: 4.5,
    dividend_yield_pct: 3.0,
    revenue_growth_pct: 8.0,
    last_updated_iso: "2024-12-31",
    status: "demo",
  },
  {
    ticker: "TLV", name: "Banca Transilvania S.A.",
    sector: "Financials", industry: "Banks",
    exchange: "BVB", currency: "RON", country: "Romania",
    market_cap_usd: 46_700_000_000,        // RON
    revenue_usd: 11_000_000_000,           // net banking income
    ebitda_margin_pct: 45.0,
    net_debt_to_ebitda: 0,                 // not meaningful for a bank
    pe_ratio: 9.9,
    ev_ebitda: 8.0,
    fcf_yield_pct: 0,                      // not meaningful for a bank
    dividend_yield_pct: 4.5,
    revenue_growth_pct: 15.0,
    last_updated_iso: "2024-12-31",
    status: "demo",
  },
  {
    ticker: "AAPL", name: "Apple Inc.", sector: "Technology",
    industry: "Consumer Electronics", exchange: "NASDAQ", currency: "USD",
    market_cap_usd: 3_780_000_000_000,
    revenue_usd: 391_035_000_000,
    ebitda_margin_pct: 34.4,
    net_debt_to_ebitda: 0.31,
    pe_ratio: 40.5,
    ev_ebitda: 28.4,
    fcf_yield_pct: 2.9,
    dividend_yield_pct: 0.46,
    revenue_growth_pct: 2.0,
    last_updated_iso: "2024-12-31",
    status: "demo",
  },
  {
    ticker: "MSFT", name: "Microsoft Corp.", sector: "Technology",
    industry: "Software—Infrastructure", exchange: "NASDAQ", currency: "USD",
    market_cap_usd: 3_100_000_000_000,
    revenue_usd: 245_122_000_000,
    ebitda_margin_pct: 53.1,
    net_debt_to_ebitda: -0.45,
    pe_ratio: 36.2,
    ev_ebitda: 23.8,
    fcf_yield_pct: 2.4,
    dividend_yield_pct: 0.78,
    revenue_growth_pct: 15.7,
    last_updated_iso: "2024-06-30",
    status: "demo",
  },
  {
    ticker: "NVDA", name: "NVIDIA Corp.", sector: "Technology",
    industry: "Semiconductors", exchange: "NASDAQ", currency: "USD",
    market_cap_usd: 3_400_000_000_000,
    revenue_usd: 130_497_000_000,
    ebitda_margin_pct: 65.0,
    net_debt_to_ebitda: -0.55,
    pe_ratio: 54.0,
    ev_ebitda: 38.2,
    fcf_yield_pct: 1.8,
    dividend_yield_pct: 0.03,
    revenue_growth_pct: 125.0,
    last_updated_iso: "2025-01-31",
    status: "demo",
  },
  {
    ticker: "KO", name: "Coca-Cola Co.", sector: "Consumer Defensive",
    industry: "Beverages—Non-Alcoholic", exchange: "NYSE", currency: "USD",
    market_cap_usd: 273_000_000_000,
    revenue_usd: 46_318_000_000,
    ebitda_margin_pct: 33.8,
    net_debt_to_ebitda: 2.1,
    pe_ratio: 25.4,
    ev_ebitda: 19.8,
    fcf_yield_pct: 3.4,
    dividend_yield_pct: 3.05,
    revenue_growth_pct: 3.0,
    last_updated_iso: "2024-12-31",
    status: "demo",
  },
  {
    ticker: "PEP", name: "PepsiCo Inc.", sector: "Consumer Defensive",
    industry: "Beverages—Non-Alcoholic", exchange: "NASDAQ", currency: "USD",
    market_cap_usd: 205_000_000_000,
    revenue_usd: 91_854_000_000,
    ebitda_margin_pct: 18.6,
    net_debt_to_ebitda: 2.4,
    pe_ratio: 24.1,
    ev_ebitda: 14.2,
    fcf_yield_pct: 4.1,
    dividend_yield_pct: 3.55,
    revenue_growth_pct: 0.4,
    last_updated_iso: "2024-12-31",
    status: "demo",
  },
  {
    ticker: "TSLA", name: "Tesla Inc.", sector: "Consumer Cyclical",
    industry: "Auto Manufacturers", exchange: "NASDAQ", currency: "USD",
    market_cap_usd: 1_300_000_000_000,
    revenue_usd: 97_690_000_000,
    ebitda_margin_pct: 12.4,
    net_debt_to_ebitda: -1.2,
    pe_ratio: 95.0,
    ev_ebitda: 105.0,
    fcf_yield_pct: 0.4,
    dividend_yield_pct: 0,
    revenue_growth_pct: 1.0,
    last_updated_iso: "2024-12-31",
    status: "demo",
  },
];

/** Quick "did the operator's Nasdaq key authenticate against SF1 yet" toggle.
 *  The hub page wraps each render in this so the "Demo data" badge appears
 *  uniformly across watchlist + benchmark + AI panels. */
export function isDemoMode(keyConfigured: boolean, sampleSubscriptionRequired: boolean): boolean {
  if (!keyConfigured) return true;
  if (sampleSubscriptionRequired) return true;
  return false;
}

/** Hit objects for the search field's default suggestions, derived from the
 *  same watchlist so a user can click a chip to drop straight into a result. */
export function watchlistAsHits(): PublicCompanyHit[] {
  return DEMO_WATCHLIST.map((r) => ({
    ticker: r.ticker,
    name: r.name,
    sector: r.sector,
    industry: r.industry,
    exchange: r.exchange,
    // BVB Phase 2 — read country from row when present (RO for BVB picks)
    // and default to United States for back-compat with rows authored
    // before the country field was added.
    country: r.country ?? "United States",
    currency: r.currency,
    is_active: true,
  }));
}
