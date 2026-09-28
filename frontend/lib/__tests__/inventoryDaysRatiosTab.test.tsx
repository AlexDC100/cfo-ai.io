// INVENTORY DAYS ON THE RATIOS TAB — the tile and the drawer print the
// served split (owner spec 2026-09-26 P1: "Show all four, each with its
// accounts"; design B4 "one authority").
//
// Laws, on the real served pair (fixtures/comparatives/pair_served.json,
// captured through create_app, kept fresh by its capture script):
//   1. the DIO tile's headline is the served ratio row, and that row IS the
//      block's total (value_q) — one figure, one formula;
//   2. under it the tile prints the three legs with their accounts and
//      days, "alte stocuri" inside the total, and the block's basis
//      sentence — each the block's own value_q, never a browser division;
//   3. the drawer prints the same split in full, with the period-end
//      figure the cycle uses and the total's flow;
//   4. in Romanian every figure takes the decimal comma and every label is
//      the engine's Romanian;
//   5. a period with no block prints no split (and the fallback refuses —
//      lib/__tests__/ratioRefusal.test.tsx).

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";

import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { RatioCompareCtx } from "@/components/cfo/ComparativesPanel";
import { RatiosTabContent } from "@/components/cfo/ratios/RatiosTab";
import { altmanRatio, computeRatios, type Statements } from "@/lib/financialReport";
import { computeCreditScore } from "@/lib/financialValuation";
import { buildRatioCompareView, printRatioRow, readRatioTable, servedCreditEnvelopes } from "@/lib/ratioCompareView";
import { printDaysQ, printInventoryDays, readInventoryDaysSplit } from "@/lib/inventoryDays";

import pairJson from "./fixtures/comparatives/pair_served.json";

type Json = Record<string, unknown>;
interface Pair {
  comparatives: Json;
  current_body: {
    assembled_metrics: Json;
    statements: Statements & { periodLabel: string; inventory_days?: unknown };
    metrics: { name: string; value: number | null }[];
  };
}
const fresh = (): Pair => JSON.parse(JSON.stringify(pairJson)) as Pair;

function renderTab(p: Pair) {
  const statements = p.current_body.statements;
  const metricsByName: Record<string, number | null> = {};
  for (const m of p.current_body.metrics) metricsByName[m.name] = typeof m.value === "number" ? m.value : null;
  const ratios = computeRatios(
    statements,
    { ebitdaMargin: metricsByName.ebitda_margin ?? null, netMargin: metricsByName.net_margin ?? null },
    metricsByName,
  );
  const env = servedCreditEnvelopes(p.current_body.assembled_metrics, statements, metricsByName);
  const credit = computeCreditScore(statements, env.credit, env.piotroski, env.metricsByName);
  const view = buildRatioCompareView({
    periodTable: readRatioTable(p.current_body.assembled_metrics),
    comparativesDoc: null,
    refusal: null,
    currentLabel: statements.periodLabel,
  });
  return renderWithProviders(
    <RatioCompareCtx.Provider value={view}>
      <RatiosTabContent ratios={ratios} statements={statements} altman={altmanRatio(credit)} />
    </RatioCompareCtx.Provider>,
  );
}

