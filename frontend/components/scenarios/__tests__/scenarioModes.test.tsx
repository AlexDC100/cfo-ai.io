// @vitest-environment jsdom
// THE DIAL (Part E) — Scenarios in Simple mode.
//
//   · Gate M1 (the load-bearing one): the results table renders CENT-
//     IDENTICAL row strings in Simple and Pro — same accessors, same
//     Amount group scale; only ROW VISIBILITY differs.
//   · Simple collapses to the headline group with a "Show all" expand;
//     Pro renders every row with no toggle (nothing pro is removed).
//   · Template cards in Simple lead with the QUESTION and keep the Pro
//     label as the subtitle; Pro cards are unchanged.

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/i18n";
import { CurrencyProvider } from "@/stores/currency";
import { ScenarioProvider } from "@/stores/scenario";
import { applyCascade } from "@/lib/scenarios/cascade";
import { SCENARIO_LEVERS, leverToAdjustment } from "@/lib/scenarios/levers";
import { SCENARIO_METRIC_ROWS } from "@/lib/scenarios/baseline";
import { SCENARIO_TEMPLATES } from "@/lib/scenarios/templates";
import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";
import { ScenarioComparison } from "../ScenarioComparison";
import { ScenarioTemplateCards } from "../ScenarioTemplateCards";

// Hermetic in-memory localStorage (same workaround as viewModes.test.ts).
const bag = new Map<string, string>();
const stub = {
  getItem: (k: string) => bag.get(k) ?? null,
  setItem: (k: string, v: string) => void bag.set(k, String(v)),
  removeItem: (k: string) => void bag.delete(k),
  clear: () => void bag.clear(),
  key: (i: number) => [...bag.keys()][i] ?? null,
  get length() {
    return bag.size;
  },
};
Object.defineProperty(globalThis, "localStorage", { value: stub, configurable: true });

const MODE_KEY = "cfo-view-mode-v1";
const setMode = (m: "simple" | "pro") => bag.set(MODE_KEY, m);

// Calibrated EEI-like baseline (mirrors lib/scenarios/__tests__ fixture).
const REV = 4_900_000, COGS = 500_000, DEP = 800_000, AMORT = 0;
const EBITDA_STAT = 2_100_000, NFR = -600_000, NI_STAT = 400_000;
const baseline: ReportingMetrics = {
  revenue: REV, cogs: COGS, opex: REV - COGS + DEP + AMORT - EBITDA_STAT,
  depreciation: DEP, amortization: AMORT,
  netFinancialResult: NFR, incomeTax: EBITDA_STAT - DEP - AMORT + NFR - NI_STAT,
  ebitda: EBITDA_STAT, ebit: EBITDA_STAT - DEP - AMORT, netProfit: NI_STAT,
  totalDebt: 14_100_000, cash: 1_500_000,
  receivables: 600_000, inventory: 200_000, accountsPayable: 400_000,
  currentAssets: 2_500_000, currentLiabilities: 900_000,
  shareholdersEquity: 10_000_000, totalAssets: 25_000_000, capex: 300_000,
};
const revLever = SCENARIO_LEVERS.find((l) => l.key === "revenue")!;
const scenario = applyCascade(baseline, [leverToAdjustment(revLever, -20, "t", "")]);

const HEADLINE_KEYS = SCENARIO_METRIC_ROWS
  .slice(0, SCENARIO_METRIC_ROWS.findIndex((r) => r.groupStart === "ratios"))
  .map((r) => r.conceptKey);
const ALL_KEYS = SCENARIO_METRIC_ROWS.map((r) => r.conceptKey);

function renderTable() {
  return render(
    <CurrencyProvider>
      <ScenarioComparison baseline={baseline} scenario={scenario} currency="RON" active />
    </CurrencyProvider>,
  );
}

/** conceptKey → full row text (label + baseline + scenario + delta). */
function rowTexts(container: HTMLElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of ALL_KEYS) {
    const el = container.querySelector(`[data-testid="scenario-row-${key}"]`);
    if (el) out.set(key, el.textContent ?? "");
  }
  return out;
}

