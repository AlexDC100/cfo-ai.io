// GATE one-ebitda (owner ruling R2, 2026-09-28) — BUDGET VARIANCE READS THE
// SERVED EBITDA → EBIT CHAIN, IT DOES NOT REBUILD IT.
//
// THE DEFECT (review 2026-10-02). `buildActualLines` computed the Actual
// column's EBIT in the browser as EBITDA − `metrics.depreciation`. That
// bucket is the income statement's whole 68x — it still holds the 6812 /
// 6814 provision charges — while the EBITDA beside it is the served one,
// which since R2 no longer holds the 7812 / 7814 reversals. Before R2 the
// subtraction happened to equal the served operating result; since R2 it is
// short by exactly the reversals: agras 3,988.70 low, the Scandia baseline
// 8,415,275.41 low (32,898,302.52 against a served 41,313,577.93). The same
// function feeds the "last year from a period" column (comparePeriod). The
// page is hidden at launch (`_features.py`: variance) — the arithmetic was
// wrong all the same, and silently.
//
// LAW, on the four firm books (real engine output, tests/engine/fixtures/
// firm): the Actual column's
//   · EBIT is `assembled_pl.ebit`, to the cent;
//   · D&A is `assembled_pl.depreciation` (without the ruled charges);
//   · net provisions is the served block's value (charge-signed, as D&A);
//   · and the three printed rows foot: EBITDA − D&A − net provisions = EBIT.
// The row is printed only where a column carries it. A payload the engine
// did not assemble keeps its own one-bucket arithmetic.
// REDS ON: EBIT derived from EBITDA and the 68x bucket; the D&A row holding
// the provision charges; the net-provisions row missing on a book that posts
// them (the column then does not foot), or printed empty on one that does
// not.
// Plant-proven (docs/engine_book/gates.md, "one-ebitda"): the old
// subtraction restored reds the three books that post reversals.
// CANNOT SEE: whether the served figures are right (provisions-symmetric,
// one-definition-served); the page's pixels.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Statements } from "@/lib/financialReport";
import { buildDemoStatements } from "@/lib/demo/demoFinancials";
import { actualLinesFor } from "../comparePeriod";
import { buildVarianceRows } from "../buildVariance";

type Json = Record<string, unknown>;
const repoRoot = resolve(__dirname, "../../../..");
const book = (name: string) =>
  JSON.parse(
    readFileSync(resolve(repoRoot, `tests/engine/fixtures/firm/saga_10_col_${name}.json`), "utf-8"),
  ) as { statements: Statements & { assembled_pl: Json; incomeStatement: Json } };

const BOOKS = ["agras", "carniprod", "retail", "realestate"] as const;
const cent = (v: number) => Math.round(v * 100) / 100;

describe("Budget Variance — the Actual column reads the served EBITDA → EBIT chain (R2)", () => {
  it("the witnesses: three books post reversals, so EBITDA − all of 68x is NOT the served operating result", () => {
    let differing = 0;
    for (const name of BOOKS) {
      const s = book(name).statements;
      const apl = s.assembled_pl;
      const all68x = s.incomeStatement.depreciationAmortization as number;
      const rebuilt = cent((apl.ebitda as number) - all68x);
      const reversals = ((apl.net_provisions as Json).reversals as Json).value as number;
      // The old subtraction is short by exactly the served reversals.
      expect(cent((apl.ebit as number) - rebuilt), name).toBeCloseTo(reversals, 2);
      if (Math.abs(reversals) >= 0.005) differing += 1;
    }
    expect(differing, "books on which the old arithmetic is wrong").toBe(3);
  });

  for (const name of BOOKS) {
    it(`${name}: EBIT, D&A and net provisions are the served figures, and the rows foot`, () => {
      const s = book(name).statements;
      const apl = s.assembled_pl;
      const np = apl.net_provisions as Json;
      const lines = actualLinesFor(s);
      expect(lines.ebit, "EBIT is assembled_pl.ebit").toBe(apl.ebit);
      expect(lines.depreciation, "D&A is assembled_pl.depreciation").toBe(apl.depreciation);
      expect(lines.net_provisions, "net provisions is the served block's value").toBe(np.value);
      expect(lines.ebitda, "EBITDA is the served one").toBe(apl.ebitda);
      expect(
        cent((lines.ebitda as number) - (lines.depreciation as number) - (lines.net_provisions as number)),
        "EBITDA − D&A − net provisions = EBIT, as printed",
      ).toBeCloseTo(lines.ebit as number, 2);

      const keys = buildVarianceRows(lines, null).map((r) => r.key);
      const posts = Math.abs(np.value as number) >= 0.005;
      expect(keys.includes("net_provisions"), `the row is printed only where carried (${name})`).toBe(posts);
      if (posts) {
        expect(keys.indexOf("net_provisions"), "between D&A and EBIT").toBe(keys.indexOf("depreciation") + 1);
        expect(keys.indexOf("ebit")).toBe(keys.indexOf("net_provisions") + 1);
      }
    });
  }

  it("a refused EBITDA refuses EBIT too — never a figure rebuilt from the buckets", () => {
    const s = JSON.parse(JSON.stringify(book("agras").statements)) as Statements & { assembled_pl: Json };
    s.assembled_pl.ebitda = null;
    s.assembled_pl.ebit = null;
    s.assembled_pl.ebitda_refusal = { code: "x", text_ro: "refuzat", text_en: "refused" };
    const lines = actualLinesFor(s);
    expect(lines.ebitda).toBeNull();
    expect(lines.ebit).toBeNull();
  });

  it("a net-provisions figure in the last-year column alone still prints the row", () => {
    const lines = actualLinesFor(book("realestate").statements);
    expect(buildVarianceRows(lines, null).some((r) => r.key === "net_provisions")).toBe(false);
    const rows = buildVarianceRows(lines, { budget: {}, lastYear: { net_provisions: 1250.5 }, source: "upload" });
    const row = rows.find((r) => r.key === "net_provisions");
    expect(row?.lastYear).toBe(1250.5);
  });

  it("a payload the engine did not assemble keeps its own arithmetic (one D&A bucket, no split)", () => {
    const demo = buildDemoStatements();
    const prior = (demo.historicalPeriods ?? [])[0];
    expect(prior, "the demo carries an in-statement historical year").toBeDefined();
    const s: Statements = {
      companyName: demo.companyName,
      industry: demo.industry,
      currency: demo.currency,
      periodLabel: prior.periodLabel,
      balanceSheet: prior.balanceSheet,
      incomeStatement: prior.incomeStatement,
      supplementary: {},
    };
    const lines = actualLinesFor(s);
    expect(lines.net_provisions).toBeNull();
    expect(lines.depreciation).toBe(prior.incomeStatement.depreciationAmortization);
    if (lines.ebitda !== null && lines.depreciation !== null) {
      expect(lines.ebit).toBeCloseTo(lines.ebitda - lines.depreciation, 2);
    }
  });
});
