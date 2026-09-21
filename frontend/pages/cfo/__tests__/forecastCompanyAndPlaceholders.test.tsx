// @vitest-environment jsdom
/**
 * THE FORECAST PAGE on the company on screen, and gate F5 on its statements
 * (forecast-scenarios-live; the cockpit, 2026-09-21).
 *
 * Rendered over the synthetic double of the engine's cockpit route
 * (components/forecast/cockpit/__tests__/syntheticCockpit.ts — invented names
 * and figures). cfoApi is the only projection seam; the company and period on
 * screen are stubbed.
 *
 * RED ON (TC-11):
 *   · F5: a statement cell whose served figure is non-zero painting a dash, a
 *     blank or a zero; a plan year whose "interest on debt" paints no interest
 *     while the book carries debt; a DRAWN credit line whose interest paints
 *     nothing;
 *   · the page header not naming the company on screen; more than ONE primary
 *     action on the screen; an upload control on the page;
 *   · with no company open (or a company with no analysed year) anything but
 *     one sentence and the company cards — a blank page, a projection over
 *     nothing, or a request to the engine;
 *   · the engine's English sentences (conventions, what the model does not
 *     cover) printed in English on a Romanian page when a rule says them, or
 *     a Romanian copy overruling the served English on an English page.
 * CANNOT SEE: whether the engine's projection is right (the engine's gates).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import Forecast from "../Forecast";
import { servedSentence } from "@/lib/forecastSentences";
import { __clearFeaturesForTest, __setFeaturesForTest } from "@/lib/features";
import { syntheticCockpit } from "@/components/forecast/cockpit/__tests__/syntheticCockpit";

const ORG = {
  id: "org-exemplu", name: "Exemplu Alimentar SRL", industry_key: null,
  industry_display_name: null, default_currency: "RON", role: "owner" as const,
  archived_at: null, purge_after: null, created_at: "2026-01-01T00:00:00Z",
};
const STATE = vi.hoisted(() => ({
  period: { id: "p-1", label: "Dec 2025" } as { id: string | null; label: string | null },
  orgOnScreen: true,
  holdsAny: true,
}));
vi.mock("@/lib/activePeriod", () => ({ useActivePeriod: () => STATE.period }));
vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: STATE.period.id, status: "ready" }),
}));
vi.mock("@/lib/org", () => ({
  useActiveOrg: () => ({
    org: STATE.orgOnScreen ? ORG : null, orgs: STATE.holdsAny ? [ORG] : [], archived: [],
    loading: false, loadError: false, needsOnboarding: false,
    refresh: async () => undefined, switchOrg: async () => undefined,
    createWorkspace: async () => null, renameWorkspace: async () => false,
    setWorkspaceIndustry: async () => false, archiveWorkspace: async () => false,
    restoreWorkspace: async () => false, purgeWorkspace: async () => false,
  }),
  daysUntilPurge: () => 30,
}));
vi.mock("@/lib/forecastCases", async () => {
  const actual = await vi.importActual<typeof import("@/lib/forecastCases")>("@/lib/forecastCases");
  return { ...actual, loadForecastCases: async () => [] };
});
const cockpit = vi.fn();
vi.mock("@/lib/cfoApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cfoApi")>("@/lib/cfoApi");
  return { ...actual, cfoApi: { forecastCockpit: (...a: unknown[]) => cockpit(...a) } };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Forecast />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  STATE.period = { id: "p-1", label: "Dec 2025" };
  STATE.orgOnScreen = true;
  STATE.holdsAny = true;
  cockpit.mockReset();
  cockpit.mockImplementation(async (_id: string, body: { case_id: string }) =>
    syntheticCockpit({ caseId: body.case_id, funding: body.case_id === "pesimist" }),
  );
  __clearFeaturesForTest();
  __setFeaturesForTest({
    forecast: { status: "active", label: "Forecast", description: "" },
    scenarios: { status: "active", label: "Scenarios", description: "" },
  });
});
afterEach(() => cleanup());

describe("gate F5 on the Forecast statements", () => {
  it("every non-zero served figure is painted as itself — no dash, no blank, no zero", async () => {
    wrap();
    await screen.findByTestId("forecast-block-pl");
    const served = syntheticCockpit() as Json;
    const byKey = new Map<string, number>();
    for (const section of ["pl", "bs", "cf"]) {
      for (const row of served.statements[section] as Json[]) {
        for (const v of row.values as Json[]) byKey.set(`${row.line}|${v.period}`, v.amount_minor);
        if (row.year0) byKey.set(`${row.line}|${row.year0.period}`, row.year0.amount_minor);
      }
    }
    let checked = 0;
    for (const cell of Array.from(document.querySelectorAll("td[data-line][data-period]"))) {
      const minor = byKey.get(`${cell.getAttribute("data-line")}|${cell.getAttribute("data-period")}`);
      if (typeof minor !== "number" || minor === 0) continue;
      const painted = cell.querySelector("[data-projected-value]")?.textContent ?? "";
      expect(painted, `${cell.getAttribute("data-line")} ${cell.getAttribute("data-period")} not painted`).not.toBe("");
      expect(painted, `${cell.getAttribute("data-line")} ${cell.getAttribute("data-period")} painted as zero or a dash`).toMatch(/[1-9]/);
      checked += 1;
    }
    expect(checked, "vacuous: no non-zero served figure was checked").toBeGreaterThan(40);
  });

  it("interest on debt is never zero while the book carries debt; a drawn line shows its interest", async () => {
    wrap();
    await screen.findByTestId("forecast-block-pl");
    const debt = Array.from(document.querySelectorAll('td[data-line="pl.interest_expense_debt"]')).filter(
      (c) => c.getAttribute("data-period") !== "FY2025",
    );
    expect(debt.length, "vacuous: no plan year painted interest on debt").toBe(5);
    for (const cell of debt) expect(cell.querySelector("[data-projected-value]")?.textContent ?? "").toMatch(/[1-9]/);
    cleanup();

    // the pesimist double draws the credit line: its interest is painted
    wrap();
    await screen.findByTestId("cockpit-numbers");
    fireEvent.click(screen.getByTestId("cockpit-case-pesimist"));
    await screen.findByTestId("cockpit-funding-need");
    expect(screen.getByTestId("cockpit-funding-interest").querySelector("[data-projected-value]")?.textContent ?? "").toMatch(/[1-9]/);
    const line = Array.from(document.querySelectorAll('td[data-line="pl.interest_expense_funding_line"]')).filter(
      (c) => c.getAttribute("data-period") !== "FY2025",
    );
    for (const cell of line) expect(cell.querySelector("[data-projected-value]")?.textContent ?? "").toMatch(/[1-9]/);
  });
});

describe("the company on screen", () => {
  it("names the company, carries ONE primary action and no upload control", async () => {
    wrap();
    await screen.findByTestId("cockpit-numbers");
    expect(screen.getByTestId("forecast-company").textContent).toBe(ORG.name);
    expect(document.querySelectorAll('[data-primary-action="true"]')).toHaveLength(1);
    expect(screen.getByTestId("cockpit-present-open").getAttribute("data-primary-action")).toBe("true");
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("a company with no analysed year: one sentence and the cards, no projection asked", async () => {
    STATE.period = { id: null, label: null };
    wrap();
    const cards = await screen.findByTestId("company-cards");
    expect(cards.getAttribute("data-reason")).toBe("no_year");
    expect(screen.getByTestId("company-cards-sentence").textContent).toContain(ORG.name);
    expect(cockpit).not.toHaveBeenCalled();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("no company at all: one sentence, never a blank page", async () => {
    STATE.period = { id: null, label: null };
    STATE.orgOnScreen = false;
    STATE.holdsAny = false;
    wrap();
    const cards = await screen.findByTestId("company-cards");
    expect(cards.getAttribute("data-reason")).toBe("no_company");
    expect((screen.getByTestId("company-cards-sentence").textContent ?? "").length).toBeGreaterThan(10);
    expect(cockpit).not.toHaveBeenCalled();
  });
});

describe("the engine's served sentences read in the page's language", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("ro: a served English sentence a rule says comes out in Romanian; en prints the served words", async () => {
    const row = (syntheticCockpit() as Json).not_modelled[0] as { id: string; sentence: string };
    const served = row.sentence;
    // a FIXED sentence (the same words on every book) is said by its served id
    const romanian = servedSentence(i18n.getFixedT("ro"), "ro", row.id, served);
    expect(romanian, "no Romanian rule for the served sentence").not.toBe(served);

    await i18n.changeLanguage("en");
    const en = wrap();
    await screen.findByTestId("cockpit-not-modelled");
    expect(screen.getByTestId("cockpit-not-modelled").textContent).toContain(served);
    en.unmount();

    await i18n.changeLanguage("ro");
    wrap();
    await waitFor(() => expect(screen.getByTestId("cockpit-not-modelled").textContent).toContain(romanian));
    expect(screen.getByTestId("cockpit-not-modelled").textContent).not.toContain(served);
  });

  it("en: an engine that rewords a sentence is printed as served, never overruled by a copy", async () => {
    cockpit.mockImplementation(async () => {
      const p = syntheticCockpit() as Json;
      p.not_modelled = [{ id: "headcount", sentence: "headcount is not modelled for this book yet" }];
      return p;
    });
    await i18n.changeLanguage("en");
    wrap();
    const list = await screen.findByTestId("cockpit-not-modelled");
    expect(list.textContent).toContain("headcount is not modelled for this book yet");
  });
});
