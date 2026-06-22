// publicCompanyPriceHistory.ts — types + client for the
// /api/public/companies/:ticker/price-history endpoint.
//
// PUB-200 — powers the StockPriceChart drawer. Backend returns demo
// synth when SEP isn't entitled, so the FE only branches on the
// `source` field to render the Demo watermark — the chart renders the
// same way either way.

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://127.0.0.1:8000";

export type PriceRange = "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y" | "5Y" | "MAX";

export const PRICE_RANGES: PriceRange[] = [
  "1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX",
];

export interface PricePoint {
  date: string;                 // ISO YYYY-MM-DD
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close: number;
  volume?: number | null;
}

export interface PriceHistoryPayload {
  ticker: string;
  range: PriceRange;
  currency: string;
  source: "nasdaq" | "demo" | "unavailable";
  mode: "live" | "demo";
  message: string | null;
  points: PricePoint[];
  fetched_at: string;
}

export async function fetchPriceHistory(
  ticker: string,
  range: PriceRange = "1Y",
  opts: { refresh?: boolean } = {},
): Promise<PriceHistoryPayload> {
  const qs = new URLSearchParams({ range });
  if (opts.refresh) qs.set("refresh", "true");
  const t = encodeURIComponent(ticker);
  const res = await fetch(
    `${API_URL}/api/public/companies/${t}/price-history?${qs.toString()}`,
  );
  if (!res.ok) {
    throw new Error(
      `Price history fetch failed for ${ticker} @ ${range}: HTTP ${res.status}`,
    );
  }
  return (await res.json()) as PriceHistoryPayload;
}

/** Compute period delta for the chart header. Returns absolute and
 *  percentage change between the first and last point. */
export function priceDelta(points: PricePoint[]):
  | { abs: number; pct: number; first: number; last: number }
  | null {
  if (points.length < 2) return null;
  const first = points[0].close;
  const last = points[points.length - 1].close;
  if (first === 0) return null;
  const abs = last - first;
  const pct = (abs / first) * 100;
  return { abs, pct, first, last };
}
