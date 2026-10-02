// cmdbar-switch-action — the bar's OWN "Switch to <company>" switches, and
// stays switched.
//
// THE DEFECT (review round 2 of stage CB-I, on the hermetic bundle). The
// action called `select()` IN PLACE, under the URL on display. A screen that
// pins a company — `?org=`, one of its periods, /workspace/<id> — holds for
// that company and switches the active company back to it
// (lib/companyOnScreen). So from Scandia's dashboard the header read "Agras
// SRL · Dec 2025" over a blank held page, from Scandia's company page it
// read Agras over Scandia's page, and when the hold's ask window ran out
// (HOLD_ASK_WINDOW_MS) the screen went back to Scandia; /benchmark never
// switched at all. The earlier switch laws (cmdbarSwitch, G10) moved the URL
// themselves and never pressed the bar's own action.
//
// THIS LAW presses the action (and a company × year row, and that row as a
// recent pick) on the REAL palette, from every kind of screen, with the
// REAL holds mounted beside it the way the app mounts them — AppShell's
// `useDashboardCompanyHold` (off on a company page) and the company page's
// `useCompanyOnScreen` — and a `switchOrg` that behaves like lib/org.ts's
// (the holder and the header's name written first, every `useActiveOrg`
// reader re-resolving after the remote write). With the redesign on and
// off. Time runs past the hold's ask window before anything is judged.
//
//   ENDS        the active company, the holder and the header's name are
//               the new company's — after HOLD_ASK_WINDOW_MS, not only
//               the instant after the pick;
//   ITS SCREEN  the URL it ends on pins the new company (its dashboard or
//               its company page) — never the screen of the one left;
//   ONCE        exactly one switch, to the new company; none back;
//   NO SPLIT    with the redesign off (no screen holds for a company),
//               no render shows a URL pinning one company while the holder
//               names another;
//   MID-SCAN    with an analysis running, the pick moves nothing and
//               switches nothing (lib/scanGuard).
//
// Positive controls: before the pick the world is Scandia's (holder, name,
// the header line), and the pressed row IS the action ("Switch to Agras SRL").

import { type ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useMatch } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import i18n from "@/i18n";
import { queryClient as appQueryClient } from "@/lib/queryClient";
import { clearActiveOrg, getActiveOrgId, setActiveOrgId } from "@/lib/activeOrg";
import { readWorkspaceName, writeWorkspaceName } from "@/lib/workspaceName";
import { clearUpload, startUpload } from "@/lib/uploadStore";

const REPO = resolve(__dirname, "../../../../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf-8"));

const SCANDIA = read("e2e/fixtures/workspace_v2/scandia_fy2025.json");
const AGRAS = read("e2e/fixtures/workspace_v2/agras_fy2025.json");

const USER = "user-under-test";

// ── host context ────────────────────────────────────────────────────────

const H = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    org: null as null | { id: string; name: string; industry_key: string | null },
    orgs: [] as { id: string; name: string; industry_key: string | null }[],
    version: 0,
    listeners,
    emit: () => { listeners.forEach((l) => l()); },
    v2: true,
    /** Every switch made (lib/org.ts switchOrg), with the URL on display. */
    switches: [] as { to: string; by: string; url: string }[],
    /** What each caller's own `useActiveOrg` instance holds between its
     *  switch and the re-resolve every instance makes after the remote
     *  write (lib/org.ts: `setActiveId` is the caller's own state). */
    inst: {} as Record<string, string>,
    /** Every `select()` the bar called. */
    selects: [] as string[],
    url: "",
    /** Set by the test so switchOrg can write the holder. */
    user: "user-under-test",
  };
});

/** lib/org.ts's switchOrg, in its order: the holder, the caller's own
 *  instance and the header's name first (synchronously), then — after the
 *  remote write — every `useActiveOrg` reader re-resolves. A switch to the
 *  company the CALLER's instance already holds is nothing; two callers
 *  (the bar and a hold) are two instances, so two authorities make two
 *  switches. */
