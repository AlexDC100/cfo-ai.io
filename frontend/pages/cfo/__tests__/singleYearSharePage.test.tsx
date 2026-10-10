// "% DIN VENITURI" ON ONE YEAR — THE REAL DASHBOARD PAGE.
//
// Gate `single-year-share`, second file. `components/cfo/__tests__/
// singleYearShare.test.tsx` renders the page's COMPOSITION (the shared
// components the page renders too) and holds the page's own JSX by its text.
// A text law reads what it was told to read: the second review of the lane
// (2026-10-04) planted the first review's page defects ONE WRAPPER AWAY and
// both gate files stayed green —
//   · the notes inside a `<div>` under `false &&` (the parent is an element);
//   · the whole P&L statement under `{cmpDoc && (…)}` (no P&L, and so no
//     share column, without a comparison document — the ruling undone);
//   · a `<style>` element hiding the controls of a one-period company;
//   · `common_size` deleted from `statements` before the composition is
//     called when there is no document.
// None of them changes a string the text laws pin. All of them change what
// is ON THE PAGE. So this file mounts `pages/cfo/FinancialStatements.tsx`
// ITSELF — its router, its providers, the app's own query defaults, the real
// `useActivePeriod`, `useComparatives`, `useComparisonChoice` and
// `useRatioSurfaces` — with the network mocked at the two seams the page
// really uses (`@supabase/supabase-js` createClient; global fetch), and holds
// what a reader sees.
//
// THE BODIES ARE THE ENGINE'S BYTES. `pair_served.json` /
// `pair_prior_later.json` are the committed corpus pair as GET /api/period
// and GET …/comparatives serve it, trimmed of the line items;
// `period_line_items.json` is that trimmed field
// (tests/engine/test_common_size_fe_fixture.py holds all three to the
// engine). Put together they are the route's whole body. The only thing
// changed is the two period ids and the organisation id, relabelled as
// UUIDs: the page fetches a period only for a UUID.
//
// LAW (each state on the real page):
//  P1  a company with ONE period — P&L and balance sheet: the controls are
//      VISIBLE, the share box alone, on and ticked, and every share cell
//      prints the served share through the one printer;
//  P2  the earliest of two years, AUTO: one no-prior notice, the three
//      comparison boxes off, the share box on, the column printed;
//  P3  a comparison the engine refuses: one sentence under the tab bar, the
//      comparison boxes off, the period's own share column still printed;
//  P4  a comparison document: four boxes on, every share cell the period's
//      OWN share, the document's points only beside a share it describes;
//  P5  a LATER comparison period on the Ratios tab: the page says it reads
//      backwards, the band box says one sentence, and nothing is listed,
//      counted or coloured — also when the document itself lists band
//      verdicts under that direction (it is not believed).
//
// Fails on: any of the four plants above; the notes or the controls under a
// condition of the page's own; a statement tab not rendered without a
// document; a share cell that is not the served share; the Ratios tab
// believing a document's band lists under a direction that serves none.
//
// What it cannot see: a real browser (layout, the sticky bar's height, the
// phone breakpoint — this is jsdom); the upload flow; a share DIVIDED in the
// browser that reproduces the served fraction to the printed decimal (no
// by-value law can — the source laws of the other file hold the share path's
// arithmetic); production.
// Plant log: docs/engine_book/gates.md, "single-year-share".
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import pairJson from "@/lib/__tests__/fixtures/comparatives/pair_served.json";
import laterJson from "@/lib/__tests__/fixtures/comparatives/pair_prior_later.json";
import itemsJson from "@/lib/__tests__/fixtures/comparatives/period_line_items.json";

// The whole page is mounted (lazy tabs, providers, three queries): on a
// machine busy with other suites a law must not go red on the clock.
vi.setConfig({ testTimeout: 300_000 });
const SETTLE = { timeout: 120_000, interval: 100 } as const;

const ORG = "0c0a0000-0000-4000-8000-00000000c0a1";
const P25 = "11111111-1111-4111-8111-000020251231";
const P24 = "11111111-1111-4111-8111-000020241231";
/** The engine's own ids for the two periods of the committed pair. */
const SRC25 = "period-agras-fy2025";
const SRC24 = "period-carniprod-fy2024";

