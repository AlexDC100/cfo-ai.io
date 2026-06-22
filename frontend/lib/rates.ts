// FX rate fetching + caching.
// Pulls daily rates from the backend's /api/fx-rates endpoint (which
// proxies BNR XML server-side, sidestepping the CORS issue with bnr.ro).
// Falls back to bundled rates so the app NEVER renders garbage.

export type Currency = "RON" | "EUR" | "USD";

export type Rates = Record<Currency, number>;

export interface RatesPayload {
  base: "EUR";                      // all rates are X units per 1 EUR
  rates: Rates;
  source: "BNR" | "fallback";
  as_of: string;                    // ISO date the upstream published
  fetched_at: string;               // ISO timestamp of last cache refresh
  stale: boolean;                   // true when backend served fallback
}

// Bundled fallback so the app paints SOMETHING on first load even
// before the FX endpoint responds. Matches lib/currency.ts FX_RON_TO_EUR.
export const FALLBACK_RATES: Rates = {
  EUR: 1.0,
  RON: 4.97,
  USD: 1.08,
};

export const FALLBACK_PAYLOAD: RatesPayload = {
  base: "EUR",
  rates: FALLBACK_RATES,
  source: "fallback",
  as_of: "2026-05-01",
  fetched_at: new Date().toISOString(),
  stale: true,
};

const CACHE_KEY = "cfo:fx-rates:v1";
const TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours

import { SITE } from "@/config/site";

const API_URL = SITE.apiUrl;

type CacheRecord = {
  payload: RatesPayload;
  cached_at: number;   // epoch ms
};

function readCache(): CacheRecord | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheRecord;
    // Light shape validation — bail on anything weird.
    if (
      !parsed?.payload?.rates?.EUR ||
      !parsed?.payload?.rates?.RON ||
      !parsed?.payload?.rates?.USD
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(payload: RatesPayload): void {
  try {
    const rec: CacheRecord = { payload, cached_at: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(rec));
  } catch {
    // localStorage may be disabled (private mode); silent failure is OK
    // because the runtime still has the in-memory copy.
  }
}

/** Synchronous accessor for the most recent cached payload (or fallback).
 *  Used by the store's initial state so the FIRST paint already has
 *  real-ish rates rather than placeholder zeros. Never throws. */
export function getInitialRates(): RatesPayload {
  const cached = readCache();
  if (cached) return cached.payload;
  return FALLBACK_PAYLOAD;
}

/** Async fetch from the backend (which itself caches 24h server-side).
 *  Caller decides when to call — typically on app mount + on user
 *  clicking "refresh rates" in settings. */
export async function fetchRates(opts: { forceRefresh?: boolean } = {}): Promise<RatesPayload> {
  // If a fresh-enough cache exists AND caller didn't force, skip the call.
  const cached = readCache();
  if (
    !opts.forceRefresh &&
    cached &&
    Date.now() - cached.cached_at < TTL_MS &&
    !cached.payload.stale
  ) {
    return cached.payload;
  }

  try {
    const url = `${API_URL}/api/fx-rates${opts.forceRefresh ? "?refresh=true" : ""}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const payload = (await resp.json()) as RatesPayload;
    // Shape guard — backend should always return this shape, but cheap insurance.
    if (
      typeof payload?.rates?.EUR !== "number" ||
      typeof payload?.rates?.RON !== "number" ||
      typeof payload?.rates?.USD !== "number"
    ) {
      throw new Error("malformed rates payload");
    }
    writeCache(payload);
    return payload;
  } catch (err) {
    // Network or shape error — degrade gracefully.
    if (cached) return cached.payload;
    return FALLBACK_PAYLOAD;
  }
}
