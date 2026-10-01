// Positioning gates G4 + G5 — REWRITTEN 2026-10-01.
//
// WHAT THESE GATES USED TO ASSERT, AND WHY THAT WAS THE DEFECT
//   G4 pinned a "marquee" row of seven markets — United States, Germany,
//   United Kingdom, France, Italy, Spain, UAE — in lib/markets.ts, which the
//   landing rendered under the hero beside "Any other country accepted".
//   G5 froze the dropdown label 'intl: "International (IFRS-style
//   reading)"' and forbade only the words supported / certified /
//   guaranteed next to it.
//
//   Both gates were green for a month over a claim no test supported: no
//   real book from any of the seven countries exists in the repository, a
//   file from them with no country chosen is read as Romanian, and the
//   upload dialog's country choice never reached the engine. The gates
//   asserted the ORDER of the overclaim and the POLITENESS of its verb. A
//   red here on the day the row was removed would have read as "the fix
//   broke a gate" — which is how a wrong gate defends a defect (CLAUDE.md
//   §23, TC-11).
//
// WHAT THEY ASSERT NOW
//   G4  there is no market row: lib/markets.ts is gone, nothing imports
//       it, and the landing lists no country as accepted.
//   G5  the per-document TRUST copy is still frozen (AI-read, dual-verified,
//       the re-extraction honesty line) — that half was right — and the
//       upload dialog's other-country group SAYS it is not supported.
//
// WHAT THEY RED ON, AFTER THE REPAIR
//   · lib/markets.ts (or any MARQUEE / ACCEPTANCE_LINE export) coming back;
//   · a country name other than Romania in the landing copy outside the
//     sentence about where the AI model provider is;
//   · the dropdown group losing "not supported yet" / "încă nesuportate",
//     or the generic row calling itself "International";
//   · any change to the AI-read / dual-verified trust strings.
//
// The precise, rendered check of every public surface is `public-claims`
// (publicClaims.test.tsx); the tree-wide static lint is
// scripts/check_global_positioning.mjs G3.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LANDING_STRINGS } from "@/pages/cfo/landingStrings";

const FRONTEND = join(__dirname, "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("G4 — there is no market row", () => {
  it("lib/markets.ts is gone and nothing imports it", () => {
    expect(existsSync(join(FRONTEND, "lib", "markets.ts"))).toBe(false);
    const files = sources(FRONTEND);
    expect(files.length, "the walk found no sources").toBeGreaterThan(400);
    const importers = files.filter((f) =>
      /from\s+["'](?:@\/lib\/markets|\.{1,2}\/(?:lib\/)?markets)["']/.test(readFileSync(f, "utf-8")),
    );
    expect(importers).toEqual([]);
    const revived = files.filter((f) =>
      /\bexport const (MARQUEE|ACCEPTANCE_LINE|TIER_LABELS)\b/.test(readFileSync(f, "utf-8")),
    );
    expect(revived, "a market row or an acceptance line is exported again").toEqual([]);
  });

  it("the landing copy names no country but Romania as readable", () => {
    // EVERY region the runtime can name, in English and Romanian, minus
    // Romania — generated. This was a typed list of eleven countries until
    // 2026-10-02, and "Austria · Czechia · Greece · Netherlands · Portugal ·
    // Serbia · Croatia" passed it (and `public-claims` C1, which carried the
    // same list).
    const names = new Set<string>(["USA", "UAE", "Czechia", "Cehia", "Olanda", "Holland"]);
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const locale of ["en", "ro"]) {
      const display = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
      for (const a of A) for (const b of A) {
        if (a + b === "RO") continue;
        const name = display.of(a + b);
        if (name && name.length >= 4) names.add(name);
      }
    }
    expect(names.size, "the region vocabulary collapsed").toBeGreaterThan(400);
    const escaped = [...names].sort((x, y) => y.length - x.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const COUNTRY = new RegExp(`(?<![\\p{L}-])(?:${escaped.join("|")})(?![\\p{L}-])`, "u");
    for (const probe of ["Austria", "Greece", "Grecia", "Portugal", "Serbia", "Germany", "Ungaria"]) {
      expect(COUNTRY.test(`from ${probe} too`), `${probe} is not detected`).toBe(true);
    }
    expect(COUNTRY.test("a Romanian trial balance from Romania / România")).toBe(false);
    const lines: Array<[string, string]> = [];
    const flat = (o: unknown, path: string) => {
      if (typeof o === "string") lines.push([path, o]);
      else if (Array.isArray(o)) o.forEach((v, i) => flat(v, `${path}[${i}]`));
      else if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) flat(v, path ? `${path}.${k}` : k);
      }
    };
    for (const lang of ["en", "ro"]) flat(LANDING_STRINGS[lang], lang);
    expect(lines.length).toBeGreaterThan(300);
    const named = lines
      .flatMap(([where, text]) =>
        text.split(/(?<=[.!?])\s+/).map((sentence) => [where, sentence] as const))
      .filter(([, sentence]) => COUNTRY.test(sentence))
      // The one sentence that may name another country says where the AI
      // model provider is — a data-handling fact, not coverage.
      .filter(([, sentence]) => !/model provider|furnizorului nostru de model/i.test(sentence))
      .map(([where, sentence]) => `${where}: ${sentence}`);
    expect(named).toEqual([]);
    for (const lang of ["en", "ro"]) {
      expect("global" in LANDING_STRINGS[lang], `${lang}: the global strip's copy is back`).toBe(false);
    }
  });
});

describe("G5 — trust copy is frozen; the other-country group says what is true", () => {
  const src = readFileSync(
    join(FRONTEND, "components", "cfo", "bsCanonicalStatusI18n.ts"),
    "utf-8",
  );

  // Per-document trust honesty must not drift. These strings are
  // snapshot-locked; changing one requires editing THIS test with a
  // written rationale (golden-change discipline).
  it("the AI-lane trust strings are byte-identical to the frozen set", () => {
    // The dual-verification claim (EN + RO) — the heart of the badge.
    expect(src).toContain('dualVerified: "dual-verified"');
    expect(src).toContain('dualVerified: "dublu verificat"');
    // The re-extraction honesty line: AI re-reads, stated plainly.
    expect(src).toContain('reextractBody: "Re-extraction re-reads the document with AI."');
    // The jurisdiction badge label itself.
    expect(src).toContain('badge: "Jurisdiction"');
    // The permanent provenance badge of a model-read period.
    expect(src).toContain('label: "AI-read"');
    expect(src).toContain('label: "Citit de AI"');
  });

  it("the other-country group is headed 'not supported yet' in both languages", () => {
    // RATIONALE FOR THE GOLDEN CHANGE (2026-10-01): this assertion used to
    // pin 'intl: "International (IFRS-style reading)"' under a group headed
    // "International". No file from another country is analysed correctly
    // today (frontend/data/coverage.json, row other_countries).
    expect(src).toContain('groupIntl: "Other countries — not supported yet"');
    expect(src).toContain('groupIntl: "Alte țări — încă nesuportate"');
    expect(src).toContain('intl: "Other country (IFRS-style reading)"');
    expect(src).toContain('intl: "Altă țară (citire tip IFRS)"');
    expect(src).not.toMatch(/(intl|groupIntl):\s*"[^"]*(International|Internațional)/);
    expect(src).not.toMatch(/intl:.*(supported|certified|guaranteed)"/i);
  });

  it("the dropdown disables every other-country row it does not already carry", () => {
    const select = readFileSync(
      join(FRONTEND, "components", "cfo", "JurisdictionSelect.tsx"),
      "utf-8",
    );
    expect(select).toContain("disabled={code !== current}");
  });
});
