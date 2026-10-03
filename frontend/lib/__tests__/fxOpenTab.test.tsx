// fx-browser, the OPEN TAB's half — what `stores/currency.tsx` shows and asks
// for as long as it stays mounted.
//
// DEFECT (review of fix/fx-bnr-feed, 2026-10-03; the same on main). The
// provider fetched the rates once, in a mount-only effect, and nothing in the
// app asked again. Measured through the real provider on a fake clock: mounted
// 2026-10-05 07:00Z with the function stale and the engine current -> RON
// 5.3447, as_of 2026-10-02, stale false, 2 requests; 96 hours later, after
// focus + visibilitychange + online events -> the same rate, still `stale:
// false`, still 2 requests. The rule that a rate held for more than a day "is
// no longer today's" (fxRatesChoice.test.ts) was applied to the localStorage
// copy at load and never to the copy held in React state — so a tab left
// open, or the mobile shell's WebView (alive for days), showed Monday's rate
// as current on Friday. The same cause left a reader whose mount fetch failed
// (the engine slower than the 8 s timeout) on the stale rate until a reload.
//
// LAW. Through the REAL `CurrencyProvider` and the real `lib/rates.ts`, with
// the two addresses answered by this file and the clock moved by hand:
//   · what is shown is derived at read time: a rate past its day is marked
//     stale BEFORE anyone answers and stays stale until a source does;
//   · the sources are asked again whenever no current rate is held — on a
//     timer, when the window gains focus, when the tab becomes visible, when
//     the browser comes back online — one attempt at a time, and after the
//     mount fetch never from a hidden tab;
//   · no request storm: the timer, focus and visibility ask at most once per
//     five minutes; `online` is let through once without waiting, and that
//     pass is spent for five minutes — so never more than two attempts in any
//     five minutes, whatever fires, and never more than one without `online`;
//   · inside the held day nothing is asked and nothing re-renders, with or
//     without localStorage;
//   · a failed attempt never swaps the rate on screen for the bundled
//     fallback; a clock set back does not strand the tab; another tab's
//     answer is taken without a request; unmounting stops everything.
//
// What it cannot see: a real browser's timer throttling in a background tab
// or a suspended WebView (the first look after it resumes reads the clock —
// that is the reason the rule reads `Date.now()` and counts nothing); what
// the deployed function and engine answer; the UI's stale marker.
// Plant log: docs/engine_book/gates.md, "fx-browser" (round 3).

import { act, render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CurrencyProvider, RETRY_MS, TICK_MS, useCurrency, type CurrencyContextValue } from "@/stores/currency";
import {
  FALLBACK_PAYLOAD,
  getHeldRates,
  ratesAsShown,
  ratesNeedAttempt,
  sameRates,
  type RatesPayload,
} from "@/lib/rates";

const FUNCTION_URL = "https://test.supabase.co/functions/v1/fx-rates";
const ENGINE_URL = "http://api.test.invalid/api/fx-rates";
const CACHE_KEY = "cfo:fx-rates:v1";
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Monday 5 October 2026, 07:00 UTC — the reviewer's own scenario. */
const T0 = Date.parse("2026-10-05T07:00:00Z");

/** The DEPLOYED function's answer on 2026-10-03 — measured, verbatim. */
const FUNCTION_AS_DEPLOYED = JSON.parse(
  '{"rates":{"EUR":1,"RON":5.2489,"USD":1.1541116974494283},"source":"BNR",' +
    '"as_of":"2026-08-05","fetched_at":"2026-08-05T11:09:17.271+00:00","stale":true}',
) as RatesPayload;

/** The engine with this release: BNR's file of 2026-10-02. */
const ENGINE_CURRENT: RatesPayload = {
  base: "EUR",
  rates: { EUR: 1.0, RON: 5.3447, USD: 5.3447 / 4.7519 },
  source: "BNR",
  as_of: "2026-10-02",
  fetched_at: "2026-10-05T06:58:11+00:00",
  stale: false,
};

/** The function after its redeploy, holding the same file. */
const FUNCTION_CURRENT: RatesPayload = { ...ENGINE_CURRENT, fetched_at: "2026-10-05T06:40:02.118Z" };

/** A LATER publication — constructed for this law, not a BNR figure: what a
 *  source answers once BNR has published again (dated the Monday the tab is
 *  opened on, so it is a current rate at every moment of these tests). */
