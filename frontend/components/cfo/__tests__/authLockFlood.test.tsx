// GATE — the company page must not flood the Supabase auth lock.
//
// Measured on production 2026-09-26: a company page (and a dashboard, and a
// forecast) queued Supabase auth-lock requests without end — 1,080 pending
// `lock:sb-<ref>-auth-token` after 8 s, 35,066 a few minutes later. supabase-js
// serialises EVERY auth read (getSession, and every PostgREST / RPC call,
// which reads the session first) across ALL tabs of the origin through that
// one Web Lock, so every other tab hung on "Signing you in…" until the looping
// tab died.
//
// Two ways two "which company is on screen" authorities fought forever, each
// flip unmounting and remounting the page (its hold swaps the content out):
//
//   1. ACROSS TABS. The header's company name (lib/workspaceName) was ONE
//      browser-wide localStorage value, and every tab re-read it on the
//      `storage` event. A tab on Agras's page and a tab on Scandia's dashboard
//      each insisted the header name THEIR company: each write was the other
//      tab's cue to hold its page and write its own name back.
//   2. IN ONE TAB. On /workspace/<Agras>?period=<one of Scandia's> (or
//      `?org=<Scandia>`), the company page switched to Agras while the shell's
//      dashboard hold switched to the period's company, Scandia.
//
// Scope: the REAL AppShell (+ AuthGuard, as AppLayout mounts them) around the
// REAL CompanyPage, with the real lib/org, lib/prefs, lib/workspaceName and
// lib/companyOnScreen, over a COUNTING Supabase double (every getSession,
// getUser, from(), rpc() and channel() is one auth-lock acquisition in the
// real client) and a stubbed engine. The company is Agras: no analysed year,
// its only document a FAILED upload. Time is simulated.
//
// Fails on: more than 20 Supabase calls in the 30 simulated seconds after the
// page has settled — with a second tab on another company, with a foreign
// `?period=` / `?org=` on the company page, and with the remembered active
// company deleted. Plant-proven red on the pre-fix tree: 182 calls with the
// second tab (and with the deleted company), 7,485 / 7,496 calls — the flood
// breaker below — with the foreign `?period=` / `?org=`. Each cause alone
// reds its own cases: the shared, re-read header name (lib/workspaceName)
// the second-tab cases; the dashboard hold on the company page (AppShell)
// together with the company page keeping a foreign parameter (CompanyPage)
// the `?period=` / `?org=` cases — 30 calls even with the defence-in-depth
// bounds (prefs coalescing, the hold's ask budget, the watchdog interval).
import { act, render, screen } from "@testing-library/react";
import { Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "5c0a0000-0000-4000-8000-0000000000a1";
const ORG_SCANDIA = "0a9a0000-0000-4000-8000-000000000051";
const ORG_AGRAS = "0a9a0000-0000-4000-8000-0000000000a9";
const ORG_DELETED = "98c06428-9bf4-420d-ad2f-06964e8cbd05";
const SCANDIA_PERIOD = "5ea50000-0000-4000-8000-0000000051f5";
const NAMES: Record<string, string> = { [ORG_SCANDIA]: "Scandia Food SRL", [ORG_AGRAS]: "Agras SRL" };
const HEADER_NAME_KEY = "cfoai:v1:workspace-name";

// ── The counting Supabase double ────────────────────────────────────────
const world = vi.hoisted(() => ({
  /** Every call that takes the auth lock in the real client, in order. */
  calls: [] as string[],
  /** A loop this tight never lets simulated time advance (React re-renders
   *  it synchronously, flip after flip), so past FLOOD_CAP calls the double
   *  reports the flood and the test unmounts the app — a red with a number,
   *  never a hung run. */
  flooded: false,
  onFlood: null as null | (() => void),
  record(kind: string) {
    this.calls.push(kind);
    if (!this.flooded && this.calls.length >= 5000) {
      this.flooded = true;
      this.onFlood?.();
    }
  },
  /** user_prefs.active_org_id as the server holds it. */
  remoteActiveOrg: null as string | null,
  userPrefs: {} as Record<string, unknown>,
  orgPrefs: {} as Record<string, Record<string, unknown>>,
  orgs: [] as Array<Record<string, unknown>>,
  failedDoc: null as Record<string, unknown> | null,
}));

vi.mock("@supabase/supabase-js", () => {
  const LATENCY_MS = 20;
  const later = <T,>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), LATENCY_MS));
  const session = () => ({
    access_token: "header.payload.signature",
    refresh_token: "refresh",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "5c0a0000-0000-4000-8000-0000000000a1", email: "owner@example.test", user_metadata: {} },
  });

  /** A PostgREST query: every builder method chains; awaiting it answers. */
  function query(table: string) {
    const filters: Record<string, string> = {};
    let select = "";
    let single = false;
    let write = false;
    const answer = () => {
      const eqOrg = filters.org_id;
      const rows: Array<Record<string, unknown>> = (() => {
        if (write) return [];
        if (table === "user_prefs") {
          return [{ user_id: filters.user_id, prefs: world.userPrefs, active_org_id: world.remoteActiveOrg }];
        }
        if (table === "org_prefs") {
          if (filters.org_id_in) {
            return filters.org_id_in
              .split(",")
              .filter((id) => world.orgPrefs[id])
              .map((id) => ({ org_id: id, cui: world.orgPrefs[id]!.cui ?? null, company_name: world.orgPrefs[id]!.company_name ?? null, prefs: world.orgPrefs[id] }));
          }
          return world.orgPrefs[eqOrg ?? ""] ? [{ org_id: eqOrg, prefs: world.orgPrefs[eqOrg ?? ""] }] : [];
        }
        if (table === "documents") {
          const doc = world.failedDoc;
          if (!doc) return [];
          if (filters.id) return filters.id === doc.id ? [doc] : [];
          if (eqOrg) return eqOrg === doc.org_id ? [doc] : [];
          if (select.includes("detected_language")) return [];
          return [doc];
        }
        if (table === "profiles") return [{ id: filters.id, language: "en" }];
        return [];
      })();
      const data = single ? rows[0] ?? null : rows;
      return later({ data, error: null, count: null, status: 200, statusText: "OK" });
    };
    const builder: Record<string, unknown> = {};
    const chain = (name: string) =>
      (...args: unknown[]) => {
        if (name === "select") select = String(args[0] ?? "");
        if (name === "eq") filters[String(args[0])] = String(args[1]);
        if (name === "in") filters[`${String(args[0])}_in`] = (args[1] as unknown[]).join(",");
        if (name === "maybeSingle" || name === "single") single = true;
        if (["insert", "upsert", "update", "delete"].includes(name)) write = true;
        return builder;
      };
    for (const m of [
      "select", "eq", "neq", "in", "is", "not", "or", "gt", "gte", "lt", "lte", "like", "ilike",
      "order", "limit", "range", "match", "filter", "contains", "maybeSingle", "single",
      "insert", "upsert", "update", "delete", "csv", "returns", "throwOnError", "abortSignal",
    ]) {
      builder[m] = chain(m);
    }
    builder.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => answer().then(ok, bad);
    return builder;
  }

  function channel(name: string) {
    const ch: Record<string, unknown> = {};
    ch.on = () => ch;
    ch.subscribe = () => ch;
    ch.unsubscribe = async () => "ok";
    ch.topic = name;
    return ch;
  }

  const client = {
    auth: {
      getSession: () => {
        world.record("auth.getSession");
        return later({ data: { session: session() }, error: null });
      },
      getUser: () => {
        world.record("auth.getUser");
        return later({ data: { user: session().user }, error: null });
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      refreshSession: () => later({ data: { session: session() }, error: null }),
      signOut: () => later({ error: null }),
    },
    from: (table: string) => {
      world.record(`from:${table}`);
      return query(table);
    },
    rpc: (fn: string, args?: Record<string, unknown>) => {
      world.record(`rpc:${fn}`);
      if (fn === "list_workspaces") return later({ data: world.orgs, error: null });
      if (fn === "set_user_pref" && args) world.userPrefs = { ...world.userPrefs, [String(args.p_key)]: args.p_value };
      if (fn === "set_org_pref" && args) {
        const id = String(args.p_org_id);
        world.orgPrefs[id] = { ...(world.orgPrefs[id] ?? {}), [String(args.p_key)]: args.p_value };
      }
      return later({ data: null, error: null });
    },
    channel: (name: string) => {
      world.record(`channel:${name}`);
      return channel(name);
    },
    removeChannel: async () => "ok",
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }), remove: async () => ({ error: null }) }) },
    functions: { invoke: async () => ({ data: null, error: null }) },
  };
  return { createClient: () => client };
});

