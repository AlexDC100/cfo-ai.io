// B7 — THE REPORT'S COMPARATIVES MODEL COMPUTES NO RATIO.
//
// `reportComparatives.ts` carried four ratio lines — EBITDA margin, net
// margin, equity ratio and net debt / EBITDA — each a `safeRatio` division
// of its own over `deriveTotals`, for both periods. That was a THIRD ratio
// arithmetic beside `computeRatios` and the engine's served table, and the
// only one that ever produced a prior ratio in the exported report: the
// document's page-one strip printed a change in equity ratio no other
// surface in the product agreed with. The engine is the one authority for
// both periods' ratios (`GET /api/period/{id}/comparatives → ratios`), and
// the two ratio tiles now read the served row.
//
// ── WHAT IT REDS ON, after the repair (TC-11) ─────────────────────────
//  · a comparative line whose key is a served ratio or composite, or one of
//    the ratio tiles (`SUMMARY_RATIO_TILES`), returning to the model;
//  · a line whose unit is not money;
//  · a division, `safeRatio` or `toFixed` in the module's CODE (comments
//    and string literals are stripped first, so the prose explaining the
//    removal cannot trip it and a division hidden in a template can);
//  · the executive summary's ratio tiles taking their change from a
//    comparative line instead of the served row — measured by planting a
//    prior on a book that has one and asserting the tile carries no line.
//
// ── WHAT IT CANNOT SEE ────────────────────────────────────────────────
//  · a ratio computed in ANOTHER file and fed in as a money figure. The
//    reader gates in `reportPriorCredit.test.ts` cover what reaches print.
//
// PLANTS, proven RED on 2026-09-15 (each restored after):
//  1. re-adding the `ebitda_margin` line with its `safeRatio` division to
//     `COMPARATIVE_LINES` reds "no comparative line is a ratio" (expected
//     [ 'ebitda_margin' ] to deeply equal []) and "the module's code divides
//     nothing" (… not to match /safeRatio/);
//  2. routing the equity_ratio tile past `SUMMARY_RATIO_TILES` in
//     `buildExecutiveSummary` reds "the tiles read the served row"
//     (equity_ratio: expected undefined to be 'equity_ratio').

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { buildExecutiveSummary, SUMMARY_RATIO_TILES } from "@/lib/executiveSummary";
import { computeRatios } from "@/lib/financialReport";
import { computeCreditScore } from "@/lib/financialValuation";
import { buildComparatives, COMPARATIVE_LINES } from "@/lib/reportComparatives";

import { metricsFor } from "./exportBooks";
import { pairStatements, servedRatioPair } from "./servedRatioPair";

const SOURCE = resolve(__dirname, "../reportComparatives.ts");

/** The module's code with comments and string/template literals blanked. */
function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < src.length && src[i] !== ch) i += src[i] === "\\" ? 2 : 1;
      i += 1;
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

describe("reportComparatives carries money lines only", () => {
  const servedKeys = new Set<string>([
    ...servedRatioPair().ratios.rows.map((r) => r.key),
    ...servedRatioPair().ratios.composites.map((r) => r.key),
    ...Object.keys(SUMMARY_RATIO_TILES),
    ...Object.values(SUMMARY_RATIO_TILES).map((t) => t.servedKey),
  ]);

  it("non-vacuity: the served key set is the census plus composites plus the tile aliases", () => {
    expect(servedKeys.size).toBeGreaterThanOrEqual(31);
    expect(COMPARATIVE_LINES.length).toBeGreaterThan(0);
  });

  it("no comparative line is a ratio, and every unit is money", () => {
    const ratioLines = COMPARATIVE_LINES.filter((l) => servedKeys.has(l.key));
    expect(ratioLines.map((l) => l.key), "a ratio line is back in the comparatives model").toEqual([]);
    expect(COMPARATIVE_LINES.filter((l) => l.unit !== "money").map((l) => l.key)).toEqual([]);
  });

  it("the module's code divides nothing", () => {
    const code = codeOnly(readFileSync(SOURCE, "utf-8"));
    expect(code).not.toMatch(/safeRatio/);
    expect(code).not.toMatch(/toFixed\(/);
    // A division operator: `/` not part of `//`, `/*`, `*/` (all stripped)
    // and not `/=`-free regex syntax (the module has no regex literals).
    const divisions = code.split("\n").filter((line) => /[^/*]\/[^/*=]/.test(line));
    expect(divisions, "a division in reportComparatives.ts").toEqual([
      // the one permitted division: a money line's percentage change,
      // (current − comparison) ÷ |comparison|, which is not a ratio of two
      // statement figures but the variance of one.
      expect.stringMatching(/percent: .*absolute .*Math\.abs\(comparison\)/),
    ]);
  });

  it("a book WITH a prior: the model has no line for either ratio tile, and the tiles read the served row", () => {
    const s = pairStatements();
    const c = buildComparatives(s);
    expect(c.available, "the prior must reach the model for this to prove anything").toBe(true);
    for (const [tile, spec] of Object.entries(SUMMARY_RATIO_TILES)) {
      expect(c.lines.find((l) => l.key === tile || l.key === spec.servedKey), tile).toBeUndefined();
    }
    const metrics = metricsFor("agras");
    const summary = buildExecutiveSummary(s, computeRatios(s, undefined, metrics), computeCreditScore(s, undefined, undefined, metrics));
    for (const tile of summary.tiles.filter((t) => t.key in SUMMARY_RATIO_TILES)) {
      expect(tile.line, tile.key).toBeNull();
      expect(tile.ratio?.row?.key, tile.key).toBe(SUMMARY_RATIO_TILES[tile.key].servedKey);
    }
  });
});
