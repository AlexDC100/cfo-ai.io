// THE DIAL — Simple-mode statement disclosure (Prompt 12, Part C §2) +
// first-upload journey (Part E2).
//
// BSStatementView (the real-period path the demo stack can't reach —
// demo periods carry no lineItems, so the live review covered PL/CF only):
//   · Simple collapsed → only builder-marked subtotal/total rows render,
//     the "Show all lines" toggle is present, totals untouched;
//   · expanding shows the item rows (the untouched full table);
//   · Pro → no toggle, every row renders exactly as today;
//   · <Term> affordance appears only in Simple and only on rows the
//     glossary maps; Pro labels carry no data-term.
//
// FirstUploadJourney:
//   · Skip is visible on every step; the 3 steps advance; Done fires;
//   · a render error inside the overlay calls onDone (never blocks).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// In-memory localStorage (this jsdom build ships a broken one).
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

// Currency store is context-backed — mock the hooks the renderers consume
// (same pattern as lib/__tests__/bsReconcileFlow.test.tsx).
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

const { BSStatementView } = await import("@/components/cfo/BSStatementView");
const { FirstUploadJourney } = await import("@/components/cfo/simple/FirstUploadJourney");
const { TooltipProvider } = await import("@/components/ui/tooltip");
import type { BSStatement } from "@/lib/bsStructure";

const MODE_KEY = "cfo-view-mode-v1";

// ─── fixture — hand-built statement with item + subtotal rows ───────────

function bsFixture(): BSStatement {
  return {
    entity: "Test SRL",
    asOf: "31.12.2025",
    comparativeDate: "01.01.2025",
    currency: "RON",
    assetSections: [
      {
        header: "CURRENT ASSETS",
        lines: [
          // Detail row — hides when collapsed. No bucket (so no Learnable
          // wrapper); account 301 maps to the "inventory" glossary id.
          { label: "Materii prime", accountCode: "301", opening: 10, closing: 12, style: "item" },
          { label: "Casa în lei", accountCode: "5311", opening: 5, closing: 6, style: "item" },
        ],
        subtotalLabel: "Total active circulante",
        subtotalOpening: 15,
        subtotalClosing: 18,
        subtotalDelta: 3,
      },
    ],
    totalAssets: { opening: 15, closing: 18, delta: 3 },
    equityLiabSections: [
      {
        header: "EQUITY",
        lines: [
          { label: "Capital social", accountCode: "1012", opening: 15, closing: 18, style: "item" },
        ],
        subtotalLabel: "Total capitaluri",
        subtotalOpening: 15,
        subtotalClosing: 18,
        subtotalDelta: 3,
      },
    ],
    totalEquityLiab: { opening: 15, closing: 18, delta: 3 },
    balanceCheck: 0,
  };
}

