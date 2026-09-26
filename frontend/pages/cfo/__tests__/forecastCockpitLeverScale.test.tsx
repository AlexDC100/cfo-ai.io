// @vitest-environment jsdom
/**
 * GATE forecast-cockpit-lever-scale — A SLIDER'S SCALE IS FIXED; A POSITION IS
 * A DECIMAL.
 *
 * THE DEFECT (the verifier's repro, 2026-09-26, over the real engine): the
 * page derived a slider's tick scale from the decimals of every ANSWER's
 * value (`places = max(decimals(min, max, step, value))`). A lever whose
 * measured default carries more decimals than its step — the measured growth
 * (six decimals), DSO/DIO/DPO, the interest rate, capex: the primary lever on
 * every real book — stood at scale 10^6; after one honest move the engine answered
 * with the moved value ("0.05", two decimals), the scale became 10^3, the
 * input's min/max/step changed under the thumb (±300000/1000 → ±300/1), the
 * value text read "5.000 %", and the STORED position (50000 ticks) was
 * re-read at the new scale: the next move of ANY other slider sent
 * revenue_growth "50" → 422 lever_out_of_range → the stale-figures banner;
 * "Save my case" persisted the corrupt decimal; DSO 40 read "4.000.000 zile"
 * and the next move sent dso_days "4000000".
 *
 * THE RULE HELD HERE: the scale is the lever's FIXED property — the pack's
 * `decimals`, served by the engine on every lever (gate F10) — never derived
 * from an answer; a position is held as the exact decimal the wire carries
 * and ticks are derived at render; a saved case stores the wire decimal.
 *
 * TWO ENGINE DOUBLES, both refusing out of range in the engine's own words:
 *   · SYNTHETIC (syntheticCockpit.ts) with six-decimal served defaults — the
 *     class that flipped; the double answers ANY in-range body;
 *   · CAPTURED — the real route's bytes for exactly the verifier's requests
 *     (tests/engine/fixtures/forecast/cockpit_agras_*.json, pinned to the
 *     route by test_c_the_committed_cockpit_fixtures_are_what_the_route_serves;
 *     and, opt-in and never committed, the owner's local pair through
 *     FORECAST_LOCAL_COCKPIT_FIXTURES=<dir>, written by
 *     scripts/gen_cockpit_fixtures.py --book scandia_local --out <dir>).
 *     A body the engine was never asked for has NO answer here: a drifted
 *     decimal is a red, not a re-interpretation.
 *
 * RED ON (TC-11): an input's min/max/step or its decimals changing after an
 * answer; the value text after an answer not being the ENGINE's display; the
 * request after a second lever's move not carrying the first lever's original
 * decimal (the double has no answer for it); the engine refusing the second
 * move; a saved case whose decimals are not the wire decimals inside the
 * served range; a lever's scale differing between two answers.
 * CANNOT SEE: pixels and a real drag (the walk over the harness engine,
 * specs-durable/cockpit_harness/shots.mjs `cockpit-slider-scale`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import Forecast from "../Forecast";
import { CfoApiError } from "@/lib/cfoApi";
import { SYNTH_COMPANY, syntheticCockpit } from "@/components/forecast/cockpit/__tests__/syntheticCockpit";

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
vi.mock("@/lib/reportPdf", () => ({ requestReportPdf: vi.fn(), saveReportPdf: vi.fn() }));

type Body = { case_id: string; levers: Record<string, string> };
const cockpitCall = vi.fn();
vi.mock("@/lib/cfoApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cfoApi")>("@/lib/cfoApi");
  return {
    ...actual,
    cfoApi: {
      forecastCockpit: (...a: unknown[]) => cockpitCall(...a),
      forecastCockpitExport: async () => {
        throw new Error("not exercised here");
      },
    },
  };
});

// ── the engine doubles ───────────────────────────────────────────────────

interface ServedLever {
  id: string;
  decimals: number;
  range: { min: string; max: string; step: string };
  display: { ro: string; en: string } | null;
  value: string | string[] | null;
}
type Payload = Record<string, unknown> & { levers: ServedLever[] };

const DECIMAL = /^-?\d+(\.\d+)?$/;
const leverOf = (p: Payload, id: string): ServedLever => {
  const l = p.levers.find((x) => x.id === id);
  if (!l) throw new Error(`the served cockpit has no lever ${id}`);
  return l;
};
/** A lever DECIMAL (never money) as ticks at the lever's fixed scale — what
 *  the test types into the range input, computed from the SERVED decimals. */
const ticksOf = (decimal: string, decimals: number) => String(Math.round(Number(decimal) * 10 ** decimals));

