// The BNR reference-rate feed — the PURE half of the `fx-rates` Edge Function.
//
// Everything here runs unchanged in Deno (the function) and in Node (the
// gate): no `Deno` global, no import, no database client. `index.ts` holds
// the HTTP handler, the CORS allowlist and the three statements that touch
// the `fx_rates_cache` row; this file holds everything that can be wrong
// about the FEED — where it lives, what counts as the feed, how old a rate
// may be, when BNR may be asked again — and the order in which one request
// reads the row, asks BNR and writes the row (`resolveRates`).
//
// WHY THIS FILE EXISTS (measured on production, 2026-10-03). The deployed
// function asked `https://www.bnr.ro/nbrfxrates.xml` and nothing else. BNR
// had moved the feed to `https://curs.bnr.ro/nbrfxrates.xml`; the old address
// answers a redirect to a web page. The function fell back to its last cached
// row and served it, marked stale, for two months:
//
//   {"rates":{"EUR":1,"RON":5.2489,"USD":1.1541116974494283},"source":"BNR",
//    "as_of":"2026-08-05","fetched_at":"2026-08-05T11:09:17.271+00:00","stale":true}
//
// against BNR's file of 2026-10-02 (5.3447 RON per EUR, 4.7519 RON per USD):
// every EUR amount in the browser 1.8% too high, every USD amount 4.5%. It
// also refetched BNR on EVERY request while stale (no failure cooldown), and
// nothing tested its parser or its address: it was the one copy of the feed
// reader no gate could run, because it lived inside `Deno.serve`.
//
// The rules below are the engine's (`src/engine/api/fx_rates.py`), restated
// in this runtime and held by the gate `fx-browser`
// (frontend/lib/__tests__/fxFunctionBnr.test.ts) on BNR's own bytes
// (tests/engine/fixtures/fx/nbrfxrates_REAL_curs_bnr_ro.xml) and on the row
// production held on 2026-10-03.
//
// KEEP IN SYNC — three live copies of the bundled fallback, held equal by the
// gates: `_FALLBACK_RATES` / `_FALLBACK_AS_OF` in fx_rates.py, FALLBACK_*
// below, and `frontend/lib/rates.ts`.

export interface Rates {
  EUR: number;
  RON: number;
  USD: number;
}

export interface ParsedRates {
  base: "EUR";
  rates: Rates;
  source: "BNR";
  /** The Cube's date, YYYY-MM-DD — the day BNR published these. */
  as_of: string;
}

export interface RatesPayload {
  base: "EUR";
  rates: Rates;
  source: string;
  as_of: string;
  fetched_at: string;
  stale: boolean;
}

// ── Where the feed lives ────────────────────────────────────────────────
// Asked in order. Every address is a candidate: the newest acceptable Cube
// date wins (the first listed on a tie), and today's file ends the search.
export const BNR_URLS: readonly string[] = [
  "https://curs.bnr.ro/nbrfxrates.xml",
  "https://www.bnr.ro/nbrfxrates.xml",
];

export const TTL_MS = 24 * 60 * 60 * 1000; // an accepted file is good for a day
export const FETCH_TIMEOUT_MS = 8000; // don't hang the request on BNR
/** BNR is asked at most once per this window after an attempt — failed OR
 *  forced. Without it a stale cache refetched BNR on every request. */
export const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
/** A Cube older than this is an address answering a file that stopped
 *  updating. BNR's longest gap between two files is a holiday bridge. */
export const MAX_AGE_DAYS = 10;
/** The feed is under 2 KB. Anything over 64 KB is not the feed. */
export const MAX_BODY_BYTES = 64 * 1024;

// A rate outside these bounds is refused: a feed that changes its quoting
// convention (a multiplier, an inverted pair) must not become a silently
// wrong amount. RON per EUR has been 4.4–5.4 since 2015; USD per EUR 0.95–1.25.
export const PLAUSIBLE_RON_PER_EUR: readonly [number, number] = [3.0, 10.0];
export const PLAUSIBLE_USD_PER_EUR: readonly [number, number] = [0.5, 2.0];

