// fx-browser, the BROWSER's half — which exchange rate `lib/rates.ts` shows
// when its two sources disagree.
//
// INCIDENT (measured on production, 2026-10-03). The browser asks the
// Supabase Edge Function `fx-rates`, not the engine. BNR had moved its feed;
// the deployed function served its last cached row, marked stale:
//
//   {"rates":{"EUR":1,"RON":5.2489,"USD":1.1541116974494283},"source":"BNR",
//    "as_of":"2026-08-05","fetched_at":"2026-08-05T11:09:17.271+00:00","stale":true}
//
// and `fetchRates` used it — for two months every EUR amount was shown 1.8%
// too high and every USD amount 4.5% (BNR's file of 2026-10-02: 5.3447 RON
// per EUR, 4.7519 RON per USD). The engine endpoint, which nothing in the
// browser read, was serving the bundled 4.97 fallback over the same days.
//
// LAW. Through `fetchRates` with the two addresses answered by this file
// (payloads shaped exactly like the real ones), on a pinned clock: a function
// payload that is not a current BNR rate makes the browser ask the engine as
// well, and the engine's CURRENT rate is used; a current function payload
// costs no second request; "current" is `source: BNR`, `stale: false` AND a
// publication date at most ten days old and not in the future — a label is
// not trusted against its date; when nothing is current the NEWER publication
// is kept, MARKED STALE; with neither answering, what this browser holds
// (stale once past its day), else the bundled fallback — stale. What the
// browser holds changes only for something better: a stale answer never
// replaces a current rate, nor an older figure a newer one (the bundled
// fallback included). A held payload that is not current never spares the
// next attempt. Each request is abandoned after eight seconds on its own.
// Nothing that is not a current BNR rate is ever returned with `stale: false`.
//
// What it cannot see: what the deployed function and the deployed engine
// answer (this file answers for both); the UI's stale marker; amounts already
// stored at the old rate (chat answers, downloaded exports).
// Plant log: docs/engine_book/gates.md, "fx-browser".

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FALLBACK_PAYLOAD,
  MAX_AGE_DAYS,
  chooseRates,
  fetchRates,
  getInitialRates,
  isCurrentBnrRate,
  preferHeld,
  todayInRomania,
  type HeldRates,
  type RatesPayload,
} from "@/lib/rates";

const FUNCTION_URL = "https://test.supabase.co/functions/v1/fx-rates";
const ENGINE_URL = "http://api.test.invalid/api/fx-rates";
const CACHE_KEY = "cfo:fx-rates:v1";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The clock every test runs on: Saturday 3 October 2026, 20:00 in Romania —
 *  the day of the incident, the day after BNR's committed file. "Current"
 *  reads the publication date against the clock, so the clock is pinned. */
const NOW = Date.parse("2026-10-03T17:00:00Z");

// BNR's own figures, read out of the committed file by a regex.
const REAL = readFileSync(resolve(process.cwd(), "tests/engine/fixtures/fx/nbrfxrates_REAL_curs_bnr_ro.xml"), "utf8");
const inFile = (cur: string) => Number(REAL.match(new RegExp(`<Rate currency="${cur}">([0-9.]+)</Rate>`))![1]);
const EUR = inFile("EUR"); // 5.3447 RON per EUR
const USD = inFile("USD"); // 4.7519 RON per USD

/** The DEPLOYED function's answer on 2026-10-03 — measured, verbatim. */
const FUNCTION_AS_DEPLOYED = JSON.parse(
  '{"rates":{"EUR":1,"RON":5.2489,"USD":1.1541116974494283},"source":"BNR",' +
    '"as_of":"2026-08-05","fetched_at":"2026-08-05T11:09:17.271+00:00","stale":true}',
) as RatesPayload;

/** The function after its redeploy: BNR's file of 2026-10-02, accepted today. */
const FUNCTION_CURRENT: RatesPayload = {
  base: "EUR",
  rates: { EUR: 1, RON: EUR, USD: EUR / USD },
  source: "BNR",
  as_of: "2026-10-02",
  fetched_at: "2026-10-03T16:40:02.118Z",
  stale: false,
};

/** The ENGINE's answer on production on 2026-10-03, before this release —
 *  measured: the bundled fallback of the time. */
