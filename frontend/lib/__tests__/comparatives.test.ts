// comparatives.ts — the default prior, the parity guard, and the row map
// MEASURED against the real committed analytic book.
//
// WHAT THESE RED ON, with the module correct (TC-11):
//   · AUTO picking the current period, a later one, or a different
//     fiscal cut when a same-cut earlier period exists
//   · the parity guard letting a prior render beside a row whose amount
//     is not the engine's current figure for that line
//   · the definition guard letting "Total operating revenue" carry the
//     net-turnover cells while either period carries 722 (the current's
//     as stated, the prior's as served), or reading a refused memo as zero
//   · PL_ROW_TO_KEY naming a row that does NOT equal the engine line on
//     the real book (the aggregates builder and assembled_pl drifting apart)
//     — beyond the composed rows and the two 758 rows, whose measured
//     difference (the 781 reversals the row's bucket holds) must refuse
//   · a row the engine reports absent being painted with a number
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PARITY_FLOOR,
  PL_ROW_TO_KEY,
  bsOpeningFill,
  cellForRow,
  indexCells,
  pickDefaultPrior,
  type ComparativeCell,
  type ComparativesResponse,
} from "@/lib/comparatives";
import { buildPLStatementFromAggregates } from "@/lib/buildPlStatement";
import type { OrgPeriod } from "@/lib/orgPeriods";
import type { Statements } from "@/lib/financialReport";

const period = (id: string, end: string | null): OrgPeriod =>
  ({ period_id: id, period_label: end ?? id, period_start: null, period_end: end, documents: [] }) as unknown as OrgPeriod;

describe("pickDefaultPrior — the previous period of the same length", () => {
  const periods = [
    period("p-2026-03", "2026-03-31"),
    period("p-2025-12", "2025-12-31"),
    period("p-2025-06", "2025-06-30"),
    period("p-2024-12", "2024-12-31"),
    period("p-2023-12", "2023-12-31"),
  ];
  it("prefers the nearest EARLIER period with the same month/day cut", () => {
    expect(pickDefaultPrior(periods, "p-2025-12", "2025-12-31")?.period_id).toBe("p-2024-12");
  });
  it("never picks the current period or a later one", () => {
    const pick = pickDefaultPrior(periods, "p-2024-12", "2024-12-31");
    expect(pick?.period_id).toBe("p-2023-12");
    expect(pickDefaultPrior(periods, "p-2023-12", "2023-12-31")).toBeNull();
  });
  // Owner rule (2026-09-26): the default is a period of the SAME LENGTH. A
  // Romanian balance is cumulative — Q1 2026 against the whole of 2025 is
  // not a comparison — so with no same-cut period there is no default (the
  // reader can still pick any period in "Compare with").
  it("with no earlier period of the same length, there is no default", () => {
    expect(pickDefaultPrior(periods, "p-2026-03", "2026-03-31")).toBeNull();
    expect(pickDefaultPrior(periods, "p-2025-06", "2025-06-30")).toBeNull();
  });
  it("a December close compares with the previous December, not the month before it", () => {
    const monthly = [
      period("p-2025-12", "2025-12-31"),
      period("p-2025-11", "2025-11-30"),
      period("p-2024-12", "2024-12-31"),
    ];
    expect(pickDefaultPrior(monthly, "p-2025-12", "2025-12-31")?.period_id).toBe("p-2024-12");
  });
  it("a year-to-date month compares with the same month of the previous year", () => {
    const monthly = [
      period("p-2025-08", "2025-08-31"),
      period("p-2025-07", "2025-07-31"),
      period("p-2024-12", "2024-12-31"),
      period("p-2024-08", "2024-08-31"),
    ];
    expect(pickDefaultPrior(monthly, "p-2025-08", "2025-08-31")?.period_id).toBe("p-2024-08");
  });
  it("month ends match across leap years; a different start is a different length", () => {
    const feb = [period("p-2025-02", "2025-02-28"), period("p-2024-02", "2024-02-29")];
    expect(pickDefaultPrior(feb, "p-2025-02", "2025-02-28")?.period_id).toBe("p-2024-02");
    const withStarts = [
      { ...period("p-2025-12", "2025-12-31"), period_start: "2025-01-01" },
      { ...period("p-2024-12q", "2024-12-31"), period_start: "2024-10-01" },
    ] as OrgPeriod[];
    expect(pickDefaultPrior(withStarts, "p-2025-12", "2025-12-31")).toBeNull();
  });
  it("returns null without a current period", () => {
    expect(pickDefaultPrior(periods, null, null)).toBeNull();
  });
});

