// THE COMPARISON NEVER LEAVES ITS COMPANY (live walkthrough, 2026-09-26).
//
// Scandia Food's dashboard, then EEI's (or a second group company's)
// analysed period: EEI's Overview printed "No comparison: period
// '<uuid>' is not in this workspace" — a period of Scandia's. The
// "compare with" choice lived under ONE browser-wide key, so the prior picked
// (or synced) on Scandia was still the choice on EEI; the page asked the
// engine to compare EEI's period with it, and printed the engine's refusal
// message, raw period id included.
//
// The rule these gates hold:
//   · the prior is chosen ONLY among the periods of the company the period on
//     screen belongs to (the list and the request are keyed by that company);
//   · a stored choice that is not one of them is ignored silently (AUTO);
//   · a company with one period shows no comparison — no request, no error;
//   · the stored choice itself is per company, never carried to the next;
//   · (G6-style) switching company, no request carries the other company's
//     period.
//
// Fails on: the old browser-wide store (a Scandia choice read on EEI), a
// stored foreign id reaching the request, a request whose X-Org-Id is not the
// company both periods belong to, any request after the switch naming a
// period of the company left behind.
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestQueryClient } from "@/test/renderWithProviders";

// ── The two companies, as the engine serves them ───────────────────────
const SCANDIA = "0a9a0000-0000-4000-8000-000000000051";
const EEI = "0a9a0000-0000-4000-8000-0000000000e1";
const S25 = "5ea50000-0000-4000-8000-0000000051f5"; // Scandia Dec 2025
const S24 = "5ea50000-0000-4000-8000-0000000051f4"; // Scandia Dec 2024
const E25 = "5ea50000-0000-4000-8000-00000000e125"; // EEI Dec 2025 — its only period

const PERIODS: Record<string, { id: string; end: string }[]> = {
  [SCANDIA]: [
    { id: S25, end: "2025-12-31" },
    { id: S24, end: "2024-12-31" },
  ],
  [EEI]: [{ id: E25, end: "2025-12-31" }],
};

const session = vi.hoisted(() => ({ activeOrg: "0a9a0000-0000-4000-8000-000000000051" }));
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "tok", user: { id: "u1" } } } }) },
  }),
  currentOrgId: async () => session.activeOrg,
}));

interface Seen {
  url: string;
  org: string | null;
}
const seen: Seen[] = [];

function periodsWithDocuments(org: string) {
  return {
    active_period_id: PERIODS[org]?.[0]?.id ?? null,
    periods: (PERIODS[org] ?? []).map((p) => ({
      period_id: p.id,
      period_label: p.end,
      period_start: p.end.slice(0, 4) + "-01-01",
      period_end: p.end,
      documents: [{ id: `doc-${p.id}`, status: "analyzed" }],
    })),
  };
}