const ENGINE_AS_DEPLOYED: RatesPayload = {
  base: "EUR",
  rates: { EUR: 1.0, RON: 4.97, USD: 1.08 },
  source: "fallback",
  as_of: "2026-05-01",
  fetched_at: "2026-10-03T05:12:44+00:00",
  stale: true,
};

/** The engine with this release: BNR's file of 2026-10-02 from curs.bnr.ro. */
const ENGINE_CURRENT: RatesPayload = {
  base: "EUR",
  rates: { EUR: 1.0, RON: EUR, USD: EUR / USD },
  source: "BNR",
  as_of: "2026-10-02",
  fetched_at: "2026-10-03T06:32:11+00:00",
  stale: false,
};

/** The engine holding the file of 1 October after BNR stopped answering it
 *  (constructed for this law — not BNR's figures). */
const ENGINE_LAST_KNOWN: RatesPayload = { ...ENGINE_CURRENT, as_of: "2026-10-01", rates: { EUR: 1, RON: 5.3301, USD: 1.1201 }, stale: true };

/** A function row of TODAY's date that the function itself marks stale —
 *  published after the bundled fallback (constructed for this law). */
const FUNCTION_STALE_TODAY: RatesPayload = { ...FUNCTION_CURRENT, as_of: "2026-10-03", rates: { EUR: 1, RON: 5.3502, USD: 1.1262 }, stale: true };

/** The bundled fallback as `fetchRates` returns it (its `fetched_at` is the
 *  moment the module loaded). */
const fallbackShown = () => ({ RON: FALLBACK_PAYLOAD.rates.RON, as_of: FALLBACK_PAYLOAD.as_of, source: FALLBACK_PAYLOAD.source, stale: FALLBACK_PAYLOAD.stale });
const shown = (p: RatesPayload) => ({ RON: p.rates.RON, as_of: p.as_of, source: p.source, stale: p.stale });

type Reply = RatesPayload | "network-error" | "hang" | { status: number } | { body: unknown };

/** Answer the two addresses; every request is recorded. */
function wire(replies: { fn: Reply; engine: Reply }) {
  const asked: string[] = [];
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    asked.push(url);
    const reply = url.startsWith(FUNCTION_URL) ? replies.fn : url.startsWith(ENGINE_URL) ? replies.engine : null;
    if (reply === null) return Promise.reject(new Error(`a request to an address this law does not know: ${url}`));
    if (reply === "network-error") return Promise.reject(new TypeError("Failed to fetch"));
    if (reply === "hang") {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if ("status" in reply && typeof reply.status === "number") {
      return Promise.resolve({ ok: false, status: reply.status, json: async () => ({}) } as Response);
    }
    const body = "body" in reply ? reply.body : reply;
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  });
  vi.stubGlobal("fetch", mock);
  return asked;
}

function hold(payload: RatesPayload, ageMs: number) {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ payload, cached_at: Date.now() - ageMs }));
}
const held = () => JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null")?.payload ?? null;

