// cmdbar-switch — a company or a period switch paints NOTHING of what was
// left behind under the new header, and asks the engine nothing that pairs
// one company with another company's period.
//
// THE DEFECT (review of stage CB-H; workspace-v2 G6 on the hermetic bundle,
// 8 of 40 runs red on this branch, 20 of 20 green on 69fb9621). The app's
// query client keeps the PREVIOUS key's data on screen while a new key
// loads (`placeholderData: keepPreviousData`, lib/queryClient.ts). The bar's
// documents are keyed by (company, period), but the bar READ whatever the
// observer held: across Scandia → Agras it painted Scandia's "Ce contează
// acum" items and sector positions under "Searching Agras SRL", and a
// placeholder Scandia body read as "ready" for Agras's period asked
// `GET /api/period/<Agras>/comparatives?prior=<Scandia>` under Scandia's
// X-Org-Id. Every earlier jsdom law built its QueryClient WITHOUT the app's
// defaults, so none of them could see a placeholder.
//
// THIS LAW runs the REAL palette (and the AppShell prefetch beside it) on a
// QueryClient with the APP's own default options, and walks the switch the
// way the app performs it (lib/org.ts): the workspace holder names the new
// company first, the cache is cleared, the URL moves (company page, then
// its dashboard link), the palette's `useActiveOrg()` catches up LATER, the
// new period body lands, and the new company's documents land last. Every
// React commit of the bar is a frame (a Profiler's onRender runs after the
// DOM is mutated): under a header "Searching X · month", every figure,
// served chip, key metric and context a row carries must be one that X's
// own documents print for that month (collected by mounting X alone); under
// any other header ("loading", "another company") no row carries anything.
// Every request, and every period body the bar asks for, is held to the
// period → company map: no company is asked about another's period, and
// after the switch nothing names a period of the company left behind.
//
// Positive controls: the frames before the switch painted the first
// company's figures, the last frame paints the new company's own items,
// and the two companies' figure sets differ by ≥ 3 carriers — so an empty
// or vacuous run is red, not green.

import { Profiler, type ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import i18n from "@/i18n";
import { queryClient as appQueryClient } from "@/lib/queryClient";
import { clearActiveOrg, setActiveOrgId } from "@/lib/activeOrg";

const REPO = resolve(__dirname, "../../../../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf-8"));

const SCANDIA = read("e2e/fixtures/workspace_v2/scandia_fy2025.json");
const AGRAS = read("e2e/fixtures/workspace_v2/agras_fy2025.json");
const ATT = {
  scandia: read("frontend/lib/__tests__/fixtures/attention/scandia.attention.json"),
  agras: read("frontend/lib/__tests__/fixtures/attention/agras.attention.json"),
};
const SECTOR = {
  scandia: read("frontend/lib/__tests__/fixtures/attention/scandia.sector.json"),
  agras: read("frontend/lib/__tests__/fixtures/attention/agras.sector.json"),
};

const USER = "user-under-test";

// ── host context (provided) ─────────────────────────────────────────────

type Org = { id: string; name: string; industry_key: string | null };