function cell(over: Partial<ComparativeCell>): ComparativeCell {
  return {
    key: "pl.revenue", status: "compared", current: 100, prior: 90, delta: 10, deltaPct: 0.1111,
    currentShare: 1, priorShare: 1, deltaPts: 0, note: "", ...over,
  };
}

describe("cellForRow — the parity guard", () => {
  const cells = new Map<string, ComparativeCell>([
    ["pl.revenue", cell({})],
    ["pl.cogs", cell({ key: "pl.cogs", current: null, prior: 40, status: "absent_current" })],
  ]);
  it("paints the cell when the row's amount IS the engine's current figure", () => {
    const out = cellForRow(cells, "revenueTurnover", 100);
    expect(out.kind).toBe("cell");
  });
  it("refuses when the row's amount differs from the engine's line by a cent or more", () => {
    const out = cellForRow(cells, "revenueTurnover", 100.01); // one cent off
    expect(out.kind).toBe("definition_differs");
    if (out.kind === "definition_differs") {
      expect(out.engineCurrent).toBe(100);
      expect(out.key).toBe("pl.revenue");
    }
  });
  it("accepts a full engine key as the row key", () => {
    expect(cellForRow(cells, "pl.revenue", 100).kind).toBe("cell");
  });
  it("is unmapped for a row with no engine line", () => {
    expect(cellForRow(cells, "otherIncome758", 5).kind).toBe("unmapped");
    expect(cellForRow(cells, undefined, 5).kind).toBe("unmapped");
    expect(cellForRow(null, "revenueTurnover", 5).kind).toBe("unmapped");
  });
  it("a row showing a number the engine reports ABSENT is refused, not painted", () => {
    expect(cellForRow(cells, "cogs", 40).kind).toBe("definition_differs");
    // A zero row against an absent engine side is consistent — nothing to paint wrongly.
    expect(cellForRow(cells, "cogs", 0).kind).toBe("cell");
  });
});

