// cmdbar-evidence — EVERY link the command bar builds lands on a rendered,
// HIGHLIGHTED target (design C4, stage CB-F2).
//
// The hrefs are built by the bar's OWN view functions (nowItemView,
// accountView, statementView, ratioView — cmdbarViews.ts) over REAL served
// documents: the engine-composed "Ce contează acum" fixtures
// (fixtures/attention/, held to a fresh composition by cmdbar-fixtures), the
// period bodies the hermetic e2e double serves (Scandia, Agras — anonymized
// corpus books) and the comparatives pair capture. Each href is then opened
// on the receiver the dashboard mounts for it:
//
//   /benchmark?row=            SectorBenchmarkView — the named row, only it
//   /dashboard?tab=ratios&ratio=   RatiosTabContent — the ratio's drawer when
//                              it has a tile, and ALWAYS its ratio-table row
//   /dashboard?…&line= / &account=  EvidenceDrawer — the account view
//
// and the landing is asserted: the target exists, is marked
// `data-highlighted="true"`, is the thing the item named (same key, same
// code), and prints the served figure — never a sum the engine did not
// serve, never 0 for an absent account.
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11): a link to a slug the dashboard
// does not have (bs / cf / pnl / p_and_l / statements) — built at runtime or
// written in source; an item whose
// evidence opens no receiver; a receiver that renders but marks nothing; a
// Cont row that lands on its tab with its account nowhere; a synthetic code
// printed with a total the engine did not serve; an absent account printed
// as 0; a ratio key with no tile landing on a tab with nothing marked.
// WHAT IT CANNOT SEE: pixels and real scrolling (the hermetic live spec,
// e2e/design/cmdbar.spec.ts), and the P&L / balance-sheet row targets
// behind the drawer (useHighlightFromUrl's own contract).

import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { useLocation } from "react-router-dom";

import i18n from "@/i18n";
import { formatMoneyFrom } from "@/lib/money";

const DISPLAY = vi.hoisted(() => ({ code: "RON" as "RON" | "EUR" | "USD" }));
vi.mock("@/stores/currency", async (orig) => {
  // The REAL conversion into the header's display currency: a receiver that
  // printed through the toggle would print EUR when the reader chose EUR.
  const { formatAmountFrom: f } = await import("@/lib/money");
  return {
    ...(await orig<typeof import("@/stores/currency")>()),
    useAmountFormatter: (from: string) => (v: number | null | undefined, opts: Record<string, unknown> = {}) =>
      f(v, (from || "RON") as never, DISPLAY.code, { RON: 1, EUR: 5, USD: 4.6 } as never, opts),
  };
});

import { renderWithProviders } from "@/test/renderWithProviders";
import { EvidenceDrawer } from "@/components/cfo/evidence/EvidenceDrawer";
import { buildEvidenceModel, readEvidenceRequest, type EvidenceBody } from "@/components/cfo/evidence/evidenceView";
import { RatiosTabContent } from "@/components/cfo/ratios/RatiosTab";
import { RatioCompareCtx } from "@/components/cfo/ComparativesPanel";
import { SectorBenchmarkView } from "@/components/cfo/benchmark/SectorBenchmarkSection";
import { altmanRatio, computeRatios, type Statements } from "@/lib/financialReport";
import { computeCreditScore } from "@/lib/financialValuation";
import { buildRatioCompareView, readRatioTable, servedCreditEnvelopes } from "@/lib/ratioCompareView";
import { EVIDENCE_LINES } from "@/lib/evidence/evidenceLines";
import { lineEvidenceHref, realStatementTab } from "@/lib/evidence/evidenceLink";
import { STATEMENT_TAB } from "@/lib/traceableSource";
import type { SectorBenchmarkDoc } from "@/lib/sectorBenchmark";
import type { AttentionDoc } from "@/lib/attention";
import type { PeriodLineItem } from "@/lib/activePeriod";
import {
  accountMoreView,
  accountView,
  nowItemView,
  ratioView,
  statementView,
  type ViewContext,
} from "@/components/instrument/shell/cmdbar/cmdbarViews";
import { ANSWERS, buildCmdbarIndex, searchCmdbar, type CmdbarHit } from "@/components/instrument/shell/cmdbar/cmdbarIndex";
import { codeKey } from "@/components/instrument/shell/cmdbar/cmdbarSearch";
import { servedEbitda, servedLine, servedNetResult, ratioTableRows } from "@/components/instrument/shell/cmdbar/cmdbarSources";
import strings from "@/components/cfo/evidence/evidenceStrings.json";

/** The landing laws mount a receiver per link (every ratio row, every item,
 *  every answer): 0.3-1 s each alone, 5-10x that under the full suite's
 *  parallel load, where three of them met vitest's 5 s default with every
 *  assertion green (review round 1 of stage CB-I). They assert no time;
 *  their bound is the work, and this is only a hang guard. */
vi.setConfig({ testTimeout: 30_000 });

const REPO = resolve(__dirname, "../../../../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf-8"));

const SCANDIA = read("e2e/fixtures/workspace_v2/scandia_fy2025.json").period;
const AGRAS = read("e2e/fixtures/workspace_v2/agras_fy2025.json").period;
const PAIR = read("frontend/lib/__tests__/fixtures/comparatives/pair_served.json");
const SECTOR_PAIR = read("frontend/lib/__tests__/fixtures/sectorBenchmark/served_pair.json").with_prior;

const RATES = { RON: 1, EUR: 5, USD: 4.6 };
/** The account view's money: the SERVED currency with its code. */
const full = (v: number) => formatMoneyFrom(v, "RON", "RON", RATES as never, {});

/** The dashboard's real tab ids a statement / ratio link may name. */
const REAL_TABS = ["pl", "balance_sheet", "cash_flow", "ratios"];

interface World {
  name: string;
  body: Record<string, any>;
  attention: AttentionDoc;
  sector: SectorBenchmarkDoc;
  comparatives: unknown;
}

const WORLDS: World[] = [
  { name: "scandia", body: SCANDIA, attention: read("frontend/lib/__tests__/fixtures/attention/scandia.attention.json"),
    sector: read("frontend/lib/__tests__/fixtures/attention/scandia.sector.json"), comparatives: null },
  { name: "agras", body: AGRAS, attention: read("frontend/lib/__tests__/fixtures/attention/agras.attention.json"),
    sector: read("frontend/lib/__tests__/fixtures/attention/agras.sector.json"), comparatives: null },
  { name: "pair", body: PAIR.current_body, attention: read("frontend/lib/__tests__/fixtures/attention/pair.attention.json"),
    sector: SECTOR_PAIR, comparatives: PAIR.comparatives },
  { name: "pair_letter", body: PAIR.current_body, attention: read("frontend/lib/__tests__/fixtures/attention/pair_letter.attention.json"),
    sector: SECTOR_PAIR, comparatives: PAIR.comparatives },
];

