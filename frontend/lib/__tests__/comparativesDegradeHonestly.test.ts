/**
 * COMPARATIVES — both paths, and the degraded one says so.
 *
 * Before `reportComparatives.ts` the report had no comparatives of any
 * kind: not a value, not a gap, not a sentence. A document opening with
 * "Revenue RON 118.58M" answered nothing about direction, and the reader
 * has no way to tell a company that grew 40% from one that shrank 40%.
 *
 * The two paths and where each is real:
 *
 *   DEGRADED — every private RO book. `statements.prior` is undefined on
 *     all four committed `saga_10_col_*.json` and nothing in the engine
 *     populates it for a trial-balance upload. The model must then say
 *     "No comparatives — position report, not performance report", and
 *     must NOT emit 0, "0.0%", "flat", or a dash: each of those is a
 *     claim about a period nobody has.
 *
 *   REAL — `fixtures/publicCompany/aapl_envelope.json`, which carries
 *     TWO real periods (FY2024 ending 2024-09-28 and FY2023 ending
 *     2023-09-30) and whose adapter already fills `prior`. Revenue
 *     391,035M against 383,285M is +7,750M / +2.02%; net income
 *     93,736M against 96,995M is −3,259M / −3.36%. Both checkable
 *     against the fixture's own `headline` block, which is what the
 *     assertions below recompute from — not against a number typed here.
 *
 * WHAT THIS GATE REDS ON (TC-11)
 *   · a degraded variance that carries a number — the "0 means no
 *     change" defect;
 *   · a degraded variance with no stated reason;
 *   · a real variance computed the wrong way round, or against the
 *     wrong side;
 *   · an annual book printing its single prior period under two
 *     different column headings as though they were two comparisons.
 *
 * WHAT IT CANNOT SEE
 *   · the RENDER. Lane C draws this model; a renderer that receives a
 *     stated gap and prints "—" anyway is invisible here. That gate
 *     belongs beside the export once the section exists.
 *   · a quarterly book's prior-year lookup (four entries back in
 *     `historicalPeriods`). No committed fixture carries quarterly
 *     history, so that branch is typed and reasoned but not measured.
 */

import { describe, expect, it } from "vitest";

import { BOOKS, statementsFor, type Book } from "./exportBooks";
import {
  NO_COMPARATIVES_NOTE,
  buildComparatives,
  comparativeLine,
  formatVariance,
  NO_COMPARATIVE_CELL,
} from "@/lib/reportComparatives";
import { buildPublicStatements } from "@/lib/publicCompanyAdapters";
import type { PublicCompanyEnvelope } from "@/lib/publicCompanyApi";
import envelopeJson from "./fixtures/publicCompany/aapl_envelope.json";
import * as XLSX from "xlsx";
import { buildExcelWorkbook } from "@/lib/financialExports";

const AAPL = envelopeJson as unknown as PublicCompanyEnvelope;

describe("comparatives — the degraded form, on every book that has none", () => {
  it.each(BOOKS)("%s: says so, and states no number", (book: Book) => {
    const c = buildComparatives(statementsFor(book));
    expect(c.available, `${book} unexpectedly has comparatives`).toBe(false);
    expect(c.degradedNote).toBe("No comparatives — position report, not performance report");
    expect(c.degradedReason, book).not.toBeNull();
    expect(c.periods, book).toEqual([]);
    expect(c.lines.length, book).toBeGreaterThanOrEqual(6);
    for (const line of c.lines) {
      for (const kind of ["prior_period", "prior_year"] as const) {
        const v = line.vs[kind];
        expect(v.absolute, `${book}/${line.key}/${kind} absolute`).toBeNull();
        expect(v.percent, `${book}/${line.key}/${kind} percent`).toBeNull();
        expect(v.direction, `${book}/${line.key}/${kind} direction`).toBeNull();
        expect(v.unavailable, `${book}/${line.key}/${kind} states no reason`).toBeTruthy();
      }
    }
  });

  it.each(BOOKS)("%s: the CURRENT figure is still there — a position report is still a report", (book: Book) => {
    const c = buildComparatives(statementsFor(book));
    expect(comparativeLine(c, "revenue")!.current, book).not.toBeNull();
    expect(comparativeLine(c, "total_assets")!.current, book).not.toBeNull();
  });

  it("the printed form of an absent variance is the sentence, never a zero or a dash", () => {
    const c = buildComparatives(statementsFor("agras"));
    const printed = formatVariance(comparativeLine(c, "revenue")!.vs.prior_period, "money");
    expect(printed).toBe(NO_COMPARATIVES_NOTE);
    expect(printed).not.toMatch(/^[-—–]$/);
    expect(printed).not.toMatch(/\b0(\.0+)?%?\b/);
  });
});

describe("comparatives — the WORKBOOK's own comparison column", () => {
  // The xlsx export has had a prior column and "Δ Abs" / "Δ %" headers
  // since it shipped. On every book the private path serves there is no
  // prior period, so it printed a column HEADED "—" with "—" in the
  // prior cell and both delta cells EMPTY. In a spreadsheet an empty
  // delta and a zero delta read the same at a glance, and a dash beside
  // a figure reads as "no change" at least as often as "no data".
  const SHEETS: Array<[string, string, string]> = [
    ["P&L", "Profit & Loss", "Revenue"],
    ["Balance Sheet", "Balance Sheet", "Cash & equivalents"],
  ];

  it.each(BOOKS)("%s: says there is no comparison rather than dashing it", (book: Book) => {
    const wb = buildExcelWorkbook(statementsFor(book));
    for (const [sheet, headerLabel, firstRow] of SHEETS) {
      const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[sheet], {
        header: 1,
        defval: "",
      });
      const header = rows.find((r) => r[0] === headerLabel);
      expect(header, `${book}/${sheet} has no header row`).toBeDefined();
      expect(header![2], `${book}/${sheet} comparison column header`).toBe(NO_COMPARATIVES_NOTE);
      const row = rows.find((r) => r[0] === firstRow);
      expect(row, `${book}/${sheet} has no "${firstRow}" row`).toBeDefined();
      for (const col of [2, 3, 4]) {
        expect(row![col], `${book}/${sheet} col ${col}`).toBe(NO_COMPARATIVE_CELL);
        expect(row![col], `${book}/${sheet} col ${col} is a dash`).not.toBe("—");
        expect(row![col], `${book}/${sheet} col ${col} is blank`).not.toBe("");
        expect(row![col], `${book}/${sheet} col ${col} is a number`).not.toBeTypeOf("number");
      }
    }
  });
});