beforeEach(() => {
  localStorage.clear();
  // The DATE alone is replaced: the requests' own timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

// ════════════════════════════════════════════════════════════════════════
describe("fx browser · the function is not current, so the engine is asked as well", () => {
  it("production on 2026-10-03, with this release: the function's August row is stale, the engine has BNR's file of 2 October — the engine's rate is shown, as current", async () => {
    const asked = wire({ fn: FUNCTION_AS_DEPLOYED, engine: ENGINE_CURRENT });

    const got = await fetchRates();

    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
    expect(got).toEqual(ENGINE_CURRENT);
    expect([got.rates.RON, got.as_of, got.source, got.stale]).toEqual([5.3447, "2026-10-02", "BNR", false]);
    // 1,000 EUR of RON: 5,344.70 at BNR's rate — it was shown as 5,248.90
    expect(got.rates.RON / FUNCTION_AS_DEPLOYED.rates.RON).toBeCloseTo(1.01825, 5);
    // the browser keeps what was chosen, and inside its day it spares both requests
    expect(held()).toEqual(ENGINE_CURRENT);
    expect(await fetchRates()).toEqual(ENGINE_CURRENT);
    expect(asked).toHaveLength(2);
  });

  it("the function says source 'fallback': that is not a current rate either — the engine's is used", async () => {
    const fnFallback: RatesPayload = { ...FALLBACK_PAYLOAD, fetched_at: "2026-10-03T16:00:00.000Z" };
    const asked = wire({ fn: fnFallback, engine: ENGINE_CURRENT });
    expect(await fetchRates()).toEqual(ENGINE_CURRENT);
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
  });

  it("the engine is unreachable and the function's row is newer than anything held: it is kept, MARKED STALE, and the next call asks both again", async () => {
    for (const engineDown of ["network-error", { status: 502 }, { status: 404 }, { body: { detail: "Not Found" } }] as Reply[]) {
      localStorage.clear();
      const asked = wire({ fn: FUNCTION_STALE_TODAY, engine: engineDown });
      const got = await fetchRates();
      expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
      expect(got).toEqual(FUNCTION_STALE_TODAY);
      expect(got.stale).toBe(true);
      // held — and a held STALE payload never spares the next attempt
      expect(held()).toEqual(FUNCTION_STALE_TODAY);
      await fetchRates();
      expect(asked).toEqual([FUNCTION_URL, ENGINE_URL, FUNCTION_URL, ENGINE_URL]);
    }
  });

  it("production on 2026-10-03 with the engine unreachable: the function's August row is OLDER than the bundled fallback — the fallback is shown, marked stale, and nothing is stored", async () => {
    const asked = wire({ fn: FUNCTION_AS_DEPLOYED, engine: "network-error" });
    const got = await fetchRates();
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
    // BNR's file of 2 October (bundled), not the row of 5 August — both stale
    expect(shown(got)).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "fallback", stale: true });
    expect(held()).toBeNull(); // the fallback is never stored as if a source had answered
    await fetchRates();
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL, FUNCTION_URL, ENGINE_URL]);
  });

  it("the engine is itself stale — production's engine as it was, serving 4.97 as of May: never 4.97, never shown as current", async () => {
    const asked = wire({ fn: FUNCTION_AS_DEPLOYED, engine: ENGINE_AS_DEPLOYED });
    const got = await fetchRates();
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
    // of the two answers the function's is the newer (5 August against 1 May)…
    expect(chooseRates(FUNCTION_AS_DEPLOYED, ENGINE_AS_DEPLOYED)).toEqual(FUNCTION_AS_DEPLOYED);
    // …and the bundled fallback is newer than both
    expect(shown(got)).toEqual(fallbackShown());
    expect([got.rates.RON, got.stale]).toEqual([5.3447, true]);

    // a browser that already holds the August row (every browser that opened
    // the app before this release) keeps it: 4.97 of May never replaces it
    hold(FUNCTION_AS_DEPLOYED, 5 * 60_000);
    wire({ fn: "network-error", engine: ENGINE_AS_DEPLOYED });
    expect(await fetchRates()).toEqual(FUNCTION_AS_DEPLOYED);
    expect(held()).toEqual(FUNCTION_AS_DEPLOYED);
  });

  it("nothing is current: of two stale answers the NEWER publication is kept, marked stale — the engine's last-known rate of 1 October, not the function's row of 5 August", async () => {
    hold(FUNCTION_AS_DEPLOYED, 5 * 60_000); // what this browser held before the release
    const asked = wire({ fn: FUNCTION_AS_DEPLOYED, engine: ENGINE_LAST_KNOWN });
    const got = await fetchRates();
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
    expect(got).toEqual(ENGINE_LAST_KNOWN);
    expect([got.rates.RON, got.as_of, got.stale]).toEqual([5.3301, "2026-10-01", true]);
    expect(held()).toEqual(ENGINE_LAST_KNOWN);
    // the other way round: the function's row is the newer one
    expect(chooseRates(FUNCTION_STALE_TODAY, ENGINE_LAST_KNOWN)).toEqual(FUNCTION_STALE_TODAY);
    // on the same date the function's is kept
    const sameDay: RatesPayload = { ...ENGINE_LAST_KNOWN, as_of: "2026-10-03" };
    expect(chooseRates(FUNCTION_STALE_TODAY, sameDay)).toEqual(FUNCTION_STALE_TODAY);
  });

  it("this release with the engine unable to read BNR: it answers its bundled fallback, the function its August row — BNR's file of 2 October is shown, marked stale", async () => {
    // the engine's fallback payload after this release: source fallback, as_of 2026-10-02
    const engineFallback: RatesPayload = { ...FALLBACK_PAYLOAD, fetched_at: "2026-10-03T16:59:00+00:00" };
    hold(FUNCTION_AS_DEPLOYED, 5 * 60_000);
    wire({ fn: FUNCTION_AS_DEPLOYED, engine: engineFallback });
    const got = await fetchRates();
    expect(got).toEqual(engineFallback);
    expect(shown(got)).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "fallback", stale: true });
    expect(held()).toEqual(engineFallback);
  });

  it("a function payload that omits `stale`, or says stale with any other word, is not trusted as current", async () => {
    for (const odd of [undefined, "false", 0, null]) {
      localStorage.clear();
      const fn = { ...FUNCTION_AS_DEPLOYED, stale: odd } as unknown as RatesPayload;
      const asked = wire({ fn, engine: "network-error" });
      const got = await fetchRates();
      expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
      expect(got.stale, String(odd)).toBe(true);
    }
  });

  it("the function's stale rate was published AFTER the engine's current one: the newer publication is kept, marked stale", async () => {
    wire({ fn: FUNCTION_STALE_TODAY, engine: ENGINE_CURRENT });
    const got = await fetchRates();
    expect([got.as_of, got.rates.RON, got.stale]).toEqual(["2026-10-03", 5.3502, true]);
    expect(held()).toEqual(FUNCTION_STALE_TODAY);
  });

  it("a function payload newer than the engine's current rate that does NOT say it is stale is still returned marked stale", () => {
    // the shape one evasion of the review left unmarked: source BNR, a newer
    // as_of, `stale` missing — not current, so the engine was asked; kept as
    // the newer publication; and it must not leave the choice unmarked
    for (const odd of [undefined, null, "false", 0]) {
      const fn = { ...FUNCTION_STALE_TODAY, stale: odd } as unknown as RatesPayload;
      const got = chooseRates(fn, ENGINE_CURRENT)!;
      expect([got.as_of, got.rates.RON], String(odd)).toEqual(["2026-10-03", 5.3502]);
      expect(got.stale, String(odd)).toBe(true);
    }
  });

  it("a function payload LABELLED current but published two months ago — a row touched by hand — is not current: the engine is asked and its rate is used", async () => {
    // measured on the function under Deno: as_of 2026-08-05 with a fetched_at
    // one hour old was answered `stale: false`
    const touched: RatesPayload = { ...FUNCTION_AS_DEPLOYED, fetched_at: "2026-10-03T16:00:00.000Z", stale: false };
    const asked = wire({ fn: touched, engine: ENGINE_CURRENT });
    expect(await fetchRates()).toEqual(ENGINE_CURRENT);
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);

    // …and with the engine down it is shown only as what it is: stale
    localStorage.clear();
    wire({ fn: touched, engine: "network-error" });
    const got = await fetchRates();
    expect(got.stale).toBe(true);
    expect(chooseRates(touched, null)).toEqual({ ...touched, stale: true });
  });

  it("the same publication on both, the function's marked stale: the engine's is shown, as current", async () => {
    wire({ fn: { ...FUNCTION_CURRENT, stale: true }, engine: ENGINE_CURRENT });
    const got = await fetchRates();
    expect(got).toEqual(ENGINE_CURRENT);
    expect(got.stale).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx browser · the function is current, so nothing else is asked", () => {
  it("a current function payload is used and costs no second request — the engine may be stopped", async () => {
    const asked = wire({ fn: FUNCTION_CURRENT, engine: "network-error" });
    const got = await fetchRates();
    expect(asked).toEqual([FUNCTION_URL]);
    expect(got).toEqual(FUNCTION_CURRENT);
    expect(held()).toEqual(FUNCTION_CURRENT);
  });

  it("a forced refresh asks the function with ?refresh=true and never passes the parameter to the engine", async () => {
    hold(FUNCTION_CURRENT, HOUR);
    let asked = wire({ fn: FUNCTION_CURRENT, engine: ENGINE_CURRENT });
    await fetchRates({ forceRefresh: true });
    expect(asked).toEqual([`${FUNCTION_URL}?refresh=true`]);

    asked = wire({ fn: FUNCTION_AS_DEPLOYED, engine: ENGINE_CURRENT });
    await fetchRates({ forceRefresh: true });
    expect(asked).toEqual([`${FUNCTION_URL}?refresh=true`, ENGINE_URL]);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx browser · the function does not answer", () => {
  it.each([
    ["a network error", "network-error"],
    ["a 500", { status: 500 }],
    ["a body that is not rates", { body: { message: "Function not found" } }],
    ["a body with a zero rate", { body: { ...FUNCTION_CURRENT, rates: { EUR: 1, RON: 0, USD: 1.12 } } }],
  ] as Array<[string, Reply]>)("%s from the function: the engine's current rate is used", async (_name, fnReply) => {
    const asked = wire({ fn: fnReply, engine: ENGINE_CURRENT });
    expect(await fetchRates()).toEqual(ENGINE_CURRENT);
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
  });

  it("the function is down and the engine is stale: the engine's payload as served — stale — unless what the browser holds is newer", async () => {
    hold(FUNCTION_AS_DEPLOYED, 5 * 60_000);
    wire({ fn: "network-error", engine: ENGINE_LAST_KNOWN });
    const got = await fetchRates();
    expect(got).toEqual(ENGINE_LAST_KNOWN);
    expect(got.stale).toBe(true);

    // nothing held: the bundled fallback (2 October) is newer than the
    // engine's last-known rate (1 October)
    localStorage.clear();
    wire({ fn: "network-error", engine: ENGINE_LAST_KNOWN });
    expect(shown(await fetchRates())).toEqual(fallbackShown());
    expect(held()).toBeNull();
  });

  it("a function that never answers is abandoned after eight seconds and the engine is asked", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const asked = wire({ fn: "hang", engine: ENGINE_CURRENT });
    const pending = fetchRates();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(asked).toEqual([FUNCTION_URL]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(ENGINE_CURRENT);
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
  });

  it("an ENGINE that never answers is abandoned after eight seconds of its own: the attempt ends, with what the function answered marked stale", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const asked = wire({ fn: FUNCTION_STALE_TODAY, engine: "hang" });
    let settled: RatesPayload | null = null;
    const pending = fetchRates().then((p) => (settled = p));
    await vi.advanceTimersByTimeAsync(7_999);
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
    expect(settled).toBeNull(); // still waiting on the engine
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toEqual(FUNCTION_STALE_TODAY);

    // both hang: sixteen seconds, eight each — not eight in all, not for ever
    localStorage.clear();
    const both = wire({ fn: "hang", engine: "hang" });
    settled = null;
    const second = fetchRates().then((p) => (settled = p));
    await vi.advanceTimersByTimeAsync(15_999);
    expect(both).toEqual([FUNCTION_URL, ENGINE_URL]);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(shown(settled!)).toEqual(fallbackShown());
  });

  it("Supabase is not configured in the build: the engine alone is asked", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.resetModules();
    const unconfigured = await import("@/lib/rates");
    const asked = wire({ fn: FUNCTION_CURRENT, engine: ENGINE_CURRENT });
    expect(await unconfigured.fetchRates()).toEqual(ENGINE_CURRENT);
    expect(asked).toEqual([ENGINE_URL]);
    vi.resetModules();
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx browser · neither source answers", () => {
  it("nothing held: the bundled fallback — BNR's file of 2026-10-02 — marked stale", async () => {
    const asked = wire({ fn: "network-error", engine: "network-error" });
    const got = await fetchRates();
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
    expect([got.source, got.stale, got.as_of]).toEqual(["fallback", true, "2026-10-02"]);
    expect(got.rates).toEqual({ EUR: 1, RON: EUR, USD: EUR / USD });
    expect(held()).toBeNull(); // the fallback is never stored as if a source had answered
  });

  it("a current rate held for 25 hours: it is shown — marked stale, it is no longer today's", async () => {
    hold(ENGINE_CURRENT, 25 * HOUR);
    wire({ fn: "network-error", engine: { status: 503 } });
    const got = await fetchRates();
    expect(got).toEqual({ ...ENGINE_CURRENT, stale: true });
  });

  it("a stale payload held: shown, still stale", async () => {
    hold(FUNCTION_AS_DEPLOYED, 5 * 60_000);
    wire({ fn: "network-error", engine: "network-error" });
    expect(await fetchRates()).toEqual(FUNCTION_AS_DEPLOYED);
  });

  it("a forced refresh that fails inside the held rate's day keeps it as it is", async () => {
    hold(FUNCTION_CURRENT, 2 * HOUR);
    wire({ fn: "network-error", engine: "network-error" });
    expect(await fetchRates({ forceRefresh: true })).toEqual(FUNCTION_CURRENT);
  });

  it("a forced refresh answered only by STALE sources inside the held rate's day keeps the current rate — a stale answer never replaces it", async () => {
    hold(FUNCTION_CURRENT, 2 * HOUR);
    const asked = wire({ fn: FUNCTION_STALE_TODAY, engine: ENGINE_LAST_KNOWN });
    const got = await fetchRates({ forceRefresh: true });
    expect(asked).toEqual([`${FUNCTION_URL}?refresh=true`, ENGINE_URL]);
    expect(got).toEqual(FUNCTION_CURRENT);
    expect(got.stale).toBe(false);
    expect(held()).toEqual(FUNCTION_CURRENT);
  });

  it("a rate held past its day is not replaced by an OLDER stale answer: yesterday's figure stays, marked stale", async () => {
    hold(ENGINE_CURRENT, 25 * HOUR);
    wire({ fn: FUNCTION_AS_DEPLOYED, engine: "network-error" });
    const got = await fetchRates();
    expect(got).toEqual({ ...ENGINE_CURRENT, stale: true });
    expect(held()).toEqual(ENGINE_CURRENT); // the record is left as it was

    // …and IS replaced by a stale answer published after it
    wire({ fn: FUNCTION_STALE_TODAY, engine: "network-error" });
    expect(await fetchRates()).toEqual(FUNCTION_STALE_TODAY);
    expect(held()).toEqual(FUNCTION_STALE_TODAY);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx browser · what the browser holds", () => {
  it("a current rate held for less than a day spares both requests; past its day it does not", async () => {
    hold(ENGINE_CURRENT, 23 * HOUR);
    let asked = wire({ fn: FUNCTION_CURRENT, engine: ENGINE_CURRENT });
    expect(await fetchRates()).toEqual(ENGINE_CURRENT);
    expect(asked).toEqual([]);

    hold(ENGINE_CURRENT, 24 * HOUR + 1_000);
    asked = wire({ fn: FUNCTION_CURRENT, engine: ENGINE_CURRENT });
    expect(await fetchRates()).toEqual(FUNCTION_CURRENT);
    expect(asked).toEqual([FUNCTION_URL]);
  });

  it("a held payload that is not a current BNR rate never spares the next attempt — not for a day, not for a minute", async () => {
    // what every browser that opened the app before this release holds today
    for (const stale of [FUNCTION_AS_DEPLOYED, ENGINE_AS_DEPLOYED, { ...FALLBACK_PAYLOAD }]) {
      hold(stale, 60_000);
      const asked = wire({ fn: FUNCTION_AS_DEPLOYED, engine: ENGINE_CURRENT });
      const got = await fetchRates();
      expect(asked, stale.as_of).toEqual([FUNCTION_URL, ENGINE_URL]);
      expect(got).toEqual(ENGINE_CURRENT);
    }
  });

  it("a held record stamped in the future (a clock set back) is not trusted as current", async () => {
    hold(ENGINE_CURRENT, -2 * HOUR);
    const asked = wire({ fn: FUNCTION_CURRENT, engine: ENGINE_CURRENT });
    await fetchRates();
    expect(asked).toEqual([FUNCTION_URL]);
    hold(ENGINE_CURRENT, -2 * HOUR);
    expect(getInitialRates().stale).toBe(true);
  });

  it("first paint: the held rate while it is current, marked stale once past its day, the bundled fallback when nothing is held", () => {
    expect(getInitialRates()).toBe(FALLBACK_PAYLOAD);
    expect([FALLBACK_PAYLOAD.stale, FALLBACK_PAYLOAD.source, FALLBACK_PAYLOAD.rates.RON]).toEqual([true, "fallback", EUR]);

    hold(ENGINE_CURRENT, 2 * HOUR);
    expect(getInitialRates()).toEqual(ENGINE_CURRENT);

    hold(ENGINE_CURRENT, 30 * HOUR);
    expect(getInitialRates()).toEqual({ ...ENGINE_CURRENT, stale: true });

    hold(FUNCTION_AS_DEPLOYED, 2 * HOUR);
    expect(getInitialRates()).toEqual(FUNCTION_AS_DEPLOYED);

    localStorage.setItem(CACHE_KEY, "{not json");
    expect(getInitialRates()).toBe(FALLBACK_PAYLOAD);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx browser · the choice itself", () => {
  const current = (as_of: string, RON: number): RatesPayload => ({ ...ENGINE_CURRENT, as_of, rates: { EUR: 1, RON, USD: 1.12 } });

  it("neither answered: there is nothing to choose", () => {
    expect(chooseRates(null, null)).toBeNull();
  });

  it("both current: the newer publication wins, the function's on a tie", () => {
    const fn = current("2026-10-02", 5.1);
    expect(chooseRates(fn, current("2026-10-01", 5.2))).toBe(fn);
    expect(chooseRates(fn, current("2026-10-02", 5.2))).toBe(fn);
    const engine = current("2026-10-03", 5.2);
    expect(chooseRates(fn, engine)).toBe(engine);
  });

  it("is a current BNR rate: source BNR, stale exactly false, and published within ten days — never after today", () => {
    expect(isCurrentBnrRate(ENGINE_CURRENT)).toBe(true);
    expect(isCurrentBnrRate(FUNCTION_AS_DEPLOYED)).toBe(false);
    expect(isCurrentBnrRate(ENGINE_AS_DEPLOYED)).toBe(false);
    expect(isCurrentBnrRate({ ...ENGINE_CURRENT, source: "fallback" })).toBe(false);
    expect(isCurrentBnrRate(null)).toBe(false);

    // the publication date against the clock — the sources' own rule
    expect(MAX_AGE_DAYS).toBe(10);
    expect(todayInRomania(NOW)).toBe("2026-10-03");
    const labelled = (as_of: unknown) => ({ ...ENGINE_CURRENT, as_of }) as RatesPayload;
    expect(isCurrentBnrRate(labelled("2026-10-03"))).toBe(true); // today's file
    expect(isCurrentBnrRate(labelled("2026-09-23"))).toBe(true); // exactly ten days
    expect(isCurrentBnrRate(labelled("2026-09-22"))).toBe(false); // eleven
    expect(isCurrentBnrRate(labelled("2026-08-05"))).toBe(false); // the row production held
    expect(isCurrentBnrRate(labelled("2026-10-04"))).toBe(false); // tomorrow
    for (const notADate of ["", "02.10.2026", "2026-13-45", "2026-02-31", undefined, null, 20261002]) {
      expect(isCurrentBnrRate(labelled(notADate)), String(notADate)).toBe(false);
    }
    // the SAME payload stops being current as the clock moves
    expect(isCurrentBnrRate(ENGINE_CURRENT, NOW + 9 * DAY)).toBe(true); // 12 October: ten days
    expect(isCurrentBnrRate(ENGINE_CURRENT, NOW + 10 * DAY)).toBe(false); // 13 October: eleven
    expect(isCurrentBnrRate(ENGINE_CURRENT, NOW - 2 * DAY)).toBe(false); // 1 October: not published yet
    // Romania's date, not UTC's: 21:00 UTC is already the next day there
    expect(todayInRomania(Date.parse("2026-10-03T20:59:59Z"))).toBe("2026-10-03");
    expect(todayInRomania(Date.parse("2026-10-03T21:00:00Z"))).toBe("2026-10-04");
  });

  it("whatever the two sources answer, nothing but a current BNR rate is ever returned with stale false", () => {
    const shapes: Array<RatesPayload | null> = [
      null,
      FUNCTION_AS_DEPLOYED,
      FUNCTION_CURRENT,
      ENGINE_AS_DEPLOYED,
      ENGINE_CURRENT,
      ENGINE_LAST_KNOWN,
      FUNCTION_STALE_TODAY,
      { ...ENGINE_AS_DEPLOYED, stale: false },                       // a fallback that forgot to say so
      { ...ENGINE_CURRENT, source: "ECB" } as unknown as RatesPayload, // a source this app does not know
      { ...ENGINE_CURRENT, stale: undefined } as unknown as RatesPayload,
      { ...FUNCTION_AS_DEPLOYED, stale: false },                     // labelled current, published two months ago
      { ...ENGINE_CURRENT, as_of: "2026-10-09" },                    // labelled current, dated next week
      { ...ENGINE_CURRENT, as_of: "soon" },                          // labelled current, no date at all
    ];
    let pairs = 0;
    for (const fn of shapes) {
      for (const engine of shapes) {
        const got = chooseRates(fn, engine);
        pairs += 1;
        if (got === null) {
          expect(fn === null && engine === null).toBe(true);
          continue;
        }
        if (got.stale === false) {
          expect(got.source, JSON.stringify([fn, engine])).toBe("BNR");
          expect(isCurrentBnrRate(got), JSON.stringify([fn, engine])).toBe(true);
          expect(got === fn || got === engine).toBe(true); // returned as served, not rewritten
        } else {
          expect(got.stale).toBe(true);
        }
        // a current rate is on the table: what is shown is never older than it
        const best = [fn, engine].filter((p) => isCurrentBnrRate(p)).map((p) => p!.as_of).sort().pop();
        if (best) expect(got.as_of >= best, JSON.stringify([fn, engine])).toBe(true);
        // a date that is not one, or is in the future, never wins against a real one
        const real = [fn, engine].filter((p) => p && /^2026-(05|08|10)-0[1-5]$/.test(p.as_of));
        if (real.length) expect(/^2026-(05|08|10)-0[1-5]$/.test(got.as_of), JSON.stringify([fn, engine])).toBe(true);
      }
    }
    expect(pairs).toBe(169);
  });

  it("what the browser holds changes only for something better", () => {
    const at = (payload: RatesPayload, ageMs: number): HeldRates => ({ payload, cached_at: NOW - ageMs });
    const nothingHeld: HeldRates = { payload: FALLBACK_PAYLOAD, cached_at: 0 };
    const answered = (payload: RatesPayload) => at(payload, 0);
    const kept = (own: HeldRates, next: HeldRates) => (preferHeld(own, next, NOW) === next ? "next" : "own");

    // a current rate is always taken — over nothing, over a stale record, over another current one
    expect(kept(nothingHeld, answered(ENGINE_CURRENT))).toBe("next");
    expect(kept(at(FUNCTION_AS_DEPLOYED, HOUR), answered(ENGINE_CURRENT))).toBe("next");
    expect(kept(at(FUNCTION_CURRENT, HOUR), answered(ENGINE_CURRENT))).toBe("next");
    // a stale answer never replaces a current rate — not even one published after it
    expect(kept(at(FUNCTION_CURRENT, HOUR), answered(FUNCTION_AS_DEPLOYED))).toBe("own");
    expect(kept(at(FUNCTION_CURRENT, HOUR), answered(FUNCTION_STALE_TODAY))).toBe("own");
    // neither is current: the one published later, the held one on a tie
    expect(kept(at(ENGINE_CURRENT, 25 * HOUR), answered(FUNCTION_AS_DEPLOYED))).toBe("own");
    expect(kept(at(ENGINE_CURRENT, 25 * HOUR), answered(FUNCTION_STALE_TODAY))).toBe("next");
    expect(kept(at(ENGINE_CURRENT, 25 * HOUR), answered({ ...FUNCTION_CURRENT, stale: true }))).toBe("own");
    expect(kept(at(FUNCTION_AS_DEPLOYED, HOUR), answered(ENGINE_LAST_KNOWN))).toBe("next");
    // nothing held is the bundled fallback, BNR's file of 2 October
    expect(kept(nothingHeld, answered(FUNCTION_AS_DEPLOYED))).toBe("own");
    expect(kept(nothingHeld, answered(ENGINE_LAST_KNOWN))).toBe("own");
    expect(kept(nothingHeld, answered(FUNCTION_STALE_TODAY))).toBe("next");
    // an answer dated in the future, or with no date, never displaces a real one
    expect(kept(at(FUNCTION_AS_DEPLOYED, HOUR), answered({ ...ENGINE_LAST_KNOWN, as_of: "2026-10-09" }))).toBe("own");
    expect(kept(at(FUNCTION_AS_DEPLOYED, HOUR), answered({ ...ENGINE_LAST_KNOWN, as_of: "soon" }))).toBe("own");
    // a held record stamped in the future (a clock set back) is not current: a current answer replaces it
    expect(kept(at(ENGINE_CURRENT, -2 * HOUR), answered(FUNCTION_CURRENT))).toBe("next");
  });
});