function ctxOf(w: World): ViewContext {
  return {
    printer: { lang: "en", money: (v: number) => formatMoneyFrom(v, "RON", "RON", RATES as never, { compact: true }) },
    body: w.body,
    comparatives: w.comparatives ? { state: "ok", data: w.comparatives as never } : { state: "none", reason: "no_prior" },
    sector: { state: "ok", data: w.sector },
    periodId: w.body.period.id,
    orgId: w.body.organization?.id ?? "org-under-test",
  };
}

function evidenceBody(w: World): EvidenceBody {
  return { statements: w.body.statements, assembled_metrics: w.body.assembled_metrics, line_items: w.body.line_items ?? [] };
}

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

afterEach(async () => {
  DISPLAY.code = "RON";
  cleanup();
  await act(async () => { await i18n.changeLanguage("en"); });
});

// ── the receivers, mounted the way the pages mount them ─────────────────

function ratiosTab(w: World, href: string) {
  const body = w.body;
  const metricsByName = Object.fromEntries(
    (body.metrics ?? []).map((m: { name: string; value: number | null }) => [m.name, typeof m.value === "number" ? m.value : null]),
  ) as Record<string, number | null>;
  const statements = body.statements as Statements;
  const ratios = computeRatios(statements, { ebitdaMargin: metricsByName.ebitda_margin ?? null, netMargin: metricsByName.net_margin ?? null }, metricsByName);
  const env = servedCreditEnvelopes(body.assembled_metrics, statements, metricsByName);
  const credit = computeCreditScore(statements, env.credit, env.piotroski, env.metricsByName);
  const view = buildRatioCompareView({
    periodTable: readRatioTable(body.assembled_metrics),
    comparativesDoc: w.comparatives,
    currentLabel: statements.periodLabel,
  });
  renderWithProviders(
    <RatioCompareCtx.Provider value={view}>
      <RatiosTabContent ratios={ratios} statements={statements} altman={altmanRatio(credit)} />
      <Where />
    </RatioCompareCtx.Provider>,
    { route: href },
  );
  return { ratios };
}

function drawer(w: World, href: string) {
  return renderWithProviders(
    <>
      <EvidenceDrawer
        body={evidenceBody(w)}
        periodLabel={w.body.statements.periodLabel ?? null}
        documentName={w.body.period.source_document?.filename ?? null}
        currency="RON"
      />
      <Where />
    </>,
    { route: href },
  );
}

/** Open `href` on its receiver and return the element it landed on. */
async function landOn(w: World, href: string): Promise<{ kind: string; target: HTMLElement }> {
  const url = new URL(href, "http://cfo.test");
  if (url.pathname === "/benchmark") {
    renderWithProviders(<SectorBenchmarkView doc={w.sector} />, { route: href });
    const lit = [...document.querySelectorAll<HTMLElement>('[data-sector-row][data-highlighted="true"]')];
    expect(lit.map((r) => r.dataset.sectorRow), href).toEqual([url.searchParams.get("row")]);
    return { kind: "sector", target: lit[0] };
  }
  expect(url.pathname, href).toBe("/dashboard");
  const tab = url.searchParams.get("tab");
  expect(REAL_TABS, `${href} names tab ${tab}`).toContain(tab);
  if (url.searchParams.get("ratio")) {
    const key = url.searchParams.get("ratio")!;
    expect(tab).toBe("ratios");
    const { ratios } = ratiosTab(w, href);
    const row = await screen.findAllByTestId("ratio-compare-row", {}, { timeout: 2000 }).then(() =>
      document.querySelector<HTMLElement>(`[data-testid="ratio-compare-row"][data-ratio-key="${key}"]`));
    expect(row, `${href}: the ratio table has no row for ${key}`).not.toBeNull();
    expect(row!.dataset.highlighted, `${href}: the ${key} row is not marked`).toBe("true");
    const tiles = [ratios.liquidity, ratios.profitability, ratios.leverage, ratios.coverage, ratios.efficiency].flat();
    if (tiles.some((r) => r.key === key)) {
      const d = await screen.findByTestId("ratio-detail-drawer");
      expect(d.textContent).toContain(tiles.find((r) => r.key === key)!.label);
    }
    return { kind: "ratio", target: row! };
  }
  if (url.searchParams.get("line") || url.searchParams.getAll("account").length > 0) {
    drawer(w, href);
    const d = await screen.findByTestId("evidence-drawer");
    const lit = [...d.querySelectorAll<HTMLElement>('[data-evidence-target][data-highlighted="true"]')];
    expect(lit.length, `${href}: the account view marks nothing`).toBeGreaterThan(0);
    return { kind: "evidence", target: d };
  }
  throw new Error(`${href} opens no receiver`);
}

/** The served number an item prints — the object it carries, verbatim. */
function itemServedValue(item: AttentionDoc["items"][number]): number | string | null {
  const f = item.figure as Record<string, any>;
  switch (f.kind) {
    case "comparatives_column": return f.column.current ?? null;
    case "sector_row": return f.row.company?.value ?? null;
    case "ratio_compare_row": return f.row.current?.value ?? f.row.current?.value_q ?? null;
    case "insight_measure": return f.measure.value ?? null;
    default: return null;
  }
}

/** The number the landing HEADS with: the account view's one headline
 *  (`data-evidence-headline` — the finding's measure, else the line's
 *  served figure), the sector row's company figure, the ratio-table row's
 *  current side. `text` is the printed headline where the landing prints it
 *  with the item's own printer (a finding's measure), else null. */
function headlineOf(landed: { kind: string; target: HTMLElement }): { value: number | string | null; text: string | null } {
  const num = (v: string | undefined) => (v === undefined || v === "" ? null : Number(v));
  if (landed.kind === "evidence") {
    const heads = [...landed.target.querySelectorAll<HTMLElement>("[data-evidence-headline]")];
    expect(heads.length, "the account view has exactly one headline").toBe(1);
    const h = heads[0];
    return { value: num(h.dataset.servedValue), text: h.dataset.testid === "evidence-finding-value" ? h.textContent : null };
  }
  if (landed.kind === "sector") return { value: num(landed.target.dataset.servedValue), text: null };
  if (landed.kind === "ratio") {
    const printed = JSON.parse(landed.target.dataset.ratioPrintedJson ?? "{}") as { current?: string };
    const cmp = JSON.parse(landed.target.dataset.ratioCmpJson ?? "null") as Record<string, any> | null;
    const side = cmp?.current ?? cmp?.row?.current ?? null;
    return { value: side ? (side.value ?? side.value_q ?? null) : printed.current ?? null, text: null };
  }
  return { value: null, text: null };
}