vi.mock("@supabase/supabase-js", () => {
  // A chain that answers every table read with nothing: the page's own
  // tables (documents, preferences, …) are empty; the period, the comparison
  // and the company's period list come from the engine through fetch.
  const chain = (result: unknown): unknown => {
    const p: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
        if (prop === "single" || prop === "maybeSingle") return () => chain({ data: null, error: null });
        return () => p;
      },
      apply() {
        return p;
      },
    });
    return p;
  };
  const session = { access_token: "tok", user: { id: "u1", email: "reader@example.invalid", user_metadata: {} } };
  const client = {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: session.user }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: () => chain({ data: [], error: null }),
    rpc: () => chain({ data: null, error: null }),
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => {} };
      return ch;
    },
    removeChannel: () => {},
    storage: { from: () => chain({ data: null, error: null }) },
    functions: { invoke: async () => ({ data: null, error: null }) },
  };
  return { createClient: () => client };
});

vi.mock("@/lib/org", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/org")>();
  const org = {
    id: "0c0a0000-0000-4000-8000-00000000c0a1",
    name: "Corpus Entity",
    industry_key: null,
    archived_at: null,
    created_at: "2025-01-01",
  };
  return {
    ...real,
    useActiveOrg: () => ({
      org, orgs: [org], archived: [], loading: false, loadError: false, needsOnboarding: false,
      refresh: async () => {}, switchOrg: async () => {},
    }),
  };
});

// ── The served world ──────────────────────────────────────────────────

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** GET /api/period/{id} for one of the two periods: the committed body with
 *  its line items put back, relabelled with the UUID the page asks for. */
function body(which: 25 | 24): Json {
  const src = clone((which === 25 ? pairJson : laterJson) as unknown as { current_body: Json }).current_body;
  const srcId = which === 25 ? SRC25 : SRC24;
  expect(src.period.id).toBe(srcId);
  const items = (itemsJson as unknown as { periods: Record<string, { line_items: unknown[] }> }).periods[srcId];
  src.line_items = clone(items.line_items);
  src.period.id = which === 25 ? P25 : P24;
  src.organization.id = ORG;
  return src;
}
/** GET …/comparatives for the pair, forwards (2025 against 2024) or the
 *  other way round, relabelled the same way. */
function comparison(which: "forward" | "later"): Json {
  const doc = clone((which === "forward" ? pairJson : laterJson) as unknown as { comparatives: Json }).comparatives;
  doc.current.period_id = which === "forward" ? P25 : P24;
  doc.prior.period_id = which === "forward" ? P24 : P25;
  return doc;
}

interface World {
  periods: Record<string, Json>;
  comparisons: Record<string, { status: number; body: unknown }>;
  list: { id: string; end: string }[];
  calls: string[];
}
const world: World = { periods: {}, comparisons: {}, list: [], calls: [] };
const Y25 = { id: P25, end: "2025-12-31" };
const Y24 = { id: P24, end: "2024-12-31" };

function installFetch(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : (input as Request).url);
    world.calls.push(url.replace(/^https?:\/\/[^/]+/, ""));
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    const cmp = /\/api\/period\/([^/?]+)\/comparatives\?prior=([^&]+)/.exec(url);
    if (cmp) {
      const hit = world.comparisons[`${cmp[1]}|${decodeURIComponent(cmp[2])}`];
      return hit ? json(hit.status, hit.body) : json(404, { detail: "no such pair in this world" });
    }
    const per = /\/api\/period\/([^/?]+)$/.exec(url);
    if (per) return world.periods[per[1]] ? json(200, world.periods[per[1]]) : json(404, {});
    if (url.includes("/api/org/periods-with-documents")) {
      return json(200, {
        recently_deleted: [],
        periods: world.list.map((p) => ({
          period_id: p.id,
          period_label: p.end,
          period_start: `${p.end.slice(0, 4)}-01-01`,
          period_end: p.end,
          is_active: true,
          documents: [{ id: `doc-${p.id}`, filename: "book.xlsx", is_active: true, status: "analyzed", scope: "financial" }],
        })),
      });
    }
    return json(404, {});
  });
}