// ── The definition guard: a total that folds 722 in ───────────────────
//
// "Total operating revenue" is net turnover PLUS capitalized own work (722).
// Its figure can equal the engine's net turnover to the cent in the current
// period while the PRIOR period's total held 722 — and then the prior cell
// would print net turnover under a total that includes 722. The row may
// carry the engine's net-turnover cells only while every component it folds
// in is zero in BOTH periods: the current's as the builder states it, the
// prior's as the served document carries it.
describe("cellForRow — the definition guard", () => {
  const cells = new Map<string, ComparativeCell>([["pl.revenue", cell({})]]);
  const ZERO = { capitalized_own_work_memo: 0 };
  const prior = (memo: unknown) => ({ assembled_pl: { capitalized_own_work_memo: memo } });

  it("carries the cells while neither period carries 722", () => {
    expect(cellForRow(cells, "revenue", 100, { folds: ZERO, priorStatements: prior(0) }).kind).toBe("cell");
    // Below half a cent is a zero, as everywhere in this module.
    expect(cellForRow(cells, "revenue", 100, { folds: { capitalized_own_work_memo: 0.004 }, priorStatements: prior(-0.004) }).kind).toBe("cell");
  });
  it("refuses when the CURRENT period carries 722, even with the row equal to net turnover", () => {
    const out = cellForRow(cells, "revenue", 100, { folds: { capitalized_own_work_memo: 5 }, priorStatements: prior(0) });
    expect(out.kind).toBe("definition_differs");
    if (out.kind === "definition_differs") {
      expect(out.key).toBe("pl.revenue");
      expect(out.engineCurrent).toBe(100);
    }
  });
  it("refuses when only the PRIOR period carries 722", () => {
    expect(cellForRow(cells, "revenue", 100, { folds: ZERO, priorStatements: prior(7.5) }).kind).toBe("definition_differs");
  });
  it("reads a prior memo the document does not serve as zero — the served contract", () => {
    expect(cellForRow(cells, "revenue", 100, { folds: ZERO, priorStatements: { assembled_pl: {} } }).kind).toBe("cell");
    expect(cellForRow(cells, "revenue", 100, { folds: ZERO, priorStatements: {} }).kind).toBe("cell");
    expect(cellForRow(cells, "revenue", 100, { folds: ZERO, priorStatements: undefined }).kind).toBe("cell");
  });
  it("never reads a refused or unreadable amount as zero", () => {
    for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, "0", {}]) {
      expect(cellForRow(cells, "revenue", 100, { folds: ZERO, priorStatements: prior(bad) }).kind).toBe("definition_differs");
    }
    expect(cellForRow(cells, "revenue", 100, { folds: { capitalized_own_work_memo: null }, priorStatements: prior(0) }).kind).toBe("definition_differs");
  });
  it("a total that does not state its 722 is refused — the component is required, not optional", () => {
    expect(cellForRow(cells, "revenue", 100).kind).toBe("definition_differs");
    expect(cellForRow(cells, "revenue", 100, { folds: {}, priorStatements: prior(0) }).kind).toBe("definition_differs");
  });
  it("every component a row declares is held to both periods (the line-item total folds 767 in too)", () => {
    const folds = { capitalized_own_work_memo: 0, discounts_received: 0 };
    const both = (d: unknown) => ({ assembled_pl: { capitalized_own_work_memo: 0, discounts_received: d } });
    expect(cellForRow(cells, "revenue", 100, { folds, priorStatements: both(0) }).kind).toBe("cell");
    expect(cellForRow(cells, "revenue", 100, { folds, priorStatements: both(3) }).kind).toBe("definition_differs");
    expect(cellForRow(cells, "revenue", 100, { folds: { ...folds, discounts_received: 3 }, priorStatements: both(0) }).kind).toBe("definition_differs");
  });
  it("the net-turnover LINE folds nothing in: the prior's 722 does not touch it", () => {
    expect(cellForRow(cells, "revenueTurnover", 100, { priorStatements: prior(7.5) }).kind).toBe("cell");
  });
  it("the parity guard still runs after the definition guard", () => {
    expect(cellForRow(cells, "revenue", 100.01, { folds: ZERO, priorStatements: prior(0) }).kind).toBe("definition_differs");
  });
});

// ── PL_ROW_TO_KEY parity, measured on the real analytic book ─────────
//
// The dashboard's aggregates builder reads `statements.incomeStatement`
// (persisted-bucket sums) while the engine's comparative lines read
// `assembled_pl`. The two agree on exactly the rows the map names, and
// disagree on the ones it does not (otherIncome carries 711/781). This
// test builds the P&L the way the dashboard does and checks each mapped
// row against the engine's own field.

const BASELINE = resolve(
  __dirname, "../../../src/engine/country_packs/ro_romania/fixtures/regression_baselines/scandia_fy2025.json",
);

