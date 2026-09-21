// @vitest-environment jsdom
/**
 * GATE F6 — a saved scenario survives reload and belongs to the right company
 * (forecast-scenarios-live).
 *
 * The real `lib/savedScenarios` over a Supabase double that behaves like the
 * production pair it talks to: `org_prefs` rows keyed by org_id (read with
 * select/eq/maybeSingle) and the `set_org_pref` RPC, which merges ONE
 * top-level key into ONE org's bag — exactly schema_phase_prefs.sql. The page
 * is the real Scenarios page; only the engine (cfoApi) and the active
 * company / period are stubbed.
 *
 * RED ON (TC-11): a save that lands in any org but the company on screen
 * (the RPC's p_org_id); a saved scenario missing after a RELOAD (fresh query
 * cache, fresh render, the double's rows only); a Scandia scenario listed on
 * Agras — on a fresh load of Agras, on a company switch inside one session
 * (the query cache keyed by company), or through a bag entry that names
 * another company; opening a saved scenario sending anything but its saved
 * template and levers to the engine.
 * CANNOT SEE: RLS on org_prefs (the migration's own tests), a two-tab race on
 * the whole list (documented in lib/savedScenarios.ts).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import Scenarios from "../Scenarios";

const SCANDIA = { id: "org-scandia", name: "Scandia Food SRL", period: { id: "p-scandia", label: "FY2025" } };
const AGRAS = { id: "org-agras", name: "Agra's Food Factory SRL", period: { id: "p-agras", label: "FY2025" } };

const STATE = vi.hoisted(() => ({
  company: null as null | { id: string; name: string; period: { id: string; label: string } },
}));

vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => STATE.company!.period,
}));
vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: STATE.company!.period.id, status: "ready" }),
}));
vi.mock("@/lib/org", () => {
  const org = () => ({
    id: STATE.company!.id, name: STATE.company!.name, industry_key: null,
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

/** THE DOUBLE: org_prefs rows by org_id, and set_org_pref's `||` merge. */
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
  }),
  supabaseEnabled: true,
}));

const REPO = resolve(__dirname, "../../../..");
const SERVED = () =>
  JSON.parse(
    readFileSync(resolve(REPO, "tests/engine/fixtures/forecast/fp1_2_agras_served.json"), "utf8"),
  );
const CATALOGUE = JSON.parse(
  readFileSync(resolve(REPO, "tests/engine/fixtures/forecast/scenario_catalogue.json"), "utf8"),
);

const forecastScenario = vi.fn();
vi.mock("@/lib/cfoApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cfoApi")>("@/lib/cfoApi");
  return {
    ...actual,
    cfoApi: {
      forecastScenario: (...args: unknown[]) => forecastScenario(...args),
      forecastScenarioTemplates: async () => CATALOGUE,
    },
  };
});

function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Scenarios />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, client, rerenderPage: () => result.rerender(tree()) };
}

async function saveAs(name: string, templateId: string) {
  await screen.findByTestId("scenarios-outcome-table");
  fireEvent.click(screen.getByTestId(`scenarios-template-${templateId}`));
  await screen.findByTestId("scenarios-saved");
  fireEvent.change(screen.getByTestId("scenarios-save-name"), { target: { value: name } });
  fireEvent.click(screen.getByTestId("scenarios-save"));
  await waitFor(() => expect(screen.getByTestId("scenarios-saved-list").textContent).toContain(name));
}

const listed = () => screen.queryByTestId("scenarios-saved-list")?.textContent ?? "";

beforeEach(async () => {
  await i18n.changeLanguage("en");
  DB.orgPrefs.clear();
  DB.rpcCalls.length = 0;
  STATE.company = SCANDIA;
  forecastScenario.mockReset();
  forecastScenario.mockImplementation(async () => SERVED());
});

afterEach(() => cleanup());

describe("gate F6: a saved scenario survives reload and belongs to its company", () => {
  it("saves into the company on screen, and a reload lists it", async () => {
    const first = mount();
    await saveAs("Downturn 2026", "recession");
    const write = DB.rpcCalls.find((c) => c.fn === "set_org_pref");
    expect(write?.args.p_org_id).toBe(SCANDIA.id);
    expect(write?.args.p_key).toBe("scenarios");
    first.unmount();

    // RELOAD: a fresh query cache and a fresh page; only the double's rows remain.
    mount();
    await screen.findByTestId("scenarios-saved-list");
    expect(listed()).toContain("Downturn 2026");
  });

  it("a Scandia scenario never shows on Agras — fresh load, and switch inside one session", async () => {
    const page = mount();
    await saveAs("Scandia only", "recession");
    // Switch company INSIDE the same session (same query client), as a
    // workspace switch does before its cache clear lands.
    STATE.company = AGRAS;
    page.rerenderPage();
    await waitFor(() => expect(screen.getByTestId("scenarios-saved").getAttribute("data-org-id")).toBe(AGRAS.id));
    await screen.findByTestId("scenarios-saved-empty");
    expect(document.body.textContent).not.toContain("Scandia only");
    page.unmount();

    mount();
    await screen.findByTestId("scenarios-saved-empty");
    expect(document.body.textContent).not.toContain("Scandia only");
    expect(DB.orgPrefs.get(AGRAS.id)).toBeUndefined();
  });

  it("an entry naming another company is never listed, even inside this company's bag", async () => {
    DB.orgPrefs.set(SCANDIA.id, {
      scenarios: [
        { id: "x1", name: "Agras leak", orgId: AGRAS.id, templateId: "base", overrides: {},
          periodId: null, periodLabel: null, savedAt: "2026-09-20T00:00:00Z" },
        { id: "x2", name: "Scandia own", orgId: SCANDIA.id, templateId: "base", overrides: {},
          periodId: null, periodLabel: null, savedAt: "2026-09-20T00:00:00Z" },
      ],
    });
    mount();
    await screen.findByTestId("scenarios-saved-list");
    expect(listed()).toContain("Scandia own");
    expect(listed()).not.toContain("Agras leak");
  });

  it("opening a saved scenario sends its saved template and levers back to the engine", async () => {
    DB.orgPrefs.set(SCANDIA.id, {
      scenarios: [
        { id: "y1", name: "Slow payers", orgId: SCANDIA.id, templateId: "working_capital_squeeze",
          overrides: { dso_days: { values: ["60", null, null, null, null] } },
          periodId: SCANDIA.period.id, periodLabel: "FY2025", savedAt: "2026-09-20T00:00:00Z" },
      ],
    });
    mount();
    await screen.findByTestId("scenarios-saved-list");
    fireEvent.click(screen.getByTestId("scenarios-saved-open-y1"));
    await waitFor(() =>
      expect(forecastScenario.mock.calls.some((c) => (c[1] as { template: string }).template === "working_capital_squeeze")).toBe(true),
    );
    const sent = forecastScenario.mock.calls
      .map((c) => c[1] as { template: string; overrides: Record<string, unknown> })
      .filter((b) => b.template === "working_capital_squeeze");
    expect(sent[sent.length - 1].overrides).toEqual({ dso_days: { values: ["60", null, null, null, null] } });
    expect(screen.getByTestId("scenarios-template-working_capital_squeeze")).toHaveAttribute("aria-pressed", "true");
  });
});
