// THE COMMAND BAR (⌘K) — the rendered-surface gates (design C2/C3/C5).
//
// The REAL CommandPalette, driven by keyboard, over REAL served documents:
// the period bodies the hermetic e2e double serves (G7 captures of the
// anonymized corpus books), the comparatives pair capture, the sector
// documents, and "Ce contează acum" as the ENGINE composed it
// (frontend/lib/__tests__/fixtures/attention/, held to a fresh composition
// by tests/engine/test_cmdbar_fixtures.py). Only the host context (who is
// signed in, which company is open, the rail) is provided, and `fetch` is
// TRAPPED — recorded, never forwarded.
//
// Gates, each red on its planted defect (transcripts: docs/engine_book/
// gates.md, "cmdbar-*"):
//
//   cmdbar-swap        the empty state is company-specific: two companies,
//                      one fixture shape, different items (S1 figures, S2
//                      text with numerals masked); the rows ARE the served
//                      items, in the served rank.
//   cmdbar-figures     every Răspuns / Cont figure equals the served figure,
//                      read INDEPENDENTLY from the served JSON and printed
//                      by the shared printer; ratios from ratio_table only.
//                      Exhaustive since stage CB-G: every Cont leaf of both
//                      books (582) in RO and EN with its design key metric,
//                      every Δ against its comparatives column, every
//                      vs-sector against its sector row.
//   cmdbar-no-model    the bar makes no model or capsule-tool request in any
//                      interaction and renders no recommendations / briefing
//                      / alert / narrative text.
//   cmdbar-latency     warm cache: every keystroke renders all groups but
//                      "Întreabă" in < 100 ms of the render thread's CPU
//                      (test/cpuClock — the work, not the machine's load)
//                      with ZERO fetches — counted after every timer the
//                      keystroke armed has run on a fake clock that fakes
//                      Date and performance too (DEBOUNCE_HORIZON_MS), so a
//                      debounce that measures elapsed time is counted too;
//                      cold open:
//                      the value first, Δ / vs-sector say "loading" — never
//                      blank, never 0.
//   cmdbar-keyboard    ↑↓ walk every row the reader sees and stop at the
//                      ends, the composer names the active row
//                      (aria-activedescendant), Enter opens its evidence,
//                      Tab / ⌘Enter hand the query to the chat, Esc closes.
//   + digits, synonyms and diacritics (pure AND rendered), the header line,
//     the caveat printed once, the absent-figure reason, RO + EN.
//
// WHAT IT CANNOT SEE: pixels (the screenshot harness), and whether the
// engine ranked the right items (tests/engine/test_attention_rules.py).

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import i18n from "@/i18n";
import { formatMoneyFrom, moneyLocaleFor } from "@/lib/money";
import { formatRatioSide, localiseDecimal, ratioLabelForKey, type RatioTableRow } from "@/lib/ratioTable";
import { formatDeltaPct } from "@/lib/comparatives";
import { changeKindWordKey, isWordKind, type ChangeKind } from "@/lib/changeKind";
import { lawfulFigure, sectorValueText } from "@/lib/sectorBenchmark";
import { foreignNumber, plainSpaces } from "@/test/numberLanguage";

const REPO = resolve(__dirname, "../../../../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf-8"));

const SCANDIA = read("e2e/fixtures/workspace_v2/scandia_fy2025.json");
const AGRAS = read("e2e/fixtures/workspace_v2/agras_fy2025.json");
const PAIR = read("frontend/lib/__tests__/fixtures/comparatives/pair_served.json");
const SECTOR_PAIR = read("frontend/lib/__tests__/fixtures/sectorBenchmark/served_pair.json").with_prior;
const ATT = {
  scandia: read("frontend/lib/__tests__/fixtures/attention/scandia.attention.json"),
  agras: read("frontend/lib/__tests__/fixtures/attention/agras.attention.json"),
  pair: read("frontend/lib/__tests__/fixtures/attention/pair.attention.json"),
  pairLetter: read("frontend/lib/__tests__/fixtures/attention/pair_letter.attention.json"),
};
const SECTOR = {
  scandia: read("frontend/lib/__tests__/fixtures/attention/scandia.sector.json"),
  agras: read("frontend/lib/__tests__/fixtures/attention/agras.sector.json"),
};
/** The engine's constructed one-EBITDA books (refusal-carries), for a
 *  refusal in the exact shape the engine serves it. */
const ONE_EBITDA_BOOKS = read("frontend/lib/__tests__/fixtures/oneEbitda/constructed_books.json");

const RATES = { RON: 1, EUR: 5, USD: 4.6 };
/** The bar's money: the SERVED currency with its code, never converted
 *  (lib/money formatMoneyFrom, source = display), in the language the test
 *  READS — its locale stated here through the one mapping
 *  (moneyLocaleFor), never taken from the global i18n state. So an English
 *  row painted in Romanian format ("413,7 mil. RON") is a mismatch, and a
 *  Romanian row painted in English format too (owner ticket 2026-09-28:
 *  the English bar printed "413,7 mil. RON" and this helper, following the
 *  currency's locale, printed the same wrong string and agreed). */
const money = (v: number, lang: Lang) =>
  formatMoneyFrom(v, "RON", "RON", RATES as never, { compact: true, locale: moneyLocaleFor(lang) });

// ── host context (provided) ─────────────────────────────────────────────

const H = vi.hoisted(() => ({
  /** The header's display currency (the CurrencyMenu's choice). */
  display: "RON" as "RON" | "EUR" | "USD",
  org: null as null | { id: string; name: string; industry_key: string | null },
  orgs: [] as { id: string; name: string; industry_key: string | null }[],
  periods: [] as { period_id: string; period_end: string | null }[],
  select: (_id: string) => Promise.resolve(),
  /** The Forecast feature's status in THIS reader's registry. */
  forecast: "coming_soon" as "coming_soon" | "active",
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "user-under-test" }, status: "signed_in" }) }));
vi.mock("@/lib/apiHeaders", () => ({ authOrgHeaders: async () => ({ Authorization: "Bearer test" }) }));
vi.mock("@/lib/org", async (orig) => ({
  ...(await orig<typeof import("@/lib/org")>()),
  useActiveOrg: () => ({ org: H.org, orgs: H.orgs, archived: [], loading: false, loadError: false }),
}));
vi.mock("@/lib/usePeriodStepper", () => ({
  usePeriodStepper: () => ({
    periods: H.periods, selectedEnd: H.periods[0]?.period_end ?? null, selectedMonth: null,
    selectedYear: null, prevTarget: null, nextTarget: null, showStepper: false, goToPeriod: () => {},
  }),
}));
vi.mock("@/lib/workspaces", () => ({ useWorkspaces: () => ({ select: H.select }) }));
vi.mock("@/lib/previewFeatures", () => ({ useUploadRoute: (legacy: string) => legacy, useWorkspaceV2: () => false }));
vi.mock("@/lib/features", async (orig) => ({
  ...(await orig<typeof import("@/lib/features")>()),
  useFeatureStatus: (k: string) => (k === "forecast" ? H.forecast : "active"),
}));
vi.mock("@/components/cfo/Sidebar", () => ({
  useShellNav: () => [{ key: "core", label: "Core", items: [{ to: "/dashboard", labelKey: "sidebar.dashboard" }] }],
  SIDEBAR_TOGGLE_EVENT: "cfo-ai-sidebar-toggle",
}));
vi.mock("@/stores/currency", async (orig) => {
  // The REAL conversion into the header's display currency (H.display):
  // a surface that prints through the display toggle prints EUR here when
  // the reader chose EUR — which the bar must not (cmdbar-one-currency).
  const { formatAmountFrom: f } = await import("@/lib/money");
  const rates = { RON: 1, EUR: 5, USD: 4.6 };
  return {
    ...(await orig<typeof import("@/stores/currency")>()),
    useAmountFormatter: (from: string) => (v: number | null | undefined, opts: Record<string, unknown> = {}) =>
      f(v, (from || "RON") as never, H.display, rates as never, opts),
    useCurrency: () => ({ display: H.display, rates: { rates, source: "test", fetched_at: null }, setDisplay: () => {}, refresh: async () => {}, refreshing: false }),
    useDisplayCurrency: () => H.display,
  };
});

import { CommandPalette } from "../CommandPalette";
import { accountView, type ViewContext } from "../cmdbar/cmdbarViews";
import { LAT_CMDBAR_SEARCH, resetLatency, snapshotLatency } from "@/lib/capsuleLatency";
import { CPU_CLOCK, cpuNow, wallNow } from "@/test/cpuClock";
import { RECENTS_KEY_PREFIX } from "../cmdbar/cmdbarRecents";
import { cmdbarSectorQueryKey } from "../cmdbar/useCmdbarData";
import { OPEN_ASK_CFO_AI_EVENT } from "@/components/cfo/chat/openAskCfoAi";

/** The exhaustive tests type hundreds of queries (every leaf of a book,
 *  every ratio row): well under a second alone, but the full suite runs
 *  files in parallel and one of them met vitest's 5 s default under that
 *  load. Their bound is the WORK, not the clock; the latency laws time
 *  keystrokes themselves, on the thread's CPU (cmdbar-latency) — so a
 *  keystroke that really costs too much reds on its BUDGET, not on this
 *  hang guard. */
const HEAVY = 30_000;

// ── the fetch trap ──────────────────────────────────────────────────────

