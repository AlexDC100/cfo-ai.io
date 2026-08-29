// D9 (component half) + the never-fake-trust gate.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Amount, AmountGroup, hasProvenance } from "../Amount";

function wrap(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("<Amount> — magnitude group unity", () => {
  it("all members of a group render on ONE scale", () => {
    wrap(
      <AmountGroup values={[15_100_000, 41_944.6]}>
        <Amount value={15_100_000} currency="€" />
        <Amount value={41_944.6} currency="€" />
      </AmountGroup>,
    );
    expect(screen.getByText(/15\.1\sM€/)).toBeInTheDocument();
    // The small member scales with the group — never "41,944.6 €".
    expect(screen.getByText(/0\.0\sM€/)).toBeInTheDocument();
    expect(screen.queryByText(/41,944/)).not.toBeInTheDocument();
  });
});

describe("<Amount> — the trust rule: never fake provenance", () => {
  it("renders the affordance only when the payload carries substance", () => {
    wrap(
      <Amount
        value={1234}
        currency="€"
        provenance={{ source: "sheet Balanta · row 214 · col G", method: "mechanical" }}
      />,
    );
    const el = document.querySelector('[data-provenance="true"]');
    expect(el).not.toBeNull();
  });

  it("REFUSES the affordance for an empty provenance object", () => {
    // A fake tooltip on a value lacking payload is trust chrome with
    // nothing behind it — the component must render plain.
    wrap(<Amount value={1234} currency="€" provenance={{}} />);
    expect(document.querySelector('[data-provenance="true"]')).toBeNull();
    expect(hasProvenance({})).toBe(false);
    expect(hasProvenance(null)).toBe(false);
  });

  it("renders plain when provenance is absent entirely", () => {
    wrap(<Amount value={1234} currency="€" />);
    expect(document.querySelector('[data-provenance="true"]')).toBeNull();
  });
});

describe("<Amount> — percent + multiple sanity in the DOM", () => {
  it("an insane percent renders as a multiplier", () => {
    wrap(<Amount value={-108.343} kind="percent" />);
    expect(screen.getByText("−108×")).toBeInTheDocument();
  });
  it("a capped multiple renders ≥cap", () => {
    wrap(<Amount value={142.7} kind="multiple" cap={99} />);
    expect(screen.getByText("≥99×")).toBeInTheDocument();
  });
  it("absent renders the em-dash, zero renders zero", () => {
    wrap(<Amount value={null} currency="€" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    wrap(<Amount value={0} kind="count" />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