function loadBaseline() {
  const env = JSON.parse(readFileSync(BASELINE, "utf-8")).assembled as {
    statements: Record<string, Record<string, number>>;
    lineItems: { bucket?: string; canonical_bucket?: string; amount: number; ro_account_code?: string }[];
  };
  // The persisted-bucket sums, as /api/period assembles `incomeStatement`.
  const pl: Record<string, number> = {
    revenue: 0, costOfGoodsSold: 0, operatingExpenses: 0, depreciationAmortization: 0,
    interestExpense: 0, otherIncome: 0, financialIncome: 0, financialExpense: 0, taxExpense: 0,
  };
  const map: Record<string, string> = {
    revenue: "revenue", cogs: "costOfGoodsSold", operatingExpenses: "operatingExpenses",
    depreciation: "depreciationAmortization", interestExpense: "interestExpense",
    otherIncome: "otherIncome", financialIncome: "financialIncome",
    financialExpense: "financialExpense", taxExpense: "taxExpense",
  };
  let inventoryVariationMemo = 0;
  for (const li of env.lineItems) {
    const b = li.bucket ?? li.canonical_bucket ?? "";
    if (b === "otherIncome" && (li.ro_account_code ?? "").startsWith("711")) {
      inventoryVariationMemo += li.amount;
    } else if (map[b]) {
      pl[map[b]] += li.amount;
    }
  }
  const statements = {
    companyName: "Scandia", industry: null, currency: "RON", periodLabel: "2025-12-31",
    balanceSheet: {}, incomeStatement: { ...pl, inventoryVariationMemo },
    assembled_pl: env.statements.assembled_pl,
    assembled_bs: env.statements.assembled_bs,
  } as unknown as Statements;
  return { env, statements };
}