const MODEL_SEAMS = [/\/api\/capsule\/tools\//, /functions\/v1\/chat-llm/, /anthropic/i];
let fetched: string[] = [];
/** The workspace each request was asked of (its X-Org-Id), in order. */
let fetchedOrg: (string | null)[] = [];
let savedFetch: unknown;
let hangFetch = false;

beforeEach(() => {
  H.display = "RON";
  fetched = [];
  fetchedOrg = [];
  hangFetch = false;
  const g = globalThis as unknown as Record<string, unknown>;
  savedFetch = g.fetch;
  g.fetch = async (input: unknown, init?: { headers?: Record<string, string> }) => {
    fetched.push(typeof input === "string" ? input : String((input as { url?: string })?.url ?? input));
    fetchedOrg.push(init?.headers?.["X-Org-Id"] ?? null);
    if (hangFetch) return new Promise(() => {});
    return new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
  };
  try { window.localStorage.clear(); } catch { /* shim */ }
  resetLatency();
});

afterEach(async () => {
  vi.useRealTimers(); // a latency law that failed mid-way leaves no fake clock behind
  (globalThis as unknown as Record<string, unknown>).fetch = savedFetch;
  cleanup();
  await act(async () => { await i18n.changeLanguage("en"); });
});

// ── worlds ──────────────────────────────────────────────────────────────

interface World {
  body: Record<string, any>;
  org: { id: string; name: string; industry_key: string | null };
  periodId: string;
  attention?: unknown;
  sector?: unknown;
  comparatives?: unknown;
  priorId?: string | null;
  seed?: "warm" | "cold";
}

function scandiaWorld(over: Partial<World> = {}): World {
  const body = SCANDIA.period;
  return {
    body, org: { id: body.organization.id, name: body.organization.name, industry_key: "food_manufacturing" },
    periodId: body.period.id, attention: ATT.scandia, sector: SECTOR.scandia, ...over,
  };
}
function agrasWorld(over: Partial<World> = {}): World {
  const body = AGRAS.period;
  return {
    body, org: { id: body.organization.id, name: body.organization.name, industry_key: "food_manufacturing" },
    periodId: body.period.id, attention: ATT.agras, sector: SECTOR.agras, ...over,
  };
}
/** Dec 2025 vs Dec 2024 — the comparatives pair capture (with a prior). */
function pairWorld(over: Partial<World> = {}): World {
  const body = PAIR.current_body;
  return {
    body, org: { id: body.organization.id, name: body.organization.name, industry_key: null },
    // The sector capture is the same book (Agras Dec 2025) under its own
    // harness id ('p-agras-dec2025'); the bar reads a sector document only
    // when it names the period it is read for, so the world pairs it to
    // this body's period — as the engine serves it for this period.
    periodId: body.period.id, attention: ATT.pair,
    sector: { ...SECTOR_PAIR, period: { ...SECTOR_PAIR.period, id: body.period.id } },
    comparatives: PAIR.comparatives, priorId: PAIR.comparatives.prior.period_id, ...over,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

/** `onCommit`: called on every React commit of the bar (a Profiler's
 *  onRender runs after the DOM is mutated) — a law that must hold on EVERY
 *  frame, not only the settled one, reads the DOM there. */
function mount(w: World, onCommit?: () => void) {
  H.org = w.org;
  H.orgs = [w.org, { id: "org-other", name: "Other Company SRL", industry_key: null }];
  const priorPeriod = w.priorId ? [{ period_id: w.priorId, period_end: "2024-12-31", period_start: null, period_label: "Dec 2024", documents: [{ id: "d0" }] }] : [];
  H.periods = [{ period_id: w.periodId, period_end: w.body.period.period_end }];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(["period", w.periodId], { kind: "ok", data: w.body });
  // The company's own analysed periods — the list the bar reads its period
  // from when the URL names none it can use (the pair world's ids are not
  // UUIDs) and picks the comparison among. Not one of the bar's DOCUMENTS
  // (attention, comparatives, sector — what "cold" leaves out).
  qc.setQueryData(["periods-with-documents", "company", w.org.id], {
    orgId: w.org.id,
    periods: [{ period_id: w.periodId, period_end: w.body.period.period_end, period_start: null, period_label: "", documents: [{ id: "d1" }] }, ...priorPeriod],
  });
  if (w.seed !== "cold") {
    if (w.comparatives && w.priorId) qc.setQueryData(["comparatives", w.org.id, w.periodId, w.priorId], { kind: "ok", data: w.comparatives });
    if (w.sector) qc.setQueryData(cmdbarSectorQueryKey(w.org.id, w.periodId), w.sector);
    if (w.attention) qc.setQueryData(["attention", w.org.id, w.periodId, "auto"], { kind: "ok", data: w.attention });
    qc.setQueryData(["company-years", w.org.id], [{ period_id: w.periodId, year: 2025, period_end: "2025-12-31", revenue: null, revenue_change_pct: null }]);
    qc.setQueryData(["company-years", "org-other"], [{ period_id: "p-other", year: 2024, period_end: "2024-12-31", revenue: null, revenue_change_pct: null }]);
  }
  const onOpenChange = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/dashboard?period=${w.periodId}`]}>
        <Profiler id="cmdbar" onRender={() => onCommit?.()}>
          <CommandPalette open onOpenChange={onOpenChange} onOpenAi={() => {}} />
        </Profiler>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onOpenChange, qc };
}

const input = () => screen.getByTestId("capsule-composer") as HTMLTextAreaElement;
function type(q: string) {
  fireEvent.change(input(), { target: { value: q } });
}
function key(k: string, extra: Record<string, unknown> = {}) {
  fireEvent.keyDown(input(), { key: k, ...extra });
}
function rowsOf(kind: string): HTMLElement[] {
  return screen.queryAllByTestId(`cmdbar-row-${kind}`);
}
function spend(): string[] {
  return fetched.filter((u) => MODEL_SEAMS.some((re) => re.test(u)));
}
const bar = () => screen.getByTestId("cmdbar");

/** Let every pending async step run: React Query schedules its queryFn, and
 *  every app fetch first AWAITS `authOrgHeaders()` — a request a keystroke
 *  caused is issued only after the synchronous `type()` has returned. A
 *  count taken before this runs cannot see it (the defect a synchronous
 *  count hid: a per-keystroke query through the app's own hook stayed
 *  green). Several macrotask turns, each wrapped in act. */
async function flushAsync(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

/** THE DEBOUNCE HORIZON. A request a keystroke DEFERS — a debounce, a
 *  throttle, any timer — is issued only after its window, so a count taken
 *  as soon as the keystroke's promises settle cannot see it (the review of
 *  stage CB-H: `flushAsync` alone was blind to a 300 ms debounced fetch).
 *  Under fake timers every timer a keystroke armed is run, up to this far
 *  ahead, BEFORE its requests are counted. Far past any debounce a search
 *  box would use; virtual time, so it costs nothing. */
const DEBOUNCE_HORIZON_MS = 5_000;

/** Run every timer due within the horizon (fake timers on), letting each
 *  timer's promises settle in between, inside act. */
async function pastTheHorizon(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE_HORIZON_MS); });
}

/** Fake EVERY clock a debounce is built from: its timers AND the clocks
 *  it measures elapsed time on. lodash/debounce re-arms its timer until
 *  `Date.now()` says the wait has passed — with only the timers faked, the
 *  virtual horizon ran its timer again and again while the real Date barely
 *  moved, and the fetch was never issued before the count (review round 1
 *  of stage CB-I). `performance` too, for a debounce that reads it. Never
 *  the scheduler's own queue (setImmediate / MessageChannel). The latency
 *  is read on the thread's CPU clock (test/cpuClock), which no fake moves. */
const FAKED_CLOCKS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] as const;
function fakeDebounceTimers(): void {
  vi.useFakeTimers({ toFake: [...FAKED_CLOCKS] });
}

// ════════════════════════════════════════════════════════════════════════
// AT REST — "Ce contează acum"
// ════════════════════════════════════════════════════════════════════════

describe("cmdbar-swap — the empty state is THIS company's", () => {
  function restSnapshot(w: World): { figures: string[]; text: string; keys: string[] } {
    const { unmount } = mount(w);
    const items = rowsOf("now");
    const out = {
      figures: items.map((el) => el.querySelector('[data-figure="now"]')?.textContent ?? ""),
      text: items.map((el) => el.textContent ?? "").join(" | "),
      keys: items.map((el) => el.getAttribute("data-row-id") ?? ""),
    };
    unmount();
    return out;
  }

  it("the rows ARE the served items, in the served rank, each with its figure", () => {
    for (const [w, doc] of [[scandiaWorld(), ATT.scandia], [agrasWorld(), ATT.agras], [pairWorld(), ATT.pair]] as const) {
      const snap = restSnapshot(w);
      expect(snap.keys).toEqual(doc.items.map((i: { key: string }) => `now:${i.key}`));
      expect(snap.figures.every((f) => f.trim() !== "")).toBe(true);
    }
  });

  it("two companies, one fixture shape: different figures (S1) and different words (S2)", () => {
    const a = restSnapshot(scandiaWorld());
    const b = restSnapshot(agrasWorld());
    expect(a.figures.length).toBeGreaterThanOrEqual(2);
    // S1 — at least half of the cited figures differ.
    const differing = a.figures.filter((f, i) => f !== b.figures[i]).length;
    expect(differing * 2).toBeGreaterThanOrEqual(Math.max(a.figures.length, b.figures.length));
    // S2 — with every numeral masked, the rendered rows still differ.
    const mask = (s: string) => s.replace(/[0-9][0-9.,\s]*/g, "#");
    expect(mask(a.text)).not.toBe(mask(b.text));
  });

  it("the old company-agnostic surface is gone: no fixed tiles, no covenant chip, no generic question", () => {
    mount(scandiaWorld());
    const text = bar().textContent ?? "";
    expect(screen.queryByTestId("capsule-fact-tile")).toBeNull();
    expect(text).not.toMatch(/typical Romanian facility test|not your loan documents|headroom against a typical/i);
    expect(text).not.toMatch(/rent only/i);
  });

  it("the actions are the engine's, for this company's state", () => {
    mount(scandiaWorld());
    const labels = rowsOf("now-action").map((el) => el.textContent);
    // No prior year → "Add the previous year", then the bank report — the
    // engine's actions, in its order, in its words, and nothing else.
    expect(labels).toEqual(ATT.scandia.actions.map((a: { label: { en: string } }) => a.label.en));
    expect(labels).toContain("Export the bank report");
  });
});

// ── ruling R4 (owner, 2026-09-28) ───────────────────────────────────────
// "«Exportă raportul pentru bancă» → the CFO Report PDF, not the Forecast
// page (Forecast is still closed)." The CFO Report PDF is the dashboard's
// export tab (its PDF card posts the report to /api/report/pdf). Held at
// rest, typed, and from a recent pick saved before the ruling (whose id,
// "action:bank-export", used to open the Forecast) — with the Forecast
// feature OFF and ON in this reader's registry. Red on: the row missing or
// renamed, any click landing on /dashboard/forecast or off the export tab, a
// second export row for the same document.

function landedOnTheCfoReportPdf(): void {
  const loc = new URL(screen.getByTestId("location").textContent ?? "", "http://cfo.test");
  expect(loc.pathname).toBe("/dashboard");
  expect(loc.searchParams.get("tab")).toBe("export");
  expect(loc.pathname + loc.search).not.toMatch(/forecast/i);
}

describe("ruling R4 — the bank report is the CFO Report PDF", () => {
  afterEach(() => { H.forecast = "coming_soon"; });

  for (const forecast of ["coming_soon", "active"] as const) {
    it(`at rest: "Exportă raportul pentru bancă" opens the export tab (Forecast ${forecast})`, async () => {
      H.forecast = forecast;
      await act(async () => { await i18n.changeLanguage("ro"); });
      mount(scandiaWorld());
      const rows = rowsOf("now-action");
      const bank = rows.find((el) => el.getAttribute("data-row-id") === "now-action:bank_export");
      expect(bank?.textContent).toBe("Exportă raportul pentru bancă");
      // ONE export at rest: no retired "Exportă raportul CFO (PDF)" beside it.
      expect(rows.filter((el) => /Exportă/.test(el.textContent ?? ""))).toHaveLength(1);
      fireEvent.click(bank!);
      landedOnTheCfoReportPdf();
    });

    it(`typed: every bank word finds ONE export row, the CFO Report PDF (Forecast ${forecast})`, () => {
      H.forecast = forecast;
      for (const q of ["banca", "bank", "export the bank report", "raportul pentru bancă", "exporta"]) {
        mount(scandiaWorld());
        type(q);
        const exports = rowsOf("action").filter((el) => /^action:(export-pdf|bank-export)$/.test(el.getAttribute("data-row-id") ?? ""));
        expect(exports.map((el) => el.getAttribute("data-row-id")), `"${q}"`).toEqual(["action:export-pdf"]);
        fireEvent.click(exports[0]);
        landedOnTheCfoReportPdf();
        cleanup();
      }
    });
  }

  it("a recent pick saved before the ruling (it opened the Forecast) opens the CFO Report PDF", () => {
    H.forecast = "active";
    const w = scandiaWorld();
    window.localStorage.setItem(`${RECENTS_KEY_PREFIX}${w.org.id}`, JSON.stringify([
      { id: "action:bank-export", group: "action", label: "Exportă raportul pentru bancă" },
    ]));
    mount(w);
    const recent = rowsOf("recent").find((el) => (el.textContent ?? "").includes("Exportă raportul pentru bancă"));
    expect(recent).toBeTruthy();
    fireEvent.click(recent!);
    landedOnTheCfoReportPdf();
  });
});

describe("the caveat is printed ONCE for the panel", () => {
  it("one caveat node, referenced by the listbox, never repeated on an item", () => {
    mount(pairWorld({ attention: ATT.pairLetter }));
    const caveats = screen.getAllByTestId("cmdbar-caveat");
    expect(caveats).toHaveLength(1);
    const text = ATT.pairLetter.caveats[0].text.en;
    expect(caveats[0].textContent).toBe(text);
    const listbox = within(bar()).getByRole("listbox");
    expect(listbox.getAttribute("aria-describedby")).toBe(caveats[0].id);
    const occurrences = (bar().textContent ?? "").split(text).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("each item opens its evidence", () => {
  it("a statement item opens its statement tab; a sector item its benchmark row", () => {
    mount(pairWorld());
    fireEvent.click(rowsOf("now")[0]);
    expect(screen.getByTestId("location").textContent).toContain("tab=balance_sheet");
    cleanup();
    mount(pairWorld());
    fireEvent.click(rowsOf("now")[1]);
    expect(screen.getByTestId("location").textContent).toMatch(/^\/benchmark\?.*row=receivables_days/);
  });

  it("the filed-basis inventory row is a POSITION with the owner's label ONCE, never a verdict", () => {
    mount(scandiaWorld());
    const row = rowsOf("now").find((el) => el.getAttribute("data-row-id") === "now:inventory_days_on_turnover")!;
    const text = row.textContent ?? "";
    expect(text).toContain("filed basis (stock ÷ net turnover)");
    expect(text.split("filed basis (stock ÷ net turnover)").length - 1, "the label, once").toBe(1);
    expect(row.querySelector("[data-basis]"), "no second basis note").toBeNull();
    expect(text).not.toMatch(/worse than the sector|slow/i);
  });
});

// ════════════════════════════════════════════════════════════════════════
// TYPING — Răspuns · Cont · Pagină · Acțiune · Întreabă CFO AI
// ════════════════════════════════════════════════════════════════════════

describe("the groups, in order, answer first, Întreabă last", () => {
  it("'profit' (with a prior): the account-121 result, its Δ, its margin, then the rest", () => {
    mount(pairWorld());
    type("profit");
    const headings = screen.getAllByTestId(/cmdbar-heading-/).map((el) => el.getAttribute("data-testid"));
    expect(headings[0]).toBe("cmdbar-heading-answer");
    expect(headings[headings.length - 1]).toBe("cmdbar-heading-ask");
    const answer = rowsOf("answer")[0];
    const pl = PAIR.current_body.statements.assembled_pl;
    expect(answer.querySelector('[data-figure="answer"]')?.textContent).toBe(money(pl.net_income_statutory, "en"));
    expect(answer.textContent).toContain("from account 121");
    const col = PAIR.comparatives.columns.find((c: { key: string }) => c.key === "pl.net_income");
    expect(answer.textContent).toContain(`${formatDeltaPct(col.delta_pct)} vs ${PAIR.comparatives.prior.label}`);
    const margin = PAIR.current_body.assembled_metrics.ratio_table.rows.find((r: { key: string }) => r.key === "net_margin");
    expect(answer.textContent).toContain(formatRatioSide(margin, margin.display_unit, "en"));
  });

  it("a move across zero is a WORD, never a percentage", () => {
    mount(pairWorld());
    type("datorii");
    const answer = rowsOf("answer")[0];
    const col = PAIR.comparatives.columns.find((c: { key: string }) => c.key === "bs.total_debt");
    expect(col.change_kind).toBe("from_zero");
    expect(answer.textContent).toContain("from zero");
    expect(answer.textContent).not.toMatch(/%\s*vs/);
  });

  it("Tab jumps to 'Ask CFO AI'; Enter SENDS it to the chat, and the bar itself calls no model", () => {
    const seen: unknown[] = [];
    const onAsk = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_ASK_CFO_AI_EVENT, onAsk);
    try {
      mount(scandiaWorld());
      type("de ce a scăzut marja");
      key("Tab");
      const active = within(bar()).getAllByRole("option").find((el) => el.getAttribute("aria-selected") === "true")!;
      expect(active.getAttribute("data-row-kind")).toBe("ask");
      key("Enter");
      expect(seen).toEqual([{ prompt: "de ce a scăzut marja", send: true }]);
      expect(spend()).toEqual([]);
    } finally {
      window.removeEventListener(OPEN_ASK_CFO_AI_EVENT, onAsk);
    }
  });

  it("↑↓ walk the rows the reader sees; Enter on a page opens it", () => {
    mount(scandiaWorld());
    type("bilant");
    const options = () => within(bar()).getAllByRole("option");
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    const pageIdx = options().findIndex((el) => el.getAttribute("data-row-kind") === "page");
    for (let i = 0; i < pageIdx; i++) key("ArrowDown");
    expect(options()[pageIdx].getAttribute("aria-selected")).toBe("true");
    key("Enter");
    expect(screen.getByTestId("location").textContent).toContain("tab=balance_sheet");
  });

  it("Esc closes the bar", () => {
    const { onOpenChange } = mount(scandiaWorld());
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Romanian: the five groups by their Romanian names, diacritics intact", async () => {
    await act(async () => { await i18n.changeLanguage("ro"); });
    mount(scandiaWorld());
    type("clienti");
    const names = screen.getAllByTestId(/cmdbar-heading-/).map((el) => el.textContent);
    expect(names).toEqual(expect.arrayContaining(["Răspuns", "Cont", "Întreabă CFO AI"]));
    expect(screen.getByTestId("cmdbar-scope").textContent).toMatch(/^Caut în Scandia Food SRL · /);
  });
});

/** Each statement answer's served figure, read INDEPENDENTLY of the bar's
 *  own term table (cmdbarTerms.json): the path the engine serves it at. */
function servedPath(body: Record<string, any>, answerId: string): number | null {
  const pl = body.statements.assembled_pl;
  const bs = body.statements.assembled_bs;
  return ({
    turnover: pl.revenue, ebitda: pl.ebitda, operating_result: pl.ebit, net_result: pl.net_income_statutory,
    cash: bs.cash, debt: bs.total_debt, inventory: bs.inventory, receivables: bs.ar_net,
    payables: bs.ap, equity: bs.total_equity, total_assets: bs.total_assets,
  } as Record<string, number | null>)[answerId] ?? null;
}

/** One query per statement answer — Romanian words, diacritics left off. */
const QUERIES: Record<string, string> = {
  turnover: "cifra de afaceri", ebitda: "ebitda", operating_result: "rezultat din exploatare",
  net_result: "profit net", cash: "numerar", debt: "datorie totala", inventory: "stocuri",
  receivables: "creante", payables: "furnizori", equity: "capitaluri proprii", total_assets: "total active",
};

describe("cmdbar-figures — every figure is the served figure", () => {
  const cases: [string, World][] = [["scandia", scandiaWorld()], ["agras", agrasWorld()]];

  it.each(cases)("%s — each statement answer prints the served value through the shared printer", (_n, w) => {
    mount(w);
    let checked = 0;
    for (const [id, q] of Object.entries(QUERIES)) {
      type(q);
      const row = rowsOf("answer").find((el) => el.getAttribute("data-row-id") === `answer:${id}`);
      expect(row, `${id} answers "${q}"`).toBeTruthy();
      const served = servedPath(w.body, id);
      expect(served, id).not.toBeNull();
      expect(row!.querySelector('[data-figure="answer"]')?.textContent, id).toBe(money(served as number, "en"));
      checked++;
    }
    expect(checked).toBe(Object.keys(QUERIES).length);
  });

  it.each(cases)("%s — every ratio answer is its ratio_table row, never metrics[]", (_n, w) => {
    mount(w);
    const rows: RatioTableRow[] = w.body.assembled_metrics.ratio_table.rows;
    const metrics = new Map<string, number>((w.body.metrics ?? []).map((m: { name: string; value: number }) => [m.name, m.value]));
    let differsFromMetrics = 0;
    let checked = 0;
    for (const r of rows) {
      if (r.key === "dio") continue; // through the inventory-days adapter, below
      type(r.key.replace(/_/g, " "));
      const row = rowsOf("answer").find((el) => el.getAttribute("data-row-id") === `ratio:${r.key}`);
      // EVERY served row is reachable by its own name — a skipped row is a
      // row whose figure nobody checked.
      expect(row, `"${r.key.replace(/_/g, " ")}" answers ratio:${r.key}`).toBeTruthy();
      const printed = row!.querySelector('[data-figure="answer"]')?.textContent
        ?? row!.querySelector("[data-absent]")?.textContent;
      expect(printed, r.key).toBe(formatRatioSide(r, r.display_unit, "en"));
      checked++;
      const m = metrics.get(r.key);
      if (typeof m === "number" && typeof r.value === "number" && Math.abs(m - r.value) > 1e-9) differsFromMetrics++;
    }
    expect(checked, "every ratio_table row but dio").toBe(rows.filter((r) => r.key !== "dio").length);
    expect(checked).toBeGreaterThanOrEqual(20);
    // POSITIVE CONTROL: on this book metrics[] disagrees with the table for
    // some row, so a bar reading metrics[] would print a different figure.
    expect(differsFromMetrics).toBeGreaterThan(0);
  }, HEAVY);

  // THE SERVED BLOCK (merge contract 2026-09-28): the bar prints the ONE
  // inventory-days block — its total at the block's own quantization (the
  // string the Ratios tile prints), the served basis LABEL (never the code,
  // never the retired "closing stock ÷ total operating cost"), and never the
  // filed-basis sector row beside it.
  for (const [name, world] of [["scandia", () => scandiaWorld()], ["agras", () => agrasWorld()]] as const) {
    it(`${name}: inventory days are the served block — its figure, its basis label, no filed-basis row beside it, never slow`, async () => {
      for (const lang of ["en", "ro"] as const) {
        await useLang(lang);
        const w = world();
        mount(w);
        type("zile stoc");
        const block = w.body.statements.inventory_days;
        expect(block?.schema, "the capture serves the block").toBe("inventory_days/1");
        const printed = formatRatioSide(
          { value: null, value_q: block.total.value_q, band: null, band_status: "graded", ladder: null,
            ladder_floor: null, operands: [], reason: null } as unknown as RatioTableRow,
          "days", lang);
        const row = rowsOf("answer").find((el) => el.getAttribute("data-row-id") === "answer:inventory")!;
        expect(row.textContent).toContain(`${ratioLabelForKey("dio", lang)} ${printed}`);
        // One printed string: the Ratios tile's dio row prints the same.
        const dio = w.body.assembled_metrics.ratio_table.rows.find((r: { key: string }) => r.key === "dio");
        expect(formatRatioSide(dio, dio.display_unit, lang)).toBe(printed);
        expect(row.querySelector("[data-basis]")?.textContent).toBe(block.basis_label[lang]);
        expect(row.textContent).not.toContain(block.basis);
        expect(row.textContent).not.toMatch(/total operating cost|cheltuieli totale de exploatare/);
        const filedLabel = i18n.getFixedT(lang)("benchmarkPage.sector.ratio.inventory_days_on_turnover");
        expect(row.textContent).not.toContain(filedLabel);
        expect(row.textContent).not.toMatch(/bază depusă|filed basis/);
        const lead = i18n.getFixedT(lang)("cmdbar.figure.sector", { what: "\u0000", position: "" }).split("\u0000")[0];
        const sectorChips = Array.from(row.querySelectorAll("[data-chip-state]"))
          .filter((el) => (el.textContent ?? "").startsWith(lead));
        expect(sectorChips.map((el) => el.textContent), "no sector chip beside the split").toEqual([]);
        expect(row.textContent).not.toMatch(/\bslow\b|lent/i);
        cleanup();
      }
    });
  }

  it("a period that serves NO block prints that reason — never the ratio table's days, never a retired formula", async () => {
    await useLang("en");
    const body = structuredClone(SCANDIA.period);
    delete body.statements.inventory_days;
    delete body.assembled_metrics.inventory_days;
    const dio = body.assembled_metrics.ratio_table.rows.find((r: { key: string }) => r.key === "dio");
    expect(dio.value_q, "POSITIVE CONTROL: a ratio-table dio row is still there to be misread").not.toBeNull();
    mount(scandiaWorld({ body }));
    type("zile stoc");
    const row = rowsOf("answer").find((el) => el.getAttribute("data-row-id") === "answer:inventory")!;
    expect(row.textContent).toContain(i18n.getFixedT("en")("cmdbar.absent.inventory_days_absent"));
    expect(row.textContent).not.toContain(formatRatioSide(dio, dio.display_unit, "en"));
    expect(row.querySelector("[data-basis]")).toBeNull();
    expect(row.textContent).not.toMatch(/total operating cost/);
  });

  it("a period on the single-day snapshot prints ITS basis label; a refused block prints the engine's reason, never a figure", async () => {
    await useLang("en");
    const body = structuredClone(SCANDIA.period);
    // CONSTRUCTED from the served block: the fields the printer reads —
    // the basis and its served label — moved to the snapshot's.
    body.statements.inventory_days.basis = "year_end_snapshot";
    body.statements.inventory_days.basis_label = body.statements.inventory_days.ccc_dio_term.basis_label;
    mount(scandiaWorld({ body }));
    type("zile stoc");
    let row = rowsOf("answer").find((el) => el.getAttribute("data-row-id") === "answer:inventory")!;
    expect(row.querySelector("[data-basis]")?.textContent).toBe(body.statements.inventory_days.ccc_dio_term.basis_label.en);
    expect(row.querySelector("[data-basis]")?.textContent).toMatch(/a single day/);
    cleanup();
    const refused = structuredClone(SCANDIA.period);
    const reason = { code: "stock_variation_refused", inputs: [],
      text_ro: "variația stocurilor de produse (711) nu a putut fi măsurată, deci costul producției vândute nu este cunoscut",
      text_en: "the change in inventories of products (711) could not be measured, so the cost of production sold is not known" };
    refused.statements.inventory_days.total = { ...refused.statements.inventory_days.total, value: null, value_q: null, reason };
    mount(scandiaWorld({ body: refused }));
    type("zile stoc");
    row = rowsOf("answer").find((el) => el.getAttribute("data-row-id") === "answer:inventory")!;
    expect(row.textContent).toContain(reason.text_en);
    expect(row.textContent).not.toContain("stock_variation_refused");
    expect(row.textContent).not.toMatch(/(^|\s)0 days/);
  });

  it("Cont: a leaf account prints its served amount, its key metric, and opens the account", () => {
    const w = scandiaWorld();
    mount(w);
    type("411101");
    const row = rowsOf("account")[0];
    const item = w.body.line_items.find((li: { ro_account_code: string }) => li.ro_account_code === "411101");
    expect(row.querySelector('[data-figure="account"]')?.textContent).toBe(money(item.amount, "en"));
    const dso = w.body.assembled_metrics.ratio_table.rows.find((r: { key: string }) => r.key === "dso");
    expect(row.textContent).toContain(formatRatioSide(dso, dso.display_unit, "en"));
    fireEvent.click(row);
    expect(screen.getByTestId("location").textContent).toMatch(/tab=balance_sheet.*account=411101/);
  });

  it("the digit rule holds on the surface: '4112' opens no 4111 account", () => {
    mount(scandiaWorld());
    type("4112");
    expect(rowsOf("account").some((el) => (el.textContent ?? "").includes("4111"))).toBe(false);
    type("4111");
    expect(rowsOf("account").length).toBeGreaterThan(0);
  });
});

describe("Cont — nothing past the cap is hidden; the material accounts are the ones shown", () => {
  // The owner's own example: "4111" on Scandia. Six 4111 leaves; the first
  // three by CODE hold 1.47M of a 12.65M receivable — 411121 alone holds
  // 11.03M (87 %) and was invisible, with nothing saying more existed.
  it("'4111': the three largest leaves by served balance, then ONE row counting the rest and opening all six", () => {
    const w = scandiaWorld();
    mount(w);
    type("4111");
    const leaves = (w.body.line_items as { ro_account_code: string; amount: number; statement: string }[])
      .filter((li) => li.statement !== "IGNORED" && li.ro_account_code.startsWith("4111"));
    expect(leaves.length).toBe(6);
    const largest = [...leaves].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 3).map((li) => li.ro_account_code);
    expect(largest[0]).toBe("411121");
    const shown = rowsOf("account").map((el) => el.getAttribute("data-row-id")!.split(":")[1]);
    expect(shown).toEqual(largest);
    const more = rowsOf("account-more");
    expect(more).toHaveLength(1);
    expect(more[0].textContent).toBe("All accounts starting with 4111: 6 (3 more)");
    // It sits in the Cont group, under its heading — no heading of its own.
    expect(screen.queryAllByTestId("cmdbar-heading-account")).toHaveLength(1);
    fireEvent.click(more[0]);
    const loc = new URL(screen.getByTestId("location").textContent ?? "", "http://cfo.test");
    expect(loc.searchParams.getAll("account")).toEqual(["4111"]);
    expect(loc.searchParams.get("tab")).toBe("balance_sheet");
  });

  it("a name query counts every account it matched and opens exactly those", () => {
    const w = scandiaWorld();
    mount(w);
    type("clienti");
    const more = rowsOf("account-more")[0];
    expect(more, "clienti overflows the Cont group").toBeTruthy();
    const n = Number(more.querySelector("[data-more]")?.getAttribute("data-more"));
    expect(n).toBeGreaterThan(0);
    expect(more.textContent).toMatch(/^All accounts matching “clienti”: \d+ \(\d+ more\)$/);
    fireEvent.click(more);
    const loc = new URL(screen.getByTestId("location").textContent ?? "", "http://cfo.test");
    expect(loc.searchParams.getAll("account").length).toBe(3 + n);
  });

  it("the keyboard reaches it: ↓ past the last account selects the overflow row, Enter opens it", () => {
    mount(scandiaWorld());
    type("4111");
    const all = screen.getAllByRole("option");
    const idx = all.findIndex((el) => el.getAttribute("data-row-kind") === "account-more");
    expect(idx).toBeGreaterThan(0);
    for (let i = 0; i < idx; i++) key("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(all[idx].id);
    key("Enter");
    expect(screen.getByTestId("location").textContent).toContain("account=4111");
  });

  it("Romanian: the overflow row speaks Romanian, with diacritics", async () => {
    await act(async () => { await i18n.changeLanguage("ro"); });
    mount(scandiaWorld());
    type("4111");
    expect(rowsOf("account-more")[0].textContent).toBe("Toate conturile care încep cu 4111: 6 (încă 3)");
  });

  it("no overflow, no row: a query whose accounts all fit says nothing more", () => {
    mount(scandiaWorld());
    type("5121");
    expect(rowsOf("account").length).toBeGreaterThan(0);
    expect(rowsOf("account-more")).toHaveLength(0);
  });
});

describe("cmdbar-legible — a figure, its context and its basis are never cut", () => {
  // Found live (review, 2026-09-27): the context line was one `truncate`
  // span, so at 1440 "stoc" ended "…Zile stocuri raportate la ci…" — the
  // sector value, its position, the "bază depusă" label and the inventory
  // basis the owner requires were in the DOM (every textContent gate passed)
  // and off the screen; at 390 "Marja operațională 6…" cut a FIGURE. The law
  // here is structural (jsdom has no layout): nothing that carries a figure,
  // a change, a position or a basis sits in, or under, a truncating box. The
  // live G9 (e2e/design/cmdbar.spec.ts) holds each box inside its row, on
  // screen, at 1440 and 390.
  const CARRIERS = "[data-figure],[data-absent],[data-basis],[data-chip-state],[data-context],[data-chips],[data-key-metric],[data-more]";
  const CUTS = /(^|\s)(truncate|text-ellipsis|line-clamp-\d+)(\s|$)/;
  function cut(el: Element): string | null {
    for (let n: Element | null = el; n && n.getAttribute("role") !== "option"; n = n.parentElement) {
      const cls = n.getAttribute("class") ?? "";
      if (CUTS.test(cls)) return cls.match(CUTS)![2];
    }
    return null;
  }
  const worlds: [string, () => World][] = [["scandia", () => scandiaWorld()], ["agras", () => agrasWorld()], ["pair", () => pairWorld()]];
  for (const lang of LANGS) {
    it(`${lang}: at rest and typed, every carrier on every row is outside any truncating box`, async () => {
      await useLang(lang);
      let carriers = 0;
      let bases = 0;
      const bad: string[] = [];
      for (const [name, make] of worlds) {
        const { unmount } = mount(make());
        for (const q of ["", "stoc", "clienti", "profit", "4111", "cifra de afaceri", "zile stoc", "marja operationala"]) {
          type(q);
          for (const opt of screen.queryAllByRole("option")) {
            for (const el of Array.from(opt.querySelectorAll(CARRIERS))) {
              carriers++;
              if (el.hasAttribute("data-basis")) bases++;
              const c = cut(el);
              if (c) bad.push(`${name} "${q}" ${opt.getAttribute("data-row-id")}: ${el.outerHTML.slice(0, 60)}… under .${c}`);
            }
          }
        }
        unmount();
      }
      expect(bad, "carriers inside a truncating box").toEqual([]);
      // POSITIVE CONTROL: the rows carried figures, chips and — the owner's
      // requirement — the inventory basis and the filed-basis label.
      expect(carriers).toBeGreaterThanOrEqual(100);
      expect(bases).toBeGreaterThanOrEqual(3);
    }, HEAVY);
  }
});

describe("cmdbar-one-currency — the SERVED currency, with its code, whatever the display toggle says", () => {
  // Found by review (2026-09-27), display currency EUR: "profit" painted
  // "Net result 81.060,2 from account 121" — the served 402,869.16 RON
  // divided by a browser rate, no currency, labelled as account 121 — and
  // "cifra de afaceri" "9,7 Mio.", beside "What matters now" items printed
  // "RON -2,577,640.82": one panel, two currencies, one of them unnamed.
  it.each(["RON", "EUR", "USD"] as const)("display %s: every money figure is the served RON figure with its code; account 121 is named only on the served figure", (display) => {
    H.display = display;
    const w = scandiaWorld();
    mount(w);
    // At rest: every item figure that is money names RON; none names another currency.
    const rest = rowsOf("now").map((el) => el.querySelector('[data-figure="now"]')?.textContent ?? "");
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.filter((f) => /RON/.test(f)).length, "the resting money items name their currency").toBeGreaterThanOrEqual(2);
    for (const f of rest) expect(f).not.toMatch(/€|\$|\bEUR\b|\bUSD\b/);
    type("profit");
    const net = answerRowById("answer:net_result")!;
    const served = w.body.statements.assembled_pl.net_income_statutory as number;
    expect(net.querySelector('[data-figure="answer"]')?.textContent).toBe(money(served, "en"));
    expect(net.querySelector('[data-figure="answer"]')?.textContent).toMatch(/RON$/);
    expect(net.textContent).toContain("from account 121");
    type("cifra de afaceri");
    const turnover = answerRowById("answer:turnover")!;
    expect(turnover.querySelector('[data-figure="answer"]')?.textContent).toBe(money(w.body.statements.assembled_pl.revenue, "en"));
    type("4111");
    for (const el of rowsOf("account")) expect(el.querySelector('[data-figure="account"]')?.textContent).toMatch(/RON$/);
    // Nothing anywhere in the panel is in the display currency.
    for (const q of ["profit", "cifra de afaceri", "numerar", "4111", "clienti"]) {
      type(q);
      expect(bar().textContent, q).not.toMatch(/€|\$|\bEUR\b|\bUSD\b/);
    }
  });
});

function answerRowById(id: string): HTMLElement | undefined {
  return screen.queryAllByTestId("cmdbar-row-answer").find((el) => el.getAttribute("data-row-id") === id);
}

describe("absent is never 0", () => {
  it("a net result not anchored to account 121 prints the reason, not a figure", () => {
    const body = structuredClone(SCANDIA.period);
    body.statements.assembled_pl.net_income_anchor_status = "absent";
    mount(scandiaWorld({ body }));
    type("profit");
    const row = rowsOf("answer").find((el) => el.getAttribute("data-row-id") === "answer:net_result")!;
    expect(row.querySelector('[data-figure="answer"]')).toBeNull();
    expect(row.querySelector("[data-absent]")?.textContent).toMatch(/not anchored to account 121/);
    expect(row.textContent).not.toContain("from account 121");
  });

  it("a refused EBITDA prints the engine's own words — the refusal the one-EBITDA ruling serves, never its code, never 0", async () => {
    // The served shape: assembled_pl.ebitda null beside ebitda_refusal
    // {code, text_ro, text_en, source, fields} — taken from the engine's
    // constructed 'unanchored' book (oneEbitda/constructed_books.json).
    const served = ONE_EBITDA_BOOKS.unanchored.statements.assembled_pl.ebitda_refusal;
    expect(served.code).toBe("account_121_anchor_absent");
    for (const lang of ["en", "ro"] as const) {
      await useLang(lang);
      const body = structuredClone(SCANDIA.period);
      body.statements.assembled_pl.ebitda = null;
      body.statements.assembled_pl.ebitda_refusal = served;
      mount(scandiaWorld({ body }));
      type("ebitda");
      const row = rowsOf("answer").find((el) => el.getAttribute("data-row-id") === "answer:ebitda")!;
      expect(row.querySelector('[data-figure="answer"]')).toBeNull();
      expect(row.textContent).toContain(lang === "ro" ? served.text_ro : served.text_en);
      expect(row.textContent).not.toContain(served.code);
      expect(row.textContent).not.toMatch(/(^|\s)0(\s|$)/);
      cleanup();
    }
  });

  it("no prior: the Δ says there is none — not blank, not 0", () => {
    mount(scandiaWorld());
    type("cifra de afaceri");
    const row = rowsOf("answer")[0];
    expect(row.querySelector('[data-chip-state="none"]')?.textContent).toBe("no comparable prior period");
  });
});

describe("cmdbar-latency — warm cache, cold open", () => {
  it("warm: every keystroke renders under 100 ms and fetches NOTHING — not even after a debounce", async () => {
    fakeDebounceTimers();
    mount(pairWorld());
    // The mount's own settling (nothing should be asked for: every document
    // is seeded) is not a keystroke's.
    await pastTheHorizon();
    const before = fetched.length;
    const cpus: number[] = [];
    const walls: number[] = [];
    const perKeystroke: string[] = [];
    let horizons = 0;
    // POSITIVE CONTROL: the clocks a debounce measures time on are fake —
    // the horizon moves them, not the real time that passes.
    const d0 = Date.now();
    const p0 = performance.now();
    await pastTheHorizon();
    expect(Date.now() - d0, "Date is on the fake clock").toBe(DEBOUNCE_HORIZON_MS);
    expect(performance.now() - p0, "performance is on the fake clock").toBe(DEBOUNCE_HORIZON_MS);
    for (const q of ["profit", "clienti", "4111", "bilant", "cifra de afaceri", "furnizrii", "marja neta", "exporta"]) {
      for (let i = 1; i <= q.length; i++) {
        const c0 = cpuNow();
        const w0 = wallNow();
        type(q.slice(0, i));
        cpus.push(cpuNow() - c0);
        walls.push(wallNow() - w0);
        // Count AFTER the keystroke's async work AND every timer it armed
        // have run — a request is issued only once authOrgHeaders()
        // resolves, and a debounced one only after its window (both outside
        // the timing).
        const n = fetched.length;
        await pastTheHorizon();
        horizons++;
        if (fetched.length > n) perKeystroke.push(`"${q.slice(0, i)}": ${fetched.slice(n).join(", ")}`);
      }
    }
    vi.useRealTimers();
    expect(perKeystroke, "requests caused by a keystroke").toEqual([]);
    expect(fetched.length - before).toBe(0);
    expect(horizons, "VACUITY: every keystroke waited out the debounce horizon").toBe(cpus.length);
    const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
    // THE BUDGET, on the work: the render thread's CPU per keystroke.
    expect(p95(cpus), `p95 keystroke work (${CPU_CLOCK}, ms)`).toBeLessThan(100);
    // The app's own instrument ran on every keystroke (its figure reads
    // the faked performance clock here; the real one is held live, G7).
    const search = snapshotLatency()[LAT_CMDBAR_SEARCH] ?? [];
    expect(search.length).toBeGreaterThan(40);
    console.log(`GATE-WORK cmdbar-latency warm keystrokes=${cpus.length} clock=${CPU_CLOCK} cpu_p95_ms=${p95(cpus).toFixed(1)} cpu_max_ms=${Math.max(...cpus).toFixed(1)} wall_p95_ms=${p95(walls).toFixed(1)} (wall not asserted)`);
  }, HEAVY);

  it("cold: the value first; Δ and vs-sector say 'loading' — never blank, never 0", () => {
    hangFetch = true;
    mount(pairWorld({ seed: "cold" }));
    type("profit");
    const row = rowsOf("answer")[0];
    expect(row.querySelector('[data-figure="answer"]')?.textContent).toBe(
      money(PAIR.current_body.statements.assembled_pl.net_income_statutory, "en"));
    const pending = row.querySelectorAll('[data-chip-state="pending"]');
    expect(pending.length).toBeGreaterThanOrEqual(1);
    for (const el of Array.from(pending)) expect(el.textContent).toBe("loading");
    // At rest, the empty state says it is reading — never an empty panel.
    type("");
    expect(screen.getByTestId("cmdbar-status").textContent).toBe("Reading this period…");
  });
});

describe("cmdbar-no-model — no model call, no model text", () => {
  const SENTINEL = "MODEL-SENTINEL 987654.32";
  it("planted model text in every field the bar must not read never reaches it", () => {
    const body = structuredClone(SCANDIA.period);
    body.recommendations = [{ id: "r", title: SENTINEL, body: SENTINEL, impact_ron: 987654.32, urgency: "high" }];
    body.briefing = { body: SENTINEL, language: "en", model: "x" };
    body.alerts = [{ rule_key: "ai_council", title: SENTINEL, body: SENTINEL, severity: "critical" }];
    for (const m of body.metrics ?? []) m.value = 987654.32;
    for (const ins of body.statements.insights?.insights ?? []) {
      ins.narrative = { text: SENTINEL }; ins.claim = SENTINEL; ins.title = SENTINEL;
    }
    mount(scandiaWorld({ body }));
    const seen = [bar().textContent ?? ""];
    for (const q of ["profit", "risc", "recomandari", "marja", "clienti", "ebitda", "alert", "briefing"]) {
      type(q);
      seen.push(bar().textContent ?? "");
    }
    for (const text of seen) {
      expect(text).not.toContain("MODEL-SENTINEL");
      expect(text).not.toMatch(/987[.,]?654/);
    }
    expect(spend()).toEqual([]);
  });
});

describe("the header line names the company and period being searched", () => {
  it("names both, from the SAME period the facts come from", () => {
    mount(scandiaWorld());
    expect(screen.getByTestId("cmdbar-scope").textContent).toBe("Searching Scandia Food SRL · Dec 2025");
  });

  it("a period of ANOTHER company is not searched under this one's name", () => {
    const w = scandiaWorld();
    mount({ ...w, org: { id: "org-else", name: "Else SRL", industry_key: null } });
    expect(screen.getByTestId("cmdbar-scope").textContent).toMatch(/belongs to another company/);
    type("profit");
    expect(rowsOf("answer")).toHaveLength(0);
  });
});

describe("recent searches — picked rows, per company, on this device", () => {
  it("a picked row is remembered for this company and offered at rest", () => {
    const w = scandiaWorld();
    const first = mount(w);
    type("bilant");
    const page = rowsOf("page")[0];
    fireEvent.click(page);
    const stored = JSON.parse(window.localStorage.getItem(`${RECENTS_KEY_PREFIX}${w.org.id}`) ?? "[]");
    expect(stored[0].group).toBe("page");
    first.unmount();
    mount(w);
    expect(rowsOf("recent").map((el) => el.textContent)).toContain(stored[0].label);
  });

  it("corrupt storage degrades to no recents, never a broken bar", () => {
    const w = scandiaWorld();
    window.localStorage.setItem(`${RECENTS_KEY_PREFIX}${w.org.id}`, "{not json");
    mount(w);
    expect(rowsOf("recent")).toHaveLength(0);
    expect(rowsOf("now").length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// STAGE CB-G (design C5) — the laws above held EXHAUSTIVELY, in both
// languages, and the ones held only in part until now: every Cont leaf of
// both books, every Δ against its comparatives column, every vs-sector
// position against its sector row, the cold open under 100 ms, synonyms and
// diacritics on the RENDERED surface, and the whole keyboard flow. Each
// rule has its own plant in docs/engine_book/gates.md ("cmdbar-surface",
// stage CB-G).
// ════════════════════════════════════════════════════════════════════════

const LANGS = ["en", "ro"] as const;
type Lang = (typeof LANGS)[number];

async function useLang(lang: Lang) {
  await act(async () => { await i18n.changeLanguage(lang); });
}

/** The ratio_table row the design names as an account's key metric
 *  (C2: 411x → DSO, 401x → DPO, 3xx → inventory days, 512x / 531x → cash
 *  ratio) — written here, NOT read from the bar's own table, so a bar that
 *  attaches the wrong metric to a family reds. Other families are held to
 *  their amount only. */
function designKeyMetric(code: string): string | null {
  if (code.startsWith("411")) return "dso";
  if (code.startsWith("401")) return "dpo";
  if (code.startsWith("3")) return "dio";
  if (code.startsWith("512") || code.startsWith("531")) return "cash_ratio";
  return null;
}

/** The comparatives line each statement answer is compared on — the
 *  engine's line keys (src/engine/comparatives/lines.py). */
const LINE_OF: Record<string, string> = {
  turnover: "pl.revenue", ebitda: "pl.ebitda", operating_result: "pl.ebit", net_result: "pl.net_income",
  cash: "bs.cash", debt: "bs.total_debt", inventory: "bs.inventory", receivables: "bs.trade_receivables_net",
  payables: "bs.trade_payables", equity: "bs.total_equity", total_assets: "bs.total_assets",
};

/** The sector row the benchmark page compares each statement answer on. */
const SECTOR_OF: Record<string, string> = {
  turnover: "revenue_growth", net_result: "net_margin",
  receivables: "receivables_days", equity: "equity_ratio",
};

function answerRow(id: string): HTMLElement | undefined {
  return rowsOf("answer").find((el) => el.getAttribute("data-row-id") === id);
}

function chipTexts(row: HTMLElement): { state: string; text: string }[] {
  return Array.from(row.querySelectorAll("[data-chip-state]")).map((el) => ({
    state: el.getAttribute("data-chip-state") ?? "",
    text: el.textContent ?? "",
  }));
}

describe("cmdbar-figures — EVERY Cont leaf of both books, in both languages", () => {
  const books: [string, () => World][] = [["scandia", () => scandiaWorld()], ["agras", () => agrasWorld()]];
  for (const [name, world] of books) {
    for (const lang of LANGS) {
      it(`${name} (${lang}): each leaf, found by its own code, prints its served amount and the design's key metric from ratio_table`, async () => {
        await useLang(lang);
        const w = world();
        mount(w);
        const table = new Map<string, RatioTableRow>(
          (w.body.assembled_metrics.ratio_table.rows as RatioTableRow[]).map((r) => [r.key, r]));
        const leaves = (w.body.line_items as { ro_account_code: string; bucket: string; amount: number; statement: string }[])
          .filter((li) => typeof li.ro_account_code === "string" && li.statement !== "IGNORED");
        let amounts = 0;
        let metrics = 0;
        let negatives = 0;
        for (const li of leaves) {
          type(li.ro_account_code);
          const row = rowsOf("account").find(
            (el) => el.getAttribute("data-row-id") === `account:${li.ro_account_code}:${li.bucket}`);
          expect(row, `"${li.ro_account_code}" finds its own leaf`).toBeTruthy();
          expect(row!.querySelector('[data-figure="account"]')?.textContent, li.ro_account_code).toBe(money(li.amount, lang));
          amounts++;
          if (li.amount < 0) negatives++;
          const key = designKeyMetric(li.ro_account_code);
          if (key) {
            const r = table.get(key)!;
            expect(r, `${key} is served`).toBeTruthy();
            expect(row!.textContent, `${li.ro_account_code} → ${key}`)
              .toContain(`${ratioLabelForKey(key, lang)} ${formatRatioSide(r, r.display_unit, lang)}`);
            metrics++;
          }
        }
        console.log(`GATE-WORK cmdbar-cont-leaves ${name}/${lang} leaves=${amounts} key_metrics=${metrics}`);
        expect(amounts, "VACUITY: every leaf of the book").toBe(leaves.length);
        expect(amounts).toBeGreaterThanOrEqual(280);
        expect(metrics, "VACUITY: key metrics checked").toBeGreaterThanOrEqual(10);
        // POSITIVE CONTROL: the book holds contra accounts, so a printer that
        // dropped the sign would print another figure for them.
        expect(negatives).toBeGreaterThan(0);
      }, HEAVY);
    }
  }
});