// ════════════════════════════════════════════════════════════════════════

describe("cmdbar-evidence — every 'Ce contează acum' item lands on its evidence", () => {
  for (const w of WORLDS) {
    it(`${w.name}: each served item opens a rendered, highlighted target that IS the item`, async () => {
      const ctx = ctxOf(w);
      let headlines = 0;
      expect(w.attention.items.length).toBeGreaterThan(0);
      for (const item of w.attention.items) {
        const view = nowItemView(ctx, item, w.attention);
        const landed = await landOn(w, view.href);
        const ev = item.evidence as Record<string, any>;
        if (ev.kind === "statement") {
          const line = landed.target.querySelector<HTMLElement>(`[data-evidence-target="line:${ev.line}"]`);
          expect(line, `${item.key}: no line block for ${ev.line}`).not.toBeNull();
          expect(line!.dataset.highlighted).toBe("true");
          for (const code of (ev.accounts ?? []) as string[]) {
            const acc = landed.target.querySelector<HTMLElement>(`[data-evidence-target="account:${CSS.escape(code)}"]`);
            expect(acc?.dataset.highlighted, `${item.key}: cited account ${code} not marked`).toBe("true");
            expect(acc?.dataset.absent, `${item.key}: cited account ${code} is not in the book`).toBeUndefined();
          }
        } else if (ev.kind === "account") {
          const codes = ((ev.accounts ?? []) as string[]).length ? ev.accounts : [ev.account];
          for (const code of codes as string[]) {
            const acc = landed.target.querySelector<HTMLElement>(`[data-evidence-target="account:${CSS.escape(code)}"]`);
            expect(acc?.dataset.highlighted, `${item.key}: account ${code} not marked`).toBe("true");
          }
        } else if (ev.kind === "ratio") {
          expect(landed.target.dataset.ratioKey).toBe(ev.ratio);
        } else if (ev.kind === "benchmark_row") {
          expect(landed.target.dataset.sectorRow).toBe(ev.row);
        }
        // THE LANDING HEADS WITH THE ITEM'S OWN NUMBER (review 2026-09-27:
        // Scandia's earnings_quality printed 753,070.01 and landed under
        // "Served figure 448,406.27"; Agras's 1.50x landed on 2.10x).
        const head = headlineOf(landed);
        const want = itemServedValue(item);
        expect(head.value, `${w.name} ${item.key}: the landing heads with ${head.value}, the item printed ${want}`).toBe(want);
        if (head.text !== null) expect(head.text, `${w.name} ${item.key}: printed headline`).toBe(view.figure);
        headlines++;
        cleanup();
      }
      expect(headlines, "every item's landing headline was compared").toBe(w.attention.items.length);
    });
  }

  it.each(["en", "ro"] as const)("%s: Scandia's earnings_quality opens under ITS number (758 + 781), then the accounts it cites — not under the 758 line", async (lang) => {
    await act(async () => { await i18n.changeLanguage(lang); });
    const w = WORLDS[0];
    const item = w.attention.items.find((i) => i.key === "earnings_quality")!;
    const view = nowItemView({ ...ctxOf(w), printer: { ...ctxOf(w).printer, lang } }, item, w.attention);
    drawer(w, view.href);
    const d = await screen.findByTestId("evidence-drawer");
    const value = d.querySelector('[data-testid="evidence-finding-value"]')!;
    expect(value.textContent).toBe(view.figure);
    expect(Number((value as HTMLElement).dataset.servedValue)).toBe(753070.01);
    // The 758 line's own figure is not the headline anywhere on the view.
    expect(d.querySelector('[data-testid="evidence-line-value"]')).toBeNull();
    expect(d.querySelector('[data-testid="evidence-finding-note"]')?.textContent)
      .toBe(i18n.getFixedT(lang)("evidence.findingNote"));
    expect(d.querySelector('[data-testid="evidence-title"]')?.textContent)
      .toBe(i18n.getFixedT(lang)("evidence.measure.non_trading"));
    // Every cited 758 / 781 leaf is listed and marked.
    for (const code of (item.evidence as { accounts: string[] }).accounts) {
      expect(d.querySelector(`[data-evidence-target="account:${CSS.escape(code)}"]`)?.getAttribute("data-highlighted"), code).toBe("true");
    }
    if (lang === "ro") expect(d.textContent).toContain("Măsura proprie a constatării");
  });

  it("the statement lines the engine names are all declared (none opens the 'unknown line' sentence)", () => {
    const pack = WORLDS.flatMap((w) => w.attention.items)
      .map((i) => (i.evidence as Record<string, any>))
      .filter((e) => e.kind === "statement")
      .map((e) => e.line as string);
    expect(pack.length).toBeGreaterThan(0);
    for (const l of pack) expect(EVIDENCE_LINES[l], l).toBeDefined();
  });
});

describe("cmdbar-evidence — every Cont row lands on its account, highlighted", () => {
  for (const w of WORLDS.slice(0, 2)) {
    it(`${w.name}: every served line item's Cont row opens the account view on that exact leaf (model, all rows)`, () => {
      const ctx = ctxOf(w);
      const items = (w.body.line_items as PeriodLineItem[]).filter((li) => li.statement !== "IGNORED");
      expect(items.length).toBeGreaterThan(200);
      for (const li of items) {
        const href = accountView(ctx, li).href;
        const url = new URL(href, "http://cfo.test");
        expect(url.searchParams.get("tab")).toBe(li.statement === "PL" ? "pl" : "balance_sheet");
        const req = readEvidenceRequest(url.searchParams)!;
        expect(req.accounts).toEqual([li.ro_account_code]);
        const m = buildEvidenceModel(evidenceBody(w), req);
        const block = m.accounts[0];
        expect(block.absent).toBe(false);
        const leaf = block.leaves.find((l) => l.exact && l.bucket === li.bucket);
        expect(leaf, `${li.ro_account_code}`).toBeDefined();
        expect(leaf!.amount).toBe(li.amount);
      }
    });

    it(`${w.name}: rendered, the requested leaf is marked and prints the served balance`, async () => {
      const ctx = ctxOf(w);
      const items = (w.body.line_items as PeriodLineItem[]).filter((li) => li.statement !== "IGNORED");
      // One leaf per account class present — every statement family.
      const sample = [...new Map(items.map((li) => [li.ro_account_code[0], li])).values()];
      expect(sample.length).toBeGreaterThanOrEqual(6);
      for (const li of sample) {
        drawer(w, accountView(ctx, li).href);
        const d = await screen.findByTestId("evidence-drawer");
        const rows = [...d.querySelectorAll<HTMLElement>(`[data-evidence-target="leaf:${CSS.escape(li.ro_account_code)}"][data-highlighted="true"]`)];
        expect(rows.length, li.ro_account_code).toBeGreaterThan(0);
        const printed = rows.map((r) => {
          const cell = r.querySelector('[data-cell="amount"]');
          return (cell?.querySelector('[data-provenance="true"]') ?? cell)?.textContent;
        });
        expect(printed, `${li.ro_account_code}: ${JSON.stringify(printed)}`).toContain(full(li.amount));
        expect(d.querySelector('[data-testid="evidence-meta"]')?.textContent).toContain(w.body.period.source_document.filename);
        cleanup();
      }
    });
  }
});

