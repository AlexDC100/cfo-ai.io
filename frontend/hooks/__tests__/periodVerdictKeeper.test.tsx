// WHAT A BROWSER REMEMBERS AS "THIS COMPANY'S PERIOD" IS A PERIOD THE READER
// WAS SERVED FOR IT — AND ONE THE ENGINE ANSWERS "NOT FOUND" IS NEVER A DEAD END.
//
// THE INCIDENT (production, 2026-10-04). A signed-in reader's dashboard said
// "nothing analysed here yet" over a company holding two analysed years, and
// the chat, "grounded" in that company, told the reader its period was a row
// id. The browser's remembered period for the company was a period of
// ANOTHER ACCOUNT: it had been opened once by URL, the engine answered 404,
// and useActivePeriodFallback had already written it down — "a uuid in the
// URL is proof the company has this period". Every bare /dashboard, /chat and
// /benchmark of that company was sent back to it from then on.
//
// LAW.
//   · a period is remembered for the active company only when its payload
//     landed and names that company — never from the URL alone, never while
//     it loads, never for another company's period;
//   · a period answered "not found" is forgotten wherever it is remembered,
//     the reader is told once, and the page re-opens on the company's own
//     period;
//   · that recovery is bounded: once per period, a few per page life — a
//     second "not found" for the same id is left to the page (no loop);
//   · a transport error says nothing about a period;
//   · the answer read is the cache's own for the URL's period, not the
//     previous period's placeholder;
//   · the chat is grounded only in a period that was served.
//
// Fails on: the verdict written from the URL; the dead end (a remembered
// unreadable period re-opened for ever); a recovery that loops; a period of
// another company remembered for this one; a period still loading treated as
// missing; a not-found period sent to the assistant as grounding.
// Cannot see: the engine's own answer (the route is stubbed); a page that
// carries `?period=` and never mounts the shell; what the assistant replies.
// Plant log: docs/engine_book/gates.md, "period-verdict-served".
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import { clearActiveOrg, setActiveOrgId } from "@/lib/activeOrg";
import { clearDataPresence, readPeriodVerdict, writePeriodVerdict } from "@/lib/dataPresence";
import { queryClient as appQueryClient } from "@/lib/queryClient";

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: "tok", user: { id: "u1" } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
  supabaseEnabled: true,
  currentOrgId: async () => "A",
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signed_in", user: { id: "u1" } }) }));
vi.mock("@/lib/testMode", () => ({ isPublicTestMode: false }));
vi.mock("@/lib/orgPeriods", () => ({
  fetchWorkspacePeriodsDirect: vi.fn(async () => ({ active_period_id: null, periods: [] })),
  isCurrentMonthPeriod: () => false,
}));
const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock("@/components/ui/sonner", () => ({ toast }));

import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { PERIOD_RECOVERY_BUDGET, resetPeriodRecoveries, usePeriodVerdictKeeper } from "@/hooks/usePeriodVerdictKeeper";
import { useActivePeriod } from "@/lib/activePeriod";
import { buildWorkspaceSnapshot } from "@/pages/cfo/Chat";

const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const X = id(1); // a period this reader cannot read
const Y = id(2); // company A's own period
const Y2 = id(3); // company A's other period
const Z = id(4); // company B's period (the reader is a member of both)

/** The engine. `/api/period/<id>`: served, 404, or 500. The lookup answers
 *  per company. Every request is recorded. */
type Served = { org: string } | "not_found" | "error";
const engine = {
  periods: new Map<string, Served>(),
  active: new Map<string, string | null>(),
  delayMs: new Map<string, number>(),
  asked: [] as string[],
};
let checked = 0;