const dioTile = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[data-testid="ratio-tile"][data-ratio-key="dio"]');
  if (!el) throw new Error("no DIO tile");
  return el;
};
const legRow = (root: HTMLElement, key: string): HTMLElement => {
  const el = root.querySelector<HTMLElement>(`[data-inventory-leg="${key}"]`);
  if (!el) throw new Error(`no ${key} row`);
  return el;
};
const col = (root: HTMLElement, c: string) => (root.querySelector(`[data-col="${c}"]`)?.textContent ?? "").trim();

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("the Ratios tab prints the ONE inventory-days block", () => {
  it("the DIO tile's figure is the served row, and the served row is the block's total", () => {
    const p = fresh();
    const block = p.current_body.statements.inventory_days as Json;
    const table = readRatioTable(p.current_body.assembled_metrics)!;
    const dioRow = table.rows.find((r) => r.key === "dio")!;
    // One figure, ONE quantization: the ratio row carries the block's
    // total, and the block quantizes at the ratio table's days rule — the
    // tile's headline and the split's total print the same characters (the
    // tile printed "30" over a split total of "30,2" until 2026-09-27).
    expect(dioRow.value).toBe((block.total as Json).value);
    expect(dioRow.value_q).toBe((block.total as Json).value_q);
    renderTab(p);
    const headline = within(dioTile()).getByTestId("ratio-current").textContent ?? "";
    expect(headline).toContain(printDaysQ(dioRow.value_q as string, "en"));
    fireEvent.click(dioTile());
    const full = within(screen.getByTestId("ratio-detail-drawer")).getByTestId("inventory-days-split");
    expect(col(legRow(full, "total"), "days")).toBe(printDaysQ(dioRow.value_q as string, "en"));
  });

  it("the tile prints every leg with its accounts, alte stocuri and the basis — the block's own figures", () => {
    const p = fresh();
    const block = p.current_body.statements.inventory_days as Json;
    renderTab(p);
    const split = within(dioTile()).getByTestId("inventory-days-split");
    const printed = printInventoryDays(readInventoryDaysSplit(p.current_body.statements)!, "en");
    for (const g of block.groups as Json[]) {
      const row = legRow(split, g.key as string);
      expect(row.textContent).toContain(g.label_en as string);
      expect(col(row, "days")).toBe(printDaysQ(g.value_q as string, "en"));
      for (const code of g.stock_accounts as string[]) expect(col(row, "accounts")).toContain(code);
    }
    expect(col(legRow(split, "other_stock"), "days")).toBe(printed.other!.days);
    expect(within(split).getByTestId("inventory-days-basis").textContent).toBe(
      `Basis: ${(block.basis_label as Json).en}`,
    );
    // only the DIO tile carries it
    expect(document.querySelectorAll('[data-testid="inventory-days-split"]').length).toBe(1);
  });

  it("the drawer prints the full split, the total's flow and the period-end figure", () => {
    const p = fresh();
    const block = p.current_body.statements.inventory_days as Json;
    const total = block.total as Json;
    renderTab(p);
    fireEvent.click(dioTile());
    const drawer = screen.getByTestId("ratio-detail-drawer");
    const splits = within(drawer).getAllByTestId("inventory-days-split");
    expect(splits.length).toBe(1);
    const full = splits[0];
    expect(full.getAttribute("data-variant")).toBe("full");
    const totalRow = legRow(full, "total");
    expect(col(totalRow, "days")).toBe(printDaysQ(total.value_q as string, "en"));
    expect(col(totalRow, "flow")).toBe(`÷ ${(total.flow as Json).label_en}`);
    expect(within(full).getByTestId("inventory-days-closing").textContent).toContain(
      printDaysQ(total.closing_value_q as string, "en"),
    );
  });

  it("in Romanian: decimal comma, the engine's Romanian labels and basis", async () => {
    await i18n.changeLanguage("ro");
    const p = fresh();
    const block = p.current_body.statements.inventory_days as Json;
    renderTab(p);
    const split = within(dioTile()).getByTestId("inventory-days-split");
    for (const g of block.groups as Json[]) {
      const row = legRow(split, g.key as string);
      expect(row.textContent).toContain(g.label_ro as string);
      expect(col(row, "days")).toContain((g.value_q as string).replace(".", ","));
    }
    expect(col(legRow(split, "other_stock"), "days")).toBe("inclus în total, fără zile proprii");
    expect(within(split).getByTestId("inventory-days-basis").textContent).toBe(
      `Bază: ${(block.basis_label as Json).ro}`,
    );
  });

  it("a seasonal block wears the flag on the tile", () => {
    const p = fresh();
    const block = p.current_body.statements.inventory_days as Json;
    block.seasonality = { flagged: true, note_ro: "notă", note_en: "a seasonal note" };
    renderTab(p);
    const flag = within(dioTile()).getByTestId("inventory-days-seasonal");
    expect(flag.textContent).toBe("Seasonal stock");
    expect(flag.getAttribute("title")).toBe("a seasonal note");
  });

  it("with no served table and no block, the tile refuses as inventory days — never as EBITDA", async () => {
    const p = fresh();
    delete p.current_body.statements.inventory_days;
    const statements = p.current_body.statements;
    const ratios = computeRatios(statements, undefined, {});
    const dio = ratios.efficiency.find((r) => r.key === "dio")!;
    expect(dio.value).toBeNull();
    renderWithProviders(
      <RatioCompareCtx.Provider value={null}>
        <RatiosTabContent ratios={ratios} statements={statements} altman={null} />
      </RatioCompareCtx.Provider>,
    );
    const text = within(dioTile()).getByTestId("ratio-unavailable").parentElement!.textContent ?? "";
    expect(text).toContain("Inventory days refused: inventory days are not served for this period");
    expect(text).not.toContain("EBITDA");
    cleanup();
    await i18n.changeLanguage("ro");
    renderWithProviders(
      <RatioCompareCtx.Provider value={null}>
        <RatiosTabContent ratios={ratios} statements={statements} altman={null} />
      </RatioCompareCtx.Provider>,
    );
    expect(dioTile().textContent).toContain("Zile de stoc refuzate: zilele de stoc nu sunt servite pentru această perioadă");
  });

  it("a comparison across two bases prints the basis sentence — no change, no colour — in EN and RO", async () => {
    // The engine refuses the delta (value, % and direction) when the two
    // periods' inventory days sit on different bases (ratio_compare
    // basis_differs; the stock-claim-policy gate reds on a served one).
    // The browser prints the refusal's sentence and no tone — never a
    // "+6 days, deteriorated" between an average and a single day.
    const p = fresh();
    const rows = (p.comparatives.ratios as Json).rows as Json[];
    const dio = rows.find((r) => r.key === "dio")!;
    dio.basis = { current: "average_two_year_ends", prior: "year_end_snapshot" };
    dio.delta = { value: null, unit: "days", pct_change: null, favourable: null, reason_code: "basis_differs" };
    dio.movement = { ...(dio.movement as Json), status: "not_comparable", reason_code: "basis_differs" };
    const view = buildRatioCompareView({
      periodTable: readRatioTable(p.current_body.assembled_metrics),
      comparativesDoc: p.comparatives,
      refusal: null,
      currentLabel: p.current_body.statements.periodLabel,
    });
    for (const lang of ["en", "ro"] as const) {
      await i18n.changeLanguage(lang);
      const row = printRatioRow(view, "dio", lang)!;
      const sentence = i18n.t("statements.ratioCmp.reason.basis_differs");
      expect(sentence).not.toBe("statements.ratioCmp.reason.basis_differs");
      expect(row.delta).toBe(sentence);
      expect(row.deltaTone).toBe("neutral");
      expect(row.delta).not.toMatch(/\d/);
      // The engine refuses ANY mismatch (monthly vs two year-ends too), so
      // the sentence names no particular pair of bases — it said "an
      // average of two balances against a single year-end balance" for
      // every pair.
      expect(row.delta).not.toMatch(/single year-end|singur sold|two balances|două solduri/);
    }
  });

  it("no block, no split on the tile", () => {
    const p = fresh();
    delete p.current_body.statements.inventory_days;
    renderTab(p);
    expect(document.querySelector('[data-testid="inventory-days-split"]')).toBeNull();
  });
});
