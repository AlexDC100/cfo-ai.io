// @vitest-environment jsdom
/**
 * THE FORECAST PAGE on the company on screen, and gate F5 on its statements
 * (forecast-scenarios-live).
 *
 * Rendered over the REAL served bytes of the agras corpus book through the real
 * route (`fp1_2_agras_served.json`, five plan years). cfoApi is the only
 * projection seam; the company and period on screen are stubbed.
 *
 * RED ON (TC-11):
 *   · F5: a statement cell whose served figure is non-zero painting a dash, a
 *     blank or a zero; a period in which the book carries debt whose "Interest
 *     on debt" cell paints no interest;
 *   · the page header not naming the company on screen; more than ONE primary
 *     action on the screen; an upload control on the page;
 *   · with no company open (or a company with no analysed year) anything but
 *     one sentence and the company cards — a blank page, a projection over
 *     nothing, or a request to the engine.
 * CANNOT SEE: whether the engine's projection is right (forecast-f-gates).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import Forecast from "../Forecast";
import { __clearFeaturesForTest, __setFeaturesForTest } from "@/lib/features";

const ORG = {
  id: "org-agras", name: "Agra's Food Factory SRL", industry_key: null,
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
const forecast = vi.fn();
vi.mock("@/lib/cfoApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cfoApi")>("@/lib/cfoApi");
  return {
    ...actual,
    cfoApi: {
      forecast: (...a: unknown[]) => forecast(...a),
      forecastRecompute: (...a: unknown[]) => forecast(...a),
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const SERVED = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../../tests/engine/fixtures/forecast/fp1_2_agras_served.json"),
    "utf-8",
  ),
) as Json;

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
  forecast.mockReset();
  forecast.mockResolvedValue(SERVED);
  __clearFeaturesForTest();
  __setFeaturesForTest({
    forecast: { status: "active", label: "Forecast", description: "" },
    scenarios: { status: "active", label: "Scenarios", description: "" },
  });
});
afterEach(() => cleanup());

describe("gate F5 on the Forecast statements", () => {
  it("every non-zero served figure is painted as itself, in both grains", async () => {
    wrap();
    await screen.findByTestId("forecast-block-pl");
    const byKey = new Map<string, Json>(
      (SERVED.figures as Json[]).map((f) => [`${f.line}|${f.period}`, f]),
    );
    let checked = 0;
    const scan = () => {
      for (const cell of Array.from(document.querySelectorAll("td[data-line][data-period]"))) {
        const f = byKey.get(`${cell.getAttribute("data-line")}|${cell.getAttribute("data-period")}`);
        if (!f || typeof f.amount_minor !== "number" || f.amount_minor === 0) continue;
        const painted = cell.querySelector("[data-projected-value]")?.textContent ?? "";
        expect(painted, `${f.line} ${f.period} not painted`).not.toBe("");
        expect(painted, `${f.line} ${f.period} painted as zero or a dash`).toMatch(/[1-9]/);
        checked += 1;
      }
    };
    scan();
    fireEvent.click(screen.getByTestId("forecast-grain-toggle"));
    scan();
    expect(checked, "vacuous: no non-zero served figure was checked").toBeGreaterThan(100);
  });

  it("interest on debt is never zero while the book carries debt", async () => {
    wrap();
    await screen.findByTestId("forecast-block-pl");
    fireEvent.click(screen.getByTestId("forecast-grain-toggle"));
    const byKey = new Map<string, number>(
      (SERVED.figures as Json[]).map((f) => [`${f.line}|${f.period}`, f.amount_minor as number]),
    );
    let withDebt = 0;
    for (const period of SERVED.horizon.labels as string[]) {
      const debt = (byKey.get(`bs.st_debt|${period}`) ?? 0) + (byKey.get(`bs.lt_debt|${period}`) ?? 0);
      if (debt <= 0) continue;
      const cell = document.querySelector(
        `td[data-line="pl.interest_expense_debt"][data-period="${period}"]`,
      );
      if (!cell) continue;
      withDebt += 1;
      expect(cell.querySelector("[data-projected-value]")?.textContent ?? "", period).toMatch(/[1-9]/);
    }
    expect(withDebt, "vacuous: the book carried no debt in any painted period").toBeGreaterThan(0);
  });
});

describe("the company on screen", () => {
  it("names the company, carries ONE primary action and no upload control", async () => {
    wrap();
    await screen.findByTestId("forecast-block-pl");
    expect(screen.getByTestId("forecast-company").textContent).toBe(ORG.name);
    expect(document.querySelectorAll('[data-primary-action="true"]')).toHaveLength(1);
    expect(screen.getByTestId("forecast-open-scenarios")).toBeTruthy();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("a company with no analysed year: one sentence and the cards, no projection asked", async () => {
    STATE.period = { id: null, label: null };
    wrap();
    const cards = await screen.findByTestId("company-cards");
    expect(cards.getAttribute("data-reason")).toBe("no_year");
    expect(screen.getByTestId("company-cards-sentence").textContent).toContain(ORG.name);
    expect(forecast).not.toHaveBeenCalled();
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
    expect(forecast).not.toHaveBeenCalled();
  });
});

describe("the engine's FIXED sentences read in the page's language", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("ro: the covenant refusal, the runway and the strip formula are Romanian; en prints the served words", async () => {
    // The served English, straight from the bytes.
    const breachServed = (SERVED.strip.first_breach_period.refused as Json).text as string;
    const runwayServed = (SERVED.summary.runway.sentence as Json).text as string;
    const formulaServed = (SERVED.strip.cumulative_fcf as Json).formula as string;

    await i18n.changeLanguage("en");
    const en = wrap();
    await screen.findByTestId("forecast-strip");
    expect(screen.getByTestId("forecast-strip-breach-refusal").textContent).toBe(breachServed);
    expect(screen.getByTestId("forecast-strip-first-breach").textContent).toContain(runwayServed);
    expect(screen.getByTestId("forecast-strip-cumulative-fcf").textContent).toContain(formulaServed);
    en.unmount();

    await i18n.changeLanguage("ro");
    wrap();
    await screen.findByTestId("forecast-strip");
    const breach = screen.getByTestId("forecast-strip-breach-refusal").textContent ?? "";
    expect(breach).toBe(i18n.t("forecast.served.not_served_in_this_build"));
    expect(breach).not.toBe(breachServed);
    const firstBreach = screen.getByTestId("forecast-strip-first-breach").textContent ?? "";
    expect(firstBreach).toContain(i18n.t("forecast.served.runway_none"));
    expect(firstBreach).not.toContain(runwayServed);
    const fcf = screen.getByTestId("forecast-strip-cumulative-fcf").textContent ?? "";
    expect(fcf).toContain(i18n.t("forecast.formula.cumulativeFcf"));
    expect(fcf).not.toContain(formulaServed);
    // the lever rail's "not served by this engine" list, row by row
    const unserved = SERVED.client.unserved as Json[];
    expect(unserved.length).toBeGreaterThan(0);
    for (const row of unserved) {
      const li = await screen.findByTestId(`forecast-lever-unserved-${row.key}`);
      expect(li.textContent).toBe(i18n.t(`forecast.served.${row.key}`));
      expect(li.textContent).not.toBe(row.sentence.text);
    }
  });

  it("en: an engine that rewords a fixed sentence is printed as served, never overruled by a copy", async () => {
    const reworded = JSON.parse(JSON.stringify(SERVED)) as Json;
    reworded.strip.first_breach_period.refused.text = "covenants are not modelled for this book yet";
    forecast.mockResolvedValue(reworded);
    await i18n.changeLanguage("en");
    wrap();
    await screen.findByTestId("forecast-strip");
    expect(screen.getByTestId("forecast-strip-breach-refusal").textContent).toBe(
      "covenants are not modelled for this book yet",
    );
  });
});
