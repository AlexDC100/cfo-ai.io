// THE FINDINGS FIGURES NAME THEIR ORIGIN — measured on REAL engine output.
//
// TC-1: `ENGINE_REPORT` is the agras_fy2025 period run through
// `s_engine.run_single_period` and dumped verbatim (see engineFixture.ts).
// Every string asserted below is read back OUT of that fixture rather
// than restated, so the test moves with the engine.
//
// Four figures used to render bare on a card that painted provenance
// DOTS beside them: the threshold's limit and observed value, and the
// impact's two endpoints. All checks' rows painted a limit whose
// parameter file the same report names two objects away. Each is
// opened here by FOCUS (the keyboard path — a hover-only card would be
// decorative for a keyboard reader) and its text asserted.
//
// TC-2 was run on this file: with `thresholdLimitProvenance` returning
// null, "the LIMIT names its parameter file" went red on
// `no affordance rendered`; with the `source:` lookup in
// `checkLimitProvenance` removed, "a check row's LIMIT …" went red on
// the missing `profiles.yaml` text. Both were reverted.

import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";

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

import { buildFindingsReport } from "@/lib/findings";
import { FindingCard } from "../FindingCard";
import { AllChecksList } from "../AllChecksList";
import { ENGINE_REPORT } from "./engineFixture";

// Radix's Popper needs both of these; jsdom ships neither.
beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const MODE_KEY = "cfo-view-mode-v1";
const render = (ui: Parameters<typeof rtlRender>[0]) =>
  rtlRender(
    <MemoryRouter>
      <TooltipProvider>{ui}</TooltipProvider>
    </MemoryRouter>,
  );

const report = () => buildFindingsReport(ENGINE_REPORT);
const finding = () => {
  const f = report().surfaced.find((x) => x.ruleKey === "concentration_related_party");
  if (!f) throw new Error("fixture lost the 461 finding");
  return f;
};

/** The fixture's own words, read back rather than restated. */
const THRESHOLD = () => finding().elements.threshold!;
const PROVENANCE = () => finding().elements.evidence!.provenance!;

function affordancesWithin(testid: string): HTMLElement[] {
  return Array.from(
    screen.getByTestId(testid).querySelectorAll<HTMLElement>('[data-provenance="true"]'),
  );
}

async function openByFocus(el: HTMLElement): Promise<void> {
  fireEvent.focus(el);
  await waitFor(() => {
    const cards = document.querySelectorAll("[data-radix-popper-content-wrapper]");
    if (cards.length === 0) throw new Error("card did not open");
  });
}

/** Text of every open card — Radix renders the tooltip twice (visible +
 *  a11y copy); collapsing to one string makes the assertions about
 *  content, not about that implementation detail. */
function openCardText(): string {
  return Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]"))
    .map((n) => n.textContent ?? "")
    .join(" ");
}

beforeEach(() => {
  cleanup();
  bag.clear();
  localStorage.setItem(MODE_KEY, "pro");
});

describe("the fixture actually carries what the cards would show", () => {
  it("the 461 threshold names a parameter file and a rule", () => {
    const t = THRESHOLD();
    expect(t.source).toContain("profiles.yaml");
    expect(t.rule_id).toBe("concentration_related_party");
    expect(t.parameter).toBeTruthy();
  });
  it("the finding names a source, line refs and a snapshot", () => {
    const p = PROVENANCE();
    expect(p.source).toBeTruthy();
    expect(p.line_refs.length).toBeGreaterThan(0);
    expect(p.snapshot_id).toBeTruthy();
  });
});

describe("the threshold's two figures", () => {
  it("both wear the affordance, and both are reachable by keyboard", () => {
    render(<FindingCard finding={finding()} />);
    const found = affordancesWithin("fnd-threshold");
    expect(found.length, "the meter rendered no affordance at all").toBe(2);
    for (const el of found) expect(el.getAttribute("tabindex")).toBe("0");
  });

  it("the LIMIT names its parameter file and the rule — and NO snapshot", async () => {
    render(<FindingCard finding={finding()} />);
    const [limit] = affordancesWithin("fnd-threshold");
    await openByFocus(limit);
    const text = openCardText();
    expect(text).toContain(THRESHOLD().source);
    expect(text).toContain(`rule ${THRESHOLD().rule_id}`);
    // A limit is not measured on a balance sheet.
    expect(text).not.toContain(PROVENANCE().snapshot_id as string);
    expect(text).not.toContain(PROVENANCE().line_refs[0]);
  });

  it("the OBSERVED value carries the finding's provenance, measured by the rule", async () => {
    render(<FindingCard finding={finding()} />);
    const [, observed] = affordancesWithin("fnd-threshold");
    await openByFocus(observed);
    const text = openCardText();
    expect(text).toContain(PROVENANCE().source);
    expect(text).toContain(PROVENANCE().line_refs.join(", "));
    expect(text).toContain(PROVENANCE().snapshot_id as string);
    expect(text).toContain(`measured by rule ${THRESHOLD().rule_id} · ${THRESHOLD().parameter}`);
  });
});

