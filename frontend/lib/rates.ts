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
//   · a CURRENT payload is `source: "BNR"`, `stale: false` AND published
//     (`as_of`) at most `MAX_AGE_DAYS` before today, never after it — the
//     sources' own freshness rule, re-checked here: a label is not trusted
//     against the date it is printed beside;
//   · the function is current: it is used and the engine is NOT asked;
//   · the function is not current and the engine is: the engine's payload is
//     used — unless the function's is a BNR rate with a strictly NEWER
//     `as_of`, which is kept, marked stale (the newer publication wins);
//   · NOTHING is current: of the two answers the NEWER publication is kept
//     (the function's on a tie) — MARKED STALE, never presented as current;
//   · one source does not answer: the other's payload, marked stale unless
//     current;
//   · neither answers: what this browser holds (below).
// Whatever is chosen, `chooseRates` marks it in ONE place: a payload that is
// not current never leaves it without `stale: true`.
//
// THE BROWSER'S OWN COPY (localStorage `cfo:fx-rates:v1`) changes only for
// something BETTER (`preferHeld`): a current rate always replaces it; an
// answer that is not current replaces it only when what is held is not
// current either AND the answer was published later. So a stale answer never
// replaces a current rate, nor an older figure a newer one — and with nothing
// held, "what is held" is the bundled fallback (BNR's file of 2026-10-02),
// which a source's two-month-old row does not displace — and a STORED record
// that is not current and older than the bundled fallback yields to it too
// (`getHeldRates`), so two browsers handed the same answers show the same
// figure whatever they stored before.
// Only a CURRENT payload held for less than a day spares the request: a held
// payload that is stale, or the fallback, or older than a day, never
// suppresses the next attempt — every look asks again until a current rate is
// held. (That part was already so before 2026-10-03: the old check skipped
// the request only for a held payload with `stale: false`. What it did not do
// was ask anyone else, mark a day-old copy stale when the network failed, or
// mark it stale on first paint.)
//
// A TAB THAT STAYS OPEN (stores/currency.tsx, law: fxOpenTab.test.tsx). The
// rule above is about TIME, so it cannot be applied once, at load: a rate
// accepted at 07:00 on Monday is not Thursday's rate because the tab was never
// reloaded. A held rate is therefore a record — the payload AND the moment a
// source answered it (`HeldRates`) — and what may be shown is derived from it
// at read time (`ratesAsShown`): unchanged inside its day, marked stale after.
// The provider keeps asking for as long as it is mounted (`ratesNeedAttempt`);
// inside the held day that costs no request.

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
// Each request has its OWN abandon: a function that hangs must not cost the
// engine its turn, and an engine that hangs must not leave the attempt — and
// with it every later one (the provider runs one at a time) — pending forever.
const FUNCTION_TIMEOUT_MS = 8000;
const ENGINE_TIMEOUT_MS = 8000;
/** A rate published more than this many days ago is not a current rate,
 *  whatever its label says. The sources' own limit (`_MAX_AGE_DAYS` in
 *  fx_rates.py, `MAX_AGE_DAYS` in the function's bnr.ts): BNR's longest gap
 *  between two files is a holiday bridge of five or six days. */
export const MAX_AGE_DAYS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** The latest calendar date it can be in Romania at `nowMs` (UTC+3, the
 *  summer offset) — the sources' own rule, so the three agree on "today". */
