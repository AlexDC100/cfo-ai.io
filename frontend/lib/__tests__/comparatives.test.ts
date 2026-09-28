// comparatives.ts — the default prior, the parity guard, and the row map
// MEASURED against the real committed analytic book.
//
// WHAT THESE RED ON, with the module correct (TC-11):
//   · AUTO picking the current period, a later one, or a different
//     fiscal cut when a same-cut earlier period exists
//   · the parity guard letting a prior render beside a row whose amount
//     is not the engine's current figure for that line
//   · the definition guard letting a row on the ONE EBITDA (EBITDA, EBIT,
//     profit before tax, the stock variation, own work capitalised) carry
//     the engine's cells beside a prior served under another EBITDA
//     definition — or with no definition stamp at all (owner ruling
//     2026-09-26; this replaced the old "Total operating revenue folds 722"
//     guard: the first subtotal is net turnover now, and folds nothing)
//   · PL_ROW_TO_KEY naming a row that does NOT equal the engine line on
//     a real book served under the ruling — beyond the two 758 rows, whose
//     measured difference (the 781 reversals the row carries) must refuse
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
import { readServedOneEbitda } from "@/lib/servedOneEbitda";
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

// ── The definition guard: the rows on the one EBITDA ────────────────
//
// The owner's ruling of 2026-09-26 moved EBITDA, EBIT, profit before tax,
// gross profit, and gave the stock variation (711) and own work capitalised
// (72x) lines of their own. A prior assembled under another definition is
// not the same line: those rows carry the engine's cells only while the
// PRIOR's served block names the definition the CURRENT period is served
// on. The owner's rulings of 2026-09-28 moved net turnover (7411 inside,
// R3), D&A (the 6812 / 6814 charges out) and gave net provisions a line of
// their own (R2): those rows are held to the definition too. Every other
// row is untouched by it.
describe("cellForRow — the one-EBITDA definition guard", () => {
  const DEF = "ebitda/2026-09-28:711-72x-inside,767-financial,provisions-6812-6814-7812-7814-outside,7411-turnover";
  const cells = new Map<string, ComparativeCell>([
    ["pl.revenue", cell({})],
    ["pl.cogs", cell({ key: "pl.cogs", current: 40, prior: 30 })],
    ["pl.depreciation", cell({ key: "pl.depreciation", current: 7, prior: 6 })],
    ["pl.net_provisions", cell({ key: "pl.net_provisions", current: -3, prior: 2 })],
    ["pl.ebitda", cell({ key: "pl.ebitda", current: 50, prior: 40 })],
    ["pl.inventory_variation", cell({ key: "pl.inventory_variation", current: 5, prior: 4 })],
  ]);
  const prior = (definition: unknown) => ({ assembled_pl: { ebitda_definition: definition } });

  it("carries the cells while both periods are served on the same definition", () => {
    expect(cellForRow(cells, "ebitda", 50, { currentDefinition: DEF, priorStatements: prior(DEF) }).kind).toBe("cell");
    expect(cellForRow(cells, "inventoryVariation", 5, { currentDefinition: DEF, priorStatements: prior(DEF) }).kind).toBe("cell");
  });
  it("refuses a prior served under another definition, or with none", () => {
    for (const bad of ["ebitda/2025:711-outside", null, undefined, "", 7]) {
      const out = cellForRow(cells, "ebitda", 50, { currentDefinition: DEF, priorStatements: prior(bad) });
      expect(out.kind, String(bad)).toBe("definition_differs");
      if (out.kind === "definition_differs") expect(out.key).toBe("pl.ebitda");
    }
    expect(cellForRow(cells, "ebitda", 50, { currentDefinition: DEF, priorStatements: {} }).kind).toBe("definition_differs");
    expect(cellForRow(cells, "ebitda", 50, { currentDefinition: DEF, priorStatements: undefined }).kind).toBe("definition_differs");
  });
  it("net turnover, D&A and net provisions moved with the 2026-09-28 rulings: held to the definition", () => {
    const previous = "ebitda/2026-09-26:711-72x-inside,767-financial";
    for (const [row, amount] of [["revenue", 100], ["revenueTurnover", 100], ["depreciationAmortization", 7], ["netProvisions", -3]] as const) {
      expect(cellForRow(cells, row, amount, { currentDefinition: DEF, priorStatements: prior(previous) }).kind, row).toBe("definition_differs");
      expect(cellForRow(cells, row, amount, { currentDefinition: DEF, priorStatements: prior(DEF) }).kind, row).toBe("cell");
    }
  });
  it("a line the rulings did not move is never held to the definition", () => {
    expect(cellForRow(cells, "cogs", 40, { currentDefinition: DEF, priorStatements: prior("old") }).kind).toBe("cell");
  });
  it("a payload with no current definition (not an engine period) is held by the parity guard alone", () => {
    expect(cellForRow(cells, "ebitda", 50, { currentDefinition: null, priorStatements: prior("old") }).kind).toBe("cell");
    expect(cellForRow(cells, "ebitda", 50).kind).toBe("cell");
  });
  it("the parity guard still runs after the definition guard", () => {
    expect(cellForRow(cells, "ebitda", 50.01, { currentDefinition: DEF, priorStatements: prior(DEF) }).kind).toBe("definition_differs");
  });
});

// ── PL_ROW_TO_KEY parity, measured on real books served under the ruling ─
//
// The dashboard's aggregates builder prints the SERVED `assembled_pl`
// lines; the engine's comparative lines read the same block. They agree on
// exactly the rows the map names — except the two 758 rows, which print
// the served other-operating-income line (758 + 781 reversals + 74x …)
// while the engine's comparative 758 line is 758 alone, and are refused.
// The books: agras (a closed manufacturer whose 711 is the 121 bridge) and
// the constructed bridge-with-722 book (72x beside the bridge), both real
// engine output.

