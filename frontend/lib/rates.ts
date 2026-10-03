// FX rate fetching + caching.
//
// TWO SOURCES, ONE CHOICE.
//   1. The `fx-rates` Supabase Edge Function — asked FIRST. It proxies BNR's
//      XML server-side (bnr.ro sends no CORS headers), shares one cached rate
//      across all users via `fx_rates_cache`, and keeps display-currency
//      conversion working with `cfo-ai-backend` stopped (root CLAUDE.md,
//      "Milestone D"). When it answers a CURRENT rate, nothing else is asked.
//   2. The engine's GET /api/fx-rates — asked ONLY when the function's answer
//      is not a current BNR rate (`stale: true`, or `source` not "BNR"), or
//      when the function does not answer. Same payload shape.
//
// WHY THE SECOND SOURCE (measured on production, 2026-10-03). BNR moved its
// feed; the deployed function kept asking the dead address and served its
// last cached row, marked stale, for two months:
//
//   {"rates":{"EUR":1,"RON":5.2489,"USD":1.1541116974494283},"source":"BNR",
//    "as_of":"2026-08-05","fetched_at":"2026-08-05T11:09:17.271+00:00","stale":true}
//
// This module read `stale: true` and used the payload anyway — EUR amounts
// 1.8% too high, USD amounts 4.5%, against BNR's file of 2026-10-02 (5.3447
// RON per EUR, 4.7519 RON per USD). A frontend deploy does not redeploy the
// function, so the browser is made right without it: a stale answer is a
// reason to ask the engine, never an answer to trust. The function's source
// is repaired too (supabase/functions/fx-rates); this choice stays for the
// hours between the two deploys and for any later outage of either source.
//
// THE CHOICE (`chooseRates`, law: frontend/lib/__tests__/fxRatesChoice.test.ts,
// gate fx-browser):
//   · a CURRENT payload is `source: "BNR"` and `stale: false`;
//   · the function is current: it is used and the engine is NOT asked;
//   · the function is not current and the engine is: the engine's payload is
//     used — unless the function's is a BNR rate with a strictly NEWER
//     `as_of`, which is kept, marked stale (the newer publication wins);
//   · the engine is unreachable or itself stale: the function's payload is
//     kept — MARKED STALE, never presented as current;
//   · the function does not answer: the engine's payload is used as it is
//     served (marked stale unless current);
//   · neither answers: the last payload this browser held, marked stale once
//     it is past its day, else the bundled fallback, marked stale.
//
// THE BROWSER'S OWN COPY (localStorage `cfo:fx-rates:v1`) keeps whichever was
// chosen. Only a CURRENT payload held for less than a day spares the request:
// a held payload that is stale, or the fallback, or older than a day, never
// suppresses the next attempt — every mount asks again until a current rate
// is held. (That part was already so before 2026-10-03: the old check skipped
// the request only for a held payload with `stale: false`. What it did not do
// was ask anyone else, mark a day-old copy stale when the network failed, or
// mark it stale on first paint.)

export type Currency = "RON" | "EUR" | "USD";

export type Rates = Record<Currency, number>;

export interface RatesPayload {
  base: "EUR";                      // all rates are X units per 1 EUR
  rates: Rates;
  source: "BNR" | "fallback";
  as_of: string;                    // ISO date the upstream published
  fetched_at: string;               // ISO timestamp of last cache refresh
  stale: boolean;                   // true = NOT a current BNR rate
}

// Bundled fallback — BNR's file of 2026-10-02 — so the app paints SOMETHING
// on first load before either source answers. Always `stale: true`.
// THREE LIVE COPIES, held equal by the gate fx-browser: this one,
// supabase/functions/fx-rates/bnr.ts and src/engine/api/fx_rates.py.
export const FALLBACK_RATES: Rates = {
  EUR: 1.0,
  RON: 5.3447,              // 1 EUR = 5.3447 RON
  USD: 5.3447 / 4.7519,     // 1 EUR = 1.12475 USD (BNR: 1 USD = 4.7519 RON)
};

export const FALLBACK_PAYLOAD: RatesPayload = {
  base: "EUR",
  rates: FALLBACK_RATES,
  source: "fallback",
  as_of: "2026-10-02",
  fetched_at: new Date().toISOString(),
  stale: true,
};

const CACHE_KEY = "cfo:fx-rates:v1";
const TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours
const REQUEST_TIMEOUT_MS = 8000;      // neither source may hang the other's turn

import { SITE } from "@/config/site";

const API_URL = SITE.apiUrl;

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** The Edge Function's address, or null when Supabase is not configured. */
function functionEndpoint(forceRefresh: boolean): { url: string; headers: Record<string, string> } | null {
  if (!SUPABASE_URL) return null;
  const headers: Record<string, string> = { Accept: "application/json" };
  // The function is deployed --no-verify-jwt (rates are public reference
  // data and the landing page renders them signed-out), but the platform
  // gateway still wants an apikey when one is available.
  if (SUPABASE_ANON_KEY) headers.apikey = SUPABASE_ANON_KEY;
  return { url: `${SUPABASE_URL}/functions/v1/fx-rates${forceRefresh ? "?refresh=true" : ""}`, headers };
}

/** The engine's address. No `?refresh=true`: on the engine that parameter is
 *  the operator's (it is ignored without the operator bearer). */
function engineEndpoint(): { url: string; headers: Record<string, string> } {
  return { url: `${API_URL}/api/fx-rates`, headers: { Accept: "application/json" } };
}

