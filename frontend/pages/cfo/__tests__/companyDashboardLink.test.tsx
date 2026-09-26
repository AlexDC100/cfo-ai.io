// GATE G6, the sidebar's half — the Dashboard row on a company page leads to
// THAT company (workspace redesign, 2026-09-26).
//
// Owner-reported: with Agras open (its company page, no analysed year) the
// sidebar's Dashboard landed on /dashboard?period=<one of Scandia's> while
// the header read "Agras SRL · dec. 2025". Rule: a dashboard link from a
// company page opens that company's latest analysed period, or, when it has
// none, the company page itself with its one-line state ("No analysis yet /
// Nicio analiză încă"); the header always describes the screen.
//
// Scope: the REAL Sidebar rendered beside the REAL CompanyPage and the real
// capsule-label hook, with the years each company has read from the same
// mocked engine route the page reads.
//
// Fails on: the Dashboard row carrying any period on a company page with no
// analysed year; the row not carrying the company's own latest period (with
// the company pinned) when it has one; the row losing its `?period=` link off
// a company page or with the redesign off; the page painting under a header
// naming another company.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { TestProviders } from "@/test/renderWithProviders";
import { useCapsuleLabel } from "@/components/instrument/shell/ContextObject";
import { writeWorkspaceName } from "@/lib/workspaceName";
import { __setFeaturesForTest } from "@/lib/features";
import { clearDataPresence, writePeriodVerdict } from "@/lib/dataPresence";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// ── the workspace store, shaped like lib/org's useActiveOrg ────────────
const orgStore = vi.hoisted(() => {
  type Org = { id: string; name: string; industry_key: string | null; industry_display_name: null; archived_at: null; created_at: string };
  const orgs: Org[] = [
    { id: "scandia", name: "Scandia Food SRL", industry_key: "fmcg", industry_display_name: null, archived_at: null, created_at: "2025-01-01" },
    { id: "agras", name: "Agras SRL", industry_key: "agriculture", industry_display_name: null, archived_at: null, created_at: "2025-02-01" },
  ];
  const state = { activeId: "scandia" as string | null, orgs, version: 0 };
  const listeners = new Set<() => void>();
  const emit = () => {
    state.version++;
    listeners.forEach((l) => l());
  };
  return { state, listeners, emit };
});
const switchOrg = vi.fn(async (id: string) => {
  await new Promise((r) => setTimeout(r, 5));
  orgStore.state.activeId = id;
  orgStore.emit();
  const org = orgStore.state.orgs.find((o) => o.id === id);
  if (org) writeWorkspaceName(org.name);
});
vi.mock("@/lib/org", async () => {
  const { useSyncExternalStore: useStore } = await import("react");
  return {
    useActiveOrg: () => {
      useStore(
        (cb) => {
          orgStore.listeners.add(cb);
          return () => orgStore.listeners.delete(cb);
        },
        () => orgStore.state.version,
      );
      const org = orgStore.state.orgs.find((o) => o.id === orgStore.state.activeId) ?? null;
      return {
        org,
        orgs: orgStore.state.orgs,
        archived: [],
        loading: false,
        loadError: false,
        needsOnboarding: false,
        refresh: async () => {},
        switchOrg,
        createWorkspace: async () => null,
        renameWorkspace: async () => true,
        setWorkspaceIndustry: async () => true,
        archiveWorkspace: async () => true,
        restoreWorkspace: async () => true,
        purgeWorkspace: async () => true,
      };
    },
    activateWorkspace: vi.fn(async () => true),
    daysUntilPurge: () => 30,
  };
});

// The header's month half — a company page resolves no month here.
vi.mock("@/lib/usePeriodStepper", () => ({
  usePeriodStepper: () => ({
    periods: [],
    selectedEnd: null,
    selectedMonth: null,
    selectedYear: null,
    prevTarget: null,
    nextTarget: null,
    showStepper: false,
    goToPeriod: () => {},
  }),
}));

// The years each company has — the SAME route the company page reads.
const YEARS: Record<string, unknown[]> = {
  scandia: [
    { period_id: "p-2024", year: 2024, period_end: "2024-12-31", revenue: 100_000_000, revenue_change_pct: null },
    { period_id: "p-2025", year: 2025, period_end: "2025-12-31", revenue: 118_600_000, revenue_change_pct: 18.6 },
  ],
  agras: [],
};
vi.mock("@/lib/uploadsApi", () => ({
  fetchCompanyYears: vi.fn(async (orgId: string) => YEARS[orgId] ?? []),
  fetchCompanyDirectory: vi.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { cui: id === "agras" ? "46355095" : "16070576", companyName: id }])),
  ),
}));