/** THE ENGINE'S RANGE CHECK in its own words (packs/forecast/cockpit.yaml
 *  #refusals), thrown the way cfoApi surfaces a 422 — so a position that
 *  drifted out of range is refused exactly as the route would refuse it. */
function refuseLikeTheEngine(base: Payload, body: Body): void {
  for (const [id, decimal] of Object.entries(body.levers)) {
    const lever = base.levers.find((l) => l.id === id);
    if (!lever) {
      throw new CfoApiError("refused", 422, { code: "unknown_lever", text: `${id} is not a lever of this cockpit`, field: id });
    }
    if (!DECIMAL.test(decimal)) {
      throw new CfoApiError("refused", 422, { code: "not_decimal", text: `${id}: ${decimal} is not a decimal string`, field: id });
    }
    const v = Number(decimal);
    if (v < Number(lever.range.min) || v > Number(lever.range.max)) {
      throw new CfoApiError("refused", 422, {
        code: "lever_out_of_range",
        text: `${id}: ${decimal} is outside ${lever.range.min} to ${lever.range.max}`,
        field: id,
      });
    }
  }
}

interface Engine {
  readonly label: string;
  readonly base: Payload;
  answer(body: Body): Payload;
}

/** The synthetic book, with the six-decimal served defaults the real engine
 *  measures: the class that flipped scale. Any in-range body is answered. */
const SYNTH_DEFAULTS = { revenue_growth: "-0.041237", dso_days: "38.41667", interest_rate: "0.0761234", capex: "0.031452" };
function syntheticEngine(): Engine {
  const opts = (body: Body) => ({ caseId: body.case_id, levers: body.levers, defaults: SYNTH_DEFAULTS, seed: Object.keys(body.levers).length });
  const base = syntheticCockpit(opts({ case_id: "base", levers: {} })) as unknown as Payload;
  return {
    label: "synthetic (six-decimal defaults)",
    base,
    answer(body) {
      if (body.case_id.startsWith("saved:")) {
        const stored = savedLevers(body.case_id);
        return syntheticCockpit({ ...opts({ case_id: "base", levers: stored }), savedName: "Cazul meu" }) as unknown as Payload;
      }
      refuseLikeTheEngine(base, body);
      return syntheticCockpit(opts(body)) as unknown as Payload;
    },
  };
}

/** The saved case the page just wrote, as the engine would read it from
 *  this company's prefs row: id → its lever set (year-one value per lever). */
function savedLevers(caseId: string): Record<string, string> {
  const id = caseId.slice("saved:".length);
  const list = (DB.orgPrefs.get(STATE.company.id)?.forecast_cases ?? []) as Array<Record<string, unknown>>;
  const entry = list.find((e) => e.id === id);
  if (!entry) throw new CfoApiError("refused", 404, { code: "case_not_found", text: `no saved case ${caseId}`, field: "case_id" });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry.levers as Record<string, string | string[]>)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** The verifier's requests, as captured from the REAL route
 *  (tests/engine/test_forecast_cockpit.py FIXTURE_REQUESTS). */
const CAPTURED_REQUESTS: Array<[string, Body]> = [
  ["base", { case_id: "base", levers: {} }],
  ["growth", { case_id: "base", levers: { revenue_growth: "0.05" } }],
  ["growth_inflation", { case_id: "base", levers: { inflation: "0.03", revenue_growth: "0.05" } }],
  ["dso", { case_id: "base", levers: { dso_days: "40" } }],
  ["dso_dio", { case_id: "base", levers: { dio_days: "50", dso_days: "40" } }],
];
const sameBody = (a: Body, b: Body) =>
  a.case_id === b.case_id && JSON.stringify(Object.entries(a.levers).sort()) === JSON.stringify(Object.entries(b.levers).sort());

function capturedEngine(label: string, dir: string, book: string): Engine {
  const captures = CAPTURED_REQUESTS.map(([name, body]) => {
    const path = resolve(dir, `cockpit_${book}_${name}.json`);
    expect(existsSync(path), `${label}: ${path} is missing — regenerate with scripts/gen_cockpit_fixtures.py`).toBe(true);
    return { body, payload: JSON.parse(readFileSync(path, "utf8")) as Payload };
  });
  const base = captures[0].payload;
  return {
    label,
    base,
    answer(body) {
      const asked = body.case_id.startsWith("saved:") ? { case_id: "base", levers: savedLevers(body.case_id) } : body;
      const hit = captures.find((c) => sameBody(c.body, asked));
      if (hit) return hit.payload;
      refuseLikeTheEngine(base, asked);
      throw new Error(
        `${label}: the page asked the engine for ${JSON.stringify(asked)}, a position the engine was never asked for ` +
          `— a decimal drifted from the wire form (the captured requests are ${CAPTURED_REQUESTS.map(([n]) => n).join(", ")})`,
      );
    },
  };
}

