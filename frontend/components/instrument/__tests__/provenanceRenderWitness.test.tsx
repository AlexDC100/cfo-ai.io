// THE RENDER WITNESS — the instrument the static census cannot be.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────
//
// `scripts/check_provenance_census.mjs` counts affordance-bearing SITES.
// A critic pointed at the one thing a site count structurally cannot see:
// the kill moved up one layer.
//
//   · flip a single `||` to `&&` in `hasProvenance` and EVERY affordance
//     in the product renders bare — no dotted rule, no card, on every
//     surface at once;
//   · gut `ProvenanceCard`'s body and every dotted rule in the product
//     opens an EMPTY card — the state the census itself calls the worst
//     bucket, a figure offering a provenance jump that lands nowhere.
//
// Under both, the census still reports 76 units, every surface unchanged,
// PASS. It is counting call sites, and the call sites did not move. A
// census of call sites cannot see a primitive that stopped working.
//
// So this file asserts the RENDERED RESULT, and the census RUNS it: the
// gate cannot go green while the affordance is dead. The set of
// primitives covered here is not a list somebody maintains — the census
// DERIVES it from its own measurement (every tag it credits with a
// bearing site must appear in `RENDER_WITNESS`), so a new primitive that
// starts bearing needs a witness before the gate passes.
//
// ── THE FOUR CLAIMS ───────────────────────────────────────────────────
//
//   1. hasProvenance is a DISJUNCTION. Each qualifying field ALONE is
//      enough. (`||` → `&&` dies here, per field, five times.)
//   2. A payload paints the dotted rule, and the rule is the WCAG
//      indicator — not just a data attribute nobody can see.
//   3. The opened card paints the payload's OWN TEXT, field by field.
//      (Gutting ProvenanceCard dies here, per row.)
//   4. Every primitive the census credits with a bearing site really
//      paints one — and refuses when the payload carries nothing.
//
// The existing `provenance.test.tsx` drives hover / focus / Escape and
// the absent-figure refusals. This one is about the payload → pixels
// chain, and is deliberately a separate file so the census can name it.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { MemoryRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";
import { CurrencyProvider } from "@/stores/currency";
import { MoneyAmount } from "@/components/comparison/MoneyAmount";
import { FigureCell } from "@/components/cfo/findings/parts";
import { Amount } from "../Amount";
import {
  ProvenanceAffordance,
  ProvenanceCard,
  hasProvenance,
  type AmountProvenance,
} from "../Provenance";

// Radix's Popper positions through floating-ui, which needs both of
// these; jsdom ships neither.
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
      get top() {
        return this.y;
      }
      get left() {
        return this.x;
      }
      get right() {
        return this.x + this.width;
      }
      get bottom() {
        return this.y + this.height;
      }
      static fromRect() {
        return new (globalThis as never as { DOMRect: new () => unknown }).DOMRect();
      }
      toJSON() {
        return {};
      }
    };
  }
});

const AFF = '[data-provenance="true"]';
const VALUE = 66_280_871.31;

function wrap(node: React.ReactNode) {
  return (
    <MemoryRouter>
      <CurrencyProvider>
        <TooltipProvider>{node}</TooltipProvider>
      </CurrencyProvider>
    </MemoryRouter>
  );
}

function affordance(): HTMLElement | null {
  return document.querySelector(AFF);
}

/** Open by FOCUS — no delay, unlike hover's 150 ms. */
async function open(el: HTMLElement, text: string) {
  fireEvent.focus(el);
  await waitFor(() => expect(screen.getAllByText(text).length).toBeGreaterThan(0));
}

// ══════════════════════════════════════════════════════════════════════
// 1 — hasProvenance IS A DISJUNCTION, FIELD BY FIELD
// ══════════════════════════════════════════════════════════════════════
//
// Asserted at the FUNCTION and again through the RENDER, because the two
// can be broken separately: a `&&` in the predicate kills every card
// while the predicate's unit test still describes a payload that happens
// to carry every field.

