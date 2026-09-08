// D1 — THE ENVELOPE KEY A NAME NEVER MATCHED, AND THE FINDING IT ATE.
//
// ── WHAT WAS MEASURED, ON THE COMMITTED BOOKS, 2026-09-07 ────────────
//
// `financialReport.generateRecommendations` read the fact feed off
// `statements.assembled_bs` through a `Record<string, number>`, which
// accepts any string. One line read
//
//     const intercompany = pick(ab.intercompany_loans, 0);
//
// `intercompany_loans` is the `BSFacts` spelling. The ENGINE's key is
// `ar_intercompany`, so the lookup returned `undefined` on every book
// ever served and the fact fell to its `0` fallback forever, with
// nothing raised. On agras the envelope carries 7,692,202.74 there —
// 32.15% of that book's equity — and the rule that grades related-party
// exposure could not clear its own floor, so the printed report never
// mentioned the largest single exposure on the balance sheet.
//
// `periodFacts.ts:278` had met this exact trap, documented it verbatim
// ("passing a real BSFacts key compiles clean and then MISSES on every
// lookup"), and fixed it by naming the engine's key space in the type.
// The repair was never carried to this entry point.
//
// ── WHAT THESE GATES RED ON, AFTER THE REPAIR (TC-11) ───────────────
//
//   · a name in `CANONICAL_BS_KEYS` / `_PL_` / `_CF_` that the served
//     envelope does not carry — the runtime half of the compile guard,
//     which is what catches a name that is spelled from the wrong
//     vocabulary but happens to typecheck because it was ADDED to the
//     list;
//   · a book whose related-party exposure clears the insight engine's
//     floor and whose printed export does not name it, or the reverse.
//
// ── WHAT THEY CANNOT SEE ────────────────────────────────────────────
//
//   · a key that exists in the envelope AND is the wrong concept
//     (`ppe_net` under the investment-property name typechecked, existed,
//     and was still wrong — that one is caught by the cross-surface
//     comparison in `periodFacts`, not here);
//   · a key the four committed books happen not to exercise. The key
//     space is stable across all eight fixtures in the firm directory,
//     which is the whole population this repo can measure.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  CANONICAL_BS_KEYS,
  CANONICAL_CF_KEYS,
  CANONICAL_PL_KEYS,
} from "@/lib/financialReport";
import { BOOKS, exportDoc, recommendationTexts, statementsFor } from "./exportBooks";

const firmDir = resolve(__dirname, "../../../tests/engine/fixtures/firm");

interface Assembled {
  assembled_bs?: Record<string, number>;
  assembled_pl?: Record<string, number>;
  assembled_cf?: Record<string, unknown>;
}

/** Every committed fixture in the firm directory that carries statements. */
function everyServedBook(): Array<{ name: string; st: Assembled }> {
  return readdirSync(firmDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      let parsed: { statements?: Assembled } = {};
      try {
        parsed = JSON.parse(readFileSync(resolve(firmDir, f), "utf-8"));
      } catch {
        return null;
      }
      const st = parsed.statements;
      return st && st.assembled_bs ? { name: f, st } : null;
    })
    .filter((x): x is { name: string; st: Assembled } => x !== null);
}

describe("D1 — the declared key space is the engine's key space", () => {
  const books = everyServedBook();

  it("finds served books to measure against", () => {
    expect(books.length).toBeGreaterThanOrEqual(4);
  });

  const cases: Array<[string, readonly string[], keyof Assembled]> = [
    ["assembled_bs", CANONICAL_BS_KEYS, "assembled_bs"],
    ["assembled_pl", CANONICAL_PL_KEYS, "assembled_pl"],
    ["assembled_cf", CANONICAL_CF_KEYS, "assembled_cf"],
  ];

  for (const [label, declared, field] of cases) {
    it(`every ${label} name the report reads is a key the envelope carries`, () => {
      const missing: string[] = [];
      for (const { name, st } of books) {
        const served = (st[field] ?? {}) as Record<string, unknown>;
        for (const key of declared) {
          if (!(key in served)) {
            missing.push(
              `${name}: statements.${label} carries no ${JSON.stringify(key)} — ` +
                `the report reads it and would silently take its fallback. ` +
                `Nearest served names: ${Object.keys(served)
                  .filter((k) => k.split("_").some((p) => key.includes(p)))
                  .slice(0, 4)
                  .join(", ") || "(none share a word)"}`,
            );
          }
        }
      }
      expect(missing.join("\n")).toBe("");
    });
  }
});

describe("D1 — a related-party exposure that clears the floor is named in print", () => {
  // The insight engine's ladder for this exposure (`BANDS.exposureOfEquity`
  // in recommendationRules) has its lowest rung at 2% of total equity.
  // Reading the rung from the same place the rule does is the point: this
  // gate must not carry its own copy of the cutoff (TC-10).
  const FLOOR_OF_EQUITY = 0.02;

  for (const book of BOOKS) {
    it(`${book}: the printed export names it iff the envelope says it clears the floor`, () => {
      const st = statementsFor(book) as { assembled_bs?: Record<string, number> };
      const ab = st.assembled_bs ?? {};
      const exposure = ab.ar_intercompany;
      const equity = ab.total_equity;
      expect(typeof exposure).toBe("number");
      expect(typeof equity).toBe("number");

      const share = exposure / equity;
      const shouldName = share >= FLOOR_OF_EQUITY;

      const printed = recommendationTexts(exportDoc(book));
      const named = printed.filter((t) => /related-party|intercompany/i.test(t));

      if (shouldName) {
        expect(
          named.length,
          `${book} carries ${exposure.toLocaleString("en-US")} of related-party receivables — ` +
            `${(share * 100).toFixed(2)}% of ${equity.toLocaleString("en-US")} equity, above the ` +
            `${(FLOOR_OF_EQUITY * 100).toFixed(0)}% floor — and the printed export says nothing ` +
            `about it. Recommendation cards printed: ${printed
              .map((t) => t.slice(0, 60))
              .join(" | ")}`,
        ).toBeGreaterThan(0);
        // The card must quote the SERVED figure, not a rounded guess.
        expect(named[0]).toContain(Math.round(exposure).toLocaleString("en-US"));
      } else {
        expect(
          named.length,
          `${book}'s related-party exposure is ${(share * 100).toFixed(2)}% of equity, below the ` +
            `${(FLOOR_OF_EQUITY * 100).toFixed(0)}% floor, and the export raised it anyway: ` +
            `${named.map((t) => t.slice(0, 80)).join(" | ")}`,
        ).toBe(0);
      }
    });
  }
});
