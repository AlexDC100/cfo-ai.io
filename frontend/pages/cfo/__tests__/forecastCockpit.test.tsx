// @vitest-environment jsdom
/**
 * THE FORECAST COCKPIT — the page, over a hermetic double of the engine's
 * cockpit route (POST /api/forecast/{id}/cockpit, `forecast_cockpit/1`)
 * answering SYNTHETIC books (components/forecast/cockpit/__tests__/
 * syntheticCockpit.ts; no client name or figure is committed).
 *
 * RED ON (TC-11, i.e. after the repairs):
 *   · a figure among the four numbers, the chart readouts, the bridge or the
 *     statements that is not the ENGINE's (its display text, or its amount
 *     painted through the one gateway door), or a projected one without ◇;
 *   · DSCR not coloured by the ENGINE's verdict; a funding need without its
 *     month or its interest; a missing DSCR painted as a number;
 *   · the engine's sentence not in the page's language (RO and EN);
 *   · a slider without its basis beneath it; "Mai multe" not holding the
 *     rest; a lever the book cannot measure shown with a made-up value;
 *   · a slider drag firing more than ONE request per settled position, or
 *     firing before the debounce; anything the engine computes moving before
 *     it answers; an OLDER answer overwriting the answer to the latest
 *     position (latest response wins);
 *   · reset not landing on the case answer EXACTLY (gate F4) — a cache read
 *     of the served bytes, so a second request is also a red;
 *   · a case switch sending anything but {case_id, levers:{}}; a saved case
 *     (gate F6) stored without its company, its whole lever set, missing
 *     after a reload, listed on another company, or opened with anything but
 *     "saved:<id>";
 *   · present mode not full-screen, not closing on Esc, or carrying more than
 *     one primary action; the bank export not built from the ENGINE's export
 *     data with an assumptions page, or not reaching the PDF pipeline;
 *   · the header not naming the company; more than one primary action; an
 *     upload control; a refusal replaced by a generic message.
 * CANNOT SEE: whether the engine's numbers are right (the engine lane's
 * gates C-F1…C-F9), pixels (the walk's screenshots), real latency (the
 * walk's p95).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import Forecast from "../Forecast";
import { CfoApiError } from "@/lib/cfoApi";
import {
  SYNTH_COMPANY,
  syntheticCockpit,
  syntheticExport,
  type SynthOptions,
} from "@/components/forecast/cockpit/__tests__/syntheticCockpit";

const OTHER = "Exemplu Transport SRL";
const STATE = vi.hoisted(() => ({
  company: { id: "org-exemplu", name: "Exemplu Alimentar SRL" },
  period: { id: "p-synth", label: "FY2025" } as { id: string | null; label: string | null },
}));
vi.mock("@/lib/activePeriod", () => ({ useActivePeriod: () => STATE.period }));
vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: STATE.period.id, status: "ready" }),
}));
vi.mock("@/lib/org", () => {
  const org = () => ({
    id: STATE.company.id, name: STATE.company.name, industry_key: null,
    industry_display_name: null, default_currency: "RON", role: "owner",
    archived_at: null, purge_after: null, created_at: "2026-01-01T00:00:00Z",
  });
  return {
    useActiveOrg: () => ({
      org: org(), orgs: [org()], archived: [], loading: false, loadError: false,
      needsOnboarding: false, refresh: async () => undefined, switchOrg: async () => undefined,
      createWorkspace: async () => null, renameWorkspace: async () => false,
      setWorkspaceIndustry: async () => false, archiveWorkspace: async () => false,
      restoreWorkspace: async () => false, purgeWorkspace: async () => false,
    }),
    daysUntilPurge: () => 30,
  };
});

/** THE org_prefs DOUBLE: rows by org_id, and set_org_pref's one-key merge. */
const DB = vi.hoisted(() => ({
  orgPrefs: new Map<string, Record<string, unknown>>(),
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table !== "org_prefs") throw new Error(`the double has no table ${table}`);
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return q;
        },
        maybeSingle: async () => {
          const bag = DB.orgPrefs.get(String(filters.org_id));
          return { data: bag ? { prefs: JSON.parse(JSON.stringify(bag)) } : null, error: null };
        },
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      DB.rpcCalls.push({ fn, args: JSON.parse(JSON.stringify(args)) });
      if (fn !== "set_org_pref") return { data: null, error: { message: `no rpc ${fn}` } };
      const org = String(args.p_org_id);
      const bag = { ...(DB.orgPrefs.get(org) ?? {}) };
      bag[String(args.p_key)] = JSON.parse(JSON.stringify(args.p_value));
      DB.orgPrefs.set(org, bag);
      return { data: null, error: null };
    },
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
  supabaseEnabled: true,
  currentOrgId: async () => STATE.company.id,
}));

const pdf = vi.hoisted(() => ({ request: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/reportPdf", () => ({
  requestReportPdf: (...a: unknown[]) => pdf.request(...a),
  saveReportPdf: (...a: unknown[]) => pdf.save(...a),
}));

