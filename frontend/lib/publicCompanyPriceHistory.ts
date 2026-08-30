// publicCompanyPriceHistory.ts — types + client for the
// /api/public/companies/:ticker/price-history endpoint.
//
// PUB-200 — powers the StockPriceChart drawer. Backend returns demo
// synth when SEP isn't entitled, so the FE only branches on the
// `source` field to render the Demo watermark — the chart renders the
// same way either way.

import { staticBvbRows } from "@/lib/bvbStaticUniverse";

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
  source: "nasdaq" | "bvb_yahoo" | "demo" | "unavailable";
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
  try {
    const res = await fetch(
      `${API_URL}/api/public/companies/${t}/price-history?${qs.toString()}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as PriceHistoryPayload;
    // A backend that predates the BVB provider answers with an empty
    // "unavailable" payload for Romanian tickers — treat that like a
    // failure so the dev fallback below gets its chance.
    if (payload.points.length === 0 && isBvbTicker(ticker)) {
      throw new Error("empty payload for BVB ticker");
    }
    return payload;
  } catch (err) {
    // Dev fallback (2026-07-23): when the engine isn't reachable (local
    // Vite without a backend) BVB charts are fetched through the Vite
    // dev-server proxy at /yahoo → query1.finance.yahoo.com (browsers
    // can't call Yahoo directly — no CORS headers). In production the
    // path 404s and the original error propagates; the deployed engine
    // serves these charts itself via providers/yahoo_bvb.py.
    if (isBvbTicker(ticker)) {
      const fallback = await fetchBvbHistoryViaProxy(ticker, range).catch(() => null);
      if (fallback) return fallback;
    }
    throw err instanceof Error
      ? err
      : new Error(`Price history fetch failed for ${ticker} @ ${range}`);
  }
}

// ── BVB dev fallback (mirrors src/engine/public/providers/yahoo_bvb.py) ──

function isBvbTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return staticBvbRows().some((r) => r.ticker === t);
}

const YAHOO_RANGE: Record<PriceRange, [string, string]> = {
  "1D": ["5d", "1d"],
  "5D": ["5d", "1d"],
  "1M": ["1mo", "1d"],
  "6M": ["6mo", "1d"],
  YTD: ["ytd", "1d"],
  "1Y": ["1y", "1d"],
  "5Y": ["5y", "1d"],
  MAX: ["max", "1wk"],
};

async function fetchBvbHistoryViaProxy(
  ticker: string,
  range: PriceRange,
): Promise<PriceHistoryPayload | null> {
  const symbol = `${ticker.toUpperCase().replace(/\.BVB$/, "")}.RO`;
  const [yrange, interval] = YAHOO_RANGE[range] ?? YAHOO_RANGE["1Y"];
  const res = await fetch(
    `/yahoo/v8/finance/chart/${encodeURIComponent(symbol)}?range=${yrange}&interval=${interval}`,
  );
  if (!res.ok) return null;
  const payload = await res.json();
  const result = payload?.chart?.result?.[0];
  const stamps: number[] = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  if (!stamps.length) return null;

  // Annotated on the MAP, not on the filtered result. Annotating only the
  // final binding leaves the mapped object literal uncontextualised, so
  // `close: number` widens, the element type stops being a PricePoint, and
  // the type predicate below is rejected (TS2677).
  let points: PricePoint[] = stamps
    .map((ts, i): PricePoint | null => {
      const close = quote.close?.[i];
      if (close == null) return null;
      return {
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        open: quote.open?.[i] ?? null,
        high: quote.high?.[i] ?? null,
        low: quote.low?.[i] ?? null,
        close: Math.round(close * 10000) / 10000,
        volume: quote.volume?.[i] ?? null,
      };
    })
    .filter((p): p is PricePoint => p !== null);
  if (range === "1D" && points.length > 2) points = points.slice(-2);
  if (!points.length) return null;

  return {
    ticker: ticker.toUpperCase(),
    range,
    currency: "RON",
    source: "bvb_yahoo",
    mode: "live",
    message: null,
    points,
    fetched_at: new Date().toISOString(),
  };
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
