// PRODUCTS lane — instrument-spec unit checks for the populated-state
// building blocks. The local dev stack cannot mint a Supabase session
// (PUBLIC_TEST_MODE 503s without env), so the populated branch of
// /products is exercised here at the component level instead: mono
// figures via <Amount>/<MoneyAmount>, the filtered-totals row with its
// double hairline, honest em-dash signals in the pre-upload example
// preview, and Chip-based status pills.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { CurrencyProvider } from "@/stores/currency";
import { __productsTestables } from "@/pages/cfo/Products";

const { SkuTable, ExampleResultPreview, DocumentStatusPill, WcCard } = __productsTestables;

function wrap(ui: ReactNode) {
  return render(
    <CurrencyProvider>
      <TooltipProvider>{ui}</TooltipProvider>
    </CurrencyProvider>,
  );
}

const sku = (over: Record<string, unknown>) => ({
  id: "s1",
  product_name: "CONSERVA TON 160G",
  brand: "OCEAN",
  category: "TON",
  volume_tons: 412.5,
  niv_krn: 18250,
  gm_krn: 3420,
  gm_pct: 3420 / 18250,
  real_margin_krn: null,
  real_margin_pct: null,
  days_inventory_on_hand: 92,
  inventory_value_krn: 1480,
  cogs_krn: 5200,
  classification: "anchor" as const,
  classification_reason: null,
  channels_present: ["KA"],
  clients_present: null,
  line_row_count: 120,
  user_override: null,
  ...over,
});

describe("SkuTable — instrument table spec", () => {
  it("renders a filtered-totals row (double hairline) that sums the rendered rows", () => {
    wrap(
      <SkuTable
        rows={[
          sku({ id: "a" }),
          sku({ id: "b", product_name: "MACROU 200G", niv_krn: 1750, gm_krn: -140, gm_pct: -0.08 }),
        ]}
        currency="RON"
        onSelect={() => {}}
      />,
    );
    const totalsRow = screen.getByTestId("sku-table-totals");
    // Double hairline is the spec's totals marker.
    expect(totalsRow.className).toContain("border-top-style:double");
    // NIV total = 18,250k + 1,750k = 20,000,000 RON → "20.0 M RON" scale.
    expect(within(totalsRow).getByText(/20\.0/)).toBeInTheDocument();
  });

  it("renders money figures mono via <Amount> and marks negative GM with the alert token", () => {
    const { container } = wrap(
      <SkuTable
        rows={[sku({ gm_krn: -140, gm_pct: -0.08 })]}
        currency="RON"
        onSelect={() => {}}
      />,
    );
    // Negative GM cell speaks in text-alert, never a raw red palette class.
    expect(container.querySelector(".text-alert")).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/text-red-\d/);
    // Figures are mono (Amount always emits font-mono tabular-nums).
    expect(container.querySelector(".font-mono.tabular-nums")).not.toBeNull();
  });

  it("shows an em-dash for a missing DIO — never a fabricated zero", () => {
    wrap(
      <SkuTable
        rows={[sku({ days_inventory_on_hand: null, inventory_value_krn: null, cogs_krn: null })]}
        currency="RON"
        onSelect={() => {}}
      />,
    );
    const cells = screen.getAllByTestId("sku-dio-cell");
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c).toHaveAttribute("data-dio-available", "false");
      expect(c.textContent).toContain("—");
    }
  });
});

describe("ExampleResultPreview — value visible before upload, nothing invented", () => {
  it("derives DIO from the sample's own inventory/COGS and leaves signals em-dash", () => {
    wrap(<ExampleResultPreview />);
    const section = screen.getByTestId("products-example-result");
    // DIO for row A: 450/1200*365 = 137 (derived, not invented).
    expect(within(section).getByText("137")).toBeInTheDocument();
    // The Signal column stays honestly absent — classification is the
    // engine's judgment, not derivable from a format sample.
    expect(within(section).getAllByText("—").length).toBeGreaterThanOrEqual(3);
    // Totals: 350 t volume across the three fictional rows.
    expect(within(section).getByText("350")).toBeInTheDocument();
  });
});

describe("DocumentStatusPill — one chip system, semantic tones", () => {
  it("maps analyzed → success tint and failed → alert tint", () => {
    const { container: ok } = wrap(<DocumentStatusPill status={"analyzed" as never} active={false} />);
    expect(ok.querySelector(".bg-success-tint")).not.toBeNull();
    const { container: bad } = wrap(<DocumentStatusPill status={"failed" as never} active={false} />);
    expect(bad.querySelector(".bg-alert-tint")).not.toBeNull();
    expect(bad.innerHTML).not.toMatch(/text-red-\d|#[0-9a-fA-F]{6}/);
  });
});

describe("WcCard — honest missing values", () => {
  it("renders the day count mono when available and 'not available' when null", () => {
    const { container } = wrap(
      <WcCard label="DIO" value={92} unit="days" source="src" tone="brand" testid="wc-a" />,
    );
    expect(container.querySelector('[data-available="true"]')).not.toBeNull();
    expect(container.querySelector(".font-mono.tabular-nums")).not.toBeNull();
    const { container: missing } = wrap(
      <WcCard label="CCC" value={null} unit="days" source="src" tone="caution" testid="wc-b" />,
    );
    expect(missing.querySelector('[data-available="false"]')).not.toBeNull();
  });
});
