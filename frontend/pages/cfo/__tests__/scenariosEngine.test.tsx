// @vitest-environment jsdom
/**
 * THE SCENARIOS PAGE ON THE ONE ENGINE (plan/2 B13, minimal cut).
 *
 * Rendered over the REAL served bytes (`fp1_2_agras_served.json`, the agras
 * corpus book through the real route), with `cfoApi.forecastRecompute` the only
 * seam: what the page SENDS is asserted, and what it PAINTS is the engine's.
 *
 * WHAT IT REDS ON (TC-11, after the repair)
 *   · the page, or anything it imports, reaching a client scenario-math module
 *     (`lib/scenarios/*`, the old `stores/scenario`) — the page computes
 *     nothing (S4, defect 0.5);
 *   · a template POSTing anything but its declared shock set: a changed value,
 *     a dropped pool, an extra shock, a shock outside the first-month / no-ramp
 *     / no-end window, or a body that states `total_years` (2.2);
 *   · a template the data file declares that this suite does not pin;
 *   · a 409/422 from the engine painting anything but the engine's sentence —
 *     a blank page, a generic line, or a projected number;
 *   · an industry word (en or ro) anywhere in the rendered page (S2, 8.6);
 *   · a served negative cash balance painted as the page's cash, or drawn on
 *     its cash chart, instead of the funding line the engine served (S3).
 *
 * WHAT IT CANNOT SEE
 *   · whether the engine's projection is right — the engine's own gates own
 *     that (scenario-cost-behaviour, scenario-funding-line, and
 *     tests/engine/test_scenario_page_templates.py, which runs this page's
 *     template file through project_plan on the four corpus books);
 *   · pixels, and a dynamic import built from a string.
 */

import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import Scenarios from "../Scenarios";
import { CfoApiError } from "@/lib/cfoApi";
import { SCENARIO_TEMPLATES } from "@/lib/scenarioTemplates";

const PERIOD = { id: "p-1", label: "Dec 2025" };

vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => PERIOD,
}));
vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: PERIOD.id, status: "resolved" }),
}));

const forecastRecompute = vi.fn();
const forecast = vi.fn();
vi.mock("@/lib/cfoApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cfoApi")>("@/lib/cfoApi");
  return {
    ...actual,
    cfoApi: {
      forecast: (...args: unknown[]) => forecast(...args),
      forecastRecompute: (...args: unknown[]) => forecastRecompute(...args),
    },
  };
});

const REPO = resolve(__dirname, "../../../..");
const SERVED_TEXT = readFileSync(
  resolve(REPO, "tests/engine/fixtures/forecast/fp1_2_agras_served.json"),
  "utf8",
);
/** The served payload, as JSON: the test reads and plants fields by path. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const served = () => JSON.parse(SERVED_TEXT) as Json;
const SERVED = served();

/** The operating-cost pools the served book declares, in served order — the
 *  set `pool_level.*` must expand over. Read from the payload, never typed. */
const SERVED_POOLS: string[] = (SERVED.driver_order as string[]).filter((k) =>
  k.startsWith("pool_level."),
);

type Body = {
  horizon: Record<string, unknown>;
  overrides: Record<string, unknown>;
  shocks: Array<Record<string, unknown>>;
};
const bodies = (): Body[] => forecastRecompute.mock.calls.map((c) => c[1] as Body);
const lastBody = (): Body => bodies()[bodies().length - 1];

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Scenarios />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  forecastRecompute.mockReset();
  forecast.mockReset();
  forecastRecompute.mockImplementation(async () => served());
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

// ── 1. the boundary ────────────────────────────────────────────────────

/** Every module a file reaches through static imports, re-exports and
 *  literal dynamic imports, resolved inside frontend/. The same walk as
 *  scripts/check_forecast_boundary.mjs `importClosure`; a test that imported
 *  the gate script would run the gate. */
function importClosure(startRel: string): string[] {
  const exts = ["", ".ts", ".tsx", ".json", "/index.ts", "/index.tsx"];
  const resolveSpec = (fromAbs: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = join(REPO, "frontend", spec.slice(2));
    else if (spec.startsWith(".")) base = join(fromAbs, "..", spec);
    else return null;
    for (const ext of exts) {
      try {
        if (statSync(base + ext).isFile()) return base + ext;
      } catch {
        /* not this extension */
      }
    }
    return null;
  };
  const rx =
    /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  const seen = new Set<string>();
  const stack = [join(REPO, startRel)];
  while (stack.length) {
    const abs = stack.pop() as string;
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (abs.endsWith(".json")) continue;
    const src = readFileSync(abs, "utf8");
    for (const m of src.matchAll(rx)) {
      const target = resolveSpec(abs, m[1] ?? m[2]);
      if (target && !seen.has(target)) stack.push(target);
    }
  }
  return [...seen].map((a) => relative(REPO, a).split("\\").join("/")).sort();
}

