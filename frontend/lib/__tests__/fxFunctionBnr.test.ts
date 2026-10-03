// fx-browser, the FUNCTION's half — the `fx-rates` Edge Function's feed
// reader (supabase/functions/fx-rates/bnr.ts), run in Node on BNR's own bytes
// and on the row production held on 2026-10-03.
//
// INCIDENT (measured on production, 2026-10-03). The browser's
// display-currency rates come from this function, not from the engine. The
// deployed function asked `https://www.bnr.ro/nbrfxrates.xml` and nothing
// else; BNR had moved the feed to `https://curs.bnr.ro/nbrfxrates.xml` and the
// old address answers a redirect to a web page. The function served its last
// cached row, marked stale, for two months:
//
//   {"rates":{"EUR":1,"RON":5.2489,"USD":1.1541116974494283},"source":"BNR",
//    "as_of":"2026-08-05","fetched_at":"2026-08-05T11:09:17.271+00:00","stale":true}
//
// against BNR's file of 2026-10-02 (5.3447 RON per EUR, 4.7519 RON per USD):
// EUR amounts 1.8% too high, USD amounts 4.5%. Nothing could test it — the
// parser, the address and the cache logic all sat inside `Deno.serve`.
//
// LAW. On the committed real file (tests/engine/fixtures/fx/, BNR's bytes of
// 2026-10-02, public data): the parser returns the figures a regex reads out
// of the file; a web page is not the feed; a rate outside the plausible range,
// a Cube without a usable date, a body over 64 KB or one declaring a DOCTYPE /
// ENTITY is refused; a Cube in the future or more than 10 days old is a
// failure; the feed is asked at curs.bnr.ro first, every address is a
// candidate and the newest date wins. Through `resolveRates` — the function's
// whole request, with the row and the wire passed in: on the row production
// holds, BNR is asked at the new address, the fresh row is stored and the
// answer is `source: BNR, stale: false`; while BNR does not answer, the last
// accepted rate is served MARKED STALE, the rate is never overwritten, and
// BNR is asked at most once per five minutes (it was: on every request).
// The three live copies of the bundled fallback are one figure.
//
// What it cannot see: the DEPLOYED function (its redeploy is a separate step
// — docs/engine_book/gates.md "fx-browser" carries the command and the
// probe); the real supabase-js client and the real `fx_rates_cache` table
// (the three statements in index.ts are read here as text, not executed);
// whether BNR moves the feed again.
// Plant log: docs/engine_book/gates.md, "fx-browser".

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as bnr from "../../../supabase/functions/fx-rates/bnr.ts";
import { FALLBACK_PAYLOAD, FALLBACK_RATES as BROWSER_FALLBACK_RATES } from "@/lib/rates";

const REPO = process.cwd();
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

// A source file without its comments (whole-line `//` ones and block ones),
// so a sentence ABOUT `Deno.serve` is not read as a use of it.
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const REAL = read("tests/engine/fixtures/fx/nbrfxrates_REAL_curs_bnr_ro.xml");
const BNR_TS = code(read("supabase/functions/fx-rates/bnr.ts"));
const INDEX_TS = code(read("supabase/functions/fx-rates/index.ts"));
const ENGINE_PY = read("src/engine/api/fx_rates.py");

const NEW = "https://curs.bnr.ro/nbrfxrates.xml";
const OLD = "https://www.bnr.ro/nbrfxrates.xml";

/** What the old address answers once its redirect is followed (first bytes,
 *  measured 2026-10-03): a 200 that is a web page. */
const HTML_PAGE =
  '<!doctype html><html lang="ro">\r\n<head>\r\n    <meta charset="UTF-8">\r\n' +
  "    <title>BNR Banca Nationala a Romaniei (BNR)</title></head><body></body></html>";

/** The feed's own figure, read by a regex — not by the parser under test. */
function rateInFile(currency: string): number {
  const m = REAL.match(new RegExp(`<Rate currency="${currency}"(?: multiplier="(\\d+)")?>([0-9.]+)</Rate>`));
  if (!m) throw new Error(`the fixture carries no ${currency} rate`);
  return Number(m[2]) / (m[1] ? Number(m[1]) : 1);
}
const EUR = rateInFile("EUR");
const USD = rateInFile("USD");

/** The real file, re-dated (Cube and PublishingDate) and re-priced in EUR. */
function dated(date: string, eur = "5.3447"): string {
  const doc = REAL.split("2026-10-02").join(date).replace(
    '<Rate currency="EUR">5.3447</Rate>',
    `<Rate currency="EUR">${eur}</Rate>`,
  );
  if (doc === REAL && !(date === "2026-10-02" && eur === "5.3447")) throw new Error("the fixture was not changed");
  return doc;
}

function swap(old: string, planted: string): string {
  const doc = REAL.replace(old, planted);
  if (doc === REAL) throw new Error(`the fixture does not contain ${old}`);
  return doc;
}