async function switchOrg(orgId: string, by: string): Promise<void> {
  const next = H.orgs.find((o) => o.id === orgId);
  if (!next || orgId === (H.inst[by] ?? H.org?.id)) return;
  H.switches.push({ to: orgId, by, url: H.url });
  setActiveOrgId(H.user, orgId);
  H.inst[by] = orgId;
  writeWorkspaceName(next.name);
  await Promise.resolve(); // writeRemoteActiveOrgId
  H.org = next;
  H.inst = {};
  H.version++;
  H.emit();
}

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "user-under-test" }, status: "signed_in" }) }));
vi.mock("@/lib/apiHeaders", () => ({ authOrgHeaders: async () => ({ Authorization: "Bearer test" }) }));
vi.mock("@/lib/org", async (orig) => {
  const React = await import("react");
  return {
    ...(await orig<typeof import("@/lib/org")>()),
    useActiveOrg: () => {
      React.useSyncExternalStore(
        (cb: () => void) => { H.listeners.add(cb); return () => { H.listeners.delete(cb); }; },
        () => H.version,
      );
      return {
        org: H.org, orgs: H.orgs, archived: [], loading: false, loadError: false,
        refresh: async () => {},
        switchOrg: (id: string) => switchOrg(id, "hold"),
      };
    },
  };
});
// A period body the cache does not hold is IN FLIGHT, as it is live: asked
// (the trapped fetch below), never answered. Without a session the real
// reader answers "error" at once, and an errored query drops the kept
// payload the dashboard's hold must not read — the in-flight case would
// pass for the wrong reason (it did, until this session was provided).
vi.mock("@/lib/supabase", async (orig) => ({
  ...(await orig<typeof import("@/lib/supabase")>()),
  getSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: "test" } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}));
vi.mock("@/lib/usePeriodStepper", () => ({
  usePeriodStepper: () => ({
    periods: [], selectedEnd: null, selectedMonth: null, selectedYear: null,
    prevTarget: null, nextTarget: null, showStepper: false, goToPeriod: () => {},
  }),
}));
// lib/workspaces' select: the scan guard, then switchOrg.
vi.mock("@/lib/workspaces", async () => {
  const { blockedByScan } = await import("@/lib/scanGuard");
  return {
    useWorkspaces: () => ({
      select: async (id: string) => {
        H.selects.push(id);
        if (blockedByScan("workspace")) return;
        await switchOrg(id, "bar");
      },
    }),
  };
});
vi.mock("@/lib/previewFeatures", () => ({
  useUploadRoute: (legacy: string) => (H.v2 ? "/workspace" : legacy),
  useWorkspaceV2: () => H.v2,
}));
vi.mock("@/lib/features", async (orig) => ({
  ...(await orig<typeof import("@/lib/features")>()),
  useFeatureStatus: (k: string) => (k === "forecast" ? "coming_soon" : "active"),
}));
vi.mock("@/components/cfo/Sidebar", () => ({
  useShellNav: () => [{ key: "core", label: "Core", items: [{ to: "/dashboard", labelKey: "sidebar.dashboard" }] }],
  SIDEBAR_TOGGLE_EVENT: "cfo-ai-sidebar-toggle",
}));

import { CommandPalette } from "../CommandPalette";
import { RECENTS_KEY_PREFIX } from "../cmdbar/cmdbarRecents";
import { HOLD_ASK_WINDOW_MS, useCompanyOnScreen, useDashboardCompanyHold } from "@/lib/companyOnScreen";

// ── the world ───────────────────────────────────────────────────────────

type Org = { id: string; name: string; industry_key: string | null };
const ORG_S: Org = { id: SCANDIA.period.organization.id, name: SCANDIA.period.organization.name, industry_key: "food_manufacturing" };
const ORG_A: Org = { id: AGRAS.period.organization.id, name: AGRAS.period.organization.name, industry_key: "food_manufacturing" };
const S25 = SCANDIA.period.period.id as string;
const A25 = AGRAS.period.period.id as string;
const OWNER: Record<string, string> = { [S25]: ORG_S.id, [A25]: ORG_A.id };

/** The company a URL pins: `?org=`, else its period's company, else the
 *  company page's id — or none (/settings, a bare /dashboard). The second
 *  argument is only the PARSE BASE for a relative URL, never a request; it is
 *  localhost, as in the live twin (e2e/design/cmdbar.spec.ts companyOfUrl). */