const H = vi.hoisted(() => {
  const gates = new Map<string, (v: unknown) => void>();
  return {
    org: null as null | { id: string; name: string; industry_key: string | null },
    orgs: [] as { id: string; name: string; industry_key: string | null }[],
    /** What the header's month stepper lists — it lags a switch like every
     *  other `useActiveOrg` reader (the pre-fix bar took its period here). */
    periods: [] as { period_id: string; period_end: string | null }[],
    /** Every period body the bar asked for, in order. */
    periodAsks: [] as string[],
    /** A period body is answered when the test says so (release()). */
    gates,
  };
});

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "user-under-test" }, status: "signed_in" }) }));
vi.mock("@/lib/apiHeaders", () => ({ authOrgHeaders: async () => ({ Authorization: "Bearer test" }) }));
vi.mock("@/lib/org", async (orig) => ({
  ...(await orig<typeof import("@/lib/org")>()),
  useActiveOrg: () => ({ org: H.org, orgs: H.orgs, archived: [], loading: false, loadError: false }),
}));
vi.mock("@/lib/activePeriod", async (orig) => ({
  ...(await orig<typeof import("@/lib/activePeriod")>()),
  fetchPeriodFromApi: (id: string) => {
    H.periodAsks.push(id);
    return new Promise((res) => { H.gates.set(id, res); });
  },
}));
vi.mock("@/lib/usePeriodStepper", () => ({
  usePeriodStepper: () => ({
    periods: H.periods, selectedEnd: H.periods[0]?.period_end ?? null, selectedMonth: null,
    selectedYear: null, prevTarget: null, nextTarget: null, showStepper: false, goToPeriod: () => {},
  }),
}));
vi.mock("@/lib/workspaces", () => ({ useWorkspaces: () => ({ select: () => Promise.resolve() }) }));
vi.mock("@/lib/previewFeatures", () => ({ useUploadRoute: (legacy: string) => legacy }));
vi.mock("@/lib/features", async (orig) => ({
  ...(await orig<typeof import("@/lib/features")>()),
  useFeatureStatus: (k: string) => (k === "forecast" ? "coming_soon" : "active"),
}));
vi.mock("@/components/cfo/Sidebar", () => ({
  useShellNav: () => [{ key: "core", label: "Core", items: [{ to: "/dashboard", labelKey: "sidebar.dashboard" }] }],
  SIDEBAR_TOGGLE_EVENT: "cfo-ai-sidebar-toggle",
}));

import { CommandPalette } from "../CommandPalette";
import { CommandBarPrefetch, cmdbarSectorQueryKey } from "../cmdbar/useCmdbarData";
import { RECENTS_KEY_PREFIX } from "../cmdbar/cmdbarRecents";

// ── the worlds ──────────────────────────────────────────────────────────

const ORG_S: Org = { id: SCANDIA.period.organization.id, name: SCANDIA.period.organization.name, industry_key: "food_manufacturing" };
const ORG_A: Org = { id: AGRAS.period.organization.id, name: AGRAS.period.organization.name, industry_key: "food_manufacturing" };
const S25 = SCANDIA.period.period.id as string;
const A25 = AGRAS.period.period.id as string;
/** A second, earlier period of Scandia — the period-switch world. Its book
 *  is the Agras capture re-homed (a different book, so different figures),
 *  named by Scandia and by its own id and year end in every document. */
const S24 = "5ea50000-0000-4000-8000-0000000051f4";

interface PeriodWorld {
  org: Org;
  id: string;
  end: string;
  body: Record<string, any>;
  attention: Record<string, any>;
  sector: Record<string, any>;
}

function rehome(body: Record<string, any>, org: Org, id: string, end: string) {
  return { ...body, organization: { ...body.organization, id: org.id, name: org.name }, period: { ...body.period, id, period_end: end } };
}

const W: Record<"S25" | "S24" | "A25", PeriodWorld> = {
  S25: { org: ORG_S, id: S25, end: "2025-12-31", body: SCANDIA.period, attention: ATT.scandia, sector: SECTOR.scandia },
  A25: { org: ORG_A, id: A25, end: "2025-12-31", body: AGRAS.period, attention: ATT.agras, sector: SECTOR.agras },
  S24: {
    org: ORG_S, id: S24, end: "2024-12-31",
    body: rehome(AGRAS.period, ORG_S, S24, "2024-12-31"),
    attention: { ...ATT.agras, period: { ...ATT.agras.period, id: S24, org_id: ORG_S.id, company_name: ORG_S.name, period_end: "2024-12-31", label: "2024-12-31" } },
    sector: { ...SECTOR.agras, period: { ...SECTOR.agras.period, id: S24, period_end: "2024-12-31" } },
  },
};
/** Which company each period belongs to — the request law's authority. */
const OWNER: Record<string, string> = { [S25]: ORG_S.id, [S24]: ORG_S.id, [A25]: ORG_A.id };

