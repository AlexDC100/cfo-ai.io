// canonical_bs v2 pass-through (docs/CANONICAL_BS_V2_CONTRACT.md,
// "Consumption rules"). The BS view-model must carry the engine object's
// rows / section subtotals / grand totals / status VERBATIM — zero FE
// arithmetic, no residual entries, no reconcile plugs. The synthetic
// object below is deliberately internally INCONSISTENT (rows don't sum to
// subtotals, sections don't sum to totals): a true pass-through preserves
// every figure as-is, while any surviving FE arithmetic or plug machinery
// would "correct" them and fail these assertions.

import { describe, expect, it } from "vitest";

import { buildBSStatement } from "@/lib/buildBsStatement";
import { buildPeriodFacts } from "@/lib/periodFacts";
import type { CanonicalBs, Statements } from "@/lib/financialReport";

const baseArgs = {
  lineItems: [],
  entity: "Test SRL",
  asOf: "31.12.2025",
  comparativeDate: "01.01.2025",
  currency: "RON",
};

function syntheticCanonicalBs(overrides: Partial<CanonicalBs> = {}): CanonicalBs {
  return {
    schema: "bs_v2",
    mapping_version: "ro_omfp1802_v2",
    rows: [
      { id: "ppe_land", section: "non_current_assets", label: "Land", account_codes: ["211"], amount: 100, opening: null },
      { id: "cash", section: "current_assets", label: "Cash at bank", account_codes: ["5121", "5124"], amount: 50, opening: 40 },
      { id: "share_capital", section: "equity", label: "Share capital", account_codes: ["1012"], amount: 90, opening: null },
      { id: "ap_trade", section: "current_liabilities", label: "Trade payables", account_codes: ["401"], amount: 55, opening: null },
    ],
    sections: [
      { id: "non_current_assets", subtotal: 111 }, // ≠ row sum (100) on purpose
      { id: "current_assets", subtotal: 55 }, // ≠ row sum (50) on purpose
      { id: "prepaid_expenses", subtotal: 0 },
      { id: "equity", subtotal: 90 },
      { id: "provisions", subtotal: 0 },
      { id: "non_current_liabilities", subtotal: 0 },
      { id: "current_liabilities", subtotal: 60 }, // ≠ row sum (55) on purpose
      { id: "deferred_income", subtotal: 0 },
    ],
    totals: {
      assets: 166,
      equity: 90,
      liabilities: 60,
      equity_plus_liabilities: 150,
      current_assets: 55,
      current_liabilities: 60,
    },
    difference: 16,
    status: "MINOR_DRIFT",
    diagnosis: [],
    ...overrides,
  };
}

