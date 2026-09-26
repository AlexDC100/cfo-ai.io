// THE DASHBOARD COMPARES WITH LAST YEAR BY DEFAULT (owner, 2026-09-26).
//
// "The dashboard is not showing the comparison between years of the same
// company; it should pick it up automatically and the user can deselect it."
//
// The rule these gates hold:
//   · every dashboard view of a period compares, by default, with the SAME
//     company's immediately preceding period of the same length (Dec 2025 →
//     Dec 2024) — no click needed;
//   · the Overview shows it: each key figure prints the prior period's figure
//     and the move, built by the same builders as the tile over the prior's
//     own served block;
//   · "Compare with" → "No comparison" is remembered for THAT company only;
//     another company opens on its own default, and the first company still
//     shows no comparison when the reader comes back;
//   · a company with one period shows no comparison and makes no request.
//
// Fails on: no comparatives request for a two-year company with nothing
// chosen; a default prior that is not the previous December; an Overview
// tile without the prior figure; a deselection that leaks to another company
// or is forgotten on the way back; FinancialStatements not feeding the
// comparison into the four Overview tiles.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestQueryClient, TestProviders } from "@/test/renderWithProviders";
import PAIR from "@/lib/__tests__/fixtures/comparatives/pair_served.json";

const SCANDIA = "0a9a0000-0000-4000-8000-000000000051";
const AGRAS = "0a9a0000-0000-4000-8000-0000000000a9";
const EEI = "0a9a0000-0000-4000-8000-0000000000e1";
const S25 = "5ea50000-0000-4000-8000-0000000051f5"; // Scandia Dec 2025
const S24 = "5ea50000-0000-4000-8000-0000000051f4"; // Scandia Dec 2024
const A25 = "5ea50000-0000-4000-8000-00000000a925"; // Agras Dec 2025
const A24 = "5ea50000-0000-4000-8000-00000000a924"; // Agras Dec 2024
const E25 = "5ea50000-0000-4000-8000-00000000e125"; // EEI Dec 2025 — its only period

const PERIODS: Record<string, { id: string; end: string }[]> = {
  [SCANDIA]: [
    { id: S25, end: "2025-12-31" },
    { id: S24, end: "2024-12-31" },
  ],
  [AGRAS]: [
    { id: A25, end: "2025-12-31" },
    { id: A24, end: "2024-12-31" },
  ],
  [EEI]: [{ id: E25, end: "2025-12-31" }],
};

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "tok", user: { id: "u1" } } } }) },
    // The providers' own preference writes (theme, learning mode) land here.
    rpc: async () => ({ data: null, error: null }),
  }),
  currentOrgId: async () => null,
}));

const comparisons: { org: string | null; period: string; prior: string }[] = [];