const listOf = (org: Org, periods: PeriodWorld[]) => ({
  orgId: org.id,
  periods: periods.map((p) => ({ period_id: p.id, period_end: p.end, period_start: null, period_label: "", documents: [{ id: `d-${p.id}` }] })),
});
const COMPANY_PERIODS: Record<string, PeriodWorld[]> = { [ORG_S.id]: [W.S25, W.S24], [ORG_A.id]: [W.A25] };

// ── the fetch trap: recorded with the company asked, never answered ─────

let fetched: { url: string; org: string | null }[] = [];
let savedFetch: unknown;

beforeEach(async () => {
  fetched = [];
  H.periodAsks = [];
  H.gates.clear();
  const g = globalThis as unknown as Record<string, unknown>;
  savedFetch = g.fetch;
  g.fetch = (input: unknown, init?: { headers?: Record<string, string> }) => {
    fetched.push({
      url: typeof input === "string" ? input : String((input as { url?: string })?.url ?? input),
      org: init?.headers?.["X-Org-Id"] ?? null,
    });
    return new Promise(() => {});
  };
  try { window.localStorage.clear(); } catch { /* shim */ }
  await act(async () => { await i18n.changeLanguage("en"); });
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).fetch = savedFetch;
  cleanup();
  clearActiveOrg();
});

/** The APP's query defaults — keepPreviousData included — with no retry. */
function appClient(): QueryClient {
  const d = appQueryClient.getDefaultOptions();
  return new QueryClient({ defaultOptions: { ...d, queries: { ...d.queries, retry: false } } });
}

function seedPeriod(qc: QueryClient, w: PeriodWorld) {
  qc.setQueryData(["period", w.id], { kind: "ok", data: w.body });
}
function seedCompany(qc: QueryClient, org: Org) {
  qc.setQueryData(["periods-with-documents", "company", org.id], listOf(org, COMPANY_PERIODS[org.id]));
  qc.setQueryData(["company-years", org.id], COMPANY_PERIODS[org.id].map((p) => ({
    period_id: p.id, year: Number(p.end.slice(0, 4)), period_end: p.end, revenue: null, revenue_change_pct: null,
  })));
}
function seedDocs(qc: QueryClient, w: PeriodWorld) {
  qc.setQueryData(cmdbarSectorQueryKey(w.org.id, w.id), w.sector);
  qc.setQueryData(["attention", w.org.id, w.id, "auto"], { kind: "ok", data: w.attention });
}

/** Each company's recent picks on this device (labels and links, never a
 *  figure — but a link names ITS company's period). */
const RECENT: Record<string, { id: string; group: string; label: string; href: string }> = {
  [ORG_S.id]: { id: "account:411121:ar", group: "account", label: "411121 Scandia pick", href: `/dashboard?period=${S25}&org=${ORG_S.id}&account=411121` },
  [ORG_A.id]: { id: "page:tab:pl", group: "page", label: "Agras pick", href: `/dashboard?period=${A25}&org=${ORG_A.id}&tab=pl` },
};
function seedRecents() {
  for (const [org, r] of Object.entries(RECENT)) window.localStorage.setItem(`${RECENTS_KEY_PREFIX}${org}`, JSON.stringify([r]));
}

/** Several macrotask turns inside act: queries schedule, every fetch awaits
 *  its headers, results commit. */
