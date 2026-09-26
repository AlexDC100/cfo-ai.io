// useActivePeriodFallback — a bare URL resolves a period FOR THE ACTIVE
// COMPANY (workspace redesign, G6, 2026-09-26).
//
// Owner-reported: with Agras open (no analysed year) a bare /dashboard was
// canonicalized to one of Scandia's periods. Two causes, one hook: the lookup
// sent the bearer alone (the engine answered for the caller's OLDEST
// membership), and the remembered verdict was per user, not per company.
//
// Fails on: the lookup not naming the active company (X-Org-Id); a verdict
// remembered for one company used for another; a company with nothing
// analysed being sent to another company's month; the active company's own
// period not resolving, or being remembered under the wrong company.
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setActiveOrgId, clearActiveOrg } from "@/lib/activeOrg";
import { clearDataPresence, readPeriodVerdict, writePeriodVerdict } from "@/lib/dataPresence";

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "tok", user: { id: "u1" } } } }) },
  }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signed_in", user: { id: "u1" } }) }));
vi.mock("@/lib/testMode", () => ({ isPublicTestMode: false }));
vi.mock("@/lib/orgPeriods", () => ({
  fetchWorkspacePeriodsDirect: vi.fn(async () => ({ active_period_id: null, periods: [] })),
  isCurrentMonthPeriod: () => false,
}));

import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";

/** The engine, per company: Scandia has a period, Agras has none. Without
 *  the header it answers for the oldest membership — Scandia. */
const calls: Array<{ url: string; org: string | null }> = [];
function installEngine() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const org = ((init?.headers ?? {}) as Record<string, string>)["X-Org-Id"] ?? null;
      calls.push({ url, org });
      const body = org === "agras"
        ? { active_period_id: null, periods: [], recently_deleted: [] }
        : { active_period_id: "p-scandia-2025", periods: [], recently_deleted: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

function Probe() {
  // `basePath`: the hook canonicalizes `window.location.pathname`, which a
  // MemoryRouter does not drive — the dashboard's own path is passed.
  const { status } = useActivePeriodFallback({ basePath: "/dashboard" });
  const loc = useLocation();
  return (
    <>
      <div data-testid="status">{status}</div>
      <div data-testid="location">{loc.pathname + loc.search}</div>
    </>
  );
}

function renderAt(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Probe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  clearDataPresence();
  clearActiveOrg();
  calls.length = 0;
  installEngine();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useActivePeriodFallback resolves for the active company", () => {
  it("Agras open, nothing analysed: the lookup names Agras and the page stays bare — never Scandia's month", async () => {
    setActiveOrgId("u1", "agras");
    renderAt("/dashboard");
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]!.url).toMatch(/\/api\/org\/periods-with-documents$/);
    expect(calls[0]!.org, "the lookup must name the active company").toBe("agras");
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("none"));
    expect(screen.getByTestId("location")).toHaveTextContent("/dashboard");
    expect(screen.getByTestId("location").textContent).not.toContain("p-scandia");
  });

  it("a period remembered for Scandia is not Agras's: Agras resolves on its own", async () => {
    writePeriodVerdict("u1", "p-scandia-2025", "scandia");
    setActiveOrgId("u1", "agras");
    renderAt("/dashboard");
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]!.org).toBe("agras");
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("none"));
    expect(screen.getByTestId("location").textContent).not.toContain("p-scandia");
    expect(readPeriodVerdict("u1", "scandia")).toBe("p-scandia-2025");
    expect(readPeriodVerdict("u1", "agras")).toBeNull();
  });

  it("Scandia open: its own period resolves and is remembered for Scandia only", async () => {
    setActiveOrgId("u1", "scandia");
    renderAt("/dashboard");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/dashboard?period=p-scandia-2025"));
    expect(calls[0]!.org).toBe("scandia");
    expect(readPeriodVerdict("u1", "scandia")).toBe("p-scandia-2025");
    expect(readPeriodVerdict("u1", "agras")).toBeUndefined();
  });

  it("a verdict remembered for the active company is used without a round-trip", async () => {
    writePeriodVerdict("u1", "p-scandia-2025", "scandia");
    setActiveOrgId("u1", "scandia");
    renderAt("/dashboard");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/dashboard?period=p-scandia-2025"));
    expect(calls).toEqual([]);
  });
});