beforeEach(() => {
  bag.clear();
});

describe("results table — Pro renders every row, no toggle", () => {
  it("shows all rows and never the Simple disclosure control", () => {
    setMode("pro");
    const { container, unmount } = renderTable();
    expect([...rowTexts(container).keys()]).toEqual(ALL_KEYS);
    expect(screen.queryByTestId("scenario-rows-toggle")).toBeNull();
    unmount();
  });
});

describe("results table — Simple collapses to headline rows + Show all", () => {
  it("collapsed: exactly the headline group, toggle collapsed", () => {
    setMode("simple");
    const { container, unmount } = renderTable();
    expect([...rowTexts(container).keys()]).toEqual(HEADLINE_KEYS);
    const toggle = screen.getByTestId("scenario-rows-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    unmount();
  });

  it("Show all reveals the ratios group; Show fewer collapses again", () => {
    setMode("simple");
    const { container, unmount } = renderTable();
    fireEvent.click(screen.getByTestId("scenario-rows-toggle"));
    expect([...rowTexts(container).keys()]).toEqual(ALL_KEYS);
    expect(screen.getByTestId("scenario-rows-toggle")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByTestId("scenario-rows-toggle"));
    expect([...rowTexts(container).keys()]).toEqual(HEADLINE_KEYS);
    unmount();
  });
});

describe("gate M1 — cent-identical strings across modes", () => {
  it("every shared row renders the identical text in Pro, Simple-collapsed and Simple-expanded", () => {
    setMode("pro");
    const pro = renderTable();
    const proTexts = rowTexts(pro.container);
    pro.unmount();

    setMode("simple");
    const simple = renderTable();
    const collapsedTexts = rowTexts(simple.container);
    for (const [key, text] of collapsedTexts) {
      expect(text, `collapsed row ${key}`).toBe(proTexts.get(key));
    }
    fireEvent.click(screen.getByTestId("scenario-rows-toggle"));
    const expandedTexts = rowTexts(simple.container);
    expect([...expandedTexts.keys()]).toEqual([...proTexts.keys()]);
    for (const [key, text] of expandedTexts) {
      expect(text, `expanded row ${key}`).toBe(proTexts.get(key));
    }
    simple.unmount();
  });
});

describe("template cards — Simple leads with the question, Pro unchanged", () => {
  const renderCards = () =>
    render(
      <ScenarioProvider>
        <ScenarioTemplateCards />
      </ScenarioProvider>,
    );

  it("Pro: card titles are the template names, descriptions shown", () => {
    setMode("pro");
    const { unmount } = renderCards();
    for (const tpl of SCENARIO_TEMPLATES) {
      const card = screen.getByTestId(`scenario-template-${tpl.key}`);
      expect(card.textContent).toContain(tpl.name);
      expect(card.textContent).toContain(tpl.description.slice(0, 30));
    }
    unmount();
  });

  it("Simple: question leads, Pro label survives as the subtitle", () => {
    setMode("simple");
    const { unmount } = renderCards();
    for (const tpl of SCENARIO_TEMPLATES) {
      const card = screen.getByTestId(`scenario-template-${tpl.key}`);
      const question = i18n.t(`scenModes.templates.${tpl.key}`);
      expect(question.trim(), `question for ${tpl.key}`).toBeTruthy();
      expect(card.textContent).toContain(question);
      expect(card.textContent).toContain(tpl.name);
    }
    // The recession card asks the mandated phrasing derived from its params.
    expect(
      screen.getByTestId("scenario-template-recession").textContent,
    ).toContain("What if sales drop 20%?");
    unmount();
  });

  it("RO questions exist for every template (tu-form strings registered)", () => {
    const tRo = i18n.getFixedT("ro");
    for (const tpl of SCENARIO_TEMPLATES) {
      const q = tRo(`scenModes.templates.${tpl.key}`);
      expect(q, `ro question for ${tpl.key}`).not.toContain("scenModes.");
      expect(q.trim()).toBeTruthy();
    }
  });
});