async function mountPage(route: string) {
  const { default: FinancialStatements } = await import("@/pages/cfo/FinancialStatements");
  const { queryClient: appClient } = await import("@/lib/queryClient");
  const { ThemeProvider } = await import("@/theme");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { CurrencyProvider } = await import("@/stores/currency");
  const { LearningModeProvider } = await import("@/stores/learningMode");
  const { PopoverStackProvider } = await import("@/components/learning/PopoverStackProvider");
  const { AuthProvider } = await import("@/lib/auth");
  // THE APP'S OWN QUERY DEFAULTS (placeholderData, refetchOnMount false, …).
  const client = new QueryClient({ defaultOptions: appClient.getDefaultOptions() });
  return render(
    <ThemeProvider defaultTheme="light" enableSystem={false}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <CurrencyProvider>
            <TooltipProvider>
              <MemoryRouter initialEntries={[route]}>
                <LearningModeProvider>
                  <PopoverStackProvider>
                    <FinancialStatements />
                  </PopoverStackProvider>
                </LearningModeProvider>
              </MemoryRouter>
            </TooltipProvider>
          </CurrencyProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

// ── What is on the page ───────────────────────────────────────────────

const boxes = () =>
  (screen.queryAllByTestId(/^comparatives-col-/) as HTMLInputElement[]).map(
    (b) => `${b.dataset.testid!.slice(17)}:${b.disabled ? "off" : "on"}:${b.checked ? "ticked" : "unticked"}`,
  );
const shareOnlyCells = () => [...document.querySelectorAll<HTMLElement>('[data-cmp="share-only"]')];
const servedRows = (b: Json): Map<string, Json> =>
  new Map((b.statements.common_size.rows as Json[]).map((r) => [r.key as string, r]));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 300)); });
const storeView = (priorPeriodId: string | null | "none") =>
  window.localStorage.setItem(
    "cfo:comparatives-view:v2:" + ORG,
    JSON.stringify({ priorPeriodId, columns: { prior: true, delta: true, deltaPct: true, share: true } }),
  );

let cellsHeld = 0;
let statesHeld = 0;

/** Every single-period share cell on the page that prints a share prints the
 *  SERVED one; returns how many. */
async function everyShareOnlyCellIsServed(b: Json): Promise<number> {
  const { formatShare } = await import("@/lib/comparatives");
  const rows = servedRows(b);
  let printed = 0;
  for (const cell of shareOnlyCells()) {
    if (cell.getAttribute("data-share-status") !== "share") continue;
    const row = rows.get(cell.getAttribute("data-cmp-key") ?? "");
    expect(row, `no served row for ${cell.getAttribute("data-cmp-key")}`).toBeTruthy();
    expect(cell.textContent).toBe(formatShare(row!.share, "en"));
    printed += 1;
  }
  cellsHeld += printed;
  return printed;
}

beforeEach(async () => {
  window.localStorage.clear();
  window.localStorage.setItem("cfo-view-mode-v1", "pro");
  world.periods = {};
  world.comparisons = {};
  world.list = [];
  world.calls = [];
  installFetch();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await i18n.changeLanguage("en");
  // eslint-disable-next-line no-console
  console.log(`GATE-WORK single-year-share page_cells=${cellsHeld} page_states=${statesHeld}`);
});

describe("the real dashboard page — the fixtures put together are the route's body", () => {
  it("each period carries its block, its canonical rows and its line items", () => {
    for (const which of [25, 24] as const) {
      const b = body(which);
      expect(b.line_items.length).toBeGreaterThan(200);
      expect(b.statements.common_size.schema).toBe("common_size/1");
      expect(b.statements.canonical_bs.rows.length).toBeGreaterThan(30);
      expect(b.organization.id).toBe(ORG);
    }
    expect(comparison("forward").direction.order).toBe("prior_is_earlier");
    expect(comparison("later").direction.order).toBe("prior_is_later");
    expect(comparison("later").ratios.band_movements.verdicts_withheld).toBe("prior_is_later");
    statesHeld += 1;
  });
});

describe("P1 the real page — a company with ONE period", () => {
  for (const [tab, least] of [["pl", 15], ["balance_sheet", 40]] as const) {
    it(`${tab}: the controls are visible, the share box alone, on and ticked — and every share cell is the served share`, async () => {
      const b = body(25);
      world.periods = { [P25]: b };
      world.list = [Y25];
      await mountPage(`/dashboard?period=${P25}&tab=${tab}`);
      await waitFor(() => expect(shareOnlyCells().length).toBeGreaterThan(0), SETTLE);
      await settle();
      // VISIBLE: on the page, not hidden by a style of the page's own.
      expect(screen.getByTestId("comparatives-controls")).toBeVisible();
      expect(screen.getByTestId("comparatives-col-share")).toBeVisible();
      expect(boxes()).toEqual(["share:on:ticked"]);
      expect(screen.queryByTestId("comparatives-prior-select")).toBeNull();
      expect(screen.queryByTestId("comparatives-no-prior")).toBeNull();
      expect(screen.queryByTestId("comparatives-outcome")).toBeNull();
      const printed = await everyShareOnlyCellIsServed(b);
      expect(printed, `${tab}: no single-period share column on the real page`).toBeGreaterThanOrEqual(least);
      // One company, one period: nothing was asked about a comparison.
      expect(world.calls.filter((c) => c.includes("/comparatives"))).toEqual([]);
      statesHeld += 1;
    });
  }
});