describe("the impact's two endpoints say they are a projection", () => {
  it("baseline and adjusted both wear it", () => {
    render(<FindingCard finding={finding()} />);
    expect(affordancesWithin("fnd-impact").length).toBe(2);
  });

  it("the adjusted figure names itself a projection, never a reading", async () => {
    render(<FindingCard finding={finding()} />);
    const [, adjusted] = affordancesWithin("fnd-impact");
    await openByFocus(adjusted);
    const text = openCardText();
    expect(text).toContain("projection");
    expect(text).toContain("recomputed without this item");
    expect(text).toContain(finding().elements.impact!.metric);
    expect(text).toContain(PROVENANCE().snapshot_id as string);
  });
});

describe("all checks", () => {
  it("a check row's LIMIT names the parameter file its finding carries, by lookup", async () => {
    render(<AllChecksList report={report()} defaultOpen />);
    const row = screen.getAllByTestId("fnd-check-concentration_related_party")[0];
    const found = Array.from(row.querySelectorAll<HTMLElement>('[data-provenance="true"]'));
    expect(found.length, "the check row rendered no affordance").toBe(2);
    await openByFocus(found[0]);
    const text = openCardText();
    expect(text).toContain("profiles.yaml");
    expect(text).toContain("rule concentration_related_party");
    expect(text).toContain("profile inventory_operator");
  });

  it("a row whose rule surfaced nowhere names only the rule and profile", async () => {
    const r = report();
    // A quiet row WITH a limit. Until 2026-09-04 this picked the first
    // quiet row, `affiliate_income_dependency` — `limit: null, observed:
    // null` — and asserted that its DASH wore a card naming the rule.
    // That was the fabrication (critic finding #2, ea6df1f) pinned as a
    // pass; the refusal it should have been is the test below.
    const quiet = r.checks.find((c) => !c.fired && c.rule_id && typeof c.limit === "number");
    if (!quiet) throw new Error("fixture has no quiet check row with a limit");
    render(<AllChecksList report={r} defaultOpen />);
    const row = screen.getAllByTestId(`fnd-check-${quiet.rule_id}`)[0];
    const found = Array.from(row.querySelectorAll<HTMLElement>('[data-provenance="true"]'));
    expect(found.length).toBeGreaterThan(0);
    await openByFocus(found[0]);
    const text = openCardText();
    expect(text).toContain(`rule ${quiet.rule_id}`);
    expect(text).not.toContain("profiles.yaml");
  });

  it("a row whose limit and observed value are ABSENT paints two dashes and NO card", () => {
    const r = report();
    const absent = r.checks.find((c) => !c.fired && c.limit === null && c.observed === null);
    if (!absent) throw new Error("fixture has no check row with an absent limit and observed");
    render(<AllChecksList report={r} defaultOpen />);
    const row = screen.getAllByTestId(`fnd-check-${absent.rule_id}`)[0];
    // Both FIGURE cells (the right-aligned limit and observed columns;
    // the parameter column paints its own dash for an empty name and is
    // not a figure) paint the dash …
    const dashes = Array.from(row.querySelectorAll("td.text-right")).filter(
      (td) => td.textContent?.trim() === "—",
    );
    expect(dashes.length, "the absent row did not paint two figure dashes").toBe(2);
    // … and neither wears a card: a rule name over a number that does
    // not exist is an origin for nothing.
    expect(row.querySelectorAll('[data-provenance="true"]').length).toBe(0);
  });
});

describe("the refusal — a finding with no provenance keeps its impact plain", () => {
  it("strips the impact affordances when the payload carries no provenance", () => {
    const f = finding();
    const bare = {
      ...f,
      elements: {
        ...f.elements,
        evidence: { ...f.elements.evidence!, provenance: null },
      },
    };
    render(<FindingCard finding={bare} />);
    expect(affordancesWithin("fnd-impact").length).toBe(0);
    // The LIMIT still knows its file; the OBSERVED still knows its rule.
    expect(affordancesWithin("fnd-threshold").length).toBe(2);
  });
});
