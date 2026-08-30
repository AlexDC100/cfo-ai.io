// THE TIER-0 PREVIEW — the answer that arrives while you type.
//
// This file exists because of one defect the screenshot loop could not
// have found and a live probe did: the surface rendered the literal
// string
//
//     "No figure for {{metric}} in this period — it is missing, not zero."
//
// A raw interpolation placeholder, on screen, inside an honest refusal.
// It is the same defect class as a half-arrived `{{money:…}}` — braces
// are the renderer admitting it did not finish, and the answer lane's
// rule is that unfinished output is not shown. The guard is in
// `resolveNote`; these are its teeth.

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({
    display: "RON" as const,
    rates: { rates: { RON: 5, EUR: 1, USD: 1.1 }, as_of: "2026-08-01" },
    setDisplay: () => {},
    refresh: async () => {},
    refreshing: false,
  }),
}));

import type { FactRef } from "@/lib/capsuleFactIndex";
import {
  NOTE_ABSENT,
  NOTE_SINGLE_PERIOD,
  TIER0_NOTE_KEYS,
  type Tier0Answer,
} from "@/lib/capsuleTier0";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CapsuleTier0Preview } from "../CapsuleTier0Preview";
import { hasCopy } from "../capsuleAnswerI18n";

afterEach(cleanup);

const moneyFact: FactRef = {
  factKey: "revenue",
  label: "Revenue",
  value: 4137275.6,
  unit: "money",
  currency: "RON",
  periodId: "p-dec",
  periodLabel: "December 2025",
};

const ratioFact: FactRef = {
  factKey: "current_ratio",
  label: "Current ratio",
  value: 2.8,
  unit: "ratio",
  periodId: "p-dec",
  periodLabel: "December 2025",
};

function show(answer: Tier0Answer | null) {
  // Router + TooltipProvider because a figure is rendered by the REAL
  // renderers: `<Amount>` opens a provenance tooltip and the money path
  // links to its source row. Stubbing either would test a different
  // component than the one that ships.
  render(
    <MemoryRouter>
      <TooltipProvider>
        <CapsuleTier0Preview answer={answer} onOpen={() => {}} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("the placeholder guard", () => {
  it("refuses a note whose interpolation did not resolve", () => {
    // Exactly the live failure: `capsuleTier0.note.absent` wants a
    // `metric`, and this refusal arrived without one.
    show({ kind: "fact", facts: [], refused: true, note: NOTE_ABSENT });
    expect(document.body.textContent ?? "").not.toContain("{{");
    // Nothing at all is the correct outcome — a broken sentence is
    // worse than no sentence.
    expect(screen.queryByTestId("capsule-tier0")).toBeNull();
  });

  it("renders the refusal when the param IS supplied", () => {
    show({
      kind: "fact",
      facts: [],
      refused: true,
      note: NOTE_ABSENT,
      noteParams: { metric: "revenue" },
    });
    const el = screen.getByTestId("capsule-tier0");
    expect(el.dataset.refused).toBe("true");
    expect(el.textContent).toContain("missing, not zero");
    expect(el.textContent).not.toContain("{{");
  });

  it("names the metric in the reader's words, not the engine's", () => {
    show({
      kind: "fact",
      facts: [],
      refused: true,
      note: NOTE_ABSENT,
      noteParams: { metric: "net_result" },
    });
    // "No figure for net_result" points an engine identifier at a
    // person. The label goes through the same resolver the figure list
    // uses, so the two can never call one metric two names.
    expect(screen.getByTestId("capsule-tier0").textContent).not.toContain("net_result");
  });

  it("renders nothing for a note key this build has no copy for", () => {
    show({ kind: "meta", facts: [], refused: true, note: "capsuleTier0.note.invented" });
    expect(screen.queryByTestId("capsule-tier0")).toBeNull();
  });

  it("every note key the resolver can emit HAS copy in this build", () => {
    // The resolver's own published list. If it grows a note and this
    // lane does not register the copy, the guard above silently hides
    // it — so the coverage is asserted here rather than discovered as
    // a blank row.
    const missing = TIER0_NOTE_KEYS.filter((k) => !hasCopy(k));
    expect(missing, `no copy for: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("what a resolution renders", () => {
  it("puts a money figure through the money path, and names its fact", () => {
    show({ kind: "fact", facts: [moneyFact] });
    const el = screen.getByTestId("capsule-tier0");
    expect(el.dataset.kind).toBe("fact");
    // C3's grounding walk needs an ancestor naming the fact — a bare
    // span with a number in it is indistinguishable from a numeral a
    // model typed.
    expect(el.querySelector('[data-fact="revenue"]')).not.toBeNull();
  });

  it("renders a dimensionless fact with no currency attached", () => {
    show({ kind: "fact", facts: [ratioFact] });
    const text = screen.getByTestId("capsule-tier0").textContent ?? "";
    expect(text).not.toMatch(/RON|EUR|€/);
  });

  it("shows at most two facts — a third is a table, and the canvas has one", () => {
    show({
      kind: "compare",
      facts: [moneyFact, { ...moneyFact, periodId: "p-nov", periodLabel: "November 2025" },
        { ...moneyFact, periodId: "p-oct", periodLabel: "October 2025" }],
    });
    expect(
      screen.getByTestId("capsule-tier0").querySelectorAll("[data-fact]").length,
    ).toBe(2);
  });

  it("renders nothing at all when there is no Tier-0 resolution", () => {
    show(null);
    expect(screen.queryByTestId("capsule-tier0")).toBeNull();
  });

  it("a refusal is a STATEMENT, not a button — there is nothing to open", () => {
    show({
      kind: "compare",
      facts: [],
      refused: true,
      note: NOTE_SINGLE_PERIOD,
      noteParams: {},
    });
    const el = screen.getByTestId("capsule-tier0");
    expect(el.tagName.toLowerCase()).not.toBe("button");
  });
});
