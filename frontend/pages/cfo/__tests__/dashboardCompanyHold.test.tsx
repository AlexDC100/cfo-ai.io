// GATE G6, the stale-link half — a dashboard opened on another company's
// period switches the active company FIRST (workspace redesign, 2026-09-26).
//
// Browser Back, a bookmark, a link pasted from another device: `?period=<id>`
// alone, no `?org=`. The engine says which company the period belongs to
// (`organization.id` on the payload); the shell must switch to it and hold
// the page until the header names it — never paint one company's month under
// another company's header. `useDashboardCompanyHold` is the hook AppShell
// holds on.
//
// Fails on: no hold while the period's company is not the active one; no
// switch; the page released under a header naming the wrong company; a
// `?org=` link no longer held (the earlier rule, kept).
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TestProviders } from "@/test/renderWithProviders";
import { useCapsuleLabel } from "@/components/instrument/shell/ContextObject";
import { useWorkspaceName, writeWorkspaceName } from "@/lib/workspaceName";

const orgStore = vi.hoisted(() => {
  type Org = { id: string; name: string; industry_key: string | null; archived_at: null; created_at: string };
  const orgs: Org[] = [
    { id: "scandia", name: "Scandia Food SRL", industry_key: "fmcg", archived_at: null, created_at: "2025-01-01" },
    { id: "agras", name: "Agras SRL", industry_key: "agriculture", archived_at: null, created_at: "2025-02-01" },
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
      return { org, orgs: orgStore.state.orgs, archived: [], loading: false, loadError: false, needsOnboarding: false, refresh: async () => {}, switchOrg };
    },
    activateWorkspace: vi.fn(async () => true),
    daysUntilPurge: () => 30,
  };
});

// The period on screen — what /api/period answered for `?period=`.
const periodState = vi.hoisted(() => ({ organizationId: null as string | null, periodEnd: null as string | null }));
vi.mock("@/lib/activePeriod", () => ({
  usePrefetchPeriod: () => () => {},
  useActivePeriod: () => ({ id: "p-x", isLoading: false, isLoaded: true, organizationId: periodState.organizationId, periodEnd: periodState.periodEnd }),
}));
vi.mock("@/lib/usePeriodStepper", () => ({
  usePeriodStepper: () => ({ periods: [], selectedEnd: periodState.periodEnd, selectedMonth: null, selectedYear: null, prevTarget: null, nextTarget: null, showStepper: false, goToPeriod: () => {} }),
}));
vi.mock("@/lib/uploadsApi", () => ({ fetchCompanyYears: vi.fn(async () => []), fetchCompanyDirectory: vi.fn(async () => ({})) }));

import { useDashboardCompanyHold } from "@/lib/companyOnScreen";

function HeaderProbe() {
  return <div data-testid="header-capsule-label">{useCapsuleLabel()}</div>;
}

/** AppShell's composition: the hold, and the page (naming the active company) only when released. */
function Probe({ enabled }: { enabled: boolean }) {
  const holding = useDashboardCompanyHold(enabled);
  const name = useWorkspaceName();
  return (
    <>
      <HeaderProbe />
      <div data-testid="hold" data-holding={String(holding)}>
        {holding ? null : <span data-company-on-screen={name}>{name}</span>}
      </div>
    </>
  );
}

function watchForDesync(root: HTMLElement): { violations: string[]; stop: () => void } {
  const violations: string[] = [];
  const check = () => {
    const header = root.querySelector('[data-testid="header-capsule-label"]')?.textContent ?? "";
    root.querySelectorAll("[data-company-on-screen]").forEach((el) => {
      const name = el.getAttribute("data-company-on-screen") ?? "";
      if (!header.startsWith(name)) violations.push(`page shows "${name}" under a header naming "${header}"`);
    });
  };
  const obs = new MutationObserver(check);
  obs.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  check();
  return { violations, stop: () => obs.disconnect() };
}

beforeEach(() => {
  orgStore.state.activeId = "scandia";
  orgStore.emit();
  writeWorkspaceName("Scandia Food SRL");
  switchOrg.mockClear();
  periodState.organizationId = null;
  periodState.periodEnd = null;
});
afterEach(() => writeWorkspaceName(""));

describe("G6 — a dashboard opened on another company's period switches the company first", () => {
  it("?period= alone, the period is Agras's, Scandia is active: hold, switch, then Agras under Agras", async () => {
    periodState.organizationId = "agras";
    periodState.periodEnd = "2025-12-31";
    const { container } = render(
      <TestProviders route="/dashboard?period=p-x">
        <Probe enabled />
      </TestProviders>,
    );
    const watch = watchForDesync(container);
    expect(screen.getByTestId("hold")).toHaveAttribute("data-holding", "true");
    await waitFor(() => expect(switchOrg).toHaveBeenCalledWith("agras"));
    await waitFor(() => expect(screen.getByTestId("hold")).toHaveAttribute("data-holding", "false"));
    expect(screen.getByTestId("header-capsule-label").textContent).toMatch(/^Agras/);
    watch.stop();
    expect(watch.violations).toEqual([]);
  });

  it("the period is the active company's own: nothing held, nothing switched", () => {
    periodState.organizationId = "scandia";
    render(
      <TestProviders route="/dashboard?period=p-x">
        <Probe enabled />
      </TestProviders>,
    );
    expect(screen.getByTestId("hold")).toHaveAttribute("data-holding", "false");
    expect(switchOrg).not.toHaveBeenCalled();
  });

  it("a redesign link's ?org= still holds while the payload is out", async () => {
    render(
      <TestProviders route="/dashboard?period=p-x&org=agras">
        <Probe enabled />
      </TestProviders>,
    );
    expect(screen.getByTestId("hold")).toHaveAttribute("data-holding", "true");
    await waitFor(() => expect(switchOrg).toHaveBeenCalledWith("agras"));
  });

  it("with the redesign off, nothing is held", () => {
    periodState.organizationId = "agras";
    render(
      <TestProviders route="/dashboard?period=p-x">
        <Probe enabled={false} />
      </TestProviders>,
    );
    expect(screen.getByTestId("hold")).toHaveAttribute("data-holding", "false");
    expect(switchOrg).not.toHaveBeenCalled();
  });
});
