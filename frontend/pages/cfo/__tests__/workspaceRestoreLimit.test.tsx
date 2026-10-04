// A REFUSED RESTORE SAYS WHY — AND WHERE TO UPGRADE.
//
// Since the database's workspace-cap guard (2026-10-04,
// supabase/schema_phase_workspace_cap_guard.sql) an owner at their plan's
// workspace limit who restores an archived workspace is refused. Both screens
// that restore answered every refusal "Couldn't restore" — no reason, no next
// step, while the archived workspace's purge date kept counting down.
//
// LAW. When the database refuses a restore for the plan's workspace limit,
// the reader is told, in English or Romanian, that the limit is reached —
// with the number THE REFUSAL names, not the plan card's — and is given one
// action that opens the plans. Any other failure keeps the plain "couldn't
// restore". A success, or a later failure of another kind, never repeats the
// limit sentence.
//
// Fails on: the refusal not read where the RPC answered, the generic sentence
// shown for a limit refusal on either screen, the limit sentence shown for a
// failure that is not the limit (or after a success), a number other than the
// refusal's, a missing Romanian or English sentence, an action that does not
// open the plans.
//
// What it cannot see: the database guard itself (gate hole-workspace-cap);
// the legacy workspace page rendered (its restore handler is read from the
// source — the page needs the whole workspace store); whether the plans page
// offers a plan with more workspaces.
// Plant log: docs/engine_book/gates.md, "workspace-restore-limit".
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import { TestProviders } from "@/test/renderWithProviders";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

/** What the database answers the restore RPC with, per test. */
const rpc = vi.hoisted(() => ({ error: null as null | { message: string }, calls: [] as string[] }));

vi.mock("@/lib/supabase", () => {
  // Every table read answers "no rows"; only the restore RPC is under test.
  const rows = (): unknown => {
    const answer = Promise.resolve({ data: [], error: null });
    const chain: unknown = new Proxy(() => chain, {
      get: (_t, key) => (key === "then" ? answer.then.bind(answer) : chain),
      apply: () => chain,
    });
    return chain;
  };
  const client = {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
    },
    from: () => rows(),
    rpc: async (name: string) => {
      rpc.calls.push(name);
      return name === "restore_workspace" ? { data: null, error: rpc.error } : { data: [], error: null };
    },
  };
  return {
  getSupabase: () => client,
  supabaseEnabled: true,
  currentOrgId: async () => "live-1",
  subscribeToDocumentStatus: () => () => {},
  fetchDocumentStatus: async () => null,
  };
});
vi.mock("@/lib/uploadsApi", () => ({
  identifyUpload: vi.fn(() => new Promise(() => {})),
  commitUpload: vi.fn(),
  UploadApiError: class extends Error {},
  fetchCompanyYears: vi.fn(async () => []),
  fetchCompanyDirectory: vi.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { cui: null, companyName: null }])),
  ),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("@/components/ui/sonner", () => ({ toast }));
vi.mock("@/components/cfo/command/DecisionRulesModal", () => ({
  DecisionRulesPanel: () => <div data-testid="decision-rules-panel" />,
}));

// The page's company list is fixed; `restoreWorkspace` is the REAL RPC
// wrapper of lib/org (over the stubbed database above), so the refusal is
// read exactly where production reads it.
vi.mock("@/lib/org", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/org")>();
  const live = [
    { id: "live-1", name: "Company One SRL", industry_key: "fmcg", industry_display_name: null, default_currency: null, role: "owner", archived_at: null, purge_after: null, created_at: "2025-01-01" },
  ];
  const archived = [
    { id: "old-1", name: "Old Company SRL", industry_key: null, industry_display_name: null, default_currency: null, role: "owner", archived_at: "2026-09-10", purge_after: "2026-10-10", created_at: "2024-01-01" },
  ];
  return {
    ...real,
    useActiveOrg: () => ({
      org: live[0],
      orgs: live,
      archived,
      loading: false,
      loadError: false,
      needsOnboarding: false,
      refresh: async () => {},
      switchOrg: async () => {},
      restoreWorkspace: (id: string) => real.restoreWorkspaceOrg(id),
    }),
    activateWorkspace: vi.fn(async () => true),
    daysUntilPurge: () => 19,
  };
});

const org = await import("@/lib/org");
const { workspaceRestoreLimitNotice, WORKSPACE_UPGRADE_PATH } = await import("@/lib/workspaceRestoreNotice");
const { default: WorkspaceHomeV2 } = await import("@/pages/cfo/WorkspaceHomeV2");

/** The database's own sentence — the format string of
 *  supabase/schema_phase_plan_caps.sql, which the guard passes through. */
const refusalOf = (plan: string, cap: number) =>
  `workspace_cap_reached: your ${plan} plan allows ${cap} workspace(s). Upgrade to add more.`;