describe("cmdbar-figures — every Răspuns in Romanian too", () => {
  const books: [string, () => World][] = [["scandia", () => scandiaWorld()], ["agras", () => agrasWorld()]];
  it.each(books)("%s (ro): statement answers print the served value; ratios their ratio_table row in Romanian", async (_n, world) => {
    await useLang("ro");
    const w = world();
    mount(w);
    for (const [id, q] of Object.entries(QUERIES)) {
      type(q);
      const row = answerRow(`answer:${id}`);
      expect(row, `${id} answers "${q}"`).toBeTruthy();
      expect(row!.querySelector('[data-figure="answer"]')?.textContent, id).toBe(money(servedPath(w.body, id) as number, "ro"));
    }
    let ratios = 0;
    for (const r of w.body.assembled_metrics.ratio_table.rows as RatioTableRow[]) {
      if (r.key === "dio") continue;
      type(r.key.replace(/_/g, " "));
      const row = answerRow(`ratio:${r.key}`);
      expect(row, `"${r.key.replace(/_/g, " ")}" answers ratio:${r.key}`).toBeTruthy();
      const printed = row!.querySelector('[data-figure="answer"]')?.textContent
        ?? row!.querySelector("[data-absent]")?.textContent;
      expect(printed, r.key).toBe(formatRatioSide(r, r.display_unit, "ro"));
      ratios++;
    }
    const rows = w.body.assembled_metrics.ratio_table.rows as RatioTableRow[];
    expect(ratios, "every ratio_table row but dio").toBe(rows.filter((r) => r.key !== "dio").length);
    expect(ratios).toBeGreaterThanOrEqual(20);
  }, HEAVY);
});

