// CASH FLOW — NUMERIC NARROWING REGRESSION (TSC burn-down, TIER 1).
//
// `assembled_cf` is a genuinely heterogeneous record: the SAME object that
// carries ~30 numeric cash-flow fields also carries `is_approximated` and
// `dividends_declared_but_unpaid` (bool) and `approximation_notes`
// (string[]). That is not a hypothetical — the fixture asserted in §1 is
// real engine output for Carniprod FY2025, captured through the real
// `/api/period` composition (TC-1), and §1 proves the mixed types are
// present rather than assuming it.
//
// `buildCashFlowStatement` used to read those fields with a bare `?? 0`,
// which types as `number | boolean | string[]` and coerces in JS instead
// of throwing. 17 of the 101 baselined type errors were exactly this file
// telling us so. The measured consequence of a single non-numeric read:
//
//     ["a note"] + 3695525.59  ===  "a note3695525.59"
//
// which propagates into wcReconciliationPlug (NaN) → the >50k disclosure
// note silently stops firing → `drift` is NaN → the builder's stated
// "balances to the BS cash position within RON 1" guarantee is never
// actually checked, while a money cell renders the concatenated string.
//
// §2 is the behaviour-preserved half (real data still reconciles); §3 is
// the regression half (poisoned reads can no longer escape as strings or
// NaN). §3 would have FAILED before the narrowing fix.

import { describe, it, expect } from "vitest";

import { buildCashFlowStatement } from "@/lib/buildCashFlowStatement";
import realPeriod from "./fixtures/capsuleTier0/period_carniprod_fy2025.json";

type CfRecord = Record<string, number | boolean | string[] | undefined>;

const REAL_CF = (realPeriod as { assembled_cf: CfRecord }).assembled_cf;
const REAL_PL = (realPeriod as { assembled_pl: Record<string, number> }).assembled_pl;
const REAL_BS = (realPeriod as { assembled_bs: Record<string, number> }).assembled_bs;

function build(cf: CfRecord) {
  return buildCashFlowStatement({
    pl: REAL_PL,
    bs: REAL_BS,
    cf,
    entity: "Carniprod SRL",
    period: "FY2025",
    currency: "RON",
    yearLabel: "2025",
  });
}

/** Every money field the statement exposes, flattened. If any one of these
 *  is a string or NaN the view renders garbage in a money cell. */
function moneyFields(s: ReturnType<typeof build>): Array<[string, unknown]> {
  return [
    ["operating.netProfit", s.operating.netProfit],
    ["operating.depreciation", s.operating.depreciation],
    ["operating.cfBeforeWcChanges", s.operating.cfBeforeWcChanges],
    ["operating.cashFromOperating", s.operating.cashFromOperating],
    ["investing.cashUsedInInvesting", s.investing.cashUsedInInvesting],
    ["financing.bankLoanDrawdowns", s.financing.bankLoanDrawdowns],
    ["financing.bankLoanRepayments", s.financing.bankLoanRepayments],
    ["financing.dividendsPaid", s.financing.dividendsPaid],
    ["financing.cashFromFinancing", s.financing.cashFromFinancing],
    ["reconciliation.netChangeInCash", s.reconciliation.netChangeInCash],
    ["reconciliation.openingCash", s.reconciliation.openingCash],
    ["reconciliation.closingCashComputed", s.reconciliation.closingCashComputed],
    ["reconciliation.closingCashActual", s.reconciliation.closingCashActual],
    ["reconciliation.drift", s.reconciliation.drift],
    ...s.investing.items.map(
      (it, i) => [`investing.items[${i}].amount`, it.amount] as [string, unknown],
    ),
    ...s.operating.wcChanges.map(
      (w, i) => [`operating.wcChanges[${i}].delta`, w.delta] as [string, unknown],
    ),
  ];
}