const LATER: RatesPayload = {
  base: "EUR",
  rates: { EUR: 1, RON: 5.3512, USD: 1.1263 },
  source: "BNR",
  as_of: "2026-10-05",
  fetched_at: "2026-10-05T10:05:00.000Z",
  stale: false,
};

type Deferred = { answer: (p: RatesPayload) => void; promise: Promise<RatesPayload> };
function deferred(): Deferred {
  let answer!: (p: RatesPayload) => void;
  const promise = new Promise<RatesPayload>((r) => (answer = r));
  return { answer, promise };
}
type Reply = RatesPayload | "network-error" | "hang" | Deferred;

/** Answer the two addresses; every request is recorded. The replies can be
 *  changed while the tab is open. */
function wire(initial: { fn: Reply; engine: Reply }) {
  const replies = { ...initial };
  const asked: string[] = [];
  /** when (fake clock) the FUNCTION was asked — one entry per attempt */
  const attemptsAt: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      asked.push(url);
      if (url.startsWith(FUNCTION_URL)) attemptsAt.push(Date.now());
      const reply = url.startsWith(FUNCTION_URL) ? replies.fn : url.startsWith(ENGINE_URL) ? replies.engine : null;
      if (reply === null) return Promise.reject(new Error(`a request to an address this law does not know: ${url}`));
      if (reply === "network-error") return Promise.reject(new TypeError("Failed to fetch"));
      if (reply === "hang") {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      if ("promise" in reply) {
        return reply.promise.then((body) => ({ ok: true, status: 200, json: async () => body }) as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => reply } as Response);
    }),
  );
  return { asked, replies, attemptsAt };
}

// ── the tab ─────────────────────────────────────────────────────────────
let ctx: CurrencyContextValue;
let renders = 0;
function Probe() {
  ctx = useCurrency();
  renders += 1;
  return null;
}
const shown = () => ({ RON: ctx.rates.rates.RON, as_of: ctx.rates.as_of, source: ctx.rates.source, stale: ctx.rates.stale });

function open() {
  renders = 0;
  return render(
    <CurrencyProvider>
      <Probe />
    </CurrencyProvider>,
  );
}

/** Let `ms` of the fake clock pass (timers and the promises they start). */
async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Dispatch events, then let the promises they started settle — without
 *  reaching the next look at the clock. */
async function fire(...events: Array<"focus" | "online" | "visibilitychange">) {
  await act(async () => {
    for (const e of events) {
      (e === "visibilitychange" ? document : window).dispatchEvent(new Event(e));
    }
    await vi.advanceTimersByTimeAsync(10);
  });
}

/** A storm: the same events every `everyMs` for `forMs`, inside ONE act —
 *  an hour of them costs one flush, not thousands. */
async function storm(events: Array<"focus" | "online" | "visibilitychange">, everyMs: number, forMs: number) {
  await act(async () => {
    for (let t = 0; t < forMs; t += everyMs) {
      for (const e of events) (e === "visibilitychange" ? document : window).dispatchEvent(new Event(e));
      await vi.advanceTimersByTimeAsync(everyMs);
    }
  });
}

/** The machine slept (a closed laptop, a suspended WebView): the clock moved
 *  and NO timer fired. The tab learns of it from the next event. */
function sleepUntil(ms: number) {
  vi.setSystemTime(ms);
}

// These laws drive days of a fake clock; under a loaded machine the default
// five seconds is not a law about the provider.
vi.setConfig({ testTimeout: 30_000 });
afterAll(() => vi.resetConfig());

let visibility: "visible" | "hidden" = "visible";
function setVisibility(v: "visible" | "hidden") {
  visibility = v;
}