const REPO = resolve(__dirname, "../../../..");
const ENGINES: Array<() => Engine> = [
  syntheticEngine,
  () => capturedEngine("agras (captured from the real route)", resolve(REPO, "tests/engine/fixtures/forecast"), "agras"),
];
const LOCAL = process.env.FORECAST_LOCAL_COCKPIT_FIXTURES;
if (LOCAL && existsSync(LOCAL)) {
  for (const f of readdirSync(LOCAL)) {
    const m = /^cockpit_(.+)_base\.json$/.exec(f);
    if (m) ENGINES.push(() => capturedEngine(`${m[1]} (local capture, never committed)`, LOCAL, m[1]));
  }
}

// ── the page ─────────────────────────────────────────────────────────────

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

const lastBody = () => cockpitCall.mock.calls[cockpitCall.mock.calls.length - 1][1] as Body;
const input = (id: string) => screen.getByTestId(`cockpit-lever-${id}-input`) as HTMLInputElement;
const attrs = (el: HTMLInputElement) => ({
  min: el.getAttribute("min"),
  max: el.getAttribute("max"),
  step: el.getAttribute("step"),
  decimals: el.getAttribute("data-decimals"),
});
const text = (id: string) => (screen.getByTestId(`cockpit-lever-${id}-value`).textContent ?? "").replace(/ /g, " ");
const settled = async (calls: number) => {
  await waitFor(() => expect(cockpitCall).toHaveBeenCalledTimes(calls), { timeout: 4000 });
  await waitFor(() => expect(screen.getByTestId("forecast-cockpit").getAttribute("data-recomputing")).toBe("false"), {
    timeout: 4000,
  });
};
const move = (id: string, ticks: string) => fireEvent.change(input(id), { target: { value: ticks } });

let answers: Payload[] = [];
function install(engine: Engine) {
  answers = [];
  cockpitCall.mockImplementation(async (_id: string, body: Body) => {
    const payload = engine.answer(body);
    answers.push(payload);
    return payload;
  });
}
const lastAnswer = () => answers[answers.length - 1];

beforeEach(async () => {
  await i18n.changeLanguage("en");
  STATE.company = { id: "org-exemplu", name: SYNTH_COMPANY };
  STATE.period = { id: "p-synth", label: "FY2025" };
  DB.orgPrefs.clear();
  DB.rpcCalls.length = 0;
  cockpitCall.mockReset();
});
afterEach(() => cleanup());