/** A payload that may be shown as the current rate. (A plain boolean, not a
 *  type guard: "not current" does not mean "not a payload".) */
export function isCurrentBnrRate(p: RatesPayload | null | undefined): boolean {
  return !!p && p.source === "BNR" && p.stale === false;
}

function asStale(p: RatesPayload): RatesPayload {
  return p.stale === true ? p : { ...p, stale: true };
}

/** The publication date as a comparable string ("" when absent). */
function asOf(p: RatesPayload): string {
  return typeof p.as_of === "string" ? p.as_of : "";
}

/** THE CHOICE between what the function answered and what the engine
 *  answered (null = did not answer). Pure. Returns null when neither did.
 *  A payload that is not current is ALWAYS returned with `stale: true`. */
export function chooseRates(
  fromFunction: RatesPayload | null,
  fromEngine: RatesPayload | null,
): RatesPayload | null {
  const fnCurrent = isCurrentBnrRate(fromFunction);
  const engineCurrent = isCurrentBnrRate(fromEngine);
  if (fnCurrent && engineCurrent) {
    // Both current: the newer publication date wins, the function's on a tie.
    return asOf(fromEngine) > asOf(fromFunction) ? fromEngine : fromFunction;
  }
  if (fnCurrent) return fromFunction;
  if (engineCurrent) {
    // The engine holds a current rate and the function does not. The engine's
    // is used — unless the function's is a BNR rate published AFTER it, which
    // is the better figure and is kept, marked stale.
    if (fromFunction && fromFunction.source === "BNR" && asOf(fromFunction) > asOf(fromEngine)) {
      return asStale(fromFunction);
    }
    return fromEngine;
  }
  // Nothing current. Keep the function's answer when there is one — the
  // engine being down or stale must not change what the app shows — and say
  // what it is: stale.
  if (fromFunction) return asStale(fromFunction);
  if (fromEngine) return asStale(fromEngine);
  return null;
}

type CacheRecord = {
  payload: RatesPayload;
  cached_at: number;   // epoch ms
};

function isRatesPayload(payload: unknown): payload is RatesPayload {
  const p = payload as RatesPayload | null;
  return (
    typeof p?.rates?.EUR === "number" &&
    typeof p?.rates?.RON === "number" &&
    typeof p?.rates?.USD === "number" &&
    p.rates.EUR > 0 &&
    p.rates.RON > 0 &&
    p.rates.USD > 0
  );
}

function readCache(): CacheRecord | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheRecord;
    // Light shape validation — bail on anything weird.
    if (!isRatesPayload(parsed?.payload)) return null;
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

/** Is this held record a current rate RIGHT NOW: a current BNR payload,
 *  stored less than a day ago (and not in the future — a clock set back). */
function heldIsCurrent(rec: CacheRecord, nowMs: number): boolean {
  const age = nowMs - rec.cached_at;
  return isCurrentBnrRate(rec.payload) && age >= 0 && age < TTL_MS;
}

/** The held payload as it may be shown: unchanged while it is current,
 *  marked stale otherwise. */
function heldPayload(rec: CacheRecord, nowMs: number): RatesPayload {
  return heldIsCurrent(rec, nowMs) ? rec.payload : asStale(rec.payload);
}

/** Synchronous accessor for the most recent cached payload (or fallback).
 *  Used by the store's initial state so the FIRST paint already has
 *  real-ish rates rather than placeholder zeros. Never throws. The fetch
 *  that follows on mount replaces it. A held payload past its day is marked
 *  stale until that fetch answers — it is the last rate this browser saw,
 *  not a current one. */
export function getInitialRates(): RatesPayload {
  const cached = readCache();
  if (cached) return heldPayload(cached, Date.now());
  return FALLBACK_PAYLOAD;
}

/** One GET. null on any failure: network, timeout, non-2xx, wrong shape. */
async function ask(
  endpoint: { url: string; headers: Record<string, string> },
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<RatesPayload | null> {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const init: RequestInit = { method: "GET", headers: endpoint.headers };
    if (ctl) init.signal = ctl.signal;
    const resp = await fetch(endpoint.url, init);
    if (!resp.ok) return null;
    const payload = (await resp.json()) as unknown;
    return isRatesPayload(payload) ? payload : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fetch the rates: the function first, the engine only when the function's
 *  answer is not a current BNR rate. Caller decides when to call — on app
 *  mount. Never throws; always returns a payload. */
export async function fetchRates(opts: { forceRefresh?: boolean } = {}): Promise<RatesPayload> {
  // A CURRENT payload held for less than a day is used without a request.
  // A held payload that is stale (or is the fallback, or is past its day)
  // never suppresses the next attempt: every call asks again until a current
  // rate is held.
  const cached = readCache();
  if (!opts.forceRefresh && cached && heldIsCurrent(cached, Date.now())) {
    return cached.payload;
  }

  const fn = functionEndpoint(opts.forceRefresh === true);
  const fromFunction = fn ? await ask(fn) : null;
  // The second request happens only when the first did not settle it.
  const fromEngine = isCurrentBnrRate(fromFunction) ? null : await ask(engineEndpoint());

  const chosen = chooseRates(fromFunction, fromEngine);
  if (chosen) {
    writeCache(chosen);
    return chosen;
  }

  // Neither answered. The last payload this browser held is better than the
  // bundled constant — and past its day it is no longer a current rate.
  if (cached) return heldPayload(cached, Date.now());
  return FALLBACK_PAYLOAD;
}
