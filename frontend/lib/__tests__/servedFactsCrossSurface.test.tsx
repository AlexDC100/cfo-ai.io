// I1 (FE half) — cross-surface identity: periodFacts, both exports, the BS
// builder, ratios, valuation and the chat snapshot all rendered from the
// SAME served fixture must agree on every shared BS concept TO THE CENT.
// Three fixtures: balanced, BS-placed RECONCILED, PNL-placed RECONCILED.
//
// I4 (FE half) — a RECONCILED period must present as non-'balanced' on all
// three wording surfaces: the chip copy (auto-adjusted caption, never the
// plain balanced chip), the HTML export string, and the Excel status cell.
//
// ⚠ THE intentional number change of the gateway rollout is asserted here:
// valuation equity (WACC weights, asset-based primary_value fallback,
// Altman X4) is the ADJUSTED (reconciliation-inclusive) served figure —
// the raw pre-adjustment equity must appear on NO analytical surface.

import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as XLSX from "xlsx";

// Currency store is context-backed (throws outside its provider); mock the
// hooks the strip consumes so it renders standalone — same pattern as
// bsReconcileFlow.test.tsx.
vi.mock("@/stores/currency", () => ({
  useAmountFormatter:
    () =>
    (v: number | null | undefined): string =>
      v === null || v === undefined ? "0" : String(Math.round(v * 100) / 100),
  useDisplayCurrency: () => "RON",
  useCurrency: () => ({ display: "RON", rates: { rates: {} } }),
  useRates: () => ({ rates: {} }),
  CurrencyProvider: ({ children }: { children: unknown }) => children,
}));

import { factsFrom } from "@/lib/servedFacts";
import { buildPeriodFacts } from "@/lib/periodFacts";
import { buildExcelWorkbook } from "@/lib/financialExports";
import {
  computeRatios,
  renderReportHtml,
  type Statements,
} from "@/lib/financialReport";
import { buildBSStatement, canonicalMetaFromBs } from "@/lib/buildBsStatement";
import { altmanZScore, computeCostOfCapital } from "@/lib/financialValuation";
import { BsCanonicalStatusStrip } from "@/components/cfo/BSStatementView";

const load = (name: string): Statements =>
  JSON.parse(
    readFileSync(resolve(__dirname, "fixtures", name), "utf-8"),
  ) as Statements;

const FIXTURES = [
  ["served_balanced.json", "balanced"],
  ["served_reconciled_bs.json", "BS-placed reconciled"],
  ["served_reconciled_pnl.json", "PNL-placed reconciled"],
] as const;

const cents = (v: number): number => Math.round(v * 100);

/** Read one aoa sheet back out of the workbook. */
function sheetRows(wb: XLSX.WorkBook, name: string): unknown[][] {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 }) as unknown[][];
}
function rowValue(rows: unknown[][], label: string): unknown {
  const row = rows.find((r) => r[0] === label);
  expect(row, `sheet row "${label}"`).toBeDefined();
  return row![1];
}