let checked = 0;

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}
function renderHome() {
  return render(
    <TestProviders route="/workspace">
      <LocationProbe />
      <Routes>
        <Route path="/workspace" element={<WorkspaceHomeV2 />} />
        <Route path="*" element={<div data-testid="elsewhere" />} />
      </Routes>
    </TestProviders>,
  );
}
async function clickRestore() {
  const shelf = screen.getByTestId("workspace-home-deleted");
  fireEvent.click(within(shelf).getByTestId("workspace-home-restore-old-1"));
  await waitFor(() => expect(rpc.calls).toContain("restore_workspace"));
}

beforeEach(async () => {
  rpc.error = null;
  rpc.calls.length = 0;
  toast.error.mockClear();
  toast.success.mockClear();
  await i18n.changeLanguage("en");
});
afterEach(() => cleanup());
afterAll(async () => {
  await i18n.changeLanguage("en");
  // eslint-disable-next-line no-console
  console.log(`GATE-WORK workspace-restore-limit checks=${checked}`);
});

describe("the refusal is read where the database answered", () => {
  it("the database's sentence is the one the parser reads — its format string is in the repository's SQL", () => {
    const sql = readFileSync(resolve(process.cwd(), "supabase/schema_phase_plan_caps.sql"), "utf8");
    expect(sql).toContain("'workspace_cap_reached: your % plan allows % workspace(s). Upgrade to add more.'");
    for (const [plan, cap] of [["trial", 1], ["solo", 1], ["pro", 5], ["multi", 5], ["business", 20]] as const) {
      expect(org.isWorkspaceLimitMessage(refusalOf(plan, cap)), plan).toBe(true);
      expect(org.workspaceCapOfMessage(refusalOf(plan, cap)), plan).toBe(cap);
      checked += 2;
    }
    for (const other of [null, undefined, "", "permission denied for table organizations", "workspace not found", "allows 0 workspace(s)", "plan allows many workspaces"]) {
      expect(org.workspaceCapOfMessage(other), String(other)).toBeNull();
      checked += 1;
    }
  });

  it("a limit refusal is recorded with its number; another failure, and a success, record none", async () => {
    rpc.error = { message: refusalOf("trial", 1) };
    expect(await org.restoreWorkspaceOrg("old-1")).toBe(false);
    expect(org.lastWorkspaceRestoreRefusal()).toEqual({ capReached: true, cap: 1 });

    // A failure of another kind right after: the limit sentence must not be repeated.
    rpc.error = { message: "only the owner can restore a workspace" };
    expect(await org.restoreWorkspaceOrg("old-1")).toBe(false);
    expect(org.lastWorkspaceRestoreRefusal()).toEqual({ capReached: false, cap: null });

    rpc.error = { message: refusalOf("pro", 5) };
    await org.restoreWorkspaceOrg("old-1");
    expect(org.lastWorkspaceRestoreRefusal()).toEqual({ capReached: true, cap: 5 });
    rpc.error = null;
    expect(await org.restoreWorkspaceOrg("old-1")).toBe(true);
    expect(org.lastWorkspaceRestoreRefusal()).toEqual({ capReached: false, cap: null });

    // A limit refusal that names no number is still the limit.
    rpc.error = { message: "workspace_cap_reached" };
    await org.restoreWorkspaceOrg("old-1");
    expect(org.lastWorkspaceRestoreRefusal()).toEqual({ capReached: true, cap: null });
    checked += 5;
  });
});

