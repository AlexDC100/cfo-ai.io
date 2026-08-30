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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { pcmEn, pcmRo } from "../marketI18n";
import { pciEn, pciRo } from "../pciI18n";

const PAGE = readFileSync(
  join(__dirname, "..", "..", "..", "pages", "cfo", "PublicCompanyIntelligence.tsx"),
  "utf-8",
);

const LEDE =
  "Listed-company financials from Romania, the US, Europe, China and the UAE — " +
  "from official filings, with market prices. Add any company as a benchmark peer " +
  "and it sits next to your private books.";

describe("DOD4 — the lede copy", () => {
  it("is the agreed sentence, byte for byte", () => {
    expect(pcmEn.lede).toBe(LEDE);
  });

  it("names the market groups and headlines no single foreign country", () => {
    for (const region of ["Romania", "the US", "Europe", "China", "the UAE"]) {
      expect(pcmEn.lede).toContain(region);
    }
    // A country named on its own outside the list would be a headline.
    expect(pcmEn.lede).not.toMatch(/germany|france|italy|spain|united kingdom/i);
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
    expect(pcmRo.lede).toMatch(/Emiratele Arabe Unite/);
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