describe("comparatives — the real form, on a book that carries two periods", () => {
  const built = buildPublicStatements(AAPL)!;
  const c = buildComparatives(built.statements);

  it("is not vacuous: the fixture really carries two distinct periods", () => {
    expect(AAPL.periods.length).toBe(2);
    expect(AAPL.periods[0].fiscal_period_end).not.toBe(AAPL.periods[1].fiscal_period_end);
    expect(c.available).toBe(true);
  });

  it("revenue moves by the difference between the two filings' own headline figures", () => {
    const cur = AAPL.periods[0].headline!.revenue as number;
    const prev = AAPL.periods[1].headline!.revenue as number;
    const v = comparativeLine(c, "revenue")!.vs.prior_period;
    expect(v.absolute).toBeCloseTo(cur - prev, 0);
    expect(v.percent).toBeCloseTo(((cur - prev) / Math.abs(prev)) * 100, 6);
    expect(v.direction).toBe(cur > prev ? "up" : cur < prev ? "down" : "flat");
    expect(v.unavailable).toBeNull();
  });

  it("EVERY OTHER LINE REFUSES, and names the input that made it incomparable", () => {
    // The measurement that shaped the module. The AAPL current period
    // declares sixteen absent inputs and the adapter plugs
    // `otherNonCurrentAssets` with 294,341M so reconstructed total
    // assets reproduces the filed 364,980M. The prior side gets no such
    // plug (its `otherNonCurrentAssets` is 0), so `deriveTotals` reads
    // its assets as 65,804M against a filed 352,583M. A first draft of
    // this module subtracted those and reported total assets UP
    // 299,176M — +454% — on a company whose assets grew 12,397M.
    const refused = c.lines.filter((l) => !l.comparable).map((l) => l.key);
    expect(refused).toContain("total_assets");
    expect(refused).toContain("net_income");
    expect(refused).toContain("ebitda");
    expect(refused).toContain("gross_profit");
    for (const key of refused) {
      const v = comparativeLine(c, key)!.vs.prior_period;
      expect(v.absolute, `${key} still carries a number`).toBeNull();
      expect(v.unavailable, `${key} refuses without saying why`).toBeTruthy();
    }
    // the refusal is specific, not a blanket sentence
    expect(comparativeLine(c, "total_assets")!.vs.prior_period.unavailable).toContain(
      "otherNonCurrentAssets",
    );
    expect(comparativeLine(c, "gross_profit")!.vs.prior_period.unavailable).toContain(
      "costOfGoodsSold",
    );
  });

  it("the refusal is CONDITIONAL — a source that declares nothing absent compares everything", () => {
    // Non-vacuity for the comparability rule: the same book with the
    // absence manifest and the reported totals removed compares every
    // line. This is the shape a Romanian trial balance has — the line
    // items ARE the source — so the private path loses nothing to this
    // rule the moment a prior period reaches it.
    const bare = {
      ...built.statements,
      absentInputs: undefined,
      reportedTotals: undefined,
    };
    const open = buildComparatives(bare);
    expect(open.lines.every((l) => l.comparable)).toBe(true);
    expect(open.lines.every((l) => l.vs.prior_period.absolute !== null)).toBe(true);
  });

  it("the reported-total half of the rule reds on its own shape", () => {
    // MEASURED HONESTLY (TC-11): planting this half away does NOT red
    // any assertion above, because on the one committed two-period
    // fixture every line it would block is already blocked by the
    // absence manifest. So it is proven here on the shape it exists
    // for — a source that reports a total WITHOUT declaring any input
    // absent, which is what a vendor feed carrying `ebitda` but no cost
    // breakdown looks like. Nothing about the money is invented: the
    // periods are the fixture's own; only the two manifests move.
    const reportsTotalsOnly = {
      ...built.statements,
      absentInputs: undefined,
      reportedTotals: { ebitda: 134661000000 } as const,
    };
    const c2 = buildComparatives(reportsTotalsOnly);
    const ebitda = comparativeLine(c2, "ebitda")!;
    expect(ebitda.comparable).toBe(false);
    expect(ebitda.vs.prior_period.absolute).toBeNull();
    expect(ebitda.vs.prior_period.unavailable).toContain("reported directly");
    // and revenue, which no reported total covers, still compares
    expect(comparativeLine(c2, "revenue")!.comparable).toBe(true);
  });

  it("an annual book does not print one prior period under two headings", () => {
    // FY2024 vs FY2023: "previous" and "last year" name the SAME filing.
    // Two columns of the identical number would be one concept printed
    // twice — the R1 defect wearing a column heading.
    const py = c.periods.find((p) => p.kind === "prior_year");
    expect(py, "no prior-year comparison was offered at all").toBeDefined();
    expect(py!.sameAsPriorPeriod).toBe(true);
    expect(py!.heading).toContain("the same period");
    for (const line of c.lines) {
      expect(line.vs.prior_year.absolute, line.key).toBe(line.vs.prior_period.absolute);
    }
  });
});