beforeEach(() => {
  seen.length = 0;
  session.activeOrg = SCANDIA;
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const org = headers["X-Org-Id"] ?? null;
      seen.push({ url, org });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/org/periods-with-documents")) return json(200, periodsWithDocuments(org ?? ""));
      const cmp = /\/api\/period\/([^/?]+)\/comparatives\?prior=([^&]+)/.exec(url);
      if (cmp) {
        // THE ENGINE'S WALL (_comparatives.load_period_in_org): both periods
        // must live in the X-Org-Id company, or "period '<id>' is not in
        // this workspace".
        const ids = (PERIODS[org ?? ""] ?? []).map((p) => p.id);
        const [cur, prior] = [decodeURIComponent(cmp[1]), decodeURIComponent(cmp[2])];
        const missing = !ids.includes(cur) ? cur : !ids.includes(prior) ? prior : null;
        if (missing) {
          return json(404, { detail: { code: "period_not_in_workspace", message: `period '${missing}' is not in this workspace` } });
        }
        return json(200, { current: { period_id: cur }, prior: { period_id: prior } });
      }
      return json(404, { detail: "not modelled" });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const { comparisonChoiceOf, useComparatives, useComparisonChoice } = await import("@/lib/comparatives");
const { ComparativesViewProvider, useComparativesView, COMPARATIVES_VIEW_KEY_PREFIX } = await import(
  "@/stores/comparativesView"
);

const company = (org: string) => ({
  orgId: org,
  periods: (PERIODS[org] ?? []).map((p) => ({
    period_id: p.id,
    period_label: p.end,
    period_start: null,
    period_end: p.end,
    documents: [{ id: `doc-${p.id}` }],
  })),
});

describe("the rule — the prior is one of the current company's own periods", () => {
  const onScandia = { currentId: S25, currentEnd: "2025-12-31", currentOrgId: SCANDIA, activeOrgId: SCANDIA };
  const onEei = { currentId: E25, currentEnd: "2025-12-31", currentOrgId: EEI, activeOrgId: EEI };

  it("AUTO on Scandia is Scandia's previous year-end", () => {
    expect(comparisonChoiceOf({ ...onScandia, stored: null }, company(SCANDIA)).priorId).toBe(S24);
  });

  it("a stored choice that is one of the company's periods is used", () => {
    expect(comparisonChoiceOf({ ...onScandia, stored: S24 }, company(SCANDIA)).priorId).toBe(S24);
  });

  it("Scandia's stored choice on EEI is ignored silently: EEI has one period, so no prior", () => {
    const got = comparisonChoiceOf({ ...onEei, stored: S24 }, company(EEI));
    expect(got).toEqual({ companyId: EEI, periods: company(EEI).periods, autoPick: null, priorId: null });
  });

  it("a period list of another company is never read as this company's", () => {
    expect(comparisonChoiceOf({ ...onEei, stored: null }, company(SCANDIA)).priorId).toBeNull();
  });

  it("while the company open now is not the period's company (a switch settling), nothing is chosen", () => {
    const settling = { ...onEei, activeOrgId: SCANDIA };
    expect(comparisonChoiceOf({ ...settling, stored: null }, company(EEI))).toEqual({
      companyId: null,
      periods: [],
      autoPick: null,
      priorId: null,
    });
  });

  it("comparisons off stays off; the period itself is never its own prior", () => {
    expect(comparisonChoiceOf({ ...onScandia, stored: "none" }, company(SCANDIA)).priorId).toBeNull();
    expect(comparisonChoiceOf({ ...onScandia, stored: S25 }, company(SCANDIA)).priorId).toBe(S24);
  });
});

// ── The stored choice is per company ───────────────────────────────────

let latest: ReturnType<typeof useComparativesView> | null = null;
function ViewProbe() {
  latest = useComparativesView();
  return null;
}

describe("the 'compare with' choice is stored per company", () => {
  it("a choice made on Scandia is not EEI's, and Scandia's comes back on Scandia", async () => {
    const view = (org: string | null) => (
      <ComparativesViewProvider orgId={org}>
        <ViewProbe />
      </ComparativesViewProvider>
    );
    const r = render(view(SCANDIA));
    act(() => latest!.setPriorPeriodId(S24));
    expect(latest!.view.priorPeriodId).toBe(S24);

    r.rerender(view(EEI));
    expect(latest!.view.priorPeriodId, "Scandia's prior carried over to EEI").toBeNull();
    expect(latest!.orgId).toBe(EEI);

    r.rerender(view(SCANDIA));
    await waitFor(() => expect(latest!.view.priorPeriodId).toBe(S24));
    // Stored under a key that names the company.
    expect(JSON.parse(window.localStorage.getItem(COMPARATIVES_VIEW_KEY_PREFIX + SCANDIA)!).priorPeriodId).toBe(S24);
    expect(window.localStorage.getItem(COMPARATIVES_VIEW_KEY_PREFIX + EEI)).toBeNull();
  });

  it("the old browser-wide key — which says nothing about the company — is never read", () => {
    window.localStorage.setItem(
      "cfo:comparatives-view:v1",
      JSON.stringify({ priorPeriodId: S24, columns: { prior: true, delta: true, deltaPct: true, share: true } }),
    );
    // Nor a choice stored for this company before v2 (written by that same
    // browser-wide store): e.g. a "No comparison" made on another company.
    window.localStorage.setItem(
      "cfo:comparatives-view:v1:" + EEI,
      JSON.stringify({ priorPeriodId: "none", columns: { prior: true, delta: true, deltaPct: true, share: true } }),
    );
    render(
      <ComparativesViewProvider orgId={EEI}>
        <ViewProbe />
      </ComparativesViewProvider>,
    );
    expect(latest!.view.priorPeriodId).toBeNull();
  });
});

// ── G6-style, at the hook level: switch company, no foreign period ─────

interface Screen {
  periodId: string;
  periodEnd: string;
  periodOrg: string;
  activeOrg: string;
}

let choice: ReturnType<typeof useComparisonChoice> | null = null;
let query: ReturnType<typeof useComparatives> | null = null;
function Dashboard({ screen }: { screen: Screen }) {
  const view = useComparativesView();
  choice = useComparisonChoice({
    currentId: screen.periodId,
    currentEnd: screen.periodEnd,
    currentOrgId: screen.periodOrg,
    activeOrgId: screen.activeOrg,
    stored: view.view.priorPeriodId,
  });
  query = useComparatives(screen.periodId, choice.priorId, choice.companyId);
  // The reader picked Scandia's 2024 on Scandia's dashboard.
  useEffect(() => {
    if (screen.activeOrg === SCANDIA && view.view.priorPeriodId === null) view.setPriorPeriodId(S24);
  }, [screen.activeOrg, view]);
  return null;
}

function App({ screen, children }: { screen: Screen; children?: ReactNode }) {
  return (
    <ComparativesViewProvider orgId={screen.activeOrg}>
      <Dashboard screen={screen} />
      {children}
    </ComparativesViewProvider>
  );
}

describe("G6-style — switching company, no request names the other company's period", () => {
  it("Scandia (two years, a chosen prior) → EEI (one year): no comparison, no error, no Scandia id anywhere", async () => {
    const qc = createTestQueryClient();
    const wrap = (screen: Screen) => (
      <QueryClientProvider client={qc}>
        <App screen={screen} />
      </QueryClientProvider>
    );
    const onScandia: Screen = { periodId: S25, periodEnd: "2025-12-31", periodOrg: SCANDIA, activeOrg: SCANDIA };
    const r = render(wrap(onScandia));
    // Scandia's own comparison: its two periods, asked of Scandia.
    await waitFor(() => expect(query!.data?.kind).toBe("ok"));
    const scandiaCmp = seen.filter((s) => s.url.includes("/comparatives"));
    expect(scandiaCmp.map((s) => [s.org, s.url.split("/api/period/")[1]])).toEqual([
      [SCANDIA, `${S25}/comparatives?prior=${S24}`],
    ]);

    // The switch: EEI is activated (lib/org activateWorkspace), its period opens.
    const mark = seen.length;
    session.activeOrg = EEI;
    const onEei: Screen = { periodId: E25, periodEnd: "2025-12-31", periodOrg: EEI, activeOrg: EEI };
    r.rerender(wrap(onEei));
    await waitFor(() => expect(choice!.companyId).toBe(EEI));
    await waitFor(() => expect(choice!.periods.map((p) => p.period_id)).toEqual([E25]));
    // Give any stray request its chance to fire.
    await new Promise((res) => setTimeout(res, 30));

    const after = seen.slice(mark);
    const foreign = after.filter((s) => s.url.includes(S24) || s.url.includes(S25));
    expect(foreign, "a request after the switch named a Scandia period").toEqual([]);
    expect(after.filter((s) => s.url.includes("/comparatives")), "EEI has one period: nothing to compare").toEqual([]);
    for (const s of after) expect(s.org, s.url).toBe(EEI);
    expect(choice!.priorId).toBeNull();
    expect(query!.data).toBeUndefined();
    expect(query!.fetchStatus).toBe("idle");
  });
});