describe.each(ENGINES.map((make) => [make().label, make] as const))("%s", (_label, make) => {
  it("growth +5 % then inflation 3 %: the growth input keeps its scale, shows the engine's display, and the second request carries '0.05' — the engine answers 200; the saved case stores the wire decimals", async () => {
    const engine = make();
    install(engine);
    wrap();
    await screen.findByTestId("cockpit-levers");
    await settled(1);
    const growthSpec = leverOf(engine.base, "revenue_growth");
    const inflationSpec = leverOf(engine.base, "inflation");
    const growth = input("revenue_growth");
    const before = attrs(growth);
    const everyLeverBefore = engine.base.levers.map((l) => [l.id, screen.queryByTestId(`cockpit-lever-${l.id}-input`)] as const)
      .filter((x): x is readonly [string, HTMLInputElement] => x[1] !== null)
      .map(([id, el]) => [id, attrs(el)] as const);

    // A: the reader sets growth to +5 % (ticks at the lever's SERVED decimals)
    move("revenue_growth", ticksOf("0.05", growthSpec.decimals));
    await settled(2);
    expect(lastBody()).toEqual({ case_id: "base", levers: { revenue_growth: "0.05" } });
    // the answer did not move the scale under the thumb …
    expect(attrs(growth), "the growth input's min/max/step changed after the engine answered").toEqual(before);
    expect(growth.value).toBe(ticksOf("0.05", growthSpec.decimals));
    // … and the value beside the slider is the ENGINE's own display
    expect(text("revenue_growth")).toBe(leverOf(lastAnswer(), "revenue_growth").display?.en);
    expect(screen.getByTestId("cockpit-lever-revenue_growth-value").getAttribute("data-pending")).toBe("false");

    // B: the reader moves ANOTHER lever; the request still carries A's decimal
    move("inflation", ticksOf("0.03", inflationSpec.decimals));
    await settled(3);
    expect(lastBody()).toEqual({ case_id: "base", levers: { inflation: "0.03", revenue_growth: "0.05" } });
    expect(screen.queryByTestId("forecast-stale-notice"), "the engine refused the second move").toBeNull();
    expect(attrs(growth)).toEqual(before);
    expect(text("revenue_growth")).toBe(leverOf(lastAnswer(), "revenue_growth").display?.en);
    expect(text("inflation")).toBe(leverOf(lastAnswer(), "inflation").display?.en);
    // no lever's scale moved between the three answers
    for (const [id, was] of everyLeverBefore) expect(attrs(input(id)), `${id}'s scale changed between answers`).toEqual(was);
    // the scale IS the served decimals, on every lever
    for (const l of engine.base.levers) {
      const el = screen.queryByTestId(`cockpit-lever-${l.id}-input`);
      if (el) expect(el.getAttribute("data-decimals"), l.id).toBe(String(l.decimals));
    }

    // "Save my case": the wire decimals, each inside the served range
    fireEvent.click(screen.getByTestId("cockpit-save"));
    fireEvent.change(screen.getByTestId("cockpit-save-name"), { target: { value: "Cazul meu" } });
    fireEvent.click(screen.getByTestId("cockpit-save-confirm"));
    await waitFor(() => expect(DB.rpcCalls).toHaveLength(1));
    const stored = (DB.rpcCalls[0].args.p_value as Array<{ levers: Record<string, string | string[]> }>)[0].levers;
    expect(stored.revenue_growth).toBe("0.05");
    expect(stored.inflation).toBe("0.03");
    for (const [id, v] of Object.entries(stored)) {
      const spec = leverOf(engine.base, id);
      for (const d of Array.isArray(v) ? v : [v]) {
        expect(d, `${id}: ${d} is not a decimal`).toMatch(DECIMAL);
        expect(Number(d) >= Number(spec.range.min) && Number(d) <= Number(spec.range.max), `${id}: ${d} is outside ${spec.range.min}..${spec.range.max}`).toBe(true);
      }
    }
    // opening the saved case is a 200 too (the engine reads the same decimals)
    await waitFor(() => expect(lastBody().case_id).toMatch(/^saved:/));
    await waitFor(() => expect(screen.getByTestId("forecast-cockpit").getAttribute("data-recomputing")).toBe("false"));
    expect(screen.queryByTestId("forecast-stale-notice")).toBeNull();
  });

  it("DSO 40 days then DIO: the DSO input keeps its scale, reads the engine's display, and the DIO request carries dso_days '40' — 200", async () => {
    const engine = make();
    install(engine);
    wrap();
    await screen.findByTestId("cockpit-levers");
    await settled(1);
    fireEvent.click(screen.getByTestId("cockpit-levers-more"));
    const dsoSpec = leverOf(engine.base, "dso_days");
    const dioSpec = leverOf(engine.base, "dio_days");
    const dso = input("dso_days");
    const before = attrs(dso);
    move("dso_days", ticksOf("40", dsoSpec.decimals));
    await settled(2);
    expect(lastBody()).toEqual({ case_id: "base", levers: { dso_days: "40" } });
    expect(attrs(dso), "the DSO input's min/max/step changed after the engine answered").toEqual(before);
    expect(dso.value).toBe(ticksOf("40", dsoSpec.decimals));
    expect(text("dso_days")).toBe(leverOf(lastAnswer(), "dso_days").display?.en);
    move("dio_days", ticksOf("50", dioSpec.decimals));
    await settled(3);
    expect(lastBody()).toEqual({ case_id: "base", levers: { dio_days: "50", dso_days: "40" } });
    expect(screen.queryByTestId("forecast-stale-notice"), "the engine refused the DIO move").toBeNull();
    expect(attrs(dso)).toEqual(before);
    expect(text("dso_days")).toBe(leverOf(lastAnswer(), "dso_days").display?.en);
    expect(text("dio_days")).toBe(leverOf(lastAnswer(), "dio_days").display?.en);
    expect(dso.getAttribute("data-decimals")).toBe(String(dsoSpec.decimals));
  });
});

describe("the engines this gate runs over", () => {
  it("names at least the synthetic book and the agras capture (a vacuous roster is a broken gate)", () => {
    expect(ENGINES.length).toBeGreaterThanOrEqual(2);
    console.log(`GATE-WORK forecast-cockpit-lever-scale engines=${ENGINES.length}: ${ENGINES.map((m) => m().label).join(" · ")}`);
  });
});