describe("the page computes nothing (one engine)", () => {
  const closure = importClosure("frontend/pages/cfo/Scenarios.tsx");

  it("reaches no client scenario-math module, through any import", () => {
    // Not vacuous: the walk has to have found the page's own surface and the
    // one reader of a served projection.
    expect(closure).toContain("frontend/pages/cfo/Scenarios.tsx");
    expect(closure).toContain("frontend/components/scenarios/ScenarioOutcome.tsx");
    expect(closure).toContain("frontend/lib/forecastFacts.ts");
    const math = closure.filter(
      (p) => p.startsWith("frontend/lib/scenarios/") || p === "frontend/stores/scenario.tsx",
    );
    expect(
      math,
      `the Scenarios page reaches client scenario math: ${math.join(", ")}`,
    ).toEqual([]);
  });

  it("asks the engine: the page POSTs /recompute and names no cascade", () => {
    const page = readFileSync(join(REPO, "frontend/pages/cfo/Scenarios.tsx"), "utf8");
    // Line comments FIRST: a `//` line that mentions a path ending in `/*`
    // would otherwise open a "block comment" that swallows the imports.
    const code = page
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).toMatch(/\bforecastRecompute\s*\(/);
    expect(code).not.toMatch(/\b(applyCascade|buildScenarioBaseline|buildDashboardCanonical|computeMetric)\b/);
  });
});

// ── 2. templates POST exactly their declared shock sets ────────────────

const shock = (
  template: string,
  n: number,
  driverKey: string,
  op: string,
  value: string,
  groupId: string | null = null,
) => ({
  id: `template:${template}:${n}`,
  driver_key: driverKey,
  op,
  value,
  start_month: 1,
  ramp_months: 0,
  end_month: null,
  source: `template:${template}`,
  group_id: groupId,
});

/** THE PINNED SETS. Written out literally, not recompiled from the data file:
 *  a gate that derived its expectation from the module under test would agree
 *  with any change to it. */
const EXPECTED: Record<string, Array<Record<string, unknown>>> = {
  base: [],
  recession: [
    shock("recession", 1, "volume_index", "level_pct", "-0.20"),
    ...SERVED_POOLS.map((pool, i) =>
      shock("recession", i + 2, pool, "level_pct", "-0.05", "template:recession:pool_level"),
    ),
  ],
  input_cost_inflation: [
    shock("input_cost_inflation", 1, "input_price_index", "level_pct", "0.10"),
  ],
  price_pressure: [shock("price_pressure", 1, "price_index", "level_pct", "-0.05")],
  working_capital_squeeze: [
    shock("working_capital_squeeze", 1, "dso_days", "add_days", "15"),
    shock("working_capital_squeeze", 2, "dio_cogs_days", "add_days", "10"),
  ],
};