function hold(payload: RatesPayload, ageMs: number) {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ payload, cached_at: Date.now() - ageMs }));
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).visibilityState;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ════════════════════════════════════════════════════════════════════════
describe("fx open tab · a rate on screen stops being current when its day ends", () => {
  it("a tab left open for four days — mounted Monday 07:00 with BNR's file of 2 October: when that rate's day ends the sources are asked again, every day, and Friday shows what they answer", async () => {
    const { asked, replies } = wire({ fn: FUNCTION_AS_DEPLOYED, engine: ENGINE_CURRENT });
    open();
    await pass(SECOND);
    // exactly what the reviewer measured at mount
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "BNR", stale: false });
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);

    // the function is redeployed meanwhile and BNR publishes again
    replies.fn = LATER;
    await pass(96 * HOUR);
    await fire("focus", "visibilitychange", "online");

    // the reviewer measured, here: 5.3447 / 2026-10-02 / stale false / 2 requests
    expect(shown()).toEqual({ RON: 5.3512, as_of: "2026-10-05", source: "BNR", stale: false });
    // one request at the end of each of the four days — the function answers
    // a current rate, so the engine is not asked — and none in between
    expect(asked.slice(2)).toEqual([FUNCTION_URL, FUNCTION_URL, FUNCTION_URL, FUNCTION_URL]);
  });

  it("past its day the rate on screen is marked stale BEFORE anyone answers, and stays stale until a source does", async () => {
    const { asked, replies } = wire({ fn: FUNCTION_CURRENT, engine: "network-error" });
    open();
    await pass(DAY - MINUTE);
    expect(shown().stale).toBe(false);
    expect(asked).toEqual([FUNCTION_URL]);

    const slow = deferred();
    replies.fn = slow;
    await pass(MINUTE); // the rate's day ends
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "BNR", stale: true });
    expect(asked).toEqual([FUNCTION_URL, FUNCTION_URL]); // asked again — not answered yet

    await pass(3 * SECOND);
    expect(shown().stale).toBe(true);

    await act(async () => {
      slow.answer(LATER);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(shown()).toEqual({ RON: 5.3512, as_of: "2026-10-05", source: "BNR", stale: false });
    expect(asked).toHaveLength(2);
  });

  it("the sources stop answering: the rate stays on screen, marked stale, and is asked for once per five minutes — not once per look, and nothing re-renders in between", async () => {
    const { asked, replies } = wire({ fn: FUNCTION_CURRENT, engine: "network-error" });
    open();
    await pass(DAY - MINUTE);
    replies.fn = "network-error";

    await pass(MINUTE); // the day ends: stale, and one attempt (function, then engine)
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "BNR", stale: true });
    expect(asked).toHaveLength(1 + 2);
    const rendersOnceStale = renders;

    await pass(4 * MINUTE); // four looks at the clock
    await fire("focus", "visibilitychange");
    expect(asked).toHaveLength(1 + 2);

    await pass(MINUTE - 10); // five minutes after the failed attempt
    expect(asked).toHaveLength(1 + 2 + 2);

    await pass(55 * MINUTE); // …and eleven more in the rest of the hour
    expect(asked).toHaveLength(1 + 2 * 13);
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "BNR", stale: true });
    expect(renders).toBe(rendersOnceStale);
    expect(RETRY_MS).toBe(5 * MINUTE);
    expect(TICK_MS).toBe(MINUTE);
  });

  it("a window that regains focus after the rate's day ended is marked and asks at once — not at the next look", async () => {
    hold(FUNCTION_CURRENT, 30 * SECOND); // its day ends 30 s BEFORE a look
    const { asked, replies } = wire({ fn: FUNCTION_CURRENT, engine: "network-error" });
    open();
    await pass(DAY - 40 * SECOND); // the last look (23 h 59 min) saw it current
    expect(shown().stale).toBe(false);
    expect(asked).toEqual([]);

    await pass(20 * SECOND); // the day ended ten seconds ago; no look yet
    expect(shown().stale).toBe(false);
    replies.fn = LATER;
    await fire("focus");
    expect(asked).toEqual([FUNCTION_URL]);
    expect(shown()).toEqual({ RON: 5.3512, as_of: "2026-10-05", source: "BNR", stale: false });
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx open tab · inside the held day nothing is asked", () => {
  it("23 hours of looks at the clock, focus, visibility and online events cost no request and no re-render", async () => {
    const { asked } = wire({ fn: FUNCTION_CURRENT, engine: ENGINE_CURRENT });
    open();
    await pass(SECOND);
    expect(asked).toEqual([FUNCTION_URL]);
    const rendersOnceHeld = renders;
    const held = ctx.rates;

    for (let hour = 1; hour <= 23; hour += 1) {
      await pass(HOUR - (hour === 1 ? SECOND : 0) - 10);
      await fire("focus", "visibilitychange", "online");
    }
    expect(Date.now()).toBe(T0 + 23 * HOUR);
    expect(asked).toEqual([FUNCTION_URL]);
    expect(renders).toBe(rendersOnceHeld);
    expect(ctx.rates).toBe(held); // the same object: no memo downstream is busted
    expect(shown().stale).toBe(false);
  });

  it("another tab already asked: at the end of this tab's day it takes the shared copy and asks no one", async () => {
    const { asked } = wire({ fn: FUNCTION_CURRENT, engine: ENGINE_CURRENT });
    open();
    await pass(12 * HOUR);
    expect(asked).toEqual([FUNCTION_URL]);
    hold(LATER, 0); // what another tab of this browser stored just now

    await pass(12 * HOUR);
    expect(shown()).toEqual({ RON: 5.3512, as_of: "2026-10-05", source: "BNR", stale: false });
    expect(asked).toEqual([FUNCTION_URL]);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx open tab · a failed attempt is tried again without a reload", () => {
  it("the mount fetch failed — the function stale, the engine slower than eight seconds: five minutes later the tab asks again and shows the current rate", async () => {
    const { asked, replies } = wire({ fn: FUNCTION_AS_DEPLOYED, engine: "hang" });
    open();
    await pass(8 * SECOND + 10);
    // the function's August row is older than the bundled fallback (BNR's
    // file of 2 October): the fallback stays on screen, marked stale
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "fallback", stale: true });
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);

    replies.engine = ENGINE_CURRENT; // the engine has warmed up
    await pass(5 * MINUTE - 8 * SECOND - 10 - SECOND); // 4 min 59 s after mount
    expect(asked).toHaveLength(2);
    expect(shown().stale).toBe(true);

    await pass(SECOND + 10);
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL, FUNCTION_URL, ENGINE_URL]);
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "BNR", stale: false });
    // …and from here it is held for its day
    await pass(HOUR);
    expect(asked).toHaveLength(4);
  });

  it("focus and visibility events inside the five minutes do not multiply the attempts; `online` is let through once, and that pass is spent for five minutes", async () => {
    const { asked, replies } = wire({ fn: FUNCTION_AS_DEPLOYED, engine: "network-error" });
    open();
    await pass(30 * SECOND);
    expect(asked).toHaveLength(2);

    await fire("focus", "visibilitychange", "focus", "visibilitychange", "focus");
    expect(asked).toHaveLength(2);

    await fire("online"); // the network came back: the last failure says nothing about now
    expect(asked).toHaveLength(4);
    expect(shown().stale).toBe(true);

    replies.engine = ENGINE_CURRENT; // the engine is back too — but the pass is spent
    await fire("online", "focus", "visibilitychange", "online");
    await pass(4 * MINUTE);
    await fire("online", "online");
    expect(asked).toHaveLength(4);
    expect(shown().stale).toBe(true);

    await pass(90 * SECOND); // the first look five minutes after that attempt
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL, FUNCTION_URL, ENGINE_URL, FUNCTION_URL, ENGINE_URL]);
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "BNR", stale: false });
    await fire("online", "focus"); // a current rate is held: nothing to ask
    expect(asked).toHaveLength(6);
  });

  it("no request storm: an hour of `online`, focus and visibility events every two seconds while both sources fail — never more than two attempts in any five minutes; without `online`, never more than one", async () => {
    const { attemptsAt } = wire({ fn: "network-error", engine: "network-error" });
    open();
    await storm(["online", "focus", "visibilitychange", "online"], 2 * SECOND, HOUR);
    expect(Date.now()).toBe(T0 + HOUR);
    // it keeps trying — and no window of five minutes holds a third attempt
    expect(attemptsAt.length).toBeGreaterThanOrEqual(12);
    expect(attemptsAt.length).toBeLessThanOrEqual(2 * 12 + 2);
    for (let i = 0; i + 2 < attemptsAt.length; i += 1) {
      expect(attemptsAt[i + 2] - attemptsAt[i], `attempts ${i}..${i + 2}`).toBeGreaterThanOrEqual(RETRY_MS);
    }

    // the second hour: the same storm without `online`
    const before = attemptsAt.length;
    await storm(["focus", "visibilitychange", "focus"], 2 * SECOND, HOUR);
    const quiet = attemptsAt.slice(before - 1); // from the last attempt of the first hour on
    expect(quiet.length - 1).toBeGreaterThanOrEqual(11);
    expect(quiet.length - 1).toBeLessThanOrEqual(12);
    for (let i = 0; i + 1 < quiet.length; i += 1) {
      expect(quiet[i + 1] - quiet[i], `attempts ${i}..${i + 1}`).toBeGreaterThanOrEqual(RETRY_MS);
    }
  });

  it("a hidden tab asks nothing — its rate is still marked stale when the day ends — and it asks the moment it becomes visible", async () => {
    const { asked, replies } = wire({ fn: FUNCTION_CURRENT, engine: "network-error" });
    open();
    await pass(SECOND);
    setVisibility("hidden");
    await fire("visibilitychange");
    replies.fn = LATER;

    await pass(30 * HOUR);
    expect(asked).toEqual([FUNCTION_URL]);
    expect(shown().stale).toBe(true); // what a screenshot of the hidden tab would carry

    await pass(20 * SECOND); // between two looks
    setVisibility("visible");
    await fire("visibilitychange");
    expect(asked).toEqual([FUNCTION_URL, FUNCTION_URL]);
    expect(shown()).toEqual({ RON: 5.3512, as_of: "2026-10-05", source: "BNR", stale: false });
  });

  it("a tab opened in the background makes its mount fetch — one attempt — and then nothing until it is seen", async () => {
    setVisibility("hidden");
    const { asked, replies } = wire({ fn: "network-error", engine: "network-error" });
    open();
    await pass(HOUR);
    await fire("focus", "online"); // events reach a hidden window too: they ask nothing
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "fallback", stale: true });

    replies.fn = FUNCTION_CURRENT;
    setVisibility("visible");
    await fire("visibilitychange");
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL, FUNCTION_URL]);
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "BNR", stale: false });
  });

  it("one attempt at a time: events while a request is in flight start no second one", async () => {
    const { asked } = wire({ fn: "hang", engine: "hang" });
    open();
    await fire("online", "focus", "online");
    expect(asked).toEqual([FUNCTION_URL]);

    await pass(8 * SECOND); // the function is abandoned; the engine is asked
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
    await fire("online", "online");
    expect(asked).toHaveLength(2);

    await pass(8 * SECOND); // the engine is abandoned too: the attempt is over
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "fallback", stale: true });
    await fire("online");
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL, FUNCTION_URL]);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx open tab · what the tab holds", () => {
  it("localStorage unavailable (private mode): nothing is asked inside the day, the tab's own copy is marked stale past it, and a failed attempt never swaps it for the bundled fallback", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const { asked, replies } = wire({ fn: LATER, engine: "network-error" });
    open();
    await pass(SECOND);
    expect(shown()).toEqual({ RON: 5.3512, as_of: "2026-10-05", source: "BNR", stale: false });
    expect(asked).toEqual([FUNCTION_URL]);

    await pass(23 * HOUR);
    await fire("focus", "visibilitychange", "online");
    expect(asked).toEqual([FUNCTION_URL]); // held in memory: it spares the requests too

    replies.fn = "network-error";
    await pass(HOUR);
    // both sources were asked and neither answered; lib/rates has no copy to
    // fall back on and returns the bundled fallback — the tab keeps its own
    expect(asked.slice(1, 3)).toEqual([FUNCTION_URL, ENGINE_URL]);
    expect(shown()).toEqual({ RON: 5.3512, as_of: "2026-10-05", source: "BNR", stale: true });
    expect(FALLBACK_PAYLOAD.rates.RON).not.toBe(5.3512);
  });

  it("a browser that stored the August row before this release: first paint is the bundled file of 2 October, marked stale — never 5.2489 — and then the current rate", async () => {
    hold(FUNCTION_AS_DEPLOYED, HOUR);
    const { asked } = wire({ fn: FUNCTION_AS_DEPLOYED, engine: ENGINE_CURRENT });
    open();
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "fallback", stale: true });
    await pass(SECOND);
    expect(asked).toEqual([FUNCTION_URL, ENGINE_URL]);
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "BNR", stale: false });
  });

  it("a stale answer never replaces the newer rate on screen: past its day the tab's rate is marked stale and the function's August row does not take its place", async () => {
    const { asked, replies } = wire({ fn: FUNCTION_CURRENT, engine: "network-error" });
    open();
    await pass(DAY - MINUTE);
    replies.fn = FUNCTION_AS_DEPLOYED; // the function fell back to its old row
    await pass(MINUTE);
    expect(asked).toEqual([FUNCTION_URL, FUNCTION_URL, ENGINE_URL]);
    // BNR's file of 2 October, marked stale — not 5.2489 of 5 August
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "BNR", stale: true });
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).payload.as_of).toBe("2026-10-02");

    // the same with localStorage unavailable: the tab's own copy is the judge
    replies.engine = "network-error";
    await pass(10 * MINUTE);
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "BNR", stale: true });
  });

  it("a rate whose PUBLICATION is more than ten days old is not current, however recently a source answered it — and a tab that slept learns of it from its first event", async () => {
    // a source that keeps answering Friday's file as current (its own check
    // failing): the tab takes it on Monday — and not eleven days after Friday
    const { asked } = wire({ fn: FUNCTION_CURRENT, engine: "network-error" });
    open();
    await pass(SECOND);
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "BNR", stale: false });
    expect(asked).toEqual([FUNCTION_URL]);

    // the laptop is closed for a week: no timer fires. Monday 12 October —
    // ten days after the file. The first event asks; the label is believed.
    sleepUntil(T0 + 7 * DAY + SECOND);
    await fire("visibilitychange", "focus");
    expect(asked).toEqual([FUNCTION_URL, FUNCTION_URL]);
    expect(shown().stale).toBe(false);

    // closed again until Tuesday 13 October — eleven days. The function's
    // label is no longer believed, so the engine is asked too, and the rate
    // is shown as what it is.
    sleepUntil(T0 + 8 * DAY + 2 * SECOND);
    await fire("focus");
    expect(asked).toEqual([FUNCTION_URL, FUNCTION_URL, FUNCTION_URL, ENGINE_URL]);
    expect(shown()).toEqual({ RON: 5.3447, as_of: "2026-10-02", source: "BNR", stale: true });
  });

  it("a clock set back does not strand the tab: a held record stamped in the future is shown stale and replaced by the next answer", async () => {
    hold(ENGINE_CURRENT, -2 * HOUR);
    const { asked } = wire({ fn: LATER, engine: "network-error" });
    open();
    expect(shown().stale).toBe(true); // first paint
    await pass(SECOND);
    expect(asked).toEqual([FUNCTION_URL]);
    expect(shown()).toEqual({ RON: 5.3512, as_of: "2026-10-05", source: "BNR", stale: false });
  });

  it("refresh() asks the function with ?refresh=true whatever is held, and the rate's day runs from that answer", async () => {
    const { asked, replies } = wire({ fn: FUNCTION_CURRENT, engine: "network-error" });
    open();
    await pass(HOUR);
    replies.fn = LATER;
    await act(async () => {
      await ctx.refresh();
    });
    expect(asked).toEqual([FUNCTION_URL, `${FUNCTION_URL}?refresh=true`]);
    expect(shown()).toEqual({ RON: 5.3512, as_of: "2026-10-05", source: "BNR", stale: false });
    expect(ctx.refreshing).toBe(false);

    await pass(DAY - MINUTE); // 24 h 59 min after mount, 23 h 59 min after the refresh
    expect(asked).toHaveLength(2);
    await pass(MINUTE);
    expect(asked).toEqual([FUNCTION_URL, `${FUNCTION_URL}?refresh=true`, FUNCTION_URL]);
  });

  it("unmounting stops everything: no look, no listener, no request — and an answer that arrives afterwards changes nothing", async () => {
    const slow = deferred();
    const { asked, replies } = wire({ fn: slow, engine: "network-error" });
    const tab = open();
    await pass(SECOND);
    expect(asked).toEqual([FUNCTION_URL]);
    const before = ctx.rates;
    const rendersBefore = renders;

    tab.unmount();
    replies.fn = "network-error"; // from here every attempt would cost two requests
    await act(async () => {
      slow.answer(LATER);
      await vi.advanceTimersByTimeAsync(10);
    });
    await pass(2 * DAY);
    await fire("focus", "visibilitychange", "online");
    expect(asked).toEqual([FUNCTION_URL]);
    expect(ctx.rates).toBe(before);
    expect(renders).toBe(rendersBefore);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx open tab · the rule itself, read off a held record", () => {
  const at = Date.parse("2026-10-05T07:00:00Z");
  const record = (payload: RatesPayload) => ({ payload, cached_at: at });

  it("current inside its day, stale from the day's last millisecond on — and a payload that is not a current BNR rate is stale at every moment", () => {
    const held = record(ENGINE_CURRENT);
    expect(ratesAsShown(held, at)).toBe(ENGINE_CURRENT);
    expect(ratesAsShown(held, at + DAY - 1)).toBe(ENGINE_CURRENT);
    expect(ratesAsShown(held, at + DAY)).toEqual({ ...ENGINE_CURRENT, stale: true });
    expect(ratesAsShown(held, at + 4 * DAY)).toEqual({ ...ENGINE_CURRENT, stale: true });
    expect(ratesAsShown(held, at - 1)).toEqual({ ...ENGINE_CURRENT, stale: true }); // stamped in the future
    expect([ratesNeedAttempt(held, at), ratesNeedAttempt(held, at + DAY - 1), ratesNeedAttempt(held, at + DAY), ratesNeedAttempt(held, at - 1)]).toEqual([false, false, true, true]);

    for (const notCurrent of [FUNCTION_AS_DEPLOYED, { ...ENGINE_CURRENT, source: "fallback" } as RatesPayload, FALLBACK_PAYLOAD]) {
      expect(ratesAsShown(record(notCurrent), at + MINUTE).stale).toBe(true);
      expect(ratesNeedAttempt(record(notCurrent), at + MINUTE)).toBe(true);
    }
    // the held payload itself is never rewritten
    expect(ENGINE_CURRENT.stale).toBe(false);

    // …and inside its day a record is current only while its PUBLICATION is
    // at most ten days old: answered on 13 October, BNR's file of 2 October
    // is eleven days old
    const lateAnswer = { payload: ENGINE_CURRENT, cached_at: at + 8 * DAY };
    expect(ratesAsShown({ payload: ENGINE_CURRENT, cached_at: at + 7 * DAY }, at + 7 * DAY + HOUR)).toBe(ENGINE_CURRENT);
    expect(ratesAsShown(lateAnswer, at + 8 * DAY + HOUR)).toEqual({ ...ENGINE_CURRENT, stale: true });
    expect(ratesNeedAttempt(lateAnswer, at + 8 * DAY + HOUR)).toBe(true);
  });

  it("nothing held is the bundled fallback, answered never: stale, and it spares no request; a record without a usable timestamp is the same", () => {
    expect(getHeldRates()).toEqual({ payload: FALLBACK_PAYLOAD, cached_at: 0 });
    expect(ratesAsShown(getHeldRates(), Date.now())).toBe(FALLBACK_PAYLOAD);
    expect(ratesNeedAttempt(getHeldRates(), Date.now())).toBe(true);

    for (const stamp of [undefined, null, "yesterday", Number.NaN]) {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ payload: ENGINE_CURRENT, cached_at: stamp }));
      const held = getHeldRates();
      expect(held.cached_at, String(stamp)).toBe(0);
      expect(ratesAsShown(held, Date.now())).toEqual({ ...ENGINE_CURRENT, stale: true });
      expect(ratesNeedAttempt(held, Date.now())).toBe(true);
    }
  });

  it("two payloads are the same rate when a reader could not tell them apart — and not when the label, the date or a figure differs", () => {
    expect(sameRates(ENGINE_CURRENT, JSON.parse(JSON.stringify(ENGINE_CURRENT)))).toBe(true);
    expect(sameRates(ENGINE_CURRENT, { ...ENGINE_CURRENT, stale: true })).toBe(false);
    expect(sameRates(ENGINE_CURRENT, { ...ENGINE_CURRENT, source: "fallback" })).toBe(false);
    expect(sameRates(ENGINE_CURRENT, { ...ENGINE_CURRENT, as_of: "2026-10-01" })).toBe(false);
    expect(sameRates(ENGINE_CURRENT, { ...ENGINE_CURRENT, fetched_at: "2026-10-05T07:00:00+00:00" })).toBe(false);
    for (const cur of ["RON", "USD", "EUR"] as const) {
      expect(sameRates(ENGINE_CURRENT, { ...ENGINE_CURRENT, rates: { ...ENGINE_CURRENT.rates, [cur]: 9 } }), cur).toBe(false);
    }
  });
});