// ── Bundled fallback: BNR's file of 2026-10-02 ──────────────────────────
// Served, marked stale, only when BNR does not answer AND no row is cached.
export const FALLBACK_RATES: Rates = {
  EUR: 1.0,
  RON: 5.3447, // 1 EUR = 5.3447 RON
  USD: 5.3447 / 4.7519, // 1 EUR = 1.12475 USD (BNR: 1 USD = 4.7519 RON)
};
export const FALLBACK_AS_OF = "2026-10-02";

export function fallbackPayload(nowIso: string): RatesPayload {
  return {
    base: "EUR",
    rates: { ...FALLBACK_RATES },
    source: "fallback",
    as_of: FALLBACK_AS_OF,
    fetched_at: nowIso,
    stale: true,
  };
}

// ── Parsing ─────────────────────────────────────────────────────────────
//
// Document shape:
//   <DataSet xmlns="https://www.bnr.ro/xsd" …>
//     <Header><PublishingDate>2026-10-02</PublishingDate></Header>
//     <Body><Cube date="2026-10-02">
//       <Rate currency="EUR">5.3447</Rate>
//       <Rate currency="USD">4.7519</Rate>
//   …
//
// BNR quotes everything in RON ("1 EUR = X RON"); we normalise to "X units
// per 1 EUR" so the frontend has a single consistent base.
//
// Parsed with regex rather than an XML DOM: Deno has no built-in DOMParser,
// and this document is a flat, machine-generated list of <Rate> elements.
// The expressions accept any namespace prefix and do not read `xmlns` at
// all, so the namespace BNR writes (http://, https://, curs.bnr.ro) cannot
// break them. No entity is ever expanded.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)/i;
/** A rate as the feed writes it: plain decimal digits. `Number()` alone would
 *  also read "0x10" and "1e1"; `parseFloat` would read "5,3447" as 5. */
const DECIMAL = /^\d+(?:\.\d+)?$/;
const CUBE = /<(?:[\w.-]+:)?Cube\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?Cube>/g;
const RATE = /<(?:[\w.-]+:)?Rate\b([^>]*)>([^<]*)<\/(?:[\w.-]+:)?Rate>/g;

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? (m[1] ?? m[2]) : undefined;
}

/** A real calendar date in YYYY-MM-DD, or null. */
function isoDate(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!ISO_DATE.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  // Date.parse rolls 2026-02-31 over to March; the round trip refuses it.
  return new Date(t).toISOString().slice(0, 10) === s ? s : null;
}

/** Parse the feed. Throws on anything that is not the feed: a body over
 *  64 KB, one declaring a DOCTYPE / ENTITY (a web page), no Cube with a date,
 *  no EUR / USD rate, a rate outside the plausible range. The clock is NOT
 *  read here — `requireFresh` judges the date. */