describe("PL_ROW_TO_KEY — every mapped row equals the engine line on the real book", () => {
  const { env, statements } = loadBaseline();
  const apl = env.statements.assembled_pl;
  const stmt = buildPLStatementFromAggregates(statements);
  // Engine keys → assembled_pl fields (src/engine/comparatives/lines.py).
  const FIELD: Record<string, string> = {
    "pl.revenue": "revenue", "pl.cogs": "cogs", "pl.opex_total": "opex_total",
    "pl.other_operating_income": "other_income_758",
    "pl.depreciation": "depreciation", "pl.ebitda": "ebitda", "pl.ebit": "ebit",
    "pl.financial_income": "financial_income", "pl.interest_income": "interest_income",
    "pl.interest_expense": "interest_expense", "pl.opex_third_party": "opex_third_party",
    "pl.net_financial_result": "net_financial_result", "pl.pretax": "pretax", "pl.tax": "tax",
    "pl.net_income_operational": "net_income_operational", "pl.net_income": "net_income_statutory",
  };
  /** Keys only the LINE-ITEM builder stamps (its exact-code rows for 766
   *  and 628); plCompareSubtotals.test.tsx holds that builder to them. */
  const LINE_ITEM_ONLY = new Set(["interestIncome", "opexThirdParty"]);
  const rows = new Map<string, number>();
  const folds = new Map<string, Readonly<Record<string, number | null>>>();
  for (const s of stmt.sections) {
    for (const l of s.lines) if (l.bucket && typeof l.amount === "number") rows.set(l.bucket, l.amount);
    if (s.subtotalBucket && typeof s.subtotalAmount === "number") rows.set(s.subtotalBucket, s.subtotalAmount);
    if (s.subtotalBucket && s.subtotalFolds) folds.set(s.subtotalBucket, s.subtotalFolds);
  }
  rows.set("ebitda", stmt.ebitda);
  if (typeof stmt.netProfitStatutory === "number") rows.set("netIncomeStatutory", stmt.netProfitStatutory);
  const aggregateKeys = Object.entries(PL_ROW_TO_KEY).filter(([k]) => !LINE_ITEM_ONLY.has(k));

  it("the builder stamps every key the map names (no silent unmapped rows)", () => {
    const missing = aggregateKeys.map(([k]) => k).filter((k) => !rows.has(k));
    expect(missing).toEqual([]);
  });

  it("every engine key the map names is a line the engine serves", () => {
    for (const engineKey of Object.values(PL_ROW_TO_KEY)) {
      expect(FIELD[engineKey], engineKey).toBeDefined();
      expect(typeof apl[FIELD[engineKey]], engineKey).toBe("number");
    }
  });

  it.each(aggregateKeys)("%s → %s agrees to the cent", (rowKey, engineKey) => {
    const engine = apl[FIELD[engineKey]];
    const row = rows.get(rowKey);
    expect(typeof engine).toBe("number");
    expect(typeof row).toBe("number");
    // The rows the dashboard shows and the engine's lines are the same
    // number on the analytic book — or the parity guard would blank them.
    // netFinancialResult / pretax / netIncome* are FE-composed from the
    // persisted financial buckets and are allowed to differ; the guard
    // handles them at render time. The two 758 rows show the persisted
    // other-operating-income BUCKET, which on this book also holds
    // provision reversals (781) the engine's 758 line excludes: they are
    // refused, asserted below. Everything else must agree.
    const composed = new Set(["netFinancialResult", "pretax", "netIncomeOperational", "netIncomeStatutory"]);
    const bucketWider = new Set(["otherOperatingIncome", "otherOperatingIncomeTotal"]);
    if (composed.has(rowKey) || bucketWider.has(rowKey)) {
      return;
    }
    expect(Math.abs((row as number) - (engine as number))).toBeLessThan(PARITY_FLOOR);
  });

  it("the composed rows are either equal or refused by the guard — never painted wrong", () => {
    const doc = {
      columns: Object.entries(FIELD).map(([key, field]) => ({
        key, statement: "PL", label: key, unit: "money", requires: "synthetic",
        current: apl[field] ?? null, prior: apl[field] ?? null, delta: 0, delta_pct: 0,
        current_disclosure: "reported", prior_disclosure: "reported", status: "compared", note: "",
      })),
      common_size: [],
      prior_statements: { assembled_pl: apl },
    } as unknown as ComparativesResponse;
    const cells = indexCells(doc);
    for (const [rowKey] of aggregateKeys) {
      const out = cellForRow(cells, rowKey, rows.get(rowKey), {
        folds: folds.get(rowKey),
        priorStatements: doc.prior_statements,
      });
      expect(["cell", "definition_differs"]).toContain(out.kind);
      if (out.kind === "cell") {
        expect(Math.abs((rows.get(rowKey) as number) - (out.cell.current as number))).toBeLessThan(PARITY_FLOOR);
      }
    }
    // The measured refusals: the 758 rows carry the 781 reversals.
    for (const rowKey of ["otherOperatingIncome", "otherOperatingIncomeTotal"]) {
      expect(Math.abs((rows.get(rowKey) as number) - (apl.other_income_758 as number))).toBeGreaterThanOrEqual(PARITY_FLOOR);
      expect(cellForRow(cells, rowKey, rows.get(rowKey)).kind).toBe("definition_differs");
    }
    // And the total: no 722 in either year of this book, so it carries.
    expect(cellForRow(cells, "revenue", rows.get("revenue"), {
      folds: folds.get("revenue"), priorStatements: doc.prior_statements,
    }).kind).toBe("cell");
  });
});

describe("bsOpeningFill", () => {
  it("keys the prior canonical rows, sections and totals", () => {
    const doc = {
      prior: { label: "Dec 2024" },
      prior_canonical_bs: {
        rows: { cash: { amount: 1.5, section: "current_assets", label: "Cash" }, x: { amount: null, section: null, label: null } },
        sections: { current_assets: 1.5 },
        facts: { assets: 1.5, equity_plus_liabilities: 1.5 },
        status: "BALANCED",
      },
    } as unknown as ComparativesResponse;
    const fill = bsOpeningFill(doc)!;
    expect(fill.rows.get("cash")).toBe(1.5);
    expect(fill.rows.has("x")).toBe(false);
    expect(fill.sections.get("current_assets")).toBe(1.5);
    expect(fill.totalAssets).toBe(1.5);
    expect(fill.priorLabel).toBe("Dec 2024");
  });
  it("is null when the prior period carries no canonical balance sheet", () => {
    expect(bsOpeningFill({ prior: { label: "x" }, prior_canonical_bs: null } as unknown as ComparativesResponse)).toBeNull();
  });
});