describe("buildCashFlowStatement — numeric narrowing", () => {
  // ── §1 DISCOVERY CANARY ────────────────────────────────────────────
  // This suite is only meaningful if the real payload actually mixes
  // types. If a future engine version splits the booleans and the list
  // out of `assembled_cf`, this fails LOUDLY rather than letting §3
  // quietly become a test of nothing.
  describe("§1 the hazard this suite guards is real in engine output", () => {
    it("real assembled_cf carries bool and string[] alongside numbers", () => {
      const kinds = new Map<string, string>();
      for (const [k, v] of Object.entries(REAL_CF)) {
        kinds.set(k, Array.isArray(v) ? "array" : typeof v);
      }
      const byKind = (want: string) =>
        [...kinds.entries()].filter(([, t]) => t === want).map(([k]) => k);

      expect(byKind("number").length).toBeGreaterThan(20);
      // MUST FIND — named explicitly so a rename cannot read as "clean".
      expect(byKind("boolean")).toEqual(
        expect.arrayContaining(["is_approximated", "dividends_declared_but_unpaid"]),
      );
      expect(byKind("array")).toEqual(
        expect.arrayContaining(["approximation_notes"]),
      );
    });
  });

  // ── §2 BEHAVIOUR PRESERVED ON REAL DATA ────────────────────────────
  describe("§2 real Carniprod FY2025 still reconciles", () => {
    const s = build(REAL_CF);

    it("every money field is a finite number", () => {
      for (const [name, v] of moneyFields(s)) {
        expect(typeof v, name).toBe("number");
        expect(Number.isFinite(v as number), name).toBe(true);
      }
    });

    it("closing cash reconciles to the BS position within RON 1", () => {
      expect(Math.abs(s.reconciliation.drift)).toBeLessThan(1);
    });

    it("reads the canonical values, not the fallbacks", () => {
      // Guards against a narrowing helper that discards good input.
      expect(s.reconciliation.closingCashActual).toBe(REAL_CF.closing_cash_actual);
      expect(s.financing.dividendsPaid).toBe(REAL_CF.dividends_paid);
      expect(s.investing.cashUsedInInvesting).toBe(REAL_CF.cash_used_in_investing);
      expect(s.operating.depreciation).toBe(REAL_PL.depreciation ?? REAL_CF.depreciation);
    });

    it("honesty rails survive: approximated flag and notes pass through", () => {
      expect(s.isApproximated).toBe(true);
      expect(s.approximationNotes.length).toBeGreaterThan(0);
      expect(s.approximationNotes.every((n) => typeof n === "string")).toBe(true);
    });
  });

  // ── §3 THE REGRESSION ──────────────────────────────────────────────
  // Each case poisons ONE read key with a value the record's own type
  // permits. Before the fix, `net_profit` as a string[] produced a STRING
  // in operating.cfBeforeWcChanges and NaN drift.
  describe("§3 a non-numeric field cannot escape into a money cell", () => {
    const POISON: Array<[string, number | boolean | string[]]> = [
      ["net_profit", ["Working-capital movements estimated"]],
      ["depreciation", ["note"]],
      ["cash_used_in_investing", false],
      ["bank_loan_drawdowns", true],
      ["dividends_paid", ["declared, unpaid"]],
      ["closing_cash_actual", false],
      ["capitalized_construction", ["231 additions"]],
      ["net_change_in_cash", ["-1379258.07"]],
    ];

    for (const [key, bad] of POISON) {
      it(`${key} = ${JSON.stringify(bad)} → all money fields stay finite numbers`, () => {
        // `net_profit` / `depreciation` are only reached when the PL view
        // does not supply them, which is the real single-view fallback path.
        const s = buildCashFlowStatement({
          pl: {},
          bs: REAL_BS,
          cf: { ...REAL_CF, [key]: bad },
          entity: "Carniprod SRL",
          period: "FY2025",
          currency: "RON",
        });
        for (const [name, v] of moneyFields(s)) {
          expect(typeof v, `${key} → ${name}`).toBe("number");
          expect(Number.isFinite(v as number), `${key} → ${name}`).toBe(true);
        }
      });
    }

    it("a NaN in the payload does not poison every downstream total", () => {
      const s = build({ ...REAL_CF, net_profit: NaN, depreciation: NaN });
      for (const [name, v] of moneyFields(s)) {
        expect(Number.isFinite(v as number), name).toBe(true);
      }
    });

    it("the drift guarantee is still CHECKABLE when a field is poisoned", () => {
      // The point of the fix: drift stays a real number, so
      // `Math.abs(drift) < 1` remains a meaningful assertion instead of
      // silently evaluating NaN.
      const s = build({ ...REAL_CF, cash_used_in_investing: false });
      expect(Number.isNaN(s.reconciliation.drift)).toBe(false);
      expect(Math.abs(s.reconciliation.drift)).toBeLessThan(1);
    });
  });
});