export function parseBnrXml(xml: string): ParsedRates {
  if (xml.length > MAX_BODY_BYTES) {
    throw new Error(`BNR body is ${xml.length} characters (over ${MAX_BODY_BYTES}) — not the feed`);
  }
  if (DECLARATION.test(xml)) {
    throw new Error("BNR body declares a DOCTYPE or an ENTITY — not the feed");
  }

  // More than one Cube (the ten-day file): the newest date is the rate.
  let chosen: { asOf: string; inner: string } | null = null;
  let cubes = 0;
  CUBE.lastIndex = 0;
  for (let m = CUBE.exec(xml); m !== null; m = CUBE.exec(xml)) {
    cubes += 1;
    const asOf = isoDate(attr(m[1], "date"));
    if (asOf && (chosen === null || asOf > chosen.asOf)) chosen = { asOf, inner: m[2] };
  }
  if (cubes === 0) throw new Error("BNR XML missing Cube");
  if (chosen === null) throw new Error("BNR XML carries no Cube with a date (YYYY-MM-DD)");

  // How many RON one unit of <currency> equals.
  const inRon: Record<string, number> = {};
  RATE.lastIndex = 0;
  for (let m = RATE.exec(chosen.inner); m !== null; m = RATE.exec(chosen.inner)) {
    const cur = attr(m[1], "currency");
    if (!cur) continue;
    const text = m[2].trim();
    // "5,3447" must be refused, not read as 5.
    if (!DECIMAL.test(text)) continue;
    let v = Number(text);
    // BNR publishes some currencies per 100 units (HUF, JPY, KRW) via a
    // `multiplier` attribute. Divide it out so every entry is per-1-unit.
    const multRaw = (attr(m[1], "multiplier") ?? "").trim();
    if (DECIMAL.test(multRaw) && Number(multRaw) !== 0) v = v / Number(multRaw);
    inRon[cur] = v;
  }

  const oneEurInRon = inRon.EUR;
  const oneUsdInRon = inRon.USD;
  if (!Number.isFinite(oneEurInRon) || oneEurInRon <= 0) {
    throw new Error("BNR XML missing EUR rate");
  }
  if (!Number.isFinite(oneUsdInRon) || oneUsdInRon <= 0) {
    throw new Error("BNR XML missing USD rate");
  }

  const rates: Rates = { EUR: 1.0, RON: oneEurInRon, USD: oneEurInRon / oneUsdInRon };
  const bounds: Array<["RON" | "USD", readonly [number, number]]> = [
    ["RON", PLAUSIBLE_RON_PER_EUR],
    ["USD", PLAUSIBLE_USD_PER_EUR],
  ];
  for (const [cur, [lo, hi]] of bounds) {
    if (!(rates[cur] > lo && rates[cur] < hi)) {
      throw new Error(
        `BNR rate outside the plausible range: ${cur} per 1 EUR = ${rates[cur]} (expected ${lo}..${hi})`,
      );
    }
  }
  return { base: "EUR", rates, source: "BNR", as_of: chosen.asOf };
}

// ── Freshness ───────────────────────────────────────────────────────────

/** The latest calendar date it can be in Romania at `now` (UTC+3, the summer
 *  offset — no tz database needed). */
