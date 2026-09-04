// AN ABSENT FIGURE WEARS NO CARD — the findings cell.
//
// `FigureValue` paints "—" for a value that is not a finite number, and
// until 2026-09-04 `FigureCell` wrapped that dash in the finding's FULL
// provenance — Source, Accounts, Period, snapshot — so a reader hovering
// a figure that does not exist was handed an origin for it (critic
// finding #2, commit ea6df1f). The affordance now takes the figure and
// refuses an absent one; this file plants the shape and expects the
// refusal, with the positive control beside it so a refusal-of-
// everything cannot pass.

import { describe, expect, it, vi, beforeAll } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";

const RATES = { EUR: 1, RON: 5.2489, USD: 1.16 };
vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({
    display: "RON",
    rates: { rates: RATES, as_of: "2026-05-22", source: "BNR", stale: false },
    setDisplay: () => {},
    refresh: async () => {},
    refreshing: false,
  }),
  useDisplayCurrency: () => "RON",
  useRates: () => ({ rates: RATES }),
  useAmountFormatter: () => (v: number | null | undefined) => String(v ?? ""),
}));

import { FigureCell, findingProvenance } from "../parts";
import type { FindingFigure, FindingProvenance } from "@/lib/findings";

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// The provenance shape the engine emits on every surfaced finding
// (`evidence.provenance`), with the field names of the contract.
const PROVENANCE: FindingProvenance = {
  period_id: "p-carniprod_fy2025",
  snapshot_id: "snap-carniprod_fy2025",
  line_refs: ["5121", "5311"],
  source: "assembled_canonical_v1",
};

function mount(figure: FindingFigure) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <FigureCell
          figure={figure}
          facts={{ cash: figure.value }}
          factUnits={{ cash: "money" }}
          currency="RON"
          provenance={findingProvenance(PROVENANCE)}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const affordance = () => document.querySelector('[data-provenance="true"]');

describe("FigureCell — the figure decides whether the card may open", () => {
  it("a present figure wears the finding's provenance (positive control)", async () => {
    mount({ fact: "cash", value: 1_234_567, unit: "money", label: "Cash" });
    const el = affordance();
    expect(el, "no affordance on a real figure").not.toBeNull();
    fireEvent.focus(el as HTMLElement);
    await waitFor(() =>
      expect(screen.getAllByText("assembled_canonical_v1").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("5121, 5311").length).toBeGreaterThan(0);
  });

  it("an ABSENT figure paints the dash with NO card, whatever the payload says", () => {
    // `FindingFigure.value` is typed number; the parser drops non-finite
    // values, but a cell can still be handed one by a caller that did
    // not go through the parser. NaN is the absent shape here.
    mount({ fact: "cash", value: Number.NaN, unit: "money", label: "Cash" });
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(affordance(), "a dash opened a provenance card").toBeNull();
  });

  it("a real zero is a figure and keeps the card", () => {
    mount({ fact: "cash", value: 0, unit: "money", label: "Cash" });
    expect(affordance()).not.toBeNull();
  });
});