describe("cmdbar-evidence — every Cont overflow row opens EVERY account it counted", () => {
  for (const w of WORLDS.slice(0, 2)) {
    it(`${w.name}: for every code prefix and name word that overflows the Cont group, the row's link lists exactly the accounts found`, () => {
      const ctx = ctxOf(w);
      const idx = buildCmdbarIndex({ body: w.body as never, pages: [], actions: [] });
      const items = (w.body.line_items as PeriodLineItem[]).filter((li) => li.statement !== "IGNORED");
      const probes = new Set<string>();
      for (const li of items) {
        const k = codeKey(li.ro_account_code);
        for (const n of [1, 2, 3, 4]) if (k.length >= n) probes.add(li.ro_account_code.slice(0, n));
        for (const word of (li.ro_account_name ?? "").split(/\s+/)) if (/^\p{L}{5,}$/u.test(word)) probes.add(word.toLowerCase());
      }
      const item = (h: CmdbarHit) => (h.entry.ref.kind === "account" ? h.entry.ref.item : null);
      let overflowing = 0;
      let prefixLinks = 0;
      const bad: string[] = [];
      for (const q of probes) {
        const g = searchCmdbar(idx, q).groups.find((x) => x.group === "account");
        if (!g) continue;
        const shown = g.hits.map(item).filter((x): x is PeriodLineItem => !!x);
        const hidden = g.rest.map(item).filter((x): x is PeriodLineItem => !!x);
        const view = accountMoreView(ctx, q, shown, hidden);
        if (hidden.length === 0) { if (view) bad.push(`"${q}": a row with nothing hidden`); continue; }
        overflowing++;
        if (!view) { bad.push(`"${q}": ${hidden.length} hidden, no row`); continue; }
        if (view.more !== hidden.length || view.total !== shown.length + hidden.length) bad.push(`"${q}": counts ${view.more}/${view.total}`);
        const req = readEvidenceRequest(new URL(view.href, "http://cfo.test").searchParams)!;
        const m = buildEvidenceModel(evidenceBody(w), req);
        const opened = new Set(m.accounts.flatMap((b) => b.leaves.map((l) => `${l.code}:${l.bucket}`)));
        const found = new Set([...shown, ...hidden].map((li) => `${li.ro_account_code}:${li.bucket}`));
        const missing = [...found].filter((k) => !opened.has(k));
        const extra = [...opened].filter((k) => !found.has(k));
        if (missing.length || extra.length) bad.push(`"${q}": missing ${missing.slice(0, 3)} extra ${extra.slice(0, 3)}`);
        if (req.accounts.length === 1 && req.accounts[0] === q) prefixLinks++;
      }
      expect(bad, `${w.name}: overflow rows that hide or add accounts`).toEqual([]);
      expect(overflowing, "VACUITY: overflowing queries").toBeGreaterThanOrEqual(20);
      expect(prefixLinks, "the prefix form was exercised").toBeGreaterThanOrEqual(5);
      console.log(`GATE-WORK cmdbar-cont-overflow ${w.name} probes=${probes.size} overflowing=${overflowing} prefix_links=${prefixLinks}`);
    }, 30_000);
  }
});

describe("cmdbar-evidence — every Răspuns row opens its evidence", () => {
  for (const w of WORLDS.slice(0, 3)) {
    it(`${w.name}: each statement answer lands on its line, printing the SAME served figure through the same reader`, async () => {
      const ctx = ctxOf(w);
      for (const a of ANSWERS) {
        const view = statementView(ctx, a);
        const landed = await landOn(w, view.href);
        const block = landed.target.querySelector<HTMLElement>(`[data-evidence-target="line:${a.line}"]`);
        expect(block?.dataset.highlighted, a.id).toBe("true");
        const served = a.reader === "ebitda" ? servedEbitda(w.body as never)
          : a.reader === "net_result" ? servedNetResult(w.body as never)
          : servedLine(w.body as never, a.statement as "pl" | "bs", a.field!);
        const printed = block!.querySelector('[data-testid="evidence-line-value"]')?.textContent;
        if (served.value !== null) expect(printed, a.id).toBe(full(served.value));
        else expect(printed, a.id).not.toMatch(/^[\s0.,-]*$/);
        cleanup();
      }
    });

    it(`${w.name}: every ratio answer lands on its ratio-table row (tile or not)`, async () => {
      const ctx = ctxOf(w);
      const keys = [...ratioTableRows(w.body as never).keys()];
      expect(keys.length).toBeGreaterThan(20);
      for (const key of keys) {
        const landed = await landOn(w, ratioView(ctx, key).href);
        expect(landed.target.dataset.ratioKey).toBe(key);
        cleanup();
      }
    });
  }
});

