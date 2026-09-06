// GATE M1, EXTENDED TO THE ORIGIN — both modes wear the same provenance.
//
// The mode-parity test asserts Simple's StoryOverview and Pro's
// KeyMetricsRow print cent-identical figures from one fixture. This
// asserts the same of their ORIGIN: the page builds one HeadlineProvenance
// and both surfaces receive it, so the card a reader opens on the Pro
// revenue tile and the one they open on the Simple revenue row must be
// the same card — and a figure whose origin the page did not vouch for
// must be plain in BOTH modes, never in one.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

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
const { NO_HEADLINE_PROVENANCE } = await import("@/lib/headlineProvenance");

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const FIXTURE = {
  currency: "RON",
  revenue: 413_727_560.37,
  ebitda: 54_443_834.11,
  profit: 36_787_353.21,
  cash: 8_454_120.55,
  netDebt: 23_456_789.12,
  totalDebt: 31_910_909.67,
};

/** ONE origin object, as the page would build it — revenue and cash
 *  vouched for, net debt derived, profit deliberately absent. */
const ORIGIN = {
  ...NO_HEADLINE_PROVENANCE,
  revenue: {
    source: "scandia_balanta_2025.xlsx",
    accounts: "701, 704, 707, 708",
    method: "subtotal of the listed accounts · Total operating revenue",
    period: "FY 2025",
  },
  cash: {
    source: "scandia_balanta_2025.xlsx · Anon_2bb7638cfd",
    accounts: "5121, 5124, 5311",
    method: "deterministic",
    pack: "ro_omfp1802_v2",
    period: "FY 2025",
  },
  netDebt: { method: "derived · total debt − cash", period: "FY 2025" },
};

const MODE_KEY = "cfo-view-mode-v1";

function Providers({ children }: { children: ReactNode }) {
  return (
    <CurrencyProvider>
      <TooltipProvider>{children}</TooltipProvider>
    </CurrencyProvider>
  );
}

function affordanceUnder(testid: string): HTMLElement | null {
  return screen.getByTestId(testid).querySelector<HTMLElement>('[data-provenance="true"]');
}

function openCardText(): string {
  return Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]"))
    .map((n) => n.textContent ?? "")
    .join(" ");
}

function renderSimple() {
  localStorage.setItem(MODE_KEY, "simple");
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
        provenance={ORIGIN}
      />
    </Providers>,
  );
}

function renderPro() {
  localStorage.setItem(MODE_KEY, "pro");
  render(
    <Providers>
      <KeyMetricsRow
        currency={FIXTURE.currency}
        items={[
          { label: "Revenue", desc: "d", value: FIXTURE.revenue, trend: null, testid: "key-metric-revenue", provenance: ORIGIN.revenue },
          { label: "Net profit", desc: "d", value: FIXTURE.profit, trend: null, testid: "key-metric-profit", provenance: ORIGIN.profit },
          { label: "Cash", desc: "d", value: FIXTURE.cash, trend: null, testid: "key-metric-cash", provenance: ORIGIN.cash },
          { label: "Net debt", desc: "d", value: FIXTURE.netDebt, trend: null, testid: "key-metric-net-debt", provenance: ORIGIN.netDebt },
        ]}
      />
    </Providers>,
  );
}

beforeEach(() => bag.clear());
afterEach(() => cleanup());

describe("the same figure wears the same origin in both modes", () => {
  it("revenue, cash and net debt carry it; profit is plain — in Simple", () => {
    renderSimple();
    expect(affordanceUnder("story-figure-revenue-amount")).not.toBeNull();
    expect(affordanceUnder("story-figure-cash-amount")).not.toBeNull();
    expect(affordanceUnder("story-figure-net-debt-amount")).not.toBeNull();
    expect(affordanceUnder("story-figure-profit-amount")).toBeNull();
  });

  it("revenue, cash and net debt carry it; profit is plain — in Pro", () => {
    renderPro();
    expect(affordanceUnder("key-metric-revenue-amount")).not.toBeNull();
    expect(affordanceUnder("key-metric-cash-amount")).not.toBeNull();
    expect(affordanceUnder("key-metric-net-debt-amount")).not.toBeNull();
    expect(affordanceUnder("key-metric-profit-amount")).toBeNull();
  });

  it("the card a reader opens on cash is the same card in both modes", async () => {
    renderSimple();
    fireEvent.focus(affordanceUnder("story-figure-cash-amount")!);
    await waitFor(() => expect(openCardText()).toContain("5121, 5124, 5311"));
    const simpleCard = openCardText();
    cleanup();

    renderPro();
    fireEvent.focus(affordanceUnder("key-metric-cash-amount")!);
    await waitFor(() => expect(openCardText()).toContain("5121, 5124, 5311"));
    const proCard = openCardText();

    expect(proCard).toBe(simpleCard);
    expect(proCard).toContain("ro_omfp1802_v2");
    expect(proCard).toContain("Anon_2bb7638cfd");
  });

  it("every affordance in both modes is reachable by keyboard", () => {
    renderSimple();
    const simple = Array.from(document.querySelectorAll<HTMLElement>('[data-provenance="true"]'));
    expect(simple.length).toBe(3);
    for (const el of simple) expect(el.getAttribute("tabindex")).toBe("0");
    cleanup();
    renderPro();
    const pro = Array.from(document.querySelectorAll<HTMLElement>('[data-provenance="true"]'));
    expect(pro.length).toBe(3);
    for (const el of pro) expect(el.getAttribute("tabindex")).toBe("0");
  });
});

describe("no origin, no affordance — in both modes", () => {
  it("the empty map renders every figure plain", () => {
    localStorage.setItem(MODE_KEY, "simple");
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
          provenance={NO_HEADLINE_PROVENANCE}
        />
      </Providers>,
    );
    expect(document.querySelectorAll('[data-provenance="true"]').length).toBe(0);
  });
});