export function todayInRomania(nowMs: number): string {
  return new Date(nowMs + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** `as_of` as a real calendar date (YYYY-MM-DD) not after today, else "".
 *  The key the publication dates are compared by: a date that is missing,
 *  malformed or in the future ranks below every real one. */
function publishedOn(p: RatesPayload, nowMs: number): string {
  const s = typeof p.as_of === "string" ? p.as_of : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return "";
  return s <= todayInRomania(nowMs) ? s : "";
}

/** Was this payload published at most MAX_AGE_DAYS before today (and not
 *  after it)? */
function publishedRecently(p: RatesPayload, nowMs: number): boolean {
  const on = publishedOn(p, nowMs);
  if (on === "") return false;
  const age = Math.round((Date.parse(`${todayInRomania(nowMs)}T00:00:00Z`) - Date.parse(`${on}T00:00:00Z`)) / DAY_MS);
  return age <= MAX_AGE_DAYS;
}

/** A payload that may be shown as the current rate: a BNR rate, labelled not
 *  stale, published within MAX_AGE_DAYS. (A plain boolean, not a type guard:
 *  "not current" does not mean "not a payload".) */
export function isCurrentBnrRate(p: RatesPayload | null | undefined, nowMs: number = Date.now()): boolean {
  return !!p && p.source === "BNR" && p.stale === false && publishedRecently(p, nowMs);
}

function asStale(p: RatesPayload): RatesPayload {
  return p.stale === true ? p : { ...p, stale: true };
}

/** Which of the two answers — as served, not yet marked. */
function pickRates(
  fromFunction: RatesPayload | null,
  fromEngine: RatesPayload | null,
  nowMs: number,
): RatesPayload | null {
  if (!fromFunction || !fromEngine) return fromFunction ?? fromEngine;
  const fnCurrent = isCurrentBnrRate(fromFunction, nowMs);
  const engineCurrent = isCurrentBnrRate(fromEngine, nowMs);
  const fnOn = publishedOn(fromFunction, nowMs);
  const engineOn = publishedOn(fromEngine, nowMs);
  if (fnCurrent && engineCurrent) {
    // Both current: the newer publication date wins, the function's on a tie.
    return engineOn > fnOn ? fromEngine : fromFunction;
  }
  if (fnCurrent) return fromFunction;
  if (engineCurrent) {
    // The engine holds a current rate and the function does not. The engine's
    // is used — unless the function's is a BNR rate published AFTER it, which
    // is the better figure and is kept (marked stale by `chooseRates`).
    return fromFunction.source === "BNR" && fnOn > engineOn ? fromFunction : fromEngine;
  }
  // Nothing current: the newer publication, the function's on a tie.
  return engineOn > fnOn ? fromEngine : fromFunction;
}

/** THE CHOICE between what the function answered and what the engine
 *  answered (null = did not answer). Pure. Returns null when neither did.
 *  THE ONE PLACE A CHOSEN PAYLOAD IS MARKED: whatever `pickRates` picks, a
 *  payload that is not current leaves here with `stale: true`. */
export function chooseRates(
  fromFunction: RatesPayload | null,
  fromEngine: RatesPayload | null,
  nowMs: number = Date.now(),
): RatesPayload | null {
  const picked = pickRates(fromFunction, fromEngine, nowMs);
  if (picked === null) return null;
  return isCurrentBnrRate(picked, nowMs) ? picked : asStale(picked);
}

/** A payload and the moment (epoch ms) a source answered it to this browser.
 *  `cached_at: 0` is "never": the bundled fallback, which no source answered. */
export interface HeldRates {
  payload: RatesPayload;
  cached_at: number;
}

type CacheRecord = HeldRates;

/** Nothing held: the bundled fallback, answered by no source at no time. */
const NOTHING_HELD: HeldRates = { payload: FALLBACK_PAYLOAD, cached_at: 0 };

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
    // A record without a usable timestamp was answered "never": it can be
    // shown (marked stale) and never spares a request.
    const at = typeof parsed.cached_at === "number" && Number.isFinite(parsed.cached_at) ? parsed.cached_at : 0;
    return { payload: parsed.payload, cached_at: at };
  } catch {
    return null;
  }
}

function writeCache(rec: CacheRecord): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(rec));
  } catch {
    // localStorage may be disabled (private mode); silent failure is OK
    // because the caller is handed the same record and holds it in memory
    // (stores/currency.tsx keeps it, with its `cached_at`).
  }
}

/** Is this held record a current rate RIGHT NOW: a current BNR payload,
 *  stored less than a day ago (and not in the future — a clock set back). */
function heldIsCurrent(rec: CacheRecord, nowMs: number): boolean {
  const age = nowMs - rec.cached_at;
  return isCurrentBnrRate(rec.payload, nowMs) && age >= 0 && age < TTL_MS;
}

/** WHAT A BROWSER KEEPS when a source has answered `next` and it holds `own`.
 *  What is held changes only for something better:
 *    · `next` is a current rate: it is taken;
 *    · it is not, and `own` still is: `own` is kept — a stale answer never
 *      replaces a current rate;
 *    · neither is current: the one PUBLISHED later, `own` on a tie — an older
 *      figure never replaces a newer one. Both are shown marked stale.
 *  Used on the localStorage copy (`fetchHeldRates`) and on the copy a mounted
 *  tab holds in memory (stores/currency.tsx). */
export function preferHeld(own: HeldRates, next: HeldRates, nowMs: number): HeldRates {
  if (heldIsCurrent(next, nowMs)) return next;
  if (heldIsCurrent(own, nowMs)) return own;
  return publishedOn(next.payload, nowMs) > publishedOn(own.payload, nowMs) ? next : own;
}