// Signed in, as AuthProvider would report it once the session is read.
vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  const user = { id: "5c0a0000-0000-4000-8000-0000000000a1", email: "owner@example.test", user_metadata: {}, app_metadata: {}, aud: "authenticated", created_at: "2026-01-01" };
  const state = {
    status: "signed_in" as const,
    session: { access_token: "t", user },
    user,
    displayName: "Owner",
    initials: "OW",
    workspaceLabel: null,
    companyName: null,
    demoActive: false,
    isAuthenticated: true,
    signUp: async () => ({ error: null, needsConfirmation: false }),
    signIn: async () => ({ error: null }),
    signOut: async () => ({ error: null }),
    signInWithOAuth: async () => ({ error: null }),
    enterDemo: () => {},
    exitDemo: () => {},
  };
  return { ...real, useAuth: () => state };
});

// The anonymized real Scandia FY2025 period, as GET /api/period serves it
// (the capture the workspace-v2 browser gates hold to the live route).
import SCANDIA from "../../../../e2e/fixtures/workspace_v2/scandia_fy2025.json";

/** The app, loaded FRESH for each test (vi.resetModules): lib/org, lib/prefs,
 *  lib/activeOrg and lib/workspaceName keep module-level state, and a test
 *  must start from what its own localStorage says, like a new page load. */
