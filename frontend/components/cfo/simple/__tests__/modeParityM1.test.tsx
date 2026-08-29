// GATE M1 — mode parity (Prompt 12, hard rule 1).
//
// Modes are PRESENTATION ONLY. This test renders the shared headline
// figures (revenue · profit · cash · net debt) from ONE fixture payload
// through BOTH surfaces — Simple's StoryOverview and Pro's REAL
// KeyMetricsRow (the extracted component the dashboard overview mounts)
// — with the view mode pinned to "simple" and "pro" respectively, and
// asserts the <Amount> output strings are IDENTICAL, cent for cent.
//
// Both surfaces convert through the shared useConvertedAmounts hook and
// render under an <AmountGroup> whose scale is picked by the largest
// member (revenue in both sets), so any drift — a branch on mode, a
// second conversion path, a different magnitude set — fails here.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

// This jsdom build exposes localStorage as a bare object with no working
// methods (same as explainM4.test.tsx) — install an in-memory Storage.
const bag = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, String(v)),
    removeItem: (k: string) => void bag.delete(k),
    clear: () => void bag.clear(),
    key: (i: number) => [...bag.keys()][i] ?? null,
    get length() {
      return bag.size;
    },
  },
});

const { CurrencyProvider } = await import("@/stores/currency");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { StoryOverview } = await import("@/components/cfo/simple/StoryOverview");
const { KeyMetricsRow } = await import("@/components/cfo/KeyMetricsRow");
// Gates-lane shared M1 machinery — render one fixture under BOTH modes.
const { renderBothModes, expectParityBySelector } = await import(
  "@/lib/__tests__/modeParityHarness"
);

// ── the ONE fixture payload ────────────────────────────────────────────
// Cents on purpose: "cent-identical" must survive rounding/scale picking.
const FIXTURE = {
  currency: "RON",
  revenue: 413_727_560.37,
  ebitda: 54_443_834.11,
  profit: 36_787_353.21,
  cash: 8_454_120.55,
  netDebt: 23_456_789.12,
  totalDebt: 31_910_909.67,
};

const MODE_KEY = "cfo-view-mode-v1";

function Providers({ children }: { children: ReactNode }) {
  return (
    <CurrencyProvider>
      <TooltipProvider>{children}</TooltipProvider>
    </CurrencyProvider>
  );
}

function amountText(testid: string): string {
  const el = screen.getByTestId(testid);
  return (el.textContent ?? "").trim();
}

function renderSimpleStory(mode: "simple" | "pro" = "simple"): Record<string, string> {
  localStorage.setItem(MODE_KEY, mode);
  render(
    <Providers>
      <StoryOverview
        currency={FIXTURE.currency}
        revenue={FIXTURE.revenue}
        profit={FIXTURE.profit}
        cash={FIXTURE.cash}
        netDebt={FIXTURE.netDebt}
        totalDebt={FIXTURE.totalDebt}
        ebitda={FIXTURE.ebitda}
        annualOperatingCosts={null}
        revenueTrend={null}
        recommendations={[]}
      />
    </Providers>,
  );
  const out = {
    revenue: amountText("story-figure-revenue-amount"),
    profit: amountText("story-figure-profit-amount"),
    cash: amountText("story-figure-cash-amount"),
    netDebt: amountText("story-figure-net-debt-amount"),
  };
  cleanup();
  return out;
}

function renderProKeyMetrics(): Record<string, string> {
  localStorage.setItem(MODE_KEY, "pro");
  // The REAL Pro row, with the page's item shape. Includes EBITDA (the
  // slot the live overview renders) plus the profit figure so all four
  // shared figures pass through the Pro pipeline; revenue stays the
  // largest group member either way, so the shared scale matches the
  // Simple group's by construction — exactly the production condition.
  render(
    <Providers>
      <KeyMetricsRow
        currency={FIXTURE.currency}
        items={[
          { label: "Revenue", desc: "d", value: FIXTURE.revenue, trend: null, testid: "key-metric-revenue" },
          { label: "EBITDA", desc: "d", value: FIXTURE.ebitda, trend: null, testid: "key-metric-ebitda" },
          { label: "Net profit", desc: "d", value: FIXTURE.profit, trend: null, testid: "key-metric-profit" },
          { label: "Cash", desc: "d", value: FIXTURE.cash, trend: null, testid: "key-metric-cash" },
          { label: "Net debt", desc: "d", value: FIXTURE.netDebt, trend: null, testid: "key-metric-net-debt" },
        ]}
      />
    </Providers>,
  );
  const out = {
    revenue: amountText("key-metric-revenue-amount"),
    profit: amountText("key-metric-profit-amount"),
    cash: amountText("key-metric-cash-amount"),
    netDebt: amountText("key-metric-net-debt-amount"),
  };
  cleanup();
  return out;
}

describe("gate M1 — Simple and Pro render cent-identical figures from one payload", () => {
  beforeEach(() => bag.clear());
  afterEach(() => cleanup());

  it("revenue / profit / cash / net debt strings are identical across modes", () => {
    const simple = renderSimpleStory();
    const pro = renderProKeyMetrics();

    // Guard against a trivially-true comparison of placeholders: every
    // captured string must be a real formatted figure.
    for (const v of [...Object.values(simple), ...Object.values(pro)]) {
      expect(v).toMatch(/\d/);
      expect(v).not.toBe("—");
    }

    expect(simple.revenue).toBe(pro.revenue);
    expect(simple.profit).toBe(pro.profit);
    expect(simple.cash).toBe(pro.cash);
    expect(simple.netDebt).toBe(pro.netDebt);
  });

  it("figures do not branch on the mode flag itself", () => {
    // Render the SAME surface under both persisted modes — the strings
    // may not move (presentation-only guarantee from the other side:
    // the mode flag flips arrangement/labels, never a value).
    const underSimple = renderSimpleStory("simple");
    const underPro = renderSimpleStory("pro");
    expect(underPro).toEqual(underSimple);
  });

  it("harness gate: BOTH surfaces render cent-identical figure strings under both modes", () => {
    // The gates lane's renderBothModes wraps Query/Router/Tooltip; the
    // currency store is ours to provide. One fixture carrying BOTH
    // surfaces, one shared selector over every `-amount` node — the
    // strings (and their count) must be equal across the mode flip.
    const both = renderBothModes(
      <CurrencyProvider>
        <StoryOverview
          currency={FIXTURE.currency}
          revenue={FIXTURE.revenue}
          profit={FIXTURE.profit}
          cash={FIXTURE.cash}
          netDebt={FIXTURE.netDebt}
          totalDebt={FIXTURE.totalDebt}
          ebitda={FIXTURE.ebitda}
          annualOperatingCosts={null}
          revenueTrend={null}
          recommendations={[]}
        />
        <KeyMetricsRow
          currency={FIXTURE.currency}
          items={[
            { label: "Revenue", desc: "d", value: FIXTURE.revenue, trend: null, testid: "key-metric-revenue" },
            { label: "Net profit", desc: "d", value: FIXTURE.profit, trend: null, testid: "key-metric-profit" },
            { label: "Cash", desc: "d", value: FIXTURE.cash, trend: null, testid: "key-metric-cash" },
            { label: "Net debt", desc: "d", value: FIXTURE.netDebt, trend: null, testid: "key-metric-net-debt" },
          ]}
        />
      </CurrencyProvider>,
    );
    expectParityBySelector(both, '[data-testid$="-amount"]');
  });
});
