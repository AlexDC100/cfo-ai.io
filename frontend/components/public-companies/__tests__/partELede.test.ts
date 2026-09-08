// DOD4 — the page lede is GLOBAL, and it actually reaches the screen.
//
// This gate exists because the first attempt at this edit LOOKED right
// and shipped the old sentence anyway: `pci.header.subtitle` is already
// present in frontend/i18n/locales/{en,ro}.json, and a component bundle
// registered with `overwrite=false` cannot displace a key the locale
// files carry — so the new copy registered and lost, silently, and the
// page kept describing only the Bucharest Stock Exchange.
//
// A test that only asserted the STRING would have passed while the
// screen was wrong. So this file asserts both halves: the copy, and the
// key the page actually renders.
//
// ── 2026-09-08 — THIS GATE HAD PINNED A DEFECT ────────────────────────
// Two of its assertions were a byte-for-byte pin of the shipped sentence
// ("is the agreed sentence, byte for byte") and a requirement that the
// lede name China and the UAE ("names the market groups", "ships in
// Romanian too" / `Emiratele Arabe Unite`). Both `cn` and `ae` carry
// `status: awaiting_provider` and `fundamentals_source: none` in
// `src/engine/public_market/markets.yaml`, so the gate REQUIRED the page
// to claim listed-company financials from two markets that cannot
// produce a single figure — and would have gone red on the repair,
// reading to the next engineer as a reason to revert it.
//
// The copy assertions are now DERIVED FROM THE REGISTRY instead of
// pinned to a sentence: a market may be named in the lede only while it
// has a fundamentals feed. Flip `cn` to a real source in markets.yaml
// and naming China becomes legal here with no edit to this file; let a
// market go dark and naming it reds. The three assertions that were the
// actual point of the file — the lede reaches the screen, it is not
// Bucharest-only, it makes no deterministic-grade claim — are untouched.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { pcmEn, pcmRo } from "../marketI18n";
import { pciEn, pciRo } from "../pciI18n";

const PAGE = readFileSync(
  join(__dirname, "..", "..", "..", "pages", "cfo", "PublicCompanyIntelligence.tsx"),
  "utf-8",
);

const REGISTRY = readFileSync(
  join(__dirname, "..", "..", "..", "..", "src", "engine", "public_market", "markets.yaml"),
  "utf-8",
);

/** {market_id → {status, fundamentals_source}} straight off markets.yaml.
 *  Flat two-space block sequence, so a line scan is enough and pulls in
 *  no YAML dependency. */
function parseMarketRegistry(): Record<string, { status: string; fundamentals: string }> {
  const out: Record<string, { status: string; fundamentals: string }> = {};
  let id: string | null = null;
  for (const raw of REGISTRY.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    let m = /^\s*-\s*market_id:\s*([a-z]+)\s*$/.exec(line);
    if (m) {
      id = m[1];
      out[id] = { status: "", fundamentals: "" };
      continue;
    }
    if (!id) continue;
    m = /^\s+status:\s*([a-z_]+)\s*$/.exec(line);
    if (m) out[id].status = m[1];
    m = /^\s+fundamentals_source:\s*([A-Za-z0-9_.]+)\s*$/.exec(line);
    if (m) out[id].fundamentals = m[1];
  }
  return out;
}

const MARKETS = parseMarketRegistry();

/** How each market may be NAMED in prose, in both languages. Keyed by
 *  registry id so a market that leaves the registry leaves this map. */
const MARKET_WORDS: Record<string, RegExp> = {
  us: /\bthe US\b|United States|Statele Unite/i,
  de: /\bGermany\b|\bGermania\b/i,
  uk: /United Kingdom|Regatul Unit/i,
  fr: /\bFrance\b|\bFranța\b/i,
  it: /\bItaly\b|\bItalia\b/i,
  es: /\bSpain\b|\bSpania\b/i,
  cn: /\bChina\b/i,
  ae: /\bthe UAE\b|United Arab Emirates|Emiratele Arabe Unite/i,
};