async function loadApp() {
  vi.resetModules();
  const [{ TestProviders }, { AuthGuard }, { AppShell }, CompanyPageModule, { __setFeaturesForTest }] =
    await Promise.all([
      import("@/test/renderWithProviders"),
      import("@/components/cfo/AuthGuard"),
      import("@/components/cfo/AppShell"),
      import("@/pages/cfo/CompanyPage"),
      import("@/lib/features"),
    ]);
  __setFeaturesForTest({
    workspace_v2: { status: "active", label: "Workspace", description: "" },
  } as never);
  return { TestProviders, AuthGuard, AppShell, CompanyPage: CompanyPageModule.default };
}

// Captured before any test fakes the clock: the flood breaker must be able
// to run while simulated time is stuck.
const realSetTimeout = globalThis.setTimeout;

// ── The engine, stubbed at fetch ────────────────────────────────────────
const engineCalls: string[] = [];
function stubEngine() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      engineCalls.push(url.pathname);
      await new Promise((r) => setTimeout(r, 20));
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      const p = url.pathname;
      if (p === "/health") return json({ status: "ok" });
      if (/^\/api\/companies\/[^/]+\/years$/.test(p)) return json([]);
      if (p === "/api/org/periods-with-documents") {
        return json({ active_period_id: null, periods: [], public_records: [], recently_deleted: [] });
      }
      if (p === `/api/period/${SCANDIA_PERIOD}`) return json(SCANDIA.period);
      if (p === "/api/industry/profiles") return json([]);
      return json({ detail: "not stubbed" }, 404);
    }),
  );
}