// cmdbar-ui-language (owner ticket 2026-09-28): the English bar printed
// "413,7 mil. RON" / "36,8 mil. RON" — lib/money chose the locale from the
// currency, and this suite's own `money` helper, following the same rule,
// printed the same wrong string and agreed. Every figure the bar paints is in
// the READER'S language: the turnover answer is the owner's string for that
// language, and no figure at rest or typed — answers, Δ chips, ratios,
// accounts, notes — is a number in the other language's format
// (frontend/test/numberLanguage.ts).
/** English unit and refusal words the Romanian bar must never print. */
const ENGLISH_UNIT_WORDS = /\b(?:not reported|years?|days?|accounts?|loading)\b/i;

describe("cmdbar-ui-language — every figure the bar paints is in the reader's language", () => {
  const books: [string, () => World, Record<Lang, string>][] = [
    ["scandia", () => scandiaWorld(), { en: "48.3M RON", ro: "48,3 mil. RON" }],
    ["agras", () => agrasWorld(), { en: "110.8M RON", ro: "110,8 mil. RON" }],
    ["pair", () => pairWorld(), { en: "", ro: "" }],
  ];
  for (const [name, world, turnover] of books) {
    for (const lang of LANGS) {
      it(`${name} (${lang}): no figure at rest or typed is in the other language's format${turnover[lang] ? `; turnover reads ${turnover[lang]}` : ""}`, async () => {
        await useLang(lang);
        const w = world();
        mount(w);
        const seen: string[] = [];
        const words: string[] = [];
        const collect = (where: string) => {
          for (const el of Array.from(document.querySelectorAll('[data-testid="cmdbar"] [data-figure], [data-testid="cmdbar"] [data-chip-state]'))) {
            const text = el.textContent ?? "";
            if (/\d/.test(text)) seen.push(`${where}: ${text}`);
          }
          // Every WORD too (owner ruling 2026-09-29: the Romanian bar printed
          // "not reported", "years"): the whole bar, every row it paints.
          const bar = document.querySelector('[data-testid="cmdbar-rows"]')?.textContent ?? "";
          const english = lang === "ro" ? ENGLISH_UNIT_WORDS.exec(bar) : null;
          if (english) words.push(`${where}: "${english[0]}"`);
        };
        collect("rest");
        for (const q of [...Object.values(QUERIES), "profit", "4111", "401", "711", "stoc", "dso", "marja neta"]) {
          type(q);
          collect(q);
        }
        const foreign = seen.filter((f) => foreignNumber(f.slice(f.indexOf(": ") + 2), lang) !== null);
        expect(foreign, `${name}/${lang}: figures in the other language's format`).toEqual([]);
        expect(words, `${name}/${lang}: English words in the Romanian bar`).toEqual([]);
        const moneyFigures = seen.filter((f) => /RON/.test(f));
        expect(moneyFigures.length, "VACUITY: money figures painted").toBeGreaterThanOrEqual(10);
        if (turnover[lang]) {
          type(QUERIES.turnover);
          expect(plainSpaces(answerRow("answer:turnover")!.querySelector('[data-figure="answer"]')?.textContent)).toBe(turnover[lang]);
          expect(turnover[lang]).toBe(plainSpaces(money(servedPath(w.body, "turnover") as number, lang)));
        }
        console.log(`GATE-WORK cmdbar-ui-language ${name}/${lang} figures=${seen.length} money=${moneyFigures.length}`);
      }, HEAVY);
    }
  }
});