const REPO_ROOT = resolve(__dirname, "../../..");

function servedBook(path: string, key?: string): Statements {
  const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, path), "utf-8"));
  return (key ? raw[key] : raw).statements as Statements;
}

/** Engine keys → the served `assembled_pl` path each comparative line reads
 *  (src/engine/comparatives/lines.py). */
const FIELD: Record<string, string> = {
  "pl.revenue": "revenue", "pl.cogs": "cogs", "pl.opex_total": "opex_total",
  "pl.other_operating_income": "other_income_758",
  "pl.capitalized_own_work": "capitalized_own_work.value",
  "pl.inventory_variation": "inventory_variation.value",
  "pl.depreciation": "depreciation", "pl.ebitda": "ebitda", "pl.ebit": "ebit",
  "pl.financial_income": "financial_income", "pl.interest_income": "interest_income",
  "pl.interest_expense": "interest_expense", "pl.opex_third_party": "opex_third_party",
  "pl.net_financial_result": "net_financial_result", "pl.pretax": "pretax", "pl.tax": "tax",
  "pl.net_income": "net_income_statutory",
};

function fieldOf(apl: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), apl);
}

/** Keys only the LINE-ITEM builder stamps (its exact-code rows for 766
 *  and 628); plCompareSubtotals.test.tsx holds that builder to them. */
const LINE_ITEM_ONLY = new Set(["interestIncome", "opexThirdParty"]);
/** The two 758 rows: the served other-operating-income line, wider than
 *  the engine's 758 comparative line wherever 781 / 74x post. */
const BUCKET_WIDER = new Set(["otherOperatingIncome", "otherOperatingIncomeTotal"]);

for (const [name, statements] of [
  ["agras", servedBook("tests/engine/fixtures/firm/saga_10_col_agras.json")],
  ["bridge_with_722", servedBook("frontend/lib/__tests__/fixtures/oneEbitda/constructed_books.json", "bridge_with_722")],
] as const) {
  describe(`PL_ROW_TO_KEY — every mapped row equals the engine line (${name})`, () => {
    const apl = statements.assembled_pl as unknown as Record<string, unknown>;
    const served = readServedOneEbitda(apl)!;
    const stmt = buildPLStatementFromAggregates(statements);
    const rows = new Map<string, number>();
    for (const s of stmt.sections) {
      for (const l of s.lines) if (l.bucket && typeof l.amount === "number") rows.set(l.bucket, l.amount);
      if (s.subtotalBucket && typeof s.subtotalAmount === "number") rows.set(s.subtotalBucket, s.subtotalAmount);
    }
    if (typeof stmt.ebitda === "number") rows.set("ebitda", stmt.ebitda);
    const aggregateKeys = Object.entries(PL_ROW_TO_KEY).filter(([k]) => !LINE_ITEM_ONLY.has(k));
    /** A row the builder omits because the period's served line is an
     *  exact zero — a book with no other operating income, no financial
     *  items, no 72x (the reconciliation line under EBITDA states the zero
     *  components). Omitted is not unmapped: there is nothing to compare. */
    const zeroComponent = (k: string) => {
      const v = fieldOf(apl, FIELD[PL_ROW_TO_KEY[k]]);
      return typeof v === "number" && Math.abs(v) < PARITY_FLOOR;
    };

    it("the builder stamps every key the map names (no silent unmapped rows)", () => {
      const missing = aggregateKeys.map(([k]) => k).filter((k) => !rows.has(k) && !zeroComponent(k));
      expect(missing).toEqual([]);
    });

    it("every engine key the map names is a line the engine serves", () => {
      for (const engineKey of Object.values(PL_ROW_TO_KEY)) {
        expect(FIELD[engineKey], engineKey).toBeDefined();
        expect(typeof fieldOf(apl, FIELD[engineKey]), engineKey).toBe("number");
      }
    });

    it.each(aggregateKeys)("%s → %s agrees to the cent", (rowKey, engineKey) => {
      if (BUCKET_WIDER.has(rowKey) || (!rows.has(rowKey) && zeroComponent(rowKey))) return;
      const engine = fieldOf(apl, FIELD[engineKey]);
      const row = rows.get(rowKey);
      expect(typeof engine).toBe("number");
      expect(typeof row).toBe("number");
      expect(Math.abs((row as number) - (engine as number))).toBeLessThan(PARITY_FLOOR);
    });

    it("the 758 rows are either equal or refused by the guard — never painted wrong", () => {
      const doc = {
        columns: Object.entries(FIELD).map(([key, field]) => ({
          key, statement: "PL", label: key, unit: "money", requires: "synthetic",
          current: fieldOf(apl, field) ?? null, prior: fieldOf(apl, field) ?? null, delta: 0, delta_pct: 0,
          current_disclosure: "reported", prior_disclosure: "reported", status: "compared", note: "",
        })),
        common_size: [],
        prior_statements: { assembled_pl: apl },
      } as unknown as ComparativesResponse;
      const cells = indexCells(doc);
      for (const [rowKey] of aggregateKeys) {
        if (!rows.has(rowKey)) continue;
        const out = cellForRow(cells, rowKey, rows.get(rowKey), {
          currentDefinition: served.definition,
          priorStatements: doc.prior_statements,
        });
        expect(["cell", "definition_differs"]).toContain(out.kind);
        if (out.kind === "cell") {
          expect(Math.abs((rows.get(rowKey) as number) - (out.cell.current as number))).toBeLessThan(PARITY_FLOOR);
        } else {
          expect(BUCKET_WIDER.has(rowKey), `${rowKey} refused`).toBe(true);
        }
      }
    });
  });
}

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