function org(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    industry_key: "food_manufacturing",
    industry_display_name: null,
    default_currency: "RON",
    role: "owner",
    archived_at: null,
    purge_after: null,
    created_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

/** AppLayout's composition: AuthGuard + AppShell around the routed page. */
async function renderApp(route: string) {
  const { TestProviders, AuthGuard, AppShell, CompanyPage } = await loadApp();
  return render(
    <TestProviders route={route}>
      <Routes>
        <Route
          element={
            <AuthGuard>
              <AppShell>
                <Outlet />
              </AppShell>
            </AuthGuard>
          }
        >
          <Route path="/workspace/:orgId" element={<CompanyPage />} />
          <Route path="/dashboard" element={<div data-testid="dashboard-page" />} />
        </Route>
      </Routes>
    </TestProviders>,
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Another tab of the same browser, on Scandia's dashboard. A real tab re-reads
 * the shared localStorage on every `storage` event our writes cause, and its
 * own hold writes ITS company's name back whenever the header it would show
 * names another company. Modelled exactly: whenever the key holds a name that
 * is not Scandia's, this "tab" writes Scandia's and fires the `storage` event
 * our window would receive — ~50 ms later, a render's worth.
 */
function peerTabOnScandia(): () => void {
  const timer = setInterval(() => {
    const now = localStorage.getItem(HEADER_NAME_KEY);
    if (now === NAMES[ORG_SCANDIA]) return;
    localStorage.setItem(HEADER_NAME_KEY, NAMES[ORG_SCANDIA]!);
    window.dispatchEvent(
      new StorageEvent("storage", { key: HEADER_NAME_KEY, oldValue: now, newValue: NAMES[ORG_SCANDIA] }),
    );
  }, 50);
  return () => clearInterval(timer);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  localStorage.clear();
  world.calls = [];
  world.flooded = false;
  world.onFlood = null;
  engineCalls.length = 0;
  world.remoteActiveOrg = ORG_SCANDIA;
  world.userPrefs = { theme: "light", view_mode: "pro" };
  world.orgPrefs = {
    [ORG_SCANDIA]: { cui: "16070576", company_name: NAMES[ORG_SCANDIA], display_currency: "RON" },
    [ORG_AGRAS]: { cui: "46355095", company_name: NAMES[ORG_AGRAS], display_currency: "RON" },
  };
  world.orgs = [org(ORG_SCANDIA, NAMES[ORG_SCANDIA]!), org(ORG_AGRAS, NAMES[ORG_AGRAS]!, { industry_key: null })];
  // Agras: no analysed year; its only document a failed upload.
  world.failedDoc = {
    id: "c1368347-0000-4000-8000-000000000001",
    org_id: ORG_AGRAS,
    status: "failed",
    original_filename: "balanta.pdf",
    display_name: "balanta.pdf",
    storage_path: `${ORG_AGRAS}/uploads/balanta.pdf`,
    period_id: null,
    error: "Could not read the document.",
    scope: "financial",
    detected_type: null,
    detected_language: null,
    is_active: true,
    size_bytes: 1000,
    created_at: "2026-09-20T10:00:00Z",
    deleted_at: null,
  };
  // The active company as the other tab (or the last session) left it.
  localStorage.setItem("cfoai.active_org", JSON.stringify({ uid: USER_ID, orgId: ORG_SCANDIA }));
  localStorage.setItem(HEADER_NAME_KEY, NAMES[ORG_SCANDIA]!);
  stubEngine();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Supabase calls made in the 30 simulated seconds after the page settled. */
async function callsInSteadyWindow(route: string, opts: { peer?: boolean } = {}) {
  const view = await renderApp(route);
  let unmounted = false;
  world.onFlood = () =>
    realSetTimeout(() => {
      if (!unmounted) {
        unmounted = true;
        view.unmount();
      }
    }, 0);
  const stopPeer = opts.peer ? peerTabOnScandia() : () => {};
  // Let the page settle: the switch to the page's company, prefs, the years.
  for (let i = 0; i < 10; i++) await advance(500);
  const mark = world.calls.length;
  for (let i = 0; i < 60; i++) await advance(500);
  const window = world.calls.slice(mark);
  stopPeer();
  if (!unmounted) {
    unmounted = true;
    view.unmount();
  }
  const byKind: Record<string, number> = {};
  for (const c of window) byKind[c] = (byKind[c] ?? 0) + 1;
  return { count: window.length, byKind, flooded: world.flooded, total: world.calls.length };
}

/** The gate's one assertion, with the evidence in its message. */
function expectSettled(r: Awaited<ReturnType<typeof callsInSteadyWindow>>) {
  expect(r.flooded, `flooded: ${r.total} Supabase calls before the run could advance`).toBe(false);
  expect(r.count, `Supabase calls in 30 s after settling: ${JSON.stringify(r.byKind)}`).toBeLessThanOrEqual(20);
}

describe("the company page settles — no auth-lock flood", { timeout: 120_000 }, () => {
  it("settles alone: the title names Agras and the page stops calling Supabase", async () => {
    expectSettled(await callsInSteadyWindow(`/workspace/${ORG_AGRAS}`));
  });

  it("with another tab open on another company (the shared header name)", async () => {
    expectSettled(await callsInSteadyWindow(`/workspace/${ORG_AGRAS}`, { peer: true }));
  });

  it("with a `?period=` of another company on the company page", async () => {
    expectSettled(await callsInSteadyWindow(`/workspace/${ORG_AGRAS}?period=${SCANDIA_PERIOD}`));
  });

  it("with an `?org=` of another company on the company page", async () => {
    expectSettled(await callsInSteadyWindow(`/workspace/${ORG_AGRAS}?org=${ORG_SCANDIA}`));
  });

  it("with the remembered active company deleted (here and on the server)", async () => {
    localStorage.setItem("cfoai.active_org", JSON.stringify({ uid: USER_ID, orgId: ORG_DELETED }));
    localStorage.setItem("cfoai.active_org_id", ORG_DELETED);
    world.remoteActiveOrg = ORG_DELETED;
    expectSettled(await callsInSteadyWindow(`/workspace/${ORG_AGRAS}`, { peer: true }));
  });

  it("a dashboard link of another company switches once and settles", async () => {
    localStorage.setItem("cfoai.active_org", JSON.stringify({ uid: USER_ID, orgId: ORG_AGRAS }));
    expectSettled(await callsInSteadyWindow(`/dashboard?period=${SCANDIA_PERIOD}`));
  });
});

describe("what the settled company page shows", { timeout: 60_000 }, () => {
  it("names Agras, says it has no analysis, and the header agrees", async () => {
    await renderApp(`/workspace/${ORG_AGRAS}`);
    for (let i = 0; i < 10; i++) await advance(500);
    expect(screen.getByTestId("company-title").textContent).toBe(NAMES[ORG_AGRAS]);
    expect(screen.getByTestId("company-no-years")).toBeTruthy();
  });
});