/** What this browser holds — the record in localStorage, else the bundled
 *  fallback (`cached_at: 0`). A stored record that is not current and was
 *  published BEFORE the bundled fallback yields to it (`preferHeld`): the
 *  bundle then carries a newer BNR file than the record does — every browser
 *  that opened the app before 2026-10-03 holds the function's August row.
 *  The record itself is left where it is. Synchronous; never throws. */
export function getHeldRates(nowMs: number = Date.now()): HeldRates {
  const stored = readCache();
  return stored ? preferHeld(stored, NOTHING_HELD, nowMs) : NOTHING_HELD;
}

/** A held record AS IT MAY BE SHOWN at `nowMs`: the payload unchanged while
 *  it is a current rate inside its day, marked stale otherwise. Derived at
 *  READ time — a tab that stays open calls this again as the clock moves, so
 *  a rate does not stay "current" for as long as nobody reloads. */
export function ratesAsShown(held: HeldRates, nowMs: number): RatesPayload {
  return heldIsCurrent(held, nowMs) ? held.payload : asStale(held.payload);
}

/** Should the sources be asked: true unless a current rate is held inside
 *  its day. */
export function ratesNeedAttempt(held: HeldRates, nowMs: number): boolean {
  return !heldIsCurrent(held, nowMs);
}

/** The same rate, the same date, the same label — whatever the object. */
export function sameRates(a: RatesPayload, b: RatesPayload): boolean {
  return (
    a === b ||
    (a.source === b.source &&
      a.stale === b.stale &&
      a.as_of === b.as_of &&
      a.fetched_at === b.fetched_at &&
      a.rates.EUR === b.rates.EUR &&
      a.rates.RON === b.rates.RON &&
      a.rates.USD === b.rates.USD)
  );
}

/** Synchronous accessor for the most recent cached payload (or fallback).
 *  Used by the store's initial state so the FIRST paint already has
 *  real-ish rates rather than placeholder zeros. Never throws. The fetch
 *  that follows on mount replaces it. A held payload past its day is marked
 *  stale until that fetch answers — it is the last rate this browser saw,
 *  not a current one. */
export function getInitialRates(): RatesPayload {
  return ratesAsShown(getHeldRates(), Date.now());
}

/** One GET, abandoned after `timeoutMs`. null on any failure: network,
 *  timeout, non-2xx, wrong shape. */
async function ask(
  endpoint: { url: string; headers: Record<string, string> },
  timeoutMs: number,
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
 *  answer is not a current BNR rate. Returns the RECORD — the payload and
 *  when a source answered it — so the caller can keep deriving what may be
 *  shown as time passes (`ratesAsShown`). Never throws. */
export async function fetchHeldRates(opts: { forceRefresh?: boolean } = {}): Promise<HeldRates> {
  // A CURRENT payload held for less than a day is used without a request.
  // A held payload that is stale (or is the fallback, or is past its day)
  // never suppresses the next attempt: every call asks again until a current
  // rate is held.
  const cached = readCache();
  if (!opts.forceRefresh && cached && heldIsCurrent(cached, Date.now())) {
    return cached;
  }

  const fn = functionEndpoint(opts.forceRefresh === true);
  const fromFunction = fn ? await ask(fn, FUNCTION_TIMEOUT_MS) : null;
  // The second request happens only when the first did not settle it.
  const fromEngine = isCurrentBnrRate(fromFunction) ? null : await ask(engineEndpoint(), ENGINE_TIMEOUT_MS);

  // What this browser holds NOW: its last record — read again, another tab
  // may have stored one while the two requests were out — or the bundled
  // fallback when nothing is stored, or when what is stored is older than it.
  const now = Date.now();
  const own = getHeldRates(now);
  const chosen = chooseRates(fromFunction, fromEngine, now);
  // Neither answered: what is held stands (past its day `ratesAsShown` marks
  // it stale).
  if (!chosen) return own;

  const answered: HeldRates = { payload: chosen, cached_at: now };
  const kept = preferHeld(own, answered, now);
  // Only an answer that was TAKEN is stored — never the bundled fallback as
  // if a source had answered it, never an older stale figure over a newer one.
  if (kept === answered) writeCache(answered);
  return kept;
}

/** `fetchHeldRates`, as the payload that may be shown now. Never throws;
 *  always returns a payload. */
export async function fetchRates(opts: { forceRefresh?: boolean } = {}): Promise<RatesPayload> {
  return ratesAsShown(await fetchHeldRates(opts), Date.now());
}
