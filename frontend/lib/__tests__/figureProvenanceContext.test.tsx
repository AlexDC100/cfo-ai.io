// THE CONFIGURABLE TILE LEARNS ITS ORIGIN BY CONCEPT — and refuses to
// borrow it for a different number.
//
// The map the page provides pairs each concept with the VALUE it vouched
// for. A tile whose resolver produced any other value (a derived margin,
// a stale snapshot, a rounding) must render plain: the headline's origin
// on a number the headline never showed is the fabricated affordance
// this whole lane exists to remove.

import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  FigureProvenanceProvider,
  useFigureProvenance,
  type FigureProvenanceMap,
} from "@/lib/figureProvenanceContext";

function Probe({ concept, value }: { concept: string; value: number | null }) {
  const p = useFigureProvenance(concept, value);
  return <span data-testid="probe">{p ? p.source ?? p.method ?? "some" : "none"}</span>;
}

const MAP: FigureProvenanceMap = {
  ebitda: {
    value: 12_345_678.9,
    provenance: { source: "tb.xlsx · assembled_pl.ebitda_statutory" },
  },
  net_debt: { value: 3_000, provenance: { method: "derived · total debt − cash" } },
  cash: { value: 500, provenance: null },
};

function mount(concept: string, value: number | null) {
  cleanup();
  render(
    <FigureProvenanceProvider value={MAP}>
      <Probe concept={concept} value={value} />
    </FigureProvenanceProvider>,
  );
  return screen.getByTestId("probe").textContent;
}

describe("useFigureProvenance", () => {
  it("hands over the origin when the concept AND the value match to the cent", () => {
    expect(mount("ebitda", 12_345_678.9)).toBe("tb.xlsx · assembled_pl.ebitda_statutory");
    expect(mount("ebitda", 12_345_678.904)).toBe("tb.xlsx · assembled_pl.ebitda_statutory");
  });

  it("refuses a different value for the same concept", () => {
    expect(mount("ebitda", 12_345_678.0)).toBe("none");
  });

  it("refuses a concept the page did not vouch for", () => {
    expect(mount("ebitda_margin", 0.13)).toBe("none");
  });

  it("refuses when the page vouched for the concept but holds no origin", () => {
    expect(mount("cash", 500)).toBe("none");
  });

  it("refuses a null value", () => {
    expect(mount("net_debt", null)).toBe("none");
  });

  it("renders plain outside any provider", () => {
    cleanup();
    render(<Probe concept="ebitda" value={12_345_678.9} />);
    expect(screen.getByTestId("probe").textContent).toBe("none");
  });
});