describe("the sentence — the limit is reached, and how to upgrade — in both languages", () => {
  const t = (lang: string) => i18n.getFixedT(lang);
  const CASES: { cap: number | null; en: string; ro: string }[] = [
    {
      cap: 1,
      en: "Your plan includes 1 workspace, so this one can't be restored yet. Upgrade your plan to restore it.",
      ro: "Planul tău include un singur spațiu de lucru, așa că acesta nu poate fi restaurat încă. Treci la un plan superior ca să-l restaurezi.",
    },
    {
      cap: 5,
      en: "Your plan includes 5 workspaces, so this one can't be restored yet. Upgrade your plan to restore it.",
      ro: "Planul tău include 5 spații de lucru, așa că acesta nu poate fi restaurat încă. Treci la un plan superior ca să-l restaurezi.",
    },
    {
      cap: 20,
      en: "Your plan includes 20 workspaces, so this one can't be restored yet. Upgrade your plan to restore it.",
      ro: "Planul tău include 20 de spații de lucru, așa că acesta nu poate fi restaurat încă. Treci la un plan superior ca să-l restaurezi.",
    },
    {
      cap: null,
      en: "Your plan's workspace limit is reached, so this one can't be restored yet. Upgrade your plan to restore it.",
      ro: "Ai atins limita de spații de lucru a planului tău, așa că acesta nu poate fi restaurat încă. Treci la un plan superior ca să-l restaurezi.",
    },
  ];

  it("each limit, sentence for sentence; title and action name the limit and the plans", () => {
    for (const c of CASES) {
      const refusal = { capReached: true, cap: c.cap };
      const e = workspaceRestoreLimitNotice(t("en"), refusal)!;
      const r = workspaceRestoreLimitNotice(t("ro"), refusal)!;
      expect(e.description, `en cap ${c.cap}`).toBe(c.en);
      expect(r.description, `ro cap ${c.cap}`).toBe(c.ro);
      expect([e.title, e.cta, e.href]).toEqual(["Workspace limit reached", "View plans", "/pricing"]);
      expect([r.title, r.cta, r.href]).toEqual(["Ai atins limita de spații de lucru", "Vezi planurile", "/pricing"]);
      for (const text of [e.title, e.description, e.cta, r.title, r.description, r.cta]) {
        expect(text).not.toMatch(/pricing\.|\{\{|\}\}/);
      }
      checked += 2;
    }
  });

  it("a failure that is not the limit has no limit notice", () => {
    expect(workspaceRestoreLimitNotice(t("en"), { capReached: false, cap: null })).toBeNull();
    expect(workspaceRestoreLimitNotice(t("en"), { capReached: false, cap: 3 })).toBeNull();
    checked += 2;
  });

  it("every sentence is in both bundles, with Romanian's three plural forms", () => {
    const p = (bundle: unknown) => (bundle as { pricing: Record<string, string> }).pricing;
    for (const k of ["workspaceRestoreLimitDesc_one", "workspaceRestoreLimitDesc_other", "workspaceRestoreLimitDescNoCount"]) {
      expect(p(en)[k], `en ${k}`).toBeTruthy();
      expect(p(ro)[k], `ro ${k}`).toBeTruthy();
      expect(p(ro)[k]).not.toBe(p(en)[k]);
      checked += 1;
    }
    expect(p(ro).workspaceRestoreLimitDesc_few).toBeTruthy();
    // The upgrade path is a route of the app.
    const app = readFileSync(resolve(process.cwd(), "frontend/App.tsx"), "utf8");
    expect(WORKSPACE_UPGRADE_PATH).toBe("/pricing");
    expect(app).toMatch(/path="\/pricing"/);
    checked += 2;
  });
});

describe("the home screen's Recently deleted shelf", () => {
  for (const lang of ["en", "ro"] as const) {
    it(`${lang}: a restore the plan's limit refuses says the limit and offers the plans — not "couldn't restore"`, async () => {
      await i18n.changeLanguage(lang);
      rpc.error = { message: refusalOf("trial", 1) };
      renderHome();
      await clickRestore();
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      const [title, opts] = toast.error.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }];
      const want = lang === "ro"
        ? {
            title: "Ai atins limita de spații de lucru",
            description: "Planul tău include un singur spațiu de lucru, așa că acesta nu poate fi restaurat încă. Treci la un plan superior ca să-l restaurezi.",
            cta: "Vezi planurile",
            generic: "N-am putut restaura compania.",
          }
        : {
            title: "Workspace limit reached",
            description: "Your plan includes 1 workspace, so this one can't be restored yet. Upgrade your plan to restore it.",
            cta: "View plans",
            generic: "We couldn't restore the company.",
          };
      expect(title).toBe(want.title);
      expect(opts.description).toBe(want.description);
      expect(opts.action.label).toBe(want.cta);
      expect(title).not.toBe(want.generic);
      // The one action opens the plans.
      opts.action.onClick();
      await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/pricing"));
      checked += 1;
    });
  }

  it("a failure that is not the limit keeps the plain sentence — and no upgrade action", async () => {
    rpc.error = { message: "only the owner can restore a workspace" };
    renderHome();
    await clickRestore();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error.mock.calls[0]).toEqual(["We couldn't restore the company."]);
    checked += 1;
  });

  it("a restore that works says nothing about a limit", async () => {
    rpc.error = null;
    renderHome();
    await clickRestore();
    await new Promise((r) => setTimeout(r, 20));
    expect(toast.error).not.toHaveBeenCalled();
    checked += 1;
  });
});

describe("the legacy workspace page's shelf", () => {
  it("its restore handler asks for the limit notice before the plain sentence, and opens the plans from it", () => {
    const page = readFileSync(resolve(process.cwd(), "frontend/pages/cfo/Workspace.tsx"), "utf8");
    const fn = /async function restoreWorkspace\(id: string, name: string\) \{[\s\S]*?\n {2}\}\n/.exec(page)?.[0] ?? "";
    expect(fn, "the handler was not found").not.toBe("");
    const limitAt = fn.indexOf("workspaceRestoreLimitNotice(t)");
    const genericAt = fn.indexOf('t("ws.cantRestoreWorkspace")');
    expect(limitAt).toBeGreaterThan(-1);
    expect(genericAt).toBeGreaterThan(limitAt);
    expect(fn).toMatch(/toast\.error\(limit\.title, \{\s*description: limit\.description,\s*action: \{ label: limit\.cta, onClick: \(\) => navigate\(limit\.href\) \},/);
    expect(fn).toMatch(/if \(limit\) \{[\s\S]*?return;\s*\}/);
    checked += 1;
  });
});