describe("cmdbar-ui-language — a finding measured in years, and one the engine could not measure, in the reader's words", () => {
  // CONSTRUCTED from Agras's engine-composed document: its asset_age item
  // carries the measure the engine's asset_age detector also emits
  // (src/engine/insights/detectors.py: remaining_life, unit "years"), and its
  // liquidity_quality item a measure the engine could not compute (value
  // null). Neither shape occurs in the committed corpus documents, so the
  // rendered law needs them built — the pure printer's law is in
  // ui-language-figures.
  const constructed = () => {
    const doc = structuredClone(ATT.agras);
    const age = doc.items.find((i: { key: string }) => i.key === "asset_age");
    age.figure.measure = { key: "remaining_life", label: "Remaining useful life", unit: "years", value: 12.5 };
    const liq = doc.items.find((i: { key: string }) => i.key === "liquidity_quality");
    liq.figure.measure = { ...liq.figure.measure, value: null };
    return doc;
  };
  const want = { en: { age: "12.5 years", liq: "not reported" }, ro: { age: "12,5 ani", liq: "neraportat" } } as const;
  for (const lang of LANGS) {
    it(`${lang}: ${want[lang].age} and ${want[lang].liq}; no word of the other language in the bar`, async () => {
      await useLang(lang);
      mount(agrasWorld({ attention: constructed() }));
      const fig = (key: string) => plainSpaces(
        rowsOf("now").find((el) => el.getAttribute("data-row-id") === `now:${key}`)?.querySelector('[data-figure="now"]')?.textContent);
      expect(fig("asset_age")).toBe(want[lang].age);
      expect(fig("liquidity_quality")).toBe(want[lang].liq);
      const bar = screen.getByTestId("cmdbar-rows").textContent ?? "";
      if (lang === "ro") expect(ENGLISH_UNIT_WORDS.exec(bar), "English words in the Romanian bar").toBeNull();
      else expect(/\b(?:neraportat|ani)\b/.exec(bar), "Romanian words in the English bar").toBeNull();
    });
  }
});

