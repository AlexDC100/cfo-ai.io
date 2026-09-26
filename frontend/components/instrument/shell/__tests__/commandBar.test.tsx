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
//                      "Întreabă" in < 100 ms with ZERO fetches; cold open:
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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import i18n from "@/i18n";
import { formatAmountFrom } from "@/lib/money";
import { formatRatioSide, localiseDecimal, ratioLabelForKey, type RatioTableRow } from "@/lib/ratioTable";
import { formatDeltaPct } from "@/lib/comparatives";
import { changeKindWordKey, isWordKind, type ChangeKind } from "@/lib/changeKind";
import { lawfulFigure, sectorValueText } from "@/lib/sectorBenchmark";

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

const RATES = { RON: 1, EUR: 5, USD: 4.6 };
const money = (v: number) => formatAmountFrom(v, "RON", "RON", RATES as never, { compact: true });

// ── host context (provided) ─────────────────────────────────────────────

const H = vi.hoisted(() => ({
  org: null as null | { id: string; name: string; industry_key: string | null },
  orgs: [] as { id: string; name: string; industry_key: string | null }[],
  periods: [] as { period_id: string; period_end: string | null }[],
  select: (_id: string) => Promise.resolve(),
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
vi.mock("@/lib/previewFeatures", () => ({ useUploadRoute: (legacy: string) => legacy }));
vi.mock("@/lib/features", async (orig) => ({
  ...(await orig<typeof import("@/lib/features")>()),
  useFeatureStatus: (k: string) => (k === "forecast" ? "coming_soon" : "active"),
}));
vi.mock("@/components/cfo/Sidebar", () => ({
  useShellNav: () => [{ key: "core", label: "Core", items: [{ to: "/dashboard", labelKey: "sidebar.dashboard" }] }],
  SIDEBAR_TOGGLE_EVENT: "cfo-ai-sidebar-toggle",
}));
vi.mock("@/stores/currency", async (orig) => {
  const { formatAmountFrom: f } = await import("@/lib/money");
  return {
    ...(await orig<typeof import("@/stores/currency")>()),
    useAmountFormatter: () => (v: number | null | undefined, opts: Record<string, unknown> = {}) =>
      f(v, "RON", "RON", { RON: 1, EUR: 5, USD: 4.6 } as never, opts),
  };
});

import { CommandPalette } from "../CommandPalette";
import { LAT_CMDBAR_SEARCH, resetLatency, snapshotLatency } from "@/lib/capsuleLatency";
import { RECENTS_KEY_PREFIX } from "../cmdbar/cmdbarRecents";
import { OPEN_ASK_CFO_AI_EVENT } from "@/components/cfo/chat/openAskCfoAi";

// ── the fetch trap ──────────────────────────────────────────────────────

const MODEL_SEAMS = [/\/api\/capsule\/tools\//, /functions\/v1\/chat-llm/, /anthropic/i];
let fetched: string[] = [];
let savedFetch: unknown;
let hangFetch = false;

beforeEach(() => {
  fetched = [];
  hangFetch = false;
  const g = globalThis as unknown as Record<string, unknown>;
  savedFetch = g.fetch;
  g.fetch = async (input: unknown) => {
    fetched.push(typeof input === "string" ? input : String((input as { url?: string })?.url ?? input));
    if (hangFetch) return new Promise(() => {});
    return new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
  };
  try { window.localStorage.clear(); } catch { /* shim */ }
  resetLatency();
});

afterEach(async () => {
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
    periodId: body.period.id, attention: ATT.pair, sector: SECTOR_PAIR,
    comparatives: PAIR.comparatives, priorId: PAIR.comparatives.prior.period_id, ...over,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function mount(w: World) {
  H.org = w.org;
  H.orgs = [w.org, { id: "org-other", name: "Other Company SRL", industry_key: null }];
  const priorPeriod = w.priorId ? [{ period_id: w.priorId, period_end: "2024-12-31", period_start: null, period_label: "Dec 2024", documents: [{ id: "d0" }] }] : [];
  H.periods = [{ period_id: w.periodId, period_end: w.body.period.period_end }];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(["period", w.periodId], { kind: "ok", data: w.body });
  if (w.seed !== "cold") {
    qc.setQueryData(["periods-with-documents", "company", w.org.id], {
      orgId: w.org.id,
      periods: [{ period_id: w.periodId, period_end: w.body.period.period_end, period_start: null, period_label: "", documents: [{ id: "d1" }] }, ...priorPeriod],
    });
    if (w.comparatives && w.priorId) qc.setQueryData(["comparatives", w.org.id, w.periodId, w.priorId], { kind: "ok", data: w.comparatives });
    if (w.sector) qc.setQueryData(["sector-benchmark", w.periodId], w.sector);
    if (w.attention) qc.setQueryData(["attention", w.org.id, w.periodId, "auto"], { kind: "ok", data: w.attention });
    qc.setQueryData(["company-years", w.org.id], [{ period_id: w.periodId, year: 2025, period_end: "2025-12-31", revenue: null, revenue_change_pct: null }]);
    qc.setQueryData(["company-years", "org-other"], [{ period_id: "p-other", year: 2024, period_end: "2024-12-31", revenue: null, revenue_change_pct: null }]);
  }
  const onOpenChange = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/dashboard?period=${w.periodId}`]}>
        <CommandPalette open onOpenChange={onOpenChange} onOpenAi={() => {}} />
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
    // No prior year → "Add the previous year"; the bank export needs the
    // forecast feature, which is not active here, so it is not offered.
    expect(labels).toContain(ATT.scandia.actions[0].label.en);
    expect(labels.some((l) => /bank report/i.test(l ?? ""))).toBe(false);
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

  it("the filed-basis inventory row is a POSITION with its basis label, never a verdict", () => {
    mount(scandiaWorld());
    const row = rowsOf("now").find((el) => el.getAttribute("data-row-id") === "now:inventory_days_on_turnover")!;
    expect(row.textContent).toContain("filed basis (stock ÷ net turnover)");
    expect(row.textContent).not.toMatch(/worse than the sector|slow/i);
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
    expect(answer.querySelector('[data-figure="answer"]')?.textContent).toBe(money(pl.net_income_statutory));
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
      expect(row!.querySelector('[data-figure="answer"]')?.textContent, id).toBe(money(served as number));
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
      if (!row) continue;
      const printed = row.querySelector('[data-figure="answer"]')?.textContent
        ?? row.querySelector("[data-absent]")?.textContent;
      expect(printed, r.key).toBe(formatRatioSide(r, r.display_unit, "en"));
      checked++;
      const m = metrics.get(r.key);
      if (typeof m === "number" && typeof r.value === "number" && Math.abs(m - r.value) > 1e-9) differsFromMetrics++;
    }
    expect(checked).toBeGreaterThanOrEqual(20);
    // POSITIVE CONTROL: on this book metrics[] disagrees with the table for
    // some row, so a bar reading metrics[] would print a different figure.
    expect(differsFromMetrics).toBeGreaterThan(0);
  });

  it("inventory days come through the ONE adapter, with their basis, never called slow", () => {
    const w = scandiaWorld();
    mount(w);
    type("zile stoc");
    const row = rowsOf("answer").find((el) => el.getAttribute("data-row-id") === "answer:inventory")!;
    const dio = w.body.assembled_metrics.ratio_table.rows.find((r: { key: string }) => r.key === "dio");
    expect(row.textContent).toContain(formatRatioSide(dio, dio.display_unit, "en"));
    expect(row.querySelector("[data-basis]")?.textContent).toMatch(/closing stock ÷ total operating cost/);
    expect(row.textContent).not.toMatch(/\bslow\b|lent/i);
  });

  it("Cont: a leaf account prints its served amount, its key metric, and opens the account", () => {
    const w = scandiaWorld();
    mount(w);
    type("411101");
    const row = rowsOf("account")[0];
    const item = w.body.line_items.find((li: { ro_account_code: string }) => li.ro_account_code === "411101");
    expect(row.querySelector('[data-figure="account"]')?.textContent).toBe(money(item.amount));
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

  it("a refused EBITDA (the 711 lane's typed refusal) prints the refusal", () => {
    const body = structuredClone(SCANDIA.period);
    delete body.statements.assembled_pl.ebitda;
    body.statements.assembled_pl.ebitda_refusal = { code: "reprocess_required", inputs: [] };
    mount(scandiaWorld({ body }));
    type("ebitda");
    const row = rowsOf("answer").find((el) => el.getAttribute("data-row-id") === "answer:ebitda")!;
    expect(row.querySelector('[data-figure="answer"]')).toBeNull();
    expect(row.textContent).toMatch(/re-read before EBITDA/);
    expect(row.textContent).not.toMatch(/(^|\s)0(\s|$)/);
  });

  it("no prior: the Δ says there is none — not blank, not 0", () => {
    mount(scandiaWorld());
    type("cifra de afaceri");
    const row = rowsOf("answer")[0];
    expect(row.querySelector('[data-chip-state="none"]')?.textContent).toBe("no comparable prior period");
  });
});

describe("cmdbar-latency — warm cache, cold open", () => {
  it("warm: every keystroke renders under 100 ms and fetches NOTHING", () => {
    mount(pairWorld());
    const before = fetched.length;
    const walls: number[] = [];
    for (const q of ["profit", "clienti", "4111", "bilant", "cifra de afaceri", "furnizrii", "marja neta", "exporta"]) {
      for (let i = 1; i <= q.length; i++) {
        const t0 = performance.now();
        type(q.slice(0, i));
        walls.push(performance.now() - t0);
      }
    }
    expect(fetched.length - before).toBe(0);
    const sorted = [...walls].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    expect(p95).toBeLessThan(100);
    const search = snapshotLatency()[LAT_CMDBAR_SEARCH] ?? [];
    expect(search.length).toBeGreaterThan(40);
    expect(Math.max(...search)).toBeLessThan(100);
  });

  it("cold: the value first; Δ and vs-sector say 'loading' — never blank, never 0", () => {
    hangFetch = true;
    mount(pairWorld({ seed: "cold" }));
    type("profit");
    const row = rowsOf("answer")[0];
    expect(row.querySelector('[data-figure="answer"]')?.textContent).toBe(
      money(PAIR.current_body.statements.assembled_pl.net_income_statutory));
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
  turnover: "revenue_growth", net_result: "net_margin", inventory: "inventory_days_on_turnover",
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
          expect(row!.querySelector('[data-figure="account"]')?.textContent, li.ro_account_code).toBe(money(li.amount));
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
      });
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
      expect(row!.querySelector('[data-figure="answer"]')?.textContent, id).toBe(money(servedPath(w.body, id) as number));
    }
    let ratios = 0;
    for (const r of w.body.assembled_metrics.ratio_table.rows as RatioTableRow[]) {
      if (r.key === "dio") continue;
      type(r.key.replace(/_/g, " "));
      const row = answerRow(`ratio:${r.key}`);
      if (!row) continue;
      const printed = row.querySelector('[data-figure="answer"]')?.textContent
        ?? row.querySelector("[data-absent]")?.textContent;
      expect(printed, r.key).toBe(formatRatioSide(r, r.display_unit, "ro"));
      ratios++;
    }
    expect(ratios).toBeGreaterThanOrEqual(20);
  });
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
    });

    it(`scandia (${lang}): each vs-sector position is the served sector row — the filed-basis stock row a position only`, async () => {
      await useLang(lang);
      const w = scandiaWorld();
      mount(w);
      const tt = i18n.getFixedT(lang);
      const doc = SECTOR.scandia;
      let lawful = 0;
      let refused = 0;
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
        if (key === "inventory_days_on_turnover") {
          // The owner's rule: the filed basis, labelled, never a verdict.
          expect(sector!.text).toContain(tt("cmdbar.sectorBasis.inventory_days_on_turnover"));
          if (verdict) expect(sector!.text).not.toContain(verdict);
        } else if (verdict) {
          expect(sector!.text).toContain(verdict);
        }
        lawful++;
      };
      for (const [id, key] of Object.entries(SECTOR_OF)) {
        type(QUERIES[id]);
        check(answerRow(`answer:${id}`)!, key);
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
      expect(lawful).toBeGreaterThanOrEqual(8);
      expect(refused, "POSITIVE CONTROL: revenue growth has no company figure here").toBeGreaterThanOrEqual(1);
    });
  }
});

describe("cmdbar-latency — the cold open, timed", () => {
  it("cold: every statement answer's VALUE renders under 100 ms from the period body; Δ and vs-sector say 'loading', never blank or 0", async () => {
    hangFetch = true;
    const w = pairWorld({ seed: "cold" });
    mount(w);
    const walls: number[] = [];
    let pending = 0;
    for (const [id, q] of Object.entries(QUERIES)) {
      const t0 = performance.now();
      type(q);
      walls.push(performance.now() - t0);
      const row = answerRow(`answer:${id}`);
      expect(row, id).toBeTruthy();
      expect(row!.querySelector('[data-figure="answer"]')?.textContent, id).toBe(money(servedPath(w.body, id) as number));
      for (const c of chipTexts(row!)) {
        expect(c.text.trim(), `${id}: no blank chip`).not.toBe("");
        expect(c.text.trim(), `${id}: no 0 chip`).not.toMatch(/^[−-]?0([.,]0+)?\s*%?$/);
        if (c.state === "pending") { expect(c.text).toBe("loading"); pending++; }
      }
    }
    expect(Math.max(...walls)).toBeLessThan(100);
    // The Δ is pending on every answer (the comparatives never land here).
    expect(pending).toBeGreaterThanOrEqual(Object.keys(QUERIES).length);
    expect(fetched.filter((u) => /\/attention|\/comparatives|\/sector-benchmark/.test(u)).length,
      "cold: the bar's documents are asked for once, by the prefetch, not per keystroke").toBeLessThanOrEqual(3);
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
    });
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
    // Every family the reader sees was walked through, in order.
    const order = ["answer", "account", "page", "action", "ask"];
    expect([...new Set(walked)]).toEqual(order.filter((k) => walked.includes(k)));
    expect(walked).toContain("account");
    for (let i = 0; i < n + 2; i++) key("ArrowUp");
    expect(selected()).toBe(0);
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