describe.each(FIXTURES.map(([f, label]) => [label, f] as const))(
  "I1 — cross-surface identity (%s fixture)",
  (_label, file) => {
    const s = load(file);
    const sf = factsFrom(s);

    it("periodFacts totals + balance check match the gateway to the cent", () => {
      const facts = buildPeriodFacts({
        periodId: "p-test",
        statements: s,
        lineItems: [],
        valuation: null,
        industry: s.industry ?? null,
      });
      expect(cents(facts.bs.total_assets)).toBe(sf.cents.totalAssetsCents);
      expect(cents(facts.bs.total_equity)).toBe(sf.cents.totalEquityCents);
      expect(cents(facts.bs.total_liabilities)).toBe(sf.cents.totalLiabilitiesCents);
      expect(cents(facts.bs.current_assets)).toBe(sf.cents.currentAssetsCents);
      expect(cents(facts.bs.short_term_liabilities)).toBe(sf.cents.currentLiabilitiesCents);
      expect(cents(facts.bs.non_current_assets)).toBe(sf.cents.nonCurrentAssetsCents);
      expect(cents(facts.bs.bs_balance_check)).toBe(sf.cents.differenceCents);
      expect(cents(facts.audit.bs_balance_check)).toBe(sf.cents.differenceCents);
    });

    it("Excel Cover + Balance Sheet quote the same book", () => {
      const wb = buildExcelWorkbook(s);
      const cover = sheetRows(wb, "Cover");
      expect(cents(rowValue(cover, "Total assets") as number)).toBe(sf.cents.totalAssetsCents);
      expect(cents(rowValue(cover, "Total equity") as number)).toBe(sf.cents.totalEquityCents);
      const bsSheet = sheetRows(wb, "Balance Sheet");
      expect(cents(rowValue(bsSheet, "Total assets") as number)).toBe(sf.cents.totalAssetsCents);
      expect(cents(rowValue(bsSheet, "Total equity") as number)).toBe(sf.cents.totalEquityCents);
      expect(cents(rowValue(bsSheet, "Total liabilities") as number)).toBe(
        sf.cents.totalLiabilitiesCents,
      );
      expect(cents(rowValue(bsSheet, "Total equity + liabilities") as number)).toBe(
        sf.cents.equityPlusLiabilitiesCents,
      );
      expect(
        cents(rowValue(bsSheet, "Difference (assets − equity − liabilities)") as number),
      ).toBe(sf.cents.differenceCents);
    });

    it("BS builder view-model matches the gateway to the cent", () => {
      const st = buildBSStatement({
        lineItems: [],
        entity: s.companyName,
        asOf: "31.12.2025",
        comparativeDate: "01.01.2025",
        currency: s.currency,
        canonicalBs: s.canonical_bs,
      });
      expect(cents(st.totalAssets.closing)).toBe(sf.cents.totalAssetsCents);
      expect(cents(st.totalEquityLiab.closing)).toBe(sf.cents.equityPlusLiabilitiesCents);
      expect(cents(st.balanceCheck)).toBe(sf.cents.differenceCents);
      expect(st.canonical?.status).toBe(sf.status());
      const equitySection = st.equityLiabSections.find(
        (sec) => sec.subtotalBucket === "totalEquity",
      );
      expect(cents(equitySection?.subtotalClosing ?? NaN)).toBe(sf.cents.totalEquityCents);
    });

    it("ratios (FE fallback path) derive from the gateway totals", () => {
      const r = computeRatios(s);
      const equityRatio = r.leverage.find((x) => x.key === "equity_ratio");
      expect(equityRatio?.value).toBeCloseTo(
        (sf.totalEquity() / sf.totalAssets()) * 100,
        6,
      );
      const currentRatio = r.liquidity.find((x) => x.key === "current_ratio");
      expect(currentRatio?.value).toBeCloseTo(
        sf.currentAssets() / sf.currentLiabilities(),
        6,
      );
    });

    it("valuation reads the ADJUSTED equity (the documented change)", () => {
      const altman = altmanZScore(s);
      expect(altman.components.x4_equity_to_liabilities).toBeCloseTo(
        sf.totalEquity() / sf.totalLiabilities(),
        6,
      );
      const wacc = computeCostOfCapital(s);
      const debt = s.assembled_bs?.total_debt ?? 0;
      expect(wacc.weightOfEquity).toBeCloseTo(
        sf.totalEquity() / (debt + sf.totalEquity()),
        10,
      );
      const facts = buildPeriodFacts({
        periodId: "p-test",
        statements: s,
        lineItems: [],
        valuation: null,
        industry: s.industry ?? null,
      });
      // Asset-based primary_value fallback = the served (adjusted) equity.
      expect(cents(facts.valuation.primary_value)).toBe(sf.cents.totalEquityCents);
    });

    it("HTML report serializes the gateway totals", () => {
      const html = renderReportHtml(s);
      const fmt = (n: number) =>
        `RON ${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
      expect(html).toContain(fmt(sf.totalAssets()));
      expect(html).toContain(fmt(sf.equityPlusLiabilities()));
    });
  },
);

describe("I1 — the raw pre-adjustment equity appears on NO analytical surface", () => {
  it("PNL-placed fixture: 5,000,052.18 (raw) never leaks; 5,000,000.00 (adjusted) serves", () => {
    const s = load("served_reconciled_pnl.json");
    const sf = factsFrom(s);
    expect(sf.totalEquity()).toBe(5000000);

    const html = renderReportHtml(s);
    expect(html).not.toContain("5,000,052");

    const wb = buildExcelWorkbook(s);
    const bsSheet = sheetRows(wb, "Balance Sheet");
    expect(rowValue(bsSheet, "Total equity")).toBe(5000000);

    const facts = buildPeriodFacts({
      periodId: "p-test",
      statements: s,
      lineItems: [],
      valuation: null,
      industry: null,
    });
    expect(facts.bs.total_equity).toBe(5000000);
    expect(facts.valuation.primary_value).toBe(5000000);
  });

  it("the P&L-placed visible line is exposed through the gateway", () => {
    const sf = factsFrom(load("served_reconciled_pnl.json"));
    expect(sf.reconciliationAdjustment()).toEqual({
      placement: "pnl",
      placementDetail: "pl_other_expense",
      amount: -52.18,
      label: "Diferențe de reconciliere",
    });
  });
});

describe.each([
  ["served_reconciled_bs.json"],
  ["served_reconciled_pnl.json"],
] as const)("I4 — RECONCILED is non-'balanced' on every wording surface (%s)", (file) => {
  const s = load(file);

  it("chip copy reads 'Reconciled' + auto-adjusted — never a balanced label", () => {
    cleanup();
    const meta = canonicalMetaFromBs(s.canonical_bs!);
    render(<BsCanonicalStatusStrip meta={meta} currency={s.currency} periodId="p-test" />);
    // The RECONCILED chip (green COLOR family) with the honest label +
    // micro-caption — sv1 lock: the display string is never a
    // 'balanced'-family word.
    const strip = screen.getByTestId("bs-status-reconciled");
    expect(strip.textContent).toContain("Reconciled");
    expect(strip.textContent!.toLowerCase()).not.toMatch(/balanc/);
    expect(screen.queryByTestId("bs-status-balanced")).toBeNull();
    expect(screen.getByTestId("bs-auto-adjusted-caption").textContent).toContain(
      "auto-adjusted",
    );
  });

  it("HTML export words RECONCILED, not the pristine balanced verdict", () => {
    const html = renderReportHtml(s);
    expect(html).toContain("RECONCILED");
    expect(html).toContain("reconciled is not balanced");
    // The pristine BALANCED headline must not appear anywhere.
    expect(html).not.toContain("Balance check passed");
  });

  it("Excel status cell is the machine token RECONCILED", () => {
    const wb = buildExcelWorkbook(s);
    const bsSheet = sheetRows(wb, "Balance Sheet");
    const status = String(rowValue(bsSheet, "Balance status"));
    expect(status).toBe("RECONCILED");
    expect(status.toLowerCase()).not.toContain("balanced");
  });
});