/** 2026-10-03 09:00 in Romania — the day after the committed file. */
const NOW = new Date("2026-10-03T06:00:00.000Z");
const TODAY = "2026-10-03";

// ── the wire ────────────────────────────────────────────────────────────

type Answer = string | { status: number; body: string } | Error | "hang" | Uint8Array;

class Wire {
  asked: string[] = [];
  inits: Array<{ headers: Record<string, string>; signal: AbortSignal }> = [];
  bytesRead = 0;
  cancelled = 0;
  constructor(public answers: Record<string, Answer>) {}

  fetch: bnr.FeedFetch = (url, init) => {
    this.asked.push(url);
    this.inits.push(init);
    const answer = this.answers[url];
    if (answer === undefined) return Promise.reject(new Error(`unexpected address ${url}`));
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === "hang") {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    // ArrayBuffer.isView, not instanceof: jsdom's TextEncoder hands out a
    // Uint8Array of another realm.
    const raw = ArrayBuffer.isView(answer) ? (answer as Uint8Array) : null;
    const described = raw || typeof answer === "string" ? null : (answer as { status: number; body: string });
    const status = described ? described.status : 200;
    const bytes = raw ?? new TextEncoder().encode(described ? described.body : (answer as string));
    // The body is handed out in 16 KB chunks through a reader, as a stream is.
    const CHUNK = 16 * 1024;
    let at = 0;
    const reader = {
      read: async () => {
        if (at >= bytes.byteLength) return { done: true, value: undefined };
        const value = bytes.slice(at, at + CHUNK);
        at += value.byteLength;
        this.bytesRead += value.byteLength;
        return { done: false, value };
      },
      cancel: async () => {
        this.cancelled += 1;
      },
    };
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      body: { getReader: () => reader },
      text: async () => new TextDecoder().decode(bytes),
    });
  };
}

// ── the row ─────────────────────────────────────────────────────────────

/** The `fx_rates_cache` row behind the answer the deployed function gave on
 *  2026-10-03 (the function writes `updated_at = fetched_at` on a success). */
const DEPLOYED_ROW: bnr.CacheRow = {
  base: "EUR",
  rates: { EUR: 1, RON: 5.2489, USD: 1.1541116974494283 },
  source: "BNR",
  as_of: "2026-08-05",
  fetched_at: "2026-08-05T11:09:17.271+00:00",
  updated_at: "2026-08-05T11:09:17.271+00:00",
};

class Store implements bnr.RatesStore {
  writes: Array<[string, unknown]> = [];
  readFails = false;
  writeFails = false;
  constructor(public row: bnr.CacheRow | null) {}
  async read() {
    if (this.readFails) throw new Error("relation fx_rates_cache does not exist");
    return this.row ? { ...this.row } : null;
  }
  async writeAccepted(p: bnr.RatesPayload) {
    if (this.writeFails) throw new Error("permission denied for table fx_rates_cache");
    this.writes.push(["accepted", p]);
    this.row = {
      base: p.base, rates: { ...p.rates }, source: p.source, as_of: p.as_of,
      fetched_at: p.fetched_at, updated_at: p.fetched_at,
    };
  }
  async stampFailedAttempt(atIso: string) {
    this.writes.push(["attempt", atIso]);
    if (this.row) this.row = { ...this.row, updated_at: atIso };
  }
}

function request(store: Store, wire: Wire, memory: bnr.InstanceMemory, at: Date, forceRefresh = false) {
  return bnr.resolveRates({ store, fetchFn: wire.fetch, now: at, forceRefresh, memory });
}

const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