type Body = { case_id: string; levers: Record<string, string> };
const cockpitCall = vi.fn();
const exportCall = vi.fn();
vi.mock("@/lib/cfoApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cfoApi")>("@/lib/cfoApi");
  return {
    ...actual,
    cfoApi: {
      forecastCockpit: (...a: unknown[]) => cockpitCall(...a),
      forecastCockpitExport: (...a: unknown[]) => exportCall(...a),
    },
  };
});

/** The double's answer to a body. Like the engine: a saved case is read from
 *  THIS company's bag (and refused when it names another company); the case
 *  decides the case; a moved slider moves the served figures (seed).
 *  Deterministic: the same body is the same bytes. */
function answerFor(body: Body, extra: SynthOptions = {}) {
  let savedName: string | undefined;
  if (body.case_id.startsWith("saved:")) {
    const id = body.case_id.slice("saved:".length);
    const list = (DB.orgPrefs.get(STATE.company.id)?.forecast_cases ?? []) as Array<Record<string, unknown>>;
    const entry = list.find((e) => e.id === id);
    if (!entry || entry.orgId !== STATE.company.id) {
      throw new CfoApiError("refused", 404, { code: "case_not_found", text: `no saved case ${body.case_id} in this company's saved cases`, field: "case_id" });
    }
    savedName = String(entry.name);
  }
  const seed =
    Object.values(body.levers).reduce((s, v) => s + Math.round(Math.abs(Number(v)) * 1000), 0) +
    (body.case_id === "pesimist" ? 7 : body.case_id === "optimist" ? 3 : savedName ? 11 : 0);
  return syntheticCockpit({
    caseId: body.case_id,
    levers: body.levers,
    seed,
    funding: body.case_id === "pesimist",
    dscrBelow: body.case_id === "pesimist",
    savedName,
    ...extra,
  });
}

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

const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const lastBody = () => cockpitCall.mock.calls[cockpitCall.mock.calls.length - 1][1] as Body;
const nb = (s: string | null | undefined) => (s ?? "").replace(/ /g, " ");
const painted = (testId: string) =>
  nb(screen.getByTestId(testId).querySelector("[data-projected-value]")?.textContent);