describe("P2 the real page — the earliest of two years, AUTO", () => {
  it("one no-prior notice, the comparison boxes off, the share box on, the column printed", async () => {
    const b = body(24);
    world.periods = { [P24]: b };
    world.list = [Y25, Y24];
    await mountPage(`/dashboard?period=${P24}&tab=pl`);
    await waitFor(() => expect(screen.queryByTestId("comparatives-no-prior")).not.toBeNull(), SETTLE);
    await settle();
    expect(screen.getAllByTestId("comparatives-no-prior").length).toBe(1);
    expect(screen.getByTestId("comparatives-no-prior")).toBeVisible();
    expect(screen.getByTestId("comparatives-prior-select")).toBeVisible();
    expect(boxes()).toEqual(["prior:off:unticked", "delta:off:unticked", "deltaPct:off:unticked", "share:on:ticked"]);
    expect(screen.queryByTestId("comparatives-outcome")).toBeNull();
    expect(await everyShareOnlyCellIsServed(b)).toBeGreaterThanOrEqual(14);
    expect(world.calls.filter((c) => c.includes("/comparatives"))).toEqual([]);
    statesHeld += 1;
  });
});

describe("P3 the real page — a comparison the engine refuses", () => {
  it("one sentence under the tab bar, the comparison boxes off, the period's own share column still printed", async () => {
    const b = body(25);
    world.periods = { [P25]: b };
    world.list = [Y25, Y24];
    world.comparisons[`${P25}|${P24}`] = { status: 409, body: { detail: { code: "period_not_servable", message: "x" } } };
    await mountPage(`/dashboard?period=${P25}&tab=pl`);
    await waitFor(() => expect(screen.queryByTestId("comparatives-outcome")).not.toBeNull(), SETTLE);
    await settle();
    const notes = screen.getAllByTestId("comparatives-outcome");
    expect(notes.length).toBe(1);
    expect(notes[0].getAttribute("data-outcome")).toBe("refused");
    expect(notes[0]).toBeVisible();
    expect((notes[0].textContent ?? "").trim().length).toBeGreaterThan(20);
    expect(screen.queryByTestId("comparatives-no-prior")).toBeNull();
    expect(boxes()).toEqual(["prior:off:unticked", "delta:off:unticked", "deltaPct:off:unticked", "share:on:ticked"]);
    expect(await everyShareOnlyCellIsServed(b)).toBeGreaterThanOrEqual(15);
    // Asked once; nothing asks again on its own.
    expect(world.calls.filter((c) => c.includes("/comparatives")).length).toBe(1);
    statesHeld += 1;
  });
});

describe("P4 the real page — a comparison document on screen", () => {
  it("four boxes on; every share cell is the period's OWN share, the document's points only beside a share it describes", async () => {
    const { formatShare, formatPts } = await import("@/lib/comparatives");
    const b = body(25);
    const doc = comparison("forward");
    world.periods = { [P25]: b };
    world.list = [Y25, Y24];
    world.comparisons[`${P25}|${P24}`] = { status: 200, body: doc };
    await mountPage(`/dashboard?period=${P25}&tab=pl`);
    // (while the request is in flight the page paints the period's own
    // share-only column; the document's cells replace it)
    await waitFor(() => {
      expect(shareOnlyCells().length).toBe(0);
      expect(document.querySelectorAll('.cmp-cells[data-share-status="share"]').length).toBeGreaterThan(0);
    }, SETTLE);
    await settle();
    expect(boxes()).toEqual(["prior:on:ticked", "delta:on:ticked", "deltaPct:on:ticked", "share:on:ticked"]);
    expect(screen.queryByTestId("comparatives-outcome")).toBeNull();
    expect(screen.queryByTestId("comparatives-no-prior")).toBeNull();
    expect(shareOnlyCells().length).toBe(0);
    const own = servedRows(b);
    const served = new Map((doc.common_size as Json[]).map((r) => [r.key as string, r]));
    let shares = 0;
    let withPoints = 0;
    for (const cells of document.querySelectorAll<HTMLElement>('.cmp-cells[data-share-status="share"]')) {
      const key = cells.getAttribute("data-cmp-key") ?? "";
      const cell = cells.lastElementChild as HTMLElement;
      const share = formatShare(own.get(key)!.share, "en")!;
      const pts = cell.querySelector(".cmp-cell--pts");
      if (pts) {
        // The document describes THIS share — and its points are served.
        expect(served.get(key)!.current_share).toBe(own.get(key)!.share);
        expect(pts.textContent?.trim()).toBe(formatPts(served.get(key)!.delta_pts, "en"));
        expect(cell.textContent).toBe(`${share} ${formatPts(served.get(key)!.delta_pts, "en")}`);
        withPoints += 1;
      } else {
        expect(cell.textContent).toBe(share);
      }
      shares += 1;
    }
    expect(shares).toBeGreaterThanOrEqual(15);
    expect(withPoints).toBeGreaterThanOrEqual(12);
    cellsHeld += shares;
    expect(world.calls.filter((c) => c.includes("/comparatives")).length).toBe(1);
    statesHeld += 1;
  });
});