// release r-rulings2 (2026-10-01): the stock-build regime line (owner ruling
// R1) was written before the reader's-language ruling and no book of the law
// above carries a regime, so the line's two money figures were never examined
// by it. CONSTRUCTED: Agras's engine-composed document carrying the corpus
// developer's served regime block (the committed capture
// frontend/lib/__tests__/fixtures/served_credit_regime.json) — the regime of
// one book on the document of another, which no engine serves; the law is
// the PRINTING of the line, not the regime's figures.
describe("cmdbar-ui-language — the credit regime line prints its figures in the bar's language", () => {
  const REGIME = read("frontend/lib/__tests__/fixtures/served_credit_regime.json").attention_developer;
  for (const lang of LANGS) {
    it(`${lang}: the regime line's net 711 and net turnover are in the reader's format, each with its code after the figure`, async () => {
      await useLang(lang);
      mount(agrasWorld({ attention: { ...structuredClone(ATT.agras), credit_regime: REGIME.credit_regime } }));
      const line = plainSpaces(screen.getByTestId("cmdbar-credit-regime").textContent);
      expect(foreignNumber(line, lang), `${lang}: a figure in the other language's format in "${line}"`).toBeNull();
      // the code AFTER the figure, never before it (and never "lei")
      const money = line.match(/-?\d[\d.,]*(?: (?:mii|mil\.|mld\.)|[KMBT])? RON/g) ?? [];
      expect(money.length, "VACUITY: the line's two served money figures").toBe(2);
      expect(line).not.toMatch(/RON -?\d/);
      expect(line).not.toMatch(/\blei\b/);
      console.log(`GATE-WORK cmdbar-ui-language regime/${lang} figures=${money.length}`);
    });
  }
});

describe("cmdbar-figures — every Δ IS its comparatives column, every vs-sector IS its sector row", () => {
  for (const lang of LANGS) {
    it(`pair (${lang}): each statement answer's Δ is the served column through the shared printers`, async () => {
      await useLang(lang);
      mount(pairWorld());
      const tt = i18n.getFixedT(lang);
      let words = 0;
      let pcts = 0;
      for (const [id, q] of Object.entries(QUERIES)) {
        type(q);
        const row = answerRow(`answer:${id}`);
        expect(row, id).toBeTruthy();
        const col = PAIR.comparatives.columns.find((c: { key: string }) => c.key === LINE_OF[id]);
        expect(col, `${LINE_OF[id]} is served`).toBeTruthy();
        const kind = col.change_kind as ChangeKind;
        const change = isWordKind(kind)
          ? tt(changeKindWordKey(kind))
          : localiseDecimal(formatDeltaPct(col.delta_pct) as string, lang);
        if (isWordKind(kind)) words++; else pcts++;
        const first = chipTexts(row!)[0];
        expect(first, `${id}: the Δ chip`).toEqual({
          state: "ok",
          text: tt("cmdbar.figure.vsPrior", { change, prior: PAIR.comparatives.prior.label }),
        });
      }
      // Both printers exercised: a percentage AND a word (bs.total_debt
      // moves from zero on this pair).
      expect(pcts).toBeGreaterThanOrEqual(8);
      expect(words).toBeGreaterThanOrEqual(1);
    }, HEAVY);

    it(`scandia (${lang}): each vs-sector position is the served sector row — the split's cards carry none`, async () => {
      await useLang(lang);
      const w = scandiaWorld();
      mount(w);
      const tt = i18n.getFixedT(lang);
      const doc = SECTOR.scandia;
      let lawful = 0;
      let refused = 0;
      let splitCards = 0;
      const check = (row: HTMLElement, key: string) => {
        const sr = doc.rows.find((r: { key: string }) => r.key === key);
        // "vs sector — …" / "față de sector — …": the chip the sector row prints.
        const lead = tt("cmdbar.figure.sector", { what: "\u0000", position: "" }).split("\u0000")[0];
        const sector = chipTexts(row).find((c) => c.text.startsWith(lead));
        const ok = sr && sr.status === "sourced" && sr.position && lawfulFigure(sr.sector, doc.min_peers);
        if (!ok) {
          expect(sector, `${key}: a refused sector row prints no position`).toBeUndefined();
          refused++;
          return;
        }
        expect(sector, `${key}: printed`).toBeTruthy();
        expect(sector!.text).toContain(sectorValueText(sr.company.value, sr.unit, lang));
        expect(sector!.text).toContain(tt(`benchmarkPage.sector.position.${sr.position}`));
        const verdict = sr.vs_sector && sr.vs_sector !== "inside" ? tt(`cmdbar.vsSector.${sr.vs_sector}`) : null;
        if (verdict) expect(sector!.text).toContain(verdict);
        lawful++;
      };
      for (const [id, key] of Object.entries(SECTOR_OF)) {
        type(QUERIES[id]);
        check(answerRow(`answer:${id}`)!, key);
      }
      // THE SPLIT STANDS ALONE (owner spec 2026-09-26 P1.3, merge contract
      // 2026-09-28): the inventory answer and every card built on the split
      // carry NO sector chip — least of all the filed-basis row's, which
      // the served document does carry.
      const lead = tt("cmdbar.figure.sector", { what: "\u0000", position: "" }).split("\u0000")[0];
      expect(doc.rows.some((r: { key: string; status: string }) => r.key === "inventory_days_on_turnover" && r.status === "sourced"),
        "POSITIVE CONTROL: the filed-basis row is served and lawful here").toBe(true);
      type(QUERIES.inventory);
      expect(chipTexts(answerRow("answer:inventory")!).filter((c) => c.text.startsWith(lead)), "inventory").toEqual([]);
      for (const card of ["dio", "inventory_turnover", "ccc"]) {
        type(card === "dio" ? "dio" : card.replace(/_/g, " "));
        const r = answerRow(`ratio:${card}`);
        if (!r) continue;
        expect(chipTexts(r).filter((c) => c.text.startsWith(lead)), card).toEqual([]);
        splitCards++;
      }
      // Ratio answers meet their sector row through the row's card key.
      for (const sr of doc.rows as { key: string; definition?: { card_key?: string | null } }[]) {
        const card = sr.definition?.card_key;
        if (!card || card === "dio" || card === "dso") continue; // shown once, on the statement answer
        type(card.replace(/_/g, " "));
        const row = answerRow(`ratio:${card}`);
        expect(row, `ratio:${card}`).toBeTruthy();
        check(row!, sr.key);
      }
      console.log(`GATE-WORK cmdbar-sector lawful=${lawful} refused=${refused} split_cards=${splitCards}`);
      expect(lawful).toBeGreaterThanOrEqual(8);
      expect(splitCards, "POSITIVE CONTROL: the split's cards were typed and found").toBeGreaterThanOrEqual(1);
      expect(refused, "POSITIVE CONTROL: revenue growth has no company figure here").toBeGreaterThanOrEqual(1);
    }, HEAVY);
  }
});

describe("cmdbar-latency — the cold open, timed", () => {
  it("cold: every statement answer's VALUE renders under 100 ms from the period body; Δ and vs-sector say 'loading', never blank or 0", async () => {
    hangFetch = true;
    fakeDebounceTimers();
    const w = pairWorld({ seed: "cold" });
    mount(w);
    const cpus: number[] = [];
    const walls: number[] = [];
    let pending = 0;
    for (const [id, q] of Object.entries(QUERIES)) {
      const c0 = cpuNow();
      const w0 = wallNow();
      type(q);
      cpus.push(cpuNow() - c0);
      walls.push(wallNow() - w0);
      const row = answerRow(`answer:${id}`);
      expect(row, id).toBeTruthy();
      expect(row!.querySelector('[data-figure="answer"]')?.textContent, id).toBe(money(servedPath(w.body, id) as number, "en"));
      for (const c of chipTexts(row!)) {
        expect(c.text.trim(), `${id}: no blank chip`).not.toBe("");
        expect(c.text.trim(), `${id}: no 0 chip`).not.toMatch(/^[−-]?0([.,]0+)?\s*%?$/);
        if (c.state === "pending") { expect(c.text).toBe("loading"); pending++; }
      }
    }
    // THE BUDGET, on the work (test/cpuClock): each cold answer's render.
    expect(Math.max(...cpus), `cold answer work (${CPU_CLOCK}, ms)`).toBeLessThan(100);
    console.log(`GATE-WORK cmdbar-latency cold answers=${cpus.length} clock=${CPU_CLOCK} cpu_max_ms=${Math.max(...cpus).toFixed(1)} wall_max_ms=${Math.max(...walls).toFixed(1)} (wall not asserted)`);
    // The Δ is pending on every answer (the comparatives never land here).
    expect(pending).toBeGreaterThanOrEqual(Object.keys(QUERIES).length);
    // Counted AFTER the async work AND every timer the typing armed have
    // run: a synchronous count sees no request at all (every fetch awaits
    // its headers), and a debounced one is issued only after its window.
    await pastTheHorizon();
    vi.useRealTimers();
    const docs = fetched.filter((u) => /\/attention|\/comparatives|\/sector-benchmark/.test(u));
    // POSITIVE CONTROL: the cold open DID ask (so the ceiling below counts
    // real requests, not a count taken before any could be made).
    expect(docs.length, "the cold open asked for its documents").toBeGreaterThanOrEqual(2);
    expect(docs.length,
      "cold: the bar's documents are asked for once, by the prefetch, not per keystroke").toBeLessThanOrEqual(3);
  }, HEAVY);
});