describe("DOD4 — the lede copy", () => {
  it("reads the real market registry, not an empty file (floor)", () => {
    expect(Object.keys(MARKETS).length).toBeGreaterThanOrEqual(9);
    expect(MARKETS.ro?.status).toBe("live");
    expect(MARKETS.us?.status).toBe("live");
    expect(MARKETS.cn?.fundamentals).toBe("none");
    expect(MARKETS.ae?.fundamentals).toBe("none");
    expect(MARKETS.de?.fundamentals).toBe("none");
  });

  it("names no market the registry says has no fundamentals feed", () => {
    const offences: string[] = [];
    for (const [id, rx] of Object.entries(MARKET_WORDS)) {
      const reg = MARKETS[id];
      if (!reg || reg.fundamentals !== "none") continue;
      for (const [lang, lede] of [["en", pcmEn.lede], ["ro", pcmRo.lede]] as const) {
        const hit = rx.exec(lede);
        if (hit) {
          offences.push(
            `lede[${lang}] names "${hit[0]}" — markets.yaml gives market "${id}" ` +
              `fundamentals_source: none (status ${reg.status}), so the platform ` +
              `cannot produce one figure for it`,
          );
        }
      }
    }
    expect(offences.join("\n")).toBe("");
  });

  it("still names the markets that ARE live, and headlines no lone European country", () => {
    // The half of the original assertion that was correct: the lede is
    // global, so it must name more than the home market.
    expect(pcmEn.lede).toMatch(MARKET_WORDS.us);
    expect(pcmEn.lede).toMatch(/Romania/);
    expect(pcmRo.lede).toMatch(MARKET_WORDS.us);
    // A single European country named on its own would be a headline.
    for (const id of ["de", "uk", "fr", "it", "es"]) {
      expect(pcmEn.lede, `lede headlines ${id}`).not.toMatch(MARKET_WORDS[id]);
      expect(pcmRo.lede, `lede[ro] headlines ${id}`).not.toMatch(MARKET_WORDS[id]);
    }
  });

  it("promises no market-price coverage the price slot cannot deliver", () => {
    // Every non-RO market's price_source is `licensed_provider_slot`,
    // dark until PROVIDER_API_KEY is set, and prices.py omits RO by
    // design. An unconditional "with market prices" was the second
    // overstatement in the pinned sentence.
    for (const [lang, lede] of [["en", pcmEn.lede], ["ro", pcmRo.lede]] as const) {
      expect(lede, `lede[${lang}]`).not.toMatch(
        /with market prices|cu prețuri de piață|live prices|prețuri în timp real/i,
      );
    }
  });

  it("no longer describes only the Bucharest Stock Exchange", () => {
    expect(pcmEn.lede).not.toMatch(/bucharest/i);
    expect(pcmRo.lede).not.toMatch(/bursa de valori/i);
  });

  it("keeps the deterministic-grade claim OUT of the global lede", () => {
    // Romania's grade is Romania's. Claiming it in a sentence that also
    // covers markets with no feed at all would be the loudest untruth on
    // the page.
    expect(pcmEn.lede).not.toMatch(/machine-verified|deterministic/i);
    expect(pcmEn.ro.grade).toMatch(/deterministic home market/i);
    expect(pcmRo.ro.grade.length).toBeGreaterThan(0);
  });

  it("ships in Romanian too", () => {
    expect(pcmRo.lede).toMatch(/România/);
    // Was `/Emiratele Arabe Unite/` — a required mention of a market with
    // no feed. The Romanian half is now proven by length + the shared
    // registry assertions above, which run over BOTH languages.
    expect(pcmRo.lede.length).toBeGreaterThan(80);
    expect(pcmRo.lede).not.toBe(pcmEn.lede);
  });
});

describe("DOD4 — the lede actually renders", () => {
  it("the page reads pcm.lede", () => {
    expect(PAGE).toContain('t("pcm.lede")');
  });

  it("the page no longer reads the locale-owned pci.header.subtitle", () => {
    // This is the assertion that would have caught the silent failure.
    expect(PAGE).not.toContain('t("pci.header.subtitle")');
  });

  it("the pci bundle no longer carries a competing subtitle", () => {
    // Two ledes is one lede too many; whichever won would be a coin toss
    // decided by locale-file merge order.
    expect(pciEn.header).not.toHaveProperty("subtitle");
    expect(pciRo.header).not.toHaveProperty("subtitle");
  });
});
