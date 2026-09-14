// S7 SIGN FLIPS — the TypeScript classifier against the shared truth table
// (plan_contract_v2 section 7, R21, 26.2 S7; vitest canary of the S7 row).
//
// The Python twin (src/engine/serving/change_kind.py) is held to the same
// fixture by tests/engine/test_change_kind.py. The fixture is the join:
// if either classifier changes alone, its own suite reds on the row.
//
// After the repair this reds on (TC-11): any fixture row this classifier
// classifies differently from the table (kind or delta_pct byte); a
// delta_pct on any kind but compared with a non-zero base; a table that
// stops exercising all seven kinds (TC-3); the pack mirror losing its
// places.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHANGE_KINDS,
  DELTA_PCT_PLACES,
  ROUNDED_MONEY_ZERO_FLOOR,
  classifyChange,
  deltaPctNumber,
  isWordKind,
} from "@/lib/changeKind";

interface Row {
  group: string;
  base: number | null;
  plan: number | null;
  zero_floor: number;
  kind: string;
  delta_pct: string | null;
  note: string;
}

const REPO = resolve(__dirname, "../../..");
const TRUTH = JSON.parse(
  readFileSync(resolve(REPO, "tests/fixtures/contracts/change_kind_truth_table.json"), "utf8"),
) as { delta_pct_places: number; rows: Row[] };

describe("changeKind — the TS classifier matches the shared truth table", () => {
  it("classifies every truth-table row exactly as the table says", () => {
    expect(TRUTH.rows.length).toBeGreaterThanOrEqual(60);
    const mismatches: string[] = [];
    for (const [i, row] of TRUTH.rows.entries()) {
      const got = classifyChange(row.base, row.plan, row.zero_floor);
      if (got.kind !== row.kind || got.deltaPct !== row.delta_pct) {
        mismatches.push(
          `row ${i} ${row.group} base=${row.base} plan=${row.plan} floor=${row.zero_floor}: ` +
            `want (${row.kind}, ${row.delta_pct}), got (${got.kind}, ${got.deltaPct})`,
        );
      }
    }
    expect(mismatches).toEqual([]);
    const kinds = new Set(TRUTH.rows.map((r) => r.kind));
    expect([...kinds].sort()).toEqual([...CHANGE_KINDS].sort());
    // TC-12: coverage printed.
    console.log(`SIGN-FLIP truth table (typescript): ${TRUTH.rows.length} rows, ${kinds.size} kinds`);
  });

  it("carries delta_pct only for compared with a non-zero base", () => {
    for (const row of TRUTH.rows) {
      const got = classifyChange(row.base, row.plan, row.zero_floor);
      if (got.kind !== "compared") {
        expect(got.deltaPct).toBeNull();
        expect(isWordKind(got.kind)).toBe(true);
        expect(deltaPctNumber(got)).toBeNull();
      }
    }
  });

  it("reads its places and floor from the pack mirror the table was authored at", () => {
    expect(DELTA_PCT_PLACES).toBe(TRUTH.delta_pct_places);
    expect(ROUNDED_MONEY_ZERO_FLOOR).toBe(0.005);
    expect(classifyChange(3, 5, 0, 2).deltaPct).toBe("0.67");
  });

  it("renders the measured defect pairs as flips, never a ratio", () => {
    expect(classifyChange(6_104_815.29, -107_630_000, ROUNDED_MONEY_ZERO_FLOOR)).toEqual({
      kind: "flip_to_negative",
      deltaPct: null,
    });
    expect(classifyChange(54_444_000, -20_257_000, ROUNDED_MONEY_ZERO_FLOOR).kind).toBe(
      "flip_to_negative",
    );
  });

  it("refuses a non-finite input instead of classifying it", () => {
    expect(() => classifyChange(Number.NaN, 1, 0)).toThrow();
    expect(() => classifyChange(1, Number.POSITIVE_INFINITY, 0)).toThrow();
    expect(() => classifyChange(1, 2, -1)).toThrow();
  });
});