function renderBs(mode: "simple" | "pro") {
  localStorage.setItem(MODE_KEY, mode);
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <BSStatementView statement={bsFixture()} hideGuide periodId="p1" />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("BSStatementView — Simple totals-first disclosure", () => {
  beforeEach(() => bag.clear());
  afterEach(() => cleanup());

  it("Simple collapsed: item rows hide, subtotals/totals stay, toggle present", () => {
    renderBs("simple");
    expect(screen.getByTestId("bs-show-all")).toBeInTheDocument();
    // Detail rows hidden.
    expect(screen.queryByText("Materii prime")).toBeNull();
    expect(screen.queryByText("Capital social")).toBeNull();
    // Headline rows stay.
    expect(screen.getByText("Total active circulante")).toBeInTheDocument();
    expect(screen.getByText("Total capitaluri")).toBeInTheDocument();
    // Grand totals untouched.
    expect(screen.getByTestId("bs-total-assets-label")).toBeInTheDocument();
  });

  it("Show all lines expands to the full table; collapsing hides again", () => {
    renderBs("simple");
    fireEvent.click(screen.getByTestId("bs-show-all"));
    expect(screen.getByText("Materii prime")).toBeInTheDocument();
    expect(screen.getByText("Capital social")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("bs-show-all"));
    expect(screen.queryByText("Materii prime")).toBeNull();
  });

  it("Simple expanded: glossary-mapped label carries the Term affordance, unmapped renders verbatim", () => {
    renderBs("simple");
    fireEvent.click(screen.getByTestId("bs-show-all"));
    // 301 → "inventory" in the dictionary → data-term affordance.
    const inv = screen.getByText("Materii prime");
    expect(inv.getAttribute("data-term")).toBe("inventory");
    // 5311 is not in the map → verbatim, no affordance.
    const cash = screen.getByText("Casa în lei");
    expect(cash.getAttribute("data-term")).toBeNull();
  });

  it("Pro: no toggle, every row renders (untouched), no Term affordances", () => {
    renderBs("pro");
    expect(screen.queryByTestId("bs-show-all")).toBeNull();
    expect(screen.getByText("Materii prime")).toBeInTheDocument();
    expect(screen.getByText("Capital social")).toBeInTheDocument();
    expect(screen.getByText("Materii prime").getAttribute("data-term")).toBeNull();
  });
});

// ─── first-upload journey ───────────────────────────────────────────────

function renderJourney(onDone: () => void) {
  localStorage.setItem(MODE_KEY, "simple");
  return render(
    <TooltipProvider>
      <FirstUploadJourney
        currency="RON"
        revenue={1_000_000}
        profit={100_000}
        cash={50_000}
        trustBand="clean"
        trustChip={<span data-testid="frozen-chip">Verified</span>}
        recommendations={[]}
        onDone={onDone}
      />
    </TooltipProvider>,
  );
}

describe("FirstUploadJourney — skippable 3-step reveal", () => {
  beforeEach(() => bag.clear());
  afterEach(() => cleanup());

  it("walks the 3 steps with Skip always visible, then fires onDone", async () => {
    const onDone = vi.fn();
    renderJourney(onDone);
    // Step 1 — trust state, frozen chip rendered verbatim.
    expect(screen.getByTestId("frozen-chip")).toBeInTheDocument();
    expect(screen.getByTestId("journey-skip")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("journey-continue"));
    // Step 2 — the three headline figures (AnimatePresence mode="wait"
    // mounts the next step after the exit transition — await it).
    expect(await screen.findByTestId("journey-figure-revenue")).toBeInTheDocument();
    expect(screen.getByTestId("journey-figure-cash")).toBeInTheDocument();
    expect(screen.getByTestId("journey-skip")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("journey-continue"));
    // Step 3 — the one thing to watch (all-clear with no recs) + finish.
    const finish = await screen.findByTestId("journey-finish");
    expect(screen.getByTestId("journey-skip")).toBeInTheDocument();
    fireEvent.click(finish);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("Skip fires onDone immediately from step 1", () => {
    const onDone = vi.fn();
    renderJourney(onDone);
    fireEvent.click(screen.getByTestId("journey-skip"));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a render error inside the overlay dismisses it (never blocks)", () => {
    const onDone = vi.fn();
    function Bomb(): never {
      throw new Error("boom");
    }
    // React logs caught boundary errors — silence for this one render.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      localStorage.setItem(MODE_KEY, "simple");
      render(
        <TooltipProvider>
          <FirstUploadJourney
            currency="RON"
            revenue={1}
            profit={1}
            cash={1}
            trustBand="clean"
            trustChip={<Bomb />}
            recommendations={[]}
            onDone={onDone}
          />
        </TooltipProvider>,
      );
    } finally {
      spy.mockRestore();
    }
    // Boundary swallowed the error, called onDone, rendered nothing.
    expect(onDone).toHaveBeenCalled();
    expect(screen.queryByTestId("first-upload-journey")).toBeNull();
  });
});
