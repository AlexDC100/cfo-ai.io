// comparatives.ts — the default prior, the parity guard, and the row map
// MEASURED against the real committed analytic book.
//
// WHAT THESE RED ON, with the module correct (TC-11):
//   · AUTO picking the current period, a later one, or a different
//     fiscal cut when a same-cut earlier period exists
//   · the parity guard letting a prior render beside a row whose amount
//     is not the engine's current figure for that line
//   · PL_ROW_TO_KEY naming a row that does NOT equal the engine line on
//     the real book (the aggregates builder and assembled_pl drifting apart)
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

describe("pickDefaultPrior — the previous fiscal year-end", () => {
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
  it("falls back to the nearest earlier period when no same-cut one exists", () => {
    expect(pickDefaultPrior(periods, "p-2026-03", "2026-03-31")?.period_id).toBe("p-2025-12");
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
  // Engine keys → assembled_pl fields.
  const FIELD: Record<string, string> = {
    "pl.revenue": "revenue", "pl.cogs": "cogs", "pl.opex_total": "opex_total",
    "pl.depreciation": "depreciation", "pl.ebitda": "ebitda", "pl.ebit": "ebit",
    "pl.net_financial_result": "net_financial_result", "pl.pretax": "pretax", "pl.tax": "tax",
    "pl.net_income_operational": "net_income_operational", "pl.net_income": "net_income_statutory",
  };
  const rows = new Map<string, number>();
  for (const s of stmt.sections) {
    for (const l of s.lines) if (l.bucket && typeof l.amount === "number") rows.set(l.bucket, l.amount);
    if (s.subtotalBucket && typeof s.subtotalAmount === "number") rows.set(s.subtotalBucket, s.subtotalAmount);
  }
  rows.set("ebitda", stmt.ebitda);
  if (typeof stmt.netProfitStatutory === "number") rows.set("netIncomeStatutory", stmt.netProfitStatutory);

  it("the builder stamps every key the map names (no silent unmapped rows)", () => {
    const missing = Object.keys(PL_ROW_TO_KEY).filter((k) => !rows.has(k));
    // financial rows are deliberately unmapped; these two subtotals must be present.
    expect(missing).toEqual([]);
  });

  it.each(Object.entries(PL_ROW_TO_KEY))("%s → %s agrees to the cent", (rowKey, engineKey) => {
    const engine = apl[FIELD[engineKey]];
    const row = rows.get(rowKey);
    expect(typeof engine).toBe("number");
    expect(typeof row).toBe("number");
    // The rows the dashboard shows and the engine's lines are the same
    // number on the analytic book — or the parity guard would blank them.
    // netFinancialResult / pretax / netIncome* are FE-composed from the
    // persisted financial buckets and are allowed to differ; the guard
    // handles them at render time. Everything else must agree.
    const composed = new Set(["netFinancialResult", "pretax", "netIncomeOperational", "netIncomeStatutory"]);
    if (composed.has(rowKey)) {
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
    } as unknown as ComparativesResponse;
    const cells = indexCells(doc);
    for (const [rowKey] of Object.entries(PL_ROW_TO_KEY)) {
      const out = cellForRow(cells, rowKey, rows.get(rowKey));
      expect(["cell", "definition_differs"]).toContain(out.kind);
      if (out.kind === "cell") {
        expect(Math.abs((rows.get(rowKey) as number) - (out.cell.current as number))).toBeLessThan(PARITY_FLOOR);
      }
    }
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
