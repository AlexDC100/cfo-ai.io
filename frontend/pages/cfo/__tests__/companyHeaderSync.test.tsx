// GATE G6 — the header names the company on screen (workspace redesign).
//
// Owner rule: "the header ALWAYS names the company on screen — a Scandia page
// never shows another workspace in the header". The header prints the ACTIVE
// workspace (useCapsuleLabel ← lib/workspaceName, written by lib/org on every
// switch). A company page opened while another workspace is active must
// switch first and show nothing of its company until the header agrees.
//
// Scope: CompanyPage (/workspace/:orgId) rendered beside the REAL capsule
// label hook the TopHeader prints, with a workspace store whose switch lands
// in the worst order (active id first, header name a tick later).
//
// Fails on: the company's title ever present in the DOM while the header
// label names another company (watched on EVERY mutation, not just at the
// end); the page never switching; the title never arriving once in sync.
// Plant-proven: a company page that skips the sync (useCompanyOnScreen
// forced "ready") turns it red, and so does a hand-built desynced DOM.
import { act, render, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";

import { TestProviders } from "@/test/renderWithProviders";
import { useCapsuleLabel } from "@/components/instrument/shell/ContextObject";
import { writeWorkspaceName } from "@/lib/workspaceName";
import { __setFeaturesForTest } from "@/lib/features";

// ── A workspace store shaped like lib/org's useActiveOrg ───────────────
const orgStore = vi.hoisted(() => {
  type Org = { id: string; name: string; industry_key: string | null; archived_at: null; created_at: string };
  const orgs: Org[] = [
    { id: "scandia", name: "Scandia", industry_key: "fmcg", archived_at: null, created_at: "2025-01-01" },
    { id: "agras", name: "Agras", industry_key: "agriculture", archived_at: null, created_at: "2025-02-01" },
  ];
  const state = { activeId: "scandia" as string | null, orgs, version: 0 };
  const listeners = new Set<() => void>();
  const emit = () => {
    state.version++;
    listeners.forEach((l) => l());
  };
  return { state, listeners, emit };
});

// The switch lands asynchronously and in the worst order a real one could:
// the ACTIVE ID first, the header name a tick later.
const switchOrg = vi.fn(async (id: string) => {
  await new Promise((r) => setTimeout(r, 5));
  orgStore.state.activeId = id;
  orgStore.emit();
  await new Promise((r) => setTimeout(r, 5));
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

// The header's month half — not under test here.
vi.mock("@/lib/usePeriodStepper", () => ({
  usePeriodStepper: () => ({
    periods: [],
    selectedEnd: "2025-12-31",
    selectedMonth: "Dec 2025",
    selectedYear: "2025",
    prevTarget: null,
    nextTarget: null,
    showStepper: false,
    goToPeriod: () => {},
  }),
}));

vi.mock("@/lib/uploadsApi", () => ({
  fetchCompanyYears: vi.fn(async () => [
    { period_id: "p-2024", year: 2024, period_end: "2024-12-31", revenue: 100_000_000, revenue_change_pct: null },
    { period_id: "p-2025", year: 2025, period_end: "2025-12-31", revenue: 118_600_000, revenue_change_pct: 18.6 },
  ]),
  fetchCompanyDirectory: vi.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { cui: id === "agras" ? "RO7654321" : "RO1234567", companyName: id }])),
  ),
}));

import CompanyPage from "@/pages/cfo/CompanyPage";

/** What the TopHeader prints in its capsule — the real hook. */
function HeaderProbe() {
  const label = useCapsuleLabel();
  return <div data-testid="header-capsule-label">{label}</div>;
}

/**
 * The law, as a DOM check: every company named as "on screen" must be the
 * company the header names. Throws on a desync.
 */
export function assertHeaderNamesScreenCompany(root: ParentNode): void {
  const header = root.querySelector('[data-testid="header-capsule-label"]')?.textContent ?? "";
  root.querySelectorAll("[data-company-on-screen]").forEach((el) => {
    const name = el.getAttribute("data-company-on-screen") ?? "";
    if (!header.startsWith(name)) {
      throw new Error(`page shows "${name}" under a header naming "${header}"`);
    }
  });
}