describe("P5 the real page — the Ratios tab under a LATER comparison period", () => {
  const VERDICT_WORDS = /improved|deteriorated/gi;

  /** No list, no count, no heading, no verdict colour: the two words appear
   *  only in the page's sentence and the band box's sentence. */
  function nothingIsJudged(): void {
    const note = screen.getByTestId("comparatives-outcome");
    expect(note.getAttribute("data-outcome")).toBe("backwards");
    const boxText = screen.getByTestId("band-movements-withheld").textContent ?? "";
    expect(screen.getByTestId("band-movements").getAttribute("data-verdicts")).toBe("withheld");
    for (const id of ["band-improved", "band-deteriorated", "band-movements-counts", "band-movements-nothing", "band-movement-item"]) {
      expect(screen.queryAllByTestId(id).length, id).toBe(0);
    }
    const all = (document.body.textContent ?? "").match(VERDICT_WORDS) ?? [];
    const said = ((note.textContent ?? "").match(VERDICT_WORDS) ?? []).length + (boxText.match(VERDICT_WORDS) ?? []).length;
    expect(all.length).toBe(said);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="ratio-compare-row"]')];
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      for (const sel of ['[data-cell="delta"]', '[data-cell="movement"]']) {
        const cell = row.querySelector<HTMLElement>(sel);
        if (!cell) continue;
        const classes = [cell, ...cell.querySelectorAll<HTMLElement>("*")].map((n) => n.className).join(" ");
        expect(classes, `${row.getAttribute("data-ratio-key")} ${sel}`).not.toMatch(/text-(success|alert)/);
      }
    }
  }

  async function mountRatios(which: 25 | 24, doc: Json): Promise<void> {
    const [cur, pri] = which === 24 ? [P24, P25] : [P25, P24];
    world.periods = { [cur]: body(which) };
    world.list = [Y25, Y24];
    world.comparisons[`${cur}|${pri}`] = { status: 200, body: doc };
    storeView(pri);
    await mountPage(`/dashboard?period=${cur}&tab=ratios`);
    await waitFor(() => expect(screen.queryByTestId("band-movements")).not.toBeNull(), SETTLE);
    await waitFor(() => expect(screen.queryByTestId("comparatives-outcome")).not.toBeNull(), SETTLE);
    await settle();
  }

  it("the engine's document: the page says it reads backwards, the band box says one sentence, nothing is listed or coloured", async () => {
    await mountRatios(24, comparison("later"));
    nothingIsJudged();
    statesHeld += 1;
  });

  it("a document that LISTS band verdicts under a later comparison period is not believed", async () => {
    // CONSTRUCTED — the shape the engine served before its ratio block read
    // the direction (and what a regression of it would serve): a direction
    // that serves no verdict over a ratio block that carries lists,
    // crossings and adjectives and no `verdicts_withheld`. Built on the
    // served forward pair, so every figure ties to the period on screen:
    // only the document's direction is changed.
    const lying = comparison("forward");
    lying.direction = { ...lying.direction, order: "prior_is_later", verdicts_served: false, reason: "prior_is_later" };
    const bm = lying.ratios.band_movements;
    expect(bm.verdicts_withheld ?? null).toBeNull();
    const crossed: string[] = [...bm.improved, ...bm.deteriorated];
    expect(crossed.length).toBeGreaterThan(5);
    await mountRatios(25, lying);
    nothingIsJudged();
    // The crossings are on the page as figures — each says why it is not judged.
    const { default: enBundle } = await import("@/i18n/locales/en.json");
    const reason = (enBundle as unknown as Json).statements.ratioCmp.reason.prior_is_later as string;
    let said = 0;
    for (const row of document.querySelectorAll<HTMLElement>('[data-testid="ratio-compare-row"]')) {
      if (!crossed.includes(row.dataset.ratioKey ?? "")) continue;
      expect(row.querySelector('[data-cell="movement"]')?.textContent, row.dataset.ratioKey).toBe(reason);
      said += 1;
    }
    expect(said).toBe(crossed.length);
    statesHeld += 1;
  });
});