describe("cmdbar-scope — every document the bar asks for is asked of ITS company", () => {
  it("attention, comparatives and the sector document carry the period's company as X-Org-Id — never the ambient workspace", async () => {
    // Found live (e2e/workspace-v2.spec.ts G6, stage CB-G): the bar's
    // app-wide prefetch asked for the sector document with the header read
    // at request time, so across a company switch Agras's workspace was
    // asked for a Scandia period. Here the ambient helper names NO
    // workspace (see the authOrgHeaders mock): whatever the bar sends, it
    // must have named itself.
    hangFetch = true;
    const w = pairWorld({ seed: "cold" });
    mount(w);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const docs = fetched
      .map((u, i) => ({ u, org: fetchedOrg[i] }))
      .filter((r) => /\/attention|\/comparatives|\/sector-benchmark/.test(r.u));
    const unnamed = docs.filter((r) => r.org !== w.org.id).map((r) => `${r.u} → ${r.org}`);
    expect(unnamed, "asked of another (or no) workspace").toEqual([]);
    // POSITIVE CONTROL: the cold open did ask for the sector document and
    // the attention document, so the check above had subjects.
    expect(docs.some((r) => /\/sector-benchmark/.test(r.u)), "the sector document was asked for").toBe(true);
    expect(docs.some((r) => /\/attention/.test(r.u)), "the attention document was asked for").toBe(true);
  });
});

describe("cmdbar-search — synonyms and diacritics on the RENDERED bar, both languages", () => {
  const SAME: [string, string[]][] = [
    ["answer:receivables", ["clienti", "clienți", "creante", "creanțe", "CREANȚE"]],
    ["answer:turnover", ["cifra de afaceri", "cifră de afaceri", "Cifră de Afaceri", "revenue", "turnover", "venituri"]],
    ["answer:net_result", ["profit", "profitul net", "net income", "rezultat"]],
    ["answer:inventory", ["stoc", "stocuri", "inventory"]],
    ["answer:payables", ["furnizori", "suppliers"]],
    ["answer:cash", ["numerar", "cash", "disponibilități", "disponibilitati"]],
  ];
  for (const lang of LANGS) {
    it(`${lang}: every spelling of a subject — with or without diacritics, RO or EN — opens the same first answer`, async () => {
      await useLang(lang);
      mount(scandiaWorld());
      let spellings = 0;
      for (const [id, qs] of SAME) {
        for (const q of qs) {
          type(q);
          expect(rowsOf("answer")[0]?.getAttribute("data-row-id"), `"${q}"`).toBe(id);
          spellings++;
        }
      }
      expect(spellings).toBeGreaterThanOrEqual(20);
    }, HEAVY);
  }

  it("with and without accents the WHOLE result list is the same, row for row", () => {
    mount(scandiaWorld());
    const ids = () => within(bar()).getAllByRole("option").map((el) => el.getAttribute("data-row-id"));
    for (const [a, b] of [["creanțe", "creante"], ["cifră de afaceri", "cifra de afaceri"], ["disponibilități", "disponibilitati"], ["bilanț", "bilant"]]) {
      type(a);
      const withAccents = ids();
      type(b);
      expect(withAccents.length, `"${a}" finds something`).toBeGreaterThan(1);
      expect(ids(), `"${a}" vs "${b}"`).toEqual(withAccents);
    }
  });

  it("diacritics no other rule rescues: short words (în, și, vamă) find their account only through folding", () => {
    // The synonym table lists both spellings of its own words, and the
    // one-edit typo rule forgives ONE missing accent in a word of five
    // letters or more — so neither can stand in for folding here: "în",
    // "și" and "vamă" are too short to be fuzzed, and the book writes the
    // names without accents.
    mount(scandiaWorld());
    const probes: [string, string][] = [
      ["casa în lei", "531101"],
      ["chirii și redevențe", "612015"],
      ["furnizori tva în vamă", "401401"],
      ["imob.necorp. în curs", "208002"],
    ];
    for (const [q, code] of probes) {
      type(q);
      const first = rowsOf("account")[0];
      expect(first?.getAttribute("data-row-id") ?? "", `"${q}"`).toMatch(new RegExp(`^account:${code}:`));
    }
  });

  it("'raport' finds the report — a page or the PDF export, never nothing", () => {
    mount(scandiaWorld());
    type("raport");
    const ids = [...rowsOf("page"), ...rowsOf("action")].map((el) => el.getAttribute("data-row-id"));
    expect(ids.some((id) => id === "page:report" || id === "action:export-pdf")).toBe(true);
  });
});

describe("cmdbar-keyboard — the whole flow from the keyboard", () => {
  const opts = () => within(bar()).getAllByRole("option");
  const selected = () => opts().findIndex((el) => el.getAttribute("aria-selected") === "true");

  it("typing selects the answer; ↓ walks every row and stops on 'Ask CFO AI'; ↑ walks back and stops on the answer; the composer names the active row", () => {
    mount(scandiaWorld());
    type("clienti");
    expect(selected()).toBe(0);
    expect(opts()[0].getAttribute("data-row-kind")).toBe("answer");
    expect(input().getAttribute("aria-activedescendant")).toBe(opts()[0].id);
    const n = opts().length;
    expect(n).toBeGreaterThanOrEqual(4);
    const walked: string[] = [];
    for (let i = 0; i < n + 2; i++) {
      key("ArrowDown");
      walked.push(opts()[selected()].getAttribute("data-row-kind") ?? "");
    }
    expect(selected()).toBe(n - 1);
    expect(opts()[n - 1].getAttribute("data-row-kind")).toBe("ask");
    expect(input().getAttribute("aria-activedescendant")).toBe(opts()[n - 1].id);
    // Every family the reader sees was walked through, in order — the Cont
    // group's overflow row right after its accounts.
    const order = ["answer", "account", "account-more", "page", "action", "ask"];
    expect([...new Set(walked)]).toEqual(order.filter((k) => walked.includes(k)));
    expect(walked).toContain("account");
    expect(walked).toContain("account-more");
    for (let i = 0; i < n + 2; i++) key("ArrowUp");
    expect(selected()).toBe(0);
  });

  it("a new query selects ITS answer even when the old selection sat below the new list's end", () => {
    // Found by the live keyboard probe (stage CB-G): "profit", ↓ to
    // "Întreabă CFO AI", then "clienti" — a shorter list — left the
    // selection clamped onto "Întreabă CFO AI", so Enter asked the chat
    // instead of opening the answer the reader had just typed for.
    mount(scandiaWorld());
    type("profit");
    const long = opts().length;
    for (let i = 0; i < long + 2; i++) key("ArrowDown");
    expect(opts()[selected()].getAttribute("data-row-kind")).toBe("ask");
    type("clienti");
    expect(opts().length, "POSITIVE CONTROL: the new list is shorter than the old selection").toBeLessThan(long);
    expect(selected()).toBe(0);
    expect(opts()[0].getAttribute("data-row-id")).toBe("answer:receivables");
    expect(input().getAttribute("aria-activedescendant")).toBe(opts()[0].id);
    key("Enter");
    expect(screen.getByTestId("location").textContent).toMatch(/line=bs\.trade_receivables_net/);
  });

  it("no committed frame of a new query carries the previous walk's selection — every commit, not only the settled one", () => {
    // Live G8 (stage CB-J run) caught the first frame of "stoc", typed after
    // ↓ had walked "profit" to its end, with NO row selected: the reset ran
    // in an effect after the commit that showed the new list. The settled
    // state was right, so every law that looked after the effects was green.
    const frames: { query: string; sel: string | null; first: string | null }[] = [];
    const onCommit = () => {
      const composer = document.querySelector<HTMLTextAreaElement>('[data-testid="capsule-composer"]');
      const rows = [...document.querySelectorAll('[data-testid="cmdbar-rows"] [role="option"]')];
      frames.push({
        query: composer?.value ?? "",
        sel: document.querySelector('[data-testid="cmdbar-rows"] [role="option"][aria-selected="true"]')?.getAttribute("data-row-id") ?? null,
        first: rows[0]?.getAttribute("data-row-id") ?? null,
      });
    };
    mount(scandiaWorld(), onCommit);
    type("profit");
    const bad: string[] = [];
    let judged = 0;
    for (const q of ["stoc", "clienti", "raport", "4111", "cifra de afaceri", "profit"]) {
      const n = opts().length;
      for (let i = 0; i < n + 2; i++) key("ArrowDown");
      // POSITIVE CONTROL: the walk ended below the new query's first row.
      expect(selected(), `the walk before "${q}" ended on the last row`).toBe(n - 1);
      const at = frames.length;
      type(q);
      const mine = frames.slice(at).filter((f) => f.query === q && f.first !== null);
      expect(mine.length, `VACUITY: frames committed for "${q}"`).toBeGreaterThan(0);
      for (const f of mine) {
        judged++;
        if (f.sel !== f.first) bad.push(`"${q}": a frame selected ${f.sel}, its first row is ${f.first}`);
      }
    }
    expect(bad, "a committed frame of a new query that does not select its first row").toEqual([]);
    console.log(`GATE-WORK cmdbar-selection-frames queries=6 frames=${judged}`);
  });

  it("Enter on the answer opens its evidence (the account view for its line)", () => {
    mount(scandiaWorld());
    type("clienti");
    key("Enter");
    expect(screen.getByTestId("location").textContent).toMatch(/tab=balance_sheet.*line=bs\.trade_receivables_net/);
  });

  it("⌘Enter / Ctrl+Enter sends the query to the chat whatever row is selected; the bar calls no model", () => {
    const seen: unknown[] = [];
    const onAsk = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_ASK_CFO_AI_EVENT, onAsk);
    try {
      mount(scandiaWorld());
      type("de ce au crescut creantele");
      key("ArrowDown");
      key("Enter", { metaKey: true });
      expect(seen).toEqual([{ prompt: "de ce au crescut creantele", send: true }]);
      cleanup();
      mount(scandiaWorld());
      type("marja neta");
      key("Enter", { ctrlKey: true });
      expect(seen[1]).toEqual({ prompt: "marja neta", send: true });
      expect(spend()).toEqual([]);
    } finally {
      window.removeEventListener(OPEN_ASK_CFO_AI_EVENT, onAsk);
    }
  });

  it("at rest nothing is selected; ↓ selects the first 'Ce contează acum' item and Enter opens its evidence", () => {
    mount(scandiaWorld());
    expect(selected()).toBe(-1);
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    key("ArrowDown");
    expect(selected()).toBe(0);
    expect(opts()[0].getAttribute("data-row-id")).toBe(`now:${ATT.scandia.items[0].key}`);
    key("Enter");
    const loc = screen.getByTestId("location").textContent ?? "";
    expect(loc).not.toBe(`/dashboard?period=${scandiaWorld().periodId}`);
    expect(loc).toContain(`period=${scandiaWorld().periodId}`);
  });
});

// ════════════════════════════════════════════════════════════════════════
// RELEASE r-rulings, FIXER ROUND 1 (2026-09-28) — a refused line is not an
// absent one, and an account-711 row never prints without what it IS.
//
//   · TOTAL EQUITY the engine refuses as total equity (`assembled_bs.
//     total_equity_refusal`: no account 121, a refused net 711, a sheet that
//     does not balance without the year's result) printed as "Total equity
//     200 K RON" — the short figure the dashboard card refuses;
//   · the OPERATING RESULT refused with the one EBITDA printed "not in this
//     book" beside an EBITDA row carrying the engine's reason — every stored
//     period until it is reprocessed (§25);
//   · a 711 leaf (on a closed book: the production stocked, its credit
//     turnover) printed as a bare P&L amount under the Stocuri answer, with
//     none of the note the Capsule adds (design A1 / A6).
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11): the equity answer printing any
// figure, or the bar's own "not in this book", where the engine serves the
// equity refusal; the operating result printing a figure or "not in this
// book" where the one-EBITDA refusal names it; a Δ against a prior the
// engine refused on that line; a 711 row (rendered or modelled, RO or EN)
// without the note, or a note that is not the served variation / its
// provenance / the closed-book wording; a note on any other account.
// Plants: docs/engine_book/gates.md, "Release r-rulings — fixer round 1".
// ════════════════════════════════════════════════════════════════════════

/** The engine's constructed book `name` (oneEbitda/constructed_books.json)
 *  served as the period's body: its statements and line items under
 *  the first hermetic capture's period / company shell (the host context
 *  the bar needs), with
 *  no other book's ratio table beside it. */
function constructedBody(name: string): Record<string, any> {
  const book = ONE_EBITDA_BOOKS[name];
  const body = structuredClone(SCANDIA.period);
  body.statements = structuredClone(book.statements);
  body.line_items = structuredClone(book.line_items);
  body.assembled_metrics = null;
  return body;
}

/** A served sector document with no rows: the constructed books have no
 *  sector, and the capture's rows must not be printed beside them. */
const NO_SECTOR_ROWS = { ...SECTOR.scandia, rows: [] };