beforeEach(async () => {
  await i18n.changeLanguage("en");
  STATE.company = { id: "org-exemplu", name: SYNTH_COMPANY };
  STATE.period = { id: "p-synth", label: "FY2025" };
  DB.orgPrefs.clear();
  DB.rpcCalls.length = 0;
  pdf.request.mockReset();
  pdf.save.mockReset();
  cockpitCall.mockReset();
  exportCall.mockReset();
  cockpitCall.mockImplementation(async (_id: string, body: Body) => answerFor(body));
  exportCall.mockImplementation(async (_id: string, body: Body) => syntheticExport(answerFor(body)));
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("the four numbers a bank asks for", () => {
  it("each is the ENGINE's text, painted with the ◇ mark", async () => {
    wrap();
    await screen.findByTestId("cockpit-numbers");
    expect(cockpitCall).toHaveBeenCalledTimes(1);
    expect(lastBody()).toEqual({ case_id: "base", levers: {} });
    expect(painted("cockpit-ebitda-final")).toBe("17.2M RON");
    expect(painted("cockpit-cumulative-fcf")).toBe("45.0M RON");
    expect(painted("cockpit-min-cash")).toBe("3.1M RON");
    expect(screen.getByTestId("cockpit-min-cash").textContent).toContain("March 2026");
    for (const id of ["cockpit-ebitda-final", "cockpit-cumulative-fcf", "cockpit-min-cash", "cockpit-dscr"]) {
      const card = screen.getByTestId(id);
      const figure = card.querySelector('[data-projected="true"]');
      expect(figure, `${id} paints no projected figure`).not.toBeNull();
      expect(figure?.querySelector("[data-projected-mark]")?.textContent, `${id} lost its ◇`).toBe("◇");
    }
    expect(screen.getByTestId("cockpit-ebitda-final").textContent).toContain("EBITDA 2030");
    expect(screen.getByTestId("cockpit-ebitda-margin").textContent).toContain("15.2%");
    const today = screen.getByTestId("cockpit-ebitda-margin-today");
    expect(today.textContent).toContain("11.9%");
    expect(today.querySelector("[data-projected-mark]"), "today's margin is an ACTUAL: no ◇").toBeNull();
  });

  it("DSCR is coloured by the ENGINE's verdict against its served threshold", async () => {
    wrap();
    const card = await screen.findByTestId("cockpit-dscr");
    expect(card.getAttribute("data-tone")).toBe("good");
    expect(painted("cockpit-dscr")).toBe("2.10×");
    expect(screen.getByTestId("cockpit-dscr-verdict").getAttribute("data-below")).toBe("false");
    expect(screen.getByTestId("cockpit-dscr-verdict").textContent).toContain("1.25×");

    fireEvent.click(screen.getByTestId("cockpit-case-pesimist"));
    await waitFor(() => expect(screen.getByTestId("cockpit-dscr").getAttribute("data-tone")).toBe("bad"));
    expect(painted("cockpit-dscr")).toBe("0.98×");
    expect(screen.getByTestId("cockpit-dscr-verdict").textContent).toContain("below the bank's threshold");
  });

  it("a DSCR with no debt service is said, never painted as a number", async () => {
    cockpitCall.mockImplementation(async (_id: string, body: Body) => answerFor(body, { dscrNotApplicable: true }));
    wrap();
    const refusal = await screen.findByTestId("cockpit-dscr-refusal");
    expect(refusal.textContent).toContain("no debt service in 2026");
    expect(screen.getByTestId("cockpit-dscr").querySelector("[data-projected-value]")).toBeNull();
  });

  it("a plan that needs money says 'funding need', the month and the interest", async () => {
    wrap();
    await screen.findByTestId("cockpit-numbers");
    fireEvent.click(screen.getByTestId("cockpit-case-pesimist"));
    const card = await screen.findByTestId("cockpit-funding-need");
    expect(screen.queryByTestId("cockpit-min-cash")).toBeNull();
    expect(painted("cockpit-funding-need")).toBe("18.0M RON");
    expect(screen.getByTestId("cockpit-funding-month").textContent).toBe("from October 2026");
    const interest = screen.getByTestId("cockpit-funding-interest");
    expect(interest.querySelector("[data-projected-mark]")).not.toBeNull();
    expect(nb(interest.querySelector("[data-projected-value]")?.textContent)).toBe("123.5K RON");
    expect(card.getAttribute("data-tone")).toBe("warn");
    // the chart shades exactly the periods the ENGINE flags
    expect(screen.getByTestId("cockpit-chart").getAttribute("data-funding-gap")).toBe("true");
    for (const p of ["2026-10", "2026-11", "2026-12", "FY2027", "FY2030"]) {
      expect(screen.getByTestId(`cockpit-chart-gap-${p}`), p).toBeTruthy();
    }
    expect(screen.queryByTestId("cockpit-chart-gap-2026-09")).toBeNull();
  });

  it("a line first drawn after plan year one is dated to its YEAR — 'during 2027', never 'from 2027' (EN and RO, card, sentence and export)", async () => {
    // the engine projects monthly only in plan year one; a later first draw
    // is known to the year, and the card must not read as a month
    const annual = (body: Body) => answerFor(body, { fundingFirst: "annual" });
    cockpitCall.mockImplementation(async (_id: string, body: Body) => annual(body));
    exportCall.mockImplementation(async (_id: string, body: Body) => syntheticExport(annual(body)));
    pdf.request.mockResolvedValue({ blob: new Blob(["%PDF"]), filename: "x.pdf", pages: 4 });
    const en = wrap();
    await screen.findByTestId("cockpit-numbers");
    fireEvent.click(screen.getByTestId("cockpit-case-pesimist"));
    await screen.findByTestId("cockpit-funding-need");
    const when = screen.getByTestId("cockpit-funding-month");
    expect(when.textContent).toBe("during 2027");
    expect(when.getAttribute("data-granularity")).toBe("annual");
    expect(screen.getByTestId("cockpit-sentence").textContent).toContain("during 2027");
    expect(screen.getByTestId("cockpit-sentence").textContent).not.toContain("starting in 2027");
    // the chart shades the year, no month of year one
    expect(screen.queryByTestId("cockpit-chart-gap-2026-10")).toBeNull();
    expect(screen.getByTestId("cockpit-chart-gap-FY2027")).toBeTruthy();
    // the bank export says the same
    fireEvent.click(screen.getByTestId("cockpit-export"));
    await waitFor(() => expect(pdf.request).toHaveBeenCalledTimes(1));
    const [html] = pdf.request.mock.calls[0] as [string];
    expect(html).toContain("during 2027");
    expect(html).not.toContain("from 2027");
    en.unmount();
    await i18n.changeLanguage("ro");
    wrap();
    await screen.findByTestId("cockpit-numbers");
    fireEvent.click(screen.getByTestId("cockpit-case-pesimist"));
    await screen.findByTestId("cockpit-funding-need");
    expect(screen.getByTestId("cockpit-funding-month").textContent).toBe("în cursul anului 2027");
    expect(screen.getByTestId("cockpit-sentence").textContent).toContain("în cursul anului 2027");
    expect(screen.getByTestId("cockpit-sentence").textContent).not.toContain("începând din 2027");
    // a first draw in a MONTH of year one keeps the month (the default double)
    cockpitCall.mockImplementation(async (_id: string, body: Body) => answerFor(body));
    cleanup();
    wrap();
    await screen.findByTestId("cockpit-numbers");
    fireEvent.click(screen.getByTestId("cockpit-case-pesimist"));
    await screen.findByTestId("cockpit-funding-need");
    expect(screen.getByTestId("cockpit-funding-month").getAttribute("data-granularity")).toBe("monthly");
    expect(screen.getByTestId("cockpit-funding-month").textContent).toBe("din octombrie 2026");
  });
});

describe("the chart", () => {
  it("draws year 0 as the actual and five projected years, every readout served", async () => {
    wrap();
    await screen.findByTestId("cockpit-chart");
    expect(screen.getByTestId("cockpit-chart-bar-FY2025").getAttribute("data-kind")).toBe("actual");
    for (const y of ["FY2026", "FY2027", "FY2028", "FY2029", "FY2030"]) {
      expect(screen.getByTestId(`cockpit-chart-bar-${y}`).getAttribute("data-kind")).toBe("projected");
    }
    const readouts = screen.getByTestId("cockpit-chart-readouts");
    const y0 = readouts.querySelector('[data-period="FY2025"] [data-series="ebitda"]');
    expect(y0?.querySelector("[data-actual]"), "year 0 is an actual").not.toBeNull();
    expect(y0?.querySelector("[data-projected-mark]")).toBeNull();
    const y5 = readouts.querySelector('[data-period="FY2030"] [data-series="ebitda"]');
    expect(nb(y5?.querySelector("[data-projected-value]")?.textContent)).toBe("17.2M RON");
    expect(y5?.querySelector("[data-projected-mark]")).not.toBeNull();
    // year one's close is the served close of its LAST month (a selection)
    const y1cash = readouts.querySelector('[data-period="FY2026"] [data-series="cash"] [data-projected-value]');
    expect(nb(y1cash?.textContent)).toBe("3.8M RON");
    expect(screen.queryByTestId("cockpit-chart-gap-legend")).toBeNull();
  });
});

describe("the engine's sentence under the numbers", () => {
  it("is the engine's own, in the page's language", async () => {
    const en = wrap();
    const p = await screen.findByTestId("cockpit-sentence");
    expect(p.textContent).toMatch(/^In the base case, cash never goes below zero, with a low of 3\.1M RON in March 2026;/);
    en.unmount();
    await i18n.changeLanguage("ro");
    wrap();
    const ro = await screen.findByTestId("cockpit-sentence");
    expect(ro.textContent).toMatch(/^În scenariul de bază, numerarul nu scade sub zero/);
    fireEvent.click(screen.getByTestId("cockpit-case-pesimist"));
    await waitFor(() =>
      expect(screen.getByTestId("cockpit-sentence").textContent).toMatch(
        /^În scenariul pesimist, ai nevoie de o linie de credit de până la 18,0 mil\. RON începând din octombrie 2026; DSCR scade sub pragul băncii/,
      ),
    );
    expect(screen.getByTestId("cockpit-case-base").textContent).toBe("Bază");
    expect(screen.getByTestId("cockpit-present-open").textContent).toContain("Prezintă");
    expect(screen.getByTestId("cockpit-export").textContent).toContain("Exportă pentru bancă");
    expect(screen.getByTestId("cockpit-funding-need").textContent).toContain("Necesar de finanțare");
    expect(screen.getByTestId("cockpit-funding-month").textContent).toBe("din octombrie 2026");
    expect(painted("cockpit-funding-need")).toBe("18,0 mil. RON");
    expect(screen.getByTestId("cockpit-case-basis").textContent).toContain("traiectoria BNR");
  });
});

describe("the sliders", () => {
  it("four primary sliders, each with its basis beneath; the rest behind 'More'", async () => {
    wrap();
    await screen.findByTestId("cockpit-levers");
    for (const id of ["revenue_growth", "inflation", "raw_material_price", "wage_growth"]) {
      const basis = screen.getByTestId(`cockpit-lever-${id}-basis`);
      expect(basis.textContent?.length, `${id} has no basis`).toBeGreaterThan(5);
    }
    expect(screen.getByTestId("cockpit-lever-revenue_growth-basis").textContent).toBe(
      "history 3.1% (2024→2025, synthetic) · sector median 4.4% (synthetic)",
    );
    expect(screen.getByTestId("cockpit-lever-revenue_growth-value").textContent).toBe("3.1%");
    expect(screen.queryByTestId("cockpit-lever-eur_ron")).toBeNull();
    fireEvent.click(screen.getByTestId("cockpit-levers-more"));
    // the book cannot measure EUR/RON: no value made up, and the basis SAYS so
    expect(screen.getByTestId("cockpit-lever-eur_ron-value").textContent).toBe("not measured");
    expect(screen.getByTestId("cockpit-lever-eur_ron-basis").textContent).toContain("not measurable");
    expect(screen.getByTestId("cockpit-lever-eur_ron-inert").textContent).toContain("imported share");
    expect(screen.getByTestId("cockpit-lever-dso_days-value").textContent).toBe("45.0");
  });

  it("one request per settled drag, after the debounce, with exact decimals", async () => {
    wrap();
    await screen.findByTestId("cockpit-levers");
    expect(cockpitCall).toHaveBeenCalledTimes(1);
    const input = screen.getByTestId("cockpit-lever-revenue_growth-input");
    // served step "0.001": the slider moves in ticks of one thousandth
    expect(input.getAttribute("step")).toBe("1");
    expect(input.getAttribute("min")).toBe("-300");
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.change(input, { target: { value: "52" } });
    // the slider shows the reader's position at once …
    expect(screen.getByTestId("cockpit-lever-revenue_growth-value").textContent).toBe("5.2%");
    expect(screen.getByTestId("cockpit-lever-revenue_growth-value").getAttribute("data-pending")).toBe("true");
    await sleep(120);
    // … but the engine has not been asked yet (the owner's ~250 ms)
    expect(cockpitCall).toHaveBeenCalledTimes(1);
    await sleep(250);
    expect(cockpitCall).toHaveBeenCalledTimes(2);
    expect(lastBody()).toEqual({ case_id: "base", levers: { revenue_growth: "0.052" } });
    await waitFor(() => expect(screen.getByTestId("forecast-cockpit").getAttribute("data-recomputing")).toBe("false"));
    expect(cockpitCall).toHaveBeenCalledTimes(2);
    // once answered, the value beside the slider is the ENGINE's display
    expect(screen.getByTestId("cockpit-lever-revenue_growth-value").getAttribute("data-pending")).toBe("false");
    expect(screen.getByTestId("cockpit-lever-revenue_growth").getAttribute("data-origin")).toBe("user");
  });

  it("NOTHING the engine computes moves until the engine answers", async () => {
    wrap();
    await screen.findByTestId("cockpit-levers");
    const numbers = screen.getByTestId("cockpit-numbers").textContent;
    const chart = screen.getByTestId("cockpit-chart-readouts").textContent;
    const sentence = screen.getByTestId("cockpit-sentence").textContent;
    let release: (v: unknown) => void = () => undefined;
    let body: Body | null = null;
    cockpitCall.mockImplementation(
      (_id: string, b: Body) =>
        new Promise((resolve) => {
          body = b;
          release = resolve;
        }),
    );
    fireEvent.change(screen.getByTestId("cockpit-lever-revenue_growth-input"), { target: { value: "150" } });
    await sleep(320);
    expect(body).not.toBeNull();
    expect(screen.getByTestId("forecast-cockpit").getAttribute("data-recomputing")).toBe("true");
    expect(screen.getByTestId("cockpit-numbers").textContent).toBe(numbers);
    expect(screen.getByTestId("cockpit-chart-readouts").textContent).toBe(chart);
    expect(screen.getByTestId("cockpit-sentence").textContent).toBe(sentence);
    await act(async () => release(answerFor(body as unknown as Body)));
    await waitFor(() => expect(screen.getByTestId("cockpit-numbers").textContent).not.toBe(numbers));
    expect(screen.getByTestId("forecast-cockpit").getAttribute("data-recomputing")).toBe("false");
  });

  it("LATEST RESPONSE WINS: an older answer arriving last never overwrites the newer one", async () => {
    wrap();
    await screen.findByTestId("cockpit-levers");
    const base = painted("cockpit-ebitda-final");
    const deferred: Array<{ body: Body; resolve: (v: unknown) => void }> = [];
    cockpitCall.mockImplementation((_id: string, body: Body) => new Promise((resolve) => deferred.push({ body, resolve })));
    const input = screen.getByTestId("cockpit-lever-revenue_growth-input");
    fireEvent.change(input, { target: { value: "100" } });
    await sleep(300);
    fireEvent.change(input, { target: { value: "150" } });
    await sleep(300);
    expect(deferred.map((d) => d.body.levers.revenue_growth)).toEqual(["0.1", "0.15"]);
    await act(async () => deferred[1].resolve(answerFor(deferred[1].body)));
    const newer = painted("cockpit-ebitda-final");
    expect(newer).not.toBe(base);
    await act(async () => deferred[0].resolve(answerFor(deferred[0].body)));
    expect(painted("cockpit-ebitda-final")).toBe(newer);
    expect(screen.getByTestId("cockpit-lever-revenue_growth-value").textContent).toBe("15.0%");
  });

  it("an answer to a superseded position is not shown while the latest is in flight", async () => {
    wrap();
    await screen.findByTestId("cockpit-levers");
    const base = painted("cockpit-ebitda-final");
    const deferred: Array<{ body: Body; resolve: (v: unknown) => void }> = [];
    cockpitCall.mockImplementation((_id: string, body: Body) => new Promise((resolve) => deferred.push({ body, resolve })));
    const input = screen.getByTestId("cockpit-lever-revenue_growth-input");
    fireEvent.change(input, { target: { value: "100" } });
    await sleep(300);
    fireEvent.change(input, { target: { value: "150" } });
    await sleep(300);
    await act(async () => deferred[0].resolve(answerFor(deferred[0].body)));
    expect(painted("cockpit-ebitda-final")).toBe(base);
    expect(screen.getByTestId("forecast-cockpit").getAttribute("data-recomputing")).toBe("true");
    await act(async () => deferred[1].resolve(answerFor(deferred[1].body)));
    expect(painted("cockpit-ebitda-final")).not.toBe(base);
  });

  it("gate F4: reset lands on the case answer EXACTLY, from the served bytes", async () => {
    wrap();
    await screen.findByTestId("cockpit-levers");
    const baseText = screen.getByTestId("cockpit-numbers").textContent;
    const baseChart = screen.getByTestId("cockpit-chart-readouts").textContent;
    fireEvent.change(screen.getByTestId("cockpit-lever-inflation-input"), { target: { value: "90" } });
    await sleep(320);
    await waitFor(() => expect(screen.getByTestId("cockpit-numbers").textContent).not.toBe(baseText));
    expect(screen.getByTestId("cockpit-bridge")).toBeTruthy();
    const calls = cockpitCall.mock.calls.length;
    fireEvent.click(screen.getByTestId("cockpit-lever-inflation-reset"));
    await waitFor(() => expect(screen.getByTestId("cockpit-numbers").textContent).toBe(baseText));
    expect(screen.getByTestId("cockpit-chart-readouts").textContent).toBe(baseChart);
    expect(screen.queryByTestId("cockpit-bridge")).toBeNull();
    expect(cockpitCall.mock.calls.length).toBe(calls);
  });

  it("a refused position keeps the last served answer, names the lever and says why", async () => {
    wrap();
    await screen.findByTestId("cockpit-levers");
    const base = painted("cockpit-ebitda-final");
    cockpitCall.mockImplementation(async () => {
      throw new CfoApiError("refused", 422, {
        code: "lever_out_of_range",
        text: "inflation: 0.2 is outside 0 to 0.15",
        field: "inflation",
      });
    });
    fireEvent.change(screen.getByTestId("cockpit-lever-inflation-input"), { target: { value: "150" } });
    await sleep(320);
    const notice = await screen.findByTestId("forecast-stale-notice");
    expect(screen.getByTestId("cockpit-refusal-sentence").textContent).toBe("inflation: 0.2 is outside 0 to 0.15");
    expect(notice.textContent).not.toMatch(/\{"code"/);
    expect(painted("cockpit-ebitda-final")).toBe(base);
    expect(screen.getByTestId("cockpit-lever-inflation").className).toContain("border-alert");
  });
});

describe("the case switch and the bridge from base", () => {
  it("Bază · Optimist · Pesimist are the engine's cases; a switch sends the case and no lever", async () => {
    wrap();
    await screen.findByTestId("cockpit-cases");
    expect(["base", "optimist", "pesimist"].map((id) => screen.getByTestId(`cockpit-case-${id}`).textContent)).toEqual([
      "Base",
      "Optimist",
      "Pessimist",
    ]);
    expect(screen.queryByTestId("cockpit-bridge"), "the base case has no bridge from itself").toBeNull();
    fireEvent.click(screen.getByTestId("cockpit-case-optimist"));
    await waitFor(() => expect(cockpitCall).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({ case_id: "optimist", levers: {} });
    await waitFor(() => expect(screen.getByTestId("cockpit-case-optimist").getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByTestId("cockpit-case-basis").textContent).toContain("sector median");
    // gate F9 on the page: the bridge from base, every step served, ◇ on each
    const bridge = await screen.findByTestId("cockpit-bridge");
    expect(bridge.getAttribute("data-sums-exactly")).toBe("true");
    for (const s of ["revenue", "costs", "ebitda", "working_capital", "capex", "interest_tax", "dividends", "debt", "cash"]) {
      const li = within(bridge).getByTestId(`cockpit-bridge-${s}`);
      expect(li.querySelector("[data-projected-mark]"), s).not.toBeNull();
    }
    expect(within(bridge).getByTestId("cockpit-bridge-cash").getAttribute("data-total")).toBe("true");
    fireEvent.click(within(bridge).getByTestId("cockpit-bridge-window-year_one"));
    expect(screen.getByTestId("cockpit-bridge").getAttribute("data-window")).toBe("year_one");
    // back to base: the base answer, from the cache
    fireEvent.click(screen.getByTestId("cockpit-case-base"));
    await waitFor(() => expect(screen.queryByTestId("cockpit-bridge")).toBeNull());
    expect(cockpitCall).toHaveBeenCalledTimes(2);
  });

  it("a per-year path the case sets is shown as the engine's display, marked as a path", async () => {
    wrap();
    await screen.findByTestId("cockpit-levers");
    fireEvent.click(screen.getByTestId("cockpit-case-pesimist"));
    await waitFor(() => expect(screen.getByTestId("cockpit-lever-inflation").getAttribute("data-origin")).toBe("case"));
    expect(screen.getByTestId("cockpit-lever-inflation-value").textContent).toBe("4.5%");
    expect(screen.getByTestId("cockpit-lever-inflation-path")).toBeTruthy();
    expect(screen.getByTestId("cockpit-lever-raw_material_price-value").textContent).toBe("12.0%");
  });
});

describe("gate F6: saved cases survive reload and belong to the right company", () => {
  it("saves the WHOLE lever set to the company on screen; the engine reopens it after a reload; never on another company", async () => {
    const first = wrap();
    await screen.findByTestId("cockpit-levers");
    fireEvent.click(screen.getByTestId("cockpit-case-pesimist"));
    await waitFor(() => expect(screen.getByTestId("cockpit-case-pesimist").getAttribute("aria-checked")).toBe("true"));
    await screen.findByTestId("cockpit-funding-need");
    fireEvent.change(screen.getByTestId("cockpit-lever-wage_growth-input"), { target: { value: "95" } });
    await sleep(320);
    await waitFor(() => expect(screen.getByTestId("cockpit-lever-wage_growth").getAttribute("data-origin")).toBe("user"));
    fireEvent.click(screen.getByTestId("cockpit-save"));
    fireEvent.change(screen.getByTestId("cockpit-save-name"), { target: { value: "Salarii mari" } });
    fireEvent.click(screen.getByTestId("cockpit-save-confirm"));
    await waitFor(() => expect(DB.rpcCalls).toHaveLength(1));
    expect(DB.rpcCalls[0].args.p_org_id).toBe("org-exemplu");
    expect(DB.rpcCalls[0].args.p_key).toBe("forecast_cases");
    const stored = DB.rpcCalls[0].args.p_value as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    // the case it started from (the engine's own decimals) + the moved slider
    expect(stored[0]).toMatchObject({
      name: "Salarii mari",
      orgId: "org-exemplu",
      caseId: "pesimist",
      levers: {
        inflation: ["0.045", "0.035", "0.03", "0.03", "0.03"],
        raw_material_price: ["0.12"],
        wage_growth: "0.095",
      },
    });
    const savedId = String(stored[0].id);
    // saving opens it: the ENGINE is asked for "saved:<id>", no lever sent
    await waitFor(() => expect(lastBody()).toEqual({ case_id: `saved:${savedId}`, levers: {} }));
    first.unmount();

    // RELOAD: a fresh page over the double's rows only
    cockpitCall.mockClear();
    wrap();
    await screen.findByTestId("cockpit-levers");
    const pill = await screen.findByTestId(`cockpit-saved-${savedId}`);
    expect(pill.textContent).toBe("Salarii mari");
    fireEvent.click(pill);
    await waitFor(() => expect(lastBody()).toEqual({ case_id: `saved:${savedId}`, levers: {} }));
    await waitFor(() => expect(screen.getByTestId("cockpit-sentence").textContent).toContain("“Salarii mari”"));
    cleanup();

    // ANOTHER COMPANY: nothing of the first is listed
    STATE.company = { id: "org-other", name: OTHER };
    STATE.period = { id: "p-other", label: "FY2025" };
    wrap();
    await screen.findByTestId("cockpit-levers");
    await sleep(20);
    expect(screen.queryByTestId(`cockpit-saved-${savedId}`)).toBeNull();
    expect(screen.getByTestId("forecast-company").textContent).toBe(OTHER);
  });

  it("an entry naming another company, or not a lever set, is never listed", async () => {
    DB.orgPrefs.set("org-exemplu", {
      forecast_cases: [
        { id: "x1", name: "Străin", orgId: "org-other", caseId: "base", levers: {}, savedAt: "2026-09-01T00:00:00Z" },
        { id: "x2", name: "Al meu", orgId: "org-exemplu", caseId: "pesimist", levers: { inflation: "0.05" }, savedAt: "2026-09-02T00:00:00Z" },
        { id: "x3", name: "Stricat", orgId: "org-exemplu", caseId: "base", levers: { inflation: 0.05 }, savedAt: "2026-09-03T00:00:00Z" },
      ],
    });
    wrap();
    await screen.findByTestId("cockpit-saved-x2");
    expect(screen.queryByTestId("cockpit-saved-x1")).toBeNull();
    expect(screen.queryByTestId("cockpit-saved-x3")).toBeNull();
    fireEvent.click(screen.getByTestId("cockpit-saved-x2"));
    await waitFor(() => expect(lastBody()).toEqual({ case_id: "saved:x2", levers: {} }));
  });
});

describe("present mode and the bank export", () => {
  it("'Present' opens a full-screen view with one primary action; Esc exits", async () => {
    wrap();
    await screen.findByTestId("cockpit-numbers");
    fireEvent.click(screen.getByTestId("cockpit-present-open"));
    const overlay = await screen.findByTestId("cockpit-present");
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.className).toContain("fixed");
    expect(overlay.className).toContain("inset-0");
    expect(screen.getByTestId("cockpit-present-company").textContent).toBe(SYNTH_COMPANY);
    expect(within(overlay).getByTestId("cockpit-numbers")).toBeTruthy();
    expect(within(overlay).getByTestId("cockpit-chart")).toBeTruthy();
    expect(within(overlay).getByTestId("cockpit-present-sentence").textContent).toMatch(/^In the base case/);
    expect(within(overlay).getByTestId("cockpit-present-assumptions").textContent).toContain("Revenue growth / year");
    expect(document.querySelectorAll('[data-primary-action="true"]')).toHaveLength(1);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("cockpit-present")).toBeNull());
    expect(screen.getByTestId("cockpit-numbers")).toBeTruthy();
  });

  it("'Export for the bank' renders the ENGINE's export data through the CFO Report PDF pipeline", async () => {
    pdf.request.mockResolvedValue({ blob: new Blob(["%PDF"]), filename: "x.pdf", pages: 4 });
    wrap();
    await screen.findByTestId("cockpit-numbers");
    fireEvent.click(screen.getByTestId("cockpit-case-pesimist"));
    await screen.findByTestId("cockpit-funding-need");
    fireEvent.click(screen.getByTestId("cockpit-export"));
    await waitFor(() => expect(pdf.request).toHaveBeenCalledTimes(1));
    // the export asks the engine for THE request on screen
    expect(exportCall).toHaveBeenCalledWith("p-synth", { case_id: "pesimist", levers: {} });
    const [html, meta] = pdf.request.mock.calls[0] as [string, { company: string; period: string }];
    expect(meta.company).toBe(SYNTH_COMPANY);
    expect(html).toContain('data-forecast-export="bank"');
    expect(html).toContain('id="assumptions"');
    expect(html).toContain("inflation on the BNR path (synthetic); raw materials +12.0%");
    expect(html).toContain("from the case");
    expect(html).toContain("In the pessimist case, you need a credit line of up to 18.0M RON");
    expect(html).toContain("@page");
    expect(html).toContain("headcount is not served");
    const marked = html.match(/data-projected="true"[^>]*>[^<]*<sup class="pm"/g) ?? [];
    expect(marked.length).toBeGreaterThan(20);
    expect(html).not.toMatch(/<script/i);
    await waitFor(() => expect(pdf.save).toHaveBeenCalledTimes(1));
  });
});

describe("the collapsed statements", () => {
  it("every served cell painted as itself: ◇ on projections, year 0 an actual, no zero invented", async () => {
    wrap();
    await screen.findByTestId("forecast-block-pl");
    const details = screen.getByTestId("forecast-appendix-details") as HTMLDetailsElement;
    expect(details.open, "the statements are the appendix: collapsed").toBe(false);
    const y0 = document.querySelector('td[data-line="pl.revenue"][data-period="FY2025"]');
    expect(y0?.querySelector("[data-actual]")).not.toBeNull();
    expect(nb(y0?.textContent)).toContain("97,000,000");
    const y1 = document.querySelector('td[data-line="pl.revenue"][data-period="FY2026"]');
    expect(nb(y1?.querySelector("[data-projected-value]")?.textContent)).toBe("100,000,000 RON");
    expect(y1?.querySelector("[data-projected-mark]")).not.toBeNull();
    // interest on debt is never zero while the book carries debt (F5)
    const interest = Array.from(document.querySelectorAll('td[data-line="pl.interest_expense_debt"]')).filter(
      (c) => c.getAttribute("data-period") !== "FY2025",
    );
    expect(interest).toHaveLength(5);
    for (const cell of interest) {
      expect(nb(cell.textContent)).toMatch(/[1-9]/);
      expect(cell.querySelector("[data-projected-mark]")).not.toBeNull();
    }
    // a year-0 line the book does not split: the engine's reason, an em dash, never a zero
    const unsplit = document.querySelector('td[data-line="pl.cost_of_sales"][data-period="FY2025"] [data-projected="refused"]');
    expect(unsplit?.textContent).toBe("—");
    expect(unsplit?.getAttribute("title")).toBe("the actual year does not split this line");
    // the assumptions come BEFORE the statements: a reader meets the drivers first
    const levers = screen.getByTestId("cockpit-levers");
    expect(levers.compareDocumentPosition(screen.getByTestId("forecast-block-pl")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("cockpit-conventions").textContent).toContain("HELD at their opening balance");
    expect(screen.getByTestId("cockpit-not-modelled").textContent).toContain("headcount is not served");
  });
});

describe("the company on screen", () => {
  it("names the company, carries ONE primary action and no upload control", async () => {
    wrap();
    await screen.findByTestId("cockpit-numbers");
    expect(screen.getByTestId("forecast-company").textContent).toBe(SYNTH_COMPANY);
    expect(document.querySelectorAll('[data-primary-action="true"]')).toHaveLength(1);
    expect(screen.getByTestId("cockpit-present-open").getAttribute("data-primary-action")).toBe("true");
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("the engine refusing the book: its own sentence, never a generic message", async () => {
    cockpitCall.mockImplementation(async () => {
      throw new CfoApiError("refused", 422, {
        code: "balance_violation",
        text: "the projected balance sheet does not close in FY2027 by 4.11; the projection is not served",
      });
    });
    wrap();
    const detail = await screen.findByTestId("forecast-refusal-detail");
    expect(detail.textContent).toBe("the projected balance sheet does not close in FY2027 by 4.11; the projection is not served");
    expect(screen.queryByTestId("cockpit-numbers")).toBeNull();
  });

  it("an answer that is not the cockpit: a contract error, no numbers invented", async () => {
    cockpitCall.mockImplementation(async () => ({ kind: "projection", contract: "fp1.2" }));
    wrap();
    await screen.findByTestId("forecast-contract-error");
    expect(screen.queryByTestId("cockpit-numbers")).toBeNull();
    expect(screen.queryByTestId("cockpit-chart")).toBeNull();
  });
});