const QUALIFYING: Array<[keyof AmountProvenance, string]> = [
  ["source", "sheet Anon_2bb7638cfd"],
  ["accounts", "2131, 2132, 2133"],
  ["method", "deterministic"],
  ["pack", "ro_omfp1802_v2"],
  ["snapshot", "sv1"],
];

describe("hasProvenance — ANY ONE qualifying field is enough", () => {
  for (const [field, sample] of QUALIFYING) {
    it(`\`${field}\` alone qualifies, on its own`, () => {
      expect(hasProvenance({ [field]: sample } as AmountProvenance)).toBe(true);
    });

    it(`\`${field}\` alone paints the dotted rule`, () => {
      render(
        wrap(
          <ProvenanceAffordance provenance={{ [field]: sample }} value={VALUE}>
            <span>66,3 M</span>
          </ProvenanceAffordance>,
        ),
      );
      const el = affordance();
      expect(el, `a payload carrying only \`${field}\` rendered bare`).not.toBeNull();
      // THE DOTTED RULE IS THE AFFORDANCE. A `data-provenance` attribute
      // with no decoration is invisible to a reader, so the indicator is
      // asserted, not the marker.
      expect(el!.className).toMatch(/decoration-dotted/);
      expect(el!.className).toMatch(/decoration-brand\/80/);
      expect(el!.getAttribute("tabindex")).toBe("0");
    });
  }

  it("a payload carrying NOTHING qualifying renders bare", () => {
    render(
      wrap(
        <ProvenanceAffordance provenance={{ period: "FY 2025" }} value={VALUE}>
          <span>66,3 M</span>
        </ProvenanceAffordance>,
      ),
    );
    expect(affordance()).toBeNull();
    expect(hasProvenance({})).toBe(false);
    expect(hasProvenance({ period: "FY 2025" })).toBe(false);
    expect(hasProvenance(null)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2 — THE CARD PAINTS THE PAYLOAD, ROW BY ROW
// ══════════════════════════════════════════════════════════════════════
//
// One assertion per row of the card, each on the PAYLOAD'S OWN TEXT and
// on its label. A gutted `ProvenanceCard` — an empty div, a card that
// renders only `exact`, a card that lost one row in a refactor — fails
// here and cannot reach the census.

const FULL: AmountProvenance = {
  source: "sheet Anon_2bb7638cfd",
  accounts: "2131, 2132, 2133",
  period: "FY 2025",
  method: "deterministic",
  confidence: 0.97,
  pack: "ro_omfp1802_v2",
  computedAt: "2026-09-04T09:00:00Z",
  snapshot: "sv1",
};

describe("ProvenanceCard paints every field the payload carries", () => {
  const ROWS: Array<[string, string]> = [
    ["Source", FULL.source!],
    ["Accounts", FULL.accounts!],
    ["Period", FULL.period!],
    ["Method", FULL.method!],
    ["Pack", FULL.pack!],
  ];

  for (const [label, text] of ROWS) {
    it(`the "${label}" row carries the payload's own value`, () => {
      render(wrap(<ProvenanceCard p={FULL} exact="66.280.871,31 RON" />));
      expect(screen.getAllByText(text).length, `card lost its ${label} value`).toBeGreaterThan(0);
      expect(
        screen.getAllByText((_, node) => node?.textContent?.trim().startsWith(label) === true)
          .length,
        `card lost its "${label}" label`,
      ).toBeGreaterThan(0);
    });
  }

  it("the confidence rides with the method, as a percentage", () => {
    render(wrap(<ProvenanceCard p={FULL} />));
    expect(screen.getAllByText(/97%/).length).toBeGreaterThan(0);
  });

  it("the computed / snapshot footer names both", () => {
    render(wrap(<ProvenanceCard p={FULL} />));
    expect(screen.getAllByText(/computed 2026-09-04T09:00:00Z/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/snapshot sv1/).length).toBeGreaterThan(0);
  });

  it("the exact spelling is the card's first line when one is given", () => {
    render(wrap(<ProvenanceCard p={FULL} exact="66.280.871,31 RON" />));
    expect(screen.getAllByText("66.280.871,31 RON").length).toBeGreaterThan(0);
  });

  it("a card opened through the affordance carries the same rows", async () => {
    render(
      wrap(
        <ProvenanceAffordance provenance={FULL} value={VALUE} exact="66.280.871,31 RON">
          <span>66,3 M</span>
        </ProvenanceAffordance>,
      ),
    );
    const el = affordance();
    expect(el).not.toBeNull();
    await open(el!, FULL.source!);
    expect(screen.getAllByText(FULL.accounts!).length).toBeGreaterThan(0);
    expect(screen.getAllByText(FULL.pack!).length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3 — EVERY PRIMITIVE THE CENSUS CREDITS WITH A BEARING SITE
// ══════════════════════════════════════════════════════════════════════
//
// Measured on this tree: <Amount> 36, <MoneyAmount> 21,
// <ProvenanceAffordance> 14, <BsAmountCell> 4, <FigureCell> 1. The first
// four are covered here or in the file the census names; BsAmountCell is
// local to BSStatementView and its witness is
// `components/cfo/__tests__/statementProvenance.test.tsx`, which the
// census also runs.
//
// Each primitive gets BOTH halves — it paints with a payload, and it
// refuses without one — because a component hard-wired to always paint
// would satisfy half of this and be a fabrication generator.

describe("<Amount> — the general figure primitive", () => {
  it("paints the dotted rule and opens the payload's card", async () => {
    render(wrap(<Amount kind="money" value={VALUE} currency="RON" provenance={FULL} />));
    const el = affordance();
    expect(el).not.toBeNull();
    expect(el!.className).toMatch(/decoration-dotted/);
    await open(el!, FULL.source!);
  });

  it("renders plain when the payload carries nothing", () => {
    render(wrap(<Amount kind="money" value={VALUE} currency="RON" provenance={{}} />));
    expect(affordance()).toBeNull();
  });

  it("renders plain when the FIGURE is absent, whatever the payload says", () => {
    render(wrap(<Amount kind="money" value={null} currency="RON" provenance={FULL} />));
    expect(affordance()).toBeNull();
  });
});

describe("<MoneyAmount> — the converted-money primitive", () => {
  it("paints the dotted rule and opens the payload's card", async () => {
    render(wrap(<MoneyAmount value={VALUE} fromCurrency="RON" provenance={FULL} />));
    const el = affordance();
    expect(el).not.toBeNull();
    expect(el!.className).toMatch(/decoration-dotted/);
    await open(el!, FULL.source!);
  });

  it("renders plain when the payload carries nothing", () => {
    render(wrap(<MoneyAmount value={VALUE} fromCurrency="RON" provenance={null} />));
    expect(affordance()).toBeNull();
  });
});

describe("<FigureCell> — the findings figure", () => {
  const figure = {
    fact: "trade_receivables",
    label: "related-party balance on 461",
    value: VALUE,
    unit: "money" as const,
  };

  it("paints the dotted rule and opens the finding's card", async () => {
    render(
      wrap(
        <FigureCell
          figure={figure}
          facts={{ trade_receivables: VALUE }}
          factUnits={{ trade_receivables: "money" }}
          currency="RON"
          provenance={FULL}
        />,
      ),
    );
    const el = affordance();
    expect(el).not.toBeNull();
    expect(el!.className).toMatch(/decoration-dotted/);
    await open(el!, FULL.source!);
  });

  it("renders plain when the finding carries no provenance", () => {
    render(
      wrap(
        <FigureCell
          figure={figure}
          facts={{ trade_receivables: VALUE }}
          factUnits={{ trade_receivables: "money" }}
          currency="RON"
        />,
      ),
    );
    expect(affordance()).toBeNull();
  });
});