describe("absent is never 0 — a REFUSED line prints the engine's words (fixer round 1)", () => {
  const NOT_IN_BOOK = { en: "not in this book", ro: "nu apare în balanță" } as const;

  it("total equity the engine refuses AS total equity prints the engine's words — never the short figure, never 'not in this book'", async () => {
    const book = ONE_EBITDA_BOOKS.unanchored_unbalanced;
    const served = book.statements.assembled_bs.total_equity_refusal;
    // POSITIVE CONTROL: the short figure IS served beside the refusal — what
    // a reader of the bare line prints.
    expect(book.statements.assembled_bs.total_equity).toBe(200000);
    expect(served.code).toBe("account_121_anchor_absent");
    for (const lang of LANGS) {
      await useLang(lang);
      mount(scandiaWorld({ body: constructedBody("unanchored_unbalanced"), sector: NO_SECTOR_ROWS }));
      type(lang === "ro" ? "capitaluri proprii" : "total equity");
      const row = answerRow("answer:equity");
      expect(row, `${lang}: the equity answer`).toBeTruthy();
      expect(row!.querySelector('[data-figure="answer"]'), `${lang}: no figure`).toBeNull();
      expect(row!.querySelector("[data-absent]")?.textContent).toBe(lang === "ro" ? served.text_ro : served.text_en);
      expect(row!.textContent).not.toContain(money(200000, lang));
      expect(row!.textContent).not.toContain(served.code);
      expect(row!.textContent).not.toContain(NOT_IN_BOOK[lang]);
      expect(row!.textContent).not.toMatch(/(^|\s)0(\s|$)/);
      cleanup();
    }
    // The same book's OTHER balance-sheet lines are not refused: the
    // refusal is equity's, not the sheet's.
    await useLang("en");
    mount(scandiaWorld({ body: constructedBody("unanchored_unbalanced"), sector: NO_SECTOR_ROWS }));
    type("total assets");
    expect(answerRow("answer:total_assets")?.querySelector('[data-figure="answer"]')?.textContent)
      .toBe(money(book.statements.assembled_bs.total_assets, "en"));
  });

  // CRITIC ROUND 2 (2026-09-28): the prior's refusal printed BARE beside the
  // current figure — "Total equity <figure> · total equity excludes the
  // year's result, which is refused …" of a book that HAS account 121; the
  // refusal was Dec 2024's. The engine's own column names the side
  // ("<prior>: <text>", comparatives/columns.py); the bar dropped it. Held
  // on ALL FOUR guarded answers, in both languages: the chip names the prior
  // period, and the bare reason never stands beside a served current figure.
  it("a prior the engine refused on a line carries no Δ — its refusal NAMED AS THE PRIOR'S on every guarded answer (EBITDA, operating result, net result, total equity), never the bare reason", async () => {
    const book = ONE_EBITDA_BOOKS.unanchored_unbalanced.statements;
    const cmp = structuredClone(PAIR.comparatives);
    // The prior becomes the engine's constructed book with no account 121:
    // EBITDA and EBIT refused, the net result unanchored, total equity
    // refused — each in the exact shape the engine serves it.
    cmp.prior_statements.assembled_pl = structuredClone(book.assembled_pl);
    cmp.prior_statements.assembled_bs = structuredClone(book.assembled_bs);
    const priorLabel = cmp.prior.label;
    expect(priorLabel, "POSITIVE CONTROL: the prior carries a label to name").toMatch(/\S/);
    const words = (r: { text_en: string; text_ro: string }, lang: Lang) => (lang === "ro" ? r.text_ro : r.text_en);
    // The reason each answer's prior carries, from the SERVED JSON and the
    // strings — not from the bar's readers.
    const reasonOf: Record<string, (lang: Lang) => string> = {
      ebitda: (lang) => words(book.assembled_pl.ebitda_refusal, lang),
      operating_result: (lang) => words(book.assembled_pl.ebitda_refusal, lang),
      net_result: (lang) => i18n.getFixedT(lang)("cmdbar.absent.net_result_not_account_121", { status: book.assembled_pl.net_income_anchor_status }),
      equity: (lang) => words(book.assembled_bs.total_equity_refusal, lang),
    };
    expect(book.assembled_pl.ebitda_refusal.fields, "POSITIVE CONTROL: EBIT refuses with EBITDA").toContain("ebit");
    expect(book.assembled_pl.net_income_anchor_status).not.toBe("anchored");
    let judged = 0;
    for (const lang of LANGS) {
      await useLang(lang);
      const tt = i18n.getFixedT(lang);
      for (const id of Object.keys(reasonOf)) {
        // POSITIVE CONTROL: the column itself still compares — the
        // comparatives document is the capture's, so only the bar's guard
        // keeps the change off the row.
        expect(cmp.columns.find((c: { key: string }) => c.key === LINE_OF[id]).status, id).toBe("compared");
        mount(pairWorld({ comparatives: cmp }));
        type(tt(`cmdbar.answer.${id}`));
        const row = answerRow(`answer:${id}`);
        expect(row, `${lang}/${id}: the answer`).toBeTruthy();
        // The CURRENT figure is served (the pair's current book is anchored).
        expect(row!.querySelector('[data-figure="answer"]')?.textContent, `${lang}/${id}: the current figure`).toMatch(/\d/);
        const bare = reasonOf[id](lang);
        const chips = chipTexts(row!);
        expect(chips[0], `${lang}/${id}`).toEqual({ state: "none", text: tt("cmdbar.figure.priorRefused", { prior: priorLabel, reason: bare }) });
        expect(chips[0].text.startsWith(`${priorLabel}: `), `${lang}/${id}: the chip names the prior`).toBe(true);
        expect(chips.some((c) => c.text === bare), `${lang}/${id}: the bare reason beside a served current figure`).toBe(false);
        expect(chips.some((c) => new RegExp(` ${lang === "ro" ? "față de" : "vs"} ${priorLabel}`).test(c.text)), `${lang}/${id}: a Δ against the refused prior`).toBe(false);
        judged++;
        cleanup();
      }
    }
    console.log(`GATE-WORK cmdbar-prior-refused answers=${judged}`);
  });

  for (const name of ["g6_uncleared", "unanchored_unbalanced"] as const) {
    it(`${name}: a refused operating result prints the one-EBITDA refusal in the engine's words — never 'not in this book', never a figure`, async () => {
      const apl = ONE_EBITDA_BOOKS[name].statements.assembled_pl;
      const served = apl.ebitda_refusal;
      // POSITIVE CONTROL: the refusal names the operating result.
      expect(served.fields).toContain("ebit");
      expect(apl.ebit).toBeNull();
      for (const lang of LANGS) {
        await useLang(lang);
        mount(scandiaWorld({ body: constructedBody(name), sector: NO_SECTOR_ROWS }));
        type(lang === "ro" ? "rezultat din exploatare" : "operating result");
        const row = answerRow("answer:operating_result");
        expect(row, `${lang}: the operating-result answer`).toBeTruthy();
        expect(row!.querySelector('[data-figure="answer"]')).toBeNull();
        const words = lang === "ro" ? served.text_ro : served.text_en;
        expect(row!.querySelector("[data-absent]")?.textContent).toBe(words);
        expect(row!.textContent).not.toContain(NOT_IN_BOOK[lang]);
        expect(row!.textContent).not.toContain(served.code);
        // The EBITDA row beside it says the SAME thing — one reason.
        type("ebitda");
        expect(answerRow("answer:ebitda")!.querySelector("[data-absent]")?.textContent).toBe(words);
        cleanup();
      }
    });
  }

  it("an operating result the engine SERVES still prints its figure (the reader refuses only what the engine refused)", () => {
    mount(scandiaWorld());
    type("operating result");
    const ebit = SCANDIA.period.statements.assembled_pl.ebit;
    expect(typeof ebit).toBe("number");
    expect(answerRow("answer:operating_result")!.querySelector('[data-figure="answer"]')?.textContent).toBe(money(ebit, "en"));
  });
});

describe("cmdbar-711 — an account-711 row never prints without what it IS (fixer round 1)", () => {
  /** The note as the engine's served block words it — assembled here from
   *  the served JSON and the strings, NOT from the bar's function. */
  function expectedNote(body: Record<string, any>, lang: Lang, fmt: (v: number) => string): string {
    const iv = body.statements.assembled_pl.inventory_variation;
    const tt = i18n.getFixedT(lang);
    const head = tt(iv.book_state === "closed" ? "cmdbar.account.stockVariation.closed" : "cmdbar.account.stockVariation.open");
    const name = iv.line_name_ro;
    const tail = iv.value !== null
      ? tt("cmdbar.account.stockVariation.served", { name, value: fmt(iv.value), provenance: lang === "ro" ? iv.label_ro : iv.label_en })
      : tt("cmdbar.account.stockVariation.refused", { name, reason: lang === "ro" ? iv.refusal.text_ro : iv.refusal.text_en });
    return `${head} ${tail}`;
  }

  const books: [string, () => World][] = [["scandia", () => scandiaWorld()], ["agras", () => agrasWorld()]];
  for (const [name, world] of books) {
    for (const lang of LANGS) {
      it(`${name} (${lang}): every 711 row the bar lists for '711' and 'stoc' carries the served note; no other row carries one`, async () => {
        await useLang(lang);
        const w = world();
        const iv = w.body.statements.assembled_pl.inventory_variation;
        // POSITIVE CONTROL: a closed book whose 711 leaves are the gross
        // (their sum is the served audit-named credit turnover) and whose
        // served variation is a different, measured figure.
        expect(iv.book_state).toBe("closed");
        expect(iv.provenance).toBe("account_121_bridge");
        const leaves711 = (w.body.line_items as PeriodLineItemLite[]).filter((li) => li.ro_account_code.startsWith("711"));
        expect(leaves711.length).toBeGreaterThan(0);
        expect(Math.abs(leaves711.reduce((s, li) => s + li.amount, 0) - iv.stock_production_credit_turnover)).toBeLessThan(0.01);
        expect(iv.value).not.toBe(iv.stock_production_credit_turnover);
        mount(w);
        const want = expectedNote(w.body, lang, (v) => money(v, lang));
        expect(want).toContain(money(iv.value, lang));
        expect(want).toContain(lang === "ro" ? iv.label_ro : iv.label_en);
        let with711 = 0;
        for (const q of ["711", "stoc", ...leaves711.map((li) => li.ro_account_code)]) {
          type(q);
          for (const row of rowsOf("account")) {
            const code = (row.getAttribute("data-row-id") ?? "").split(":")[1] ?? "";
            const note = row.querySelector("[data-stock-note]");
            if (code.startsWith("711")) {
              expect(note?.textContent, `"${q}" → ${code}`).toBe(want);
              with711++;
            } else {
              expect(note, `"${q}" → ${code}: a note on a non-711 account`).toBeNull();
            }
          }
        }
        expect(with711, "VACUITY: 711 rows seen").toBeGreaterThanOrEqual(leaves711.length);
        console.log(`GATE-WORK cmdbar-711-note ${name}/${lang} rows=${with711} leaves=${leaves711.length}`);
      }, HEAVY);
    }
  }

  it("modelled over EVERY line item of both books: a note on each 711 leaf and on nothing else", () => {
    let notes = 0;
    let others = 0;
    for (const [, world] of books) {
      const w = world();
      const ctx: ViewContext = {
        printer: { lang: "en", money: (v: number) => money(v, "en") },
        body: w.body as never,
        comparatives: { state: "none", reason: "no_prior" },
        sector: { state: "none", reason: "off" },
        periodId: w.periodId,
        orgId: w.org.id,
      };
      const want = expectedNote(w.body, "en", (v) => money(v, "en"));
      for (const li of w.body.line_items as PeriodLineItemLite[]) {
        if (li.statement === "IGNORED") continue;
        const v = accountView(ctx, li as never);
        if (li.ro_account_code.startsWith("711")) { expect(v.note, li.ro_account_code).toBe(want); notes++; }
        else { expect(v.note, li.ro_account_code).toBeNull(); others++; }
      }
    }
    expect(notes, "VACUITY: 711 leaves").toBeGreaterThanOrEqual(11);
    expect(others, "VACUITY: other leaves").toBeGreaterThanOrEqual(500);
  });

  it("a 711 row on a book whose variation the engine REFUSED says so in the engine's words — never a variation figure", async () => {
    const body = constructedBody("unanchored");
    const iv = body.statements.assembled_pl.inventory_variation;
    expect(iv.value).toBeNull();
    for (const lang of LANGS) {
      await useLang(lang);
      mount(scandiaWorld({ body, sector: NO_SECTOR_ROWS }));
      type("711");
      const row = rowsOf("account").find((el) => (el.getAttribute("data-row-id") ?? "").startsWith("account:711:"));
      expect(row, lang).toBeTruthy();
      const note = row!.querySelector("[data-stock-note]")?.textContent ?? "";
      expect(note).toBe(expectedNote(body, lang, (v) => money(v, lang)));
      expect(note).toContain(lang === "ro" ? iv.refusal.text_ro : iv.refusal.text_en);
      cleanup();
    }
  });
});

type PeriodLineItemLite = { ro_account_code: string; bucket: string; amount: number; statement: string };
