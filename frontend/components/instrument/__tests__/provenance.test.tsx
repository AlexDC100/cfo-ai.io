// THE AFFORDANCE, MEASURED — hover, focus, Escape, and the refusal.
//
// The claim "it works on hover and on focus and dismisses with Escape"
// is three separate behaviours from a third-party primitive. Reading
// Radix's source and asserting the wiring is not the same as watching
// the card appear and disappear, so each one is DRIVEN here: an event
// goes in, the card's own text is asserted out.
//
// The refusal half matters at least as much. A card that appears over a
// payload carrying nothing is the defect this lane exists to remove, so
// an empty object, a null and a period-only payload are each planted and
// each expected to render plain.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ProvenanceAffordance,
  hasProvenance,
  provenanceOf,
} from "../Provenance";

// Radix's Popper positions through floating-ui, which needs both of
// these; jsdom ships neither. Stubbed locally rather than in the shared
// setup file so nothing else in the suite changes behaviour.
beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!("DOMRect" in globalThis)) {
    (globalThis as unknown as { DOMRect: unknown }).DOMRect = class {
      constructor(
        public x = 0,
        public y = 0,
        public width = 0,
        public height = 0,
      ) {}
      get top() { return this.y; }
      get left() { return this.x; }
      get right() { return this.x + this.width; }
      get bottom() { return this.y + this.height; }
      static fromRect() { return new (globalThis as never as { DOMRect: new () => unknown }).DOMRect(); }
      toJSON() { return {}; }
    };
  }
});

const FULL = {
  source: "sheet Anon_2bb7638cfd",
  accounts: "2131, 2132, 2133",
  period: "FY 2025",
  method: "deterministic",
  pack: "ro_omfp1802_v2",
  snapshot: "sv1",
};

function mount(p: Parameters<typeof ProvenanceAffordance>[0]["provenance"]) {
  return render(
    <TooltipProvider>
      <ProvenanceAffordance provenance={p} exact="66.280.871,31 RON">
        <span>66,3 M</span>
      </ProvenanceAffordance>
    </TooltipProvider>,
  );
}

function trigger() {
  const el = document.querySelector('[data-provenance="true"]');
  if (!el) throw new Error("no affordance rendered");
  return el as HTMLElement;
}

describe("the affordance opens on HOVER", () => {
  it("a pointer over the figure reveals the source", async () => {
    mount(FULL);
    fireEvent.pointerMove(trigger());
    // delayDuration is 150ms — waitFor polls past it rather than the
    // test asserting on the same tick and calling a race a pass.
    await waitFor(() =>
      expect(screen.getAllByText("sheet Anon_2bb7638cfd").length).toBeGreaterThan(0),
    );
  });
});

describe("the affordance opens on FOCUS — a keyboard user gets the same thing", () => {
  // MEASURED, not assumed: deleting `tabIndex={0}` from the trigger was
  // planted and only THIS assertion went red. The two `fireEvent.focus`
  // tests below stayed green, because dispatching a focus event at a
  // span works whether or not a keyboard could ever put focus there.
  // So the reachability half of "it works on focus" is guarded here and
  // nowhere else — the behavioural tests alone would have passed over a
  // figure no keyboard user can reach.
  it("the figure is reachable by keyboard", () => {
    mount(FULL);
    expect(trigger().getAttribute("tabindex")).toBe("0");
  });

  it("focusing it reveals the same card, with no delay", async () => {
    mount(FULL);
    fireEvent.focus(trigger());
    await waitFor(() =>
      expect(screen.getAllByText("2131, 2132, 2133").length).toBeGreaterThan(0),
    );
  });
});

describe("the affordance dismisses with ESCAPE", () => {
  it("Escape closes a card opened by focus", async () => {
    mount(FULL);
    fireEvent.focus(trigger());
    await waitFor(() =>
      expect(screen.getAllByText("ro_omfp1802_v2").length).toBeGreaterThan(0),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("ro_omfp1802_v2")).toBeNull());
  });
});

describe("only the fields the payload carries are rendered", () => {
  it("a payload with a source and nothing else names no pack and no snapshot", async () => {
    mount({ source: "10-K" });
    fireEvent.focus(trigger());
    await waitFor(() => expect(screen.getAllByText("10-K").length).toBeGreaterThan(0));
    // No placeholder for an absent field — a card that lists "Pack —"
    // has invented a fact about the pack.
    expect(screen.queryByText(/Pack/)).toBeNull();
    expect(screen.queryByText(/Snapshot/i)).toBeNull();
    expect(screen.queryByText(/Accounts/)).toBeNull();
  });
});

describe("NEVER FAKE IT — the refusals", () => {
  it("an empty payload renders the figure plain", () => {
    mount({});
    expect(document.querySelector('[data-provenance="true"]')).toBeNull();
    expect(screen.getByText("66,3 M")).toBeInTheDocument();
  });

  it("a null payload renders the figure plain", () => {
    mount(null);
    expect(document.querySelector('[data-provenance="true"]')).toBeNull();
  });

  it("a PERIOD alone is not provenance", () => {
    // Every fact in the index carries a period label. If a period bought
    // the affordance, every figure in the product would wear it and none
    // of them would be saying anything — which is precisely how the
    // affordance stops meaning something. This was a live defect in
    // CapsuleTier0Preview: `{ source: fact.periodLabel }` put "FY 2025"
    // in a field the card labels "Source".
    mount({ period: "FY 2025" });
    expect(hasProvenance({ period: "FY 2025" })).toBe(false);
    expect(document.querySelector('[data-provenance="true"]')).toBeNull();
  });

  it("whitespace is not substance", () => {
    expect(provenanceOf({ source: "   ", pack: "" })).toBeNull();
    expect(hasProvenance({ source: "" })).toBe(false);
  });

  it("provenanceOf keeps what is real and drops what is empty", () => {
    const p = provenanceOf({
      source: "sheet Balanta",
      accounts: "",
      period: "FY 2025",
      pack: undefined,
      confidence: Number.NaN,
    });
    expect(p).toEqual({ source: "sheet Balanta", period: "FY 2025" });
  });
});