function companyOf(url: string): string | null {
  const u = new URL(url, "http://localhost");
  const org = u.searchParams.get("org");
  if (org) return org;
  const period = u.searchParams.get("period");
  if (period && OWNER[period]) return OWNER[period];
  const page = /^\/workspace\/([^/]+)$/.exec(u.pathname);
  return page ? decodeURIComponent(page[1]) : null;
}

let fetched: string[] = [];
let savedFetch: unknown;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  fetched = [];
  H.switches = [];
  H.selects = [];
  H.inst = {};
  H.version = 0;
  const g = globalThis as unknown as Record<string, unknown>;
  savedFetch = g.fetch;
  // Nothing is answered: every document the bar reads is in the cache.
  g.fetch = (input: unknown) => {
    fetched.push(typeof input === "string" ? input : String((input as { url?: string })?.url ?? input));
    return new Promise(() => {});
  };
  try { window.localStorage.clear(); } catch { /* shim */ }
  await act(async () => { await i18n.changeLanguage("en"); });
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).fetch = savedFetch;
  cleanup();
  clearActiveOrg();
  clearUpload();
  vi.useRealTimers();
});

function appClient(): QueryClient {
  const d = appQueryClient.getDefaultOptions();
  return new QueryClient({ defaultOptions: { ...d, queries: { ...d.queries, retry: false } } });
}

function seed(qc: QueryClient, agrasYearsRead: boolean, agrasBodyRead = true) {
  qc.setQueryData(["period", S25], { kind: "ok", data: SCANDIA.period });
  // Not read yet: the app's query client keeps Scandia's body on screen
  // (keepPreviousData) while Agras's is in flight — never answered here.
  if (agrasBodyRead) qc.setQueryData(["period", A25], { kind: "ok", data: AGRAS.period });
  const list = (org: Org, id: string) => ({
    orgId: org.id,
    periods: [{ period_id: id, period_end: "2025-12-31", period_start: null, period_label: "", documents: [{ id: `d-${id}` }] }],
  });
  qc.setQueryData(["periods-with-documents", "company", ORG_S.id], list(ORG_S, S25));
  qc.setQueryData(["periods-with-documents", "company", ORG_A.id], list(ORG_A, A25));
  const years = (id: string) => [{ period_id: id, year: 2025, period_end: "2025-12-31", revenue: null, revenue_change_pct: null }];
  qc.setQueryData(["company-years", ORG_S.id], years(S25));
  if (agrasYearsRead) qc.setQueryData(["company-years", ORG_A.id], years(A25));
}

// ── what the app mounts beside the bar ──────────────────────────────────

interface Frame { url: string; holder: string | null; header: string }
let frames: Frame[] = [];

/** The two holds, mounted as the app mounts them: AppShell's dashboard
 *  hold (never on a company page), the company page's own. With the
 *  redesign off, neither holds. Records every render's frame. */
function Screen() {
  const loc = useLocation();
  const companyPage = useMatch("/workspace/:orgId");
  H.url = `${loc.pathname}${loc.search}`;
  useDashboardCompanyHold(H.v2 && !companyPage, false);
  useCompanyOnScreen(H.v2 && companyPage ? companyPage.params.orgId ?? null : null);
  frames.push({ url: H.url, holder: getActiveOrgId(USER), header: readWorkspaceName() });
  return null;
}

