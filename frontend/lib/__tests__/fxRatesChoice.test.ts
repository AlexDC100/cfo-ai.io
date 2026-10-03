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
// (payloads shaped exactly like the real ones): a function payload that is
// not a current BNR rate makes the browser ask the engine as well, and the
// engine's CURRENT rate is used; a current function payload costs no second
// request; with the engine unreachable or itself stale the function's payload
// is kept and stays MARKED STALE; with the function down the engine's is used
// as served; with neither, the last payload this browser held (stale once
// past its day), else the bundled fallback — stale. A held payload that is
// not current never spares the next attempt. Nothing that is not a current
// BNR rate is ever returned with `stale: false`.
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
  chooseRates,
  fetchRates,
  getInitialRates,
  isCurrentBnrRate,
  type RatesPayload,
} from "@/lib/rates";

const FUNCTION_URL = "https://test.supabase.co/functions/v1/fx-rates";
const ENGINE_URL = "http://api.test.invalid/api/fx-rates";
const CACHE_KEY = "cfo:fx-rates:v1";
const HOUR = 3_600_000;

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

/** The engine holding yesterday's file after BNR stopped answering it. */
const ENGINE_LAST_KNOWN: RatesPayload = { ...ENGINE_CURRENT, as_of: "2026-10-01", rates: { EUR: 1, RON: 5.3301, USD: 1.1201 }, stale: true };

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

  it("the engine is unreachable: the function's payload is kept, MARKED STALE, and the next call asks both again", async () => {
    for (const engineDown of ["network-error", { status: 502 }, { status: 404 }, { body: { detail: "Not Found" } }] as Reply[]) {
      localStorage.clear();
      const asked = wire({ fn: FUNCTION_AS_DEPLOYED, engine: engineDown });
      const got = await fetchRates();
      expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
      expect(got).toEqual(FUNCTION_AS_DEPLOYED);
      expect(got.stale).toBe(true);
      // held — and a held STALE payload never spares the next attempt
      expect(held()).toEqual(FUNCTION_AS_DEPLOYED);
      await fetchRates();
      expect(asked).toEqual([FUNCTION_URL, ENGINE_URL, FUNCTION_URL, ENGINE_URL]);
    }
  });

  it("the engine is itself stale — production's engine as it was, serving 4.97: the function's payload is kept, never 4.97, still stale", async () => {
    const asked = wire({ fn: FUNCTION_AS_DEPLOYED, engine: ENGINE_AS_DEPLOYED });
    const got = await fetchRates();
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
    expect(got).toEqual(FUNCTION_AS_DEPLOYED);
    expect([got.rates.RON, got.stale]).toEqual([5.2489, true]);
  });

  it("the engine holds a last-known rate after a failed refetch: stale too — the function's payload is kept, stale", async () => {
    wire({ fn: FUNCTION_AS_DEPLOYED, engine: ENGINE_LAST_KNOWN });
    const got = await fetchRates();
    expect([got.rates.RON, got.as_of, got.stale]).toEqual([5.2489, "2026-08-05", true]);
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
    const fnNewer: RatesPayload = { ...FUNCTION_CURRENT, as_of: "2026-10-02", stale: true };
    const engineOlder: RatesPayload = { ...ENGINE_CURRENT, as_of: "2026-10-01", rates: { EUR: 1, RON: 5.3301, USD: 1.1201 } };
    wire({ fn: fnNewer, engine: engineOlder });
    const got = await fetchRates();
    expect([got.as_of, got.rates.RON, got.stale]).toEqual(["2026-10-02", 5.3447, true]);
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

  it("the function is down and the engine is stale: the engine's payload as served — stale", async () => {
    wire({ fn: "network-error", engine: ENGINE_LAST_KNOWN });
    const got = await fetchRates();
    expect(got).toEqual(ENGINE_LAST_KNOWN);
    expect(got.stale).toBe(true);
  });

  it("a function that never answers is abandoned after eight seconds and the engine is asked", async () => {
    vi.useFakeTimers();
    const asked = wire({ fn: "hang", engine: ENGINE_CURRENT });
    const pending = fetchRates();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(asked).toEqual([FUNCTION_URL]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(ENGINE_CURRENT);
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
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
  const stale = (p: RatesPayload): RatesPayload => ({ ...p, stale: true });

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

  it("is a current BNR rate: source BNR and stale exactly false, nothing else", () => {
    expect(isCurrentBnrRate(ENGINE_CURRENT)).toBe(true);
    expect(isCurrentBnrRate(FUNCTION_AS_DEPLOYED)).toBe(false);
    expect(isCurrentBnrRate(ENGINE_AS_DEPLOYED)).toBe(false);
    expect(isCurrentBnrRate({ ...ENGINE_CURRENT, source: "fallback" })).toBe(false);
    expect(isCurrentBnrRate(null)).toBe(false);
  });

  it("whatever the two sources answer, nothing but a current BNR rate is ever returned with stale false", () => {
    const shapes: Array<RatesPayload | null> = [
      null,
      FUNCTION_AS_DEPLOYED,
      FUNCTION_CURRENT,
      ENGINE_AS_DEPLOYED,
      ENGINE_CURRENT,
      ENGINE_LAST_KNOWN,
      stale(current("2026-10-09", 5.4)),
      { ...ENGINE_AS_DEPLOYED, stale: false },                       // a fallback that forgot to say so
      { ...ENGINE_CURRENT, source: "ECB" } as unknown as RatesPayload, // a source this app does not know
      { ...ENGINE_CURRENT, stale: undefined } as unknown as RatesPayload,
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
          expect(got === fn || got === engine).toBe(true); // returned as served, not rewritten
        } else {
          expect(got.stale).toBe(true);
        }
        // a current rate is on the table: what is shown is never older than it
        const best = [fn, engine].filter(isCurrentBnrRate).map((p) => p.as_of).sort().pop();
        if (best) expect(got.as_of >= best, JSON.stringify([fn, engine])).toBe(true);
      }
    }
    expect(pairs).toBe(100);
  });
});