beforeEach(() => {
  comparisons.length = 0;
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const org = ((init?.headers ?? {}) as Record<string, string>)["X-Org-Id"] ?? null;
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/org/periods-with-documents")) {
        return json(200, {
          active_period_id: PERIODS[org ?? ""]?.[0]?.id ?? null,
          periods: (PERIODS[org ?? ""] ?? []).map((p) => ({
            period_id: p.id,
            period_label: p.end,
            period_start: `${p.end.slice(0, 4)}-01-01`,
            period_end: p.end,
            documents: [{ id: `doc-${p.id}`, status: "analyzed" }],
          })),
        });
      }
      const cmp = /\/api\/period\/([^/?]+)\/comparatives\?prior=([^&]+)/.exec(url);
      if (cmp) {
        comparisons.push({ org, period: decodeURIComponent(cmp[1]!), prior: decodeURIComponent(cmp[2]!) });
        return json(200, { current: { period_id: cmp[1] }, prior: { period_id: cmp[2] } });
      }
      return json(404, { detail: "not modelled" });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const { useComparatives, useComparisonChoice } = await import("@/lib/comparatives");
const { ComparativesViewProvider, useComparativesView, COMPARATIVES_VIEW_KEY_PREFIX } = await import(
  "@/stores/comparativesView"
);
const { overviewPriorOf, trendAgainstPrior } = await import("@/lib/overviewComparison");
const { computeDashboardHeadline, canonicalMarginsFrom } = await import("@/lib/dashboardHeadline");
const { deriveTotals } = await import("@/lib/financialReport");
const { KeyMetricsRow } = await import("@/components/cfo/KeyMetricsRow");

// ── A dashboard, the way FinancialStatements wires the comparison ──────
interface Screen {
  periodId: string;
  periodEnd: string;
  org: string;
}
let view: ReturnType<typeof useComparativesView> | null = null;
let choice: ReturnType<typeof useComparisonChoice> | null = null;
function Dashboard({ screen }: { screen: Screen }) {
  view = useComparativesView();
  choice = useComparisonChoice({
    currentId: screen.periodId,
    currentEnd: screen.periodEnd,
    currentOrgId: screen.org,
    activeOrgId: screen.org,
    stored: view.view.priorPeriodId,
  });
  useComparatives(screen.periodId, choice.priorId, choice.companyId);
  return null;
}

function mount() {
  const qc = createTestQueryClient();
  const tree = (screen: Screen) => (
    <QueryClientProvider client={qc}>
      <ComparativesViewProvider orgId={screen.org}>
        <Dashboard screen={screen} />
      </ComparativesViewProvider>
    </QueryClientProvider>
  );
  return { tree };
}

const onScandia: Screen = { periodId: S25, periodEnd: "2025-12-31", org: SCANDIA };
const onAgras: Screen = { periodId: A25, periodEnd: "2025-12-31", org: AGRAS };
const onEei: Screen = { periodId: E25, periodEnd: "2025-12-31", org: EEI };

describe("a two-year company compares with the previous year by default", () => {
  it("Scandia 2025 is compared with Scandia 2024 — nothing chosen, one request, asked of Scandia", async () => {
    const { tree } = mount();
    render(tree(onScandia));
    await waitFor(() => expect(comparisons).toEqual([{ org: SCANDIA, period: S25, prior: S24 }]));
    expect(view!.view.priorPeriodId, "nothing was chosen: this is the default").toBeNull();
    expect(choice!.autoPick?.period_id).toBe(S24);
  });

  it("a company with one period compares with nothing, and asks nothing", async () => {
    const { tree } = mount();
    render(tree(onEei));
    await waitFor(() => expect(choice!.periods.map((p) => p.period_id)).toEqual([E25]));
    await new Promise((r) => setTimeout(r, 20));
    expect(choice!.priorId).toBeNull();
    expect(comparisons).toEqual([]);
  });
});

describe("'No comparison' is remembered for that company only", () => {
  it("deselect on Scandia → Agras opens on its own default → back on Scandia, still none", async () => {
    const { tree } = mount();
    const r = render(tree(onScandia));
    await waitFor(() => expect(choice!.priorId).toBe(S24));

    act(() => view!.setPriorPeriodId("none"));
    expect(choice!.priorId, "deselected: no prior").toBeNull();
    expect(JSON.parse(window.localStorage.getItem(COMPARATIVES_VIEW_KEY_PREFIX + SCANDIA)!).priorPeriodId).toBe("none");

    // Another company: its own default, not Scandia's "none".
    r.rerender(tree(onAgras));
    await waitFor(() => expect(choice!.companyId).toBe(AGRAS));
    await waitFor(() => expect(choice!.priorId).toBe(A24));
    expect(view!.view.priorPeriodId, "Scandia's deselection carried to Agras").toBeNull();
    expect(window.localStorage.getItem(COMPARATIVES_VIEW_KEY_PREFIX + AGRAS)).toBeNull();
    await waitFor(() => expect(comparisons.filter((c) => c.org === AGRAS)).toEqual([{ org: AGRAS, period: A25, prior: A24 }]));

    // Back on Scandia: the deselection is still Scandia's.
    r.rerender(tree(onScandia));
    await waitFor(() => expect(choice!.companyId).toBe(SCANDIA));
    await waitFor(() => expect(view!.view.priorPeriodId).toBe("none"));
    expect(choice!.priorId).toBeNull();
    // No request ever mixed the two companies.
    for (const c of comparisons) {
      const ids = PERIODS[c.org ?? ""]!.map((p) => p.id);
      expect(ids).toContain(c.period);
      expect(ids).toContain(c.prior);
    }
  });
});

// ── The Overview shows the prior figures ───────────────────────────────

type Doc = Parameters<typeof overviewPriorOf>[0];
/** The Net debt tile's reader, as the page passes it. */
const netDebtOf = (s: never) => deriveTotals(s).netDebt;
const doc = (PAIR as unknown as { comparatives: NonNullable<Doc> }).comparatives;
const current = (PAIR as unknown as { current_body: { statements: never; metrics: never[] } }).current_body;

describe("the Overview's key figures carry the prior period", () => {
  it("each prior figure is the tile's own builder over the prior's served block", () => {
    const prior = overviewPriorOf(doc, "Entity", netDebtOf)!;
    expect(prior.label).toBe("Dec 2024");
    const ps = doc.prior_statements as never;
    const metrics = doc.prior_metrics.map((m) => ({ ...m, unit: null, direction: null }));
    const h = computeDashboardHeadline({
      statements: ps,
      lineItems: doc.prior_line_items ?? [],
      metrics,
      entity: "Entity",
      canonicalMargins: canonicalMarginsFrom(metrics),
    });
    expect(prior.figures.revenue).toBe(h.totalOperatingRevenue);
    expect(prior.figures.ebitda).toBe(h.tileEbitdaRon);
    expect(prior.figures.cash).toBe((ps as { balanceSheet: { cash: number } }).balanceSheet.cash);
    expect(prior.figures.netDebt).toBe(deriveTotals(ps).netDebt);
    // Non-vacuity: the served prior differs from the current on every figure.
    expect(prior.figures.cash).not.toBe((current.statements as { balanceSheet: { cash: number } }).balanceSheet.cash);
    expect(overviewPriorOf(null, "Entity", netDebtOf)).toBeNull();
  });

  it("the tiles print the prior period and its figure beside the move", () => {
    const prior = overviewPriorOf(doc, "Entity", netDebtOf)!;
    const cs = current.statements as never;
    const metrics = current.metrics as never[];
    const h = computeDashboardHeadline({
      statements: cs,
      lineItems: [],
      metrics,
      entity: "Entity",
      canonicalMargins: canonicalMarginsFrom(metrics),
    });
    const cash = (cs as { balanceSheet: { cash: number } }).balanceSheet.cash;
    const netDebt = deriveTotals(cs).netDebt;
    render(
      <TestProviders>
        <KeyMetricsRow
          currency="RON"
          items={[
            { label: "Revenue", desc: "d", value: h.totalOperatingRevenue, testid: "key-metric-revenue", trend: trendAgainstPrior(prior, "revenue", h.totalOperatingRevenue) },
            { label: "EBITDA", desc: "d", value: h.tileEbitdaRon, testid: "key-metric-ebitda", trend: trendAgainstPrior(prior, "ebitda", h.tileEbitdaRon) },
            { label: "Cash", desc: "d", value: cash, testid: "key-metric-cash", trend: trendAgainstPrior(prior, "cash", cash) },
            { label: "Net debt", desc: "d", value: netDebt, testid: "key-metric-net-debt", trend: trendAgainstPrior(prior, "netDebt", netDebt) },
          ]}
        />
      </TestProviders>,
    );
    for (const id of ["key-metric-revenue", "key-metric-ebitda", "key-metric-cash", "key-metric-net-debt"]) {
      const tile = screen.getByTestId(id);
      const line = within(tile).getByTestId(`${id}-prior`);
      expect(line.textContent, id).toMatch(/^Dec 2024: /);
      expect(line.textContent, id).toMatch(/\d/);
      // The move vs the prior: a chip on the tile (a percent, or words for a flip).
      expect(tile.querySelector("[data-change-kind]"), `${id} has no change chip`).not.toBeNull();
    }
  });

  // THE JOIN — the page itself needs the router, Supabase and the period
  // queries, so its use of the comparison is held by reading its source.
  it("FinancialStatements feeds the comparison into all four Overview tiles and offers the picker there", () => {
    const raw = readFileSync(resolve(process.cwd(), "frontend/pages/cfo/FinancialStatements.tsx"), "utf8");
    const page = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(page).toMatch(/overviewPriorOf\(cmpDoc, t\("dash\.entity"\), \(s\) => deriveTotals\(s\)\.netDebt\)/);
    expect(page).toMatch(/const overviewPrior = useMemo\(/);
    for (const [fig, value] of [
      ["revenue", "headline.totalOperatingRevenue"],
      ["ebitda", "headline.tileEbitdaRon"],
      ["cash", "statements.balanceSheet.cash"],
      ["netDebt", "totals.netDebt"],
    ]) {
      expect(page, fig).toContain(`trendAgainstPrior(overviewPrior, "${fig}", ${value})`);
    }
    expect(page).toMatch(/activeTab === "overview" \|\| activeTab === "pl"/);
  });
});