function renderCompanyPage(orgId: string) {
  return render(
    <TestProviders route={`/workspace/${orgId}`}>
      <HeaderProbe />
      <Routes>
        <Route path="/workspace/:orgId" element={<CompanyPage />} />
      </Routes>
    </TestProviders>,
  );
}

/** Watch every DOM mutation for a desync — a flash counts. */
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

beforeEach(() => {
  orgStore.state.activeId = "scandia";
  orgStore.emit();
  writeWorkspaceName("Scandia");
  switchOrg.mockClear();
  __setFeaturesForTest({});
});

afterEach(() => {
  writeWorkspaceName("");
});

describe("G6 — a company page renders only under a header that names it", () => {
  it("opening Agras while Scandia is active switches first, and never shows Agras under Scandia", async () => {
    const { container } = renderCompanyPage("agras");
    const watch = watchForDesync(container);

    // Before the switch lands: a neutral hold, nothing of Agras.
    expect(screen.getByTestId("company-page-hold")).toBeInTheDocument();
    expect(screen.queryByTestId("company-title")).toBeNull();
    await waitFor(() => expect(switchOrg).toHaveBeenCalledWith("agras"));

    const title = await screen.findByTestId("company-title");
    expect(title).toHaveTextContent("Agras");
    expect(screen.getByTestId("header-capsule-label").textContent).toMatch(/^Agras/);
    watch.stop();
    expect(watch.violations, "the page painted one company under a header naming another").toEqual([]);
  });

  it("the company already active renders at once, without a switch", async () => {
    const { container } = renderCompanyPage("scandia");
    const watch = watchForDesync(container);
    expect(await screen.findByTestId("company-title")).toHaveTextContent("Scandia");
    expect(switchOrg).not.toHaveBeenCalled();
    watch.stop();
    expect(watch.violations).toEqual([]);
  });

  it("a stale header name for the SAME company is rewritten before the page shows", async () => {
    writeWorkspaceName("Old name");
    const { container } = renderCompanyPage("scandia");
    const watch = watchForDesync(container);
    expect(await screen.findByTestId("company-title")).toHaveTextContent("Scandia");
    expect(screen.getByTestId("header-capsule-label").textContent).toMatch(/^Scandia/);
    watch.stop();
    expect(watch.violations).toEqual([]);
  });

  it("a company that is not mine says so and switches nothing", async () => {
    renderCompanyPage("someone-elses");
    expect(await screen.findByTestId("company-page-missing")).toBeInTheDocument();
    expect(switchOrg).not.toHaveBeenCalled();
  });

  it("PLANT: a hand-built desynced screen is caught", () => {
    const { container } = render(
      <TestProviders>
        <HeaderProbe />
        <h1 data-company-on-screen="Agras">Agras</h1>
      </TestProviders>,
    );
    expect(() => assertHeaderNamesScreenCompany(container)).toThrow(/page shows "Agras" under a header naming "Scandia/);
  });

  it("PLANT: a company page that skips the sync turns the gate red", async () => {
    vi.resetModules();
    vi.doMock("@/lib/companyOnScreen", () => ({
      // The defect: declare the page ready without switching the workspace.
      useCompanyOnScreen: (orgId: string) => ({
        status: "ready",
        org: { id: orgId, name: orgId === "agras" ? "Agras" : "Scandia", industry_key: null },
      }),
    }));
    const { default: DesyncedPage } = await import("@/pages/cfo/CompanyPage");
    const { useCapsuleLabel: capsule } = await import("@/components/instrument/shell/ContextObject");
    // Fresh module graph → fresh providers, or the page's context hooks
    // would look for a provider instance the old graph created.
    const { TestProviders: FreshProviders } = await import("@/test/renderWithProviders");
    const Probe = () => <div data-testid="header-capsule-label">{capsule()}</div>;
    const { container } = render(
      <FreshProviders route="/workspace/agras">
        <Probe />
        <Routes>
          <Route path="/workspace/:orgId" element={<DesyncedPage />} />
        </Routes>
      </FreshProviders>,
    );
    const watch = watchForDesync(container);
    await screen.findByTestId("company-title");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    watch.stop();
    expect(watch.violations.length, "the planted desync went unnoticed").toBeGreaterThan(0);
    vi.doUnmock("@/lib/companyOnScreen");
    vi.resetModules();
  });
});

// Keep the import used (React's hook is referenced inside the hoisted mock).
void useSyncExternalStore;