describe("templates are lever sets the engine runs", () => {
  it("pins every template the data file declares", () => {
    expect(SERVED_POOLS.length).toBeGreaterThan(0);
    expect(SCENARIO_TEMPLATES.map((t) => t.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("the base plan POSTs no shock, and never states total_years", async () => {
    renderPage();
    await screen.findByTestId("scenarios-outcome-table");
    expect(forecastRecompute).toHaveBeenCalledTimes(1);
    expect(forecastRecompute.mock.calls[0][0]).toBe(PERIOD.id);
    expect(lastBody()).toEqual({
      horizon: { monthly_months: 12 },
      overrides: {},
      shocks: [],
    });
    // GET serves 3 or 5 years only; the Scenarios horizon is the pack's.
    expect(forecast).not.toHaveBeenCalled();
  });

  for (const id of Object.keys(EXPECTED).filter((k) => k !== "base")) {
    it(`${id} POSTs exactly its declared shock set`, async () => {
      renderPage();
      await screen.findByTestId("scenarios-outcome-table");
      fireEvent.click(screen.getByTestId(`scenarios-template-${id}`));
      await waitFor(() => expect(forecastRecompute).toHaveBeenCalledTimes(2));
      const body = lastBody();
      expect(body.horizon).toEqual({ monthly_months: 12 });
      expect(body.overrides).toEqual({});
      expect(body.shocks).toEqual(EXPECTED[id]);
      // The column is the template's, and it paints served figures.
      const cell = await screen.findByTestId(
        `scenarios-cell-template-revenue-${SERVED.horizon.labels_annual[0]}`,
      );
      expect(cell.querySelector('[data-projected="true"]')).not.toBeNull();
    });
  }

  it("every card shows what its template changes, as declared", async () => {
    renderPage();
    await screen.findByTestId("scenarios-outcome-table");
    const recession = screen.getByTestId("scenarios-template-recession-changes");
    expect(recession.textContent).toContain("Sales volume");
    expect(recession.textContent).toContain("\u221220%");
    // The pool group is ONE line naming how many served pools it covers.
    expect(recession.textContent).toContain(
      `all ${SERVED_POOLS.length} cost pools this book serves`,
    );
    expect(recession.textContent).toContain("\u22125%");
    const squeeze = screen.getByTestId("scenarios-template-working_capital_squeeze-changes");
    expect(squeeze.textContent).toContain("+15 days");
    expect(squeeze.textContent).toContain("+10 days");
    expect(screen.getByTestId("scenarios-template-input_cost_inflation-changes").textContent)
      .toContain("+10%");
    expect(screen.getByTestId("scenarios-template-base-changes").textContent)
      .toMatch(/Nothing/);
  });
});

// ── 3. a refusal renders the engine's sentence ─────────────────────────

describe("a refusal is the engine's sentence, never a blank page or a number", () => {
  it("422 on the base plan: the page's refusal state is the engine's text", async () => {
    const sentence =
      "the assembled profit and loss carries no revenue line, so there is no revenue to project; an absent revenue is never read as nil";
    forecastRecompute.mockImplementation(async () => {
      throw new CfoApiError(JSON.stringify({ code: "revenue_absent" }), 422, {
        code: "revenue_absent",
        text: sentence,
        field: null,
      });
    });
    renderPage();
    const detail = await screen.findByTestId("scenarios-refusal-detail");
    expect(detail.textContent).toBe(sentence);
    expect(document.querySelector('[data-projected="true"]')).toBeNull();
    expect(screen.queryByTestId("scenarios-outcome-table")).toBeNull();
    // The rest of the page still stands: templates are chrome, not figures.
    expect(screen.getByTestId("scenarios-templates")).toBeTruthy();
  });

  it("409 on the base plan (statements rebuild failed): the same", async () => {
    const sentence = "the statements of this period could not be rebuilt from its line items";
    forecastRecompute.mockImplementation(async () => {
      throw new CfoApiError("409", 409, { code: "statements_rebuild_failed", text: sentence });
    });
    renderPage();
    const detail = await screen.findByTestId("scenarios-refusal-detail");
    expect(detail.textContent).toBe(sentence);
    expect(document.querySelector('[data-projected="true"]')).toBeNull();
  });

  it("422 on a template: that column is the sentence, the base column stands", async () => {
    const sentence =
      "dio_cogs_days is not measured on this book, so a change in days has nothing to add to; set it instead";
    forecastRecompute.mockImplementation(async (_id: string, body: Body) => {
      if (body.shocks.length > 0) {
        throw new CfoApiError("422", 422, {
          code: "days_not_measured",
          text: sentence,
          field: "dio_cogs_days",
        });
      }
      return served();
    });
    renderPage();
    await screen.findByTestId("scenarios-outcome-table");
    fireEvent.click(screen.getByTestId("scenarios-template-working_capital_squeeze"));
    const refusal = await screen.findByTestId("scenarios-refusal-template-sentence");
    expect(refusal.textContent).toBe(sentence);
    const fy = SERVED.horizon.labels_annual[0];
    const templateCell = screen.getByTestId(`scenarios-cell-template-revenue-${fy}`);
    expect(templateCell.querySelector("[data-projected]")).toBeNull();
    expect(templateCell.querySelector('[data-state="refused"]')).not.toBeNull();
    const baseCell = screen.getByTestId(`scenarios-cell-base-revenue-${fy}`);
    expect(baseCell.querySelector('[data-projected="true"]')).not.toBeNull();
  });

  it("switching template never paints the previous template's figures", async () => {
    let release: (v: unknown) => void = () => undefined;
    forecastRecompute.mockImplementation(async (_id: string, body: Body) => {
      if (body.shocks.some((s) => s.driver_key === "price_index")) {
        return new Promise((r) => {
          release = r;
        });
      }
      return served();
    });
    renderPage();
    await screen.findByTestId("scenarios-outcome-table");
    fireEvent.click(screen.getByTestId("scenarios-template-recession"));
    const fy = SERVED.horizon.labels_annual[0];
    await waitFor(() =>
      expect(
        screen
          .getByTestId(`scenarios-cell-template-revenue-${fy}`)
          .querySelector('[data-projected="true"]'),
      ).not.toBeNull(),
    );
    fireEvent.click(screen.getByTestId("scenarios-template-price_pressure"));
    await waitFor(() =>
      expect(
        screen
          .getByTestId(`scenarios-cell-template-revenue-${fy}`)
          .querySelector('[data-state="loading"]'),
      ).not.toBeNull(),
    );
    expect(
      screen
        .getByTestId(`scenarios-cell-template-revenue-${fy}`)
        .querySelector('[data-projected="true"]'),
    ).toBeNull();
    release(served());
  });
});

// ── 4. no industry word, en and ro ─────────────────────────────────────

/** Words of another industry's vocabulary (8.6). Word-bounded: "current"
 *  contains "rent" and is not one. */
const FORBIDDEN = [
  /\brent\b/i,
  /\brents\b/i,
  /\brental\b/i,
  /\brent roll\b/i,
  /\bproperty\b/i,
  /\bproperties\b/i,
  /\btenants?\b/i,
  /\boccupancy\b/i,
  /\bchiri(e|i|ile|a)\b/i,
  /\bchiria[sș]\w*/i,
  /\bimobil\w*/i,
  /\bproprietat\w*/i,
  /\blocatar\w*/i,
  /\bgrad(ul)? de ocupare\b/i,
];

function renderedWords(): string {
  const attrs = Array.from(document.querySelectorAll("[title],[aria-label]"))
    .map((el) => `${el.getAttribute("title") ?? ""} ${el.getAttribute("aria-label") ?? ""}`)
    .join(" ");
  return `${document.body.textContent ?? ""} ${attrs}`;
}

describe("no industry word on the page", () => {
  for (const lang of ["en", "ro"] as const) {
    it(`${lang}: base plus every template, every rendered word`, async () => {
      await i18n.changeLanguage(lang);
      renderPage();
      await screen.findByTestId("scenarios-outcome-table");
      const seen: string[] = [renderedWords()];
      for (const tpl of SCENARIO_TEMPLATES) {
        fireEvent.click(screen.getByTestId(`scenarios-template-${tpl.id}`));
        await waitFor(() =>
          expect(screen.getByTestId(`scenarios-template-${tpl.id}`)).toHaveAttribute(
            "aria-pressed",
            "true",
          ),
        );
        seen.push(renderedWords());
      }
      const text = seen.join(" ");
      // Not vacuous: the page's own chrome rendered in the language asked.
      expect(text).toContain(
        lang === "en" ? "What this template changes" : "Ce schimbă acest șablon",
      );
      for (const rx of FORBIDDEN) {
        expect(text, `${lang}: ${rx} appears on the Scenarios page`).not.toMatch(rx);
      }
    });
  }
});

// ── 5. cash is never painted below zero ────────────────────────────────

describe("a served negative cash is never the page's cash", () => {
  const fy = SERVED.horizon.labels_annual[0] as string;

  function withNegativeCash(): Json {
    const body = served();
    for (const f of body.figures as Array<Json>) {
      if (f.line === "bs.cash" && f.period === fy) f.amount_minor = -12345678900;
      if (f.line === "bs.revolver" && f.period === fy) f.amount_minor = 98765432100;
    }
    const point = (body.series.closing_cash as Array<Json>)[0];
    point.amount_minor = -12345678900;
    return body;
  }

  it("control: a served non-negative cash paints as cash", async () => {
    renderPage();
    const cell = await screen.findByTestId(`scenarios-cell-base-closing_cash-${fy}`);
    expect(cell.querySelector('[data-cash-floored="true"]')).toBeNull();
    const painted = cell.querySelector('[data-projected="true"]');
    expect(painted).not.toBeNull();
    expect(screen.getByTestId("scenarios-cash-chart")).toBeTruthy();
  });

  it("paints the served funding line instead, and withholds the chart", async () => {
    forecastRecompute.mockImplementation(async () => withNegativeCash());
    renderPage();
    const cell = await screen.findByTestId(`scenarios-cell-base-closing_cash-${fy}`);
    expect(cell.querySelector('[data-cash-floored="true"]')).not.toBeNull();
    // Nothing in the cash row shows a negative amount, and the one figure in
    // the cell is the funding line the engine served for that period.
    const row = screen.getByTestId("scenarios-row-closing_cash");
    for (const el of Array.from(row.querySelectorAll("[data-projected-value]"))) {
      expect(el.textContent ?? "").not.toMatch(/[-\u2212]\s*\D{0,4}\d/);
    }
    const figures = cell.querySelectorAll('[data-projected="true"]');
    expect(figures.length).toBe(1);
    const revolver = within(screen.getByTestId("scenarios-row-funding_line"))
      .getByTestId(`scenarios-cell-base-funding_line-${fy}`)
      .querySelector("[data-projected-value]")?.textContent;
    expect(revolver).toBeTruthy();
    expect(figures[0].querySelector("[data-projected-value]")?.textContent).toBe(revolver);
    expect(screen.queryByTestId("scenarios-cash-chart")).toBeNull();
    expect(screen.getByTestId("scenarios-cash-chart-withheld")).toBeTruthy();
  });
});