function tree(qc: QueryClient, url: string): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Screen />
        <CommandPalette open onOpenChange={() => {}} onOpenAi={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Let queries, effects and every timer due within `ms` run. */
async function run(ms = 50): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function type(q: string) {
  fireEvent.change(screen.getByTestId("capsule-composer"), { target: { value: q } });
}

function row(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
  if (!el) throw new Error(`no row ${id} — rows: ${[...document.querySelectorAll("[data-row-id]")].map((e) => e.getAttribute("data-row-id")).join(", ")}`);
  return el;
}

// ════════════════════════════════════════════════════════════════════════

const STARTS = [
  { name: "Scandia's dashboard", url: `/dashboard?period=${S25}&org=${ORG_S.id}`, v2Only: false },
  { name: "Scandia's dashboard, ?period alone", url: `/dashboard?period=${S25}`, v2Only: false },
  { name: "Scandia's company page", url: `/workspace/${ORG_S.id}`, v2Only: true },
  { name: "/benchmark of Scandia's period", url: `/benchmark?period=${S25}`, v2Only: false },
  { name: "the bare dashboard", url: "/dashboard", v2Only: false },
  { name: "/settings", url: "/settings", v2Only: false },
];

const PICKS = [
  { name: "the action 'Switch to Agras SRL'", query: "switch agras", id: `action:switch:${ORG_A.id}`, label: "Switch to Agras SRL" },
  { name: "the company × year row 'Agras SRL · 2025'", query: "agras 2025", id: `page:year:${ORG_A.id}:${A25}`, label: "Agras SRL · 2025" },
];

interface Run { preFrames: number; start: string; v2: boolean; yearsRead: boolean }

async function mountScandia(start: string, v2: boolean, yearsRead: boolean, agrasBodyRead = true) {
  H.v2 = v2;
  H.org = ORG_S;
  H.orgs = [ORG_S, ORG_A];
  setActiveOrgId(USER, ORG_S.id);
  writeWorkspaceName(ORG_S.name);
  frames = [];
  const qc = appClient();
  seed(qc, yearsRead, agrasBodyRead);
  render(tree(qc, start));
  await run();
  // POSITIVE CONTROL: the world is Scandia's before the pick.
  expect(getActiveOrgId(USER)).toBe(ORG_S.id);
  expect(readWorkspaceName()).toBe(ORG_S.name);
  expect(screen.getByTestId("cmdbar-scope").textContent).toMatch(/^Searching Scandia Food SRL/);
  expect(H.switches, "nothing switched before the pick").toEqual([]);
}

/** Every law of the header, judged past the hold's ask window. */
function judge(r: Run): string[] {
  const out: string[] = [];
  if (frames.length <= r.preFrames) out.push("VACUITY: nothing rendered after the pick");
  if (getActiveOrgId(USER) !== ORG_A.id) out.push(`the holder ends on ${getActiveOrgId(USER)}, not Agras`);
  if (H.org?.id !== ORG_A.id) out.push(`useActiveOrg() ends on ${H.org?.name}, not Agras`);
  if (readWorkspaceName() !== ORG_A.name) out.push(`the header ends on "${readWorkspaceName()}", not "Agras SRL"`);
  const endsOn = companyOf(H.url);
  // With the redesign off and Agras's years not read, the dashboard (which
  // pins no company) opens the active company's own state.
  const pinless = !r.v2 && !r.yearsRead;
  if (pinless ? endsOn !== null && endsOn !== ORG_A.id : endsOn !== ORG_A.id) {
    out.push(`the screen it ends on (${H.url}) pins ${endsOn ?? "no company"}, not Agras`);
  }
  const back = H.switches.filter((s) => s.to !== ORG_A.id);
  if (back.length) out.push(`switched back: ${JSON.stringify(back)}`);
  const toA = H.switches.filter((s) => s.to === ORG_A.id);
  if (toA.length !== 1) out.push(`${toA.length} switches to Agras (one authority makes one): ${JSON.stringify(toA)}`);
  if (!r.v2) {
    for (const f of frames.slice(r.preFrames)) {
      const pinned = companyOf(f.url);
      if (pinned && pinned !== f.holder) out.push(`a render with ${f.url} (pins ${pinned}) under holder ${f.holder}`);
    }
  }
  return [...new Set(out)];
}

describe("cmdbar-switch-action — the bar's own switch opens the company, and it stays open", () => {
  for (const v2 of [true, false]) {
    for (const pick of PICKS) {
      for (const start of STARTS) {
        if (start.v2Only && !v2) continue;
        it(`redesign ${v2 ? "on" : "off"} · ${pick.name} · from ${start.name}`, async () => {
          await mountScandia(start.url, v2, true);
          type(pick.query);
          await run();
          const el = row(pick.id);
          expect(el.textContent, "POSITIVE CONTROL: the row pressed is the switch").toContain(pick.label);
          const r: Run = { preFrames: frames.length, start: start.url, v2, yearsRead: true };
          fireEvent.click(el);
          // Past the hold's ask window: a hold that re-asks after it has
          // run out of asks does so here.
          for (let t = 0; t < HOLD_ASK_WINDOW_MS * 1.5; t += 500) await run(500);
          expect(judge(r)).toEqual([]);
          console.log(`GATE-WORK cmdbar-switch-action redesign=${v2 ? "on" : "off"} pick=${pick.id.split(":")[0]} from="${start.name}" ends=${H.url} switches=${H.switches.length} frames=${frames.length - r.preFrames}`);
        }, 30_000);
      }
    }
  }

  for (const v2 of [true, false]) {
    it(`redesign ${v2 ? "on" : "off"} · Agras's years not read yet · from Scandia's dashboard`, async () => {
      await mountScandia(`/dashboard?period=${S25}&org=${ORG_S.id}`, v2, false);
      type("switch agras");
      await run();
      const r: Run = { preFrames: frames.length, start: "", v2, yearsRead: false };
      fireEvent.click(row(`action:switch:${ORG_A.id}`));
      for (let t = 0; t < HOLD_ASK_WINDOW_MS * 1.5; t += 500) await run(500);
      expect(judge(r)).toEqual([]);
      if (v2) expect(H.url, "the company page is Agras's own screen").toBe(`/workspace/${ORG_A.id}`);
    }, 30_000);
  }

  // Agras's period body in flight: the dashboard's hold reads the period on
  // screen, and the app's query client keeps SCANDIA's body there until
  // Agras's lands (keepPreviousData) — the link's `?org=` pin must decide,
  // or the hold asks for Scandia, nothing switches, and Scandia's month is
  // painted under a URL naming Agras (lib/companyOnScreen
  // useDashboardCompanyHold; live, G11).
  for (const pick of PICKS) {
    it(`redesign on · ${pick.name} · Agras's period body in flight · from Scandia's dashboard`, async () => {
      await mountScandia(`/dashboard?period=${S25}&org=${ORG_S.id}`, true, true, false);
      type(pick.query);
      await run();
      const r: Run = { preFrames: frames.length, start: "", v2: true, yearsRead: true };
      fireEvent.click(row(pick.id));
      for (let t = 0; t < HOLD_ASK_WINDOW_MS * 1.5; t += 500) await run(500);
      expect(judge(r)).toEqual([]);
      console.log(`GATE-WORK cmdbar-switch-action redesign=on pick=${pick.id.split(":")[0]} body=in-flight ends=${H.url} switches=${H.switches.length}`);
    }, 30_000);
  }

  for (const v2 of [true, false]) {
    it(`redesign ${v2 ? "on" : "off"} · a recent pick of Agras's year · from Scandia's dashboard`, async () => {
      window.localStorage.setItem(`${RECENTS_KEY_PREFIX}${ORG_S.id}`, JSON.stringify([
        { id: `page:year:${ORG_A.id}:${A25}`, group: "page", label: "Agras SRL · 2025", href: `/dashboard?period=${A25}&org=${ORG_A.id}` },
      ]));
      await mountScandia(`/dashboard?period=${S25}&org=${ORG_S.id}`, v2, true);
      const r: Run = { preFrames: frames.length, start: "", v2, yearsRead: true };
      fireEvent.click(row(`recent:page:year:${ORG_A.id}:${A25}`));
      for (let t = 0; t < HOLD_ASK_WINDOW_MS * 1.5; t += 500) await run(500);
      expect(judge(r)).toEqual([]);
    }, 30_000);
  }

  for (const v2 of [true, false]) {
    it(`redesign ${v2 ? "on" : "off"} · with an analysis running, the pick moves nothing and switches nothing`, async () => {
      await mountScandia(`/dashboard?period=${S25}&org=${ORG_S.id}`, v2, true);
      startUpload({ docId: "doc-running", filename: "balanta.xlsx" });
      type("switch agras");
      await run();
      fireEvent.click(row(`action:switch:${ORG_A.id}`));
      for (let t = 0; t < HOLD_ASK_WINDOW_MS * 1.5; t += 500) await run(500);
      expect({ url: H.url, holder: getActiveOrgId(USER), switches: H.switches }).toEqual({
        url: `/dashboard?period=${S25}&org=${ORG_S.id}`, holder: ORG_S.id, switches: [],
      });
    }, 30_000);
  }
});