export function todayInRomania(now: Date): string {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Throws unless `asOf` is a date not after `today` and at most
 *  MAX_AGE_DAYS before it. Both are YYYY-MM-DD. */
export function requireFresh(asOf: string, today: string): void {
  const published = isoDate(asOf);
  if (published === null) throw new Error(`BNR Cube date ${JSON.stringify(asOf)} is not a date`);
  if (published > today) {
    throw new Error(`BNR Cube is dated ${published}, after today (${today})`);
  }
  const age = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${published}T00:00:00Z`)) / 86_400_000,
  );
  if (age > MAX_AGE_DAYS) {
    throw new Error(
      `BNR Cube is dated ${published} — ${age} days old (limit ${MAX_AGE_DAYS}): ` +
        "the address answers a file that stopped updating",
    );
  }
}

// ── Reading the addresses ───────────────────────────────────────────────

/** The slice of `Response` this file reads — satisfied by `fetch`'s. */
export interface FeedResponse {
  ok: boolean;
  status: number;
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
  text(): Promise<string>;
}
export type FeedFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<FeedResponse>;

/** The body as text, read to `MAX_BODY_BYTES` + 1 at most. */
async function readCapped(resp: FeedResponse): Promise<string> {
  const reader = resp.body?.getReader?.();
  if (!reader) {
    const text = await resp.text();
    if (text.length > MAX_BODY_BYTES) throw new Error(`BNR body is over ${MAX_BODY_BYTES} bytes — not the feed`);
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`BNR body is over ${MAX_BODY_BYTES} bytes — not the feed`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  // fatal: a body that is not UTF-8 is not the feed.
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

async function readAddress(fetchFn: FeedFetch, url: string): Promise<ParsedRates> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchFn(url, {
      headers: { "User-Agent": "cfo-ai/1.0 (+https://cfo-ai.io)" },
      signal: ctl.signal,
    });
    if (!resp.ok || resp.status !== 200) throw new Error(`BNR HTTP ${resp.status}`);
    return parseBnrXml(await readCapped(resp));
  } finally {
    clearTimeout(timer);
  }
}

/** Ask BNR. Every address is tried in order; one that does not answer an
 *  acceptable feed is a failure and the next is tried. Among those that do,
 *  the newest Cube date wins (the first listed on a tie); an address that
 *  answers today's file ends the search. Throws when none answers. */
export async function fetchBnr(fetchFn: FeedFetch, now: Date): Promise<ParsedRates> {
  const today = todayInRomania(now);
  let best: ParsedRates | null = null;
  const problems: string[] = [];
  for (const url of BNR_URLS) {
    let got: ParsedRates;
    try {
      got = await readAddress(fetchFn, url);
      requireFresh(got.as_of, today);
    } catch (e) {
      problems.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (best === null || got.as_of > best.as_of) best = got;
    if (best.as_of >= today) break;
  }
  if (best === null) throw new Error(problems.join("; "));
  return best;
}

// ── When may BNR be asked? ──────────────────────────────────────────────

export type FetchDecision = "serve-cached" | "cooldown" | "fetch";

/** One decision per request, from three timestamps (epoch ms, 0 = never):
 *
 *   serve-cached  an accepted file younger than TTL_MS is cached and the
 *                 caller did not force — it is served, not stale.
 *   cooldown      BNR was asked less than FAILURE_COOLDOWN_MS ago (the
 *                 attempt failed, or it succeeded and the caller forces
 *                 again) — it is NOT asked; the answer is what is cached,
 *                 fresh only if the cached file is still inside its TTL.
 *   fetch         ask BNR.
 *
 *  `?refresh=true` skips the 24 h window, never the 5-minute one: the
 *  function is anonymous, and a parameter that reaches BNR on every call is
 *  a tap anyone can open. */
export function fetchDecision(at: {
  nowMs: number;
  /** when the cached file was accepted */
  fetchedAtMs: number;
  /** when BNR was last asked, successfully or not */
  lastAttemptMs: number;
  forceRefresh: boolean;
}): FetchDecision {
  const cachedIsFresh = at.fetchedAtMs > 0 && at.nowMs - at.fetchedAtMs < TTL_MS;
  if (cachedIsFresh && !at.forceRefresh) return "serve-cached";
  const lastAsked = Math.max(at.lastAttemptMs, at.fetchedAtMs);
  if (lastAsked > 0 && at.nowMs - lastAsked < FAILURE_COOLDOWN_MS) return "cooldown";
  return "fetch";
}

/** Is a cached file still inside its 24 h window at `nowMs`? */
export function cachedIsFresh(nowMs: number, fetchedAtMs: number): boolean {
  return fetchedAtMs > 0 && nowMs - fetchedAtMs < TTL_MS;
}

/** What is served when BNR is not asked, or did not answer: the cached file
 *  — marked stale unless it is still inside its own 24 h window — else the
 *  bundled fallback, always stale. Never a stale rate presented as current. */
export function payloadWithoutBnr(
  cached: Omit<RatesPayload, "stale"> | null,
  fetchedAtMs: number,
  now: Date,
): RatesPayload {
  if (cached) {
    return { ...cached, stale: !cachedIsFresh(now.getTime(), fetchedAtMs) };
  }
  return fallbackPayload(now.toISOString());
}

// ── One request, start to finish ────────────────────────────────────────
//
// The handler's whole decision, with its three effects (read the row, ask
// BNR, write the row) passed in — so the gate runs the SAME code the function
// serves with, on the row production holds today.

/** The `fx_rates_cache` row as PostgREST returns it. */
export interface CacheRow {
  base?: string;
  rates?: Partial<Rates> | null;
  source?: string;
  as_of?: string;
  fetched_at?: string;
  updated_at?: string | null;
}

export interface RatesStore {
  /** The single row, or null when there is none. May throw. */
  read(): Promise<CacheRow | null>;
  /** Store an accepted file: `fetched_at` and `updated_at` are both
   *  `payload.fetched_at`. May throw. */
  writeAccepted(payload: RatesPayload): Promise<void>;
  /** A FAILED attempt: set `updated_at` alone, leave the rate and its
   *  `fetched_at` as they are. May throw. */
  stampFailedAttempt(atIso: string): Promise<void>;
}

/** What one function instance remembers between requests — the cooldown and
 *  the last accepted file when the row cannot carry them (no row yet, the
 *  table unreadable or unwritable). */
export interface InstanceMemory {
  /** epoch ms of this instance's last attempt at BNR, 0 = none */
  lastAttemptMs: number;
  /** the last file this instance accepted from BNR */
  accepted: Omit<RatesPayload, "stale"> | null;
}

export function newInstanceMemory(): InstanceMemory {
  return { lastAttemptMs: 0, accepted: null };
}

function ms(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function usableRow(row: CacheRow | null): Omit<RatesPayload, "stale"> | null {
  const r = row?.rates;
  if (!row || !r) return null;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!ok(r.EUR) || !ok(r.RON) || !ok(r.USD)) return null;
  if (typeof row.source !== "string" || typeof row.as_of !== "string" || typeof row.fetched_at !== "string") {
    return null;
  }
  return {
    base: "EUR",
    rates: { EUR: r.EUR, RON: r.RON, USD: r.USD },
    source: row.source,
    as_of: row.as_of,
    fetched_at: row.fetched_at,
  };
}

/** The payload for one request. Never throws.
 *
 *   1. read the shared row (when it cannot be read, or this instance has
 *      accepted a newer file than it holds, the instance's own copy stands in);
 *   2. `fetchDecision` — serve it, hold the cooldown, or ask BNR;
 *   3. BNR answered an acceptable feed: store it, serve it, `stale: false`;
 *   4. BNR did not: remember the attempt (on the row when there is one — every
 *      instance sees it — and in this instance always), then serve what is
 *      cached marked stale, else the bundled fallback marked stale.
 *
 *  In every state one instance asks BNR at most once per FAILURE_COOLDOWN_MS,
 *  and at most once per TTL_MS unless forced. */
export async function resolveRates(deps: {
  store: RatesStore;
  fetchFn: FeedFetch;
  now: Date;
  forceRefresh: boolean;
  memory: InstanceMemory;
  warn?: (message: string, error?: unknown) => void;
}): Promise<RatesPayload> {
  const { store, fetchFn, now, forceRefresh, memory } = deps;
  const warn = deps.warn ?? (() => undefined);
  const nowMs = now.getTime();

  let row: CacheRow | null = null;
  try {
    row = await store.read();
  } catch (e) {
    // Table missing / unreadable — the request is answered without a cache.
    warn("[fx-rates] cache read failed", e);
  }
  const fromRow = usableRow(row);
  const rowAttemptMs = fromRow ? ms(row?.updated_at) : 0;
  // The row is the shared truth; this instance's own last accepted file
  // stands in only when it is the newer of the two (the row unreadable, or a
  // write that did not land).
  const cached =
    memory.accepted && (!fromRow || ms(memory.accepted.fetched_at) > ms(fromRow.fetched_at))
      ? memory.accepted
      : fromRow;
  const fetchedAtMs = cached ? ms(cached.fetched_at) : 0;

  const decision = fetchDecision({
    nowMs,
    fetchedAtMs,
    lastAttemptMs: Math.max(rowAttemptMs, memory.lastAttemptMs),
    forceRefresh,
  });
  if (decision !== "fetch") return payloadWithoutBnr(cached, fetchedAtMs, now);

  // Stamped BEFORE the fetch: a second request reaching this instance while
  // the first is still waiting on BNR holds the cooldown instead of asking.
  memory.lastAttemptMs = nowMs;
  let accepted: ParsedRates | null = null;
  try {
    accepted = await fetchBnr(fetchFn, now);
  } catch (e) {
    warn("[fx-rates] BNR did not answer the feed; serving the last accepted rate marked stale", e);
  }

  if (accepted) {
    const payload: RatesPayload = { ...accepted, fetched_at: now.toISOString(), stale: false };
    memory.accepted = { ...accepted, fetched_at: payload.fetched_at };
    try {
      await store.writeAccepted(payload);
    } catch (e) {
      // The rate BNR just answered is still served, and this instance
      // keeps it (memory.accepted) — a failed write costs other instances a
      // refetch, never this one a fetch per request.
      warn("[fx-rates] cache write failed", e);
    }
    return payload;
  }

  if (fromRow) {
    try {
      await store.stampFailedAttempt(now.toISOString());
    } catch (e) {
      warn("[fx-rates] could not stamp the failed attempt", e);
    }
  }
  return payloadWithoutBnr(cached, fetchedAtMs, now);
}