// Review round 1 of stage CB-I: the account view printed the engine's own
// paths — "read from statements.insights.insights[id=earnings_quality]
// .measures[key=non_trading]", "read from assembled_pl.ebitda", "Land ·
// canonical_bs.rows[id=ppe_land]" — and an unknown line as "(pl.nope)".
// The reader gets where the figure was read in words (evidence.source.*,
// RO/EN); the path stays in `data-source` for a developer, printed nowhere.
describe("cmdbar-evidence — the view speaks the reader's words: no engine path on screen", () => {
  const ENGINE_PATH = /assembled_[a-z]+\.|canonical_bs|statements\.insights|\[id=|\[key=|\bline_items\b/;
  const SNAKE = /\b[a-z0-9]+_[a-z0-9_]+\b/;

  /** Every account-view link the bar builds over a world: its items'
   *  (those that open the view), its statement answers, a served total,
   *  a line no declaration knows. */
  function viewHrefs(w: World): string[] {
    const ctx = ctxOf(w);
    const out: string[] = [];
    for (const item of w.attention.items) {
      const u = new URL(nowItemView(ctx, item, w.attention).href, "http://cfo.test");
      if (u.searchParams.get("line") || u.searchParams.getAll("account").length) out.push(u.pathname + u.search);
    }
    for (const a of ANSWERS) out.push(statementView(ctx, a).href);
    out.push("/dashboard?tab=balance_sheet&account=121");
    out.push("/dashboard?tab=pl&line=pl.no_such_line");
    return out;
  }

  for (const lang of ["en", "ro"] as const) {
    it(`${lang}: every account view the bar opens names its source in words, and prints no engine path or id`, async () => {
      await act(async () => { await i18n.changeLanguage(lang); });
      const tt = i18n.getFixedT(lang);
      const wrong: string[] = [];
      let views = 0;
      let sources = 0;
      let unknown = 0;
      for (const w of WORLDS) {
        for (const href of viewHrefs(w)) {
          drawer(w, href);
          const d = await screen.findByTestId("evidence-drawer");
          const text = d.textContent ?? "";
          const hit = ENGINE_PATH.exec(text);
          if (hit) wrong.push(`${w.name} ${href}: "${text.slice(Math.max(0, hit.index - 30), hit.index + 50)}"`);
          for (const el of d.querySelectorAll<HTMLElement>("[data-source]")) {
            const path = el.dataset.source ?? "";
            // POSITIVE CONTROL: the developer attribute still carries the path.
            if (!ENGINE_PATH.test(path)) wrong.push(`${w.name} ${href}: data-source "${path}" is not an engine path`);
            const printed = el.textContent ?? "";
            if (SNAKE.test(printed)) wrong.push(`${w.name} ${href}: a source line prints "${printed}"`);
            if (el.dataset.testid === "evidence-total-source") continue;
            const key = path.startsWith("statements.insights") ? "findings" : path.startsWith("assembled_pl.") ? "pl"
              : path.startsWith("assembled_bs.") || path.startsWith("canonical_bs.") ? "bs" : path.startsWith("assembled_cf.") ? "cf"
              : path.startsWith("assembled_metrics.") ? "metrics" : "served";
            const want = tt("evidence.servedFrom", { source: tt(`evidence.source.${key}`) });
            if (printed !== want) wrong.push(`${w.name} ${href}: "${printed}" ≠ "${want}"`);
            sources++;
          }
          const u = d.querySelector<HTMLElement>('[data-testid="evidence-unknown-line"]');
          if (u) {
            unknown++;
            if (u.textContent !== tt("evidence.unknownLine")) wrong.push(`${w.name} ${href}: unknown line "${u.textContent}"`);
            if ((u.textContent ?? "").includes(u.dataset.line ?? "\u0000")) wrong.push(`${w.name} ${href}: the unknown line prints its key`);
          }
          views++;
          cleanup();
        }
      }
      expect(wrong.slice(0, 12), `engine paths or ids on screen (${wrong.length})`).toEqual([]);
      expect(views, "VACUITY: views opened").toBeGreaterThanOrEqual(40);
      expect(sources, "VACUITY: source lines read").toBeGreaterThanOrEqual(40);
      expect(unknown, "VACUITY: the unknown line was opened in every world").toBe(WORLDS.length);
      console.log(`GATE-WORK cmdbar-evidence-words ${lang} views=${views} sources=${sources}`);
    }, 60_000);
  }
});

describe("cmdbar-evidence — the account rules", () => {
  const scandia = WORLDS[0];

  it("a synthetic code shows its leaves and NO total the engine did not serve", async () => {
    drawer(scandia, "/dashboard?tab=balance_sheet&account=4111");
    const d = await screen.findByTestId("evidence-drawer");
    const leaves = [...d.querySelectorAll<HTMLElement>('[data-testid="evidence-leaf"]')].map((r) => r.dataset.accountCode);
    expect(leaves.length).toBeGreaterThan(1);
    expect(leaves.every((c) => c!.startsWith("4111"))).toBe(true);
    expect(d.querySelector('[data-testid="evidence-total"]')).toBeNull();
    expect(d.querySelector('[data-testid="evidence-no-total"]')).not.toBeNull();
    // The sum of the leaves is printed nowhere (a second authority).
    const sum = (SCANDIA.line_items as PeriodLineItem[])
      .filter((li) => li.ro_account_code.startsWith("4111")).reduce((s, li) => s + li.amount, 0);
    expect(d.textContent).not.toContain(full(Math.round(sum * 100) / 100));
    // The balance-sheet row it rolls into, with ITS served amount.
    const rollup = d.querySelector<HTMLElement>('[data-testid="evidence-rollup"][data-row-id="ar_trade_gross"]');
    const row = SCANDIA.statements.canonical_bs.rows.find((r: { id: string }) => r.id === "ar_trade_gross");
    expect(rollup?.textContent).toContain(full(row.amount));
  });

  it("an account the engine serves a total for prints THAT total (account 121 → the canonical result row)", async () => {
    drawer(scandia, "/dashboard?tab=balance_sheet&account=121");
    const d = await screen.findByTestId("evidence-drawer");
    const row = SCANDIA.statements.canonical_bs.rows.find((r: { account_codes: string[] }) =>
      r.account_codes.length === 1 && r.account_codes[0] === "121");
    expect(d.querySelector('[data-testid="evidence-total"]')?.textContent).toContain(full(row.amount));
    expect(d.querySelector('[data-testid="evidence-leaf-ids"]')?.textContent).toContain(row.leaf_ids[0]);
  });

  it("an account absent from the book says so — never 0; a code one digit off picks nothing", async () => {
    const codes = new Set((SCANDIA.line_items as PeriodLineItem[]).map((li) => li.ro_account_code));
    const offByOne = ["4112", "4119", "4121"].find((c) => ![...codes].some((x) => x.startsWith(c)))!;
    expect(offByOne).toBeDefined();
    drawer(scandia, `/dashboard?tab=balance_sheet&account=${offByOne}`);
    const d = await screen.findByTestId("evidence-drawer");
    // Said in words — the sentence and nothing else, no figure at all.
    expect(d.querySelector('[data-testid="evidence-absent"]')?.textContent)
      .toBe(i18n.getFixedT("en")("evidence.absent", { code: offByOne }));
    expect(d.querySelectorAll('[data-testid="evidence-leaf"]').length).toBe(0);
    expect(d.querySelector('[data-testid="evidence-total"]')).toBeNull();
    expect(d.textContent).not.toContain(full(0));
  });

  // Review of stage CB-H: the sentence for a finding the period does not
  // serve printed the engine's ids — "This period serves no measure
  // non_trading for the finding earnings_quality." The reader gets the
  // measure's declared name in their language, or no name — never an id.
  for (const lang of ["en", "ro"] as const) {
    it(`${lang}: a finding this period does not serve is said in words — the measure by its name, no engine id on screen`, async () => {
      await act(async () => { await i18n.changeLanguage(lang); });
      const tt = i18n.getFixedT(lang);
      const cases = [
        // Served finding, a measure it does not carry — a declared name.
        { href: "/dashboard?tab=pl&finding=asset_age&measure=net_financial&account=2131", ids: ["asset_age", "net_financial"],
          want: tt("evidence.findingAbsent", { measure: tt("evidence.measure.net_financial") }) },
        // A finding Scandia does not serve (Agras's), a measure with no declared name.
        { href: "/dashboard?tab=bs&finding=unclassified_balances&measure=unclassified&account=4111", ids: ["unclassified_balances", "unclassified"],
          want: tt("evidence.findingAbsentUnnamed") },
      ];
      for (const c of cases) {
        drawer(scandia, c.href);
        const d = await screen.findByTestId("evidence-drawer");
        const sentence = d.querySelector('[data-testid="evidence-finding-absent"]')?.textContent ?? "";
        expect(sentence).toBe(c.want);
        // No engine identifier anywhere the reader reads (attributes aside).
        for (const id of c.ids) expect(d.textContent, `"${id}" on screen`).not.toMatch(new RegExp(`\\b${id}\\b`));
        expect(d.textContent).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
        expect(d.querySelector('[data-testid="evidence-finding-value"]')).toBeNull();
        cleanup();
      }
    });
  }

  it("display EUR: the account view prints the SERVED RON balance with its code, never a converted, unlabelled one", async () => {
    DISPLAY.code = "EUR";
    const li = (SCANDIA.line_items as PeriodLineItem[]).find((x) => x.ro_account_code === "411121")!;
    drawer(scandia, "/dashboard?tab=balance_sheet&account=411121&line=bs.trade_receivables_net");
    const d = await screen.findByTestId("evidence-drawer");
    const leaf = d.querySelector('[data-evidence-target="leaf:411121"] [data-cell="amount"]');
    expect((leaf?.querySelector('[data-provenance="true"]') ?? leaf)?.textContent).toBe(full(li.amount));
    expect(full(li.amount)).toMatch(/RON$/);
    const line = d.querySelector('[data-testid="evidence-line-value"]')?.textContent ?? "";
    expect(line).toBe(full(servedLine(SCANDIA as never, "bs", "ar_net").value as number));
    expect(d.textContent).not.toMatch(/€|\bEUR\b/);
  });

  it("every leaf amount wears its provenance (account, document, method, pack)", async () => {
    drawer(scandia, "/dashboard?tab=balance_sheet&account=5121");
    const d = await screen.findByTestId("evidence-drawer");
    const cells = [...d.querySelectorAll('[data-testid="evidence-leaf"] [data-cell="amount"]')];
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c.querySelector('[data-provenance="true"]')).not.toBeNull();
  });

  it("closing drops the evidence parameters and keeps the tab", async () => {
    drawer(scandia, "/dashboard?period=p&tab=balance_sheet&account=5121&line=bs.cash");
    await screen.findByTestId("evidence-drawer");
    expect(screen.getByTestId("where").textContent).toContain("account=5121");
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    const where = screen.getByTestId("where").textContent ?? "";
    expect(where).not.toContain("account=");
    expect(where).not.toContain("line=");
    expect(where).toContain("tab=balance_sheet");
    expect(screen.queryByTestId("evidence-drawer")).toBeNull();
  });

  it("a derived line says it has no accounts of its own and offers its statement row", async () => {
    drawer(scandia, "/dashboard?tab=pl&line=pl.ebitda");
    const d = await screen.findByTestId("evidence-drawer");
    expect(d.querySelector('[data-testid="evidence-derived"]')).not.toBeNull();
    const see = d.querySelector<HTMLButtonElement>('[data-testid="evidence-see-row"]')!;
    await act(async () => { see.click(); });
    expect(screen.getByTestId("where").textContent).toContain("highlight=ebitda");
  });

  it("RO: the view speaks Romanian, with diacritics", async () => {
    await act(async () => { await i18n.changeLanguage("ro"); });
    drawer(scandia, "/dashboard?tab=balance_sheet&line=bs.cash");
    const d = await screen.findByTestId("evidence-drawer");
    expect(d.textContent).toContain("Numerar și echivalente");
    expect(d.textContent).toContain("Conturile care alimentează linia");
  });
});

describe("cmdbar-evidence — strings and slugs", () => {
  it("EN and RO carry the same keys", () => {
    const keys = (o: Record<string, unknown>, p = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v ? keys(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(strings.ro).sort()).toEqual(keys(strings.en).sort());
  });

  it("every statement spelling a producer has used opens a REAL tab", () => {
    const spellings: [string, string][] = [
      ["bs", "balance_sheet"], ["cf", "cash_flow"], ["pnl", "pl"], ["p_and_l", "pl"],
      ["pl", "pl"], ["balance_sheet", "balance_sheet"], ["cash_flow", "cash_flow"],
    ];
    for (const [spelling, want] of spellings) {
      expect(realStatementTab(spelling), spelling).toBe(want);
      const href = lineEvidenceHref({ periodId: "p", orgId: "o" }, "bs.cash", spelling);
      expect(new URL(href, "http://cfo.test").searchParams.get("tab"), spelling).toBe(want);
    }
    for (const v of Object.values(STATEMENT_TAB)) expect(REAL_TABS).toContain(v);
    expect(realStatementTab("statements")).toBeNull();
  });

  it("no source file links a statement tab by a slug the dashboard does not have", () => {
    const FE = resolve(REPO, "frontend");
    const bad = /[?&]tab=(bs|cf|pnl|p_and_l|statements)\b|[?&]tab=\$\{[^}]*\}#|tab=statements#|"p_and_l"/;
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__" || name === "dist") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.endsWith(join("evidence", "evidenceLink.ts"))) {
          // Code only: a comment that NAMES the retired slug (to say it was
          // retired) is not a link.
          const src = readFileSync(p, "utf-8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|\s)\/\/.*$/gm, "$1");
          if (bad.test(src)) hits.push(p.slice(FE.length + 1));
        }
      }
    };
    walk(FE);
    expect(hits).toEqual([]);
  });
});