afterEach(() => {
  vi.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════
describe("fx function · the parser on BNR's own bytes", () => {
  it("the real feed parses to the figures BNR published", () => {
    expect([EUR, USD]).toEqual([5.3447, 4.7519]); // the committed fixture is BNR's file of 2026-10-02
    const got = bnr.parseBnrXml(REAL);
    expect(got.source).toBe("BNR");
    expect(got.base).toBe("EUR");
    expect(got.as_of).toBe("2026-10-02");
    expect(got.rates.EUR).toBe(1);
    expect(got.rates.RON).toBe(EUR);
    expect(got.rates.USD).toBeCloseTo(EUR / USD, 12);
  });

  it.each([
    ["the pre-2026 http:// namespace", 'xmlns="http://www.bnr.ro/xsd"'],
    ["curs.bnr.ro, where the file's own schemaLocation points", 'xmlns="https://curs.bnr.ro/xsd"'],
    ["single-quoted", "xmlns='https://www.bnr.ro/xsd'"],
    ["one nobody has seen yet", 'xmlns="urn:any:other"'],
    ["none at all", ""],
  ])("the feed parses in any namespace: %s", (_name, written) => {
    const got = bnr.parseBnrXml(swap('xmlns="https://www.bnr.ro/xsd"', written));
    expect([got.rates.RON, got.as_of]).toEqual([EUR, "2026-10-02"]);
  });

  it("prefixed elements and single-quoted attributes are still the feed", () => {
    const doc = REAL.split("<Cube").join("<n:Cube").split("</Cube>").join("</n:Cube>")
      .split("<Rate").join("<n:Rate").split("</Rate>").join("</n:Rate>")
      .replace('date="2026-10-02"', "date='2026-10-02'");
    expect(doc).not.toBe(REAL);
    const got = bnr.parseBnrXml(doc);
    expect([got.rates.RON, got.as_of]).toEqual([EUR, "2026-10-02"]);
  });

  it("a web page is not the feed", () => {
    expect(() => bnr.parseBnrXml(HTML_PAGE)).toThrow(/DOCTYPE/);
    // ...a page that is well-formed XML with no DOCTYPE is still not it,
    expect(() => bnr.parseBnrXml("<html><head><title>BNR</title></head><body/></html>")).toThrow(/missing Cube/);
    // ...and neither is anything the size of a page (the real one is 119,885 bytes).
    const big = REAL.replace("</DataSet>", `<!--${"x".repeat(64 * 1024)}--></DataSet>`);
    expect(big.length).toBeGreaterThan(bnr.MAX_BODY_BYTES);
    expect(() => bnr.parseBnrXml(big)).toThrow(/not the feed/);
    expect(bnr.MAX_BODY_BYTES).toBe(64 * 1024);
  });

  it.each([
    ["EUR ten times: a multiplier nobody divided", '<Rate currency="EUR">5.3447</Rate>', '<Rate currency="EUR">53.447</Rate>', "RON per 1 EUR"],
    ["EUR inverted", '<Rate currency="EUR">5.3447</Rate>', '<Rate currency="EUR">0.1871</Rate>', "RON per 1 EUR"],
    ["USD ALONE ten times", '<Rate currency="USD">4.7519</Rate>', '<Rate currency="USD">47.519</Rate>', "USD per 1 EUR"],
    ["USD ALONE a tenth", '<Rate currency="USD">4.7519</Rate>', '<Rate currency="USD">0.47519</Rate>', "USD per 1 EUR"],
  ])("a rate outside the plausible range is refused: %s", (_name, old, planted, names) => {
    expect(() => bnr.parseBnrXml(swap(old, planted))).toThrow(/plausible/);
    expect(() => bnr.parseBnrXml(swap(old, planted))).toThrow(names);
  });

  it.each([
    ["no date at all", "<Cube>"],
    ["an empty date", '<Cube date="">'],
    ["a date not in the feed's format", '<Cube date="02.10.2026">'],
    ["the format, not a date", '<Cube date="2026-13-45">'],
    ["a day that does not exist", '<Cube date="2026-02-31">'],
  ])("a Cube without a usable date is not the feed: %s", (_name, cube) => {
    // The deployed function served such a Cube FRESH, with the fallback's
    // date on a live rate. Nothing can say how old the rate is: a failure.
    expect(() => bnr.parseBnrXml(swap('<Cube date="2026-10-02">', cube))).toThrow(/no Cube with a date/);
  });

  it("of two Cubes the newest date is the rate", () => {
    const older =
      '<Cube date="2026-10-01"><Rate currency="EUR">5.0001</Rate><Rate currency="USD">4.5001</Rate></Cube>';
    for (const doc of [
      swap('<Cube date="2026-10-02">', `${older}<Cube date="2026-10-02">`),
      swap("</Cube></Body>", `</Cube>${older}</Body>`),
    ]) {
      const got = bnr.parseBnrXml(doc);
      expect([got.as_of, got.rates.RON]).toEqual(["2026-10-02", 5.3447]);
    }
  });

  it.each([
    ["an entity", '<!DOCTYPE DataSet [<!ENTITY a "5.3447">]>'],
    ["a lowercase doctype", "<!doctype DataSet>"],
    ["a bare entity declaration", '<!ENTITY lol "lol">'],
  ])("a body declaring a DOCTYPE or an ENTITY is refused: %s", (_name, planted) => {
    expect(() => bnr.parseBnrXml(swap("<DataSet ", `${planted}<DataSet `))).toThrow(/DOCTYPE or an ENTITY/);
  });

  it("a multiplier is divided out; a decimal comma, a hex or an exponent figure is not a rate", () => {
    const per100 = swap('<Rate currency="USD">4.7519</Rate>', '<Rate currency="USD" multiplier="100">475.19</Rate>');
    expect(bnr.parseBnrXml(per100).rates.USD).toBeCloseTo(5.3447 / 4.7519, 9);
    for (const written of ["5,3447", "0x5", "5e0", "", " "]) {
      const doc = swap('<Rate currency="EUR">5.3447</Rate>', `<Rate currency="EUR">${written}</Rate>`);
      expect(() => bnr.parseBnrXml(doc), written).toThrow(/missing EUR rate/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx function · freshness: the Cube's date against the calendar", () => {
  it.each([
    ["today's file", "2026-10-03", true],
    ["yesterday's", "2026-10-02", true],
    ["exactly ten days", "2026-09-23", true],
    ["eleven days", "2026-09-22", false],
    ["a file that stopped updating long ago", "2025-01-03", false],
    ["tomorrow", "2026-10-04", false],
  ])("a Cube is fresh for ten days and never from the future: %s", (_name, cubeDate, fresh) => {
    expect(bnr.MAX_AGE_DAYS).toBe(10);
    if (fresh) expect(() => bnr.requireFresh(cubeDate, TODAY)).not.toThrow();
    else expect(() => bnr.requireFresh(cubeDate, TODAY)).toThrow(/days old|after today/);
  });

  it("today is Romania's date, not UTC's", () => {
    expect(bnr.todayInRomania(new Date("2026-10-03T20:59:59Z"))).toBe("2026-10-03");
    expect(bnr.todayInRomania(new Date("2026-10-03T21:00:00Z"))).toBe("2026-10-04");
    expect(bnr.todayInRomania(NOW)).toBe(TODAY);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx function · the fetch: which address, in which order, and what a non-feed means", () => {
  it("the feed is asked at the address it lives at first, and the old address stays a candidate", () => {
    expect(bnr.BNR_URLS[0]).toBe(NEW);
    expect(bnr.BNR_URLS).toContain(OLD);
  });

  it("production as it is: the new address answers the feed, the old one a web page", async () => {
    const wire = new Wire({ [NEW]: REAL, [OLD]: HTML_PAGE });
    const got = await bnr.fetchBnr(wire.fetch, NOW);
    // yesterday's file: the other address is asked, answers a page, changes nothing
    expect(wire.asked).toEqual([NEW, OLD]);
    expect([got.source, got.as_of, got.rates.RON]).toEqual(["BNR", "2026-10-02", 5.3447]);
    expect(got.rates.USD).toBeCloseTo(5.3447 / 4.7519, 12);
  });

  it("the deployed function's one address answers a web page: that is a failure, not an answer", async () => {
    const wire = new Wire({ [NEW]: new Error("no route"), [OLD]: HTML_PAGE });
    await expect(bnr.fetchBnr(wire.fetch, NOW)).rejects.toThrow(/DOCTYPE/);
    expect(wire.asked).toEqual([NEW, OLD]);
  });

  it("today's file ends the search", async () => {
    const wire = new Wire({ [NEW]: dated("2026-10-03"), [OLD]: HTML_PAGE });
    const got = await bnr.fetchBnr(wire.fetch, NOW);
    expect(wire.asked).toEqual([NEW]);
    expect(got.as_of).toBe("2026-10-03");
  });

  it("a page or an unreachable host at the first address is a failure and the next is tried", async () => {
    for (const first of [HTML_PAGE, new Error("no route")] as Answer[]) {
      const wire = new Wire({ [NEW]: first, [OLD]: REAL });
      const got = await bnr.fetchBnr(wire.fetch, NOW);
      expect(wire.asked).toEqual([NEW, OLD]);
      expect(got.rates.RON).toBe(5.3447);
    }
  });

  it("a frozen first address loses to a newer second; an older second never replaces the first; a tie is the first's", async () => {
    let wire = new Wire({ [NEW]: dated("2026-09-25", "5.0001"), [OLD]: REAL });
    let got = await bnr.fetchBnr(wire.fetch, NOW);
    expect([wire.asked, got.as_of, got.rates.RON]).toEqual([[NEW, OLD], "2026-10-02", 5.3447]);

    wire = new Wire({ [NEW]: REAL, [OLD]: dated("2026-09-25", "5.0001") });
    got = await bnr.fetchBnr(wire.fetch, NOW);
    expect([wire.asked, got.as_of, got.rates.RON]).toEqual([[NEW, OLD], "2026-10-02", 5.3447]);

    wire = new Wire({ [NEW]: REAL, [OLD]: dated("2026-10-02", "5.1111") });
    got = await bnr.fetchBnr(wire.fetch, NOW);
    expect(got.rates.RON).toBe(5.3447);
  });

  it.each([["eleven days old", "2026-09-22"], ["frozen since 2025", "2025-01-03"], ["dated tomorrow", "2026-10-04"]])(
    "a feed that is %s at every address is a failure",
    async (_name, cubeDate) => {
      const wire = new Wire({ [NEW]: dated(cubeDate), [OLD]: dated(cubeDate) });
      await expect(bnr.fetchBnr(wire.fetch, NOW)).rejects.toThrow(/days old|after today/);
      expect(wire.asked).toEqual([NEW, OLD]);
    },
  );

  it.each([204, 206, 301, 503])("an answer that is not 200 is a failure whatever its body: %i", async (status) => {
    // The body IS the real feed, so only the status check can refuse it.
    const wire = new Wire({ [NEW]: { status, body: REAL }, [OLD]: HTML_PAGE });
    await expect(bnr.fetchBnr(wire.fetch, NOW)).rejects.toThrow(`BNR HTTP ${status}`);
    expect(wire.asked).toEqual([NEW, OLD]);
  });

  it("a body over 64 KB is abandoned mid-read, never read whole", async () => {
    const page = new TextEncoder().encode(HTML_PAGE + " ".repeat(119_885 - HTML_PAGE.length)); // the real page's size
    const wire = new Wire({ [NEW]: page, [OLD]: page });
    await expect(bnr.fetchBnr(wire.fetch, NOW)).rejects.toThrow(/over 65536 bytes/);
    expect(wire.cancelled).toBe(2);
    // five 16 KB chunks cross the cap; the other ~40 KB of each page is never read
    expect(wire.bytesRead).toBe(2 * 5 * 16 * 1024);
  });

  it("a body that is not UTF-8 is not the feed", async () => {
    // UTF-16 with its byte-order mark: 0xFF 0xFE is not UTF-8.
    const units = new Uint8Array(new Uint16Array(Array.from(REAL, (c) => c.charCodeAt(0))).buffer);
    const utf16 = new Uint8Array(units.byteLength + 2);
    utf16.set([0xff, 0xfe], 0);
    utf16.set(units, 2);
    const wire = new Wire({ [NEW]: utf16, [OLD]: utf16 });
    const refused = await bnr.fetchBnr(wire.fetch, NOW).then(() => "", (e: Error) => e.message);
    expect(refused).not.toBe("");
    expect(refused).not.toMatch(/BNR HTTP|missing Cube/); // refused by the decoder, before any parsing
    expect(wire.asked).toEqual([NEW, OLD]);
    // the control: the same characters as UTF-8 are the feed
    const utf8 = new Wire({ [NEW]: new TextEncoder().encode(REAL), [OLD]: HTML_PAGE });
    expect((await bnr.fetchBnr(utf8.fetch, NOW)).rates.RON).toBe(5.3447);
  });

  it("every fetch carries an abort signal, and a hanging address is abandoned after eight seconds", async () => {
    vi.useFakeTimers();
    expect(bnr.FETCH_TIMEOUT_MS).toBe(8000);
    const wire = new Wire({ [NEW]: "hang", [OLD]: REAL });
    const pending = bnr.fetchBnr(wire.fetch, NOW);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(wire.asked).toEqual([NEW]); // still waiting on the first address
    await vi.advanceTimersByTimeAsync(1);
    const got = await pending;
    expect(wire.asked).toEqual([NEW, OLD]);
    expect(got.rates.RON).toBe(5.3447);
    expect(wire.inits.every((i) => i.signal instanceof AbortSignal)).toBe(true);
    expect(wire.inits[0].signal.aborted).toBe(true);
    expect(wire.inits[1].signal.aborted).toBe(false);
  });

  it("no address answering the feed is an error that names both", async () => {
    const wire = new Wire({ [NEW]: HTML_PAGE, [OLD]: new Error("down") });
    await expect(bnr.fetchBnr(wire.fetch, NOW)).rejects.toThrow(/curs\.bnr\.ro.*www\.bnr\.ro/s);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx function · when BNR may be asked", () => {
  const H = 3_600_000;
  const MIN = 60_000;
  const t = NOW.getTime();

  it.each([
    ["an accepted file 23 h old, not forced", { fetchedAtMs: t - 23 * H, lastAttemptMs: 0, forceRefresh: false }, "serve-cached"],
    ["an accepted file 25 h old, never retried", { fetchedAtMs: t - 25 * H, lastAttemptMs: 0, forceRefresh: false }, "fetch"],
    ["the deployed row: accepted two months ago", { fetchedAtMs: Date.parse("2026-08-05T11:09:17.271Z"), lastAttemptMs: Date.parse("2026-08-05T11:09:17.271Z"), forceRefresh: false }, "fetch"],
    ["a stale row, BNR asked 4 minutes ago and failed", { fetchedAtMs: t - 60 * 24 * H, lastAttemptMs: t - 4 * MIN, forceRefresh: false }, "cooldown"],
    ["a stale row, BNR asked 6 minutes ago and failed", { fetchedAtMs: t - 60 * 24 * H, lastAttemptMs: t - 6 * MIN, forceRefresh: false }, "fetch"],
    ["a stale row, forced, BNR asked 4 minutes ago", { fetchedAtMs: t - 60 * 24 * H, lastAttemptMs: t - 4 * MIN, forceRefresh: true }, "cooldown"],
    ["a fresh file, forced, accepted 4 minutes ago", { fetchedAtMs: t - 4 * MIN, lastAttemptMs: 0, forceRefresh: true }, "cooldown"],
    ["a fresh file, forced, accepted an hour ago", { fetchedAtMs: t - H, lastAttemptMs: 0, forceRefresh: true }, "fetch"],
    ["nothing cached, never asked", { fetchedAtMs: 0, lastAttemptMs: 0, forceRefresh: false }, "fetch"],
    ["nothing cached, asked a minute ago", { fetchedAtMs: 0, lastAttemptMs: t - MIN, forceRefresh: false }, "cooldown"],
  ])("%s", (_name, at, expected) => {
    expect(bnr.TTL_MS).toBe(24 * H);
    expect(bnr.FAILURE_COOLDOWN_MS).toBe(5 * MIN);
    expect(bnr.fetchDecision({ nowMs: t, ...at })).toBe(expected);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx function · one request, on the row production holds", () => {
  it("the deployed row + BNR at its new address: the feed is fetched, the fresh row stored, the answer BNR and not stale", async () => {
    const store = new Store({ ...DEPLOYED_ROW });
    const wire = new Wire({ [NEW]: REAL, [OLD]: HTML_PAGE });
    const memory = bnr.newInstanceMemory();

    const got = await request(store, wire, memory, NOW);

    expect(wire.asked).toEqual([NEW, OLD]);
    expect(got).toEqual({
      base: "EUR",
      rates: { EUR: 1, RON: 5.3447, USD: EUR / USD },
      source: "BNR",
      as_of: "2026-10-02",
      fetched_at: NOW.toISOString(),
      stale: false,
    });
    // ONE write: the accepted file, fetched_at and updated_at both now.
    expect(store.writes.map((w) => w[0])).toEqual(["accepted"]);
    expect(store.row).toEqual({
      base: "EUR",
      rates: { EUR: 1, RON: 5.3447, USD: EUR / USD },
      source: "BNR",
      as_of: "2026-10-02",
      fetched_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });

    // The next request — from ANOTHER instance — is served from the row: no fetch, no write.
    const again = await request(store, wire, bnr.newInstanceMemory(), minutes(30));
    expect(wire.asked).toEqual([NEW, OLD]);
    expect(store.writes).toHaveLength(1);
    expect([again.stale, again.rates.RON, again.fetched_at]).toEqual([false, 5.3447, NOW.toISOString()]);
  });

  it("the deployed row while BNR does not answer: the August rate, MARKED STALE, never overwritten", async () => {
    const store = new Store({ ...DEPLOYED_ROW });
    const wire = new Wire({ [NEW]: HTML_PAGE, [OLD]: { status: 503, body: "" } });

    const got = await request(store, wire, bnr.newInstanceMemory(), NOW);

    expect(wire.asked).toEqual([NEW, OLD]);
    // byte for byte what the deployed function answered on 2026-10-03
    expect(got).toEqual({
      base: "EUR",
      rates: { EUR: 1, RON: 5.2489, USD: 1.1541116974494283 },
      source: "BNR",
      as_of: "2026-08-05",
      fetched_at: "2026-08-05T11:09:17.271+00:00",
      stale: true,
    });
    // the attempt is stamped on the row; the rate and its fetched_at are not touched
    expect(store.writes).toEqual([["attempt", NOW.toISOString()]]);
    expect(store.row).toEqual({ ...DEPLOYED_ROW, updated_at: NOW.toISOString() });
  });

  it("a stale row does not refetch BNR on every request: once per five minutes, whichever instance asks", async () => {
    const store = new Store({ ...DEPLOYED_ROW });
    const wire = new Wire({ [NEW]: HTML_PAGE, [OLD]: HTML_PAGE });
    const first = bnr.newInstanceMemory();

    await request(store, wire, first, NOW);
    expect(wire.asked).toHaveLength(2);
    // 40 more requests inside the window, half of them from instances that have never asked
    for (let i = 1; i <= 40; i += 1) {
      const got = await request(store, wire, i % 2 ? first : bnr.newInstanceMemory(), new Date(NOW.getTime() + i * 7_000));
      expect([got.stale, got.rates.RON]).toEqual([true, 5.2489]);
    }
    expect(wire.asked).toHaveLength(2); // ONE attempt; the deployed function asked BNR on each of the 41
    expect(store.writes).toHaveLength(1);
    // ?refresh=true does not skip the five-minute window either — the function is anonymous
    await request(store, wire, bnr.newInstanceMemory(), minutes(4.9), true);
    expect(wire.asked).toHaveLength(2);
    // past the window BNR is asked again, and the row carries the new attempt
    await request(store, wire, bnr.newInstanceMemory(), minutes(5.1));
    expect(wire.asked).toHaveLength(4);
    expect(store.row?.updated_at).toBe(minutes(5.1).toISOString());
    expect(store.row?.fetched_at).toBe(DEPLOYED_ROW.fetched_at);
  });

  it("the moment BNR answers again the stale row is replaced", async () => {
    const store = new Store({ ...DEPLOYED_ROW });
    const wire = new Wire({ [NEW]: HTML_PAGE, [OLD]: HTML_PAGE });
    expect((await request(store, wire, bnr.newInstanceMemory(), NOW)).stale).toBe(true);
    wire.answers = { [NEW]: REAL, [OLD]: HTML_PAGE };
    const got = await request(store, wire, bnr.newInstanceMemory(), minutes(6));
    expect([got.stale, got.source, got.as_of, got.rates.RON]).toEqual([false, "BNR", "2026-10-02", 5.3447]);
    expect(store.row?.as_of).toBe("2026-10-02");
  });

  it("an accepted file past its day, with BNR not answering, is served marked stale — never as current", async () => {
    const store = new Store(null);
    const wire = new Wire({ [NEW]: REAL, [OLD]: HTML_PAGE });
    const memory = bnr.newInstanceMemory();
    const first = await request(store, wire, memory, NOW);
    expect(first.stale).toBe(false);

    const inside = await request(store, wire, memory, minutes(23 * 60));
    expect([inside.stale, wire.asked.length]).toEqual([false, 2]);

    wire.answers = { [NEW]: new Error("down"), [OLD]: HTML_PAGE };
    const late = await request(store, wire, memory, minutes(25 * 60));
    expect(wire.asked).toHaveLength(4);
    expect(late.stale).toBe(true);
    expect([late.source, late.as_of, late.rates.RON]).toEqual(["BNR", "2026-10-02", 5.3447]);
    expect(late.fetched_at).toBe(first.fetched_at); // the time of the LAST GOOD fetch
  });

  it("a forced refresh inside the day: held for five minutes, then BNR is asked", async () => {
    const store = new Store(null);
    const wire = new Wire({ [NEW]: REAL, [OLD]: HTML_PAGE });
    const memory = bnr.newInstanceMemory();
    await request(store, wire, memory, NOW);
    const held = await request(store, wire, memory, minutes(2), true);
    expect([wire.asked.length, held.stale]).toEqual([2, false]);
    await request(store, wire, memory, minutes(10), true);
    expect(wire.asked).toHaveLength(4);
  });

  it("no row and no answer: the bundled fallback, marked stale; this instance asks once per window", async () => {
    const store = new Store(null);
    const wire = new Wire({ [NEW]: HTML_PAGE, [OLD]: new Error("down") });
    const memory = bnr.newInstanceMemory();
    const got = await request(store, wire, memory, NOW);
    expect(got).toEqual({
      base: "EUR",
      rates: { EUR: 1, RON: bnr.FALLBACK_RATES.RON, USD: bnr.FALLBACK_RATES.USD },
      source: "fallback",
      as_of: bnr.FALLBACK_AS_OF,
      fetched_at: NOW.toISOString(),
      stale: true,
    });
    expect(store.writes).toEqual([]); // there is no row to stamp
    await request(store, wire, memory, minutes(1));
    expect(wire.asked).toHaveLength(2);
    await request(store, wire, memory, minutes(6));
    expect(wire.asked).toHaveLength(4);
  });

  it("a row that cannot be read or written does not turn every request into a BNR fetch", async () => {
    const wire = new Wire({ [NEW]: REAL, [OLD]: HTML_PAGE });
    for (const broken of ["read", "write"] as const) {
      const store = new Store(null);
      store.readFails = broken === "read";
      store.writeFails = broken === "write";
      const memory = bnr.newInstanceMemory();
      const warned: string[] = [];
      const before = wire.asked.length;
      const first = await bnr.resolveRates({ store, fetchFn: wire.fetch, now: NOW, forceRefresh: false, memory, warn: (m) => warned.push(m) });
      expect([first.stale, first.rates.RON]).toEqual([false, 5.3447]);
      expect(warned.join(" ")).toContain(broken === "read" ? "cache read failed" : "cache write failed");
      for (let i = 1; i <= 10; i += 1) {
        const got = await request(store, wire, memory, minutes(i * 30));
        expect([got.stale, got.rates.RON, got.fetched_at]).toEqual([false, 5.3447, NOW.toISOString()]);
      }
      expect(wire.asked.length - before).toBe(2);
    }
  });

  it.each([
    ["a zero rate", { ...DEPLOYED_ROW, rates: { EUR: 1, RON: 0, USD: 1.15 } }],
    ["a rate that is text", { ...DEPLOYED_ROW, rates: { EUR: 1, RON: "5.2489", USD: 1.15 } as unknown as bnr.Rates }],
    ["no rates", { ...DEPLOYED_ROW, rates: null }],
    ["no date", { ...DEPLOYED_ROW, as_of: undefined }],
  ])("a malformed row is no row: %s", async (_name, row) => {
    const store = new Store(row as bnr.CacheRow);
    const wire = new Wire({ [NEW]: HTML_PAGE, [OLD]: HTML_PAGE });
    const got = await request(store, wire, bnr.newInstanceMemory(), NOW);
    expect([got.source, got.stale]).toEqual(["fallback", true]);
  });

  it.each([
    ["implausible (EUR ten times)", swap('<Rate currency="EUR">5.3447</Rate>', '<Rate currency="EUR">53.447</Rate>')],
    ["frozen (eleven days old)", dated("2026-09-22", "5.0001")],
    ["dateless", swap('<Cube date="2026-10-02">', "<Cube>")],
  ])("a feed that is %s is never stored and never served", async (_name, doc) => {
    const store = new Store({ ...DEPLOYED_ROW });
    const wire = new Wire({ [NEW]: doc, [OLD]: doc });
    const got = await request(store, wire, bnr.newInstanceMemory(), NOW);
    expect(wire.asked).toEqual([NEW, OLD]);
    expect([got.stale, got.rates.RON, got.as_of]).toEqual([true, 5.2489, "2026-08-05"]);
    expect(store.writes.map((w) => w[0])).toEqual(["attempt"]);
    expect(store.row?.rates).toEqual(DEPLOYED_ROW.rates);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx function · the bundled fallback is one figure in three places", () => {
  /** The engine's copy, read out of its source: a literal or `a / b`. */
  function engineConstant(name: "RON" | "USD"): number {
    const block = ENGINE_PY.match(/_FALLBACK_RATES: Dict\[str, float\] = \{([\s\S]*?)\n\}/);
    if (!block) throw new Error("fx_rates.py carries no _FALLBACK_RATES block");
    const m = block[1].match(new RegExp(`"${name}":\\s*([0-9.]+)(?:\\s*/\\s*([0-9.]+))?\\s*,`));
    if (!m) throw new Error(`fx_rates.py carries no ${name} fallback`);
    return m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
  }

  it("the engine's, the function's and the browser's fallback are equal, and say the same date", () => {
    const engineAsOf = ENGINE_PY.match(/^_FALLBACK_AS_OF = "(\d{4}-\d{2}-\d{2})"$/m)?.[1];
    for (const cur of ["RON", "USD"] as const) {
      expect(bnr.FALLBACK_RATES[cur], `function ${cur}`).toBe(engineConstant(cur));
      expect(BROWSER_FALLBACK_RATES[cur], `browser ${cur}`).toBe(engineConstant(cur));
    }
    expect([bnr.FALLBACK_RATES.EUR, BROWSER_FALLBACK_RATES.EUR]).toEqual([1, 1]);
    expect(engineAsOf).toBeDefined();
    expect(bnr.FALLBACK_AS_OF).toBe(engineAsOf);
    expect(FALLBACK_PAYLOAD.as_of).toBe(engineAsOf);
    expect([FALLBACK_PAYLOAD.source, FALLBACK_PAYLOAD.stale]).toEqual(["fallback", true]);
    expect(bnr.fallbackPayload(NOW.toISOString()).stale).toBe(true);
  });

  it("the fallback is within five percent of BNR's committed file (4.97 against 5.3447 was 7.5% off)", () => {
    expect(Math.abs(bnr.FALLBACK_RATES.RON / EUR - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(bnr.FALLBACK_RATES.USD / (EUR / USD) - 1)).toBeLessThanOrEqual(0.05);
    expect(bnr.FALLBACK_AS_OF <= "2026-10-02").toBe(true); // never a date after the file it was taken from
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("fx function · the source the redeploy bundles", () => {
  it("bnr.ts runs in Deno and in Node: no Deno global, no import, no Node-only API", () => {
    expect(BNR_TS).not.toMatch(/\bDeno\s*\./);
    expect(BNR_TS).not.toMatch(/^\s*import\s/m);
    for (const nodeOnly of [/\brequire\s*\(/, /["']node:/, /\bprocess\./, /\bBuffer\b/, /__dirname/]) {
      expect(BNR_TS).not.toMatch(nodeOnly);
      expect(INDEX_TS).not.toMatch(nodeOnly);
    }
  });

  it("index.ts imports ./bnr.ts by its extension and holds no second copy of the feed logic", () => {
    expect(INDEX_TS).toMatch(/from "\.\/bnr\.ts";/);
    expect(INDEX_TS).toMatch(/\bresolveRates\(\{/);
    // no address, no parser, no fallback figure, no TTL of its own
    expect(INDEX_TS).not.toMatch(/https:\/\/[\w.]*bnr\.ro/);
    expect(INDEX_TS).not.toMatch(/<Cube|<Rate|parseBnrXml|FALLBACK_RATES|TTL_MS/);
    // the three statements, each raising supabase-js's `error` (it does not throw)
    expect(INDEX_TS.match(/if \(error\) throw new Error\(error\.message\);/g)).toHaveLength(3);
    expect(INDEX_TS).toMatch(/\.select\("base, rates, source, as_of, fetched_at, updated_at"\)/);
    expect(INDEX_TS).toMatch(/\.update\(\{ updated_at: atIso \}\)/);
  });

  it("a stale answer is never cached by the browser; a current one for an hour", () => {
    expect(INDEX_TS).toMatch(/"Cache-Control": fresh \? "public, max-age=3600" : "no-store"/);
    expect(INDEX_TS).toMatch(/const fresh = "stale" in body && body\.stale === false;/);
  });
});