// The sidebar's other dependencies — signed in, nothing in flight.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ status: "signed_in", user: { id: "u1", email: "owner@example.test" }, displayName: "Owner", initials: "O" }),
}));
vi.mock("@/lib/activePeriod", () => ({
  usePrefetchPeriod: () => () => {},
  useActivePeriod: () => ({ id: null, isLoading: false, isLoaded: false, organizationId: null, periodEnd: null }),
}));
vi.mock("@/lib/unsavedGuard", () => ({ confirmLeaveUnsaved: () => true }));
vi.mock("@/components/cfo/NotificationsMenu", () => ({ NotificationsMenu: () => null }));
vi.mock("@/components/cfo/CurrencyToggle", () => ({ CurrencyToggle: () => null }));

import CompanyPage from "@/pages/cfo/CompanyPage";
import { Sidebar } from "@/components/cfo/Sidebar";

function HeaderProbe() {
  const label = useCapsuleLabel();
  return <div data-testid="header-capsule-label">{label}</div>;
}

/** Every company named as "on screen" must be the one the header names. */
function assertHeaderNamesScreenCompany(root: ParentNode): void {
  const header = root.querySelector('[data-testid="header-capsule-label"]')?.textContent ?? "";
  root.querySelectorAll("[data-company-on-screen]").forEach((el) => {
    const name = el.getAttribute("data-company-on-screen") ?? "";
    if (!header.startsWith(name)) throw new Error(`page shows "${name}" under a header naming "${header}"`);
  });
}

function watchForDesync(root: HTMLElement): { violations: string[]; stop: () => void } {
  const violations: string[] = [];
  const check = () => {
    try {
      assertHeaderNamesScreenCompany(root);
    } catch (e) {
      violations.push((e as Error).message);
    }
  };
  const obs = new MutationObserver(check);
  obs.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  check();
  return { violations, stop: () => obs.disconnect() };
}

function renderShell(route: string) {
  return render(
    <TestProviders route={route}>
      <HeaderProbe />
      <Sidebar onSettings={() => {}} />
      <Routes>
        <Route path="/workspace/:orgId" element={<CompanyPage />} />
        <Route path="*" element={<div data-testid="elsewhere" />} />
      </Routes>
    </TestProviders>,
  );
}

const dashboardRow = () => screen.getByTestId("sidebar-dashboard");

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  clearDataPresence();
  orgStore.state.activeId = "scandia";
  orgStore.emit();
  writeWorkspaceName("Scandia Food SRL");
  switchOrg.mockClear();
  __setFeaturesForTest({ workspace_v2: { status: "active", label: "Workspace v2", description: "" } });
});
afterEach(() => {
  cleanup();
  writeWorkspaceName("");
});

describe("G6 — the Dashboard row on a company page", () => {
  it("Agras open, no analysed year, Scandia's month remembered: the row stays on Agras's page with its one-line state", async () => {
    // The verdict the old code handed to a bare /dashboard: Scandia's month.
    writePeriodVerdict("u1", "p-2025", "scandia");
    writePeriodVerdict("u1", "p-2025");
    const { container } = renderShell("/workspace/agras");
    const watch = watchForDesync(container);

    await waitFor(() => expect(switchOrg).toHaveBeenCalledWith("agras"));
    expect(await screen.findByTestId("company-no-years")).toHaveTextContent("No analysis yet");
    await waitFor(() => expect(dashboardRow()).toHaveAttribute("href", "/workspace/agras"));
    expect(dashboardRow().getAttribute("href")).not.toMatch(/p-2025|dashboard/);
    expect(screen.getByTestId("header-capsule-label").textContent).toMatch(/^Agras/);
    watch.stop();
    expect(watch.violations, "the page painted one company under a header naming another").toEqual([]);
  });

  it("Scandia open, two analysed years: the row opens ITS latest year, the company pinned", async () => {
    renderShell("/workspace/scandia");
    await screen.findByTestId("company-year-2025");
    await waitFor(() => expect(dashboardRow()).toHaveAttribute("href", "/dashboard?period=p-2025&org=scandia"));
    expect(screen.getByTestId("header-capsule-label").textContent).toMatch(/^Scandia/);
  });

  it("off a company page the row keeps the period on screen", async () => {
    renderShell("/benchmark?period=p-2024");
    await screen.findByTestId("elsewhere");
    expect(dashboardRow()).toHaveAttribute("href", "/dashboard?period=p-2024");
  });

  it("with the redesign off, the row is untouched", async () => {
    __setFeaturesForTest({});
    renderShell("/workspace/agras");
    await screen.findByTestId("company-title");
    expect(dashboardRow()).toHaveAttribute("href", "/dashboard");
  });

  it("Romanian: the one-line state", async () => {
    await i18n.changeLanguage("ro");
    renderShell("/workspace/agras");
    expect(await screen.findByTestId("company-no-years")).toHaveTextContent("Nicio analiză încă");
    await waitFor(() => expect(dashboardRow()).toHaveAttribute("href", "/workspace/agras"));
  });
});