// RELEASE r-rulings, FIXER ROUND 1 (2026-09-28): opening a 711 leaf from the
// bar printed "Contul 711104 … Sold <the leaf's amount>" — the production
// stocked on a closed book (its credit turnover) labelled a BALANCE, with
// none of the note the Capsule adds (design A1 / A6). And a refused line
// (the operating result under the one-EBITDA refusal, total equity short by
// a refused result) printed the bar's "not in this book" or the short
// figure as its served figure.
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11): a 711 leaf in the account view
// — alone, under its prefix, among several accounts or a finding's — without
// the note, or labelled "Balance" / "Sold" on a closed book (by the column
// where every row is 711, by the row's own tag beside a balance); a note on
// a view with no 711 leaf; a statement line whose listed feeds do not sum to
// its served figure, or that lists a 711 leaf at all (critic round 2); a
// refused operating result or total equity printed as a figure or as "not in
// this book".
describe("cmdbar-evidence — account 711 and the refused lines (fixer round 1)", () => {
  const scandia = WORLDS[0];
  const IV = SCANDIA.statements.assembled_pl.inventory_variation;

  function expectedNote(lang: "en" | "ro", body: Record<string, any> = SCANDIA): string {
    const iv = body.statements.assembled_pl.inventory_variation;
    const tt = i18n.getFixedT(lang);
    const head = tt(iv.book_state === "closed" ? "cmdbar.account.stockVariation.closed" : "cmdbar.account.stockVariation.open");
    const tail = iv.value !== null
      ? tt("cmdbar.account.stockVariation.served", { name: iv.line_name_ro, value: full(iv.value), provenance: lang === "ro" ? iv.label_ro : iv.label_en })
      : tt("cmdbar.account.stockVariation.refused", { name: iv.line_name_ro, reason: lang === "ro" ? iv.refusal.text_ro : iv.refusal.text_en });
    return `${head} ${tail}`;
  }

  for (const lang of ["en", "ro"] as const) {
    it(`${lang}: a 711 leaf opens labelled as its credit turnover (never a balance) with the served variation beside it`, async () => {
      await act(async () => { await i18n.changeLanguage(lang); });
      const tt = i18n.getFixedT(lang);
      // POSITIVE CONTROL: a closed book, the leaf is the gross, the served
      // variation a different figure.
      expect(IV.book_state).toBe("closed");
      const li = (SCANDIA.line_items as PeriodLineItem[]).find((x) => x.ro_account_code === "711104")!;
      expect(li.amount).not.toBe(IV.value);
      drawer(scandia, accountView(ctxOf(scandia), li).href);
      const d = await screen.findByTestId("evidence-drawer");
      expect(d.querySelector('[data-testid="evidence-amount-label"]')?.textContent?.trim()).toBe(tt("evidence.turnover711"));
      expect(d.querySelector('[data-testid="evidence-amount-label"]')?.textContent?.trim()).not.toBe(tt("evidence.balance"));
      const notes = [...d.querySelectorAll('[data-testid="evidence-stock-note"]')];
      expect(notes.length, "the note, once").toBe(1);
      expect(notes[0].textContent).toBe(expectedNote(lang));
      expect(notes[0].textContent).toContain(full(IV.value));
      // The leaf's own amount is still the served one.
      expect(d.querySelector('[data-evidence-target="leaf:711104"] [data-cell="amount"]')?.textContent).toContain(full(li.amount));
      cleanup();
    });

    // CRITIC ROUND 2 (2026-09-28): round 1 switched the heading only where
    // EVERY row is 711, and this law then PINNED "Balance" / "Sold" over the
    // 711 rows of a line's feeds and of a mixed view — "Alte venituri din
    // exploatare" listed ten 711 leaves (the gross production stocked) under
    // "Sold", beside a served 758 figure they are not part of. Now: no line
    // lists a 711 leaf among its feeds (the stock variation is its own
    // measured line), and in a mixed table each 711 row names its own amount.
    it(`${lang}: every view that lists a 711 leaf carries the note once and labels each 711 amount as its credit turnover — by the column where every row is 711, by the row beside a balance; no line lists one among its feeds`, async () => {
      await act(async () => { await i18n.changeLanguage(lang); });
      const tt = i18n.getFixedT(lang);
      const cases: { href: string; note: boolean; heading?: string; tagged: boolean }[] = [
        { href: "/dashboard?tab=pl&account=711", note: true, heading: tt("evidence.colTurnover711"), tagged: false },
        { href: "/dashboard?tab=pl&account=711104&account=758", note: true, heading: tt("evidence.colAmount"), tagged: true },
        { href: "/dashboard?tab=pl&account=7", note: true, heading: tt("evidence.colAmount"), tagged: true },
        // The line's feeds: the 758 leaves the served figure IS — no 711
        // leaf, no note, the balance heading.
        { href: "/dashboard?tab=pl&line=pl.other_operating_income", note: false, heading: tt("evidence.colAmount"), tagged: false },
        // POSITIVE CONTROLS: no 711 leaf, no note, the balance heading.
        { href: "/dashboard?tab=balance_sheet&account=4111", note: false, heading: tt("evidence.colAmount"), tagged: false },
        { href: "/dashboard?tab=pl&account=758", note: false, tagged: false },
      ];
      for (const c of cases) {
        drawer(scandia, c.href);
        const d = await screen.findByTestId("evidence-drawer");
        const rows = [...d.querySelectorAll<HTMLElement>('[data-testid="evidence-leaf"]')];
        const leaves711 = rows.filter((r) => (r.dataset.accountCode ?? "").startsWith("711"));
        expect(leaves711.length > 0, `${c.href}: lists a 711 leaf`).toBe(c.note);
        const notes = [...d.querySelectorAll('[data-testid="evidence-stock-note"]')].map((n) => n.textContent);
        expect(notes, c.href).toEqual(c.note ? [expectedNote(lang)] : []);
        if (c.heading) {
          const heads = [...d.querySelectorAll("thead th")].map((th) => th.textContent);
          expect(heads[heads.length - 1], c.href).toBe(c.heading);
        }
        // POSITIVE CONTROL for the mixed views: a balance row sits beside
        // the 711 rows, so the heading cannot speak for them.
        if (c.tagged) expect(rows.some((r) => !(r.dataset.accountCode ?? "").startsWith("711")), c.href).toBe(true);
        for (const r of rows) {
          const tag = r.querySelector('[data-testid="evidence-amount-tag"]')?.textContent ?? null;
          const is711 = (r.dataset.accountCode ?? "").startsWith("711");
          expect(tag, `${c.href} ${r.dataset.accountCode}`).toBe(is711 && c.tagged ? tt("evidence.rowTurnover711") : null);
        }
        cleanup();
      }
    });
  }

  it("THE FEEDS ARE THE FIGURE: every statement line's listed feeds (both books, as the view lists them) sum to its served figure, and none is a 711 leaf", async () => {
    let judged = 0;
    let narrowed = 0;
    for (const w of WORLDS.slice(0, 2)) {
      const body = evidenceBody(w);
      const items = (w.body.line_items as PeriodLineItem[]).filter((li) => li.statement !== "IGNORED");
      for (const spec of Object.values(EVIDENCE_LINES)) {
        if (spec.buckets.length === 0) continue;
        const model = buildEvidenceModel(body, { accounts: [], line: spec.key, finding: null });
        const served = model.line!.figure.value;
        expect(typeof served, `${w.name}/${spec.key}: a served figure`).toBe("number");
        const listed = model.line!.leaves;
        expect(listed.length, `${w.name}/${spec.key}: lists feeds`).toBeGreaterThan(0);
        const total = listed.reduce((a, l) => a + (l.amount ?? 0), 0);
        expect(Math.abs(total - (served as number)), `${w.name}/${spec.key}: the listed feeds sum to ${total}, served ${served}`).toBeLessThan(0.005);
        expect(listed.filter((l) => l.code.startsWith("711")).map((l) => l.code), `${w.name}/${spec.key}`).toEqual([]);
        // POSITIVE CONTROL: the bucket ALONE would list the 711 memo — the
        // narrowing is what keeps it out.
        const wide = items.filter((li) => spec.buckets.includes(li.bucket));
        if (wide.length !== listed.length) {
          narrowed++;
          expect(wide.some((li) => li.ro_account_code.startsWith("711")), `${w.name}/${spec.key}`).toBe(true);
        }
        judged++;
      }
      // Rendered: the "Other operating income" view shows exactly those feeds.
      drawer(w, "/dashboard?tab=pl&line=pl.other_operating_income");
      const d = await screen.findByTestId("evidence-drawer");
      const codes = [...d.querySelectorAll<HTMLElement>('[data-testid="evidence-feeds"] [data-testid="evidence-leaf"]')].map((r) => r.dataset.accountCode ?? "");
      expect(codes.length, w.name).toBeGreaterThan(0);
      expect(codes.filter((c) => !c.startsWith("758")), w.name).toEqual([]);
      cleanup();
    }
    expect(narrowed, "both books carry the 711 memo in the bucket").toBe(2);
    console.log(`GATE-WORK cmdbar-evidence-feeds lines=${judged} narrowed=${narrowed}`);
  });

  it("EVERY 711 row, in every account view that lists one (each leaf, the 7 / 71 / 711 prefixes, beside each other P&L leaf), is labelled as its credit turnover on the closed books — never under 'Balance' alone", async () => {
    let rowsJudged = 0;
    let views = 0;
    for (const lang of ["en", "ro"] as const) {
    await act(async () => { await i18n.changeLanguage(lang); });
    const tt = i18n.getFixedT(lang);
    for (const w of WORLDS.slice(0, 2)) {
      expect(w.body.statements.assembled_pl.inventory_variation.book_state, w.name).toBe("closed");
      const items = (w.body.line_items as PeriodLineItem[]).filter((li) => li.statement !== "IGNORED");
      const c711 = [...new Set(items.filter((li) => li.ro_account_code.startsWith("711")).map((li) => li.ro_account_code))];
      // One other P&L account family per two-digit group (60 … 78).
      const others = [...new Set(items.filter((li) => li.statement === "PL" && !li.ro_account_code.startsWith("711")).map((li) => li.ro_account_code.slice(0, 2)))];
      expect(c711.length, w.name).toBeGreaterThan(0);
      const hrefs = [
        ...c711.map((c) => `/dashboard?tab=pl&account=${c}`),
        "/dashboard?tab=pl&account=7", "/dashboard?tab=pl&account=71", "/dashboard?tab=pl&account=711",
        ...others.map((o) => `/dashboard?tab=pl&account=${c711[0]}&account=${o}`),
      ];
      for (const href of hrefs) {
        drawer(w, href);
        const d = await screen.findByTestId("evidence-drawer");
        const heads = [...d.querySelectorAll("thead th")].map((th) => th.textContent);
        const heading = heads.length ? heads[heads.length - 1] : null;
        for (const r of d.querySelectorAll<HTMLElement>('[data-testid="evidence-leaf"]')) {
          if (!(r.dataset.accountCode ?? "").startsWith("711")) continue;
          const label = r.querySelector('[data-testid="evidence-amount-label"]')?.textContent?.trim()
            ?? r.querySelector('[data-testid="evidence-amount-tag"]')?.textContent
            ?? heading;
          expect([tt("evidence.turnover711"), tt("evidence.rowTurnover711"), tt("evidence.colTurnover711")], `${w.name} ${href} ${r.dataset.accountCode}: "${label}"`).toContain(label);
          rowsJudged++;
        }
        views++;
        cleanup();
      }
    }
    }
    console.log(`GATE-WORK cmdbar-evidence-711-label views=${views} rows=${rowsJudged}`);
  });

  it("a 711 leaf on a book whose variation the engine REFUSED carries that refusal in the engine's words", async () => {
    const book = read("frontend/lib/__tests__/fixtures/oneEbitda/constructed_books.json").unanchored;
    const w: World = { ...scandia, body: { ...SCANDIA, statements: book.statements, line_items: book.line_items, assembled_metrics: null } };
    drawer(w, "/dashboard?tab=pl&account=711");
    const d = await screen.findByTestId("evidence-drawer");
    const note = d.querySelector('[data-testid="evidence-stock-note"]')?.textContent ?? "";
    expect(note).toBe(expectedNote("en", w.body));
    expect(note).toContain(book.statements.assembled_pl.inventory_variation.refusal.text_en);
  });

  it("a refused operating result and a refused total equity open on the engine's words — never 'not in this book', never the short figure", async () => {
    const books = read("frontend/lib/__tests__/fixtures/oneEbitda/constructed_books.json");
    const book = books.unanchored_unbalanced;
    const w: World = { ...scandia, body: { ...SCANDIA, statements: book.statements, line_items: book.line_items, assembled_metrics: null } };
    const cases = [
      { line: "pl.ebit", words: book.statements.assembled_pl.ebitda_refusal.text_en, short: null as number | null },
      { line: "bs.total_equity", words: book.statements.assembled_bs.total_equity_refusal.text_en, short: book.statements.assembled_bs.total_equity as number },
    ];
    for (const c of cases) {
      drawer(w, `/dashboard?tab=pl&line=${c.line}`);
      const d = await screen.findByTestId("evidence-drawer");
      const v = d.querySelector<HTMLElement>('[data-testid="evidence-line-value"]')!;
      expect(v.textContent, c.line).toBe(c.words);
      expect(v.dataset.servedValue, c.line).toBe("");
      expect(d.textContent).not.toContain("not in this book");
      if (c.short !== null) expect(d.textContent).not.toContain(full(c.short));
      cleanup();
    }
  });
});