function installEngine() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const m = /\/api\/period\/([0-9a-f-]{36})$/.exec(u);
      if (m) {
        const pid = m[1];
        engine.asked.push(`period:${pid}`);
        const wait = engine.delayMs.get(pid) ?? 0;
        if (wait) await new Promise((r) => setTimeout(r, wait));
        const served = engine.periods.get(pid) ?? "not_found";
        if (served === "not_found") return new Response(JSON.stringify({ detail: "Period not found." }), { status: 404 });
        if (served === "error") return new Response("boom", { status: 500 });
        return new Response(
          JSON.stringify({
            period: { id: pid, period_end: "2025-12-31", currency: "RON" },
            organization: { id: served.org, name: `Company ${served.org}` },
            line_items: [],
            metrics: [],
            statements: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (/\/api\/org\/periods-with-documents$/.test(u)) {
        const org = ((init?.headers ?? {}) as Record<string, string>)["X-Org-Id"] ?? "";
        engine.asked.push(`lookup:${org}`);
        return new Response(
          JSON.stringify({ active_period_id: engine.active.get(org) ?? null, periods: [], recently_deleted: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${u}`);
    }),
  );
}

let go: (to: string) => void = () => {};
function Probe() {
  usePeriodVerdictKeeper();
  const { status } = useActivePeriodFallback({ basePath: "/dashboard" });
  const period = useActivePeriod();
  const loc = useLocation();
  go = useNavigate();
  return (
    <>
      <div data-testid="status">{status}</div>
      <div data-testid="location">{loc.pathname + loc.search}</div>
      <div data-testid="not-found">{String(period.notFound)}</div>
    </>
  );
}

/** The APP'S query defaults (previous data kept as a placeholder) — a client
 *  without them cannot see the placeholder law. */
function renderAt(route: string) {
  const client = new QueryClient({ defaultOptions: appQueryClient.getDefaultOptions() });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const location = () => screen.getByTestId("location").textContent;
const settle = (ms = 60) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const askedFor = (what: string) => engine.asked.filter((a) => a === what).length;

beforeEach(() => {
  localStorage.clear();
  clearDataPresence();
  clearActiveOrg();
  resetPeriodRecoveries();
  engine.periods.clear();
  engine.active.clear();
  engine.delayMs.clear();
  engine.asked.length = 0;
  toast.info.mockClear();
  installEngine();
  setActiveOrgId("u1", "A");
  engine.periods.set(Y, { org: "A" });
  engine.periods.set(Y2, { org: "A" });
  engine.periods.set(Z, { org: "B" });
  engine.active.set("A", Y);
  engine.active.set("B", Z);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(`GATE-WORK period-verdict-served checks=${checked}`);
});

describe("a period the engine answers 'not found' is never a dead end", () => {
  it("THE INCIDENT: the company's remembered period is one this reader cannot read — the bare dashboard recovers to the company's own", async () => {
    writePeriodVerdict("u1", X, "A");
    renderAt("/dashboard");
    await waitFor(() => expect(location()).toBe(`/dashboard?period=${Y}`));
    await waitFor(() => expect(readPeriodVerdict("u1", "A")).toBe(Y));
    expect(askedFor(`period:${X}`)).toBe(1);
    expect(askedFor("lookup:A")).toBe(1);
    // The reader is told, once, in words.
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info.mock.calls[0]).toEqual([
      "That period isn't available",
      { description: "It was deleted or belongs to another account. We opened this company's own data instead." },
    ]);
    expect(screen.getByTestId("not-found").textContent).toBe("false");
    checked += 5;
  });

  it("a stale link is not written down — not while it loads, not after it fails", async () => {
    engine.delayMs.set(X, 80);
    renderAt(`/dashboard?period=${X}`);
    await settle(30);
    // Still loading: nothing is remembered (the defect wrote it at once).
    expect(readPeriodVerdict("u1", "A")).toBeUndefined();
    await waitFor(() => expect(location()).toBe(`/dashboard?period=${Y}`));
    expect(readPeriodVerdict("u1", "A")).toBe(Y);
    expect(localStorage.getItem(`cfoai:v1:period-verdict:u1:A`)).toBe(Y);
    for (let i = 0; i < localStorage.length; i++) {
      expect(localStorage.getItem(localStorage.key(i)!)).not.toBe(X);
    }
    checked += 3;
  });

  it("it is forgotten for EVERY company that remembered it", async () => {
    writePeriodVerdict("u1", X, "A");
    writePeriodVerdict("u1", X, "B");
    writePeriodVerdict("u1", Y2, "C");
    renderAt(`/dashboard?period=${X}`);
    await waitFor(() => expect(location()).toBe(`/dashboard?period=${Y}`));
    expect(readPeriodVerdict("u1", "B")).toBeUndefined();
    expect(readPeriodVerdict("u1", "C")).toBe(Y2);
    checked += 2;
  });

  it("no loop: the lookup answers the same unreadable period — one recovery, then the page is left alone", async () => {
    engine.active.set("A", X);
    renderAt(`/dashboard?period=${X}`);
    await waitFor(() => expect(askedFor("lookup:A")).toBe(1));
    await waitFor(() => expect(location()).toBe(`/dashboard?period=${X}`));
    await settle(150);
    expect(location()).toBe(`/dashboard?period=${X}`);
    expect(askedFor("lookup:A")).toBe(1);
    // The engine was asked for the period once: its answer is not re-bought.
    expect(askedFor(`period:${X}`)).toBe(1);
    expect(toast.info).toHaveBeenCalledTimes(1);
    // …and what the engine's own lookup wrote is forgotten again: the next
    // bare visit asks, it does not trust.
    expect(readPeriodVerdict("u1", "A")).toBeUndefined();
    checked += 5;
  });

  it("the recovery budget of a page life is a number, and it holds", async () => {
    expect(PERIOD_RECOVERY_BUDGET).toBe(3);
    for (let n = 0; n < PERIOD_RECOVERY_BUDGET; n++) {
      const view = renderAt(`/dashboard?period=${id(100 + n)}`);
      await waitFor(() => expect(location()).toBe(`/dashboard?period=${Y}`));
      view.unmount();
    }
    expect(toast.info).toHaveBeenCalledTimes(PERIOD_RECOVERY_BUDGET);
    const stuck = id(200);
    renderAt(`/dashboard?period=${stuck}`);
    await waitFor(() => expect(askedFor(`period:${stuck}`)).toBe(1));
    await settle(120);
    expect(location()).toBe(`/dashboard?period=${stuck}`);
    expect(toast.info).toHaveBeenCalledTimes(PERIOD_RECOVERY_BUDGET);
    checked += 3;
  });

  it("a transport error is not 'not found': nothing forgotten, nothing recovered, nothing said", async () => {
    engine.periods.set(X, "error");
    writePeriodVerdict("u1", X, "A");
    renderAt(`/dashboard?period=${X}`);
    await waitFor(() => expect(askedFor(`period:${X}`)).toBeGreaterThan(0));
    await settle(120);
    expect(location()).toBe(`/dashboard?period=${X}`);
    expect(readPeriodVerdict("u1", "A")).toBe(X);
    expect(toast.info).not.toHaveBeenCalled();
    checked += 3;
  });
});

describe("a period is remembered when it was served for this company", () => {
  it("the company's own period, opened by URL, is remembered once its payload lands", async () => {
    engine.delayMs.set(Y2, 80);
    renderAt(`/dashboard?period=${Y2}`);
    await settle(30);
    expect(readPeriodVerdict("u1", "A")).toBeUndefined();
    await waitFor(() => expect(readPeriodVerdict("u1", "A")).toBe(Y2));
    expect(location()).toBe(`/dashboard?period=${Y2}`);
    expect(toast.info).not.toHaveBeenCalled();
    checked += 3;
  });

  it("another company's period is not this company's — it is remembered for its own, once that company is the active one", async () => {
    renderAt(`/dashboard?period=${Z}`);
    await waitFor(() => expect(askedFor(`period:${Z}`)).toBe(1));
    await settle(80);
    expect(readPeriodVerdict("u1", "A")).toBeUndefined();
    expect(readPeriodVerdict("u1", "B")).toBeUndefined();
    act(() => setActiveOrgId("u1", "B"));
    await waitFor(() => expect(readPeriodVerdict("u1", "B")).toBe(Z));
    expect(readPeriodVerdict("u1", "A")).toBeUndefined();
    checked += 4;
  });

  it("a period still loading is neither served nor missing — the previous period's answer is not its answer", async () => {
    // The page sits on an unreadable period whose recovery was already spent.
    engine.active.set("A", X);
    renderAt(`/dashboard?period=${X}`);
    await waitFor(() => expect(askedFor("lookup:A")).toBe(1));
    await waitFor(() => expect(location()).toBe(`/dashboard?period=${X}`));
    await settle(60);
    toast.info.mockClear();
    writePeriodVerdict("u1", Y2, "C");
    // The reader steps to a real period that takes a moment. Meanwhile the
    // app's query client hands the hook the PREVIOUS answer ("not found").
    engine.delayMs.set(Y2, 120);
    act(() => go(`/dashboard?period=${Y2}`));
    await settle(50);
    expect(location()).toBe(`/dashboard?period=${Y2}`);
    expect(readPeriodVerdict("u1", "C")).toBe(Y2); // not forgotten as "not found"
    expect(readPeriodVerdict("u1", "A")).toBeUndefined(); // not remembered before it landed
    await waitFor(() => expect(readPeriodVerdict("u1", "A")).toBe(Y2));
    expect(location()).toBe(`/dashboard?period=${Y2}`);
    expect(toast.info).not.toHaveBeenCalled();
    checked += 5;
  });
});

describe("the chat is grounded only in a period that was served", () => {
  type P = Parameters<typeof buildWorkspaceSnapshot>[0];
  const period = (over: Record<string, unknown>) =>
    ({
      id: Y, label: "Company A", periodEnd: "2025-12-31", organizationId: "A", industry: null, statements: null,
      lineItems: [], invoices: null, metrics: [], recommendations: [], alerts: [], briefing: null, notFound: false,
      ...over,
    }) as unknown as P;

  it("not found, or nothing landed: no snapshot — the chat says it has no workspace loaded", () => {
    expect(buildWorkspaceSnapshot(period({ id: X, notFound: true, label: null }))).toBeUndefined();
    expect(buildWorkspaceSnapshot(period({}))).toBeUndefined();
    expect(buildWorkspaceSnapshot(period({ notFound: true, metrics: [{ name: "current_ratio", value: 1.2 }] }))).toBeUndefined();
    checked += 3;
  });

  it("a served period is still a snapshot", () => {
    const snap = buildWorkspaceSnapshot(period({ metrics: [{ name: "current_ratio", value: 1.2, unit: "x" }] }));
    expect(snap).toBeDefined();
    expect(snap!.split("\n")[0]).toBe("Period: period ending 2025-12-31");
    checked += 1;
  });
});

describe("the wiring", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("the fallback hook remembers only what the engine's lookup answered — never the URL's period", () => {
    const hook = read("frontend/hooks/useActivePeriodFallback.ts");
    const writes = [...hook.matchAll(/writePeriodVerdict\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, " "));
    expect(writes.sort()).toEqual(["uid, body.active_period_id, orgId", "uid, null, orgId"]);
    checked += 1;
  });

  it("the shell mounts the keeper, once; no other file writes a period verdict", () => {
    const shell = read("frontend/components/cfo/AppShell.tsx");
    expect(shell.split("usePeriodVerdictKeeper()").length - 1).toBe(1);
    expect(shell).toContain('import { usePeriodVerdictKeeper } from "@/hooks/usePeriodVerdictKeeper";');
    const keeper = read("frontend/hooks/usePeriodVerdictKeeper.ts");
    expect(keeper).toContain("queryClient.getQueryData<PeriodFetchResult>(periodQueryKey(urlPeriod))");
    expect(keeper).toMatch(/company === orgId\) writePeriodVerdict\(uid, urlPeriod, orgId\)/);
    checked += 3;
  });

  it("the two sentences exist in English and Romanian, and differ", () => {
    const s = (b: unknown) => (b as { period: Record<string, string> }).period;
    for (const k of ["unavailableTitle", "unavailableBody"]) {
      expect(s(en)[k]).toBeTruthy();
      expect(s(ro)[k]).toBeTruthy();
      expect(s(ro)[k]).not.toBe(s(en)[k]);
      checked += 1;
    }
  });
});