describe("buildBSStatement — canonical_bs v2 pass-through", () => {
  it("renders totals, subtotals, rows and status verbatim, ignoring assembledBs", () => {
    const st = buildBSStatement({
      ...baseArgs,
      canonicalBs: syntheticCanonicalBs(),
      // A conflicting legacy assembled_bs must be ignored entirely on the
      // canonical path — the engine object is the single authority.
      assembledBs: { total_assets: 999999, total_equity: 1, total_liabilities: 1, bs_balance_delta: 123 },
    });

    // Grand totals + THE drift, straight from the object.
    expect(st.totalAssets.closing).toBe(166);
    expect(st.totalEquityLiab.closing).toBe(150);
    expect(st.balanceCheck).toBe(16);
    expect(st.canonical?.status).toBe("MINOR_DRIFT");
    expect(st.canonical?.mappingVersion).toBe("ro_omfp1802_v2");

    // Empty sections (subtotal 0, no rows) are skipped; the rest keep the
    // object's own order and land on the contract-mapped side.
    expect(st.assetSections.map((s) => s.header)).toEqual(["NON-CURRENT", "CURRENT"]);
    expect(st.equityLiabSections.map((s) => s.header)).toEqual(["EQUITY", "CURRENT LIABILITIES"]);

    // Section subtotals are the ENGINE values even where rows sum lower —
    // proof no local arithmetic replaced them.
    const nonCurrent = st.assetSections[0];
    expect(nonCurrent.subtotalClosing).toBe(111);
    const currentLiab = st.equityLiabSections[1];
    expect(currentLiab.subtotalClosing).toBe(60);

    // Rows pass through untouched (labels, amounts, account codes), and no
    // residual/plug rows exist anywhere in the statement.
    const allLines = [...st.assetSections, ...st.equityLiabSections].flatMap((s) => s.lines);
    expect(allLines.map((l) => l.label)).toEqual([
      "Land",
      "Cash at bank",
      "Share capital",
      "Trade payables",
    ]);
    expect(allLines.map((l) => l.closing)).toEqual([100, 50, 90, 55]);
    expect(allLines.find((l) => l.label === "Cash at bank")?.accountCode).toBe("5121+5124");
    expect(allLines.some((l) => l.accountCode === "other")).toBe(false);
    expect(allLines.some((l) => l.label.startsWith("Other "))).toBe(false);

    // Opening column: engine-supplied opening survives; null opening
    // mirrors closing (Δ 0) — symmetric on both sides.
    expect(allLines.find((l) => l.label === "Cash at bank")?.opening).toBe(40);
    expect(allLines.find((l) => l.label === "Land")?.opening).toBe(100);
    expect(st.totalAssets.delta).toBe(0);
    expect(st.totalEquityLiab.delta).toBe(0);
  });

  it("MATERIAL_IMBALANCE yields the blocking state with the diagnosis list", () => {
    const st = buildBSStatement({
      ...baseArgs,
      canonicalBs: syntheticCanonicalBs({
        status: "MATERIAL_IMBALANCE",
        difference: -46613.06,
        diagnosis: [
          {
            code: "D2_FINGERPRINT",
            detail: "account 4511 amount 46613.06 ≈ difference",
            leaf_ids: ["4511"],
          },
        ],
      }),
    });

    // `canonical` is what BSStatementView renders the blocking red strip
    // from (role="alert", never "all good") — it must carry the verdict,
    // the exact signed difference, and the engine diagnosis verbatim.
    expect(st.canonical?.status).toBe("MATERIAL_IMBALANCE");
    expect(st.canonical?.difference).toBe(-46613.06);
    expect(st.canonical?.totalAssets).toBe(166);
    expect(st.canonical?.diagnosis).toEqual([
      { code: "D2_FINGERPRINT", detail: "account 4511 amount 46613.06 ≈ difference" },
    ]);
    expect(st.balanceCheck).toBe(-46613.06);
  });

  it("legacy path (no canonical_bs) is unchanged: assembledBs totals, no canonical meta", () => {
    const st = buildBSStatement({
      ...baseArgs,
      lineItems: [{ statement: "BS", bucket: "cash", ro_account_code: "5121", amount: 100 }],
      assembledBs: { total_assets: 123, total_equity: 60, total_liabilities: 63, bs_balance_delta: 0 },
    });
    expect(st.canonical).toBeUndefined();
    expect(st.totalAssets.closing).toBe(123);
    expect(st.totalEquityLiab.closing).toBe(123);
  });
});

describe("buildPeriodFacts — bs_balance_check sourcing", () => {
  function makeStatements(overrides: Partial<Statements> = {}): Statements {
    return {
      companyName: "Test SRL",
      currency: "RON",
      periodLabel: "FY2025",
      balanceSheet: {
        cash: 10,
        accountsReceivable: 0,
        inventory: 0,
        otherCurrentAssets: 0,
        propertyPlantEquipment: 0,
        intangibles: 0,
        otherNonCurrentAssets: 0,
        accountsPayable: 0,
        shortTermDebt: 0,
        otherCurrentLiabilities: 0,
        longTermDebt: 0,
        otherNonCurrentLiabilities: 0,
        shareCapital: 5,
        retainedEarnings: 0,
        otherEquity: 0,
      },
      incomeStatement: {
        revenue: 100,
        costOfGoodsSold: 40,
        operatingExpenses: 30,
        depreciationAmortization: 5,
        interestExpense: 1,
        otherIncome: 0,
        taxExpense: 2,
      },
      supplementary: {},
      ...overrides,
    };
  }

  it("reads canonical_bs.difference when present (no FE recompute)", () => {
    const facts = buildPeriodFacts({
      periodId: "p1",
      statements: makeStatements({ canonical_bs: syntheticCanonicalBs({ difference: 16 }) }),
      lineItems: [],
      valuation: null,
      industry: null,
    });
    // The FE recompute would give 10 − (0 + 5) = 5; canonical must win.
    expect(facts.bs.bs_balance_check).toBe(16);
    expect(facts.audit.bs_balance_check).toBe(16);
  });

  it("keeps the legacy recompute when canonical_bs is absent", () => {
    const facts = buildPeriodFacts({
      periodId: "p1",
      statements: makeStatements(),
      lineItems: [],
      valuation: null,
      industry: null,
    });
    expect(facts.bs.bs_balance_check).toBe(5);
  });
});