async function flush(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

// ── frames ──────────────────────────────────────────────────────────────

interface Frame { step: string; header: string | null; carriers: string[]; yearRows: string[]; recents: string[] }

let frames: Frame[] = [];
let step = "mount";

/** What a row carries that is a figure or a served judgement: the figure,
 *  a served chip, the key metric, the context — each with its row. */
const CARRIERS = '[data-figure], [data-chip-state="ok"], [data-key-metric], [data-context]';

function snapshot(): Frame {
  const scope = document.querySelector('[data-testid="cmdbar-scope"]');
  if (!scope) return { step, header: null, carriers: [], yearRows: [], recents: [] };
  const bar = document.querySelector('[data-testid="cmdbar"]')!;
  const carriers = [...bar.querySelectorAll(CARRIERS)].map((el) => {
    const row = el.closest("[data-row-id]")?.getAttribute("data-row-id") ?? "?";
    const kind = ["data-figure", "data-chip-state", "data-key-metric", "data-context"].find((a) => el.hasAttribute(a));
    return `${row} | ${kind} | ${el.textContent ?? ""}`;
  });
  const yearRows = [...bar.querySelectorAll('[data-row-id^="page:year:"]')].map((el) => el.getAttribute("data-row-id")!);
  const recents = [...bar.querySelectorAll('[data-row-kind="recent"]')].map((el) => el.getAttribute("data-row-id")!);
  return { step, header: scope.textContent ?? "", carriers, yearRows, recents };
}

function onCommit() {
  frames.push(snapshot());
}

let navigate: ((to: string) => void) | null = null;
function NavigateProbe() {
  const n = useNavigate();
  navigate = (to: string) => n(to);
  return null;
}

function tree(qc: QueryClient, open: boolean, url: string): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Profiler id="cmdbar" onRender={onCommit}>
          <CommandBarPrefetch />
          <CommandPalette open={open} onOpenChange={() => {}} onOpenAi={() => {}} />
        </Profiler>
        <NavigateProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function type(q: string) {
  fireEvent.change(screen.getByTestId("capsule-composer"), { target: { value: q } });
}

/** What X's OWN documents paint, per header: X mounted alone, every document
 *  of its period in the cache, at rest and (when the run types) typed. */
async function steadyState(w: PeriodWorld, query: string): Promise<{ header: string; carriers: Set<string> }> {
  const qc = appClient();
  seedPeriod(qc, w);
  seedCompany(qc, w.org);
  seedDocs(qc, w);
  H.org = w.org;
  H.orgs = [ORG_S, ORG_A];
  H.periods = COMPANY_PERIODS[w.org.id].map((p) => ({ period_id: p.id, period_end: p.end }));
  setActiveOrgId(USER, w.org.id);
  seedRecents();
  const utils = render(tree(qc, true, `/dashboard?period=${w.id}&org=${w.org.id}`));
  await flush();
  const rest = snapshot();
  const carriers = new Set(rest.carriers);
  if (query) {
    type(query);
    await flush();
    const typed = snapshot();
    expect(typed.header).toBe(rest.header);
    typed.carriers.forEach((c) => carriers.add(c));
  }
  utils.unmount();
  return { header: rest.header ?? "", carriers };
}

async function allowedFor(worlds: PeriodWorld[], query: string) {
  const byHeader = new Map<string, Set<string>>();
  for (const w of worlds) {
    const s = await steadyState(w, query);
    expect(s.carriers.size, `POSITIVE CONTROL: ${w.org.name} ${w.end} paints figures ("${query}")`).toBeGreaterThanOrEqual(3);
    byHeader.set(s.header, s.carriers);
  }
  return byHeader;
}

/** Every frame's carriers belong to the header it was painted under. */
function foreignPaint(byHeader: Map<string, Set<string>>): string[] {
  const out: string[] = [];
  for (const f of frames) {
    if (f.header === null) continue;
    const allowed = byHeader.get(f.header);
    for (const c of f.carriers) {
      if (!allowed || !allowed.has(c)) out.push(`[${f.step}] "${f.header}" painted ${c}`);
    }
    // A recent pick is shown only under the header of the company it was
    // picked in (its link names that company's period).
    const named = [ORG_S, ORG_A].find((o) => f.header!.includes(o.name));
    for (const id of f.recents) {
      if (!named || id !== `recent:${RECENT[named.id].id}`) out.push(`[${f.step}] "${f.header}" shows another company's recent pick ${id}`);
    }
    for (const id of f.yearRows) {
      const [, , org, period] = id.split(":");
      if (OWNER[period] && OWNER[period] !== org) out.push(`[${f.step}] "${f.header}" links ${org}'s year to another company's period: ${id}`);
    }
  }
  return out;
}

/** The periods a request names (in its path or its ?prior=). */
function periodsIn(url: string): string[] {
  return Object.keys(OWNER).filter((p) => url.includes(p));
}

/** No request asks one company about another company's period; after
 *  `from`, nothing names a period of `left` at all. */
function requestViolations(from: number, left: string | null): string[] {
  const out: string[] = [];
  fetched.forEach((r, i) => {
    const named = periodsIn(r.url);
    const foreign = r.org ? named.filter((p) => OWNER[p] !== r.org) : [];
    if (foreign.length) out.push(`asked ${r.org} about another company's period: ${r.url}`);
    if (left && i >= from && named.some((p) => OWNER[p] === left)) out.push(`after the switch, named the company left behind: ${r.url} (as ${r.org})`);
  });
  return out;
}

// ════════════════════════════════════════════════════════════════════════

describe("cmdbar-switch — Scandia → Agras: nothing of Scandia under Agras's header, no cross-company request", () => {
  for (const variant of [
    { name: "the bar open, at rest", open: true, query: "" },
    { name: "the bar open, typed 'clienti'", open: true, query: "clienti" },
    { name: "the bar closed through the switch, opened before Agras's documents land", open: false, query: "" },
  ]) {
    it(variant.name, async () => {
      const byHeader = await allowedFor([W.S25, W.A25], variant.query);
      const [sHeader, aHeader] = [...byHeader.keys()];
      const foreignSet = [...byHeader.get(sHeader)!].filter((c) => !byHeader.get(aHeader)!.has(c));
      expect(foreignSet.length, "POSITIVE CONTROL: Scandia paints ≥ 3 carriers Agras does not").toBeGreaterThanOrEqual(3);

      // ── Scandia's dashboard, everything warm ─────────────────────────
      frames = [];
      fetched = [];
      H.periodAsks = [];
      step = "scandia";
      const qc = appClient();
      seedPeriod(qc, W.S25);
      seedCompany(qc, ORG_S);
      seedCompany(qc, ORG_A);
      seedDocs(qc, W.S25);
      H.org = ORG_S;
      H.orgs = [ORG_S, ORG_A];
      H.periods = [{ period_id: S25, period_end: "2025-12-31" }, { period_id: S24, period_end: "2024-12-31" }];
      setActiveOrgId(USER, ORG_S.id);
      seedRecents();
      let open = variant.open;
      let url = `/dashboard?period=${S25}&org=${ORG_S.id}`;
      const utils = render(tree(qc, open, url));
      if (open && variant.query) type(variant.query);
      await flush();
      const before = frames.filter((f) => f.header === sHeader && f.carriers.length > 0).length;
      if (open) expect(before, "POSITIVE CONTROL: Scandia's figures were painted before the switch").toBeGreaterThanOrEqual(1);

      // ── the switch, the way lib/org.ts performs it ───────────────────
      // 1. the holder names Agras, the cache is cleared, the company page opens
      const switchedAt = fetched.length;
      const periodAsksAt = H.periodAsks.length;
      step = "1 holder=Agras, cache cleared, /workspace/<Agras>";
      await act(async () => {
        setActiveOrgId(USER, ORG_A.id);
        qc.clear();
        navigate!(`/workspace/${ORG_A.id}`);
      });
      await flush();
      // 2. the company page's Dashboard link
      step = "2 /dashboard?period=<Agras>&org=<Agras>";
      url = `/dashboard?period=${A25}&org=${ORG_A.id}`;
      await act(async () => { navigate!(url); });
      await flush();
      // 3. the palette's useActiveOrg() re-resolves — the stepper with it
      step = "3 useActiveOrg() = Agras";
      H.org = ORG_A;
      H.periods = [{ period_id: A25, period_end: "2025-12-31" }];
      await act(async () => { utils.rerender(tree(qc, open, url)); });
      await flush();
      // 4. Agras's period body lands (the lists came back too)
      step = "4 Agras's period body";
      seedCompany(qc, ORG_A);
      seedCompany(qc, ORG_S);
      await act(async () => { H.gates.get(A25)?.({ kind: "ok", data: W.A25.body }); });
      await flush();
      if (!open) {
        step = "4b the bar opened";
        open = true;
        await act(async () => { utils.rerender(tree(qc, open, url)); });
        if (variant.query) type(variant.query);
        await flush();
      }
      // 5. Agras's documents land
      step = "5 Agras's documents";
      await act(async () => { seedDocs(qc, W.A25); });
      await flush();

      const paint = foreignPaint(byHeader);
      expect.soft(paint, "a figure painted under a header that is not its company's").toEqual([]);
      const asks = requestViolations(switchedAt, ORG_S.id);
      const bodies = H.periodAsks.slice(periodAsksAt).filter((p) => OWNER[p] === ORG_S.id).map((p) => `the period body of ${p}`);
      expect([...asks, ...bodies], "a request pairing a company with another's period, or naming the company left").toEqual([]);

      // POSITIVE CONTROL: the switch ended on Agras's own figures.
      const last = frames.at(-1)!;
      expect(last.header).toBe(aHeader);
      expect(last.carriers.length).toBeGreaterThanOrEqual(3);
      expect(last.carriers.every((c) => byHeader.get(aHeader)!.has(c))).toBe(true);
      expect(frames.length, "frames observed").toBeGreaterThanOrEqual(6);
      if (!variant.query) {
        expect(frames.some((f) => f.recents.includes(`recent:${RECENT[ORG_S.id].id}`)) || !variant.open,
          "POSITIVE CONTROL: Scandia's recent pick was shown before the switch").toBe(true);
        expect(last.recents, "the switch ends on Agras's own recent picks").toEqual([`recent:${RECENT[ORG_A.id].id}`]);
      }
      console.log(`GATE-WORK cmdbar-switch company "${variant.name}" frames=${frames.length} foreign_carriers=${foreignSet.length} requests=${fetched.length}`);
    }, 30_000);
  }
});

describe("cmdbar-switch — a period switch (Scandia Dec 2025 → Dec 2024): nothing of Dec 2025 under Dec 2024", () => {
  for (const query of ["", "clienti"]) {
    it(query ? `typed '${query}'` : "at rest", async () => {
      const byHeader = await allowedFor([W.S25, W.S24], query);
      const [h25, h24] = [...byHeader.keys()];
      expect(h25).not.toBe(h24);
      const foreignSet = [...byHeader.get(h25)!].filter((c) => !byHeader.get(h24)!.has(c));
      expect(foreignSet.length, "POSITIVE CONTROL: Dec 2025 paints ≥ 3 carriers Dec 2024 does not").toBeGreaterThanOrEqual(3);

      frames = [];
      fetched = [];
      step = "Dec 2025";
      const qc = appClient();
      seedPeriod(qc, W.S25);
      seedCompany(qc, ORG_S);
      seedDocs(qc, W.S25);
      H.org = ORG_S;
      H.orgs = [ORG_S, ORG_A];
      H.periods = [{ period_id: S25, period_end: "2025-12-31" }, { period_id: S24, period_end: "2024-12-31" }];
      setActiveOrgId(USER, ORG_S.id);
      seedRecents();
      render(tree(qc, true, `/dashboard?period=${S25}&org=${ORG_S.id}`));
      if (query) type(query);
      await flush();

      step = "the stepper moves to Dec 2024 (its body in flight)";
      await act(async () => { navigate!(`/dashboard?period=${S24}&org=${ORG_S.id}`); });
      await flush();
      step = "Dec 2024's body lands";
      await act(async () => { H.gates.get(S24)?.({ kind: "ok", data: W.S24.body }); });
      await flush();
      step = "Dec 2024's documents land";
      await act(async () => { seedDocs(qc, W.S24); });
      await flush();

      expect.soft(foreignPaint(byHeader), "a figure painted under another period's header").toEqual([]);
      expect(requestViolations(0, null)).toEqual([]);
      const last = frames.at(-1)!;
      expect(last.header).toBe(h24);
      expect(last.carriers.length).toBeGreaterThanOrEqual(3);
      console.log(`GATE-WORK cmdbar-switch period "${query || "rest"}" frames=${frames.length} foreign_carriers=${foreignSet.length}`);
    }, 30_000);
  }
});
